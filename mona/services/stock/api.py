"""Stock HTTP API (design §10.1, dev plan T15/P5).

Market capabilities for the services process include watchlist CRUD/import,
instrument search, batch quote snapshots and kline with deterministic
indicators. It never starts AgentJobs or WorkflowRuns. The P5 outcome routes
read local V4 report artifacts and only fetch data after an explicit refresh;
report queries otherwise remain on the WebSocket port (T16).

The store and provider are module-level lazy singletons so tests can bind
them to ``tmp_path`` / fakes; production uses ``~/.mona/stock`` and the
failover composition (Tencent primary, East Money fallback).
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from aiohttp import web
from pydantic import ValidationError

from mona.services.stock.diagnosis import (
    DiagnosisNotFoundError,
    DiagnosisService,
    DiagnosisStateError,
    DiagnosisStorageError,
)
from mona.services.stock.evidence import EvidenceService
from mona.services.stock.failover import FailoverProvider, IntradayFailoverProvider
from mona.services.stock.indicators import (
    macd,
    rsi,
    sma,
    swing_high_low,
    volume_change_pct,
)
from mona.services.stock.intraday import IntradaySeries
from mona.services.stock.intraday_service import IntradayService
from mona.services.stock.intraday_storage import IntradayStore
from mona.services.stock.material_evidence import (
    MaterialBindingError,
    MaterialBindingStore,
    confirmed_fact_user_payload,
)
from mona.services.stock.outcomes import (
    PUBLIC_MARKET_BENCHMARK,
    SELECTION_TRACKING_FILE,
    SELECTION_WINDOWS,
    aggregate_outcome_observations,
    aggregate_selection_outcome_observations,
    append_outcome_observation,
    append_selection_outcome_observations,
    build_outcome_tracking_snapshot,
    build_selection_outcome_tracking_snapshot,
    calculate_outcome_observations,
    calculate_selection_outcome_observations,
    ensure_outcome_tracking_snapshot,
    ensure_selection_outcome_tracking_snapshot,
    evaluate_decision_conditions,
    read_latest_outcome_observations,
    read_latest_selection_outcome_observations,
)
from mona.services.stock.provenance import CN_TZ, parse_asia_datetime
from mona.services.stock.provider import (
    EastMoneyProvider,
    Fundamentals,
    GovernmentResearchProvider,
    InstrumentRef,
    NewsItem,
    ProviderError,
    Quote,
)
from mona.services.stock.provider_tencent import TencentProvider
from mona.services.stock.risk_profile import (
    LocalRiskProfileStore,
    RiskProfileStorageError,
    risk_profile_path,
)
from mona.services.stock.screening import (
    ScreeningValidationError,
    StockScreeningService,
)
from mona.services.stock.storage import (
    WatchlistCorruptError,
    WatchlistItem,
    WatchlistStore,
    infer_exchange,
)
from mona.services.stock.v6_tracking import (
    V6_TRACKING_FILE,
    aggregate_v6_observations,
    append_v6_observation,
    calculate_v6_observations,
    ensure_v6_tracking_snapshot,
    latest_v6_observations,
)

_MAX_QUOTE_IDS = 50
_MAX_KLINE_LIMIT = 250
_DEFAULT_NEWS_LIMIT = 5
_MAX_NEWS_LIMIT = 8
_ID_RE = re.compile(r"^(XSHG|XSHE|BJSE):(\d{6})$")

_STORE: WatchlistStore | None = None
_PROVIDER: FailoverProvider | None = None
_INTRADAY_PROVIDER: IntradayFailoverProvider | None = None
_INTRADAY_SERVICE: IntradayService | None = None
_SCREENING_SERVICE: StockScreeningService | None = None
_SCREENING_WORKSPACE: Path | None = None


def _diagnosis_workspace(request: web.Request) -> Path:
    workspace = request.app.get("workspace")
    return Path(workspace).expanduser() if workspace else Path.home() / ".mona" / "workspace"


def _diagnosis_service(request: web.Request) -> DiagnosisService:
    """Resolve an injectable standard-diagnosis service for this app."""
    configured = request.app.get("stock_diagnosis_service")
    if configured is not None and all(
        callable(getattr(configured, name, None))
        for name in ("create", "execute", "get", "list", "cancel", "fail", "retry", "delete")
    ):
        return configured
    factory = request.app.get("stock_diagnosis_service_factory")
    if callable(factory):
        service = factory(request)
        if service is not None and all(
            callable(getattr(service, name, None))
            for name in ("create", "execute", "get", "list", "cancel", "fail", "retry", "delete")
        ):
            return service
    workspace = _diagnosis_workspace(request)
    provider = request.app.get("stock_diagnosis_provider") or _provider()
    evidence_service = request.app.get("stock_evidence_service")
    evidence_factory = request.app.get("stock_evidence_service_factory")
    if evidence_service is None and callable(evidence_factory):
        evidence_service = evidence_factory(request)
    if evidence_service is None:
        evidence_service = EvidenceService(
            workspace=workspace,
            provider=provider,
            research_provider=GovernmentResearchProvider(),
            cache_root=Path.home() / ".mona" / "stock" / "cache",
        )
    return DiagnosisService(
        workspace,
        evidence_service=evidence_service,
        provider=provider,
        cache_root=Path.home() / ".mona" / "stock" / "cache",
    )


def _store() -> WatchlistStore:
    global _STORE
    if _STORE is None:
        _STORE = WatchlistStore(Path.home() / ".mona" / "stock")
    return _STORE


def _provider() -> FailoverProvider:
    """Tencent primary (batched, throttle-tolerant) + East Money fallback."""
    global _PROVIDER
    if _PROVIDER is None:
        _PROVIDER = FailoverProvider(TencentProvider(), EastMoneyProvider())
    return _PROVIDER


def _screening(request: web.Request | None = None) -> StockScreeningService:
    """Build the shared screening service for the current services app."""
    global _SCREENING_SERVICE, _SCREENING_WORKSPACE
    raw_workspace = request.app.get("workspace") if request is not None else None
    workspace = Path(raw_workspace) if raw_workspace else None
    if (
        _SCREENING_SERVICE is None
        or _SCREENING_WORKSPACE != workspace
        or _SCREENING_SERVICE.provider is not _provider()
    ):
        _SCREENING_WORKSPACE = workspace
        _SCREENING_SERVICE = StockScreeningService(
            provider=_provider(),
            workspace=workspace,
        )
    return _SCREENING_SERVICE


def _intraday_provider() -> IntradayFailoverProvider:
    """Dedicated chain: East Money trends2 primary, Tencent minute backup."""
    global _INTRADAY_PROVIDER
    if _INTRADAY_PROVIDER is None:
        _INTRADAY_PROVIDER = IntradayFailoverProvider(
            EastMoneyProvider(), TencentProvider()
        )
    return _INTRADAY_PROVIDER


def _intraday_service() -> IntradayService:
    global _INTRADAY_SERVICE
    if _INTRADAY_SERVICE is None:
        _INTRADAY_SERVICE = IntradayService(
            _intraday_provider(),
            IntradayStore(_store().root),
        )
    return _INTRADAY_SERVICE


async def cleanup_stock_intraday() -> None:
    """Stop intraday refresh tasks and close its SQLite connection."""
    global _INTRADAY_SERVICE
    service = _INTRADAY_SERVICE
    _INTRADAY_SERVICE = None
    if service is not None:
        await service.close()


def _error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


def _parse_instrument_id(raw: str) -> InstrumentRef:
    """Accept ``EXCHANGE:symbol`` or a bare 6-digit equity code."""
    text = raw.strip()
    match = _ID_RE.match(text)
    if match:
        return InstrumentRef(exchange=match.group(1), symbol=match.group(2))
    if ":" not in text and re.fullmatch(r"\d{6}", text):
        return InstrumentRef(exchange=infer_exchange(text), symbol=text)
    raise ValueError(f"unknown instrument id {raw!r}")


def _resolve_instrument(raw: str, watchlist: dict[str, WatchlistItem]) -> InstrumentRef:
    """Use the saved instrument type when this id belongs to the watchlist."""
    parsed = _parse_instrument_id(raw)
    saved = watchlist.get(parsed.id)
    if saved is None:
        return parsed
    return InstrumentRef(
        exchange=parsed.exchange,
        symbol=parsed.symbol,
        instrument_type=saved.instrument_type,
    )


def _watchlist_by_id() -> dict[str, WatchlistItem]:
    return {item.id: item for item in _store().list()}


def _risk_profile_store(request: web.Request) -> LocalRiskProfileStore:
    workspace = request.app.get("workspace")
    if workspace is None:
        workspace = Path.home() / ".mona" / "workspace"
    return LocalRiskProfileStore(risk_profile_path(workspace))


def _risk_profile_payload(store: LocalRiskProfileStore) -> dict[str, Any]:
    profile = store.get_risk_profile().model_dump(mode="json")
    level_labels = {
        "conservative": "保守",
        "balanced": "稳健",
        "aggressive": "积极",
    }
    return {
        "profile": profile,
        "configured": bool(profile.get("configured")),
        "riskLevelLabel": level_labels.get(profile.get("risk_level"), "保守"),
        "displayMetadata": store.display_metadata(),
        "storage": {"localOnly": True, "brokerConnected": False},
    }


def _portfolio_context_payload(instrument_id: str, context: Any) -> dict[str, Any]:
    raw = context.model_dump(mode="json")
    exact_value_configured = raw.get("portfolio_value_yuan") is not None
    raw["portfolio_value_configured"] = exact_value_configured
    return {
        "instrumentId": instrument_id,
        "context": raw,
        "configured": context.holding_state == "holding" or exact_value_configured,
        "storage": {"localOnly": True, "brokerConnected": False},
    }


async def handle_stock_risk_profile(request: web.Request) -> web.Response:
    """Read or save the local risk profile; no broker/account access."""
    store = _risk_profile_store(request)
    try:
        if request.method == "GET":
            return web.json_response(_risk_profile_payload(store))
        data = await _json_body(request)
        profile = data.get("profile") if isinstance(data.get("profile"), dict) else data
        saved = store.save_risk_profile(profile)
        payload = _risk_profile_payload(store)
        payload["profile"] = saved.model_dump(mode="json")
        payload["configured"] = True
        return web.json_response(payload)
    except RiskProfileStorageError as exc:
        return _error(500, "risk_profile_store_error", str(exc))
    except (ValueError, TypeError) as exc:
        return _error(400, "risk_profile_invalid", str(exc))


async def handle_stock_risk_profile_delete(request: web.Request) -> web.Response:
    try:
        profile = _risk_profile_store(request).clear_risk_profile()
        return web.json_response(
            {
                "profile": profile.model_dump(mode="json"),
                "configured": False,
                "storage": {"localOnly": True, "brokerConnected": False},
            }
        )
    except RiskProfileStorageError as exc:
        return _error(500, "risk_profile_store_error", str(exc))
    except (ValueError, TypeError) as exc:
        return _error(400, "risk_profile_invalid", str(exc))


async def handle_stock_portfolio_context(request: web.Request) -> web.Response:
    store = _risk_profile_store(request)
    raw_id = request.query.get("instrumentId") or request.query.get("instrument_id")
    body: dict[str, Any] = {}
    if request.method in {"PUT", "DELETE"}:
        body = await _json_body(request)
        raw_id = raw_id or body.get("instrumentId") or body.get("instrument_id")
    try:
        instrument = _parse_instrument_id(str(raw_id or ""))
        instrument_id = instrument.id
        if request.method == "GET":
            context = store.get_portfolio_context(instrument_id)
        elif request.method == "DELETE":
            context = store.delete_portfolio_context(instrument_id)
        else:
            context_payload = body.get("context") if isinstance(body.get("context"), dict) else body
            context = store.save_portfolio_context(instrument_id, context_payload)
        return web.json_response(_portfolio_context_payload(instrument_id, context))
    except RiskProfileStorageError as exc:
        return _error(500, "portfolio_context_store_error", str(exc))
    except (ValueError, TypeError) as exc:
        return _error(400, "portfolio_context_invalid", str(exc))


def _item_payload(item: WatchlistItem) -> dict:
    """CamelCase dump plus the synthetic ``instrumentId`` (a property)."""
    payload = item.model_dump(by_alias=True)
    payload["instrumentId"] = item.id
    return payload


def _items_payload(items: list[WatchlistItem]) -> web.Response:
    return web.json_response({"items": [_item_payload(i) for i in items]})


async def _json_body(request: web.Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# --- standard AI diagnosis -------------------------------------------------


_DIAGNOSIS_CREATE_FIELDS = {
    "instrumentId",
    "evidenceContextId",
    "holdingState",
    "execute",
}


def _diagnosis_wire(record: dict[str, Any], *, include_report: bool = True) -> dict[str, Any]:
    """Project durable snake_case run state to the stock HTTP contract."""
    result = {
        "diagnosisId": record.get("diagnosis_id"),
        "workflowId": record.get("workflow_id"),
        "status": record.get("status"),
        "instrument": record.get("instrument"),
        "evidenceContextId": record.get("evidence_context_id"),
        "createdAt": record.get("created_at"),
        "updatedAt": record.get("updated_at"),
        "attempt": record.get("attempt", 1),
        "agentSteps": record.get("agent_steps") or [],
        "agentStepCount": record.get("agent_step_count", 0),
        "llmAgentSteps": record.get("llm_agent_steps", 0),
        "inputHash": record.get("input_hash"),
        "holdingState": record.get("holding_state", "not_holding"),
        "error": record.get("error"),
        "errorCode": record.get("error_code"),
    }
    if include_report and record.get("report") is not None:
        result["report"] = record.get("report")
        result["markdown"] = record.get("markdown") or ""
    return result


def _diagnosis_input(data: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(data) - _DIAGNOSIS_CREATE_FIELDS)
    if unknown:
        raise ValueError("unknown diagnosis fields: " + ", ".join(unknown))
    raw_instrument = data.get("instrumentId")
    if not isinstance(raw_instrument, str) or not raw_instrument.strip():
        raise ValueError("missing instrumentId")
    instrument_ref = _resolve_instrument(raw_instrument, _watchlist_by_id())
    instrument = {
        "symbol": instrument_ref.symbol,
        "exchange": instrument_ref.exchange,
        "instrument_type": instrument_ref.instrument_type,
        "name": "",
    }
    holding_state = data.get("holdingState", "not_holding")
    if holding_state not in {"holding", "not_holding"}:
        raise ValueError("holdingState must be holding or not_holding")
    context_id = data.get("evidenceContextId")
    if context_id is not None and (not isinstance(context_id, str) or not context_id.strip()):
        raise ValueError("evidenceContextId must be a non-empty string")
    normalized = {
        "instrument": instrument,
        "evidence_context_id": context_id.strip() if isinstance(context_id, str) else None,
        "holding_state": holding_state,
    }
    execute = data.get("execute", True)
    if not isinstance(execute, bool):
        raise ValueError("execute must be boolean")
    normalized["execute"] = execute
    return normalized


async def handle_stock_diagnosis_create(request: web.Request) -> web.Response:
    data = await _json_body(request)
    try:
        payload = _diagnosis_input(data)
        execute = payload.pop("execute")
        service = _diagnosis_service(request)
        prepare_context = getattr(service, "prepare_context", None)
        if callable(prepare_context) and (
            not isinstance(service, DiagnosisService)
            or getattr(service, "evidence_service", None) is not None
        ):
            prepared = await prepare_context(
                instrument=payload["instrument"],
                evidence_context_id=payload.get("evidence_context_id"),
            )
            context_id = prepared[0] if isinstance(prepared, tuple) else prepared
            if not isinstance(context_id, str) or not context_id.strip():
                raise ValueError("evidence context preparation returned no context id")
            payload["evidence_context_id"] = context_id
        diagnosis_id = payload.pop("diagnosis_id", None)
        record = service.create(diagnosis_id=diagnosis_id, **payload)
        if execute:
            record = await service.execute(str(record["diagnosis_id"]))
    except (ValueError, ValidationError) as exc:
        return _error(400, "invalid_diagnosis", str(exc))
    except DiagnosisStateError as exc:
        return _error(409, "diagnosis_conflict", str(exc))
    status = 201 if record.get("status") in {"succeeded", "failed", "cancelled"} else 202
    return web.json_response(_diagnosis_wire(record), status=status)


async def handle_stock_diagnosis_list(request: web.Request) -> web.Response:
    raw_limit = request.query.get("limit", "50")
    try:
        limit = max(1, min(int(raw_limit), 200))
    except ValueError:
        return _error(400, "invalid_params", "invalid limit")
    instrument_id = request.query.get("instrumentId") or request.query.get("instrument_id")
    status = request.query.get("status")
    if status and status not in {"queued", "running", "succeeded", "failed", "cancelled"}:
        return _error(400, "invalid_params", "invalid diagnosis status")
    service = _diagnosis_service(request)
    items = [_diagnosis_wire(item, include_report=False) for item in service.list(instrument_id=instrument_id, status=status, limit=limit)]
    return web.json_response({"items": items})


async def handle_stock_diagnosis_get(request: web.Request) -> web.Response:
    diagnosis_id = request.match_info.get("diagnosis_id", "")
    try:
        record = _diagnosis_service(request).get(diagnosis_id)
    except (ValueError, DiagnosisNotFoundError):
        return _error(404, "diagnosis_not_found", "诊股记录不存在")
    return web.json_response(_diagnosis_wire(record))


async def handle_stock_diagnosis_delete(request: web.Request) -> web.Response:
    diagnosis_id = request.match_info.get("diagnosis_id", "")
    try:
        record = _diagnosis_service(request).delete(diagnosis_id)
    except (ValueError, DiagnosisNotFoundError):
        return _error(404, "diagnosis_not_found", "诊股记录不存在")
    except DiagnosisStateError:
        return _error(409, "diagnosis_state_conflict", "诊股仍在进行中，暂时不能删除")
    except DiagnosisStorageError:
        return _error(500, "diagnosis_delete_failed", "诊股记录删除失败")
    return web.json_response({"deleted": record["diagnosis_id"]})


async def handle_stock_diagnosis_cancel(request: web.Request) -> web.Response:
    diagnosis_id = request.match_info.get("diagnosis_id", "")
    data = await _json_body(request)
    reason = str(data.get("reason") or "cancelled by user")
    try:
        record = _diagnosis_service(request).cancel(diagnosis_id, reason=reason)
    except DiagnosisNotFoundError:
        return _error(404, "diagnosis_not_found", "诊股记录不存在")
    except (ValueError, DiagnosisStateError) as exc:
        return _error(409, "diagnosis_state_conflict", str(exc))
    return web.json_response(_diagnosis_wire(record))


async def handle_stock_diagnosis_fail(request: web.Request) -> web.Response:
    diagnosis_id = request.match_info.get("diagnosis_id", "")
    data = await _json_body(request)
    reason = data.get("reason") or data.get("error")
    if not isinstance(reason, str) or not reason.strip():
        return _error(400, "invalid_params", "failure reason is required")
    try:
        record = _diagnosis_service(request).fail(
            diagnosis_id,
            reason=reason,
            code=str(data.get("code") or "diagnosis_failed"),
        )
    except DiagnosisNotFoundError:
        return _error(404, "diagnosis_not_found", "诊股记录不存在")
    except (ValueError, DiagnosisStateError) as exc:
        return _error(409, "diagnosis_state_conflict", str(exc))
    return web.json_response(_diagnosis_wire(record))


async def handle_stock_diagnosis_retry(request: web.Request) -> web.Response:
    diagnosis_id = request.match_info.get("diagnosis_id", "")
    data = await _json_body(request)
    execute = data.get("execute", data.get("start", True))
    if not isinstance(execute, bool):
        return _error(400, "invalid_params", "execute must be boolean")
    try:
        service = _diagnosis_service(request)
        record = service.retry(diagnosis_id)
        if execute:
            record = await service.execute(diagnosis_id)
    except DiagnosisNotFoundError:
        return _error(404, "diagnosis_not_found", "诊股记录不存在")
    except (ValueError, DiagnosisStateError) as exc:
        return _error(409, "diagnosis_state_conflict", str(exc))
    status = 201 if record.get("status") in {"succeeded", "failed", "cancelled"} else 202
    return web.json_response(_diagnosis_wire(record), status=status)


# --- outcome tracking ---


def _stock_projects_root(request: web.Request) -> Path:
    workspace = request.app.get("workspace")
    if workspace is None:
        workspace = Path.home() / ".mona" / "workspace"
    return Path(workspace).expanduser() / "stock_projects"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _iter_stock_documents(root: Path) -> Iterator[tuple[Path, str, dict[str, Any]]]:
    """Yield readable report/digest documents without using a provider."""
    if not root.is_dir():
        return
    try:
        run_dirs = sorted(root.iterdir())
    except OSError:
        return
    for run_dir in run_dirs:
        if not run_dir.is_dir():
            continue
        for stem in ("report", "digest"):
            path = run_dir / f"{stem}.json"
            if not path.is_file():
                continue
            document = _read_json(path)
            if document is not None:
                yield run_dir, stem, document


def _find_outcome_report(
    root: Path, report_id: str
) -> tuple[Path, dict[str, Any], bool] | None:
    """Return ``(run_dir, document, is_v4)`` for a report id."""
    for run_dir, stem, document in _iter_stock_documents(root):
        if document.get("report_id") != report_id:
            continue
        is_v4 = stem == "report" and (
            document.get("kind") == "deep_research"
            and document.get("schema_version") == 4
        )
        return run_dir, document, is_v4
    return None


def _is_v4_report(document: dict[str, Any]) -> bool:
    return (
        document.get("kind") == "deep_research"
        and document.get("schema_version") == 4
    )


def _find_decision_report(
    root: Path, report_id: str
) -> tuple[Path, dict[str, Any], bool] | None:
    """Find a valid current V5 or legacy V4 report for decision queries."""
    from mona.services.stock.reports import is_v5_report

    for run_dir, stem, document in _iter_stock_documents(root):
        if stem != "report" or document.get("report_id") != report_id:
            continue
        if _is_v4_report(document) or is_v5_report(document):
            return run_dir, document, _is_v4_report(document)
    return None


def _load_or_build_tracking(
    run_dir: Path, report: dict[str, Any], *, persist_missing: bool
) -> dict[str, Any]:
    path = run_dir / "outcome_tracking.json"
    if path.is_file():
        tracking = _read_json(path)
        if tracking is None:
            raise ValueError("outcome tracking is unreadable")
        return tracking
    tracking = build_outcome_tracking_snapshot(report)
    if tracking is None:
        raise ValueError("report is not a V4 deep-research report")
    if persist_missing:
        return ensure_outcome_tracking_snapshot(run_dir, report)
    return tracking


def _iter_v4_reports(
    root: Path,
) -> Iterator[tuple[Path, dict[str, Any], dict[str, Any]]]:
    for run_dir, stem, document in _iter_stock_documents(root):
        if stem != "report" or not _is_v4_report(document):
            continue
        tracking = _load_or_build_tracking(run_dir, document, persist_missing=True)
        yield run_dir, document, tracking


def _find_v6_outcome_report(
    root: Path, report_id: str
) -> tuple[Path, dict[str, Any]] | None:
    from mona.services.stock.reports import is_v6_report

    for run_dir, stem, document in _iter_stock_documents(root):
        if stem == "report" and document.get("report_id") == report_id and is_v6_report(document):
            return run_dir, document
    return None


def _load_v6_tracking(run_dir: Path, report: dict[str, Any]) -> dict[str, Any]:
    path = run_dir / V6_TRACKING_FILE
    if path.is_file():
        tracking = _read_json(path)
        if tracking is None:
            raise ValueError("V6 outcome tracking is unreadable")
        return tracking
    return ensure_v6_tracking_snapshot(run_dir, report)


def _v6_outcome_payload(
    run_dir: Path,
    report: dict[str, Any],
    tracking: dict[str, Any],
    *,
    pending: list[dict[str, Any]] | None = None,
    updated: bool = False,
    append_count: int = 0,
) -> dict[str, Any]:
    tracking_id = tracking.get("trackingId")
    observations = latest_v6_observations(run_dir, tracking_id)
    return {
        "version": 6,
        "reportId": report.get("report_id"),
        "tracking": tracking,
        "observations": observations,
        "pending": pending or [],
        "aggregate": aggregate_v6_observations(observations),
        "samples": observations,
        "sampleCount": len(observations),
        "updated": updated,
        "appendCount": append_count,
        "publicMarketBenchmark": dict(tracking.get("benchmark") or {}),
    }


def _outcome_payload(
    request: web.Request,
    *,
    selected: tuple[Path, dict[str, Any], dict[str, Any]] | None = None,
    pending: list[dict[str, Any]] | None = None,
    updated: bool = False,
    append_count: int = 0,
) -> dict[str, Any]:
    all_observations: list[dict[str, Any]] = []
    selected_observations: list[dict[str, Any]] = []
    selected_report_id = None
    selected_tracking = None
    for run_dir, report, tracking in _iter_v4_reports(_stock_projects_root(request)):
        observations = read_latest_outcome_observations(
            run_dir, tracking.get("tracking_id") or (tracking.get("tracking") or {}).get("id")
        )
        all_observations.extend(observations)
        if selected is not None and run_dir == selected[0]:
            selected_report_id = report.get("report_id")
            selected_tracking = tracking
            selected_observations = observations
    if selected is not None and selected_tracking is None:
        selected_report_id = selected[1].get("report_id")
        selected_tracking = selected[2]
        selected_observations = read_latest_outcome_observations(
            selected[0],
            selected_tracking.get("tracking_id")
            or (selected_tracking.get("tracking") or {}).get("id"),
        )
    return {
        "reportId": selected_report_id,
        "tracking": selected_tracking,
        "observations": selected_observations,
        "pending": pending or [],
        "aggregate": aggregate_outcome_observations(all_observations),
        "samples": all_observations,
        "sampleCount": len(all_observations),
        "updated": updated,
        "appendCount": append_count,
        "publicMarketBenchmark": dict(PUBLIC_MARKET_BENCHMARK),
    }


def _pending_observation(row: dict[str, Any]) -> dict[str, Any]:
    pending = dict(row)
    pending["status"] = "pending"
    pending["pending_reason"] = "window_not_mature"
    return pending


def _target_instrument(report: dict[str, Any]) -> InstrumentRef:
    instrument = report.get("instrument")
    if not isinstance(instrument, dict):
        raise ValueError("report instrument is missing")
    exchange = instrument.get("exchange")
    symbol = instrument.get("symbol")
    if not isinstance(exchange, str) or not isinstance(symbol, str):
        raise ValueError("report instrument is invalid")
    return InstrumentRef(
        exchange=exchange,
        symbol=symbol,
        instrument_type=instrument.get("instrument_type", "equity"),
    )


def _decision_metric(value: float | None, source_id: str | None, as_of: str | None) -> dict[str, Any]:
    return {
        "value": value,
        "source_ids": [source_id] if source_id else [],
        "as_of": as_of,
    }


def _evidence_source_ids(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return []
    raw = value.get("source_ids") or value.get("sourceIds")
    if isinstance(raw, str):
        raw = [raw]
    return list(dict.fromkeys(item.strip() for item in (raw or []) if isinstance(item, str) and item.strip()))


def _evidence_time(value: Any, fallback: str | None) -> str | None:
    if not isinstance(value, dict):
        return fallback
    return value.get("observed_at") or value.get("as_of") or value.get("valid_at") or fallback


def _frozen_evidence_metrics(bundle: dict[str, Any]) -> dict[str, Any]:
    """Flatten only numeric values from the immutable run Evidence bundle."""
    metrics: dict[str, Any] = {}
    kline_source_ids = [
        source.get("id")
        for source in bundle.get("sources") or []
        if isinstance(source, dict)
        and isinstance(source.get("id"), str)
        and "date" in (source.get("fields") or [])
    ]
    fallback_as_of = bundle.get("market_as_of") or bundle.get("research_cutoff_at")

    def walk(value: Any, prefix: str, inherited_sources: list[str], inherited_as_of: str | None) -> None:
        if isinstance(value, dict):
            local_sources = _evidence_source_ids(value) or inherited_sources
            local_as_of = _evidence_time(value, inherited_as_of)
            if "value" in value and isinstance(value.get("value"), (int, float)) and not isinstance(value.get("value"), bool):
                if prefix:
                    metrics[prefix] = _decision_metric(value["value"], local_sources[0] if local_sources else None, local_as_of)
                    metrics[prefix]["source_ids"] = local_sources
            for key, child in value.items():
                if key in {"source_ids", "source", "value", "as_of", "observed_at", "valid_at"}:
                    continue
                child_prefix = f"{prefix}.{key}" if prefix else str(key)
                child_sources = local_sources
                if child_prefix.startswith("indicators.") and not child_sources:
                    child_sources = kline_source_ids
                walk(child, child_prefix, child_sources, local_as_of)
            return
        if isinstance(value, (int, float)) and not isinstance(value, bool) and prefix:
            sources = inherited_sources
            if prefix.startswith("indicators.") and not sources:
                sources = kline_source_ids
            metrics[prefix] = _decision_metric(value, sources[0] if sources else None, inherited_as_of)

    walk(bundle, "", [], fallback_as_of)
    return metrics


def _merge_current_metric(
    metrics: dict[str, Any],
    reference: str,
    current: dict[str, Any],
    previous_value: float | None = None,
) -> None:
    frozen = metrics.get(reference)
    if isinstance(frozen, dict):
        frozen["observed_value"] = current.get("value")
        frozen["observed_source_ids"] = current.get("source_ids") or []
        frozen["observed_as_of"] = current.get("as_of")
        frozen["observed_previous_value"] = previous_value
        return
    metrics[reference] = {
        **current,
        "current_only": True,
        "observed_previous_value": previous_value,
    }


def _previous_close_before_quote(series: Any, quote_as_of: str | None) -> float | None:
    quote_time = parse_asia_datetime(quote_as_of)
    if quote_time is None:
        return None
    bars = []
    for bar in getattr(series, "bars", []) or []:
        bar_time = parse_asia_datetime(getattr(bar, "date", None))
        if bar_time is not None and bar_time <= quote_time:
            bars.append((bar_time, bar.close))
    bars.sort(key=lambda item: item[0])
    if not bars:
        return None
    if bars[-1][0].date() == quote_time.date():
        bars.pop()
    return bars[-1][1] if bars else None


async def _decision_metrics(report: dict[str, Any], run_dir: Path | None = None) -> dict[str, Any]:
    """Read current observed data and frozen references from the run Evidence."""
    instrument = _target_instrument(report)
    metrics: dict[str, Any] = {}
    if run_dir is not None:
        evidence = _read_json(run_dir / "evidence.json")
        symbols = evidence.get("symbols") if isinstance(evidence, dict) else None
        bundle = symbols.get(instrument.id) if isinstance(symbols, dict) else None
        if isinstance(bundle, dict):
            metrics = _frozen_evidence_metrics(bundle)
    quote_as_of: str | None = None
    try:
        quote = await _provider().quote(instrument)
    except ProviderError:
        quote = None
    if quote is not None:
        source_id = getattr(quote.source, "id", None)
        as_of = quote.as_of or getattr(quote.source, "published_at", None)
        quote_as_of = as_of
        price = _decision_metric(quote.price, source_id, as_of)
        _merge_current_metric(metrics, "quote.price", price)
        _merge_current_metric(metrics, "quote.close", price)
        _merge_current_metric(metrics, "quote.change_pct", _decision_metric(quote.change_pct, source_id, as_of))

    try:
        series = await _provider().kline(instrument, limit=60, klt=101)
    except ProviderError:
        series = None
    if series is not None:
        source_id = getattr(series.source, "id", None)
        as_of = getattr(series.source, "fetched_at", None) or quote_as_of
        closes = [bar.close for bar in series.bars]
        previous_close = _previous_close_before_quote(series, quote_as_of)
        if previous_close is None and len(closes) > 1:
            previous_close = closes[-2]
        if quote is not None:
            current_quote = _decision_metric(quote.price, getattr(quote.source, "id", None), quote_as_of)
            _merge_current_metric(metrics, "quote.price", current_quote, previous_close)
            _merge_current_metric(metrics, "quote.close", current_quote, previous_close)
        for window in (5, 10, 20, 60):
            values = sma(closes, window)
            _merge_current_metric(
                metrics,
                f"indicators.ma{window}",
                _decision_metric(values[-1] if values else None, source_id, as_of),
                values[-2] if len(values) > 1 else None,
            )
        swing = swing_high_low(
            [bar.high for bar in series.bars],
            [bar.low for bar in series.bars],
        )
        previous_swing = swing_high_low(
            [bar.high for bar in series.bars[:-1]],
            [bar.low for bar in series.bars[:-1]],
        )
        _merge_current_metric(
            metrics,
            "indicators.swing.support",
            _decision_metric(swing.get("support"), source_id, as_of),
            previous_swing.get("support"),
        )
        _merge_current_metric(
            metrics,
            "indicators.swing.resistance",
            _decision_metric(swing.get("resistance"), source_id, as_of),
            previous_swing.get("resistance"),
        )
    return metrics


def _decision_payload(result: dict[str, Any]) -> dict[str, Any]:
    horizon_aliases = {
        "short_term": "shortTerm",
        "medium_term": "mediumTerm",
        "long_term": "longTerm",
    }
    horizons: dict[str, Any] = {}
    for horizon, value in (result.get("horizons") or {}).items():
        if not isinstance(value, dict):
            continue
        conditions = []
        for condition in value.get("conditions") or []:
            if not isinstance(condition, dict):
                continue
            group = str(condition.get("group") or "")
            group = group.removesuffix("_conditions")
            conditions.append(
                {
                    "group": group,
                    "groupLabel": condition.get("group_label", "条件"),
                    "text": condition.get("text", ""),
                    "sourceIds": condition.get("source_ids", []),
                    "status": condition.get("status", "not_evaluable"),
                    "statusLabel": condition.get("status_label", "暂无法判断"),
                    "evaluatedAt": condition.get("evaluated_at"),
                    "methodVersion": condition.get("method_version"),
                    "reason": condition.get("reason", "当前无法判断条件是否满足"),
                }
            )
        risk_reward = value.get("risk_reward") if isinstance(value.get("risk_reward"), dict) else {}
        horizons[horizon_aliases.get(horizon, horizon)] = {
            "conditions": conditions,
            "riskReward": {
                "status": risk_reward.get("status", "not_evaluable"),
                "statusLabel": risk_reward.get("status_label", "暂无法判断"),
                "ratio": risk_reward.get("ratio"),
                "direction": risk_reward.get("direction", "unknown"),
                "evaluatedAt": risk_reward.get("evaluated_at"),
                "methodVersion": risk_reward.get("method_version"),
                "reason": risk_reward.get("reason", "暂无法计算风险收益比"),
            },
        }
    return {
        "reportId": result.get("report_id"),
        "evaluatedAt": result.get("evaluated_at"),
        "methodVersion": result.get("method_version"),
        "horizons": horizons,
    }


def _v5_condition_status(group: str, price: float, plan: dict[str, Any], index: int) -> str:
    if group == "entry":
        return "triggered" if price >= plan["reference_buy_high"] else "not_triggered"
    if group == "exit":
        return "triggered" if price <= plan["stop_loss"] else "not_triggered"
    targets = (plan["first_take_profit"], plan["second_take_profit"])
    target = targets[min(index, len(targets) - 1)]
    return "triggered" if price >= target else "not_triggered"


def _v5_decision_conditions(
    report: dict[str, Any], quote: Quote, *, market_as_of: str
) -> dict[str, Any]:
    aliases = {
        "short_term": "shortTerm",
        "medium_term": "mediumTerm",
        "long_term": "longTerm",
    }
    group_labels = {
        "entry": "参与条件",
        "exit": "退出/止损条件",
        "take_profit": "止盈条件",
    }
    horizons: dict[str, Any] = {}
    for source_key, public_key in aliases.items():
        decision = report["horizon_decisions"][source_key]
        plan = decision["trading_plan"]
        output_conditions: list[dict[str, Any]] = []
        for group, field in (
            ("entry", "entry_conditions"),
            ("exit", "exit_conditions"),
            ("take_profit", "take_profit_conditions"),
        ):
            conditions = plan[field]
            if group == "take_profit":
                conditions = [
                    {
                        "description": f"价格达到第一止盈参考 {plan['first_take_profit']:.2f} 元"
                    },
                    {
                        "description": f"价格达到第二止盈参考 {plan['second_take_profit']:.2f} 元"
                    },
                ]
            rows: list[dict[str, Any]] = []
            for index, condition in enumerate(conditions):
                rows.append(
                    {
                        "group": group,
                        "groupLabel": group_labels[group],
                        "text": condition["description"],
                        "status": _v5_condition_status(group, quote.price, plan, index),
                        "evaluatedAt": market_as_of,
                        "currentPrice": quote.price,
                    }
                )
            output_conditions.extend(rows)
        horizons[public_key] = {
            "conditions": output_conditions,
            "riskReward": {
                "first": plan["risk_reward_first"],
                "second": plan["risk_reward_second"],
            },
        }
    return {
        "reportId": report["report_id"],
        "schemaVersion": 5,
        "evaluatedAt": datetime.now(CN_TZ).isoformat(),
        "marketAsOf": market_as_of,
        "currentPrice": quote.price,
        "horizons": horizons,
    }


async def handle_stock_decision_conditions(request: web.Request) -> web.Response:
    """Read a report and current market metrics without persisting or refreshing."""
    report_id = request.query.get("reportId", "").strip()
    if not report_id or not re.fullmatch(r"^[a-z0-9_]+$", report_id):
        return _error(400, "invalid_params", "报告编号格式无效")
    found = _find_decision_report(_stock_projects_root(request), report_id)
    if found is None:
        return _error(404, "report_not_found", "投研报告不存在")
    run_dir, report, is_v4 = found
    if not is_v4:
        try:
            quote = await _provider().quote(_target_instrument(report))
        except ProviderError as exc:
            return _error(502, "market_data_unavailable", f"当前行情获取失败：{exc}")
        price = getattr(quote, "price", None) if quote is not None else None
        if (
            isinstance(price, bool)
            or not isinstance(price, (int, float))
            or not math.isfinite(price)
            or price <= 0
        ):
            return _error(502, "market_data_unavailable", "当前行情获取失败，请稍后重试")
        source = getattr(quote, "source", None)
        market_as_of = (
            getattr(quote, "as_of", None)
            or getattr(source, "published_at", None)
            or getattr(source, "fetched_at", None)
        )
        if not isinstance(market_as_of, str) or parse_asia_datetime(market_as_of) is None:
            return _error(502, "market_data_unavailable", "当前行情缺少有效时间，请稍后重试")
        return web.json_response(
            _v5_decision_conditions(report, quote, market_as_of=market_as_of)
        )
    try:
        metrics = await _decision_metrics(report, run_dir)
    except (AttributeError, ProviderError, TypeError, ValueError):
        metrics = {}
    result = evaluate_decision_conditions(
        report,
        metrics,
        evaluated_at=datetime.now(CN_TZ),
    )
    return web.json_response(_decision_payload(result))


def _post_report_dates(snapshot: dict[str, Any], bars: Any) -> set[str]:
    """Return the available benchmark calendar after the report date."""
    report_value = (
        snapshot.get("report_as_of")
        or snapshot.get("research_cutoff_at")
        or snapshot.get("market_as_of")
    )
    report_date = None
    if isinstance(report_value, str):
        parsed = parse_asia_datetime(report_value)
        report_date = parsed.date() if parsed is not None else None
    if report_date is None:
        return set()
    dates: set[str] = set()
    for bar in bars or []:
        value = getattr(bar, "date", None)
        if isinstance(value, str):
            parsed = parse_asia_datetime(value)
            if parsed is not None and parsed.date() > report_date:
                dates.add(parsed.date().isoformat())
    return dates


def _is_mature_observation(row: dict[str, Any], benchmark_dates: set[str]) -> bool:
    """Mature on the target endpoint or the benchmark's N-day calendar.

    The benchmark calendar is authoritative for the window clock. This lets
    a target with missing bars be persisted as an explicit incomplete result
    once the endpoint date has elapsed, while genuinely future windows stay
    pending.
    """
    if row.get("entry_date") is not None and row.get("exit_date") is not None:
        return True
    try:
        window = int(row.get("window"))
    except (TypeError, ValueError):
        return False
    return len(benchmark_dates) >= window


async def handle_stock_outcomes(request: web.Request) -> web.Response:
    """Read local V4/V6 tracking/observations; never fetch market data."""
    report_id = request.query.get("reportId", "").strip() or None
    root = _stock_projects_root(request)
    selected = None
    if report_id is not None:
        if not re.fullmatch(r"^[a-z0-9_]+$", report_id):
            return _error(400, "invalid_params", "malformed report id")
        v6_found = _find_v6_outcome_report(root, report_id)
        if v6_found is not None:
            run_dir, report = v6_found
            try:
                tracking = _load_v6_tracking(run_dir, report)
            except (OSError, ValueError) as exc:
                return _error(500, "tracking_unavailable", str(exc))
            try:
                return web.json_response(_v6_outcome_payload(run_dir, report, tracking))
            except (OSError, ValueError) as exc:
                return _error(500, "tracking_corrupt", str(exc))
        found = _find_outcome_report(root, report_id)
        if found is None:
            return _error(404, "report_not_found", f"report {report_id!r} not found")
        run_dir, report, is_v4 = found
        if not is_v4:
            return _error(400, "unsupported_report", "only V4 deep-research reports are tracked")
        try:
            selected = (run_dir, report, _load_or_build_tracking(run_dir, report, persist_missing=True))
        except ValueError as exc:
            return _error(500, "tracking_unavailable", str(exc))
    try:
        payload = _outcome_payload(request, selected=selected)
        v6_samples: list[dict[str, Any]] = []
        for run_dir, stem, report in _iter_stock_documents(root):
            if stem != "report" or not _find_v6_outcome_report(root, report.get("report_id", "")):
                continue
            try:
                tracking = _load_v6_tracking(run_dir, report)
            except (OSError, ValueError) as exc:
                return _error(500, "tracking_corrupt", str(exc))
            v6_samples.extend(latest_v6_observations(run_dir, tracking.get("trackingId")))
        payload["v6"] = {
            "observations": v6_samples,
            "aggregate": aggregate_v6_observations(v6_samples),
            "sampleCount": len(v6_samples),
        }
        return web.json_response(payload)
    except (OSError, ValueError) as exc:
        return _error(500, "tracking_unavailable", str(exc))


async def handle_stock_outcomes_refresh(request: web.Request) -> web.Response:
    """Explicitly refresh one V4 or V6 report's mature outcome windows."""
    data = await _json_body(request)
    report_id = str(data.get("reportId") or data.get("report_id") or "").strip()
    if not report_id or not re.fullmatch(r"^[a-z0-9_]+$", report_id):
        return _error(400, "invalid_params", "malformed or missing reportId")
    v6_found = _find_v6_outcome_report(_stock_projects_root(request), report_id)
    if v6_found is not None:
        run_dir, report = v6_found
        try:
            target = _target_instrument(report)
            snapshot = _load_v6_tracking(run_dir, report)
            target_series = await _provider().kline(target, limit=640, klt=101)
            benchmark = InstrumentRef(exchange="XSHG", symbol="000985", instrument_type="index")
            benchmark_series = await _provider().kline(benchmark, limit=640, klt=101)
            calculated = calculate_v6_observations(
                snapshot,
                target_series.bars,
                benchmark_series.bars,
                calculated_at=datetime.now(CN_TZ).isoformat(),
            )
            pending = [row for row in calculated if row.get("status") != "available"]
            append_count = sum(
                int(append_v6_observation(run_dir, row))
                for row in calculated
            )
        except ProviderError as exc:
            return _error(502, "upstream_unavailable", str(exc))
        except (OSError, ValueError, TypeError) as exc:
            return _error(500, "outcome_calculation_failed", str(exc))
        return web.json_response(
            _v6_outcome_payload(
                run_dir,
                report,
                snapshot,
                pending=pending,
                updated=append_count > 0,
                append_count=append_count,
            )
        )
    found = _find_outcome_report(_stock_projects_root(request), report_id)
    if found is None:
        return _error(404, "report_not_found", f"report {report_id!r} not found")
    run_dir, report, is_v4 = found
    if not is_v4:
        return _error(400, "unsupported_report", "only V4 deep-research reports are tracked")
    try:
        target = _target_instrument(report)
        snapshot = _load_or_build_tracking(run_dir, report, persist_missing=False)
    except (TypeError, ValueError) as exc:
        return _error(400, "invalid_report", str(exc))

    benchmark = InstrumentRef(
        exchange="XSHG", symbol="000985", instrument_type="index"
    )
    try:
        target_series = await _provider().kline(target, limit=640, klt=101)
        benchmark_series = await _provider().kline(benchmark, limit=640, klt=101)
    except ProviderError as exc:
        return _error(502, "upstream_unavailable", str(exc))

    try:
        # Persist a missing immutable snapshot only after both upstream calls
        # succeed, so a failed refresh leaves no tracking/result artifacts.
        snapshot = _load_or_build_tracking(run_dir, report, persist_missing=True)
        rows = calculate_outcome_observations(
            snapshot,
            target_series.bars,
            benchmark_series.bars,
        )
        calculated_at = datetime.now(CN_TZ).isoformat()
        benchmark_dates = _post_report_dates(snapshot, benchmark_series.bars)
        pending: list[dict[str, Any]] = []
        append_count = 0
        for row in rows:
            if not _is_mature_observation(row, benchmark_dates):
                pending.append(_pending_observation(row))
                continue
            result = {**row, "calculated_at": calculated_at}
            append_count += int(append_outcome_observation(run_dir, result))
    except (OSError, ValueError, TypeError) as exc:
        return _error(500, "outcome_calculation_failed", str(exc))

    try:
        return web.json_response(
            _outcome_payload(
                request,
                selected=(run_dir, report, snapshot),
                pending=pending,
                updated=append_count > 0,
                append_count=append_count,
            )
        )
    except (OSError, ValueError) as exc:
        return _error(500, "tracking_unavailable", str(exc))


