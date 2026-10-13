"""Authenticated local cloud settings, separate from the VPS control API."""
from __future__ import annotations

from aiohttp import web
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from mona.cloud.coordinator import CloudCoordinator, SyncPreferences
from mona.cloud.crypto import CloudCryptoError
from mona.cloud.transfer import CloudTransferError
from mona.cloud.work_snapshot import is_work_session
from mona.config.paths import get_config_path, get_data_dir, get_media_dir
from mona.materials.auth import SERVICES_TOKEN_HEADER, is_valid_services_token
from mona.webui.transcript import webui_transcript_path

PREFIX = "/api/cloud-sync"
RUNTIME_KEY = "cloud_sync_coordinator"


class RequestBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Prepare(RequestBody):
    recovery: str | None = Field(default=None, max_length=160, repr=False)


class Scope(RequestBody):
    session_keys: list[str] = Field(default_factory=list, max_length=10_000)
    sync_new_conversations: bool | None = None
    sync_planning: bool | None = None

    @field_validator("session_keys")
    @classmethod
    def work_only(cls, keys):
        if any(not is_work_session(key, {}) for key in keys):
            raise ValueError("Only Work conversations are eligible")
        return list(dict.fromkeys(keys))


class Enable(Scope):
    draft_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    confirmed: bool = False


class Resource(RequestBody):
    resource_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class History(Resource):
    before: int = Field(default=2_147_483_647, ge=1, le=2_147_483_647)


class Download(Resource):
    file_id: str = Field(pattern=r"^[a-f0-9]{64}$")


class EnsureFile(RequestBody):
    session_key: str | None = Field(default=None, min_length=1, max_length=138)
    path: str = Field(min_length=1, max_length=4096)

    @field_validator("session_key")
    @classmethod
    def work_only(cls, key):
        if key is not None and not is_work_session(key, {}):
            raise ValueError("Only Work conversations are eligible")
        return key


class Restore(Resource):
    version: int = Field(ge=1, le=2_000_000_000)
    request_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    confirmed: bool = False


async def get_coordinator(request: web.Request) -> CloudCoordinator:
    coordinator = request.app.get(RUNTIME_KEY)
    if coordinator is None:
        loop = request.app.get("agent_loop")
        if loop is None or getattr(loop, "sessions", None) is None:
            raise CloudTransferError("runtime_unavailable", "会话服务尚未就绪，请稍后重试。")
        coordinator = CloudCoordinator(loop, config_path=get_config_path(),
            state_path=get_data_dir() / "cloud-sync" / "state.sqlite3", media_root=get_media_dir("websocket"),
            transcript_for=webui_transcript_path)
        request.app[RUNTIME_KEY] = coordinator
    await coordinator.start()
    return coordinator


async def body(request, schema):
    raw = bytearray()
    async for chunk in request.content.iter_chunked(64 * 1024):
        if len(raw) + len(chunk) > 512 * 1024:
            raise ValueError("Too large")
        raw.extend(chunk)
    return schema.model_validate_json(bytes(raw) or b"{}")


@web.middleware
async def cloud_auth(request, handler):
    if request.path != PREFIX and not request.path.startswith(PREFIX + "/"):
        return await handler(request)
    if request.method == "OPTIONS":
        return await handler(request)
    if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
        return web.json_response({"error": {"code": "unauthorized", "message": "请从 Mona 设置中操作云同步。"}},
                                 status=401, headers={"Cache-Control": "no-store"})
    try:
        response = await handler(request)
    except (CloudTransferError, CloudCryptoError) as exc:
        response = web.json_response({"error": {"code": getattr(exc, "code", "invalid_key"), "message": str(exc)}}, status=409)
    except (ValidationError, ValueError, TypeError):
        response = web.json_response({"error": {"code": "invalid_request", "message": "同步设置无效，请检查后重试。"}}, status=400)
    except Exception as exc:
        logger.warning("Cloud settings failed ({})", type(exc).__name__)
        response = web.json_response({"error": {"code": "sync_unavailable", "message": "同步操作尚未完成，本地内容已保留，请稍后重试。"}}, status=503)
    response.headers["Cache-Control"] = "no-store"
    return response


