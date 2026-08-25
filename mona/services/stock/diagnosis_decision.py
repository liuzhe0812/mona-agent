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

from mona.services.stock.schemas import (
    DiagnosisAction,
    DiagnosisAvailability,
    DiagnosisClaim,
    DiagnosisDirection,
    DiagnosisHorizonDecision,
    DiagnosisHorizonDecisions,
    DiagnosisMaterializedPlan,
    DiagnosisPositionPlan,
)

HORIZONS = ("short_term", "medium_term", "long_term")
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
    if score > 0.2:
        return "positive"
    if score < -0.2:
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
        if f_usable:
            weighted.append((float(f["signed_score"]), 0.55))
        if t_usable:
            weighted.append((float(t["signed_score"]), 0.45))
        if q_calibrated and q["signed_score"] is not None:
            weighted.append((float(q["signed_score"]), 0.25))
        denominator = sum(weight for _score, weight in weighted)
        signed_score = sum(score * weight for score, weight in weighted) / denominator
        direction = _direction(signed_score)

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

    holding = holding_state == "holding"
    not_holding_action = _action(direction, holding=False, score=signed_score)
    holding_action = _action(direction, holding=True, score=signed_score)
    if _exit_triggered(technical, horizon):
        holding_action = "exit"
    selected_action = holding_action if holding else not_holding_action
    if direction == "unavailable":
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
        factor_score=factor_score,
        market_percentile=_finite_number(_horizon_value(quant, horizon).get("market_percentile")),
        industry_percentile=_finite_number(_horizon_value(quant, horizon).get("industry_percentile")),
        factor_contributions=factor_contributions,
        validation_status=validation_status,
        not_holding_action=not_holding_action,
        holding_action=holding_action,
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
