"""Stock module end-to-end acceptance (dev plan T21, design §16).

The data provider is fully mocked and the LLM loop is replaced by a scripted
executor that drives the *real* submit tools with the job's trusted context —
the same calls the pack prompts instruct the models to make. Everything else
is the production wiring: pack bootstrap, hidden room, workflow runner,
artifact collector, evidence bootstrap, cron dispatch and report queries.

Covers design §16 item by item:

1. The built-in stock pack exposes no user-facing partner; ``/api/sessions``
   never lists the stock research room.
2. The hidden room exists with 7 members and the deep-research template
   active.
3. ``run_workflow(inputs={"symbols": ["XSHG:600519"]})`` creates exactly 6
   AgentJobs with the correct parallel layering (3 analysts -> bull/bear ->
   referee).
4. ``StepRun.output.artifacts`` chain is complete; the report traces back to
   inputs, evidence, every view and its sources.
5. Missing evidence yields an ``insufficient_data`` report and a succeeded
   run.
6. The review cron fires via ``template_ref``, covers the whole watchlist in
   one run and produces a digest.
7. Cancel / failure / restart recovery ride the existing run/job state
   machine — no stock-specific job system.
8. ETF and equity flow through different instrument_type fields; a forged
   source_id submission fails.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Request

from mona.agent import run_artifacts
from mona.agent.pack_bootstrap import (
    DAILY_REVIEW_TEMPLATE_REF,
    STOCK_DIAGNOSIS_ROOM_AGENT_IDS,
    STOCK_PACK_ID,
    STOCK_ROOM_AGENT_IDS,
    STOCK_ROOM_ID,
    ensure_stock_pack,
)
from mona.agent.partners import AgentRegistry, ConversationMetadata
from mona.agent.subagent import SubagentManager
from mona.agent.tools.stock_submit import (
    SubmitBearCaseTool,
    SubmitBullCaseTool,
    SubmitFundamentalViewTool,
    SubmitNewsViewTool,
    SubmitStockReportStagedTool,
    SubmitStockReportTool,
    SubmitTechnicalViewTool,
)
from mona.agent.workflow import (
    RUN_STATUS_RUNNING,
    WorkflowRun,
    execution_layers,
)
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.config import schema as _config_schema
from mona.config.schema import ChannelsConfig, StockConfig
from mona.cron.service import CronService
from mona.cron.types import CronJob, CronPayload, CronSchedule
from mona.providers.base import LLMProvider, LLMResponse
from mona.services.stock import review as stock_review
from mona.services.stock import run_init as stock_run_init
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import (
    Fundamentals,
    InstrumentRef,
    KlineBar,
    KlineSeries,
    NewsItem,
    ProviderError,
    Quote,
)
from mona.services.stock.reports import load_report, scan_reports
from mona.services.stock.storage import WatchlistItem, WatchlistStore
from mona.session.manager import SessionManager

# Force ToolsConfig forward-ref resolution before any SubagentManager build
# (same reason as tests/agent/test_pack_bootstrap.py).
_config_schema._resolve_tool_config_refs()

MT = "XSHG:600519"  # 贵州茅台 (equity)
ETF = "XSHE:159915"  # 创业板 ETF
PB = "XSHE:000001"  # 平安银行 (equity)
CALENDAR_DATES = ["2026-08-12", "2026-08-13", "2026-08-14"]

ANALYST_STEPS = {"technical", "fundamental", "news"}
DEBATE_STEPS = {"bull", "bear"}

_VIEW_TOOLS = {
    "technical": SubmitTechnicalViewTool,
    "fundamental": SubmitFundamentalViewTool,
    "news": SubmitNewsViewTool,
    "bull": SubmitBullCaseTool,
    "bear": SubmitBearCaseTool,
}
_VIEW_STANCES = {
    "technical": "positive",
    "fundamental": "positive",
    "news": "neutral",
    "bull": "positive",
    "bear": "negative",
}
_ROLE_LABELS = {
    "technical": "技术",
    "fundamental": "基本面",
    "news": "资讯",
    "bull": "多头",
    "bear": "空头",
}
_HORIZON_LABELS = {
    "short_term": "短线",
    "medium_term": "中线",
    "long_term": "长线",
}


# ----------------------------------------------------------------------
# Mock data provider
# ----------------------------------------------------------------------


def _source(url: str, body: bytes, fields: list[str]) -> SourceRecord:
    return SourceRecord.create(
        provider="eastmoney-mock", url=url, body=body, fields=fields
    )


def _bars(n: int = 80, start: float = 10.0) -> list[KlineBar]:
    out: list[KlineBar] = []
    for i in range(n):
        close = start + i * 0.1
        out.append(
            KlineBar(
                date=f"2026-07-{(i % 28) + 1:02d}",
                open=close - 0.05,
                close=close,
                high=close + 0.1,
                low=close - 0.1,
                volume=1_000_000 + i * 1000,
            )
        )
    return out


class _MockStockProvider:
    """Serves deterministic data; per-symbol failures simulate outages."""

    def __init__(self, *, failing: set[str] | None = None) -> None:
        self.failing = failing or set()
        self.names = {MT: "贵州茅台", ETF: "创业板ETF", PB: "平安银行"}

    def _check(self, inst: InstrumentRef) -> None:
        if inst.id in self.failing:
            raise ProviderError(f"mock outage for {inst.id}")

    async def quote(self, inst: InstrumentRef) -> Quote:
        self._check(inst)
        return Quote(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            name=self.names.get(inst.id, inst.symbol),
            price=12.34,
            change_pct=1.23,
            volume=9_876_543.0,
            as_of="2026-08-14T15:00:00+08:00",
            source=_source(
                f"https://push2.example/{inst.symbol}",
                f"quote-{inst.id}".encode(),
                ["price", "change_pct"],
            ),
        )

    async def kline(self, inst: InstrumentRef, *, limit: int = 120) -> KlineSeries:
        if inst.instrument_type == "index":
            # Trading-calendar query never fails in these tests.
            bars = [
                KlineBar(date=d, open=1, close=1, high=1, low=1, volume=1)
                for d in CALENDAR_DATES
            ]
            return KlineSeries(
                instrument_id=inst.id,
                instrument_type=inst.instrument_type,
                bars=bars,
                source=_source(
                    "https://calendar.example", b"calendar", ["date"]
                ),
            )
        self._check(inst)
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=_bars(),
            source=_source(
                f"https://kline.example/{inst.symbol}",
                f"kline-{inst.id}".encode(),
                ["date", "close"],
            ),
        )

    async def market_snapshot(self, *, limit: int = 5000) -> list[dict[str, Any]]:
        """Minimal complete snapshot required by the current V6 research gate."""
        observed_at = "2026-08-14T15:00:00+08:00"
        industry_source = _source(
            "https://snapshot.example/industry",
            b"fixed-industry-snapshot",
            ["industry", "change_pct", "pe", "pb"],
        )
        rows = []
        for index, instrument_id in enumerate((MT, PB, ETF), start=1):
            exchange, symbol = instrument_id.split(":", 1)
            rows.append(
                {
                    "instrument_id": instrument_id,
                    "exchange": exchange,
                    "symbol": symbol,
                    "industry": "测试行业",
                    "industry_code": "I001",
                    "classification_scheme": "fixed-e2e-industry-v1",
                    "industry_member_coverage": {"available": 3, "total": 3},
                    "industry_benchmark": "fixed-industry-index",
                    "industry_lifecycle": "成熟期",
                    "change_pct": 1.0 - index * 0.1,
                    "amount": 100_000_000.0,
                    "is_suspended": False,
                    "is_st": False,
                    "is_delisting": False,
                    "active_universe_member": True,
                    "status_method": "fixed-e2e-status-v1",
                    "listing_days": 1000,
                    "board": "main",
                    "previous_close": 12.0,
                    "price_limit_rule": "main-10pct",
                    "t_plus_one": "restricted",
                    "pe": 20.0 + index,
                    "pb": 2.0 + index * 0.1,
                    "observed_at": observed_at,
                    "source": industry_source,
                    "source_ids": [industry_source.id],
                }
            )
        return rows

    async def fundamentals_history(
        self, inst: InstrumentRef, *, limit: int = 12
    ) -> list[Fundamentals]:
        self._check(inst)
        periods = ("2026Q2", "2026Q1", "2025Q4", "2025Q3")
        published = (
            "2026-08-10T18:00:00+08:00",
            "2026-05-01T18:00:00+08:00",
            "2026-03-01T18:00:00+08:00",
            "2025-11-01T18:00:00+08:00",
        )
        result: list[Fundamentals] = []
        for index, (period, published_at) in enumerate(zip(periods, published)):
            source = _source(
                f"https://fund.example/{inst.symbol}/{period}",
                f"fund-{inst.id}-{period}".encode(),
                ["report_period", "net_profit", "operating_cashflow", "pe", "pb"],
            ).model_copy(update={"published_at": published_at, "period_end": period})
            result.append(
                Fundamentals(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    report_period=period,
                    metrics={
                        "roe": 0.15,
                        "gross_margin": 0.9,
                        "revenue_yoy": 0.08 + index * 0.01,
                        "profit_yoy": 0.10 + index * 0.01,
                        "net_profit": 100.0 + index,
                        "operating_cashflow": 120.0 + index,
                        "pe": 20.0 + index,
                        "pb": 2.0 + index * 0.1,
                    },
                    source=source,
                )
            )
        return result[:limit]

    async def fundamentals(self, inst: InstrumentRef) -> Fundamentals:
        self._check(inst)
        return Fundamentals(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            report_period="2026Q2",
            metrics={"roe": 0.15, "gross_margin": 0.9},
            source=_source(
                f"https://fund.example/{inst.symbol}",
                f"fund-{inst.id}".encode(),
                ["roe"],
            ),
        )

    async def news(self, inst: InstrumentRef, *, limit: int = 10) -> list[NewsItem]:
        self._check(inst)
        return [
            NewsItem(
                instrument_id=inst.id,
                instrument_type=inst.instrument_type,
                title=f"{inst.symbol} 公告",
                url=f"https://news.example/{inst.symbol}/1",
                published_at="2026-08-14T12:00:00+08:00",
                summary="公告摘要",
                source=_source(
                    f"https://news.example/{inst.symbol}/1",
                    f"news-{inst.id}".encode(),
                    ["title"],
                ),
            )
        ]


class _UnusedLLM(LLMProvider):
    """The E2E never reaches the LLM; the manager just needs one."""

    async def chat(self, messages, tools=None, model=None, **kwargs):
        return LLMResponse(content="unused", finish_reason="stop")

    def get_default_model(self) -> str:
        return "unused-model"


# ----------------------------------------------------------------------
# Scripted agent behavior (replaces the LLM loop, drives the real tools)
# ----------------------------------------------------------------------


def _must_ok(result: str) -> str:
    if result.startswith("Error"):
        raise RuntimeError(result)
    return result


class _ScriptedAgents:
    """Stands in for ``SubagentManager._run_named_agent``.

    Marks the job running, calls the step's real submit tool with the job's
    trusted context (exactly what the pack prompts tell the model to do),
    then marks the job succeeded. Failures are injected per step id.
    """

    def __init__(self, harness: "_Harness") -> None:
        self.h = harness
        self.started: dict[str, float] = {}
        self.finished: dict[str, float] = {}
        self.failing_steps: set[str] = set()
        self.on_step_start: Any = None

    async def __call__(
        self, task_id, job, definition, origin, status, registry, store, **kwargs
    ) -> None:
        step_id = job.workflow_step_id
        self.started[step_id] = time.monotonic()
        if self.on_step_start is not None:
            self.on_step_start(step_id, job.workflow_run_id)
        store.mark_running(job.id)
        try:
            if step_id in self.failing_steps:
                raise RuntimeError(f"scripted failure in {step_id}")
            summary = await self._act(job)
        except Exception as exc:
            store.fail_job(job.id, error=str(exc))
            return
        self.finished[step_id] = time.monotonic()
        store.mark_succeeded(job.id, result=summary)

    # -- scripted tool calls ---------------------------------------------

    def _ctx(self, job) -> SimpleNamespace:
        return SimpleNamespace(
            workspace=str(self.h.ws),
            job_id=job.id,
            workflow_run_id=job.workflow_run_id,
            room_id=job.room_id,
        )

    def _run(self, run_id: str) -> WorkflowRun:
        return self.h.run_store().load(run_id)

    def _bundles(self, run_id: str) -> dict[str, dict]:
        data = EvidenceService(workspace=self.h.ws, provider=None).read(run_id) or {}
        return data.get("symbols") or {}

    @staticmethod
    def _tag(bundle: dict) -> dict:
        inst = bundle["instrument"]
        return {
            "symbol": inst["symbol"],
            "exchange": inst["exchange"],
            "name": inst.get("name") or "",
            "instrument_type": inst["instrument_type"],
        }

    @staticmethod
    def _src(bundle: dict) -> list[str]:
        return [s["id"] for s in bundle.get("sources") or []][:1]

    async def _act(self, job) -> str:
        step_id = job.workflow_step_id
        run = self._run(job.workflow_run_id)
        bundles = self._bundles(run.id)
        if step_id in _VIEW_TOOLS:
            return await self._act_view(job, step_id, run, bundles)
        if step_id == "referee":
            return await self._act_referee(job, run, bundles)
        raise RuntimeError(f"unexpected step {step_id!r}")

    async def _act_view(self, job, step_id, run, bundles) -> str:
        tool = _VIEW_TOOLS[step_id](workspace=self.h.ws, tool_ctx=self._ctx(job))
        stance = _VIEW_STANCES[step_id]
        if step_id in ANALYST_STEPS and "bull" not in run.workflow.step_map():
            # Daily review: one batch view covering the whole watchlist.
            items = []
            for iid in run.inputs["symbols"]:
                bundle = bundles[iid]
                role_label = _ROLE_LABELS[step_id]
                items.append(
                    {
                        "instrument": self._tag(bundle),
                        "stance": stance,
                        "summary": f"{role_label}批量观点 {iid}",
                        "points": [
                            {
                                "claim": f"{role_label}论据",
                                "evidence": "证据",
                                "claim_type": "fact" if self._src(bundle) else "hypothesis",
                                "source_ids": self._src(bundle),
                            }
                        ],
                        "source_ids": self._src(bundle),
                    }
                )
            as_of = next(iter(bundles.values()))["as_of"]
            _must_ok(await tool.execute(as_of=as_of, items=items))
            return f"{step_id} 批量观点已提交"
        iid = run.inputs["symbols"][0]
        bundle = bundles[iid]
        source_ids = self._src(bundle)
        role_label = _ROLE_LABELS[step_id]
        if step_id == "technical":
            sections = {
                "market_regime": [],
                "capital_positioning": [],
                "tradeability": [],
                "short_term_timing": [],
            }
            if source_ids:
                sections["short_term_timing"] = [
                    {
                        "claim": "短线量价观察",
                        "evidence": "证据",
                        "claim_type": "fact",
                        "source_ids": source_ids,
                    }
                ]
        elif step_id == "fundamental":
            sections = {
                "company_quality": [],
                "financial_quality": [],
                "valuation_context": [],
                "long_term_value": [],
            }
            if source_ids:
                sections["financial_quality"] = [
                    {
                        "claim": "财务快照可核验",
                        "evidence": "证据",
                        "claim_type": "fact",
                        "source_ids": source_ids,
                    }
                ]
        elif step_id == "news":
            sections = {
                "industry_context": [],
                "policy_context": [],
                "cycle_context": [],
                "event_calendar": [],
            }
            if source_ids:
                sections["event_calendar"] = [
                    {
                        "claim": "事件来源可核验",
                        "evidence": "证据",
                        "claim_type": "fact",
                        "source_ids": source_ids,
                    }
                ]
        else:
            readiness = bundle.get("decision_readiness") or {}
            research_ready = readiness.get("research_ready") or {}
            readiness_horizons = research_ready.get("horizons") or {}
            horizon_cases = {}
            for horizon in ("short_term", "medium_term", "long_term"):
                horizon_missing = (
                    (readiness_horizons.get(horizon) or {}).get("status") != "ready"
                )
                case_status = (
                    "insufficient_data"
                    if horizon_missing or not source_ids
                    else "available"
                )
                case_points = (
                    [
                        {
                            "claim": f"{_ROLE_LABELS[step_id]}论据",
                            "evidence": "证据",
                            "claim_type": "fact",
                            "source_ids": source_ids,
                        }
                    ]
                    if case_status == "available"
                    else []
                )
                horizon_cases[horizon] = {
                    "status": case_status,
                    "summary": f"{_HORIZON_LABELS[horizon]}{_ROLE_LABELS[step_id]}论证",
                    "points": case_points,
                    "assumptions": [],
                    "confirmation": [],
                    "invalidation": [],
                    "source_ids": source_ids,
                }
            sections = {
                "horizon_cases": horizon_cases
            }
        coverage_horizon = {
            "technical": "short_term",
            "fundamental": "long_term",
            "news": "medium_term",
        }.get(step_id)
        if coverage_horizon is not None:
            readiness = bundle.get("decision_readiness") or {}
            research_ready = readiness.get("research_ready") or {}
            readiness_horizons = research_ready.get("horizons") or {}
            if (readiness_horizons.get(coverage_horizon) or {}).get("status") != "ready":
                stance = "insufficient_data"
        elif not source_ids:
            stance = "insufficient_data"
        _must_ok(
            await tool.execute(
                as_of=bundle["as_of"],
                instrument=self._tag(bundle),
                stance=stance,
                summary=f"{role_label}观点",
                source_ids=source_ids,
                **sections,
            )
        )
        return f"{step_id} 观点已提交"

    async def _act_referee(self, job, run, bundles) -> str:
        if "bull" not in run.workflow.step_map():
            tool = SubmitStockReportTool(workspace=self.h.ws, tool_ctx=self._ctx(job))
            return await self._act_digest(tool, run, bundles)
        iid = run.inputs["symbols"][0]
        bundle = bundles[iid]
        source_ids = self._src(bundle)
        readiness = bundle.get("decision_readiness") or {}
        research_ready = readiness.get("research_ready") or {}
        research_horizons = research_ready.get("horizons") or {}

        def point(text: str) -> dict[str, object]:
            return {
                "claim": text,
                "evidence": "当前 run Evidence",
                "claim_type": "fact",
                "source_ids": source_ids,
            }

        decisions: dict[str, dict[str, object]] = {}
        for horizon in ("short_term", "medium_term", "long_term"):
            if (research_horizons.get(horizon) or {}).get("status") != "ready":
                continue
            horizon_label = _HORIZON_LABELS[horizon]
            decisions[horizon] = {
                "direction": "positive",
                "action": "conditional_participation",
                "thesis": f"{horizon_label}当前证据支持条件参与。",
                "not_holding_action": "participate",
                "holding_action": "hold",
                "key_reasons": [point(f"{horizon_label}有可核验驱动")],
                "key_risks": [point(f"{horizon_label}触发条件失败时重新评估")],
                "source_ids": source_ids,
            }
        if not decisions:
            raise RuntimeError("fixed V6 fixture unexpectedly has no research-ready horizon")
        staged = SubmitStockReportStagedTool(
            workspace=self.h.ws,
            tool_ctx=self._ctx(job),
        )
        _must_ok(
            await staged.execute(
                section="deep_v6",
                payload={
                    "summary": "固定证据下形成三周期研究结论，交易计划由系统门槛决定。",
                    "instrument": self._tag(bundle),
                    "horizon_decisions_v6": decisions,
                },
            )
        )
        _must_ok(await staged.execute(section="finalize"))
        return "V6 研究报告已提交"

    async def _act_digest(self, tool, run, bundles) -> str:
        items = []
        for iid in run.inputs["symbols"]:
            bundle = bundles[iid]
            missing = bundle["data_quality"]["missing"]
            items.append(
                {
                    "instrument": self._tag(bundle),
                    "stance": "insufficient_data" if "quote" in missing else "neutral",
                    "one_liner": f"{iid} 一句话复盘",
                    "data_quality": "degraded" if missing else "complete",
                    "missing": missing,
                }
            )
        source_ids = [
            sid for bundle in bundles.values() for sid in self._src(bundle)
        ]
        as_of = next(iter(bundles.values()))["as_of"]
        _must_ok(
            await tool.execute(
                as_of=as_of, summary="每日复盘摘要", items=items,
                source_ids=source_ids,
            )
        )
        return "复盘简报已提交"


# ----------------------------------------------------------------------
# Harness
# ----------------------------------------------------------------------


class _Harness:
    """Production wiring with a mocked provider and scripted agents."""

    def __init__(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        *,
        provider: _MockStockProvider | None = None,
    ) -> None:
        self.ws = tmp_path / "workspace"
        self.ws.mkdir()
        config_path = tmp_path / "mona-config.json"
        config_path.write_text("{}", encoding="utf-8")
        # Job/Workflow/Run stores are instance runtime state, not workspace
        # state; keep this E2E's runtime under its temporary instance.
        monkeypatch.setattr("mona.config.paths.get_config_path", lambda: config_path)
        self.watchlist_root = tmp_path / "stock"
        self.provider = provider or _MockStockProvider()
        self.sessions = SessionManager(tmp_path / "sessions")
        self.cron = CronService(tmp_path / "cron" / "jobs.json")
        self.registry = AgentRegistry()
        self.behavior = _ScriptedAgents(self)
        monkeypatch.setattr(SubagentManager, "_run_named_agent", self.behavior)
        # Evidence bootstrap seam: the run initializer resolves the provider
        # and default roots through these module-level helpers.
        monkeypatch.setattr(
            stock_run_init, "_default_provider", lambda: self.provider
        )
        monkeypatch.setattr(
            stock_run_init, "_default_watchlist_root", lambda: self.watchlist_root
        )
        monkeypatch.setattr(
            stock_run_init, "_default_cache_root", lambda: tmp_path / "cache"
        )
        self.manager = SubagentManager(
            provider=_UnusedLLM(),
            workspace=self.ws,
            bus=MessageBus(),
            max_tool_result_chars=4000,
            session_manager=self.sessions,
        )
        self.workflow_store = self.manager.workflow_store_for_room(STOCK_ROOM_ID)
        ensure_stock_pack(
            self.sessions,
            self.workflow_store,
            self.cron,
            self.registry,
        )

    # -- helpers ----------------------------------------------------------

    def stock_dir(self) -> Path:
        return self.ws / "stock_projects"

    def run_store(self):
        return self.manager.run_store_for_room(STOCK_ROOM_ID)

    def job_store(self):
        return self.manager.job_store_for_room(STOCK_ROOM_ID)

    def add_watchlist(self, *items: WatchlistItem) -> None:
        store = WatchlistStore(self.watchlist_root)
        for item in items:
            store.add(item)

    async def run_deep(self, symbols: list[str]) -> WorkflowRun:
        runner = self.manager.workflow_runner_for_room(STOCK_ROOM_ID)
        workflow = self.workflow_store.get_active(STOCK_ROOM_ID)
        assert workflow is not None
        session = self.sessions.get_or_create(f"websocket:{STOCK_ROOM_ID}")
        return await runner.run(
            room_id=STOCK_ROOM_ID,
            workflow=workflow,
            conversation=session.conversation_metadata,
            registry=self.registry,
            inputs={"symbols": symbols},
        )


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------
# 1. Partner list + session list
# ----------------------------------------------------------------------


class TestVisibilityAcceptance:
    def test_stock_pack_has_no_visible_partner(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        pack_agents = [
            a
            for a in harness.registry.list_agents()
            if a.package_id == STOCK_PACK_ID
        ]
        assert {a.id for a in pack_agents} == {
            *STOCK_ROOM_AGENT_IDS,
            *STOCK_DIAGNOSIS_ROOM_AGENT_IDS,
        }
        visible = [a.id for a in pack_agents if a.visibility == "partner"]
        assert visible == []

    def test_sessions_list_never_shows_research_room(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        channel = WebSocketChannel(
            {
                "enabled": True,
                "allowFrom": ["*"],
                "host": "127.0.0.1",
                "port": 29878,
                "path": "/ws",
                "websocketRequiresToken": False,
            },
            MagicMock(),
        )
        channel._api_tokens["tok"] = time.monotonic() + 300.0
        channel._session_manager = harness.sessions
        # A normal room for contrast.
        normal = harness.sessions.get_or_create("websocket:room-normal")
        normal.metadata["conversation"] = ConversationMetadata.room(
            ["com.mona.stock-tech-analyst"], title="普通房间"
        ).to_session_metadata()
        harness.sessions.save(normal)

        req = Request(
            "/api/sessions", Headers([("Authorization", "Bearer tok")])
        )
        resp = channel._handle_sessions_list(req)
        assert resp.status_code == 200
        keys = {row["key"] for row in json.loads(resp.body.decode())["sessions"]}
        assert f"websocket:{STOCK_ROOM_ID}" not in keys
        assert "websocket:room-normal" in keys


# ----------------------------------------------------------------------
# 2. Hidden room + active template
# ----------------------------------------------------------------------


class TestBootstrapAcceptance:
    def test_hidden_room_members_and_active_template(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        session = harness.sessions.get_or_create(f"websocket:{STOCK_ROOM_ID}")
        conversation = session.conversation_metadata
        assert conversation.type == "room"
        assert conversation.hidden is True
        assert conversation.agent_ids == STOCK_ROOM_AGENT_IDS
        assert len(conversation.agent_ids) == len(STOCK_ROOM_AGENT_IDS)

        active = harness.workflow_store.get_active(STOCK_ROOM_ID)
        assert active is not None
        assert active.status == "active"
        assert {s.id for s in active.steps} == (
            ANALYST_STEPS | DEBATE_STEPS | {"referee"}
        )
        layers = execution_layers(active)
        assert [set(layer) for layer in layers] == [
            {"technical", "fundamental", "news"},
            {"bull", "bear"},
            {"referee"},
        ]


# ----------------------------------------------------------------------
# 3 + 4. Deep research run: jobs, layering, artifact chain
# ----------------------------------------------------------------------


class TestDeepResearchRun:
    def test_six_jobs_with_layered_order(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        run = _run(harness.run_deep([MT]))
        assert run.status == "succeeded"

        jobs = [
            j
            for j in harness.job_store().list_for_room(STOCK_ROOM_ID)
            if j.workflow_run_id == run.id
        ]
        assert len(jobs) == 6
        assert {j.workflow_step_id for j in jobs} == (
            ANALYST_STEPS | DEBATE_STEPS | {"referee"}
        )
        assert all(j.status == "succeeded" for j in jobs)
        # Generic AgentJob records only — no stock-specific job system.
        assert all(j.assigned_to.startswith("com.mona.stock-") for j in jobs)

        behavior = harness.behavior
        analysts_done = max(behavior.finished[s] for s in ANALYST_STEPS)
        debate_started = min(behavior.started[s] for s in DEBATE_STEPS)
        debate_done = max(behavior.finished[s] for s in DEBATE_STEPS)
        assert debate_started >= analysts_done
        assert behavior.started["referee"] >= debate_done

    def test_artifact_chain_and_report_traceability(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        run = _run(harness.run_deep([MT]))
        assert run.status == "succeeded"
        state = harness.run_store().load(run.id)
        assert state.inputs == {"symbols": [MT]}

        run_dir = harness.stock_dir() / run.id
        for step_id in ANALYST_STEPS | DEBATE_STEPS:
            output = state.steps[step_id].output
            assert output is not None
            refs = output["artifacts"]
            assert len(refs) == 1
            assert refs[0]["owner_kind"] == "product"
            assert refs[0]["owner_id"] == run.id
            assert refs[0]["product"] == "stock"
            assert refs[0]["relative_path"] == f"{step_id}.json"
            assert (run_dir / f"{step_id}.json").is_file()
        referee_output = state.steps["referee"].output
        referee_refs = referee_output["artifacts"]
        assert len(referee_refs) == 1
        assert referee_refs[0]["owner_kind"] == "product"
        assert referee_refs[0]["owner_id"] == run.id
        assert referee_refs[0]["relative_path"] == "report.json"

        # V6 report -> run / decision / source traceability.
        report = _read_json(run_dir / "report.json")
        assert report["workflow_run_id"] == run.id
        assert report["instrument"]["symbol"] == "600519"
        assert report["schema_version"] == 6
        assert set(report["horizon_decisions"]) == {
            "short_term", "medium_term", "long_term"
        }
        assert report["research_status"] == "ready"
        assert report["decision_mode"] in {"research_only", "reference_plan"}
        for decision in report["horizon_decisions"].values():
            assert {"direction", "action", "research_status", "trade_status", "key_reasons", "key_risks"} <= set(decision)
            if decision["research_status"] == "ready":
                assert decision["key_reasons"]
                assert decision["key_risks"]
                assert decision["source_ids"]
        assert report["sources"]

        # Evidence bundle exists and backs every cited source.
        evidence = _read_json(run_dir / "evidence.json")
        bundle = evidence["symbols"][MT]
        assert bundle["quote"]["price"] == 12.34
        evidence_source_ids = {s["id"] for s in bundle["sources"]}
        assert {s["id"] for s in report["sources"]} <= evidence_source_ids
        assert set(report["source_ids"]) <= evidence_source_ids
        for decision in report["horizon_decisions"].values():
            assert set(decision["source_ids"]) <= evidence_source_ids
            for point in decision["key_reasons"] + decision["key_risks"]:
                assert set(point["source_ids"]) <= evidence_source_ids
        assert bundle["kline_ref"]["content_hash"].startswith("sha256:")
        assert (run_dir / "v6_outcome_tracking.json").is_file()

        # The report query surface (StockView) resolves the same document.
        items = scan_reports(harness.stock_dir())
        assert [item["reportId"] for item in items] == [report["report_id"]]
        doc, markdown = load_report(harness.stock_dir(), report["report_id"])
        assert doc["workflow_run_id"] == run.id
        assert "交易结论" in markdown


# ----------------------------------------------------------------------
# 5. Evidence shortage -> initializer fails before research steps
# ----------------------------------------------------------------------


class TestInsufficientEvidence:
    def test_missing_sections_yield_insufficient_data(self, tmp_path, monkeypatch):
        provider = _MockStockProvider(failing={MT})
        harness = _Harness(tmp_path, monkeypatch, provider=provider)
        with pytest.raises(Exception):
            _run(harness.run_deep([MT]))

        runs = harness.run_store().list_for_room(STOCK_ROOM_ID)
        assert len(runs) == 1
        run = runs[0]
        assert run.status == "failed"
        run_dir = harness.stock_dir() / run.id
        evidence = _read_json(run_dir / "evidence.json")
        bundle = evidence["symbols"][MT]
        assert {"quote", "kline", "news"} <= set(bundle["data_quality"]["missing"])
        readiness = bundle["decision_readiness"]
        assert readiness["research_ready"]["status"] == "failed"
        assert not (run_dir / "report.json").exists()
        assert not (run_dir / "report.md").exists()

    def test_calendar_failure_fails_run_before_any_step(self, tmp_path, monkeypatch):
        """Trading-calendar outage -> initializer raises -> run fails fast.

        Design §16: an unavailable calendar is an explicit failure, never a
        weekday-guess fallback and never an evidence-free run.
        """

        class _CalendarDownProvider(_MockStockProvider):
            async def kline(self, inst, *, limit: int = 120):
                if inst.instrument_type == "index":
                    raise ProviderError("calendar feed down")
                return await super().kline(inst, limit=limit)

        harness = _Harness(
            tmp_path, monkeypatch, provider=_CalendarDownProvider()
        )
        with pytest.raises(Exception, match="calendar"):
            _run(harness.run_deep([MT]))
        runs = harness.run_store().list_for_room(STOCK_ROOM_ID)
        assert len(runs) == 1
        assert runs[0].status == "failed"
        assert all(j.workflow_run_id != runs[0].id for j in
                   harness.job_store().list_for_room(STOCK_ROOM_ID))


# ----------------------------------------------------------------------
# 6. Review cron: template_ref dispatch covering the whole watchlist
# ----------------------------------------------------------------------


class TestReviewCron:
    def _cron_job(self) -> CronJob:
        return CronJob(
            id=f"wf_stock_review_{STOCK_ROOM_ID}",
            name=f"workflow:stock-review:{STOCK_ROOM_ID}",
            enabled=True,
            schedule=CronSchedule(
                kind="cron", expr="30 15 * * 1-5", tz="Asia/Shanghai"
            ),
            payload=CronPayload(
                kind="workflow_run",
                room_id=STOCK_ROOM_ID,
                template_ref=DAILY_REVIEW_TEMPLATE_REF,
            ),
        )

    def test_cron_covers_watchlist_and_produces_digest(self, tmp_path, monkeypatch):
        from mona.cli.commands import _execute_workflow_run_cron

        harness = _Harness(tmp_path, monkeypatch)
        harness.add_watchlist(
            WatchlistItem(
                symbol="600519", exchange="XSHG",
                name="贵州茅台", instrument_type="equity",
            ),
            WatchlistItem(
                symbol="000001", exchange="XSHE",
                name="平安银行", instrument_type="equity",
            ),
        )
        config = MagicMock()
        config.stock = StockConfig(enabled=True, auto_review_enabled=True, review_time="15:30", review_scope="all")
        config.services.port = 17174
        config.channels = ChannelsConfig()
        config.workspace_path = harness.ws
        notifier = AsyncMock()

        async def _drive() -> None:
            with pytest.MonkeyPatch.context() as mp:
                mp.setattr(
                    stock_review, "is_trading_day", AsyncMock(return_value=True)
                )
                mp.setattr(
                    stock_review,
                    "_default_watchlist_root",
                    lambda: harness.watchlist_root,
                )
                mp.setattr(stock_review, "notify_review_complete", notifier)
                await _execute_workflow_run_cron(
                    self._cron_job(),
                    subagents=harness.manager,
                    session_manager=harness.sessions,
                    config=config,
                )
                await asyncio.gather(
                    *asyncio.all_tasks() - {asyncio.current_task()}
                )

        _run(_drive())

        notifier.assert_awaited_once()
        notify_kwargs = notifier.await_args.kwargs
        assert notify_kwargs["symbols"] == [MT, PB]
        run_id = notify_kwargs["run_id"]

        run = harness.run_store().load(run_id)
        assert run.status == "succeeded"
        assert run.trigger_type == "cron"
        assert run.inputs == {"symbols": [MT, PB]}
        # The packaged template drives the run, not the room revision.
        assert {s.id for s in run.workflow.steps} == (
            {"technical", "fundamental", "news", "referee"}
        )

        run_dir = harness.stock_dir() / run_id
        digest = _read_json(run_dir / "digest.json")
        assert digest["kind"] == "daily_review"
        assert [item["instrument"]["symbol"] for item in digest["items"]] == [
            "600519",
            "000001",
        ]
        assert (run_dir / "digest.md").is_file()
        # One run, one evidence bundle covering both symbols.
        evidence = _read_json(run_dir / "evidence.json")
        assert set(evidence["symbols"]) == {MT, PB}

        items = scan_reports(harness.stock_dir())
        assert items[0]["reportId"] == digest["report_id"]
        assert items[0]["kind"] == "daily_review"


# ----------------------------------------------------------------------
# 7. Cancel / failure / restart recovery on the existing state machine
# ----------------------------------------------------------------------


class TestStateMachineReuse:
    def test_step_failure_fails_run_and_skips_downstream(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        harness.behavior.failing_steps = {"news"}
        run = _run(harness.run_deep([MT]))
        assert run.status == "failed"
        state = harness.run_store().load(run.id)
        assert state.steps["news"].status == "failed"
        assert state.steps["technical"].status == "succeeded"
        for step_id in ("bull", "bear", "referee"):
            assert state.steps[step_id].status == "skipped"
        jobs = harness.job_store().list_for_room(STOCK_ROOM_ID)
        news_jobs = [j for j in jobs if j.workflow_step_id == "news"]
        assert len(news_jobs) == 1
        assert news_jobs[0].status == "failed"
        # Downstream steps never created jobs.
        assert not [j for j in jobs if j.workflow_step_id in DEBATE_STEPS]

    def test_cancel_between_layers_uses_existing_machine(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)

        def _cancel_on_referee_layer(step_id: str, run_id: str) -> None:
            if step_id == "technical":
                runner = harness.manager.workflow_runner_for_room(STOCK_ROOM_ID)
                runner.cancel_run(run_id)

        harness.behavior.on_step_start = _cancel_on_referee_layer
        run = _run(harness.run_deep([MT]))
        assert run.status == "cancelled"
        state = harness.run_store().load(run.id)
        for step_id in ("bull", "bear", "referee"):
            assert state.steps[step_id].status == "cancelled"

    def test_restart_recovery_fails_interrupted_stock_run(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        workflow = harness.workflow_store.get_active(STOCK_ROOM_ID)
        store = harness.run_store()
        run = store.create(room_id=STOCK_ROOM_ID, workflow=workflow)
        store.transition(run.id, RUN_STATUS_RUNNING)
        stats = _run(harness.manager.recover_workflow_runs())
        assert stats["failed"] >= 1
        assert store.load(run.id).status == "failed"


# ----------------------------------------------------------------------
# 8. ETF vs equity fields; forged source_id rejected
# ----------------------------------------------------------------------


class TestInstrumentTypesAndSourceIntegrity:
    def test_etf_and_equity_keep_their_template_fields(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        harness.add_watchlist(
            WatchlistItem(
                symbol="159915", exchange="XSHE",
                name="创业板ETF", instrument_type="etf",
            ),
        )
        run = _run(harness.run_deep([ETF]))
        assert run.status == "succeeded"
        run_dir = harness.stock_dir() / run.id
        evidence = _read_json(run_dir / "evidence.json")
        assert evidence["symbols"][ETF]["instrument"]["instrument_type"] == "etf"
        report = _read_json(run_dir / "report.json")
        assert report["instrument"]["instrument_type"] == "etf"
        assert report["schema_version"] == 6
        assert set(report["horizon_decisions"]) == {
            "short_term", "medium_term", "long_term"
        }
        # Equity run for contrast.
        run2 = _run(harness.run_deep([MT]))
        report2 = _read_json(harness.stock_dir() / run2.id / "report.json")
        assert report2["instrument"]["instrument_type"] == "equity"
        assert report2["schema_version"] == 6

    def test_forged_source_id_submission_fails(self, tmp_path, monkeypatch):
        harness = _Harness(tmp_path, monkeypatch)
        run = _run(harness.run_deep([MT]))
        assert run.status == "succeeded"
        before = (harness.stock_dir() / run.id / "technical.json").read_text(
            encoding="utf-8"
        )
        ctx = SimpleNamespace(
            workspace=str(harness.ws),
            job_id="job-forged",
            workflow_run_id=run.id,
            room_id=STOCK_ROOM_ID,
        )
        tool = SubmitTechnicalViewTool(workspace=harness.ws, tool_ctx=ctx)
        result = _run(
            tool.execute(
                as_of="2026-08-14T15:00:00+08:00",
                instrument={
                    "symbol": "600519",
                    "exchange": "XSHG",
                    "instrument_type": "equity",
                },
                stance="positive",
                summary="伪造来源的观点",
                source_ids=["src_forged000000"],
            )
        )
        assert result.startswith("Error")
        assert "src_forged000000" in result
        # Nothing written, nothing collected, original artifact untouched.
        after = (harness.stock_dir() / run.id / "technical.json").read_text(
            encoding="utf-8"
        )
        assert after == before
        assert run_artifacts.collect(run.id, "technical") == []
