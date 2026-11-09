"""Bind the shared Office and canvas tools to one hosted account and live renderer."""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

import httpx

from mona.agent.tools.canvas import CanvasTool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DeliverFileTool
from mona.agent.tools.office import (
    _IMAGE_EXT_TO_MIME,
    _MAX_IMAGE_BYTES,
    OfficeTool,
    OfficeToolConfig,
)
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.bus.events import OUTBOUND_META_AGENT_UI, OutboundMessage
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.contracts import WorkError, identifier, private_directory
from mona.hosted_work.sandbox_files import relative_path
from mona.hosted_work.tenant_files import TenantFiles
from mona.office.client import OfficeServiceClient
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import OFFICE_OWNER_HEADER

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_EDITOR_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_OFFICE_ROUTE = re.compile(
    r"/api/work/desktop/api/office/sessions(?:/[A-Za-z0-9_-]+(?:/(?:file|inspect|apply|save|export))?)?"
)
_PATH_FIELDS = frozenset({"path", "output", "sourcePath", "source_path", "absolute_path", "workingPath", "working_path"})
_OFFICE_ACTIONS = frozenset({"list", "open", "inspect", "apply", "save", "export", "close"})
Emit = Callable[[str, dict], Awaitable[None]]


def _invalid_path() -> OfficeError:
    return OfficeError(OfficeErrorCode.INVALID_OPERATION, "文件不在当前账号的文档工作区内。")


def _failure(error: OfficeError) -> str:
    return json.dumps({"ok": False, "error": {"code": error.code, "message": error.message,
                                               "retryable": error.retryable}}, ensure_ascii=False)


@dataclass(frozen=True, slots=True)
class _EditorScope:
    root: Path
    sessions: Path
    owner: str
    run_id: str
    session_id: str
    endpoint: str
    origin: str
    limit: int
    file_limit: int
    token: str = field(repr=False)

    @property
    def session_key(self) -> str:
        return "websocket:" + self.session_id

    def host_path(self, value: object) -> Path:
        if not isinstance(value, str) or not value or len(value) > 2048:
            raise _invalid_path()
        if value.startswith("/workspace/"):
            logical = value
        else:
            candidate = Path(value)
            if candidate.is_absolute():
                if not candidate.is_relative_to(self.root):
                    raise _invalid_path()
                logical = TenantFiles._logical(self.root, candidate)
            else:
                logical = "/workspace/" + value
        try:
            return TenantFiles._path(self.root, logical)
        except (OSError, ValueError, WorkError):
            raise _invalid_path() from None

    def logical_path(self, value: object) -> str:
        return TenantFiles._logical(self.root, self.host_path(value))

    def context(self, ctx: RequestContext) -> RequestContext:
        if ctx.chat_id != self.session_id or ctx.session_key not in (None, self.session_key):
            raise _invalid_path()
        metadata = {key: ctx.metadata[key] for key in ("office_session_id", "canvas_id", "canvas_path")
                    if ctx.metadata.get(key) is not None}
        for key in ("office_session_id", "canvas_id"):
            value = metadata.get(key)
            if value is not None and (not isinstance(value, str) or not _EDITOR_ID.fullmatch(value)):
                raise _invalid_path()
        if metadata.get("canvas_path"):
            metadata["canvas_path"] = str(self.host_path(metadata["canvas_path"]))
        return replace(ctx, channel="websocket", session_key=self.session_key, metadata=metadata)

    def scrub_text(self, text: str) -> str:
        return text.replace(self.token, "[redacted]").replace(str(self.root), "/workspace").replace(
            str(self.sessions), "/workspace/.office")

    def public_value(self, value: Any) -> Any:
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key in _PATH_FIELDS and isinstance(item, str):
                    path = Path(item)
                    if key in {"workingPath", "working_path"} and item.startswith("/workspace/.office/"):
                        if not re.fullmatch(r"/workspace/\.office/[A-Za-z0-9_-]{1,128}/working\.(docx|xlsx|pptx)", item):
                            raise _invalid_path()
                        item = None
                    elif item.startswith("/workspace/") or path.is_absolute() and path.is_relative_to(self.root):
                        item = self.logical_path(item)
                    elif path.is_absolute() and path.is_relative_to(self.sessions):
                        item = None if key in {"workingPath", "working_path"} else (
                            "/workspace/.office/" + path.relative_to(self.sessions).as_posix())
                    elif key in {"workingPath", "working_path", "sourcePath", "source_path", "absolute_path"} and path.is_absolute():
                        raise _invalid_path()
                result[key] = self.public_value(item)
            return result
        if isinstance(value, list):
            return [self.public_value(item) for item in value]
        if isinstance(value, str):
            return self.scrub_text(value)
        return value

    def tool_result(self, result: Any) -> Any:
        if isinstance(result, str):
            try:
                return json.dumps(self.public_value(json.loads(result)), ensure_ascii=False)
            except ValueError:
                return self.scrub_text(result)
        if isinstance(result, list):
            return [{**item, "text": self.tool_result(item["text"])}
                    if isinstance(item, dict) and item.get("type") == "text" else self.public_value(item) for item in result]
        return result


