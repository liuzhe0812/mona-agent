"""OpenAI-compatible HTTP API server for a fixed mona session.

Provides /v1/chat/completions and /v1/models endpoints.
All requests route to a single persistent API session.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import imaplib
import json as _json
import re
import smtplib
import ssl
import time
import uuid
from datetime import datetime
from email import policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, formatdate, getaddresses, parseaddr
from pathlib import Path
from typing import Any, Callable, TypeVar
from urllib.parse import quote

from aiohttp import web
from loguru import logger

from mona.api.hoard_handlers import (
    handle_hoard_add,
    handle_hoard_delete_by_url,
)
from mona.api.url2note import Url2NoteError, Url2NoteExtractor
from mona.config.paths import get_media_dir, get_workspace_path
from mona.email.imap_pool import imap_pool_manager
from mona.materials.api import (
    handle_materials_create_directory,
    handle_materials_delete,
    handle_materials_delete_wiki_page,
    handle_materials_extract,
    handle_materials_get_raw,
    handle_materials_get_raw_binary,
    handle_materials_get_text,
    handle_materials_get_wiki_page,
    handle_materials_list_files,
    handle_materials_list_wiki,
    handle_materials_llm_config,
    handle_materials_move,
    handle_materials_search,
    handle_materials_status,
    handle_materials_write_wiki_page,
)
from mona.security.network import validate_host
from mona.system_agent import handle_system_plan
from mona.utils.helpers import safe_filename
from mona.utils.media_decode import (
    MAX_FILE_SIZE,
)
from mona.utils.media_decode import (
    FileSizeExceeded as _FileSizeExceeded,
)
from mona.utils.media_decode import (
    save_base64_data_url as _save_base64_data_url,
)
from mona.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

__all__ = (
    "MAX_FILE_SIZE",
    "_FileSizeExceeded",
    "_save_base64_data_url",
    "create_app",
    "handle_chat_completions",
    # Re-exported for mona.services.server (services process imports these
    # handlers from here rather than reaching into each source module).
    "handle_hoard_add",
    "handle_hoard_delete_by_url",
    "handle_materials_create_directory",
    "handle_materials_delete",
    "handle_materials_delete_wiki_page",
    "handle_materials_extract",
    "handle_materials_get_raw",
    "handle_materials_get_raw_binary",
    "handle_materials_get_text",
    "handle_materials_get_wiki_page",
    "handle_materials_list_files",
    "handle_materials_list_wiki",
    "handle_materials_llm_config",
    "handle_materials_move",
    "handle_materials_search",
    "handle_materials_status",
    "handle_materials_write_wiki_page",
)


API_SESSION_KEY = "api:default"
API_CHAT_ID = "default"


def _resolve_llm_provider(request: web.Request) -> Any | None:
    """Resolve an LLM provider for non-agent business handlers.

    Prefers the gateway AgentLoop's live provider; falls back to building one
    from config.json so the services process (no AgentLoop) can serve the
    same routes autonomously.
    """
    agent_loop = request.app.get("agent_loop")
    provider = getattr(agent_loop, "provider", None)
    if provider is not None:
        return provider
    try:
        from mona.providers.factory import load_provider_snapshot

        return load_provider_snapshot().provider
    except Exception:
        logger.debug("could not build provider from config snapshot")
        return None


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


_T = TypeVar("_T")

# 按 IMAP 账号串行化操作，避免部分邮箱（如 QQ 邮箱）因并发连接被限制导致 LIST 返回空
_IMAP_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


def _imap_lock_key(body: dict[str, Any]) -> tuple[str, str] | None:
    host = str(body.get("imapHost", "") or "").strip()
    username = str(body.get("imapUsername", "") or "").strip()
    if not host or not username:
        return None
    return (host, username)


async def _run_imap_locked(
    body: dict[str, Any],
    func: Callable[[dict[str, Any]], _T],
    max_retries: int = 1,
) -> _T:
    """在 IMAP 账号级锁保护下执行阻塞的 IMAP 操作，带指数退避重试。

    对网络瞬时故障（连接超时、连接重置、EOF）自动重试最多 max_retries 次，
    退避间隔 1s → 2s → 4s。对业务错误（登录失败、文件夹不存在）不重试。
    """
    key = _imap_lock_key(body)
    if key is None:
        return await _retry_imap_call(func, body, max_retries=max_retries)
    if key not in _IMAP_LOCKS:
        _IMAP_LOCKS[key] = asyncio.Lock()
    async with _IMAP_LOCKS[key]:
        return await _retry_imap_call(func, body, max_retries=max_retries)


# 可重试的异常特征（网络瞬时故障）
_RETRYABLE_ERRORS = (
    TimeoutError,
    ConnectionError,
    OSError,
    imaplib.IMAP4.abort,
    imaplib.IMAP4.readonly,
)


def _is_retryable_error(e: Exception) -> bool:
    """判断异常是否为可重试的瞬时网络故障。"""
    # Python 3.14+ 将 smtplib.SMTPException 改为继承 OSError，
    # 导致 SMTPAuthenticationError（535 认证失败）被误判为可重试。
    # SMTP 认证/权限错误是永久性业务错误，重试只会加剧邮箱风控。
    if isinstance(e, smtplib.SMTPResponseException):
        return False
    if isinstance(e, _RETRYABLE_ERRORS):
        return True
    msg = str(e).lower()
    retryable_markers = (
        "timeout", "timed out", "connection reset", "broken pipe",
        "eof", "connection closed", "connection aborted", "temporarily unavailable",
        "socket", "network is unreachable", "connection refused",
        # 连接池中残留的 LOGOUT 状态连接被复用时，服务器返回此错误。
        # 内层 imap_pool.run 已会重试一次，外层兜底再重试一次以确保恢复。
        "illegal in state", "logout",
    )
    return any(m in msg for m in retryable_markers)


async def _retry_imap_call(
    func: Callable[[dict[str, Any]], _T],
    body: dict[str, Any],
    max_retries: int = 3,
) -> _T:
    """执行 IMAP 调用，对瞬时网络故障做指数退避重试。"""
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return await asyncio.to_thread(func, body)
        except Exception as e:
            last_error = e
            if attempt >= max_retries or not _is_retryable_error(e):
                raise
            backoff = 2 ** attempt  # 1s, 2s, 4s
            logger.warning(
                f"[imap] retryable error (attempt {attempt + 1}/{max_retries + 1}): {e}, "
                f"retry in {backoff}s"
            )
            await asyncio.sleep(backoff)
    # 理论上不会到达
    assert last_error is not None
    raise last_error


# ---------------------------------------------------------------------------
# IMAP IDLE 实时推送
# ---------------------------------------------------------------------------
# 每个邮箱账号一个后台线程，保持 IMAP IDLE 长连接。
# 服务器推送新邮件通知时，通过 WebSocket 广播事件给前端，前端再触发同步。
# 用 imaplib 手动实现 IDLE（RFC 2177），不引入新依赖。

import select  # noqa: E402
import threading  # noqa: E402


class _IdleWorker:
    """单个账号的 IDLE 监听线程。

    支持监听多个文件夹（INBOX + Sent + Drafts + Junk + Trash），
    每个文件夹一条 IMAP IDLE 长连接。
    收到服务器推送或超时后触发回调，通过 WebSocket 广播事件给前端。
    使用指数退避重连，避免网络抖动导致频繁重连。
    """

    def __init__(
        self,
        account_id: str,
        config: dict[str, Any],
        on_notification: Callable[[str, str], None],
    ):
        self._account_id = account_id
        self._config = config
        self._on_notification = on_notification
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._idle_tag: bytes | None = None
        self._client: imaplib.IMAP4 | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name=f"idle-{self._account_id}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._send_done()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    def _run(self) -> None:
        backoff = 1
        while not self._stop_event.is_set():
            try:
                self._idle_loop()
                backoff = 1
            except Exception as e:
                if self._stop_event.is_set():
                    return
                err_msg = str(e).lower()
                # 永久性认证错误（密码错误/账号异常/频率限制）：停止重试
                # 否则 IDLE 疯狂重试会导致邮箱服务器对该账号限流，
                # 拖垮 fetch_body 等正常 IMAP 操作
                permanent_markers = (
                    # 英文
                    "login fail",
                    "password",
                    "authentication failed",
                    "account is abnormal",
                    "service is not open",
                    "login frequency limited",
                    # 中文（腾讯/网易/阿里常见提示）
                    "认证失败",
                    "密码错误",
                    "账号异常",
                    "账户异常",
                    "登录失败",
                    "登录频率",
                    "频率限制",
                    "服务未开通",
                    "暂时禁止登录",
                    "不允许尝试登录",
                )
                if any(m in err_msg for m in permanent_markers):
                    logger.error(
                        f"[idle] {self._account_id} permanent auth error: {e}, "
                        f"stopping IDLE to avoid rate limiting"
                    )
                    return
                logger.debug(
                    f"[idle] {self._account_id} error: {e}, retry in {backoff}s"
                )
                self._stop_event.wait(backoff)
                backoff = min(backoff * 2, 60)

    def _get_mailboxes_to_monitor(self, client: imaplib.IMAP4) -> list[str]:
        """获取需要 IDLE 监听的文件夹列表。

        优先从配置的 mailbox 字段读取，如果配置了 'mailboxes' 列表则用列表，
        否则默认只监听 INBOX（避免占用过多 IMAP 并发连接配额，
        QQ/163 等邮箱对并发连接数有严格限制）。
        """
        # 如果配置中指定了 mailboxes 列表，直接使用
        mailboxes_cfg = self._config.get("mailboxes")
        if mailboxes_cfg and isinstance(mailboxes_cfg, list):
            return [str(m).strip() for m in mailboxes_cfg if str(m).strip()]

        # 默认：只监听配置的 mailbox（通常是 INBOX）
        mailbox = str(self._config.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
        return [mailbox]

    def _idle_loop(self) -> None:
        """建立连接并进入 IDLE 循环，直到 stop 或连接断开。"""
        host = str(self._config.get("imapHost", "")).strip()
        port = int(self._config.get("imapPort", 993) or 993)
        username = str(self._config.get("imapUsername", "")).strip()
        password = str(self._config.get("imapPassword", "") or "")
        use_ssl = bool(self._config.get("useSsl", True))

        if not host or not username:
            raise ValueError("imapHost and imapUsername are required for IDLE")

        _validate_mail_host(host)

        if use_ssl:
            client = imaplib.IMAP4_SSL(host, port, timeout=30)
        else:
            client = imaplib.IMAP4(host, port, timeout=30)

        self._client = client
        try:
            client.login(username, password)

            # 获取需要监听的文件夹列表
            mailboxes = self._get_mailboxes_to_monitor(client)
            logger.info(f"[idle] account connected, monitoring: {mailboxes}")

            # 为每个文件夹创建独立的 IDLE 连接
            # 使用线程池并行监听多个文件夹
            if len(mailboxes) <= 1:
                # 单文件夹：保持原有逻辑
                mailbox = mailboxes[0] if mailboxes else "INBOX"
                status, _ = client.select(_imap_quote_mailbox(mailbox))
                if status != "OK":
                    raise RuntimeError(f"select {mailbox} failed: {status}")
                while not self._stop_event.is_set():
                    self._do_idle_cycle(timeout=29 * 60)
                    if self._stop_event.is_set():
                        break
                    try:
                        self._on_notification(self._account_id, mailbox)
                    except Exception as e:
                        logger.warning(f"[idle] {self._account_id} callback error: {e}")
            else:
                # 多文件夹：每个文件夹一个子线程
                sub_threads: list[threading.Thread] = []
                sub_stop = threading.Event()

                def _monitor_mailbox(mb: str, mb_client: imaplib.IMAP4) -> None:
                    """子线程：监听单个文件夹。"""
                    try:
                        status, _ = mb_client.select(_imap_quote_mailbox(mb))
                        if status != "OK":
                            logger.warning(f"[idle] {self._account_id} select {mb} failed: {status}")
                            return
                        worker = _IdleWorker(self._account_id, self._config, self._on_notification)
                        worker._client = mb_client
                        worker._stop_event = sub_stop
                        while not sub_stop.is_set():
                            worker._do_idle_cycle(timeout=29 * 60)
                            if sub_stop.is_set():
                                break
                            try:
                                worker._on_notification(self._account_id, mb)
                            except Exception as e:
                                logger.warning(f"[idle] {self._account_id} callback error for {mb}: {e}")
                    except Exception as e:
                        if not sub_stop.is_set():
                            logger.warning(f"[idle] {self._account_id} mailbox {mb} error: {e}")

                for mb in mailboxes[1:]:
                    # 为每个额外文件夹创建独立连接
                    try:
                        if use_ssl:
                            mb_client = imaplib.IMAP4_SSL(host, port, timeout=30)
                        else:
                            mb_client = imaplib.IMAP4(host, port, timeout=30)
                        mb_client.login(username, password)
                        t = threading.Thread(
                            target=_monitor_mailbox, args=(mb, mb_client),
                            name=f"idle-{self._account_id}-{mb}", daemon=True
                        )
                        t.start()
                        sub_threads.append(t)
                    except Exception as e:
                        logger.warning(f"[idle] {self._account_id} failed to start monitor for {mb}: {e}")

                # 主连接监听第一个文件夹
                mailbox = mailboxes[0]
                status, _ = client.select(_imap_quote_mailbox(mailbox))
                if status != "OK":
                    raise RuntimeError(f"select {mailbox} failed: {status}")
                while not self._stop_event.is_set():
                    self._do_idle_cycle(timeout=29 * 60)
                    if self._stop_event.is_set():
                        break
                    try:
                        self._on_notification(self._account_id, mailbox)
                    except Exception as e:
                        logger.warning(f"[idle] {self._account_id} callback error: {e}")

                # 停止子线程
                sub_stop.set()
                for t in sub_threads:
                    t.join(timeout=3)
        finally:
            self._client = None
            try:
                client.close()
            except Exception:
                pass
            try:
                client.logout()
            except Exception:
                pass

    def _do_idle_cycle(self, timeout: int) -> None:
        """发送 IDLE 命令，等待通知或超时，然后发送 DONE。"""
        client = self._client
        if client is None:
            return

        # 发送 IDLE 命令（手动构造，imaplib 无原生支持）
        # Python 3.14 的 _new_tag() 返回 bytes，旧版本返回 str
        tag = client._new_tag()
        if isinstance(tag, str):
            tag = tag.encode("ascii")
        client.send(tag + b" IDLE\r\n")
        self._idle_tag = tag

        # 等待 "+ idling" 响应
        deadline = time.time() + 10
        while time.time() < deadline:
            line = client.readline()
            if line.startswith(b"+"):
                break
        else:
            # 未收到 continuation 响应，退出
            self._idle_tag = None
            return

        # 等待服务器推送（未标记响应）或超时
        sock = client.sock
        start = time.time()
        while not self._stop_event.is_set():
            remaining = timeout - (time.time() - start)
            if remaining <= 0:
                break
            try:
                readable, _, _ = select.select([sock], [], [], min(remaining, 30))
            except (OSError, ValueError):
                break
            if readable:
                try:
                    line = client.readline()
                except (OSError, imaplib.IMAP4.error):
                    break
                # 空行表示连接已关闭
                if not line:
                    break
                # 未标记响应（如 "* 5 EXISTS"）表示有新邮件或状态变化
                if line.startswith(b"* "):
                    break

        # 发送 DONE 结束 IDLE
        self._send_done()

    def _send_done(self) -> None:
        """发送 DONE 命令结束 IDLE 状态。"""
        client = self._client
        tag = self._idle_tag
        if client is None or tag is None:
            return
        try:
            client.send(b"DONE\r\n")
            # 读取 IDLE 结束响应（tag + OK）
            deadline = time.time() + 5
            while time.time() < deadline:
                line = client.readline()
                if line.startswith(tag + b" "):
                    break
        except Exception:
            pass
        finally:
            self._idle_tag = None


class _IdleManager:
    """管理多个账号的 IDLE 监听，并通过 WebSocket 广播新邮件事件。"""

    def __init__(self) -> None:
        self._workers: dict[str, _IdleWorker] = {}
        self._lock = threading.Lock()
        self._ws_clients: set[web.WebSocketResponse] = set()
        self._ws_lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def _broadcast(self, account_id: str, mailbox: str = "INBOX") -> None:
        """从工作线程调用，通过事件循环广播 WebSocket 事件。"""
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._async_broadcast(account_id, mailbox), self._loop)

    async def _async_broadcast(self, account_id: str, mailbox: str = "INBOX") -> None:
        async with self._ws_lock:
            dead = []
            for ws in self._ws_clients:
                try:
                    await ws.send_json({"type": "new-mail", "accountId": account_id, "mailbox": mailbox})
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._ws_clients.discard(ws)

    async def add_ws_client(self, ws: web.WebSocketResponse) -> None:
        async with self._ws_lock:
            self._ws_clients.add(ws)

    async def remove_ws_client(self, ws: web.WebSocketResponse) -> None:
        async with self._ws_lock:
            self._ws_clients.discard(ws)

    def start_account(self, account_id: str, config: dict[str, Any]) -> None:
        with self._lock:
            if account_id in self._workers:
                self._workers[account_id].stop()
            worker = _IdleWorker(account_id, config, self._broadcast)
            self._workers[account_id] = worker
            worker.start()

    def stop_account(self, account_id: str) -> None:
        with self._lock:
            worker = self._workers.pop(account_id, None)
        if worker:
            worker.stop()

    def stop_all(self) -> None:
        with self._lock:
            workers = list(self._workers.values())
            self._workers.clear()
        for w in workers:
            w.stop()

    def list_active(self) -> list[str]:
        with self._lock:
            return list(self._workers.keys())


_idle_manager = _IdleManager()


def _error_json(status: int, message: str, err_type: str = "invalid_request_error") -> web.Response:
    return web.json_response(
        {"error": {"message": message, "type": err_type, "code": status}},
        status=status,
    )


def _chat_completion_response(content: str, model: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _response_text(value: Any) -> str:
    """Normalize process_direct output to plain assistant text."""
    if value is None:
        return ""
    if hasattr(value, "content"):
        return str(getattr(value, "content") or "")
    return str(value)

# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------


def _sse_chunk(delta: str, model: str, chunk_id: str, finish_reason: str | None = None) -> bytes:
    """Format a single OpenAI-compatible SSE chunk."""
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": delta} if delta else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {_json.dumps(payload)}\n\n".encode()


_SSE_DONE = b"data: [DONE]\n\n"

# ---------------------------------------------------------------------------
# Upload helpers
# ---------------------------------------------------------------------------


def _parse_json_content(body: dict) -> tuple[str, list[str]]:
    """Parse JSON request body. Returns (text, media_paths)."""
    messages = body.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        raise ValueError("Only a single user message is supported")
    message = messages[0]
    if not isinstance(message, dict) or message.get("role") != "user":
        raise ValueError("Only a single user message is supported")

    user_content = message.get("content", "")
    media_dir = get_media_dir("api")
    media_paths: list[str] = []

    if isinstance(user_content, list):
        text_parts: list[str] = []
        for part in user_content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text_parts.append(part.get("text", ""))
            elif part.get("type") == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    saved = _save_base64_data_url(url, media_dir)
                    if saved:
                        media_paths.append(saved)
                elif url:
                    raise ValueError(
                        "Remote image URLs are not supported. "
                        "Use base64 data URLs or upload files via multipart/form-data."
                    )
        text = " ".join(text_parts)
    elif isinstance(user_content, str):
        text = user_content
    else:
        raise ValueError("Invalid content format")

    return text, media_paths


async def _parse_multipart(request: web.Request) -> tuple[str, list[str], str | None, str | None]:
    """Parse multipart/form-data. Returns (text, media_paths, session_id, model)."""
    media_dir = get_media_dir("api")
    reader = await request.multipart()
    text = ""
    session_id = None
    model = None
    media_paths: list[str] = []

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "message":
            text = (await part.read()).decode("utf-8")
        elif part.name == "session_id":
            session_id = (await part.read()).decode("utf-8").strip()
        elif part.name == "model":
            model = (await part.read()).decode("utf-8").strip()
        elif part.name == "files":
            raw = await part.read()
            if len(raw) > MAX_FILE_SIZE:
                raise _FileSizeExceeded(
                    f"File '{part.filename}' exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit"
                )
            base = safe_filename(part.filename or "upload.bin")
            filename = f"{uuid.uuid4().hex[:12]}_{base}"
            dest = media_dir / filename
            dest.write_bytes(raw)
            media_paths.append(str(dest))

    if not text:
        text = "请分析上传的文件"

    return text, media_paths, session_id, model


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


def _session_set_workspace_impl(
    session_manager,
    key: str,
    workspace: str | None,
) -> tuple[dict, int]:
    """Apply workspace binding to a session; return (body, status).

    ``workspace=None`` clears the binding (session returns to default "会话").
    """
    if session_manager is None:
        return {"error": "session manager unavailable"}, 503
    if not key.startswith("websocket:"):
        return {"error": "only websocket sessions can be bound to a project"}, 400
    session = session_manager.get_or_create(key)
    if workspace is None or not workspace.strip():
        session.metadata.pop("workspace", None)
    else:
        session.metadata["workspace"] = workspace.strip()
    session_manager.save(session)
    return {"ok": True, "workspace": session.metadata.get("workspace")}, 200


async def handle_session_set_workspace(request: web.Request) -> web.Response:
    """POST /api/sessions/{key}/set-workspace  body: {"workspace": "..."}

    Binds (or re-binds) a session to a project working directory.
    """
    agent_loop = request.app.get("agent_loop")
    session_manager = getattr(agent_loop, "sessions", None)
    key = request.match_info["key"]
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    workspace = payload.get("workspace") if isinstance(payload, dict) else None
    if not isinstance(workspace, str):
        return web.json_response({"error": "workspace must be a string"}, status=400)
    body, status = _session_set_workspace_impl(session_manager, key, workspace)
    return web.json_response(body, status=status)


async def handle_session_clear_workspace(request: web.Request) -> web.Response:
    """POST /api/sessions/{key}/clear-workspace

    Removes the workspace binding; session returns to the default "会话" section.
    """
    agent_loop = request.app.get("agent_loop")
    session_manager = getattr(agent_loop, "sessions", None)
    key = request.match_info["key"]
    body, status = _session_set_workspace_impl(session_manager, key, None)
    return web.json_response(body, status=status)


async def handle_projects_list(request: web.Request) -> web.Response:
    """GET /api/projects

    Returns the distinct list of project workspaces bound to sessions.
    Used by the sidebar to render project sections even when the user
    clears all sessions in a project (so the project section remains
    discoverable until manually removed).
    """
    agent_loop = request.app.get("agent_loop")
    session_manager = getattr(agent_loop, "sessions", None)
    if session_manager is None:
        return web.json_response({"projects": []})
    seen: list[str] = []
    seen_set: set[str] = set()
    for s in session_manager.list_sessions():
        ws = s.get("workspace")
        if isinstance(ws, str) and ws.strip() and ws not in seen_set:
            seen_set.add(ws)
            seen.append(ws)
    return web.json_response({"projects": seen})


async def handle_project_remove(request: web.Request) -> web.Response:
    """POST /api/projects/remove

    Clears the workspace binding for all sessions in the given project,
    effectively removing the project section from the sidebar.
    """
    agent_loop = request.app.get("agent_loop")
    session_manager = getattr(agent_loop, "sessions", None)
    if session_manager is None:
        return web.json_response({"ok": False}, status=500)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    workspace = body.get("workspace")
    if not isinstance(workspace, str) or not workspace.strip():
        return web.json_response({"ok": False, "error": "workspace required"}, status=400)
    cleared = 0
    for s in session_manager.list_sessions():
        if s.get("workspace") == workspace:
            _session_set_workspace_impl(session_manager, s["key"], None)
            cleared += 1
    return web.json_response({"ok": True, "cleared": cleared})


# ---------------------------------------------------------------------------
# Profile (user distillation) routes
# ---------------------------------------------------------------------------


def _get_memory_dir_for_profile() -> Any:
    from mona.config.paths import get_memory_dir
    return get_memory_dir()


async def handle_profile_get(request: web.Request) -> web.Response:
    """GET /api/profile — return profile.rich.json content."""
    from mona.distill.store import read_rich_profile

    memory_dir = _get_memory_dir_for_profile()
    data = read_rich_profile(memory_dir)
    return web.json_response(data)


async def handle_profile_user_get(request: web.Request) -> web.Response:
    """GET /api/profile/user — return USER.md content."""
    from mona.distill.store import read_user_profile

    memory_dir = _get_memory_dir_for_profile()
    content = read_user_profile(memory_dir)
    return web.json_response({"content": content})


async def handle_profile_user_update(request: web.Request) -> web.Response:
    """PATCH /api/profile/user — update USER.md section or full content."""
    from mona.distill.store import update_user_section

    try:
        body = await request.json()
    except Exception:
        return _error_json(400, "Invalid JSON body")

    section = body.get("section")
    content = body.get("content")
    full = body.get("full")

    memory_dir = _get_memory_dir_for_profile()
    user_path = memory_dir / "USER.md"

    if isinstance(full, str):
        user_path.write_text(full, encoding="utf-8")
        return web.json_response({"ok": True, "mode": "full"})

    if not isinstance(section, str) or not section.strip():
        return _error_json(400, "section is required (or provide full content)")
    if not isinstance(content, str):
        return _error_json(400, "content is required")

    update_user_section(user_path, section, content)
    return web.json_response({"ok": True, "mode": "section", "section": section})


async def handle_profile_distill(request: web.Request) -> web.Response:
    """POST /api/profile/distill — trigger distillation manually.

    Body: {"task": "work-pattern" | "profile" | "all"} (default: "all")
    """
    from mona.distill.service import (
        run_all_distill,
        run_profile_distill,
        run_work_pattern_distill,
    )

    try:
        body = await request.json()
    except Exception:
        body = {}
    task = body.get("task", "all") if isinstance(body, dict) else "all"

    # 从 gateway app 获取已初始化的 agent_loop（含 provider）
    agent_loop = request.app.get("agent_loop")

    if task == "work-pattern":
        result = await run_work_pattern_distill(agent_loop)
    elif task == "profile":
        result = await run_profile_distill(agent_loop)
    else:
        results = await run_all_distill(agent_loop)
        return web.json_response({
            "ok": True,
            "results": [
                {
                    "task": r.task_name,
                    "success": r.success,
                    "confidence": r.confidence,
                    "error": r.error,
                }
                for r in results
            ],
        })

    return web.json_response({
        "ok": result.success,
        "task": result.task_name,
        "confidence": result.confidence,
        "error": result.error,
    })


async def handle_profile_snapshots(request: web.Request) -> web.Response:
    """GET /api/profile/snapshots — list all historical snapshots."""
    from mona.config.paths import get_memory_dir
    from mona.distill.scoring import load_snapshots

    snapshots = load_snapshots(get_memory_dir())
    return web.json_response({"snapshots": snapshots})


async def handle_profile_comparison(request: web.Request) -> web.Response:
    """GET /api/profile/comparison?date=YYYY-MM-DD — get current vs previous snapshot."""
    from mona.config.paths import get_memory_dir
    from mona.distill.scoring import compute_growth_comparison, load_snapshots

    current_date = request.query.get("date")
    snapshots = load_snapshots(get_memory_dir())
    if not snapshots:
        return web.json_response({"comparison": None, "snapshots": []})

    if current_date:
        current = next((s for s in snapshots if s.get("date") == current_date), None)
        if current is None and snapshots:
            current = snapshots[-1]
    else:
        current = snapshots[-1]

    previous = None
    if current:
        current_date_str = current.get("date", "")
        prev_list = [s for s in snapshots if s.get("date", "") < current_date_str]
        previous = prev_list[-1] if prev_list else None

    comparison = compute_growth_comparison(
        {
            "radar_scores": current.get("radar_scores", []) if current else [],
            "keywords": current.get("keywords", []) if current else [],
            "snapshot_date": current.get("date") if current else None,
        },
        {
            "radar_scores": previous.get("radar_scores", []) if previous else [],
            "keywords": previous.get("keywords", []) if previous else [],
            "snapshot_date": previous.get("date") if previous else None,
        } if previous else None,
    )

    return web.json_response({
        "comparison": comparison,
        "snapshots": [{"date": s.get("date"), "keywords_count": len(s.get("keywords", []))} for s in snapshots],
    })


async def handle_chat_completions(request: web.Request) -> web.Response:
    """POST /v1/chat/completions — supports JSON and multipart/form-data."""
    content_type = request.content_type or ""
    if not isinstance(content_type, str):
        content_type = ""

    agent_loop = request.app["agent_loop"]
    timeout_s: float = request.app.get("request_timeout", 120.0)
    model_name: str = request.app.get("model_name", "mona")

    stream = False
    try:
        if content_type.startswith("multipart/"):
            text, media_paths, session_id, requested_model = await _parse_multipart(request)
        else:
            try:
                body = await request.json()
            except Exception:
                return _error_json(400, "Invalid JSON body")
            stream = body.get("stream", False)
            requested_model = body.get("model")
            text, media_paths = _parse_json_content(body)
            session_id = body.get("session_id")
    except ValueError as e:
        return _error_json(400, str(e))
    except _FileSizeExceeded as e:
        return _error_json(413, str(e), err_type="invalid_request_error")
    except Exception:
        logger.exception("Error parsing upload")
        return _error_json(413, "File too large or invalid upload")

    if requested_model and requested_model != model_name:
        return _error_json(400, f"Only configured model '{model_name}' is available")

    session_key = f"api:{session_id}" if session_id else API_SESSION_KEY
    session_locks: dict[str, asyncio.Lock] = request.app["session_locks"]
    session_lock = session_locks.setdefault(session_key, asyncio.Lock())

    logger.debug(
        "API request session_key={} media={} text_len={} stream={}",
        session_key, len(media_paths), len(text), stream,
    )
    # -- streaming path --
    if stream:
        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Connection"] = "keep-alive"
        await resp.prepare(request)

        chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        stream_failed = False
        emitted_content = False

        async def _on_stream(token: str) -> None:
            nonlocal emitted_content
            if token:
                emitted_content = True
            await queue.put(token)

        async def _on_stream_end(*_a: Any, **_kw: Any) -> None:
            # Agent stream-end callbacks mark generation segment boundaries.
            # Tool-backed requests may continue after a segment ends, so the
            # HTTP SSE stream is closed only when process_direct returns.
            return None

        async def _run() -> None:
            nonlocal stream_failed
            try:
                async with session_lock:
                    response = await asyncio.wait_for(
                        agent_loop.process_direct(
                            content=text,
                            media=media_paths if media_paths else None,
                            session_key=session_key,
                            channel="api",
                            chat_id=API_CHAT_ID,
                            on_stream=_on_stream,
                            on_stream_end=_on_stream_end,
                        ),
                        timeout=timeout_s,
                    )
                    if not emitted_content:
                        response_text = _response_text(response)
                        if response_text.strip():
                            await queue.put(response_text)
            except Exception:
                stream_failed = True
                logger.exception("Streaming error for session {}", session_key)
            finally:
                await queue.put(None)

        task = asyncio.create_task(_run())
        try:
            while True:
                token = await queue.get()
                if token is None:
                    break
                await resp.write(_sse_chunk(token, model_name, chunk_id))
        finally:
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        if not stream_failed:
            await resp.write(_sse_chunk("", model_name, chunk_id, finish_reason="stop"))
            await resp.write(_SSE_DONE)
        return resp

    # -- non-streaming path (original logic) --
    fallback = EMPTY_FINAL_RESPONSE_MESSAGE

    try:
        async with session_lock:
            try:
                response = await asyncio.wait_for(
                    agent_loop.process_direct(
                        content=text,
                        media=media_paths if media_paths else None,
                        session_key=session_key,
                        channel="api",
                        chat_id=API_CHAT_ID,
                    ),
                    timeout=timeout_s,
                )
                response_text = _response_text(response)

                if not response_text or not response_text.strip():
                    logger.warning("Empty response for session {}, retrying", session_key)
                    retry_response = await asyncio.wait_for(
                        agent_loop.process_direct(
                            content=text,
                            media=media_paths if media_paths else None,
                            session_key=session_key,
                            channel="api",
                            chat_id=API_CHAT_ID,
                        ),
                        timeout=timeout_s,
                    )
                    response_text = _response_text(retry_response)
                    if not response_text or not response_text.strip():
                        logger.warning("Empty response after retry, using fallback")
                        response_text = fallback

            except asyncio.TimeoutError:
                return _error_json(504, f"Request timed out after {timeout_s}s")
            except Exception:
                logger.exception("Error processing request for session {}", session_key)
                return _error_json(500, "Internal server error", err_type="server_error")
    except Exception:
        logger.exception("Unexpected API lock error for session {}", session_key)
        return _error_json(500, "Internal server error", err_type="server_error")

    return web.json_response(_chat_completion_response(response_text, model_name))


async def handle_models(request: web.Request) -> web.Response:
    """GET /v1/models"""
    model_name = request.app.get("model_name", "mona")
    return web.json_response(
        {
            "object": "list",
            "data": [
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "mona",
                }
            ],
        }
    )


async def handle_audio_transcriptions(request: web.Request) -> web.Response:
    """POST /v1/audio/transcriptions — OpenAI-compatible audio transcription.

    Accepts multipart/form-data with a ``file`` field (audio blob) and
    optional ``model`` / ``language`` fields. Returns ``{"text": "..."}``.

    Audio bytes are passed directly to the transcription provider — no temp
    file is written, enabling real-time streaming from browser/mic.
    """
    agent_loop = request.app["agent_loop"]
    cc = agent_loop.channels_config
    if cc is None:
        return _error_json(500, "Channels config not available", err_type="server_error")

    content_type = request.content_type or ""
    if not content_type.startswith("multipart/"):
        return _error_json(400, "Expected multipart/form-data with a 'file' field")

    reader = await request.multipart()
    audio_data: bytes | None = None
    audio_filename = "audio.webm"
    language: str | None = None

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "file":
            raw = await part.read()
            if len(raw) > MAX_FILE_SIZE:
                raise _FileSizeExceeded(
                    f"File '{part.filename}' exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit"
                )
            audio_data = bytes(raw)
            if part.filename:
                audio_filename = safe_filename(part.filename)
        elif part.name == "language":
            language = (await part.read()).decode("utf-8").strip() or None

    if audio_data is None:
        return _error_json(400, "Missing 'file' field in multipart form data")

    try:
        provider_name = cc.transcription_provider
        lang = language or cc.transcription_language or None

        if provider_name == "openai":
            from mona.providers.transcription import OpenAITranscriptionProvider

            provider = OpenAITranscriptionProvider(language=lang)
        else:
            from mona.providers.transcription import GroqTranscriptionProvider

            provider = GroqTranscriptionProvider(language=lang)

        text = await provider.transcribe_bytes(audio_data, filename=audio_filename)
        return web.json_response({"text": text})
    except Exception as e:
        logger.exception("Audio transcription API error: {}", e)
        return _error_json(500, f"Transcription failed: {e}", err_type="server_error")


async def handle_audio_speech(request: web.Request) -> web.Response:
    """POST /v1/audio/speech — OpenAI-compatible text-to-speech.

    Accepts JSON: ``{"input": "text", "voice": "optional-voice-id"}``.
    Returns audio/mpeg binary data directly (no temp file on disk).
    """
    agent_loop = request.app["agent_loop"]
    cc = agent_loop.channels_config
    if cc is None:
        return _error_json(500, "Channels config not available", err_type="server_error")

    try:
        body = await request.json()
    except Exception:
        return _error_json(400, "Invalid JSON body")

    text = body.get("input", "").strip()
    if not text:
        return _error_json(400, "Missing 'input' field")

    voice = body.get("voice", "").strip() or cc.tts_voice

    try:
        from mona.providers.tts import get_tts_provider

        provider = get_tts_provider(
            cc.tts_provider,
            api_key=cc.tts_api_key or None,
            api_base=cc.tts_api_base or None,
            voice=voice,
            model=cc.tts_model or "",
        )

        audio_bytes = await provider.synthesize_to_bytes(text, voice=voice)
        if audio_bytes is None:
            return _error_json(500, "TTS synthesis failed", err_type="server_error")

        return web.Response(body=audio_bytes, content_type="audio/mpeg")
    except Exception as e:
        logger.exception("Audio speech API error: {}", e)
        return _error_json(500, f"TTS failed: {e}", err_type="server_error")


async def handle_health(request: web.Request) -> web.Response:
    """GET /health"""
    return web.json_response({"status": "ok"})


async def handle_shutdown(request: web.Request) -> web.Response:
    """POST /shutdown - Gracefully shut down the gateway process.

    Sets the app-level ``shutdown_event`` so the gateway's main loop unwinds
    through its normal finally block (MCP close, session flush, channel stop).
    The response is sent before the event fires.
    """
    event = request.app.get("shutdown_event")
    if event is not None:
        # Defer slightly so the HTTP response flushes first.
        asyncio.get_running_loop().call_later(0.1, event.set)
    return web.json_response({"status": "shutting down"})


async def handle_tauri_invoke(request: web.Request) -> web.Response:
    """POST /api/tauri/invoke - Proxy Tauri IPC commands from agent tools.

    Accepts JSON body: {"cmd": "command_name", "args": {...}}
    Returns the Tauri command result or error.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    cmd = body.get("cmd", "")
    args = body.get("args", {})

    if not cmd:
        return web.json_response({"error": "Missing 'cmd' field"}, status=400)

    allowed_prefixes = (
        "terminal_",
        "shell_",
        "ssh_",
        "sftp_",
        "bridge_",
    )

    if not any(cmd.startswith(p) for p in allowed_prefixes):
        return web.json_response(
            {"error": f"Command '{cmd}' not allowed through proxy"}, status=403
        )

    try:
        tauri_args = ["mona-desktop", cmd]
        for key, value in args.items():
            tauri_args.append(f"--{key}")
            tauri_args.append(str(value) if not isinstance(value, str) else value)

        result = await asyncio.create_subprocess_exec(
            *tauri_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(result.communicate(), timeout=30)

        if result.returncode == 0:
            output = stdout.decode("utf-8", errors="replace").strip()
            try:
                parsed = _json.loads(output)
                return web.json_response(parsed)
            except (_json.JSONDecodeError, ValueError):
                return web.json_response({"result": output})
        else:
            error_msg = stderr.decode("utf-8", errors="replace").strip()
            return web.json_response({"error": error_msg}, status=500)

    except asyncio.TimeoutError:
        return web.json_response({"error": "Tauri command timed out"}, status=504)
    except FileNotFoundError:
        return web.json_response(
            {"error": "Tauri CLI not available - running outside Tauri context"}, status=501
        )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Email sync / send (IMAP + SMTP HTTP endpoints)
# ---------------------------------------------------------------------------


def _email_extract_message_bytes(fetched: list[Any]) -> bytes | None:
    """从 IMAP fetch 结果中提取原始邮件字节。

    IMAP FETCH 响应格式因服务器而异：
    - 标准: [(b'1 (BODY[] {N}', b'<raw bytes>'), b')']
    - 部分服务器: [(b'1 (UID N BODY[] {N}', b'<raw bytes>')]
    - 少数服务器返回 memoryview 或非标准结构

    策略：收集所有 bytes 元素，返回最长的（邮件内容远大于 header 行）。
    """
    candidates: list[bytes] = []
    for item in fetched:
        if isinstance(item, tuple):
            for elem in item:
                if isinstance(elem, (bytes, bytearray, memoryview)) and elem:
                    candidates.append(bytes(elem))
        elif isinstance(item, (bytes, bytearray, memoryview)) and item:
            # 跳过结尾的 b')'
            b = bytes(item)
            if b != b")":
                candidates.append(b)

    if not candidates:
        try:
            types = [type(item).__name__ for item in fetched]
            logger.warning(
                f"Failed to extract message bytes, fetched types={types}, "
                f"len={len(fetched)}, content_preview={[str(item)[:100] for item in fetched[:3]]}"
            )
        except Exception:
            logger.warning(f"Failed to extract message bytes, fetched={fetched!r}")
        return None

    # 返回最长的 bytes（邮件内容通常 >> header 行）
    return max(candidates, key=len)


def _email_extract_uid(fetched: list[Any]) -> str:
    """从 IMAP fetch 结果中提取 UID。"""
    for item in fetched:
        if isinstance(item, tuple) and item and isinstance(item[0], (bytes, bytearray)):
            head = bytes(item[0]).decode("utf-8", errors="ignore")
            m = re.search(r"UID\s+(\d+)", head)
            if m:
                return m.group(1)
    return ""


def _email_extract_seen_flag(fetched: list[Any]) -> bool:
    """从 IMAP fetch 结果中提取 \\Seen 标记（已读状态）。"""
    return _email_extract_flag(fetched, "\\Seen")


def _email_extract_flagged_flag(fetched: list[Any]) -> bool:
    """从 IMAP fetch 结果中提取 \\Flagged 标记（星标状态）。"""
    return _email_extract_flag(fetched, "\\Flagged")


def _email_extract_flag(fetched: list[Any], flag: str) -> bool:
    """从 IMAP fetch 结果中提取指定标记是否存在。"""
    for item in fetched:
        if isinstance(item, tuple) and item and isinstance(item[0], (bytes, bytearray)):
            head = bytes(item[0]).decode("utf-8", errors="ignore")
            if flag in head:
                return True
    return False


# 把 MIME encoded-word 中的 gb2312/gbk charset 归一化为 gb18030（超集），
# 避免 policy.default 解码时因 gb2312 缺少"喆"等扩展字符而产生 \ufffd
_GB_CHARSET_PATTERN = re.compile(rb'=\?(gb2312|gbk|gb_2312)\?', re.IGNORECASE)


def _normalize_mime_charset(raw_bytes: bytes) -> bytes:
    return _GB_CHARSET_PATTERN.sub(b'=?gb18030?', raw_bytes)


def _email_decode_header_value(value: str) -> str:
    """解码邮件头字段（处理 MIME 编码 + 非编码的 raw 字节）。

    policy.default 下 parsed.get() 可能已自动解码 MIME encoded-word，
    此时 value 是纯 Unicode 字符串，不应再调用 decode_header（会重复编解码，
    对某些字符产生 \ufffd 替换字符）。仅当 value 仍含 =?...?= 标记时才解码。
    gb2312/gbk 统一用 gb18030（超集）解码，避免"喆"等扩展字符丢失。
    """
    if not value:
        return ""
    # 含 MIME encoded-word 标记：手动解码，gb2312/gbk 用 gb18030 作为超集
    if "=?" in value and "?=" in value:
        try:
            parts = decode_header(value)
            result = []
            for text, charset in parts:
                if isinstance(text, bytes):
                    cs = (charset or "").lower()
                    # gb2312/gbk 用 gb18030 超集解码，避免生僻字（如"喆"）丢失
                    if cs in ("gb2312", "gbk", "gb_2312", "gb18030", "csiso58gb231280"):
                        try:
                            result.append(text.decode("gb18030"))
                        except UnicodeDecodeError:
                            result.append(text.decode("utf-8", errors="replace"))
                    else:
                        try:
                            result.append(text.decode(cs or "utf-8"))
                        except (LookupError, UnicodeDecodeError):
                            result.append(text.decode("utf-8", errors="replace"))
                else:
                    result.append(text)
            return "".join(result)
        except Exception:
            return value
    # 检测 surrogate（policy.default 对 raw 字节用 surrogateescape 处理）
    if any(0xDC80 <= ord(c) <= 0xDCFF for c in value):
        try:
            raw_bytes = value.encode("latin-1", errors="surrogateescape")
            for charset in ("utf-8", "gb18030", "gbk", "big5"):
                try:
                    return raw_bytes.decode(charset)
                except UnicodeDecodeError:
                    continue
        except Exception:
            pass
    return value


def _email_extract_bodies(msg: Any) -> tuple[str, str]:
    """提取邮件正文，返回 (纯文本, HTML) 元组。

    HTML 中的 cid:xxx 引用会被替换为 data URI（来自 MIME 内联图片 part）。
    否则 iframe srcDoc 无法解析 cid: 这个非标准 URL scheme，导致图片破图。
    """
    plain_parts: list[str] = []
    html_parts: list[str] = []
    # CID(小写) -> data URI 映射，用于替换 HTML 中的 cid: 引用
    inline_images: dict[str, str] = {}

    def _extract_part_payload(part: Any) -> str:
        """从单个 MIME part 提取已解码的文本内容。

        优先使用 get_content()（policy.default 会自动处理 CTE 解码）；
        失败时回退到 get_payload(decode=True) + 手动 charset 解码。
        """
        try:
            payload = part.get_content()
            if isinstance(payload, str):
                return payload
            if isinstance(payload, bytes):
                charset = part.get_content_charset() or "utf-8"
                return payload.decode(charset, errors="replace")
        except Exception:
            pass
        # 回退：手动解码
        payload_bytes = part.get_payload(decode=True) or b""
        if isinstance(payload_bytes, str):
            return payload_bytes
        charset = part.get_content_charset() or "utf-8"
        return payload_bytes.decode(charset, errors="replace")

    parts_iter = msg.walk() if msg.is_multipart() else [msg]
    for part in parts_iter:
        disposition = part.get_content_disposition()
        content_type = part.get_content_type()

        # 文本正文
        if disposition != "attachment" and content_type in ("text/plain", "text/html"):
            payload = _extract_part_payload(part)
            if payload:
                if content_type == "text/plain":
                    plain_parts.append(payload)
                else:
                    html_parts.append(payload)
            continue

        # 内联图片：有 Content-ID 头，或 Content-Disposition: inline 且为 image/*
        # 这类 part 是 HTML 正文里 cid: 引用对应的图片数据
        cid_header = part.get("Content-ID")
        is_inline_image = (cid_header is not None) or (
            disposition == "inline" and content_type.startswith("image/")
        )
        if not is_inline_image:
            continue
        try:
            raw = part.get_payload(decode=True)
            if not raw:
                continue
            # 提取 CID key（去尖括号、去空白）
            cid_key = (cid_header or "").strip().strip("<>").strip()
            if not cid_key:
                # 没有 Content-ID 时，用 Content-Location 或 filename 兜底
                cid_key = (part.get("Content-Location") or part.get_filename() or "").strip()
            if not cid_key:
                continue
            # 大小保护：单张超 5MB 的图片不转换，避免响应体膨胀过大
            if len(raw) > 5 * 1024 * 1024:
                continue
            data_uri = f"data:{content_type};base64,{base64.b64encode(raw).decode('ascii')}"
            # 映射 key 用小写，HTML 中 cid: 引用大小写不敏感匹配
            inline_images[cid_key.lower()] = data_uri
        except Exception:
            pass

    html = "\n\n".join(html_parts)

    # 替换 HTML 中的 cid: 引用为 data URI
    if inline_images and html:
        def _replace_cid(m: "re.Match[str]") -> str:
            cid_ref = m.group(1).strip().lower()
            data_uri = inline_images.get(cid_ref)
            if data_uri:
                return f'src="{data_uri}"'
            return m.group(0)

        html = re.sub(
            r'src=["\']cid:([^"\']+)["\']',
            _replace_cid,
            html,
            flags=re.IGNORECASE,
        )

    return "\n\n".join(plain_parts), html


def _email_has_attachments(msg: Any) -> bool:
    """检测邮件是否包含附件。"""
    if not msg.is_multipart():
        return False
    for part in msg.walk():
        if part.get_content_disposition() == "attachment":
            return True
    return False


def _email_extract_attachments(msg: Any) -> list[dict[str, Any]]:
    """提取附件元信息列表（filename, contentType, size）。"""
    attachments: list[dict[str, Any]] = []
    if not msg.is_multipart():
        return attachments
    for part in msg.walk():
        if part.get_content_disposition() != "attachment":
            continue
        filename = part.get_filename() or "unknown"
        # 解码 MIME 编码的文件名
        try:
            filename = str(make_header(decode_header(filename)))
        except Exception:
            pass
        content_type = part.get_content_type() or "application/octet-stream"
        # 尝试获取大小
        try:
            payload = part.get_payload(decode=True)
            size = len(payload) if payload else 0
        except Exception:
            size = 0
        attachments.append(
            {
                "filename": filename,
                "contentType": content_type,
                "size": size,
            }
        )
    return attachments


def _encode_imap_utf7(s: str) -> str:
    """将字符串编码为 IMAP Modified UTF-7（RFC 3501 Section 5.1.3）。

    IMAP 协议要求非 ASCII 文件夹名必须用 Modified UTF-7 编码传输。
    规则：连续的非 ASCII 字符 → UTF-16-BE 字节 → base64（无填充）→ &...- 包裹；
    字面 & → &-；纯 ASCII 原样输出。
    """
    if not s:
        return s
    # 全 ASCII 直接返回（只需处理 & 的转义）
    try:
        s.encode("ascii")
        return s.replace("&", "&-")
    except UnicodeEncodeError:
        pass

    result: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if ord(s[i]) < 0x80:
            if s[i] == "&":
                result.append("&-")
            else:
                result.append(s[i])
            i += 1
            continue
        # 收集连续的非 ASCII 字符
        j = i
        while j < n and ord(s[j]) >= 0x80:
            j += 1
        raw = s[i:j].encode("utf-16-be")
        # RFC 3501 §5.1.3 Modified BASE64：标准 base64 中的 '/' 必须替换为 ','，且去掉填充 '='
        encoded = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
        result.append(f"&{encoded}-")
        i = j
    return "".join(result)


def _imap_quote_mailbox(mailbox: str) -> str:
    """对 IMAP mailbox 名做 Modified UTF-7 编码并加双引号。

    IMAP 协议要求：非 ASCII 字符必须用 Modified UTF-7 编码传输；
    包含空格等特殊字符的 mailbox 名必须用双引号包裹。
    这里统一处理编码 + 引号，所有调用点传入解码后的可读文件夹名即可。
    例如 "Sent Messages" → '"Sent Messages"'，"已发送" → '"&XfJT0ZAB-"'
    """
    if not mailbox:
        return '""'
    # 如果已经带引号则不处理（防止双重编码）
    if mailbox.startswith('"') and mailbox.endswith('"'):
        return mailbox
    # Modified UTF-7 编码（中文等非 ASCII 字符）
    encoded = _encode_imap_utf7(mailbox)
    # 转义内部反斜杠和双引号
    escaped = encoded.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _validate_mail_host(imap_host: str, smtp_host: str = "") -> None:
    """SSRF 校验：禁止 IMAP/SMTP 主机指向内网地址（允许 loopback 用于本地邮件服务器）。"""
    if imap_host:
        ok, err = validate_host(imap_host, allow_loopback=True)
        if not ok:
            raise ValueError(f"IMAP 服务器地址不被允许: {err}")
    if smtp_host:
        ok, err = validate_host(smtp_host, allow_loopback=True)
        if not ok:
            raise ValueError(f"SMTP 服务器地址不被允许: {err}")


def _imap_fetch_recent(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 并拉取邮件（Offline-First：同步时全量拉取 RFC822）。

    - 校验 UIDVALIDITY：变化时返回 uidValidityChanged=true，调用方废弃旧 UID 映射
    - 支持 lastUid 增量同步：只拉取 UID > lastUid 的新邮件
    - FETCH BODY.PEEK[] 拉完整 RFC822，落盘后用户点击可毫秒级显示
    - 不按大小降级（skill 第三节：不得用 RFC822 大小推断正文是否值得缓存）
    - 首次同步限制为最近 20 封，增量同步单次最多 50 封
    - 复用持久连接池，避免频繁 login 触发邮箱风控
    - 返回 dict：{"messages": [...], "uidValidity": str, "uidValidityChanged": bool}
    """
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    last_uid_raw = body.get("lastUid")
    # 调用方传入的本地已知 UIDVALIDITY（用于检测变化）
    known_uid_validity = str(body.get("uidValidity", "") or "").strip()

    # 解析 lastUid（前端传字符串或 null）
    last_uid: int | None = None
    if last_uid_raw is not None:
        try:
            last_uid = int(str(last_uid_raw).strip())
        except (ValueError, TypeError):
            last_uid = None

    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, data = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")
        # 解析 SELECT 响应中的 UIDVALIDITY
        uid_validity = ""
        for item in data or []:
            if isinstance(item, bytes) and b"UIDVALIDITY" in item:
                text = item.decode("utf-8", errors="ignore")
                m = re.search(r"UIDVALIDITY\s+(\d+)", text)
                if m:
                    uid_validity = m.group(1)
                    break
        # UIDVALIDITY 变化：调用方负责废弃旧 UID 映射并重建文件夹索引
        uid_validity_changed = bool(
            uid_validity and known_uid_validity and uid_validity != known_uid_validity
        )

        # 增量同步：只拉取 UID > last_uid 的邮件
        uids: list[bytes] = []
        all_uids: list[bytes] = []
        if last_uid is not None and last_uid > 0:
            status, data = client.uid("SEARCH", "UID", f"{last_uid + 1}:*")
            if status == "OK" and data and data[0]:
                uids = [u for u in data[0].split() if int(u) > last_uid]
            # 部分企业邮箱对 UID n:* 范围搜索返回空，回退到 SEARCH ALL 本地过滤
            if not uids:
                logger.debug(
                    "[imap-sync] UID range search returned empty, "
                    "falling back to SEARCH ALL"
                )
                status, data = client.uid("SEARCH", "ALL")
                if status == "OK" and data and data[0]:
                    all_uids = data[0].split()
                    uids = [u for u in all_uids if int(u) > last_uid]
                    # 增量同步单次最多 50 封
                    uids = uids[-50:]
        else:
            # 首次同步：拉取全部 UID，后续取最后 20 封
            status, data = client.uid("SEARCH", "ALL")
            if status != "OK" or not data or not data[0]:
                return []
            all_uids = data[0].split()
            uids = all_uids[-20:]

        # 保护：如果服务器最大 UID < last_uid，说明本地 last_uid 已过期/无效
        # （服务器删除了高 UID 邮件），重置并重新拉取最近 20 封，避免永远漏掉新邮件。
        # 注意：用严格小于，last_uid == server max uid 是正常已同步状态，不触发重置。
        if (
            last_uid is not None
            and last_uid > 0
            and all_uids
            and max(int(u) for u in all_uids) < last_uid
        ):
            logger.warning(
                f"[imap-sync] local last_uid={last_uid} > server max uid, "
                f"resetting and fetching recent 20"
            )
            uids = all_uids[-20:]

        if not uids:
            logger.debug(
                f"[imap-sync] no new uids "
                f"(mailbox={mailbox}, last_uid={last_uid})"
            )
            return {"messages": [], "uidValidity": uid_validity, "uidValidityChanged": uid_validity_changed}

        messages: list[dict[str, Any]] = []
        for uid in uids:
            # Offline-First: 同步时直接 FETCH BODY.PEEK[] 拉完整 RFC822，
            # 落盘后用户点击可毫秒级返回，无需再走 gateway。
            # 不按大小降级（skill 第三节：不得用 RFC822 大小推断正文是否值得缓存）
            uid_str = uid.decode("utf-8", errors="ignore")
            fetch_cmd = "(BODY.PEEK[] UID FLAGS)"
            raw_bytes: bytes | None = None
            fetched: list[Any] = []

            try:
                status, fetched = client.uid("FETCH", uid, fetch_cmd)
                if status != "OK" or not fetched:
                    continue
                raw_bytes = _email_extract_message_bytes(fetched)
            except imaplib.IMAP4.error as e:
                logger.warning(f"[imap-sync] FETCH uid={uid_str} failed: {e}")
                continue

            # body_fetched 默认为 true；仅在 FETCH 失败回退到 HEADER-only 时置 false
            body_fetched = True

            if raw_bytes is None:
                # 拉完整 RFC822 失败，回退到 HEADER-only（body_fetched=false 触发后台补拉）
                logger.warning(
                    f"[imap-sync] FETCH full RFC822 returned empty for uid={uid_str}, "
                    f"falling back to HEADER-only"
                )
                status, fetched = client.uid(
                    "FETCH", uid, "(BODY.PEEK[HEADER] UID FLAGS)"
                )
                if status != "OK" or not fetched:
                    continue
                raw_bytes = _email_extract_message_bytes(fetched)
                if raw_bytes is None:
                    continue
                body_fetched = False

            uid_str = _email_extract_uid(fetched) or uid_str

            parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))

            subject = _email_decode_header_value(parsed.get("Subject", ""))
            from_name, from_addr = parseaddr(
                _email_decode_header_value(parsed.get("From", ""))
            )
            from_name = from_name.strip()
            to_addrs = [
                addr for _name, addr in getaddresses([_email_decode_header_value(parsed.get("To", "") or "")]) if addr
            ]
            cc_addrs = [
                addr for _name, addr in getaddresses([_email_decode_header_value(parsed.get("Cc", "") or "")]) if addr
            ]
            date_value = parsed.get("Date", "")
            message_id = parsed.get("Message-ID", "") or ""

            messages.append(
                {
                    "uid": uid_str,
                    "subject": subject,
                    "from": from_addr,
                    "fromName": from_name,
                    "to": ", ".join(to_addrs),
                    "cc": ", ".join(cc_addrs),
                    "date": date_value,
                    "bodyText": "",
                    "bodyHtml": None,
                    "bodyFetched": body_fetched,
                    "hasAttachments": _email_has_attachments(parsed),
                    "rawSize": len(raw_bytes),
                    "isRead": _email_extract_seen_flag(fetched),
                    "isStarred": _email_extract_flagged_flag(fetched),
                    "messageId": message_id,
                    "attachments": _email_extract_attachments(parsed),
                    # 完整 RFC822（base64）；HEADER-only 回退时为信头
                    "rawBytes": base64.b64encode(raw_bytes).decode("ascii"),
                }
            )

        return {"messages": messages, "uidValidity": uid_validity, "uidValidityChanged": uid_validity_changed}

    result = imap_pool_manager.run(body, op)
    logger.debug(
        f"[imap-sync] mailbox={mailbox} "
        f"last_uid={last_uid} fetched={len(result['messages'])} new messages "
        f"uid_validity={result['uidValidity']} changed={result['uidValidityChanged']}"
    )
    return result


def _imap_list_uids(body: dict[str, Any]) -> dict[str, Any]:
    """返回指定文件夹的 UIDVALIDITY 和所有 UID 列表。

    用于后台同步做删除对账和 UIDVALIDITY 检测：
    - 本地有但服务器没有的 UID 即为已删除邮件
    - UIDVALIDITY 变化时本地缓存失效，需清空重建
    只做一次 UID SEARCH ALL，开销极低。
    """
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, data = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")
        # 解析 SELECT 响应中的 UIDVALIDITY
        uid_validity = ""
        for item in data or []:
            if isinstance(item, bytes) and b"UIDVALIDITY" in item:
                # 格式 b')]' 或 b' (UIDVALIDITY 12345)'
                text = item.decode("utf-8", errors="ignore")
                m = re.search(r"UIDVALIDITY\s+(\d+)", text)
                if m:
                    uid_validity = m.group(1)
                    break
        status, data = client.uid("SEARCH", "ALL")
        uids: list[str] = []
        if status == "OK" and data and data[0]:
            uids = [u.decode("utf-8", errors="ignore") for u in data[0].split()]
        return {"uids": uids, "uidValidity": uid_validity}

    result = imap_pool_manager.run(body, op)
    logger.debug(
        f"[imap-uids] mailbox={mailbox} "
        f"total_uids={len(result.get('uids', []))} uid_validity={result.get('uidValidity', '')}"
    )
    return result


def _decode_imap_utf7(s: str) -> str:
    """解码 IMAP Modified UTF-7 编码的文件夹名（RFC 3501 Section 5.1.3）。

    IMAP 服务器返回的文件夹名可能包含 &...- 形式的 UTF-7 编码段，
    用于表示非 ASCII 字符（如中文"已发送" → &XfJT0ZAB-）。
    标准 UTF-8 解码会显示成乱码，这里做正确解码。
    规则：& 开始编码段，- 结束；&- 表示字面 & 字符。
    """
    if "&" not in s:
        return s
    result: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s[i] == "&":
            j = s.find("-", i + 1)
            if j == -1:
                result.append(s[i:])
                break
            encoded = s[i + 1:j]
            if encoded == "":
                # &- 表示字面 & 字符
                result.append("&")
            else:
                try:
                    # IMAP Modified BASE64 用 ',' 替代标准 base64 的 '/' (RFC 3501)
                    normalized = encoded.replace(",", "/")
                    padded = normalized + "=" * (-len(normalized) % 4)
                    raw = base64.b64decode(padded)
                    result.append(raw.decode("utf-16-be"))
                except Exception:
                    result.append(s[i:j + 1])
            i = j + 1
        else:
            result.append(s[i])
            i += 1
    return "".join(result)


def _imap_list_folders(body: dict[str, Any]) -> list[dict[str, Any]]:
    """连接 IMAP 并列出所有文件夹。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> list[dict[str, Any]]:
        status, folder_data = client.list()
        logger.debug(
            "IMAP LIST status=%s folders=%s",
            status,
            len(folder_data) if folder_data else 0,
        )
        # 部分 IMAP 服务器在刚执行完 CREATE 后 LIST 会瞬态返回空，重试一次
        if status == "OK" and not folder_data:
            time.sleep(0.8)
            status, folder_data = client.list()
            logger.debug(
                "IMAP LIST retry status=%s folders=%s",
                status,
                len(folder_data) if folder_data else 0,
            )
        if status != "OK" or not folder_data:
            return []

        folders: list[dict[str, Any]] = []
        for raw_line in folder_data:
            line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
            # IMAP LIST 响应格式: (\HasChildren) "/" "INBOX"
            parts = line.rsplit('"', 2)
            if len(parts) >= 3:
                name = parts[-2]
                delimiter = parts[-3].strip().strip('"')
            else:
                # 没有引号包裹的简单格式
                tokens = line.split()
                name = tokens[-1].strip('"')
                delimiter = "/"
            original_name = name
            # 解码 Modified UTF-7 编码的文件夹名（如中文文件夹）
            name = _decode_imap_utf7(name)
            if original_name != name:
                logger.debug(
                    "[imap-folder] decoded '%s' -> '%s'",
                    original_name,
                    name,
                )
            elif "&" in original_name:
                logger.warning(
                    "[imap-folder] failed to decode utf7 name '%s' (raw line: %s) for %s",
                    original_name,
                    line.strip(),
                    imap_username,
                )
            flags = line.split(")")[0].lstrip("(").lower() if "(" in line else ""

            # 不再用 STATUS UNSEEN 逐文件夹查询（N 次 IMAP 往返，是文件夹列表慢的根因）
            # 未读数由前端从本地 SQLite 统一查询（email_unread_counts），IMAP 仅返回结构
            folders.append({
                "name": name,
                "delimiter": delimiter,
                "hasChildren": "\\haschildren" in flags.lower(),
                "flags": flags,
                "unreadCount": 0,
            })
        return folders

    return imap_pool_manager.run(body, op)


async def handle_email_folders(request: web.Request) -> web.Response:
    """POST /email/folders - 列出 IMAP 文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_list_folders)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email list folders failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_create_folder(body: dict[str, Any]) -> None:
    """连接 IMAP 并创建文件夹。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not mailbox:
        raise ValueError("mailbox is required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> None:
        status, data = client.create(_imap_quote_mailbox(mailbox))
        logger.debug(
            "IMAP CREATE status=%s data=%s mailbox=%s",
            status,
            data,
            mailbox,
        )
        if status != "OK":
            # 提取服务器返回的错误描述，便于诊断
            server_msg = ""
            if data:
                first = data[0]
                if isinstance(first, bytes):
                    server_msg = first.decode("utf-8", errors="replace")
                elif first is not None:
                    server_msg = str(first)

            # 文件夹已存在视为成功（幂等）：用户意图是"让文件夹存在"，目标已达成。
            # 兼容标准响应码 ALREADYEXISTS 与各邮箱的自定义文案
            # （如网易的 "Folder exist with the same name!"）。
            msg_lower = server_msg.lower()
            if (
                "alreadyexists" in msg_lower
                or "already exist" in msg_lower
                or "exist with the same name" in msg_lower
            ):
                logger.debug(
                    "IMAP CREATE: folder already exists, treating as success: %s",
                    mailbox,
                )
                return

            detail = f" server: {server_msg}" if server_msg else ""
            raise RuntimeError(f"Create folder failed: {status} ({mailbox}){detail}")

    imap_pool_manager.run(body, op)


def _imap_rename_folder(body: dict[str, Any]) -> None:
    """重命名 IMAP 文件夹。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    old_name = str(body.get("oldName", "") or "").strip()
    new_name = str(body.get("newName", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not old_name or not new_name:
        raise ValueError("oldName and newName are required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> None:
        status, data = client.rename(_imap_quote_mailbox(old_name), _imap_quote_mailbox(new_name))
        logger.debug(
            "IMAP RENAME status=%s data=%s old=%s new=%s",
            status,
            data,
            old_name,
            new_name,
        )
        if status != "OK":
            server_msg = ""
            if data:
                first = data[0]
                if isinstance(first, bytes):
                    server_msg = first.decode("utf-8", errors="replace")
                elif first is not None:
                    server_msg = str(first)
            detail = f" server: {server_msg}" if server_msg else ""
            raise RuntimeError(f"Rename folder failed: {status} ({old_name} -> {new_name}){detail}")

    imap_pool_manager.run(body, op)


def _imap_delete_folder(body: dict[str, Any]) -> None:
    """删除 IMAP 文件夹。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    folder_name = str(body.get("folderName", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not folder_name:
        raise ValueError("folderName is required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> None:
        status, data = client.delete(_imap_quote_mailbox(folder_name))
        logger.debug(
            "IMAP DELETE status=%s data=%s folder=%s",
            status,
            data,
            folder_name,
        )
        if status != "OK":
            server_msg = ""
            if data:
                first = data[0]
                if isinstance(first, bytes):
                    server_msg = first.decode("utf-8", errors="replace")
                elif first is not None:
                    server_msg = str(first)
            detail = f" server: {server_msg}" if server_msg else ""
            raise RuntimeError(f"Delete folder failed: {status} ({folder_name}){detail}")

    imap_pool_manager.run(body, op)


async def handle_email_create_folder(request: web.Request) -> web.Response:
    """POST /email/create_folder - 在 IMAP 服务器上创建文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_create_folder)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email create folder failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_rename_folder(request: web.Request) -> web.Response:
    """POST /email/rename_folder - 重命名 IMAP 文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_rename_folder)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email rename folder failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_delete_folder(request: web.Request) -> web.Response:
    """POST /email/delete_folder - 删除 IMAP 文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_delete_folder)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email delete folder failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_sync(request: web.Request) -> web.Response:
    """POST /email/sync - 通过 IMAP 拉取最近邮件。

    请求体包含 IMAP 连接信息和 mailbox，返回最近 50 封邮件的 JSON 数组。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_fetch_recent)
        return web.json_response(result)
    except Exception as e:
        err_msg = str(e)
        # IMAP SELECT 失败（如企业邮箱限制非 INBOX 文件夹访问），返回 422 而非 500
        if "select" in err_msg.lower() and "failed" in err_msg.lower():
            logger.warning(f"Email sync rejected (folder not accessible): {err_msg}")
            return web.json_response(
                {"error": f"该文件夹不支持同步: {err_msg}"},
                status=422,
            )
        logger.exception("Email sync failed")
        return web.json_response({"error": err_msg}, status=500)


async def handle_email_list_uids(request: web.Request) -> web.Response:
    """POST /email/list_uids - 返回指定文件夹所有 UID 列表。

    用于后台同步做删除对账：本地有但服务器没有的 UID 即为已删除邮件。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_list_uids)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email list_uids failed")
        return web.json_response({"error": str(e)}, status=500)


def _smtp_send_message_no_append(body: dict[str, Any]) -> bytes:
    """通过 SMTP 发送邮件，返回邮件原始字节（不保存副本）。

    副本保存由调用方异步执行，避免 _imap_append_sent 绕过 asyncio.Lock 导致并发问题。
    """
    smtp_host = str(body.get("smtpHost", "") or "").strip()
    smtp_port = int(body.get("smtpPort", 587) or 587)
    smtp_username = str(body.get("smtpUsername", "") or "").strip()
    smtp_password = str(body.get("smtpPassword", "") or "")
    # 调试日志：仅记录密码长度，不记录密码任何部分（安全考虑）
    pwd_len = len(smtp_password)
    logger.debug(f"[smtp] host={smtp_host}:{smtp_port} pwd_len={pwd_len}")
    use_tls = bool(body.get("useTls", True))
    use_ssl = bool(body.get("useSsl", False))
    from_address = str(body.get("fromAddress", "") or "").strip()
    from_name = str(body.get("fromName", "") or "").strip()
    to_addrs = body.get("to", []) or []
    cc_addrs = body.get("cc", []) or []
    bcc_addrs = body.get("bcc", []) or []
    subject = str(body.get("subject", "") or "")
    body_html = str(body.get("bodyHtml", "") or "")
    in_reply_to = body.get("inReplyTo")
    attachments = body.get("attachments", []) or []

    if not smtp_host:
        raise ValueError("smtpHost is required")
    if not to_addrs:
        raise ValueError("to is required")

    _validate_mail_host("", smtp_host)

    msg = EmailMessage()
    sender_addr = from_address or smtp_username
    if from_name:
        msg["From"] = formataddr((from_name, sender_addr))
    else:
        msg["From"] = sender_addr
    msg["To"] = ", ".join(to_addrs)
    if cc_addrs:
        msg["Cc"] = ", ".join(cc_addrs)
    # Bcc 头不写入邮件（密送），但收件人列表需包含
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    if in_reply_to:
        msg["In-Reply-To"] = str(in_reply_to)
        msg["References"] = str(in_reply_to)

    msg.set_content(body_html, subtype="html")

    # 添加附件
    for att in attachments:
        filename = str(att.get("filename", "attachment") or "attachment")
        content_type = str(att.get("contentType", "application/octet-stream") or "application/octet-stream")
        data_b64 = str(att.get("data", "") or "")
        content_id = att.get("contentId")  # 内联图片的 Content-ID（不含尖括号）
        try:
            data_bytes = base64.b64decode(data_b64)
        except Exception:
            logger.warning(f"附件 base64 解码失败，跳过: {filename}")
            continue
        # 解析 maintype/subtype
        if "/" in content_type:
            maintype, _, subtype = content_type.partition("/")
        else:
            maintype, subtype = "application", "octet-stream"
        # 内联图片（cid 引用）：Content-Disposition: inline + Content-ID 头
        # 普通附件：Content-Disposition: attachment（add_attachment 默认行为）
        if content_id:
            msg.add_attachment(
                data_bytes,
                maintype=maintype,
                subtype=subtype,
                filename=filename,
            )
            # add_attachment 会把最后一个 part 设为 attachment，需改为 inline 并加 Content-ID
            # msg.get_payload() 返回 list（multipart 时）
            payload = msg.get_payload()
            if isinstance(payload, list) and payload:
                last_part = payload[-1]
                last_part.replace_header("Content-Disposition", f'inline; filename="{filename}"')
                last_part["Content-ID"] = f"<{content_id}>"
        else:
            msg.add_attachment(
                data_bytes,
                maintype=maintype,
                subtype=subtype,
                filename=filename,
            )

    # SMTP 实际收件人 = To + Cc + Bcc
    all_recipients = list(to_addrs) + list(cc_addrs) + list(bcc_addrs)

    raw_bytes = msg.as_bytes()

    timeout = 30
    if use_ssl:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=timeout) as smtp:
            smtp.login(smtp_username, smtp_password)
            smtp.send_message(msg, to_addrs=all_recipients)
    else:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=timeout) as smtp:
            if use_tls:
                smtp.starttls(context=ssl.create_default_context())
            smtp.login(smtp_username, smtp_password)
            smtp.send_message(msg, to_addrs=all_recipients)

    return raw_bytes


def _imap_append_sent(body: dict[str, Any], raw_bytes: bytes) -> None:
    """通过 IMAP APPEND 把已发送邮件副本保存到 Sent 文件夹。

    按常见"已发送"文件夹名优先级尝试，失败则用 LIST 查找含 sent/已发送 的文件夹。
    任何异常都只记录日志、不抛出——邮件已通过 SMTP 发出，保存副本失败不应影响发送结果。
    复用持久连接池。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()

    if not imap_host or not imap_username:
        logger.warning("[append-sent] 没有 IMAP 配置，无法保存副本（仅 SMTP 场景）")
        return

    _validate_mail_host(imap_host)

    # 关键修复：body 中 useSsl 是 SMTP 的 SSL 设置，IMAP 需要用 imapUseSsl
    # 必须强制覆盖 useSsl 为 imapUseSsl 的值，否则 IMAP 连接会用错 SSL 配置
    body = {**body, "useSsl": bool(body.get("imapUseSsl", True))}

    # 常见"已发送"文件夹名（按优先级）
    sent_candidates = ["Sent", "Sent Items", "Sent Messages", "已发送"]

    def op(client: imaplib.IMAP4) -> None:
        # 先 LIST 查看服务器实际有哪些文件夹，用于诊断
        try:
            typ, data = client.list()
            if typ == "OK" and data:
                folder_names = []
                for item in data:
                    try:
                        line = bytes(item).decode("utf-8", errors="ignore")
                        # 提取文件夹名
                        m = re.search(r'"([^"]+)"\s*$', line)
                        if m:
                            folder_names.append(m.group(1))
                    except Exception:
                        pass
                logger.debug(f"[append-sent] 服务器文件夹列表: {folder_names}")
        except Exception:
            logger.debug("[append-sent] LIST 失败，跳过诊断")

        # 尝试每个候选文件夹，第一个成功的即返回
        for sent_box in sent_candidates:
            try:
                quoted = _imap_quote_mailbox(sent_box)
                logger.debug(f"[append-sent] 尝试 APPEND 到 {sent_box} (quoted={quoted})")
                typ, _ = client.append(
                    quoted, "(\\Seen)", None, raw_bytes
                )
                if typ == "OK":
                    logger.debug(f"[append-sent] 成功保存副本到 {sent_box}")
                    return
                else:
                    logger.warning(f"[append-sent] APPEND {sent_box} 返回 {typ}")
            except imaplib.IMAP4.error as e:
                logger.warning(f"[append-sent] APPEND {sent_box} 失败: {e}")
                continue
        # 所有候选文件夹都失败，尝试 LIST 查找含 sent/已发送 的文件夹
        typ, data = client.list()
        if typ == "OK":
            for item in data or []:
                try:
                    line = bytes(item).decode("utf-8", errors="ignore")
                except Exception:
                    continue
                lower = line.lower()
                if "sent" in lower or "已发送" in line:
                    # 提取文件夹名（最后一个引号内的内容）
                    m = re.search(r'"([^"]+)"\s*$', line)
                    if m:
                        folder_name = m.group(1)
                        try:
                            quoted = _imap_quote_mailbox(folder_name)
                            logger.debug(f"[append-sent] LIST 发现文件夹 {folder_name}，尝试 APPEND")
                            typ, _ = client.append(
                                quoted, "(\\Seen)", None, raw_bytes
                            )
                            if typ == "OK":
                                logger.debug(f"[append-sent] 成功保存副本到 {folder_name}")
                                return
                        except imaplib.IMAP4.error as e:
                            logger.warning(f"[append-sent] APPEND {folder_name} 失败: {e}")
                            continue
        logger.warning(
            "邮件已通过 SMTP 发送，但未找到可用的 Sent 文件夹保存副本"
        )

    try:
        imap_pool_manager.run(body, op)
    except Exception:
        logger.warning("保存已发送邮件副本失败", exc_info=True)


async def handle_email_send(request: web.Request) -> web.Response:
    """POST /email/send - 通过 SMTP 发送邮件。

    请求体包含 SMTP 连接信息和邮件内容，发送成功返回：
    {"status": "ok", "rawBytes": "<base64>", "messageId": "...", "date": "..."}
    其中 rawBytes 是 RFC822 原始字节（base64 编码），messageId 用于本地索引。

    同步执行 SMTP 发送 + IMAP APPEND 保存副本，确保 APPEND 完成后再返回，
    让 Rust 侧能立即同步"已发送"文件夹索引。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        # 1. SMTP 发送（同步）
        raw_bytes = await _retry_smtp_call(_smtp_send_message_no_append, body)
        logger.debug(f"[email-send] SMTP 发送成功，raw_bytes 大小={len(raw_bytes)}")

        # 2. 同步保存副本到 IMAP 服务器（等 APPEND 完成再返回）
        # 必须同步：Rust 侧返回后会立即同步"已发送"文件夹，APPEND 必须先完成
        if raw_bytes:
            try:
                await _safe_append_sent(body, raw_bytes)
                logger.debug("[email-send] IMAP APPEND 副本保存完成")
            except Exception:
                logger.warning("[email-send] 保存已发送副本失败（不影响发送结果）", exc_info=True)
        else:
            logger.warning("[email-send] raw_bytes 为空，跳过保存副本")

        # 3. 提取 Message-Id 和 Date，供 Rust 侧落盘 .eml + 写本地索引
        message_id = ""
        date_str = ""
        in_reply_to = ""
        try:
            import email as email_lib
            msg = email_lib.message_from_bytes(raw_bytes)
            message_id = (msg.get("Message-Id") or "").strip()
            date_str = (msg.get("Date") or "").strip()
            in_reply_to = (msg.get("In-Reply-To") or "").strip()
        except Exception:
            logger.debug("[email-send] 提取 Message-Id/Date 失败", exc_info=True)

        # 4. 异步检查是否回复了某封关联待办的邮件，若是则给待办加"已回复"备注
        if in_reply_to:
            asyncio.create_task(
                _mark_todos_replied(request.app, in_reply_to, date_str or message_id)
            )

        return web.json_response({
            "status": "ok",
            "rawBytes": base64.b64encode(raw_bytes).decode("ascii") if raw_bytes else "",
            "messageId": message_id,
            "date": date_str,
        })
    except Exception as e:
        logger.exception("Email send failed")
        friendly = _format_smtp_error(e)
        return web.json_response({"error": friendly}, status=500)


def _append_sent_done_callback(task: asyncio.Task) -> None:
    """异步保存副本任务的完成回调，记录成功/失败日志。"""
    try:
        task.result()
        logger.debug("[email-send] 保存已发送副本异步任务完成")
    except asyncio.CancelledError:
        logger.warning("[email-send] 保存已发送副本异步任务被取消")
    except Exception as e:
        logger.warning(f"[email-send] 保存已发送副本异步任务失败: {e}")


async def _mark_todos_replied(app: web.Application, in_reply_to: str, ref: str) -> None:
    """邮件回复成功后，给来源邮件的关联待办加"已回复"备注。

    匹配条件：todo.source_type == 'email' 且 source_locator.messageId == in_reply_to。
    非阻塞：任何异常只记日志，不影响发送主流程。
    """
    todo_svc = app.get("todo_service")
    if todo_svc is None:
        return
    try:
        items = await todo_svc.list_items(state="open", source_type="email")
        matched = [
            it for it in items
            if it.source_locator.get("messageId") == in_reply_to
        ]
        if not matched:
            return
        for it in matched:
            existing_notes = it.notes or ""
            reply_tag = f"[已回复 {ref}]"
            if reply_tag in existing_notes:
                continue
            new_notes = f"{existing_notes}\n{reply_tag}".strip()
            await todo_svc.update_item(it.id, {"notes": new_notes})
            logger.debug("[todo-reply] 已为待办 {} 标注已回复", it.id)
    except Exception:
        logger.warning("[todo-reply] 标注已回复失败", exc_info=True)


async def _safe_append_sent(body: dict[str, Any], raw_bytes: bytes) -> None:
    """异步保存已发送邮件副本，任何异常只记日志不影响主流程。

    通过 _run_imap_locked 获取 per-account 锁，避免与后台同步并发操作同一 IMAP 连接。
    """
    try:
        logger.debug("[append-sent] 开始保存已发送邮件副本")
        await _run_imap_locked(body, lambda b: _imap_append_sent(b, raw_bytes))
        logger.debug("[append-sent] 保存已发送邮件副本流程结束")
    except Exception:
        logger.warning("保存已发送邮件副本失败", exc_info=True)


def _format_smtp_error(e: Exception) -> str:
    """将 SMTP 异常格式化为用户友好的中文提示。

    smtplib 的认证/响应异常是 tuple 形式 (code, bytes_message)，
    直接 str() 会得到 "(535, b'Error: ...')" 这种 repr 格式，对用户不友好。
    """
    msg = str(e)
    # 提取 SMTP 响应码和消息文本（形如 (535, b'Error: authentication failed, system busy')）
    m = re.match(r"\(\s*(\d+)\s*,\s*b['\"](.+)['\"]\s*\)", msg)
    if m:
        code = int(m.group(1))
        text = m.group(2)
    elif isinstance(e, smtplib.SMTPResponseException):
        code = e.smtp_code
        text = e.smtp_error.decode("utf-8", errors="ignore") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
    else:
        code = 0
        text = msg

    text_lower = text.lower()
    # 535 认证失败：优先判断是否为密码/授权码错误
    if code == 535:
        # 腾讯企业邮返回 "system busy" 并不一定是风控，也可能是密码错误时的通用提示
        # 准确告知用户：认证失败，让用户检查密码/授权码
        return f"SMTP 认证失败（535）：{text}。请检查账号设置中的 SMTP 密码或授权码是否正确。腾讯企业邮需使用客户端专用密码，非网页登录密码。"
    # 554 发送被拒
    if code == 554 or "message rejected" in text_lower:
        return f"邮件被服务器拒收（554）：{text}。可能是内容被识别为垃圾邮件或发信频率过高。"
    # 550 信封/路由错误
    if code == 550:
        return f"发送失败（550）：{text}。可能是收件人地址无效或被对方拒收。"
    # 其他错误：返回清理后的文本
    return f"发送邮件失败（{code}）：{text}" if code else f"发送邮件失败：{text}"


async def _retry_smtp_call(
    func: Callable[[dict[str, Any]], _T],
    body: dict[str, Any],
    max_retries: int = 2,
) -> _T:
    """执行 SMTP 调用，对瞬时网络故障做指数退避重试（发送邮件重试次数较少，避免重复发送）。"""
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return await asyncio.to_thread(func, body)
        except Exception as e:
            last_error = e
            if attempt >= max_retries or not _is_retryable_error(e):
                raise
            backoff = 2 ** attempt  # 1s, 2s
            logger.warning(
                f"[smtp] retryable error (attempt {attempt + 1}/{max_retries + 1}): {e}, "
                f"retry in {backoff}s"
            )
            await asyncio.sleep(backoff)
    assert last_error is not None
    raise last_error


def _imap_save_draft(body: dict[str, Any]) -> None:
    """连接 IMAP，将草稿通过 APPEND 保存到 Drafts 文件夹。

    草稿邮件带 \\Draft 标志，按常见 Drafts 文件夹名优先级尝试 APPEND。
    复用持久连接池。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()

    from_address = str(body.get("fromAddress", "") or "").strip()
    from_name = str(body.get("fromName", "") or "").strip()
    to_addrs = body.get("to", []) or []
    cc_addrs = body.get("cc", []) or []
    subject = str(body.get("subject", "") or "")
    body_html = str(body.get("bodyHtml", "") or "")
    in_reply_to = body.get("inReplyTo")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    # 构造草稿邮件
    msg = EmailMessage()
    sender_addr = from_address or imap_username
    if from_name:
        msg["From"] = formataddr((from_name, sender_addr))
    else:
        msg["From"] = sender_addr
    if to_addrs:
        msg["To"] = ", ".join(to_addrs)
    if cc_addrs:
        msg["Cc"] = ", ".join(cc_addrs)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    if in_reply_to:
        msg["In-Reply-To"] = str(in_reply_to)
        msg["References"] = str(in_reply_to)
    msg.set_content(body_html, subtype="html")

    raw_bytes = msg.as_bytes()
    # 常见草稿文件夹名（按优先级）
    draft_candidates = ["Drafts", "Draft", "草稿", "已发送草稿"]

    def op(client: imaplib.IMAP4) -> None:
        # 尝试每个草稿文件夹，第一个成功的即返回
        for draft_box in draft_candidates:
            try:
                typ, _ = client.append(
                    _imap_quote_mailbox(draft_box), "(\\Draft)", None, raw_bytes
                )
                if typ == "OK":
                    return
            except imaplib.IMAP4.error:
                continue
        # 所有候选文件夹都失败，尝试 LIST 查找含 Draft 的文件夹
        typ, data = client.list()
        if typ == "OK":
            for item in data or []:
                try:
                    line = bytes(item).decode("utf-8", errors="ignore")
                except Exception:
                    continue
                lower = line.lower()
                if "draft" in lower or "草稿" in line:
                    # 提取文件夹名（最后一个引号内的内容）
                    m = re.search(r'"([^"]+)"\s*$', line)
                    if m:
                        folder_name = m.group(1)
                        try:
                            typ, _ = client.append(
                                _imap_quote_mailbox(folder_name), "(\\Draft)", None, raw_bytes
                            )
                            if typ == "OK":
                                return
                        except imaplib.IMAP4.error:
                            continue
        raise RuntimeError("未找到可用的 Drafts 文件夹，请确认邮箱已创建草稿箱")

    imap_pool_manager.run(body, op)


async def handle_email_save_draft(request: web.Request) -> web.Response:
    """POST /email/save_draft - 保存草稿到 IMAP Drafts 文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_save_draft)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email save draft failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_test_connection(body: dict[str, Any]) -> dict[str, Any]:
    """测试 IMAP 登录连接，返回 {"ok": true} 或抛出异常。

    测试连接时先重置连接池，确保使用最新的账号配置（用户可能刚修改密码）。
    使用一次性连接，不复用池（避免测试失败污染池状态）。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    # 重置连接池，清除可能的 failed 状态（用户修改配置后会先点测试连接）
    imap_pool_manager.reset_pool(body)

    # 使用一次性连接测试，避免测试失败影响池
    if use_ssl:
        ctx = ssl.create_default_context()
        with imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30) as mail:
            mail.login(imap_username, imap_password)
            # 列出文件夹以确认权限正常
            typ, data = mail.list()
            folders = []
            if typ == "OK":
                for item in data or []:
                    try:
                        folders.append(bytes(item).decode("utf-8", errors="ignore"))
                    except Exception:
                        pass
            return {"ok": True, "folders": len(folders)}
    else:
        with imaplib.IMAP4(imap_host, imap_port, timeout=30) as mail:
            mail.starttls(ssl.create_default_context())
            mail.login(imap_username, imap_password)
            return {"ok": True, "folders": 0}


async def handle_email_test_connection(request: web.Request) -> web.Response:
    """POST /email/test_connection - 测试 IMAP 登录连接。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_test_connection)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email test connection failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_reset_pool(request: web.Request) -> web.Response:
    """POST /email/reset_pool - 重置指定账号的 IMAP 连接池。

    在删除账号、修改账号配置或遇到连接异常时调用，清除持久连接和 failed 状态，
    下次操作时会自动重建连接。请求体：{ imapHost, imapUsername }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        imap_pool_manager.reset_pool(body)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email reset pool failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_pool_status(request: web.Request) -> web.Response:
    """GET /email/pool_status - 获取所有 IMAP 连接池的状态（监控/调试用）。"""
    return web.json_response({"pools": imap_pool_manager.status()})


# ---------------------------------------------------------------------------
# Contacts (CardDAV) 路由
# ---------------------------------------------------------------------------


async def handle_contacts_sync(request: web.Request) -> web.Response:
    """POST /contacts/sync - 同步 CardDAV 地址簿（仅下载）。

    请求体：{ accountId, carddavUrl, username, password, oldSyncToken? }
    返回：{ added, updated, deleted, total, syncToken, contacts, deletedUids, error? }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    carddav_url = str(body.get("carddavUrl", "") or "").strip()
    username = str(body.get("username", "") or "").strip()
    password = str(body.get("password", "") or "")
    old_token = body.get("oldSyncToken")

    if not carddav_url or not username:
        return web.json_response({"error": "carddavUrl and username are required"}, status=400)

    from mona.contacts.sync import sync_account_contacts

    try:
        result = await sync_account_contacts(
            carddav_url, username, password, old_token
        )
        return web.json_response({
            "added": result.added,
            "updated": result.updated,
            "deleted": result.deleted,
            "total": result.total,
            "syncToken": result.sync_token,
            "contacts": [
                {
                    "remoteUid": c.remote_uid,
                    "etag": c.etag,
                    "data": c.data,
                }
                for c in result.contacts
            ],
            "deletedUids": result.deleted_uids,
            "error": result.error,
        })
    except Exception as e:
        logger.exception("Contacts sync failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_contacts_test_carddav(request: web.Request) -> web.Response:
    """POST /contacts/test_carddav - 测试 CardDAV 连接。

    请求体：{ carddavUrl, username, password }
    返回：{ ok, contactsCount?, error? }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    carddav_url = str(body.get("carddavUrl", "") or "").strip()
    username = str(body.get("username", "") or "").strip()
    password = str(body.get("password", "") or "")

    if not carddav_url or not username:
        return web.json_response({"error": "carddavUrl and username are required"}, status=400)

    from mona.contacts.sync import test_carddav_connection

    try:
        ok, count, err = await test_carddav_connection(carddav_url, username, password)
        return web.json_response({
            "ok": ok,
            "contactsCount": count if ok else None,
            "error": err,
        })
    except Exception as e:
        logger.exception("CardDAV test failed")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_contacts_sync_eas(request: web.Request) -> web.Response:
    """POST /contacts/sync_eas - 通过 Exchange ActiveSync 同步联系人（仅下载）。

    请求体：{ accountId, easUrl, username, password, oldSyncToken? }
    返回：{ added, updated, deleted, total, syncToken, contacts, deletedUids, error? }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "").strip()
    eas_url = str(body.get("easUrl", "") or "").strip()
    username = str(body.get("username", "") or "").strip()
    password = str(body.get("password", "") or "")
    old_token = body.get("oldSyncToken")

    if not eas_url or not username or not account_id:
        return web.json_response(
            {"error": "easUrl, username and accountId are required"}, status=400
        )

    from mona.contacts.sync import sync_account_contacts_eas

    try:
        result = await sync_account_contacts_eas(
            eas_url, username, password, account_id, old_token
        )
        return web.json_response({
            "added": result.added,
            "updated": result.updated,
            "deleted": result.deleted,
            "total": result.total,
            "syncToken": result.sync_token,
            "contacts": [
                {
                    "remoteUid": c.remote_uid,
                    "etag": c.etag,
                    "data": c.data,
                }
                for c in result.contacts
            ],
            "deletedUids": result.deleted_uids,
            "error": result.error,
        })
    except Exception as e:
        logger.exception("EAS contacts sync failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_contacts_test_eas(request: web.Request) -> web.Response:
    """POST /contacts/test_eas - 测试 Exchange ActiveSync 连接。

    请求体：{ easUrl, username, password, accountId? }
    返回：{ ok, contactsCount?, error? }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    eas_url = str(body.get("easUrl", "") or "").strip()
    username = str(body.get("username", "") or "").strip()
    password = str(body.get("password", "") or "")
    account_id = str(body.get("accountId", "") or "").strip()

    if not eas_url or not username:
        return web.json_response({"error": "easUrl and username are required"}, status=400)

    from mona.contacts.sync import test_eas_connection

    try:
        ok, count, err = await test_eas_connection(eas_url, username, password, account_id)
        return web.json_response({
            "ok": ok,
            "contactsCount": count if ok else None,
            "error": err,
        })
    except Exception as e:
        logger.exception("EAS test failed")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# IMAP IDLE 路由
# ---------------------------------------------------------------------------


async def handle_email_idle_start(request: web.Request) -> web.Response:
    """POST /email/idle/start - 启动指定账号的 IMAP IDLE 监听。

    请求体：{ accountId, imapHost, imapPort, imapUsername, imapPassword, mailbox?, useSsl? }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "").strip()
    if not account_id:
        return web.json_response({"error": "accountId is required"}, status=400)

    try:
        _idle_manager.start_account(account_id, body)
        return web.json_response({"ok": True, "accountId": account_id})
    except Exception as e:
        logger.exception(f"Failed to start IDLE for {account_id}")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_idle_stop(request: web.Request) -> web.Response:
    """POST /email/idle/stop - 停止指定账号的 IMAP IDLE 监听。

    请求体：{ accountId }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "").strip()
    if not account_id:
        return web.json_response({"error": "accountId is required"}, status=400)

    _idle_manager.stop_account(account_id)
    return web.json_response({"ok": True, "accountId": account_id})


# ---------------------------------------------------------------------------
# Skill lifecycle routes (settings panel)
# ---------------------------------------------------------------------------


async def handle_skills_list(request: web.Request) -> web.Response:
    """GET /api/skills/list - 列出所有 skill（active + archived）及使用统计。

    返回：{ skills: [{ name, provenance, location, access_count,
                      last_accessed_at, created_at, pinned, archived_at }] }
    """
    from mona.agent import skill_usage

    try:
        rows = skill_usage.usage_report()
    except Exception as e:
        logger.exception("[skills] list failed")
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"skills": rows})


