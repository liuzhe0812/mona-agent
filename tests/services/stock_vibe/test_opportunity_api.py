from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager

import httpx
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime


async def test_opportunity_history_remains_readable_but_legacy_writes_are_retired(tmp_path, monkeypatch):
    calls, receipts, operation_payloads = [], {}, []

    def upstream(request):
        calls.append((request.method, request.url.path))
        if request.url.path.startswith("/mona/requests/"):
            return httpx.Response(200, json=receipts[request.url.path.rsplit("/", 1)[-1]])
        if request.method == "GET":
            if request.url.path == "/mona/opportunity-plans":
                return httpx.Response(200, json={"plans": [{"id": "multifactor"}]})
            if request.url.path == "/mona/opportunity-history":
                assert dict(request.url.params) in ({"limit": "17", "offset": "22"},
                                                    {"limit": "20", "offset": "0"})
                return httpx.Response(200, json={"items": [{"batch_id": "history_1"}], "total": 1,
                                                 "limit": int(request.url.params["limit"]),
                                                 "offset": int(request.url.params["offset"])})
            if request.url.path == "/mona/opportunity-records":
                assert dict(request.url.params) == {"limit": "8", "offset": "16"}
                return httpx.Response(200, json={"items": [{"operation_id": "c" * 32}], "total": 1,
                                                 "limit": 8, "offset": 16})
            if request.url.path == "/mona/opportunity-history/" + "b" * 32 + "/batches/history_1":
                assert dict(request.url.params) == {}
                return httpx.Response(200, json={"batch_id": "history_1", "status": "completed"})
            assert request.url.path == "/mona/opportunity-sessions/session-1"
            assert dict(request.url.params) == {"attempt_id": "attempt-1"}
            return httpx.Response(200, json={"candidates": [], "limitations": ["资料不足"]})
        payload = json.loads(request.content)
        assert request.url.path == "/mona/operations"
        operation_payloads.append(payload)
        assert payload == {"operation": "backtest", "run_id": "run_123"}
        body, status = {"operation_id": "a" * 32, "status": "queued"}, 202
        request_id = request.headers["X-Mona-Request-ID"]
        receipts[request_id] = {"request_id": request_id, "status": "completed",
                                "receipt": {"status_code": status, "body": body}}
        return httpx.Response(status, json=body)

    _resolve_tool_config_refs()
    runtime = StockVibeRuntime(runtime_root=tmp_path / "components", data_root=tmp_path / "native",
                               config_loader=lambda: Config())

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(upstream)) as native:
            yield native

    monkeypatch.setattr(runtime, "lease", lease)
    monkeypatch.setattr(runtime, "source_identity", lambda: {
        "snapshot_id": "sha256:" + "a" * 64, "patches": [],
        "instance_id": "b" * 32, "data_root_sha256": "c" * 64,
    })
    app = web.Application()
    register_stock_vibe_routes(app, runtime=runtime)
    async with TestClient(TestServer(app)) as client:
        result = await client.get("/api/stock-vibe/opportunity-plans")
        assert result.status == 200 and (await result.json())["native"]["plans"][0]["id"] == "multifactor"
        result = await client.get("/api/stock-vibe/opportunity-history?limit=17&offset=22")
        assert result.status == 200 and (await result.json())["native"]["limit"] == 17
        result = await client.get("/api/stock-vibe/opportunity-history")
        assert result.status == 200 and (await result.json())["native"]["offset"] == 0
        result = await client.get("/api/stock-vibe/opportunity-records?limit=8&offset=16")
        assert result.status == 200 and (await result.json())["native"]["items"][0]["operation_id"] == "c" * 32
        for url in (
            "/api/stock-vibe/opportunity-history?limit=0",
            "/api/stock-vibe/opportunity-history?limit=101",
            "/api/stock-vibe/opportunity-history?limit=1.5",
            "/api/stock-vibe/opportunity-history?offset=-1",
            "/api/stock-vibe/opportunity-history?offset=1000001",
            "/api/stock-vibe/opportunity-history?limit=20&limit=21",
            "/api/stock-vibe/opportunity-history?limit=20&unknown=x",
            "/api/stock-vibe/opportunity-records?offset=1&other=x",
        ):
            assert (await client.get(url)).status == 400
        result = await client.get(
            "/api/stock-vibe/opportunity-history/" + "b" * 32 + "/batches/history_1"
        )
        assert result.status == 200 and (await result.json())["native"]["status"] == "completed"
        for url in (
            "/api/stock-vibe/opportunity-history/bad.id/batches/history_1",
            "/api/stock-vibe/opportunity-history/" + "b" * 32 + "/batches/bad.id",
            "/api/stock-vibe/opportunity-history/" + "b" * 32 + "/batches/%2E%2E%2Fescape",
        ):
            assert (await client.get(url)).status in {400, 404}
        result = await client.get("/api/stock-vibe/opportunity-sessions/session-1?attempt_id=attempt-1")
        assert result.status == 200 and (await result.json())["native"]["limitations"] == ["资料不足"]
        for query in ("attempt_id=a&attempt_id=b", "attempt_id=a&path=../other"):
            assert (await client.get("/api/stock-vibe/opportunity-sessions/session-1?" + query)).status == 400
        old_context = {"plan_id": "custom", "mode": "swing", "universe": "watchlist",
                       "symbols": ["002460.SZ"], "conditions": "旧版选股历史上下文"}
        for body in (
            {"title": "旧选股会话", "opportunity": old_context},
            {"operation": "opportunity_screen", "plan_id": "multifactor", "mode": "swing"},
        ):
            response = await client.post(
                "/api/stock-vibe/sessions" if "title" in body else "/api/stock-vibe/operations",
                json=body, headers={"X-Mona-Request-ID": uuid.uuid4().hex},
            )
            assert response.status == 400, await response.text()
        assert calls.count(("POST", "/sessions")) == 0
        assert calls.count(("POST", "/mona/operations")) == 0

        backtest = {"operation": "backtest", "run_id": "run_123"}
        backtest_response = await client.post(
            "/api/stock-vibe/operations", json=backtest,
            headers={"X-Mona-Request-ID": uuid.uuid4().hex},
        )
        assert backtest_response.status == 200, await backtest_response.text()

        retired_history_operations = (
            {"operation": "opportunity_history", "plan_id": "low_volatility", "mode": "swing",
             "selection_date": "2026-03-06", "horizon": 5, "top_n": 5},
            {"operation": "opportunity_history_range", "plan_id": "low_volatility", "mode": "swing",
             "start_date": "2026-03-01", "end_date": "2026-03-06", "horizon": 5, "top_n": 5},
            {"operation": "opportunity_history_continue", "source_operation_id": "d" * 32},
        )
        native_operation_count = calls.count(("POST", "/mona/operations"))
        for retired in retired_history_operations:
            response = await client.post(
                "/api/stock-vibe/operations", json=retired,
                headers={"X-Mona-Request-ID": uuid.uuid4().hex},
            )
            assert response.status == 400, await response.text()
        assert calls.count(("POST", "/mona/operations")) == native_operation_count == 1
        assert [item["operation"] for item in operation_payloads] == ["backtest"]
