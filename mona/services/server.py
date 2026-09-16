"""aiohttp application for the mona services process.

Registers every business route that does not need a live AgentLoop instance.
Handlers are imported from ``mona.api.server`` so behavior stays identical;
``mona.api.server.create_app`` keeps the same registrations during the
transition window (dual registration, see
docs/architecture/services-split-design.md §3.4).

IMAP singletons (connection pool, IDLE manager) are module-level in
``mona.api.server`` / ``mona.email.imap_pool``; importing this module does not
start them — the keepalive thread and the IDLE event loop are wired here, so
they exist exactly once per process.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from typing import Any

from aiohttp import web
from loguru import logger

from mona.api.server import (
    _cors_middleware,
    _idle_manager,
    handle_contacts_sync,
    handle_contacts_sync_eas,
    handle_contacts_test_carddav,
    handle_contacts_test_eas,
    handle_doc2note_extract,
    handle_doc2note_runtime_download,
    handle_doc2note_status,
    handle_email_account_removed,
    handle_email_analyze,
    handle_email_create_folder,
    handle_email_delete,
    handle_email_delete_folder,
    handle_email_empty_folder,
    handle_email_fetch_attachment,
    handle_email_fetch_body,
    handle_email_fetch_raw,
    handle_email_folders,
    handle_email_idle_start,
    handle_email_idle_status,
    handle_email_idle_stop,
    handle_email_idle_ws,
    handle_email_list_uids,
    handle_email_mark_all_read,
    handle_email_move,
    handle_email_parse_attachment,
    handle_email_pool_status,
    handle_email_rename_folder,
    handle_email_reset_pool,
    handle_email_save_draft,
    handle_email_schedule_confirm,
    handle_email_schedule_discard,
    handle_email_schedule_extract,
    handle_email_schedule_extract_manual,
    handle_email_schedule_pending,
    handle_email_send,
    handle_email_set_flag,
    handle_email_sync,
    handle_email_test_connection,
    handle_hoard_add,
    handle_hoard_delete_by_url,
    handle_materials_create_directory,
    handle_materials_create_library,
    handle_materials_delete,
    handle_materials_delete_library,
    handle_materials_delete_wiki_page,
    handle_materials_extract,
    handle_materials_get_evidence,
    handle_materials_get_raw,
    handle_materials_get_raw_binary,
    handle_materials_get_text,
    handle_materials_get_wiki_page,
    handle_materials_lint,
    handle_materials_list_files,
    handle_materials_list_libraries,
    handle_materials_list_wiki,
    handle_materials_llm_config,
    handle_materials_move,
    handle_materials_reconcile,
    handle_materials_search,
    handle_materials_status,
    handle_materials_update_library,
    handle_materials_write_wiki_page,
    handle_notes_export_docx,
    handle_office_health,
    handle_office_runtime_download,
    handle_profile_advice_feedback,
    handle_profile_advice_start,
    handle_profile_artifact_feedback,
    handle_profile_context_update,
    handle_profile_distill,
    handle_profile_evidence_get,
    handle_profile_get,
    handle_profile_user_get,
    handle_profile_user_update,
    handle_schedule_create,
    handle_schedule_get,
    handle_schedule_list,
    handle_schedule_notification_push,
    handle_schedule_notifications,
    handle_schedule_remove,
    handle_schedule_toggle,
    handle_schedule_update,
    handle_shutdown,
    handle_stock_kline,
    handle_stock_quote,
    handle_stock_research_context,
    handle_stock_research_preflight,
    handle_stock_search,
    handle_stock_watchlist_add,
    handle_stock_watchlist_focus,
    handle_stock_watchlist_import,
    handle_stock_watchlist_list,
    handle_stock_watchlist_remove,
    handle_stock_watchlist_reorder,
    handle_todo_briefing,
    handle_todo_create,
    handle_todo_from_email,
    handle_todo_get,
    handle_todo_list,
    handle_todo_remove,
    handle_todo_to_schedule,
    handle_todo_update,
    handle_url2note_extract,
    handle_video_ai_scene_html,
    handle_video_ai_scene_rewrite,
    handle_video_project,
    handle_video_project_archive,
    handle_video_project_asset_import,
    handle_video_project_asset_update,
    handle_video_project_assets,
    handle_video_project_change_aspect,
    handle_video_project_copy,
    handle_video_project_create,
    handle_video_project_export,
    handle_video_project_export_cancel,
    handle_video_project_export_preflight,
    handle_video_project_export_status,
    handle_video_project_file,
    handle_video_project_localize,
    handle_video_project_lock_storyboard,
    handle_video_project_plan,
    handle_video_project_preview_full,
    handle_video_project_rename,
    handle_video_project_review_create,
    handle_video_project_review_resolve,
    handle_video_project_reviews,
    handle_video_project_save_chat_id,
    handle_video_project_scene_add,
    handle_video_project_scene_confirm,
    handle_video_project_scene_delete,
    handle_video_project_scene_narration,
    handle_video_project_scene_preview,
    handle_video_project_scene_regenerate,
    handle_video_project_scene_reorder,
    handle_video_project_scene_timeline,
    handle_video_project_scene_update,
    handle_video_project_storyboard,
    handle_video_project_upgrade_style,
    handle_video_project_version_restore,
    handle_video_project_versions,
    handle_video_projects,
    handle_video_runtime_check,
    handle_video_runtime_download,
    handle_video_series_projects_upgrade,
)
from mona.api.video_runtime_jobs import (
    handle_video_runtime_download_cancel,
    handle_video_runtime_download_start,
    handle_video_runtime_download_status,
)
from mona.api.video_series import (
    handle_video_background_asset_delete,
    handle_video_background_asset_import,
    handle_video_background_asset_preview,
    handle_video_brand_kit_create,
    handle_video_brand_kit_lock,
    handle_video_brand_kits,
    handle_video_brand_logo_import,
    handle_video_series_apply_brand_kit,
    handle_video_series_create,
    handle_video_series_delete,
    handle_video_series_get,
    handle_video_series_list,
    handle_video_series_update,
    handle_video_style_draft_get,
    handle_video_style_draft_put,
    handle_video_style_lock,
    handle_video_style_preview,
    handle_video_style_templates,
    handle_video_style_validate,
    handle_video_style_version_to_draft,
    handle_video_style_versions,
)
from mona.email.imap_pool import imap_pool_manager
from mona.materials.auth import get_services_token, materials_auth_middleware
from mona.materials.compile import (
    handle_materials_wiki_compile_cancel,
    handle_materials_wiki_compile_start,
    handle_materials_wiki_compile_status,
)
from mona.materials.knowledge import (
    handle_agent_knowledge_add,
    handle_agent_knowledge_graph,
    handle_agent_knowledge_list,
    handle_agent_knowledge_remove,
    handle_agent_knowledge_retry,
    recover_agent_knowledge_tasks,
    shutdown_agent_knowledge_tasks,
)
from mona.office.api import office_error_middleware, register_office_routes
from mona.services.stock.api import (
    cleanup_stock_intraday,
    handle_stock_decision_conditions,
    handle_stock_diagnosis_cancel,
    handle_stock_diagnosis_create,
    handle_stock_diagnosis_delete,
    handle_stock_diagnosis_fail,
    handle_stock_diagnosis_get,
    handle_stock_diagnosis_list,
    handle_stock_diagnosis_outcome,
    handle_stock_diagnosis_retry,
    handle_stock_intraday,
    handle_stock_intraday_stream,
    handle_stock_material_bind,
    handle_stock_material_confirm,
    handle_stock_material_preview,
    handle_stock_materials,
    handle_stock_outcomes,
    handle_stock_outcomes_refresh,
    handle_stock_portfolio_context,
    handle_stock_risk_profile,
    handle_stock_risk_profile_delete,
    handle_stock_screen_compare,
    handle_stock_screen_history,
    handle_stock_screen_opportunity_source,
    handle_stock_screen_outcomes,
    handle_stock_screen_outcomes_refresh,
    handle_stock_screen_results,
    handle_stock_screen_strategies,
    handle_stock_screen_strategy_delete,
    handle_stock_screen_templates,
)

_PRO_ROUTE_PREFIXES = (
    "/api/video",
    "/api/stock/diagnosis",
    "/email/analyze",
    "/email/schedule/",
    "/api/email/schedule/",
)


async def _has_subscription_access(request: web.Request) -> bool:
    resolver = request.app.get("subscription_access_resolver")
    try:
        if resolver is None:
            from mona.agent.tools.tauri_ipc import check_subscription_access

            return bool(await asyncio.to_thread(check_subscription_access))
        result = resolver()
        if inspect.isawaitable(result):
            result = await result
        return result is True
    except Exception:
        logger.exception("subscription access check failed")
        return False


@web.middleware
async def _subscription_middleware(
    request: web.Request, handler: Any
) -> web.StreamResponse:
    if request.method != "OPTIONS" and request.path.startswith(_PRO_ROUTE_PREFIXES):
        if not await _has_subscription_access(request):
            return web.json_response(
                {
                    "error": "membership_required",
                    "detail": "该功能需要有效的 Mona Pro 订阅或试用",
                },
                status=403,
            )
    return await handler(request)


async def handle_services_health(request: web.Request) -> web.Response:
    """Identify a compatible services process, not merely a live HTTP server."""
    return web.json_response(
        {
            "status": "ok",
            "service": "mona-services",
            "capabilities": ["stock-v1", "office-editor-v1"],
        }
    )


def create_services_app(
    schedule_service: Any | None = None,
    todo_service: Any | None = None,
    workspace: Any | None = None,
) -> web.Application:
    """Create the aiohttp application for the services process.

    Args:
        schedule_service: ScheduleService backing /api/schedule/* and
            /email/schedule/* routes (also consumes LLM schedule extraction).
        todo_service: TodoService backing /api/schedule/todos/* and
            /api/schedule/briefing routes.
        workspace: Mona workspace root shared with the Agent runtime. 3D
            project routes must resolve against the same directory the Agent
            file tools see, otherwise uploads and generation diverge.
    """
    app = web.Application(
        client_max_size=20 * 1024 * 1024,
        middlewares=[
            _cors_middleware,
            _subscription_middleware,
            materials_auth_middleware,
            office_error_middleware,
        ],
    )
    # 启动时即解析并持久化 services 令牌，保证 Rust 本地 HTTP 桥读取
    # services.token 时文件已存在（避免首次请求的 chicken-and-egg 401）。
    get_services_token()
    # No agent_loop in this process; handlers that need an LLM fall back to
    # _resolve_llm_provider() (config.json snapshot).
    app["shutdown_event"] = asyncio.Event()
    app["schedule_service"] = schedule_service
    app["todo_service"] = todo_service
    app["workspace"] = workspace

    app.router.add_get("/health", handle_services_health)
    app.router.add_post("/shutdown", handle_shutdown)

    # Email routes (IMAP pool + IDLE live in this process only)
    app.router.add_post("/email/folders", handle_email_folders)
    app.router.add_post("/email/create_folder", handle_email_create_folder)
    app.router.add_post("/email/rename_folder", handle_email_rename_folder)
    app.router.add_post("/email/delete_folder", handle_email_delete_folder)
    app.router.add_post("/email/sync", handle_email_sync)
    app.router.add_post("/email/list_uids", handle_email_list_uids)
    app.router.add_post("/email/send", handle_email_send)
    app.router.add_post("/email/delete", handle_email_delete)
    app.router.add_post("/email/set_flag", handle_email_set_flag)
    app.router.add_post("/email/mark_all_read", handle_email_mark_all_read)
    app.router.add_post("/email/empty_folder", handle_email_empty_folder)
    app.router.add_post("/email/move", handle_email_move)
    app.router.add_post("/email/analyze", handle_email_analyze)
    app.router.add_post("/email/fetch_attachment", handle_email_fetch_attachment)
    app.router.add_post("/email/fetch_body", handle_email_fetch_body)
    app.router.add_post("/email/parse_attachment", handle_email_parse_attachment)
    app.router.add_post("/email/fetch_raw", handle_email_fetch_raw)
    app.router.add_post("/email/save_draft", handle_email_save_draft)
    app.router.add_post("/email/test_connection", handle_email_test_connection)
    app.router.add_post("/email/reset_pool", handle_email_reset_pool)
    app.router.add_get("/email/pool_status", handle_email_pool_status)
    app.router.add_post("/email/account_removed", handle_email_account_removed)

    # Email schedule AI extract routes
    app.router.add_post("/email/schedule/extract", handle_email_schedule_extract)
    app.router.add_post("/email/schedule/extract-manual", handle_email_schedule_extract_manual)
    app.router.add_get("/api/email/schedule/pending", handle_email_schedule_pending)
    app.router.add_post("/api/email/schedule/confirm", handle_email_schedule_confirm)
    app.router.add_post("/api/email/schedule/discard", handle_email_schedule_discard)

    # Email IDLE routes（实时推送）
    app.router.add_post("/email/idle/start", handle_email_idle_start)
    app.router.add_post("/email/idle/stop", handle_email_idle_stop)
    app.router.add_get("/email/idle/status", handle_email_idle_status)
    app.router.add_get("/email/idle/ws", handle_email_idle_ws)

    # Contacts (CardDAV/EAS) routes
    app.router.add_post("/contacts/sync", handle_contacts_sync)
    app.router.add_post("/contacts/test_carddav", handle_contacts_test_carddav)
    app.router.add_post("/contacts/sync_eas", handle_contacts_sync_eas)
    app.router.add_post("/contacts/test_eas", handle_contacts_test_eas)

    # Schedule routes
    app.router.add_get("/api/schedule/items", handle_schedule_list)
    app.router.add_get("/api/schedule/items/{id}", handle_schedule_get)
    app.router.add_post("/api/schedule/items", handle_schedule_create)
    app.router.add_post("/api/schedule/items/{id}/update", handle_schedule_update)
    app.router.add_post("/api/schedule/items/{id}/remove", handle_schedule_remove)
    app.router.add_post("/api/schedule/items/{id}/toggle", handle_schedule_toggle)
    app.router.add_get("/api/schedule/notifications", handle_schedule_notifications)
    app.router.add_post(
        "/api/schedule/notifications/push", handle_schedule_notification_push
    )

    # Todo routes (unified planning center)
    app.router.add_get("/api/schedule/todos", handle_todo_list)
    app.router.add_get("/api/schedule/todos/{id}", handle_todo_get)
    app.router.add_post("/api/schedule/todos", handle_todo_create)
    app.router.add_post("/api/schedule/todos/{id}/update", handle_todo_update)
    app.router.add_post("/api/schedule/todos/{id}/remove", handle_todo_remove)
    app.router.add_post("/api/schedule/todos/{id}/to-schedule", handle_todo_to_schedule)
    app.router.add_post("/api/schedule/todos/from-email", handle_todo_from_email)
    app.router.add_get("/api/schedule/briefing", handle_todo_briefing)

    # Materials routes
    app.router.add_get("/api/materials/libraries", handle_materials_list_libraries)
    app.router.add_post("/api/materials/libraries", handle_materials_create_library)
    app.router.add_patch(
        "/api/materials/libraries/{library_id}", handle_materials_update_library
    )
    app.router.add_delete(
        "/api/materials/libraries/{library_id}", handle_materials_delete_library
    )
    app.router.add_get("/api/materials/files", handle_materials_list_files)
    app.router.add_post("/api/materials/directory", handle_materials_create_directory)
    app.router.add_delete("/api/materials/files/{path:.*}", handle_materials_delete)
    app.router.add_post("/api/materials/move", handle_materials_move)
    app.router.add_post("/api/materials/extract", handle_materials_extract)
    app.router.add_post("/api/materials/reconcile", handle_materials_reconcile)
    app.router.add_get("/api/materials/text/{path:.*}", handle_materials_get_text)
    app.router.add_get(
        "/api/materials/evidence/{evidence_id}", handle_materials_get_evidence
    )
    app.router.add_get("/api/materials/raw/{path:.*}", handle_materials_get_raw)
    app.router.add_get("/api/materials/raw-binary/{path:.*}", handle_materials_get_raw_binary)
    app.router.add_get("/api/materials/wiki", handle_materials_list_wiki)
    app.router.add_post("/api/materials/wiki/compile", handle_materials_wiki_compile_start)
    app.router.add_get(
        "/api/materials/wiki/compile/{task_id}", handle_materials_wiki_compile_status
    )
    app.router.add_post(
        "/api/materials/wiki/compile/{task_id}/cancel", handle_materials_wiki_compile_cancel
    )
    app.router.add_get("/api/materials/wiki/{path:.*}", handle_materials_get_wiki_page)
    app.router.add_post("/api/materials/wiki/write", handle_materials_write_wiki_page)
    app.router.add_delete("/api/materials/wiki/{path:.*}", handle_materials_delete_wiki_page)
    app.router.add_get("/api/materials/search", handle_materials_search)
    app.router.add_post("/api/materials/lint", handle_materials_lint)
    app.router.add_get("/api/materials/status", handle_materials_status)
    app.router.add_get("/api/materials/llm-config", handle_materials_llm_config)
    app.router.add_get("/api/materials/knowledge", handle_agent_knowledge_list)
    app.router.add_post("/api/materials/knowledge", handle_agent_knowledge_add)
    app.router.add_get(
        "/api/materials/knowledge/graph",
        handle_agent_knowledge_graph,
    )
    app.router.add_post(
        "/api/materials/knowledge/{document_id}/retry",
        handle_agent_knowledge_retry,
    )
    app.router.add_delete(
        "/api/materials/knowledge/{document_id}",
        handle_agent_knowledge_remove,
    )

    # Hoard routes (Agent URL memory: browser star sync)
    app.router.add_post("/api/hoard", handle_hoard_add)
    app.router.add_delete("/api/hoard-by-url", handle_hoard_delete_by_url)

    # Stock module data API (design §10.1/P5): market data plus explicit,
    # local outcome tracking reads/refreshes under the configured workspace.
    app.router.add_get("/api/stock/watchlist", handle_stock_watchlist_list)
    app.router.add_post("/api/stock/watchlist", handle_stock_watchlist_add)
    app.router.add_delete("/api/stock/watchlist", handle_stock_watchlist_remove)
    app.router.add_post("/api/stock/watchlist/import", handle_stock_watchlist_import)
    app.router.add_post("/api/stock/watchlist/focus", handle_stock_watchlist_focus)
    app.router.add_post("/api/stock/watchlist/order", handle_stock_watchlist_reorder)
    app.router.add_get("/api/stock/search", handle_stock_search)
    app.router.add_get("/api/stock/quote", handle_stock_quote)
    app.router.add_get("/api/stock/kline", handle_stock_kline)
    app.router.add_get("/api/stock/intraday", handle_stock_intraday)
    app.router.add_get("/api/stock/intraday/stream", handle_stock_intraday_stream)
    app.router.add_post("/api/stock/diagnosis", handle_stock_diagnosis_create)
    app.router.add_get("/api/stock/diagnosis", handle_stock_diagnosis_list)
    app.router.add_get("/api/stock/diagnosis/{diagnosis_id}", handle_stock_diagnosis_get)
    app.router.add_get(
        "/api/stock/diagnosis/{diagnosis_id}/outcome",
        handle_stock_diagnosis_outcome,
    )
    app.router.add_delete(
        "/api/stock/diagnosis/{diagnosis_id}", handle_stock_diagnosis_delete
    )
    app.router.add_post(
        "/api/stock/diagnosis/{diagnosis_id}/cancel", handle_stock_diagnosis_cancel
    )
    app.router.add_post(
        "/api/stock/diagnosis/{diagnosis_id}/fail", handle_stock_diagnosis_fail
    )
    app.router.add_post(
        "/api/stock/diagnosis/{diagnosis_id}/retry", handle_stock_diagnosis_retry
    )
    app.router.add_get("/api/stock/decision-conditions", handle_stock_decision_conditions)
    app.router.add_get("/api/stock/materials", handle_stock_materials)
    app.router.add_get("/api/stock/materials/preview", handle_stock_material_preview)
    app.router.add_post("/api/stock/materials/bind", handle_stock_material_bind)
    app.router.add_post("/api/stock/materials/confirm", handle_stock_material_confirm)
    app.router.add_get("/api/stock/outcomes", handle_stock_outcomes)
    app.router.add_post("/api/stock/outcomes/refresh", handle_stock_outcomes_refresh)
    app.router.add_get("/api/stock/risk-profile", handle_stock_risk_profile)
    app.router.add_put("/api/stock/risk-profile", handle_stock_risk_profile)
    app.router.add_delete("/api/stock/risk-profile", handle_stock_risk_profile_delete)
    app.router.add_get("/api/stock/portfolio-context", handle_stock_portfolio_context)
    app.router.add_put("/api/stock/portfolio-context", handle_stock_portfolio_context)
    app.router.add_delete("/api/stock/portfolio-context", handle_stock_portfolio_context)
    app.router.add_get("/api/stock/screen/outcomes", handle_stock_screen_outcomes)
    app.router.add_post(
        "/api/stock/screen/outcomes/refresh", handle_stock_screen_outcomes_refresh
    )
    app.router.add_get("/api/stock/research-context", handle_stock_research_context)
    app.router.add_post("/api/stock/research/preflight", handle_stock_research_preflight)
    app.router.add_get("/api/stock/screen/templates", handle_stock_screen_templates)
    app.router.add_get("/api/stock/screen/strategies", handle_stock_screen_strategies)
    app.router.add_post("/api/stock/screen/strategies", handle_stock_screen_strategies)
    app.router.add_delete("/api/stock/screen/strategies", handle_stock_screen_strategy_delete)
    app.router.add_get("/api/stock/screen/results", handle_stock_screen_results)
    app.router.add_get(
        "/api/stock/screen/opportunity/source",
        handle_stock_screen_opportunity_source,
    )
    app.router.add_get("/api/stock/screen/history", handle_stock_screen_history)
    app.router.add_post("/api/stock/screen/compare", handle_stock_screen_compare)

    # Profile (user distillation) routes
    app.router.add_get("/api/profile", handle_profile_get)
    app.router.add_get("/api/profile/user", handle_profile_user_get)
    app.router.add_patch("/api/profile/user", handle_profile_user_update)
    app.router.add_patch("/api/profile/context", handle_profile_context_update)
    app.router.add_patch(
        "/api/profile/advice/{id}/feedback", handle_profile_advice_feedback
    )
    app.router.add_post("/api/profile/advice/{id}/start", handle_profile_advice_start)
    app.router.add_patch(
        "/api/profile/artifacts/{id}/feedback", handle_profile_artifact_feedback
    )
    app.router.add_get("/api/profile/evidence/{ref}", handle_profile_evidence_get)
    app.router.add_post("/api/profile/distill", handle_profile_distill)

    # Video project routes + url2note + doc2note
    app.router.add_get("/api/video/runtime-check", handle_video_runtime_check)
    app.router.add_post("/api/video/runtime-download", handle_video_runtime_download)
    app.router.add_post(
        "/api/video/runtime-download/start", handle_video_runtime_download_start
    )
    app.router.add_post(
        "/api/video/runtime-download/cancel", handle_video_runtime_download_cancel
    )
    app.router.add_get(
        "/api/video/runtime-download/status", handle_video_runtime_download_status
    )
    app.router.add_post("/api/url2note/extract", handle_url2note_extract)
    app.router.add_get("/api/doc2note/status", handle_doc2note_status)
    app.router.add_post("/api/doc2note/runtime-download", handle_doc2note_runtime_download)
    app.router.add_post("/api/doc2note/extract", handle_doc2note_extract)

    # Office document collaboration (阶段 B: OfficeCLI-backed AI modification)
    app.router.add_get("/api/office/health", handle_office_health)
    app.router.add_post("/api/office/runtime-download", handle_office_runtime_download)
    register_office_routes(app, workspace=workspace)
    # Notes → Word export (markdown → .docx, with mermaid PNGs rasterized client-side)
    app.router.add_post("/api/notes/export-docx", handle_notes_export_docx)
    app.router.add_get("/api/video/projects", handle_video_projects)
    app.router.add_get("/api/video/style/templates", handle_video_style_templates)
    app.router.add_get("/api/video/series", handle_video_series_list)
    app.router.add_post("/api/video/series", handle_video_series_create)
    app.router.add_patch(
        "/api/video/series/{series_id}", handle_video_series_update
    )
    app.router.add_get("/api/video/brand-kits", handle_video_brand_kits)
    app.router.add_post("/api/video/brand-kits", handle_video_brand_kit_create)
    app.router.add_post(
        "/api/video/brand-kits/{kit_id}/logo", handle_video_brand_logo_import
    )
    app.router.add_post(
        "/api/video/brand-kits/{kit_id}/lock", handle_video_brand_kit_lock
    )
    app.router.add_get("/api/video/series/{series_id}", handle_video_series_get)
    app.router.add_delete("/api/video/series/{series_id}", handle_video_series_delete)
    app.router.add_post(
        "/api/video/series/{series_id}/brand-kit",
        handle_video_series_apply_brand_kit,
    )
    app.router.add_get(
        "/api/video/series/{series_id}/style/draft", handle_video_style_draft_get
    )
    app.router.add_put(
        "/api/video/series/{series_id}/style/draft", handle_video_style_draft_put
    )
    app.router.add_post(
        "/api/video/series/{series_id}/style/validate", handle_video_style_validate
    )
    app.router.add_post(
        "/api/video/series/{series_id}/style/preview", handle_video_style_preview
    )
    app.router.add_post(
        "/api/video/series/{series_id}/style/lock", handle_video_style_lock
    )
    app.router.add_get(
        "/api/video/series/{series_id}/styles", handle_video_style_versions
    )
    app.router.add_post(
        "/api/video/series/{series_id}/styles/{version}/draft",
        handle_video_style_version_to_draft,
    )
    app.router.add_post(
        "/api/video/series/{series_id}/background-assets",
        handle_video_background_asset_import,
    )
    app.router.add_delete(
        "/api/video/series/{series_id}/background-assets/{asset_id}",
        handle_video_background_asset_delete,
    )
    app.router.add_get(
        "/api/video/series/{series_id}/background-assets/{asset_id}/preview",
        handle_video_background_asset_preview,
    )
    app.router.add_post("/api/video/project/plan", handle_video_project_plan)
    app.router.add_post("/api/video/project/create", handle_video_project_create)
    app.router.add_post("/api/video/project/rename", handle_video_project_rename)
    app.router.add_post("/api/video/project/copy", handle_video_project_copy)
    app.router.add_post("/api/video/project/archive", handle_video_project_archive)
    app.router.add_post(
        "/api/video/project/change-aspect", handle_video_project_change_aspect
    )
    app.router.add_post(
        "/api/video/project/upgrade-style", handle_video_project_upgrade_style
    )
    app.router.add_post(
        "/api/video/series/{series_id}/upgrade-projects",
        handle_video_series_projects_upgrade,
    )
    app.router.add_get("/api/video/project", handle_video_project)
    app.router.add_get("/api/video/project-file", handle_video_project_file)
    app.router.add_get("/api/video/project/assets", handle_video_project_assets)
    app.router.add_post(
        "/api/video/project/asset/import", handle_video_project_asset_import
    )
    app.router.add_patch(
        "/api/video/project/asset", handle_video_project_asset_update
    )
    app.router.add_post(
        "/api/video/project-save-chat-id", handle_video_project_save_chat_id
    )
    app.router.add_get(
        "/api/video/project/storyboard", handle_video_project_storyboard
    )
    app.router.add_put("/api/video/project/scene", handle_video_project_scene_update)
    app.router.add_delete(
        "/api/video/project/scene", handle_video_project_scene_delete
    )
    app.router.add_post("/api/video/project/scene/add", handle_video_project_scene_add)
    app.router.add_post(
        "/api/video/project/scene/reorder", handle_video_project_scene_reorder
    )
    app.router.add_post(
        "/api/video/project/lock-storyboard", handle_video_project_lock_storyboard
    )
    app.router.add_post(
        "/api/video/project/localize", handle_video_project_localize
    )
    app.router.add_post(
        "/api/video/project/scene/narration", handle_video_project_scene_narration
    )
    app.router.add_get(
        "/api/video/project/scene/narration", handle_video_project_scene_narration
    )
    app.router.add_post("/api/video/ai/scene-html", handle_video_ai_scene_html)
    app.router.add_get(
        "/api/video/project/scene/preview", handle_video_project_scene_preview
    )
    app.router.add_get(
        "/api/video/project/scene/timeline", handle_video_project_scene_timeline
    )
    app.router.add_post(
        "/api/video/project/scene/confirm", handle_video_project_scene_confirm
    )
    app.router.add_post(
        "/api/video/project/scene/regenerate", handle_video_project_scene_regenerate
    )
    app.router.add_post("/api/video/ai/scene-rewrite", handle_video_ai_scene_rewrite)
    app.router.add_post("/api/video/project/export", handle_video_project_export)
    app.router.add_post(
        "/api/video/project/export/cancel", handle_video_project_export_cancel
    )
    app.router.add_get(
        "/api/video/project/export-preflight",
        handle_video_project_export_preflight,
    )
    app.router.add_get(
        "/api/video/project/export-status", handle_video_project_export_status
    )
    app.router.add_get(
        "/api/video/project/preview-full", handle_video_project_preview_full
    )
    app.router.add_get(
        "/api/video/project/versions", handle_video_project_versions
    )
    app.router.add_post(
        "/api/video/project/version/restore", handle_video_project_version_restore
    )
    app.router.add_get("/api/video/project/reviews", handle_video_project_reviews)
    app.router.add_post(
        "/api/video/project/review", handle_video_project_review_create
    )
    app.router.add_patch(
        "/api/video/project/review", handle_video_project_review_resolve
    )

    # 设置 IDLE 管理器的事件循环（本进程独占）
    _idle_manager.set_loop(asyncio.get_event_loop())

    # 启动 IMAP 连接池后台保活线程（与 gateway 原实现一致，每 2 分钟 NOOP 一次）
    keepalive_thread = threading.Thread(
        target=imap_pool_manager.keepalive,
        args=(120.0,),
        name="imap-pool-keepalive",
        daemon=True,
    )
    keepalive_thread.start()

    async def _on_cleanup(_app: web.Application) -> None:
        _idle_manager.stop_all()
        await shutdown_agent_knowledge_tasks()
        await asyncio.to_thread(imap_pool_manager.close_all)
        await cleanup_stock_intraday()

    app.on_startup.append(recover_agent_knowledge_tasks)
    app.on_cleanup.append(_on_cleanup)

    logger.info("services app created (business routes, no AgentLoop)")
    return app
