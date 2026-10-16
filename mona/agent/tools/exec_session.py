"""Session support for long-running exec workflows."""

from __future__ import annotations

import asyncio
import shutil
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

DEFAULT_YIELD_MS = 1000
MAX_YIELD_MS = 30_000
DEFAULT_WAIT_FOR_MS = 10_000
MAX_WAIT_FOR_MS = 120_000
DEFAULT_MAX_OUTPUT_CHARS = 10_000
MAX_OUTPUT_CHARS = 50_000


@dataclass(slots=True)
class _SessionPoll:
    output: str
    done: bool
    exit_code: int | None
    elapsed_s: float = 0.0
    timed_out: bool = False
    terminated: bool = False
    stdin_closed: bool = False
    truncated_chars: int = 0


@dataclass(slots=True)
class ExecSessionInfo:
    session_id: str
    command: str
    cwd: str
    elapsed_s: float
    idle_s: float
    remaining_s: float
    returncode: int | None


class _ExecSession:
    def __init__(
        self,
        *,
        session_id: str,
        process: asyncio.subprocess.Process,
        command: str,
        cwd: str,
        timeout: int,
        owner_session_key: str | None,
        diagnostics: Callable[[int | None, str], str] | None = None,
        observe_output: bool = False,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self.session_id = session_id
        self.process = process
        self.command = command
        self.cwd = cwd
        self.started_at = time.monotonic()
        self.started_at_iso = datetime.now(timezone.utc).isoformat()
        self.finished_at: float | None = None
        self.background = False
        self._observe_output = observe_output
        self._on_change = on_change
        self._output_preview = ""
        self._output_truncated = False
        self._terminated = False
        self.deadline = time.monotonic() + timeout
        self.owner_session_key = owner_session_key
        self._diagnostics = diagnostics
        self._stderr_tail = ""
        self.last_access = time.monotonic()
        self._chunks: list[str] = []
        self._lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._timed_out = False
        self._stdout_task = asyncio.create_task(self._read_stream(process.stdout, ""))
        self._stderr_task = asyncio.create_task(self._read_stream(process.stderr, "STDERR:\n"))
        if observe_output:
            self._exit_task = asyncio.create_task(self._watch_exit())

    def _changed(self) -> None:
        if self.background and self._on_change:
            self._on_change()

    async def _watch_exit(self) -> None:
        await self.process.wait()
        self.finished_at = time.monotonic()
        self._changed()

    def describe(self) -> dict[str, Any]:
        status = "running"
        if self.process.returncode is not None:
            status = "timed_out" if self._timed_out else "terminated" if self._terminated else "exited"
        return {
            "id": self.session_id, "command": self.command, "cwd": self.cwd,
            "startedAt": self.started_at_iso,
            "elapsedSeconds": max(0.0, (self.finished_at or time.monotonic()) - self.started_at),
            "status": status, "exitCode": self.process.returncode,
        }

    async def _read_stream(
        self,
        stream: asyncio.StreamReader | None,
        prefix: str,
    ) -> None:
        if stream is None:
            return
        first = True
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            if prefix and first:
                text = prefix + text
                first = False
            async with self._lock:
                self._chunks.append(text)
                if self._observe_output:
                    combined = self._output_preview + text
                    self._output_truncated |= len(combined) > MAX_OUTPUT_CHARS
                    self._output_preview = combined[-MAX_OUTPUT_CHARS:]
                if prefix and self._diagnostics:
                    self._stderr_tail = (self._stderr_tail + text)[-4096:]
            self._changed()

    async def write(self, chars: str) -> str | None:
        if self.process.returncode is not None:
            return "session has already exited"
        if self.process.stdin is None:
            return "session stdin is not available"
        try:
            self.process.stdin.write(chars.encode("utf-8"))
            await self.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            return "session stdin is closed"
        return None

    async def close_stdin(self) -> str | None:
        if self.process.returncode is not None:
            return "session has already exited"
        if self.process.stdin is None:
            return "session stdin is not available"
        self.process.stdin.close()
        with suppress(BrokenPipeError, ConnectionResetError):
            await self.process.stdin.wait_closed()
        return None

    async def poll(
        self,
        yield_time_ms: int,
        max_output_chars: int,
        *,
        terminated: bool = False,
        stdin_closed: bool = False,
    ) -> _SessionPoll:
        self.last_access = time.monotonic()
        if yield_time_ms > 0 and self.process.returncode is None:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self.process.wait(), timeout=min(yield_time_ms, MAX_YIELD_MS) / 1000,
                )

        if self.process.returncode is None and time.monotonic() >= self.deadline:
            self._timed_out = True
            await self.kill()

        if self.process.returncode is not None:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.gather(self._stdout_task, self._stderr_task),
                    timeout=2.0,
                )

        async with self._lock:
            output = "".join(self._chunks)
            self._chunks.clear()

        output, truncated = _truncate_output(output, max_output_chars)
        if self.process.returncode is not None and not (terminated or self._terminated or self._timed_out) and self._diagnostics:
            diagnostics = self._diagnostics(self.process.returncode, self._stderr_tail)
            if diagnostics:
                output = f"{output}\n{diagnostics}" if output else diagnostics
        return _SessionPoll(
            output=output,
            done=self.process.returncode is not None,
            exit_code=self.process.returncode,
            elapsed_s=max(0.0, time.monotonic() - self.started_at),
            timed_out=self._timed_out,
            terminated=terminated or self._terminated,
            stdin_closed=stdin_closed,
            truncated_chars=truncated,
        )

    async def kill(self) -> None:
        from mona.agent.tools.shell import kill_process_tree

        async with self._stop_lock:
            if self.process.returncode is None:
                self._terminated = True
            await kill_process_tree(self.process)
            self._changed()


