import asyncio
import json
import secrets
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mona.bus.events import InboundMessage, OutboundMessage
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.session.manager import SessionManager
from mona.session.webui_turns import (
    notify_work_turn_closed,
    publish_turn_run_status,
    websocket_turn_wall_started_at,
)


@pytest.fixture
def channel(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.channels.websocket._load_or_create_media_secret", lambda: secrets.token_bytes(32))
    monkeypatch.setattr("mona.session.webui_turns._WEBSOCKET_TURN_WALL_STARTED_AT", {})
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"], "websocketRequiresToken": False},
        MessageBus(), session_manager=SessionManager(tmp_path),
    )
    channel._try_append_webui_transcript = Mock()
    return channel


def start(channel, chat="chat-a", *, result=None):
    task = asyncio.create_task(asyncio.Event().wait())

    async def cancel():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return result

    turn = channel.bus.work_turns.start(f"websocket:{chat}", chat, task, cancel, input_id="input-a",
                                      on_closed=lambda turn: notify_work_turn_closed(channel.bus, turn))
    return task, turn


def sent(connection):
    return [json.loads(call.args[0]) for call in connection.send.await_args_list]


@pytest.mark.parametrize("mode", ["unattached", "missing_turn", "denied"])
async def test_invalid_stop_never_cancels_the_main_task(channel, monkeypatch, mode):
    task, turn = start(channel)
    connection = AsyncMock()
    envelope = {"type": "stop_work_turn", "chat_id": "chat-a", "request_id": "request-a", "expected_turn_id": turn.turn_id}
    if mode != "unattached":
        channel._attach(connection, "chat-a")
    if mode == "missing_turn":
        envelope.pop("expected_turn_id")
    if mode == "denied":
        monkeypatch.setattr(channel, "is_allowed", lambda _client: False)
    await channel._dispatch_envelope(connection, client_id="fixture", envelope=envelope)
    assert sent(connection)[-1]["ok"] is False
    assert not task.done()
    await channel.bus.work_turns.stop("chat-a", turn.turn_id)


async def test_stale_stop_does_not_touch_new_main_or_create_a_text_command(channel):
    old_task, old = start(channel)
    await channel.bus.work_turns.stop("chat-a", old.turn_id)
    task, current = start(channel)
    connection = AsyncMock()
    channel._attach(connection, "chat-a")
    channel._handle_message = AsyncMock()
    await channel._dispatch_envelope(connection, client_id="fixture", envelope={
        "type": "stop_work_turn", "chat_id": "chat-a", "request_id": "request-a", "expected_turn_id": old.turn_id,
    })
    assert sent(connection)[-1] == {"event": "work_turn_stop_result", "ok": True, "outcome": "already_finished",
                                    "chat_id": "chat-a", "request_id": "request-a", "turn_id": old.turn_id}
    assert not task.done()
    channel._handle_message.assert_not_awaited()
    assert channel.bus.inbound_size == 0
    await channel.bus.work_turns.stop("chat-a", current.turn_id)
    await asyncio.gather(old_task, return_exceptions=True)


async def test_hydrate_reports_exact_main_identity_and_external_unknown_is_not_stopped(channel):
    task, turn = start(channel, result="unknown")
    connection = AsyncMock()
    channel._attach(connection, "chat-a")
    await channel._hydrate_after_subscribe("chat-a")
    status = next(event for event in sent(connection) if event["event"] == "goal_status")
    assert status["turn_id"] == turn.turn_id
    assert status["input_id"] == "input-a"
    assert status["turn_state"] == "running"
    await channel._dispatch_envelope(connection, client_id="fixture", envelope={
        "type": "stop_work_turn", "chat_id": "chat-a", "request_id": "request-a", "expected_turn_id": turn.turn_id,
    })
    result = sent(connection)[-1]
    assert result["outcome"] == "unknown"
    assert result["external_unknown"] is True
    assert task.done()
    await channel.bus.work_turns.wait_ready("websocket:chat-a")


async def test_subagent_only_running_state_never_invents_a_main_identity(channel):
    channel._subagent_manager = SimpleNamespace(get_running_count_by_session=lambda _key: 1,
                                               get_session_started_at=lambda _key: 100)
    connection = AsyncMock()
    channel._attach(connection, "chat-a")
    await channel._hydrate_after_subscribe("chat-a")
    status = next(event for event in sent(connection) if event["event"] == "goal_status")
    assert status["status"] == "running"
    assert "turn_id" not in status
    await channel._dispatch_envelope(connection, client_id="fixture", envelope={
        "type": "stop_work_turn", "chat_id": "chat-a", "request_id": "request-a", "expected_turn_id": "missing-main",
    })
    assert sent(connection)[-1]["outcome"] == "unsupported"


async def test_old_idle_cannot_clear_new_main_and_streams_keep_identity(channel):
    task, turn = start(channel)
    connection = AsyncMock()
    channel._attach(connection, "chat-a")
    metadata = {"turn_id": turn.turn_id, "input_id": "input-a", "task_id": "shared-goal"}
    await publish_turn_run_status(channel.bus, InboundMessage("websocket", "fixture", "chat-a", "", metadata=metadata), "running")
    await channel._send_combined_goal_status("chat-a", "idle", turn_id="old-turn")
    assert sent(connection) == []
    await channel.send_delta("chat-a", "text", metadata)
    await channel.send_reasoning_delta("chat-a", "reason", metadata)
    await channel.send_reasoning_end("chat-a", metadata)
    await channel.send(OutboundMessage("websocket", "chat-a", "", metadata={**metadata, "_turn_end": True}))
    for event in sent(connection):
        assert event["turn_id"] == turn.turn_id
        assert event["input_id"] == "input-a"
    await channel.bus.work_turns.stop("chat-a", turn.turn_id)
    await asyncio.gather(task, return_exceptions=True)


async def test_late_cleanup_closes_the_turn_for_all_windows_without_another_stop(channel):
    channel.bus.work_turns.stop_timeout_seconds = 0.01
    owner = asyncio.create_task(asyncio.Event().wait())
    release = asyncio.Event()

    async def cleanup():
        owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)
        await release.wait()

    turn = channel.bus.work_turns.start("websocket:chat-a", "chat-a", owner, cleanup,
                                      on_closed=lambda value: notify_work_turn_closed(channel.bus, value))
    requester, observer = AsyncMock(), AsyncMock()
    channel._attach(requester, "chat-a")
    channel._attach(observer, "chat-a")
    await publish_turn_run_status(channel.bus, InboundMessage("websocket", "fixture", "chat-a", "",
                                  metadata={"turn_id": turn.turn_id}), "running")
    await channel._handle_stop_work_turn(requester, "fixture", {
        "chat_id": "chat-a", "request_id": "request-a", "expected_turn_id": turn.turn_id,
    })
    assert sent(requester)[-1]["outcome"] == "unknown"
    assert websocket_turn_wall_started_at("chat-a") is not None
    release.set()
    await turn.cleanup_task
    await asyncio.sleep(0)
    while channel.bus.outbound_size:
        await channel.send(await channel.bus.consume_outbound())
    assert websocket_turn_wall_started_at("chat-a") is None
    assert channel.bus.work_turns.current("chat-a") is None
    assert any(event.get("event") == "goal_status" and event["status"] == "idle"
               and event["turn_id"] == turn.turn_id for event in sent(observer))
