"""Structured artifact payload schemas (design §6, §8; dev plan T12).

Pydantic models validating the ``submit_*`` tool payloads before anything
is persisted. Every model forbids unexpected fields so a model cannot
smuggle trusted identity fields (``run_id``, ``room_id`` …) into a
payload — those always come from the ToolContext. Artifact JSON keeps
snake_case keys (design §7.3).

Two payload families:

- :class:`ViewSubmission` — the five analyst/researcher view tools, with
  a single-instrument mode (deep research) and a batch ``items`` mode
  (daily review).
- :class:`ReportSubmission` — the chairman's ``submit_stock_report``,
  with the deep-research report mode (§8 schema) and the daily-review
  digest variant (§5.3).
"""

from __future__ import annotations

from datetime import datetime
from math import isfinite
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

STANCES = ("positive", "neutral", "negative", "insufficient_data")
DATA_QUALITIES = ("complete", "degraded")
EXCHANGES = ("XSHG", "XSHE", "BJSE")
INSTRUMENT_TYPES = ("equity", "etf", "index")
DISCLAIMER = "仅供信息研究与学习参考，不构成投资建议。"

Stance = Literal["positive", "neutral", "negative", "insufficient_data"]
DataQuality = Literal["complete", "degraded"]
EvidenceStrength = Literal["low", "medium", "high"]
ClaimType = Literal["fact", "inference", "hypothesis"]
HorizonStatus = Literal["available", "insufficient_data"]
DataStatus = Literal["available", "degraded", "missing"]
ConditionKind = Literal["manual", "trigger"]
ConditionOperator = Literal[
    "gt", "gte", "lt", "lte", "crosses_above", "crosses_below"
]
Action = Literal[
    "observe",
    "wait_for_confirmation",
    "conditional_participation",
    "reduce_exposure",
    "not_applicable",
]
PricedIn = Literal["not_priced_in", "partially_priced_in", "fully_priced_in", "unknown"]
RelativeView = Literal["outperform", "inline", "underperform", "unknown"]
ConflictStatus = Literal["aligned", "mixed", "insufficient_data"]
DimensionKey = Literal[
    "market_environment",
    "industry",
    "policy",
    "cycle",
    "company_quality",
    "valuation",
    "capital_positioning",
    "event_risk",
]

ANALYSIS_DIMENSION_KEYS = (
    "market_environment",
    "industry",
    "policy",
    "cycle",
    "company_quality",
    "valuation",
    "capital_positioning",
    "event_risk",
)

VIEW_SCHEMA_VERSION = 3
REPORT_SCHEMA_VERSION = 4
DECISION_REPORT_SCHEMA_VERSION = 5
DIGEST_SCHEMA_VERSION = 3

V5_FORBIDDEN_TERMS = (
    "insufficient_data",
    "unknown",
    "not_evaluable",
    "数据不足",
    "证据不足",
    "数据缺失",
    "暂不判断",
    "暂无法判断",
    "未提供",
)


class Payload(BaseModel):
    """Common base: reject anything the schema does not declare."""

    model_config = ConfigDict(extra="forbid")


class InstrumentTag(Payload):
    symbol: str = Field(pattern=r"^\d{6}$")
    exchange: Literal["XSHG", "XSHE", "BJSE"]
    name: str = ""
    instrument_type: Literal["equity", "etf", "index"] = "equity"


class ViewPoint(Payload):
    """One claim inside a view with an explicit epistemic status."""

    claim: str = Field(min_length=1)
    evidence: str = ""
    claim_type: ClaimType
    basis: str | None = None
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_provenance(self) -> "ViewPoint":
        if self.claim_type == "fact" and not self.source_ids:
            raise ValueError("fact claims require at least one source_id")
        if self.claim_type == "inference":
            if not self.source_ids:
                raise ValueError("inference claims require at least one source_id")
            if not (self.basis or "").strip():
                raise ValueError("inference claims require a non-empty basis")
        if self.basis is not None and not self.basis.strip():
            raise ValueError("basis must not be blank")
        return self


class ViewItem(Payload):
    """One instrument's view inside a batch (daily-review) submission."""

    instrument: InstrumentTag
    stance: Stance
    summary: str = Field(min_length=1)
    points: list[ViewPoint] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)


class BatchViewSubmission(Payload):
    """Legacy-compatible daily-review batch payload for the three analysts."""

    as_of: str = Field(min_length=1)
    items: list[ViewItem]

    @model_validator(mode="after")
    def _non_empty_items(self) -> "BatchViewSubmission":
        if not self.items:
            raise ValueError("items must be a non-empty list in batch mode")
        return self

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []

        for item in self.items:
            for source_id in item.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
            for point in item.points:
                for source_id in point.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class SingleViewSubmission(Payload):
    """Common single-instrument fields for structured V3 analyst views."""

    as_of: str = Field(min_length=1)
    instrument: InstrumentTag
    stance: Stance
    summary: str = Field(min_length=1)
    source_ids: list[str]

    def all_source_ids(self) -> list[str]:
        return list(dict.fromkeys(self.source_ids))


class TechnicalViewSubmission(SingleViewSubmission):
    """Market and trading view; all four sections are explicit, even empty."""

    market_regime: list[ViewPoint]
    capital_positioning: list[ViewPoint]
    tradeability: list[ViewPoint]
    short_term_timing: list[ViewPoint]

    @model_validator(mode="after")
    def _empty_requires_insufficient_data(self) -> "TechnicalViewSubmission":
        if not any((self.market_regime, self.capital_positioning, self.tradeability, self.short_term_timing)) and self.stance != "insufficient_data":
            raise ValueError("empty technical sections require stance=insufficient_data")
        return self

    def all_source_ids(self) -> list[str]:
        ids = super().all_source_ids()
        for section in (
            self.market_regime,
            self.capital_positioning,
            self.tradeability,
            self.short_term_timing,
        ):
            for point in section:
                for source_id in point.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class NewsViewSubmission(SingleViewSubmission):
    """Industry, policy, cycle and event view; all four sections are explicit."""

    industry_context: list[ViewPoint]
    policy_context: list[ViewPoint]
    cycle_context: list[ViewPoint]
    event_calendar: list[ViewPoint]

    @model_validator(mode="after")
    def _empty_requires_insufficient_data(self) -> "NewsViewSubmission":
        if not any((self.industry_context, self.policy_context, self.cycle_context, self.event_calendar)) and self.stance != "insufficient_data":
            raise ValueError("empty news sections require stance=insufficient_data")
        return self

    def all_source_ids(self) -> list[str]:
        ids = super().all_source_ids()
        for section in (
            self.industry_context,
            self.policy_context,
            self.cycle_context,
            self.event_calendar,
        ):
            for point in section:
                for source_id in point.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class FundamentalViewSubmission(SingleViewSubmission):
    """Company quality, financial quality, valuation and long-term value view."""

    company_quality: list[ViewPoint]
    financial_quality: list[ViewPoint]
    valuation_context: list[ViewPoint]
    long_term_value: list[ViewPoint]

    @model_validator(mode="after")
    def _empty_requires_insufficient_data(self) -> "FundamentalViewSubmission":
        if not any((self.company_quality, self.financial_quality, self.valuation_context, self.long_term_value)) and self.stance != "insufficient_data":
            raise ValueError("empty fundamental sections require stance=insufficient_data")
        return self

    def all_source_ids(self) -> list[str]:
        ids = super().all_source_ids()
        for section in (
            self.company_quality,
            self.financial_quality,
            self.valuation_context,
            self.long_term_value,
        ):
            for point in section:
                for source_id in point.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class HorizonCase(Payload):
    """One horizon's case; empty claims are valid with an explicit summary."""

    status: HorizonStatus
    summary: str = Field(min_length=1)
    points: list[ViewPoint]
    assumptions: list[ViewPoint]
    confirmation: list[ViewPoint]
    invalidation: list[ViewPoint]
    source_ids: list[str]

    @model_validator(mode="after")
    def _validate_status_and_conditions(self) -> "HorizonCase":
        if self.status == "available" and not self.points:
            raise ValueError("available horizon case requires at least one point")
        for condition_name in ("confirmation", "invalidation"):
            if any(point.claim_type == "hypothesis" for point in getattr(self, condition_name)):
                raise ValueError(f"{condition_name} cannot contain hypothesis claims")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for group in (self.points, self.assumptions, self.confirmation, self.invalidation):
            for point in group:
                for source_id in point.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class HorizonCases(Payload):
    """Exactly the three supported research horizons."""

    short_term: HorizonCase
    medium_term: HorizonCase
    long_term: HorizonCase

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for case in (self.short_term, self.medium_term, self.long_term):
            for source_id in case.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class HorizonCaseSubmission(SingleViewSubmission):
    """Bull/bear submission with a required case for every horizon."""

    horizon_cases: HorizonCases

    @model_validator(mode="after")
    def _empty_cases_require_insufficient_data(self) -> "HorizonCaseSubmission":
        if self.stance != "insufficient_data" and all(
            case.status == "insufficient_data"
            for case in (
                self.horizon_cases.short_term,
                self.horizon_cases.medium_term,
                self.horizon_cases.long_term,
            )
        ):
            raise ValueError("all insufficient horizon cases require stance=insufficient_data")
        return self

    def all_source_ids(self) -> list[str]:
        ids = super().all_source_ids()
        for source_id in self.horizon_cases.all_source_ids():
            if source_id not in ids:
                ids.append(source_id)
        return ids


# Compatibility export for callers that imported the old generic batch model.
ViewSubmission = BatchViewSubmission


class MarketSnapshot(Payload):
    price: float
    change_pct: float


class TechnicalLevels(Payload):
    """Support/resistance may enter a report only with a versioned method."""

    support: float | None = None
    resistance: float | None = None
    method: str = Field(min_length=1)


class ManualCondition(Payload):
    """A human-observation condition; never treated as an auto trigger."""

    text: str = Field(min_length=1)

    @model_validator(mode="after")
    def _non_blank(self) -> "ManualCondition":
        if not self.text.strip():
            raise ValueError("manual condition text must not be blank")
        return self


class ManualConditions(Payload):
    confirmation: list[ManualCondition] = Field(default_factory=list)
    watch: list[ManualCondition] = Field(default_factory=list)
    invalidation: list[ManualCondition] = Field(default_factory=list)


class MethodRef(Payload):
    """Versioned deterministic calculation inputs for a numeric condition."""

    method: str = Field(min_length=1)
    version: str = Field(min_length=1)
    inputs: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _non_blank_inputs(self) -> "MethodRef":
        if any(not item.strip() for item in self.inputs):
            raise ValueError("method_ref inputs must not be blank")
        return self


class NumericCondition(Payload):
    """A machine-checkable condition tied to Evidence or a deterministic method."""

    description: str = Field(min_length=1)
    metric_ref: str | None = Field(default=None, min_length=1)
    method_ref: MethodRef | None = None

    @model_validator(mode="after")
    def _exactly_one_reference(self) -> "NumericCondition":
        if (self.metric_ref is None) == (self.method_ref is None):
            raise ValueError("numeric condition requires exactly one metric_ref or method_ref")
        if not self.description.strip():
            raise ValueError("numeric condition description must not be blank")
        return self


class DecisionConditions(Payload):
    """Manual observations and machine-checkable conditions are separate.

    The legacy string buckets remain readable/writable for V3 callers. New
    agents should use ``manual_conditions`` and ``numeric_conditions``; the
    legacy buckets are serialized unchanged for older consumers and are never
    interpreted as automatic numeric triggers.
    """

    manual_conditions: ManualConditions = Field(default_factory=ManualConditions)
    numeric_conditions: list[NumericCondition] = Field(default_factory=list)
    # V3 compatibility buckets. They remain human observations only.
    confirmation: list[str] = Field(default_factory=list)
    watch: list[str] = Field(default_factory=list)
    invalidation: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _non_blank(self) -> "DecisionConditions":
        for name in ("confirmation", "watch", "invalidation"):
            if any(not value.strip() for value in getattr(self, name)):
                raise ValueError(f"{name} conditions must not contain blank values")
        return self


