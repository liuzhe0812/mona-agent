"""Deterministic market sentiment and optional public-opinion contracts.

This module consumes an already-built Evidence bundle.  It deliberately has
no network client: the market state is derived from point-in-time breadth,
benchmark returns and turnover presence; public opinion is accepted only from
an explicitly supplied local aggregate snapshot.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from mona.services.stock.provenance import normalize_asia_datetime

MARKET_SENTIMENT_VERSION = "market-sentiment-v1"
PUBLIC_OPINION_VERSION = "public-opinion-v1"
_BREADTH_POSITIVE = 0.55
_BREADTH_NEGATIVE = 0.45
_RETURN_THRESHOLDS = {5: 0.5, 20: 1.5}
_DIRECTION_LABELS = {1: "偏多", -1: "偏空", 0: "震荡"}
_PUBLIC_OPINION_LABELS = {
    "positive": "偏多",
    "bullish": "偏多",
    "偏多": "偏多",
    "negative": "偏空",
    "bearish": "偏空",
    "偏空": "偏空",
    "neutral": "震荡",
    "mixed": "分歧",
    "divergent": "分歧",
    "震荡": "震荡",
    "分歧": "分歧",
}


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _source_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, Iterable) or isinstance(value, (bytes, bytearray)):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})


def _known_sources(ids: Iterable[str], known_source_ids: set[str] | None) -> tuple[list[str], list[str]]:
    values = sorted(set(ids))
    if known_source_ids is None:
        return values, []
    return [item for item in values if item in known_source_ids], [
        item for item in values if item not in known_source_ids
    ]


def _time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    normalized = normalize_asia_datetime(value)
    if normalized is None:
        return None
    from mona.services.stock.provenance import parse_asia_datetime

    return parse_asia_datetime(normalized)


def _status_is_usable(status: Any) -> bool:
    return str(status or "").strip().lower() in {"available", "degraded"}


def _signal_direction(value: float, threshold: float) -> int:
    if value >= threshold:
        return 1
    if value <= -threshold:
        return -1
    return 0


def _signal_time(section: Mapping[str, Any], *, fallback: Any = None) -> Any:
    return (
        section.get("observed_at")
        or section.get("market_as_of")
        or section.get("as_of")
        or fallback
    )


def _valid_input_time(
    value: Any,
    cutoff: datetime | None,
    *,
    signal: str,
    excluded_future: list[dict[str, Any]],
) -> bool:
    observed = _time(value)
    if observed is None or cutoff is None:
        return observed is not None
    if observed > cutoff:
        excluded_future.append(
            {
                "section": "market_sentiment",
                "field": f"{signal}.observed_at",
                "value": normalize_asia_datetime(value),
                "reason": "after_research_cutoff",
            }
        )
        return False
    return True


def build_market_sentiment(
    *,
    market_regime: Mapping[str, Any] | None,
    relative_benchmarks: Mapping[str, Any] | None,
    research_cutoff_at: Any = None,
    known_source_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Build a point-in-time market direction without reading news.

    The two benchmark windows are separate horizon signals.  Two agreeing
    directional signals are required for a strong direction.  A single signal
    is retained as a weak reference only and cannot become a market direction.
    """
    regime = _as_mapping(market_regime)
    benchmarks = _as_mapping(relative_benchmarks)
    cutoff = _time(research_cutoff_at)
    known = set(known_source_ids) if known_source_ids is not None else None
    excluded_future: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []
    unknown_source_ids: set[str] = set()

    def append_signal(
        name: str,
        label: str,
        value: float | None,
        unit: str,
        direction: int | None,
        observed_at: Any,
        source_ids: Iterable[str],
        *,
        usable: bool,
        reason: str | None = None,
    ) -> None:
        ids, unknown = _known_sources(source_ids, known)
        unknown_source_ids.update(unknown)
        if unknown:
            usable = False
            reason = "来源未进入本次证据包"
        if observed_at is None:
            usable = False
            reason = reason or "缺少可核验时点"
        elif not _valid_input_time(
            observed_at,
            cutoff,
            signal=name,
            excluded_future=excluded_future,
        ):
            usable = False
            reason = "超过研究截止时间"
        signals.append(
            {
                "name": name,
                "label": label,
                "value": value,
                "unit": unit,
                "direction": _DIRECTION_LABELS.get(direction) if direction is not None else None,
                "direction_code": direction,
                "observed_at": normalize_asia_datetime(observed_at),
                "source_ids": ids,
                "usable": bool(usable and bool(ids)),
                "reason": reason if not (usable and ids) else None,
            }
        )

    breadth = _as_mapping(regime.get("breadth"))
    breadth_ratio = _number(breadth.get("advance_ratio"))
    breadth_observed = _signal_time(regime)
    breadth_ids = _source_ids(regime.get("source_ids"))
    breadth_available = (
        _status_is_usable(regime.get("status"))
        and breadth_ratio is not None
        and 0 <= breadth_ratio <= 1
        and _number(regime.get("available_change_count")) is not None
        and _number(regime.get("available_change_count")) >= 2
    )
    breadth_direction = (
        1
        if breadth_ratio is not None and breadth_ratio >= _BREADTH_POSITIVE
        else -1
        if breadth_ratio is not None and breadth_ratio <= _BREADTH_NEGATIVE
        else 0
        if breadth_ratio is not None
        else None
    )
    append_signal(
        "market_breadth",
        "全市场涨跌宽度",
        breadth_ratio,
        "上涨占比",
        breadth_direction,
        breadth_observed,
        breadth_ids,
        usable=breadth_available,
        reason="缺少完整的全市场涨跌宽度" if not breadth_available else None,
    )

    windows = benchmarks.get("windows")
    if not isinstance(windows, list):
        windows = []
    window_by_size = {
        int(item.get("window")): item
        for item in windows
        if isinstance(item, Mapping) and str(item.get("window", "")).isdigit()
    }
    benchmark_ids = _source_ids(benchmarks.get("source_ids"))
    for window in (5, 20):
        item = _as_mapping(window_by_size.get(window))
        value = _number(item.get("benchmark_return"))
        observed_at = _signal_time(item, fallback=benchmarks.get("market_as_of"))
        item_ids = _source_ids(item.get("source_ids")) or benchmark_ids
        threshold = _RETURN_THRESHOLDS[window]
        direction = _signal_direction(value, threshold) if value is not None else None
        append_signal(
            f"benchmark_{window}d_return",
            f"中证全指{window}日收益",
            value,
            "百分比",
            direction,
            observed_at,
            item_ids,
            usable=(
                _status_is_usable(item.get("status"))
                and value is not None
                and bool(item_ids)
            ),
            reason=f"缺少中证全指{window}日收益" if value is None else None,
        )

    turnover = _number(regime.get("turnover_amount"))
    turnover_observed = _signal_time(regime)
    append_signal(
        "market_turnover_amount",
        "全市场成交额",
        turnover,
        "成交额",
        None,
        turnover_observed,
        breadth_ids,
        usable=(
            _status_is_usable(regime.get("status"))
            and turnover is not None
            and turnover >= 0
        ),
        reason="仅作为覆盖度校验，不单独判断涨跌方向" if turnover is not None else "缺少全市场成交额",
    )

    usable_directional = [
        item for item in signals if item["usable"] and item["direction_code"] in {-1, 0, 1}
    ]
    directional = [item for item in usable_directional if item["direction_code"] in {-1, 1}]
    positive = sum(item["direction_code"] == 1 for item in directional)
    negative = sum(item["direction_code"] == -1 for item in directional)
    independent_source_ids = {
        source_id
        for item in usable_directional
        for source_id in item["source_ids"]
    }
    independent_source_count = len(independent_source_ids)
    all_full = all(
        item["usable"] and item["reason"] is None
        for item in signals
        if item["name"] != "market_turnover_amount" and item["value"] is not None
    )
    strong_eligible = len(usable_directional) >= 2 and independent_source_count >= 2
    if strong_eligible:
        if positive >= 2 and positive > negative:
            direction = "偏多"
        elif negative >= 2 and negative > positive:
            direction = "偏空"
        elif not directional:
            direction = "震荡"
        else:
            direction = "暂不判断"
        strong_direction = direction in {"偏多", "偏空", "震荡"} and (
            len(directional) >= 2 or not directional
        )
        strength = "strong" if strong_direction and all_full else "moderate" if strong_direction else "weak"
        status = "available" if strong_direction and all_full else "degraded"
    elif len(usable_directional) >= 2 and not directional:
        direction = "震荡"
        strength = "weak"
        status = "degraded"
    elif len(usable_directional) >= 2:
        direction = "暂不判断"
        strength = "weak"
        status = "degraded"
    elif len(directional) == 1:
        direction = "暂不判断"
        strength = "weak"
        status = "degraded"
    else:
        direction = "暂不判断"
        strength = "none"
        status = "missing"

    usable_names = [item["name"] for item in signals if item["usable"]]
    missing_names = [item["name"] for item in signals if not item["usable"]]
    source_ids = sorted({source_id for item in signals for source_id in item["source_ids"] if item["usable"]})
    result = {
        "status": status,
        "direction": direction,
        "label": direction,
        "strength": strength,
        "method": MARKET_SENTIMENT_VERSION,
        "algorithm_version": MARKET_SENTIMENT_VERSION,
        "basis": "全市场涨跌宽度与中证全指5日、20日收益共同判断；成交额只校验覆盖度",
        "signals": signals,
        "input_coverage": {
            "expected": [
                "market_breadth",
                "benchmark_5d_return",
                "benchmark_20d_return",
                "market_turnover_amount",
            ],
            "available": usable_names,
            "missing": missing_names,
            "available_count": len(usable_names),
            "directional_signal_count": len(directional),
            "independent_signal_count": len(usable_directional),
            "independent_source_count": independent_source_count,
        },
        "as_of": max((item["observed_at"] for item in signals if item["usable"] and item.get("observed_at")), default=None),
        "research_cutoff_at": normalize_asia_datetime(research_cutoff_at),
        "source_ids": source_ids,
        "source_closure": {
            "status": "closed" if not unknown_source_ids else "open",
            "unknown_source_ids": sorted(unknown_source_ids),
        },
        "excluded_future": excluded_future,
        "missing_fields": missing_names,
        "decision_impact": "新闻关键词不能单独改变本结论；本项仅作为市场环境参考",
    }
    if unknown_source_ids:
        result["status"] = "missing"
        result["direction"] = "暂不判断"
        result["label"] = "暂不判断"
        result["strength"] = "none"
    return result


