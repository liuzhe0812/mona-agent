from __future__ import annotations

import asyncio
import base64
from contextvars import ContextVar
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import RequestContext
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import IpcTimeoutError
from mona.agent.tools.tauri_ipc import tauri_invoke as _shared_tauri_invoke
from mona.agent.tools.tauri_ipc import tauri_invoke_async as _shared_tauri_invoke_async
from mona.config.schema import TerminalToolConfig


def _tauri_invoke(
    cmd: str,
    args: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
    raise_on_timeout: bool = False,
) -> Any:
    """Wrapper around the shared IPC helper that returns error strings
    instead of raising, matching the original terminal.py contract.

    ``raise_on_timeout`` opts into ``IpcTimeoutError`` propagation instead.
    Callers handling long-running work need it: "no answer observed" is not the
    same as "the command failed", and only they can say what to do next.
    """
    try:
        return _shared_tauri_invoke(cmd, args, timeout=timeout)
    except IpcTimeoutError as e:
        if raise_on_timeout:
            raise
        logger.warning("IPC bridge invoke failed for cmd={!r}: {}", cmd, e)
        return f"Error: {e}"
    except RuntimeError as e:
        logger.warning("IPC bridge error for cmd={!r}: {}", cmd, e)
        return f"Error: {e}"
    except Exception as e:
        logger.warning("IPC bridge invoke failed for cmd={!r}: {}", cmd, e)
        return f"Error: Tauri invoke failed: {e}"


async def _tauri_invoke_async(
    cmd: str,
    args: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
    raise_on_timeout: bool = False,
) -> Any:
    """Async counterpart that preserves the terminal wrapper's error contract."""
    try:
        return await _shared_tauri_invoke_async(cmd, args, timeout=timeout)
    except IpcTimeoutError as e:
        if raise_on_timeout:
            raise
        logger.warning("IPC bridge invoke failed for cmd={!r}: {}", cmd, e)
        return f"Error: {e}"
    except RuntimeError as e:
        logger.warning("IPC bridge error for cmd={!r}: {}", cmd, e)
        return f"Error: {e}"
    except Exception as e:
        logger.warning("IPC bridge invoke failed for cmd={!r}: {}", cmd, e)
        return f"Error: Tauri invoke failed: {e}"


_DEFAULT_TERMINAL_CONFIG = TerminalToolConfig()
_TERMINAL_OWNER_SESSION_KEY: ContextVar[str | None] = ContextVar(
    "mona_terminal_owner_session_key",
    default=None,
)
_TERMINAL_REQUEST_CONTEXT: ContextVar[RequestContext | None] = ContextVar(
    "mona_terminal_request_context",
    default=None,
)
_TERMINAL_SESSION_STATE: ContextVar[dict[str, str | None] | None] = ContextVar(
    "mona_terminal_session_state",
    default=None,
)
_TERMINAL_TASKS_BY_SESSION: dict[str, set[str]] = {}


def _terminal_request_context() -> RequestContext | None:
    return _TERMINAL_REQUEST_CONTEXT.get()


def _bind_terminal_context(ctx: RequestContext) -> None:
    if _TERMINAL_REQUEST_CONTEXT.get() is ctx:
        return
    _TERMINAL_REQUEST_CONTEXT.set(ctx)
    _TERMINAL_SESSION_STATE.set({"session_id": ctx.terminal_session_id})


def _terminal_session_id() -> str | None:
    state = _TERMINAL_SESSION_STATE.get()
    if state is not None:
        return state.get("session_id")
    ctx = _terminal_request_context()
    return ctx.terminal_session_id if ctx else None


def _remember_terminal_session(session_id: str) -> None:
    state = _TERMINAL_SESSION_STATE.get()
    if state is None:
        state = {"session_id": session_id}
        _TERMINAL_SESSION_STATE.set(state)
    else:
        state["session_id"] = session_id


def _track_terminal_task(task_id: str) -> None:
    session_key = _TERMINAL_OWNER_SESSION_KEY.get()
    if session_key:
        _TERMINAL_TASKS_BY_SESSION.setdefault(session_key, set()).add(task_id)


