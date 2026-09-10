"""Deterministic cross-sectional factors used by standard AI diagnosis.

The selection service is the source of truth for the market snapshot and
factor cache.  This module only turns that immutable, point-in-time input
into a target diagnosis view; it never treats a single target as a market
sample and it never promotes a descriptive rank to Alpha.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable, Mapping

from mona.services.stock.provenance import parse_asia_datetime
from mona.services.stock.quant_validation import validate_strategy
from mona.services.stock.screening import (
    MarketSnapshot,
    ScreeningStore,
    StockScreeningService,
    stable_json_hash,
)

HORIZONS = ("short_term", "medium_term", "long_term")
MARKET_MIN_SAMPLE = 30
INDUSTRY_MIN_SAMPLE = 5
DESCRIPTIVE_METHOD_VERSION = "diagnosis-descriptive-percentile-v1"
FACTOR_METHOD_VERSION = "diagnosis-cross-section-factor-v1"
RANK_METHOD_VERSION = "percentile-rank-v1"

# Evidence uses slightly different names from the selection snapshot.  The
# mapping is intentionally explicit so a missing field remains visible.
_BUNDLE_PATHS: dict[str, tuple[str, ...]] = {
    "momentum20": ("derived_decision_metrics", "momentum", "momentum20_pct"),
    "momentum60": ("derived_decision_metrics", "momentum", "momentum60_pct"),
    "volatility20": ("derived_decision_metrics", "volatility", "return_std20_pct"),
    "volume": ("quote", "volume"),
    "turnover": ("tradeability", "turnover_rate_pct"),
    "revenue_yoy": ("fundamentals", "metrics", "revenue_yoy"),
    "profit_yoy": ("fundamentals", "metrics", "profit_yoy"),
    "roe": ("fundamentals", "metrics", "roe"),
    "roic": ("fundamentals", "metrics", "roic"),
    "pe": ("quote", "pe"),
    "pb": ("quote", "pb"),
    "operating_cashflow": ("fundamentals", "metrics", "operating_cashflow"),
    "debt_ratio": ("fundamentals", "metrics", "debt_ratio"),
    "eps": ("fundamentals", "metrics", "eps"),
}

_HORIZON_FIELDS: dict[str, tuple[str, ...]] = {
    "short_term": ("momentum20", "momentum60", "volatility20", "volume", "turnover"),
    "medium_term": (
        "revenue_yoy", "profit_yoy", "roe", "roic", "momentum20", "momentum60",
    ),
    "long_term": (
        "pe", "pb", "roe", "roic", "operating_cashflow", "debt_ratio", "eps",
    ),
}

_DIRECTIONS: dict[str, dict[str, str]] = {
    "short_term": {
        "momentum20": "desc", "momentum60": "desc", "volatility20": "asc",
        "volume": "desc", "turnover": "desc",
    },
    "medium_term": {
        "revenue_yoy": "desc", "profit_yoy": "desc", "roe": "desc",
        "roic": "desc", "momentum20": "desc", "momentum60": "desc",
    },
    "long_term": {
        "pe": "asc", "pb": "asc", "roe": "desc", "roic": "desc",
        "operating_cashflow": "desc", "debt_ratio": "asc", "eps": "desc",
    },
}


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _source_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple, set)):
        return []
    return sorted({item.strip() for item in value if isinstance(item, str) and item.strip()})


def _date(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:10]


def _cutoff(bundle: Mapping[str, Any]) -> str | None:
    for key in ("market_as_of", "as_of", "research_cutoff_at"):
        value = bundle.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _at_or_before(value: Any, cutoff: str | None) -> bool:
    if not cutoff:
        return True
    observed = parse_asia_datetime(value)
    requested = parse_asia_datetime(cutoff)
    if observed is None or requested is None:
        return False
    return observed <= requested


def _same_day(value: Any, cutoff: str | None) -> bool:
    if not cutoff:
        return True
    return _date(value) == _date(cutoff)


def _within_prior_cache_window(value: Any, cutoff: str | None, *, max_age_days: int) -> bool:
    """Accept only bounded, point-in-time cache rows at or before cutoff."""

    observed = parse_asia_datetime(value)
    requested = parse_asia_datetime(cutoff)
    if observed is None or requested is None or observed > requested:
        return False
    return (requested - observed).total_seconds() <= max_age_days * 86_400


def _target_industry(bundle: Mapping[str, Any], rows: Iterable[Mapping[str, Any]]) -> str | None:
    direct = bundle.get("industry")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    for section_name in ("industry_context", "instrument", "quote"):
        section = bundle.get(section_name)
        if isinstance(section, Mapping):
            value = section.get("target_industry") or section.get("industry")
            if isinstance(value, str) and value.strip():
                return value.strip()
    instrument_id = _instrument_id(bundle)
    for row in rows:
        if row.get("instrument_id") == instrument_id:
            value = row.get("industry")
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _instrument_id(bundle: Mapping[str, Any]) -> str:
    value = bundle.get("instrument_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    instrument = bundle.get("instrument")
    if isinstance(instrument, Mapping):
        direct = instrument.get("instrument_id")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        exchange = instrument.get("exchange")
        symbol = instrument.get("symbol")
        if isinstance(exchange, str) and isinstance(symbol, str):
            return f"{exchange.strip().upper()}:{symbol.strip()}"
    return ""


def _bundle_factor(
    bundle: Mapping[str, Any], field: str, source_records: set[str]
) -> tuple[float | None, list[str], str | None, bool]:
    """Return value, closed sources, as-of and closure status for one target."""
    path = _BUNDLE_PATHS[field]
    current: Any = bundle
    for part in path:
        if not isinstance(current, Mapping) or part not in current:
            # A few providers expose turnover directly in tradeability under a
            # legacy name.  Keep this fallback explicit and auditable.
            if field == "turnover" and isinstance(bundle.get("quote"), Mapping):
                current = bundle["quote"].get("turnover_rate")
                break
            return None, [], None, False
        current = current[part]
    value = _finite(current)
    parent: Any = bundle
    for part in path[:-1]:
        if not isinstance(parent, Mapping):
            parent = {}
            break
        parent = parent.get(part)
    source_node = parent if isinstance(parent, Mapping) else {}
    if not _source_ids(source_node.get("source_ids")) and isinstance(bundle.get(path[0]), Mapping):
        # Fundamental source ownership is recorded at the section root;
        # kline-derived metrics commonly keep it on the nested metric node.
        source_node = bundle[path[0]]
    raw_ids = _source_ids(source_node.get("source_ids"))
    closed_ids = sorted(set(raw_ids) & source_records)
    closure_missing = bool(raw_ids) and len(closed_ids) != len(raw_ids)
    # Values without a source are deliberately not promoted to a factor.
    available = value is not None and bool(closed_ids) and not closure_missing
    as_of = next(
        (source_node.get(key) for key in ("as_of", "published_at", "period_end")
         if isinstance(source_node.get(key), str) and source_node.get(key)),
        None,
    )
    if not isinstance(as_of, str):
        as_of = _cutoff(bundle)
    return value if available else value, closed_ids, as_of, closure_missing


def _row_factor(field: str, row: Mapping[str, Any], factors: Mapping[str, Any]) -> float | None:
    if field == "volume":
        value = row.get("volume")
    elif field == "turnover":
        value = row.get("turnover_rate")
        if value is None:
            value = row.get("turnover")
        if value is None:
            value = row.get("amount")
    elif field in {"pe", "pb"}:
        value = row.get(field)
    else:
        aliases = {
            "momentum20": ("momentum20", "momentum20_pct"),
            "momentum60": ("momentum60", "momentum60_pct"),
            "volatility20": ("volatility20", "return_std20_pct"),
        }.get(field, (field,))
        value = next(
            (row.get(alias) for alias in aliases if row.get(alias) is not None),
            None,
        )
        if value is None:
            value = next((factors.get(alias) for alias in aliases if alias in factors), None)
    return _finite(value)


def _percentile(values: list[float], value: float | None) -> float | None:
    if value is None or len(values) < 2:
        return None
    ordered = sorted(values)
    below = sum(item <= value for item in ordered)
    return (below - 1) / (len(ordered) - 1)


def _rank(rows: Iterable[tuple[str, float]], target_id: str, direction: str) -> int | None:
    ordered = sorted(
        rows,
        key=lambda item: (-item[1] if direction == "desc" else item[1], item[0]),
    )
    for position, (instrument_id, _value) in enumerate(ordered, start=1):
        if instrument_id == target_id:
            return position
    return None


def _eligible_row(row: Mapping[str, Any]) -> bool:
    return (
        row.get("instrument_type", "equity") == "equity"
        and not bool(row.get("is_st"))
        and not bool(row.get("is_suspended"))
        and (row.get("listing_days") is None or row.get("listing_days", 0) >= 120)
    )


def _read_cache(
    *,
    cache_root: Path,
    bundle: Mapping[str, Any],
    allow_prior: bool = False,
    max_age_days: int = 7,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], str]:
    """Read same-day rows, or an explicitly bounded prior snapshot fallback."""
    root = cache_root.parent if cache_root.name == "cache" else cache_root
    try:
        store = ScreeningStore(root)
        cutoff = _cutoff(bundle)
        rows: dict[str, dict[str, Any]] = {}
        used_prior = False
        for snapshot, source in store.latest_snapshots_with_sources():
            observed = snapshot.observed_at or snapshot.as_of
            if not _at_or_before(observed, cutoff):
                continue
            same_day = _same_day(observed, cutoff)
            if not same_day and not (
                allow_prior
                and _within_prior_cache_window(observed, cutoff, max_age_days=max_age_days)
            ):
                continue
            used_prior = used_prior or not same_day
            if not _eligible_row(snapshot.model_dump(mode="json")):
                continue
            payload = snapshot.model_dump(mode="json")
            source_ids = _source_ids(payload.get("source_ids"))
            if source is not None:
                source_ids = sorted(set(source_ids) | {source.id})
            payload["source_ids"] = source_ids
            rows[payload["instrument_id"]] = payload
        factors = store.latest_factor_snapshots(as_of=cutoff)
        factors = {
            instrument_id: item
            for instrument_id, item in factors.items()
            if _same_day(item.get("as_of"), cutoff)
            or (
                allow_prior
                and _within_prior_cache_window(
                    item.get("as_of"), cutoff, max_age_days=max_age_days
                )
            )
        }
        if not rows:
            return [], factors, "cache_empty"
        return (
            list(rows.values()),
            factors,
            "recent_prior_cache" if used_prior else "same_day_cache",
        )
    except (OSError, RuntimeError, TypeError, ValueError):
        return [], {}, "cache_unavailable"


def _method_registry() -> dict[str, dict[str, Any]]:
    registry = StockScreeningService._quant_method_registry()
    # Keep the selection target windows and the diagnosis display method
    # together, so OOS metadata can be traced without claiming validation.
    return {
        horizon: {
            **method,
            "factorAlgorithmVersion": FACTOR_METHOD_VERSION,
            "rankAlgorithmVersion": RANK_METHOD_VERSION,
            "descriptiveRuleVersion": DESCRIPTIVE_METHOD_VERSION,
            "descriptiveRule": "percentile>=0.70 positive; <=0.30 negative; otherwise neutral",
        }
        for horizon, method in registry.items()
    }


def _factor_values(
    *,
    rows: list[dict[str, Any]],
    factors: Mapping[str, Mapping[str, Any]],
    target_id: str,
    target_values: Mapping[str, float | None],
) -> dict[str, dict[str, float | None]]:
    result: dict[str, dict[str, float | None]] = {}
    for row in rows:
        instrument_id = str(row.get("instrument_id") or "")
        cached = factors.get(instrument_id) or {}
        cached_values = cached.get("factors") if isinstance(cached, Mapping) else {}
        if not isinstance(cached_values, Mapping):
            cached_values = {}
        result[instrument_id] = {
            field: _row_factor(field, row, cached_values) for field in _BUNDLE_PATHS
        }
    result.setdefault(target_id, {field: None for field in _BUNDLE_PATHS})
    for field, value in target_values.items():
        # The frozen target bundle always overrides a stale cache row,
        # including an explicit missing value.
        result[target_id][field] = value
    return result


def _scope_values(
    values: Mapping[str, Mapping[str, float | None]],
    ids: Iterable[str],
    field: str,
) -> list[float]:
    return [
        value
        for instrument_id in ids
        for value in [_finite(values.get(instrument_id, {}).get(field))]
        if value is not None
    ]


def _composite(
    *,
    values: Mapping[str, Mapping[str, float | None]],
    ids: list[str],
    fields: tuple[str, ...],
    directions: Mapping[str, str],
    minimum: int,
) -> tuple[dict[str, float], dict[str, dict[str, float]], dict[str, list[float]]]:
    distributions = {field: _scope_values(values, ids, field) for field in fields}
    scores: dict[str, float] = {}
    contributions: dict[str, dict[str, float]] = {}
    for instrument_id in ids:
        raw: dict[str, float] = {}
        for field in fields:
            value = _finite(values.get(instrument_id, {}).get(field))
            distribution = distributions[field]
            if value is not None and len(distribution) >= minimum:
                percentile = _percentile(distribution, value)
                if percentile is not None:
                    raw[field] = percentile if directions[field] == "desc" else 1.0 - percentile
        if raw:
            # Equal weights are the registered selection method's default for
            # direct diagnosis; using the average keeps contributions additive.
            score = sum(raw.values()) / len(raw)
            scores[instrument_id] = score
            contributions[instrument_id] = {
                field: round(value / len(raw), 6) for field, value in raw.items()
            }
    return scores, contributions, distributions


def _signal(percentile: float | None) -> tuple[str, str, str]:
    if percentile is None:
        return "insufficient_data", "unavailable", "unavailable"
    if percentile >= 0.70:
        return "positive", "available", "descriptive"
    if percentile <= 0.30:
        return "negative", "available", "descriptive"
    return "neutral", "available", "descriptive"


def _calibration_result(
    records: Iterable[Mapping[str, Any]] | None, horizon: str
) -> dict[str, Any]:
    if records is None:
        return {
            "status": "research_only",
            "promotionStatus": "research_only",
            "eligibleForTrading": False,
            "validationStatus": "not_evaluable",
            "reason": "当前横截面结果尚无滚动样本外收益记录，仅作描述性观察",
            "metrics": {"status": "not_evaluable", "sampleCount": 0, "oosPeriods": 0},
        }
    result = validate_strategy(
        records,
        direction="desc",
        factor_id="composite_score",
        factor_direction="desc",
        strategy_horizon=horizon,
    )
    return result


def build_diagnosis_quant_payload(
    bundle: Mapping[str, Any],
    instrument_id: str | None = None,
    *,
    cache_root: str | Path | None = None,
    market_rows: Iterable[Mapping[str, Any] | MarketSnapshot] | None = None,
    cached_factors: Mapping[str, Mapping[str, Any]] | None = None,
    validation_records: Mapping[str, Iterable[Mapping[str, Any]]] | None = None,
    cache_status: str | None = None,
) -> dict[str, Any] | None:
    """Build immutable direct-diagnosis quant payload.

    ``market_rows`` is primarily a test/canary seam.  In production rows are
    read from the same screening cache built by
    :func:`ensure_diagnosis_cross_section_cache`.
    """
    if not isinstance(bundle, Mapping):
        return None
    target_id = instrument_id or _instrument_id(bundle)
    if not target_id:
        return None
    source_records = {
        source.get("id")
        for source in bundle.get("sources") or []
        if isinstance(source, Mapping) and isinstance(source.get("id"), str)
    }
    if market_rows is None:
        rows, factors, read_status = _read_cache(
            cache_root=Path(cache_root or (Path.home() / ".mona" / "stock" / "cache")),
            bundle=bundle,
        )
        cache_status = cache_status or read_status
    else:
        rows = []
        for raw in market_rows:
            if isinstance(raw, MarketSnapshot):
                row = raw.model_dump(mode="json")
            elif isinstance(raw, Mapping):
                row = dict(raw)
            else:
                continue
            if row.get("instrument_id") and _eligible_row(row):
                rows.append(row)
        factors = dict(cached_factors or {})
        cache_status = cache_status or "provided_fixture"
    # De-duplicate deterministically and ensure the frozen target row wins.
    by_id = {str(row.get("instrument_id")): row for row in rows if row.get("instrument_id")}
    target_row = by_id.get(target_id)
    if target_row is None:
        target_row = {
            "instrument_id": target_id,
            "industry": _target_industry(bundle, rows),
            **(dict(bundle.get("quote")) if isinstance(bundle.get("quote"), Mapping) else {}),
        }
        by_id[target_id] = target_row
    else:
        target_row = dict(target_row)
        by_id[target_id] = target_row
    rows = [by_id[key] for key in sorted(by_id)]
    industry = _target_industry(bundle, rows)
    if industry and not target_row.get("industry"):
        target_row["industry"] = industry

    target_values: dict[str, float | None] = {}
    target_sources: dict[str, list[str]] = {}
    target_as_of: dict[str, str | None] = {}
    closure_missing: set[str] = set()
    missing_target: set[str] = set()
    all_source_ids: set[str] = set()
    for field in _BUNDLE_PATHS:
        value, source_ids, as_of, source_gap = _bundle_factor(bundle, field, source_records)
        if source_gap:
            closure_missing.add(field)
        if value is None or not source_ids or source_gap:
            missing_target.add(field)
            target_values[field] = None
        else:
            target_values[field] = value
            target_sources[field] = source_ids
            target_as_of[field] = as_of
            all_source_ids.update(source_ids)

    values = _factor_values(
        rows=rows,
        factors=factors,
        target_id=target_id,
        target_values=target_values,
    )
    market_ids = sorted(values)
    industry_ids = [
        instrument_key
        for instrument_key in market_ids
        if industry and by_id.get(instrument_key, {}).get("industry") == industry
    ]
    if target_id not in industry_ids and industry:
        industry_ids.append(target_id)
    registry = _method_registry()
    cutoff = _cutoff(bundle)
    cross_section_as_of = max(
        (
            str(row.get("observed_at") or row.get("as_of"))
            for row in rows
            if row.get("observed_at") or row.get("as_of")
        ),
        default=None,
    )
    cohort_eligible = (
        cache_status in {"built", "same_day_cache", "provided_fixture", "fixture"}
        and _date(cross_section_as_of) == _date(cutoff)
    )
    horizons: dict[str, dict[str, Any]] = {}
    cross_section: dict[str, dict[str, Any]] = {}
    calibration_candidates: dict[str, dict[str, Any]] = {}
    horizon_signals: list[str] = []
    max_market_sample = 0
    max_observed_sample = 0
    target_observation_count = 0
    factor_scopes: dict[str, dict[str, Any]] = {}

    for horizon in HORIZONS:
        fields = _HORIZON_FIELDS[horizon]
        directions = _DIRECTIONS[horizon]
        market_scores, market_contributions, market_distributions = _composite(
            values=values,
            ids=market_ids,
            fields=fields,
            directions=directions,
            minimum=MARKET_MIN_SAMPLE,
        )
        market_sample_counts = {
            field: len(market_distributions[field]) for field in fields
        }
        market_valid = min(market_sample_counts.values(), default=0) >= MARKET_MIN_SAMPLE
        industry_counts = {
            field: len(_scope_values(values, industry_ids, field)) for field in fields
        }
        industry_valid = bool(industry) and min(industry_counts.values(), default=0) >= INDUSTRY_MIN_SAMPLE
        scope = "industry" if industry_valid else "market_fallback" if industry else "market"
        selected_ids = industry_ids if industry_valid else market_ids
        selected_minimum = INDUSTRY_MIN_SAMPLE if industry_valid else MARKET_MIN_SAMPLE
        selected_scores, selected_contributions, selected_distributions = _composite(
            values=values,
            ids=selected_ids,
            fields=fields,
            directions=directions,
            minimum=selected_minimum,
        )
        target_selected_score = selected_scores.get(target_id)
        target_market_score = market_scores.get(target_id)
        market_percentile = (
            _percentile(list(market_scores.values()), target_market_score)
            if market_valid and len(market_scores) >= MARKET_MIN_SAMPLE
            else None
        )
        industry_percentile = (
            _percentile(list(selected_scores.values()), target_selected_score)
            if industry_valid and len(selected_scores) >= INDUSTRY_MIN_SAMPLE
            else None
        )
        # Market validity is the hard signal gate.  Industry fallback still
        # exposes its explicit scope and uses market normalization.
        factor_score = target_market_score if market_percentile is not None else None
        signal, signal_status, validation_label = _signal(market_percentile)
        horizon_signals.append(signal)
        observations: list[dict[str, Any]] = []
        for field in fields:
            chosen_distribution = selected_distributions[field]
            raw_value = target_values.get(field)
            percentile = (
                _percentile(chosen_distribution, raw_value)
                if len(chosen_distribution) >= selected_minimum and raw_value is not None
                else None
            )
            rank_rows = [
                (key, _finite(values.get(key, {}).get(field)))
                for key in selected_ids
                if _finite(values.get(key, {}).get(field)) is not None
            ]
            direction = directions[field]
            rank = _rank(
                [(key, value) for key, value in rank_rows if value is not None],
                target_id,
                direction,
            ) if percentile is not None else None
            contribution = selected_contributions.get(target_id, {}).get(field)
            missing_count = len(selected_ids) - len(chosen_distribution)
            observations.append(
                {
                    "field": field,
                    "raw_value": raw_value,
                    "percentile_or_rank": percentile,
                    "rank": rank,
                    "direction": direction,
                    "scope": scope,
                    "sample_count": len(chosen_distribution),
                    "missing_count": max(0, missing_count),
                    "as_of": target_as_of.get(field) or _cutoff(bundle),
                    "source_ids": target_sources.get(field, []),
                    "method_version": FACTOR_METHOD_VERSION,
                    "rank_method_version": RANK_METHOD_VERSION,
                    "validation_status": "uncalibrated" if market_valid and percentile is not None else "insufficient_data",
                    "validation_label": validation_label if market_valid and percentile is not None else "unavailable",
                    "weight": round(1 / len(fields), 6),
                    "contribution": contribution,
                }
            )
            scope_payload = {
                "scope": scope,
                "sample_count": len(chosen_distribution),
                "missing_count": max(0, missing_count),
                "direction": direction,
                "weight": round(1 / len(fields), 6),
            }
            factor_scopes[f"{horizon}:{field}"] = scope_payload
            factor_scopes.setdefault(field, scope_payload)
        records = validation_records.get(horizon) if isinstance(validation_records, Mapping) else None
        calibration = _calibration_result(records, horizon)
        if calibration.get("promotionStatus") == "calibrated" and not cohort_eligible:
            calibration = {
                **calibration,
                "status": "research_only",
                "promotionStatus": "research_only",
                "eligibleForTrading": False,
                "reason": "当前横截面不是同日完整快照，历史校准不授权本次交易信号",
                "calibratedHorizon": None,
            }
        calibrated = calibration.get("promotionStatus") == "calibrated"
        if calibrated and market_percentile is not None:
            validation_label = "calibrated"
        horizon_payload = {
            "validation_status": "calibrated" if calibrated else "descriptive" if market_valid else "unavailable",
            "quant_signal": signal,
            "signal": signal_status if signal == "insufficient_data" else signal,
            "signal_status": signal_status,
            "validation_label": validation_label,
            "alpha_status": "validated" if calibrated else "not_validated",
            "composite_score": factor_score,
            "factor_score": factor_score,
            "market_percentile": market_percentile,
            "industry_percentile": industry_percentile,
            "factor_contributions": selected_contributions.get(target_id, {}) if market_valid else {},
            "market_sample_count": min(market_sample_counts.values(), default=0),
            "industry_sample_count": min(industry_counts.values(), default=0) if industry else 0,
            "sample_counts": {
                "market": market_sample_counts,
                "industry": industry_counts if industry else {},
                "effective": min(market_sample_counts.values(), default=0),
            },
            "scope": scope,
            "method_versions": {
                "factor": FACTOR_METHOD_VERSION,
                "rank": RANK_METHOD_VERSION,
                "descriptive": DESCRIPTIVE_METHOD_VERSION,
                "selection": registry[horizon].get("version"),
            },
            "method_id": registry[horizon].get("methodId"),
            "method_version": registry[horizon].get("version"),
            "target_window_sessions": registry[horizon].get("targetWindowSessions"),
            "target_definition": registry[horizon].get("targetDefinition"),
            "calibration": calibration,
            "factor_observations": observations,
        }
        horizons[horizon] = horizon_payload
        complete_ids = [
            instrument_key
            for instrument_key in market_ids
            if all(
                _finite(values.get(instrument_key, {}).get(field)) is not None
                for field in fields
            )
            and instrument_key in market_scores
        ]
        cohort_rows: list[dict[str, Any]] = []
        for instrument_key in complete_ids:
            market_row = by_id.get(instrument_key) or {}
            reference_price = _finite(market_row.get("price"))
            peer_factor = factors.get(instrument_key) or {}
            row_sources = set(_source_ids(market_row.get("source_ids")))
            row_sources.update(_source_ids(peer_factor.get("source_ids")))
            if instrument_key == target_id:
                row_sources.update(
                    source_id
                    for field_sources in target_sources.values()
                    for source_id in field_sources
                )
            if reference_price is None or reference_price <= 0 or not row_sources:
                continue
            cohort_rows.append(
                {
                    "instrument_id": instrument_key,
                    "composite_score": round(float(market_scores[instrument_key]), 10),
                    "reference_price": reference_price,
                    "source_ids": sorted(row_sources),
                }
            )
        method_id = str(registry[horizon].get("methodId") or horizon)
        calibration_candidates[horizon] = {
            "strategy_id": f"diagnosis-{method_id}",
            "strategy_fingerprint": stable_json_hash(
                {
                    "strategy": "diagnosis_cross_section",
                    "horizon": horizon,
                    "method": registry[horizon],
                    "factor_version": FACTOR_METHOD_VERSION,
                }
            ),
            "as_of": cutoff,
            "factor_version": FACTOR_METHOD_VERSION,
            "rank_version": RANK_METHOD_VERSION,
            "validation_window": int(
                registry[horizon].get("targetWindowSessions") or 10
            ),
            "universe_count": len(market_ids),
            "observed_count": len(cohort_rows),
            "rows": cohort_rows,
            "cohort_eligible": cohort_eligible,
        }
        max_market_sample = max(max_market_sample, min(market_sample_counts.values(), default=0))
        max_observed_sample = max(max_observed_sample, len(market_scores))
        target_observation_count += sum(item["raw_value"] is not None for item in observations)
        cross_section[horizon] = {
            "scope": scope,
            "market_count": min(market_sample_counts.values(), default=0),
            "industry_count": min(industry_counts.values(), default=0) if industry else 0,
            "market_valid": market_valid,
            "industry_valid": industry_valid,
            "target_score": factor_score,
            "market_percentile": market_percentile,
            "industry_percentile": industry_percentile,
        }

    any_available = any(item.get("signal_status") == "available" for item in horizons.values())
    top_signal = next((item for item in horizon_signals if item != "insufficient_data"), "insufficient_data")
    # Keep the legacy top-level status as ``uncalibrated`` when raw target
    # factors exist, while every horizon and the signal itself remain
    # ``insufficient_data`` until the market sample gate is met.  This makes
    # the unavailable scope explicit without reintroducing a neutral signal.
    top_status = "uncalibrated" if target_observation_count else "insufficient_data"
    calibration_promotions = [
        item["calibration"] for item in horizons.values()
        if item.get("calibration", {}).get("promotionStatus") == "calibrated"
    ]
    if calibration_promotions:
        top_status = "calibrated"
    promotion = calibration_promotions[0] if calibration_promotions else _calibration_result(None, "medium_term")
    if any_available:
        reason = "当前横截面评分和分位为描述性结果；OOS滚动样本外验证未通过或尚未形成，不代表Alpha。"
    else:
        reason = "市场有效样本不足30只或目标因子缺失，当前量化信号不可用；不会退化为单股中性。"
    normalized_factors = {
        instrument_id: {
            "as_of": item.get("as_of"),
            "algorithm_version": item.get("algorithm_version"),
            "factors": item.get("factors") or {},
        }
        for instrument_id, item in factors.items()
        if isinstance(item, Mapping)
    }
    cache_rows_hash = stable_json_hash(
        {"as_of": cutoff, "rows": rows, "factors": normalized_factors}
    )
    validation_metrics = {
        "status": "available" if calibration_promotions else "not_evaluable",
        "sampleScope": "current_cross_section" if any_available else "single_instrument_or_insufficient_cross_section",
        "sampleCount": target_observation_count,
        "marketSampleCount": max_market_sample,
        "observedSampleCount": max_observed_sample,
        "crossSection": cross_section,
        "oosPeriods": max(
            int((item.get("calibration", {}).get("metrics") or {}).get("oosPeriods") or 0)
            for item in horizons.values()
        ),
        "calibrationRequired": not bool(calibration_promotions),
        "reason": "OOS=0时仅标记descriptive；通过既有滚动OOS晋级门槛后才可标记calibrated",
    }
    quant_snapshot = {
        "schema_version": 1,
        "strategy_id": "deep_research_factor_observation",
        "strategy_fingerprint": stable_json_hash(
            {"strategy": "diagnosis_cross_section", "registry": registry, "factor_version": FACTOR_METHOD_VERSION}
        ),
        "as_of": cutoff,
        "snapshot_as_of": cross_section_as_of or cutoff,
        "universe_definition": "screening_default_eligible_universe",
        "factor_algorithm_version": FACTOR_METHOD_VERSION,
        "rank_algorithm_version": RANK_METHOD_VERSION,
        "validation_status": top_status,
        "reason": reason,
        "universe": {
            "universe_count": len(rows),
            "hard_filter_count": len(rows),
            "cheap_count": len(rows),
            "enriched_count": len(factors),
            "unprocessed_after_cap": 0,
            "preselection_basis": "screening_default_eligible_universe",
        },
        "factor_scopes": factor_scopes,
        "candidate_ids_hash": stable_json_hash(sorted(by_id)),
        "source_ids": sorted(all_source_ids),
        "source_closure_missing": sorted(closure_missing),
        "data_quality": {
            "status": "available" if any_available else "unavailable",
            "quant_validation_status": top_status,
            "reason": reason,
            "point_in_time": {
                "status": "verified" if cutoff else "unknown",
                "requested_as_of": cutoff,
                "latest_observed_at": cutoff,
                "missing_observed_at": 0 if cutoff else 1,
            },
            "missing_factor_fields": sorted(missing_target),
            "source_closure_missing": sorted(closure_missing),
            "market_sample_count": max_market_sample,
            "industry_sample_count": max(
                (item["industry_sample_count"] for item in horizons.values()), default=0
            ),
        },
        "promotion_status": promotion.get("promotionStatus", "research_only"),
        "promotion_reason": promotion.get("reason") or reason,
        "eligible_for_trading": promotion.get("eligibleForTrading") is True,
        "strategy_horizon": None,
        "calibrated_horizon": None,
        "method_registry": registry,
        "method_versions": {
            "factor": FACTOR_METHOD_VERSION,
            "rank": RANK_METHOD_VERSION,
            "descriptive": DESCRIPTIVE_METHOD_VERSION,
        },
        "validation_metrics": validation_metrics,
        "cache": {
            # Acquisition path is operational metadata, not part of the
            # diagnosis result.  Normalize it so first-build and cache-hit
            # runs produce the same immutable structure.
            "status": (
                cache_status
                if max_market_sample >= MARKET_MIN_SAMPLE and cache_status
                else "unavailable"
            ),
            "as_of": cutoff,
            "cross_section_as_of": cross_section_as_of,
            "universe_definition": "screening_default_eligible_universe",
            "content_hash": cache_rows_hash,
            "sample_counts": {h: item["market_sample_count"] for h, item in horizons.items()},
            "missing_counts": {h: item["sample_counts"]["market"] for h, item in horizons.items()},
        },
    }
    quant_validation = {
        "snapshot_as_of": cross_section_as_of or cutoff,
        "universe_definition": "screening_default_eligible_universe",
        "validation_status": top_status,
        "quant_signal": top_signal,
        "horizons": horizons,
        "source_closure_missing": sorted(closure_missing),
        "promotion_status": promotion.get("promotionStatus", "research_only"),
        "promotion_reason": promotion.get("reason") or reason,
        "eligible_for_trading": promotion.get("eligibleForTrading") is True,
        "strategy_horizon": None,
        "calibrated_horizon": None,
        "validation_metrics": validation_metrics,
    }
    return {
        "quant_snapshot": quant_snapshot,
        "quant_validation": quant_validation,
        "_calibration_candidates": calibration_candidates,
    }


async def ensure_diagnosis_cross_section_cache(
    *,
    provider: Any | None,
    cache_root: str | Path,
    workspace: str | Path | None,
    as_of: str | None,
) -> dict[str, Any]:
    """Use same-day screening cache, building it once when absent.

    The function is intentionally idempotent.  A missing provider/cache is a
    truthful unavailable result; it never creates a one-row neutral universe.
    """
    root = Path(cache_root)
    probe = {"market_as_of": as_of} if as_of else {}
    rows, factors, status = _read_cache(cache_root=root, bundle=probe)
    if len(rows) >= MARKET_MIN_SAMPLE:
        return {"rows": rows, "factors": factors, "status": status, "built": False}
    prior_rows, prior_factors, prior_status = _read_cache(
        cache_root=root,
        bundle=probe,
        allow_prior=True,
    )
    if len(prior_rows) >= MARKET_MIN_SAMPLE:
        return {
            "rows": prior_rows,
            "factors": prior_factors,
            "status": prior_status,
            "built": False,
        }
    if provider is None or not hasattr(provider, "market_snapshot"):
        return {"rows": rows, "factors": factors, "status": "unavailable", "built": False}
    try:
        service = StockScreeningService(
            provider=provider,
            root=root.parent if root.name == "cache" else root,
            workspace=workspace,
        )
        prepared = await service.build_diagnosis_cross_section(as_of=as_of)
        prepared_rows = [item.model_dump(mode="json") for item in prepared.get("rows", [])]
        if len(prepared_rows) < MARKET_MIN_SAMPLE:
            return {
                "rows": prior_rows,
                "factors": prior_factors,
                "status": prior_status if prior_rows else "unavailable",
                "built": False,
            }
        return {
            "rows": prepared_rows,
            "factors": prepared.get("factors", {}),
            "status": "built",
            "built": True,
        }
    except Exception:
        return {
            "rows": prior_rows,
            "factors": prior_factors,
            "status": prior_status if prior_rows else "unavailable",
            "built": False,
        }


__all__ = [
    "DESCRIPTIVE_METHOD_VERSION",
    "FACTOR_METHOD_VERSION",
    "INDUSTRY_MIN_SAMPLE",
    "MARKET_MIN_SAMPLE",
    "RANK_METHOD_VERSION",
    "build_diagnosis_quant_payload",
    "ensure_diagnosis_cross_section_cache",
]
