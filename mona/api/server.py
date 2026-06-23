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
from email.utils import formatdate, getaddresses, parseaddr
from typing import Any, Callable, TypeVar

from aiohttp import web
from loguru import logger

from mona.config.paths import get_media_dir
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
) -> _T:
    """在 IMAP 账号级锁保护下执行阻塞的 IMAP 操作。"""
    key = _imap_lock_key(body)
    if key is None:
        return await asyncio.to_thread(func, body)
    if key not in _IMAP_LOCKS:
        _IMAP_LOCKS[key] = asyncio.Lock()
    async with _IMAP_LOCKS[key]:
        return await asyncio.to_thread(func, body)


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

    在线程中保持 IMAP IDLE 长连接，收到服务器推送或超时后触发回调。
    使用指数退避重连，避免网络抖动导致频繁重连。
    """

    def __init__(
        self,
        account_id: str,
        config: dict[str, Any],
        on_notification: Callable[[str], None],
    ):
        self._account_id = account_id
        self._config = config
        self._on_notification = on_notification
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._client: imaplib.IMAP4 | None = None
        self._idle_tag: bytes | None = None

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
                logger.warning(
                    f"[idle] {self._account_id} error: {e}, retry in {backoff}s"
                )
                self._stop_event.wait(backoff)
                backoff = min(backoff * 2, 60)

    def _idle_loop(self) -> None:
        """建立连接并进入 IDLE 循环，直到 stop 或连接断开。"""
        host = str(self._config.get("imapHost", "")).strip()
        port = int(self._config.get("imapPort", 993) or 993)
        username = str(self._config.get("imapUsername", "")).strip()
        password = str(self._config.get("imapPassword", "") or "")
        mailbox = str(self._config.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
        use_ssl = bool(self._config.get("useSsl", True))

        if not host or not username:
            raise ValueError("imapHost and imapUsername are required for IDLE")

        if use_ssl:
            client = imaplib.IMAP4_SSL(host, port, timeout=30)
        else:
            client = imaplib.IMAP4(host, port, timeout=30)

        self._client = client
        try:
            client.login(username, password)
            status, _ = client.select(_imap_quote_mailbox(mailbox))
            if status != "OK":
                raise RuntimeError(f"select {mailbox} failed: {status}")

            logger.info(f"[idle] {self._account_id} connected, monitoring {mailbox}")

            # IDLE 循环：每 29 分钟重新 IDLE，避免服务器超时断开
            while not self._stop_event.is_set():
                self._do_idle_cycle(timeout=29 * 60)
                if self._stop_event.is_set():
                    break
                # 收到通知或超时，触发回调
                try:
                    self._on_notification(self._account_id)
                except Exception as e:
                    logger.warning(f"[idle] {self._account_id} callback error: {e}")
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
        tag = client._new_tag().encode("ascii")
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

    def _broadcast(self, account_id: str) -> None:
        """从工作线程调用，通过事件循环广播 WebSocket 事件。"""
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._async_broadcast(account_id), self._loop)

    async def _async_broadcast(self, account_id: str) -> None:
        async with self._ws_lock:
            dead = []
            for ws in self._ws_clients:
                try:
                    await ws.send_json({"type": "new-mail", "accountId": account_id})
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
        import subprocess

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
    """从 IMAP fetch 结果中提取原始邮件字节。"""
    for item in fetched:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
            return bytes(item[1])
    return None


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
    for item in fetched:
        if isinstance(item, tuple) and item and isinstance(item[0], (bytes, bytearray)):
            head = bytes(item[0]).decode("utf-8", errors="ignore")
            if "\\Seen" in head:
                return True
    return False


def _email_decode_header_value(value: str) -> str:
    """解码邮件头字段（处理 MIME 编码）。"""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _email_extract_bodies(msg: Any) -> tuple[str, str]:
    """提取邮件正文，返回 (纯文本, HTML) 元组。"""
    plain_parts: list[str] = []
    html_parts: list[str] = []

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

    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                continue
            content_type = part.get_content_type()
            if content_type not in ("text/plain", "text/html"):
                continue
            payload = _extract_part_payload(part)
            if payload:
                if content_type == "text/plain":
                    plain_parts.append(payload)
                else:
                    html_parts.append(payload)
    else:
        content_type = msg.get_content_type()
        if content_type in ("text/plain", "text/html"):
            payload = _extract_part_payload(msg)
            if payload:
                if content_type == "text/plain":
                    plain_parts.append(payload)
                else:
                    html_parts.append(payload)

    return "\n\n".join(plain_parts), "\n\n".join(html_parts)


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


def _imap_quote_mailbox(mailbox: str) -> str:
    """对 IMAP mailbox 名加双引号，处理带空格或特殊字符的文件夹名。

    IMAP 协议要求包含空格等特殊字符的 mailbox 名必须用双引号包裹。
    imaplib 不会自动加引号，需要手动处理。
    例如 "Sent Messages" 需要变为 '"Sent Messages"' 否则 SELECT 会报 BAD。
    """
    if not mailbox:
        return '""'
    # 如果已经带引号则不处理
    if mailbox.startswith('"') and mailbox.endswith('"'):
        return mailbox
    # 转义内部反斜杠和双引号
    escaped = mailbox.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _imap_fetch_recent(body: dict[str, Any]) -> list[dict[str, Any]]:
    """连接 IMAP 并拉取邮件。

    - 支持 lastUid 增量同步：只拉取 UID > lastUid 的新邮件
    - 部分拉取 BODY.PEEK[]<0.65536>：只取前 64KB，避免下载大附件导致超时
    - 首次同步限制为最近 20 封，增量同步单次最多 50 封
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX").strip() or "INBOX"
    use_ssl = bool(body.get("useSsl", True))
    last_uid_raw = body.get("lastUid")

    # 解析 lastUid（前端传字符串或 null）
    last_uid: int | None = None
    if last_uid_raw is not None:
        try:
            last_uid = int(str(last_uid_raw).strip())
        except (ValueError, TypeError):
            last_uid = None

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    if use_ssl:
        client = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
    else:
        client = imaplib.IMAP4(imap_host, imap_port, timeout=30)

    try:
        client.login(imap_username, imap_password)
        status, _ = client.select(_imap_quote_mailbox(mailbox))
        if status != "OK":
            raise RuntimeError(f"Mailbox select failed: {status} ({mailbox})")

        # 增量同步：只拉取 UID > last_uid 的邮件
        if last_uid is not None and last_uid > 0:
            status, data = client.uid("SEARCH", "UID", f"{last_uid + 1}:*")
        else:
            # 首次同步：拉取全部 UID，后续取最后 20 封
            status, data = client.uid("SEARCH", "ALL")

        if status != "OK" or not data or not data[0]:
            return []

        uids = data[0].split()

        # 某些 IMAP 服务器在 UID search 范围无匹配时仍返回 * 对应的最新邮件，
        # 需过滤掉 UID <= last_uid 的误匹配
        if last_uid is not None and last_uid > 0:
            uids = [u for u in uids if int(u) > last_uid]
            # 增量同步单次最多 50 封
            uids = uids[-50:]
        else:
            # 首次同步限制为最近 20 封
            uids = uids[-20:]

        if not uids:
            return []

        messages: list[dict[str, Any]] = []
        for uid in uids:
            # 部分拉取：只取前 2MB（含头部+正文），避免下载大附件导致超时
            # 2MB 足以覆盖绝大多数 HTML 邮件正文，避免截断导致编码损坏
            # FLAGS 用于获取已读状态
            status, fetched = client.uid(
                "FETCH", uid, "(BODY.PEEK[]<0.2097152> UID FLAGS)"
            )
            if status != "OK" or not fetched:
                continue

            raw_bytes = _email_extract_message_bytes(fetched)
            if raw_bytes is None:
                continue

            uid_str = _email_extract_uid(fetched)
            if not uid_str:
                uid_str = uid.decode("utf-8", errors="ignore")

            parsed = BytesParser(policy=policy.default).parsebytes(raw_bytes)

            subject = _email_decode_header_value(parsed.get("Subject", ""))
            from_name, from_addr = parseaddr(
                _email_decode_header_value(parsed.get("From", ""))
            )
            from_name = from_name.strip()
            to_addrs = [
                addr for _name, addr in getaddresses([parsed.get("To", "") or ""]) if addr
            ]
            cc_addrs = [
                addr for _name, addr in getaddresses([parsed.get("Cc", "") or ""]) if addr
            ]
            date_value = parsed.get("Date", "")
            message_id = parsed.get("Message-ID", "") or ""

            body_text, body_html = _email_extract_bodies(parsed)
            # body_text 截断到 50000 字符
            if body_text:
                body_text = body_text[:50000]

            messages.append(
                {
                    "uid": uid_str,
                    "subject": subject,
                    "from": from_addr,
                    "fromName": from_name,
                    "to": ", ".join(to_addrs),
                    "cc": ", ".join(cc_addrs),
                    "date": date_value,
                    "bodyText": body_text,
                    "bodyHtml": body_html,
                    "hasAttachments": _email_has_attachments(parsed),
                    "rawSize": len(raw_bytes),
                    "isRead": _email_extract_seen_flag(fetched),
                    "messageId": message_id,
                    "attachments": _email_extract_attachments(parsed),
                }
            )

        return messages
    finally:
        with contextlib.suppress(Exception):
            client.logout()


