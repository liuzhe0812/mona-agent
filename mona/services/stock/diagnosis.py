"""Standard AI diagnosis orchestration and durable run storage.

The standard diagnosis path is intentionally separate from the packaged
``stock-deep-research`` six-agent workflow.  It consumes one immutable
Evidence context plus deterministic stage-A/stage-B/stage-C inputs, permits
at most one injected semantic researcher, and persists a
``StockDiagnosisV1`` report under ``stock_diagnoses`` rather than under the
deep-research run directory.

No provider or LLM is faked here.  Integrations inject explicit factor and
semantic-research callables; when a seam is not connected, the report keeps
the corresponding section unavailable instead of inventing values.
"""

from __future__ import annotations

import inspect
import json
import os
import re
import shutil
import uuid
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from mona.services.stock.diagnosis_decision import (
    HORIZONS,
    build_diagnosis_decision,
    canonical_input_hash,
)
from mona.services.stock.diagnosis_quant import (
    build_diagnosis_quant_payload,
    ensure_diagnosis_cross_section_cache,
)
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.fundamental_factors import build_fundamental_factors
from mona.services.stock.provider import InstrumentRef
from mona.services.stock.schemas import (
    DiagnosisAvailability,
    DiagnosisDataQuality,
    DiagnosisDecisionBasisRow,
    DiagnosisFactor,
    DiagnosisFactorHorizon,
    DiagnosisFactorSnapshot,
    DiagnosisFundamentalResearch,
    DiagnosisSemanticSubmission,
    DiagnosisTechnicalExecution,
    InstrumentTag,
    StockDiagnosisV1,
)

CN_TZ = timezone(timedelta(hours=8))
DIAGNOSIS_SCHEMA_VERSION = 1
DIAGNOSIS_KIND = "ai_diagnosis"
DIAGNOSIS_WORKFLOW_ID = "stock-ai-diagnosis"
DIAGNOSIS_SEMANTIC_STEP_ID = "semantic_research"
DIAGNOSIS_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")
_DIAGNOSIS_ID_RE = re.compile(r"^diagnosis_[a-z0-9_]{8,96}$")
_RUN_FILE = "run.json"
_INPUT_FILE = "inputs.json"
_REPORT_FILE = "report.json"
_MARKDOWN_FILE = "report.md"

SemanticResearcher = Callable[..., Any | Awaitable[Any]]
FactorProvider = Callable[..., Any | Awaitable[Any]]


def _now() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        result = dump(mode="python")
        return dict(result) if isinstance(result, Mapping) else {}
    return {}


def _json_safe(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _json_safe(value.model_dump(mode="python"))
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (datetime, timezone)):
        return value.isoformat()
    return value


def _instrument(value: Any) -> InstrumentTag:
    if isinstance(value, InstrumentTag):
        return value
    return InstrumentTag.model_validate(value)


def _source_ids(value: Any) -> list[str]:
    found: list[str] = []

    def visit(item: Any) -> None:
        if isinstance(item, Mapping):
            raw = item.get("source_ids")
            if isinstance(raw, list):
                for source_id in raw:
                    if isinstance(source_id, str) and source_id and source_id not in found:
                        found.append(source_id)
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return found


def _source_ids_from_evidence(bundle: Mapping[str, Any]) -> list[str]:
    values = bundle.get("source_ids")
    result = [item for item in values or [] if isinstance(item, str) and item]
    for item in _source_ids(bundle):
        if item not in result:
            result.append(item)
    return result


def _horizon_value(value: Any, horizon: str) -> dict[str, Any]:
    raw = _mapping(value)
    item = raw.get(horizon)
    if isinstance(item, Mapping):
        return dict(item)
    nested = raw.get("horizons")
    if isinstance(nested, Mapping) and isinstance(nested.get(horizon), Mapping):
        return dict(nested[horizon])
    return raw


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _snapshot_status(raw: Mapping[str, Any], *, fallback: str = "unavailable") -> DiagnosisAvailability:
    value = str(raw.get("status") or raw.get("availability") or "").lower()
    if value in {"available", "ready", "complete", "ok"}:
        return "available"
    if value in {"degraded", "partial"}:
        return "degraded"
    return fallback  # type: ignore[return-value]


def _factor_score(raw: Mapping[str, Any]) -> float | None:
    for key in ("factor_score", "score", "composite_score", "composite"):
        value = _number(raw.get(key))
        if value is None:
            continue
        if 0 <= value <= 1:
            return value
        if -1 <= value <= 1:
            return (value + 1) / 2
    direction = str(raw.get("direction") or raw.get("signal") or "").lower()
    if direction in {"positive", "bullish", "outperform", "strong"}:
        return 1.0
    if direction in {"neutral", "inline", "mixed"}:
        return 0.5
    if direction in {"negative", "bearish", "underperform", "weak"}:
        return 0.0
    factors = raw.get("factors")
    if isinstance(factors, list):
        values = [_factor_score(_mapping(item)) for item in factors]
        values = [item for item in values if item is not None]
        if values:
            return sum(values) / len(values)
    return None


def _validation(raw: Mapping[str, Any], *, quant: bool, status: str) -> str:
    value = str(
        raw.get("validation_status")
        or raw.get("validationStatus")
        or raw.get("oos_status")
        or ""
    ).lower()
    if value in {"calibrated", "validated", "passed"}:
        return "calibrated"
    if value in {"rejected", "invalid"}:
        return "rejected"
    if value in {"unavailable", "missing", "not_available"}:
        return "unavailable"
    if quant and (
        _factor_score(raw) is not None
        or raw.get("direction") is not None
        or raw.get("signal") is not None
    ):
        return "descriptive"
    return "descriptive" if status != "unavailable" else "unavailable"


def _factor_rows(raw: Mapping[str, Any]) -> list[DiagnosisFactor]:
    values = raw.get("factors")
    if not isinstance(values, list):
        values = raw.get("factor_values")
    if not isinstance(values, list):
        values = raw.get("factor_observations")
    if not isinstance(values, list):
        return []
    result: list[DiagnosisFactor] = []
    for index, item in enumerate(values):
        value = _mapping(item)
        name = (
            value.get("name")
            or value.get("id")
            or value.get("factor")
            or value.get("field")
            or f"factor_{index + 1}"
        )
        if not isinstance(name, str) or not name.strip():
            continue
        percentile = _number(value.get("percentile", value.get("percentile_or_rank")))
        if percentile is not None and not 0 <= percentile <= 1:
            percentile = None
        direction = value.get("direction") or value.get("signal")
        if direction not in {"positive", "neutral", "negative", "unavailable", None}:
            # Quant observations expose the ranking polarity (asc/desc),
            # while the report contract exposes the resulting signal.  The
            # favorable percentile is the single source for that mapping.
            direction = (
                "positive" if percentile is not None and percentile >= 0.70
                else "negative" if percentile is not None and percentile <= 0.30
                else "neutral" if percentile is not None
                else "unavailable"
            )
        result.append(
            DiagnosisFactor(
                name=name.strip(),
                value=_number(value.get("value", value.get("raw_value"))),
                percentile=percentile,
                direction=direction,
                weight=_number(value.get("weight")),
                contribution=_number(value.get("contribution")),
                source_ids=[
                    item for item in value.get("source_ids") or []
                    if isinstance(item, str) and item
                ],
            )
        )
    return result