class DigestItem(Payload):
    """One watchlist row inside the daily-review digest."""

    instrument: InstrumentTag
    stance: Stance
    one_liner: str = Field(min_length=1)
    data_quality: DataQuality
    missing: list[str] = Field(default_factory=list)


class HorizonCondition(Payload):
    """A manual observation or an evidence-backed deterministic trigger."""

    kind: ConditionKind
    text: str = ""
    claim_type: ClaimType | None = None
    observed_metric_ref: str | None = None
    operator: ConditionOperator | None = None
    threshold_metric_ref: str | None = None
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_kind_and_threshold(self) -> "HorizonCondition":
        if self.kind == "manual":
            if not self.text.strip():
                raise ValueError("manual conditions require non-empty text")
            if any(
                value is not None
                for value in (
                    self.observed_metric_ref,
                    self.operator,
                    self.threshold_metric_ref,
                )
            ):
                raise ValueError("manual conditions cannot carry trigger fields")
            return self
        if not self.observed_metric_ref or self.operator is None:
            raise ValueError("trigger conditions require observed_metric_ref and operator")
        if not self.source_ids:
            raise ValueError("trigger conditions require at least one source_id")
        if self.threshold_metric_ref is None:
            raise ValueError(
                "trigger conditions require threshold_metric_ref from Evidence"
            )
        if self.observed_metric_ref == self.threshold_metric_ref:
            raise ValueError(
                "trigger conditions require distinct observed_metric_ref and threshold_metric_ref"
            )
        if not self.text.strip():
            raise ValueError("trigger conditions require non-empty text")
        return self


class Benchmark(Payload):
    name: str = Field(min_length=1)
    relative_view: RelativeView
    instrument_id: str | None = Field(
        default=None, pattern=r"^(XSHG|XSHE|BJSE):\d{6}$"
    )
    basis: str | None = None
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _require_verifiable_comparison(self) -> "Benchmark":
        if self.basis is not None and not self.basis.strip():
            raise ValueError("benchmark basis must not be blank")
        if self.relative_view != "unknown" and (
            not self.instrument_id or not self.basis or not self.basis.strip() or not self.source_ids
        ):
            raise ValueError(
                "non-unknown benchmark comparison requires instrument_id, basis and source_ids"
            )
        return self

    def all_source_ids(self) -> list[str]:
        return list(dict.fromkeys(self.source_ids))


class HorizonView(Payload):
    """Independent short/medium/long conclusion for the V4 report."""

    stance: Stance
    status: HorizonStatus
    thesis: str = Field(min_length=1)
    drivers: list[ViewPoint] = Field(default_factory=list)
    priced_in: PricedIn
    priced_in_basis: ViewPoint | None = None
    benchmark: Benchmark
    action: Action
    participation_conditions: list[HorizonCondition] = Field(default_factory=list)
    confirmation_conditions: list[HorizonCondition] = Field(default_factory=list)
    watch_conditions: list[HorizonCondition] = Field(default_factory=list)
    invalidation_conditions: list[HorizonCondition] = Field(default_factory=list)
    stop_loss_conditions: list[HorizonCondition] = Field(default_factory=list)
    take_profit_conditions: list[HorizonCondition] = Field(default_factory=list)
    time_stop: str = Field(min_length=1)
    tradeability_risks: list[ViewPoint] = Field(default_factory=list)
    blind_spots: list[ViewPoint] = Field(default_factory=list)
    evidence_strength: EvidenceStrength
    data_status: DataQuality
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    dimension_keys: list[DimensionKey]

    @model_validator(mode="after")
    def _status_matches_stance(self) -> "HorizonView":
        if (self.status == "insufficient_data") != (
            self.stance == "insufficient_data"
        ):
            raise ValueError("horizon status and stance must agree on insufficient_data")
        if self.status == "insufficient_data" and not self.missing_fields:
            raise ValueError("insufficient_data horizon requires missing_fields")
        if self.status == "insufficient_data" and self.data_status != "degraded":
            raise ValueError("insufficient_data horizon requires data_status=degraded")
        if self.status == "available":
            if not self.drivers:
                raise ValueError("available horizon requires at least one driver")
            if not any(
                point.claim_type in ("fact", "inference") and point.source_ids
                for point in self.drivers
            ):
                raise ValueError(
                    "available horizon requires a sourced fact or inference driver"
                )
        if self.priced_in != "unknown":
            if self.priced_in_basis is None or self.priced_in_basis.claim_type != "inference":
                raise ValueError(
                    "non-unknown priced_in requires an inference priced_in_basis"
                )
        if len(set(self.dimension_keys)) != len(self.dimension_keys):
            raise ValueError("horizon dimension_keys must be unique")
        for field_name in ("stop_loss_conditions", "take_profit_conditions"):
            conditions = getattr(self, field_name)
            if any(
                condition.claim_type not in ("fact", "inference")
                or not condition.source_ids
                or any(not source_id.strip() for source_id in condition.source_ids)
                for condition in conditions
            ):
                raise ValueError(
                    f"{field_name} require non-empty claim_type and source_ids"
                )
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.drivers + self.tradeability_risks + self.blind_spots:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        if self.priced_in_basis is not None:
            for source_id in self.priced_in_basis.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for source_id in self.benchmark.all_source_ids():
            if source_id not in ids:
                ids.append(source_id)
        for group in (
            self.participation_conditions,
            self.confirmation_conditions,
            self.watch_conditions,
            self.invalidation_conditions,
            self.stop_loss_conditions,
            self.take_profit_conditions,
        ):
            for condition in group:
                for source_id in condition.source_ids:
                    if source_id not in ids:
                        ids.append(source_id)
        return ids


class HorizonViews(Payload):
    short_term: HorizonView
    medium_term: HorizonView
    long_term: HorizonView

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for view in (self.short_term, self.medium_term, self.long_term):
            for source_id in view.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class DebateResolution(Payload):
    """Compact, source-backed chairman ruling for one investment horizon."""

    status: DataStatus
    issue: str = Field(min_length=1)
    bull_case: list[ViewPoint] = Field(default_factory=list)
    bear_case: list[ViewPoint] = Field(default_factory=list)
    verdict: list[ViewPoint] = Field(default_factory=list)
    change_conditions: list[HorizonCondition] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_resolution(self) -> "DebateResolution":
        if self.status == "available":
            if not self.bull_case or not self.bear_case or not self.verdict:
                raise ValueError(
                    "available debate resolution requires bull_case, bear_case and verdict"
                )
            if not any(
                point.claim_type in ("fact", "inference") and point.source_ids
                for point in self.bull_case + self.bear_case + self.verdict
            ):
                raise ValueError("available debate resolution requires sourced reasoning")
        elif not self.missing_fields:
            raise ValueError("degraded or missing debate resolution requires missing_fields")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.bull_case + self.bear_case + self.verdict:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for condition in self.change_conditions:
            for source_id in condition.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class DebateResolutions(Payload):
    """One non-verbatim debate ruling for each independent horizon."""

    short_term: DebateResolution
    medium_term: DebateResolution
    long_term: DebateResolution

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for view in (self.short_term, self.medium_term, self.long_term):
            for source_id in view.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class CycleState(Payload):
    status: DataStatus
    stage: str = Field(min_length=1)
    leading_indicators: list[ViewPoint] = Field(default_factory=list)
    confirmation_indicators: list[ViewPoint] = Field(default_factory=list)
    turning_conditions: list[HorizonCondition] = Field(default_factory=list)
    observation_window: str = Field(min_length=1)
    evidence_strength: EvidenceStrength
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.leading_indicators + self.confirmation_indicators:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for condition in self.turning_conditions:
            for source_id in condition.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class CycleStates(Payload):
    policy: CycleState
    industry: CycleState
    earnings: CycleState
    valuation: CycleState

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for cycle in (self.policy, self.industry, self.earnings, self.valuation):
            for source_id in cycle.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class SummarySection(Payload):
    status: DataStatus
    summary: str = Field(min_length=1)
    points: list[ViewPoint] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.points:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class AnalysisDimension(Payload):
    """One independently auditable conclusion in the report's eight dimensions.

    The three point buckets make epistemic status visible in the persisted
    report instead of flattening facts, inferences and hypotheses into one
    prose summary. Timing is filled from the trusted Evidence sources by the
    submit tool; callers cannot make it authoritative by writing a timestamp.
    """

    status: DataStatus
    summary: str = Field(min_length=1)
    # ``points`` is the renderer-facing list; the three buckets make the
    # epistemic split explicit for agents and are normalized into this list.
    points: list[ViewPoint] = Field(default_factory=list)
    facts: list[ViewPoint] = Field(default_factory=list)
    inferences: list[ViewPoint] = Field(default_factory=list)
    hypotheses: list[ViewPoint] = Field(default_factory=list)
    research_cutoff_at: str | None = None
    market_as_of: str | None = None
    published_at: str | None = None
    period_end: str | None = None
    missing_fields: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_dimension_contract(self) -> "AnalysisDimension":
        buckets = self.facts + self.inferences + self.hypotheses
        if self.facts or self.inferences or self.hypotheses:
            if self.points and self.points != buckets:
                raise ValueError(
                    "analysis dimension points must equal facts + inferences + hypotheses"
                )
            self.points = buckets
        elif self.points:
            self.facts = [point for point in self.points if point.claim_type == "fact"]
            self.inferences = [point for point in self.points if point.claim_type == "inference"]
            self.hypotheses = [point for point in self.points if point.claim_type == "hypothesis"]
        if any(point.claim_type != "fact" for point in self.facts):
            raise ValueError("analysis dimension facts must use claim_type=fact")
        if any(point.claim_type != "inference" for point in self.inferences):
            raise ValueError("analysis dimension inferences must use claim_type=inference")
        if any(point.claim_type != "hypothesis" for point in self.hypotheses):
            raise ValueError("analysis dimension hypotheses must use claim_type=hypothesis")
        if self.status == "available":
            if not any(point.claim_type in ("fact", "inference") for point in self.points):
                raise ValueError("available analysis dimension requires fact or inference points")
            if not any(
                point.source_ids
                for point in self.points
                if point.claim_type in ("fact", "inference")
            ):
                raise ValueError("available analysis dimension requires sourced fact or inference")
        if self.status in ("degraded", "missing") and not self.missing_fields:
            raise ValueError("degraded or missing analysis dimension requires missing_fields")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.points:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class DimensionViews(Payload):
    """The eight conclusions that every new deep-research report must carry."""

    market_environment: AnalysisDimension
    industry: AnalysisDimension
    policy: AnalysisDimension
    cycle: AnalysisDimension
    company_quality: AnalysisDimension
    valuation: AnalysisDimension
    capital_positioning: AnalysisDimension
    event_risk: AnalysisDimension

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for key in ANALYSIS_DIMENSION_KEYS:
            for source_id in getattr(self, key).all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


# Python compatibility for callers that used the design terminology before
# the persisted report contract settled on ``dimension_views``.
AnalysisDimensions = DimensionViews


