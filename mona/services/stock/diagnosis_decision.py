"""Deterministic standard-diagnosis decision engine.

This module is intentionally free of provider and LLM calls.  It consumes the
structured outputs of the fundamental, quantitative and technical services
and returns a stable, JSON-compatible decision.  In particular:

* a missing cross-sectional quant snapshot is ``unavailable`` rather than a
  synthetic neutral signal;
* descriptive (not out-of-sample calibrated) quant scores are retained for
  explanation and confidence only, never used to select an action; and
* prices, plans and positions are copied only from the technical/execution
  input, never generated here from a narrative or an LLM response.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from typing import Any

from mona.services.stock.execution import (
    assess_a_share_execution,
    cost_adjusted_risk_reward,
)
from mona.services.stock.schemas import (
    DiagnosisAction,
    DiagnosisAvailability,
    DiagnosisClaim,
    DiagnosisDirection,
    DiagnosisHorizonDecision,
    DiagnosisHorizonDecisions,
    DiagnosisMaterializedPlan,
    DiagnosisPositionPlan,
    V6CostAssumptions,
)

HORIZONS = ("short_term", "medium_term", "long_term")
DIRECTION_THRESHOLD = 0.2
MINIMUM_RISK_REWARD_FIRST = 1.0
MINIMUM_RISK_REWARD_SECOND = 2.0
COST_ADJUSTED_RISK_REWARD_METHOD_VERSION = "a-share-cost-adjusted-risk-reward-v1"
_PLAN_FIELDS = (
    "reference_entry",
    "pullback_entry",
    "stop_loss",
    "first_take_profit",
    "second_take_profit",
)
_PLAN_ALIASES = {
    "reference_entry": (
        "reference_entry", "reference_buy", "entry_reference", "reference_buy_high", "reference_buy_low",
    ),
    "pullback_entry": (
        "pullback_entry", "pullback_buy", "entry_pullback", "pullback_buy_high", "pullback_buy_low",
    ),
    "stop_loss": ("stop_loss", "stop_loss_reference", "stop"),
    "first_take_profit": ("first_take_profit", "take_profit_1", "first_tp"),
    "second_take_profit": ("second_take_profit", "take_profit_2", "second_tp"),
}
_PLAN_RANGE_ALIASES = {
    "reference_entry_low": ("reference_entry_low", "reference_buy_low"),
    "reference_entry_high": ("reference_entry_high", "reference_buy_high"),
    "pullback_entry_low": ("pullback_entry_low", "pullback_buy_low"),
    "pullback_entry_high": ("pullback_entry_high", "pullback_buy_high"),
}


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        result = dump(mode="python")
        return dict(result) if isinstance(result, Mapping) else {}
    return {}


def _horizon_value(value: Any, horizon: str) -> dict[str, Any]:
    """Resolve both ``{short_term: ...}`` and shared-snapshot shapes."""

    raw = _mapping(value)
    candidate = raw.get(horizon)
    if isinstance(candidate, Mapping):
        return dict(candidate)
    nested = raw.get("horizons")
    if isinstance(nested, Mapping) and isinstance(nested.get(horizon), Mapping):
        return dict(nested[horizon])
    return raw


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _source_ids(value: Mapping[str, Any]) -> list[str]:
    raw = value.get("source_ids")
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(item for item in raw if isinstance(item, str) and item))


def _status(value: Mapping[str, Any]) -> DiagnosisAvailability:
    raw = str(value.get("status") or value.get("availability") or "").lower()
    if raw in {"available", "ready", "complete", "ok"}:
        return "available"
    if raw in {"degraded", "partial"}:
        return "degraded"
    return "unavailable"


def _validation_status(value: Mapping[str, Any], *, quant: bool) -> str:
    raw = str(
        value.get("validation_status")
        or value.get("validationStatus")
        or value.get("oos_status")
        or ""
    ).lower()
    if raw in {"calibrated", "validated", "passed"}:
        return "calibrated"
    if raw in {"rejected", "invalid"}:
        return "rejected"
    if raw in {"unavailable", "missing", "not_available"}:
        return "unavailable"
    if quant:
        # A score with no OOS promotion is explicitly descriptive.  It is not
        # promoted merely because it has a large or small value.
        if any(key in value for key in ("factor_score", "score", "composite_score", "direction", "signal")):
            return "descriptive"
        return "unavailable"
    return "descriptive"


def _factor_score(value: Mapping[str, Any]) -> float | None:
    for key in ("factor_score", "score", "composite_score", "composite"):
        number = _finite_number(value.get(key))
        if number is None:
            continue
        if 0 <= number <= 1:
            return number
        # Some deterministic factor adapters expose a signed score.  Convert
        # it to the public 0..1 descriptive score without changing the input.
        if -1 <= number <= 1:
            return (number + 1) / 2
    return None


def _signed_score(value: Mapping[str, Any]) -> float | None:
    direction = str(value.get("direction") or value.get("signal") or value.get("stance") or "").lower()
    if direction in {"positive", "bullish", "outperform", "strong"}:
        return 1.0
    if direction in {"negative", "bearish", "underperform", "weak"}:
        return -1.0
    if direction in {"neutral", "inline", "mixed"}:
        return 0.0
    score = None
    for key in ("signed_score", "signal_score", "factor_score", "score", "composite_score", "composite"):
        score = _finite_number(value.get(key))
        if score is not None:
            break
    if score is None:
        factors = value.get("factors")
        if isinstance(factors, list):
            values = [_signed_score(_mapping(item)) for item in factors]
            values = [item for item in values if item is not None]
            if values:
                return sum(values) / len(values)
        return None
    # Values in [0, 1] are public factor scores; values outside that range are
    # already signed deterministic scores.
    if 0 <= score <= 1:
        return score * 2 - 1
    return max(-1.0, min(1.0, score))


def _direction(score: float | None) -> DiagnosisDirection:
    if score is None:
        return "unavailable"
    if score > DIRECTION_THRESHOLD:
        return "positive"
    if score < -DIRECTION_THRESHOLD:
        return "negative"
    return "neutral"


def _contributions(value: Mapping[str, Any]) -> dict[str, float]:
    raw = value.get("factor_contributions")
    if not isinstance(raw, Mapping):
        raw = value.get("contributions")
    result: dict[str, float] = {}
    if isinstance(raw, Mapping):
        for key, item in raw.items():
            number = _finite_number(item)
            if number is not None:
                result[str(key)] = number
    factors = value.get("factors")
    if isinstance(factors, list):
        for item in factors:
            factor = _mapping(item)
            name = factor.get("name")
            contribution = _finite_number(factor.get("contribution"))
            if isinstance(name, str) and contribution is not None:
                result[name] = contribution
    return result


def _component(value: Any, horizon: str, *, quant: bool) -> dict[str, Any]:
    raw = _horizon_value(value, horizon)
    status = _status(raw)
    validation_status = _validation_status(raw, quant=quant)
    if validation_status in {"unavailable", "rejected"}:
        status = "unavailable"
    score = _signed_score(raw)
    if status == "unavailable" or score is None:
        usable_score = None
    else:
        usable_score = score
    return {
        "raw": raw,
        "status": status,
        "validation_status": validation_status,
        "factor_score": _factor_score(raw),
        "signed_score": usable_score,
        "direction": _direction(usable_score),
        "source_ids": _source_ids(raw),
        "contributions": _contributions(raw),
    }


def _technical_component(value: Any, horizon: str) -> dict[str, Any]:
    """Resolve a deterministic timing score without requiring a plan score."""

    component = _component(value, horizon, quant=False)
    if component["signed_score"] is not None or horizon != "short_term":
        return component
    root = _mapping(value)
    trend = _mapping(root.get("trend"))
    trend_value = str(trend.get("value") or trend.get("direction") or "").lower()
    trend_score = {
        # Trend alone is descriptive timing evidence.  Keep it below the
        # deterministic forced-exit threshold; an explicit stop/exit trigger
        # is required for an unconditional exit action.
        "up": 0.6,
        "positive": 0.6,
        "bullish": 0.6,
        "flat": 0.0,
        "neutral": 0.0,
        "sideways": 0.0,
        "down": -0.6,
        "negative": -0.6,
        "bearish": -0.6,
    }.get(trend_value)
    if trend_score is None:
        return component
    source_ids = list(dict.fromkeys(component["source_ids"] + _source_ids(root) + _source_ids(trend)))
    return {
        **component,
        "status": "available",
        "validation_status": "descriptive",
        "signed_score": trend_score,
        "factor_score": (trend_score + 1) / 2,
        "direction": _direction(trend_score),
        "source_ids": source_ids,
        "contributions": {**component["contributions"], "trend": trend_score},
    }


def _plan_candidate(raw: Mapping[str, Any], horizon: str) -> dict[str, Any]:
    candidate: dict[str, Any] = {}
    for key in ("materialized_plan", "trading_plan", "execution_plan", "plan"):
        nested = raw.get(key)
        if isinstance(nested, Mapping):
            candidate.update(nested)
    horizons = raw.get("horizons")
    if isinstance(horizons, Mapping) and isinstance(horizons.get(horizon), Mapping):
        candidate.update(horizons[horizon])
    candidate.update({key: raw[key] for key in _PLAN_FIELDS if key in raw})
    return candidate


def _plan(raw: Any, horizon: str) -> DiagnosisMaterializedPlan:
    root = _mapping(raw)
    value = _horizon_value(raw, horizon)
    candidate = _plan_candidate(value, horizon)
    result: dict[str, Any] = {}
    unavailable: list[str] = []
    for field in _PLAN_FIELDS:
        number = None
        for alias in _PLAN_ALIASES[field]:
            number = _finite_number(candidate.get(alias))
            if number is not None:
                break
        result[field] = number
        if number is None:
            unavailable.append(field)
    for field, aliases in _PLAN_RANGE_ALIASES.items():
        result[field] = next(
            (
                number
                for alias in aliases
                if (number := _finite_number(candidate.get(alias))) is not None
            ),
            None,
        )
    entry_conditions = candidate.get("entry_conditions")
    if isinstance(entry_conditions, list):
        normalized_conditions = [
            item for item in entry_conditions if isinstance(item, Mapping)
        ]
    else:
        normalized_conditions = []
    statuses = {
        str(item.get("status") or "").lower() for item in normalized_conditions
    }
    result["entry_condition_count"] = len(normalized_conditions)
    result["entry_condition_realtime_eligible"] = (
        len(normalized_conditions) == 1
        and str(normalized_conditions[0].get("kind") or "").lower() == "price_trigger"
        and str(normalized_conditions[0].get("observed_metric_ref") or "") == "quote.price"
        and str(normalized_conditions[0].get("operator") or "").lower() == "gte"
    )
    if normalized_conditions and statuses == {"triggered"}:
        result["entry_condition_status"] = "triggered"
    elif "not_triggered" in statuses:
        result["entry_condition_status"] = "not_triggered"
    else:
        result["entry_condition_status"] = "unavailable"
    result["entry_condition"] = next(
        (
            str(item.get("description")).strip()
            for item in normalized_conditions
            if isinstance(item.get("description"), str)
            and str(item.get("description")).strip()
        ),
        None,
    )
    explicit_status = str(candidate.get("value_status") or candidate.get("status") or "").lower()
    if explicit_status in {"unavailable", "missing"}:
        value_status = "unavailable"
    elif not unavailable:
        value_status = "available"
    elif len(unavailable) < len(_PLAN_FIELDS):
        value_status = "partial"
    else:
        value_status = "unavailable"
    invalidation = candidate.get("invalidation")
    if not isinstance(invalidation, list):
        invalidation = candidate.get("invalidation_conditions")
    if not isinstance(invalidation, list):
        invalidation = candidate.get("exit_conditions")
    if not isinstance(invalidation, list):
        invalidation = []
    result["value_status"] = value_status
    result["unavailable_fields"] = unavailable
    result["invalidation"] = [
        str(item.get("description") or item.get("text") or item)
        if isinstance(item, Mapping)
        else str(item)
        for item in invalidation
        if str(item).strip()
    ]
    boundaries = candidate.get("boundaries") or candidate.get("boundary") or []
    if isinstance(boundaries, str):
        boundaries = [boundaries]
    result["boundaries"] = [str(item) for item in boundaries if str(item).strip()] if isinstance(boundaries, list) else []
    result["max_risk_pct"] = _finite_number(candidate.get("max_risk_pct"))
    result["source_ids"] = _source_ids(candidate)
    risk_reference = result.get("reference_entry_high") or result.get("reference_entry")
    stop_loss = result.get("stop_loss")
    first_take_profit = result.get("first_take_profit")
    second_take_profit = result.get("second_take_profit")
    if (
        isinstance(risk_reference, float)
        and isinstance(stop_loss, float)
        and risk_reference > stop_loss > 0
    ):
        risk_per_share = risk_reference - stop_loss
        result["risk_reference_price"] = risk_reference
        result["risk_per_share"] = round(risk_per_share, 6)
        result["risk_pct"] = round(risk_per_share / risk_reference * 100, 6)
        if isinstance(first_take_profit, float) and first_take_profit > risk_reference:
            first_reward = first_take_profit - risk_reference
            result["first_reward_pct"] = round(first_reward / risk_reference * 100, 6)
            result["risk_reward_first"] = round(first_reward / risk_per_share, 6)
        if isinstance(second_take_profit, float) and second_take_profit > risk_reference:
            second_reward = second_take_profit - risk_reference
            result["second_reward_pct"] = round(second_reward / risk_reference * 100, 6)
            result["risk_reward_second"] = round(second_reward / risk_per_share, 6)
        result["risk_reward_method_version"] = "gross-risk-reward-reference-high-v1"
    result["minimum_risk_reward_first"] = MINIMUM_RISK_REWARD_FIRST
    result["minimum_risk_reward_second"] = MINIMUM_RISK_REWARD_SECOND
    first_ratio = result.get("risk_reward_first")
    second_ratio = result.get("risk_reward_second")
    if isinstance(first_ratio, float) and isinstance(second_ratio, float):
        result["risk_reward_gate_status"] = (
            "passed"
            if first_ratio >= MINIMUM_RISK_REWARD_FIRST
            and second_ratio >= MINIMUM_RISK_REWARD_SECOND
            else "failed"
        )
    else:
        result["risk_reward_gate_status"] = "unavailable"
    result["risk_reward_gate_method_version"] = "gross-risk-reward-gate-v1"
    raw_costs = value.get("cost_assumptions") or root.get("cost_assumptions")
    costs = V6CostAssumptions.model_validate(raw_costs or {})
    result["cost_assumptions"] = costs.model_dump(mode="python")
    facts = value.get("execution_facts") or root.get("execution_facts")
    slippage: float | None = None
    slippage_method: str | None = None
    if isinstance(facts, Mapping):
        result["source_ids"] = list(
            dict.fromkeys([*result.get("source_ids", []), *_source_ids(facts)])
        )
        try:
            assessment = assess_a_share_execution(
                facts,
                holding_state="not_holding",
                requested_side="buy",
            )
        except ValueError:
            assessment = None
        if assessment is not None:
            slippage = assessment.estimated_slippage_pct
            slippage_method = assessment.slippage_method_version
    result["estimated_slippage_pct"] = slippage
    result["slippage_method_version"] = slippage_method
    fee_first: float | None = None
    fee_second: float | None = None
    stress_first: float | None = None
    stress_second: float | None = None
    if all(
        isinstance(result.get(field), float)
        for field in (
            "risk_reference_price",
            "stop_loss",
            "first_take_profit",
            "second_take_profit",
        )
    ):
        fee_first, fee_second = cost_adjusted_risk_reward(
            entry_price=result["risk_reference_price"],
            stop_loss=result["stop_loss"],
            first_take_profit=result["first_take_profit"],
            second_take_profit=result["second_take_profit"],
            slippage_pct=0.0,
            costs=costs,
        )
        stress_first, stress_second = cost_adjusted_risk_reward(
            entry_price=result["risk_reference_price"],
            stop_loss=result["stop_loss"],
            first_take_profit=result["first_take_profit"],
            second_take_profit=result["second_take_profit"],
            slippage_pct=slippage,
            costs=costs,
        )
    result["risk_reward_first_after_fees"] = fee_first
    result["risk_reward_second_after_fees"] = fee_second
    result["fee_gate_status"] = (
        "passed"
        if fee_first is not None
        and fee_second is not None
        and fee_first >= MINIMUM_RISK_REWARD_FIRST
        and fee_second >= MINIMUM_RISK_REWARD_SECOND
        else "failed" if fee_first is not None and fee_second is not None
        else "unavailable"
    )
    result["fee_gate_method_version"] = "fee-adjusted-risk-reward-gate-v1"
    result["risk_reward_first_after_cost"] = stress_first
    result["risk_reward_second_after_cost"] = stress_second
    result["cost_method_version"] = COST_ADJUSTED_RISK_REWARD_METHOD_VERSION
    if stress_first is not None and stress_second is not None:
        result["cost_scope"] = "fees_and_slippage_proxy"
        result["slippage_stress_status"] = (
            "passed"
            if stress_first >= MINIMUM_RISK_REWARD_FIRST
            and stress_second >= MINIMUM_RISK_REWARD_SECOND
            else "failed"
        )
    else:
        result["cost_scope"] = "unavailable"
        result["slippage_stress_status"] = "unavailable"
    result["slippage_stress_method_version"] = "market-slippage-stress-v1"
    return DiagnosisMaterializedPlan.model_validate(result)


def _position(raw: Any, horizon: str) -> DiagnosisPositionPlan:
    value = _horizon_value(raw, horizon)
    candidate: dict[str, Any] = {}
    nested = value.get("position_plan")
    if isinstance(nested, Mapping):
        candidate.update(nested)
    nested = value.get("position")
    if isinstance(nested, Mapping):
        candidate.update(nested)
    positions = _mapping(raw).get("position")
    if isinstance(positions, Mapping) and isinstance(positions.get(horizon), Mapping):
        candidate.update(positions[horizon])
    aliases = {
        "reference_position_pct": ("reference_position_pct", "initial_position_pct", "position_pct"),
        "max_position_pct": ("max_position_pct",),
        "risk_budget_pct": ("risk_budget_pct",),
    }
    result: dict[str, Any] = {}
    missing = 0
    for field, names in aliases.items():
        result[field] = None
        for name in names:
            number = _finite_number(candidate.get(name))
            if number is not None and 0 <= number <= 100:
                result[field] = number
                break
        if result[field] is None:
            missing += 1
    explicit_status = str(candidate.get("value_status") or candidate.get("status") or "").lower()
    if explicit_status in {"unavailable", "missing"} or missing == len(aliases):
        result["value_status"] = "unavailable"
    elif missing:
        result["value_status"] = "partial"
    else:
        result["value_status"] = "available"
    for field, upper_bound in (
        ("stop_distance_pct", 100.0),
        ("volatility_adjustment", 1.0),
        ("liquidity_cap_pct", 100.0),
    ):
        number = _finite_number(candidate.get(field))
        result[field] = number if number is not None and 0 < number <= upper_bound else None
    for field in ("calculation_method", "calculation_version"):
        value = candidate.get(field)
        result[field] = value.strip() if isinstance(value, str) and value.strip() else None
    result["source_ids"] = _source_ids(candidate)
    return DiagnosisPositionPlan.model_validate(result)


def _claim(text: str, source_ids: list[str]) -> DiagnosisClaim:
    return DiagnosisClaim(
        text=text,
        source_ids=source_ids,
        claim_type="fact" if source_ids else "hypothesis",
    )


def _action(direction: DiagnosisDirection, *, holding: bool, score: float | None) -> DiagnosisAction:
    if direction == "unavailable":
        return "reduce" if holding else "avoid"
    if direction == "positive":
        return "hold" if holding else "conditional_participation"
    if direction == "negative":
        if holding and score is not None and score < -0.65:
            return "exit"
        return "reduce" if holding else "avoid"
    return "hold" if holding else "wait"


def _valid_until(raw: Any, horizon: str) -> str | None:
    value = _mapping(raw)
    horizon_value = _horizon_value(raw, horizon)
    horizon_direct = horizon_value.get("valid_until")
    if isinstance(horizon_direct, str) and horizon_direct.strip():
        return horizon_direct.strip()
    direct = value.get("valid_until")
    if isinstance(direct, Mapping):
        direct = direct.get(horizon)
    return direct if isinstance(direct, str) and direct.strip() else None


def _review_trigger(raw: Any, horizon: str) -> str:
    value = _mapping(raw)
    horizon_value = _horizon_value(raw, horizon)
    horizon_direct = horizon_value.get("review_trigger")
    if isinstance(horizon_direct, str) and horizon_direct.strip():
        return horizon_direct.strip()
    direct = value.get("review_trigger")
    if isinstance(direct, Mapping):
        direct = direct.get(horizon)
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    triggers = value.get("review_triggers")
    if isinstance(triggers, Mapping):
        item = triggers.get(horizon)
        if isinstance(item, str) and item.strip():
            return item.strip()
    return "暂无可确认的复评条件"


def _exit_triggered(raw: Any, horizon: str) -> bool:
    """Return true only for an explicit deterministic exit-condition hit."""

    candidate = _plan_candidate(_horizon_value(raw, horizon), horizon)
    conditions = candidate.get("exit_conditions")
    if not isinstance(conditions, list):
        return False
    return any(
        isinstance(item, Mapping)
        and str(item.get("status") or "").lower() in {"triggered", "matched"}
        for item in conditions
    )


def _merge_ids(*parts: Mapping[str, Any]) -> list[str]:
    result: list[str] = []
    for part in parts:
        for source_id in _source_ids(part):
            if source_id not in result:
                result.append(source_id)
    return result


def _horizon_decision(
    horizon: str,
    *,
    fundamental: Any,
    quant: Any,
    technical: Any,
    holding_state: str,
) -> DiagnosisHorizonDecision:
    f = _component(fundamental, horizon, quant=False)
    q = _component(quant, horizon, quant=True)
    t = _technical_component(technical, horizon)

    # A descriptive quant snapshot is useful context but cannot drive direction
    # or action; only a calibrated signal may join the deterministic score.
    q_usable = q["status"] != "unavailable"
    q_calibrated = q_usable and q["validation_status"] == "calibrated"
    f_usable = f["status"] != "unavailable" and f["signed_score"] is not None
    t_usable = t["status"] != "unavailable" and t["signed_score"] is not None
    # Descriptive quant is evidence, not a hard prerequisite.  A missing
    # enhancement must not erase a usable fundamental or technical decision.
    if not f_usable and not t_usable:
        signed_score = None
        direction: DiagnosisDirection = "unavailable"
    else:
        weighted: list[tuple[float, float]] = []
        component_scores: dict[str, float] = {}
        raw_component_weights: dict[str, float] = {}
        if f_usable:
            weighted.append((float(f["signed_score"]), 0.55))
            component_scores["fundamental"] = float(f["signed_score"])
            raw_component_weights["fundamental"] = 0.55
        if t_usable:
            weighted.append((float(t["signed_score"]), 0.45))
            component_scores["technical"] = float(t["signed_score"])
            raw_component_weights["technical"] = 0.45
        if q_calibrated and q["signed_score"] is not None:
            weighted.append((float(q["signed_score"]), 0.25))
            component_scores["quant"] = float(q["signed_score"])
            raw_component_weights["quant"] = 0.25
        denominator = sum(weight for _score, weight in weighted)
        signed_score = sum(score * weight for score, weight in weighted) / denominator
        direction = _direction(signed_score)
    if signed_score is None:
        component_scores = {}
        component_weights: dict[str, float] = {}
    else:
        denominator = sum(raw_component_weights.values())
        component_weights = {
            name: weight / denominator
            for name, weight in raw_component_weights.items()
        }

    # ``factor_score`` is the public descriptive cross-sectional score.  It
    # can be shown even when validation is descriptive, but cannot affect the
    # score above.  A neutral score is therefore never invented when q is
    # unavailable.
    factor_score = q["factor_score"] if q["status"] != "unavailable" else None
    if q["status"] == "unavailable":
        validation_status = "unavailable"
    elif q["validation_status"] in {"calibrated", "descriptive"}:
        validation_status = q["validation_status"]
    else:
        validation_status = "unavailable"

    plan = _plan(technical, horizon)
    position = _position(technical, horizon)
    original_max_position = position.max_position_pct
    if (
        position.value_status == "available"
        and position.risk_budget_pct is not None
        and position.max_position_pct is not None
        and position.reference_position_pct is not None
        and plan.risk_pct is not None
        and plan.risk_pct > 0
    ):
        conservative_cap = round(
            min(100.0, position.risk_budget_pct / plan.risk_pct * 100.0),
            6,
        )
        capped_max = min(position.max_position_pct, conservative_cap)
        position = DiagnosisPositionPlan.model_validate(
            {
                **position.model_dump(mode="python"),
                "reference_position_pct": min(position.reference_position_pct, capped_max / 2),
                "max_position_pct": capped_max,
                "conservative_risk_cap_pct": conservative_cap,
                "risk_cap_method_version": "conservative-entry-high-risk-cap-v1",
            }
        )
    ids = list(dict.fromkeys(f["source_ids"] + q["source_ids"] + t["source_ids"] + plan.source_ids + position.source_ids))
    reasons: list[DiagnosisClaim] = []
    risks: list[DiagnosisClaim] = []
    if direction == "positive":
        reasons.append(_claim("基本面与技术执行结果共同支持当前方向", f["source_ids"] + t["source_ids"]))
    elif direction == "negative":
        risks.append(_claim("基本面与技术执行结果共同形成下行压力", f["source_ids"] + t["source_ids"]))
    elif direction == "neutral":
        reasons.append(_claim("基本面与技术执行结果未形成明确方向", f["source_ids"] + t["source_ids"]))
    else:
        risks.append(_claim("基本面和技术执行结果均不可用，当前周期不形成方向结论", ids))
    if not q_usable:
        risks.append(_claim("横截面量化本次不参与买卖裁决，已有技术风险边界继续有效", q["source_ids"]))
    if validation_status == "descriptive":
        risks.append(_claim("当前量化信号仅为描述性相对位置，未通过样本外验证，不单独驱动动作、价格或仓位", q["source_ids"]))
    if plan.value_status != "available":
        risks.append(_claim("真实交易计划数值未完整提供，保留计划字段但不补造数值", plan.source_ids))
    if plan.slippage_stress_status == "failed":
        risks.append(
            _claim(
                "市场流动性滑点压力测试未通过；该代理不含用户委托规模，实际参与前需结合订单金额和盘口复核",
                plan.source_ids,
            )
        )
    elif plan.slippage_stress_status == "unavailable" and direction == "positive":
        risks.append(
            _claim(
                "市场成交额、换手率或波动率不足，滑点压力测试待确认",
                plan.source_ids,
            )
        )
    if (
        original_max_position is not None
        and position.max_position_pct is not None
        and position.max_position_pct < original_max_position - 1e-6
    ):
        risks.append(
            _claim(
                "原始仓位超过按参与区间上沿计算的单笔风险预算，已自动下调仓位上限",
                plan.source_ids + position.source_ids,
            )
        )

    holding = holding_state == "holding"
    not_holding_action = _action(direction, holding=False, score=signed_score)
    holding_action = _action(direction, holding=True, score=signed_score)
    execution_ready = (
        plan.value_status == "available"
        and plan.risk_reward_gate_status == "passed"
        and plan.fee_gate_status == "passed"
        and position.value_status == "available"
        and position.reference_position_pct is not None
        and position.reference_position_pct > 0
        and position.max_position_pct is not None
        and position.max_position_pct > 0
        and position.risk_budget_pct is not None
        and position.risk_budget_pct > 0
    )
    if not_holding_action == "conditional_participation" and not execution_ready:
        not_holding_action = "wait"
        if plan.risk_reward_gate_status == "failed":
            wait_reason = "收益风险比未达到策略门槛，未持有者继续等待"
        elif plan.fee_gate_status == "failed":
            wait_reason = "计入默认交易费率后，收益风险比未达到策略门槛，未持有者继续等待"
        elif plan.fee_gate_status == "unavailable":
            wait_reason = "交易费率后的收益风险无法确认，未持有者继续等待"
        else:
            wait_reason = "研究方向偏正，但入场、止损、止盈、仓位或参与条件未完整形成，未持有者继续等待"
        risks.append(
            _claim(
                wait_reason,
                plan.source_ids + position.source_ids,
            )
        )
    if _exit_triggered(technical, horizon):
        holding_action = "exit"
    selected_action = holding_action if holding else not_holding_action
    if holding:
        current_action = holding_action
    elif not_holding_action == "conditional_participation":
        current_action = (
            "participate"
            if plan.entry_condition_status == "triggered"
            else "wait"
        )
    else:
        current_action = not_holding_action
    if direction == "unavailable" or (direction == "positive" and not execution_ready):
        confidence = "low"
    elif not q_usable or validation_status == "descriptive" or f["status"] == "degraded" or t["status"] == "degraded":
        confidence = "low"
    elif q_calibrated:
        confidence = "high"
    else:
        confidence = "medium"

    factor_contributions: dict[str, float] = {}
    for component in (f, t, q):
        for name, contribution in component["contributions"].items():
            # Preserve the original factor name for UI/existing adapters while
            # making the merge deterministic when two groups expose a name.
            key = name
            if key in factor_contributions:
                prefix = "fundamental" if component is f else "technical" if component is t else "quant"
                key = f"{prefix}.{name}"
            factor_contributions[key] = contribution

    # ``selected_action`` is intentionally computed by the deterministic
    # direction gate above; semantic research never reaches this branch.
    return DiagnosisHorizonDecision(
        direction=direction,
        action=selected_action,
        decision_score=signed_score,
        positive_threshold=DIRECTION_THRESHOLD,
        negative_threshold=-DIRECTION_THRESHOLD,
        component_scores=component_scores,
        component_weights=component_weights,
        factor_score=factor_score,
        market_percentile=_finite_number(_horizon_value(quant, horizon).get("market_percentile")),
        industry_percentile=_finite_number(_horizon_value(quant, horizon).get("industry_percentile")),
        factor_contributions=factor_contributions,
        validation_status=validation_status,
        not_holding_action=not_holding_action,
        holding_action=holding_action,
        current_action=current_action,
        materialized_plan=plan,
        position_plan=position,
        review_trigger=_review_trigger(technical, horizon),
        valid_until=_valid_until(technical, horizon),
        key_reasons=reasons,
        key_risks=risks,
        confidence=confidence,
        source_ids=ids,
    )


def decide_diagnosis(
    *,
    fundamental_factors: Any,
    quant_factors: Any,
    technical_execution: Any,
    holding_state: str = "not_holding",
) -> dict[str, Any]:
    """Return a deterministic v1 decision projection.

    The returned dictionary is suitable for ``StockDiagnosisV1`` after the
    surrounding report fields and factor snapshots have been assembled.
    Calling this function twice with equal structured inputs returns equal
    dictionaries byte-for-byte after canonical JSON serialization.
    """

    normalized_holding = "holding" if holding_state == "holding" else "not_holding"
    decisions = {
        horizon: _horizon_decision(
            horizon,
            fundamental=fundamental_factors,
            quant=quant_factors,
            technical=technical_execution,
            holding_state=normalized_holding,
        )
        for horizon in HORIZONS
    }
    model = DiagnosisHorizonDecisions.model_validate(
        {key: value.model_dump(mode="python") for key, value in decisions.items()}
    )
    current = model.short_term.model_copy(deep=True)
    if normalized_holding == "not_holding" and current.not_holding_action != "conditional_participation":
        current.position_plan = current.position_plan.model_copy(
            update={
                "reference_position_pct": 0.0,
                "max_position_pct": 0.0,
                "value_status": "available",
            }
        )
    confidences = [getattr(model, key).confidence for key in HORIZONS]
    overall = "high" if all(item == "high" for item in confidences) else "medium"
    if any(item == "low" for item in confidences):
        overall = "low"
    radar = {
        key: getattr(model, key).model_dump(mode="python") for key in HORIZONS
    }
    radar["current_decision"] = current.model_dump(mode="python")
    radar["holding_state"] = normalized_holding
    radar["overall_confidence"] = overall
    radar["deterministic"] = True
    return {
        "horizon_decisions": model.model_dump(mode="python"),
        "decision_radar": radar,
        "overall_confidence": overall,
    }


# Names used by external stage-A/stage-B adapters and tests.
deterministic_decision = decide_diagnosis
build_diagnosis_decision = decide_diagnosis


def canonical_input_hash(value: Any) -> str:
    """Hash a normalized input snapshot for cache/replay identity."""

    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
