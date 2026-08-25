"""Fixed cross-section fixtures for standard AI-diagnosis factors."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from pathlib import Path

from mona.services.stock.diagnosis_quant import (
    build_diagnosis_quant_payload,
    ensure_diagnosis_cross_section_cache,
)
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import Fundamentals, InstrumentRef, KlineBar, KlineSeries
from mona.services.stock.screening import MarketSnapshot

AS_OF = "2026-08-24T15:00:00+08:00"
TARGET = "XSHG:600000"


def _fixture() -> tuple[dict, list[dict], dict[str, dict]]:
    ids = [f"XSHG:{600000 + index:06d}" for index in range(30)]
    rows: list[dict] = []
    factors: dict[str, dict] = {}
    for index, instrument_id in enumerate(ids):
        rows.append(
            {
                "instrument_id": instrument_id,
                "industry": "固定行业" if index < 5 else "其他行业",
                "instrument_type": "equity",
                "listing_days": 2_000,
                "volume": 1_000_000 + index,
                "turnover": 10_000_000 + index,
                "pe": 10 + index / 10,
                "pb": 1 + index / 100,
            }
        )
        factors[instrument_id] = {
            "as_of": AS_OF,
            "factors": {
                "momentum20": index,
                "momentum60": index * 2,
                "volatility20": index / 10 + 1,
                "revenue_yoy": index + 1,
                "profit_yoy": index + 2,
                "roe": index + 3,
                "roic": index + 4,
                "operating_cashflow": index + 100,
                "debt_ratio": 100 - index,
                "eps": index + 1,
            },
        }
    bundle = {
        "instrument": {"exchange": "XSHG", "symbol": "600000"},
        "market_as_of": AS_OF,
        "industry_context": {"industry": "固定行业"},
        "quote": {
            "volume": 1_000_000,
            "turnover": 10_000_000,
            "pe": 10,
            "pb": 1,
            "source_ids": ["quote-source"],
        },
        "fundamentals": {
            "metrics": {
                "revenue_yoy": 1,
                "profit_yoy": 2,
                "roe": 3,
                "roic": 4,
                "operating_cashflow": 100,
                "debt_ratio": 100,
                "eps": 1,
            },
            "source_ids": ["fundamental-source"],
        },
        "derived_decision_metrics": {
            "momentum": {
                "momentum20_pct": 0,
                "momentum60_pct": 0,
                "source_ids": ["kline-source"],
            },
            "volatility": {"return_std20_pct": 1, "source_ids": ["kline-source"]},
        },
        "tradeability": {"turnover_rate_pct": 10, "source_ids": ["quote-source"]},
        "sources": [{"id": item} for item in ("quote-source", "fundamental-source", "kline-source")],
    }
    return bundle, rows, factors


def test_full_market_and_industry_emit_deterministic_three_horizon_analysis() -> None:
    bundle, rows, factors = _fixture()
    first = build_diagnosis_quant_payload(
        bundle, TARGET, market_rows=rows, cached_factors=factors, cache_status="fixture"
    )
    second = build_diagnosis_quant_payload(
        bundle, TARGET, market_rows=rows, cached_factors=factors, cache_status="fixture"
    )
    assert first == second
    assert first is not None
    for horizon in ("short_term", "medium_term", "long_term"):
        view = first["quant_validation"]["horizons"][horizon]
        assert view["validation_status"] == "descriptive"
        assert view["composite_score"] is not None
        assert view["market_percentile"] is not None
        assert view["industry_percentile"] is not None
        assert view["factor_contributions"]
        assert view["market_sample_count"] == 30
        assert view["industry_sample_count"] == 5
        assert view["method_versions"]["descriptive"]
    assert first["quant_validation"]["quant_signal"] != "insufficient_data"
    assert first["quant_snapshot"]["validation_metrics"]["oosPeriods"] == 0


def test_small_industry_explicitly_falls_back_to_market() -> None:
    bundle, rows, factors = _fixture()
    for row in rows[2:]:
        row["industry"] = "其他行业"
    payload = build_diagnosis_quant_payload(
        bundle, TARGET, market_rows=rows, cached_factors=factors
    )
    assert payload is not None
    assert all(
        view["scope"] == "market_fallback"
        and view["industry_sample_count"] == 2
        and view["industry_percentile"] is None
        for view in payload["quant_validation"]["horizons"].values()
    )


def test_single_target_is_unavailable_and_never_default_neutral() -> None:
    bundle, _rows, _factors = _fixture()
    payload = build_diagnosis_quant_payload(bundle, TARGET, market_rows=[])
    assert payload is not None
    assert payload["quant_validation"]["quant_signal"] == "insufficient_data"
    assert all(
        view["signal"] == "unavailable"
        and view["composite_score"] is None
        and view["quant_signal"] == "insufficient_data"
        for view in payload["quant_validation"]["horizons"].values()
    )


def test_missing_target_factor_is_explicit() -> None:
    bundle, rows, factors = _fixture()
    broken = deepcopy(bundle)
    broken["derived_decision_metrics"]["momentum"].pop("momentum20_pct")
    payload = build_diagnosis_quant_payload(
        broken, TARGET, market_rows=rows, cached_factors=factors
    )
    assert payload is not None
    assert "momentum20" in payload["quant_snapshot"]["data_quality"]["missing_factor_fields"]
    assert payload["quant_validation"]["horizons"]["short_term"]["signal"] == "unavailable"


class _CacheFixtureProvider:
    def __init__(self) -> None:
        source = SourceRecord.create(
            provider="fixture",
            url="https://fixture.example/market",
            body=b"market",
            fields=["price", "as_of"],
        )
        self.source = source
        self.market_calls = 0
        self.rows = [
            MarketSnapshot(
                instrument_id=f"XSHG:{600000 + index:06d}",
                symbol=f"{600000 + index:06d}",
                exchange="XSHG",
                name=f"fixture-{index}",
                industry="固定行业" if index < 5 else "其他行业",
                price=10 + index,
                volume=1_000_000 + index,
                turnover=10_000_000 + index,
                pe=10 + index / 10,
                pb=1 + index / 100,
                listing_days=2_000,
                as_of=AS_OF,
                observed_at=AS_OF,
                source_ids=[source.id],
                source=source,
            )
            for index in range(30)
        ]

    async def market_snapshot(self, *, limit: int = 5000):
        self.market_calls += 1
        return self.rows[:limit]

    async def kline(self, inst: InstrumentRef, *, limit: int = 120) -> KlineSeries:
        bars = [
            KlineBar(
                date=f"2026-05-{index + 1:02d}",
                open=10 + index,
                close=10 + index,
                high=10 + index,
                low=10 + index,
                volume=1_000_000,
            )
            for index in range(60)
        ]
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=bars,
            source=self.source,
        )

    async def fundamentals(self, inst: InstrumentRef) -> Fundamentals:
        return Fundamentals(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            report_period="2026Q2",
            metrics={
                "revenue_yoy": 10.0,
                "profit_yoy": 10.0,
                "roe": 10.0,
                "roic": 8.0,
                "operating_cashflow": 100.0,
                "debt_ratio": 40.0,
                "eps": 1.0,
            },
            source=self.source,
        )


def test_missing_cache_builds_once_then_reuses_same_day_snapshot(tmp_path: Path) -> None:
    provider = _CacheFixtureProvider()
    first = asyncio.run(
        ensure_diagnosis_cross_section_cache(
            provider=provider,
            cache_root=tmp_path / "cache",
            workspace=tmp_path,
            as_of=AS_OF,
        )
    )
    second = asyncio.run(
        ensure_diagnosis_cross_section_cache(
            provider=provider,
            cache_root=tmp_path / "cache",
            workspace=tmp_path,
            as_of=AS_OF,
        )
    )
    assert first["built"] is True
    assert len(first["rows"]) == 30
    assert second["built"] is False
    assert second["status"] == "same_day_cache"
    assert len(second["rows"]) == 30
    assert provider.market_calls == 1


def test_recent_prior_cache_is_used_when_same_day_provider_is_unavailable(tmp_path: Path) -> None:
    provider = _CacheFixtureProvider()
    asyncio.run(
        ensure_diagnosis_cross_section_cache(
            provider=provider,
            cache_root=tmp_path / "cache",
            workspace=tmp_path,
            as_of=AS_OF,
        )
    )

    fallback = asyncio.run(
        ensure_diagnosis_cross_section_cache(
            provider=None,
            cache_root=tmp_path / "cache",
            workspace=tmp_path,
            as_of="2026-08-25T15:00:00+08:00",
        )
    )

    assert fallback["built"] is False
    assert fallback["status"] == "recent_prior_cache"
    assert len(fallback["rows"]) == 30
    assert len(fallback["factors"]) == 30
