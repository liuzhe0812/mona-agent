"""SDK spawn is not a successful control-protocol exchange; no vendor account used."""
import asyncio
from types import SimpleNamespace

import pytest

from mona.development.executors.sdk_worker import Worker


class DeferredClient:
    def __init__(self, result, gate):
        self.result, self.gate = result, gate
        self.entered = asyncio.Event()
        self.connected = False
        self.closed = False
        self.owner = None
        self.calls = []

    async def connect(self, prompt=None):
        self.owner = asyncio.current_task()
        self.connected = True
        if prompt is not None:
            self.calls.append("initialize")
            self.entered.set()
            await self.gate.wait()
            async for message in prompt:
                raise AssertionError("Unexpected user message during initialization")

    async def mcp_server_status(self):
        raise AssertionError("Installed CLI does not implement this SDK control method")

    async def receive_messages(self):
        await asyncio.Event().wait()
        if False:
            yield {}

    async def disconnect(self):
        assert self.owner is asyncio.current_task()
        self.closed = True


def start_worker(monkeypatch, client, *, executor="codebuddy", host=False):
    worker = Worker()
    start = {"executor": executor, "nativeSessionId": "native-test", "permissionMode": "ask"}
    worker.start = start
    worker.ready = asyncio.get_running_loop().create_future()
    worker.permission_modes = ["ask"]
    worker.projector = SimpleNamespace(host_collaboration=host, work_tool=False, design_resources=False)
    monkeypatch.setattr(worker, "build_options", lambda _: (client, "0.3.264"))
    return worker, asyncio.create_task(worker.own_client(start))


@pytest.mark.asyncio
async def test_deferred_connect_waits_for_real_codebuddy_control_response(monkeypatch):
    gate = asyncio.Event()
    client = DeferredClient([], gate)
    worker, task = start_worker(monkeypatch, client)
    try:
        await asyncio.wait_for(client.entered.wait(), 1)
        assert client.connected and not worker.ready.done()
        gate.set()
        ready = await asyncio.wait_for(asyncio.shield(worker.ready), 1)
        assert ready["models"] == [] and ready["identityConfirmed"] is False
        assert client.calls == ["initialize"]
    finally:
        gate.set()
        worker.closing.set()
        await asyncio.wait_for(task, 1)
    assert client.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("result,host,accepted", [
    ({"mcpServers": [{"name": "mona_development"}]}, True, True),
    ({"mcpServers": [{"name": "foreign"}]}, True, False),
    ({"mcpServers": [{"name": "mona_development"}]}, False, False),
    (None, False, False),
    ([], False, False),
])
async def test_status_payload_is_checked_without_silent_empty_fallback(monkeypatch, result, host, accepted):
    gate = asyncio.Event()
    gate.set()
    client = DeferredClient(result, gate)
    async def info():
        return result
    client.get_server_info = info
    worker, task = start_worker(monkeypatch, client, host=host, executor="claude")
    try:
        if accepted:
            assert (await asyncio.wait_for(asyncio.shield(worker.ready), 1))["hostCollaboration"] is True
        else:
            with pytest.raises(ValueError):
                await asyncio.wait_for(asyncio.shield(worker.ready), 1)
    finally:
        worker.closing.set()
        await asyncio.wait_for(task, 1)
    assert client.closed


@pytest.mark.asyncio
async def test_missing_claude_handshake_method_cannot_report_ready(monkeypatch):
    gate = asyncio.Event()
    gate.set()
    client = DeferredClient([], gate)
    worker, task = start_worker(monkeypatch, client, executor="claude")
    try:
        with pytest.raises(ValueError, match="sdk_contract_incompatible"):
            await asyncio.wait_for(asyncio.shield(worker.ready), 1)
    finally:
        worker.closing.set()
        await asyncio.wait_for(task, 1)
    assert client.closed and not client.calls
