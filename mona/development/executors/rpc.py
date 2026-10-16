"""Bounded, bidirectional NDJSON RPC for native agents; no shell or request replay.

The separation of transport, pending requests and session routing follows Cindy's
app-server client/host design. See docs/design/development-native-executors.md.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import subprocess
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

from mona.development.store import DevelopmentError

JsonId = str | int
NotificationHandler = Callable[[str, dict[str, Any]], None]
RequestHandler = Callable[[JsonId, str, dict[str, Any]], Awaitable[Any]]


class RpcError(DevelopmentError):
    def __init__(self, code: str, message: str, *, outcome_unknown: bool = False):
        super().__init__(code, message)
        self.outcome_unknown = outcome_unknown


class MissingNativeSessionError(RpcError):
    """An exact correlated native resume rejection, never a timeout heuristic."""

    def __init__(self):
        super().__init__("native_session_not_found", "原生执行者明确返回原会话历史不存在；产品会话和项目文件仍保留。")


class RemoteRpcError(RpcError):
    def __init__(self, rpc_code: int):
        # Native error text/data may contain prompts, paths or credentials.
        super().__init__("native_request_rejected", f"原生执行者拒绝请求（协议错误 {rpc_code}）。")
        self.rpc_code = rpc_code
        self.rpc_method: str | None = None


def _id(value: Any) -> bool:
    return type(value) in (str, int) and (not isinstance(value, str) or 0 < len(value) <= 512)


def _reject_constant(_: str) -> None:
    raise ValueError("Non-finite JSON number")


class JsonRpcProcess:
    """One process/connection. User approvals cannot block its response reader."""

    def __init__(self, process: asyncio.subprocess.Process, *,
                 notification: NotificationHandler,
                 server_request: RequestHandler,
                 disconnected: Callable[[str], None],
                 jsonrpc_version: bool = False, max_frame_bytes: int = 2_097_152,
                 request_timeout: float = 30.0, max_pending: int = 128):
        self.process = process
        self._notification = notification
        self._server_request = server_request
        self._disconnected = disconnected
        self._jsonrpc_version = jsonrpc_version
        self._max_frame_bytes = max_frame_bytes
        self._timeout = request_timeout
        self._max_pending = max_pending
        self._next_id = 0
        self._pending: dict[JsonId, asyncio.Future[Any]] = {}
        self._error_classifiers: dict[JsonId, Callable[[dict[str, Any]], RpcError | None]] = {}
        self._inbound: dict[tuple[type, JsonId], asyncio.Task[None]] = {}
        self._write_lock = asyncio.Lock()
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None
        self._reader = asyncio.create_task(self._read(), name="development-rpc-reader")
        self._stderr_reader = asyncio.create_task(self._drain_stderr(), name="development-rpc-stderr")
        self.stderr_bytes = 0

    @classmethod
    async def spawn(cls, command: tuple[str, ...], *, cwd: Path, env: Mapping[str, str],
                    notification: NotificationHandler, server_request: RequestHandler,
                    disconnected: Callable[[str], None], jsonrpc_version: bool = False,
                    max_frame_bytes: int = 2_097_152, request_timeout: float = 30.0) -> JsonRpcProcess:
        if not command or not Path(command[0]).is_absolute() or not Path(command[0]).is_file():
            raise RpcError("invalid_executable", "请指定原生执行程序的实际绝对路径。")
        if Path(command[0]).suffix.lower() in {".cmd", ".bat", ".ps1"}:
            raise RpcError("unsupported_launcher", "请使用原生程序或明确的 Node 入口，不通过 shell 执行 CLI 包装脚本。")
        if any(not isinstance(x, str) or "\x00" in x for x in command):
            raise RpcError("invalid_executable", "原生启动参数无效。")
        root = Path(cwd).resolve(strict=True)
        if not root.is_dir() or not math.isfinite(request_timeout) or request_timeout <= 0:
            raise RpcError("invalid_launch", "原生启动目录或等待时间无效。")
        kwargs: dict[str, Any] = {}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        spawning = asyncio.create_task(asyncio.create_subprocess_exec(
            *command, cwd=str(root), env=dict(env), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=max_frame_bytes + 1, **kwargs,
        ))
        try:
            process = await asyncio.shield(spawning)
        except OSError as exc:
            code = "executable_access_denied" if isinstance(exc, PermissionError) else (
                "invalid_executable_format" if getattr(exc, "winerror", None) in {193, 216} or exc.errno == 8 else "native_launch_failed")
            raise RpcError(code, "本地程序未能启动；请核对路径、平台和访问权限。未发送任务。") from exc
        except asyncio.CancelledError:
            # A cancelled caller may already have created a child. Observe that
            # same spawn, drain/reap it, and never start another process.
            process = await spawning
            orphan = cls(process, notification=lambda *_: None, server_request=server_request,
                         disconnected=lambda _: None, max_frame_bytes=max_frame_bytes)
            await orphan.close()
            raise
        return cls(process, notification=notification, server_request=server_request,
                   disconnected=disconnected, jsonrpc_version=jsonrpc_version,
                   max_frame_bytes=max_frame_bytes, request_timeout=request_timeout)

    @property
    def closed(self) -> bool:
        return self._closed

    def _encode(self, message: dict[str, Any]) -> bytes:
        if self._jsonrpc_version:
            message = {"jsonrpc": "2.0", **message}
        raw = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
        if len(raw) > self._max_frame_bytes:
            raise RpcError("rpc_frame_too_large", "原生请求超过协议大小上限，未发送。")
        return raw

    async def request(self, method: str, params: dict[str, Any] | None = None,
                      *, timeout: float | None = None,
                      omit_params: bool = False,
                      classify_error: Callable[[dict[str, Any]], RpcError | None] | None = None) -> Any:
        budget = self._timeout if timeout is None else timeout
        if not math.isfinite(budget) or budget <= 0:
            raise ValueError("RPC timeout must be positive and finite")
        if self._closed:
            raise RpcError("native_disconnected", "原生连接已关闭，未重新发送任务。")
        if len(self._pending) >= self._max_pending:
            raise RpcError("rpc_busy", "原生连接待处理请求过多，请等待已有请求结果。")
        self._next_id += 1
        request_id = f"mona-{self._next_id}"
        message = {"id": request_id, "method": method}
        if not omit_params:
            message["params"] = params or {}
        raw = self._encode(message)
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        if classify_error is not None:
            self._error_classifiers[request_id] = classify_error
        written = False

        async def exchange() -> Any:
            nonlocal written
            async with self._write_lock:
                if self._closed or self.process.stdin is None:
                    raise RpcError("native_disconnected", "原生连接已关闭，未发送请求。")
                self.process.stdin.write(raw)
                written = True
                await self.process.stdin.drain()
            return await asyncio.shield(future)

        try:
            return await asyncio.wait_for(exchange(), timeout=budget)
        except RemoteRpcError as exc:
            exc.rpc_method = method
            raise
        except asyncio.TimeoutError as exc:
            raise RpcError("native_request_timeout", "等待原生回执超时；已发送的请求结果未知，不应自动重跑。",
                           outcome_unknown=written) from exc
        except (BrokenPipeError, ConnectionError, OSError) as exc:
            raise RpcError("native_transport_lost", "原生连接中断；已发送的请求结果未知。",
                           outcome_unknown=written) from exc
        finally:
            self._pending.pop(request_id, None)
            self._error_classifiers.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # Retrieve an exception even when cancellation won the race.
                future.exception()

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        await self._write({"method": method, "params": params or {}})

    async def _write(self, message: dict[str, Any]) -> None:
        raw = self._encode(message)

        async def write() -> None:
            async with self._write_lock:
                if self._closed or self.process.stdin is None:
                    raise RpcError("native_disconnected", "原生连接已关闭。")
                self.process.stdin.write(raw)
                await self.process.stdin.drain()
        try:
            await asyncio.wait_for(write(), timeout=self._timeout)
        except (asyncio.TimeoutError, BrokenPipeError, ConnectionError, OSError) as exc:
            self._fail("native_transport_lost")
            raise RpcError("native_transport_lost", "原生连接中断。", outcome_unknown=True) from exc

    async def _read(self) -> None:
        assert self.process.stdout is not None
        reason = "native_transport_lost"
        try:
            while True:
                raw = await self.process.stdout.readline()
                if not raw:
                    break
                if self._closed:
                    continue  # Keep draining pipes while the child exits.
                if len(raw) > self._max_frame_bytes or not raw.endswith(b"\n"):
                    raise ValueError("invalid frame")
                if not raw.strip():
                    continue
                message = json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
                if not isinstance(message, dict):
                    raise ValueError("invalid envelope")
                self._dispatch(message)
        except asyncio.CancelledError:
            return
        except (ValueError, UnicodeError, RecursionError, TypeError):
            reason = "native_protocol_error"
        except (OSError, ConnectionError):
            reason = "native_transport_lost"
        except Exception:
            reason = "native_event_handler_failed"
        finally:
            self._fail(reason)

    def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if method is not None:
            if not isinstance(method, str) or not method or len(method) > 200:
                raise ValueError("invalid method")
            params = message.get("params", {})
            if params is None:
                params = {}
            if not isinstance(params, dict):
                raise ValueError("invalid params")
            if "id" not in message:
                self._notification(method, params)
                return
            request_id = message["id"]
            if not _id(request_id):
                raise ValueError("invalid request id")
            key = (type(request_id), request_id)
            if key in self._inbound or len(self._inbound) >= 64:
                raise ValueError("duplicate or excessive server requests")
            task = asyncio.create_task(self._answer(request_id, method, params))
            self._inbound[key] = task
            task.add_done_callback(lambda _: self._inbound.pop(key, None))
            return
        request_id = message.get("id")
        if not _id(request_id) or ("result" in message) == ("error" in message):
            raise ValueError("invalid response")
        future = self._pending.get(request_id)
        if future is None or future.done():
            return  # Late response is not permission to replay a timed-out request.
        if "error" in message:
            error = message["error"]
            if not isinstance(error, dict) or type(error.get("code")) is not int:
                raise ValueError("invalid error")
            classifier = self._error_classifiers.get(request_id)
            classified = classifier(error) if classifier else None
            # Only a sanitized category escapes this correlated reply; arbitrary
            # vendor diagnostics are neither retained nor passed to the model.
            future.set_exception(classified or RemoteRpcError(error["code"]))
        else:
            future.set_result(message["result"])

    async def _answer(self, request_id: JsonId, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self._server_request(request_id, method, params)
            await self._write({"id": request_id, "result": result})
        except asyncio.CancelledError:
            return
        except RemoteRpcError as exc:
            with suppress(RpcError):
                await self._write({"id": request_id, "error": {"code": exc.rpc_code, "message": "Unsupported client request"}})
        except Exception:
            with suppress(RpcError):
                await self._write({"id": request_id, "error": {"code": -32603, "message": "Client request failed"}})

    async def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            while chunk := await self.process.stderr.read(8192):
                # Drain for liveness, but never infer auth/status from stderr or
                # persist arbitrary native diagnostics containing credentials.
                self.stderr_bytes += len(chunk)
        except (OSError, asyncio.CancelledError):
            return

    def _fail(self, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        for future in self._pending.values():
            if not future.done():
                future.set_exception(RpcError(reason, "原生连接已结束，请核对未完成任务的实际状态。", outcome_unknown=True))
        for task in self._inbound.values():
            task.cancel()
        try:
            self._disconnected(reason)
        except Exception:
            # Consumer bugs must not leave pending RPC futures or child handles alive.
            if self._close_task is None:
                self._close_task = asyncio.create_task(self._close())

    async def close(self) -> None:
        if self._close_task is None or (self._close_task.done() and self.process.returncode is not None):
            self._close_task = asyncio.create_task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        self._fail("native_host_closed")
        if self.process.stdin is not None:
            with suppress(BrokenPipeError, ConnectionError, OSError):
                self.process.stdin.close()  # EOF first: let native history flush.
        try:
            await asyncio.wait_for(self.process.wait(), timeout=1.5)
        except asyncio.TimeoutError:
            with suppress(ProcessLookupError):
                self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                with suppress(ProcessLookupError):
                    self.process.kill()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=1.0)
                except asyncio.TimeoutError as exc:
                    raise RpcError("native_exit_unconfirmed", "未确认原生进程已退出；不能标记为已停止。", outcome_unknown=True) from exc
        finally:
            tasks = (self._reader, self._stderr_reader, *self._inbound.values())
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
