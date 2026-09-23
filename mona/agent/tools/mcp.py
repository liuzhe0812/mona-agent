"""MCP client: connects to MCP servers and wraps their tools as native mona tools."""

import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import urllib.parse
import uuid
from contextlib import AsyncExitStack, suppress
from contextvars import ContextVar
from typing import Any

import httpx
from loguru import logger

from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry

# Transient connection errors that warrant a single retry.
# These typically happen when an MCP server restarts or a network
# connection is interrupted between calls.
_TRANSIENT_EXC_NAMES: frozenset[str] = frozenset((
    "ClosedResourceError",
    "BrokenResourceError",
    "EndOfStream",
    "BrokenPipeError",
    "ConnectionResetError",
    "ConnectionRefusedError",
    "ConnectionAbortedError",
    "ConnectionError",
))

_WINDOWS_SHELL_LAUNCHERS: frozenset[str] = frozenset(("npx", "npm", "pnpm", "yarn", "bunx"))
BUILTIN_COMPUTER_SERVER_NAME = "__mona_computer_use"
_COMPUTER_STRUCTURED_CONTEXT_MAX_CHARS = 12_000
# The driver rejects a label it has already closed, e.g.
# "this session has ended; call start_session explicitly to reuse its label".
# Mona keeps one label per conversation for the life of the MCP connection, so
# without reviving it every later computer call returns this error instead.
_STALE_COMPUTER_SESSION_RE = re.compile(
    r"session(?:\s+['\"`][^'\"`\r\n]+['\"`])?\s+(?:has\s+)?"
    r"(?:ended|expired|not\s+found|no\s+longer\s+active|is\s+not\s+active)\b",
    re.IGNORECASE,
)

# Characters allowed in tool names by model providers (Anthropic, OpenAI, etc.).
# Replace anything outside [a-zA-Z0-9_-] with underscore and collapse runs.
_SANITIZE_RE = re.compile(r"_+")

# Distinguishes "no replacement wrapper" from a tool legitimately returning None.
_NO_REPLACEMENT = object()


def _computer_error(code: str, message: str) -> str:
    return json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False)


def _computer_failed(result: Any) -> bool:
    if isinstance(result, str):
        if result.startswith("Error"):
            return True
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            return False
    return isinstance(result, dict) and (result.get("ok") is False or result.get("isError") is True)


_COMPUTER_PRIVATE_ARGUMENTS = {
    "session", "screenshot_out_file", "delivery_mode", "target",
    "element_index", "snapshot_id", "capture_mode", "from_zoom",
    "start_minimized", "include_screenshot",
}


def _computer_action_schema(target: Any) -> dict[str, Any]:
    schema = getattr(target, "parameters", {})
    properties = {
        name: value for name, value in schema.get("properties", {}).items()
        if name not in _COMPUTER_PRIVATE_ARGUMENTS
    }
    return {"type": "object", "properties": properties, "additionalProperties": False,
            "required": [name for name in schema.get("required", []) if name in properties]}


def _sanitize_name(name: str) -> str:
    """Sanitize an MCP-derived name for model API compatibility."""
    return _SANITIZE_RE.sub("_", re.sub(r"[^a-zA-Z0-9_-]", "_", name))


def _wrapped_tool_name(server_name: str, original_name: str) -> str:
    if server_name == BUILTIN_COMPUTER_SERVER_NAME:
        return _sanitize_name(f"computer_{original_name}")
    return _sanitize_name(f"mcp_{server_name}_{original_name}")


def _computer_structured_context(result: Any) -> str | None:
    structured = getattr(result, "structuredContent", None) or getattr(
        result, "structured_content", None
    )
    if not isinstance(structured, dict):
        return None
    elements = structured.get("elements")
    if not isinstance(elements, list):
        return None
    lines = [
        "Actionable computer snapshot:",
        "snapshot_id={snapshot} screenshot={width}x{height} window-local pixels".format(
            snapshot=structured.get("snapshot_id"),
            width=structured.get("screenshot_width"),
            height=structured.get("screenshot_height"),
        ),
        "Prefer element_token for controls. Use x/y only for canvas content in this screenshot. "
        "The screenshot origin is its top-left pixel, including the title/menu bars. "
        "Do not apply Windows display scaling or add the screen/window position; the driver maps screenshot pixels.",
    ]
    for element in elements:
        if not isinstance(element, dict) or not element.get("element_token"):
            continue
        line = (
            "- element_token={token} role={role} label={label}".format(
                token=element["element_token"],
                role=element.get("role", ""),
                label=json.dumps(str(element.get("label", ""))[:200], ensure_ascii=False),
            )
        )
        if sum(len(item) + 1 for item in lines) + len(line) > _COMPUTER_STRUCTURED_CONTEXT_MAX_CHARS:
            lines.append("- additional elements omitted; query the window again with a narrower filter")
            break
        lines.append(line)
    return "\n".join(lines)


def _is_transient(exc: BaseException) -> bool:
    """Check if an exception looks like a transient connection error."""
    return type(exc).__name__ in _TRANSIENT_EXC_NAMES


def _is_stale_computer_session_text(text: str) -> bool:
    """Check whether driver output reports a closed per-conversation session."""
    return bool(text) and bool(_STALE_COMPUTER_SESSION_RE.search(text))


def _is_stale_computer_session_result(result: Any) -> bool:
    """Check whether an MCP tool result is a closed-session error.

    The driver reports this as an ``isError`` result rather than a raised
    exception, so it has to be inspected before the content is returned as a
    successful observation.
    """
    if not getattr(result, "isError", False):
        return False
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and _is_stale_computer_session_text(text):
            return True
    return False


async def _probe_http_url(url: str, timeout: float = 3.0) -> bool:
    """Quick TCP probe to check if an HTTP MCP server is reachable.

    Avoids entering ``streamable_http_client`` / ``sse_client`` when the port is
    closed — those transports use anyio task groups whose cleanup can raise
    ``RuntimeError`` / ``ExceptionGroup`` that escape the caller's try/except
    and crash the event loop.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port
    if not port:
        port = 443 if parsed.scheme == "https" else 80
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout,
        )
        writer.close()
        await writer.wait_closed()
        return True
    except (OSError, asyncio.TimeoutError):
        return False


def _windows_command_basename(command: str) -> str:
    """Return the lowercase basename for a Windows command or path."""
    return command.replace("\\", "/").rsplit("/", maxsplit=1)[-1].lower()


def _normalize_windows_stdio_command(
    command: str,
    args: list[str] | None,
    env: dict[str, str] | None,
) -> tuple[str, list[str], dict[str, str] | None]:
    """Wrap Windows shell launchers so MCP stdio servers start reliably."""
    normalized_args = list(args or [])
    if os.name != "nt":
        return command, normalized_args, env

    basename = _windows_command_basename(command)
    if basename in {"cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"}:
        return command, normalized_args, env

    if basename.endswith((".exe", ".com")):
        return command, normalized_args, env

    resolved = shutil.which(command, path=(env or {}).get("PATH")) or command
    resolved_basename = _windows_command_basename(resolved)
    should_wrap = (
        basename in _WINDOWS_SHELL_LAUNCHERS
        or basename.endswith((".cmd", ".bat"))
        or resolved_basename.endswith((".cmd", ".bat"))
    )
    if not should_wrap:
        return command, normalized_args, env

    comspec = (env or {}).get("COMSPEC") or os.environ.get("COMSPEC") or "cmd.exe"
    return comspec, ["/d", "/c", command, *normalized_args], env


def _extract_nullable_branch(options: Any) -> tuple[dict[str, Any], bool] | None:
    """Return the single non-null branch for nullable unions."""
    if not isinstance(options, list):
        return None

    non_null: list[dict[str, Any]] = []
    saw_null = False
    for option in options:
        if not isinstance(option, dict):
            return None
        if option.get("type") == "null":
            saw_null = True
            continue
        non_null.append(option)

    if saw_null and len(non_null) == 1:
        return non_null[0], True
    return None


def _normalize_schema_for_openai(schema: Any) -> dict[str, Any]:
    """Normalize only nullable JSON Schema patterns for tool definitions."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}

    normalized = dict(schema)

    raw_type = normalized.get("type")
    if isinstance(raw_type, list):
        non_null = [item for item in raw_type if item != "null"]
        if "null" in raw_type and len(non_null) == 1:
            normalized["type"] = non_null[0]
            normalized["nullable"] = True

    for key in ("oneOf", "anyOf"):
        nullable_branch = _extract_nullable_branch(normalized.get(key))
        if nullable_branch is not None:
            branch, _ = nullable_branch
            merged = {k: v for k, v in normalized.items() if k != key}
            merged.update(branch)
            normalized = merged
            normalized["nullable"] = True
            break

    if "properties" in normalized and isinstance(normalized["properties"], dict):
        normalized["properties"] = {
            name: _normalize_schema_for_openai(prop) if isinstance(prop, dict) else prop
            for name, prop in normalized["properties"].items()
        }

    if "items" in normalized and isinstance(normalized["items"], dict):
        normalized["items"] = _normalize_schema_for_openai(normalized["items"])

    if normalized.get("type") != "object":
        return normalized

    normalized.setdefault("properties", {})
    normalized.setdefault("required", [])
    return normalized


