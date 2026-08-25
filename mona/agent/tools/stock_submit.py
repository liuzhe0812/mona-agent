"""Structured submission tools (design §6, §8; dev plan T12).

Six ``submit_*`` tools for the A-share pack, all living in the
``subagent`` scope only. Each tool validates its payload with the
Pydantic schemas in :mod:`mona.services.stock.schemas`, resolves every
cited ``source_id`` against the current run's evidence bundle (forged
references are rejected), writes the artifact under
``<workspace>/stock_projects/<run_id>/`` atomically, and appends the
``artifact://`` reference to the run-level collector so the
``WorkflowRunner`` can fill ``StepRun.output.artifacts`` on success.

Trusted identity (``workflow_run_id``, ``job_id``) always comes from the
shared ToolContext, never from model input — the schemas forbid those
fields outright.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Annotated, Any, Mapping

from pydantic import Field, TypeAdapter, ValidationError

from mona.agent import run_artifacts
from mona.agent.artifacts import ArtifactRef
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.workflow import WorkflowRunStore
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.execution import assess_a_share_execution, materialize_v6_trading_plan
from mona.services.stock.outcomes import ensure_outcome_tracking_snapshot
from mona.services.stock.provenance import SourceRecord, compare_asia_datetime
from mona.services.stock.risk_profile import (
    LocalRiskProfileStore,
    RiskProfileStorageError,
    risk_profile_path,
)
from mona.services.stock.schemas import (
    ANALYSIS_DIMENSION_KEYS,
    DATA_QUALITIES,
    DECISION_REPORT_SCHEMA_VERSION,
    DIGEST_SCHEMA_VERSION,
    DISCLAIMER,
    EXCHANGES,
    INSTRUMENT_TYPES,
    REPORT_SCHEMA_VERSION,
    STANCES,
    V5_FORBIDDEN_TERMS,
    VIEW_SCHEMA_VERSION,
    AnalysisDimension,
    BatchViewSubmission,
    CrossHorizonConflict,
    CycleState,
    CycleStates,
    DebateResolution,
    DebateResolutions,
    DecisionReportV5,
    DecisionReportV6,
    DigestItem,
    DimensionViews,
    FundamentalViewSubmission,
    HorizonCaseSubmission,
    HorizonView,
    HorizonViews,
    InstrumentTag,
    NewsViewSubmission,
    ReportSubmission,
    ScenarioSet,
    ScenarioSets,
    SummarySection,
    TechnicalViewSubmission,
    V5HorizonDecision,
    V5HorizonDecisionSubmission,
    V5PositionPlan,
    V5TradingPlan,
    V6HorizonDecision,
    V6HorizonDecisionSubmission,
    ViewPoint,
)
from mona.services.stock.v6_tracking import ensure_v6_tracking_snapshot

_HORIZON_DIMENSIONS = {
    "short_term": (
        "market_environment",
        "industry",
        "capital_positioning",
        "event_risk",
    ),
    "medium_term": (
        "market_environment",
        "industry",
        "policy",
        "cycle",
        "capital_positioning",
    ),
    "long_term": (
        "industry",
        "policy",
        "cycle",
        "company_quality",
        "valuation",
    ),
}

_COVERAGE_DISCLOSURE_ALIASES = {
    "quote": "market_environment",
    "kline": "market_environment",
    "market_regime": "market_environment",
    "industry_context": "industry",
    "policy_context": "policy",
    "cycle_context": "cycle",
    "company_quality": "company_quality",
    "fundamentals": "company_quality",
    "event_calendar": "event_risk",
    "tradeability": "tradeability",
}

_STANCE_ENUM = list(STANCES)
_QUALITY_ENUM = list(DATA_QUALITIES)
_EXCHANGE_ENUM = list(EXCHANGES)
_INSTRUMENT_TYPE_ENUM = list(INSTRUMENT_TYPES)

_BENCHMARK_HORIZON_WINDOWS = {
    "short_term": frozenset({5, 10}),
    "medium_term": frozenset({20, 60}),
    "long_term": frozenset({120, 250}),
}
_EVENT_FIELDS = (
    "event_type",
    "title",
    "published_at",
    "event_date",
    "status",
    "url",
    "source_ids",
)
_REPORT_WRITE_LOCK = threading.Lock()
_STOCK_RESEARCH_ROOM_ID = "stock_research"
_STOCK_DEEP_RESEARCH_STEP_IDS = frozenset(
    {"technical", "fundamental", "news", "bull", "bear", "referee"}
)

_INSTRUMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "symbol": {"type": "string", "description": "6-digit instrument code"},
        "exchange": {"type": "string", "enum": _EXCHANGE_ENUM},
        "name": {"type": "string"},
        "instrument_type": {"type": "string", "enum": _INSTRUMENT_TYPE_ENUM},
    },
    "required": ["symbol", "exchange"],
}
_POINT_SCHEMA = {
    "type": "object",
    "properties": {
        "claim": {"type": "string"},
        "evidence": {"type": "string"},
        "claim_type": {
            "type": "string",
            "enum": ["fact", "inference", "hypothesis"],
            "description": "Epistemic status of this claim",
        },
        "basis": {
            "type": ["string", "null"],
            "description": "Transparent rule or reasoning basis for an inference",
        },
        "source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["claim", "claim_type"],
}
_VIEW_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "instrument": _INSTRUMENT_SCHEMA,
        "stance": {"type": "string", "enum": _STANCE_ENUM},
        "summary": {"type": "string"},
        "points": {"type": "array", "items": _POINT_SCHEMA},
        "source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["instrument", "stance", "summary"],
}
_BASE_VIEW_PROPERTIES = {
    "as_of": {
        "type": "string",
        "description": "Evidence timestamp (ISO 8601) copied from the bundle",
    },
    "instrument": _INSTRUMENT_SCHEMA,
    "stance": {"type": "string", "enum": _STANCE_ENUM},
    "summary": {"type": "string", "description": "One-paragraph conclusion"},
    "source_ids": {"type": "array", "items": {"type": "string"}},
}


def _structured_view_params(sections: list[str]) -> dict[str, Any]:
    properties = dict(_BASE_VIEW_PROPERTIES)
    properties.update({name: {"type": "array", "items": _POINT_SCHEMA} for name in sections})
    properties["items"] = {
        "type": "array",
        "items": _VIEW_ITEM_SCHEMA,
        "description": "Legacy daily-review batch mode",
    }
    return {
        "type": "object",
        "properties": properties,
        # Pydantic selects the structured single mode or legacy batch mode.
        "required": ["as_of"],
    }


_BATCH_VIEW_PARAMS = {
    "type": "object",
    "properties": {
        "as_of": _BASE_VIEW_PROPERTIES["as_of"],
        "items": {
            "type": "array",
            "items": _VIEW_ITEM_SCHEMA,
            "description": "Batch mode (daily review): one entry per instrument",
        },
    },
    "required": ["as_of", "items"],
}

_HORIZON_CASE_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["available", "insufficient_data"]},
        "summary": {"type": "string"},
        "points": {"type": "array", "items": _POINT_SCHEMA},
        "assumptions": {"type": "array", "items": _POINT_SCHEMA},
        "confirmation": {"type": "array", "items": _POINT_SCHEMA},
        "invalidation": {"type": "array", "items": _POINT_SCHEMA},
        "source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "status",
        "summary",
        "points",
        "assumptions",
        "confirmation",
        "invalidation",
        "source_ids",
    ],
}
_CASE_PARAMS = {
    "type": "object",
    "properties": {
        **_BASE_VIEW_PROPERTIES,
        "horizon_cases": {
            "type": "object",
            "properties": {
                "short_term": _HORIZON_CASE_SCHEMA,
                "medium_term": _HORIZON_CASE_SCHEMA,
                "long_term": _HORIZON_CASE_SCHEMA,
            },
            "required": ["short_term", "medium_term", "long_term"],
        },
        "items": {
            "type": "array",
            "items": _VIEW_ITEM_SCHEMA,
            "description": "Legacy daily-review batch mode",
        },
    },
    # Pydantic selects either the single horizon_cases mode or legacy items mode.
    "required": ["as_of"],
}
_DIGEST_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "instrument": _INSTRUMENT_SCHEMA,
        "stance": {"type": "string", "enum": _STANCE_ENUM},
        "one_liner": {"type": "string"},
        "data_quality": {"type": "string", "enum": _QUALITY_ENUM},
        "missing": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["instrument", "stance", "one_liner", "data_quality"],
}
_V5_SUBMISSION_DECISION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "direction": {"type": "string", "enum": ["positive", "neutral", "negative"]},
        "action": {
            "type": "string",
            "enum": ["conditional_participation", "wait", "hold", "reduce", "exit", "avoid"],
        },
        "thesis": {"type": "string"},
        "not_holding_action": {"type": "string", "enum": ["participate", "wait", "avoid"]},
        "holding_action": {"type": "string", "enum": ["hold", "reduce", "exit"]},
        "key_reasons": {"type": "array", "items": _POINT_SCHEMA},
        "key_risks": {"type": "array", "items": _POINT_SCHEMA},
        "source_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "direction",
        "action",
        "thesis",
        "not_holding_action",
        "holding_action",
        "key_reasons",
        "key_risks",
        "source_ids",
    ],
}
_V6_SUBMISSION_DECISION_SCHEMA = {
    **_V5_SUBMISSION_DECISION_SCHEMA,
    "properties": {
        **_V5_SUBMISSION_DECISION_SCHEMA["properties"],
        "direction": {"type": "string", "enum": ["positive", "neutral", "negative", "avoid"]},
        "disagreement_matrix": {
            "type": "object",
            "description": "Structured qualitative disagreement; no numeric or execution fields",
        },
    },
}
_REPORT_PARAMS = {
    "type": "object",
    "properties": {
        "as_of": {"type": ["string", "null"]},
        "schema_version": {"type": ["integer", "null"], "enum": [5, 6, None]},
        "summary": {"type": "string"},
        "source_ids": {"type": "array", "items": {"type": "string"}},
        "instrument": _INSTRUMENT_SCHEMA,
        "horizon_decisions": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "short_term": _V5_SUBMISSION_DECISION_SCHEMA,
                "medium_term": _V5_SUBMISSION_DECISION_SCHEMA,
                "long_term": _V5_SUBMISSION_DECISION_SCHEMA,
            },
            "required": ["short_term", "medium_term", "long_term"],
            "description": "V5 qualitative decisions; price, position and condition fields are system-injected",
        },
        "horizon_decisions_v6": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "short_term": _V6_SUBMISSION_DECISION_SCHEMA,
                "medium_term": _V6_SUBMISSION_DECISION_SCHEMA,
                "long_term": _V6_SUBMISSION_DECISION_SCHEMA,
            },
            "description": "V6 qualitative decisions; research/trade gates and plans are system-injected",
        },
        "versions": {"type": "object"},
        "horizon_views": {
            "type": "object",
            "properties": {
                "short_term": {"$ref": "#/$defs/horizon_view"},
                "medium_term": {"$ref": "#/$defs/horizon_view"},
                "long_term": {"$ref": "#/$defs/horizon_view"},
            },
            "required": ["short_term", "medium_term", "long_term"],
        },
        "dimension_views": {
            "type": "object",
            "properties": {
                key: {"$ref": "#/$defs/dimension_view"}
                for key in ANALYSIS_DIMENSION_KEYS
            },
            "required": list(ANALYSIS_DIMENSION_KEYS),
        },
        "debate_resolution": {
            "type": "object",
            "properties": {
                "short_term": {"$ref": "#/$defs/debate_resolution"},
                "medium_term": {"$ref": "#/$defs/debate_resolution"},
                "long_term": {"$ref": "#/$defs/debate_resolution"},
            },
            "required": ["short_term", "medium_term", "long_term"],
        },
        "cycle_states": {
            "type": "object",
            "properties": {
                "policy": {"$ref": "#/$defs/cycle_state"},
                "industry": {"$ref": "#/$defs/cycle_state"},
                "earnings": {"$ref": "#/$defs/cycle_state"},
                "valuation": {"$ref": "#/$defs/cycle_state"},
            },
            "required": ["policy", "industry", "earnings", "valuation"],
        },
        "market_regime_summary": {"$ref": "#/$defs/summary_section"},
        "industry_policy_summary": {"$ref": "#/$defs/summary_section"},
        "scenario_sets": {
            "type": "object",
            "properties": {
                "short_term": {"$ref": "#/$defs/scenario_set"},
                "medium_term": {"$ref": "#/$defs/scenario_set"},
                "long_term": {"$ref": "#/$defs/scenario_set"},
            },
            "required": ["short_term", "medium_term", "long_term"],
        },
        "cross_horizon_conflict": {
            "type": "object",
            "properties": {
                "explanation": {"type": "string"},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["explanation"],
        },
        "risks": {"type": "array", "items": _POINT_SCHEMA},
        "catalysts": {"type": "array", "items": _POINT_SCHEMA},
        "open_questions": {"type": "array", "items": _POINT_SCHEMA},
        "items": {
            "type": "array",
            "items": _DIGEST_ITEM_SCHEMA,
            "description": "Daily-review digest mode: one row per watchlist instrument",
        },
    },
    "required": ["summary"],
    "additionalProperties": False,
    "$defs": {
        "condition": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["manual", "trigger"]},
                "text": {"type": "string"},
                "claim_type": {
                    "type": ["string", "null"],
                    "enum": ["fact", "inference", "hypothesis", None],
                    "description": "Required with a non-empty source_ids list for stop-loss and take-profit conditions; legacy conditions may omit it",
                },
                "observed_metric_ref": {"type": ["string", "null"]},
                "operator": {
                    "type": ["string", "null"],
                    "enum": [
                        "gt", "gte", "lt", "lte", "crosses_above", "crosses_below", None
                    ],
                },
                "threshold_metric_ref": {
                    "type": ["string", "null"],
                    "description": "Distinct Evidence field containing the threshold (for example indicators.swing.support); literal numeric thresholds are forbidden",
                },
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["kind", "source_ids"],
        },
        "benchmark": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "instrument_id": {
                    "type": ["string", "null"],
                    "pattern": "^(XSHG|XSHE|BJSE):[0-9]{6}$",
                    "description": "Exact instrument_id of a benchmark item in Evidence.relative_benchmarks; never infer from name",
                },
                "relative_view": {
                    "type": "string",
                    "enum": ["outperform", "inline", "underperform", "unknown"],
                },
                "basis": {"type": ["string", "null"], "description": "Why the matched Evidence benchmark window supports this comparison; the final boundary injects the deterministic window fact when available"},
                "source_ids": {"type": "array", "items": {"type": "string"}, "description": "Source ids from the matched Evidence benchmark item, not merely any current-run source"},
            },
            "required": ["name", "relative_view"],
        },
        "horizon_view": {
            "type": "object",
            "properties": {
                "stance": {"type": "string", "enum": _STANCE_ENUM},
                "status": {"type": "string", "enum": ["available", "insufficient_data"]},
                "thesis": {"type": "string"},
                "drivers": {"type": "array", "items": _POINT_SCHEMA},
                "priced_in": {
                    "type": "string",
                    "enum": ["not_priced_in", "partially_priced_in", "fully_priced_in", "unknown"],
                },
                "priced_in_basis": {
                    "type": ["object", "null"],
                    "properties": _POINT_SCHEMA["properties"],
                    "required": _POINT_SCHEMA["required"],
                    "description": "Sourced inference explaining priced_in; required unless unknown",
                },
                "benchmark": {"$ref": "#/$defs/benchmark"},
                "action": {
                    "type": "string",
                    "enum": [
                        "observe", "wait_for_confirmation", "conditional_participation",
                        "reduce_exposure", "not_applicable",
                    ],
                },
                "participation_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "confirmation_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "watch_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "invalidation_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "stop_loss_conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/condition"},
                    "description": "Optional evidence-traceable exit/stop-loss conditions; use an empty array when evidence is insufficient",
                },
                "take_profit_conditions": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/condition"},
                    "description": "Optional evidence-traceable take-profit conditions; never invent target prices",
                },
                "time_stop": {"type": "string"},
                "tradeability_risks": {"type": "array", "items": _POINT_SCHEMA},
                "blind_spots": {"type": "array", "items": _POINT_SCHEMA},
                "evidence_strength": {"type": "string", "enum": ["low", "medium", "high"]},
                "data_status": {"type": "string", "enum": _QUALITY_ENUM},
                "missing_fields": {"type": "array", "items": {"type": "string"}},
                "source_ids": {"type": "array", "items": {"type": "string"}},
                "dimension_keys": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(ANALYSIS_DIMENSION_KEYS)},
                },
            },
            "required": [
                "stance", "status", "thesis", "drivers", "priced_in", "priced_in_basis", "benchmark", "action",
                "participation_conditions", "confirmation_conditions", "watch_conditions",
                "invalidation_conditions", "time_stop", "tradeability_risks", "blind_spots",
                "evidence_strength", "data_status", "missing_fields", "source_ids",
                "dimension_keys",
            ],
        },
        "dimension_view": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["available", "degraded", "missing"]},
                "summary": {"type": "string"},
                "points": {
                    "type": "array",
                    "items": _POINT_SCHEMA,
                    "description": "Renderer compatibility field; must equal facts + inferences + hypotheses",
                },
                "facts": {"type": "array", "items": _POINT_SCHEMA},
                "inferences": {"type": "array", "items": _POINT_SCHEMA},
                "hypotheses": {"type": "array", "items": _POINT_SCHEMA},
                "research_cutoff_at": {"type": ["string", "null"]},
                "market_as_of": {"type": ["string", "null"]},
                "published_at": {"type": ["string", "null"]},
                "period_end": {"type": ["string", "null"]},
                "missing_fields": {"type": "array", "items": {"type": "string"}},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "status", "summary", "points", "facts", "inferences", "hypotheses",
                "missing_fields", "source_ids",
            ],
        },
        "debate_resolution": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["available", "degraded", "missing"]},
                "issue": {"type": "string"},
                "bull_case": {"type": "array", "items": _POINT_SCHEMA},
                "bear_case": {"type": "array", "items": _POINT_SCHEMA},
                "verdict": {"type": "array", "items": _POINT_SCHEMA},
                "change_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "missing_fields": {"type": "array", "items": {"type": "string"}},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "status", "issue", "bull_case", "bear_case", "verdict",
                "change_conditions", "missing_fields", "source_ids",
            ],
        },
        "cycle_state": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["available", "degraded", "missing"]},
                "stage": {"type": "string"},
                "leading_indicators": {"type": "array", "items": _POINT_SCHEMA},
                "confirmation_indicators": {"type": "array", "items": _POINT_SCHEMA},
                "turning_conditions": {
                    "type": "array", "items": {"$ref": "#/$defs/condition"}
                },
                "observation_window": {"type": "string"},
                "evidence_strength": {"type": "string", "enum": ["low", "medium", "high"]},
                "missing_fields": {"type": "array", "items": {"type": "string"}},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "status", "stage", "leading_indicators", "confirmation_indicators",
                "turning_conditions", "observation_window", "evidence_strength",
                "missing_fields", "source_ids",
            ],
        },
        "summary_section": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["available", "degraded", "missing"]},
                "summary": {"type": "string"},
                "points": {"type": "array", "items": _POINT_SCHEMA},
                "missing_fields": {"type": "array", "items": {"type": "string"}},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["status", "summary", "points", "missing_fields", "source_ids"],
        },
        "scenario": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "conditions": {"type": "array", "items": {"$ref": "#/$defs/condition"}},
                "outcome_direction": {"type": "string"},
                "risks": {"type": "array", "items": _POINT_SCHEMA},
                "source_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["summary", "conditions", "outcome_direction", "risks", "source_ids"],
        },
        "scenario_set": {
            "type": "object",
            "properties": {
                "optimistic": {"$ref": "#/$defs/scenario"},
                "base": {"$ref": "#/$defs/scenario"},
                "pessimistic": {"$ref": "#/$defs/scenario"},
            },
            "required": ["optimistic", "base", "pessimistic"],
        },
    },
}


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
    os.replace(tmp, path)


def _atomic_write_json(path: Path, data: dict) -> None:
    _atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2))


def _resolve_sources(
    workspace: Path, run_id: str, source_ids: list[str]
) -> tuple[list[dict], str | None]:
    """Resolve cited source ids against the run's evidence bundle.

    Returns ``(records, None)`` in citation order, or ``([], error)`` when
    any id is unknown — agents may reference sources but never fabricate
    them (design §7.3, §8).
    """
    if not source_ids:
        return [], None
    data = EvidenceService(workspace=workspace, provider=None).read(run_id)
    available: dict[str, dict] = {}
    for bundle in ((data or {}).get("symbols") or {}).values():
        for record in bundle.get("sources") or []:
            if isinstance(record, dict) and record.get("id"):
                available.setdefault(record["id"], record)
    resolved: list[dict] = []
    for source_id in source_ids:
        record = available.get(source_id)
        if record is None:
            return [], f"Error: source {source_id!r} not found in run {run_id} evidence."
        resolved.append(record)
    return resolved, None


_MISSING = object()


def _evidence_path_value(value: Any, field_ref: str) -> Any:
    """Resolve a dotted Evidence field path, preserving missing/None values."""
    current = value
    for part in field_ref.split("."):
        if not part or not isinstance(current, dict) or part not in current:
            return _MISSING
        current = current[part]
    return current


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except (OverflowError, TypeError):
        return False


def _load_report_bundle(
    workspace: Path, run_id: str, instrument_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    data = EvidenceService(workspace=workspace, provider=None).read(run_id) or {}
    bundle = (data.get("symbols") or {}).get(instrument_id)
    if not isinstance(bundle, dict):
        return None, f"Error: instrument Evidence {instrument_id!r} not found in run {run_id}."
    return bundle, None


def _iter_report_conditions(payload: Any):
    """Yield every V4 condition whose metric refs need current Evidence."""
    for view in (
        payload.horizon_views.short_term,
        payload.horizon_views.medium_term,
        payload.horizon_views.long_term,
    ):
        yield from view.participation_conditions
        yield from view.confirmation_conditions
        yield from view.watch_conditions
        yield from view.invalidation_conditions
        yield from getattr(view, "stop_loss_conditions", []) or []
        yield from getattr(view, "take_profit_conditions", []) or []
    for cycle in (
        payload.cycle_states.policy,
        payload.cycle_states.industry,
        payload.cycle_states.earnings,
        payload.cycle_states.valuation,
    ):
        yield from cycle.turning_conditions
    for resolution in (
        payload.debate_resolution.short_term,
        payload.debate_resolution.medium_term,
        payload.debate_resolution.long_term,
    ):
        yield from resolution.change_conditions
    for scenarios in (
        payload.scenario_sets.short_term,
        payload.scenario_sets.medium_term,
        payload.scenario_sets.long_term,
    ):
        for scenario in (scenarios.optimistic, scenarios.base, scenarios.pessimistic):
            yield from scenario.conditions


def _relative_benchmark_entries(bundle: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the auditable benchmark items exposed by Evidence.

    The current Evidence provider emits one ``relative_benchmarks`` object;
    accepting an ``items``/``benchmarks`` list keeps the submit contract
    readable if more public benchmarks are added later without allowing a
    model to invent one.
    """
    raw = bundle.get("relative_benchmarks")
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if not isinstance(raw, dict):
        return []
    for key in ("items", "benchmarks"):
        items = raw.get(key)
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    return [raw]


