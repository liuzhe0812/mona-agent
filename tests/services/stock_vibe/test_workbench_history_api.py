from contextlib import asynccontextmanager

import httpx
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime

SYMBOL = "002460.SZ"
PREFIX = "/api/stock-vibe/workbench/history"
ROW = {"session_id": "session-original", "attempt_id": "attempt-original", "title": "已有风险研究",
       "task": "risk", "mode": "swing", "status": "completed", "created_at": "2026-10-16T08:00:00Z",
       "completed_at": "2026-10-16T08:10:00Z"}


async def client_for(tmp_path, monkeypatch, handler):
    _resolve_tool_config_refs()
    runtime = StockVibeRuntime(runtime_root=tmp_path / "components", data_root=tmp_path / "native",
                               config_loader=lambda: Config())

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(handler)) as native:
            yield native

    monkeypatch.setattr(runtime, "lease", lease)
    app = web.Application()
    register_stock_vibe_routes(app, runtime=runtime)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


async def test_history_filters_and_pagination_are_native_read_only(tmp_path, monkeypatch):
    calls = []

    def native(request):
        calls.append(request)
        assert request.method == "GET" and request.url.path == "/mona/workbench-history"
        assert dict(request.url.params) == {"symbol": SYMBOL, "q": "风险", "task": "risk", "state": "completed", "offset": "100", "limit": "10"}
        return httpx.Response(200, json={"symbol": SYMBOL, "offset": 100, "limit": 10, "total": 101, "items": [ROW]})

    client = await client_for(tmp_path, monkeypatch, native)
    async with client:
        response = await client.get(PREFIX, params={"symbol": SYMBOL, "q": "风险", "task": "risk", "state": "completed", "offset": 100, "limit": 10})
        assert response.status == 200
        assert (await response.json())["native"]["items"] == [ROW]
        assert response.headers["Cache-Control"] == "no-store"
        assert len(calls) == 1


async def test_history_rejects_invalid_queries_before_dispatch(tmp_path, monkeypatch):
    calls = []

    def native(request):
        calls.append(request)
        return httpx.Response(500)

    client = await client_for(tmp_path, monkeypatch, native)
    async with client:
        for query in ("symbol=002460.SZ&offset=-1", "symbol=002460.SZ&limit=51", "symbol=002460.SZ&task=other",
                      "symbol=002460.SZ&state=running", "symbol=../../other", "symbol=002460.SZ&unknown=1",
                      "symbol=002460.SZ&symbol=600000.SH", "symbol=002460.SZ&q=" + "x" * 121):
            response = await client.get(PREFIX + "?" + query)
            assert response.status == 400, query
        assert calls == []


async def test_history_masks_invalid_native_records(tmp_path, monkeypatch):
    payload = {"symbol": SYMBOL, "offset": 0, "limit": 10, "total": 1, "items": [ROW]}

    def native(_request):
        return httpx.Response(200, json=payload)

    client = await client_for(tmp_path, monkeypatch, native)
    async with client:
        for invalid in ({**payload, "symbol": "600000.SH"}, {**payload, "offset": 10},
                        {**payload, "items": [{**ROW, "session_id": "../../private-detail"}]},
                        {**payload, "items": [{**ROW, "attempt_id": None}]}, {**payload, "total": True}):
            payload = invalid
            response = await client.get(PREFIX, params={"symbol": SYMBOL})
            assert response.status == 502
            result = await response.json()
            assert result["error"] == "analysis_history_unavailable"
            assert "private-detail" not in str(result)
