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

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
DIGEST_SCHEMA_VERSION = 3


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


class ReportSubmission(Payload):
    """Payload for ``submit_stock_report``.

    A single-instrument payload is Report V4. The daily-review ``items``
    variant remains schema V3. Trusted evidence timestamps, coverage and
    outcome tracking are injected by the submit tool, never accepted here.
    """

    as_of: str | None = None
    summary: str = Field(min_length=1)
    source_ids: list[str] = Field(default_factory=list)
    instrument: InstrumentTag | None = None
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

    def all_source_ids(self) -> list[str]:
        ids = list(dict.fromkeys(self.source_ids))
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