def _untrack_terminal_task(task_id: str) -> None:
    for session_key, task_ids in list(_TERMINAL_TASKS_BY_SESSION.items()):
        task_ids.discard(task_id)
        if not task_ids:
            _TERMINAL_TASKS_BY_SESSION.pop(session_key, None)


async def cancel_terminal_tasks_by_session(session_key: str) -> int:
    task_ids = list(_TERMINAL_TASKS_BY_SESSION.pop(session_key, set()))
    if task_ids:
        await asyncio.gather(
            *(
                _tauri_invoke_async("terminal_maintenance_cancel", {"taskId": task_id})
                for task_id in task_ids
            )
        )
    return len(task_ids)

_NO_TASK_ERROR = (
    "Error: terminal_exec requires task_id and step_id from an active "
    "maintenance task. Call terminal_task(action='start', goal=..., steps=[...]) "
    "first, then pass the returned ids here. Each step executes exactly one command."
)

# The Rust step runner defaults to 600s and caps at 1800s. The transport must
# outlive the command it is waiting for, so the bridge timeout is derived from
# the step timeout plus headroom for the app to finalise and reply.
#
# 600s is the default because the primary use of this flow is package installs
# and builds, which routinely take several minutes. Timeout is not a neutral
# event here: the wait is abandoned but the remote command keeps running, so an
# undersized default leaves orphaned work on the server instead of failing
# cleanly.
_STEP_DEFAULT_TIMEOUT_SECS = 600
_STEP_MAX_TIMEOUT_SECS = 1800
_BRIDGE_HEADROOM_SECS = 30

# An upload moves the whole file body through the bridge in one request, so it
# gets its own bound rather than the short default meant for ordinary commands.
_UPLOAD_BRIDGE_TIMEOUT_SECS = 300

# A bridge timeout is NOT a command failure: the request reached the app and the
# remote command was most likely started, we just stopped waiting for its answer.
# Retrying the same step is rejected by the step state machine, and starting a
# fresh task would abandon the plan, so point the model at observation instead.
_STEP_BRIDGE_TIMEOUT = (
    "Error: Mona 等待命令返回超时（{seconds}s），这不代表命令失败。\n"
    "命令很可能已在远端开始执行，只是本地停止等待，步骤结果未知。\n"
    "请勿重复执行同一 step（状态机会拒绝），也不要为此新建任务。\n"
    "下一步应先观察现状再决定：用 terminal_output 读取终端输出，"
    "或用一个只读步骤确认当前系统状态（进程是否仍在、目标是否已达成）。\n"
    "若该命令本身耗时较长，下一次执行时通过 timeout_secs 提高上限（最大 {max_seconds}s），"
    "或改为后台执行并轮询。"
)

# sshd refusing a new session channel means the remote host could not fork one
# (resource exhaustion, too many processes/sessions) while the TCP connection is
# still alive. Retrying immediately repeats the same rejection, so converge.
_STEP_CHANNEL_REFUSED = (
    "Error: 远端主机拒绝为本次命令打开新的 SSH 会话通道（{detail}）。\n"
    "TCP 连接仍在，是服务器的 sshd 无法再分配会话（通常因为远端进程或会话过多）。\n"
    "继续重试同一个命令只会得到同样的拒绝。请停止重试，并把情况告知用户："
    "需要在终端面板对当前 SSH 会话点击「重新连接」，或先在远端释放资源。"
)

_STEP_KINDS = ("inspect", "change", "verify")


def _parse_steps(raw: Any) -> list[dict[str, str]] | str:
    """Validate the steps array; returns the parsed list or an error string."""
    # Tolerate JSON-string encoded arrays from providers that don't decode
    # nested arrays (cast_params normally handles this, but be defensive).
    if isinstance(raw, str) and raw.strip().startswith("["):
        try:
            import json

            raw = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            pass
    if not isinstance(raw, list) or not raw:
        return "Error: steps must be a non-empty array of {title, kind} objects"
    out: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            return f"Error: steps[{i}] must be an object with title and kind"
        title = str(item.get("title") or "").strip()
        kind = str(item.get("kind") or "inspect").strip()
        if not title:
            return f"Error: steps[{i}].title is required"
        if kind not in _STEP_KINDS:
            return f"Error: steps[{i}].kind must be one of {', '.join(_STEP_KINDS)}"
        out.append({"title": title, "kind": kind})
    return out