class Scenario(Payload):
    summary: str = Field(min_length=1)
    conditions: list[HorizonCondition] = Field(default_factory=list)
    outcome_direction: str = Field(min_length=1)
    risks: list[ViewPoint] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _requires_condition(self) -> "Scenario":
        if not self.conditions:
            raise ValueError("scenario requires at least one condition")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for condition in self.conditions:
            for source_id in condition.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for point in self.risks:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class ScenarioSet(Payload):
    optimistic: Scenario
    base: Scenario
    pessimistic: Scenario

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for scenario in (self.optimistic, self.base, self.pessimistic):
            for source_id in scenario.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class ScenarioSets(Payload):
    short_term: ScenarioSet
    medium_term: ScenarioSet
    long_term: ScenarioSet

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for scenarios in (self.short_term, self.medium_term, self.long_term):
            for source_id in scenarios.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class CrossHorizonConflict(Payload):
    """The model supplies only an explanation; status is derived by the tool."""

    explanation: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)


V5Direction = Literal["positive", "neutral", "negative"]
V5Action = Literal[
    "conditional_participation",
    "wait",
    "hold",
    "reduce",
    "exit",
    "avoid",
]
V5NotHoldingAction = Literal["participate", "wait", "avoid"]
V5HoldingAction = Literal["hold", "reduce", "exit"]
V5EvidenceStrength = Literal["strong", "medium", "weak"]
V5ConditionKind = Literal["price_trigger", "event_trigger", "scheduled_review"]
V5ConditionStatus = Literal[
    "triggered",
    "not_triggered",
    "waiting_event",
    "confirmed",
    "invalidated",
    "scheduled",
    "due",
]


def _v5_datetime(value: str, field_name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a valid ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field_name} must include a timezone")
    return parsed