def _imap_list_folders(body: dict[str, Any]) -> list[dict[str, Any]]:
    """连接 IMAP 并列出所有文件夹。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    if use_ssl:
        client = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
    else:
        client = imaplib.IMAP4(imap_host, imap_port, timeout=30)

    try:
        client.login(imap_username, imap_password)
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
            flags = line.split(")")[0].lstrip("(").lower() if "(" in line else ""

            # 用 STATUS 命令获取未读数（UNSEEN）
            unread_count = 0
            try:
                st, sd = client.status(_imap_quote_mailbox(name), "(UNSEEN)")
                if st == "OK" and sd and sd[0]:
                    status_line = (
                        sd[0].decode("utf-8", errors="replace")
                        if isinstance(sd[0], bytes)
                        else str(sd[0])
                    )
                    m_unseen = re.search(r"UNSEEN\s+(\d+)", status_line)
                    if m_unseen:
                        unread_count = int(m_unseen.group(1))
            except Exception:
                # 某些文件夹可能不支持 STATUS，忽略
                pass

            folders.append({
                "name": name,
                "delimiter": delimiter,
                "hasChildren": "\\haschildren" in flags.lower(),
                "flags": flags,
                "unreadCount": unread_count,
            })
        return folders
    finally:
        with contextlib.suppress(Exception):
            client.logout()


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
    """连接 IMAP 并创建文件夹。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "") or "").strip()
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not mailbox:
        raise ValueError("mailbox is required")

    if use_ssl:
        client = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
    else:
        client = imaplib.IMAP4(imap_host, imap_port, timeout=30)
        client.starttls(ssl.create_default_context())

    try:
        client.login(imap_username, imap_password)
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
    finally:
        with contextlib.suppress(Exception):
            client.logout()


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
        logger.exception("Email sync failed")
        return web.json_response({"error": str(e)}, status=500)


