"""Contracts and deterministic behaviour for standard AI diagnosis."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

import mona.services.stock.diagnosis as diagnosis_module
from mona.services.stock.diagnosis import (
    DiagnosisNotFoundError,
    DiagnosisService,
    DiagnosisStateError,
    _decision_basis_rows,
    _diagnosis_source_records,
    build_factor_snapshot,
    standard_diagnosis_workflow,
)
from mona.services.stock.diagnosis_decision import decide_diagnosis
from mona.services.stock.schemas import (
    DiagnosisFundamentalResearch,
    DiagnosisSemanticSubmission,
    StockDiagnosisV1,
)
from tests.services.stock.test_diagnosis_quant import TARGET, _fixture


def _factor_inputs(*, score: float, status: str = "available") -> dict:
    return {
        horizon: {
            "status": status,
            "score": score,
            "source_ids": ["src_factor"],
        }
        for horizon in ("short_term", "medium_term", "long_term")
    } | {"source_ids": ["src_factor"]}


def _quant_inputs(*, score: float, validation_status: str = "calibrated") -> dict:
    return {
        horizon: {
            "status": "available",
            "score": score,
            "validation_status": validation_status,
            "sample_count": 30,
            "source_ids": ["src_quant"],
        }
        for horizon in ("short_term", "medium_term", "long_term")
    } | {"source_ids": ["src_quant"]}


def _technical_inputs(direction: str = "positive") -> dict:
    return {
        horizon: {
            "status": "available",
            "direction": direction,
            "source_ids": ["src_tech"],
        }
        for horizon in ("short_term", "medium_term", "long_term")
    } | {"status": "available", "source_ids": ["src_tech"]}


def test_semantic_submission_rejects_unknown_and_internal_fields() -> None:
    with pytest.raises(ValidationError):
        DiagnosisSemanticSubmission.model_validate(
            {
                "instrument": {"exchange": "XSHG", "symbol": "600519"},
                "evidence_context_id": "ctx_123456789012",
                "source_ids": [],
                "price": 10,
            }
        )
    with pytest.raises(ValidationError):
        StockDiagnosisV1.model_validate({"kind": "deep_research", "schema_version": 6})


def test_deterministic_decision_positive_neutral_negative_and_unavailable() -> None:
    technical = _technical_inputs()
    positive = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.9),
        technical_execution=technical,
    )
    assert positive["horizon_decisions"]["short_term"]["direction"] == "positive"

    neutral = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.5),
        quant_factors=_quant_inputs(score=0.5),
        technical_execution=_technical_inputs("neutral"),
    )
    assert neutral["horizon_decisions"]["short_term"]["direction"] == "neutral"

    negative = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.1),
        quant_factors=_quant_inputs(score=0.1),
        technical_execution=_technical_inputs("negative"),
    )
    assert negative["horizon_decisions"]["short_term"]["direction"] == "negative"

    without_quant = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors={},
        technical_execution=technical,
    )
    short = without_quant["horizon_decisions"]["short_term"]
    assert short["direction"] == "positive"
    assert short["factor_score"] is None
    assert short["confidence"] == "low"

    unavailable = decide_diagnosis(
        fundamental_factors={},
        quant_factors={},
        technical_execution={},
    )
    assert unavailable["horizon_decisions"]["short_term"]["direction"] == "unavailable"


def test_current_decision_keeps_short_term_risk_plan_without_quant_or_fundamental() -> None:
    technical = {
        "trend": {"value": "down", "source_ids": ["src_tech"]},
        "source_ids": ["src_tech"],
        "horizons": {
            "short_term": {
                "valid_until": "2026-09-08T15:00:00+08:00",
                "review_trigger": "10个交易日后或价格条件变化时复评",
                "trading_plan": {
                    "reference_buy_high": 36.23,
                    "pullback_buy_high": 35.42,
                    "stop_loss": 34.05,
                    "first_take_profit": 38.64,
                    "second_take_profit": 40.17,
                    "source_ids": ["src_tech"],
                },
                "position_plan": {
                    "initial_position_pct": 4.59,
                    "max_position_pct": 9.18,
                    "risk_budget_pct": 1.0,
                },
            }
        },
    }
    result = decide_diagnosis(
        fundamental_factors={},
        quant_factors={},
        technical_execution=technical,
        holding_state="not_holding",
    )
    current = result["decision_radar"]["current_decision"]
    assert current["direction"] == "negative"
    assert current["not_holding_action"] == "avoid"
    assert current["holding_action"] == "reduce"
    assert current["materialized_plan"]["stop_loss"] == 34.05
    assert current["materialized_plan"]["first_take_profit"] == 38.64
    assert current["materialized_plan"]["second_take_profit"] == 40.17
    assert current["valid_until"] == "2026-09-08T15:00:00+08:00"
    assert current["review_trigger"] == "10个交易日后或价格条件变化时复评"
    assert current["position_plan"]["reference_position_pct"] == 0
    assert current["position_plan"]["max_position_pct"] == 0


def test_explicit_stop_trigger_forces_holding_exit() -> None:
    technical = {
        "trend": {"value": "down", "source_ids": ["src_tech"]},
        "horizons": {
            "short_term": {
                "trading_plan": {
                    "stop_loss": 34.05,
                    "exit_conditions": [
                        {"description": "价格跌至止损参考 34.05 元", "status": "triggered"}
                    ],
                }
            }
        },
    }
    result = decide_diagnosis(
        fundamental_factors={},
        quant_factors={},
        technical_execution=technical,
        holding_state="not_holding",
    )

    current = result["decision_radar"]["current_decision"]
    assert current["not_holding_action"] == "avoid"
    assert current["holding_action"] == "exit"


def test_descriptive_quant_does_not_drive_action() -> None:
    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.5),
        quant_factors=_quant_inputs(score=1.0, validation_status="descriptive"),
        technical_execution=_technical_inputs("neutral"),
    )
    short = result["horizon_decisions"]["short_term"]
    assert short["validation_status"] == "descriptive"
    assert short["direction"] == "neutral"
    assert short["action"] == "wait"


def test_promoted_quant_can_change_direction_but_cannot_bypass_the_plan_gate() -> None:
    descriptive = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.6),
        quant_factors=_quant_inputs(score=1.0, validation_status="descriptive"),
        technical_execution=_technical_inputs("neutral"),
    )["horizon_decisions"]["short_term"]
    calibrated = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.6),
        quant_factors=_quant_inputs(score=1.0, validation_status="calibrated"),
        technical_execution=_technical_inputs("neutral"),
    )["horizon_decisions"]["short_term"]

    assert descriptive["direction"] == "neutral"
    assert descriptive["action"] == "wait"
    assert calibrated["direction"] == "positive"
    assert calibrated["action"] == "wait"


def test_decision_exposes_signed_score_and_normalized_component_weights() -> None:
    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.695),
        quant_factors=_quant_inputs(score=1.0, validation_status="descriptive"),
        technical_execution=_technical_inputs("neutral"),
    )

    short = result["horizon_decisions"]["short_term"]
    assert short["decision_score"] == pytest.approx(0.2145)
    assert short["direction"] == "positive"
    assert short["positive_threshold"] == pytest.approx(0.2)
    assert short["negative_threshold"] == pytest.approx(-0.2)
    assert short["component_scores"] == {
        "fundamental": pytest.approx(0.39),
        "technical": pytest.approx(0.0),
    }
    assert short["component_weights"] == {
        "fundamental": pytest.approx(0.55),
        "technical": pytest.approx(0.45),
    }


@pytest.mark.parametrize(
    ("signed_score", "expected_direction"),
    [
        (0.2, "neutral"),
        (0.200001, "positive"),
        (-0.2, "neutral"),
        (-0.200001, "negative"),
    ],
)
def test_direction_thresholds_are_strictly_plus_minus_point_two(
    signed_score: float, expected_direction: str
) -> None:
    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=(signed_score + 1) / 2),
        quant_factors={},
        technical_execution={},
    )

    short = result["horizon_decisions"]["short_term"]
    assert short["decision_score"] == pytest.approx(signed_score)
    assert short["direction"] == expected_direction


def test_quant_snapshot_preserves_oos_performance_and_cohort_progress() -> None:
    snapshot = build_factor_snapshot(
        {
            "short_term": {
                "status": "available",
                "validation_status": "calibrated",
                "factor_score": 0.72,
                "market_percentile": 0.81,
                "sample_count": 90,
                "target_window_sessions": 10,
                "calibration": {
                    "promotionStatus": "calibrated",
                    "metrics": {
                        "oosPeriods": 3,
                        "sampleCount": 90,
                        "rankIc": 0.08,
                        "excessReturnAfterCost": 0.012,
                        "maxDrawdown": -0.06,
                    },
                    "cohortProgress": {
                        "cohortCount": 11,
                        "matureCohortCount": 11,
                        "requiredCohortCount": 11,
                    },
                },
            },
            "medium_term": {"status": "unavailable"},
            "long_term": {"status": "unavailable"},
        },
        quant=True,
    )

    short = snapshot.short_term
    assert short.promotion_status == "calibrated"
    assert short.target_window_sessions == 10
    assert short.validation_metrics["oosPeriods"] == 3
    assert short.validation_metrics["excessReturnAfterCost"] == 0.012
    assert short.validation_metrics["cohortProgress"] == {
        "cohortCount": 11,
        "matureCohortCount": 11,
        "requiredCohortCount": 11,
    }


def test_factor_snapshot_preserves_user_facing_metric_context() -> None:
    snapshot = build_factor_snapshot(
        {
            "status": "available",
            "score": 0.72,
            "factors": [
                {
                    "id": "roe",
                    "value": 15.0,
                    "percentile": 0.78,
                    "direction": "positive",
                    "group": "profitability",
                    "unit": "percent",
                    "comparison_scope": "cross_section",
                    "as_of": "2026-06-30T15:00:00+08:00",
                    "source_ids": ["src_fundamentals"],
                }
            ],
        },
        quant=False,
    )

    factor = snapshot.short_term.factors[0]
    assert factor.group == "profitability"
    assert factor.unit == "percent"
    assert factor.comparison_scope == "cross_section"
    assert factor.as_of == "2026-06-30T15:00:00+08:00"


def test_diagnosis_source_records_project_only_user_facing_metadata() -> None:
    records = _diagnosis_source_records(
        {
            "sources": [
                {
                    "id": "src_report",
                    "provider": "eastmoney",
                    "url": "https://example.com/report",
                    "published_at": "2026-08-31T15:00:00+08:00",
                    "period_end": "2026-06-30",
                    "content_hash": "sha256:internal",
                    "fields": ["roe"],
                },
                {"id": "src_unused", "provider": "other", "url": "https://example.com/unused"},
            ]
        },
        ["src_report"],
    )

    assert records == [
        {
            "id": "src_report",
            "provider": "eastmoney",
            "url": "https://example.com/report",
            "published_at": "2026-08-31T15:00:00+08:00",
            "period_end": "2026-06-30",
        }
    ]


def test_four_step_basis_is_concrete_and_decision_oriented() -> None:
    fundamental = build_factor_snapshot(
        {
            "status": "degraded",
            "score": 0.52,
            "factors": [
                {"id": "revenue_yoy", "value": 62.5, "percentile": 0.8, "direction": "positive", "source_ids": ["src_f"]},
                {"id": "profit_yoy", "value": 897.2, "percentile": 0.9, "direction": "positive", "source_ids": ["src_f"]},
                {"id": "cashflow_to_profit", "value": 0.66, "percentile": 0.4, "direction": "neutral", "source_ids": ["src_f"]},
                {"id": "pe", "value": 59.9, "percentile": 0.25, "direction": "negative", "source_ids": ["src_f"]},
                {"id": "pb", "value": 4.65, "percentile": 0.0, "direction": "negative", "source_ids": ["src_f"]},
            ],
        },
        quant=False,
    )
    quant = build_factor_snapshot(
        {
            "short_term": {
                "status": "available",
                "validation_status": "descriptive",
                "score": 0.49,
                "market_percentile": 0.20,
                "sample_count": 77,
                "factors": [
                    {"field": "momentum20", "raw_value": -0.94, "percentile_or_rank": 0.45, "source_ids": ["src_q"]},
                ],
            },
            "medium_term": {"status": "unavailable"},
            "long_term": {"status": "unavailable"},
        },
        quant=True,
    )
    rows = _decision_basis_rows(
        evidence={
            "market_sentiment": {"direction": "暂不判断", "source_ids": ["src_s"]},
            "quote": {"price": 34.0, "source_ids": ["src_quote"]},
            "technical_supplement": {
                "close_price": 34.0,
                "ma20": 35.5,
                "macd": -0.4,
                "source_ids": ["src_westock_technical"],
            },
            "chip_data": {
                "average_cost": 36.3,
                "profit_ratio": 18.2,
                "source_ids": ["src_westock_chip"],
            },
        },
        fundamental_research=DiagnosisFundamentalResearch(
            status="available",
            business_understandable=True,
            source_ids=["src_f"],
        ),
        fundamental_factors=fundamental,
        quant_factors=quant,
        technical_input={"trend": {"value": "down", "source_ids": ["src_t"]}},
        current_decision={
            "direction": "negative",
            "action": "avoid",
            "not_holding_action": "avoid",
            "holding_action": "reduce",
            "source_ids": ["src_t"],
        },
    )

    assert [(row["label"], row["stance_label"], row["summary"]) for row in rows] == [
        ("基本面", "中性", "盈利修复，现金流偏弱"),
        ("量化验证", "偏空", "市场第20百分位，仅为描述性排名，未经过样本外验证，价格仍在20日均线下"),
        ("情绪与预期", "谨慎", "现价低于筹码平均成本，反弹压力仍需观察"),
        ("风控纪律", "严格", "当前回避买入，等待方向修复"),
    ]
    assert "src_westock_technical" in rows[1]["source_ids"]
    assert "src_westock_chip" in rows[2]["source_ids"]
    assert fundamental.short_term.factors[0].name == "revenue_yoy"


def test_four_step_uses_real_quant_percentile_and_shared_fundamental_threshold() -> None:
    fundamental = build_factor_snapshot(
        {"status": "available", "score": 0.695, "source_ids": ["src_f"]},
        quant=False,
    )
    quant = build_factor_snapshot(
        {
            "short_term": {
                "status": "available",
                "validation_status": "descriptive",
                "score": 0.389,
                "market_percentile": 0.2105,
                "sample_count": 77,
                "source_ids": ["src_q"],
            },
            "medium_term": {"status": "unavailable"},
            "long_term": {"status": "unavailable"},
        },
        quant=True,
    )

    rows = _decision_basis_rows(
        evidence={},
        fundamental_research=DiagnosisFundamentalResearch(
            status="available", business_understandable=True, source_ids=["src_f"]
        ),
        fundamental_factors=fundamental,
        quant_factors=quant,
        technical_input={},
        current_decision={
            "direction": "positive",
            "action": "conditional_participation",
            "not_holding_action": "conditional_participation",
            "holding_action": "hold",
        },
    )

    assert rows[0]["stance_label"] == "中性"
    assert rows[1]["stance_label"] == "偏空"
    assert rows[1]["summary"].startswith("市场第21百分位")


def test_plan_preserves_entry_ranges_and_current_condition_status() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = {
        "reference_buy_low": 38.64,
        "reference_buy_high": 39.36,
        "pullback_buy_low": 37.83,
        "pullback_buy_high": 38.91,
        "stop_loss": 37.55,
        "first_take_profit": 41.90,
        "second_take_profit": 43.35,
        "entry_conditions": [
            {
                "description": "价格达到参考买入区间上沿 39.36 元",
                "status": "not_triggered",
            }
        ],
    }
    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )

    plan = result["horizon_decisions"]["short_term"]["materialized_plan"]
    assert plan["reference_entry_low"] == 38.64
    assert plan["reference_entry_high"] == 39.36
    assert plan["pullback_entry_low"] == 37.83
    assert plan["pullback_entry_high"] == 38.91
    assert plan["entry_condition_status"] == "not_triggered"
    assert plan["entry_condition"] == "价格达到参考买入区间上沿 39.36 元"


def test_plan_calculates_gross_risk_and_two_take_profit_ratios() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = {
        "reference_entry_low": 38.64,
        "reference_entry_high": 39.36,
        "pullback_entry_low": 37.83,
        "pullback_entry_high": 38.91,
        "stop_loss": 37.55,
        "first_take_profit": 41.90,
        "second_take_profit": 43.35,
        "source_ids": ["src_tech"],
    }
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 4.59,
        "max_position_pct": 9.18,
        "risk_budget_pct": 1.0,
    }

    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
        holding_state="not_holding",
    )

    plan = result["horizon_decisions"]["short_term"]["materialized_plan"]
    assert plan["risk_reference_price"] == pytest.approx(39.36)
    assert plan["risk_per_share"] == pytest.approx(1.81)
    assert plan["risk_pct"] == pytest.approx(4.598577)
    assert plan["first_reward_pct"] == pytest.approx(6.453252)
    assert plan["second_reward_pct"] == pytest.approx(10.137195)
    assert plan["risk_reward_first"] == pytest.approx(1.403315)
    assert plan["risk_reward_second"] == pytest.approx(2.204420)
    assert plan["risk_reward_method_version"] == "gross-risk-reward-reference-high-v1"


def _complete_short_term_plan() -> dict:
    return {
        "reference_entry": 100.0,
        "pullback_entry": 100.0,
        "stop_loss": 95.0,
        "first_take_profit": 110.0,
        "second_take_profit": 120.0,
        "source_ids": ["src_tech"],
    }


def _low_slippage_execution_facts() -> dict:
    return {
        "board": "main",
        "exchange": "XSHG",
        "risk_warning": False,
        "registration_listing": False,
        "suspended": False,
        "delisted": False,
        "delisting": False,
        "listing_days": 100,
        "price": 100.0,
        "previous_close": 100.0,
        "amount_yuan": 100_000_000_000.0,
        "turnover_rate_pct": 100.0,
        "atr20_pct": 0.0,
        "has_order_book": False,
        "observed_at": "2026-08-23T15:00:00+08:00",
        "source_ids": ["src_exec"],
    }


def test_only_one_machine_price_condition_is_realtime_eligible() -> None:
    technical = _technical_inputs("positive")
    price_condition = {
        "kind": "price_trigger",
        "description": "价格达到参考买入区间上沿 100.00 元",
        "observed_metric_ref": "quote.price",
        "operator": "gte",
        "status": "not_triggered",
    }
    plan = {**_complete_short_term_plan(), "entry_conditions": [price_condition]}
    technical["short_term"]["trading_plan"] = plan

    single = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]["materialized_plan"]
    assert single["entry_condition_count"] == 1
    assert single["entry_condition_realtime_eligible"] is True

    technical["short_term"]["trading_plan"] = {
        **plan,
        "entry_conditions": [
            price_condition,
            {"kind": "manual", "description": "等待基本面复核", "status": "not_triggered"},
        ],
    }
    multiple = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]["materialized_plan"]
    assert multiple["entry_condition_count"] == 2
    assert multiple["entry_condition_realtime_eligible"] is False


def test_technical_input_projects_real_bundle_execution_facts_for_after_cost_gate() -> None:
    bundle = {
        "instrument": {"symbol": "000001", "exchange": "XSHE"},
        "quote": {
            "price": 100.0,
            "previous_close": 100.0,
            "amount": 100_000_000_000.0,
            "turnover_rate": 100.0,
            "as_of": "2026-08-23T15:00:00+08:00",
            "source_ids": ["src_quote"],
        },
        "tradeability": {
            "observed_at": "2026-08-23T15:00:00+08:00",
            "execution_facts_projection": {
                "board": "深交所主板A股",
                "exchange": "XSHE",
                "risk_warning": False,
                "registration_listing": False,
                "suspended": False,
                "delisted": False,
                "delisting": False,
                "listing_days": 100,
                "source_ids": ["src_tradeability"],
            },
            "source_ids": ["src_tradeability"],
        },
        "derived_decision_metrics": {
            "as_of": "2026-08-23T15:00:00+08:00",
            "source_ids": ["src_kline"],
            "volatility": {"atr20_pct": 0.0, "source_ids": ["src_kline"]},
            "horizons": {
                "short_term": {
                    "trading_plan": _complete_short_term_plan(),
                    "position_plan": {
                        "initial_position_pct": 7.5,
                        "max_position_pct": 15.0,
                        "risk_budget_pct": 1.0,
                        "source_ids": ["src_kline"],
                    },
                }
            },
        },
    }

    technical = diagnosis_module._technical_input(bundle, None)
    facts = technical["execution_facts"]
    assert facts["amount_yuan"] == 100_000_000_000.0
    assert facts["turnover_rate_pct"] == 100.0
    assert facts["atr20_pct"] == 0.0
    assert facts["board"] == "main"
    assert facts["exchange"] == "XSHE"

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    assert short["materialized_plan"]["fee_gate_status"] == "passed"
    assert short["materialized_plan"]["slippage_stress_status"] == "passed"


def test_position_plan_preserves_risk_metadata() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = _complete_short_term_plan()
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "stop_distance_pct": 5.0,
        "volatility_adjustment": 0.75,
        "liquidity_cap_pct": 30.0,
        "calculation_method": "fixed_fractional_risk",
        "calculation_version": "fixed-fractional-risk-test-v1",
        "source_ids": ["src_tech"],
    }

    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )

    position = result["horizon_decisions"]["short_term"]["position_plan"]
    assert position["stop_distance_pct"] == pytest.approx(5.0)
    assert position["volatility_adjustment"] == pytest.approx(0.75)
    assert position["liquidity_cap_pct"] == pytest.approx(30.0)
    assert position["calculation_method"] == "fixed_fractional_risk"
    assert position["calculation_version"] == "fixed-fractional-risk-test-v1"


@pytest.mark.parametrize(
    ("entry_status", "expected_current_action"),
    [("not_triggered", "wait"), ("triggered", "participate")],
)
def test_current_action_tracks_entry_condition_status(
    entry_status: str, expected_current_action: str
) -> None:
    technical = _technical_inputs("positive")
    plan = _complete_short_term_plan()
    plan["entry_conditions"] = [
        {"description": "价格达到参考买入区间上沿 100.00 元", "status": entry_status}
    ]
    technical["short_term"]["trading_plan"] = plan
    technical["execution_facts"] = _low_slippage_execution_facts()
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    assert short["not_holding_action"] == "conditional_participation"
    assert short["current_action"] == expected_current_action


def test_missing_execution_facts_leave_fee_gate_available_but_stress_unavailable() -> None:
    technical = _technical_inputs("positive")
    plan = _complete_short_term_plan()
    plan["entry_conditions"] = [
        {"description": "价格达到参考买入区间上沿 100.00 元", "status": "triggered"}
    ]
    technical["short_term"]["trading_plan"] = plan
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    plan_result = short["materialized_plan"]
    assert plan_result["fee_gate_status"] == "passed"
    assert plan_result["slippage_stress_status"] == "unavailable"
    assert short["not_holding_action"] == "conditional_participation"
    assert short["current_action"] == "participate"


def test_conservative_slippage_marks_stress_without_degrading_strategy_action() -> None:
    technical = _technical_inputs("positive")
    plan = _complete_short_term_plan()
    plan.update(
        {
            "entry_conditions": [
                {"description": "价格达到参考买入区间上沿 100.00 元", "status": "triggered"}
            ],
        }
    )
    technical["short_term"]["trading_plan"] = plan
    high_slippage_facts = _low_slippage_execution_facts()
    high_slippage_facts.update(
        {"amount_yuan": 1.0, "turnover_rate_pct": 0.01, "atr20_pct": 5.0}
    )
    technical["execution_facts"] = high_slippage_facts
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    plan_result = short["materialized_plan"]
    assert plan_result["risk_reward_gate_status"] == "passed"
    assert plan_result["fee_gate_status"] == "passed"
    assert plan_result["slippage_stress_status"] == "failed"
    assert plan_result["risk_reward_first_after_fees"] >= 1.0
    assert plan_result["risk_reward_second_after_fees"] >= 2.0
    assert plan_result["risk_reward_first_after_cost"] < 1.0
    assert plan_result["risk_reward_second_after_cost"] < 2.0
    assert short["not_holding_action"] == "conditional_participation"
    assert short["current_action"] == "participate"
    assert any("滑点压力测试未通过" in risk["text"] for risk in short["key_risks"])


@pytest.mark.parametrize(
    ("first_take_profit", "second_take_profit"),
    [(104.0, 110.0), (105.0, 109.0)],
)
def test_below_risk_reward_gate_waits_for_not_holding_action(
    first_take_profit: float, second_take_profit: float
) -> None:
    technical = _technical_inputs("positive")
    plan = _complete_short_term_plan()
    plan.update(
        {
            "first_take_profit": first_take_profit,
            "second_take_profit": second_take_profit,
            "entry_conditions": [
                {"description": "价格达到参考买入区间上沿 100.00 元", "status": "triggered"}
            ],
        }
    )
    technical["short_term"]["trading_plan"] = plan
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    assert short["materialized_plan"]["risk_reward_gate_status"] == "failed"
    assert short["not_holding_action"] == "wait"
    assert short["current_action"] == "wait"
    assert any("收益风险比未达到策略门槛" in risk["text"] for risk in short["key_risks"])


def test_conservative_risk_cap_reduces_an_overlarge_position() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = _complete_short_term_plan()
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 20.0,
        "max_position_pct": 25.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )

    short = result["horizon_decisions"]["short_term"]
    position = short["position_plan"]
    assert position["max_position_pct"] == pytest.approx(20.0)
    assert position["reference_position_pct"] == pytest.approx(10.0)
    assert position["conservative_risk_cap_pct"] == pytest.approx(20.0)
    assert any("已自动下调仓位上限" in risk["text"] for risk in short["key_risks"])


def test_zero_position_downgrades_not_holding_action_to_wait() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = _complete_short_term_plan()
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 0.0,
        "max_position_pct": 0.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    short = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
    )["horizon_decisions"]["short_term"]

    assert short["direction"] == "positive"
    assert short["not_holding_action"] == "wait"
    assert short["action"] == "wait"
    assert short["position_plan"]["max_position_pct"] == 0.0


def test_positive_direction_without_complete_plan_waits_for_a_valid_plan() -> None:
    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=_technical_inputs("positive"),
        holding_state="not_holding",
    )

    short = result["horizon_decisions"]["short_term"]
    assert short["direction"] == "positive"
    assert short["materialized_plan"]["value_status"] == "unavailable"
    assert short["not_holding_action"] == "wait"
    assert short["action"] == "wait"


def test_positive_direction_with_a_complete_valid_plan_allows_conditional_participation() -> None:
    technical = _technical_inputs("positive")
    technical["short_term"]["trading_plan"] = {
        "reference_entry": 39.36,
        "reference_entry_low": 38.64,
        "reference_entry_high": 39.36,
        "pullback_entry": 38.91,
        "pullback_entry_low": 37.83,
        "pullback_entry_high": 38.91,
        "stop_loss": 37.55,
        "first_take_profit": 41.90,
        "second_take_profit": 43.35,
        "source_ids": ["src_tech"],
    }
    technical["execution_facts"] = _low_slippage_execution_facts()
    technical["short_term"]["position_plan"] = {
        "initial_position_pct": 7.5,
        "max_position_pct": 15.0,
        "risk_budget_pct": 1.0,
        "source_ids": ["src_tech"],
    }

    result = decide_diagnosis(
        fundamental_factors=_factor_inputs(score=0.9),
        quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
        technical_execution=technical,
        holding_state="not_holding",
    )

    short = result["horizon_decisions"]["short_term"]
    assert short["direction"] == "positive"
    assert short["materialized_plan"]["value_status"] == "available"
    assert short["not_holding_action"] == "conditional_participation"
    assert short["action"] == "conditional_participation"


@pytest.mark.parametrize(
    ("invalid_field", "invalid_value"),
    [
        ("stop_loss", 40.0),
        ("first_take_profit", 38.0),
        ("second_take_profit", 40.0),
    ],
)
def test_invalid_plan_price_order_is_rejected(invalid_field: str, invalid_value: float) -> None:
    technical = _technical_inputs("positive")
    plan = {
        "reference_entry": 39.36,
        "pullback_entry": 38.91,
        "stop_loss": 37.55,
        "first_take_profit": 41.90,
        "second_take_profit": 43.35,
        "source_ids": ["src_tech"],
    }
    plan[invalid_field] = invalid_value
    technical["short_term"]["trading_plan"] = plan

    with pytest.raises(ValueError):
        decide_diagnosis(
            fundamental_factors=_factor_inputs(score=0.9),
            quant_factors=_quant_inputs(score=0.5, validation_status="descriptive"),
            technical_execution=technical,
            holding_state="not_holding",
        )


def test_service_persists_report_and_enforces_one_agent(tmp_path) -> None:
    calls: list[int] = []

    def semantic(evidence, instrument):
        calls.append(1)
        return {
            "schema_version": 1,
            "instrument": {
                "exchange": instrument.exchange,
                "symbol": instrument.symbol,
            },
            "evidence_context_id": "ctx_123456789012",
            "source_ids": ["src_sem"],
            "business_model": "公开证据中的主营业务",
        }

    service = DiagnosisService(tmp_path, semantic_researcher=semantic)

    async def run():
        return await service.create_and_execute(
            instrument={"exchange": "XSHG", "symbol": "600519"},
            evidence_context_id="ctx_123456789012",
            evidence={
                "instrument": {"exchange": "XSHG", "symbol": "600519"},
                "research_cutoff_at": "2026-08-25T15:00:00+08:00",
                "quote": {"price": 1700.0, "source_ids": ["src_price"]},
                "source_ids": ["src_sem", "src_factor", "src_quant", "src_tech", "src_price"],
            },
            fundamental_factors=_factor_inputs(score=0.8),
            quant_factors=_quant_inputs(score=0.8),
            technical_execution=_technical_inputs(),
        )

    result = asyncio.run(run())
    assert result["status"] == "succeeded"
    assert result["agent_step_count"] == 1
    assert len(calls) == 1
    report = result["report"]
    assert report["kind"] == "ai_diagnosis"
    assert report["schema_version"] == 1
    assert report["current_price"] == 1700.0
    assert report["price_source_ids"] == ["src_price"]
    assert report["horizon_decisions"]["short_term"]["materialized_plan"]["value_status"] == "unavailable"
    assert service.list()[0]["diagnosis_id"] == result["diagnosis_id"]


def test_service_deletes_only_terminal_diagnoses(tmp_path) -> None:
    service = DiagnosisService(tmp_path)
    active = service.create(
        instrument={"exchange": "XSHG", "symbol": "600519"},
        evidence_context_id="direct_input",
    )
    with pytest.raises(DiagnosisStateError, match="active diagnosis"):
        service.delete(active["diagnosis_id"])

    service.cancel(active["diagnosis_id"])
    deleted = service.delete(active["diagnosis_id"])

    assert deleted["diagnosis_id"] == active["diagnosis_id"]
    assert service.list() == []
    with pytest.raises(DiagnosisNotFoundError):
        service.get(active["diagnosis_id"])


def test_workflow_has_one_agent_and_deterministic_final_step() -> None:
    workflow = standard_diagnosis_workflow()
    assert len([step for step in workflow["steps"] if step["type"] == "agent"]) == 1
    assert workflow["maxLlmAgentSteps"] == 1
    assert workflow["deterministicDecisionStep"] is True


def test_production_quant_output_is_parsed_into_service_report(tmp_path, monkeypatch) -> None:
    """Exercise the real stage-A payload through C's report adapter."""

    bundle, rows, factors = _fixture()
    bundle = {**bundle, "research_cutoff_at": bundle["market_as_of"]}

    async def ensure_cross_section(**_kwargs):
        return {"rows": rows, "factors": factors, "status": "fixture"}

    monkeypatch.setattr(
        diagnosis_module,
        "ensure_diagnosis_cross_section_cache",
        ensure_cross_section,
    )

    class EvidenceFixture:
        def __init__(self):
            self.contexts = {}

        async def build_context(self, context_id, instrument, **_kwargs):
            context = {
                "context_id": context_id,
                "owner": {"kind": "ai_diagnosis"},
                "symbols": {instrument.id: bundle},
            }
            self.contexts[context_id] = context
            return context

        def read_context(self, context_id):
            return self.contexts.get(context_id)

    service = DiagnosisService(
        tmp_path,
        evidence_service=EvidenceFixture(),
        provider=None,
    )
    result = asyncio.run(
        service.create_and_execute(
            instrument={"exchange": "XSHG", "symbol": TARGET.split(":", 1)[1]},
        )
    )

    assert result["status"] == "succeeded"
    quant = result["report"]["quant_factors"]
    for horizon in ("short_term", "medium_term", "long_term"):
        view = quant[horizon]
        assert view["status"] == "available"
        assert view["validation_status"] == "descriptive"
        assert view["sample_count"] == 30
        assert view["factor_score"] is not None
        assert view["factors"]


