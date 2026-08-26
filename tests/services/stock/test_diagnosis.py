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
        evidence={"market_sentiment": {"direction": "暂不判断", "source_ids": ["src_s"]}},
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
        ("量化验证", "偏空", "估值偏高，短期动量走弱"),
        ("情绪与预期", "谨慎", "市场信号分化，个股暂无反转信号"),
        ("风控纪律", "严格", "回避新增，已持有优先降风险"),
    ]
    assert fundamental.short_term.factors[0].name == "revenue_yoy"


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
                "source_ids": ["src_sem", "src_factor", "src_quant", "src_tech"],
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