def _smtp_send_message(body: dict[str, Any]) -> None:
    """通过 SMTP 发送邮件。"""
    smtp_host = str(body.get("smtpHost", "") or "").strip()
    smtp_port = int(body.get("smtpPort", 587) or 587)
    smtp_username = str(body.get("smtpUsername", "") or "").strip()
    smtp_password = str(body.get("smtpPassword", "") or "")
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

    # 发送成功后，通过 IMAP APPEND 保存副本到"已发送"文件夹
    # SMTP 只负责投递，不保存副本；标准邮件客户端都会额外保存到 Sent
    _imap_append_sent(body, raw_bytes)


def _imap_append_sent(body: dict[str, Any], raw_bytes: bytes) -> None:
    """通过 IMAP APPEND 把已发送邮件副本保存到 Sent 文件夹。

    按常见"已发送"文件夹名优先级尝试，失败则用 LIST 查找含 sent/已发送 的文件夹。
    任何异常都只记录日志、不抛出——邮件已通过 SMTP 发出，保存副本失败不应影响发送结果。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    use_ssl = bool(body.get("imapUseSsl", True))

    if not imap_host or not imap_username:
        # 没有 IMAP 配置，无法保存副本（仅 SMTP 场景）
        return

    # 常见"已发送"文件夹名（按优先级）
    sent_candidates = ["Sent", "Sent Items", "Sent Messages", "已发送"]

    def _do() -> None:
        if use_ssl:
            ctx = ssl.create_default_context()
            client = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            client = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            client.starttls(ssl.create_default_context())
        try:
            client.login(imap_username, imap_password)
            # 尝试每个候选文件夹，第一个成功的即返回
            for sent_box in sent_candidates:
                try:
                    typ, _ = client.append(
                        _imap_quote_mailbox(sent_box), "(\\Seen)", None, raw_bytes
                    )
                    if typ == "OK":
                        return
                except imaplib.IMAP4.error:
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
                                typ, _ = client.append(
                                    _imap_quote_mailbox(folder_name), "(\\Seen)", None, raw_bytes
                                )
                                if typ == "OK":
                                    return
                            except imaplib.IMAP4.error:
                                continue
            logger.warning(
                "邮件已通过 SMTP 发送，但未找到可用的 Sent 文件夹保存副本"
            )
        finally:
            with contextlib.suppress(Exception):
                client.logout()

    try:
        _do()
    except Exception:
        # 保存副本失败不影响发送结果，只记录日志
        logger.warning("保存已发送邮件副本失败", exc_info=True)


async def handle_email_send(request: web.Request) -> web.Response:
    """POST /email/send - 通过 SMTP 发送邮件。

    请求体包含 SMTP 连接信息和邮件内容，发送成功返回 {"status": "ok"}。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await asyncio.to_thread(_smtp_send_message, body)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email send failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_save_draft(body: dict[str, Any]) -> None:
    """连接 IMAP，将草稿通过 APPEND 保存到 Drafts 文件夹。

    草稿邮件带 \\Draft 标志，按常见 Drafts 文件夹名优先级尝试 APPEND。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    from_address = str(body.get("fromAddress", "") or "").strip()
    from_name = str(body.get("fromName", "") or "").strip()
    to_addrs = body.get("to", []) or []
    cc_addrs = body.get("cc", []) or []
    subject = str(body.get("subject", "") or "")
    body_html = str(body.get("bodyHtml", "") or "")
    in_reply_to = body.get("inReplyTo")

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

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

    def _do() -> None:
        if use_ssl:
            ctx = ssl.create_default_context()
            client = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            client = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            client.starttls(ssl.create_default_context())
        try:
            client.login(imap_username, imap_password)
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
        finally:
            with contextlib.suppress(Exception):
                client.logout()

    _do()


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
    """测试 IMAP 登录连接，返回 {"ok": true} 或抛出异常。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    def _do() -> dict[str, Any]:
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

    return _do()


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