async def _read_response(response: httpx.Response, limit: int) -> bytes:
    chunks, total = [], 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > limit:
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "编辑器返回内容超过大小限制。")
        chunks.append(chunk)
    return b"".join(chunks)


class _OfficeTransport(httpx.AsyncBaseTransport):
    def __init__(self, scope: _EditorScope):
        self.scope = scope

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        scope = self.scope
        base = httpx.URL(scope.endpoint)
        if (request.url.scheme != base.scheme or request.url.host != base.host or request.url.port != base.port
                or request.url.username or request.url.password or request.url.query
                or not _OFFICE_ROUTE.fullmatch(request.url.path)
                or request.headers.get(OFFICE_OWNER_HEADER) != scope.session_key):
            raise _invalid_path()
        body = await request.aread()
        if len(body) > scope.limit:
            raise _invalid_path()
        if body:
            try:
                payload = json.loads(body)
            except ValueError:
                raise _invalid_path() from None
            if not isinstance(payload, dict):
                raise _invalid_path()
            for key in ("path", "output"):
                if payload.get(key) is not None:
                    payload[key] = scope.logical_path(payload[key])
            if "ownerSessionKey" in payload and payload["ownerSessionKey"] != scope.session_key:
                raise _invalid_path()
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        headers = httpx.Headers(request.headers)
        for key in ("X-Mona-Token", "Content-Length", "Transfer-Encoding"):
            headers.pop(key, None)
        headers.update({"Authorization": "Bearer " + scope.token, "Host": urlsplit(scope.origin).netloc,
                        "Origin": scope.origin})
        forwarded = httpx.Request(request.method, request.url, headers=headers, content=body)
        async with httpx.AsyncHTTPTransport(trust_env=False) as transport:
            response = await transport.handle_async_request(forwarded)
            try:
                data = await _read_response(response, scope.limit)
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                if "application/json" in content_type:
                    payload = json.loads(data)
                    if response.status_code >= 400 and not isinstance(payload.get("error"), dict):
                        payload = {"error": {"code": OfficeErrorCode.EDITOR_UNAVAILABLE,
                                             "message": "文档服务暂不可用，请核对登录状态后重试。",
                                             "retryable": response.status_code >= 500}}
                    data = json.dumps(scope.public_value(payload), ensure_ascii=False).encode()
                return httpx.Response(response.status_code, content=data,
                                      headers={"Content-Type": content_type, "Cache-Control": "no-store"},
                                      request=request)
            finally:
                await response.aclose()


