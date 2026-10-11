import base64
import io
import json
import os
import sys

import pytest
from PIL import Image
from test_native_service import PEER, requests, setup, wait_status
from test_workbench_api import AUTH, setup_client

from mona.development import output_media
from mona.development.context import load_project_context
from mona.development.contracts import ExecutorId, InputState, RunInput, RunStatus
from mona.development.executors.base import NativeEvent, SessionStart
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_events import normalize_codex_event
from mona.development.executors.codex_policy import CodexProfile
from mona.development.native_service import NativeRunService
from mona.development.output_media import materialize_generated_image, read_generated_image
from mona.development.store import DevelopmentError, DevelopmentStore
from mona.session.manager import SessionManager
from mona.utils.media_decode import DEFAULT_MAX_BYTES


def _png_bytes(width=1, height=1, *, noisy=False):
    pixels = os.urandom(width * height * 3) if noisy else bytes([20, 90, 160]) * width * height
    image = Image.frombytes("RGB", (width, height), pixels)
    output = io.BytesIO()
    image.save(output, format="PNG", compress_level=0 if noisy else 9)
    return output.getvalue()


def _patch_media_dir(monkeypatch, root):
    monkeypatch.setattr(output_media, "get_media_dir", lambda channel=None: root / channel if channel else root)


def _artifact_owner(native_session_id):
    return "".join(c if c.isascii() and (c.isalnum() or c in "-_") else "_" for c in native_session_id)


def test_codex_image_generation_is_a_tool_event_only_after_success():
    item = {"id": "image-1", "type": "imageGeneration", "status": "inProgress", "result": ""}
    started = normalize_codex_event("item/started", {"turnId": "turn-1", "item": item})
    assert started.type == "tool.started"
    assert started.native_turn_id == "turn-1"
    assert started.native_event_id == "image:item/started:image-1"
    assert started.payload == {"itemId": "image-1", "kind": "imageGeneration", "status": "inProgress"}

    completed = normalize_codex_event("item/completed", {"turnId": "turn-1", "item": {
        **item, "status": "completed", "result": "data:image/png;base64,AAAA", "savedPath": "C:\\native\\image-1.png",
    }})
    assert completed.type == "tool.completed"
    assert completed.type != "agent.message.completed"
    assert completed.native_event_id == "image:item/completed:image-1"
    assert completed.payload["text"] == ""
    assert completed.payload["content"] == [{
        "type": "image", "url": "C:\\native\\image-1.png", "name": "生成的图片",
    }]

    failed = normalize_codex_event("item/completed", {"turnId": "turn-1", "item": {
        "id": "image-failed", "type": "imageGeneration", "status": "failed", "result": "partial-preview",
    }})
    assert failed.type == "tool.completed"
    assert "content" not in failed.payload