async def handle_skills_set_pinned(request: web.Request) -> web.Response:
    """POST /api/skills/set_pinned - 设置/取消置顶。

    请求体：{ name, pinned }
    """
    from mona.agent import skill_usage

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = str(body.get("name", "") or "").strip()
    pinned = bool(body.get("pinned", False))
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    try:
        skill_usage.set_pinned(name, pinned)
    except Exception as e:
        logger.exception("[skills] set_pinned failed")
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"ok": True, "name": name, "pinned": pinned})


async def handle_skills_archive(request: web.Request) -> web.Response:
    """POST /api/skills/archive - 手动归档（可恢复）。

    请求体：{ name }
    """
    from mona.agent import skill_usage

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = str(body.get("name", "") or "").strip()
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    try:
        ok, msg = skill_usage.archive_skill(name, automatic=False)
    except Exception as e:
        logger.exception("[skills] archive failed")
        return web.json_response({"error": str(e)}, status=500)
    if not ok:
        return web.json_response({"error": msg}, status=400)
    return web.json_response({"ok": True, "name": name, "message": msg})


async def handle_skills_restore(request: web.Request) -> web.Response:
    """POST /api/skills/restore - 从归档恢复。

    请求体：{ name }
    """
    from mona.agent import skill_usage

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = str(body.get("name", "") or "").strip()
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    try:
        ok, msg = skill_usage.restore_skill(name)
    except Exception as e:
        logger.exception("[skills] restore failed")
        return web.json_response({"error": str(e)}, status=500)
    if not ok:
        return web.json_response({"error": msg}, status=400)
    return web.json_response({"ok": True, "name": name, "message": msg})


