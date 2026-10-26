"""Authenticated Services routes. No arbitrary native proxy or legacy fallback."""

from __future__ import annotations

import asyncio
import base64
import binascii
import re
import secrets
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from zoneinfo import ZoneInfo

import httpx
from aiohttp import web
from loguru import logger
from pydantic import ValidationError

from mona.services.stock_vibe.client import NativeProtocolError, StockVibeClient, object_id
from mona.services.stock_vibe.contracts import (
    OPERATION_INPUT,
    AlphaListQuery,
    AttentionPreferences,
    CreateSchedule,
    CreateSession,
    EmptyQuery,
    EventTicket,
    MarketQuery,
    ModelSelection,
    NativeResearchCatalogQuery,
    OpportunityListQuery,
    ReportPositionsQuery,
    ReportRunQuery,
    ReportRunsQuery,
    SendMessage,
    StartSwarm,
    StockVibeDataSettingsUpdate,
    StrategyLibraryHistoryQuery,
    StrategyLibraryQuery,
    SymbolSearchQuery,
    UpdateSchedule,
    Upload,
    WorkbenchContext,
    WorkbenchHistoryQuery,
    WorkbenchMarketQuery,
    WorkbenchQuery,
)
from mona.services.stock_vibe.paper import register_paper_routes
from mona.services.stock_vibe.requests import RequestConflictError, RequestStore
from mona.services.stock_vibe.runtime import StockVibeRuntime, StockVibeUnavailableError
from mona.services.stock_vibe.settings import (
    attention_preferences,
    data_settings,
    model_options,
    model_selection,
    save_attention_preferences,
    save_data_settings,
    save_model_binding,
    save_model_selection,
)

_PREFIX = "/api/stock-vibe"
_CLIENT = web.AppKey("stock_vibe_client", StockVibeClient)
_TICKETS = web.AppKey("stock_vibe_event_tickets", dict)
_MODEL_WRITER = web.AppKey("stock_vibe_model_writer", object)
_MODEL_BINDING_WRITER = web.AppKey("stock_vibe_model_binding_writer", object)
_ATTENTION_WRITER = web.AppKey("stock_vibe_attention_writer", object)
_DATA_SETTINGS_WRITER = web.AppKey("stock_vibe_data_settings_writer", object)
_SUBMISSION_LOCK = web.AppKey("stock_vibe_submission_lock", asyncio.Lock)
_ALPHA_ID = re.compile(r"^[a-z][a-z0-9]+_[a-z0-9_]{1,64}$")
_NATIVE_STRATEGY_ID = re.compile(r"^(?:alpha_zoo|sdm):[A-Za-z0-9_.-]{1,128}$")
_LIBRARY_STRATEGY_ID = re.compile(r"^(?:builtin|sdm):[A-Za-z0-9_.-]{1,128}$")


def _id(request: web.Request) -> str:
    return object_id(request.match_info["object_id"])


async def _submit(request: web.Request, *args, **kwargs):
    async with request.app[_SUBMISSION_LOCK]:
        client = request.app[_CLIENT]
        return await client.submit(*args, **kwargs)


def _submission_response(result: dict) -> web.Response:
    result["request_url"] = f"{_PREFIX}/requests/{result['request_id']}"
    if result.get("error_category") == "not_dispatched":
        return web.json_response({**result, "error": "native_unavailable", "message": "股票服务未能接收此操作，尚未派发任务"}, status=503)
    return web.json_response(result, status=202 if result["status"] == "unknown" else 200)


@web.middleware
async def stock_vibe_errors(request: web.Request, handler):
    if request.path != _PREFIX and not request.path.startswith(_PREFIX + "/"):
        return await handler(request)
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except RequestConflictError:
        return web.json_response({"error": "request_conflict", "message": "此提交标识已用于另一项操作"}, status=409)
    except (ValidationError, ValueError):
        return web.json_response({"error": "invalid_input", "message": "请检查输入内容"}, status=400)
    except KeyError:
        return web.json_response({"error": "not_found", "message": "未找到这项记录"}, status=404)
    except NativeProtocolError as exc:
        logger.warning("Stock Vibe native request failed: route={} status={}", request.match_info.route.name, exc.status_code)
        if request.match_info.route.name == "sv_strategy_library_industries" and exc.status_code in {502, 503}:
            return web.json_response({"error": "industry_unavailable", "message": "行业目录暂时无法读取，请稍后重试，或先使用自选范围。"}, status=502)
        if exc.status_code == 404:
            return web.json_response({"error": "not_found", "message": "未找到这项原生记录"}, status=404)
        return web.json_response({"error": "native_unavailable", "message": "股票服务暂不可用，请查看功能资源和模型设置"}, status=503)
    except (StockVibeUnavailableError, httpx.HTTPError) as exc:
        logger.warning("Stock Vibe service request failed: route={} error={}", request.match_info.route.name, type(exc).__name__)
        return web.json_response({"error": "native_unavailable", "message": "股票服务暂不可用，请查看功能资源和模型设置"}, status=503)


async def _body(request: web.Request, model, *, max_bytes: int = 512 * 1024) -> dict:
    if request.content_length and request.content_length > max_bytes:
        raise web.HTTPRequestEntityTooLarge(max_size=max_bytes, actual_size=request.content_length)
    return model.model_validate(await request.json()).model_dump(mode="json")


def _workbench_query(request: web.Request, model) -> dict:
    if len(request.query) != len(set(request.query)):
        raise ValueError("duplicate query parameter")
    return model.model_validate(dict(request.query)).model_dump()


