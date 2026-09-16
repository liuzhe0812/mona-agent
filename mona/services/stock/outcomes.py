"""Deterministic, append-only outcome tracking for Stock Report V4.

This module deliberately has no provider or scheduling dependency.  Callers
pass the daily bars they already obtained through the stock provider, so the
same functions are usable by a future explicit "update results" action.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections import defaultdict
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping

from mona.services.stock.provenance import CN_TZ, parse_asia_datetime

PUBLIC_MARKET_BENCHMARK = {
    "name": "中证全指",
    "instrument_id": "XSHG:000985",
    "instrument_type": "index",
}

WINDOW_SPECS: dict[str, tuple[int, ...]] = {
    "short_term": (5, 10),
    "medium_term": (20, 60),
    "long_term": (120, 250),
}

# Selection ranks are not directional predictions.  These windows therefore
# report forward and benchmark-relative returns, never a win rate.
SELECTION_WINDOWS: tuple[int, ...] = (5, 20, 60)
SELECTION_OUTCOME_METHOD = "报告日后首个交易日开盘至第N个交易日收盘"
SELECTION_OUTCOME_VERSION = "selection-forward-v1"
SELECTION_TRACKING_FILE = "selection_outcome_tracking.json"
SELECTION_OBSERVATIONS_FILE = "selection_outcome_observations.jsonl"
MAX_SELECTION_OUTCOME_CANDIDATES = 100

_SELECTION_STATUS_LABELS = {
    "complete": "数据完整",
    "incomplete": "数据不完整",
    "pending": "窗口尚未成熟",
}
_SELECTION_DATA_STATUS_LABELS = {
    "available": "可计算",
    "window_not_mature": "尚未达到观察窗口",
    "missing_target_bar": "标的缺少对应交易日行情",
    "missing_target_price": "标的缺少开盘价或收盘价",
    "missing_target_volume": "标的成交量缺失或无成交",
    "missing_benchmark_bar": "基准缺少对应交易日行情",
    "missing_benchmark_price": "基准缺少开盘价或收盘价",
    "missing_benchmark_volume": "基准成交量缺失或无成交",
    "missing_report_date": "选股报告缺少报告日期",
}

OUTCOME_CALCULATION_METHOD = "first_post_report_open_to_nth_trading_close"
OUTCOME_CALCULATION_VERSION = "v1"

_HORIZONS = tuple(WINDOW_SPECS)
_CONDITION_GROUPS = (
    "participation_conditions",
    "confirmation_conditions",
    "watch_conditions",
    "invalidation_conditions",
    "stop_loss_conditions",
    "take_profit_conditions",
)
_PRICE_FIELDS = frozenset({"open", "close", "high", "low", "price", "volume"})
_OPERATORS = frozenset({"gt", "gte", "lt", "lte", "crosses_above", "crosses_below"})

DECISION_EVALUATION_VERSION = "decision-conditions-v1"
DECISION_EVALUATION_MAX_AGE_SECONDS = 24 * 60 * 60
_DECISION_CONDITION_GROUPS = (
    ("participation_conditions", "参与条件"),
    ("confirmation_conditions", "确认条件"),
    ("invalidation_conditions", "退出条件"),
    ("stop_loss_conditions", "止损条件"),
    ("take_profit_conditions", "止盈条件"),
)
_DECISION_STATUS_LABELS = {
    "matched": "已满足",
    "not_matched": "未满足",
    "not_evaluable": "暂无法判断",
}

# V5 price/position plans are deterministic products of frozen Evidence.
# Keep these versions explicit so a later calibration can replace the method
# without changing the meaning of an existing report.
V5_DERIVED_DECISION_METHOD = "risk-controlled-reference-plan"
V5_DERIVED_DECISION_VERSION = "risk-controlled-reference-plan-v1"
V5_INDICATOR_METHOD_VERSION = "evidence-derived-indicators-v1"
V5_CONDITION_METHOD_VERSION = "price-threshold-condition-v1"
V5_POSITION_METHOD_VERSION = "fixed-fractional-risk-product-single-stock-cap-v1"
V5_PRODUCT_SINGLE_STOCK_CAP_PCT = 30.0

_V5_HORIZON_PLAN_SPECS: dict[str, dict[str, float | int]] = {
    # The short horizon's 10 trading days are represented by 14 calendar days;
    # the disclosure is returned in review_trigger and method_versions.
    "short_term": {
        "entry_atr": 0.25,
        "pullback_atr": 0.75,
        "stop_atr": 1.0,
        "valid_calendar_days": 14,
        "position_cap_pct": 20.0,
    },
    "medium_term": {
        "entry_atr": 0.50,
        "pullback_atr": 1.25,
        "stop_atr": 1.50,
        "valid_calendar_days": 90,
        "position_cap_pct": 30.0,
    },
    "long_term": {
        "entry_atr": 0.75,
        "pullback_atr": 1.75,
        "stop_atr": 2.00,
        "valid_calendar_days": 365,
        "position_cap_pct": 40.0,
    },
}


def _plain(value: Any) -> Any:
    """Copy mappings/Pydantic values into JSON-compatible Python values."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return deepcopy(value)


def _date_value(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    parsed = parse_asia_datetime(value)
    return parsed.date() if parsed is not None else None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _bar(value: Any) -> dict[str, Any] | None:
    row = _plain(value)
    if not isinstance(row, Mapping):
        return None
    result: dict[str, Any] = {"date": row.get("date") or row.get("trading_date")}
    result["_date"] = _date_value(result["date"])
    for field in ("open", "close", "high", "low", "volume"):
        result[field] = _number(row.get(field))
    if result["_date"] is None:
        return None
    result["date"] = result["_date"].isoformat()
    return result


def _sorted_bars(values: Iterable[Any]) -> list[dict[str, Any]]:
    bars = [row for value in values if (row := _bar(value)) is not None]
    bars.sort(key=lambda row: row["_date"])
    return bars


def _tracking_id(report: Mapping[str, Any]) -> str:
    value = report.get("outcome_tracking_id")
    if isinstance(value, str) and value:
        return value
    instrument = report.get("instrument") or {}
    instrument_id = f"{instrument.get('exchange', '')}:{instrument.get('symbol', '')}"
    run_id = str(report.get("workflow_run_id") or "")
    digest = hashlib.sha256(f"{run_id}:{instrument_id}".encode()).hexdigest()
    return f"stock_outcome_{digest[:24]}"


def _condition_items(view: Mapping[str, Any]) -> list[dict[str, Any]]:
    conditions: list[dict[str, Any]] = []
    for group in _CONDITION_GROUPS:
        for condition in view.get(group) or []:
            if isinstance(condition, Mapping):
                conditions.append({"group": group, **_plain(condition)})
    return conditions


def build_outcome_tracking_snapshot(report: Mapping[str, Any] | Any) -> dict[str, Any] | None:
    """Build the immutable tracking snapshot for one deep-research V4 report.

    V3 reports and daily-review digests intentionally return ``None``.  The
    snapshot excludes narrative text, so a harmless report markdown revision
    does not conflict with the original prediction record.
    """
    doc = _plain(report)
    if not isinstance(doc, Mapping):
        return None
    if doc.get("kind") != "deep_research" or doc.get("schema_version") != 4:
        return None
    horizons: dict[str, dict[str, Any]] = {}
    views = doc.get("horizon_views") or {}
    for horizon in _HORIZONS:
        view = views.get(horizon) if isinstance(views, Mapping) else None
        view = view if isinstance(view, Mapping) else {}
        horizons[horizon] = {
            "stance": view.get("stance"),
            "status": view.get("status"),
            "conditions": _condition_items(view),
            "benchmark": _plain(view.get("benchmark") or {}),
        }
    source_ids = list(dict.fromkeys(str(item) for item in (doc.get("source_ids") or []) if item))
    versions = _plain(doc.get("versions") or {})
    source_hashes = {
        source["id"]: source["content_hash"]
        for source in (doc.get("sources") or [])
        if isinstance(source, Mapping)
        and isinstance(source.get("id"), str)
        and isinstance(source.get("content_hash"), str)
    }
    evidence = {
        "version": versions.get("evidence") if isinstance(versions, Mapping) else None,
        "versions": versions,
        "coverage": _plain(doc.get("evidence_coverage") or {}),
        "source_ids": source_ids,
        "source_hashes": source_hashes,
    }
    report_info = {
        "id": doc.get("report_id"),
        "schema_version": doc.get("schema_version"),
    }
    run_info = {"id": doc.get("workflow_run_id")}
    tracking_info = {"id": _tracking_id(doc)}
    instrument = _plain(doc.get("instrument") or {})
    return {
        "schema_version": 1,
        "tracking": tracking_info,
        "tracking_id": tracking_info["id"],
        "report": report_info,
        "report_id": report_info["id"],
        "run": run_info,
        "workflow_run_id": run_info["id"],
        "instrument": instrument,
        "research_cutoff_at": doc.get("research_cutoff_at"),
        "market_as_of": doc.get("market_as_of"),
        "report_as_of": doc.get("as_of"),
        "horizons": horizons,
        "public_market_benchmark": dict(PUBLIC_MARKET_BENCHMARK),
        "evidence": evidence,
        "versions": versions,
        "source_ids": source_ids,
    }


def ensure_outcome_tracking_snapshot(
    run_dir: str | Path, report: Mapping[str, Any] | Any
) -> dict[str, Any] | None:
    """Create an immutable snapshot, or verify and return the existing one."""
    snapshot = build_outcome_tracking_snapshot(report)
    if snapshot is None:
        return None
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "outcome_tracking.json"
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"immutable outcome tracking is unreadable: {exc}") from exc
        if existing != snapshot:
            raise ValueError("immutable outcome tracking cannot be overwritten")
        return existing
    content = json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return snapshot