async def handle_skills_prune(request: web.Request) -> web.Response:
    """POST /api/skills/prune - dry-run 或实际归档闲置 skill。

    请求体：{ apply?, days? }
    返回：{ candidates: [...], archived: [{name, ok, message}]? }
    """
    from mona.agent import skill_usage
    from mona.config.loader import load_config

    try:
        body = await request.json() if request.can_read_body else {}
    except Exception:
        body = {}

    apply = bool(body.get("apply", False))
    days = body.get("days")
    if days is None:
        try:
            config = load_config()
            days = config.agents.defaults.dream.archive_after_days
        except Exception:
            days = 90
    try:
        days = int(days)
        if days < 1:
            days = 90
    except (TypeError, ValueError):
        days = 90

    disabled: set[str] = set()
    try:
        config = load_config()
        disabled = set(config.agents.defaults.disabled_skills or [])
    except Exception:
        pass

    try:
        candidates = skill_usage.plan_automatic_archives(
            archive_after_days=days,
            disabled_skills=disabled,
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=500)

    archived: list[dict[str, Any]] = []
    if apply:
        for name in candidates:
            ok, msg = skill_usage.archive_skill(name, automatic=True)
            archived.append({"name": name, "ok": ok, "message": msg})

    return web.json_response({
        "candidates": candidates,
        "archived": archived,
        "applied": apply,
        "days": days,
    })


