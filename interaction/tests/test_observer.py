import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from mona_interaction.app import TASKS, create_app
from mona_interaction.connector import ConnectorError


def message(kind, message_id, payload=None):
    return {"version": 1, "type": kind, "session_id": "session-1",
            "message_id": message_id, "payload": payload or {}}


class Connector:
    def __init__(self):
        self.status = "accepted"
        self.requested = 0

    async def lookup(self, session_id):
        return [{"message_id": "task-1", "text": "任务", "status": self.status, "parts": []}]

    async def request(self, *args):
        self.requested += 1
        raise AssertionError("An observer must never start a request")


class RacingConnector:
    """Freeze one historical read while a real writer progresses."""

    def __init__(self, block_call, *, fail_lookup=False, stale_records=None):
        self.block_call = block_call
        self.fail_lookup = fail_lookup
        self.stale_records = stale_records or []
        self.lookup_calls = 0
        self.lookup_started = asyncio.Event()
        self.release_lookup = asyncio.Event()
        self.accepted = asyncio.Event()
        self.finish_request = asyncio.Event()
        self.requested = 0

    async def lookup(self, session_id):
        self.lookup_calls += 1
        # The read was taken before the concurrent task was admitted.
        stale_records = self.stale_records
        if self.lookup_calls == self.block_call:
            self.lookup_started.set()
            await self.release_lookup.wait()
            if self.fail_lookup:
                raise ConnectorError("连接暂时不可用。")
        return stale_records

    async def request(self, command, on_accepted):
        self.requested += 1
        await on_accepted()
        self.accepted.set()
        await self.finish_request.wait()
        return {"state": "completed", "reply": "已完成", "performance": None,
                "performance_status": "missing"}


@pytest.mark.asyncio
async def test_observer_reads_existing_tasks_without_recovery_or_dispatch():
    connector = Connector()
    app = create_app(connector=connector)
    async with TestClient(TestServer(app)) as client:
        async with client.ws_connect("/ws") as ws:
            await ws.send_json(message("session.observe", "first"))
            snapshot = await ws.receive_json()
            assert snapshot["type"] == "session.snapshot"
            assert snapshot["payload"]["pending_id"] == "task-1"
            assert snapshot["payload"]["state"] == "thinking"
            assert not app[TASKS]
            await ws.send_json(message("input.text", "other", {"text": "不应执行"}))
            assert (await ws.receive_json())["type"] == "error"
            connector.status = "completed"
            await ws.send_json(message("session.observe", "second"))
            snapshot = await ws.receive_json()
            assert snapshot["payload"]["pending_id"] is None
            assert snapshot["payload"]["state"] == "idle"
            await asyncio.sleep(0)
            assert connector.requested == 0
            assert not app[TASKS]


@pytest.mark.asyncio
async def test_observer_receives_events_from_a_separate_writer():
    async with TestClient(TestServer(create_app(demo=True))) as client:
        async with client.ws_connect("/ws") as observer, client.ws_connect("/ws") as writer:
            await observer.send_json(message("session.observe", "initial"))
            assert (await observer.receive_json())["type"] == "session.snapshot"
            await writer.send_json(message("input.text", "task-1", {"text": "你好"}))
            assert (await observer.receive_json())["type"] == "input.accepted"
            assert (await observer.receive_json())["payload"]["state"] == "thinking"
            while True:
                event = await asyncio.wait_for(observer.receive_json(), 3)
                if event["type"] == "turn.state" and event["payload"]["state"] == "idle":
                    break


