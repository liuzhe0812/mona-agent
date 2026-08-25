"""Tencent adapter tests: batch quote parsing, kline shapes, failure isolation.

All outbound HTTP is mocked via ``httpx.MockTransport``; ``validate_url_target``
is monkeypatched in ``mona.services.stock.provider`` (home of ``secure_fetch``)
so no DNS resolution happens in tests.
"""

import json

import httpx
import pytest

import mona.services.stock.provider as provider_mod
from mona.services.stock.provider import (
    HostNotAllowedError,
    InstrumentRef,
    ProviderError,
    Quote,
)
from mona.services.stock.provider_tencent import TencentProvider, tx_code

MT = InstrumentRef(exchange="XSHG", symbol="600519", instrument_type="equity")
PA = InstrumentRef(exchange="XSHE", symbol="000001", instrument_type="equity")
SH_INDEX = InstrumentRef(exchange="XSHG", symbol="000001", instrument_type="index")


@pytest.fixture(autouse=True)
def _no_ssrf(monkeypatch):
    monkeypatch.setattr(provider_mod, "validate_url_target", lambda url: (True, ""))


def make_provider(handler, **kwargs) -> TencentProvider:
    return TencentProvider(transport=httpx.MockTransport(handler), **kwargs)


def _quote_payload(*, name: str, code: str, price: str, volume: str, when: str, pct: str) -> str:
    fields = ["0"] * 49
    fields[0] = "1"
    fields[1] = name
    fields[2] = code
    fields[3] = price
    fields[4] = "1690.00"
    fields[6] = volume
    fields[33] = "40.48"  # daily high; must not be read as the upper limit
    fields[34] = "39.03"  # daily low; must not be read as the lower limit
    fields[37] = "172900.0"  # amount in ten-thousand CNY
    fields[38] = "1.23"  # turnover rate in percent
    fields[30] = when
    fields[32] = pct
    fields[39] = "20.60"
    fields[45] = "16775.97"
    fields[46] = "6.68"
    fields[47] = "39.77"
    fields[48] = "32.54"
    return "~".join(fields)


def _quote_body(*lines: str) -> bytes:
    return "".join(lines).encode("gbk")


def test_tx_code_mapping():
    assert tx_code(MT) == "sh600519"
    assert tx_code(PA) == "sz000001"
    assert tx_code(InstrumentRef(exchange="BJSE", symbol="920001")) == "bj920001"


# --- quotes ---


async def test_quotes_batch_single_request_parses_all():
    seen_urls = []

    def handler(request):
        seen_urls.append(str(request.url))
        return httpx.Response(
            200,
            content=_quote_body(
                'v_sh600519="'
                + _quote_payload(
                    name="贵州茅台",
                    code="600519",
                    price="1700.50",
                    volume="21076",
                    when="20260814150000",
                    pct="-1.22",
                )
                + '";\n',
                'v_sz000001="'
                + _quote_payload(
                    name="平安银行",
                    code="000001",
                    price="10.20",
                    volume="123456",
                    when="20260814150000",
                    pct="0.49",
                )
                + '";\n',
            ),
        )

    provider = make_provider(handler)
    results = await provider.quotes([MT, PA])
    assert len(seen_urls) == 1
    assert "q=sh600519,sz000001" in seen_urls[0]
    mt = results["XSHG:600519"]
    assert isinstance(mt, Quote)
    assert mt.name == "贵州茅台"
    assert mt.price == 1700.50
    assert mt.change_pct == -1.22
    assert mt.volume == 21076.0
    assert mt.amount == 1_729_000_000
    assert mt.previous_close == 1690.00
    assert mt.turnover_rate == 1.23
    assert mt.limit_up == 39.77
    assert mt.limit_down == 32.54
    assert mt.limit_up != 40.48  # [33] is the daily high, not the upper limit
    assert mt.limit_down != 39.03  # [34] is the daily low, not the lower limit
    assert mt.pe == 20.60
    assert mt.pb == 6.68
    assert mt.market_cap == 1677597000000
    assert mt.as_of == "2026-08-14T15:00:00+08:00"
    assert mt.source.provider == "tencent"
    pa = results["XSHE:000001"]
    assert isinstance(pa, Quote)
    assert pa.change_pct == 0.49


async def test_quotes_unknown_code_isolated_as_error():
    def handler(request):
        return httpx.Response(
            200,
            content=_quote_body(
                'v_sh600519="'
                + _quote_payload(
                    name="贵州茅台",
                    code="600519",
                    price="1700.50",
                    volume="21076",
                    when="20260814150000",
                    pct="-1.22",
                )
                + '";\n',
                'v_pv_none_match="1";\n',
            ),
        )

    provider = make_provider(handler)
    results = await provider.quotes([MT, PA])
    assert isinstance(results["XSHG:600519"], Quote)
    assert isinstance(results["XSHE:000001"], ProviderError)


