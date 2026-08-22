"""Deterministic A-share opportunity discovery service.

The service is deliberately independent from Agent/Workflow code.  Agents may
turn a user's words into a :class:`SelectionStrategy`, but this module owns
the actual universe filtering, factor calculation, risk checks and durable
report.  Missing historical data is reported as ``unavailable``; this module
never fabricates a backtest.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Literal

from loguru import logger
from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import (
    Fundamentals,
    InstrumentRef,
    KlineSeries,
    ProviderError,
    Quote,
)
from mona.services.stock.storage import infer_exchange

StrategySource = Literal["builtin", "user", "agent"]
StrategyHorizon = Literal["short_term", "swing", "medium_term", "long_term"]
ScheduleMode = Literal["manual", "daily_after_close", "weekly"]
StrategyAvailability = Literal["available", "unavailable"]

_OPS = frozenset({">", ">=", "<", "<=", "=", "!=", "in", "not_in"})
_FIELDS = frozenset(
    {
        "price",
        "change_pct",
        "volume",
        "turnover",
        "market_cap",
        "pe",
        "pb",
        "roe",
        "roic",
        "gross_margin",
        "net_margin",
        "revenue_yoy",
        "profit_yoy",
        "net_profit",
        "operating_cashflow",
        "debt_ratio",
        "eps",
        "ma5",
        "ma20",
        "ma60",
        "momentum20",
        "momentum60",
        "volatility20",
        "industry",
        "is_st",
        "is_suspended",
        "listing_days",
    }
)
_RANK_FIELDS = _FIELDS - {"industry", "is_st", "is_suspended"}
_SNAPSHOT_FIELDS = frozenset(
    {
        "price", "change_pct", "volume", "turnover", "market_cap", "pe", "pb",
        "industry", "is_st", "is_suspended", "listing_days",
    }
)
_MAX_ENRICHMENT_ROWS = 300
_ENRICHMENT_CONCURRENCY = 20
_MAX_LIMIT = 100
_RUN_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_CATALYST_WINDOW_DAYS = 7
_EVENT_FRESH_SECONDS = 30 * 60
_EVENT_STALE_SECONDS = 24 * 60 * 60
_VALUATION_COMPARISON_SCOPE = "same_industry_current_snapshot"
_VALUATION_MIN_PEER_COUNT = 2

# The provider is deliberately free to use its own upstream taxonomy.  These
# aliases keep the deterministic selector stable while accepting the common
# names used by announcement feeds.
_MATERIAL_EVENT_TYPES = {
    "report", "periodic_report", "earnings", "earnings_report", "earnings_forecast",
    "performance_forecast", "earnings_express", "dividend", "cash_dividend",
    "buyback", "share_reduction", "share_increase", "share_change", "major_contract",
    "contract", "project", "product", "license", "licence", "merger", "restructuring",
    "asset_sale", "financing", "refinancing", "suspension", "resumption", "risk_warning",
    "inquiry", "penalty", "litigation", "major_event", "material_event", "major_matter",
    "shareholder_change", "重大事项",
    "业绩预告", "业绩快报", "定期报告", "分红", "回购", "增减持", "重大合同", "重大项目",
    "并购重组", "融资", "停复牌", "风险警示", "问询", "处罚", "诉讼",
}
_NON_MATERIAL_EVENT_TYPES = {
    "board_meeting", "general_meeting", "procedural", "ordinary_announcement", "notice",
    "董事会", "股东大会", "一般公告", "制度公告", "通知",
}

_DISCOVERY_STRATEGIES = {
    "stable_business": "经营稳健",
    "quality_growth": "业绩成长",
    "trend_confirmation": "趋势确认",
    "recent_catalyst": "近期催化",
}

_EVENT_TYPE_LABELS = {
    "report": "定期报告", "periodic_report": "定期报告", "earnings": "业绩披露",
    "earnings_report": "业绩报告", "earnings_forecast": "业绩预告",
    "performance_forecast": "业绩预告", "earnings_express": "业绩快报",
    "dividend": "利润分配", "cash_dividend": "现金分红", "buyback": "股份回购",
    "share_reduction": "股东减持", "share_increase": "股东增持",
    "share_change": "股东持股变动", "shareholder_change": "股东持股变动",
    "major_contract": "重大合同", "contract": "合同事项", "project": "重大项目",
    "product": "产品进展", "license": "资质许可", "licence": "资质许可",
    "merger": "并购事项", "restructuring": "资产重组", "asset_sale": "资产处置",
    "financing": "融资事项", "refinancing": "再融资", "suspension": "停牌事项",
    "resumption": "复牌事项", "risk_warning": "风险警示", "inquiry": "监管问询",
    "penalty": "监管处罚", "litigation": "重大诉讼", "major_event": "重大事项",
    "material_event": "重大事项", "major_matter": "重大事项",
}


class ScreeningValidationError(ValueError):
    """A strategy contains a field or operation outside the allowlist."""


class SelectionCondition(Base):
    field: str
    op: str
    value: Any

    @model_validator(mode="after")
    def _validate_condition(self) -> "SelectionCondition":
        if self.field not in _FIELDS:
            raise ValueError(f"unsupported screening field {self.field!r}")
        if self.op not in _OPS:
            raise ValueError(f"unsupported screening operator {self.op!r}")
        if self.op in {"in", "not_in"} and not isinstance(self.value, list):
            raise ValueError(f"operator {self.op!r} requires a list value")
        if self.op not in {"in", "not_in"} and isinstance(self.value, (dict, tuple)):
            raise ValueError("condition value must be scalar or list")
        return self


class RankingFactor(Base):
    field: str
    direction: Literal["asc", "desc"] = "desc"
    weight: float = Field(default=1.0, ge=0)

    @field_validator("field")
    @classmethod
    def _validate_field(cls, value: str) -> str:
        if value not in _RANK_FIELDS:
            raise ValueError(f"unsupported ranking field {value!r}")
        return value


class StrategyUniverse(Base):
    markets: list[str] = Field(default_factory=lambda: ["XSHG", "XSHE", "BJSE"])
    instrument_types: list[str] = Field(default_factory=lambda: ["equity"])
    industries: list[str] = Field(default_factory=list)
    exclude_st: bool = True
    exclude_suspended: bool = True
    min_listing_days: int = Field(default=120, ge=0, le=20_000)
    min_daily_amount: float | None = Field(default=None, ge=0)


class StrategySchedule(Base):
    """Persisted preference; cron registration remains in the Agent layer."""

    mode: ScheduleMode = "manual"
    enabled: bool = False
    time: str = Field(default="15:30", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    weekday: int | None = Field(default=None, ge=0, le=6)


class SelectionStrategy(Base):
    schema_version: int = 1
    strategy_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,63}$")
    name: str = Field(min_length=1, max_length=80)
    source: StrategySource = "user"
    availability: StrategyAvailability = "available"
    unavailable_reason: str | None = Field(default=None, max_length=240)
    horizon: StrategyHorizon = "medium_term"
    universe: StrategyUniverse = Field(default_factory=StrategyUniverse)
    schedule: StrategySchedule = Field(default_factory=StrategySchedule)
    filters: list[SelectionCondition] = Field(default_factory=list, max_length=50)
    ranking: list[RankingFactor] = Field(default_factory=list, max_length=20)
    included_strategy_ids: list[str] = Field(default_factory=list, max_length=4)
    limit: int = Field(default=30, ge=1, le=_MAX_LIMIT)
    created_at: str = ""
    updated_at: str = ""

    @model_validator(mode="after")
    def _validate_weights(self) -> "SelectionStrategy":
        if self.ranking and sum(f.weight for f in self.ranking) <= 0:
            raise ValueError("ranking weights must have a positive total")
        if self.availability == "unavailable" and not self.unavailable_reason:
            raise ValueError("unavailable strategies must explain the missing capability")
        if self.strategy_id == "combined_discovery":
            unique = list(dict.fromkeys(self.included_strategy_ids))
            if len(unique) < 2 or any(item not in _DISCOVERY_STRATEGIES for item in unique):
                raise ValueError("combined_discovery requires 2-4 supported discovery strategies")
            self.included_strategy_ids = unique
        elif self.included_strategy_ids:
            raise ValueError("included_strategy_ids is only valid for combined_discovery")
        return self


class MarketSnapshot(Base):
    """Small, point-in-time row used by the deterministic screening engine."""

    instrument_id: str
    symbol: str = Field(pattern=r"^\d{6}$")
    exchange: Literal["XSHG", "XSHE", "BJSE"]
    instrument_type: Literal["equity", "etf"] = "equity"
    name: str = ""
    industry: str | None = None
    price: float | None = None
    change_pct: float | None = None
    volume: float | None = None
    # ``turnover`` is retained as the legacy amount field used by screening.
    # The explicit names below make the market snapshot semantics unambiguous
    # for the evidence layer without changing existing screening payloads.
    turnover: float | None = None
    amount: float | None = None
    turnover_rate: float | None = None
    market_cap: float | None = None
    pe: float | None = None
    pb: float | None = None
    is_st: bool = False
    is_suspended: bool = False
    listing_days: int | None = None
    as_of: str | None = None
    observed_at: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    # The full SourceRecord is needed while composing EvidenceBundle, but it
    # must not leak into screening reports or SQLite snapshot JSON.
    source: SourceRecord | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _check_id(self) -> "MarketSnapshot":
        if self.instrument_id != f"{self.exchange}:{self.symbol}":
            raise ValueError("instrument_id does not match exchange and symbol")
        return self


class ValuationMetric(Base):
    value: float | None = None
    peer_count: int = 0
    median: float | None = None
    percentile: float | None = None


class ValuationContext(Base):
    status: Literal["complete", "partial", "unavailable"]
    as_of: str | None = None
    comparison_scope: Literal["same_industry_current_snapshot"] = _VALUATION_COMPARISON_SCOPE
    basis: str
    current_pe: float | None = None
    current_pb: float | None = None
    pe: ValuationMetric = Field(default_factory=ValuationMetric)
    pb: ValuationMetric = Field(default_factory=ValuationMetric)
    missing_fields: list[str] = Field(default_factory=list)


class StockSelectionCandidate(Base):
    instrument_id: str
    symbol: str
    exchange: str
    name: str = ""
    industry: str | None = None
    snapshot: dict[str, Any] = Field(default_factory=dict)
    rank: int
    score: float | None = None
    score_contributions: dict[str, float] = Field(default_factory=dict)
    matched_conditions: list[dict[str, Any]] = Field(default_factory=list)
    unmatched_conditions: list[dict[str, Any]] = Field(default_factory=list)
    selection_reasons: list[str] = Field(default_factory=list, max_length=3)
    risk_flags: list[str] = Field(default_factory=list)
    data_quality: Literal["available", "partial", "stale", "unavailable"] = "available"
    missing_fields: list[str] = Field(default_factory=list)
    as_of: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    change_state: Literal["new", "continued", "reentered", "unchanged"] = "new"
    valuation_context: ValuationContext | None = None


class StockSelectionReport(Base):
    schema_version: int = 1
    kind: Literal["stock_selection"] = "stock_selection"
    report_id: str
    workflow_run_id: str
    strategy: SelectionStrategy
    as_of: str | None = None
    universe_count: int = 0
    filtered_count: int = 0
    candidates: list[StockSelectionCandidate] = Field(default_factory=list)
    filter_statistics: list[dict[str, Any]] = Field(default_factory=list)
    validation: dict[str, Any] = Field(default_factory=dict)
    data_quality: dict[str, Any] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    status: Literal["completed", "unavailable", "failed"] = "completed"
    error: dict[str, str] | None = None


OpportunityClaimType = Literal["fact", "inference", "unknown"]
OpportunityPriority = Literal["high", "medium", "low"]
OpportunityStatus = Literal["completed", "partial", "unavailable"]
OpportunityHorizon = Literal["short_term", "medium_term", "long_term"]
_OPPORTUNITY_HORIZONS: tuple[str, ...] = ("short_term", "medium_term", "long_term")


class OpportunityClaim(Base):
    """One source-traceable statement in an AI opportunity report.

    The model only describes the shape.  Source ownership is checked by
    ``StockScreeningService.submit_opportunity_report`` against the immutable
    context file for the candidate.
    """

    text: str = Field(min_length=1, max_length=2000)
    claim_type: OpportunityClaimType
    source_ids: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("text")
    @classmethod
    def _non_empty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("claim text must be non-empty")
        return value

    @field_validator("source_ids")
    @classmethod
    def _unique_source_ids(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for source_id in value:
            if not isinstance(source_id, str) or not source_id.strip():
                raise ValueError("source_ids must contain non-empty strings")
            source_id = source_id.strip()
            if source_id not in cleaned:
                cleaned.append(source_id)
        return cleaned

    @model_validator(mode="after")
    def _requires_evidence(self) -> "OpportunityClaim":
        if self.claim_type in {"fact", "inference"} and not self.source_ids:
            raise ValueError(f"{self.claim_type} claims require at least one source_id")
        return self


class OpportunityHorizonView(Base):
    """One independently auditable research view for a holding horizon."""

    status: Literal["available", "insufficient_data"]
    summary: OpportunityClaim
    supporting_evidence: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    counter_evidence: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    watch_items: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    invalidation_conditions: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    data_gaps: list[OpportunityClaim] = Field(default_factory=list, max_length=20)

    @staticmethod
    def _has_supported_claim(claim: OpportunityClaim) -> bool:
        return claim.claim_type in {"fact", "inference"} and bool(claim.source_ids)

    @model_validator(mode="after")
    def _validate_horizon_evidence(self) -> "OpportunityHorizonView":
        if self.status == "available":
            if not self._has_supported_claim(self.summary):
                raise ValueError("available horizon summary requires a source-backed fact or inference")
            if not any(self._has_supported_claim(claim) for claim in self.supporting_evidence):
                raise ValueError("available horizon requires source-backed supporting_evidence")
            if not any(self._has_supported_claim(claim) for claim in self.counter_evidence):
                raise ValueError("available horizon requires source-backed counter_evidence")
            if not self.watch_items:
                raise ValueError("available horizon requires watch_items")
            if not self.invalidation_conditions:
                raise ValueError("available horizon requires invalidation_conditions")
        elif not self.data_gaps:
            raise ValueError("insufficient_data horizon requires data_gaps")
        return self


OpportunityEventStatus = Literal["available", "insufficient_data"]
OpportunityPricedIn = Literal[
    "not_priced_in",
    "partially_priced_in",
    "fully_priced_in",
    "unknown",
]


class OpportunityEventTransmission(Base):
    """Traceable path from a catalyst event to a candidate's earnings."""

    status: OpportunityEventStatus
    event: OpportunityClaim
    direct_impact: OpportunityClaim
    industry_chain: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    business_exposure: OpportunityClaim
    earnings_path: OpportunityClaim
    validation_window: OpportunityClaim
    priced_in: OpportunityPricedIn
    priced_in_basis: OpportunityClaim | None = None
    counter_evidence: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    invalidation_conditions: list[OpportunityClaim] = Field(
        default_factory=list, max_length=20
    )
    data_gaps: list[OpportunityClaim] = Field(default_factory=list, max_length=20)

    @staticmethod
    def _has_supported_claim(claim: OpportunityClaim) -> bool:
        return claim.claim_type in {"fact", "inference"} and bool(claim.source_ids)

    @model_validator(mode="after")
    def _validate_transmission(self) -> "OpportunityEventTransmission":
        if self.priced_in != "unknown":
            if self.priced_in_basis is None:
                raise ValueError("non-unknown priced_in requires priced_in_basis")
            if not self._has_supported_claim(self.priced_in_basis) or (
                self.priced_in_basis.claim_type != "inference"
            ):
                raise ValueError("priced_in_basis requires a source-backed inference")
        if self.status == "insufficient_data":
            if not self.data_gaps:
                raise ValueError("insufficient_data event transmission requires data_gaps")
            return self
        if self.event.claim_type != "fact" or not self.event.source_ids:
            raise ValueError("available event transmission requires a source-backed event fact")
        if not self._has_supported_claim(self.direct_impact) or (
            self.direct_impact.claim_type != "inference"
        ):
            raise ValueError("available event transmission requires a source-backed direct impact inference")
        if not any(
            self._has_supported_claim(claim) and claim.claim_type == "inference"
            for claim in self.industry_chain
        ):
            raise ValueError("available event transmission requires an industry-chain inference")
        if not self._has_supported_claim(self.business_exposure):
            raise ValueError("available event transmission requires source-backed business exposure")
        if not self._has_supported_claim(self.earnings_path) or (
            self.earnings_path.claim_type != "inference"
        ):
            raise ValueError("available event transmission requires a source-backed earnings-path inference")
        if not self.counter_evidence:
            raise ValueError("available event transmission requires counter_evidence")
        if not self.invalidation_conditions:
            raise ValueError("available event transmission requires invalidation_conditions")
        return self


