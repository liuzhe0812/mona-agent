"""Dedicated tools for accessing the current agent's memory resources.

These tools replace direct file access (read_file/write_file/edit_file/grep)
to memory files stored OUTSIDE the workspace at ~/.mona/agents/<agent_id>/memory/.
The _FsTool hard boundary prevents direct file access, so agents must use
these tools. Paths resolve per executing agent: Mona uses her own directory,
named agents use their private memory directory.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

_VALID_FILES = {"memory", "soul", "user", "agents"}
_FILE_MAP = {
    "memory": "MEMORY.md",
    "soul": "SOUL.md",
    "user": "USER.md",
    "agents": "AGENTS.md",
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
    """Read a memory file (MEMORY.md / SOUL.md / USER.md / AGENTS.md)."""

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
            "file='soul' for SOUL.md (personality/style), "
            "file='user' for USER.md (user profile), "
            "file='agents' for AGENTS.md (project-specific preferences)."
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

    async def execute(self, file: str | None = None, **kwargs: Any) -> str:
        if not file:
            return "Error: file parameter is required."
        try:
            path = _memory_file_path(file, self._agent_id)
        except ValueError as e:
            return f"Error: {e}"
        if not path.exists():
            return f"{path.name} does not exist yet (empty)."
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as e:
            return f"Error reading {path.name}: {e}"
        if not content.strip():
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
            "file='memory' → MEMORY.md, 'soul' → SOUL.md, "
            "'user' → USER.md, 'agents' → AGENTS.md."
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
            path.parent.mkdir(parents=True, exist_ok=True)
            if mode == "append" and path.exists():
                existing = path.read_text(encoding="utf-8")
                if existing and not existing.endswith("\n"):
                    content = existing + "\n" + content
                else:
                    content = existing + content
            path.write_text(content, encoding="utf-8")
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

        import re

        try:
            pattern = re.compile(re.escape(query), re.IGNORECASE) if fixed_strings else re.compile(query, re.IGNORECASE)
        except re.error as e:
            return f"Error: invalid regex query: {e}"

        matches: list[str] = []
        try:
            with history_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # Search in message content
                    text_parts = []
                    if "timestamp" in entry:
                        text_parts.append(str(entry["timestamp"]))
                    if "role" in entry:
                        text_parts.append(str(entry["role"]))
                    if "content" in entry:
                        content = entry["content"]
                        if isinstance(content, str):
                            text_parts.append(content)
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict):
                                    if "text" in part:
                                        text_parts.append(str(part["text"]))
                                elif isinstance(part, str):
                                    text_parts.append(part)
                    blob = " ".join(text_parts)
                    if pattern.search(blob):
                        ts = entry.get("timestamp", "?")
                        role = entry.get("role", "?")
                        # Truncate long content for display
                        display = blob[:500] + ("..." if len(blob) > 500 else "")
                        matches.append(f"[{ts}] {role}: {display}")
                        if len(matches) >= limit:
                            break
        except Exception as e:
            return f"Error searching history: {e}"

        if not matches:
            return f"No matches found for query: {query}"

        header = f"Found {len(matches)} match(es) for '{query}':\n\n"
        return header + "\n---\n".join(matches)
