"""OpenAI-compatible HTTP API server for a fixed mona session.

Provides /v1/chat/completions and /v1/models endpoints.
All requests route to a single persistent API session.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import imaplib
import json as _json
import math
import os
import re
import shutil
import smtplib
import ssl
import sys
import time
import uuid
import zipfile
from datetime import datetime
from email import policy
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, formatdate, getaddresses, parseaddr, parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, TypeVar
from urllib.parse import quote, unquote

from aiohttp import web
from loguru import logger

from mona.api.hoard_handlers import (
    handle_hoard_add,
    handle_hoard_delete_by_url,
)
from mona.api.url2note import Url2NoteError, Url2NoteExtractor
from mona.config.paths import get_media_dir, get_workspace_path
from mona.email.imap_pool import ImapOperationDeferred, ImapOutcomeUnknown, imap_pool_manager
from mona.materials.api import (
    handle_materials_create_directory,
    handle_materials_create_library,
    handle_materials_delete,
    handle_materials_delete_library,
    handle_materials_delete_wiki_page,
    handle_materials_extract,
    handle_materials_get_evidence,
    handle_materials_get_raw,
    handle_materials_get_raw_binary,
    handle_materials_get_text,
    handle_materials_get_wiki_page,
    handle_materials_lint,
    handle_materials_list_files,
    handle_materials_list_libraries,
    handle_materials_list_wiki,
    handle_materials_llm_config,
    handle_materials_move,
    handle_materials_reconcile,
    handle_materials_search,
    handle_materials_status,
    handle_materials_update_library,
    handle_materials_write_wiki_page,
)
from mona.providers.tts import TTSError
from mona.security.network import validate_host
from mona.system_agent import handle_storage_analyze, handle_system_diagnose, handle_system_plan
from mona.usage import get_usage_summary
from mona.utils.helpers import replace_file_with_retry, safe_filename
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
from mona.video_style import (
    VideoStyleError,
    read_style_version,
)
from mona.video_style import (
    get_series as get_video_series,
)
from mona.video_style import (
    series_directory as video_series_directory,
)

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
    "handle_materials_create_library",
    "handle_materials_delete",
    "handle_materials_delete_library",
    "handle_materials_delete_wiki_page",
    "handle_materials_extract",
    "handle_materials_get_evidence",
    "handle_materials_get_raw",
    "handle_materials_get_raw_binary",
    "handle_materials_get_text",
    "handle_materials_get_wiki_page",
    "handle_materials_lint",
    "handle_materials_list_files",
    "handle_materials_list_libraries",
    "handle_materials_list_wiki",
    "handle_materials_llm_config",
    "handle_materials_move",
    "handle_materials_reconcile",
    "handle_materials_search",
    "handle_materials_status",
    "handle_materials_update_library",
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
_IMAP_LOCK_TIMEOUT_SECONDS = 10.0
_IMAP_FOREGROUND_WAITERS: dict[tuple[str, str], int] = {}
_IMAP_SYNC_BATCH_SECONDS = 2.0


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
    background = bool(body.get("background")) and func in (
        _imap_fetch_recent, _imap_list_uids, _imap_fetch_body, _imap_fetch_attachment, _imap_fetch_raw,
    )
    lock = _IMAP_LOCKS[key]
    loop = asyncio.get_running_loop()
    started = loop.time()
    interrupt_timer: asyncio.TimerHandle | None = None

    def interrupt_background_until_acquired() -> None:
        nonlocal interrupt_timer
        imap_pool_manager.interrupt_background(body)
        interrupt_timer = loop.call_later(0.1, interrupt_background_until_acquired)

    if not background:
        _IMAP_FOREGROUND_WAITERS[key] = _IMAP_FOREGROUND_WAITERS.get(key, 0) + 1
        # 后台线程可能仍在启动，等待期间也要让随后开始的后台读让出连接。
        interrupt_background_until_acquired()
    try:
        async with asyncio.timeout(_IMAP_LOCK_TIMEOUT_SECONDS):
            while True:
                await lock.acquire()
                if not background or not _IMAP_FOREGROUND_WAITERS.get(key):
                    break
                lock.release()
                await asyncio.sleep(0)
    except TimeoutError:
        if background:
            raise ImapOperationDeferred("后台收取已暂缓，稍后继续。") from None
        logger.warning("[imap] queue timeout: operation={} waited={:.1f}s", func.__name__, loop.time() - started)
        raise TimeoutError("邮箱正忙，请稍后重试。") from None
    finally:
        if not background:
            if interrupt_timer is not None:
                interrupt_timer.cancel()
            remaining = _IMAP_FOREGROUND_WAITERS[key] - 1
            if remaining:
                _IMAP_FOREGROUND_WAITERS[key] = remaining
            else:
                _IMAP_FOREGROUND_WAITERS.pop(key)
    acquired = loop.time()
    try:
        return await _retry_imap_call(func, body, max_retries=max_retries)
    finally:
        lock.release()
        elapsed = loop.time() - acquired
        if acquired - started >= 1 or elapsed >= 10:
            logger.warning(
                "[imap] slow operation: operation={} queued={:.1f}s running={:.1f}s",
                func.__name__, acquired - started, elapsed,
            )


# 可重试的异常特征（网络瞬时故障）
_RETRYABLE_ERRORS = (
    TimeoutError,
    ConnectionError,
    OSError,
    imaplib.IMAP4.abort,
)


def _is_retryable_error(e: Exception) -> bool:
    """判断异常是否为可重试的瞬时网络故障。"""
    # Python 3.14+ 将 smtplib.SMTPException 改为继承 OSError，
    # 导致 SMTPAuthenticationError（535 认证失败）被误判为可重试。
    # SMTP 认证/权限错误是永久性业务错误，重试只会加剧邮箱风控。
    if isinstance(e, smtplib.SMTPResponseException):
        return False
    if isinstance(e, (ImapOperationDeferred, ImapOutcomeUnknown)):
        return False
    if isinstance(e, imaplib.IMAP4.readonly):
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
                    has_new_mail = self._do_idle_cycle(timeout=29 * 60)
                    if self._stop_event.is_set():
                        break
                    if has_new_mail:
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
                            has_new_mail = worker._do_idle_cycle(timeout=29 * 60)
                            if sub_stop.is_set():
                                break
                            if has_new_mail:
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
                    has_new_mail = self._do_idle_cycle(timeout=29 * 60)
                    if self._stop_event.is_set():
                        break
                    if has_new_mail:
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

    def _do_idle_cycle(self, timeout: int) -> bool:
        """发送 IDLE 命令，等待通知或超时，然后发送 DONE。"""
        client = self._client
        if client is None:
            return False

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
            return False

        # 等待服务器推送（未标记响应）或超时
        sock = client.sock
        start = time.time()
        has_new_mail = False
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
                # 只有 EXISTS/RECENT 表示可能有新邮件；FLAGS、EXPUNGE、超时和断线
                # 都不应触发一次全账号同步。
                upper_line = line.upper()
                if line.startswith(b"* ") and (
                    b" EXISTS" in upper_line or b" RECENT" in upper_line
                ):
                    has_new_mail = True
                    break

        # 发送 DONE 结束 IDLE
        self._send_done()
        return has_new_mail

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


async def handle_webui_sidebar_state_update(request: web.Request) -> web.Response:
    """Persist sidebar state from a JSON body without request-URL size limits."""
    from mona.webui.sidebar_state import write_webui_sidebar_state

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "state must be an object"}, status=400)
    try:
        state = write_webui_sidebar_state(body, merge_markers=True)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except OSError:
        logger.exception("failed to write webui sidebar state")
        return web.json_response({"error": "failed to write sidebar state"}, status=500)
    return web.json_response(state)


# ---------------------------------------------------------------------------
# Profile (user distillation) routes
# ---------------------------------------------------------------------------


def _get_memory_dir_for_profile() -> Any:
    from mona.distill.store import ensure_user_profile_store

    return ensure_user_profile_store()


async def handle_profile_get(request: web.Request) -> web.Response:
    """GET /api/profile — return profile.rich.json content."""
    import copy

    from mona.distill.store import effective_context, ensure_profile_v3

    memory_dir = _get_memory_dir_for_profile()
    data = copy.deepcopy(ensure_profile_v3(memory_dir))
    data["effective_context"] = effective_context(data)
    artifact_feedback = data.get("feedback", {}).get("artifacts", {})
    for item in data.get("dashboard", {}).get("artifacts", []):
        if not isinstance(item, dict):
            continue
        feedback = artifact_feedback.get(item.get("id"), {})
        item["adopted"] = bool(feedback.get("adopted", False))
        item["feedback_revision"] = int(feedback.get("revision") or 0)
    return web.json_response(data)


async def handle_profile_user_get(request: web.Request) -> web.Response:
    """GET /api/profile/user — return USER.md content."""
    from mona.distill.store import ensure_profile_v3, read_user_profile

    memory_dir = _get_memory_dir_for_profile()
    ensure_profile_v3(memory_dir)
    content = read_user_profile(memory_dir)
    return web.json_response({"content": content})


async def handle_profile_user_update(request: web.Request) -> web.Response:
    """PATCH /api/profile/user — update USER.md section or full content."""
    from mona.distill.store import (
        replace_user_profile_and_sync,
        update_user_section_and_sync,
    )

    try:
        body = await request.json()
    except Exception:
        return _error_json(400, "Invalid JSON body")

    section = body.get("section")
    content = body.get("content")
    full = body.get("full")

    memory_dir = _get_memory_dir_for_profile()
    if isinstance(full, str):
        data = replace_user_profile_and_sync(memory_dir, full)
        return web.json_response({"ok": True, "mode": "full", "revision": data["revision"]})

    if not isinstance(section, str) or not section.strip():
        return _error_json(400, "section is required (or provide full content)")
    if not isinstance(content, str):
        return _error_json(400, "content is required")

    data = update_user_section_and_sync(memory_dir, section, content)
    return web.json_response({
        "ok": True,
        "mode": "section",
        "section": section,
        "revision": data["revision"],
    })


def _profile_error(status: int, message: str, code: str, **extra: Any) -> web.Response:
    return web.json_response({"error": message, "code": code, **extra}, status=status)


async def handle_profile_context_update(request: web.Request) -> web.Response:
    from pydantic import ValidationError

    from mona.distill.models import ProfileContextPatch
    from mona.distill.store import (
        ProfileRevisionConflictError,
        effective_context,
        update_explicit_context,
    )

    try:
        patch = ProfileContextPatch.model_validate(await request.json())
    except (ValidationError, ValueError, TypeError):
        return _profile_error(400, "画像字段或内容不符合要求", "invalid_profile_context")
    try:
        data, warning = update_explicit_context(
            _get_memory_dir_for_profile(),
            field=patch.field,
            mode=patch.mode,
            value=patch.value,
            expected_context_revision=patch.expected_context_revision,
        )
    except ProfileRevisionConflictError as exc:
        return _profile_error(
            409,
            "画像已在其他位置更新，请核对最新内容后重试",
            "profile_revision_conflict",
            current_context_revision=exc.current_revision,
        )
    response: dict[str, Any] = {
        "ok": True,
        "revision": data["revision"],
        "context_revision": data["facts"]["context_revision"],
        "effective_context": effective_context(data),
    }
    if warning:
        response["warning"] = warning
    return web.json_response(response)


async def handle_profile_advice_feedback(request: web.Request) -> web.Response:
    from pydantic import ValidationError

    from mona.distill.models import AdviceFeedbackPatch
    from mona.distill.store import (
        ProfileItemNotFoundError,
        ProfileRevisionConflictError,
        update_advice_feedback,
    )

    try:
        patch = AdviceFeedbackPatch.model_validate(await request.json())
    except (ValidationError, ValueError, TypeError):
        return _profile_error(400, "建议反馈不符合要求", "invalid_advice_feedback")
    try:
        result = update_advice_feedback(
            _get_memory_dir_for_profile(),
            request.match_info["id"],
            patch.model_dump(exclude={"expected_item_revision"}),
            patch.expected_item_revision,
        )
    except ProfileItemNotFoundError:
        return _profile_error(404, "这条建议已不存在", "advice_not_found")
    except ProfileRevisionConflictError as exc:
        return _profile_error(
            409,
            "这条建议的反馈已更新，请重试",
            "feedback_revision_conflict",
            current_item_revision=exc.current_revision,
        )
    return web.json_response(result)


async def handle_profile_artifact_feedback(request: web.Request) -> web.Response:
    from pydantic import ValidationError

    from mona.distill.models import ArtifactFeedbackPatch
    from mona.distill.store import (
        ProfileItemNotFoundError,
        ProfileRevisionConflictError,
        update_artifact_feedback,
    )

    try:
        patch = ArtifactFeedbackPatch.model_validate(await request.json())
    except (ValidationError, ValueError, TypeError):
        return _profile_error(400, "成果反馈不符合要求", "invalid_artifact_feedback")
    try:
        result = update_artifact_feedback(
            _get_memory_dir_for_profile(),
            request.match_info["id"],
            patch.adopted,
            patch.expected_item_revision,
        )
    except ProfileItemNotFoundError:
        return _profile_error(404, "这项成果已不存在", "artifact_not_found")
    except ProfileRevisionConflictError as exc:
        return _profile_error(
            409,
            "这项成果的状态已更新，请重试",
            "feedback_revision_conflict",
            current_item_revision=exc.current_revision,
        )
    return web.json_response(result)


def _profile_evidence_available(item: dict[str, Any], data: dict[str, Any]) -> bool:
    kind = item.get("kind")
    current_scope = data.get("dashboard", {}).get("source_scope_id")
    if not current_scope or item.get("source_scope_id") != current_scope:
        return False
    if kind == "explicit_context":
        return True
    if kind == "user_message":
        import hashlib

        from mona.agent.partners import conversation_from_session_metadata
        from mona.distill.collectors.session_collector import _is_profile_user_message
        from mona.session.manager import SessionManager

        key = item.get("session_key")
        if not isinstance(key, str):
            return False
        path = get_workspace_path() / "sessions" / f"{SessionManager.safe_key(key)}.jsonl"
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
            meta = _json.loads(lines[0])
            metadata = meta.get("metadata") if isinstance(meta.get("metadata"), dict) else {}
            conversation = conversation_from_session_metadata(metadata)
            name = path.name.lower()
            background = any(
                token in name
                for token in ("ephemeral", "cron_", "cron-", "schedule_", "schedule-")
            ) or any(metadata.get(field) is True for field in (
                "background",
                "is_background",
                "background_execution",
            ))
            source = str(metadata.get("source") or metadata.get("trigger") or "").lower()
            background = background or source in {
                "cron",
                "schedule",
                "scheduled",
                "background",
                "system",
            }
            if conversation.hidden or background or str(meta.get("key") or path.stem) != key:
                return False
            target_index = item.get("message_index")
            expected_hash = item.get("content_hash")
            index = -1
            for raw in lines[1:]:
                message = _json.loads(raw)
                if message.get("_type") == "metadata":
                    continue
                index += 1
                if index != target_index:
                    continue
                if not _is_profile_user_message(message, set(conversation.agent_ids)):
                    return False
                content = message.get("content")
                return isinstance(content, str) and hashlib.sha256(
                    content.encode("utf-8")
                ).hexdigest() == expected_hash
            return False
        except (OSError, ValueError, TypeError, _json.JSONDecodeError, IndexError):
            return False
    if kind == "note":
        import hashlib

        try:
            from mona.agent.tools.notes import _get_vault_path

            root = _get_vault_path()
            relative = item.get("note_relative_path")
            if root is None or not isinstance(relative, str):
                return False
            root = Path(root).resolve()
            target = (root / relative).resolve()
            target.relative_to(root)
            if not target.is_file():
                return False
            content = target.read_text(encoding="utf-8")
            return hashlib.sha256(content.encode("utf-8")).hexdigest() == item.get("content_hash")
        except (OSError, ValueError):
            return False
    if kind == "artifact":
        from mona.agent.artifacts import coerce_artifact_ref

        artifact_id = item.get("artifact_id")
        artifact = next(
            (
                row
                for row in data.get("dashboard", {}).get("artifacts", [])
                if isinstance(row, dict) and row.get("id") == artifact_id
            ),
            None,
        )
        ref = coerce_artifact_ref(artifact.get("artifact_ref")) if artifact else None
        if ref is None:
            return False
        try:
            return ref.resolve(get_workspace_path()).is_file()
        except (OSError, ValueError):
            return False
    return False


async def handle_profile_evidence_get(request: web.Request) -> web.Response:
    from mona.distill.store import read_rich_profile

    data = read_rich_profile(_get_memory_dir_for_profile())
    item = data.get("evidence_index", {}).get(request.match_info["ref"])
    if not isinstance(item, dict):
        return _profile_error(404, "依据不存在", "evidence_not_found")
    if not _profile_evidence_available(item, data):
        return _profile_error(410, "原始依据当前不可访问", "evidence_unavailable")
    return web.json_response({**item, "available": True})


async def handle_profile_advice_start(request: web.Request) -> web.Response:
    from mona.distill.store import read_rich_profile

    data = read_rich_profile(_get_memory_dir_for_profile())
    advice_id = request.match_info["id"]
    item = next(
        (
            value
            for value in data.get("advice", {}).get("items", [])
            if isinstance(value, dict) and value.get("id") == advice_id
        ),
        None,
    )
    if item is None:
        return _profile_error(404, "这条建议已不存在", "advice_not_found")
    feedback = data.get("feedback", {}).get("advice", {}).get(advice_id, {})
    if feedback.get("disposition") in {"dismissed", "completed"}:
        return _profile_error(409, "这条建议当前不是待执行状态", "advice_inactive")
    evidence = [
        data.get("evidence_index", {}).get(ref)
        for ref in item.get("source_refs", [])[:5]
    ]
    evidence = [
        value
        for value in evidence
        if isinstance(value, dict) and _profile_evidence_available(value, data)
    ]
    source_lines = [
        f"- {value.get('title') or value.get('kind')}：{value.get('excerpt') or ''}"
        for value in evidence
    ]
    if item.get("kind") == "one_insight":
        knowledge = item.get("knowledge") if isinstance(item.get("knowledge"), dict) else {}
        resources = [
            f"- {value.get('title')}：{value.get('url')}"
            for value in item.get("resources", [])
            if isinstance(value, dict) and value.get("url")
        ]
        prompt_parts = [
            f"请继续讲解：{knowledge.get('title') or item.get('title')}",
            str(knowledge.get("content") or item.get("why_now") or "").strip(),
            f"学习建议：{item.get('learning_advice') or item.get('first_step')}",
        ]
        if resources:
            prompt_parts.append("参考资料：\n" + "\n".join(resources))
    elif item.get("kind") == "holistic_learning":
        applications = [
            f"- {value.get('area')}：{value.get('benefit')}"
            for value in item.get("application_areas", [])
            if isinstance(value, dict)
        ]
        resources = [
            f"- {value.get('title')}：{value.get('url')}"
            for value in item.get("resources", [])
            if isinstance(value, dict) and value.get("url")
        ]
        prompt_parts = [
            str(item.get("start_prompt") or "").strip(),
            f"希望理解的问题：{item.get('title')}",
            f"建议系统了解：{item.get('knowledge_area')}",
            f"为什么现在值得了解：{item.get('why_now')}",
            f"已有简要解释：\n{item.get('starter_content')}",
        ]
        if applications:
            prompt_parts.append("可以联系到的经历：\n" + "\n".join(applications))
        if resources:
            prompt_parts.append("可参考资料：\n" + "\n".join(resources))
    else:
        prompt_parts = [
            str(item.get("start_prompt") or "").strip(),
            f"建议目标：{item.get('title')}",
            f"先完成：{item.get('first_step')}",
            f"预期产物：{item.get('expected_output')}",
            f"完成标准：{item.get('done_when')}",
        ]
    if source_lines:
        prompt_parts.append("相关背景摘要：\n" + "\n".join(source_lines))
    return web.json_response({
        "prompt": "\n\n".join(part for part in prompt_parts if part),
        "advice_id": advice_id,
        "source_refs": [value["ref"] for value in evidence],
        "origin": "profile_advice",
        "evidence": evidence,
    })


async def handle_profile_distill(request: web.Request) -> web.Response:
    """POST /api/profile/distill — trigger distillation manually.

    Body: {"task": "work-pattern" | "profile" | "advice" | "all"}.
    """
    from mona.distill.service import (
        ProfileBusyError,
        run_advice_distill,
        run_all_distill,
        run_profile_distill,
        run_work_pattern_distill,
    )

    try:
        body = await request.json()
    except Exception:
        body = {}
    task = body.get("task", "all") if isinstance(body, dict) else "all"
    if task not in {"work-pattern", "profile", "advice", "all"}:
        return _profile_error(400, "未知的画像更新任务", "invalid_profile_task")

    agent_loop = request.app.get("agent_loop")

    try:
        if task == "work-pattern":
            result = await run_work_pattern_distill(agent_loop)
        elif task == "profile":
            result = await run_profile_distill(agent_loop)
        elif task == "advice":
            result = await run_advice_distill(agent_loop)
        else:
            results = await run_all_distill(agent_loop)
            return web.json_response({
                "ok": all(item.success for item in results),
                "results": [
                    {
                        "task": item.task_name,
                        "success": item.success,
                        "status": item.status,
                        "confidence": item.confidence,
                        "code": item.code,
                        "error": item.error,
                    }
                    for item in results
                ],
            })
    except ProfileBusyError:
        return _profile_error(409, "画像正在更新，请稍后再试", "profile_busy")

    return web.json_response({
        "ok": result.success,
        "task": result.task_name,
        "status": result.status,
        "confidence": result.confidence,
        "code": result.code,
        "error": result.error,
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
    provider = getattr(request.app.get("agent_loop"), "provider", None)
    capabilities = (
        provider.get_capabilities(model_name).to_dict()
        if provider is not None
        else None
    )
    return web.json_response(
        {
            "object": "list",
            "data": [
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "mona",
                    "capabilities": capabilities,
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
    except TTSError as exc:
        return _tts_error_response(exc)
    except Exception as e:
        logger.exception("Audio speech API error: {}", e)
        return _error_json(500, f"TTS failed: {e}", err_type="server_error")


async def handle_health(request: web.Request) -> web.Response:
    """GET /health"""
    from mona import __version__

    return web.json_response(
        {
            "status": "ok",
            "service": "mona-gateway",
            "version": __version__,
            "capabilities": ["agent-http-v1"],
        }
    )


async def handle_usage_get(request: web.Request) -> web.Response:
    """GET /api/usage - local all-provider model usage."""
    try:
        tz_offset_minutes = int(request.query.get("tz_offset_minutes", "0"))
    except ValueError:
        return _error_json(400, "Invalid timezone offset")
    if not -720 <= tz_offset_minutes <= 840:
        return _error_json(400, "Timezone offset must be between -720 and 840 minutes")
    return web.json_response(get_usage_summary(tz_offset_minutes))


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


def _email_extract_rfc822_size(fetched: list[Any]) -> int | None:
    """从 IMAP FETCH 元数据中提取邮件完整大小。"""
    for item in fetched:
        if isinstance(item, tuple) and item and isinstance(item[0], (bytes, bytearray)):
            head = bytes(item[0]).decode("ascii", errors="ignore")
            match = re.search(r"RFC822\.SIZE\s+(\d+)", head, re.IGNORECASE)
            if match:
                return int(match.group(1))
    return None


def _email_extract_internal_timestamp(fetched: list[Any]) -> int | None:
    """Read INTERNALDATE from FETCH metadata, excluding message literal bytes."""
    has_literal = any(isinstance(item, tuple) and item for item in fetched)
    for item in fetched:
        if isinstance(item, tuple) and item:
            header = item[0]
        elif has_literal:
            header = item
        else:
            continue
        if not isinstance(header, (bytes, bytearray)):
            continue
        match = re.search(rb'\bINTERNALDATE\s+"([^"]+)"', bytes(header), re.IGNORECASE)
        if not match:
            continue
        value = re.fullmatch(
            rb"\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) "
            rb"(\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})",
            match.group(1),
        )
        if not value or int(value[6]) > 23 or int(value[7]) > 59:
            return None
        day, month, year, clock, sign, hours, minutes = (
            group.decode("ascii") for group in value.groups()
        )
        try:
            received = parsedate_to_datetime(
                f"{day} {month} {year} {clock} {sign}{hours}{minutes}"
            )
            return int(received.timestamp()) if received.tzinfo is not None else None
        except (ValueError, TypeError, OverflowError, OSError):
            return None
    return None


def _imap_uid_validity(client: imaplib.IMAP4) -> str:
    """读取 SELECT 后由 imaplib 缓存的 UIDVALIDITY 响应。"""
    _name, data = client.response("UIDVALIDITY")
    for item in data or []:
        if isinstance(item, (bytes, bytearray)):
            match = re.search(r"\d+", bytes(item).decode("ascii", errors="ignore"))
            if match:
                return match.group(0)
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
        header = item[0] if isinstance(item, tuple) and item else item
        if isinstance(header, (bytes, bytearray)):
            head = bytes(header).decode("utf-8", errors="ignore")
            match = re.search(r"\bFLAGS\s*\(([^)]*)\)", head, re.IGNORECASE)
            if match and flag.casefold() in {value.casefold() for value in match[1].split()}:
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
    """提取普通附件和带 Content-ID 的内联资源元信息。"""
    attachments: list[dict[str, Any]] = []
    if not msg.is_multipart():
        return attachments
    for part in msg.walk():
        is_attachment = part.get_content_disposition() == "attachment"
        raw_content_id = str(part.get("Content-ID", "") or "").strip()
        content_id = raw_content_id.strip("<>").strip()
        is_inline = not is_attachment and bool(content_id)
        if not is_attachment and not is_inline:
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
        attachment = {
            "filename": filename,
            "contentType": content_type,
            "size": size,
            "isInline": is_inline,
        }
        if content_id:
            attachment["contentId"] = content_id
        attachments.append(attachment)
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


def _email_sync_uid_batch(
    all_uids: list[bytes], last_uid: int | None, before_uid: int | None,
    known_uids: set[bytes] | None = None,
    include_history: bool = True,
) -> tuple[list[bytes], set[bytes], bool]:
    ordered = sorted(set(all_uids), key=int)
    if not last_uid:
        selected = list(reversed(ordered[-20:]))
        return selected, set(selected), len(ordered) > len(selected)
    newer = [uid for uid in ordered if int(uid) > last_uid]
    selected_new = newer[:50]
    older = [
        uid for uid in ordered if int(uid) <= last_uid
        and (uid not in known_uids if known_uids is not None else int(uid) < (before_uid or last_uid + 1))
    ]
    remaining = 50 - len(selected_new)
    selected_old = list(reversed(older[-remaining:])) if remaining and include_history else []
    return selected_new + selected_old, set(selected_old), len(newer) > len(selected_new) or len(older) > len(selected_old)


def _email_fetch_flags(client: imaplib.IMAP4, uids: list[bytes]) -> list[dict[str, Any]]:
    result = []
    for start in range(0, len(uids), 200):
        uid_set = b",".join(uids[start:start + 200]).decode("ascii")
        status, fetched = client.uid("FETCH", uid_set, "(UID FLAGS)")
        if status != "OK":
            raise RuntimeError("Mailbox flags could not be refreshed")
        for item in fetched or []:
            header = item[0] if isinstance(item, tuple) else item
            if not isinstance(header, bytes):
                continue
            match = re.search(rb"\bUID\s+(\d+)\b", header, re.IGNORECASE)
            if match:
                flags = re.search(rb"\bFLAGS\s*\(([^)]*)\)", header, re.IGNORECASE)
                if flags:
                    values = {value.lower() for value in flags[1].split()}
                    result.append({"uid": match[1].decode("ascii"), "isRead": b"\\seen" in values, "isStarred": b"\\flagged" in values})
    return result


def _imap_fetch_recent(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP 并拉取邮件元数据，正文由按需读取和后台预取负责。

    - 校验 UIDVALIDITY：变化时返回 uidValidityChanged=true，调用方废弃旧 UID 映射
    - 新邮件按 UID 递增补收，历史邮件从 beforeUid 向前补齐
    - FETCH HEADER + FLAGS + INTERNALDATE，避免大附件阻塞整个同步请求
    - 首次同步限制为最近 20 封，增量同步单次最多 50 封
    - 复用持久连接池，避免频繁 login 触发邮箱风控
    - 返回 dict：{"messages": [...], "uidValidity": str, "uidValidityChanged": bool}
    """
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    last_uid_raw = body.get("lastUid")
    before_uid_raw = body.get("beforeUid")
    before_uid = int(before_uid_raw) if before_uid_raw is not None else None
    known_uids_raw = body.get("knownUids")
    known_uids = {str(uid).encode("ascii") for uid in known_uids_raw if str(uid).isdigit()} if isinstance(known_uids_raw, list) else None
    include_history = body.get("includeHistory", True)
    if not isinstance(include_history, bool):
        raise ValueError("includeHistory must be a boolean")
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
        status, _data = client.select(_imap_quote_mailbox(mailbox), readonly=True)
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")
        uid_validity = _imap_uid_validity(client)
        # UIDVALIDITY 变化：调用方负责废弃旧 UID 映射并重建文件夹索引
        uid_validity_changed = bool(
            uid_validity and known_uid_validity and uid_validity != known_uid_validity
        )
        # UID 只在当前 UIDVALIDITY 下有效，变化后不能继续使用旧水位线。
        sync_after_uid = None if uid_validity_changed else last_uid

        status, data = client.uid("SEARCH", "ALL")
        if status != "OK":
            raise RuntimeError("Mailbox UID search failed")
        all_uids = data[0].split() if data and data[0] else []
        history_before = None if uid_validity_changed else before_uid
        uids, historical_uids, has_more = _email_sync_uid_batch(
            all_uids, sync_after_uid, history_before, None if uid_validity_changed else known_uids,
            include_history,
        )
        known = [u for u in all_uids if sync_after_uid and int(u) <= sync_after_uid
                 and (known_uids is None or u in known_uids)
                 and (history_before is None or int(u) >= history_before)]

        messages: list[dict[str, Any]] = []
        batch_started = time.monotonic()
        for uid in uids:
            if messages and time.monotonic() - batch_started >= _IMAP_SYNC_BATCH_SECONDS:
                break
            # 同步主流程只取信头和标志。正文由 /email/fetch_body 按需读取，
            # 后台逐步补齐所有正文，避免一个大附件拖慢整批信头同步。
            uid_str = uid.decode("utf-8", errors="ignore")
            fetch_cmd = "(BODY.PEEK[HEADER] UID FLAGS RFC822.SIZE INTERNALDATE)"
            raw_bytes: bytes | None = None
            fetched: list[Any] = []

            try:
                status, fetched = client.uid("FETCH", uid, fetch_cmd)
                if status != "OK" or not fetched:
                    logger.warning(
                        f"[imap-sync] FETCH header uid={uid_str} failed: status={status}"
                    )
                    break
                raw_bytes = next(
                    (
                        bytes(item[1]) for item in fetched
                        if isinstance(item, tuple) and len(item) > 1
                        and isinstance(item[1], (bytes, bytearray, memoryview)) and item[1]
                    ),
                    None,
                )
                if raw_bytes is None:
                    raw_bytes = _email_extract_message_bytes(fetched)
            except imaplib.IMAP4.error as e:
                # 连接已被服务器关闭（LOGOUT 状态）：后续 FETCH 都会失败。
                # 抛出可重试异常，让 imap_pool.run 重连并重试整个 op，
                # 而不是 continue 到下一个 UID 重复失败。
                if getattr(client, "state", "") == "LOGOUT" or "illegal in state" in str(e).lower():
                    raise imaplib.IMAP4.error(
                        f"connection entered LOGOUT state during FETCH uid={uid_str}: {e}"
                    )
                logger.warning(f"[imap-sync] FETCH header uid={uid_str} failed: {e}")
                break

            if raw_bytes is None:
                logger.warning(
                    f"[imap-sync] FETCH header returned empty for uid={uid_str}"
                )
                break

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
                    "isHistorical": uid in historical_uids,
                    "subject": subject,
                    "from": from_addr,
                    "fromName": from_name,
                    "to": ", ".join(to_addrs),
                    "cc": ", ".join(cc_addrs),
                    "date": date_value,
                    "receivedAt": _email_extract_internal_timestamp(fetched),
                    "bodyText": "",
                    "bodyHtml": None,
                    "bodyFetched": False,
                    "hasAttachments": _email_has_attachments(parsed),
                    "rawSize": _email_extract_rfc822_size(fetched) or len(raw_bytes),
                    "isRead": _email_extract_seen_flag(fetched),
                    "isStarred": _email_extract_flagged_flag(fetched),
                    "messageId": message_id,
                    "attachments": _email_extract_attachments(parsed),
                    # 信头原文（base64）；正文由 /email/fetch_body 补拉
                    "rawBytes": base64.b64encode(raw_bytes).decode("ascii"),
                }
            )

        # 补收历史的连续分页无需反复刷新整份已知标志。
        flags = _email_fetch_flags(client, known) if body.get("refreshFlags", True) else []
        return {"messages": messages, "uidValidity": uid_validity,
                "uidValidityChanged": uid_validity_changed, "flags": flags,
                "hasMore": has_more or len(messages) < len(uids)}

    result = imap_pool_manager.run(body, op, background=bool(body.get("background")))
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
        status, _data = client.select(_imap_quote_mailbox(mailbox), readonly=True)
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")
        uid_validity = _imap_uid_validity(client)
        status, data = client.uid("SEARCH", "ALL")
        uids: list[str] = []
        if status == "OK" and data and data[0]:
            uids = [u.decode("utf-8", errors="ignore") for u in data[0].split()]
        return {"uids": uids, "uidValidity": uid_validity}

    result = imap_pool_manager.run(body, op, background=bool(body.get("background")))
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

    imap_pool_manager.run(body, op, retry_on_disconnect=False)


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

    imap_pool_manager.run(body, op, retry_on_disconnect=False)


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
        # 连接池内部已负责断线重连一次；不要在 HTTP 层再次重跑整个批次。
        result = await _run_imap_locked(body, _imap_fetch_recent, max_retries=0)
        return web.json_response(result)
    except ImapOperationDeferred:
        return web.json_response({"deferred": True}, status=409)
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
    except ImapOperationDeferred:
        return web.json_response({"deferred": True}, status=409)
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
    attachment_bytes = 0
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
        attachment_bytes += len(data_bytes)
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

    # 大附件传输耗时随体积增长，固定 30s 会让 20~50MB 附件在慢链路上直接超时失败
    timeout = 30 + min(int(attachment_bytes / (512 * 1024)), 240)
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
        imap_pool_manager.run(body, op, retry_on_disconnect=False)
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
        raw_bytes = await _run_smtp_call(_smtp_send_message_no_append, body)
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
        definite_failure = isinstance(e, (smtplib.SMTPResponseException, smtplib.SMTPRecipientsRefused, ValueError))
        friendly = _format_smtp_error(e) if definite_failure else "发送结果尚未确认，请先检查已发送邮件，勿直接重复发送。"
        return web.json_response({"error": friendly, "sendState": "failed" if definite_failure else "unknown"}, status=500)


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
    # 邮件过大：服务器拒收超限邮件（Gmail 25MB、Exchange 默认 10MB、企业邮常见 50MB）
    if (
        code == 552
        or "message size" in text_lower
        or "size exceeds" in text_lower
        or "message too large" in text_lower
    ):
        return (
            f"邮件过大被服务器拒收（{code or 'SMTP'}）：{text}。"
            "请减少附件体积（多数邮箱单封上限 10~25MB，企业邮通常 50MB）。"
        )
    # 554 发送被拒
    if code == 554 or "message rejected" in text_lower:
        return f"邮件被服务器拒收（554）：{text}。可能是内容被识别为垃圾邮件或发信频率过高。"
    # 550 信封/路由错误
    if code == 550:
        return f"发送失败（550）：{text}。可能是收件人地址无效或被对方拒收。"
    # 其他错误：返回清理后的文本
    return f"发送邮件失败（{code}）：{text}" if code else f"发送邮件失败：{text}"