class OpportunityCandidate(Base):
    instrument_id: str = Field(min_length=1, max_length=32)
    deterministic_rank: int = Field(ge=1, le=_MAX_LIMIT)
    research_priority: OpportunityPriority = "low"
    why_now: OpportunityClaim
    thesis: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    supporting_evidence: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    counter_evidence: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    relative_edge: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    watch_items: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    invalidation_conditions: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    data_gaps: list[OpportunityClaim] = Field(default_factory=list, max_length=20)
    horizon_views: dict[OpportunityHorizon, OpportunityHorizonView]
    event_transmission: OpportunityEventTransmission | None = None
    context_id: str = Field(pattern=r"^ctx_[a-z0-9]{12,64}$")
    source_ids: list[str] = Field(default_factory=list, max_length=64)

    @field_validator("source_ids")
    @classmethod
    def _unique_candidate_source_ids(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for source_id in value:
            if not isinstance(source_id, str) or not source_id.strip():
                raise ValueError("source_ids must contain non-empty strings")
            source_id = source_id.strip()
            if source_id not in cleaned:
                cleaned.append(source_id)
        return cleaned

    @model_validator(mode="after")
    def _requires_all_horizons(self) -> "OpportunityCandidate":
        if set(self.horizon_views) != set(_OPPORTUNITY_HORIZONS):
            raise ValueError("horizon_views must include short_term, medium_term and long_term")
        return self


class OpportunityResearchReport(Base):
    schema_version: int = 2
    kind: Literal["stock_opportunity_research"] = "stock_opportunity_research"
    report_id: str = Field(min_length=1, max_length=128)
    workflow_run_id: str = Field(min_length=1, max_length=96)
    selection_report_id: str = Field(min_length=1, max_length=128)
    as_of: str | None = None
    status: OpportunityStatus = "completed"
    candidate_count: int = Field(ge=0, le=8)
    candidates: list[OpportunityCandidate] = Field(default_factory=list, max_length=8)
    comparison_summary: list[OpportunityClaim] = Field(default_factory=list, max_length=32)
    data_quality: dict[str, Any] = Field(default_factory=dict)
    source_ids: list[str] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def _candidate_count_matches(self) -> "OpportunityResearchReport":
        if self.candidate_count != len(self.candidates):
            raise ValueError("candidate_count must match candidates length")
        return self


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _insufficient_event_transmission_payload(reason: str) -> dict[str, Any]:
    """Build an honest, non-source-backed event gap for catalyst candidates."""
    unknown = {
        "text": "无法核验",
        "claim_type": "unknown",
        "source_ids": [],
    }
    return {
        "status": "insufficient_data",
        "event": dict(unknown),
        "direct_impact": dict(unknown),
        "industry_chain": [],
        "business_exposure": dict(unknown),
        "earnings_path": dict(unknown),
        "validation_window": dict(unknown),
        "priced_in": "unknown",
        "priced_in_basis": None,
        "counter_evidence": [],
        "invalidation_conditions": [],
        "data_gaps": [
            {
                "text": reason,
                "claim_type": "unknown",
                "source_ids": [],
            }
        ],
    }


def _safe_run_id(raw: str | None) -> str:
    value = raw or f"run_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:8]}"
    if not _RUN_RE.fullmatch(value):
        raise ValueError("invalid workflow_run_id")
    return value


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _event_value(event: Any, *keys: str) -> Any:
    """Read provider event fields without coupling L2 to the L1 model shape."""
    if isinstance(event, dict):
        for key in keys:
            if key in event:
                return event[key]
            camel = key.split("_")[0] + "".join(part.title() for part in key.split("_")[1:])
            if camel in event:
                return event[camel]
        return None
    for key in keys:
        value = getattr(event, key, None)
        if value is not None:
            return value
    return None


def _event_source_ids(event: Any) -> list[str]:
    source_ids = _event_value(event, "source_ids", "source_id")
    source = _event_value(event, "source")
    if source is not None:
        source_id = _event_value(source, "id")
        if source_id:
            source_ids = [*(source_ids or []), source_id]
    if isinstance(source_ids, str):
        source_ids = [source_ids]
    return sorted({str(item).strip() for item in (source_ids or []) if str(item).strip()})


def _event_payload(event: Any) -> dict[str, Any]:
    """Normalize one provider event for selection.json and Agent evidence."""
    fields = {
        "event_id": _event_value(event, "event_id", "id"),
        "instrument_id": _event_value(event, "instrument_id"),
        "event_type": _event_value(event, "event_type", "type"),
        "title": _event_value(event, "title") or "",
        "summary": _event_value(event, "summary") or "",
        "url": _event_value(event, "url") or "",
        "published_at": _event_value(event, "published_at", "publish_time", "notice_time"),
        "event_date": _event_value(event, "event_date"),
        "status": _event_value(event, "status") or "published",
        "category_codes": _event_value(event, "category_codes", "category_code") or [],
        "category_names": _event_value(event, "category_names", "category_name") or [],
        "source_ids": _event_source_ids(event),
    }
    for key in ("category_codes", "category_names"):
        if isinstance(fields[key], str):
            fields[key] = [fields[key]]
    # Do not expose a non-serializable SourceRecord in selection.json.  Its
    # stable id is retained in source_ids and the source remains openable from
    # the corresponding Evidence context.
    return fields


def _parse_event_time(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                parsed = None
        if parsed is None:
            return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _event_type_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _event_type_label(value: Any) -> str:
    key = _event_type_key(value)
    return _EVENT_TYPE_LABELS.get(key, str(value).strip() if str(value or "").strip() and not key.isascii() else "公告事件")


def _is_material_event(event: dict[str, Any]) -> bool:
    event_type = _event_type_key(event.get("event_type"))
    if event_type in _NON_MATERIAL_EVENT_TYPES:
        return False
    if event_type in _MATERIAL_EVENT_TYPES:
        return True
    categories = " ".join(str(item) for item in (event.get("category_names") or []))
    text = f"{event.get('title') or ''} {event.get('summary') or ''} {categories}"
    # Unknown categories are not promoted based on title semantics.  Only the
    # explicit material taxonomy can trigger deterministic catalyst screening.
    return any(token in text for token in ("重大", "业绩预告", "业绩快报", "回购", "分红", "并购", "重组", "问询", "处罚", "诉讼", "增持", "减持", "融资"))


def _capture_value(capture: Any, key: str, default: Any = None) -> Any:
    return _event_value(capture, key) if capture is not None else default


def _compare(actual: Any, op: str, expected: Any) -> bool | None:
    if actual is None:
        return None
    if op in {"in", "not_in"}:
        values = expected if isinstance(expected, list) else []
        result = actual in values
        return result if op == "in" else not result
    try:
        if op == ">":
            return actual > expected
        if op == ">=":
            return actual >= expected
        if op == "<":
            return actual < expected
        if op == "<=":
            return actual <= expected
        if op == "=":
            return actual == expected
        if op == "!=":
            return actual != expected
    except (TypeError, ValueError):
        return None
    return None


def _percentile(values: list[float], value: float) -> float:
    if not values:
        return 0.5
    ordered = sorted(values)
    if len(ordered) == 1:
        return 1.0
    below = sum(item <= value for item in ordered)
    return (below - 1) / (len(ordered) - 1)


def _valuation_metric(value: Any, peer_values: Iterable[Any]) -> ValuationMetric:
    current = _as_float(value)
    positive_peers = sorted(
        item for raw in peer_values
        if (item := _as_float(raw)) is not None and item > 0
    )
    if current is None or current <= 0 or len(positive_peers) < _VALUATION_MIN_PEER_COUNT:
        return ValuationMetric(value=current, peer_count=len(positive_peers))
    middle = len(positive_peers) // 2
    median = (
        positive_peers[middle]
        if len(positive_peers) % 2
        else (positive_peers[middle - 1] + positive_peers[middle]) / 2
    )
    return ValuationMetric(
        value=current,
        peer_count=len(positive_peers),
        median=median,
        percentile=_percentile(positive_peers, current),
    )


def _valuation_context(row: MarketSnapshot, rows: Iterable[MarketSnapshot], as_of: str | None) -> ValuationContext:
    peers = [
        item for item in rows
        if item.instrument_id != row.instrument_id and item.industry and item.industry == row.industry
    ]
    pe = _valuation_metric(row.pe, (item.pe for item in peers))
    pb = _valuation_metric(row.pb, (item.pb for item in peers))
    missing_fields: list[str] = []
    for name, current, metric in (("pe", pe.value, pe), ("pb", pb.value, pb)):
        if current is None or current <= 0:
            missing_fields.append(f"current_{name}")
        if metric.peer_count < _VALUATION_MIN_PEER_COUNT:
            missing_fields.append(f"peer_{name}")
    if pe.peer_count < _VALUATION_MIN_PEER_COUNT or pb.peer_count < _VALUATION_MIN_PEER_COUNT:
        missing_fields.append("peer_valuation")
    if not row.industry:
        missing_fields.append("industry_classification")
    has_current = any(metric.value is not None and metric.value > 0 for metric in (pe, pb))
    has_positive_peer = any(metric.peer_count > 0 for metric in (pe, pb))
    complete = not missing_fields
    status = "complete" if complete else "partial" if has_current or has_positive_peer else "unavailable"
    return ValuationContext(
        status=status,
        as_of=as_of or row.as_of,
        comparison_scope=_VALUATION_COMPARISON_SCOPE,
        basis=(
            "同一行业当前快照中除目标公司外的正值 PE/PB 样本用于比较；"
            f"每项指标至少有 {_VALUATION_MIN_PEER_COUNT} 个样本时才计算中位数和分位。"
        ),
        current_pe=pe.value,
        current_pb=pb.value,
        pe=pe,
        pb=pb,
        missing_fields=list(dict.fromkeys(missing_fields)),
    )


def _kline_factors(series: KlineSeries | None) -> dict[str, float | None]:
    if series is None or not series.bars:
        return {}
    closes = [bar.close for bar in series.bars]
    latest = closes[-1]
    def ma(period: int) -> float | None:
        return sum(closes[-period:]) / period if len(closes) >= period else None
    def momentum(period: int) -> float | None:
        if len(closes) <= period or closes[-period - 1] == 0:
            return None
        return (latest / closes[-period - 1] - 1.0) * 100
    recent = closes[-20:]
    mean = sum(recent) / len(recent)
    variance = sum((item - mean) ** 2 for item in recent) / len(recent)
    return {
        "ma5": ma(5),
        "ma20": ma(20),
        "ma60": ma(60),
        "momentum20": momentum(20),
        "momentum60": momentum(60),
        "volatility20": math.sqrt(variance) / mean * 100 if mean else None,
    }


def _condition_payload(condition: SelectionCondition, actual: Any, result: bool | None) -> dict[str, Any]:
    return {
        "field": condition.field,
        "op": condition.op,
        "value": condition.value,
        "actual": actual,
        "matched": result,
    }


BUILTIN_STRATEGIES: tuple[SelectionStrategy, ...] = (
    SelectionStrategy(
        strategy_id="stable_business", name="经营稳健", source="builtin", horizon="long_term",
        filters=[SelectionCondition(field="roe", op=">=", value=8), SelectionCondition(field="debt_ratio", op="<=", value=70)],
        ranking=[RankingFactor(field="roe", weight=0.4), RankingFactor(field="operating_cashflow", weight=0.35), RankingFactor(field="volatility20", direction="asc", weight=0.25)],
    ),
    SelectionStrategy(
        strategy_id="quality_value", name="质量价值", source="builtin", horizon="long_term",
        filters=[SelectionCondition(field="roe", op=">=", value=8), SelectionCondition(field="pe", op=">", value=0), SelectionCondition(field="pe", op="<=", value=35)],
        ranking=[RankingFactor(field="roe", weight=0.4), RankingFactor(field="pe", direction="asc", weight=0.3), RankingFactor(field="operating_cashflow", weight=0.3)],
    ),
    SelectionStrategy(
        strategy_id="quality_growth", name="业绩成长", source="builtin", horizon="medium_term",
        filters=[SelectionCondition(field="revenue_yoy", op=">=", value=20), SelectionCondition(field="profit_yoy", op=">=", value=15)],
        ranking=[RankingFactor(field="profit_yoy", weight=0.45), RankingFactor(field="revenue_yoy", weight=0.3), RankingFactor(field="roe", weight=0.25)],
    ),
    SelectionStrategy(
        strategy_id="trend_confirmation", name="趋势机会", source="builtin", horizon="swing",
        filters=[SelectionCondition(field="momentum20", op=">=", value=0), SelectionCondition(field="momentum60", op=">=", value=0)],
        ranking=[RankingFactor(field="momentum20", weight=0.5), RankingFactor(field="momentum60", weight=0.3), RankingFactor(field="volatility20", direction="asc", weight=0.2)],
    ),
    SelectionStrategy(
        strategy_id="volume_breakout", name="放量突破", source="builtin", horizon="short_term",
        filters=[SelectionCondition(field="momentum20", op=">=", value=5), SelectionCondition(field="change_pct", op=">=", value=0)],
        ranking=[RankingFactor(field="momentum20", weight=0.55), RankingFactor(field="volume", weight=0.45)],
    ),
    SelectionStrategy(
        strategy_id="low_volatility", name="低波动", source="builtin", horizon="medium_term",
        filters=[SelectionCondition(field="volatility20", op="<=", value=5)],
        ranking=[RankingFactor(field="volatility20", direction="asc", weight=0.6), RankingFactor(field="roe", weight=0.4)],
    ),
    SelectionStrategy(
        strategy_id="recent_catalyst", name="近期催化", source="builtin", availability="available",
        horizon="swing", filters=[], ranking=[],
    ),
    SelectionStrategy(
        strategy_id="theme_beneficiary", name="主题受益", source="builtin", availability="unavailable",
        unavailable_reason="当前主题映射与产业链真实性数据源尚未接入，不能可靠筛选主题受益股",
        horizon="medium_term", filters=[], ranking=[],
    ),
)


class ScreeningStore:
    """Small SQLite store for reusable snapshots, strategies and run metadata."""

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root or (Path.home() / ".mona" / "stock"))
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "screening.db"
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS instrument_snapshot (
                  instrument_id TEXT NOT NULL, as_of TEXT NOT NULL, payload TEXT NOT NULL,
                  PRIMARY KEY(instrument_id, as_of)
                );
                CREATE TABLE IF NOT EXISTS factor_snapshot (
                  instrument_id TEXT NOT NULL, as_of TEXT NOT NULL, algorithm_version TEXT NOT NULL,
                  payload TEXT NOT NULL, PRIMARY KEY(instrument_id, as_of, algorithm_version)
                );
                CREATE TABLE IF NOT EXISTS selection_strategy (
                  strategy_id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL,
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS selection_evaluation (
                  run_id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, as_of TEXT,
                  status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS event_capture (
                  cache_key TEXT PRIMARY KEY, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
                  fetched_at TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                """
            )

    def save_snapshots(self, snapshots: Iterable[MarketSnapshot], as_of: str) -> None:
        rows = [(item.instrument_id, as_of, item.model_dump_json()) for item in snapshots]
        if not rows:
            return
        with self._connect() as conn:
            conn.executemany("INSERT OR REPLACE INTO instrument_snapshot VALUES (?, ?, ?)", rows)

    def save_factors(self, instrument_id: str, as_of: str, factors: dict[str, Any], algorithm_version: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO factor_snapshot VALUES (?, ?, ?, ?)",
                (instrument_id, as_of, algorithm_version, json.dumps(factors, ensure_ascii=False)),
            )

    def latest_snapshots(self, as_of: str | None = None) -> list[MarketSnapshot]:
        with self._connect() as conn:
            if as_of:
                rows = conn.execute("SELECT payload FROM instrument_snapshot WHERE as_of = ?", (as_of,)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.payload FROM instrument_snapshot s JOIN (SELECT instrument_id, MAX(as_of) as a FROM instrument_snapshot GROUP BY instrument_id) x ON x.instrument_id=s.instrument_id AND x.a=s.as_of"
                ).fetchall()
        return [MarketSnapshot.model_validate_json(row[0]) for row in rows]

    def save_strategy(self, strategy: SelectionStrategy) -> None:
        now = strategy.updated_at or _now()
        created = strategy.created_at or now
        normalized = strategy.model_copy(update={"created_at": created, "updated_at": now})
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO selection_strategy VALUES (?, ?, ?, ?, ?)",
                (normalized.strategy_id, normalized.source, normalized.model_dump_json(), created, now),
            )

    def delete_strategy(self, strategy_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM selection_strategy WHERE strategy_id = ?", (strategy_id,))
            return cur.rowcount > 0

    def list_strategies(self) -> list[SelectionStrategy]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM selection_strategy ORDER BY updated_at DESC").fetchall()
        return [SelectionStrategy.model_validate_json(row[0]) for row in rows]

    def save_run(self, report: StockSelectionReport) -> None:
        summary = report.model_copy(update={"candidates": []}).model_dump_json()
        summary_payload = json.loads(summary)
        summary_payload["_candidate_ids"] = [item.instrument_id for item in report.candidates]
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO selection_evaluation VALUES (?, ?, ?, ?, ?, ?)",
                (report.workflow_run_id, report.strategy.strategy_id, report.as_of, report.status, json.dumps(summary_payload, ensure_ascii=False), _now()),
            )

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM selection_evaluation ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def save_event_capture(self, payload: dict[str, Any]) -> None:
        """Persist the latest bounded event window atomically by cache key."""
        key = "recent_catalyst"
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO event_capture VALUES (?, ?, ?, ?, ?, ?)",
                (
                    key,
                    str(payload.get("window_start") or ""),
                    str(payload.get("window_end") or ""),
                    str(payload.get("fetched_at") or _now()),
                    json.dumps(payload, ensure_ascii=False),
                    _now(),
                ),
            )

    def latest_event_capture(self) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM event_capture WHERE cache_key = ?", ("recent_catalyst",)
            ).fetchone()
        if row is None:
            return None
        try:
            payload = json.loads(row[0])
        except (TypeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None


def _default_strategies() -> list[SelectionStrategy]:
    return [item.model_copy(deep=True) for item in BUILTIN_STRATEGIES]


class StockScreeningService:
    """Stable entry point for Agent tools and HTTP adapters.

    ``run`` accepts an optional explicit ``universe`` for tests and for an
    authorised full-market adapter.  Without either it asks the provider for
    ``market_snapshot``; if the provider cannot supply point-in-time rows the
    result is explicitly ``unavailable``.
    """

    FACTOR_VERSION = "screening-factor-v1"

    def __init__(self, provider: Any | None = None, *, root: str | Path | None = None, workspace: str | Path | None = None, store: ScreeningStore | None = None):
        self.provider = provider
        self.root = Path(root or (Path.home() / ".mona" / "stock"))
        self.store = store or ScreeningStore(self.root)
        self.workspace = Path(workspace).expanduser() if workspace else None

    def templates(self) -> list[dict[str, Any]]:
        return [item.model_dump(by_alias=True) for item in _default_strategies()]

    def strategies(self) -> list[SelectionStrategy]:
        return _default_strategies() + self.store.list_strategies()

    def resolve_strategy(self, raw: str | dict[str, Any] | SelectionStrategy) -> SelectionStrategy:
        if isinstance(raw, SelectionStrategy):
            strategy = raw
        elif isinstance(raw, dict):
            try:
                strategy = SelectionStrategy.model_validate(raw)
            except Exception as exc:
                raise ScreeningValidationError(str(exc)) from exc
        else:
            strategy = next((item for item in self.strategies() if item.strategy_id == raw), None)
            if strategy is None:
                raise ScreeningValidationError(f"unknown strategy {raw!r}")
        return strategy

    def save_strategy(self, raw: dict[str, Any] | SelectionStrategy) -> SelectionStrategy:
        strategy = self.resolve_strategy(raw)
        builtin_ids = {item.strategy_id for item in BUILTIN_STRATEGIES}
        if strategy.strategy_id == "natural_language":
            # Every confirmed natural-language strategy is a separate user
            # object; a fixed id would silently overwrite the prior one.
            strategy = strategy.model_copy(
                update={"source": "user", "strategy_id": f"natural_language_{uuid.uuid4().hex[:10]}"}
            )
        elif strategy.source == "builtin" or strategy.strategy_id in builtin_ids:
            candidate = strategy.model_copy(update={"source": "user", "strategy_id": ""})
            signature = candidate.model_dump(exclude={"strategy_id", "created_at", "updated_at"})
            existing = next(
                (
                    item
                    for item in self.store.list_strategies()
                    if item.model_dump(exclude={"strategy_id", "created_at", "updated_at"}) == signature
                ),
                None,
            )
            if existing is not None:
                return existing
            base = f"{strategy.strategy_id}_copy"
            taken = {item.strategy_id for item in self.strategies()}
            copy_id = base
            suffix = 2
            while copy_id in taken:
                copy_id = f"{base}_{suffix}"
                suffix += 1
            strategy = candidate.model_copy(update={"strategy_id": copy_id})
        self.store.save_strategy(strategy)
        return strategy

    def delete_strategy(self, strategy_id: str) -> bool:
        if any(item.strategy_id == strategy_id for item in BUILTIN_STRATEGIES):
            return False
        return self.store.delete_strategy(strategy_id)

    async def _universe(self, explicit: Iterable[MarketSnapshot | dict[str, Any]] | None, as_of: str | None) -> tuple[list[MarketSnapshot], str, str]:
        if explicit is not None:
            rows = [item if isinstance(item, MarketSnapshot) else MarketSnapshot.model_validate(item) for item in explicit]
            stamp = as_of or next((item.as_of for item in rows if item.as_of), None) or _now()
            return rows, stamp, "available"
        if self.provider is None or not hasattr(self.provider, "market_snapshot"):
            cached = self.store.latest_snapshots()
            if cached:
                stamp = max((item.as_of or "" for item in cached), default="")
                return cached, stamp, "stale"
            return [], as_of or _now(), "unavailable"
        try:
            rows = await self.provider.market_snapshot()
        except (ProviderError, OSError, RuntimeError):
            cached = self.store.latest_snapshots()
            if cached:
                stamp = max((item.as_of or "" for item in cached), default="")
                return cached, stamp, "stale"
            return [], as_of or _now(), "unavailable"
        snapshots = [item if isinstance(item, MarketSnapshot) else MarketSnapshot.model_validate(item) for item in rows]
        stamp = as_of or next((item.as_of for item in snapshots if item.as_of), None) or _now()
        self.store.save_snapshots(snapshots, stamp)
        return snapshots, stamp, "available"

    @staticmethod
    def _snapshot_values(snapshot: MarketSnapshot, factors: dict[str, Any], fundamentals: dict[str, Any] | None = None) -> dict[str, Any]:
        values = snapshot.model_dump()
        values.update(factors)
        if fundamentals:
            values.update({key: value for key, value in fundamentals.items()})
        return values

    def _hard_filter(self, strategy: SelectionStrategy, row: MarketSnapshot) -> tuple[bool, list[str]]:
        reasons: list[str] = []
        if row.exchange not in strategy.universe.markets or row.instrument_type not in strategy.universe.instrument_types:
            return False, ["股票池范围"]
        if strategy.universe.industries and row.industry not in strategy.universe.industries:
            return False, ["行业范围"]
        if strategy.universe.exclude_st and row.is_st:
            return False, ["ST风险"]
        if strategy.universe.exclude_suspended and row.is_suspended:
            return False, ["停牌"]
        if row.listing_days is not None and row.listing_days < strategy.universe.min_listing_days:
            return False, ["上市天数"]
        if strategy.universe.min_daily_amount is not None and (row.turnover is None or row.turnover < strategy.universe.min_daily_amount):
            return False, ["成交额"]
        return True, reasons

    async def _enrich(self, row: MarketSnapshot, fields: set[str]) -> tuple[dict[str, Any], list[str], list[str]]:
        values: dict[str, Any] = {}
        missing: list[str] = []
        source_ids = list(row.source_ids)
        inst = InstrumentRef(exchange=row.exchange, symbol=row.symbol, instrument_type=row.instrument_type)
        if fields & {"ma5", "ma20", "ma60", "momentum20", "momentum60", "volatility20"}:
            try:
                if self.provider is None:
                    raise ProviderError("provider unavailable")
                series = await self.provider.kline(inst, limit=120)
                values.update(_kline_factors(series))
                source_ids.append(series.source.id)
            except Exception:
                missing.extend(sorted(fields & {"ma5", "ma20", "ma60", "momentum20", "momentum60", "volatility20"}))
        fundamental_fields = fields & {"roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy", "net_profit", "operating_cashflow", "debt_ratio", "eps"}
        if fundamental_fields:
            try:
                if self.provider is None:
                    raise ProviderError("provider unavailable")
                fundamentals: Fundamentals = await self.provider.fundamentals(inst)
                values.update(fundamentals.metrics)
                source_ids.append(fundamentals.source.id)
            except Exception:
                missing.extend(sorted(fundamental_fields))
        return values, sorted(set(missing)), sorted(set(source_ids))

    @staticmethod
    def _catalyst_window(as_of: str | None) -> tuple[str, str]:
        end = _parse_event_time(as_of) or datetime.now(timezone.utc)
        start = end - timedelta(days=_CATALYST_WINDOW_DAYS)
        return start.isoformat(), end.isoformat()

    @staticmethod
    def _capture_payload(capture: Any, *, window_start: str, window_end: str, cache_status: str) -> dict[str, Any] | None:
        if capture is None:
            return None
        raw_events = _capture_value(capture, "events", None)
        if raw_events is None and isinstance(capture, (list, tuple)):
            raw_events = list(capture)
        if raw_events is None:
            raw_events = []
        events = [_event_payload(item) for item in raw_events]
        fetched_at = _capture_value(capture, "fetched_at") or _now()
        payload = {
            "events": events,
            "window_start": _capture_value(capture, "window_start") or window_start,
            "window_end": _capture_value(capture, "window_end") or window_end,
            "expected_count": _capture_value(capture, "expected_count"),
            "loaded_count": _capture_value(capture, "loaded_count", len(events)) or len(events),
            "complete": bool(_capture_value(capture, "complete", True)),
            "fetched_at": fetched_at,
            "provider": _capture_value(capture, "provider") or "market_events",
            "error": _capture_value(capture, "error"),
            "cache_status": cache_status,
            "data_cutoff_at": _capture_value(capture, "window_end") or window_end,
        }
        return payload

    @staticmethod
    def _cache_age_seconds(payload: dict[str, Any]) -> float | None:
        fetched_at = _parse_event_time(payload.get("fetched_at"))
        if fetched_at is None:
            return None
        return max(0.0, (datetime.now(timezone.utc) - fetched_at).total_seconds())

    @staticmethod
    def _capture_covers(payload: dict[str, Any], window_start: str, window_end: str) -> bool:
        start = _parse_event_time(payload.get("window_start"))
        end = _parse_event_time(payload.get("window_end"))
        requested_start = _parse_event_time(window_start)
        requested_end = _parse_event_time(window_end)
        if not (start and end and requested_start and requested_end and start <= requested_start):
            return False
        # A fresh capture made earlier in the same trading day is still a
        # valid reusable window; its exact cutoff is surfaced to the caller.
        return end >= requested_end or end.date() == requested_end.date()

    @staticmethod
    def _capture_start_covers(payload: dict[str, Any], window_start: str) -> bool:
        start = _parse_event_time(payload.get("window_start"))
        requested_start = _parse_event_time(window_start)
        return bool(start and requested_start and start <= requested_start)

    async def _recent_catalyst_capture(self, *, as_of: str | None) -> tuple[dict[str, Any] | None, str]:
        window_start, window_end = self._catalyst_window(as_of)
        cached = self.store.latest_event_capture()
        if cached and self._capture_covers(cached, window_start, window_end):
            age = self._cache_age_seconds(cached)
            if age is not None and age <= _EVENT_FRESH_SECONDS:
                fresh = dict(cached)
                fresh["cache_status"] = "fresh_cache"
                fresh["data_cutoff_at"] = cached.get("window_end")
                return fresh, "fresh_cache"

        method = getattr(self.provider, "market_events", None) if self.provider is not None else None
        if method is not None:
            try:
                capture = await method(
                    since=window_start,
                    until=window_end,
                    symbols=None,
                    limit=5000,
                )
                payload = self._capture_payload(
                    capture,
                    window_start=window_start,
                    window_end=window_end,
                    cache_status="live",
                )
                if payload is not None:
                    self.store.save_event_capture(payload)
                    return payload, "live"
            except Exception as exc:
                logger.warning("stock market events unavailable: {}", exc)

        if cached and self._capture_start_covers(cached, window_start):
            age = self._cache_age_seconds(cached)
            if age is not None and age <= _EVENT_STALE_SECONDS:
                stale = dict(cached)
                stale["cache_status"] = "stale_cache"
                stale["data_cutoff_at"] = cached.get("window_end")
                return stale, "stale_cache"
        return None, "unavailable"

    @staticmethod
    def _event_rank(event: dict[str, Any]) -> int:
        event_type = _event_type_key(event.get("event_type"))
        if event_type in {"risk_warning", "penalty", "litigation", "inquiry", "suspension"}:
            return 1
        if event_type in {"earnings", "earnings_report", "earnings_forecast", "performance_forecast", "earnings_express", "report"}:
            return 5
        if event_type in {"buyback", "dividend", "share_reduction", "share_increase", "financing"}:
            return 4
        if event_type in {"merger", "restructuring", "asset_sale", "major_contract", "project", "license", "product", "major_event", "material_event", "major_matter"}:
            return 3
        if event_type in {"shareholder_change", "share_change"}:
            return 4
        return 2

    async def _run_recent_catalyst(
        self,
        selected: SelectionStrategy,
        workflow_run_id: str,
        rows: list[MarketSnapshot],
        stamp: str,
        market_quality: str,
    ) -> dict[str, Any]:
        capture, capture_status = await self._recent_catalyst_capture(as_of=stamp)
        if capture is None:
            report = StockSelectionReport(
                report_id=f"stock_selection_{workflow_run_id}",
                workflow_run_id=workflow_run_id,
                strategy=selected,
                as_of=stamp,
                universe_count=len(rows),
                status="unavailable",
                data_quality={
                    "status": "unavailable",
                    "reason": "近期公告事件源不可用，且没有24小时内可复用的事件缓存",
                    "event_capture": {"status": capture_status, "window_days": _CATALYST_WINDOW_DAYS},
                },
                validation={"status": "unavailable", "reason": "缺少可核验的近期事件 capture"},
                error={"code": "event_data_unavailable", "message": "近期公告事件源不可用，无法可靠筛选近期催化"},
            )
            self.store.save_run(report)
            self._write_report(report)
            return report.model_dump(by_alias=True)

        by_instrument: dict[str, list[dict[str, Any]]] = {}
        for raw in capture.get("events") or []:
            event = raw if isinstance(raw, dict) else _event_payload(raw)
            instrument_id = str(event.get("instrument_id") or "").strip()
            published = _parse_event_time(event.get("published_at"))
            if not instrument_id or published is None or not _is_material_event(event):
                continue
            by_instrument.setdefault(instrument_id, []).append(event)
        for items in by_instrument.values():
            items.sort(
                key=lambda item: (
                    -self._event_rank(item),
                    -(_parse_event_time(item.get("published_at")) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(),
                    str(item.get("event_id") or item.get("title") or ""),
                )
            )

        hard_rows: list[MarketSnapshot] = []
        filtered_reasons: dict[str, int] = {}
        for row in rows:
            ok, reasons = self._hard_filter(selected, row)
            if ok:
                hard_rows.append(row)
            else:
                for reason in reasons:
                    filtered_reasons[reason] = filtered_reasons.get(reason, 0) + 1
        matched = [(row, by_instrument.get(row.instrument_id, [])[:3]) for row in hard_rows if by_instrument.get(row.instrument_id)]
        matched.sort(
            key=lambda pair: (
                -self._event_rank(pair[1][0]),
                -(_parse_event_time(pair[1][0].get("published_at")) or datetime.min.replace(tzinfo=timezone.utc)).timestamp(),
                -(pair[0].turnover or 0.0),
                pair[0].instrument_id,
            )
        )
        previous_ids = self._previous_candidate_ids(selected.strategy_id)
        candidates: list[StockSelectionCandidate] = []
        report_sources: set[str] = set()
        risk_types = {"risk_warning", "penalty", "litigation", "inquiry", "suspension"}
        for rank, (row, events) in enumerate(matched[: selected.limit], start=1):
            event_sources = sorted({source_id for event in events for source_id in event.get("source_ids") or []})
            source_ids = sorted(set(row.source_ids) | set(event_sources))
            reasons = [
                f"{_event_type_label(event.get('event_type'))}：{event.get('title') or '未命名公告'}（公开于 {event.get('published_at') or '未知时间'}）"
                for event in events[:3]
            ]
            risks = [
                "包含风险类公告，需核验影响方向"
                for event in events
                if _event_type_key(event.get("event_type")) in risk_types
            ]
            candidates.append(
                StockSelectionCandidate(
                    instrument_id=row.instrument_id,
                    symbol=row.symbol,
                    exchange=row.exchange,
                    name=row.name,
                    industry=row.industry,
                    snapshot={
                        key: getattr(row, key)
                        for key in ("price", "change_pct", "volume", "turnover", "market_cap", "pe", "pb")
                    } | {"catalyst_events": events},
                    rank=rank,
                    score=None,
                    selection_reasons=reasons or ["命中近期可核验材料事件"],
                    risk_flags=risks or ["事件影响方向需结合基本面与行情核验"],
                    data_quality=("stale" if capture_status == "stale_cache" else ("partial" if not capture.get("complete", True) else market_quality)),
                    missing_fields=[] if capture.get("complete", True) else ["full_event_window_coverage"],
                    as_of=row.as_of or stamp,
                    source_ids=source_ids,
                    change_state="continued" if row.instrument_id in previous_ids else "new",
                    valuation_context=_valuation_context(row, rows, stamp),
                )
            )
            report_sources.update(source_ids)
        report_quality = "stale" if capture_status == "stale_cache" else ("partial" if not capture.get("complete", True) else market_quality)
        event_meta = {
            key: capture.get(key)
            for key in ("window_start", "window_end", "data_cutoff_at", "expected_count", "loaded_count", "complete", "fetched_at", "provider", "cache_status", "error")
        }
        report = StockSelectionReport(
            report_id=f"stock_selection_{workflow_run_id}",
            workflow_run_id=workflow_run_id,
            strategy=selected,
            as_of=stamp,
            universe_count=len(rows),
            filtered_count=len(matched),
            candidates=candidates,
            filter_statistics=[
                {"stage": "universe", "before": len(rows), "after": len(hard_rows)},
                *({"condition": reason, "filtered": count} for reason, count in sorted(filtered_reasons.items())),
                {"stage": "recent_catalyst", "before": len(hard_rows), "after": len(matched), "window_days": _CATALYST_WINDOW_DAYS},
            ],
            validation={"status": "available", "reason": "由公开事件类型、发布时间和证券映射确定性筛选"},
            data_quality={
                "status": report_quality,
                "reason": "当前窗口无命中材料事件" if not candidates else None,
                "event_capture": event_meta,
            },
            missing_fields=["full_event_window_coverage"] if not capture.get("complete", True) else [],
            source_ids=sorted(report_sources),
            status="completed",
        )
        self.store.save_run(report)
        self._write_report(report)
        return report.model_dump(by_alias=True)

    async def _run_combined(
        self,
        selected: SelectionStrategy,
        workflow_run_id: str,
        rows: list[MarketSnapshot],
        stamp: str,
    ) -> dict[str, Any]:
        """Union selected directions, then rank the shared candidate pool once."""
        reports: list[StockSelectionReport] = []
        for strategy_id in selected.included_strategy_ids:
            payload = await self.run(
                strategy_id,
                run_id=workflow_run_id,
                universe=rows,
                as_of=stamp,
            )
            reports.append(StockSelectionReport.model_validate(payload))

        merged: dict[str, dict[str, Any]] = {}
        quality_order = {"available": 0, "partial": 1, "stale": 2, "unavailable": 3}
        for report in reports:
            direction_id = report.strategy.strategy_id
            direction_name = _DISCOVERY_STRATEGIES[direction_id]
            for candidate in report.candidates:
                item = merged.setdefault(candidate.instrument_id, {
                    "candidate": candidate.model_dump(),
                    "score": 0.0,
                    "best_rank": candidate.rank,
                    "directions": [],
                })
                item["score"] += 1.0 / (60 + candidate.rank)
                item["best_rank"] = min(item["best_rank"], candidate.rank)
                item["directions"].append({
                    "strategy_id": direction_id,
                    "name": direction_name,
                    "rank": candidate.rank,
                })
                base = item["candidate"]
                base["source_ids"] = sorted(set(base.get("source_ids") or []) | set(candidate.source_ids))
                base["risk_flags"] = list(dict.fromkeys([*(base.get("risk_flags") or []), *candidate.risk_flags]))
                base["missing_fields"] = sorted(set(base.get("missing_fields") or []) | set(candidate.missing_fields))
                base["matched_conditions"] = [
                    *base.get("matched_conditions", []),
                    *[condition for condition in candidate.matched_conditions if condition not in base.get("matched_conditions", [])],
                ]
                base["data_quality"] = max(
                    (base.get("data_quality", "available"), candidate.data_quality),
                    key=lambda value: quality_order.get(value, 1),
                )
                snapshot = base.setdefault("snapshot", {})
                for key, value in candidate.snapshot.items():
                    if key == "catalyst_events":
                        snapshot[key] = [
                            *snapshot.get(key, []),
                            *[event for event in value if event not in snapshot.get(key, [])],
                        ]
                    elif key == "factors":
                        snapshot[key] = {**snapshot.get(key, {}), **value}
                    elif snapshot.get(key) is None:
                        snapshot[key] = value

        previous_ids = self._previous_candidate_ids(selected.strategy_id)
        ranked = sorted(
            merged.values(),
            key=lambda item: (-item["score"], item["best_rank"], item["candidate"]["instrument_id"]),
        )[: selected.limit]
        candidates: list[StockSelectionCandidate] = []
        for rank, item in enumerate(ranked, start=1):
            payload = item["candidate"]
            directions = sorted(item["directions"], key=lambda direction: direction["rank"])
            payload.update({
                "rank": rank,
                "score": round(item["score"], 6),
                "score_contributions": {
                    _DISCOVERY_STRATEGIES[direction["strategy_id"]]: round(1.0 / (60 + direction["rank"]), 6)
                    for direction in directions
                },
                "selection_reasons": [
                    f"命中方向：{'、'.join(direction['name'] for direction in directions)}",
                    *(payload.get("selection_reasons") or []),
                ][:3],
                "change_state": "continued" if payload["instrument_id"] in previous_ids else "new",
            })
            payload.setdefault("snapshot", {})["matched_strategies"] = directions
            candidates.append(StockSelectionCandidate.model_validate(payload))

        available_reports = [report for report in reports if report.status == "completed"]
        catalyst_report = next((item for item in reports if item.strategy.strategy_id == "recent_catalyst"), None)
        catalyst_capture = catalyst_report.data_quality.get("event_capture") if catalyst_report else None
        direction_quality = [str(item.data_quality.get("status") or "partial") for item in reports]
        combined_quality = max(direction_quality, key=lambda value: quality_order.get(value, 1))
        if available_reports and len(available_reports) != len(reports):
            combined_quality = "partial"
        report = StockSelectionReport(
            report_id=f"stock_selection_{workflow_run_id}",
            workflow_run_id=workflow_run_id,
            strategy=selected,
            as_of=stamp,
            universe_count=len(rows),
            filtered_count=len(merged),
            candidates=candidates,
            filter_statistics=[{
                "direction": _DISCOVERY_STRATEGIES[item.strategy.strategy_id],
                "candidate_count": len(item.candidates),
                "status": item.status,
            } for item in reports],
            validation={"status": "available", "reason": "各方向独立筛选后取并集，并按跨方向名次统一排序"},
            data_quality={
                "status": combined_quality,
                "directions": [item.data_quality for item in reports],
                "event_capture": catalyst_capture,
            },
            missing_fields=sorted({field for item in candidates for field in item.missing_fields}),
            source_ids=sorted({source_id for item in candidates for source_id in item.source_ids}),
            status="completed" if available_reports else "unavailable",
        )
        self.store.save_run(report)
        self._write_report(report)
        return report.model_dump(by_alias=True)

    async def run(
        self,
        strategy: str | dict[str, Any] | SelectionStrategy | None = None,
        *,
        strategy_id: str | None = None,
        run_id: str | None = None,
        universe: Iterable[MarketSnapshot | dict[str, Any]] | None = None,
        symbols: list[str] | None = None,
        as_of: str | None = None,
    ) -> dict[str, Any]:
        if strategy is None:
            strategy = strategy_id
        if strategy is None:
            raise ScreeningValidationError("strategy or strategy_id is required")
        selected = self.resolve_strategy(strategy)
        workflow_run_id = _safe_run_id(run_id)
        if selected.availability == "unavailable":
            report = StockSelectionReport(
                report_id=f"stock_selection_{workflow_run_id}",
                workflow_run_id=workflow_run_id,
                strategy=selected,
                as_of=as_of or _now(),
                status="unavailable",
                data_quality={
                    "status": "unavailable",
                    "reason": selected.unavailable_reason or "策略所需数据能力尚未接入",
                },
                validation={
                    "status": "unavailable",
                    "reason": selected.unavailable_reason or "策略所需数据能力尚未接入",
                },
                error={
                    "code": "strategy_unavailable",
                    "message": selected.unavailable_reason or "策略所需数据能力尚未接入",
                },
            )
            self.store.save_run(report)
            self._write_report(report)
            return report.model_dump(by_alias=True)
        if universe is None and symbols is not None:
            universe = await self._symbols_universe(symbols)
        rows, stamp, quality = await self._universe(universe, as_of)
        if not rows:
            report = StockSelectionReport(
                report_id=f"stock_selection_{workflow_run_id}", workflow_run_id=workflow_run_id,
                strategy=selected, as_of=stamp, status="unavailable",
                data_quality={"status": "unavailable", "reason": "没有可用的全市场时点数据"},
                validation={"status": "unavailable", "reason": "缺少有时间点一致性的股票池和行情数据"},
                error={"code": "market_data_unavailable", "message": "没有可用的全市场时点数据"},
            )
            self.store.save_run(report)
            self._write_report(report)
            return report.model_dump(by_alias=True)
        self.store.save_snapshots(rows, stamp)
        if selected.strategy_id == "combined_discovery":
            return await self._run_combined(selected, workflow_run_id, rows, stamp)
        if selected.strategy_id == "recent_catalyst":
            return await self._run_recent_catalyst(selected, workflow_run_id, rows, stamp, quality)

        hard_rows: list[MarketSnapshot] = []
        stats: list[dict[str, Any]] = []
        reasons_count: dict[str, int] = {}
        for row in rows:
            ok, reasons = self._hard_filter(selected, row)
            if ok:
                hard_rows.append(row)
            else:
                for reason in reasons:
                    reasons_count[reason] = reasons_count.get(reason, 0) + 1
        stats.append({"stage": "universe", "before": len(rows), "after": len(hard_rows)})
        stats.extend({"condition": reason, "filtered": count} for reason, count in sorted(reasons_count.items()))

        fields = {item.field for item in selected.filters} | {item.field for item in selected.ranking}
        snapshot_conditions = [item for item in selected.filters if item.field in _SNAPSHOT_FIELDS]
        cheap_rows: list[MarketSnapshot] = []
        for row in hard_rows:
            values = row.model_dump()
            if all(
                _compare(values.get(condition.field), condition.op, condition.value) is not False
                for condition in snapshot_conditions
            ):
                cheap_rows.append(row)
        if snapshot_conditions:
            stats.append({"stage": "cheap_conditions", "before": len(hard_rows), "after": len(cheap_rows)})
        enrichment_fields = fields - _SNAPSHOT_FIELDS
        skipped_for_cap = 0
        if enrichment_fields:
            enrichment_limit = min(_MAX_ENRICHMENT_ROWS, max(50, selected.limit * 5))
            # Market-wide enrichment is bounded.  Use a visible, deterministic
            # liquidity preselection so provider order cannot change the sample.
            candidate_rows = sorted(
                cheap_rows,
                key=lambda row: (
                    row.turnover is None,
                    -(row.turnover or 0.0),
                    row.market_cap is None,
                    -(row.market_cap or 0.0),
                    row.instrument_id,
                ),
            )[:enrichment_limit]
            skipped_for_cap = max(0, len(cheap_rows) - len(candidate_rows))
            stats.append({
                "stage": "enrichment_cap",
                "before": len(cheap_rows),
                "after": len(candidate_rows),
                "limit": enrichment_limit,
                "unprocessed": skipped_for_cap,
                "preselection_basis": "turnover_desc,market_cap_desc,instrument_id_asc",
            })
        else:
            candidate_rows = cheap_rows
        enriched: list[tuple[MarketSnapshot, dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[str], list[str]]] = []
        semaphore = asyncio.Semaphore(_ENRICHMENT_CONCURRENCY)

        async def enrich_one(row: MarketSnapshot):
            async with semaphore:
                return row, await self._enrich(row, enrichment_fields)

        enriched_inputs = await asyncio.gather(*(enrich_one(row) for row in candidate_rows))
        for row, (factors, missing, sources) in enriched_inputs:
            self.store.save_factors(row.instrument_id, stamp, factors, self.FACTOR_VERSION)
            values = self._snapshot_values(row, factors)
            matched: list[dict[str, Any]] = []
            unmatched: list[dict[str, Any]] = []
            for condition in selected.filters:
                result = _compare(values.get(condition.field), condition.op, condition.value)
                item = _condition_payload(condition, values.get(condition.field), result)
                (matched if result is True else unmatched).append(item)
            if unmatched:
                continue
            enriched.append((row, values, matched, unmatched, missing, sources))
        stats.append({"stage": "conditions", "before": len(candidate_rows), "after": len(enriched)})

        rankings: list[tuple[float, tuple[Any, ...], int]] = []
        ranking_contributions: dict[int, dict[str, float]] = {}
        normalization_modes: dict[str, str] = {}
        for index, (_row, values, _matched, _unmatched, _missing, _sources) in enumerate(enriched):
            score = 0.0
            contributions: dict[str, float] = {}
            total_weight = sum(item.weight for item in selected.ranking) or 1.0
            for factor in selected.ranking:
                actual = _as_float(values.get(factor.field))
                peer_rows = enriched
                if factor.field in {"pe", "pb", "roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy", "debt_ratio", "operating_cashflow"} and values.get("industry"):
                    industry_rows = [item for item in enriched if item[1].get("industry") == values.get("industry")]
                    if len(industry_rows) >= 2:
                        peer_rows = industry_rows
                        normalization_modes[factor.field] = "industry"
                    else:
                        normalization_modes.setdefault(factor.field, "market_fallback")
                peer_values = [_as_float(item[1].get(factor.field)) for item in peer_rows]
                numeric = [item for item in peer_values if item is not None]
                if actual is None or not numeric:
                    continue
                percentile = _percentile(numeric, actual)
                contribution = (percentile if factor.direction == "desc" else 1.0 - percentile) * factor.weight / total_weight
                score += contribution
                contributions[factor.field] = round(contribution, 6)
            ranking_contributions[index] = contributions
            rankings.append((score, tuple(values.get(f.field) for f in selected.ranking), index))
        rankings.sort(key=lambda item: (-item[0], item[2]))
        previous_ids = self._previous_candidate_ids(selected.strategy_id)
        candidates: list[StockSelectionCandidate] = []
        report_sources: set[str] = set()
        for rank, (score, _key, index) in enumerate(rankings[: selected.limit], start=1):
            row, values, matched, unmatched, missing, sources = enriched[index]
            contributions = ranking_contributions.get(index, {})
            reasons = self._reasons(row, values, selected)
            risks = self._risks(row, values, missing)
            quality_value = "partial" if missing else quality
            state = "continued" if row.instrument_id in previous_ids else "new"
            candidates.append(StockSelectionCandidate(
                instrument_id=row.instrument_id, symbol=row.symbol, exchange=row.exchange,
                name=row.name, industry=row.industry, snapshot={
                    **{key: values.get(key) for key in ("price", "change_pct", "volume", "turnover", "market_cap", "pe", "pb")},
                    "factors": {field: values.get(field) for field in sorted(fields)},
                },
                rank=rank, score=round(score, 6), score_contributions=contributions,
                matched_conditions=matched, unmatched_conditions=unmatched, selection_reasons=reasons,
                risk_flags=risks, data_quality=quality_value, missing_fields=missing,
                as_of=values.get("as_of") or stamp, source_ids=sources, change_state=state,
                valuation_context=_valuation_context(row, rows, stamp),
            ))
            report_sources.update(sources)
        report = StockSelectionReport(
            report_id=f"stock_selection_{workflow_run_id}", workflow_run_id=workflow_run_id,
            strategy=selected, as_of=stamp, universe_count=len(rows), filtered_count=len(enriched),
            candidates=candidates, filter_statistics=stats,
            validation={"status": "unavailable", "reason": "缺少有时间点一致的历史股票池、行情和财务数据"},
            data_quality={
                "status": "partial" if skipped_for_cap else quality,
                "factor_algorithm_version": self.FACTOR_VERSION,
                "enrichment_cap": _MAX_ENRICHMENT_ROWS if enrichment_fields else None,
                "unprocessed_after_cap": skipped_for_cap,
                "preselection_basis": "turnover_desc,market_cap_desc,instrument_id_asc" if enrichment_fields else None,
                "normalization": normalization_modes,
            },
            missing_fields=sorted({field for item in candidates for field in item.missing_fields}),
            source_ids=sorted(report_sources), status="completed",
        )
        self.store.save_run(report)
        self._write_report(report)
        return report.model_dump(by_alias=True)

    async def _symbols_universe(self, symbols: list[str]) -> list[MarketSnapshot]:
        """Turn an explicit symbol list into a truthful quote-only universe."""
        if self.provider is None or not hasattr(self.provider, "quotes"):
            return []
        instruments: list[InstrumentRef] = []
        for raw in symbols[:500]:
            text = str(raw).strip().upper()
            if ":" in text:
                exchange, symbol = text.split(":", 1)
            else:
                symbol = text
                try:
                    exchange = infer_exchange(symbol)
                except ValueError:
                    continue
            if exchange not in {"XSHG", "XSHE", "BJSE"} or not re.fullmatch(r"\d{6}", symbol):
                continue
            instruments.append(InstrumentRef(exchange=exchange, symbol=symbol))
        if not instruments:
            return []
        try:
            quotes = await self.provider.quotes(instruments)
        except Exception:
            return []
        rows: list[MarketSnapshot] = []
        for instrument in instruments:
            quote = quotes.get(instrument.id)
            if not isinstance(quote, Quote):
                continue
            rows.append(
                MarketSnapshot(
                    instrument_id=quote.instrument_id,
                    symbol=instrument.symbol,
                    exchange=instrument.exchange,
                    instrument_type=instrument.instrument_type,
                    name=quote.name,
                    price=quote.price,
                    change_pct=quote.change_pct,
                    volume=quote.volume,
                    market_cap=quote.market_cap,
                    pe=quote.pe,
                    pb=quote.pb,
                    as_of=quote.as_of,
                    source_ids=[quote.source.id],
                )
            )
        return rows

    def _previous_candidate_ids(self, strategy_id: str) -> set[str]:
        for item in self.store.list_runs(limit=100):
            if item.get("strategy", {}).get("strategy_id") == strategy_id and item.get("status") == "completed":
                return set(item.get("_candidate_ids", []))
        return set()

    @staticmethod
    def _reasons(row: MarketSnapshot, values: dict[str, Any], strategy: SelectionStrategy) -> list[str]:
        reasons: list[str] = []
        for condition in strategy.filters:
            actual = values.get(condition.field)
            if actual is not None:
                reasons.append(f"{condition.field} {condition.op} {condition.value}")
        if row.industry:
            reasons.append(f"行业：{row.industry}")
        return reasons[:3] or ["满足当前策略条件"]

    @staticmethod
    def _risks(row: MarketSnapshot, values: dict[str, Any], missing: list[str]) -> list[str]:
        risks: list[str] = []
        if row.is_st:
            risks.append("ST标记")
        if row.is_suspended:
            risks.append("停牌")
        if _as_float(values.get("debt_ratio")) is not None and float(values["debt_ratio"]) > 70:
            risks.append("资产负债率偏高")
        if _as_float(values.get("volatility20")) is not None and float(values["volatility20"]) > 8:
            risks.append("近期波动偏高")
        if missing:
            risks.append("部分因子缺失")
        return risks or ["未发现已执行规则中的风险标记"]

    def _report_path(self, run_id: str) -> Path:
        if self.workspace is not None:
            from mona.config.paths import get_stock_project_dir
            return get_stock_project_dir(self.workspace, run_id) / "selection.json"
        return self.root / "selection_reports" / f"{run_id}.json"

    def _opportunity_path(self, run_id: str) -> Path:
        """Return the durable opportunity artifact beside ``selection.json``."""
        if self.workspace is not None:
            from mona.config.paths import get_stock_project_dir

            return get_stock_project_dir(self.workspace, run_id) / "opportunity.json"
        return self.root / "selection_reports" / f"{run_id}.opportunity.json"

    def _write_report(self, report: StockSelectionReport) -> None:
        path = self._report_path(report.workflow_run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(report.model_dump(by_alias=True), handle, ensure_ascii=False, indent=2)
            handle.flush()
        os.replace(tmp, path)

    def read_report(self, run_id: str) -> dict[str, Any] | None:
        path = self._report_path(run_id)
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def _read_opportunity_context(
        self, context_id: str, instrument_id: str, *, run_id: str | None = None
    ) -> tuple[set[str], dict[str, Any], dict[str, Any]]:
        """Read one context and return its owned source ids and quality data.

        Context files are immutable outputs of ``stock_context_read``.  The
        submit seam intentionally reads them directly so the Agent cannot
        broaden source ownership by passing a source id from another context.
        """
        if self.workspace is None:
            raise ScreeningValidationError(
                "opportunity research requires a configured workspace"
            )
        if not isinstance(context_id, str) or not re.fullmatch(
            r"^ctx_[a-z0-9]{12,64}$", context_id
        ):
            raise ScreeningValidationError(f"invalid context_id {context_id!r}")
        from mona.config.paths import get_stock_projects_dir

        path = (
            get_stock_projects_dir(self.workspace).parent
            / "stock_contexts"
            / f"{context_id}.json"
        )
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ScreeningValidationError(
                f"context {context_id!r} was not found"
            ) from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise ScreeningValidationError(
                f"context {context_id!r} is unreadable"
            ) from exc
        if not isinstance(payload, dict):
            raise ScreeningValidationError(f"context {context_id!r} is invalid")
        owner = payload.get("owner")
        owner_run_id = (
            owner.get("workflow_run_id") or owner.get("run_id")
            if isinstance(owner, dict)
            else None
        )
        if owner_run_id != run_id:
            raise ScreeningValidationError(
                f"context {context_id!r} does not belong to the current workflow run"
            )
        symbols = payload.get("symbols")
        bundle = symbols.get(instrument_id) if isinstance(symbols, dict) else None
        if not isinstance(bundle, dict):
            raise ScreeningValidationError(
                f"context {context_id!r} has no evidence for {instrument_id}"
            )
        sources = bundle.get("sources")
        if not isinstance(sources, list):
            sources = []
        source_ids = {
            item.get("id")
            for item in sources
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        quality = bundle.get("data_quality")
        if not isinstance(quality, dict):
            quality = {}
        return {item for item in source_ids if item}, bundle, quality

    @staticmethod
    def _opportunity_value(payload: dict[str, Any], name: str) -> Any:
        """Read a field from either the Agent's snake or public camel form."""
        if name in payload:
            return payload[name]
        if not name:
            return None
        parts = name.split("_")
        camel = parts[0] + "".join(
            part[:1].upper() + part[1:] for part in parts[1:]
        )
        return payload.get(camel)

    @classmethod
    def _opportunity_claims(cls, payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
        fields = (
            "why_now",
            "thesis",
            "supporting_evidence",
            "counter_evidence",
            "relative_edge",
            "watch_items",
            "invalidation_conditions",
            "data_gaps",
        )
        for field in fields:
            value = cls._opportunity_value(payload, field)
            if field == "why_now":
                if isinstance(value, dict):
                    yield value
                continue
            if isinstance(value, list):
                yield from (item for item in value if isinstance(item, dict))
        horizons = cls._opportunity_value(payload, "horizon_views")
        if isinstance(horizons, dict):
            for horizon in _OPPORTUNITY_HORIZONS:
                view = cls._opportunity_value(horizons, horizon)
                if not isinstance(view, dict):
                    continue
                summary = cls._opportunity_value(view, "summary")
                if isinstance(summary, dict):
                    yield summary
                for field in (
                    "supporting_evidence",
                    "counter_evidence",
                    "watch_items",
                    "invalidation_conditions",
                    "data_gaps",
                ):
                    value = cls._opportunity_value(view, field)
                    if isinstance(value, list):
                        yield from (item for item in value if isinstance(item, dict))
        transmission = cls._opportunity_value(payload, "event_transmission")
        if isinstance(transmission, dict):
            for field in (
                "event",
                "direct_impact",
                "business_exposure",
                "earnings_path",
                "validation_window",
                "priced_in_basis",
            ):
                claim = cls._opportunity_value(transmission, field)
                if isinstance(claim, dict):
                    yield claim
            for field in (
                "industry_chain",
                "counter_evidence",
                "invalidation_conditions",
                "data_gaps",
            ):
                value = cls._opportunity_value(transmission, field)
                if isinstance(value, list):
                    yield from (item for item in value if isinstance(item, dict))

    def submit_opportunity_report(
        self, run_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Validate and atomically persist an AI opportunity research report."""
        if not isinstance(run_id, str) or not run_id:
            raise ScreeningValidationError("invalid workflow_run_id")
        workflow_run_id = _safe_run_id(run_id)
        if not isinstance(payload, dict):
            raise ScreeningValidationError("opportunity payload must be an object")
        selection = self.read_report(workflow_run_id)
        if selection is None:
            raise KeyError(f"selection report {workflow_run_id!r} not found")
        raw_candidates = payload.get("candidates")
        if not isinstance(raw_candidates, list):
            raise ScreeningValidationError("candidates must be an array")
        if not 1 <= len(raw_candidates) <= 8:
            raise ScreeningValidationError("opportunity research requires 1 to 8 candidates")

        selected_candidates = selection.get("candidates")
        if not isinstance(selected_candidates, list):
            raise ScreeningValidationError("selection report has no candidates")
        selected: dict[str, dict[str, Any]] = {}
        for item in selected_candidates:
            if not isinstance(item, dict):
                continue
            instrument_id = item.get("instrument_id") or item.get("instrumentId")
            if isinstance(instrument_id, str) and instrument_id:
                selected[instrument_id] = item

        seen: set[str] = set()
        validated: list[OpportunityCandidate] = []
        report_source_ids: set[str] = set()
        owned_all_sources: set[str] = set()
        missing_sections: set[str] = set()
        reported_data_gaps = 0
        priority_downgrades: list[str] = []
        context_ids: set[str] = set()
        incomplete_candidate_sections: dict[str, list[str]] = {}
        incomplete_horizon_views: dict[str, list[str]] = {}
        incomplete_event_transmissions: dict[str, list[str]] = {}
        candidate_owned_sources: dict[str, set[str]] = {}

        def has_current_evidence(
            claims: list[OpportunityClaim], owned_sources: set[str]
        ) -> bool:
            return any(
                claim.claim_type in {"fact", "inference"}
                and bool(claim.source_ids)
                and set(claim.source_ids) <= owned_sources
                for claim in claims
            )

        for index, raw in enumerate(raw_candidates, start=1):
            if not isinstance(raw, dict):
                raise ScreeningValidationError(f"candidate {index} must be an object")
            candidate_payload = dict(raw)
            instrument_id = self._opportunity_value(candidate_payload, "instrument_id")
            if not isinstance(instrument_id, str) or not instrument_id.strip():
                raise ScreeningValidationError(f"candidate {index} is missing instrument_id")
            instrument_id = instrument_id.strip()
            if instrument_id in seen:
                raise ScreeningValidationError(f"duplicate opportunity candidate {instrument_id}")
            if instrument_id not in selected:
                raise ScreeningValidationError(
                    f"opportunity candidate {instrument_id} is not in the selection report"
                )
            seen.add(instrument_id)

            # Rank is a deterministic selection fact.  Any model-provided
            # rank is discarded before validation and replaced from selection.
            candidate_payload.pop("instrumentId", None)
            candidate_payload.pop("deterministicRank", None)
            candidate_payload.pop("rank", None)
            candidate_payload.pop("deterministic_rank", None)
            candidate_payload["instrument_id"] = instrument_id
            selected_rank = selected[instrument_id].get("rank")
            if not isinstance(selected_rank, int) or selected_rank < 1:
                raise ScreeningValidationError(
                    f"selection candidate {instrument_id} has no deterministic rank"
                )
            candidate_payload["deterministic_rank"] = selected_rank

            context_id = self._opportunity_value(candidate_payload, "context_id")
            if not isinstance(context_id, str) or not context_id.strip():
                raise ScreeningValidationError(
                    f"candidate {instrument_id} is missing context_id"
                )
            context_id = context_id.strip()
            candidate_payload["context_id"] = context_id
            owned_sources, _bundle, quality = self._read_opportunity_context(
                context_id, instrument_id, run_id=workflow_run_id
            )
            candidate_owned_sources[instrument_id] = set(owned_sources)
            owned_all_sources.update(owned_sources)
            context_ids.add(context_id)
            missing = quality.get("missing") or []
            omitted = quality.get("omitted") or []
            for section in [*missing, *omitted]:
                if isinstance(section, str) and section:
                    missing_sections.add(section)

            snapshot = selected[instrument_id].get("snapshot") or {}
            raw_events = (
                snapshot.get("catalyst_events")
                or snapshot.get("catalystEvents")
                or []
            )
            catalyst_sources = {
                source_id
                for event in raw_events
                if isinstance(event, dict)
                for source_id in (
                    event.get("source_ids") or event.get("sourceIds") or []
                )
                if isinstance(source_id, str) and source_id
            }
            event_transmission_was_missing = bool(
                raw_events
                and self._opportunity_value(candidate_payload, "event_transmission")
                is None
            )
            if event_transmission_was_missing:
                candidate_payload["event_transmission"] = (
                    _insufficient_event_transmission_payload(
                        "候选包含催化事件，但未提交可追溯的事件传导链。"
                    )
                )

            declared_sources = self._opportunity_value(candidate_payload, "source_ids")
            if declared_sources is None:
                declared_sources = []
            if not isinstance(declared_sources, list):
                raise ScreeningValidationError(
                    f"candidate {instrument_id} source_ids must be an array"
                )
            if any(
                not isinstance(item, str) or not item.strip()
                for item in declared_sources
            ):
                raise ScreeningValidationError(
                    f"candidate {instrument_id} source_ids must contain non-empty strings"
                )
            declared_sources = [item.strip() for item in declared_sources]
            foreign_sources = set(declared_sources) - owned_sources
            if foreign_sources:
                raise ScreeningValidationError(
                    f"candidate {instrument_id} references source ids outside its context: "
                    + ", ".join(sorted(foreign_sources))
                )

            claim_sources: set[str] = set(declared_sources)
            for claim in self._opportunity_claims(candidate_payload):
                claim_source_ids = self._opportunity_value(claim, "source_ids")
                if claim_source_ids is None:
                    claim_source_ids = []
                if not isinstance(claim_source_ids, list):
                    raise ScreeningValidationError(
                        f"candidate {instrument_id} claim source_ids must be an array"
                    )
                if any(
                    not isinstance(item, str) or not item.strip()
                    for item in claim_source_ids
                ):
                    raise ScreeningValidationError(
                        f"candidate {instrument_id} claim source_ids must contain non-empty strings"
                    )
                claim_sources.update(
                    item.strip() for item in claim_source_ids
                )
            foreign_claim_sources = claim_sources - owned_sources
            if foreign_claim_sources:
                raise ScreeningValidationError(
                    f"candidate {instrument_id} claim references source ids outside its context: "
                    + ", ".join(sorted(foreign_claim_sources))
                )
            candidate_payload["source_ids"] = sorted(claim_sources)
            try:
                candidate = OpportunityCandidate.model_validate(candidate_payload)
            except Exception as exc:
                raise ScreeningValidationError(
                    f"invalid opportunity candidate {instrument_id}: {exc}"
                ) from exc
            horizon_gaps = [
                horizon
                for horizon in _OPPORTUNITY_HORIZONS
                if candidate.horizon_views[horizon].status == "insufficient_data"
            ]
            if horizon_gaps:
                incomplete_horizon_views[instrument_id] = horizon_gaps
            catalyst_source_missing = False
            if raw_events:
                catalyst_source_missing = not bool(
                    catalyst_sources & set(candidate.why_now.source_ids)
                )
            event_transmission_incomplete = False
            event_transmission_reason: str | None = None
            if raw_events:
                transmission = candidate.event_transmission
                transmission_sources = (
                    set(transmission.event.source_ids)
                    if transmission is not None
                    else set()
                )
                if transmission is None:
                    event_transmission_incomplete = True
                    event_transmission_reason = "missing"
                elif transmission.status != "available":
                    event_transmission_incomplete = True
                    event_transmission_reason = (
                        "missing" if event_transmission_was_missing else "insufficient_data"
                    )
                elif not catalyst_sources or not transmission_sources & catalyst_sources:
                    event_transmission_incomplete = True
                    event_transmission_reason = "catalyst_source_mismatch"
                if event_transmission_incomplete and transmission is not None:
                    gap_text = (
                        "事件来源未与候选催化事件同源匹配，无法核验事件传导链。"
                    )
                    gap = OpportunityClaim(
                        text=gap_text,
                        claim_type="unknown",
                        source_ids=[],
                    )
                    if not any(claim.text == gap_text for claim in transmission.data_gaps):
                        transmission = transmission.model_copy(
                            update={
                                "status": "insufficient_data",
                                "data_gaps": [*transmission.data_gaps, gap],
                            }
                        )
                        candidate = candidate.model_copy(
                            update={"event_transmission": transmission}
                        )
                if event_transmission_incomplete:
                    incomplete_event_transmissions[instrument_id] = [
                        event_transmission_reason or "insufficient_data"
                    ]
            if candidate.research_priority in {"high", "medium"}:
                supporting = has_current_evidence(
                    candidate.supporting_evidence, owned_sources
                )
                counter = has_current_evidence(candidate.counter_evidence, owned_sources)
                if (
                    not supporting
                    or not counter
                    or catalyst_source_missing
                    or event_transmission_incomplete
                ):
                    candidate = candidate.model_copy(update={"research_priority": "low"})
                    priority_downgrades.append(instrument_id)
            if candidate.data_gaps:
                reported_data_gaps += len(candidate.data_gaps)
            reported_data_gaps += sum(
                len(view.data_gaps) for view in candidate.horizon_views.values()
            )
            if candidate.event_transmission is not None:
                reported_data_gaps += len(candidate.event_transmission.data_gaps)
            incomplete: list[str] = []

            # A non-empty section is not sufficient for a completed report:
            # the thesis, its support/counter evidence, and invalidation
            # conditions must contain at least one source-backed fact or
            # inference from this candidate's current context.  Watch items
            # are intentionally looser because they may be future unknowns.
            if not has_current_evidence([candidate.why_now], owned_sources):
                incomplete.append("why_now")
            elif catalyst_source_missing:
                incomplete.append("why_now_catalyst_source")
            for field in (
                "thesis",
                "supporting_evidence",
                "counter_evidence",
                "invalidation_conditions",
            ):
                claims = getattr(candidate, field)
                if not claims or not has_current_evidence(claims, owned_sources):
                    incomplete.append(field)
            incomplete.extend(f"horizon_views.{horizon}" for horizon in horizon_gaps)
            if event_transmission_incomplete:
                incomplete.append("event_transmission")
            if not candidate.watch_items:
                incomplete.append("watch_items")
            if incomplete:
                incomplete_candidate_sections[instrument_id] = incomplete
            validated.append(candidate)
            report_source_ids.update(candidate.source_ids)

        comparison_raw = payload.get("comparison_summary", payload.get("comparisonSummary", []))
        if comparison_raw is None:
            comparison_raw = []
        if not isinstance(comparison_raw, list) or len(comparison_raw) > 32:
            raise ScreeningValidationError("comparison_summary must contain at most 32 claims")
        comparison: list[OpportunityClaim] = []
        for index, raw_claim in enumerate(comparison_raw, start=1):
            if not isinstance(raw_claim, dict):
                raise ScreeningValidationError(f"comparison_summary claim {index} must be an object")
            source_ids = self._opportunity_value(raw_claim, "source_ids") or []
            if not isinstance(source_ids, list):
                raise ScreeningValidationError(
                    f"comparison_summary claim {index} source_ids must be an array"
                )
            foreign_sources = {
                item.strip() for item in source_ids
                if isinstance(item, str) and item.strip()
            } - owned_all_sources
            if foreign_sources:
                raise ScreeningValidationError(
                    "comparison_summary references source ids outside candidate contexts: "
                    + ", ".join(sorted(foreign_sources))
                )
            try:
                comparison.append(OpportunityClaim.model_validate(raw_claim))
            except Exception as exc:
                raise ScreeningValidationError(
                    f"invalid comparison_summary claim {index}: {exc}"
                ) from exc
            report_source_ids.update(comparison[-1].source_ids)

        comparison_missing: list[str] = []
        if len(validated) > 1:
            if not comparison or not has_current_evidence(comparison, owned_all_sources):
                comparison_missing.append("comparison_summary")
            for candidate in validated:
                owned_sources = candidate_owned_sources.get(candidate.instrument_id, set())
                if not candidate.relative_edge or not has_current_evidence(
                    candidate.relative_edge, owned_sources
                ):
                    incomplete_candidate_sections.setdefault(
                        candidate.instrument_id, []
                    ).append("relative_edge")

        selection_report_id = selection.get("report_id") or selection.get("reportId")
        if not isinstance(selection_report_id, str) or not selection_report_id:
            selection_report_id = f"stock_selection_{workflow_run_id}"
        quality_incomplete = bool(incomplete_candidate_sections or comparison_missing)
        quality_status = (
            "partial"
            if missing_sections or reported_data_gaps or quality_incomplete
            else "available"
        )
        report_status: OpportunityStatus = (
            "partial"
            if missing_sections or reported_data_gaps or quality_incomplete
            else "completed"
        )
        data_quality: dict[str, Any] = {
            "status": quality_status,
            "missing_sections": sorted(missing_sections),
            "context_count": len(context_ids),
            "incomplete_candidate_sections": incomplete_candidate_sections,
            "incomplete_horizon_views": incomplete_horizon_views,
            "incomplete_event_transmissions": incomplete_event_transmissions,
            "comparison_missing": comparison_missing,
        }
        if priority_downgrades:
            data_quality["priority_downgrades"] = sorted(priority_downgrades)
        if reported_data_gaps:
            data_quality["reported_data_gaps"] = reported_data_gaps
        report = OpportunityResearchReport(
            report_id=f"stock_opportunity_{workflow_run_id}",
            workflow_run_id=workflow_run_id,
            selection_report_id=selection_report_id,
            as_of=selection.get("as_of") or selection.get("asOf") or _now(),
            status=report_status,
            candidate_count=len(validated),
            candidates=validated,
            comparison_summary=comparison,
            data_quality=data_quality,
            source_ids=sorted(report_source_ids),
        )
        path = self._opportunity_path(workflow_run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(report.model_dump(), handle, ensure_ascii=False, indent=2)
                handle.flush()
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        return report.model_dump()

    def read_opportunity_report(self, run_id: str) -> dict[str, Any] | None:
        if not isinstance(run_id, str) or not run_id:
            raise ScreeningValidationError("invalid workflow_run_id")
        workflow_run_id = _safe_run_id(run_id)
        path = self._opportunity_path(workflow_run_id)
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def read_opportunity_source(
        self, run_id: str, context_id: str, source_id: str
    ) -> dict[str, Any]:
        """Read one source only when the opportunity/run/context all agree.

        ``opportunity.json`` is the first ownership boundary, the context
        owner binds the evidence to this workflow run, and the context bundle
        is the final source-record boundary.  A source that merely exists in
        a context but was not cited by a submitted candidate is not exposed.
        """
        if not isinstance(run_id, str) or not run_id:
            raise ScreeningValidationError("invalid workflow_run_id")
        workflow_run_id = _safe_run_id(run_id)
        if not isinstance(context_id, str) or not re.fullmatch(
            r"^ctx_[a-z0-9]{12,64}$", context_id
        ):
            raise ScreeningValidationError(f"invalid context_id {context_id!r}")
        if not isinstance(source_id, str) or not source_id.strip():
            raise ScreeningValidationError("source_id must be non-empty")
        source_id = source_id.strip()
        opportunity = self.read_opportunity_report(workflow_run_id)
        if opportunity is None:
            raise KeyError(f"opportunity report {workflow_run_id!r} not found")
        candidates = opportunity.get("candidates")
        if not isinstance(candidates, list):
            raise KeyError(f"opportunity report {workflow_run_id!r} has no candidates")

        instrument_id: str | None = None
        for item in candidates:
            if not isinstance(item, dict):
                continue
            item_context = item.get("context_id") or item.get("contextId")
            if item_context != context_id:
                continue
            item_instrument = item.get("instrument_id") or item.get("instrumentId")
            cited = item.get("source_ids") or item.get("sourceIds") or []
            if not isinstance(item_instrument, str) or source_id not in cited:
                raise KeyError("source is not cited by this opportunity candidate")
            instrument_id = item_instrument
            break
        if instrument_id is None:
            raise KeyError("opportunity candidate context not found")

        try:
            owned_sources, bundle, _quality = self._read_opportunity_context(
                context_id,
                instrument_id,
                run_id=workflow_run_id,
            )
        except ScreeningValidationError as exc:
            # Do not disclose whether another run owns the context.
            raise KeyError("opportunity context is not owned by this run") from exc
        if source_id not in owned_sources:
            raise KeyError("source is not owned by this opportunity context")
        sources = bundle.get("sources") or []
        for source in sources:
            if isinstance(source, dict) and source.get("id") == source_id:
                return dict(source)
        raise KeyError("source record not found")

    def history(self, limit: int = 50) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for raw in self.store.list_runs(limit):
            strategy = raw.get("strategy") or {}
            candidate_ids = raw.get("_candidate_ids") or []
            run_id = raw.get("workflow_run_id")
            opportunity = (
                self.read_opportunity_report(run_id)
                if isinstance(run_id, str) and run_id
                else None
            )
            research_status = (opportunity or {}).get("status") or "not_started"
            items.append(
                {
                    "reportId": raw.get("report_id"),
                    "runId": raw.get("workflow_run_id"),
                    "status": raw.get("status"),
                    "asOf": raw.get("as_of"),
                    "strategyId": strategy.get("strategy_id"),
                    "strategyName": strategy.get("name"),
                    "candidateCount": len(candidate_ids),
                    "dataQuality": raw.get("data_quality") or {},
                    "research_status": research_status,
                    "has_opportunity_research": bool(opportunity),
                    # Existing stock API fields are camelCase.  Keep the
                    # aliases while exposing the plan's canonical names so
                    # old clients and the new opportunity view can coexist.
                    "researchStatus": research_status,
                    "hasOpportunityResearch": bool(opportunity),
                }
            )
        return items

    def compare(self, run_id: str, instrument_ids: list[str]) -> dict[str, Any]:
        if not isinstance(instrument_ids, list) or not 2 <= len(instrument_ids) <= 5:
            raise ValueError("compare requires 2 to 5 instrument ids")
        report = self.read_report(run_id)
        if report is None:
            raise KeyError(f"selection report {run_id!r} not found")
        requested = set(instrument_ids)
        candidates = [item for item in report.get("candidates", []) if item.get("instrument_id") in requested or item.get("instrumentId") in requested]
        if len(candidates) != len(requested):
            raise ValueError("all compared instruments must exist in the selection report")
        def value(candidate: dict[str, Any], key: str) -> Any:
            snapshot = candidate.get("snapshot") or {}
            return snapshot.get(key)

        dimensions = [
            {
                "key": "score",
                "label": "策略得分",
                "values": {item.get("instrumentId") or item.get("instrument_id"): item.get("score") for item in candidates},
            },
            {
                "key": "price",
                "label": "现价",
                "values": {item.get("instrumentId") or item.get("instrument_id"): value(item, "price") for item in candidates},
            },
            {
                "key": "change_pct",
                "label": "涨跌幅",
                "values": {item.get("instrumentId") or item.get("instrument_id"): value(item, "change_pct") for item in candidates},
            },
            {
                "key": "industry",
                "label": "行业",
                "values": {item.get("instrumentId") or item.get("instrument_id"): item.get("industry") for item in candidates},
            },
            {
                "key": "risk_count",
                "label": "风险标记数",
                "values": {item.get("instrumentId") or item.get("instrument_id"): len(item.get("riskFlags") or item.get("risk_flags") or []) for item in candidates},
            },
            {
                "key": "data_quality",
                "label": "数据质量",
                "values": {item.get("instrumentId") or item.get("instrument_id"): item.get("dataQuality") or item.get("data_quality") for item in candidates},
            },
        ]
        report_quality = report.get("dataQuality") or report.get("data_quality") or {}
        return {
            "runId": run_id,
            "items": candidates,
            "candidates": candidates,
            "dimensions": dimensions,
            "dataQuality": report_quality,
        }

    def validation(self, run_id: str) -> dict[str, Any]:
        report = self.read_report(run_id)
        if report is None:
            raise KeyError(f"selection report {run_id!r} not found")
        return report.get("validation") or {"status": "unavailable", "reason": "未生成验证结果"}


_SERVICE: StockScreeningService | None = None


def default_screening_service(*, provider: Any | None = None, workspace: str | Path | None = None) -> StockScreeningService:
    """Return the process-local service used by HTTP and Agent adapters."""
    global _SERVICE
    if _SERVICE is None or provider is not None or workspace is not None:
        _SERVICE = StockScreeningService(provider=provider, workspace=workspace)
    return _SERVICE
