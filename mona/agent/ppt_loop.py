"""PPT agent loop: focused, single-task, tool-whitelisted.

The PPT agent is a thin subclass of :class:`AgentLoop` that:
- Swaps the context builder for :class:`PPTContextBuilder` (ppt_soul.md identity,
  no memory, no history replay, only mona-ppt skill).
- Filters the tool registry to a strict whitelist (no memory_edit, no
  skill_create, no heartbeat_update, no subagent spawn, no schedule/cron).

The PPT loop does NOT consume the message bus directly. The main AgentLoop
inspects ``session.metadata.agent_kind`` at turn entry and delegates to
``PPTAgentLoop._process_message`` when the session is a PPT task. This keeps
the bus single-consumer and avoids routing ambiguity.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.agent.loop import AgentLoop
from mona.agent.ppt_context import PPTContextBuilder
from mona.agent.tools.registry import ToolRegistry

# Strict tool whitelist for the PPT agent.
# Anything not in this list is unregistered from the PPT loop's registry.
PPT_TOOLS_WHITELIST: frozenset[str] = frozenset({
    # File system (project artifacts under ppt_projects/<name>/)
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    # Shell (svg_to_pptx.py, preview server, etc.)
    "exec",
    # Web (image search + download)
    "web_search",
    "web_fetch",
    # Image generation (fallback when web_search unavailable)
    "generate_image",
    # Skill access (mona-ppt SKILL.md, scripts, references, assets)
    "skill_read",
    "skill_script_run",
    "skill_reference_read",
    "skill_asset_copy",
    # Memory read-only (PPT may need to peek at USER.md for style prefs)
    "memory_read",
})


class PPTAgentLoop(AgentLoop):
    """Agent loop variant for PPT generation tasks.

    Constructed with the same dependencies as the main loop but swaps the
    context builder and filters the tool registry to :data:`PPT_TOOLS_WHITELIST`.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # Replace the default context builder with the PPT variant.
        # PPTContextBuilder skips memory/history/bootstrap and uses ppt_soul.md.
        self.context = PPTContextBuilder(
            self.workspace,
            timezone=self.context.timezone,
            disabled_skills=None,
        )
        # Filter the tool registry to the PPT whitelist.
        self._filter_tools_to_whitelist()

    def _filter_tools_to_whitelist(self) -> None:
        """Unregister every tool not in :data:`PPT_TOOLS_WHITELIST`."""
        if not isinstance(self.tools, ToolRegistry):
            logger.warning("PPTAgentLoop.tools is not a ToolRegistry; skipping whitelist filter")
            return
        all_names = list(self.tools._tools.keys())  # noqa: SLF001 — registry has no public iterator
        removed: list[str] = []
        for name in all_names:
            if name not in PPT_TOOLS_WHITELIST:
                self.tools.unregister(name)
                removed.append(name)
        logger.info(
            "PPTAgentLoop whitelist: kept {}, removed {}",
            sorted(PPT_TOOLS_WHITELIST & set(all_names)),
            removed,
        )


__all__ = ["PPTAgentLoop", "PPT_TOOLS_WHITELIST"]
