"""Delivery-level acceptance for the selection-to-Alpha feedback loop.

This test deliberately drives the real screening service with a frozen,
point-in-time universe.  It does not lower the production promotion gate and
it never reconstructs a historical universe from a later snapshot.
"""

from __future__ import annotations

import asyncio
import math
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from mona.services.stock.calibration_cohort import (
    CalibrationCohortStore,
    build_validation_records,
)
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import InstrumentRef, KlineBar, KlineSeries
from mona.services.stock.quant_validation import PromotionGate
from mona.services.stock.screening import (
    MarketSnapshot,
    RankingFactor,
    SelectionStrategy,
    StockScreeningService,
)
from mona.services.stock.v6_tracking import (
    append_v6_observation,
    build_v6_tracking_snapshot,
    calculate_v6_observations,
    ensure_v6_tracking_snapshot,
    read_v6_observations,
)

DATA_START = date(2023, 1, 1)
COHORT_START = date(2024, 1, 1)
COHORT_DATES = [COHORT_START + timedelta(days=30 * index) for index in range(12)]
INSTRUMENTS = [f"XSHG:{600000 + index:06d}" for index in range(30)]


def _source(provider: str, key: str, fields: list[str]) -> SourceRecord:
    return SourceRecord.create(
        provider=provider,
        url=f"https://fixture.example/{provider}/{key}",
        body=f"{provider}:{key}".encode(),
        fields=fields,
    )


def _all_dates() -> list[date]:
    return [DATA_START + timedelta(days=index) for index in range(1000)]


def _close_path(index: int) -> list[KlineBar]:
    """A deterministic signal path with small date-varying noise.

    The 20-day momentum ranks mostly follow ``index`` while the forward ten
    day return contains enough independent noise for a real IC standard
    deviation.  No value is generated from a later cohort's factor.
    """
    price = 80.0 + index * 0.2
    bars: list[KlineBar] = []
    for day_index, day in enumerate(_all_dates()):
        if day_index:
            signal = 0.00030 * index
            noise = 0.00400 * math.sin(day_index * 0.71 + index * 1.37)
            price *= 1.00035 + signal + noise
        bars.append(
            KlineBar(
                date=day.isoformat(),
                open=price * 0.999,
                close=price,
                high=price * 1.002,
                low=price * 0.998,
                volume=1_000_000 + index * 10_000,
            )
        )
    return bars


class _AlphaFixtureProvider:
    """Point-in-time provider: short requests stop at the run cutoff."""

    def __init__(self) -> None:
        self.current_as_of = COHORT_DATES[0]
        self.calls: list[tuple[str, str, int]] = []
        self._bars = {instrument_id: _close_path(index) for index, instrument_id in enumerate(INSTRUMENTS)}
        self._benchmark = self._build_benchmark()

    @staticmethod
    def _build_benchmark() -> list[KlineBar]:
        return [
            KlineBar(
                date=day.isoformat(),
                open=100.0,
                close=100.0 + day_index * 0.02,
                high=100.1 + day_index * 0.02,
                low=99.9 + day_index * 0.02,
                volume=10_000_000,
            )
            for day_index, day in enumerate(_all_dates())
        ]

    async def kline(self, inst: InstrumentRef, *, limit: int = 120) -> KlineSeries:
        self.calls.append(("kline", inst.id, limit))
        if inst.instrument_type == "index":
            bars = self._benchmark
            source = _source("fixture-benchmark", "000985", ["date", "close"])
        else:
            bars = self._bars[inst.id]
            source = _source("fixture-kline", inst.symbol, ["date", "close"])
        # Screening enrichment must obey the requested point-in-time cutoff;
        # cohort maturation is the only path allowed to request the full path.
        if limit <= 120:
            bars = [bar for bar in bars if date.fromisoformat(bar.date) <= self.current_as_of][-limit:]
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=bars,
            source=source,
        )


