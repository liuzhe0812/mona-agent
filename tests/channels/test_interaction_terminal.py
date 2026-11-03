"""Exercise the independent terminal against the real Mona interaction channel."""

import asyncio
import json
import secrets
from contextlib import suppress

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer
from mona_interaction.app import create_app
from mona_interaction.connector import ConnectionSettings, MonaConnector

from mona.agent.loop import AgentLoop
from mona.bus.queue import MessageBus
from mona.channels.interaction import InteractionChannel
from mona.channels.manager import ChannelManager
from mona.config.schema import Config, InteractionChannelConfig
from mona.providers.base import LLMProvider, LLMResponse

SESSION = "terminal_session"
MESSAGE = "input_1"
INPUT = "你好，请和我说话。"
TEXT = "你好，我在这里。"
PERFORMANCE = {
    "tone": "gentle", "smile": 0.6, "gaze": "user",
    "gesture": {"type": "nod", "strength": 0.4},
}
MODEL_REPLY = json.dumps({"text": TEXT, "performance": PERFORMANCE}, ensure_ascii=False)


class LocalModel(LLMProvider):
    """Replace only the external model response, preserving the real agent loop."""

    def __init__(self):
        super().__init__()
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    def get_default_model(self):
        return "interaction-test"

    async def chat(self, messages, **kwargs):
        self.calls.append(messages)
        self.started.set()
        await self.release.wait()
        return LLMResponse(content=MODEL_REPLY)


