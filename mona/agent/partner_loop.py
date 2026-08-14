"""Partner agent loop: direct-chat execution under a partner agent identity.

When a session's conversation metadata declares ``direct_agent_id`` other than
Mona, the main AgentLoop delegates to PartnerAgentLoop (same pattern as
DocumentAgentLoop) so the partner agent itself executes the turn:

- ``ContextBuilder`` resolves the agent's package prompt, private memory and
  private + package skills (multi-agent guide 7.2).
- The tool registry is rebuilt with the manifest allowlist intersected with
  the platform-safe ``subagent`` scope table, and every tool is constructed
  with ``ToolContext.agent_id`` set to the partner — memory/skill tools
  therefore read and write the agent's private directories.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.agent.loop import AgentLoop
from mona.agent.partners import AgentRegistry, normalize_agent_id


class PartnerAgentLoop(AgentLoop):
    """Agent loop variant for partner agents in direct chats.

    Shares the main loop's provider/sessions/bus but executes under the
    partner agent's identity with a filtered tool registry.
    """

    def __init__(
        self,
        *,
        agent_id: str,
        registry: AgentRegistry | None = None,
        **kwargs: Any,
    ) -> None:
        # Set before super().__init__: _register_default_tools runs inside the
        # base constructor and needs the partner identity + manifest.
        self._partner_agent_id = normalize_agent_id(agent_id)
        self._agent_registry = registry or AgentRegistry()
        # Manifest model: "inherit" follows the main loop's current model;
        # any other value pins this partner to its own model for every turn
        # (LLMRuntime reads ``self.model`` per call).
        definition = self._agent_registry.require(self._partner_agent_id)
        manifest_model = (definition.model or "").strip()
        if manifest_model and manifest_model.lower() != "inherit":
            kwargs["model"] = manifest_model
        super().__init__(**kwargs)
        from mona.agent.context import ContextBuilder

        self.context = ContextBuilder(
            self.workspace,
            timezone=self.context.timezone,
            disabled_skills=None,
            agent_id=self._partner_agent_id,
            agent_registry=self._agent_registry,
        )
        # Re-bind memory-dependent helpers so consolidation / dreaming
        # operate on the partner's private store, not Mona's.
        from mona.agent.autocompact import AutoCompact
        from mona.agent.memory import Consolidator, Dream

        self.consolidator = Consolidator(
            store=self.context.memory,
            provider=self.provider,
            model=self.model,
            sessions=self.sessions,
            context_window_tokens=self.context_window_tokens,
            build_messages=self.context.build_messages,
            get_tool_definitions=self.tools.get_definitions,
            max_completion_tokens=self.provider.generation.max_tokens,
            consolidation_ratio=kwargs.get("consolidation_ratio", 0.5),
        )
        self.auto_compact = AutoCompact(
            sessions=self.sessions,
            consolidator=self.consolidator,
            session_ttl_minutes=kwargs.get("session_ttl_minutes", 0),
        )
        self.dream = Dream(
            store=self.context.memory,
            provider=self.provider,
            model=self.model,
        )

    @property
    def partner_agent_id(self) -> str:
        return self._partner_agent_id

    def _register_default_tools(self) -> None:
        """Build the partner tool registry from the manifest allowlist.

        Replaces the base implementation entirely: the allowlist is
        intersected with the platform-safe ``subagent`` scope (Mona-only tools
        can never leak in, loader guarantee), and tools capture the partner
        ``agent_id`` at construction time.
        """
        from mona.agent.tools.context import ToolContext
        from mona.agent.tools.loader import ToolLoader

        definition = self._agent_registry.require(self._partner_agent_id)
        ctx = ToolContext(
            config=self.tools_config,
            workspace=str(self.workspace),
            bus=self.bus,
            subagent_manager=self.subagents,
            sessions=self.sessions,
            timezone=self.context.timezone or "UTC",
            agent_id=self._partner_agent_id,
        )
        self._tool_ctx = ctx
        registered = ToolLoader().load(
            ctx,
            self.tools,
            scope="subagent",
            tool_allowlist=definition.tool_allowlist,
        )
        logger.info(
            "PartnerAgentLoop({}) registered {} tools: {}",
            self._partner_agent_id,
            len(registered),
            registered,
        )


__all__ = ["PartnerAgentLoop"]
