"""Workflow-run evidence bootstrap (stock-module design §5.2, dev plan T21).

Before the first step of a stock workflow run executes, every symbol in
``run.inputs["symbols"]`` gets its trimmed, immutable EvidenceBundle under
``<workspace>/stock_projects/<run_id>/evidence.json`` — analysts read this
prepared data and never fetch their own (design §5.2). Instrument types
(``equity`` / ``etf``) come from the watchlist, so an ETF keeps its template
fields end to end; unknown symbols default to ``equity``.

Failures are explicit: an invalid symbol or an unavailable trading calendar
raises, the runner marks the run failed, and no agent ever runs against a
half-built bundle.
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.workflow import WorkflowRun
from mona.config.paths import get_stock_project_dir
from mona.services.stock.diagnosis_quant import (
    build_diagnosis_quant_payload,
    ensure_diagnosis_cross_section_cache,
)
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.failover import FailoverProvider
from mona.services.stock.material_evidence import MaterialBindingError, MaterialBindingStore
from mona.services.stock.provenance import SourceRecord, parse_asia_datetime
from mona.services.stock.provider import (
    EastMoneyProvider,
    GovernmentResearchProvider,
    InstrumentRef,
)
from mona.services.stock.provider_tencent import TencentProvider
from mona.services.stock.screening import (
    QuantCandidateValidation,
    QuantDataQuality,
    QuantFactorObservation,
    QuantHorizonValidation,
    QuantPointInTimeQuality,
    QuantSnapshot,
    QuantUniverse,
    ScreeningStore,
    StockScreeningService,
    stable_json_hash,
)
from mona.services.stock.storage import WatchlistStore

_EXCHANGES = ("XSHG", "XSHE", "BJSE")
_SELECTION_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
_SELECTION_ORIGIN_USAGE_NOTE = (
    "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。"
)
_SELECTION_REASON_LIMIT = 3
_SELECTION_REASON_MAX_LENGTH = 240
_FOCUS_QUESTION_LIMIT = 12
_FOCUS_QUESTION_MAX_LENGTH = 240
_PROMOTION_FIELDS = (
    "promotion_status",
    "promotion_reason",
    "eligible_for_trading",
    "validation_metrics",
    "strategy_horizon",
    "calibrated_horizon",
)

# Direct deep research does not have a selection report to inherit.  It still
# gets a deterministic, source-closed factor observation snapshot.  The
# snapshot is intentionally research-only until full-universe walk-forward
# evidence promotes the same method; it must never manufacture a trading
# signal from one stock's raw values.
_DIRECT_QUANT_STRATEGY_ID = "deep_research_factor_observation"
_DIRECT_QUANT_FACTOR_VERSION = "deep-research-factor-observation-v1"
_DIRECT_QUANT_RANK_VERSION = "deep-research-factor-observation-v1"
_DIRECT_QUANT_METHODS: dict[str, dict[str, tuple[str, ...]]] = {
    "short_term": {
        "momentum20": ("derived_decision_metrics", "momentum", "momentum20_pct"),
        "momentum60": ("derived_decision_metrics", "momentum", "momentum60_pct"),
        "volatility20": ("derived_decision_metrics", "volatility", "return_std20_pct"),
        "volume": ("quote", "volume"),
        "turnover": ("tradeability", "turnover_rate_pct"),
    },
    "medium_term": {
        "revenue_yoy": ("fundamentals", "metrics", "revenue_yoy"),
        "profit_yoy": ("fundamentals", "metrics", "profit_yoy"),
        "roe": ("fundamentals", "metrics", "roe"),
        "roic": ("fundamentals", "metrics", "roic"),
        "momentum20": ("derived_decision_metrics", "momentum", "momentum20_pct"),
        "momentum60": ("derived_decision_metrics", "momentum", "momentum60_pct"),
    },
    "long_term": {
        "pe": ("quote", "pe"),
        "pb": ("quote", "pb"),
        "roe": ("fundamentals", "metrics", "roe"),
        "roic": ("fundamentals", "metrics", "roic"),
        "operating_cashflow": ("fundamentals", "metrics", "operating_cashflow"),
        "debt_ratio": ("fundamentals", "metrics", "debt_ratio"),
        "eps": ("fundamentals", "metrics", "eps"),
    },
}
_DIRECT_QUANT_DIRECTIONS: dict[str, dict[str, str]] = {
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


def _validated_promotion_fields(
    snapshot: dict[str, Any], candidate: dict[str, Any], sidecar: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate promotion data after both persisted sides have been parsed."""
    if candidate != sidecar:
        return None, "选股量化候选内容与报告不一致，未注入量化验证"
    snapshot_promotion = {
        field: snapshot.get(field)
        for field in _PROMOTION_FIELDS
        if field in snapshot
    }
    candidate_promotion = {
        field: candidate.get(field)
        for field in _PROMOTION_FIELDS
        if field in candidate
    }
    if any(
        field in snapshot_promotion and snapshot_promotion[field] != candidate_promotion.get(field)
        for field in _PROMOTION_FIELDS
    ):
        return None, "选股量化晋级字段与快照不一致，未注入量化验证"
    promotion_status = candidate_promotion["promotion_status"]
    eligible_for_trading = candidate_promotion["eligible_for_trading"]
    if promotion_status not in {"research_only", "calibrated", "rejected"}:
        return None, "选股量化晋级状态无效，未注入量化验证"
    if not isinstance(eligible_for_trading, bool) or eligible_for_trading != (
        promotion_status == "calibrated"
    ):
        return None, "选股量化交易资格与晋级状态不一致，未注入量化验证"
    if not isinstance(candidate_promotion["promotion_reason"], str) or not candidate_promotion["promotion_reason"].strip():
        return None, "选股量化晋级原因无效，未注入量化验证"
    if not isinstance(candidate_promotion["validation_metrics"], dict):
        return None, "选股量化验证指标无效，未注入量化验证"
    for field in ("strategy_horizon", "calibrated_horizon"):
        value = candidate_promotion.get(field)
        if value is not None and value not in {"short_term", "medium_term", "long_term"}:
            return None, "选股量化周期字段无效，未注入量化验证"
    if (
        promotion_status == "calibrated"
        and (
            candidate_promotion.get("strategy_horizon") is not None
            or candidate_promotion.get("calibrated_horizon") is not None
        )
        and candidate_promotion.get("strategy_horizon")
        != candidate_promotion.get("calibrated_horizon")
    ):
        return None, "选股量化策略周期与校准周期不一致，未注入量化验证"
    return candidate_promotion, None