def _benchmark_item_sources(item: dict[str, Any]) -> set[str]:
    """Read only an item's explicitly isolated benchmark source ids.

    Evidence may expose isolated ids on the nested benchmark item.  The
    current single-item shape also exposes the complete calculation source
    set on the item itself; callers handle that legacy shape strictly (the
    submitted ids must equal the complete set) so a target quote alone cannot
    claim the benchmark.
    """
    benchmark = item.get("benchmark")
    if isinstance(benchmark, dict):
        source_ids = benchmark.get("source_ids")
        if isinstance(source_ids, list):
            return {sid for sid in source_ids if isinstance(sid, str)}
    source_ids = item.get("benchmark_source_ids")
    if isinstance(source_ids, list):
        return {sid for sid in source_ids if isinstance(sid, str)}
    source_ids = item.get("source_ids")
    if isinstance(source_ids, list):
        return {sid for sid in source_ids if isinstance(sid, str)}
    return set()


def _has_isolated_benchmark_sources(item: dict[str, Any]) -> bool:
    benchmark = item.get("benchmark")
    return (
        isinstance(benchmark, dict)
        and isinstance(benchmark.get("source_ids"), list)
    ) or isinstance(item.get("benchmark_source_ids"), list)


def _benchmark_windows(item: dict[str, Any]) -> list[dict[str, Any]]:
    windows = item.get("windows")
    if not isinstance(windows, list):
        windows = item.get("window_results")
    return [window for window in windows or [] if isinstance(window, dict)]


def _benchmark_fact(
    item: dict[str, Any], horizon: str
) -> dict[str, Any] | None:
    """Build one deterministic horizon benchmark from Evidence only."""
    if item.get("status") not in {"available", "degraded"}:
        return None
    expected_windows = _BENCHMARK_HORIZON_WINDOWS[horizon]
    supported = [
        window
        for window in _benchmark_windows(item)
        if window.get("window") in expected_windows
        and window.get("status") in {"available", "degraded"}
        and _finite_number(window.get("relative_return"))
    ]
    if not supported:
        return None
    window = max(supported, key=lambda value: value["window"])
    benchmark = item.get("benchmark")
    if not isinstance(benchmark, dict):
        return None
    source_ids = sorted(
        {
            source_id
            for source_id in window.get("source_ids") or _benchmark_item_sources(item)
            if isinstance(source_id, str)
        }
    )
    instrument_id = benchmark.get("instrument_id")
    name = benchmark.get("name")
    if not isinstance(instrument_id, str) or not isinstance(name, str) or not source_ids:
        return None
    relative_return = float(window["relative_return"])
    relative_view = (
        "outperform"
        if relative_return > 0
        else "underperform"
        if relative_return < 0
        else "inline"
    )
    return {
        "name": name,
        "instrument_id": instrument_id,
        "relative_view": relative_view,
        "basis": (
            f"Evidence {window['window']}日对齐收盘相对收益"
            f"={relative_return:.6g}%（{window.get('method') or item.get('method') or 'Evidence'}）"
        ),
        "source_ids": source_ids,
        # Keep the numeric comparison auditable instead of hiding it in prose.
        "evidence_window": window["window"],
        "relative_return": relative_return,
        "target_return": window.get("target_return"),
        "benchmark_return": window.get("benchmark_return"),
        "method": window.get("method") or item.get("method"),
        "market_as_of": window.get("market_as_of") or item.get("market_as_of"),
    }


def _validate_benchmarks(payload: Any, bundle: dict[str, Any]) -> str | None:
    """Require every declared comparison to match deterministic Evidence."""
    entries = _relative_benchmark_entries(bundle)
    for horizon in ("short_term", "medium_term", "long_term"):
        view = getattr(payload.horizon_views, horizon)
        benchmark = view.benchmark
        if benchmark.relative_view == "unknown":
            # The final materializer upgrades this to the deterministic
            # Evidence fact whenever the horizon has a usable window.
            continue
        matched = [
            item
            for item in entries
            if isinstance(item.get("benchmark"), dict)
            and item["benchmark"].get("instrument_id") == benchmark.instrument_id
        ]
        if not matched:
            return (
                f"Error: {horizon} non-unknown benchmark instrument_id must match "
                "an Evidence.relative_benchmarks item."
            )
        item = matched[0]
        item_status = item.get("status")
        if item_status not in {"available", "degraded"}:
            return (
                f"Error: {horizon} benchmark Evidence status must be available or degraded; "
                f"got {item_status or 'missing'}."
            )
        item_source_ids = _benchmark_item_sources(item)
        declared_source_ids = set(benchmark.source_ids)
        if not item_source_ids:
            return f"Error: {horizon} benchmark Evidence item has no source_ids."
        if _has_isolated_benchmark_sources(item):
            source_match = declared_source_ids <= item_source_ids
        else:
            # Legacy Evidence exposes target+benchmark calculation inputs on
            # the item.  Require the complete set instead of accepting a
            # target quote as if it proved the public benchmark.
            source_match = declared_source_ids == item_source_ids
        if not source_match:
            return (
                f"Error: {horizon} benchmark source_ids must come from the matched "
                "Evidence benchmark item."
            )
        fact = _benchmark_fact(item, horizon)
        if fact is None:
            return (
                f"Error: {horizon} benchmark comparison lacks an available/degraded "
                "Evidence window matching that horizon."
            )
        if benchmark.relative_view != fact["relative_view"]:
            return (
                f"Error: {horizon} benchmark relative_view must match Evidence "
                f"({fact['relative_view']})."
            )
        expected_windows = _BENCHMARK_HORIZON_WINDOWS[horizon]
        supported = [
            window
            for window in _benchmark_windows(item)
            if window.get("window") in expected_windows
            and window.get("status") in {"available", "degraded"}
            and _finite_number(window.get("relative_return"))
        ]
        if not supported:
            return (
                f"Error: {horizon} benchmark comparison lacks an available/degraded "
                "Evidence window matching that horizon."
            )
    return None


def _trusted_event_calendar(bundle: dict[str, Any]) -> dict[str, Any] | None:
    """Copy only cutoff-approved event evidence into a persisted report."""
    section = bundle.get("event_calendar")
    if not isinstance(section, dict):
        return None
    cutoff = bundle.get("research_cutoff_at")
    events: list[dict[str, Any]] = []
    missing_fields = [
        field for field in section.get("missing_fields") or [] if isinstance(field, str)
    ]
    for raw in section.get("events") or []:
        if not isinstance(raw, dict):
            continue
        # Evidence has already applied this gate; repeat it at the report
        # boundary so stale/hand-edited bundles cannot leak future events.
        if compare_asia_datetime(raw.get("published_at"), cutoff) is not True:
            continue
        event = {field: raw.get(field) for field in _EVENT_FIELDS}
        # An undated announcement is published evidence, not an upcoming
        # event.  Never let a missing event_date become an upcoming status.
        if event.get("event_date") is None and event.get("status") == "upcoming":
            event["status"] = "published"
            if "event_date" not in missing_fields:
                missing_fields.append("event_date")
        events.append(event)
    return {
        "status": section.get("status") or ("available" if events else "missing"),
        "events": events,
        "missing_fields": list(dict.fromkeys(missing_fields)),
    }


