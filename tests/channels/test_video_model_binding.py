from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock
from urllib.parse import quote

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Request

from mona.channels.websocket import WebSocketChannel
from mona.session.manager import SessionManager

BINDING = {"executor": "codex", "model": "video-test", "provider": None, "effort": "high"}


@pytest.fixture
def channel(tmp_path, monkeypatch):
    result = WebSocketChannel({"enabled": True}, MagicMock())
    result._session_manager = SessionManager(tmp_path / "sessions")
    result._send_event = AsyncMock()
    result._hydrate_after_subscribe = AsyncMock()
    result._handle_message = AsyncMock()
    result._subagent_manager = None
    monkeypatch.setattr("mona.agent.video_model_binding.validate_video_model_binding", AsyncMock(return_value=BINDING.copy()))
    monkeypatch.setattr("mona.config.loader.load_config", MagicMock())
    return result


def _video(channel, chat_id="video"):
    session = channel._session_manager.get_or_create(f"websocket:{chat_id}")
    session.metadata.update(agent_kind="video", model_binding=BINDING.copy())
    channel._session_manager.save(session)
    return session


@pytest.mark.asyncio
async def test_new_chat_persists_and_replays_model_binding(channel):
    conn = object()
    await channel._dispatch_envelope(conn, "client", {
        "type": "new_chat", "agent_kind": "video", "model_binding": BINDING, "request_id": "new",
    })
    result = channel._send_event.await_args
    chat_id = result.kwargs["chat_id"]
    assert result.args[1] == "attached" and result.kwargs["model_binding"] == BINDING
    assert channel._session_manager.read_session_file(f"websocket:{chat_id}")["metadata"]["model_binding"] == BINDING
    channel._send_event.reset_mock()
    await channel._dispatch_envelope(conn, "client", {"type": "attach", "chat_id": chat_id})
    assert channel._send_event.await_args.kwargs["model_binding"] == BINDING


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,raw", [(None, BINDING), ("video", {"executor": "missing", "model": "x"})])
async def test_invalid_new_selection_has_no_attachment_or_persistence(channel, kind, raw):
    await channel._dispatch_envelope(object(), "client", {
        "type": "new_chat", "agent_kind": kind, "model_binding": raw, "request_id": "invalid",
    })
    assert not channel._subs
    assert not list(channel._session_manager.sessions_dir.glob("*.jsonl"))
    result = channel._send_event.await_args
    assert result.args[1] == "error" and result.kwargs["request_id"] == "invalid"


@pytest.mark.asyncio
async def test_message_captures_binding_and_explicit_null_without_queue_cross_talk(channel, monkeypatch):
    session = _video(channel)
    validate = AsyncMock(return_value=BINDING.copy())
    monkeypatch.setattr("mona.agent.video_model_binding.validate_video_model_binding", validate)
    async def send(**extra):
        await channel._dispatch_envelope(object(), "client", {"type": "message", "chat_id": "video", "content": "make", **extra})
    await send()
    first = channel._handle_message.await_args.kwargs["metadata"]
    await send(model_binding=None)
    second = channel._handle_message.await_args.kwargs["metadata"]
    assert first["model_binding"] == BINDING and second["model_binding"] is None
    assert session.metadata["model_binding"] is None
    validate.assert_not_awaited()
    assert first["model_binding"] == BINDING


@pytest.mark.asyncio
async def test_invalid_message_does_not_promote_save_or_send(channel):
    conn = object()
    await channel._dispatch_envelope(conn, "client", {
        "type": "message", "chat_id": "fresh", "content": "make", "agent_kind": "video",
        "model_binding": {"executor": "unknown", "model": "x"},
    })
    assert not channel._subs
    channel._handle_message.assert_not_awaited()
    assert channel._session_manager.read_session_file("websocket:fresh") is None
    assert channel._session_manager.get_or_create("websocket:fresh").metadata == {}


@pytest.mark.asyncio
async def test_update_only_video_idle_binding_and_idempotence(channel, monkeypatch):
    _video(channel)
    validate = AsyncMock(return_value=BINDING.copy())
    monkeypatch.setattr("mona.agent.video_model_binding.validate_video_model_binding", validate)
    await channel._dispatch_envelope(object(), "client", {
        "type": "video_model_binding_update", "chat_id": "video", "model_binding": BINDING, "request_id": "same",
    })
    assert channel._send_event.await_args.kwargs["ok"] is True
    validate.assert_not_awaited()
    monkeypatch.setattr("mona.channels.websocket.websocket_turn_wall_started_at", lambda _: 10)
    await channel._dispatch_envelope(object(), "client", {
        "type": "video_model_binding_update", "chat_id": "video", "model_binding": None, "request_id": "busy",
    })
    assert channel._send_event.await_args.kwargs["code"] == "run_active"
    assert channel._session_manager.read_session_file("websocket:video")["metadata"]["model_binding"] == BINDING


