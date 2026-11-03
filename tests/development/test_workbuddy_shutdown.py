"""SDK cleanup acknowledgement must precede replacing its worker process."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_sdk_workbench import _event_host

from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_worker import Worker


async def test_shutdown_waits_for_native_cleanup_before_closing_transport(tmp_path):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    order = []
    async def request(method, params=None, **kwargs):
        assert method == "close" and params == {"force": True}
        order.append("request")
        await asyncio.sleep(0.01)
        order.append("native-reaped")
        return {"closed": True}
    async def close():
        order.append("transport-closed")
    runtime.connection = SimpleNamespace(closed=False, request=request, close=close)
    await host.shutdown()
    assert order == ["request", "native-reaped", "transport-closed"]
    assert runtime.closed


@pytest.mark.parametrize("reply", [{"closed": False}, None])
async def test_unknown_native_cleanup_is_not_hidden_by_pipe_exit(tmp_path, reply):
    host, _, runtime = _event_host(tmp_path, work_mode=True)
    runtime.connection = SimpleNamespace(closed=False, request=AsyncMock(return_value=reply), close=AsyncMock())
    with pytest.raises(RpcError) as error:
        await host.shutdown()
    assert error.value.code == "native_exit_unconfirmed"
    runtime.connection.close.assert_awaited_once()


@pytest.mark.parametrize("status", ["running", "unknown", "starting", "waiting_user"])
async def test_lost_pipe_cannot_confirm_native_cleanup(tmp_path, status):
    host, _, runtime = _event_host(tmp_path, work_mode=True)
    runtime.status = status
    runtime.connection = SimpleNamespace(closed=True, request=AsyncMock(), close=AsyncMock())
    with pytest.raises(RpcError) as error:
        await host.shutdown()
    assert error.value.code == "native_exit_unconfirmed" and error.value.outcome_unknown
    runtime.connection.request.assert_not_awaited()
    runtime.connection.close.assert_awaited_once()


@pytest.mark.parametrize("status", ["idle", "not_loaded"])
async def test_closed_pipe_after_confirmed_turn_can_be_reaped(tmp_path, status):
    host, _, runtime = _event_host(tmp_path, work_mode=True)
    runtime.status = status
    runtime.connection = SimpleNamespace(closed=True, request=AsyncMock(), close=AsyncMock())
    await host.shutdown()
    assert runtime.closed
    runtime.connection.close.assert_awaited_once()


async def test_worker_disconnect_failure_cannot_acknowledge_closed(monkeypatch):
    worker = Worker()
    worker.start = {"executor": "codebuddy", "nativeSessionId": "native", "permissionMode": "ask"}
    worker.projector = SimpleNamespace(work_tool=True, host_collaboration=False, design_resources=False)
    worker.permission_modes = ["ask"]
    worker.ready = asyncio.get_running_loop().create_future()
    async def messages():
        await asyncio.Event().wait()
        yield {}
    client = SimpleNamespace(receive_messages=messages,
                             disconnect=AsyncMock(side_effect=RuntimeError("PRIVATE_SDK_DETAIL")))
    monkeypatch.setattr(worker, "build_options", lambda _: (client, "fixture"))
    monkeypatch.setattr(worker, "connect_client", AsyncMock(return_value={"models": []}))
    worker.owner = asyncio.create_task(worker.own_client(worker.start))
    await asyncio.wait_for(asyncio.shield(worker.ready), 1)
    try:
        with pytest.raises(RpcError) as error:
            await asyncio.wait_for(worker.handle("close", {"force": True}), 1)
        assert error.value.code == "native_exit_unconfirmed"
        assert "PRIVATE_SDK_DETAIL" not in str(error.value)
    finally:
        worker.closing.set()
        await worker.owner
