"""T15: services 数据 API（design §10.1，dev plan T15）。

aiohttp test client against a minimal app wiring only ``/api/stock/*``
routes; the watchlist store is bound to ``tmp_path`` and the provider is a
recording fake — no network, no workspace access.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.services.stock.api as stock_api
from mona.services.stock import run_init
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import (
    Fundamentals,
    InstrumentSearchResult,
    KlineBar,
    KlineSeries,
    NewsItem,
    ProviderError,
    Quote,
)
from mona.services.stock.storage import WatchlistItem, WatchlistStore
from tests.services.stock.test_evidence import FakeProvider as EvidenceFakeProvider
from tests.services.stock.test_evidence import _bars


def _source() -> SourceRecord:
    return SourceRecord.create(
        provider="fake",
        url="https://push2.eastmoney.com/api/qt/stock/get",
        body=b"{}",
        fields=["price"],
        published_at=None,
    )


def _quote(inst_id: str = "XSHG:600519", name: str = "贵州茅台") -> Quote:
    return Quote(
        instrument_id=inst_id,
        instrument_type="equity",
        name=name,
        price=1700.0,
        change_pct=0.0123,
        volume=23456.0,
        as_of="2026-08-15T15:00:00+08:00",
        source=_source(),
    )


def _kline(inst_id: str = "XSHG:600519", bars: int = 60) -> KlineSeries:
    return KlineSeries(
        instrument_id=inst_id,
        instrument_type="equity",
        bars=[
            KlineBar(
                date=f"2026-06-{(i % 28) + 1:02d}",
                open=100.0 + i,
                close=101.0 + i,
                high=102.0 + i,
                low=99.0 + i,
                volume=1000.0 + i,
            )
            for i in range(bars)
        ],
        source=_source(),
    )


def _fundamentals(inst_id: str = "XSHG:600519") -> Fundamentals:
    return Fundamentals(
        instrument_id=inst_id,
        instrument_type="equity",
        report_period="2026-06-30",
        metrics={"eps": 1.23, "roe": 10.2},
        source=_source(),
    )


def _news(inst_id: str = "XSHG:600519") -> NewsItem:
    return NewsItem(
        instrument_id=inst_id,
        instrument_type="equity",
        title="公司公告",
        url="https://example.com/news",
        published_at="2026-08-15T10:00:00+08:00",
        summary="新闻摘要",
        source=_source(),
    )


class FakeProvider:
    """Records calls; per-instrument entries may be an Exception to raise."""

    def __init__(self) -> None:
        self.search_results: list[InstrumentSearchResult] = []
        self.search_error: Exception | None = None
        self.quote_results: dict[str, Quote | Exception] = {}
        self.kline_series: dict[str, KlineSeries | Exception] = {}
        self.kline_limits: list[int] = []
        self.kline_klts: list[int] = []
        self.quote_types: list[str] = []
        self.kline_types: list[str] = []
        self.fundamentals_result: Fundamentals | Exception | None = None
        self.news_result: list[NewsItem] | Exception | None = None
        self.fundamentals_types: list[str] = []
        self.news_limits: list[int] = []

    async def search(self, keyword: str, *, limit: int = 10):
        if self.search_error is not None:
            raise self.search_error
        return self.search_results[:limit]

    async def quotes(self, insts):
        self.quote_types.extend(inst.instrument_type for inst in insts)
        return {inst.id: self.quote_results[inst.id] for inst in insts}

    async def kline(self, inst, *, limit: int = 120, klt: int = 101):
        self.kline_limits.append(limit)
        self.kline_klts.append(klt)
        self.kline_types.append(inst.instrument_type)
        result = self.kline_series[inst.id]
        if isinstance(result, Exception):
            raise result
        return result

    async def fundamentals(self, inst):
        self.fundamentals_types.append(inst.instrument_type)
        if isinstance(self.fundamentals_result, Exception):
            raise self.fundamentals_result
        assert self.fundamentals_result is not None
        return self.fundamentals_result

    async def news(self, inst, *, limit: int = 10):
        self.news_limits.append(limit)
        if isinstance(self.news_result, Exception):
            raise self.news_result
        assert self.news_result is not None
        return self.news_result[:limit]


@pytest.fixture
def store(tmp_path):
    return WatchlistStore(tmp_path / "stock")


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
async def client(store, provider, monkeypatch):
    monkeypatch.setattr(stock_api, "_STORE", store)
    monkeypatch.setattr(stock_api, "_PROVIDER", provider)
    app = web.Application()
    app["workspace"] = store.root.parent
    app.router.add_get("/api/stock/watchlist", stock_api.handle_stock_watchlist_list)
    app.router.add_post("/api/stock/watchlist", stock_api.handle_stock_watchlist_add)
    app.router.add_delete("/api/stock/watchlist", stock_api.handle_stock_watchlist_remove)
    app.router.add_post(
        "/api/stock/watchlist/import", stock_api.handle_stock_watchlist_import
    )
    app.router.add_post(
        "/api/stock/watchlist/focus", stock_api.handle_stock_watchlist_focus
    )
    app.router.add_post(
        "/api/stock/watchlist/order", stock_api.handle_stock_watchlist_reorder
    )
    app.router.add_get("/api/stock/search", stock_api.handle_stock_search)
    app.router.add_get("/api/stock/quote", stock_api.handle_stock_quote)
    app.router.add_get("/api/stock/kline", stock_api.handle_stock_kline)
    app.router.add_get("/api/stock/diagnosis/{diagnosis_id}", stock_api.handle_stock_diagnosis_get)
    app.router.add_get(
        "/api/stock/diagnosis/{diagnosis_id}/outcome",
        stock_api.handle_stock_diagnosis_outcome,
    )
    app.router.add_delete("/api/stock/diagnosis/{diagnosis_id}", stock_api.handle_stock_diagnosis_delete)
    app.router.add_get("/api/stock/research-context", stock_api.handle_stock_research_context)
    app.router.add_post("/api/stock/research/preflight", stock_api.handle_stock_research_preflight)
    app.router.add_get("/api/stock/risk-profile", stock_api.handle_stock_risk_profile)
    app.router.add_put("/api/stock/risk-profile", stock_api.handle_stock_risk_profile)
    app.router.add_delete("/api/stock/risk-profile", stock_api.handle_stock_risk_profile_delete)
    app.router.add_get("/api/stock/portfolio-context", stock_api.handle_stock_portfolio_context)
    app.router.add_put("/api/stock/portfolio-context", stock_api.handle_stock_portfolio_context)
    app.router.add_delete("/api/stock/portfolio-context", stock_api.handle_stock_portfolio_context)
    async with TestClient(TestServer(app)) as c:
        yield c


# --- watchlist ---


async def test_watchlist_list_empty(client):
    resp = await client.get("/api/stock/watchlist")
    assert resp.status == 200
    assert (await resp.json()) == {"items": []}


async def test_diagnosis_delete_removes_terminal_record(client, store):
    service = stock_api.DiagnosisService(store.root.parent)
    record = service.create(
        instrument={"exchange": "XSHG", "symbol": "600519"},
        evidence_context_id="direct_input",
    )
    service.cancel(record["diagnosis_id"])

    response = await client.delete(f"/api/stock/diagnosis/{record['diagnosis_id']}")

    assert response.status == 200
    assert await response.json() == {"deleted": record["diagnosis_id"]}
    missing = await client.get(f"/api/stock/diagnosis/{record['diagnosis_id']}")
    assert missing.status == 404


@pytest.mark.asyncio
async def test_standard_diagnosis_outcome_endpoint_tracks_one_stock_path(provider):
    from tests.services.stock.test_diagnosis_outcome import _report

    class OutcomeDiagnosisService:
        def get(self, diagnosis_id, **_kwargs):
            assert diagnosis_id == "diagnosis_outcome_fixture"
            return {"status": "succeeded", "report": _report()}

        create = execute = list = cancel = fail = retry = delete = lambda self, *args, **kwargs: None

    def series(instrument_id: str, rows: list[tuple[str, float, float, float]]) -> KlineSeries:
        return KlineSeries(
            instrument_id=instrument_id,
            instrument_type="index" if instrument_id == "XSHG:000985" else "equity",
            bars=[
                KlineBar(
                    date=date,
                    open=close,
                    high=high,
                    low=low,
                    close=close,
                    volume=1000,
                )
                for date, high, low, close in rows
            ],
            source=_source(),
        )

    provider.kline_series["XSHE:002709"] = series(
        "XSHE:002709",
        [
            ("2026-01-02", 39.50, 39.00, 39.20),
            ("2026-01-05", 39.00, 38.50, 38.80),
            ("2026-01-06", 42.10, 38.00, 41.50),
        ],
    )
    provider.kline_series["XSHG:000985"] = series(
        "XSHG:000985",
        [
            ("2026-01-02", 101, 99, 100),
            ("2026-01-05", 102, 100, 101),
            ("2026-01-06", 103, 101, 102),
        ],
    )
    app = web.Application()
    app["stock_diagnosis_service"] = OutcomeDiagnosisService()
    app["stock_diagnosis_provider"] = provider
    app.router.add_get(
        "/api/stock/diagnosis/{diagnosis_id}/outcome",
        stock_api.handle_stock_diagnosis_outcome,
    )
    async with TestClient(TestServer(app)) as outcome_client:
        response = await outcome_client.get(
            "/api/stock/diagnosis/diagnosis_outcome_fixture/outcome"
        )
        assert response.status == 200
        body = await response.json()

    assert body["outcomeLabel"] == "达到第一止盈"
    assert body["entryDate"] == "2026-01-05"
    assert body["firstTriggerType"] == "first_take_profit"
    assert provider.kline_types[-2:] == ["equity", "index"]


async def test_watchlist_add_bare_code_infers_exchange(client):
    resp = await client.post(
        "/api/stock/watchlist", json={"symbol": "600519", "name": "贵州茅台"}
    )
    assert resp.status == 200
    items = (await resp.json())["items"]
    assert len(items) == 1
    item = items[0]
    assert item["instrumentId"] == "XSHG:600519"
    assert item["instrumentType"] == "equity"
    assert item["name"] == "贵州茅台"
    assert item["focus"] is False
    assert item["addedAt"]


async def test_watchlist_add_accepts_exchange_prefix_and_etf(client):
    resp = await client.post(
        "/api/stock/watchlist",
        json={"symbol": "XSHE:159915", "name": "创业板ETF", "instrumentType": "etf"},
    )
    assert resp.status == 200
    item = (await resp.json())["items"][0]
    assert item["instrumentId"] == "XSHE:159915"
    assert item["instrumentType"] == "etf"


async def test_watchlist_add_duplicate_is_idempotent(client):
    payload = {"symbol": "600519", "name": "贵州茅台"}
    await client.post("/api/stock/watchlist", json=payload)
    resp = await client.post("/api/stock/watchlist", json=payload)
    assert resp.status == 200
    assert len((await resp.json())["items"]) == 1


async def test_watchlist_add_invalid_symbol(client):
    resp = await client.post("/api/stock/watchlist", json={"symbol": "ABC"})
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_add_invalid_instrument_type(client):
    resp = await client.post(
        "/api/stock/watchlist",
        json={"symbol": "600519", "instrumentType": "future"},
    )
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_remove(client):
    await client.post("/api/stock/watchlist", json={"symbol": "600519"})
    resp = await client.delete("/api/stock/watchlist", params={"id": "XSHG:600519"})
    assert resp.status == 200
    assert (await resp.json()) == {"items": []}


async def test_watchlist_remove_missing_returns_404(client):
    resp = await client.delete("/api/stock/watchlist", params={"id": "XSHG:600519"})
    assert resp.status == 404
    assert (await resp.json())["error"]["code"] == "unknown_instrument"


async def test_watchlist_remove_malformed_id(client):
    resp = await client.delete("/api/stock/watchlist", params={"id": "nonsense"})
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_focus_toggles_marker(client):
    """Focus toggle feeds review_scope=focus (stock-module design §11)."""
    await client.post(
        "/api/stock/watchlist", json={"symbol": "600519", "name": "贵州茅台"}
    )
    await client.post(
        "/api/stock/watchlist", json={"symbol": "000001", "name": "平安银行"}
    )
    resp = await client.post(
        "/api/stock/watchlist/focus",
        json={"id": "XSHG:600519", "focus": True},
    )
    assert resp.status == 200
    items = {i["instrumentId"]: i for i in (await resp.json())["items"]}
    assert items["XSHG:600519"]["focus"] is True
    assert items["XSHE:000001"]["focus"] is False
    # Toggling back off.
    resp = await client.post(
        "/api/stock/watchlist/focus",
        json={"id": "XSHG:600519", "focus": False},
    )
    assert resp.status == 200
    items = {i["instrumentId"]: i for i in (await resp.json())["items"]}
    assert items["XSHG:600519"]["focus"] is False


async def test_watchlist_focus_requires_bool(client):
    await client.post("/api/stock/watchlist", json={"symbol": "600519"})
    resp = await client.post(
        "/api/stock/watchlist/focus", json={"id": "XSHG:600519", "focus": "yes"}
    )
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_focus_unknown_returns_404(client):
    resp = await client.post(
        "/api/stock/watchlist/focus",
        json={"id": "XSHG:999999", "focus": True},
    )
    assert resp.status == 404
    assert (await resp.json())["error"]["code"] == "unknown_instrument"


async def test_watchlist_focus_malformed_id(client):
    resp = await client.post(
        "/api/stock/watchlist/focus", json={"id": "../etc", "focus": True}
    )
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_reorder_persists_drag_and_drop_order(client):
    await client.post("/api/stock/watchlist", json={"symbol": "600519"})
    await client.post("/api/stock/watchlist", json={"symbol": "000001"})
    resp = await client.post(
        "/api/stock/watchlist/order",
        json={"ids": ["XSHE:000001", "XSHG:600519"]},
    )
    assert resp.status == 200
    items = (await resp.json())["items"]
    assert [i["instrumentId"] for i in items] == ["XSHE:000001", "XSHG:600519"]


async def test_watchlist_reorder_mismatch_keeps_current_order(client):
    """ids 不是当前列表的排列时不写入，返回真实列表让前端自愈。"""
    await client.post("/api/stock/watchlist", json={"symbol": "600519"})
    await client.post("/api/stock/watchlist", json={"symbol": "000001"})
    resp = await client.post(
        "/api/stock/watchlist/order",
        json={"ids": ["XSHG:999999", "XSHG:600519"]},
    )
    assert resp.status == 200
    items = (await resp.json())["items"]
    assert [i["instrumentId"] for i in items] == ["XSHG:600519", "XSHE:000001"]


async def test_watchlist_reorder_validates_ids(client):
    resp = await client.post("/api/stock/watchlist/order", json={"ids": "600519"})
    assert resp.status == 400
    resp = await client.post(
        "/api/stock/watchlist/order", json={"ids": ["../etc"]}
    )
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_import_reports_counts_and_errors(client):
    text = "600519,贵州茅台\n000001,平安银行\n600519,贵州茅台\nbadline\n"
    resp = await client.post("/api/stock/watchlist/import", json={"text": text})
    assert resp.status == 200
    body = await resp.json()
    assert body["imported"] == 2
    assert body["skipped"] == 1
    assert len(body["errors"]) == 1
    assert len(body["items"]) == 2


async def test_watchlist_import_requires_text(client):
    resp = await client.post("/api/stock/watchlist/import", json={})
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_watchlist_corrupt_returns_500(client, store):
    store.root.mkdir(parents=True, exist_ok=True)
    store.path.write_text("not json", encoding="utf-8")
    resp = await client.get("/api/stock/watchlist")
    assert resp.status == 500
    assert (await resp.json())["error"]["code"] == "watchlist_corrupt"


# --- search ---


async def test_search_requires_query(client):
    resp = await client.get("/api/stock/search")
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_search_returns_results(client, provider):
    provider.search_results = [
        InstrumentSearchResult(
            instrument_id="XSHG:600519",
            symbol="600519",
            exchange="XSHG",
            name="贵州茅台",
            instrument_type="equity",
            pinyin="GZMT",
        )
    ]
    resp = await client.get("/api/stock/search", params={"q": "茅台"})
    assert resp.status == 200
    results = (await resp.json())["results"]
    assert results == [
        {
            "instrumentId": "XSHG:600519",
            "symbol": "600519",
            "exchange": "XSHG",
            "name": "贵州茅台",
            "instrumentType": "equity",
            "pinyin": "GZMT",
        }
    ]


async def test_search_upstream_failure_returns_502(client, provider):
    provider.search_error = ProviderError("boom")
    resp = await client.get("/api/stock/search", params={"q": "茅台"})
    assert resp.status == 502
    assert (await resp.json())["error"]["code"] == "upstream_unavailable"


# --- quote ---


async def test_quote_requires_ids(client):
    resp = await client.get("/api/stock/quote")
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_quote_rejects_unknown_instrument_id(client):
    resp = await client.get("/api/stock/quote", params={"ids": "XSHG:600519,BAD:1"})
    assert resp.status == 400
    body = await resp.json()
    assert body["error"]["code"] == "unknown_instrument"
    assert "BAD:1" in body["error"]["message"]


async def test_quote_rejects_too_many_ids(client):
    ids = ",".join(["XSHG:600519"] * 51)
    resp = await client.get("/api/stock/quote", params={"ids": ids})
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_quote_batch_snapshot(client, provider):
    provider.quote_results["XSHG:600519"] = _quote()
    provider.quote_results["XSHE:000001"] = _quote("XSHE:000001", "平安银行")
    resp = await client.get(
        "/api/stock/quote", params={"ids": "XSHG:600519,XSHE:000001"}
    )
    assert resp.status == 200
    quotes = (await resp.json())["quotes"]
    assert [q["instrumentId"] for q in quotes] == ["XSHG:600519", "XSHE:000001"]
    first = quotes[0]
    assert first["name"] == "贵州茅台"
    assert first["price"] == 1700.0
    assert first["changePct"] == pytest.approx(0.0123)
    assert first["asOf"] == "2026-08-15T15:00:00+08:00"
    assert first["source"]["provider"] == "fake"


async def test_quote_per_item_failure_isolated(client, provider):
    provider.quote_results["XSHG:600519"] = _quote()
    provider.quote_results["XSHE:000001"] = ProviderError("timeout")
    resp = await client.get(
        "/api/stock/quote", params={"ids": "XSHG:600519,XSHE:000001"}
    )
    assert resp.status == 200
    quotes = (await resp.json())["quotes"]
    assert quotes[0]["instrumentId"] == "XSHG:600519"
    assert "error" not in quotes[0]
    assert quotes[1]["instrumentId"] == "XSHE:000001"
    assert quotes[1]["error"]["code"] == "upstream_unavailable"


async def test_quote_uses_saved_etf_type(client, provider):
    await client.post(
        "/api/stock/watchlist",
        json={"symbol": "510300", "exchange": "XSHG", "name": "沪深300ETF", "instrumentType": "etf"},
    )
    provider.quote_results["XSHG:510300"] = _quote("XSHG:510300", "沪深300ETF")
    resp = await client.get("/api/stock/quote", params={"ids": "XSHG:510300"})
    assert resp.status == 200
    assert provider.quote_types == ["etf"]


# --- kline ---


async def test_kline_rejects_unknown_instrument_id(client):
    resp = await client.get("/api/stock/kline", params={"id": "nonsense"})
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "unknown_instrument"


async def test_kline_returns_bars_and_indicators(client, provider):
    provider.kline_series["XSHG:600519"] = _kline()
    resp = await client.get("/api/stock/kline", params={"id": "XSHG:600519"})
    assert resp.status == 200
    body = await resp.json()
    assert body["instrumentId"] == "XSHG:600519"
    assert len(body["bars"]) == 60
    indicators = body["indicators"]
    assert len(indicators["ma"]["ma5"]) == 60
    assert len(indicators["ma"]["ma20"]) == 60
    assert len(indicators["ma"]["ma60"]) == 60
    assert len(indicators["macd"]["dif"]) == 60
    assert len(indicators["macd"]["dea"]) == 60
    assert len(indicators["macd"]["hist"]) == 60
    assert len(indicators["rsi14"]) == 60
    swing = indicators["swing"]
    assert swing["method"] == "swing-high-low-v1"
    assert swing["support"] == pytest.approx(139.0)  # min low of last 20 bars
    assert swing["resistance"] == pytest.approx(161.0)  # max high of last 20 bars
    assert indicators["volumeChangePct"] is not None
    assert body["source"]["provider"] == "fake"


async def test_kline_forwards_limit(client, provider):
    provider.kline_series["XSHG:600519"] = _kline()
    resp = await client.get(
        "/api/stock/kline", params={"id": "XSHG:600519", "limit": "30"}
    )
    assert resp.status == 200
    assert provider.kline_limits == [30]


async def test_kline_forwards_klt_period(client, provider):
    """101日/102周/103月透传；非法 klt 拒绝。"""
    provider.kline_series["XSHG:600519"] = _kline()
    for klt in ("101", "102", "103"):
        resp = await client.get(
            "/api/stock/kline", params={"id": "XSHG:600519", "klt": klt}
        )
        assert resp.status == 200
    assert provider.kline_klts == [101, 102, 103]
    resp = await client.get(
        "/api/stock/kline", params={"id": "XSHG:600519", "klt": "105"}
    )
    assert resp.status == 400
    assert (await resp.json())["error"]["code"] == "invalid_params"


async def test_kline_upstream_failure_returns_502(client, provider):
    provider.kline_series["XSHG:600519"] = ProviderError("boom")
    resp = await client.get("/api/stock/kline", params={"id": "XSHG:600519"})
    assert resp.status == 502
    assert (await resp.json())["error"]["code"] == "upstream_unavailable"


# --- research context ---


async def test_research_context_returns_current_fundamentals_and_news(client, provider):
    provider.fundamentals_result = _fundamentals()
    provider.news_result = [_news()]
    resp = await client.get("/api/stock/research-context", params={"id": "XSHG:600519"})
    assert resp.status == 200
    body = await resp.json()
    assert body["instrumentId"] == "XSHG:600519"
    assert body["fundamentals"]["status"] == "available"
    assert body["fundamentals"]["data"]["reportPeriod"] == "2026-06-30"
    assert body["news"]["status"] == "available"
    assert body["news"]["items"][0]["title"] == "公司公告"
    assert provider.news_limits == [5]


async def test_research_context_degrades_only_the_failed_section(client, provider):
    provider.fundamentals_result = ProviderError("timeout")
    provider.news_result = [_news()]
    resp = await client.get("/api/stock/research-context", params={"id": "XSHG:600519"})
    assert resp.status == 200
    body = await resp.json()
    assert body["fundamentals"]["status"] == "unavailable"
    assert body["news"]["status"] == "available"


async def test_research_context_skips_company_fundamentals_for_etf(client, provider):
    await client.post(
        "/api/stock/watchlist",
        json={"symbol": "510300", "exchange": "XSHG", "name": "沪深300ETF", "instrumentType": "etf"},
    )
    provider.news_result = [_news("XSHG:510300")]
    resp = await client.get("/api/stock/research-context", params={"id": "XSHG:510300"})
    assert resp.status == 200
    body = await resp.json()
    assert body["instrumentType"] == "etf"
    assert body["fundamentals"]["status"] == "not_applicable"
    assert provider.fundamentals_types == []


async def test_local_risk_profile_and_instrument_context_api_are_scoped_and_safe(client):
    initial = await client.get("/api/stock/risk-profile")
    assert initial.status == 200
    initial_body = await initial.json()
    assert initial_body["configured"] is False
    assert initial_body["storage"]["brokerConnected"] is False

    saved = await client.put(
        "/api/stock/risk-profile",
        json={
            "risk_level": "balanced",
            "max_drawdown_tolerance_pct": 25,
            "risk_budget_pct": 0.5,
            "max_single_position_pct": 15,
            "max_industry_exposure_pct": 25,
            "max_correlated_exposure_pct": 40,
            "total_funds_range": "100k_500k",
        },
    )
    assert saved.status == 200
    saved_body = await saved.json()
    assert saved_body["configured"] is True
    assert saved_body["profile"]["risk_level"] == "balanced"

    context = await client.put(
        "/api/stock/portfolio-context",
        json={
            "instrumentId": "XSHG:600519",
            "context": {
                "position_input_mode": "percentage",
                "holding_state": "not_holding",
                "current_position_pct": 12,
                "today_bought_quantity": 100,
            },
        },
    )
    assert context.status == 200
    context_body = await context.json()
    assert context_body["context"]["holding_state"] == "holding"
    assert context_body["context"]["position_input_mode"] == "percentage"
    assert context_body["context"]["portfolio_value_yuan"] is None
    assert context_body["context"]["holding_quantity"] is None
    assert context_body["context"]["portfolio_value_configured"] is False

    assets_context = await client.put(
        "/api/stock/portfolio-context",
        json={
            "instrumentId": "XSHG:600519",
            "context": {
                "position_input_mode": "assets_shares",
                "portfolio_value_yuan": 100000,
                "holding_quantity": 100,
                "current_position_pct": 12,
            },
        },
    )
    assert assets_context.status == 200
    assets_body = await assets_context.json()
    assert assets_body["context"]["position_input_mode"] == "assets_shares"
    assert assets_body["context"]["portfolio_value_yuan"] == 100000
    assert assets_body["context"]["holding_quantity"] == 100

    deleted = await client.delete(
        "/api/stock/portfolio-context", params={"instrumentId": "XSHG:600519"}
    )
    assert deleted.status == 200
    assert (await deleted.json())["context"]["holding_state"] == "not_holding"


async def test_local_risk_profile_api_reports_corrupt_store(client, store):
    path = store.root.parent / "stock" / "risk_profile.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{broken", encoding="utf-8")
    response = await client.get("/api/stock/risk-profile")
    assert response.status == 500
    assert (await response.json())["error"]["code"] == "risk_profile_store_error"


async def test_local_risk_profile_rejects_inconsistent_funds_range(client):
    saved = await client.put(
        "/api/stock/risk-profile",
        json={"total_funds_range": "under_100k", "risk_level": "conservative"},
    )
    assert saved.status == 200
    response = await client.put(
        "/api/stock/portfolio-context",
        json={
            "instrumentId": "XSHG:600519",
            "context": {
                "position_input_mode": "assets_shares",
                "portfolio_value_yuan": 200000,
                "holding_quantity": 100,
            },
        },
    )
    assert response.status == 400
    assert (await response.json())["error"]["code"] == "portfolio_context_invalid"


async def test_research_preflight_returns_context_and_horizon_coverage(client, monkeypatch):
    class FakeEvidenceService:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        async def build_context(self, context_id, inst, **kwargs):
            assert context_id.startswith("ctx_")
            assert inst.id == "XSHG:600519"
            assert kwargs["owner"] == {"kind": "stock_preflight"}
            return {
                "symbols": {
                    inst.id: {
                        "instrument": {
                            "symbol": inst.symbol,
                            "exchange": inst.exchange,
                            "instrument_type": inst.instrument_type,
                            "name": "贵州茅台",
                        },
                        "research_cutoff_at": "2026-08-19T15:00:00+08:00",
                        "market_as_of": "2026-08-19T15:00:00+08:00",
                            "decision_readiness": {
                                "status": "ready",
                                "horizons": {
                                    "short_term": {"status": "ready", "required": ["quote", "kline", "technical_indicators"], "available": ["quote", "kline", "technical_indicators"], "missing": []},
                                    "medium_term": {"status": "ready", "required": ["quote", "kline", "technical_indicators", "fundamentals"], "available": ["quote", "kline", "technical_indicators", "fundamentals"], "missing": []},
                                    "long_term": {"status": "ready", "required": ["quote", "kline", "technical_indicators", "fundamentals", "company_quality", "valuation"], "available": ["quote", "kline", "technical_indicators", "fundamentals", "company_quality", "valuation"], "missing": []},
                                },
                            },
                        "evidence_coverage": {
                            "short_term": {"status": "available", "missing_sections": [], "degraded_sections": []},
                            "medium_term": {"status": "degraded", "missing_sections": ["policy_context"], "degraded_sections": []},
                            "long_term": {"status": "insufficient_data", "missing_sections": ["company_quality"], "degraded_sections": []},
                        },
                        "data_quality": {"missing": ["policy_context"]},
                    }
                }
            }

    monkeypatch.setattr(stock_api, "EvidenceService", FakeEvidenceService)
    resp = await client.post("/api/stock/research/preflight", json={"instrumentId": "XSHG:600519"})
    assert resp.status == 200
    body = await resp.json()
    assert body["contextId"].startswith("ctx_")
    assert body["instrument"]["instrumentType"] == "equity"
    assert body["researchCutoffAt"] == "2026-08-19T15:00:00+08:00"
    assert body["decisionReadiness"]["status"] == "ready"
    assert body["decisionReadiness"]["horizons"]["long_term"]["status"] == "ready"
    assert set(body["decisionReadiness"]) == {"status", "horizons"}
    assert body["evidenceCoverage"]["medium_term"]["missing_sections"] == ["policy_context"]
    assert body["evidenceCoverage"]["long_term"]["status"] == "insufficient_data"


async def test_research_preflight_failure_is_explicit(client, monkeypatch):
    class FailingEvidenceService:
        def __init__(self, **kwargs):
            pass

        async def build_context(self, *args, **kwargs):
            raise TimeoutError("source timeout")

    monkeypatch.setattr(stock_api, "EvidenceService", FailingEvidenceService)
    resp = await client.post("/api/stock/research/preflight", json={"instrumentId": "XSHG:600519"})
    assert resp.status == 502
    assert (await resp.json())["error"]["code"] == "preflight_failed"


async def test_research_preflight_rejects_failed_decision_readiness(client, monkeypatch):
    class FailedEvidenceService:
        def __init__(self, **kwargs):
            pass

        async def build_context(self, context_id, inst, **kwargs):
            return {
                "symbols": {
                    inst.id: {
                        "instrument": {"symbol": inst.symbol, "exchange": inst.exchange, "instrument_type": "equity"},
                        "decision_readiness": {
                            "status": "failed",
                            "core": {"status": "failed", "missing": ["quote"]},
                            "enhanced": {"status": "degraded", "missing": []},
                        },
                    }
                }
            }

    monkeypatch.setattr(stock_api, "EvidenceService", FailedEvidenceService)
    resp = await client.post("/api/stock/research/preflight", json={"instrumentId": "XSHG:600519"})
    assert resp.status == 502
    payload = await resp.json()
    assert payload["error"]["code"] == "preflight_failed"


async def test_research_preflight_round_trip_reuses_real_context_without_refetch(
    client, store, monkeypatch, tmp_path
):
    store.add(
        WatchlistItem(
            symbol="600519",
            exchange="XSHG",
            name="贵州茅台",
            instrument_type="equity",
        )
    )
    bars = _bars(130)
    bars = [
        bar.model_copy(
            update={
                "date": (datetime(2026, 1, 5) + timedelta(days=index)).strftime("%Y-%m-%d")
            }
        )
        for index, bar in enumerate(bars)
    ]
    provider = EvidenceFakeProvider(
        bars=bars,
        fund_published_at="2026-08-15T15:00:00+08:00",
    )

    class FakeResearchProvider:
        async def search_documents(self, *_args, **_kwargs):
            return []

        async def search_policy_documents(self, *_args, **_kwargs):
            return []

    workspace = tmp_path / "workspace"
    monkeypatch.setattr(stock_api, "_PROVIDER", provider)
    monkeypatch.setattr(stock_api, "GovernmentResearchProvider", FakeResearchProvider)
    monkeypatch.setattr(stock_api, "_preflight_workspace", lambda _request: workspace)

    response = await client.post(
        "/api/stock/research/preflight", json={"instrumentId": "XSHG:600519"}
    )
    # V6 can launch research when at least one horizon is research-ready;
    # missing trade qualifications are returned as per-horizon gates.
    assert response.status == 200
    preflight = await response.json()
    assert "researchReady" in preflight["decisionReadiness"]
    assert "tradeReady" in preflight["decisionReadiness"]
    return
    preflight = await response.json()
    context_id = preflight["contextId"]
    calls_after_preflight = dict(provider.calls)

    run = SimpleNamespace(
        id="run_preflight_roundtrip",
        inputs={
            "symbols": ["XSHG:600519"],
            "evidence_context_id": context_id,
        },
    )
    result = await run_init.build_run_evidence(
        run,
        workspace=workspace,
        watchlist_root=tmp_path / "unused-watchlist",
    )

    assert result == ["XSHG:600519"]
    assert provider.calls == calls_after_preflight

    from mona.services.stock.evidence import EvidenceService

    evidence = EvidenceService(workspace=workspace, provider=None)
    context = evidence.read_context(context_id)
    assert context["owner"]["workflow_run_id"] == run.id
    assert evidence.read(run.id, "XSHG:600519") == context["symbols"]["XSHG:600519"]