def _selection_report_value(
    document: dict[str, Any], name: str, default: Any = None
) -> Any:
    if name in document:
        return document[name]
    parts = name.split("_")
    alias = parts[0] + "".join(part.capitalize() for part in parts[1:])
    return document.get(alias, default)


def _find_selection_report(
    request: web.Request, run_id: str
) -> tuple[Path, dict[str, Any]] | None:
    """Resolve only the requested selection run; never scan other reports."""
    try:
        path = _screening(request)._report_path(run_id)
    except (OSError, ValueError):
        return None
    report = _read_json(path)
    if report is None or _selection_report_value(report, "kind") != "stock_selection":
        return None
    owner_run_id = _selection_report_value(report, "workflow_run_id")
    if owner_run_id != run_id:
        return None
    return path.parent, report


def _selection_tracking_for_refresh(
    run_dir: Path, report: dict[str, Any]
) -> dict[str, Any]:
    """Validate an existing snapshot without writing before upstream fetches."""
    snapshot = build_selection_outcome_tracking_snapshot(report)
    if snapshot is None:
        raise ValueError("不是可验证的选股报告")
    path = run_dir / SELECTION_TRACKING_FILE
    if path.is_file():
        existing = _read_json(path)
        if existing is None:
            raise ValueError("选股验证快照不可读取")
        if existing != snapshot:
            raise ValueError("选股验证快照不可覆盖")
        return existing
    return snapshot


