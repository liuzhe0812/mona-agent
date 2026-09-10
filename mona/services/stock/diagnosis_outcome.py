"""Read-only price-path evaluation for one standard AI diagnosis report."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from mona.services.stock.provenance import parse_asia_datetime
from mona.services.stock.v6_tracking import calculate_v6_observations

DIAGNOSIS_OUTCOME_VERSION = "diagnosis-single-stock-outcome-v1"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _date(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = parse_asia_datetime(value)
    return parsed.date().isoformat() if parsed is not None else value[:10]


def _bar_value(bar: Any, name: str) -> Any:
    return bar.get(name) if isinstance(bar, Mapping) else getattr(bar, name, None)


def _bar_dates(bars: Iterable[Any], *, after: str | None) -> set[str]:
    result: set[str] = set()
    for bar in bars or []:
        date = _date(_bar_value(bar, "date") or _bar_value(bar, "as_of"))
        close = _number(_bar_value(bar, "close"))
        if date is not None and close is not None and close > 0 and (after is None or date > after):
            result.add(date)
    return result


def _normalized_bars(bars: Iterable[Any], *, after: str | None) -> dict[str, dict[str, float | str]]:
    result: dict[str, dict[str, float | str]] = {}
    for bar in bars or []:
        date = _date(_bar_value(bar, "date") or _bar_value(bar, "as_of"))
        close = _number(_bar_value(bar, "close"))
        if date is None or close is None or close <= 0 or (after is not None and date <= after):
            continue
        result[date] = {
            "date": date,
            "high": _number(_bar_value(bar, "high")) or close,
            "low": _number(_bar_value(bar, "low")) or close,
            "close": close,
        }
    return result


def _plan(report: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    radar = report.get("decision_radar")
    decision = radar.get("current_decision") if isinstance(radar, Mapping) else None
    if not isinstance(decision, Mapping):
        decisions = report.get("horizon_decisions")
        decision = decisions.get("short_term") if isinstance(decisions, Mapping) else None
    decision = decision if isinstance(decision, Mapping) else {}
    plan = decision.get("materialized_plan")
    return decision, plan if isinstance(plan, Mapping) else {}


def build_diagnosis_tracking_snapshot(report: Mapping[str, Any]) -> dict[str, Any] | None:
    if report.get("kind") != "ai_diagnosis" or report.get("schema_version") != 1:
        return None
    diagnosis_id = report.get("diagnosis_id")
    instrument = report.get("instrument")
    reference_price = _number(report.get("current_price"))
    if not isinstance(diagnosis_id, str) or not isinstance(instrument, Mapping) or reference_price is None:
        return None
    decision, plan = _plan(report)
    quant = report.get("quant_factors")
    short_quant = quant.get("short_term") if isinstance(quant, Mapping) else None
    window = short_quant.get("target_window_sessions") if isinstance(short_quant, Mapping) else None
    if isinstance(window, bool) or not isinstance(window, int) or window <= 0:
        window = 10
    buy_low = _number(plan.get("reference_entry_low")) or _number(plan.get("reference_entry"))
    buy_high = _number(plan.get("reference_entry_high")) or _number(plan.get("reference_entry"))
    pullback_low = _number(plan.get("pullback_entry_low")) or _number(plan.get("pullback_entry"))
    pullback_high = _number(plan.get("pullback_entry_high")) or _number(plan.get("pullback_entry"))
    plan_snapshot = {
        "buy_low": buy_low,
        "buy_high": buy_high,
        "pullback_low": pullback_low,
        "pullback_high": pullback_high,
        "stop_loss": _number(plan.get("stop_loss")),
        "first_take_profit": _number(plan.get("first_take_profit")),
        "second_take_profit": _number(plan.get("second_take_profit")),
        "entry_condition_status": plan.get("entry_condition_status"),
    }
    tracking_id = "stock_diagnosis_outcome_" + hashlib.sha256(
        diagnosis_id.encode("utf-8")
    ).hexdigest()[:24]
    radar = report.get("decision_radar")
    holding_state = (
        radar.get("holding_state", "not_holding")
        if isinstance(radar, Mapping)
        else "not_holding"
    )
    selected_action = (
        decision.get("holding_action")
        if holding_state == "holding"
        else decision.get("not_holding_action") or decision.get("action")
    )
    return {
        "schemaVersion": 1,
        "trackingId": tracking_id,
        "reportId": diagnosis_id,
        "workflowRunId": diagnosis_id,
        "instrument": dict(instrument),
        "reportAsOf": report.get("market_as_of") or report.get("research_cutoff_at"),
        "marketAsOf": report.get("market_as_of"),
        "holdingState": holding_state,
        "horizons": {
            "short_term": {
                "direction": decision.get("direction"),
                "action": selected_action,
                "materializedPlan": plan_snapshot,
                "validUntil": decision.get("valid_until"),
                "referencePrice": reference_price,
                "benchmarkPrice": None,
                "sourceIds": list(decision.get("source_ids") or []),
            }
        },
        "windowSessions": window,
        "methodVersions": {
            **dict(report.get("method_versions") or {}),
            "singleStockOutcome": DIAGNOSIS_OUTCOME_VERSION,
        },
        "sourceIds": list(report.get("source_ids") or []),
        "priceSourceIds": list(report.get("price_source_ids") or []),
    }


def _outcome_label(row: Mapping[str, Any], holding_state: str) -> str:
    if row.get("status") != "available":
        return "诊股结果跟踪中"
    trigger = row.get("firstTrigger")
    trigger_type = trigger.get("type") if isinstance(trigger, Mapping) else None
    if trigger_type == "ambiguous_same_bar":
        return "同日触发顺序不确定，本次不计入命中"
    if trigger_type == "stop_loss":
        return "参与后触发止损" if holding_state != "holding" else "持仓触发止损"
    if trigger_type == "second_take_profit":
        return "达到第二止盈"
    if trigger_type == "first_take_profit":
        return "达到第一止盈"
    if row.get("tradeStatus") == "not_entered":
        return "观察期内未触发参与"
    if row.get("tradeStatus") == "entered":
        return "已触发参与，计划仍在跟踪"
    direction_hit = row.get("directionHit")
    if isinstance(direction_hit, bool):
        return "方向判断得到验证" if direction_hit else "方向判断未得到验证"
    return "观察期已结束"


def _holding_first_trigger(
    report: Mapping[str, Any], target_bars: Iterable[Any], benchmark_bars: Iterable[Any], window: int
) -> dict[str, Any] | None:
    _decision, plan = _plan(report)
    stop = _number(plan.get("stop_loss"))
    first_take = _number(plan.get("first_take_profit"))
    second_take = _number(plan.get("second_take_profit"))
    report_date = _date(report.get("market_as_of") or report.get("research_cutoff_at"))
    targets = _normalized_bars(target_bars, after=report_date)
    benchmark_dates = sorted(_bar_dates(benchmark_bars, after=report_date))[:window]
    for date in benchmark_dates:
        bar = targets.get(date)
        if bar is None:
            continue
        low = _number(bar.get("low"))
        high = _number(bar.get("high"))
        stop_hit = stop is not None and low is not None and low <= stop
        first_hit = first_take is not None and high is not None and high >= first_take
        second_hit = second_take is not None and high is not None and high >= second_take
        if stop_hit and (first_hit or second_hit):
            return {
                "type": "ambiguous_same_bar",
                "date": date,
                "conservativeRule": "持仓同日同时触发止损与止盈，无法确认先后，本次不计入命中",
            }
        if stop_hit:
            return {"type": "stop_loss", "date": date}
        if first_hit:
            return {"type": "first_take_profit", "date": date}
        if second_hit:
            return {"type": "second_take_profit", "date": date}
    return None


def calculate_diagnosis_outcome(
    report: Mapping[str, Any],
    target_bars: Iterable[Any],
    benchmark_bars: Iterable[Any],
    *,
    calculated_at: str | None = None,
) -> dict[str, Any] | None:
    snapshot = build_diagnosis_tracking_snapshot(report)
    if snapshot is None:
        return None
    window = int(snapshot["windowSessions"])
    target_rows = list(target_bars or [])
    benchmark_rows = list(benchmark_bars or [])
    observations = calculate_v6_observations(
        snapshot,
        target_rows,
        benchmark_rows,
        windows=(window,),
        calculated_at=calculated_at,
    )
    if not observations:
        return None
    row = observations[0]
    report_date = _date(snapshot.get("reportAsOf"))
    observed_sessions = min(
        window,
        len(
            _bar_dates(target_rows, after=report_date)
            & _bar_dates(benchmark_rows, after=report_date)
        ),
    )
    holding_state = str(snapshot.get("holdingState") or "not_holding")
    if holding_state == "holding" and row.get("status") == "available":
        holding_trigger = _holding_first_trigger(
            report, target_rows, benchmark_rows, window
        )
        if holding_trigger is not None:
            row["firstTrigger"] = holding_trigger
    trigger = row.get("firstTrigger") if isinstance(row.get("firstTrigger"), Mapping) else None
    entry = row.get("tradeEntry") if isinstance(row.get("tradeEntry"), Mapping) else None
    return {
        "schemaVersion": 1,
        "diagnosisId": snapshot["reportId"],
        "trackingId": snapshot["trackingId"],
        "status": row.get("status"),
        "outcomeLabel": _outcome_label(row, holding_state),
        "windowSessions": window,
        "observedSessions": observed_sessions,
        "reportAsOf": snapshot.get("reportAsOf"),
        "observationStartDate": row.get("observationStartDate"),
        "exitDate": row.get("exitDate"),
        "referencePrice": row.get("referencePrice"),
        "direction": row.get("direction"),
        "action": row.get("action"),
        "directionReturnPct": row.get("directionReturnPct"),
        "directionMfePct": row.get("directionMfePct"),
        "directionMaePct": row.get("directionMaePct"),
        "directionHit": row.get("directionHit"),
        "tradeStatus": row.get("tradeStatus"),
        "entryDate": row.get("entryDate"),
        "entryPrice": entry.get("price") if entry else None,
        "firstTriggerType": trigger.get("type") if trigger else None,
        "firstTriggerDate": trigger.get("date") if trigger else None,
        "conservativeRule": trigger.get("conservativeRule") if trigger else None,
        "tradeReturnPct": row.get("tradeReturnPct"),
        "tradeMfePct": row.get("tradeMfePct"),
        "tradeMaePct": row.get("tradeMaePct"),
        "calculatedAt": row.get("calculatedAt"),
        "calculationVersion": DIAGNOSIS_OUTCOME_VERSION,
        "dailyBarProxy": row.get("dailyBarProxy", False),
    }


__all__ = [
    "DIAGNOSIS_OUTCOME_VERSION",
    "build_diagnosis_tracking_snapshot",
    "calculate_diagnosis_outcome",
]
