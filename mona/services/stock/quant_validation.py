"""Small deterministic rolling out-of-sample validator for stock factors.

The validator is deliberately independent from screening and LLM code.  It
consumes already frozen point-in-time rows; it never fetches data, fills
missing values, randomizes splits, or changes a screening rank.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

VALIDATION_METHOD_VERSION = "rolling-oos-factor-v1"
COST_MODEL_VERSION = "a-share-cost-proxy-v1"
PROMOTION_GATE_VERSION = "promotion-gate-v1"


@dataclass(frozen=True)
class TransactionCost:
    """Explicit costs per one *full portfolio turnover*.

    The validator's turnover is the fraction of the selected basket replaced
    between two test dates.  Commission, stamp duty and slippage are charged
    once against that full-turnover fraction; this is a deliberately explicit
    proxy, not a claim about broker-side fill mechanics.
    """

    version: str = COST_MODEL_VERSION
    commission_bps: float = 3.0
    stamp_duty_bps: float = 5.0
    slippage_bps: float = 5.0

    @property
    def rate(self) -> float:
        return (self.commission_bps + self.stamp_duty_bps + self.slippage_bps) / 10_000.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "basis": "full_turnover_once",
            "commissionBps": self.commission_bps,
            "stampDutyBps": self.stamp_duty_bps,
            "slippageBps": self.slippage_bps,
        }


@dataclass(frozen=True)
class PromotionGate:
    version: str = PROMOTION_GATE_VERSION
    min_oos_samples: int = 60
    min_oos_periods: int = 3
    min_rank_ic: float = 0.03
    min_icir: float = 0.2
    min_excess_return_after_cost: float = 0.0
    min_cross_section_size: int = 30
    min_universe_coverage: float = 0.8
    require_group_monotonicity: bool = True

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "minOosSamples": self.min_oos_samples,
            "minOosPeriods": self.min_oos_periods,
            "minRankIc": self.min_rank_ic,
            "minIcir": self.min_icir,
            "minExcessReturnAfterCost": self.min_excess_return_after_cost,
            "minCrossSectionSize": self.min_cross_section_size,
            "minUniverseCoverage": self.min_universe_coverage,
            "requireGroupMonotonicity": self.require_group_monotonicity,
        }


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _row_time(row: Mapping[str, Any]) -> datetime | None:
    return _time(row.get("as_of") or row.get("factor_as_of") or row.get("date"))


def _future_time(row: Mapping[str, Any]) -> datetime | None:
    return _time(row.get("outcome_as_of") or row.get("return_as_of") or row.get("future_as_of"))


def _rank(values: list[float]) -> list[float]:
    ordered = sorted(enumerate(values), key=lambda item: (item[1], item[0]))
    ranks = [0.0] * len(values)
    for position, (index, _value) in enumerate(ordered):
        ranks[index] = float(position + 1)
    return ranks


def _correlation(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 2:
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    left_var = sum((a - left_mean) ** 2 for a in left)
    right_var = sum((b - right_mean) ** 2 for b in right)
    denominator = math.sqrt(left_var * right_var)
    return numerator / denominator if denominator > 0 else None


def _daily_groups(rows: list[dict[str, Any]], groups: int = 5) -> list[list[dict[str, Any]]]:
    ordered = sorted(rows, key=lambda row: (float(row["factor"]), str(row["instrument_id"])))
    if not ordered:
        return []
    count = min(groups, len(ordered))
    base, remainder = divmod(len(ordered), count)
    result: list[list[dict[str, Any]]] = []
    start = 0
    for index in range(count):
        width = base + (1 if index < remainder else 0)
        result.append(ordered[start : start + width])
        start += width
    return result


def _max_drawdown(returns: Iterable[float]) -> float:
    wealth = 1.0
    peak = 1.0
    drawdown = 0.0
    for value in returns:
        wealth *= 1.0 + value
        peak = max(peak, wealth)
        drawdown = min(drawdown, wealth / peak - 1.0)
    return drawdown


def _validate_rows(rows: Iterable[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[datetime, str]] = set()
    for index, raw in enumerate(rows):
        if not isinstance(raw, Mapping):
            return [], f"第{index + 1}条记录不是对象"
        as_of = _row_time(raw)
        outcome_as_of = _future_time(raw)
        factor = _number(raw.get("factor"))
        future_return = _number(raw.get("forward_return"))
        instrument_id = raw.get("instrument_id") or raw.get("instrumentId")
        snapshot_hash = raw.get("snapshot_hash") or raw.get("snapshotHash")
        factor_version = raw.get("factor_version") or raw.get("factorVersion")
        strategy_fingerprint = raw.get("strategy_fingerprint") or raw.get("strategyFingerprint")
        report_id = raw.get("report_id") or raw.get("reportId")
        workflow_run_id = raw.get("workflow_run_id") or raw.get("workflowRunId")
        row_factor_id = raw.get("factor_id") or raw.get("factorId")
        row_factor_direction = raw.get("factor_direction") or raw.get("factorDirection")
        sample_scope = raw.get("sample_scope") or raw.get("sampleScope")
        universe_count = raw.get("universe_count") or raw.get("universeCount")
        observed_count = raw.get("observed_count") or raw.get("observedCount")
        source_ids = raw.get("source_ids") or raw.get("sourceIds")
        outcome_snapshot_hash = raw.get("outcome_snapshot_hash") or raw.get("outcomeSnapshotHash")
        if as_of is None or outcome_as_of is None:
            return [], f"第{index + 1}条记录缺少有效因子时点或收益时点"
        if outcome_as_of <= as_of:
            return [], f"第{index + 1}条记录的未来收益时点不晚于因子时点"
        if factor is None or future_return is None or not isinstance(instrument_id, str) or not instrument_id:
            return [], f"第{index + 1}条记录缺少可计算因子或收益"
        if not isinstance(snapshot_hash, str) or not snapshot_hash.strip():
            return [], f"第{index + 1}条记录缺少冻结快照哈希"
        if (
            not isinstance(factor_version, str) or not factor_version.strip()
        ) and (not isinstance(strategy_fingerprint, str) or not strategy_fingerprint.strip()):
            return [], f"第{index + 1}条记录缺少因子版本或策略指纹"
        if row_factor_direction is not None and row_factor_direction not in {"asc", "desc"}:
            return [], f"第{index + 1}条记录的因子方向无效"
        if sample_scope not in {
            "full_universe",
            "full_eligible_universe",
            "complete_eligible_universe",
            "selected_candidates",
        }:
            return [], f"第{index + 1}条记录缺少有效样本范围"
        if (
            isinstance(universe_count, bool)
            or not isinstance(universe_count, int)
            or universe_count <= 0
            or isinstance(observed_count, bool)
            or not isinstance(observed_count, int)
            or observed_count <= 0
            or observed_count > universe_count
        ):
            return [], f"第{index + 1}条记录的股票池覆盖信息无效"
        if not isinstance(source_ids, list) or any(
            not isinstance(source_id, str) or not source_id.strip() for source_id in source_ids
        ):
            return [], f"第{index + 1}条记录缺少来源闭包"
        if not isinstance(outcome_snapshot_hash, str) or not outcome_snapshot_hash.strip():
            return [], f"第{index + 1}条记录缺少未来收益快照哈希"
        key = (as_of, instrument_id)
        if key in seen:
            return [], f"第{index + 1}条记录与同一时点股票重复"
        seen.add(key)
        normalized.append(
            {
                "as_of": as_of,
                "outcome_as_of": outcome_as_of,
                "instrument_id": instrument_id,
                "factor": factor,
                "forward_return": future_return,
                "snapshot_hash": snapshot_hash.strip(),
                "factor_version": factor_version.strip() if isinstance(factor_version, str) else None,
                "strategy_fingerprint": strategy_fingerprint.strip() if isinstance(strategy_fingerprint, str) else None,
                "report_id": report_id.strip() if isinstance(report_id, str) and report_id.strip() else None,
                "workflow_run_id": workflow_run_id.strip() if isinstance(workflow_run_id, str) and workflow_run_id.strip() else None,
                "factor_id": row_factor_id.strip() if isinstance(row_factor_id, str) and row_factor_id.strip() else None,
                "factor_direction": row_factor_direction if row_factor_direction in {"asc", "desc"} else None,
                "sample_scope": sample_scope,
                "universe_count": universe_count,
                "observed_count": observed_count,
                "source_ids": sorted(set(source_ids)),
                "outcome_snapshot_hash": outcome_snapshot_hash.strip(),
            }
        )
    if not normalized:
        return normalized, None
    factor_versions = {row["factor_version"] for row in normalized if row["factor_version"]}
    strategy_fingerprints = {
        row["strategy_fingerprint"] for row in normalized if row["strategy_fingerprint"]
    }
    factor_ids = {row["factor_id"] for row in normalized if row["factor_id"]}
    factor_directions = {row["factor_direction"] for row in normalized if row["factor_direction"]}
    sample_scopes = {row["sample_scope"] for row in normalized}
    by_batch: dict[str, set[str]] = {}
    for row in normalized:
        batch_id = row["report_id"] or row["workflow_run_id"] or row["snapshot_hash"]
        by_batch.setdefault(batch_id, set()).add(row["snapshot_hash"])
    if any(len(snapshot_hashes) != 1 for snapshot_hashes in by_batch.values()):
        return [], "同一选股运行的冻结快照哈希不一致"
    if len(factor_versions) > 1 or len(strategy_fingerprints) > 1:
        return [], "同次验证记录的因子版本或策略指纹不一致"
    if len(factor_ids) > 1 or len(factor_directions) > 1:
        return [], "同次验证记录的因子标识或方向不一致"
    if len(sample_scopes) != 1:
        return [], "同次验证记录的样本范围不一致"
    by_date_metadata: dict[datetime, set[tuple[str, int, int]]] = {}
    for row in normalized:
        by_date_metadata.setdefault(row["as_of"], set()).add(
            (row["sample_scope"], row["universe_count"], row["observed_count"])
        )
    if any(len(values) != 1 for values in by_date_metadata.values()):
        return [], "同一时点的股票池覆盖信息不一致"
    return normalized, None


def _rolling_test_rows(
    rows: list[dict[str, Any]], *, train_periods: int, validation_periods: int, test_periods: int
) -> tuple[list[dict[str, Any]], int]:
    dates = sorted({row["as_of"] for row in rows})
    if len(dates) < train_periods + validation_periods + test_periods:
        return [], 0
    by_date = {date: [row for row in rows if row["as_of"] == date] for date in dates}
    out: list[dict[str, Any]] = []
    periods = 0
    start = train_periods
    while start + validation_periods + test_periods <= len(dates):
        test_dates = dates[start + validation_periods : start + validation_periods + test_periods]
        out.extend(row for date in test_dates for row in by_date[date])
        periods += 1
        start += test_periods
    return out, periods


def validate_rolling_oos(
    rows: Iterable[Mapping[str, Any]],
    *,
    direction: str = "desc",
    train_periods: int = 6,
    validation_periods: int = 2,
    test_periods: int = 1,
    cost: TransactionCost | None = None,
    gate: PromotionGate | None = None,
    factor_id: str = "composite_score",
    factor_direction: str = "desc",
    strategy_horizon: str | None = None,
) -> dict[str, Any]:
    """Run deterministic chronological rolling validation.

    ``rows`` must contain factor and *future* return observations captured at
    each factor date.  No row after a test date is used to form that test
    result.  The validator reports not-evaluable diagnostics instead of
    inventing PBO/DSR statistics when the trial history is insufficient.
    """
    cost = cost or TransactionCost()
    gate = gate or PromotionGate()
    split_metadata = {
        "method": "chronological_rolling",
        "trainPeriods": train_periods,
        "validationPeriods": validation_periods,
        "testPeriods": test_periods,
        "randomized": False,
    }
    normalized, error = _validate_rows(rows)
    if error:
        return {
            "status": "rejected",
            "promotionStatus": "rejected",
            "eligibleForTrading": False,
            "reason": error,
            "validationStatus": "rejected",
            "notEvaluable": True,
            "methodVersion": VALIDATION_METHOD_VERSION,
            "costModel": cost.as_dict(),
            "promotionGate": gate.as_dict(),
            "split": split_metadata,
            "factor": {"id": factor_id, "direction": factor_direction},
            "strategyHorizon": strategy_horizon,
            "calibratedHorizon": None,
        }
    if direction not in {"asc", "desc"}:
        raise ValueError("direction must be asc or desc")
    if not isinstance(factor_id, str) or not factor_id.strip():
        raise ValueError("factor_id must be non-empty")
    if factor_direction not in {"asc", "desc"}:
        raise ValueError("factor_direction must be asc or desc")
    normalized.sort(key=lambda row: (row["as_of"], row["instrument_id"]))
    record_factor_ids = {row["factor_id"] for row in normalized if row["factor_id"]}
    record_factor_directions = {row["factor_direction"] for row in normalized if row["factor_direction"]}
    factor_metadata = {
        "id": next(iter(record_factor_ids), factor_id),
        "direction": next(iter(record_factor_directions), factor_direction),
    }
    test_rows, oos_periods = _rolling_test_rows(
        normalized,
        train_periods=train_periods,
        validation_periods=validation_periods,
        test_periods=test_periods,
    )
    by_date: dict[datetime, list[dict[str, Any]]] = {}
    for row in test_rows:
        by_date.setdefault(row["as_of"], []).append(row)
    sample_scope = next(iter({row["sample_scope"] for row in normalized}), None)
    scope_is_complete = sample_scope in {
        "full_universe",
        "full_eligible_universe",
        "complete_eligible_universe",
    }
    coverage_is_complete = all(
        row["observed_count"] >= gate.min_cross_section_size
        and row["observed_count"] / row["universe_count"] >= gate.min_universe_coverage
        for row in normalized
    )
    ics: list[float] = []
    group_returns: list[list[float]] = []
    top_returns: list[float] = []
    all_returns: list[float] = []
    selected_by_date: list[set[str]] = []
    cross_sectional_sample_ok = True
    for date in sorted(by_date):
        day = by_date[date]
        factor_values = [row["factor"] for row in day]
        returns = [row["forward_return"] for row in day]
        rank_ic = _correlation(_rank(factor_values), _rank(returns))
        if rank_ic is not None:
            ics.append(rank_ic if direction == "desc" else -rank_ic)
        groups = _daily_groups(day)
        if len(day) < 5 or len(groups) < 5:
            cross_sectional_sample_ok = False
        group_means = [sum(row["forward_return"] for row in group) / len(group) for group in groups]
        if direction == "desc":
            group_means.reverse()
            groups.reverse()
        group_returns.append(group_means)
        top = groups[0]
        selected_by_date.append({row["instrument_id"] for row in top})
        top_returns.append(sum(row["forward_return"] for row in top) / len(top))
        all_returns.append(sum(returns) / len(returns))
    # Opening the first test portfolio is a full turnover; subsequent values
    # are the fraction replaced from the previous selected basket.
    turnover: list[float] = [1.0] if selected_by_date else []
    for previous, current in zip(selected_by_date, selected_by_date[1:]):
        union = previous | current
        turnover.append(len(previous ^ current) / len(union) if union else 0.0)
    costs = [value * cost.rate for value in turnover]
    net_top_returns = [
        value - costs[index]
        for index, value in enumerate(top_returns)
    ]
    sample_count = len(test_rows)
    mean_ic = sum(ics) / len(ics) if ics else None
    ic_std = math.sqrt(sum((value - mean_ic) ** 2 for value in ics) / (len(ics) - 1)) if mean_ic is not None and len(ics) > 1 else None
    icir = mean_ic / ic_std if mean_ic is not None and ic_std and ic_std > 0 else None
    t_statistic = icir * math.sqrt(len(ics)) if icir is not None else None
    mean_excess = (
        sum(top - market for top, market in zip(top_returns, all_returns)) / len(top_returns)
        if top_returns
        else None
    )
    mean_net_excess = (
        sum(top - market for top, market in zip(net_top_returns, all_returns)) / len(net_top_returns)
        if net_top_returns
        else None
    )
    aggregate_group_returns = (
        [
            sum(values[index] for values in group_returns) / len(group_returns)
            for index in range(min(len(values) for values in group_returns))
        ]
        if group_returns and cross_sectional_sample_ok
        else None
    )
    monotonic = (
        all(
            aggregate_group_returns[index] >= aggregate_group_returns[index + 1]
            if direction == "desc"
            else aggregate_group_returns[index] <= aggregate_group_returns[index + 1]
            for index in range(len(aggregate_group_returns) - 1)
        )
        if aggregate_group_returns is not None
        else None
    )
    metrics = {
        "sampleScope": sample_scope,
        "universeCoverage": min(
            (row["observed_count"] / row["universe_count"] for row in normalized),
            default=None,
        ),
        "sampleCount": sample_count,
        "oosPeriods": oos_periods,
        "rankIc": mean_ic,
        "icir": icir,
        "tStatistic": t_statistic,
        "groupMonotonic": monotonic if group_returns else None,
        "groupReturns": group_returns,
        "groupReturnsAggregate": aggregate_group_returns,
        "excessReturn": mean_excess,
        "excessReturnAfterCost": mean_net_excess,
        "turnover": sum(turnover) / len(turnover) if turnover else None,
        "costRate": cost.rate,
        "maxDrawdown": _max_drawdown(net_top_returns) if net_top_returns else None,
        "pbo": "not_evaluable",
        "dsr": "not_evaluable",
        "trialCount": 1,
    }
    scope_eligible = scope_is_complete and coverage_is_complete and all(
        len(day) >= gate.min_cross_section_size for day in by_date.values()
    )
    if not scope_eligible:
        metrics.update(
            {
                "rankIc": None,
                "icir": None,
                "tStatistic": None,
                "groupMonotonic": None,
                "groupReturns": None,
                "groupReturnsAggregate": None,
                "excessReturn": None,
                "excessReturnAfterCost": None,
                "turnover": None,
                "maxDrawdown": None,
            }
        )
    enough = (
        scope_eligible
        and sample_count >= gate.min_oos_samples
        and oos_periods >= gate.min_oos_periods
    )
    icir_pass = (
        icir is not None and icir >= gate.min_icir
    ) or (
        icir is None and len(ics) < 2 and gate.min_icir <= 0
    )
    passed = enough and (
        mean_ic is not None and mean_ic >= gate.min_rank_ic
        and icir_pass
        and mean_net_excess is not None and mean_net_excess >= gate.min_excess_return_after_cost
        and (not gate.require_group_monotonicity or metrics["groupMonotonic"] is True)
    )
    if passed:
        promotion_status = "calibrated"
        reason = "样本外滚动验证通过版本化晋级门槛"
    elif sample_scope == "selected_candidates":
        promotion_status = "research_only"
        reason = "当前记录只覆盖已入选股票，不能代表完整股票池，不能晋级校准"
    elif not scope_eligible:
        promotion_status = "research_only"
        reason = "冻结股票池覆盖不足或横截面样本不足，不能晋级校准"
    elif not enough or not test_rows:
        promotion_status = "research_only"
        reason = "样本外历史收益记录不足，不能标记为已校准"
    else:
        promotion_status = "rejected"
        reason = "样本外验证未通过晋级门槛"
    return {
        "status": promotion_status,
        "promotionStatus": promotion_status,
        "eligibleForTrading": promotion_status == "calibrated",
        "reason": reason,
        "validationStatus": "available" if test_rows else "not_evaluable",
        "notEvaluable": not bool(test_rows) or not scope_eligible,
        "sampleScope": sample_scope,
        "methodVersion": VALIDATION_METHOD_VERSION,
        "costModel": cost.as_dict(),
        "promotionGate": gate.as_dict(),
        "split": split_metadata,
        "factor": factor_metadata,
        "strategyHorizon": strategy_horizon,
        "calibratedHorizon": strategy_horizon if promotion_status == "calibrated" else None,
        "metrics": metrics,
    }


def validate_strategy(
    rows: Iterable[Mapping[str, Any]] | None,
    *,
    direction: str = "desc",
    gate: PromotionGate | None = None,
    cost: TransactionCost | None = None,
    factor_id: str = "composite_score",
    factor_direction: str = "desc",
    strategy_horizon: str | None = None,
) -> dict[str, Any]:
    """Promotion entry point used by screening; no rows means research-only."""
    if rows is None:
        result = validate_rolling_oos(
            [],
            direction=direction,
            gate=gate,
            cost=cost,
            factor_id=factor_id,
            factor_direction=factor_direction,
            strategy_horizon=strategy_horizon,
        )
        result["reason"] = "未提供冻结点时历史收益记录，当前仅用于研究观察"
        return result
    return validate_rolling_oos(
        rows,
        direction=direction,
        gate=gate,
        cost=cost,
        factor_id=factor_id,
        factor_direction=factor_direction,
        strategy_horizon=strategy_horizon,
    )