def _selection_pending_rows(
    snapshot: dict[str, Any], observations: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    seen = {
        (row.get("instrument_id"), int(row.get("window")))
        for row in observations
        if row.get("instrument_id") and row.get("window") is not None
    }
    rows: list[dict[str, Any]] = []
    for candidate in snapshot.get("candidates") or []:
        for window in SELECTION_WINDOWS:
            if (candidate.get("instrument_id"), window) in seen:
                continue
            rows.append(
                {
                    "selection_tracking_id": snapshot.get("tracking_id"),
                    "report_id": snapshot.get("report_id"),
                    "workflow_run_id": snapshot.get("workflow_run_id"),
                    "instrument_id": candidate.get("instrument_id"),
                    "rank": candidate.get("rank"),
                    "name": candidate.get("name"),
                    "window": window,
                    "status": "pending",
                    "status_label": "窗口尚未成熟",
                    "data_status": "window_not_mature",
                    "data_status_label": "尚未达到观察窗口",
                    "entry_date": None,
                    "exit_date": None,
                    "target_return_pct": None,
                    "benchmark_return_pct": None,
                    "relative_return_pct": None,
                }
            )
    return rows


def _selection_outcome_payload(
    run_dir: Path,
    report: dict[str, Any],
    snapshot: dict[str, Any],
    *,
    pending: list[dict[str, Any]] | None = None,
    updated: bool = False,
    append_count: int = 0,
) -> dict[str, Any]:
    observations = read_latest_selection_outcome_observations(
        run_dir, snapshot.get("tracking_id")
    )
    summary = aggregate_selection_outcome_observations(snapshot, observations)
    return {
        "runId": _selection_report_value(report, "workflow_run_id"),
        "reportId": _selection_report_value(report, "report_id"),
        "tracking": snapshot,
        "observations": observations,
        "pending": pending if pending is not None else _selection_pending_rows(snapshot, observations),
        "summary": summary,
        "calculation": snapshot.get("calculation") or {},
        "publicMarketBenchmark": dict(PUBLIC_MARKET_BENCHMARK),
        "updated": updated,
        "appendCount": append_count,
    }


async def handle_stock_screen_outcomes(request: web.Request) -> web.Response:
    """Read one selection run's local validation; never fetch market data."""
    run_id = request.query.get("runId", "").strip()
    if not re.fullmatch(r"^[a-z0-9_-]{1,96}$", run_id):
        return _error(400, "invalid_params", "选股运行编号格式不正确")
    found = _find_selection_report(request, run_id)
    if found is None:
        return _error(404, "report_not_found", "选股报告不存在")
    run_dir, report = found
    try:
        # GET is deliberately read-only.  When the explicit refresh has not
        # created the immutable snapshot yet, build it in memory only.
        snapshot = _selection_tracking_for_refresh(run_dir, report)
        return web.json_response(_selection_outcome_payload(run_dir, report, snapshot))
    except (OSError, ValueError) as exc:
        return _error(500, "tracking_unavailable", str(exc))


async def handle_stock_screen_outcomes_refresh(request: web.Request) -> web.Response:
    """Explicitly refresh one selection report's mature 5/20/60-day windows."""
    data = await _json_body(request)
    run_id = str(data.get("runId") or data.get("run_id") or "").strip()
    if not re.fullmatch(r"^[a-z0-9_-]{1,96}$", run_id):
        return _error(400, "invalid_params", "选股运行编号格式不正确")
    found = _find_selection_report(request, run_id)
    if found is None:
        return _error(404, "report_not_found", "选股报告不存在")
    run_dir, report = found
    try:
        snapshot = _selection_tracking_for_refresh(run_dir, report)
        candidates = snapshot.get("candidates") or []
        if not candidates:
            return _error(400, "invalid_report", "选股报告没有候选股票")
    except (OSError, ValueError) as exc:
        return _error(400, "invalid_report", str(exc))

    benchmark = InstrumentRef(exchange="XSHG", symbol="000985", instrument_type="index")
    try:
        benchmark_series = await _provider().kline(benchmark, limit=640, klt=101)
        candidate_bars: dict[str, Any] = {}
        for candidate in candidates:
            instrument_id = str(candidate.get("instrument_id") or "")
            instrument = _parse_instrument_id(instrument_id)
            series = await _provider().kline(instrument, limit=640, klt=101)
            candidate_bars[instrument_id] = series.bars
    except (ProviderError, asyncio.TimeoutError) as exc:
        return _error(502, "upstream_unavailable", f"行情数据暂不可用：{exc}")
    except ValueError as exc:
        return _error(400, "invalid_report", str(exc))

    try:
        # Both benchmark and every candidate series are now available.  Only
        # after that point is the immutable snapshot and result log touched.
        snapshot = ensure_selection_outcome_tracking_snapshot(run_dir, report)
        if snapshot is None:
            raise ValueError("不是可验证的选股报告")
        rows = calculate_selection_outcome_observations(
            snapshot,
            candidate_bars,
            benchmark_series.bars,
        )
        calculated_at = datetime.now(CN_TZ).isoformat()
        pending = [row for row in rows if row.get("status") == "pending"]
        mature = [
            {**row, "calculated_at": calculated_at}
            for row in rows
            if row.get("status") != "pending"
        ]
        append_count = append_selection_outcome_observations(run_dir, mature)
        return web.json_response(
            _selection_outcome_payload(
                run_dir,
                report,
                snapshot,
                pending=pending,
                updated=append_count > 0,
                append_count=append_count,
            )
        )
    except (OSError, ValueError, TypeError) as exc:
        return _error(500, "outcome_calculation_failed", str(exc))


# --- watchlist ---


async def handle_stock_watchlist_list(request: web.Request) -> web.Response:
    try:
        items = _store().list()
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    return _items_payload(items)


async def handle_stock_watchlist_add(request: web.Request) -> web.Response:
    data = await _json_body(request)
    symbol = str(data.get("symbol") or "").strip()
    exchange = str(data.get("exchange") or "").strip().upper()
    if ":" in symbol:
        exchange, _, symbol = symbol.partition(":")
        exchange = exchange.upper()
    elif not exchange:
        try:
            exchange = infer_exchange(symbol)
        except ValueError as exc:
            return _error(400, "invalid_params", str(exc))
    try:
        item = WatchlistItem(
            symbol=symbol,
            exchange=exchange,
            name=str(data.get("name") or ""),
            instrument_type=data.get("instrumentType", "equity"),
            focus=bool(data.get("focus", False)),
        )
    except ValidationError as exc:
        return _error(400, "invalid_params", str(exc))
    try:
        items = _store().add(item)
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    return _items_payload(items)


async def handle_stock_watchlist_remove(request: web.Request) -> web.Response:
    raw = request.query.get("id", "")
    if not _ID_RE.match(raw.strip()):
        return _error(400, "invalid_params", f"malformed instrument id {raw!r}")
    try:
        removed = _store().remove(raw.strip())
        items = _store().list() if removed else []
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    if not removed:
        return _error(404, "unknown_instrument", f"{raw!r} is not in the watchlist")
    return _items_payload(items)


async def handle_stock_watchlist_focus(request: web.Request) -> web.Response:
    """Toggle the focus marker feeding ``review_scope="focus"`` (§11)."""
    data = await _json_body(request)
    raw = str(data.get("id") or "").strip()
    if not _ID_RE.match(raw):
        return _error(400, "invalid_params", f"malformed instrument id {raw!r}")
    if not isinstance(data.get("focus"), bool):
        return _error(400, "invalid_params", "'focus' must be a boolean")
    try:
        updated = _store().set_focus(raw, data["focus"])
        items = _store().list()
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    if not updated:
        return _error(404, "unknown_instrument", f"{raw!r} is not in the watchlist")
    return _items_payload(items)


async def handle_stock_watchlist_reorder(request: web.Request) -> web.Response:
    """Persist a drag-and-drop order: ``ids`` must cover the current list."""
    data = await _json_body(request)
    raw_ids = data.get("ids")
    if not isinstance(raw_ids, list) or not all(isinstance(i, str) for i in raw_ids):
        return _error(400, "invalid_params", "'ids' must be a list of instrument ids")
    ids = [i.strip() for i in raw_ids]
    if any(not _ID_RE.match(i) for i in ids):
        return _error(400, "invalid_params", "malformed instrument id in 'ids'")
    try:
        _store().reorder(ids)
        items = _store().list()
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    return _items_payload(items)


async def handle_stock_watchlist_import(request: web.Request) -> web.Response:
    data = await _json_body(request)
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        return _error(400, "invalid_params", "missing non-empty 'text'")
    try:
        result = _store().import_csv(text)
        items = _store().list()
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    return web.json_response(
        {
            "imported": result.imported,
            "skipped": result.skipped,
            "errors": result.errors,
            "items": [_item_payload(i) for i in items],
        }
    )


# --- search ---


async def handle_stock_search(request: web.Request) -> web.Response:
    keyword = request.query.get("q", "").strip()
    if not keyword:
        return _error(400, "invalid_params", "missing query parameter 'q'")
    try:
        results = await _provider().search(keyword)
    except ProviderError as exc:
        return _error(502, "upstream_unavailable", str(exc))
    return web.json_response({"results": [r.model_dump(by_alias=True) for r in results]})


# --- quote ---


async def handle_stock_quote(request: web.Request) -> web.Response:
    raw = request.query.get("ids", "")
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return _error(400, "invalid_params", "missing query parameter 'ids'")
    if len(parts) > _MAX_QUOTE_IDS:
        return _error(
            400, "invalid_params", f"at most {_MAX_QUOTE_IDS} instruments per request"
        )
    try:
        watchlist = _watchlist_by_id()
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    instruments: list[InstrumentRef] = []
    for part in parts:
        try:
            instruments.append(_resolve_instrument(part, watchlist))
        except ValueError:
            return _error(400, "unknown_instrument", f"unknown instrument id {part!r}")

    results = await _provider().quotes(instruments)
    quotes = []
    for inst in instruments:
        result = results.get(inst.id)
        if isinstance(result, Quote):
            quotes.append(result.model_dump(by_alias=True))
        else:
            message = str(result) if isinstance(result, ProviderError) else "no data"
            quotes.append(
                {
                    "instrumentId": inst.id,
                    "error": {"code": "upstream_unavailable", "message": message},
                }
            )
    return web.json_response({"quotes": quotes})


# --- kline ---


async def handle_stock_kline(request: web.Request) -> web.Response:
    raw = request.query.get("id", "")
    try:
        inst = _resolve_instrument(raw, _watchlist_by_id())
    except ValueError:
        return _error(400, "unknown_instrument", f"unknown instrument id {raw!r}")
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    raw_limit = request.query.get("limit", "120")
    try:
        limit = int(raw_limit)
    except ValueError:
        return _error(400, "invalid_params", f"invalid limit {raw_limit!r}")
    limit = max(1, min(limit, _MAX_KLINE_LIMIT))
    # K-line period: 101 daily / 102 weekly / 103 monthly (default daily).
    raw_klt = request.query.get("klt", "101")
    try:
        klt = int(raw_klt)
    except ValueError:
        return _error(400, "invalid_params", f"invalid klt {raw_klt!r}")
    if klt not in (101, 102, 103):
        return _error(400, "invalid_params", f"unsupported klt {raw_klt!r}")
    try:
        series = await _provider().kline(inst, limit=limit, klt=klt)
    except ProviderError as exc:
        return _error(502, "upstream_unavailable", str(exc))

    bars = series.bars
    closes = [b.close for b in bars]
    dif, dea, hist = macd(closes)
    indicators = {
        "ma": {
            "ma5": sma(closes, 5),
            "ma20": sma(closes, 20),
            "ma60": sma(closes, 60),
        },
        "macd": {"dif": dif, "dea": dea, "hist": hist},
        "rsi14": rsi(closes, 14),
        "swing": swing_high_low([b.high for b in bars], [b.low for b in bars]),
        "volumeChangePct": volume_change_pct([b.volume for b in bars]),
    }
    return web.json_response(
        {
            "instrumentId": series.instrument_id,
            "instrumentType": series.instrument_type,
            "bars": [b.model_dump(by_alias=True) for b in bars],
            "indicators": indicators,
            "source": series.source.model_dump(by_alias=True),
        }
    )


# --- intraday ---


def _intraday_payload(series: IntradaySeries) -> dict:
    return series.model_dump(by_alias=True)


def _sse_frame(event: str, payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


async def handle_stock_intraday(request: web.Request) -> web.Response:
    raw = request.query.get("id", "")
    try:
        inst = _resolve_instrument(raw, _watchlist_by_id())
    except ValueError:
        return _error(400, "unknown_instrument", f"unknown instrument id {raw!r}")
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))
    try:
        series = await _intraday_service().get(inst)
    except ProviderError as exc:
        return _error(502, "upstream_unavailable", str(exc))
    return web.json_response(_intraday_payload(series))


