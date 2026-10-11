"""File previews must not repeatedly parse a session or block other requests."""

import asyncio
import json
import threading
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest

from mona.agent.partners import ConversationMetadata
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.config.paths import get_agent_output_dir
from mona.session.manager import SessionManager
from mona.webui.transcript import webui_transcript_path


@pytest.fixture
def preview(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    sessions = SessionManager(tmp_path / "workspace")
    key = "websocket:preview"
    session = sessions.get_or_create(key)
    session.metadata["conversation"] = ConversationMetadata.direct("mona").to_session_metadata()
    for i in range(100):
        session.add_message("user" if i % 2 == 0 else "assistant", "history " * 100)
    sessions.save(session)
    output = get_agent_output_dir(sessions.workspace, "mona")
    picture = output / "picture.png"
    picture.write_bytes(b"image contents")
    channel = WebSocketChannel({"enabled": True}, MessageBus(), session_manager=sessions)
    query = urlencode({
        "scope": "shared", "session_key": key, "path": picture.name,
        "artifact_id": "historical-list-id",
    })
    request = SimpleNamespace(
        path=f"/api/file-preview?{query}",
        headers={"Authorization": f"Bearer {channel._runtime_token}"},
    )
    return channel, sessions, key, picture, request


@pytest.mark.parametrize("event", ["deliver_files", "generate_image"])
async def test_many_legacy_artifacts_read_session_once(preview, monkeypatch, event):
    channel, sessions, key, picture, request = preview
    files = [{"path": f"old-{i}.png"} for i in range(120)] + [{"path": picture.name}]
    record = {"event": "deliver_files", "files": files} if event == "deliver_files" else {
        "event": "message", "tool_events": [
            {"name": "generate_image", "result": {"artifacts": files}},
        ],
    }
    webui_transcript_path(key).write_text(json.dumps(record) + "\n", encoding="utf-8")
    reads = []
    original = sessions.read_session_file

    def read_session(key):
        reads.append(key)
        return original(key)

    def no_runtime_mutation(*args):
        raise AssertionError("Preview must not load or create mutable runtime sessions")

    monkeypatch.setattr(sessions, "read_session_file", read_session)
    monkeypatch.setattr(sessions, "get_or_create", no_runtime_mutation)
    response = await channel._dispatch_http(None, request)
    assert response.status_code == 200
    assert response.body == picture.read_bytes()
    assert response.headers["Content-Type"] == "image/png"
    assert reads == [key]


async def test_preview_does_not_block_health_request(preview, monkeypatch):
    channel, _sessions, key, _picture, request = preview
    import mona.webui.transcript as transcript

    entered, release = threading.Event(), threading.Event()
    original = transcript.read_transcript_lines

    def slow_read(session_key):
        entered.set()
        assert release.wait(timeout=2)
        return original(session_key)

    webui_transcript_path(key).write_text(
        json.dumps({"event": "deliver_files", "files": [{"path": "picture.png"}]}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(transcript, "read_transcript_lines", slow_read)
    pending = asyncio.create_task(channel._dispatch_http(None, request))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        health = await asyncio.wait_for(
            channel._dispatch_http(None, SimpleNamespace(path="/health", headers={})), 0.5,
        )
        assert health.status_code == 200
        assert not pending.done()
    finally:
        release.set()
        response = await pending
    assert response.status_code == 200


async def test_preview_revalidates_owner_and_path_each_request(preview):
    channel, sessions, key, picture, request = preview
    webui_transcript_path(key).write_text(
        json.dumps({"event": "deliver_files", "files": [{"path": picture.name}]}) + "\n",
        encoding="utf-8",
    )
    assert (await channel._dispatch_http(None, request)).body == b"image contents"
    session = sessions.get_or_create(key)
    session.metadata["conversation"] = ConversationMetadata.direct("com.example.other").to_session_metadata()
    sessions.save(session)
    assert (await channel._dispatch_http(None, request)).status_code == 404
    request.path = "/api/file-preview?" + urlencode({
        "scope": "shared", "session_key": key, "path": "../picture.png",
    })
    assert (await channel._dispatch_http(None, request)).status_code == 400
    request.headers = {}
    assert (await channel._dispatch_http(None, request)).status_code == 401
