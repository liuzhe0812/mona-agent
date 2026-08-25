"""Contracts for independent instrument metadata and quote facts."""

from __future__ import annotations

import json

import httpx
import pytest

from mona.services.stock.failover import FailoverProvider
from mona.services.stock.provider import (
    EastMoneyProvider,
    InstrumentProfile,
    InstrumentRef,
)
from mona.services.stock.provider_tencent import TencentProvider

INST = InstrumentRef(exchange="XSHE", symbol="002407")


def _transport(routes: dict[str, bytes], calls: list[str]):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        for path, body in routes.items():
            if request.url.path == path:
                return httpx.Response(200, content=body, request=request)
        return httpx.Response(404, request=request)

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_eastmoney_profile_is_independent_and_cached(tmp_path) -> None:
    payload = {
        "jbzl": [
            {
                "SECURITY_NAME_ABBR": "多氟多",
                "ORG_NAME": "多氟多新材料股份有限公司",
                "EM2016": "基础化工-化学新材料-化学新材料",
                "ORG_PROFILE": "主营业务为氟基新材料、新能源电池及材料。",
                "BUSINESS_SCOPE": "研发、生产和销售。",
                "SECURITY_TYPE": "深交所主板A股",
            }
        ],
        "fxxg": [{"LISTING_DATE": "2010-05-18 00:00:00"}],
    }
    calls: list[str] = []
    provider = EastMoneyProvider(
        transport=_transport(
            {"/PC_HSF10/CompanySurvey/PageAjax": json.dumps(payload).encode()},
            calls,
        ),
        max_retries=0,
        profile_cache_path=tmp_path / "profiles.json",
    )

    profile = await provider.instrument_profile(INST)
    cached = await provider.instrument_profile(INST)
    disk_cached = await EastMoneyProvider(
        transport=_transport({}, []),
        max_retries=0,
        profile_cache_path=tmp_path / "profiles.json",
    ).instrument_profile(INST)

    assert isinstance(profile, InstrumentProfile)
    assert profile.industry == "化学新材料"
    assert profile.industry_path == "基础化工-化学新材料-化学新材料"
    assert profile.company_name == "多氟多新材料股份有限公司"
    assert profile.main_business == "氟基新材料、新能源电池及材料"
    assert profile.listing_date == "2010-05-18"
    assert profile.source.provider == "eastmoney"
    assert profile.observed_at == profile.source.published_at
    assert cached.cache_status == "fresh_cache"
    assert disk_cached.cache_status == "fresh_cache"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_eastmoney_quote_exposes_only_structured_upstream_fields() -> None:
    payload = {
        "data": {
            "f43": 3457,
            "f47": 1236130,
            "f48": 4315997278.03,
            "f51": 3977,
            "f52": 3254,
            "f57": "002407",
            "f58": "多氟多",
            "f59": 2,
            "f60": 3615,
            "f116": 41153253910.33,
            "f162": 4020,
            "f167": 474,
            "f168": 1144,
            "f170": -437,
        }
    }
    provider = EastMoneyProvider(
        transport=_transport(
            {"/api/qt/stock/get": json.dumps(payload).encode()}, []
        ),
        max_retries=0,
    )

    quote = await provider.quote(INST)

    assert quote.amount == pytest.approx(4315997278.03)
    assert quote.previous_close == pytest.approx(36.15)
    assert quote.turnover_rate == pytest.approx(11.44)
    assert quote.limit_up == pytest.approx(39.77)
    assert quote.limit_down == pytest.approx(32.54)
    assert quote.pe == pytest.approx(40.20)
    assert quote.pb == pytest.approx(4.74)