async def handle_stock_intraday_stream(request: web.Request) -> web.StreamResponse:
    raw = request.query.get("id", "")
    try:
        inst = _resolve_instrument(raw, _watchlist_by_id())
    except ValueError:
        return _error(400, "unknown_instrument", f"unknown instrument id {raw!r}")
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))

    service = _intraday_service()
    initial: IntradaySeries | None = None
    initial_error: str | None = None
    try:
        initial = await service.get(inst)
    except ProviderError as exc:
        initial_error = str(exc)
    queue = await service.subscribe(inst)
    response = web.StreamResponse(
        headers={
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
    prepared = False
    try:
        await response.prepare(request)
        prepared = True
        if initial is not None:
            await response.write(_sse_frame("snapshot", _intraday_payload(initial)))
        else:
            await response.write(
                _sse_frame(
                    "status",
                    {
                        "instrumentId": inst.id,
                        "status": "unavailable",
                        "stale": True,
                        "quality": "unavailable",
                        "error": initial_error or "行情暂不可用",
                    },
                )
            )
        while True:
            try:
                event, series = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                await response.write(b": heartbeat\n\n")
                continue
            # Stage 2 fixes one simple protocol: every actual state/data
            # change is a complete snapshot.  A reconnect gets the same
            # complete snapshot through the first event.
            await response.write(_sse_frame(event, _intraday_payload(series)))
    except asyncio.CancelledError:
        raise
    except (ConnectionResetError, BrokenPipeError, RuntimeError):
        # Browser/EventSource disconnects must reach the unsubscribe cleanup.
        pass
    finally:
        await service.unsubscribe(inst, queue)
        if prepared:
            try:
                await response.write_eof()
            except (ConnectionResetError, BrokenPipeError, RuntimeError):
                pass
    return response


# --- research context ---


def _section_error() -> dict:
    return {
        "status": "unavailable",
        "data": None,
        "error": {
            "code": "upstream_unavailable",
            "message": "数据源暂不可用",
        },
    }


def _fundamentals_payload(value: Fundamentals) -> dict:
    return value.model_dump(by_alias=True)


def _news_payload(value: NewsItem) -> dict:
    return value.model_dump(by_alias=True)


async def handle_stock_research_context(request: web.Request) -> web.Response:
    """Current fundamentals and news for the selected workbench instrument.

    This is a read-only data capability, deliberately separate from the
    evidence bundle and report workflow. A partial upstream outage therefore
    degrades one section while the rest of the workbench remains usable.
    """
    raw = request.query.get("id", "")
    try:
        inst = _resolve_instrument(raw, _watchlist_by_id())
    except ValueError:
        return _error(400, "unknown_instrument", f"unknown instrument id {raw!r}")
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))

    raw_limit = request.query.get("newsLimit", str(_DEFAULT_NEWS_LIMIT))
    try:
        news_limit = int(raw_limit)
    except ValueError:
        return _error(400, "invalid_params", f"invalid newsLimit {raw_limit!r}")
    news_limit = max(1, min(news_limit, _MAX_NEWS_LIMIT))

    if inst.instrument_type == "etf":
        fundamentals: dict = {"status": "not_applicable", "data": None, "error": None}
        (news_result,) = await asyncio.gather(
            _provider().news(inst, limit=news_limit), return_exceptions=True
        )
    else:
        fundamentals_result, news_result = await asyncio.gather(
            _provider().fundamentals(inst),
            _provider().news(inst, limit=news_limit),
            return_exceptions=True,
        )
        if isinstance(fundamentals_result, ProviderError):
            fundamentals = _section_error()
        elif isinstance(fundamentals_result, Exception):
            raise fundamentals_result
        else:
            fundamentals = {
                "status": "available",
                "data": _fundamentals_payload(fundamentals_result),
                "error": None,
            }

    if isinstance(news_result, ProviderError):
        news = {**_section_error(), "items": []}
    elif isinstance(news_result, Exception):
        raise news_result
    else:
        news = {
            "status": "available",
            "items": [_news_payload(item) for item in news_result],
            "error": None,
        }

    return web.json_response(
        {
            "instrumentId": inst.id,
            "instrumentType": inst.instrument_type,
            "fundamentals": fundamentals,
            "news": news,
        }
    )