async def _run_smtp_call(
    func: Callable[[dict[str, Any]], _T],
    body: dict[str, Any],
) -> _T:
    """SMTP 结果不明时不得自动重发，重试必须由用户核对后重新发起。"""
    return await asyncio.to_thread(func, body)


def _format_draft_addresses(values: list[Any]) -> str:
    formatted: list[str] = []
    for raw in values:
        value = str(raw or "").strip()
        if not value:
            continue
        bracketed = re.fullmatch(r"(.*?)\s*<([^<>]+)>", value)
        if bracketed:
            name = bracketed.group(1).strip().strip('"')
            address = bracketed.group(2).strip()
        else:
            name, address = parseaddr(value)
            address = address.strip()
        if address:
            formatted.append(formataddr((name, address)) if name else address)
        else:
            formatted.append(value)
    return ", ".join(formatted)


def _build_draft_message(body: dict[str, Any], request_id: str) -> EmailMessage:
    from_address = str(body.get("fromAddress", "") or "").strip()
    from_name = str(body.get("fromName", "") or "").strip()
    body_text = str(body.get("bodyText", "") or "")
    body_html = str(body.get("bodyHtml", "") or "")
    in_reply_to = body.get("inReplyTo")

    msg = EmailMessage()
    sender_addr = from_address or str(body.get("imapUsername", "") or "").strip()
    msg["From"] = formataddr((from_name, sender_addr)) if from_name else sender_addr
    for header, key in (("To", "to"), ("Cc", "cc"), ("Bcc", "bcc")):
        formatted = _format_draft_addresses(body.get(key, []) or [])
        if formatted:
            msg[header] = formatted
    msg["Subject"] = str(body.get("subject", "") or "")
    msg["Date"] = formatdate(localtime=True)
    msg["X-Mona-Draft-Request-ID"] = request_id
    if in_reply_to:
        msg["In-Reply-To"] = str(in_reply_to)
        msg["References"] = str(in_reply_to)

    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    attachments = body.get("attachments", []) or []
    if not isinstance(attachments, list):
        raise ValueError("草稿附件格式无效")
    for attachment in attachments:
        if not isinstance(attachment, dict):
            raise ValueError("草稿附件格式无效")
        filename = str(attachment.get("filename", "attachment") or "attachment")
        content_type = str(
            attachment.get("contentType", "application/octet-stream") or "application/octet-stream"
        )
        encoded = str(attachment.get("data", "") or "")
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ValueError(f"草稿附件数据无效: {filename}") from exc
        maintype, separator, subtype = content_type.partition("/")
        if not separator or not maintype or not subtype:
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
        content_id = str(attachment.get("contentId", "") or "").strip().strip("<>")
        if content_id:
            if "\r" in content_id or "\n" in content_id:
                raise ValueError(f"草稿附件 Content-ID 无效: {filename}")
            part = msg.get_payload()[-1]
            part.replace_header("Content-Disposition", "inline")
            part.set_param("filename", filename, header="Content-Disposition", replace=True)
            part["Content-ID"] = f"<{content_id}>"
    return msg


def _appenduid(data: list[bytes] | None) -> str | None:
    raw = b" ".join(item for item in data or [] if isinstance(item, bytes))
    match = re.search(rb"APPENDUID\s+\d+\s+(\d+)", raw, re.IGNORECASE)
    return match.group(1).decode("ascii") if match else None


def _find_draft_request_uid(client: imaplib.IMAP4, mailbox: str, request_id: str) -> str | None:
    selected, _ = client.select(_imap_quote_mailbox(mailbox))
    if selected != "OK":
        return None
    status, data = client.uid(
        "SEARCH", None, "HEADER", "X-Mona-Draft-Request-ID", request_id
    )
    if status != "OK" or not data or not data[0]:
        return None
    uids = re.findall(rb"\d+", data[0] if isinstance(data[0], bytes) else str(data[0]).encode())
    return max((uid.decode("ascii") for uid in uids), key=int, default=None)


def _replace_old_draft(
    client: imaplib.IMAP4,
    mailbox: str,
    old_uid: str,
    delete_strategy: tuple[str, str | None],
) -> None:
    selected, _ = client.select(_imap_quote_mailbox(mailbox))
    if selected != "OK":
        raise RuntimeError("无法选择原草稿文件夹")
    strategy, target = delete_strategy
    if strategy == "move" and target:
        status, _ = client.uid("MOVE", old_uid, _imap_quote_mailbox(target))
        if status != "OK":
            raise RuntimeError("新草稿已保存，但原草稿未能移入回收站")
        return

    status, _ = client.uid("STORE", old_uid, "+FLAGS.SILENT", "(\\Deleted)")
    if status != "OK":
        raise RuntimeError("新草稿已保存，但原草稿标记删除失败")
    status, _ = client.uid("EXPUNGE", old_uid)
    if status != "OK":
        try:
            client.uid("STORE", old_uid, "-FLAGS.SILENT", "(\\Deleted)")
        except Exception as exc:
            logger.warning("恢复原草稿删除标志失败: {}", exc)
        raise RuntimeError("新草稿已保存，但原草稿未能安全替换")


def _imap_save_draft(body: dict[str, Any]) -> dict[str, str]:
    """将草稿追加到 IMAP Drafts，并在可安全定位时替换原 UID。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    _validate_mail_host(imap_host)

    request_id = str(body.get("draftRequestId", "") or "").strip() or uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", request_id):
        raise ValueError("草稿请求标识无效")
    body["draftRequestId"] = request_id
    draft_uid = str(body.get("draftUid", "") or "").strip()
    draft_folder = str(body.get("draftFolder", "") or "").strip()
    if draft_uid and (not draft_folder or not re.fullmatch(r"[1-9]\d{0,19}", draft_uid)):
        raise ValueError("原草稿 UID 或文件夹无效")

    raw_bytes = _build_draft_message(body, request_id).as_bytes()
    fixed_candidates = ["Drafts", "Draft", "草稿", "已发送草稿"]
    trash_candidates = ["Trash", "Deleted Messages", "已删除", "Deleted", "Deleted Items", "废纸篓"]

    def op(client: imaplib.IMAP4) -> dict[str, str]:
        candidates = [draft_folder] if draft_folder else list(fixed_candidates)
        if not draft_folder:
            try:
                list_status, folders = client.list()
                if list_status == "OK":
                    for item in folders or []:
                        line = item.decode("utf-8", errors="ignore") if isinstance(item, bytes) else str(item)
                        if "draft" in line.lower() or "草稿" in line:
                            name = _extract_mailbox_name_from_list(line)
                            if name and name not in candidates:
                                candidates.append(name)
            except Exception:
                pass

        delete_strategy: tuple[str, str | None] | None = None
        if draft_uid:
            capabilities = {
                cap.decode("ascii", errors="ignore").upper() if isinstance(cap, bytes) else str(cap).upper()
                for cap in getattr(client, "capabilities", ())
            }
            if "UIDPLUS" in capabilities:
                delete_strategy = ("uidplus", None)
            elif "MOVE" in capabilities:
                trash_folder = _find_trash_folder(client, trash_candidates)
                if trash_folder:
                    delete_strategy = ("move", trash_folder)
            if delete_strategy is None:
                raise RuntimeError("当前邮箱服务器不支持安全更新草稿，请改为另存新草稿")

        for mailbox in candidates:
            existing_uid = _find_draft_request_uid(client, mailbox, request_id)
            new_uid = existing_uid
            if not new_uid:
                try:
                    status, data = client.append(
                        _imap_quote_mailbox(mailbox), "(\\Draft)", None, raw_bytes
                    )
                except (imaplib.IMAP4.abort, TimeoutError, ConnectionError, OSError) as exc:
                    raise RuntimeError(
                        "草稿保存结果尚未确认，请刷新草稿箱后再检查"
                    ) from exc
                except imaplib.IMAP4.error:
                    if draft_folder:
                        raise
                    continue
                if status != "OK":
                    if draft_folder:
                        raise RuntimeError("保存草稿失败")
                    continue
                new_uid = _appenduid(data)
                if not new_uid:
                    try:
                        new_uid = _find_draft_request_uid(client, mailbox, request_id)
                    except (imaplib.IMAP4.abort, TimeoutError, ConnectionError, OSError) as exc:
                        raise RuntimeError(
                            "草稿已提交，但保存结果尚未确认；请刷新草稿箱后再检查"
                        ) from exc
                if not new_uid:
                    raise RuntimeError("草稿已提交，但服务器未能确认新 UID；请勿重复另存")

            if draft_uid and new_uid != draft_uid:
                assert draft_folder and delete_strategy is not None
                _replace_old_draft(client, draft_folder, draft_uid, delete_strategy)
            return {"draftUid": new_uid, "draftFolder": mailbox}

        raise RuntimeError("未找到可用的 Drafts 文件夹，请确认邮箱已创建草稿箱")

    return imap_pool_manager.run(body, op, retry_on_disconnect=False)


async def handle_email_save_draft(request: web.Request) -> web.Response:
    """POST /email/save_draft - 保存草稿到 IMAP Drafts 文件夹。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_save_draft, max_retries=0)
        return web.json_response({"status": "ok", **result})
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


def _skill_owner_agent_id(value: Any) -> str:
    from mona.agent.partners import normalize_agent_id

    return normalize_agent_id(str(value or ""))


