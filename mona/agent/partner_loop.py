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

from copy import copy
from typing import Any

from loguru import logger

from mona.agent.loop import AgentLoop
from mona.agent.partners import AgentRegistry, normalize_agent_id
from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config


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
        self._user_config = load_agent_user_config(self._partner_agent_id)
        self._effective_config = resolve_effective_agent_config(definition, self._user_config)
        self.user_config_revision = self._user_config.revision
        manifest_model = (definition.model or "").strip()
        preset_name = self._effective_config.model_preset
        available_presets = kwargs.get("model_presets") or {}
        if preset_name and preset_name in available_presets:
            kwargs["model_preset"] = preset_name
        elif manifest_model and manifest_model.lower() != "inherit":
            kwargs["model"] = manifest_model
        super().__init__(**kwargs)
        self._apply_user_generation_overrides()
        from mona.agent.context import ContextBuilder

        self.context = ContextBuilder(
            self.workspace,
            timezone=self.context.timezone,
            disabled_skills=self._effective_config.disabled_skills,
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

    def _apply_user_generation_overrides(self) -> None:
        """Apply per-agent generation values without mutating Mona's provider."""
        config = self._effective_config
        if (
            config.temperature is None
            and config.max_tokens is None
            and config.reasoning_effort is None
        ):
            return
        try:
            provider = copy(self.provider)
            provider.generation = copy(self.provider.generation)
            if config.temperature is not None:
                provider.generation.temperature = config.temperature
            if config.max_tokens is not None:
                provider.generation.max_tokens = config.max_tokens
            if config.reasoning_effort is not None and hasattr(provider.generation, "reasoning_effort"):
                provider.generation.reasoning_effort = config.reasoning_effort
            self.provider = provider
            self.runner.provider = provider
            self.subagents.provider = provider
            # ``PartnerAgentLoop`` applies its override before it replaces the
            # memory helpers below; a base loop may already have one.
            if hasattr(self, "consolidator"):
                self.consolidator.provider = provider
        except Exception:
            logger.exception("Failed to apply runtime overrides for {}", self._partner_agent_id)

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

        ctx = ToolContext(
            config=self.tools_config,
            workspace=str(self.workspace),
            bus=self.bus,
            subagent_manager=self.subagents,
            sessions=self.sessions,
            image_generation_provider_configs=self._image_generation_provider_configs,
            video_generation_provider_configs=self._video_generation_provider_configs,
            timezone=self.context.timezone or "UTC",
            agent_id=self._partner_agent_id,
        )
        self._tool_ctx = ctx
        registered = ToolLoader().load(
            ctx,
            self.tools,
            scope="subagent",
            tool_allowlist=self._effective_config.allowed_tools,
        )
        logger.info(
            "PartnerAgentLoop({}) registered {} tools: {}",
            self._partner_agent_id,
            len(registered),
            registered,
        )


__all__ = ["PartnerAgentLoop"]