def _imap_delete_message(body: dict[str, Any]) -> None:
    """连接 IMAP 并删除邮件。

    优先 MOVE 到回收站（Trash/Deleted Messages/已删除），失败则回退到 +FLAGS \\Deleted + expunge。
    """
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")

    # 常见回收站文件夹名（按优先级）
    trash_candidates = ["Trash", "Deleted Messages", "已删除", "Deleted", "垃圾邮件"]

    def _do() -> None:
        if use_ssl:
            ctx = ssl.create_default_context()
            mail = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            mail = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            mail.starttls(ssl.create_default_context())

        try:
            mail.login(imap_username, imap_password)
            mail.select(_imap_quote_mailbox(mailbox))
            _delete_with_trash_fallback(mail, uid, trash_candidates)
        finally:
            # MOVE/EXPUNGE 后部分服务器会立即关闭连接，logout 可能抛
            # socket error: EOF，此时删除已成功，忽略即可
            with contextlib.suppress(Exception):
                mail.logout()

    _do()


def _delete_with_trash_fallback(
    mail: Any, uid: str, trash_candidates: list[str]
) -> None:
    """尝试 MOVE 到回收站，失败则直接标记删除。"""
    # 如果当前已在回收站文件夹，直接永久删除
    for trash in trash_candidates:
        try:
            mail.uid("MOVE", uid, _imap_quote_mailbox(trash))
            return
        except imaplib.IMAP4.error:
            continue
    # 所有回收站都失败，回退到永久删除
    mail.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
    mail.expunge()