def test_service_prefers_immutable_run_quant_over_rebuilding_cache(tmp_path, monkeypatch) -> None:
    async def unexpected_cross_section(**_kwargs):
        raise AssertionError("immutable run quant must be reused")

    monkeypatch.setattr(
        diagnosis_module,
        "ensure_diagnosis_cross_section_cache",
        unexpected_cross_section,
    )
    evidence = {
        "instrument": {"exchange": "XSHG", "symbol": "600519"},
        "research_cutoff_at": "2026-08-25T15:00:00+08:00",
        "source_ids": ["src_quant", "src_tech"],
        "quant_validation": _quant_inputs(score=0.8),
        "derived_decision_metrics": _technical_inputs(),
    }
    service = DiagnosisService(tmp_path)

    result = asyncio.run(
        service.create_and_execute(
            instrument={"exchange": "XSHG", "symbol": "600519"},
            evidence_context_id="direct_input",
            evidence=evidence,
        )
    )

    assert result["status"] == "succeeded"
    assert result["report"]["quant_factors"]["short_term"]["factor_score"] == 0.8


def test_service_rebuilds_single_instrument_quant_from_market_cache(tmp_path, monkeypatch) -> None:
    bundle, rows, factors = _fixture()
    bundle = {
        **bundle,
        "research_cutoff_at": bundle["market_as_of"],
        "quant_validation": {
            "horizons": {
                horizon: {
                    "status": "unavailable",
                    "market_sample_count": 1,
                    "validation_status": "unavailable",
                }
                for horizon in ("short_term", "medium_term", "long_term")
            }
        },
    }

    async def ensure_cross_section(**_kwargs):
        return {"rows": rows, "factors": factors, "status": "fixture"}

    monkeypatch.setattr(
        diagnosis_module,
        "ensure_diagnosis_cross_section_cache",
        ensure_cross_section,
    )
    service = DiagnosisService(tmp_path)
    result = asyncio.run(
        service.create_and_execute(
            instrument={"exchange": "XSHG", "symbol": TARGET.split(":", 1)[1]},
            evidence_context_id="direct_input",
            evidence=bundle,
        )
    )

    assert result["status"] == "succeeded"
    assert result["report"]["quant_factors"]["short_term"]["sample_count"] == 30
    assert result["report"]["quant_factors"]["short_term"]["factor_score"] is not None
