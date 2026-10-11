from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import settle, setup, trace

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId


@pytest.mark.asyncio
async def test_reconnect_auth_exact_owner_repeat_and_safe_snapshot(tmp_path, monkeypatch):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-reconnect-test")
    auth = {"X-Mona-Token": "synthetic-reconnect-test"}
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        await runtime.submit(session.id, "request_first", "instant")
        await settle(runtime)
        current = runtime.store.get_session(session.id)
        binding = runtime.store.list_bindings(session.id)[0]
        path = f"/api/development/sessions/{session.id}/reconnect"
        body = {"revision": current.revision, "bindingId": binding.id}
        assert (await client.post(path, json=body)).status == 401
        other = runtime.store.create_session(project.id, ExecutorId.CODEX)
        assert (await client.post(f"/api/development/sessions/{other.id}/reconnect", json={**body, "revision": other.revision}, headers=auth)).status == 409
        invalid = await client.post(path, json={**body, "clearHistory": True}, headers=auth)
        assert invalid.status == 400
        first = await client.post(path, json=body, headers=auth)
        assert first.status == 200
        repeated = await client.post(path, json=body, headers=auth)
        assert repeated.status == 200 and await first.json() == await repeated.json()
        snapshot = await (await client.get(f"/api/development/sessions/{session.id}/snapshot", headers=auth)).json()
        assert snapshot["nativeBinding"]["replacesBindingId"] == binding.id
        assert snapshot["nativeBinding"]["turnHistory"] is True
        assert "handoff" not in snapshot["nativeBinding"]
        assert len(snapshot["runs"]) == 1
        assert sum(r.get("method") == "turn/start" for r in trace(root)) == 1
    finally:
        await client.close()