async def handle_email_delete(request: web.Request) -> web.Response:
    """POST /email/delete - 标记删除 IMAP 邮件并 expunge。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        await _run_imap_locked(body, _imap_delete_message)
        return web.json_response({"status": "ok"})
    except Exception as e:
        logger.exception("Email delete message failed")
        return web.json_response({"error": str(e)}, status=500)


def _imap_set_flag(body: dict[str, Any]) -> None:
    """连接 IMAP 并为指定 UID 设置或清除标志（\\Seen / \\Flagged 等）。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    use_ssl = bool(body.get("useSsl", True))
    flag = str(body.get("flag", "") or "").strip()
    add = bool(body.get("add", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")
    if not flag:
        raise ValueError("flag is required")

    op = "+FLAGS" if add else "-FLAGS"

    def _do() -> None:
        if use_ssl:
            ctx = ssl.create_default_context()
            with imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30) as mail:
                mail.login(imap_username, imap_password)
                mail.select(_imap_quote_mailbox(mailbox))
                mail.uid("STORE", uid, op, f"({flag})")
        else:
            with imaplib.IMAP4(imap_host, imap_port, timeout=30) as mail:
                mail.starttls(ssl.create_default_context())
                mail.login(imap_username, imap_password)
                mail.select(_imap_quote_mailbox(mailbox))
                mail.uid("STORE", uid, op, f"({flag})")

    _do()


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
    """连接 IMAP 并将指定文件夹中所有邮件标记为已读。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")

    def _do() -> int:
        if use_ssl:
            ctx = ssl.create_default_context()
            mail = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            mail = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            mail.starttls(ssl.create_default_context())
        try:
            mail.login(imap_username, imap_password)
            mail.select(_imap_quote_mailbox(mailbox))
            # 搜索所有未读邮件
            typ, data = mail.search(None, "UNSEEN")
            if typ != "OK" or not data or not data[0]:
                return 0
            uids = data[0].split()
            for uid in uids:
                mail.uid("STORE", uid.decode(), "+FLAGS", "(\\Seen)")
            return len(uids)
        finally:
            with contextlib.suppress(Exception):
                mail.logout()

    return _do()


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
    """连接 IMAP 并永久删除指定文件夹中的所有邮件。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not mailbox:
        raise ValueError("mailbox is required")

    def _do() -> int:
        if use_ssl:
            ctx = ssl.create_default_context()
            mail = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            mail = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            mail.starttls(ssl.create_default_context())
        try:
            mail.login(imap_username, imap_password)
            mail.select(_imap_quote_mailbox(mailbox))
            typ, data = mail.search(None, "ALL")
            if typ != "OK" or not data or not data[0]:
                return 0
            uids = data[0].split()
            for uid in uids:
                mail.uid("STORE", uid.decode(), "+FLAGS", "(\\Deleted)")
            mail.expunge()
            return len(uids)
        finally:
            with contextlib.suppress(Exception):
                mail.logout()

    return _do()


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
    """连接 IMAP 并将指定 UID 的邮件移动到目标文件夹。"""
    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    dest_mailbox = str(body.get("destMailbox", "") or "").strip()
    uid = str(body.get("uid", "") or "")
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")
    if not dest_mailbox:
        raise ValueError("destMailbox is required")

    def _do() -> None:
        if use_ssl:
            ctx = ssl.create_default_context()
            mail = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx, timeout=30)
        else:
            mail = imaplib.IMAP4(imap_host, imap_port, timeout=30)
            mail.starttls(ssl.create_default_context())

        try:
            mail.login(imap_username, imap_password)
            mail.select(_imap_quote_mailbox(mailbox))
            # 优先尝试 IMAP MOVE（RFC 6851），失败则回退到 COPY+STORE+EXPUNGE
            try:
                mail.uid("MOVE", uid, _imap_quote_mailbox(dest_mailbox))
            except imaplib.IMAP4.error:
                mail.uid("COPY", uid, _imap_quote_mailbox(dest_mailbox))
                mail.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
                mail.expunge()
        finally:
            # MOVE/EXPUNGE 后部分服务器会立即关闭连接，logout 可能抛
            # socket error: EOF，此时邮件已成功移动，忽略即可
            with contextlib.suppress(Exception):
                mail.logout()

    _do()


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
    """连接 IMAP，FETCH 完整邮件，按 filename 提取附件并返回 base64 编码。"""
    import base64

    imap_host = str(body.get("imapHost", "") or "").strip()
    imap_port = int(body.get("imapPort", 993) or 993)
    imap_username = str(body.get("imapUsername", "") or "").strip()
    imap_password = str(body.get("imapPassword", "") or "")
    mailbox = str(body.get("mailbox", "INBOX") or "INBOX")
    uid = str(body.get("uid", "") or "")
    filename = str(body.get("filename", "") or "").strip()
    use_ssl = bool(body.get("useSsl", True))

    if not imap_host or not imap_username:
        raise ValueError("imapHost and imapUsername are required")
    if not uid:
        raise ValueError("uid is required")
    if not filename:
        raise ValueError("filename is required")

    if use_ssl:
        client = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
    else:
        client = imaplib.IMAP4(imap_host, imap_port, timeout=30)

    try:
        client.login(imap_username, imap_password)
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

        parsed = BytesParser(policy=policy.default).parsebytes(raw_bytes)

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
    finally:
        with contextlib.suppress(Exception):
            client.logout()


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