def _v5_price(value: float, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise ValueError(f"{field_name} must be a finite number")
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    if abs(float(value) - round(float(value), 2)) > 1e-8:
        raise ValueError(f"{field_name} must use A-share two-decimal precision")
    return float(value)


def _v5_validate_claims(points: list[ViewPoint], field_name: str) -> None:
    if any(
        point.claim_type not in ("fact", "inference") or not point.source_ids
        for point in points
    ):
        raise ValueError(f"V5 {field_name} must contain sourced fact or inference claims")


class V5TradingCondition(Payload):
    """A condition injected by the deterministic decision layer.

    The model-facing submission deliberately has no field of this type.  Its
    status and all numeric thresholds are therefore never LLM-controlled.
    """

    kind: V5ConditionKind
    description: str = Field(min_length=1)
    observed_metric_ref: str | None = Field(default=None, min_length=1)
    operator: ConditionOperator | None = None
    threshold_metric_ref: str | None = Field(default=None, min_length=1)
    status: V5ConditionStatus
    market_as_of: str
    source_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_kind_status_and_time(self) -> "V5TradingCondition":
        _v5_datetime(self.market_as_of, "market_as_of")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V5 condition source_ids must not contain blanks")
        if self.kind == "price_trigger":
            if not self.observed_metric_ref or self.operator is None or not self.threshold_metric_ref:
                raise ValueError(
                    "price_trigger requires observed_metric_ref, operator and threshold_metric_ref"
                )
            if self.observed_metric_ref == self.threshold_metric_ref:
                raise ValueError("price_trigger metric references must be distinct")
            if self.status not in {"triggered", "not_triggered"}:
                raise ValueError("price_trigger has an invalid status")
        elif self.kind == "event_trigger":
            if self.status not in {"waiting_event", "confirmed", "invalidated"}:
                raise ValueError("event_trigger has an invalid status")
            if self.observed_metric_ref is not None or self.operator is not None or self.threshold_metric_ref is not None:
                raise ValueError("event_trigger cannot carry price trigger fields")
        else:
            if self.status not in {"scheduled", "due"}:
                raise ValueError("scheduled_review has an invalid status")
            if self.observed_metric_ref is not None or self.operator is not None or self.threshold_metric_ref is not None:
                raise ValueError("scheduled_review cannot carry price trigger fields")
        return self


class V5TradingPlan(Payload):
    """Deterministically calculated price and trigger plan for one horizon."""

    reference_buy_low: float
    reference_buy_high: float
    pullback_buy_low: float
    pullback_buy_high: float
    stop_loss: float
    first_take_profit: float
    first_reduce_fraction: float
    second_take_profit: float
    second_reduce_fraction: float
    risk_reward_first: float
    risk_reward_second: float
    currency: Literal["CNY"]
    calculation_method: str = Field(min_length=1)
    calculation_version: str = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)
    market_as_of: str
    entry_conditions: list[V5TradingCondition] = Field(min_length=1)
    exit_conditions: list[V5TradingCondition] = Field(min_length=1)
    take_profit_conditions: list[V5TradingCondition] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_price_plan(self) -> "V5TradingPlan":
        prices = (
            "reference_buy_low",
            "reference_buy_high",
            "pullback_buy_low",
            "pullback_buy_high",
            "stop_loss",
            "first_take_profit",
            "second_take_profit",
        )
        for field_name in prices:
            _v5_price(getattr(self, field_name), field_name)
        _v5_datetime(self.market_as_of, "market_as_of")
        if self.reference_buy_low > self.reference_buy_high:
            raise ValueError("reference buy interval is reversed")
        if self.pullback_buy_low > self.pullback_buy_high:
            raise ValueError("pullback buy interval is reversed")
        entry = (self.reference_buy_low + self.reference_buy_high) / 2
        if self.stop_loss >= entry:
            raise ValueError("stop_loss must be below the reference buy midpoint")
        if self.first_take_profit <= entry or self.second_take_profit <= self.first_take_profit:
            raise ValueError("take-profit prices must increase above the reference buy midpoint")
        for field_name in ("first_reduce_fraction", "second_reduce_fraction"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or not 0 < value <= 1:
                raise ValueError(f"{field_name} must be between 0 and 1")
        if self.first_reduce_fraction + self.second_reduce_fraction > 1 + 1e-8:
            raise ValueError("reduce fractions cannot exceed the full position")
        denominator = entry - self.stop_loss
        expected_first = (self.first_take_profit - entry) / denominator
        expected_second = (self.second_take_profit - entry) / denominator
        for field_name, expected in (
            ("risk_reward_first", expected_first),
            ("risk_reward_second", expected_second),
        ):
            actual = getattr(self, field_name)
            if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not isfinite(actual) or actual <= 0:
                raise ValueError(f"{field_name} must be a positive finite number")
            if abs(float(actual) - expected) > 1e-6:
                raise ValueError(f"{field_name} must match the deterministic price-plan formula")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V5 trading plan source_ids must not contain blanks")
        all_conditions = self.entry_conditions + self.exit_conditions + self.take_profit_conditions
        condition_keys = [
            (
                condition.kind,
                condition.observed_metric_ref,
                condition.operator,
                condition.threshold_metric_ref,
            )
            for condition in all_conditions
        ]
        if len(condition_keys) != len(set(condition_keys)):
            raise ValueError("V5 trading plan conditions must not be duplicated")
        return self


class V5PositionPlan(Payload):
    """Deterministic percentage position sizing; no account amount or shares."""

    risk_budget_pct: float
    initial_position_pct: float
    max_position_pct: float
    stop_distance_pct: float
    volatility_adjustment: float
    liquidity_cap_pct: float
    calculation_method: Literal["fixed_fractional_risk"]
    calculation_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_position_math(self) -> "V5PositionPlan":
        names = (
            "risk_budget_pct",
            "initial_position_pct",
            "max_position_pct",
            "stop_distance_pct",
            "volatility_adjustment",
            "liquidity_cap_pct",
        )
        for name in names:
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value < 0 or value > 100:
                raise ValueError(f"{name} must be a finite percentage from 0 to 100")
        if self.risk_budget_pct <= 0 or self.stop_distance_pct <= 0:
            raise ValueError("risk_budget_pct and stop_distance_pct must be positive")
        if self.initial_position_pct <= 0 or self.max_position_pct <= 0:
            raise ValueError("initial_position_pct and max_position_pct must be positive")
        if self.liquidity_cap_pct <= 0:
            raise ValueError("liquidity_cap_pct must be positive")
        if self.volatility_adjustment <= 0 or self.volatility_adjustment > 1:
            raise ValueError("volatility_adjustment must be a factor from 0 to 1")
        if self.initial_position_pct > self.max_position_pct:
            raise ValueError("initial_position_pct cannot exceed max_position_pct")
        theoretical = self.risk_budget_pct / self.stop_distance_pct * 100
        maximum = min(theoretical * self.volatility_adjustment, self.liquidity_cap_pct)
        if self.max_position_pct > maximum + 1e-8:
            raise ValueError("max_position_pct exceeds volatility or liquidity limit")
        return self


# V6 execution/risk contracts are additive.  Historical V5 payloads remain
# readable; only the new deterministic materializer emits these models.
V6Board = Literal["main", "chinext", "star", "bse", "unknown"]
V6Exchange = Literal["XSHG", "XSHE", "BJSE"]
V6RiskLevel = Literal["conservative", "balanced", "aggressive"]
V6FundsRange = Literal["under_100k", "100k_500k", "500k_2m", "over_2m"]
V6Direction = Literal["positive", "neutral", "negative", "avoid"]
V6PositionInputMode = Literal["percentage", "assets_shares"]
V6HoldingState = Literal["not_holding", "holding"]
V6ExecutionStatus = Literal["proxy", "limited", "blocked"]
V6RuleStatus = Literal["confirmed", "limited"]
V6LiquidityStatus = Literal["proxy", "limited"]
V6OrderStatus = Literal["proxy", "limited", "blocked", "not_applicable"]
V6TPlusOneStatus = Literal["allowed", "restricted", "not_applicable", "unknown"]
V6CurrentAction = Literal[
    "participate", "wait", "hold", "reduce", "exit", "avoid", "execution_blocked"
]
V6PlanType = Literal["alpha_calibrated", "rule_reference"]
V6AlphaCalibrationStatus = Literal["calibrated", "research_only"]


def _v6_optional_price(value: float | None, field_name: str) -> None:
    if value is None:
        return
    _v5_price(value, field_name)


class V6ExecutionFacts(Payload):
    """Observable A-share execution inputs; no order-book data is implied."""

    board: V6Board = "unknown"
    exchange: V6Exchange | None = None
    risk_warning: bool | None = None
    registration_listing: bool | None = None
    suspended: bool | None = None
    delisted: bool | None = None
    delisting: bool | None = None
    listing_days: int | None = Field(default=None, ge=1)
    listing_age_lower_bound_sessions: int | None = Field(default=None, ge=1)
    listing_days_is_lower_bound: bool = False
    status_methods: dict[str, str] = Field(default_factory=dict)
    price: float | None = None
    previous_close: float | None = None
    amount_yuan: float | None = Field(default=None, ge=0)
    turnover_rate_pct: float | None = Field(default=None, ge=0, le=100)
    atr20_pct: float | None = Field(default=None, ge=0)
    has_order_book: bool = False
    observed_at: str
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_facts(self) -> "V6ExecutionFacts":
        _v5_datetime(self.observed_at, "observed_at")
        _v6_optional_price(self.price, "price")
        _v6_optional_price(self.previous_close, "previous_close")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V6 execution source_ids must not contain blanks")
        return self


class V6RiskProfile(Payload):
    """Local risk budget; never represents a broker/account connection."""

    profile_name: str = "conservative_default"
    configured: bool = False
    risk_level: V6RiskLevel = "conservative"
    max_drawdown_tolerance_pct: float = Field(default=10.0, gt=0, le=60)
    total_funds_range: V6FundsRange | None = None
    risk_budget_pct: float = Field(default=1.0, gt=0, le=100)
    max_single_position_pct: float = Field(default=20.0, gt=0, le=100)
    max_industry_exposure_pct: float = Field(default=30.0, gt=0, le=100)
    max_correlated_exposure_pct: float = Field(default=50.0, gt=0, le=100)

    @classmethod
    def conservative_default(cls) -> "V6RiskProfile":
        return cls()

    @model_validator(mode="after")
    def _validate_risk_contract(self) -> "V6RiskProfile":
        level_limits = {
            "conservative": 20.0,
            "balanced": 40.0,
            "aggressive": 60.0,
        }
        if self.max_drawdown_tolerance_pct > level_limits[self.risk_level]:
            raise ValueError("max_drawdown_tolerance_pct exceeds risk_level limit")
        if self.risk_budget_pct > self.max_drawdown_tolerance_pct:
            raise ValueError("risk_budget_pct cannot exceed max_drawdown_tolerance_pct")
        return self


class V6PortfolioContext(Payload):
    """Optional local portfolio context supplied by the user, not a broker."""

    # ``holding_state`` remains readable for old reports/files; the local store
    # derives it from ``current_position_pct`` when saving user input.
    holding_state: V6HoldingState = "not_holding"
    position_input_mode: V6PositionInputMode = "percentage"
    portfolio_value_yuan: float | None = Field(default=None, gt=0)
    current_position_pct: float = Field(default=0.0, ge=0, le=100)
    holding_quantity: StrictInt | None = Field(default=None, ge=0)
    industry_exposure_pct: float = Field(default=0.0, ge=0, le=100)
    correlated_exposure_pct: float = Field(default=0.0, ge=0, le=100)
    today_bought_quantity: int | None = Field(default=None, ge=0)
    holding_cost: float | None = None

    @model_validator(mode="after")
    def _validate_context(self) -> "V6PortfolioContext":
        _v6_optional_price(self.holding_cost, "holding_cost")
        return self


class V6CostAssumptions(Payload):
    """Versioned conservative cost assumptions for post-cost risk/reward."""

    commission_pct: float = Field(default=0.03, ge=0, le=100)
    stamp_tax_pct: float = Field(default=0.05, ge=0, le=100)
    transfer_fee_pct: float = Field(default=0.001, ge=0, le=100)
    method_version: str = "a-share-cost-assumptions-v1"


class V6ExecutionAssessment(Payload):
    """Rule and proxy result; status never claims an immediate fill."""

    execution_status: V6ExecutionStatus
    rules_status: V6RuleStatus
    liquidity_status: V6LiquidityStatus
    board: V6Board
    exchange: V6Exchange | None = None
    risk_warning: bool | None
    price_limit_pct: float | None = None
    upper_limit_price: float | None = None
    lower_limit_price: float | None = None
    buy_status: V6OrderStatus
    sell_status: V6OrderStatus
    t_plus_one_status: V6TPlusOneStatus
    min_order_quantity: int = Field(ge=1)
    order_quantity_increment: int = Field(ge=1)
    immediate_execution_allowed: Literal[False] = False
    execution_mode: Literal["research_only"] = "research_only"
    estimated_slippage_pct: float | None = None
    capacity_notional_yuan: float | None = None
    method_version: str = "a-share-execution-constraints-v1"
    rule_version: str = "a-share-price-rules-2026-v1"
    quantity_rule_version: str = "a-share-order-size-rules-v1"
    slippage_method_version: str = "turnover-amount-atr-proxy-v1"
    warnings: list[str] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_assessment(self) -> "V6ExecutionAssessment":
        for name in (
            "price_limit_pct",
            "upper_limit_price",
            "lower_limit_price",
            "estimated_slippage_pct",
            "capacity_notional_yuan",
        ):
            value = getattr(self, name)
            if value is not None and (not isfinite(value) or value < 0):
                raise ValueError(f"{name} must be a finite non-negative number")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V6 execution source_ids must not contain blanks")
        if self.execution_status == "blocked" and all(
            status != "blocked" for status in (self.buy_status, self.sell_status)
        ):
            raise ValueError("blocked execution must block at least one order side")
        return self


class V6MaterializedTradingPlan(Payload):
    """Direction/holding-aware plan that can be consumed by a later API layer."""

    schema_version: Literal[6] = 6
    direction: V6Direction
    action: V5Action
    holding_state: V6HoldingState
    current_action: V6CurrentAction
    plan_status: V6ExecutionStatus
    plan_type: V6PlanType = "alpha_calibrated"
    alpha_calibration_status: V6AlphaCalibrationStatus = "calibrated"
    execution: V6ExecutionAssessment
    buy_low: float | None = None
    buy_high: float | None = None
    pullback_low: float | None = None
    pullback_high: float | None = None
    confirmation_price: float | None = None
    invalidation_price: float | None = None
    exit_price: float | None = None
    reentry_confirmation_price: float | None = None
    stop_loss: float | None = None
    first_take_profit: float | None = None
    second_take_profit: float | None = None
    initial_position_pct: float = Field(default=0, ge=0, le=100)
    max_position_pct: float = Field(default=0, ge=0, le=100)
    target_max_position_pct: float = Field(default=0, ge=0, le=100)
    additional_position_pct: float = Field(default=0, ge=0, le=100)
    liquidity_cap_pct: float | None = Field(default=None, ge=0, le=100)
    risk_budget_pct: float = Field(default=0, ge=0, le=100)
    risk_reward_first_after_cost: float | None = None
    risk_reward_second_after_cost: float | None = None
    risk_profile_name: str = "conservative_default"
    risk_profile_configured: bool = False
    position_cap_reasons: list[str] = Field(default_factory=list)
    calculation_method: str = "direction-aware-a-share-plan"
    calculation_version: str = "direction-aware-a-share-plan-v1"
    execution_mode: Literal["research_only"] = "research_only"
    cost_assumptions: dict[str, object] = Field(default_factory=dict)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_direction_shape(self) -> "V6MaterializedTradingPlan":
        for name in (
            "buy_low",
            "buy_high",
            "pullback_low",
            "pullback_high",
            "confirmation_price",
            "invalidation_price",
            "exit_price",
            "reentry_confirmation_price",
            "stop_loss",
            "first_take_profit",
            "second_take_profit",
        ):
            _v6_optional_price(getattr(self, name), name)
        if self.initial_position_pct > self.max_position_pct:
            raise ValueError("initial_position_pct cannot exceed max_position_pct")
        if abs(self.max_position_pct - self.target_max_position_pct) > 1e-8:
            raise ValueError("max_position_pct must equal target_max_position_pct")
        if self.initial_position_pct > self.additional_position_pct + 1e-8:
            raise ValueError("initial_position_pct cannot exceed additional_position_pct")
        if self.plan_type == "rule_reference" and self.max_position_pct > 10.0 + 1e-8:
            raise ValueError("rule_reference plan cannot exceed the conservative 10% position cap")
        if self.direction != "positive" and any(
            getattr(self, name) is not None
            for name in ("buy_low", "buy_high", "pullback_low", "pullback_high")
        ):
            raise ValueError("neutral, negative and avoid plans cannot carry buy ranges")
        if self.direction == "neutral" and (
            self.confirmation_price is None or self.invalidation_price is None
        ):
            raise ValueError("neutral plans require confirmation and invalidation prices")
        if self.direction == "neutral" and self.action == "reduce":
            if self.holding_state != "holding" or self.exit_price is None:
                raise ValueError("neutral reduce plans require a holding and exit boundary")
        if self.direction in {"negative", "avoid"} and self.holding_state == "not_holding":
            if self.exit_price is not None:
                raise ValueError("not-held negative or avoid plans cannot carry an exit price")
        if self.direction in {"negative", "avoid"} and self.reentry_confirmation_price is None:
            raise ValueError("negative and avoid plans require a re-entry confirmation price")
        return self


V6ResearchStatus = Literal["ready", "unavailable"]
V6TradeStatus = Literal["ready", "unavailable"]
V6DecisionMode = Literal["research_only", "reference_plan"]


class V6DisagreementMatrix(Payload):
    """Structured qualitative disagreement; no numeric or execution fields."""

    issue: str = Field(min_length=1)
    bull_basis: list[ViewPoint] = Field(default_factory=list)
    bear_basis: list[ViewPoint] = Field(default_factory=list)
    ruling: list[ViewPoint] = Field(default_factory=list)
    retained_risks: list[ViewPoint] = Field(default_factory=list)
    change_conditions: list[HorizonCondition] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in (
            *self.bull_basis,
            *self.bear_basis,
            *self.ruling,
            *self.retained_risks,
        ):
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for condition in self.change_conditions:
            for source_id in condition.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class V6HorizonDecisionSubmission(Payload):
    """Model-facing V6 qualitative decision; all deterministic fields are absent."""

    direction: V6Direction
    action: V5Action
    thesis: str = Field(min_length=1)
    not_holding_action: V5NotHoldingAction
    holding_action: V5HoldingAction
    key_reasons: list[ViewPoint] = Field(default_factory=list, max_length=3)
    key_risks: list[ViewPoint] = Field(default_factory=list, max_length=2)
    disagreement_matrix: V6DisagreementMatrix | None = None
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_action_alignment(self) -> "V6HorizonDecisionSubmission":
        if self.direction == "positive" and self.action in {"reduce", "exit", "avoid"}:
            raise ValueError("positive direction cannot reduce, exit or avoid")
        if self.direction == "negative" and self.action in {"conditional_participation", "hold"}:
            raise ValueError("negative direction cannot conditionally participate or hold")
        if self.direction == "avoid" and self.action not in {"avoid", "reduce", "exit"}:
            raise ValueError("avoid direction only allows avoid, reduce or exit")
        if self.direction == "positive" and self.not_holding_action == "avoid":
            raise ValueError("positive direction cannot avoid when not holding")
        if self.direction == "negative" and self.not_holding_action == "participate":
            raise ValueError("negative direction cannot participate when not holding")
        if self.direction == "negative" and self.holding_action == "hold":
            raise ValueError("negative direction cannot hold")
        if self.direction == "positive" and self.holding_action == "exit":
            raise ValueError("positive direction cannot exit")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V6 horizon source_ids must not contain blanks")
        if self.key_reasons:
            _v5_validate_claims(self.key_reasons, "key_reasons")
        if self.key_risks:
            _v5_validate_claims(self.key_risks, "key_risks")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.key_reasons + self.key_risks:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        if self.disagreement_matrix is not None:
            for source_id in self.disagreement_matrix.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class V6HorizonDecisionsSubmission(Payload):
    short_term: V6HorizonDecisionSubmission | None = None
    medium_term: V6HorizonDecisionSubmission | None = None
    long_term: V6HorizonDecisionSubmission | None = None

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for horizon in (self.short_term, self.medium_term, self.long_term):
            if horizon is None:
                continue
            for source_id in horizon.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class V6HorizonDecision(Payload):
    """One persisted V6 decision after system gate/plan materialization."""

    direction: V6Direction
    action: V5Action
    thesis: str = Field(min_length=1)
    not_holding_action: V5NotHoldingAction
    holding_action: V5HoldingAction
    key_reasons: list[ViewPoint] = Field(min_length=1, max_length=3)
    key_risks: list[ViewPoint] = Field(min_length=1, max_length=2)
    disagreement_matrix: V6DisagreementMatrix | None = None
    research_status: V6ResearchStatus
    trade_status: V6TradeStatus
    materialized_plan: V6MaterializedTradingPlan | None = None
    valid_until: str | None = None
    review_trigger: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_decision(self) -> "V6HorizonDecision":
        if self.research_status == "unavailable":
            if self.action not in {"wait", "reduce", "exit", "avoid"}:
                raise ValueError("unavailable research must use wait, reduce, exit or avoid")
            if self.materialized_plan is not None:
                raise ValueError("unavailable research cannot carry a materialized plan")
        if self.trade_status != "ready" and self.materialized_plan is not None:
            raise ValueError("non-trade-ready horizon cannot carry a materialized plan")
        if self.valid_until is not None:
            _v5_datetime(self.valid_until, "valid_until")
        if self.materialized_plan is not None:
            if self.materialized_plan.direction != self.direction:
                raise ValueError("materialized plan direction must match decision direction")
            if self.materialized_plan.action != self.action:
                raise ValueError("materialized plan action must match decision action")
            if self.valid_until is None:
                raise ValueError("materialized V6 plan requires valid_until")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V6 horizon source_ids must not contain blanks")
        if self.research_status == "ready":
            _v5_validate_claims(self.key_reasons, "key_reasons")
            _v5_validate_claims(self.key_risks, "key_risks")
        elif any(
            point.claim_type != "hypothesis"
            for point in self.key_reasons + self.key_risks
        ):
            raise ValueError("unavailable V6 research may only use system hypotheses")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        for point in self.key_reasons + self.key_risks:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        if self.disagreement_matrix is not None:
            for source_id in self.disagreement_matrix.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        if self.materialized_plan is not None:
            for source_id in self.materialized_plan.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
            ids.extend(
                source_id
                for source_id in self.materialized_plan.execution.source_ids
                if source_id not in ids
            )
        return list(dict.fromkeys(ids))


class V6HorizonDecisions(Payload):
    short_term: V6HorizonDecision
    medium_term: V6HorizonDecision
    long_term: V6HorizonDecision

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for decision in (self.short_term, self.medium_term, self.long_term):
            for source_id in decision.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class DecisionReportV6(Payload):
    """Strict V6 report; a research result may exist without trade plans."""

    schema_version: Literal[6]
    kind: Literal["deep_research"]
    result_status: Literal["completed"]
    report_id: str = Field(min_length=1)
    workflow_run_id: str = Field(min_length=1)
    instrument: InstrumentTag
    research_cutoff_at: str
    market_as_of: str
    generated_at: str
    current_price: float | None = None
    benchmark_price: float | None = None
    price_source_ids: list[str] = Field(default_factory=list)
    summary: str = Field(min_length=1)
    decision_mode: V6DecisionMode
    research_status: V6ResearchStatus
    trade_status: V6TradeStatus
    horizon_decisions: V6HorizonDecisions
    research_ready: dict[str, object] = Field(default_factory=dict)
    trade_ready: dict[str, object] = Field(default_factory=dict)
    # The deterministic factor observations are separate from the promotion
    # gate.  Keeping the full payload here lets the report explain what was
    # measured even when the model is not yet eligible for trading.
    quant_validation: dict[str, object] | None = None
    quant_promotion: dict[str, object] = Field(default_factory=dict)
    valuation: dict[str, object] = Field(default_factory=dict)
    # These two deterministic sections are copied from the immutable Evidence
    # bundle.  They are never accepted from an Agent submission.
    market_sentiment: dict[str, object] = Field(default_factory=dict)
    public_opinion: dict[str, object] = Field(default_factory=dict)
    execution_qualification: dict[str, object] = Field(default_factory=dict)
    risk_profile_configured: bool = False
    risk_level: V6RiskLevel = "conservative"
    holding_state: V6HoldingState = "not_holding"
    method_versions: dict[str, str]
    source_ids: list[str] = Field(default_factory=list)
    sources: list[dict[str, object]] = Field(default_factory=list)
    disclaimer: Literal[DISCLAIMER]

    @model_validator(mode="after")
    def _validate_report(self) -> "DecisionReportV6":
        cutoff = _v5_datetime(self.research_cutoff_at, "research_cutoff_at")
        market = _v5_datetime(self.market_as_of, "market_as_of")
        generated = _v5_datetime(self.generated_at, "generated_at")
        if market > cutoff or cutoff > generated:
            raise ValueError("V6 report timestamps are out of order")
        _v6_optional_price(self.current_price, "current_price")
        _v6_optional_price(self.benchmark_price, "benchmark_price")
        if any(not source_id.strip() for source_id in self.price_source_ids):
            raise ValueError("V6 price_source_ids must not contain blanks")
        decisions = (
            self.horizon_decisions.short_term,
            self.horizon_decisions.medium_term,
            self.horizon_decisions.long_term,
        )
        if not any(item.research_status == "ready" for item in decisions):
            raise ValueError("V6 report requires at least one research-ready horizon")
        for horizon, item in zip(
            ("short_term", "medium_term", "long_term"), decisions
        ):
            if item.valid_until is not None and _v5_datetime(item.valid_until, f"{horizon}.valid_until") <= generated:
                raise ValueError(f"{horizon}.valid_until must be later than generated_at")
        if self.decision_mode == "reference_plan" and not any(
            item.materialized_plan is not None for item in decisions
        ):
            raise ValueError("reference_plan requires at least one materialized plan")
        if self.decision_mode == "research_only" and any(
            item.materialized_plan is not None for item in decisions
        ):
            raise ValueError("research_only cannot carry materialized plans")
        if self.trade_status == "unavailable" and any(
            phrase in self.summary.lower()
            for phrase in ("交易可用", "交易已可用", "可直接交易")
        ):
            raise ValueError("summary cannot claim trading is available when trade_status is unavailable")
        if not any(
            item.action in {"conditional_participation", "reduce", "exit", "avoid"}
            or (
                item.materialized_plan is not None
                and any(
                    getattr(item.materialized_plan, field) is not None
                    for field in (
                        "buy_low",
                        "buy_high",
                        "confirmation_price",
                        "invalidation_price",
                        "exit_price",
                        "reentry_confirmation_price",
                        "stop_loss",
                        "first_take_profit",
                        "second_take_profit",
                    )
                )
            )
            for item in decisions
        ):
            raise ValueError("V6 report requires at least one user action or executable boundary")
        if any(
            item.materialized_plan is not None and item.trade_status != "ready"
            for item in decisions
        ):
            raise ValueError("materialized plan requires trade_status=ready")
        required_sources = set(self.horizon_decisions.all_source_ids())

        def nested_source_ids(value: object):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key == "source_ids" and isinstance(child, list):
                        yield from (item for item in child if isinstance(item, str))
                    else:
                        yield from nested_source_ids(child)
            elif isinstance(value, list):
                for child in value:
                    yield from nested_source_ids(child)

        for section in (
            self.quant_validation,
            self.valuation,
            self.market_sentiment,
            self.public_opinion,
            self.execution_qualification,
        ):
            required_sources.update(nested_source_ids(section))
        required_sources.update(self.price_source_ids)
        if not required_sources <= set(self.source_ids):
            raise ValueError("V6 report source_ids must include all cited horizon sources")
        source_record_ids = {
            source.get("id")
            for source in self.sources
            if isinstance(source, dict) and isinstance(source.get("id"), str)
        }
        if not set(self.source_ids) <= source_record_ids:
            raise ValueError("V6 report sources must close every source_id")
        if not self.method_versions or any(
            not isinstance(value, str) or not value.strip()
            for value in self.method_versions.values()
        ):
            raise ValueError("V6 method_versions must be non-empty")
        return self


# Public V6 aliases for callers using the shorter product vocabulary.
HorizonDecisionV6Submission = V6HorizonDecisionSubmission
HorizonDecisionsV6Submission = V6HorizonDecisionsSubmission
HorizonDecisionV6 = V6HorizonDecision
HorizonDecisionsV6 = V6HorizonDecisions


class V5HorizonDecisionSubmission(Payload):
    """Only qualitative fields the referee may submit; deterministic fields are absent."""

    direction: V5Direction
    action: V5Action
    thesis: str = Field(min_length=1)
    not_holding_action: V5NotHoldingAction
    holding_action: V5HoldingAction
    key_reasons: list[ViewPoint] = Field(min_length=1, max_length=3)
    key_risks: list[ViewPoint] = Field(min_length=1, max_length=2)
    source_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_action_alignment(self) -> "V5HorizonDecisionSubmission":
        if self.direction == "positive" and self.action in {"reduce", "exit", "avoid"}:
            raise ValueError("positive direction cannot reduce, exit or avoid")
        if self.direction == "negative" and self.action in {"conditional_participation", "hold"}:
            raise ValueError("negative direction cannot conditionally participate or hold")
        if self.direction == "positive" and self.not_holding_action == "avoid":
            raise ValueError("positive direction cannot avoid when not holding")
        if self.direction == "negative" and self.not_holding_action == "participate":
            raise ValueError("negative direction cannot participate when not holding")
        if self.direction == "negative" and self.holding_action == "hold":
            raise ValueError("negative direction cannot hold")
        if self.direction == "positive" and self.holding_action == "exit":
            raise ValueError("positive direction cannot exit")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V5 horizon source_ids must not contain blanks")
        _v5_validate_claims(self.key_reasons, "key_reasons")
        _v5_validate_claims(self.key_risks, "key_risks")
        return self


class V5HorizonDecisionsSubmission(Payload):
    short_term: V5HorizonDecisionSubmission
    medium_term: V5HorizonDecisionSubmission
    long_term: V5HorizonDecisionSubmission

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for decision in (self.short_term, self.medium_term, self.long_term):
            for source_id in decision.source_ids + [
                source_id
                for point in decision.key_reasons + decision.key_risks
                for source_id in point.source_ids
            ]:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class V5HorizonDecision(Payload):
    """Complete persisted V5 decision after deterministic injection."""

    direction: V5Direction
    action: V5Action
    thesis: str = Field(min_length=1)
    not_holding_action: V5NotHoldingAction
    holding_action: V5HoldingAction
    trading_plan: V5TradingPlan
    position_plan: V5PositionPlan
    valid_until: str
    review_trigger: str = Field(min_length=1)
    key_reasons: list[ViewPoint] = Field(min_length=1, max_length=3)
    key_risks: list[ViewPoint] = Field(min_length=1, max_length=2)
    evidence_strength: V5EvidenceStrength
    source_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_complete_decision(self) -> "V5HorizonDecision":
        _v5_datetime(self.valid_until, "valid_until")
        if any(term in self.thesis or term in self.review_trigger for term in V5_FORBIDDEN_TERMS):
            raise ValueError("V5 decision contains a forbidden missing-state placeholder")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V5 horizon source_ids must not contain blanks")
        if self.direction == "positive" and self.action in {"reduce", "exit", "avoid"}:
            raise ValueError("positive direction cannot reduce, exit or avoid")
        if self.direction == "negative" and self.action in {"conditional_participation", "hold"}:
            raise ValueError("negative direction cannot conditionally participate or hold")
        if self.direction == "positive" and self.not_holding_action == "avoid":
            raise ValueError("positive direction cannot avoid when not holding")
        if self.direction == "negative" and self.not_holding_action == "participate":
            raise ValueError("negative direction cannot participate when not holding")
        if self.direction == "negative" and self.holding_action == "hold":
            raise ValueError("negative direction cannot hold")
        if self.direction == "positive" and self.holding_action == "exit":
            raise ValueError("positive direction cannot exit")
        _v5_validate_claims(self.key_reasons, "key_reasons")
        _v5_validate_claims(self.key_risks, "key_risks")
        return self

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids + self.trading_plan.source_ids))
        for condition in (
            *self.trading_plan.entry_conditions,
            *self.trading_plan.exit_conditions,
            *self.trading_plan.take_profit_conditions,
        ):
            for source_id in condition.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for point in self.key_reasons + self.key_risks:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class V5HorizonDecisions(Payload):
    short_term: V5HorizonDecision
    medium_term: V5HorizonDecision
    long_term: V5HorizonDecision

    def all_source_ids(self) -> list[str]:
        ids: list[str] = []
        for decision in (self.short_term, self.medium_term, self.long_term):
            for source_id in decision.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
        return ids