class ExecSessionManager:
    def __init__(self, *, max_sessions: int = 8, idle_timeout: int = 1800,
                 observe_output: bool = False) -> None:
        self.max_sessions = max_sessions
        self.idle_timeout = idle_timeout
        self._sessions: dict[str, _ExecSession] = {}
        self._completed: dict[str, _ExecSession] = {}
        self._observe_output = observe_output
        self.on_change: Callable[[], None] | None = None
        self._lock = asyncio.Lock()

    def _changed(self) -> None:
        if self.on_change:
            self.on_change()

    def _remember(self, session: _ExecSession) -> None:
        if self._observe_output and session.background:
            self._completed[session.session_id] = session
            while len(self._completed) > self.max_sessions:
                self._completed.pop(next(iter(self._completed)))
            self._changed()

    def describe(self) -> list[dict[str, Any]]:
        """Read the Code process projection without consuming model output."""
        return [session.describe() for session in {**self._completed, **self._sessions}.values()
                if session.background]

    async def inspect(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id) or self._completed.get(session_id)
        if session is None or not session.background:
            raise KeyError(session_id)
        if session.process.returncode is not None:
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(asyncio.gather(
                    session._stdout_task, session._stderr_task,
                )), timeout=2.0)
        return {**session.describe(), "output": session._output_preview,
                "truncated": session._output_truncated}

    async def stop(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id) or self._completed.get(session_id)
        if session is None or not session.background:
            raise KeyError(session_id)
        await session.kill()
        if session.process.returncode is None:
            raise RuntimeError("未确认命令已停止，请核对当前运行状态。")
        async with self._lock:
            self._sessions.pop(session_id, None)
            self._remember(session)
        return await self.inspect(session_id)

    async def start(
        self,
        *,
        command: str,
        cwd: str,
        env: dict[str, str],
        timeout: int,
        shell_program: str | None,
        login: bool,
        yield_time_ms: int,
        max_output_chars: int,
        owner_session_key: str | None = None,
    ) -> tuple[str, _SessionPoll]:
        async with self._lock:
            await self._cleanup_locked()
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError(f"maximum exec sessions reached ({self.max_sessions})")
            process = await self._spawn(command, cwd, env, shell_program, login)
            session_id = uuid.uuid4().hex[:12]
            session = _ExecSession(
                session_id=session_id,
                process=process,
                command=command,
                cwd=cwd,
                timeout=timeout,
                owner_session_key=owner_session_key,
                diagnostics=self._execution_diagnostics(),
                observe_output=self._observe_output,
                on_change=self._changed,
            )
            self._sessions[session_id] = session

        try:
            poll = await session.poll(yield_time_ms, max_output_chars)
        except asyncio.CancelledError:
            await session.kill()
            async with self._lock:
                self._sessions.pop(session_id, None)
            raise
        if poll.done:
            async with self._lock:
                self._sessions.pop(session_id, None)
        else:
            session.background = True
            self._changed()
        return session_id, poll

    def _execution_diagnostics(self) -> Callable[[int | None, str], str] | None:
        return None

    async def write(
        self,
        *,
        session_id: str,
        chars: str | None,
        close_stdin: bool,
        terminate: bool,
        yield_time_ms: int,
        max_output_chars: int,
    ) -> _SessionPoll:
        async with self._lock:
            await self._cleanup_locked()
            session = self._sessions.get(session_id) or self._completed.get(session_id)
        if session is None:
            raise KeyError(session_id)

        if chars:
            error = await session.write(chars)
            if error:
                raise RuntimeError(error)
        stdin_closed = False
        if close_stdin:
            error = await session.close_stdin()
            if error:
                raise RuntimeError(error)
            stdin_closed = True
        if terminate:
            await session.kill()
        poll = await session.poll(
            yield_time_ms,
            max_output_chars,
            terminated=terminate,
            stdin_closed=stdin_closed,
        )
        if poll.done:
            async with self._lock:
                self._sessions.pop(session_id, None)
                self._remember(session)
        return poll

    async def list(self) -> list[ExecSessionInfo]:
        async with self._lock:
            await self._cleanup_locked()
            now = time.monotonic()
            return [
                ExecSessionInfo(
                    session_id=session_id,
                    command=session.command,
                    cwd=session.cwd,
                    elapsed_s=max(0.0, now - session.started_at),
                    idle_s=max(0.0, now - session.last_access),
                    remaining_s=max(0.0, session.deadline - now),
                    returncode=session.process.returncode,
                )
                for session_id, session in sorted(self._sessions.items())
            ]

    async def cancel_by_session(self, session_key: str) -> int:
        async with self._lock:
            owned = [
                session_id
                for session_id, session in self._sessions.items()
                if session.owner_session_key == session_key
                and session.process.returncode is None
            ]
            sessions = [self._sessions.pop(session_id) for session_id in owned]
        if sessions:
            await asyncio.gather(*(session.kill() for session in sessions))
            async with self._lock:
                for session in sessions:
                    self._remember(session)
        return len(sessions)

    async def _cleanup_locked(self) -> None:
        if self._observe_output:
            for session_id, session in list(self._sessions.items()):
                if session.process.returncode is not None:
                    self._sessions.pop(session_id)
                    self._remember(session)
        now = time.monotonic()
        stale = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_access > self.idle_timeout
        ]
        for session_id in stale:
            session = self._sessions.pop(session_id)
            await session.kill()
            self._remember(session)

    async def _spawn(
        self,
        command: str,
        cwd: str,
        env: dict[str, str],
        shell_program: str | None,
        login: bool,
    ) -> asyncio.subprocess.Process:
        from mona.agent.tools import shell

        if shell._IS_WINDOWS:
            return await asyncio.create_subprocess_shell(
                command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
        shell_program = shell_program or shutil.which("bash") or "/bin/bash"
        args = [shell_program]
        if login and shell_program.rsplit("/", 1)[-1] in {"bash", "zsh"}:
            args.append("-l")
        args.extend(["-c", command])
        return await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            start_new_session=True,
        )