def _factor_contributions(raw: Mapping[str, Any]) -> dict[str, float]:
    value = raw.get("factor_contributions")
    if not isinstance(value, Mapping):
        value = raw.get("contributions")
    result: dict[str, float] = {}
    if isinstance(value, Mapping):
        for key, item in value.items():
            number = _number(item)
            if number is not None:
                result[str(key)] = number
    for factor in _factor_rows(raw):
        if factor.contribution is not None:
            result[factor.name] = factor.contribution
    return result


def _factor_horizon(raw_value: Any, horizon: str, *, quant: bool) -> DiagnosisFactorHorizon:
    raw = _horizon_value(raw_value, horizon)
    explicit_data = bool(raw)
    score = _factor_score(raw)
    status = _snapshot_status(raw, fallback="available" if explicit_data and score is not None else "unavailable")
    validation = _validation(raw, quant=quant, status=status)
    sample_count_raw = raw.get("sample_count")
    if sample_count_raw is None:
        sample_count_raw = raw.get("market_sample_count")
    if sample_count_raw is None and isinstance(raw.get("sample_counts"), Mapping):
        sample_count_raw = raw["sample_counts"].get("effective")
    sample_count = int(sample_count_raw) if isinstance(sample_count_raw, int) and sample_count_raw >= 0 else None
    industry_count_raw = raw.get("industry_sample_count")
    industry_count = int(industry_count_raw) if isinstance(industry_count_raw, int) and industry_count_raw >= 0 else None
    market_percentile = _number(raw.get("market_percentile"))
    industry_percentile = _number(raw.get("industry_percentile"))
    if market_percentile is not None and not 0 <= market_percentile <= 1:
        market_percentile = None
    if industry_percentile is not None and not 0 <= industry_percentile <= 1:
        industry_percentile = None

    # The minimum market cross-section is a hard contract, not an implicit
    # neutral fallback.  Keep sample metadata but clear conclusion score and
    # percentiles when the sample cannot support a ranking (including when
    # the adapter did not report the sample count).
    fallback_scope = str(raw.get("fallback_scope") or "none")
    if fallback_scope == "market_fallback":
        fallback_scope = "market"
    elif fallback_scope not in {"none", "market", "unavailable"}:
        scope = str(raw.get("scope") or "")
        fallback_scope = "market" if scope == "market_fallback" else "none"
    if quant and (sample_count is None or sample_count < 30):
        status = "unavailable"
        validation = "unavailable"
        score = None
        market_percentile = None
        industry_percentile = None
        fallback_scope = "unavailable"
    elif industry_count is not None and industry_count < 5:
        industry_percentile = None
        if market_percentile is not None:
            fallback_scope = "market"

    if fallback_scope not in {"none", "market", "unavailable"}:
        fallback_scope = "none"
    rank = raw.get("rank")
    rank = int(rank) if isinstance(rank, int) and rank >= 1 else None
    missing_count = raw.get("missing_count")
    missing_count = int(missing_count) if isinstance(missing_count, int) and missing_count >= 0 else None
    source_ids = [item for item in raw.get("source_ids") or [] if isinstance(item, str) and item]
    for factor in _factor_rows(raw):
        for source_id in factor.source_ids:
            if source_id not in source_ids:
                source_ids.append(source_id)
    return DiagnosisFactorHorizon(
        status=status,
        validation_status=validation,
        factor_score=score,
        market_percentile=market_percentile,
        industry_percentile=industry_percentile,
        rank=rank,
        sample_count=sample_count,
        industry_sample_count=industry_count,
        missing_count=missing_count,
        fallback_scope=fallback_scope,
        factors=_factor_rows(raw),
        factor_contributions=_factor_contributions(raw),
        method_version=str(raw.get("method_version") or raw.get("method") or "unavailable"),
        source_ids=source_ids,
    )


def build_factor_snapshot(raw_value: Any, *, quant: bool) -> DiagnosisFactorSnapshot:
    """Normalize a stage-A/B factor result into the v1 snapshot contract."""

    raw = _mapping(raw_value)
    if quant:
        # The production quant adapter returns both the persisted snapshot
        # metadata and the per-horizon validation view.  The report contract
        # consumes the latter; keep the metadata available for source/hash
        # projection without treating the wrapper itself as a factor row.
        snapshot = raw.get("quant_snapshot")
        validation = raw.get("quant_validation")
        if isinstance(snapshot, Mapping) or isinstance(validation, Mapping):
            merged = dict(snapshot) if isinstance(snapshot, Mapping) else {}
            merged.update(raw)
            if isinstance(validation, Mapping):
                merged.update(validation)
            raw = merged
    horizons = {
        horizon: _factor_horizon(raw, horizon, quant=quant) for horizon in HORIZONS
    }
    snapshot_as_of = raw.get("snapshot_as_of") or raw.get("as_of")
    snapshot_as_of = snapshot_as_of if isinstance(snapshot_as_of, str) else None
    sample_count = raw.get("sample_count")
    sample_count = int(sample_count) if isinstance(sample_count, int) and sample_count >= 0 else None
    if sample_count is None and quant:
        horizon_samples = [
            getattr(snapshot, "sample_count")
            for snapshot in horizons.values()
            if getattr(snapshot, "sample_count") is not None
        ]
        if horizon_samples:
            sample_count = min(horizon_samples)
    missing_count = raw.get("missing_count")
    missing_count = int(missing_count) if isinstance(missing_count, int) and missing_count >= 0 else None
    return DiagnosisFactorSnapshot(
        short_term=horizons["short_term"],
        medium_term=horizons["medium_term"],
        long_term=horizons["long_term"],
        snapshot_as_of=snapshot_as_of,
        universe_definition=(
            raw.get("universe_definition")
            if isinstance(raw.get("universe_definition"), str)
            else (raw.get("pool_definition") if isinstance(raw.get("pool_definition"), str) else None)
        ),
        content_hash=(
            raw.get("content_hash")
            if isinstance(raw.get("content_hash"), str)
            else (canonical_input_hash(raw) if raw else None)
        ),
        sample_count=sample_count,
        missing_count=missing_count,
        source_ids=_source_ids(raw),
    )


def _semantic_to_research(value: Any, *, instrument: InstrumentTag, context_id: str) -> DiagnosisFundamentalResearch:
    if isinstance(value, DiagnosisFundamentalResearch):
        return value
    if isinstance(value, DiagnosisSemanticSubmission):
        if value.instrument is not None and value.instrument != instrument:
            raise ValueError("semantic submission instrument does not match diagnosis instrument")
        if value.evidence_context_id is not None and value.evidence_context_id != context_id:
            raise ValueError("semantic submission evidence_context_id does not match diagnosis context")
        payload = value.model_dump(mode="python")
        payload.pop("schema_version", None)
        payload.pop("instrument", None)
        payload.pop("evidence_context_id", None)
        payload["status"] = "available"
        return DiagnosisFundamentalResearch.model_validate(payload)
    raw = _mapping(value)
    if not raw:
        return DiagnosisFundamentalResearch(status="unavailable")
    # Callback results arrive as JSON mappings.  Validate the submission
    # contract before projecting it into the persisted research section so
    # trusted identity and the semantic-only field boundary remain enforced.
    if "evidence_context_id" in raw or "schema_version" in raw:
        submission = DiagnosisSemanticSubmission.model_validate(raw)
        return _semantic_to_research(
            submission,
            instrument=instrument,
            context_id=context_id,
        )
    payload = dict(raw)
    payload.setdefault("status", "available")
    return DiagnosisFundamentalResearch.model_validate(payload)