class _RendererInvoker:
    def __init__(self, scope: _EditorScope):
        self.scope = scope

    async def __call__(self, command: str, args: dict[str, Any]):
        if command not in {"canvas_activate_sidebar", "canvas_agent_request"}:
            raise RuntimeError("画布操作不在当前工作台授权范围内。")
        scope = self.scope
        arguments = dict(args)
        if arguments.get("path") is not None:
            arguments["path"] = scope.logical_path(arguments["path"])
        body = {"run_id": scope.run_id, "session_id": scope.session_id, "command": command, "args": arguments}
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=35) as client:
                async with client.stream("POST", scope.endpoint + "/api/work/desktop/internal/tool", json=body,
                                         headers={"Authorization": "Bearer " + scope.token,
                                                  "Host": urlsplit(scope.origin).netloc, "Origin": scope.origin}) as response:
                    data = await _read_response(response, scope.limit)
                    if response.status_code != 200 or not response.headers.get("Content-Type", "").startswith("application/json"):
                        raise ValueError("invalid renderer response")
            value = json.loads(data)
            if not isinstance(value, dict) or "result" not in value:
                raise ValueError("missing renderer result")
            return value["result"]
        except (httpx.HTTPError, ValueError, OfficeError):
            raise RuntimeError("画布操作结果尚未确认，请核对当前画布后继续。") from None


class _EditorBus:
    def __init__(self, scope: _EditorScope, emit: Emit):
        self.scope, self.emit = scope, emit
        self.delivered: dict[str, tuple[int, str]] = {}
        self.expected_delivery: dict[str, tuple[int, str]] | None = None

    async def publish_outbound(self, message: OutboundMessage):
        scope = self.scope
        if message.channel != "websocket" or message.chat_id != scope.session_id:
            raise _invalid_path()
        metadata = message.metadata
        if OUTBOUND_META_AGENT_UI in metadata:
            await self.emit("desktop", scope.public_value({"event": "message", "chat_id": scope.session_id,
                "task_id": scope.run_id, "text": message.content, "kind": "progress",
                "agent_ui": metadata[OUTBOUND_META_AGENT_UI]}))
        if metadata.get("_deliver_files"):
            files, verified = [], {}
            for item in metadata["_deliver_files"]:
                path = scope.host_path(item.get("absolute_path") or item.get("path"))
                digest, info = TenantFiles._file_digest(path, scope.file_limit)
                logical = scope.logical_path(str(path))
                verified[logical] = (info.st_size, digest)
                if self.expected_delivery is not None and self.expected_delivery.get(logical) != verified[logical]:
                    raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "已交付文件发生变化，请重新导出后再交付。")
                if self.delivered.get(logical) != verified[logical]:
                    files.append({**item, "size": info.st_size, "sha256": digest})
            if files:
                await self.emit("desktop", scope.public_value({"event": "deliver_files", "chat_id": scope.session_id,
                    "files": files}))
            self.delivered.update(verified)


class _HostedCanvasTool(CanvasTool):
    def __init__(self, scope: _EditorScope):
        self.scope = scope
        super().__init__(workspace=scope.root, invoke=_RendererInvoker(scope))

    def _active_workspace(self) -> Path:
        return self.scope.root

    def set_context(self, ctx: RequestContext):
        context = self.scope.context(ctx)
        directory = self.scope.host_path("/workspace/canvases")
        if directory.is_dir():
            for path in directory.glob("*.mona-canvas"):
                self.scope.host_path(str(path))
        super().set_context(context)

    async def execute(self, action: str, **kwargs):
        try:
            for key in ("path", "patch_path", "output"):
                if kwargs.get(key) is not None:
                    kwargs[key] = str(self.scope.host_path(kwargs[key]))
            return self.scope.tool_result(await super().execute(action, **kwargs))
        except OfficeError as error:
            return _failure(error)


