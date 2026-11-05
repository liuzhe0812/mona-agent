"""Use the desktop question tool through the hosted, account-bound parent."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
from contextvars import ContextVar
from dataclasses import replace
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import ValidationError

from mona.agent.tools.ask_user import AskUserQuestionTool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META
from mona.bus.events import OutboundMessage
from mona.bus.user_questions import QuestionAnswer, UserQuestion
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.sandbox_files import relative_path
from mona.utils.helpers import detect_image_mime

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_TOKEN = re.compile(r"^[\x21-\x7e]{1,8192}$")
_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})


class RunRPC:
    """Account-bound transport for one trusted hosted run; no sandbox credentials."""

    def __init__(self, config: HostedWorkConfig, payload: dict, sandbox, emit, pending_files: list[dict]):
        owner, token = payload.get("owner"), payload.get("account_token")
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("invalid_identity", "登录身份无效，请重新登录。", 401)
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            raise WorkError("login_required", "请重新登录后继续。", 401)
        self.session_id, self.run_id = identifier(payload.get("session_id")), identifier(payload.get("run_id"))
        if not isinstance(pending_files, list):
            raise WorkError("invalid_request", "待交付文件记录无效。")
        host, origin = private_listener(config.bind_host), website_origin(config)
        authority = f"[{host}]" if ":" in host else host
        self.url = f"http://{authority}:{config.port}/api/work/desktop/internal/tool"
        self.headers = {"Authorization": "Bearer " + token, "Host": urlsplit(origin).netloc,
                        "Origin": origin, "Accept": "application/json"}
        self.config, self.sandbox, self.emit, self.pending_files = config, sandbox, emit, pending_files
        self.ask_id: ContextVar[str | None] = ContextVar("hosted_question_ask_id", default=None)

    async def _stop(self, message: str) -> None:
        try:
            await self.emit("progress", {"message": message})
        finally:
            raise asyncio.CancelledError(message) from None

    async def _post(self, command: str, args: dict) -> dict:
        body = {"run_id": self.run_id, "session_id": self.session_id, "command": command, "args": args}
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=35) as client:
                    async with client.stream("POST", self.url, json=body, headers=self.headers) as response:
                        if response.status_code >= 500:
                            if attempt < 2:
                                continue
                            await self._stop("会话服务暂不可用，本轮已停止并保留进度。")
                        if response.status_code in {401, 403, 404, 409}:
                            await self._stop("会话已结束或登录失效，本轮已停止并保留进度。")
                        if response.status_code in {400, 413, 422} and command == "question_preview":
                            raise WorkError("question_unavailable", "提问或样张暂时无法发送，请检查后重试。", 503)
                        if (response.status_code != 200 or
                                response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json"):
                            await self._stop("会话回执无法确认，本轮已停止并保留进度。")
                        data = bytearray()
                        async for chunk in response.aiter_bytes():
                            data.extend(chunk)
                            if len(data) > self.config.max_history_bytes:
                                await self._stop("会话回执无法确认，本轮已停止并保留进度。")
                value = json.loads(data)
                if not isinstance(value, dict) or not isinstance(value.get("result"), dict):
                    await self._stop("会话回执无法确认，本轮已停止并保留进度。")
                return value["result"]
            except httpx.HTTPError:
                if attempt == 2:
                    await self._stop("会话连接暂不可用，本轮已停止并保留进度。")
            except (ValueError, UnicodeError):
                await self._stop("会话回执无法确认，本轮已停止并保留进度。")
        raise AssertionError("unreachable")

class RemoteUserQuestions(RunRPC):
    """Proxy the shared tool's ask operation through the run-scoped transport."""

    async def ask(self, chat_id: str, agent_id: str, questions: list[UserQuestion]) -> dict:
        ask_id = self.ask_id.get()
        if chat_id != self.session_id or agent_id != "mona" or not ask_id:
            raise WorkError("invalid_request", "提问不属于当前会话。")
        args = {"ask_id": ask_id, "questions": [question.model_dump(mode="json", exclude_none=True)
                                                for question in questions]}
        try:
            async with asyncio.timeout(self.config.question_timeout_seconds):
                while True:
                    value = await self._post("user_question", args)
                    status = value.get("status")
                    if status == "pending":
                        # The parent normally waits before returning pending. A
                        # faulty immediate reply must still yield to cancellation.
                        await asyncio.sleep(0.05)
                        continue
                    if status == "cancelled" or value.get("cancelled") is True:
                        await self._stop("提问已取消，本轮已停止并保留进度。")
                    if status == "answered" or status is None and "answers" in value:
                        try:
                            answers = [QuestionAnswer.model_validate(item) for item in value["answers"]]
                            if (len(answers) != len(questions) or
                                    {answer.id for answer in answers} != {question.id for question in questions}):
                                raise ValueError("invalid answer ids")
                            by_id = {answer.id: answer for answer in answers}
                            for question in questions:
                                answer = by_id[question.id]
                                labels = {option.label for option in question.options}
                                if (len(set(answer.selected)) != len(answer.selected)
                                        or any(item not in labels for item in answer.selected)
                                        or (not question.multi_select and len(answer.selected) > 1)
                                        or not answer.selected and not (answer.custom or "").strip()):
                                    raise ValueError("invalid answer selection")
                        except (ValidationError, ValueError, TypeError, KeyError):
                            await self._stop("提问回执无法确认，本轮已停止并保留进度。")
                        return {"answers": [answer.model_dump(exclude_none=True) for answer in answers]}
                    await self._stop("提问回执无法确认，本轮已停止并保留进度。")
        except TimeoutError:
            await self._stop("等待回答已超时，本轮已停止并保留进度。")

    async def preview(self, message: OutboundMessage) -> None:
        ask_id = self.ask_id.get()
        if (message.channel != "websocket" or message.chat_id != self.session_id or not ask_id
                or message.metadata.get("_question_preview") is not True):
            raise WorkError("invalid_request", "样张不属于当前会话。")
        supplied = message.metadata.get("_deliver_files")
        if not isinstance(supplied, list) or not supplied:
            raise WorkError("invalid_request", "样张文件记录无效。")
        files, selected, total = [], set(), 0
        for item in supplied:
            if not isinstance(item, dict):
                raise WorkError("invalid_request", "样张文件记录无效。")
            try:
                path = relative_path(item.get("path"))
            except (ValueError, TypeError):
                raise WorkError("invalid_request", "样张路径无效，请重新准备文件。") from None
            name, mime, size, digest = PurePosixPath(path).name, item.get("mime"), item.get("size"), item.get("sha256")
            if (item.get("name") != name or mime not in _IMAGE_TYPES or type(size) is not int
                    or size <= 0 or size > self.config.max_file_bytes or not isinstance(digest, str)
                    or not _DIGEST.fullmatch(digest)):
                raise WorkError("invalid_request", "样张格式或大小无效，请使用 PNG、JPEG 或 WebP。")
            key = path, digest
            if key in selected:
                continue
            total += size
            if total > self.config.max_history_bytes:
                raise WorkError("file_limit", "样张总大小超过允许范围。", 413)
            try:
                value = await self.sandbox.file({"action": "download", "path": path})
                encoded = value.get("data") if isinstance(value, dict) else None
                if not isinstance(encoded, str) or len(encoded) > 4 * ((self.config.max_file_bytes + 2) // 3):
                    raise ValueError("invalid preview")
                data = base64.b64decode(encoded, validate=True)
                if (value.get("path") != path or value.get("name") != name or value.get("size") != size
                        or value.get("sha256") != digest or len(data) != size
                        or hashlib.sha256(data).hexdigest() != digest or detect_image_mime(data) != mime):
                    raise ValueError("preview changed")
            except (OSError, ValueError, TypeError, binascii.Error, WorkError, TimeoutError):
                raise WorkError("file_changed", "样张未通过核对，请重新准备文件后再选择。", 409) from None
            selected.add(key)
            files.append({"name": name, "mime": mime, "size": size, "sha256": digest, "data": encoded})
        result = await self._post("question_preview", {"ask_id": ask_id, "files": files})
        if result.get("ok") is not True:
            await self._stop("样张结果尚未确认，本轮已停止并保留进度。")
        kept = []
        for item in self.pending_files:
            try:
                key = relative_path(item.get("path")), item.get("sha256")
            except (ValueError, TypeError, AttributeError):
                key = None
            if not isinstance(item, dict) or item.get("mime") not in _IMAGE_TYPES or key not in selected:
                kept.append(item)
        self.pending_files[:] = kept


class HostedAskUserQuestionTool(AskUserQuestionTool):
    def __init__(self, remote: RemoteUserQuestions):
        self.remote = remote
        super().__init__(questions=remote, agent_id="mona", send_callback=remote.preview)
        self.set_context(RequestContext(channel="websocket", chat_id=remote.session_id,
            session_key="websocket:" + remote.session_id, metadata={DELIVER_FILES_PENDING_META: remote.pending_files}))

    def set_context(self, ctx: RequestContext) -> None:
        expected = "websocket:" + self.remote.session_id
        if ctx.channel != "websocket" or ctx.chat_id != self.remote.session_id or ctx.session_key not in (None, expected):
            raise WorkError("invalid_request", "提问不属于当前会话。")
        super().set_context(replace(ctx, session_key=expected,
            metadata={**ctx.metadata, DELIVER_FILES_PENDING_META: self.remote.pending_files}))

    async def execute(self, questions: list[dict], **kwargs: Any) -> Any:
        ask_token = self.remote.ask_id.set(uuid4().hex)
        ctx = self._context.get()
        context_token = None
        try:
            if ctx is not None:
                # The shared tool clears its pending list after preview. Give it
                # only images so non-image deliveries stay queued for the end.
                images = [item for item in self.remote.pending_files if isinstance(item, dict)
                          and isinstance(item.get("mime"), str) and item["mime"].startswith("image/")]
                context_token = self._context.set(replace(ctx, metadata={**ctx.metadata, DELIVER_FILES_PENDING_META: images}))
            return await super().execute(questions, **kwargs)
        finally:
            if context_token is not None:
                self._context.reset(context_token)
            self.remote.ask_id.reset(ask_token)


def build_question_tool(config: HostedWorkConfig, payload: dict, sandbox, emit,
                        pending_files: list[dict]) -> AskUserQuestionTool:
    return HostedAskUserQuestionTool(RemoteUserQuestions(config, payload, sandbox, emit, pending_files))
