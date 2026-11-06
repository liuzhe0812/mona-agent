"""Authenticated HTTP adapters for the unchanged desktop conversation components."""
from __future__ import annotations

import hashlib
import inspect
import mimetypes
import os
import re
import secrets
import sqlite3
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from aiohttp import web
from filelock import FileLock

from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.desktop_store import DesktopStore, chat_id, request_id, timestamp
from mona.hosted_work.model_policy import model_available
from mona.hosted_work.tenant_files import TenantFiles
from mona.hosted_work.tenant_office import OFFICE_PREFIX, TenantOffice
from mona.hosted_work.tenant_xlsx import SandboxedXlsxEngineFactory

PREFIX = "/api/work/desktop"
_OWNER = re.compile(r"^[a-f0-9]{64}$")
_MEDIA = re.compile(r"^" + PREFIX + r"/media/([A-Za-z0-9_-]{32,128})$")
_SESSION = re.compile(r"^/api/sessions/([^/]+)/(webui-thread|delete|clear-workspace|set-workspace)$")


def _mime(name: str) -> str:
    if Path(name).suffix.lower() == ".webp":
        return "image/webp"
    if Path(name).suffix.lower() in {".html", ".htm", ".xhtml", ".js", ".mjs", ".cjs"}:
        return "text/plain"
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _size(value: int) -> str:
    return f"{value / 1024 / 1024:.1f} MB" if value >= 1024 * 1024 else f"{value / 1024:.1f} KB" if value >= 1024 else f"{value} B"


@dataclass(frozen=True)
class _FileTicket:
    owner: str
    token: str
    session: str
    path: str
    digest: str
    expires: float