def _opportunity_list_query(request: web.Request) -> dict:
    if len(request.query) != len(set(request.query)) or set(request.query) - {"limit", "offset"}:
        raise ValueError("unexpected opportunity list query")
    return OpportunityListQuery.model_validate(dict(request.query)).model_dump()


def _native_query(request: web.Request, model) -> dict | None:
    if len(request.query) != len(set(request.query)):
        raise ValueError("duplicate query parameter")
    result = model.model_validate(dict(request.query)).model_dump(mode="json", exclude_none=True)
    return result or None


async def _status(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    config = client.runtime.config_loader()
    return web.json_response({"execution_allowed": True,
                              "model_preset": config.stock_vibe.model_preset,
                              "model_binding": model_selection(config).get("model_binding"),
                              "tushare_token_configured": client.runtime.has_tushare_token(config),
                              "running": client.runtime.running,
                              "diagnostic": client.runtime.last_error})


async def _read(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    route = request.match_info.route.name
    value = None
    if "object_id" in request.match_info:
        if route in {"sv_native_research_strategy", "sv_strategy_library_strategy"}:
            value = request.match_info["object_id"]
            pattern = _LIBRARY_STRATEGY_ID if route == "sv_strategy_library_strategy" else _NATIVE_STRATEGY_ID
            if not pattern.fullmatch(value):
                raise ValueError("invalid native strategy id")
        else:
            value = _id(request)
        if route == "sv_alpha" and not _ALPHA_ID.fullmatch(value):
            raise ValueError("invalid alpha id")
    if route == "sv_native_research_evidence" and not re.fullmatch(r"[a-f0-9]{64}", request.match_info["artifact_id"]):
        raise ValueError("invalid native research evidence identity")
    routes = {
        "sv_sessions": ("/sessions", None),
        "sv_session": (f"/sessions/{value}", "session"),
        "sv_messages": (f"/sessions/{value}/messages", "session"),
        "sv_presets": ("/swarm/presets", None),
        "sv_swarms": ("/swarm/runs", None),
        "sv_swarm": (f"/swarm/runs/{value}", "swarm"),
        "sv_swarm_artifacts": (f"/mona/swarm-runs/{value}/artifacts", "swarm"),
        "sv_runs": ("/mona/backtest-inputs", None),
        "sv_run": (f"/runs/{value}", "backtest"),
        "sv_run_preview": (f"/runs/{value}/preview", "backtest"),
        "sv_portfolio": ("/api/portfolio", None),
        "sv_portfolio_status": ("/api/portfolio/refresh-status", None),
        "sv_operations": ("/mona/operations", None),
        "sv_operation": (f"/mona/operations/{value}", "operation"),
        "sv_shadows": ("/mona/shadow-profiles", None),
        "sv_shadow": (f"/mona/shadow-profiles/{value}", "shadow"),
        "sv_scenarios": ("/mona/scenarios", None),
        "sv_scenario": (f"/mona/scenarios/{value}", "scenario"),
        "sv_firings": ("/mona/scheduled-firings", None),
        "sv_attention_events": ("/mona/attention/events", None),
        "sv_opportunity_plans": ("/mona/opportunity-plans", None),
        "sv_opportunity_history": ("/mona/opportunity-history", None),
        "sv_opportunity_records": ("/mona/opportunity-records", None),
        "sv_backtest_settings_defaults": ("/mona/backtest-settings/defaults", None),
        "sv_backtest_settings_inputs": ("/mona/backtest-settings/inputs", None),
        "sv_native_research_catalog": ("/mona/native-research/catalog", None),
        "sv_strategy_library": ("/mona/strategy-library", None),
        "sv_strategy_library_history": ("/mona/strategy-library/history", None),
        "sv_strategy_library_industries": ("/mona/strategy-library/industries", None),
        "sv_strategy_library_strategy": (f"/mona/strategy-library/{value}", None),
        "sv_native_research_run": (f"/mona/native-research/{value}", "swarm"),
        "sv_native_research_strategy": (f"/mona/native-research/strategies/{value}", None),
        "sv_native_research_evidence": (f"/mona/native-research/{value}/evidence/{request.match_info.get('artifact_id', '')}", None),
        "sv_alpha_list": ("/alpha/list", None),
        "sv_alpha_defaults": ("/mona/alpha-defaults", None),
        "sv_alpha_readiness": ("/alpha/readiness", None),
        "sv_alpha": (f"/alpha/{value}", None),
        "sv_report_runs": ("/runs", None),
        "sv_report_run": (f"/runs/{value}", None),
        "sv_report_preview": (f"/runs/{value}/preview", None),
        "sv_report_code": (f"/runs/{value}/code", None),
        "sv_report_pine": (f"/runs/{value}/pine", None),
        "sv_report_factor": (f"/runs/{value}/factor", None),
        "sv_report_attribution": (f"/runs/{value}/attribution", None),
        "sv_report_positions_sectors": (f"/runs/{value}/positions/sectors", None),
    }
    path, kind = routes[route]
    # Query input is deliberately limited; it cannot select files or provider URLs.
    params = None
    if route in {"sv_sessions", "sv_swarms", "sv_runs"}:
        limit = int(request.query.get("limit", "50"))
        if not 1 <= limit <= 100:
            raise ValueError("limit")
        params = {"limit": limit}
        if route == "sv_sessions" and "journal_operation_id" in request.query:
            journal_id = request.query["journal_operation_id"]
            if not re.fullmatch(r"[0-9a-f]{32}", journal_id):
                raise ValueError("invalid journal operation")
            params["journal_operation_id"] = journal_id
    elif route in {"sv_opportunity_history", "sv_opportunity_records"}:
        params = _opportunity_list_query(request)
    elif route == "sv_native_research_catalog":
        params = _native_query(request, NativeResearchCatalogQuery)
    elif route == "sv_strategy_library":
        params = _native_query(request, StrategyLibraryQuery)
    elif route == "sv_strategy_library_history":
        params = _native_query(request, StrategyLibraryHistoryQuery)
    elif route == "sv_alpha_list":
        params = _native_query(request, AlphaListQuery)
    elif route == "sv_report_runs":
        params = _native_query(request, ReportRunsQuery)
    elif route == "sv_report_run":
        params = _native_query(request, ReportRunQuery)
    elif route == "sv_report_positions_sectors":
        params = _native_query(request, ReportPositionsQuery)
    elif route in {
        "sv_native_research_run", "sv_native_research_strategy", "sv_native_research_evidence", "sv_strategy_library_strategy",
        "sv_strategy_library_industries",
        "sv_alpha_readiness", "sv_alpha",
        "sv_alpha_defaults",
        "sv_report_preview", "sv_report_code", "sv_report_pine", "sv_report_factor", "sv_report_attribution",
    }:
        params = _native_query(request, EmptyQuery)
    return web.json_response(await client.read(path, kind=kind, value=value, params=params))


async def _write(request: web.Request) -> web.Response:
    route = request.match_info.route.name
    request_id = request.headers.get("X-Mona-Request-ID", "")
    value = _id(request) if "object_id" in request.match_info else None
    if route == "sv_create_session":
        path, payload = "/sessions", await _body(request, CreateSession)
        context = payload.pop("workbench")
        native_research = payload.pop("native_research")
        journal_id = payload.pop("journal_operation_id")
        strategy_creation = payload.pop("strategy_creation")
        if context is not None:
            payload["config"] = {"mona_workbench": context}
        elif journal_id is not None:
            payload["config"] = {"mona_journal": {"operation_id": journal_id}}
        if native_research is not None:
            payload.setdefault("config", {})["mona_native_research"] = native_research
        if strategy_creation:
            payload.setdefault("config", {})["mona_strategy_creation"] = True
    elif route == "sv_send":
        path, payload = f"/sessions/{value}/messages", await _body(request, SendMessage)
    elif route == "sv_start_swarm":
        payload = await _body(request, StartSwarm)
        path = "/swarm/runs"
    else:
        if request.can_read_body and await request.read() not in {b"", b"{}"}:
            raise ValueError("unexpected payload")
        payload = None
        paths = {"sv_cancel_session": f"/sessions/{value}/cancel",
                 "sv_cancel_swarm": f"/swarm/runs/{value}/cancel",
                 "sv_resume_swarm": f"/swarm/runs/{value}/retry",
                 "sv_refresh_portfolio": "/api/portfolio/refresh"}
        path = paths[route]
    params = {"resume": "true"} if route == "sv_resume_swarm" else None
    result = await _submit(request, request_id, "POST", path, payload, params=params)
    # A completed receipt means acceptance/response, not a completed research job.
    return _submission_response(result)


async def _request(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    record = client.requests.get(request.match_info["request_id"])
    if record is None:
        raise KeyError(request.match_info["request_id"])
    if record["path"] in {"/host/model", "/host/attention", "/host/data-settings"}:
        return web.json_response(_reconcile_model(client, record))
    return web.json_response(await client.request(request.match_info["request_id"]))


def _reconcile_model(client: StockVibeClient, record: dict) -> dict:
    if record["status"] in {"completed", "rejected"}:
        return record
    config = client.runtime.config_loader()
    if record["path"] == "/host/model":
        current = model_selection(config)
    elif record["path"] == "/host/attention":
        current = attention_preferences(config)
    else:
        current = {"tushare_token": config.stock_vibe.tushare_token}
    try:
        client.requests.claim(record["request_id"], "PUT", record["path"], current)
    except RequestConflictError:
        return record
    receipt_body = data_settings(config) if record["path"] == "/host/data-settings" else current
    return client.requests.complete_model_setting(record["request_id"], receipt={"status_code": 200, "body": receipt_body})


async def _model_get(request: web.Request) -> web.Response:
    return web.json_response(model_options(request.app[_CLIENT].runtime.config_loader()))


async def _data_settings_get(request: web.Request) -> web.Response:
    return web.json_response(data_settings(request.app[_CLIENT].runtime.config_loader()))


async def _attention_get(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    return web.json_response({"preferences": attention_preferences(client.runtime.config_loader()),
                              "execution_allowed": True,
                              "runtime": client.runtime.attention_state})


async def _attention_put(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    body = await _body(request, AttentionPreferences)
    record, claimed = client.requests.claim(request.headers.get("X-Mona-Request-ID", ""), "PUT", "/host/attention", body)
    if not claimed:
        return _submission_response(_reconcile_model(client, record))
    async with client.runtime._mutex:
        try:
            request.app[_ATTENTION_WRITER](body)
            if client.runtime.running:
                await client.runtime.sync_attention()
            result = client.requests.complete_model_setting(record["request_id"], receipt={"status_code": 200, "body": body})
        except (OSError, ValueError, httpx.HTTPError, StockVibeUnavailableError):
            result = client.requests.mark_unknown(record["request_id"], "settings_unconfirmed")
    return _submission_response(result)


async def _notifications(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    preferences = client.runtime.config_loader().stock_vibe
    local_time = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%H:%M")
    if (not client.runtime.running or preferences.proactive_mode == "manual"
        or not preferences.watched_symbols or not preferences.notification_start <= local_time <= preferences.notification_end):
        return web.json_response({"notifications": []})
    events = (await client.read("/mona/attention/events"))["native"].get("events", [])
    notifications = []
    for event in events:
        if event.get("delivery_status") != "pending" or event.get("symbol") not in preferences.watched_symbols:
            continue
        event_id = object_id(event["event_id"])
        completed = event.get("kind") == "research_completed"
        title = "股票研究已完成" if completed else "股票条件发生变化"
        body = f"{event['symbol']} · " + ("报告已生成，可打开查看。" if completed else "已记录条件变化，可打开核对事实与原计划。")
        payload = event.get("payload")
        fact = payload.get("condition") if isinstance(payload, dict) else None
        if not completed and isinstance(fact, dict):
            if payload.get("group") == "invalidation":
                title = "股票计划失效条件已发生"
            body = (f"{event['symbol']} · {fact.get('field')}={fact.get('value')}，条件 {fact.get('operator')} {fact.get('threshold')}；"
                    f"{fact.get('observed_at')}，来源 {fact.get('source')}。计划 {str(event.get('artifact_id', ''))[:12]}。"
                    f"{str(payload.get('next_step') or '')[:80]}")
        notifications.append({"id": event_id, "title": title, "body": body, "click_action": "open-stock",
                              "click_data": {key: event.get(key) for key in ("symbol", "artifact_id", "session_id", "attempt_id")}})
    return web.json_response({"notifications": notifications})


async def _notification_write(request: web.Request) -> web.Response:
    action = request.match_info["action"]
    if action not in {"claim", "ack"}:
        raise web.HTTPNotFound()
    if request.can_read_body and await request.read() not in {b"", b"{}"}:
        raise ValueError("unexpected payload")
    result = await _submit(request, request.headers.get("X-Mona-Request-ID", ""), "POST",
                                 f"/mona/attention/events/{_id(request)}/{action}", None)
    return _submission_response(result)


async def _model_put(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    body = await _body(request, ModelSelection)
    record, claimed = client.requests.claim(request.headers.get("X-Mona-Request-ID", ""), "PUT", "/host/model", body)
    if not claimed:
        return _submission_response(_reconcile_model(client, record))
    async with client.runtime._mutex:
        config = client.runtime.config_loader()
        choice = body["model_preset"]
        binding = body.get("model_binding")
        changing = model_selection(config) != body
        supported = (binding["executor"] in config.development.enabled_engines if binding else
                     choice is None or any(item["preset"] == choice and item["protocol_supported"]
                                           for item in model_options(config)["choices"]))
        busy = False
        if supported and changing and client.runtime.running:
            try:
                await client.runtime.sync_attention(execution_allowed=False)
                busy = not await client.runtime._is_idle()
                if busy:
                    await client.runtime.sync_attention()
            except httpx.HTTPError:
                return _submission_response(client.requests.mark_unknown(record["request_id"], "settings_unconfirmed"))
        if not supported:
            result = client.requests.complete_model_setting(record["request_id"], status="rejected",
                receipt={"status_code": 400, "body": {"error": "unsupported_model"}})
        elif busy:
            result = client.requests.complete_model_setting(record["request_id"], status="rejected",
                receipt={"status_code": 409, "body": {"error": "model_busy"}})
        else:
            try:
                if binding:
                    request.app[_MODEL_BINDING_WRITER](binding)
                else:
                    request.app[_MODEL_WRITER](choice)
                if changing and client.runtime.running:
                    await client.runtime._stop()
                result = client.requests.complete_model_setting(record["request_id"], receipt={"status_code": 200, "body": body})
            except (OSError, ValueError):
                result = client.requests.mark_unknown(record["request_id"], "settings_unconfirmed")
    return _submission_response(result)


async def _data_settings_put(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    body = await _body(request, StockVibeDataSettingsUpdate)
    record, claimed = client.requests.claim(
        request.headers.get("X-Mona-Request-ID", ""), "PUT", "/host/data-settings", body
    )
    if not claimed:
        return _submission_response(_reconcile_model(client, record))
    async with client.runtime._mutex:
        try:
            request.app[_DATA_SETTINGS_WRITER](body["tushare_token"])
            result = client.requests.complete_model_setting(
                record["request_id"],
                receipt={"status_code": 200, "body": data_settings(client.runtime.config_loader())},
            )
        except (OSError, ValueError):
            result = client.requests.mark_unknown(record["request_id"], "settings_unconfirmed")
    return _submission_response(result)


async def _attempt(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    session, attempt = _id(request), object_id(request.match_info["attempt_id"])
    return web.json_response(await client.read(f"/mona/sessions/{session}/attempts/{attempt}", kind="attempt", value=attempt))


async def _opportunity_session(request: web.Request) -> web.Response:
    session = _id(request)
    if len(request.query) != len(set(request.query)) or set(request.query) - {"attempt_id"}:
        raise ValueError("unexpected opportunity query")
    params = {"attempt_id": object_id(request.query["attempt_id"])} if "attempt_id" in request.query else None
    result = await request.app[_CLIENT].read(f"/mona/opportunity-sessions/{session}", kind="session", value=session, params=params)
    return web.json_response(result)


async def _opportunity_history_batch(request: web.Request) -> web.Response:
    operation_id = _id(request)
    batch_id = object_id(request.match_info["batch_id"])
    result = await request.app[_CLIENT].read(
        f"/mona/opportunity-history/{operation_id}/batches/{batch_id}",
        kind="operation", value=operation_id,
    )
    return web.json_response(result)


async def _artifact(request: web.Request) -> web.StreamResponse:
    value, kind = _id(request), request.match_info["kind"]
    if kind not in {"shadow-pdf", "shadow-html", "report-pdf", "run-config", "run-code", "run-card", "run-metrics", "run-trades", "run-equity"}:
        raise web.HTTPNotFound()
    return await _stream_artifact(request, f"/mona/artifacts/{kind}/{value}")


async def _swarm_artifact(request: web.Request) -> web.StreamResponse:
    value, artifact = _id(request), object_id(request.match_info["artifact_id"])
    return await _stream_artifact(request, f"/mona/swarm-runs/{value}/artifacts/{artifact}")


async def _stream_artifact(request: web.Request, native_path: str) -> web.StreamResponse:
    client = request.app[_CLIENT]
    async with client.runtime.lease() as native:
        async with native.stream("GET", native_path) as upstream:
            if upstream.status_code != 200:
                raise NativeProtocolError("产物读取失败", status_code=upstream.status_code)
            headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
            for key in ("Content-Type", "Content-Disposition", "Content-Length"):
                if key in upstream.headers:
                    headers[key] = upstream.headers[key]
            response = web.StreamResponse(headers=headers)
            await response.prepare(request)
            try:
                async for chunk in upstream.aiter_bytes():
                    await response.write(chunk)
            except (ConnectionResetError, httpx.HTTPError):
                pass
            return response


async def _market_data(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    params = MarketQuery.model_validate(dict(request.query)).model_dump(mode="json", exclude_none=True)
    try:
        result = await client.read("/mona/market-data", params=params)
    except NativeProtocolError as exc:
        logger.warning("Stock Vibe market read failed: symbol={} interval={} status={}",
                       params["symbol"], params["interval"], exc.status_code)
        if exc.status_code in {400, 422}:
            return web.json_response({"error": "market_query_unsupported",
                                      "message": "当前数据源不支持所选行情，请核对代码或切换周期。"}, status=400)
        return web.json_response({"error": "market_data_unavailable",
                                  "message": "未能取得所选行情，请稍后刷新行情或切换周期。"}, status=502)
    except httpx.TimeoutException:
        logger.warning("Stock Vibe market read timed out: symbol={} interval={}", params["symbol"], params["interval"])
        return web.json_response({"error": "market_data_unavailable",
                                  "message": "未能取得所选行情，请稍后刷新行情或切换周期。"}, status=504)
    result["observed_at"] = datetime.now(timezone.utc).isoformat()
    return web.json_response(result)


async def _workbench(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    params = _workbench_query(request, WorkbenchQuery)
    result = await client.read("/mona/workbench", params=params)
    payload = result["native"]
    if not isinstance(payload, dict) or payload.get("symbol") != params["symbol"]:
        raise NativeProtocolError("工作台响应无效")
    try:
        payload["portfolio"] = (await client.read("/api/portfolio"))["native"]
    except (NativeProtocolError, StockVibeUnavailableError, httpx.HTTPError):
        payload["portfolio"] = None
        payload.setdefault("errors", []).append({"section": "portfolio", "code": "read_failed"})
        logger.warning("Stock Vibe workbench portfolio read failed")
    return web.json_response(result)


async def _workbench_history(request: web.Request) -> web.Response:
    params = _workbench_query(request, WorkbenchHistoryQuery)
    try:
        result = await request.app[_CLIENT].read("/mona/workbench-history", params=params)
        payload = result["native"]
        if (not isinstance(payload, dict) or payload.get("symbol") != params["symbol"]
            or payload.get("offset") != params["offset"] or payload.get("limit") != params["limit"]
            or type(payload.get("total")) is not int or payload["total"] < 0
            or not isinstance(payload.get("items"), list) or len(payload["items"]) > params["limit"]):
            raise NativeProtocolError("分析记录响应无效")
        for row in payload["items"]:
            if (not isinstance(row, dict)
                or not isinstance(row.get("session_id"), str) or object_id(row["session_id"]) != row["session_id"]
                or row.get("attempt_id") is not None and (not isinstance(row["attempt_id"], str) or object_id(row["attempt_id"]) != row["attempt_id"])
                or not isinstance(row.get("title"), str) or not isinstance(row.get("created_at"), str)
                or row.get("completed_at") is not None and not isinstance(row["completed_at"], str)
                or row.get("task") not in {"comprehensive", "fundamental", "technical", "risk"}
                or row.get("mode") not in {"ultrashort", "swing", "medium"}
                or row.get("status") not in {"idle", "pending", "running", "waiting_user", "completed", "failed", "cancelled", "interrupted"}
                or (row.get("attempt_id") is None) != (row.get("status") == "idle")):
                raise NativeProtocolError("分析记录字段无效")
    except (NativeProtocolError, StockVibeUnavailableError, httpx.HTTPError, ValueError):
        logger.warning("Stock Vibe analysis history read failed: symbol={} offset={}", params["symbol"], params["offset"])
        return web.json_response({"error": "analysis_history_unavailable", "message": "暂时无法读取分析记录，请稍后重试。"}, status=502)
    return web.json_response(result, headers={"Cache-Control": "no-store"})


async def _workbench_market(request: web.Request) -> web.Response:
    params = _workbench_query(request, WorkbenchMarketQuery)
    forecast = request.match_info.route.name == "sv_workbench_forecast"
    path = "/mona/workbench-forecast" if forecast else "/mona/workbench-market"
    try:
        result = await request.app[_CLIENT].read(path, params=params)
    except (NativeProtocolError, StockVibeUnavailableError, httpx.HTTPError):
        logger.warning("Stock Vibe workbench market read failed: symbol={} interval={} forecast={}",
                       params["symbol"], params["interval"], forecast)
        return web.json_response({"error": "forecast_unavailable" if forecast else "market_data_unavailable",
                                  "message": "暂未取得走势预测，请稍后重试。" if forecast else "暂未取得行情，请稍后刷新。"}, status=502)
    payload = result["native"]
    if not isinstance(payload, dict) or payload.get("symbol") != params["symbol"] or payload.get("interval") != params["interval"]:
        raise NativeProtocolError("行情响应无效")
    result["observed_at"] = datetime.now(timezone.utc).isoformat()
    return web.json_response(result, headers={"Cache-Control": "no-store"})


async def _symbol_search(request: web.Request) -> web.Response:
    params = _workbench_query(request, SymbolSearchQuery)
    try:
        result = await request.app[_CLIENT].read("/mona/symbol-search", params=params)
        payload = result["native"]
        if (not isinstance(payload, dict) or payload.get("query") != params["q"]
            or not isinstance(payload.get("candidates"), list) or len(payload["candidates"]) > 10
            or any(not isinstance(row, dict)
                   or not isinstance(row.get("symbol"), str)
                   or not re.fullmatch(r"[0-9]{6}\.(SH|SZ|BJ)", row["symbol"])
                   or not isinstance(row.get("name"), str) or not 1 <= len(row["name"]) <= 128
                   for row in payload["candidates"])):
            raise NativeProtocolError("证券搜索响应无效")
    except (NativeProtocolError, StockVibeUnavailableError, httpx.HTTPError):
        logger.warning("Stock Vibe symbol search failed")
        return web.json_response({"error": "symbol_search_unavailable",
                                  "message": "暂未取得搜索结果，请稍后重试，或输入六位股票代码添加。"}, status=502)
    return web.json_response(result)


async def _scheduled_get(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    if request.match_info.route.name == "sv_scheduler_status":
        return web.json_response(await client.read("/scheduled-runs/status"))
    params = _workbench_query(request, WorkbenchQuery)
    result = await client.read("/mona/workbench", params=params)
    payload = result["native"]
    if any(error.get("section") == "scheduled" for error in payload.get("errors", [])):
        raise NativeProtocolError("定时跟进读取失败")
    return web.json_response({"native": payload["scheduled_jobs"], "source": result["source"]})


async def _scheduled_write(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    request_id = request.headers.get("X-Mona-Request-ID", "")
    if request.method == "POST":
        body = await _body(request, CreateSchedule)
        body["config"] = {"mona_workbench": body.pop("workbench")}
        return _submission_response(await _submit(request, request_id, "POST", "/scheduled-runs", body))
    value = _id(request)
    if request.method == "PATCH":
        payload = await _body(request, UpdateSchedule)
        method = "PATCH"
    else:
        if request.can_read_body and await request.read() not in {b"", b"{}"}:
            raise ValueError("unexpected payload")
        payload = None
        method = "DELETE"
    # Reconcile an earlier write before validating a job that it may have changed or removed.
    if client.requests.get(request_id) is None:
        job = (await client.read(f"/scheduled-runs/{value}"))["native"]
        config = job.get("config") if isinstance(job, dict) else None
        context = config.get("mona_workbench") if isinstance(config, dict) else None
        try:
            WorkbenchContext.model_validate(context)
        except ValidationError as exc:
            raise KeyError(value) from exc
    return _submission_response(await _submit(request, request_id, method, f"/scheduled-runs/{value}", payload))


async def _operation(request: web.Request) -> web.Response:
    if request.content_length and request.content_length > 512 * 1024:
        raise web.HTTPRequestEntityTooLarge(max_size=512 * 1024, actual_size=request.content_length)
    payload = OPERATION_INPUT.validate_python(await request.json()).model_dump(mode="json", exclude_none=True)
    result = await _submit(request, request.headers.get("X-Mona-Request-ID", ""), "POST", "/mona/operations", payload)
    return _submission_response(result)


async def _upload(request: web.Request) -> web.Response:
    body = await _body(request, Upload, max_bytes=12 * 1024 * 1024)
    try:
        data = base64.b64decode(body["data_base64"], validate=True)
    except binascii.Error as exc:
        raise ValueError("附件编码无效") from exc
    if not data or len(data) > 8 * 1024 * 1024:
        raise ValueError("附件必须介于1字节与8MB之间")
    result = await _submit(request, request.headers.get("X-Mona-Request-ID", ""), "POST", "/upload",
                                 upload=(body["filename"], data))
    return _submission_response(result)


async def _uploaded_receipts(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    data_root = Path(client.runtime.data_root).resolve()
    upload_root = (data_root / "uploads").resolve()
    uploads = []
    for record in client.requests.list_completed_uploads():
        receipt = record.get("receipt")
        body = receipt.get("body") if isinstance(receipt, dict) else None
        if not isinstance(body, dict):
            continue
        native_path, filename = body.get("file_path"), body.get("filename")
        if not isinstance(native_path, str) or "\\" in native_path:
            continue
        relative = PurePosixPath(native_path)
        parts = relative.parts
        if (relative.is_absolute() or len(parts) != 2 or parts[0] != "uploads"
            or not re.fullmatch(r"[a-f0-9]{32}\.(csv|tsv|xls|xlsx)", parts[1], re.IGNORECASE)):
            continue
        if (not isinstance(filename, str) or not filename or PurePosixPath(filename).name != filename
            or PureWindowsPath(filename).name != filename or any(ord(char) < 32 for char in filename)):
            continue
        upload_id = PurePosixPath(parts[1]).stem.lower()
        path = (data_root / "uploads" / parts[1]).resolve()
        if not path.is_relative_to(upload_root):
            continue
        try:
            size_bytes = path.stat().st_size if path.is_file() else None
        except OSError:
            size_bytes = None
        uploads.append({
            "upload_id": upload_id,
            "request_id": record["request_id"],
            "filename": filename,
            "size_bytes": size_bytes,
            "payload_sha256": record["payload_sha256"],
            "receipt_sha256": record["receipt_sha256"],
            "source": record["source"],
            "uploaded_at": record["created_at"],
        })
    return web.json_response({"uploads": uploads})


async def _ticket(request: web.Request) -> web.Response:
    client = request.app[_CLIENT]
    body = await _body(request, EventTicket)
    kind, value = body["kind"], body["object_id"]
    path = f"/sessions/{value}" if kind == "session" else f"/swarm/runs/{value}"
    await client.read(path, kind=kind, value=value)
    tickets = request.app[_TICKETS]
    now = time.monotonic()
    for key in list(tickets):
        if tickets[key]["expires"] <= now:
            del tickets[key]
    if len(tickets) >= 128:
        raise web.HTTPTooManyRequests()
    token = secrets.token_urlsafe(32)
    tickets[token] = {**body, "expires": now + 30}
    return web.json_response({"url": f"{_PREFIX}/events?ticket={token}", "expires_in_seconds": 30})


async def _events(request: web.Request) -> web.StreamResponse:
    # This exact route uses a single-use capability issued by the authenticated route above.
    record = request.app[_TICKETS].pop(request.query.get("ticket", ""), None)
    if not record or record["expires"] <= time.monotonic():
        raise web.HTTPUnauthorized()
    client = request.app[_CLIENT]
    value = record["object_id"]
    path = f"/sessions/{value}/events" if record["kind"] == "session" else f"/swarm/runs/{value}/events"
    cursor = record["last_event_id"]
    headers = {"Last-Event-ID": cursor} if cursor else {}
    async with client.runtime.lease() as native:
        async with native.stream("GET", path, headers=headers, timeout=httpx.Timeout(30, read=None)) as upstream:
            if upstream.status_code != 200:
                raise NativeProtocolError("事件流不可用")
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                                                   "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
            await response.prepare(request)
            try:
                async for chunk in upstream.aiter_bytes():
                    await response.write(chunk)
            except (ConnectionResetError, httpx.HTTPError):
                pass
            return response


def register_stock_vibe_routes(app: web.Application, *, runtime: StockVibeRuntime | None = None,
                               host_root: Path | None = None,
                               model_writer: Callable[[str | None], None] = save_model_selection,
                               model_binding_writer: Callable[[dict], None] = save_model_binding,
                               attention_writer: Callable[[dict], None] = save_attention_preferences,
                               data_settings_writer: Callable[[str], None] = save_data_settings) -> None:
    runtime = runtime or StockVibeRuntime(automation_allowed=lambda: True)
    root = host_root or runtime.data_root.parent / "host"
    app[_CLIENT] = StockVibeClient(runtime, RequestStore(root / "requests.sqlite3"))
    app[_TICKETS] = {}
    app[_MODEL_WRITER] = model_writer
    app[_MODEL_BINDING_WRITER] = model_binding_writer
    app[_ATTENTION_WRITER] = attention_writer
    app[_DATA_SETTINGS_WRITER] = data_settings_writer
    app[_SUBMISSION_LOCK] = asyncio.Lock()
    app.middlewares.append(stock_vibe_errors)
    register_paper_routes(app, app[_CLIENT], _submit, _submission_response)
    app.router.add_get(_PREFIX, _status)
    app.router.add_get(_PREFIX + "/model", _model_get)
    app.router.add_put(_PREFIX + "/model", _model_put)
    app.router.add_get(_PREFIX + "/data-settings", _data_settings_get)
    app.router.add_put(_PREFIX + "/data-settings", _data_settings_put)
    app.router.add_get(_PREFIX + "/attention", _attention_get)
    app.router.add_put(_PREFIX + "/attention", _attention_put)
    app.router.add_get(_PREFIX + "/notifications", _notifications)
    app.router.add_post(_PREFIX + "/notifications/{object_id}/{action}", _notification_write)
    reads = {"/sessions": "sv_sessions", "/sessions/{object_id}": "sv_session",
             "/sessions/{object_id}/messages": "sv_messages", "/swarm/presets": "sv_presets",
             "/swarm/runs": "sv_swarms", "/swarm/runs/{object_id}": "sv_swarm",
             "/swarm/runs/{object_id}/artifacts": "sv_swarm_artifacts",
             "/runs": "sv_runs", "/runs/{object_id}": "sv_run",
             "/runs/{object_id}/preview": "sv_run_preview", "/portfolio": "sv_portfolio",
             "/portfolio/status": "sv_portfolio_status", "/operations": "sv_operations",
             "/operations/{object_id}": "sv_operation", "/shadow-profiles": "sv_shadows",
             "/shadow-profiles/{object_id}": "sv_shadow", "/scenarios": "sv_scenarios",
             "/scenarios/{object_id}": "sv_scenario", "/scheduled-firings": "sv_firings",
             "/attention/events": "sv_attention_events"}
    writes = {"/sessions": "sv_create_session", "/sessions/{object_id}/messages": "sv_send",
              "/sessions/{object_id}/cancel": "sv_cancel_session", "/swarm/runs": "sv_start_swarm",
              "/swarm/runs/{object_id}/cancel": "sv_cancel_swarm",
              "/swarm/runs/{object_id}/resume": "sv_resume_swarm", "/portfolio/refresh": "sv_refresh_portfolio"}
    for path, name in reads.items():
        app.router.add_get(_PREFIX + path, _read, name=name)
    for path, name in writes.items():
        app.router.add_post(_PREFIX + path, _write, name=name)
    app.router.add_get(_PREFIX + "/requests/{request_id}", _request)
    app.router.add_get(_PREFIX + "/sessions/{object_id}/attempts/{attempt_id}", _attempt)
    app.router.add_get(_PREFIX + "/opportunity-plans", _read, name="sv_opportunity_plans")
    app.router.add_get(_PREFIX + "/opportunity-sessions/{object_id}", _opportunity_session)
    app.router.add_get(_PREFIX + "/opportunity-history", _read, name="sv_opportunity_history")
    app.router.add_get(_PREFIX + "/opportunity-history/{object_id}/batches/{batch_id}", _opportunity_history_batch)
    app.router.add_get(_PREFIX + "/opportunity-records", _read, name="sv_opportunity_records")
    app.router.add_get(_PREFIX + "/backtest-settings/defaults", _read, name="sv_backtest_settings_defaults")
    app.router.add_get(_PREFIX + "/backtest-settings/inputs", _read, name="sv_backtest_settings_inputs")
    app.router.add_get(_PREFIX + "/native-research/catalog", _read, name="sv_native_research_catalog")
    app.router.add_get(_PREFIX + "/strategy-library", _read, name="sv_strategy_library")
    app.router.add_get(_PREFIX + "/strategy-library/history", _read, name="sv_strategy_library_history")
    app.router.add_get(_PREFIX + "/strategy-library/industries", _read, name="sv_strategy_library_industries")
    app.router.add_get(_PREFIX + "/strategy-library/{object_id}", _read, name="sv_strategy_library_strategy")
    app.router.add_get(_PREFIX + "/native-research/strategies/{object_id}", _read, name="sv_native_research_strategy")
    app.router.add_get(_PREFIX + "/native-research/{object_id}/evidence/{artifact_id}", _read, name="sv_native_research_evidence")
    app.router.add_get(_PREFIX + "/native-research/{object_id}", _read, name="sv_native_research_run")
    app.router.add_get(_PREFIX + "/alpha/list", _read, name="sv_alpha_list")
    app.router.add_get(_PREFIX + "/alpha/defaults", _read, name="sv_alpha_defaults")
    app.router.add_get(_PREFIX + "/alpha/readiness", _read, name="sv_alpha_readiness")
    app.router.add_get(_PREFIX + "/alpha/{object_id}", _read, name="sv_alpha")
    app.router.add_get(_PREFIX + "/reports/runs", _read, name="sv_report_runs")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/preview", _read, name="sv_report_preview")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/code", _read, name="sv_report_code")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/pine", _read, name="sv_report_pine")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/factor", _read, name="sv_report_factor")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/attribution", _read, name="sv_report_attribution")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}/positions/sectors", _read, name="sv_report_positions_sectors")
    app.router.add_get(_PREFIX + "/reports/runs/{object_id}", _read, name="sv_report_run")
    app.router.add_get(_PREFIX + "/artifacts/{kind}/{object_id}", _artifact)
    app.router.add_get(_PREFIX + "/swarm/runs/{object_id}/artifacts/{artifact_id}", _swarm_artifact)
    app.router.add_post(_PREFIX + "/uploads", _upload)
    app.router.add_get(_PREFIX + "/uploads", _uploaded_receipts)
    app.router.add_get(_PREFIX + "/market-data", _market_data)
    app.router.add_get(_PREFIX + "/symbol-search", _symbol_search)
    app.router.add_get(_PREFIX + "/workbench", _workbench)
    app.router.add_get(_PREFIX + "/workbench/history", _workbench_history)
    app.router.add_get(_PREFIX + "/workbench-market", _workbench_market, name="sv_workbench_market")
    app.router.add_get(_PREFIX + "/forecast", _workbench_market, name="sv_workbench_forecast")
    app.router.add_get(_PREFIX + "/scheduled-runs", _scheduled_get)
    app.router.add_get(_PREFIX + "/scheduled-runs/status", _scheduled_get, name="sv_scheduler_status")
    app.router.add_post(_PREFIX + "/scheduled-runs", _scheduled_write)
    app.router.add_patch(_PREFIX + "/scheduled-runs/{object_id}", _scheduled_write)
    app.router.add_delete(_PREFIX + "/scheduled-runs/{object_id}", _scheduled_write)
    app.router.add_post(_PREFIX + "/operations", _operation)
    app.router.add_post(_PREFIX + "/events/ticket", _ticket)
    app.router.add_get(_PREFIX + "/events", _events)

    async def cleanup(_app):
        await runtime.close()

    async def startup(_app):
        runtime.start_background_owner()

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