async def handle_skills_config(request: web.Request) -> web.Response:
    """GET /api/skills/config - 读取 skill 生命周期配置。

    返回：{ skillPruneEnabled, archiveAfterDays, maxActiveUserSkills,
            activeCount, archivedCount }
    """
    from mona.agent import skill_usage
    from mona.config.loader import load_config

    try:
        config = load_config()
        dream = config.agents.defaults.dream
    except Exception:
        dream = None

    skill_prune_enabled = bool(getattr(dream, "skill_prune_enabled", False))
    archive_after_days = int(getattr(dream, "archive_after_days", 90))
    max_active = int(getattr(dream, "max_active_user_skills", 100))

    try:
        active_count = len(skill_usage.list_active_user_skill_names())
        archived_count = len(skill_usage.list_archived_skill_names())
    except Exception:
        active_count = 0
        archived_count = 0

    return web.json_response({
        "skillPruneEnabled": skill_prune_enabled,
        "archiveAfterDays": archive_after_days,
        "maxActiveUserSkills": max_active,
        "activeCount": active_count,
        "archivedCount": archived_count,
    })


async def handle_skills_update_config(request: web.Request) -> web.Response:
    """POST /api/skills/update_config - 更新 skill 生命周期配置。

    请求体：{ skillPruneEnabled?, archiveAfterDays?, maxActiveUserSkills? }
    """
    from mona.config.loader import load_config, save_config

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        config = load_config()
        dream = config.agents.defaults.dream
        if "skillPruneEnabled" in body:
            dream.skill_prune_enabled = bool(body["skillPruneEnabled"])
        if "archiveAfterDays" in body:
            days = int(body["archiveAfterDays"])
            if days < 1:
                return web.json_response(
                    {"error": "archiveAfterDays must be >= 1"}, status=400
                )
            dream.archive_after_days = days
        if "maxActiveUserSkills" in body:
            cap = int(body["maxActiveUserSkills"])
            if cap < 1:
                return web.json_response(
                    {"error": "maxActiveUserSkills must be >= 1"}, status=400
                )
            dream.max_active_user_skills = cap
        save_config(config)
    except Exception as e:
        logger.exception("[skills] update_config failed")
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True})


