from __future__ import annotations

import base64
import re
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import RequestContext
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
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


def _pattern_matches(pattern: str, command_lower: str) -> bool:
    pat_lower = pattern.lower()
    if "-" not in pat_lower:
        return pat_lower in command_lower
    parts = pat_lower.split("-")
    escaped = [re.escape(p) for p in parts]
    regex = r"\W+".join(escaped)
    return bool(re.search(regex, command_lower))


def _classify_risk(
    command: str,
    *,
    exec_mode: str,
    dangerous_patterns: list[str] | None = None,
    safe_patterns: list[str] | None = None,
) -> str:
    cmd_lower = command.lower()
    d_patterns = dangerous_patterns if dangerous_patterns is not None else _DEFAULT_TERMINAL_CONFIG.dangerous_patterns
    for pat in d_patterns:
        if _pattern_matches(pat, cmd_lower):
            return "approval"
    if exec_mode == "approval":
        return "approval"
    return "direct"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID. If omitted, uses the current active terminal session.",
            nullable=True,
        ),
        command=StringSchema("Shell command to execute in the terminal session"),
        source=StringSchema(
            "Source label for the approval dialog (e.g. 'AI Agent')",
            nullable=True,
        ),
        require_approval=StringSchema(
            "Whether to require user approval before executing (true/false)",
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
        self._request_ctx = ctx
        # Hide this tool from the model when no terminal session is active so
        # the model does not attempt to call it and then misread the resulting
        # error string as "tool does not exist". The AgentLoop refreshes the
        # registry cache after set_context returns.
        self.is_available = bool(ctx.terminal_session_id)

    @property
    def name(self) -> str:
        return "terminal_exec"

    @property
    def description(self) -> str:
        return (
            "Execute a shell command in the user's current terminal session (SSH or local shell). "
            "The session_id is automatically set to the active terminal the user is viewing — "
            "you do NOT need to discover or specify it. Just provide the command. "
            "Commands are risk-classified: dangerous commands (rm -rf, mkfs, dd, etc.) "
            "always require user approval; safe commands (ls, cat, df, etc.) may execute "
            "directly depending on config; unknown commands default to requiring approval. "
            "After execution, call terminal_output to read the result."
        )

    @property
    def read_only(self) -> bool:
        return False

    @staticmethod
    def _load_config() -> TerminalToolConfig:
        try:
            import mona.config as _cfg

            cfg = _cfg.load_config()
            return cfg.tools.terminal
        except Exception:
            return TerminalToolConfig()

    async def execute(
        self,
        command: str,
        session_id: str | None = None,
        source: str | None = None,
        require_approval: str | None = None,
        **kwargs: Any,
    ) -> str:
        effective_session = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
        if not effective_session:
            return (
                "tool_unavailable: terminal_exec requires an active terminal "
                "session, but the user is not currently viewing a terminal. "
                "This is a transient state — the tool exists but cannot run. "
                "Ask the user to open the terminal panel, or if you only need "
                "to run a shell command in the workspace, use the `exec` tool "
                "instead. Do NOT claim you do not have terminal tools."
            )

        explicit_approval = (
            require_approval is not None
            and require_approval.lower() in ("true", "1", "yes")
        )

        if explicit_approval:
            need_approval = True
        else:
            tcfg = self._load_config()
            effective_exec_mode = (
                self._request_ctx.terminal_exec_mode
                if self._request_ctx and self._request_ctx.terminal_exec_mode
                else tcfg.exec_mode.value
            )
            risk = _classify_risk(
                command,
                exec_mode=effective_exec_mode,
                dangerous_patterns=tcfg.dangerous_patterns,
                safe_patterns=tcfg.safe_patterns,
            )
            need_approval = risk == "approval"
            logger.debug(
                "terminal risk classification: command={!r} risk={} exec_mode={}",
                command,
                risk,
                effective_exec_mode,
            )

        if need_approval:
            result = _tauri_invoke(
                "terminal_request_exec",
                {
                    "sessionId": effective_session,
                    "command": command,
                    "source": source or "AI Agent",
                },
            )
        else:
            result = _tauri_invoke(
                "terminal_exec_command",
                {"sessionId": effective_session, "command": command},
            )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if need_approval:
            return f"Command submitted for approval: {command}"
        return f"Command executed: {command}"


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
        self.is_available = bool(ctx.terminal_session_id)

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
        effective_session = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
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
        required=["remote_path", "content"],
    )
)
class TerminalUploadTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_upload"
    _request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx
        self.is_available = bool(ctx.terminal_session_id)

    @property
    def name(self) -> str:
        return "terminal_upload"

    @property
    def description(self) -> str:
        return (
            "Upload a file to the remote server via the current SSH session's SFTP channel. "
            "The session_id is automatically set to the active terminal the user is viewing — "
            "you do NOT need to discover or specify it. "
            "Use encoding='text' (default) for text files, encoding='base64' for binary data. "
            "This reuses the existing SSH connection, no additional authentication needed."
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
        **kwargs: Any,
    ) -> str:
        effective_session = session_id or (
            self._request_ctx.terminal_session_id if self._request_ctx else None
        )
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
            "terminal_upload_file",
            {
                "sessionId": effective_session,
                "remotePath": remote_path,
                "content": content_b64,
            },
        )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if isinstance(result, dict):
            status = result.get("status", "unknown")
            bytes_uploaded = result.get("bytes", "?")
            path = result.get("remotePath", remote_path)
            return f"File uploaded: {path} ({bytes_uploaded} bytes, {status})"

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