def _evidence_bundle(workspace: Path, context_id: str | None, direct: Any) -> dict[str, Any]:
    if isinstance(direct, Mapping):
        return dict(direct)
    if not context_id:
        return {}
    # Keep the context read-only and avoid constructing an EvidenceService with
    # a provider just to read a persisted context.
    context_path = workspace / "stock_contexts" / f"{context_id}.json"
    if not context_path.is_file():
        return {}
    payload = json.loads(context_path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        return {}
    symbols = payload.get("symbols")
    if isinstance(symbols, Mapping) and len(symbols) == 1:
        bundle = next(iter(symbols.values()))
        return dict(bundle) if isinstance(bundle, Mapping) else {}
    # A direct bundle may be stored by a stage adapter under ``bundle``.
    bundle = payload.get("bundle")
    return dict(bundle) if isinstance(bundle, Mapping) else {}


def _default_factor_input(bundle: Mapping[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        value = bundle.get(name)
        if value is not None:
            return value
    return None


def _fundamental_research_from_bundle(bundle: Mapping[str, Any], explicit: Any) -> Any:
    if explicit is not None:
        return explicit
    return _default_factor_input(
        bundle,
        ("fundamental_research", "semantic_research", "company_research"),
    )


def _technical_input(bundle: Mapping[str, Any], explicit: Any) -> Any:
    if explicit is not None:
        return explicit
    return _default_factor_input(
        bundle,
        ("technical_execution", "execution", "derived_decision_metrics"),
    )


def _fundamental_factor_input(bundle: Mapping[str, Any], explicit: Any) -> Any:
    if explicit is not None:
        return explicit
    return _default_factor_input(
        bundle,
        ("fundamental_factors", "fundamental_factor_snapshot", "fundamentals"),
    )


def _quant_factor_input(bundle: Mapping[str, Any], explicit: Any) -> Any:
    if explicit is not None:
        return explicit
    return _default_factor_input(
        bundle,
        ("quant_factors", "quantitative_factors", "quant_validation", "quant_snapshot", "quant_signal"),
    )


def _has_usable_quant_cross_section(value: Any) -> bool:
    raw = _mapping(value)
    validation = raw.get("quant_validation")
    if isinstance(validation, Mapping):
        raw = dict(validation)
    short = _horizon_value(raw, "short_term")
    sample = short.get("sample_count")
    if sample is None:
        sample = short.get("market_sample_count")
    if sample is None and isinstance(short.get("sample_counts"), Mapping):
        sample = short["sample_counts"].get("effective")
    return isinstance(sample, int) and not isinstance(sample, bool) and sample >= 30


def _quant_percentile_map(value: Any) -> dict[str, float]:
    """Project shared cross-sectional percentiles into fundamental factors."""

    raw_value = _mapping(value)
    validation = raw_value.get("quant_validation")
    if isinstance(validation, Mapping):
        value = validation
    result: dict[str, float] = {}
    for horizon in ("long_term", "medium_term", "short_term"):
        raw = _horizon_value(value, horizon)
        observations = raw.get("factor_observations")
        if not isinstance(observations, list):
            observations = raw.get("factors")
        if not isinstance(observations, list):
            continue
        for observation in observations:
            item = _mapping(observation)
            field = item.get("field") or item.get("name") or item.get("factor")
            percentile = _number(item.get("percentile_or_rank") or item.get("percentile"))
            if (
                isinstance(field, str)
                and field
                and percentile is not None
                and 0 <= percentile <= 1
                and field not in result
            ):
                result[field] = percentile
    return result


def _fundamental_percentile_map(
    bundle: Mapping[str, Any], quant_value: Any
) -> dict[str, float]:
    """Prefer verified same-industry valuation ranks, then shared market ranks."""

    result = _quant_percentile_map(quant_value)
    valuation = _mapping(bundle.get("valuation"))
    relative_positions = _mapping(valuation.get("relative_positions"))
    company_quality = _mapping(bundle.get("company_quality"))
    valuation_context = _mapping(company_quality.get("valuation_context"))
    for factor_id in ("pe", "pb"):
        candidates = [
            _mapping(relative_positions.get(factor_id)).get("percentile"),
            _mapping(valuation_context.get(factor_id)).get("percentile"),
            _mapping(_mapping(valuation.get("assessment")).get(factor_id)).get("percentile"),
        ]
        percentile = next(
            (
                value
                for candidate in candidates
                if (value := _number(candidate)) is not None and 0 <= value <= 1
            ),
            None,
        )
        if percentile is not None:
            result[factor_id] = percentile
    return result


def _factor_lookup(snapshot: DiagnosisFactorSnapshot) -> dict[str, DiagnosisFactor]:
    return {factor.name: factor for factor in snapshot.short_term.factors}


def _basis_source_ids(*values: Any) -> list[str]:
    result: list[str] = []
    for value in values:
        payload = value.model_dump(mode="python") if hasattr(value, "model_dump") else value
        for source_id in _source_ids(payload):
            if source_id not in result:
                result.append(source_id)
    return result


def _decision_basis_rows(
    *,
    evidence: Mapping[str, Any],
    fundamental_research: DiagnosisFundamentalResearch,
    fundamental_factors: DiagnosisFactorSnapshot,
    quant_factors: DiagnosisFactorSnapshot,
    technical_input: Any,
    current_decision: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Build the four user-facing conclusions from deterministic outputs."""

    fundamental = _factor_lookup(fundamental_factors)
    quant = _factor_lookup(quant_factors)
    fundamental_score = fundamental_factors.short_term.factor_score
    if fundamental_research.business_understandable is False:
        fundamental_stance, fundamental_label = "negative", "回避"
    elif fundamental_score is None:
        fundamental_stance, fundamental_label = "cautious", "谨慎"
    elif fundamental_score >= 0.65:
        fundamental_stance, fundamental_label = "positive", "偏强"
    elif fundamental_score <= 0.35:
        fundamental_stance, fundamental_label = "negative", "偏弱"
    else:
        fundamental_stance, fundamental_label = "neutral", "中性"

    revenue_growth = getattr(fundamental.get("revenue_yoy"), "value", None)
    profit_growth = getattr(fundamental.get("profit_yoy"), "value", None)
    cashflow_ratio = getattr(fundamental.get("cashflow_to_profit"), "value", None)
    fundamental_parts: list[str] = []
    if isinstance(revenue_growth, (int, float)) and isinstance(profit_growth, (int, float)):
        if revenue_growth > 0 and profit_growth > 0:
            fundamental_parts.append("盈利修复")
        elif revenue_growth < 0 and profit_growth < 0:
            fundamental_parts.append("营收与利润承压")
        else:
            fundamental_parts.append("营收与利润分化")
    if isinstance(cashflow_ratio, (int, float)):
        if cashflow_ratio < 0.8:
            fundamental_parts.append("现金流偏弱")
        elif cashflow_ratio >= 1:
            fundamental_parts.append("现金流匹配利润")
        else:
            fundamental_parts.append("现金流尚可")
    if not fundamental_parts:
        fundamental_parts.append(
            "盈利与现金流需重新诊股"
            if fundamental_research.status == "unavailable"
            else "经营结论已形成，因子评分待更新"
        )

    direction = str(current_decision.get("direction") or "unavailable")
    action = str(current_decision.get("action") or "avoid")
    if direction == "positive":
        quant_stance, quant_label = "positive", "偏多"
    elif direction == "negative" or action in {"avoid", "reduce", "exit"}:
        quant_stance, quant_label = "negative", "偏空"
    elif direction == "neutral":
        quant_stance, quant_label = "neutral", "中性"
    else:
        quant_stance, quant_label = "cautious", "谨慎"

    valuation_percentiles = [
        factor.percentile
        for name in ("pe", "pb")
        if (factor := fundamental.get(name)) is not None and factor.percentile is not None
    ]
    quant_parts: list[str] = []
    if valuation_percentiles:
        valuation_score = sum(valuation_percentiles) / len(valuation_percentiles)
        quant_parts.append(
            "估值偏高" if valuation_score <= 0.30
            else "估值偏低" if valuation_score >= 0.70
            else "估值居中"
        )
    momentum20 = getattr(quant.get("momentum20"), "value", None)
    if isinstance(momentum20, (int, float)):
        quant_parts.append(
            "短期动量走弱" if momentum20 < 0
            else "短期动量向上" if momentum20 > 0
            else "短期动量平稳"
        )
    if not quant_parts:
        quant_parts.append(
            "短期趋势走弱" if quant_label == "偏空"
            else "量价信号偏强" if quant_label == "偏多"
            else "量价信号分化"
        )

    sentiment = _mapping(evidence.get("market_sentiment"))
    sentiment_direction = str(sentiment.get("direction") or sentiment.get("label") or "暂不判断")
    technical = _mapping(technical_input)
    trend = str(_mapping(technical.get("trend")).get("value") or "").lower()
    if sentiment_direction == "偏多" and trend not in {"down", "negative", "bearish"}:
        sentiment_stance, sentiment_label = "positive", "积极"
        sentiment_summary = "市场偏多，个股趋势同步"
    elif sentiment_direction == "偏空":
        sentiment_stance, sentiment_label = "cautious", "谨慎"
        sentiment_summary = "市场偏弱，不提高仓位"
    elif sentiment_direction == "偏多":
        sentiment_stance, sentiment_label = "cautious", "谨慎"
        sentiment_summary = "市场偏多，但个股尚未转强"
    elif trend in {"down", "negative", "bearish"} or quant_label == "偏空":
        sentiment_stance, sentiment_label = "cautious", "谨慎"
        sentiment_summary = "市场信号分化，个股暂无反转信号"
    else:
        sentiment_stance, sentiment_label = "neutral", "中性"
        sentiment_summary = "市场信号分化，等待方向确认"

    not_holding = str(current_decision.get("not_holding_action") or "avoid")
    holding = str(current_decision.get("holding_action") or "reduce")
    if not_holding == "avoid" and holding == "exit":
        risk_summary = "回避新增，已持有执行退出"
    elif not_holding == "avoid" and holding == "reduce":
        risk_summary = "回避新增，已持有优先降风险"
    elif not_holding == "conditional_participation":
        risk_summary = "满足买入条件再参与，持仓执行止损纪律"
    else:
        risk_summary = "暂不新增，持仓按止损与仓位纪律执行"

    rows = [
        DiagnosisDecisionBasisRow(
            key="fundamental",
            label="基本面",
            stance=fundamental_stance,
            stance_label=fundamental_label,
            summary="，".join(fundamental_parts),
            source_ids=_basis_source_ids(fundamental_research, fundamental_factors),
        ),
        DiagnosisDecisionBasisRow(
            key="quant",
            label="量化验证",
            stance=quant_stance,
            stance_label=quant_label,
            summary="，".join(quant_parts),
            source_ids=_basis_source_ids(fundamental_factors, quant_factors, technical_input),
        ),
        DiagnosisDecisionBasisRow(
            key="sentiment",
            label="情绪与预期",
            stance=sentiment_stance,
            stance_label=sentiment_label,
            summary=sentiment_summary,
            source_ids=_basis_source_ids(sentiment, evidence.get("public_opinion"), technical_input),
        ),
        DiagnosisDecisionBasisRow(
            key="risk",
            label="风控纪律",
            stance="strict",
            stance_label="严格",
            summary=risk_summary,
            source_ids=_basis_source_ids(current_decision, technical_input),
        ),
    ]
    return [row.model_dump(mode="python") for row in rows]


def _invoke_callable(callback: Callable[..., Any], *, evidence: Mapping[str, Any], instrument: InstrumentTag) -> Any:
    """Call an injected seam exactly once using its declared arity."""

    try:
        signature = inspect.signature(callback)
    except (TypeError, ValueError):
        return callback(evidence)
    positional = [
        parameter
        for parameter in signature.parameters.values()
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
    ]
    required = [parameter for parameter in positional if parameter.default is parameter.empty]
    if len(required) >= 2 or len(positional) >= 2:
        return callback(evidence, instrument)
    if positional:
        return callback(evidence)
    return callback()


async def _await_if_needed(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _fundamental_status(value: DiagnosisFundamentalResearch) -> DiagnosisAvailability:
    return value.status


def _data_quality(
    *,
    fundamental: DiagnosisFundamentalResearch,
    factors: DiagnosisFactorSnapshot,
    quant: DiagnosisFactorSnapshot,
    technical: DiagnosisTechnicalExecution,
    overall_confidence: str,
) -> DiagnosisDataQuality:
    missing: list[str] = []
    degraded: list[str] = []
    if fundamental.status == "unavailable":
        missing.append("fundamental_research")
    elif fundamental.status == "degraded":
        degraded.append("fundamental_research")
    for label, snapshot in (("fundamental_factors", factors), ("quant_factors", quant)):
        statuses = [getattr(snapshot, horizon).status for horizon in HORIZONS]
        if all(status == "unavailable" for status in statuses):
            missing.append(label)
        elif any(status != "available" for status in statuses):
            degraded.append(label)
    if technical.status == "unavailable":
        missing.append("technical_execution")
    elif technical.status == "degraded":
        degraded.append("technical_execution")
    status: str = "complete"
    if missing:
        status = "degraded"
    elif degraded:
        status = "degraded"
    return DiagnosisDataQuality(
        status=status,
        confidence=overall_confidence,  # type: ignore[arg-type]
        missing_fields=missing,
        degraded_fields=degraded,
        sample_counts={
            horizon: getattr(quant, horizon).sample_count
            for horizon in HORIZONS
            if getattr(quant, horizon).sample_count is not None
        },
    )


def _technical_report(value: Any, decision: Mapping[str, Any]) -> DiagnosisTechnicalExecution:
    raw = _mapping(value)
    statuses = []
    for horizon in HORIZONS:
        item = _horizon_value(value, horizon)
        if item:
            statuses.append(str(item.get("status") or "available"))
    status: DiagnosisAvailability = "available" if statuses and all(item in {"available", "ready", "complete", "ok"} for item in statuses) else ("degraded" if statuses else "unavailable")
    decisions = decision["horizon_decisions"]
    horizons = {horizon: decisions[horizon]["materialized_plan"] for horizon in HORIZONS}
    positions = {horizon: decisions[horizon]["position_plan"] for horizon in HORIZONS}
    return DiagnosisTechnicalExecution(
        status=status,
        source_ids=_source_ids(raw),
        horizons=horizons,
        position=positions,
        review_triggers={
            horizon: decisions[horizon]["review_trigger"] for horizon in HORIZONS
        },
        valid_until={
            horizon: decisions[horizon]["valid_until"] for horizon in HORIZONS
        },
    )


def _markdown(report: StockDiagnosisV1) -> str:
    labels = {"short_term": "短线", "medium_term": "中线", "long_term": "长线"}
    lines = [
        "# AI诊股报告",
        "",
        f"- 标的：{report.instrument.name or report.instrument.symbol}",
        f"- 诊股编号：{report.diagnosis_id}",
        f"- 研究截止：{report.research_cutoff_at}",
        f"- 数据质量：{report.data_quality.status}",
        "",
        "## 三周期确定性裁决",
    ]
    for horizon in HORIZONS:
        decision = getattr(report.horizon_decisions, horizon)
        lines.append(
            f"- {labels[horizon]}：方向 {decision.direction}；动作 {decision.action}；"
            f"可信度 {decision.confidence}；计划状态 {decision.materialized_plan.value_status}"
        )
    lines.extend(
        [
            "",
            "> 说明：本报告的方向、动作、计划和仓位由确定性代码生成；"
            "语义研究仅作为公司、行业、政策、周期和治理的结构化依据。",
        ]
    )
    return "\n".join(lines) + "\n"


class DiagnosisStorageError(RuntimeError):
    pass


class DiagnosisNotFoundError(KeyError):
    pass


class DiagnosisStateError(ValueError):
    pass


class DiagnosisStore:
    """Atomic JSON storage for standard diagnosis runs and reports."""

    def __init__(self, workspace: str | Path):
        candidate = Path(workspace).expanduser().resolve()
        if candidate.name == "stock_projects":
            candidate = candidate.parent
        self.workspace = candidate
        self.root = candidate / "stock_diagnoses"

    @staticmethod
    def _check_id(diagnosis_id: str) -> None:
        if not isinstance(diagnosis_id, str) or not _DIAGNOSIS_ID_RE.fullmatch(diagnosis_id):
            raise ValueError(f"invalid diagnosis_id {diagnosis_id!r}")

    def _dir(self, diagnosis_id: str) -> Path:
        self._check_id(diagnosis_id)
        return self.root / diagnosis_id

    @staticmethod
    def _atomic_write(path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(
            json.dumps(_json_safe(payload), ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(temporary, path)

    def _write_run(self, record: Mapping[str, Any]) -> None:
        self._atomic_write(self._dir(str(record["diagnosis_id"])) / _RUN_FILE, record)

    def read(self, diagnosis_id: str) -> dict[str, Any] | None:
        path = self._dir(diagnosis_id) / _RUN_FILE
        if not path.is_file():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise DiagnosisStorageError(f"cannot read diagnosis {diagnosis_id!r}: {exc}") from exc
        return dict(value) if isinstance(value, Mapping) else None

    def require(self, diagnosis_id: str) -> dict[str, Any]:
        record = self.read(diagnosis_id)
        if record is None:
            raise DiagnosisNotFoundError(diagnosis_id)
        return record

    def report(self, diagnosis_id: str) -> dict[str, Any] | None:
        path = self._dir(diagnosis_id) / _REPORT_FILE
        if not path.is_file():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return dict(value) if isinstance(value, Mapping) else None

    def markdown(self, diagnosis_id: str) -> str:
        path = self._dir(diagnosis_id) / _MARKDOWN_FILE
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def save_inputs(self, diagnosis_id: str, payload: Mapping[str, Any]) -> None:
        self._atomic_write(self._dir(diagnosis_id) / _INPUT_FILE, payload)

    def load_inputs(self, diagnosis_id: str) -> dict[str, Any]:
        path = self._dir(diagnosis_id) / _INPUT_FILE
        if not path.is_file():
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
        return dict(value) if isinstance(value, Mapping) else {}

    def save_report(self, report: StockDiagnosisV1) -> None:
        directory = self._dir(report.diagnosis_id)
        self._atomic_write(directory / _REPORT_FILE, report.model_dump(mode="json"))
        temporary = directory / (_MARKDOWN_FILE + ".tmp")
        temporary.write_text(_markdown(report), encoding="utf-8")
        os.replace(temporary, directory / _MARKDOWN_FILE)

    def list(self, *, instrument_id: str | None = None, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        values: list[dict[str, Any]] = []
        for path in self.root.iterdir():
            if not path.is_dir() or not _DIAGNOSIS_ID_RE.fullmatch(path.name):
                continue
            try:
                record = self.read(path.name)
            except DiagnosisStorageError:
                continue
            if record is None:
                continue
            instrument = record.get("instrument")
            found_id = None
            if isinstance(instrument, Mapping):
                found_id = f"{instrument.get('exchange')}:{instrument.get('symbol')}"
            if instrument_id and found_id != instrument_id:
                continue
            if status and record.get("status") != status:
                continue
            values.append(record)
        values.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
        return values[: max(1, min(int(limit), 200))]

    def delete(self, diagnosis_id: str) -> dict[str, Any]:
        record = self.require(diagnosis_id)
        if record.get("status") not in {"succeeded", "failed", "cancelled"}:
            raise DiagnosisStateError("cannot delete an active diagnosis")
        directory = self._dir(diagnosis_id).resolve()
        root = self.root.resolve()
        if directory.parent != root:
            raise DiagnosisStorageError("diagnosis directory is outside the storage root")
        try:
            shutil.rmtree(directory)
        except OSError as exc:
            raise DiagnosisStorageError(f"cannot delete diagnosis {diagnosis_id!r}: {exc}") from exc
        return record


class DiagnosisService:
    """Create, execute and manage standard diagnosis runs."""

    def __init__(
        self,
        workspace: str | Path,
        *,
        semantic_researcher: SemanticResearcher | None = None,
        fundamental_provider: FactorProvider | None = None,
        quant_provider: FactorProvider | None = None,
        technical_provider: FactorProvider | None = None,
        evidence_service: EvidenceService | None = None,
        provider: Any | None = None,
        cache_root: str | Path | None = None,
    ):
        self.store = DiagnosisStore(workspace)
        self.semantic_researcher = semantic_researcher
        self.fundamental_provider = fundamental_provider
        self.quant_provider = quant_provider
        self.technical_provider = technical_provider
        self.provider = provider if provider is not None else getattr(evidence_service, "provider", None)
        self.cache_root = Path(cache_root or (Path.home() / ".mona" / "stock" / "cache"))
        self.evidence_service = evidence_service
        self._prepared_contexts: dict[str, dict[str, Any]] = {}
        if self.evidence_service is None and provider is not None:
            # Production callers provide the same failover provider used by
            # the stock Evidence path.  This keeps direct service callers on
            # the immutable-context contract without requiring API globals.
            self.evidence_service = EvidenceService(
                workspace=self.store.workspace,
                provider=provider,
                cache_root=self.cache_root,
            )

    @staticmethod
    def _instrument_ref(instrument: InstrumentTag) -> InstrumentRef:
        return InstrumentRef(
            exchange=instrument.exchange,
            symbol=instrument.symbol,
            instrument_type=instrument.instrument_type,
        )

    @staticmethod
    def _context_bundle(
        context_id: str,
        instrument: InstrumentTag,
        context: Any,
        *,
        expected_cutoff: str | None = None,
        diagnosis_id: str | None = None,
    ) -> dict[str, Any]:
        """Validate an immutable Evidence context before using its bundle."""

        if not isinstance(context, Mapping) or context.get("context_id") != context_id:
            raise ValueError("evidence context is invalid")
        owner = context.get("owner")
        if not isinstance(owner, Mapping):
            raise ValueError("evidence context owner is missing")
        owner_kind = str(owner.get("kind") or "")
        if owner_kind not in {"stock_preflight", "ai_diagnosis", "direct_chat"}:
            raise ValueError("evidence context owner is not valid for standard diagnosis")
        if owner.get("workflow_run_id") or owner.get("run_id"):
            raise ValueError("evidence context belongs to a deep-research run")
        owner_diagnosis_id = owner.get("diagnosis_id") or owner.get("diagnosisId")
        if owner_diagnosis_id and diagnosis_id and str(owner_diagnosis_id) != diagnosis_id:
            raise ValueError("evidence context owner does not match diagnosis")
        symbols = context.get("symbols")
        instrument_id = f"{instrument.exchange}:{instrument.symbol}"
        bundle = symbols.get(instrument_id) if isinstance(symbols, Mapping) else None
        if not isinstance(bundle, Mapping):
            raise ValueError("evidence context instrument mismatch")
        bundle_instrument = bundle.get("instrument")
        actual_id = None
        if isinstance(bundle_instrument, Mapping):
            actual_id = f"{bundle_instrument.get('exchange')}:{bundle_instrument.get('symbol')}"
        if actual_id != instrument_id:
            raise ValueError("evidence context instrument mismatch")
        cutoff = bundle.get("research_cutoff_at")
        if not isinstance(cutoff, str) or not cutoff.strip():
            raise ValueError("evidence context cutoff is missing")
        from mona.services.stock.provenance import parse_asia_datetime

        if parse_asia_datetime(cutoff) is None:
            raise ValueError("evidence context cutoff is invalid")
        if expected_cutoff is not None:
            from mona.services.stock.provenance import normalize_asia_datetime

            if normalize_asia_datetime(cutoff) != normalize_asia_datetime(expected_cutoff):
                raise ValueError("evidence context cutoff mismatch")
        return dict(bundle)

    async def prepare_context(
        self,
        *,
        instrument: Any,
        evidence_context_id: str | None = None,
        research_cutoff_at: str | None = None,
        diagnosis_id: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Load a supplied context or build one exactly once for a run."""

        instrument_model = _instrument(instrument)
        context_id = (evidence_context_id or "").strip()
        if context_id:
            if self.evidence_service is None:
                raise ValueError("evidence context service is unavailable")
            read_context = getattr(self.evidence_service, "read_context", None)
            if not callable(read_context):
                raise ValueError("evidence context reader is unavailable")
            context = read_context(context_id)
            if context is None:
                raise ValueError(f"evidence context {context_id!r} not found")
            bundle = self._context_bundle(
                context_id,
                instrument_model,
                context,
                expected_cutoff=research_cutoff_at,
                diagnosis_id=diagnosis_id,
            )
            self._prepared_contexts[context_id] = dict(context)
            return context_id, bundle
        if self.evidence_service is None:
            raise ValueError("evidence service is unavailable")
        context_id = f"ctx_{uuid.uuid4().hex}"
        build_context = getattr(self.evidence_service, "build_context", None)
        if not callable(build_context):
            raise ValueError("evidence context builder is unavailable")
        context = await _await_if_needed(
            build_context(
                context_id,
                self._instrument_ref(instrument_model),
                research_cutoff_at=research_cutoff_at,
                name=instrument_model.name or "",
                owner={"kind": "ai_diagnosis"},
            )
        )
        bundle = self._context_bundle(
            context_id,
            instrument_model,
            context,
            expected_cutoff=research_cutoff_at,
            diagnosis_id=diagnosis_id,
        )
        self._prepared_contexts[context_id] = dict(context)
        return context_id, bundle

    def create(
        self,
        *,
        instrument: Any,
        evidence_context_id: str | None = None,
        evidence: Any = None,
        fundamental_research: Any = None,
        fundamental_factors: Any = None,
        quant_factors: Any = None,
        technical_execution: Any = None,
        holding_state: str = "not_holding",
        research_cutoff_at: str | None = None,
        market_as_of: str | None = None,
        semantic_research: Any = None,
        user_context: Any = None,
        diagnosis_id: str | None = None,
    ) -> dict[str, Any]:
        instrument_model = _instrument(instrument)
        context_id = (evidence_context_id or "direct_input").strip()
        if not context_id:
            raise ValueError("evidence_context_id must not be blank")
        diagnosis_id = diagnosis_id or f"diagnosis_{uuid.uuid4().hex}"
        self.store._check_id(diagnosis_id)
        if self.store.read(diagnosis_id) is not None:
            raise DiagnosisStateError(f"diagnosis {diagnosis_id!r} already exists")
        now = _now()
        input_payload = {
            "instrument": instrument_model.model_dump(mode="python"),
            "evidence_context_id": context_id,
            "evidence": _json_safe(evidence),
            "fundamental_research": _json_safe(fundamental_research),
            "fundamental_factors": _json_safe(fundamental_factors),
            "quant_factors": _json_safe(quant_factors),
            "technical_execution": _json_safe(technical_execution),
            "holding_state": "holding" if holding_state == "holding" else "not_holding",
            "research_cutoff_at": research_cutoff_at,
            "market_as_of": market_as_of,
            "semantic_research": _json_safe(semantic_research),
            "user_context": _json_safe(user_context),
        }
        record = {
            "schema_version": DIAGNOSIS_SCHEMA_VERSION,
            "kind": "ai_diagnosis_run",
            "diagnosis_id": diagnosis_id,
            "workflow_id": DIAGNOSIS_WORKFLOW_ID,
            "status": "queued",
            "instrument": instrument_model.model_dump(mode="python"),
            "evidence_context_id": context_id,
            "created_at": now,
            "updated_at": now,
            "attempt": 1,
            "agent_steps": [],
            "agent_step_count": 0,
            "llm_agent_steps": 0,
            "error": None,
            "input_hash": canonical_input_hash(input_payload),
            "holding_state": input_payload["holding_state"],
        }
        self.store.save_inputs(diagnosis_id, input_payload)
        self.store._write_run(record)
        return record

    def get(self, diagnosis_id: str, *, include_report: bool = True) -> dict[str, Any]:
        record = self.store.require(diagnosis_id)
        result = dict(record)
        if include_report:
            report = self.store.report(diagnosis_id)
            if report is not None:
                result["report"] = report
                result["markdown"] = self.store.markdown(diagnosis_id)
        return result

    def list(self, **kwargs: Any) -> list[dict[str, Any]]:
        return self.store.list(**kwargs)

    def delete(self, diagnosis_id: str) -> dict[str, Any]:
        return self.store.delete(diagnosis_id)

    def _update(self, record: dict[str, Any], **updates: Any) -> dict[str, Any]:
        updated = dict(record)
        updated.update(updates)
        updated["updated_at"] = _now()
        self.store._write_run(updated)
        return updated

    def cancel(self, diagnosis_id: str, *, reason: str = "cancelled by user") -> dict[str, Any]:
        record = self.store.require(diagnosis_id)
        if record.get("status") in {"succeeded", "failed", "cancelled"}:
            if record.get("status") == "cancelled":
                return record
            raise DiagnosisStateError(f"cannot cancel terminal diagnosis {diagnosis_id!r}")
        return self._update(record, status="cancelled", error=reason)

    def fail(self, diagnosis_id: str, *, reason: str, code: str = "diagnosis_failed") -> dict[str, Any]:
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("failure reason must not be blank")
        record = self.store.require(diagnosis_id)
        if record.get("status") == "succeeded":
            raise DiagnosisStateError(f"cannot fail succeeded diagnosis {diagnosis_id!r}")
        return self._update(record, status="failed", error=reason.strip(), error_code=code)

    def retry(self, diagnosis_id: str) -> dict[str, Any]:
        record = self.store.require(diagnosis_id)
        if record.get("status") not in {"failed", "cancelled"}:
            raise DiagnosisStateError("only failed or cancelled diagnoses can be retried")
        attempt = int(record.get("attempt") or 1) + 1
        return self._update(
            record,
            status="queued",
            attempt=attempt,
            error=None,
            error_code=None,
            agent_steps=[],
            agent_step_count=0,
            llm_agent_steps=0,
        )

    async def _default_fundamental_factors(
        self,
        evidence: Mapping[str, Any],
        instrument: InstrumentTag,
        *,
        percentile_map: Mapping[str, float] | None = None,
    ) -> dict[str, Any]:
        history = evidence.get("fundamentals_history")
        return build_fundamental_factors(
            evidence,
            history=history if isinstance(history, list) else None,
            percentile_map=percentile_map,
            source_ids=_source_ids(evidence),
            as_of=evidence.get("as_of") if isinstance(evidence.get("as_of"), str) else None,
            research_cutoff_at=(
                evidence.get("research_cutoff_at")
                if isinstance(evidence.get("research_cutoff_at"), str)
                else None
            ),
        )

    async def _default_quant_factors(
        self, evidence: Mapping[str, Any], instrument: InstrumentTag
    ) -> dict[str, Any]:
        as_of = next(
            (
                evidence.get(name)
                for name in ("market_as_of", "as_of", "research_cutoff_at")
                if isinstance(evidence.get(name), str) and evidence.get(name)
            ),
            None,
        )
        cache = await _await_if_needed(
            ensure_diagnosis_cross_section_cache(
                provider=self.provider,
                cache_root=self.cache_root,
                workspace=self.store.workspace,
                as_of=as_of,
            )
        )
        rows = cache.get("rows") if isinstance(cache, Mapping) else []
        factors = cache.get("factors") if isinstance(cache, Mapping) else {}
        status = cache.get("status") if isinstance(cache, Mapping) else "unavailable"
        result = build_diagnosis_quant_payload(
            evidence,
            f"{instrument.exchange}:{instrument.symbol}",
            cache_root=self.cache_root,
            market_rows=rows if isinstance(rows, list) else [],
            cached_factors=factors if isinstance(factors, Mapping) else {},
            cache_status=status if isinstance(status, str) else "unavailable",
        )
        return result if isinstance(result, Mapping) else {}

    async def execute(self, diagnosis_id: str) -> dict[str, Any]:
        record = self.store.require(diagnosis_id)
        if record.get("status") == "cancelled":
            return self.get(diagnosis_id)
        if record.get("status") == "succeeded":
            return self.get(diagnosis_id)
        record = self._update(record, status="running", error=None, error_code=None)
        inputs = self.store.load_inputs(diagnosis_id)
        instrument = _instrument(inputs.get("instrument") or record.get("instrument"))
        context_id = str(inputs.get("evidence_context_id") or record.get("evidence_context_id") or "")
        direct_evidence = inputs.get("evidence")
        if context_id == "direct_input" and not isinstance(direct_evidence, Mapping) and self.evidence_service is not None:
            try:
                context_id, _bundle = await self.prepare_context(
                    instrument=instrument,
                    research_cutoff_at=inputs.get("research_cutoff_at"),
                    diagnosis_id=diagnosis_id,
                )
                inputs["evidence_context_id"] = context_id
                self.store.save_inputs(diagnosis_id, inputs)
                record = self._update(record, evidence_context_id=context_id)
            except ValueError as exc:
                return self.fail(
                    diagnosis_id,
                    reason=str(exc),
                    code="evidence_context_unavailable",
                )
        if isinstance(direct_evidence, Mapping):
            # Legacy service-level tests may provide a frozen bundle directly.
            # The HTTP adapter never accepts this path.
            evidence = dict(direct_evidence)
        elif context_id != "direct_input":
            try:
                if self.evidence_service is None:
                    raise ValueError("evidence context service is unavailable")
                read_context = getattr(self.evidence_service, "read_context", None)
                context = (
                    read_context(context_id)
                    if callable(read_context)
                    else self._prepared_contexts.get(context_id)
                )
                evidence = self._context_bundle(
                    context_id,
                    instrument,
                    context,
                    expected_cutoff=inputs.get("research_cutoff_at"),
                    diagnosis_id=diagnosis_id,
                )
            except ValueError as exc:
                code = "evidence_context_mismatch" if "mismatch" in str(exc) or "owner" in str(exc) or "cutoff" in str(exc) else "evidence_context_not_found"
                return self.fail(diagnosis_id, reason=str(exc), code=code)
        else:
            evidence = {}
        agent_steps: list[dict[str, Any]] = []
        try:
            semantic = inputs.get("semantic_research")
            if semantic is None and self.semantic_researcher is not None:
                # This is the single and only LLM boundary.  The callback must
                # return the strict semantic contract; no second synthesis
                # callback or LLM referee is ever invoked.
                started_at = _now()
                semantic_step = {
                    "step_id": DIAGNOSIS_SEMANTIC_STEP_ID,
                    "kind": "semantic_research",
                    "status": "running",
                    "started_at": started_at,
                }
                agent_steps.append(semantic_step)
                try:
                    result = _invoke_callable(
                        self.semantic_researcher,
                        evidence=evidence,
                        instrument=instrument,
                    )
                    semantic = await _await_if_needed(result)
                except Exception:
                    semantic_step["status"] = "failed"
                    semantic_step["completed_at"] = _now()
                    raise
                semantic_step["status"] = "succeeded"
                semantic_step["completed_at"] = _now()
            quant_input = inputs.get("quant_factors")
            if quant_input is None:
                # A workflow run may already contain the immutable
                # cross-section computed before the semantic Agent.  Reuse it
                # before attempting any provider/cache rebuild.
                immutable_quant = _quant_factor_input(evidence, None)
                if _has_usable_quant_cross_section(immutable_quant):
                    quant_input = immutable_quant
            if quant_input is None:
                try:
                    if self.quant_provider is not None:
                        quant_input = await _await_if_needed(
                            _invoke_callable(self.quant_provider, evidence=evidence, instrument=instrument)
                        )
                    else:
                        quant_input = await self._default_quant_factors(evidence, instrument)
                except Exception as exc:
                    logger.warning("standard stock diagnosis quant factors unavailable: {}", exc)
                    quant_input = {}
            quant_input = _quant_factor_input(evidence, quant_input)
            fundamental_input = inputs.get("fundamental_factors")
            if fundamental_input is None:
                try:
                    if self.fundamental_provider is not None:
                        fundamental_input = await _await_if_needed(
                            _invoke_callable(self.fundamental_provider, evidence=evidence, instrument=instrument)
                        )
                    else:
                        fundamental_input = await self._default_fundamental_factors(
                            evidence,
                            instrument,
                            percentile_map=_fundamental_percentile_map(evidence, quant_input),
                        )
                except Exception as exc:
                    logger.warning("standard stock diagnosis fundamental factors unavailable: {}", exc)
                    fundamental_input = {}
            technical_input = inputs.get("technical_execution")
            if technical_input is None and self.technical_provider is not None:
                technical_input = await _await_if_needed(
                    _invoke_callable(self.technical_provider, evidence=evidence, instrument=instrument)
                )
            fundamental_input = _fundamental_factor_input(evidence, fundamental_input)
            technical_input = _technical_input(evidence, technical_input)
            semantic = _fundamental_research_from_bundle(evidence, semantic or inputs.get("fundamental_research"))
            fundamental_research = _semantic_to_research(
                semantic,
                instrument=instrument,
                context_id=context_id,
            )
            fundamental_factors = build_factor_snapshot(fundamental_input, quant=False)
            quant_factors = build_factor_snapshot(quant_input, quant=True)
            decision = build_diagnosis_decision(
                fundamental_factors=fundamental_factors.model_dump(mode="python"),
                quant_factors=quant_factors.model_dump(mode="python"),
                technical_execution=technical_input,
                holding_state=str(inputs.get("holding_state") or "not_holding"),
            )
            current_decision = _mapping(
                _mapping(decision.get("decision_radar")).get("current_decision")
            )
            decision["decision_radar"]["basis_rows"] = _decision_basis_rows(
                evidence=evidence,
                fundamental_research=fundamental_research,
                fundamental_factors=fundamental_factors,
                quant_factors=quant_factors,
                technical_input=technical_input,
                current_decision=current_decision,
            )
            technical_execution = _technical_report(technical_input, decision)
            all_sources = []
            for value in (
                evidence,
                fundamental_research,
                fundamental_factors,
                quant_factors,
                technical_execution,
                decision,
            ):
                for source_id in _source_ids(value):
                    if source_id not in all_sources:
                        all_sources.append(source_id)
            research_cutoff = inputs.get("research_cutoff_at") or evidence.get("research_cutoff_at") or evidence.get("as_of")
            if not isinstance(research_cutoff, str) or not research_cutoff.strip():
                research_cutoff = _now()
            market_as_of = inputs.get("market_as_of") or evidence.get("market_as_of") or evidence.get("as_of")
            if not isinstance(market_as_of, str):
                market_as_of = None
            generated_at = _now()
            data_quality = _data_quality(
                fundamental=fundamental_research,
                factors=fundamental_factors,
                quant=quant_factors,
                technical=technical_execution,
                overall_confidence=str(decision["overall_confidence"]),
            )
            report = StockDiagnosisV1.model_validate(
                {
                    "schema_version": DIAGNOSIS_SCHEMA_VERSION,
                    "kind": DIAGNOSIS_KIND,
                    "diagnosis_id": diagnosis_id,
                    "instrument": instrument.model_dump(mode="python"),
                    "research_cutoff_at": research_cutoff,
                    "market_as_of": market_as_of,
                    "generated_at": generated_at,
                    "evidence_context_id": context_id,
                    "source_ids": all_sources,
                    "data_quality": data_quality.model_dump(mode="python"),
                    "fundamental_research": fundamental_research.model_dump(mode="python"),
                    "fundamental_factors": fundamental_factors.model_dump(mode="python"),
                    "quant_factors": quant_factors.model_dump(mode="python"),
                    "technical_execution": technical_execution.model_dump(mode="python"),
                    "horizon_decisions": decision["horizon_decisions"],
                    "decision_radar": decision["decision_radar"],
                    "method_versions": {
                        "diagnosis_schema": "stock-diagnosis-v1",
                        "decision_engine": "deterministic-diagnosis-v1",
                        "factor_snapshot": "factor-snapshot-v1",
                        "decision_basis": "diagnosis-four-step-v1",
                    },
                }
            )
            # A cancellation that arrived while an injected callback was
            # running wins over a late success.
            latest = self.store.require(diagnosis_id)
            if latest.get("status") == "cancelled":
                return self.get(diagnosis_id)
            self.store.save_report(report)
            self._update(
                latest,
                status="succeeded",
                agent_steps=agent_steps,
                agent_step_count=len(agent_steps),
                llm_agent_steps=len(agent_steps),
                report_path=_REPORT_FILE,
                input_hash=canonical_input_hash(inputs),
                error=None,
                error_code=None,
            )
            return self.get(diagnosis_id)
        except Exception as exc:
            logger.warning("standard stock diagnosis {} failed: {}", diagnosis_id, exc)
            latest = self.store.require(diagnosis_id)
            if latest.get("status") == "cancelled":
                return self.get(diagnosis_id)
            self._update(
                latest,
                status="failed",
                agent_steps=agent_steps,
                agent_step_count=len(agent_steps),
                llm_agent_steps=len(agent_steps),
                error=str(exc),
                error_code="diagnosis_failed",
            )
            return self.get(diagnosis_id)

    async def create_and_execute(self, **kwargs: Any) -> dict[str, Any]:
        if self.evidence_service is not None and not isinstance(kwargs.get("evidence"), Mapping):
            context_id, _bundle = await self.prepare_context(
                instrument=kwargs.get("instrument"),
                evidence_context_id=kwargs.get("evidence_context_id"),
                research_cutoff_at=kwargs.get("research_cutoff_at"),
                diagnosis_id=kwargs.get("diagnosis_id"),
            )
            kwargs["evidence_context_id"] = context_id
        record = self.create(**kwargs)
        return await self.execute(str(record["diagnosis_id"]))


def standard_diagnosis_workflow() -> dict[str, Any]:
    """Return the one-agent workflow skeleton used by integrations/tests."""

    return {
        "schemaVersion": 1,
        "id": DIAGNOSIS_WORKFLOW_ID,
        "kind": "standard_ai_diagnosis",
        "steps": [
            {
                "id": DIAGNOSIS_SEMANTIC_STEP_ID,
                "type": "agent",
                "agentId": "com.mona.stock-diagnosis-semantic-researcher",
                "requiredArtifacts": ["semantic_submission.json"],
            }
        ],
        "maxLlmAgentSteps": 1,
        "deterministicDecisionStep": True,
    }


# Discoverable aliases for callers that use a builder/definition naming style.
build_standard_diagnosis_workflow = standard_diagnosis_workflow
StockDiagnosisService = DiagnosisService
