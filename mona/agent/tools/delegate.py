"""delegate_agent tool — assign a room task to a named partner agent.

Multi-agent phase 2 (docs/design/multi-agent-development-guide.md section
7.4). Only the reserved Mona agent gets this tool (the loader strips it from
package agents even when allowlisted). The model supplies ``agent_id``,
``task`` and ``success_criteria``; trusted identity fields (``room_id``,
``requested_by``, ``workflow_run_id``) come from the ToolContext, never from
model input.
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from mona.agent.partners import (
    MONA_AGENT_ID,
    AgentRegistry,
    normalize_agent_id,
)
from mona.agent.room import RoomError, require_room, require_room_member
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import StringSchema, tool_parameters_schema

if TYPE_CHECKING:
    from mona.agent.subagent import SubagentManager


@tool_parameters(
    tool_parameters_schema(
        agent_id=StringSchema("ID of the room member agent to run the task"),
        task=StringSchema("Self-contained task for the agent to complete"),
        success_criteria=StringSchema("How to judge whether the result is acceptable"),
        required=["agent_id", "task", "success_criteria"],
    )
)
class DelegateAgentTool(Tool, ContextAware):
    """Delegate a task to a named agent in the current collaboration room."""

    def __init__(
        self,
        manager: "SubagentManager",
        tool_ctx: Any,
        registry: AgentRegistry | None = None,
    ):
        self._manager = manager
        # Shared ToolContext; AgentLoop refreshes its room identity fields at
        # the start of every request, before ``set_context`` runs.
        self._tool_ctx = tool_ctx
        self._registry = registry
        self._origin_channel: ContextVar[str] = ContextVar("delegate_origin_channel", default="cli")
        self._origin_chat_id: ContextVar[str] = ContextVar("delegate_origin_chat_id", default="direct")
        self._session_key: ContextVar[str] = ContextVar("delegate_session_key", default="cli:direct")
        self._origin_message_id: ContextVar[str | None] = ContextVar(
            "delegate_origin_message_id",
            default=None,
        )

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager, tool_ctx=ctx)

    def set_context(self, ctx: RequestContext) -> None:
        """Set the origin context for result announcements."""
        self._origin_channel.set(ctx.channel)
        self._origin_chat_id.set(ctx.chat_id)
        self._session_key.set(ctx.session_key or f"{ctx.channel}:{ctx.chat_id}")
        self._origin_message_id.set(ctx.message_id)
        # Only visible to the model inside collaboration rooms.
        self.is_available = getattr(self._tool_ctx, "room_id", None) is not None

    @property
    def name(self) -> str:
        return "delegate_agent"

    @property
    def description(self) -> str:
        return (
            "Delegate a well-defined task to a named partner agent in this "
            "collaboration room. The agent runs in the background with its own "
            "prompt, tools and memory, and reports back when done. Provide a "
            "self-contained task and explicit success criteria."
        )

    def _registry_or_default(self) -> AgentRegistry:
        if self._registry is None:
            self._registry = AgentRegistry()
        return self._registry

    async def execute(
        self,
        agent_id: str,
        task: str,
        success_criteria: str,
        **kwargs: Any,
    ) -> str:
        """Validate the delegation and hand off to the SubagentManager."""
        room_id = getattr(self._tool_ctx, "room_id", None)
        if not room_id:
            return "delegate_agent is only available inside a collaboration room."
        requested_by = getattr(self._tool_ctx, "agent_id", None) or MONA_AGENT_ID
        try:
            target = normalize_agent_id(agent_id)
        except ValueError:
            return f"Invalid agent id {agent_id!r}."
        if target == requested_by:
            return f"Cannot delegate to {target!r}: an agent cannot delegate to itself."
        if not task.strip():
            return "Cannot delegate: task must be non-empty."
        if not success_criteria.strip():
            return "Cannot delegate: success_criteria must be non-empty."

        # Re-validate room membership from the stored conversation metadata;
        # model-supplied targets are never trusted (guide 7.5).
        sessions = getattr(self._tool_ctx, "sessions", None)
        if sessions is None:
            return "delegate_agent is unavailable: no session manager in context."
        conversation = sessions.get_or_create(self._session_key.get()).conversation_metadata
        try:
            require_room(conversation)
            require_room_member(conversation, target)
        except RoomError as exc:
            return f"Cannot delegate: {exc}"

        # The target must be an installed (enabled) agent.
        registry = self._registry_or_default()
        if registry.get(target) is None:
            return f"Cannot delegate: agent {target!r} is not installed or is disabled."

        return await self._manager.delegate(
            agent_id=target,
            task=task,
            success_criteria=success_criteria,
            room_id=room_id,
            requested_by=requested_by,
            origin_channel=self._origin_channel.get(),
            origin_chat_id=self._origin_chat_id.get(),
            session_key=self._session_key.get(),
            origin_message_id=self._origin_message_id.get(),
            workflow_run_id=getattr(self._tool_ctx, "workflow_run_id", None),
            registry=registry,
        )
