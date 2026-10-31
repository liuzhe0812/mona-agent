"""Dedicated tools for accessing the current agent's memory resources.

These tools replace direct file access (read_file/write_file/edit_file/grep)
to memory files stored OUTSIDE the workspace at ~/.mona/agents/<agent_id>/memory/.
The _FsTool hard boundary prevents direct file access, so agents must use
these tools. Paths resolve per executing agent: Mona uses her own directory,
named agents use their private memory directory.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterator

from mona.agent.tools.base import Tool
from mona.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

_VALID_FILES = {"memory", "soul"}
_FILE_MAP = {
    "memory": "MEMORY.md",
    "soul": "SOUL.md",
}


def _agent_id_from_ctx(ctx: Any) -> str:
    from mona.agent.partners import MONA_AGENT_ID
    agent_id = getattr(ctx, "agent_id", None)
    if isinstance(agent_id, str) and agent_id.strip():
        return agent_id
    return MONA_AGENT_ID


def _memory_file_path(file: str, agent_id: str) -> Path:
    from mona.config.paths import get_agent_memory_dir
    if file not in _VALID_FILES:
        raise ValueError(
            f"Invalid file '{file}'. Must be one of: {sorted(_VALID_FILES)}"
        )
    return get_agent_memory_dir(agent_id) / _FILE_MAP[file]


def _history_path(agent_id: str) -> Path:
    from mona.config.paths import get_agent_memory_dir
    return get_agent_memory_dir(agent_id) / "history.jsonl"


class MemoryReadTool(Tool):
    """Read the current Agent's long-term memory or persona."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(self, agent_id: str) -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "memory_read"

    @property
    def description(self) -> str:
        return (
            "Read a memory file stored outside the workspace. "
            "Use file='memory' for MEMORY.md (long-term memory), "
            "file='soul' for SOUL.md (persona: identity, style and behavior). "
            "User preferences are provided separately by the shared user profile."
        )

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            file=StringSchema(
                description="Which memory file to read.",
                enum=sorted(_VALID_FILES),
            ),
            required=["file"],
        )

    async def read_result(self, file: str) -> dict[str, Any]:
        """Read private content without mixing an error message into the body."""
        _memory_file_path(file, self._agent_id)
        from mona.agent.agent_management import read_instruction

        return read_instruction(self._agent_id, file)

    async def execute(self, file: str | None = None, **kwargs: Any) -> str:
        if not file:
            return "Error: file parameter is required."
        try:
            path = _memory_file_path(file, self._agent_id)
        except ValueError as e:
            return f"Error: {e}"
        try:
            content = (await self.read_result(file))["content"]
        except Exception as e:
            return f"Error reading {path.name}: {e}"
        if not content.strip():
            if not path.exists():
                return f"{path.name} does not exist yet (empty)."
            return f"{path.name} is empty."
        return content


class MemoryEditTool(Tool):
    """Edit the current agent's own memory file.

    Supports two modes:
    - replace (default): replace entire file content
    - append: append content to end of file
    """

    _scopes = {"memory", "subagent"}

    def __init__(self, agent_id: str) -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "memory_edit"

    @property
    def description(self) -> str:
        return (
            "Edit your own memory file stored outside the workspace. "
            "Use mode='replace' to replace entire content (default), "
            "or mode='append' to add content to the end. "
            "file='memory' → MEMORY.md, 'soul' → SOUL.md (persona). "
            "Shared user preferences cannot be edited with this tool. All changes are "
            "saved immediately, keeping only the previous version."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            file=StringSchema(
                description="Which memory file to edit.",
                enum=sorted(_VALID_FILES),
            ),
            content=StringSchema(
                description="Content to write or append.",
            ),
            mode=StringSchema(
                description="Edit mode: 'replace' (default) or 'append'.",
                enum=["replace", "append"],
            ),
            required=["file", "content"],
        )

    async def execute(
        self,
        file: str | None = None,
        content: str | None = None,
        mode: str = "replace",
        **kwargs: Any,
    ) -> str:
        if not file:
            return "Error: file parameter is required."
        if content is None:
            return "Error: content parameter is required."
        try:
            path = _memory_file_path(file, self._agent_id)
        except ValueError as e:
            return f"Error: {e}"
        try:
            from mona.agent.agent_management import read_instruction, write_instruction

            if mode == "append":
                existing = read_instruction(self._agent_id, file)["content"]
                if existing and not existing.endswith("\n"):
                    content = existing + "\n" + content
                else:
                    content = existing + content
            write_instruction(
                self._agent_id,
                file,
                content,
                message=f"agent memory update: {path.name}",
            )
            return f"Successfully {'appended to' if mode == 'append' else 'wrote'} {path.name} ({len(content)} chars)."
        except Exception as e:
            return f"Error editing {path.name}: {e}"