def _default_provider() -> Any:
    """Real data source; tests rebind this seam with a mock."""
    return FailoverProvider(TencentProvider(), EastMoneyProvider())


def _default_watchlist_root() -> Path:
    """Global watchlist root (``~/.mona/stock``); tests rebind it."""
    return Path.home() / ".mona" / "stock"


def _default_cache_root() -> Path:
    """Raw-kline TTL cache root (``~/.mona/stock/cache``); tests rebind it."""
    return Path.home() / ".mona" / "stock" / "cache"


def _parse_symbol(entry: Any) -> str:
    """Validate one ``EXCHANGE:symbol`` input entry; returns it normalized."""
    if not isinstance(entry, str):
        raise ValueError(f"run inputs symbols entries must be strings, got {entry!r}")
    exchange, sep, symbol = entry.strip().partition(":")
    if not sep or exchange.upper() not in _EXCHANGES:
        raise ValueError(f"invalid symbol {entry!r}: expect EXCHANGE:symbol")
    if len(symbol) != 6 or not symbol.isdigit():
        raise ValueError(f"invalid symbol {entry!r}: expect 6 digits")
    return f"{exchange.upper()}:{symbol}"


def _report_value(payload: dict[str, Any], name: str) -> Any:
    """Read persisted reports written by either snake- or camel-case models."""
    if name in payload:
        return payload[name]
    parts = name.split("_")
    return payload.get(parts[0] + "".join(part.title() for part in parts[1:]))


def _research_ready(readiness: Any) -> bool:
    """Allow research-only runs while keeping V5 trade gating downstream."""
    if not isinstance(readiness, dict):
        return False
    research = readiness.get("research_ready")
    if isinstance(research, dict):
        return research.get("status") == "ready"
    # Legacy V5 fixtures have only the top-level status; preserve their seam.
    return readiness.get("status") == "ready"


def _core_research_ready(bundle: Any) -> bool:
    """Keep the six-agent boundary closed when concrete evidence is present."""
    if not isinstance(bundle, dict):
        return False
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, dict):
        return False
    core = readiness.get("core")
    if isinstance(core, dict) and core.get("status") in {"failed", "insufficient_data"}:
        return False
    if not any(key in bundle for key in ("quote", "kline_ref", "derived_decision_metrics")):
        return _research_ready(readiness)
    quote = bundle.get("quote")
    price = quote.get("price") if isinstance(quote, dict) else None
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price <= 0:
        return False
    kline_ref = bundle.get("kline_ref")
    try:
        bars = int(kline_ref.get("bars") or 0) if isinstance(kline_ref, dict) else 0
    except (TypeError, ValueError):
        return False
    if bars < 60:
        return False
    derived = bundle.get("derived_decision_metrics")
    return isinstance(derived, dict) and all(
        isinstance(derived.get(name), dict)
        for name in ("atr20", "trend", "volatility", "swing", "stop_distance")
    )


def _read_report(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"{label} not found")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is unreadable") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be an object")
    return payload


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    """Atomically persist the run evidence after a trusted local merge."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _quant_snapshot_payload(value: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Return snake-case and public forms of a persisted quant snapshot."""
    if not isinstance(value, dict):
        return None, None
    try:
        model = QuantSnapshot.model_validate(value)
    except (TypeError, ValueError):
        return None, None
    return model.model_dump(mode="json"), model.model_dump(by_alias=True, mode="json")


