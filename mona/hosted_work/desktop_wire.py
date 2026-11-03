"""The ordinary desktop chat protocol over account-scoped hosted Work runs."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import inspect
import json
import mimetypes
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from aiohttp import WSMsgType, web
from pydantic import ValidationError

from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, identifier
from mona.hosted_work.desktop_store import chat_id, request_id
from mona.hosted_work.store import encoded
from mona.office.schemas import OfficeSessionState

SOCKET_PATH = "/api/work/desktop/ws"
_SCOPED_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_OWNER = re.compile(r"^[a-f0-9]{64}$")
_DATA_URL = re.compile(r"^data:([A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+)?;base64,(.*)$", re.DOTALL)
_CONTEXT_FIELDS = {"ui_theme", "quote", "office_session_id", "office_document_type", "office_display_name",
                   "canvas_id", "canvas_path"}
_FRAME_FIELDS = _CONTEXT_FIELDS | {"chat_id", "input_id", "content", "display_content", "doc_paths", "media", "task_id"}


@dataclass(slots=True)
class _Ticket:
    owner: str
    token: str = field(repr=False)
    client_id: str | None = None
    expires: float = 0


@dataclass(slots=True, eq=False)
class _Peer:
    socket: web.WebSocketResponse
    owner: str
    token: str = field(repr=False)
    client_id: str = ""
    chats: set[str] = field(default_factory=set)


def _scope(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _SCOPED_ID.fullmatch(value):
        raise WorkError("invalid_request", label + "无效。")
    return value


def _chat(value: Any) -> str:
    return chat_id(_scope(value, "会话标识"))


class DesktopWire:
    def __init__(self, service, state, controller=None):
        self.service, self.state, self.controller = service, state, controller
        self._tickets: dict[str, _Ticket] = {}
        self._peers: set[_Peer] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._streams: dict[tuple[str, str], tuple[int, bool]] = {}
        self._stream_text: dict[tuple[str, str], list[str]] = {}
        self._announced: set[tuple[str, str]] = set()
        self._platform: dict[tuple[str, str, str], asyncio.Future] = {}
        self._platform_done: dict[tuple[str, str], tuple[str, str]] = {}

    def issue_ticket(self, owner: str, account_token: str, client_id: str | None = None) -> dict:
        if (not isinstance(owner, str) or not _OWNER.fullmatch(owner) or not isinstance(account_token, str)
                or not account_token or len(account_token) > 8192 or not account_token.isascii()
                or any(ord(c) < 33 or ord(c) == 127 for c in account_token)):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        if client_id is not None:
            _scope(client_id, "客户端标识")
        now = time.monotonic()
        self._tickets = {key: value for key, value in self._tickets.items() if value.expires > now}
        value = secrets.token_urlsafe(32)
        self._tickets[value] = _Ticket(owner, account_token, client_id, now + 30)
        return {"ticket": value, "expires_in_seconds": 30}

    @staticmethod
    def is_socket(request: web.Request) -> bool:
        return request.method == "GET" and request.path == SOCKET_PATH

    async def _identity(self, token: str, owner: str):
        if await self.service.auth.identity(token) != owner:
            raise WorkError("login_required", "登录已失效，请重新登录。", 401)

    async def handle_socket(self, request: web.Request) -> web.WebSocketResponse:
        if any(name in request.query for name in ("token", "access_token", "authorization")):
            raise WorkError("invalid_request", "登录凭据不能放入连接地址。")
        if request.headers.get("Origin") not in (None, self.service.config.public_origin.rstrip("/")):
            raise WorkError("origin_denied", "当前网页无权访问在线工作区。", 403)
        ticket = self._tickets.pop(request.query.get("ticket", ""), None)
        if ticket is None or ticket.expires <= time.monotonic():
            raise WorkError("login_required", "会话连接已失效，请刷新页面。", 401)
        client_id = request.query.get("client_id") or ticket.client_id or "web-" + secrets.token_hex(12)
        _scope(client_id, "客户端标识")
        if ticket.client_id is not None and ticket.client_id != client_id:
            raise WorkError("login_required", "会话连接不属于当前客户端。", 401)
        await self._identity(ticket.token, ticket.owner)
        socket = web.WebSocketResponse(heartbeat=20,
            max_msg_size=self.service.config.max_file_bytes * 2 + self.service.config.max_history_bytes)
        await socket.prepare(request)
        peer = _Peer(socket, ticket.owner, ticket.token, client_id)
        self._peers.add(peer)
        try:
            await socket.send_json({"event": "ready", "chat_id": "ephemeral:" + request_id(client_id, "ready"),
                                    "client_id": client_id})
            async for message in socket:
                if message.type != WSMsgType.TEXT:
                    if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                        break
                    continue
                try:
                    await self._identity(peer.token, peer.owner)
                except WorkError:
                    await socket.close(code=1008, message=b"account authorization expired")
                    break
                frame = None
                try:
                    frame = json.loads(message.data)
                    if not isinstance(frame, dict):
                        frame = {}
                        raise WorkError("invalid_request", "请求内容无效。")
                    await self._dispatch(peer, frame)
                except (ValueError, TypeError, ValidationError):
                    await self._error(peer, frame or {}, WorkError("invalid_request", "请求内容无效。"))
                except WorkError as exc:
                    await self._error(peer, frame or {}, exc)
        finally:
            self._peers.discard(peer)
        return socket

    async def _error(self, peer: _Peer, frame: dict, error: WorkError):
        kind = frame.get("type")
        fields = {key: frame[key] for key in ("chat_id", "request_id", "input_id")
                  if isinstance(frame.get(key), str) and len(frame[key]) <= 200}
        if kind == "doc_upload":
            await peer.socket.send_json({"event": "doc_upload_result", "ok": False,
                                         "error": error.message, **fields})
        elif kind == "stop_work_turn":
            await peer.socket.send_json({"event": "work_turn_stop_result", "ok": False,
                                         "code": error.code, "detail": error.message, **fields})
        else:
            await peer.socket.send_json({"event": "error", "code": error.code, "detail": error.message,
                                         **fields, **({"message_rejected": True} if kind == "message" else {})})

    async def _dispatch(self, peer: _Peer, frame: dict):
        kind = frame.get("type")
        if kind == "new_chat":
            source = _scope(frame.get("request_id"), "请求标识")
            if frame.get("workspace") not in (None, "", "/workspace") or frame.get("agent_kind"):
                raise WorkError("feature_unavailable", "线上工作台仅支持普通会话。")
            sid = request_id(source, peer.client_id + "new_chat")
            if frame.get("ephemeral") is True:
                await peer.socket.send_json({"event": "attached", "chat_id": "ephemeral:" + sid, "request_id": source})
                return
            if self.state.get(peer.owner, "chat:" + sid):
                self.state.session(peer.owner, sid)
            else:
                self.service.store.create_session(peer.owner, NewSession(request_id=sid))
                self.state.set(peer.owner, "chat:" + sid, {"request_id": source, "client_id": peer.client_id})
            self.state.session(peer.owner, sid)
            peer.chats.add(sid)
            await peer.socket.send_json({"event": "attached", "chat_id": sid, "request_id": source})
            await self.emit_to_chat(peer.owner, sid, {"event": "session_updated", "scope": "metadata"})
            return
        if kind == "attach":
            await self._attach(peer, frame.get("chat_id"))
            return
        if kind == "message":
            async with self._locks.setdefault(peer.owner, asyncio.Lock()):
                await self._message(peer, frame)
            return
        if kind == "doc_upload":
            await self._upload(peer, frame)
            return
        if kind == "stop_work_turn":
            await self._stop(peer, frame)
            return
        if kind == "delete_chat":
            sid = _chat(frame.get("chat_id"))
            self.state.delete(peer.owner, sid)
            for subscriber in self._peers:
                if subscriber.owner == peer.owner:
                    subscriber.chats.discard(sid)
            return
        request = frame.get("request_id")
        if isinstance(request, str) and frame.get("chat_id"):
            sid = _chat(frame["chat_id"])
            self.state.session(peer.owner, sid)
            future = self._platform.get((peer.owner, sid, request))
            if future is not None and sid in peer.chats and isinstance(kind, str) and kind.endswith("_result"):
                self.platform_result(peer.owner, request, frame)
                return
        raise WorkError("feature_unavailable", "此功能暂未接入线上工作台。")

    async def _attach(self, peer: _Peer, raw_sid: str):
        sid = _chat(raw_sid)
        self.state.session(peer.owner, sid)
        peer.chats.add(sid)
        await peer.socket.send_json({"event": "attached", "chat_id": sid})
        active = self.service.store.db.execute(
            "SELECT id FROM runs WHERE owner=? AND session_id=? AND status IN ('running','cancelling','unknown') ORDER BY created DESC LIMIT 1",
            (peer.owner, sid)).fetchone()
        if active:
            run = self.service.store.run(peer.owner, active[0])
            await peer.socket.send_json(self._goal(run, self.state.get(peer.owner, "run:" + run["id"], {})))
        else:
            await peer.socket.send_json({"event": "goal_status", "chat_id": sid, "status": "idle"})
        if self.controller is not None and hasattr(self.controller, "restore_editors"):
            restored = self.controller.restore_editors(peer.owner, sid)
            if inspect.isawaitable(restored):
                restored = await restored
            if not isinstance(restored, list):
                raise WorkError("protocol_error", "文档恢复记录格式无效。", 503)
            for item in restored:
                session = self._office_state(item)
                await peer.socket.send_json({"event": "message", "chat_id": sid, "kind": "progress",
                    "text": "已恢复文档：" + session["displayName"],
                    "agent_ui": {"kind": "office_session", "data": {"session": session}}})

    @staticmethod
    def _goal(run: dict, metadata: dict) -> dict:
        state = "unknown" if run["status"] == "unknown" else "stopping" if run["status"] == "cancelling" else "running"
        return {"event": "goal_status", "chat_id": run["session_id"], "status": "running",
                "turn_id": run["id"], "input_id": metadata.get("input_id"), "turn_state": state,
                "started_at": run["created"]}

    def _record_user(self, owner: str, run: dict, metadata: dict):
        if not metadata:
            self.state.records(owner, run["session_id"])
            return
        frame = metadata.get("frame", {})
        record = {"event": "user", "text": frame.get("content", run["input"]["text"])}
        for key in ("display_content", "quote", "task_id"):
            if frame.get(key):
                record[key] = frame[key]
        if frame.get("doc_paths"):
            record["media_paths"] = frame["doc_paths"]
        self.state.append(owner, run["session_id"], record, "run:" + run["id"] + ":user")

    async def _message(self, peer: _Peer, frame: dict):
        sid = _chat(frame.get("chat_id"))
        self.state.session(peer.owner, sid)
        self.state.records(peer.owner, sid)
        input_id = _scope(frame.get("input_id"), "消息标识")
        content = frame.get("content")
        if not isinstance(content, str) or not content.strip():
            raise WorkError("invalid_request", "消息内容不能为空。")
        selected = {key: frame[key] for key in _FRAME_FIELDS if key in frame}
        fingerprint = hashlib.sha256(json.dumps(selected, sort_keys=True, ensure_ascii=False,
                                                separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        rid = request_id(input_id, peer.client_id + "message")
        previous = self.state.get(peer.owner, "run:" + rid)
        if previous and (previous["fingerprint"] != fingerprint or previous["chat_id"] != sid):
            raise WorkError("request_conflict", "该消息标识已用于其他内容，未重复执行。", 409)
        if previous:
            request = NewTurn.model_validate(previous["request"])
        else:
            attachments = []
            if frame.get("media") or frame.get("doc_paths"):
                if self.controller is None or not hasattr(self.controller, "prepare_attachments"):
                    raise WorkError("feature_unavailable", "附件尚未接入当前执行环境。", 503)
                attachments = self.controller.prepare_attachments(peer.owner, sid, frame)
                if inspect.isawaitable(attachments):
                    attachments = await attachments
            context = {key: frame[key] for key in _CONTEXT_FIELDS if key in frame}
            request = NewTurn(request_id=rid, model_id=self.state.model(peer.owner), text=content,
                              attachment_ids=attachments, metadata=context)
            selected.pop("media", None)
            previous = {"input_id": input_id, "chat_id": sid, "client_id": peer.client_id,
                        "fingerprint": fingerprint, "frame": selected, "request": request.model_dump()}
            self.state.set(peer.owner, "run:" + rid, previous)
        run = await self.service.submit(peer.owner, peer.token, sid, request)
        self._record_user(peer.owner, run, previous)
        peer.chats.add(sid)
        await peer.socket.send_json({"event": "message_accepted", "chat_id": sid, "input_id": input_id})
        current = self.service.store.run(peer.owner, rid)
        if current["status"] in {"running", "cancelling", "unknown"}:
            if (peer.owner, rid) in self._announced:
                await peer.socket.send_json(self._goal(current, previous))
            else:
                await self._started(peer.owner, current)
        else:
            await peer.socket.send_json({"event": "turn_end", "chat_id": sid, "turn_id": rid, "input_id": input_id})
            await peer.socket.send_json({"event": "session_updated", "chat_id": sid, "scope": "thread"})

    async def _started(self, owner: str, run: dict):
        key = owner, run["id"]
        if key not in self._announced:
            self._announced.add(key)
            metadata = self.state.get(owner, "run:" + run["id"], {})
            await self.emit_to_chat(owner, run["session_id"], self._goal(run, metadata))

    @staticmethod
    def _office_state(value: dict) -> dict:
        session = OfficeSessionState.model_validate(value)
        suffix = {"docs": ".docx", "sheets": ".xlsx", "slides": ".pptx"}[session.type]
        logical_path = f"/workspace/.office/{session.session_id}/working{suffix}"
        if session.working_path is not None and session.working_path != logical_path:
            raise WorkError("protocol_error", "编辑器返回了非工作区路径。", 503)
        return session.model_dump(by_alias=True, mode="json")

    async def _delivery_files(self, owner: str, sid: str, values: list, *, read_contents: bool) -> list[dict]:
        if not isinstance(values, list) or not 1 <= len(values) <= 128:
            raise WorkError("protocol_error", "交付文件记录格式无效。", 503)
        root = self.state.files.root(owner)
        result = []
        for item in values:
            if not isinstance(item, dict):
                raise WorkError("protocol_error", "交付文件记录格式无效。", 503)
            raw_path = item.get("absolute_path") or item.get("path")
            if not isinstance(raw_path, str):
                raise WorkError("protocol_error", "交付文件路径无效。", 503)
            logical = raw_path if raw_path.startswith("/workspace/") else "/workspace/" + raw_path
            path = self.state.files._path(root, logical)
            size, name = item.get("size"), item.get("name")
            if type(size) is not int or not 0 <= size <= self.service.config.max_file_bytes or name != path.name:
                raise WorkError("protocol_error", "交付文件属性无效。", 503)
            digest = item.get("sha256")
            if any(item.get(key) is not None and not isinstance(item[key], str) for key in ("mime", "size_human")):
                raise WorkError("protocol_error", "交付文件属性无效。", 503)
            if read_contents:
                if self.controller is not None and hasattr(self.controller, "read_file"):
                    loaded = self.controller.read_file(owner, sid, logical)
                    if inspect.isawaitable(loaded):
                        loaded = await loaded
                    actual_name, content = loaded
                    if actual_name != name:
                        raise WorkError("file_changed", "交付文件已变化，请重新确认。", 409)
                else:
                    content = self.state.files._read_bytes(path, self.service.config.max_file_bytes)
                actual = hashlib.sha256(content).hexdigest()
                if len(content) != size or digest is not None and digest != actual:
                    raise WorkError("file_changed", "交付文件已变化，请重新确认。", 409)
                digest = actual
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise WorkError("protocol_error", "交付文件缺少可核对的摘要。", 503)
            result.append({"path": logical, "absolute_path": logical, "name": name, "size": size,
                           "size_human": item.get("size_human") or f"{size / 1024:.1f} KB",
                           "mime": item.get("mime") or mimetypes.guess_type(name)[0] or "application/octet-stream",
                           "sha256": digest})
        return result

    async def _upload(self, peer: _Peer, frame: dict):
        if self.controller is None or not hasattr(self.controller, "prepare_attachments"):
            raise WorkError("feature_unavailable", "附件尚未接入当前执行环境。", 503)
        scope = _scope(frame.get("chat_id"), "会话标识")
        if not scope.startswith("ephemeral:"):
            self.state.session(peer.owner, chat_id(scope))
        files = frame.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= 8:
            raise WorkError("invalid_request", "请选择有效附件。")
        decoded = []
        for item in files:
            if not isinstance(item, dict) or item.get("local_path"):
                raise WorkError("invalid_request", "网页附件必须上传文件内容。")
            name, url = item.get("name"), item.get("data_url")
            if (not isinstance(name, str) or not name or len(name.encode()) > 240 or name in {".", ".."}
                    or any(c in name for c in "/\\:") or any(ord(c) < 32 or ord(c) == 127 for c in name)):
                raise WorkError("invalid_filename", "附件名称无效。")
            match = _DATA_URL.fullmatch(url) if isinstance(url, str) and len(url) <= self.service.config.max_file_bytes * 2 else None
            try:
                raw = base64.b64decode(match[2], validate=True) if match else None
            except (ValueError, binascii.Error):
                raw = None
            if raw is None or len(raw) > self.service.config.max_file_bytes:
                raise WorkError("file_limit", "附件格式无效或超过大小限制。", 413)
            decoded.append((name, raw, match[1] or mimetypes.guess_type(name)[0] or "application/octet-stream"))
        if sum(len(raw) for _, raw, _ in decoded) > self.service.config.workspace_bytes:
            raise WorkError("file_limit", "附件总大小超过工作区限制。", 413)
        root = self.state.files.root(peer.owner)
        uploads = root / "uploads"
        if uploads.is_symlink():
            raise WorkError("invalid_state", "附件目录不可用。", 503)
        uploads.mkdir(mode=0o700, exist_ok=True)
        if not uploads.is_dir() or uploads.resolve().parent != root:
            raise WorkError("invalid_state", "附件目录不可用。", 503)
        added = []
        for name, raw, mime in decoded:
            slot = secrets.token_hex(16)
            directory = uploads / slot
            directory.mkdir(mode=0o700, exist_ok=False)
            path = directory / name
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            logical = "/workspace/uploads/" + slot + "/" + name
            record = {"name": name, "path": logical, "size": len(raw), "mime": mime,
                      "sha256": hashlib.sha256(raw).hexdigest(), "scope": scope}
            self.state.set(peer.owner, "upload:" + logical, record)
            added.append({key: record[key] for key in ("name", "path", "size", "mime")})
        await peer.socket.send_json({"event": "doc_upload_result", "ok": True, "chat_id": scope, "files": added})

    async def _stop(self, peer: _Peer, frame: dict):
        sid = _chat(frame.get("chat_id"))
        self.state.session(peer.owner, sid)
        rid = identifier(frame.get("expected_turn_id", ""))
        run = self.service.store.run(peer.owner, rid)
        if run["session_id"] != sid:
            raise WorkError("request_conflict", "停止目标不属于当前会话。", 409)
        source = _scope(frame.get("request_id"), "请求标识")
        outcome = "already_finished"
        if run["status"] in {"running", "cancelling"}:
            await self.service.stop(peer.owner, rid)
            task = self.service.tasks.get((peer.owner, rid))
            if task is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(task), 7.5)
                except TimeoutError:
                    pass
            current = self.service.store.run(peer.owner, rid)
            outcome = "stopped" if current["status"] not in {"running", "cancelling", "unknown"} else "unknown"
        elif run["status"] == "unknown":
            outcome = "unknown"
        await peer.socket.send_json({"event": "work_turn_stop_result", "ok": True, "chat_id": sid,
                                     "turn_id": rid, "request_id": source, "outcome": outcome})

    async def emit_to_chat(self, owner: str, sid: str, event: dict):
        try:
            self.state.session(owner, sid)
        except WorkError as exc:
            if exc.status == 404:
                return
            raise
        payload = encoded({**event, "chat_id": sid})
        for peer in tuple(self._peers):
            if peer.owner != owner or sid not in peer.chats or peer.socket.closed:
                continue
            try:
                await self._identity(peer.token, owner)
            except WorkError:
                await peer.socket.close(code=1008, message=b"account authorization expired")
                continue
            try:
                await peer.socket.send_str(payload)
            except (ConnectionError, RuntimeError):
                self._peers.discard(peer)

    async def on_run_event(self, owner: str, run: dict, kind: str, data: dict):
        async with self._locks.setdefault(owner, asyncio.Lock()):
            await self._on_run_event(owner, run, kind, data)

    async def _on_run_event(self, owner: str, run: dict, kind: str, data: dict):
        if kind not in {"delta", "progress", "desktop"}:
            return
        sid, rid = run["session_id"], run["id"]
        self.state.session(owner, sid)
        stored = self.service.store.run(owner, rid)
        if stored["session_id"] != sid or stored["status"] not in {"running", "cancelling"}:
            return
        metadata = self.state.get(owner, "run:" + rid, {})
        self._record_user(owner, stored, metadata)
        await self._started(owner, stored)
        row = self.service.store.db.execute("SELECT seq,kind,data FROM events WHERE owner=? AND run_id=? ORDER BY seq DESC LIMIT 1", (owner, rid)).fetchone()
        if row is None or row["kind"] != kind or json.loads(row["data"]) != data:
            raise WorkError("protocol_error", "执行进度尚未持久保存。", 503)
        if row["seq"] <= self.state.get(owner, "wire_seq:" + rid, 0):
            return
        key = owner, rid
        index, active = self._streams.get(key, (0, False))
        if kind == "delta":
            if not active:
                index += 1
                self._stream_text[key] = []
            text = data.get("text")
            if not isinstance(text, str):
                raise WorkError("protocol_error", "模型输出格式无效。", 503)
            self._stream_text[key].append(text)
            record = {"event": "delta", "text": text, "stream_id": rid + ":" + str(index), "task_id": rid}
            active = True
        elif kind == "desktop":
            ui = data.get("agent_ui")
            if data.get("event") == "deliver_files":
                record = {"event": "deliver_files", "task_id": rid, "inline_media": False,
                          "files": await self._delivery_files(owner, sid, data.get("files"), read_contents=True)}
            elif (data.get("event") != "message" or data.get("kind") != "progress"
                    or not isinstance(data.get("text"), str) or not isinstance(ui, dict)
                    or ui.get("kind") != "office_session" or not isinstance(ui.get("data"), dict)):
                raise WorkError("protocol_error", "编辑器事件格式无效。", 503)
            else:
                session = self._office_state(ui["data"].get("session"))
                record = {"event": "message", "kind": "progress", "text": data["text"], "task_id": rid,
                          "agent_ui": {"kind": "office_session", "data": {"session": session}}}
        else:
            if active:
                ending = {"event": "stream_end", "stream_id": rid + ":" + str(index)}
                self.state.append(owner, sid, ending, f"run:{rid}:event:{row['seq']}:stream_end")
                await self.emit_to_chat(owner, sid, ending)
            active = False
            record = {"event": "message", "kind": "progress", "text": str(data.get("message") or "正在处理任务"), "task_id": rid}
            if isinstance(data.get("tools"), list):
                record["tool_events"] = [{"version": 1, "phase": "start", "name": name,
                                           "call_id": f"{rid}:{row['seq']}:{i}"}
                                          for i, name in enumerate(data["tools"]) if isinstance(name, str)]
        self.state.append(owner, sid, record, f"run:{rid}:event:{row['seq']}")
        self.state.set(owner, "wire_seq:" + rid, row["seq"])
        self._streams[key] = index, active
        await self.emit_to_chat(owner, sid, record)

    async def on_run_finish(self, owner: str, run: dict, result: dict):
        async with self._locks.setdefault(owner, asyncio.Lock()):
            await self._on_run_finish(owner, run, result)

    async def _on_run_finish(self, owner: str, run: dict, result: dict):
        sid, rid = run["session_id"], run["id"]
        try:
            self.state.session(owner, sid)
            stored = self.service.store.run(owner, rid)
        except WorkError as exc:
            if exc.status == 404:
                return
            raise
        if stored["status"] in {"running", "cancelling"}:
            raise WorkError("execution_pending", "执行尚未确认结束。", 409)
        status = stored["status"]
        if self.state.get(owner, "wire_finished:" + rid) == status:
            return
        metadata = self.state.get(owner, "run:" + rid, {})
        self._record_user(owner, stored, metadata)
        verified = [item["file"] for item in self.state.get(owner, "artifact_index:" + sid, [])
                    if isinstance(item, dict) and item.get("task_id") == rid and item.get("delivered") is True
                    and isinstance(item.get("file"), dict)]
        delivery = {"event": "deliver_files", "task_id": rid, "inline_media": False,
                    "files": await self._delivery_files(owner, sid, verified, read_contents=False)} if verified else None
        index, active = self._streams.pop((owner, rid), (0, False))
        if active:
            end = {"event": "stream_end", "stream_id": rid + ":" + str(index)}
            self.state.append(owner, sid, end, "run:" + rid + ":stream_end")
            await self.emit_to_chat(owner, sid, end)
        text = stored["result"].get("content", "")
        streamed = "".join(self._stream_text.pop((owner, rid), []))
        record = {"event": "message", "text": text, "task_id": rid, "token_usage": stored["result"].get("usage", {})}
        if index:
            record["stream_id"] = rid + ":" + str(index)
        if not text or status != "completed":
            record["kind"] = "progress"
            record["text"] = stored["result"].get("message") or ("本轮已完成。" if status == "completed" else "本轮未完成，已有结果已保留。")
        already_streamed = status == "completed" and bool(text) and index > 0 and text == streamed
        if not already_streamed:
            self.state.append(owner, sid, record, f"run:{rid}:finish:{status}")
        self.state.set(owner, "wire_finished:" + rid, status)
        if not already_streamed:
            await self.emit_to_chat(owner, sid, record)
        if delivery is not None:
            self.state.append(owner, sid, delivery, f"run:{rid}:deliver:{status}")
            await self.emit_to_chat(owner, sid, delivery)
        if status == "unknown":
            await self.emit_to_chat(owner, sid, self._goal(stored, metadata))
        else:
            ending = {"event": "turn_end", "turn_id": rid, "input_id": metadata.get("input_id"), "task_id": rid,
                      "token_usage": stored["result"].get("usage", {})}
            self.state.append(owner, sid, ending, f"run:{rid}:turn_end:{status}")
            await self.emit_to_chat(owner, sid, ending)
        await self.emit_to_chat(owner, sid, {"event": "artifacts_changed"})
        await self.emit_to_chat(owner, sid, {"event": "session_updated", "scope": "thread"})

    async def request_platform(self, owner: str, sid: str, event: dict, *, timeout: float = 30) -> dict:
        self.state.session(owner, sid)
        value = dict(event)
        rid = _scope(value.get("request_id") or "platform-" + secrets.token_hex(16), "请求标识")
        value["request_id"] = rid
        key = owner, sid, rid
        if ((owner, rid) in self._platform_done
                or any(existing[0] == owner and existing[2] == rid for existing in self._platform)):
            raise WorkError("request_conflict", "编辑请求已在进行。", 409)
        future = asyncio.get_running_loop().create_future()
        self._platform[key] = future
        try:
            await self.emit_to_chat(owner, sid, value)
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            raise WorkError("editor_unavailable", "编辑器尚未确认操作结果，请核对后继续。", 503) from None
        finally:
            self._platform.pop(key, None)

    def platform_pending(self, owner: str, request: str) -> bool:
        matching = [(key, future) for key, future in self._platform.items()
                    if key[0] == owner and key[2] == request and not future.done()]
        if len(matching) != 1:
            return False
        try:
            self.state.session(owner, matching[0][0][1])
        except WorkError as exc:
            if exc.status == 404:
                return False
            raise
        return True

    def platform_result(self, owner: str, request: str, result: dict) -> dict:
        if not isinstance(result, dict):
            raise WorkError("invalid_request", "编辑器回执格式无效。")
        value = encoded(result)
        if len(value.encode()) > self.service.config.max_history_bytes:
            raise WorkError("event_limit", "编辑器回执超过允许大小。", 413)
        digest = hashlib.sha256(json.dumps(result, sort_keys=True, ensure_ascii=False,
                                           separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        done = self._platform_done.get((owner, request))
        if done:
            self.state.session(owner, done[0])
            if done[1] != digest:
                raise WorkError("request_conflict", "同一编辑操作的回执已变化。", 409)
            return {"ok": True}
        matching = [(key, future) for key, future in self._platform.items()
                    if key[0] == owner and key[2] == request]
        if not matching:
            raise WorkError("not_found", "未找到对应的编辑请求。", 404)
        if len(matching) != 1 or matching[0][1].done():
            raise WorkError("request_conflict", "该编辑请求已结束。", 409)
        key, future = matching[0]
        self.state.session(owner, key[1])
        self._platform_done[(owner, request)] = key[1], digest
        while len(self._platform_done) > 256:
            self._platform_done.pop(next(iter(self._platform_done)))
        future.set_result(result)
        return {"ok": True}

    async def close(self):
        self._tickets.clear()
        for future in self._platform.values():
            if not future.done():
                future.set_exception(WorkError("editor_unavailable", "编辑连接已关闭。", 503))
        self._platform.clear()
        self._platform_done.clear()
        for peer in tuple(self._peers):
            await peer.socket.close(code=1001, message=b"service shutdown")
        self._peers.clear()