def _report_date(snapshot: Mapping[str, Any]) -> date | None:
    return _date_value(
        snapshot.get("report_as_of")
        or snapshot.get("research_cutoff_at")
        or snapshot.get("market_as_of")
    )


def _declared_benchmark_id(benchmark: Mapping[str, Any]) -> str | None:
    """Use only an explicit, verifiable code; never infer one from its name."""
    value = benchmark.get("instrument_id") or benchmark.get("id")
    if isinstance(value, str) and ":" in value:
        exchange, symbol = value.split(":", 1)
        if exchange in {"XSHG", "XSHE", "BJSE"} and symbol.isdigit():
            return f"{exchange}:{symbol}"
    symbol = benchmark.get("symbol") or benchmark.get("code")
    exchange = benchmark.get("exchange")
    if isinstance(symbol, str) and isinstance(exchange, str) and symbol.isdigit():
        if exchange in {"XSHG", "XSHE", "BJSE"}:
            return f"{exchange}:{symbol}"
    return None


def _relative_return(
    entry_date: str,
    exit_date: str,
    market_bars: list[dict[str, Any]],
    required_dates: Iterable[str] | None = None,
) -> tuple[float | None, str]:
    lookup = {row["date"]: row for row in market_bars}
    if required_dates is not None and any(day not in lookup for day in required_dates):
        return None, "missing_date"
    first, last = lookup.get(entry_date), lookup.get(exit_date)
    if first is None or last is None:
        return None, "missing_date"
    if any(row.get("volume") is None for row in (first, last)):
        return None, "missing_volume"
    if any(row["volume"] <= 0 for row in (first, last)):
        return None, "zero_volume"
    if first["open"] is None or last["close"] is None or first["open"] == 0:
        return None, "missing_price"
    return round((last["close"] / first["open"] - 1.0) * 100.0, 10), "available"


def _window_status(window: list[dict[str, Any]], size: int) -> tuple[str, str | None]:
    if len(window) < size:
        return "incomplete", "missing_date"
    for row in window:
        if row["volume"] is None:
            return "incomplete", "missing_volume"
        if row["volume"] <= 0:
            return "incomplete", "zero_volume"
        if any(row[field] is None for field in ("open", "close", "high", "low")):
            return "incomplete", "missing_price"
    return "complete", None


def _mfe_mae(window: list[dict[str, Any]], entry: float) -> tuple[float, float]:
    highs = [(row["high"] / entry - 1.0) * 100.0 for row in window]
    lows = [(row["low"] / entry - 1.0) * 100.0 for row in window]
    return round(max(highs), 10), round(min(lows), 10)


def calculate_outcome_observations(
    snapshot: Mapping[str, Any],
    target_bars: Iterable[Any],
    market_bars: Iterable[Any] | None = None,
    *,
    source_hash: str | None = None,
    benchmark_source_hash: str | None = None,
) -> list[dict[str, Any]]:
    """Calculate all six fixed windows from daily bars without filling gaps."""
    target = _sorted_bars(target_bars)
    market = _sorted_bars(market_bars or [])
    report_date = _report_date(snapshot)
    eligible = [row for row in target if report_date is not None and row["_date"] > report_date]
    source_hash = source_hash or _bars_hash(target)
    benchmark_source_hash = benchmark_source_hash or _bars_hash(market)
    observations: list[dict[str, Any]] = []
    horizons = snapshot.get("horizons") or {}
    target_by_date = {row["date"]: row for row in eligible}
    market_eligible = [
        row for row in market if report_date is not None and row["_date"] > report_date
    ]
    for horizon, windows in WINDOW_SPECS.items():
        view = horizons.get(horizon) if isinstance(horizons, Mapping) else {}
        view = view if isinstance(view, Mapping) else {}
        benchmark = view.get("benchmark") if isinstance(view.get("benchmark"), Mapping) else {}
        declared_id = _declared_benchmark_id(benchmark)
        for size in windows:
            # The public market calendar anchors the window.  Target bars are
            # looked up by those exact dates, so a missing target bar cannot
            # slide the exit date forward to a later bar.
            market_window = market_eligible[:size]
            market_dates = [item["date"] for item in market_window]
            target_window = [target_by_date[day] for day in market_dates if day in target_by_date]
            target_dates = [item["date"] for item in eligible[:size]]
            target_missing_date = len(target_window) != size
            market_missing_date = len(market_window) != size
            market_status, market_data_status = _window_status(market_window, size)
            if market_missing_date:
                status, data_status = "incomplete", "market_missing_date"
            elif market_status != "complete":
                status, data_status = "incomplete", f"market_{market_data_status}"
            elif target_missing_date:
                status, data_status = "incomplete", "missing_date"
            elif target_dates != market_dates:
                # Target covers the selected market dates, but the target's
                # first N dates expose a missing market date in the source.
                status, data_status = "incomplete", "market_missing_date"
            else:
                status, data_status = _window_status(target_window, size)
            entry_bar = target_by_date.get(market_dates[0]) if market_dates else None
            exit_bar = target_by_date.get(market_dates[-1]) if len(market_window) >= size else None
            row: dict[str, Any] = {
                "tracking_id": snapshot.get("tracking_id") or (snapshot.get("tracking") or {}).get("id"),
                "report_id": snapshot.get("report_id") or (snapshot.get("report") or {}).get("id"),
                "horizon": horizon,
                "window": size,
                "stance": view.get("stance"),
                "source_hash": source_hash,
                "benchmark_source_hash": benchmark_source_hash,
                "status": status,
                "data_status": data_status or "available",
                "entry_date": market_dates[0] if market_dates else None,
                "exit_date": market_dates[-1] if len(market_window) >= size else None,
                "entry_price": entry_bar["open"] if entry_bar else None,
                "exit_price": exit_bar["close"] if exit_bar else None,
                "absolute_return_pct": None,
                "mfe_pct": None,
                "mae_pct": None,
                "relative_market_return_pct": None,
                "relative_market_status": "missing_benchmark" if not market else "missing_date",
                "declared_benchmark_id": declared_id,
                "declared_benchmark_return_pct": None,
                "declared_benchmark_status": (
                    "unsupported_no_verifiable_code" if declared_id is None else "missing_data"
                ),
                "calculation_method": OUTCOME_CALCULATION_METHOD,
                "calculation_version": OUTCOME_CALCULATION_VERSION,
                "conditions": [],
            }
            if status == "complete":
                entry, exit_price = target_window[0]["open"], target_window[-1]["close"]
                if entry is None or entry == 0:
                    row["status"], row["data_status"] = "incomplete", "missing_price"
                else:
                    target_return = round((exit_price / entry - 1.0) * 100.0, 10)
                    row["absolute_return_pct"] = target_return
                    row["mfe_pct"], row["mae_pct"] = _mfe_mae(target_window, entry)
                    market_return, market_status = _relative_return(
                        target_window[0]["date"],
                        target_window[-1]["date"],
                        market,
                        required_dates=market_dates,
                    )
                    row["relative_market_return_pct"] = (
                        target_return - market_return
                        if market_return is not None
                        else None
                    )
                    row["relative_market_status"] = market_status
                    if market_status != "available":
                        row["status"] = "incomplete"
                        row["data_status"] = f"market_{market_status}"
                    if declared_id is not None:
                        # The caller must pass matching declared benchmark bars
                        # explicitly in a future provider integration.  Do not
                        # reuse public-market bars for an unnamed benchmark.
                        row["declared_benchmark_status"] = "missing_data"
            row["conditions"] = replay_report_conditions(
                snapshot, target_window, horizons=(horizon,)
            )
            observations.append(row)
    return observations