def _material_store(request: web.Request) -> MaterialBindingStore:
    return MaterialBindingStore(_preflight_workspace(request))


def _material_error(exc: MaterialBindingError) -> web.Response:
    return _error(400, exc.code, exc.message)


def _material_row_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "materialId": row.get("material_id"),
        "materialName": row.get("material_name"),
        "extractionStatus": row.get("extraction_status_label"),
        "extractionStatusCode": row.get("extraction_status"),
        "pageCount": row.get("page_count"),
        "bindings": [
            {
                "bindingId": binding.get("binding_id"),
                "status": binding.get("status_label"),
                "statusCode": binding.get("status"),
                "reportPeriod": binding.get("report_period"),
                "firstPublishedAt": binding.get("first_published_at"),
                "publisher": binding.get("publisher"),
                "pages": binding.get("pages"),
                "confirmedFacts": [
                    confirmed_fact_user_payload(fact)
                    for fact in binding.get("confirmed_facts") or []
                ],
                "confirmedAt": binding.get("confirmed_at"),
                "invalidationReason": binding.get("invalidation_reason"),
            }
            for binding in row.get("bindings") or []
        ],
    }


def _binding_payload(binding: Any) -> dict[str, Any]:
    """Expose readable labels; storage enums stay behind this API boundary."""
    return {
        "bindingId": binding.binding_id,
        "materialId": binding.material_id,
        "instrumentId": binding.instrument_id,
        "reportType": "财报",
        "reportPeriod": binding.report_period,
        "firstPublishedAt": binding.first_published_at,
        "publisher": binding.publisher,
        "pages": binding.pages,
        "confirmedFacts": [
            confirmed_fact_user_payload(fact)
            for fact in binding.confirmed_facts
        ],
        "userConfirmed": binding.user_confirmed,
        "confirmedAt": binding.confirmed_at,
        "status": {
            "pending": "待用户确认",
            "confirmed": "已确认",
            "invalidated": "已失效",
        }[binding.status],
        "statusCode": binding.status,
        "invalidationReason": binding.invalidation_reason,
    }