def _strategy() -> SelectionStrategy:
    return SelectionStrategy(
        strategy_id="fixture_short_alpha",
        name="固定短线阿尔法验证",
        source="user",
        horizon="short_term",
        ranking=[RankingFactor(field="momentum20", direction="desc", weight=1.0)],
        limit=30,
    )


def _universe(provider: _AlphaFixtureProvider, as_of: date) -> list[MarketSnapshot]:
    rows: list[MarketSnapshot] = []
    for index, instrument_id in enumerate(INSTRUMENTS):
        exchange, symbol = instrument_id.split(":", 1)
        close = next(bar.close for bar in provider._bars[instrument_id] if bar.date == as_of.isoformat())
        source = _source("fixture-quote", symbol, ["price", "observed_at"])
        rows.append(
            MarketSnapshot(
                instrument_id=instrument_id,
                symbol=symbol,
                exchange=exchange,
                name=f"测试股票{index + 1}",
                industry="固定测试行业",
                price=close,
                change_pct=0.1,
                volume=1_000_000 + index * 10_000,
                turnover=10_000_000 + index * 100_000,
                pe=10.0 + index / 10,
                pb=1.0 + index / 100,
                listing_days=2000,
                as_of=as_of.isoformat(),
                observed_at=as_of.isoformat(),
                source_ids=[source.id],
                source=source,
            )
        )
    return rows


def _v6_report(selection: dict[str, Any], *, as_of: date, instrument_id: str) -> dict[str, Any]:
    promotion = selection.get("dataQuality") or selection["data_quality"]
    metrics = promotion["validation_metrics"]
    calibrated = {
        "status": promotion["promotion_status"],
        "promotionStatus": promotion["promotion_status"],
        "eligibleForTrading": promotion["eligible_for_trading"],
        "reason": promotion["promotion_reason"],
        "metrics": metrics,
        "strategyHorizon": promotion["strategy_horizon"],
        "calibratedHorizon": promotion["calibrated_horizon"],
    }
    horizons = {
        horizon: {"promotionStatus": calibrated["promotionStatus"], "metrics": metrics}
        for horizon in ("short_term", "medium_term", "long_term")
    }
    return {
        "schema_version": 6,
        "report_id": "report_fixture_alpha",
        "workflow_run_id": "run_fixture_alpha",
        "instrument": {"exchange": "XSHG", "symbol": instrument_id.split(":", 1)[1], "name": "测试股票1"},
        "current_price": 80.0,
        "benchmark_price": 100.0,
        "research_cutoff_at": as_of.isoformat(),
        "market_as_of": as_of.isoformat(),
        "decision_mode": "research_only",
        "research_status": "ready",
        "trade_status": "research_only",
        "quant_promotion": {**calibrated, "horizons": horizons},
        "horizon_decisions": {
            horizon: {
                "direction": "positive",
                "action": "research_only",
                "research_status": "ready",
                "trade_status": "research_only",
                "source_ids": [],
            }
            for horizon in ("short_term", "medium_term", "long_term")
        },
        "method_versions": {"quant": "rolling-oos-factor-v1"},
        "source_ids": [],
        "price_source_ids": [],
    }


