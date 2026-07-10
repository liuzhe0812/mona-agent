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
from email import policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, formatdate, getaddresses, parseaddr
from pathlib import Path
from typing import Any, Callable, TypeVar

from aiohttp import web
from loguru import logger

from mona.api.hoard_handlers import (
    handle_hoard_add,
    handle_hoard_delete_by_url,
)
from mona.api.notes_kb_handlers import (
    handle_notes_kb_embed,
    handle_notes_kb_embed_status,
    handle_notes_kb_related,
    handle_notes_kb_search,
)
from mona.config.paths import get_media_dir, get_workspace_path
from mona.email.imap_pool import imap_pool_manager
from mona.kb.api import (
    handle_kb_create_project,
    handle_kb_delete_file,
    handle_kb_embed,
    handle_kb_embed_status,
    handle_kb_get_reviews,
    handle_kb_get_wiki_page,
    handle_kb_graph,
    handle_kb_import_files,
    handle_kb_lint,
    handle_kb_list_files,
    handle_kb_list_projects,
    handle_kb_list_wiki,
    handle_kb_rename_project,
    handle_kb_save_reviews,
    handle_kb_search,
    handle_kb_update_wiki_page,
)
from mona.security.network import validate_host
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
)


API_SESSION_KEY = "api:default"
API_CHAT_ID = "default"


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
                logger.warning(
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
            logger.info(f"[idle] {self._account_id} connected, monitoring: {mailboxes}")

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
    from mona.distill.scoring import load_snapshots
    from mona.config.paths import get_memory_dir

    snapshots = load_snapshots(get_memory_dir())
    return web.json_response({"snapshots": snapshots})


async def handle_profile_comparison(request: web.Request) -> web.Response:
    """GET /api/profile/comparison?date=YYYY-MM-DD — get current vs previous snapshot."""
    from mona.distill.scoring import load_snapshots, compute_growth_comparison
    from mona.config.paths import get_memory_dir

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

    logger.info(
        "API request session_key={} media={} text={} stream={}",
        session_key, len(media_paths), text[:80], stream,
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
        encoded = base64.b64encode(raw).decode("ascii").rstrip("=")
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


def _imap_fetch_recent(body: dict[str, Any]) -> list[dict[str, Any]]:
    """连接 IMAP 并拉取邮件。

    - 支持 lastUid 增量同步：只拉取 UID > lastUid 的新邮件
    - 按需拉取模式：只拉取 HEADER + FLAGS，不下载正文/附件
      正文在用户点击邮件时通过 /email/fetch_body 按需拉取，避免同步超时和 DB 膨胀
    - 首次同步限制为最近 20 封，增量同步单次最多 50 封
    - 复用持久连接池，避免频繁 login 触发邮箱风控
    """
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    last_uid_raw = body.get("lastUid")

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

    def op(client: imaplib.IMAP4) -> list[dict[str, Any]]:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")

        # 增量同步：只拉取 UID > last_uid 的邮件
        uids: list[bytes] = []
        all_uids: list[bytes] = []
        if last_uid is not None and last_uid > 0:
            status, data = client.uid("SEARCH", "UID", f"{last_uid + 1}:*")
            if status == "OK" and data and data[0]:
                uids = [u for u in data[0].split() if int(u) > last_uid]
            # 部分企业邮箱对 UID n:* 范围搜索返回空，回退到 SEARCH ALL 本地过滤
            if not uids:
                logger.info(
                    f"[imap-sync] UID range search returned empty for {imap_username}, "
                    f"falling back to SEARCH ALL"
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

        # 保护：如果服务器最大 UID 仍 <= last_uid，说明本地 last_uid 已过期/无效，
        # 重置并重新拉取最近 20 封，避免永远漏掉新邮件。
        if (
            last_uid is not None
            and last_uid > 0
            and all_uids
            and max(int(u) for u in all_uids) <= last_uid
        ):
            logger.warning(
                f"[imap-sync] local last_uid={last_uid} >= server max uid for "
                f"{imap_username}, resetting and fetching recent 20"
            )
            uids = all_uids[-20:]

        if not uids:
            logger.info(
                f"[imap-sync] no new uids for {imap_username} "
                f"(mailbox={mailbox}, last_uid={last_uid})"
            )
            return []

        messages: list[dict[str, Any]] = []
        for uid in uids:
            # Foxmail 风格：同步时拉完整 RFC822（BODY.PEEK[]），落盘 .eml。
            # 点击邮件时 Rust 本地 mailparse 解析，毫秒级，无需走 IMAP。
            status, fetched = client.uid(
                "FETCH", uid, "(BODY.PEEK[] UID FLAGS)"
            )
            if status != "OK" or not fetched:
                continue

            raw_bytes = _email_extract_message_bytes(fetched)
            if raw_bytes is None:
                continue

            uid_str = _email_extract_uid(fetched)
            if not uid_str:
                uid_str = uid.decode("utf-8", errors="ignore")

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
                    "bodyFetched": False,
                    "hasAttachments": _email_has_attachments(parsed),
                    "rawSize": len(raw_bytes),
                    "isRead": _email_extract_seen_flag(fetched),
                    "isStarred": _email_extract_flagged_flag(fetched),
                    "messageId": message_id,
                    "attachments": _email_extract_attachments(parsed),
                    # Foxmail 风格：返回完整 RFC822 字节（base64），供 Rust 侧落盘为 .eml
                    # 点击邮件时 Rust 本地 mailparse 解析 .eml，毫秒级
                    "rawBytes": base64.b64encode(raw_bytes).decode("ascii"),
                }
            )

        return messages

    result = imap_pool_manager.run(body, op)
    logger.info(
        f"[imap-sync] {imap_username} mailbox={mailbox} "
        f"last_uid={last_uid} fetched={len(result)} new messages"
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
                import re as _re
                m = _re.search(r"UIDVALIDITY\s+(\d+)", text)
                if m:
                    uid_validity = m.group(1)
                    break
        status, data = client.uid("SEARCH", "ALL")
        uids: list[str] = []
        if status == "OK" and data and data[0]:
            uids = [u.decode("utf-8", errors="ignore") for u in data[0].split()]
        return {"uids": uids, "uidValidity": uid_validity}

    result = imap_pool_manager.run(body, op)
    logger.info(
        f"[imap-uids] {imap_username} mailbox={mailbox} "
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
        logger.info(
            "IMAP LIST status=%s folders=%s for %s",
            status,
            len(folder_data) if folder_data else 0,
            imap_username,
        )
        # 部分 IMAP 服务器在刚执行完 CREATE 后 LIST 会瞬态返回空，重试一次
        if status == "OK" and not folder_data:
            time.sleep(0.8)
            status, folder_data = client.list()
            logger.info(
                "IMAP LIST retry status=%s folders=%s for %s",
                status,
                len(folder_data) if folder_data else 0,
                imap_username,
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
                logger.info(
                    "[imap-folder] decoded '%s' -> '%s' for %s",
                    original_name,
                    name,
                    imap_username,
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
        logger.info(
            "IMAP CREATE status=%s data=%s mailbox=%s for %s",
            status,
            data,
            mailbox,
            imap_username,
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
                logger.info(
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
        logger.info(
            "IMAP RENAME status=%s data=%s old=%s new=%s for %s",
            status,
            data,
            old_name,
            new_name,
            imap_username,
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
        logger.info(
            "IMAP DELETE status=%s data=%s folder=%s for %s",
            status,
            data,
            folder_name,
            imap_username,
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
            logger.warning("Email sync rejected (folder not accessible): %s", err_msg)
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
    logger.info(f"[smtp] host={smtp_host}:{smtp_port} user={smtp_username} pwd_len={pwd_len}")
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
            logger.warning("附件 base64 解码失败，跳过: %s", filename)
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
                logger.info(f"[append-sent] 服务器文件夹列表: {folder_names}")
        except Exception:
            logger.debug("[append-sent] LIST 失败，跳过诊断")

        # 尝试每个候选文件夹，第一个成功的即返回
        for sent_box in sent_candidates:
            try:
                quoted = _imap_quote_mailbox(sent_box)
                logger.info(f"[append-sent] 尝试 APPEND 到 {sent_box} (quoted={quoted})")
                typ, _ = client.append(
                    quoted, "(\\Seen)", None, raw_bytes
                )
                if typ == "OK":
                    logger.info(f"[append-sent] 成功保存副本到 {sent_box}")
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
                            logger.info(f"[append-sent] LIST 发现文件夹 {folder_name}，尝试 APPEND")
                            typ, _ = client.append(
                                quoted, "(\\Seen)", None, raw_bytes
                            )
                            if typ == "OK":
                                logger.info(f"[append-sent] 成功保存副本到 {folder_name}")
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
        logger.info(f"[email-send] SMTP 发送成功，raw_bytes 大小={len(raw_bytes)}")

        # 2. 同步保存副本到 IMAP 服务器（等 APPEND 完成再返回）
        # 必须同步：Rust 侧返回后会立即同步"已发送"文件夹，APPEND 必须先完成
        if raw_bytes:
            try:
                await _safe_append_sent(body, raw_bytes)
                logger.info("[email-send] IMAP APPEND 副本保存完成")
            except Exception:
                logger.warning("[email-send] 保存已发送副本失败（不影响发送结果）", exc_info=True)
        else:
            logger.warning("[email-send] raw_bytes 为空，跳过保存副本")

        # 3. 提取 Message-Id 和 Date，供 Rust 侧落盘 .eml + 写本地索引
        message_id = ""
        date_str = ""
        try:
            import email as email_lib
            msg = email_lib.message_from_bytes(raw_bytes)
            message_id = (msg.get("Message-Id") or "").strip()
            date_str = (msg.get("Date") or "").strip()
        except Exception:
            logger.debug("[email-send] 提取 Message-Id/Date 失败", exc_info=True)

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
        logger.info("[email-send] 保存已发送副本异步任务完成")
    except asyncio.CancelledError:
        logger.warning("[email-send] 保存已发送副本异步任务被取消")
    except Exception as e:
        logger.warning(f"[email-send] 保存已发送副本异步任务失败: {e}")


async def _safe_append_sent(body: dict[str, Any], raw_bytes: bytes) -> None:
    """异步保存已发送邮件副本，任何异常只记日志不影响主流程。

    通过 _run_imap_locked 获取 per-account 锁，避免与后台同步并发操作同一 IMAP 连接。
    """
    try:
        logger.info("[append-sent] 开始保存已发送邮件副本")
        await _run_imap_locked(body, lambda b: _imap_append_sent_sync(b, raw_bytes))
        logger.info("[append-sent] 保存已发送邮件副本流程结束")
    except Exception:
        logger.warning("保存已发送邮件副本失败", exc_info=True)


def _imap_append_sent_sync(body: dict[str, Any], raw_bytes: bytes) -> None:
    """同步版的 IMAP APPEND（通过 _run_imap_locked 调用，已获得锁）。"""
    _imap_append_sent(body, raw_bytes)


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
    # 如果当前已在回收站文件夹，直接永久删除
    if current_mailbox in trash_candidates:
        mail.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
        mail.expunge()
        return None

    # 先动态查找服务器上实际的 trash 文件夹（从 LIST 结果匹配）
    actual_trash = _find_trash_folder(mail, trash_candidates)

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


def _imap_move_message(body: dict[str, Any]) -> None:
    """连接 IMAP 并将指定 UID 的邮件移动到目标文件夹。复用持久连接池。"""
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

    def op(client: imaplib.IMAP4) -> None:
        client.select(_imap_quote_mailbox(mailbox))
        # 优先尝试 IMAP MOVE（RFC 6851），失败则回退到 COPY+STORE+EXPUNGE
        try:
            client.uid("MOVE", uid, _imap_quote_mailbox(dest_mailbox))
        except imaplib.IMAP4.error:
            client.uid("COPY", uid, _imap_quote_mailbox(dest_mailbox))
            client.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
            client.expunge()

    # 注意：MOVE/EXPUNGE 后部分服务器会立即关闭连接，
    # 连接池会自动重连，不影响下次操作
    imap_pool_manager.run(body, op)


async def handle_email_move(request: web.Request) -> web.Response:
    """POST /email/move - 移动 IMAP 邮件到目标文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_move_message)
        return web.json_response({"status": "ok"})
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

    agent_loop = request.app["agent_loop"]
    provider = getattr(agent_loop, "provider", None)
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


def _imap_fetch_attachment(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP，FETCH 完整邮件，按 filename 提取附件并返回 base64 编码。复用持久连接池。"""
    import base64

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

    请求体：{ imapHost, imapPort, imapUsername, imapPassword, mailbox, uid, useSsl }
    返回：{ bodyText, bodyHtml, hasAttachments, attachments, rawBytes }
    Foxmail 风格：额外返回 rawBytes（base64 编码的完整 RFC822），供 Rust 侧落盘为 .eml。
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
            raise RuntimeError("Failed to extract message bytes")

        parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))
        body_text, body_html = _email_extract_bodies(parsed)
        # body_text 截断到 50000 字符，与同步逻辑保持一致
        if body_text:
            body_text = body_text[:50000]

        return {
            "bodyText": body_text,
            "bodyHtml": body_html,
            "hasAttachments": _email_has_attachments(parsed),
            "attachments": _email_extract_attachments(parsed),
            # Foxmail 风格：返回完整 RFC822 字节（base64），供 Rust 侧落盘为 .eml 文件
            "rawBytes": base64.b64encode(raw_bytes).decode("ascii"),
        }

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


async def handle_email_parse_body(request: web.Request) -> web.Response:
    """POST /email/parse_body - 从 RFC822 字节解析邮件正文（不走 IMAP）。

    Foxmail 风格：Rust 侧已将 .eml 文件落盘，点击邮件时优先读本地 .eml 并调用此路由解析，
    避免每次点击都走 IMAP。

    请求体：{ rawBytes: string (base64 编码的 RFC822) }
    返回：{ bodyText, bodyHtml, hasAttachments, attachments }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        raw_b64 = str(body.get("rawBytes", "") or "")
        if not raw_b64:
            return web.json_response({"error": "rawBytes is required"}, status=400)

        raw_bytes = base64.b64decode(raw_b64)
        parsed = BytesParser(policy=policy.default).parsebytes(_normalize_mime_charset(raw_bytes))
        body_text, body_html = _email_extract_bodies(parsed)
        if body_text:
            body_text = body_text[:50000]

        return web.json_response({
            "bodyText": body_text,
            "bodyHtml": body_html,
            "hasAttachments": _email_has_attachments(parsed),
            "attachments": _email_extract_attachments(parsed),
        })
    except Exception as e:
        logger.exception("Failed to parse email body from raw bytes")
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
            raise RuntimeError("Failed to extract message bytes")

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
    """POST /api/video/project/create  body: {"name", "resolution", "fps", "quality"}."""
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

        project_dir = _video_projects_dir() / name
        if project_dir.exists():
            return web.json_response(
                {"error": "project already exists"}, status=409
            )
        # Pre-build the standard directory layout.
        for sub in ("scenes", "compositions", "assets", "renders", "output/preview"):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        (project_dir / ".generating").write_text("1", encoding="utf-8")
        meta = {
            "name": name,
            "resolution": resolution,
            "fps": fps,
            "quality": quality,
        }
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


# ---------------------------------------------------------------------------
# Flowchart project routes (/api/flowchart/*)
# ---------------------------------------------------------------------------


def _flowchart_projects_dir() -> Path:
    return get_workspace_path() / "flowchart_projects"


def _get_flowchart_project_status(project_dir: Path) -> dict:
    """Inspect a flowchart project directory and return its status."""
    generating_marker = project_dir / ".generating"
    diagram = project_dir / "diagram.drawio"
    graph_json = project_dir / "graph.json"
    output_dir = project_dir / "output"
    has_svg = (output_dir / "diagram.svg").is_file()
    has_png = (output_dir / "diagram.png").is_file()
    has_export = has_svg or has_png
    if has_export:
        status = "done"
    elif generating_marker.exists() and not diagram.exists():
        status = "generating"
    elif diagram.exists():
        status = "done"
    elif graph_json.exists():
        status = "generating"
    else:
        status = "init"
    return {
        "status": status,
        "hasDiagram": diagram.exists(),
        "hasGraph": graph_json.exists(),
        "hasExport": has_export,
        "hasSvg": has_svg,
        "hasPng": has_png,
    }


async def handle_flowchart_projects(request: web.Request) -> web.Response:
    """GET /api/flowchart/projects - list all flowchart projects."""
    try:
        projects_dir = _flowchart_projects_dir()
        if not projects_dir.exists():
            return web.json_response({"projects": []})
        projects = []
        for d in sorted(projects_dir.iterdir()):
            if not d.is_dir() or d.name.startswith("_"):
                continue
            status_info = _get_flowchart_project_status(d)
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
        logger.exception("flowchart projects error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project_create(request: web.Request) -> web.Response:
    """POST /api/flowchart/project/create  body: {"name"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _flowchart_projects_dir() / name
        if project_dir.exists():
            return web.json_response(
                {"error": "project already exists"}, status=409
            )
        (project_dir / "output").mkdir(parents=True, exist_ok=True)
        (project_dir / ".generating").write_text("1", encoding="utf-8")
        return web.json_response({"ok": True, "name": name})
    except Exception as e:
        logger.exception("flowchart project create error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project(request: web.Request) -> web.Response:
    """GET /api/flowchart/project?name=<n> - get a single project's status."""
    try:
        name = request.query.get("name") or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _flowchart_projects_dir() / name
        if not project_dir.is_dir():
            return web.json_response({"status": "not_found"}, status=404)
        status_info = _get_flowchart_project_status(project_dir)
        chat_id_file = project_dir / ".chat_id"
        chat_id = (
            chat_id_file.read_text(encoding="utf-8").strip()
            if chat_id_file.exists()
            else None
        )
        return web.json_response({"name": name, "chatId": chat_id, **status_info})
    except Exception as e:
        logger.exception("flowchart project error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project_xml(request: web.Request) -> web.Response:
    """GET /api/flowchart/project-xml?name=<n> - read diagram.drawio content."""
    try:
        name = request.query.get("name") or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _flowchart_projects_dir() / name
        diagram = project_dir / "diagram.drawio"
        if not diagram.is_file():
            return web.json_response({"error": "diagram not found"}, status=404)
        xml = diagram.read_text(encoding="utf-8")
        return web.json_response({"name": name, "xml": xml})
    except Exception as e:
        logger.exception("flowchart project xml error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project_save(request: web.Request) -> web.Response:
    """POST /api/flowchart/project-save  body: {"name", "xml"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _flowchart_projects_dir() / name
        if not project_dir.is_dir():
            return web.json_response({"error": "project not found"}, status=404)
        xml = str(body.get("xml", "") or "")
        (project_dir / "diagram.drawio").write_text(xml, encoding="utf-8")
        # Saving user edits means generation is complete.
        (project_dir / ".generating").unlink(missing_ok=True)
        return web.json_response({"ok": True})
    except Exception as e:
        logger.exception("flowchart project save error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project_export(request: web.Request) -> web.Response:
    """GET /api/flowchart/project-export?name=<n>&format=<svg|png>."""
    try:
        name = request.query.get("name") or ""
        fmt = (request.query.get("format") or "svg").lower()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        if fmt not in {"svg", "png"}:
            return web.json_response(
                {"error": "format must be svg or png"}, status=400
            )
        project_dir = _flowchart_projects_dir() / name
        export_file = project_dir / "output" / f"diagram.{fmt}"
        if not export_file.is_file():
            return web.json_response(
                {"error": "export file not found"}, status=404
            )
        content = export_file.read_bytes()
        content_type = (
            "image/svg+xml" if fmt == "svg" else "image/png"
        )
        return web.Response(body=content, content_type=content_type)
    except Exception as e:
        logger.exception("flowchart project export error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_project_save_chat_id(
    request: web.Request,
) -> web.Response:
    """POST /api/flowchart/project-save-chat-id  body: {"name", "chatId"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        project_dir = _flowchart_projects_dir() / name
        if not project_dir.is_dir():
            return web.json_response({"error": "project not found"}, status=404)
        chat_id = str(body.get("chatId", "") or "")
        (project_dir / ".chat_id").write_text(chat_id, encoding="utf-8")
        return web.json_response({"ok": True})
    except Exception as e:
        logger.exception("flowchart save chat id error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_runtime_check(request: web.Request) -> web.Response:
    """GET /api/flowchart/runtime-check - detect draw.io webapp availability."""
    try:
        from mona.api.flowchart_runtime import get_flowchart_runtime

        result = get_flowchart_runtime().check()
        return web.json_response(result)
    except Exception as e:
        logger.exception("flowchart runtime-check error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_flowchart_runtime_download(request: web.Request) -> web.Response:
    """POST /api/flowchart/runtime-download - download draw.io webapp."""
    try:
        from mona.api.flowchart_runtime import get_flowchart_runtime

        result = await get_flowchart_runtime().ensure_runtime()
        return web.json_response(result)
    except Exception as e:
        logger.exception("flowchart runtime-download error")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# CORS middleware (allows browser-based clients like the ESP32 simulator)
# ---------------------------------------------------------------------------

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
    schedule_service: Any | None = None,
) -> web.Application:
    """Create the aiohttp application.

    Args:
        agent_loop: An initialized AgentLoop instance.
        model_name: Model name reported in responses.
        request_timeout: Per-request timeout in seconds.
        schedule_service: Optional ScheduleService for /api/schedule/* routes.
    """
    app = web.Application(client_max_size=20 * 1024 * 1024, middlewares=[_cors_middleware])
    app["agent_loop"] = agent_loop
    app["model_name"] = model_name
    app["request_timeout"] = request_timeout
    app["session_locks"] = {}  # per-user locks, keyed by session_key
    # Event used by POST /shutdown to unwind the gateway's main loop cleanly.
    app["shutdown_event"] = asyncio.Event()
    app["schedule_service"] = schedule_service

    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/audio/transcriptions", handle_audio_transcriptions)
    app.router.add_post("/v1/audio/speech", handle_audio_speech)
    app.router.add_get("/health", handle_health)
    app.router.add_post("/shutdown", handle_shutdown)
    app.router.add_post("/api/tauri/invoke", handle_tauri_invoke)

    # KB routes
    app.router.add_get("/api/kb/projects", handle_kb_list_projects)
    app.router.add_post("/api/kb/projects", handle_kb_create_project)
    app.router.add_post("/api/kb/{id}/rename", handle_kb_rename_project)
    app.router.add_get("/api/kb/{id}/files", handle_kb_list_files)
    app.router.add_post("/api/kb/{id}/import", handle_kb_import_files)
    app.router.add_delete("/api/kb/{id}/files/{path:.*}", handle_kb_delete_file)
    app.router.add_get("/api/kb/{id}/wiki", handle_kb_list_wiki)
    app.router.add_get("/api/kb/{id}/wiki/{path:.*}", handle_kb_get_wiki_page)
    app.router.add_post("/api/kb/{id}/wiki/update/{path:.*}", handle_kb_update_wiki_page)
    app.router.add_get("/api/kb/{id}/graph", handle_kb_graph)
    app.router.add_get("/api/kb/{id}/search", handle_kb_search)
    app.router.add_post("/api/kb/{id}/embed", handle_kb_embed)
    app.router.add_get("/api/kb/{id}/embed/status", handle_kb_embed_status)
    app.router.add_get("/api/kb/{id}/reviews", handle_kb_get_reviews)
    app.router.add_post("/api/kb/{id}/reviews", handle_kb_save_reviews)
    app.router.add_get("/api/kb/{id}/lint", handle_kb_lint)

    # Notes KB routes (vector index + hybrid search for notes vault)
    app.router.add_post("/api/notes-kb/embed", handle_notes_kb_embed)
    app.router.add_get("/api/notes-kb/embed/status", handle_notes_kb_embed_status)
    app.router.add_post("/api/notes-kb/search", handle_notes_kb_search)
    app.router.add_get("/api/notes-kb/related/{note_id}", handle_notes_kb_related)

    # Hoard routes (Agent URL memory: browser star sync)
    app.router.add_post("/api/hoard", handle_hoard_add)
    app.router.add_delete("/api/hoard-by-url", handle_hoard_delete_by_url)

    # Email routes
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
    app.router.add_post("/email/parse_body", handle_email_parse_body)
    app.router.add_post("/email/parse_attachment", handle_email_parse_attachment)
    app.router.add_post("/email/fetch_raw", handle_email_fetch_raw)
    app.router.add_post("/email/save_draft", handle_email_save_draft)
    app.router.add_post("/email/test_connection", handle_email_test_connection)
    app.router.add_post("/email/reset_pool", handle_email_reset_pool)
    app.router.add_get("/email/pool_status", handle_email_pool_status)

    # Contacts (CardDAV) routes
    app.router.add_post("/contacts/sync", handle_contacts_sync)
    app.router.add_post("/contacts/test_carddav", handle_contacts_test_carddav)
    app.router.add_post("/contacts/sync_eas", handle_contacts_sync_eas)
    app.router.add_post("/contacts/test_eas", handle_contacts_test_eas)

    # Email IDLE routes（实时推送）
    app.router.add_post("/email/idle/start", handle_email_idle_start)
    app.router.add_post("/email/idle/stop", handle_email_idle_stop)
    app.router.add_get("/email/idle/status", handle_email_idle_status)
    app.router.add_get("/email/idle/ws", handle_email_idle_ws)

    # Email account lifecycle routes
    app.router.add_post("/email/account_removed", handle_email_account_removed)

    # Schedule routes
    app.router.add_get("/api/schedule/items", handle_schedule_list)
    app.router.add_get("/api/schedule/items/{id}", handle_schedule_get)
    app.router.add_post("/api/schedule/items", handle_schedule_create)
    app.router.add_post("/api/schedule/items/{id}/update", handle_schedule_update)
    app.router.add_post("/api/schedule/items/{id}/remove", handle_schedule_remove)
    app.router.add_post("/api/schedule/items/{id}/toggle", handle_schedule_toggle)
    app.router.add_get("/api/schedule/notifications", handle_schedule_notifications)

    # Session-project binding routes (Phase 3)
    app.router.add_post("/api/sessions/{key}/set-workspace", handle_session_set_workspace)
    app.router.add_post("/api/sessions/{key}/clear-workspace", handle_session_clear_workspace)
    app.router.add_get("/api/projects", handle_projects_list)

    # Profile (user distillation) routes
    app.router.add_get("/api/profile", handle_profile_get)
    app.router.add_get("/api/profile/user", handle_profile_user_get)
    app.router.add_patch("/api/profile/user", handle_profile_user_update)
    app.router.add_post("/api/profile/distill", handle_profile_distill)
    app.router.add_get("/api/profile/snapshots", handle_profile_snapshots)
    app.router.add_get("/api/profile/comparison", handle_profile_comparison)

    # Video project routes
    app.router.add_get("/api/video/runtime-check", handle_video_runtime_check)
    app.router.add_post("/api/video/runtime-download", handle_video_runtime_download)
    app.router.add_get("/api/video/projects", handle_video_projects)
    app.router.add_post("/api/video/project/create", handle_video_project_create)
    app.router.add_get("/api/video/project", handle_video_project)
    app.router.add_get("/api/video/project-file", handle_video_project_file)
    app.router.add_post(
        "/api/video/project-save-chat-id", handle_video_project_save_chat_id
    )

    # Flowchart project routes
    app.router.add_get("/api/flowchart/projects", handle_flowchart_projects)
    app.router.add_post("/api/flowchart/project/create", handle_flowchart_project_create)
    app.router.add_get("/api/flowchart/project", handle_flowchart_project)
    app.router.add_get("/api/flowchart/project-xml", handle_flowchart_project_xml)
    app.router.add_post("/api/flowchart/project-save", handle_flowchart_project_save)
    app.router.add_get(
        "/api/flowchart/project-export", handle_flowchart_project_export
    )
    app.router.add_post(
        "/api/flowchart/project-save-chat-id",
        handle_flowchart_project_save_chat_id,
    )
    app.router.add_get(
        "/api/flowchart/runtime-check", handle_flowchart_runtime_check
    )
    app.router.add_post(
        "/api/flowchart/runtime-download", handle_flowchart_runtime_download
    )

    # draw.io webapp static files (served at /drawio/*)
    # 优先使用用户下载的 ~/.mona/runtime/drawio/,回退打包的 mona/static/drawio/
    from mona.api.flowchart_runtime import get_flowchart_runtime

    _drawio_dir = get_flowchart_runtime().get_drawio_path()
    if _drawio_dir and _drawio_dir.is_dir():
        app.router.add_static("/drawio", str(_drawio_dir), show_index=True)

    # 设置 IDLE 管理器的事件循环
    _idle_manager.set_loop(asyncio.get_event_loop())

    # 启动 IMAP 连接池后台保活线程（每 2 分钟 NOOP 一次），
    # 避免长时间不操作后连接被服务器关闭、下次操作被迫重新 login 触发风控。
    keepalive_thread = threading.Thread(
        target=imap_pool_manager.keepalive,
        args=(120.0,),
        name="imap-pool-keepalive",
        daemon=True,
    )
    keepalive_thread.start()

    async def _on_cleanup(_app: web.Application) -> None:
        _idle_manager.stop_all()
        # 关闭所有 IMAP 连接池，释放持久连接
        await asyncio.to_thread(imap_pool_manager.close_all)

    app.on_cleanup.append(_on_cleanup)

    return app
