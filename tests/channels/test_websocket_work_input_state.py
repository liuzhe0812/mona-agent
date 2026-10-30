import asyncio
import json
import secrets
from unittest.mock import AsyncMock, Mock

import pytest

from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.session.manager import SessionManager


@pytest.fixture
def channel(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.channels.websocket._load_or_create_media_secret", lambda: secrets.token_bytes(32))
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"], "websocketRequiresToken": False},
                               MessageBus(), session_manager=SessionManager(tmp_path))
    channel._try_append_webui_transcript = Mock()
    channel._hydrate_after_subscribe = AsyncMock()
    return channel


def start(channel):
    owner = asyncio.create_task(asyncio.Event().wait())

    async def cancel():
        owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)

    return owner, channel.bus.work_turns.start("websocket:guide-chat", "guide-chat", owner, cancel)


def envelope(turn, **changes):
    return {"type": "message", "chat_id": "guide-chat", "content": "guide", "input_id": "guide-one",
            "target_turn_id": turn.turn_id, "task_id": "same-goal", "webui": True, **changes}


def sent(connection):
    return [json.loads(call.args[0]) for call in connection.send.await_args_list]


async def states(channel):
    values = []
    while channel.bus.outbound_size:
        item = await channel.bus.consume_outbound()
        if item.metadata.get("_work_input_state"):
            values.append(item.metadata["_work_input_state"])
        await channel.send(item)
    return values


async def test_guide_acceptance_is_bus_admission_and_repeated_frame_does_not_publish_twice(channel):
    owner, turn = start(channel)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(turn))
    assert channel.bus.inbound_size == 1
    input_state = channel.bus.work_turns.input_state("guide-chat", "guide-one")
    assert input_state == {"chat_id": "guide-chat", "input_id": "guide-one", "turn_id": turn.turn_id, "state": "accepted"}
    await channel._dispatch_envelope(connection, "fixture", envelope(turn))
    assert channel.bus.inbound_size == 1
    state_events = await states(channel)
    assert all(event["state"] == "accepted" for event in state_events)
    assert any(event["event"] == "work_input_state" for event in sent(connection))
    await channel.bus.work_turns.stop("guide-chat", turn.turn_id)
    await asyncio.gather(owner, return_exceptions=True)


@pytest.mark.parametrize("target", [None, "", "unknown-turn"])
async def test_missing_or_forged_guide_target_never_falls_back_to_a_new_task(channel, target):
    owner, turn = start(channel)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(turn, target_turn_id=target))
    assert channel.bus.inbound_size == 0
    assert any(event.get("message_rejected") is True for event in sent(connection))
    if isinstance(target, str) and target:
        assert next(event for event in sent(connection) if event.get("message_rejected"))["target_turn_id"] == target
    await channel.bus.work_turns.stop("guide-chat", turn.turn_id)
    await asyncio.gather(owner, return_exceptions=True)


async def test_stop_between_media_preparation_and_final_admission_rejects_old_target(channel, monkeypatch):
    owner, turn = start(channel)
    monkeypatch.setattr(channel, "_save_envelope_media", Mock(return_value=(["prepared-media"], None)))

    async def hydrate(_chat):
        assert await channel.bus.work_turns.stop("guide-chat", turn.turn_id) == "stopped"

    monkeypatch.setattr(channel, "_hydrate_after_subscribe", hydrate)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(turn, media=[{}]))
    assert channel.bus.inbound_size == 0
    assert not any(event["event"] == "message_accepted" for event in sent(connection))
    assert any(event.get("message_rejected") is True for event in sent(connection))
    await asyncio.gather(owner, return_exceptions=True)


async def test_stop_after_identity_reservation_but_before_bus_publish_leaves_input_paused(channel, monkeypatch):
    owner, turn = start(channel)

    async def pause(_chat):
        assert await channel.bus.work_turns.stop("guide-chat", turn.turn_id) == "stopped"

    monkeypatch.setattr(channel, "_maybe_push_task_plan", pause)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(turn))
    assert channel.bus.inbound_size == 0
    assert channel.bus.work_turns.input_state("guide-chat", "guide-one")["state"] == "paused"
    assert not any(event["event"] == "message_accepted" for event in sent(connection))
    await asyncio.gather(owner, return_exceptions=True)


