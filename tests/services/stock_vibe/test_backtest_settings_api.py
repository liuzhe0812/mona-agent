from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager

import httpx
import pytest

from mona.services.stock_vibe import api
from tests.services.stock_vibe.test_api import PREFIX, _app


@pytest.mark.asyncio
async def test_native_backtest_settings_reads_are_authenticated_and_forwarded(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    calls = []
    native_values = {
        "/mona/backtest-settings/defaults": {
            "initial_cash": 1_000_000,
            "optimizer_parameters": {
                "equal_volatility": {"lookback": 60},
                "risk_parity": {"lookback": 60},
                "mean_variance": {"lookback": 60, "risk_free": 0},
                "max_diversification": {"lookback": 60},
                "turnover_aware": {
                    "lookback": 60, "risk_aversion": 1, "turnover_penalty": 0,
                    "max_per_name": None, "groups": None, "max_per_group": None,
                },
            },
            "validation_parameters": {
                "monte_carlo": {"n_simulations": 1000, "seed": 42},
                "bootstrap": {"n_bootstrap": 1000, "confidence": 0.95, "seed": 42},
                "walk_forward": {"n_windows": 5},
            },
        },
        "/mona/backtest-settings/inputs": {"sources": ["auto", "local", "tushare"]},
    }

    def native(request):
        calls.append(request)
        return httpx.Response(200, json=native_values[request.url.path])

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as upstream:
            yield upstream

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        for endpoint in ("defaults", "inputs"):
            assert (await client.get(f"{PREFIX}/backtest-settings/{endpoint}")).status == 401
        assert calls == []

        for endpoint, path in (
            ("defaults", "/mona/backtest-settings/defaults"),
            ("inputs", "/mona/backtest-settings/inputs"),
        ):
            response = await client.get(f"{PREFIX}/backtest-settings/{endpoint}", headers=auth)
            assert response.status == 200
            assert (await response.json()) == {"native": native_values[path], "source": None}
        assert [request.url.path for request in calls] == list(native_values)
        assert runtime._process is None


@pytest.mark.asyncio
async def test_backtest_settings_validate_and_forward_without_host_defaults(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(_request, request_id, method, path, payload, **_kwargs):
        writes.append((request_id, method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        request_id = uuid.uuid4().hex
        legacy = await client.post(f"{PREFIX}/operations", headers={**auth, "X-Mona-Request-ID": request_id},
                                   json={"operation": "backtest", "run_id": "run_123"})
        assert legacy.status == 200
        assert writes[-1] == (request_id, "POST", "/mona/operations", {
            "operation": "backtest", "run_id": "run_123",
        })

        request_id = uuid.uuid4().hex
        response = await client.post(f"{PREFIX}/operations", headers={**auth, "X-Mona-Request-ID": request_id}, json={
            "operation": "backtest",
            "template_id": "vibe_multifactor_example",
            "settings": {
                "codes": ["600000", "000001", "430001.BJ"],
                "start_date": "2025-01-01",
                "end_date": "2025-12-31",
                "source": "auto",
                "commission_rate": 0.11,
                "commission_min": 1001,
                "position_adjustment": "rebalance",
                "rebalance_mask": "W-FRI",
                "optimizer": "turnover_aware",
                "optimizer_params": {
                    "lookback": 60, "risk_aversion": 1, "turnover_penalty": 0.2,
                    "max_per_name": 0.5, "groups": {"600000": "bank", "000001.SZ": "bank"},
                    "max_per_group": {"bank": 0.7},
                },
                "validation": {"monte_carlo": {"n_simulations": 1000, "seed": 42},
                               "bootstrap": {"n_bootstrap": 1000, "confidence": 0.95, "seed": 42},
                               "walk_forward": {"n_windows": 5}},
            },
            "strategy_parameters": {
                "momentum_window": 20, "vol_window": 20, "top_n": 3, "rebalance_freq": 5,
            },
        })
        assert response.status == 200
        assert writes[-1][3] == {
            "operation": "backtest",
            "template_id": "vibe_multifactor_example",
            "settings": {
                "codes": ["600000.SH", "000001.SZ", "430001.BJ"],
                "start_date": "2025-01-01",
                "end_date": "2025-12-31",
                "source": "auto",
                "commission_rate": 0.11,
                "commission_min": 1001.0,
                "position_adjustment": "rebalance",
                "rebalance_mask": "W-FRI",
                "optimizer": "turnover_aware",
                "optimizer_params": {
                    "lookback": 60, "risk_aversion": 1.0, "turnover_penalty": 0.2,
                    "max_per_name": 0.5,
                    "groups": {"600000.SH": "bank", "000001.SZ": "bank"},
                    "max_per_group": {"bank": 0.7},
                },
                "validation": {"monte_carlo": {"n_simulations": 1000, "seed": 42},
                               "bootstrap": {"n_bootstrap": 1000, "confidence": 0.95, "seed": 42},
                               "walk_forward": {"n_windows": 5}},
            },
            "strategy_parameters": {
                "momentum_window": 20, "vol_window": 20, "top_n": 3, "rebalance_freq": 5,
            },
        }

        request_id = uuid.uuid4().hex
        empty_settings = await client.post(f"{PREFIX}/operations", headers={**auth, "X-Mona-Request-ID": request_id},
                                           json={"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {}})
        assert empty_settings.status == 200
        assert writes[-1][3] == {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {}}

        request_id = uuid.uuid4().hex
        partial = await client.post(f"{PREFIX}/operations", headers={**auth, "X-Mona-Request-ID": request_id}, json={
            "operation": "backtest", "template_id": "vibe_multifactor_example",
            "settings": {"initial_cash": 250000, "benchmark": None},
            "strategy_parameters": {"momentum_window": 30},
        })
        assert partial.status == 200
        assert writes[-1][3] == {
            "operation": "backtest", "template_id": "vibe_multifactor_example",
            "settings": {"initial_cash": 250000.0, "benchmark": None},
            "strategy_parameters": {"momentum_window": 30},
        }


@pytest.mark.asyncio
async def test_backtest_rejects_untrusted_or_invalid_settings_before_dispatch(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    writes = []

    async def submit(*args, **kwargs):
        writes.append((args, kwargs))
        return {"request_id": args[1], "status": "completed"}

    monkeypatch.setattr(api, "_submit", submit)
    invalid_bodies = [
        {"operation": "backtest", "template_id": "../outside"},
        {"operation": "backtest", "run_id": "run_123", "template_id": "vibe_multifactor_example"},
        {"operation": "backtest", "run_id": "run_123", "strategy_parameters": {"top_n": 3}},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {"path": "../outside"}},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "strategy_parameters": {"script_path": "../outside"}},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {"codes": ["../outside"]}},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {"start_date": "2026-2-01"}},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "start_date": "2026-02-02", "end_date": "2026-02-01",
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "position_adjustment": "hold", "rebalance_mask": ["2026-01-01"],
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "optimizer_params": {"risk_aversion": float("nan")},
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "validation": {"monte_carlo": {"seed": -1}},
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "optimizer_params": {"groups": {"../unsafe": "bank"}},
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "optimizer_params": {"groups": {"600000": "bank"}, "max_per_group": {"finance": 0.5}},
        }},
        {"operation": "backtest", "template_id": "vibe_multifactor_example", "settings": {
            "validation": {"monte_carlo": {"unexpected": 1}},
        }},
    ]
    async with client:
        for payload in invalid_bodies:
            response = await client.post(f"{PREFIX}/operations", headers={
                **auth, "X-Mona-Request-ID": uuid.uuid4().hex,
            }, data=json.dumps(payload, allow_nan=True))
            assert response.status == 400
        assert writes == []
        assert runtime._process is None