def _bars_hash(bars: Iterable[Any]) -> str:
    normalized = []
    for row in _sorted_bars(bars):
        normalized.append({field: row.get(field) for field in ("date", "open", "close", "high", "low", "volume")})
    body = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(body.encode()).hexdigest()}"


def _metric_field(ref: Any) -> str | None:
    if not isinstance(ref, str):
        return None
    field = ref.rsplit(".", 1)[-1].lower()
    if field not in _PRICE_FIELDS:
        return None
    return "close" if field == "price" else field


def _decision_field(value: Mapping[str, Any], name: str, default: Any = None) -> Any:
    if name in value:
        return value[name]
    parts = name.split("_")
    alias = parts[0] + "".join(part.capitalize() for part in parts[1:])
    return value.get(alias, default)


def _decision_source_ids(value: Mapping[str, Any]) -> list[str]:
    raw = _decision_field(value, "source_ids", [])
    if not raw:
        raw = _decision_field(value, "source_id", [])
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    return list(dict.fromkeys(item.strip() for item in raw if isinstance(item, str) and item.strip()))


def _decision_timestamp(value: Any) -> datetime | None:
    return parse_asia_datetime(value)


def _decision_metric(
    metrics: Mapping[str, Any],
    reference: Any,
    *,
    role: str = "any",
) -> dict[str, Any] | None:
    if not isinstance(reference, str) or not reference.strip():
        return None
    raw = metrics.get(reference)
    if not isinstance(raw, Mapping):
        return None
    current_only = bool(raw.get("current_only"))
    if role in {"threshold", "reference"} and current_only:
        return None
    value_key = "observed_value" if role == "observed" and "observed_value" in raw else "value"
    value = _number(raw.get(value_key))
    source_ids = _decision_source_ids(raw)
    if role == "observed" and "observed_source_ids" in raw:
        source_ids = list(raw.get("observed_source_ids") or [])
    source = raw.get("source") if isinstance(raw.get("source"), Mapping) else {}
    if not source_ids and isinstance(source, Mapping):
        source_id = source.get("id")
        if isinstance(source_id, str) and source_id.strip():
            source_ids = [source_id.strip()]
    as_of = (
        _decision_field(raw, "as_of")
        or _decision_field(raw, "observed_at")
        or _decision_field(raw, "valid_at")
        or _decision_field(raw, "effective_at")
        or _decision_field(raw, "timestamp")
    )
    if as_of is None and isinstance(source, Mapping):
        as_of = source.get("published_at") or source.get("fetched_at")
    if role == "observed" and "observed_as_of" in raw:
        as_of = raw.get("observed_as_of")
    parsed_as_of = _decision_timestamp(as_of)
    if value is None or not source_ids or parsed_as_of is None:
        return None
    return {
        "value": value,
        "source_ids": source_ids,
        "as_of": parsed_as_of,
        "previous_value": _number(
            raw.get("observed_previous_value", _decision_field(raw, "previous_value"))
            if role == "observed"
            else _decision_field(raw, "previous_value")
        ),
    }


def _decision_report_cutoff(report: Mapping[str, Any]) -> datetime | None:
    for field in ("research_cutoff_at", "market_as_of", "as_of"):
        parsed = _decision_timestamp(_decision_field(report, field))
        if parsed is not None:
            return parsed
    return None


def _decision_gate_reason(
    condition: Mapping[str, Any],
    observed: dict[str, Any] | None,
    threshold: dict[str, Any] | None,
    report_cutoff: datetime | None,
    evaluated_at: datetime,
    *,
    max_age_seconds: int,
) -> str | None:
    if not _decision_source_ids(condition):
        return "缺少可核验来源"
    if observed is None:
        return "缺少当前指标数据或来源时点"
    if threshold is None:
        return "缺少阈值指标数据或来源时点"
    if threshold["as_of"] > observed["as_of"]:
        return "阈值有效时点晚于当前观察值"
    if observed["as_of"] > evaluated_at or threshold["as_of"] > evaluated_at:
        return "指标有效时点晚于当前评估时点"
    if report_cutoff is not None and threshold["as_of"] > report_cutoff:
        return "阈值有效时点晚于报告截止时间"
    condition_as_of = (
        _decision_field(condition, "as_of")
        or _decision_field(condition, "observed_at")
        or _decision_field(condition, "valid_at")
        or _decision_field(condition, "effective_at")
    )
    if condition_as_of is not None:
        parsed_condition_as_of = _decision_timestamp(condition_as_of)
        if parsed_condition_as_of is None:
            return "条件有效时点无法解析"
        if parsed_condition_as_of != threshold["as_of"]:
            return "条件与指标有效时点不一致"
    valid_until = _decision_timestamp(
        _decision_field(condition, "valid_until") or _decision_field(condition, "expires_at")
    )
    if valid_until is not None and valid_until < evaluated_at:
        return "条件已过期"
    if report_cutoff is not None and (evaluated_at - report_cutoff).total_seconds() > max_age_seconds:
        return "报告已过期"
    if (evaluated_at - observed["as_of"]).total_seconds() > max_age_seconds:
        return "引用数据已过期"
    return None


def _decision_operator_result(
    operator: Any,
    observed: float,
    threshold: float,
    previous: float | None,
) -> bool | None:
    if operator == "gt":
        return observed > threshold
    if operator == "gte":
        return observed >= threshold
    if operator == "lt":
        return observed < threshold
    if operator == "lte":
        return observed <= threshold
    if operator == "crosses_above":
        return None if previous is None else previous <= threshold < observed
    if operator == "crosses_below":
        return None if previous is None else previous >= threshold > observed
    return None


def _decision_condition_result(
    horizon: str,
    group: str,
    group_label: str,
    condition: Mapping[str, Any],
    metrics: Mapping[str, Any],
    report_cutoff: datetime | None,
    evaluated_at: datetime,
    *,
    max_age_seconds: int,
) -> dict[str, Any]:
    text = condition.get("text") if isinstance(condition.get("text"), str) else ""
    base = {
        "horizon": horizon,
        "group": group,
        "group_label": group_label,
        "text": text,
        "source_ids": _decision_source_ids(condition),
        "evaluated_at": evaluated_at.isoformat(),
        "method_version": DECISION_EVALUATION_VERSION,
        "condition": _plain(condition),
    }
    if condition.get("kind") == "manual":
        return {
            **base,
            "status": "not_evaluable",
            "status_label": _DECISION_STATUS_LABELS["not_evaluable"],
            "reason": "人工条件不能由当前行情自动判断",
        }
    if condition.get("kind") != "trigger":
        return {
            **base,
            "status": "not_evaluable",
            "status_label": _DECISION_STATUS_LABELS["not_evaluable"],
            "reason": "条件类型无法判断",
        }
    observed_ref = _decision_field(condition, "observed_metric_ref")
    threshold_ref = _decision_field(condition, "threshold_metric_ref")
    operator = _decision_field(condition, "operator")
    observed = _decision_metric(metrics, observed_ref, role="observed")
    threshold = _decision_metric(metrics, threshold_ref, role="threshold")
    reason = _decision_gate_reason(
        condition,
        observed,
        threshold,
        report_cutoff,
        evaluated_at,
        max_age_seconds=max_age_seconds,
    )
    if reason is not None:
        return {**base, "status": "not_evaluable", "status_label": _DECISION_STATUS_LABELS["not_evaluable"], "reason": reason}
    if operator not in _OPERATORS:
        return {**base, "status": "not_evaluable", "status_label": _DECISION_STATUS_LABELS["not_evaluable"], "reason": "缺少可识别的条件操作符"}
    result = _decision_operator_result(
        operator,
        observed["value"],
        threshold["value"],
        observed.get("previous_value"),
    )
    if result is None:
        return {**base, "status": "not_evaluable", "status_label": _DECISION_STATUS_LABELS["not_evaluable"], "reason": "缺少前一时点数据，无法判断穿越条件"}
    return {
        **base,
        "status": "matched" if result else "not_matched",
        "status_label": _DECISION_STATUS_LABELS["matched" if result else "not_matched"],
        "reason": "当前数据已满足条件" if result else "当前数据未满足条件",
        "observed_value": observed["value"],
        "threshold_value": threshold["value"],
    }


def _decision_condition_reference(view: Mapping[str, Any], group: str, metrics: Mapping[str, Any]) -> dict[str, Any] | None:
    conditions = _decision_field(view, group, [])
    if not isinstance(conditions, (list, tuple)):
        return None
    for condition in conditions:
        if isinstance(condition, Mapping) and condition.get("kind") == "trigger":
            reference = _decision_field(condition, "threshold_metric_ref")
            resolved = _decision_metric(metrics, reference, role="reference")
            if resolved is not None:
                return resolved
    return None


