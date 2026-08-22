from __future__ import annotations

import base64
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
from mona.agent.tools.tauri_ipc import tauri_invoke as _shared_tauri_invoke
from mona.config.schema import TerminalToolConfig


def _tauri_invoke(cmd: str, args: dict[str, Any] | None = None) -> Any:
    """Wrapper around the shared IPC helper that returns error strings
    instead of raising, matching the original terminal.py contract.
    """
    try:
        return _shared_tauri_invoke(cmd, args)
    except RuntimeError as e:
        logger.warning("IPC bridge error for cmd={!r}: {}", cmd, e)
        return f"Error: {e}"
    except Exception as e:
        logger.warning("IPC bridge invoke failed for cmd={!r}: {}", cmd, e)
        return f"Error: Tauri invoke failed: {e}"


_DEFAULT_TERMINAL_CONFIG = TerminalToolConfig()

_NO_TASK_ERROR = (
    "Error: terminal_exec requires task_id and step_id from an active "
    "maintenance task. Call terminal_task(action='start', goal=..., steps=[...]) "
    "first, then pass the returned ids here. Each step executes exactly one command."
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


def _session_type(session_id: str) -> str | None:
    """Best-effort lookup of a session's type ('ssh', 'local', ...)."""
    result = _tauri_invoke("terminal_list_sessions")
    if isinstance(result, list):
        for s in result:
            if isinstance(s, dict) and s.get("id") == session_id:
                return s.get("sessionType") or s.get("session_type")
    return None


def _resolve_terminal_session(preferred_id: str | None) -> str | None:
    """Resolve an effective terminal session ID without relying on the frontend.

    If ``preferred_id`` is given and the session still exists, use it.
    Otherwise fall back to the first connected SSH or Local session found.
    This decouples the backend from the frontend's terminalSessionId
    propagation, which is fragile and breaks easily when other modules change.
    """
    result = _tauri_invoke("terminal_list_sessions")
    if not isinstance(result, list):
        return None
    sessions = [s for s in result if isinstance(s, dict)]
    # Prefer the requested session if it's still alive.
    if preferred_id:
        for s in sessions:
            if s.get("id") == preferred_id:
                return preferred_id
    # Fall back to the first connected terminal session.
    for s in sessions:
        stype = (s.get("sessionType") or s.get("session_type") or "").lower()
        status = (s.get("status") or "").lower()
        if stype in ("ssh", "local", "desktop") and "connected" in status:
            return s.get("id")
    # Last resort: any terminal session regardless of status.
    for s in sessions:
        stype = (s.get("sessionType") or s.get("session_type") or "").lower()
        if stype in ("ssh", "local", "desktop"):
            return s.get("id")
    return None


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"[truncated, showing last {limit} chars]\n" + text[-limit:]


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
    if exit_code != 0 or result.get("timedOut") or result.get("cancelled"):
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
    _request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        # Tools stay visible to the model regardless of session state — the
        # execute() path returns a clear "open the terminal panel" error when
        # no session is active. Hiding tools via is_available couples backend
        # visibility to frontend store state and breaks easily when other
        # modules change.
        self._request_ctx = ctx

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
            return self._start(goal, steps, session_id)
        if action == "finish":
            return self._finish(task_id, diagnosis, summary)
        if action == "fail":
            return self._fail(task_id, error)
        return f"Error: unknown action {action!r}; use start, finish or fail"

    def _start(self, goal: str | None, steps: Any, session_id: str | None) -> str:
        if not goal or not goal.strip():
            return "Error: goal is required for start"
        parsed = _parse_steps(steps)
        if isinstance(parsed, str):
            return parsed
        preferred = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
        effective_session = _resolve_terminal_session(preferred)
        if not effective_session:
            return (
                "tool_unavailable: terminal_task requires an active terminal "
                "session, but the user is not currently viewing a terminal. "
                "Ask the user to open the terminal panel and try again."
            )
        exec_mode = (
            self._request_ctx.terminal_exec_mode
            if self._request_ctx and self._request_ctx.terminal_exec_mode
            else _DEFAULT_TERMINAL_CONFIG.exec_mode.value
        )
        result = _tauri_invoke(
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
        lines = [f"Maintenance task started. task_id: {task_id}", "steps:"]
        for i, sid in enumerate(step_ids):
            title = parsed[i]["title"] if i < len(parsed) else "?"
            lines.append(f"  {sid}  [{parsed[i]['kind']}] {title}" if i < len(parsed) else f"  {sid}")
        lines.append(
            "Now execute the first step with terminal_exec(task_id=..., step_id=..., command=...)."
        )
        return "\n".join(lines)

    def _finish(self, task_id: str | None, diagnosis: str | None, summary: str | None) -> str:
        if not task_id:
            return "Error: task_id is required for finish"
        result = _tauri_invoke(
            "terminal_maintenance_finish",
            {
                "taskId": task_id,
                "diagnosis": diagnosis or "",
                "summary": summary or "",
            },
        )
        if isinstance(result, str) and result.startswith("Error:"):
            return result
        return (
            "Maintenance task finished successfully. Give the user your final summary. "
            "Do not run further steps for this task."
        )

    def _fail(self, task_id: str | None, error: str | None) -> str:
        if not task_id:
            return "Error: task_id is required for fail"
        result = _tauri_invoke(
            "terminal_maintenance_fail",
            {"taskId": task_id, "error": error or "AI 放弃继续处理"},
        )
        if isinstance(result, str) and result.startswith("Error:"):
            return result
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
                "Max seconds to wait for the command. Default 120, max 1800. "
                "A timed-out command counts as a failed step."
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
    _request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        # Tools stay visible to the model — execute() returns a clear error
        # when no terminal session is active. See TerminalTaskTool.set_context
        # for rationale.
        self._request_ctx = ctx

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
            "for local commands."
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
        preferred = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
        effective_session = _resolve_terminal_session(preferred)
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
            if (_session_type(effective_session) or "").lower() == "local":
                result = _tauri_invoke(
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
        if isinstance(timeout_secs, int) and timeout_secs > 0:
            args["timeoutSecs"] = timeout_secs
        result = _tauri_invoke("terminal_maintenance_execute_step", args)

        if isinstance(result, str) and result.startswith("Error:"):
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
    _request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

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
        preferred = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
        effective_session = _resolve_terminal_session(preferred)
        if effective_session:
            result = _tauri_invoke(
                "terminal_get_output", {"sessionId": effective_session}
            )
        else:
            result = _tauri_invoke("terminal_list_sessions")

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
    _request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

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

        preferred = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
        effective_session = _resolve_terminal_session(preferred)
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

        result = _tauri_invoke(
            "terminal_maintenance_execute_upload",
            {
                "taskId": task_id,
                "stepId": step_id,
                "remotePath": remote_path,
                "content": content_b64,
                "source": "ai",
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
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
        result = _tauri_invoke(
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