class DecisionReportV5(Payload):
    """Complete, user-facing deep-research decision report."""

    schema_version: Literal[5]
    kind: Literal["deep_research"]
    result_status: Literal["completed"]
    report_id: str = Field(min_length=1)
    workflow_run_id: str = Field(min_length=1)
    instrument: InstrumentTag
    research_cutoff_at: str
    market_as_of: str
    generated_at: str
    summary: str = Field(min_length=1)
    horizon_decisions: V5HorizonDecisions
    source_ids: list[str] = Field(min_length=1)
    method_versions: dict[str, str]
    disclaimer: Literal[DISCLAIMER]

    @model_validator(mode="after")
    def _validate_report_contract(self) -> "DecisionReportV5":
        market_as_of = _v5_datetime(self.market_as_of, "market_as_of")
        research_cutoff_at = _v5_datetime(self.research_cutoff_at, "research_cutoff_at")
        generated_at = _v5_datetime(self.generated_at, "generated_at")
        if market_as_of > research_cutoff_at:
            raise ValueError("market_as_of must not be later than research_cutoff_at")
        if research_cutoff_at > generated_at:
            raise ValueError("research_cutoff_at must not be later than generated_at")
        for horizon in ("short_term", "medium_term", "long_term"):
            valid_until = _v5_datetime(
                getattr(self.horizon_decisions, horizon).valid_until,
                f"horizon_decisions.{horizon}.valid_until",
            )
            if valid_until <= generated_at:
                raise ValueError(
                    f"horizon_decisions.{horizon}.valid_until must be later than generated_at"
                )
        if not self.method_versions or any(
            key not in self.method_versions or not isinstance(value, str) or not value.strip()
            for key in ("decision", "indicators", "conditions")
            for value in (self.method_versions.get(key),)
        ):
            raise ValueError("V5 method_versions must include decision, indicators and conditions")
        if any(not source_id.strip() for source_id in self.source_ids):
            raise ValueError("V5 report source_ids must not contain blanks")
        required_sources = set(self.horizon_decisions.all_source_ids())
        if not required_sources <= set(self.source_ids):
            raise ValueError("V5 report source_ids must include all cited horizon sources")
        serialized = self.model_dump(mode="json")
        text_values: list[str] = []
        def collect(value: object) -> None:
            if isinstance(value, str):
                text_values.append(value)
            elif isinstance(value, dict):
                for item in value.values():
                    collect(item)
            elif isinstance(value, list):
                for item in value:
                    collect(item)
        collect(serialized)
        if any(term in value for value in text_values for term in V5_FORBIDDEN_TERMS):
            raise ValueError("V5 report contains a forbidden missing-state placeholder")
        return self