async def handle_stock_materials(request: web.Request) -> web.Response:
    """List real PDF materials and existing binding states for one stock."""
    raw = request.query.get("instrumentId", "")
    if not raw.strip():
        return _error(400, "invalid_params", "缺少股票代码")
    try:
        instrument = _resolve_instrument(raw, _watchlist_by_id())
        materials = _material_store(request).list_available(instrument.id)
    except (ValueError, WatchlistCorruptError):
        return _error(400, "invalid_params", "股票代码无效")
    except MaterialBindingError as exc:
        return _material_error(exc)
    return web.json_response(
        {
            "instrumentId": instrument.id,
            "materials": [_material_row_payload(row) for row in materials],
        }
    )


async def handle_stock_material_preview(request: web.Request) -> web.Response:
    """Return one extracted PDF page for user review before confirmation."""
    material_id = request.query.get("materialId", "")
    raw_page = request.query.get("page", "")
    if not material_id.strip():
        return _error(400, "invalid_params", "缺少资料编号")
    if not raw_page.strip() or not raw_page.isascii() or not raw_page.isdigit():
        return _error(400, "invalid_params", "页码必须是正整数")
    page = int(raw_page)
    if page <= 0:
        return _error(400, "invalid_params", "页码必须是正整数")
    try:
        store = _material_store(request)
        source = store._load_source(material_id)
        selected = store._validate_pages(source, [page])
    except MaterialBindingError as exc:
        return _material_error(exc)
    return web.json_response(
        {
            "materialName": source["raw_path"].name,
            "page": page,
            "text": selected[page],
        }
    )