async def _session_type_async(session_id: str) -> str | None:
    """Async version of _session_type for tool execution paths."""
    result = await _tauri_invoke_async("terminal_list_sessions")
    if isinstance(result, list):
        for s in result:
            if isinstance(s, dict) and s.get("id") == session_id:
                return s.get("sessionType") or s.get("session_type")
    return None


async def _resolve_terminal_session_async(preferred_id: str | None) -> str | None:
    """Async version of _resolve_terminal_session for tool execution paths."""
    result = await _tauri_invoke_async("terminal_list_sessions")
    if not isinstance(result, list):
        return None
    sessions = [s for s in result if isinstance(s, dict)]
    if preferred_id:
        for s in sessions:
            if s.get("id") == preferred_id:
                return preferred_id
    for s in sessions:
        stype = (s.get("sessionType") or s.get("session_type") or "").lower()
        status = (s.get("status") or "").lower()
        if stype in ("ssh", "local", "desktop") and "connected" in status:
            return s.get("id")
    for s in sessions:
        stype = (s.get("sessionType") or s.get("session_type") or "").lower()
        if stype in ("ssh", "local", "desktop"):
            return s.get("id")
    return None


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"[truncated, showing last {limit} chars]\n" + text[-limit:]


# russh reports a server-side CHANNEL_OPEN_FAILURE as "Failed to open channel
# (ConnectFailed)". The TCP connection is alive here — the remote sshd answered
# and refused to allocate a session channel — so this is a distinct condition
# from a dropped connection and must not be retried like a transient error.
_CHANNEL_REFUSED_MARKERS = (
    "Failed to open channel",
    "ConnectFailed",
    "ResourceShortage",
    "AdministrativelyProhibited",
)


def _is_channel_refused(message: str) -> bool:
    return any(marker in message for marker in _CHANNEL_REFUSED_MARKERS)


# Deterministic contract rejections from the step/task state machine. Retrying
# these can never succeed — the plan is immutable and a step runs at most once —
# so returning the raw backend error left the model looping on the same call
# until the tool circuit-breaker disabled it. Each one is translated into the
# single valid next action instead.
def _translate_step_contract_error(message: str) -> str | None:
    text = message.removeprefix("Error: ").strip()
    if "不能重复执行" in text or "已开始或已结束" in text:
        return (
            "Error: 这个 step 已经执行过，其结果已经记录在任务里，不能再次执行。\n"
            "不要重复调用同一个 step_id（状态机会一直拒绝）。\n"
            "下一步：查看该步骤已记录的 exit_code/stdout（或用 terminal_output 读取终端输出）确认它的实际结果，"
            "然后执行计划里的下一个 step_id。若计划因此无法继续，调用 terminal_task(action='fail') 说明原因。"
        )
    if text.startswith("Step ") and "not found in task" in text:
        return (
            "Error: 该 step_id 不属于当前任务（可能来自旧任务或已被清除）。\n"
            "下一步：确认你使用的是 terminal_task(action='start') 返回的 task_id 与 step_id 配对；"
            "如果原计划已失效，用 terminal_task(action='start') 重新给出完整计划。"
        )
    if "维护任务已结束" in text:
        return (
            "Error: 该维护任务已经结束，不能继续执行步骤。\n"
            "下一步：用 terminal_task(action='finish'/'fail') 收尾这个任务；"
            "如果还需要继续操作，请用 terminal_task(action='start') 建立新的完整计划。"
        )
    return None


