"""Actual read_file, signed-media and preview handlers hydrate verified Work files."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from test_cloud_coordinator import add_conversation, enable, initial_pair
from test_cloud_coordinator import desktops as desktops

from mona.agent.artifacts import ArtifactRef
from mona.agent.tools.context import RequestContext
from mona.agent.tools.filesystem import ReadFileTool
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.cloud.file_access import ensure_session_file
from mona.cloud.transfer import CloudTransferError


def target_file(coordinator, key):
    data = coordinator.manager.read_session_file(key)
    return Path(data["metadata"]["cloud_history"]["files"][0]["local_path"])


def attach_reader(coordinator):
    coordinator.manager.cloud_file_resolver = coordinator.ensure_file


def channel_for(coordinator, monkeypatch):
    monkeypatch.setattr("mona.config.loader._current_config_path", coordinator.preferences.path)
    monkeypatch.setattr("mona.channels.websocket.get_media_dir", lambda channel=None: coordinator.media_root)
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda channel=None: coordinator.media_root)
    monkeypatch.setattr("mona.webui.transcript.webui_transcript_path", coordinator.transcript_for)
    attach_reader(coordinator)
    return WebSocketChannel({"enabled": True}, MessageBus(), session_manager=coordinator.manager)


def request(channel, path):
    return SimpleNamespace(path=path, headers={"Authorization": f"Bearer {channel._runtime_token}"})


async def output_pair(desktops, extension="md"):
    service, create = desktops
    a, na = create("a")
    b, nb = create("b")
    session = add_conversation(a, attachment=False)
    root = a.manager.workspace / "agent-workspaces" / "mona" / "output"
    root.mkdir(parents=True)
    file = root / f"report.{extension}"
    file.write_bytes(b"VERIFIED_RESULT_BODY")
    ref = ArtifactRef.for_path(owner_kind="agent", owner_id="mona", root=root, path=file,
        created_by_agent_id="mona", session_id=session.key)
    with a.transcript_for(session.key).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": "deliver_files", "files": [{"artifact_ref": ref.model_dump(mode="json")} ]}) + "\n")
    await enable(a, [session.key])
    await a.run_once()
    assert a.problem is None
    await enable(b, [], na.recovery)
    await b.run_once()
    assert b.problem is None
    key = b.manager.list_sessions()[0]["key"]
    attach_reader(b)
    return service, a, b, nb, key


@pytest.mark.asyncio
async def test_agent_read_downloads_real_file_then_reuses_local_without_account_calls(desktops, monkeypatch):
    service, _, b, _, nb, _, key = await initial_pair(desktops)
    attach_reader(b)
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda: b.media_root)
    path = target_file(b, key)
    assert not path.exists()
    tool = ReadFileTool(workspace=b.manager.workspace, allowed_dir=b.manager.workspace, sessions=b.manager)
    tool.set_context(RequestContext(channel="websocket", chat_id=key.split(":", 1)[1], session_key=key))
    answer = await tool.execute(str(path))
    assert "ATTACHMENT_BODY" in answer
    assert path.read_bytes() == b"ATTACHMENT_BODY"
    count, calls = len(service.downloads), len(nb.calls)
    assert "ATTACHMENT_BODY" in await tool.execute(str(path), force=True)
    assert len(service.downloads) == count and len(nb.calls) == calls


@pytest.mark.asyncio
async def test_read_without_owner_or_outside_tool_boundary_never_hydrates(desktops, tmp_path, monkeypatch):
    service, _, b, _, _, _, key = await initial_pair(desktops)
    attach_reader(b)
    path = target_file(b, key)
    tool = ReadFileTool(workspace=b.manager.workspace, sessions=b.manager)
    count = len(service.downloads)
    assert "not found" in await tool.execute(str(path))
    assert len(service.downloads) == count
    tool.set_context(RequestContext(channel="websocket", chat_id="other", session_key="websocket:other"))
    assert "不属于" in await tool.execute(str(path))
    assert not path.exists() and len(service.downloads) == count
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda: tmp_path / "not-allowed")
    constrained = ReadFileTool(workspace=b.manager.workspace, allowed_dir=b.manager.workspace, sessions=b.manager)
    constrained.set_context(RequestContext(channel="websocket", chat_id="x", session_key=key))
    assert "outside allowed" in await constrained.execute(str(path))
    assert not path.exists() and len(service.downloads) == count


@pytest.mark.asyncio
async def test_concurrent_reads_share_one_hydration_and_do_not_duplicate_transfers(desktops):
    service, _, b, _, _, _, key = await initial_pair(desktops)
    path = target_file(b, key)
    service.downloads.clear()
    assert await asyncio.gather(*(b.ensure_file(key, path) for _ in range(3))) == [True, True, True]
    assert len(service.downloads) == len(set(service.downloads))
    assert path.read_bytes() == b"ATTACHMENT_BODY"


@pytest.mark.asyncio
async def test_foreign_account_is_rejected_without_download_or_local_write(desktops):
    service, _, b, _, nb, _, key = await initial_pair(desktops)
    path = target_file(b, key)
    nb.account_id = "other"
    nb.binding = "changed-binding"
    before = len(service.downloads)
    with pytest.raises(CloudTransferError) as error:
        await b.ensure_file(key, path)
    assert error.value.code == "account_changed"
    assert not path.exists() and len(service.downloads) == before


@pytest.mark.asyncio
async def test_account_change_after_last_chunk_blocks_publication(desktops):
    _, _, b, _, nb, _, key = await initial_pair(desktops)
    path = target_file(b, key)
    checks = 0
    def change_on_publish(command):
        nonlocal checks
        if command == "cloud_sync_context":
            checks += 1
            if checks == 2:
                nb.account_id = "other"
                nb.binding = "changed-binding"
    nb.hook = change_on_publish
    with pytest.raises(CloudTransferError) as error:
        await b.ensure_file(key, path)
    assert error.value.code == "account_changed"
    assert not path.exists() and not list(b.media_root.glob(".sync-*"))


@pytest.mark.asyncio
async def test_cancelling_download_never_publishes_after_thread_finishes(desktops, monkeypatch):
    service, _, b, _, _, _, key = await initial_pair(desktops)
    path = target_file(b, key)
    entered, release, finished = Event(), Event(), Event()
    original = service.download
    def slow_download(authorization):
        entered.set()
        assert release.wait(5)
        try:
            return original(authorization)
        finally:
            finished.set()
    monkeypatch.setattr(service, "download", slow_download)
    pending = asyncio.create_task(b.ensure_file(key, path))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        release.set()
        await asyncio.to_thread(finished.wait, 5)
    assert not path.exists()
    assert not list(b.media_root.glob(".sync-*"))


@pytest.mark.asyncio
async def test_pausing_background_sync_still_allows_explicit_file_open(desktops):
    _, _, b, _, _, _, key = await initial_pair(desktops)
    await b.pause()
    path = target_file(b, key)
    assert await b.ensure_file(key, path)
    assert not b.preferences.read().enabled
    assert b.cancelled.is_set()


@pytest.mark.asyncio
async def test_signed_media_handler_fetches_missing_cloud_file_but_invalid_signature_cannot(desktops, monkeypatch):
    service, _, b, _, _, _, key = await initial_pair(desktops)
    channel = channel_for(b, monkeypatch)
    path = target_file(b, key)
    url = channel._sign_media_path(path)
    assert url and not path.exists()
    before = len(service.downloads)
    broken = url.replace(url.split("/")[3], "invalid", 1)
    assert (await channel._dispatch_http(None, request(channel, broken))).status_code == 401
    assert len(service.downloads) == before and not path.exists()
    result = await channel._dispatch_http(None, request(channel, url))
    assert result.status_code == 200 and result.body == b"ATTACHMENT_BODY"
    assert path.read_bytes() == b"ATTACHMENT_BODY"


@pytest.mark.asyncio
@pytest.mark.parametrize("extension", ["md", "docx", "xlsx", "pptx"])
async def test_authenticated_preview_hydrates_same_bytes_used_by_office_open(desktops, monkeypatch, extension):
    service, _, b, _, key = await output_pair(desktops, extension)
    channel = channel_for(b, monkeypatch)
    path = target_file(b, key)
    root = b.manager.workspace / "agent-workspaces" / "mona" / "output"
    query = urlencode({"scope": "shared", "session_key": key, "path": path.relative_to(root).as_posix()})
    req = request(channel, "/api/file-preview?" + query)
    before = len(service.downloads)
    bad = SimpleNamespace(path=req.path, headers={})
    assert (await channel._dispatch_http(None, bad)).status_code == 401
    assert not path.exists() and len(service.downloads) == before
    response = await channel._dispatch_http(None, req)
    assert response.status_code == 200 and response.body == b"VERIFIED_RESULT_BODY"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


@pytest.mark.asyncio
async def test_missing_ordinary_file_never_triggers_cloud_calls(desktops):
    _, create = desktops
    coordinator, native = create("a")
    attach_reader(coordinator)
    missing = coordinator.manager.workspace / "missing.txt"
    assert await ensure_session_file(coordinator.manager, "websocket:plain", missing) is False
    assert native.calls == []


@pytest.mark.asyncio
async def test_tampered_ciphertext_never_becomes_empty_or_partial_preview(desktops, monkeypatch):
    service, _, b, _, key = await output_pair(desktops)
    channel = channel_for(b, monkeypatch)
    path = target_file(b, key)
    root = b.manager.workspace / "agent-workspaces" / "mona" / "output"
    original = service.download
    def corrupt(authorization):
        data = original(authorization)
        return data[:-1] + bytes([data[-1] ^ 1])
    monkeypatch.setattr(service, "download", corrupt)
    req = request(channel, "/api/file-preview?" + urlencode({"scope": "shared", "session_key": key, "path": path.relative_to(root).as_posix()}))
    result = await channel._dispatch_http(None, req)
    assert result.status_code == 409 and not path.exists()
    assert json.loads(result.body)["error"]["message"]


@pytest.mark.asyncio
async def test_uploaded_document_has_a_signed_lazy_url_without_copying_all_files(desktops, monkeypatch):
    service, create = desktops
    a, na = create("a")
    b, _ = create("b")
    session = add_conversation(a, attachment=False)
    upload = a.manager.workspace / "uploads" / "attached.docx"
    upload.parent.mkdir()
    upload.write_bytes(b"UPLOADED_DOCUMENT_BYTES")
    session.add_message("user", "请检查文档", media=[str(upload)])
    a.manager.save(session)
    with a.transcript_for(session.key).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": "user", "media_paths": [str(upload)]}) + "\n")
    await enable(a, [session.key])
    await a.run_once()
    await enable(b, [], na.recovery)
    await b.run_once()
    assert b.problem is None
    key = b.manager.list_sessions()[0]["key"]
    channel = channel_for(b, monkeypatch)
    path = target_file(b, key)
    media = channel._augment_transcript_user_media([str(path)])
    assert not path.exists() and len(media) == 1
    assert media[0]["url"].startswith("/api/cloud-attachment/")
    assert channel._sign_cloud_attachment(b.manager.workspace.parent / "outside.txt") is None
    before = len(service.downloads)
    forged_namespace = media[0]["url"].replace("/api/cloud-attachment/", "/api/media/")
    assert (await channel._dispatch_http(None, request(channel, forged_namespace))).status_code == 401
    assert len(service.downloads) == before and not path.exists()
    response = await channel._dispatch_http(None, request(channel, media[0]["url"]))
    assert response.status_code == 200 and response.body == b"UPLOADED_DOCUMENT_BYTES"
    assert path.read_bytes() == b"UPLOADED_DOCUMENT_BYTES"
    assert not list(b.media_root.glob("**/attached.docx"))


@pytest.mark.asyncio
async def test_agent_office_open_hydrates_before_handing_file_to_existing_editor_service(desktops, monkeypatch):
    from mona.agent.tools.office import OfficeTool
    from mona.office.schemas import DocumentVersion, OfficeSessionState
    _, _, b, _, key = await output_pair(desktops, "docx")
    path = target_file(b, key)
    opened = []
    class EditorService:
        async def open(self, *, owner_session_key, path, **kwargs):
            opened.append((owner_session_key, path.read_bytes()))
            return OfficeSessionState(session_id="office_test", display_name="report.docx", type="docs",
                version=DocumentVersion(editor_epoch="epoch_test", model_revision=0))
    monkeypatch.setattr("mona.agent.tools.office.OfficeServiceClient.from_port", lambda _: EditorService())
    tool = OfficeTool(workspace=b.manager.workspace)
    tool._sessions = b.manager
    tool.set_context(RequestContext(channel="websocket", chat_id="one", session_key=key))
    result = json.loads(await tool.execute("open", path=str(path)))
    assert result["sessionId"] == "office_test"
    assert opened == [(key, b"VERIFIED_RESULT_BODY")]
    assert path.is_file()


@pytest.mark.asyncio
async def test_read_context_is_task_local_not_last_session_wins(desktops, monkeypatch):
    service, _, b, _, _, _, key = await initial_pair(desktops)
    attach_reader(b)
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda: b.media_root)
    tool = ReadFileTool(workspace=b.manager.workspace, sessions=b.manager)
    path = target_file(b, key)
    ready = asyncio.Event()
    async def invalid_owner():
        tool.set_context(RequestContext(channel="websocket", chat_id="other", session_key="websocket:other"))
        ready.set()
        await asyncio.sleep(0)
        return await tool.execute(str(path))
    task = asyncio.create_task(invalid_owner())
    await ready.wait()
    tool.set_context(RequestContext(channel="websocket", chat_id="right", session_key=key))
    invalid = await task
    assert "不属于" in invalid and not path.exists()
    assert "ATTACHMENT_BODY" in await tool.execute(str(path))
    assert service.downloads
