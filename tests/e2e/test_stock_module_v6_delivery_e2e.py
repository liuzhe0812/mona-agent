"""Fixed-data delivery acceptance for the V6 stock research contract.

These tests intentionally bypass provider/network collection and stage one
trusted Evidence bundle on disk.  The V6 report writer, deterministic plan
materializer, immutable tracking snapshot, and report query surface remain
real production code paths.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from types import SimpleNamespace

from mona.agent.tools.stock_submit import SubmitStockReportStagedTool
from mona.agent.workflow import WorkflowDefinition, WorkflowRunStore, WorkflowStep
from mona.config.paths import get_stock_project_dir
from mona.services.stock.outcomes import build_v5_derived_decision_metrics
from mona.services.stock.reports import load_report, public_report_detail, scan_reports
from mona.services.stock.schemas import DecisionReportV5

INSTRUMENT_ID = "XSHG:600519"
SOURCE_ID = "src_v6_fixed_quote"
MARKET_AS_OF = "2026-08-14T15:00:00+08:00"
RESEARCH_CUTOFF = "2026-08-14T15:05:00+08:00"
INSTRUMENT = {
    "symbol": "600519",
    "exchange": "XSHG",
    "name": "贵州茅台",
    "instrument_type": "equity",
}


def _source() -> dict[str, object]:
    return {
        "id": SOURCE_ID,
        "provider": "fixed-v6-e2e",
        "url": "https://example.invalid/v6-fixed-quote",
        "content_hash": "sha256:v6-fixed-quote",
        "fields": ["price", "previous_close", "amount_yuan", "turnover_rate_pct"],
        "published_at": MARKET_AS_OF,
        "fetched_at": MARKET_AS_OF,
        "observed_at": MARKET_AS_OF,
    }


def _metric(value: object, **extra: object) -> dict[str, object]:
    return {
        "value": value,
        "as_of": MARKET_AS_OF,
        "source_ids": [SOURCE_ID],
        **extra,
    }


def _readiness(*, all_horizons: bool) -> dict[str, object]:
    statuses = {
        horizon: {"status": "ready" if all_horizons or horizon == "short_term" else "failed"}
        for horizon in ("short_term", "medium_term", "long_term")
    }
    available = [horizon for horizon, item in statuses.items() if item["status"] == "ready"]
    return {
        "status": "ready",
        "as_of": MARKET_AS_OF,
        "source_ids": [SOURCE_ID],
        "horizons": statuses,
        "research_ready": {
            "status": "ready",
            "available_horizons": available,
            "horizons": statuses,
        },
        "trade_ready": {
            "status": "ready",
            "horizons": statuses,
        },
        "enhanced": {"status": "available", "available": ["market_regime"]},
    }


def _bundle(*, calibrated: bool, all_horizons: bool = False) -> dict[str, object]:
    bundle: dict[str, object] = {
        "instrument": INSTRUMENT,
        "research_cutoff_at": RESEARCH_CUTOFF,
        "market_as_of": MARKET_AS_OF,
        "quote": {
            "price": 12.34,
            "previous_close": 12.00,
            "amount_yuan": 200_000_000.0,
            "turnover_rate_pct": 5.0,
            "source_ids": [SOURCE_ID],
        },
        "tradeability": {
            "board": "main",
            "listing_days": 1000,
            "risk_warning": False,
            "suspended": False,
            "delisted": False,
            "delisting": False,
            "source_ids": [SOURCE_ID],
        },
        "execution_facts_projection": {
            "listing_days": 1000,
            "risk_warning": False,
            "suspended": False,
            "delisted": False,
            "delisting": False,
            "active_membership": True,
            "previous_close": 12.00,
            "amount_yuan": 200_000_000.0,
            "turnover_rate_pct": 5.0,
        },
        "relative_benchmarks": {
            "benchmark": {"price": 100.0, "source_ids": [SOURCE_ID]},
            "source_ids": [SOURCE_ID],
        },
        "decision_readiness": _readiness(all_horizons=all_horizons),
        "quant_snapshot": {
            "strategy_id": "quality_growth",
            "as_of": MARKET_AS_OF,
            "factor_algorithm_version": "factor-v6-fixed",
            "rank_algorithm_version": "rank-v6-fixed",
            "source_ids": [SOURCE_ID],
        },
        "quant_validation": (
            {
                "strategy_id": "quality_growth",
                "as_of": MARKET_AS_OF,
                "factor_algorithm_version": "factor-v6-fixed",
                "rank_algorithm_version": "rank-v6-fixed",
                "promotion_status": "calibrated",
                "promotion_reason": "固定量化验证结果",
                "eligible_for_trading": True,
                "validation_status": "uncalibrated",
                "quant_signal": "neutral",
                "strategy_horizon": "short_term",
                "calibrated_horizon": "short_term",
                "horizons": {
                    "short_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                    "medium_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                    "long_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                },
                "validation_metrics": {
                    "sample_scope": "full_eligible_universe",
                    "universe_coverage": 0.95,
                    "status": "passed",
                },
                "source_ids": [SOURCE_ID],
                "snapshot_hash": "sha256:v6-selection-fixture",
                "reason": "固定量化验证结果",
            }
            if calibrated
            else {
                "strategy_id": "quality_growth",
                "as_of": MARKET_AS_OF,
                "factor_algorithm_version": "factor-v6-fixed",
                "rank_algorithm_version": "rank-v6-fixed",
                "promotion_status": "research_only",
                "eligible_for_trading": False,
                "validation_status": "uncalibrated",
                "quant_signal": "neutral",
                "horizons": {
                    "short_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                    "medium_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                    "long_term": {"validation_status": "uncalibrated", "quant_signal": "neutral", "factor_observations": []},
                },
                "reason": "量化策略尚未通过样本外晋级门槛",
                "promotion_reason": "量化策略尚未通过样本外晋级门槛",
                "validation_metrics": {"status": "not_evaluable", "sampleScope": "selected_candidates"},
                "source_ids": [SOURCE_ID],
                "snapshot_hash": "sha256:v6-selection-fixture",
            }
        ),
        "valuation": {
            "trade_ready": True,
            "usable_method_count": 2,
            "cross_range": {"status": "available", "method_count": 2},
        },
        "sources": [_source()],
    }
    derived_input = {
        "schema_version": 1,
        "as_of": MARKET_AS_OF,
        "source_ids": [SOURCE_ID],
        "price": 12.34,
        "momentum": _metric(None, momentum20_pct=4.0, momentum60_pct=8.0),
        "atr20": _metric(0.40),
        "trend": _metric("上升", ma20=12.00, ma60=11.50),
        "volatility": _metric(None, atr20_pct=3.0, return_std20_pct=2.0),
        "swing": _metric(None, support=11.00, resistance=14.00),
        "stop_distance": _metric(None, stop_loss=10.50, value_pct=14.9),
    }
    generated = build_v5_derived_decision_metrics(
        {**bundle, "derived_decision_metrics": derived_input},
        generated_at=RESEARCH_CUTOFF,
        eligible_horizons=[
            "short_term",
            "medium_term",
            "long_term",
        ]
        if all_horizons
        else ["short_term"],
    )
    # Evidence keeps the deterministic inputs beside the generated plans;
    # execution qualification consumes volatility from that same frozen map.
    bundle["derived_decision_metrics"] = {**derived_input, **generated}
    return bundle


def _quant_observation(field: str) -> dict[str, object]:
    return {
        "field": field,
        "raw_value": 4.0,
        "percentile_or_rank": None,
        "direction": "desc",
        "scope": "market",
        "sample_count": 1,
        "missing_count": 0,
        "as_of": MARKET_AS_OF,
        "source_ids": [SOURCE_ID],
        "method_version": "deep-research-factor-observation-v1",
        "validation_status": "uncalibrated",
    }


def _quant_horizons() -> dict[str, object]:
    return {
        "short_term": {
            "validation_status": "uncalibrated",
            "quant_signal": "neutral",
            "factor_observations": [_quant_observation("momentum20")],
        },
        "medium_term": {
            "validation_status": "uncalibrated",
            "quant_signal": "neutral",
            "factor_observations": [_quant_observation("roe")],
        },
        "long_term": {
            "validation_status": "uncalibrated",
            "quant_signal": "neutral",
            "factor_observations": [_quant_observation("pe")],
        },
    }


def _direct_quant_evidence(bundle: dict[str, object]) -> dict[str, object]:
    bundle = dict(bundle)
    bundle["quant_snapshot"] = {
        "strategy_id": "deep_research_factor_observation",
        "as_of": MARKET_AS_OF,
        "factor_algorithm_version": "deep-research-factor-observation-v1",
        "rank_algorithm_version": "deep-research-factor-observation-v1",
        "source_ids": [SOURCE_ID],
        "strategy_fingerprint": "direct-fingerprint",
        "method_registry": {
            "short_term": {"version": "short-term-volume-price-v1", "targetWindowSessions": 10, "targetDefinition": "未来10个交易日相对基准收益"},
            "medium_term": {"version": "medium-term-quality-growth-v1", "targetWindowSessions": 60, "targetDefinition": "未来60个交易日相对基准收益"},
            "long_term": {"version": "long-term-quality-value-v1", "targetWindowSessions": 120, "targetDefinition": "未来120个交易日相对基准收益"},
        },
    }
    bundle["quant_validation"] = {
        "validation_status": "uncalibrated",
        "quant_signal": "neutral",
        "horizons": _quant_horizons(),
        "source_closure_missing": [],
        "promotion_status": "research_only",
        "promotion_reason": "仅作研究观察",
        "eligible_for_trading": False,
        "strategy_horizon": None,
        "calibrated_horizon": None,
        "validation_metrics": {"status": "not_evaluable", "sampleScope": "single_instrument_observation"},
    }
    return bundle


def _selection_quant_evidence(bundle: dict[str, object]) -> dict[str, object]:
    bundle = dict(bundle)
    bundle["quant_snapshot"] = {
        "strategy_id": "quality_growth",
        "as_of": MARKET_AS_OF,
        "factor_algorithm_version": "medium-term-quality-growth-v1",
        "rank_algorithm_version": "percentile-rank-v1",
        "source_ids": [SOURCE_ID],
        "method_registry": {
            "short_term": {"version": "short-term-volume-price-v1", "targetWindowSessions": 10, "targetDefinition": "未来10个交易日相对基准收益"},
            "medium_term": {"version": "medium-term-quality-growth-v1", "targetWindowSessions": 60, "targetDefinition": "未来60个交易日相对基准收益"},
            "long_term": {"version": "long-term-quality-value-v1", "targetWindowSessions": 120, "targetDefinition": "未来120个交易日相对基准收益"},
        },
    }
    bundle["quant_validation"] = {
        "selection_run_id": "run_selection_fixture",
        "selection_report_id": "stock_selection_fixture",
        "strategy_id": "quality_growth",
        "as_of": MARKET_AS_OF,
        "factor_algorithm_version": "medium-term-quality-growth-v1",
        "rank_algorithm_version": "percentile-rank-v1",
        "validation_status": "uncalibrated",
        "quant_signal": "neutral",
        "horizons": _quant_horizons(),
        "source_ids": [SOURCE_ID],
        "snapshot_hash": "sha256:selection-fixture",
        "reason": "选股量化结果仅作为研究先验",
        "source_closure_missing": [],
        "promotion_status": "research_only",
        "promotion_reason": "尚未通过样本外校准",
        "eligible_for_trading": False,
        "validation_metrics": {"status": "not_evaluable", "sampleScope": "selected_candidates"},
    }
    return bundle


def _new_run(
    workspace: Path,
    runtime_root: Path,
    monkeypatch,
    *,
    inputs: dict[str, object] | None = None,
) -> str:
    monkeypatch.setattr(
        "mona.config.paths.get_workflow_runs_dir",
        lambda: runtime_root / "workflow-runs",
    )
    steps = [
        WorkflowStep(
            id=step_id,
            agent_id=f"com.mona.stock-{step_id}-analyst",
            task=f"fixed V6 {step_id}",
        )
        for step_id in ("technical", "fundamental", "news")
    ]
    steps.extend(
        [
            WorkflowStep(
                id="bull",
                agent_id="com.mona.stock-bull-researcher",
                task="fixed V6 bull",
                depends_on=["technical", "fundamental", "news"],
            ),
            WorkflowStep(
                id="bear",
                agent_id="com.mona.stock-bear-researcher",
                task="fixed V6 bear",
                depends_on=["technical", "fundamental", "news"],
            ),
            WorkflowStep(
                id="referee",
                agent_id="com.mona.stock-referee",
                task="fixed V6 referee",
                depends_on=["bull", "bear"],
            ),
        ]
    )
    workflow = WorkflowDefinition(
        id="wf_v6_fixed_e2e",
        room_id="stock_research",
        revision=1,
        status="active",
        steps=steps,
    )
    run = WorkflowRunStore(WorkflowRunStore.default_dir(workspace)).create(
        room_id="stock_research",
        workflow=workflow,
        inputs={"symbols": [INSTRUMENT_ID], **(inputs or {})},
    )
    return run.id


def _write_evidence(workspace: Path, run_id: str, bundle: dict[str, object]) -> Path:
    run_dir = get_stock_project_dir(workspace, run_id)
    (run_dir / "evidence.json").write_text(
        json.dumps({"schema_version": 1, "symbols": {INSTRUMENT_ID: bundle}}, ensure_ascii=False),
        encoding="utf-8",
    )
    return run_dir


def _decision() -> dict[str, object]:
    point = {
        "claim": "短线趋势与量价结构支持条件参与",
        "evidence": "固定行情证据",
        "claim_type": "fact",
        "source_ids": [SOURCE_ID],
    }
    risk = {
        "claim": "放量失败将削弱短线判断",
        "evidence": "固定行情证据",
        "claim_type": "fact",
        "source_ids": [SOURCE_ID],
    }
    return {
        "direction": "positive",
        "action": "conditional_participation",
        "thesis": "短线趋势与量价结构支持条件参与，价格触发后再执行。",
        "not_holding_action": "participate",
        "holding_action": "hold",
        "key_reasons": [point],
        "key_risks": [risk],
        "source_ids": [SOURCE_ID],
    }


def _payload(*, all_horizons: bool) -> dict[str, object]:
    decisions: dict[str, object] = {"short_term": _decision()}
    if all_horizons:
        decisions.update(
            {
                "medium_term": _decision(),
                "long_term": _decision(),
            }
        )
    return {
        "summary": "固定证据下形成短线研究结论，交易计划由量化门槛和执行规则决定。",
        "instrument": INSTRUMENT,
        "horizon_decisions_v6": decisions,
    }


def _legacy_v5_report(bundle: dict[str, object], run_id: str) -> dict[str, object]:
    derived = bundle["derived_decision_metrics"]
    assert isinstance(derived, dict)
    decisions: dict[str, object] = {}
    for horizon, item in (derived.get("horizons") or {}).items():
        assert isinstance(item, dict)
        point = {
            "claim": f"{horizon}旧版研究结论",
            "evidence": "固定行情证据",
            "claim_type": "fact",
            "source_ids": [SOURCE_ID],
        }
        decisions[horizon] = {
            "direction": "positive",
            "action": "conditional_participation",
            "thesis": f"{horizon}旧版交易计划",
            "not_holding_action": "participate",
            "holding_action": "hold",
            "trading_plan": item["trading_plan"],
            "position_plan": item["position_plan"],
            "valid_until": item["valid_until"],
            "review_trigger": item["review_trigger"],
            "key_reasons": [point],
            "key_risks": [dict(point, claim="旧版计划风险")],
            "evidence_strength": "medium",
            "source_ids": [SOURCE_ID],
        }
    report = DecisionReportV5.model_validate(
        {
            "schema_version": 5,
            "kind": "deep_research",
            "result_status": "completed",
            "report_id": f"stock_report_v5_{run_id.removeprefix('run_')}",
            "workflow_run_id": run_id,
            "instrument": INSTRUMENT,
            "research_cutoff_at": RESEARCH_CUTOFF,
            "market_as_of": MARKET_AS_OF,
            "generated_at": RESEARCH_CUTOFF,
            "summary": "旧版历史报告",
            "horizon_decisions": decisions,
            "source_ids": [SOURCE_ID],
            "method_versions": {
                "decision": "legacy-v5",
                "indicators": "legacy-v5",
                "conditions": "legacy-v5",
            },
            "disclaimer": "仅供信息研究与学习参考，不构成投资建议。",
        }
    )
    return report.model_dump(mode="json")


async def _finalize(workspace: Path, run_id: str, job_id: str, payload: dict[str, object]) -> str:
    ctx = SimpleNamespace(
        workspace=str(workspace),
        workflow_run_id=run_id,
        job_id=job_id,
        room_id="stock_research",
        agent_id="com.mona.stock-referee",
    )
    tool = SubmitStockReportStagedTool(workspace=workspace, tool_ctx=ctx)
    saved = await tool.execute(section="deep_v6", payload=payload)
    assert saved.startswith("Saved deep_v6:"), saved
    result = await tool.execute(section="finalize")
    assert result.startswith("Submitted stock_report_v6_"), result
    return result


def _run(coro):
    return asyncio.run(coro)


def _report(run_dir: Path) -> dict[str, object]:
    return json.loads((run_dir / "report.json").read_text(encoding="utf-8"))


def test_v6_finalize_writes_schema_six_and_tracking_snapshot(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    run_dir = _write_evidence(workspace, run_id, _bundle(calibrated=False))

    _run(_finalize(workspace, run_id, "job_v6_research_only", _payload(all_horizons=False)))

    report = _report(run_dir)
    assert report["schema_version"] == 6
    assert report["research_status"] == "ready"
    assert report["horizon_decisions"]["short_term"]["research_status"] == "ready"
    assert report["horizon_decisions"]["medium_term"]["research_status"] == "unavailable"
    assert report["decision_mode"] == "reference_plan"
    assert report["trade_status"] == "ready"
    assert report["horizon_decisions"]["short_term"]["materialized_plan"]["plan_type"] == "rule_reference"
    assert (run_dir / "v6_outcome_tracking.json").is_file()
    tracking = json.loads((run_dir / "v6_outcome_tracking.json").read_text(encoding="utf-8"))
    assert tracking["schemaVersion"] == 1
    assert tracking["reportId"] == report["report_id"]
    assert set(tracking["horizons"]) == {"short_term", "medium_term", "long_term"}

    markdown = (run_dir / "report.md").read_text(encoding="utf-8")
    assert "insufficient_data" not in markdown
    assert "source_ids" not in markdown
    assert "eligibleForTrading" not in markdown


def test_v6_uncalibrated_quant_keeps_explicit_rule_reference_plan(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    run_dir = _write_evidence(workspace, run_id, _bundle(calibrated=False))

    _run(_finalize(workspace, run_id, "job_v6_quant_research_only", _payload(all_horizons=False)))

    report = _report(run_dir)
    assert report["quant_promotion"]["status"] == "research_only"
    assert report["quant_promotion"]["eligibleForTrading"] is False
    assert report["decision_mode"] == "reference_plan"
    assert report["trade_status"] == "ready"
    short = report["horizon_decisions"]["short_term"]
    assert short["materialized_plan"]["plan_type"] == "rule_reference"
    assert short["materialized_plan"]["alpha_calibration_status"] == "research_only"
    assert short["materialized_plan"]["max_position_pct"] <= 10.0


def test_v6_execution_qualification_is_independent_of_quant_and_valuation_gates(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    run_dir = _write_evidence(workspace, run_id, _bundle(calibrated=False))

    _run(_finalize(workspace, run_id, "job_v6_execution_gate_independent", _payload(all_horizons=False)))

    report = _report(run_dir)
    execution = report["execution_qualification"]
    assert execution["status"] in {"proxy", "limited", "blocked"}
    assert execution["status"] != "unavailable"
    assert execution["horizons"]["short_term"]["executionStatus"] == execution["status"]
    assert report["quant_promotion"]["status"] == "research_only"


def test_v6_finalize_rejects_completed_agents_without_action_or_boundary(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    bundle = _bundle(calibrated=False, all_horizons=True)
    derived = bundle["derived_decision_metrics"]
    assert isinstance(derived, dict)
    derived["horizons"] = {}
    run_dir = _write_evidence(workspace, run_id, bundle)
    payload = _payload(all_horizons=True)
    decisions = payload["horizon_decisions_v6"]
    assert isinstance(decisions, dict)
    for decision in decisions.values():
        assert isinstance(decision, dict)
        decision.update(
            {
                "action": "wait",
                "not_holding_action": "wait",
                "holding_action": "hold",
            }
        )

    ctx = SimpleNamespace(
        workspace=str(workspace),
        workflow_run_id=run_id,
        job_id="job_v6_empty_result",
        room_id="stock_research",
        agent_id="com.mona.stock-referee",
    )
    tool = SubmitStockReportStagedTool(workspace=workspace, tool_ctx=ctx)
    _run(tool.execute(section="deep_v6", payload=payload))
    result = _run(tool.execute(section="finalize"))

    assert result.startswith("Error:")
    assert not (run_dir / "report.json").exists()


def test_v6_direct_research_persists_trusted_quant_observations(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    run_dir = _write_evidence(workspace, run_id, _direct_quant_evidence(_bundle(calibrated=False)))

    _run(_finalize(workspace, run_id, "job_v6_direct_quant", _payload(all_horizons=False)))

    report = _report(run_dir)
    quant = report["quant_validation"]
    assert quant["strategy_id"] == "deep_research_factor_observation"
    assert set(quant["horizons"]) == {"short_term", "medium_term", "long_term"}
    assert quant["horizons"]["short_term"]["target_window_sessions"] == 10
    assert quant["horizons"]["medium_term"]["target_window_sessions"] == 60
    assert quant["horizons"]["long_term"]["target_window_sessions"] == 120
    assert SOURCE_ID in report["source_ids"]
    assert {source["id"] for source in report["sources"]} >= {SOURCE_ID}


def test_v6_selection_origin_keeps_selection_quant_payload(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(
        workspace,
        tmp_path,
        monkeypatch,
        inputs={
            "selection_origin": {
                "selection_run_id": "run_selection_fixture",
                "selection_report_id": "stock_selection_fixture",
                "instrument_id": INSTRUMENT_ID,
            }
        },
    )
    run_dir = _write_evidence(workspace, run_id, _selection_quant_evidence(_bundle(calibrated=False)))

    _run(_finalize(workspace, run_id, "job_v6_selection_quant", _payload(all_horizons=False)))

    report = _report(run_dir)
    quant = report["quant_validation"]
    assert quant["selection_run_id"] == "run_selection_fixture"
    assert quant["selection_report_id"] == "stock_selection_fixture"
    assert quant["strategy_id"] == "quality_growth"
    assert quant["horizons"]["short_term"]["factor_observations"][0]["field"] == "momentum20"
    assert quant["horizons"]["short_term"]["target_window_sessions"] == 10
    assert SOURCE_ID in report["source_ids"]


def test_v6_all_gates_materialize_direction_aware_plan(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    run_id = _new_run(workspace, tmp_path, monkeypatch)
    run_dir = _write_evidence(workspace, run_id, _bundle(calibrated=True))

    _run(_finalize(workspace, run_id, "job_v6_reference_plan", _payload(all_horizons=True)))

    report = _report(run_dir)
    short = report["horizon_decisions"]["short_term"]
    assert report["quant_promotion"]["status"] == "calibrated"
    assert report["quant_promotion"]["eligibleForTrading"] is True
    assert report["decision_mode"] == "reference_plan"
    assert report["trade_status"] == "ready"
    assert short["trade_status"] == "ready"
    assert short["materialized_plan"]["direction"] == "positive"
    assert short["materialized_plan"]["execution"]["execution_status"] == "proxy"
    assert short["materialized_plan"]["buy_low"] < short["materialized_plan"]["buy_high"]
    assert short["materialized_plan"]["risk_reward_first_after_cost"] is not None


def test_v6_report_query_keeps_v6_visible_with_legacy_v5_present(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    v6_run_id = _new_run(workspace, tmp_path, monkeypatch)
    legacy_dir = get_stock_project_dir(workspace, "run_legacy_v5")
    legacy_dir.joinpath("report.json").write_text(
        json.dumps(
            _legacy_v5_report(
                _bundle(calibrated=False, all_horizons=True), "run_legacy_v5"
            ),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    legacy_dir.joinpath("report.md").write_text("# 旧版历史报告", encoding="utf-8")
    os.utime(legacy_dir / "report.json", (1, 1))
    os.utime(legacy_dir / "report.md", (1, 1))
    v6_dir = _write_evidence(workspace, v6_run_id, _bundle(calibrated=False))
    _run(_finalize(workspace, v6_run_id, "job_v6_visible", _payload(all_horizons=False)))

    items = scan_reports(workspace / "stock_projects")
    report = _report(v6_dir)
    assert [item["reportId"] for item in items] == [
        report["report_id"],
        "stock_report_v5_legacy_v5",
    ]
    loaded = load_report(workspace / "stock_projects", report["report_id"])
    assert loaded is not None
    doc, markdown = loaded
    assert doc["schema_version"] == 6
    detail = public_report_detail(doc, markdown)
    assert detail["report"]["schemaVersion"] == 6
    assert "sourceIds" not in json.dumps(detail, ensure_ascii=False)
    assert v6_dir.joinpath("report.json").is_file()