@pytest.mark.asyncio
async def test_explicit_update_null_is_persisted_and_existing_messages_stay_unchanged(channel):
    source = _video(channel)
    source.add_message("user", "earlier")
    channel._session_manager.save(source)
    await channel._dispatch_envelope(object(), "client", {
        "type": "video_model_binding_update", "chat_id": "video", "model_binding": None, "request_id": "clear",
    })
    result = channel._send_event.await_args
    assert result.args[1] == "video_model_binding_result" and result.kwargs["ok"] is True
    assert result.kwargs["request_id"] == "clear" and result.kwargs["model_binding"] is None
    assert source.metadata["model_binding"] is None and source.messages[0]["content"] == "earlier"


@pytest.mark.asyncio
async def test_update_failure_preserves_old_selection_and_does_not_send_model_message(channel, monkeypatch):
    source = _video(channel)
    monkeypatch.setattr("mona.agent.video_model_binding.validate_video_model_binding", AsyncMock(side_effect=ValueError("请选择可用模型。")))
    await channel._dispatch_envelope(object(), "client", {
        "type": "video_model_binding_update", "chat_id": "video",
        "model_binding": {"executor": "claude", "model": "new"}, "request_id": "fail",
    })
    assert channel._send_event.await_args.kwargs["ok"] is False
    assert source.metadata["model_binding"] == BINDING
    channel._handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_message_cannot_switch_model_after_a_run_starts(channel, monkeypatch):
    session = _video(channel)
    monkeypatch.setattr("mona.channels.websocket.websocket_turn_wall_started_at", lambda _: 10)
    await channel._dispatch_envelope(object(), "client", {
        "type": "message", "chat_id": "video", "content": "change model", "model_binding": None,
    })
    assert channel._send_event.await_args.kwargs["code"] == "run_active"
    assert session.metadata["model_binding"] == BINDING
    channel._handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_model_binding_branch_copies_selection_without_mutating_source(channel, tmp_path, monkeypatch):
    from mona.webui.transcript import write_transcript_objects

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path / "webui")
    source = _video(channel)
    source.messages = [{"role": "user", "content": "question"}, {"role": "assistant", "content": "answer"}]
    channel._session_manager.save(source)
    write_transcript_objects("websocket:video", [
        {"event": "user", "chat_id": "video", "text": "question"},
        {"event": "message", "chat_id": "video", "text": "answer"},
    ])
    await channel._dispatch_envelope(object(), "client", {
        "type": "branch_chat", "source_chat_id": "video", "assistant_ordinal": 1,
    })
    result = channel._send_event.await_args
    assert result.args[1] == "attached" and result.kwargs["model_binding"] == BINDING
    branch = channel._session_manager.get_or_create(f"websocket:{result.kwargs['chat_id']}")
    assert branch.metadata["model_binding"] == BINDING
    branch.metadata["model_binding"]["model"] = "independent"
    assert source.metadata["model_binding"] == BINDING


def test_model_binding_get_is_authenticated_lightweight_and_never_creates(channel, monkeypatch):
    _video(channel)
    request = Request(path="/api/sessions/websocket%3Avideo/model-binding", headers=Headers())
    monkeypatch.setattr(channel, "_check_api_token", lambda _: False)
    assert channel._handle_video_model_binding_get(request, "websocket%3Avideo").status_code == 401
    monkeypatch.setattr(channel, "_check_api_token", lambda _: True)
    channel._session_manager.read_session_file = MagicMock(side_effect=AssertionError("no full history"))
    response = channel._handle_video_model_binding_get(request, quote("websocket:video", safe=""))
    assert response.status_code == 200 and json.loads(response.body)["modelBinding"] == BINDING
    assert channel._handle_video_model_binding_get(request, "websocket%3Amissing").status_code == 404
    assert channel._handle_video_model_binding_get(request, "slack%3Avideo").status_code == 404
    assert not channel._session_manager._get_session_path("websocket:missing").exists()