class DesktopAPI:
    def __init__(self, service):
        self.service = service
        self.files = TenantFiles(service.config, service.store.session)
        self.state = DesktopStore(service, self.files)
        self.xlsx = SandboxedXlsxEngineFactory(service.config, self.files.root)
        self.office = TenantOffice(service.config, authorize_session=self.state.session,
                                   identity=service.auth.identity, workspace_for_owner=self.files.root,
                                   engine_factory=self.xlsx)
        self._wire = None
        self.tool_handler = None
        self.platform_handler = None
        self._file_tickets: dict[str, _FileTicket] = {}
        from mona.hosted_work.inputs import HostedInputs
        from mona.hosted_work.previews import QuestionPreviews
        from mona.hosted_work.questions import HostedQuestions
        from mona.hosted_work.steering_attachments import SteeringAttachments

        self.previews = QuestionPreviews(service.config, self.state, self.files)
        self.questions = HostedQuestions(service.store, self._question_event)
        self.inputs = HostedInputs(self.state, emit=self._question_event)
        self.steering = SteeringAttachments(self)

    async def _question_event(self, owner: str, sid: str, frame: dict):
        await self.wire.emit_to_chat(owner, sid, frame)

    @property
    def wire(self):
        if self._wire is None:
            from mona.hosted_work.desktop_wire import DesktopWire

            self._wire = DesktopWire(self.service, self.state, self)
        return self._wire

    @staticmethod
    def is_socket(request: web.Request) -> bool:
        return request.method == "GET" and (request.path == PREFIX + "/ws" or TenantOffice.is_socket(request))

    @staticmethod
    def is_file_ticket(request: web.Request) -> bool:
        return request.method == "GET" and _MEDIA.fullmatch(request.path) is not None

    async def socket(self, request: web.Request):
        return await self.office.handle(request) if TenantOffice.is_socket(request) else await self.wire.handle_socket(request)

    async def close(self):
        self._file_tickets.clear()
        try:
            await self.questions.close()
            if self._wire is not None:
                await self._wire.close()
        finally:
            try:
                await self.office.close()
            finally:
                self.state.close()

    async def restore_editors(self, owner: str, sid: str):
        return await self.office.list_states(owner, sid)

    @staticmethod
    def _owner(request: web.Request) -> str:
        owner = request.get("owner", "")
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        return owner

    def _session(self, owner: str, value: str | None) -> str:
        if not isinstance(value, str):
            raise WorkError("invalid_request", "请先选择会话。")
        sid = chat_id(value)
        self.state.session(owner, sid)
        return sid

    def _logical(self, owner: str, raw: object) -> tuple[Path, str]:
        if isinstance(raw, str) and not raw.startswith("/"):
            raw = "/workspace/" + raw
        root = self.files.root(owner)
        checked = self.files._path(root, raw)
        return checked, self.files._logical(root, checked)

    @staticmethod
    def _body(value: object, allowed: set[str]) -> dict:
        if not isinstance(value, dict) or set(value) - allowed:
            raise WorkError("invalid_request", "请求内容无效。")
        return value

    def settings(self, owner: str) -> dict:
        models = {key: model for key, model in self.service.config.models.items() if model_available(model)}
        selected = self.state.model(owner)
        selection = models.get(selected)
        max_tokens = selection.max_output_tokens if selection else 4096
        from mona.hosted_work.model_access import model_context_window
        window = model_context_window(selection) if selection else None
        context = window.tokens if window else 1_000_000
        effort = selection.reasoning_effort if selection else None
        configured = bool(models)
        rows = [{"id": key, "name": item.label, "type": "chat", "enabled": True,
                 "recommended": index == 0, "context_window": None, "billing_type": "token"}
                for index, (key, item) in enumerate(models.items())]
        agent = {"model": selected, "provider": "mona_managed", "resolved_provider": "mona_managed",
                 "executor": "mona", "model_preset": None, "has_api_key": configured,
                 "max_tokens": max_tokens, "context_window_tokens": context, "context_window_source": window.source if window else "default",
                 "auto_compact_token_limit": None, "temperature": 0.7, "reasoning_effort": effort,
                 "timezone": "UTC", "tool_hint_max_length": 120}
        preset = {"name": "default", "label": "默认模型", "active": True, "is_default": True,
                  "model": selected, "provider": "mona_managed", "max_tokens": max_tokens,
                  "context_window_tokens": context, "auto_compact_token_limit": None, "temperature": 0.7,
                  "reasoning_effort": effort, "capabilities": {"supports_vision": False,
                    "supports_tool_calling": True, "supports_streaming": True, "supports_json_mode": None}}
        return {"agent": agent, "model_presets": [preset],
                "providers": [{"name": "mona_managed", "label": "Mona AI", "configured": configured,
                               "api_key_required": False, "model": selected}],
                "chat_providers": [{"name": "mona_managed", "label": "Mona AI", "source_group": "mona",
                    "configured": configured, "is_builtin": True, "api_key_required": False,
                    "api_base": "", "default_api_base": "", "api_base_editable": False,
                    "models_url": None, "model": selected, "models": rows}],
                "web_search": {"provider": "", "providers": [], "max_results": 0, "timeout": 0},
                "web": {"enable": True, "search": {"max_results": 0, "timeout": 0}},
                "jev": {"configured": False, "api_base": "", "model": "", "timeout_seconds": 0},
                "browser": {"use_jev": False, "jev_ready": False},
                "computer_use": {"use_decision_model": False, "vision_model_preset": None, "max_steps": 0,
                    "max_duration_seconds": 0, "decision_model_ready": False, "vision_model_options": []},
                "image_generation": {"enabled": False, "provider": "", "model": "", "provider_configured": False,
                    "default_aspect_ratio": "1:1", "default_image_size": "1K", "max_images_per_turn": 0,
                    "model_parameters": {}, "providers": [], "save_dir": "/workspace"},
                "video_generation": {"enabled": False, "provider": "", "model": "", "provider_configured": False,
                    "default_aspect_ratio": "16:9", "default_duration": 0, "model_parameters": {},
                    "providers": [], "save_dir": "/workspace"},
                "runtime": {"config_path": "", "workspace_path": "/workspace", "gateway_host": "",
                    "gateway_port": 0, "auto_download": False, "unified_session": False,
                    "heartbeat": {"enabled": False, "interval_s": 0, "keep_recent_messages": 0},
                    "dream": {"schedule": "", "max_batch_size": 0, "max_iterations": 0}},
                "advanced": {"restrict_to_workspace": True, "ssrf_whitelist_count": 0, "mcp_server_count": 0,
                    "exec_enabled": True, "exec_sandbox": "gvisor", "exec_path_append_set": False},
                "channels": {"available": []}, "tts": {"provider": "", "voice": "", "api_base": None,
                    "model": None, "api_key_configured": False, "api_key_hint": None},
                "requires_restart": False, "restart_required_sections": []}

    def _file_row(self, logical: str, *, size: int, modified: float | None = None, directory: bool = False,
                  sha256: str | None = None):
        return {"path": logical.removeprefix("/workspace/"), "absolute_path": logical,
                "name": logical.rsplit("/", 1)[-1], "size": size, "size_human": _size(size),
                "mime": "inode/directory" if directory else _mime(logical), "is_dir": directory,
                **({"sha256": sha256} if sha256 is not None else {}),
                **({"modified_at": timestamp(modified)} if modified is not None else {})}

    def inventory(self, owner: str, sid: str, *, task_id: str | None = None) -> dict:
        self.state.session(owner, sid)
        root = self.files.root(owner)
        rows: dict[str, dict] = {}
        for index, path in enumerate(root.rglob("*")):
            if index >= 2048:
                raise WorkError("file_limit", "工作区文件数量超过允许范围。", 413)
            checked = self.files._path(root, self.files._logical(root, path))
            info = checked.lstat()
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise WorkError("invalid_path", "工作区包含不支持的文件。")
            digest = None
            if stat.S_ISREG(info.st_mode):
                digest, info = self.files._file_digest(checked, self.service.config.workspace_bytes)
            logical = self.files._logical(root, checked)
            rows[logical] = self._file_row(logical, size=info.st_size if stat.S_ISREG(info.st_mode) else 0,
                                           modified=info.st_mtime, directory=stat.S_ISDIR(info.st_mode), sha256=digest)
        for item in self.service.store.files(owner, sid):
            stored = self.service.store.file(owner, sid, item["id"])
            _, logical = self._logical(owner, stored["path"])
            row = rows.get(logical) or self._file_row(logical, size=stored["size"], sha256=stored["sha256"])
            rows.setdefault(logical, row)
        recorded = self.state.get(owner, "artifact_index:" + sid, [])
        if not isinstance(recorded, list) or not all(isinstance(item, dict) for item in recorded):
            raise WorkError("invalid_state", "文件记录无法读取，请联系管理员。", 503)
        delivered: dict[str, dict] = {}
        working: dict[str, dict] = {}
        for item in recorded:
            _, logical = self._logical(owner, item.get("path"))
            row = rows.get(logical)
            if row is None or row["is_dir"]:
                continue
            if item.get("delivered") is True:
                delivered[logical] = row
            elif item.get("delivered") is False and task_id and item.get("task_id") == task_id:
                working[logical] = row
        return {"files": sorted(rows.values(), key=lambda row: (not row["is_dir"], row["path"])),
                "session_files": list(delivered.values()),
                "task_files": [row for logical, row in working.items() if logical not in delivered],
                "task_id": task_id, "truncated": False}

    async def read_file(self, owner: str, sid: str, raw: str, artifact_id: str | None = None) -> tuple[str, bytes]:
        self.state.session(owner, sid)
        if self.previews.handles(raw):
            if artifact_id:
                raise WorkError("not_found", "未找到该文件。", 404)
            return self.previews.read(owner, sid, raw)
        path, logical = self._logical(owner, raw)
        if artifact_id:
            stored = self.service.store.file(owner, sid, identifier(artifact_id))
            if self._logical(owner, stored["path"])[1] != logical:
                raise WorkError("not_found", "未找到该文件。", 404)
            return await self.service.download(owner, sid, stored["id"])
        try:
            path.lstat()
        except FileNotFoundError:
            for item in self.service.store.files(owner, sid):
                stored = self.service.store.file(owner, sid, item["id"])
                if self._logical(owner, stored["path"])[1] == logical:
                    return await self.service.download(owner, sid, stored["id"])
            raise WorkError("not_found", "未找到该文件。", 404) from None
        return path.name, self.files._read_bytes(path, self.service.config.max_file_bytes)

    def media_url(self, owner: str, token: str, sid: str, raw: str) -> str:
        self.state.session(owner, sid)
        if not token or len(token) > 8192:
            raise WorkError("login_required", "请重新登录。", 401)
        if self.previews.handles(raw):
            _, data = self.previews.read(owner, sid, raw)
            digest = hashlib.sha256(data).hexdigest()
            logical = raw if raw.startswith("/") else "/workspace/" + raw
        else:
            path, logical = self._logical(owner, raw)
            try:
                path.lstat()
            except FileNotFoundError:
                stored = next((self.service.store.file(owner, sid, item["id"])
                               for item in self.service.store.files(owner, sid)
                               if self._logical(owner, self.service.store.file(owner, sid, item["id"])["path"])[1] == logical), None)
                if stored is None:
                    raise WorkError("not_found", "未找到该文件。", 404) from None
                digest = stored["sha256"]
            else:
                digest, _ = self.files._file_digest(path, self.service.config.max_file_bytes)
        now = time.monotonic()
        self._file_tickets = {key: value for key, value in self._file_tickets.items() if value.expires > now}
        if len(self._file_tickets) >= 2048:
            raise WorkError("request_capacity", "文件读取较多，请稍后重试。", 429)
        ticket = secrets.token_urlsafe(32)
        self._file_tickets[ticket] = _FileTicket(owner, token, sid, logical, digest, now + 60)
        return self.service.config.public_origin.rstrip("/") + PREFIX + "/media/" + ticket

    def history_media(self, owner: str, token: str, sid: str, paths: list[str]):
        media = []
        for path in paths:
            try:
                mime = _mime(path)
                if mime.startswith(("image/", "video/")):
                    media.append({"kind": "image" if mime.startswith("image/") else "video",
                                  "url": self.media_url(owner, token, sid, path), "name": Path(path).name})
            except WorkError:
                continue  # A missing preview is not replaced with another account's file.
        return media

    @staticmethod
    def _file_response(name: str, data: bytes, *, download: bool = False):
        return web.Response(body=data, content_type=_mime(name), headers={
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
            "Content-Disposition": ("attachment" if download else "inline") + "; filename*=UTF-8''" + quote(name, safe=""),
        })

    async def file_ticket(self, request: web.Request):
        match = _MEDIA.fullmatch(request.path)
        binding = self._file_tickets.get(match[1]) if match else None
        if binding is None or binding.expires <= time.monotonic():
            raise WorkError("login_required", "文件链接已过期，请重新打开文件。", 401)
        if await self.service.auth.identity(binding.token) != binding.owner:
            raise WorkError("login_required", "文件链接已失效，请重新登录。", 401)
        supplied = request.headers.get("Authorization", "")
        if supplied and (not supplied.startswith("Bearer ")
                         or await self.service.auth.identity(supplied[7:]) != binding.owner):
            raise WorkError("not_found", "未找到该文件。", 404)
        name, data = await self.read_file(binding.owner, binding.session, binding.path)
        if hashlib.sha256(data).hexdigest() != binding.digest:
            raise WorkError("file_changed", "文件已变化，请重新打开文件。", 409)
        return self._file_response(name, data)

    async def prepared_attachments(self, owner: str, sid: str, frame: dict) -> list[str]:
        self.state.session(owner, sid)
        if frame.get("media"):
            raise WorkError("unsupported_media", "当前工作台未开放这种图片输入，请作为文件附件上传。")
        paths = frame.get("doc_paths", [])
        if not isinstance(paths, list) or len(paths) > 8 or not all(isinstance(item, str) for item in paths):
            raise WorkError("invalid_request", "附件信息无效。")
        if not paths:
            return []
        input_id = frame.get("input_id")
        if not isinstance(input_id, str) or not input_id or len(input_id) > 200:
            raise WorkError("invalid_request", "发送请求标识无效。")
        result = []
        for raw in dict.fromkeys(paths):
            path, logical = self._logical(owner, raw)
            metadata = self.state.get(owner, "upload:" + logical)
            if not isinstance(metadata, dict) or metadata.get("path") != logical or metadata.get("name") != path.name:
                raise WorkError("not_found", "附件尚未上传或不属于当前账号。", 404)
            data = self.files._read_bytes(path, self.service.config.max_file_bytes)
            digest = hashlib.sha256(data).hexdigest()
            if len(data) != metadata.get("size") or digest != metadata.get("sha256"):
                raise WorkError("file_changed", "附件已变化，请重新上传后发送。", 409)
            fingerprint = hashlib.sha256((logical + ":" + digest).encode()).hexdigest()
            fid = request_id(fingerprint, "attachment:" + sid + ":" + input_id)
            try:
                previous = self.service.store.file(owner, sid, fid)
            except WorkError as error:
                if error.status != 404:
                    raise
                await self.service.upload(owner, sid, fid, path.name, data)
            else:
                if previous["size"] != len(data) or previous["sha256"] != digest:
                    raise WorkError("file_changed", "附件记录已变化，请重新上传。", 409)
            result.append(fid)
        return result

    prepare_attachments = prepared_attachments

    async def handle(self, request: web.Request):
        try:
            return await self._handle(request)
        except WorkError as error:
            return web.json_response({"error": {"code": error.code, "message": error.message}, "code": error.code},
                                     status=error.status, headers={"Cache-Control": "no-store"})

    async def _handle(self, request: web.Request):
        owner = self._owner(request)
        if request.path.startswith(OFFICE_PREFIX + "/"):
            return await self.office.handle(request)
        if not request.path.startswith(PREFIX + "/"):
            raise web.HTTPNotFound()
        path = request.path[len(PREFIX):]
        method = request.method
        if path == "/socket-ticket" and method == "POST":
            body = self._body(await request.json(), {"client_id"}) if request.can_read_body else {}
            return web.json_response(self.wire.issue_ticket(owner, request["account_token"], body.get("client_id")))
        if path == "/platform/invoke" and method == "POST":
            body = self._body(await request.json(), {"command", "args"})
            if not isinstance(body.get("command"), str):
                raise WorkError("invalid_request", "操作名称无效。")
            if body["command"] == "move_to_trash" and (not isinstance(body.get("args"), dict)
                    or not isinstance(body["args"].get("expectedSha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", body["args"]["expectedSha256"])):
                raise WorkError("file_version_required", "请刷新文件列表后再删除文件。", 409)
            if body.get("command") in {"canvas_agent_respond", "canvas_agent_stage"}:
                if self.platform_handler is None:
                    raise WorkError("not_connected", "画布连接尚未就绪，请重新打开画布。", 503)
                args = body.get("args", {})
                if not isinstance(args, dict):
                    raise WorkError("invalid_request", "请求内容无效。")
                result = self.platform_handler(owner, body["command"], args)
                if inspect.isawaitable(result):
                    result = await result
                return web.json_response(result)
            if body["command"] == "move_to_trash":
                return web.json_response(await self._trash(owner, body.get("args", {})))
            return web.json_response(self.files.invoke(owner, body.get("command"), body.get("args", {})))
        if path == "/internal/tool" and method == "POST":
            if self.tool_handler is None:
                raise WorkError("unsupported_operation", "此操作尚未接入。", 501)
            result = self.tool_handler(request)
            if inspect.isawaitable(result):
                result = await result
            return result if isinstance(result, web.StreamResponse) else web.json_response(result)
        if path == "/api/settings" and method == "GET":
            return web.json_response(self.settings(owner))
        if path == "/api/development/provider-executors" and method == "GET":
            return web.json_response({"executors": []})
        if path == "/api/development/work-model-source" and method == "PUT":
            body = self._body(await request.json(), {"executor", "provider", "model", "effort"})
            if body.get("executor") != "mona" or body.get("provider") is not None and body["provider"] != "mona_managed":
                raise WorkError("invalid_model", "请选择已开放的平台模型。")
            model = body.get("model")
            if not isinstance(model, str) or model not in self.service.config.models:
                raise WorkError("invalid_model", "此模型未开放。")
            effort = body.get("effort")
            if effort is not None and (not isinstance(effort, str) or effort != self.service.config.models[model].reasoning_effort):
                raise WorkError("invalid_model", "此模型未开放所选思考强度。")
            self.state.set_model(owner, model)
            return web.json_response(self.settings(owner))
        if path == "/api/sessions" and method == "GET":
            return web.json_response({"sessions": self.state.summaries(owner)})
        session = _SESSION.fullmatch(path)
        if session:
            sid = self._session(owner, session[1])
            action = session[2]
            if action == "webui-thread" and method == "GET":
                try:
                    limit = int(request.query.get("limit", "80"))
                    before = int(request.query["before"]) if "before" in request.query else None
                except ValueError:
                    raise WorkError("invalid_cursor", "历史位置无效。") from None
                return web.json_response(self.state.history(owner, sid, limit=limit, before=before, revision=request.query.get("revision"),
                    augment_user_media=lambda paths: self.history_media(owner, request["account_token"], sid, paths)))
            if action == "delete" and method == "GET":
                self.state.delete(owner, sid)
                return web.json_response({"deleted": True})
            if action == "clear-workspace" and method == "POST":
                return web.json_response({"ok": True, "workspace": None})
            raise WorkError("unsupported_operation", "线上工作台使用当前账号的隔离工作区。", 501)
        if path == "/api/webui/sidebar-state" and method == "GET":
            return web.json_response(self.state.sidebar(owner))
        if path == "/api/webui/sidebar-state/update" and method == "POST":
            return web.json_response(self.state.update_sidebar(owner, await request.json()))
        if path == "/api/commands" and method == "GET":
            return web.json_response({"commands": []})
        if path == "/api/agents" and method == "GET":
            return web.json_response({"agents": [{"id": "mona", "displayName": "Mona", "enabled": True,
                "visibility": "public", "description": "线上工作台助手"}]})
        if path in {"/api/artifacts", "/api/project-files"} and method == "GET":
            if request.query.get("room"):
                raise WorkError("unsupported_operation", "当前工作台未开放协作房间。", 501)
            sid = self._session(owner, request.query.get("session_key") or request.query.get("key"))
            return web.json_response(self.inventory(owner, sid, task_id=request.query.get("task_id")))
        if path == "/api/file-preview" and method == "GET":
            if request.query.get("scope", "shared") not in {"shared", "project"} or request.query.get("room"):
                raise WorkError("unsupported_operation", "此文件范围不可用。", 501)
            sid = self._session(owner, request.query.get("session_key"))
            name, data = await self.read_file(owner, sid, request.query.get("path", ""), request.query.get("artifact_id"))
            return self._file_response(name, data, download=request.query.get("download") == "1")
        if path == "/api/artifact-rename" and method == "GET":
            return web.json_response(await self._rename(owner, request.query))
        raise WorkError("unsupported_operation", "线上工作台未开放此功能。", 501)

    def _renamed_metadata(self, owner: str, logical: str, new_logical: str, name: str) -> dict:
        updates = {}
        old_paths = {logical, logical.removeprefix("/workspace/")}
        keys = self.state.db(owner).execute("SELECT key FROM metadata WHERE key GLOB 'artifact_index:*'").fetchall()
        for row in keys:
            records = self.state.get(owner, row["key"])
            if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
                raise WorkError("invalid_state", "文件记录无法读取，请联系管理员。", 503)
            renamed = []
            for item in records:
                if item.get("path") not in old_paths:
                    renamed.append(item)
                    continue
                value = {**item, "path": new_logical.removeprefix("/workspace/")}
                if "name" in value:
                    value["name"] = name
                if isinstance(item.get("file"), dict):
                    value["file"] = {**item["file"], "path": new_logical, "absolute_path": new_logical, "name": name}
                renamed.append(value)
            if renamed != records:
                updates[row["key"]] = renamed
        uploaded = self.state.get(owner, "upload:" + logical)
        if isinstance(uploaded, dict):
            updates["upload:" + new_logical] = {**uploaded, "path": new_logical, "name": name}
            updates["upload:" + logical] = None
        return updates

    def _saved_file(self, owner: str, logical: str, digest: str | None = None) -> dict:
        rows = self.service.store.db.execute(
            "SELECT id,session_id,sha256 FROM files WHERE owner=? AND path=? ORDER BY rowid DESC",
            (owner, logical.removeprefix("/workspace/"))).fetchall()
        for row in rows:
            if digest is None or row["sha256"] == digest:
                self.state.session(owner, row["session_id"])
                return {**self.service.store.file(owner, row["session_id"], row["id"]), "session_id": row["session_id"]}
        if rows:
            raise WorkError("file_changed", "文件已变化，请刷新文件列表后核对。", 409)
        raise WorkError("not_found", "未找到该文件。", 404)

    def _save_metadata(self, owner: str, updates: dict):
        if not updates:
            return
        db = self.state.db(owner)
        try:
            db.execute("BEGIN IMMEDIATE")
            for key, value in updates.items():
                self.state.set(owner, key, value)
            db.commit()
        except sqlite3.Error:
            if db.in_transaction:
                db.rollback()
            raise WorkError("file_metadata_pending", "文件已更改，但文件记录未能保存，请刷新后核对。", 503) from None

    async def _trash(self, owner: str, args: dict):
        self._body(args, {"path", "expectedSha256"})
        path, logical = self._logical(owner, args.get("path"))
        updates = {}
        old_paths = {logical, logical.removeprefix("/workspace/")}
        for row in self.state.db(owner).execute("SELECT key FROM metadata WHERE key LIKE 'artifact_index:%'").fetchall():
            records = self.state.get(owner, row["key"])
            if not isinstance(records, list) or not all(isinstance(item, dict) for item in records):
                raise WorkError("invalid_state", "文件记录无法读取，请联系管理员。", 503)
            filtered = [item for item in records if item.get("path") not in old_paths]
            if filtered != records:
                updates[row["key"]] = filtered
        updates["upload:" + logical] = None
        try:
            path.lstat()
        except FileNotFoundError:
            stored = self._saved_file(owner, logical, args["expectedSha256"])
            await self.service.mutate_file(owner, stored["session_id"], stored["id"], "trash", expected_sha256=args["expectedSha256"])
        else:
            self.files.invoke(owner, "move_to_trash", args)
        self._save_metadata(owner, updates)
        return None

    async def _rename(self, owner: str, query) -> dict:
        self._session(owner, query.get("session_key"))
        if query.get("scope", "shared") not in {"shared", "project"}:
            raise WorkError("invalid_request", "文件范围无效。")
        name = query.get("new_name", "")
        if not name or len(name) > 160 or name in {".", ".."} or any(c in name for c in "/\\") or any(ord(c) < 32 for c in name):
            raise WorkError("invalid_request", "文件名称无效。")
        path, logical = self._logical(owner, query.get("path", ""))
        root = self.files.root(owner)
        target = self.files._path(root, self.files._logical(root, path.with_name(name)))
        new_logical = self.files._logical(root, target)
        try:
            path.lstat()
        except FileNotFoundError:
            stored = self._saved_file(owner, logical)
            updates = self._renamed_metadata(owner, logical, new_logical, name)
            await self.service.mutate_file(owner, stored["session_id"], stored["id"], "rename", expected_sha256=stored["sha256"], destination=new_logical)
            self._save_metadata(owner, updates)
            return {"path": new_logical.removeprefix("/workspace/"), "name": name}
        lock = self.files._home(owner) / ".documents.lock"
        if lock.exists() or lock.is_symlink():
            info = lock.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise WorkError("invalid_state", "工作区目录不可用。", 503)
        try:
            with FileLock(str(lock), mode=0o600, timeout=0):
                try:
                    path.lstat()
                except FileNotFoundError:
                    raise WorkError("not_found", "未找到该文件。", 404) from None
                _, before = self.files._file_digest(path, self.service.config.workspace_bytes)
                if target == path:
                    return {"path": logical.removeprefix("/workspace/"), "name": name}
                updates = self._renamed_metadata(owner, logical, new_logical, name)
                os.link(path, target)
                linked = target.lstat()
                if (linked.st_ino, linked.st_dev, linked.st_size, linked.st_mtime_ns) != (
                        before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns):
                    target.unlink()
                    raise WorkError("file_changed", "文件已变化，请重新读取。", 409)
                try:
                    current = path.lstat()
                    if (current.st_ino, current.st_dev, current.st_mtime_ns) != (before.st_ino, before.st_dev, before.st_mtime_ns):
                        raise WorkError("file_changed", "文件已变化，请重新读取。", 409)
                    path.unlink()
                except (OSError, WorkError):
                    target.unlink()
                    raise
                self._save_metadata(owner, updates)
        except FileExistsError:
            raise WorkError("file_conflict", "同名文件已存在，请更换名称。", 409) from None
        except OSError:
            raise WorkError("file_changed", "文件改名未完成，请刷新后核对。", 409) from None
        return {"path": new_logical.removeprefix("/workspace/"), "name": name}
