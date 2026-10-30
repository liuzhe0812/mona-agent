"""Work input receipts identify bus admission, independently of the active task."""

import json
from unittest.mock import AsyncMock

import pytest

from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.session.manager import SessionManager


@pytest.fixture
def channel(tmp_path):
    return WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"], "websocketRequiresToken": False},
        MessageBus(), session_manager=SessionManager(tmp_path),
    )


def envelope(**changes):
    return {"type": "message", "chat_id": "receipt-chat", "task_id": "same-task",
            "input_id": "input-one", "content": "continue", "webui": True, **changes}


def sent(connection):
    return [json.loads(call.args[0]) for call in connection.send.await_args_list]


async def test_receipt_is_sent_only_after_the_identified_input_enters_the_real_bus(channel):
    connection = AsyncMock()

    async def observe(message):
        if json.loads(message).get("event") == "message_accepted":
            assert channel.bus.inbound_size == 1

    connection.send.side_effect = observe
    await channel._dispatch_envelope(connection, "client", envelope())
    message = await channel.bus.consume_inbound()
    assert message.metadata["input_id"] == "input-one"
    assert sent(connection)[-1] == {
        "event": "message_accepted", "chat_id": "receipt-chat", "input_id": "input-one",
    }


async def test_rejected_document_only_append_keeps_its_own_id(channel):
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "client", envelope(content="", doc_paths=["uploads/missing.pdf"]))
    assert channel.bus.inbound_size == 0
    assert sent(connection)[-1] == {
        "event": "error", "chat_id": "receipt-chat", "input_id": "input-one",
        "task_id": "same-task", "message_rejected": True, "detail": "missing content",
    }


async def test_partner_target_validation_returns_a_correlated_rejection(channel):
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "client", envelope(target_agent_ids="invalid"))
    assert channel.bus.inbound_size == 0
    assert sent(connection)[-1]["input_id"] == "input-one"
    assert sent(connection)[-1]["message_rejected"] is True


async def test_denied_input_is_rejected_before_side_effects(channel, monkeypatch):
    monkeypatch.setattr(channel, "is_allowed", lambda _sender: False)
    connection = AsyncMock()
    await channel._dispatch_envelope(connection, "client", envelope())
    assert channel.bus.inbound_size == 0
    assert sent(connection)[-1]["code"] == "access_denied"
    assert sent(connection)[-1]["input_id"] == "input-one"


async def test_dispatch_failure_cannot_claim_an_input_was_accepted_or_rejected(channel, monkeypatch):
    original = channel.bus.publish_inbound

    async def unknown(message):
        await original(message)
        raise OSError("transport interrupted after admission")

    monkeypatch.setattr(channel.bus, "publish_inbound", unknown)
    connection = AsyncMock()
    with pytest.raises(OSError):
        await channel._dispatch_envelope(connection, "client", envelope())
    assert channel.bus.inbound_size == 1
    assert not any(event.get("event") == "message_accepted" or event.get("message_rejected") for event in sent(connection))
