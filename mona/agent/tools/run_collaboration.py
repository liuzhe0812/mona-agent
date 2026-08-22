"""Run a one-shot natural-language collaboration in a room.

This tool is intentionally different from ``propose_workflow``: it starts
the transient execution immediately and never writes a workflow draft or
changes the room's active workflow.  Only Mona receives it; direct ``@``
routing is handled by the router and never invokes this tool implicitly.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mona.agent.partners import AgentRegistry
from mona.agent.room import RoomError, require_room, require_room_member
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import (
    PARTNER_JOBS_DISPATCHED_META,
    ContextAware,
    RequestContext,
)
from mona.agent.tools.schema import (
    ArraySchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.workflow import RunConflictError, WorkflowValidationError

if TYPE_CHECKING:
    from mona.agent.subagent import SubagentManager


_STEP_SCHEMA = ObjectSchema(
    properties={
        "id": StringSchema(
            "Optional stable step id (defaults to s1..sN in declaration order)"
        ),
        "agent_id": StringSchema("Room member agent id"),
        "task": StringSchema("Self-contained task for this agent"),
        "expected_output": StringSchema("What the agent must produce"),
        "depends_on": ArraySchema(
            StringSchema("Step id that must finish first"),
            description=(
                "Optional predecessor step ids; omitted follows the prior step, "
                "while an explicit empty list means parallel"
            ),
        ),
    },
    required=["agent_id", "task", "expected_output"],
    description="One agent step in this one-time collaboration",
)


@tool_parameters(
    tool_parameters_schema(
        goal=StringSchema("The immediate result the room should produce"),
        steps=ArraySchema(
            _STEP_SCHEMA,
            description=(
                "One to eight agent steps. Use depends_on for serial work, "
                "review, or a final summary step."
            ),
            min_items=1,
            max_items=8,
        ),
        required=["goal", "steps"],
    )
)
class RunCollaborationTool(Tool, ContextAware):
    """Start a transient collaboration run for the current room."""

    def __init__(self, manager: "SubagentManager", tool_ctx: Any):
        self._manager = manager
        self._tool_ctx = tool_ctx
        self._session_key = "cli:direct"

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager, tool_ctx=ctx)

    def set_context(self, ctx: RequestContext) -> None:
        self._session_key = ctx.session_key or f"{ctx.channel}:{ctx.chat_id}"
        metadata = ctx.metadata if isinstance(ctx.metadata, dict) else {}
        dispatched = metadata.get(PARTNER_JOBS_DISPATCHED_META)
        # The router owns this hint.  A direct multi-@ turn has already
        # created the partner jobs, so an LLM-generated orchestration call in
        # that same turn would duplicate them.  Context is refreshed every
        # request, so this naturally restores availability on the next turn.
        self.is_available = (
            getattr(self._tool_ctx, "agent_id", "mona") == "mona"
            and getattr(self._tool_ctx, "room_id", None) is not None
            and not self._has_dispatched_partners(dispatched)
        )

    @staticmethod
    def _has_dispatched_partners(value: Any) -> bool:
        return isinstance(value, (list, tuple, set, frozenset)) and any(
            isinstance(item, str) and item.strip() and item.strip().lower() != "mona"
            for item in value
        )

    @property
    def name(self) -> str:
        return "run_collaboration"

    @property
    def description(self) -> str:
        return (
            "Immediately run a one-time collaboration for this room. Use this "
            "when the user asks in natural language to do work in parallel, "
            "先后执行, have one agent review another, or have Mona summarize "
            "the results. The run is transient and starts now; it does not "
            "create or activate a reusable workflow. Use propose_workflow "
            "instead for reusable or scheduled processes. Ordinary @ mentions "
            "are routed directly and must not trigger this tool."
        )

    async def execute(
        self,
        goal: str,
        steps: list[dict[str, Any]],
        **kwargs: Any,
    ) -> str:
        room_id = getattr(self._tool_ctx, "room_id", None)
        if not room_id:
            return "run_collaboration is only available inside a collaboration room."
        if not self.is_available:
            return "run_collaboration is unavailable for this turn."
        if not isinstance(goal, str) or not goal.strip():
            return "Cannot run collaboration: goal must be non-empty."
        if not isinstance(steps, list) or not 1 <= len(steps) <= 8:
            return "Cannot run collaboration: steps must contain 1 to 8 agent steps."

        sessions = getattr(self._tool_ctx, "sessions", None)
        if sessions is None:
            return "run_collaboration is unavailable: no session manager in context."
        try:
            conversation = sessions.get_or_create(self._session_key).conversation_metadata
            require_room(conversation)
        except RoomError as exc:
            return f"Cannot run collaboration: {exc}"

        registry = AgentRegistry()
        from mona.agent.user_config import load_agent_user_config

        for index, raw in enumerate(steps, start=1):
            if not isinstance(raw, dict):
                return f"Cannot run collaboration: step {index} must be an object."
            if raw.get("type", "agent") != "agent":
                return f"Cannot run collaboration: step {index} must be an agent step."
            raw_agent_id = raw.get("agent_id")
            if not isinstance(raw_agent_id, str) or not raw_agent_id.strip():
                return f"Cannot run collaboration: step {index} agent_id must be non-empty."
            try:
                target = require_room_member(conversation, raw_agent_id)
            except (RoomError, TypeError, ValueError) as exc:
                return f"Cannot run collaboration: step {index}: {exc}"
            if registry.get(target) is None:
                return (
                    f"Cannot run collaboration: step {index}: agent {target!r} "
                    "is not installed or is disabled."
                )
            if not load_agent_user_config(target).enabled:
                return f"Cannot run collaboration: step {index}: agent {target!r} is disabled."
            task = raw.get("task")
            expected = raw.get("expected_output")
            if not isinstance(task, str) or not task.strip():
                return f"Cannot run collaboration: step {index} task must be non-empty."
            if not isinstance(expected, str) or not expected.strip():
                return (
                    f"Cannot run collaboration: step {index} expected_output "
                    "must be non-empty."
                )

        try:
            launch_id = await self._manager.launch_collaboration(
                room_id=room_id,
                goal=goal.strip(),
                steps=steps,
                conversation=conversation,
                registry=registry,
                started_by="mona",
            )
        except (RunConflictError, WorkflowValidationError, ValueError) as exc:
            return f"Cannot run collaboration: {exc}"
        return (
            f"Collaboration started ({launch_id}). The room will show each "
            "agent's progress and final result as it completes."
        )