async def status(request):
    return web.json_response(await (await get_coordinator(request)).status())


async def prepare(request):
    data = await body(request, Prepare)
    return web.json_response(await (await get_coordinator(request)).prepare(data.recovery))


async def enable(request):
    data = await body(request, Enable)
    return web.json_response(await (await get_coordinator(request)).enable(
        data.draft_id, data.session_keys, data.confirmed, data.sync_new_conversations is True,
        data.sync_planning is True))


async def scope(request):
    data = await body(request, Scope)
    return web.json_response(await (await get_coordinator(request)).select(
        data.session_keys, data.sync_new_conversations, data.sync_planning))


async def pause(request):
    await body(request, RequestBody)
    return web.json_response(await (await get_coordinator(request)).pause())


async def sync(request):
    await body(request, RequestBody)
    coordinator = await get_coordinator(request)
    import asyncio
    config = await asyncio.to_thread(coordinator.preferences.read)
    if not config.enabled:
        raise CloudTransferError("sync_disabled", "请先开启云同步。")
    coordinator.wake.set()
    return web.json_response({"scheduled": True})


async def history(request):
    data = await body(request, History)
    return web.json_response(await (await get_coordinator(request)).history(data.resource_id, data.before))


async def files(request):
    data = await body(request, Resource)
    return web.json_response(await (await get_coordinator(request)).files(data.resource_id))


async def download(request):
    data = await body(request, Download)
    return web.json_response(await (await get_coordinator(request)).download_file(data.resource_id, data.file_id))


async def ensure_file(request):
    from pathlib import Path

    from mona.cloud.file_access import is_cloud_file_path
    data = await body(request, EnsureFile)
    path = Path(data.path)
    if not path.is_absolute() or not is_cloud_file_path(path):
        raise ValueError("Only exact cloud version paths are eligible")
    available = await (await get_coordinator(request)).ensure_file(data.session_key, path)
    return web.json_response({"available": available})


async def restore(request):
    data = await body(request, Restore)
    return web.json_response(await (await get_coordinator(request)).restore_version(
        data.resource_id, data.version, data.request_id, data.confirmed))


async def startup(app):
    try:
        import asyncio
        config = await asyncio.to_thread(SyncPreferences(get_config_path()).read)
        if config.enabled:
            loop = app.get("agent_loop")
            if loop is not None and getattr(loop, "sessions", None) is not None:
                coordinator = CloudCoordinator(loop, config_path=get_config_path(),
                    state_path=get_data_dir() / "cloud-sync" / "state.sqlite3", media_root=get_media_dir("websocket"),
                    transcript_for=webui_transcript_path)
                app[RUNTIME_KEY] = coordinator
                await coordinator.start()
    except Exception as exc:
        # Sync must never prevent the ordinary local Agent from starting.
        logger.warning("Cloud startup deferred ({})", type(exc).__name__)


async def cleanup(app):
    coordinator = app.get(RUNTIME_KEY)
    if coordinator is not None:
        await coordinator.close()


def register_cloud_routes(app: web.Application) -> None:
    manager = getattr(app.get("agent_loop"), "sessions", None)
    if manager is not None:
        async def resolve_file(session_key, path):
            coordinator = app.get(RUNTIME_KEY)
            if coordinator is None:
                coordinator = CloudCoordinator(app["agent_loop"], config_path=get_config_path(),
                    state_path=get_data_dir() / "cloud-sync" / "state.sqlite3",
                    media_root=get_media_dir("websocket"), transcript_for=webui_transcript_path)
                app[RUNTIME_KEY] = coordinator
                await coordinator.start()
            return await coordinator.ensure_file(session_key, path)
        manager.cloud_file_resolver = resolve_file
    app.middlewares.append(cloud_auth)
    app.router.add_get(PREFIX + "/status", status)
    for path, handler in [("prepare", prepare), ("enable", enable), ("scope", scope), ("pause", pause), ("sync", sync),
                          ("history", history), ("files", files), ("download", download), ("ensure-file", ensure_file), ("restore", restore)]:
        app.router.add_post(PREFIX + "/" + path, handler)
    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
