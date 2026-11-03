import asyncio

import pytest
import pytest_asyncio
from aiohttp import WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from mona_interaction.app import create_app


@pytest_asyncio.fixture
async def client():
    async with TestClient(TestServer(create_app())) as test_client:
        yield test_client


def command(kind, message_id, *, text=None, version=1):
    payload = {} if text is None else {"text": text}
    return {
        "version": version,
        "type": kind,
        "session_id": "session-1",
        "message_id": message_id,
        "payload": payload,
    }


async def receive(ws):
    return await asyncio.wait_for(ws.receive_json(), timeout=3)


async def receive_until_idle(ws):
    events = []
    while True:
        item = await receive(ws)
        events.append(item)
        if item["type"] == "turn.state" and item["payload"]["state"] == "idle":
            return events


@pytest.mark.asyncio
async def test_health_identifies_demo(client):
    async with client.get("/health") as response:
        assert response.status == 200
        health = await response.json()
    assert health["status"] == "ok"
    assert health["module"] == "mona-interaction"
    assert health["mode"] == "demo"
    assert type(health["protocol_version"]) is int
    assert health["protocol_version"] == 1


@pytest.mark.asyncio
async def test_websocket_turn_streams_a_complete_reply(client):
    async with client.ws_connect("/ws") as ws:
        await ws.send_json(command("input.text", "message-1", text="你好"))
        events = await receive_until_idle(ws)

    types = [item["type"] for item in events]
    assert types[:2] == ["input.accepted", "turn.state"]
    assert events[1]["payload"]["state"] == "thinking"
    assert types[-2:] == ["reply.completed", "turn.state"]
    assert types[2:-2] and set(types[2:-2]) == {"reply.delta"}
    assert all(item["version"] == 1 for item in events)
    assert all(item["session_id"] == "session-1" for item in events)
    assert all(item["message_id"] == "message-1" for item in events)
    chunks = "".join(item["payload"]["text"] for item in events[2:-2])
    assert chunks == events[-2]["payload"]["text"]
    assert chunks


@pytest.mark.asyncio
async def test_message_id_is_idempotent_and_rejects_conflicting_text(client):
    original = command("input.text", "message-1", text="第一次")
    async with client.ws_connect("/ws") as ws:
        await ws.send_json(original)
        await ws.send_json(original)
        await ws.send_json(command("input.text", "message-1", text="不同内容"))

        events = []
        while True:
            events.append(await receive(ws))
            kinds = {item["type"] for item in events}
            idle = any(item["type"] == "turn.state" and item["payload"]["state"] == "idle"
                       for item in events)
            if {"session.snapshot", "error"} <= kinds and idle:
                break
        assert sum(item["type"] == "input.accepted" for item in events) == 1
        assert sum(item["type"] == "reply.completed" for item in events) == 1
        snapshots = [item for item in events if item["type"] == "session.snapshot"]
        assert len(snapshots) == 1
        assert len(snapshots[0]["payload"]["records"]) == 1
        errors = [item for item in events if item["type"] == "error"]
        assert len(errors) == 1
        assert errors[0]["payload"]["code"] == "invalid_input"
        completed = next(item for item in events if item["type"] == "reply.completed")

        await ws.send_json(original)
        snapshot = await receive(ws)
        assert snapshot["type"] == "session.snapshot"
        assert snapshot["payload"]["records"] == [{
            "message_id": "message-1",
            "text": "第一次",
            "state": "completed",
            "reply": completed["payload"]["text"],
        }]
        with pytest.raises(asyncio.TimeoutError):
            await ws.receive(timeout=0.7)


@pytest.mark.asyncio
async def test_sync_recovers_completed_result_after_disconnect_without_resending(client):
    async with client.ws_connect("/ws") as observer:
        await observer.send_json(command("session.sync", "sync-before"))
        assert (await receive(observer))["payload"]["records"] == []

        async with client.ws_connect("/ws") as first:
            await first.send_json(command("input.text", "message-1", text="断线测试"))
            assert (await receive(first))["type"] == "input.accepted"
            assert (await receive(first))["payload"]["state"] == "thinking"
        events = await receive_until_idle(observer)
        assert sum(item["type"] == "input.accepted" for item in events) == 1
        completed = [item for item in events if item["type"] == "reply.completed"]
        assert len(completed) == 1

    async with client.ws_connect("/ws") as reconnected:
        await reconnected.send_json(command("session.sync", "sync-after"))
        snapshot = await receive(reconnected)
        assert snapshot["type"] == "session.snapshot"
        assert snapshot["payload"]["state"] == "idle"
        assert snapshot["payload"]["records"] == [{
            "message_id": "message-1",
            "text": "断线测试",
            "state": "completed",
            "reply": completed[0]["payload"]["text"],
        }]


@pytest.mark.asyncio
async def test_boolean_protocol_version_is_rejected(client):
    async with client.ws_connect("/ws") as ws:
        await ws.send_json(command("input.text", "message-1", text="你好", version=True))
        error = await receive(ws)
        assert error["type"] == "error"
        assert error["payload"]["code"] == "invalid_input"

        await ws.send_json(command("session.sync", "sync-1"))
        snapshot = await receive(ws)
        assert snapshot["type"] == "session.snapshot"
        assert snapshot["payload"]["records"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [
    {"Host": "attacker.example"},
    {"Host": "attacker.example@127.0.0.1"},
    {"Origin": "https://attacker.example"},
    {"Origin": "null"},
])
async def test_untrusted_host_and_origin_are_rejected_for_http_and_websocket(client, headers):
    async with client.get("/app.js", headers=headers) as response:
        assert response.status == 403
    with pytest.raises(WSServerHandshakeError) as error:
        await client.ws_connect("/ws", headers=headers)
    assert error.value.status == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("path", [
    "/%2e%2e%2fprotocol.py",
    "/%2e%2e%2f%2e%2e%2fpyproject.toml",
    "/%2e%2e%5cprotocol.py",
    "/protocol.py",
])
async def test_static_files_reject_traversal_and_unlisted_paths(client, path):
    async with client.get("/app.js") as response:
        assert response.status == 200
    async with client.get(URL(path, encoded=True)) as response:
        assert response.status == 404
