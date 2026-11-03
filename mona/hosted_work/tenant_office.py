"""Account-bound adapters for the existing Office HTTP and editor protocol."""
from __future__ import annotations

import asyncio
import inspect
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aiohttp import web

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, identifier, private_directory
from mona.hosted_work.sandbox_files import relative_path
from mona.office.api import (
    OFFICE_MANAGER_KEY,
    office_error_middleware,
    register_office_routes,
)
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import OFFICE_OWNER_HEADER, OfficeSessionState
from mona.office.sidecar import XlsxEngineService

OFFICE_PREFIX = "/api/work/desktop/api/office"
_OWNER = re.compile(r"^[a-f0-9]{64}$")
_SOCKET_TTL_SECONDS = 30

SessionAuthorizer = Callable[[str, str], Any | Awaitable[Any]]
IdentityReader = Callable[[str], Awaitable[str]]
EngineFactory = Callable[[str, str, Path], XlsxEngineService]


def _invalid_state() -> WorkError:
    return WorkError("invalid_state", "文档工作空间未通过安全检查。", 503)


def _public_state(state: OfficeSessionState) -> OfficeSessionState:
    suffix = {"docs": ".docx", "sheets": ".xlsx", "slides": ".pptx"}[state.type]
    return state.model_copy(update={
        "working_path": f"/workspace/.office/{state.session_id}/working{suffix}",
    })


def _directory(root: Path, *parts: str) -> Path:
    if root.is_symlink() or not root.is_dir():
        raise _invalid_state()
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise _invalid_state()
        current = private_directory(current)
        if not current.is_relative_to(root):
            raise _invalid_state()
    return current


def _within(root: Path, path: Path) -> Path:
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise _invalid_state() from None
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise _invalid_state()
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise _invalid_state()
    return resolved


class _UnavailableXlsxEngine(XlsxEngineService):
    async def open(self, *args, **kwargs):
        raise OfficeError(OfficeErrorCode.EDITOR_UNAVAILABLE, "线上表格处理组件尚未配置。", retryable=True)

    async def read_range(self, *args, **kwargs):
        raise OfficeError(OfficeErrorCode.EDITOR_UNAVAILABLE, "线上表格处理组件尚未配置。", retryable=True)


@dataclass(slots=True)
class _Context:
    app: web.Application
    workspace: Path
    sessions: Path


@dataclass(slots=True)
class _SocketBinding:
    owner: str
    conversation: str
    office_session: str
    expires: float
    token: str = field(repr=False)


class _OfficeRequest:
    def __init__(self, original: web.Request, context: _Context, internal_path: str):
        self.original = original
        self.app = context.app
        self.workspace = context.workspace
        self.rel_url = original.rel_url.with_path(internal_path)
        self.match_info: Any = None

    def __getattr__(self, name):
        return getattr(self.original, name)

    def __getitem__(self, key):
        return self.original[key]

    async def json(self):
        value = await self.original.json()
        if isinstance(value, dict):
            value = dict(value)
            field_name = "path" if self.rel_url.path == "/api/office/sessions" else (
                "output" if self.rel_url.path.endswith("/export") else None
            )
            if field_name and value.get(field_name) is not None:
                try:
                    relative = relative_path(value[field_name])
                except (ValueError, TypeError):
                    raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "文档路径不在当前工作区。") from None
                value[field_name] = str(_within(self.workspace, self.workspace / relative))
        return value


