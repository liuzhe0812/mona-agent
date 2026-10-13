"""Authenticated synchronization endpoints on Services, not the Agent Gateway."""
from __future__ import annotations

import asyncio

from aiohttp import web
from filelock import Timeout
from pydantic import BaseModel, ConfigDict, Field

from mona.materials.auth import SERVICES_TOKEN_HEADER, is_valid_services_token
from mona.schedule.sync import KINDS, PlanningSyncError, apply_sync_item, list_sync_items
from mona.schedule.types import ScheduleItem

PREFIX = "/api/schedule/sync"


class ApplyItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
    expected: str = Field(pattern=r"^[a-f0-9]{64}$")
    data: dict | None


def service_for(request):
    if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
        raise web.HTTPUnauthorized()
    kind = request.match_info["kind"]
    if kind not in KINDS:
        raise web.HTTPNotFound()
    service = request.app.get("todo_service" if kind == "todo" else "schedule_service")
    if service is None:
        raise web.HTTPServiceUnavailable(reason="日程服务尚未就绪。")
    return service, kind


async def items(request):
    service, kind = service_for(request)
    try:
        result = await asyncio.to_thread(list_sync_items, service, kind)
        return web.json_response({"items": result}, headers={"Cache-Control": "no-store"})
    except (PlanningSyncError, Timeout) as exc:
        return failure(exc)


def failure(exc):
    return web.json_response({"error": {"code": getattr(exc, "code", "planning_busy"),
        "message": str(exc) if isinstance(exc, PlanningSyncError) else "本机日程正在保存，请稍后重试。"}},
        status=409, headers={"Cache-Control": "no-store"})


async def apply(request):
    service, kind = service_for(request)
    raw = bytearray()
    async for chunk in request.content.iter_chunked(16 * 1024):
        raw.extend(chunk)
        if len(raw) > 256 * 1024:
            raise web.HTTPRequestEntityTooLarge(max_size=256 * 1024, actual_size=len(raw))
    try:
        body = ApplyItem.model_validate_json(bytes(raw))
    except ValueError:
        raise web.HTTPBadRequest(reason="同步记录格式无效。") from None
    try:
        result = await asyncio.to_thread(apply_sync_item, service, kind, body.id, body.expected, body.data)
        if kind == "calendar_event":
            # Reconcile against current storage, not a potentially stale reply.
            # Personal reminders never dispatch AI jobs or replay missed runs.
            current = service._get_item_sync(body.id)
            handle = service._timers.pop(body.id, None)
            if handle:
                handle.cancel()
            if isinstance(current, ScheduleItem) and current.kind == "personal" and service._running:
                service._arm_personal_timer(current)
        return web.json_response(result, headers={"Cache-Control": "no-store"})
    except (PlanningSyncError, Timeout) as exc:
        return failure(exc)


def register_planning_sync_routes(app):
    app.router.add_get(PREFIX + "/{kind}", items)
    app.router.add_post(PREFIX + "/{kind}", apply)
