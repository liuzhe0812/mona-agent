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
_FRAME_FIELDS = _CONTEXT_FIELDS | {"chat_id", "input_id", "content", "display_content", "doc_paths", "media", "task_id",
                                   "target_turn_id", "resume_input"}


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


def _task(metadata: dict, run_id: str) -> str:
    value = metadata.get("frame", {}).get("task_id")
    return _scope(value, "任务标识") if value is not None else run_id


class DesktopWire:
    def __init__(self, service, state, controller=None):
        self.service, self.state, self.controller = service, state, controller
        self._tickets: dict[str, _Ticket] = {}
        self._peers: set[_Peer] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._streams: dict[tuple[str, str], tuple[int, bool]] = {}
        self._stream_text: dict[tuple[str, str], list[str]] = {}
        self._reasoning_open: set[tuple[str, str]] = set()
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
        fields = {key: frame[key] for key in ("chat_id", "request_id", "input_id", "target_turn_id")
                  if isinstance(frame.get(key), str) and len(frame[key]) <= 200}
        if kind == "doc_upload":
            await peer.socket.send_json({"event": "doc_upload_result", "ok": False,
                                         "error": error.message, **fields})
        elif kind == "stop_work_turn":
            await peer.socket.send_json({"event": "work_turn_stop_result", "ok": False,
                                         "code": error.code, "detail": error.message, **fields})
        elif kind == "answer_user_question":
            await peer.socket.send_json({"event": "answer_user_question_result", "ok": False,
                                         "code": error.code, "detail": error.message, **fields})
        else:
            await peer.socket.send_json({"event": "error", "code": error.code, "detail": error.message,
                                         **fields, **({"message_rejected": True} if kind == "message" else {})})

    async def _dispatch(self, peer: _Peer, frame: dict):
        kind = frame.get("type")
        if kind == "answer_user_question":
            sid = _chat(frame.get("chat_id"))
            request = _scope(frame.get("request_id"), "回答标识")
            fields = {"event": "answer_user_question_result", "chat_id": sid, "request_id": request}
            try:
                answer = getattr(getattr(self.controller, "questions", None), "answer", None)
                if not callable(answer):
                    raise WorkError("question_unavailable", "回答暂时无法提交，请刷新会话后重试。", 503)
                if "answers" not in frame:
                    raise WorkError("invalid_answer", "回答格式无效。")
                self.state.session(peer.owner, sid)
                answer(peer.owner, sid, frame.get("question_id"), frame["answers"], attached=sid in peer.chats)
            except WorkError as exc:
                await peer.socket.send_json({**fields, "ok": False, "detail": exc.message, "code": exc.code})
            else:
                await peer.socket.send_json({**fields, "ok": True})
            return
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
        editors = []
        if self.controller is not None and hasattr(self.controller, "restore_editors"):
            restored = self.controller.restore_editors(peer.owner, sid)
            if inspect.isawaitable(restored):
                restored = await restored
            if not isinstance(restored, list):
                raise WorkError("protocol_error", "文档恢复记录格式无效。", 503)
            editors = [self._office_state(item) for item in restored]
        await peer.socket.send_json({"event": "attached", "chat_id": sid, "office_sessions": editors})
        for name in ("task_plan", "goal_state"):
            saved = self.state.get(peer.owner, name + ":" + sid)
            if not isinstance(saved, dict):
                continue
            run = self.service.store.run(peer.owner, saved.get("run_id", ""))
            if run["session_id"] != sid:
                raise WorkError("protocol_error", "任务状态不属于当前会话。", 503)
            if name == "task_plan":
                latest = self.service.store.db.execute(
                    "SELECT id FROM runs WHERE owner=? AND session_id=? ORDER BY created DESC LIMIT 1",
                    (peer.owner, sid)).fetchone()
                if latest is None or latest[0] != run["id"]:
                    continue
            metadata = self.state.get(peer.owner, "run:" + run["id"], {})
            event = self._task_state(saved.get("snapshot"), sid, run["id"], _task(metadata, run["id"]), metadata.get("input_id"))
            await peer.socket.send_json({**event, "chat_id": sid})
        snapshot = getattr(getattr(self.controller, "questions", None), "snapshot", None)
        questions = snapshot(peer.owner, sid) if callable(snapshot) else []
        if not isinstance(questions, list):
            raise WorkError("protocol_error", "提问恢复记录格式无效。", 503)
        await peer.socket.send_json({"event": "user_questions", "chat_id": sid, "requests": questions})
        inputs = getattr(self.controller, "inputs", None)
        if inputs is not None:
            for snapshot in await inputs.snapshot(peer.owner, sid):
                await peer.socket.send_json({"event": "work_input_state", **snapshot})
        active = self.service.store.db.execute(
            "SELECT id FROM runs WHERE owner=? AND session_id=? AND status IN ('running','cancelling','unknown') ORDER BY created DESC LIMIT 1",
            (peer.owner, sid)).fetchone()
        if active:
            run = self.service.store.run(peer.owner, active[0])
            task = self.service.tasks.get((peer.owner, run["id"]))
            if run["status"] == "unknown" and task is not None and not task.done():
                run = {**run, "status": "cancelling"}
            await peer.socket.send_json(self._goal(run, self.state.get(peer.owner, "run:" + run["id"], {})))
        else:
            latest = self.service.store.db.execute(
                "SELECT id FROM runs WHERE owner=? AND session_id=? ORDER BY created DESC LIMIT 1",
                (peer.owner, sid)).fetchone()
            if latest:
                run = self.service.store.run(peer.owner, latest[0])
                task = self.service.tasks.get((peer.owner, run["id"]))
                if task is not None and not self._task_finished(task):
                    state = "unknown" if task.done() else "cancelling"
                    await peer.socket.send_json(self._goal({**run, "status": state},
                        self.state.get(peer.owner, "run:" + run["id"], {})))
                    return
                if self._finished_recorded(peer.owner, run):
                    await peer.socket.send_json({"event": "goal_status", "chat_id": sid, "status": "idle",
                                                 "turn_id": run["id"], "stop_confirmed": True})
                    return
            await peer.socket.send_json({"event": "goal_status", "chat_id": sid, "status": "idle"})

    @staticmethod
    def _goal(run: dict, metadata: dict) -> dict:
        state = "unknown" if run["status"] == "unknown" else "stopping" if run["status"] == "cancelling" else "running"
        return {"event": "goal_status", "chat_id": run["session_id"], "status": "running",
                "turn_id": run["id"], "input_id": metadata.get("input_id"), "turn_state": state,
                "started_at": run["created"]}

    @staticmethod
    def _task_finished(task) -> bool:
        return task.done() and not task.cancelled() and task.exception() is None

    def _finished_recorded(self, owner: str, run: dict) -> bool:
        return (run["status"] not in {"running", "cancelling", "unknown"}
                and self.state.get(owner, "wire_finished:" + run["id"]) == run["status"])

    def _record_user(self, owner: str, run: dict, metadata: dict):
        if not metadata:
            self.state.records(owner, run["session_id"])
            return
        frame = metadata.get("frame", {})
        record = {"event": "user", "text": frame.get("content", run["input"]["text"]),
                  "input_id": metadata.get("input_id"), "turn_id": run["id"]}
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
        if frame.get("task_id") is not None:
            _scope(frame["task_id"], "任务标识")
        if not isinstance(content, str) or not content.strip() and not (frame.get("media") or frame.get("doc_paths")):
            raise WorkError("invalid_request", "消息内容不能为空。")
        target = frame.get("target_turn_id")
        resume = frame.get("resume_input", False)
        if not isinstance(resume, bool):
            raise WorkError("invalid_request", "消息恢复标记无效。")
        if target is not None:
            identifier(target)
        active = self.service.store.db.execute(
            "SELECT id FROM runs WHERE owner=? AND session_id=? AND status IN ('running','cancelling','unknown') ORDER BY created DESC LIMIT 1",
            (peer.owner, sid)).fetchone()
        inputs = getattr(self.controller, "inputs", None)
        # Explicit steering never becomes an independent task if the target
        # finishes between a browser send and admission.
        if target is not None or resume:
            if active is None or target != active[0] or inputs is None:
                raise WorkError("input_turn_conflict", "原任务已结束或尚待核对，未继续执行追加内容。", 409)
            paths = frame.get("doc_paths", [])
            steering = getattr(self.controller, "steering", None)
            if not isinstance(paths, list):
                raise WorkError("invalid_request", "附件信息无效。")
            if frame.get("media"):
                if steering is None:
                    raise WorkError("feature_unavailable", "此会话暂时无法接收图片。", 503)
                paths = [*paths, *steering.stage_media(peer.owner, sid, input_id, frame["media"])]
            attachments = steering.prepare(peer.owner, sid, input_id, paths) if steering is not None else []
            if paths and steering is None:
                raise WorkError("feature_unavailable", "此会话暂时无法接收附件。", 503)
            metadata = {key: frame[key] for key in ("ui_theme", "office_session_id", "office_document_type",
                        "office_display_name", "display_content", "quote", "task_id") if key in frame}
            peer.chats.add(sid)
            await inputs.enqueue(peer.owner, sid, target, input_id, content, resume=resume,
                                 attachments=attachments, metadata=metadata)
            await peer.socket.send_json({"event": "message_accepted", "chat_id": sid, "input_id": input_id,
                                         "target_turn_id": target})
            return
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
                attachment_frame = dict(frame)
                if frame.get("media"):
                    steering = getattr(self.controller, "steering", None)
                    if steering is None:
                        raise WorkError("feature_unavailable", "此会话暂时无法接收图片。", 503)
                    paths = frame.get("doc_paths", [])
                    if not isinstance(paths, list):
                        raise WorkError("invalid_request", "附件信息无效。")
                    paths = [*paths, *steering.stage_media(peer.owner, sid, input_id, frame["media"])]
                    attachment_frame.update(media=[], doc_paths=paths)
                    selected["doc_paths"] = paths
                attachments = self.controller.prepare_attachments(peer.owner, sid, attachment_frame)
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
            start = {"event": "artifact_task_started", "task_id": _task(metadata, run["id"])}
            self.state.append(owner, run["session_id"], start, "run:" + run["id"] + ":task_started")
            await self.emit_to_chat(owner, run["session_id"], start)
            await self.emit_to_chat(owner, run["session_id"], self._goal(run, metadata))

    @staticmethod
    def _office_state(value: dict) -> dict:
        session = OfficeSessionState.model_validate(value)
        suffix = {"docs": ".docx", "sheets": ".xlsx", "slides": ".pptx"}[session.type]
        logical_path = f"/workspace/.office/{session.session_id}/working{suffix}"
        if session.working_path is not None and session.working_path != logical_path:
            raise WorkError("protocol_error", "编辑器返回了非工作区路径。", 503)
        return session.model_dump(by_alias=True, mode="json")

    @staticmethod
    def _task_state(data: dict, sid: str, rid: str, task_id: str, input_id: str | None) -> dict:
        if (not isinstance(data, dict) or not isinstance(data.get("event"), str)
                or data["event"] not in {"task_plan", "goal_state"}
                or any(data.get(key, value) not in (None, value) for key, value in
                       {"chat_id": sid, "turn_id": rid, "task_id": task_id, "input_id": input_id}.items())):
            raise WorkError("protocol_error", "任务状态不属于当前会话。", 503)
        name = data["event"]
        blob = data.get(name)
        if not isinstance(blob, dict):
            raise WorkError("protocol_error", "任务状态格式无效。", 503)
        if name == "task_plan":
            from mona.session.task_plan import task_plan_ws_blob

            if blob.get("task_id") not in (None, task_id):
                raise WorkError("protocol_error", "任务计划不属于当前任务。", 503)
            blob = task_plan_ws_blob({"task_plan": {**blob, "task_id": task_id}})
        else:
            if type(blob.get("active")) is not bool:
                raise WorkError("protocol_error", "任务目标格式无效。", 503)
            if any(key in blob and not isinstance(blob[key], str) for key in ("objective", "ui_summary")):
                raise WorkError("protocol_error", "任务目标格式无效。", 503)
            blob = {"active": blob["active"], **{key: blob[key][:limit] for key, limit in
                    (("objective", 601), ("ui_summary", 120)) if key in blob}}
        return {"event": name, name: blob}

    def _file_edits(self, owner: str, values: list) -> list[dict]:
        if not isinstance(values, list) or not 1 <= len(values) <= 100:
            raise WorkError("protocol_error", "文件编辑记录格式无效。", 503)
        root = self.state.files.root(owner)
        edits = []
        for item in values:
            if (not isinstance(item, dict) or not isinstance(item.get("call_id"), str)
                    or not isinstance(item.get("tool"), str) or not isinstance(item.get("status"), str)
                    or item.get("tool") not in {"write_file", "edit_file", "apply_patch"}
                    or item.get("status") not in {"editing", "done", "error"}
                    or any(type(item.get(key)) is not int or item[key] < 0 for key in ("added", "deleted"))):
                raise WorkError("protocol_error", "文件编辑记录格式无效。", 503)
            edit = {key: item[key] for key in ("version", "call_id", "tool", "phase", "added", "deleted",
                    "approximate", "status", "binary", "pending") if key in item}
            raw = item.get("absolute_path") or item.get("path")
            if not isinstance(raw, str):
                raise WorkError("protocol_error", "文件编辑路径无效。", 503)
            if raw == "" and item.get("pending") is True and item["status"] == "editing":
                edit["path"] = ""
            else:
                logical = raw if raw.startswith("/workspace/") else "/workspace/" + raw
                path = self.state.files._path(root, logical)
                edit.update(path=path.relative_to(root).as_posix(), absolute_path=logical)
            if item["status"] == "error":
                edit["error"] = "文件修改未能完成，请核对已有内容后继续。"
            edits.append(edit)
        return edits

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
            result.append({"path": logical.removeprefix("/workspace/"), "absolute_path": logical, "name": name, "size": size,
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
            if (not isinstance(name, str) or not name or len(name) > 160 or len(name.encode()) > 240 or name in {".", ".."}
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
        was_active = run["status"] in {"running", "cancelling"}
        if was_active or run["status"] == "unknown":
            await self.service.stop(peer.owner, rid)
        task = self.service.tasks.get((peer.owner, rid))
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), 7.5)
            except TimeoutError:
                pass
            except asyncio.CancelledError:
                if not task.cancelled():
                    raise
            except Exception:
                pass  # A failed cleanup cannot confirm that the task stopped.
        current = self.service.store.run(peer.owner, rid)
        if current["status"] == "unknown" and task is not None and task.done():
            current = await self.service.stop(peer.owner, rid)
        if task is not None and not task.done():
            outcome = "pending"
        elif not self._finished_recorded(peer.owner, current) or task is not None and not self._task_finished(task):
            outcome = "unknown"
        else:
            outcome = "stopped" if was_active else "already_finished"
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
        if kind not in {"delta", "stream_end", "progress", "desktop", "widget"}:
            return
        sid, rid = run["session_id"], run["id"]
        self.state.session(owner, sid)
        stored = self.service.store.run(owner, rid)
        if stored["session_id"] != sid or stored["status"] not in {"running", "cancelling"}:
            return
        metadata = self.state.get(owner, "run:" + rid, {})
        task_id = _task(metadata, rid)
        self._record_user(owner, stored, metadata)
        await self._started(owner, stored)
        row = self.service.store.db.execute("SELECT seq,kind,data FROM events WHERE owner=? AND run_id=? ORDER BY seq DESC LIMIT 1", (owner, rid)).fetchone()
        if row is None or row["kind"] != kind or json.loads(row["data"]) != data:
            raise WorkError("protocol_error", "执行进度尚未持久保存。", 503)
        if row["seq"] <= self.state.get(owner, "wire_seq:" + rid, 0):
            return
        key = owner, rid
        index, active = self._streams.get(key, (0, False))
        identity = {"task_id": task_id, "turn_id": rid, "input_id": metadata.get("input_id")}
        persist = True
        if kind == "delta":
            if not active:
                index += 1
                self._stream_text[key] = []
            text = data.get("text")
            if not isinstance(text, str):
                raise WorkError("protocol_error", "模型输出格式无效。", 503)
            self._stream_text[key].append(text)
            record = {"event": "delta", "text": text, "stream_id": rid + ":" + str(index), **identity}
            active = True
        elif kind == "stream_end":
            if type(data.get("resuming")) is not bool:
                raise WorkError("protocol_error", "输出分段格式无效。", 503)
            if not active:
                self.state.set(owner, "wire_seq:" + rid, row["seq"])
                return
            record = {"event": "stream_end", "stream_id": rid + ":" + str(index),
                      "resuming": data["resuming"], **identity}
            active = False
        elif kind == "widget":
            from mona.agent.tools.visualizer import _validate_widget

            widget = {key: data.get(key) for key in ("id", "title", "code", "loadingMessages", "status")}
            if (not isinstance(widget["id"], str) or not 1 <= len(widget["id"]) <= 256
                    or not isinstance(widget["title"], str) or not isinstance(widget["code"], str)
                    or len(widget["code"]) > 128000 or not isinstance(widget["status"], str)
                    or widget["status"] not in {"streaming", "complete", "error"}
                    or not isinstance(widget["loadingMessages"], list) or len(widget["loadingMessages"]) > 4
                    or any(not isinstance(message, str) or len(message) > 1000 for message in widget["loadingMessages"])):
                raise WorkError("protocol_error", "图形事件格式无效。", 503)
            if widget["status"] == "streaming":
                if widget["code"]:
                    raise WorkError("protocol_error", "图形预览尚未通过完整校验。", 503)
                persist = False
            if widget["status"] == "complete" and _validate_widget(widget["code"])[0]:
                raise WorkError("protocol_error", "图形内容未通过校验。", 503)
            widget["title"] = widget["title"][:512]
            if widget["status"] == "error":
                widget["code"] = ""
                widget["error"] = "图形暂时无法展示，请让 Mona 调整后重试。"
            record = {"event": "widget", "widget": widget, "author_id": "mona", "task_id": task_id,
                      "turn_id": rid, "input_id": metadata.get("frame", {}).get("input_id")}
        elif kind == "desktop":
            ui = data.get("agent_ui")
            if data.get("event") in ("task_plan", "goal_state"):
                record = self._task_state(data, sid, rid, task_id, metadata.get("input_id"))
                self.state.set(owner, record["event"] + ":" + sid, {"run_id": rid, "snapshot": record})
                persist = False
            elif data.get("event") == "deliver_files":
                record = {"event": "deliver_files", "task_id": task_id, "inline_media": False,
                          "files": await self._delivery_files(owner, sid, data.get("files"), read_contents=True)}
            elif (data.get("event") != "message" or data.get("kind") != "progress"
                    or not isinstance(data.get("text"), str) or not isinstance(ui, dict)
                    or ui.get("kind") != "office_session" or not isinstance(ui.get("data"), dict)):
                raise WorkError("protocol_error", "编辑器事件格式无效。", 503)
            else:
                session = self._office_state(ui["data"].get("session"))
                record = {"event": "message", "kind": "progress", "text": data["text"], "task_id": task_id,
                          "agent_ui": {"kind": "office_session", "data": {"session": session}}}
        elif data.get("kind") == "context_usage":
            usage = data.get("token_usage")
            if not isinstance(usage, dict):
                raise WorkError("protocol_error", "上下文用量格式无效。", 503)
            record = {"event": "context_usage", "token_usage": usage, **identity}
            persist = False
        elif data.get("kind") == "context_compacting":
            if type(data.get("active")) is not bool:
                raise WorkError("protocol_error", "上下文整理状态无效。", 503)
            record = {"event": "message", "kind": "progress", "text": "",
                      "context_compacting": data["active"], **identity}
        elif data.get("kind") == "file_edit":
            record = {"event": "file_edit", "edits": self._file_edits(owner, data.get("edits")), **identity}
        elif data.get("kind") in {"reasoning_delta", "reasoning_end"}:
            if data["kind"] == "reasoning_delta":
                text = data.get("text")
                if not isinstance(text, str) or not text:
                    self.state.set(owner, "wire_seq:" + rid, row["seq"])
                    return
                self._reasoning_open.add(key)
                record = {"event": "reasoning_delta", "text": text, **identity}
            else:
                self._reasoning_open.discard(key)
                record = {"event": "reasoning_end", **identity}
        else:
            if active:
                ending = {"event": "stream_end", "stream_id": rid + ":" + str(index), **identity}
                self.state.append(owner, sid, ending, f"run:{rid}:event:{row['seq']}:stream_end")
                await self.emit_to_chat(owner, sid, ending)
            active = False
            events = data.get("tool_events")
            message = data.get("message")
            text = message if isinstance(message, str) else ("" if isinstance(events, list) else "正在处理任务")
            record = {"event": "message", "kind": "tool_hint" if data.get("kind") == "tool_hint" else "progress",
                      "text": text, **identity}
            if isinstance(events, list):
                from mona.agent.tool_privacy import redact_tool_arguments

                tools = []
                for event in events:
                    if not isinstance(event, dict) or event.get("phase") not in {"start", "end", "error"}:
                        continue
                    name, call_id, arguments = event.get("name"), event.get("call_id"), event.get("arguments")
                    if not isinstance(name, str) or not name or not isinstance(call_id, str) or not isinstance(arguments, dict):
                        continue
                    tool = {"version": 1, "phase": event["phase"], "call_id": call_id, "name": name,
                            "arguments": redact_tool_arguments(name, arguments)}
                    if event["phase"] == "error":
                        tool["error"] = "操作未能完成，请核对后继续。"
                    tools.append(tool)
                record["tool_events"] = tools
            elif isinstance(data.get("tools"), list):
                record["tool_events"] = [{"version": 1, "phase": "start", "name": name,
                                           "call_id": f"{rid}:{row['seq']}:{i}"}
                                          for i, name in enumerate(data["tools"]) if isinstance(name, str)]
        if persist:
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
        task_id = _task(metadata, rid)
        self._record_user(owner, stored, metadata)
        verified = [item["file"] for item in self.state.get(owner, "artifact_index:" + sid, [])
                    if isinstance(item, dict) and item.get("run_id", item.get("task_id")) == rid and item.get("delivered") is True
                    and isinstance(item.get("file"), dict)]
        delivery = {"event": "deliver_files", "task_id": task_id, "inline_media": False,
                    "files": await self._delivery_files(owner, sid, verified, read_contents=False)} if verified else None
        index, active = self._streams.pop((owner, rid), (0, False))
        if active:
            end = {"event": "stream_end", "stream_id": rid + ":" + str(index), "task_id": task_id,
                   "turn_id": rid, "input_id": metadata.get("input_id")}
            self.state.append(owner, sid, end, "run:" + rid + ":stream_end")
            await self.emit_to_chat(owner, sid, end)
        if (owner, rid) in self._reasoning_open:
            self._reasoning_open.discard((owner, rid))
            end = {"event": "reasoning_end", "task_id": task_id, "turn_id": rid,
                   "input_id": metadata.get("input_id")}
            self.state.append(owner, sid, end, "run:" + rid + ":reasoning_end")
            await self.emit_to_chat(owner, sid, end)
        text = stored["result"].get("content", "")
        streamed = "".join(self._stream_text.pop((owner, rid), []))
        usage = stored["result"].get("final_usage") or stored["result"].get("usage", {})
        record = {"event": "message", "text": text, "task_id": task_id, "turn_id": rid,
                  "input_id": metadata.get("input_id"), "token_usage": usage}
        if index and status == "completed":
            record["stream_id"] = rid + ":" + str(index)
        if not text or status != "completed":
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
            ending = {"event": "turn_end", "turn_id": rid, "input_id": metadata.get("input_id"), "task_id": task_id,
                      "stop_confirmed": True,
                      "token_usage": usage}
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
            self._platform_done.setdefault((owner, rid), (sid, ""))
            while len(self._platform_done) > 256:
                self._platform_done.pop(next(iter(self._platform_done)))

    def cancel_platform_requests(self, owner: str, sid: str) -> None:
        """End waits for this stopped chat; late edits are never replayed."""
        for key, future in tuple(self._platform.items()):
            if key[:2] == (owner, sid) and not future.done():
                future.cancel()

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
        self._reasoning_open.clear()
        for future in self._platform.values():
            if not future.done():
                future.set_exception(WorkError("editor_unavailable", "编辑连接已关闭。", 503))
        self._platform.clear()
        self._platform_done.clear()
        for peer in tuple(self._peers):
            await peer.socket.close(code=1001, message=b"service shutdown")
        self._peers.clear()