def _decision_risk_reward(
    view: Mapping[str, Any],
    metrics: Mapping[str, Any],
    report_cutoff: datetime | None,
    evaluated_at: datetime,
    *,
    max_age_seconds: int,
) -> dict[str, Any]:
    stance = view.get("stance")
    declared_direction = _decision_field(view, "direction")
    direction = (
        declared_direction
        if declared_direction in {"long", "short"}
        else "long" if stance == "positive" else "short" if stance == "negative" else None
    )
    base = {
        "status": "not_evaluable",
        "status_label": _DECISION_STATUS_LABELS["not_evaluable"],
        "ratio": None,
        "direction": direction or "unknown",
        "evaluated_at": evaluated_at.isoformat(),
        "method_version": DECISION_EVALUATION_VERSION,
    }
    if direction is None:
        return {**base, "reason": "方向不明确，无法计算风险收益比"}
    entry = (
        _decision_condition_reference(view, "participation_conditions", metrics)
        or _decision_condition_reference(view, "confirmation_conditions", metrics)
    )
    stop = _decision_condition_reference(view, "stop_loss_conditions", metrics)
    take = _decision_condition_reference(view, "take_profit_conditions", metrics)
    if entry is None or stop is None or take is None:
        return {**base, "reason": "缺少计划入场、止损或止盈参考"}
    if not entry["source_ids"] or not stop["source_ids"] or not take["source_ids"]:
        return {**base, "reason": "计划入场、止损或止盈参考缺少来源"}
    if len({entry["as_of"], stop["as_of"], take["as_of"]}) != 1:
        return {**base, "reason": "计划入场、止损和止盈有效时点不一致"}
    if report_cutoff is not None and (evaluated_at - report_cutoff).total_seconds() > max_age_seconds:
        return {**base, "reason": "报告已过期"}
    if (evaluated_at - entry["as_of"]).total_seconds() > max_age_seconds:
        return {**base, "reason": "计划价格引用已过期"}
    entry_value, stop_value, take_value = entry["value"], stop["value"], take["value"]
    if direction == "long":
        numerator, denominator = take_value - entry_value, entry_value - stop_value
    else:
        numerator, denominator = entry_value - take_value, stop_value - entry_value
    if denominator <= 0:
        return {**base, "reason": "计划入场与止损参考无法形成正向风险区间"}
    if numerator <= 0:
        return {**base, "reason": "计划止盈参考与方向不一致"}
    return {
        **base,
        "status": "matched",
        "status_label": _DECISION_STATUS_LABELS["matched"],
        "ratio": round(numerator / denominator, 6),
        "reason": "风险收益比已按计划入场参考计算",
    }


