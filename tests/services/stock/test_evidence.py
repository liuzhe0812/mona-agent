"""T10: EvidenceBundle service (design §5.2, §7.4, §9).

Idempotent per ``(run_id, symbol)``; trimmed evidence with complete source
records; raw kline kept in the TTL'd cache with hash recorded in the bundle.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from filelock import Timeout as FileLockTimeout

import mona.services.stock.evidence as evidence_module
from mona.services.stock.evidence import (
    _EVENT_TYPES,
    BatchCapacityError,
    EvidenceService,
    TradingCalendarUnavailableError,
)
from mona.services.stock.provenance import (
    SourceRecord,
    compare_asia_datetime,
    normalize_asia_datetime,
    parse_asia_datetime,
)
from mona.services.stock.provider import (
    Fundamentals,
    IndustryValuation,
    IndustryValuationPeer,
    InstrumentRef,
    KlineBar,
    KlineSeries,
    MarketSnapshotCapture,
    MarketSnapshotIncompleteError,
    NewsItem,
    ProviderError,
    Quote,
    ResearchDocument,
)
from mona.services.stock.screening import MarketSnapshot

CN_TZ = timezone(timedelta(hours=8))
MT = InstrumentRef(exchange="XSHG", symbol="600519", instrument_type="equity")
ETF = InstrumentRef(exchange="XSHE", symbol="159915", instrument_type="etf")
POLY = InstrumentRef(exchange="XSHE", symbol="002407", instrument_type="equity")
AS_OF = "2026-08-14T15:30:00+08:00"


def _bars(n=30, start=1.0):
    """30 deterministic daily bars: close = start + i, high/low ±0.5."""
    out = []
    for i in range(n):
        close = start + i
        day = datetime(2026, 7, 6, tzinfo=CN_TZ) + timedelta(days=i)
        out.append(
            KlineBar(
                date=day.strftime("%Y-%m-%d"),
                open=close - 0.2,
                close=close,
                high=close + 0.5,
                low=close - 0.5,
                volume=1000.0 + i,
            )
        )
    return out


def _src(url):
    return SourceRecord.create(provider="fake", url=url, body=url.encode(), fields=["x"])


class FakeProvider:
    name = "fake"

    def __init__(
        self,
        bars=None,
        news_count=8,
        fail=(),
        news_dates=None,
        quote_as_of=AS_OF,
        fund_published_at=None,
    ):
        self.calls = {"quote": 0, "kline": 0, "fundamentals": 0, "news": 0}
        self._bars = bars if bars is not None else _bars()
        self._news_count = news_count
        self._fail = set(fail)
        self._news_dates = news_dates
        self._quote_as_of = quote_as_of
        self._fund_published_at = fund_published_at

    def _maybe_fail(self, kind, inst):
        if kind in self._fail or f"{kind}:{inst.symbol}" in self._fail:
            raise ProviderError(f"{kind} boom")

    async def quote(self, inst):
        self.calls["quote"] += 1
        self._maybe_fail("quote", inst)
        return Quote(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            name=f"名称{inst.symbol}",
            price=1680.5,
            change_pct=1.23,
            volume=23456,
            pe=20.6,
            pb=6.68,
            market_cap=1677597000000,
            as_of=self._quote_as_of,
            source=_src(f"fake://quote/{inst.symbol}"),
        )

    async def kline(self, inst, *, limit=120):
        self.calls["kline"] += 1
        self._maybe_fail("kline", inst)
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=self._bars,
            source=_src(f"fake://kline/{inst.symbol}"),
        )

    async def fundamentals(self, inst):
        self.calls["fundamentals"] += 1
        self._maybe_fail("fundamentals", inst)
        return Fundamentals(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            report_period="2026-03-31",
            metrics={"eps": 12.34, "roe": 8.56},
            source=SourceRecord.create(
                provider="fake",
                url=f"fake://fund/{inst.symbol}",
                body=f"fake://fund/{inst.symbol}".encode(),
                fields=["x"],
                published_at=self._fund_published_at,
            ),
        )

    async def news(self, inst, *, limit=10):
        self.calls["news"] += 1
        self._maybe_fail("news", inst)
        return [
            NewsItem(
                instrument_id=inst.id,
                instrument_type=inst.instrument_type,
                title=f"新闻{i}",
                url=f"https://example.com/{i}",
                published_at=(
                    self._news_dates[i]
                    if self._news_dates is not None and i < len(self._news_dates)
                    else f"2026-08-1{i} 09:00:00"
                ),
                summary="长" * 500,
                source=_src(f"fake://news/{inst.symbol}"),
            )
            for i in range(self._news_count)
        ]


class FakeWestockSupplement:
    def __init__(self):
        self.calls = []

    async def fetch(self, command, inst):
        self.calls.append(command)
        source = SourceRecord.create(
            provider="westock",
            url=f"westock://{command}/{inst.id}",
            body=f"{command}:{inst.id}".encode(),
            fields=[command],
            published_at=AS_OF,
        )
        data = {
            "profile": {
                "code": inst.symbol,
                "name": "贵州茅台",
                "company_name": "贵州茅台股份有限公司",
                "main_business": "白酒生产与销售",
                "industry": "白酒",
            },
            "asfund": [{
                "code": inst.symbol,
                "report_period": "2026-03-31",
                "period_end": "2026-03-31",
                "published_at": AS_OF,
                "revenue": 10_000,
                "net_profit": 3_000,
                "operating_cashflow": 3_200,
                "cashflow_to_profit": 1.0667,
                "current_ratio": 1.8,
                "interest_coverage": 12.0,
            }],
            "sector": [{
                "code": inst.symbol,
                "industry": "白酒",
                "indicator_name": "产量:白酒:当期同比",
                "latest_date": "2026-08-14",
                "latest_value": 4.2,
            }],
            "macro": [
                {"name": "M2同比", "value": 7.7, "unit": "percent", "period_end": "2026-07-31", "published_at": AS_OF},
                {"name": "居民消费价格同比", "value": 0.5, "unit": "percent", "period_end": "2026-07-31", "published_at": AS_OF},
            ],
            "report": [{"code": inst.symbol, "document_id": "report-1", "title": "公司研究报告", "published_at": AS_OF, "url": ""}],
            "notice": [{"code": inst.symbol, "document_id": "notice-1", "title": "公司经营公告", "published_at": AS_OF, "url": ""}],
            "chip": {"code": inst.symbol, "as_of": AS_OF, "profit_ratio": 38.0, "average_cost": 1600.0, "concentration": 6.0, "concentration70": 6.0},
            "technical": {"code": inst.symbol, "as_of": AS_OF, "close_price": 1680.5, "ma20": 1650.0, "macd": 1.2, "dif": 2.0, "dea": 0.8},
        }[command]
        return {
            "data": data,
            "data_as_of": AS_OF,
            "source": source,
            "source_ids": [source.id],
            "package_name": "westock-data-skillhub",
            "package_version": "1.0.5",
            "contract_version": "westock-contract-v2",
            "validation_mode": "real_canary",
        }

    def capability_matrix(self):
        return {command: {"status": "canary_verified"} for command in self.calls}


class StructuredEventProvider(FakeProvider):
    def __init__(self, events=None, *, complete=True, **kwargs):
        super().__init__(**kwargs)
        self.events = list(events or [])
        self.event_complete = complete
        self.event_calls = []

    async def market_events(self, **kwargs):
        self.event_calls.append(kwargs)
        return SimpleNamespace(
            events=self.events,
            window_start=kwargs["since"],
            window_end=kwargs["until"],
            expected_count=len(self.events),
            loaded_count=len(self.events),
            complete=self.event_complete,
            fetched_at=AS_OF,
            provider="structured-fake",
            cache_status="live",
        )


def _structured_event(*, published_at="2026-08-14 09:00:00", event_date="2026-08-28", title="回购公告", event_type="buyback", source_url="fake://event/1"):
    source = SourceRecord.create(
        provider="structured-fake",
        url=source_url,
        body=source_url.encode(),
        fields=["title", "published_at", "event_type"],
        published_at=published_at,
    )
    return SimpleNamespace(
        event_id=f"event:{source.id}",
        instrument_id=MT.id,
        event_type=event_type,
        title=title,
        summary="可核验结构化事件",
        url="https://example.com/event",
        published_at=published_at,
        event_date=event_date,
        status="published",
        category_codes=["buyback"],
        category_names=["回购"],
        source=source,
        source_ids=[source.id],
    )


class SnapshotProvider(FakeProvider):
    def __init__(self, snapshot_rows=None, **kwargs):
        super().__init__(**kwargs)
        self.snapshot_rows = snapshot_rows or []
        self.snapshot_calls = 0

    async def market_snapshot(self, *, limit=5000):
        self.snapshot_calls += 1
        return MarketSnapshotCapture(
            self.snapshot_rows,
            expected_count=len(self.snapshot_rows),
            page_size=len(self.snapshot_rows),
            complete=True,
            requested_limit=limit,
        )


class FailedMarketSnapshotProvider(FakeProvider):
    """Target quote/profile remain usable when breadth page 1 fails."""

    async def quote(self, inst):
        self.calls["quote"] += 1
        source = SourceRecord.create(
            provider="quote-fallback",
            url=f"fake://quote/{inst.symbol}",
            body=f"quote:{inst.id}".encode(),
            fields=[
                "price", "change_pct", "volume", "amount", "previous_close",
                "turnover_rate", "limit_up", "limit_down",
            ],
            published_at=AS_OF,
        )
        return Quote(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            name="多氟多",
            price=34.57,
            change_pct=-4.37,
            volume=1_236_130,
            amount=4_315_997_278.03,
            previous_close=36.15,
            turnover_rate=11.44,
            limit_up=39.77,
            limit_down=32.54,
            as_of=AS_OF,
            source=source,
        )

    async def instrument_profile(self, inst):
        source = SourceRecord.create(
            provider="profile-fallback",
            url=f"fake://profile/{inst.symbol}",
            body=f"profile:{inst.id}".encode(),
            fields=["industry", "listing_date", "board", "observed_at"],
            published_at=AS_OF,
        )
        return {
            "instrument_id": inst.id,
            "industry": "化学新材料",
            "classification_scheme": "测试行业分类",
            "listing_date": "2010-05-18",
            "board": "深交所主板A股",
            "observed_at": AS_OF,
            "source": source,
        }

    async def market_snapshot(self, *, limit=5000):
        raise MarketSnapshotIncompleteError(
            "market snapshot page 1 failed",
            rows=[],
            expected_count=5000,
            page_size=0,
            requested_limit=limit,
        )


class IndependentValuationProvider(FailedMarketSnapshotProvider):
    async def industry_valuation(self, inst):
        source = SourceRecord.create(
            provider="industry-valuation",
            url=f"fake://industry-valuation/{inst.symbol}",
            body=f"industry-valuation:{inst.id}".encode(),
            fields=["peer_pe_ttm", "peer_pb_mrq", "observed_at"],
            published_at=AS_OF,
        )
        return IndustryValuation(
            instrument_id=inst.id,
            target_pe_ttm=20.6,
            target_pb_mrq=6.68,
            peers=[
                IndustryValuationPeer(
                    instrument_id=f"XSHG:{code}",
                    symbol=code,
                    exchange="XSHG",
                    name=f"同行{index}",
                    pe_ttm=float(10 + index * 5),
                    pb_mrq=float(1 + index),
                    report_period="2026-06-30",
                )
                for index, code in enumerate(("600001", "600002", "600003"), start=1)
            ],
            report_period="2026-06-30",
            observed_at=AS_OF,
            source=source,
        )


def _snapshot_rows(*, observed_at=AS_OF, include_target=True):
    source = SourceRecord.create(
        provider="snapshot",
        url="fake://market/snapshot",
        body=f"snapshot:{observed_at}".encode(),
        fields=["price", "change_pct", "amount", "turnover_rate", "industry", "observed_at"],
        published_at=observed_at,
    )
    rows = [
        MarketSnapshot(
            instrument_id="XSHE:000001",
            symbol="000001",
            exchange="XSHE",
            industry="银行",
            price=10,
            change_pct=-1,
            volume=200,
            turnover=500,
            amount=500,
            turnover_rate=2,
            observed_at=observed_at,
            source_ids=[source.id],
            source=source,
        )
    ]
    if include_target:
        rows.append(
            MarketSnapshot(
                instrument_id=MT.id,
                symbol=MT.symbol,
                exchange=MT.exchange,
                industry="白酒",
                price=1680.5,
                change_pct=1.23,
                volume=23456,
                turnover=10000,
                amount=10000,
                turnover_rate=1.2,
                observed_at=observed_at,
                source_ids=[source.id],
                source=source,
            )
        )
    return rows


def _valuation_peer(symbol, pe, pb, source, *, observed_at=AS_OF):
    return MarketSnapshot(
        instrument_id=f"XSHG:{symbol}",
        symbol=symbol,
        exchange="XSHG",
        industry="白酒",
        price=25,
        change_pct=0.5,
        volume=2000,
        amount=20000,
        turnover=20000,
        turnover_rate=2,
        pe=pe,
        pb=pb,
        observed_at=observed_at,
        source_ids=[source.id],
        source=source,
    )


def make_service(tmp_path, provider, **kwargs):
    return EvidenceService(
        workspace=tmp_path / "ws",
        provider=provider,
        cache_root=tmp_path / "cache",
        **kwargs,
    )


def test_asia_datetime_parser_is_explicit_and_unknown_safe():
    assert normalize_asia_datetime("2026-08-18") == "2026-08-18T00:00:00+08:00"
    assert normalize_asia_datetime("2026-08-18 15:00:00") == "2026-08-18T15:00:00+08:00"
    assert normalize_asia_datetime("2026-08-18T07:00:00Z") == "2026-08-18T15:00:00+08:00"
    assert parse_asia_datetime("not-a-date") is None
    assert compare_asia_datetime("not-a-date", "2026-08-18") is None


async def test_westock_supplements_feed_standard_evidence_sections(tmp_path):
    supplement = FakeWestockSupplement()
    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
        supplement_provider=supplement,
    ).build("run_westock_merge", MT, as_of=AS_OF)

    assert set(supplement.calls) == {
        "profile", "asfund", "sector", "macro", "report", "notice", "chip", "technical",
    }
    assert bundle["company_profile"]["main_business"] == "白酒生产与销售"
    assert bundle["fundamentals"]["metrics"]["eps"] == pytest.approx(12.34)
    assert bundle["fundamentals"]["metrics"]["current_ratio"] == pytest.approx(1.8)
    assert len(bundle["fundamentals"]["source_ids"]) == 2
    assert bundle["cycle_context"]["cycles"]["macro_liquidity"]["status"] == "available"
    assert bundle["cycle_context"]["cycles"]["industry_supply_demand"]["status"] == "available"
    assert bundle["capital_positioning"]["chip_average_cost"] == pytest.approx(1600.0)
    assert bundle["technical_supplement"]["ma20"] == pytest.approx(1650.0)
    assert any(item["title"] == "公司经营公告" for item in bundle["news"])
    assert bundle["research_reports"][0]["title"] == "公司研究报告"
    assert "governance" in bundle["company_quality"]["optional_missing_fields"]
    assert "governance" not in bundle["company_quality"]["missing_fields"]
    source_ids = {item["id"] for item in bundle["sources"]}
    assert set(bundle["capital_positioning"]["source_ids"]) <= source_ids


async def test_research_cutoff_excludes_future_news_and_source(tmp_path):
    provider = FakeProvider(
        news_dates=["2026-08-18 09:00:00", "2026-08-19 09:00:00"],
        news_count=2,
    )
    bundle = await make_service(tmp_path, provider).build(
        "run_cutoff",
        MT,
        research_cutoff_at="2026-08-18T15:00:00+08:00",
    )
    assert bundle["research_cutoff_at"] == "2026-08-18T15:00:00+08:00"
    assert [item["published_at"] for item in bundle["news"]] == [
        "2026-08-18 09:00:00"
    ]
    assert bundle["data_quality"]["excluded_future"]
    assert all("published_at" in item["field"] for item in bundle["data_quality"]["excluded_future"])
    assert "news" not in bundle["data_quality"]["missing"]
    assert not any(source.get("published_at", "").startswith("2026-08-19") for source in bundle["sources"])


async def test_after_close_keeps_post_close_news_but_market_stays_at_close(tmp_path):
    bars = _bars() + [
        KlineBar(
            date="2026-08-18",
            open=32,
            close=32,
            high=32,
            low=32,
            volume=1032,
        )
    ]
    provider = FakeProvider(
        bars=bars,
        news_dates=["2026-08-18 16:00:00"],
        news_count=1,
        quote_as_of="2026-08-18T15:00:00+08:00",
    )
    svc = make_service(
        tmp_path,
        provider,
        clock=lambda: datetime(2026, 8, 18, 16, 30, tzinfo=CN_TZ),
    )
    bundle = await svc.build("run_after_close", MT)
    assert bundle["news"][0]["published_at"] == "2026-08-18 16:00:00"
    assert bundle["market_as_of"] == "2026-08-18T15:00:00+08:00"
    assert bundle["research_cutoff_at"] == "2026-08-18T16:30:00+08:00"


async def test_live_capture_freezes_cutoff_after_primary_fetches(tmp_path):
    start = datetime(2026, 8, 24, 11, 4, 50, 109000, tzinfo=CN_TZ)
    finish = datetime(2026, 8, 24, 11, 5, 0, tzinfo=CN_TZ)
    quote_as_of = "2026-08-24T11:04:51+08:00"
    bars = []
    for index in range(60):
        close = 20 + index * 0.1
        day = datetime(2026, 6, 20, tzinfo=CN_TZ) + timedelta(days=index)
        bars.append(
            KlineBar(
                date=day.strftime("%Y-%m-%d"),
                open=close - 0.1,
                close=close,
                high=close + 0.2,
                low=close - 0.2,
                volume=1000 + index,
            )
        )
    clock_reads = []

    def clock():
        clock_reads.append(True)
        return start if len(clock_reads) <= 2 else finish

    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=bars, quote_as_of=quote_as_of),
        clock=clock,
    ).build("run_live_cutoff", MT)

    assert bundle["research_cutoff_at"] == finish.isoformat()
    assert bundle["quote"]["as_of"] == quote_as_of
    assert bundle["derived_decision_metrics"] is not None
    assert bundle["decision_readiness"]["research_ready"]["status"] == "ready"
    assert bundle["decision_readiness"]["horizons"]["short_term"]["status"] == "ready"


async def test_historical_replay_still_excludes_quote_after_cutoff(tmp_path):
    cutoff = "2026-08-24T11:04:50+08:00"
    future_quote = "2026-08-24T11:04:51+08:00"
    bundle = await make_service(
        tmp_path,
        FakeProvider(quote_as_of=future_quote),
    ).build("run_historical_quote_cutoff", MT, research_cutoff_at=cutoff)

    assert bundle["quote"] is None
    assert "quote" in bundle["data_quality"]["missing"]
    assert any(
        item["section"] == "quote"
        for item in bundle["data_quality"]["excluded_future"]
    )


async def test_future_kline_bars_do_not_enter_indicators(tmp_path):
    bars = _bars() + [
        KlineBar(date="2026-08-18", open=32, close=32, high=32, low=32, volume=1032),
        KlineBar(date="2026-08-19", open=999, close=999, high=999, low=999, volume=9999),
    ]
    bundle = await make_service(tmp_path, FakeProvider(bars=bars)).build(
        "run_kline_cutoff",
        MT,
        research_cutoff_at="2026-08-18T15:00:00+08:00",
    )
    assert bundle["kline_ref"]["last_date"] == "2026-08-18"
    assert bundle["kline_ref"]["bars"] == len(bars) - 1
    assert bundle["data_quality"]["excluded_future"]
    assert "kline" not in bundle["data_quality"]["missing"]
    assert bundle["indicators"]["ma5"] < 100


async def test_future_quote_is_excluded_and_marked(tmp_path):
    bundle = await make_service(
        tmp_path,
        FakeProvider(quote_as_of="2026-08-19T09:30:00+08:00"),
    ).build(
        "run_quote_cutoff",
        MT,
        research_cutoff_at="2026-08-18T15:00:00+08:00",
    )
    assert bundle["quote"] is None
    assert "quote" in bundle["data_quality"]["missing"]
    assert any(item["section"] == "quote" for item in bundle["data_quality"]["excluded_future"])


async def test_all_future_news_marks_news_missing(tmp_path):
    bundle = await make_service(
        tmp_path,
        FakeProvider(news_dates=["2026-08-19 09:30:00"], news_count=1),
    ).build(
        "run_all_future_news",
        MT,
        research_cutoff_at="2026-08-18T15:00:00+08:00",
    )
    assert bundle["news"] == []
    assert "news" in bundle["data_quality"]["missing"]


async def test_unknown_financial_public_time_degrades_historical_replay(tmp_path):
    bundle = await make_service(tmp_path, FakeProvider()).build(
        "run_unknown_fund",
        MT,
        research_cutoff_at="2026-08-18T15:00:00+08:00",
    )
    assert bundle["fundamentals"] is None
    assert any(item["section"] == "fundamentals" for item in bundle["data_quality"]["unknown_availability"])


# --- idempotency ---


async def test_build_writes_evidence_and_is_idempotent(tmp_path):
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    bundle = await svc.build("run1", MT, as_of=AS_OF)
    assert bundle["instrument"]["symbol"] == "600519"
    assert bundle["instrument"]["instrument_type"] == "equity"
    assert bundle["as_of"] == AS_OF
    # key report values are embedded in evidence.json
    assert bundle["quote"]["price"] == 1680.5
    assert bundle["quote"]["pe"] == 20.6
    assert bundle["quote"]["pb"] == 6.68
    assert bundle["indicators"]["swing"]["method"] == "swing-high-low-v1"
    assert bundle["indicators"]["swing"]["support"] == pytest.approx(10.5)
    assert bundle["indicators"]["swing"]["resistance"] == pytest.approx(30.5)
    assert bundle["indicators"]["ma20"] == pytest.approx(20.5)

    again = await svc.build("run1", MT, as_of=AS_OF)
    assert again == bundle
    assert provider.calls == {"quote": 1, "kline": 2, "fundamentals": 1, "news": 1}


async def test_second_instance_reads_from_disk(tmp_path):
    svc1 = make_service(tmp_path, FakeProvider())
    bundle = await svc1.build("run1", MT, as_of=AS_OF)

    provider2 = FakeProvider()
    svc2 = make_service(tmp_path, provider2)
    assert await svc2.build("run1", MT, as_of=AS_OF) == bundle
    assert provider2.calls == {"quote": 0, "kline": 0, "fundamentals": 0, "news": 0}
    assert svc2.read("run1", MT.id) == bundle


async def test_etf_skips_company_fundamentals_without_marking_missing(tmp_path):
    provider = FakeProvider()
    bundle = await make_service(tmp_path, provider).build("run1", ETF, as_of=AS_OF)
    assert bundle["fundamentals"] is None
    assert "fundamentals" not in bundle["data_quality"]["missing"]
    assert provider.calls == {"quote": 1, "kline": 2, "fundamentals": 0, "news": 1}


async def test_concurrent_builds_fetch_once(tmp_path):
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    b1, b2 = await asyncio.gather(
        svc.build("run1", MT, as_of=AS_OF), svc.build("run1", MT, as_of=AS_OF)
    )
    assert b1 == b2
    assert provider.calls["quote"] == 1


async def test_run_id_path_traversal_rejected(tmp_path):
    svc = make_service(tmp_path, FakeProvider())
    with pytest.raises(ValueError):
        await svc.build("../escape", MT, as_of=AS_OF)


# --- as_of / trading calendar ---


async def test_as_of_generated_from_trading_calendar(tmp_path):
    today = datetime(2026, 8, 14, 16, 0, tzinfo=CN_TZ)  # Friday, after close
    dates = ["2026-08-12", "2026-08-13", "2026-08-14"]
    bars = [
        KlineBar(date=d, open=1, close=1, high=1, low=1, volume=1) for d in dates
    ]
    svc = make_service(
        tmp_path, FakeProvider(bars=bars), clock=lambda: today
    )
    bundle = await svc.build("run1", MT)
    assert bundle["as_of"] == "2026-08-14T15:00:00+08:00"
    assert svc._trading_dates == set(dates)


async def test_as_of_before_close_uses_previous_trading_day(tmp_path):
    now = datetime(2026, 8, 14, 10, 0, tzinfo=CN_TZ)  # intraday
    bars = [
        KlineBar(date=d, open=1, close=1, high=1, low=1, volume=1)
        for d in ["2026-08-13", "2026-08-14"]
    ]
    svc = make_service(tmp_path, FakeProvider(bars=bars), clock=lambda: now)
    bundle = await svc.build("run1", MT)
    assert bundle["as_of"] == "2026-08-13T15:00:00+08:00"


@pytest.mark.parametrize(
    ("cutoff", "expected"),
    (
        # Explicit cutoff after the close uses that day's close, not 17:00.
        ("2026-08-18T17:00:00+08:00", "2026-08-18T15:00:00+08:00"),
        # Explicit intraday cutoff uses the previous completed trading close.
        ("2026-08-18T10:00:00+08:00", "2026-08-17T15:00:00+08:00"),
        # A non-trading-day cutoff uses the latest available prior close.
        ("2026-08-16T12:00:00+08:00", "2026-08-14T15:00:00+08:00"),
    ),
)
async def test_explicit_research_cutoff_derives_distinct_legacy_close(
    tmp_path, cutoff, expected
):
    bars = [
        KlineBar(date=d, open=1, close=1, high=1, low=1, volume=1)
        for d in ("2026-08-14", "2026-08-17", "2026-08-18")
    ]
    bundle = await make_service(tmp_path, FakeProvider(bars=bars)).build(
        f"run_cutoff_{cutoff[11:13]}",
        MT,
        research_cutoff_at=cutoff,
    )
    assert bundle["as_of"] == expected
    assert bundle["research_cutoff_at"] == cutoff
    assert bundle["as_of"] != bundle["research_cutoff_at"]
    assert parse_asia_datetime(bundle["market_as_of"]) <= parse_asia_datetime(cutoff)
    assert bundle["market_as_of"] != cutoff


async def test_explicit_cutoff_calendar_unavailable_is_not_fabricated(tmp_path):
    svc = make_service(tmp_path, FakeProvider(fail={"kline"}))
    with pytest.raises(TradingCalendarUnavailableError):
        await svc.build(
            "run_cutoff_calendar_missing",
            MT,
            research_cutoff_at="2026-08-18T17:00:00+08:00",
        )


async def test_calendar_unavailable_raises_no_weekday_fallback(tmp_path):
    # even on a weekday, calendar failure must not degrade to weekday logic
    monday = datetime(2026, 8, 17, 16, 0, tzinfo=CN_TZ)
    svc = make_service(
        tmp_path, FakeProvider(fail={"kline"}), clock=lambda: monday
    )
    with pytest.raises(TradingCalendarUnavailableError):
        await svc.build("run1", MT)


# --- trimming ---


async def test_trimming_and_sources_complete(tmp_path):
    svc = make_service(tmp_path, FakeProvider(news_count=8))
    bundle = await svc.build("run1", MT, as_of=AS_OF)
    assert len(bundle["news"]) == 5  # news_limit default
    assert all(len(n["summary"]) <= 200 for n in bundle["news"])
    # raw bars are NOT embedded; only a cache ref with hash
    ref = bundle["kline_ref"]
    assert all(not isinstance(v, list) for v in ref.values())
    assert "klines" not in json.dumps(bundle, ensure_ascii=False)
    assert ref["adjust"] == "qfq"
    assert ref["bars"] == 30
    assert ref["content_hash"].startswith("sha256:")
    # cache file exists and matches the recorded hash
    cache_file = tmp_path / "cache" / "kline" / ref["cache"]
    assert cache_file.exists()
    import hashlib

    assert ref["content_hash"] == "sha256:" + hashlib.sha256(
        cache_file.read_bytes()
    ).hexdigest()
    # sources complete: quote + kline + fundamentals + news(deduped by id)
    kinds = {s["url"].split("/")[2] for s in bundle["sources"]}
    assert kinds == {"quote", "kline", "fund", "news"}
    assert all(s["content_hash"].startswith("sha256:") for s in bundle["sources"])


# --- batch ---


async def test_batch_per_instrument_idempotent(tmp_path):
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    out = await svc.build_batch("run1", [MT, ETF], as_of=AS_OF)
    assert set(out) == {MT.id, ETF.id}
    quote_calls = provider.calls["quote"]
    assert quote_calls == 2
    out2 = await svc.build_batch("run1", [MT], as_of=AS_OF)
    assert set(out2) == {MT.id}
    assert provider.calls["quote"] == 2  # MT read from disk


async def test_batch_over_capacity_raises(tmp_path):
    svc = make_service(tmp_path, FakeProvider())
    instruments = [
        InstrumentRef(exchange="XSHG", symbol=f"6000{i:02d}") for i in range(21)
    ]
    with pytest.raises(BatchCapacityError):
        await svc.build_batch("run1", instruments, as_of=AS_OF)


# --- kline cache TTL cleanup (design §9) ---


async def test_cache_write_purges_expired_kline_files(tmp_path):
    """Writing a cache file purges siblings older than the TTL (§9)."""
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    kline_dir = tmp_path / "cache" / "kline"

    # An expired leftover from a previous run.
    stale = kline_dir / "XSHG_600000.json"
    kline_dir.mkdir(parents=True, exist_ok=True)
    stale.write_text("{}", encoding="utf-8")
    expired_ts = time.time() - (svc.kline_cache_ttl_days + 1) * 86400
    os.utime(stale, (expired_ts, expired_ts))

    # A fresh sibling written moments ago stays.
    fresh = kline_dir / "XSHE_000002.json"
    fresh.write_text("{}", encoding="utf-8")

    bundle = await svc.build("run_ttl", MT, as_of=AS_OF)
    ref = bundle["kline_ref"]
    assert (kline_dir / ref["cache"]).is_file()
    assert not stale.exists(), "expired cache file must be purged"
    assert fresh.exists(), "fresh cache file must survive"


async def test_cache_cleanup_failure_never_breaks_build(tmp_path):
    """Purge errors are logged and swallowed — the build still returns."""
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    kline_dir = tmp_path / "cache" / "kline"
    stale = kline_dir / "XSHG_600000.json"
    kline_dir.mkdir(parents=True, exist_ok=True)
    stale.write_text("{}", encoding="utf-8")
    expired_ts = time.time() - (svc.kline_cache_ttl_days + 1) * 86400
    os.utime(stale, (expired_ts, expired_ts))

    from unittest.mock import patch

    with patch(
        "mona.services.stock.evidence._purge_expired_kline_cache",
        side_effect=OSError("disk gone"),
    ):
        bundle = await svc.build("run_ttl2", MT, as_of=AS_OF)
    assert bundle["kline_ref"]["cache"]


# --- partial failure ---


async def test_partial_failure_marks_missing(tmp_path):
    provider = FakeProvider(fail={"fundamentals"})
    svc = make_service(tmp_path, provider)
    bundle = await svc.build("run1", MT, as_of=AS_OF)
    assert bundle["fundamentals"] is None
    assert "fundamentals" in bundle["data_quality"]["missing"]
    assert bundle["quote"]["price"] == 1680.5


async def test_decision_readiness_requires_core_and_derives_trade_metrics(tmp_path):
    """V5-B2: quote/kline/technical data are hard gates; enhancements are not."""
    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    ).build(
        "decision_readiness_ready", MT, as_of="2026-09-10T15:00:00+08:00"
    )

    readiness = bundle["decision_readiness"]
    assert readiness["status"] == "failed"
    assert readiness["horizons"]["short_term"]["status"] == "ready"
    assert "medium_industry_context_missing" in readiness["trade_ready"]["failure_reasons"]
    assert readiness["core"]["status"] == "ready"
    assert set(readiness["core"]["required"]) == {
        "quote",
        "kline",
        "technical_indicators",
    }
    # No market snapshot is available in this provider, but it cannot block
    # the short-term decision gate.
    assert readiness["enhanced"]["status"] == "degraded"

    metrics = bundle["derived_decision_metrics"]
    assert metrics["method_version"] == "decision-derived-v5-b2"
    assert metrics["source_ids"]
    assert metrics["as_of"]
    assert metrics["price_as_of"] == AS_OF
    assert metrics["kline_as_of"] == "2026-09-03T15:00:00+08:00"
    assert metrics["as_of"] == metrics["kline_as_of"]
    assert metrics["atr20"]["value"] > 0
    assert metrics["trend"]["value"] in {"up", "down", "sideways"}
    assert metrics["volatility"]["atr20_pct"] > 0
    assert metrics["swing"]["support"] is not None
    assert metrics["swing"]["resistance"] is not None
    assert metrics["stop_distance"]["value_pct"] > 0
    for item in (metrics["atr20"], metrics["trend"], metrics["volatility"], metrics["swing"], metrics["stop_distance"]):
        assert item["source_ids"]
        assert item["as_of"]
        assert item["method_version"]


async def test_decision_readiness_fails_when_core_kline_is_unavailable(tmp_path):
    bundle = await make_service(
        tmp_path, FakeProvider(bars=_bars(60), fail={"kline"})
    ).build("decision_readiness_failed", MT, as_of=AS_OF)

    readiness = bundle["decision_readiness"]
    assert readiness["status"] == "failed"
    assert readiness["core"]["status"] == "failed"
    assert "kline" in readiness["core"]["missing"]
    assert bundle["derived_decision_metrics"]["eligible_horizons"] == []
    assert bundle["derived_decision_metrics"]["generated_horizons"] == []


async def test_decision_readiness_fails_medium_and_long_without_latest_fundamentals(tmp_path):
    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fail={"fundamentals"}),
    ).build("decision_readiness_no_fundamentals", MT, as_of="2026-09-10T15:00:00+08:00")

    readiness = bundle["decision_readiness"]
    assert readiness["horizons"]["short_term"]["status"] == "ready"
    assert readiness["horizons"]["medium_term"]["status"] == "failed"
    assert readiness["horizons"]["long_term"]["status"] == "failed"
    assert "fundamentals" in readiness["horizons"]["medium_term"]["missing"]
    assert readiness["status"] == "failed"


async def test_decision_readiness_fails_long_without_valuation_basis(tmp_path):
    class NoValuationProvider(FakeProvider):
        async def quote(self, inst):
            return (await super().quote(inst)).model_copy(update={"pe": None, "pb": None})

    bundle = await make_service(
        tmp_path,
        NoValuationProvider(bars=_bars(60), fund_published_at=AS_OF),
    ).build("decision_readiness_no_valuation", MT, as_of="2026-09-10T15:00:00+08:00")

    readiness = bundle["decision_readiness"]
    assert readiness["horizons"]["short_term"]["status"] == "ready"
    assert readiness["horizons"]["medium_term"]["status"] == "failed"
    assert readiness["horizons"]["long_term"]["status"] == "failed"
    assert "valuation_basis" in readiness["horizons"]["long_term"]["missing"]
    assert readiness["status"] == "failed"


async def test_ready_bundle_contains_complete_v5_derived_plan_and_source_closure(tmp_path, monkeypatch):
    from mona.services.stock.evidence import EvidenceService
    from mona.services.stock.schemas import V5PositionPlan, V5TradingPlan

    def force_ready(bundle):
        as_of = bundle["derived_decision_metrics"]["as_of"]
        source_ids = list(bundle["derived_decision_metrics"]["source_ids"])
        horizons = {
            horizon: {
                "status": "ready",
                "required": [],
                "available": [],
                "missing": [],
                "failure_reasons": [],
            }
            for horizon in ("short_term", "medium_term", "long_term")
        }
        return {
            "status": "ready",
            "method_version": "test-v6",
            "as_of": as_of,
            "source_ids": source_ids,
            "core": {"status": "ready", "required": [], "available": [], "missing": [], "failure_reasons": []},
            "horizons": horizons,
            "research_ready": {"status": "ready", "failure_reasons": []},
            "trade_ready": {"status": "ready", "failure_reasons": [], "horizons": horizons},
            "enhanced": {"status": "available", "available": [], "missing": []},
        }

    monkeypatch.setattr(EvidenceService, "_decision_readiness", staticmethod(force_ready))
    service = make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    )
    bundle = await service.build(
        "decision_readiness_v5_plan", MT, as_of="2026-09-10T15:00:00+08:00"
    )

    assert bundle["decision_readiness"]["status"] == "ready"
    derived = bundle["derived_decision_metrics"]
    assert set(derived["horizons"]) == {"short_term", "medium_term", "long_term"}
    assert derived["price"]
    assert derived["atr20"]["value"]
    assert derived["swing"]["support"]
    assert derived["stop_distance"]["stop_loss"]
    evidence_source_ids = {item["id"] for item in bundle["sources"]}
    assert set(derived["source_ids"]) <= evidence_source_ids
    for item in derived["horizons"].values():
        V5TradingPlan.model_validate(item["trading_plan"])
        V5PositionPlan.model_validate(item["position_plan"])
        assert set(item["source_ids"]) <= evidence_source_ids
    again = await service.build(
        "decision_readiness_v5_plan", MT, as_of="2026-09-10T15:00:00+08:00"
    )
    assert again["derived_decision_metrics"] == derived


async def test_v5_plan_derivation_failure_marks_readiness_and_leaves_no_half_plan(
    tmp_path, monkeypatch
):
    def fail(*_args, **_kwargs):
        raise ValueError("synthetic V5 derivation failure")

    monkeypatch.setattr(evidence_module, "build_v6_derived_decision_metrics", fail)
    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    ).build("decision_readiness_v5_derivation_failure", MT, as_of="2026-09-10T15:00:00+08:00")

    readiness = bundle["decision_readiness"]
    assert readiness["status"] == "failed"
    assert "horizons" not in bundle["derived_decision_metrics"]


async def test_v6_research_ready_can_survive_trade_dimension_gaps(tmp_path):
    bundle = await make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    ).build("v6_trade_gates_missing_industry", MT, as_of="2026-09-10T15:00:00+08:00")

    readiness = bundle["decision_readiness"]
    assert readiness["research_ready"]["status"] == "ready"
    assert readiness["trade_ready"]["status"] == "failed"
    assert readiness["status"] == "failed"
    assert "medium_industry_context_missing" in readiness["trade_ready"]["failure_reasons"]
    assert readiness["research_ready"]["available_horizons"] == ["short_term", "long_term"]
    assert bundle["derived_decision_metrics"]["eligible_horizons"] == ["short_term"]
    assert set(bundle["derived_decision_metrics"]["horizons"]) == {"short_term"}


async def test_v6_research_horizons_are_independent(tmp_path):
    service = make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    )
    bundle = await service.build("v6_research_horizons", MT, as_of="2026-09-10T15:00:00+08:00")
    bundle["industry_context"] = {
        "status": "degraded",
        "target_industry": "食品饮料",
        "source_ids": ["src_industry"],
    }
    bundle["cycle_context"] = {
        "status": "degraded",
        "cycles": {"industry_supply_demand": {"status": "degraded", "source_ids": ["src_cycle"]}},
        "source_ids": ["src_cycle"],
    }
    bundle["company_quality"] = {
        "status": "degraded",
        "source_ids": ["src_fund"],
        "cashflow_quality": [],
    }
    readiness = service._decision_readiness(bundle)
    assert readiness["research_ready"]["status"] == "ready"
    assert set(readiness["research_ready"]["available_horizons"]) == {
        "short_term",
        "medium_term",
        "long_term",
    }
    assert readiness["trade_ready"]["status"] == "failed"


async def test_v6_policy_gate_applies_only_to_policy_sensitive_industry(tmp_path):
    service = make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    )
    base = await service.build("v6_policy_gate", MT, as_of="2026-09-10T15:00:00+08:00")
    base["industry_context"] = {
        "status": "available",
        "target_industry": "银行",
        "source_ids": ["src_industry"],
    }
    base["cycle_context"] = {
        "status": "available",
        "cycles": {
            "industry_supply_demand": {"status": "available", "source_ids": ["src_cycle"]},
            "company_earnings": {"status": "available", "source_ids": ["src_cycle"]},
        },
        "source_ids": ["src_cycle"],
    }
    base["policy_context"] = {"status": "missing", "source_ids": []}
    sensitive = service._decision_readiness(base)
    assert sensitive["horizons"]["medium_term"]["status"] == "failed"
    assert "medium_policy_context_missing" in sensitive["trade_ready"]["failure_reasons"]

    base["industry_context"]["target_industry"] = "食品饮料"
    nonsensitive = service._decision_readiness(base)
    assert nonsensitive["horizons"]["medium_term"]["status"] == "ready"


async def test_v6_long_gate_requires_core_financials_not_optional_lifecycle(tmp_path):
    service = make_service(
        tmp_path,
        FakeProvider(bars=_bars(60), fund_published_at=AS_OF),
    )
    bundle = await service.build("v6_long_gate", MT, as_of="2026-09-10T15:00:00+08:00")
    bundle["industry_context"] = {
        "status": "available",
        "target_industry": "食品饮料",
        "source_ids": ["src_industry"],
    }
    bundle["cycle_context"] = {
        "status": "available",
        "cycles": {
            "industry_supply_demand": {
                "status": "available",
                "source_ids": ["src_cycle"],
            },
            "company_earnings": {"status": "available", "source_ids": ["src_cycle"]},
        },
        "source_ids": ["src_cycle"],
    }
    bundle["fundamentals_history"] = [
        {
            "report_period": f"202{index}-12-31",
            "published_at": f"202{index + 1}-03-31T18:00:00+08:00",
            "metrics": {"net_profit": 100 + index, "operating_cashflow": 120 + index},
            "source_ids": [f"src_fund_{index}"],
        }
        for index in range(4, 8)
    ]
    bundle["company_quality"] = {
        "status": "available",
        "source_ids": [f"src_fund_{index}" for index in range(4, 8)],
        "missing_fields": [],
        "cashflow_quality": [
            {"net_profit": 100 + index, "operating_cashflow": 120 + index, "source_ids": [f"src_fund_{index}" ]}
            for index in range(4, 8)
        ],
    }
    bundle["valuation"] = {
        "status": "available",
        "trade_ready": True,
        "usable_method_count": 2,
        "cross_range": {"status": "available", "method_count": 2},
        "source_ids": ["src_valuation"],
    }
    readiness = service._decision_readiness(bundle)
    assert readiness["horizons"]["long_term"]["status"] == "ready"
    assert readiness["trade_ready"]["status"] == "ready"
    assert readiness["status"] == "ready"


async def test_v2_sections_are_deterministic_and_market_source_is_resolvable(tmp_path):
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows())
    bundle = await make_service(tmp_path, provider).build("v2_complete", MT, as_of=AS_OF)

    assert set(
        bundle
    ) >= {
        "market_regime", "industry_context", "policy_context", "cycle_context",
        "company_quality", "capital_positioning", "event_calendar", "tradeability",
        "evidence_coverage",
    }
    assert bundle["market_regime"]["status"] == "available"
    assert bundle["market_regime"]["breadth"]["advancing"] == 1
    assert bundle["industry_context"]["relative_change_pct"] == pytest.approx(1.115)
    assert bundle["industry_context"]["status"] == "degraded"
    assert "industry_benchmark" in bundle["industry_context"]["missing_fields"]
    assert bundle["policy_context"]["status"] == "missing"
    assert bundle["cycle_context"]["cycles"]["macro_liquidity"]["status"] == "missing"
    assert bundle["company_quality"]["status"] == "degraded"
    assert "financing_balance" in bundle["capital_positioning"]["optional_missing_fields"]
    assert "financing_balance" not in bundle["capital_positioning"]["missing_fields"]
    assert bundle["tradeability"]["liquidity_proxy"]["value"] == 1.2
    assert bundle["tradeability"]["status"] == "degraded"
    assert bundle["evidence_coverage"]["short_term"]["status"] == "insufficient_data"
    evidence_source_ids = {item["id"] for item in bundle["sources"]}
    for section in (
        "market_regime", "industry_context", "company_quality", "capital_positioning", "tradeability"
    ):
        assert set(bundle[section]["source_ids"]) <= evidence_source_ids
    assert all("source" not in item for item in bundle["sources"])
    assert provider.snapshot_calls == 1


async def test_tradeability_preserves_verified_risk_and_listing_fields(tmp_path):
    rows = _snapshot_rows()
    target_index = next(index for index, row in enumerate(rows) if row.instrument_id == MT.id)
    rows[target_index] = rows[target_index].model_copy(
        update={"is_st": True, "listing_days": 500}
    )
    bundle = await make_service(
        tmp_path,
        SnapshotProvider(snapshot_rows=rows),
    ).build("tradeability_facts", MT, as_of=AS_OF)

    tradeability = bundle["tradeability"]
    assert tradeability["risk_warning"] is True
    assert tradeability["is_st"] is True
    assert tradeability["listing_days"] == 500
    assert tradeability["exchange"] == "XSHG"
    assert tradeability["board"] is None
    assert tradeability["is_suspended"] is False
    assert tradeability["delisted"] is None
    assert tradeability["delisting"] is None
    assert tradeability["active_universe_member"] is True
    assert tradeability["active_universe_member_method"] == "complete-market-capture-current-quote-v1"
    assert tradeability["previous_close"] == pytest.approx(1680.5 / 1.0123)
    assert tradeability["previous_close_method"] == "price-change-reverse-v1"
    assert tradeability["execution_facts_projection"]["source_ids"] == tradeability["source_ids"]
    assert tradeability["source_ids"]


async def test_tradeability_falls_back_to_quote_and_profile_after_market_page_failure(tmp_path):
    bundle = await make_service(
        tmp_path,
        FailedMarketSnapshotProvider(),
    ).build("tradeability_quote_profile_fallback", POLY, as_of=AS_OF)

    quote = bundle["quote"]
    assert quote["amount"] == pytest.approx(4_315_997_278.03)
    assert quote["previous_close"] == pytest.approx(36.15)
    assert quote["turnover_rate"] == pytest.approx(11.44)
    assert quote["limit_up"] == pytest.approx(39.77)
    assert quote["limit_down"] == pytest.approx(32.54)
    assert quote["source_ids"]

    tradeability = bundle["tradeability"]
    assert tradeability["price"] == pytest.approx(34.57)
    assert tradeability["volume"] == pytest.approx(1_236_130)
    assert tradeability["amount"] == pytest.approx(4_315_997_278.03)
    assert tradeability["turnover_rate"] == pytest.approx(11.44)
    assert tradeability["previous_close"] == pytest.approx(36.15)
    assert tradeability["previous_close_method"] == "provided-market-or-quote-v1"
    assert tradeability["limit_up"] == pytest.approx(39.77)
    assert tradeability["limit_down"] == pytest.approx(32.54)
    assert tradeability["board"] == "深交所主板A股"
    assert tradeability["listing_date"] == "2010-05-18"
    assert tradeability["t_plus_one"] == "restricted"
    assert tradeability["t_plus_one_method"] == "a-share-equity-t-plus-one-rule-v1"
    assert "order_book_depth" in tradeability["optional_missing_fields"]
    assert "realized_slippage" in tradeability["optional_missing_fields"]
    assert "order_book_depth" not in tradeability["missing_fields"]
    assert tradeability["limit_up"] != pytest.approx(40.48)
    assert tradeability["limit_down"] != pytest.approx(39.03)
    assert tradeability["source_ids"]
    source_ids = {item["id"] for item in bundle["sources"]}
    assert set(tradeability["source_ids"]) <= source_ids


async def test_tradeability_uses_kline_listing_lower_bound_without_guessing_exact_age(tmp_path):
    bundle = await make_service(
        tmp_path,
        SnapshotProvider(snapshot_rows=_snapshot_rows()),
    ).build("tradeability_listing_lower_bound", MT, as_of=AS_OF)
    tradeability = bundle["tradeability"]
    assert tradeability["listing_days"] is None
    assert tradeability["listing_age_lower_bound_sessions"] >= 6
    assert tradeability["listing_age_lower_bound_method"] == "completed-kline-session-count-v1"


async def test_v2_real_dimensions_feed_all_three_horizons(tmp_path):
    class RichProvider(SnapshotProvider):
        async def fundamentals_history(self, inst, *, limit=12):
            rows = []
            for index, period in enumerate(("2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30")):
                rows.append(
                    Fundamentals(
                        instrument_id=inst.id,
                        instrument_type=inst.instrument_type,
                        report_period=period,
                        metrics={
                            "revenue_yoy": 12 - index,
                            "profit_yoy": 16 - index * 2,
                            "net_profit": 100 - index * 10,
                            "operating_cashflow": 110 - index * 8,
                            "roe": 10 - index,
                        },
                        source=SourceRecord.create(
                            provider="eastmoney",
                            url=f"https://example.com/fund/{period}",
                            body=period.encode(),
                            fields=["report_period", "profit_yoy", "operating_cashflow"],
                            published_at=f"{period[:4]}-{min(int(period[5:7]) + 1, 12):02d}-30",
                            period_end=period,
                        ),
                    )
                )
            return rows

        async def news(self, inst, *, limit=10):
            source = _src("fake://news/unlock")
            return [
                NewsItem(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    title="限售股将于2026年8月28日上市流通",
                    url="https://example.com/unlock",
                    published_at="2026-08-14 09:00:00",
                    summary="解禁安排",
                    source=source,
                )
            ]

    class OfficialResearch:
        async def search_documents(self, keyword, *, limit=5, include_explainers=False):
            source = SourceRecord.create(
                provider="gov.cn-policy-library",
                url=f"https://www.gov.cn/{keyword}",
                body=keyword.encode(),
                fields=["title", "published_at", "issuer", "document_id"],
                published_at="2026-08-01",
            )
            return [
                ResearchDocument(
                    title=f"{keyword}正式文件",
                    url=source.url,
                    published_at="2026-08-01",
                    issuer="国务院部门",
                    document_id="国文〔2026〕1号",
                    category="bumenfile",
                    summary="公开事实摘要",
                    source=source,
                )
            ]

    rows = _snapshot_rows()
    rows[1] = rows[1].model_copy(update={"pe": 20, "pb": 3})
    peer_source = rows[1].source
    rows.append(
        MarketSnapshot(
            instrument_id="XSHG:600809",
            symbol="600809",
            exchange="XSHG",
            industry="白酒",
            price=25,
            change_pct=0.5,
            volume=2000,
            amount=20000,
            turnover=20000,
            turnover_rate=2,
            pe=30,
            pb=5,
            observed_at=AS_OF,
            source_ids=[peer_source.id],
            source=peer_source,
        )
    )
    rows.append(
        MarketSnapshot(
            instrument_id="XSHG:600810",
            symbol="600810",
            exchange="XSHG",
            industry="白酒",
            price=28,
            change_pct=0.8,
            volume=2100,
            amount=21000,
            turnover=21000,
            turnover_rate=2.1,
            pe=40,
            pb=7,
            observed_at=AS_OF,
            source_ids=[peer_source.id],
            source=peer_source,
        )
    )
    provider = RichProvider(snapshot_rows=rows)
    service = make_service(tmp_path, provider, research_provider=OfficialResearch())
    bundle = await service.build("v2_rich", MT, as_of=AS_OF)

    assert bundle["policy_context"]["status"] == "degraded"
    assert "effective_from" in bundle["policy_context"]["missing_fields"]
    assert bundle["policy_context"]["documents"][0]["issuer"] == "国务院部门"
    assert bundle["cycle_context"]["cycles"]["macro_liquidity"]["status"] == "degraded"
    assert bundle["cycle_context"]["cycles"]["company_earnings"]["status"] == "available"
    assert bundle["company_quality"]["period_count"] == 4
    assert "multi_period_financials" not in bundle["company_quality"]["missing_fields"]
    valuation = bundle["company_quality"]["valuation_context"]
    assert valuation["pe"]["peer_count"] == 2
    assert valuation["pe"]["median"] == 35
    assert valuation["pb"]["peer_count"] == 2
    assert valuation["status"] == "available"
    assert "排除目标公司" in valuation["basis"]
    assert bundle["event_calendar"]["events"][0]["event_type"] == "share_unlock"
    assert bundle["event_calendar"]["events"][0]["event_date"] == "2026-08-28"
    assert bundle["event_calendar"]["status"] == "degraded"
    assert "event_type_coverage" in bundle["event_calendar"]["missing_fields"]
    assert bundle["capital_positioning"]["disclosure_signals"][0]["event_type"] == "share_unlock"
    assert bundle["evidence_coverage"]["short_term"]["status"] == "insufficient_data"
    assert bundle["evidence_coverage"]["medium_term"]["status"] == "degraded"
    assert bundle["evidence_coverage"]["long_term"]["status"] == "degraded"


async def test_valuation_with_one_other_peer_is_insufficient(tmp_path):
    rows = _snapshot_rows()
    rows[1] = rows[1].model_copy(update={"pe": 20, "pb": 3})
    peer_source = rows[1].source
    rows.append(_valuation_peer("600809", 30, 5, peer_source))

    bundle = await make_service(tmp_path, SnapshotProvider(snapshot_rows=rows)).build(
        "valuation_one_peer", MT, as_of=AS_OF
    )
    valuation = bundle["company_quality"]["valuation_context"]

    assert valuation["status"] == "missing"
    assert valuation["pe"] == {
        "value": 20.0,
        "peer_count": 1,
        "median": None,
        "percentile": None,
    }
    assert "peer_valuation" in bundle["company_quality"]["optional_missing_fields"]
    assert "peer_valuation" not in bundle["company_quality"]["missing_fields"]


async def test_valuation_excludes_negative_peer_values(tmp_path):
    rows = _snapshot_rows()
    rows[1] = rows[1].model_copy(update={"pe": 20, "pb": 3})
    peer_source = rows[1].source
    rows.extend([
        _valuation_peer("600809", 30, 5, peer_source),
        _valuation_peer("600810", 40, 7, peer_source),
        _valuation_peer("600811", -10, -2, peer_source),
    ])

    bundle = await make_service(tmp_path, SnapshotProvider(snapshot_rows=rows)).build(
        "valuation_negative_peer", MT, as_of=AS_OF
    )
    valuation = bundle["company_quality"]["valuation_context"]

    assert valuation["status"] == "available"
    assert valuation["pe"]["peer_count"] == 2
    assert valuation["pb"]["peer_count"] == 2
    assert valuation["pe"]["median"] == 35
    assert valuation["pb"]["median"] == 6


async def test_relative_benchmark_is_real_aligned_and_reused_in_batch(tmp_path):
    def bars(multiplier: float):
        return [
            KlineBar(
                date=(datetime(2026, 1, 1) + timedelta(days=index)).strftime("%Y-%m-%d"),
                open=100 + multiplier * index,
                close=100 + multiplier * index,
                high=101 + multiplier * index,
                low=99 + multiplier * index,
                volume=1000,
            )
            for index in range(130)
        ]

    class BenchmarkProvider(FakeProvider):
        benchmark_calls = 0

        async def kline(self, inst, *, limit=120):
            self.calls["kline"] += 1
            if inst.id == "XSHG:000985":
                self.benchmark_calls += 1
                source = SourceRecord.create(
                    provider="benchmark",
                    url="https://example.com/index/000985",
                    body=b"benchmark-000985",
                    fields=["date", "close"],
                    published_at="2026-05-10",
                )
                return KlineSeries(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    bars=bars(0.5),
                    source=source,
                )
            source = SourceRecord.create(
                provider="target",
                url=f"https://example.com/target/{inst.symbol}",
                body=inst.id.encode(),
                fields=["date", "close"],
                published_at="2026-05-10",
            )
            return KlineSeries(
                instrument_id=inst.id,
                instrument_type=inst.instrument_type,
                bars=bars(1.0),
                source=source,
            )

    provider = BenchmarkProvider()
    bundles = await make_service(tmp_path, provider).build_batch(
        "relative_benchmark_batch", [MT, ETF], as_of=AS_OF
    )
    assert provider.benchmark_calls == 1
    for bundle in bundles.values():
        relative = bundle["relative_benchmarks"]
        assert relative["status"] == "available"
        assert relative["benchmark"]["instrument_id"] == "XSHG:000985"
        assert [item["window"] for item in relative["windows"]] == [5, 20, 60, 120]
        assert all(item["status"] == "available" for item in relative["windows"])
        assert all(item["source_ids"] for item in relative["windows"])
        assert relative["market_as_of"] == "2026-05-10T15:00:00+08:00"
        assert bundle["evidence_coverage"]["sections"]["relative_benchmarks"]["status"] == "available"


async def test_v2_historical_cutoff_excludes_current_market_snapshot(tmp_path):
    provider = SnapshotProvider(
        snapshot_rows=_snapshot_rows(observed_at="2026-08-19T09:30:00+08:00")
    )
    bundle = await make_service(tmp_path, provider).build(
        "v2_historical_snapshot", MT, research_cutoff_at="2026-08-18T15:00:00+08:00"
    )

    assert bundle["market_regime"]["status"] == "missing"
    assert bundle["industry_context"]["status"] == "missing"
    assert bundle["tradeability"]["status"] == "degraded"
    assert any(
        item["section"] == "market_snapshot"
        for item in bundle["data_quality"]["excluded_future"]
    )
    market_source_ids = {
        item["id"] for item in bundle["sources"] if item["provider"] == "snapshot"
    }
    assert not market_source_ids
    assert bundle["evidence_coverage"]["short_term"]["status"] == "insufficient_data"


async def test_v2_sections_share_time_and_claim_contract(tmp_path):
    bundle = await make_service(
        tmp_path, SnapshotProvider(snapshot_rows=_snapshot_rows())
    ).build("v2_contract", MT, as_of=AS_OF)
    source_ids = {item["id"] for item in bundle["sources"]}
    for name in (
        "market_regime", "industry_context", "policy_context", "cycle_context",
        "company_quality", "capital_positioning", "event_calendar", "tradeability",
    ):
        section = bundle[name]
        assert {"status", "claim_type", "observed_at", "published_at", "period_end", "research_cutoff_at", "missing_fields", "source_ids"} <= set(section)
        assert section["research_cutoff_at"] == bundle["research_cutoff_at"]
        assert set(section["source_ids"]) <= source_ids


async def test_v2_batch_captures_full_market_snapshot_once(tmp_path):
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows(include_target=False))
    svc = make_service(tmp_path, provider)
    await svc.build_batch("v2_batch", [MT, ETF], as_of=AS_OF)
    assert provider.snapshot_calls == 1


async def test_v2_batch_does_not_refetch_when_all_symbols_exist(tmp_path):
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows())
    svc = make_service(tmp_path, provider)
    await svc.build_batch("v2_batch_cached", [MT, ETF], as_of=AS_OF)
    provider.calls = {key: 0 for key in provider.calls}
    provider.snapshot_calls = 0

    result = await svc.build_batch("v2_batch_cached", [MT, ETF], as_of=AS_OF)

    assert set(result) == {MT.id, ETF.id}
    assert provider.calls == {"quote": 0, "kline": 0, "fundamentals": 0, "news": 0}
    assert provider.snapshot_calls == 0


async def test_v2_batch_only_captures_snapshot_for_pending_symbols(tmp_path):
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows())
    svc = make_service(tmp_path, provider)
    await svc.build("v2_batch_partial", MT, as_of=AS_OF)
    provider.calls = {key: 0 for key in provider.calls}
    provider.snapshot_calls = 0

    await svc.build_batch("v2_batch_partial", [MT, ETF], as_of=AS_OF)

    assert provider.snapshot_calls == 0
    assert provider.calls == {"quote": 1, "kline": 2, "fundamentals": 0, "news": 1}


async def test_complete_market_snapshot_cache_reuses_same_observation_day(tmp_path):
    rows = _snapshot_rows()
    first_provider = SnapshotProvider(snapshot_rows=rows)
    first = make_service(tmp_path, first_provider)
    await first.build("market_cache_seed", MT, as_of=AS_OF)
    assert first_provider.snapshot_calls == 1

    cache_path = tmp_path / "cache" / "market_snapshot" / "2026-08-14.json"
    assert cache_path.is_file()
    cached_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cached_payload["complete"] is True
    assert cached_payload["expected_count"] == 2
    assert cached_payload["rows"][0]["source"]["id"] in cached_payload["rows"][0]["source_ids"]
    assert cached_payload["rows"][0]["observed_at"] == AS_OF

    second_provider = SnapshotProvider(snapshot_rows=[])
    second = make_service(tmp_path, second_provider)
    bundle = await second.build("market_cache_hit", ETF, as_of=AS_OF)

    assert second_provider.snapshot_calls == 0
    coverage = bundle["market_regime"]["coverage"]
    assert coverage["cache"]["status"] == "hit"
    assert coverage["cache"]["observation_date"] == "2026-08-14"
    assert coverage["cache"]["freshness"] == "same_trading_day"
    source_ids = set(bundle["market_regime"]["source_ids"])
    assert source_ids
    assert source_ids <= {item["id"] for item in bundle["sources"]}


async def test_market_snapshot_partial_failure_falls_back_only_to_same_day_cache(tmp_path):
    rows = _snapshot_rows()
    seed_provider = SnapshotProvider(snapshot_rows=rows)
    await make_service(tmp_path, seed_provider).build("market_cache_fallback_seed", MT, as_of=AS_OF)

    class PartialProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            self.snapshot_calls += 1
            raise MarketSnapshotIncompleteError(
                "page failed",
                rows=self.snapshot_rows,
                expected_count=5000,
                page_size=100,
                requested_limit=limit,
            )

    provider = PartialProvider(snapshot_rows=rows)
    service = make_service(tmp_path, provider)
    capture = await service._fetch_market_snapshot()

    assert provider.snapshot_calls == 1
    assert capture.complete is True
    assert capture.cache_info["status"] == "fallback"
    assert capture.cache_info["observation_date"] == "2026-08-14"
    assert capture.cache_info["fallback_reason"] == "provider_partial"
    assert capture[0].source.id in capture[0].source_ids


async def test_market_snapshot_cache_uses_previous_day_as_stale_fallback(tmp_path):
    rows = _snapshot_rows()

    class PartialProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            self.snapshot_calls += 1
            raise MarketSnapshotIncompleteError(
                "partial",
                rows=self.snapshot_rows,
                expected_count=5000,
                page_size=100,
                requested_limit=limit,
            )

    seed_provider = SnapshotProvider(snapshot_rows=rows)
    await make_service(tmp_path, seed_provider).build("market_cache_previous_day", MT, as_of=AS_OF)
    provider = PartialProvider(snapshot_rows=rows)
    service = make_service(tmp_path, provider)
    capture = await service._fetch_market_snapshot(target_date="2026-08-15")

    assert provider.snapshot_calls == 1
    assert capture.complete is False
    assert capture.cache_info["status"] == "fallback"
    assert capture.cache_info["observation_date"] == "2026-08-14"
    assert capture.cache_info["freshness"] == "prior_trading_day"
    assert capture.cache_info["fallback_reason"] == "provider_partial_prior_cache"
    assert not (tmp_path / "cache" / "market_snapshot" / "2026-08-15.json").exists()


async def test_data_quality_aggregates_derived_section_gaps(tmp_path):
    bundle = await make_service(tmp_path, FakeProvider()).build(
        "derived_quality_gap", MT, as_of=AS_OF
    )

    quality = bundle["data_quality"]
    assert "industry_context" in quality["derived_missing"]
    assert quality["status"] == "degraded"
    assert "industry_context" in quality["missing"]


async def test_industry_classification_uses_independent_profile_when_market_snapshot_missing(tmp_path):
    class ProfileProvider(FakeProvider):
        async def instrument_profile(self, inst):
            source = SourceRecord.create(
                provider="profile-cache",
                url=f"fake://profile/{inst.symbol}",
                body=b"profile",
                fields=["industry", "classification_scheme"],
                published_at=AS_OF,
            )
            return {
                "industry": "白酒",
                "classification_scheme": "公开行业分类",
                "industry_code": "F001",
                "observed_at": AS_OF,
                "source": source,
            }

    bundle = await make_service(tmp_path, ProfileProvider()).build(
        "independent_industry_profile", MT, as_of=AS_OF
    )

    industry = bundle["industry_context"]
    assert industry["target_industry"] == "白酒"
    assert industry["source_ids"]
    assert any(
        source["provider"] == "profile-cache" for source in bundle["sources"]
    )


async def test_independent_industry_valuation_survives_market_snapshot_failure(tmp_path):
    bundle = await make_service(
        tmp_path, IndependentValuationProvider()
    ).build("independent_valuation", POLY, as_of=AS_OF)

    valuation_context = bundle["company_quality"]["valuation_context"]
    assert valuation_context["status"] == "available"
    assert valuation_context["pe"]["peer_count"] == 3
    assert valuation_context["pb"]["peer_count"] == 3
    assert len(valuation_context["peer_companies"]) == 3
    assert bundle["valuation"]["methods"]["peer_pe"]["status"] == "available"
    assert bundle["valuation"]["relative_positions"]["pe"]["view"] != "暂不判断"
    assert bundle["valuation"]["assessment"]["view"] == "高估"
    assert any(
        source["provider"] == "industry-valuation"
        for source in bundle["sources"]
    )
    assert bundle["quote"]["amount"] == pytest.approx(4_315_997_278.03)
    assert bundle["tradeability"]["turnover_rate_pct"] == pytest.approx(11.44)
    assert bundle["tradeability"]["previous_close"] == pytest.approx(36.15)
    assert bundle["tradeability"]["limit_up"] == pytest.approx(39.77)
    assert bundle["tradeability"]["limit_down"] == pytest.approx(32.54)
    assert bundle["tradeability"]["t_plus_one"]


async def test_market_snapshot_failure_reuses_screening_database_with_provenance(tmp_path):
    rows = _snapshot_rows()
    seed_provider = SnapshotProvider(snapshot_rows=rows)
    service = make_service(tmp_path, seed_provider)
    await service._fetch_market_snapshot(target_date="2026-08-14")
    for path in (tmp_path / "cache" / "market_snapshot").glob("*.json"):
        path.unlink()

    class DownProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            self.snapshot_calls += 1
            raise ProviderError("snapshot down")

    capture = await make_service(tmp_path, DownProvider())._fetch_market_snapshot(
        target_date="2026-08-15"
    )

    assert capture.cache_info["freshness"] == "screening_cache"
    assert capture.cache_info["fallback_reason"] == "provider_failure_screening_cache"
    assert capture[0].source.id in capture[0].source_ids


async def test_corrupt_market_snapshot_cache_is_ignored_without_blocking(tmp_path):
    cache_dir = tmp_path / "cache" / "market_snapshot"
    cache_dir.mkdir(parents=True)
    (cache_dir / "2026-08-14.json").write_text("{broken", encoding="utf-8")
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows())
    service = make_service(tmp_path, provider)

    capture = await service._fetch_market_snapshot(target_date="2026-08-14")

    assert provider.snapshot_calls == 1
    assert capture.complete is True
    assert capture.cache_info["status"] == "live"
    assert json.loads((cache_dir / "2026-08-14.json").read_text(encoding="utf-8"))["complete"] is True


async def test_market_snapshot_effective_date_reuses_preopen_and_nontrading_cache(
    tmp_path,
):
    previous = "2026-08-19"
    rows = _snapshot_rows(observed_at=f"{previous}T15:00:00+08:00")
    seed_provider = SnapshotProvider(snapshot_rows=rows)
    seed = make_service(tmp_path, seed_provider)
    await seed._fetch_market_snapshot(target_date=previous)

    for cutoff, trading_dates in (
        (
            datetime(2026, 8, 20, 8, 45, tzinfo=CN_TZ),
            {previous, "2026-08-20"},
        ),
        (
            datetime(2026, 8, 22, 10, 0, tzinfo=CN_TZ),
            {previous, "2026-08-20"},
        ),
    ):
        provider = SnapshotProvider(snapshot_rows=[])
        service = make_service(tmp_path, provider, clock=lambda cutoff=cutoff: cutoff)
        service._trading_dates = trading_dates
        target_date = service._effective_market_snapshot_date(
            research_cutoff_at=cutoff,
            legacy_as_of=f"{previous}T15:00:00+08:00",
        )

        assert target_date == previous
        capture = await service._fetch_market_snapshot(target_date=target_date)
        assert capture.complete is True
        assert capture.cache_info["status"] == "hit"
        assert capture.cache_info["observation_date"] == previous
        assert provider.snapshot_calls == 0


async def test_market_snapshot_effective_date_switches_to_current_after_open(
    tmp_path,
):
    previous = "2026-08-19"
    current = "2026-08-20"
    seed_provider = SnapshotProvider(
        snapshot_rows=_snapshot_rows(observed_at=f"{previous}T15:00:00+08:00")
    )
    await make_service(tmp_path, seed_provider)._fetch_market_snapshot(
        target_date=previous
    )

    class PartialProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            self.snapshot_calls += 1
            raise MarketSnapshotIncompleteError(
                "current session is partial",
                rows=[],
                expected_count=2,
                page_size=1,
                requested_limit=limit,
            )

    provider = PartialProvider(snapshot_rows=[])
    service = make_service(
        tmp_path,
        provider,
        clock=lambda: datetime(2026, 8, 20, 10, 0, tzinfo=CN_TZ),
    )
    service._trading_dates = {previous, current}
    target_date = service._effective_market_snapshot_date(
        research_cutoff_at="2026-08-20T10:00:00+08:00",
        legacy_as_of=f"{previous}T15:00:00+08:00",
    )

    assert target_date == current
    capture = await service._fetch_market_snapshot(target_date=target_date)
    assert capture.complete is False
    assert capture.cache_info["status"] == "fallback"
    assert capture.cache_info["observation_date"] == previous
    assert capture.cache_info["freshness"] == "prior_trading_day"
    assert capture.cache_info["fallback_reason"] == "provider_partial_prior_cache"
    assert provider.snapshot_calls == 1


async def test_market_snapshot_effective_date_reuses_current_session_cache(tmp_path):
    current = "2026-08-20"
    seed_provider = SnapshotProvider(
        snapshot_rows=_snapshot_rows(observed_at=f"{current}T10:05:00+08:00")
    )
    await make_service(tmp_path, seed_provider)._fetch_market_snapshot(
        target_date=current
    )

    provider = SnapshotProvider(snapshot_rows=[])
    service = make_service(
        tmp_path,
        provider,
        clock=lambda: datetime(2026, 8, 20, 10, 30, tzinfo=CN_TZ),
    )
    service._trading_dates = {"2026-08-19", current}
    target_date = service._effective_market_snapshot_date(
        research_cutoff_at="2026-08-20T10:30:00+08:00",
        legacy_as_of="2026-08-19T15:00:00+08:00",
    )

    assert target_date == current
    capture = await service._fetch_market_snapshot(target_date=target_date)
    assert capture.complete is True
    assert capture.cache_info["status"] == "hit"
    assert capture.cache_info["observation_date"] == current
    assert provider.snapshot_calls == 0


async def test_build_context_reuses_effective_market_cache_across_instances(tmp_path):
    previous = "2026-08-19"
    current = "2026-08-20"
    calendar_bars = [
        KlineBar(date=day, open=1, close=1, high=1, low=1, volume=1)
        for day in (previous, current)
    ]

    seed_provider = SnapshotProvider(
        bars=calendar_bars,
        snapshot_rows=_snapshot_rows(observed_at=f"{previous}T15:00:00+08:00"),
    )
    seed = make_service(
        tmp_path,
        seed_provider,
        clock=lambda: datetime(2026, 8, 19, 16, 0, tzinfo=CN_TZ),
    )
    seeded = await seed.build_context("ctx_cacheintegration", MT)
    seeded_bundle = seeded["symbols"][MT.id]
    assert seed_provider.snapshot_calls == 1
    assert seeded_bundle["market_regime"]["coverage"]["cache"]["status"] == "live"

    preopen_provider = SnapshotProvider(bars=calendar_bars, snapshot_rows=[])
    preopen = make_service(
        tmp_path,
        preopen_provider,
        clock=lambda: datetime(2026, 8, 20, 8, 45, tzinfo=CN_TZ),
    )
    preopen_payload = await preopen.build_context("ctx_cachepreopen", MT)
    preopen_bundle = preopen_payload["symbols"][MT.id]
    preopen_cache = preopen_bundle["market_regime"]["coverage"]["cache"]
    assert preopen_provider.snapshot_calls == 0
    assert preopen_cache["status"] == "hit"
    assert preopen_cache["observation_date"] == previous

    nontrading_provider = SnapshotProvider(
        bars=[calendar_bars[0]],
        snapshot_rows=[],
    )
    nontrading = make_service(
        tmp_path,
        nontrading_provider,
        clock=lambda: datetime(2026, 8, 22, 10, 0, tzinfo=CN_TZ),
    )
    nontrading_payload = await nontrading.build_context("ctx_cachenontrade", MT)
    nontrading_bundle = nontrading_payload["symbols"][MT.id]
    nontrading_cache = nontrading_bundle["market_regime"]["coverage"]["cache"]
    assert nontrading_provider.snapshot_calls == 0
    assert nontrading_cache["status"] == "hit"
    assert nontrading_cache["observation_date"] == previous

    class IntradayPartialProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            self.snapshot_calls += 1
            raise MarketSnapshotIncompleteError(
                "current session is partial",
                rows=[],
                expected_count=2,
                page_size=1,
                requested_limit=limit,
            )

    intraday_provider = IntradayPartialProvider(bars=calendar_bars, snapshot_rows=[])
    intraday = make_service(
        tmp_path,
        intraday_provider,
        clock=lambda: datetime(2026, 8, 20, 10, 0, tzinfo=CN_TZ),
    )
    intraday_payload = await intraday.build_context("ctx_cacheintraday", MT)
    intraday_bundle = intraday_payload["symbols"][MT.id]
    intraday_cache = intraday_bundle["market_regime"]["coverage"]["cache"]
    assert intraday_provider.snapshot_calls == 1
    assert intraday_cache["status"] == "fallback"
    assert intraday_cache["observation_date"] == previous
    assert intraday_cache["freshness"] == "prior_trading_day"
    assert intraday_cache["fallback_reason"] == "provider_partial_prior_cache"


async def test_v2_market_snapshot_timeout_is_an_evidence_gap(tmp_path):
    class TimeoutProvider(FakeProvider):
        async def market_snapshot(self, *, limit=5000):
            raise TimeoutError("snapshot timeout")

    bundle = await make_service(tmp_path, TimeoutProvider()).build("v2_timeout", MT, as_of=AS_OF)
    assert bundle["market_regime"]["status"] == "missing"
    assert bundle["industry_context"]["status"] == "missing"
    assert bundle["market_regime"]["coverage"]["complete"] is False
    assert bundle["policy_context"]["status"] == "missing"
    assert bundle["evidence_coverage"]["short_term"]["status"] == "insufficient_data"


async def test_v2_formal_macro_policy_survives_snapshot_gap_without_m2_promotion(tmp_path):
    class MacroPolicyOnly:
        async def search_policy_documents(self, *, limit=5):
            source = SourceRecord.create(
                provider="gov.cn-policy-library",
                url="https://www.gov.cn/policy/2026",
                body=b"macro-policy",
                fields=["title", "published_at", "issuer", "document_id"],
                published_at="2026-08-01",
            )
            return [
                ResearchDocument(
                    title="货币政策正式文件",
                    url=source.url,
                    published_at="2026-08-01",
                    issuer="国务院部门",
                    document_id="国文〔2026〕2号",
                    category="gongwen",
                    summary="正式政策文件",
                    source=source,
                )
            ]

        async def search_documents(self, keyword, *, limit=5, include_explainers=False):
            return []

    bundle = await make_service(
        tmp_path,
        FakeProvider(),
        research_provider=MacroPolicyOnly(),
    ).build("v2_macro_policy_only", MT, as_of=AS_OF)

    policy = bundle["policy_context"]
    assert policy["status"] == "degraded"
    assert policy["industry_policy_documents"] == []
    assert policy["macro_regulatory_documents"]
    assert "industry_policy_documents" in policy["missing_fields"]
    assert all("M2" not in (item["title"] or "") for item in policy["documents"])


async def test_v2_macro_policy_filters_procedural_keyword_hits_but_keeps_relevant_documents(tmp_path):
    class MacroPolicySearch:
        def __init__(self, documents):
            self.documents = documents

        async def search_policy_documents(self, *, limit=5):
            return self.documents[:limit]

        async def search_documents(self, keyword, *, limit=5, include_explainers=False):
            return []

    def document(title, summary, suffix):
        source = SourceRecord.create(
            provider="gov.cn-policy-library",
            url=f"https://www.gov.cn/policy/{suffix}",
            body=suffix.encode(),
            fields=["title", "published_at", "issuer", "document_id"],
            published_at="2026-08-01",
        )
        return ResearchDocument(
            title=title,
            url=source.url,
            published_at="2026-08-01",
            issuer="国务院",
            document_id=f"国令〔2026〕{suffix}",
            category="gongwen",
            summary=summary,
            source=source,
        )

    irrelevant = document(
        "行政法规制定程序条例",
        "本条例规范行政法规制定程序；涉及外汇汇率、货币政策的确定以及公布后的施行。",
        "procedural",
    )
    relevant = document(
        "中国人民银行货币政策委员会2026年第二季度例会召开",
        "会议分析国内外经济金融形势，研究货币政策。",
        "monetary",
    )
    bundle = await make_service(
        tmp_path,
        FakeProvider(),
        research_provider=MacroPolicySearch([irrelevant, relevant]),
    ).build("v2_macro_policy_relevance", MT, as_of=AS_OF)

    policy = bundle["policy_context"]
    assert [item["title"] for item in policy["macro_policy_documents"]] == [relevant.title]
    assert policy["status"] == "degraded"
    assert any(
        item["title"] == irrelevant.title
        for item in bundle["data_quality"]["excluded_irrelevant_policy_documents"]
    )
    assert irrelevant.source.id not in {item["id"] for item in bundle["sources"]}


async def test_v2_macro_policy_with_only_irrelevant_documents_is_missing(tmp_path):
    class IrrelevantPolicySearch:
        async def search_policy_documents(self, *, limit=5):
            source = SourceRecord.create(
                provider="gov.cn-policy-library",
                url="https://www.gov.cn/policy/procedural-only",
                body=b"procedural-only",
                fields=["title", "published_at", "issuer", "document_id"],
                published_at="2026-08-01",
            )
            return [
                ResearchDocument(
                    title="行政法规制定程序条例",
                    url=source.url,
                    published_at="2026-08-01",
                    issuer="国务院",
                    document_id="国令〔2026〕838号",
                    category="gongwen",
                    summary="仅在程序性条文中提及货币政策。",
                    source=source,
                )
            ]

        async def search_documents(self, keyword, *, limit=5, include_explainers=False):
            return []

    bundle = await make_service(
        tmp_path,
        FakeProvider(),
        research_provider=IrrelevantPolicySearch(),
    ).build("v2_macro_policy_missing", MT, as_of=AS_OF)

    policy = bundle["policy_context"]
    assert policy["macro_policy_documents"] == []
    assert policy["status"] == "missing"
    assert "macro_regulatory_policy_documents" in policy["missing_fields"]


async def test_v2_event_without_scheduled_date_is_degraded_but_kept_as_risk_evidence(tmp_path):
    provider = FakeProvider(
        news_count=1,
        news_dates=["2026-08-14 09:00:00"],
    )
    bundle = await make_service(tmp_path, provider).build(
        "v2_event_without_date", MT, as_of=AS_OF
    )

    assert bundle["event_calendar"]["events"]
    assert bundle["event_calendar"]["events"][0]["event_date"] is None
    assert bundle["event_calendar"]["status"] == "degraded"
    assert "event_date" in bundle["event_calendar"]["missing_fields"]


async def test_structured_events_are_same_source_event_calendar_and_cutoff_safe(tmp_path):
    current = _structured_event()
    future = _structured_event(
        published_at="2026-08-14 16:00:00",
        title="未来公告",
        source_url="fake://event/future",
    )
    provider = StructuredEventProvider([current, future])
    bundle = await make_service(tmp_path, provider).build(
        "structured_event_calendar",
        MT,
        as_of=AS_OF,
    )

    events = bundle["event_calendar"]["events"]
    assert len(events) == 1
    assert events[0]["title"] == "回购公告"
    assert events[0]["source_ids"] == [current.source.id]
    assert bundle["event_calendar"]["capture"]["source"] == "structured_market_events"
    assert bundle["event_calendar"]["capture"]["complete"] is True
    source_ids = {source["id"] for source in bundle["sources"]}
    assert current.source.id in source_ids
    assert "未来公告" not in {event["title"] for event in events}
    assert provider.event_calls[0]["symbols"] == [MT.id]


async def test_structured_event_capture_partial_is_explicitly_degraded(tmp_path):
    provider = StructuredEventProvider([_structured_event()], complete=False)
    bundle = await make_service(tmp_path, provider).build(
        "structured_event_partial",
        MT,
        as_of=AS_OF,
    )
    assert bundle["event_calendar"]["capture"]["complete"] is False
    assert bundle["event_calendar"]["status"] == "degraded"
    assert bundle["event_calendar"]["capture"]["cache_status"] == "live"


async def test_v2_event_calendar_is_available_only_with_explicit_type_coverage(tmp_path):
    class CompleteEventProvider(FakeProvider):
        async def news(self, inst, *, limit=10):
            items = []
            for index, (_event_type, keywords) in enumerate(_EVENT_TYPES):
                source = _src(f"fake://events/{index}")
                items.append(
                    NewsItem(
                        instrument_id=inst.id,
                        instrument_type=inst.instrument_type,
                        title=f"{keywords[0]} 2026年8月{index + 1}日",
                        url=source.url,
                        published_at="2026-08-14 09:00:00",
                        summary="可核验事件",
                        source=source,
                    )
                )
            return items

    bundle = await make_service(
        tmp_path,
        CompleteEventProvider(),
        news_limit=len(_EVENT_TYPES),
    ).build("v2_event_type_coverage", MT, as_of=AS_OF)

    coverage = bundle["event_calendar"]["event_type_coverage"]
    assert coverage["complete"] is True
    assert coverage["missing_types"] == []
    assert bundle["event_calendar"]["status"] == "available"
    assert "event_type_coverage" not in bundle["event_calendar"]["missing_fields"]


async def test_v2_partial_market_snapshot_is_degraded_not_market_breadth(tmp_path):
    class PartialProvider(SnapshotProvider):
        async def market_snapshot(self, *, limit=5000):
            rows = _snapshot_rows()
            return MarketSnapshotCapture(
                rows,
                expected_count=5000,
                page_size=100,
                complete=False,
                error="page 3 failed",
            )

    bundle = await make_service(tmp_path, PartialProvider()).build(
        "v2_partial_snapshot", MT, as_of=AS_OF
    )
    assert bundle["market_regime"]["status"] == "degraded"
    assert bundle["industry_context"]["status"] == "degraded"
    coverage = bundle["market_regime"]["coverage"]
    assert coverage["expected_count"] == 5000
    assert coverage["loaded_count"] == 2
    assert coverage["coverage"] == pytest.approx(2 / 5000)
    assert coverage["complete"] is False
    assert "market_snapshot_complete" in bundle["market_regime"]["missing_fields"]
    assert bundle["evidence_coverage"]["short_term"]["status"] == "insufficient_data"
    assert bundle["tradeability"]["active_universe_member"] is None


async def test_promote_context_copies_immutable_bundle_without_refetch(tmp_path):
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    context_id = "ctx_promoteabc123"
    run_id = "run_promote"
    payload = await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"workflow_run_id": run_id},
    )
    calls = dict(provider.calls)
    expected = payload["symbols"][MT.id]

    promoted = await svc.promote_context(context_id, run_id, MT.id)
    assert promoted == expected
    assert svc.read(run_id, MT.id) == expected
    assert provider.calls == calls

    # A second promotion is an idempotent local read, not another write/fetch.
    assert await svc.promote_context(context_id, run_id, MT.id) == expected
    assert provider.calls == calls


async def test_promote_context_rejects_exact_instrument_mismatch(tmp_path):
    svc = make_service(tmp_path, FakeProvider())
    context_id = "ctx_promotemismatch"
    run_id = "run_promote_mismatch"
    await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"workflow_run_id": run_id},
    )

    with pytest.raises(ValueError, match="exact evidence"):
        await svc.promote_context(context_id, run_id, ETF.id)


async def test_unbound_preflight_context_binds_once_and_rejects_replay(tmp_path):
    provider = FakeProvider()
    svc = make_service(tmp_path, provider)
    context_id = "ctx_preflightbind"
    run_id = "run_preflight_bind"
    payload = await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"kind": "stock_preflight"},
    )
    calls = dict(provider.calls)

    assert await svc.promote_context(context_id, run_id, MT.id) == payload["symbols"][MT.id]
    assert svc.read_context(context_id)["owner"] == {
        "kind": "stock_preflight",
        "workflow_run_id": run_id,
    }
    assert provider.calls == calls
    assert await svc.promote_context(context_id, run_id, MT.id) == payload["symbols"][MT.id]
    assert provider.calls == calls

    with pytest.raises(ValueError, match="does not belong"):
        await svc.promote_context(context_id, "run_preflight_replay", MT.id)


async def test_unbound_preflight_context_rejects_instrument_mismatch_before_binding(tmp_path):
    svc = make_service(tmp_path, FakeProvider())
    context_id = "ctx_preflightmismatch"
    await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"kind": "stock_preflight"},
    )

    with pytest.raises(ValueError, match="exact evidence"):
        await svc.promote_context(context_id, "run_preflight_mismatch", ETF.id)
    assert svc.read_context(context_id)["owner"] == {"kind": "stock_preflight"}


async def test_unbound_preflight_context_cross_instance_race_has_one_winner(tmp_path):
    builder = make_service(tmp_path, FakeProvider())
    context_id = "ctx_preflightrace"
    await builder.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"kind": "stock_preflight"},
    )
    first = make_service(tmp_path, None)
    second = make_service(tmp_path, None)

    async def consume(service, run_id):
        try:
            await service.promote_context(context_id, run_id, MT.id)
            return run_id, None
        except Exception as exc:  # one contender must lose the owner race
            return run_id, exc

    results = await asyncio.gather(
        consume(first, "run_preflight_race_a"),
        consume(second, "run_preflight_race_b"),
    )
    winners = [(run_id, error) for run_id, error in results if error is None]
    losers = [(run_id, error) for run_id, error in results if error is not None]
    assert len(winners) == 1
    assert len(losers) == 1
    winner_id = winners[0][0]
    loser_id, loser_error = losers[0]
    assert "does not belong" in str(loser_error)

    context = first.read_context(context_id)
    assert context["owner"]["workflow_run_id"] == winner_id
    assert first.read(winner_id, MT.id) == context["symbols"][MT.id]
    assert first.read(loser_id, MT.id) is None


async def test_preflight_context_lock_timeout_is_explicit(tmp_path, monkeypatch):
    svc = make_service(tmp_path, FakeProvider())
    context_id = "ctx_preflighttimeout"
    await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"kind": "stock_preflight"},
    )

    class BusyLock:
        def __init__(self, path, *, timeout):
            self.path = path
            self.timeout = timeout

        def __enter__(self):
            raise FileLockTimeout(self.path)

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(evidence_module, "FileLock", BusyLock)
    with pytest.raises(RuntimeError, match="lock timeout"):
        await svc.promote_context(context_id, "run_preflight_timeout", MT.id)


async def test_promote_context_rejects_conflicting_existing_bundle(tmp_path):
    svc = make_service(tmp_path, FakeProvider())
    context_id = "ctx_promoteconflict"
    run_id = "run_promote_conflict"
    payload = await svc.build_context(
        context_id,
        MT,
        as_of=AS_OF,
        owner={"workflow_run_id": run_id},
    )
    path = svc._evidence_path(run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    original = {"run_id": run_id, "symbols": {MT.id: {"different": True}}}
    path.write_text(json.dumps(original), encoding="utf-8")

    with pytest.raises(ValueError, match="conflicting evidence bundle"):
        await svc.promote_context(context_id, run_id, MT.id)
    assert json.loads(path.read_text(encoding="utf-8")) == original
    assert payload["symbols"][MT.id] != original["symbols"][MT.id]


async def test_market_intelligence_sections_attach_without_optional_opinion_block(tmp_path):
    provider = SnapshotProvider(snapshot_rows=_snapshot_rows())
    bundle = await make_service(tmp_path, provider).build(
        "run_market_intelligence",
        MT,
        research_cutoff_at=AS_OF,
    )
    assert bundle["market_sentiment"]["algorithm_version"] == "market-sentiment-v1"
    assert bundle["public_opinion"]["status"] == "unavailable"
    assert bundle["public_opinion"]["decision_impact"] == "暂无公开舆论覆盖，本项不参与决策"
    assert "public_opinion" in bundle["data_quality"]["optional_derived_missing"]
    assert "public_opinion" not in bundle["data_quality"]["missing"]
    assert bundle["evidence_coverage"]["sections"]["public_opinion"]["status"] == "unavailable"