async def handle_stock_material_bind(request: web.Request) -> web.Response:
    """Create a pending user-confirmable PDF binding."""
    data = await _json_body(request)
    raw_instrument = data.get("instrumentId") or data.get("instrument_id")
    try:
        if not isinstance(raw_instrument, str) or not raw_instrument.strip():
            raise MaterialBindingError("invalid_params", "缺少股票代码")
        instrument = _resolve_instrument(raw_instrument, _watchlist_by_id())
    except MaterialBindingError as exc:
        return _material_error(exc)
    except (ValueError, WatchlistCorruptError):
        return _error(400, "invalid_params", "股票代码格式无效")
    try:
        material_id = data.get("materialId") or data.get("material_id")
        report_period = data.get("reportPeriod") or data.get("report_period")
        first_published_at = data.get("firstPublishedAt") or data.get("first_published_at")
        publisher = data.get("publisher")
        pages = data.get("pages")
        if pages is None:
            pages = data.get("pageNumbers")
        binding = _material_store(request).create_pending(
            material_id=material_id,
            instrument_id=instrument.id,
            report_period=report_period,
            first_published_at=first_published_at,
            publisher=publisher,
            pages=pages,
        )
    except MaterialBindingError as exc:
        return _material_error(exc)
    except (ValueError, TypeError):
        return _error(400, "invalid_params", "绑定参数无效")
    return web.json_response(
        {
            "binding": _binding_payload(binding),
            "statusLabel": "待用户确认",
        },
        status=201,
    )


async def handle_stock_material_confirm(request: web.Request) -> web.Response:
    """Explicitly confirm a pending PDF binding."""
    data = await _json_body(request)
    binding_id = data.get("bindingId") or data.get("binding_id")
    confirmed_facts = data.get("confirmedFacts")
    if confirmed_facts is None and "confirmed_facts" in data:
        confirmed_facts = data.get("confirmed_facts")
    try:
        binding = _material_store(request).confirm(
            binding_id,
            confirmed_facts=confirmed_facts,
        )
    except MaterialBindingError as exc:
        return _material_error(exc)
    except (ValueError, TypeError):
        return _error(400, "invalid_params", "绑定参数无效")
    return web.json_response(
        {
            "binding": _binding_payload(binding),
            "statusLabel": "已确认",
        }
    )


# --- six-agent preflight -------------------------------------------------


def _preflight_workspace(request: web.Request) -> Path:
    workspace = request.app.get("workspace")
    return Path(workspace) if workspace else Path.home() / ".mona" / "workspace"


def _preflight_core_research_gap(bundle: dict[str, Any]) -> list[str]:
    """Return only hard core gaps that make a basic research run impossible.

    Industry, policy, sentiment and opinion coverage are valuable enhancements
    but are not prerequisites for a short-term research answer.  The check is
    performed before the user confirms the six-agent workflow, so a failed
    preflight cannot spend agent tokens.
    """
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, dict):
        return ["决策数据准备结果"]
    core = readiness.get("core")
    if isinstance(core, dict) and core.get("status") in {"failed", "insufficient_data"}:
        missing = core.get("missing") or []
        labels = {
            "quote": "实时行情（价格）",
            "kline": "至少60根历史日线",
            "technical_indicators": "技术指标与波动/支撑计算",
        }
        return [labels.get(item, str(item)) for item in missing]

    # Real EvidenceBundle objects always carry these keys, even when their
    # values are null.  Older test/integration seams only expose readiness;
    # preserve those seams when they explicitly report a ready research gate.
    concrete_bundle = any(
        key in bundle for key in ("quote", "kline_ref", "derived_decision_metrics")
    )
    if not concrete_bundle:
        research = readiness.get("research_ready")
        if isinstance(research, dict) and research.get("status") in {"ready", "available"}:
            return []
        if readiness.get("status") in {"ready", "available"}:
            return []
        return ["核心行情、历史日线或技术指标"]

    gaps: list[str] = []
    quote = bundle.get("quote")
    price = quote.get("price") if isinstance(quote, dict) else None
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price <= 0:
        gaps.append("实时行情（价格）")
    kline_ref = bundle.get("kline_ref")
    try:
        bars = int(kline_ref.get("bars") or 0) if isinstance(kline_ref, dict) else 0
    except (TypeError, ValueError):
        bars = 0
    if bars < 60:
        gaps.append("至少60根历史日线")
    derived = bundle.get("derived_decision_metrics")
    required_technical = ("atr20", "trend", "volatility", "swing", "stop_distance")
    if not isinstance(derived, dict) or any(
        not isinstance(derived.get(name), dict) for name in required_technical
    ):
        gaps.append("技术指标与波动/支撑计算")
    return gaps