def _format_step_result(result: dict[str, Any]) -> str:
    exit_code = result.get("exitCode")
    duration = result.get("durationMs", "?")
    bits = [f"exit_code: {exit_code if exit_code is not None else 'null'}", f"duration: {duration} ms"]
    if result.get("timedOut"):
        bits.append("TIMED OUT")
    if result.get("cancelled"):
        bits.append("CANCELLED")
    lines = [" | ".join(bits)]
    stdout = str(result.get("stdout") or "").rstrip()
    stderr = str(result.get("stderr") or "").rstrip()
    if stdout:
        lines.append("--- stdout ---")
        lines.append(_tail(stdout, 6000))
    if stderr:
        lines.append("--- stderr ---")
        lines.append(_tail(stderr, 4000))
    if result.get("cancelled"):
        # CANCELLED means the wait was abandoned, not that the remote command is
        # confirmed stopped, and no exit status was observed either way.
        lines.append(
            "CANCELLED: the wait was abandoned, so the result of this command is "
            "UNKNOWN — no exit_code was observed. This does NOT confirm the "
            "command stopped; it may still be running on the server. Do not "
            "report to the user that the process was terminated. Stop here and "
            "ask the user whether to wait, check, or stop it, instead of "
            "continuing the plan."
        )
        return "\n".join(lines)

    if result.get("timedOut"):
        # Mona stopped waiting; the remote command was NOT killed. Verified on a
        # real OpenSSH host that a signal request is never delivered and that
        # dropping the channel does not make sshd reap the command, so the honest
        # report is "still possibly running", not "terminated".
        #
        # The plan must not continue past this either: the next step may act on a
        # half-applied change.
        lines.append(
            "TIMED OUT: Mona stopped waiting after the step timeout, but the "
            "command was NOT stopped — it may still be running on the server. "
            "Do not start the same work again in another step, because you may "
            "end up with two instances running at once. Stop here and ask the "
            "user whether to wait for it, inspect it, or stop it explicitly; do "
            "not continue with the remaining steps on your own. For package "
            "operations, also beware of a stale lock if it was interrupted."
        )
        return "\n".join(lines)

    if exit_code != 0:
        lines.append(
            "Step FAILED — only exit_code 0 counts as success. Diagnose the output "
            "above and continue with the remaining planned steps; if the plan cannot "
            "continue, call terminal_task(action='fail') and start a revised task. "
            "Do NOT claim the step succeeded."
        )
    return "\n".join(lines)


