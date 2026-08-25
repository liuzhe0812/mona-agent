"""Append-only outcome tracking for Decision Report V6.

V6 keeps research-only horizons observable even when no trading plan exists.
All calculations use frozen report fields plus daily bars supplied explicitly
by the refresh caller; no provider or LLM is used here.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from filelock import FileLock

from mona.services.stock.provenance import parse_asia_datetime

V6_TRACKING_FILE = "v6_outcome_tracking.json"
V6_OBSERVATIONS_FILE = "v6_outcome_observations.jsonl"
V6_TRACKING_SCHEMA_VERSION = 1
V6_WINDOWS = (1, 5, 10, 20, 60, 120)
V6_BENCHMARK = {
    "instrumentId": "XSHG:000985",
    "name": "中证全指",
    "methodVersion": "v6-relative-csi-all-share-v1",
}


def _plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, Mapping):
        return {str(key): _plain(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(child) for child in value]
    return value


def _bar_value(bar: Any, name: str) -> Any:
    if isinstance(bar, Mapping):
        return bar.get(name)
    return getattr(bar, name, None)


def _bar_date(bar: Any) -> str | None:
    value = _bar_value(bar, "date") or _bar_value(bar, "as_of")
    if isinstance(value, datetime):
        return value.date().isoformat()
    if not isinstance(value, str):
        return None
    parsed = parse_asia_datetime(value)
    return parsed.date().isoformat() if parsed is not None else value[:10]


def _bar_number(bar: Any, name: str) -> float | None:
    value = _bar_value(bar, name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(float(value)) else None


def _normalized_bars(bars: Iterable[Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for bar in bars or []:
        date = _bar_date(bar)
        close = _bar_number(bar, "close")
        if date is None or close is None or close <= 0:
            continue
        rows.append(
            {
                "date": date,
                "open": _bar_number(bar, "open"),
                "high": _bar_number(bar, "high") or close,
                "low": _bar_number(bar, "low") or close,
                "close": close,
            }
        )
    return sorted({row["date"]: row for row in rows}.values(), key=lambda row: row["date"])


def _date(value: Any) -> str | None:
    parsed = parse_asia_datetime(value) if isinstance(value, str) else None
    return parsed.date().isoformat() if parsed is not None else None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _midpoint(plan: Mapping[str, Any] | None) -> float | None:
    if not isinstance(plan, Mapping):
        return None
    low = _number(plan.get("buy_low"))
    high = _number(plan.get("buy_high"))
    if low is not None and high is not None:
        return (low + high) / 2
    low = _number(plan.get("reference_buy_low"))
    high = _number(plan.get("reference_buy_high"))
    return (low + high) / 2 if low is not None and high is not None else None


def _plan_snapshot(plan: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(plan, Mapping):
        return None
    names = (
        "buy_low", "buy_high", "pullback_low", "pullback_high",
        "confirmation_price", "invalidation_price", "exit_price",
        "reentry_confirmation_price", "stop_loss", "first_take_profit",
        "second_take_profit", "initial_position_pct", "max_position_pct",
        "risk_budget_pct", "risk_reward_first_after_cost",
        "risk_reward_second_after_cost", "risk_profile_configured",
        "risk_profile_name", "calculation_method", "calculation_version",
        "execution_mode", "source_ids",
        "cost_assumptions",
    )
    result = {name: _plain(plan.get(name)) for name in names if name in plan}
    execution = plan.get("execution")
    if isinstance(execution, Mapping):
        result["execution"] = {
            "estimated_slippage_pct": execution.get("estimated_slippage_pct"),
            "execution_status": execution.get("execution_status"),
            "source_ids": list(execution.get("source_ids") or []),
        }
    return result


def build_v6_tracking_snapshot(report: Mapping[str, Any]) -> dict[str, Any] | None:
    """Build the immutable prediction snapshot for a validated V6 report."""
    if not isinstance(report, Mapping) or report.get("schema_version") != 6:
        return None
    report_id = report.get("report_id")
    workflow_run_id = report.get("workflow_run_id")
    instrument = report.get("instrument")
    if not isinstance(report_id, str) or not isinstance(workflow_run_id, str):
        return None
    if not isinstance(instrument, Mapping):
        return None
    quant_promotion = report.get("quant_promotion")
    horizons: dict[str, Any] = {}
    for horizon in ("short_term", "medium_term", "long_term"):
        decision = (report.get("horizon_decisions") or {}).get(horizon)
        if not isinstance(decision, Mapping):
            return None
        horizon_quant = (
            quant_promotion.get("horizons", {}).get(horizon)
            if isinstance(quant_promotion, Mapping)
            and isinstance(quant_promotion.get("horizons"), Mapping)
            else None
        )
        plan = decision.get("materialized_plan")
        plan_copy = _plan_snapshot(plan)
        reference_price = _number(report.get("current_price"))
        horizons[horizon] = {
            "direction": decision.get("direction"),
            "action": decision.get("action"),
            "researchStatus": decision.get("research_status"),
            "tradeStatus": decision.get("trade_status"),
            "materializedPlan": plan_copy,
            "validUntil": decision.get("valid_until"),
            "reviewTrigger": decision.get("review_trigger"),
            "referencePrice": reference_price,
            "benchmarkPrice": _number(report.get("benchmark_price")),
            "sourceIds": list(decision.get("source_ids") or []),
            "quantPromotion": _plain(horizon_quant),
        }
    tracking_id = "stock_v6_outcome_" + hashlib.sha256(
        f"{workflow_run_id}:{report_id}".encode("utf-8")
    ).hexdigest()[:24]
    return {
        "schemaVersion": V6_TRACKING_SCHEMA_VERSION,
        "trackingId": tracking_id,
        "reportId": report_id,
        "workflowRunId": workflow_run_id,
        "instrument": dict(instrument),
        "reportAsOf": report.get("market_as_of") or report.get("research_cutoff_at"),
        "researchCutoffAt": report.get("research_cutoff_at"),
        "marketAsOf": report.get("market_as_of"),
        "decisionMode": report.get("decision_mode"),
        "riskProfileConfigured": report.get("risk_profile_configured", False),
        "riskLevel": report.get("risk_level", "conservative"),
        "holdingState": report.get("holding_state", "not_holding"),
        "researchStatus": report.get("research_status"),
        "tradeStatus": report.get("trade_status"),
        "quantPromotion": _plain(quant_promotion),
        "horizons": horizons,
        "methodVersions": dict(report.get("method_versions") or {}),
        "sourceIds": list(report.get("source_ids") or []),
        "priceSourceIds": list(report.get("price_source_ids") or []),
        "benchmark": dict(V6_BENCHMARK),
        "dataProxyLabels": ["daily_bar_proxy"],
    }


def ensure_v6_tracking_snapshot(run_dir: str | Path, report: Mapping[str, Any]) -> dict[str, Any]:
    snapshot = build_v6_tracking_snapshot(report)
    if snapshot is None:
        raise ValueError("report is not a valid V6 deep-research report")
    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / V6_TRACKING_FILE
    with FileLock(str(path) + ".lock"):
        if path.is_file():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError("tracking_corrupt: V6 outcome tracking is unreadable") from exc
            if existing != snapshot:
                raise ValueError("V6 outcome tracking snapshot is immutable")
            return existing
        tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(snapshot, ensure_ascii=False, indent=2))
            handle.flush()
            os.fsync(handle.fileno())
        tmp.replace(path)
        return snapshot


def _read_v6_observations_unlocked(
    run_dir: str | Path, tracking_id: str | None = None
) -> list[dict[str, Any]]:
    path = Path(run_dir) / V6_OBSERVATIONS_FILE
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError("tracking_corrupt: invalid V6 observation JSON") from exc
        if not isinstance(value, dict):
            continue
        if tracking_id is None or value.get("trackingId") == tracking_id:
            rows.append(value)
    return rows


def read_v6_observations(run_dir: str | Path, tracking_id: str | None = None) -> list[dict[str, Any]]:
    path = Path(run_dir) / V6_OBSERVATIONS_FILE
    with FileLock(str(path) + ".lock"):
        return _read_v6_observations_unlocked(run_dir, tracking_id)


def append_v6_observation(run_dir: str | Path, observation: Mapping[str, Any]) -> bool:
    row = _plain(observation)
    if not isinstance(row, dict):
        raise ValueError("V6 observation must be an object")
    required = (
        "trackingId",
        "horizon",
        "window",
        "status",
        "targetSourceHash",
        "benchmarkSourceHash",
        "calculationVersion",
    )
    if any(not row.get(field) for field in required):
        raise ValueError("V6 observation is missing its identity fields")
    path = Path(run_dir) / V6_OBSERVATIONS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    key = (
        row["trackingId"],
        row["horizon"],
        row["window"],
        row["status"],
        row.get("targetSourceHash"),
        row.get("benchmarkSourceHash"),
        row.get("calculationVersion"),
    )
    with FileLock(str(path) + ".lock"):
        for existing in _read_v6_observations_unlocked(run_dir):
            existing_key = (
                existing.get("trackingId"),
                existing.get("horizon"),
                existing.get("window"),
                existing.get("status"),
                existing.get("targetSourceHash"),
                existing.get("benchmarkSourceHash"),
                existing.get("calculationVersion"),
            )
            if existing_key == key:
                if existing != row:
                    raise ValueError("V6 outcome observation is immutable")
                return False
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return True


def _source_hash(rows: list[dict[str, Any]]) -> str:
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _entry_and_first_trigger(
    plan: Mapping[str, Any],
    rows: list[dict[str, Any]],
    *,
    direction: str,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    # A positive plan confirms first, then enters only on a later-day pullback
    # into the declared range.  This is a simulated rule, never an immediate
    # fill at the confirmation high.
    confirmation = _number(plan.get("buy_high")) or _number(plan.get("reference_buy_high"))
    pullback_low = _number(plan.get("pullback_low")) or _number(plan.get("pullback_buy_low"))
    pullback_high = _number(plan.get("pullback_high")) or _number(plan.get("pullback_buy_high"))
    stop = _number(plan.get("stop_loss")) or _number(plan.get("invalidation_price"))
    first_take = _number(plan.get("first_take_profit"))
    second_take = _number(plan.get("second_take_profit"))
    confirmed_date: str | None = None
    entry: dict[str, Any] | None = None
    first_trigger: dict[str, Any] | None = None
    for row in rows:
        high = row.get("high")
        low = row.get("low")
        confirmation_hit = confirmation is not None and high is not None and high >= confirmation
        pullback_hit = (
            pullback_low is not None
            and pullback_high is not None
            and low is not None
            and high is not None
            and low <= pullback_high
            and high >= pullback_low
        )
        stop_hit = stop is not None and low is not None and low <= stop
        take_hit = first_take is not None and high is not None and high >= first_take
        second_hit = second_take is not None and high is not None and high >= second_take
        if entry is None:
            if confirmed_date is None and confirmation_hit:
                confirmed_date = row["date"]
                if pullback_hit:
                    return None, {
                        "type": "ambiguous_same_bar",
                        "date": row["date"],
                        "conservativeRule": "同日同时确认并回踩，无法确认先后，按未入场处理",
                        "daily_bar_proxy": True,
                    }
                continue
            if confirmed_date is not None and row["date"] > confirmed_date and pullback_hit:
                conservative_price = pullback_high
                entry = {
                    "date": row["date"],
                    "price": conservative_price,
                    "status": "entered",
                    "method": "confirmed_then_next_day_pullback_high",
                    "daily_bar_proxy": True,
                }
                if stop_hit and (take_hit or second_hit):
                    first_trigger = {
                        "type": "ambiguous_same_bar",
                        "date": row["date"],
                        "conservativeRule": "入场日同时触发止损与止盈，按止损先触发处理",
                        "daily_bar_proxy": True,
                    }
                elif stop_hit:
                    first_trigger = {"type": "stop_loss", "date": row["date"], "daily_bar_proxy": True}
                elif take_hit:
                    first_trigger = {"type": "first_take_profit", "date": row["date"], "daily_bar_proxy": True}
                elif second_hit:
                    first_trigger = {"type": "second_take_profit", "date": row["date"], "daily_bar_proxy": True}
                continue
            if confirmation_hit and stop_hit:
                entry = {
                    "date": row["date"],
                    "price": None,
                    "status": "ambiguous_same_bar",
                    "daily_bar_proxy": True,
                }
                first_trigger = {
                    "type": "ambiguous_same_bar",
                    "date": row["date"],
                    "conservativeRule": "确认日同时触发止损，按未入场处理",
                    "daily_bar_proxy": True,
                }
                break
        if entry is not None and first_trigger is None:
            if stop_hit and (take_hit or second_hit):
                first_trigger = {
                    "type": "ambiguous_same_bar",
                    "date": row["date"],
                    "conservativeRule": "同日同时触发止损与止盈，按止损先触发处理",
                    "daily_bar_proxy": True,
                }
            elif stop_hit:
                first_trigger = {"type": "stop_loss", "date": row["date"], "daily_bar_proxy": True}
            elif take_hit:
                first_trigger = {"type": "first_take_profit", "date": row["date"], "daily_bar_proxy": True}
            elif second_hit:
                first_trigger = {"type": "second_take_profit", "date": row["date"], "daily_bar_proxy": True}
    return entry, first_trigger


def calculate_v6_observations(
    snapshot: Mapping[str, Any],
    target_bars: Iterable[Any],
    benchmark_bars: Iterable[Any],
    *,
    windows: Iterable[int] = V6_WINDOWS,
    calculated_at: str | None = None,
) -> list[dict[str, Any]]:
    """Calculate mature/pending horizon observations from daily bars."""
    target = _normalized_bars(target_bars)
    benchmark = _normalized_bars(benchmark_bars)
    report_date = _date(snapshot.get("reportAsOf") or snapshot.get("marketAsOf"))
    target = [row for row in target if report_date is None or row["date"] > report_date]
    benchmark = [row for row in benchmark if report_date is None or row["date"] > report_date]
    target_by_date = {row["date"]: row for row in target}
    benchmark_by_date = {row["date"]: row for row in benchmark}
    target_source_hash = _source_hash(target)
    benchmark_source_hash = _source_hash(benchmark)
    frozen_benchmark_price = _number(snapshot.get("benchmarkPrice"))
    rows: list[dict[str, Any]] = []
    calculated_at = calculated_at or datetime.now().astimezone().isoformat()
    for horizon, decision in (snapshot.get("horizons") or {}).items():
        if not isinstance(decision, Mapping):
            continue
        plan = decision.get("materializedPlan")
        reference_price = _number(decision.get("referencePrice"))
        benchmark_price = frozen_benchmark_price or _number(decision.get("benchmarkPrice"))
        for window in windows:
            window = int(window)
            benchmark_dates = sorted(benchmark_by_date)
            dates = benchmark_dates[:window]
            benchmark_window_ready = len(dates) >= window
            target_window_ready = benchmark_window_ready and all(
                date in target_by_date for date in dates
            )
            mature = (
                benchmark_window_ready
                and target_window_ready
                and reference_price is not None
                and reference_price > 0
            )
            base = {
                "trackingId": snapshot.get("trackingId"),
                "reportId": snapshot.get("reportId"),
                "workflowRunId": snapshot.get("workflowRunId"),
                "instrumentId": f"{(snapshot.get('instrument') or {}).get('exchange')}:{(snapshot.get('instrument') or {}).get('symbol')}",
                "horizon": horizon,
                "window": window,
                "direction": decision.get("direction"),
                "action": decision.get("action"),
                "researchStatus": decision.get("researchStatus"),
                "tradeStatus": decision.get("tradeStatus"),
                "referencePrice": reference_price,
                "benchmarkPrice": benchmark_price,
                "quantPromotion": decision.get("quantPromotion"),
                "targetSourceHash": target_source_hash,
                "benchmarkSourceHash": benchmark_source_hash,
                "benchmark": dict(snapshot.get("benchmark") or V6_BENCHMARK),
                "benchmarkBasis": "frozen_report_time_price",
                "status": "available" if mature else "pending",
                "directionHit": None,
                "actionHit": None,
                "pendingReason": (
                    None
                    if mature
                    else "window_not_mature"
                    if not benchmark_window_ready
                    else "target_bar_missing"
                ),
                "dataProxyLabels": ["daily_bar_proxy"],
                "calculationMethod": "v6-daily-bar-outcome-v1",
                "calculationVersion": "v6-daily-bar-outcome-v1",
                "calculatedAt": calculated_at,
            }
            if not mature:
                rows.append(base)
                continue
            target_rows = [target_by_date[date] for date in dates]
            benchmark_rows = [benchmark_by_date[date] for date in dates]
            final_target = target_rows[-1]["close"]
            final_benchmark = benchmark_rows[-1]["close"]
            target_return = final_target / reference_price - 1.0
            benchmark_return = (
                final_benchmark / benchmark_price - 1.0
                if benchmark_price is not None and benchmark_price > 0
                else None
            )
            highs = [row["high"] for row in target_rows]
            lows = [row["low"] for row in target_rows]
            base.update(
                {
                    "observationStartDate": dates[0],
                    "exitDate": dates[-1],
                    "directionReturnPct": round(target_return * 100, 6),
                    "benchmarkReturnPct": round(benchmark_return * 100, 6) if benchmark_return is not None else None,
                    "relativeReturnPct": round((target_return - benchmark_return) * 100, 6) if benchmark_return is not None else None,
                    "directionHit": (
                        target_return > 0 if decision.get("direction") == "positive"
                        else target_return < 0 if decision.get("direction") in {"negative", "avoid"}
                        else None
                    ),
                    "directionMfePct": round((max(highs) / reference_price - 1.0) * 100, 6),
                    "directionMaePct": round((min(lows) / reference_price - 1.0) * 100, 6),
                    "mfePct": round((max(highs) / reference_price - 1.0) * 100, 6),
                    "maePct": round((min(lows) / reference_price - 1.0) * 100, 6),
                }
            )
            if isinstance(plan, Mapping):
                direction = str(decision.get("direction"))
                sim_trade = direction == "positive" and decision.get("action") == "conditional_participation"
                entry, trigger = (
                    _entry_and_first_trigger(plan, target_rows, direction=direction)
                    if sim_trade
                    else (None, None)
                )
                if direction == "neutral":
                    confirmation = _number(plan.get("confirmation_price"))
                    invalidation = _number(plan.get("invalidation_price"))
                    for bar in target_rows:
                        high = bar.get("high")
                        low = bar.get("low")
                        confirmed = confirmation is not None and high is not None and high >= confirmation
                        invalidated = invalidation is not None and low is not None and low <= invalidation
                        if confirmed or invalidated:
                            trigger = {
                                "type": "ambiguous_same_bar" if confirmed and invalidated else "confirmation" if confirmed else "invalidation",
                                "date": bar["date"],
                                "daily_bar_proxy": True,
                            }
                            break
                base["tradeEntry"] = entry
                base["firstTrigger"] = trigger
                base["tradeStatus"] = "entered" if entry and entry.get("status") == "entered" else "not_entered" if sim_trade else "not_applicable"
                base["actionHit"] = (
                    base["tradeStatus"] == "entered"
                    if sim_trade
                    else None
                )
                base["dailyBarProxy"] = bool(sim_trade or trigger)
                if entry is not None and entry.get("status") == "entered":
                    base["entryDate"] = entry.get("date")
                entry_date = entry.get("date") if entry else None
                trade_rows = [row for row in target_rows if entry_date is not None and row["date"] >= entry_date]
                trade_entry_price = _number(entry.get("price")) if entry else None
                if trade_entry_price is not None and trade_rows and entry.get("status") == "entered":
                    trade_final = trade_rows[-1]["close"]
                    trade_return = trade_final / trade_entry_price - 1.0
                    trade_highs = [row["high"] for row in trade_rows]
                    trade_lows = [row["low"] for row in trade_rows]
                    base["tradeReturnPct"] = round(trade_return * 100, 6)
                    base["tradeMfePct"] = round((max(trade_highs) / trade_entry_price - 1.0) * 100, 6)
                    base["tradeMaePct"] = round((min(trade_lows) / trade_entry_price - 1.0) * 100, 6)
                    stop = _number(plan.get("stop_loss"))
                    risk = (trade_entry_price - stop) / trade_entry_price if stop is not None and stop < trade_entry_price else None
                    base["grossR"] = round(trade_return / risk, 6) if risk and risk > 0 else None
                    execution = plan.get("execution") if isinstance(plan.get("execution"), Mapping) else {}
                    slippage = _number(execution.get("estimated_slippage_pct")) or 0.0
                    costs = plan.get("cost_assumptions") if isinstance(plan.get("cost_assumptions"), Mapping) else {}
                    commission = _number(costs.get("commission_pct"))
                    transfer = _number(costs.get("transfer_fee_pct"))
                    stamp = _number(costs.get("stamp_tax_pct"))
                    if commission is None or transfer is None or stamp is None:
                        base["afterCostR"] = None
                        base["afterCostRReason"] = "缺少冻结成本参数，暂不计算成本后R"
                        base["afterCostRMethod"] = None
                        rows.append(base)
                        continue
                    buy_cost = commission + transfer + slippage
                    sell_cost = commission + transfer + stamp + slippage
                    effective_entry = trade_entry_price * (1 + buy_cost / 100)
                    effective_exit = trade_final * (1 - sell_cost / 100)
                    effective_stop = stop * (1 - sell_cost / 100) if stop is not None else None
                    after_cost_risk = (
                        (effective_entry - effective_stop) / effective_entry
                        if effective_stop is not None and effective_stop < effective_entry
                        else None
                    )
                    after_cost_return = effective_exit / effective_entry - 1.0
                    base["afterCostR"] = round(after_cost_return / after_cost_risk, 6) if after_cost_risk and after_cost_risk > 0 else None
                    base["afterCostRMethod"] = costs.get("method_version") or "unknown"
                else:
                    base["tradeReturnPct"] = None
                    base["tradeMfePct"] = None
                    base["tradeMaePct"] = None
                    base["grossR"] = None
                    base["afterCostR"] = None
                    base["afterCostRReason"] = "入场条件尚未触发，暂不计算交易收益"
            else:
                base["tradeStatus"] = "research_only"
                base["tradeEntry"] = None
                base["firstTrigger"] = None
                base["dailyBarProxy"] = False
            rows.append(base)
    return rows


def latest_v6_observations(run_dir: str | Path, tracking_id: str | None = None) -> list[dict[str, Any]]:
    latest: dict[tuple[str, int], dict[str, Any]] = {}
    for row in read_v6_observations(run_dir, tracking_id):
        try:
            key = (str(row["horizon"]), int(row["window"]))
        except (KeyError, TypeError, ValueError):
            continue
        latest[key] = row
    return sorted(latest.values(), key=lambda row: (row["horizon"], int(row["window"])))


def aggregate_v6_observations(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    values = [dict(row) for row in rows if isinstance(row, Mapping)]
    mature = [row for row in values if row.get("status") == "available"]
    def summary(items: list[dict[str, Any]]) -> dict[str, Any]:
        returns = [
            float(row["directionReturnPct"])
            for row in items
            if _number(row.get("directionReturnPct")) is not None
        ]
        relative = [
            float(row["relativeReturnPct"])
            for row in items
            if _number(row.get("relativeReturnPct")) is not None
        ]
        direction_hits = [row["directionHit"] for row in items if isinstance(row.get("directionHit"), bool)]
        action_hits = [row["actionHit"] for row in items if isinstance(row.get("actionHit"), bool)]
        windows = sorted({int(row["window"]) for row in items if str(row.get("window", "")).isdigit()})
        return {
            "sampleCount": len(items),
            "matureCount": len(items),
            "windows": windows,
            "meanDirectionReturnPct": round(sum(returns) / len(returns), 6) if returns else None,
            "meanRelativeReturnPct": round(sum(relative) / len(relative), 6) if relative else None,
            "directionHitRatePct": round(sum(direction_hits) / len(direction_hits) * 100, 6) if direction_hits else None,
            "actionHitRatePct": round(sum(action_hits) / len(action_hits) * 100, 6) if action_hits else None,
        }

    by_horizon = {
        horizon: summary([row for row in mature if row.get("horizon") == horizon])
        for horizon in ("short_term", "medium_term", "long_term")
    }
    aggregate = summary(mature)
    return {
        "sampleCount": len(values),
        "matureCount": len(mature),
        "windows": aggregate["windows"],
        "meanDirectionReturnPct": aggregate["meanDirectionReturnPct"],
        "meanRelativeReturnPct": aggregate["meanRelativeReturnPct"],
        "directionHitRatePct": aggregate["directionHitRatePct"],
        "actionHitRatePct": aggregate["actionHitRatePct"],
        "byHorizon": by_horizon,
    }
