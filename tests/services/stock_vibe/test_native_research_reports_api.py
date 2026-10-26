from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest

from mona.services.stock_vibe import api
from tests.services.stock_vibe.test_api import PREFIX, _app


@pytest.mark.asyncio
async def test_native_team_and_report_reads_are_authenticated_and_allowlisted(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    responses = {
        "/mona/native-research/catalog": {"teams": [], "strategies": {"items": []}},
        "/mona/native-research/swarm-123": {"id": "swarm-123", "tasks": [], "linked_runs": []},
        "/mona/native-research/strategies/alpha_zoo:alpha101_001": {"strategy_id": "alpha_zoo:alpha101_001"},
        "/mona/native-research/swarm-123/evidence/" + "a" * 64: {"verified": True, "observed_symbols": ["600000.SH"]},
        "/mona/alpha-defaults": {"zoos": {"alpha101": 101}, "tools": []},
        "/alpha/list": {"status": "ok", "alphas": [], "total": 0},
        "/alpha/readiness": {"universes": {}},
        "/alpha/alpha101_001": {"id": "alpha101_001", "formula": "native"},
        "/runs": [{"run_id": "run_20261020_120000"}],
        "/runs/run_20261020_120000": {"run_id": "run_20261020_120000"},
        "/runs/run_20261020_120000/attribution": {"exists": True},
        "/runs/run_20261020_120000/factor": {"exists": True},
        "/runs/run_20261020_120000/positions/sectors": {"items": []},
    }
    calls = []

    def native(request):
        calls.append((request.url.path, dict(request.url.params)))
        return httpx.Response(200, json=responses[request.url.path])

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as upstream:
            yield upstream

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        assert (await client.get(f"{PREFIX}/native-research/catalog")).status == 401
        assert calls == []

        read_urls = [
            f"{PREFIX}/native-research/catalog?limit=12&offset=24&source=sdm",
            f"{PREFIX}/native-research/swarm-123",
            f"{PREFIX}/native-research/strategies/alpha_zoo:alpha101_001",
            f"{PREFIX}/native-research/swarm-123/evidence/" + "a" * 64,
            f"{PREFIX}/alpha/defaults",
            f"{PREFIX}/alpha/list?zoo=alpha101&universe=csi300&limit=25",
            f"{PREFIX}/alpha/readiness",
            f"{PREFIX}/alpha/alpha101_001",
            f"{PREFIX}/reports/runs?limit=50",
            f"{PREFIX}/reports/runs/run_20261020_120000?chart_symbol=600000.SH&chart_payload=summary",
            f"{PREFIX}/reports/runs/run_20261020_120000/attribution",
            f"{PREFIX}/reports/runs/run_20261020_120000/factor",
            f"{PREFIX}/reports/runs/run_20261020_120000/positions/sectors?refresh=1",
        ]
        for url in read_urls:
            response = await client.get(url, headers=auth)
            assert response.status == 200, f"{url}: {await response.text()} calls={calls}"
            assert "native" in await response.json()

        expected = [
            ("/mona/native-research/catalog", {"limit": "12", "offset": "24", "source": "sdm"}),
            ("/mona/native-research/swarm-123", {}),
            ("/mona/native-research/strategies/alpha_zoo:alpha101_001", {}),
            ("/mona/native-research/swarm-123/evidence/" + "a" * 64, {}),
            ("/mona/alpha-defaults", {}),
            ("/alpha/list", {"zoo": "alpha101", "universe": "csi300", "limit": "25"}),
            ("/alpha/readiness", {}),
            ("/alpha/alpha101_001", {}),
            ("/runs", {"limit": "50"}),
            ("/runs/run_20261020_120000", {"chart_symbol": "600000.SH", "chart_payload": "summary"}),
            ("/runs/run_20261020_120000/attribution", {}),
            ("/runs/run_20261020_120000/factor", {}),
            ("/runs/run_20261020_120000/positions/sectors", {"refresh": "1"}),
        ]
        assert calls == expected
        for url in (
            f"{PREFIX}/native-research/catalog?limit=10&limit=11",
            f"{PREFIX}/native-research/catalog?path=../outside",
            f"{PREFIX}/native-research/strategies/alpha101_001",
            f"{PREFIX}/native-research/swarm-123/evidence/bad-id",
            f"{PREFIX}/alpha/list?theme=unknown",
            f"{PREFIX}/alpha/not-a-factor",
            f"{PREFIX}/reports/runs/run_20261020_120000?chart_payload=full",
            f"{PREFIX}/reports/runs/run_20261020_120000?path=../outside",
            f"{PREFIX}/reports/runs/run_20261020_120000/positions/sectors?refresh=2",
        ):
            assert (await client.get(url, headers=auth)).status == 400
        assert len(calls) == len(expected)


@pytest.mark.asyncio
async def test_native_research_presets_and_alpha_operations_keep_exact_native_contracts(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((request_id, method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        inputs = [
            {"preset_name": "quant_strategy_desk", "user_vars": {"market": "A-shares", "goal": "value and momentum"}},
            {"preset_name": "factor_research_committee", "user_vars": {"market": "A-shares", "factor_type": "quality"}},
            {"preset_name": "ml_quant_lab", "user_vars": {"market": "A-shares", "target_variable": "return", "goal": "monthly stock selection"}},
            {"preset_name": "fundamental_research_team", "user_vars": {"target": "600519.SH", "market": "A-shares"}},
            {"preset_name": "sector_rotation_team", "user_vars": {"market": "A-shares", "goal": "high dividends"}},
            {"preset_name": "event_driven_task_force", "user_vars": {"market": "A-shares"}},
            {"preset_name": "equity_research_team", "user_vars": {"market": "A-shares", "goal": "Q2 outlook"}},
            {"preset_name": "investment_committee", "user_vars": {"target": "600519.SH", "market": "A-shares"}},
            {"preset_name": "mona_ashare_research", "user_vars": {
                "symbol": "600519.SH", "start_date": "2026-10-01", "end_date": "2026-10-10",
                "question": "核对已提供的区间证据",
            }},
        ]
        for body in inputs:
            response = await client.post(f"{PREFIX}/swarm/runs", json=body,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 200, await response.text()
            assert writes[-1][2] == "/swarm/runs"
            assert writes[-1][3] == body

        for invalid in (
            {"preset_name": "unknown", "user_vars": {"market": "A-shares", "goal": "x"}},
            {"preset_name": "quant_strategy_desk", "user_vars": {"market": "A-shares", "goal": "x", "code": "extra"}},
            {"preset_name": "quant_strategy_desk", "user_vars": {"market": "A-shares", "goal": "https://example.test"}},
            {"preset_name": "quant_strategy_desk", "user_vars": {"market": "A-shares", "goal": "api_key=secret"}},
            {"preset_name": "event_driven_task_force", "user_vars": {"market": "A-shares", "event_type": ""}},
            {"preset_name": "mona_ashare_research", "user_vars": {
                "symbol": "../outside", "start_date": "2026-10-01", "end_date": "2026-10-10",
            }},
        ):
            response = await client.post(f"{PREFIX}/swarm/runs", json=invalid,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert len(writes) == len(inputs)

        alpha_bench = {
            "operation": "alpha_bench", "zoo": "alpha101", "universe": "csi300", "period": "2020-2024",
            "alpha_id": "alpha101_001", "top": 10,
        }
        response = await client.post(f"{PREFIX}/operations", json=alpha_bench,
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1][3] == alpha_bench
        default_bench = {key: value for key, value in alpha_bench.items() if key not in {"alpha_id", "top"}}
        response = await client.post(f"{PREFIX}/operations", json=default_bench,
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1][3] == {**default_bench, "top": 20}
        alpha_compare = {
            "operation": "alpha_compare", "alpha_ids": ["alpha101_001", "gtja191_2"],
            "universe": "sp500", "period": "2020-2024",
        }
        response = await client.post(f"{PREFIX}/operations", json=alpha_compare,
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 200
        assert writes[-1][3] == {**alpha_compare, "sort": "ir"}
        before = len(writes)
        for invalid in (
            {**alpha_bench, "output_dir": "../outside"},
            {**alpha_bench, "top": True},
            {key: value for key, value in alpha_bench.items() if key != "zoo"},
            {**alpha_bench, "zoo": "unknown"},
            {**alpha_compare, "alpha_ids": ["alpha101_001", "alpha101_001"]},
            {**alpha_compare, "alpha_ids": ["unsafe/path", "gtja191_2"]},
            {**alpha_compare, "sort": "bad"},
        ):
            response = await client.post(f"{PREFIX}/operations", json=invalid,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert len(writes) == before
        assert runtime._process is None


@pytest.mark.asyncio
async def test_native_research_provenance_preserves_stock_context_and_strategy_sources(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((request_id, method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        valid = await client.post(f"{PREFIX}/sessions", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json={
            "title": "查看量化研究中的股票",
            "workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
            "native_research": {"swarm_id": "swarm-123", "task_id": "task-screen", "symbol": "600519.SH"},
        })
        assert valid.status == 200
        assert writes[-1][3] == {
            "title": "查看量化研究中的股票",
            "config": {
                "mona_workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
                "mona_native_research": {"swarm_id": "swarm-123", "task_id": "task-screen", "symbol": "600519.SH"},
            },
        }

        strategy = await client.post(f"{PREFIX}/sessions", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json={
            "workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
            "native_research": {"strategy_id": "alpha_zoo:alpha101_001"},
        })
        assert strategy.status == 200
        assert writes[-1][3]["config"]["mona_native_research"] == {"strategy_id": "alpha_zoo:alpha101_001"}

        invalid_bodies = (
            {"native_research": {"swarm_id": "swarm-123", "symbol": "600519.SH"}},
            {"workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
             "opportunity": {"plan_id": "multifactor", "mode": "swing"},
             "native_research": {"swarm_id": "swarm-123"}},
            {"workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
             "native_research": {"strategy_id": "alpha101_001", "symbol": "600519.SH"}},
            {"workbench": {"symbol": "600519.SH", "task": "comprehensive", "mode": "swing"},
             "native_research": {"swarm_id": "../outside"}},
        )
        before = len(writes)
        for body in invalid_bodies:
            response = await client.post(f"{PREFIX}/sessions", json=body,
                                         headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        assert len(writes) == before
        assert runtime._process is None