async def test_resume_same_id_requires_explicit_flag_and_is_not_duplicated(channel):
    owner, old = start(channel)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(old))
    old_message = await channel.bus.consume_inbound()
    await channel.bus.work_turns.stop("guide-chat", old.turn_id)
    assert await channel.bus.publish_inbound(old_message) is False
    newer, current = start(channel)
    await channel._dispatch_envelope(connection, "fixture", envelope(current))
    assert channel.bus.inbound_size == 0
    await channel._dispatch_envelope(connection, "fixture", envelope(current, resume_input=True))
    assert channel.bus.inbound_size == 1
    await channel._dispatch_envelope(connection, "fixture", envelope(current, resume_input=True))
    assert channel.bus.inbound_size == 1
    assert channel.bus.work_turns.input_state("guide-chat", "guide-one")["turn_id"] == current.turn_id
    await channel.bus.work_turns.stop("guide-chat", current.turn_id)
    await asyncio.gather(owner, newer, return_exceptions=True)


async def test_unknown_resume_and_structured_room_target_do_not_spawn_other_work(channel, monkeypatch):
    owner, turn = start(channel)
    route = AsyncMock()
    monkeypatch.setattr(channel, "_route_room_agent_mentions", route)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "fixture", envelope(turn, resume_input=True))
    await channel._dispatch_envelope(connection, "fixture", envelope(turn, target_agent_ids=["partner"]))
    route.assert_not_awaited()
    assert channel.bus.inbound_size == 0
    await channel.bus.work_turns.stop("guide-chat", turn.turn_id)
    await asyncio.gather(owner, return_exceptions=True)


async def test_cleanup_blocked_ordinary_input_is_explicitly_rejected(channel):
    release = asyncio.Event()
    owner = asyncio.create_task(asyncio.Event().wait())

    async def cleanup():
        owner.cancel()
        await asyncio.gather(owner, return_exceptions=True)
        await release.wait()

    channel.bus.work_turns.stop_timeout_seconds = 0.01
    turn = channel.bus.work_turns.start("websocket:guide-chat", "guide-chat", owner, cleanup)
    assert await channel.bus.work_turns.stop("guide-chat", turn.turn_id) == "unknown"
    connection = AsyncMock()
    ordinary = envelope(turn, input_id="ordinary-new")
    ordinary.pop("target_turn_id")
    await channel._dispatch_envelope(connection, "fixture", ordinary)
    assert channel.bus.inbound_size == 0
    assert any(event.get("message_rejected") is True for event in sent(connection))
    assert not any(event["event"] == "message_accepted" for event in sent(connection))
    release.set()
    await turn.cleanup_task


@pytest.mark.parametrize("state", ["consumed", "paused", "rejected"])
async def test_same_process_reattach_replays_input_state_after_a_lost_receipt(channel, state):
    owner, turn = start(channel)
    original = AsyncMock()
    channel._attach(original, "guide-chat")
    if state == "rejected":
        await channel._dispatch_envelope(original, "fixture", envelope(turn, media="invalid-media"))
    else:
        await channel._dispatch_envelope(original, "fixture", envelope(turn))
        if state == "consumed":
            channel.bus.work_turns.bind_input("guide-chat", "guide-one", turn.turn_id)
            assert channel.bus.work_turns.consume_input("guide-chat", "guide-one", turn.turn_id)
    channel._cleanup_connection(original)
    await channel.bus.work_turns.stop("guide-chat", turn.turn_id)
    await states(channel)
    reconnected = AsyncMock()
    await channel._dispatch_envelope(reconnected, "fixture", {"type": "attach", "chat_id": "guide-chat"})
    snapshot = next(event for event in sent(reconnected) if event["event"] == "work_input_state")
    assert snapshot == {"event": "work_input_state", "chat_id": "guide-chat", "input_id": "guide-one",
                        "turn_id": turn.turn_id, "state": state}
    await asyncio.gather(owner, return_exceptions=True)


async def test_denied_guide_cannot_create_input_state_in_another_session(channel, monkeypatch):
    owner, turn = start(channel)
    denied = AsyncMock()
    channel._attach(denied, "guide-chat")
    monkeypatch.setattr(channel, "is_allowed", lambda _client: False)
    await channel._dispatch_envelope(denied, "denied", envelope(turn))
    assert channel.bus.work_turns.input_state("guide-chat", "guide-one") is None
    assert channel.bus.inbound_size == 0
    assert sent(denied)[-1]["message_rejected"] is True
    await channel.bus.work_turns.stop("guide-chat", turn.turn_id)
    await asyncio.gather(owner, return_exceptions=True)
