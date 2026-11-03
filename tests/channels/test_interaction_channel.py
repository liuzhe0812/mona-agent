"""Behavior of the local interaction bridge through its real message bus."""

import asyncio
import json
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from aiohttp import WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from mona.agent.loop import AgentLoop
from mona.bus.events import OutboundMessage
from mona.bus.queue import MessageBus
from mona.channels.interaction import InteractionChannel
from mona.channels.manager import ChannelManager
from mona.channels.registry import discover_channel_names, discover_enabled
from mona.config.schema import ChannelsConfig, Config, InteractionChannelConfig


def _auth_headers(channel: InteractionChannel) -> dict[str, str]:
    connection = json.loads(channel.connection_file.read_text(encoding="utf-8"))
    return {"Authorization": f"Bearer {connection['token']}"}


def _command(kind: str, message_id: str, text: str = "") -> dict:
    return {
        "version": 1,
        "type": kind,
        "session_id": "conversation_1",
        "message_id": message_id,
        "payload": {"text": text},
    }


async def _receive_json(ws) -> dict:
    return await asyncio.wait_for(ws.receive_json(), timeout=2)


async def _wait_for_parts(channel: InteractionChannel, expected: list[str]) -> None:
    async def wait() -> None:
        while True:
            record = channel.store.get(f"{channel.config.device_id}:conversation_1", "request_1")
            if record is not None and record["parts"] == expected:
                return
            await asyncio.sleep(0.005)

    await asyncio.wait_for(wait(), timeout=2)


@pytest_asyncio.fixture
async def bridge(tmp_path: Path):
    bus = MessageBus()
    channel = InteractionChannel(
        InteractionChannelConfig(enabled=True), bus, state_dir=tmp_path / "state"
    )
    manager = ChannelManager(Config(), bus)
    manager.channels[channel.name] = channel
    dispatcher = asyncio.create_task(manager._dispatch_outbound())
    try:
        async with TestClient(TestServer(channel.create_app())) as client:
            yield channel, bus, client
    finally:
        dispatcher.cancel()
        with suppress(asyncio.CancelledError):
            await dispatcher
        await channel.stop()


@pytest.mark.asyncio
async def test_websocket_requires_credential_and_rejects_browser_origin(bridge) -> None:
    channel, _, client = bridge
    with pytest.raises(WSServerHandshakeError) as missing:
        await client.ws_connect("/ws")
    assert missing.value.status == 401

    with pytest.raises(WSServerHandshakeError) as wrong:
        await client.ws_connect("/ws", headers={"Authorization": "Bearer invalid"})
    assert wrong.value.status == 401

    headers = _auth_headers(channel)
    with pytest.raises(WSServerHandshakeError) as browser:
        await client.ws_connect("/ws", headers={**headers, "Origin": "https://example.com"})
    assert browser.value.status == 401

    async with client.ws_connect("/ws", headers=headers) as ws:
        await ws.send_json(_command("session.sync", "sync_1"))
        assert (await _receive_json(ws))["type"] == "session.snapshot"


@pytest.mark.asyncio
async def test_input_and_completion_use_the_real_message_bus(bridge) -> None:
    channel, bus, client = bridge
    raw_text = "  你好，Mona\n请听我说。  "
    async with client.ws_connect("/ws", headers=_auth_headers(channel)) as ws:
        await ws.send_json(_command("input.text", "request_1", raw_text))
        accepted = await _receive_json(ws)
        assert accepted["type"] == "input.accepted"
        assert accepted["message_id"] == "request_1"
        assert accepted["payload"]["text"] == raw_text

        inbound = await asyncio.wait_for(bus.consume_inbound(), timeout=2)
        assert inbound.channel == "interaction"
        assert inbound.sender_id == channel.config.device_id
        assert inbound.chat_id == f"{channel.config.device_id}:conversation_1"
        assert inbound.content == raw_text
        assert inbound.metadata["origin_message_id"] == "request_1"
        assert inbound.metadata["_interaction_message_id"] == "request_1"
        assert inbound.metadata["_interaction_session_id"] == "conversation_1"
        assert inbound.metadata["_wants_channel_turn_end"] is True
        assert not inbound.metadata.get("_wants_stream")

        answer = '{"text":"你好","performance":{"tone":"gentle"}}'
        await bus.publish_outbound(OutboundMessage(
            channel=inbound.channel, chat_id=inbound.chat_id,
            content=answer, metadata=dict(inbound.metadata),
        ))
        await _wait_for_parts(channel, [answer])
        # A sync reply must be the next event; the answer alone did not complete the turn.
        await ws.send_json(_command("session.sync", "sync_1"))
        snapshot = await _receive_json(ws)
        assert snapshot["type"] == "session.snapshot"
        assert snapshot["payload"]["records"][0]["status"] == "accepted"
        assert snapshot["payload"]["records"][0]["parts"] == [answer]

        await bus.publish_outbound(OutboundMessage(
            channel=inbound.channel, chat_id=inbound.chat_id, content="",
            metadata={**inbound.metadata, "_channel_turn_end": True,
                      "_channel_turn_status": "completed"},
        ))
        completed = await _receive_json(ws)
        assert completed["type"] == "turn.completed"
        assert completed["message_id"] == "request_1"
        assert completed["payload"]["status"] == "completed"
        assert completed["payload"]["parts"] == [answer]


