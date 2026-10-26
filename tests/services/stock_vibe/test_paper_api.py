"""Host authentication, bounded paper contracts and non-replayed writes."""
from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager

import httpx
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config
from mona.materials.auth import get_services_token, materials_auth_middleware
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime


async def _client(tmp_path, monkeypatch, *, lose_receipt=False):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "mona"))
    monkeypatch.delenv("MONA_SERVICES_TOKEN", raising=False)
    config = Config()
    config.stock_vibe.model_preset = None
    runtime = StockVibeRuntime(runtime_root=tmp_path / "uninstalled", data_root=tmp_path / "native",
                               config_loader=lambda: config)
    source = {"data_root_sha256": "a" * 64, "instance_id": "b" * 32,
              "snapshot_id": "sha256:" + "c" * 64, "patches": []}
    calls, receipts = [], {}

    def native(request):
        calls.append(request)
        if request.url.path.startswith("/mona/requests/"):
            record = receipts.get(request.url.path.rsplit("/", 1)[1])
            return httpx.Response(200 if record else 404, json=record or {})
        assert request.url.path.startswith("/mona/paper/")
        if request.method == "GET":
            return httpx.Response(200, json={"status": "uninitialized", "path": request.url.path})
        payload = json.loads(request.content)
        request_id = request.headers["X-Mona-Request-ID"]
        body = {"trade": {"trade_id": "d" * 32, "request_id": request_id, "preview_id": payload.get("preview_id")}}
        receipts[request_id] = {"request_id": request_id, "status": "completed",
                                "receipt": {"status_code": 201, "body": body}}
        if lose_receipt:
            raise httpx.ReadError("synthetic lost response", request=request)
        return httpx.Response(201, json=body)

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as native_client:
            yield native_client

    monkeypatch.setattr(runtime, "lease", lease)
    monkeypatch.setattr(runtime, "source_identity", lambda: source)
    app = web.Application(middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(app, runtime=runtime)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, {"X-Mona-Token": get_services_token()}, calls


async def test_paper_reads_are_authenticated_and_only_forward_bounded_queries(tmp_path, monkeypatch):
    client, auth, calls = await _client(tmp_path, monkeypatch)
    async with client:
        for suffix in ("account", "trades", "preview?symbol=002460.SZ&side=buy&quantity=100"):
            assert (await client.get("/api/stock-vibe/paper/" + suffix)).status == 401
        assert calls == []
        response = await client.get("/api/stock-vibe/paper/preview", headers=auth,
                                    params={"symbol": "002460.SZ", "side": "buy", "quantity": 100})
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert dict(calls[-1].url.params) == {"symbol": "002460.SZ", "side": "buy", "quantity": "100"}
        for suffix in ("account?price=1", "preview?symbol=../private&side=buy&quantity=100",
                       "preview?symbol=002460.SZ&side=buy&quantity=1.5", "trades?limit=101",
                       "trades?limit=10&limit=20"):
            assert (await client.get("/api/stock-vibe/paper/" + suffix, headers=auth)).status == 400
        assert len(calls) == 1


async def test_paper_writes_accept_no_client_price_account_state_or_extra_paths(tmp_path, monkeypatch):
    client, auth, calls = await _client(tmp_path, monkeypatch)
    async with client:
        for path, body in (("account", {"initial_cash": 0}), ("account", {"initial_cash": True}),
                           ("trades", {"preview_id": "d" * 32, "price": 1}),
                           ("trades", {"preview_id": "../private"}),
                           ("trades", {"preview_id": "d" * 32, "research": {"session_id": "s", "attempt_id": "a", "summary": "fake"}})):
            response = await client.post("/api/stock-vibe/paper/" + path, json=body,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert calls == []
        request_id = uuid.uuid4().hex
        body = {"preview_id": "d" * 32, "note": "核对财报后记录", "research": {"session_id": "s", "attempt_id": "a"}}
        response = await client.post("/api/stock-vibe/paper/trades", json=body,
                                     headers={**auth, "X-Mona-Request-ID": request_id})
        assert response.status == 200
        assert (await response.json())["status"] == "completed"
        dispatched = next(item for item in calls if item.method == "POST")
        assert dispatched.url.path == "/mona/paper/trades"
        assert json.loads(dispatched.content) == body


async def test_lost_paper_response_is_reconciled_without_a_second_financial_dispatch(tmp_path, monkeypatch):
    client, auth, calls = await _client(tmp_path, monkeypatch, lose_receipt=True)
    async with client:
        request_id = uuid.uuid4().hex
        path = "/api/stock-vibe/paper/trades"
        payload = {"preview_id": "d" * 32}
        first = await client.post(path, json=payload, headers={**auth, "X-Mona-Request-ID": request_id})
        assert first.status == 202
        assert (await first.json())["status"] == "unknown"
        receipt = await client.get("/api/stock-vibe/requests/" + request_id, headers=auth)
        assert (await receipt.json())["status"] == "completed"
        repeated = await client.post(path, json=payload, headers={**auth, "X-Mona-Request-ID": request_id})
        assert (await repeated.json())["status"] == "completed"
        assert sum(item.method == "POST" for item in calls) == 1