class _HostedOfficeTool(OfficeTool):
    def __init__(self, scope: _EditorScope, emit: Emit, sandbox=None):
        self.scope, self.sandbox = scope, sandbox
        bus = _EditorBus(scope, emit)
        self._delivery_bus = bus
        self._delivery = DeliverFileTool(send_callback=bus.publish_outbound, workspace=scope.root,
                                        restrict_to_workspace=True)
        client = OfficeServiceClient(scope.endpoint + "/api/work/desktop", token="hosted-editor-transport",
                                     transport=_OfficeTransport(scope))
        super().__init__(workspace=scope.root, config=OfficeToolConfig(restrict_to_workspace=True),
                         restrict_to_workspace=True, bus=bus, service_client=client)

    def _active_workspace(self) -> Path:
        return self.scope.root

    def set_context(self, ctx: RequestContext):
        context = self.scope.context(ctx)
        super().set_context(context)
        self._delivery.set_context(context)

    async def deliver_existing_file(self, path: str) -> str | None:
        """Reuse desktop delivery for an existing document; sandbox files keep their own lifecycle."""
        try:
            target = self.scope.host_path(path)
            expected = self._delivery_bus.delivered.get(self.scope.logical_path(str(target)))
            if expected is None:
                return None
            digest, info = TenantFiles._file_digest(target, self.scope.file_limit)
            if (info.st_size, digest) != expected:
                raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "已交付文件发生变化，请重新导出当前文稿后再交付。")
            workspace_token = set_current_workspace(self.scope.root)
            self._delivery_bus.expected_delivery = {self.scope.logical_path(str(target)): expected}
            try:
                return self.scope.tool_result(await self._delivery.execute(paths=[str(target)]))
            finally:
                self._delivery_bus.expected_delivery = None
                reset_current_workspace(workspace_token)
        except OfficeError as error:
            return _failure(error)
        except (OSError, WorkError):
            return _failure(OfficeError(OfficeErrorCode.INVALID_OPERATION, "已交付文件无法读取，请核对后重新导出。"))

    async def _asset(self, value: object) -> tuple[str, str]:
        """Read a workspace image from this run's sandbox or the existing document workspace."""
        target = self.scope.host_path(value)
        if self.sandbox is None:
            return "assetPath", str(target)
        if isinstance(value, str) and not value.startswith("/workspace/") and Path(value).is_absolute():
            return "assetPath", str(target)
        logical = self.scope.logical_path(value)
        try:
            path = relative_path(logical)
        except (TypeError, ValueError):
            raise _invalid_path() from None
        mime = _IMAGE_EXT_TO_MIME.get(PurePosixPath(path).suffix.lower())
        if mime is None:
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "图片格式不受支持。")
        try:
            image = await self.sandbox.file({"action": "download", "path": path})
        except WorkError as error:
            if error.code == "file_not_found":
                # Files already managed by Office live in the account's
                # documents directory, and keep the existing desktop handling.
                return "assetPath", str(target)
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "图片无法读取，请核对工作区文件。") from None
        try:
            if (not isinstance(image, dict) or image.get("path") != path
                    or image.get("name") != PurePosixPath(path).name
                    or type(image.get("size")) is not int or image["size"] < 0
                    or image["size"] > min(self.scope.file_limit, _MAX_IMAGE_BYTES)
                    or not isinstance(image.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", image["sha256"])
                    or not isinstance(image.get("data"), str)
                    or len(image["data"]) > 4 * ((min(self.scope.file_limit, _MAX_IMAGE_BYTES) + 2) // 3)):
                raise ValueError("invalid sandbox image")
            raw = base64.b64decode(image["data"], validate=True)
            if len(raw) != image["size"] or hashlib.sha256(raw).hexdigest() != image["sha256"]:
                raise ValueError("sandbox image changed")
        except (ValueError, TypeError, binascii.Error):
            raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "图片未通过校验，请检查后重试。") from None
        return "dataUrl", f"data:{mime};base64,{image['data']}"

    def _assets(self, value):
        if isinstance(value, dict):
            return {key: str(self.scope.host_path(item)) if key == "assetPath" else self._assets(item)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [self._assets(item) for item in value]
        return value

    async def _sandbox_assets(self, value: dict) -> dict:
        """Translate the same slide image slots handled by the shared Office tool."""
        value = copy.deepcopy(value)
        total = 0

        async def convert(item):
            nonlocal total
            if not isinstance(item, dict) or "assetPath" not in item:
                return
            key, result = await self._asset(item["assetPath"])
            if key == "dataUrl":
                total += len(result)
                if total > self.scope.limit:
                    raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "图片总大小超过文档操作上限。")
                item.pop("assetPath")
            item[key] = result

        async def preset(content):
            if not isinstance(content, dict):
                return
            await convert(content.get("image"))
            if isinstance(content.get("images"), list):
                for item in content["images"]:
                    await convert(item)

        operations = value.get("operations")
        if isinstance(operations, list):
            for operation in operations:
                if not isinstance(operation, dict) or not isinstance(operation.get("payload"), dict):
                    continue
                op, payload = operation.get("op"), operation["payload"]
                if op == "slide_add_image":
                    await convert(payload)
                elif op in {"slide_compose", "slide_add"}:
                    content = payload if op == "slide_compose" else payload.get("content")
                    if isinstance(content, dict) and isinstance(content.get("items"), list):
                        for item in content["items"]:
                            if isinstance(item, dict) and item.get("type") == "image":
                                await convert(item)
                elif op in {"slide_add_preset", "slide_add_design"}:
                    await preset(payload.get("content"))
        query = value.get("query")
        if isinstance(query, dict):
            await preset(query.get("presetContent"))
        return value

    async def execute(self, action: str, **kwargs):
        try:
            if action not in _OFFICE_ACTIONS:
                raise OfficeError(OfficeErrorCode.INVALID_OPERATION, "线上 Office 仅使用实时文档编辑接口。")
            query = kwargs.get("query")
            if action == "inspect" and isinstance(query, dict) and kwargs.get("mode") == query.get("mode"):
                kwargs.pop("mode", None)
            if any(key not in self.parameters["properties"] for key in kwargs):
                raise OfficeError(OfficeErrorCode.INVALID_OPERATION,
                                  "Office 操作参数无效。查询模式只放在 query.mode，不要传顶层 mode；其他参数须符合工具定义。")
            if kwargs.get("session_id") is not None and not _EDITOR_ID.fullmatch(kwargs["session_id"]):
                raise _invalid_path()
            for key in ("path", "output"):
                if kwargs.get(key) is not None:
                    kwargs[key] = str(self.scope.host_path(kwargs[key]))
            if self.sandbox is not None:
                kwargs = await self._sandbox_assets(kwargs)
            kwargs = self._assets(kwargs)
            return self.scope.tool_result(await super().execute(action, **kwargs))
        except OfficeError as error:
            return _failure(error)
        except (httpx.HTTPError, ValueError, OSError):
            return _failure(OfficeError(OfficeErrorCode.EDITOR_UNAVAILABLE,
                                       "文档操作未能确认，请核对原文档后重试。", retryable=True))


def build_editor_tools(config: HostedWorkConfig, payload: dict, emit: Emit, *, sandbox=None) -> tuple[CanvasTool, OfficeTool]:
    owner = payload.get("owner")
    if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
        raise WorkError("invalid_identity", "登录身份无效，请重新登录。", 401)
    session_id, run_id = identifier(payload.get("session_id")), identifier(payload.get("run_id"))
    if sandbox is not None and (getattr(sandbox, "owner", None), getattr(sandbox, "run_id", None)) != (owner, run_id):
        raise WorkError("invalid_identity", "工作区不属于当前任务。", 403)
    token = payload.get("account_token")
    if not isinstance(token, str) or not token or len(token) > 8192 or not re.fullmatch(r"[\x21-\x7e]+", token):
        raise WorkError("login_required", "请重新登录后执行文档操作。", 401)
    state = Path(config.state_dir).expanduser()
    if not state.is_absolute() or state.is_symlink():
        raise WorkError("invalid_state", "文档工作空间不可用。", 503)
    root = private_directory(state)
    for part in ("users", owner, "documents"):
        candidate = root / part
        if candidate.is_symlink() or bool(getattr(candidate, "is_junction", lambda: False)()):
            raise WorkError("invalid_state", "文档工作空间不可用。", 503)
        root = private_directory(candidate)
    host = private_listener(config.bind_host)
    scope = _EditorScope(root, state.resolve() / "users" / owner / "office" / session_id / "sessions",
                         owner, run_id, session_id, f"http://{'[' + host + ']' if ':' in host else host}:{config.port}",
                         website_origin(config), 2 * config.max_file_bytes + 65536, config.max_file_bytes, token)
    tools = (_HostedCanvasTool(scope), _HostedOfficeTool(scope, emit, sandbox))
    context = RequestContext(channel="websocket", chat_id=session_id, session_key=scope.session_key,
                             metadata=payload.get("metadata") or {})
    for tool in tools:
        tool.set_context(context)
    return tools