async def handle_schedule_complete(request: web.Request) -> web.Response:
    """POST /api/schedule/items/{id}/complete - mark a personal item done."""
    svc = _require_schedule_service(request)
    item_id = request.match_info["id"]
    ok = await svc.complete_item(item_id)
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
    app = web.Application(client_max_size=20 * 1024 * 1024)  # 20MB for base64 images
    app["agent_loop"] = agent_loop
    app["model_name"] = model_name
    app["request_timeout"] = request_timeout
    app["session_locks"] = {}  # per-user locks, keyed by session_key
    # Event used by POST /shutdown to unwind the gateway's main loop cleanly.
    app["shutdown_event"] = asyncio.Event()
    app["schedule_service"] = schedule_service

    app.router.add_post("/v1/chat/completions", handle_chat_completions)
    app.router.add_get("/v1/models", handle_models)
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

    # Email routes
    app.router.add_post("/email/folders", handle_email_folders)
    app.router.add_post("/email/create_folder", handle_email_create_folder)
    app.router.add_post("/email/sync", handle_email_sync)
    app.router.add_post("/email/send", handle_email_send)
    app.router.add_post("/email/delete", handle_email_delete)
    app.router.add_post("/email/set_flag", handle_email_set_flag)
    app.router.add_post("/email/mark_all_read", handle_email_mark_all_read)
    app.router.add_post("/email/empty_folder", handle_email_empty_folder)
    app.router.add_post("/email/move", handle_email_move)
    app.router.add_post("/email/analyze", handle_email_analyze)
    app.router.add_post("/email/fetch_attachment", handle_email_fetch_attachment)
    app.router.add_post("/email/save_draft", handle_email_save_draft)
    app.router.add_post("/email/test_connection", handle_email_test_connection)

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

    # Schedule routes
    app.router.add_get("/api/schedule/items", handle_schedule_list)
    app.router.add_get("/api/schedule/items/{id}", handle_schedule_get)
    app.router.add_post("/api/schedule/items", handle_schedule_create)
    app.router.add_post("/api/schedule/items/{id}/update", handle_schedule_update)
    app.router.add_post("/api/schedule/items/{id}/remove", handle_schedule_remove)
    app.router.add_post("/api/schedule/items/{id}/complete", handle_schedule_complete)
    app.router.add_post("/api/schedule/items/{id}/toggle", handle_schedule_toggle)
    app.router.add_get("/api/schedule/notifications", handle_schedule_notifications)

    # 设置 IDLE 管理器的事件循环，并在应用清理时停止所有 IDLE 监听
    _idle_manager.set_loop(asyncio.get_event_loop())

    async def _on_cleanup(_app: web.Application) -> None:
        _idle_manager.stop_all()

    app.on_cleanup.append(_on_cleanup)

    return app
