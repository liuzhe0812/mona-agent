"""Read-only stock report queries over ``<workspace>/stock_projects/`` (design §10.2).

Report/digest documents are written by the submit tools (T12) as
``<run_id>/{report,digest}.{json,md}``. This module scans them for the
WebSocket GET routes (T16): list, detail and the watchlist × latest-report
dashboard aggregate. It never writes and never leaves the given directory —
``report_id`` is matched against document content, never used as a path
component.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from mona.services.stock.provenance import CN_TZ, parse_asia_datetime
from mona.services.stock.schemas import DecisionReportV5, DecisionReportV6, StockDiagnosisV1
from mona.services.stock.storage import WatchlistItem, WatchlistStore

_REPORT_ID_RE = re.compile(r"^[a-z0-9_]+$")
_STEMS = ("report", "digest")

_STORE: WatchlistStore | None = None


def _store() -> WatchlistStore:
    """Process-wide watchlist store (``~/.mona/stock``); tests rebind it."""
    global _STORE
    if _STORE is None:
        _STORE = WatchlistStore(Path.home() / ".mona" / "stock")
    return _STORE


def valid_report_id(report_id: str) -> bool:
    return bool(_REPORT_ID_RE.fullmatch(report_id))


def default_watchlist() -> list[WatchlistItem]:
    """The global watchlist (``~/.mona/stock``) the dashboard joins against."""
    return _store().list()


def _read_doc(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("Skipping unreadable stock report {}", path)
        return None
    return doc if isinstance(doc, dict) else None


def _instrument_payload(doc: dict[str, Any]) -> dict[str, Any] | None:
    inst = doc.get("instrument")
    if not isinstance(inst, dict):
        return None
    return {
        "instrumentId": f"{inst.get('exchange')}:{inst.get('symbol')}",
        "symbol": inst.get("symbol"),
        "exchange": inst.get("exchange"),
        "name": inst.get("name") or "",
        "instrumentType": inst.get("instrument_type"),
    }


def _is_v4_deep_report(doc: dict[str, Any]) -> bool:
    return doc.get("kind") == "deep_research" and doc.get("schema_version") == 4


def _is_v5_deep_report(doc: dict[str, Any]) -> bool:
    if doc.get("kind") != "deep_research" or doc.get("schema_version") != 5:
        return False
    try:
        DecisionReportV5.model_validate(doc)
    except (TypeError, ValueError):
        return False
    return True


def _is_v6_deep_report(doc: dict[str, Any]) -> bool:
    if doc.get("kind") != "deep_research" or doc.get("schema_version") != 6:
        return False
    try:
        DecisionReportV6.model_validate(doc)
    except (TypeError, ValueError):
        return False
    return True


def _is_ai_diagnosis_report(doc: dict[str, Any]) -> bool:
    """Validate the standard report without treating it as deep research."""
    if doc.get("kind") != "ai_diagnosis" or doc.get("schema_version") != 1:
        return False
    try:
        StockDiagnosisV1.model_validate(doc)
    except (TypeError, ValueError):
        return False
    return True


def is_v5_report(doc: dict[str, Any]) -> bool:
    """Public validity predicate for current V5 report consumers."""
    return _is_v5_deep_report(doc)


def is_v6_report(doc: dict[str, Any]) -> bool:
    """Public validity predicate for current V6 report consumers."""
    return _is_v6_deep_report(doc)


def _is_invalid_v5(doc: dict[str, Any]) -> bool:
    return doc.get("kind") == "deep_research" and doc.get("schema_version") == 5 and not _is_v5_deep_report(doc)


def _is_invalid_v6(doc: dict[str, Any]) -> bool:
    return doc.get("kind") == "deep_research" and doc.get("schema_version") == 6 and not _is_v6_deep_report(doc)


def _v5_expiry_states(doc: dict[str, Any], *, now: datetime | None = None) -> dict[str, bool]:
    current = now or datetime.now(CN_TZ)
    decisions = doc.get("horizon_decisions") or {}
    return {
        key: (
            (parsed := parse_asia_datetime((decisions.get(key) or {}).get("valid_until"))) is None
            or current > parsed
        )
        for key in ("short_term", "medium_term", "long_term")
    }


def _v5_horizon_projection(
    doc: dict[str, Any], *, now: datetime | None = None
) -> dict[str, dict[str, Any]]:
    decisions = doc.get("horizon_decisions") or {}
    expiry = _v5_expiry_states(doc, now=now)
    return {
        key: {
            "direction": decision.get("direction"),
            "action": decision.get("action"),
            "validUntil": decision.get("valid_until"),
            "isExpired": expiry[source_key],
        }
        for key, source_key in (
            ("shortTerm", "short_term"),
            ("mediumTerm", "medium_term"),
            ("longTerm", "long_term"),
        )
        for decision in (decisions.get(source_key) or {},)
    }


def _horizon_stances(doc: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    """Project V4 horizon fields without deriving missing values."""
    views = doc.get("horizon_views")
    if not isinstance(views, dict):
        return None
    return {
        key: {
            "stance": view.get("stance") if isinstance(view, dict) else None,
            "status": view.get("status") if isinstance(view, dict) else None,
        }
        for key, source_key in (
            ("shortTerm", "short_term"),
            ("mediumTerm", "medium_term"),
            ("longTerm", "long_term"),
        )
        for view in (views.get(source_key),)
    }


def _report_projection(doc: dict[str, Any]) -> dict[str, Any]:
    """Return the shared list/dashboard projection for one document."""
    if _is_ai_diagnosis_report(doc):
        decisions = doc.get("horizon_decisions") or {}
        return {
            "schemaVersion": 1,
            "resultStatus": "completed",
            "kind": "ai_diagnosis",
            "horizonDecisions": {
                public_key: {
                    "direction": (decisions.get(source_key) or {}).get("direction"),
                    "action": (decisions.get(source_key) or {}).get("action"),
                    "validationStatus": (decisions.get(source_key) or {}).get("validation_status"),
                    "confidence": (decisions.get(source_key) or {}).get("confidence"),
                }
                for public_key, source_key in (
                    ("shortTerm", "short_term"),
                    ("mediumTerm", "medium_term"),
                    ("longTerm", "long_term"),
                )
            },
            "researchCutoffAt": doc.get("research_cutoff_at"),
            "marketAsOf": doc.get("market_as_of"),
            "generatedAt": doc.get("generated_at"),
            "dataQuality": doc.get("data_quality"),
            "stance": None,
        }
    if _is_v6_deep_report(doc):
        return {
            "schemaVersion": 6,
            "resultStatus": "completed",
            "decisionMode": doc.get("decision_mode"),
            "researchStatus": doc.get("research_status"),
            "tradeStatus": doc.get("trade_status"),
            "quantPromotion": {
                key: doc.get("quant_promotion", {}).get(key)
                for key in ("status", "eligibleForTrading", "promotionStatus", "reason")
                if key in (doc.get("quant_promotion") or {})
            },
            "valuation": {
                key: (doc.get("valuation") or {}).get(key)
                for key in ("status", "tradeReady", "usableMethodCount", "reason")
                if key in (doc.get("valuation") or {})
            },
            "marketSentiment": _public_market_sentiment(doc.get("market_sentiment")),
            "publicOpinion": _public_opinion(doc.get("public_opinion")),
            "executionQualification": {
                "status": (doc.get("execution_qualification") or {}).get("status"),
            },
            "riskProfileConfigured": doc.get("risk_profile_configured", False),
            "riskLevel": doc.get("risk_level", "conservative"),
            "holdingState": doc.get("holding_state", "not_holding"),
            "horizonDecisions": {
                public_key: {
                    "direction": (doc.get("horizon_decisions", {}).get(source_key) or {}).get("direction"),
                    "action": (doc.get("horizon_decisions", {}).get(source_key) or {}).get("action"),
                    "researchStatus": (doc.get("horizon_decisions", {}).get(source_key) or {}).get("research_status"),
                    "tradeStatus": (doc.get("horizon_decisions", {}).get(source_key) or {}).get("trade_status"),
                }
                for public_key, source_key in (
                    ("shortTerm", "short_term"),
                    ("mediumTerm", "medium_term"),
                    ("longTerm", "long_term"),
                )
            },
            "researchCutoffAt": doc.get("research_cutoff_at"),
            "marketAsOf": doc.get("market_as_of"),
            "stance": None,
            "dataQuality": None,
        }
    if _is_v5_deep_report(doc):
        expiry = _v5_expiry_states(doc)
        return {
            "schemaVersion": 5,
            "resultStatus": "completed",
            "horizonDecisions": _v5_horizon_projection(doc),
            "researchCutoffAt": doc.get("research_cutoff_at"),
            "marketAsOf": doc.get("market_as_of"),
            "generatedAt": doc.get("generated_at"),
            "isExpired": all(expiry.values()),
            "hasExpiredHorizon": any(expiry.values()),
            "stance": None,
            "dataQuality": None,
        }
    if not _is_v4_deep_report(doc):
        return {
            "stance": doc.get("research_stance"),
            "dataQuality": doc.get("data_quality"),
        }
    return {
        "schemaVersion": doc.get("schema_version"),
        "horizonStances": _horizon_stances(doc),
        "researchCutoffAt": doc.get("research_cutoff_at"),
        "marketAsOf": doc.get("market_as_of"),
        "evidenceCoverage": doc.get("evidence_coverage"),
        # V4 deliberately has no composite stance/quality.
        "stance": None,
        "dataQuality": None,
    }


def _doc_projections(doc: dict[str, Any]) -> list[tuple[str, str | None, str | None]]:
    """``(instrument_id, stance, data_quality)`` for each covered instrument."""
    if doc.get("kind") == "daily_review":
        out: list[tuple[str, str | None, str | None]] = []
        for item in doc.get("items") or []:
            inst = item.get("instrument") or {}
            iid = f"{inst.get('exchange')}:{inst.get('symbol')}"
            out.append((iid, item.get("stance"), item.get("data_quality")))
        return out
    inst = _instrument_payload(doc)
    if inst is None:
        return []
    projection = _report_projection(doc)
    return [(inst["instrumentId"], projection["stance"], projection["dataQuality"])]


def _iter_docs(stock_dir: Path):
    """Yield ``(mtime, run_dir, stem, doc)`` for every readable document."""
    if not stock_dir.is_dir():
        return
    for run_dir in sorted(stock_dir.iterdir()):
        if not run_dir.is_dir():
            continue
        for stem in _STEMS:
            path = run_dir / f"{stem}.json"
            if not path.is_file():
                continue
            doc = _read_doc(path)
            if doc is None:
                continue
            yield path.stat().st_mtime, run_dir, stem, doc


def _list_item(mtime: float, run_dir: Path, doc: dict[str, Any]) -> dict[str, Any]:
    item = {
        "reportId": doc.get("report_id") or doc.get("diagnosis_id"),
        "runId": doc.get("workflow_run_id") or doc.get("diagnosis_id") or run_dir.name,
        "kind": doc.get("kind"),
        "instrument": _instrument_payload(doc),
        "symbols": [p[0] for p in _doc_projections(doc)],
        "asOf": doc.get("as_of") or doc.get("market_as_of"),
        "modifiedAt": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
    }
    item.update(_report_projection(doc))
    return item


def scan_reports(stock_dir: Path) -> list[dict[str, Any]]:
    """All report/digest list items, newest document first."""
    entries = [
        (mtime, _list_item(mtime, run_dir, doc))
        for mtime, run_dir, _stem, doc in _iter_docs(stock_dir)
        if not _is_invalid_v5(doc) and not _is_invalid_v6(doc)
    ]
    entries.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in entries]


def load_report(stock_dir: Path, report_id: str) -> tuple[dict[str, Any], str] | None:
    """``(doc, markdown)`` for ``report_id``; ``None`` when not found."""
    for _mtime, run_dir, stem, doc in _iter_docs(stock_dir):
        if doc.get("report_id") != report_id and doc.get("diagnosis_id") != report_id:
            continue
        if _is_invalid_v5(doc) or _is_invalid_v6(doc):
            continue
        md_path = run_dir / f"{stem}.md"
        markdown = md_path.read_text(encoding="utf-8") if md_path.is_file() else ""
        if "source_ids" not in doc:
            sources = doc.get("sources") or []
            if isinstance(sources, list):
                doc = {
                    **doc,
                    "source_ids": [
                        source["id"]
                        for source in sources
                        if isinstance(source, dict) and isinstance(source.get("id"), str)
                    ],
                }
        return doc, markdown
    return None


def _claim_texts(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [
        value.get("claim", "").strip()
        for value in values
        if isinstance(value, dict) and isinstance(value.get("claim"), str) and value.get("claim", "").strip()
    ]


def _public_market_sentiment(value: Any) -> dict[str, Any]:
    """Expose only the deterministic market conclusion, never its inputs."""
    section = value if isinstance(value, dict) else {}
    direction = section.get("direction")
    if direction not in {"偏多", "偏空", "震荡", "暂不判断"}:
        direction = "暂不判断"
    return {
        "status": section.get("status"),
        "direction": direction,
        "strength": section.get("strength"),
        "asOf": section.get("as_of"),
        "decisionImpact": section.get("decision_impact"),
    }


def _public_opinion(value: Any) -> dict[str, Any]:
    """Expose the aggregate opinion direction, coverage and time only."""
    section = value if isinstance(value, dict) else {}
    direction = section.get("direction")
    if direction not in {"偏多", "偏空", "分歧"}:
        direction = None
    count = section.get("coverage_account_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        count = None
    index = section.get("redfox_index")
    if isinstance(index, bool) or not isinstance(index, (int, float)):
        index = None
    return {
        "status": section.get("status"),
        "direction": direction,
        "asOf": section.get("as_of"),
        "coverageAccountCount": count,
        "redfoxIndex": index,
        "decisionImpact": section.get("decision_impact"),
    }


def _public_quant_validation(value: Any) -> dict[str, Any] | None:
    """Expose V6 quantitative observations with a stable public contract.

    Evidence and the immutable report keep snake_case because they are Python
    storage contracts.  The detail route is a UI/API contract, so nested
    quantitative fields must be projected explicitly instead of leaking the
    persisted document wholesale.
    """
    if not isinstance(value, dict):
        return None

    def source_count(item: Any) -> int:
        ids = item.get("source_ids") if isinstance(item, dict) else None
        return len({source_id for source_id in ids if isinstance(source_id, str) and source_id}) if isinstance(ids, list) else 0

    def public_observation(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        return {
            "field": item.get("field"),
            "rawValue": item.get("raw_value"),
            "percentileOrRank": item.get("percentile_or_rank"),
            "direction": item.get("direction"),
            "scope": item.get("scope"),
            "sampleCount": item.get("sample_count"),
            "missingCount": item.get("missing_count"),
            "asOf": item.get("as_of"),
            "methodVersion": item.get("method_version"),
            "validationStatus": item.get("validation_status"),
            "sourceCount": source_count(item),
        }

    def public_horizon(item: Any) -> dict[str, Any]:
        item = item if isinstance(item, dict) else {}
        observations = item.get("factor_observations")
        return {
            "status": item.get("status", item.get("validation_status")),
            "signal": item.get("signal", item.get("quant_signal")),
            "factorObservations": [
                observation
                for raw in observations or []
                if (observation := public_observation(raw)) is not None
            ],
            "methodId": item.get("method_id"),
            "methodVersion": item.get("method_version"),
            "targetWindowSessions": item.get("target_window_sessions"),
            "targetDefinition": item.get("target_definition"),
        }

    horizons = value.get("horizons") if isinstance(value.get("horizons"), dict) else {}
    target_windows = value.get("target_windows") if isinstance(value.get("target_windows"), dict) else {}
    method_registry = value.get("method_registry") if isinstance(value.get("method_registry"), dict) else {}

    def public_window(item: Any) -> dict[str, Any]:
        item = item if isinstance(item, dict) else {}
        return {"sessions": item.get("sessions"), "definition": item.get("definition")}

    def public_registry(item: Any) -> dict[str, Any]:
        item = item if isinstance(item, dict) else {}
        return {
            "id": item.get("id", item.get("method_id")),
            "version": item.get("version", item.get("method_version")),
            "targetWindowSessions": item.get("targetWindowSessions", item.get("target_window_sessions")),
            "targetDefinition": item.get("targetDefinition", item.get("target_definition")),
        }

    return {
        "strategyId": value.get("strategy_id"),
        "asOf": value.get("as_of"),
        "factorAlgorithmVersion": value.get("factor_algorithm_version"),
        "rankAlgorithmVersion": value.get("rank_algorithm_version"),
        "validationStatus": value.get("validation_status"),
        "quantSignal": value.get("quant_signal"),
        "horizons": {
            "shortTerm": public_horizon(horizons.get("short_term")),
            "mediumTerm": public_horizon(horizons.get("medium_term")),
            "longTerm": public_horizon(horizons.get("long_term")),
        },
        "promotionStatus": value.get("promotion_status"),
        "eligibleForTrading": value.get("eligible_for_trading"),
        "targetWindowSessions": value.get("target_window_sessions"),
        "targetDefinition": value.get("target_definition"),
        "targetWindows": {
            "shortTerm": public_window(target_windows.get("short_term")),
            "mediumTerm": public_window(target_windows.get("medium_term")),
            "longTerm": public_window(target_windows.get("long_term")),
        },
        "methodRegistry": {
            "shortTerm": public_registry(method_registry.get("short_term")),
            "mediumTerm": public_registry(method_registry.get("medium_term")),
            "longTerm": public_registry(method_registry.get("long_term")),
        },
    }


def _public_valuation(value: Any) -> dict[str, Any]:
    """Keep the user-facing valuation assessment and percentiles only."""
    section = value if isinstance(value, dict) else {}
    assessment = section.get("assessment")
    assessment = assessment if isinstance(assessment, dict) else {}
    public_assessment = {
        "view": assessment.get("view") if assessment.get("view") in {"低估", "合理", "高估", "暂不判断"} else "暂不判断",
    }
    for name in ("pe", "pb"):
        metric = assessment.get(name)
        metric = metric if isinstance(metric, dict) else {}
        percentile = metric.get("percentile")
        if isinstance(percentile, bool) or not isinstance(percentile, (int, float)):
            percentile = None
        public_assessment[name] = {
            "view": metric.get("view") if metric.get("view") in {"低估", "合理", "高估", "暂不判断"} else "暂不判断",
            "percentile": percentile,
        }
    return {
        "status": section.get("status"),
        "tradeReady": section.get("tradeReady"),
        "usableMethodCount": section.get("usableMethodCount"),
        "reason": section.get("reason"),
        "assessment": public_assessment,
    }


def _public_gate(value: Any) -> dict[str, Any]:
    section = value if isinstance(value, dict) else {}
    horizons = section.get("horizons") if isinstance(section.get("horizons"), dict) else {}
    public_horizons: dict[str, Any] = {}
    for public_key, source_key in (
        ("shortTerm", "short_term"),
        ("mediumTerm", "medium_term"),
        ("longTerm", "long_term"),
    ):
        item = horizons.get(source_key)
        if not isinstance(item, dict):
            continue
        public_horizons[public_key] = {
            "status": item.get("status"),
            "required": item.get("required"),
            "available": item.get("available"),
        }
    return {
        "status": section.get("status"),
        "horizons": public_horizons,
        "failureReasons": list(section.get("failure_reasons") or [])[:8],
    }


def _public_execution_qualification(value: Any) -> dict[str, Any]:
    section = value if isinstance(value, dict) else {}
    horizons = section.get("horizons") if isinstance(section.get("horizons"), dict) else {}
    public_horizons: dict[str, Any] = {}
    for public_key, source_key in (
        ("shortTerm", "short_term"),
        ("mediumTerm", "medium_term"),
        ("longTerm", "long_term"),
    ):
        item = horizons.get(source_key)
        if not isinstance(item, dict):
            continue
        public_horizons[public_key] = {
            "status": item.get("status"),
            "executionStatus": item.get("executionStatus"),
            "reason": item.get("reason"),
            "reasons": list(item.get("reasons") or []),
        }
    return {"status": section.get("status"), "horizons": public_horizons}


def _v5_public_horizon(
    decision: dict[str, Any],
    *,
    market_as_of: str,
    generated_at: str,
    is_expired: bool,
) -> dict[str, Any]:
    plan = decision.get("trading_plan") or {}
    position = decision.get("position_plan") or {}
    return {
        "direction": decision.get("direction"),
        "action": decision.get("action"),
        "thesis": decision.get("thesis"),
        "notHoldingAction": decision.get("not_holding_action"),
        "holdingAction": decision.get("holding_action"),
        "tradingPlan": {
            "referenceBuyLow": plan.get("reference_buy_low"),
            "referenceBuyHigh": plan.get("reference_buy_high"),
            "pullbackBuyLow": plan.get("pullback_buy_low"),
            "pullbackBuyHigh": plan.get("pullback_buy_high"),
            "stopLoss": plan.get("stop_loss"),
            "firstTakeProfit": plan.get("first_take_profit"),
            "firstReduceFraction": plan.get("first_reduce_fraction"),
            "secondTakeProfit": plan.get("second_take_profit"),
            "secondReduceFraction": plan.get("second_reduce_fraction"),
            "riskRewardFirst": plan.get("risk_reward_first"),
            "riskRewardSecond": plan.get("risk_reward_second"),
            "currency": "元",
        },
        "positionPlan": {
            "riskBudgetPct": position.get("risk_budget_pct"),
            "initialPositionPct": position.get("initial_position_pct"),
            "maxPositionPct": position.get("max_position_pct"),
            "stopDistancePct": position.get("stop_distance_pct"),
        },
        "validUntil": decision.get("valid_until"),
        "reviewTrigger": decision.get("review_trigger"),
        "keyReasons": _claim_texts(decision.get("key_reasons")),
        "keyRisks": _claim_texts(decision.get("key_risks")),
        "evidenceStrength": decision.get("evidence_strength"),
        "marketAsOf": market_as_of,
        "generatedAt": generated_at,
        "isExpired": is_expired,
    }


def public_report_detail(doc: dict[str, Any], markdown: str) -> dict[str, Any]:
    """Project a report for the user-facing detail route.

    V4 remains a raw compatibility document; V5 exposes only the compact
    transaction-plan contract and never forwards provenance internals.
    """
    if _is_ai_diagnosis_report(doc):
        decisions = doc["horizon_decisions"]
        horizons = {
            public_key: {
                "direction": (decisions[source_key] or {}).get("direction"),
                "action": (decisions[source_key] or {}).get("action"),
                "factorScore": (decisions[source_key] or {}).get("factor_score"),
                "marketPercentile": (decisions[source_key] or {}).get("market_percentile"),
                "industryPercentile": (decisions[source_key] or {}).get("industry_percentile"),
                "validationStatus": (decisions[source_key] or {}).get("validation_status"),
                "notHoldingAction": (decisions[source_key] or {}).get("not_holding_action"),
                "holdingAction": (decisions[source_key] or {}).get("holding_action"),
                "materializedPlan": (decisions[source_key] or {}).get("materialized_plan"),
                "positionPlan": (decisions[source_key] or {}).get("position_plan"),
                "reviewTrigger": (decisions[source_key] or {}).get("review_trigger"),
                "validUntil": (decisions[source_key] or {}).get("valid_until"),
                "keyReasons": _claim_texts((decisions[source_key] or {}).get("key_reasons")),
                "keyRisks": _claim_texts((decisions[source_key] or {}).get("key_risks")),
                "confidence": (decisions[source_key] or {}).get("confidence"),
            }
            for public_key, source_key in (
                ("shortTerm", "short_term"),
                ("mediumTerm", "medium_term"),
                ("longTerm", "long_term"),
            )
        }
        return {
            "report": {
                "schemaVersion": 1,
                "resultStatus": "completed",
                "reportId": doc["diagnosis_id"],
                "diagnosisId": doc["diagnosis_id"],
                "kind": "ai_diagnosis",
                "instrument": _instrument_payload(doc),
                "dataQuality": doc.get("data_quality"),
                "researchCutoffAt": doc.get("research_cutoff_at"),
                "marketAsOf": doc.get("market_as_of"),
                "generatedAt": doc.get("generated_at"),
                "horizonDecisions": horizons,
                "decisionRadar": doc.get("decision_radar"),
                "methodVersions": doc.get("method_versions") or {},
            },
            "markdown": markdown,
        }
    if _is_v6_deep_report(doc):
        labels = (
            ("shortTerm", "short_term"),
            ("mediumTerm", "medium_term"),
            ("longTerm", "long_term"),
        )
        horizons = {}
        for public_key, source_key in labels:
            decision = doc["horizon_decisions"][source_key]
            plan = decision.get("materialized_plan")
            public_plan = None
            if isinstance(plan, dict):
                public_plan = {
                    "direction": plan.get("direction"),
                    "action": plan.get("action"),
                    "holdingState": plan.get("holding_state"),
                    "currentAction": plan.get("current_action"),
                    "planStatus": plan.get("plan_status"),
                    "buyLow": plan.get("buy_low"),
                    "buyHigh": plan.get("buy_high"),
                    "pullbackLow": plan.get("pullback_low"),
                    "pullbackHigh": plan.get("pullback_high"),
                    "confirmationPrice": plan.get("confirmation_price"),
                    "invalidationPrice": plan.get("invalidation_price"),
                    "exitPrice": plan.get("exit_price"),
                    "reentryConfirmationPrice": plan.get("reentry_confirmation_price"),
                    "stopLoss": plan.get("stop_loss"),
                    "firstTakeProfit": plan.get("first_take_profit"),
                    "secondTakeProfit": plan.get("second_take_profit"),
                    "initialPositionPct": plan.get("initial_position_pct"),
                    "maxPositionPct": plan.get("max_position_pct"),
                    "targetMaxPositionPct": plan.get("target_max_position_pct"),
                    "additionalPositionPct": plan.get("additional_position_pct"),
                    "liquidityCapPct": plan.get("liquidity_cap_pct"),
                    "riskBudgetPct": plan.get("risk_budget_pct"),
                    "riskRewardFirstAfterCost": plan.get("risk_reward_first_after_cost"),
                    "riskRewardSecondAfterCost": plan.get("risk_reward_second_after_cost"),
                    "riskProfileName": plan.get("risk_profile_name"),
                    "riskProfileConfigured": plan.get("risk_profile_configured"),
                    "positionCapReasons": plan.get("position_cap_reasons") or [],
                    "executionMode": plan.get("execution_mode"),
                }
                execution = plan.get("execution")
                if isinstance(execution, dict):
                    public_plan["execution"] = {
                        "executionStatus": execution.get("execution_status"),
                        "rulesStatus": execution.get("rules_status"),
                        "liquidityStatus": execution.get("liquidity_status"),
                        "board": execution.get("board"),
                        "exchange": execution.get("exchange"),
                        "riskWarning": execution.get("risk_warning"),
                        "priceLimitPct": execution.get("price_limit_pct"),
                        "upperLimitPrice": execution.get("upper_limit_price"),
                        "lowerLimitPrice": execution.get("lower_limit_price"),
                        "buyStatus": execution.get("buy_status"),
                        "sellStatus": execution.get("sell_status"),
                        "tPlusOneStatus": execution.get("t_plus_one_status"),
                        "minOrderQuantity": execution.get("min_order_quantity"),
                        "orderQuantityIncrement": execution.get("order_quantity_increment"),
                        "immediateExecutionAllowed": execution.get("immediate_execution_allowed"),
                        "executionMode": execution.get("execution_mode"),
                        "estimatedSlippagePct": execution.get("estimated_slippage_pct"),
                        "capacityNotionalYuan": execution.get("capacity_notional_yuan"),
                        "warnings": execution.get("warnings") or [],
                    }
            horizons[public_key] = {
                "direction": decision.get("direction"),
                "action": decision.get("action"),
                "thesis": decision.get("thesis"),
                "keyReasons": _claim_texts(decision.get("key_reasons")),
                "keyRisks": _claim_texts(decision.get("key_risks")),
                "researchStatus": decision.get("research_status"),
                "tradeStatus": decision.get("trade_status"),
                "materializedPlan": public_plan,
                "validUntil": decision.get("valid_until"),
                "reviewTrigger": decision.get("review_trigger"),
            }
        return {
            "report": {
                "schemaVersion": 6,
                "resultStatus": "completed",
                "reportId": doc["report_id"],
                "runId": doc["workflow_run_id"],
                "kind": doc["kind"],
                "decisionMode": doc.get("decision_mode"),
                "researchStatus": doc.get("research_status"),
                "tradeStatus": doc.get("trade_status"),
                "researchReady": _public_gate(doc.get("research_ready")),
                "tradeReady": _public_gate(doc.get("trade_ready")),
                "quantValidation": _public_quant_validation(doc.get("quant_validation")),
                "quantPromotion": doc.get("quant_promotion"),
                 "valuation": _public_valuation(doc.get("valuation")),
                 "marketSentiment": _public_market_sentiment(doc.get("market_sentiment")),
                 "publicOpinion": _public_opinion(doc.get("public_opinion")),
                "executionQualification": _public_execution_qualification(doc.get("execution_qualification")),
                "riskProfileConfigured": doc.get("risk_profile_configured", False),
                "riskLevel": doc.get("risk_level", "conservative"),
                "holdingState": doc.get("holding_state", "not_holding"),
                "currentPrice": doc.get("current_price"),
                "benchmarkPrice": doc.get("benchmark_price"),
                "sourceCount": len({source_id for source_id in doc.get("source_ids") or [] if isinstance(source_id, str) and source_id}),
                "instrument": _instrument_payload(doc),
                "summary": doc["summary"],
                "researchCutoffAt": doc["research_cutoff_at"],
                "marketAsOf": doc["market_as_of"],
                "generatedAt": doc["generated_at"],
                "horizonDecisions": horizons,
            },
            "markdown": markdown,
        }
    if not _is_v5_deep_report(doc):
        return {"report": doc, "markdown": markdown}
    market_as_of = doc["market_as_of"]
    generated_at = doc["generated_at"]
    expiry = _v5_expiry_states(doc)
    horizons = {
        public_key: _v5_public_horizon(
            doc["horizon_decisions"][source_key],
            market_as_of=market_as_of,
            generated_at=generated_at,
            is_expired=expiry[source_key],
        )
        for public_key, source_key in (
            ("shortTerm", "short_term"),
            ("mediumTerm", "medium_term"),
            ("longTerm", "long_term"),
        )
    }
    report = {
        "schemaVersion": 5,
        "resultStatus": "completed",
        "reportId": doc["report_id"],
        "runId": doc["workflow_run_id"],
        "kind": doc["kind"],
        "instrument": _instrument_payload(doc),
        "summary": doc["summary"],
        "researchCutoffAt": doc["research_cutoff_at"],
        "marketAsOf": market_as_of,
        "generatedAt": generated_at,
        "isExpired": all(expiry.values()),
        "hasExpiredHorizon": any(expiry.values()),
        "horizonDecisions": horizons,
    }
    return {"report": report, "markdown": markdown}


def delete_report(stock_dir: Path, report_id: str) -> bool:
    """Delete the whole run directory backing ``report_id`` (manual cleanup).

    Design §9: reports are never auto-deleted, but the user gets an explicit
    cleanup entry. The run directory holds the report/digest plus its
    evidence bundle and view artifacts — they are one run's products and go
    away together. ``report_id`` is matched against document content, never
    used as a path component. Returns whether anything was deleted.
    """
    if not valid_report_id(report_id):
        return False
    for _mtime, run_dir, _stem, doc in _iter_docs(stock_dir):
        if doc.get("report_id") != report_id:
            continue
        shutil.rmtree(run_dir, ignore_errors=True)
        logger.info("Deleted stock report {} (run dir {})", report_id, run_dir.name)
        return True
    return False


def build_dashboard(
    stock_dir: Path, watchlist: list[WatchlistItem]
) -> list[dict[str, Any]]:
    """Watchlist items joined with their newest deep-research projection.

    Daily-review digests are a separate, portfolio-level product and must not
    replace a symbol's persisted deep-research result in this index.
    """
    latest_v5: dict[str, tuple[float, dict[str, Any]]] = {}
    latest_legacy: dict[str, tuple[float, dict[str, Any]]] = {}
    for mtime, run_dir, _stem, doc in _iter_docs(stock_dir):
        if doc.get("kind") != "deep_research":
            continue
        if _is_invalid_v5(doc) or _is_invalid_v6(doc):
            continue
        target = latest_v5 if (_is_v5_deep_report(doc) or _is_v6_deep_report(doc)) else latest_legacy
        for instrument_id, stance, quality in _doc_projections(doc):
            current = target.get(instrument_id)
            if current is not None and current[0] >= mtime:
                continue
            projection = _report_projection(doc)
            target[instrument_id] = (
                mtime,
                {
                    "reportId": doc.get("report_id"),
                    "runId": doc.get("workflow_run_id") or run_dir.name,
                    "kind": doc.get("kind"),
                    "asOf": doc.get("as_of"),
                    "modifiedAt": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                    **projection,
                },
            )
    return [
        {
            "instrumentId": item.id,
            "name": item.name,
            "instrumentType": item.instrument_type,
            "focus": item.focus,
            "latest": (
                latest_v5.get(item.id)
                or latest_legacy.get(item.id)
                or (0.0, None)
            )[1],
        }
        for item in watchlist
    ]
