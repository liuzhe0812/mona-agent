"""Dedicated tool for managing HEARTBEAT.md stored outside the workspace.

HEARTBEAT.md lives at ~/.mona/HEARTBEAT.md (outside workspace) for hard boundary.
Agents must use this tool instead of apply_patch/edit_file/write_file.
"""
from __future__ import annotations

from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.schema import StringSchema, tool_parameters_schema


class HeartbeatUpdateTool(Tool):
    """Update HEARTBEAT.md (stored outside workspace at ~/.mona/HEARTBEAT.md)."""

    _scopes = {"core", "subagent", "memory"}

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def name(self) -> str:
        return "heartbeat_update"

    @property
    def description(self) -> str:
        return (
            "Update HEARTBEAT.md — the periodic task list checked on the heartbeat interval. "
            "Stored outside the workspace (~/.mona/HEARTBEAT.md). "
            "Use this tool instead of apply_patch/edit_file/write_file for HEARTBEAT.md. "
            "Supports modes: 'replace' (overwrite), 'append' (add to end), 'prepend' (add to start)."
        )

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "content",
                description="New content (for replace) or text to append/prepend.",
                required=True,
            ),
            StringSchema(
                "mode",
                description="Update mode: 'replace' (default), 'append', or 'prepend'.",
                default="replace",
                enum=["replace", "append", "prepend"],
            ),
        ])

    async def execute(
        self,
        content: str | None = None,
        mode: str = "replace",
        **kwargs: Any,
    ) -> str:
        if content is None:
            return "Error: content parameter is required."
        from mona.config.paths import get_heartbeat_path
        path = get_heartbeat_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if mode in ("append", "prepend") and path.exists():
                existing = path.read_text(encoding="utf-8")
                if mode == "append":
                    if existing and not existing.endswith("\n"):
                        content = existing + "\n" + content
                    else:
                        content = existing + content
                else:  # prepend
                    if content and not content.endswith("\n"):
                        content = content + "\n" + existing
                    else:
                        content = content + existing
            path.write_text(content, encoding="utf-8")
            return f"Successfully updated HEARTBEAT.md ({len(content)} chars, mode={mode})."
        except Exception as e:
            return f"Error updating HEARTBEAT.md: {e}"
