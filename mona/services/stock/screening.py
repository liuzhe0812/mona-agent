"""Deterministic A-share opportunity discovery service.

The service is deliberately independent from Agent/Workflow code.  Agents may
turn a user's words into a :class:`SelectionStrategy`, but this module owns
the actual universe filtering, factor calculation, risk checks and durable
report.  Missing historical data is reported as ``unavailable``; this module
never fabricates a backtest.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping

from loguru import logger
from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base
from mona.services.stock.calibration_cohort import (
    VALIDATION_WINDOWS,
    CalibrationCohortStore,
    build_validation_records,
    make_cohort_payload,
)
from mona.services.stock.provenance import SourceRecord
from mona.services.stock.provider import (
    Fundamentals,
    InstrumentRef,
    KlineSeries,
    ProviderError,
    Quote,
)
from mona.services.stock.quant_validation import (
    PromotionGate,
    TransactionCost,
    validate_strategy,
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
_RANK_ALGORITHM_VERSION = "percentile-rank-v1"

# These are display/trace groups only.  They do not create a second score or
# infer fields that the deterministic selector did not calculate.
_QUANT_HORIZON_FACTOR_FIELDS = {
    "short_term": frozenset(
        {"momentum20", "momentum60", "volatility20", "volume", "turnover"}
    ),
    "medium_term": frozenset(
        {
            "revenue_yoy",
            "profit_yoy",
            "net_profit",
            "roe",
            "roic",
            "gross_margin",
            "net_margin",
            "operating_cashflow",
            "debt_ratio",
            "eps",
            "momentum20",
            "momentum60",
        }
    ),
    "long_term": frozenset(
        {
            "pe",
            "pb",
            "roe",
            "roic",
            "gross_margin",
            "net_margin",
            "operating_cashflow",
            "debt_ratio",
            "eps",
        }
    ),
}

_QUANT_METHOD_REGISTRY: dict[str, dict[str, Any]] = {
    "short_term": {
        "methodId": "short-term-volume-price-v1",
        "horizon": "short_term",
        "inputFactors": sorted(_QUANT_HORIZON_FACTOR_FIELDS["short_term"]),
        "directions": {"momentum20": "desc", "momentum60": "desc", "volatility20": "asc", "volume": "desc", "turnover": "desc"},
        "version": "short-term-volume-price-v1",
        "targetWindowSessions": 10,
        "targetDefinition": "未来10个交易日相对基准收益",
        "marketStates": ["all"],
    },
    "medium_term": {
        "methodId": "medium-term-quality-growth-v1",
        "horizon": "medium_term",
        "inputFactors": sorted(_QUANT_HORIZON_FACTOR_FIELDS["medium_term"]),
        "directions": {"revenue_yoy": "desc", "profit_yoy": "desc", "roe": "desc", "roic": "desc", "momentum20": "desc", "momentum60": "desc"},
        "version": "medium-term-quality-growth-v1",
        "targetWindowSessions": 60,
        "targetDefinition": "未来60个交易日相对基准收益",
        "marketStates": ["all"],
    },
    "long_term": {
        "methodId": "long-term-quality-value-v1",
        "horizon": "long_term",
        "inputFactors": sorted(_QUANT_HORIZON_FACTOR_FIELDS["long_term"]),
        "directions": {"pe": "asc", "pb": "asc", "roe": "desc", "roic": "desc", "operating_cashflow": "desc", "debt_ratio": "asc", "eps": "desc"},
        "version": "long-term-quality-value-v1",
        "targetWindowSessions": 120,
        "targetDefinition": "未来120个交易日相对基准收益",
        "marketStates": ["all"],
    },
}
_MIN_QUANT_UNIQUE_SCORES = 5


def stable_json_hash(value: Any) -> str:
    """Hash canonical JSON; never use process-randomized Python ``hash``."""
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _stable_hash(value: Any) -> str:
    """Backward-compatible private alias for the public canonical hash."""
    return stable_json_hash(value)

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
    board: str | None = None
    is_st: bool = False
    is_suspended: bool = False
    is_delisting: bool | None = None
    active_universe_member: bool | None = None
    status_method: str | None = None
    name_status_proxy: bool | None = None
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


QuantValidationStatus = Literal[
    "uncalibrated", "support", "unconfirmed", "oppose", "insufficient_data"
]
QuantSignal = Literal["positive", "neutral", "negative", "insufficient_data"]
QuantHorizon = Literal["short_term", "medium_term", "long_term"]
QuantPromotionStatus = Literal["research_only", "calibrated", "rejected"]


class QuantFactorObservation(Base):
    field: str
    raw_value: float | None = None
    percentile_or_rank: float | None = None
    # Current cross-sectional rank is descriptive only.  It is not an OOS
    # Alpha forecast and cannot promote a plan to trading.
    rank: int | None = Field(default=None, ge=1)
    direction: Literal["asc", "desc"]
    scope: Literal["industry", "market_fallback", "market"]
    sample_count: int = Field(default=0, ge=0)
    missing_count: int = Field(default=0, ge=0)
    as_of: str | None = None
    source_ids: list[str] = Field(default_factory=list)
    method_version: str
    validation_status: QuantValidationStatus = "uncalibrated"


class QuantHorizonValidation(Base):
    validation_status: QuantValidationStatus
    quant_signal: QuantSignal = "insufficient_data"
    factor_observations: list[QuantFactorObservation] = Field(default_factory=list)


class QuantCandidateValidation(Base):
    validation_status: QuantValidationStatus
    quant_signal: QuantSignal = "insufficient_data"
    horizons: dict[QuantHorizon, QuantHorizonValidation]
    source_closure_missing: list[str] = Field(default_factory=list)
    promotion_status: QuantPromotionStatus = "research_only"
    promotion_reason: str = "当前策略仅用于研究观察"
    eligible_for_trading: bool = False
    strategy_horizon: StrategyHorizon | None = None
    calibrated_horizon: StrategyHorizon | None = None
    validation_metrics: dict[str, Any] = Field(default_factory=dict)


class QuantPointInTimeQuality(Base):
    status: Literal["not_requested", "verified", "incompatible", "unknown"]
    requested_as_of: str | None = None
    latest_observed_at: str | None = None
    missing_observed_at: int = Field(default=0, ge=0)


class QuantDataQuality(Base):
    status: Literal["available", "partial", "stale", "unavailable", "unknown"]
    quant_validation_status: QuantValidationStatus
    reason: str
    point_in_time: QuantPointInTimeQuality
    missing_factor_fields: list[str] = Field(default_factory=list)
    source_closure_missing: list[str] = Field(default_factory=list)


class QuantUniverse(Base):
    universe_count: int = Field(default=0, ge=0)
    hard_filter_count: int = Field(default=0, ge=0)
    cheap_count: int = Field(default=0, ge=0)
    enriched_count: int = Field(default=0, ge=0)
    unprocessed_after_cap: int = Field(default=0, ge=0)
    preselection_basis: str | None = None


class QuantFactorScope(Base):
    scope: Literal["industry", "market_fallback", "market", "mixed"]
    sample_count: int = Field(default=0, ge=0)
    missing_count: int = Field(default=0, ge=0)
    direction: Literal["asc", "desc"]
    weight: float = Field(ge=0)


class QuantSnapshot(Base):
    schema_version: Literal[1] = 1
    strategy_id: str
    strategy_fingerprint: str
    as_of: str | None = None
    factor_algorithm_version: str
    rank_algorithm_version: str
    validation_status: QuantValidationStatus
    reason: str
    universe: QuantUniverse
    factor_scopes: dict[str, QuantFactorScope] = Field(default_factory=dict)
    candidate_ids_hash: str
    source_ids: list[str] = Field(default_factory=list)
    data_quality: QuantDataQuality
    source_closure_missing: list[str] = Field(default_factory=list)
    promotion_status: QuantPromotionStatus = "research_only"
    promotion_reason: str = "当前策略仅用于研究观察"
    eligible_for_trading: bool = False
    strategy_horizon: StrategyHorizon | None = None
    calibrated_horizon: StrategyHorizon | None = None
    method_registry: dict[str, Any] = Field(default_factory=dict)
    validation_metrics: dict[str, Any] = Field(default_factory=dict)


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
    # Quantitative observations are immutable context only.  They are not a
    # calibrated direction signal and therefore cannot change deterministic
    # selection rank.
    quant_validation: QuantCandidateValidation | None = None


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
    quant_snapshot: QuantSnapshot | None = None


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
        conn = self._connect()
        try:
            with conn:
                conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS instrument_snapshot (
                  instrument_id TEXT NOT NULL, as_of TEXT NOT NULL, payload TEXT NOT NULL,
                  PRIMARY KEY(instrument_id, as_of)
                );
                CREATE TABLE IF NOT EXISTS instrument_snapshot_source (
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
        finally:
            conn.close()

    def save_snapshots(self, snapshots: Iterable[MarketSnapshot], as_of: str) -> None:
        snapshots = list(snapshots)
        rows = [(item.instrument_id, as_of, item.model_dump_json()) for item in snapshots]
        if not rows:
            return
        source_rows = [
            (item.instrument_id, as_of, item.source.model_dump_json())
            for item in snapshots
            if isinstance(item.source, SourceRecord)
        ]
        conn = self._connect()
        try:
            with conn:
                conn.executemany("INSERT OR REPLACE INTO instrument_snapshot VALUES (?, ?, ?)", rows)
                if source_rows:
                    conn.executemany(
                        "INSERT OR REPLACE INTO instrument_snapshot_source VALUES (?, ?, ?)",
                        source_rows,
                    )
        finally:
            conn.close()

    def save_factors(self, instrument_id: str, as_of: str, factors: dict[str, Any], algorithm_version: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO factor_snapshot VALUES (?, ?, ?, ?)",
                (instrument_id, as_of, algorithm_version, json.dumps(factors, ensure_ascii=False)),
            )

    def latest_factor_snapshots(
        self,
        as_of: str | None = None,
        algorithm_version: str | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Return the newest cached factor observation per instrument.

        Direct research uses this as a read-only cross-sectional cache.  It is
        deliberately separate from selection promotion: these rows provide
        current factor values and provenance context, never historical Alpha
        validation or trading eligibility.
        """
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT instrument_id, as_of, algorithm_version, payload "
                "FROM factor_snapshot ORDER BY as_of DESC, instrument_id ASC"
            ).fetchall()
        finally:
            conn.close()
        result: dict[str, dict[str, Any]] = {}
        for instrument_id, observed_as_of, version, payload in rows:
            if not isinstance(instrument_id, str) or instrument_id in result:
                continue
            if as_of is not None and str(observed_as_of) > as_of:
                continue
            if algorithm_version is not None and version != algorithm_version:
                continue
            try:
                factors = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(factors, dict):
                continue
            result[instrument_id] = {
                "as_of": observed_as_of,
                "algorithm_version": version,
                "factors": factors,
            }
        return result

    def latest_snapshots(self, as_of: str | None = None) -> list[MarketSnapshot]:
        conn = self._connect()
        try:
            if as_of:
                rows = conn.execute("SELECT payload FROM instrument_snapshot WHERE as_of = ?", (as_of,)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.payload FROM instrument_snapshot s JOIN (SELECT instrument_id, MAX(as_of) as a FROM instrument_snapshot GROUP BY instrument_id) x ON x.instrument_id=s.instrument_id AND x.a=s.as_of"
                ).fetchall()
        finally:
            conn.close()
        return [MarketSnapshot.model_validate_json(row[0]) for row in rows]

    def latest_snapshots_with_sources(
        self, as_of: str | None = None
    ) -> list[tuple[MarketSnapshot, SourceRecord | None]]:
        """Return reusable snapshots with their optional original source.

        Screening payloads intentionally omit source bodies.  The side table
        keeps provenance available to EvidenceService without changing the
        public screening report shape.
        """
        conn = self._connect()
        try:
            if as_of:
                rows = conn.execute(
                    "SELECT instrument_id, as_of, payload FROM instrument_snapshot WHERE as_of = ?",
                    (as_of,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.instrument_id, s.as_of, s.payload FROM instrument_snapshot s "
                    "JOIN (SELECT instrument_id, MAX(as_of) as a FROM instrument_snapshot GROUP BY instrument_id) x "
                    "ON x.instrument_id=s.instrument_id AND x.a=s.as_of"
                ).fetchall()
            source_rows = conn.execute(
                "SELECT instrument_id, as_of, payload FROM instrument_snapshot_source"
            ).fetchall()
        finally:
            conn.close()
        sources: dict[tuple[str, str], SourceRecord] = {}
        for row in source_rows:
            try:
                sources[(row[0], row[1])] = SourceRecord.model_validate_json(row[2])
            except (TypeError, ValueError):
                continue
        out: list[tuple[MarketSnapshot, SourceRecord | None]] = []
        for row in rows:
            try:
                snapshot = MarketSnapshot.model_validate_json(row[2])
            except (TypeError, ValueError):
                continue
            # Older provider payloads omitted timestamps even though the
            # SQLite primary key retained the immutable observation stamp.
            # Restore that stored point-in-time metadata on read so bounded
            # cache reuse never mistakes a dated row for an undated value.
            if not snapshot.as_of or not snapshot.observed_at:
                snapshot = snapshot.model_copy(
                    update={
                        "as_of": snapshot.as_of or row[1],
                        "observed_at": snapshot.observed_at or row[1],
                    }
                )
            out.append((snapshot, sources.get((row[0], row[1]))))
        return out

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
                "INSERT OR IGNORE INTO selection_evaluation VALUES (?, ?, ?, ?, ?, ?)",
                (report.workflow_run_id, report.strategy.strategy_id, report.as_of, report.status, json.dumps(summary_payload, ensure_ascii=False), _now()),
            )

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM selection_evaluation ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def read_validation_records(
        self, workspace: str | Path | None, strategy_id: str
    ) -> list[dict[str, Any]]:
        """Read only mature append-only selection outcomes for one strategy.

        Each record retains the immutable selection snapshot hash and factor
        version from its originating report.  Incomplete or pending outcome
        rows are ignored; this method never fetches data or rewrites files.
        """
        if workspace is None:
            return []
        root = Path(workspace).expanduser() / "stock_projects"
        if not root.is_dir():
            return []
        records: list[dict[str, Any]] = []
        for run_dir in sorted(root.iterdir()):
            if not run_dir.is_dir():
                continue
            report_path = run_dir / "selection.json"
            observations_path = run_dir / "selection_outcome_observations.jsonl"
            if not report_path.is_file() or not observations_path.is_file():
                continue
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(report, dict):
                continue
            strategy = report.get("strategy") or {}
            report_strategy_id = strategy.get("strategy_id") or strategy.get("strategyId")
            if report_strategy_id != strategy_id:
                continue
            quant_snapshot = report.get("quantSnapshot") or report.get("quant_snapshot")
            if not isinstance(quant_snapshot, dict):
                continue
            snapshot_hash = stable_json_hash(quant_snapshot)
            factor_version = quant_snapshot.get("factorAlgorithmVersion") or quant_snapshot.get("factor_algorithm_version")
            strategy_fingerprint = quant_snapshot.get("strategyFingerprint") or quant_snapshot.get("strategy_fingerprint")
            if not isinstance(factor_version, str) or not factor_version.strip():
                continue
            if not isinstance(strategy_fingerprint, str) or not strategy_fingerprint.strip():
                continue
            snapshot_source_ids = quant_snapshot.get("sourceIds") or quant_snapshot.get("source_ids") or []
            candidates = {
                item.get("instrumentId") or item.get("instrument_id"): item
                for item in report.get("candidates") or []
                if isinstance(item, dict)
            }
            report_id = report.get("reportId") or report.get("report_id")
            run_id = report.get("workflowRunId") or report.get("workflow_run_id") or run_dir.name
            as_of = report.get("asOf") or report.get("as_of")
            if not isinstance(report_id, str) or not isinstance(as_of, str):
                continue
            universe = quant_snapshot.get("universe") or {}
            universe_count = universe.get("universeCount") or universe.get("universe_count")
            observed_count = len(candidates)
            if not isinstance(universe_count, int) or universe_count <= 0:
                continue
            best_observations: dict[str, dict[str, Any]] = {}
            for line in observations_path.read_text(encoding="utf-8").splitlines():
                try:
                    observation = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(observation, dict) or observation.get("status") != "complete":
                    continue
                if observation.get("data_status") not in {None, "available"}:
                    continue
                instrument_id = observation.get("instrument_id")
                candidate = candidates.get(instrument_id)
                if not isinstance(candidate, dict):
                    continue
                factor = candidate.get("score")
                forward_return = observation.get("relative_return_pct")
                candidate_source_ids = candidate.get("sourceIds") or candidate.get("source_ids") or snapshot_source_ids
                if (
                    _as_float(factor) is None
                    or _as_float(forward_return) is None
                    or not isinstance(candidate_source_ids, list)
                    or any(not isinstance(source_id, str) or not source_id for source_id in candidate_source_ids)
                ):
                    continue
                exit_date = observation.get("exit_date")
                if not isinstance(exit_date, str) or not exit_date:
                    continue
                window = int(observation.get("window") or 0)
                current = best_observations.get(instrument_id)
                if current is None or window > int(current["window"]):
                    best_observations[instrument_id] = {
                        "as_of": as_of,
                        "outcome_as_of": exit_date,
                        "instrument_id": instrument_id,
                        "factor": float(factor),
                        "forward_return": float(forward_return) / 100.0,
                        "snapshot_hash": snapshot_hash,
                        "factor_version": factor_version,
                        "strategy_fingerprint": strategy_fingerprint,
                        "report_id": report_id,
                        "workflow_run_id": run_id,
                        "factor_id": "composite_score",
                        "factor_direction": "desc",
                        "source_ids": sorted(set(candidate_source_ids)),
                        "outcome_snapshot_hash": stable_json_hash(
                            {
                                "report_id": report_id,
                                "instrument_id": instrument_id,
                                "window": window,
                                "relative_return_pct": float(forward_return),
                                "source_ids": sorted(set(candidate_source_ids)),
                            }
                        ),
                        "sample_scope": "selected_candidates",
                        "universe_count": universe_count,
                        "observed_count": observed_count,
                        "window": window,
                    }
            records.extend(
                {
                    key: value
                    for key, value in item.items()
                    if key != "window"
                }
                for item in best_observations.values()
            )
        return records

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
    RANK_ALGORITHM_VERSION = _RANK_ALGORITHM_VERSION

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
        capture_complete = getattr(rows, "complete", True)
        snapshots = [item if isinstance(item, MarketSnapshot) else MarketSnapshot.model_validate(item) for item in rows]
        stamp = as_of or next((item.as_of for item in snapshots if item.as_of), None) or _now()
        self.store.save_snapshots(snapshots, stamp)
        return snapshots, stamp, "available" if capture_complete else "partial"

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

    async def _enrich(
        self, row: MarketSnapshot, fields: set[str]
    ) -> tuple[
        dict[str, Any],
        list[str],
        list[str],
        dict[str, list[str]],
        dict[str, list[SourceRecord]],
    ]:
        values: dict[str, Any] = {}
        missing: list[str] = []
        source_ids = list(row.source_ids)
        row_source = row.source if isinstance(row.source, SourceRecord) else None
        if row_source is not None and not source_ids:
            source_ids.append(row_source.id)
        factor_sources: dict[str, list[str]] = {}
        factor_source_records: dict[str, list[SourceRecord]] = {}
        inst = InstrumentRef(exchange=row.exchange, symbol=row.symbol, instrument_type=row.instrument_type)
        if fields & {"ma5", "ma20", "ma60", "momentum20", "momentum60", "volatility20"}:
            try:
                if self.provider is None:
                    raise ProviderError("provider unavailable")
                series = await self.provider.kline(inst, limit=120)
                kline_factors = _kline_factors(series)
                values.update(kline_factors)
                series_source = series.source if isinstance(series.source, SourceRecord) else None
                source_id = getattr(series.source, "id", None)
                if isinstance(source_id, str) and source_id:
                    source_ids.append(source_id)
                for field in fields & set(kline_factors):
                    factor_sources[field] = [source_id] if source_id else []
                    if series_source is not None and series_source.id == source_id:
                        factor_source_records[field] = [series_source]
            except Exception:
                missing.extend(sorted(fields & {"ma5", "ma20", "ma60", "momentum20", "momentum60", "volatility20"}))
        fundamental_fields = fields & {"roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy", "net_profit", "operating_cashflow", "debt_ratio", "eps"}
        if fundamental_fields:
            try:
                if self.provider is None:
                    raise ProviderError("provider unavailable")
                fundamentals: Fundamentals = await self.provider.fundamentals(inst)
                values.update(fundamentals.metrics)
                fundamentals_source = fundamentals.source if isinstance(fundamentals.source, SourceRecord) else None
                source_id = getattr(fundamentals.source, "id", None)
                if isinstance(source_id, str) and source_id:
                    source_ids.append(source_id)
                for field in fundamental_fields:
                    if field in fundamentals.metrics:
                        factor_sources[field] = [source_id] if source_id else []
                        if fundamentals_source is not None and fundamentals_source.id == source_id:
                            factor_source_records[field] = [fundamentals_source]
            except Exception:
                missing.extend(sorted(fundamental_fields))
        return (
            values,
            sorted(set(missing)),
            sorted(set(source_ids)),
            factor_sources,
            factor_source_records,
        )

    async def build_diagnosis_cross_section(
        self,
        *,
        as_of: str | None = None,
        universe: Iterable[MarketSnapshot | dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Build the reusable eligible market/factor snapshot for diagnosis.

        This deliberately shares ``_universe``, ``_hard_filter`` and
        ``_enrich`` with selection.  It writes only the same snapshot/factor
        cache used by selection; it does not create a selection report or a
        calibration cohort.  The diagnosis layer can therefore request a
        same-day cross-section when no prior selection run exists.
        """
        rows, stamp, quality = await self._universe(universe, as_of)
        strategy = SelectionStrategy(
            strategy_id="diagnosis_cross_section",
            name="AI诊股横截面",
            source="builtin",
        )
        eligible = [row for row in rows if self._hard_filter(strategy, row)[0]]
        fields = {
            "momentum20", "momentum60", "volatility20",
            "revenue_yoy", "profit_yoy", "roe", "roic",
            "pe", "pb", "operating_cashflow", "debt_ratio", "eps",
        }
        semaphore = asyncio.Semaphore(_ENRICHMENT_CONCURRENCY)

        async def enrich_one(row: MarketSnapshot):
            async with semaphore:
                return row, await self._enrich(row, fields)

        enriched = await asyncio.gather(*(enrich_one(row) for row in eligible))
        factors: dict[str, dict[str, Any]] = {}
        for row, (values, missing, _sources, _factor_sources, _records) in enriched:
            self.store.save_factors(row.instrument_id, stamp, values, self.FACTOR_VERSION)
            factors[row.instrument_id] = {
                "as_of": stamp,
                "algorithm_version": self.FACTOR_VERSION,
                "factors": values,
                "missing_fields": missing,
            }
        return {
            "rows": eligible,
            "factors": factors,
            "as_of": stamp,
            "quality": quality,
            "universe_definition": "screening_default_eligible_universe",
        }

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
        validation_records: Iterable[Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        capture, capture_status = await self._recent_catalyst_capture(as_of=stamp)
        if capture is None:
            promotion = self._promotion_result(
                selected,
                validation_records,
                current_snapshot_incomplete=True,
            )
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
                    "quantPromotion": promotion,
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
        promotion = self._promotion_result(
            selected,
            validation_records,
            current_snapshot_incomplete=report_quality != "available",
        )
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
                "quantPromotion": promotion,
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
        validation_records: Iterable[Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Union selected directions, then rank the shared candidate pool once."""
        reports: list[StockSelectionReport] = []
        for direction_index, strategy_id in enumerate(selected.included_strategy_ids):
            # A combined report owns the public workflow id.  Directional
            # sub-runs need private ids so immutable selection.json handling
            # does not make the first direction shadow the final union.
            direction_run_id = f"{workflow_run_id[:80]}_d{direction_index}"
            payload = await self.run(
                strategy_id,
                run_id=direction_run_id,
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
        promotion = self._promotion_result(
            selected,
            validation_records,
            current_snapshot_incomplete=combined_quality != "available",
        )
        candidates = [
            candidate.model_copy(
                update={
                    "quant_validation": candidate.quant_validation.model_copy(
                        update={
                            "promotion_status": promotion["promotionStatus"],
                            "promotion_reason": promotion["reason"],
                            "eligible_for_trading": promotion["eligibleForTrading"],
                            "strategy_horizon": promotion.get("strategyHorizon"),
                            "calibrated_horizon": promotion.get("calibratedHorizon"),
                            "validation_metrics": promotion.get("metrics") or {},
                        }
                    )
                    if candidate.quant_validation is not None
                    else None
                }
            )
            for candidate in candidates
        ]
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
                "quantPromotion": promotion,
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
        validation_records: Iterable[Mapping[str, Any]] | None = None,
        calibration_benchmark_reference: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if strategy is None:
            strategy = strategy_id
        if strategy is None:
            raise ScreeningValidationError("strategy or strategy_id is required")
        selected = self.resolve_strategy(strategy)
        workflow_run_id = _safe_run_id(run_id)
        if validation_records is None:
            validation_records = self.store.read_validation_records(
                self.workspace, selected.strategy_id
            )
        existing_report = self.read_report(workflow_run_id)
        if existing_report is not None:
            # A run id identifies one immutable selection input.  Retries
            # must return the persisted report before touching providers or
            # replacing the SQLite summary.
            return existing_report
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
            return await self._run_combined(
                selected,
                workflow_run_id,
                rows,
                stamp,
                validation_records,
            )
        if selected.strategy_id == "recent_catalyst":
            return await self._run_recent_catalyst(
                selected,
                workflow_run_id,
                rows,
                stamp,
                quality,
                validation_records,
            )

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
        enriched: list[
            tuple[
                MarketSnapshot,
                dict[str, Any],
                list[dict[str, Any]],
                list[dict[str, Any]],
                list[str],
                list[str],
                dict[str, list[str]],
                dict[str, list[SourceRecord]],
            ]
        ] = []
        semaphore = asyncio.Semaphore(_ENRICHMENT_CONCURRENCY)

        async def enrich_one(row: MarketSnapshot):
            async with semaphore:
                return row, await self._enrich(row, enrichment_fields)

        enriched_inputs = await asyncio.gather(*(enrich_one(row) for row in candidate_rows))
        for row, (factors, missing, sources, factor_sources, factor_source_records) in enriched_inputs:
            self.store.save_factors(row.instrument_id, stamp, factors, self.FACTOR_VERSION)
            values = self._snapshot_values(row, factors)
            row_source = row.source if isinstance(row.source, SourceRecord) else None
            snapshot_source_ids = list(row.source_ids)
            if row_source is not None and not snapshot_source_ids:
                snapshot_source_ids = [row_source.id]
            for field in fields & _SNAPSHOT_FIELDS:
                factor_sources.setdefault(field, snapshot_source_ids)
                if row_source is not None and (
                    not row.source_ids or row_source.id in row.source_ids
                ):
                    factor_source_records.setdefault(field, [row_source])
            matched: list[dict[str, Any]] = []
            unmatched: list[dict[str, Any]] = []
            for condition in selected.filters:
                result = _compare(values.get(condition.field), condition.op, condition.value)
                item = _condition_payload(condition, values.get(condition.field), result)
                (matched if result is True else unmatched).append(item)
            if unmatched:
                continue
            enriched.append(
                (
                    row,
                    values,
                    matched,
                    unmatched,
                    missing,
                    sources,
                    factor_sources,
                    factor_source_records,
                )
            )
        stats.append({"stage": "conditions", "before": len(candidate_rows), "after": len(enriched)})

        rankings: list[tuple[float, tuple[Any, ...], int]] = []
        ranking_contributions: dict[int, dict[str, float]] = {}
        ranking_observations: dict[int, dict[str, dict[str, Any]]] = {}
        source_records_by_id: dict[str, dict[str, Any]] = {}
        source_record_conflicts: set[str] = set()
        source_closure_missing_by_index: dict[int, set[str]] = {}
        factor_scope_records: dict[str, list[dict[str, Any]]] = {}
        normalization_modes: dict[str, str] = {}
        for index, (
            _row,
            values,
            _matched,
            _unmatched,
            _missing,
            _sources,
            factor_sources,
            factor_source_records,
        ) in enumerate(enriched):
            score = 0.0
            contributions: dict[str, float] = {}
            observations: dict[str, dict[str, Any]] = {}
            total_weight = sum(item.weight for item in selected.ranking) or 1.0
            for factor in selected.ranking:
                actual = _as_float(values.get(factor.field))
                peer_rows = enriched
                scope = "market"
                if factor.field in {"pe", "pb", "roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy", "debt_ratio", "operating_cashflow"} and values.get("industry"):
                    industry_rows = [item for item in enriched if item[1].get("industry") == values.get("industry")]
                    if len(industry_rows) >= 2:
                        peer_rows = industry_rows
                        scope = "industry"
                        normalization_modes[factor.field] = "industry"
                    else:
                        scope = "market_fallback"
                        normalization_modes.setdefault(factor.field, "market_fallback")
                else:
                    normalization_modes.setdefault(factor.field, "market")
                peer_values = [_as_float(item[1].get(factor.field)) for item in peer_rows]
                numeric = [item for item in peer_values if item is not None]
                percentile = _percentile(numeric, actual) if actual is not None and numeric else None
                raw_source_ids = sorted(set(factor_sources.get(factor.field) or []))
                source_ids, source_missing = self._resolve_factor_sources(
                    raw_source_ids,
                    factor_source_records.get(factor.field) or [],
                    source_records_by_id,
                    source_record_conflicts,
                )
                if source_missing and (
                    values.get(factor.field) is not None
                    or raw_source_ids
                    or factor_source_records.get(factor.field)
                ):
                    source_closure_missing_by_index.setdefault(index, set()).add(
                        factor.field
                    )
                observation = {
                    "field": factor.field,
                    "raw_value": values.get(factor.field),
                    "percentile_or_rank": percentile,
                    "direction": factor.direction,
                    "scope": scope,
                    "sample_count": len(numeric),
                    "missing_count": len(peer_values) - len(numeric),
                    "as_of": values.get("as_of") or stamp,
                    "source_ids": source_ids,
                    "method_version": self.RANK_ALGORITHM_VERSION,
                    "validation_status": (
                        "uncalibrated"
                        if percentile is not None and source_ids
                        else "insufficient_data"
                    ),
                }
                observations[factor.field] = observation
                factor_scope_records.setdefault(factor.field, []).append(
                    {
                        "scope": scope,
                        "sample_count": len(numeric),
                        "missing_count": len(peer_values) - len(numeric),
                    }
                )
                if percentile is None:
                    continue
                contribution = (percentile if factor.direction == "desc" else 1.0 - percentile) * factor.weight / total_weight
                score += contribution
                contributions[factor.field] = round(contribution, 6)
            ranking_contributions[index] = contributions
            ranking_observations[index] = observations
            rankings.append((score, tuple(values.get(f.field) for f in selected.ranking), index))
        if source_record_conflicts:
            for index, observations in ranking_observations.items():
                for field, observation in observations.items():
                    if source_record_conflicts.intersection(observation.get("source_ids") or []):
                        observation["source_ids"] = []
                        observation["validation_status"] = "insufficient_data"
                        source_closure_missing_by_index.setdefault(index, set()).add(field)
        rankings.sort(key=lambda item: (-item[0], enriched[item[2]][0].instrument_id))
        previous_ids = self._previous_candidate_ids(selected.strategy_id)
        point_in_time = self._point_in_time_quality(rows, as_of)
        missing_factor_fields = sorted(
            {
                field
                for observations in ranking_observations.values()
                for field, observation in observations.items()
                if observation.get("validation_status") != "uncalibrated"
            }
        )
        source_closure_missing = sorted(
            f"{enriched[index][0].instrument_id}:{field}"
            for index, fields_missing in source_closure_missing_by_index.items()
            for field in sorted(fields_missing)
        )
        mapped_factor_fields = {
            factor.field
            for factor in selected.ranking
            if any(
                factor.field in horizon_fields
                for horizon_fields in _QUANT_HORIZON_FACTOR_FIELDS.values()
            )
        }
        core_missing = (
            point_in_time["status"] in {"incompatible", "unknown"}
            or quality != "available"
            or skipped_for_cap > 0
            or bool(missing_factor_fields)
            or bool(source_closure_missing)
            or not selected.ranking
            or not mapped_factor_fields
        )
        if point_in_time["status"] == "incompatible":
            quant_reason = "请求的历史时点早于实际行情观测时间，当前数据不能作为点时量化快照"
        elif point_in_time["status"] == "unknown":
            quant_reason = "未提供完整的股票池观测时点，不能确认量化快照的时间口径"
        elif quality != "available":
            quant_reason = f"股票池数据质量为{quality}，不能形成完整量化快照"
        elif skipped_for_cap > 0:
            quant_reason = "仅处理部分候选，未处理股票不能用于完整量化验证"
        elif source_closure_missing:
            quant_reason = "量化因子来源闭包缺失：" + "、".join(source_closure_missing)
        elif missing_factor_fields:
            quant_reason = f"排序因子缺少可核验数据：{'、'.join(missing_factor_fields)}"
        elif not selected.ranking:
            quant_reason = "当前策略没有排序因子，不能形成量化观察"
        elif not mapped_factor_fields:
            quant_reason = "当前排序因子没有可映射的周期观察，不能形成量化结论"
        else:
            quant_reason = "量化因子尚未经过历史校准，不能形成方向信号"
        quant_status = "insufficient_data" if core_missing else "uncalibrated"
        cohort_records = await self._update_calibration_cohorts(
            selected,
            stamp,
            enriched,
            rankings,
            rows,
            skipped_for_cap=skipped_for_cap,
            quality=quality,
            benchmark_reference=calibration_benchmark_reference,
        )
        if cohort_records:
            validation_records = cohort_records
        current_score_diverse = len({round(float(item[0]), 10) for item in rankings}) >= _MIN_QUANT_UNIQUE_SCORES
        current_snapshot_reason = (
            "当前因子无区分度，不能形成交易推荐"
            if not current_score_diverse
            else None
        )
        promotion = self._promotion_result(
            selected,
            validation_records,
            current_snapshot_incomplete=core_missing or not current_score_diverse,
            current_snapshot_reason=current_snapshot_reason,
        )

        factor_scopes: dict[str, dict[str, Any]] = {}
        for factor in selected.ranking:
            records = factor_scope_records.get(factor.field, [])
            observed_scopes = {str(item.get("scope")) for item in records}
            scope = (
                next(iter(observed_scopes))
                if len(observed_scopes) == 1
                else "mixed"
                if observed_scopes
                else normalization_modes.get(factor.field, "market")
            )
            factor_scopes[factor.field] = {
                "scope": scope,
                "sample_count": (
                    min(int(item.get("sample_count") or 0) for item in records)
                    if records
                    else 0
                ),
                "missing_count": max(
                    (int(item.get("missing_count") or 0) for item in records),
                    default=0,
                ),
                "direction": factor.direction,
                "weight": factor.weight,
            }
        candidates: list[StockSelectionCandidate] = []
        report_sources: set[str] = set()
        for rank, (score, _key, index) in enumerate(rankings[: selected.limit], start=1):
            (
                row,
                values,
                matched,
                unmatched,
                missing,
                sources,
                _factor_sources,
                _factor_source_records,
            ) = enriched[index]
            contributions = ranking_contributions.get(index, {})
            reasons = self._reasons(row, values, selected)
            risks = self._risks(row, values, missing)
            quality_value = "partial" if missing else quality
            state = "continued" if row.instrument_id in previous_ids else "new"
            quant_validation = self._quant_validation(
                ranking_observations.get(index, {}),
                (factor.field for factor in selected.ranking),
                snapshot_status=quant_status,
                source_closure_missing=source_closure_missing_by_index.get(index, set()),
                promotion_status=promotion["promotionStatus"],
                promotion_reason=promotion["reason"],
                validation_metrics=promotion.get("metrics") or {},
                strategy_horizon=promotion.get("strategyHorizon"),
                calibrated_horizon=promotion.get("calibratedHorizon"),
            )
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
                quant_validation=quant_validation,
            ))
            report_sources.update(sources)
        report_data_quality = {
            "status": "partial" if skipped_for_cap else quality,
            "factor_algorithm_version": self.FACTOR_VERSION,
            "enrichment_cap": _MAX_ENRICHMENT_ROWS if enrichment_fields else None,
            "unprocessed_after_cap": skipped_for_cap,
            "preselection_basis": "turnover_desc,market_cap_desc,instrument_id_asc" if enrichment_fields else None,
            "normalization": normalization_modes,
            "source_closure_missing": source_closure_missing,
            "promotion_status": promotion["promotionStatus"],
            "promotion_reason": promotion["reason"],
            "eligible_for_trading": promotion["eligibleForTrading"],
            "strategy_horizon": promotion.get("strategyHorizon"),
            "calibrated_horizon": promotion.get("calibratedHorizon"),
            "method_registry": self._quant_method_registry(),
            "validation_metrics": promotion.get("metrics") or {},
        }
        quant_snapshot = {
            "schema_version": 1,
            "strategy_id": selected.strategy_id,
            "strategy_fingerprint": stable_json_hash(
                selected.model_dump(mode="json", exclude={"created_at", "updated_at"})
            ),
            "as_of": stamp,
            "factor_algorithm_version": self.FACTOR_VERSION,
            "rank_algorithm_version": self.RANK_ALGORITHM_VERSION,
            "validation_status": quant_status,
            "reason": quant_reason,
            "universe": {
                "universe_count": len(rows),
                "hard_filter_count": len(hard_rows),
                "cheap_count": len(cheap_rows),
                "enriched_count": len(enriched),
                "unprocessed_after_cap": skipped_for_cap,
                "preselection_basis": report_data_quality["preselection_basis"],
            },
            "factor_scopes": factor_scopes,
            "candidate_ids_hash": stable_json_hash([item.instrument_id for item in candidates]),
            "source_ids": sorted(report_sources),
            "data_quality": {
                "status": quality,
                "quant_validation_status": quant_status,
                "reason": quant_reason,
                "point_in_time": point_in_time,
                "missing_factor_fields": missing_factor_fields,
                "source_closure_missing": source_closure_missing,
            },
            "source_closure_missing": source_closure_missing,
            "promotion_status": promotion["promotionStatus"],
            "promotion_reason": promotion["reason"],
            "eligible_for_trading": promotion["eligibleForTrading"],
            "strategy_horizon": promotion.get("strategyHorizon"),
            "calibrated_horizon": promotion.get("calibratedHorizon"),
            "method_registry": self._quant_method_registry(),
            "validation_metrics": promotion.get("metrics") or {},
        }
        report = StockSelectionReport(
            report_id=f"stock_selection_{workflow_run_id}", workflow_run_id=workflow_run_id,
            strategy=selected, as_of=stamp, universe_count=len(rows), filtered_count=len(enriched),
            candidates=candidates, filter_statistics=stats,
            validation={"status": "unavailable", "reason": "缺少有时间点一致的历史股票池、行情和财务数据"},
            data_quality=report_data_quality,
            missing_fields=sorted({field for item in candidates for field in item.missing_fields}),
            source_ids=sorted(report_sources), status="completed", quant_snapshot=quant_snapshot,
        )
        quant_evidence = self._quant_evidence_payload(report, source_records_by_id)
        self.store.save_run(report)
        self._write_quant_evidence(quant_evidence)
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

    @staticmethod
    def _point_in_time_quality(
        rows: Iterable[MarketSnapshot], requested_as_of: str | None
    ) -> dict[str, Any]:
        """Describe whether the supplied universe can represent ``as_of``.

        The screening provider currently returns a live snapshot.  This
        metadata prevents a caller asking for a historical ``as_of`` from
        mistaking that live snapshot for point-in-time data.
        """
        if not requested_as_of:
            return {
                "status": "not_requested",
                "requested_as_of": None,
                "latest_observed_at": None,
                "missing_observed_at": 0,
            }
        requested = _parse_event_time(requested_as_of)
        raw_rows = list(rows)
        observed = [
            _parse_event_time(item.observed_at or item.as_of)
            for item in raw_rows
        ]
        parsed = [item for item in observed if item is not None]
        missing = len(observed) - len(parsed)
        if requested is None:
            return {
                "status": "unknown",
                "requested_as_of": requested_as_of,
                "latest_observed_at": None,
                "missing_observed_at": missing,
            }
        date_only = len(str(requested_as_of).strip()) <= 10
        future = any(
            (item.date() > requested.date()) if date_only else item > requested
            for item in parsed
        )
        if future:
            status = "incompatible"
        elif missing:
            status = "unknown"
        else:
            status = "verified"
        return {
            "status": status,
            "requested_as_of": requested_as_of,
            "latest_observed_at": max(parsed).isoformat() if parsed else None,
            "missing_observed_at": missing,
        }

    @staticmethod
    def _quant_method_registry() -> dict[str, dict[str, Any]]:
        return {
            horizon: {
                **method,
                "inputFactors": list(method["inputFactors"]),
                "directions": dict(method["directions"]),
                "marketStates": list(method["marketStates"]),
            }
            for horizon, method in _QUANT_METHOD_REGISTRY.items()
        }

    @staticmethod
    def _promotion_result(
        strategy: SelectionStrategy,
        validation_records: Iterable[Mapping[str, Any]] | None,
        *,
        current_snapshot_incomplete: bool,
        current_snapshot_reason: str | None = None,
    ) -> dict[str, Any]:
        result = validate_strategy(
            validation_records,
            # The selection score is always sorted descending after weighted
            # contributions are combined.  A first factor's asc/desc is not
            # the direction of that composite score.
            direction="desc",
            factor_id="composite_score",
            factor_direction="desc",
            strategy_horizon=strategy.horizon,
            cost=TransactionCost(),
            gate=PromotionGate(),
        )
        if current_snapshot_incomplete and result.get("promotionStatus") == "calibrated":
            result = {
                **result,
                "status": "research_only",
                "promotionStatus": "research_only",
                "eligibleForTrading": False,
                "reason": current_snapshot_reason or "当前选股快照未满足数据完整性门槛，仅保留研究排序",
            }
        return result

    def _calibration_cohort_store(self) -> CalibrationCohortStore | None:
        return CalibrationCohortStore(self.workspace) if self.workspace is not None else None

    async def _update_calibration_cohorts(
        self,
        strategy: SelectionStrategy,
        stamp: str,
        rows: list[tuple[Any, dict[str, Any], Any, Any, Any, Any, Any, Any]],
        rankings: list[tuple[float, tuple[Any, ...], int]],
        market_snapshot: list[MarketSnapshot],
        *,
        skipped_for_cap: int,
        quality: str,
        benchmark_reference: Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Persist full eligible cohorts and return only mature OOS records."""
        store = self._calibration_cohort_store()
        if store is None:
            return []
        current_rows: list[dict[str, Any]] = []
        for score, _key, index in rankings:
            row, values, _matched, _unmatched, _missing, sources, _factor_sources, _records = rows[index]
            price = _as_float(values.get("price") or row.price)
            if price is None or price <= 0 or not sources:
                continue
            current_rows.append(
                {
                    "instrument_id": row.instrument_id,
                    "composite_score": round(float(score), 10),
                    "reference_price": price,
                    "source_ids": sorted(set(sources)),
                }
            )
        current_rows.sort(key=lambda item: item["instrument_id"])
        score_diverse = len({row["composite_score"] for row in current_rows}) >= _MIN_QUANT_UNIQUE_SCORES
        complete_market_snapshot = (
            quality == "available"
            and skipped_for_cap == 0
            and bool(market_snapshot)
        )
        benchmark_bars: list[dict[str, Any]] = []
        if complete_market_snapshot and benchmark_reference is None and self.provider is not None and hasattr(self.provider, "kline"):
            try:
                reference_series = await self.provider.kline(
                    InstrumentRef(exchange="XSHG", symbol="000985", instrument_type="index"),
                    limit=640,
                )
                benchmark_bars = [
                    {"date": getattr(bar, "date", None), "close": getattr(bar, "close", None)}
                    for bar in getattr(reference_series, "bars", []) or []
                ]
                stamp_date = str(stamp)[:10]
                reference_bar = next(
                    (bar for bar in benchmark_bars if str(bar.get("date"))[:10] == stamp_date),
                    None,
                )
                if reference_bar is not None:
                    benchmark_reference = {
                        "price": reference_bar.get("close"),
                        "as_of": stamp,
                        "source_ids": [
                            source_id
                            for source_id in [getattr(getattr(reference_series, "source", None), "id", "")]
                            if source_id
                        ],
                    }
            except Exception:
                benchmark_reference = None
        strategy_fingerprint = stable_json_hash(
            strategy.model_dump(mode="json", exclude={"created_at", "updated_at"})
        )
        strategy_window = int(
            _QUANT_METHOD_REGISTRY.get(strategy.horizon, {}).get(
                "targetWindowSessions", 10
            )
        )
        cohorts = store.list(strategy.strategy_id)
        if complete_market_snapshot:
            current_snapshot_hash = stable_json_hash(
                {
                    "as_of": stamp,
                    "strategy": strategy_fingerprint,
                    "rows": [
                        {
                            "instrument_id": row.instrument_id,
                            "price": row.price,
                            "source_ids": sorted(set(row.source_ids)),
                        }
                        for row in sorted(market_snapshot, key=lambda item: item.instrument_id)
                    ],
                }
            )
            current_by_id = {
                row.instrument_id: {
                    "reference_price": _as_float(row.price),
                    "source_ids": sorted(set(row.source_ids)),
                }
                for row in market_snapshot
                if _as_float(row.price) is not None and _as_float(row.price) > 0
            }
            for cohort in cohorts:
                if cohort.get("as_of") == stamp:
                    continue
                observations = [
                    {
                        "instrument_id": instrument_id,
                        "as_of": stamp,
                        "price": current_by_id[instrument_id]["reference_price"],
                        "source_ids": current_by_id[instrument_id]["source_ids"],
                        "snapshot_hash": current_snapshot_hash,
                        "universe_count": cohort.get("universe_count"),
                        "observed_count": cohort.get("observed_count"),
                        "sample_scope": "full_eligible_universe",
                    }
                    for instrument_id in (
                        row.get("instrument_id") for row in cohort.get("rows") or []
                    )
                    if instrument_id in current_by_id
                ]
                store.append_observations(cohort["cohort_id"], observations)
            if score_diverse and current_rows and len(current_rows) == len(rankings):
                store.create(
                    make_cohort_payload(
                        strategy_id=strategy.strategy_id,
                        strategy_fingerprint=strategy_fingerprint,
                        as_of=stamp,
                        factor_version=self.FACTOR_VERSION,
                        rank_version=self.RANK_ALGORITHM_VERSION,
                        rows=current_rows,
                        universe_count=len(current_rows),
                        observed_count=len(current_rows),
                        validation_window=strategy_window,
                        validation_windows=VALIDATION_WINDOWS,
                        benchmark_reference=benchmark_reference,
                    )
                )
            cohorts = store.list(strategy.strategy_id)
        older_cohorts = [cohort for cohort in cohorts if cohort.get("as_of") != stamp]
        if not older_cohorts or self.provider is None or not hasattr(self.provider, "kline"):
            return []
        try:
            benchmark_series = await self.provider.kline(
                InstrumentRef(exchange="XSHG", symbol="000985", instrument_type="index"),
                limit=640,
            )
        except Exception:
            return []
        benchmark_bars = [
            {"date": getattr(bar, "date", None), "close": getattr(bar, "close", None)}
            for bar in getattr(benchmark_series, "bars", []) or []
        ]
        benchmark_source_id = getattr(getattr(benchmark_series, "source", None), "id", None)
        cohort_instruments = sorted(
            {
                str(row.get("instrument_id"))
                for cohort in older_cohorts
                for row in cohort.get("rows") or []
                if isinstance(row, Mapping) and isinstance(row.get("instrument_id"), str)
            }
        )
        target_bars: dict[str, list[dict[str, Any]]] = {}
        semaphore = asyncio.Semaphore(_ENRICHMENT_CONCURRENCY)

        async def load_target_bars(instrument_id: str) -> tuple[str, list[dict[str, Any]]]:
            exchange, symbol = instrument_id.split(":", 1)
            async with semaphore:
                try:
                    series = await self.provider.kline(
                        InstrumentRef(exchange=exchange, symbol=symbol, instrument_type="equity"),
                        limit=640,
                    )
                except Exception:
                    return instrument_id, []
            source_id = getattr(getattr(series, "source", None), "id", None)
            return instrument_id, [
                {
                    "date": getattr(bar, "date", None),
                    "close": getattr(bar, "close", None),
                    "source_ids": [source_id] if source_id else [],
                }
                for bar in getattr(series, "bars", []) or []
            ]

        loaded_targets = await asyncio.gather(
            *(load_target_bars(instrument_id) for instrument_id in cohort_instruments)
        )
        target_bars.update(loaded_targets)
        records: list[dict[str, Any]] = []
        for cohort in older_cohorts:
            result = build_validation_records(
                cohort,
                benchmark_bars=benchmark_bars,
                source_ids=[benchmark_source_id] if benchmark_source_id else [],
                instrument_bars=target_bars,
            )
            if result["status"] == "complete":
                # The cohort stores all three horizons, but a rolling
                # validator must receive one target window per strategy;
                # otherwise the same factor-date/instrument appears three
                # times and is correctly rejected as a duplicate sample.
                records.extend(
                    row for row in result["records"] if row.get("window") == strategy_window
                )
        return records

    @staticmethod
    def _resolve_factor_sources(
        source_ids: Iterable[str],
        records: Iterable[SourceRecord],
        registry: dict[str, dict[str, Any]],
        conflicts: set[str],
    ) -> tuple[list[str], bool]:
        """Return source ids whose complete records are present and consistent.

        A source id alone is not a provenance record.  The sidecar only treats
        a factor as closed when every declared id has an exact SourceRecord;
        conflicting records for one id are also considered unresolved.
        """
        declared = sorted({item for item in source_ids if isinstance(item, str) and item})
        payloads: dict[str, dict[str, Any]] = {}
        for record in records:
            if not isinstance(record, SourceRecord) or not record.id:
                continue
            payload = record.model_dump(mode="json")
            existing = registry.get(record.id)
            if existing is not None and existing != payload:
                conflicts.add(record.id)
            else:
                registry.setdefault(record.id, payload)
            payloads[record.id] = payload

        if not declared:
            declared = sorted(payloads)
        if not declared or any(item not in payloads for item in declared):
            return [], True
        if any(item in conflicts for item in declared):
            return [], True
        return declared, False

    @staticmethod
    def _quant_validation(
        observations: dict[str, dict[str, Any]],
        ranking_fields: Iterable[str],
        *,
        snapshot_status: str,
        source_closure_missing: Iterable[str] = (),
        promotion_status: QuantPromotionStatus = "research_only",
        promotion_reason: str = "当前策略仅用于研究观察",
        validation_metrics: dict[str, Any] | None = None,
        strategy_horizon: StrategyHorizon | None = None,
        calibrated_horizon: StrategyHorizon | None = None,
    ) -> QuantCandidateValidation:
        by_horizon: dict[str, list[dict[str, Any]]] = {
            "short_term": [],
            "medium_term": [],
            "long_term": [],
        }
        for field in ranking_fields:
            observation = observations.get(field)
            if observation is None:
                continue
            for horizon, fields in _QUANT_HORIZON_FACTOR_FIELDS.items():
                if field in fields:
                    by_horizon[horizon].append(dict(observation))
        horizons: dict[str, QuantHorizonValidation] = {}
        for horizon, raw_observations in by_horizon.items():
            horizon_status: QuantValidationStatus = (
                "uncalibrated"
                if raw_observations
                and all(
                    item.get("validation_status") == "uncalibrated"
                    for item in raw_observations
                )
                else "insufficient_data"
            )
            horizons[horizon] = QuantHorizonValidation.model_validate(
                {
                    "validation_status": horizon_status,
                    "factor_observations": raw_observations,
                }
            )
        candidate_status: QuantValidationStatus = (
            "insufficient_data"
            if snapshot_status == "insufficient_data"
            or any(
                item.validation_status == "insufficient_data"
                for item in horizons.values()
            )
            or bool(source_closure_missing)
            else "uncalibrated"
        )
        return QuantCandidateValidation.model_validate(
            {
                "validation_status": candidate_status,
                "horizons": horizons,
                "source_closure_missing": sorted(set(source_closure_missing)),
                "promotion_status": promotion_status,
                "promotion_reason": promotion_reason,
                "eligible_for_trading": promotion_status == "calibrated",
                "strategy_horizon": strategy_horizon,
                "calibrated_horizon": calibrated_horizon,
                "validation_metrics": validation_metrics or {},
            }
        )

    @staticmethod
    def _quant_evidence_payload(
        report: StockSelectionReport,
        source_records_by_id: dict[str, dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Build the private provenance sidecar for a quant snapshot."""
        report_payload = report.model_dump(by_alias=True)
        quant_snapshot = report_payload.get("quantSnapshot")
        if not isinstance(quant_snapshot, dict):
            return None
        candidates: dict[str, dict[str, Any]] = {}
        used_source_ids: set[str] = set()
        for candidate in report.candidates:
            validation = candidate.quant_validation
            if validation is None:
                continue
            validation_payload = validation.model_dump(mode="json")
            factor_source_ids: dict[str, list[str]] = {}
            for horizon in validation_payload.get("horizons", {}).values():
                for observation in horizon.get("factor_observations", []):
                    field = observation.get("field")
                    source_ids = sorted(
                        {
                            item
                            for item in observation.get("source_ids", [])
                            if isinstance(item, str) and item
                        }
                    )
                    if not isinstance(field, str) or not field:
                        continue
                    factor_source_ids[field] = source_ids
                    used_source_ids.update(source_ids)
                    if any(item not in source_records_by_id for item in source_ids):
                        raise ScreeningValidationError(
                            f"quant evidence source closure failed for {candidate.instrument_id}:{field}"
                        )
            candidates[candidate.instrument_id] = {
                "quant_validation": validation_payload,
                "factor_source_ids": factor_source_ids,
            }
        return {
            "schema_version": 1,
            "run_id": report.workflow_run_id,
            "report_id": report.report_id,
            "strategy_fingerprint": quant_snapshot.get("strategyFingerprint"),
            "quant_snapshot_hash": stable_json_hash(quant_snapshot),
            "candidates": candidates,
            "sources": [
                source_records_by_id[source_id]
                for source_id in sorted(used_source_ids)
            ],
        }

    def _quant_evidence_path(self, run_id: str) -> Path:
        report_path = self._report_path(run_id)
        if self.workspace is None:
            return report_path.with_name(f"{run_id}.quant_evidence.json")
        return report_path.with_name("quant_evidence.json")

    def _write_quant_evidence(self, payload: dict[str, Any] | None) -> None:
        if payload is None:
            return
        run_id = payload.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            raise ScreeningValidationError("quant evidence run_id is missing")
        path = self._quant_evidence_path(run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ScreeningValidationError(
                    f"quant evidence is unreadable for {run_id}"
                ) from exc
            if existing != payload:
                raise ScreeningValidationError(
                    f"quant evidence {run_id} is immutable; start a new run"
                )
            return
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

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
        # A workflow run is an immutable input to later outcome replay.  A
        # retry with the same run id must not replace its quant snapshot with
        # newer provider data; start a new run to create a new snapshot.
        if path.is_file():
            return
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
