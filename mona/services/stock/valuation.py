"""Deterministic, industry-aware valuation evidence for Stock Evidence V6.

The engine only reports reproducible valuation evidence.  It never asks an
LLM to choose a multiple, invent a target price, or treat a cumulative
financial report as a standalone quarter/TTM observation.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from mona.services.stock.provenance import parse_asia_datetime

VALUATION_SCHEMA_VERSION = 2
VALUATION_METHOD_VERSION = "valuation-method-selection-v2"
MIN_PEER_SAMPLE = 3
MIN_HISTORY_SAMPLE = 4

_FINANCIAL_MARKERS = ("银行", "保险", "证券", "金融", "信托", "期货")
_STABLE_CASHFLOW_MARKERS = (
    "公用事业", "电力", "水务", "燃气", "高速", "机场", "港口", "运营",
)
_CYCLICAL_MARKERS = (
    "钢铁", "煤炭", "有色", "石化", "化工", "航运", "建筑材料", "房地产", "建材",
)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _positive(value: Any) -> float | None:
    result = _number(value)
    return result if result is not None and result > 0 else None


def _source_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    return list(dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip()))


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        if name in value:
            return value[name]
        parts = name.split("_")
        return value.get(parts[0] + "".join(part.title() for part in parts[1:]), default)
    return getattr(value, name, default)


def _industry_family(industry: str) -> str:
    if any(marker in industry for marker in _FINANCIAL_MARKERS):
        return "financial"
    if any(marker in industry for marker in _STABLE_CASHFLOW_MARKERS):
        return "stable_cashflow"
    if any(marker in industry for marker in _CYCLICAL_MARKERS):
        return "cyclical"
    return "general"


def is_policy_sensitive_industry(industry: str | None) -> bool:
    """Return whether policy evidence is a medium-term hard gate."""
    value = str(industry or "")
    return any(
        marker in value
        for marker in (*_FINANCIAL_MARKERS, "房地产", "半导体", "军工", "电力", "通信", "互联网")
    )


def _quantile(values: list[float], probability: float) -> float:
    if not values:
        raise ValueError("quantile requires values")
    if len(values) == 1:
        return values[0]
    position = (len(values) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return values[lower]
    weight = position - lower
    return values[lower] + (values[upper] - values[lower]) * weight


def _robust_summary(values: list[float]) -> dict[str, Any] | None:
    """Use Tukey fences and quartiles, never raw min/max, for a peer range."""
    usable = sorted(value for value in values if _number(value) is not None)
    if len(usable) < MIN_PEER_SAMPLE:
        return None
    kept = usable
    if len(usable) >= 4:
        q1_all = _quantile(usable, 0.25)
        q3_all = _quantile(usable, 0.75)
        spread = q3_all - q1_all
        lower = q1_all - 1.5 * spread
        upper = q3_all + 1.5 * spread
        candidate = [value for value in usable if lower <= value <= upper]
        if len(candidate) >= MIN_PEER_SAMPLE:
            kept = candidate
    q1 = _quantile(kept, 0.25)
    median = _quantile(kept, 0.5)
    q3 = _quantile(kept, 0.75)
    return {
        "sample_count": len(usable),
        "used_sample_count": len(kept),
        "outlier_count": len(usable) - len(kept),
        "values": kept,
        "q1": q1,
        "median": median,
        "q3": q3,
        "low": q1,
        "high": q3,
    }


def _position(value: float | None, summary: dict[str, Any] | None) -> dict[str, Any]:
    if value is None or summary is None:
        return {"view": "暂不判断", "code": "undetermined", "percentile": None}
    values = summary["values"]
    less = sum(item < value for item in values)
    equal = sum(item == value for item in values)
    percentile = (less + equal / 2) / len(values)
    if percentile <= 1 / 3:
        view, code = "低估", "undervalued"
    elif percentile >= 2 / 3:
        view, code = "高估", "overvalued"
    else:
        view, code = "合理", "fair"
    return {
        "view": view,
        "code": code,
        "percentile": percentile,
        "percentile_method": "稳健样本中位秩分位",
    }


def _range(summary: dict[str, Any] | None) -> dict[str, float] | None:
    if summary is None:
        return None
    return {"low": summary["low"], "high": summary["high"]}


def _method(
    *,
    method_id: str,
    method: str,
    version: str,
    as_of: str,
    source_ids: list[str],
    required: list[str],
    available: list[str],
    inputs: dict[str, Any],
    unit: str,
    status: str,
    reference_range: dict[str, float] | None = None,
    result: float | None = None,
    summary: dict[str, Any] | None = None,
    relative: dict[str, Any] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    if status == "available" and not source_ids:
        status = "unavailable"
        reason = reason or "缺少可追溯来源"
    missing = [item for item in required if item not in available]
    output: dict[str, Any] = {
        "id": method_id,
        "status": status,
        "method": method,
        "version": version,
        "as_of": as_of,
        "source_ids": list(dict.fromkeys(source_ids)),
        "unit": unit,
        "inputs": inputs,
        "input_completeness": {
            "required": required,
            "available": available,
            "missing": missing,
        },
    }
    if result is not None and _number(result) is not None:
        output["result"] = result
    if summary is not None:
        output["summary"] = {
            key: summary[key]
            for key in (
                "sample_count", "used_sample_count", "outlier_count", "q1", "median", "q3", "low", "high",
            )
            if key in summary
        }
    if reference_range is not None:
        output["reference_range"] = reference_range
    if relative is not None:
        output["relative_position"] = relative
    if reason:
        output["reason"] = reason
    return output


def _peer_values(valuation_context: Mapping[str, Any] | None, key: str) -> list[float]:
    if not isinstance(valuation_context, Mapping):
        return []
    values = valuation_context.get("peer_values")
    if isinstance(values, Mapping):
        values = values.get(key)
    if not isinstance(values, (list, tuple)):
        return []
    return [number for value in values if (number := _positive(value)) is not None]


def _history_rows(bundle: Mapping[str, Any], cutoff) -> list[tuple[Mapping[str, Any], str, list[str]]]:
    result: list[tuple[Mapping[str, Any], str, list[str]]] = []
    for row in bundle.get("fundamentals_history") or []:
        if not isinstance(row, Mapping):
            continue
        published = parse_asia_datetime(row.get("published_at"))
        if published is None or (cutoff is not None and published > cutoff):
            continue
        source_ids = _source_ids(row.get("source_ids"))
        if not source_ids:
            continue
        result.append((row, published.isoformat(), source_ids))
    return result


def _period_basis(row: Mapping[str, Any], metrics: Mapping[str, Any]) -> str:
    raw = row.get("period_basis") or row.get("period_type") or metrics.get("period_basis") or metrics.get("period_type")
    if isinstance(row.get("is_cumulative"), bool):
        return "cumulative" if row["is_cumulative"] else "single_period"
    value = str(raw or "").strip().lower()
    if any(token in value for token in ("cumulative", "累计", "ytd", "ttm", "year_to_date")):
        return "cumulative"
    if any(token in value for token in ("single", "quarter", "standalone", "point_in_time", "point-in-time", "单期", "单季")):
        return "single_period"
    return "unknown"


def _point_in_time_rows(history: list[tuple[Mapping[str, Any], str, list[str]]]) -> list[tuple[Mapping[str, Any], str, list[str]]]:
    return [
        entry
        for entry in history
        if _period_basis(entry[0], entry[0].get("metrics") if isinstance(entry[0].get("metrics"), Mapping) else {}) == "single_period"
    ]


def _cashflow_value(metrics: Mapping[str, Any]) -> tuple[float | None, str | None]:
    if _period_basis({}, metrics) != "single_period":
        return None, None
    direct = _number(metrics.get("free_cashflow"))
    if direct is not None:
        return direct, "free_cashflow"
    operating = _number(metrics.get("operating_cashflow"))
    capex = _number(metrics.get("capital_expenditure"))
    if operating is None or capex is None:
        return None, None
    return operating - abs(capex), "operating_cashflow_minus_capital_expenditure"


def _missing_reason(*, name: str, count: int, required: int, sample_label: str) -> str:
    if count < required:
        return f"{name}需要至少{required}{sample_label}，当前仅{count}{sample_label}"
    return f"{name}输入未满足可复算条件"


def _relative_metric(
    *,
    metric: str,
    current: float | None,
    values: list[float],
    source_ids: list[str],
    as_of: str,
    sample_required: int,
    method_id: str,
    method_name: str,
    unit: str,
    reason_label: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    summary = _robust_summary(values) if len(values) >= sample_required else None
    if summary is None:
        reason = f"{reason_label}样本少于{sample_required}家" if sample_required == MIN_PEER_SAMPLE else f"{reason_label}样本少于{sample_required}期"
    else:
        reason = None
    relative = _position(current, summary)
    if summary is not None:
        relative["sample_count"] = summary["sample_count"]
        relative["used_sample_count"] = summary["used_sample_count"]
        relative["reference_range"] = _range(summary)
    required = [f"current_{metric}", f"{reason_label}_sample"]
    available = ([] if current is None else [f"current_{metric}"]) + ([] if summary is None else [f"{reason_label}_sample"])
    method = _method(
        method_id=method_id,
        method=method_name,
        version=f"{method_id}-robust-quantile-v2",
        as_of=as_of,
        source_ids=source_ids,
        required=required,
        available=available,
        inputs={
            f"current_{metric}": current,
            "sample_count": len(values),
            "sample_required": sample_required,
            "values": sorted(values),
            "outlier_count": summary["outlier_count"] if summary else 0,
        },
        unit=unit,
        status="available" if current is not None and summary is not None else "unavailable",
        reference_range=_range(summary),
        result=summary["median"] if summary else None,
        summary=summary,
        relative=relative,
        reason=reason or ("当前估值缺失" if current is None else None),
    )
    return method, relative


def _relative_positions(
    *,
    current: float | None,
    peer: dict[str, Any] | None,
    historical: dict[str, Any] | None,
    peer_count: int,
    history_count: int,
) -> dict[str, Any]:
    peer_position = _position(current, peer)
    historical_position = _position(current, historical)
    positions = [item for item in (peer_position, historical_position) if item.get("percentile") is not None]
    views = {item["view"] for item in positions}
    if not positions:
        view = "暂不判断"
        reason_parts = []
        if peer_count < MIN_PEER_SAMPLE:
            reason_parts.append(f"同行样本少于{MIN_PEER_SAMPLE}家")
        if history_count < MIN_HISTORY_SAMPLE:
            reason_parts.append(f"历史估值样本少于{MIN_HISTORY_SAMPLE}期")
        reason = "；".join(reason_parts) or "缺少可复算估值样本"
        percentile = None
    elif len(views) == 1:
        view = positions[0]["view"]
        reason = "同行与历史估值位置一致" if len(positions) == 2 else "已有一类可复算估值样本"
        percentile = positions[0]["percentile"]
    else:
        view = "暂不判断"
        reason = "同行与历史估值位置冲突"
        percentile = None
    return {
        "view": view,
        "code": {"低估": "undervalued", "合理": "fair", "高估": "overvalued", "暂不判断": "undetermined"}[view],
        "percentile": percentile,
        "peer": peer_position,
        "historical": historical_position,
        "reason": reason,
        "sample_count": {"peer": peer_count, "historical": history_count},
    }


def _valuation_assessment(relative_positions: Mapping[str, Any]) -> dict[str, Any]:
    """Expose one deterministic conclusion for the report/UI contract."""
    allowed = {"低估", "合理", "高估", "暂不判断"}
    metrics: dict[str, dict[str, Any]] = {}
    judged: list[tuple[str, str]] = []
    for name in ("pe", "pb"):
        raw = relative_positions.get(name)
        raw = raw if isinstance(raw, Mapping) else {}
        view = raw.get("view") if raw.get("view") in allowed else "暂不判断"
        percentile = raw.get("percentile")
        if isinstance(percentile, bool) or not isinstance(percentile, (int, float)):
            percentile = None
        metrics[name] = {"view": view, "percentile": percentile}
        if view != "暂不判断":
            judged.append((name, view))

    if not judged:
        view = "暂不判断"
        reason = "市盈率和市净率都没有形成可复算结论"
    elif len(judged) == 1:
        view = judged[0][1]
        reason = f"仅依据{('市盈率' if judged[0][0] == 'pe' else '市净率')}形成结论，另一项暂不判断"
    elif len({item[1] for item in judged}) == 1:
        view = judged[0][1]
        reason = "市盈率和市净率均支持该结论"
    else:
        view = "暂不判断"
        reason = "市盈率与市净率结论不一致"
    return {"view": view, **metrics, "reason": reason}


def _normalized_eps_method(
    point_rows: list[tuple[Mapping[str, Any], str, list[str]]],
    *,
    as_of: str,
    source_ids: list[str],
) -> tuple[dict[str, Any], float | None]:
    values: list[float] = []
    ids: list[str] = []
    for row, _, row_ids in point_rows:
        metrics = row.get("metrics") if isinstance(row.get("metrics"), Mapping) else {}
        value = _positive(metrics.get("normalized_eps")) or _positive(metrics.get("eps"))
        if value is not None:
            values.append(value)
            ids.extend(row_ids)
    summary = _robust_summary(values) if len(values) >= MIN_HISTORY_SAMPLE else None
    available = ["point_in_time_financial_history"] if summary else []
    method = _method(
        method_id="normalized_earnings",
        method="multi-period-point-in-time-normalized-eps",
        version="normalized-eps-median-v2",
        as_of=as_of,
        source_ids=list(dict.fromkeys([*source_ids, *ids])),
        required=["point_in_time_financial_history"],
        available=available,
        inputs={
            "period_count": len(values),
            "sample_required": MIN_HISTORY_SAMPLE,
            "values": sorted(values),
            "basis": "仅使用明确标记为单期的多期每股收益；不把累计半年报当作单季或TTM",
        },
        unit="eps_per_share",
        status="available" if summary else "unavailable",
        reference_range=_range(summary),
        result=summary["median"] if summary else None,
        summary=summary,
        reason=None if summary else _missing_reason(name="正常化盈利", count=len(values), required=MIN_HISTORY_SAMPLE, sample_label="单期财务数据"),
    )
    return method, (summary["median"] if summary else None)


def _cashflow_quality_method(
    point_rows: list[tuple[Mapping[str, Any], str, list[str]]],
    *,
    as_of: str,
    source_ids: list[str],
) -> dict[str, Any]:
    ratios: list[float] = []
    ids: list[str] = []
    for row, _, row_ids in point_rows:
        metrics = row.get("metrics") if isinstance(row.get("metrics"), Mapping) else {}
        cashflow = _number(metrics.get("operating_cashflow"))
        profit = _number(metrics.get("net_profit"))
        if cashflow is not None and profit not in (None, 0):
            ratios.append(cashflow / profit)
            ids.extend(row_ids)
    summary = _robust_summary(ratios) if len(ratios) >= MIN_HISTORY_SAMPLE else None
    method = _method(
        method_id="cashflow_quality",
        method="multi-period-operating-cashflow-to-profit",
        version="cashflow-quality-median-v2",
        as_of=as_of,
        source_ids=list(dict.fromkeys([*source_ids, *ids])),
        required=["point_in_time_financial_history", "operating_cashflow", "net_profit"],
        available=([] if summary is None else ["point_in_time_financial_history", "operating_cashflow", "net_profit"]),
        inputs={
            "period_count": len(ratios),
            "sample_required": MIN_HISTORY_SAMPLE,
            "values": sorted(ratios),
            "basis": "仅使用明确标记为单期的经营现金流/净利润；不把累计半年报当作单季或TTM",
        },
        unit="cashflow_to_profit_ratio",
        status="available" if summary else "unavailable",
        reference_range=_range(summary),
        result=summary["median"] if summary else None,
        summary=summary,
        reason=None if summary else "现金流质量需要至少4期明确的单期经营现金流与净利润；不得将累计半年报当作单季或TTM",
    )
    return method


def build_valuation_result(bundle: Mapping[str, Any]) -> dict[str, Any]:
    """Compute deterministic valuation methods from one frozen Evidence bundle."""
    cutoff = parse_asia_datetime(bundle.get("research_cutoff_at"))
    as_of = cutoff.isoformat() if cutoff is not None else str(bundle.get("research_cutoff_at") or "")
    quote = bundle.get("quote") if isinstance(bundle.get("quote"), Mapping) else {}
    fundamentals = bundle.get("fundamentals") if isinstance(bundle.get("fundamentals"), Mapping) else {}
    metrics = fundamentals.get("metrics") if isinstance(fundamentals.get("metrics"), Mapping) else {}
    context = (bundle.get("company_quality") or {}).get("valuation_context") if isinstance(bundle.get("company_quality"), Mapping) else None
    context = context if isinstance(context, Mapping) else {}
    industry_context = bundle.get("industry_context")
    industry = str(_field(industry_context, "target_industry", "") or "")
    family = _industry_family(industry)
    quote_sources = _source_ids(quote.get("source_ids"))
    context_sources = _source_ids(context.get("source_ids"))
    fundamental_sources = _source_ids(fundamentals.get("source_ids"))
    base_sources = list(dict.fromkeys([*quote_sources, *context_sources, *fundamental_sources]))
    peer_pe = _peer_values(context, "pe")
    peer_pb = _peer_values(context, "pb")
    current_pe = _positive(quote.get("pe")) or _positive(_field(context.get("pe"), "value"))
    current_pb = _positive(quote.get("pb")) or _positive(_field(context.get("pb"), "value"))
    methods: dict[str, dict[str, Any]] = {}

    peer_pe_method, peer_pe_position = _relative_metric(
        metric="pe", current=current_pe, values=peer_pe, source_ids=base_sources, as_of=as_of,
        sample_required=MIN_PEER_SAMPLE, method_id="peer_pe", method_name="same-industry-peer-pe-robust-range",
        unit="pe_multiple", reason_label="同行市盈率",
    )
    peer_pb_method, peer_pb_position = _relative_metric(
        metric="pb", current=current_pb, values=peer_pb, source_ids=base_sources, as_of=as_of,
        sample_required=MIN_PEER_SAMPLE, method_id="peer_pb", method_name="same-industry-peer-pb-robust-range",
        unit="pb_multiple", reason_label="同行市净率",
    )
    methods["peer_pe"] = peer_pe_method
    methods["peer_pb"] = peer_pb_method

    history = _history_rows(bundle, cutoff)
    historical_pe = [_positive(_field(row.get("metrics"), "pe")) for row, _, _ in history]
    historical_pb = [_positive(_field(row.get("metrics"), "pb")) for row, _, _ in history]
    historical_pe_values = [value for value in historical_pe if value is not None]
    historical_pb_values = [value for value in historical_pb if value is not None]
    history_sources = list(dict.fromkeys(source_id for _, _, ids in history for source_id in ids))
    historical_pe_method, historical_pe_position = _relative_metric(
        metric="pe", current=current_pe, values=historical_pe_values, source_ids=history_sources, as_of=as_of,
        sample_required=MIN_HISTORY_SAMPLE, method_id="historical_pe", method_name="own-history-pe-robust-range",
        unit="pe_multiple", reason_label="历史市盈率",
    )
    historical_pb_method, historical_pb_position = _relative_metric(
        metric="pb", current=current_pb, values=historical_pb_values, source_ids=history_sources, as_of=as_of,
        sample_required=MIN_HISTORY_SAMPLE, method_id="historical_pb", method_name="own-history-pb-robust-range",
        unit="pb_multiple", reason_label="历史市净率",
    )
    methods["historical_pe"] = historical_pe_method
    methods["historical_pb"] = historical_pb_method
    point_rows = _point_in_time_rows(history)

    if family == "financial":
        roe = _positive(metrics.get("roe"))
        peer_summary = _robust_summary(peer_pb) if len(peer_pb) >= MIN_PEER_SAMPLE else None
        methods["industry_pb_roe"] = _method(
            method_id="industry_pb_roe",
            method="financial-pb-roe-relative-range",
            version="financial-pb-roe-v2",
            as_of=as_of,
            source_ids=base_sources,
            required=["current_pb", "roe", "peer_pb_sample"],
            available=([] if current_pb is None else ["current_pb"]) + ([] if roe is None else ["roe"]) + ([] if peer_summary is None else ["peer_pb_sample"]),
            inputs={"current_pb": current_pb, "roe": roe, "peer_count": len(peer_pb)},
            unit="pb_multiple",
            status="available" if current_pb is not None and roe is not None and peer_summary is not None else "unavailable",
            reference_range=_range(peer_summary),
            result=peer_summary["median"] if peer_summary else None,
            summary=peer_summary,
            relative=_position(current_pb, peer_summary),
            reason=None if peer_summary is not None and roe is not None and current_pb is not None else "金融股需要当前市净率、当前ROE和至少3家同行市净率样本",
        )
        # Residual-income PB is deliberately strict: all return assumptions
        # must be explicit and point-in-time; no DCF or LLM-filled default.
        normalized_roes = []
        for row, _, _ in point_rows:
            row_metrics = row.get("metrics") if isinstance(row.get("metrics"), Mapping) else {}
            value = _positive(row_metrics.get("normalized_roe")) or _positive(row_metrics.get("roe"))
            if value is not None:
                normalized_roes.append(value)
        normalized_roe = _quantile(sorted(normalized_roes), 0.5) if len(normalized_roes) >= MIN_HISTORY_SAMPLE else None
        cost = _positive(metrics.get("cost_of_equity"))
        growth = _number(metrics.get("growth_rate"))
        if growth is None:
            growth = _number(metrics.get("sustainable_growth_rate"))
        if growth is not None and growth < 1:
            growth *= 100
        justified_pb = None
        if normalized_roe is not None and cost is not None and growth is not None and cost > growth and normalized_roe > growth:
            justified_pb = ((normalized_roe - growth) / (cost - growth))
        methods["residual_income"] = _method(
            method_id="residual_income",
            method="financial-residual-income-pb",
            version="financial-residual-income-v2",
            as_of=as_of,
            source_ids=list(dict.fromkeys([*base_sources, *history_sources])),
            required=["normalized_roe_multi_period", "cost_of_equity", "growth_rate", "current_pb"],
            available=([] if normalized_roe is None else ["normalized_roe_multi_period"]) + ([] if cost is None else ["cost_of_equity"]) + ([] if growth is None else ["growth_rate"]) + ([] if current_pb is None else ["current_pb"]),
            inputs={"normalized_roe": normalized_roe, "cost_of_equity": cost, "growth_rate": growth, "current_pb": current_pb},
            unit="pb_multiple",
            status="available" if justified_pb is not None and current_pb is not None else "unavailable",
            reference_range={"low": justified_pb, "high": justified_pb} if justified_pb is not None else None,
            result=justified_pb,
            relative={"view": "合理", "code": "fair", "percentile": None, "basis": "显式剩余收益假设"} if justified_pb is not None else None,
            reason=None if justified_pb is not None else "缺少至少4期单期ROE、权益成本或增长率，不能复算剩余收益PB",
        )

    cashflow_quality = _cashflow_quality_method(point_rows, as_of=as_of, source_ids=history_sources)
    methods["cashflow_quality"] = cashflow_quality

    if family == "stable_cashflow":
        cashflow, cashflow_method = _cashflow_value(metrics)
        market_cap = _positive(quote.get("market_cap"))
        fcf_yield = cashflow / market_cap * 100 if cashflow is not None and market_cap is not None and cashflow > 0 else None
        methods["fcf_yield"] = _method(
            method_id="fcf_yield",
            method="stable-cashflow-yield",
            version="stable-cashflow-yield-v2",
            as_of=as_of,
            source_ids=base_sources,
            required=["single_period_cashflow", "market_cap"],
            available=([] if fcf_yield is None else ["single_period_cashflow"]) + ([] if market_cap is None else ["market_cap"]),
            inputs={"cashflow": cashflow, "cashflow_method": cashflow_method, "market_cap": market_cap, "fcf_yield_pct": fcf_yield, "period_basis": _period_basis({}, metrics)},
            unit="fcf_yield_pct",
            status="available" if fcf_yield is not None else "unavailable",
            reference_range={"low": fcf_yield, "high": fcf_yield} if fcf_yield is not None else None,
            result=fcf_yield,
            reason=None if fcf_yield is not None else "需要明确标记为单期的自由现金流和市值；不得将累计半年报当作单季或TTM",
        )

    normalized_method, normalized_eps = _normalized_eps_method(point_rows, as_of=as_of, source_ids=history_sources)
    methods["normalized_earnings"] = normalized_method
    if family == "cyclical":
        peer_summary = _robust_summary(peer_pe) if len(peer_pe) >= MIN_PEER_SAMPLE else None
        price_range = {"low": normalized_eps * peer_summary["low"], "high": normalized_eps * peer_summary["high"]} if normalized_eps is not None and peer_summary is not None else None
        methods["mid_cycle_pe"] = _method(
            method_id="mid_cycle_pe",
            method="cyclical-mid-cycle-earnings-relative-range",
            version="cyclical-mid-cycle-pe-v2",
            as_of=as_of,
            source_ids=list(dict.fromkeys([*base_sources, *history_sources])),
            required=["normalized_eps_multi_period", "peer_pe_sample"],
            available=([] if normalized_eps is None else ["normalized_eps_multi_period"]) + ([] if peer_summary is None else ["peer_pe_sample"]),
            inputs={"normalized_eps": normalized_eps, "peer_count": len(peer_pe)},
            unit="price_per_share",
            status="available" if price_range is not None else "unavailable",
            reference_range=price_range,
            result=(price_range["low"] + price_range["high"]) / 2 if price_range else None,
            summary=peer_summary,
            reason=None if price_range is not None else "周期股需要至少4期明确单期每股收益和至少3家同行市盈率样本",
        )

    usable = [
        method
        for method in methods.values()
        if method.get("status") == "available" and _number(method.get("result")) is not None and method.get("reference_range")
    ]
    grouped: dict[str, list[dict[str, Any]]] = {}
    for method in usable:
        grouped.setdefault(method["unit"], []).append(method)
    cross: dict[str, Any] = {"status": "unavailable", "method_count": 0, "unit": None, "method_ids": [], "reason": "至少需要两种同单位且可复算的方法"}
    for unit, candidates in grouped.items():
        if len(candidates) < 2:
            continue
        low = max(item["reference_range"]["low"] for item in candidates)
        high = min(item["reference_range"]["high"] for item in candidates)
        cross = {
            "status": "available" if low <= high else "conflict",
            "unit": unit,
            "method_count": len(candidates),
            "method_ids": [item["id"] for item in candidates],
            **({"low": low, "high": high} if low <= high else {"reason": "同单位方法的稳健区间没有交集"}),
        }
        break
    relative_positions = {
        "pe": _relative_positions(current=current_pe, peer=_robust_summary(peer_pe) if len(peer_pe) >= MIN_PEER_SAMPLE else None, historical=_robust_summary(historical_pe_values) if len(historical_pe_values) >= MIN_HISTORY_SAMPLE else None, peer_count=len(peer_pe), history_count=len(historical_pe_values)),
        "pb": _relative_positions(current=current_pb, peer=_robust_summary(peer_pb) if len(peer_pb) >= MIN_PEER_SAMPLE else None, historical=_robust_summary(historical_pb_values) if len(historical_pb_values) >= MIN_HISTORY_SAMPLE else None, peer_count=len(peer_pb), history_count=len(historical_pb_values)),
    }
    assessment = _valuation_assessment(relative_positions)
    source_ids = list(dict.fromkeys([*base_sources, *history_sources, *[source_id for method in methods.values() for source_id in method.get("source_ids") or []]]))
    usable_count = len(usable)
    trade_ready = cross["status"] == "available"
    status = "available" if trade_ready else ("degraded" if usable_count else "unavailable")
    missing_fields = []
    if not industry:
        missing_fields.append("industry")
    if not quote_sources:
        missing_fields.append("current_quote")
    if not fundamental_sources:
        missing_fields.append("financial_snapshot")
    if not any(item["view"] != "暂不判断" for item in relative_positions.values()):
        missing_fields.append("relative_valuation_sample")
    safety_margin = None
    if trade_ready:
        current_by_unit = {"pe_multiple": current_pe, "pb_multiple": current_pb, "price_per_share": _positive(quote.get("price"))}
        current = current_by_unit.get(cross["unit"])
        if current is not None and current > 0:
            safety_margin = {"status": "available", "unit": cross["unit"], "current": current, "to_upper_bound_pct": (cross["high"] - current) / current * 100, "basis": "当前倍数距离交叉验证区间上沿；不是目标价"}
    return {
        "schema_version": VALUATION_SCHEMA_VERSION,
        "method": "industry-adapted-valuation",
        "version": VALUATION_METHOD_VERSION,
        "status": status,
        "trade_ready": trade_ready,
        "industry": industry,
        "industry_family": family,
        "as_of": as_of,
        "source_ids": source_ids,
        "methods": methods,
        "relative_positions": relative_positions,
        "assessment": assessment,
        "usable_method_count": usable_count,
        "cross_range": cross,
        "safety_margin": safety_margin,
        "evidence_strength": "strong" if trade_ready else ("medium" if usable_count else "weak"),
        "input_completeness": {
            "required": ["industry", "current_quote", "financial_snapshot"],
            "available": [item for item, present in (("industry", bool(industry)), ("current_quote", bool(quote_sources)), ("financial_snapshot", bool(fundamental_sources))) if present],
            "missing": [item for item, present in (("industry", bool(industry)), ("current_quote", bool(quote_sources)), ("financial_snapshot", bool(fundamental_sources))) if not present],
        },
        "missing_fields": missing_fields,
        "reason": "已通过至少两种同单位方法交叉验证" if trade_ready else cross.get("reason") or "当前仅保留已有可复算估值证据，未形成交叉验证区间",
    }