class MCPToolWrapper(Tool):
    """Wraps a single MCP server tool as a mona Tool."""

    _plugin_discoverable = False
    requires_explicit_permission = True

    def __init__(
        self,
        session,
        server_name: str,
        tool_def,
        tool_timeout: int = 30,
        computer_session_nonce: str | None = None,
        reconnect=None,
    ):
        self._session = session
        self._server_name = server_name
        self.model_visible = server_name != BUILTIN_COMPUTER_SERVER_NAME
        self._computer_session_nonce = computer_session_nonce
        self._computer_session_context: ContextVar[str | None] = ContextVar(
            f"computer_session_{id(self)}", default=None,
        )
        self._reconnect = reconnect
        self._reconnect_disabled = False
        self._original_name = tool_def.name
        self._name = _wrapped_tool_name(server_name, tool_def.name)
        self._description = tool_def.description or tool_def.name
        raw_schema = tool_def.inputSchema or {"type": "object", "properties": {}}
        self._parameters = _normalize_schema_for_openai(raw_schema)
        self._accepts_computer_session = False
        if server_name == BUILTIN_COMPUTER_SERVER_NAME:
            properties = self._parameters.get("properties")
            if isinstance(properties, dict):
                properties.pop("screenshot_out_file", None)
                self._accepts_computer_session = "session" in properties
                properties.pop("session", None)
        self._tool_timeout = tool_timeout
        annotations = getattr(tool_def, "annotations", None)
        if isinstance(annotations, dict):
            self._read_only = bool(
                annotations.get("readOnlyHint") or annotations.get("read_only_hint")
            )
        else:
            self._read_only = bool(
                getattr(annotations, "readOnlyHint", False)
                or getattr(annotations, "read_only_hint", False)
            )

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    @property
    def read_only(self) -> bool:
        return self._read_only

    @property
    def _computer_session(self) -> str | None:
        return self._computer_session_context.get()

    @_computer_session.setter
    def _computer_session(self, value: str | None) -> None:
        self._computer_session_context.set(value)

    def set_context(self, context: Any) -> None:
        if self._computer_session_nonce is None:
            return
        from mona.computer_use.session import get_computer_turn

        turn = get_computer_turn()
        if turn is not None:
            self._computer_session = turn.driver_label
            return
        identity = str(context.session_key or context.chat_id)
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
        self._computer_session = f"mona-{self._computer_session_nonce}-{digest}"

    async def _restart_computer_session(self) -> bool:
        """Re-open this conversation's driver session after the driver closed it.

        A daemon restart or a revoked session ends the label, and every later
        call carrying it is rejected until ``start_session`` re-opens it. Returns
        whether the session is usable again.
        """
        if self._server_name != BUILTIN_COMPUTER_SERVER_NAME or not self._computer_session:
            return False
        from mona.computer_use.session import get_computer_turn

        turn = get_computer_turn()
        if turn is not None and turn.stopped:
            return False
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(
                    "start_session", arguments={"session": self._computer_session}
                ),
                timeout=self._tool_timeout,
            )
        except Exception:
            logger.exception(
                "Computer session '{}' could not be restarted", self._computer_session
            )
            return False
        if getattr(result, "isError", False):
            logger.warning(
                "Computer session '{}' restart was rejected by the driver",
                self._computer_session,
            )
            return False
        logger.info(
            "Computer session '{}' restarted after the driver closed it",
            self._computer_session,
        )
        return True

    async def _replace_connection(self, kwargs: dict[str, Any]) -> Any:
        """Rebuild the MCP server process and retry through the fresh wrapper.

        Used when the stdio transport is dead (driver process exited/crashed),
        which no amount of retrying on the old session can recover. Returns
        ``_NO_REPLACEMENT`` when the server could not be rebuilt, so the caller
        falls back to its normal error handling.
        """
        if self._reconnect is None or self._reconnect_disabled:
            return _NO_REPLACEMENT
        from mona.computer_use.session import get_computer_turn

        turn = get_computer_turn()
        if turn is not None and turn.stopped:
            return _NO_REPLACEMENT
        self._reconnect_disabled = True
        replacement = await self._reconnect()
        if replacement is None or replacement is self:
            return _NO_REPLACEMENT
        # A fresh driver process means this conversation's label is free again;
        # carry it over so the retry keeps the same per-conversation isolation.
        if self._computer_session and getattr(replacement, "_accepts_computer_session", False):
            replacement._computer_session = self._computer_session
        replacement._reconnect_disabled = True
        logger.info("MCP server '{}' reconnected; retrying '{}'", self._server_name, self._name)
        return await replacement.execute(**kwargs)

    async def execute(self, **kwargs: Any) -> Any:
        from mcp import types

        from mona.computer_use.session import get_computer_turn, track_computer_session

        is_computer = self._server_name == BUILTIN_COMPUTER_SERVER_NAME
        turn = get_computer_turn() if is_computer else None
        if turn is not None and turn.stopped:
            return _computer_error("COMPUTER_STOPPED", "Computer operation was stopped by the user.")

        if (
            self._server_name == BUILTIN_COMPUTER_SERVER_NAME
            and "screenshot_out_file" in kwargs
        ):
            return "Computer screenshots are returned directly; explicit output paths are disabled."
        if (
            self._computer_session is not None
            and self._accepts_computer_session
        ):
            kwargs = {
                **{key: value for key, value in kwargs.items() if key != "session"},
                "session": self._computer_session,
            }
        if turn is not None and self._computer_session:
            if not track_computer_session(turn, self._session, self._computer_session):
                return _computer_error("COMPUTER_STOPPED", "Computer session no longer owns the desktop.")

        for attempt in range(2):  # At most 1 retry
            if turn is not None and turn.stopped:
                return _computer_error("COMPUTER_STOPPED", "Computer operation was stopped by the user.")
            if turn is not None and turn.dispatch_guard is not None:
                reason = turn.dispatch_guard()
                if reason:
                    return _computer_error("COMPUTER_HANDOFF", reason)
            try:
                result = await asyncio.wait_for(
                    self._session.call_tool(self._original_name, arguments=kwargs),
                    timeout=self._tool_timeout,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "MCP tool '{}' timed out after {}s", self._name, self._tool_timeout
                )
                message = f"MCP tool call timed out after {self._tool_timeout}s"
                return _computer_error("COMPUTER_TIMEOUT", message) if is_computer else f"({message})"
            except asyncio.CancelledError:
                # MCP SDK's anyio cancel scopes can leak CancelledError on timeout/failure.
                # Re-raise only if our task was externally cancelled (e.g. /stop).
                task = asyncio.current_task()
                if task is not None and task.cancelling() > 0:
                    raise
                logger.warning("MCP tool '{}' was cancelled by server/SDK", self._name)
                if is_computer:
                    return _computer_error("COMPUTER_CANCELLED", "MCP tool call was cancelled")
                return "(MCP tool call was cancelled)"
            except Exception as exc:
                if (
                    attempt == 0
                    and self._server_name == BUILTIN_COMPUTER_SERVER_NAME
                    and _is_stale_computer_session_text(str(exc))
                ):
                    if await self._restart_computer_session():
                        continue
                    replacement_result = await self._replace_connection(kwargs)
                    if replacement_result is not _NO_REPLACEMENT:
                        return replacement_result
                if _is_transient(exc):
                    if is_computer and self._name in ComputerActTool._actions.values():
                        return _computer_error(
                            "COMPUTER_OUTCOME_UNKNOWN",
                            "Connection lost during the action. Observe the target before deciding "
                            "what to do next; do not blindly repeat the action.",
                        )
                    if attempt == 0:
                        # A dead stdio transport cannot recover by retrying the
                        # same session; rebuild the server process instead.
                        replacement_result = await self._replace_connection(kwargs)
                        if replacement_result is not _NO_REPLACEMENT:
                            return replacement_result
                        logger.warning(
                            "MCP tool '{}' hit transient error ({}), retrying once...",
                            self._name,
                            type(exc).__name__,
                        )
                        await asyncio.sleep(1)  # Brief backoff before retry
                        continue
                    # Second transient failure — give up with retry-specific message
                    logger.exception(
                        "MCP tool '{}' failed after retry: {}",
                        self._name,
                        type(exc).__name__,
                    )
                    message = f"MCP tool call failed after retry: {type(exc).__name__}"
                    return _computer_error("COMPUTER_CONNECTION_FAILED", message) if is_computer else f"({message})"
                logger.exception(
                    "MCP tool '{}' failed: {}: {}",
                    self._name,
                    type(exc).__name__,
                    exc,
                )
                message = f"MCP tool call failed: {type(exc).__name__}"
                return _computer_error("COMPUTER_CALL_FAILED", message) if is_computer else f"({message})"
            else:
                if (
                    self._server_name == BUILTIN_COMPUTER_SERVER_NAME
                    and _is_stale_computer_session_result(result)
                ):
                    if attempt == 0 and await self._restart_computer_session():
                        continue
                    if attempt == 0:
                        replacement_result = await self._replace_connection(kwargs)
                        if replacement_result is not _NO_REPLACEMENT:
                            return replacement_result
                    logger.warning(
                        "Computer session '{}' stayed closed after a restart attempt",
                        self._computer_session,
                    )
                    return _computer_error(
                        "COMPUTER_SESSION_CLOSED",
                        "Computer session was closed by the driver and could not be restarted.",
                    )
                # Success — extract result
                parts: list[str] = []
                blocks: list[dict[str, Any]] = []
                for block in result.content:
                    if isinstance(block, types.TextContent):
                        parts.append(block.text)
                        blocks.append({"type": "text", "text": block.text})
                    elif (
                        getattr(types, "ImageContent", None) is not None
                        and isinstance(block, types.ImageContent)
                    ):
                        mime = getattr(block, "mimeType", None) or getattr(
                            block, "mime_type", "image/png"
                        )
                        blocks.append(
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{mime};base64,{block.data}"
                                },
                            }
                        )
                    else:
                        rendered = str(block)
                        parts.append(rendered)
                        blocks.append({"type": "text", "text": rendered})
                structured = getattr(result, "structuredContent", None) or getattr(result, "structured_content", None)
                if getattr(result, "isError", False) or (
                    isinstance(structured, dict) and structured.get("effect") == "refused"
                ):
                    details = structured if isinstance(structured, dict) else {}
                    refusal = details.get("refusal") or {}
                    return json.dumps({
                        "ok": False,
                        "isError": True,
                        "error": {
                            "code": refusal.get("code") or details.get("code") or "MCP_TOOL_ERROR",
                            "message": "\n".join(parts) or "MCP tool reported failure",
                        },
                        "structuredContent": structured,
                        "content": blocks,
                    }, ensure_ascii=False)
                if is_computer:
                    observation = None
                    if turn is not None:
                        from mona.computer_use.actions import remember_observation

                        observation = remember_observation(turn, self._original_name, kwargs, result)
                    structured_context = _computer_structured_context(result)
                    if structured_context:
                        parts.append(structured_context)
                        image_index = next(
                            (
                                index
                                for index, item in enumerate(blocks)
                                if item.get("type") == "image_url"
                            ),
                            len(blocks),
                        )
                        blocks.insert(
                            image_index,
                            {"type": "text", "text": structured_context},
                        )
                    elif isinstance(structured, dict):
                        receipt = json.dumps(structured, ensure_ascii=False)
                        parts.append(receipt)
                        blocks.append({"type": "text", "text": receipt})
                    if observation is not None:
                        from mona.computer_use.perception import observation_context

                        context = observation_context(observation)
                        parts.append(context)
                        image_index = next(
                            (
                                index
                                for index, item in enumerate(blocks)
                                if item.get("type") == "image_url"
                            ),
                            len(blocks),
                        )
                        blocks.insert(image_index, {"type": "text", "text": context})
                if any(item.get("type") == "image_url" for item in blocks):
                    return blocks or [{"type": "text", "text": "(no output)"}]
                return "\n".join(parts) or "(no output)"

        return "(MCP tool call failed)"  # Unreachable, but satisfies type checkers