class MemorySearchTool(Tool):
    """Search past events in memory/history.jsonl."""

    _scopes = {"core", "subagent", "memory"}
    _DEFAULT_LIMIT = 50
    _MAX_LIMIT = 500

    def __init__(self, agent_id: str) -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "memory_search"

    @property
    def description(self) -> str:
        return (
            "Search past events in memory/history.jsonl (append-only JSONL log). "
            "Performs case-insensitive full-text search across event messages. "
            "Returns matching entries with timestamps. "
            "Use query for keywords, dates (YYYY-MM-DD), or phrases."
        )

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            query=StringSchema(
                description="Search query (case-insensitive).",
            ),
            limit=IntegerSchema(
                self._DEFAULT_LIMIT,
                description=f"Max results (default {self._DEFAULT_LIMIT}, max {self._MAX_LIMIT}).",
                minimum=1,
                maximum=self._MAX_LIMIT,
            ),
            fixed_strings=BooleanSchema(
                description="Treat query as literal string (no regex). Default false.",
            ),
            required=["query"],
        )

    def _event_ref(self, entry: dict[str, Any]) -> str:
        canonical = json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(f"{self._agent_id}\0{canonical}".encode("utf-8")).hexdigest()
        return f"event:{digest}"

    def _history_entries(self) -> Iterator[dict[str, Any]]:
        path = _history_path(self._agent_id)
        try:
            with path.open("r", encoding="utf-8") as stream:
                for line_number, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise RuntimeError(f"Invalid history entry on line {line_number}.") from exc
                    if not isinstance(entry, dict):
                        raise RuntimeError(f"Invalid history entry on line {line_number}.")
                    yield entry
        except FileNotFoundError:
            return
        except UnicodeError as exc:
            raise RuntimeError("History log is not valid UTF-8.") from exc
        except OSError as exc:
            raise RuntimeError(f"Cannot read history log ({type(exc).__name__}).") from exc

    @staticmethod
    def _event_text(entry: dict[str, Any]) -> str:
        parts: list[str] = []
        for field in ("timestamp", "role"):
            if field in entry:
                parts.append(str(entry[field]))
        content = entry.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and "text" in part:
                    parts.append(str(part["text"]))
                elif isinstance(part, str):
                    parts.append(part)
        return " ".join(parts)

    def _search_results(
        self, query: str, limit: int, fixed_strings: bool,
    ) -> list[dict[str, Any]]:
        if not query:
            raise ValueError("query parameter is required.")
        try:
            pattern = re.compile(re.escape(query) if fixed_strings else query, re.IGNORECASE)
        except re.error as exc:
            raise ValueError(f"invalid regex query: {exc}") from exc
        limit = max(1, min(limit, self._MAX_LIMIT))
        matches: list[dict[str, Any]] = []
        for entry in self._history_entries():
            text = self._event_text(entry)
            if len(matches) < limit and pattern.search(text):
                preview = text[:500] + ("..." if len(text) > 500 else "")
                matches.append({**entry, "ref": self._event_ref(entry), "preview": preview})
        return matches

    async def search_results(
        self, query: str, limit: int, fixed_strings: bool = False,
    ) -> list[dict[str, Any]]:
        """Search real entries and return stable references for the current Agent."""
        return await asyncio.to_thread(self._search_results, query, limit, fixed_strings)

    def _read_result(self, ref: str) -> dict[str, Any]:
        if not re.fullmatch(r"event:[0-9a-f]{64}", ref):
            raise ValueError("Invalid history event reference.")
        for entry in self._history_entries():
            if self._event_ref(entry) == ref:
                return entry
        raise ValueError("History event reference is stale or unavailable.")

    async def read_result(self, ref: str) -> dict[str, Any]:
        """Read one matching entry from the current Agent's current history log."""
        return await asyncio.to_thread(self._read_result, ref)

    async def execute(
        self,
        query: str | None = None,
        limit: int = _DEFAULT_LIMIT,
        fixed_strings: bool = False,
        **kwargs: Any,
    ) -> str:
        if not query:
            return "Error: query parameter is required."
        limit = max(1, min(limit, self._MAX_LIMIT))
        history_path = _history_path(self._agent_id)
        if not history_path.exists():
            return "No history found (history.jsonl does not exist yet)."

        try:
            entries = await self.search_results(query, limit, fixed_strings)
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error searching history: {e}"

        matches: list[str] = []
        for entry in entries:
            ts = entry.get("timestamp", "?")
            role = entry.get("role", "?")
            matches.append(f"[{ts}] {role}: {entry['preview']}")
        if not matches:
            return f"No matches found for query: {query}"

        header = f"Found {len(matches)} match(es) for '{query}':\n\n"
        return header + "\n---\n".join(matches)
