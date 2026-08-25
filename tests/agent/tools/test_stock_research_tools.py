"""Regression tests for the controlled stock research tool entry points."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from mona.agent.pack_bootstrap import STOCK_ROOM_ID
from mona.agent.partners import ConversationMetadata
from mona.agent.tools.context import ToolContext
from mona.agent.tools.stock_research import (
    StockResearchStartTool,
    StockResearchStatusTool,
    _status_payload,
)
from mona.agent.tools.stock_submit import _unavailable_horizon_summary
from mona.agent.workflow import WorkflowDefinition, WorkflowRunStore, WorkflowStep
from mona.services.stock.reports import public_report_detail
from mona.services.stock.schemas import DecisionReportV6


class _Session:
    conversation_metadata = ConversationMetadata.room(
        ["com.mona.a-share-analyst"], title="股票研究室", hidden=True
    )


class _Sessions:
    def get_or_create(self, key):
        assert key == f"websocket:{STOCK_ROOM_ID}"
        return _Session()


class _WorkflowStore:
    def __init__(self, workflow):
        self.workflow = workflow

    def get_active(self, room_id):
        assert room_id == STOCK_ROOM_ID
        return self.workflow


class _Runner:
    def __init__(self, store):
        self.store = store

    async def run(self, **kwargs):
        # Match the real runner's asynchronous creation boundary: the run is
        # persisted before research work begins.
        await asyncio.sleep(0)
        self.store.create(
            room_id=STOCK_ROOM_ID,
            workflow=kwargs["workflow"],
            inputs=kwargs["inputs"],
            started_by=kwargs["started_by"],
        )


class _Manager:
    def __init__(self, tmp_path):
        workflow = WorkflowDefinition(
            id="stock-deep-research",
            room_id=STOCK_ROOM_ID,
            revision=1,
            status="active",
            steps=[
                WorkflowStep(
                    id="technical",
                    agent_id="com.mona.stock-tech-analyst",
                    task="analyze",
                )
            ],
        )
        self._sessions = _Sessions()
        self._store = WorkflowRunStore(tmp_path / "runs")
        self._workflow_store = _WorkflowStore(workflow)
        self._runner = _Runner(self._store)

    def run_store_for_room(self, room_id):
        return self._store

    def workflow_store_for_room(self, room_id):
        return self._workflow_store

    def workflow_runner_for_room(self, room_id):
        return self._runner


def _ctx(tmp_path, manager):
    return ToolContext(
        config=SimpleNamespace(),
        workspace=str(tmp_path),
        subagent_manager=manager,
        sessions=manager._sessions,
        agent_id="com.mona.a-share-analyst",
        conversation_id="chat-1",
    )


def _v6_reference_plan_report() -> dict:
    def decision(*, action: str, trade_status: str, plan: dict | None = None) -> dict:
        return {
            "direction": "positive" if plan else "avoid",
            "action": action,
            "thesis": "结构化研究结论",
            "not_holding_action": "participate" if plan else "avoid",
            "holding_action": "hold" if plan else "exit",
            "key_reasons": [{"claim": "趋势保持向上", "claim_type": "fact", "source_ids": ["src-1"]}] if plan else [{"claim": "该周期未形成交易计划", "claim_type": "hypothesis", "source_ids": []}],
            "key_risks": [{"claim": "执行条件变化", "claim_type": "fact", "source_ids": ["src-1"]}] if plan else [{"claim": "补齐数据后结论可能改变", "claim_type": "hypothesis", "source_ids": []}],
            "research_status": "ready" if plan else "unavailable",
            "trade_status": trade_status,
            "materialized_plan": plan,
            "valid_until": "2026-09-01T15:00:00+08:00" if plan else None,
            "review_trigger": "关键条件变化时重新评估",
            "source_ids": ["src-1"] if plan else [],
        }

    plan = {
        "schema_version": 6,
        "direction": "positive",
        "action": "conditional_participation",
        "holding_state": "not_holding",
        "current_action": "participate",
        "plan_status": "proxy",
        "execution": {
            "execution_status": "proxy",
            "rules_status": "confirmed",
            "liquidity_status": "proxy",
            "board": "main",
            "exchange": "XSHG",
            "risk_warning": False,
            "buy_status": "proxy",
            "sell_status": "not_applicable",
            "t_plus_one_status": "allowed",
            "min_order_quantity": 100,
            "order_quantity_increment": 100,
            "immediate_execution_allowed": False,
            "execution_mode": "research_only",
            "warnings": [],
            "source_ids": ["src-1"],
        },
        "buy_low": 98.0,
        "buy_high": 100.0,
        "pullback_low": 96.0,
        "pullback_high": 97.0,
        "stop_loss": 92.0,
        "first_take_profit": 108.0,
        "second_take_profit": 112.0,
        "initial_position_pct": 10.0,
        "max_position_pct": 20.0,
        "target_max_position_pct": 20.0,
        "additional_position_pct": 20.0,
        "liquidity_cap_pct": 20.0,
        "risk_budget_pct": 1.0,
        "risk_profile_name": "conservative_default",
        "risk_profile_configured": False,
        "position_cap_reasons": ["单股仓位上限"],
        "execution_mode": "research_only",
        "source_ids": ["src-1"],
    }
    return {
        "schema_version": 6,
        "kind": "deep_research",
        "result_status": "completed",
        "report_id": "stock_report_v6_contract",
        "workflow_run_id": "run_v6_contract",
        "instrument": {"symbol": "600519", "exchange": "XSHG", "name": "贵州茅台"},
        "research_cutoff_at": "2026-08-23T15:00:00+08:00",
        "market_as_of": "2026-08-23T15:00:00+08:00",
        "generated_at": "2026-08-23T15:00:00+08:00",
        "current_price": 100.0,
        "benchmark_price": 200.0,
        "summary": "三周期研究结论",
        "decision_mode": "reference_plan",
        "research_status": "ready",
        "trade_status": "ready",
        "horizon_decisions": {
            "short_term": decision(action="conditional_participation", trade_status="ready", plan=plan),
            "medium_term": decision(action="avoid", trade_status="unavailable"),
            "long_term": decision(action="avoid", trade_status="unavailable"),
        },
        "research_ready": {"status": "ready"},
        "trade_ready": {"status": "ready"},
        "quant_promotion": {"status": "calibrated", "eligibleForTrading": True, "promotionStatus": "calibrated"},
        "valuation": {"status": "ready", "tradeReady": True},
        "execution_qualification": {"status": "ready"},
        "method_versions": {"report": "v6"},
        "source_ids": ["src-1"],
        "sources": [{"id": "src-1"}],
        "disclaimer": "仅供信息研究与学习参考，不构成投资建议。",
    }


@pytest.mark.asyncio
async def test_start_creates_one_persisted_run_and_reuses_it(tmp_path):
    manager = _Manager(tmp_path)
    ctx = _ctx(tmp_path, manager)
    tool = StockResearchStartTool.create(ctx)

    first = json.loads(await tool.execute(symbol="600519"))
    assert first["run_id"].startswith("run_")
    assert first["status"] == "queued"

    second = json.loads(await tool.execute(symbol="XSHG:600519"))
    assert second["run_id"] == first["run_id"]
    assert len(manager._store.list_for_room(STOCK_ROOM_ID)) == 1


@pytest.mark.asyncio
async def test_start_rejects_different_symbol_while_run_is_unfinished(tmp_path):
    manager = _Manager(tmp_path)
    ctx = _ctx(tmp_path, manager)
    tool = StockResearchStartTool.create(ctx)
    await tool.execute(symbol="600519")
    result = await tool.execute(symbol="000001")
    assert result.startswith("Error: stock research room already has unfinished run")


@pytest.mark.asyncio
async def test_status_reads_the_same_run_store(tmp_path):
    manager = _Manager(tmp_path)
    ctx = _ctx(tmp_path, manager)
    start = StockResearchStartTool.create(ctx)
    created = json.loads(await start.execute(symbol="600519"))
    status = StockResearchStatusTool.create(ctx)

    payload = json.loads(await status.execute(run_id=created["run_id"]))
    assert payload["run_id"] == created["run_id"]
    assert payload["status"] == "queued"
    assert payload["completed_steps"] == []

    assert (await status.execute(run_id="run_not_found")).startswith("Error:")


def test_status_report_refs_only_include_final_report_artifacts(tmp_path):
    manager = _Manager(tmp_path)
    run = manager._store.create(
        room_id=STOCK_ROOM_ID,
        workflow=manager._workflow_store.workflow,
        inputs={"symbols": ["XSHG:600519"]},
    )
    run.steps["technical"].output = {
        "artifacts": [
            f"artifact://stock/{run.id}/technical.json",
            f"artifact://stock/{run.id}/report.json",
            f"artifact://stock/{run.id}/report.md",
            f"artifact://stock/{run.id}/digest.json",
            f"artifact://stock/{run.id}/digest.md",
        ]
    }
    payload = _status_payload(run)
    assert payload["report_refs"] == [
        f"artifact://stock/{run.id}/report.json",
        f"artifact://stock/{run.id}/report.md",
        f"artifact://stock/{run.id}/digest.json",
        f"artifact://stock/{run.id}/digest.md",
    ]


def test_v6_public_detail_maps_plan_fields_for_the_user_interface():
    detail = public_report_detail(_v6_reference_plan_report(), "")
    report = detail["report"]
    plan = report["horizonDecisions"]["shortTerm"]["materializedPlan"]

    assert report["schemaVersion"] == 6
    assert report["currentPrice"] == 100.0
    assert plan["buyLow"] == 98.0
    assert plan["targetMaxPositionPct"] == 20.0
    assert plan["currentAction"] == "participate"
    assert plan["holdingState"] == "not_holding"
    assert plan["execution"]["executionStatus"] == "proxy"
    assert plan["execution"]["tPlusOneStatus"] == "allowed"
    serialized = json.dumps(plan, ensure_ascii=False)
    assert "buy_low" not in serialized
    assert "source_ids" not in serialized


def test_v6_public_detail_projects_evidence_market_conclusions_without_articles():
    document = _v6_reference_plan_report()
    document["market_sentiment"] = {
        "status": "available",
        "direction": "偏空",
        "as_of": "2026-08-23T15:00:00+08:00",
        "decision_impact": "市场环境偏弱，仅作为环境参考",
        "source_ids": ["src-1"],
    }
    document["public_opinion"] = {
        "status": "available",
        "direction": "分歧",
        "as_of": "2026-08-23T14:00:00+08:00",
        "coverage_account_count": 30,
        "redfox_index": 62.5,
        "source_ids": ["src-1"],
    }
    document["valuation"]["assessment"] = {
        "view": "合理",
        "pe": {"view": "合理", "percentile": 0.5},
        "pb": {"view": "高估", "percentile": 0.8},
    }

    report = public_report_detail(document, "")["report"]
    assert report["marketSentiment"] == {
        "status": "available",
        "direction": "偏空",
        "strength": None,
        "asOf": "2026-08-23T15:00:00+08:00",
        "decisionImpact": "市场环境偏弱，仅作为环境参考",
    }
    assert report["publicOpinion"]["direction"] == "分歧"
    assert report["publicOpinion"]["coverageAccountCount"] == 30
    assert report["publicOpinion"]["redfoxIndex"] == 62.5
    assert report["valuation"]["assessment"]["pe"]["percentile"] == 0.5
    assert report["sourceCount"] == len(document["source_ids"])
    serialized = json.dumps(report, ensure_ascii=False)
    assert "source_ids" not in serialized
    assert "article" not in serialized.lower()
    assert report["horizonDecisions"]["shortTerm"]["materializedPlan"]["buyLow"] == 98.0


def test_v6_evidence_market_source_ids_are_closed_by_report_sources():
    document = _v6_reference_plan_report()
    document["market_sentiment"] = {"status": "available", "direction": "偏多", "source_ids": ["src-missing"]}
    with pytest.raises(ValueError, match="source_ids"):
        DecisionReportV6.model_validate(document)


def test_v6_public_detail_without_opinion_source_uses_empty_projection():
    document = _v6_reference_plan_report()
    document["public_opinion"] = {
        "status": "unavailable",
        "direction": None,
        "decision_impact": "暂无公开舆论覆盖，本项不参与决策",
        "source_ids": [],
    }
    report = public_report_detail(document, "")["report"]
    assert report["publicOpinion"]["direction"] is None
    assert report["publicOpinion"]["coverageAccountCount"] is None


def test_technical_unavailable_summary_keeps_base_indicators_separate():
    summary = _unavailable_horizon_summary(
        {
            "indicators": {"ma5": 10.0, "macd": {"hist": 0.2}},
            "decision_readiness": {
                "research_ready": {
                    "horizons": {
                        "short_term": {
                            "status": "failed",
                            "available": ["kline"],
                            "failure_reasons": [
                                "quote_unavailable",
                                "derived_indicators_unavailable",
                            ],
                        }
                    }
                }
            },
        },
        "short_term",
        "technical",
    )
    assert summary is not None
    assert "短线已核验历史价格" in summary
    assert "当前不能形成可靠结论或交易计划" in summary
    assert "EastMoney" not in summary
    assert "API" not in summary
    assert "derived_decision_metrics" not in summary
    assert "基础指标缺失" not in summary


def test_technical_unavailable_summary_does_not_leak_unknown_failure_reason():
    summary = _unavailable_horizon_summary(
        {
            "indicators": {"ma5": 10.0},
            "decision_readiness": {
                "research_ready": {
                    "horizons": {
                        "short_term": {
                            "status": "failed",
                            "available": ["kline"],
                            "failure_reasons": ["internal_provider_stack_trace"],
                        }
                    }
                }
            },
        },
        "short_term",
        "technical",
    )
    assert summary is not None
    assert "internal_provider_stack_trace" not in summary
    assert "provider" not in summary
    assert "内部字段" not in summary