DEFAULT_EXEC_SESSION_MANAGER = ExecSessionManager()


def clamp_session_int(value: int | None, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    return min(max(value, minimum), maximum)


def _truncate_output(output: str, max_output_chars: int) -> tuple[str, int]:
    if len(output) <= max_output_chars:
        return output, 0
    half = max_output_chars // 2
    omitted = len(output) - max_output_chars
    return (
        output[:half]
        + f"\n\n... ({omitted:,} chars truncated) ...\n\n"
        + output[-half:],
        omitted,
    )


def format_session_poll(session_id: str, poll: _SessionPoll) -> str:
    parts = [poll.output] if poll.output else []
    if poll.truncated_chars:
        parts.append(f"(output truncated by {poll.truncated_chars:,} chars)")
    if poll.timed_out:
        parts.append("Error: Command timed out; session was terminated.")
    if poll.terminated and not poll.timed_out:
        parts.append("Session terminated.")
    if poll.stdin_closed:
        parts.append("Stdin closed.")
    if poll.done:
        parts.append(f"Exit code: {poll.exit_code}")
    else:
        parts.append(f"Process running. session_id: {session_id}")
    parts.append(f"Elapsed: {poll.elapsed_s:.1f}s")
    return "\n".join(parts) if parts else "(no output yet)"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema("Session id returned by exec when yield_time_ms is used."),
        chars=StringSchema(
            "Bytes/text to write to stdin. Omit or pass an empty string to only poll recent output.",
            nullable=True,
        ),
        close_stdin=BooleanSchema(
            description="Close stdin after writing chars. Useful for commands waiting for EOF.",
            default=False,
        ),
        terminate=BooleanSchema(
            description="Terminate the running exec session.",
            default=False,
        ),
        yield_time_ms=IntegerSchema(
            DEFAULT_YIELD_MS,
            description="Milliseconds to wait before returning recent output (default 1000, max 30000).",
            minimum=0,
            maximum=MAX_YIELD_MS,
        ),
        wait_for=StringSchema(
            "Optional text to wait for in output before returning. "
            "Useful for interactive commands and dev servers.",
            nullable=True,
        ),
        wait_timeout_ms=IntegerSchema(
            DEFAULT_WAIT_FOR_MS,
            description="Maximum milliseconds to wait for wait_for text (default 10000, max 120000).",
            minimum=0,
            maximum=MAX_WAIT_FOR_MS,
            nullable=True,
        ),
        max_output_chars=IntegerSchema(
            DEFAULT_MAX_OUTPUT_CHARS,
            description="Maximum output characters to return from this poll (default 10000, max 50000).",
            minimum=1000,
            maximum=MAX_OUTPUT_CHARS,
        ),
        max_output_tokens=IntegerSchema(
            DEFAULT_MAX_OUTPUT_CHARS,
            description="Compatibility alias for max_output_chars. The current runtime uses a character budget.",
            minimum=1000,
            maximum=MAX_OUTPUT_CHARS,
            nullable=True,
        ),
        required=["session_id"],
    )
)
class WriteStdinTool(Tool):
    """Write to or poll a running exec session."""

    _scopes = {"core", "subagent"}
    config_key = "exec"

    @classmethod
    def config_cls(cls):
        from mona.agent.tools.shell import ExecToolConfig

        return ExecToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.exec.enable

    def __init__(
        self,
        *,
        manager: ExecSessionManager | None = None,
    ) -> None:
        self._manager = manager or DEFAULT_EXEC_SESSION_MANAGER

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def exclusive(self) -> bool:
        return True

    @property
    def name(self) -> str:
        return "write_stdin"

    @property
    def description(self) -> str:
        return (
            "Interact with a running exec session created by exec with "
            "yield_time_ms. Use chars='' to poll without writing, chars to send "
            "stdin, close_stdin=true to send EOF, or terminate=true to stop the "
            "process. Use wait_for with wait_timeout_ms for dev servers, test "
            "watchers, and prompts where you need to wait for expected output. "
            "Do not use this to start new commands; start them with exec."
        )

    async def execute(
        self,
        session_id: str,
        chars: str | None = None,
        close_stdin: bool = False,
        terminate: bool = False,
        yield_time_ms: int | None = None,
        wait_for: str | None = None,
        wait_timeout_ms: int | None = None,
        max_output_chars: int | None = None,
        max_output_tokens: int | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            if max_output_chars is None:
                max_output_chars = max_output_tokens
            output_limit = clamp_session_int(
                max_output_chars,
                DEFAULT_MAX_OUTPUT_CHARS,
                1000,
                MAX_OUTPUT_CHARS,
            )
            if wait_for:
                return await self._wait_for_output(
                    session_id=session_id,
                    chars=chars,
                    close_stdin=close_stdin,
                    terminate=terminate,
                    wait_for=wait_for,
                    wait_timeout_ms=clamp_session_int(
                        wait_timeout_ms,
                        DEFAULT_WAIT_FOR_MS,
                        0,
                        MAX_WAIT_FOR_MS,
                    ),
                    max_output_chars=output_limit,
                )
            poll = await self._manager.write(
                session_id=session_id,
                chars=chars,
                close_stdin=close_stdin,
                terminate=terminate,
                yield_time_ms=clamp_session_int(yield_time_ms, DEFAULT_YIELD_MS, 0, MAX_YIELD_MS),
                max_output_chars=output_limit,
            )
            return format_session_poll(session_id, poll)
        except KeyError:
            return f"Error: exec session not found: {session_id}"
        except Exception as exc:
            return f"Error writing to exec session: {exc}"

    async def _wait_for_output(
        self,
        *,
        session_id: str,
        chars: str | None,
        close_stdin: bool,
        terminate: bool,
        wait_for: str,
        wait_timeout_ms: int,
        max_output_chars: int,
    ) -> str:
        deadline = time.monotonic() + (wait_timeout_ms / 1000)
        aggregate: list[str] = []
        first = True
        poll: _SessionPoll | None = None

        while True:
            remaining_ms = max(0, int((deadline - time.monotonic()) * 1000))
            step_ms = min(500, remaining_ms)
            poll = await self._manager.write(
                session_id=session_id,
                chars=chars if first else None,
                close_stdin=close_stdin if first else False,
                terminate=terminate if first else False,
                yield_time_ms=step_ms,
                max_output_chars=max_output_chars,
            )
            first = False
            if poll.output:
                aggregate.append(poll.output)
                joined = "".join(aggregate)
                if wait_for in joined:
                    poll.output = joined
                    return format_session_poll(session_id, poll)
            if poll.done or remaining_ms <= 0:
                poll.output = "".join(aggregate)
                result = format_session_poll(session_id, poll)
                if wait_for not in poll.output:
                    result += f"\nWait target not observed: {wait_for!r}"
                return result


@tool_parameters(tool_parameters_schema())
class ListExecSessionsTool(Tool):
    """List active exec sessions."""

    _scopes = {"core", "subagent"}
    config_key = "exec"

    @classmethod
    def config_cls(cls):
        from mona.agent.tools.shell import ExecToolConfig

        return ExecToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.exec.enable

    def __init__(
        self,
        *,
        manager: ExecSessionManager | None = None,
    ) -> None:
        self._manager = manager or DEFAULT_EXEC_SESSION_MANAGER

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def name(self) -> str:
        return "list_exec_sessions"

    @property
    def description(self) -> str:
        return (
            "List active long-running exec sessions, including session_id, cwd, "
            "elapsed time, idle time, remaining timeout, and command preview. "
            "Use this to recover a session_id after context shifts before "
            "polling, writing stdin, or terminating with write_stdin."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        try:
            sessions = await self._manager.list()
            if not sessions:
                return "No active exec sessions."
            lines = []
            for info in sessions:
                command = " ".join(info.command.split())
                if len(command) > 120:
                    command = command[:119] + "..."
                status = "exited" if info.returncode is not None else "running"
                lines.append(
                    f"{info.session_id} | {status} | elapsed={info.elapsed_s:.1f}s "
                    f"| idle={info.idle_s:.1f}s | remaining={info.remaining_s:.1f}s "
                    f"| cwd={info.cwd} | {command}"
                )
            return "\n".join(lines)
        except Exception as exc:
            return f"Error listing exec sessions: {exc}"