def evaluate_decision_conditions(
    report: Mapping[str, Any] | Any,
    metrics: Mapping[str, Any] | None = None,
    *,
    evaluated_at: Any | None = None,
    max_age_seconds: int = DECISION_EVALUATION_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    """Evaluate current decision conditions without filling or model calls."""
    document = _plain(report)
    if not isinstance(document, Mapping):
        document = {}
    metric_values = metrics if isinstance(metrics, Mapping) else {}
    parsed_evaluated_at = _decision_timestamp(evaluated_at) or datetime.now(CN_TZ)
    report_cutoff = _decision_report_cutoff(document)
    views = document.get("horizon_views")
    if not isinstance(views, Mapping):
        views = document.get("horizons") if isinstance(document.get("horizons"), Mapping) else {}
    horizons: dict[str, Any] = {}
    for horizon in _HORIZONS:
        view = views.get(horizon) if isinstance(views, Mapping) else None
        view = view if isinstance(view, Mapping) else {}
        conditions: list[dict[str, Any]] = []
        for group, group_label in _DECISION_CONDITION_GROUPS:
            raw_conditions = _decision_field(view, group, [])
            if not isinstance(raw_conditions, (list, tuple)):
                continue
            conditions.extend(
                _decision_condition_result(
                    horizon,
                    group,
                    group_label,
                    condition,
                    metric_values,
                    report_cutoff,
                    parsed_evaluated_at,
                    max_age_seconds=max_age_seconds,
                )
                for condition in raw_conditions
                if isinstance(condition, Mapping)
            )
        horizons[horizon] = {
            "conditions": conditions,
            "risk_reward": _decision_risk_reward(
                view,
                metric_values,
                report_cutoff,
                parsed_evaluated_at,
                max_age_seconds=max_age_seconds,
            ),
        }
    return {
        "report_id": document.get("report_id"),
        "evaluated_at": parsed_evaluated_at.isoformat(),
        "method_version": DECISION_EVALUATION_VERSION,
        "horizons": horizons,
    }


def replay_report_conditions(
    snapshot: Mapping[str, Any],
    target_bars: Iterable[Any],
    *,
    horizons: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    """Replay only daily-price triggers; manual conditions remain manual."""
    bars = _sorted_bars(target_bars)
    results: list[dict[str, Any]] = []
    for horizon in horizons or _HORIZONS:
        view = (snapshot.get("horizons") or {}).get(horizon) or {}
        for condition in view.get("conditions") or []:
            condition = condition if isinstance(condition, Mapping) else {}
            base = {"horizon": horizon, "condition": _plain(condition)}
            if condition.get("kind") == "manual":
                results.append({**base, "status": "manual", "reason": "requires_manual_review"})
                continue
            field = _metric_field(condition.get("observed_metric_ref"))
            operator = condition.get("operator")
            threshold = _number(condition.get("threshold"))
            if field is None or operator not in _OPERATORS or threshold is None:
                results.append({**base, "status": "unsupported", "reason": "not_daily_price_mappable"})
                continue
            matched: dict[str, Any] | None = None
            previous: float | None = None
            for bar in bars:
                value = bar.get(field)
                if value is None:
                    previous = None
                    continue
                triggered = {
                    "gt": value > threshold,
                    "gte": value >= threshold,
                    "lt": value < threshold,
                    "lte": value <= threshold,
                    "crosses_above": previous is not None and previous <= threshold < value,
                    "crosses_below": previous is not None and previous >= threshold > value,
                }[operator]
                if triggered:
                    matched = {"date": bar["date"], "value": value}
                    break
                previous = value
            results.append(
                {
                    **base,
                    "status": "triggered" if matched else "not_triggered",
                    "date": matched.get("date") if matched else None,
                    "value": matched.get("value") if matched else None,
                }
            )
    return results


def _observation_key(row: Mapping[str, Any]) -> str:
    required = (
        row.get("tracking_id"),
        row.get("horizon"),
        row.get("window"),
        row.get("source_hash"),
        row.get("benchmark_source_hash"),
    )
    if any(value in (None, "") for value in required):
        raise ValueError(
            "observation requires tracking_id, horizon, window, source_hash "
            "and benchmark_source_hash"
        )
    return "|".join(str(value) for value in required)


def append_outcome_observation(run_dir: str | Path, observation: Mapping[str, Any]) -> bool:
    """Append one observation unless its tracking/window/source key exists."""
    row = _plain(observation)
    if not isinstance(row, Mapping):
        raise ValueError("observation must be a mapping")
    key = _observation_key(row)
    path = Path(run_dir) / "outcome_observations.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_keys: set[str] = set()
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                saved = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(saved, Mapping):
                try:
                    existing_keys.add(_observation_key(saved))
                except ValueError:
                    continue
    if key in existing_keys:
        return False
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(dict(row), ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return True


def read_latest_outcome_observations(
    run_dir: str | Path, tracking_id: str | None = None
) -> list[dict[str, Any]]:
    """Read the last source version for each tracking/horizon/window."""
    path = Path(run_dir) / "outcome_observations.jsonl"
    if not path.is_file():
        return []
    latest: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if tracking_id is not None and row.get("tracking_id") != tracking_id:
            continue
        try:
            _observation_key(row)  # validate the append/idempotency identity
            key = (row.get("tracking_id"), row.get("horizon"), row.get("window"))
            latest[key] = row
        except ValueError:
            continue
    return list(latest.values())


def aggregate_outcome_observations(
    observations: Iterable[Mapping[str, Any]], *, min_samples: int = 30
) -> dict[str, dict[int, dict[str, Any]]]:
    """Pure grouped summary; small samples never produce accuracy claims."""
    grouped: dict[tuple[str, int], list[Mapping[str, Any]]] = defaultdict(list)
    for row in observations:
        horizon, window = row.get("horizon"), row.get("window")
        if horizon in WINDOW_SPECS and window in WINDOW_SPECS[horizon]:
            grouped[(horizon, int(window))].append(row)
    result: dict[str, dict[int, dict[str, Any]]] = {horizon: {} for horizon in WINDOW_SPECS}
    for (horizon, window), rows in grouped.items():
        complete = [
            row
            for row in rows
            if row.get("status") == "complete"
            and _number(row.get("absolute_return_pct")) is not None
        ]
        returns = [_number(row.get("absolute_return_pct")) for row in complete]
        mfe = [_number(row.get("mfe_pct")) for row in complete]
        mae = [_number(row.get("mae_pct")) for row in complete]
        scorable = [
            row
            for row in complete
            if row.get("stance") in {"positive", "negative"}
            and _number(row.get("relative_market_return_pct")) is not None
        ]
        correct = 0
        for row in scorable:
            value = _number(row.get("relative_market_return_pct"))
            stance = row.get("stance")
            correct += int(
                (stance == "positive" and value > 0)
                or (stance == "negative" and value < 0)
            )
        total_count = len(rows)
        sample_count = len(scorable)
        result[horizon][window] = {
            "horizon": horizon,
            "window": window,
            "sample_count": sample_count,
            "complete_count": len(complete),
            "total_count": total_count,
            "incomplete_count": total_count - len(complete),
            "scored_count": len(scorable),
            "status": "insufficient_sample" if len(scorable) < min_samples else "available",
            "directional_accuracy": (
                correct / len(scorable) if len(scorable) >= min_samples else None
            ),
            "average_absolute_return_pct": (
                sum(value for value in returns if value is not None) / len(returns) if returns else None
            ),
            "average_mfe_pct": (
                sum(value for value in mfe if value is not None) / len([value for value in mfe if value is not None])
                if any(value is not None for value in mfe)
                else None
            ),
            "average_mae_pct": (
                sum(value for value in mae if value is not None) / len([value for value in mae if value is not None])
                if any(value is not None for value in mae)
                else None
            ),
        }
    return result


# --- selection outcome validation -------------------------------------------------


def _selection_value(row: Mapping[str, Any], name: str, default: Any = None) -> Any:
    """Read a report field written either in snake_case or camelCase."""
    if name in row:
        return row[name]
    parts = name.split("_")
    alias = parts[0] + "".join(part.capitalize() for part in parts[1:])
    return row.get(alias, default)


def _selection_tracking_id(report: Mapping[str, Any]) -> str:
    report_id = _selection_value(report, "report_id", "")
    run_id = _selection_value(report, "workflow_run_id", "")
    digest = hashlib.sha256(f"{run_id}:{report_id}".encode()).hexdigest()
    return f"stock_selection_outcome_{digest[:24]}"


def build_selection_outcome_tracking_snapshot(
    report: Mapping[str, Any] | Any,
) -> dict[str, Any] | None:
    """Capture the immutable selection pool used by later explicit refreshes."""
    doc = _plain(report)
    if not isinstance(doc, Mapping):
        return None
    if _selection_value(doc, "kind") != "stock_selection":
        return None
    candidates = _selection_value(doc, "candidates", [])
    if not isinstance(candidates, list):
        raise ValueError("selection report candidates are invalid")
    if len(candidates) > MAX_SELECTION_OUTCOME_CANDIDATES:
        raise ValueError("selection report contains too many candidates to validate")
    run_id = _selection_value(doc, "workflow_run_id")
    report_id = _selection_value(doc, "report_id")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("selection report workflow run id is missing")
    if not isinstance(report_id, str) or not report_id:
        raise ValueError("selection report id is missing")
    captured: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            raise ValueError("selection report candidate is invalid")
        instrument_id = _selection_value(candidate, "instrument_id")
        if not isinstance(instrument_id, str) or not re.fullmatch(
            r"(?:XSHG|XSHE|BJSE):\d{6}", instrument_id
        ):
            raise ValueError("selection report candidate instrument id is invalid")
        if instrument_id in seen:
            raise ValueError("selection report contains duplicate candidates")
        seen.add(instrument_id)
        rank = _selection_value(candidate, "rank")
        if isinstance(rank, bool) or not isinstance(rank, int) or rank < 1:
            raise ValueError("selection report candidate rank is invalid")
        captured.append(
            {
                "instrument_id": instrument_id,
                "name": _selection_value(candidate, "name", ""),
                "industry": _selection_value(candidate, "industry"),
                "rank": rank,
                "score": _selection_value(candidate, "score"),
                "score_contributions": _plain(
                    _selection_value(candidate, "score_contributions", {})
                ),
                "selection_reasons": _plain(
                    _selection_value(candidate, "selection_reasons", [])
                ),
                "risk_flags": _plain(_selection_value(candidate, "risk_flags", [])),
                "data_quality": _selection_value(candidate, "data_quality"),
                "as_of": _selection_value(candidate, "as_of"),
                "source_ids": _plain(_selection_value(candidate, "source_ids", [])),
            }
        )
    return {
        "schema_version": 1,
        "tracking_id": _selection_tracking_id(doc),
        "report_id": report_id,
        "workflow_run_id": run_id,
        "report_as_of": _selection_value(doc, "as_of"),
        "strategy": _plain(_selection_value(doc, "strategy", {})),
        "candidate_count": len(captured),
        "candidates": captured,
        "benchmark": dict(PUBLIC_MARKET_BENCHMARK),
        "calculation": {
            "method": SELECTION_OUTCOME_METHOD,
            "version": SELECTION_OUTCOME_VERSION,
            "benchmark_method": "标的与中证全指使用相同起止交易日，计算收益差",
            "windows": list(SELECTION_WINDOWS),
        },
    }


def ensure_selection_outcome_tracking_snapshot(
    run_dir: str | Path, report: Mapping[str, Any] | Any
) -> dict[str, Any] | None:
    """Create or verify the immutable selection tracking snapshot."""
    snapshot = build_selection_outcome_tracking_snapshot(report)
    if snapshot is None:
        return None
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / SELECTION_TRACKING_FILE
    if path.is_file():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"immutable selection tracking is unreadable: {exc}") from exc
        if existing != snapshot:
            raise ValueError("immutable selection tracking cannot be overwritten")
        return existing
    content = json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return snapshot


def _selection_observation_key(row: Mapping[str, Any]) -> str:
    required = (
        row.get("selection_tracking_id"),
        row.get("instrument_id"),
        row.get("window"),
        row.get("source_hash"),
        row.get("benchmark_source_hash"),
    )
    if any(value in (None, "") for value in required):
        raise ValueError(
            "selection observation requires selection_tracking_id, instrument_id, "
            "window, source_hash and benchmark_source_hash"
        )
    return "|".join(str(value) for value in required)


def append_selection_outcome_observations(
    run_dir: str | Path, observations: Iterable[Mapping[str, Any]]
) -> int:
    """Append a batch atomically; repeated source snapshots are idempotent."""
    rows = [_plain(row) for row in observations]
    rows = [row for row in rows if isinstance(row, Mapping) and row.get("status") != "pending"]
    if not rows:
        return 0
    path = Path(run_dir) / SELECTION_OBSERVATIONS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_lines: list[str] = []
    existing_keys: set[str] = set()
    if path.is_file():
        existing_lines = path.read_text(encoding="utf-8").splitlines()
        for line in existing_lines:
            try:
                saved = json.loads(line)
                if isinstance(saved, Mapping):
                    existing_keys.add(_selection_observation_key(saved))
            except (json.JSONDecodeError, ValueError):
                continue
    additions: list[str] = []
    for row in rows:
        key = _selection_observation_key(row)
        if key in existing_keys:
            continue
        additions.append(json.dumps(dict(row), ensure_ascii=False, sort_keys=True))
        existing_keys.add(key)
    if not additions:
        return 0
    # Replacing the complete append-only log keeps a storage failure from
    # leaving a partially written batch while preserving all prior entries.
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        content = "\n".join([*existing_lines, *additions]) + "\n"
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return len(additions)


def read_latest_selection_outcome_observations(
    run_dir: str | Path, tracking_id: str | None = None
) -> list[dict[str, Any]]:
    path = Path(run_dir) / SELECTION_OBSERVATIONS_FILE
    if not path.is_file():
        return []
    latest: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if tracking_id is not None and row.get("selection_tracking_id") != tracking_id:
            continue
        try:
            _selection_observation_key(row)
        except ValueError:
            continue
        key = (
            row.get("selection_tracking_id"),
            row.get("instrument_id"),
            row.get("window"),
        )
        latest[key] = row
    return list(latest.values())


def _v5_required_mapping(value: Any, field_name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field_name} must be an object")
    return value


def _v5_required_number(value: Any, field_name: str, *, positive: bool = False) -> float:
    number = _number(value)
    if number is None or (positive and number <= 0):
        requirement = "positive " if positive else "finite "
        raise ValueError(f"{field_name} must be a {requirement}number")
    return number


def _v5_required_sources(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{field_name} must be a non-empty list")
    sources = list(dict.fromkeys(
        item.strip() for item in value if isinstance(item, str) and item.strip()
    ))
    if not sources or len(sources) != len(value):
        raise ValueError(f"{field_name} must contain only non-empty source ids")
    return sources


def _v5_required_timestamp(value: Any, field_name: str) -> tuple[str, datetime]:
    if not isinstance(value, (str, datetime)):
        raise ValueError(f"{field_name} must be a timestamp")
    parsed = parse_asia_datetime(value)
    if parsed is None or parsed.tzinfo is None:
        raise ValueError(f"{field_name} must be a valid timezone-aware timestamp")
    return parsed.isoformat(), parsed


def _v5_metric(
    derived: Mapping[str, Any], name: str, all_sources: list[str]
) -> Mapping[str, Any]:
    metric = _v5_required_mapping(_decision_field(derived, name), f"derived_decision_metrics.{name}")
    sources = _v5_required_sources(
        _decision_field(metric, "source_ids"),
        f"derived_decision_metrics.{name}.source_ids",
    )
    _v5_required_timestamp(
        _decision_field(metric, "as_of"),
        f"derived_decision_metrics.{name}.as_of",
    )
    for source_id in sources:
        if source_id not in all_sources:
            all_sources.append(source_id)
    return metric


def _v5_price(value: float) -> float:
    rounded = round(float(value), 2)
    if not math.isfinite(rounded) or rounded <= 0:
        raise ValueError("V5 price plan produced a non-positive price")
    return rounded


def _v5_floor_percentage(value: float, places: int = 6) -> float:
    factor = 10**places
    return math.floor(value * factor + 1e-12) / factor


def build_v5_derived_decision_metrics(
    bundle: Mapping[str, Any],
    *,
    generated_at: str | datetime | None = None,
    eligible_horizons: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Build the deterministic V5 price and position plans from frozen Evidence.

    This function deliberately consumes only ``derived_decision_metrics`` and
    ``decision_readiness``.  It does not call providers, inspect narratives or
    invoke an LLM.  ``generated_at`` is optional for callers that need a
    reproducible result: when omitted, the frozen research cutoff is used.
    """
    if not isinstance(bundle, Mapping):
        raise ValueError("V5 decision bundle must be an object")
    derived = _v5_required_mapping(
        _decision_field(bundle, "derived_decision_metrics"),
        "derived_decision_metrics",
    )
    readiness = _v5_required_mapping(
        _decision_field(bundle, "decision_readiness"),
        "decision_readiness",
    )
    market_as_of, market_dt = _v5_required_timestamp(
        _decision_field(derived, "as_of"), "derived_decision_metrics.as_of"
    )
    research_cutoff, research_cutoff_dt = _v5_required_timestamp(
        _decision_field(bundle, "research_cutoff_at"), "research_cutoff_at"
    )
    if research_cutoff_dt < market_dt:
        raise ValueError("research_cutoff_at must not precede market_as_of")
    _, readiness_dt = _v5_required_timestamp(
        _decision_field(readiness, "as_of"), "decision_readiness.as_of"
    )
    if readiness_dt != market_dt:
        raise ValueError("decision_readiness.as_of must match derived_decision_metrics.as_of")
    partial = eligible_horizons is not None
    selected_horizons = tuple(
        dict.fromkeys(eligible_horizons if eligible_horizons is not None else _HORIZONS)
    )
    if any(horizon not in _HORIZONS for horizon in selected_horizons):
        raise ValueError("eligible_horizons contains an unsupported horizon")
    if not partial and _decision_field(readiness, "status") != "ready":
        raise ValueError("decision_readiness is not ready")

    all_sources = _v5_required_sources(
        _decision_field(derived, "source_ids"),
        "derived_decision_metrics.source_ids",
    )
    readiness_sources = _v5_required_sources(
        _decision_field(readiness, "source_ids"),
        "decision_readiness.source_ids",
    )
    for source_id in readiness_sources:
        if source_id not in all_sources:
            all_sources.append(source_id)

    readiness_horizons = _v5_required_mapping(
        _decision_field(readiness, "horizons"), "decision_readiness.horizons"
    )
    for horizon in selected_horizons:
        status = _decision_field(
            _v5_required_mapping(
                _decision_field(readiness_horizons, horizon),
                f"decision_readiness.horizons.{horizon}",
            ),
            "status",
        )
        if status != "ready":
            raise ValueError(f"decision_readiness.horizons.{horizon} is not ready")

    price = _v5_required_number(
        _decision_field(derived, "price"),
        "derived_decision_metrics.price",
        positive=True,
    )
    momentum = _v5_metric(derived, "momentum", all_sources)
    _v5_required_number(
        _decision_field(momentum, "momentum20_pct"),
        "derived_decision_metrics.momentum.momentum20_pct",
    )
    _v5_required_number(
        _decision_field(momentum, "momentum60_pct"),
        "derived_decision_metrics.momentum.momentum60_pct",
    )
    atr_metric = _v5_metric(derived, "atr20", all_sources)
    atr = _v5_required_number(
        _decision_field(atr_metric, "value"),
        "derived_decision_metrics.atr20.value",
        positive=True,
    )
    trend = _v5_metric(derived, "trend", all_sources)
    trend_value = _decision_field(trend, "value")
    if not isinstance(trend_value, str) or not trend_value.strip():
        raise ValueError("derived_decision_metrics.trend.value must be non-empty")
    ma20 = _v5_required_number(
        _decision_field(trend, "ma20"), "derived_decision_metrics.trend.ma20", positive=True
    )
    ma60 = _v5_required_number(
        _decision_field(trend, "ma60"), "derived_decision_metrics.trend.ma60", positive=True
    )
    volatility = _v5_metric(derived, "volatility", all_sources)
    atr20_pct = _v5_required_number(
        _decision_field(volatility, "atr20_pct"),
        "derived_decision_metrics.volatility.atr20_pct",
        positive=True,
    )
    return_std20_pct = _number(_decision_field(volatility, "return_std20_pct")) or 0.0
    swing = _v5_metric(derived, "swing", all_sources)
    support = _v5_required_number(
        _decision_field(swing, "support"), "derived_decision_metrics.swing.support", positive=True
    )
    resistance = _v5_required_number(
        _decision_field(swing, "resistance"), "derived_decision_metrics.swing.resistance", positive=True
    )
    if support >= resistance:
        raise ValueError("derived_decision_metrics.swing support must be below resistance")
    stop_distance = _v5_metric(derived, "stop_distance", all_sources)
    provided_stop = _v5_required_number(
        _decision_field(stop_distance, "stop_loss"),
        "derived_decision_metrics.stop_distance.stop_loss",
        positive=True,
    )
    _v5_required_number(
        _decision_field(stop_distance, "value_pct"),
        "derived_decision_metrics.stop_distance.value_pct",
        positive=True,
    )

    raw_generated_at = generated_at if generated_at is not None else research_cutoff
    generated_text, generated_dt = _v5_required_timestamp(raw_generated_at, "generated_at")
    if generated_dt < research_cutoff_dt:
        raise ValueError("generated_at must not precede research_cutoff_at")

    # The anchor blends the frozen quote and moving averages, then remains
    # inside the observed swing range.  Each horizon changes only its ATR
    # bandwidth and holding window; no narrative or prediction enters here.
    anchor = max(support, min(resistance, (price + ma20 + ma60) / 3.0))
    volatility_adjustment = max(
        0.25,
        min(1.0, 1.0 / (1.0 + max(atr20_pct, return_std20_pct) / 5.0)),
    )
    enhanced = _decision_field(readiness, "enhanced")
    enhanced_available = (
        isinstance(enhanced, Mapping)
        and _decision_field(enhanced, "status") == "available"
    )
    evidence_strength = "strong" if enhanced_available else "medium"

    from mona.services.stock.schemas import V5PositionPlan, V5TradingCondition, V5TradingPlan

    horizons: dict[str, dict[str, Any]] = {}
    for horizon in selected_horizons:
        spec = _V5_HORIZON_PLAN_SPECS[horizon]
        entry_band = max(0.01, atr * float(spec["entry_atr"]))
        pullback_band = max(0.01, atr * float(spec["pullback_atr"]))
        entry_low = _v5_price(max(0.01, anchor - entry_band))
        entry_high = _v5_price(anchor + entry_band)
        if entry_high <= entry_low:
            entry_high = _v5_price(entry_low + 0.01)
        pullback_high = _v5_price(max(0.01, anchor - entry_band * 0.25))
        pullback_low = _v5_price(max(0.01, pullback_high - pullback_band))
        if pullback_high < pullback_low:
            pullback_low, pullback_high = pullback_high, pullback_low
        entry_midpoint = (entry_low + entry_high) / 2.0

        stop_candidates = [
            provided_stop,
            support - atr * float(spec["stop_atr"]),
            ma20 - atr * float(spec["stop_atr"]) * 0.5,
        ]
        valid_candidates = [
            candidate
            for candidate in stop_candidates
            if 0 < candidate < entry_midpoint
        ]
        stop_raw = max(valid_candidates) if valid_candidates else 0.0
        if stop_raw <= 0 or stop_raw >= entry_midpoint:
            stop_raw = entry_midpoint - max(atr * float(spec["stop_atr"]), entry_midpoint * 0.02)
        stop_loss = _v5_price(max(0.01, stop_raw))
        if stop_loss >= entry_midpoint:
            stop_loss = _v5_price(entry_midpoint - 0.01)
        if stop_loss >= entry_midpoint:
            raise ValueError(f"{horizon} cannot produce a positive stop distance")

        risk = entry_midpoint - stop_loss
        first_take_profit = _v5_price(entry_midpoint + 2.0 * risk)
        second_take_profit = _v5_price(entry_midpoint + 3.0 * risk)
        if first_take_profit <= entry_midpoint:
            first_take_profit = _v5_price(entry_midpoint + 0.01)
        if second_take_profit <= first_take_profit:
            second_take_profit = _v5_price(first_take_profit + 0.01)
        risk_reward_first = round(
            (first_take_profit - entry_midpoint) / (entry_midpoint - stop_loss), 10
        )
        risk_reward_second = round(
            (second_take_profit - entry_midpoint) / (entry_midpoint - stop_loss), 10
        )
        threshold_root = (
            "derived_decision_metrics.horizons."
            f"{horizon}.trading_plan"
        )

        def condition(
            description: str,
            threshold_name: str,
            operator: str,
            status: str,
        ) -> dict[str, Any]:
            return V5TradingCondition(
                kind="price_trigger",
                description=description,
                observed_metric_ref="quote.price",
                operator=operator,
                threshold_metric_ref=f"{threshold_root}.{threshold_name}",
                status=status,
                market_as_of=market_as_of,
                source_ids=list(all_sources),
            ).model_dump(mode="json")

        entry_status = "triggered" if price >= entry_high else "not_triggered"
        stop_status = "triggered" if price <= stop_loss else "not_triggered"
        take_status = "triggered" if price >= first_take_profit else "not_triggered"
        plan = V5TradingPlan(
            reference_buy_low=entry_low,
            reference_buy_high=entry_high,
            pullback_buy_low=pullback_low,
            pullback_buy_high=pullback_high,
            stop_loss=stop_loss,
            first_take_profit=first_take_profit,
            first_reduce_fraction=1.0 / 3.0,
            second_take_profit=second_take_profit,
            second_reduce_fraction=1.0 / 3.0,
            risk_reward_first=risk_reward_first,
            risk_reward_second=risk_reward_second,
            currency="CNY",
            calculation_method=V5_DERIVED_DECISION_METHOD,
            calculation_version=f"{V5_DERIVED_DECISION_VERSION}-{horizon}",
            source_ids=list(all_sources),
            market_as_of=market_as_of,
            entry_conditions=[
                condition(
                    f"价格达到参考买入区间上沿 {entry_high:.2f} 元",
                    "reference_buy_high",
                    "gte",
                    entry_status,
                )
            ],
            exit_conditions=[
                condition(
                    f"价格跌至止损参考 {stop_loss:.2f} 元",
                    "stop_loss",
                    "lte",
                    stop_status,
                )
            ],
            take_profit_conditions=[
                condition(
                    f"价格达到第一止盈参考 {first_take_profit:.2f} 元",
                    "first_take_profit",
                    "gte",
                    take_status,
                )
            ],
        )
        # Persist the rounded distance first; every downstream sizing value,
        # including the theoretical limit, must use this exact saved value.
        stop_distance_pct = round(
            (entry_midpoint - stop_loss) / entry_midpoint * 100.0, 6
        )
        if stop_distance_pct <= 0:
            raise ValueError(f"{horizon} produced an invalid saved stop distance")
        theoretical_position = round(1.0 / stop_distance_pct * 100.0, 12)
        saved_volatility_adjustment = round(volatility_adjustment, 6)
        period_cap = float(spec["position_cap_pct"])
        max_position = _v5_floor_percentage(
            min(
                theoretical_position * saved_volatility_adjustment,
                V5_PRODUCT_SINGLE_STOCK_CAP_PCT,
                period_cap,
            )
        )
        # Keep the persisted percentage strictly within the Schema's
        # recomputed fixed-fractional-risk ceiling after decimal truncation.
        max_position = min(max_position, _v5_floor_percentage(theoretical_position))
        if max_position <= 0:
            raise ValueError(f"{horizon} cannot produce a positive position limit")
        initial_position = _v5_floor_percentage(max_position / 2.0)
        if initial_position <= 0:
            initial_position = max_position
        position = V5PositionPlan(
            risk_budget_pct=1.0,
            initial_position_pct=initial_position,
            max_position_pct=max_position,
            stop_distance_pct=stop_distance_pct,
            volatility_adjustment=saved_volatility_adjustment,
            liquidity_cap_pct=V5_PRODUCT_SINGLE_STOCK_CAP_PCT,
            calculation_method="fixed_fractional_risk",
            calculation_version=f"{V5_POSITION_METHOD_VERSION}-{horizon}",
        )
        valid_until = (
            generated_dt + timedelta(days=int(spec["valid_calendar_days"]))
        ).isoformat()
        review_trigger = (
            "10个交易日（按14个自然日近似）后，或价格触发条件变化时重新评估"
            if horizon == "short_term"
            else "计划有效期到期或价格触发条件变化时重新评估"
        )
        horizons[horizon] = {
            "trading_plan": plan.model_dump(mode="json"),
            "position_plan": position.model_dump(mode="json"),
            "valid_until": valid_until,
            "review_trigger": review_trigger,
            "evidence_strength": evidence_strength,
            "source_ids": list(all_sources),
        }

    return {
        "schema_version": 1,
        "generated_at": generated_text,
        "method_versions": {
            "decision": V5_DERIVED_DECISION_VERSION,
            "indicators": V5_INDICATOR_METHOD_VERSION,
            "conditions": V5_CONDITION_METHOD_VERSION,
        },
        "source_ids": list(all_sources),
        "horizons": horizons,
    }


def build_v6_derived_decision_metrics(
    bundle: Mapping[str, Any], *, generated_at: str | datetime | None = None
) -> dict[str, Any]:
    """Build independent V6 plans for only trade-eligible horizons.

    V5 remains all-or-nothing through ``build_v5_derived_decision_metrics``.
    V6 reuses that exact formula with a selected horizon set and records the
    eligibility boundary explicitly, so an unavailable medium/long horizon
    cannot erase an otherwise executable short plan.
    """
    if not isinstance(bundle, Mapping):
        raise ValueError("V6 decision bundle must be an object")
    readiness = _v5_required_mapping(
        _decision_field(bundle, "decision_readiness"),
        "decision_readiness",
    )
    readiness_horizons = _v5_required_mapping(
        _decision_field(readiness, "horizons"),
        "decision_readiness.horizons",
    )
    eligible = [
        horizon
        for horizon in _HORIZONS
        if _decision_field(
            _v5_required_mapping(
                _decision_field(readiness_horizons, horizon),
                f"decision_readiness.horizons.{horizon}",
            ),
            "status",
        )
        == "ready"
    ]
    # A V6 plan is still an executable trading artifact.  Without the short
    # horizon's quote/K-line/technical core, do not let a longer research
    # horizon create an isolated plan.
    if not eligible or "short_term" not in eligible:
        eligible = []
    raw_generated_at = generated_at if generated_at is not None else _decision_field(bundle, "research_cutoff_at")
    generated_text, _ = _v5_required_timestamp(raw_generated_at, "generated_at")
    derived = _decision_field(bundle, "derived_decision_metrics")
    source_ids = list(_decision_field(readiness, "source_ids") or [])
    if isinstance(derived, Mapping):
        source_ids = list(dict.fromkeys([*(_decision_field(derived, "source_ids") or []), *source_ids]))
    method_versions = {
        "decision": V5_DERIVED_DECISION_VERSION,
        "indicators": V5_INDICATOR_METHOD_VERSION,
        "conditions": V5_CONDITION_METHOD_VERSION,
    }
    if not eligible:
        return {
            "schema_version": 1,
            "generated_at": generated_text,
            "method_versions": method_versions,
            "source_ids": list(dict.fromkeys(source_ids)),
            "eligible_horizons": [],
            "generated_horizons": [],
            "horizons": {},
        }
    plan = build_v5_derived_decision_metrics(
        bundle,
        generated_at=generated_text,
        eligible_horizons=eligible,
    )
    plan["eligible_horizons"] = list(eligible)
    plan["generated_horizons"] = list(plan.get("horizons") or {})
    return plan


def _selection_observation_row(
    snapshot: Mapping[str, Any],
    candidate: Mapping[str, Any],
    window: int,
    *,
    status: str,
    data_status: str,
    market_window: list[dict[str, Any]],
    target_window: list[dict[str, Any]],
    target_hash: str,
    benchmark_hash: str,
) -> dict[str, Any]:
    instrument_id = str(candidate.get("instrument_id"))
    market_entry = market_window[0] if market_window else None
    market_exit = market_window[-1] if len(market_window) >= window else None
    target_by_date = {row["date"]: row for row in target_window}
    entry_bar = target_by_date.get(market_entry["date"]) if market_entry else None
    exit_bar = target_by_date.get(market_exit["date"]) if market_exit else None
    row: dict[str, Any] = {
        "selection_tracking_id": snapshot.get("tracking_id"),
        "report_id": snapshot.get("report_id"),
        "workflow_run_id": snapshot.get("workflow_run_id"),
        "instrument_id": instrument_id,
        "rank": candidate.get("rank"),
        "name": candidate.get("name"),
        "window": window,
        "status": status,
        "status_label": _SELECTION_STATUS_LABELS.get(status, status),
        "data_status": data_status,
        "data_status_label": _SELECTION_DATA_STATUS_LABELS.get(data_status, data_status),
        "entry_date": market_entry["date"] if market_entry else None,
        "exit_date": market_exit["date"] if market_exit else None,
        "entry_price": entry_bar.get("open") if entry_bar else None,
        "exit_price": exit_bar.get("close") if exit_bar else None,
        "target_return_pct": None,
        "benchmark_return_pct": None,
        "relative_return_pct": None,
        "source_hash": target_hash,
        "benchmark_source_hash": benchmark_hash,
        "calculation_method": SELECTION_OUTCOME_METHOD,
        "calculation_version": SELECTION_OUTCOME_VERSION,
        "benchmark": dict(PUBLIC_MARKET_BENCHMARK),
    }
    return row


def _selection_market_status(window: list[dict[str, Any]], window_size: int) -> str:
    if len(window) < window_size:
        return "window_not_mature"
    if any(row.get("volume") is None or row.get("volume") <= 0 for row in window):
        return "missing_benchmark_volume"
    if any(row.get(field) is None for row in window for field in ("open", "close")):
        return "missing_benchmark_price"
    return "available"


def _selection_target_status(window: list[dict[str, Any]], window_size: int) -> str:
    if len(window) != window_size:
        return "missing_target_bar"
    if any(row.get("volume") is None or row.get("volume") <= 0 for row in window):
        return "missing_target_volume"
    if any(row.get(field) is None for row in window for field in ("open", "close")):
        return "missing_target_price"
    return "available"


def calculate_selection_outcome_observations(
    snapshot: Mapping[str, Any],
    candidate_bars: Mapping[str, Iterable[Any]],
    benchmark_bars: Iterable[Any],
    *,
    source_hashes: Mapping[str, str] | None = None,
    benchmark_source_hash: str | None = None,
) -> list[dict[str, Any]]:
    """Calculate rank forward returns on the benchmark's exact trading dates."""
    report_date = _date_value(snapshot.get("report_as_of"))
    benchmark = _sorted_bars(benchmark_bars)
    benchmark_hash = benchmark_source_hash or _bars_hash(benchmark)
    market_eligible = [row for row in benchmark if report_date and row["_date"] > report_date]
    rows: list[dict[str, Any]] = []
    candidates = snapshot.get("candidates") or []
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        instrument_id = str(candidate.get("instrument_id"))
        target = _sorted_bars((candidate_bars or {}).get(instrument_id, []))
        target_hash = (source_hashes or {}).get(instrument_id) or _bars_hash(target)
        target_lookup = {row["date"]: row for row in target}
        for window in SELECTION_WINDOWS:
            market_window = market_eligible[:window]
            data_status = "available"
            if report_date is None:
                status, data_status = "incomplete", "missing_report_date"
            elif len(market_window) < window:
                status, data_status = "pending", "window_not_mature"
            else:
                market_status = _selection_market_status(market_window, window)
                target_window = [target_lookup.get(row["date"]) for row in market_window]
                target_window = [row for row in target_window if row is not None]
                target_status = _selection_target_status(target_window, window)
                market_dates = {row["date"] for row in market_window}
                benchmark_missing_evidence = any(
                    market_window[0]["date"] <= row["date"] <= market_window[-1]["date"]
                    and row["date"] not in market_dates
                    for row in target
                )
                if market_status != "available":
                    status, data_status = "incomplete", market_status
                elif benchmark_missing_evidence:
                    status, data_status = "incomplete", "missing_benchmark_bar"
                elif target_status != "available":
                    status, data_status = "incomplete", target_status
                else:
                    status = "complete"
            target_window = [target_lookup.get(row["date"]) for row in market_window]
            target_window = [row for row in target_window if row is not None]
            row = _selection_observation_row(
                snapshot,
                candidate,
                window,
                status=status,
                data_status=data_status,
                market_window=market_window,
                target_window=target_window,
                target_hash=target_hash,
                benchmark_hash=benchmark_hash,
            )
            if status == "complete":
                target_entry = target_window[0]["open"]
                target_exit = target_window[-1]["close"]
                market_entry = market_window[0]["open"]
                market_exit = market_window[-1]["close"]
                if target_entry in (None, 0) or market_entry in (None, 0):
                    row["status"] = "incomplete"
                    row["status_label"] = _SELECTION_STATUS_LABELS["incomplete"]
                    row["data_status"] = "missing_target_price"
                    row["data_status_label"] = _SELECTION_DATA_STATUS_LABELS["missing_target_price"]
                else:
                    target_return = (target_exit / target_entry - 1.0) * 100.0
                    benchmark_return = (market_exit / market_entry - 1.0) * 100.0
                    row["target_return_pct"] = round(target_return, 10)
                    row["benchmark_return_pct"] = round(benchmark_return, 10)
                    row["relative_return_pct"] = round(target_return - benchmark_return, 10)
            rows.append(row)
    return rows


def aggregate_selection_outcome_observations(
    snapshot: Mapping[str, Any], observations: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    """Summarize maturity and data completeness; never emit win-rate claims."""
    candidate_count = int(snapshot.get("candidate_count") or len(snapshot.get("candidates") or []))
    rows = list(observations)
    by_key = {(row.get("instrument_id"), int(row.get("window"))): row for row in rows if row.get("window") is not None}
    windows: list[dict[str, Any]] = []
    for window in SELECTION_WINDOWS:
        complete = incomplete = pending = 0
        for candidate in snapshot.get("candidates") or []:
            key = (candidate.get("instrument_id"), window)
            row = by_key.get(key)
            if row is None or row.get("status") == "pending":
                pending += 1
            elif row.get("status") == "complete":
                complete += 1
            else:
                incomplete += 1
        mature = complete + incomplete
        windows.append(
            {
                "window": window,
                "sample_count": complete,
                "mature_window_count": mature,
                "complete_count": complete,
                "incomplete_count": incomplete,
                "pending_count": pending,
                "total_window_count": candidate_count,
                "data_completeness_pct": round(complete / mature * 100.0, 2) if mature else None,
            }
        )
    return {
        "candidate_count": candidate_count,
        "total_window_count": candidate_count * len(SELECTION_WINDOWS),
        "mature_window_count": sum(item["mature_window_count"] for item in windows),
        "sample_count": sum(item["sample_count"] for item in windows),
        "data_completeness_pct": (
            round(
                sum(item["complete_count"] for item in windows)
                / sum(item["mature_window_count"] for item in windows)
                * 100.0,
                2,
            )
            if sum(item["mature_window_count"] for item in windows)
            else None
        ),
        "windows": windows,
        "note": "选股是排序结果，不计算方向胜率。",
    }


# Short aliases for callers that prefer the domain nouns without the long
# storage-oriented names.
def assess_a_share_execution(*args: Any, **kwargs: Any) -> Any:
    """Compatibility export for the V6 execution layer."""
    from mona.services.stock.execution import assess_a_share_execution as _assess

    return _assess(*args, **kwargs)


def materialize_v6_trading_plan(*args: Any, **kwargs: Any) -> Any:
    """Compatibility export for the V6 direction-aware materializer."""
    from mona.services.stock.execution import materialize_v6_trading_plan as _materialize

    return _materialize(*args, **kwargs)


create_tracking_snapshot = build_outcome_tracking_snapshot
append_observation = append_outcome_observation
read_latest_observations = read_latest_outcome_observations
aggregate_observations = aggregate_outcome_observations
replay_conditions = replay_report_conditions