def load_local_public_opinion_snapshot(path: str | Path | None) -> dict[str, Any] | None:
    """Read one explicitly configured local aggregate file; never performs I/O over network."""
    if path is None:
        return None
    candidate = Path(path)
    if not candidate.is_file():
        return None
    try:
        raw = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def build_public_opinion_state(
    *,
    snapshot: Mapping[str, Any] | None,
    research_cutoff_at: Any = None,
    known_source_ids: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Normalize a legal local aggregate; never derive direction from articles."""
    base = {
        "status": "unavailable",
        "direction": None,
        "label": "暂无公开舆论覆盖，本项不参与决策",
        "method": PUBLIC_OPINION_VERSION,
        "algorithm_version": PUBLIC_OPINION_VERSION,
        "source_ids": [],
        "source_closure": {"status": "closed", "unknown_source_ids": []},
        "as_of": None,
        "research_cutoff_at": normalize_asia_datetime(research_cutoff_at),
        "coverage_account_count": None,
        "redfox_index": None,
        "missing_fields": ["local_aggregate_snapshot"],
        "decision_impact": "暂无公开舆论覆盖，本项不参与决策",
    }
    if not isinstance(snapshot, Mapping):
        return base
    direction = _PUBLIC_OPINION_LABELS.get(str(snapshot.get("direction") or snapshot.get("stance") or "").strip().lower())
    observed_raw = (
        snapshot.get("as_of")
        or snapshot.get("observed_at")
        or snapshot.get("snapshot_at")
        or snapshot.get("published_at")
    )
    observed = _time(observed_raw)
    cutoff = _time(research_cutoff_at)
    source_ids = _source_ids(snapshot.get("source_ids") or snapshot.get("source_id"))
    ids, unknown = _known_sources(source_ids, set(known_source_ids) if known_source_ids is not None else None)
    if cutoff is not None and observed is not None and observed > cutoff:
        base["missing_fields"] = ["local_aggregate_snapshot_before_cutoff"]
        base["excluded_future"] = [
            {
                "section": "public_opinion",
                "field": "observed_at",
                "value": normalize_asia_datetime(observed_raw),
                "reason": "after_research_cutoff",
            }
        ]
        return base
    if direction is None or observed is None or not ids or unknown:
        base["source_ids"] = ids
        base["source_closure"] = {"status": "open" if unknown else "closed", "unknown_source_ids": unknown}
        base["missing_fields"] = [
            field
            for field, value in {
                "direction": direction,
                "observed_at": observed,
                "source_ids": ids,
            }.items()
            if not value
        ] or ["source_closure"]
        return base
    count = snapshot.get("coverage_account_count", snapshot.get("account_count"))
    if isinstance(count, bool):
        count = None
    try:
        count = int(count) if count is not None else None
    except (TypeError, ValueError):
        count = None
    index = _number(snapshot.get("redfox_index"))
    canonical = json.dumps(dict(snapshot), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {
        "status": "available",
        "direction": direction,
        "label": f"市场舆论风向：{direction}",
        "method": PUBLIC_OPINION_VERSION,
        "algorithm_version": PUBLIC_OPINION_VERSION,
        "source_ids": ids,
        "source_closure": {"status": "closed", "unknown_source_ids": []},
        "as_of": normalize_asia_datetime(observed_raw),
        "research_cutoff_at": normalize_asia_datetime(research_cutoff_at),
        "coverage_account_count": count,
        "redfox_index": index,
        "snapshot_content_hash": "sha256:" + hashlib.sha256(canonical).hexdigest(),
        "missing_fields": [],
        "decision_impact": "仅作为舆论环境参考，不单独决定个股方向、价格或仓位",
    }


__all__ = [
    "MARKET_SENTIMENT_VERSION",
    "PUBLIC_OPINION_VERSION",
    "build_market_sentiment",
    "build_public_opinion_state",
    "load_local_public_opinion_snapshot",
]
