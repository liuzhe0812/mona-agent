"""Async client wrapper around the OfficeCLI binary.

OfficeCLI (https://github.com/iOfficeAI/OfficeCLI) is a CLI tool that can
inspect, query, and modify Office documents (.docx, .xlsx, .pptx) via a
schema-driven command set. This module wraps the binary in an async API
so the agent tool and HTTP handlers can call it without blocking the
event loop.

Key design points:
- All commands run with ``--json`` so the output is parseable.
- Each call is a short-lived subprocess; we do NOT keep a resident
  ``open`` process across calls (simpler, avoids orphans). The trade-off
  is slower throughput for rapid multi-edit sessions, which is acceptable
  for the "AI proposes, user confirms" flow.
- File paths are validated to stay inside the workspace before being
  passed to the binary (defense-in-depth on top of OfficeCLI's own
  path handling).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.tools.path_utils import resolve_workspace_path
from mona.api.officecli_runtime import OfficeCliRuntime

__all__ = ("OfficeCliClient", "OfficeCliError", "OfficeCliResult")

# Subcommands exposed by ``officecli`` (from ``officecli --help``).
_VALID_COMMANDS = frozenset({
    "open", "close", "save", "watch", "unwatch",
    "view", "get", "query", "set", "add", "remove", "move", "swap",
    "refresh", "raw", "raw-set", "add-part", "validate",
    "batch", "dump", "import", "create", "merge",
})


class OfficeCliError(Exception):
    """Raised when OfficeCLI fails (non-zero exit, timeout, parse error)."""


class OfficeCliResult:
    """Parsed result of an OfficeCLI command."""

    __slots__ = ("ok", "exit_code", "stdout", "stderr", "json")

    def __init__(self, ok: bool, exit_code: int, stdout: str, stderr: str, parsed: Any) -> None:
        self.ok = ok
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr
        self.json = parsed

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "json": self.json,
        }


class OfficeCliClient:
    """Async wrapper around the OfficeCLI binary.

    Each instance caches the resolved binary path so repeated calls do not
    re-scan the filesystem. Instances are cheap to create; there is no
    persistent connection state.
    """

    def __init__(
        self,
        *,
        workspace: Path | str | None = None,
        exe_path: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._workspace = Path(workspace).expanduser() if workspace else None
        self._timeout = timeout
        if exe_path:
            self._exe = exe_path
        else:
            runtime = OfficeCliRuntime()
            self._exe = runtime.get_officecli_path() or ""

    @property
    def available(self) -> bool:
        return bool(self._exe) and Path(self._exe).is_file()

    def _resolve_workspace(self) -> Path:
        if self._workspace is not None:
            return self._workspace
        from mona.config.paths import get_workspace_path
        return get_workspace_path()

    def _resolve_path(self, file_path: str) -> Path:
        """Resolve a user-supplied path against the workspace and verify it stays inside."""
        ws = self._resolve_workspace()
        try:
            resolved = resolve_workspace_path(file_path, ws, ws)
        except (OSError, PermissionError, ValueError) as e:
            raise OfficeCliError(f"path not allowed: {e}") from e
        return resolved

    async def run(
        self,
        command: str,
        file_path: str | None = None,
        *,
        args: list[str] | None = None,
        stdin_json: Any = None,
        timeout: float | None = None,
    ) -> OfficeCliResult:
        """Run a single OfficeCLI subcommand.

        Args:
            command: The subcommand verb (e.g. ``"get"``, ``"query"``, ``"batch"``).
            file_path: The document path. Resolved against the workspace and
                passed as the first positional argument when not None.
            args: Extra positional/flag arguments appended after the file path.
            stdin_json: If not None, serialized to JSON and piped to stdin.
            timeout: Override the default timeout (seconds).
        """
        if not self.available:
            raise OfficeCliError("officecli binary not found")
        if command not in _VALID_COMMANDS:
            raise OfficeCliError(f"unknown officecli command: {command}")

        cmd: list[str] = [self._exe, command, "--json"]
        if file_path is not None:
            resolved = self._resolve_path(file_path)
            cmd.append(str(resolved))
        if args:
            cmd.extend(args)

        stdin_data: bytes | None = None
        if stdin_json is not None:
            stdin_data = json.dumps(stdin_json).encode("utf-8")

        logger.debug("officecli run: {}", " ".join(cmd))
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=0x08000000 if sys.platform == "win32" else 0,
            )
        except FileNotFoundError as e:
            raise OfficeCliError(f"officecli binary not found: {e}") from e

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(input=stdin_data),
                timeout=timeout or self._timeout,
            )
        except asyncio.TimeoutExpired:
            proc.kill()
            await proc.wait()
            raise OfficeCliError(f"officecli {command} timed out after {timeout or self._timeout}s")

        stdout = stdout_b.decode("utf-8", errors="replace") if stdout_b else ""
        stderr = stderr_b.decode("utf-8", errors="replace") if stderr_b else ""
        exit_code = proc.returncode or 0

        parsed: Any = None
        if stdout.strip():
            try:
                parsed = json.loads(stdout)
            except json.JSONDecodeError:
                pass

        ok = exit_code == 0
        if not ok and stderr:
            logger.warning("officecli {} failed (exit {}): {}", command, exit_code, stderr.strip())

        return OfficeCliResult(ok=ok, exit_code=exit_code, stdout=stdout, stderr=stderr, parsed=parsed)

    async def inspect(self, file_path: str) -> OfficeCliResult:
        """Get the document structure tree (``officecli get <file> /``)."""
        return await self.run("get", file_path, args=["/"])

    async def query(self, file_path: str, selector: str) -> OfficeCliResult:
        """Query elements with a CSS-like selector."""
        return await self.run("query", file_path, args=[selector])

    async def view(self, file_path: str, mode: str = "outline") -> OfficeCliResult:
        """View the document in a given mode (outline/content/raw)."""
        return await self.run("view", file_path, args=[mode])

    async def validate(self, file_path: str) -> OfficeCliResult:
        """Validate the document against the OpenXML schema."""
        return await self.run("validate", file_path)

    async def batch(
        self,
        file_path: str,
        commands: list[dict[str, Any]],
    ) -> OfficeCliResult:
        """Execute multiple commands atomically in a single pass.

        Each item is an object whose ``"command"`` is the bare verb; the
        verb's arguments are sibling fields. See ``officecli help batch``.
        """
        return await self.run("batch", file_path, stdin_json=commands)

    async def get_node(self, file_path: str, path: str) -> OfficeCliResult:
        """Get a specific document node by path (e.g. ``/body/p[1]``)."""
        return await self.run("get", file_path, args=[path])
