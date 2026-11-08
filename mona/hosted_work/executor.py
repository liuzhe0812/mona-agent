"""Bounded child-process transport. Losing a reply never dispatches a replacement run."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import sys
import time
from pathlib import Path

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.sandbox import DockerSandbox

_PIDFD_PROCESS_GROUP = 1 << 2  # Linux PIDFD_SIGNAL_PROCESS_GROUP (6.9+).
_GROUP_EXIT_TIMEOUT = 3.0
_STOP_GRACE_TIMEOUT = 15.0


def _owned_group_handle(process, nonce: str) -> int | None:
    """Pin this new session leader before any model payload is sent."""
    if os.name != "posix" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return None
    for attempt in range(5):
        if process.returncode is not None:
            return None
        fd = None
        try:
            fd = os.pidfd_open(process.pid)
            proc = Path("/proc") / str(process.pid)
            environment = (proc / "environ").read_bytes().split(b"\0")
            marker = ("MONA_HOSTED_PROCESS_NONCE=" + nonce).encode("ascii")
            stat = (proc / "stat").read_text(encoding="ascii")
            fields = stat[stat.rfind(")") + 2:].split()
            if (marker not in environment or int(fields[1]) != os.getpid()
                    or int(fields[2]) != process.pid or int(fields[3]) != process.pid):
                raise ValueError("unverified hosted process group")
            # A zero signal tests that this kernel can address this exact group
            # through the pinned pidfd, not through a potentially reusable PGID.
            signal.pidfd_send_signal(fd, 0, None, _PIDFD_PROCESS_GROUP)
            return fd
        except (OSError, ValueError, IndexError, TypeError, AttributeError, NotImplementedError):
            if fd is not None:
                os.close(fd)
            if attempt < 4 and process.returncode is None:
                time.sleep(0.01)
    return None


def _group_present(process, fd: int | None) -> bool:
    try:
        if fd is not None:
            signal.pidfd_send_signal(fd, 0, None, _PIDFD_PROCESS_GROUP)
        elif os.name == "posix":
            # Probe only: never send a signal to a numerical group after its
            # leader may have exited and its identity may have been reused.
            os.killpg(process.pid, 0)
        else:
            return False  # Local non-Linux test fixtures have no POSIX group.
    except ProcessLookupError:
        return False
    except (OSError, TypeError, AttributeError, NotImplementedError):
        raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503) from None
    return True


async def _stop_remaining_group(process, fd: int | None) -> bool:
    """Terminate surviving members of the pinned group, or fail closed."""
    if not _group_present(process, fd):
        return False
    if fd is None:
        raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503)
    try:
        signal.pidfd_send_signal(fd, signal.SIGKILL, None, _PIDFD_PROCESS_GROUP)
    except ProcessLookupError:
        return False
    except (OSError, TypeError, AttributeError, NotImplementedError):
        raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503) from None
    # Reap the leader before checking for remaining group members; otherwise a
    # stopped leader can itself keep the group visible as a zombie.
    if process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), _GROUP_EXIT_TIMEOUT)
        except TimeoutError:
            raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503) from None
    deadline = asyncio.get_running_loop().time() + _GROUP_EXIT_TIMEOUT
    while _group_present(process, fd):
        if asyncio.get_running_loop().time() >= deadline:
            raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503)
        await asyncio.sleep(0.05)
    return True


def child_environment(config: HostedWorkConfig, payload: dict) -> dict[str, str]:
    allowed = {"PATH", "LANG", "LC_ALL", "SYSTEMROOT"}
    if payload.get("action") == "turn":
        selected = config.models.get(payload.get("model_id", ""))
        if selected is not None and selected.source == "mona" and selected.api_key_env:
            allowed.add(selected.api_key_env)
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    if (payload.get("action") == "turn" and selected is not None and selected.source == "codex"
            and config.codex.local_proxy_url):
        environment.update({key: config.codex.local_proxy_url for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")})
    environment.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONNOUSERSITE="1")
    return environment


class ProcessExecutor:
    def __init__(self, config: HostedWorkConfig):
        self.config = config
        self.processes: dict[tuple[str, str], asyncio.subprocess.Process] = {}
        self.group_handles: dict[tuple[str, str], int] = {}
        self.forced_groups: set[tuple[str, str]] = set()
        self.stop_watchdogs: dict[tuple[str, str], asyncio.Task] = {}
        self.cancelled: set[tuple[str, str]] = set()

    async def _watch_cancelled_group(self, key, process, handle: int) -> None:
        """Bound the grace period even if an orphan keeps stdout open."""
        deadline = asyncio.get_running_loop().time() + _STOP_GRACE_TIMEOUT
        while process.returncode is None and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        try:
            if _group_present(process, handle):
                self.forced_groups.add(key)
                signal.pidfd_send_signal(handle, signal.SIGKILL, None, _PIDFD_PROCESS_GROUP)
        except ProcessLookupError:
            pass
        except (WorkError, OSError, TypeError, AttributeError, NotImplementedError):
            # The main execution path must retain an unknown result.
            self.forced_groups.add(key)

    def cancel(self, owner: str, run_id: str):
        key = (owner, run_id)
        self.cancelled.add(key)
        process = self.processes.get(key)
        if process:
            handle = self.group_handles.get(key)
            if handle is not None:
                was_running = process.returncode is None
                try:
                    if was_running:
                        signal.pidfd_send_signal(handle, signal.SIGTERM)
                    else:
                        # The leader may have exited while a descendant still
                        # holds the stream or continues an upstream request.
                        signal.pidfd_send_signal(handle, signal.SIGKILL, None, _PIDFD_PROCESS_GROUP)
                        self.forced_groups.add(key)
                except ProcessLookupError:
                    pass
                except (OSError, TypeError, AttributeError, NotImplementedError):
                    raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503) from None
                if was_running and key not in self.stop_watchdogs:
                    self.stop_watchdogs[key] = asyncio.create_task(self._watch_cancelled_group(key, process, handle))
            elif os.name != "posix" and process.returncode is None:
                process.send_signal(signal.SIGTERM)

    async def file(self, owner: str, operation_id: str, request: dict, on_event) -> dict:
        if (not isinstance(request, dict) or not isinstance(request.get("action"), str)
                or request["action"] not in {"rename", "trash"}):
            raise WorkError("invalid_operation", "此文件操作不可用。")
        # Existing file lifecycle owns the user lock, snapshot commit and cleanup.
        return await self.execute({"action": "upload", "owner": owner, "run_id": operation_id,
                                   "file_request": dict(request)}, on_event)

    async def execute(self, payload: dict, on_event) -> dict:
        if sys.platform != "linux":
            raise WorkError("linux_required", "在线任务需要 Ubuntu 隔离环境，未改用本机执行。", 503)
        key = (payload["owner"], payload["run_id"])
        if key in self.processes:
            raise WorkError("duplicate_execution", "此任务已在执行，未重复派发。", 409)
        if key in self.cancelled:
            self.cancelled.discard(key)
            result = {"status": "cancelled", "message": "任务在派发前已停止。", "workspace_saved": True}
            selected = self.config.models.get(payload.get("model_id", ""))
            if selected is not None and selected.source == "codex":
                result["billing_usage"] = {"prompt_tokens": 0, "cached_tokens": 0,
                                           "completion_tokens": 0, "complete": True}
            return result
        # History/checkpoints may contain losslessly restored image blocks.
        # Their total encoded size has its own account-scoped bound; retain a
        # separate bound for text and protocol overhead.
        frame_limit = max(self.config.max_history_bytes * 2, self.config.max_file_bytes * 2 + 65536,
                          self.config.max_history_bytes + self.config.history_media_expand_bytes + 65536)
        environment = child_environment(self.config, payload)
        nonce = secrets.token_hex(24)
        environment["MONA_HOSTED_PROCESS_NONCE"] = nonce
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-m", "mona.hosted_work.turn", "--parent-pid", str(os.getpid()),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=frame_limit + 1, start_new_session=True, env=environment,
            cwd=Path(__file__).resolve().parents[2],
        )
        handle = _owned_group_handle(process, nonce)
        if os.name == "posix" and handle is None:
            # The child is still waiting for its input; close it without
            # dispatching a model request when group ownership cannot be pinned.
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), _GROUP_EXIT_TIMEOUT)
            except TimeoutError:
                pass
            self.cancelled.discard(key)
            raise WorkError("execution_cleanup_unknown", "无法确认任务进程可安全停止，本次未开始执行。", 503)
        self.processes[key] = process
        if handle is not None:
            self.group_handles[key] = handle
        if key in self.cancelled:
            if handle is not None:
                try:
                    signal.pidfd_send_signal(handle, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                process.send_signal(signal.SIGTERM)
        result = None

        async def stdout():
            nonlocal result
            while raw := await process.stdout.readline():
                if len(raw) > frame_limit:
                    raise WorkError("protocol_limit", "任务输出超过安全上限。", 503)
                event = json.loads(raw)
                if not isinstance(event, dict) or set(event) != {"kind", "data"} or not isinstance(event["data"], dict):
                    raise WorkError("protocol_error", "任务执行状态无法确认。", 503)
                kind, value = event["kind"], event["data"]
                if result is not None:
                    raise WorkError("protocol_error", "任务结束后返回了额外操作。", 503)
                if kind == "result":
                    if value.get("status") not in {"completed", "failed", "cancelled", "unknown"}:
                        raise WorkError("protocol_error", "任务执行状态无法确认。", 503)
                    result = value
                elif kind in {"delta", "progress", "artifact", "history", "checkpoint", "context", "title", "desktop", "widget"}:
                    await on_event(kind, value)
                else:
                    raise WorkError("protocol_error", "任务执行状态无法确认。", 503)

        async def stderr():
            total = 0
            while raw := await process.stderr.read(65536):
                total += len(raw)
                if total > 1024 * 1024:
                    raise WorkError("diagnostic_limit", "任务诊断输出异常，已停止执行。", 503)
                # Never persist raw engine diagnostics or credential-bearing exceptions.

        readers = [asyncio.create_task(stdout()), asyncio.create_task(stderr())]
        try:
            envelope = {"config": self.config.model_dump(), "payload": payload}
            process.stdin.write(json.dumps(envelope, ensure_ascii=False, allow_nan=False).encode())
            await process.stdin.drain()
            process.stdin.close()
            await asyncio.wait_for(asyncio.gather(*readers, process.wait()),
                                   self.config.run_timeout_seconds + self.config.tool_timeout_seconds + 45)
            if process.returncode != 0 or result is None:
                raise WorkError("execution_unknown", "执行结果待核对，不会自动重新执行。", 503)
            if await _stop_remaining_group(process, handle) or key in self.forced_groups:
                raise WorkError("execution_cleanup_unknown", "任务的后台进程未正常结束，请核对结果。", 503)
            return result
        except BaseException as error:
            cleanup_error = None
            try:
                if process.returncode is None:
                    if handle is not None:
                        try:
                            signal.pidfd_send_signal(handle, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                    else:
                        process.send_signal(signal.SIGTERM)
                    try:
                        await asyncio.wait_for(process.wait(), 20)
                    except TimeoutError:
                        # The pinned pidfd targets the original group even if
                        # its numeric PID/PGID is later reused.
                        await _stop_remaining_group(process, handle)
                await _stop_remaining_group(process, handle)
            except (WorkError, OSError, AttributeError) as exc:
                cleanup_error = exc
            # A killed CLI is not proof the container stopped. Check and remove
            # only this exact, owner-labelled container before releasing capacity.
            cleanup = DockerSandbox(self.config, key[0], key[1],
                                    Path(self.config.state_dir) / "users" / key[0] / "workspace.zip")
            cleanup.created = True
            try:
                await asyncio.shield(cleanup.close())
            except Exception:
                pass  # The caller records unknown and keeps the user blocked.
            if cleanup_error is not None:
                raise WorkError("execution_cleanup_unknown", "任务进程的结束状态尚未确认。", 503) from error
            raise
        finally:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            watchdog = self.stop_watchdogs.pop(key, None)
            if watchdog is not None:
                watchdog.cancel()
                await asyncio.gather(watchdog, return_exceptions=True)
            self.processes.pop(key, None)
            self.group_handles.pop(key, None)
            if handle is not None:
                os.close(handle)
            self.forced_groups.discard(key)
            self.cancelled.discard(key)