class _ComputerFacadeTool(Tool):
    _plugin_discoverable = False
    requires_explicit_permission = True
    _actions: dict[str, str] = {}

    def __init__(
        self, registry: ToolRegistry, *, provider=None, model=None,
        runtime_config_loader=None, provider_loader=None, permission_check=None, geometry_reader=None,
    ):
        self._registry = registry
        self._provider = provider
        self._model = model
        self._runtime_config_loader = runtime_config_loader
        self._provider_loader = provider_loader
        self._permission_check = permission_check
        self._geometry_reader = geometry_reader

    def _config(self):
        from mona.config.loader import load_config, resolve_config_env_vars

        return resolve_config_env_vars((self._runtime_config_loader or load_config)())

    def _geometry(self, args):
        if self._geometry_reader and args.get("pid") is not None and args.get("window_id") is not None:
            return self._geometry_reader(args["pid"], args["window_id"])
        return None

    @property
    def exclusive(self) -> bool:
        # Observations replace the snapshot used to validate the next action.
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        properties: dict[str, Any] = {}
        for name in self._actions.values():
            properties.update(_computer_action_schema(self._registry.get(name))["properties"])
        properties["image_id"] = {"type": "string", "description": "Image ID from the current original screenshot or latest zoom. Omit only for original screenshot coordinates."}
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": list(self._actions),
                },
                "arguments": {
                    "type": "object",
                    "description": "Arguments for the selected action. Window actions require exact "
                    "pid/window_id from the last screenshot. Choose element_token OR x/y, never both.",
                    "properties": properties,
                    "additionalProperties": False,
                },
            },
            "required": ["action"],
        }

    async def execute(
        self,
        action: str,
        arguments: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> Any:
        target_name = self._actions.get(action)
        if target_name is None:
            return f"Error: Unknown computer action: {action}"
        target = self._registry.get(target_name)
        if target is None:
            return f"Error: Computer action is unavailable: {action}"
        if arguments is not None and not isinstance(arguments, dict):
            return "Error: arguments must be an object"
        from mona.computer_use.actions import validate_action
        from mona.computer_use.session import claim_computer_turn, get_computer_turn

        turn = get_computer_turn()
        if turn is None or turn.stopped:
            return _computer_error("COMPUTER_STOPPED", "Start a new turn before operating the computer.")
        if not claim_computer_turn(turn):
            return _computer_error("COMPUTER_BUSY", "Another task is operating the computer. Wait until it finishes.")
        if self._permission_check and not self._permission_check():
            return _computer_error("COMPUTER_PERMISSION_REVOKED", "Computer operation permission was revoked.")
        args = dict(arguments or {})
        if "session" in args or "screenshot_out_file" in args:
            return _computer_error("INVALID_COMPUTER_ARGUMENTS", "Session and screenshot paths are managed by Mona.")
        is_action = self.name == "computer_act"
        if is_action:
            from mona.computer_use.actions import (
                image_point_to_original,
                repeated_no_progress_error,
            )

            if turn.observation is None and action != "launch":
                return _computer_error("INVALID_COMPUTER_TARGET", validate_action(action, args, None))
            image_id = args.pop("image_id", None)
            if (turn.observation or {}).get("detail_view") and image_id is None and any(key in args for key in ("x", "y", "from_x", "from_y", "to_x", "to_y")):
                return _computer_error("INVALID_COMPUTER_TARGET", "A detail image exists. Specify the original or detail image_id before using pixel coordinates.")
            try:
                for x_key, y_key in (("x", "y"), ("from_x", "from_y"), ("to_x", "to_y")):
                    if x_key in args or y_key in args:
                        args[x_key], args[y_key] = image_point_to_original(
                            turn.observation or {}, args.get(x_key), args.get(y_key), image_id=image_id,
                        )
                if image_id is not None and not any(key in args for key in ("x", "from_x", "to_x")):
                    return _computer_error("INVALID_COMPUTER_ARGUMENTS", "image_id is only used with pixel coordinates")
            except ValueError as exc:
                return _computer_error("INVALID_COMPUTER_TARGET", str(exc))

            error = validate_action(action, args, turn.observation) or repeated_no_progress_error(
                turn, action, args
            )
            if error:
                return _computer_error("INVALID_COMPUTER_TARGET", error)
            before_geometry = (turn.observation or {}).get("geometry")
            if before_geometry is not None and self._geometry(args) != before_geometry:
                turn.observation = None
                return _computer_error("STALE_COMPUTER_TARGET", "Window moved or resized. Observe it again.")
        args.pop("delivery_mode", None)
        schema = getattr(target, "parameters", {})
        if isinstance(target, MCPToolWrapper):
            properties = schema.get("properties", {})
            if is_action and "delivery_mode" in properties:
                args["delivery_mode"] = "foreground"
            if action == "window":
                args["include_screenshot"] = True
            if action == "launch" and "start_minimized" in properties:
                args["start_minimized"] = False
            if "scope" not in properties and args.get("scope") == "window":
                args.pop("scope")
            unknown = set(args) - set(properties)
            if unknown:
                return _computer_error("INVALID_COMPUTER_ARGUMENTS", f"Unsupported arguments for {action}: {', '.join(sorted(unknown))}")
            args = target.cast_params(args)
            errors = target.validate_params(args)
            if errors:
                return _computer_error("INVALID_COMPUTER_ARGUMENTS", "; ".join(errors))
        if is_action:
            # Consumed even if dispatch fails: its outcome may be uncertain.
            from mona.computer_use.actions import remember_pending_action

            remember_pending_action(turn, action, args)
            turn.observation = None
            if action not in {"launch", "focus"} and args.get("scope", "window") == "window":
                focus = self._registry.get("computer_bring_to_front")
                if focus is None:
                    return _computer_error("COMPUTER_UNAVAILABLE", "Cannot focus the target window.")
                focused = await focus.execute(pid=args["pid"], window_id=args["window_id"])
                if _computer_failed(focused):
                    turn.pending_action = None
                    return focused
                if turn.stopped:
                    return _computer_error("COMPUTER_STOPPED", "Computer operation was stopped by the user.")
                if before_geometry is not None and self._geometry(args) != before_geometry:
                    turn.pending_action = None
                    return _computer_error("STALE_COMPUTER_TARGET", "Window geometry changed while focusing; observe again.")
            if self._permission_check and not self._permission_check():
                turn.pending_action = None
                return _computer_error("COMPUTER_PERMISSION_REVOKED", "Computer operation permission was revoked.")
            if turn.dispatch_guard and (reason := turn.dispatch_guard()):
                turn.pending_action = None
                return _computer_error("COMPUTER_HANDOFF", reason)
        elif action in {"window", "desktop"}:
            turn.observation = None
        result = await target.execute(**args)
        if isinstance(result, str) and result.startswith("✅"):
            return (
                f"{result}\nAction dispatch acknowledged, but UI change is not yet verified. "
                "Re-observe the same target before claiming success."
            )
        return result


class ComputerObserveTool(_ComputerFacadeTool):
    name = "computer_observe"
    description = (
        "Observe the local desktop without changing it. Actions: desktop (screenshot), "
        "apps, windows, window (UI tree plus screenshot; arguments pid/window_id), "
        "verify, health, permissions, accessibility, zoom (crop the current screenshot using x1/y1/x2/y2), "
        "and preview (mark a planned x/y or candidate_id without input). "
        "Start with windows to identify the target; window/desktop return screenshots directly. Observe the same target "
        "again after every computer_act operation. Window/desktop screenshots authorize "
        "the next action only. Zoom preserves that observation and returns an image_id; "
        "pass that exact image_id when using zoom pixel coordinates. Preview does not send input."
    )
    _actions = {
        "desktop": "computer_get_desktop_state",
        "apps": "computer_list_apps",
        "windows": "computer_list_windows",
        "window": "computer_get_window_state",
        "verify": "computer_verify_state",
        "health": "computer_health_report",
        "permissions": "computer_check_permissions",
        "accessibility": "computer_get_accessibility_tree",
        "zoom": "computer_zoom",
    }

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        schema = super().parameters
        schema["properties"]["action"]["enum"].append("preview")
        properties = schema["properties"]["arguments"]["properties"]
        for key in ("x", "y", "x1", "y1", "x2", "y2"):
            properties[key] = {"type": "number"}
        properties["candidate_id"] = {"type": "string", "description": "One candidate from the current observation to preview; do not combine with coordinates."}
        schema["properties"]["goal"] = {"type": "string", "maxLength": 12000, "description": "Current phase goal to focus visual perception."}
        return schema

    def _image_operation(self, action: str, arguments: dict | None):
        from mona.computer_use.actions import image_point_to_original, validate_action
        from mona.computer_use.perception import (
            make_detail_view,
            observation_data_url,
            preview_point,
        )
        from mona.computer_use.session import claim_computer_turn, get_computer_turn

        turn = get_computer_turn()
        if turn is None or turn.stopped:
            return _computer_error("COMPUTER_STOPPED", "Start a new turn before observing the computer.")
        if not claim_computer_turn(turn):
            return _computer_error("COMPUTER_BUSY", "Another task owns the computer.")
        if self._permission_check and not self._permission_check():
            return _computer_error("COMPUTER_PERMISSION_REVOKED", "Computer permission was revoked.")
        if arguments is not None and not isinstance(arguments, dict):
            return _computer_error("INVALID_COMPUTER_ARGUMENTS", "arguments must be an object")
        observation = turn.observation
        if observation is None:
            return _computer_error("INVALID_COMPUTER_TARGET", "Observe the target before requesting a zoom or preview.")
        args = arguments or {}
        if observation.get("detail_view") and "image_id" not in args and "candidate_id" not in args:
            return _computer_error("INVALID_COMPUTER_TARGET", "Specify the original or detail image_id when multiple images exist.")
        allowed = {"pid", "window_id", "scope", "image_id"} | ({"x1", "y1", "x2", "y2"} if action == "zoom" else {"x", "y", "candidate_id"})
        if set(args) - allowed:
            return _computer_error("INVALID_COMPUTER_ARGUMENTS", "Unsupported image operation arguments")
        target = {key: args.get(key, observation.get(key)) for key in ("scope", "pid", "window_id")}
        if target["scope"] == "desktop":
            target = {key: value for key, value in target.items() if value is not None}
        error = validate_action("focus", target, observation)
        if error:
            return _computer_error("INVALID_COMPUTER_TARGET", error)
        try:
            if observation.get("geometry") is not None and self._geometry(target) != observation["geometry"]:
                turn.observation = None
                return _computer_error("STALE_COMPUTER_TARGET", "Window changed; observe again.")
            if action == "zoom":
                left, top = image_point_to_original(observation, args.get("x1"), args.get("y1"), image_id=args.get("image_id"))
                right, bottom = image_point_to_original(observation, args.get("x2"), args.get("y2"), image_id=args.get("image_id"), allow_edge=True)
                view = make_detail_view(observation, {"x": left, "y": top, "w": right - left, "h": bottom - top})
                metadata = {key: value for key, value in view.items() if key != "screenshot"}
                metadata["message"] = "局部图已生成，未发送任何输入。使用此图坐标时必须携带对应 image_id。"
                url = observation_data_url(view)
            else:
                if "candidate_id" in args:
                    if any(key in args for key in ("x", "y", "image_id")):
                        raise ValueError("Use candidate_id OR image coordinates")
                    candidate = next((c for c in observation.get("candidates", []) if c.get("id") == args["candidate_id"]), None)
                    frame = candidate.get("frame") if candidate else None
                    if not frame:
                        raise ValueError("Candidate has no verified screenshot position; use screenshot coordinates")
                    x, y = image_point_to_original(observation, frame["x"] + frame["w"] / 2, frame["y"] + frame["h"] / 2)
                else:
                    x, y = image_point_to_original(observation, args.get("x"), args.get("y"), image_id=args.get("image_id"))
                metadata = {"image_id": observation.get("image_id"), "point": {"x": x, "y": y}, "executed": False,
                            "message": "红圈标记计划落点，未点击或移动鼠标，不代表实际输入已经命中。"}
                url = preview_point(observation, x, y)
            return [{"type": "text", "text": json.dumps(metadata, ensure_ascii=False)}, {"type": "image_url", "image_url": {"url": url}}]
        except (ValueError, OSError) as exc:
            return _computer_error("INVALID_COMPUTER_TARGET", str(exc))

    async def execute(self, action, arguments=None, goal="", **kwargs):
        from mona.computer_use.session import get_computer_turn

        if action in {"zoom", "preview"}:
            return self._image_operation(action, arguments)
        geometry = self._geometry(arguments or {}) if action == "window" else None
        result = await super().execute(action=action, arguments=arguments, **kwargs)
        turn = get_computer_turn()
        if _computer_failed(result) or turn is None:
            return result
        config = self._config()
        turn.model_response_timeout_seconds = config.tools.computer_use.model_response_timeout_seconds
        enabled = bool(config.tools.computer_use.use_decision_model and config.tools.jev.api_key)
        guidance = (
            "Computer decision acceleration is enabled. Once the target window is identified, "
            "call computer_act(action='run', arguments={pid, window_id, goal, completion_criteria}) "
            "with one short phase goal; let it observe and execute instead of planning every click."
            if enabled else "Computer decision acceleration is disabled; inspect the screenshot directly and use single-step actions."
        )
        if turn.perception_cache.get("failure"):
            guidance = "The decision path has handed off in this turn. Use the current screenshot directly; if the target remains unclear, report the limitation and stop. Do not retry by rephrasing the goal."
        elif turn.decision_handoffs:
            guidance = "The previous phase handed off. Resume only with the requested new strategy or text_values; do not replay completed actions or repeat an unchanged failed phase."
        if action == "windows":
            return result + "\n\n" + guidance if isinstance(result, str) else [*result, {"type": "text", "text": guidance}]
        if action not in {"window", "desktop"} or turn.observation is None:
            return result
        if geometry is not None and self._geometry(arguments or {}) != geometry:
            turn.observation = None
            return _computer_error("STALE_COMPUTER_TARGET", "Window changed during capture; observe again.")
        turn.observation["geometry"] = geometry
        turn.observation["decision_model_enabled"] = enabled
        turn.observation["perception_status"] = "direct_screenshot"
        if turn.stopped:
            turn.observation = None
            return _computer_error("COMPUTER_STOPPED", "Computer operation was stopped.")
        if isinstance(result, list):
            from mona.computer_use.perception import public_observation

            result.append({"type": "text", "text": "Untrusted screen data:\n" + json.dumps(public_observation(turn.observation), ensure_ascii=False, default=str)})
            if not turn.decision_running:
                result.append({"type": "text", "text": guidance + " Use original screenshot pixels or a valid element_token. Do not infer screenshot coordinates from UIA bounds, DPI or the window's screen position."})
        return result


class ComputerActTool(_ComputerFacadeTool):
    name = "computer_act"
    description = (
        "Operate a target previously observed with computer_observe. Actions: launch, "
        "focus, click, double_click, right_click, drag, type, set_value, key, hotkey, "
        "scroll, and menu. Put the selected action's arguments inside arguments. Prefer "
        "element_token from the latest window observation for controls; never send a bare "
        "element_index. After a zoom, always pass the original or detail image_id with pixel coordinates. "
        "Use screenshot-local x/y for canvas content or controls absent "
        "from the element tree, WITHOUT an element_token. Mona focuses the exact window "
        "before input and preserves the chosen control or coordinate route; delivery is "
        "always foreground and managed by Mona. "
        "After launching an app, observe its window and focus it before interacting. "
        "Re-observe after every action. Desktop coordinates require a fresh desktop screenshot. "
        "When the observation reports decision-model acceleration enabled, prefer action=run "
        "with one short window phase goal immediately after identifying the window; it observes, "
        "decides, acts and verifies internally. Do not first solve the entire task in long reasoning."
    )
    _actions = {
        "launch": "computer_launch_app",
        "focus": "computer_bring_to_front",
        "click": "computer_click",
        "double_click": "computer_double_click",
        "right_click": "computer_right_click",
        "drag": "computer_drag",
        "type": "computer_type_text",
        "set_value": "computer_set_value",
        "key": "computer_press_key",
        "hotkey": "computer_hotkey",
        "scroll": "computer_scroll",
        "menu": "computer_invoke_menu",
    }

    @property
    def parameters(self) -> dict[str, Any]:
        schema = super().parameters
        schema["properties"]["action"]["enum"].append("run")
        schema["properties"]["arguments"]["properties"].update(
            {
                "goal": {"type": "string", "maxLength": 12000},
                "completion_criteria": {"type": "string", "maxLength": 4000},
                "strategy": {"type": "string", "maxLength": 4000, "description": "Optional phase strategy from the main model; supply when the decision loop requests planning."},
                "text_values": {
                    "type": "array",
                    "items": {"type": "string", "maxLength": 2000},
                    "maxItems": 20,
                },
                "max_steps": {"type": "integer", "minimum": 1, "maximum": 60},
            }
        )
        return schema

    async def execute(
        self,
        action: str,
        arguments: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        if action != "run":
            return await super().execute(action=action, arguments=arguments, **kwargs)
        from mona.computer_use.executor import run_computer_goal
        from mona.computer_use.session import claim_computer_turn, get_computer_turn

        turn = get_computer_turn()
        if turn is None or turn.stopped:
            return _computer_error("COMPUTER_STOPPED", "Start a new turn before operating the computer.")
        if not claim_computer_turn(turn):
            return _computer_error("COMPUTER_BUSY", "Another task is operating the computer.")
        args = dict(arguments or {})
        goal = args.get("goal")
        pid, window_id = args.get("pid"), args.get("window_id")
        if not isinstance(goal, str) or not goal.strip():
            return _computer_error("INVALID_COMPUTER_ARGUMENTS", "run requires a goal")
        if not isinstance(pid, int) or not isinstance(window_id, int):
            return _computer_error("INVALID_COMPUTER_ARGUMENTS", "run requires integer pid and window_id")
        config = self._config()
        computer_config = getattr(config.tools, "computer_use", None)
        if computer_config is None or not computer_config.use_decision_model:
            return _computer_error("DECISION_MODEL_DISABLED", "Computer decision-model acceleration is disabled.")
        decision_config = config.tools.jev.model_copy(deep=True)
        if not decision_config.api_key:
            return _computer_error("DECISION_MODEL_UNCONFIGURED", "Configure the decision model before enabling acceleration.")
        phase_id = hashlib.sha256(json.dumps(
            [pid, window_id, goal.strip(), args.get("strategy", ""), args.get("text_values", [])],
            ensure_ascii=False,
        ).encode()).hexdigest()
        if phase_id in turn.decision_handoffs:
            return _computer_error("COMPUTER_HANDOFF", "This phase already handed off. Inspect and use single-step actions before proposing a new phase.")
        if turn.decision_running:
            return _computer_error("COMPUTER_BUSY", "A decision loop already owns this turn.")
        observer = ComputerObserveTool(
            self._registry, provider=self._provider, model=self._model,
            runtime_config_loader=self._runtime_config_loader, provider_loader=self._provider_loader,
            permission_check=self._permission_check, geometry_reader=self._geometry_reader,
        )
        deadline = time.monotonic() + computer_config.max_duration_seconds

        def policy() -> str | None:
            if turn.stopped:
                return "stopped"
            if time.monotonic() >= deadline:
                return "Execution time budget expired."
            latest = self._config()
            if not latest.tools.computer_use.use_decision_model or not latest.tools.jev.api_key:
                return "Decision-model acceleration was disabled; continue with single-step actions."
            if self._permission_check and not self._permission_check():
                return "Computer permission was revoked."
            for tool_name, sample in (
                ("computer_observe", {"action": "window", "arguments": {"pid": pid, "window_id": window_id}}),
                ("computer_act", {"action": "run", "arguments": {"pid": pid, "window_id": window_id, "goal": goal}}),
            ):
                _, _, denied = self._registry.prepare_call(tool_name, sample)
                if denied:
                    return denied
            return None

        async def observe() -> Any:
            return await observer.execute(
                action="window", arguments={"pid": pid, "window_id": window_id}, goal=goal,
            )

        async def act(selected: str, selected_args: dict[str, Any]) -> Any:
            if turn.observation and any(key in selected_args for key in ("x", "from_x", "to_x")):
                selected_args = {**selected_args, "image_id": turn.observation.get("image_id")}
            return await _ComputerFacadeTool.execute(
                self, action=selected, arguments=selected_args
            )

        async def perceive(observation: dict) -> dict:
            from mona.computer_use.vision import enrich_observation

            provider, model = self._provider_loader() if self._provider_loader else (self._provider, self._model)
            return await enrich_observation(
                observation, goal=goal, config=self._config(), provider=provider,
                model=model, cache=turn.perception_cache,
            )

        async def progress(stage: str) -> None:
            if turn.progress is not None and not turn.stopped:
                text = {"observe": "正在识别电脑界面", "perception": "正在识别界面对象", "decision": "正在选择下一步操作", "act": "正在操作电脑", "settle": "正在确认界面变化", "wait": "正在等待界面更新"}.get(stage, "正在操作电脑")
                await turn.progress(text, tool_hint=True)

        turn.decision_running = True
        turn.dispatch_guard = policy
        try:
            result = await run_computer_goal(
                pid=pid,
                window_id=window_id,
                goal=goal.strip(),
                completion_criteria=str(args.get("completion_criteria") or "").strip(),
                text_values=[
                    value for value in args.get("text_values", []) if isinstance(value, str)
                ],
                max_steps=min(int(args.get("max_steps") or computer_config.max_steps), computer_config.max_steps),
                max_duration_seconds=computer_config.max_duration_seconds,
                decision_config=decision_config,
                observe=observe,
                act=act,
                get_observation=lambda: turn.observation,
                is_stopped=lambda: turn.stopped,
                guard=policy,
                min_confidence=computer_config.min_confidence,
                settle_seconds=computer_config.settle_seconds,
                supported_actions={action for action, name in self._actions.items() if self._registry.get(name)},
                progress=progress,
                perceive=perceive,
                strategy=str(args.get("strategy") or ""),
            )
            if result["status"] != "done_pending_verification":
                turn.decision_handoffs.add(phase_id)
            blocks = [{"type": "text", "text": json.dumps(result, ensure_ascii=False, default=str)}]
            if result.get("snapshot_current") and turn.observation:
                from mona.computer_use.perception import observation_data_url

                blocks.append({"type": "image_url", "image_url": {"url": observation_data_url(turn.observation)}})
            return blocks
        finally:
            turn.decision_running = False
            turn.dispatch_guard = None

    @property
    def read_only(self) -> bool:
        return False


class MCPResourceWrapper(Tool):
    """Wraps an MCP resource URI as a read-only mona Tool."""

    _plugin_discoverable = False
    requires_explicit_permission = True

    def __init__(self, session, server_name: str, resource_def, resource_timeout: int = 30):
        self._session = session
        self._uri = resource_def.uri
        self._name = _sanitize_name(f"mcp_{server_name}_resource_{resource_def.name}")
        desc = resource_def.description or resource_def.name
        self._description = f"[MCP Resource] {desc}\nURI: {self._uri}"
        self._parameters: dict[str, Any] = {
            "type": "object",
            "properties": {},
            "required": [],
        }
        self._resource_timeout = resource_timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types

        for attempt in range(2):
            try:
                result = await asyncio.wait_for(
                    self._session.read_resource(self._uri),
                    timeout=self._resource_timeout,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "MCP resource '{}' timed out after {}s", self._name, self._resource_timeout
                )
                return f"(MCP resource read timed out after {self._resource_timeout}s)"
            except asyncio.CancelledError:
                task = asyncio.current_task()
                if task is not None and task.cancelling() > 0:
                    raise
                logger.warning("MCP resource '{}' was cancelled by server/SDK", self._name)
                return "(MCP resource read was cancelled)"
            except Exception as exc:
                if _is_transient(exc):
                    if attempt == 0:
                        logger.warning(
                            "MCP resource '{}' hit transient error ({}), retrying once...",
                            self._name,
                            type(exc).__name__,
                        )
                        await asyncio.sleep(1)
                        continue
                    logger.exception(
                        "MCP resource '{}' failed after retry: {}",
                        self._name,
                        type(exc).__name__,
                    )
                    return f"(MCP resource read failed after retry: {type(exc).__name__})"
                logger.exception(
                    "MCP resource '{}' failed: {}: {}",
                    self._name,
                    type(exc).__name__,
                    exc,
                )
                return f"(MCP resource read failed: {type(exc).__name__})"
            else:
                parts: list[str] = []
                for block in result.contents:
                    if isinstance(block, types.TextResourceContents):
                        parts.append(block.text)
                    elif isinstance(block, types.BlobResourceContents):
                        parts.append(f"[Binary resource: {len(block.blob)} bytes]")
                    else:
                        parts.append(str(block))
                return "\n".join(parts) or "(no output)"

        return "(MCP resource read failed)"  # Unreachable


class MCPPromptWrapper(Tool):
    """Wraps an MCP prompt as a read-only mona Tool."""

    _plugin_discoverable = False
    requires_explicit_permission = True

    def __init__(self, session, server_name: str, prompt_def, prompt_timeout: int = 30):
        self._session = session
        self._prompt_name = prompt_def.name
        self._name = _sanitize_name(f"mcp_{server_name}_prompt_{prompt_def.name}")
        desc = prompt_def.description or prompt_def.name
        self._description = (
            f"[MCP Prompt] {desc}\n"
            "Returns a filled prompt template that can be used as a workflow guide."
        )
        self._prompt_timeout = prompt_timeout

        # Build parameters from prompt arguments
        properties: dict[str, Any] = {}
        required: list[str] = []
        for arg in prompt_def.arguments or []:
            prop: dict[str, Any] = {"type": "string"}
            if getattr(arg, "description", None):
                prop["description"] = arg.description
            properties[arg.name] = prop
            if arg.required:
                required.append(arg.name)
        self._parameters: dict[str, Any] = {
            "type": "object",
            "properties": properties,
            "required": required,
        }

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types
        from mcp.shared.exceptions import McpError

        for attempt in range(2):
            try:
                result = await asyncio.wait_for(
                    self._session.get_prompt(self._prompt_name, arguments=kwargs),
                    timeout=self._prompt_timeout,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "MCP prompt '{}' timed out after {}s", self._name, self._prompt_timeout
                )
                return f"(MCP prompt call timed out after {self._prompt_timeout}s)"
            except asyncio.CancelledError:
                task = asyncio.current_task()
                if task is not None and task.cancelling() > 0:
                    raise
                logger.warning("MCP prompt '{}' was cancelled by server/SDK", self._name)
                return "(MCP prompt call was cancelled)"
            except McpError as exc:
                logger.exception(
                    "MCP prompt '{}' failed: code={} message={}",
                    self._name,
                    exc.error.code,
                    exc.error.message,
                )
                return f"(MCP prompt call failed: {exc.error.message} [code {exc.error.code}])"
            except Exception as exc:
                if _is_transient(exc):
                    if attempt == 0:
                        logger.warning(
                            "MCP prompt '{}' hit transient error ({}), retrying once...",
                            self._name,
                            type(exc).__name__,
                        )
                        await asyncio.sleep(1)
                        continue
                    logger.exception(
                        "MCP prompt '{}' failed after retry: {}",
                        self._name,
                        type(exc).__name__,
                    )
                    return f"(MCP prompt call failed after retry: {type(exc).__name__})"
                logger.exception(
                    "MCP prompt '{}' failed: {}: {}",
                    self._name,
                    type(exc).__name__,
                    exc,
                )
                return f"(MCP prompt call failed: {type(exc).__name__})"
            else:
                parts: list[str] = []
                for message in result.messages:
                    content = message.content
                    if isinstance(content, types.TextContent):
                        parts.append(content.text)
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, types.TextContent):
                                parts.append(block.text)
                            else:
                                parts.append(str(block))
                    else:
                        parts.append(str(content))
                return "\n".join(parts) or "(no output)"

        return "(MCP prompt call failed)"  # Unreachable


async def connect_single_mcp_server(
    name: str,
    cfg,
    registry: ToolRegistry,
    reconnect=None,
    *,
    computer_provider: Any | None = None,
    computer_model: str | None = None,
    runtime_config_loader=None,
    computer_provider_loader=None,
    computer_permission_check=None,
) -> AsyncExitStack | None:
    """Connect to a single MCP server and register its tools/resources/prompts.

    Returns the server's dedicated AsyncExitStack on success, or None on failure.
    Each server gets its own stack to prevent cancel scope conflicts
    when multiple MCP servers are configured.

    ``reconnect`` is an optional async callback taking the server name and
    returning the replacement tool wrapper (or None). Wrappers use it to rebuild
    the server process when its stdio transport dies mid-call.
    """
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.sse import sse_client
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client

    server_stack = AsyncExitStack()
    await server_stack.__aenter__()

    try:
        transport_type = cfg.type
        if not transport_type:
            if cfg.command:
                transport_type = "stdio"
            elif cfg.url:
                transport_type = (
                    "sse" if cfg.url.rstrip("/").endswith("/sse") else "streamableHttp"
                )
            else:
                logger.warning("MCP server '{}': no command or url configured, skipping", name)
                await server_stack.aclose()
                return None

        if transport_type == "stdio":
            command, args, env = _normalize_windows_stdio_command(
                cfg.command,
                cfg.args,
                cfg.env or None,
            )
            params = StdioServerParameters(
                command=command,
                args=args,
                env=env,
            )
            read, write = await server_stack.enter_async_context(stdio_client(params))
        elif transport_type == "sse":
            if not await _probe_http_url(cfg.url):
                logger.warning("MCP server '{}': {} unreachable, skipping", name, cfg.url)
                await server_stack.aclose()
                return None

            def httpx_client_factory(
                headers: dict[str, str] | None = None,
                timeout: httpx.Timeout | None = None,
                auth: httpx.Auth | None = None,
            ) -> httpx.AsyncClient:
                merged_headers = {
                    "Accept": "application/json, text/event-stream",
                    **(cfg.headers or {}),
                    **(headers or {}),
                }
                return httpx.AsyncClient(
                    headers=merged_headers or None,
                    follow_redirects=True,
                    timeout=timeout,
                    auth=auth,
                )

            read, write = await server_stack.enter_async_context(
                sse_client(cfg.url, httpx_client_factory=httpx_client_factory)
            )
        elif transport_type == "streamableHttp":
            if not await _probe_http_url(cfg.url):
                logger.warning("MCP server '{}': {} unreachable, skipping", name, cfg.url)
                await server_stack.aclose()
                return None

            http_client = await server_stack.enter_async_context(
                httpx.AsyncClient(
                    headers=cfg.headers or None,
                    follow_redirects=True,
                    timeout=None,
                )
            )
            read, write, _ = await server_stack.enter_async_context(
                streamable_http_client(cfg.url, http_client=http_client)
            )
        else:
            logger.warning("MCP server '{}': unknown transport type '{}'", name, transport_type)
            await server_stack.aclose()
            return None

        session = await server_stack.enter_async_context(ClientSession(read, write))
        await session.initialize()

        tools = await session.list_tools()
        enabled_tools = set(cfg.enabled_tools)
        allow_all_tools = "*" in enabled_tools
        registered_count = 0
        matched_enabled_tools: set[str] = set()
        available_raw_names = [tool_def.name for tool_def in tools.tools]
        available_wrapped_names = [
            _wrapped_tool_name(name, tool_def.name) for tool_def in tools.tools
        ]
        computer_session_nonce = (
            uuid.uuid4().hex[:8] if name == BUILTIN_COMPUTER_SERVER_NAME else None
        )

        def make_reconnect(tool_name: str):
            async def _reconnect_tool():
                if reconnect is None:
                    return None
                replacement = await reconnect(name)
                if isinstance(replacement, dict):
                    return replacement.get(tool_name)
                return replacement

            return _reconnect_tool

        for tool_def in tools.tools:
            wrapped_name = _wrapped_tool_name(name, tool_def.name)
            if (
                not allow_all_tools
                and tool_def.name not in enabled_tools
                and wrapped_name not in enabled_tools
            ):
                logger.debug(
                    "MCP: skipping tool '{}' from server '{}' (not in enabledTools)",
                    wrapped_name,
                    name,
                )
                continue
            wrapper = MCPToolWrapper(
                session,
                name,
                tool_def,
                tool_timeout=cfg.tool_timeout,
                computer_session_nonce=computer_session_nonce,
                reconnect=(
                    make_reconnect(tool_def.name)
                    if reconnect is not None and name == BUILTIN_COMPUTER_SERVER_NAME
                    else None
                ),
            )
            registry.register(wrapper)
            logger.debug("MCP: registered tool '{}' from server '{}'", wrapper.name, name)
            registered_count += 1
            if enabled_tools:
                if tool_def.name in enabled_tools:
                    matched_enabled_tools.add(tool_def.name)
                if wrapped_name in enabled_tools:
                    matched_enabled_tools.add(wrapped_name)

        if name == BUILTIN_COMPUTER_SERVER_NAME:
            from mona.computer_use.geometry import window_geometry

            computer_kwargs = dict(
                provider=computer_provider, model=computer_model,
                runtime_config_loader=runtime_config_loader,
                provider_loader=computer_provider_loader, permission_check=computer_permission_check,
                geometry_reader=window_geometry,
            )
            registry.register(ComputerObserveTool(registry, **computer_kwargs))
            registry.register(
                ComputerActTool(
                    registry,
                    **computer_kwargs,
                )
            )
            registered_count += 2

        if enabled_tools and not allow_all_tools:
            unmatched_enabled_tools = sorted(enabled_tools - matched_enabled_tools)
            if unmatched_enabled_tools:
                logger.warning(
                    "MCP server '{}': enabledTools entries not found: {}. Available raw names: {}. "
                    "Available wrapped names: {}",
                    name,
                    ", ".join(unmatched_enabled_tools),
                    ", ".join(available_raw_names) or "(none)",
                    ", ".join(available_wrapped_names) or "(none)",
                )

        if name != BUILTIN_COMPUTER_SERVER_NAME:
            try:
                resources_result = await session.list_resources()
                for resource in resources_result.resources:
                    wrapper = MCPResourceWrapper(
                        session, name, resource, resource_timeout=cfg.tool_timeout
                    )
                    registry.register(wrapper)
                    registered_count += 1
                    logger.debug(
                        "MCP: registered resource '{}' from server '{}'", wrapper.name, name
                    )
            except Exception as e:
                logger.debug("MCP server '{}': resources not supported or failed: {}", name, e)

            try:
                prompts_result = await session.list_prompts()
                for prompt in prompts_result.prompts:
                    wrapper = MCPPromptWrapper(
                        session, name, prompt, prompt_timeout=cfg.tool_timeout
                    )
                    registry.register(wrapper)
                    registered_count += 1
                    logger.debug("MCP: registered prompt '{}' from server '{}'", wrapper.name, name)
            except Exception as e:
                logger.debug("MCP server '{}': prompts not supported or failed: {}", name, e)

        logger.info(
            "MCP server '{}': connected, {} capabilities registered", name, registered_count
        )
        return server_stack

    except Exception as e:
        hint = ""
        text = str(e).lower()
        if any(
            marker in text
            for marker in (
                "parse error",
                "invalid json",
                "unexpected token",
                "jsonrpc",
                "content-length",
            )
        ):
            hint = (
                " Hint: this looks like stdio protocol pollution. Make sure the MCP server writes "
                "only JSON-RPC to stdout and sends logs/debug output to stderr instead."
            )
        logger.exception("MCP server '{}': failed to connect: {}", name, hint)
        with suppress(Exception):
            await server_stack.aclose()
        return None


async def connect_mcp_servers(
    mcp_servers: dict,
    registry: ToolRegistry,
    reconnect=None,
    *,
    computer_provider: Any | None = None,
    computer_model: str | None = None,
    runtime_config_loader=None,
    computer_provider_loader=None,
    computer_permission_check=None,
) -> dict[str, AsyncExitStack]:
    """Connect to configured MCP servers and register their tools, resources, prompts.

    Returns a dict mapping server name -> its dedicated AsyncExitStack.
    Each server gets its own stack to prevent cancel scope conflicts
    when multiple MCP servers are configured.
    """
    server_stacks: dict[str, AsyncExitStack] = {}

    for name, cfg in mcp_servers.items():
        try:
            stack = await connect_single_mcp_server(
                name,
                cfg,
                registry,
                reconnect,
                computer_provider=computer_provider,
                computer_model=computer_model,
                runtime_config_loader=runtime_config_loader,
                computer_provider_loader=computer_provider_loader,
                computer_permission_check=computer_permission_check,
            )
        except Exception as e:
            logger.exception("MCP server '{}' connection failed: {}", name, e)
            continue
        if stack is not None:
            server_stacks[name] = stack

    return server_stacks


def collect_mcp_tool_wrappers(registry: ToolRegistry, server_name: str) -> dict[str, MCPToolWrapper]:
    """Map a server's original tool names to their current wrappers.

    Used by reconnect callbacks so a wrapper whose transport died can find the
    replacement created by a server restart.
    """
    wrappers: dict[str, MCPToolWrapper] = {}
    for tool_name in registry.tool_names:
        tool = registry.get(tool_name)
        if isinstance(tool, MCPToolWrapper) and tool._server_name == server_name:
            wrappers[tool._original_name] = tool
    return wrappers


def list_mcp_server_tools(registry: ToolRegistry, server_name: str) -> list[dict[str, Any]]:
    """List tools registered for a given MCP server name.

    Returns a list of dicts with keys: name, description, kind (tool/resource/prompt).
    """
    prefix = (
        "computer_"
        if server_name == BUILTIN_COMPUTER_SERVER_NAME
        else f"mcp_{server_name}_"
    )
    out: list[dict[str, Any]] = []
    for tool_name in registry.tool_names:
        if not tool_name.startswith(prefix):
            continue
        tool = registry.get(tool_name)
        if tool is None:
            continue
        if not getattr(tool, "model_visible", True):
            continue
        kind = "tool"
        cls_name = type(tool).__name__
        if cls_name == "MCPResourceWrapper":
            kind = "resource"
        elif cls_name == "MCPPromptWrapper":
            kind = "prompt"
        out.append({
            "name": tool_name,
            "description": getattr(tool, "description", "") or "",
            "kind": kind,
        })
    return out