@pytest_asyncio.fixture
async def bridge(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    bus = MessageBus()
    channel = InteractionChannel(InteractionChannelConfig(enabled=True), bus, state_dir=tmp_path / "bridge")
    model = LocalModel()
    agent = AgentLoop(bus=bus, provider=model, workspace=tmp_path / "workspace", model="interaction-test")
    manager = ChannelManager(Config(), bus)
    manager.channels[channel.name] = channel
    dispatcher = asyncio.create_task(manager._dispatch_outbound())
    agent_task = asyncio.create_task(agent.run())
    try:
        async with TestClient(TestServer(channel.create_app())) as upstream:
            connection = json.loads(channel.connection_file.read_text(encoding="utf-8"))
            settings = ConnectionSettings(str(upstream.make_url("/ws").with_scheme("ws")), connection["token"])
            connector = MonaConnector(settings)
            async with TestClient(TestServer(create_app(connector))) as terminal:
                yield channel, bus, model, agent, connector, terminal
    finally:
        agent.stop()
        agent_task.cancel()
        with suppress(asyncio.CancelledError):
            await agent_task
        active = [task for tasks in agent._active_tasks.values() for task in tasks]
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
        await agent.close_mcp()
        dispatcher.cancel()
        await asyncio.gather(dispatcher, return_exceptions=True)
        await channel.stop()


def command(kind, message_id=MESSAGE, text=INPUT):
    return {"version": 1, "type": kind, "session_id": SESSION, "message_id": message_id,
            "payload": {"text": text} if kind == "input.text" else {}}


async def receive(ws):
    return await asyncio.wait_for(ws.receive_json(), timeout=5)


async def turn(ws):
    events = []
    while True:
        event = await receive(ws)
        events.append(event)
        if event["type"] == "turn.state" and event["payload"]["state"] == "idle":
            return events


async def complete(terminal):
    async with terminal.ws_connect("/ws") as ws:
        await ws.send_json(command("input.text"))
        events = await turn(ws)
    reply = next(event for event in events if event["type"] == "reply.completed")
    return events, reply


async def make_unknown(ws, model, agent):
    model.release.clear()
    await ws.send_json(command("input.text"))
    assert (await receive(ws))["type"] == "input.accepted"
    assert (await receive(ws))["payload"]["state"] == "thinking"
    await asyncio.wait_for(model.started.wait(), timeout=5)
    active = [task for tasks in agent._active_tasks.values() for task in tasks]
    assert len(active) == 1
    active[0].cancel()
    await asyncio.gather(active[0], return_exceptions=True)
    return await turn(ws)


@pytest.mark.asyncio
async def test_terminal_keeps_its_bound_session_when_other_channels_are_unified(bridge):
    _, _, _, agent, _, terminal = bridge
    agent._unified_session = True
    await complete(terminal)
    session = agent.sessions.get_or_create(f"interaction:companion:{SESSION}")
    assert [message["content"] for message in session.messages if message["role"] == "user"] == [INPUT]


@pytest.mark.asyncio
async def test_full_turn_returns_text_and_performance_without_raw_json(bridge):
    _, _, model, _, _, terminal = bridge
    async with terminal.get("/health") as response:
        assert (await response.json())["mode"] == "mona"
    events, reply = await complete(terminal)
    assert [event["type"] for event in events] == [
        "input.accepted", "turn.state", "reply.completed", "turn.state"
    ]
    assert events[1]["payload"]["state"] == "thinking"
    assert reply["payload"] == {"text": TEXT, "performance": PERFORMANCE, "performance_status": "valid"}
    assert MODEL_REPLY not in json.dumps(events, ensure_ascii=False)
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_recreated_terminal_sync_restores_text_and_performance(bridge):
    _, _, model, _, connector, terminal = bridge
    await complete(terminal)
    await terminal.close()
    async with TestClient(TestServer(create_app(connector))) as recreated:
        async with recreated.ws_connect("/ws") as ws:
            await ws.send_json(command("session.sync", "sync_1"))
            snapshot = await receive(ws)
    assert snapshot["type"] == "session.snapshot"
    assert snapshot["payload"]["mode"] == "mona"
    assert snapshot["payload"]["records"] == [{
        "message_id": MESSAGE, "text": INPUT, "state": "completed", "reply": TEXT,
        "performance": PERFORMANCE, "performance_status": "valid",
    }]
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_recreated_terminal_watches_an_already_accepted_turn(bridge):
    _, _, model, _, connector, terminal = bridge
    model.release.clear()
    async with terminal.ws_connect("/ws") as ws:
        await ws.send_json(command("input.text"))
        assert (await receive(ws))["type"] == "input.accepted"
        assert (await receive(ws))["payload"]["state"] == "thinking"
        await asyncio.wait_for(model.started.wait(), timeout=5)
    await terminal.close()

    async with TestClient(TestServer(create_app(connector))) as recreated:
        async with recreated.ws_connect("/ws") as ws:
            await ws.send_json(command("session.sync", "sync_running"))
            snapshot = await receive(ws)
            assert snapshot["type"] == "session.snapshot"
            assert snapshot["payload"]["state"] == "thinking"
            assert snapshot["payload"]["records"][0]["state"] == "accepted"
            assert (await receive(ws))["type"] == "input.accepted"
            assert (await receive(ws))["payload"]["state"] == "thinking"
            model.release.set()
            events = await turn(ws)
    reply = next(event for event in events if event["type"] == "reply.completed")
    assert reply["payload"]["text"] == TEXT
    assert reply["payload"]["performance"] == PERFORMANCE
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_duplicate_id_on_fresh_terminal_does_not_dispatch_again(bridge):
    _, _, model, _, connector, terminal = bridge
    await complete(terminal)
    async with TestClient(TestServer(create_app(connector))) as recreated:
        events, reply = await complete(recreated)
    assert reply["payload"]["text"] == TEXT
    assert reply["payload"]["performance"] == PERFORMANCE
    assert len(model.calls) == 1
    assert sum(event["type"] == "input.accepted" for event in events) == 1

    model.release.clear()
    model.started.clear()
    async with terminal.ws_connect("/ws") as original:
        await original.send_json(command("input.text", "input_2"))
        assert (await receive(original))["type"] == "input.accepted"
        assert (await receive(original))["payload"]["state"] == "thinking"
        await asyncio.wait_for(model.started.wait(), timeout=5)
        async with TestClient(TestServer(create_app(connector))) as recreated:
            async with recreated.ws_connect("/ws") as duplicate:
                await duplicate.send_json(command("input.text", "input_2"))
                assert (await receive(duplicate))["type"] == "input.accepted"
                assert (await receive(duplicate))["payload"]["state"] == "thinking"
                assert len(model.calls) == 2
                model.release.set()
                assert any(event["type"] == "reply.completed" for event in await turn(original))
                assert any(event["type"] == "reply.completed" for event in await turn(duplicate))
    assert len(model.calls) == 2

    async with TestClient(TestServer(create_app(connector))) as recreated:
        async with recreated.ws_connect("/ws") as ws:
            await ws.send_json(command("input.text", text="同一标识的不同内容"))
            events = await turn(ws)
    assert any(event["type"] == "error" for event in events)
    assert len(model.calls) == 2


@pytest.mark.asyncio
async def test_auth_failure_does_not_automatically_resend(bridge):
    _, bus, model, _, connector, _ = bridge
    bad_settings = ConnectionSettings(connector.settings.url, secrets.token_urlsafe(32))
    unauthorized = MonaConnector(bad_settings)
    async with TestClient(TestServer(create_app(unauthorized))) as terminal:
        async with terminal.ws_connect("/ws") as ws:
            await ws.send_json(command("input.text"))
            events = await turn(ws)
            assert [event["payload"]["code"] for event in events if event["type"] == "error"] == [
                "connection_failed"
            ]
            unauthorized.settings = connector.settings
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(model.started.wait(), timeout=0.3)
            await ws.send_json(command("session.sync", "sync_after_auth"))
            snapshot = await receive(ws)
    assert snapshot["payload"]["records"] == []
    assert not model.calls
    assert bus.inbound.empty()


@pytest.mark.asyncio
async def test_disconnect_does_not_resend_and_completed_result_can_be_synced(bridge):
    channel, _, model, _, _, terminal = bridge
    model.release.clear()
    async with terminal.ws_connect("/ws") as ws:
        await ws.send_json(command("input.text"))
        assert (await receive(ws))["type"] == "input.accepted"
        assert (await receive(ws))["payload"]["state"] == "thinking"
        await asyncio.wait_for(model.started.wait(), timeout=5)
        upstream = next(iter(channel._connections[SESSION]))
        await upstream.close()
        events = await turn(ws)
        assert [event["payload"]["code"] for event in events if event["type"] == "error"] == [
            "result_unknown"
        ]
        model.release.set()
        for _ in range(200):
            await ws.send_json(command("session.sync", "sync_after_disconnect"))
            snapshot = await receive(ws)
            records = snapshot["payload"]["records"]
            if records and records[0]["state"] == "completed":
                break
            await asyncio.sleep(0.025)
        else:
            pytest.fail("The completed turn could not be recovered by synchronization")
    assert records[0]["reply"] == TEXT
    assert records[0]["performance"] == PERFORMANCE
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_unknown_upstream_turn_reports_uncertain_result_without_resending(bridge):
    _, _, model, agent, connector, terminal = bridge
    async with terminal.ws_connect("/ws") as ws:
        events = await make_unknown(ws, model, agent)
    assert [event["payload"]["code"] for event in events if event["type"] == "error"] == ["result_unknown"]
    assert not any(event["type"] == "reply.completed" for event in events)

    async with TestClient(TestServer(create_app(connector))) as recreated:
        async with recreated.ws_connect("/ws") as ws:
            await ws.send_json(command("input.text"))
            repeated = await turn(ws)
    assert [event["payload"]["code"] for event in repeated if event["type"] == "error"] == ["result_unknown"]
    assert len(model.calls) == 1


@pytest.mark.asyncio
async def test_acknowledging_unknown_allows_new_input_without_reexecuting_original(bridge):
    _, _, model, agent, _, terminal = bridge
    async with terminal.ws_connect("/ws") as ws:
        events = await make_unknown(ws, model, agent)
        assert any(event["type"] == "error" and event["payload"]["code"] == "result_unknown" for event in events)

        await ws.send_json(command("input.text", "blocked_input", "请继续"))
        blocked = await turn(ws)
        assert any(event["type"] == "error" for event in blocked)
        assert len(model.calls) == 1

        await ws.send_json({
            "version": 1, "type": "input.resolve", "session_id": SESSION, "message_id": "resolve_1",
            "payload": {"message_id": MESSAGE, "acknowledged": True},
        })
        snapshot = await receive(ws)
        assert snapshot["type"] == "session.snapshot"
        original = next(row for row in snapshot["payload"]["records"] if row["message_id"] == MESSAGE)
        assert original["state"] == "closed_unknown"
        assert len(model.calls) == 1

        await ws.send_json(command("input.text"))
        repeated = await receive(ws)
        assert repeated["type"] == "session.snapshot"
        assert len(model.calls) == 1

        model.release.set()
        await ws.send_json(command("input.text", "input_2", "继续新的任务"))
        events = await turn(ws)
    assert any(event["type"] == "reply.completed" for event in events)
    assert len(model.calls) == 2