def _quant_candidate_payload(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    try:
        return QuantCandidateValidation.model_validate(value).model_dump(mode="json")
    except (TypeError, ValueError):
        return None


def _direct_quant_value(bundle: dict[str, Any], path: tuple[str, ...]) -> tuple[float | None, list[str], str | None]:
    """Read one numeric point-in-time factor and its exact Evidence provenance."""
    current: Any = bundle
    for part in path:
        if not isinstance(current, dict) or part not in current:
            return None, [], None
        current = current[part]
    if isinstance(current, bool) or not isinstance(current, (int, float)):
        return None, [], None
    value = float(current)
    if not math.isfinite(value):
        return None, [], None

    parent: Any = bundle
    for part in path[:-1]:
        if not isinstance(parent, dict) or part not in parent:
            parent = {}
            break
        parent = parent[part]
    source_node: Any = parent
    if path[0] == "fundamentals":
        source_node = bundle.get("fundamentals")
    source_ids = source_node.get("source_ids") if isinstance(source_node, dict) else []
    if isinstance(source_ids, str):
        source_ids = [source_ids]
    source_ids = sorted({item for item in source_ids or [] if isinstance(item, str) and item})
    as_of = None
    for key in ("as_of", "published_at", "period_end"):
        candidate = source_node.get(key) if isinstance(source_node, dict) else None
        if isinstance(candidate, str) and candidate:
            as_of = candidate
            break
    if as_of is None:
        as_of = bundle.get("market_as_of") or bundle.get("as_of")
    return value, source_ids, as_of if isinstance(as_of, str) else None


def _direct_quant_method_registry() -> dict[str, dict[str, Any]]:
    """Expose the same three-period method registry used by selection."""
    return StockScreeningService._quant_method_registry()


def _direct_quant_percentile(values: list[float], value: float) -> float | None:
    """Return the deterministic raw percentile used by the selector."""
    if len(values) < 2:
        return None
    ordered = sorted(values)
    below = sum(item <= value for item in ordered)
    return (below - 1) / (len(ordered) - 1)


def _direct_quant_cache(
    *, cache_root: Path, bundle: dict[str, Any], instrument_id: str
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    """Read the existing selection caches without contacting an upstream.

    ``instrument_snapshot`` provides the current cross-section while
    ``factor_snapshot`` supplies already-computed kline/fundamental factors.
    Both are bounded by the frozen research cutoff; no current data is used to
    backfill a historical run.
    """
    try:
        store = ScreeningStore(cache_root.parent)
        cutoff = parse_asia_datetime(
            bundle.get("market_as_of") or bundle.get("as_of") or bundle.get("research_cutoff_at")
        )
        rows: list[dict[str, Any]] = []
        for snapshot, source in store.latest_snapshots_with_sources():
            observed = parse_asia_datetime(snapshot.observed_at or snapshot.as_of)
            if cutoff is not None and (observed is None or observed > cutoff):
                continue
            payload = snapshot.model_dump(mode="json")
            if source is not None:
                payload["source_ids"] = sorted(
                    set(payload.get("source_ids") or []) | {source.id}
                )
            rows.append(payload)
        factors = store.latest_factor_snapshots(
            as_of=(
                (bundle.get("market_as_of") or bundle.get("as_of"))
                if isinstance(bundle.get("market_as_of") or bundle.get("as_of"), str)
                else None
            )
        )
        # A cache can contain a stale target row from an older selection.  It
        # is still useful as a peer only when it is no newer than the cutoff;
        # the frozen evidence value always replaces it for the target.
        return rows, factors
    except (OSError, RuntimeError, TypeError, ValueError):
        return [], {}


def _direct_quant_target_industry(
    bundle: dict[str, Any], rows: list[dict[str, Any]], instrument_id: str
) -> str | None:
    for section_name in ("industry_context", "instrument"):
        section = bundle.get(section_name)
        if isinstance(section, dict):
            value = section.get("target_industry") or section.get("industry")
            if isinstance(value, str) and value.strip():
                return value.strip()
    for row in rows:
        if row.get("instrument_id") == instrument_id:
            value = row.get("industry")
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _direct_quant_peer_value(
    field: str, row: dict[str, Any], factors: dict[str, Any]
) -> float | None:
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
        value = next((factors.get(alias) for alias in aliases if alias in factors), None)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(float(value)) else None


def _direct_quant_rank(
    rows: list[tuple[str, float]], target_id: str, direction: str
) -> int | None:
    if len(rows) < 2:
        return None
    ordered = sorted(
        rows,
        key=lambda item: (
            -item[1] if direction == "desc" else item[1],
            item[0],
        ),
    )
    for position, (instrument_id, _value) in enumerate(ordered, start=1):
        if instrument_id == target_id:
            return position
    return None


def _build_direct_quant_payload(
    bundle: dict[str, Any], instrument_id: str, *, cache_root: Path | None = None
) -> dict[str, Any] | None:
    """Build current cross-sectional factor observations for direct research.

    The current percentile/rank is descriptive and comes from the existing
    market/factor cache.  It is intentionally separate from OOS calibration:
    a rank can be shown to the user while the promotion gate remains
    ``research_only`` until future-return validation passes.
    """
    if not isinstance(bundle, dict) or not instrument_id:
        return None
    # The reusable diagnosis service owns cross-sectional scoring.  Keep this
    # compatibility seam for callers/tests that used the old run-init helper.
    return build_diagnosis_quant_payload(
        bundle,
        instrument_id,
        cache_root=cache_root or _default_cache_root(),
    )
    if isinstance(bundle.get("quant_validation"), dict):
        return None
    source_records = {
        source.get("id")
        for source in bundle.get("sources") or []
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    cache_root = cache_root or _default_cache_root()
    market_rows, cached_factors = _direct_quant_cache(
        cache_root=cache_root, bundle=bundle, instrument_id=instrument_id
    )
    target_industry = _direct_quant_target_industry(bundle, market_rows, instrument_id)
    target_row = next(
        (row for row in market_rows if row.get("instrument_id") == instrument_id),
        None,
    )
    if target_row is None:
        target_row = {
            "instrument_id": instrument_id,
            "industry": target_industry,
            **(bundle.get("quote") or {}),
        }
    if target_industry and not target_row.get("industry"):
        target_row["industry"] = target_industry
    if not any(row.get("instrument_id") == instrument_id for row in market_rows):
        market_rows = [*market_rows, target_row]
    method_registry = _direct_quant_method_registry()
    horizons: dict[str, dict[str, Any]] = {}
    all_source_ids: set[str] = set()
    missing_fields: set[str] = set()
    source_closure_missing: set[str] = set()
    factor_scopes: dict[str, dict[str, Any]] = {}
    total_observations = 0
    cross_section: dict[str, dict[str, Any]] = {}
    rank_missing_fields: set[str] = set()

    industry_scoped_fields = {
        "revenue_yoy", "profit_yoy", "roe", "roic", "pe", "pb",
        "operating_cashflow", "debt_ratio", "eps",
    }

    for horizon, factors in _DIRECT_QUANT_METHODS.items():
        observations: list[dict[str, Any]] = []
        horizon_scope: str | None = None
        horizon_universe = 0
        horizon_observed = 0
        horizon_ranks: dict[str, int] = {}
        for field, path in factors.items():
            value, source_ids, as_of = _direct_quant_value(bundle, path)
            closed_source_ids = sorted(set(source_ids) & source_records)
            if source_ids and len(closed_source_ids) != len(source_ids):
                source_closure_missing.add(field)
                closed_source_ids = []
            available = value is not None and bool(closed_source_ids)
            if not available:
                missing_fields.add(field)
            else:
                total_observations += 1
                all_source_ids.update(closed_source_ids)

            peer_rows = market_rows
            scope = "market"
            if field in industry_scoped_fields and target_industry:
                industry_rows = [
                    row for row in market_rows if row.get("industry") == target_industry
                ]
                if len(industry_rows) >= 2:
                    peer_rows = industry_rows
                    scope = "industry"
                else:
                    scope = "market_fallback"
            target_factor_cache = cached_factors.get(instrument_id) or {}
            target_factor_values = target_factor_cache.get("factors") or {}
            peer_values: list[float] = []
            ranked_rows: list[tuple[str, float]] = []
            for peer in peer_rows:
                peer_id = str(peer.get("instrument_id") or "")
                peer_factor_values = (cached_factors.get(peer_id) or {}).get("factors") or {}
                peer_value = value if peer_id == instrument_id else _direct_quant_peer_value(
                    field, peer, peer_factor_values
                )
                if peer_id == instrument_id and peer_value is None:
                    peer_value = _direct_quant_peer_value(field, peer, target_factor_values)
                if peer_value is None:
                    continue
                peer_values.append(peer_value)
                ranked_rows.append((peer_id, peer_value))
            percentile = (
                _direct_quant_percentile(peer_values, value)
                if available
                else None
            )
            rank = (
                _direct_quant_rank(
                    ranked_rows,
                    instrument_id,
                    _DIRECT_QUANT_DIRECTIONS[horizon][field],
                )
                if available
                else None
            )
            if available and rank is None:
                rank_missing_fields.add(field)
            if available:
                horizon_scope = scope if horizon_scope in (None, scope) else "mixed"
                horizon_universe = max(horizon_universe, len(peer_rows))
                horizon_observed = max(horizon_observed, len(peer_values))
                if rank is not None:
                    horizon_ranks[field] = rank
            observation = QuantFactorObservation.model_validate(
                {
                    "field": field,
                    "raw_value": value if available else None,
                    "percentile_or_rank": percentile,
                    "rank": rank,
                    "direction": _DIRECT_QUANT_DIRECTIONS[horizon][field],
                    "scope": scope,
                    "sample_count": len(peer_values) if available else 0,
                    "missing_count": max(0, len(peer_rows) - len(peer_values)) if available else 1,
                    "as_of": as_of,
                    "source_ids": closed_source_ids,
                    "method_version": _DIRECT_QUANT_FACTOR_VERSION,
                    "validation_status": "uncalibrated" if available else "insufficient_data",
                }
            ).model_dump(mode="json")
            observations.append(observation)
            factor_scopes[field] = {
                "scope": scope,
                "sample_count": len(peer_values) if available else 0,
                "missing_count": max(0, len(peer_rows) - len(peer_values)) if available else 1,
                "direction": _DIRECT_QUANT_DIRECTIONS[horizon][field],
                "weight": round(1 / len(factors), 6),
            }
        cross_section[horizon] = {
            "scope": horizon_scope or "market",
            "universeCount": horizon_universe,
            "observedCount": horizon_observed,
            "targetRanks": horizon_ranks,
        }
        horizon_status = "uncalibrated" if any(
            item["validation_status"] == "uncalibrated" for item in observations
        ) else "insufficient_data"
        horizons[horizon] = QuantHorizonValidation.model_validate(
            {
                "validation_status": horizon_status,
                "quant_signal": "insufficient_data",
                "factor_observations": observations,
            }
        ).model_dump(mode="json")

    strategy_fingerprint = stable_json_hash(
        {
            "strategy_id": _DIRECT_QUANT_STRATEGY_ID,
            "factor_version": _DIRECT_QUANT_FACTOR_VERSION,
            "methods": method_registry,
        }
    )
    validation_status = "uncalibrated" if total_observations else "insufficient_data"
    has_cross_section = any(
        item.get("observedCount", 0) >= 2 for item in cross_section.values()
    )
    reason = (
        "当前深度投研已按缓存股票池生成三周期因子分位和排名；"
        "该结果尚未经过跨时点样本外校准，保留研究参考，不开放交易晋级。"
        if has_cross_section
        else "当前深度投研已记录可核验因子观测，但缓存股票池不足以形成横截面排名；"
        "尚未经过跨时点样本外校准，保留研究参考，不开放交易晋级。"
        if total_observations
        else "当前深度投研没有形成可核验的量化因子观测，暂不开放交易晋级。"
    )
    validation_metrics = {
        "status": "not_evaluable",
        "sampleScope": "current_cross_section" if has_cross_section else "single_instrument_observation",
        "sampleCount": total_observations,
        "crossSection": cross_section,
        "oosPeriods": 0,
        "calibrationRequired": True,
        "reason": "需要全市场、跨时点的未来收益记录后才可进行样本外校准",
    }
    data_quality = QuantDataQuality.model_validate(
        {
            "status": (
                "available"
                if total_observations and not missing_fields
                else "partial"
                if total_observations
                else "unavailable"
            ),
            "quant_validation_status": validation_status,
            "reason": reason,
            "point_in_time": QuantPointInTimeQuality.model_validate(
                {
                    "status": "verified" if bundle.get("market_as_of") else "unknown",
                    "requested_as_of": bundle.get("market_as_of"),
                    "latest_observed_at": bundle.get("market_as_of"),
                    "missing_observed_at": 0 if bundle.get("market_as_of") else 1,
                }
            ).model_dump(mode="json"),
            "missing_factor_fields": sorted(missing_fields),
            "source_closure_missing": sorted(source_closure_missing),
            "rank_missing_fields": sorted(rank_missing_fields),
        }
    ).model_dump(mode="json")
    snapshot = QuantSnapshot.model_validate(
        {
            "strategy_id": _DIRECT_QUANT_STRATEGY_ID,
            "strategy_fingerprint": strategy_fingerprint,
            "as_of": bundle.get("market_as_of") or bundle.get("as_of"),
            "factor_algorithm_version": _DIRECT_QUANT_FACTOR_VERSION,
            "rank_algorithm_version": _DIRECT_QUANT_RANK_VERSION,
            "validation_status": validation_status,
            "reason": reason,
            "universe": QuantUniverse.model_validate(
                {
                    "universe_count": max(
                        [item.get("universeCount", 0) for item in cross_section.values()] + [1]
                    ),
                    "hard_filter_count": max(
                        [item.get("universeCount", 0) for item in cross_section.values()] + [1]
                    ),
                    "cheap_count": max(
                        [item.get("universeCount", 0) for item in cross_section.values()] + [1]
                    ),
                    "enriched_count": max(
                        [item.get("observedCount", 0) for item in cross_section.values()] + [1]
                    ),
                    "unprocessed_after_cap": 0,
                    "preselection_basis": (
                        "复用同一研究截止日前缓存股票池计算当前横截面分位；"
                        "不代表历史Alpha校准"
                        if has_cross_section
                        else "当前股票自选研究，不代表全市场排序"
                    ),
                }
            ).model_dump(mode="json"),
            "factor_scopes": factor_scopes,
            "candidate_ids_hash": stable_json_hash([instrument_id]),
            "source_ids": sorted(all_source_ids),
            "data_quality": data_quality,
            "source_closure_missing": sorted(source_closure_missing),
            "promotion_status": "research_only",
            "promotion_reason": reason,
            "eligible_for_trading": False,
            "strategy_horizon": None,
            "calibrated_horizon": None,
            "method_registry": method_registry,
            "validation_metrics": validation_metrics,
        }
    ).model_dump(mode="json")
    candidate = QuantCandidateValidation.model_validate(
        {
            "validation_status": validation_status,
            "quant_signal": "insufficient_data",
            "horizons": horizons,
            "source_closure_missing": sorted(source_closure_missing),
            "promotion_status": "research_only",
            "promotion_reason": reason,
            "eligible_for_trading": False,
            "strategy_horizon": None,
            "calibrated_horizon": None,
            "validation_metrics": validation_metrics,
        }
    ).model_dump(mode="json")
    return {
        "quant_snapshot": snapshot,
        "quant_validation": candidate,
    }


def _attach_direct_quant_to_evidence(
    *,
    workspace: Path,
    run_id: str,
    instrument_id: str,
    cache_root: Path | None = None,
    market_rows: list[dict[str, Any]] | None = None,
    cached_factors: dict[str, dict[str, Any]] | None = None,
    cache_status: str | None = None,
) -> None:
    """Persist direct-research quant observations without overwriting selection quant."""
    path = get_stock_project_dir(workspace, run_id) / "evidence.json"
    if not path.is_file():
        return
    data = _read_report(path, "run evidence")
    symbols = data.get("symbols")
    bundle = symbols.get(instrument_id) if isinstance(symbols, dict) else None
    if not isinstance(bundle, dict) or isinstance(bundle.get("quant_validation"), dict):
        return
    payload = _build_direct_quant_payload(
        bundle,
        instrument_id,
        cache_root=cache_root,
    )
    if market_rows is not None or cached_factors is not None:
        payload = build_diagnosis_quant_payload(
            bundle,
            instrument_id,
            cache_root=cache_root or _default_cache_root(),
            market_rows=market_rows or [],
            cached_factors=cached_factors or {},
            cache_status=cache_status,
        )
    if payload is None:
        return
    updated_bundle = dict(bundle)
    updated_bundle["quant_snapshot"] = payload["quant_snapshot"]
    updated_bundle["quant_validation"] = payload["quant_validation"]
    updated = dict(data)
    updated["symbols"] = dict(symbols)
    updated["symbols"][instrument_id] = updated_bundle
    _atomic_json_write(path, updated)


def _verify_selection_quant_sidecar(
    *,
    project_dir: Path,
    selection: dict[str, Any],
    selected_candidate: dict[str, Any],
    instrument_id: str,
) -> tuple[dict[str, Any] | None, str | None]:
    """Verify and normalize one candidate's private quant provenance sidecar."""
    raw_snapshot = _report_value(selection, "quant_snapshot")
    if raw_snapshot is None:
        return None, None
    snapshot, public_snapshot = _quant_snapshot_payload(raw_snapshot)
    if snapshot is None or public_snapshot is None:
        return None, "选股量化快照格式无效，未注入量化验证"
    selected_validation = _quant_candidate_payload(
        _report_value(selected_candidate, "quant_validation")
    )
    if selected_validation is None:
        return None, "选股候选缺少量化验证，未注入量化验证"

    sidecar_path = project_dir / "quant_evidence.json"
    if not sidecar_path.is_file():
        return None, "未找到选股量化来源侧车，未注入量化验证"
    try:
        sidecar = _read_report(sidecar_path, "quant evidence sidecar")
    except ValueError:
        return None, "选股量化来源侧车不可读，未注入量化验证"

    expected_run_id = project_dir.name
    expected_report_id = _report_value(selection, "report_id") or ""
    if sidecar.get("run_id") != expected_run_id:
        return None, "选股量化来源侧车运行编号不匹配，未注入量化验证"
    if sidecar.get("report_id") != expected_report_id:
        return None, "选股量化来源侧车报告编号不匹配，未注入量化验证"
    if sidecar.get("strategy_fingerprint") != snapshot.get("strategy_fingerprint"):
        return None, "选股量化来源侧车策略指纹不匹配，未注入量化验证"
    snapshot_hash = sidecar.get("quant_snapshot_hash")
    accepted_snapshot_hashes = {
        stable_json_hash(public_snapshot),
        # Keep compatibility with the first V6 fixture writer, which hashed
        # the persisted snake-case payload before alias normalization.
        stable_json_hash(snapshot),
        stable_json_hash(raw_snapshot),
    }
    if not isinstance(snapshot_hash, str) or snapshot_hash not in accepted_snapshot_hashes:
        return None, "选股量化快照哈希校验失败，未注入量化验证"

    sidecar_candidates = sidecar.get("candidates")
    if not isinstance(sidecar_candidates, dict):
        return None, "选股量化来源侧车候选结构无效，未注入量化验证"
    candidate = sidecar_candidates.get(instrument_id)
    if not isinstance(candidate, dict):
        return None, "选股量化来源侧车缺少当前候选，未注入量化验证"
    sidecar_validation = _quant_candidate_payload(candidate.get("quant_validation"))
    if sidecar_validation is None or selected_validation is None:
        return None, "选股候选缺少量化验证，未注入量化验证"
    candidate_promotion, promotion_error = _validated_promotion_fields(
        snapshot, selected_validation, sidecar_validation
    )
    if promotion_error is not None or candidate_promotion is None:
        return None, promotion_error or "选股量化晋级字段无效，未注入量化验证"
    promotion_status = candidate_promotion["promotion_status"]
    eligible_for_trading = candidate_promotion["eligible_for_trading"]

    expected_factor_sources: dict[str, list[str]] = {}
    for horizon in selected_validation.get("horizons", {}).values():
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
                return None, "选股量化因子字段无效，未注入量化验证"
            if field in expected_factor_sources and expected_factor_sources[field] != source_ids:
                return None, "选股量化因子来源不一致，未注入量化验证"
            expected_factor_sources[field] = source_ids
    factor_source_ids = candidate.get("factor_source_ids")
    if not isinstance(factor_source_ids, dict):
        return None, "选股量化因子来源映射无效，未注入量化验证"
    normalized_factor_sources = {
        str(field): sorted(
            {
                item
                for item in values
                if isinstance(item, str) and item
            }
        )
        for field, values in factor_source_ids.items()
        if isinstance(field, str) and isinstance(values, list)
    }
    if normalized_factor_sources != expected_factor_sources:
        return None, "选股量化因子来源映射与观测不一致，未注入量化验证"

    raw_sources = sidecar.get("sources")
    if not isinstance(raw_sources, list):
        return None, "选股量化来源记录缺失，未注入量化验证"
    source_records: dict[str, dict[str, Any]] = {}
    for raw_source in raw_sources:
        try:
            source = SourceRecord.model_validate(raw_source)
        except (TypeError, ValueError):
            return None, "选股量化来源记录格式无效，未注入量化验证"
        normalized = source.model_dump(mode="json")
        if source.id in source_records:
            return None, "选股量化来源记录存在重复编号，未注入量化验证"
        source_records[source.id] = normalized
    required_source_ids = {
        source_id
        for source_ids in expected_factor_sources.values()
        for source_id in source_ids
    }
    if not required_source_ids <= set(source_records):
        return None, "选股量化因子来源记录不完整，未注入量化验证"

    safe_snapshot = dict(snapshot)
    safe_snapshot["source_ids"] = sorted(required_source_ids)
    quant_validation = {
        "selection_run_id": sidecar["run_id"],
        "selection_report_id": sidecar["report_id"],
        "strategy_id": safe_snapshot["strategy_id"],
        "as_of": safe_snapshot.get("as_of"),
        "factor_algorithm_version": safe_snapshot["factor_algorithm_version"],
        "rank_algorithm_version": safe_snapshot["rank_algorithm_version"],
        "validation_status": sidecar_validation["validation_status"],
        "quant_signal": sidecar_validation.get("quant_signal", "insufficient_data"),
        "horizons": sidecar_validation["horizons"],
        "source_ids": sorted(required_source_ids),
        "snapshot_hash": snapshot_hash,
        "reason": safe_snapshot["reason"],
        "source_closure_missing": sidecar_validation.get("source_closure_missing", []),
        "promotion_status": promotion_status,
        "promotion_reason": candidate_promotion["promotion_reason"],
        "eligible_for_trading": eligible_for_trading,
        "validation_metrics": dict(candidate_promotion["validation_metrics"]),
        **{
            field: candidate_promotion[field]
            for field in ("strategy_horizon", "calibrated_horizon")
            if candidate_promotion.get(field) is not None
        },
    }
    return {
        "quant_snapshot": safe_snapshot,
        "quant_validation": quant_validation,
        "sources": [
            source_records[source_id] for source_id in sorted(required_source_ids)
        ],
    }, None


def _selection_quant_for_origin(
    run: Any,
    *,
    workspace: Path,
    canonical_origin: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None]:
    """Load the candidate selected by an already-canonical origin."""
    project_dir = get_stock_project_dir(workspace, canonical_origin["selection_run_id"])
    try:
        selection = _read_report(project_dir / "selection.json", "selection report")
        candidates = _report_value(selection, "candidates")
        selected = next(
            (
                item
                for item in candidates or []
                if isinstance(item, dict)
                and _report_value(item, "instrument_id") == canonical_origin["instrument_id"]
            ),
            None,
        )
        if selected is None:
            return None, "选股报告缺少当前候选，未注入量化验证"
        return _verify_selection_quant_sidecar(
            project_dir=project_dir,
            selection=selection,
            selected_candidate=selected,
            instrument_id=canonical_origin["instrument_id"],
        )
    except (TypeError, ValueError, KeyError):
        return None, "选股量化来源侧车校验失败，未注入量化验证"


def _attach_selection_quant_to_evidence(
    *,
    workspace: Path,
    run_id: str,
    instrument_id: str,
    quant_payload: dict[str, Any] | None,
    gap: str | None,
) -> None:
    """Merge verified selection quant data into one already-built run bundle."""
    path = get_stock_project_dir(workspace, run_id) / "evidence.json"
    if not path.is_file():
        # Test seams and legacy callers may mock EvidenceService.  There is no
        # bundle to mutate in that case; the old run-init behavior remains.
        return
    data = _read_report(path, "run evidence")
    symbols = data.get("symbols")
    bundle = symbols.get(instrument_id) if isinstance(symbols, dict) else None
    if not isinstance(bundle, dict):
        raise ValueError("正式证据缺少选股候选对应的标的证据")

    updated_bundle = dict(bundle)
    if quant_payload is not None:
        existing_quant = bundle.get("quant_validation")
        if existing_quant is not None and existing_quant != quant_payload["quant_validation"]:
            raise ValueError("正式证据中的量化验证已存在且不一致，拒绝覆盖")
        existing_snapshot = bundle.get("quant_snapshot")
        if existing_snapshot is not None and existing_snapshot != quant_payload["quant_snapshot"]:
            raise ValueError("正式证据中的量化快照已存在且不一致，拒绝覆盖")
        existing_sources = bundle.get("sources")
        if not isinstance(existing_sources, list):
            existing_sources = []
        source_by_id: dict[str, dict[str, Any]] = {
            source.get("id"): source
            for source in existing_sources
            if isinstance(source, dict) and isinstance(source.get("id"), str)
        }
        for source in quant_payload["sources"]:
            source_id = source["id"]
            previous = source_by_id.get(source_id)
            if previous is not None and previous != source:
                gap = "选股量化来源与正式证据来源冲突，未注入量化验证"
                quant_payload = None
                break
            source_by_id[source_id] = source
        if quant_payload is not None:
            updated_bundle["quant_snapshot"] = quant_payload["quant_snapshot"]
            updated_bundle["quant_validation"] = quant_payload["quant_validation"]
            updated_bundle["sources"] = [
                source_by_id[source_id] for source_id in sorted(source_by_id)
            ]
    if quant_payload is None and gap:
        quality = dict(bundle.get("data_quality") or {})
        quality["quant_validation_gap"] = gap
        updated_bundle["data_quality"] = quality
    if updated_bundle == bundle:
        return
    updated = dict(data)
    updated["symbols"] = dict(symbols)
    updated["symbols"][instrument_id] = updated_bundle
    _atomic_json_write(path, updated)


def _claim_texts(value: Any, *, limit: int, max_length: int) -> list[str]:
    """Extract bounded text from persisted opportunity claims only."""
    if not isinstance(value, list):
        return []
    if len(value) > limit:
        raise ValueError("selection_origin text array exceeds the allowed limit")
    texts: list[str] = []
    for item in value:
        if isinstance(item, dict):
            text = item.get("text") or item.get("claim")
        elif isinstance(item, str):
            # Keep legacy opportunity payloads readable, but never accept
            # arbitrary browser text here: the value must come from the file.
            text = item
        else:
            raise ValueError("selection_origin text array contains an invalid item")
        if not isinstance(text, str):
            raise ValueError("selection_origin text array contains a non-string text")
        text = text.strip()
        if not text or len(text) > max_length:
            raise ValueError("selection_origin text exceeds the allowed length")
        if text in texts:
            continue
        texts.append(text)
    if len(texts) > limit:
        raise ValueError("selection_origin text array exceeds the allowed limit")
    return texts


def _canonical_selection_origin(
    run: Any, *, workspace: Path, raw_origin: Any
) -> dict[str, Any]:
    """Derive the only safe selection handoff from durable stock reports."""
    if not isinstance(raw_origin, dict):
        raise ValueError("run inputs 'selection_origin' must be an object")
    inputs = run.inputs if isinstance(getattr(run, "inputs", None), dict) else {}
    raw_symbols = inputs.get("symbols")
    if not isinstance(raw_symbols, list) or len(raw_symbols) != 1:
        raise ValueError("selection_origin requires exactly one symbol")
    instrument_id = _parse_symbol(raw_symbols[0])

    selection_run_id = raw_origin.get("selection_run_id")
    if (
        not isinstance(selection_run_id, str)
        or not _SELECTION_RUN_ID_RE.fullmatch(selection_run_id)
    ):
        raise ValueError("selection_origin selection_run_id is invalid")
    project_dir = get_stock_project_dir(workspace, selection_run_id)
    selection = _read_report(project_dir / "selection.json", "selection report")
    selection_workflow_run_id = _report_value(selection, "workflow_run_id")
    if selection_workflow_run_id is not None and selection_workflow_run_id != selection_run_id:
        raise ValueError("selection report does not belong to selection_run_id")
    selection_report_id = _report_value(selection, "report_id")
    if (
        not isinstance(selection_report_id, str)
        or not selection_report_id
        or len(selection_report_id) > 128
    ):
        raise ValueError("selection report is missing report_id")

    candidates = _report_value(selection, "candidates")
    if not isinstance(candidates, list):
        raise ValueError("selection report has no candidates")
    matches = [
        item
        for item in candidates
        if isinstance(item, dict)
        and (_report_value(item, "instrument_id") == instrument_id)
    ]
    if len(matches) != 1:
        raise ValueError("selection_origin instrument is not a unique selection candidate")
    selected = matches[0]
    strategy = _report_value(selection, "strategy")
    if not isinstance(strategy, dict):
        raise ValueError("selection report is missing strategy")
    strategy_id = _report_value(strategy, "strategy_id")
    strategy_name = _report_value(strategy, "name")
    strategy_horizon = _report_value(strategy, "horizon")
    if not all(
        isinstance(value, str) and value
        for value in (strategy_id, strategy_name, strategy_horizon)
    ) or len(strategy_id) > 64 or len(strategy_name) > 80:
        raise ValueError("selection report strategy is incomplete")
    deterministic_rank = _report_value(selected, "rank")
    if (
        not isinstance(deterministic_rank, int)
        or isinstance(deterministic_rank, bool)
        or deterministic_rank < 1
        or deterministic_rank > 100
    ):
        raise ValueError("selection candidate deterministic rank is invalid")
    selection_reasons = _claim_texts(
        _report_value(selected, "selection_reasons"),
        limit=_SELECTION_REASON_LIMIT,
        max_length=_SELECTION_REASON_MAX_LENGTH,
    )
    opportunity_report_id: str | None = None
    why_now: str | None = None
    research_priority: str | None = None
    focus_questions: list[str] = []
    source_count = 0
    opportunity_path = project_dir / "opportunity.json"
    if opportunity_path.is_file():
        opportunity = _read_report(opportunity_path, "opportunity report")
        opportunity_workflow_run_id = _report_value(opportunity, "workflow_run_id")
        if opportunity_workflow_run_id is not None and opportunity_workflow_run_id != selection_run_id:
            raise ValueError("opportunity report does not belong to selection_run_id")
        opportunity_candidates = _report_value(opportunity, "candidates")
        if not isinstance(opportunity_candidates, list):
            raise ValueError("opportunity report has no candidates")
        opportunity_matches = [
            item
            for item in opportunity_candidates
            if isinstance(item, dict)
            and _report_value(item, "instrument_id") == instrument_id
        ]
        if len(opportunity_matches) > 1:
            raise ValueError("opportunity report has duplicate instrument candidates")
        if opportunity_matches:
            opportunity_report_id_value = _report_value(opportunity, "report_id")
            if (
                not isinstance(opportunity_report_id_value, str)
                or not opportunity_report_id_value
                or len(opportunity_report_id_value) > 128
            ):
                raise ValueError("opportunity report is missing report_id")
            opportunity_report_id = opportunity_report_id_value
            opportunity_candidate = opportunity_matches[0]
            why_now_claim = _report_value(opportunity_candidate, "why_now")
            if isinstance(why_now_claim, dict):
                text = why_now_claim.get("text") or why_now_claim.get("claim")
                if isinstance(text, str) and text.strip():
                    why_now = text.strip()
                    if len(why_now) > 2000:
                        raise ValueError("opportunity why_now exceeds the allowed length")
            priority = _report_value(opportunity_candidate, "research_priority")
            if priority is not None:
                if priority not in {"high", "medium", "low"}:
                    raise ValueError("opportunity research_priority is invalid")
                research_priority = priority
            watch_items = _report_value(opportunity_candidate, "watch_items")
            data_gaps = _report_value(opportunity_candidate, "data_gaps")
            focus_questions = _claim_texts(
                [
                    *(watch_items if isinstance(watch_items, list) else []),
                    *(data_gaps if isinstance(data_gaps, list) else []),
                ],
                limit=_FOCUS_QUESTION_LIMIT,
                max_length=_FOCUS_QUESTION_MAX_LENGTH,
            )
            source_ids = _report_value(opportunity_candidate, "source_ids")
            if (
                not isinstance(source_ids, list)
                or len(source_ids) > 64
                or any(
                    not isinstance(item, str) or not item.strip()
                    for item in source_ids
                )
            ):
                raise ValueError("opportunity candidate source_ids is invalid")
            source_count = len({item.strip() for item in source_ids})

    selection_as_of = _report_value(selection, "as_of")
    if selection_as_of is not None and (
        not isinstance(selection_as_of, str) or len(selection_as_of) > 128
    ):
        raise ValueError("selection report as_of is invalid")

    canonical = {
        "schema_version": 1,
        "selection_run_id": selection_run_id,
        "selection_report_id": selection_report_id,
        "opportunity_report_id": opportunity_report_id,
        "instrument_id": instrument_id,
        "strategy_id": strategy_id,
        "strategy_name": strategy_name,
        "strategy_horizon": strategy_horizon,
        "deterministic_rank": deterministic_rank,
        "selection_reasons": selection_reasons,
        "why_now": why_now,
        "research_priority": research_priority,
        "focus_questions": focus_questions,
        "source_count": source_count,
        "selection_as_of": selection_as_of,
        "usage_note": _SELECTION_ORIGIN_USAGE_NOTE,
    }
    if raw_origin != canonical:
        raise ValueError("selection_origin does not match persisted selection and opportunity reports")
    return canonical


async def build_run_evidence(
    run: WorkflowRun,
    *,
    workspace: Path,
    provider: Any | None = None,
    watchlist_root: Path | None = None,
    cache_root: Path | None = None,
) -> list[str]:
    """Build the EvidenceBundle for every symbol in ``run.inputs["symbols"]``.

    Returns the normalized instrument ids actually prepared. A run without
    ``inputs.symbols`` (non-stock ad-hoc usage of the room) is a no-op.
    Idempotent per symbol — the evidence service reloads existing bundles.
    """
    inputs = run.inputs if isinstance(getattr(run, "inputs", None), dict) else {}
    selection_origin = inputs.get("selection_origin")
    canonical_selection_origin: dict[str, Any] | None = None
    selection_quant_payload: dict[str, Any] | None = None
    selection_quant_gap: str | None = None
    if selection_origin is not None:
        canonical_selection_origin = _canonical_selection_origin(
            run,
            workspace=Path(workspace),
            raw_origin=selection_origin,
        )
        selection_quant_payload, selection_quant_gap = _selection_quant_for_origin(
            run,
            workspace=Path(workspace),
            canonical_origin=canonical_selection_origin,
        )
    raw = inputs.get("symbols")
    material_binding_ids = inputs.get("material_binding_ids")
    if material_binding_ids is not None:
        if not isinstance(raw, list) or len(raw) != 1:
            raise ValueError("选择财报材料时只能对应一只股票")
        instrument_for_materials = _parse_symbol(raw[0])
        if (
            not isinstance(material_binding_ids, list)
            or not material_binding_ids
            or len(material_binding_ids) > 8
            or any(not isinstance(item, str) for item in material_binding_ids)
        ):
            raise ValueError("财报材料选择必须是 1 至 8 个绑定记录编号")
        if len(set(material_binding_ids)) != len(material_binding_ids):
            raise ValueError("财报材料绑定记录编号不能重复")
        try:
            MaterialBindingStore(Path(workspace)).confirmed_projections(
                material_binding_ids,
                instrument_id=instrument_for_materials,
            )
        except MaterialBindingError as exc:
            raise ValueError(f"材料绑定不可用于本次投研：{exc.message}") from exc
    if not raw:
        return []
    if not isinstance(raw, list):
        raise ValueError("run inputs 'symbols' must be a list")

    context_id = (run.inputs or {}).get("evidence_context_id")
    if context_id is not None:
        if not isinstance(context_id, str) or not context_id.strip():
            raise ValueError("run inputs 'evidence_context_id' must be a non-empty string")
        if len(raw) != 1:
            raise ValueError("evidence_context_id requires exactly one symbol")
        instrument_id = _parse_symbol(raw[0])
        # Promotion is a local immutable copy.  In particular, do not create
        # the default provider here: a confirmed preflight must not refetch.
        service = EvidenceService(
            workspace=Path(workspace),
            provider=None,
            cache_root=cache_root or _default_cache_root(),
        )
        if material_binding_ids:
            promoted_bundle = await service.promote_context(
                context_id.strip(),
                run.id,
                instrument_id,
                material_binding_ids=material_binding_ids,
            )
        else:
            promoted_bundle = await service.promote_context(
                context_id.strip(), run.id, instrument_id
            )
        readiness = promoted_bundle.get("decision_readiness") if isinstance(promoted_bundle, dict) else None
        if not _research_ready(readiness) or not _core_research_ready(promoted_bundle):
            raise ValueError("决策数据预检失败，未启动投研")
        if canonical_selection_origin is not None:
            _attach_selection_quant_to_evidence(
                workspace=Path(workspace),
                run_id=run.id,
                instrument_id=instrument_id,
                quant_payload=selection_quant_payload,
                gap=selection_quant_gap,
            )
        diagnosis_cache = await ensure_diagnosis_cross_section_cache(
            provider=None,
            cache_root=cache_root or _default_cache_root(),
            workspace=workspace,
            as_of=(
                promoted_bundle.get("market_as_of")
                if isinstance(promoted_bundle, dict)
                else None
            ),
        )
        _attach_direct_quant_to_evidence(
            workspace=Path(workspace),
            run_id=run.id,
            instrument_id=instrument_id,
            cache_root=cache_root or _default_cache_root(),
            market_rows=diagnosis_cache.get("rows"),
            cached_factors=diagnosis_cache.get("factors"),
            cache_status=diagnosis_cache.get("status"),
        )
        logger.info(
            "Stock run {} reused preflight evidence context {} for {}",
            run.id,
            context_id.strip(),
            instrument_id,
        )
        return [instrument_id]

    using_default_provider = provider is None
    provider = provider if provider is not None else _default_provider()
    watchlist = WatchlistStore(watchlist_root or _default_watchlist_root())
    types = {item.id: item.instrument_type for item in watchlist.list()}

    instruments: list[InstrumentRef] = []
    seen: set[str] = set()
    for entry in raw:
        instrument_id = _parse_symbol(entry)
        if instrument_id in seen:
            continue
        seen.add(instrument_id)
        exchange, _, symbol = instrument_id.partition(":")
        instruments.append(
            InstrumentRef(
                exchange=exchange,
                symbol=symbol,
                instrument_type=types.get(instrument_id, "equity"),
            )
        )

    service = EvidenceService(
        workspace=Path(workspace),
        provider=provider,
        research_provider=GovernmentResearchProvider() if using_default_provider else None,
        cache_root=cache_root or _default_cache_root(),
    )
    if material_binding_ids:
        prepared = await service.build_batch(
            run.id,
            instruments,
            material_binding_ids=material_binding_ids,
        )
    else:
        prepared = await service.build_batch(run.id, instruments)
    if isinstance(prepared, dict):
        failed = [
            instrument_id
            for instrument_id, bundle in prepared.items()
            if not isinstance(bundle, dict)
            or not _research_ready(bundle.get("decision_readiness"))
            or not _core_research_ready(bundle)
        ]
        if failed:
            raise ValueError(
                "决策数据预检失败，未启动投研：" + ", ".join(sorted(failed))
            )
    if canonical_selection_origin is not None:
        _attach_selection_quant_to_evidence(
            workspace=Path(workspace),
            run_id=run.id,
            instrument_id=canonical_selection_origin["instrument_id"],
            quant_payload=selection_quant_payload,
            gap=selection_quant_gap,
        )
    first_bundle = next(
        (
            bundle
            for bundle in (prepared.values() if isinstance(prepared, dict) else [])
            if isinstance(bundle, dict)
        ),
        None,
    )
    diagnosis_cache = (
        await ensure_diagnosis_cross_section_cache(
            provider=provider,
            cache_root=cache_root or _default_cache_root(),
            workspace=workspace,
            as_of=(first_bundle or {}).get("market_as_of"),
        )
        if first_bundle is not None
        else {"rows": [], "factors": {}, "status": "unavailable"}
    )
    for instrument_id in sorted(seen):
        _attach_direct_quant_to_evidence(
            workspace=Path(workspace),
            run_id=run.id,
            instrument_id=instrument_id,
            cache_root=cache_root or _default_cache_root(),
            market_rows=diagnosis_cache.get("rows"),
            cached_factors=diagnosis_cache.get("factors"),
            cache_status=diagnosis_cache.get("status"),
        )
    logger.info(
        "Stock run {} evidence ready: {} instruments ({})",
        run.id,
        len(instruments),
        ", ".join(sorted(seen)),
    )
    return sorted(seen)
