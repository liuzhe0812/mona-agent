"""Deterministic, point-in-time fundamental factor groups.

This module consumes structured Evidence only.  It does not fetch data, read
news, ask an LLM to calculate values, or fill a missing governance/audit/
capital-expenditure field.  A factor with no current value is retained as an
explicit unavailable record and its group records the gap.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from mona.services.stock.provenance import (
    compare_asia_datetime,
    normalize_asia_datetime,
    parse_asia_datetime,
)

FUNDAMENTAL_FACTORS_SCHEMA_VERSION = "fundamental-factors-v1"
FUNDAMENTAL_FACTORS_METHOD_VERSION = "fundamental-factor-groups-v1"


@dataclass(frozen=True)
class _FactorSpec:
    factor_id: str
    group: str
    weight: float
    polarity: str  # higher_is_better / lower_is_better
    aliases: tuple[str, ...] = ()
    unit: str = "provider_native"


_GROUP_WEIGHTS: dict[str, float] = {
    "profitability": 0.22,
    "growth_quality": 0.18,
    "cashflow_quality": 0.18,
    "financial_safety": 0.16,
    "valuation": 0.16,
    "governance": 0.10,
}

_SPECS: tuple[_FactorSpec, ...] = (
    _FactorSpec("roe", "profitability", 0.30, "higher_is_better", unit="percent"),
    _FactorSpec("roic", "profitability", 0.30, "higher_is_better", unit="percent"),
    _FactorSpec("gross_margin", "profitability", 0.20, "higher_is_better", unit="percent"),
    _FactorSpec("net_margin", "profitability", 0.20, "higher_is_better", unit="percent"),
    _FactorSpec(
        "revenue_yoy",
        "growth_quality",
        0.30,
        "higher_is_better",
        aliases=("revenue_growth",),
        unit="percent",
    ),
    _FactorSpec(
        "profit_yoy",
        "growth_quality",
        0.30,
        "higher_is_better",
        aliases=("net_profit_yoy", "earnings_yoy"),
        unit="percent",
    ),
    _FactorSpec("growth_stability", "growth_quality", 0.40, "higher_is_better", unit="provider_native"),
    _FactorSpec(
        "operating_cashflow",
        "cashflow_quality",
        0.35,
        "higher_is_better",
        aliases=("operating_cash_flow",),
        unit="currency",
    ),
    _FactorSpec(
        "cashflow_to_profit",
        "cashflow_quality",
        0.65,
        "higher_is_better",
        aliases=("ocf_to_profit", "cash_flow_to_profit"),
        unit="ratio",
    ),
    _FactorSpec("debt_ratio", "financial_safety", 0.35, "lower_is_better", unit="percent"),
    _FactorSpec(
        "interest_coverage",
        "financial_safety",
        0.20,
        "higher_is_better",
        unit="ratio",
    ),
    _FactorSpec("current_ratio", "financial_safety", 0.20, "higher_is_better", unit="ratio"),
    _FactorSpec(
        "capex_to_cashflow",
        "financial_safety",
        0.25,
        "lower_is_better",
        unit="ratio",
    ),
    _FactorSpec("pe", "valuation", 0.45, "lower_is_better", unit="multiple"),
    _FactorSpec("pb", "valuation", 0.35, "lower_is_better", unit="multiple"),
    _FactorSpec(
        "cashflow_yield",
        "valuation",
        0.20,
        "higher_is_better",
        aliases=("fcf_yield", "operating_cashflow_yield"),
        unit="percent",
    ),
    _FactorSpec(
        "audit_qualification",
        "governance",
        0.25,
        "lower_is_better",
        aliases=("audit_opinion_flag",),
        unit="flag",
    ),
    _FactorSpec(
        "restatement_count",
        "governance",
        0.20,
        "lower_is_better",
        aliases=("restatements",),
        unit="count",
    ),
    _FactorSpec("dilution_ratio", "governance", 0.20, "lower_is_better", aliases=("dilution",), unit="percent"),
    _FactorSpec("pledge_ratio", "governance", 0.20, "lower_is_better", aliases=("share_pledge_ratio",), unit="percent"),
    _FactorSpec(
        "related_party_transactions",
        "governance",
        0.15,
        "lower_is_better",
        aliases=("related_party_transaction_count",),
        unit="count",
    ),
)

_SPEC_BY_ID = {spec.factor_id: spec for spec in _SPECS}
_ALIAS_TO_ID = {
    alias: spec.factor_id
    for spec in _SPECS
    for alias in (spec.factor_id, *spec.aliases)
}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Mapping):
        value = value.get("value")
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _source_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return []
    return list(dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip()))


def _field(value: Mapping[str, Any] | None, name: str, *aliases: str) -> Any:
    if not isinstance(value, Mapping):
        return None
    for candidate_name in (name, *aliases):
        if candidate_name in value:
            return value[candidate_name]
        compact = candidate_name.replace("_", "").lower()
        for key, candidate in value.items():
            if str(key).replace("_", "").lower() == compact:
                return candidate
    return None


def _metrics(row: Mapping[str, Any] | None) -> Mapping[str, Any]:
    if not isinstance(row, Mapping):
        return {}
    value = row.get("metrics")
    return value if isinstance(value, Mapping) else row


def _row_source_ids(row: Mapping[str, Any] | None, default: list[str]) -> list[str]:
    if not isinstance(row, Mapping):
        return list(default)
    direct = _source_ids(row.get("source_ids"))
    if direct:
        return direct
    source = row.get("source")
    if isinstance(source, Mapping):
        direct = _source_ids(source.get("id"))
    elif source is not None:
        direct = _source_ids(getattr(source, "id", None))
    return direct or list(default)


def _as_of(row: Mapping[str, Any] | None) -> str | None:
    if not isinstance(row, Mapping):
        return None
    value = row.get("published_at") or row.get("as_of") or row.get("data_as_of")
    if value is None and isinstance(row.get("source"), Mapping):
        value = row["source"].get("published_at")
    return normalize_asia_datetime(value)


def _history_rows(input_value: Any, explicit_history: Sequence[Any] | None) -> list[Mapping[str, Any]]:
    if explicit_history is not None:
        values = explicit_history
    elif isinstance(input_value, Mapping):
        values = input_value.get("fundamentals_history") or []
        if not values and input_value.get("fundamentals"):
            values = [input_value.get("fundamentals")]
    elif isinstance(input_value, Sequence) and not isinstance(input_value, (str, bytes, bytearray)):
        values = input_value
    else:
        values = [input_value] if input_value is not None else []
    return [value for value in values if isinstance(value, Mapping)]


def _cutoff_rows(rows: list[Mapping[str, Any]], cutoff: str | None) -> tuple[list[Mapping[str, Any]], list[dict[str, Any]]]:
    if cutoff is None:
        return rows, []
    excluded: list[dict[str, Any]] = []
    eligible: list[Mapping[str, Any]] = []
    for row in rows:
        observed = _as_of(row)
        relation = compare_asia_datetime(observed, cutoff)
        if relation is False:
            excluded.append({"value": observed, "reason": "after_research_cutoff"})
            continue
        if relation is None:
            excluded.append({"value": observed, "reason": "unknown_public_time"})
            continue
        eligible.append(row)
    return eligible, excluded


def _current_row(rows: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    if not rows:
        return None
    observed = [(parse_asia_datetime(_as_of(row)), index, row) for index, row in enumerate(rows)]
    known = [item for item in observed if item[0] is not None]
    if known:
        return max(known, key=lambda item: item[0])[2]
    return rows[0]


def _explicit_percentile(
    input_value: Any,
    factor_id: str,
    metrics: Mapping[str, Any],
    *,
    percentile_map: Mapping[str, Any] | None,
) -> float | None:
    maps = [percentile_map]
    if isinstance(input_value, Mapping):
        maps.extend(
            [
                input_value.get("percentiles"),
                input_value.get("fundamental_percentiles"),
                input_value.get("market_percentiles"),
            ]
        )
    for source in maps:
        if not isinstance(source, Mapping):
            continue
        value = _field(source, factor_id)
        if isinstance(value, Mapping):
            value = value.get("percentile") or value.get("value")
        number = _number(value)
        if number is not None and 0 <= number <= 1:
            return number
    value = _field(metrics, f"{factor_id}_percentile")
    number = _number(value)
    return number if number is not None and 0 <= number <= 1 else None


def _universe_rows(input_value: Any, universe: Sequence[Any] | None) -> list[Mapping[str, Any]]:
    if universe is not None:
        return [row for row in universe if isinstance(row, Mapping)]
    if isinstance(input_value, Mapping):
        value = input_value.get("fundamental_universe") or input_value.get("cross_section")
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            return [row for row in value if isinstance(row, Mapping)]
    return []


def _rank_percentile(value: float, values: list[float]) -> float | None:
    if not values:
        return None
    less = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    return (less + equal / 2) / len(values)


def _peer_values(input_value: Any, factor_id: str) -> list[float]:
    if not isinstance(input_value, Mapping):
        return []
    candidates: list[Any] = [
        input_value.get("peer_values"),
        input_value.get("valuation_context"),
        input_value.get("valuation"),
    ]
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        nested = candidate.get("peer_values") if "peer_values" in candidate else candidate
        if isinstance(nested, Mapping):
            value = nested.get(factor_id)
            if value is None and factor_id in {"pe", "pb"}:
                value = nested.get(factor_id)
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
                return [number for item in value if (number := _number(item)) is not None]
    return []


def _derive_value(
    factor_id: str,
    current_metrics: Mapping[str, Any],
    rows: list[Mapping[str, Any]],
    *,
    current_row: Mapping[str, Any] | None,
) -> float | None:
    direct = _field(current_metrics, factor_id)
    if direct is not None:
        return _number(direct)
    if factor_id == "cashflow_to_profit":
        cashflow = _number(_field(current_metrics, "operating_cashflow", "operating_cash_flow"))
        profit = _number(_field(current_metrics, "net_profit"))
        return cashflow / profit if cashflow is not None and profit not in (None, 0) else None
    if factor_id == "capex_to_cashflow":
        capex = _number(_field(current_metrics, "capex", "capital_expenditure"))
        cashflow = _number(_field(current_metrics, "operating_cashflow", "operating_cash_flow"))
        return abs(capex) / abs(cashflow) if capex is not None and cashflow not in (None, 0) else None
    if factor_id == "cashflow_yield":
        cashflow = _number(_field(current_metrics, "operating_cashflow", "operating_cash_flow"))
        market_cap = _number(_field(current_metrics, "market_cap"))
        return cashflow / market_cap * 100 if cashflow is not None and market_cap not in (None, 0) else None
    if factor_id == "growth_stability":
        growth_values = []
        for row in rows:
            metric = _metrics(row)
            value = _number(_field(metric, "profit_yoy", "revenue_yoy"))
            if value is not None:
                growth_values.append(value)
        if len(growth_values) >= 2:
            # A bounded inverse dispersion score retains directionality while
            # avoiding a fabricated target growth rate.
            return 1 / (1 + statistics.pstdev(growth_values))
    return None


def _state(score: float | None, *, available: bool) -> str:
    if not available or score is None:
        return "unavailable"
    if score >= 0.70:
        return "strong"
    if score <= 0.30:
        return "weak"
    return "neutral"


def _direction(score: float | None, *, available: bool) -> str:
    if not available or score is None:
        return "unavailable"
    if score >= 0.70:
        return "positive"
    if score <= 0.30:
        return "negative"
    return "neutral"


def _metric_sources(input_value: Any, factor_id: str, current_row: Mapping[str, Any] | None, default: list[str]) -> list[str]:
    if isinstance(input_value, Mapping):
        for key in ("metric_sources", "factor_sources", "source_by_metric"):
            source_map = input_value.get(key)
            if isinstance(source_map, Mapping):
                ids = _source_ids(_field(source_map, factor_id))
                if ids:
                    return ids
        if factor_id in {"pe", "pb", "cashflow_yield"}:
            for key in ("quote", "valuation"):
                section = input_value.get(key)
                if isinstance(section, Mapping):
                    ids = _source_ids(section.get("source_ids"))
                    if ids:
                        return ids
    return _row_source_ids(current_row, default)


def _root_metrics(input_value: Any) -> dict[str, Any]:
    """Merge current public fundamentals with quote-level valuation fields."""

    if not isinstance(input_value, Mapping):
        return {}
    result: dict[str, Any] = {}
    fundamentals = input_value.get("fundamentals")
    if isinstance(fundamentals, Mapping):
        result.update(_metrics(fundamentals))
    quote = input_value.get("quote")
    if isinstance(quote, Mapping):
        for field in ("pe", "pb", "market_cap"):
            if quote.get(field) is not None:
                result[field] = quote[field]
    valuation = input_value.get("valuation")
    if isinstance(valuation, Mapping):
        aliases = {
            "pe": ("pe", "current_pe"),
            "pb": ("pb", "current_pb"),
            "market_cap": ("market_cap", "current_market_cap"),
        }
        for field, names in aliases.items():
            if result.get(field) is not None:
                continue
            value = _field(valuation, *names)
            if value is not None:
                result[field] = value
    return result


def build_fundamental_factors(
    input_value: Any,
    *,
    history: Sequence[Any] | None = None,
    universe: Sequence[Any] | None = None,
    percentile_map: Mapping[str, Any] | None = None,
    source_ids: Sequence[str] | None = None,
    as_of: str | None = None,
    research_cutoff_at: str | None = None,
    method_version: str = FUNDAMENTAL_FACTORS_METHOD_VERSION,
) -> dict[str, Any]:
    """Build six explainable fundamental groups from structured rows.

    ``input_value`` may be an Evidence bundle, a fundamentals row, or a list
    of rows.  Percentiles are read from explicit maps or a supplied universe;
    one-row inputs intentionally produce ``unavailable`` percentiles rather
    than a fake neutral score.
    """
    cutoff = normalize_asia_datetime(research_cutoff_at) if research_cutoff_at is not None else None
    if research_cutoff_at is not None and cutoff is None:
        raise ValueError(f"invalid research_cutoff_at {research_cutoff_at!r}")
    rows, excluded = _cutoff_rows(_history_rows(input_value, history), cutoff)
    current = _current_row(rows)
    current_metrics = {**_root_metrics(input_value), **_metrics(current)}
    default_sources = _source_ids(source_ids)
    if not default_sources and isinstance(input_value, Mapping):
        default_sources = _source_ids(input_value.get("source_ids"))
    if not default_sources:
        default_sources = _row_source_ids(current, [])
    effective_as_of = normalize_asia_datetime(as_of) or _as_of(current) or cutoff

    cross_rows = _universe_rows(input_value, universe)
    if cutoff is not None:
        cross_rows, excluded_cross = _cutoff_rows(cross_rows, cutoff)
        excluded = [*excluded, *excluded_cross]
    factors: list[dict[str, Any]] = []
    group_members: dict[str, list[dict[str, Any]]] = {group: [] for group in _GROUP_WEIGHTS}
    missing_fields: set[str] = set()

    for spec in _SPECS:
        raw_value = _derive_value(spec.factor_id, current_metrics, rows, current_row=current)
        if raw_value is None:
            missing_fields.add(spec.factor_id)
        raw_percentile = _explicit_percentile(
            input_value, spec.factor_id, current_metrics, percentile_map=percentile_map
        )
        comparison_scope = "explicit" if raw_percentile is not None else "unavailable"
        if raw_percentile is None and raw_value is not None:
            values: list[float] = []
            for row in cross_rows:
                value = _derive_value(spec.factor_id, _metrics(row), cross_rows, current_row=row)
                if value is not None:
                    values.append(value)
            if not values:
                values = _peer_values(input_value, spec.factor_id)
            if values:
                raw_percentile = _rank_percentile(raw_value, values)
                comparison_scope = "cross_section"
            elif spec.factor_id not in {"operating_cashflow", "pe", "pb", "cashflow_yield"}:
                # Ratios, margins and growth rates can be compared with the
                # company's own published history.  Do not compare cumulative
                # cash amounts across Q1/H1/FY periods or invent valuation
                # history from current quotes.
                own_history = [
                    value
                    for row in rows
                    if (
                        value := _derive_value(
                            spec.factor_id,
                            _metrics(row),
                            rows,
                            current_row=row,
                        )
                    )
                    is not None
                ]
                if len(own_history) >= 4:
                    raw_percentile = _rank_percentile(raw_value, own_history)
                    comparison_scope = "own_history"
        favorable_percentile = raw_percentile
        if favorable_percentile is not None and spec.polarity == "lower_is_better":
            favorable_percentile = 1 - favorable_percentile
        factor_sources = _metric_sources(input_value, spec.factor_id, current, default_sources)
        available = (
            raw_value is not None
            and favorable_percentile is not None
            and bool(factor_sources)
        )
        state = _state(favorable_percentile, available=available)
        direction = _direction(favorable_percentile, available=available)
        factor_weight = _GROUP_WEIGHTS[spec.group] * spec.weight
        contribution = (
            (favorable_percentile - 0.5) * 2 * factor_weight if favorable_percentile is not None else None
        )
        factor = {
            "id": spec.factor_id,
            "group": spec.group,
            "raw_value": raw_value,
            "raw": raw_value,
            "value": raw_value,
            "unit": spec.unit,
            "raw_percentile": raw_percentile,
            "percentile": favorable_percentile,
            "status": state,
            "state": state,
            "direction": direction,
            "polarity": spec.polarity,
            "comparison_scope": comparison_scope,
            "weight": factor_weight,
            "contribution": contribution,
            "method_version": method_version,
            "as_of": effective_as_of,
            "source_ids": factor_sources,
            "sources": factor_sources,
        }
        factors.append(factor)
        group_members[spec.group].append(factor)

    groups: dict[str, dict[str, Any]] = {}
    available_group_scores: list[tuple[float, float]] = []
    for group, group_weight in _GROUP_WEIGHTS.items():
        members = group_members[group]
        available_members = [item for item in members if item["percentile"] is not None]
        if not available_members:
            status = "missing"
            score = None
            contribution = None
        else:
            weights = [float(_SPEC_BY_ID[item["id"]].weight) for item in available_members]
            total_weight = sum(weights)
            score = sum(float(item["percentile"]) * weight for item, weight in zip(available_members, weights)) / total_weight
            contribution = sum(float(item["contribution"]) for item in available_members if item["contribution"] is not None)
            status = "available" if len(available_members) == len(members) else "degraded"
            available_group_scores.append((score, group_weight))
        groups[group] = {
            "status": status,
            "score": score,
            "direction": _direction(score, available=score is not None),
            "weight": group_weight,
            "contribution": contribution,
            "factor_ids": [item["id"] for item in members],
            "source_ids": sorted({sid for item in members for sid in item["source_ids"]}),
            "as_of": effective_as_of,
            "method_version": method_version,
            "missing_fields": [item["id"] for item in members if item["percentile"] is None],
        }
    total_weight = sum(weight for _, weight in available_group_scores)
    score = (
        sum(group_score * weight for group_score, weight in available_group_scores) / total_weight
        if total_weight
        else None
    )
    all_source_ids = sorted({sid for item in factors for sid in item["source_ids"]})
    core_group_ready = {
        "profitability": any(
            item["percentile"] is not None
            for item in group_members["profitability"]
            if item["id"] in {"roe", "gross_margin", "net_margin"}
        ),
        "growth_quality": any(
            item["percentile"] is not None
            for item in group_members["growth_quality"]
            if item["id"] in {"revenue_yoy", "profit_yoy"}
        ),
        "cashflow_quality": any(
            item["percentile"] is not None
            for item in group_members["cashflow_quality"]
            if item["id"] == "cashflow_to_profit"
        ),
        "financial_safety": any(
            item["percentile"] is not None
            for item in group_members["financial_safety"]
            if item["id"] == "debt_ratio"
        ),
        "valuation": any(
            item["percentile"] is not None
            for item in group_members["valuation"]
            if item["id"] in {"pe", "pb"}
        ),
    }
    status = (
        "missing"
        if not rows
        else ("available" if score is not None and all(core_group_ready.values()) else "degraded")
    )
    if any(item["status"] == "unavailable" for item in group_members["governance"]):
        missing_fields.update({"governance", "audit_or_restatement_status"})
    capex_input = _field(current_metrics, "capex", "capital_expenditure")
    cashflow_input = _field(current_metrics, "operating_cashflow", "operating_cash_flow")
    if capex_input is None or cashflow_input is None:
        missing_fields.add("capital_expenditure")
    return {
        "schema_version": FUNDAMENTAL_FACTORS_SCHEMA_VERSION,
        "method_version": method_version,
        "status": status,
        "score": score,
        "direction": _direction(score, available=score is not None),
        "as_of": effective_as_of,
        "research_cutoff_at": cutoff,
        "source_ids": sorted(set(default_sources) | set(all_source_ids)),
        "factors": factors,
        "groups": groups,
        "factor_groups": groups,
        "factor_contributions": {
            item["id"]: item["contribution"] for item in factors if item["contribution"] is not None
        },
        "missing_fields": sorted(missing_fields),
        "core_group_ready": core_group_ready,
        "excluded_future": excluded,
        "validation_status": "descriptive",
        "is_alpha_validated": False,
        "threshold_method": "percentile-30-70-v1",
    }


def compute_fundamental_factors(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Explicit synonym for callers that use a calculation-oriented name."""
    return build_fundamental_factors(*args, **kwargs)


def calculate_fundamental_factors(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Backward-compatible synonym used by early stage-B fixtures."""
    return build_fundamental_factors(*args, **kwargs)


class FundamentalFactorEngine:
    """Small stateless façade for dependency injection in Evidence/tests."""

    method_version = FUNDAMENTAL_FACTORS_METHOD_VERSION

    def __init__(self, *, method_version: str = FUNDAMENTAL_FACTORS_METHOD_VERSION) -> None:
        self.method_version = method_version

    def build(self, input_value: Any, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("method_version", self.method_version)
        return build_fundamental_factors(input_value, **kwargs)

    def calculate(self, input_value: Any, **kwargs: Any) -> dict[str, Any]:
        return self.build(input_value, **kwargs)


__all__ = [
    "FUNDAMENTAL_FACTORS_METHOD_VERSION",
    "FUNDAMENTAL_FACTORS_SCHEMA_VERSION",
    "FundamentalFactorEngine",
    "build_fundamental_factors",
    "calculate_fundamental_factors",
    "compute_fundamental_factors",
]