def _resolve_trusted_event_sources(
    bundle: dict[str, Any], event_calendar: dict[str, Any]
) -> tuple[list[str], list[dict[str, Any]], str | None]:
    """Resolve injected event citations against this symbol's Evidence only."""
    source_by_id = {
        source.get("id"): source
        for source in bundle.get("sources") or []
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    source_ids: list[str] = []
    resolved: list[dict[str, Any]] = []
    for index, event in enumerate(event_calendar.get("events") or []):
        event_source_ids = event.get("source_ids")
        if not isinstance(event_source_ids, list) or not event_source_ids:
            return [], [], (
                "Error: trusted event_calendar event "
                f"{index} has no source_ids."
            )
        for source_id in event_source_ids:
            if not isinstance(source_id, str) or not source_id:
                return [], [], (
                    "Error: trusted event_calendar event "
                    f"{index} contains an invalid source_id."
                )
            source = source_by_id.get(source_id)
            if source is None:
                return [], [], (
                    "Error: trusted event_calendar event "
                    f"{index} source {source_id!r} is not in this instrument's Evidence."
                )
            if source_id not in source_ids:
                source_ids.append(source_id)
                resolved.append(source)
    return source_ids, resolved, None


def _validate_report_refs(
    workspace: Path, run_id: str, payload: Any
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate all V4 citations, metric refs and deterministic coverage gates."""
    instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
    bundle, error = _load_report_bundle(workspace, run_id, instrument_id)
    if error is not None or bundle is None:
        return None, error
    coverage = bundle.get("evidence_coverage") or {}
    dimension_error = _validate_dimension_views(payload, bundle)
    if dimension_error is not None:
        return None, dimension_error
    benchmark_error = _validate_benchmarks(payload, bundle)
    if benchmark_error is not None:
        return None, benchmark_error
    debate_error = _validate_debate_resolution_coverage_gate(payload, bundle)
    if debate_error is not None:
        return None, debate_error
    short_trigger_error = _validate_short_term_triggers(payload, bundle)
    if short_trigger_error is not None:
        return None, short_trigger_error
    for horizon in ("short_term", "medium_term", "long_term"):
        view = getattr(payload.horizon_views, horizon)
        status = (coverage.get(horizon) or {}).get("status")
        if status == "insufficient_data" and view.stance != "insufficient_data":
            return None, (
                f"Error: {horizon} coverage is insufficient_data; "
                "submit that horizon with stance=insufficient_data."
            )
    for condition in _iter_report_conditions(payload):
        if condition.kind != "trigger":
            continue
        refs = [condition.observed_metric_ref]
        if condition.threshold_metric_ref is not None:
            refs.append(condition.threshold_metric_ref)
        for field_ref in refs:
            value = _evidence_path_value(bundle, field_ref)
            if value is _MISSING:
                return None, f"Error: Evidence field {field_ref!r} not found in run {run_id}."
            if not _finite_number(value):
                return None, (
                    f"Error: Evidence field {field_ref!r} must resolve to a finite numeric value."
                )
    return bundle, None


def _validate_short_term_triggers(payload: Any, bundle: dict[str, Any]) -> str | None:
    """Require machine-readable short-term guards when numeric Evidence exists."""
    if not _finite_number(_evidence_path_value(bundle, "quote.price")):
        return None
    threshold_paths = (
        "indicators.swing.support",
        "indicators.swing.resistance",
        "indicators.ma5",
        "indicators.ma10",
        "indicators.ma20",
    )
    if not any(_finite_number(_evidence_path_value(bundle, path)) for path in threshold_paths):
        return None
    view = payload.horizon_views.short_term
    groups = (
        ("confirmation_conditions", view.confirmation_conditions),
        ("watch_conditions", view.watch_conditions),
        ("invalidation_conditions", view.invalidation_conditions),
    )
    for name, conditions in groups:
        if not any(condition.kind == "trigger" for condition in conditions):
            return (
                "Error: short_term "
                f"{name} requires at least one Evidence-backed trigger when "
                "quote.price and technical thresholds are available."
            )
    return None


def _validate_dimension_views(payload: Any, bundle: dict[str, Any]) -> str | None:
    """Enforce the report contract without letting missing evidence look usable."""
    dimensions = payload.dimension_views
    if dimensions is None:
        return "Error: new Report V4 requires all eight dimension_views."
    coverage = bundle.get("evidence_coverage") or {}
    evidence_sections = {
        "market_environment": bundle.get("market_regime"),
        "industry": bundle.get("industry_context"),
        "policy": bundle.get("policy_context"),
        "cycle": bundle.get("cycle_context"),
        "company_quality": bundle.get("company_quality"),
        "valuation": (bundle.get("company_quality") or {}).get("valuation_context"),
        "capital_positioning": bundle.get("capital_positioning"),
        "event_risk": bundle.get("event_calendar"),
    }
    for key in ANALYSIS_DIMENSION_KEYS:
        view = getattr(dimensions, key)
        if view.status == "available" and not (view.facts or view.inferences):
            return f"Error: dimension_views.{key} cannot be available without fact/inference points."
        section = evidence_sections[key]
        allowed_source_ids = {
            sid
            for sid in (section or {}).get("source_ids") or []
            if isinstance(sid, str)
        } if isinstance(section, dict) else set()
        cited_source_ids = set(view.all_source_ids())
        forged_section_sources = sorted(cited_source_ids - allowed_source_ids)
        if forged_section_sources:
            return (
                f"Error: dimension_views.{key} cites sources outside its Evidence section: "
                + ", ".join(forged_section_sources)
            )
        if view.status == "available" and (
            not isinstance(section, dict) or section.get("status") == "missing"
        ):
            return (
                f"Error: dimension_views.{key} is available while its Evidence section "
                "is missing."
            )
    for horizon, required in _HORIZON_DIMENSIONS.items():
        view = getattr(payload.horizon_views, horizon)
        missing_keys = [key for key in required if key not in view.dimension_keys]
        if missing_keys:
            return (
                f"Error: {horizon} dimension_keys omit required analysis dimensions: "
                + ", ".join(missing_keys)
            )
        coverage_info = coverage.get(horizon) or {}
        coverage_status = coverage_info.get("status")
        if view.status != "available":
            continue
        if coverage_status == "degraded":
            degraded_sections = list(dict.fromkeys(
                (coverage_info.get("missing_sections") or [])
                + (coverage_info.get("degraded_sections") or [])
            ))
            if view.data_status != "degraded":
                return (
                    f"Error: {horizon} coverage is degraded; "
                    "data_status must be degraded and missing_fields must disclose the gap."
                )
            disclosed = set(view.missing_fields)
            undisclosed = [
                section
                for section in degraded_sections
                if section not in disclosed
                and _COVERAGE_DISCLOSURE_ALIASES.get(section) not in disclosed
            ]
            if undisclosed:
                return (
                    f"Error: {horizon} coverage is degraded; disclose missing sections in "
                    "missing_fields: " + ", ".join(undisclosed)
                )
        unavailable = [
            key
            for key in required
            if getattr(dimensions, key).status in {"missing", "degraded"}
        ]
        if unavailable:
            missing_fields = set(view.missing_fields)
            if view.data_status != "degraded":
                return (
                    f"Error: {horizon} has degraded dimensions but data_status is not degraded: "
                    + ", ".join(unavailable)
                )
            undisclosed = [key for key in unavailable if key not in missing_fields]
            if undisclosed:
                return (
                    f"Error: {horizon} must disclose degraded dimensions in missing_fields: "
                    + ", ".join(undisclosed)
                )
        if coverage_status == "insufficient_data":
            return (
                f"Error: {horizon} coverage is insufficient_data; "
                "submit that horizon with stance/status=insufficient_data."
            )
    return None


def _materialize_horizon_views(payload: Any, bundle: dict[str, Any]) -> dict[str, Any]:
    """Persist benchmark facts even when the horizon stance is insufficient."""
    data = payload.horizon_views.model_dump()
    entries = _relative_benchmark_entries(bundle)
    for horizon in ("short_term", "medium_term", "long_term"):
        view = data[horizon]
        item = next(
            (
                candidate
                for candidate in entries
                if isinstance(candidate.get("benchmark"), dict)
                and isinstance(candidate["benchmark"].get("instrument_id"), str)
            ),
            None,
        )
        if item is None:
            continue
        fact = _benchmark_fact(item, horizon)
        if fact is not None:
            view["benchmark"] = fact
    return data


_TRUSTED_DIMENSION_STATUSES = frozenset({"available", "degraded", "missing"})
_PUBLIC_DISCLOSURE_EVENT_TYPES = frozenset({
    "share_unlock",
    "share_reduction",
    "share_pledge",
})


def _trusted_dimension_status(section: Any) -> str:
    status = section.get("status") if isinstance(section, dict) else None
    return status if isinstance(status, str) and status in _TRUSTED_DIMENSION_STATUSES else "missing"


def _trusted_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _trusted_number(value: Any) -> float | int | None:
    return value if _finite_number(value) else None


def _trusted_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _projection_missing(section: Any, fields: list[str]) -> list[str]:
    existing = [
        field
        for field in (section.get("missing_fields") if isinstance(section, dict) else []) or []
        if isinstance(field, str) and field
    ]
    return list(dict.fromkeys(existing + [field for field in fields if field not in existing]))


def _materialize_market_breadth(section: Any) -> dict[str, Any]:
    section = section if isinstance(section, dict) else {}
    breadth = section.get("breadth") if isinstance(section.get("breadth"), dict) else {}
    raw_coverage = section.get("coverage")
    raw_coverage = raw_coverage if isinstance(raw_coverage, dict) else {}
    coverage = {
        "complete": raw_coverage.get("complete") if isinstance(raw_coverage.get("complete"), bool) else None,
        "loaded_count": _trusted_nonnegative_int(raw_coverage.get("loaded_count")),
        "expected_count": _trusted_nonnegative_int(raw_coverage.get("expected_count")),
        "coverage": _trusted_number(raw_coverage.get("coverage")),
    }
    values = {
        "member_count": _trusted_nonnegative_int(section.get("member_count")),
        "available_change_count": _trusted_nonnegative_int(section.get("available_change_count")),
        "advancing": _trusted_nonnegative_int(breadth.get("advancing")),
        "declining": _trusted_nonnegative_int(breadth.get("declining")),
        "unchanged": _trusted_nonnegative_int(breadth.get("unchanged")),
        "suspended": _trusted_nonnegative_int(breadth.get("suspended")),
        "advance_ratio": _trusted_number(breadth.get("advance_ratio")),
        "turnover_amount": _trusted_number(section.get("turnover_amount")),
        "observed_at": _trusted_text(section.get("observed_at")),
        "basis": _trusted_text(section.get("basis")),
        "method": _trusted_text(section.get("method")),
    }
    missing = _projection_missing(
        section,
        [
            field for field, value in values.items()
            if value is None
        ]
        + [
            f"coverage.{field}"
            for field in ("complete", "loaded_count", "expected_count")
            if coverage[field] is None
        ],
    )
    return {
        "status": _trusted_dimension_status(section),
        **values,
        "coverage": coverage,
        "missing_fields": missing,
    }


def _materialize_public_activity(section: Any) -> dict[str, Any]:
    section = section if isinstance(section, dict) else {}
    values = {
        "turnover": _trusted_number(section.get("turnover")),
        "turnover_rate": _trusted_number(section.get("turnover_rate")),
        "volume": _trusted_number(section.get("volume")),
        "price_change_pct": _trusted_number(section.get("price_change_pct")),
        "volume_change_pct_5d": _trusted_number(section.get("volume_change_pct_5d")),
        "observed_at": _trusted_text(section.get("observed_at")),
        "basis": _trusted_text(section.get("basis")),
        "method": _trusted_text(section.get("method")),
    }
    disclosure_signals: list[dict[str, Any]] = []
    untraceable_disclosure = False
    raw_signals = section.get("disclosure_signals")
    for raw_signal in raw_signals if isinstance(raw_signals, list) else []:
        if not isinstance(raw_signal, dict):
            continue
        if raw_signal.get("event_type") not in _PUBLIC_DISCLOSURE_EVENT_TYPES:
            continue
        source_ids = raw_signal.get("source_ids")
        if not isinstance(source_ids, list) or not source_ids or not all(
            isinstance(source_id, str) and source_id for source_id in source_ids
        ):
            untraceable_disclosure = True
            continue
        disclosure_signals.append({
            field: raw_signal.get(field)
            for field in (
                "event_type", "title", "published_at", "event_date",
                "status", "url", "source_ids",
            )
            if raw_signal.get(field) is not None
        })
    missing = _projection_missing(
        section,
        [field for field, value in values.items() if value is None]
        + (["disclosure_signals.source_ids"] if untraceable_disclosure else []),
    )
    return {
        "status": _trusted_dimension_status(section),
        **values,
        "disclosure_signals": disclosure_signals,
        "missing_fields": missing,
    }


def _materialize_dimension_views(
    payload: Any, bundle: dict[str, Any], sources: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Attach trusted report/source timing; ignore model-supplied timestamps."""
    source_by_id = {source.get("id"): source for source in sources if source.get("id")}
    evidence_sections = {
        "market_environment": bundle.get("market_regime"),
        "industry": bundle.get("industry_context"),
        "policy": bundle.get("policy_context"),
        "cycle": bundle.get("cycle_context"),
        "company_quality": bundle.get("company_quality"),
        "valuation": (bundle.get("company_quality") or {}).get("valuation_context"),
        "capital_positioning": bundle.get("capital_positioning"),
        "event_risk": bundle.get("event_calendar"),
    }
    result: dict[str, dict[str, Any]] = {}
    for key in ANALYSIS_DIMENSION_KEYS:
        view = getattr(payload.dimension_views, key)
        data = view.model_dump()
        section = evidence_sections[key]
        section_source_ids = (
            [sid for sid in (section or {}).get("source_ids") or [] if isinstance(sid, str)]
            if isinstance(section, dict)
            else []
        )
        materialized_source_ids = list(dict.fromkeys(view.all_source_ids() + section_source_ids))
        data["source_ids"] = materialized_source_ids
        cited = [source_by_id[sid] for sid in materialized_source_ids if sid in source_by_id]
        published = sorted(
            source.get("published_at") for source in cited if source.get("published_at")
        )
        periods = sorted(
            (source.get("period_end") for source in cited if source.get("period_end")),
        )
        data["research_cutoff_at"] = bundle.get("research_cutoff_at")
        data["market_as_of"] = bundle.get("market_as_of")
        data["published_at"] = published[-1] if published else None
        data["period_end"] = periods[-1] if periods else None
        if isinstance(section, dict):
            if section.get("status") in {"missing", "degraded"}:
                data["status"] = section["status"]
            data["missing_fields"] = list(
                dict.fromkeys(
                    (data.get("missing_fields") or [])
                    + (section.get("missing_fields") or [])
                )
            )
        if key == "market_environment":
            data["market_breadth"] = _materialize_market_breadth(section)
        elif key == "capital_positioning":
            data["public_activity"] = _materialize_public_activity(section)
        if key == "valuation" and isinstance(section, dict):
            valuation_metrics: dict[str, Any] = {
                "comparison_method": section.get("method"),
                "comparison_basis": section.get("basis"),
                "comparison_as_of": section.get("as_of"),
                "peer_comparison_status": "insufficient_data",
                "missing_reasons": [],
            }
            trusted_facts: list[dict[str, Any]] = []
            metric_labels = (("pe", "市盈率（PE）"), ("pb", "市净率（PB）"))
            current_values: dict[str, bool] = {}
            peer_values: dict[str, bool] = {}
            for metric_name, label in metric_labels:
                metric = section.get(metric_name)
                metric = metric if isinstance(metric, dict) else {}
                value = metric.get("value") if isinstance(metric, dict) else None
                current_values[metric_name] = _finite_number(value)
                peer_values[metric_name] = (
                    _finite_number(metric.get("median"))
                    and _finite_number(metric.get("percentile"))
                    and isinstance(metric.get("peer_count"), int)
                    and metric.get("peer_count") > 0
                )
                valuation_metrics[f"{metric_name}_peer_count"] = metric.get("peer_count")
                valuation_metrics[f"{metric_name}_median"] = metric.get("median")
                valuation_metrics[f"{metric_name}_percentile"] = metric.get("percentile")
                if not _finite_number(value):
                    valuation_metrics["missing_reasons"].append(f"{label}当前值缺失")
                    continue
                valuation_metrics[f"current_{metric_name}"] = value
                trusted_facts.append(
                    {
                        "claim": f"当前{label}={value}",
                        "evidence": f"Evidence.company_quality.valuation_context.{metric_name}",
                        "claim_type": "fact",
                        "basis": None,
                        "source_ids": section_source_ids,
                    }
                )
                if not peer_values[metric_name]:
                    valuation_metrics["missing_reasons"].append(
                        f"{label}同行比较数据不足，不能判断相对高低"
                    )
            peer_complete = all(peer_values.values())
            current_complete = all(current_values.values())
            valuation_metrics["peer_comparison_status"] = (
                "complete" if peer_complete and current_complete else "insufficient_data"
            )
            data["valuation_metrics"] = valuation_metrics
            if current_complete and peer_complete:
                data["missing_fields"] = [
                    field
                    for field in data.get("missing_fields") or []
                    if field not in {"current_pe", "current_pb", "peer_valuation"}
                ]
            else:
                missing_fields = list(data.get("missing_fields") or [])
                for metric_name, _label in metric_labels:
                    if not current_values[metric_name] and f"current_{metric_name}" not in missing_fields:
                        missing_fields.append(f"current_{metric_name}")
                if "peer_valuation" not in missing_fields:
                    missing_fields.append("peer_valuation")
                data["missing_fields"] = missing_fields
                if current_values["pe"] or current_values["pb"] or data.get("status") != "missing":
                    data["status"] = "degraded"
                data["summary"] = (
                    f"当前估值快照：PE={valuation_metrics.get('current_pe', '未提供')}、"
                    f"PB={valuation_metrics.get('current_pb', '未提供')}；"
                    "同行估值比较缺失，暂不作分位判断。"
                )
            if trusted_facts:
                facts = list(data.get("facts") or [])
                facts.extend(trusted_facts)
                data["facts"] = facts
                data["points"] = facts + list(data.get("inferences") or []) + list(
                    data.get("hypotheses") or []
                )
        result[key] = data
    return result


def _derived_conflict_status(payload: Any) -> str:
    stances = [
        payload.horizon_views.short_term.stance,
        payload.horizon_views.medium_term.stance,
        payload.horizon_views.long_term.stance,
    ]
    if all(stance == "insufficient_data" for stance in stances):
        return "insufficient_data"
    return "aligned" if len(set(stances)) == 1 else "mixed"


def _outcome_tracking_id(run_id: str, instrument_id: str) -> str:
    digest = hashlib.sha256(f"{run_id}:{instrument_id}".encode("utf-8")).hexdigest()
    return f"stock_outcome_{digest[:24]}"


def _iter_nested_source_ids(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "sources":
                continue
            if key == "source_ids" and isinstance(child, list):
                yield from (source_id for source_id in child if isinstance(source_id, str))
                continue
            yield from _iter_nested_source_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_nested_source_ids(child)


def _complete_report_source_closure(
    workspace: Path,
    run_id: str,
    doc: dict[str, Any],
    cited: list[str],
    sources: list[dict[str, Any]],
) -> tuple[list[str], list[dict[str, Any]], str | None]:
    """Resolve every nested report source id, including trusted injections."""
    all_source_ids = list(dict.fromkeys(cited + list(_iter_nested_source_ids(doc))))
    known = {source.get("id") for source in sources if source.get("id")}
    missing = [source_id for source_id in all_source_ids if source_id not in known]
    if missing:
        extra, error = _resolve_sources(workspace, run_id, missing)
        if error is not None:
            return [], [], error
        sources = sources + extra
    return all_source_ids, sources, None


def _quant_snapshot_digest(snapshot: Mapping[str, Any]) -> str:
    """Hash the immutable quant snapshot used by direct research."""
    canonical = json.dumps(
        snapshot,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _trusted_quant_validation(bundle: dict[str, Any]) -> dict[str, Any] | None:
    """Accept only the system-generated quant payload copied by run_init.

    Selection-origin evidence already carries the normalized provenance
    contract. Direct research carries the candidate validation beside its
    immutable ``quant_snapshot``; the missing identity/method fields are
    filled only from that snapshot, never from the chairman's submission.
    """
    raw_quant = bundle.get("quant_validation")
    if not isinstance(raw_quant, dict):
        return None
    quant = deepcopy(raw_quant)
    snapshot = bundle.get("quant_snapshot")
    has_selection_identity = any(
        field in quant for field in ("selection_run_id", "selection_report_id")
    )
    if has_selection_identity and not all(
        isinstance(quant.get(field), str) and quant.get(field)
        for field in ("selection_run_id", "selection_report_id")
    ):
        return None
    if not has_selection_identity:
        if not isinstance(snapshot, dict):
            return None
        for field in (
            "strategy_id",
            "as_of",
            "factor_algorithm_version",
            "rank_algorithm_version",
        ):
            if field not in quant:
                quant[field] = snapshot.get(field)
        quant.setdefault("snapshot_hash", _quant_snapshot_digest(snapshot))
        quant.setdefault("reason", quant.get("promotion_reason") or snapshot.get("reason"))
        nested_ids = set(_iter_nested_source_ids(quant))
        snapshot_ids = snapshot.get("source_ids")
        raw_source_ids = quant.get("source_ids")
        if raw_source_ids is not None and (
            not isinstance(raw_source_ids, list)
            or any(not isinstance(item, str) or not item for item in raw_source_ids)
        ):
            return None
        if snapshot_ids is not None and (
            not isinstance(snapshot_ids, list)
            or any(not isinstance(item, str) or not item for item in snapshot_ids)
        ):
            return None
        quant["source_ids"] = sorted(
            {
                source_id
                for source_id in [*(quant.get("source_ids") or []), *(snapshot_ids or [])]
                if isinstance(source_id, str) and source_id
            }
            | nested_ids
        )
    if isinstance(snapshot, dict):
        registry = snapshot.get("method_registry")
        if isinstance(registry, dict):
            quant.setdefault("method_registry", deepcopy(registry))
            horizons = quant.get("horizons")
            if isinstance(horizons, dict):
                for horizon, item in list(horizons.items()):
                    method = registry.get(horizon)
                    if not isinstance(item, dict) or not isinstance(method, dict):
                        continue
                    enriched = dict(item)
                    enriched.setdefault("method_id", method.get("methodId"))
                    enriched.setdefault("method_version", method.get("version"))
                    enriched.setdefault("target_window_sessions", method.get("targetWindowSessions"))
                    enriched.setdefault("target_definition", method.get("targetDefinition"))
                    horizons[horizon] = enriched
    allowed = {
        "selection_run_id",
        "selection_report_id",
        "strategy_id",
        "as_of",
        "factor_algorithm_version",
        "rank_algorithm_version",
        "validation_status",
        "quant_signal",
        "horizons",
        "source_ids",
        "snapshot_hash",
        "reason",
        "source_closure_missing",
        "promotion_status",
        "promotion_reason",
        "eligible_for_trading",
        "validation_metrics",
        "strategy_horizon",
        "calibrated_horizon",
        "method_registry",
        "target_windows",
        "target_window_sessions",
        "target_definition",
    }
    if set(quant) - allowed:
        return None
    required_text_fields = (
        "strategy_id",
        "factor_algorithm_version",
        "rank_algorithm_version",
        "snapshot_hash",
        "reason",
    )
    if any(not isinstance(quant.get(field), str) or not quant.get(field) for field in required_text_fields):
        return None
    if has_selection_identity and any(
        not isinstance(quant.get(field), str) or not quant.get(field)
        for field in ("selection_run_id", "selection_report_id")
    ):
        return None
    if quant.get("as_of") is not None and not isinstance(quant.get("as_of"), str):
        return None
    horizons = quant.get("horizons")
    if not isinstance(horizons, dict) or not horizons or not set(horizons) <= set(_V5_HORIZONS):
        return None
    scoped_horizon = quant.get("strategy_horizon") or quant.get("calibrated_horizon")
    if scoped_horizon is None and set(horizons) != set(_V5_HORIZONS):
        return None
    if scoped_horizon is not None and (
        scoped_horizon not in _V5_HORIZONS
        or scoped_horizon not in horizons
        or quant.get("strategy_horizon") != quant.get("calibrated_horizon")
    ):
        return None
    if quant.get("source_closure_missing") is not None and (
        not isinstance(quant.get("source_closure_missing"), list)
        or any(
            not isinstance(item, str)
            for item in quant.get("source_closure_missing") or []
        )
    ):
        return None
    source_ids = quant.get("source_ids")
    if not isinstance(source_ids, list) or any(
        not isinstance(item, str) or not item for item in source_ids
    ):
        return None
    source_by_id: dict[str, dict[str, Any]] = {}
    for source in bundle.get("sources") or []:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str):
            continue
        try:
            normalized_source = SourceRecord.model_validate(source).model_dump(mode="json")
        except (TypeError, ValueError):
            return None
        source_id = source["id"]
        previous = source_by_id.get(source_id)
        if previous is not None and previous != normalized_source:
            return None
        source_by_id[source_id] = normalized_source
    if not set(source_ids) <= set(source_by_id):
        return None
    nested_source_ids = set(_iter_nested_source_ids(quant))
    if not nested_source_ids <= set(source_by_id):
        return None
    if quant.get("validation_status") not in {
        "uncalibrated",
        "support",
        "unconfirmed",
        "oppose",
        "insufficient_data",
    }:
        return None
    if quant.get("quant_signal") not in {
        "positive",
        "neutral",
        "negative",
        "insufficient_data",
    }:
        return None
    if any(
        field in quant
        for field in (
            "promotion_status",
            "promotion_reason",
            "eligible_for_trading",
            "validation_metrics",
        )
    ):
        if quant.get("promotion_status") not in {"research_only", "calibrated", "rejected"}:
            return None
        if not isinstance(quant.get("promotion_reason"), str) or not quant.get("promotion_reason"):
            return None
        if not isinstance(quant.get("eligible_for_trading"), bool):
            return None
        metrics = quant.get("validation_metrics")
        if not isinstance(metrics, dict):
            return None
        if quant.get("promotion_status") == "calibrated":
            scope = metrics.get("sampleScope", metrics.get("sample_scope"))
            coverage = metrics.get(
                "universeCoverage",
                metrics.get("universe_coverage", metrics.get("coverage")),
            )
            coverage_status = metrics.get("status", metrics.get("coverageStatus"))
            if scope not in {
                "full_universe",
                "complete_eligible_universe",
                "full_eligible_universe",
            }:
                return None
            if not isinstance(coverage, (int, float)) or isinstance(coverage, bool) or coverage < 0.8:
                return None
            if coverage_status in {"rejected", "not_evaluable", "unavailable"}:
                return None
            if quant.get("eligible_for_trading") is not True:
                return None
            for field in ("strategy_horizon", "calibrated_horizon"):
                value = quant.get(field)
                if value is not None and value not in _V5_HORIZONS:
                    return None
            if (
                (quant.get("strategy_horizon") is not None or quant.get("calibrated_horizon") is not None)
                and quant.get("strategy_horizon") != quant.get("calibrated_horizon")
            ):
                return None
    return deepcopy(quant)


def _trusted_quant_promotion_sidecar(bundle: Mapping[str, Any]) -> dict[str, Any] | None:
    """Validate a scoped promotion sidecar without inventing factor observations."""
    raw = bundle.get("quant_validation")
    if not isinstance(raw, Mapping):
        return None
    required = ("promotion_status", "promotion_reason", "eligible_for_trading", "validation_metrics")
    if any(field not in raw for field in required):
        return None
    status = raw.get("promotion_status")
    reason = raw.get("promotion_reason")
    eligible = raw.get("eligible_for_trading")
    metrics = raw.get("validation_metrics")
    if status not in {"research_only", "calibrated", "rejected"}:
        return None
    if not isinstance(reason, str) or not reason.strip() or not isinstance(eligible, bool):
        return None
    if eligible != (status == "calibrated") or not isinstance(metrics, Mapping):
        return None
    strategy_horizon = raw.get("strategy_horizon")
    calibrated_horizon = raw.get("calibrated_horizon")
    if strategy_horizon is not None and strategy_horizon not in _V5_HORIZONS:
        return None
    if calibrated_horizon is not None and calibrated_horizon not in _V5_HORIZONS:
        return None
    if strategy_horizon != calibrated_horizon:
        return None
    source_ids = raw.get("source_ids", [])
    if not isinstance(source_ids, list) or any(not isinstance(item, str) or not item for item in source_ids):
        return None
    target_source_ids = {
        source.get("id")
        for source in bundle.get("sources") or []
        if isinstance(source, Mapping) and isinstance(source.get("id"), str)
    }
    if not set(source_ids) <= target_source_ids:
        return None
    return {
        "promotion_status": status,
        "promotion_reason": reason,
        "eligible_for_trading": eligible,
        "validation_metrics": dict(metrics),
        "strategy_horizon": strategy_horizon,
        "calibrated_horizon": calibrated_horizon,
        "source_ids": list(dict.fromkeys(source_ids)),
    }


_V5_HORIZONS = ("short_term", "medium_term", "long_term")


def _v5_submission_gap_error(payload: Any) -> str | None:
    """Reject incomplete-state wording with the exact model field path."""
    def forbidden_term(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        folded = value.casefold()
        return next(
            (term for term in V5_FORBIDDEN_TERMS if term.casefold() in folded),
            None,
        )

    checks: list[tuple[str, Any]] = [("summary", payload.summary)]
    for horizon in _V5_HORIZONS:
        decision = getattr(payload.horizon_decisions, horizon)
        prefix = f"horizon_decisions.{horizon}"
        checks.append((f"{prefix}.thesis", decision.thesis))
        for field in ("key_reasons", "key_risks"):
            for index, point in enumerate(getattr(decision, field)):
                for text_field in ("claim", "evidence", "basis"):
                    value = getattr(point, text_field, None)
                    if value is not None:
                        checks.append(
                            (f"{prefix}.{field}[{index}].{text_field}", value)
                        )
    for path, value in checks:
        term = forbidden_term(value)
        if term is not None:
            return (
                f"Error: V5 forbidden gap term {term!r} at {path}; "
                "replace it with a complete conclusion."
            )
    return None


def _v6_submission_gap_error(payload: Any) -> str | None:
    decisions = payload.v6_horizon_decisions
    if decisions is None:
        return "Error: V6 horizon decisions are missing."
    checks: list[tuple[str, Any]] = [("summary", payload.summary)]
    for horizon in _V5_HORIZONS:
        decision = getattr(decisions, horizon)
        if decision is None:
            continue
        prefix = f"horizon_decisions.{horizon}"
        checks.append((f"{prefix}.thesis", decision.thesis))
        for field in ("key_reasons", "key_risks"):
            for index, point in enumerate(getattr(decision, field)):
                for text_field in ("claim", "evidence", "basis"):
                    value = getattr(point, text_field, None)
                    if value is not None:
                        checks.append((f"{prefix}.{field}[{index}].{text_field}", value))
    for path, value in checks:
        if not isinstance(value, str):
            continue
        folded = value.casefold()
        term = next(
            (candidate for candidate in V5_FORBIDDEN_TERMS if candidate.casefold() in folded),
            None,
        )
        if term is not None:
            return f"Error: V6 forbidden gap term {term!r} at {path}; replace it with a complete conclusion."
    return None


def _v6_required_for_stock_run(
    workspace: Path, run_id: str, room_id: str | None,
) -> tuple[bool, str | None]:
    """Return the V6 contract for a persisted stock deep-research run.

    The workflow snapshot is the trust boundary: the active pack may change
    after a run starts, but a run must never silently change report schema.
    Non-stock and legacy test runs remain compatible with their historical
    submission contracts.
    """
    if room_id != _STOCK_RESEARCH_ROOM_ID:
        return False, None
    try:
        run_dir = WorkflowRunStore.default_dir(workspace)
        run = WorkflowRunStore(run_dir).load(run_id)
    except Exception as exc:
        return True, (
            "错误：无法确认本次股票深度投研的报告版本，已阻止提交；"
            f"请重试本次投研（{exc}）。"
        )
    step_ids = {step.id for step in run.workflow.steps}
    if not _STOCK_DEEP_RESEARCH_STEP_IDS.issubset(step_ids):
        # Daily review and stock selection use this room too, but are not
        # deep-research reports and must retain their own submission modes.
        return False, None
    return True, None


def _trusted_v5_derived_metrics(
    bundle: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate the deterministic V5 injection boundary from Evidence."""
    derived = bundle.get("derived_decision_metrics")
    if not isinstance(derived, dict):
        return None, "Error: current Evidence has no derived_decision_metrics for V5."
    methods = derived.get("method_versions")
    if not isinstance(methods, dict) or any(
        not isinstance(methods.get(key), str) or not methods.get(key)
        for key in ("decision", "indicators", "conditions")
    ):
        return None, "Error: derived_decision_metrics.method_versions is incomplete."
    generated_at = derived.get("generated_at")
    if not isinstance(generated_at, str) or not generated_at:
        return None, "Error: derived_decision_metrics.generated_at is required."
    try:
        source_ids = derived.get("source_ids")
        if not isinstance(source_ids, list) or not source_ids or any(
            not isinstance(source_id, str) or not source_id for source_id in source_ids
        ):
            return None, "Error: derived_decision_metrics.source_ids is incomplete."
        horizons = derived.get("horizons")
        if not isinstance(horizons, dict):
            return None, "Error: derived_decision_metrics.horizons is required."
        validated: dict[str, Any] = {
            "schema_version": derived.get("schema_version", 1),
            "generated_at": generated_at,
            "method_versions": dict(methods),
            "source_ids": list(dict.fromkeys(source_ids)),
            "horizons": {},
        }
        for horizon in _V5_HORIZONS:
            item = horizons.get(horizon)
            if not isinstance(item, dict):
                return None, f"Error: derived_decision_metrics.horizons.{horizon} is required."
            if set(item) - {
                "trading_plan",
                "position_plan",
                "valid_until",
                "review_trigger",
                "evidence_strength",
                "source_ids",
            }:
                return None, f"Error: derived_decision_metrics.{horizon} has unknown fields."
            trading_plan = V5TradingPlan.model_validate(item.get("trading_plan"))
            position_plan = V5PositionPlan.model_validate(item.get("position_plan"))
            valid_until = item.get("valid_until")
            review_trigger = item.get("review_trigger")
            evidence_strength = item.get("evidence_strength")
            horizon_source_ids = item.get("source_ids") or []
            if not isinstance(valid_until, str) or not valid_until:
                return None, f"Error: derived_decision_metrics.{horizon}.valid_until is required."
            if not isinstance(review_trigger, str) or not review_trigger.strip():
                return None, f"Error: derived_decision_metrics.{horizon}.review_trigger is required."
            if evidence_strength not in {"strong", "medium", "weak"}:
                return None, f"Error: derived_decision_metrics.{horizon}.evidence_strength is invalid."
            if not isinstance(horizon_source_ids, list) or any(
                not isinstance(source_id, str) or not source_id for source_id in horizon_source_ids
            ):
                return None, f"Error: derived_decision_metrics.{horizon}.source_ids is invalid."
            validated["horizons"][horizon] = {
                "trading_plan": trading_plan.model_dump(mode="json"),
                "position_plan": position_plan.model_dump(mode="json"),
                "valid_until": valid_until,
                "review_trigger": review_trigger,
                "evidence_strength": evidence_strength,
                "source_ids": list(dict.fromkeys(horizon_source_ids)),
            }
        return validated, None
    except (TypeError, ValueError, ValidationError) as exc:
        return None, f"Error: invalid derived_decision_metrics: {exc}"


def _build_v5_report(
    workspace: Path,
    run_id: str,
    payload: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
    bundle, error = _load_report_bundle(workspace, run_id, instrument_id)
    if error is not None or bundle is None:
        return None, error or "Error: instrument Evidence is unavailable."
    derived, error = _trusted_v5_derived_metrics(bundle)
    if error is not None or derived is None:
        return None, error or "Error: deterministic V5 metrics are unavailable."
    target_sources = {
        source.get("id"): source
        for source in bundle.get("sources") or []
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    submitted_source_ids = payload.all_source_ids()
    derived_source_ids = list(derived["source_ids"])
    for item in derived["horizons"].values():
        derived_source_ids.extend(item["source_ids"])
        plan = item["trading_plan"]
        derived_source_ids.extend(plan["source_ids"])
        for group in ("entry_conditions", "exit_conditions", "take_profit_conditions"):
            for condition in plan[group]:
                derived_source_ids.extend(condition["source_ids"])
    all_source_ids = list(dict.fromkeys(submitted_source_ids + derived_source_ids))
    missing_source_ids = sorted(set(all_source_ids) - set(target_sources))
    if missing_source_ids:
        return None, (
            "Error: V5 source_ids must belong to the target instrument Evidence: "
            + ", ".join(missing_source_ids)
        )
    final_horizons: dict[str, Any] = {}
    for horizon in _V5_HORIZONS:
        submitted = getattr(payload.horizon_decisions, horizon)
        item = derived["horizons"][horizon]
        final_data = submitted.model_dump(mode="json")
        final_data.update(
            {
                "trading_plan": item["trading_plan"],
                "position_plan": item["position_plan"],
                "valid_until": item["valid_until"],
                "review_trigger": item["review_trigger"],
                "evidence_strength": item["evidence_strength"],
                "source_ids": list(dict.fromkeys(
                    final_data["source_ids"] + item["source_ids"]
                )),
            }
        )
        try:
            final_horizons[horizon] = V5HorizonDecision.model_validate(final_data).model_dump(mode="json")
        except (TypeError, ValueError, ValidationError) as exc:
            return None, f"Error: invalid V5 {horizon} decision: {exc}"
    research_cutoff_at = bundle.get("research_cutoff_at")
    market_as_of = bundle.get("market_as_of")
    if not isinstance(research_cutoff_at, str) or not isinstance(market_as_of, str):
        return None, "Error: V5 Evidence requires research_cutoff_at and market_as_of."
    doc = {
        "schema_version": DECISION_REPORT_SCHEMA_VERSION,
        "report_id": f"stock_report_v5_{run_id.removeprefix('run_')}",
        "kind": "deep_research",
        "result_status": "completed",
        "workflow_run_id": run_id,
        "instrument": payload.instrument.model_dump(mode="json"),
        "research_cutoff_at": research_cutoff_at,
        "market_as_of": market_as_of,
        "generated_at": derived["generated_at"],
        "summary": payload.summary,
        "horizon_decisions": final_horizons,
        "source_ids": all_source_ids,
        "method_versions": derived["method_versions"],
        "disclaimer": DISCLAIMER,
    }
    try:
        validated = DecisionReportV5.model_validate(doc)
    except (TypeError, ValueError, ValidationError) as exc:
        return None, f"Error: invalid V5 report: {exc}"
    return validated.model_dump(mode="json"), None


_V6_SAFE_ACTIONS = {"conditional_participation", "wait", "reduce", "exit", "avoid"}


def _v6_status(value: Any) -> str:
    if isinstance(value, Mapping):
        value = value.get("status")
    if value in {"ready", "available", "complete", "passed", True}:
        return "ready"
    return "unavailable"


def _v6_horizon_statuses(
    readiness: Mapping[str, Any], section: str
) -> dict[str, str]:
    values: Any = readiness.get(section)
    if isinstance(values, Mapping) and isinstance(values.get("horizons"), Mapping):
        values = values["horizons"]
    if not isinstance(values, Mapping) or not any(
        horizon in values for horizon in _V5_HORIZONS
    ):
        values = readiness.get("horizons")
    if not isinstance(values, Mapping):
        values = {}
    return {
        horizon: _v6_status(values.get(horizon))
        for horizon in _V5_HORIZONS
    }


def _v6_compact_gate(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"status": "unavailable", "horizons": {}}
    horizons = value.get("horizons")
    compact_horizons = {}
    if isinstance(horizons, Mapping):
        for horizon in _V5_HORIZONS:
            item = horizons.get(horizon)
            if not isinstance(item, Mapping):
                continue
            compact_horizons[horizon] = {
                key: item[key]
                for key in ("status", "required", "available")
                if key in item
            }
    return {
        "status": value.get("status"),
        "horizons": compact_horizons,
        **(
            {"failure_reasons": list(value.get("failure_reasons") or [])[:8]}
            if value.get("failure_reasons")
            else {}
        ),
    }


def _v6_quant_gate(bundle: Mapping[str, Any]) -> dict[str, Any]:
    raw = (
        bundle.get("quant_validation")
        or bundle.get("quant_promotion")
        or bundle.get("quantPromotion")
    )
    if not isinstance(raw, Mapping):
        return {
            "status": "research_only",
            "eligibleForTrading": False,
            "reason": "当前股票没有已校准量化晋级结果",
        }
    eligible = raw.get("eligibleForTrading")
    if eligible is None:
        eligible = raw.get("eligible_for_trading")
    promotion = raw.get("promotionStatus") or raw.get("promotion_status")
    status = raw.get("status") or raw.get("validationStatus") or raw.get("validation_status")
    metrics = raw.get("validation_metrics") or raw.get("validationMetrics")
    if not isinstance(metrics, Mapping):
        metrics = {}
    scope = metrics.get("sampleScope", metrics.get("sample_scope"))
    coverage = metrics.get(
        "universeCoverage",
        metrics.get("universe_coverage", metrics.get("coverage")),
    )
    coverage_status = metrics.get("status", metrics.get("coverageStatus"))
    evidence_closed = (
        scope in {
            "full_universe",
            "complete_eligible_universe",
            "full_eligible_universe",
        }
        and isinstance(coverage, (int, float))
        and not isinstance(coverage, bool)
        and coverage >= 0.8
        and coverage_status not in {"rejected", "not_evaluable", "unavailable"}
    )
    # Legacy uncalibrated payloads stay research-only.  A trading promotion
    # must carry the sidecar's complete-universe validation metadata.
    qualified = eligible is True and promotion == "calibrated" and evidence_closed
    return {
        "status": "calibrated" if qualified else "research_only",
        "eligibleForTrading": qualified,
        "promotionStatus": promotion,
        "validationStatus": status,
        "reason": raw.get("reason") or raw.get("promotion_reason") or "量化策略未通过交易晋级门槛",
        "methodVersion": raw.get("methodVersion") or raw.get("factor_algorithm_version"),
        "strategyHorizon": raw.get("strategy_horizon") or raw.get("strategyHorizon"),
        "calibratedHorizon": raw.get("calibrated_horizon") or raw.get("calibratedHorizon"),
    }


def _v6_quant_gate_for_horizon(
    bundle: Mapping[str, Any], horizon: str
) -> dict[str, Any]:
    raw = (
        bundle.get("quant_validation")
        or bundle.get("quant_promotion")
        or bundle.get("quantPromotion")
    )
    if isinstance(raw, Mapping):
        strategy_horizon = raw.get("strategy_horizon") or raw.get("strategyHorizon")
        calibrated_horizon = raw.get("calibrated_horizon") or raw.get("calibratedHorizon")
        if strategy_horizon is not None or calibrated_horizon is not None:
            if strategy_horizon != horizon or calibrated_horizon != horizon:
                return {
                    "status": "research_only",
                    "eligibleForTrading": False,
                    "promotionStatus": raw.get("promotionStatus") or raw.get("promotion_status"),
                    "reason": "量化晋级仅覆盖其他周期，不能扩散到本周期",
                }
            return _v6_quant_gate(bundle)
        horizons = raw.get("horizons")
        scoped = horizons.get(horizon) if isinstance(horizons, Mapping) else None
        if isinstance(scoped, Mapping) and any(
            key in scoped
            for key in (
                "eligibleForTrading",
                "eligible_for_trading",
                "promotionStatus",
                "promotion_status",
                "validationMetrics",
                "validation_metrics",
            )
        ):
            merged = dict(raw)
            merged.update(scoped)
            return _v6_quant_gate({"quant_validation": merged})
        return {
            "status": "research_only",
            "eligibleForTrading": False,
            "promotionStatus": raw.get("promotionStatus") or raw.get("promotion_status"),
            "reason": "量化晋级结果未按周期提供，不能推断本周期具备交易资格",
        }
    return _v6_quant_gate(bundle)


def _v6_valuation_gate(bundle: Mapping[str, Any]) -> dict[str, Any]:
    raw = bundle.get("valuation")
    if not isinstance(raw, Mapping):
        return {"status": "unavailable", "tradeReady": False, "reason": "估值依据未完成"}
    qualified = raw.get("trade_ready", raw.get("tradeReady")) is True
    relative_positions = raw.get("relative_positions")
    relative_positions = relative_positions if isinstance(relative_positions, Mapping) else {}

    def metric_assessment(name: str) -> dict[str, Any]:
        item = relative_positions.get(name)
        item = item if isinstance(item, Mapping) else {}
        view = item.get("view")
        if view not in {"低估", "合理", "高估", "暂不判断"}:
            view = "暂不判断"
        percentile = item.get("percentile")
        if (
            isinstance(percentile, bool)
            or not isinstance(percentile, (int, float))
            or not math.isfinite(percentile)
            or not 0 <= percentile <= 1
        ):
            percentile = None
        return {"view": view, "percentile": percentile}

    metrics_assessment = {name: metric_assessment(name) for name in ("pe", "pb")}
    views = {
        item["view"]
        for item in metrics_assessment.values()
        if item["view"] != "暂不判断"
    }
    assessment_view = views.pop() if len(views) == 1 else "暂不判断"
    return {
        "status": "ready" if qualified else "unavailable",
        "tradeReady": qualified,
        "usableMethodCount": raw.get("usable_method_count", raw.get("usableMethodCount")),
        "crossRangeStatus": (
            (raw.get("cross_range") or raw.get("crossRange") or {}).get("status")
            if isinstance(raw.get("cross_range") or raw.get("crossRange"), Mapping)
            else None
        ),
        "assessment": {
            "view": assessment_view,
            "pe": metrics_assessment["pe"],
            "pb": metrics_assessment["pb"],
        },
        "reason": "估值交叉验证通过" if qualified else "估值交叉验证未通过",
    }


def _v6_valuation_gate_for_horizon(
    bundle: Mapping[str, Any], horizon: str
) -> dict[str, Any]:
    if horizon == "short_term":
        return {
            "status": "not_required",
            "tradeReady": True,
            "reason": "短线不以估值作为交易硬门槛",
        }
    global_gate = _v6_valuation_gate(bundle)
    raw = bundle.get("valuation")
    if horizon == "medium_term" and isinstance(raw, Mapping):
        usable = raw.get("usable_method_count", raw.get("usableMethodCount"))
        if isinstance(usable, int) and usable >= 1:
            return {
                **global_gate,
                "status": "ready",
                "tradeReady": True,
                "reason": "中线至少有一种估值方法可用",
            }
    return global_gate


def _v6_execution_facts(bundle: Mapping[str, Any]) -> dict[str, Any]:
    instrument = bundle.get("instrument") if isinstance(bundle.get("instrument"), Mapping) else {}
    quote = bundle.get("quote") if isinstance(bundle.get("quote"), Mapping) else {}
    tradeability = bundle.get("tradeability") if isinstance(bundle.get("tradeability"), Mapping) else {}
    projection = bundle.get("execution_facts_projection") or bundle.get("executionFactsProjection")
    projection = projection if isinstance(projection, Mapping) else {}
    derived = bundle.get("derived_decision_metrics") if isinstance(bundle.get("derived_decision_metrics"), Mapping) else {}
    volatility = derived.get("volatility") if isinstance(derived.get("volatility"), Mapping) else {}
    symbol = str(instrument.get("symbol") or "")
    exchange = instrument.get("exchange")
    board = tradeability.get("board") or tradeability.get("board_type")
    if board is not None:
        board = str(board).strip().lower()
    elif symbol.startswith("688"):
        board = "star"
    elif symbol.startswith(("300", "301")):
        board = "chinext"
    elif symbol.startswith(("4", "8")):
        board = "bse"
    else:
        board = "main"
    source_ids = list(
        dict.fromkeys(
            [
                *(
                    tradeability.get("source_ids") or []
                    if isinstance(tradeability.get("source_ids"), list)
                    else []
                ),
                *(
                    quote.get("source_ids") or []
                    if isinstance(quote.get("source_ids"), list)
                    else []
                ),
                *(
                    derived.get("source_ids") or []
                    if isinstance(derived.get("source_ids"), list)
                    else []
                ),
            ]
        )
    )

    def first(*names: str) -> Any:
        for name in names:
            value = projection.get(name)
            if value is not None:
                return value
            value = tradeability.get(name)
            if value is not None:
                return value
            value = quote.get(name)
            if value is not None:
                return value
        return None

    def ashare_price(value: Any) -> float | None:
        # Do not round a source value into a fabricated tick.  If a provider
        # returns more precision than an A-share quote can verify, omit it so
        # execution qualification degrades to a visible limited state.
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        try:
            decimal = Decimal(str(value))
        except (InvalidOperation, ValueError):
            return None
        if not decimal.is_finite() or decimal.quantize(Decimal("0.01")) != decimal:
            return None
        return float(value)

    lower_bound = first("listing_age_lower_bound_sessions", "listingAgeLowerBoundSessions")
    exact_listing_days = first("listing_days", "days_since_listing")
    active_membership = first("active_membership", "activeMembership")
    delisted = first("delisted", "is_delisted")
    if delisted is None and isinstance(active_membership, bool):
        delisted = not active_membership
    return {
        "board": board,
        "exchange": exchange,
        "risk_warning": first("risk_warning", "is_st", "st"),
        "registration_listing": first("registration_listing", "is_registration_listing"),
        "suspended": first("suspended", "is_suspended"),
        "delisted": delisted,
        "delisting": first("delisting", "is_delisting"),
        "listing_days": exact_listing_days or lower_bound,
        "listing_age_lower_bound_sessions": lower_bound,
        "listing_days_is_lower_bound": exact_listing_days is None and lower_bound is not None,
        "status_methods": dict(projection.get("status_methods") or projection.get("statusMethods") or {}),
        "price": ashare_price(quote.get("price")),
        "previous_close": ashare_price(first("previous_close", "pre_close", "prev_close")),
        "amount_yuan": first("amount_yuan", "amount", "turnover_amount"),
        "turnover_rate_pct": first("turnover_rate_pct", "turnover_rate", "turnover"),
        "atr20_pct": volatility.get("atr20_pct"),
        "has_order_book": False,
        "observed_at": derived.get("as_of") or bundle.get("market_as_of") or bundle.get("research_cutoff_at"),
        "source_ids": source_ids,
    }


def _v6_system_point(claim: str) -> dict[str, Any]:
    return {
        "claim": claim,
        "evidence": "系统根据当前研究门槛生成",
        "claim_type": "hypothesis",
        "source_ids": [],
    }


def _v6_frozen_prices(bundle: Mapping[str, Any]) -> tuple[float | None, float | None, list[str]]:
    quote = bundle.get("quote") if isinstance(bundle.get("quote"), Mapping) else {}
    current_price = quote.get("price")
    if isinstance(current_price, bool) or not isinstance(current_price, (int, float)):
        current_price = None
    relative = bundle.get("relative_benchmarks")
    relative = relative if isinstance(relative, Mapping) else {}
    benchmark = relative.get("benchmark")
    benchmark = benchmark if isinstance(benchmark, Mapping) else {}
    benchmark_price = next(
        (
            value
            for value in (
                benchmark.get("price"),
                benchmark.get("current_price"),
                benchmark.get("latest_close"),
                benchmark.get("close"),
                relative.get("benchmark_price"),
                relative.get("current_price"),
                relative.get("latest_benchmark_close"),
            )
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ),
        None,
    )
    source_ids = list(
        dict.fromkeys(
            [
                *(quote.get("source_ids") or [] if isinstance(quote.get("source_ids"), list) else []),
                *(relative.get("source_ids") or [] if isinstance(relative.get("source_ids"), list) else []),
                *(benchmark.get("source_ids") or [] if isinstance(benchmark.get("source_ids"), list) else []),
            ]
        )
    )
    return current_price, benchmark_price, source_ids


def _trusted_evidence_section(bundle: Mapping[str, Any], name: str) -> dict[str, Any]:
    """Copy one deterministic section without accepting Agent-supplied data."""
    value = bundle.get(name)
    return deepcopy(dict(value)) if isinstance(value, Mapping) else {}


def _v6_safe_actions(
    direction: str, decision: Any | None
) -> tuple[str, str, str]:
    if decision is None:
        return "avoid", "avoid", "exit"
    action = decision.action
    not_holding = decision.not_holding_action
    holding = decision.holding_action
    if action not in _V6_SAFE_ACTIONS:
        action = "wait" if direction in {"positive", "neutral"} else "avoid"
    if direction == "positive":
        action = "wait" if action not in _V6_SAFE_ACTIONS else action
        not_holding = "wait"
        holding = "hold"
    elif direction == "neutral":
        action = "wait" if action not in _V6_SAFE_ACTIONS else action
        not_holding = "wait"
        holding = "hold"
    else:
        action = "avoid" if action not in {"reduce", "exit", "avoid"} else action
        not_holding = "avoid"
        holding = "exit"
    return action, not_holding, holding


def _v6_plan_has_boundary(plan: Any) -> bool:
    return any(
        getattr(plan, field, None) is not None
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


def _trusted_v6_derived_metrics(
    bundle: Mapping[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate an Evidence V6 plan containing zero or more horizons."""
    derived = bundle.get("derived_decision_metrics")
    if not isinstance(derived, Mapping):
        return None, "Error: current Evidence has no V6 derived_decision_metrics."
    methods = derived.get("method_versions")
    generated_at = derived.get("generated_at")
    horizons = derived.get("horizons")
    source_ids = derived.get("source_ids")
    if not isinstance(methods, Mapping) or not all(isinstance(methods.get(key), str) and methods.get(key) for key in ("decision", "indicators", "conditions")):
        return None, "Error: V6 derived_decision_metrics.method_versions is incomplete."
    if not isinstance(generated_at, str) or not isinstance(horizons, Mapping) or not isinstance(source_ids, list):
        return None, "Error: V6 derived_decision_metrics is incomplete."
    validated: dict[str, Any] = {
        "schema_version": derived.get("schema_version", 1),
        "generated_at": generated_at,
        "method_versions": dict(methods),
        "source_ids": list(dict.fromkeys(item for item in source_ids if isinstance(item, str) and item)),
        "horizons": {},
    }
    for horizon, item in horizons.items():
        if horizon not in _V5_HORIZONS or not isinstance(item, Mapping):
            return None, f"Error: V6 derived_decision_metrics.horizons.{horizon} is invalid."
        try:
            trading_plan = V5TradingPlan.model_validate(item.get("trading_plan"))
            position_plan = V5PositionPlan.model_validate(item.get("position_plan"))
        except (TypeError, ValueError, ValidationError) as exc:
            return None, f"Error: invalid V6 derived_decision_metrics.{horizon}: {exc}"
        valid_until = item.get("valid_until")
        review_trigger = item.get("review_trigger")
        if not isinstance(valid_until, str) or not isinstance(review_trigger, str) or not review_trigger.strip():
            return None, f"Error: V6 derived_decision_metrics.{horizon} timing is incomplete."
        validated["horizons"][horizon] = {
            "trading_plan": trading_plan.model_dump(mode="json"),
            "position_plan": position_plan.model_dump(mode="json"),
            "valid_until": valid_until,
            "review_trigger": review_trigger,
            "evidence_strength": item.get("evidence_strength") or "medium",
            "source_ids": list(dict.fromkeys(item.get("source_ids") or [])),
        }
    return validated, None


def _build_v6_report(
    workspace: Path,
    run_id: str,
    payload: Any,
) -> tuple[dict[str, Any] | None, str | None]:
    instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
    bundle, error = _load_report_bundle(workspace, run_id, instrument_id)
    if error is not None or bundle is None:
        return None, error or "Error: instrument Evidence is unavailable."
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, Mapping):
        return None, "Error: V6 Evidence has no decision_readiness."
    try:
        risk_store = LocalRiskProfileStore(risk_profile_path(workspace))
        risk_profile = risk_store.get_risk_profile()
        portfolio_context = risk_store.get_portfolio_context(instrument_id)
    except (RiskProfileStorageError, ValueError, TypeError) as exc:
        return None, f"Error: V6 risk profile/context is unavailable: {exc}"
    research_statuses = _v6_horizon_statuses(readiness, "research_ready")
    if not any(status == "ready" for status in research_statuses.values()):
        return None, "Error: V6 research_ready has no research-ready horizon."
    trade_statuses = _v6_horizon_statuses(readiness, "trade_ready")
    quant_gate = _v6_quant_gate(bundle)
    trusted_quant_validation = _trusted_quant_validation(bundle)
    trusted_quant_promotion = _trusted_quant_promotion_sidecar(bundle)
    if (
        isinstance(bundle.get("quant_validation"), dict)
        and trusted_quant_validation is None
        and trusted_quant_promotion is None
    ):
        return None, "Error: Evidence quant_validation is invalid or its source closure is incomplete."
    valuation_gate = _v6_valuation_gate(bundle)
    market_sentiment = _trusted_evidence_section(bundle, "market_sentiment")
    public_opinion = _trusted_evidence_section(bundle, "public_opinion")
    current_price, benchmark_price, price_source_ids = _v6_frozen_prices(bundle)
    derived, _derived_error = _trusted_v6_derived_metrics(bundle)
    derived = derived or {"horizons": {}, "source_ids": [], "method_versions": {}}
    decisions_input = payload.v6_horizon_decisions
    if decisions_input is None:
        return None, "Error: V6 horizon decisions are missing."
    target_source_ids = {
        source.get("id")
        for source in bundle.get("sources") or []
        if isinstance(source, Mapping) and isinstance(source.get("id"), str)
    }
    submitted_source_ids = payload.all_source_ids()
    missing_submitted = sorted(set(submitted_source_ids) - target_source_ids)
    if missing_submitted:
        return None, "Error: V6 source_ids must belong to target Evidence: " + ", ".join(missing_submitted)
    facts = _v6_execution_facts(bundle)
    try:
        baseline_execution = assess_a_share_execution(
            facts,
            holding_state=portfolio_context.holding_state,
            today_bought_quantity=portfolio_context.today_bought_quantity,
        )
    except (TypeError, ValueError, ValidationError) as exc:
        return None, f"Error: V6 execution facts are invalid: {exc}"
    execution_qualification: dict[str, Any] = {
        "status": baseline_execution.execution_status,
        "assessment": baseline_execution.model_dump(mode="json"),
        "horizons": {},
    }
    quant_horizon_gates: dict[str, Any] = {}
    valuation_horizon_gates: dict[str, Any] = {}
    final_horizons: dict[str, Any] = {}
    plan_count = 0
    for horizon in _V5_HORIZONS:
        research_status = research_statuses[horizon]
        trade_status = trade_statuses[horizon]
        submitted = getattr(decisions_input, horizon)
        derived_item = derived.get("horizons", {}).get(horizon)
        if research_status != "ready":
            final_horizons[horizon] = {
                "direction": "avoid",
                "action": "avoid",
                "thesis": "当前周期暂无可核验结论，暂不参与。",
                "not_holding_action": "avoid",
                "holding_action": "exit",
                "key_reasons": [_v6_system_point("当前周期研究门槛未通过")],
                "key_risks": [_v6_system_point("补齐核心数据后结论可能改变")],
                "disagreement_matrix": None,
                "research_status": "unavailable",
                "trade_status": "unavailable",
                "materialized_plan": None,
                "valid_until": None,
                "review_trigger": "补齐该周期核心数据后重新评估",
                "source_ids": [],
            }
            execution_qualification["horizons"][horizon] = {
                "status": baseline_execution.execution_status,
                "executionStatus": baseline_execution.execution_status,
                "reason": "研究门槛未通过；执行资格仅表示当前A股规则与流动性事实",
                "reasons": ["研究门槛未通过"],
            }
            continue
        if submitted is None:
            return None, f"Error: V6 horizon_decisions.{horizon} is required for a research-ready horizon."
        if not submitted.key_reasons or not submitted.key_risks or not submitted.source_ids:
            return None, f"Error: V6 horizon_decisions.{horizon} requires sourced reasons, risks and source_ids."
        direction = submitted.direction
        action = submitted.action
        not_holding_action = submitted.not_holding_action
        holding_action = submitted.holding_action
        materialized: dict[str, Any] | None = None
        execution_status = baseline_execution.execution_status
        reasons: list[str] = []
        gate_trade = trade_status == "ready"
        scoped_quant_gate = _v6_quant_gate_for_horizon(bundle, horizon)
        scoped_valuation_gate = _v6_valuation_gate_for_horizon(bundle, horizon)
        quant_horizon_gates[horizon] = scoped_quant_gate
        valuation_horizon_gates[horizon] = scoped_valuation_gate
        gate_quant = scoped_quant_gate["eligibleForTrading"]
        gate_valuation = scoped_valuation_gate["tradeReady"]
        if not gate_trade:
            reasons.append("周期交易门槛未通过")
        if not gate_quant:
            reasons.append("量化策略未晋级交易")
        if not gate_valuation:
            reasons.append("估值资格未通过")
        requested_side = (
            "buy"
            if direction == "positive"
            and (
                portfolio_context.holding_state == "not_holding"
                or action == "conditional_participation"
            )
            else "sell"
            if direction in {"negative", "avoid"}
            and portfolio_context.holding_state == "holding"
            else None
        )
        try:
            assessment = assess_a_share_execution(
                facts,
                holding_state=portfolio_context.holding_state,
                today_bought_quantity=portfolio_context.today_bought_quantity,
                requested_side=requested_side,
            )
            execution_status = assessment.execution_status
        except (TypeError, ValueError, ValidationError) as exc:
            return None, f"Error: V6 execution qualification failed for {horizon}: {exc}"
        if isinstance(derived_item, Mapping) and assessment.execution_status != "blocked":
            try:
                reference_plan = not (gate_trade and gate_quant and gate_valuation)
                candidate = materialize_v6_trading_plan(
                    derived_item,
                    direction=direction,
                    action=action,
                    holding_state=portfolio_context.holding_state,
                    execution_facts=facts,
                    portfolio=portfolio_context,
                    risk_profile=risk_profile,
                    alpha_calibrated=gate_quant,
                    plan_type="rule_reference" if reference_plan else "alpha_calibrated",
                )
                if candidate.plan_status in {"proxy", "limited"} and _v6_plan_has_boundary(candidate):
                    materialized = candidate.model_dump(mode="json")
                    materialized["cost_assumptions"] = {
                        "commission_pct": 0.03,
                        "stamp_tax_pct": 0.05,
                        "transfer_fee_pct": 0.001,
                        "method_version": "a-share-cost-assumptions-v1",
                        "source": "system_default",
                    }
                    plan_count += 1
                else:
                    reasons.append(
                        "执行资格未通过"
                        if candidate.plan_status == "blocked"
                        else "缺少可执行价格或风控边界"
                    )
            except (TypeError, ValueError, ValidationError) as exc:
                reasons.append(f"执行计划生成失败：{exc}")
        elif not isinstance(derived_item, Mapping):
            reasons.append("缺少该周期确定性交易计划")
        else:
            reasons.append("执行资格未通过")
        if gate_trade and gate_quant and gate_valuation is False:
            reasons.append("估值资格未通过，当前仅生成规则参考计划")
        execution_qualification["horizons"][horizon] = {
            "status": assessment.execution_status,
            "executionStatus": execution_status,
            "reasons": reasons,
        }
        if materialized is None:
            action, not_holding_action, holding_action = _v6_safe_actions(direction, submitted)
        final = submitted.model_dump(mode="json")
        final.update(
            {
                "action": action,
                "not_holding_action": not_holding_action,
                "holding_action": holding_action,
                "research_status": "ready",
                "trade_status": "ready" if materialized is not None else "unavailable",
                "materialized_plan": materialized,
                "valid_until": (
                    derived_item.get("valid_until")
                    if materialized is not None and isinstance(derived_item, Mapping)
                    else None
                ),
                "review_trigger": (
                    derived_item.get("review_trigger")
                    if materialized is not None and isinstance(derived_item, Mapping)
                    else "交易门槛或关键数据发生变化时重新评估"
                ),
                "source_ids": list(dict.fromkeys(submitted.source_ids + (materialized or {}).get("source_ids", []))),
            }
        )
        try:
            final_horizons[horizon] = V6HorizonDecision.model_validate(final).model_dump(mode="json")
        except (TypeError, ValueError, ValidationError) as exc:
            return None, f"Error: invalid V6 horizon_decisions.{horizon}: {exc}"
    mode = "reference_plan" if plan_count else "research_only"
    report_sources = list(
        dict.fromkeys(
            submitted_source_ids
            + list(derived.get("source_ids") or [])
            + list(price_source_ids)
            + list(baseline_execution.source_ids)
        )
    )
    for decision in final_horizons.values():
        report_sources.extend(decision.get("source_ids") or [])
    if trusted_quant_validation is not None:
        report_sources.extend(_iter_nested_source_ids(trusted_quant_validation))
    if trusted_quant_promotion is not None:
        report_sources.extend(_iter_nested_source_ids(trusted_quant_promotion))
    report_sources.extend(_iter_nested_source_ids(market_sentiment))
    report_sources.extend(_iter_nested_source_ids(public_opinion))
    report_sources = list(dict.fromkeys(report_sources))
    missing_sources = sorted(set(report_sources) - target_source_ids)
    if missing_sources:
        return None, "Error: V6 generated source_ids must belong to target Evidence: " + ", ".join(missing_sources)
    research_public = _v6_compact_gate(readiness.get("research_ready") or readiness)
    trade_public = _v6_compact_gate(readiness.get("trade_ready") or readiness)
    research_public["horizons"] = {
        horizon: {"status": research_statuses[horizon]}
        for horizon in _V5_HORIZONS
    }
    trade_public["horizons"] = {
        horizon: {"status": trade_statuses[horizon]}
        for horizon in _V5_HORIZONS
    }
    document = {
        "schema_version": 6,
        "report_id": f"stock_report_v6_{run_id.removeprefix('run_')}",
        "kind": "deep_research",
        "result_status": "completed",
        "workflow_run_id": run_id,
        "instrument": payload.instrument.model_dump(mode="json"),
        "research_cutoff_at": bundle.get("research_cutoff_at"),
        "market_as_of": bundle.get("market_as_of"),
        "generated_at": bundle.get("research_cutoff_at") or bundle.get("market_as_of"),
        "current_price": current_price,
        "benchmark_price": benchmark_price,
        "price_source_ids": price_source_ids,
        "summary": payload.summary,
        "decision_mode": mode,
        "research_status": "ready",
        "trade_status": "ready" if plan_count else "unavailable",
        "horizon_decisions": final_horizons,
        "research_ready": research_public,
        "trade_ready": trade_public,
        "quant_promotion": {**quant_gate, "horizons": quant_horizon_gates},
        "valuation": {**valuation_gate, "horizons": valuation_horizon_gates},
        "market_sentiment": market_sentiment,
        "public_opinion": public_opinion,
        "execution_qualification": execution_qualification,
        "risk_profile_configured": risk_profile.configured,
        "risk_level": risk_profile.risk_level,
        "holding_state": portfolio_context.holding_state,
        "method_versions": {
            **dict(derived.get("method_versions") or {}),
            "report": "decision-report-v6",
        },
        "source_ids": report_sources,
        "sources": [
            source
            for source in bundle.get("sources") or []
            if isinstance(source, Mapping) and source.get("id") in set(report_sources)
        ],
        "disclaimer": DISCLAIMER,
    }
    if trusted_quant_validation is not None:
        document["quant_validation"] = trusted_quant_validation
    try:
        validated = DecisionReportV6.model_validate(document)
    except (TypeError, ValueError, ValidationError) as exc:
        return None, f"Error: invalid V6 report: {exc}"
    return validated.model_dump(mode="json"), None


def _run_context(tool_ctx: Any) -> tuple[str, str] | str:
    """Trusted ``(run_id, job_id)`` from the ToolContext, or an error."""
    run_id = getattr(tool_ctx, "workflow_run_id", None) or None
    job_id = getattr(tool_ctx, "job_id", None) or None
    if run_id is None or job_id is None:
        return "Error: submit tools are only available inside a workflow run."
    return run_id, job_id


def _trusted_selection_origin(
    workspace: Path, run_id: str
) -> tuple[dict[str, Any] | None, str | None]:
    """Read only the initializer-verified handoff from the durable run."""
    try:
        run = WorkflowRunStore.default_dir(workspace)
        persisted = WorkflowRunStore(run).load(run_id)
    except Exception:
        # Existing non-stock/development tests and legacy runs have no durable
        # origin.  They remain compatible and simply omit the report field.
        return None, None
    inputs = persisted.inputs if isinstance(persisted.inputs, dict) else {}
    origin = inputs.get("selection_origin")
    if origin is None:
        return None, None
    if not isinstance(origin, dict):
        return None, "Error: persisted selection_origin is invalid."
    return deepcopy(origin), None


def _existing_refs(run_dir: Path, run_id: str, stems: tuple[str, ...]) -> dict[str, str]:
    """References to upstream artifacts that actually exist on disk."""
    refs: dict[str, str] = {}
    for stem in stems:
        if (run_dir / f"{stem}.json").is_file():
            refs[stem] = f"artifact://stock/{run_id}/{stem}.json"
    return refs


_ANALYST_GATES = {
    "technical": "short_term",
    "news": "medium_term",
    "fundamental": "long_term",
}


def _decision_readiness_horizon_status(
    bundle: dict[str, Any], horizon: str
) -> str | None:
    """Return the trusted *research* readiness status for one horizon.

    V6 has separate research and trade gates.  Upstream Agent artifacts only
    need research evidence; trade qualification is applied when the system
    materializes a V6 plan.  Runs without the V6 research gate keep the legacy
    horizon projection for compatibility.
    """
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, dict):
        return None
    research_gate = readiness.get("research_ready")
    if isinstance(research_gate, dict):
        horizons = research_gate.get("horizons")
        if not isinstance(horizons, dict):
            horizons = readiness.get("horizons")
    else:
        horizons = readiness.get("horizons")
    if not isinstance(horizons, dict):
        return None
    item = horizons.get(horizon)
    if not isinstance(item, dict):
        return None
    status = item.get("status")
    if status in {"ready", "available"}:
        return "ready"
    if status in {"failed", "unavailable", "insufficient_data", "missing"}:
        return "failed"
    return None


def _validate_analyst_gate(
    workspace: Path, run_id: str, instrument_id: str, artifact_name: str, stance: str
) -> str | None:
    """Gate V3 views on the trusted readiness horizon, not stale coverage."""
    horizon = _ANALYST_GATES.get(artifact_name)
    if horizon is None or stance == "insufficient_data":
        return None
    data = EvidenceService(workspace=workspace, provider=None).read(run_id) or {}
    bundle = (data.get("symbols") or {}).get(instrument_id)
    if not isinstance(bundle, dict):
        return f"Error: instrument Evidence {instrument_id!r} not found in run {run_id}."
    readiness_status = _decision_readiness_horizon_status(bundle, horizon)
    if readiness_status == "ready":
        return None
    if readiness_status is None:
        return (
            f"Error: {artifact_name} {horizon} decision_readiness is missing or invalid; "
            "submit stance=insufficient_data."
        )
    return (
        f"Error: {artifact_name} {horizon} decision_readiness is {readiness_status}; "
        "submit stance=insufficient_data."
    )


_RESEARCH_HORIZON_LABELS = {
    "short_term": "短线",
    "medium_term": "中线",
    "long_term": "长线",
}
_READINESS_FACT_LABELS = {
    "quote": "行情",
    "kline": "历史价格",
    "technical_indicators": "技术指标",
    "fundamentals": "财务数据",
    "industry_context": "行业信息",
    "cycle_context": "周期信息",
    "policy_context": "政策信息",
    "company_quality": "公司质量",
    "multi_period_financials": "多期财务数据",
    "cashflow_quality": "现金流质量",
    "valuation_basis": "估值依据",
    "industry_lifecycle": "行业生命周期",
}
_USER_TEXT_KEYS = frozenset({
    "summary",
    "claim",
    "basis",
    "evidence",
    "thesis",
    "key_reasons",
    "key_risks",
    "risks",
    "bull_case",
    "bear_case",
    "verdict",
    "ruling",
    "retained_risks",
    "change_conditions",
    "issue",
    "one_liner",
})
_PUBLIC_TEXT_FORBIDDEN = (
    re.compile(r"&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);", re.IGNORECASE),
    re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", re.IGNORECASE),
    re.compile(r"\bsource[ _-]?ids?\b", re.IGNORECASE),
    re.compile(
        r"\b(?:insufficient_data|available|unavailable|missing|degraded|"
        r"research_ready|trade_ready|not_applicable|unknown|positive|negative|"
        r"neutral|conditional_participation|participate|observe|hold|avoid|"
        r"exit|reduce|wait)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:eastmoney|push2|tushare|akshare|baostock|yfinance|provider|"
        r"endpoint|api|http(?:s)?|websocket|socket|request|retry|timeout)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(?:quote|kline|tradeability)\b", re.IGNORECASE),
)
_NUMBER_LITERAL = re.compile(
    r"(?<![A-Za-z_])(?P<number>[+-]?(?:\d+(?:\.\d+)?|\.\d+))"
    r"(?P<unit>亿元|万元|万手|亿手|万|亿|倍|%|％|元)?"
)
_PARAMETER_CONTEXT = re.compile(
    r"(?:MA|RSI|ATR)\s*[\[(]?$|"
    r"(?:日均线|日线|日K|周K|月K|交易日|R\s*(?:/|$))",
    re.IGNORECASE,
)
_INDUSTRY_POSITIVE_CLAIM = re.compile(
    r"行业(?:供需|景气|周期|趋势|信息)?[^。\n]{0,12}"
    r"(?:已确认|确认|复苏中段|改善|回暖|上行)",
    re.IGNORECASE,
)


def _iter_user_texts(value: Any, path: str = "", scope: bool = False,
                     source_ids: tuple[str, ...] = ()):
    """Yield user-facing narrative fields without exposing source metadata."""
    if isinstance(value, Mapping):
        declared_source_ids = value.get("source_ids", _MISSING)
        own_source_ids = (
            tuple(item for item in declared_source_ids if isinstance(item, str) and item)
            if isinstance(declared_source_ids, list)
            else source_ids
        )
        for key, child in value.items():
            if key in {"sources", "source_ids"}:
                continue
            child_path = f"{path}.{key}" if path else str(key)
            child_scope = scope or key in _USER_TEXT_KEYS
            if isinstance(child, str) and child_scope:
                yield child_path, child, own_source_ids
            else:
                yield from _iter_user_texts(child, child_path, child_scope, own_source_ids)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            yield from _iter_user_texts(child, child_path, scope, source_ids)


def _public_text_error(value: Mapping[str, Any]) -> str | None:
    for path, text, _source_ids in _iter_user_texts(value):
        for pattern in _PUBLIC_TEXT_FORBIDDEN:
            match = pattern.search(text)
            if match:
                return (
                    f"Error: user-facing text at {path} contains forbidden internal "
                    f"term {match.group(0)!r}; rewrite it in plain Chinese."
                )
    return None


def _number_literals(text: str) -> list[tuple[float, str | None]]:
    literals: list[tuple[float, str | None]] = []
    for match in _NUMBER_LITERAL.finditer(text):
        raw_number = match.group("number")
        unit = match.group("unit")
        start, end = match.span()
        context_before = text[max(0, start - 12):start]
        context_after = text[end:min(len(text), end + 12)]
        # Bare numerals are usually indicator windows or dates in model prose;
        # only explicit business units are closed against Evidence values.
        if unit is None:
            continue
        if _PARAMETER_CONTEXT.search(context_before) or _PARAMETER_CONTEXT.search(context_after):
            continue
        try:
            literals.append((float(raw_number), unit))
        except ValueError:
            continue
    return literals


def _iter_evidence_numbers(value: Any, source_ids: tuple[str, ...] = ()):
    if isinstance(value, Mapping):
        declared_source_ids = value.get("source_ids", _MISSING)
        own_source_ids = (
            tuple(item for item in declared_source_ids if isinstance(item, str) and item)
            if isinstance(declared_source_ids, list)
            else source_ids
        )
        derived = value.get("derived_decision_metrics")
        derived_source_ids = tuple(
            item for item in (derived.get("source_ids", []) if isinstance(derived, Mapping) else [])
            if isinstance(item, str) and item
        )
        for key, child in value.items():
            if key in {"sources", "source_ids"}:
                continue
            child_source_ids = (
                derived_source_ids
                if key == "indicators" and derived_source_ids
                else own_source_ids
            )
            if _finite_number(child):
                if key not in {"year", "month", "day", "quarter"} and child_source_ids:
                    yield float(child), child_source_ids
            else:
                yield from _iter_evidence_numbers(child, child_source_ids)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_evidence_numbers(child, source_ids)


def _number_candidates(value: float, unit: str | None) -> tuple[float, ...]:
    if unit in {"%", "％"}:
        return value, value / 100.0
    if unit in {"万", "万元", "万手"}:
        return value, value * 10_000.0
    if unit in {"亿", "亿元", "亿手"}:
        return value, value * 100_000_000.0
    return (value,)


def _number_matches(value: float, unit: str | None, available: list[float]) -> bool:
    for candidate in _number_candidates(value, unit):
        tolerance = max(0.01, abs(candidate) * 0.005)
        if any(abs(candidate - actual) <= tolerance for actual in available):
            return True
    return False


def _numeric_closure_error(value: Mapping[str, Any], bundle: Mapping[str, Any]) -> str | None:
    available_by_source: dict[str, list[float]] = {}
    for number, source_ids in _iter_evidence_numbers(bundle):
        for source_id in source_ids:
            available_by_source.setdefault(source_id, []).append(number)
    for path, text, source_ids in _iter_user_texts(value):
        for number, unit in _number_literals(text):
            if not source_ids:
                return f"Error: numeric closure failed at {path}: {number:g} requires source_ids."
            available = [
                number_value
                for source_id in source_ids
                for number_value in available_by_source.get(source_id, [])
            ]
            if not _number_matches(number, unit, available):
                suffix = unit or ""
                return (
                    f"Error: numeric closure failed at {path}: {number:g}{suffix} "
                    "is not present in Evidence values for its cited sources; "
                    "replace it with a sourced value or remove the number."
                )
    return None


def _readiness_horizon(bundle: Mapping[str, Any], horizon: str) -> Mapping[str, Any] | None:
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, Mapping):
        return None
    research_ready = readiness.get("research_ready")
    horizons = research_ready.get("horizons") if isinstance(research_ready, Mapping) else None
    if not isinstance(horizons, Mapping):
        horizons = readiness.get("horizons")
    item = horizons.get(horizon) if isinstance(horizons, Mapping) else None
    return item if isinstance(item, Mapping) else None


def _unavailable_horizon_summary(
    bundle: Mapping[str, Any], horizon: str, role: str,
) -> str:
    item = _readiness_horizon(bundle, horizon) or {}
    available = [
        _READINESS_FACT_LABELS[name]
        for name in item.get("available", []) or []
        if name in _READINESS_FACT_LABELS
    ]
    prefix = _RESEARCH_HORIZON_LABELS.get(horizon, "该周期")
    if available:
        facts = "、".join(dict.fromkeys(available))
        prefix = f"{prefix}已核验{facts}"
    else:
        prefix = f"{prefix}关键资料尚未形成完整核验"
    if role in {"bull", "bear"}:
        stance = "多头" if role == "bull" else "空头"
        return f"{prefix}，当前不能形成可核验的{stance}情景。"
    return f"{prefix}，当前不能形成可靠结论或交易计划。"


def _publicize_unavailable_artifact(
    artifact: dict[str, Any], bundle: Mapping[str, Any], artifact_name: str,
) -> dict[str, Any]:
    """Replace unavailable model prose with deterministic, public wording."""
    result = deepcopy(artifact)
    if artifact_name in _ANALYST_GATES and result.get("stance") == "insufficient_data":
        horizon = _ANALYST_GATES[artifact_name]
        item = _readiness_horizon(bundle, horizon)
        if item is None or item.get("status") not in {"ready", "available"}:
            result["summary"] = _unavailable_horizon_summary(bundle, horizon, artifact_name)
    if artifact_name in {"bull", "bear"}:
        cases = result.get("horizon_cases")
        if isinstance(cases, Mapping):
            for horizon, case in cases.items():
                if isinstance(case, dict) and case.get("status") == "insufficient_data":
                    case["summary"] = _unavailable_horizon_summary(bundle, horizon, artifact_name)
    return result


def _v6_industry_claim_error(value: Mapping[str, Any], bundle: Mapping[str, Any]) -> str | None:
    industry = bundle.get("industry_context")
    if isinstance(industry, Mapping) and industry.get("status") == "available" and industry.get("source_ids"):
        return None
    for path, text, _source_ids in _iter_user_texts(value):
        match = _INDUSTRY_POSITIVE_CLAIM.search(text)
        if match:
            return (
                f"Error: {path} contains unsupported industry conclusion {match.group(0)!r}; "
                "industry evidence is not available, so state the limitation instead."
            )
    return None


_DEBATE_HORIZONS = ("short_term", "medium_term", "long_term")


def _validate_debate_coverage_gate(
    workspace: Path,
    run_id: str,
    instrument_id: str,
    artifact_name: str,
    horizon_cases: Any,
) -> str | None:
    """Gate V3 debate cases on trusted readiness before legacy coverage."""
    if artifact_name not in {"bull", "bear"}:
        return None
    data = EvidenceService(workspace=workspace, provider=None).read(run_id) or {}
    bundle = (data.get("symbols") or {}).get(instrument_id)
    if not isinstance(bundle, dict):
        return f"Error: instrument Evidence {instrument_id!r} not found in run {run_id}."
    for horizon in _DEBATE_HORIZONS:
        readiness_status = _decision_readiness_horizon_status(bundle, horizon)
        if readiness_status == "ready":
            continue
        case = getattr(horizon_cases, horizon, None)
        if readiness_status is None:
            if case is None or case.status != "insufficient_data":
                return (
                    f"Error: {artifact_name} {horizon} decision_readiness is missing or invalid; "
                    "submit horizon case status=insufficient_data."
                )
        else:
            if case is None or case.status != "insufficient_data":
                return (
                    f"Error: {artifact_name} {horizon} decision_readiness is {readiness_status}; "
                    "submit horizon case status=insufficient_data."
                )
        non_empty = [
            field
            for field in ("points", "confirmation", "invalidation")
            if getattr(case, field, None)
        ]
        if non_empty:
            return (
                f"Error: {artifact_name} {horizon} decision_readiness is failed; "
                f"submit empty {', '.join(non_empty)}."
            )
    return None


def _validate_debate_resolution_coverage_gate(
    payload: Any, bundle: dict[str, Any]
) -> str | None:
    """Keep a final ruling missing when its horizon Evidence is missing.

    The referee reads bull/bear artifacts, but those artifacts may have been
    produced by an older run or before the coverage gate existed.  Re-check
    the final resolution against the current Evidence at the immutable-report
    boundary instead of trusting either upstream artifact.
    """
    resolutions = payload.debate_resolution
    coverage = bundle.get("evidence_coverage") or {}
    for horizon in _DEBATE_HORIZONS:
        if ((coverage.get(horizon) or {}).get("status")) != "insufficient_data":
            continue
        resolution = getattr(resolutions, horizon)
        if resolution.status != "missing":
            return (
                f"Error: {horizon} coverage is insufficient_data; "
                "debate_resolution status must be missing."
            )
        non_empty = [
            field
            for field in (
                "bull_case",
                "bear_case",
                "verdict",
                "change_conditions",
                "source_ids",
            )
            if getattr(resolution, field)
        ]
        if non_empty:
            return (
                f"Error: {horizon} coverage is insufficient_data; "
                f"debate_resolution must have empty {', '.join(non_empty)}."
            )
        if not resolution.missing_fields:
            return (
                f"Error: {horizon} coverage is insufficient_data; "
                "debate_resolution.missing_fields must disclose the gap."
            )
    return None


@tool_parameters(_BATCH_VIEW_PARAMS)
class _BaseViewSubmitTool(Tool):
    """Shared validation/persistence for the five view/case submit tools.

    Underscored so the loader never discovers it; concrete subclasses set
    ``_tool_name`` / ``_artifact_name`` / ``_description``.
    """

    _scopes = {"subagent"}
    _tool_name = ""
    _artifact_name = ""
    _description = ""
    _single_model: type[Any] | None = None
    _allow_batch = False

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return self._tool_name

    @property
    def description(self) -> str:
        return self._description

    async def execute(self, **kwargs: Any) -> str:
        ctx = _run_context(self._tool_ctx)
        if isinstance(ctx, str):
            return ctx
        run_id, job_id = ctx
        try:
            if kwargs.get("items") is not None and self._allow_batch:
                payload = BatchViewSubmission.model_validate(kwargs)
            elif self._single_model is not None:
                payload = self._single_model.model_validate(kwargs)
            else:
                return "Error: submit tool has no payload schema"
        except ValidationError as exc:
            return f"Error: invalid payload: {exc}"
        sources, error = _resolve_sources(
            self._workspace, run_id, payload.all_source_ids()
        )
        if error is not None:
            return error
        if not isinstance(payload, BatchViewSubmission):
            error = _validate_analyst_gate(
                self._workspace,
                run_id,
                f"{payload.instrument.exchange}:{payload.instrument.symbol}",
                self._artifact_name,
                payload.stance,
            )
            if error is not None:
                return error
            error = _validate_debate_coverage_gate(
                self._workspace,
                run_id,
                f"{payload.instrument.exchange}:{payload.instrument.symbol}",
                self._artifact_name,
                payload.horizon_cases
                if isinstance(payload, HorizonCaseSubmission)
                else None,
            )
            if error is not None:
                return error
        artifact: dict[str, Any] = {
            "schema_version": VIEW_SCHEMA_VERSION,
            "kind": self._artifact_name,
            "workflow_run_id": run_id,
            "as_of": payload.as_of,
        }
        if isinstance(payload, BatchViewSubmission):
            artifact["items"] = [item.model_dump() for item in payload.items]
        else:
            artifact.update(payload.model_dump())
            evidence = EvidenceService(workspace=self._workspace, provider=None).read(run_id) or {}
            instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
            bundle = (evidence.get("symbols") or {}).get(instrument_id)
            if isinstance(bundle, Mapping):
                artifact = _publicize_unavailable_artifact(
                    artifact, bundle, self._artifact_name
                )
                industry_error = _v6_industry_claim_error(artifact, bundle)
                if industry_error is not None:
                    return industry_error
                text_error = _public_text_error(artifact)
                if text_error is not None:
                    return text_error
                numeric_error = _numeric_closure_error(artifact, bundle)
                if numeric_error is not None:
                    return numeric_error
        if isinstance(payload, BatchViewSubmission):
            text_error = _public_text_error(artifact)
            if text_error is not None:
                return text_error
        artifact["sources"] = sources
        from mona.config.paths import get_stock_project_dir

        run_dir = get_stock_project_dir(self._workspace, run_id)
        _atomic_write_json(run_dir / f"{self._artifact_name}.json", artifact)
        ref = ArtifactRef.for_path(
            owner_kind="product",
            owner_id=run_id,
            product="stock",
            root=run_dir,
            path=run_dir / f"{self._artifact_name}.json",
            created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
            job_id=job_id,
            workflow_run_id=run_id,
            room_id=getattr(self._tool_ctx, "room_id", None),
        )
        run_artifacts.append(job_id, ref)
        return f"Submitted {self._artifact_name} view: {ref.relative_path}"


@tool_parameters(_structured_view_params(
    ["market_regime", "capital_positioning", "tradeability", "short_term_timing"]
))
class SubmitTechnicalViewTool(_BaseViewSubmitTool):
    _tool_name = "submit_technical_view"
    _artifact_name = "technical"
    _description = (
        "Submit your technical analysis view (price/volume action, trend, "
        "market regime, capital positioning and tradeability as named "
        "sections. Cite only source ids from the current run's evidence "
        "bundle; empty sections must remain explicit."
    )
    _single_model = TechnicalViewSubmission
    _allow_batch = True


@tool_parameters(_structured_view_params(
    ["company_quality", "financial_quality", "valuation_context", "long_term_value"]
))
class SubmitFundamentalViewTool(_BaseViewSubmitTool):
    _tool_name = "submit_fundamental_view"
    _artifact_name = "fundamental"
    _description = (
        "Submit company quality, financial quality, valuation context and "
        "long-term value as named sections. Cite only source ids from the "
        "current run's evidence bundle."
    )
    _single_model = FundamentalViewSubmission
    _allow_batch = True


@tool_parameters(_structured_view_params(
    ["industry_context", "policy_context", "cycle_context", "event_calendar"]
))
class SubmitNewsViewTool(_BaseViewSubmitTool):
    _tool_name = "submit_news_view"
    _artifact_name = "news"
    _description = (
        "Submit industry, policy, cycle and event-calendar sections. Every "
        "claim must cite source ids from the current run's evidence bundle."
    )
    _single_model = NewsViewSubmission
    _allow_batch = True


@tool_parameters(_CASE_PARAMS)
class SubmitBullCaseTool(_BaseViewSubmitTool):
    _tool_name = "submit_bull_case"
    _artifact_name = "bull"
    _description = (
        "Submit a bull case with short_term, medium_term and long_term "
        "horizon_cases. Every nested claim must cite current-run evidence."
    )
    _single_model = HorizonCaseSubmission
    _allow_batch = True


@tool_parameters(_CASE_PARAMS)
class SubmitBearCaseTool(_BaseViewSubmitTool):
    _tool_name = "submit_bear_case"
    _artifact_name = "bear"
    _description = (
        "Submit a bear case with short_term, medium_term and long_term "
        "horizon_cases. Every nested claim must cite current-run evidence."
    )
    _single_model = HorizonCaseSubmission
    _allow_batch = True


@tool_parameters(_REPORT_PARAMS)
class SubmitStockReportTool(Tool):
    """Chairman submission: deep-research report or daily-review digest.

    Single-instrument payloads produce ``report.json`` + ``report.md``;
    batch ``items`` payloads produce ``digest.json`` + ``digest.md``
    (design §5.3). The report embeds references to the upstream view
    artifacts that exist for this run.
    """

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "submit_stock_report"

    @property
    def description(self) -> str:
        return (
            "Submit the final research report (deep research) or review "
            "digest (daily batch) as a structured artifact plus a markdown "
            "rendering. New stock deep research must submit schema_version=6 "
            "through submit_stock_report_staged(section=deep_v6), with "
            "qualitative three-horizon decisions only; prices, positions, "
            "risk-reward values, condition states and validity are injected "
            "from Evidence.derived_decision_metrics. Missing deterministic "
            "metrics fail finalize without writing report.json. V5 is kept "
            "only for historical non-stock callers and is blocked for the "
            "stock research room. Cite only current-run source ids."
        )

    async def execute(self, **kwargs: Any) -> str:
        ctx = _run_context(self._tool_ctx)
        if isinstance(ctx, str):
            return ctx
        model_generated_quant_fields = {
            "quant_validation",
            "quantValidation",
            "quant_snapshot",
            "quantSnapshot",
            "quant_signal",
            "quantSignal",
            "fusion_action",
            "fusionAction",
            "materialized_plan",
            "materializedPlan",
            "decision_mode",
            "decisionMode",
            "research_status",
            "researchStatus",
            "trade_status",
            "tradeStatus",
            "research_ready",
            "researchReady",
            "trade_ready",
            "tradeReady",
            "quant_promotion",
            "quantPromotion",
            "valuation",
            "execution_qualification",
        }
        attempted_quant_fields = sorted(model_generated_quant_fields.intersection(kwargs))
        if attempted_quant_fields:
            return (
                "Error: invalid payload: "
                "quantification fields are generated by the system and cannot be submitted by the model: "
                + ", ".join(attempted_quant_fields)
            )
        run_id, job_id = ctx
        try:
            payload = ReportSubmission.model_validate(kwargs)
        except ValidationError as exc:
            return f"Error: invalid payload: {exc}"
        v6_required, version_error = _v6_required_for_stock_run(
            self._workspace,
            run_id,
            getattr(self._tool_ctx, "room_id", None),
        )
        if version_error is not None:
            return version_error
        if payload.is_v5:
            if v6_required:
                return (
                    "错误：当前六 Agent 深度投研已升级为 V6，不能提交旧版 V5 报告；"
                    "请调用 submit_stock_report_staged(section=deep_v6)，"
                    "保存三周期结论后再调用 section=finalize。"
                )
            gap_error = _v5_submission_gap_error(payload)
            if gap_error is not None:
                return gap_error
        if payload.is_v6:
            gap_error = _v6_submission_gap_error(payload)
            if gap_error is not None:
                return gap_error
        if payload.is_v5 or payload.is_v6:
            instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
            bundle, bundle_error = _load_report_bundle(
                self._workspace, run_id, instrument_id
            )
            if bundle_error is not None or bundle is None:
                return bundle_error or "Error: instrument Evidence is unavailable."
            report_payload = payload.model_dump(mode="json")
            text_error = _public_text_error(report_payload)
            if text_error is not None:
                return text_error
            numeric_error = _numeric_closure_error(report_payload, bundle)
            if numeric_error is not None:
                return numeric_error
            if payload.is_v6:
                industry_error = _v6_industry_claim_error(report_payload, bundle)
                if industry_error is not None:
                    return industry_error
        cited = payload.all_source_ids()
        sources, error = _resolve_sources(self._workspace, run_id, cited)
        if error is not None:
            return error
        suffix = run_id.removeprefix("run_")
        from mona.config.paths import get_stock_project_dir

        run_dir = get_stock_project_dir(self._workspace, run_id)
        if payload.is_v6:
            doc, v6_error = _build_v6_report(self._workspace, run_id, payload)
            if v6_error is not None or doc is None:
                return v6_error or "Error: V6 report could not be built."
            markdown = _render_v6_md(doc)
            report_path = run_dir / "report.json"
            markdown_path = run_dir / "report.md"
            idempotent = False
            with _REPORT_WRITE_LOCK:
                if report_path.is_file():
                    try:
                        existing_doc = json.loads(report_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        return f"Error: immutable report is unreadable: {exc}"
                    if existing_doc != doc:
                        return (
                            f"Error: report {doc['report_id']} is immutable; "
                            "submit an identical payload for an idempotent retry."
                        )
                    if markdown_path.is_file():
                        if markdown_path.read_text(encoding="utf-8") != markdown:
                            return f"Error: report {doc['report_id']} markdown is immutable; submit an identical payload."
                    elif markdown_path.exists():
                        return f"Error: report {doc['report_id']} markdown is not a file."
                    else:
                        _atomic_write(markdown_path, markdown)
                    idempotent = True
                if markdown_path.is_file() and not idempotent:
                    return f"Error: report {doc['report_id']} has a companion markdown without report.json; refusing to overwrite."
                if not idempotent:
                    try:
                        ensure_v6_tracking_snapshot(run_dir, doc)
                    except (OSError, ValueError) as exc:
                        return f"Error: V6 outcome tracking snapshot: {exc}"
                    _atomic_write_json(report_path, doc)
                    _atomic_write(markdown_path, markdown)
                else:
                    try:
                        ensure_v6_tracking_snapshot(run_dir, doc)
                    except (OSError, ValueError) as exc:
                        return f"Error: V6 outcome tracking snapshot: {exc}"
            ref = ArtifactRef.for_path(
                owner_kind="product",
                owner_id=run_id,
                product="stock",
                root=run_dir,
                path=report_path,
                created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
                job_id=job_id,
                workflow_run_id=run_id,
                room_id=getattr(self._tool_ctx, "room_id", None),
            )
            run_artifacts.append(job_id, ref)
            suffix = " (idempotent)" if idempotent else ""
            return f"Submitted {doc['report_id']}: {ref.relative_path}{suffix}"
        if payload.is_v5:
            doc, v5_error = _build_v5_report(
                self._workspace, run_id, payload
            )
            if v5_error is not None or doc is None:
                return v5_error or "Error: V5 report could not be built."
            markdown = _render_v5_md(doc)
            report_path = run_dir / "report.json"
            markdown_path = run_dir / "report.md"
            idempotent = False
            with _REPORT_WRITE_LOCK:
                if report_path.is_file():
                    try:
                        existing_doc = json.loads(report_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        return f"Error: immutable report is unreadable: {exc}"
                    if existing_doc != doc:
                        return (
                            f"Error: report {doc['report_id']} is immutable; "
                            "submit an identical payload for an idempotent retry."
                        )
                    if markdown_path.is_file():
                        try:
                            existing_markdown = markdown_path.read_text(encoding="utf-8")
                        except OSError as exc:
                            return f"Error: immutable report is unreadable: {exc}"
                        if existing_markdown != markdown:
                            return (
                                f"Error: report {doc['report_id']} markdown is immutable; "
                                "submit an identical payload for an idempotent retry."
                            )
                    elif markdown_path.exists():
                        return f"Error: report {doc['report_id']} markdown is not a file."
                    else:
                        _atomic_write(markdown_path, markdown)
                    idempotent = True
                if markdown_path.is_file():
                    if not idempotent:
                        return (
                            f"Error: report {doc['report_id']} has a companion markdown "
                            "without report.json; refusing to overwrite."
                        )
                if not idempotent:
                    _atomic_write_json(report_path, doc)
                    _atomic_write(markdown_path, markdown)
            ref = ArtifactRef.for_path(
                owner_kind="product",
                owner_id=run_id,
                product="stock",
                root=run_dir,
                path=report_path,
                created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
                job_id=job_id,
                workflow_run_id=run_id,
                room_id=getattr(self._tool_ctx, "room_id", None),
            )
            run_artifacts.append(job_id, ref)
            suffix = " (idempotent)" if idempotent else ""
            return f"Submitted {doc['report_id']}: {ref.relative_path}{suffix}"
        if payload.is_digest:
            doc: dict[str, Any] = {
                "schema_version": DIGEST_SCHEMA_VERSION,
                "report_id": f"stock_digest_{suffix}",
                "kind": "daily_review",
                "workflow_run_id": run_id,
                "as_of": payload.as_of,
                "summary": payload.summary,
                "items": [item.model_dump() for item in payload.items or []],
                "source_ids": cited,
                "sources": sources,
                "disclaimer": DISCLAIMER,
            }
            markdown = _render_digest_md(doc)
            stem = "digest"
        else:
            bundle, error = _validate_report_refs(self._workspace, run_id, payload)
            if error is not None or bundle is None:
                return error or "Error: current run Evidence is unavailable."
            selection_origin, origin_error = _trusted_selection_origin(
                self._workspace, run_id
            )
            if origin_error is not None:
                return origin_error
            instrument_id = f"{payload.instrument.exchange}:{payload.instrument.symbol}"
            trusted_event_calendar = _trusted_event_calendar(bundle)
            if trusted_event_calendar is not None:
                (
                    trusted_event_source_ids,
                    trusted_event_sources,
                    event_source_error,
                ) = _resolve_trusted_event_sources(bundle, trusted_event_calendar)
                if event_source_error is not None:
                    return event_source_error
                source_positions = {
                    source.get("id"): index
                    for index, source in enumerate(sources)
                    if source.get("id")
                }
                for source_id, source in zip(
                    trusted_event_source_ids, trusted_event_sources
                ):
                    if source_id not in cited:
                        cited.append(source_id)
                    if source_id in source_positions:
                        # Prefer the exact target-instrument Evidence record
                        # if a same-id citation was resolved from another
                        # symbol by the initial run-wide lookup.
                        sources[source_positions[source_id]] = source
                    else:
                        sources.append(source)
                        source_positions[source_id] = len(sources) - 1
            trusted_quant_validation = _trusted_quant_validation(bundle)
            research_cutoff_at = bundle.get("research_cutoff_at")
            market_as_of = bundle.get("market_as_of")
            doc = {
                "schema_version": REPORT_SCHEMA_VERSION,
                "report_id": f"stock_report_{suffix}",
                "kind": "deep_research",
                "workflow_run_id": run_id,
                "instrument": payload.instrument.model_dump(),
                "as_of": payload.as_of or research_cutoff_at or market_as_of,
                "research_cutoff_at": research_cutoff_at,
                "market_as_of": market_as_of,
                "summary": payload.summary,
                "horizon_views": _materialize_horizon_views(payload, bundle),
                "dimension_views": _materialize_dimension_views(payload, bundle, sources),
                "debate_resolution": payload.debate_resolution.model_dump(),
                "cycle_states": payload.cycle_states.model_dump(),
                "market_regime_summary": payload.market_regime_summary.model_dump(),
                "industry_policy_summary": payload.industry_policy_summary.model_dump(),
                "scenario_sets": payload.scenario_sets.model_dump(),
                "cross_horizon_conflict": {
                    "status": _derived_conflict_status(payload),
                    **payload.cross_horizon_conflict.model_dump(),
                },
                "evidence_coverage": bundle.get("evidence_coverage") or {},
                "outcome_tracking_id": _outcome_tracking_id(run_id, instrument_id),
                "analyst_views": _existing_refs(
                    run_dir, run_id, ("technical", "fundamental", "news")
                ),
                "debate": _existing_refs(run_dir, run_id, ("bull", "bear")),
                "risks": [point.model_dump() for point in payload.risks],
                "catalysts": [point.model_dump() for point in payload.catalysts],
                "open_questions": [point.model_dump() for point in payload.open_questions],
                "source_ids": cited,
                "sources": sources,
                "versions": payload.versions,
                "disclaimer": DISCLAIMER,
            }
            if trusted_quant_validation is not None:
                doc["quant_validation"] = trusted_quant_validation
            if selection_origin is not None:
                doc["selection_origin"] = selection_origin
            if trusted_event_calendar is not None:
                doc["event_calendar"] = trusted_event_calendar
            cited, sources, source_closure_error = _complete_report_source_closure(
                self._workspace, run_id, doc, cited, sources
            )
            if source_closure_error is not None:
                return source_closure_error
            doc["source_ids"] = cited
            doc["sources"] = sources
            markdown = _render_report_md(doc)
            stem = "report"
            report_path = run_dir / f"{stem}.json"
            markdown_path = run_dir / f"{stem}.md"
            with _REPORT_WRITE_LOCK:
                if report_path.is_file():
                    try:
                        existing_doc = json.loads(report_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        return f"Error: immutable report is unreadable: {exc}"
                    if markdown_path.is_file():
                        try:
                            existing_markdown = markdown_path.read_text(encoding="utf-8")
                        except OSError as exc:
                            return f"Error: immutable report is unreadable: {exc}"
                    if existing_doc != doc:
                        return (
                            f"Error: report {doc['report_id']} is immutable; "
                            "submit an identical payload for an idempotent retry."
                        )
                    if markdown_path.is_file() and existing_markdown != markdown:
                        return (
                            f"Error: report {doc['report_id']} is immutable; "
                            "submit an identical payload for an idempotent retry."
                        )
                    try:
                        # Verify the immutable prediction snapshot on retries;
                        # this call does not rewrite an identical snapshot.
                        ensure_outcome_tracking_snapshot(run_dir, doc)
                    except (OSError, ValueError) as exc:
                        return f"Error: outcome tracking snapshot: {exc}"
                    if not markdown_path.is_file():
                        try:
                            # A crash after report.json but before report.md is
                            # recoverable only for the identical immutable doc.
                            _atomic_write(markdown_path, markdown)
                        except OSError as exc:
                            return f"Error: immutable report companion: {exc}"
                        return f"Submitted {doc['report_id']}: {report_path.name} (recovered)"
                    return f"Submitted {doc['report_id']}: {report_path.name} (idempotent)"
                if markdown_path.is_file():
                    return (
                        f"Error: report {doc['report_id']} has a companion markdown "
                        "without report.json; refusing to overwrite."
                    )
                try:
                    # The snapshot is written once from the report's immutable
                    # decision fields. Later outcome observations never rewrite
                    # report.json or this file.
                    ensure_outcome_tracking_snapshot(run_dir, doc)
                except (OSError, ValueError) as exc:
                    return f"Error: outcome tracking snapshot: {exc}"
                _atomic_write_json(report_path, doc)
                _atomic_write(markdown_path, markdown)
        if payload.is_digest:
            _atomic_write_json(run_dir / f"{stem}.json", doc)
            _atomic_write(run_dir / f"{stem}.md", markdown)
        ref = ArtifactRef.for_path(
            owner_kind="product",
            owner_id=run_id,
            product="stock",
            root=run_dir,
            path=run_dir / f"{stem}.json",
            created_by_agent_id=getattr(self._tool_ctx, "agent_id", "mona"),
            job_id=job_id,
            workflow_run_id=run_id,
            room_id=getattr(self._tool_ctx, "room_id", None),
        )
        run_artifacts.append(job_id, ref)
        return f"Submitted {doc['report_id']}: {ref.relative_path}"


_STAGED_SECTION_FIELDS: dict[str, tuple[str, ...]] = {
    "deep_v6": (
        "summary",
        "instrument",
        "horizon_decisions_v6",
    ),
    "deep_v5": (
        "summary",
        "instrument",
        "horizon_decisions_v5",
    ),
    "deep_dimensions": (
        "as_of",
        "summary",
        "source_ids",
        "instrument",
        "versions",
        "dimension_views",
    ),
    "deep_decision": (
        "horizon_views",
        "debate_resolution",
        "cross_horizon_conflict",
    ),
    "deep_context": (
        "cycle_states",
        "market_regime_summary",
        "industry_policy_summary",
        "scenario_sets",
        "risks",
        "catalysts",
        "open_questions",
    ),
    "daily_digest": ("as_of", "items"),
}
_STAGED_SECTIONS = tuple((*_STAGED_SECTION_FIELDS, "finalize"))
_STAGED_DEEP_SECTIONS = frozenset(
    {"deep_dimensions", "deep_decision", "deep_context"}
)
_STAGED_NESTED_KEYS: dict[str, tuple[str, ...]] = {
    "horizon_decisions_v6": ("short_term", "medium_term", "long_term"),
    "horizon_decisions_v5": ("short_term", "medium_term", "long_term"),
    "dimension_views": tuple(ANALYSIS_DIMENSION_KEYS),
    "horizon_views": ("short_term", "medium_term", "long_term"),
    "debate_resolution": ("short_term", "medium_term", "long_term"),
    "cycle_states": ("policy", "industry", "earnings", "valuation"),
    "scenario_sets": ("short_term", "medium_term", "long_term"),
}
_STAGED_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "deep_v6": (
        "summary",
        "instrument",
        "horizon_decisions_v6",
    ),
    "deep_v5": (
        "summary",
        "instrument",
        "horizon_decisions_v5.short_term",
        "horizon_decisions_v5.medium_term",
        "horizon_decisions_v5.long_term",
    ),
    "deep_dimensions": ("summary", "instrument", "dimension_views"),
    "deep_decision": (
        "horizon_views.short_term",
        "horizon_views.medium_term",
        "horizon_views.long_term",
        "debate_resolution.short_term",
        "debate_resolution.medium_term",
        "debate_resolution.long_term",
        "cross_horizon_conflict",
    ),
    "deep_context": (
        "cycle_states.policy",
        "cycle_states.industry",
        "cycle_states.earnings",
        "cycle_states.valuation",
        "market_regime_summary",
        "industry_policy_summary",
        "scenario_sets.short_term",
        "scenario_sets.medium_term",
        "scenario_sets.long_term",
    ),
    "daily_digest": ("as_of", "items"),
}
_STAGED_NESTED_ADAPTERS: dict[str, TypeAdapter] = {
    "horizon_decisions_v6": TypeAdapter(V6HorizonDecisionSubmission),
    "horizon_decisions_v5": TypeAdapter(V5HorizonDecisionSubmission),
    "dimension_views": TypeAdapter(AnalysisDimension),
    "horizon_views": TypeAdapter(HorizonView),
    "debate_resolution": TypeAdapter(DebateResolution),
    "cycle_states": TypeAdapter(CycleState),
    "scenario_sets": TypeAdapter(ScenarioSet),
}

# The full Report V4 JSON schema is deliberately not repeated here.  These
# adapters validate each submitted section with the same Pydantic field types
# used by ReportSubmission, while keeping the model-visible staged schema
# small.  Deep ``as_of`` remains nullable because the existing final tool
# derives its trusted timestamp from Evidence.
_STAGED_FIELD_ADAPTERS: dict[str, TypeAdapter] = {
    "as_of": TypeAdapter(str | None),
    "summary": TypeAdapter(Annotated[str, Field(min_length=1)]),
    "source_ids": TypeAdapter(list[str]),
    "instrument": TypeAdapter(InstrumentTag),
    "versions": TypeAdapter(dict[str, str]),
    # The five nested containers are validated incrementally below; their
    # full ReportSubmission models remain the final authority at finalize.
    "dimension_views": TypeAdapter(DimensionViews),
    "horizon_views": TypeAdapter(HorizonViews),
    "debate_resolution": TypeAdapter(DebateResolutions),
    "cross_horizon_conflict": TypeAdapter(CrossHorizonConflict),
    "cycle_states": TypeAdapter(CycleStates),
    "market_regime_summary": TypeAdapter(SummarySection),
    "industry_policy_summary": TypeAdapter(SummarySection),
    "scenario_sets": TypeAdapter(ScenarioSets),
    "risks": TypeAdapter(list[ViewPoint]),
    "catalysts": TypeAdapter(list[ViewPoint]),
    "open_questions": TypeAdapter(list[ViewPoint]),
    "items": TypeAdapter(list[DigestItem]),
}
_STAGED_DAILY_AS_OF_ADAPTER = TypeAdapter(Annotated[str, Field(min_length=1)])
_STAGED_PARAMS = {
    "type": "object",
    "properties": {
        "section": {
            "type": "string",
            "enum": list(_STAGED_SECTIONS),
            "description": "Draft section to save, or finalize to submit the complete report",
        },
        "payload": {
            "type": "object",
            "description": "Partial section object; nested maps may be sent incrementally; omit for finalize",
            "additionalProperties": True,
        },
    },
    "required": ["section"],
    "additionalProperties": False,
}


def _staged_report_summary(merged: dict[str, Any]) -> str:
    """Build the deep-report summary only after all three decisions exist."""
    stance_labels = {
        "positive": "偏多",
        "neutral": "中性",
        "negative": "偏空",
        "insufficient_data": "数据不足",
    }
    horizon_labels = {
        "short_term": "短线",
        "medium_term": "中线",
        "long_term": "长线",
    }
    gap_labels = {
        "market_regime": "市场环境",
        "market_snapshot": "市场环境",
        "quote": "市场环境",
        "kline": "市场环境",
        "industry": "行业信息",
        "industry_context": "行业信息",
        "policy": "政策信息",
        "policy_context": "政策信息",
        "cycle": "周期判断",
        "cycle_context": "周期判断",
        "company_quality": "公司质量",
        "valuation": "估值",
        "peer_valuation": "同行估值比较",
        "capital_positioning": "资金与筹码",
        "tradeability": "可交易性",
        "event": "事件风险",
        "event_calendar": "事件风险",
        "fundamentals": "财务数据",
        "debate_evidence": "多空证据",
        "short_term_debate": "短线多空裁决",
        "medium_term_debate": "中线多空裁决",
        "long_term_debate": "长线多空裁决",
    }

    def claim(points: Any, fallback: str) -> str:
        if isinstance(points, list):
            for point in points:
                if isinstance(point, dict) and isinstance(point.get("claim"), str):
                    text = point["claim"].strip()
                    if text:
                        return text[:160]
        return fallback

    views = merged.get("horizon_views") or {}
    resolutions = merged.get("debate_resolution") or {}
    parts: list[str] = []
    for key in ("short_term", "medium_term", "long_term"):
        view = views.get(key) or {}
        resolution = resolutions.get(key) or {}
        missing: list[str] = []
        for value in list(view.get("missing_fields") or []) + list(
            resolution.get("missing_fields") or []
        ):
            if not isinstance(value, str) or not value:
                continue
            label = gap_labels.get(value, value)
            if label not in missing:
                missing.append(label)
        gaps = "、".join(missing) if missing else "未披露"
        parts.append(
            f"{horizon_labels[key]}（{stance_labels.get(view.get('stance'), view.get('stance') or '未提供')}）："
            f"{view.get('thesis') or '未提供周期结论'}；"
            f"支持：{claim(view.get('drivers'), '未提供')}；"
            f"反证/风险：{claim(resolution.get('bear_case'), '未提供')}；"
            f"缺口：{gaps}"
        )
    conflict = merged.get("cross_horizon_conflict") or {}
    explanation = conflict.get("explanation")
    if isinstance(explanation, str) and explanation.strip():
        parts.append(f"跨周期：{explanation.strip()[:240]}")
    return "；".join(parts)


@tool_parameters(_STAGED_PARAMS)
class SubmitStockReportStagedTool(Tool):
    """Small model-facing staged writer for the final Report V4 submission.

    Drafts live only on this tool instance and are keyed by trusted run/job
    context.  Nothing is persisted until ``finalize`` delegates the complete
    payload to :class:`SubmitStockReportTool`, so the existing immutable,
    provenance, metric and coverage gates remain the only final authority.
    """

    _scopes = {"subagent"}

    def __init__(self, workspace: str | Path, tool_ctx: Any):
        self._workspace = Path(workspace)
        self._tool_ctx = tool_ctx
        self._drafts: dict[tuple[str, str], dict[str, Any]] = {}

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=ctx.workspace, tool_ctx=ctx)

    @property
    def name(self) -> str:
        return "submit_stock_report_staged"

    @property
    def description(self) -> str:
        return (
            "Incrementally stage V6 deep-research fields in memory, then call "
            "finalize to run the complete trusted submit_stock_report validation. "
            "Use deep_v6 for the three-horizon qualitative decisions, or "
            "daily_digest for daily review; finalize has no payload. Historical "
            "V5 staging is blocked for the stock research room."
        )

    def _draft_key(self, ctx: tuple[str, str]) -> tuple[str, str]:
        return ctx

    @staticmethod
    def _error(message: str) -> str:
        return f"Error: {message}"

    @staticmethod
    def _nested_field_error(field: str, value: Any) -> str | None:
        """Validate a partial named map and return a copied normalized map."""
        if not isinstance(value, dict):
            return f"{field} must be an object"
        allowed = set(_STAGED_NESTED_KEYS[field])
        unknown = sorted(set(value) - allowed)
        if unknown:
            return f"{field} has unknown keys: {', '.join(unknown)}"
        adapter = _STAGED_NESTED_ADAPTERS[field]
        for key, item in value.items():
            try:
                adapter.validate_python(item)
            except (TypeError, ValueError, ValidationError) as exc:
                return f"invalid {field}.{key}: {exc}"
        return None

    @staticmethod
    def _merge_payload(
        section: str,
        existing: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Merge one validated section without exposing a mutable draft."""
        merged = deepcopy(existing)
        for field, value in payload.items():
            if field in _STAGED_NESTED_KEYS:
                target = merged.setdefault(field, {})
                target.update(deepcopy(value))
            elif section == "deep_context" and field in {
                "risks",
                "catalysts",
                "open_questions",
            }:
                target = merged.setdefault(field, [])
                for item in value:
                    if item not in target:
                        target.append(deepcopy(item))
            else:
                # Scalars and complete section values are intentionally
                # replaceable so a failed validation can be repaired.
                merged[field] = deepcopy(value)
        return merged

    @staticmethod
    def _stored_keys(section: str, data: dict[str, Any]) -> list[str]:
        stored: list[str] = []
        for field in _STAGED_SECTION_FIELDS[section]:
            if field not in data:
                continue
            if field in _STAGED_NESTED_KEYS:
                stored.extend(
                    f"{field}.{key}" for key in _STAGED_NESTED_KEYS[field] if key in data[field]
                )
            else:
                stored.append(field)
        return stored

    @staticmethod
    def _missing_keys(draft: dict[str, Any]) -> list[str]:
        """Return only keys still needed by the final ReportSubmission."""
        mode = draft.get("mode")
        sections = draft.get("sections") or {}
        if mode == "daily":
            data = sections.get("daily_digest")
            if data is None:
                return ["daily_digest"]
            return [
                key for key in _STAGED_REQUIRED_FIELDS["daily_digest"] if key not in data
            ]
        if mode == "deep_v6":
            data = sections.get("deep_v6")
            if data is None:
                return ["deep_v6"]
            missing: list[str] = []
            for key in ("summary", "instrument"):
                if key not in data:
                    missing.append(f"deep_v6.{key}")
            if not any(
                data.get("horizon_decisions_v6", {}).get(horizon) is not None
                for horizon in _V5_HORIZONS
            ):
                missing.append("deep_v6.horizon_decisions_v6.at_least_one_horizon")
            return missing
        if mode == "deep_v5":
            data = sections.get("deep_v5")
            if data is None:
                return ["deep_v5"]
            missing: list[str] = []
            for key in _STAGED_REQUIRED_FIELDS["deep_v5"]:
                if "." in key:
                    field, nested = key.split(".", 1)
                    if nested not in (data.get(field) or {}):
                        missing.append(f"deep_v5.{key}")
                elif key not in data:
                    missing.append(f"deep_v5.{key}")
            return missing
        if mode != "deep":
            return list(_STAGED_DEEP_SECTIONS)
        missing: list[str] = []
        for section in ("deep_dimensions", "deep_decision", "deep_context"):
            data = sections.get(section)
            if data is None:
                missing.append(section)
                continue
            for key in _STAGED_REQUIRED_FIELDS[section]:
                if "." in key:
                    field, nested = key.split(".", 1)
                    if nested not in (data.get(field) or {}):
                        missing.append(f"{section}.{key}")
                elif key in _STAGED_NESTED_KEYS:
                    for nested in _STAGED_NESTED_KEYS[key]:
                        if nested not in (data.get(key) or {}):
                            missing.append(f"{section}.{key}.{nested}")
                elif key not in data:
                    missing.append(f"{section}.{key}")
        return missing

    def _progress_response(self, section: str, draft: dict[str, Any]) -> str:
        sections = draft.get("sections") or {}
        stored = self._stored_keys(section, sections.get(section) or {})
        missing = self._missing_keys(draft)
        stored_label = ", ".join(stored) or "none"
        missing_label = ", ".join(missing) or "none"
        return f"Saved {section}: {stored_label}; missing: {missing_label}"

    def _validate_section_payload(
        self, section: str, payload: Any
    ) -> tuple[dict[str, Any] | None, str | None]:
        if not isinstance(payload, dict):
            return None, self._error(f"{section} payload must be an object")
        allowed = set(_STAGED_SECTION_FIELDS[section])
        unknown = sorted(set(payload) - allowed)
        if unknown:
            return None, self._error(
                f"{section} payload has unknown fields: {', '.join(unknown)}"
            )
        for field, value in payload.items():
            if field == "as_of" and section == "deep_dimensions" and value is not None:
                return None, self._error(
                    "deep research as_of must be null or omitted; "
                    "the final report timestamp is trusted from Evidence"
                )
            if field in _STAGED_NESTED_KEYS:
                error = self._nested_field_error(field, value)
                if error is not None:
                    return None, self._error(error)
                continue
            adapter = _STAGED_FIELD_ADAPTERS[field]
            if section == "daily_digest" and field == "as_of":
                adapter = _STAGED_DAILY_AS_OF_ADAPTER
            try:
                adapter.validate_python(value)
            except (TypeError, ValueError, ValidationError) as exc:
                return None, self._error(f"invalid {section}.{field}: {exc}")
        return deepcopy(payload), None

    async def execute(self, **kwargs: Any) -> str:
        unknown_args = sorted(set(kwargs) - {"section", "payload"})
        if unknown_args:
            return self._error(
                f"unsupported parameters: {', '.join(unknown_args)}"
            )
        section = kwargs.get("section")
        if section not in _STAGED_SECTIONS:
            return self._error(
                f"section must be one of {', '.join(_STAGED_SECTIONS)}"
            )
        ctx = _run_context(self._tool_ctx)
        if isinstance(ctx, str):
            return ctx
        key = self._draft_key(ctx)
        v6_required, version_error = _v6_required_for_stock_run(
            self._workspace,
            ctx[0],
            getattr(self._tool_ctx, "room_id", None),
        )
        if version_error is not None:
            return version_error
        if section == "deep_v5" and v6_required:
            return self._error(
                "当前六 Agent 深度投研已升级为 V6，不能暂存旧版 V5 报告；"
                "请使用 section=deep_v6。"
            )
        if section == "finalize":
            if "payload" in kwargs:
                return self._error("finalize does not accept payload")
            draft = self._drafts.get(key)
            if draft is None:
                return self._error("no staged sections to finalize")
            mode = draft["mode"]
            sections = draft["sections"]
            if mode == "deep_v6":
                missing = self._missing_keys(draft)
                if missing:
                    return self._error(
                        "V6 deep research finalize is missing keys: "
                        + ", ".join(missing)
                    )
                v6_data = deepcopy(sections["deep_v6"])
                merged = {
                    "schema_version": 6,
                    "summary": v6_data["summary"],
                    "instrument": v6_data["instrument"],
                    "horizon_decisions_v6": v6_data["horizon_decisions_v6"],
                }
            elif mode == "deep_v5":
                missing = self._missing_keys(draft)
                if missing:
                    return self._error(
                        "V5 deep research finalize is missing keys: "
                        + ", ".join(missing)
                    )
                v5_data = deepcopy(sections["deep_v5"])
                merged = {
                    "schema_version": 5,
                    "summary": v5_data["summary"],
                    "instrument": v5_data["instrument"],
                    "horizon_decisions": v5_data["horizon_decisions_v5"],
                }
            elif mode == "deep":
                missing = self._missing_keys(draft)
                if missing:
                    return self._error(
                        "deep research finalize is missing keys: "
                        + ", ".join(missing)
                    )
                merged: dict[str, Any] = {}
                for staged_section in (
                    "deep_dimensions",
                    "deep_decision",
                    "deep_context",
                ):
                    merged.update(sections[staged_section])
                # Dimension agents may each send a local summary.  It is not
                # the report summary; only the completed three-horizon
                # decision set can form that user-facing statement.
                merged["summary"] = _staged_report_summary(merged)
            elif mode == "daily":
                missing = self._missing_keys(draft)
                if missing:
                    return self._error(
                        "daily review finalize is missing keys: "
                        + ", ".join(missing)
                    )
                # ReportSubmission keeps a common summary field for both
                # modes; the staged daily contract intentionally only asks
                # the model for as_of/items, so use the stable product label.
                merged = {
                    "summary": "每日复盘简报",
                    **deepcopy(sections["daily_digest"]),
                }
            else:
                return self._error("staged draft has no valid mode")

            result = await SubmitStockReportTool(
                workspace=self._workspace,
                tool_ctx=self._tool_ctx,
            ).execute(**merged)
            if isinstance(result, str) and result.startswith("Error"):
                # Keep the draft so the model can replace only the bad
                # section and retry finalization.
                return result
            self._drafts.pop(key, None)
            return result

        if "payload" not in kwargs:
            return self._error(f"{section} requires payload")
        payload, error = self._validate_section_payload(section, kwargs["payload"])
        if error is not None or payload is None:
            return error or self._error(f"invalid {section} payload")

        draft = self._drafts.setdefault(
            key,
            {"mode": None, "sections": {}},
        )
        mode = (
            "daily"
            if section == "daily_digest"
            else "deep_v6"
            if section == "deep_v6"
            else "deep_v5"
            if section == "deep_v5"
            else "deep"
        )
        if draft["mode"] is not None and draft["mode"] != mode:
            return self._error("cannot mix deep research and daily review sections")
        draft["mode"] = mode
        draft["sections"][section] = self._merge_payload(
            section,
            draft["sections"].get(section) or {},
            payload,
        )
        return self._progress_response(section, draft)


def _render_v6_md(doc: dict) -> str:
    labels = {"short_term": "短线", "medium_term": "中线", "long_term": "长线"}
    direction_labels = {"positive": "看涨", "neutral": "震荡", "negative": "看跌", "avoid": "回避"}
    action_labels = {
        "conditional_participation": "满足条件参与",
        "wait": "等待",
        "hold": "继续持有",
        "reduce": "减仓",
        "exit": "退出",
        "avoid": "回避",
    }
    lines = [
        f"# {doc['instrument'].get('name') or doc['instrument']['symbol']}交易结论",
        "",
        f"- 决策模式：{'参考计划' if doc['decision_mode'] == 'reference_plan' else '研究模式'}",
        f"- 研究截止：{doc['research_cutoff_at']}",
        f"- 行情截至：{doc['market_as_of']}",
        "",
        "## 研究总结",
        doc["summary"],
        "",
    ]
    for horizon in _V5_HORIZONS:
        decision = doc["horizon_decisions"][horizon]
        lines.extend(
            [
                f"## {labels[horizon]}",
                f"- 方向：{direction_labels[decision['direction']]}",
                f"- 当前操作：{action_labels[decision['action']]}",
                f"- 研究状态：{'可形成结论' if decision['research_status'] == 'ready' else '该周期暂不形成结论'}",
                f"- 交易状态：{'具备参考计划资格' if decision['trade_status'] == 'ready' else '仅保留研究结论'}",
                f"- 核心判断：{decision['thesis']}",
                f"- 有效期：{decision.get('valid_until') or '补齐数据后重新评估'}",
                f"- 复评条件：{decision['review_trigger']}",
            ]
        )
        plan = decision.get("materialized_plan")
        if isinstance(plan, dict):
            if plan.get("buy_low") is not None:
                lines.append(f"- 参考参与区间：{plan['buy_low']:.2f}—{plan['buy_high']:.2f}元")
            if plan.get("stop_loss") is not None:
                lines.append(f"- 止损参考：{plan['stop_loss']:.2f}元")
            if plan.get("first_take_profit") is not None:
                lines.append(f"- 第一止盈：{plan['first_take_profit']:.2f}元")
        else:
            lines.append("- 交易计划：当前不生成参考价格或仓位")
        lines.append("")
    return "\n".join(lines)


def _render_v5_md(doc: dict) -> str:
    inst = doc["instrument"]
    label = f"{inst.get('name') or inst['symbol']}（{inst['symbol']}）"
    lines = [
        f"# {label}交易计划",
        "",
        f"- 研究截止：{doc['research_cutoff_at']}",
        f"- 行情截至：{doc['market_as_of']}",
        f"- 生成时间：{doc['generated_at']}",
        "",
        "## 研究结论",
        doc["summary"],
        "",
    ]
    labels = {"short_term": "短线", "medium_term": "中线", "long_term": "长线"}
    direction_labels = {"positive": "看涨", "neutral": "震荡", "negative": "看跌"}
    action_labels = {
        "conditional_participation": "满足条件参与",
        "wait": "等待",
        "hold": "继续持有",
        "reduce": "减仓",
        "exit": "退出",
        "avoid": "回避",
    }
    not_holding_labels = {"participate": "按条件参与", "wait": "等待", "avoid": "回避"}
    holding_labels = {"hold": "继续持有", "reduce": "减仓", "exit": "退出"}
    currency_labels = {"CNY": "元"}
    for horizon in _V5_HORIZONS:
        decision = doc["horizon_decisions"][horizon]
        plan = decision["trading_plan"]
        position = decision["position_plan"]
        lines.extend(
            [
                f"## {labels[horizon]}",
                f"- 方向：{direction_labels[decision['direction']]}",
                f"- 当前操作：{action_labels[decision['action']]}",
                f"- 未持有：{not_holding_labels[decision['not_holding_action']]}",
                f"- 已持有：{holding_labels[decision['holding_action']]}",
                f"- 核心判断：{decision['thesis']}",
                f"- 参考买入：{plan['reference_buy_low']:.2f}—{plan['reference_buy_high']:.2f}{currency_labels[plan['currency']]}",
                f"- 回踩买入：{plan['pullback_buy_low']:.2f}—{plan['pullback_buy_high']:.2f}{currency_labels[plan['currency']]}",
                f"- 止损参考：{plan['stop_loss']:.2f}{currency_labels[plan['currency']]}",
                f"- 第一止盈：{plan['first_take_profit']:.2f}{currency_labels[plan['currency']]}",
                f"- 第二止盈：{plan['second_take_profit']:.2f}{currency_labels[plan['currency']]}",
                f"- 首仓/最大仓位：{position['initial_position_pct']:.2f}%/{position['max_position_pct']:.2f}%",
                f"- 有效期：{decision['valid_until']}",
                f"- 复评条件：{decision['review_trigger']}",
                "",
            ]
        )
    return "\n".join(lines)


def _render_report_md(doc: dict) -> str:
    inst = doc["instrument"]
    label = f"{inst.get('name') or inst['symbol']}（{inst['symbol']}）"
    lines = [
        f"# {label}研究报告",
        "",
        f"- 研究截止：{doc.get('research_cutoff_at') or '未提供'}",
        f"- 行情截至：{doc.get('market_as_of') or '未提供'}",
        f"- 结果追踪：{doc['outcome_tracking_id']}",
        "",
        "## 研究摘要",
        doc["summary"],
        "",
    ]
    lines += ["## 八维分析"]
    dimension_labels = {
        "market_environment": "市场环境",
        "industry": "行业",
        "policy": "政策",
        "cycle": "周期",
        "company_quality": "公司质量",
        "valuation": "估值",
        "capital_positioning": "资金筹码",
        "event_risk": "事件风险",
    }
    for key, title in dimension_labels.items():
        dimension = doc["dimension_views"][key]
        timing = "；".join(
            value for value in (
                f"研究截止 {dimension.get('research_cutoff_at')}" if dimension.get("research_cutoff_at") else "",
                f"行情截至 {dimension.get('market_as_of')}" if dimension.get("market_as_of") else "",
                f"公开于 {dimension.get('published_at')}" if dimension.get("published_at") else "",
                f"统计期末 {dimension.get('period_end')}" if dimension.get("period_end") else "",
            )
            if value
        )
        lines += [f"### {title}：{dimension['status']}", dimension["summary"]]
        if timing:
            lines.append(f"- 时点：{timing}")
        _append_claims(lines, "事实", dimension.get("facts"))
        _append_claims(lines, "推断", dimension.get("inferences"))
        _append_claims(lines, "假设", dimension.get("hypotheses"))
        if dimension.get("missing_fields"):
            lines.append(f"- 缺失字段：{', '.join(dimension['missing_fields'])}")
    lines.append("")
    event_calendar = doc.get("event_calendar")
    if isinstance(event_calendar, dict):
        lines += [
            "## 事件日历",
            f"- 状态：{event_calendar.get('status') or 'missing'}",
        ]
        for event in event_calendar.get("events") or []:
            if not isinstance(event, dict):
                continue
            date_label = event.get("event_date") or "日期未提供"
            lines.append(
                f"- {event.get('title') or '未命名事件'}；类型：{event.get('event_type') or '未分类'}；"
                f"发布日期：{event.get('published_at') or '未提供'}；事件日：{date_label}；"
                f"状态：{event.get('status') or '未提供'}"
            )
        if event_calendar.get("missing_fields"):
            lines.append(
                f"- 缺失字段：{', '.join(event_calendar['missing_fields'])}"
            )
        lines.append("")
    lines.append("## 多空裁决")
    horizon_labels = {
        "short_term": "短线（1—10个交易日）",
        "medium_term": "中线（2周—6个月）",
        "long_term": "长线（6个月以上）",
    }
    for horizon, title in horizon_labels.items():
        resolution = doc["debate_resolution"][horizon]
        lines += [
            f"### {title}：{resolution['status']}",
            f"- 核心分歧：{resolution['issue']}",
        ]
        _append_claims(lines, "多方论据", resolution.get("bull_case"))
        _append_claims(lines, "空方论据", resolution.get("bear_case"))
        _append_claims(lines, "裁决理由", resolution.get("verdict"))
        _append_conditions(lines, "改变结论的条件", resolution.get("change_conditions"))
        if resolution.get("missing_fields"):
            lines.append(f"- 缺失字段：{', '.join(resolution['missing_fields'])}")
        lines.append("")

    for horizon, title in horizon_labels.items():
        view = doc["horizon_views"][horizon]
        lines += [
            f"## {title}",
            f"- 观点：{view['stance']}；状态：{view['status']}；数据：{view['data_status']}",
            f"- 结论：{view['thesis']}",
            f"- 基准：{view['benchmark']['name']}"
            f"（{view['benchmark'].get('instrument_id') or '代码未提供'}；{view['benchmark']['relative_view']}）",
            f"- 基准依据：{view['benchmark'].get('basis') or '无法判断'}",
            f"- 已计价：{view['priced_in']}；研究动作：{view['action']}",
            f"- 时间退出：{view['time_stop']}",
        ]
        _append_claims(lines, "驱动与依据", view.get("drivers"))
        _append_claims(
            lines,
            "已计价依据",
            [view["priced_in_basis"]] if view.get("priced_in_basis") else [],
        )
        _append_conditions(lines, "参与条件", view.get("participation_conditions"))
        _append_conditions(lines, "确认条件", view.get("confirmation_conditions"))
        _append_conditions(lines, "观察条件", view.get("watch_conditions"))
        _append_conditions(lines, "失效条件", view.get("invalidation_conditions"))
        _append_conditions(lines, "止损条件", view.get("stop_loss_conditions"))
        _append_conditions(lines, "止盈条件", view.get("take_profit_conditions"))
        _append_claims(lines, "可交易性风险", view.get("tradeability_risks"))
        _append_claims(lines, "数据盲区", view.get("blind_spots"))
        if view.get("missing_fields"):
            lines.append(f"- 缺失字段：{', '.join(view['missing_fields'])}")
        lines.append("")

    for title, key in (
        ("市场环境摘要", "market_regime_summary"),
        ("行业与政策摘要", "industry_policy_summary"),
    ):
        section = doc[key]
        lines += [f"## {title}", f"- 状态：{section['status']}", section["summary"]]
        _append_claims(lines, "依据", section.get("points"))
        if section.get("missing_fields"):
            lines.append(f"- 缺失字段：{', '.join(section['missing_fields'])}")
        lines.append("")

    lines.append("## 四类周期")
    cycle_labels = {
        "policy": "宏观与流动性周期",
        "industry": "行业供需与产品价格周期",
        "earnings": "公司盈利与现金流周期",
        "valuation": "市场风格与筹码周期",
    }
    for key, title in cycle_labels.items():
        cycle = doc["cycle_states"][key]
        lines.append(f"### {title}：{cycle['status']}｜{cycle['stage']}")
        lines.append(f"- 观察窗口：{cycle['observation_window']}")
        lines.append(f"- 可信度：{cycle['evidence_strength']}")
        _append_claims(lines, "领先/确认指标", cycle.get("leading_indicators", []) + cycle.get("confirmation_indicators", []))
        _append_conditions(lines, "转折条件", cycle.get("turning_conditions"))
        if cycle.get("missing_fields"):
            lines.append(f"- 缺失字段：{', '.join(cycle['missing_fields'])}")
    lines.append("")

    lines.append("## 三种情景")
    for horizon, title in horizon_labels.items():
        lines.append(f"### {title}")
        for key, name in (("optimistic", "乐观"), ("base", "基准"), ("pessimistic", "悲观")):
            scenario = doc["scenario_sets"][horizon][key]
            lines.append(f"- {name}：{scenario['summary']}；结果方向：{scenario['outcome_direction']}")
            _append_conditions(lines, f"{name}条件", scenario.get("conditions"))
            _append_claims(lines, f"{name}风险", scenario.get("risks"))
    lines.append("")

    conflict = doc["cross_horizon_conflict"]
    lines += [
        "## 周期冲突",
        f"- 状态：{conflict['status']}",
        f"- 解释：{conflict['explanation']}",
        "",
    ]
    for title, key in (("风险", "risks"), ("催化因素", "catalysts"), ("待验证问题", "open_questions")):
        lines.append(f"## {title}")
        _append_claims(lines, title, doc.get(key))
        lines.append("")
    lines.append("## 证据覆盖")
    for horizon, coverage in (doc.get("evidence_coverage") or {}).items():
        if isinstance(coverage, dict) and "status" in coverage:
            lines.append(f"- {horizon}：{coverage['status']}")
    lines += ["", "## 来源"]
    lines.extend(f"- {source_id}" for source_id in doc.get("source_ids") or [])
    lines += ["", "---", doc["disclaimer"], ""]
    return "\n".join(lines)


def _append_claims(lines: list[str], title: str, entries: list[dict] | None) -> None:
    if not entries:
        return
    lines.append(f"- {title}：")
    for entry in entries:
        if isinstance(entry, dict):
            claim = entry.get("claim") or entry.get("text") or entry.get("summary") or ""
            source_ids = entry.get("source_ids") or []
            suffix = f"（来源：{', '.join(source_ids)}）" if source_ids else ""
            lines.append(f"  - {claim}{suffix}")
        else:
            lines.append(f"  - {entry}")


def _append_conditions(lines: list[str], title: str, entries: list[dict] | None) -> None:
    if not entries:
        return
    lines.append(f"- {title}：")
    for entry in entries:
        if entry.get("kind") == "trigger":
            threshold = entry.get("threshold_metric_ref")
            text = (
                f"{entry.get('text', '')}（{entry.get('observed_metric_ref')} "
                f"{entry.get('operator')} {threshold}；自动触发）"
            )
        else:
            text = f"{entry.get('text', '')}（人工观察，不自动触发）"
        source_ids = entry.get("source_ids") or []
        suffix = f"；来源：{', '.join(source_ids)}" if source_ids else ""
        lines.append(f"  - {text}{suffix}")


def _render_digest_md(doc: dict) -> str:
    lines = [
        f"# 每日复盘（{doc['as_of']}）",
        "",
        doc["summary"],
        "",
        "## 标的概览",
        "",
    ]
    for item in doc["items"]:
        inst = item["instrument"]
        label = f"{inst.get('name') or inst['symbol']}（{inst['symbol']}）"
        quality = item["data_quality"]
        missing = item.get("missing") or []
        if missing:
            quality += f"（缺失：{', '.join(missing)}）"
        lines += [
            f"### {label}",
            f"- 倾向：{item['stance']}",
            f"- 一句话：{item['one_liner']}",
            f"- 数据质量：{quality}",
            "",
        ]
    lines += ["---", doc["disclaimer"], ""]
    return "\n".join(lines)