@pytest.mark.asyncio
async def test_agent_dispatch_emits_completion_after_reply(bridge, tmp_path: Path) -> None:
    channel, bus, client = bridge
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    loop = AgentLoop(bus=bus, provider=provider, workspace=tmp_path, model="test-model")
    async with client.ws_connect("/ws", headers=_auth_headers(channel)) as ws:
        await ws.send_json(_command("input.text", "request_1", "你好"))
        assert (await _receive_json(ws))["type"] == "input.accepted"
        inbound = await asyncio.wait_for(bus.consume_inbound(), timeout=2)
        loop._process_message = AsyncMock(return_value=OutboundMessage(
            channel=inbound.channel, chat_id=inbound.chat_id, content="你好",
            metadata=dict(inbound.metadata),
        ))
        await loop._dispatch(inbound)
        completed = await _receive_json(ws)
        assert completed["type"] == "turn.completed"
        assert completed["message_id"] == "request_1"
        assert completed["payload"]["status"] == "completed"
        assert completed["payload"]["parts"] == ["你好"]
    await loop.close_mcp()


@pytest.mark.asyncio
async def test_duplicate_id_is_not_redispatched_and_cannot_change_text(bridge) -> None:
    channel, bus, client = bridge
    async with client.ws_connect("/ws", headers=_auth_headers(channel)) as ws:
        message = _command("input.text", "request_1", "原文")
        await ws.send_json(message)
        assert (await _receive_json(ws))["type"] == "input.accepted"
        await asyncio.wait_for(bus.consume_inbound(), timeout=2)

        await ws.send_json(message)
        snapshot = await _receive_json(ws)
        assert snapshot["type"] == "session.snapshot"
        assert snapshot["payload"]["records"][0]["text"] == "原文"
        assert bus.inbound.empty()

        await ws.send_json(_command("input.text", "request_1", "不同内容"))
        rejected = await _receive_json(ws)
        assert rejected["type"] == "error"
        assert rejected["payload"]["code"] == "invalid_input"
        assert bus.inbound.empty()


@pytest.mark.asyncio
async def test_restart_marks_pending_unknown_without_dispatch(tmp_path: Path) -> None:
    state_dir = tmp_path / "state"
    config = InteractionChannelConfig(enabled=True)
    first_bus = MessageBus()
    first = InteractionChannel(config, first_bus, state_dir=state_dir)
    async with TestClient(TestServer(first.create_app())) as client:
        async with client.ws_connect("/ws", headers=_auth_headers(first)) as ws:
            await ws.send_json(_command("input.text", "request_1", "继续上一项工作"))
            assert (await _receive_json(ws))["type"] == "input.accepted"
            await asyncio.wait_for(first_bus.consume_inbound(), timeout=2)
    await first.stop()

    second_bus = MessageBus()
    second = InteractionChannel(config, second_bus, state_dir=state_dir)
    try:
        async with TestClient(TestServer(second.create_app())) as client:
            async with client.ws_connect("/ws", headers=_auth_headers(second)) as ws:
                await ws.send_json(_command("session.sync", "sync_2"))
                snapshot = await _receive_json(ws)
                assert snapshot["type"] == "session.snapshot"
                assert snapshot["payload"]["records"][0]["status"] == "unknown"
                assert second_bus.inbound.empty()

                await ws.send_json(_command("input.text", "request_1", "继续上一项工作"))
                repeated = await _receive_json(ws)
                assert repeated["type"] == "session.snapshot"
                assert repeated["payload"]["records"][0]["status"] == "unknown"
                assert second_bus.inbound.empty()

                await ws.send_json(_command("input.text", "request_2", "另一条输入"))
                assert (await _receive_json(ws))["type"] == "error"
                assert second_bus.inbound.empty()
    finally:
        await second.stop()


@pytest.mark.asyncio
async def test_channel_is_disabled_by_default_and_discoverable(tmp_path: Path, monkeypatch) -> None:
    defaults = Config()
    assert defaults.channels.interaction.enabled is False
    assert "interaction" in discover_channel_names()
    assert discover_enabled({"interaction"})["interaction"] is InteractionChannel
    assert "interaction" not in ChannelManager(defaults, MessageBus()).channels

    monkeypatch.setattr("mona.channels.interaction.get_data_dir", lambda: tmp_path)
    enabled = Config(channels=ChannelsConfig(interaction=InteractionChannelConfig(enabled=True)))
    manager = ChannelManager(enabled, MessageBus())
    channel = manager.channels["interaction"]
    try:
        assert isinstance(channel, InteractionChannel)
        assert not channel.supports_streaming
    finally:
        await channel.stop()