class DecisionReportV5Submission(Payload):
    """Model-facing V5 input; numeric/deterministic fields are intentionally absent."""

    schema_version: Literal[5]
    summary: str = Field(min_length=1)
    instrument: InstrumentTag
    horizon_decisions: V5HorizonDecisionsSubmission

    def all_source_ids(self) -> list[str]:
        return self.horizon_decisions.all_source_ids()


# Public names follow the plan's ``*V5`` terminology; the prefixed classes
# keep the model-facing and persisted contracts visually distinct above.
TradingConditionV5 = V5TradingCondition
TradingPlanV5 = V5TradingPlan
PositionPlanV5 = V5PositionPlan
HorizonDecisionV5Submission = V5HorizonDecisionSubmission
HorizonDecisionsV5Submission = V5HorizonDecisionsSubmission
HorizonDecisionV5 = V5HorizonDecision
HorizonDecisionsV5 = V5HorizonDecisions

# Short public aliases for the V6 execution layer.
ExecutionFacts = V6ExecutionFacts
RiskProfile = V6RiskProfile
PortfolioContext = V6PortfolioContext
ExecutionAssessment = V6ExecutionAssessment
MaterializedTradingPlan = V6MaterializedTradingPlan


class ReportSubmission(Payload):
    """Payload for ``submit_stock_report``.

    A single-instrument payload is Report V4. The daily-review ``items``
    variant remains schema V3. Trusted evidence timestamps, coverage and
    outcome tracking are injected by the submit tool, never accepted here.
    """

    as_of: str | None = None
    schema_version: Literal[5, 6] | None = None
    summary: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    instrument: InstrumentTag | None = None
    horizon_decisions: V5HorizonDecisionsSubmission | V6HorizonDecisionsSubmission | None = None
    horizon_decisions_v6: V6HorizonDecisionsSubmission | None = None
    versions: dict[str, str] = Field(default_factory=dict)
    horizon_views: HorizonViews | None = None
    dimension_views: DimensionViews | None = None
    debate_resolution: DebateResolutions | None = None
    cycle_states: CycleStates | None = None
    market_regime_summary: SummarySection | None = None
    industry_policy_summary: SummarySection | None = None
    scenario_sets: ScenarioSets | None = None
    cross_horizon_conflict: CrossHorizonConflict | None = None
    risks: list[ViewPoint] = Field(default_factory=list)
    catalysts: list[ViewPoint] = Field(default_factory=list)
    open_questions: list[ViewPoint] = Field(default_factory=list)
    items: list[DigestItem] | None = None

    @model_validator(mode="after")
    def _check_mode(self) -> "ReportSubmission":
        if self.schema_version == 6 or self.horizon_decisions_v6 is not None:
            if self.schema_version != 6:
                raise ValueError("V6 deep-research mode requires schema_version=6")
            if self.items is not None:
                raise ValueError("V6 deep-research mode cannot carry daily digest items")
            if self.instrument is None:
                raise ValueError("V6 deep-research mode requires instrument")
            if self.horizon_decisions is None and self.horizon_decisions_v6 is None:
                raise ValueError("V6 deep-research mode requires horizon decisions")
            legacy_fields = {
                "as_of",
                "versions",
                "horizon_views",
                "dimension_views",
                "debate_resolution",
                "cycle_states",
                "market_regime_summary",
                "industry_policy_summary",
                "scenario_sets",
                "cross_horizon_conflict",
                "risks",
                "catalysts",
                "open_questions",
            }
            provided = legacy_fields.intersection(self.model_fields_set)
            if provided:
                raise ValueError(
                    "V6 deep-research mode cannot carry V4 fields: "
                    + ", ".join(sorted(provided))
                )
            return self
        if self.schema_version == 5 or self.horizon_decisions is not None:
            if self.schema_version != 5 or self.horizon_decisions is None:
                raise ValueError("V5 deep-research mode requires schema_version=5 and horizon_decisions")
            if self.items is not None:
                raise ValueError("V5 deep-research mode cannot carry daily digest items")
            if self.instrument is None:
                raise ValueError("V5 deep-research mode requires instrument")
            legacy_fields = {
                "as_of",
                "versions",
                "horizon_views",
                "dimension_views",
                "debate_resolution",
                "cycle_states",
                "market_regime_summary",
                "industry_policy_summary",
                "scenario_sets",
                "cross_horizon_conflict",
                "risks",
                "catalysts",
                "open_questions",
            }
            provided = legacy_fields.intersection(self.model_fields_set)
            if provided:
                raise ValueError(
                    "V5 deep-research mode cannot carry V4 fields: "
                    + ", ".join(sorted(provided))
                )
            return self
        if self.items is not None:
            if not self.items:
                raise ValueError("items must be a non-empty list in digest mode")
            if self.as_of is None:
                raise ValueError("digest mode requires as_of")
            single_fields = {
                "instrument",
                "versions",
                "horizon_views",
                "dimension_views",
                "debate_resolution",
                "cycle_states",
                "market_regime_summary",
                "industry_policy_summary",
                "scenario_sets",
                "cross_horizon_conflict",
                "risks",
                "catalysts",
                "open_questions",
            }
            provided = single_fields.intersection(self.model_fields_set)
            if provided:
                raise ValueError(
                    "digest mode cannot carry single-instrument fields: "
                    + ", ".join(sorted(provided))
                )
        else:
            if self.as_of is not None:
                raise ValueError("V4 deep-research mode does not accept as_of")
            required = (
                self.instrument,
                self.horizon_views,
                self.dimension_views,
                self.debate_resolution,
                self.cycle_states,
                self.market_regime_summary,
                self.industry_policy_summary,
                self.scenario_sets,
                self.cross_horizon_conflict,
            )
            if any(value is None for value in required):
                raise ValueError(
                    "deep-research V4 requires instrument, horizon_views, "
                    "dimension_views, debate_resolution, cycle_states, market_regime_summary, "
                    "industry_policy_summary, scenario_sets and cross_horizon_conflict"
                )
        return self

    @property
    def is_digest(self) -> bool:
        return self.items is not None

    @property
    def is_v5(self) -> bool:
        return self.schema_version == 5 and self.horizon_decisions is not None

    @property
    def is_v6(self) -> bool:
        return self.schema_version == 6 and (
            self.horizon_decisions is not None or self.horizon_decisions_v6 is not None
        )

    @property
    def v6_horizon_decisions(self) -> V6HorizonDecisionsSubmission | None:
        if self.horizon_decisions_v6 is not None:
            return self.horizon_decisions_v6
        if isinstance(self.horizon_decisions, V6HorizonDecisionsSubmission):
            return self.horizon_decisions
        if self.horizon_decisions is None:
            return None
        return V6HorizonDecisionsSubmission.model_validate(
            self.horizon_decisions.model_dump(mode="json")
        )

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
        if self.is_v5:
            for source_id in self.horizon_decisions.all_source_ids():
                if source_id not in ids:
                    ids.append(source_id)
            return ids
        if self.is_v6:
            decisions = self.v6_horizon_decisions
            if decisions is not None:
                for source_id in decisions.all_source_ids():
                    if source_id not in ids:
                        ids.append(source_id)
            return ids
        if self.items is not None:
            return ids
        for value in (
            self.horizon_views,
            self.dimension_views,
            self.debate_resolution,
            self.cycle_states,
            self.market_regime_summary,
            self.industry_policy_summary,
            self.scenario_sets,
        ):
            if value is not None:
                for source_id in value.all_source_ids():
                    if source_id not in ids:
                        ids.append(source_id)
        if self.cross_horizon_conflict is not None:
            for source_id in self.cross_horizon_conflict.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        for point in self.risks + self.catalysts + self.open_questions:
            for source_id in point.source_ids:
                if source_id not in ids:
                    ids.append(source_id)
        return ids


# ---------------------------------------------------------------------------
# Standard AI diagnosis (schema v1)
# ---------------------------------------------------------------------------
#
# The models below intentionally live beside the deep-research submission
# models, but are not subclasses/aliases of them.  ``deep_research`` remains
# the six-agent V4/V5/V6 contract; a standard diagnosis is a separate,
# deterministic report kind.  In particular, the semantic-agent submission
# does not expose any field through which a model can smuggle prices,
# positions, technical indicators or quantitative scores.

DiagnosisDirection = Literal["positive", "neutral", "negative", "unavailable"]
DiagnosisAction = Literal[
    "conditional_participation",
    "wait",
    "hold",
    "reduce",
    "exit",
    "avoid",
]
DiagnosisCurrentAction = Literal["wait", "participate", "hold", "reduce", "exit", "avoid"]
DiagnosisValidationStatus = Literal[
    "descriptive", "calibrated", "rejected", "unavailable"
]
DiagnosisAvailability = Literal["available", "degraded", "unavailable"]
DiagnosisHoldingState = Literal["not_holding", "holding"]


class DiagnosisClaim(Payload):
    """A source-backed semantic claim returned by the one allowed Agent."""

    text: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    claim_type: Literal["fact", "inference", "hypothesis"] = "inference"

    @model_validator(mode="after")
    def _source_for_claim(self) -> "DiagnosisClaim":
        if self.claim_type in {"fact", "inference"} and not self.source_ids:
            raise ValueError("fact and inference diagnosis claims require source_ids")
        return self