# ---------------------------------------------------------------------------
# MCP server lifecycle routes (settings panel)
# ---------------------------------------------------------------------------

_SENSITIVE_MASK = "****"


def _mask_mcp_server_config(cfg) -> dict[str, Any]:
    """Return a JSON-safe view of MCPServerConfig with sensitive fields masked."""
    return {
        "type": cfg.type,
        "command": cfg.command,
        "args": list(cfg.args),
        "env": {k: (_SENSITIVE_MASK if v else "") for k, v in (cfg.env or {}).items()},
        "url": cfg.url,
        "headers": {
            k: (_SENSITIVE_MASK if v else "") for k, v in (cfg.headers or {}).items()
        },
        "toolTimeout": cfg.tool_timeout,
        "enabledTools": list(cfg.enabled_tools) if cfg.enabled_tools else ["*"],
    }


def _merge_sensitive(
    new_vals: dict[str, str] | None,
    old_vals: dict[str, str] | None,
) -> dict[str, str]:
    """Merge submitted env/headers with existing values.

    If a submitted value equals the mask placeholder, keep the existing value.
    Empty string is treated as "clear this entry".
    """
    if new_vals is None:
        return dict(old_vals or {})
    old = old_vals or {}
    out: dict[str, str] = {}
    for k, v in new_vals.items():
        if v == _SENSITIVE_MASK:
            if k in old:
                out[k] = old[k]
            # else: drop the entry (no existing value to preserve)
        elif v == "":
            # explicit clear
            continue
        else:
            out[k] = v
    return out


def _build_mcp_config_from_request(
    body: dict[str, Any],
    existing=None,
) -> dict[str, Any]:
    """Build a MCPServerConfig-compatible dict from request body.

    If `existing` (a MCPServerConfig) is provided, masked sensitive fields
    not overridden by the request are preserved from it.
    """
    from mona.config.schema import MCPServerConfig

    old_env = getattr(existing, "env", None) if existing else None
    old_headers = getattr(existing, "headers", None) if existing else None

    raw_type = body.get("type")
    if raw_type not in ("stdio", "sse", "streamableHttp", None, ""):
        raise ValueError(f"Invalid transport type: {raw_type}")
    transport = raw_type if raw_type else None

    cfg_dict: dict[str, Any] = {
        "type": transport,
        "command": str(body.get("command", "") or ""),
        "args": [str(a) for a in body.get("args", []) if a is not None],
        "env": _merge_sensitive(body.get("env"), old_env),
        "url": str(body.get("url", "") or ""),
        "headers": _merge_sensitive(body.get("headers"), old_headers),
        "tool_timeout": int(body.get("toolTimeout", 30) or 30),
        "enabled_tools": (
            [str(t) for t in body.get("enabledTools", ["*"])]
            if body.get("enabledTools") is not None
            else ["*"]
        ),
    }
    # Validate via Pydantic
    MCPServerConfig(**cfg_dict)
    return cfg_dict


