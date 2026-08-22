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
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from mona.services.stock.provenance import parse_asia_datetime

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
)
_PRICE_FIELDS = frozenset({"open", "close", "high", "low", "price", "volume"})
_OPERATORS = frozenset({"gt", "gte", "lt", "lte", "crosses_above", "crosses_below"})


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


def append_selection_outcome_observation(
    run_dir: str | Path, observation: Mapping[str, Any]
) -> bool:
    return bool(append_selection_outcome_observations(run_dir, [observation]))


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
create_tracking_snapshot = build_outcome_tracking_snapshot
append_observation = append_outcome_observation
read_latest_observations = read_latest_outcome_observations
aggregate_observations = aggregate_outcome_observations
replay_conditions = replay_report_conditions
