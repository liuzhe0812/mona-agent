from __future__ import annotations

import json
import re
import urllib.request
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import StringSchema, tool_parameters_schema
from mona.config.schema import TerminalToolConfig

_GATEWAY_BASE = "http://127.0.0.1"


def _gateway_port() -> int:
    try:
        import mona.config as _cfg

        cfg = _cfg.load_config()
        return getattr(cfg, "gateway_port", 7860)
    except Exception:
        return 7860


def _tauri_invoke(cmd: str, args: dict[str, Any] | None = None) -> Any:
    port = _gateway_port()
    url = f"{_GATEWAY_BASE}:{port}/api/tauri/invoke"
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            if isinstance(result, dict) and "error" in result:
                return f"Error: {result['error']}"
            return result
    except Exception as e:
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
    s_patterns = safe_patterns if safe_patterns is not None else _DEFAULT_TERMINAL_CONFIG.safe_patterns
    for pat in d_patterns:
        if _pattern_matches(pat, cmd_lower):
            return "approval"
    if exec_mode == "approval":
        return "approval"
    for pat in s_patterns:
        if _pattern_matches(pat, cmd_lower):
            return "direct"
    return "approval"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema("Terminal session ID to execute the command in"),
        command=StringSchema("Shell command to execute in the terminal session"),
        source=StringSchema(
            "Source label for the approval dialog (e.g. 'AI Agent')",
            nullable=True,
        ),
        require_approval=StringSchema(
            "Whether to require user approval before executing (true/false)",
            nullable=True,
        ),
        required=["session_id", "command"],
    )
)
class TerminalExecTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal"

    @property
    def name(self) -> str:
        return "terminal_exec"

    @property
    def description(self) -> str:
        return (
            "Execute a shell command in an existing terminal session (SSH or local). "
            "This is the primary way to run commands on remote servers — it reuses "
            "the user's active SSH sessions. First call terminal_output without "
            "session_id to list available sessions, then pass the session_id and "
            "command. Commands are risk-classified: dangerous commands (rm -rf, "
            "mkfs, dd, etc.) always require user approval; safe commands (ls, cat, "
            "df, etc.) may execute directly depending on config; unknown commands "
            "default to requiring approval. After execution, call terminal_output "
            "with the session_id to read the result."
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
        session_id: str,
        command: str,
        source: str | None = None,
        require_approval: str | None = None,
        **kwargs: Any,
    ) -> str:
        explicit_approval = (
            require_approval is not None
            and require_approval.lower() in ("true", "1", "yes")
        )

        if explicit_approval:
            need_approval = True
        else:
            tcfg = self._load_config()
            risk = _classify_risk(
                command,
                exec_mode=tcfg.exec_mode.value,
                dangerous_patterns=tcfg.dangerous_patterns,
                safe_patterns=tcfg.safe_patterns,
            )
            need_approval = risk == "approval"
            logger.debug(
                "terminal risk classification: command={!r} risk={} exec_mode={}",
                command,
                risk,
                tcfg.exec_mode.value,
            )

        if need_approval:
            result = _tauri_invoke(
                "terminal_request_exec",
                {
                    "sessionId": session_id,
                    "command": command,
                    "source": source or "AI Agent",
                },
            )
        else:
            result = _tauri_invoke(
                "terminal_exec_command",
                {"sessionId": session_id, "command": command},
            )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if need_approval:
            return f"Command submitted for approval: {command}"
        return f"Command executed: {command}"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID to get output from",
            nullable=True,
        ),
        required=[],
    )
)
class TerminalOutputTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_output"

    @property
    def name(self) -> str:
        return "terminal_output"

    @property
    def description(self) -> str:
        return (
            "Get the current terminal output buffer for a session. "
            "If session_id is not provided, lists all active sessions instead."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if session_id:
            result = _tauri_invoke(
                "terminal_get_output", {"sessionId": session_id}
            )
        else:
            result = _tauri_invoke("terminal_list_sessions")

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if isinstance(result, list):
            if session_id:
                output = str(result)
                return output[-4000:] if len(output) > 4000 else output
            lines = []
            for s in result:
                lines.append(
                    f"  {s.get('id', '?')[:8]}... | {s.get('sessionType', '?')} | {s.get('status', '?')}"
                )
            return "Active sessions:\n" + "\n".join(lines)

        return str(result)