@pytest.mark.asyncio
@pytest.mark.parametrize("block_call,finish_before_snapshot", [(1, True), (2, False)])
async def test_snapshot_precedes_concurrent_events_without_repeating_input(block_call, finish_before_snapshot):
    connector = RacingConnector(block_call)
    app = create_app(connector=connector)
    async with TestClient(TestServer(app)) as client:
        async with client.ws_connect("/ws") as observer, client.ws_connect("/ws") as writer:
            try:
                if block_call == 2:
                    await observer.send_json(message("session.observe", "initial"))
                    assert (await observer.receive_json())["type"] == "session.snapshot"
                await observer.send_json(message("session.observe", "delayed"))
                await asyncio.wait_for(connector.lookup_started.wait(), 2)
                await writer.send_json(message("input.text", "task-1", {"text": "你好"}))
                # A stalled historical read must not delay the writer's acceptance.
                await asyncio.wait_for(connector.accepted.wait(), 2)
                if finish_before_snapshot:
                    connector.finish_request.set()
                    await asyncio.wait_for(asyncio.gather(*tuple(app[TASKS])), 2)
                connector.release_lookup.set()

                snapshot = await asyncio.wait_for(observer.receive_json(), 2)
                assert snapshot["type"] == "session.snapshot"
                assert snapshot["payload"]["state"] == "idle"
                accepted = await asyncio.wait_for(observer.receive_json(), 2)
                thinking = await asyncio.wait_for(observer.receive_json(), 2)
                assert (accepted["type"], accepted["message_id"]) == ("input.accepted", "task-1")
                assert (thinking["type"], thinking["payload"]["state"]) == ("turn.state", "thinking")
                connector.finish_request.set()
                completed = await asyncio.wait_for(observer.receive_json(), 2)
                idle = await asyncio.wait_for(observer.receive_json(), 2)
                assert (completed["type"], completed["message_id"]) == ("reply.completed", "task-1")
                assert (idle["type"], idle["payload"]["state"]) == ("turn.state", "idle")
                assert connector.requested == 1
            finally:
                connector.release_lookup.set()
                connector.finish_request.set()


@pytest.mark.asyncio
async def test_failed_snapshot_reports_error_and_releases_buffered_events():
    connector = RacingConnector(1, fail_lookup=True)
    app = create_app(connector=connector)
    async with TestClient(TestServer(app)) as client:
        async with client.ws_connect("/ws") as observer, client.ws_connect("/ws") as writer:
            try:
                await observer.send_json(message("session.observe", "first"))
                await asyncio.wait_for(connector.lookup_started.wait(), 2)
                await writer.send_json(message("input.text", "task-1", {"text": "你好"}))
                await asyncio.wait_for(connector.accepted.wait(), 2)
                connector.release_lookup.set()
                error = await asyncio.wait_for(observer.receive_json(), 2)
                assert (error["type"], error["payload"]["code"]) == ("error", "sync_failed")
                assert (await asyncio.wait_for(observer.receive_json(), 2))["type"] == "input.accepted"
                assert (await asyncio.wait_for(observer.receive_json(), 2))["payload"]["state"] == "thinking"
                await observer.send_json(message("session.observe", "retry"))
                snapshot = await asyncio.wait_for(observer.receive_json(), 2)
                assert snapshot["type"] == "session.snapshot"
                assert snapshot["payload"]["pending_id"] == "task-1"
                assert connector.requested == 1
            finally:
                connector.release_lookup.set()
                connector.finish_request.set()


@pytest.mark.asyncio
async def test_conflicting_old_pending_snapshot_requests_refresh_without_replaying_input():
    connector = RacingConnector(1, stale_records=[
        {"message_id": "old-task", "text": "之前的任务", "status": "accepted", "parts": []},
    ])
    app = create_app(connector=connector)
    async with TestClient(TestServer(app)) as client:
        async with client.ws_connect("/ws") as observer, client.ws_connect("/ws") as writer:
            try:
                await observer.send_json(message("session.observe", "first"))
                await asyncio.wait_for(connector.lookup_started.wait(), 2)
                await writer.send_json(message("input.text", "task-1", {"text": "你好"}))
                await asyncio.wait_for(connector.accepted.wait(), 2)
                connector.release_lookup.set()
                error = await asyncio.wait_for(observer.receive_json(), 2)
                assert (error["type"], error["payload"]["code"]) == ("error", "sync_failed")
                assert (await asyncio.wait_for(observer.receive_json(), 2))["type"] == "input.accepted"
                assert (await asyncio.wait_for(observer.receive_json(), 2))["payload"]["state"] == "thinking"
                await observer.send_json(message("session.observe", "retry"))
                snapshot = await asyncio.wait_for(observer.receive_json(), 2)
                assert snapshot["type"] == "session.snapshot"
                assert snapshot["payload"]["pending_id"] == "task-1"
                assert connector.requested == 1
            finally:
                connector.release_lookup.set()
                connector.finish_request.set()