async def handle_mcp_list_servers(request: web.Request) -> web.Response:
    """GET /api/mcp/servers - list configured servers with runtime status + masked config."""
    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    try:
        statuses = agent_loop.get_mcp_status()
        # Attach masked config for each server
        out: list[dict[str, Any]] = []
        for row in statuses:
            cfg = agent_loop._mcp_servers.get(row["name"])
            if cfg is not None:
                row["config"] = _mask_mcp_server_config(cfg)
            out.append(row)
        return web.json_response({"servers": out})
    except Exception as e:
        logger.exception("[mcp] list failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_list_tools(request: web.Request) -> web.Response:
    """GET /api/mcp/servers/{name}/tools - list tools registered by a server."""
    from mona.agent.tools.mcp import list_mcp_server_tools

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)
    name = request.match_info.get("name", "")
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    try:
        tools = list_mcp_server_tools(agent_loop.tools, name)
        return web.json_response({"name": name, "tools": tools})
    except Exception as e:
        logger.exception("[mcp] list tools failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_create_server(request: web.Request) -> web.Response:
    """POST /api/mcp/servers - add a new server (persist to config + connect)."""
    from mona.config.loader import load_config, save_config
    from mona.config.schema import MCPServerConfig

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = str(body.get("name", "") or "").strip()
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    if name in agent_loop._mcp_servers:
        return web.json_response(
            {"error": f"Server '{name}' already exists"}, status=400
        )

    try:
        cfg_dict = _build_mcp_config_from_request(body)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    try:
        cfg = MCPServerConfig(**cfg_dict)
        # 1. Persist to config.json
        config = load_config()
        config.tools.mcp_servers[name] = cfg
        save_config(config)
        # 2. Add to runtime + connect
        result = await agent_loop.add_mcp_server(name, cfg)
        return web.json_response(result, status=201 if result.get("ok") else 500)
    except Exception as e:
        logger.exception("[mcp] create failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_update_server(request: web.Request) -> web.Response:
    """PUT /api/mcp/servers/{name} - update a server (persist + restart)."""
    from mona.config.loader import load_config, save_config
    from mona.config.schema import MCPServerConfig

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    name = request.match_info.get("name", "")
    if not name:
        return web.json_response({"error": "name is required"}, status=400)

    existing = agent_loop._mcp_servers.get(name)
    if existing is None:
        return web.json_response(
            {"error": f"Server '{name}' not configured"}, status=404
        )

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        cfg_dict = _build_mcp_config_from_request(body, existing=existing)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    try:
        cfg = MCPServerConfig(**cfg_dict)
        # 1. Persist to config.json
        config = load_config()
        config.tools.mcp_servers[name] = cfg
        save_config(config)
        # 2. Update runtime config + restart
        agent_loop._mcp_servers[name] = cfg
        result = await agent_loop.restart_mcp_server(name)
        return web.json_response(result)
    except Exception as e:
        logger.exception("[mcp] update failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_delete_server(request: web.Request) -> web.Response:
    """DELETE /api/mcp/servers/{name} - remove a server (persist + disconnect)."""
    from mona.config.loader import load_config, save_config

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    name = request.match_info.get("name", "")
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    if name not in agent_loop._mcp_servers:
        return web.json_response(
            {"error": f"Server '{name}' not configured"}, status=404
        )

    try:
        # 1. Disconnect + remove from runtime
        result = await agent_loop.remove_mcp_server(name)
        if not result.get("ok"):
            return web.json_response(result, status=400)
        # 2. Persist to config.json
        config = load_config()
        if name in config.tools.mcp_servers:
            del config.tools.mcp_servers[name]
            save_config(config)
        return web.json_response(result)
    except Exception as e:
        logger.exception("[mcp] delete failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_restart_server(request: web.Request) -> web.Response:
    """POST /api/mcp/servers/{name}/restart - reconnect a single server."""
    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    name = request.match_info.get("name", "")
    if not name:
        return web.json_response({"error": "name is required"}, status=400)
    try:
        result = await agent_loop.restart_mcp_server(name)
        return web.json_response(result)
    except Exception as e:
        logger.exception("[mcp] restart failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_mcp_reload(request: web.Request) -> web.Response:
    """POST /api/mcp/reload - close all stacks and reconnect from config.json."""
    from mona.config.loader import load_config

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)
    try:
        # Re-sync runtime config from disk (in case user edited config.json manually)
        config = load_config()
        agent_loop._mcp_servers = dict(config.tools.mcp_servers)
        result = await agent_loop.reload_mcp()
        return web.json_response(result)
    except Exception as e:
        logger.exception("[mcp] reload failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_account_removed(request: web.Request) -> web.Response:
    """POST /email/account_removed - 账号被删除时清理 IDLE 和连接池。

    请求体：{ accountId, imapHost, imapUsername }
    Rust 侧删除账号后必须调用此接口，避免后台 IDLE/连接池继续尝试登录。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "").strip()
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    if not account_id:
        return web.json_response({"error": "accountId is required"}, status=400)

    # 1. 停止该账号的 IDLE 监听（防止后台线程继续 login）
    try:
        _idle_manager.stop_account(account_id)
    except Exception:
        logger.exception(f"[account-removed] failed to stop idle for {account_id}")

    # 2. 移除该账号的 IMAP 连接池（防止保活/下次操作触发 login）
    if imap_host and imap_username:
        try:
            imap_pool_manager.remove_pool(imap_host, imap_username)
        except Exception:
            logger.exception(f"[account-removed] failed to remove pool for {imap_username}")

    return web.json_response({"ok": True, "accountId": account_id})


async def handle_email_idle_status(request: web.Request) -> web.Response:
    """GET /email/idle/status - 查询当前 IDLE 监听状态。"""
    return web.json_response({"active": _idle_manager.list_active()})


async def handle_email_idle_ws(request: web.Request) -> web.WebSocketResponse:
    """GET /email/idle/ws - WebSocket 端点，推送新邮件事件。

    事件格式：{"type": "new-mail", "accountId": "..."}
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await _idle_manager.add_ws_client(ws)
    try:
        # 发送连接确认
        await ws.send_json({"type": "connected"})
        # 保持连接，接收客户端心跳
        async for msg in ws:
            if msg.type == web.WSMsgType.ERROR:
                break
    finally:
        await _idle_manager.remove_ws_client(ws)
    return ws


def _imap_delete_message(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 并删除邮件。

    优先 MOVE 到回收站（Trash/Deleted Messages/已删除），失败则回退到 +FLAGS \\Deleted + expunge。
    返回 {"action": "moved"|"deleted", "target": "<trash_folder>"|None}。
    复用持久连接池。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not uid:
        raise ValueError("uid is required")

    # 常见回收站文件夹名（按优先级匹配）
    trash_candidates = [
        "Trash", "Deleted Messages", "已删除", "Deleted", "垃圾邮件",
        "Deleted Items", "Junk", "已删除邮件", "废纸篓",
    ]

    result = {"action": "deleted", "target": None}

    def op(client: imaplib.IMAP4) -> None:
        client.select(_imap_quote_mailbox(mailbox))
        target = _delete_with_trash_fallback(client, uid, mailbox, trash_candidates)
        if target is not None:
            result["action"] = "moved"
            result["target"] = target

    # 注意：MOVE/EXPUNGE 后部分服务器会立即关闭连接，
    # 连接池会自动重连，不影响下次操作
    imap_pool_manager.run(body, op)
    return result


def _delete_with_trash_fallback(
    mail: Any, uid: str, current_mailbox: str, trash_candidates: list[str]
) -> str | None:
    """尝试 MOVE 到回收站，失败则直接标记删除。

    返回实际 MOVE 到的 trash 文件夹名；永久删除时返回 None。
    如果当前文件夹本身就是回收站，直接永久删除。
    """
    # 先动态查找服务器上实际的 trash 文件夹（从 LIST 结果匹配 \Trash 标志）
    actual_trash = _find_trash_folder(mail, trash_candidates)

    # 判断当前文件夹是否是回收站：
    # 1. 名称匹配候选列表，或 2. IMAP LIST 标记为 \Trash
    is_trash = current_mailbox in trash_candidates or (
        actual_trash is not None and current_mailbox == actual_trash
    )

    if is_trash:
        # 在回收站里删除 = 永久删除
        mail.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
        mail.expunge()
        # 验证邮件是否真的被删除了（UID 可能已失效）
        typ, data = mail.uid("SEARCH", None, uid)
        if typ == "OK" and data and data[0] and data[0].strip():
            raise RuntimeError(
                f"邮件删除失败：UID {uid} 仍存在于服务器（可能 UID 已失效，请先同步文件夹）"
            )
        return None

    # 尝试 MOVE 到找到的 trash 文件夹
    if actual_trash:
        try:
            mail.uid("MOVE", uid, _imap_quote_mailbox(actual_trash))
            return actual_trash
        except imaplib.IMAP4.error:
            pass  # 动态查找的也失败，回退到候选名逐一尝试

    # 回退：逐一尝试候选名（应对 LIST 权限受限的情况）
    for trash in trash_candidates:
        if trash == actual_trash:
            continue  # 已尝试过
        try:
            mail.uid("MOVE", uid, _imap_quote_mailbox(trash))
            return trash
        except imaplib.IMAP4.error:
            continue

    # 所有回收站都失败，回退到永久删除
    mail.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
    mail.expunge()
    return None


def _find_trash_folder(
    mail: Any, trash_candidates: list[str]
) -> str | None:
    """从 IMAP LIST 结果中查找回收站文件夹。

    优先匹配特殊标志 \\Trash，其次匹配候选名（不区分大小写）。
    """
    try:
        status, data = mail.list()
        if status != "OK" or not data:
            return None
        # 第一轮：查找带 \\Trash 标志的文件夹
        for item in data:
            if not item:
                continue
            if isinstance(item, bytes):
                line = item.decode("utf-8", errors="ignore")
            else:
                line = str(item)
            if "\\Trash" in line:
                # LIST 返回格式: * LIST (\Trash \HasNoChildren) "/" "Trash"
                # 提取最后一个引号包裹的文件夹名
                name = _extract_mailbox_name_from_list(line)
                if name:
                    return name
        # 第二轮：按候选名匹配（不区分大小写）
        lower_candidates = [c.lower() for c in trash_candidates]
        for item in data:
            if not item:
                continue
            if isinstance(item, bytes):
                line = item.decode("utf-8", errors="ignore")
            else:
                line = str(item)
            name = _extract_mailbox_name_from_list(line)
            if name and name.lower() in lower_candidates:
                return name
    except Exception:
        pass
    return None


def _extract_mailbox_name_from_list(line: str) -> str | None:
    """从 IMAP LIST 响应行中提取文件夹名（解码 Modified UTF-7）。"""
    # 格式: * LIST (\Trash) "/" "Trash" 或 * LIST (\HasNoChildren) "." "INBOX"
    # 找最后一个双引号包裹的部分
    import re

    m = re.search(r'"([^"]+)"\s*$', line)
    if not m:
        # 没有引号的裸文件夹名（如 INBOX）
        parts = line.split()
        if parts:
            return _decode_imap_utf7(parts[-1])
        return None
    return _decode_imap_utf7(m.group(1))


async def handle_email_delete(request: web.Request) -> web.Response:
    """POST /email/delete - 删除邮件：优先 MOVE 到回收站，失败则永久删除。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_delete_message)
        return web.json_response({"status": "ok", **result})
    except Exception as e:
        logger.exception("Email delete message failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_set_flag(body: dict[str, Any]) -> None:
    """连接 IMAP 并为指定 UID 设置或清除标志（\\Seen / \\Flagged 等）。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    flag = str(body.get("flag", "") or "").strip()
    add = bool(body.get("add", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not uid:
        raise ValueError("uid is required")
    if not flag:
        raise ValueError("flag is required")

    op = "+FLAGS" if add else "-FLAGS"

    def _op(client: imaplib.IMAP4) -> None:
        client.select(_imap_quote_mailbox(mailbox))
        client.uid("STORE", uid, op, f"({flag})")

    imap_pool_manager.run(body, _op)


async def handle_email_set_flag(request: web.Request) -> web.Response:
    """POST /email/set_flag - 设置或清除 IMAP 邮件标志（\\Seen / \\Flagged）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_set_flag)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email set flag failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_mark_all_read(body: dict[str, Any]) -> int:
    """连接 IMAP 并将指定文件夹中所有邮件标记为已读。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> int:
        client.select(_imap_quote_mailbox(mailbox))
        # 搜索所有未读邮件
        typ, data = client.search(None, "UNSEEN")
        if typ != "OK" or not data or not data[0]:
            return 0
        uids = data[0].split()
        if not uids:
            return 0
        # 批量标记已读：UID STORE uid1,uid2,... +FLAGS (\Seen)
        uid_set = b",".join(uids).decode()
        client.uid("STORE", uid_set, "+FLAGS", "(\\Seen)")
        return len(uids)

    return imap_pool_manager.run(body, op)


async def handle_email_mark_all_read(request: web.Request) -> web.Response:
    """POST /email/mark_all_read - 将指定文件夹所有邮件标记为已读。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        count = await _run_imap_locked(body, _imap_mark_all_read)
        return web.json_response({"status": "ok", "count": count})
    except Exception as e:
        logger.exception("Email mark all read failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_empty_folder(body: dict[str, Any]) -> int:
    """连接 IMAP 并永久删除指定文件夹中的所有邮件。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "") or "")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not mailbox:
        raise ValueError("mailbox is required")

    def op(client: imaplib.IMAP4) -> int:
        client.select(_imap_quote_mailbox(mailbox))
        typ, data = client.search(None, "ALL")
        if typ != "OK" or not data or not data[0]:
            return 0
        uids = data[0].split()
        for uid in uids:
            client.uid("STORE", uid.decode(), "+FLAGS", "(\\Deleted)")
        client.expunge()
        return len(uids)

    return imap_pool_manager.run(body, op)


async def handle_email_empty_folder(request: web.Request) -> web.Response:
    """POST /email/empty_folder - 清空指定文件夹中的所有邮件。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        count = await _run_imap_locked(body, _imap_empty_folder)
        return web.json_response({"status": "ok", "count": count})
    except Exception as e:
        logger.exception("Email empty folder failed")
        return web.json_response({"error": str(e)}, status=500)


def _parse_copyuid_response(client: imaplib.IMAP4) -> str | None:
    """从 IMAP 响应中解析 COPYUID/MOVEUID，返回目标 UID（RFC 4315 / RFC 6851）。

    响应格式：
      - COPY:   `OK [COPYUID <uidvalidity> <source-uid> <dest-uid>]`
      - MOVE:   `OK [COPYUID <uidvalidity> <source-uid> <dest-uid>]`（RFC 6851 复用 COPYUID）
    单 UID 时直接返回；UID 范围（如 123:123）取首尾推算单 UID 场景下的目标值。
    imaplib 将 untagged 响应存入 `client.untagged_responses`， tagged OK 中的 response code
    可能出现在 `client.response('COPYUID')` 或最近一次 completion 响应里。
    """
    candidates: list[str] = []
    # 1. 从 untagged_responses 抓 `* OK [COPYUID ...]` 或 `* [COPYUID ...]`
    for key in ("COPYUID", "MOVEUID"):
        values = client.untagged_responses.pop(key, []) or []
        candidates.extend(v.decode("utf-8", "ignore") if isinstance(v, bytes) else str(v) for v in values)
    # 2. 从 tagged completion 抓（部分服务器把 COPYUID 放在 OK 响应码里）
    for key in ("COPYUID", "MOVEUID"):
        try:
            typ, data = client.response(key)
        except Exception:
            typ, data = None, None
        if typ == "OK" and data:
            for item in data:
                candidates.append(item.decode("utf-8", "ignore") if isinstance(item, bytes) else str(item))
    for text in candidates:
        # 形如 "123 123 456" 或 "123 123:123 456:456"
        m = re.search(r"COPYUID\s+\d+\s+(\S+)\s+(\S+)", text)
        if not m:
            # 也可能 candidates 已经是纯数字串 "123 123 456"
            m = re.match(r"\s*\d+\s+(\S+)\s+(\S+)\s*$", text)
        if not m:
            continue
        dest_uid_range = m.group(2)
        # 单 UID 直接返回；UID 范围取第一个值（MOVE 单封邮件时范围退化为单值）
        if ":" in dest_uid_range:
            first = dest_uid_range.split(":")[0]
            try:
                _ = int(first)  # 校验是数字
                return first
            except ValueError:
                continue
        try:
            int(dest_uid_range)
            return dest_uid_range
        except ValueError:
            continue
    return None


def _imap_move_message(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 并将指定 UID 的邮件移动到目标文件夹。复用持久连接池。

    返回 ``{"destUid": str | None}``：
      - 服务器返回 COPYUID/MOVEUID 时给出目标文件夹的新 UID，调用方可直接 UPDATE 本地 uid
      - 服务器未返回时为 None，调用方需依赖 message_id 去重回退策略
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    dest_mailbox = str(body.get("destMailbox", "") or "").strip()
    uid = str(body.get("uid", "") or "")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not uid:
        raise ValueError("uid is required")
    if not dest_mailbox:
        raise ValueError("destMailbox is required")

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"select {mailbox} failed: {status}")
        # 优先尝试 IMAP MOVE（RFC 6851）。imaplib 对业务拒绝（NO/BAD）通常不抛异常，
        # 必须显式检查 status，否则服务器返回 NO 时本地仍会当作成功移动
        status, _ = client.uid("MOVE", uid, _imap_quote_mailbox(dest_mailbox))
        if status == "OK":
            # skill 第八章：优先解析 COPYUID/MOVEUID 关联源 UID 与目标 UID
            dest_uid = _parse_copyuid_response(client)
            return {"destUid": dest_uid}
        # MOVE 不被支持或被服务器拒绝，回退到 COPY+STORE+EXPUNGE
        status, _ = client.uid("COPY", uid, _imap_quote_mailbox(dest_mailbox))
        if status != "OK":
            raise RuntimeError(f"COPY uid {uid} to {dest_mailbox} failed: {status}")
        # COPY 成功后解析 COPYUID（RFC 4315），再做 STORE+EXPUNGE
        dest_uid = _parse_copyuid_response(client)
        status, _ = client.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
        if status != "OK":
            raise RuntimeError(f"STORE uid {uid} failed: {status}")
        client.expunge()
        return {"destUid": dest_uid}

    # 注意：MOVE/EXPUNGE 后部分服务器会立即关闭连接，
    # 连接池会自动重连，不影响下次操作
    return imap_pool_manager.run(body, op)


async def handle_email_move(request: web.Request) -> web.Response:
    """POST /email/move - 移动 IMAP 邮件到目标文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_move_message)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email move message failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_analyze(request: web.Request) -> web.Response:
    """POST /email/analyze - AI 分析单封邮件。

    人工单次触发，不自动介入。接收邮件内容，调用 LLM 返回结构化分析结果。
    不负责存储，由前端调用 Rust 命令持久化。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    subject = str(body.get("subject", "") or "")
    from_address = str(body.get("fromAddress", "") or "")
    from_name = body.get("fromName")
    if from_name is not None:
        from_name = str(from_name)
    date = str(body.get("date", "") or "")
    body_text = str(body.get("bodyText", "") or "")
    body_html = str(body.get("bodyHtml", "") or "") or None
    images = body.get("images") or []
    if not isinstance(images, list):
        images = []

    if not body_text and not body_html and not subject:
        return web.json_response({"error": "subject 或 bodyText/bodyHtml 至少需要一个"}, status=400)

    provider = _resolve_llm_provider(request)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    try:
        from mona.email_intel.analyze import analyze_email

        result = await analyze_email(
            provider,
            subject=subject,
            from_address=from_address,
            from_name=from_name,
            date=date,
            body_text=body_text,
            body_html=body_html,
            images=images,
        )
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email analyze failed")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_schedule_extract(request: web.Request) -> web.Response:
    """POST /email/schedule/extract - Rust sync hook 触发的批量日程提取。

    接收新邮件 UID 列表，逐封读取正文、调 LLM 提取日程、按配置 auto/confirm 创建。
    由 sync_folder_internal 异步调用，不阻塞同步流程。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "")
    folder = str(body.get("folder", "") or "")
    uids = body.get("uids") or []
    if not isinstance(uids, list):
        uids = []
    if not account_id or not folder or not uids:
        return web.json_response({"error": "accountId/folder/uids 不能为空"}, status=400)

    svc = request.app.get("schedule_service")
    if svc is None:
        return web.json_response({"error": "Schedule service not available"}, status=503)

    agent_loop = request.app.get("agent_loop")
    provider = _resolve_llm_provider(request)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    # 实时从 config.json 重新加载 schedule 配置。
    # agent_loop.config 是启动时的内存快照，用户在 UI 修改 schedule 配置后
    # gateway 不会自动 reload，必须实时读取才能让"启用"立即生效。
    from mona.config.loader import load_config

    try:
        config = load_config()
    except Exception:
        logger.exception("Failed to reload config for schedule extract")
        config = getattr(agent_loop, "config", None)

    schedule_config = None
    if config is not None:
        tools = getattr(config, "tools", None)
        if tools is not None:
            email_intel = getattr(tools, "email_intel", None)
            if email_intel is not None:
                schedule_config = getattr(email_intel, "schedule", None)

    if schedule_config is None or not schedule_config.enabled:
        return web.json_response({"processed": 0, "skipped": "disabled"})

    # 检查文件夹是否在配置列表中
    folder_key = f"{account_id}:{folder}"
    if folder_key not in schedule_config.folders:
        return web.json_response({"processed": 0, "skipped": "folder_not_configured"})

    from datetime import datetime

    from mona.email_intel.db import get_message
    from mona.email_intel.schedule_extract import process_email_for_schedule

    tz = getattr(config, "timezone", None) or "Asia/Shanghai"
    now_iso = datetime.now().isoformat()
    model = getattr(config, "model", None) or getattr(agent_loop, "model_name", None)

    results: dict[str, int] = {"created": 0, "pending": 0, "skipped": 0, "error": 0}
    failed_uids: list[str] = []
    for uid in uids:
        uid_str = str(uid)
        try:
            msg = get_message(uid_str, account_id, folder)
            if not msg:
                results["skipped"] += 1
                continue

            result = await process_email_for_schedule(
                provider,
                svc,
                schedule_config,
                account_id=account_id,
                uid=uid_str,
                folder=folder,
                subject=msg.get("subject") or "",
                from_address=msg.get("fromAddress") or "",
                from_name=msg.get("fromName"),
                date=msg.get("date") or "",
                body_text=msg.get("bodyText") or "",
                body_html=msg.get("bodyHtml"),
                now_iso=now_iso,
                tz=tz,
                model=model,
            )
            # error 表示 LLM 超时、网络错误或非法 JSON，等待 1 秒后重试一次
            if result == "error":
                await asyncio.sleep(1)
                try:
                    result = await process_email_for_schedule(
                        provider,
                        svc,
                        schedule_config,
                        account_id=account_id,
                        uid=uid_str,
                        folder=folder,
                        subject=msg.get("subject") or "",
                        from_address=msg.get("fromAddress") or "",
                        from_name=msg.get("fromName"),
                        date=msg.get("date") or "",
                        body_text=msg.get("bodyText") or "",
                        body_html=msg.get("bodyHtml"),
                        now_iso=now_iso,
                        tz=tz,
                        model=model,
                    )
                except Exception:
                    logger.exception("Schedule extract retry failed: uid={}", uid_str)
                    result = "error"
                if result == "error":
                    failed_uids.append(uid_str)

            if result in results:
                results[result] += 1
            else:
                results["skipped"] += 1
        except Exception:
            logger.exception("Schedule extract failed: uid={}", uid_str)
            results["error"] += 1
            failed_uids.append(uid_str)

    return web.json_response(
        {"processed": len(uids), **results, "failedUids": failed_uids}
    )


async def handle_email_schedule_pending(request: web.Request) -> web.Response:
    """GET /api/email/schedule/pending - 获取待确认的日程列表（前端轮询）。"""
    from mona.email_intel.schedule_extract import list_pending_confirmations

    return web.json_response({"items": list_pending_confirmations()})


async def handle_email_schedule_confirm(request: web.Request) -> web.Response:
    """POST /api/email/schedule/confirm - 确认创建待确认的日程。"""
    svc = _require_schedule_service(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    confirmation_id = str(body.get("id", "") or "")
    if not confirmation_id:
        return web.json_response({"error": "id 不能为空"}, status=400)

    from mona.email_intel.schedule_extract import confirm_pending_confirmation

    ok = await confirm_pending_confirmation(svc, confirmation_id)
    return web.json_response({"ok": ok})


async def handle_email_schedule_discard(request: web.Request) -> web.Response:
    """POST /api/email/schedule/discard - 丢弃待确认的日程。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    confirmation_id = str(body.get("id", "") or "")
    if not confirmation_id:
        return web.json_response({"error": "id 不能为空"}, status=400)

    from mona.email_intel.schedule_extract import discard_pending_confirmation

    ok = discard_pending_confirmation(confirmation_id)
    return web.json_response({"ok": ok})


async def handle_email_schedule_extract_manual(request: web.Request) -> web.Response:
    """POST /email/schedule/extract-manual - MailView 手动触发单封邮件的日程提取。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    account_id = str(body.get("accountId", "") or "")
    uid = str(body.get("uid", "") or "")
    folder = str(body.get("folder", "") or "")
    if not account_id or not uid or not folder:
        return web.json_response({"error": "accountId/uid/folder 不能为空"}, status=400)

    svc = request.app.get("schedule_service")
    if svc is None:
        return web.json_response({"error": "Schedule service not available"}, status=503)

    agent_loop = request.app.get("agent_loop")
    provider = _resolve_llm_provider(request)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    config = getattr(agent_loop, "config", None)
    if config is None:
        try:
            from mona.config.loader import load_config

            config = load_config()
        except Exception:
            config = None
    tz = "Asia/Shanghai"
    model = getattr(agent_loop, "model_name", None)
    if config is not None:
        tz = getattr(config, "timezone", None) or tz
        model = getattr(config, "model", None) or model

    # 手动触发时使用默认配置（confirm 模式），不走 folders 过滤
    from datetime import datetime

    from mona.email_intel.config import EmailScheduleConfig
    from mona.email_intel.db import get_message
    from mona.email_intel.schedule_extract import process_email_for_schedule

    msg = get_message(uid, account_id, folder)
    if not msg:
        return web.json_response({"error": "邮件不存在"}, status=404)

    # 手动触发：临时配置，confirm 模式，不跳过发件人
    manual_config = EmailScheduleConfig(enabled=True, folders=[], create_mode="confirm")

    result = await process_email_for_schedule(
        provider,
        svc,
        manual_config,
        account_id=account_id,
        uid=uid,
        folder=folder,
        subject=msg.get("subject") or "",
        from_address=msg.get("fromAddress") or "",
        from_name=msg.get("fromName"),
        date=msg.get("date") or "",
        body_text=msg.get("bodyText") or "",
        body_html=msg.get("bodyHtml"),
        now_iso=datetime.now().isoformat(),
        tz=tz,
        model=model,
    )

    return web.json_response({"result": result})


def _imap_fetch_attachment(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP，FETCH 完整邮件，按 filename 提取附件并返回 base64 编码。复用持久连接池。"""

    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    filename = str(body.get("filename", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not uid:
        raise ValueError("uid is required")
    if not filename:
        raise ValueError("filename is required")

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")

        # FETCH 完整邮件（含附件）
        status, fetched = client.uid("FETCH", uid, "(BODY.PEEK[] UID)")
        if status != "OK" or not fetched:
            raise RuntimeError("FETCH failed")

        raw_bytes = _email_extract_message_bytes(fetched)
        if raw_bytes is None:
            raise RuntimeError("无法获取邮件内容")

        parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))

        # 按 filename 查找附件 part
        for part in parsed.walk():
            if part.get_content_disposition() != "attachment":
                continue
            part_filename = part.get_filename() or ""
            try:
                part_filename = str(make_header(decode_header(part_filename)))
            except Exception:
                pass
            if part_filename == filename:
                payload = part.get_payload(decode=True)
                if payload is None:
                    raise RuntimeError(f"附件 {filename} 内容为空")
                return {
                    "filename": filename,
                    "contentType": part.get_content_type() or "application/octet-stream",
                    "size": len(payload),
                    "data": base64.b64encode(payload).decode("ascii"),
                }

        raise RuntimeError(f"未找到附件: {filename}")

    return imap_pool_manager.run(body, op)


async def handle_email_fetch_attachment(request: web.Request) -> web.Response:
    """POST /email/fetch_attachment - 下载指定附件，返回 base64 编码内容。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_fetch_attachment)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Email fetch attachment failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_fetch_body(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 拉取单封邮件的完整正文（同步时只拉头部，此处按需拉取正文）。

    请求体：{ imapHost, imapPort, imapUsername, imapPassword, mailbox, uid, useSsl, includeRawBytes? }
    返回：{ bodyText, bodyHtml, hasAttachments, attachments, rawBytes? }
    - includeRawBytes=false（用户主动点击）：只返回解析后的正文，不返回 rawBytes，JSON 体积小
    - includeRawBytes=true（默认，prefetch）：额外返回 rawBytes（base64 RFC822），供 Rust 侧落盘 .eml
    复用持久连接池。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    uid = str(body.get("uid", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")

    _validate_mail_host(imap_host)
    # includeRawBytes 默认 true（保持向后兼容）；用户主动点击时传 false 跳过 rawBytes 传输
    include_raw = bool(body.get("includeRawBytes", True))

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"select {mailbox} failed: {status}")

        status, fetched = client.uid("FETCH", uid, "(BODY.PEEK[] UID)")
        if status != "OK" or not fetched:
            raise RuntimeError(f"FETCH uid {uid} failed: {status}")

        raw_bytes = _email_extract_message_bytes(fetched)
        if raw_bytes is None:
            # 区分"UID 在当前文件夹不存在"与其他提取失败。
            # 存量分裂邮件（本地 folder 已是目标文件夹但 uid 仍是源文件夹的旧 uid）会落到这里：
            # SELECT 成功，FETCH 返回 OK 但内容为空。
            # Rust 端识别此错误后会触发 sync_folder_internal 用 message_id 去重替换 uid 后重试。
            raise RuntimeError(f"UID not found in mailbox: {mailbox} uid={uid}")

        parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))
        body_text, body_html = _email_extract_bodies(parsed)
        # body_text 截断到 50000 字符，与同步逻辑保持一致
        if body_text:
            body_text = body_text[:50000]

        result: dict[str, Any] = {
            "bodyText": body_text,
            "bodyHtml": body_html,
            "hasAttachments": _email_has_attachments(parsed),
            "attachments": _email_extract_attachments(parsed),
        }
        if include_raw:
            # Foxmail 风格：返回完整 RFC822 字节（base64），供 Rust 侧落盘为 .eml 文件
            result["rawBytes"] = base64.b64encode(raw_bytes).decode("ascii")
        return result

    return imap_pool_manager.run(body, op)


async def handle_email_fetch_body(request: web.Request) -> web.Response:
    """POST /email/fetch_body - 按需拉取单封邮件的完整正文。

    请求体：{ accountId, imapHost, imapPort, imapUsername, imapPassword, mailbox, uid, useSsl }
    返回：{ bodyText, bodyHtml, attachments, hasAttachments, rawBytes }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        # fetch_body 是用户主动点击邮件时的按需操作，减少重试次数（1 次，退避 1s）
        # 避免用户长时间等待；失败时快速返回错误，前端可手动重试
        result = await _run_imap_locked(body, _imap_fetch_body, max_retries=1)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Failed to fetch email body")
        return web.json_response({"error": str(e)}, status=500)


async def handle_email_parse_attachment(request: web.Request) -> web.Response:
    """POST /email/parse_attachment - 从 RFC822 字节提取指定附件（不走 IMAP）。

    Foxmail 风格：Rust 侧已将 .eml 文件落盘，下载附件时优先读本地 .eml 并调用此路由提取，
    避免每次下载都走 IMAP。

    请求体：{ rawBytes: string (base64), filename: string }
    返回：{ filename, contentType, size, data (base64) }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        raw_b64 = str(body.get("rawBytes", "") or "")
        filename = str(body.get("filename", "") or "")
        if not raw_b64:
            return web.json_response({"error": "rawBytes is required"}, status=400)
        if not filename:
            return web.json_response({"error": "filename is required"}, status=400)

        raw_bytes = base64.b64decode(raw_b64)
        parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))

        for part in parsed.walk():
            if part.is_multipart():
                continue
            content_disposition = str(part.get("Content-Disposition", "") or "")
            if "attachment" not in content_disposition.lower():
                continue
            part_filename = part.get_filename() or ""
            try:
                part_filename = str(make_header(decode_header(part_filename)))
            except Exception:
                pass
            if part_filename == filename:
                payload = part.get_payload(decode=True)
                if payload is None:
                    return web.json_response(
                        {"error": f"附件 {filename} 内容为空"}, status=500
                    )
                return web.json_response({
                    "filename": filename,
                    "contentType": part.get_content_type() or "application/octet-stream",
                    "size": len(payload),
                    "data": base64.b64encode(payload).decode("ascii"),
                })

        return web.json_response({"error": f"未找到附件: {filename}"}, status=404)
    except Exception as e:
        logger.exception("Failed to parse attachment from raw bytes")
        return web.json_response({"error": str(e)}, status=500)


def _imap_fetch_raw(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 拉取邮件原始 RFC822 字节（用于 .eml 导出）。

    请求体：{ imapHost, imapPort, imapUsername, imapPassword, mailbox, uid, useSsl }
    返回：{ rawBase64, size }
    复用持久连接池。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    uid = str(body.get("uid", "") or "").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"select {mailbox} failed: {status}")

        status, fetched = client.uid("FETCH", uid, "(BODY.PEEK[] UID)")
        if status != "OK" or not fetched:
            raise RuntimeError(f"FETCH uid {uid} failed: {status}")

        raw_bytes = _email_extract_message_bytes(fetched)
        if raw_bytes is None:
            # 区分"UID 在当前文件夹不存在"与其他提取失败。
            # 存量分裂邮件（本地 folder 已是目标文件夹但 uid 仍是源文件夹的旧 uid）会落到这里：
            # SELECT 成功，FETCH 返回 OK 但内容为空。
            # Rust 端识别此错误后会触发 sync_folder_internal 用 message_id 去重替换 uid 后重试。
            raise RuntimeError(f"UID not found in mailbox: {mailbox} uid={uid}")

        return {
            "rawBase64": base64.b64encode(raw_bytes).decode("ascii"),
            "size": len(raw_bytes),
        }

    return imap_pool_manager.run(body, op)


async def handle_email_fetch_raw(request: web.Request) -> web.Response:
    """POST /email/fetch_raw - 拉取邮件原始 RFC822 字节（用于 .eml 导出）。

    请求体：{ accountId, imapHost, imapPort, imapUsername, imapPassword, mailbox, uid, useSsl }
    返回：{ rawBase64, size }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_fetch_raw)
        return web.json_response(result)
    except Exception as e:
        logger.exception("Failed to fetch raw email")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Schedule routes
# ---------------------------------------------------------------------------


def _require_schedule_service(request: web.Request) -> Any:
    svc = request.app.get("schedule_service")
    if svc is None:
        raise web.HTTPBadRequest(reason="Schedule service not available")
    return svc


def _item_to_json(item: Any) -> dict[str, Any]:
    d = item.to_dict()
    # Convert snake_case keys to camelCase for the frontend
    camel_map = {
        "start_at_ms": "startAtMs",
        "end_at_ms": "endAtMs",
        "all_day": "allDay",
        "cron_expr": "cronExpr",
        "ai_message": "aiMessage",
        "ai_deliver": "aiDeliver",
        "source_module": "sourceModule",
        "source_chat_id": "sourceChatId",
        "last_run_at_ms": "lastRunAtMs",
        "next_run_at_ms": "nextRunAtMs",
        "last_status": "lastStatus",
        "last_error": "lastError",
        "created_at_ms": "createdAtMs",
        "updated_at_ms": "updatedAtMs",
    }
    return {camel_map.get(k, k): v for k, v in d.items()}


async def handle_schedule_list(request: web.Request) -> web.Response:
    """GET /api/schedule/items - list schedule items, optional ?from=&to= (ms)."""
    svc = _require_schedule_service(request)
    from_ms = request.query.get("from")
    to_ms = request.query.get("to")
    from_ms_i = int(from_ms) if from_ms else None
    to_ms_i = int(to_ms) if to_ms else None
    items = await svc.list_items(from_ms=from_ms_i, to_ms=to_ms_i)
    return web.json_response({"items": [_item_to_json(it) for it in items]})


async def handle_schedule_get(request: web.Request) -> web.Response:
    """GET /api/schedule/items/{id} - get a single schedule item."""
    svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    item = await svc.get_item(item_id)
    if not item:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(_item_to_json(item))


async def handle_schedule_create(request: web.Request) -> web.Response:
    """POST /api/schedule/items - create a new schedule item."""
    svc = _require_schedule_service(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.schedule import ScheduleItem, create_schedule_item_id

        item_id = body.get("id") or create_schedule_item_id()
        item = ScheduleItem.from_dict({**body, "id": item_id})
        saved = await svc.add_item(item)
        return web.json_response(_item_to_json(saved))
    except Exception as e:
        logger.exception("Schedule create failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_schedule_update(request: web.Request) -> web.Response:
    """POST /api/schedule/items/{id}/update - update an existing item."""
    svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    existing = await svc.get_item(item_id)
    if not existing:
        return web.json_response({"error": "not found"}, status=404)
    try:
        from mona.schedule import ScheduleItem

        item = ScheduleItem.from_dict({**body, "id": item_id})
        saved = await svc.update_item(item)
        return web.json_response(_item_to_json(saved))
    except Exception as e:
        logger.exception("Schedule update failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_schedule_remove(request: web.Request) -> web.Response:
    """POST /api/schedule/items/{id}/remove - delete an item."""
    svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    ok = await svc.remove_item(item_id)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def handle_schedule_toggle(request: web.Request) -> web.Response:
    """POST /api/schedule/items/{id}/toggle - pause/resume (AI task) or enable/disable."""
    svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    try:
        body = await request.json()
        enabled = bool(body.get("enabled", True))
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    ok = await svc.toggle_item(item_id, enabled)
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def handle_schedule_notifications(request: web.Request) -> web.Response:
    """GET /api/schedule/notifications - pop pending system notifications.

    Returns ``{notifications: [{title, body, item_id}, ...]}`` and clears the
    queue. Polled by the Tauri Rust side to fire native Windows toast
    notifications independent of the webview state.
    """
    svc = _require_schedule_service(request)
    pending = svc.pop_pending_notifications()
    return web.json_response({"notifications": pending})


# ---------------------------------------------------------------------------
# Todo routes (/api/schedule/todos/*, /api/schedule/briefing)
# ---------------------------------------------------------------------------


def _require_todo_service(request: web.Request) -> Any:
    svc = request.app.get("todo_service")
    if svc is None:
        raise web.HTTPBadRequest(reason="Todo service not available")
    return svc


async def handle_todo_list(request: web.Request) -> web.Response:
    """GET /api/schedule/todos - list todos with optional filters."""
    svc = _require_todo_service(request)
    state = request.query.get("state")
    bucket = request.query.get("bucket")
    source_type = request.query.get("sourceType")
    items = await svc.list_items(state=state, bucket=bucket, source_type=source_type)
    return web.json_response({"items": [it.to_dict() for it in items]})


async def handle_todo_get(request: web.Request) -> web.Response:
    """GET /api/schedule/todos/{id} - read a single todo."""
    svc = _require_todo_service(request)
    item = await svc.get_item(request.match_info["id"])
    if item is None:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(item.to_dict())


async def handle_todo_create(request: web.Request) -> web.Response:
    """POST /api/schedule/todos - create a todo or suggestion."""
    svc = _require_todo_service(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.schedule import TodoItem, create_todo_id

        item_id = body.get("id") or create_todo_id()
        item = TodoItem.from_dict({**body, "id": item_id})
        saved = await svc.add_item(item)
        return web.json_response(saved.to_dict())
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        logger.exception("Todo create failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_todo_update(request: web.Request) -> web.Response:
    """POST /api/schedule/todos/{id}/update - edit, confirm, move, complete.

    The body is a partial patch. State transitions are enforced by the service:
    - state=done → completed_at_ms set, focus_rank cleared
    - focus_rank set → displaces existing holder within today bucket
    """
    svc = _require_todo_service(request)
    item_id = request.match_info["id"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        saved = await svc.update_item(item_id, body)
        return web.json_response(saved.to_dict())
    except KeyError:
        return web.json_response({"error": "not found"}, status=404)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        logger.exception("Todo update failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_todo_remove(request: web.Request) -> web.Response:
    """POST /api/schedule/todos/{id}/remove - delete or discard."""
    svc = _require_todo_service(request)
    ok = await svc.remove_item(request.match_info["id"])
    if not ok:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"ok": True})


async def handle_todo_to_schedule(request: web.Request) -> web.Response:
    """POST /api/schedule/todos/{id}/to-schedule - arrange on calendar.

    Creates a ScheduleItem from the todo and writes schedule_id back.
    """
    todo_svc = _require_todo_service(request)
    sched_svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    try:
        body = await request.json()
    except Exception:
        body = {}
    todo = await todo_svc.get_item(item_id)
    if todo is None:
        return web.json_response({"error": "not found"}, status=404)
    try:
        from mona.schedule import ScheduleItem, create_schedule_item_id

        start_at = int(body.get("startAtMs", 0))
        if start_at == 0:
            return web.json_response({"error": "startAtMs required"}, status=400)
        sched_item = ScheduleItem(
            id=create_schedule_item_id(),
            title=todo.title,
            start_at_ms=start_at,
            description=todo.notes,
            end_at_ms=int(body["endAtMs"]) if body.get("endAtMs") else None,
            all_day=bool(body.get("allDay", False)),
            kind="personal",
            source_module="todo",
            source_chat_id=todo.id,
            created_at_ms=0,
            updated_at_ms=0,
        )
        saved_sched = await sched_svc.add_item(sched_item)
        await todo_svc.update_item(item_id, {"scheduleId": saved_sched.id})
        return web.json_response({"scheduleId": saved_sched.id, "todoId": item_id})
    except Exception as e:
        logger.exception("Todo to-schedule failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_todo_from_email(request: web.Request) -> web.Response:
    """POST /api/schedule/todos/from-email - create a todo from an email.

    Body: {accountId, folder, uid, title?}
    Reads the email via email_intel.db and stores a minimal snapshot.
    """
    todo_svc = _require_todo_service(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    account_id = body.get("accountId")
    folder = body.get("folder")
    uid = body.get("uid")
    if not account_id or not folder or not uid:
        return web.json_response(
            {"error": "accountId, folder, uid required"}, status=400
        )
    try:
        from mona.email_intel.db import get_message
        from mona.schedule import TodoItem, create_todo_id

        msg = get_message(uid=str(uid), account_id=str(account_id), folder=str(folder))
        if msg is None:
            return web.json_response({"error": "email not found"}, status=404)
        subject = msg.get("subject") or "(无主题)"
        from_name = msg.get("from_name") or msg.get("from_address") or ""
        body_text = msg.get("bodyText") or ""
        # Snapshot evidence: subject + first 240 chars of body
        evidence = body_text[:240].strip()
        title = body.get("title") or subject
        item = TodoItem(
            id=create_todo_id(),
            title=title,
            created_at_ms=0,
            updated_at_ms=0,
            state="open",
            bucket="inbox",
            source_type="email",
            source_locator={
                "accountId": str(account_id),
                "folder": str(folder),
                "uid": str(uid),
                "messageId": msg.get("message_id") or "",
            },
            source_snapshot={
                "title": subject,
                "evidence": evidence,
                "from": from_name,
            },
        )
        saved = await todo_svc.add_item(item)
        return web.json_response(saved.to_dict())
    except Exception as e:
        logger.exception("Todo from-email failed")
        return web.json_response({"error": str(e)}, status=400)


async def handle_todo_briefing(request: web.Request) -> web.Response:
    """GET /api/schedule/briefing - today's top3, overdue and suggestion counts."""
    svc = _require_todo_service(request)
    return web.json_response(await svc.get_briefing())


# ---------------------------------------------------------------------------
# PPT project V2 routes (/api/ppt/project/outline, /lock-outline, /pages, ...)
# ---------------------------------------------------------------------------


def _ppt_projects_dir() -> Path:
    return get_workspace_path() / "ppt_projects"


def _ppt_project_dir_or_404(name: str) -> tuple[Path | None, web.Response | None]:
    """Validate PPT project name and return (project_dir, None) or (None, error)."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None, web.json_response({"error": "invalid project name"}, status=400)
    project_dir = _ppt_projects_dir() / name
    if not project_dir.is_dir():
        return None, web.json_response({"error": "project not found"}, status=404)
    return project_dir, None


def _load_ppt_meta(project_dir: Path) -> dict:
    """Load meta.json, return empty dict if missing."""
    meta_file = project_dir / "meta.json"
    if not meta_file.is_file():
        return {}
    try:
        return _json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_ppt_meta_atomic(project_dir: Path, meta: dict) -> None:
    """Atomically write meta.json via temp file + os.replace."""
    import os

    meta_file = project_dir / "meta.json"
    tmp_file = project_dir / ".meta.json.tmp"
    tmp_file.write_text(
        _json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(tmp_file, meta_file)


def _load_ppt_outline(project_dir: Path) -> dict | None:
    """Load page_visual_plan.json, return None if missing."""
    outline_file = project_dir / "page_visual_plan.json"
    if not outline_file.is_file():
        return None
    try:
        return _json.loads(outline_file.read_text(encoding="utf-8"))
    except Exception:
        return None


def _save_ppt_outline_atomic(project_dir: Path, outline: dict) -> None:
    """Atomically write page_visual_plan.json."""
    import os

    outline_file = project_dir / "page_visual_plan.json"
    tmp_file = project_dir / ".page_visual_plan.json.tmp"
    tmp_file.write_text(
        _json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(tmp_file, outline_file)


def _validate_outline_pages(pages: list[dict]) -> str | None:
    """Validate outline pages, return error message or None if valid."""
    if not pages:
        return "大纲不能为空"
    for i, page in enumerate(pages):
        if not page.get("title"):
            return f"第 {i + 1} 页缺少标题"
        if not isinstance(page.get("bullets"), list):
            return f"第 {i + 1} 页 bullets 必须是数组"
        file_name = page.get("file", "")
        if file_name and ("/" in file_name or "\\" in file_name or ".." in file_name):
            return f"第 {i + 1} 页 file 包含非法路径字符"
    return None


def _renumber_outline_pages(pages: list[dict]) -> list[dict]:
    """Renumber page fields to P01..PNN and sync file names."""
    result = []
    for i, page in enumerate(pages):
        page_num = f"P{i + 1:02d}"
        new_page = {**page, "page": page_num}
        if page.get("file"):
            ext = ".svg" if not page["file"].endswith(".svg") else ""
            new_page["file"] = f"{i + 1:02d}_{page['file'].split('_', 1)[-1]}" if "_" in page["file"] else f"{i + 1:02d}{ext}"
        else:
            new_page["file"] = f"{i + 1:02d}.svg"
        result.append(new_page)
    return result


def _load_review_ready(project_dir: Path) -> dict | None:
    """Load .review_ready JSON, return None if missing or invalid."""
    rr_file = project_dir / ".review_ready"
    if not rr_file.is_file():
        return None
    try:
        return _json.loads(rr_file.read_text(encoding="utf-8"))
    except Exception:
        return None


def _svg_mtime(project_dir: Path, file_name: str) -> float | None:
    """Return mtime of svg_output/<file_name>, or None if missing."""
    svg_path = project_dir / "svg_output" / file_name
    if not svg_path.is_file():
        return None
    return svg_path.stat().st_mtime


def _is_review_ready(project_dir: Path, meta: dict, outline: dict | None) -> bool:
    """V2 §5.1: reviewReady is true only when all three conditions hold:
    - .review_ready exists
    - outlineRevision equals meta.outlineRevision
    - every file in outline.pages exists in svg_output/
    """
    rr = _load_review_ready(project_dir)
    if rr is None:
        return False
    if meta.get("outlineRevision") != rr.get("outlineRevision"):
        return False
    if outline is None:
        return False
    for page in outline.get("pages", []):
        file_name = page.get("file", "")
        if not file_name:
            return False
        if _svg_mtime(project_dir, file_name) is None:
            return False
    return True


def _page_state(file_name: str, project_dir: Path, meta: dict) -> str:
    """V2 §5.2: pending / previewing / confirmed."""
    mtime = _svg_mtime(project_dir, file_name)
    if mtime is None:
        return "pending"
    confirmed = meta.get("confirmedPages", {}).get(file_name)
    if confirmed and abs(float(confirmed.get("mtime", 0)) - mtime) < 0.001:
        return "confirmed"
    return "previewing"


def _all_pages_confirmed(project_dir: Path, meta: dict, outline: dict) -> bool:
    """V2 §5.5: every planned page's current mtime is confirmed."""
    confirmed_pages = meta.get("confirmedPages", {})
    for page in outline.get("pages", []):
        file_name = page.get("file", "")
        if not file_name:
            return False
        mtime = _svg_mtime(project_dir, file_name)
        if mtime is None:
            return False
        confirmed = confirmed_pages.get(file_name)
        if not confirmed or abs(float(confirmed.get("mtime", 0)) - mtime) >= 0.001:
            return False
    return True


def _no_extra_svgs(project_dir: Path, outline: dict) -> bool:
    """V2 §5.5: no SVGs in svg_output/ that are not in the outline."""
    planned = {p.get("file", "") for p in outline.get("pages", []) if p.get("file")}
    svg_dir = project_dir / "svg_output"
    if not svg_dir.is_dir():
        return True
    for entry in svg_dir.iterdir():
        if entry.is_file() and entry.suffix == ".svg" and entry.name not in planned:
            return False
    return True


async def handle_ppt_outline_get(request: web.Request) -> web.Response:
    """GET /api/ppt/project/outline?name=<n> - read outline JSON."""
    try:
        name = request.query.get("name") or ""
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        outline = _load_ppt_outline(project_dir)
        meta = _load_ppt_meta(project_dir)
        spec_lock = (project_dir / "spec_lock.md").exists()
        if outline is None:
            return web.json_response({"ok": False, "pages": [], "locked": False})
        return web.json_response({
            "ok": True,
            "pages": outline.get("pages", []),
            "revision": outline.get("revision", 0),
            "schemaVersion": outline.get("schemaVersion", 1),
            "locked": meta.get("outlineLocked", False) or spec_lock,
        })
    except Exception as e:
        logger.exception("ppt outline get error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_outline_put(request: web.Request) -> web.Response:
    """PUT /api/ppt/project/outline  body: {"name", "expectedRevision", "pages"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        # Block edits when locked
        meta = _load_ppt_meta(project_dir)
        spec_lock = (project_dir / "spec_lock.md").exists()
        if meta.get("outlineLocked", False) or spec_lock:
            return web.json_response(
                {"error": "大纲已锁定，无法编辑"}, status=409
            )

        expected_revision = int(body.get("expectedRevision", 0) or 0)
        pages = body.get("pages", [])
        if not isinstance(pages, list):
            return web.json_response({"error": "pages 必须是数组"}, status=400)

        validation_error = _validate_outline_pages(pages)
        if validation_error:
            return web.json_response({"error": validation_error}, status=400)

        # Check revision
        existing = _load_ppt_outline(project_dir)
        current_revision = existing.get("revision", 0) if existing else 0
        if expected_revision != current_revision:
            return web.json_response(
                {
                    "error": "revision mismatch",
                    "currentRevision": current_revision,
                    "expectedRevision": expected_revision,
                },
                status=409,
            )

        # Renumber and save
        pages = _renumber_outline_pages(pages)
        new_revision = current_revision + 1
        outline = {
            "schemaVersion": 2,
            "revision": new_revision,
            "pages": pages,
        }
        _save_ppt_outline_atomic(project_dir, outline)

        return web.json_response({
            "ok": True,
            "revision": new_revision,
            "pages": pages,
        })
    except Exception as e:
        logger.exception("ppt outline put error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_lock_outline(request: web.Request) -> web.Response:
    """POST /api/ppt/project/lock-outline  body: {"name"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        outline = _load_ppt_outline(project_dir)
        if outline is None:
            return web.json_response({"error": "大纲不存在"}, status=400)

        pages = outline.get("pages", [])
        validation_error = _validate_outline_pages(pages)
        if validation_error:
            return web.json_response({"error": validation_error}, status=400)

        # Lock: only update meta.json, do NOT write spec_lock.md
        meta = _load_ppt_meta(project_dir)
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        meta["outlineLocked"] = True
        meta["outlineRevision"] = outline.get("revision", 0)
        meta["outlineLockedAt"] = now
        meta["updatedAt"] = now
        if "createdAt" not in meta:
            meta["createdAt"] = now
        if "projectName" not in meta:
            meta["projectName"] = name
        meta.setdefault("confirmedPages", {})
        meta.setdefault("schemaVersion", 2)
        _save_ppt_meta_atomic(project_dir, meta)

        return web.json_response({
            "ok": True,
            "revision": outline.get("revision", 0),
        })
    except Exception as e:
        logger.exception("ppt lock outline error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_pages_get(request: web.Request) -> web.Response:
    """GET /api/ppt/project/pages?name=<n> - return page files, mtime, state, reviewReady."""
    try:
        name = request.query.get("name") or ""
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        meta = _load_ppt_meta(project_dir)
        outline = _load_ppt_outline(project_dir)
        if outline is None:
            return web.json_response({
                "ok": False,
                "pages": [],
                "reviewReady": False,
                "outlineRevision": meta.get("outlineRevision", 0),
            })
        pages_out = []
        for page in outline.get("pages", []):
            file_name = page.get("file", "")
            mtime = _svg_mtime(project_dir, file_name) if file_name else None
            pages_out.append({
                "page": page.get("page", ""),
                "file": file_name,
                "title": page.get("title", ""),
                "mtime": mtime,
                "state": _page_state(file_name, project_dir, meta) if file_name else "pending",
            })
        return web.json_response({
            "ok": True,
            "pages": pages_out,
            "reviewReady": _is_review_ready(project_dir, meta, outline),
            "outlineRevision": meta.get("outlineRevision", 0),
            "confirmedCount": sum(
                1 for p in pages_out if p["state"] == "confirmed"
            ),
            "totalCount": len(pages_out),
        })
    except Exception as e:
        logger.exception("ppt pages get error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_page_confirm(request: web.Request) -> web.Response:
    """POST /api/ppt/project/page/confirm  body: {"name", "file", "expectedMtime"}.

    V2 §5.3: confirm a specific mtime of an SVG. 409 if disk mtime changed.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        file_name = str(body.get("file", "") or "").strip()
        if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
            return web.json_response({"error": "invalid file"}, status=400)
        expected_mtime = float(body.get("expectedMtime", 0) or 0)

        current_mtime = _svg_mtime(project_dir, file_name)
        if current_mtime is None:
            return web.json_response({"error": "SVG 文件不存在"}, status=404)
        if abs(current_mtime - expected_mtime) >= 0.001:
            return web.json_response(
                {
                    "error": "mtime mismatch",
                    "currentMtime": current_mtime,
                    "expectedMtime": expected_mtime,
                },
                status=409,
            )

        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        meta = _load_ppt_meta(project_dir)
        confirmed_pages = meta.setdefault("confirmedPages", {})
        confirmed_pages[file_name] = {"mtime": current_mtime, "confirmedAt": now}
        meta["updatedAt"] = now
        if "createdAt" not in meta:
            meta["createdAt"] = now
        if "projectName" not in meta:
            meta["projectName"] = name
        meta.setdefault("schemaVersion", 2)
        _save_ppt_meta_atomic(project_dir, meta)

        return web.json_response({
            "ok": True,
            "file": file_name,
            "mtime": current_mtime,
            "confirmedAt": now,
        })
    except Exception as e:
        logger.exception("ppt page confirm error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_page_regenerate(request: web.Request) -> web.Response:
    """POST /api/ppt/project/page/regenerate  body: {"name", "file"}.

    V2 §5.4: clear confirmation for the file and delete .review_ready.
    Does NOT send Agent message — frontend handles that.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        file_name = str(body.get("file", "") or "").strip()
        if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
            return web.json_response({"error": "invalid file"}, status=400)

        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        meta = _load_ppt_meta(project_dir)
        confirmed_pages = meta.setdefault("confirmedPages", {})
        if file_name in confirmed_pages:
            del confirmed_pages[file_name]
        meta["updatedAt"] = now
        _save_ppt_meta_atomic(project_dir, meta)

        # Invalidate review gate
        rr_file = project_dir / ".review_ready"
        if rr_file.is_file():
            try:
                rr_file.unlink()
            except Exception:
                pass

        return web.json_response({"ok": True, "file": file_name})
    except Exception as e:
        logger.exception("ppt page regenerate error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_ppt_request_export(request: web.Request) -> web.Response:
    """POST /api/ppt/project/request-export  body: {"name"}.

    V2 §5.5: record export request after all pages confirmed.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _ppt_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        meta = _load_ppt_meta(project_dir)
        outline = _load_ppt_outline(project_dir)
        if outline is None:
            return web.json_response({"error": "大纲不存在"}, status=400)

        if not _is_review_ready(project_dir, meta, outline):
            return web.json_response(
                {"error": "review gate 未通过"}, status=409
            )
        if not _all_pages_confirmed(project_dir, meta, outline):
            return web.json_response(
                {"error": "存在未确认的页面"}, status=409
            )
        if not _no_extra_svgs(project_dir, outline):
            return web.json_response(
                {"error": "存在计划外的 SVG 文件"}, status=409
            )

        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        meta["exportRequestedAt"] = now
        meta["updatedAt"] = now
        _save_ppt_meta_atomic(project_dir, meta)

        return web.json_response({"ok": True, "exportRequestedAt": now})
    except Exception as e:
        logger.exception("ppt request export error")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Video project routes (/api/video/*)
# ---------------------------------------------------------------------------


def _video_projects_dir() -> Path:
    return get_workspace_path() / "video_projects"


def _get_video_project_status(project_dir: Path) -> dict:
    """Inspect a video project directory and return its status."""
    generating_marker = project_dir / ".generating"
    output_mp4 = project_dir / "renders" / "output.mp4"
    storyboard = project_dir / "storyboard.md"
    index_html = project_dir / "index.html"
    scenes_dir = project_dir / "scenes"
    scene_count = (
        len(list(scenes_dir.glob("scene_*.html"))) if scenes_dir.is_dir() else 0
    )
    has_render = output_mp4.is_file()
    if has_render:
        status = "done"
    elif generating_marker.exists():
        status = "generating"
    elif index_html.exists() or scene_count > 0:
        status = "generating"
    elif storyboard.exists():
        status = "planning"
    else:
        status = "init"
    return {
        "status": status,
        "hasRender": has_render,
        "sceneCount": scene_count,
        "hasStoryboard": storyboard.exists(),
        "hasIndex": index_html.exists(),
    }


async def handle_video_runtime_check(request: web.Request) -> web.Response:
    """GET /api/video/runtime-check - detect Node/FFmpeg/Chrome availability."""
    try:
        from mona.api.video_runtime import VideoRuntime

        result = VideoRuntime().check_all()
        return web.json_response(result)
    except Exception as e:
        logger.exception("video runtime-check error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_url2note_extract(request: web.Request) -> web.Response:
    """POST /api/url2note/extract - extract one public URL for a Markdown note."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    url = str(body.get("url") or "").strip() if isinstance(body, dict) else ""
    if not url:
        return web.json_response({"error": "url is required"}, status=400)
    try:
        source = await Url2NoteExtractor().extract(url)
        return web.json_response(
            {"title": source.title, "url": source.url, "kind": source.kind, "text": source.text}
        )
    except Url2NoteError as exc:
        return web.json_response({"error": str(exc)}, status=422)
    except Exception:
        logger.exception("url2note extraction error")
        return web.json_response({"error": "URL extraction failed"}, status=500)


async def handle_video_runtime_download(request: web.Request) -> web.Response:
    """POST /api/video/runtime-download  body: {"component": "node|ffmpeg|chrome"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.api.video_runtime import VideoRuntime

        component = str(body.get("component", "") or "").strip()
        if component not in {"node", "ffmpeg", "chrome"}:
            return web.json_response(
                {"error": "component must be node, ffmpeg or chrome"}, status=400
            )
        result = await VideoRuntime().ensure_runtime(component)
        return web.json_response(result)
    except Exception as e:
        logger.exception("video runtime-download error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_office_health(request: web.Request) -> web.Response:
    """GET /api/office/health - detect OfficeCLI availability and version.

    Pure health check used by the "文档加工" workbench to decide whether
    AI-driven document modification (阶段 B) is available. Does not start
    a download — call /api/office/runtime-download to provision the binary.
    """
    try:
        from mona.api.officecli_runtime import OfficeCliRuntime

        result = OfficeCliRuntime().check()
        return web.json_response(result)
    except Exception as e:
        logger.exception("office health error")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_office_runtime_download(request: web.Request) -> web.Response:
    """POST /api/office/runtime-download - download the OfficeCLI binary."""
    try:
        from mona.api.officecli_runtime import OfficeCliRuntime

        result = await OfficeCliRuntime().ensure()
        return web.json_response(result)
    except Exception as e:
        logger.exception("office runtime-download error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_notes_export_docx(request: web.Request) -> web.Response:
    """POST /api/notes/export-docx — convert a markdown note to a .docx file.

    Body: ``{"markdown": str, "vaultPath"?: str, "mermaidImages"?: {src: dataUrl}}``
    Response: binary ``application/vnd.openxmlformats-officedocument.wordprocessingml.document``.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    if not isinstance(body, dict):
        return web.json_response({"error": "Invalid body"}, status=400)

    markdown = body.get("markdown")
    if not isinstance(markdown, str) or not markdown.strip():
        return web.json_response({"error": "markdown is required"}, status=400)

    vault_path = body.get("vaultPath")
    if not isinstance(vault_path, str):
        vault_path = None

    mermaid_raw = body.get("mermaidImages")
    mermaid_images = mermaid_raw if isinstance(mermaid_raw, dict) else None

    title = str(body.get("title") or "").strip()
    if not title:
        title = "未命名笔记"

    try:
        from mona.notes.export_docx import markdown_to_docx_bytes

        # The converter is CPU-bound (parsing + docx assembly); run it in a
        # thread so the event loop stays responsive for other requests.
        data = await asyncio.to_thread(
            markdown_to_docx_bytes,
            markdown,
            vault_path,
            mermaid_images,
        )
    except Exception as exc:
        logger.exception("notes export-docx error")
        return web.json_response({"error": str(exc)}, status=500)

    # Build a safe ASCII filename with a URL-encoded fallback for non-ASCII
    # characters (RFC 5987 / RFC 6266).
    safe_title = safe_filename(title) or "note"
    ascii_name = safe_title.encode("ascii", "ignore").decode("ascii") or "note"
    utf8_name = quote(f"{safe_title}.docx", safe="")

    return web.Response(
        body=data,
        status=200,
        headers={
            "Content-Type": (
                "application/vnd.openxmlformats-officedocument"
                ".wordprocessingml.document"
            ),
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}.docx"; '
                f"filename*=UTF-8''{utf8_name}"
            ),
            "Content-Length": str(len(data)),
            "Cache-Control": "no-store",
        },
    )


async def handle_video_projects(request: web.Request) -> web.Response:
    """GET /api/video/projects - list all video projects."""
    try:
        projects_dir = _video_projects_dir()
        if not projects_dir.exists():
            return web.json_response({"projects": []})
        projects = []
        for d in sorted(projects_dir.iterdir()):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            status_info = _get_video_project_status(d)
            stat = d.stat()
            chat_id_file = d / ".chat_id"
            chat_id = (
                chat_id_file.read_text(encoding="utf-8").strip()
                if chat_id_file.exists()
                else None
            )
            projects.append({
                "name": d.name,
                "createdAt": stat.st_ctime,
                "chatId": chat_id,
                **status_info,
            })
        return web.json_response({"projects": projects})
    except Exception as e:
        logger.exception("video projects error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_create(request: web.Request) -> web.Response:
    """POST /api/video/project/create  body: {"name", "resolution", "fps", "quality",
    optional "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate"}.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        resolution = str(body.get("resolution", "landscape") or "landscape")
        fps = int(body.get("fps", 30) or 30)
        quality = str(body.get("quality", "standard") or "standard")

        # Optional narration/TTS config — defaults to edge TTS when narrationEnabled=true.
        narration_enabled = bool(body.get("narrationEnabled", False))
        tts_provider = str(body.get("ttsProvider", "") or "").strip()
        tts_voice = str(body.get("ttsVoice", "") or "").strip()
        tts_rate = str(body.get("ttsRate", "") or "").strip()
        tts_api_base = str(body.get("ttsApiBase", "") or "").strip()
        tts_api_key = str(body.get("ttsApiKey", "") or "").strip()
        tts_model = str(body.get("ttsModel", "") or "").strip()

        project_dir = _video_projects_dir() / name
        if project_dir.exists():
            return web.json_response(
                {"error": "project already exists"}, status=409
            )
        # Pre-build the standard directory layout.
        for sub in ("scenes", "compositions", "assets", "renders", "audio", "output/preview"):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        (project_dir / ".generating").write_text("1", encoding="utf-8")
        meta: dict[str, object] = {
            "name": name,
            "resolution": resolution,
            "fps": fps,
            "quality": quality,
        }
        if narration_enabled:
            meta["narrationEnabled"] = True
            meta["ttsProvider"] = tts_provider or "edge"
            meta["ttsVoice"] = tts_voice or "zh-CN-XiaoyiNeural"
            meta["ttsRate"] = tts_rate or "+0%"
            if tts_provider == "custom":
                meta["ttsApiBase"] = tts_api_base
                meta["ttsApiKey"] = tts_api_key
                meta["ttsModel"] = tts_model or "tts-1"
        (project_dir / "meta.json").write_text(
            _json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return web.json_response({"ok": True, "name": name})
    except Exception as e:
        logger.exception("video project create error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project(request: web.Request) -> web.Response:
    """GET /api/video/project?name=<n> - get a single project's status."""
    try:
        name = request.query.get("name") or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _video_projects_dir() / name
        if not project_dir.is_dir():
            return web.json_response({"status": "not_found"}, status=404)
        status_info = _get_video_project_status(project_dir)
        chat_id_file = project_dir / ".chat_id"
        chat_id = (
            chat_id_file.read_text(encoding="utf-8").strip()
            if chat_id_file.exists()
            else None
        )
        meta_file = project_dir / "meta.json"
        meta = (
            _json.loads(meta_file.read_text(encoding="utf-8"))
            if meta_file.is_file()
            else {}
        )
        return web.json_response({
            "name": name,
            "chatId": chat_id,
            "meta": meta,
            **status_info,
        })
    except Exception as e:
        logger.exception("video project error")
        return web.json_response({"error": str(e)}, status=500)


_VIDEO_FILE_CONTENT_TYPES: dict[str, str] = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".md": "text/markdown",
    ".txt": "text/plain",
}


async def handle_video_project_file(request: web.Request) -> web.Response:
    """GET /api/video/project-file?name=<n>&path=<p> - read a file from a project."""
    try:
        name = request.query.get("name") or ""
        file_path = request.query.get("path") or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        if not file_path or ".." in file_path:
            return web.json_response({"error": "invalid file path"}, status=400)
        project_dir = _video_projects_dir() / name
        resolved = (project_dir / file_path).resolve()
        if not str(resolved).startswith(str(project_dir.resolve())):
            return web.json_response(
                {"error": "path outside project"}, status=403
            )
        if not resolved.is_file():
            return web.json_response({"error": "file not found"}, status=404)
        content = resolved.read_bytes()
        content_type = _VIDEO_FILE_CONTENT_TYPES.get(
            resolved.suffix.lower(), "application/octet-stream"
        )
        return web.Response(body=content, content_type=content_type)
    except Exception as e:
        logger.exception("video project file error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_save_chat_id(request: web.Request) -> web.Response:
    """POST /api/video/project-save-chat-id  body: {"name", "chatId"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _video_projects_dir() / name
        if not project_dir.is_dir():
            return web.json_response({"error": "project not found"}, status=404)
        chat_id = str(body.get("chatId", "") or "")
        (project_dir / ".chat_id").write_text(chat_id, encoding="utf-8")
        return web.json_response({"ok": True})
    except Exception as e:
        logger.exception("video save chat id error")
        return web.json_response({"error": str(e)}, status=500)


def _video_project_dir_or_404(name: str) -> tuple[Path | None, web.Response | None]:
    """Validate project name and return (project_dir, None) or (None, error_response)."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None, web.json_response({"error": "invalid project name"}, status=400)
    project_dir = _video_projects_dir() / name
    if not project_dir.is_dir():
        return None, web.json_response({"error": "project not found"}, status=404)
    return project_dir, None


def _load_video_meta(project_dir: Path) -> dict:
    """Load meta.json, return empty dict if missing."""
    meta_file = project_dir / "meta.json"
    if not meta_file.is_file():
        return {}
    try:
        return _json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_video_meta(project_dir: Path, meta: dict) -> None:
    """Save meta.json."""
    (project_dir / "meta.json").write_text(
        _json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _sync_storyboard(project_dir: Path, scenes: list[dict]) -> None:
    """Write scenes to storyboard.md via the write_storyboard script logic."""
    import importlib.util

    skill_dir = Path(__file__).parent.parent / "skills" / "mona-video"
    script = skill_dir / "scripts" / "write_storyboard.py"
    spec = importlib.util.spec_from_file_location("write_storyboard", script)
    if spec is None or spec.loader is None:
        return
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.write_storyboard(project_dir, scenes)


async def handle_video_project_storyboard(request: web.Request) -> web.Response:
    """GET /api/video/project/storyboard?name=  → parse storyboard.md into JSON."""
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        # Prefer meta.json scenes (source of truth); fallback to parsing storyboard.md
        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes")
        if isinstance(scenes, list) and scenes:
            return web.json_response({"ok": True, "scenes": scenes, "source": "meta"})

        # Parse from storyboard.md and cache into meta.json
        import importlib.util

        skill_dir = Path(__file__).parent.parent / "skills" / "mona-video"
        script = skill_dir / "scripts" / "parse_storyboard.py"
        spec = importlib.util.spec_from_file_location("parse_storyboard", script)
        if spec is None or spec.loader is None:
            return web.json_response({"ok": False, "error": "parse script missing"})
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        scenes = mod.parse_storyboard(project_dir / "storyboard.md")
        if scenes:
            meta["scenes"] = scenes
            meta.setdefault("phase", "storyboard")
            _save_video_meta(project_dir, meta)
        return web.json_response({"ok": True, "scenes": scenes, "source": "storyboard"})
    except Exception as e:
        logger.exception("video project storyboard error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_update(request: web.Request) -> web.Response:
    """PUT /api/video/project/scene  body: {name, index, title?, duration?, visual?, animation?, narration?, assets?}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        if not scenes:
            return web.json_response({"error": "no scenes; load storyboard first"}, status=409)
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        if "title" in body:
            target["title"] = str(body["title"] or "").strip()
        if "duration" in body:
            d = body["duration"]
            if isinstance(d, (int, float)):
                target["duration"] = int(d)
                target["durationRaw"] = f"{int(d)}s"
            elif isinstance(d, str):
                target["durationRaw"] = d
                import re

                m = re.search(r"(\d+(?:\.\d+)?)", d)
                target["duration"] = int(float(m.group(1))) if m else 0
        if "visual" in body:
            target["visual"] = str(body["visual"] or "")
        if "animation" in body:
            target["animation"] = str(body["animation"] or "")
        if "narration" in body:
            target["narration"] = str(body["narration"] or "")
        if "assets" in body:
            assets = body["assets"]
            target["assets"] = assets if isinstance(assets, list) else []

        meta["scenes"] = scenes
        _save_video_meta(project_dir, meta)
        _sync_storyboard(project_dir, scenes)
        return web.json_response({"ok": True, "scene": target})
    except Exception as e:
        logger.exception("video scene update error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_delete(request: web.Request) -> web.Response:
    """DELETE /api/video/project/scene?name=&index="""
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(request.query.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        if not scenes:
            return web.json_response({"error": "no scenes"}, status=409)
        if len(scenes) <= 1:
            return web.json_response({"error": "cannot delete the last scene"}, status=409)
        scenes = [s for s in scenes if s.get("index") != index]
        for i, s in enumerate(scenes, start=1):
            s["index"] = i
        meta["scenes"] = scenes
        _save_video_meta(project_dir, meta)
        _sync_storyboard(project_dir, scenes)
        return web.json_response({"ok": True, "scenes": scenes})
    except Exception as e:
        logger.exception("video scene delete error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_add(request: web.Request) -> web.Response:
    """POST /api/video/project/scene/add  body: {name, title?, duration?, visual?, animation?, narration?}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        new_index = (max((s.get("index", 0) for s in scenes), default=0)) + 1
        new_scene = {
            "index": new_index,
            "title": str(body.get("title", "") or "").strip() or f"场景 {new_index}",
            "duration": int(body.get("duration", 5) or 5),
            "durationRaw": f"{int(body.get('duration', 5) or 5)}s",
            "visual": str(body.get("visual", "") or ""),
            "animation": str(body.get("animation", "") or ""),
            "narration": str(body.get("narration", "") or ""),
            "assets": [],
        }
        scenes.append(new_scene)
        meta["scenes"] = scenes
        _save_video_meta(project_dir, meta)
        _sync_storyboard(project_dir, scenes)
        return web.json_response({"ok": True, "scene": new_scene})
    except Exception as e:
        logger.exception("video scene add error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_reorder(request: web.Request) -> web.Response:
    """POST /api/video/project/scene/reorder  body: {name, indices: [old_index, ...]}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        indices = body.get("indices") or []
        if not isinstance(indices, list) or not indices:
            return web.json_response({"error": "indices must be non-empty list"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        if not scenes:
            return web.json_response({"error": "no scenes"}, status=409)
        if len(indices) != len(scenes):
            return web.json_response(
                {"error": f"indices length {len(indices)} != scenes count {len(scenes)}"},
                status=400,
            )

        index_map = {s["index"]: s for s in scenes}
        new_scenes: list[dict] = []
        for new_pos, old_index in enumerate(indices, start=1):
            s = index_map.get(int(old_index))
            if s is None:
                return web.json_response({"error": f"index {old_index} not found"}, status=404)
            s["index"] = new_pos
            new_scenes.append(s)
        meta["scenes"] = new_scenes
        _save_video_meta(project_dir, meta)
        _sync_storyboard(project_dir, new_scenes)
        return web.json_response({"ok": True, "scenes": new_scenes})
    except Exception as e:
        logger.exception("video scene reorder error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_lock_storyboard(request: web.Request) -> web.Response:
    """POST /api/video/project/lock-storyboard  body: {name}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        if not scenes:
            return web.json_response({"error": "no scenes to lock"}, status=409)

        # Write storyboard_lock.md (style lock for executor)
        lock_content = "# Storyboard Lock\n\n"
        lock_content += "Locked scenes (do not change without user approval):\n\n"
        for s in scenes:
            lock_content += f"- Scene {s['index']}: {s.get('title', '')} ({s.get('durationRaw', '')})\n"
        (project_dir / "storyboard_lock.md").write_text(lock_content, encoding="utf-8")

        meta["storyboardLocked"] = True
        meta["phase"] = "producing"
        _save_video_meta(project_dir, meta)
        return web.json_response({"ok": True, "phase": "producing"})
    except Exception as e:
        logger.exception("video lock storyboard error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_narration(request: web.Request) -> web.Response:
    """POST /api/video/project/scene/narration  body: {name, index, regenerate?}.

    Synthesize TTS for a single scene's narration text. Returns the audio
    bytes directly (audio/mpeg) so the frontend can play via <audio>.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        if not meta.get("narrationEnabled", False):
            return web.json_response(
                {"error": "narration is disabled for this project"}, status=409
            )

        scenes = meta.get("scenes") or []
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        text = (target.get("narration") or "").strip()
        if not text:
            return web.json_response(
                {"error": "scene has no narration text"}, status=409
            )

        # Resolve TTS provider
        from mona.providers.tts import EdgeTTSProvider, get_tts_provider

        provider_name = str(meta.get("ttsProvider") or "edge").strip() or "edge"
        voice = str(meta.get("ttsVoice") or "").strip()
        rate = str(meta.get("ttsRate") or "+0%").strip() or "+0%"

        if provider_name == "edge":
            provider = EdgeTTSProvider(
                voice=voice or "zh-CN-XiaoyiNeural", rate=rate
            )
        elif provider_name == "custom":
            api_base = str(meta.get("ttsApiBase") or "").strip()
            api_key = str(meta.get("ttsApiKey") or "").strip()
            model = str(meta.get("ttsModel") or "tts-1").strip() or "tts-1"
            if not api_base or not api_key:
                return web.json_response(
                    {"error": "custom TTS requires ttsApiBase and ttsApiKey"},
                    status=409,
                )
            provider = get_tts_provider(
                "custom",
                api_key=api_key,
                api_base=api_base,
                voice=voice,
                model=model,
                rate=rate,
            )
        else:
            provider = get_tts_provider(provider_name, voice=voice)

        # Synthesize to bytes
        audio_bytes = await provider.synthesize_to_bytes(text, voice=voice)
        if audio_bytes is None:
            return web.json_response(
                {"error": "TTS synthesis failed"}, status=502
            )

        # Optionally cache to audio/scene_NN.mp3
        audio_dir = project_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        cache_path = audio_dir / f"scene_{index:02d}.mp3"
        try:
            cache_path.write_bytes(audio_bytes)
        except Exception:
            pass  # Caching is best-effort

        return web.Response(
            body=audio_bytes,
            content_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache",
                "Content-Disposition": f'inline; filename="scene_{index:02d}.mp3"',
            },
        )
    except Exception as e:
        logger.exception("video scene narration error")
        return web.json_response({"error": str(e)}, status=500)


def _video_skill_dir() -> Path:
    return Path(__file__).parent.parent / "skills" / "mona-video"


async def _generate_scene_html_via_llm(
    project_dir: Path, scene: dict, meta: dict
) -> str:
    """Call LLM to generate HTML for a single scene. Returns HTML content."""
    from mona.providers.factory import load_provider_snapshot

    snapshot = load_provider_snapshot()
    provider = snapshot.provider
    model = snapshot.model

    lock_path = project_dir / "storyboard_lock.md"
    lock_content = (
        lock_path.read_text(encoding="utf-8") if lock_path.is_file() else "(无风格锁定)"
    )
    resolution = str(meta.get("resolution") or "1920x1080@30fps")

    system_msg = (
        "你是视频场景 HTML 工程师。根据分镜描述和风格锁定，生成单个场景的 HTML+GSAP 动画。"
        "只输出 HTML 内容，不要 markdown 代码块标记，不要任何解释说明。"
    )
    user_msg = (
        f"## 场景信息\n"
        f"- 编号: {scene.get('index', 1)}\n"
        f"- 标题: {scene.get('title', '')}\n"
        f"- 时长: {scene.get('duration', 5)} 秒\n"
        f"- 画面描述: {scene.get('visual', '')}\n"
        f"- 动画说明: {scene.get('animation', '')}\n"
        f"- 旁白: {scene.get('narration', '')}\n"
        f"- 素材: {', '.join(scene.get('assets', []) or [])}\n\n"
        f"## 风格锁定\n{lock_content}\n\n"
        f"## 分辨率\n{resolution}\n\n"
        f"请生成 scenes/scene_{scene.get('index', 1):02d}.html 的完整内容。"
    )

    resp = await provider.chat_with_retry(
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        model=model,
        max_tokens=4096,
        temperature=0.4,
    )
    html = (resp.content or "").strip()
    # Strip markdown fences if model wrapped output
    if html.startswith("```"):
        lines = html.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        html = "\n".join(lines).strip()
    return html


async def handle_video_ai_scene_html(request: web.Request) -> web.Response:
    """POST /api/video/ai/scene-html  body: {name, index}.

    Generates HTML for a single scene via LLM, writes to scenes/scene_NN.html,
    updates meta.json scene.htmlStatus. Returns the scene path.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        # Mark as generating
        target["htmlStatus"] = "generating"
        _save_video_meta(project_dir, meta)

        try:
            html = await _generate_scene_html_via_llm(project_dir, target, meta)
        except Exception as e:
            target["htmlStatus"] = "pending"
            _save_video_meta(project_dir, meta)
            return web.json_response(
                {"error": f"LLM generation failed: {e}"}, status=502
            )

        scenes_dir = project_dir / "scenes"
        scenes_dir.mkdir(parents=True, exist_ok=True)
        scene_path = scenes_dir / f"scene_{index:02d}.html"
        scene_path.write_text(html, encoding="utf-8")

        target["htmlStatus"] = "previewing"
        target["htmlPath"] = f"scenes/scene_{index:02d}.html"
        _save_video_meta(project_dir, meta)

        return web.json_response({
            "ok": True,
            "scene": target,
            "htmlPath": target["htmlPath"],
        })
    except Exception as e:
        logger.exception("video ai scene html error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_preview(request: web.Request) -> web.Response:
    """GET /api/video/project/scene/preview?name=&index=  → returns HTML content."""
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(request.query.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        scene_path = project_dir / "scenes" / f"scene_{index:02d}.html"
        if not scene_path.is_file():
            return web.json_response(
                {"error": "scene HTML not generated yet", "needsGeneration": True},
                status=404,
            )
        html = scene_path.read_text(encoding="utf-8")
        return web.Response(
            body=html.encode("utf-8"),
            content_type="text/html",
            charset="utf-8",
        )
    except Exception as e:
        logger.exception("video scene preview error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_confirm(request: web.Request) -> web.Response:
    """POST /api/video/project/scene/confirm  body: {name, index}.

    Mark a scene as confirmed. If all scenes confirmed, update meta.phase to 'exportable'.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        target["htmlStatus"] = "confirmed"
        target["confirmedAt"] = datetime.now().isoformat()

        all_confirmed = all(s.get("htmlStatus") == "confirmed" for s in scenes)
        if all_confirmed:
            meta["phase"] = "exportable"

        _save_video_meta(project_dir, meta)
        return web.json_response({
            "ok": True,
            "scene": target,
            "allConfirmed": all_confirmed,
            "phase": meta.get("phase"),
        })
    except Exception as e:
        logger.exception("video scene confirm error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_regenerate(request: web.Request) -> web.Response:
    """POST /api/video/project/scene/regenerate  body: {name, index}.

    Reset scene htmlStatus to pending, then trigger LLM regeneration.
    Effectively delegates to the scene-html AI endpoint.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        # Reset status and regenerate
        target["htmlStatus"] = "generating"
        _save_video_meta(project_dir, meta)

        try:
            html = await _generate_scene_html_via_llm(project_dir, target, meta)
        except Exception as e:
            target["htmlStatus"] = "pending"
            _save_video_meta(project_dir, meta)
            return web.json_response(
                {"error": f"LLM regeneration failed: {e}"}, status=502
            )

        scenes_dir = project_dir / "scenes"
        scenes_dir.mkdir(parents=True, exist_ok=True)
        scene_path = scenes_dir / f"scene_{index:02d}.html"
        scene_path.write_text(html, encoding="utf-8")

        target["htmlStatus"] = "previewing"
        target["htmlPath"] = f"scenes/scene_{index:02d}.html"
        _save_video_meta(project_dir, meta)

        return web.json_response({"ok": True, "scene": target})
    except Exception as e:
        logger.exception("video scene regenerate error")
        return web.json_response({"error": str(e)}, status=500)


async def _rewrite_scene_via_llm(
    project_dir: Path, scene: dict, requirement: str, meta: dict
) -> dict:
    """Call LLM to rewrite a single scene's storyboard fields. Returns new scene dict."""
    from mona.providers.factory import load_provider_snapshot

    snapshot = load_provider_snapshot()
    provider = snapshot.provider
    model = snapshot.model

    system_msg = (
        "你是视频分镜师。根据用户需求重写单个场景的分镜内容。"
        "只输出 JSON，不要 markdown 标记，不要解释。"
        "JSON 格式: {\"title\": \"\", \"duration\": 5, \"visual\": \"\", \"animation\": \"\", \"narration\": \"\"}"
    )
    user_msg = (
        f"## 当前场景\n"
        f"- 编号: {scene.get('index', 1)}\n"
        f"- 标题: {scene.get('title', '')}\n"
        f"- 时长: {scene.get('duration', 5)} 秒\n"
        f"- 画面: {scene.get('visual', '')}\n"
        f"- 动画: {scene.get('animation', '')}\n"
        f"- 旁白: {scene.get('narration', '')}\n\n"
        f"## 用户重写需求\n{requirement}\n\n"
        f"请输出重写后的场景 JSON（保留 index，其他字段可改）。"
    )

    resp = await provider.chat_with_retry(
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        model=model,
        max_tokens=1024,
        temperature=0.5,
    )
    text = (resp.content or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        new_fields = _json.loads(text)
    except Exception as e:
        raise ValueError(f"LLM did not return valid JSON: {e}")

    new_scene = dict(scene)
    for k in ("title", "duration", "visual", "animation", "narration"):
        if k in new_fields:
            v = new_fields[k]
            if k == "duration":
                new_scene[k] = int(v)
                new_scene["durationRaw"] = f"{int(v)}s"
            else:
                new_scene[k] = str(v or "")
    return new_scene


async def handle_video_ai_scene_rewrite(request: web.Request) -> web.Response:
    """POST /api/video/ai/scene-rewrite  body: {name, index, requirement}.

    LLM rewrites a single scene's storyboard fields. Updates meta.json + storyboard.md.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        index = int(body.get("index", 0) or 0)
        if index < 1:
            return web.json_response({"error": "invalid index"}, status=400)
        requirement = str(body.get("requirement", "") or "").strip()
        if not requirement:
            return web.json_response({"error": "requirement is empty"}, status=400)

        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        new_scene = await _rewrite_scene_via_llm(
            project_dir, target, requirement, meta
        )
        # Replace in scenes list
        for i, s in enumerate(scenes):
            if s.get("index") == index:
                scenes[i] = new_scene
                break
        meta["scenes"] = scenes
        _save_video_meta(project_dir, meta)
        _sync_storyboard(project_dir, scenes)

        return web.json_response({"ok": True, "scene": new_scene})
    except Exception as e:
        logger.exception("video ai scene rewrite error")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Video export (Phase 3)
# ---------------------------------------------------------------------------

# In-memory tracking of active render tasks (keyed by project name).
_video_render_tasks: dict[str, asyncio.Task] = {}


def _read_render_status(project_dir: Path) -> dict:
    """Read .render_status.json. Returns idle state if missing."""
    status_file = project_dir / ".render_status.json"
    if not status_file.is_file():
        return {"stage": "idle", "progress": 0}
    try:
        return _json.loads(status_file.read_text(encoding="utf-8"))
    except Exception:
        return {"stage": "idle", "progress": 0}


def _write_render_status(project_dir: Path, status: dict) -> None:
    """Write .render_status.json atomically."""
    status_file = project_dir / ".render_status.json"
    status_file.write_text(
        _json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
    )


async def _run_render_task(project_dir: Path, fps: int, quality: str) -> None:
    """Background task that runs render.py and updates status."""
    name = project_dir.name
    try:
        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 5,
            "message": "启动 Chrome headless...",
            "started_at": datetime.now().isoformat(),
        })

        # Run render.py in a thread pool (it uses asyncio.run internally)
        import importlib.util

        skill_dir = Path(__file__).parent.parent / "skills" / "mona-video"
        script = skill_dir / "scripts" / "render.py"
        spec = importlib.util.spec_from_file_location("render", script)
        if spec is None or spec.loader is None:
            raise RuntimeError("render.py module spec load failed")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 15,
            "message": "逐帧截图中...",
            "started_at": datetime.now().isoformat(),
        })

        # render_project is a sync wrapper around render_project_async.
        # Run it in a thread to avoid blocking the event loop.
        result = await asyncio.to_thread(
            mod.render_project, str(project_dir), fps, quality
        )

        if result.get("ok"):
            _write_render_status(project_dir, {
                "stage": "done",
                "progress": 100,
                "message": "渲染完成",
                "output": result.get("output"),
                "duration": result.get("duration"),
                "fps": result.get("fps"),
                "resolution": result.get("resolution"),
                "total_frames": result.get("total_frames"),
                "audio": result.get("audio"),
                "finished_at": datetime.now().isoformat(),
            })
            # Update meta.json phase
            meta = _load_video_meta(project_dir)
            meta["phase"] = "done"
            meta["hasVideo"] = True
            _save_video_meta(project_dir, meta)
        else:
            _write_render_status(project_dir, {
                "stage": "error",
                "progress": 0,
                "message": result.get("error", "渲染失败"),
                "need_download": result.get("need_download", False),
                "finished_at": datetime.now().isoformat(),
            })
    except Exception as e:
        logger.exception("video render task error")
        _write_render_status(project_dir, {
            "stage": "error",
            "progress": 0,
            "message": str(e)[:500],
            "finished_at": datetime.now().isoformat(),
        })
    finally:
        _video_render_tasks.pop(name, None)


async def handle_video_project_export(request: web.Request) -> web.Response:
    """POST /api/video/project/export  body: {name, fps?, quality?}.

    Triggers MP4 rendering in background. Returns immediately with status.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        # Reject if a render is already running for this project
        existing = _video_render_tasks.get(name)
        if existing is not None and not existing.done():
            return web.json_response(
                {"error": "render already in progress", "status": _read_render_status(project_dir)},
                status=409,
            )

        meta = _load_video_meta(project_dir)
        fps = int(body.get("fps", 0) or 0)
        quality = str(body.get("quality", "standard") or "standard")
        if quality not in ("draft", "standard", "high"):
            quality = "standard"
        # Use meta fps as fallback
        if fps <= 0:
            fps = int(meta.get("fps", 30) or 30)

        # Clear any previous render status
        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 0,
            "message": "准备渲染...",
            "started_at": datetime.now().isoformat(),
        })

        task = asyncio.create_task(_run_render_task(project_dir, fps, quality))
        _video_render_tasks[name] = task

        return web.json_response({
            "ok": True,
            "stage": "rendering",
            "message": "渲染已启动",
        })
    except Exception as e:
        logger.exception("video export error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_export_status(request: web.Request) -> web.Response:
    """GET /api/video/project/export-status?name=  → current render status."""
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        status = _read_render_status(project_dir)
        # Include output.mp4 existence flag
        output_mp4 = project_dir / "renders" / "output.mp4"
        status["hasVideo"] = output_mp4.is_file()
        return web.json_response({"ok": True, **status})
    except Exception as e:
        logger.exception("video export status error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_preview_full(request: web.Request) -> web.Response:
    """GET /api/video/project/preview-full?name=  → returns index.html content.

    If index.html does not exist, attempts to generate it from scenes/.
    """
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None

        index_html = project_dir / "index.html"
        if not index_html.is_file():
            # Try to generate via merge_scenes.py
            import importlib.util

            skill_dir = Path(__file__).parent.parent / "skills" / "mona-video"
            script = skill_dir / "scripts" / "merge_scenes.py"
            if script.is_file():
                spec = importlib.util.spec_from_file_location("merge_scenes", script)
                if spec is not None and spec.loader is not None:
                    mod = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(mod)
                    mod.main(str(project_dir))
            if not index_html.is_file():
                return web.json_response(
                    {"error": "index.html not found and no scenes to merge"},
                    status=404,
                )

        content = index_html.read_text(encoding="utf-8")
        return web.Response(body=content, content_type="text/html")
    except Exception as e:
        logger.exception("video preview full error")
        return web.json_response({"error": str(e)}, status=500)


@web.middleware
async def _cors_middleware(request: web.Request, handler: Callable) -> web.StreamResponse:
    """Add permissive CORS headers so browser apps can call the API directly."""
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(
    agent_loop, model_name: str = "mona", request_timeout: float = 120.0,
) -> web.Application:
    """Create the gateway aiohttp application (Agent runtime only).

    Business routes (email, contacts, video, materials, profile, schedule,
    hoard, url2note) are served by the services process — see
    ``mona.services.server.create_services_app``.
    """
    app = web.Application(client_max_size=20 * 1024 * 1024, middlewares=[_cors_middleware])
    app["agent_loop"] = agent_loop
    app["model_name"] = model_name
    app["request_timeout"] = request_timeout
    app["session_locks"] = {}  # per-user locks, keyed by session_key
    # Event used by POST /shutdown to unwind the gateway's main loop cleanly.
    app["shutdown_event"] = asyncio.Event()

    # --- Agent runtime routes ---
    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/audio/transcriptions", handle_audio_transcriptions)
    app.router.add_post("/v1/audio/speech", handle_audio_speech)
    app.router.add_get("/health", handle_health)
    app.router.add_post("/shutdown", handle_shutdown)
    app.router.add_post("/api/tauri/invoke", handle_tauri_invoke)
    app.router.add_post("/api/system/plan", handle_system_plan)

    # --- Skill lifecycle routes ---
    app.router.add_get("/api/skills/list", handle_skills_list)
    app.router.add_post("/api/skills/set_pinned", handle_skills_set_pinned)
    app.router.add_post("/api/skills/archive", handle_skills_archive)
    app.router.add_post("/api/skills/restore", handle_skills_restore)
    app.router.add_post("/api/skills/prune", handle_skills_prune)
    app.router.add_get("/api/skills/config", handle_skills_config)
    app.router.add_post("/api/skills/update_config", handle_skills_update_config)

    # --- MCP server lifecycle routes ---
    app.router.add_get("/api/mcp/servers", handle_mcp_list_servers)
    app.router.add_post("/api/mcp/servers", handle_mcp_create_server)
    app.router.add_put("/api/mcp/servers/{name}", handle_mcp_update_server)
    app.router.add_delete("/api/mcp/servers/{name}", handle_mcp_delete_server)
    app.router.add_post("/api/mcp/servers/{name}/restart", handle_mcp_restart_server)
    app.router.add_post("/api/mcp/reload", handle_mcp_reload)
    app.router.add_get("/api/mcp/servers/{name}/tools", handle_mcp_list_tools)

    # --- Session-project binding routes ---
    app.router.add_post("/api/sessions/{key}/set-workspace", handle_session_set_workspace)
    app.router.add_post("/api/sessions/{key}/clear-workspace", handle_session_clear_workspace)
    app.router.add_get("/api/projects", handle_projects_list)
    app.router.add_post("/api/projects/remove", handle_project_remove)

    return app
