from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest
from pydantic import ValidationError

from mona.services.stock_vibe import api
from mona.services.stock_vibe.contracts import OPERATION_INPUT, CreateSession
from tests.services.stock_vibe.test_api import PREFIX, _app

VERSION = "a" * 64


@pytest.mark.asyncio
async def test_library_reads_are_authenticated_paginated_and_path_limited(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    calls = []

    def native(request):
        calls.append((request.url.path, dict(request.url.params)))
        return httpx.Response(200, json={"items": [], "total": 0, "limit": 20, "offset": 0})

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as upstream:
            yield upstream

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        for path in ("/strategy-library", "/strategy-library/history", "/strategy-library/industries", "/strategy-library/builtin:multi-factor"):
            assert (await client.get(PREFIX + path)).status == 401
        assert not calls

        response = await client.get(PREFIX + "/strategy-library?source=builtin&market=all&q=因子&limit=10&offset=20", headers=auth)
        assert response.status == 200
        assert (await response.json())["native"]["items"] == []
        assert calls[-1] == ("/mona/strategy-library", {
            "source": "builtin", "market": "all", "q": "因子", "limit": "10", "offset": "20",
        })

        response = await client.get(PREFIX + "/strategy-library/history?strategy_id=sdm:art_123&offset=10&operation=backtest", headers=auth)
        assert response.status == 200
        assert calls[-1] == ("/mona/strategy-library/history", {
            "strategy_id": "sdm:art_123", "offset": "10", "limit": "50", "operation": "backtest",
        })
        assert (await client.get(PREFIX + "/strategy-library/builtin:multi-factor", headers=auth)).status == 200
        assert calls[-1] == ("/mona/strategy-library/builtin:multi-factor", {})
        assert (await client.get(PREFIX + "/strategy-library/industries", headers=auth)).status == 200
        assert calls[-1] == ("/mona/strategy-library/industries", {})

        before = len(calls)
        for path in (
            "/strategy-library?limit=0", "/strategy-library?offset=-1", "/strategy-library?limit=1&limit=2",
            "/strategy-library?source=alpha_zoo", "/strategy-library?market=options",
            "/strategy-library?path=private", "/strategy-library/history?strategy_id=alpha_zoo:alpha101_001",
            "/strategy-library/builtin:multi-factor?file=private", "/strategy-library/alpha_zoo:alpha101_001",
            "/strategy-library/industries?url=http://127.0.0.1", "/strategy-library/industries?limit=100",
        ):
            assert (await client.get(PREFIX + path, headers=auth)).status == 400, path
        assert len(calls) == before
        assert runtime._process is None


@pytest.mark.asyncio
async def test_independent_strategy_creation_and_scan_provenance_reach_native_session(tmp_path, monkeypatch):
    client, _runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    origin = {"strategy_id": "sdm:custom1", "strategy_version": VERSION, "operation_id": "b" * 32}
    async with client:
        response = await client.post(PREFIX + "/sessions", json={
            "title": "修改选股规则", "strategy_creation": True, "native_research": origin,
        }, headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1] == ("POST", "/sessions", {"title": "修改选股规则", "config": {
            "mona_native_research": origin, "mona_strategy_creation": True,
        }})

        response = await client.post(PREFIX + "/sessions", json={"strategy_creation": True},
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1][2] == {"title": "", "config": {"mona_strategy_creation": True}}

        before = len(writes)
        for body in (
            {"strategy_creation": True, "journal_operation_id": "a" * 32},
            {"strategy_creation": True, "native_research": {"strategy_id": "builtin:multi-factor", "strategy_version": VERSION}},
            {"strategy_creation": True, "native_research": {"strategy_id": "alpha_zoo:alpha101_001"}},
            {"native_research": origin, "journal_operation_id": "a" * 32},
            {"native_research": {"strategy_id": "sdm:abc", "operation_id": "b" * 32}},
            {"native_research": {"strategy_id": "sdm:abc", "strategy_version": "bad"}},
            {"strategy_creation": "true"},
        ):
            response = await client.post(PREFIX + "/sessions", json=body,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert len(writes) == before

        builtin_origin = {"strategy_id": "builtin:multi-factor", "strategy_version": VERSION}
        response = await client.post(PREFIX + "/sessions", json={"native_research": builtin_origin},
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1][2] == {"title": "", "config": {"mona_native_research": builtin_origin}}


@pytest.mark.asyncio
async def test_industry_provider_failure_is_not_reported_as_missing_runtime_or_model(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(
            lambda _request: httpx.Response(502, json={"detail": "scope_provider_unavailable"}),
        )) as upstream:
            yield upstream

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        response = await client.get(PREFIX + "/strategy-library/industries", headers=auth)
        assert response.status == 502
        body = await response.json()
        assert body["error"] == "industry_unavailable"
        assert "重试" in body["message"] and "模型" not in body["message"]
        assert (await client.get(PREFIX + "/strategy-library", headers=auth)).status == 503


@pytest.mark.asyncio
async def test_scan_and_backtest_forward_same_version_with_explicit_settings(tmp_path, monkeypatch):
    client, _runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        for operation in ("strategy_scan", "backtest"):
            body = {"operation": operation, "strategy_id": "builtin:multi-factor", "strategy_version": VERSION,
                    "settings": {"codes": ["600519", "000333"], "source": "local", "end_date": "2026-10-20"},
                    "strategy_parameters": {"top_n": 2}}
            response = await client.post(PREFIX + "/operations", json=body,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 200
            assert writes[-1] == ("POST", "/mona/operations", {
                **body, "settings": {**body["settings"], "codes": ["600519.SH", "000333.SZ"]},
            })


@pytest.mark.parametrize("operation", ["strategy_scan", "backtest"])
def test_strategy_execution_requires_one_controlled_versioned_source(operation):
    body = {"operation": operation, "strategy_id": "sdm:art_123", "strategy_version": VERSION}
    assert OPERATION_INPUT.validate_python(body).model_dump(mode="json") == body
    for override in (
        {"strategy_version": None}, {"strategy_version": "latest"}, {"strategy_id": "alpha_zoo:alpha101_001"},
        {"strategy_id": "builtin:../private"}, {"run_id": "other"}, {"template_id": "vibe_multifactor_example"},
        {"settings": {"codes": []}}, {"settings": {"source": "http://127.0.0.1"}},
        {"strategy_parameters": {"top_n": 5}}, {"code": "private"},
    ):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({**body, **override})


def test_candidate_provenance_must_match_its_stock_context():
    with pytest.raises(ValidationError):
        CreateSession(native_research={"swarm_id": "swarm-123", "symbol": "600519.SH"})
    with pytest.raises(ValidationError):
        CreateSession(workbench={"symbol": "000333.SZ", "mode": "swing", "task": "comprehensive"},
                      native_research={"swarm_id": "swarm-123", "symbol": "600519.SH"})


@pytest.mark.asyncio
async def test_custom_strategy_delete_uses_durable_operation_contract(tmp_path, monkeypatch):
    client, _runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((request_id, method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    request_id = uuid.uuid4().hex
    body = {"operation": "strategy_delete", "strategy_id": "sdm:art_123", "strategy_version": VERSION}
    async with client:
        assert (await client.post(PREFIX + "/operations", json=body)).status == 401
        response = await client.post(PREFIX + "/operations", json=body,
                                     headers={**auth, "X-Mona-Request-ID": request_id})
        assert response.status == 200
        assert writes == [(request_id, "POST", "/mona/operations", body)]
        for override in (
            {"strategy_id": "builtin:multi-factor"}, {"strategy_id": "sdm:..private"},
            {"strategy_version": None}, {"strategy_version": "latest"},
            {"settings": {}}, {"path": "private"},
        ):
            response = await client.post(PREFIX + "/operations", json={**body, **override},
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert len(writes) == 1


@pytest.mark.asyncio
async def test_market_industry_and_watchlist_scope_reach_same_native_execution(tmp_path, monkeypatch):
    client, _runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        for operation in ("strategy_scan", "backtest"):
            for scope in ({"kind": "all_a"}, {"kind": "industry", "industry_code": "BK0475"},
                          {"kind": "watchlist", "codes": ["600519", "000333"]}):
                body = {"operation": operation, "strategy_id": "sdm:art_123", "strategy_version": VERSION,
                        "scope": scope, "settings": {"source": "eastmoney"}}
                response = await client.post(PREFIX + "/operations", json=body,
                                             headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
                assert response.status == 200
                expected_scope = {"kind": "watchlist", "codes": ["600519.SH", "000333.SZ"]} if scope["kind"] == "watchlist" else scope
                assert writes[-1] == ("POST", "/mona/operations", {**body, "scope": expected_scope})


@pytest.mark.parametrize("operation", ["strategy_scan", "backtest"])
def test_scope_rejects_sample_codes_and_unrecognized_industry(operation):
    body = {"operation": operation, "strategy_id": "sdm:art_123", "strategy_version": VERSION,
            "scope": {"kind": "all_a"}}
    assert OPERATION_INPUT.validate_python(body).model_dump(mode="json") == body
    for override in (
        {"scope": {"kind": "strategy"}}, {"scope": {"kind": "industry"}},
        {"scope": {"kind": "industry", "industry_code": "申万银行"}},
        {"scope": {"kind": "all_a", "codes": ["600519"]}},
        {"scope": {"kind": "watchlist", "codes": []}},
        {"scope": {"kind": "watchlist", "codes": ["600519", "600519.SH"]}},
        {"scope": {"kind": "watchlist", "codes": ["https://example.com"]}},
        {"scope": {"kind": "all_a", "limit": 100}}, {"settings": {"codes": ["600519"]}},
        {"settings": {"codes": None}},
    ):
        with pytest.raises(ValidationError):
            OPERATION_INPUT.validate_python({**body, **override})