class TenantOffice:
    """The parent authenticates HTTP; one-use editor tickets retain that identity."""

    def __init__(self, config: HostedWorkConfig, *, authorize_session: SessionAuthorizer,
                 identity: IdentityReader, workspace_for_owner: Callable[[str], Path] | None = None,
                 engine_factory: EngineFactory | None = None):
        state = Path(config.state_dir).expanduser()
        if not state.is_absolute():
            raise ValueError("Office state root must be absolute")
        self.root = private_directory(state)
        self.config = config
        self.authorize_session = authorize_session
        self.identity = identity
        self.workspace_for_owner = workspace_for_owner
        self.engine_factory = engine_factory
        self._contexts: dict[tuple[str, str], _Context] = {}
        self._bindings: dict[str, _SocketBinding] = {}
        self._transports: set[Any] = set()
        self._creating = asyncio.Lock()

    @staticmethod
    def is_socket(request: web.Request) -> bool:
        return request.method == "GET" and request.path == OFFICE_PREFIX + "/ws"

    def workspace(self, owner: str) -> Path:
        self._owner(owner)
        expected = _directory(self.root, "users", owner, "documents")
        if self.workspace_for_owner is not None:
            supplied = self.workspace_for_owner(owner)
            if supplied.is_symlink() or supplied.resolve() != expected:
                raise _invalid_state()
        return expected

    @staticmethod
    def _owner(value: str) -> str:
        if not isinstance(value, str) or not _OWNER.fullmatch(value):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        return value

    async def _authorize(self, owner: str, conversation: str):
        self._owner(owner)
        identifier(conversation)
        result = self.authorize_session(owner, conversation)
        if inspect.isawaitable(result):
            result = await result
        if result is False:
            raise WorkError("not_found", "会话不存在。", 404)

    def _check_recovery(self, sessions: Path, workspace: Path):
        for item in sessions.glob("office_*"):
            if item.is_symlink():
                raise _invalid_state()
            if not item.is_dir():
                continue
            session_dir = _within(sessions, item)
            metadata = _within(session_dir, session_dir / "session.json")
            if not metadata.is_file():
                continue
            if metadata.stat().st_size > 2 * 1024 * 1024:
                raise _invalid_state()
            try:
                payload = json.loads(metadata.read_text(encoding="utf-8"))
            except (ValueError, UnicodeError):
                continue  # The shared manager reports damaged metadata for this session.
            if not isinstance(payload, dict):
                continue
            source = payload.get("sourcePath")
            if source is not None:
                if not isinstance(source, str):
                    raise _invalid_state()
                _within(workspace, Path(source))
            working = payload.get("workingFileName")
            if isinstance(working, str):
                _within(session_dir, session_dir / working)

    async def _context(self, owner: str, conversation: str) -> _Context:
        workspace = self.workspace(owner)
        sessions = _directory(self.root, "users", owner, "office", conversation, "sessions")
        async with self._creating:
            context = self._contexts.get((owner, conversation))
            if context is not None:
                return context
            self._check_recovery(sessions, workspace)
            manager = OfficeSessionManager(sessions_root=sessions, max_checkpoint_bytes=self.config.max_file_bytes)
            engine = self.engine_factory(owner, conversation, sessions) if self.engine_factory else _UnavailableXlsxEngine()
            app = web.Application()

            async def authorize_editor(request, session_key, office_session):
                try:
                    if request.get("owner") != owner or session_key != "websocket:" + conversation:
                        return False
                    if await self.identity(request.get("account_token", "")) != owner:
                        return False
                    await self._authorize(owner, conversation)
                    manager.get_session(office_session, owner_session_key=session_key)
                    return True
                except (WorkError, OfficeError):
                    return False

            register_office_routes(app, manager=manager, engine=engine, workspace=workspace,
                                   authorize=authorize_editor, state_transform=_public_state)
            app.freeze()
            await app.startup()
            context = _Context(app, workspace, sessions)
            self._contexts[(owner, conversation)] = context
            return context

    def _check_context_paths(self, context: _Context, session_key: str, session_id: str | None = None):
        manager = context.app[OFFICE_MANAGER_KEY]
        sessions = [manager.get_session(session_id, owner_session_key=session_key)] if session_id else (
            manager.list_sessions(owner_session_key=session_key)
        )
        for session in sessions:
            directory = _within(context.sessions, session.session_dir)
            _within(directory, session.working_path)
            if session.source_path is not None:
                _within(context.workspace, session.source_path)

    async def list_states(self, owner: str, sid: str) -> list[dict]:
        await self._authorize(owner, sid)
        context = await self._context(owner, sid)
        session_key = "websocket:" + sid
        self._check_context_paths(context, session_key)
        result = []
        for session in context.app[OFFICE_MANAGER_KEY].list_sessions(owner_session_key=session_key):
            result.append(_public_state(session.to_state()).model_dump(by_alias=True, mode="json"))
        return result

    async def handle(self, request: web.Request) -> web.StreamResponse:
        return await office_error_middleware(request, self._handle)

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        if request.headers.get("Origin") not in (None, self.config.public_origin.rstrip("/")):
            raise WorkError("origin_denied", "当前网页无权访问在线工作区。", 403)
        if not request.path.startswith(OFFICE_PREFIX + "/"):
            raise web.HTTPNotFound()
        now = time.monotonic()
        for ticket in [key for key, binding in self._bindings.items() if binding.expires <= now]:
            self._bindings.pop(ticket, None)
        socket = self.is_socket(request)
        if socket:
            binding = self._bindings.pop(request.query.get("ticket", ""), None)
            if binding is None or await self.identity(binding.token) != binding.owner:
                raise WorkError("login_required", "文档连接已失效，请重新打开文档。", 401)
            if request.get("owner") not in (None, binding.owner):
                raise WorkError("login_required", "文档连接不属于当前账号。", 401)
            owner, conversation = binding.owner, binding.conversation
            request["owner"], request["account_token"] = owner, binding.token
        else:
            owner = self._owner(request.get("owner", ""))
            key = request.headers.get(OFFICE_OWNER_HEADER, "")
            if not key.startswith("websocket:"):
                raise OfficeError(OfficeErrorCode.SESSION_NOT_FOUND, "Office 会话不存在。")
            conversation = identifier(key[len("websocket:"):])
        await self._authorize(owner, conversation)
        context = await self._context(owner, conversation)
        adapted = _OfficeRequest(request, context, "/api/office" + request.path[len(OFFICE_PREFIX):])
        adapted.match_info = await context.app.router.resolve(adapted)
        session_id = binding.office_session if socket else adapted.match_info.get("session_id")
        self._check_context_paths(context, "websocket:" + conversation, session_id)
        transport = request.transport
        if socket and transport is not None:
            self._transports.add(transport)
        try:
            response = await adapted.match_info.handler(adapted)
        finally:
            if socket and transport is not None:
                self._transports.discard(transport)
        if request.method == "POST" and request.path.endswith("/socket-ticket") and response.status == 200:
            payload = json.loads(response.body)
            token = request.get("account_token", "")
            if not token:
                raise WorkError("login_required", "请重新登录后打开文档。", 401)
            self._bindings[payload["ticket"]] = _SocketBinding(
                owner, conversation, payload["sessionId"], now + _SOCKET_TTL_SECONDS, token,
            )
        return response

    async def close(self):
        self._bindings.clear()
        for transport in tuple(self._transports):
            transport.close()
        for context in self._contexts.values():
            await context.app.cleanup()
        self._contexts.clear()


def register_tenant_office(app: web.Application, config: HostedWorkConfig, *,
                           authorize_session: SessionAuthorizer, identity: IdentityReader,
                           workspace_for_owner: Callable[[str], Path] | None = None,
                           engine_factory: EngineFactory | None = None) -> TenantOffice:
    office = TenantOffice(config, authorize_session=authorize_session, identity=identity,
                          workspace_for_owner=workspace_for_owner, engine_factory=engine_factory)
    app.router.add_route("*", OFFICE_PREFIX + "/{tail:.*}", office.handle)

    async def cleanup(_app):
        await office.close()

    app.on_cleanup.append(cleanup)
    return office