_STEP_ITEM_SCHEMA = ObjectSchema(
    properties={
        "title": StringSchema("Short human-readable step description"),
        "kind": StringSchema(
            "Step type: inspect (read-only diagnosis), change (modifies the system), "
            "verify (independent re-check after changes)",
            enum=list(_STEP_KINDS),
        ),
    },
    required=["title", "kind"],
)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Task action",
            enum=["start", "finish", "fail"],
        ),
        goal=StringSchema(
            "The user's maintenance goal, in their own words (required for start)",
            nullable=True,
        ),
        steps=ArraySchema(
            _STEP_ITEM_SCHEMA,
            description=(
                "The COMPLETE step plan (required for start). Plan the full sequence "
                "upfront: inspect steps to gather evidence, then change steps, then "
                "verify steps. The plan locks once execution starts and cannot be "
                "extended afterwards."
            ),
            min_items=1,
            nullable=True,
        ),
        task_id=StringSchema(
            "Task ID returned by start (required for finish, fail)",
            nullable=True,
        ),
        diagnosis=StringSchema(
            "AI diagnosis conclusion, saved with the task (for finish)",
            nullable=True,
        ),
        summary=StringSchema(
            "Final human-readable summary of what was done (for finish)",
            nullable=True,
        ),
        error=StringSchema(
            "Why the task cannot continue (for fail)",
            nullable=True,
        ),
        session_id=StringSchema(
            "Terminal session ID. If omitted, uses the current active terminal session.",
            nullable=True,
        ),
        required=["action"],
    )
)
class TerminalTaskTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_task"
    subscription_required = True
    def set_context(self, ctx: RequestContext) -> None:
        # Tools stay visible to the model regardless of session state — the
        # execute() path returns a clear "open the terminal panel" error when
        # no session is active. Hiding tools via is_available couples backend
        # visibility to frontend store state and breaks easily when other
        # modules change.
        _bind_terminal_context(ctx)
        _TERMINAL_OWNER_SESSION_KEY.set(ctx.session_key)

    @property
    def name(self) -> str:
        return "terminal_task"

    @property
    def description(self) -> str:
        return (
            "Manage a terminal maintenance task on the user's current SSH or desktop session. "
            "Workflow: start (user goal + the COMPLETE step plan, inspect → change → "
            "verify) → execute each step with terminal_exec/terminal_upload (exactly "
            "one action per step, in order) → finish (diagnosis + summary) or fail "
            "(reason). The plan is locked once execution starts — it cannot be "
            "extended, so plan carefully; if the plan proves wrong mid-run, fail the "
            "task and start a revised one. start returns task_id and step_ids — you "
            "MUST pass them to terminal_exec/terminal_upload. Steps are executed in "
            "the user's visible terminal and tracked with real exit codes. A task "
            "containing change steps can only finish successfully after a verify step "
            "that ran after the last change has succeeded."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        action: str,
        goal: str | None = None,
        steps: Any = None,
        task_id: str | None = None,
        diagnosis: str | None = None,
        summary: str | None = None,
        error: str | None = None,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        action = (action or "").strip()
        if action == "start":
            return await self._start(goal, steps, session_id)
        if action == "finish":
            return await self._finish(task_id, diagnosis, summary)
        if action == "fail":
            return await self._fail(task_id, error)
        return f"Error: unknown action {action!r}; use start, finish or fail"

    async def _start(self, goal: str | None, steps: Any, session_id: str | None) -> str:
        if not goal or not goal.strip():
            return "Error: goal is required for start"
        parsed = _parse_steps(steps)
        if isinstance(parsed, str):
            return parsed
        request_ctx = _terminal_request_context()
        preferred = session_id or _terminal_session_id()
        effective_session = await _resolve_terminal_session_async(preferred)
        if not effective_session:
            return (
                "tool_unavailable: terminal_task requires an active terminal "
                "session, but the user is not currently viewing a terminal. "
                "Ask the user to open the terminal panel and try again."
            )
        _remember_terminal_session(effective_session)
        exec_mode = (
            request_ctx.terminal_exec_mode
            if request_ctx and request_ctx.terminal_exec_mode
            else _DEFAULT_TERMINAL_CONFIG.exec_mode.value
        )
        result = await _tauri_invoke_async(
            "terminal_maintenance_start",
            {
                "sessionId": effective_session,
                "goal": goal.strip(),
                "execMode": exec_mode,
                "steps": parsed,
                "source": "ai",
            },
        )
        if isinstance(result, str) and result.startswith("Error:"):
            return result
        task_id = result.get("taskId", "?") if isinstance(result, dict) else "?"
        step_ids = result.get("stepIds", []) if isinstance(result, dict) else []
        if isinstance(task_id, str) and task_id != "?":
            _track_terminal_task(task_id)
        lines = [f"Maintenance task started. task_id: {task_id}", "steps:"]
        for i, sid in enumerate(step_ids):
            title = parsed[i]["title"] if i < len(parsed) else "?"
            lines.append(f"  {sid}  [{parsed[i]['kind']}] {title}" if i < len(parsed) else f"  {sid}")
        lines.append(
            "Now execute the first step with terminal_exec(task_id=..., step_id=..., command=...)."
        )
        return "\n".join(lines)

    async def _finish(self, task_id: str | None, diagnosis: str | None, summary: str | None) -> str:
        if not task_id:
            return "Error: task_id is required for finish"
        result = await _tauri_invoke_async(
            "terminal_maintenance_finish",
            {
                "taskId": task_id,
                "diagnosis": diagnosis or "",
                "summary": summary or "",
            },
        )
        if isinstance(result, str) and result.startswith("Error:"):
            return result
        _untrack_terminal_task(task_id)
        return (
            "Maintenance task finished successfully. Give the user your final summary. "
            "Do not run further steps for this task."
        )

    async def _fail(self, task_id: str | None, error: str | None) -> str:
        if not task_id:
            return "Error: task_id is required for fail"
        result = await _tauri_invoke_async(
            "terminal_maintenance_fail",
            {"taskId": task_id, "error": error or "AI 放弃继续处理"},
        )
        if isinstance(result, str) and result.startswith("Error:"):
            return result
        _untrack_terminal_task(task_id)
        return "Maintenance task marked as failed. Explain the situation to the user."


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID. If omitted, uses the current active terminal session.",
            nullable=True,
        ),
        command=StringSchema("Shell command to execute as this step"),
        task_id=StringSchema(
            "Maintenance task ID from terminal_task (required for SSH or desktop sessions)",
            nullable=True,
        ),
        step_id=StringSchema(
            "Step ID within the task — each step executes exactly one command (required for SSH or desktop sessions)",
            nullable=True,
        ),
        timeout_secs=IntegerSchema(
            description=(
                "Max seconds to wait for the command. Default 600, max 1800. "
                "That default already covers ordinary package installs and "
                "builds; raise it only for unusually slow ones. On timeout Mona "
                "stops waiting but does not stop the command, so it may keep "
                "running on the server."
            ),
            minimum=1,
            maximum=1800,
            nullable=True,
        ),
        required=["command"],
    )
)
class TerminalExecTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal"
    subscription_required = True
    def set_context(self, ctx: RequestContext) -> None:
        _bind_terminal_context(ctx)

    def available_in_context(self) -> bool:
        return bool(_terminal_session_id())

    @property
    def name(self) -> str:
        return "terminal_exec"

    @property
    def description(self) -> str:
        return (
            "Execute one shell command as a step of the active maintenance task on the "
            "user's current SSH or desktop terminal session. Requires task_id and step_id from "
            "terminal_task — a step can only be executed once and the task plan cannot "
            "be extended after start, so run the planned steps in order. Returns "
            "structured results: exit_code, stdout, stderr, "
            "duration, timed_out, cancelled. Only exit_code 0 means success — never "
            "claim success otherwise. High-risk commands automatically pause for user "
            "confirmation; forbidden commands are blocked. The command and its output "
            "are shown live in the user's terminal. On Local (non-SSH) terminals it may "
            "run without a task as an untracked passthrough — prefer the `exec` tool "
            "for local commands. "
            "Package installs and builds run synchronously: the default timeout "
            "already covers them, so let one command finish rather than splitting "
            "it up or polling for it. On timeout or cancel Mona stops waiting but "
            "does NOT stop the remote command, so it may still be running — check "
            "before retrying, and never report that it was terminated."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        command: str,
        session_id: str | None = None,
        task_id: str | None = None,
        step_id: str | None = None,
        timeout_secs: int | None = None,
        **kwargs: Any,
    ) -> str:
        preferred = session_id or _terminal_session_id()
        effective_session = await _resolve_terminal_session_async(preferred)
        if not effective_session:
            return (
                "tool_unavailable: terminal_exec requires an active terminal "
                "session, but the user is not currently viewing a terminal. "
                "This is a transient state — the tool exists but cannot run. "
                "Ask the user to open the terminal panel, or if you only need "
                "to run a shell command in the workspace, use the `exec` tool "
                "instead. Do NOT claim you do not have terminal tools."
            )

        if not task_id or not step_id:
            # Local shells have no structured execution yet — keep the previous
            # untracked passthrough so existing local-terminal usage still works.
            if (await _session_type_async(effective_session) or "").lower() == "local":
                result = await _tauri_invoke_async(
                    "terminal_exec_command",
                    {"sessionId": effective_session, "command": command, "source": "ai"},
                )
                if isinstance(result, str) and result.startswith("Error:"):
                    return result
                return (
                    "Command written to the local terminal (untracked — local sessions "
                    "do not support maintenance steps yet). Call terminal_output to "
                    "read the result; do not claim success without seeing it."
                )
            return _NO_TASK_ERROR

        args: dict[str, Any] = {
            "taskId": task_id,
            "stepId": step_id,
            "command": command,
            "source": "ai",
        }
        step_timeout = (
            timeout_secs
            if isinstance(timeout_secs, int) and timeout_secs > 0
            else _STEP_DEFAULT_TIMEOUT_SECS
        )
        step_timeout = min(step_timeout, _STEP_MAX_TIMEOUT_SECS)
        args["timeoutSecs"] = step_timeout
        transport_timeout = step_timeout + _BRIDGE_HEADROOM_SECS

        try:
            result = await _tauri_invoke_async(
                "terminal_maintenance_execute_step",
                args,
                timeout=transport_timeout,
                raise_on_timeout=True,
            )
        except IpcTimeoutError:
            # The backend is still working; the transport stopped waiting.
            logger.warning(
                "IPC bridge timed out after {}s waiting for "
                "cmd='terminal_maintenance_execute_step'; the remote command "
                "may still be running",
                transport_timeout,
            )
            return _STEP_BRIDGE_TIMEOUT.format(
                seconds=int(transport_timeout),
                max_seconds=_STEP_MAX_TIMEOUT_SECS,
            )
        except Exception as e:
            logger.warning(
                "IPC bridge invoke failed for cmd='terminal_maintenance_execute_step': {}",
                e,
            )
            return f"Error: Tauri invoke failed: {e}"

        if isinstance(result, str) and result.startswith("Error:"):
            # The shared wrapper flattens bridge errors into this string, so the
            # refused-channel case has to be recognised here rather than from an
            # exception.
            if _is_channel_refused(result):
                logger.warning(
                    "SSH server refused a session channel for "
                    "cmd='terminal_maintenance_execute_step': {}",
                    result,
                )
                return _STEP_CHANNEL_REFUSED.format(detail=result.removeprefix("Error: "))
            contract_error = _translate_step_contract_error(result)
            if contract_error is not None:
                return contract_error
            return result
        if isinstance(result, dict):
            return _format_step_result(result)
        return str(result)


