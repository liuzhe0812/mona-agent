from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from mona.services.stock.provider import InstrumentRef
from mona.services.stock.westock_provider import (
    WeStockFieldError,
    WeStockSupplementProvider,
    WeStockTimeoutError,
    WeStockUnavailableError,
    WeStockUnsupportedCommandError,
    WeStockVersionDriftError,
)

CN_TZ = timezone(timedelta(hours=8))
INST = InstrumentRef(exchange="XSHE", symbol="002407")
AS_OF = "2026-08-25T15:00:00+08:00"


def _payload(data, *, version="1.0.5", as_of=AS_OF):
    return {
        "package_version": version,
        "contract_version": "westock-contract-v2",
        "data_as_of": as_of,
        "data": data,
    }


@pytest.mark.asyncio
async def test_fixture_result_is_validated_hashed_and_cached(tmp_path):
    calls = []

    async def runner(command, symbol):
        calls.append((command, symbol))
        return _payload({"code": symbol, "roe": 12.5, "report_period": "2026-06-30"})

    provider = WeStockSupplementProvider(
        runner=runner,
        cache_root=tmp_path,
        clock=lambda: datetime(2026, 8, 25, 16, tzinfo=CN_TZ),
        validation_mode="fixture",
    )

    live = await provider.fetch("finance", INST)
    cached = await provider.fetch("asfund", INST)

    assert live.command == "asfund"
    assert live.source.content_hash == live.raw_output_hash
    assert live.cache_status == "live"
    assert cached.cache_status == "fresh_cache"
    assert calls == [("asfund", "002407")]
    assert provider.capability_matrix()["asfund"]["status"] == "fixture_only"


@pytest.mark.asyncio
async def test_uninstalled_is_zero_request_and_zero_write(tmp_path):
    provider = WeStockSupplementProvider(cache_root=tmp_path)
    with pytest.raises(WeStockUnavailableError):
        await provider.fetch("profile", INST)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_quote_is_outside_core_contract():
    provider = WeStockSupplementProvider()
    with pytest.raises(WeStockUnsupportedCommandError):
        await provider.fetch("quote", INST)


@pytest.mark.asyncio
async def test_version_drift_and_code_drift_are_rejected():
    async def wrong_version(command, symbol):
        return _payload({"code": symbol, "roe": 1}, version="9.9.9")

    with pytest.raises(WeStockVersionDriftError):
        await WeStockSupplementProvider(runner=wrong_version).fetch("asfund", INST)

    async def wrong_code(command, symbol):
        return _payload({"code": "600519", "roe": 1})

    with pytest.raises(WeStockFieldError):
        await WeStockSupplementProvider(runner=wrong_code).fetch("asfund", INST)


@pytest.mark.asyncio
async def test_timeout_and_existing_source_fallback():
    async def slow(command, symbol):
        await asyncio.sleep(0.05)
        return _payload({"code": symbol, "roe": 1})

    provider = WeStockSupplementProvider(runner=slow, timeout=0.001)
    with pytest.raises(WeStockTimeoutError):
        await provider.fetch("asfund", INST)

    async def fallback():
        return {"provider": "eastmoney", "value": 42}

    assert await provider.fetch("asfund", INST, fallback=fallback) == {
        "provider": "eastmoney",
        "value": 42,
    }
