import asyncio
import os
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import setup as setup_workbench
from test_native_workbench import trace

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId
from mona.development.executors.rpc import JsonRpcProcess, RemoteRpcError, RpcError

PEER = Path(__file__).with_name("native_peer.py").resolve()


async def spawn(tmp_path, *, handler=None, frame_limit=2097152):
    events, failures = [], []

    async def reject(*_):
        raise RemoteRpcError(-32601)

    client = await JsonRpcProcess.spawn(
        (sys.executable, "-u", str(PEER)), cwd=tmp_path, env=dict(os.environ),
        notification=lambda method, params: events.append((method, params)),
        server_request=handler or reject, disconnected=failures.append,
        max_frame_bytes=frame_limit, request_timeout=1,
    )
    return client, events, failures


@pytest.mark.asyncio
async def test_real_pipes_unicode_early_events_and_stderr(tmp_path):
    client, events, _ = await spawn(tmp_path)
    try:
        assert await client.request("echo", {"text": "中文 \n 路径"}) == {"text": "中文 \n 路径"}
        assert events == [("peer/ready", {"text": "早到的启动事件"})]
        await client.request("stderr")
        for _ in range(100):
            if client.stderr_bytes >= 150000:
                break
            await asyncio.sleep(0.01)
        assert client.stderr_bytes == 150000
    finally:
        await client.close()
    assert client.process.returncode is not None


@pytest.mark.asyncio
async def test_requests_correlate_out_of_order_not_by_arrival(tmp_path):
    client, _, _ = await spawn(tmp_path)
    try:
        first, second = await asyncio.gather(client.request("reverse", {"order": 1}), client.request("reverse", {"order": 2}))
        assert first == {"order": 1}
        assert second == {"order": 2}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_timeout_after_send_is_unknown_and_late_response_not_retried(tmp_path):
    client, _, _ = await spawn(tmp_path)
    try:
        await client.request("echo")
        with pytest.raises(RpcError) as error:
            await client.request("delay", {"once": True}, timeout=0.02)
        assert error.value.outcome_unknown
        await asyncio.sleep(0.2)
        assert await client.request("echo", {"still": "usable"}) == {"still": "usable"}
        assert (tmp_path / "peer-trace.jsonl").read_text().count('"method": "delay"') == 1
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_approval_wait_does_not_block_unrelated_rpc(tmp_path):
    pending = asyncio.Event()
    started = asyncio.Event()

    async def handler(identifier, method, params):
        assert identifier == 42
        assert method == "client/confirm"
        started.set()
        await pending.wait()
        return {"decision": "decline"}

    client, _, _ = await spawn(tmp_path, handler=handler)
    try:
        await client.request("approval")
        await asyncio.wait_for(started.wait(), 1)
        assert await client.request("echo", {"parallel": True}) == {"parallel": True}
    finally:
        pending.set()
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["malformed", "large"])
async def test_malformed_frames_fail_closed_and_wake_pending(tmp_path, method):
    client, _, failures = await spawn(tmp_path)
    try:
        with pytest.raises(RpcError):
            await client.request(method)
        assert client.closed
        assert failures == ["native_protocol_error"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_remote_errors_do_not_expose_native_diagnostics(tmp_path):
    client, _, _ = await spawn(tmp_path)
    try:
        with pytest.raises(RemoteRpcError) as error:
            await client.request("error")
        assert error.value.rpc_code == -32000
        assert error.value.rpc_method == "error"
        assert "private" not in f"{error.value!s} {vars(error.value)!r}"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_frame_size_checked_before_dispatch_and_close_idempotent(tmp_path):
    client, _, _ = await spawn(tmp_path, frame_limit=1024)
    with pytest.raises(RpcError) as error:
        await client.request("echo", {"large": "界" * 1024})
    assert not error.value.outcome_unknown
    await asyncio.gather(client.close(), client.close())
    assert client.process.returncode is not None


@pytest.mark.asyncio
async def test_cancelled_pending_request_never_replays(tmp_path):
    client, _, _ = await spawn(tmp_path)
    try:
        await client.request("echo")
        task = asyncio.create_task(client.request("delay"))
        await asyncio.sleep(0.03)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.2)
        assert await client.request("echo", {"after": True}) == {"after": True}
        assert not client._pending
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_provider_codex_logout_disconnects_chatgpt_over_authenticated_http(tmp_path, monkeypatch):
    runtime, project, root, host = await setup_workbench(tmp_path)
    runtime.native.hosts[("", ExecutorId.CODEX)] = host
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-logout-test")
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    base = "/api/development/provider-executors/codex"
    headers = {"X-Mona-Token": "synthetic-logout-test"}
    try:
        assert (await client.post(base + "/logout")).status == 401
        assert host._client is None

        login = await (await client.post(base + "/login", headers=headers)).json()
        assert login["state"] == "waiting"
        await host._client.request("test/auth/complete", {"loginId": "auth-1", "success": True})
        connected = await (await client.post(base + "/probe", headers=headers)).json()
        assert connected["authentication"] == "ready"
        assert connected["authMode"] == "chatgpt"

        response = await client.post(base + "/logout", headers=headers)
        assert response.status == 200 and await response.json() == {"ok": True}
        logout = next(call for call in trace(root) if call.get("method") == "account/logout")
        assert "params" not in logout

        status = await (await client.get(base + "/login", headers=headers)).json()
        assert status["state"] == "idle"
        disconnected = await (await client.post(base + "/probe", headers=headers)).json()
        assert disconnected["authentication"] == "required"
        assert disconnected["authMode"] == "unknown"
        methods = [call.get("method") for call in trace(root)]
        assert "thread/start" not in methods and "turn/start" not in methods
        assert not runtime.tasks and runtime.store.list_sessions(project.id) == []
    finally:
        await client.close()