_DEFAULT_OUTPUT_LINES = 200

@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID to get output from",
            nullable=True,
        ),
        lines=IntegerSchema(
            description=(
                "Number of recent lines to read from the end of the terminal buffer. "
                "Default 200. Increase for log inspection (e.g. 1000), decrease for quick "
                "status checks (e.g. 20). Hard cap 10000."
            ),
            minimum=1,
            maximum=10000,
            nullable=True,
        ),
        required=[],
    )
)
class TerminalOutputTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_output"
    subscription_required = True
    def set_context(self, ctx: RequestContext) -> None:
        _bind_terminal_context(ctx)

    def available_in_context(self) -> bool:
        return bool(_terminal_session_id())

    @property
    def name(self) -> str:
        return "terminal_output"

    @property
    def description(self) -> str:
        return (
            "Get the terminal output buffer, returning the last N lines (default 200). "
            "If session_id is not provided, uses the user's current active terminal session. "
            "Pass `lines` to control how much to read — smaller values save tokens, "
            "larger values (e.g. 1000) are useful for inspecting logs. "
            "When output is truncated, a `[showing last N of M lines]` header is prepended."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        session_id: str | None = None,
        lines: int | None = None,
        **kwargs: Any,
    ) -> str:
        preferred = session_id or _terminal_session_id()
        effective_session = await _resolve_terminal_session_async(preferred)
        if effective_session:
            result = await _tauri_invoke_async(
                "terminal_get_output", {"sessionId": effective_session}
            )
        else:
            result = await _tauri_invoke_async("terminal_list_sessions")

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if isinstance(result, list):
            if session_id:
                output = str(result)
                return output[-4000:] if len(output) > 4000 else output
            session_lines = []
            for s in result:
                session_lines.append(
                    f"  {s.get('id', '?')[:8]}... | {s.get('sessionType', '?')} | {s.get('status', '?')}"
                )
            return "Active sessions:\n" + "\n".join(session_lines)

        buffer_str = str(result)
        n = lines if isinstance(lines, int) and lines > 0 else _DEFAULT_OUTPUT_LINES
        n = min(n, 10000)
        all_lines = buffer_str.split("\n")
        if len(all_lines) <= n:
            return buffer_str
        tail = "\n".join(all_lines[-n:])
        return f"[showing last {n} of {len(all_lines)} lines]\n{tail}"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID. If omitted, uses the current active terminal session.",
            nullable=True,
        ),
        remote_path=StringSchema("Remote file path on the server to upload to"),
        content=StringSchema("File content to upload (plain text or binary as base64)"),
        encoding=StringSchema(
            "Content encoding: 'text' for plain text (default), 'base64' for binary data",
            nullable=True,
        ),
        task_id=StringSchema(
            "Maintenance task ID from terminal_task (required)",
            nullable=True,
        ),
        step_id=StringSchema(
            "Step ID within the task — uploads count as change steps (required)",
            nullable=True,
        ),
        required=["remote_path", "content"],
    )
)
class TerminalUploadTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_upload"
    subscription_required = True
    def set_context(self, ctx: RequestContext) -> None:
        _bind_terminal_context(ctx)

    def available_in_context(self) -> bool:
        return bool(_terminal_session_id())

    @property
    def name(self) -> str:
        return "terminal_upload"

    @property
    def description(self) -> str:
        return (
            "Upload a file to the remote server as a change step of the active maintenance "
            "task (SSH or desktop sessions). Requires task_id and step_id from terminal_task. "
            "Use encoding='text' (default) for text files, encoding='base64' for binary data. "
            "Reuses the existing SSH connection, no additional authentication needed. "
            "After an upload you must add and run a verify step confirming the file works "
            "as intended."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        remote_path: str,
        content: str,
        session_id: str | None = None,
        encoding: str | None = None,
        task_id: str | None = None,
        step_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not task_id or not step_id:
            return (
                "Error: terminal_upload requires task_id and step_id from an active "
                "maintenance task. Call terminal_task(action='start', ...) with a "
                "complete plan first and pass the returned ids here."
            )

        preferred = session_id or _terminal_session_id()
        effective_session = await _resolve_terminal_session_async(preferred)
        if not effective_session:
            return (
                "tool_unavailable: terminal_upload requires an active terminal "
                "session, but the user is not currently viewing a terminal. "
                "This is a transient state — the tool exists but cannot run. "
                "Ask the user to open the terminal panel and try again. "
                "Do NOT claim you do not have terminal tools."
            )

        enc = (encoding or "text").lower()
        if enc == "base64":
            content_b64 = content
        else:
            content_b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")

        # Uploads carry the file body over the bridge, so the transport must be
        # allowed more than the short default used for ordinary commands.
        upload_timeout = _UPLOAD_BRIDGE_TIMEOUT_SECS
        try:
            result = await _tauri_invoke_async(
                "terminal_maintenance_execute_upload",
                {
                    "taskId": task_id,
                    "stepId": step_id,
                    "remotePath": remote_path,
                    "content": content_b64,
                    "source": "ai",
                },
                timeout=upload_timeout,
                raise_on_timeout=True,
            )
        except IpcTimeoutError:
            logger.warning(
                "IPC bridge timed out after {}s waiting for "
                "cmd='terminal_maintenance_execute_upload' (path={})",
                upload_timeout,
                remote_path,
            )
            return (
                f"Error: Mona 等待上传返回超时（{int(upload_timeout)}s），这不代表上传失败。\n"
                "远端文件可能已经写入。请勿重复执行同一 step（状态机会拒绝）。\n"
                "下一步先用 terminal_output 或只读步骤确认远端文件是否存在及其内容，再决定后续动作。"
            )
        except Exception as e:
            logger.warning(
                "IPC bridge invoke failed for cmd='terminal_maintenance_execute_upload': {}",
                e,
            )
            return f"Error: Tauri invoke failed: {e}"

        if isinstance(result, str) and result.startswith("Error:"):
            contract_error = _translate_step_contract_error(result)
            if contract_error is not None:
                return contract_error
            return result

        if isinstance(result, dict):
            bytes_uploaded = result.get("bytes", "?")
            path = result.get("remotePath", remote_path)
            return (
                f"Upload step succeeded: {path} ({bytes_uploaded} bytes). "
                "Remember to run a verify step before finishing the task."
            )

        return str(result)


class GenerateReportTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "generate_report"

    @property
    def name(self) -> str:
        return "generate_report"

    @property
    def description(self) -> str:
        return (
            "Generate an HTML report and save it as a local file that the user can open in their browser. "
            "Use this tool when the user requests an HTML report — do NOT output the HTML content in your chat response. "
            "The report will be saved to a temporary directory and the user will see a button to open it. "
            "Parameters: title (report title, used for filename), content (complete HTML string following the Mona report design spec)."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        title: str,
        content: str,
        **kwargs: Any,
    ) -> str:
        result = await _tauri_invoke_async(
            "report_save_temp",
            {"title": title, "content": content},
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if isinstance(result, dict):
            status = result.get("status", "unknown")
            path = result.get("path", "")
            file_name = result.get("fileName", "")
            if status == "saved" and path:
                return (
                    f"Report saved successfully: {file_name}\n"
                    f"Path: {path}\n"
                    f"Tell the user the report has been generated and they can click the button to view it."
                )
            return f"Report save result: {result}"

        return str(result)