class DiagnosisSemanticSubmission(Payload):
    """Single-Agent submission contract for company/industry semantics.

    This is deliberately narrower than :class:`StockDiagnosisV1`.  Trusted
    identity and run fields are injected by the service, and all numeric
    trading fields are absent by design.  ``extra=forbid`` is inherited from
    :class:`Payload`, so ``price``, ``position``, ``quant_factors`` and other
    internal fields are rejected rather than silently ignored.
    """

    schema_version: Literal[1] = 1
    # These are optional on the model-facing payload: the trusted service may
    # inject them from the current run/Evidence context.  If supplied, the
    # service checks them against that context before persistence.
    instrument: InstrumentTag | None = None
    evidence_context_id: str | None = Field(default=None, min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    business_understandable: bool | None = None
    company_understanding: str | None = None
    business_model: str | None = None
    business_model_summary: str | None = None
    revenue_sources: list[str] = Field(default_factory=list)
    competitive_advantages: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_advantage: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_counterevidence: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_advantage_counterevidence: list[DiagnosisClaim] = Field(default_factory=list)
    management_governance: list[DiagnosisClaim] = Field(default_factory=list)
    governance: list[DiagnosisClaim] = Field(default_factory=list)
    industry_supply_demand: list[DiagnosisClaim] = Field(default_factory=list)
    industry_context: list[DiagnosisClaim] = Field(default_factory=list)
    policy_transmission: list[DiagnosisClaim] = Field(default_factory=list)
    policy_context: list[DiagnosisClaim] = Field(default_factory=list)
    cycle_position: list[DiagnosisClaim] = Field(default_factory=list)
    cycle_context: list[DiagnosisClaim] = Field(default_factory=list)
    key_assumptions: list[DiagnosisClaim] = Field(default_factory=list)
    risks: list[DiagnosisClaim] = Field(default_factory=list)
    conclusion_change_conditions: list[DiagnosisClaim] = Field(default_factory=list)
    change_conditions: list[DiagnosisClaim] = Field(default_factory=list)

    @model_validator(mode="after")
    def _claims_in_source_closure(self) -> "DiagnosisSemanticSubmission":
        source_ids = set(self.source_ids)
        for field_name in (
            "competitive_advantages",
            "competitive_advantage",
            "competitive_counterevidence",
            "competitive_advantage_counterevidence",
            "management_governance",
            "governance",
            "industry_supply_demand",
            "industry_context",
            "policy_transmission",
            "policy_context",
            "cycle_position",
            "cycle_context",
            "key_assumptions",
            "risks",
            "conclusion_change_conditions",
            "change_conditions",
        ):
            for claim in getattr(self, field_name):
                if not set(claim.source_ids) <= source_ids:
                    raise ValueError(
                        f"{field_name} source_ids must be included in source_ids"
                    )
        return self


# Descriptive aliases used by integrations which refer to the Agent as a
# semantic researcher rather than a submitter.  They are aliases, not a
# second contract.
StockDiagnosisAgentSubmission = DiagnosisSemanticSubmission
StockDiagnosisSemanticSubmission = DiagnosisSemanticSubmission
StandardDiagnosisSemanticSubmission = DiagnosisSemanticSubmission
DiagnosisAgentSubmission = DiagnosisSemanticSubmission


class DiagnosisDataQuality(Payload):
    status: Literal["complete", "available", "degraded", "unavailable"]
    confidence: Literal["high", "medium", "low"]
    missing_fields: list[str] = Field(default_factory=list)
    degraded_fields: list[str] = Field(default_factory=list)
    sample_counts: dict[str, int] = Field(default_factory=dict)


class DiagnosisFundamentalResearch(Payload):
    status: DiagnosisAvailability
    business_understandable: bool | None = None
    company_understanding: str | None = None
    business_model: str | None = None
    business_model_summary: str | None = None
    revenue_sources: list[str] = Field(default_factory=list)
    competitive_advantages: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_advantage: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_counterevidence: list[DiagnosisClaim] = Field(default_factory=list)
    competitive_advantage_counterevidence: list[DiagnosisClaim] = Field(default_factory=list)
    management_governance: list[DiagnosisClaim] = Field(default_factory=list)
    governance: list[DiagnosisClaim] = Field(default_factory=list)
    industry_supply_demand: list[DiagnosisClaim] = Field(default_factory=list)
    industry_context: list[DiagnosisClaim] = Field(default_factory=list)
    policy_transmission: list[DiagnosisClaim] = Field(default_factory=list)
    policy_context: list[DiagnosisClaim] = Field(default_factory=list)
    cycle_position: list[DiagnosisClaim] = Field(default_factory=list)
    cycle_context: list[DiagnosisClaim] = Field(default_factory=list)
    key_assumptions: list[DiagnosisClaim] = Field(default_factory=list)
    risks: list[DiagnosisClaim] = Field(default_factory=list)
    conclusion_change_conditions: list[DiagnosisClaim] = Field(default_factory=list)
    change_conditions: list[DiagnosisClaim] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)


class DiagnosisFactor(Payload):
    name: str = Field(min_length=1)
    value: float | None = None
    percentile: float | None = Field(default=None, ge=0, le=1)
    direction: Literal["positive", "neutral", "negative", "unavailable"] | None = None
    group: str | None = None
    unit: str | None = None
    comparison_scope: str | None = None
    as_of: str | None = None
    weight: float | None = None
    contribution: float | None = None
    source_ids: list[str] = Field(default_factory=list)


class DiagnosisFactorHorizon(Payload):
    status: DiagnosisAvailability = "unavailable"
    validation_status: DiagnosisValidationStatus = "unavailable"
    promotion_status: Literal["calibrated", "research_only", "rejected", "unavailable"] = "unavailable"
    validation_reason: str | None = None
    validation_metrics: dict[str, object] = Field(default_factory=dict)
    target_window_sessions: int | None = Field(default=None, ge=1)
    factor_score: float | None = Field(default=None, ge=0, le=1)
    market_percentile: float | None = Field(default=None, ge=0, le=1)
    industry_percentile: float | None = Field(default=None, ge=0, le=1)
    rank: int | None = Field(default=None, ge=1)
    sample_count: int | None = Field(default=None, ge=0)
    industry_sample_count: int | None = Field(default=None, ge=0)
    missing_count: int | None = Field(default=None, ge=0)
    fallback_scope: Literal["none", "market", "unavailable"] = "none"
    factors: list[DiagnosisFactor] = Field(default_factory=list)
    factor_contributions: dict[str, float] = Field(default_factory=dict)
    method_version: str = "unavailable"
    source_ids: list[str] = Field(default_factory=list)


class DiagnosisFactorSnapshot(Payload):
    short_term: DiagnosisFactorHorizon
    medium_term: DiagnosisFactorHorizon
    long_term: DiagnosisFactorHorizon
    snapshot_as_of: str | None = None
    universe_definition: str | None = None
    content_hash: str | None = None
    sample_count: int | None = Field(default=None, ge=0)
    missing_count: int | None = Field(default=None, ge=0)
    source_ids: list[str] = Field(default_factory=list)


class DiagnosisSourceRecord(Payload):
    id: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    url: str = Field(min_length=1)
    published_at: str | None = None
    period_end: str | None = None


class DiagnosisMaterializedPlan(Payload):
    """Execution values are copied only from deterministic execution output."""

    reference_entry: float | None = None
    reference_entry_low: float | None = None
    reference_entry_high: float | None = None
    pullback_entry: float | None = None
    pullback_entry_low: float | None = None
    pullback_entry_high: float | None = None
    stop_loss: float | None = None
    first_take_profit: float | None = None
    second_take_profit: float | None = None
    risk_reference_price: float | None = Field(default=None, gt=0)
    risk_per_share: float | None = Field(default=None, ge=0)
    risk_pct: float | None = Field(default=None, ge=0)
    first_reward_pct: float | None = Field(default=None, ge=0)
    second_reward_pct: float | None = Field(default=None, ge=0)
    risk_reward_first: float | None = Field(default=None, ge=0)
    risk_reward_second: float | None = Field(default=None, ge=0)
    risk_reward_method_version: str | None = None
    risk_reward_first_after_cost: float | None = None
    risk_reward_second_after_cost: float | None = None
    risk_reward_first_after_fees: float | None = None
    risk_reward_second_after_fees: float | None = None
    estimated_slippage_pct: float | None = Field(default=None, ge=0)
    cost_assumptions: dict[str, object] = Field(default_factory=dict)
    cost_scope: Literal["fees_and_slippage_proxy", "unavailable"] = "unavailable"
    cost_method_version: str | None = None
    slippage_method_version: str | None = None
    minimum_risk_reward_first: float = Field(default=1.0, ge=0)
    minimum_risk_reward_second: float = Field(default=2.0, ge=0)
    risk_reward_gate_status: Literal["passed", "failed", "unavailable"] = "unavailable"
    risk_reward_gate_method_version: str = "gross-risk-reward-gate-v1"
    fee_gate_status: Literal["passed", "failed", "unavailable"] = "unavailable"
    fee_gate_method_version: str = "fee-adjusted-risk-reward-gate-v1"
    slippage_stress_status: Literal["passed", "failed", "unavailable"] = "unavailable"
    slippage_stress_method_version: str = "market-slippage-stress-v1"
    entry_condition_status: Literal["triggered", "not_triggered", "unavailable"] = "unavailable"
    entry_condition: str | None = None
    entry_condition_count: int = Field(default=0, ge=0)
    entry_condition_realtime_eligible: bool = False
    value_status: Literal["available", "partial", "unavailable"] = "unavailable"
    unavailable_fields: list[str] = Field(default_factory=list)
    invalidation: list[str] = Field(default_factory=list)
    boundaries: list[str] = Field(default_factory=list)
    max_risk_pct: float | None = None
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_price_relationships(self) -> "DiagnosisMaterializedPlan":
        price_fields = (
            "reference_entry",
            "reference_entry_low",
            "reference_entry_high",
            "pullback_entry",
            "pullback_entry_low",
            "pullback_entry_high",
            "stop_loss",
            "first_take_profit",
            "second_take_profit",
        )
        for field_name in price_fields:
            value = getattr(self, field_name)
            if value is not None and value <= 0:
                raise ValueError(f"diagnosis plan {field_name} must be positive")
        if (
            self.reference_entry_low is not None
            and self.reference_entry_high is not None
            and self.reference_entry_low > self.reference_entry_high
        ):
            raise ValueError("diagnosis reference entry range is inverted")
        if (
            self.pullback_entry_low is not None
            and self.pullback_entry_high is not None
            and self.pullback_entry_low > self.pullback_entry_high
        ):
            raise ValueError("diagnosis pullback entry range is inverted")
        entry_lows = [
            value
            for value in (
                self.reference_entry_low,
                self.pullback_entry_low,
                self.reference_entry,
                self.pullback_entry,
            )
            if value is not None
        ]
        entry_highs = [
            value
            for value in (
                self.reference_entry_high,
                self.pullback_entry_high,
                self.reference_entry,
                self.pullback_entry,
            )
            if value is not None
        ]
        if self.stop_loss is not None and entry_lows and self.stop_loss >= min(entry_lows):
            raise ValueError("diagnosis stop loss must be below the entry range")
        if (
            self.first_take_profit is not None
            and entry_highs
            and self.first_take_profit <= max(entry_highs)
        ):
            raise ValueError("diagnosis first take profit must be above the entry range")
        if (
            self.first_take_profit is not None
            and self.second_take_profit is not None
            and self.second_take_profit <= self.first_take_profit
        ):
            raise ValueError("diagnosis second take profit must exceed the first")
        if self.value_status == "available" and any(
            getattr(self, field_name) is None
            for field_name in (
                "reference_entry",
                "pullback_entry",
                "stop_loss",
                "first_take_profit",
                "second_take_profit",
            )
        ):
            raise ValueError("available diagnosis plan requires all execution prices")
        if self.entry_condition_status != "unavailable" and not self.entry_condition:
            raise ValueError("diagnosis entry condition status requires a condition description")
        if self.entry_condition_realtime_eligible and (
            self.entry_condition_count != 1 or not self.entry_condition
        ):
            raise ValueError("realtime diagnosis entry evaluation requires one described condition")
        if self.risk_reward_gate_status != "unavailable":
            if self.risk_reward_first is None or self.risk_reward_second is None:
                raise ValueError("diagnosis risk-reward gate requires both target ratios")
            passed = (
                self.risk_reward_first >= self.minimum_risk_reward_first
                and self.risk_reward_second >= self.minimum_risk_reward_second
            )
            if (self.risk_reward_gate_status == "passed") != passed:
                raise ValueError("diagnosis risk-reward gate status does not match its ratios")
        if self.fee_gate_status != "unavailable":
            if (
                self.risk_reward_first_after_fees is None
                or self.risk_reward_second_after_fees is None
            ):
                raise ValueError("diagnosis fee gate requires both target ratios")
            passed_after_fees = (
                self.risk_reward_first_after_fees >= self.minimum_risk_reward_first
                and self.risk_reward_second_after_fees >= self.minimum_risk_reward_second
            )
            if (self.fee_gate_status == "passed") != passed_after_fees:
                raise ValueError("diagnosis fee gate status does not match its ratios")
        if self.slippage_stress_status != "unavailable":
            if (
                self.risk_reward_first_after_cost is None
                or self.risk_reward_second_after_cost is None
            ):
                raise ValueError("diagnosis slippage stress requires both target ratios")
            passed_stress = (
                self.risk_reward_first_after_cost >= self.minimum_risk_reward_first
                and self.risk_reward_second_after_cost >= self.minimum_risk_reward_second
            )
            if (self.slippage_stress_status == "passed") != passed_stress:
                raise ValueError("diagnosis slippage stress status does not match its ratios")
        if self.cost_scope == "fees_and_slippage_proxy" and (
            self.estimated_slippage_pct is None or not self.cost_assumptions
        ):
            raise ValueError("diagnosis cost scope requires slippage and cost assumptions")
        if self.cost_scope == "fees_and_slippage_proxy" and self.slippage_stress_status == "unavailable":
            raise ValueError("diagnosis cost scope requires a slippage stress result")
        if self.cost_scope == "unavailable" and (
            self.risk_reward_first_after_cost is not None
            or self.risk_reward_second_after_cost is not None
            or self.slippage_stress_status != "unavailable"
        ):
            raise ValueError("unavailable diagnosis cost scope cannot carry slippage stress results")
        return self