@pytest.mark.asyncio
async def test_eastmoney_industry_valuation_filters_rows_and_caches(tmp_path) -> None:
    rows = [
        {
            "CORRE_SECURITY_CODE": "行业平均",
            "CORRE_SECURITY_NAME": "行业平均",
            "PE_TTM": 20,
            "PB_MRQ": 2,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "行业中值",
            "CORRE_SECURITY_NAME": "行业中值",
            "PE_TTM": 18,
            "PB_MRQ": 1.8,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "002407",
            "CORRE_SECUCODE": "002407.SZ",
            "CORRE_SECURITY_NAME": "多氟多",
            "PE_TTM": 40,
            "PB_MRQ": 4.7,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "600001",
            "CORRE_SECUCODE": "600001.SH",
            "CORRE_SECURITY_NAME": "同行一",
            "PE_TTM": 10,
            "PB_MRQ": 1,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "600002",
            "CORRE_SECUCODE": "600002.SH",
            "CORRE_SECURITY_NAME": "同行二",
            "PE_TTM": 20,
            "PB_MRQ": 2,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "000003",
            "CORRE_SECUCODE": "000003.SZ",
            "CORRE_SECURITY_NAME": "同行三",
            "PE_TTM": 30,
            "PB_MRQ": 3,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "000004",
            "CORRE_SECUCODE": "000004.SZ",
            "CORRE_SECURITY_NAME": "ST同行",
            "PE_TTM": 40,
            "PB_MRQ": 4,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
        {
            "CORRE_SECURITY_CODE": "000005",
            "CORRE_SECUCODE": "000005.SZ",
            "CORRE_SECURITY_NAME": "非正值同行",
            "PE_TTM": -1,
            "PB_MRQ": 2,
            "REPORT_DATE": "2025-12-31 00:00:00",
        },
    ]
    calls: list[str] = []
    provider = EastMoneyProvider(
        transport=_transport(
            {"/PC_HSF10/IndustryAnalysis/PageAjax": json.dumps({"gzbj": rows}).encode()},
            calls,
        ),
        max_retries=0,
        profile_cache_path=tmp_path / "profiles.json",
    )

    valuation = await provider.industry_valuation(INST)
    cached = await provider.industry_valuation(INST)

    assert len(valuation.peers) == 3
    assert {peer.symbol for peer in valuation.peers} == {"600001", "600002", "000003"}
    assert valuation.target_pe_ttm == pytest.approx(40)
    assert valuation.industry_median_pb_mrq == pytest.approx(1.8)
    assert valuation.source.period_end == "2025-12-31"
    assert valuation.source.published_at == valuation.observed_at
    assert cached.cache_status == "fresh_cache"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_tencent_quote_exposes_amount_and_trading_bounds() -> None:
    fields = [""] * 88
    fields[1] = "多氟多"
    fields[3] = "34.57"
    fields[4] = "36.15"
    fields[6] = "1236130"
    fields[30] = "20260824161436"
    fields[32] = "-4.37"
    fields[33] = "40.48"  # 当日最高价，不是涨停价
    fields[34] = "39.03"  # 当日最低价，不是跌停价
    fields[37] = "431600"
    fields[38] = "11.44"
    fields[39] = "40.20"
    fields[46] = "4.74"
    fields[47] = "39.77"  # 涨停价
    fields[48] = "32.54"  # 跌停价
    body = f'v_sz002407="{"~".join(fields)}";'.encode("gbk")
    provider = TencentProvider(
        transport=_transport({"/q=sz002407": body}, []),
        max_retries=0,
    )

    quote = await provider.quote(INST)

    assert quote.amount == pytest.approx(4316000000)
    assert quote.previous_close == pytest.approx(36.15)
    assert quote.turnover_rate == pytest.approx(11.44)
    assert quote.limit_up == pytest.approx(39.77)
    assert quote.limit_down == pytest.approx(32.54)
    assert quote.limit_up != pytest.approx(40.48)
    assert quote.limit_down != pytest.approx(39.03)


@pytest.mark.asyncio
async def test_failover_tries_fallback_when_primary_returns_no_profile() -> None:
    class Empty:
        name = "empty"

        async def instrument_profile(self, _inst):
            return None

    class Fallback:
        name = "fallback"

        async def instrument_profile(self, _inst):
            return {"industry": "化学新材料"}

    result = await FailoverProvider(Empty(), Fallback()).instrument_profile(INST)

    assert result == {"industry": "化学新材料"}