async def test_quotes_request_failure_marks_all():
    provider = make_provider(lambda request: httpx.Response(500), max_retries=0)
    results = await provider.quotes([MT, PA])
    assert isinstance(results["XSHG:600519"], ProviderError)
    assert isinstance(results["XSHE:000001"], ProviderError)


async def test_quote_single_raises_on_missing():
    provider = make_provider(lambda request: httpx.Response(200, content=b""))
    with pytest.raises(ProviderError):
        await provider.quote(MT)


async def test_host_not_whitelisted_rejected():
    # secure_fetch guards the whitelist regardless of caller.
    from mona.services.stock.provider import secure_fetch

    with pytest.raises(HostNotAllowedError):
        await secure_fetch(
            "https://evil.example.com/api", allowed_hosts=frozenset({"qt.gtimg.cn"})
        )


# --- kline ---


def _kline_payload(code: str, key: str, rows: list) -> bytes:
    return json.dumps({"code": 0, "msg": "", "data": {code: {key: rows}}}).encode()


async def test_kline_parses_qfqday_and_skips_dividend_tail():
    def handler(request):
        return httpx.Response(
            200,
            content=_kline_payload(
                "sh600519",
                "qfqday",
                [
                    ["2026-08-13", "1680.0", "1690.0", "1700.0", "1670.0", "1000.0"],
                    ["2026-08-14", "1690.0", "1700.5", "1710.0", "1680.0", "1200.0", {"nd": 1}],
                ],
            ),
        )

    provider = make_provider(handler)
    series = await provider.kline(MT, limit=120)
    assert len(series.bars) == 2
    last = series.bars[-1]
    assert (last.date, last.open, last.close, last.high, last.low, last.volume) == (
        "2026-08-14",
        1690.0,
        1700.5,
        1710.0,
        1680.0,
        1200.0,
    )
    assert series.source.provider == "tencent"
    assert series.source.published_at == "2026-08-14"


async def test_kline_falls_back_to_day_key_for_index():
    def handler(request):
        return httpx.Response(
            200,
            content=_kline_payload(
                "sh000001",
                "day",
                [["2026-08-14", "3200.0", "3201.5", "3210.0", "3190.0", "9999.0"]],
            ),
        )

    provider = make_provider(handler)
    series = await provider.kline(SH_INDEX, limit=120)
    assert [b.close for b in series.bars] == [3201.5]


async def test_kline_week_and_month_use_period_keys():
    """klt=102/103 走 qfqweek/qfqmonth 键（实回验证 2026-08-16）。"""
    seen_urls = []

    def handler(request):
        seen_urls.append(str(request.url))
        period = "week" if "week" in seen_urls[-1] else "month"
        return httpx.Response(
            200,
            content=_kline_payload(
                "sh600519",
                f"qfq{period}",
                [["2026-08-W1", "1300.0", "1341.99", "1360.0", "1290.0", "187025.0"]],
            ),
        )

    provider = make_provider(handler)
    weekly = await provider.kline(MT, limit=30, klt=102)
    assert [b.close for b in weekly.bars] == [1341.99]
    monthly = await provider.kline(MT, limit=30, klt=103)
    assert [b.close for b in monthly.bars] == [1341.99]
    assert any(",week," in url for url in seen_urls)
    assert any(",month," in url for url in seen_urls)


async def test_kline_rejects_unsupported_klt():
    provider = make_provider(lambda request: httpx.Response(200, json={}))
    with pytest.raises(ProviderError, match="unsupported klt"):
        await provider.kline(MT, klt=105)


async def test_kline_truncates_to_limit():
    def handler(request):
        return httpx.Response(
            200,
            content=_kline_payload(
                "sh600519",
                "qfqday",
                [[f"2026-08-{i:02d}", "1", str(i), "2", "0.5", "10"] for i in range(1, 11)],
            ),
        )

    provider = make_provider(handler)
    series = await provider.kline(MT, limit=3)
    assert [b.close for b in series.bars] == [8.0, 9.0, 10.0]


async def test_kline_error_code_raises():
    provider = make_provider(
        lambda request: httpx.Response(200, content=b'{"code": 1, "msg": "bad"}')
    )
    with pytest.raises(ProviderError):
        await provider.kline(MT)


async def test_kline_empty_rows_raises():
    def handler(request):
        return httpx.Response(200, content=_kline_payload("sh600519", "qfqday", []))

    provider = make_provider(handler)
    with pytest.raises(ProviderError):
        await provider.kline(MT)