@pytest.mark.asyncio
async def test_native_generated_image_persists_small_media_reference_and_replays_once(tmp_path, monkeypatch):
    service, adapter, store, session, binding, _ = await setup(tmp_path)
    _patch_media_dir(monkeypatch, tmp_path / "isolated-media")
    try:
        run = await service.submit(session.id, "request_image_result", "hold")
        run = await wait_status(store, run.id, {RunStatus.RUNNING})

        steering = store.enqueue_input(RunInput(
            id="input_image_steering", session_id=session.id, run_id=run.id,
            message_id=run.request_message_id, intent="steering",
        ))
        reserved = store.transition_input(steering.id, steering.revision, InputState.RESERVED)
        store.transition_input(steering.id, reserved.revision, InputState.ACCEPTED)

        artifact_root = (store.path.parent / "native" / "codex" / "generated_images"
                         / _artifact_owner(binding.native_session_id))
        artifact_root.mkdir(parents=True)
        image_path = artifact_root / "image-1.png"
        original = _png_bytes(1024, 620, noisy=True)
        image_path.write_bytes(original)
        assert len(original) < 2_097_152
        assert len(base64.b64encode(original)) > 2_097_152

        started = normalize_codex_event("item/started", {"turnId": run.native_turn_id, "item": {
            "id": "image-1", "type": "imageGeneration", "status": "inProgress",
        }})
        completed = normalize_codex_event("item/completed", {"turnId": run.native_turn_id, "item": {
            "id": "image-1", "type": "imageGeneration", "status": "completed",
            "savedPath": str(image_path), "result": "unused-fallback.png",
        }})
        service._record(store.get_run(run.id), binding, started)
        assert not any(message.get("native_item_id") == "image-1"
                       for message in service.sessions.get_or_create(session.transcript_key).messages)

        service._record(store.get_run(run.id), binding, completed)
        service._record(store.get_run(run.id), binding, completed)

        messages = service.sessions.get_or_create(session.transcript_key).messages
        image_messages = [message for message in messages if message.get("native_item_id") == "image-1"]
        assert len(image_messages) == 1
        image_message = image_messages[0]
        assert image_message["role"] == "assistant"
        assert image_message["content"] == ""
        media = image_message["_display_media"]
        assert media[0]["name"] == "生成的图片"
        assert media[0]["url"].startswith("mona-media:")
        assert str(image_path) not in json.dumps(image_message, ensure_ascii=False)
        assert len(json.dumps(image_message, ensure_ascii=False)) < 2_097_152
        assert str(image_path) not in json.dumps([event.payload for event in store.events_after(session.id)], ensure_ascii=False)
        assert store.get_input(steering.id).state == InputState.ACCEPTED
        assert store.get_run(run.id).status == RunStatus.RUNNING
        assert read_generated_image(store.get_project(session.project_id), media[0]["url"])[0] == original

        reopened = NativeRunService(DevelopmentStore(store.path), SessionManager(tmp_path / "history"))
        try:
            reopened._record(reopened.store.get_run(run.id), binding, completed)
            replayed = reopened.sessions.get_or_create(session.transcript_key).messages
            assert len([message for message in replayed if message.get("native_item_id") == "image-1"]) == 1
            assert replayed[[message.get("native_item_id") for message in replayed].index("image-1")]["_display_media"] == media
        finally:
            await reopened.close()
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_generated_media_http_read_is_authenticated_and_project_scoped(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    _patch_media_dir(monkeypatch, tmp_path / "isolated-media")
    try:
        project = runtime.store.open_project(root)
        raw = _png_bytes(40, 40, noisy=True)
        encoded = base64.b64encode(raw).decode("ascii")
        reference = materialize_generated_image(project, root, f"data:image/png;base64,{encoded}")
        assert materialize_generated_image(project, root, encoded) == reference
        assert read_generated_image(project, reference) == (raw, "image/png")

        path = f"/api/development/projects/{project.id}/media"
        denied = await client.get(path, params={"path": reference})
        assert denied.status == 401
        response = await client.get(path, params={"path": reference}, headers=AUTH)
        assert response.status == 200
        assert await response.read() == raw
        assert response.content_type == "image/png"
        assert response.headers["Cache-Control"] == "private, no-store"
        assert response.headers["X-Content-Type-Options"] == "nosniff"

        other_root = tmp_path / "另一个项目"
        other_root.mkdir()
        other_project = runtime.store.open_project(other_root)
        foreign = await client.get(
            f"/api/development/projects/{other_project.id}/media",
            params={"path": reference}, headers=AUTH,
        )
        assert foreign.status == 404
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_generated_image_rejects_escaped_paths_fake_bytes_and_oversize_data(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    media_root = tmp_path / "isolated-media"
    _patch_media_dir(monkeypatch, media_root)
    try:
        project = runtime.store.open_project(root)
        artifacts = tmp_path / "native" / "generated_images"
        artifacts.mkdir(parents=True)
        other_project = tmp_path / "其他项目"
        other_project.mkdir()
        outside_image = other_project / "outside.png"
        outside_image.write_bytes(_png_bytes())

        with pytest.raises(DevelopmentError, match="生成的图片不属于当前任务"):
            materialize_generated_image(project, artifacts, str(outside_image))
        with pytest.raises(DevelopmentError):
            materialize_generated_image(project, artifacts, "../其他项目/outside.png")
        with pytest.raises(DevelopmentError, match="生成的图片文件无效"):
            materialize_generated_image(project, artifacts, "data:image/png;base64," + base64.b64encode(b"not an image").decode())
        oversized = "A" * (((DEFAULT_MAX_BYTES + 2) // 3) * 4 + 4)
        with pytest.raises(DevelopmentError, match="超过大小上限"):
            materialize_generated_image(project, artifacts, oversized)
        with pytest.raises(DevelopmentError, match="图片引用无效"):
            read_generated_image(project, "mona-media:../outside.png")
        assert not (media_root / "development" / project.id).exists()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_snapshot_restores_legacy_generated_image_once_beside_its_run(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    _patch_media_dir(monkeypatch, tmp_path / "isolated-media")
    home = tmp_path / "native-home"
    home.mkdir()
    adapter = None
    service = runtime.native.service
    try:
        project = runtime.store.open_project(root)
        session = runtime.store.create_session(project.id, ExecutorId.CODEX)
        context = load_project_context(project)
        adapter = CodexExecutor(CodexProfile(
            (sys.executable, "-u", str(PEER)), home, root, dict(os.environ),
        ), request_timeout=1)
        binding = await adapter.create_session(SessionStart(session, context))
        binding = runtime.store.activate_binding(binding, session.revision)
        service.attach(binding.id, adapter)

        original_run = await service.submit(session.id, "request_legacy_image", "hold")
        original_run = await wait_status(runtime.store, original_run.id, {RunStatus.RUNNING})
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        transcript.add_message("assistant", "旧任务的正文。", id="message_old_answer",
                               run_id=original_run.id, author_id="codex", native_item_id="answer-1")
        runtime.sessions.save(transcript, fsync=True)

        item_id = "image-legacy"
        artifact_root = (runtime.store.path.parent / "native" / "codex" / "generated_images"
                         / _artifact_owner(binding.native_session_id))
        artifact_root.mkdir(parents=True)
        image_path = artifact_root / f"{item_id}.png"
        original = _png_bytes(40, 40, noisy=True)
        image_path.write_bytes(original)
        assert runtime.store.record_native_event(
            original_run.id, binding.id, "event_legacy_image_completed", "tool.completed",
            {"itemId": item_id, "kind": "imageGeneration", "status": "completed"},
        )
        service._record(original_run, binding, NativeEvent(
            native_event_id="terminal-after-image", native_turn_id=original_run.native_turn_id,
            type="run.completed", payload={"status": "completed"},
        ))
        assert runtime.store.get_run(original_run.id).status == RunStatus.SUCCEEDED

        transcript = runtime.sessions.get_or_create(session.transcript_key)
        transcript.add_message("user", "后续的用户请求。", id="message_later_request")
        runtime.sessions.save(transcript, fsync=True)
        sequence_before_restore = len(runtime.store.events_after(session.id))
        dispatches_before_restore = len([request for request in requests(adapter) if request.get("method") == "turn/start"])
        endpoint = f"/api/development/sessions/{session.id}/snapshot"

        first_response = await client.get(endpoint, headers=AUTH)
        assert first_response.status == 200
        first = await first_response.json()
        generated = [message for message in first["messages"]
                     if any(media.get("url", "").startswith("mona-media:") for media in message.get("media", []))]
        assert len(generated) == 1
        image_message = generated[0]
        assert image_message["runId"] == original_run.id
        assert image_message["content"] == ""
        assert str(image_path) not in json.dumps(first["messages"], ensure_ascii=False)
        assert image_path.read_bytes() == original
        ids = [message["id"] for message in first["messages"]]
        assert ids.index("message_old_answer") < ids.index(image_message["id"]) < ids.index("message_later_request")
        assert len(runtime.store.events_after(session.id)) == sequence_before_restore
        assert len([request for request in requests(adapter) if request.get("method") == "turn/start"]) == dispatches_before_restore

        second_response = await client.get(endpoint, headers=AUTH)
        assert second_response.status == 200
        second = await second_response.json()
        assert second["messageCount"] == first["messageCount"]
        assert len([message for message in second["messages"]
                    if any(media.get("url", "").startswith("mona-media:") for media in message.get("media", []))]) == 1
        assert len(runtime.store.events_after(session.id)) == sequence_before_restore
        assert image_path.is_file()
        assert len([request for request in requests(adapter) if request.get("method") == "turn/start"]) == dispatches_before_restore
    finally:
        await service.close()
        if adapter:
            await adapter.shutdown()
        await client.close()