class DiagnosisPositionPlan(Payload):
    reference_position_pct: float | None = Field(default=None, ge=0, le=100)
    max_position_pct: float | None = Field(default=None, ge=0, le=100)
    risk_budget_pct: float | None = Field(default=None, ge=0, le=100)
    stop_distance_pct: float | None = Field(default=None, gt=0, le=100)
    volatility_adjustment: float | None = Field(default=None, gt=0, le=1)
    liquidity_cap_pct: float | None = Field(default=None, gt=0, le=100)
    conservative_risk_cap_pct: float | None = Field(default=None, ge=0, le=100)
    calculation_method: str | None = None
    calculation_version: str | None = None
    risk_cap_method_version: str | None = None
    value_status: Literal["available", "partial", "unavailable"] = "unavailable"
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_position_math(self) -> "DiagnosisPositionPlan":
        if (
            self.reference_position_pct is not None
            and self.max_position_pct is not None
            and self.reference_position_pct > self.max_position_pct
        ):
            raise ValueError("diagnosis reference position cannot exceed max position")
        source_sizing = (
            self.risk_budget_pct,
            self.stop_distance_pct,
            self.volatility_adjustment,
            self.liquidity_cap_pct,
            self.max_position_pct,
        )
        if all(value is not None for value in source_sizing):
            theoretical = self.risk_budget_pct / self.stop_distance_pct * 100  # type: ignore[operator]
            maximum = min(
                theoretical * self.volatility_adjustment,  # type: ignore[operator]
                self.liquidity_cap_pct,  # type: ignore[arg-type]
            )
            if self.max_position_pct > maximum + 1e-6:  # type: ignore[operator]
                raise ValueError("diagnosis max position exceeds source risk limits")
        if (
            self.conservative_risk_cap_pct is not None
            and self.max_position_pct is not None
            and self.max_position_pct > self.conservative_risk_cap_pct + 1e-6
        ):
            raise ValueError("diagnosis max position exceeds conservative risk cap")
        return self


class DiagnosisHorizonDecision(Payload):
    direction: DiagnosisDirection
    action: DiagnosisAction
    decision_score: float | None = Field(default=None, ge=-1, le=1)
    positive_threshold: float = Field(default=0.2, ge=0, le=1)
    negative_threshold: float = Field(default=-0.2, ge=-1, le=0)
    component_scores: dict[str, float] = Field(default_factory=dict)
    component_weights: dict[str, float] = Field(default_factory=dict)
    factor_score: float | None = Field(default=None, ge=0, le=1)
    market_percentile: float | None = Field(default=None, ge=0, le=1)
    industry_percentile: float | None = Field(default=None, ge=0, le=1)
    factor_contributions: dict[str, float] = Field(default_factory=dict)
    validation_status: DiagnosisValidationStatus
    not_holding_action: DiagnosisAction
    holding_action: DiagnosisAction
    current_action: DiagnosisCurrentAction | None = None
    thesis: str | None = None
    materialized_plan: DiagnosisMaterializedPlan
    position_plan: DiagnosisPositionPlan
    review_trigger: str = "暂无可确认的复评条件"
    valid_until: str | None = None
    key_reasons: list[DiagnosisClaim] = Field(default_factory=list)
    key_risks: list[DiagnosisClaim] = Field(default_factory=list)
    confidence: Literal["high", "medium", "low"]
    source_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_decision_score_contract(self) -> "DiagnosisHorizonDecision":
        allowed_components = {"fundamental", "technical", "quant"}
        if not set(self.component_scores) <= allowed_components:
            raise ValueError("diagnosis decision has an unknown score component")
        if set(self.component_scores) != set(self.component_weights):
            raise ValueError("diagnosis decision score components and weights differ")
        if any(not isfinite(value) or not -1 <= value <= 1 for value in self.component_scores.values()):
            raise ValueError("diagnosis decision component scores must be within -1..1")
        if any(not isfinite(value) or not 0 <= value <= 1 for value in self.component_weights.values()):
            raise ValueError("diagnosis decision component weights must be within 0..1")
        if self.component_weights and abs(sum(self.component_weights.values()) - 1.0) > 1e-8:
            raise ValueError("diagnosis decision component weights must sum to one")
        if self.decision_score is None:
            return self
        if self.direction == "positive" and self.decision_score <= self.positive_threshold:
            raise ValueError("positive diagnosis direction does not clear its threshold")
        if self.direction == "negative" and self.decision_score >= self.negative_threshold:
            raise ValueError("negative diagnosis direction does not clear its threshold")
        if self.direction == "neutral" and not self.negative_threshold <= self.decision_score <= self.positive_threshold:
            raise ValueError("neutral diagnosis direction is outside its thresholds")
        return self


class DiagnosisHorizonDecisions(Payload):
    short_term: DiagnosisHorizonDecision
    medium_term: DiagnosisHorizonDecision
    long_term: DiagnosisHorizonDecision


class DiagnosisDecisionBasisRow(Payload):
    key: Literal["fundamental", "quant", "sentiment", "risk"]
    label: str = Field(min_length=1)
    stance: Literal["positive", "neutral", "cautious", "negative", "strict"]
    stance_label: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)


class DiagnosisDecisionRadar(Payload):
    current_decision: DiagnosisHorizonDecision | None = None
    basis_rows: list[DiagnosisDecisionBasisRow] = Field(default_factory=list)
    short_term: DiagnosisHorizonDecision
    medium_term: DiagnosisHorizonDecision
    long_term: DiagnosisHorizonDecision
    holding_state: DiagnosisHoldingState = "not_holding"
    overall_confidence: Literal["high", "medium", "low"]
    deterministic: bool = True


class DiagnosisTechnicalExecution(Payload):
    status: DiagnosisAvailability
    source_ids: list[str] = Field(default_factory=list)
    # The calculation layer may add deterministic fields in this map.  The
    # report contract only exposes the values required for the plan and keeps
    # the map strict at the top level.
    horizons: dict[str, DiagnosisMaterializedPlan] = Field(default_factory=dict)
    position: dict[str, DiagnosisPositionPlan] = Field(default_factory=dict)
    review_triggers: dict[str, str] = Field(default_factory=dict)
    valid_until: dict[str, str | None] = Field(default_factory=dict)


class StockDiagnosisV1(Payload):
    """Persisted deterministic standard-diagnosis report.

    ``kind`` is a discriminator rather than a cosmetic label.  Deep research
    V4/V5/V6 reports remain ``kind=deep_research`` and are validated by their
    existing models; this contract cannot validate or represent those reports.
    """

    schema_version: Literal[1]
    kind: Literal["ai_diagnosis"]
    diagnosis_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    instrument: InstrumentTag
    research_cutoff_at: str = Field(min_length=1)
    market_as_of: str | None = None
    current_price: float | None = Field(default=None, gt=0)
    price_source_ids: list[str] = Field(default_factory=list)
    generated_at: str = Field(min_length=1)
    evidence_context_id: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    sources: list[DiagnosisSourceRecord] = Field(default_factory=list)
    data_quality: DiagnosisDataQuality
    fundamental_research: DiagnosisFundamentalResearch
    fundamental_factors: DiagnosisFactorSnapshot
    quant_factors: DiagnosisFactorSnapshot
    technical_execution: DiagnosisTechnicalExecution
    horizon_decisions: DiagnosisHorizonDecisions
    decision_radar: DiagnosisDecisionRadar
    method_versions: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _separate_from_deep_research(self) -> "StockDiagnosisV1":
        if self.kind != "ai_diagnosis" or self.schema_version != 1:
            raise ValueError("standard diagnosis requires kind=ai_diagnosis and schema_version=1")
        if self.current_price is not None and not self.price_source_ids:
            raise ValueError("diagnosis current_price requires price_source_ids")
        nested_source_ids: set[str] = set()
        nested_source_ids.update(self.price_source_ids)
        for value in (
            self.fundamental_research,
            self.fundamental_factors,
            self.quant_factors,
            self.technical_execution,
            self.horizon_decisions,
        ):
            serialized = value.model_dump(mode="python")
            nested_source_ids.update(_diagnosis_source_ids(serialized))
        if not nested_source_ids <= set(self.source_ids):
            missing = sorted(nested_source_ids - set(self.source_ids))
            raise ValueError(f"diagnosis source_ids missing nested sources: {missing}")
        if not {source.id for source in self.sources} <= set(self.source_ids):
            raise ValueError("diagnosis source records must belong to source_ids")
        return self


def _diagnosis_source_ids(value: object) -> set[str]:
    """Collect source ids for the v1 report closure validator."""

    if isinstance(value, dict):
        found: set[str] = set()
        raw = value.get("source_ids")
        if isinstance(raw, list):
            found.update(item for item in raw if isinstance(item, str) and item)
        for child in value.values():
            found.update(_diagnosis_source_ids(child))
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for child in value:
            found.update(_diagnosis_source_ids(child))
        return found
    return set()


# Short names make the boundary discoverable to tool and API code without
# exposing the deep-research ``ReportSubmission`` as a compatibility alias.
DiagnosisReportV1 = StockDiagnosisV1
StockDiagnosisSubmission = DiagnosisSemanticSubmission