def _preflight_payload(context_id: str, bundle: dict[str, Any]) -> dict[str, Any]:
    coverage = bundle.get("evidence_coverage")
    if not isinstance(coverage, dict):
        coverage = {
            "short_term": {"status": "insufficient_data", "missing_sections": ["evidence_coverage"], "degraded_sections": []},
            "medium_term": {"status": "insufficient_data", "missing_sections": ["evidence_coverage"], "degraded_sections": []},
            "long_term": {"status": "insufficient_data", "missing_sections": ["evidence_coverage"], "degraded_sections": []},
        }
    instrument = bundle.get("instrument")
    instrument_payload = dict(instrument) if isinstance(instrument, dict) else {}
    if "instrument_type" in instrument_payload:
        instrument_payload["instrumentType"] = instrument_payload.pop("instrument_type")
    readiness = bundle.get("decision_readiness")
    if not isinstance(readiness, dict):
        raise ValueError("决策数据预检缺少准备结果")
    horizons = readiness.get("horizons")
    if not isinstance(horizons, dict):
        raise ValueError("决策数据预检缺少三周期准备结果")

    core_gaps = _preflight_core_research_gap(bundle)
    if core_gaps:
        raise ValueError(
            "核心研究数据未准备完成，未启动投研：" + "、".join(core_gaps)
        )

    research_gate = readiness.get("research_ready")
    trade_gate = readiness.get("trade_ready")
    research_horizons = research_gate.get("horizons") if isinstance(research_gate, dict) else None
    if not isinstance(research_horizons, dict):
        research_horizons = {}
    if research_horizons:
        research_statuses = [
            (research_horizons.get(name) or {}).get("status")
            for name in ("short_term", "medium_term", "long_term")
        ]
        research_ready = any(status in {"ready", "available"} for status in research_statuses)
    elif isinstance(research_gate, dict):
        research_ready = research_gate.get("status") in {"ready", "available"}
    else:
        research_ready = any(
            isinstance(horizons.get(name), dict)
            and horizons[name].get("status") in {"ready", "available"}
            for name in ("short_term", "medium_term", "long_term")
        )
        if not research_ready:
            research_ready = readiness.get("status") in {"ready", "available"}
    # The hard preflight above is the permission boundary.  A valid short-term
    # core is enough to launch research even when optional industry/policy/
    # sentiment sections are unavailable; those sections remain visible as
    # degraded coverage in the response.
    if not research_ready:
        research_ready = not core_gaps
    if not research_ready:
        raise ValueError("核心研究数据未准备完成，未启动投研")

    def public_horizon(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {"status": "failed", "required": [], "available": [], "missing": []}
        return {
            "status": value.get("status"),
            "required": value.get("required") or [],
            "available": value.get("available") or [],
            "missing": value.get("missing") or [],
        }

    public_readiness = {
        "status": readiness.get("status"),
        "horizons": {
            name: public_horizon(horizons.get(name))
            for name in ("short_term", "medium_term", "long_term")
        },
    }
    if isinstance(research_gate, dict):
        public_readiness["researchReady"] = {
            "status": research_gate.get("status"),
            "horizons": {
                name: public_horizon(research_horizons.get(name))
                for name in ("short_term", "medium_term", "long_term")
            },
        }
    if isinstance(trade_gate, dict):
        trade_horizons = trade_gate.get("horizons")
        public_readiness["tradeReady"] = {
            "status": trade_gate.get("status"),
            "horizons": {
                name: public_horizon(
                    trade_horizons.get(name) if isinstance(trade_horizons, dict) else None
                )
                for name in ("short_term", "medium_term", "long_term")
            },
        }
    return {
        "contextId": context_id,
        "instrument": instrument_payload,
        "researchCutoffAt": bundle.get("research_cutoff_at"),
        "marketAsOf": bundle.get("market_as_of"),
        "decisionReadiness": public_readiness,
        "evidenceCoverage": {
            key: coverage.get(key, {"status": "insufficient_data", "missing_sections": [], "degraded_sections": []})
            for key in ("short_term", "medium_term", "long_term")
        },
        "dataQuality": bundle.get("data_quality") or {},
    }


async def handle_stock_research_preflight(request: web.Request) -> web.Response:
    """Build an immutable evidence context before a six-agent run is allowed.

    This endpoint intentionally creates no workflow run.  The returned context
    id is carried by the explicit second confirmation into ``runWorkflow``;
    ``run_init`` then promotes the exact bundle without fetching again.
    """
    data = await _json_body(request)
    raw = data.get("instrumentId") or data.get("instrument_id") or data.get("symbol")
    if not isinstance(raw, str) or not raw.strip():
        return _error(400, "invalid_params", "missing instrumentId")
    try:
        watchlist = _watchlist_by_id()
        inst = _resolve_instrument(raw, watchlist)
    except ValueError:
        return _error(400, "unknown_instrument", f"unknown instrument id {raw!r}")
    except WatchlistCorruptError as exc:
        return _error(500, "watchlist_corrupt", str(exc))

    saved = watchlist.get(inst.id)
    name = str(data.get("name") or (saved.name if saved else ""))
    context_id = f"ctx_{uuid.uuid4().hex}"
    service = EvidenceService(
        workspace=_preflight_workspace(request),
        provider=_provider(),
        research_provider=GovernmentResearchProvider(),
        cache_root=Path.home() / ".mona" / "stock" / "cache",
    )
    try:
        context = await service.build_context(
            context_id,
            inst,
            name=name,
            # The context is deliberately unbound until the user confirms and
            # WorkflowRunner has allocated its durable run id.
            owner={"kind": "stock_preflight"},
        )
        bundle = (context.get("symbols") or {}).get(inst.id)
        if not isinstance(bundle, dict):
            raise ValueError(f"preflight context {context_id!r} has no instrument evidence")
    except Exception as exc:
        return _error(502, "preflight_failed", f"数据预检失败：{exc}")
    try:
        payload = _preflight_payload(context_id, bundle)
    except ValueError as exc:
        return _error(502, "preflight_failed", f"数据预检失败：{exc}")
    return web.json_response(payload)


# --- opportunity discovery / deterministic screening ---


async def handle_stock_screen_templates(request: web.Request) -> web.Response:
    return web.json_response({"templates": _screening(request).templates()})


async def handle_stock_screen_strategies(request: web.Request) -> web.Response:
    service = _screening(request)
    if request.method == "GET":
        return web.json_response(
            {"strategies": [item.model_dump(by_alias=True) for item in service.strategies()]}
        )
    data = await _json_body(request)
    if isinstance(data.get("strategy"), dict):
        data = data["strategy"]
    try:
        strategy = service.save_strategy(data)
    except (ScreeningValidationError, ValueError) as exc:
        return _error(400, "invalid_strategy", str(exc))
    return web.json_response(strategy.model_dump(by_alias=True), status=201)


async def handle_stock_screen_strategy_delete(request: web.Request) -> web.Response:
    strategy_id = request.query.get("id", "").strip()
    if not re.fullmatch(r"^[a-z][a-z0-9_-]{1,63}$", strategy_id):
        return _error(400, "invalid_params", "malformed strategy id")
    if not _screening(request).delete_strategy(strategy_id):
        return _error(404, "unknown_strategy", f"strategy {strategy_id!r} not found or builtin")
    return web.json_response({"deleted": True, "strategyId": strategy_id})


async def handle_stock_screen_results(request: web.Request) -> web.Response:
    run_id = request.query.get("runId", "").strip()
    if not run_id:
        return _error(400, "invalid_params", "missing query parameter 'runId'")
    service = _screening(request)
    report = service.read_report(run_id)
    if report is None:
        return _error(404, "unknown_run", f"selection report {run_id!r} not found")
    # Keep the deterministic selection payload unchanged and expose the AI
    # research artifact as an optional sibling field.  Older runs therefore
    # remain readable without a migration or a fake report.
    result = dict(report)
    result["opportunity_research"] = service.read_opportunity_report(run_id)
    return web.json_response(result)


async def handle_stock_screen_opportunity_source(request: web.Request) -> web.Response:
    """Return a cited source record after run/context/candidate checks."""
    run_id = request.query.get("runId", "").strip()
    context_id = request.query.get("contextId", "").strip()
    source_id = request.query.get("sourceId", "").strip()
    if not run_id or not context_id or not source_id:
        return _error(
            400,
            "invalid_params",
            "runId, contextId and sourceId are required",
        )
    try:
        source = _screening(request).read_opportunity_source(
            run_id, context_id, source_id
        )
    except ScreeningValidationError as exc:
        return _error(400, "invalid_params", str(exc))
    except KeyError:
        return _error(
            404,
            "opportunity_source_not_found",
            "opportunity source not found or not owned by this run",
        )
    return web.json_response(source)


async def handle_stock_screen_history(request: web.Request) -> web.Response:
    raw_limit = request.query.get("limit", "50")
    try:
        limit = max(1, min(int(raw_limit), 200))
    except ValueError:
        return _error(400, "invalid_params", "invalid limit")
    return web.json_response({"items": _screening(request).history(limit)})


async def handle_stock_screen_compare(request: web.Request) -> web.Response:
    data = await _json_body(request)
    run_id = str(data.get("runId") or data.get("run_id") or "").strip()
    ids = data.get("instrumentIds") or data.get("instrument_ids")
    if not run_id or not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
        return _error(400, "invalid_params", "runId and instrumentIds are required")
    try:
        result = _screening(request).compare(run_id, [item.strip() for item in ids])
    except KeyError as exc:
        return _error(404, "unknown_run", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_params", str(exc))
    return web.json_response(result)