async def handle_skills_list(request: web.Request) -> web.Response:
    """GET /api/skills/list - 列出所有 skill（active + archived）及使用统计。

    返回：{ skills: [{ name, provenance, location, access_count,
                      last_accessed_at, created_at, pinned, archived_at }] }
    """
    from mona.agent import skill_usage

    try:
        agent_id = _skill_owner_agent_id(request.query.get("agentId"))
        rows = [
            {**row, "ownerAgentId": agent_id}
            for row in skill_usage.usage_report(agent_id)
        ]
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
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
    try:
        agent_id = _skill_owner_agent_id(body.get("agentId"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    pinned = bool(body.get("pinned", False))
    if not name or not agent_id:
        return web.json_response({"error": "agentId and name are required"}, status=400)
    try:
        skill_usage.set_pinned(name, pinned, agent_id)
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
    try:
        agent_id = _skill_owner_agent_id(body.get("agentId"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not name or not agent_id:
        return web.json_response({"error": "agentId and name are required"}, status=400)
    try:
        ok, msg = skill_usage.archive_skill(name, automatic=False, agent_id=agent_id)
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
    try:
        agent_id = _skill_owner_agent_id(body.get("agentId"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not name or not agent_id:
        return web.json_response({"error": "agentId and name are required"}, status=400)
    try:
        ok, msg = skill_usage.restore_skill(name, agent_id)
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
    try:
        agent_id = _skill_owner_agent_id(body.get("agentId"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
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
        from mona.agent.user_config import load_agent_user_config
        disabled = set(load_agent_user_config(agent_id).disabled_skills)
    except Exception:
        pass

    try:
        candidates = skill_usage.plan_automatic_archives(
            archive_after_days=days,
            disabled_skills=disabled,
            agent_id=agent_id,
        )
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=500)

    archived: list[dict[str, Any]] = []
    if apply:
        for name in candidates:
            ok, msg = skill_usage.archive_skill(name, automatic=True, agent_id=agent_id)
            archived.append({"name": name, "ok": ok, "message": msg})

    return web.json_response({
        "candidates": candidates,
        "archived": archived,
        "applied": apply,
        "days": days,
    })


async def handle_skills_config(request: web.Request) -> web.Response:
    """GET /api/skills/config - 读取 skill 生命周期配置。

    返回所有 Agent 共用的策略；技能数据本身始终按 Agent 隔离。
    """
    from mona.config.loader import load_config

    try:
        config = load_config()
        dream = config.agents.defaults.dream
    except Exception:
        dream = None

    skill_prune_enabled = bool(getattr(dream, "skill_prune_enabled", False))
    archive_after_days = int(getattr(dream, "archive_after_days", 90))
    max_active = int(getattr(dream, "max_active_user_skills", 100))

    return web.json_response({
        "skillPruneEnabled": skill_prune_enabled,
        "archiveAfterDays": archive_after_days,
        "maxActiveUserSkills": max_active,
        "dreamSchedule": dream.describe_schedule() if dream is not None else "every 2h",
        "scope": "per_agent",
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


async def _automation_settings(*, retries: int = 0) -> dict[str, bool]:
    from mona.agent.tools.tauri_ipc import tauri_invoke_async

    for attempt in range(retries + 1):
        try:
            raw = await tauri_invoke_async("get_automation_settings")
            if isinstance(raw, dict):
                return {
                    "browserAutomationEnabled": raw.get("browserAutomationEnabled", True)
                    is True,
                    "computerUseEnabled": raw.get("computerUseEnabled", False) is True,
                }
        except Exception:
            pass
        if attempt < retries:
            await asyncio.sleep(0.25)
    return {"browserAutomationEnabled": True, "computerUseEnabled": False}


async def _set_automation_settings(**updates: bool) -> dict[str, bool]:
    from mona.agent.tools.tauri_ipc import tauri_invoke_async

    raw = await tauri_invoke_async("set_automation_settings", updates)
    if not isinstance(raw, dict):
        raise RuntimeError("Desktop settings service returned an invalid response")
    return {
        "browserAutomationEnabled": raw.get("browserAutomationEnabled", True) is True,
        "computerUseEnabled": raw.get("computerUseEnabled", False) is True,
    }


def _computer_use_permission_enabled(agent_id: str = "mona") -> bool:
    from mona.agent.user_config import load_agent_user_config
    from mona.computer_use.runtime import COMPUTER_PERMISSION_TOOL_NAMES

    granted = load_agent_user_config(agent_id).granted_tools
    return granted is not None and set(COMPUTER_PERMISSION_TOOL_NAMES) <= set(granted)


def _browser_automation_permission_enabled() -> bool:
    from mona.agent.tools.browser import BROWSER_PERMISSION_TOOL_NAMES
    from mona.agent.user_config import load_agent_user_config

    granted = load_agent_user_config("mona").granted_tools
    return granted is None or set(BROWSER_PERMISSION_TOOL_NAMES) <= set(granted)


async def _migrate_legacy_automation_permissions(app: web.Application) -> None:
    from mona.agent.tools.browser import (
        BROWSER_LEGACY_TOOL_NAMES,
        BROWSER_PERMISSION_TOOL_NAMES,
    )
    from mona.agent.user_config import load_agent_user_config, save_agent_user_config
    from mona.computer_use.runtime import (
        COMPUTER_PERMISSION_TOOL_NAMES,
        LEGACY_COMPUTER_PERMISSION_TOOL_NAMES,
    )

    settings = await _automation_settings(retries=20)
    legacy_browser_disabled = not settings["browserAutomationEnabled"]
    legacy_computer_enabled = settings["computerUseEnabled"]
    config = load_agent_user_config("mona")
    if config.granted_tools is None:
        if not legacy_browser_disabled and not legacy_computer_enabled:
            return
        agent_loop = app.get("agent_loop")
        current = list(agent_loop.tools.tool_names) if agent_loop is not None else []
    else:
        current = list(config.granted_tools)

    current_set = set(current)
    browser_observe_legacy = {
        "browser_list_tabs",
        "browser_read",
        "browser_snapshot",
        "browser_screenshot",
    }
    browser_action_legacy = set(BROWSER_LEGACY_TOOL_NAMES) - browser_observe_legacy
    if current_set & browser_observe_legacy:
        current.append("browser_observe")
    if current_set & browser_action_legacy:
        current.append("browser_act")
    if current_set & set(LEGACY_COMPUTER_PERMISSION_TOOL_NAMES):
        current.extend(COMPUTER_PERMISSION_TOOL_NAMES)
    current = [
        name
        for name in dict.fromkeys(current)
        if name not in set(BROWSER_LEGACY_TOOL_NAMES) - {"browser_act"}
        and name not in LEGACY_COMPUTER_PERMISSION_TOOL_NAMES
    ]
    if legacy_browser_disabled:
        current = [name for name in current if name not in BROWSER_PERMISSION_TOOL_NAMES]
    if legacy_computer_enabled:
        current = list(dict.fromkeys([*current, *COMPUTER_PERMISSION_TOOL_NAMES]))

    if current != config.granted_tools:
        save_agent_user_config(
            "mona",
            {"granted_tools": current},
            expected_revision=config.revision,
        )
        agent_loop = app.get("agent_loop")
        if agent_loop is not None:
            agent_loop._refresh_mona_user_config()
    if legacy_browser_disabled or legacy_computer_enabled:
        try:
            await _set_automation_settings(
                browserAutomationEnabled=True,
                computerUseEnabled=False,
            )
        except Exception as exc:
            logger.warning("Failed to neutralize legacy automation switches: {}", exc)


async def _ensure_computer_use_server(app: web.Application) -> dict[str, Any]:
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME
    from mona.computer_use.runtime import get_cua_driver_manager

    agent_loop = app.get("agent_loop")
    if agent_loop is None:
        raise RuntimeError("Agent loop not ready")
    manager = get_cua_driver_manager()
    if BUILTIN_COMPUTER_SERVER_NAME in agent_loop._mcp_servers:
        if BUILTIN_COMPUTER_SERVER_NAME in agent_loop._mcp_stacks:
            manager.set_connection_result(None)
            return {"ok": True, "connected": True}
        result = await agent_loop.restart_mcp_server(BUILTIN_COMPUTER_SERVER_NAME)
    else:
        result = await agent_loop.add_mcp_server(
            BUILTIN_COMPUTER_SERVER_NAME,
            manager.mcp_config(),
        )
    manager.set_connection_result(
        None if result.get("ok") else str(result.get("error") or "MCP connection failed")
    )
    return result


async def _remove_computer_use_server(app: web.Application) -> None:
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    agent_loop = app.get("agent_loop")
    if agent_loop is not None and BUILTIN_COMPUTER_SERVER_NAME in agent_loop._mcp_servers:
        await agent_loop.remove_mcp_server(BUILTIN_COMPUTER_SERVER_NAME)


async def _activate_computer_use_when_ready(app: web.Application) -> None:
    from mona.computer_use.runtime import get_cua_driver_manager

    manager = get_cua_driver_manager()
    status = await manager.wait_install()
    if _computer_use_permission_enabled() and status.get("state") == "available":
        result = await _ensure_computer_use_server(app)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or "Computer Use MCP connection failed"))


def _start_computer_activation_watch(app: web.Application) -> None:
    existing = app.get("computer_use_activation_task")
    if isinstance(existing, asyncio.Task) and not existing.done():
        return
    task = asyncio.create_task(_activate_computer_use_when_ready(app))
    app["computer_use_activation_task"] = task

    def _done(completed: asyncio.Task[None]) -> None:
        try:
            completed.result()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Computer Use activation failed")

    task.add_done_callback(_done)


async def handle_automation_status(request: web.Request) -> web.Response:
    from mona.agent.partners import normalize_agent_id
    from mona.computer_use.runtime import get_cua_driver_manager

    try:
        agent_id = normalize_agent_id(request.query.get("agent_id", "mona"))
    except ValueError:
        return web.json_response({"error": "invalid agent_id"}, status=400)
    computer_enabled = _computer_use_permission_enabled(agent_id)
    manager = get_cua_driver_manager()
    initial_status = manager.status(enabled=computer_enabled)
    if computer_enabled and initial_status.get("supported"):
        if manager.executable is None:
            await manager.start_install()
            _start_computer_activation_watch(request.app)
        else:
            manager.set_connection_result(None)
            computer_status = await manager.refresh_health()
            if agent_id == "mona" and computer_status.get("state") == "available":
                await _ensure_computer_use_server(request.app)
    elif agent_id == "mona" and not computer_enabled:
        await _remove_computer_use_server(request.app)
    return web.json_response(
        {
            "browserAutomationEnabled": _browser_automation_permission_enabled(),
            "computerUse": manager.status(enabled=computer_enabled),
        }
    )


async def handle_computer_use_update(request: web.Request) -> web.Response:
    from mona.computer_use.runtime import get_cua_driver_manager

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        return web.json_response({"error": "enabled must be boolean"}, status=400)
    manager = get_cua_driver_manager()
    permission_enabled = _computer_use_permission_enabled()
    if enabled != permission_enabled:
        return web.json_response(
            {"error": "Update the Mona Agent tool permission first"}, status=409
        )
    if enabled and not manager.status(enabled=True).get("supported"):
        return web.json_response(
            {"error": "Computer Use is not available for this device"}, status=400
        )
    if not enabled:
        await _remove_computer_use_server(request.app)
        return web.json_response(manager.status(enabled=False))
    try:
        if manager.executable is None:
            await manager.start_install()
            _start_computer_activation_watch(request.app)
        else:
            manager.set_connection_result(None)
            computer_status = await manager.refresh_health(force=True)
            if computer_status.get("state") == "available":
                result = await _ensure_computer_use_server(request.app)
                if not result.get("ok"):
                    raise RuntimeError(
                        str(result.get("error") or "Computer Use MCP connection failed")
                    )
        return web.json_response(manager.status(enabled=True), status=202 if manager.executable is None else 200)
    except Exception as exc:
        logger.exception("Failed to enable Computer Use")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_computer_use_cancel(request: web.Request) -> web.Response:
    from mona.computer_use.runtime import get_cua_driver_manager

    manager = get_cua_driver_manager()
    try:
        await manager.cancel_install()
        await _remove_computer_use_server(request.app)
        return web.json_response(
            manager.status(enabled=_computer_use_permission_enabled())
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=409)


async def handle_computer_use_permissions(request: web.Request) -> web.Response:
    from mona.computer_use.runtime import get_cua_driver_manager

    try:
        manager = get_cua_driver_manager()
        manager.set_connection_result(None)
        status = await manager.grant_permissions()
        if _computer_use_permission_enabled() and status.get("state") == "available":
            await _ensure_computer_use_server(request.app)
        return web.json_response(status)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def _computer_use_startup(app: web.Application) -> None:
    from mona.computer_use.runtime import get_cua_driver_manager

    await _migrate_legacy_automation_permissions(app)
    if not _computer_use_permission_enabled():
        return
    manager = get_cua_driver_manager()
    if not manager.status(enabled=True).get("supported"):
        return
    if manager.executable is None:
        await manager.start_install()
        _start_computer_activation_watch(app)
        return
    manager.set_connection_result(None)
    computer_status = await manager.refresh_health(force=True)
    if computer_status.get("state") == "available":
        result = await _ensure_computer_use_server(app)
        if not result.get("ok"):
            logger.warning("Computer Use startup connection failed: {}", result.get("error"))


async def _schedule_computer_use_startup(app: web.Application) -> None:
    async def run() -> None:
        try:
            await _computer_use_startup(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Computer Use background startup failed")

    app["computer_use_startup_task"] = asyncio.create_task(run())


async def _cancel_computer_use_startup(app: web.Application) -> None:
    task = app.get("computer_use_startup_task")
    if isinstance(task, asyncio.Task) and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def handle_mcp_list_servers(request: web.Request) -> web.Response:
    """GET /api/mcp/servers - list configured servers with runtime status + masked config."""
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    agent_loop = request.app.get("agent_loop")
    if agent_loop is None:
        return web.json_response({"error": "Agent loop not ready"}, status=503)

    try:
        statuses = agent_loop.get_mcp_status()
        # Attach masked config for each server
        out: list[dict[str, Any]] = []
        for row in statuses:
            if row["name"] == BUILTIN_COMPUTER_SERVER_NAME:
                continue
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
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME
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
    if name == BUILTIN_COMPUTER_SERVER_NAME:
        return web.json_response({"error": "reserved server name"}, status=400)
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
    imap_pool_manager.run(body, op, retry_on_disconnect=False)
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
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError("Mailbox select failed while updating flags")
        known_validity = str(body.get("uidValidity") or "")
        if known_validity and _imap_uid_validity(client) != known_validity:
            raise RuntimeError("UIDVALIDITY changed while updating flags")
        status, _ = client.uid("STORE", uid, op + ".SILENT", f"({flag})")
        if status != "OK":
            raise RuntimeError("Mailbox flag update was rejected")

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
        return web.json_response({"error": str(e), "uidValidityChanged": "UIDVALIDITY changed" in str(e)}, status=500)


def _imap_mark_all_read(body: dict[str, Any]) -> int:
    """连接 IMAP 并将指定文件夹中所有邮件标记为已读。复用持久连接池。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    def op(client: imaplib.IMAP4) -> int:
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")
        # 搜索所有未读邮件
        typ, data = client.uid("SEARCH", "UNSEEN")
        if typ != "OK":
            raise RuntimeError(f"Searching unseen message UIDs failed: {typ}")
        if not data or not data[0]:
            return 0
        uids = data[0].split()
        if not uids:
            return 0
        # 分批 STORE，避免超长 UID 集合被服务器拒绝。
        for start in range(0, len(uids), 200):
            uid_set = b",".join(uids[start : start + 200]).decode()
            status, _ = client.uid("STORE", uid_set, "+FLAGS", "(\\Seen)")
            if status != "OK":
                raise RuntimeError(f"Marking unseen messages read failed: {status}")
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

    return imap_pool_manager.run(body, op, retry_on_disconnect=False)


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
    return imap_pool_manager.run(body, op, retry_on_disconnect=False)


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

    from mona.email_intel.db import get_account_identity, get_message
    from mona.email_intel.schedule_extract import process_email_for_schedule

    identity = get_account_identity(account_id)
    if identity is None:
        return web.json_response({"error": "邮件账号不存在"}, status=404)
    tz = getattr(config, "timezone", None) or "Asia/Shanghai"
    now_iso = datetime.now().astimezone().isoformat()
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
                user_address=identity["address"],
                user_name=identity["name"],
                to_addresses=msg.get("toAddresses") or "",
                cc_addresses=msg.get("ccAddresses") or "",
                todo_svc=request.app.get("todo_service"),
                message_id=msg.get("messageId"),
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
                        user_address=identity["address"],
                        user_name=identity["name"],
                        to_addresses=msg.get("toAddresses") or "",
                        cc_addresses=msg.get("ccAddresses") or "",
                        todo_svc=request.app.get("todo_service"),
                        message_id=msg.get("messageId"),
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
    from mona.email_intel.db import get_account_identity, get_message
    from mona.email_intel.schedule_extract import process_email_for_schedule

    msg = get_message(uid, account_id, folder)
    if not msg:
        return web.json_response({"error": "邮件不存在"}, status=404)
    identity = get_account_identity(account_id)
    if identity is None:
        return web.json_response({"error": "邮件账号不存在"}, status=404)

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
        now_iso=datetime.now().astimezone().isoformat(),
        tz=tz,
        model=model,
        user_address=identity["address"],
        user_name=identity["name"],
        to_addresses=msg.get("toAddresses") or "",
        cc_addresses=msg.get("ccAddresses") or "",
        todo_svc=request.app.get("todo_service"),
        message_id=msg.get("messageId"),
    )

    return web.json_response({"result": result})


def _imap_fetch_attachment(body: dict[str, Any]) -> dict[str, Any]:
    """连接 IMAP，优先按 Content-ID、再按 filename 提取附件并返回 base64。"""

    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_username = str(body.get("imapUsername", "") or "").strip()
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    filename = str(body.get("filename", "") or "").strip()
    content_id = str(body.get("contentId", "") or "").strip().strip("<>").strip()

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    _validate_mail_host(imap_host)

    if not uid:
        raise ValueError("uid is required")
    if not filename and not content_id:
        raise ValueError("filename or contentId is required")

    def op(client: imaplib.IMAP4) -> dict[str, Any]:
        status, _ = client.select(_imap_quote_mailbox(mailbox), readonly=True)
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

        parts = list(parsed.walk())
        selected_part = None
        if content_id:
            normalized_content_id = content_id.casefold()
            selected_part = next(
                (
                    part
                    for part in parts
                    if (part_content_id := str(part.get("Content-ID", "") or "")
                        .strip()
                        .strip("<>")
                        .strip())
                    and part_content_id.casefold() == normalized_content_id
                ),
                None,
            )

        # CID 未命中时按旧协议回退 filename，兼容历史调用和邮件格式差异。
        if selected_part is None and filename:
            for part in parts:
                if part.get_content_disposition() != "attachment":
                    continue
                part_filename = part.get_filename() or ""
                try:
                    part_filename = str(make_header(decode_header(part_filename)))
                except Exception:
                    pass
                if part_filename == filename:
                    selected_part = part
                    break

        if selected_part is None:
            raise RuntimeError(f"未找到附件: {content_id or filename}")

        part = selected_part
        part_filename = part.get_filename() or filename or "未命名附件"
        try:
            part_filename = str(make_header(decode_header(part_filename)))
        except Exception:
            pass
        payload = part.get_payload(decode=True)
        if payload is None:
            raise RuntimeError(f"附件 {part_filename} 内容为空")
        return {
            "filename": part_filename,
            "contentType": part.get_content_type() or "application/octet-stream",
            "size": len(payload),
            "data": base64.b64encode(payload).decode("ascii"),
        }

    return imap_pool_manager.run(body, op, background=bool(body.get("background")))


async def handle_email_fetch_attachment(request: web.Request) -> web.Response:
    """POST /email/fetch_attachment - 下载指定附件，返回 base64 编码内容。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        result = await _run_imap_locked(body, _imap_fetch_attachment, max_retries=0)
        return web.json_response(result)
    except ImapOperationDeferred:
        return web.json_response({"deferred": True}, status=409)
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
        started = time.monotonic()
        status, _ = client.select(_imap_quote_mailbox(mailbox), readonly=True)
        selected = time.monotonic()
        if status != "OK":
            raise RuntimeError(f"select {mailbox} failed: {status}")

        status, fetched = client.uid("FETCH", uid, "(BODY.PEEK[] UID)")
        fetched_at = time.monotonic()
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
        result: dict[str, Any] = {
            "bodyText": body_text,
            "bodyHtml": body_html,
            "hasAttachments": _email_has_attachments(parsed),
            "attachments": _email_extract_attachments(parsed),
        }
        if include_raw:
            # Foxmail 风格：返回完整 RFC822 字节（base64），供 Rust 侧落盘为 .eml 文件
            result["rawBytes"] = base64.b64encode(raw_bytes).decode("ascii")
        finished = time.monotonic()
        if finished - started >= 5:
            logger.warning(
                "[imap] body phases: select={:.1f}s fetch={:.1f}s decode={:.1f}s bytes={}",
                selected - started, fetched_at - selected, finished - fetched_at, len(raw_bytes),
            )
        return result

    return imap_pool_manager.run(body, op, background=bool(body.get("background")))


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
        # fetch_body 是用户主动点击邮件时的按需操作，只保留连接池内的一次重连重试。
        # 避免外层重复请求；失败时快速返回错误，前端可手动重试。
        result = await _run_imap_locked(body, _imap_fetch_body, max_retries=0)
        return web.json_response(result)
    except ImapOperationDeferred:
        return web.json_response({"deferred": True}, status=409)
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
        status, _ = client.select(_imap_quote_mailbox(mailbox), readonly=True)
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

    return imap_pool_manager.run(body, op, background=bool(body.get("background")))


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
        result = await _run_imap_locked(body, _imap_fetch_raw, max_retries=0)
        return web.json_response(result)
    except ImapOperationDeferred:
        return web.json_response({"deferred": True}, status=409)
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


async def handle_schedule_notification_push(request: web.Request) -> web.Response:
    """POST /api/schedule/notifications/push - enqueue a system notification.

    Cross-process producers (stock-module review cron in the gateway, T20)
    push onto the same queue the Tauri side polls, so their notifications
    get the identical native window. Optional ``click_action``/``click_data``
    route the click (e.g. ``open-stock`` with ``{"runId": …}``).
    """
    svc = _require_schedule_service(request)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    title = str(body.get("title", "") or "").strip()
    text = str(body.get("body", "") or "").strip()
    if not title or not text:
        return web.json_response({"error": "title and body are required"}, status=400)
    click_action = body.get("click_action")
    click_data = body.get("click_data")
    svc.push_notification(
        title,
        text,
        click_action=str(click_action) if click_action else None,
        click_data=click_data if isinstance(click_data, dict) else None,
    )
    return web.json_response({"status": "ok"})


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
        # createdAtMs/updatedAtMs are server-generated; default to 0 so
        # TodoItem.from_dict doesn't KeyError when clients omit them.
        # add_item fills 0 with the current time.
        body.setdefault("createdAtMs", 0)
        body.setdefault("updatedAtMs", 0)
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


def _svg_mtime(project_dir: Path, file_name: str) -> float | None:
    """Return mtime of svg_output/<file_name>, or None if missing."""
    svg_path = project_dir / "svg_output" / file_name
    if not svg_path.is_file():
        return None
    return svg_path.stat().st_mtime


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


















# ---------------------------------------------------------------------------
# Video project routes (/api/video/*)
# ---------------------------------------------------------------------------


def _video_projects_dir() -> Path:
    return get_workspace_path() / "video_projects"


def _video_archived_projects_dir() -> Path:
    return get_workspace_path() / "video_projects_archived"


VIDEO_LANGUAGE_PRESETS: dict[str, dict[str, str]] = {
    "zh-CN": {"label": "简体中文", "edgeVoice": "zh-CN-XiaoyiNeural"},
    "zh-TW": {"label": "繁体中文", "edgeVoice": "zh-TW-HsiaoChenNeural"},
    "en-US": {"label": "English", "edgeVoice": "en-US-JennyNeural"},
    "ja-JP": {"label": "日本語", "edgeVoice": "ja-JP-NanamiNeural"},
    "ko-KR": {"label": "한국어", "edgeVoice": "ko-KR-SunHiNeural"},
    "es-ES": {"label": "Español", "edgeVoice": "es-ES-ElviraNeural"},
    "fr-FR": {"label": "Français", "edgeVoice": "fr-FR-DeniseNeural"},
    "de-DE": {"label": "Deutsch", "edgeVoice": "de-DE-KatjaNeural"},
}


def _normalize_video_meta(project_dir: Path, meta: dict) -> dict:
    """Normalize video project meta.json by inferring missing fields from disk state.

    Only fills missing fields; never overwrites existing values.
    """
    result = dict(meta)
    result.setdefault("language", "zh-CN")
    result.setdefault("localeGroupId", project_dir.name)
    result.setdefault("requirePlanApproval", False)
    result.setdefault("planRevision", 0)
    result.setdefault("approvedPlanRevision", None)
    # Ensure resolution is always a string ("WxH" format).
    # Old projects or AI-written meta may store it as a list [w, h] or
    # dict {"width": w, "height": h}, which crashes the frontend.
    res = result.get("resolution")
    if not isinstance(res, str):
        if isinstance(res, (list, tuple)) and len(res) == 2:
            result["resolution"] = f"{res[0]}x{res[1]}"
        elif isinstance(res, dict) and "width" in res and "height" in res:
            result["resolution"] = f"{res['width']}x{res['height']}"
        else:
            result["resolution"] = "1920x1080"
    output_mp4 = project_dir / "renders" / "output.mp4"
    has_render = output_mp4.is_file()
    # phase
    if "phase" not in result:
        render_status_file = project_dir / ".render_status.json"
        render_running = False
        if render_status_file.is_file():
            try:
                rs = _json.loads(render_status_file.read_text(encoding="utf-8"))
                render_running = rs.get("stage") == "rendering"
            except Exception:
                pass
        scenes = result.get("scenes") or []
        scenes_dir = project_dir / "scenes"
        has_scene_html = scenes_dir.is_dir() and any(scenes_dir.glob("scene_*.html"))
        if has_render and not result.get("outputStale"):
            result["phase"] = "done"
        elif render_running:
            result["phase"] = "rendering"
        elif scenes and all(
            _video_scene_ready(project_dir, s) for s in scenes
        ):
            result["phase"] = "exportable"
        elif result.get("storyboardLocked") or scenes or has_scene_html:
            result["phase"] = "producing"
        else:
            result["phase"] = "storyboard"
    # outputStale — old projects have no staleness info; trust existing output.
    if "outputStale" not in result:
        result["outputStale"] = False
    # hasVideo
    if "hasVideo" not in result:
        result["hasVideo"] = has_render
    if result["requirePlanApproval"] and result.get("approvedPlanRevision") != result["planRevision"]:
        result["phase"] = "storyboard"
    return result


def _get_video_project_status(project_dir: Path) -> dict:
    """Inspect a video project directory and return its status."""
    output_mp4 = project_dir / "renders" / "output.mp4"
    storyboard = project_dir / "storyboard.md"
    index_html = project_dir / "index.html"
    scenes_dir = project_dir / "scenes"
    scene_count = (
        len(list(scenes_dir.glob("scene_*.html"))) if scenes_dir.is_dir() else 0
    )
    has_render = output_mp4.is_file()

    meta = _normalize_video_meta(project_dir, _load_video_meta(project_dir))
    from mona.video_project import workbench_state

    planned = meta.get("scenes") or []
    workbench = workbench_state(meta,
                               {int(scene["index"]) for scene in planned if _video_scene_ready(project_dir, scene)},
                               {int(scene["index"]) for scene in planned if scene.get("audioInputHash") and (project_dir / "audio" / f"scene_{int(scene['index']):02d}.mp3").is_file()})

    latest_style_version = None
    if meta.get("seriesId"):
        try:
            series = get_video_series(get_workspace_path(), str(meta["seriesId"]))
            latest_style_version = int(series.get("latestStyleVersion") or 0) or None
        except VideoStyleError:
            pass

    style_authoring = meta.get("styleAuthoring")
    if isinstance(style_authoring, dict):
        style_authoring = dict(style_authoring)
        try:
            style_authoring["name"] = get_video_series(get_workspace_path(), str(style_authoring.get("seriesId") or ""))["name"]
            style_authoring["available"] = True
        except VideoStyleError:
            style_authoring["name"] = "自定义风格"
            style_authoring["available"] = False

    return {
        "status": meta.get("phase", "storyboard"),
        "phase": meta.get("phase", "storyboard"),
        "resolution": meta.get("resolution", "1920x1080"),
        "hasVideo": meta.get("hasVideo", has_render),
        "outputStale": meta.get("outputStale", False),
        "sceneCount": scene_count,
        "draftSceneCount": sum(path.is_file() for path in (project_dir / "drafts").glob("scene_*.*") if path.suffix in {".html", ".tsx"}),
        "workbench": workbench,
        "hasStoryboard": storyboard.exists(),
        "hasIndex": index_html.exists(),
        "seriesId": meta.get("seriesId"),
        "seriesName": meta.get("seriesName"),
        "styleVersion": meta.get("styleVersion"),
        "latestSeriesStyleVersion": latest_style_version,
        "styleUpdateAvailable": bool(
            latest_style_version
            and int(meta.get("styleVersion") or 0) < latest_style_version
        ),
        "aspectVariant": meta.get("aspectVariant"),
        "episodeNumber": meta.get("episodeNumber"),
        "backgroundBindings": meta.get("backgroundBindings") or {},
        "language": meta.get("language", "zh-CN"),
        "localeGroupId": meta.get("localeGroupId", project_dir.name),
        "sourceProject": meta.get("sourceProject"),
        "styleAuthoring": style_authoring,
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
        source = await Url2NoteExtractor().extract(url, include_keyframes=True)
        return web.json_response(
            {
                "title": source.title,
                "url": source.url,
                "kind": source.kind,
                "text": source.text,
                "frames": [
                    {
                        "timestamp": frame.timestamp,
                        "fileName": frame.file_name,
                        "dataBase64": frame.data_base64,
                    }
                    for frame in source.frames
                ],
            }
        )
    except Url2NoteError as exc:
        return web.json_response({"error": str(exc)}, status=422)
    except Exception:
        logger.exception("url2note extraction error")
        return web.json_response({"error": "URL extraction failed"}, status=500)


async def handle_note_generate(request: web.Request) -> web.Response:
    """POST /api/notes/generate - generate Markdown without Agent tools."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    prompt = str(body.get("prompt") or "").strip() if isinstance(body, dict) else ""
    if not prompt:
        return web.json_response({"error": "prompt is required"}, status=400)

    provider = _resolve_llm_provider(request)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)
    agent_loop = request.app.get("agent_loop")
    model = getattr(agent_loop, "model", None) or provider.get_default_model()
    try:
        response = await asyncio.wait_for(
            provider.chat_with_retry(
                messages=[{"role": "user", "content": prompt}],
                model=model,
                temperature=0.2,
            ),
            timeout=float(request.app.get("request_timeout", 120.0)),
        )
        content = _response_text(response).strip()
        if not content:
            return web.json_response({"error": "AI 未返回笔记内容"}, status=502)
        return web.json_response({"content": content})
    except TimeoutError:
        return web.json_response({"error": "AI 生成超时"}, status=504)
    except Exception:
        logger.exception("note generation error")
        return web.json_response({"error": "AI 生成笔记失败"}, status=500)


async def handle_doc2note_status(request: web.Request) -> web.Response:
    """GET /api/doc2note/status - supported formats + pandoc availability.

    The frontend calls this before importing an Office document; when
    ``pandoc.ok`` is false it shows the first-download confirmation dialog
    (``pandocDownloadMb`` is the approximate zip size shown in that dialog).
    """
    try:
        from mona.api.doc2note import SUPPORTED_EXTENSIONS
        from mona.api.pandoc_runtime import PANDOC_DOWNLOAD_MB, PandocRuntime

        return web.json_response(
            {
                "supportedExtensions": SUPPORTED_EXTENSIONS,
                "pandoc": PandocRuntime().check(),
                "pandocDownloadMb": PANDOC_DOWNLOAD_MB,
            }
        )
    except Exception as e:
        logger.exception("doc2note status error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_doc2note_runtime_download(request: web.Request) -> web.Response:
    """POST /api/doc2note/runtime-download - download the Pandoc binary."""
    try:
        from mona.api.pandoc_runtime import PandocRuntime

        result = await PandocRuntime().ensure()
        return web.json_response(result, status=200 if result.get("ok") else 500)
    except Exception as e:
        logger.exception("doc2note runtime-download error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_doc2note_extract(request: web.Request) -> web.Response:
    """POST /api/doc2note/extract - parse a local document into text for a note."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    file_path = str(body.get("file_path") or "").strip() if isinstance(body, dict) else ""
    if not file_path:
        return web.json_response({"error": "file_path is required"}, status=400)
    try:
        from mona.api.doc2note import Doc2NoteError, PandocMissingError, extract_document

        source = await extract_document(file_path)
        return web.json_response(
            {"title": source.title, "kind": source.kind, "text": source.text}
        )
    except PandocMissingError as exc:
        return web.json_response(
            {"error": str(exc), "code": "PANDOC_MISSING"}, status=409
        )
    except Doc2NoteError as exc:
        return web.json_response({"error": str(exc)}, status=422)
    except Exception:
        logger.exception("doc2note extraction error")
        return web.json_response({"error": "文档解析失败"}, status=500)


async def handle_video_runtime_download(request: web.Request) -> web.Response:
    """POST /api/video/runtime-download  body: {"component": "node|ffmpeg"}."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.api.video_runtime import VideoRuntime

        component = str(body.get("component", "") or "").strip()
        if component not in {"node", "ffmpeg"}:
            return web.json_response(
                {"error": "component must be node or ffmpeg"}, status=400
            )
        result = await VideoRuntime().ensure_runtime(component)
        return web.json_response(result)
    except Exception as e:
        logger.exception("video runtime-download error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_office_health(request: web.Request) -> web.Response:
    """GET /api/office/health - detect OfficeCLI availability and version.

    Retained for old tasks that may still use an already-installed binary.
    New OfficeCLI downloads are no longer available.
    """
    try:
        from mona.api.officecli_runtime import OfficeCliRuntime

        result = OfficeCliRuntime().check()
        return web.json_response(result)
    except Exception as e:
        logger.exception("office health error")
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_office_runtime_download(request: web.Request) -> web.Response:
    """Keep the legacy route stable without distributing OfficeCLI."""
    return web.json_response(
        {
            "ok": False,
            "code": "OFFICECLI_REMOVED",
            "error": "旧 OfficeCLI 能力已停止分发",
        },
        status=410,
    )


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
        include_archived = str(request.query.get("includeArchived") or "").lower() in {
            "1",
            "true",
            "yes",
        }
        projects = []
        directories = [(_video_projects_dir(), False)]
        if include_archived:
            directories.append((_video_archived_projects_dir(), True))
        for projects_dir, archived in directories:
            if not projects_dir.is_dir():
                continue
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
                    "archived": archived,
                    **status_info,
                })
        return web.json_response({"projects": projects})
    except Exception as e:
        logger.exception("video projects error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_create(
    request: web.Request, *, _agent_context: Mapping[str, Any] | None = None
) -> web.Response:
    """POST /api/video/project/create  body: {"name", "resolution",
    optional "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate"}.
    """
    created_project_dir: Path | None = None
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return web.json_response({"error": "invalid project name"}, status=400)
        resolution = str(body.get("resolution") or "1920x1080")
        resolution = {"landscape": "1920x1080", "portrait": "1080x1920", "square": "1080x1080"}.get(resolution, resolution)
        if resolution not in {"1920x1080", "1080x1920", "1080x1080"}:
            return web.json_response({"error": "请选择横屏、竖屏或方形画面"}, status=400)
        language = str(body.get("language") or "zh-CN")
        if language not in VIDEO_LANGUAGE_PRESETS:
            return web.json_response({"error": "unsupported video language"}, status=400)

        # Optional narration/TTS config — defaults to edge TTS when narrationEnabled=true.
        narration_enabled = bool(body.get("narrationEnabled", False))
        tts_provider = str(body.get("ttsProvider", "") or "").strip()
        tts_voice = str(body.get("ttsVoice", "") or "").strip()
        tts_rate = str(body.get("ttsRate", "") or "").strip()
        subtitle_mode = str(body.get("subtitleMode") or "burned").strip()
        if subtitle_mode not in {"burned", "external", "off"}:
            return web.json_response({"error": "invalid subtitle mode"}, status=400)
        music = body.get("music") or {}
        if not isinstance(music, dict):
            return web.json_response({"error": "music must be an object"}, status=400)
        music_preset = str(music.get("preset") or "none").strip()
        if music_preset not in {"none", "ambient", "rhythmic", "brand"}:
            return web.json_response({"error": "invalid music preset"}, status=400)
        music_file_path = str(music.get("filePath") or "").strip()
        if music_preset != "none" and not music_file_path:
            return web.json_response({"error": "music file is required"}, status=400)
        source_paths = body.get("sourcePaths") or []
        if not isinstance(source_paths, list) or len(source_paths) > 10:
            return web.json_response(
                {"error": "sourcePaths must contain at most 10 files"}, status=400
            )
        attached_series_id = str(body.get("seriesId") or "").strip()
        series_id = attached_series_id or str(body.get("styleSeriesId") or "").strip()
        style_preference = "auto" if body.get("templateId", "auto") == "auto" and not series_id else "fixed"
        template_id = str(body.get("templateId") or "auto").strip()
        if template_id == "auto":
            template_id = "huashu-keynote"
        single_style: dict[str, Any] | None = None
        if not series_id:
            from mona.video_style import get_builtin_template

            try:
                single_style = get_builtin_template(template_id)
            except VideoStyleError as exc:
                return web.json_response(exc.to_dict(), status=exc.status_code)
        style_version: int | None = None
        aspect_variant = str(body.get("aspectVariant") or "").strip()
        episode_number = body.get("episodeNumber")
        background_asset_ids = body.get("backgroundBindings") or {}
        series: dict[str, Any] | None = None
        locked_style: dict[str, Any] | None = None
        style_source: Path | None = None
        if series_id:
            try:
                style_version = int(body.get("styleVersion") or 0)
            except (TypeError, ValueError):
                return web.json_response({"error": "invalid style version"}, status=400)
            if style_version < 1:
                return web.json_response({"error": "styleVersion is required"}, status=400)
            try:
                series = get_video_series(get_workspace_path(), series_id)
                if series.get("archived"):
                    return web.json_response({"error": "请先恢复归档系列，再使用此模板创建视频"}, status=409)
                series_id = str(series["id"])
                locked_style = read_style_version(
                    get_workspace_path(), series_id, style_version
                )
            except VideoStyleError as exc:
                return web.json_response(exc.to_dict(), status=exc.status_code)
            aspect_variant = aspect_variant or str(series.get("defaultAspectRatio") or "16:9")
            variant = (locked_style.get("aspectVariants") or {}).get(aspect_variant)
            if not isinstance(variant, dict):
                return web.json_response(
                    {"error": "aspect variant is not enabled"}, status=409
                )
            resolution = {
                "16:9": "1920x1080",
                "9:16": "1080x1920",
                "1:1": "1080x1080",
            }[aspect_variant]
            if not isinstance(background_asset_ids, dict):
                return web.json_response(
                    {"error": "backgroundBindings must be an object"}, status=400
                )
            style_source = (
                video_series_directory(get_workspace_path())
                / series_id
                / "styles"
                / f"v{style_version}"
            )

        project_root = _video_projects_dir().resolve()
        project_dir = (project_root / name).resolve()
        if project_dir == project_root or not project_dir.is_relative_to(project_root):
            return web.json_response({"error": "invalid project path"}, status=400)
        if project_dir.exists():
            return web.json_response(
                {"error": "project already exists"}, status=409
            )
        created_project_dir = project_dir
        # Pre-build the standard directory layout.
        for sub in (
            "scenes",
            "scene_sources",
            "drafts",
            "scene_specs",
            "compositions",
            "assets",
            "sources",
            "renders",
            "audio",
            "output/preview",
        ):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        source_records: list[dict[str, Any]] = []
        for index, raw_path in enumerate(source_paths, start=1):
            source = Path(str(raw_path or "")).resolve()
            if not source.is_file():
                shutil.rmtree(project_dir, ignore_errors=True)
                return web.json_response({"error": "source document not found"}, status=404)
            suffix = source.suffix.lower()
            if suffix not in {".pdf", ".doc", ".docx", ".ppt", ".pptx", ".md", ".txt"}:
                shutil.rmtree(project_dir, ignore_errors=True)
                return web.json_response({"error": "unsupported source document"}, status=422)
            relative = f"sources/source-{index:02d}{suffix}"
            target = project_dir / relative
            shutil.copy2(source, target)
            source_records.append(
                {
                    "id": f"source-{index:02d}",
                    "originalName": source.name,
                    "path": relative,
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "bytes": target.stat().st_size,
                }
            )
        project_backgrounds: dict[str, str] = {}
        project_background_asset_records: list[dict[str, Any]] = []
        project_background_registry_ids: dict[str, str] = {}
        project_style_asset_registry_ids: dict[str, str] = {}
        if series is not None and locked_style is not None and style_source is not None:
            shutil.copytree(style_source, project_dir / "style")
            from mona.video_style_authoring import materialize_style_sample_assets

            materialize_style_sample_assets(project_dir)
            style_backgrounds = locked_style.get("backgrounds") or {}

            def collect_style_asset_ids(value: Any) -> set[str]:
                if isinstance(value, Mapping):
                    collected = {
                        str(value["assetId"])
                        if isinstance(value.get("assetId"), str)
                        else ""
                    }
                    for nested in value.values():
                        collected.update(collect_style_asset_ids(nested))
                    return {item for item in collected if item}
                if isinstance(value, list):
                    collected: set[str] = set()
                    for nested in value:
                        collected.update(collect_style_asset_ids(nested))
                    return collected
                return set()

            for asset_id in sorted(collect_style_asset_ids(style_backgrounds)):
                source = style_source / "assets" / f"{asset_id}.webp"
                if not source.is_file():
                    continue
                metadata_path = style_source / "assets" / f"{asset_id}.json"
                try:
                    asset_metadata = _json.loads(
                        metadata_path.read_text(encoding="utf-8")
                    )
                except Exception:
                    asset_metadata = {}
                digest = str(asset_metadata.get("sha256") or hashlib.sha256(source.read_bytes()).hexdigest())
                registry_id = f"style-bg-{digest[:24]}"
                relative = f"assets/style-background-{digest[:24]}.webp"
                shutil.copyfile(source, project_dir / relative)
                project_background_registry_ids[f"style:{asset_id}"] = registry_id
                project_background_asset_records.append(
                    {
                        "id": registry_id,
                        "kind": "image",
                        "path": relative,
                        "originalName": asset_metadata.get("originalName")
                        or source.name,
                        "mimeType": "image/webp",
                        "bytes": (project_dir / relative).stat().st_size,
                        "sha256": digest,
                        "sourceType": asset_metadata.get("sourceType")
                        or "user-upload",
                        "rightsStatus": asset_metadata.get("rightsStatus")
                        or "unknown",
                        "licenseName": asset_metadata.get("licenseName") or "",
                        "rightsConfirmedAt": asset_metadata.get(
                            "rightsConfirmedAt"
                        ),
                        "usage": {"type": "style-background", "assetId": asset_id},
                    }
                )
            style_brand = locked_style.get("brand") or {}
            style_logos = (
                style_brand.get("logo") if isinstance(style_brand, Mapping) else {}
            )
            if isinstance(style_logos, Mapping):
                for variant, logo in style_logos.items():
                    if not isinstance(logo, Mapping):
                        continue
                    asset_id = str(logo.get("assetId") or "")
                    if not re.fullmatch(
                        r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", asset_id
                    ):
                        continue
                    source = style_source / "assets" / f"{asset_id}.webp"
                    if not source.is_file():
                        continue
                    metadata_path = style_source / "assets" / f"{asset_id}.json"
                    try:
                        asset_metadata = _json.loads(
                            metadata_path.read_text(encoding="utf-8")
                        )
                    except Exception:
                        asset_metadata = {}
                    digest = str(
                        asset_metadata.get("sha256")
                        or hashlib.sha256(source.read_bytes()).hexdigest()
                    )
                    registry_id = f"style-logo-{digest[:24]}"
                    relative = f"assets/style-logo-{digest[:24]}.webp"
                    shutil.copyfile(source, project_dir / relative)
                    project_style_asset_registry_ids[
                        f"brand-logo:{variant}"
                    ] = registry_id
                    project_background_asset_records.append(
                        {
                            "id": registry_id,
                            "kind": "image",
                            "path": relative,
                            "originalName": asset_metadata.get("originalName")
                            or source.name,
                            "mimeType": "image/webp",
                            "bytes": (project_dir / relative).stat().st_size,
                            "sha256": digest,
                            "sourceType": asset_metadata.get("sourceType")
                            or "user-upload",
                            "rightsStatus": asset_metadata.get("rightsStatus")
                            or "unknown",
                            "licenseName": asset_metadata.get("licenseName") or "",
                            "rightsConfirmedAt": asset_metadata.get(
                                "rightsConfirmedAt"
                            ),
                            "usage": {
                                "type": "brand-logo",
                                "variant": str(variant),
                                "assetId": asset_id,
                            },
                        }
                    )
            default_background = (locked_style.get("backgrounds") or {}).get("default") or {}
            role_backgrounds = (locked_style.get("backgrounds") or {}).get("roles") or {}
            series_assets = (
                video_series_directory(get_workspace_path()) / series_id / "draft" / "assets"
            )
            for role, raw_asset_id in background_asset_ids.items():
                role_name = str(role)
                asset_id = str(raw_asset_id or "")
                slot = role_backgrounds.get(role_name) or {}
                policy = slot.get("assetPolicy") or default_background.get("assetPolicy")
                if policy != "episode-replaceable":
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response(
                        {"error": f"background slot is not replaceable: {role_name}"},
                        status=409,
                    )
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", asset_id):
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response({"error": "invalid background asset"}, status=400)
                source = series_assets / f"{asset_id}.webp"
                if not source.is_file():
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response({"error": "background asset not found"}, status=404)
                metadata_path = series_assets / f"{asset_id}.json"
                try:
                    asset_metadata = _json.loads(
                        metadata_path.read_text(encoding="utf-8")
                    )
                except Exception:
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response({"error": "background asset metadata is invalid"}, status=409)
                minimum = {
                    "16:9": (1920, 1080),
                    "9:16": (1080, 1920),
                    "1:1": (1080, 1080),
                }[aspect_variant]
                if (
                    int(asset_metadata.get("width") or 0) < minimum[0]
                    or int(asset_metadata.get("height") or 0) < minimum[1]
                ):
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response(
                        {"error": "background asset resolution is too low"}, status=422
                    )
                relative = f"assets/background-{role_name}.webp"
                shutil.copyfile(source, project_dir / relative)
                project_backgrounds[role_name] = relative
                project_background_asset_records.append(
                    {
                        "id": f"background-{role_name}",
                        "kind": "image",
                        "path": relative,
                        "originalName": asset_metadata.get("originalName")
                        or source.name,
                        "mimeType": "image/webp",
                        "bytes": (project_dir / relative).stat().st_size,
                        "sha256": asset_metadata.get("sha256"),
                        "sourceType": asset_metadata.get("sourceType")
                        or "user-upload",
                        "rightsStatus": asset_metadata.get("rightsStatus")
                        or "unknown",
                        "licenseName": asset_metadata.get("licenseName") or "",
                        "rightsConfirmedAt": asset_metadata.get(
                            "rightsConfirmedAt"
                        ),
                        "usage": {"type": "background", "role": role_name},
                    }
                )
                project_background_registry_ids[role_name] = f"background-{role_name}"
        if series is None:
            assert single_style is not None
            single_style["projectTemplate"] = True
            (project_dir / "style").mkdir(parents=True, exist_ok=True)
            _atomic_write_text(
                project_dir / "style" / "design-system.json",
                _json.dumps(single_style, ensure_ascii=False, indent=2) + "\n",
            )
        meta: dict[str, object] = {
            "name": name,
            "resolution": resolution,
            "phase": "storyboard",
            "outputStale": False,
            "language": language,
            "localeGroupId": name,
            "sourceCount": len(source_records),
            "subtitleMode": subtitle_mode,
            "musicPreset": music_preset,
        }
        meta.update({"authoringMode": "huashu-motion", "structuredCompiler": False,
                     "requirePlanApproval": True, "planRevision": 0,
                     "approvedPlanRevision": None, "executionMode": "interactive"})
        if series is None:
            meta.update({"templateId": template_id, "stylePreference": style_preference})
        if narration_enabled:
            meta["narrationEnabled"] = True
            meta["ttsProvider"] = tts_provider or "edge"
            meta["ttsVoice"] = tts_voice or (
                VIDEO_LANGUAGE_PRESETS[language]["edgeVoice"]
                if not tts_provider or tts_provider == "edge"
                else ""
            )
            meta["ttsRate"] = tts_rate or "+0%"
        if series is not None and locked_style is not None and style_version is not None:
            meta.update(
                {
                    "seriesId": series["id"],
                    "seriesName": series["name"],
                    "styleVersion": style_version,
                    "aspectVariant": aspect_variant,
                    "backgroundBindings": project_backgrounds,
                    "backgroundAssetIds": {
                        str(role): str(asset_id)
                        for role, asset_id in background_asset_ids.items()
                    },
                    "backgroundRegistryIds": project_background_registry_ids,
                    "styleAssetRegistryIds": project_style_asset_registry_ids,
                }
            )
            if episode_number is not None:
                try:
                    episode = int(episode_number)
                except (TypeError, ValueError):
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response({"error": "invalid episode number"}, status=400)
                if episode < 1:
                    shutil.rmtree(project_dir, ignore_errors=True)
                    return web.json_response({"error": "invalid episode number"}, status=400)
                meta["episodeNumber"] = episode
            if not attached_series_id:
                meta["styleSourceSeriesId"] = series_id
                meta["templateId"] = locked_style.get("baseTemplateId") or "custom"
                meta["structuredCompiler"] = False
                for key in ("seriesId", "seriesName", "episodeNumber"):
                    meta.pop(key, None)
        if project_background_asset_records:
            from mona.video_assets import register_project_asset

            for record in project_background_asset_records:
                register_project_asset(project_dir, record)
        if music_preset != "none":
            from mona.video_assets import VideoAssetError, import_project_asset

            try:
                music_asset = await asyncio.to_thread(
                    import_project_asset,
                    project_dir,
                    music_file_path,
                    source_type=str(music.get("sourceType") or "user-upload"),
                    rights_status=str(music.get("rightsStatus") or "unknown"),
                    license_name=str(music.get("licenseName") or ""),
                    creator=str(music.get("creator") or ""),
                    attribution=str(music.get("attribution") or ""),
                )
            except VideoAssetError as exc:
                shutil.rmtree(project_dir, ignore_errors=True)
                return web.json_response(exc.to_dict(), status=exc.status_code)
            meta["musicAssetId"] = music_asset["id"]
        if source_records:
            _atomic_write_text(
                project_dir / "sources" / "manifest.json",
                _json.dumps(
                    {"schemaVersion": 1, "sources": source_records},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
            )
        if _agent_context is not None:
            _atomic_write_text(project_dir / ".chat_id", _agent_context["owner"])
            meta.update({key: _agent_context[key] for key in (
                "executionMode", "executionAuthorization", "creationRequestId"
            )})
        _save_video_meta(project_dir, meta)
        return web.json_response({"ok": True, "name": name})
    except Exception as e:
        if _agent_context is not None and created_project_dir is not None:
            shutil.rmtree(created_project_dir, ignore_errors=True)
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
        meta = _normalize_video_meta(project_dir, meta)
        return web.json_response({
            "name": name,
            "chatId": chat_id,
            "meta": meta,
            **status_info,
        })
    except Exception as e:
        logger.exception("video project error")
        return web.json_response({"error": str(e)}, status=500)


def _video_project_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError("invalid project name")
    return name


async def handle_video_project_rename(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        name = _video_project_name(body.get("name"))
        new_name = _video_project_name(body.get("newName"))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    source = _video_projects_dir() / name
    target = _video_projects_dir() / new_name
    if not source.is_dir():
        return web.json_response({"error": "project not found"}, status=404)
    if target.exists() or (_video_archived_projects_dir() / new_name).exists():
        return web.json_response({"error": "project already exists"}, status=409)
    task = _video_render_tasks.get(name)
    if task is not None and not task.done():
        return web.json_response({"error": "cannot rename while rendering"}, status=409)
    source.replace(target)
    meta = _load_video_meta(target)
    meta["name"] = new_name
    meta["renamedAt"] = datetime.now().isoformat()
    _save_video_meta(target, meta)
    return web.json_response({"ok": True, "name": new_name, "previousName": name})


async def handle_video_project_copy(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        name = _video_project_name(body.get("name"))
        new_name = _video_project_name(body.get("newName"))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    source = _video_projects_dir() / name
    target = _video_projects_dir() / new_name
    if not source.is_dir():
        return web.json_response({"error": "project not found"}, status=404)
    if target.exists() or (_video_archived_projects_dir() / new_name).exists():
        return web.json_response({"error": "project already exists"}, status=409)
    staging = target.with_name(f".{target.name}.copying-{uuid.uuid4().hex[:8]}")
    try:
        shutil.copytree(
            source,
            staging,
            ignore=shutil.ignore_patterns(
                "renders", "frames", ".chrome-profile", "versions", ".render_status.json"
            ),
        )
        (staging / "renders").mkdir(parents=True, exist_ok=True)
        (staging / ".chat_id").unlink(missing_ok=True)
        meta = _load_video_meta(staging)
        meta.update(
            {
                "name": new_name,
                "phase": "producing" if meta.get("storyboardLocked") else "storyboard",
                "hasVideo": False,
                "outputStale": False,
                "copiedFrom": name,
                "copiedAt": datetime.now().isoformat(),
                "localeGroupId": new_name,
            }
        )
        _save_video_meta(staging, meta)
        staging.replace(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return web.json_response({"ok": True, "name": new_name, "copiedFrom": name})


async def handle_video_project_archive(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        name = _video_project_name(body.get("name"))
        archived = bool(body.get("archived", True))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)
    source_root = _video_projects_dir() if archived else _video_archived_projects_dir()
    target_root = _video_archived_projects_dir() if archived else _video_projects_dir()
    source = source_root / name
    target = target_root / name
    if not source.is_dir():
        return web.json_response({"error": "project not found"}, status=404)
    if target.exists():
        return web.json_response({"error": "project already exists"}, status=409)
    task = _video_render_tasks.get(name)
    if archived and task is not None and not task.done():
        return web.json_response({"error": "cannot archive while rendering"}, status=409)
    target_root.mkdir(parents=True, exist_ok=True)
    source.replace(target)
    meta = _load_video_meta(target)
    if archived:
        meta["archivedAt"] = datetime.now().isoformat()
    else:
        meta.pop("archivedAt", None)
        meta["restoredAt"] = datetime.now().isoformat()
    _save_video_meta(target, meta)
    return web.json_response({"ok": True, "name": name, "archived": archived})


def _refresh_project_style_asset_registry(
    project_dir: Path,
    style: Mapping[str, Any],
    style_source: Path,
    meta: dict[str, Any],
) -> None:
    from mona.video_assets import read_asset_manifest, register_project_asset

    old_ids = {
        str(asset_id)
        for asset_id in (meta.get("styleAssetRegistryIds") or {}).values()
        if str(asset_id)
    }
    old_ids.update(
        str(asset_id)
        for key, asset_id in (meta.get("backgroundRegistryIds") or {}).items()
        if str(key).startswith("style:") and str(asset_id)
    )
    manifest_path = project_dir / "assets" / "manifest.json"
    original_manifest = (
        manifest_path.read_text(encoding="utf-8") if manifest_path.is_file() else None
    )
    manifest = read_asset_manifest(project_dir)
    old_records = [
        item for item in manifest.get("assets") or [] if str(item.get("id")) in old_ids
    ]
    manifest["assets"] = [
        item for item in manifest.get("assets") or [] if str(item.get("id")) not in old_ids
    ]
    records: list[dict[str, Any]] = []
    background_ids: dict[str, str] = {}
    style_ids: dict[str, str] = {}

    def add_asset(asset_id: str, *, usage: dict[str, Any], prefix: str) -> str | None:
        source = style_source / "assets" / f"{asset_id}.webp"
        if not source.is_file():
            return None
        metadata_path = style_source / "assets" / f"{asset_id}.json"
        try:
            metadata = _json.loads(metadata_path.read_text(encoding="utf-8"))
        except Exception:
            metadata = {}
        digest = str(
            metadata.get("sha256") or hashlib.sha256(source.read_bytes()).hexdigest()
        )
        registry_id = f"{prefix}-{digest[:24]}"
        relative = f"assets/{prefix}-{digest[:24]}.webp"
        shutil.copyfile(source, project_dir / relative)
        records.append(
            {
                "id": registry_id,
                "kind": "image",
                "path": relative,
                "originalName": metadata.get("originalName") or source.name,
                "mimeType": "image/webp",
                "bytes": (project_dir / relative).stat().st_size,
                "sha256": digest,
                "sourceType": metadata.get("sourceType") or "user-upload",
                "rightsStatus": metadata.get("rightsStatus") or "unknown",
                "licenseName": metadata.get("licenseName") or "",
                "rightsConfirmedAt": metadata.get("rightsConfirmedAt"),
                "usage": usage,
            }
        )
        return registry_id

    def collect_asset_ids(value: Any) -> set[str]:
        if isinstance(value, Mapping):
            result = {
                str(value.get("assetId") or "") if value.get("assetId") else ""
            }
            for nested in value.values():
                result.update(collect_asset_ids(nested))
            return {item for item in result if item}
        if isinstance(value, list):
            result: set[str] = set()
            for nested in value:
                result.update(collect_asset_ids(nested))
            return result
        return set()

    for asset_id in sorted(collect_asset_ids(style.get("backgrounds") or {})):
        registry_id = add_asset(
            asset_id,
            usage={"type": "style-background", "assetId": asset_id},
            prefix="style-bg",
        )
        if registry_id:
            background_ids[f"style:{asset_id}"] = registry_id
    brand = style.get("brand") if isinstance(style.get("brand"), Mapping) else {}
    logos = brand.get("logo") if isinstance(brand.get("logo"), Mapping) else {}
    for variant, raw_logo in logos.items():
        if not isinstance(raw_logo, Mapping):
            continue
        asset_id = str(raw_logo.get("assetId") or "")
        if not asset_id:
            continue
        registry_id = add_asset(
            asset_id,
            usage={"type": "brand-logo", "variant": str(variant), "assetId": asset_id},
            prefix="style-logo",
        )
        if registry_id:
            style_ids[f"brand-logo:{variant}"] = registry_id
    try:
        _atomic_write_text(
            manifest_path,
            _json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        for record in records:
            register_project_asset(project_dir, record)
    except Exception:
        if original_manifest is None:
            manifest_path.unlink(missing_ok=True)
        else:
            _atomic_write_text(manifest_path, original_manifest)
        raise
    new_paths = {str(record.get("path") or "") for record in records}
    for record in old_records:
        relative = str(record.get("path") or "")
        if relative not in new_paths and relative.startswith(
            ("assets/style-bg-", "assets/style-logo-")
        ):
            (project_dir / relative).unlink(missing_ok=True)
    preserved_backgrounds = {
        str(key): str(value)
        for key, value in (meta.get("backgroundRegistryIds") or {}).items()
        if not str(key).startswith("style:")
    }
    meta["backgroundRegistryIds"] = {**preserved_backgrounds, **background_ids}
    meta["styleAssetRegistryIds"] = style_ids


def _upgrade_video_project_style(
    project_dir: Path,
    series_id: str,
    version: int,
    style: Mapping[str, Any],
) -> dict[str, Any]:
    meta = _load_video_meta(project_dir)
    if str(meta.get("seriesId") or "") != series_id:
        raise ValueError("project is not in the selected series")
    aspect = str(meta.get("aspectVariant") or "16:9")
    variant = (style.get("aspectVariants") or {}).get(aspect)
    if not isinstance(variant, dict) or not variant.get("enabled"):
        raise ValueError(f"style does not support {aspect}")
    task = _video_render_tasks.get(project_dir.name)
    if task is not None and not task.done():
        raise ValueError("project is rendering")

    source = (
        video_series_directory(get_workspace_path())
        / series_id
        / "styles"
        / f"v{version}"
    )
    current = project_dir / "style"
    staging = project_dir / f".style-v{version}-{uuid.uuid4().hex[:8]}.tmp"
    backup = project_dir / f".style-previous-{uuid.uuid4().hex[:8]}.tmp"
    _create_video_project_version(
        project_dir,
        label=f"升级风格前 v{meta.get('styleVersion') or 0}",
        reason="before-style-upgrade",
    )
    shutil.copytree(source, staging)
    try:
        if current.exists():
            current.replace(backup)
        staging.replace(current)
        _refresh_project_style_asset_registry(project_dir, style, source, meta)
        meta["styleVersion"] = version
        _invalidate_video_outputs(project_dir, meta, None, reset_html=True)
        _save_video_meta(project_dir, meta)
    except Exception:
        if current.exists():
            shutil.rmtree(current, ignore_errors=True)
        if backup.exists():
            backup.replace(current)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    shutil.rmtree(backup, ignore_errors=True)
    _schedule_video_push(project_dir.name, "style")
    return meta


async def handle_video_project_upgrade_style(request: web.Request) -> web.Response:
    """Rebind one existing series project to another immutable style version."""

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name") or "").strip()
        project_dir, error = _video_project_dir_or_404(name)
        if error is not None:
            return error
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        series_id = str(meta.get("seriesId") or "")
        if not series_id:
            return web.json_response({"error": "project is not in a series"}, status=409)
        try:
            version = int(body.get("styleVersion") or 0)
        except (TypeError, ValueError):
            return web.json_response({"error": "invalid style version"}, status=400)
        try:
            style = read_style_version(get_workspace_path(), series_id, version)
        except VideoStyleError as exc:
            return web.json_response(exc.to_dict(), status=exc.status_code)
        meta = _upgrade_video_project_style(project_dir, series_id, version, style)
        return web.json_response(
            {"ok": True, "styleVersion": version, "phase": meta.get("phase")}
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=409)
    except Exception as exc:
        logger.exception("video project style upgrade error")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_video_series_projects_upgrade(request: web.Request) -> web.Response:
    """Upgrade selected or all eligible projects in one series."""

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    series_id = str(request.match_info.get("series_id") or "").strip()
    try:
        version = int(body.get("styleVersion") or 0)
    except (TypeError, ValueError):
        return web.json_response({"error": "invalid style version"}, status=400)
    selected = body.get("projectNames")
    if selected is not None and (
        not isinstance(selected, list) or len(selected) > 500
    ):
        return web.json_response({"error": "projectNames must be a list"}, status=400)
    try:
        style = read_style_version(get_workspace_path(), series_id, version)
    except VideoStyleError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)
    selected_names = {str(name) for name in selected or [] if str(name)}
    updated: list[str] = []
    skipped: list[dict[str, str]] = []
    projects_dir = _video_projects_dir()
    if projects_dir.is_dir():
        for project_dir in sorted(projects_dir.iterdir()):
            if not project_dir.is_dir() or not (project_dir / "meta.json").is_file():
                continue
            if selected is not None and project_dir.name not in selected_names:
                continue
            meta = _load_video_meta(project_dir)
            if str(meta.get("seriesId") or "") != series_id:
                continue
            if int(meta.get("styleVersion") or 0) == version:
                skipped.append({"name": project_dir.name, "reason": "already-current"})
                continue
            try:
                _upgrade_video_project_style(project_dir, series_id, version, style)
                updated.append(project_dir.name)
            except Exception as exc:
                skipped.append({"name": project_dir.name, "reason": str(exc)})
    if selected is not None:
        handled = set(updated) | {item["name"] for item in skipped}
        for name in sorted(selected_names - handled):
            skipped.append({"name": name, "reason": "请先恢复归档项目，或确认项目属于当前系列"})
    return web.json_response(
        {
            "ok": not skipped or bool(updated),
            "styleVersion": version,
            "updatedProjectNames": updated,
            "skipped": skipped,
        }
    )


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
        binding = project_dir / ".chat_id"
        previous = binding.read_text(encoding="utf-8").strip() if binding.is_file() else ""
        if previous != chat_id:
            meta = _load_video_meta(project_dir)
            if _revoke_video_automatic_execution(meta):
                _save_video_meta(project_dir, meta)
        binding.write_text(chat_id, encoding="utf-8")
        return web.json_response({"ok": True})
    except Exception as e:
        logger.exception("video save chat id error")
        return web.json_response({"error": str(e)}, status=500)


def _video_project_dir_or_404(name: str) -> tuple[Path | None, web.Response | None]:
    """Validate project name and return (project_dir, None) or (None, error_response)."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None, web.json_response({"error": "invalid project name"}, status=400)
    root = _video_projects_dir().resolve()
    project_dir = (root / name).resolve()
    if project_dir == root or not project_dir.is_relative_to(root):
        return None, web.json_response({"error": "invalid project path"}, status=400)
    if not project_dir.is_dir():
        return None, web.json_response({"error": "project not found"}, status=404)
    return project_dir, None


async def _push_video_project_changed(name: str, hint: str = "") -> None:
    """Best-effort push of a video project change to connected webui clients.

    These handlers run in the services process while the websocket channel
    lives in the gateway process, so we loop back to its internal route.
    Polling endpoints remain the fallback when the push fails.
    """
    try:
        import httpx

        from mona.channels.websocket import WebSocketConfig
        from mona.config.loader import load_config

        section = getattr(load_config().channels, "websocket", None)
        ws_cfg = WebSocketConfig.model_validate(section if isinstance(section, dict) else {})
        headers = {}
        secret = ws_cfg.token_issue_secret.strip() or ws_cfg.token.strip()
        if secret:
            headers["Authorization"] = f"Bearer {secret}"
        params: dict[str, str] = {"name": name}
        if hint:
            params["hint"] = hint
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0)) as client:
            await client.get(
                f"http://127.0.0.1:{ws_cfg.port}/api/video/broadcast-change",
                params=params,
                headers=headers,
            )
    except Exception as e:
        logger.warning("video project push failed ({} {}): {}", name, hint, e)


# Strong refs to in-flight push tasks (asyncio only weak-refs tasks).
_video_push_tasks: set[asyncio.Task] = set()


def _schedule_video_push(name: str, hint: str = "") -> None:
    """Fire-and-forget ``video_project_changed`` push.

    Handlers stay on the fast path: the loopback HTTP call runs in the
    background and never delays the response. Polling endpoints remain the
    fallback when the push fails or no client is connected.
    """
    try:
        task = asyncio.create_task(_push_video_project_changed(name, hint))
    except RuntimeError:
        return  # no running event loop (unit tests)
    _video_push_tasks.add(task)
    task.add_done_callback(_video_push_tasks.discard)


def _video_scene_ready(project_dir: Path, scene: dict) -> bool:
    """A scene is export-ready when its HTML has been generated for the current
    storyboard content (htmlStatus past pending) and the file exists on disk.

    P3: export gates on "ready", not "confirmed" — the render task snapshots
    scene HTML at start, so per-scene confirmation is no longer required.
    """
    if scene.get("htmlStatus") not in ("previewing", "confirmed"):
        return False
    idx = scene.get("index")
    if idx is None:
        return False
    if scene.get("authored"):
        from mona.video_authoring import authored_scene_source_path

        source = authored_scene_source_path(project_dir, scene)
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != scene.get("sourceHash"):
            return False
    prepared = project_dir / "scenes" / f"scene_{int(idx):02d}.html"
    if scene.get("preparedHash") and (not prepared.is_file() or hashlib.sha256(prepared.read_bytes()).hexdigest() != scene["preparedHash"]):
        return False
    return (project_dir / "scenes" / f"scene_{int(idx):02d}.html").is_file()


def _invalidate_video_outputs(
    project_dir: Path,
    meta: dict,
    scene_indexes: set[int] | None,
    *,
    reset_html: bool,
    reset_audio: bool = True,
) -> None:
    """Invalidate video outputs after content changes.

    Args:
        scene_indexes: None means all scenes; otherwise only the given scenes.
        reset_html: If True, also reset htmlStatus to pending for affected scenes.
    """
    scenes = meta.get("scenes") or []
    if meta.get("authoringMode") == "huashu-motion" and reset_html:
        meta.pop("composition", None)
        for item in scenes:
            item["htmlStatus"] = "pending"
            item.pop("motionReview", None)
            item.pop("motionReviewSourceHash", None)
    if scene_indexes is None:
        scene_indexes = {s.get("index") for s in scenes if s.get("index") is not None}
    else:
        scene_indexes = set(scene_indexes)

    for scene in scenes:
        idx = scene.get("index")
        if idx is None or idx not in scene_indexes:
            continue
        # Clear confirmation
        scene.pop("confirmedAt", None)
        scene.pop("confirmedMtime", None)
        # Clear narration-audio cache binding so export re-synthesizes TTS
        for key in (
            "audioMtime",
            "audioInputHash",
            "audioTimingPath",
            "audioTimingSource",
            "audioAlignmentConfidence",
            "audioTimingHash",
            "motionPlanPath",
            "motionPlanSummary",
            "motionReviewSourceHash",
            "motionReview",
        ):
            if key.startswith("audio") and not reset_audio:
                continue
            scene.pop(key, None)
        try:
            if reset_audio:
                (project_dir / "audio" / f"scene_{int(idx):02d}.timing.json").unlink(missing_ok=True)
            (
                project_dir / "scene_specs" / f"scene_{int(idx):02d}.motion.json"
            ).unlink(missing_ok=True)
        except OSError:
            pass
        if reset_html:
            scene["htmlStatus"] = "pending"
        else:
            # Keep htmlStatus but mark as needing re-confirmation
            if scene.get("htmlStatus") == "confirmed":
                scene["htmlStatus"] = "previewing"

    # Update project phase
    if meta.get("phase") not in ("storyboard",):
        meta["phase"] = "producing"
    # Mark output as stale if it exists
    output_mp4 = project_dir / "renders" / "output.mp4"
    if output_mp4.is_file():
        meta["outputStale"] = True


def _load_video_meta(project_dir: Path) -> dict:
    """Load meta.json, return empty dict if missing."""
    meta_file = project_dir / "meta.json"
    if not meta_file.is_file():
        return {}
    try:
        meta = _json.loads(meta_file.read_text(encoding="utf-8"))
        if not isinstance(meta, dict):
            raise ValueError("视频项目信息格式无效，请从版本记录恢复")
        meta.setdefault("requirePlanApproval", False)
        meta.setdefault("planRevision", 0)
        meta.setdefault("approvedPlanRevision", None)
        meta.setdefault("executionMode", "interactive")
        authorization = meta.get("executionAuthorization")
        if meta["executionMode"] == "automatic" or (
            isinstance(authorization, Mapping) and authorization.get("mode") == "automatic"
        ):
            binding = project_dir / ".chat_id"
            owner = binding.read_text(encoding="utf-8").strip() if binding.is_file() else ""
            if not owner or not isinstance(authorization, Mapping) or authorization.get("chatId") != owner:
                _revoke_video_automatic_execution(meta)
                _save_video_meta(project_dir, meta)
        from mona.video_project import ensure_scene_ids

        ensure_scene_ids(meta, project_dir.resolve().as_uri())
        return meta
    except (OSError, UnicodeError, _json.JSONDecodeError, TypeError, KeyError) as exc:
        raise ValueError("视频项目信息无法读取，请从版本记录恢复或重新打开项目") from exc


def _save_video_meta(project_dir: Path, meta: dict) -> None:
    """Save meta.json atomically."""
    import os

    from mona.video_project import ensure_scene_ids

    ensure_scene_ids(meta, project_dir.resolve().as_uri())

    # scenes 变更时同步时间戳，供 storyboard GET 做 mtime 仲裁：
    # AI 会话裸写 storyboard.md 后 mtime > scenesUpdatedAt → 触发重解析。
    # 调用方须先 _sync_storyboard 落盘 storyboard.md 再调本函数，
    # 保证 scenesUpdatedAt >= storyboard.mtime。
    if isinstance(meta.get("scenes"), list) and meta["scenes"]:
        meta["scenesUpdatedAt"] = time.time()
    temporary = project_dir / ".meta.json.tmp"
    temporary.write_text(
        _json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, project_dir / "meta.json")


def _scene_content(scene: Mapping[str, Any]) -> dict[str, Any]:
    result = {key: str(scene.get(key) or "") for key in (
        "title", "role", "layout", "backgroundSlot", "visual", "animation", "narration"
    )}
    result["duration"] = float(scene.get("duration") or 5)
    result["assets"] = scene.get("assets") or []
    return result


def _revoke_video_automatic_execution(meta: dict) -> bool:
    authorization = meta.get("executionAuthorization")
    if meta.get("executionMode") != "automatic" and not (
        isinstance(authorization, Mapping) and authorization.get("mode") == "automatic"
    ):
        return False
    meta.update({"executionMode": "interactive", "requirePlanApproval": True,
                 "approvedPlanRevision": None, "phase": "storyboard"})
    meta.pop("executionAuthorization", None)
    return True


def _video_automatic_execution_authorized(meta: Mapping[str, Any]) -> bool:
    authorization = meta.get("executionAuthorization")
    return bool(
        meta.get("executionMode") == "automatic"
        and not meta.get("styleAuthoring")
        and isinstance(meta.get("name"), str)
        and meta["name"].strip()
        and isinstance(authorization, Mapping)
        and authorization.get("mode") == "automatic"
        and authorization.get("projectName") == meta.get("name")
        and isinstance(authorization.get("chatId"), str)
        and authorization["chatId"].strip()
        and isinstance(authorization.get("instruction"), str)
        and authorization["instruction"].strip()
    )


def _video_plan_changed(meta: dict) -> None:
    meta["requirePlanApproval"] = not bool(meta.get("styleAuthoring"))
    meta["planRevision"] = int(meta.get("planRevision") or 0) + 1
    automatic = _video_automatic_execution_authorized(meta)
    meta["approvedPlanRevision"] = meta["planRevision"] if automatic else None
    meta["phase"] = "producing" if automatic else "storyboard"


def _require_video_plan_approval(meta: Mapping[str, Any], revision: Any = None, *, check_revision: bool = False) -> None:
    if meta.get("styleAuthoring") and check_revision and (
        isinstance(revision, bool) or not isinstance(revision, int) or revision != int(meta.get("planRevision") or 0)
    ):
        raise ValueError("样片内容已更新，请读取当前样片后继续")
    if not meta.get("requirePlanApproval"):
        return
    current = int(meta.get("planRevision") or 0)
    if check_revision and (isinstance(revision, bool) or not isinstance(revision, int) or revision != current):
        raise ValueError("分镜方案已更新，请读取当前方案后再制作")
    if meta.get("approvedPlanRevision") != current:
        raise ValueError("请先在导演台确认分镜方案，再开始制作")


def _require_video_motion_review(scene: Mapping[str, Any]) -> None:
    if scene.get("authoredRuntime") != "huashu-motion":
        return
    review = scene.get("motionReview") or {}
    if scene.get("motionReviewSourceHash") != scene.get("sourceHash") or review.get("distinctVisualStates", 0) < 2:
        raise ValueError(f"第 {scene.get('index')} 段的动画还未检查通过，请检查画面如何随口播变化后再导出")


async def handle_video_project_confirm(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        project_dir, error = _video_project_dir_or_404(str(body.get("name") or "").strip())
        if error is not None:
            return error
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        expected = body.get("expectedPlanRevision")
        current = int(meta.get("planRevision") or 0)
        if isinstance(expected, bool) or not isinstance(expected, int) or expected != current:
            return web.json_response({"error": "分镜方案已更新，请查看最新方案后再确认", "planRevision": current}, status=409)
        if not meta.get("scenes"):
            return web.json_response({"error": "请先准备分镜方案"}, status=409)
        meta.update({"requirePlanApproval": True, "approvedPlanRevision": current, "phase": "producing"})
        _save_video_meta(project_dir, meta)
        _schedule_video_push(project_dir.name, "scenes")
        return web.json_response({"ok": True, "planRevision": current})
    except (TypeError, ValueError):
        return web.json_response({"error": "确认分镜方案的请求格式无效"}, status=400)


def _video_export_input_hash(project_dir: Path, meta: Mapping[str, Any]) -> str:
    from mona.video_authoring import composition_path

    composition_path(project_dir, meta)
    payload = {
        key: meta.get(key)
        for key in ("resolution", "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode", "musicPreset", "musicAssetId", "audioTracks", "backgroundBindings", "styleVersion", "authoringMode", "composition")
    }
    payload["scenes"] = [_scene_content(scene) for scene in meta.get("scenes") or []]
    files = [project_dir / "storyboard.md", project_dir / "style" / "design-system.json", project_dir / "assets" / "manifest.json"]
    files.extend(sorted((project_dir / "scenes").glob("scene_*.html")))
    for name in ("assets", "style", "scene_specs", "scene_sources", "composition"):
        files.extend(path for path in sorted((project_dir / name).rglob("*")) if path.is_file())
    if any(not path.resolve().is_relative_to(project_dir.resolve()) for path in files if path.is_file()):
        raise ValueError("视频素材文件超出项目范围")
    payload["files"] = {
        path.relative_to(project_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files if path.is_file()
    }
    return hashlib.sha256(_json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _snapshot_video_project(project_dir: Path, meta: Mapping[str, Any]) -> Path:
    from mona.video_authoring import composition_path

    composition_path(project_dir, meta)
    root = project_dir.resolve()
    snapshot = (project_dir / "renders" / "snapshot").resolve()
    if not snapshot.is_relative_to(root):
        raise ValueError("视频导出目录超出项目范围")
    if snapshot.is_dir():
        shutil.rmtree(snapshot)
    snapshot.mkdir(parents=True)
    for name in ("scenes", "scene_specs", "scene_sources", "composition", "audio", "assets", "style"):
        source = project_dir / name
        if source.is_dir():
            if not source.resolve().is_relative_to(root):
                raise ValueError("视频素材目录超出项目范围")
            if any(not path.resolve().is_relative_to(root) for path in source.rglob("*")):
                raise ValueError("视频素材文件超出项目范围")
            shutil.copytree(source, snapshot / name)
    if (project_dir / "storyboard.md").is_file():
        shutil.copy2(project_dir / "storyboard.md", snapshot / "storyboard.md")
    _atomic_write_text(snapshot / "meta.json", _json.dumps(meta, ensure_ascii=False, indent=2))
    return snapshot


def _restore_video_render_artifacts(project_dir: Path, snapshot: Path, scenes: list[dict]) -> None:
    for directory_name in ("audio", "scene_specs", "scene_sources", "composition", "scenes"):
        source = snapshot / directory_name
        if source.is_dir():
            shutil.copytree(source, project_dir / directory_name, dirs_exist_ok=True)
    audio_dir = project_dir / "audio"
    valid_audio = {f"scene_{int(scene['index']):02d}.mp3" for scene in scenes}
    if audio_dir.is_dir():
        for path in audio_dir.glob("scene_*.mp3"):
            if path.name not in valid_audio or not (snapshot / "audio" / path.name).is_file():
                path.unlink(missing_ok=True)
        if not (snapshot / "audio" / "narration.mp3").is_file():
            (audio_dir / "narration.mp3").unlink(missing_ok=True)
    _sync_storyboard(project_dir, scenes)
    meta = _load_video_meta(project_dir)
    meta["scenes"] = scenes
    _save_video_meta(project_dir, meta)


def _merge_scene_status(
    old_scenes: list, new_scenes: list[dict]
) -> list[dict]:
    """按 scene.index 把旧场景的运行状态合并到重解析出的新场景上。

    仅内容未变的场景继承生成状态；改写后的内容必须重新生成和配音。
    """
    old_by_index = {
        s.get("index"): s
        for s in old_scenes
        if isinstance(s, dict) and s.get("index") is not None
    }
    for scene in new_scenes:
        old = old_by_index.get(scene.get("index"))
        if not isinstance(old, dict):
            continue
        if _scene_content(old) != _scene_content(scene):
            scene["htmlStatus"] = "pending"
            continue
        for key in (
            "authored",
            "authoredRuntime",
            "sourcePath",
            "sourceHash",
            "motionReview",
            "motionReviewSourceHash",
            "htmlStatus",
            "confirmedMtime",
            "confirmedAt",
            "audioMtime",
            "audioInputHash",
            "audioTimingPath",
            "audioTimingSource",
            "audioAlignmentConfidence",
            "audioTimingHash",
            "motionPlanPath",
            "motionPlanSummary",
            "error",
        ):
            if old.get(key) is not None:
                scene[key] = old[key]
    return new_scenes


def _ensure_scene_contract(scenes: list[dict]) -> list[dict]:
    """Fill structured scene fields for cached legacy metadata."""
    for position, scene in enumerate(scenes, start=1):
        role = scene.get("role")
        if not role:
            role = "cover" if position == 1 else ("outro" if position == len(scenes) else "content")
            scene["role"] = role
        scene.setdefault(
            "layout",
            {"cover": "cover-split", "outro": "outro-brand"}.get(
                str(role), "content-standard"
            ),
        )
        scene.setdefault(
            "backgroundSlot",
            role if role in ("cover", "outro") else "content",
        )
    return scenes


def _sync_storyboard(project_dir: Path, scenes: list[dict]) -> None:
    """Write scenes to storyboard.md via the write_storyboard script logic."""
    import importlib.util

    skill_dir = Path(__file__).parent.parent / "skills" / "mona-motion"
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

        storyboard_path = project_dir / "storyboard.md"
        storyboard_exists = storyboard_path.is_file()

        # meta.json scenes 是唯一事实源，但 AI 会话可能裸写 storyboard.md。
        # mtime 仲裁：storyboard.md 比 meta.scenes 更新（AI 改过）→ 重新解析；
        # 否则直接用 meta 缓存。scenesUpdatedAt 缺失（旧项目）视为 0，
        # 首次 GET 会重解析一次（内容幂等），之后走 meta 缓存。
        meta = _load_video_meta(project_dir)
        cached_scenes = meta.get("scenes")
        try:
            scenes_updated_at = float(meta.get("scenesUpdatedAt") or 0)
        except (TypeError, ValueError):
            scenes_updated_at = 0.0
        sb_mtime = storyboard_path.stat().st_mtime if storyboard_exists else None
        meta_fresh = (
            isinstance(cached_scenes, list)
            and bool(cached_scenes)
            and not (sb_mtime is not None and sb_mtime > scenes_updated_at)
        )
        if meta_fresh:
            scenes = _ensure_scene_contract(cached_scenes)
            # Attach current HTML file mtime so the client can bind confirmation
            # to the exact previewed version (expectedMtime on confirm).
            for scene in scenes:
                idx = scene.get("index")
                if idx is None:
                    continue
                scene_html = project_dir / "scenes" / f"scene_{int(idx):02d}.html"
                if scene_html.is_file():
                    try:
                        scene["htmlMtime"] = scene_html.stat().st_mtime
                    except OSError:
                        scene.pop("htmlMtime", None)
                else:
                    scene.pop("htmlMtime", None)
            return web.json_response({
                "ok": True,
                "scenes": scenes,
                "planRevision": meta.get("planRevision", 0),
                "source": "meta",
                "storyboardExists": storyboard_exists,
            })

        # Parse from storyboard.md and cache into meta.json
        import importlib.util

        skill_dir = Path(__file__).parent.parent / "skills" / "mona-motion"
        script = skill_dir / "scripts" / "parse_storyboard.py"
        spec = importlib.util.spec_from_file_location("parse_storyboard", script)
        if spec is None or spec.loader is None:
            return web.json_response({"ok": False, "error": "parse script missing"})
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        scenes = mod.parse_storyboard(storyboard_path)
        if scenes:
            _ensure_scene_contract(scenes)
            plan_changed = [_scene_content(scene) for scene in cached_scenes or []] != [_scene_content(scene) for scene in scenes]
            # storyboard.md 被 AI 重写过：保留 meta 中各场景的运行状态
            if isinstance(cached_scenes, list) and cached_scenes:
                _merge_scene_status(cached_scenes, scenes)
            meta["scenes"] = scenes
            changed = {
                int(scene["index"])
                for scene in scenes
                if scene.get("htmlStatus") == "pending"
            }
            if changed and cached_scenes:
                _invalidate_video_outputs(project_dir, meta, changed, reset_html=True)
            if plan_changed:
                _video_plan_changed(meta)
            meta.setdefault("phase", "storyboard")
            _save_video_meta(project_dir, meta)
            if plan_changed:
                _schedule_video_push(name, "scenes")
        # Diagnostic: storyboard.md exists but no scenes parsed → format mismatch
        parse_error = None
        if storyboard_exists and not scenes:
            parse_error = (
                "storyboard.md 已生成但格式无法解析。请检查文件内容是否符合 "
                "'### Scene N: <title>' 格式，或手动编辑后刷新。"
            )
        return web.json_response({
            "ok": True,
            "scenes": scenes,
            "planRevision": meta.get("planRevision", 0),
            "source": "storyboard",
            "storyboardExists": storyboard_exists,
            "parseError": parse_error,
        })
    except Exception as e:
        logger.exception("video project storyboard error")
        return web.json_response({"error": str(e)}, status=500)


def _video_settings_payload(body: Mapping[str, Any]) -> dict[str, Any]:
    keys = {"narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode"}
    settings = {key: body[key] for key in keys if key in body}
    if "narrationEnabled" in settings and not isinstance(settings["narrationEnabled"], bool):
        raise ValueError("请选择是否启用旁白")
    if "ttsProvider" in settings and settings["ttsProvider"] not in ("edge", "custom"):
        raise ValueError("请选择可用的配音来源")
    if "subtitleMode" in settings and settings["subtitleMode"] not in ("burned", "external", "off"):
        raise ValueError("请选择可用的字幕方式")
    if "ttsRate" in settings and not re.fullmatch(r"[+-](?:[0-9]|[1-9][0-9])%", str(settings["ttsRate"])):
        raise ValueError("语速格式无效")
    if "ttsVoice" in settings and (not isinstance(settings["ttsVoice"], str) or len(settings["ttsVoice"]) > 200):
        raise ValueError("音色格式无效")
    return settings


async def handle_video_project_settings(request: web.Request) -> web.Response:
    """Update narration and subtitle settings for an existing video."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "设置格式无效"}, status=400)
    name = str(body.get("name") or "").strip()
    project_dir, err = _video_project_dir_or_404(name)
    if err is not None:
        return err
    assert project_dir is not None
    task = _video_render_tasks.get(name)
    if task is not None and not task.done():
        return web.json_response({"error": "视频正在导出，请完成或取消导出后再修改设置"}, status=409)
    keys = {"narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode"}
    try:
        settings = _video_settings_payload(body)
        meta = _load_video_meta(project_dir)
        if "resolution" in body:
            if not meta.get("styleAuthoring"):
                raise ValueError("请在导演台调整视频画幅并确认方案")
            if body["resolution"] not in {"1920x1080", "1080x1920", "1080x1080"}:
                raise ValueError("请选择可用画幅")
            settings["resolution"] = body["resolution"]
            keys.add("resolution")
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    try:
        meta = _load_video_meta(project_dir)
        changed = {key for key, value in settings.items() if meta.get(key) != value}
        if changed:
            meta.update(settings)
            scenes = meta.get("scenes") or []
            audio_changed = bool(changed - {"subtitleMode", "resolution"})
            if audio_changed:
                _invalidate_video_outputs(project_dir, meta, None, reset_html=False)
                for scene in scenes:
                    (project_dir / "audio" / f"scene_{int(scene['index']):02d}.mp3").unlink(missing_ok=True)
                (project_dir / "audio" / "narration.mp3").unlink(missing_ok=True)
            for scene in scenes:
                if not _video_scene_ready(project_dir, scene):
                    continue
                if audio_changed:
                    if meta.get("narrationEnabled") and str(scene.get("narration") or "").strip():
                        _write_scene_timeline_artifacts(project_dir, scene, scene["narration"], None, boundaries=[])
                    else:
                        _write_scene_motion_without_narration(project_dir, scene)
                compiled = _recompile_series_scene_from_artifacts(project_dir, scene, meta)
                if not compiled and changed & {"subtitleMode", "narrationEnabled"}:
                    scene["htmlStatus"] = "pending"
            meta["outputStale"] = (project_dir / "renders" / "output.mp4").is_file()
            if scenes:
                meta["phase"] = "exportable" if all(_video_scene_ready(project_dir, scene) for scene in scenes) else "producing"
            _save_video_meta(project_dir, meta)
            _schedule_video_push(name, "scenes")
        return web.json_response({"ok": True, "meta": {key: meta.get(key) for key in keys}, "planRevision": meta.get("planRevision", 0)})
    except Exception:
        logger.exception("video narration settings update failed")
        return web.json_response({"error": "旁白与字幕设置保存失败，请刷新项目后重试"}, status=500)


async def handle_video_project_scene_update(request: web.Request) -> web.Response:
    """Update one storyboard scene, including its style-controlled layout fields."""
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
        if "expectedPlanRevision" in body:
            expected = body["expectedPlanRevision"]
            if isinstance(expected, bool) or not isinstance(expected, int) or expected != meta.get("planRevision", 0):
                return web.json_response({"error": "分镜方案已更新，请查看最新内容后再修改", "planRevision": meta.get("planRevision", 0)}, status=409)
        target = next((s for s in scenes if s.get("index") == index), None)
        if target is None:
            return web.json_response({"error": "scene not found"}, status=404)

        previous = _scene_content(target)

        if "title" in body:
            target["title"] = str(body["title"] or "").strip()
        if "role" in body:
            target["role"] = str(body["role"] or "content").strip()
        if "layout" in body:
            target["layout"] = str(body["layout"] or "content-standard").strip()
        if "backgroundSlot" in body:
            target["backgroundSlot"] = str(body["backgroundSlot"] or "content").strip()
        if "duration" in body:
            d = body["duration"]
            if isinstance(d, (int, float)) and not isinstance(d, bool):
                duration = float(d)
            elif isinstance(d, str):
                m = re.search(r"(\d+(?:\.\d+)?)", d)
                duration = float(m.group(1)) if m else 0
            else:
                duration = 0
            if not math.isfinite(duration) or duration <= 0:
                return web.json_response({"error": "片段时长必须大于零"}, status=400)
            target["duration"] = duration
            target["durationRaw"] = f"{duration:g}s"
        if "visual" in body:
            target["visual"] = str(body["visual"] or "")
        if "animation" in body:
            target["animation"] = str(body["animation"] or "")
        if "narration" in body:
            target["narration"] = str(body["narration"] or "")
        if "assets" in body:
            from mona.video_assets import VideoAssetError, validate_asset_references

            assets = body["assets"]
            if not isinstance(assets, list):
                return web.json_response({"error": "assets must be a list"}, status=400)
            try:
                validate_asset_references(project_dir, [str(item) for item in assets])
            except VideoAssetError as exc:
                return web.json_response(exc.to_dict(), status=exc.status_code)
            target["assets"] = [str(item) for item in assets]

        if previous != _scene_content(target):
            meta["scenes"] = scenes
            _invalidate_video_outputs(project_dir, meta, {index}, reset_html=True)
            _video_plan_changed(meta)
            _sync_storyboard(project_dir, scenes)
            _save_video_meta(project_dir, meta)
            _schedule_video_push(name, "scenes")
        return web.json_response({"ok": True, "scene": target, "planRevision": meta.get("planRevision", 0)})
    except Exception as e:
        logger.exception("video scene update error")
        return web.json_response({"error": str(e)}, status=500)


def _replace_video_scene_order(project_dir: Path, meta: dict, ordered: list[dict]) -> None:
    from mona.video_authoring import authored_scene_source_path

    old_scenes = meta.get("scenes") or []
    if meta.get("authoringMode") == "huashu-motion":
        _create_video_project_version(project_dir, label="调整片段顺序前", reason="scene-order-change")
        meta["scenes"] = ordered
        for index, scene in enumerate(ordered, start=1):
            scene["index"] = index
        _invalidate_video_outputs(project_dir, meta, None, reset_html=True)
        _video_plan_changed(meta)
        _sync_storyboard(project_dir, ordered)
        _save_video_meta(project_dir, meta)
        return
    sources = []
    for scene in ordered:
        path = authored_scene_source_path(project_dir, scene)
        if not path.resolve().is_relative_to(project_dir.resolve()):
            raise ValueError("场景源码超出项目范围")
        sources.append((path.read_bytes() if scene.get("authored") and path.is_file() else None,
                        _video_scene_ready(project_dir, scene)))
    _create_video_project_version(project_dir, label="调整片段顺序前", reason="scene-order-change")
    for scene in old_scenes:
        index = int(scene["index"])
        for directory, suffixes in {"scenes": (".html",), "scene_sources": (".html", ".tsx"), "audio": (".mp3", ".timing.json"), "scene_specs": (".json", ".motion.json")}.items():
            for suffix in suffixes:
                path = project_dir / directory / f"scene_{index:02d}{suffix}"
                if not path.resolve().is_relative_to(project_dir.resolve()):
                    raise ValueError("场景文件超出项目范围")
                path.unlink(missing_ok=True)
    meta["scenes"] = ordered
    for index, scene in enumerate(ordered, start=1):
        scene["index"] = index
    _invalidate_video_outputs(project_dir, meta, None, reset_html=True)
    for scene, (source, was_ready) in zip(ordered, sources, strict=True):
        if source is None:
            continue
        path = authored_scene_source_path(project_dir, scene)
        path.write_bytes(source)
        scene.update({"sourcePath": path.relative_to(project_dir).as_posix(), "sourceHash": hashlib.sha256(source).hexdigest()})
        if was_ready:
            from mona.video_authoring import refresh_authored_scene

            refresh_authored_scene(project_dir, scene, meta)
            rendered = project_dir / "scenes" / f"scene_{int(scene['index']):02d}.html"
            scene.update({"htmlStatus": "previewing", "htmlPath": rendered.relative_to(project_dir).as_posix(), "htmlMtime": rendered.stat().st_mtime})
            _write_scene_motion_without_narration(project_dir, scene)
    _video_plan_changed(meta)
    _sync_storyboard(project_dir, ordered)
    _save_video_meta(project_dir, meta)


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
        if not any(scene.get("index") == index for scene in scenes):
            return web.json_response({"error": "片段不存在"}, status=404)
        scenes = [s for s in scenes if s.get("index") != index]
        _replace_video_scene_order(project_dir, meta, scenes)
        _schedule_video_push(name, "scenes")
        return web.json_response({"ok": True, "scenes": scenes, "planRevision": meta.get("planRevision", 0)})
    except Exception as e:
        logger.exception("video scene delete error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_scene_add(request: web.Request) -> web.Response:
    """Append one scene using structured style defaults."""
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
        duration = body.get("duration", 5)
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            return web.json_response({"error": "片段时长必须大于零"}, status=400)
        new_scene = {
            "index": new_index,
            "title": str(body.get("title", "") or "").strip() or f"场景 {new_index}",
            "role": str(body.get("role", "content") or "content"),
            "layout": str(body.get("layout", "content-standard") or "content-standard"),
            "backgroundSlot": str(body.get("backgroundSlot", "content") or "content"),
            "duration": duration,
            "durationRaw": f"{duration:g}s",
            "visual": str(body.get("visual", "") or ""),
            "animation": str(body.get("animation", "") or ""),
            "narration": str(body.get("narration", "") or ""),
            "assets": [],
        }
        if meta.get("authoringMode") == "huashu-motion":
            new_scene.update({"authored": True, "authoredRuntime": "huashu-motion", "layout": "authored"})
        scenes.append(new_scene)
        meta["scenes"] = scenes
        _invalidate_video_outputs(project_dir, meta, {new_index}, reset_html=True)
        _video_plan_changed(meta)
        _sync_storyboard(project_dir, scenes)
        _save_video_meta(project_dir, meta)
        _schedule_video_push(name, "scenes")
        return web.json_response({"ok": True, "scene": new_scene, "planRevision": meta.get("planRevision", 0)})
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
        if any(isinstance(index, bool) or not isinstance(index, int) for index in indices) or set(indices) != set(index_map):
            return web.json_response({"error": "片段顺序无效"}, status=400)
        new_scenes = [index_map[index] for index in indices]
        if indices == [scene["index"] for scene in scenes]:
            return web.json_response({"ok": True, "scenes": scenes, "planRevision": meta.get("planRevision", 0)})
        _replace_video_scene_order(project_dir, meta, new_scenes)
        _schedule_video_push(name, "scenes")
        return web.json_response({"ok": True, "scenes": new_scenes, "planRevision": meta.get("planRevision", 0)})
    except Exception as e:
        logger.exception("video scene reorder error")
        return web.json_response({"error": str(e)}, status=500)


def _write_scene_timeline_artifacts(
    project_dir: Path,
    scene: dict,
    narration: str,
    audio_bytes: bytes | None,
    *,
    boundaries: list[dict[str, Any]],
    timing_source: str | None = None,
    alignment_confidence: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    from mona.video_timeline import (
        build_motion_plan,
        build_subtitle_track,
        summarize_motion_plan,
        write_timeline_json,
    )

    index = int(scene.get("index") or 0)
    if index < 1:
        raise ValueError("scene index is required for timeline artifacts")
    duration_ms = max(300, int(round(float(scene.get("duration") or 5) * 1000)))
    if boundaries:
        duration_ms = max(
            duration_ms,
            int(boundaries[-1].get("endMs") or 0) + 300,
        )
        duration_seconds = max(1, (duration_ms + 999) // 1000)
        scene["duration"] = duration_seconds
        scene["durationRaw"] = f"{duration_seconds}s"
        duration_ms = duration_seconds * 1000
    audio_hash = hashlib.sha256(audio_bytes).hexdigest() if audio_bytes else None
    track = build_subtitle_track(
        narration,
        duration_ms,
        word_timings=boundaries,
        audio_hash=audio_hash,
        timing_source=timing_source,
        alignment_confidence=alignment_confidence,
    )
    allowed_effects: list[str] = []
    intensity = "standard"
    style: dict[str, Any] = {}
    style_path = project_dir / "style" / "design-system.json"
    if style_path.is_file():
        try:
            style = _json.loads(style_path.read_text(encoding="utf-8"))
            allowed_effects = [str(item) for item in style.get("allowedAnimations") or []]
            intensity = str((style.get("motion") or {}).get("intensity") or "standard")
        except Exception:
            pass
    motion = {} if scene.get("authored") else build_motion_plan(
        scene,
        track,
        allowed_effects=allowed_effects or ("fade-rise", "stagger-rise", "soft-pulse", "cross-fade"),
        intensity=intensity,
        motion_preferences=style.get("motion") if style_path.is_file() else None,
    )
    audio_dir = project_dir / "audio"
    specs_dir = project_dir / "scene_specs"
    timing_path = audio_dir / f"scene_{index:02d}.timing.json"
    motion_path = specs_dir / f"scene_{index:02d}.motion.json"
    write_timeline_json(timing_path, track)
    if motion:
        write_timeline_json(motion_path, motion)
    scene["audioTimingPath"] = timing_path.relative_to(project_dir).as_posix()
    scene["audioTimingSource"] = track["timingSource"]
    scene["audioAlignmentConfidence"] = track.get("alignmentConfidence")
    scene["audioTimingHash"] = track["sourceTextHash"]
    if motion:
        scene["motionPlanPath"] = motion_path.relative_to(project_dir).as_posix()
        scene["motionPlanSummary"] = summarize_motion_plan(motion)
    return track, motion


def _write_scene_motion_without_narration(
    project_dir: Path,
    scene: dict[str, Any],
) -> dict[str, Any]:
    if scene.get("authored"):
        return {}
    from mona.video_timeline import (
        build_motion_plan,
        summarize_motion_plan,
        write_timeline_json,
    )

    duration_ms = max(300, int(round(float(scene.get("duration") or 5) * 1000)))
    visual_script = " ".join(
        str(scene.get(key) or "").strip()
        for key in ("title", "onScreenText", "visual", "body")
        if str(scene.get(key) or "").strip()
    ) or f"场景 {scene.get('index') or 1}"
    synthetic_track = {
        "schemaVersion": 1,
        "language": "zh-CN",
        "durationMs": duration_ms,
        "sourceTextHash": hashlib.sha256(visual_script.encode("utf-8")).hexdigest(),
        "audioHash": None,
        "timingSource": "visual-script",
        "alignmentConfidence": None,
        "cues": [
            {
                "id": "cue-01",
                "startMs": 0,
                "endMs": duration_ms,
                "text": visual_script,
                "words": [],
            }
        ],
    }
    allowed_effects: list[str] = []
    intensity = "standard"
    style: dict[str, Any] = {}
    style_path = project_dir / "style" / "design-system.json"
    if style_path.is_file():
        try:
            style = _json.loads(style_path.read_text(encoding="utf-8"))
            allowed_effects = [str(item) for item in style.get("allowedAnimations") or []]
            intensity = str((style.get("motion") or {}).get("intensity") or "standard")
        except Exception:
            pass
    motion = build_motion_plan(
        scene,
        synthetic_track,
        allowed_effects=allowed_effects
        or ("fade-rise", "stagger-rise", "soft-pulse", "cross-fade"),
        intensity=intensity,
        motion_preferences=style.get("motion") if style_path.is_file() else None,
    )
    motion_path = (
        project_dir
        / "scene_specs"
        / f"scene_{int(scene.get('index') or 1):02d}.motion.json"
    )
    write_timeline_json(motion_path, motion)
    scene["motionPlanPath"] = motion_path.relative_to(project_dir).as_posix()
    scene["motionPlanSummary"] = summarize_motion_plan(motion)
    return motion


def _scene_asset_media(project_dir: Path, scene: Mapping[str, Any]) -> list[dict[str, Any]]:
    from mona.video_assets import VideoAssetError, validate_asset_references

    asset_ids = [str(item) for item in scene.get("assets") or [] if str(item)]
    try:
        assets = validate_asset_references(project_dir, asset_ids)
    except VideoAssetError:
        return []
    return [
        {
            "id": asset["id"],
            "kind": asset.get("kind"),
            "path": "../" + str(asset["path"]).replace("\\", "/"),
            "originalName": asset.get("originalName"),
            "alt": asset.get("originalName") or "场景素材",
        }
        for asset in assets
    ]


def _style_brand_logo_path(style: Mapping[str, Any]) -> str | None:
    brand = style.get("brand") if isinstance(style.get("brand"), Mapping) else {}
    logo = brand.get("logo") if isinstance(brand.get("logo"), Mapping) else {}
    preferred = "light" if str(style.get("mode") or "dark") == "dark" else "dark"
    record = logo.get(preferred) or logo.get("dark") or logo.get("light")
    if not isinstance(record, Mapping):
        return None
    path = str(record.get("assetPath") or record.get("path") or "").replace("\\", "/")
    if not path:
        return None
    if path.startswith("assets/"):
        return "../style/" + path
    return None


async def _align_tts_scene_audio(
    audio_path: Path,
    text: str,
) -> tuple[list[dict[str, Any]], str | None, str | None]:
    from mona.api.video_runtime import VideoRuntime
    from mona.video_alignment import align_tts_audio

    runtime = VideoRuntime()
    ffmpeg_path = runtime.get_ffmpeg_path()
    ffprobe_path = runtime.get_ffprobe_path()
    if not ffmpeg_path or not ffprobe_path:
        return [], None, None
    try:
        result = await asyncio.to_thread(
            align_tts_audio,
            audio_path,
            text,
            ffmpeg_path=ffmpeg_path,
            ffprobe_path=ffprobe_path,
        )
    except Exception:
        logger.debug("video TTS acoustic alignment unavailable")
        return [], None, None
    return list(result.boundaries), result.timing_source, result.confidence


def _recompile_series_scene_from_artifacts(
    project_dir: Path, scene: dict, meta: dict
) -> bool:
    from mona.video_scene_compiler import compile_scene_spec

    if scene.get("authored"):
        from mona.video_authoring import refresh_authored_scene

        if not _video_scene_ready(project_dir, scene):
            return False
        return refresh_authored_scene(project_dir, scene, meta)

    index = int(scene.get("index") or 0)
    style_path = project_dir / "style" / "design-system.json"
    spec_path = project_dir / "scene_specs" / f"scene_{index:02d}.json"
    timing_path = project_dir / "audio" / f"scene_{index:02d}.timing.json"
    motion_path = project_dir / "scene_specs" / f"scene_{index:02d}.motion.json"
    if index < 1 or not all(
        path.is_file() for path in (style_path, spec_path, motion_path)
    ):
        return False
    style = _json.loads(style_path.read_text(encoding="utf-8"))
    spec = _json.loads(spec_path.read_text(encoding="utf-8"))
    spec["duration"] = float(scene.get("duration") or spec.get("duration") or 5)
    subtitle_track = _json.loads(timing_path.read_text(encoding="utf-8")) if timing_path.is_file() else None
    motion_plan = _json.loads(motion_path.read_text(encoding="utf-8"))
    background_slot = str(spec.get("backgroundSlot") or "content")
    binding = (meta.get("backgroundBindings") or {}).get(background_slot)
    background_path: str | None = None
    if isinstance(binding, str) and binding:
        background_path = "../" + binding.replace("\\", "/")
    else:
        backgrounds = style.get("backgrounds") or {}
        slot = (backgrounds.get("roles") or {}).get(background_slot) or {}
        default = backgrounds.get("default") or {}
        asset_path = slot.get("assetPath") or default.get("assetPath")
        if isinstance(asset_path, str) and asset_path:
            background_path = "../style/" + asset_path.replace("\\", "/")
    html = compile_scene_spec(
        spec,
        style,
        scene=scene,
        resolution=meta.get("resolution"),
        background_path=background_path,
        motion_plan=motion_plan,
        subtitle_track=subtitle_track,
        asset_media=_scene_asset_media(project_dir, scene),
        brand_logo_path=_style_brand_logo_path(style),
        show_subtitles=meta.get("narrationEnabled", True) and str(meta.get("subtitleMode") or "burned") == "burned",
    )
    target = project_dir / "scenes" / f"scene_{index:02d}.html"
    temporary = target.with_name(f".{target.name}.timeline.tmp")
    temporary.write_text(html, encoding="utf-8")
    os.replace(temporary, target)
    _atomic_write_text(spec_path, _json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    scene["htmlMtime"] = target.stat().st_mtime
    return True


async def _scene_audio_duration(path: Path) -> float:
    from mona.api.video_runtime import VideoRuntime

    ffprobe = VideoRuntime().get_ffprobe_path()
    if not ffprobe:
        return 0.0
    try:
        probe = await _probe_video_output(path, ffprobe)
        return float((probe.get("format") or {}).get("duration") or 0)
    except (RuntimeError, ValueError):
        logger.debug("video narration duration unavailable for {}", path.name)
        return 0.0


async def _extend_scene_for_audio(scene: dict, path: Path) -> bool:
    import math

    duration = await _scene_audio_duration(path)
    current = float(scene.get("duration") or 5)
    if duration <= current:
        return False
    scene["duration"] = math.ceil(duration)
    scene["durationRaw"] = f"{scene['duration']}s"
    return True


class _VideoNarrationInputChangedError(RuntimeError):
    """Narration no longer belongs to the current scene or voice settings."""


def _tts_error_response(exc: TTSError) -> web.Response:
    return web.json_response({"ok": False, "error": str(exc), "code": exc.code, "retryable": exc.retryable},
                             status=503 if exc.code in {"TTS_COMPONENT_MISSING", "TTS_COMPONENT_OUTDATED", "TTS_SERVICE_UNAVAILABLE"} else 422)


def _save_video_narration_meta(project_dir: Path, scene: dict, meta: dict) -> dict:
    current = _load_video_meta(project_dir)
    _require_video_plan_approval(current, meta.get("planRevision", 0), check_revision=True)
    index = int(scene["index"])
    target = next((item for item in current.get("scenes") or [] if item.get("index") == index), None)
    if target is None or target.get("sourceHash") != scene.get("sourceHash"):
        raise _VideoNarrationInputChangedError("制作期间画面已修改，请读取当前片段后再继续")
    target.update(scene)
    if meta.get("outputStale"):
        current["outputStale"] = True
    _save_video_meta(project_dir, current)
    return current


def _video_narration_settings(meta: Mapping[str, Any]) -> tuple[str, dict[str, str]]:
    from mona.providers.tts import TTSError

    provider = str(meta.get("ttsProvider") or "edge").strip() or "edge"
    voice = str(meta.get("ttsVoice") or "").strip()
    settings = {"voice": voice, "rate": str(meta.get("ttsRate") or "+0%").strip() or "+0%"}
    if provider == "edge":
        settings["voice"] = voice or VIDEO_LANGUAGE_PRESETS.get(
            str(meta.get("language") or "zh-CN"), VIDEO_LANGUAGE_PRESETS["zh-CN"]
        )["edgeVoice"]
        return provider, settings
    if provider not in {"custom", "minimax", "cosyvoice"}:
        raise TTSError("所选配音服务不受支持，请检查配音服务设置。", code="TTS_PROVIDER_UNSUPPORTED")

    from mona.config.loader import load_config

    channels = load_config().channels
    # Existing projects with local credentials retain their original protocol.
    if provider == "custom" and not (meta.get("ttsApiBase") or meta.get("ttsApiKey")):
        provider = str(channels.tts_provider or "").strip()
        if provider not in {"custom", "minimax", "cosyvoice"}:
            raise TTSError("请先在设置中配置你的配音服务，或选择内置声音。", code="TTS_CONFIGURATION_REQUIRED")
    settings.update({
        "api_key": str(meta.get("ttsApiKey") or channels.tts_api_key or "").strip(),
        "api_base": str(meta.get("ttsApiBase") or channels.tts_api_base or "").strip().rstrip("/"),
        "model": str(meta.get("ttsModel") or channels.tts_model or "").strip(),
        "voice": voice if voice and voice != "zh-CN-XiaoyiNeural" else str(channels.tts_voice or "").strip(),
    })
    if settings["voice"] == "zh-CN-XiaoyiNeural":
        settings["voice"] = ""
    if provider == "minimax":
        settings["api_key"] = settings["api_key"] or os.environ.get("MINIMAX_API_KEY", "")
        settings["api_base"] = settings["api_base"] or os.environ.get("MINIMAX_TTS_BASE_URL", "")
    elif provider == "cosyvoice":
        settings["api_key"] = settings["api_key"] or os.environ.get("COSYVOICE_API_KEY") or os.environ.get("DASHSCOPE_API_KEY", "")
        settings["api_base"] = settings["api_base"] or os.environ.get("COSYVOICE_TTS_BASE_URL", "")
    if not settings["api_key"] or (provider == "custom" and not settings["api_base"]):
        raise TTSError("请先在设置中配置你的配音服务，或选择内置声音。", code="TTS_CONFIGURATION_REQUIRED")
    return provider, settings


async def handle_video_voice_preview(request: web.Request) -> web.Response:
    """POST /api/video/voice-preview - synthesize a fixed sample for voice selection."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "试音设置格式无效"}, status=400)
    if not isinstance(body, Mapping):
        return web.json_response({"ok": False, "error": "试音设置格式无效"}, status=400)

    allowed = {"ttsProvider", "ttsVoice", "ttsRate"}
    if set(body) - allowed:
        return web.json_response({"ok": False, "error": "试音仅支持音色和语速设置"}, status=400)
    try:
        settings = _video_settings_payload(body)
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

    meta = {"language": "zh-CN", **settings}
    try:
        provider_name, provider_settings = _video_narration_settings(meta)
        from mona.providers.tts import get_tts_provider

        provider = get_tts_provider(provider_name, **provider_settings)
        audio_bytes = await provider.synthesize_to_bytes(
            "你好，我是 Mona。这是我的声音，你可以听听是否适合这个视频。",
            voice=provider_settings["voice"],
        )
        if not audio_bytes:
            raise TTSError(
                "试音没有生成声音，请稍后重试。",
                code="TTS_SERVICE_UNAVAILABLE",
                retryable=True,
            )
        return web.Response(
            body=audio_bytes,
            content_type="audio/mpeg",
            headers={"Cache-Control": "no-cache"},
        )
    except TTSError as exc:
        return _tts_error_response(exc)


async def _synthesize_scene_narration(
    project_dir: Path,
    scene: dict,
    meta: dict,
    *,
    force: bool = False,
) -> bytes | None:
    """Synthesize TTS audio for one scene's narration into audio/scene_NN.mp3.

    缓存策略：合成成功后把文件 mtime 记到 scene["audioMtime"]；下次调用若
    文件 mtime 与 audioMtime 匹配（说明场景内容未变——内容变更路径会经
    _invalidate_video_outputs 清掉 audioMtime），直接读缓存返回。
    force=True 跳过缓存（前端"重新合成"语义）。

    Returns audio bytes, or None on failure / empty narration.
    """
    _require_video_plan_approval(meta)
    index = int(scene.get("index") or 0)
    text = (scene.get("narration") or "").strip()
    if index < 1 or not text:
        return None

    audio_dir = project_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    cache_path = audio_dir / f"scene_{index:02d}.mp3"
    timing_path = audio_dir / f"scene_{index:02d}.timing.json"
    storyboard_path = project_dir / "storyboard.md"
    provider_name, provider_settings = _video_narration_settings(meta)
    voice, rate = provider_settings["voice"], provider_settings["rate"]

    def input_version() -> tuple[dict[str, Any], bytes | None]:
        current = _load_video_meta(project_dir)
        inputs = {key: current.get(key) for key in (
            "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode", "resolution", "styleVersion", "language",
            "requirePlanApproval", "planRevision", "approvedPlanRevision"
        )}
        # Include effective global configuration without persisting credentials.
        inputs["ttsSettingsHash"] = hashlib.sha256(
            _json.dumps(_video_narration_settings(current or meta), sort_keys=True).encode("utf-8")
        ).hexdigest()
        inputs["scenes"] = [_scene_content(item) for item in current.get("scenes") or []]
        return inputs, storyboard_path.read_bytes() if storyboard_path.is_file() else None

    input_versions = input_version()

    def ensure_inputs_current() -> None:
        if input_versions != input_version():
            raise _VideoNarrationInputChangedError("配音期间分镜或声音设置已修改，请重新试听或预览")

    input_hash = hashlib.sha256(
        _json.dumps(
            {"text": text, "provider": provider_name, **provider_settings},
            sort_keys=True, ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()

    if not force and cache_path.is_file():
        try:
            mtime = cache_path.stat().st_mtime
            if scene.get("audioMtime") == mtime and (
                scene.get("audioInputHash") == input_hash
                or (provider_name == "edge" and scene.get("audioInputHash") is None)
            ):
                audio_bytes = cache_path.read_bytes()
                duration_changed = await _extend_scene_for_audio(scene, cache_path)
                cached_track = (
                    _json.loads(timing_path.read_text(encoding="utf-8"))
                    if timing_path.is_file()
                    else None
                )
                from mona.video_timeline import SUBTITLE_GROUPING_VERSION

                regroup_cached_timing = (
                    cached_track is not None
                    and cached_track.get("groupingVersion") != SUBTITLE_GROUPING_VERSION
                )
                rebuild_timing = cached_track is None or duration_changed or regroup_cached_timing
                if rebuild_timing:
                    scene.pop("motionReviewSourceHash", None)
                    scene.pop("motionReview", None)
                    if cached_track is not None:
                        boundaries = [word for cue in cached_track.get("cues", []) for word in cue.get("words", [])]
                        timing_source, confidence = cached_track.get("timingSource"), cached_track.get("alignmentConfidence")
                    else:
                        boundaries, timing_source, confidence = await _align_tts_scene_audio(cache_path, text)
                    ensure_inputs_current()
                    _write_scene_timeline_artifacts(
                        project_dir,
                        scene,
                        text,
                        audio_bytes,
                        boundaries=boundaries,
                        timing_source=timing_source,
                        alignment_confidence=confidence,
                    )
                    _recompile_series_scene_from_artifacts(
                        project_dir, scene, meta
                    )
                if duration_changed:
                    _sync_storyboard(project_dir, meta.get("scenes") or [scene])
                if rebuild_timing:
                    if (project_dir / "renders" / "output.mp4").is_file():
                        meta["outputStale"] = True
                else:
                    ensure_inputs_current()
                scene["audioInputHash"] = input_hash
                return audio_bytes
        except OSError:
            pass

    from mona.providers.tts import (
        EdgeTTSProvider,
        TTSSynthesisResult,
        get_tts_provider,
    )

    if provider_name == "edge":
        provider = EdgeTTSProvider(
            voice=voice or "zh-CN-XiaoyiNeural", rate=rate
        )
    else:
        provider = get_tts_provider(provider_name, **provider_settings)

    synthesize_with_timings = getattr(provider, "synthesize_with_timings", None)
    if callable(synthesize_with_timings):
        synthesis = await synthesize_with_timings(text, voice=voice)
        if synthesis is None:
            return None
    else:
        synthesis = None
    if isinstance(synthesis, TTSSynthesisResult):
        audio_bytes = synthesis.audio
        boundaries = list(synthesis.boundaries)
        timing_source = synthesis.timing_source if boundaries else None
    else:
        audio_bytes = await provider.synthesize_to_bytes(text, voice=voice)
        boundaries = []
        timing_source = None
    if not audio_bytes:
        return None

    temporary_audio = audio_dir / f".scene_{index:02d}.{uuid.uuid4().hex}.mp3"
    try:
        ensure_inputs_current()
        temporary_audio.write_bytes(audio_bytes)
        duration_changed = await _extend_scene_for_audio(scene, temporary_audio)
        alignment_confidence: str | None = None
        if not boundaries:
            boundaries, timing_source, alignment_confidence = (
                await _align_tts_scene_audio(temporary_audio, text)
            )
        ensure_inputs_current()
        temporary_audio.replace(cache_path)
        scene.pop("motionReviewSourceHash", None)
        scene.pop("motionReview", None)
        scene["audioMtime"] = cache_path.stat().st_mtime
        scene["audioInputHash"] = input_hash
        _write_scene_timeline_artifacts(
            project_dir,
            scene,
            text,
            audio_bytes,
            boundaries=boundaries,
            timing_source=timing_source,
            alignment_confidence=alignment_confidence,
        )
        _recompile_series_scene_from_artifacts(project_dir, scene, meta)
        if (project_dir / "renders" / "output.mp4").is_file():
            meta["outputStale"] = True
        if duration_changed:
            _sync_storyboard(project_dir, meta.get("scenes") or [scene])
    except Exception:
        logger.exception("video narration artifacts could not be saved for scene {}", index)
        raise
    finally:
        temporary_audio.unlink(missing_ok=True)
    return audio_bytes


async def handle_video_project_scene_narration(request: web.Request) -> web.Response:
    """GET/POST /api/video/project/scene/narration with name and index.

    Synthesize TTS for a single scene's narration text. Returns the audio
    bytes directly (audio/mpeg) so the frontend can play via <audio>.
    """
    if request.method == "GET":
        body = request.query
    else:
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

        try:
            _require_video_plan_approval(meta)
        except ValueError as exc:
            cached = project_dir / "audio" / f"scene_{index:02d}.mp3"
            if request.method == "GET" and cached.is_file() and target.get("audioMtime") == cached.stat().st_mtime:
                return web.Response(body=cached.read_bytes(), content_type="audio/mpeg", headers={"Cache-Control": "no-cache"})
            return web.json_response({"error": str(exc), "code": "PLAN_CONFIRMATION_REQUIRED"}, status=409)

        provider_name = str(meta.get("ttsProvider") or "edge").strip() or "edge"
        if provider_name == "custom":
            # custom 缺少凭据时辅助函数返回 None；提前给出可读错误
            from mona.config.loader import load_config

            try:
                channels_cfg = load_config().channels
            except Exception:
                channels_cfg = None
            has_creds = (
                str(meta.get("ttsApiBase") or "").strip()
                or str(getattr(channels_cfg, "tts_api_base", "") or "").strip()
            ) and (
                str(meta.get("ttsApiKey") or "").strip()
                or str(getattr(channels_cfg, "tts_api_key", "") or "").strip()
            )
            if not has_creds:
                return web.json_response(
                    {"error": "custom TTS requires apiBase/apiKey — 请在设置页配置语音合成"},
                    status=409,
                )

        regenerate = str(body.get("regenerate", "")).lower() in {"1", "true", "yes"}
        audio_bytes = await _synthesize_scene_narration(
            project_dir, target, meta, force=regenerate
        )
        if audio_bytes is None:
            return web.json_response(
                {"error": "TTS synthesis failed"}, status=502
            )

        # Persist audioMtime for cache validation on later calls
        _save_video_narration_meta(project_dir, target, meta)

        return web.Response(
            body=audio_bytes,
            content_type="audio/mpeg",
            headers={
                "Cache-Control": "no-cache",
                "Content-Disposition": f'inline; filename="scene_{index:02d}.mp3"',
            },
        )
    except _VideoNarrationInputChangedError:
        return web.json_response({"error": "配音期间分镜或声音设置已修改，请重新试听", "code": "NARRATION_INPUT_CHANGED"}, status=409)
    except TTSError as exc:
        return _tts_error_response(exc)
    except Exception as e:
        logger.exception("video scene narration error")
        return web.json_response({"error": str(e)}, status=500)


def _video_skill_dir() -> Path:
    return Path(__file__).parent.parent / "skills" / "mona-motion"


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
        meta = _load_video_meta(project_dir)
        target = next((scene for scene in meta.get("scenes") or [] if scene.get("index") == index), None)
        if not scene_path.is_file() or (target is not None and target.get("htmlStatus") in ("pending", "generating")):
            return web.json_response(
                {"error": "当前分镜尚未生成画面，请先生成场景", "needsGeneration": True},
                status=404,
            )
        scene_html = scene_path.read_text(encoding="utf-8")

        resolution = str(meta.get("resolution") or "1920x1080@30fps")
        res_match = re.match(r"(\d+)\s*x\s*(\d+)", resolution)
        if res_match:
            width, height = int(res_match.group(1)), int(res_match.group(2))
        else:
            width, height = 1920, 1080

        preview_html = _prepare_scene_html_for_preview(
            scene_html, name, width, height, project_dir=project_dir
        )
        return web.Response(
            body=preview_html.encode("utf-8"),
            content_type="text/html",
            charset="utf-8",
        )
    except Exception as e:
        logger.exception("video scene preview error")
        return web.json_response({"error": str(e)}, status=500)


# ---------------------------------------------------------------------------
# Video export (Phase 3)
# ---------------------------------------------------------------------------

# In-memory tracking of active render tasks (keyed by project name).
_video_render_tasks: dict[str, asyncio.Task] = {}
_video_render_cancel_events: dict[str, threading.Event] = {}


class _VideoRenderCancelledError(RuntimeError):
    pass


def _raise_if_video_render_cancelled(cancel_event: threading.Event) -> None:
    if cancel_event.is_set():
        raise _VideoRenderCancelledError("视频导出已取消")


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
    temporary = status_file.with_name(
        f".{status_file.name}.{uuid.uuid4().hex}.tmp"
    )
    try:
        temporary.write_text(
            _json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        replace_file_with_retry(temporary, status_file)
    finally:
        temporary.unlink(missing_ok=True)


def _commit_render_output(project_dir: Path, result: dict[str, Any]) -> None:
    output_value = str(result.get("output") or "")
    candidate = project_dir / output_value if output_value else None
    final_output = project_dir / "renders" / "output.mp4"
    if candidate is not None and candidate.name == "output.pending.mp4":
        if not candidate.is_file() or candidate.stat().st_size <= 0:
            raise RuntimeError("渲染输出为空，未替换已有视频")
        candidate.replace(final_output)
        result["output"] = final_output.relative_to(project_dir).as_posix()
        result["absolute_output"] = str(final_output)


def _cleanup_render_temporary_files(project_dir: Path) -> None:
    renders_dir = project_dir / "renders"
    for name in (
        "output.pending.mp4",
        "silent.pending.mp4",
        "hyperframes-silent.mp4",
    ):
        (renders_dir / name).unlink(missing_ok=True)


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


async def _write_video_delivery_artifacts(
    project_dir: Path,
    meta: dict[str, Any],
    render_result: dict[str, Any],
    engine: str,
    cancel_event: threading.Event,
    release_type: str = "draft",
) -> dict[str, Any]:
    from mona.api.video_runtime import VideoRuntime
    from mona.video_timeline import (
        subtitle_cues_to_srt,
        subtitle_cues_to_vtt,
        validate_motion_plan,
        validate_subtitle_track,
        write_timeline_json,
    )

    renders_dir = project_dir / "renders"
    output_value = str(render_result.get("output") or "renders/output.mp4")
    output = project_dir / output_value
    if not output.is_file() or output.stat().st_size <= 0:
        raise RuntimeError("无法生成交付物：视频输出不存在")
    scenes = list(meta.get("scenes") or [])
    cues: list[dict[str, Any]] = []
    timing_sources: dict[str, int] = {}
    alignment_review_scenes: list[int] = []
    warnings: list[str] = []
    missing_motion: list[int] = []
    referenced_asset_ids: set[str] = set()
    scene_asset_usage: dict[str, list[int]] = {}
    background_asset_usage = {
        str(role): str(asset_id)
        for role, asset_id in (meta.get("backgroundRegistryIds") or {}).items()
        if str(asset_id)
    }
    referenced_asset_ids.update(background_asset_usage.values())
    style_asset_usage = {
        str(role): str(asset_id)
        for role, asset_id in (meta.get("styleAssetRegistryIds") or {}).items()
        if str(asset_id)
    }
    referenced_asset_ids.update(style_asset_usage.values())
    music_asset_id = str(meta.get("musicAssetId") or "")
    if music_asset_id:
        referenced_asset_ids.add(music_asset_id)
    offset_ms = 0
    for scene in scenes:
        _raise_if_video_render_cancelled(cancel_event)
        index = int(scene.get("index") or 0)
        scene_duration_ms = max(
            300, int(round(float(scene.get("duration") or 5) * 1000))
        )
        timing_path = project_dir / "audio" / f"scene_{index:02d}.timing.json"
        if timing_path.is_file():
            track = _json.loads(timing_path.read_text(encoding="utf-8"))
            validate_subtitle_track(track)
            source = str(track.get("timingSource") or "missing")
            timing_sources[source] = timing_sources.get(source, 0) + 1
            if (
                source == "acoustic-sentence-alignment"
                and track.get("alignmentConfidence") != "high"
            ):
                alignment_review_scenes.append(index)
            for cue in track.get("cues") or []:
                cues.append(
                    {
                        "sceneIndex": index,
                        "startMs": offset_ms + int(cue["startMs"]),
                        "endMs": offset_ms + int(cue["endMs"]),
                        "text": str(cue["text"]),
                    }
                )
        elif str(scene.get("narration") or "").strip():
            timing_sources["missing"] = timing_sources.get("missing", 0) + 1
        motion_path = project_dir / "scene_specs" / f"scene_{index:02d}.motion.json"
        if scene.get("authored"):
            pass
        elif motion_path.is_file():
            validate_motion_plan(
                _json.loads(motion_path.read_text(encoding="utf-8"))
            )
        else:
            missing_motion.append(index)
        for item in scene.get("assets") or []:
            asset_id = str(item)
            if not asset_id:
                continue
            referenced_asset_ids.add(asset_id)
            scene_asset_usage.setdefault(asset_id, []).append(index)
        offset_ms += scene_duration_ms

    if timing_sources.get("estimated"):
        warnings.append(
            f"{timing_sources['estimated']} 个场景使用估算字幕时间，请在正式发布前复核"
        )
    if timing_sources.get("missing"):
        warnings.append(f"{timing_sources['missing']} 个有旁白的场景缺少字幕时间轴")
    if alignment_review_scenes:
        warnings.append(
            f"{len(alignment_review_scenes)} 个场景的声学句级对齐需要人工复核"
        )
    if missing_motion:
        warnings.append(f"{len(missing_motion)} 个场景缺少语义动画计划")

    from mona.video_assets import list_project_assets

    registered_assets = {
        str(item.get("id")): item for item in list_project_assets(project_dir)
    }
    missing_assets = sorted(referenced_asset_ids - set(registered_assets))
    rights_issues = [
        {
            "assetId": asset_id,
            "name": registered_assets[asset_id].get("originalName"),
            "code": "ASSET_RIGHTS_UNCONFIRMED",
        }
        for asset_id in sorted(referenced_asset_ids & set(registered_assets))
        if registered_assets[asset_id].get("rightsStatus") == "unknown"
        or not registered_assets[asset_id].get("commercialUse")
    ]
    if missing_assets:
        warnings.append(f"{len(missing_assets)} 个场景素材未进入项目素材台账")
    if rights_issues:
        warnings.append(f"{len(rights_issues)} 个已使用素材尚未确认商业使用权")

    subtitle_mode = str(meta.get("subtitleMode") or "burned")
    srt_path = renders_dir / "subtitles.srt"
    vtt_path = renders_dir / "subtitles.vtt"
    artifacts: dict[str, str] = {"mp4": "renders/output.mp4"}
    if subtitle_mode != "off":
        _atomic_write_text(srt_path, subtitle_cues_to_srt(cues))
        _atomic_write_text(vtt_path, subtitle_cues_to_vtt(cues))
        artifacts.update(
            {"srt": "renders/subtitles.srt", "vtt": "renders/subtitles.vtt"}
        )
    else:
        srt_path.unlink(missing_ok=True)
        vtt_path.unlink(missing_ok=True)
    rights_report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now().isoformat(),
        "usedAssetIds": sorted(referenced_asset_ids),
        "sceneUsage": scene_asset_usage,
        "backgroundUsage": background_asset_usage,
        "styleAssetUsage": style_asset_usage,
        "musicUsage": (
            {"preset": meta.get("musicPreset"), "assetId": music_asset_id}
            if music_asset_id
            else None
        ),
        "missingAssetIds": missing_assets,
        "rightsIssues": rights_issues,
        "assets": [
            registered_assets[asset_id]
            for asset_id in sorted(referenced_asset_ids & set(registered_assets))
        ],
    }
    rights_path = renders_dir / "asset-rights.json"
    write_timeline_json(rights_path, rights_report)
    artifacts["assetRights"] = "renders/asset-rights.json"
    ffmpeg_path = VideoRuntime().get_ffmpeg_path()
    audio_path = renders_dir / "audio.m4a"
    audio_path.unlink(missing_ok=True)
    if ffmpeg_path and render_result.get("audio"):
        audio_process = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-nostdin",
            "-y",
            "-i",
            str(output),
            "-vn",
            "-c:a",
            "copy",
            str(audio_path),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
        )
        _, audio_stderr = await _communicate_video_subprocess(
            audio_process, cancel_event
        )
        if audio_process.returncode == 0 and audio_path.is_file():
            artifacts["audio"] = "renders/audio.m4a"
        else:
            warnings.append(
                "纯音频提取失败："
                + (audio_stderr or b"").decode("utf-8", "replace")[-160:]
            )
    cover_path = renders_dir / "cover.png"
    cover_path.unlink(missing_ok=True)
    if ffmpeg_path:
        cover_process = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-nostdin",
            "-y",
            "-ss",
            "0.1",
            "-i",
            str(output),
            "-frames:v",
            "1",
            str(cover_path),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
        )
        _, cover_stderr = await _communicate_video_subprocess(
            cover_process, cancel_event
        )
        if cover_process.returncode == 0 and cover_path.is_file():
            artifacts["cover"] = "renders/cover.png"
        else:
            warnings.append(
                "封面提取失败："
                + (cover_stderr or b"").decode("utf-8", "replace")[-160:]
            )
    else:
        warnings.append("未找到 FFmpeg，无法生成封面")

    report = {
        "schemaVersion": 1,
        "scope": "technical-delivery",
        "creativeQualityCertified": False,
        "generatedAt": datetime.now().isoformat(),
        "status": "warning" if warnings else "passed",
        "project": meta.get("name") or project_dir.name,
        "projectVersion": meta.get("projectVersion", 1),
        "styleVersion": meta.get("styleVersion"),
        "releaseType": release_type,
        "renderer": {
            "engine": engine,
            "hyperframesVersion": "0.8.16" if engine == "hyperframes" else None,
        },
        "output": {
            "duration": render_result.get("duration"),
            "fps": render_result.get("fps"),
            "resolution": render_result.get("resolution"),
            "totalFrames": render_result.get("total_frames"),
            "audio": render_result.get("audio"),
            "bytes": output.stat().st_size,
        },
        "checks": {
            "sceneCount": len(scenes),
            "subtitleCueCount": len(cues),
            "subtitleMode": subtitle_mode,
            "subtitleTimingSources": timing_sources,
            "alignmentReviewScenes": alignment_review_scenes,
            "motionPlanMissingScenes": missing_motion,
            "missingAssetIds": missing_assets,
            "assetRightsIssues": rights_issues,
        },
        "warnings": warnings,
    }
    report_path = renders_dir / "quality-report.json"
    write_timeline_json(report_path, report)
    artifacts["report"] = "renders/quality-report.json"

    package_path = renders_dir / "delivery.zip"
    package_temporary = renders_dir / f".delivery.{uuid.uuid4().hex}.tmp"
    try:
        with zipfile.ZipFile(package_temporary, "w", compression=zipfile.ZIP_STORED) as archive:
            for kind, relative in artifacts.items():
                _raise_if_video_render_cancelled(cancel_event)
                source = output if kind == "mp4" else project_dir / relative
                if source.is_file():
                    archive.write(
                        source,
                        arcname="output.mp4" if kind == "mp4" else source.name,
                    )
        package_temporary.replace(package_path)
    finally:
        package_temporary.unlink(missing_ok=True)
    artifacts["package"] = "renders/delivery.zip"
    return {
        "artifacts": artifacts,
        "qualityStatus": report["status"],
        "warnings": warnings,
    }


def _prepare_hyperframes_snapshot(
    project_dir: Path, snapshot_scenes_dir: Path
) -> Path:
    import importlib.util

    target = snapshot_scenes_dir.parent / "hyperframes"
    if target.is_dir():
        shutil.rmtree(target)
    shutil.copytree(snapshot_scenes_dir, target / "scenes")
    for file_name in ("storyboard.md", "meta.json"):
        source = project_dir / file_name
        if source.is_file():
            shutil.copyfile(source, target / file_name)
    for directory_name in ("assets", "style"):
        source = project_dir / directory_name
        if source.is_dir():
            shutil.copytree(source, target / directory_name)

    script = _video_skill_dir() / "scripts" / "merge_scenes.py"
    module_spec = importlib.util.spec_from_file_location(
        "mona_video_hyperframes_merge", script
    )
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError("merge_scenes.py module spec load failed")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    result = module.main(target)
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "HyperFrames composition build failed")
    return target


async def _communicate_video_subprocess(
    process: asyncio.subprocess.Process,
    cancel_event: threading.Event | None = None,
    *,
    timeout: float = 120.0,
) -> tuple[bytes, bytes]:
    communicate = asyncio.create_task(process.communicate())
    deadline = asyncio.get_running_loop().time() + timeout
    try:
        while not communicate.done():
            if cancel_event is not None and cancel_event.is_set():
                raise _VideoRenderCancelledError("视频导出已取消")
            if asyncio.get_running_loop().time() >= deadline:
                logger.error("Video post-processing timed out after {} seconds", timeout)
                raise TimeoutError("视频处理超时，已停止，请重试导出")
            await asyncio.sleep(0.1)
        return await communicate
    except (asyncio.CancelledError, _VideoRenderCancelledError, TimeoutError):
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
        communicate.cancel()
        await asyncio.gather(communicate, return_exceptions=True)
        raise


async def _probe_video_output(
    path: Path,
    ffprobe_path: str,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=0x08000000 if sys.platform == "win32" else 0,
    )
    stdout, stderr = await _communicate_video_subprocess(process, cancel_event)
    if process.returncode != 0:
        raise RuntimeError(
            (stderr or b"").decode("utf-8", "replace")
            or "FFprobe output validation failed"
        )
    return _json.loads((stdout or b"").decode("utf-8", "replace"))


async def _video_output_has_audio(
    path: Path,
    ffprobe_path: str,
    cancel_event: threading.Event | None = None,
) -> bool:
    process = await asyncio.create_subprocess_exec(
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        str(path),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=0x08000000 if sys.platform == "win32" else 0,
    )
    stdout, _stderr = await _communicate_video_subprocess(process, cancel_event)
    return process.returncode == 0 and bool((stdout or b"").strip())


async def _validate_rendered_video(
    project_dir: Path,
    meta: Mapping[str, Any],
    result: dict[str, Any],
    cancel_event: threading.Event,
) -> None:
    from mona.api.video_runtime import VideoRuntime

    output = (project_dir / str(result.get("output") or "renders/output.pending.mp4")).resolve()
    if not output.is_relative_to(project_dir.resolve()) or not output.is_file():
        raise RuntimeError("导出的视频文件缺失，请重试导出")
    ffprobe = VideoRuntime().get_ffprobe_path()
    if not ffprobe:
        raise RuntimeError("视频检查组件尚未就绪，请完成视频组件准备后重试")
    try:
        probe = await _probe_video_output(output, ffprobe, cancel_event)
        has_audio = await _video_output_has_audio(output, ffprobe, cancel_event)
        streams = probe.get("streams") or []
        video = streams[0] if streams else {}
        duration = float((probe.get("format") or {}).get("duration") or 0)
        rate_parts = str(video.get("r_frame_rate") or "0/1").split("/")
        fps = float(rate_parts[0]) / float(rate_parts[1]) if len(rate_parts) == 2 else float(rate_parts[0])
    except _VideoRenderCancelledError:
        raise
    except Exception as exc:
        logger.exception("video output probe failed")
        raise RuntimeError("导出的视频无法读取，请重试导出") from exc
    if not video or duration <= 0 or fps <= 0:
        raise RuntimeError("导出的视频没有有效画面，请重新生成场景后重试")
    scenes = meta.get("scenes") or []
    expected = sum(float(scene.get("duration") or 5) for scene in scenes)
    tolerance = max(0.15, len(scenes) * 2 / fps)
    if expected and abs(duration - expected) > tolerance:
        raise RuntimeError("导出的视频时长与分镜不一致，已停止交付，请重试导出")
    if meta.get("narrationEnabled") and any(str(scene.get("narration") or "").strip() for scene in scenes) and not has_audio:
        raise RuntimeError("旁白未加入视频，视频未导出。请重试导出。")
    result.update({
        "audio": has_audio, "duration": round(duration, 3), "fps": fps,
        "resolution": [int(video.get("width") or 0), int(video.get("height") or 0)],
        "total_frames": round(duration * fps),
    })


async def _mix_project_audio(
    project_dir: Path,
    meta: Mapping[str, Any],
    render_result: dict[str, Any],
    cancel_event: threading.Event,
) -> None:
    scenes = meta.get("scenes") or []
    has_narration = bool(meta.get("narrationEnabled")) and any(
        str(scene.get("narration") or "").strip() for scene in scenes
    )
    voice_path = project_dir / "audio" / "narration.mp3" if has_narration else None
    if has_narration and (voice_path is None or not voice_path.is_file()):
        raise RuntimeError("旁白未能合成，视频未导出。请试听旁白后重试导出。")

    tracks = meta.get("audioTracks")
    music_requested = (meta.get("musicPreset") or "none") != "none"
    if not has_narration and not music_requested and not tracks:
        return

    from mona.api.video_audio import mix_project_audio
    from mona.api.video_runtime import VideoRuntime
    output_value = render_result.get("output") or "renders/output.pending.mp4"
    project_root = project_dir.resolve()
    try:
        output = (project_dir / str(output_value)).resolve(strict=True)
        output.relative_to(project_root)
    except (OSError, ValueError) as exc:
        raise RuntimeError("视频导出失败：画面文件不存在或路径无效，无法合成声音。请重试。") from exc
    if not output.is_file():
        raise RuntimeError("视频导出失败：画面文件不存在，无法合成声音。请重试。")

    duration = float(render_result.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("视频导出失败：视频时长无效，无法合成声音。请重试。")

    render_dir = (project_dir / "renders").resolve(strict=True)
    try:
        render_dir.relative_to(project_root)
    except ValueError as exc:
        raise RuntimeError("视频导出失败：渲染目录路径无效，无法合成声音。请重试。") from exc
    audio_mix = render_dir / "audio-mix.pending.m4a"
    muxed_output = render_dir / "audio-mixed.pending.mp4"
    audio_mix.unlink(missing_ok=True)
    muxed_output.unlink(missing_ok=True)
    try:
        await mix_project_audio(
            project_dir,
            meta,
            audio_mix,
            voice_path=voice_path,
            cancel_event=cancel_event,
        )
        ffmpeg_path = VideoRuntime().get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("声音处理组件尚未就绪，请准备视频组件后重试。")
        mux_started = time.monotonic()
        logger.info("Video audio mux started (duration={}s)", duration)
        process = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-nostdin",
            "-y",
            "-i",
            str(output),
            "-i",
            str(audio_mix),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map_metadata",
            "0",
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-t",
            str(duration),
            "-movflags",
            "+faststart",
            str(muxed_output),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
        )
        _, _stderr = await _communicate_video_subprocess(process, cancel_event)
        if process.returncode != 0 or not muxed_output.is_file() or muxed_output.stat().st_size <= 0:
            logger.error("Video audio mux failed (exit code {})", process.returncode)
            raise RuntimeError("视频导出失败：声音未能合成，已保留当前内容，请重试。")
        logger.info("Video audio mux finished in {:.3f}s", time.monotonic() - mux_started)
        muxed_output.replace(output)
        render_result["audio"] = True
    except _VideoRenderCancelledError:
        raise
    except TimeoutError as exc:
        raise RuntimeError("视频导出失败：合并声音超时，已停止，请重试导出。") from exc
    except Exception as exc:
        if cancel_event.is_set():
            raise _VideoRenderCancelledError("视频导出已取消") from exc
        if isinstance(exc, RuntimeError):
            message = str(exc)
            if message.startswith(("旁白", "视频导出失败")):
                raise
            if message.startswith("声音处理组件"):
                raise RuntimeError(f"视频导出失败：{message}") from exc
        logger.error("Video audio export failed ({})", type(exc).__name__)
        raise RuntimeError("视频导出失败：声音未能合成，已保留当前内容，请重试。") from exc
    finally:
        audio_mix.unlink(missing_ok=True)
        muxed_output.unlink(missing_ok=True)


async def _run_hyperframes_engine(
    project_dir: Path,
    snapshot_scenes_dir: Path,
    fps: int,
    quality: str,
    progress_cb: Callable[[str, float, str], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    import importlib.util

    from mona.api.video_runtime import VideoRuntime

    runtime = VideoRuntime()
    ffmpeg_path = runtime.get_ffmpeg_path()
    ffprobe_path = runtime.get_ffprobe_path()
    browser_path = runtime.get_chrome_path()
    if not ffmpeg_path or not ffprobe_path or not browser_path:
        return {
            "ok": False,
            "error": "HyperFrames runtime requires Node, Chrome, FFmpeg and FFprobe",
        }
    node_path = runtime.get_node_path()
    npx_path = runtime.get_npx_path()
    if not node_path or not npx_path:
        return {"ok": False, "error": "HyperFrames runtime requires Node and npx"}
    hyperframes_root = _prepare_hyperframes_snapshot(
        project_dir, snapshot_scenes_dir
    )
    script = _video_skill_dir() / "scripts" / "hyperframes_cli.py"
    module_spec = importlib.util.spec_from_file_location(
        "mona_video_hyperframes_cli", script
    )
    if module_spec is None or module_spec.loader is None:
        return {"ok": False, "error": "HyperFrames CLI module load failed"}
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    cli = module.HyperframesCLI(hyperframes_root, runtime, cancel_event)
    if progress_cb:
        progress_cb("rendering", 18, "正在检查视频内容...")
    checked = await cli.check(samples=9)
    if checked.get("cancelled"):
        return checked
    if not checked.get("ok"):
        return {
            "ok": False,
            "error": "HyperFrames check failed",
            "details": checked,
        }
    actual_fps = fps if fps > 0 else {"draft": 24, "standard": 30, "high": 60}[quality]
    hyperframes_output = hyperframes_root / "renders" / "hyperframes-silent.mp4"
    silent_output = project_dir / "renders" / "hyperframes-silent.mp4"
    if progress_cb:
        progress_cb("rendering", 25, "正在生成视频画面...")
    rendered = await cli.render(
        "renders/hyperframes-silent.mp4",
        quality=quality,
        fps=actual_fps,
        workers=1,
        progress_cb=(
            (
                lambda percent, message: progress_cb(
                    "rendering",
                    round(25 + min(100, max(0, percent)) * 0.65, 1),
                    "正在生成视频画面...",
                )
            )
            if progress_cb
            else None
        ),
    )
    if rendered.get("cancelled"):
        return rendered
    if not rendered.get("ok") or not hyperframes_output.is_file():
        return {
            "ok": False,
            "error": "HyperFrames render failed",
            "details": rendered,
        }
    silent_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(hyperframes_output), silent_output)
    if progress_cb:
        progress_cb("encoding", 92, "正在校验视频输出...")
    probe = await _probe_video_output(silent_output, ffprobe_path, cancel_event)
    streams = probe.get("streams") or []
    stream = streams[0] if streams else {}
    duration = float((probe.get("format") or {}).get("duration") or 0)
    output = project_dir / "renders" / "output.pending.mp4"
    narration = project_dir / "audio" / "narration.mp3"
    if narration.is_file():
        if progress_cb:
            progress_cb("muxing", 96, "正在合成旁白音轨...")
        process = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-nostdin",
            "-y",
            "-i",
            str(silent_output),
            "-i",
            str(narration),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-af",
            "apad",
            "-shortest",
            str(output),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=0x08000000 if sys.platform == "win32" else 0,
        )
        _, stderr = await _communicate_video_subprocess(process, cancel_event)
        if process.returncode != 0:
            return {
                "ok": False,
                "error": (stderr or b"").decode("utf-8", "replace"),
            }
    else:
        silent_output.replace(output)
    if not output.is_file() or output.stat().st_size <= 0:
        return {"ok": False, "error": "HyperFrames output is missing or empty"}
    return {
        "ok": True,
        "output": str(output.relative_to(project_dir)),
        "absolute_output": str(output),
        "duration": round(duration, 3),
        "fps": actual_fps,
        "resolution": [int(stream.get("width") or 0), int(stream.get("height") or 0)],
        "total_frames": max(1, int(round(duration * actual_fps))),
        "audio": narration.is_file(),
        "engine": "hyperframes",
    }


async def _run_render_task(
    project_dir: Path,
    fps: int,
    quality: str,
    render_engine: str = "legacy",
    allow_fallback: bool = True,
    cancel_event: threading.Event | None = None,
    release_type: str = "draft",
) -> None:
    """Render one project with the requested engine and safe fallback."""
    name = project_dir.name
    requested_engine = render_engine if render_engine in {"legacy", "hyperframes", "auto"} else "legacy"
    actual_engine = "legacy"
    fallback_reason: str | None = None
    cancel_event = cancel_event or threading.Event()
    try:
        _raise_if_video_render_cancelled(cancel_event)
        # 开启旁白的项目必须先完成语音合成，不能将缺失声音的导出标为成功。
        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        export_input_hash = _video_export_input_hash(project_dir, meta)
        snapshot_root = _snapshot_video_project(project_dir, meta)
        snapshot_scenes_dir = snapshot_root / "scenes"
        audio_dir = snapshot_root / "audio"
        if meta.get("narrationEnabled"):
            targets = [s for s in scenes if (s.get("narration") or "").strip()]
            if targets:
                _write_render_status(project_dir, {
                    "stage": "rendering",
                    "progress": 2,
                    "message": f"正在准备旁白（0/{len(targets)}）...",
                    "started_at": datetime.now().isoformat(),
                })
                failed_indices: list[int] = []
                duration_changed = False
                for i, scene in enumerate(targets, start=1):
                    _raise_if_video_render_cancelled(cancel_event)
                    previous_duration = scene.get("duration")
                    try:
                        result = await _synthesize_scene_narration(
                            snapshot_root, scene, meta
                        )
                    except TTSError:
                        raise
                    except Exception:
                        logger.exception(
                            f"narration synthesis failed for scene {scene.get('index')}"
                        )
                        result = None
                    if not result:
                        failed_indices.append(int(scene["index"]))
                    if scene.get("duration") != previous_duration:
                        duration_changed = True
                    _write_render_status(project_dir, {
                        "stage": "rendering",
                        "progress": 2,
                        "message": f"正在准备旁白（{i}/{len(targets)}）...",
                        "started_at": datetime.now().isoformat(),
                    })
                # Persist audioMtime cache bindings
                if duration_changed:
                    _sync_storyboard(snapshot_root, scenes)
                _save_video_meta(snapshot_root, meta)
                if failed_indices:
                    if export_input_hash == _video_export_input_hash(project_dir, _load_video_meta(project_dir)):
                        _restore_video_render_artifacts(project_dir, snapshot_root, scenes)
                    failed_scenes = "、".join(str(index) for index in failed_indices)
                    raise RuntimeError(
                        f"场景 {failed_scenes} 的旁白合成失败，视频未导出。"
                        "请先试听旁白，确认声音正常后重试导出。"
                    )
            # 清理孤儿 scene_*.mp3（场景删除/重排后残留，避免拼入旧音频）
            valid_names = {
                f"scene_{int(s['index']):02d}.mp3"
                for s in scenes
                if s.get("index") is not None
            }
            if audio_dir.is_dir():
                for mp3 in audio_dir.glob("scene_*.mp3"):
                    if mp3.name not in valid_names:
                        mp3.unlink(missing_ok=True)
        else:
            # 旁白关闭：清掉历史 TTS 缓存，防止 render.py 兜底拼接旧音频
            if audio_dir.is_dir():
                for mp3 in audio_dir.glob("scene_*.mp3"):
                    mp3.unlink(missing_ok=True)
        for scene in scenes:
            _require_video_motion_review(scene)
        # 无论是否开启旁白，删除旧 narration.mp3，让 render.py 基于当前
        # scene_*.mp3 集合重新拼接（或确认无音频）。
        if audio_dir.is_dir():
            (audio_dir / "narration.mp3").unlink(missing_ok=True)

        _raise_if_video_render_cancelled(cancel_event)
        _save_video_meta(snapshot_root, meta)

        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 5,
            "message": "正在准备视频画面...",
            "started_at": datetime.now().isoformat(),
        })

        # Run render.py in a thread pool (it uses asyncio.run internally)
        import importlib.util

        skill_dir = _video_skill_dir()
        script = skill_dir / "scripts" / "render.py"
        spec = importlib.util.spec_from_file_location("render", script)
        if spec is None or spec.loader is None:
            raise RuntimeError("render.py module spec load failed")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        from mona.api.video_runtime import VideoRuntime

        render_runtime = VideoRuntime()
        render_ffmpeg_path = render_runtime.get_ffmpeg_path()
        render_browser_path = render_runtime.get_chrome_path()

        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 15,
            "message": "正在生成视频画面...",
            "started_at": datetime.now().isoformat(),
        })

        # 帧级进度回调（工作线程中执行，仅做文件写入）
        def _on_render_progress(stage: str, percent: float, message: str) -> None:
            prev = _read_render_status(project_dir)
            _write_render_status(project_dir, {
                "stage": "rendering",
                "progress": percent,
                "message": message,
                "requestedEngine": requested_engine,
                "actualEngine": actual_engine,
                "fallbackReason": fallback_reason,
                "started_at": prev.get("started_at") or datetime.now().isoformat(),
            })

        result: dict[str, Any]
        # Authored sandbox scenes use the same seek contract as their native preview.
        use_hyperframes = meta.get("authoringMode") != "huashu-motion" and (requested_engine == "hyperframes" or (
            requested_engine == "auto" and not any(scene.get("authored") for scene in scenes)
        ))
        if use_hyperframes:
            actual_engine = "hyperframes"
            if meta.get("narrationEnabled") and targets:
                paths = [audio_dir / f"scene_{int(scene['index']):02d}.mp3" for scene in scenes]
                await asyncio.to_thread(
                    mod._concat_scene_audio,
                    [path if path.is_file() else None for path in paths],
                    audio_dir / "narration.mp3", cancel_event, render_ffmpeg_path,
                    durations=[float(scene.get("duration") or 5) for scene in scenes],
                )
            result = await _run_hyperframes_engine(
                snapshot_root,
                snapshot_scenes_dir,
                fps,
                quality,
                _on_render_progress,
                cancel_event,
            )
            if result.get("cancelled") or cancel_event.is_set():
                raise _VideoRenderCancelledError("视频导出已取消")
            if not result.get("ok") and allow_fallback and result.get("error") != "HyperFrames check failed":
                fallback_reason = str(result.get("error") or "HyperFrames failed")[:500]
                actual_engine = "legacy"
                _on_render_progress(
                    "rendering", 15, "正在继续生成视频画面..."
                )
        else:
            result = {"ok": False, "error": "legacy renderer selected"}

        if actual_engine == "legacy" and not result.get("ok"):
            # render_project is a sync wrapper around render_project_async.
            # scenes_dir 指向快照目录，渲染与后续编辑隔离。
            result = await asyncio.to_thread(
                mod.render_project,
                str(snapshot_root),
                fps,
                quality,
                _on_render_progress,
                scenes_dir=snapshot_scenes_dir,
                cancel_event=cancel_event,
                output_name="output.pending.mp4",
                ffmpeg_path=render_ffmpeg_path,
                browser_path=render_browser_path,
            )

        _raise_if_video_render_cancelled(cancel_event)

        if result.get("ok"):
            has_narration = bool(meta.get("narrationEnabled")) and any(
                str(scene.get("narration") or "").strip()
                for scene in meta.get("scenes") or []
            )
            needs_audio_mix = (
                has_narration
                or bool(meta.get("audioTracks"))
                or (meta.get("musicPreset") or "none") != "none"
            )
            if needs_audio_mix:
                _on_render_progress("mixing", 97, "正在合成视频声音...")
                await _mix_project_audio(snapshot_root, meta, result, cancel_event)
            await _validate_rendered_video(snapshot_root, meta, result, cancel_event)
            try:
                _on_render_progress("packaging", 98, "正在生成字幕、封面与交付包...")
                delivery = await _write_video_delivery_artifacts(
                    snapshot_root,
                    meta,
                    result,
                    actual_engine,
                    cancel_event,
                    release_type,
                )
            except _VideoRenderCancelledError:
                raise
            except Exception:
                logger.exception("video delivery artifacts failed")
                delivery = {
                    "artifacts": {"mp4": "renders/output.mp4"},
                    "qualityStatus": "warning",
                    "warnings": ["字幕、封面或交付包未生成，请重试导出"],
                }
            if release_type == "final" and delivery["qualityStatus"] != "passed":
                warning = (delivery.get("warnings") or ["交付检查未通过"])[0]
                raise RuntimeError(f"正式版未通过交付检查：{warning}")
            unchanged = export_input_hash == _video_export_input_hash(project_dir, _load_video_meta(project_dir))
            rendered_output = snapshot_root / str(result.get("output") or "renders/output.pending.mp4")
            if rendered_output.is_file():
                pending_output = project_dir / "renders" / "output.pending.mp4"
                shutil.move(str(rendered_output), pending_output)
                result["output"] = "renders/output.pending.mp4"
                result["absolute_output"] = str(pending_output)
            for relative in delivery["artifacts"].values():
                source = snapshot_root / relative
                if source.is_file():
                    destination = project_dir / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
            if unchanged:
                _restore_video_render_artifacts(project_dir, snapshot_root, scenes)
            _commit_render_output(project_dir, result)
            done_message = "导出完成" if unchanged else "导出完成；制作期间内容已修改，请重新导出最新版本"
            _write_render_status(project_dir, {
                "stage": "done",
                "progress": 100,
                "message": done_message,
                "output": result.get("output"),
                "duration": result.get("duration"),
                "fps": result.get("fps"),
                "resolution": result.get("resolution"),
                "total_frames": result.get("total_frames"),
                "audio": result.get("audio"),
                "requestedEngine": requested_engine,
                "actualEngine": actual_engine,
                "fallbackReason": fallback_reason,
                "deliveryArtifacts": delivery["artifacts"],
                "qualityStatus": delivery["qualityStatus"],
                "deliveryWarnings": delivery["warnings"],
                "releaseType": release_type,
                "finished_at": datetime.now().isoformat(),
            })
            # Update meta.json phase
            meta = _load_video_meta(project_dir)
            if unchanged:
                meta["scenes"] = scenes
                meta["phase"] = "done"
            meta["hasVideo"] = True
            meta["outputStale"] = not unchanged
            _save_video_meta(project_dir, meta)
            _schedule_video_push(name, "status")
        else:
            _cleanup_render_temporary_files(project_dir)
            _write_render_status(project_dir, {
                "stage": "error",
                "progress": 0,
                "message": (
                    "场景内容检查未通过，请修改场景后重新导出"
                    if result.get("error") == "HyperFrames check failed"
                    else "视频导出失败，请重试；若仍失败，请重新生成相关场景"
                    if str(result.get("error") or "").startswith(("HyperFrames", "FFmpeg"))
                    else result.get("error", "渲染失败")
                ),
                "need_download": result.get("need_download", False),
                "requestedEngine": requested_engine,
                "actualEngine": actual_engine,
                "fallbackReason": fallback_reason,
                "finished_at": datetime.now().isoformat(),
            })
            # Restore phase to exportable on failure
            meta = _load_video_meta(project_dir)
            meta["phase"] = "exportable" if all(_video_scene_ready(project_dir, scene) for scene in meta.get("scenes") or []) else "producing"
            _save_video_meta(project_dir, meta)
            _schedule_video_push(name, "status")
    except _VideoRenderCancelledError:
        _cleanup_render_temporary_files(project_dir)
        previous = _read_render_status(project_dir)
        _write_render_status(project_dir, {
            "stage": "cancelled",
            "progress": previous.get("progress", 0),
            "message": "导出已取消，可随时重新导出",
            "requestedEngine": requested_engine,
            "actualEngine": actual_engine,
            "fallbackReason": fallback_reason,
            "recoverable": True,
            "finished_at": datetime.now().isoformat(),
        })
        meta = _load_video_meta(project_dir)
        meta["phase"] = "exportable" if all(_video_scene_ready(project_dir, scene) for scene in meta.get("scenes") or []) else "producing"
        _save_video_meta(project_dir, meta)
        _schedule_video_push(name, "status")
    except Exception as e:
        if cancel_event.is_set():
            _cleanup_render_temporary_files(project_dir)
            previous = _read_render_status(project_dir)
            _write_render_status(project_dir, {
                "stage": "cancelled",
                "progress": previous.get("progress", 0),
                "message": "导出已取消，可随时重新导出",
                "requestedEngine": requested_engine,
                "actualEngine": actual_engine,
                "fallbackReason": fallback_reason,
                "recoverable": True,
                "finished_at": datetime.now().isoformat(),
            })
            meta = _load_video_meta(project_dir)
            meta["phase"] = "exportable" if all(_video_scene_ready(project_dir, scene) for scene in meta.get("scenes") or []) else "producing"
            _save_video_meta(project_dir, meta)
            _schedule_video_push(name, "status")
            return
        _cleanup_render_temporary_files(project_dir)
        if isinstance(e, TTSError):
            logger.warning("video narration failed: {}", e.code)
        else:
            logger.exception("video render task error")
        message = str(e)
        if isinstance(e, TimeoutError):
            message = "视频导出超时，请重试导出。"
        elif message.startswith("正式版未通过交付检查"):
            message = "正式版未通过交付检查，请检查字幕、声音和画面后重试。"
        elif not isinstance(e, TTSError) and not message.startswith(("场景", "旁白", "导出的视频", "视频导出", "无法生成交付物")):
            message = "视频导出失败，请重试；如果仍失败，请重新制作相关片段。"
        _write_render_status(project_dir, {
            "stage": "error",
            "progress": 0,
            "message": message[:500],
            **({"code": e.code, "retryable": e.retryable} if isinstance(e, TTSError) else {}),
            "requestedEngine": requested_engine,
            "actualEngine": actual_engine,
            "fallbackReason": fallback_reason,
            "finished_at": datetime.now().isoformat(),
        })
        # Restore phase to exportable on failure
        meta = _load_video_meta(project_dir)
        meta["phase"] = "exportable" if all(_video_scene_ready(project_dir, scene) for scene in meta.get("scenes") or []) else "producing"
        _save_video_meta(project_dir, meta)
        _schedule_video_push(name, "status")
    finally:
        _video_render_tasks.pop(name, None)
        _video_render_cancel_events.pop(name, None)


async def handle_video_project_export(request: web.Request) -> web.Response:
    """POST /api/video/project/export  body: {name, quality?}.

    Triggers MP4 rendering in background. Returns immediately with status.
    Validates all scenes are ready (HTML generated) before allowing export —
    the render task snapshots scene HTML at start, so confirmation is not
    required (P3 快照导出).
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
        scenes = meta.get("scenes") or []
        if not scenes:
            return web.json_response(
                {"error": "SCENES_NOT_READY", "detail": "No scenes found"}, status=409
            )
        try:
            _require_video_plan_approval(meta)
        except ValueError as exc:
            return web.json_response({"error": str(exc), "code": "PLAN_CONFIRMATION_REQUIRED"}, status=409)
        # Check all scenes have generated HTML for their current storyboard version
        for scene in scenes:
            if not _video_scene_ready(project_dir, scene):
                return web.json_response(
                    {"error": "SCENES_NOT_READY", "detail": f"Scene {scene.get('index')} HTML not generated"},
                    status=409,
                )
            try:
                _require_video_motion_review(scene)
            except ValueError as exc:
                return web.json_response({"error": str(exc), "code": "MOTION_REVIEW_REQUIRED"}, status=409)

        quality = str(body.get("quality", "standard") or "standard")
        if quality not in ("draft", "standard", "high"):
            quality = "standard"

        try:
            from mona.config.loader import load_config

            video_config = load_config().video
            configured_engine = str(video_config.render_engine)
            allow_fallback = bool(video_config.allow_render_fallback)
        except Exception:
            configured_engine = "legacy"
            allow_fallback = True
        render_engine = str(body.get("renderEngine") or configured_engine).strip()
        if render_engine not in {"legacy", "hyperframes", "auto"}:
            return web.json_response(
                {"error": "invalid render engine"}, status=400
            )
        release_type = str(body.get("releaseType") or "draft").strip()
        if release_type not in {"draft", "final"}:
            return web.json_response({"error": "invalid release type"}, status=400)
        open_reviews = [
            item
            for item in _read_video_reviews(project_dir)
            if item.get("status") == "open"
        ]
        if release_type == "final" and open_reviews:
            return web.json_response(
                {
                    "error": "OPEN_REVIEWS",
                    "detail": f"{len(open_reviews)} reviews must be resolved",
                    "openReviewCount": len(open_reviews),
                },
                status=409,
            )
        asset_preflight = _video_asset_preflight(
            project_dir,
            scenes,
            [
                *(meta.get("backgroundRegistryIds") or {}).values(),
                *(meta.get("styleAssetRegistryIds") or {}).values(),
                *([meta.get("musicAssetId")] if meta.get("musicAssetId") else []),
            ],
        )
        if release_type == "final" and not asset_preflight["readyForCommercialUse"]:
            return web.json_response(
                {
                    "error": "ASSET_RIGHTS_BLOCKED",
                    "detail": "正式版要求所有已使用素材完成商业使用权确认",
                    **asset_preflight,
                },
                status=409,
            )

        # fps=0 lets render.py apply the quality preset (draft=24, standard=30, high=60)
        fps = 0

        # Clear any previous render status
        _write_render_status(project_dir, {
            "stage": "rendering",
            "progress": 0,
            "message": "正在准备导出...",
            "requestedEngine": render_engine,
            "releaseType": release_type,
            "started_at": datetime.now().isoformat(),
        })

        # Mark project as rendering
        meta["phase"] = "rendering"
        _save_video_meta(project_dir, meta)
        _schedule_video_push(name, "phase")

        cancel_event = threading.Event()
        task = asyncio.create_task(
            _run_render_task(
                project_dir,
                fps,
                quality,
                render_engine,
                allow_fallback,
                cancel_event,
                release_type,
            )
        )
        _video_render_tasks[name] = task
        _video_render_cancel_events[name] = cancel_event

        return web.json_response({
            "ok": True,
            "stage": "rendering",
            "message": "导出已开始",
            "requestedEngine": render_engine,
            "releaseType": release_type,
        })
    except Exception as e:
        logger.exception("video export error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_assets(request: web.Request) -> web.Response:
    try:
        from mona.video_assets import list_project_assets

        name = str(request.query.get("name", "") or "").strip()
        project_dir, error = _video_project_dir_or_404(name)
        if error is not None:
            return error
        assert project_dir is not None
        assets = list_project_assets(project_dir)
        return web.json_response({
            "ok": True,
            "assets": assets,
            "unconfirmedCount": sum(
                item.get("rightsStatus") == "unknown" for item in assets
            ),
        })
    except Exception as exc:
        from mona.video_assets import VideoAssetError

        if isinstance(exc, VideoAssetError):
            return web.json_response(exc.to_dict(), status=exc.status_code)
        logger.exception("video project assets error")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_video_project_asset_import(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.video_assets import import_project_asset

        name = str(body.get("name", "") or "").strip()
        project_dir, error = _video_project_dir_or_404(name)
        if error is not None:
            return error
        assert project_dir is not None
        source_path = str(body.get("sourcePath", "") or "").strip()
        asset = await asyncio.to_thread(
            import_project_asset,
            project_dir,
            source_path,
            source_type=str(body.get("sourceType") or "user-upload"),
            rights_status=str(body.get("rightsStatus") or "unknown"),
            license_name=str(body.get("licenseName") or ""),
            source_url=str(body.get("sourceUrl") or ""),
            creator=str(body.get("creator") or ""),
            attribution=str(body.get("attribution") or ""),
            ai_provider=str(body.get("aiProvider") or ""),
            generation_prompt=str(body.get("generationPrompt") or ""),
        )
        _schedule_video_push(name, "assets")
        return web.json_response({"ok": True, "asset": asset})
    except Exception as exc:
        from mona.video_assets import VideoAssetError

        if isinstance(exc, VideoAssetError):
            return web.json_response(exc.to_dict(), status=exc.status_code)
        logger.exception("video project asset import error")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_video_project_asset_update(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        from mona.video_assets import update_project_asset

        name = str(body.get("name", "") or "").strip()
        asset_id = str(body.get("assetId", "") or "").strip()
        project_dir, error = _video_project_dir_or_404(name)
        if error is not None:
            return error
        assert project_dir is not None
        asset = update_project_asset(project_dir, asset_id, body)
        _schedule_video_push(name, "assets")
        return web.json_response({"ok": True, "asset": asset})
    except Exception as exc:
        from mona.video_assets import VideoAssetError

        if isinstance(exc, VideoAssetError):
            return web.json_response(exc.to_dict(), status=exc.status_code)
        logger.exception("video project asset update error")
        return web.json_response({"error": str(exc)}, status=500)


def _video_asset_preflight(
    project_dir: Path,
    scenes: Iterable[Mapping[str, Any]],
    additional_asset_ids: Iterable[str] = (),
) -> dict[str, Any]:
    from mona.video_assets import list_project_assets

    registered = {
        str(asset.get("id")): asset for asset in list_project_assets(project_dir)
    }
    used_ids = sorted(
        {
            str(asset_id)
            for scene in scenes
            for asset_id in scene.get("assets") or []
            if str(asset_id)
        }
        | {str(asset_id) for asset_id in additional_asset_ids if str(asset_id)}
    )
    missing = [asset_id for asset_id in used_ids if asset_id not in registered]
    unconfirmed = [
        {
            "assetId": asset_id,
            "name": registered[asset_id].get("originalName"),
            "rightsStatus": registered[asset_id].get("rightsStatus"),
        }
        for asset_id in used_ids
        if asset_id in registered and not registered[asset_id].get("commercialUse")
    ]
    return {
        "usedAssetCount": len(used_ids),
        "missingAssetIds": missing,
        "unconfirmedAssets": unconfirmed,
        "readyForCommercialUse": not missing and not unconfirmed,
    }


async def handle_video_project_scene_timeline(request: web.Request) -> web.Response:
    try:
        name = str(request.query.get("name", "") or "").strip()
        index = int(request.query.get("index", "0") or 0)
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        scene = next(
            (item for item in meta.get("scenes") or [] if item.get("index") == index),
            None,
        )
        if scene is None:
            return web.json_response({"error": "scene not found"}, status=404)
        timing_path = project_dir / "audio" / f"scene_{index:02d}.timing.json"
        motion_path = project_dir / "scene_specs" / f"scene_{index:02d}.motion.json"
        subtitle_track = (
            _json.loads(timing_path.read_text(encoding="utf-8"))
            if timing_path.is_file()
            else None
        )
        motion_plan = (
            _json.loads(motion_path.read_text(encoding="utf-8"))
            if motion_path.is_file()
            else None
        )
        duration_ms = max(
            300, int(round(float(scene.get("duration") or 5) * 1000))
        )
        return web.json_response({
            "ok": True,
            "sceneIndex": index,
            "durationMs": duration_ms,
            "subtitleTrack": subtitle_track,
            "motionPlan": motion_plan,
        })
    except (TypeError, ValueError):
        return web.json_response({"error": "invalid scene index"}, status=400)
    except Exception as e:
        logger.exception("video scene timeline error")
        return web.json_response({"error": str(e)}, status=500)


_VIDEO_VERSION_ID_RE = re.compile(r"^[0-9A-Za-z_-]{8,80}$")


def _create_video_project_version(
    project_dir: Path,
    *,
    label: str,
    reason: str,
    changed_scene_indices: list[int] | None = None,
) -> dict[str, Any]:
    versions_dir = project_dir / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    created_at = datetime.now().isoformat()
    version_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
    version_dir = versions_dir / version_id
    version_dir.mkdir()
    for file_name in (
        "meta.json",
        "outline.json",
        "storyboard.md",
        "storyboard_lock.md",
    ):
        source = project_dir / file_name
        if source.is_file():
            shutil.copy2(source, version_dir / file_name)
    for directory_name in (
        "scenes",
        "scene_specs",
        "scene_sources",
        "audio",
        "assets",
        "sources",
        "style",
    ):
        source = project_dir / directory_name
        if source.is_dir():
            shutil.copytree(source, version_dir / directory_name)
    meta = _load_video_meta(project_dir)
    manifest = {
        "schemaVersion": 1,
        "id": version_id,
        "createdAt": created_at,
        "label": str(label or "自动版本")[:120],
        "reason": str(reason or "manual")[:80],
        "changedSceneIndices": changed_scene_indices or [],
        "projectPhase": meta.get("phase"),
        "styleVersion": meta.get("styleVersion"),
    }
    _atomic_write_text(
        version_dir / "manifest.json",
        _json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )
    return manifest


def _list_video_project_versions(project_dir: Path) -> list[dict[str, Any]]:
    versions_dir = project_dir / "versions"
    if not versions_dir.is_dir():
        return []
    versions: list[dict[str, Any]] = []
    for version_dir in sorted(versions_dir.iterdir(), reverse=True):
        manifest_path = version_dir / "manifest.json"
        if not version_dir.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = _json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(manifest, dict):
            versions.append(manifest)
    return versions


async def handle_video_project_versions(request: web.Request) -> web.Response:
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        return web.json_response(
            {"ok": True, "versions": _list_video_project_versions(project_dir)}
        )
    except Exception as e:
        logger.exception("video project versions error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_version_restore(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        version_id = str(body.get("versionId", "") or "").strip()
        if not _VIDEO_VERSION_ID_RE.fullmatch(version_id):
            return web.json_response({"error": "invalid version id"}, status=400)
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        task = _video_render_tasks.get(name)
        if task is not None and not task.done():
            return web.json_response(
                {"error": "cannot restore while rendering"}, status=409
            )
        version_dir = project_dir / "versions" / version_id
        if not (version_dir / "manifest.json").is_file():
            return web.json_response({"error": "version not found"}, status=404)
        backup = _create_video_project_version(
            project_dir,
            label="恢复版本前自动备份",
            reason="before-version-restore",
        )
        for directory_name in (
            "scenes",
            "scene_specs",
            "scene_sources",
            "audio",
            "assets",
            "sources",
            "style",
        ):
            target = project_dir / directory_name
            source = version_dir / directory_name
            if target.is_dir():
                shutil.rmtree(target)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                target.mkdir(parents=True, exist_ok=True)
        for file_name in (
            "meta.json",
            "outline.json",
            "storyboard.md",
            "storyboard_lock.md",
        ):
            target = project_dir / file_name
            source = version_dir / file_name
            if source.is_file():
                shutil.copy2(source, target)
            else:
                target.unlink(missing_ok=True)
        meta = _load_video_meta(project_dir)
        meta["restoredFromVersion"] = version_id
        meta["restoredAt"] = datetime.now().isoformat()
        meta["outputStale"] = True
        meta["hasVideo"] = (project_dir / "renders" / "output.mp4").is_file()
        scenes = meta.get("scenes") or []
        if scenes and all(_video_scene_ready(project_dir, scene) for scene in scenes):
            meta["phase"] = "exportable"
        elif meta.get("storyboardLocked"):
            meta["phase"] = "producing"
        else:
            meta["phase"] = "storyboard"
        _save_video_meta(project_dir, meta)
        _schedule_video_push(name, "scenes")
        _schedule_video_push(name, "phase")
        return web.json_response({
            "ok": True,
            "restoredVersionId": version_id,
            "backupVersionId": backup["id"],
            "phase": meta["phase"],
        })
    except Exception as e:
        logger.exception("video project version restore error")
        return web.json_response({"error": str(e)}, status=500)


def _read_video_reviews(project_dir: Path) -> list[dict[str, Any]]:
    path = project_dir / "reviews" / "reviews.json"
    if not path.is_file():
        return []
    try:
        payload = _json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return payload if isinstance(payload, list) else []


def _write_video_reviews(project_dir: Path, reviews: list[dict[str, Any]]) -> None:
    _atomic_write_text(
        project_dir / "reviews" / "reviews.json",
        _json.dumps(reviews, ensure_ascii=False, indent=2) + "\n",
    )


async def handle_video_project_reviews(request: web.Request) -> web.Response:
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        reviews = _read_video_reviews(project_dir)
        return web.json_response({
            "ok": True,
            "reviews": reviews,
            "openCount": sum(item.get("status") == "open" for item in reviews),
        })
    except Exception as e:
        logger.exception("video project reviews error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_review_create(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        text = str(body.get("text", "") or "").strip()
        scene_index = int(body.get("sceneIndex", 0) or 0)
        time_ms = max(0, int(body.get("timeMs", 0) or 0))
        if not text or len(text) > 2_000:
            return web.json_response({"error": "review text is invalid"}, status=400)
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        scene = next(
            (
                item
                for item in meta.get("scenes") or []
                if int(item.get("index") or 0) == scene_index
            ),
            None,
        )
        if scene is None:
            return web.json_response({"error": "scene not found"}, status=404)
        duration_ms = int(round(float(scene.get("duration") or 5) * 1000))
        review = {
            "id": "review-" + uuid.uuid4().hex[:12],
            "sceneIndex": scene_index,
            "timeMs": min(time_ms, duration_ms),
            "text": text,
            "status": "open",
            "createdAt": datetime.now().isoformat(),
            "resolvedAt": None,
        }
        reviews = _read_video_reviews(project_dir)
        reviews.append(review)
        _write_video_reviews(project_dir, reviews)
        _schedule_video_push(name, "reviews")
        return web.json_response({"ok": True, "review": review})
    except (TypeError, ValueError):
        return web.json_response({"error": "invalid review position"}, status=400)
    except Exception as e:
        logger.exception("video project review create error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_review_resolve(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    try:
        name = str(body.get("name", "") or "").strip()
        review_id = str(body.get("reviewId", "") or "").strip()
        resolved = bool(body.get("resolved", True))
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        reviews = _read_video_reviews(project_dir)
        review = next((item for item in reviews if item.get("id") == review_id), None)
        if review is None:
            return web.json_response({"error": "review not found"}, status=404)
        review["status"] = "resolved" if resolved else "open"
        review["resolvedAt"] = datetime.now().isoformat() if resolved else None
        _write_video_reviews(project_dir, reviews)
        _schedule_video_push(name, "reviews")
        return web.json_response({"ok": True, "review": review})
    except Exception as e:
        logger.exception("video project review resolve error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_export_cancel(request: web.Request) -> web.Response:
    """POST /api/video/project/export/cancel body: {name}."""
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
        task = _video_render_tasks.get(name)
        cancel_event = _video_render_cancel_events.get(name)
        if task is None or task.done() or cancel_event is None:
            return web.json_response(
                {"error": "render is not in progress", "code": "NOT_RENDERING"},
                status=409,
            )
        cancel_event.set()
        previous = _read_render_status(project_dir)
        _write_render_status(project_dir, {
            **previous,
            "stage": "cancelling",
            "message": "正在安全停止导出...",
            "recoverable": True,
        })
        _schedule_video_push(name, "status")
        return web.json_response({"ok": True, "stage": "cancelling"}, status=202)
    except Exception as e:
        logger.exception("video export cancel error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_export_preflight(request: web.Request) -> web.Response:
    try:
        name = str(request.query.get("name", "") or "").strip()
        quality = str(request.query.get("quality", "standard") or "standard")
        if quality not in {"draft", "standard", "high"}:
            return web.json_response({"error": "invalid quality"}, status=400)
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        scenes = meta.get("scenes") or []
        duration = round(sum(float(scene.get("duration") or 5) for scene in scenes), 2)
        fps, scale, bitrate_mbps = {
            "draft": (24, 0.5, 1.2),
            "standard": (30, 1.0, 6.0),
            "high": (60, 1.0, 10.0),
        }[quality]
        resolution_match = re.search(
            r"(\d+)\s*x\s*(\d+)", str(meta.get("resolution") or "1920x1080")
        )
        width = int(resolution_match.group(1)) if resolution_match else 1920
        height = int(resolution_match.group(2)) if resolution_match else 1080
        width = max(2, int(round(width * scale)))
        height = max(2, int(round(height * scale)))
        estimated_bytes = int(duration * bitrate_mbps * 1_000_000 / 8)
        tts_provider = str(meta.get("ttsProvider") or "edge")
        narration_chars = sum(
            len(str(scene.get("narration") or "")) for scene in scenes
        )
        reviews = _read_video_reviews(project_dir)
        asset_preflight = _video_asset_preflight(
            project_dir,
            scenes,
            [
                *(meta.get("backgroundRegistryIds") or {}).values(),
                *(meta.get("styleAssetRegistryIds") or {}).values(),
                *([meta.get("musicAssetId")] if meta.get("musicAssetId") else []),
            ],
        )
        return web.json_response({
            "ok": True,
            "duration": duration,
            "fps": fps,
            "resolution": [width, height],
            "estimatedFrames": max(1, int(round(duration * fps))),
            "estimatedOutputBytes": estimated_bytes,
            "narrationCharacters": narration_chars,
            "openReviewCount": sum(
                item.get("status") == "open" for item in reviews
            ),
            "assetRights": asset_preflight,
            "billing": {
                "monaCredits": 0,
                "localRender": True,
                "externalProviderBilling": bool(
                    meta.get("narrationEnabled") and tts_provider != "edge"
                ),
                "note": (
                    "本地导出不扣 Mona 积分；自定义配音可能由外部服务商计费"
                    if meta.get("narrationEnabled") and tts_provider != "edge"
                    else "本地导出和默认配音不扣 Mona 积分"
                ),
            },
        })
    except Exception as e:
        logger.exception("video export preflight error")
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
        task = _video_render_tasks.get(name)
        if (
            status.get("stage") in {"rendering", "cancelling"}
            and (task is None or task.done())
        ):
            status = {
                **status,
                "stage": "error",
                "message": "上次导出因应用退出而中断，可重新导出",
                "recoverable": True,
                "finished_at": datetime.now().isoformat(),
            }
            _write_render_status(project_dir, status)
            meta = _load_video_meta(project_dir)
            if meta.get("phase") == "rendering":
                meta["phase"] = "exportable"
                _save_video_meta(project_dir, meta)
        # Map snake_case to camelCase for API boundary
        result = {
            "stage": status.get("stage", "idle"),
            "progress": status.get("progress", 0),
            "message": status.get("message"),
            "output": status.get("output"),
            "duration": status.get("duration"),
            "fps": status.get("fps"),
            "resolution": status.get("resolution"),
            "audio": status.get("audio"),
            "totalFrames": status.get("total_frames"),
            "needDownload": status.get("need_download"),
            "startedAt": status.get("started_at"),
            "finishedAt": status.get("finished_at"),
            "requestedEngine": status.get("requestedEngine"),
            "actualEngine": status.get("actualEngine"),
            "fallbackReason": status.get("fallbackReason"),
            "recoverable": status.get("recoverable"),
            "deliveryArtifacts": status.get("deliveryArtifacts"),
            "qualityStatus": status.get("qualityStatus"),
            "deliveryWarnings": status.get("deliveryWarnings"),
            "releaseType": status.get("releaseType"),
            "hasVideo": (project_dir / "renders" / "output.mp4").is_file(),
        }
        # Remove None values
        result = {k: v for k, v in result.items() if v is not None}
        return web.json_response({"ok": True, **result})
    except Exception as e:
        logger.exception("video export status error")
        return web.json_response({"error": str(e)}, status=500)


async def handle_video_project_preview_full(request: web.Request) -> web.Response:
    """GET /api/video/project/preview-full?name=  → returns inline preview HTML.

    Plays the authored film once, or existing baked scene documents in sequence.
    """
    try:
        name = str(request.query.get("name", "") or "").strip()
        project_dir, err = _video_project_dir_or_404(name)
        if err is not None:
            return err
        assert project_dir is not None
        meta = _load_video_meta(project_dir)
        try:
            _require_video_plan_approval(meta)
        except ValueError as exc:
            return web.json_response({"error": str(exc), "code": "PLAN_CONFIRMATION_REQUIRED"}, status=409)
        if meta.get("scenes") and not all(_video_scene_ready(project_dir, scene) for scene in meta["scenes"]):
            return web.json_response({
                "error": "SCENES_NOT_READY",
                "message": "请先生成全部场景，再预览整片。",
            }, status=409)

        skill_dir = Path(__file__).parent.parent / "skills" / "mona-motion"
        script = skill_dir / "scripts" / "merge_scenes.py"
        if not script.is_file():
            return web.json_response(
                {"error": "merge_scenes.py not found"},
                status=500,
            )

        import importlib.util

        spec = importlib.util.spec_from_file_location("merge_scenes", script)
        if spec is None or spec.loader is None:
            return web.json_response(
                {"error": "failed to load merge_scenes.py"},
                status=500,
            )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        scenes_dir = project_dir / "scenes"
        if not scenes_dir.is_dir():
            return web.json_response(
                {"error": "scenes directory not found"},
                status=404,
            )

        scenes = mod.list_scenes(scenes_dir)
        if not scenes:
            return web.json_response(
                {"error": "no scene files found"},
                status=404,
            )

        if meta.get("narrationEnabled", False):
            for scene in meta.get("scenes") or []:
                if not str(scene.get("narration") or "").strip():
                    continue
                try:
                    audio = await _synthesize_scene_narration(project_dir, scene, meta)
                    if audio:
                        meta = _save_video_narration_meta(project_dir, scene, meta)
                except _VideoNarrationInputChangedError:
                    return web.json_response({
                        "error": "NARRATION_INPUT_CHANGED",
                        "message": "分镜或声音设置已修改，请重新预览。",
                        "retryable": True,
                    }, status=409)
                except Exception:
                    logger.exception("video preview narration preparation failed")
                    audio = None
                if not audio:
                    return web.json_response({
                        "error": "PREVIEW_NARRATION_FAILED",
                        "message": f"场景 {scene.get('index')} 的旁白准备失败，请重试。",
                        "sceneIndex": scene.get("index"), "retryable": True,
                    }, status=503)
            _sync_storyboard(project_dir, meta.get("scenes") or [])
            _save_video_meta(project_dir, meta)
            meta = _load_video_meta(project_dir)

        storyboard = mod.parse_storyboard(project_dir / "storyboard.md")
        width, height = storyboard.get("resolution") or (
            mod.DEFAULT_WIDTH,
            mod.DEFAULT_HEIGHT,
        )

        scene_entries: list[tuple[int, float, str]] = []
        scene_transitions: dict[int, tuple[str, float]] = {}
        if meta.get("authoringMode") == "huashu-motion":
            from mona.video_authoring import composition_path, refresh_huashu_composition

            if meta.get("composition") and meta.get("narrationEnabled"):
                refresh_huashu_composition(project_dir, meta)
                _save_video_meta(project_dir, meta)
            full_composition = composition_path(project_dir, meta)
            if full_composition is None:
                return web.json_response({
                    "error": "COMPOSITION_NOT_READY",
                    "message": "整片动画尚未准备完成，请先完成制作。",
                }, status=409)
            total_duration = sum(float(scene.get("duration") or 5) for scene in meta.get("scenes") or [])
            scene_entries.append((
                1,
                total_duration,
                _prepare_scene_html_for_preview(full_composition.read_text(encoding="utf-8"), name, width, height, project_dir=project_dir),
            ))
        else:
            timeline, total_duration = mod.compute_timeline(scenes, storyboard)
            for num, path, _start, duration in timeline:
                scene_html = path.read_text(encoding="utf-8")
                scene_transitions[num] = mod.read_scene_transition(path, duration, storyboard.get("motion"))
                scene_entries.append(
                    (
                        num,
                        duration,
                        _prepare_scene_html_for_preview(scene_html, name, width, height, project_dir=project_dir),
                    )
                )

        if not scene_entries:
            return web.json_response(
                {"error": "no scene content could be read"},
                status=404,
            )

        meta = _load_video_meta(project_dir)
        audio_scene_indices = (
            {
                int(scene.get("index") or 0)
                for scene in (meta.get("scenes") or [])
                if str(scene.get("narration") or "").strip()
            }
            if meta.get("narrationEnabled", False) and meta.get("authoringMode") != "huashu-motion"
            else set()
        )
        from mona.api.video_audio import prepare_preview_audio

        mixed_audio = await prepare_preview_audio(project_dir)
        master_audio = "data:audio/mp4;base64," + base64.b64encode(mixed_audio.read_bytes()).decode("ascii") if mixed_audio else None
        preview_html = _build_video_preview_html(
            width,
            height,
            total_duration,
            scene_entries,
            project_name=name,
            token=str(request.query.get("token", "") or ""),
            audio_scene_indices=audio_scene_indices,
            scene_transitions=scene_transitions,
            master_audio=master_audio,
        )
        return web.Response(body=preview_html, content_type="text/html")
    except TTSError as exc:
        return _tts_error_response(exc)
    except Exception as e:
        logger.exception("video preview full error")
        return web.json_response({"error": str(e)}, status=500)


def _prepare_scene_html_for_preview(
    html: str,
    project_name: str,
    width: int,
    height: int,
    *,
    project_dir: Path | None = None,
) -> str:
    """Make a scene HTML safe and responsive inside an iframe preview.

    - Embeds local project and style images for isolated iframe previews.
    - Injects a small script that scales the scene body to fit the iframe while
      preserving the original design aspect ratio.
    """
    def asset_url(relative: str) -> str:
        relative = unquote(relative)
        if project_dir is None:
            return f"/api/video/project-file?name={quote(project_name)}&path={quote(relative)}"
        root = project_dir.resolve()
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError("场景图片路径超出项目范围")
        content_type = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(path.suffix.lower())
        if not path.is_file() or content_type is None:
            raise ValueError("场景图片不可用，请重新导入图片后生成场景")
        return f"data:{content_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"

    relative_asset = r'(?:\.\.?/)?((?:style/)?assets/[^"\'<>\s)]+)'
    html = re.sub(
        r'(?i)(src\s*=\s*(["\']))' + relative_asset + r'\2',
        lambda match: match.group(1) + asset_url(match.group(3)) + match.group(2),
        html,
    )
    html = re.sub(
        r'(?i)(url\(\s*(["\']?))' + relative_asset + r'\2\s*\)',
        lambda match: match.group(1) + asset_url(match.group(3)) + match.group(2) + ')',
        html,
    )

    fit_script = f"""
<script>
(function() {{
  const designW = {width};
  const designH = {height};
  function fit() {{
    const scale = Math.min(window.innerWidth / designW, window.innerHeight / designH);
    document.body.style.width = designW + 'px';
    document.body.style.height = designH + 'px';
    document.body.style.transform = 'scale(' + scale + ')';
    document.body.style.transformOrigin = 'center center';
    document.body.style.position = 'absolute';
    document.body.style.left = '50%';
    document.body.style.top = '50%';
    document.body.style.marginLeft = (-designW / 2) + 'px';
    document.body.style.marginTop = (-designH / 2) + 'px';
    document.documentElement.style.overflow = 'hidden';
  }}
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', fit);
  }} else {{
    fit();
  }}
  window.addEventListener('resize', fit);
  window.addEventListener('message', async (event) => {{
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'mona-video-seek' || !Number.isFinite(Number(data.seconds))) return;
    const seconds = Math.max(0, Number(data.seconds) || 0);
    if (typeof window.__monaSeek === 'function') {{
      await window.__monaSeek(seconds);
      return;
    }}
    if (window.__timelines) {{
      for (const key in window.__timelines) {{
        const timeline = window.__timelines[key];
        if (timeline && typeof timeline.seek === 'function') timeline.seek(seconds);
        if (timeline && typeof timeline.pause === 'function') timeline.pause();
      }}
    }}
    if (typeof window.__monaApplySubtitleTime === 'function') {{
      window.__monaApplySubtitleTime(seconds);
    }}
  }});
}})();
</script>
"""
    if "</body>" in html:
        html = html.replace("</body>", f"{fit_script}</body>", 1)
    else:
        html += fit_script
    return html


def _build_video_preview_html(
    width: int,
    height: int,
    total_duration: float,
    scene_entries: list[tuple[int, float, str]],
    *,
    project_name: str = "",
    token: str = "",
    audio_scene_indices: set[int] | None = None,
    scene_transitions: dict[int, tuple[str, float]] | None = None,
    master_audio: str | None = None,
    scene_audio: dict[int, str] | None = None,
) -> str:
    """Return a self-contained HTML page that plays scenes sequentially.

    Each scene is injected as an iframe ``srcdoc`` so relative paths inside the
    scene HTML can be rewritten to absolute project-file URLs.
    """
    # NOTE: do NOT html.escape the srcdoc here — <script> content is raw text,
    # so entities like &lt; are never decoded and the iframe would show escaped
    # source instead of rendering the scene. Instead every "<" is written as
    # a JSON unicode escape (decoded back to "<" by the JS parser) so a
    # literal "</script>" in the scene HTML cannot terminate this script block.
    audible = audio_scene_indices or set()
    entries_json = _json.dumps(
        [
            [
                num,
                duration,
                srcdoc,
                (scene_audio or {}).get(num) or (
                    "/api/video/project/scene/narration?"
                    f"name={quote(project_name)}&index={num}&token={quote(token)}"
                    if num in audible and project_name
                    else ""
                ),
                *(scene_transitions or {}).get(num, ("cross-fade", 0)),
            ]
            for num, duration, srcdoc in scene_entries
        ],
        ensure_ascii=False,
    ).replace("<", "\\u003c")
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Video Preview</title>
  <style>
    html, body {{
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }}
    #stage {{
      position: relative;
      width: 100%;
      height: 100%;
    }}
    .scene-frame {{
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      opacity: 0;
      pointer-events: none;
    }}
    .scene-frame.active {{
      opacity: 1;
      pointer-events: auto;
    }}
    #progress {{
      position: absolute;
      bottom: 0;
      left: 0;
      height: 3px;
      background: rgba(255,255,255,0.6);
      width: 0%;
      z-index: 10;
    }}
    #controls {{
      position: absolute;
      left: 50%;
      bottom: 22px;
      z-index: 12;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px;
      color: #fff;
      background: rgba(12,12,14,.78);
      font: 14px/1.2 system-ui, sans-serif;
      transform: translateX(-50%);
      backdrop-filter: blur(10px);
      transition: opacity .15s;
    }}
    #controls.idle {{ opacity: 0; pointer-events: none; }}
    #controls.idle:has(:focus-visible) {{ opacity: 1; pointer-events: auto; }}
    #wake-controls {{ display: none; position: absolute; inset: 0; z-index: 11; }}
    #wake-controls.active {{ display: block; }}
    #play-toggle {{
      min-width: 78px;
      padding: 7px 12px;
      border: 0;
      border-radius: 7px;
      color: #111;
      background: #fff;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }}
    #time {{ min-width: 92px; color: rgba(255,255,255,.78); font-variant-numeric: tabular-nums; }}
    #playback-error {{ position:absolute; left:20px; right:20px; bottom:80px; z-index:12; padding:12px; color:#fff; background:rgba(12,12,14,.78); font:14px/1.5 system-ui,sans-serif; }}
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="progress"></div>
  <div id="wake-controls" aria-hidden="true"></div>
  <div id="playback-error" role="alert" hidden></div>
  <div id="controls">
    <button id="play-toggle" type="button">播放预览</button>
    <span id="time">0.0s / {total_duration:.1f}s</span>
  </div>
  <script>
    const entries = {entries_json};
    const stage = document.getElementById('stage');
    const progress = document.getElementById('progress');
    const playToggle = document.getElementById('play-toggle');
    const timeLabel = document.getElementById('time');
    const controls = document.getElementById('controls');
    const wakeControls = document.getElementById('wake-controls');
    const totalDuration = {total_duration};
    const masterSource = {_json.dumps(master_audio)};
    const masterAudio = masterSource ? new Audio(masterSource) : null;

    const audioTracks = [];
    entries.forEach(([num, duration, srcdoc, audioUrl], index) => {{
      const iframe = document.createElement('iframe');
      iframe.className = 'scene-frame';
      iframe.srcdoc = srcdoc;
      iframe.title = 'scene-' + num;
      iframe.sandbox = 'allow-scripts';
      iframe.style.zIndex = index;
      if (index === 0) iframe.classList.add('active');
      iframe.addEventListener('load', () => {{
        renderAt(playing
          ? Math.min(totalDuration, masterAudio ? masterAudio.currentTime : elapsedBeforePlay + (performance.now() - startedAt) / 1000)
          : elapsedBeforePlay);
      }});
      stage.appendChild(iframe);
      const audio = masterAudio || (audioUrl ? new Audio(audioUrl) : null);
      if (audio) audio.preload = 'auto';
      if (audio) audio.addEventListener('error', () => {{
        if ((playing || preparing) && currentIndex === index) playbackError(index);
      }});
      audioTracks[index] = audio;
    }});

    const frames = Array.from(stage.querySelectorAll('.scene-frame'));
    let currentIndex = 0;
    let elapsedBeforePlay = 0;
    let startedAt = 0;
    let playing = false;
    let preparing = false;
    let operation = 0;
    let animationFrame = 0;
    let controlsTimer = 0;

    function revealControls() {{
      clearTimeout(controlsTimer);
      controls.classList.remove('idle');
      wakeControls.classList.remove('active');
      if (playing) controlsTimer = setTimeout(() => {{
        controls.classList.add('idle');
        wakeControls.classList.add('active');
      }}, 1500);
    }}
    wakeControls.addEventListener('pointermove', revealControls);
    wakeControls.addEventListener('pointerdown', revealControls);
    controls.addEventListener('pointermove', revealControls);
    document.addEventListener('keydown', revealControls);

    function seekFrame(frame, time) {{
      frame?.contentWindow?.postMessage({{type:'mona-video-seek',seconds:time}}, '*');
    }}

    function waitForAudio(audio) {{
      if (audio.error) return Promise.reject(new Error('audio unavailable'));
      if (audio.readyState >= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {{
        function clean() {{
          audio.removeEventListener('loadedmetadata', ready);
          audio.removeEventListener('error', failed);
        }}
        function ready() {{ clean(); resolve(); }}
        function failed() {{ clean(); reject(new Error('audio unavailable')); }}
        audio.addEventListener('loadedmetadata', ready, {{once:true}});
        audio.addEventListener('error', failed, {{once:true}});
      }});
    }}

    async function setAudio(index, localTime, requestId) {{
      const audio = audioTracks[index];
      if (!audio) return;
      await waitForAudio(audio);
      if (requestId !== operation) return;
      const audioTime = localTime + (masterAudio ? entries.slice(0, index).reduce((sum, entry) => sum + entry[1], 0) : 0);
      if (Number.isFinite(audio.duration) && audioTime >= audio.duration) return;
      audio.currentTime = Math.max(0, audioTime);
      await audio.play();
      if (requestId !== operation && (audioTracks[currentIndex] !== audio || (!playing && !preparing))) audio.pause();
    }}

    function pauseAudio() {{
      audioTracks.forEach((audio) => {{ if (audio) audio.pause(); }});
    }}

    function locate(elapsed) {{
      let start = 0;
      for (let i = 0; i < entries.length; i++) {{
        const duration = entries[i][1];
        if (elapsed < start + duration || i === entries.length - 1) return {{index:i,localTime:Math.max(0,Math.min(duration,elapsed-start))}};
        start += duration;
      }}
    }}

    function renderAt(elapsed) {{
      progress.style.width = Math.min(100, (elapsed / totalDuration) * 100) + '%';
      timeLabel.textContent = elapsed.toFixed(1) + 's / ' + totalDuration.toFixed(1) + 's';
      const position = locate(elapsed);
      const nextIndex = position.index;
      const localTime = position.localTime;
      frames.forEach((frame, index) => {{
        frame.classList.toggle('active', index === nextIndex);
        frame.style.opacity = index === nextIndex ? '1' : '0';
        frame.style.transform = 'none';
        frame.style.maskImage = 'none';
      }});
      seekFrame(frames[nextIndex], localTime);
      const transitionDuration = entries[nextIndex][5];
      if (nextIndex > 0 && transitionDuration > 0 && localTime < transitionDuration) {{
        const previous = frames[nextIndex-1];
        previous.style.opacity = '1';
        seekFrame(previous, entries[nextIndex-1][1]);
        const p = Math.min(1, localTime / transitionDuration);
        const frame = frames[nextIndex];
        const preset = entries[nextIndex][4];
        if (preset === 'stagger-rise') {{
          const bands = [0,1,2].map(index => Math.max(0,Math.min(1,(p-index*.18)/.64)));
          frame.style.maskImage = 'linear-gradient(to right,rgba(0,0,0,'+bands[0]+') 0 33.333%,rgba(0,0,0,'+bands[1]+') 33.333% 66.667%,rgba(0,0,0,'+bands[2]+') 66.667% 100%)';
        }} else {{
          frame.style.opacity = p;
          if (preset === 'fade-rise') frame.style.transform = 'translateY('+((1-p)*5)+'%)';
        }}
      }}
      return position;
    }}

    function stopPlayback() {{
      if (playing) elapsedBeforePlay = Math.min(totalDuration, masterAudio ? masterAudio.currentTime : elapsedBeforePlay+(performance.now()-startedAt)/1000);
      operation++;
      cancelAnimationFrame(animationFrame);
      playing = false;
      preparing = false;
      revealControls();
      pauseAudio();
      playToggle.textContent = elapsedBeforePlay >= totalDuration ? '重新播放' : '继续播放';
    }}

    function playbackError(index) {{
      stopPlayback();
      const sceneIndex = entries[index][0];
      const message = '第 '+sceneIndex+' 段的声音播放失败，画面已暂停，请重试。';
      if (window.parent !== window) window.parent.postMessage({{type:'mona-video-playback-error',sceneIndex,message}}, '*');
      else {{
        const error = document.getElementById('playback-error');
        error.textContent = message;
        error.hidden = false;
      }}
      playToggle.textContent = '重试播放';
    }}

    async function startPlayback(elapsed) {{
      stopPlayback();
      const requestId = operation;
      elapsedBeforePlay = elapsed;
      const position = renderAt(elapsed);
      currentIndex = position.index;
      preparing = true;
      playToggle.textContent = audioTracks[currentIndex] ? '取消准备' : '暂停';
      document.getElementById('playback-error').hidden = true;
      try {{
        await setAudio(currentIndex, position.localTime, requestId);
        if (requestId !== operation) return;
        startedAt = performance.now();
        preparing = false;
        playing = true;
        revealControls();
        playToggle.textContent = '暂停';
        animationFrame = requestAnimationFrame(tick);
      }} catch (_error) {{
        if (requestId === operation) playbackError(currentIndex);
      }}
    }}

    function tick(now) {{
      if (!playing) return;
      const elapsed = Math.min(totalDuration, masterAudio ? masterAudio.currentTime : elapsedBeforePlay + (now - startedAt) / 1000);
      const position = renderAt(elapsed);
      if (position.index !== currentIndex && elapsed < totalDuration) {{
        if (masterAudio) currentIndex = position.index;
        else {{ void startPlayback(elapsed); return; }}
      }}
      if (elapsed < totalDuration) {{
        animationFrame = requestAnimationFrame(tick);
      }} else {{
        stopPlayback();
        elapsedBeforePlay = totalDuration;
        playToggle.textContent = '重新播放';
      }}
    }}

    playToggle.addEventListener('click', () => {{
      if (playing || preparing) {{
        stopPlayback();
        return;
      }}
      void startPlayback(elapsedBeforePlay >= totalDuration ? 0 : elapsedBeforePlay);
    }});
    window.addEventListener('message', (event) => {{
      if (event.source !== window.parent && event.source !== window) return;
      const data = event.data;
      if (!data || data.type !== 'mona-video-seek' || !Number.isFinite(Number(data.seconds))) return;
      const resume = playing || preparing;
      stopPlayback();
      elapsedBeforePlay = Math.max(0,Math.min(totalDuration,Number(data.seconds)));
      currentIndex = renderAt(elapsedBeforePlay).index;
      playToggle.textContent = elapsedBeforePlay >= totalDuration ? '重新播放' : '继续播放';
      if (resume && elapsedBeforePlay < totalDuration) void startPlayback(elapsedBeforePlay);
    }});
  </script>
</body>
</html>"""


_CORS_ALLOWED_HEADERS = "Content-Type, Authorization, X-Mona-Token"


def _cors_allow_origin(request_origin: str | None) -> str | None:
    """Return the origin to echo back, or None when not allowed.

    私有本地 API 不使用 `Access-Control-Allow-Origin: *`：只允许 Tauri
    webview 源与 loopback 开发源，其余 Origin 不下发 CORS 头（浏览器会拦截）。
    非浏览器消费者（Rust 本地桥、令牌调用方）不携带 Origin，不受影响。
    """
    if not request_origin:
        return None
    if request_origin in (
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ):
        return request_origin
    try:
        from urllib.parse import urlparse

        parsed = urlparse(request_origin)
    except ValueError:
        return None
    if parsed.scheme != "http":
        return None
    host = parsed.hostname or ""
    if host == "localhost":
        return request_origin
    try:
        import ipaddress

        if ipaddress.ip_address(host).is_loopback:
            return request_origin
    except ValueError:
        return None
    return None


@web.middleware
async def _cors_middleware(request: web.Request, handler: Callable) -> web.StreamResponse:
    """Add CORS headers for the Tauri webview / loopback dev origins only."""
    allow_origin = _cors_allow_origin(request.headers.get("Origin"))
    if request.headers.get("Origin") and allow_origin is None:
        raise web.HTTPForbidden(reason="untrusted local API origin")
    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)
    if allow_origin is not None:
        resp.headers["Access-Control-Allow-Origin"] = allow_origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = _CORS_ALLOWED_HEADERS
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
    from mona.materials.auth import get_services_token, materials_auth_middleware

    get_services_token()
    app = web.Application(
        client_max_size=20 * 1024 * 1024,
        middlewares=[_cors_middleware, materials_auth_middleware],
    )
    app["agent_loop"] = agent_loop
    app["model_name"] = model_name
    app["request_timeout"] = request_timeout
    app["session_locks"] = {}  # per-user locks, keyed by session_key
    # Event used by POST /shutdown to unwind the gateway's main loop cleanly.
    app["shutdown_event"] = asyncio.Event()
    app.on_startup.append(_schedule_computer_use_startup)
    app.on_cleanup.append(_cancel_computer_use_startup)

    # --- Agent runtime routes ---
    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_post("/api/notes/generate", handle_note_generate)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/audio/transcriptions", handle_audio_transcriptions)
    app.router.add_post("/v1/audio/speech", handle_audio_speech)
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/usage", handle_usage_get)
    app.router.add_post("/shutdown", handle_shutdown)
    app.router.add_post("/api/tauri/invoke", handle_tauri_invoke)
    app.router.add_post("/api/system/plan", handle_system_plan)
    app.router.add_post("/api/system/diagnose", handle_system_diagnose)
    app.router.add_post("/api/system/storage/analyze", handle_storage_analyze)
    app.router.add_get("/api/automation/status", handle_automation_status)
    app.router.add_post("/api/automation/computer", handle_computer_use_update)
    app.router.add_post("/api/automation/computer/cancel", handle_computer_use_cancel)
    app.router.add_post(
        "/api/automation/computer/permissions", handle_computer_use_permissions
    )

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
    app.router.add_post("/api/webui/sidebar-state/update", handle_webui_sidebar_state_update)

    from mona.development.api import register_development_routes
    register_development_routes(app)
    from mona.cloud.api import register_cloud_routes
    register_cloud_routes(app)
    from mona.api.stock_model_bridge import register_routes as register_stock_model_routes
    register_stock_model_routes(app)

    return app
