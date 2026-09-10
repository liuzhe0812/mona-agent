from __future__ import annotations

import pytest

from mona.services.stock.fundamental_factors import build_fundamental_factors


def _row(source_id, *, published_at="2026-08-25T15:00:00+08:00", roe=12.0):
    return {
        "published_at": published_at,
        "source_ids": [source_id],
        "metrics": {
            "roe": roe,
            "roic": 9.0,
            "gross_margin": 30.0,
            "net_margin": 10.0,
            "revenue_yoy": 20.0,
            "profit_yoy": 25.0,
            "operating_cashflow": 100.0,
            "net_profit": 80.0,
            "debt_ratio": 40.0,
            "capex": 20.0,
            "pe": 10.0,
            "pb": 2.0,
        },
    }


def test_fundamental_factor_result_is_deterministic_and_explainable():
    current = _row("src_current")
    lower = _row("src_peer", roe=6.0)
    payload = {
        "fundamentals": current,
        "fundamentals_history": [current],
        "fundamental_universe": [current, lower],
    }

    first = build_fundamental_factors(
        payload,
        research_cutoff_at="2026-08-25T16:00:00+08:00",
    )
    second = build_fundamental_factors(
        payload,
        research_cutoff_at="2026-08-25T16:00:00+08:00",
    )

    assert first == second
    assert first["status"] == "available"
    assert first["core_group_ready"] == {
        "profitability": True,
        "growth_quality": True,
        "cashflow_quality": True,
        "financial_safety": True,
        "valuation": True,
    }
    assert first["score"] is not None
    roe = next(item for item in first["factors"] if item["id"] == "roe")
    assert roe["raw_value"] == 12.0
    assert roe["percentile"] is not None
    assert roe["direction"] == "positive"
    assert roe["contribution"] > 0
    assert roe["method_version"]
    assert roe["source_ids"] == ["src_current"]


def test_future_financial_row_is_excluded_and_public_gap_is_explicit():
    current = _row("src_current")
    future = _row("src_future", published_at="2026-08-26T15:00:00+08:00")
    result = build_fundamental_factors(
        {
            "fundamentals": future,
            "fundamentals_history": [current, future],
            "fundamental_universe": [current, future],
        },
        research_cutoff_at="2026-08-25T16:00:00+08:00",
    )

    assert result["excluded_future"]
    assert result["source_ids"] == ["src_current"]
    assert "governance" in result["missing_fields"]
    assert "audit_or_restatement_status" in result["missing_fields"]
    assert "capital_expenditure" not in result["missing_fields"]


def test_quote_valuation_is_analyzed_with_cross_section_percentiles():
    current = _row("src_current")
    current["metrics"].pop("pe")
    current["metrics"].pop("pb")
    result = build_fundamental_factors(
        {
            "fundamentals": current,
            "fundamentals_history": [current],
            "quote": {"pe": 12.0, "pb": 2.5, "source_ids": ["src_quote"]},
        },
        history=[current],
        percentile_map={"pe": 0.8, "pb": 0.7},
        research_cutoff_at="2026-08-25T16:00:00+08:00",
    )

    pe = next(item for item in result["factors"] if item["id"] == "pe")
    pb = next(item for item in result["factors"] if item["id"] == "pb")
    assert pe["raw_value"] == 12.0
    assert pe["percentile"] == pytest.approx(0.2)
    assert pe["source_ids"] == ["src_quote"]
    assert pb["raw_value"] == 2.5
    assert pb["percentile"] == pytest.approx(0.3)