def test_full_alpha_loop_is_point_in_time_idempotent_and_tracked(tmp_path: Path) -> None:
    provider = _AlphaFixtureProvider()
    service = StockScreeningService(provider=provider, root=tmp_path / "screening", workspace=tmp_path)
    strategy = _strategy()
    reports: list[dict[str, Any]] = []

    for as_of in COHORT_DATES:
        provider.current_as_of = as_of
        reports.append(
            asyncio.run(
                service.run(
                    strategy,
                    run_id=f"fixture-{as_of.isoformat()}",
                    universe=_universe(provider, as_of),
                    as_of=as_of.isoformat(),
                )
            )
        )

    latest = reports[-1]
    quality = latest.get("dataQuality") or latest["data_quality"]
    wrapped = {
        item: [{"date": bar.date, "close": bar.close, "source_ids": ["fixture-kline"]} for bar in bars]
        for item, bars in provider._bars.items()
    }
    assert quality["promotion_status"] == "calibrated"
    assert quality["eligible_for_trading"] is True
    assert quality["validation_metrics"]["oosPeriods"] >= PromotionGate().min_oos_periods
    assert quality["validation_metrics"]["sampleCount"] >= PromotionGate().min_oos_samples

    cohorts_path = tmp_path / "stock_projects" / "calibration_cohorts.db"
    assert cohorts_path.is_file()
    cohorts = CalibrationCohortStore(tmp_path).list(strategy.strategy_id)
    assert len(cohorts) == len(COHORT_DATES)
    assert all(item["sample_scope"] == "full_eligible_universe" for item in cohorts)
    assert all(item["validation_windows"] == [10, 60, 120] for item in cohorts)

    # Screening's short-term strategy consumes only its 10-session period;
    # the 60/120-session records remain available in the frozen cohort but do
    # not enter this validation sample.
    assert quality["strategy_horizon"] == "short_term"
    assert quality["validation_metrics"]["sampleCount"] == 90

    # A retry returns the immutable report without provider work or another
    # cohort/observation write.
    calls_before = list(provider.calls)
    retry = asyncio.run(
        service.run(
            strategy,
            run_id=f"fixture-{COHORT_DATES[-1].isoformat()}",
            universe=_universe(provider, COHORT_DATES[-1]),
            as_of=COHORT_DATES[-1].isoformat(),
        )
    )
    assert retry == latest
    assert provider.calls == calls_before
    assert len(CalibrationCohortStore(tmp_path).list(strategy.strategy_id)) == len(COHORT_DATES)

    # Future bars are used only after the frozen factor date.  A pre-cutoff
    # bar cannot change the mature result, and every accepted record points
    # strictly into the future.
    first_cohort = cohorts[0]
    result = build_validation_records(
        first_cohort,
        benchmark_bars=provider._benchmark,
        source_ids=[_source("fixture-benchmark", "000985", ["close"]).id],
        instrument_bars=wrapped,
    )
    assert result["status"] == "complete"
    assert result["records"]
    assert all(row["window"] in {10, 60, 120} for row in result["records"])
    assert all(row["outcome_as_of"] > row["as_of"] for row in result["records"])
    pre_cutoff = {
        item: [
            {"date": "2023-12-31", "close": 9_999_999.0, "source_ids": ["fixture-kline"]},
            *bars,
        ]
        for item, bars in wrapped.items()
    }
    assert build_validation_records(
        first_cohort,
        benchmark_bars=provider._benchmark,
        source_ids=[_source("fixture-benchmark", "000985", ["close"]).id],
        instrument_bars=pre_cutoff,
    )["records"] == result["records"]

    # V6 keeps all three horizon rows, but each row is a separate outcome
    # key and the append path is immutable/idempotent.
    report = _v6_report(latest, as_of=COHORT_DATES[0], instrument_id=INSTRUMENTS[0])
    run_dir = tmp_path / "v6-run"
    snapshot = build_v6_tracking_snapshot(report)
    assert snapshot is not None
    assert snapshot["quantPromotion"]["promotionStatus"] == "calibrated"
    assert ensure_v6_tracking_snapshot(run_dir, report) == ensure_v6_tracking_snapshot(run_dir, report)
    observations = calculate_v6_observations(
        snapshot,
        provider._bars[INSTRUMENTS[0]],
        provider._benchmark,
        windows=(10,),
        calculated_at="2025-01-01T00:00:00+00:00",
    )
    assert len(observations) == 3
    assert {row["horizon"] for row in observations} == {"short_term", "medium_term", "long_term"}
    assert all(row["status"] == "available" for row in observations)
    assert sum(append_v6_observation(run_dir, row) for row in observations) == 3
    assert sum(append_v6_observation(run_dir, row) for row in observations) == 0
    assert len(read_v6_observations(run_dir, snapshot["trackingId"])) == 3
