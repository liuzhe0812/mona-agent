"""propose_workflow tool — Mona drafts a structured workflow for the room.

Multi-agent phase 3 (docs/design/multi-agent-development-guide.md sections
7.6, 9.5): "让 Mona 编排" turns a natural-language request into a validated
workflow draft. The draft is persisted via ``WorkflowStore.save_draft`` and
broadcast to room clients so the user can review it in the editor; the tool
never activates or runs the workflow — activation stays an explicit user
action.

Trusted identity (``room_id``, requesting agent) comes from the ToolContext,
never from model input. Steps missing ``depends_on`` default to a serial
chain in declaration order, matching the editor's auto-dependency model.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mona.agent.room import RoomError, require_room
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import (
    ArraySchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.workflow import (
    WorkflowStep,
    WorkflowValidationError,
)

if TYPE_CHECKING:
    from mona.agent.subagent import SubagentManager

_STEP_SCHEMA = ObjectSchema(
    properties={
        "id": StringSchema(
            "Stable step id (lowercase letters, digits, '-'/'_'). "
            "Optional: s1..sN are assigned in order when omitted."
        ),
        "type": StringSchema(
            "Step type: 'agent' runs a task, 'approval' pauses for the user",
            enum=("agent", "approval"),
        ),
        "agent_id": StringSchema("Room member agent id (agent steps only)"),
        "task": StringSchema("Self-contained task for the agent (agent steps)"),
        "expected_output": StringSchema("What the agent must produce (agent steps)"),
        "message": StringSchema("Approval prompt shown to the user (approval steps)"),
        "depends_on": ArraySchema(
            StringSchema("id of a prior step"),
            description="Ids of steps that must finish first; omitted = previous step",
        ),
    },
    description="One workflow step",
)


@tool_parameters(
    tool_parameters_schema(
        goal=StringSchema("Workflow goal, shown in the room panel"),
        steps=ArraySchema(
            _STEP_SCHEMA,
            description="Workflow steps in execution order",
            min_items=1,
        ),
        required=["goal", "steps"],
    )
)
class ProposeWorkflowTool(Tool, ContextAware):
    """Propose a structured workflow draft for the current collaboration room."""

    def __init__(self, manager: "SubagentManager", tool_ctx: Any):
        self._manager = manager
        # Shared ToolContext; AgentLoop refreshes its room identity fields at
        # the start of every request, before ``set_context`` runs.
        self._tool_ctx = tool_ctx
        self._session_key = "cli:direct"

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(manager=ctx.subagent_manager, tool_ctx=ctx)

    def set_context(self, ctx: RequestContext) -> None:
        self._session_key = ctx.session_key or f"{ctx.channel}:{ctx.chat_id}"
        # Only visible to the model inside collaboration rooms.
        self.is_available = getattr(self._tool_ctx, "room_id", None) is not None

    @property
    def name(self) -> str:
        return "propose_workflow"

    @property
    def description(self) -> str:
        return (
            "Propose a structured workflow draft for this collaboration room: "
            "an ordered list of agent tasks and human approval gates. The "
            "draft appears in the room's workflow editor for the user to "
            "review, activate and run — nothing executes automatically. Use "
            "when the user asks you to orchestrate a multi-step collaboration."
        )

    async def execute(
        self,
        goal: str,
        steps: list[dict[str, Any]],
        **kwargs: Any,
    ) -> str:
        room_id = getattr(self._tool_ctx, "room_id", None)
        if not room_id:
            return "propose_workflow is only available inside a collaboration room."
        if not isinstance(steps, list) or not steps:
            return "Cannot propose workflow: steps must be a non-empty list."

        sessions = getattr(self._tool_ctx, "sessions", None)
        if sessions is None:
            return "propose_workflow is unavailable: no session manager in context."
        conversation = sessions.get_or_create(self._session_key).conversation_metadata
        try:
            require_room(conversation)
        except RoomError as exc:
            return f"Cannot propose workflow: {exc}"

        try:
            parsed = self._parse_steps(steps)
        except WorkflowValidationError as exc:
            return f"Cannot propose workflow: {exc}"

        try:
            draft = self._manager.propose_workflow_draft(
                room_id=room_id,
                goal=goal.strip(),
                steps=parsed,
                conversation=conversation,
            )
        except WorkflowValidationError as exc:
            return f"Cannot propose workflow: {exc}"

        agent_steps = sum(1 for s in parsed if s.type == "agent")
        approval_steps = len(parsed) - agent_steps
        return (
            f"Workflow draft proposed (revision {draft.revision}): "
            f"{agent_steps} agent step(s), {approval_steps} approval step(s). "
            "It is now in the room's workflow editor as a draft — tell the "
            "user to review it there and activate it when ready. Nothing "
            "runs until the user activates and starts the workflow."
        )

    @staticmethod
    def _parse_steps(raw_steps: list[Any]) -> list[WorkflowStep]:
        """Validate raw step dicts; default ``depends_on`` to a serial chain."""
        parsed: list[WorkflowStep] = []
        used_ids: set[str] = set()
        for index, raw in enumerate(raw_steps):
            if not isinstance(raw, dict):
                raise WorkflowValidationError(f"step {index + 1} must be an object")
            data = dict(raw)
            step_id = str(data.get("id") or f"s{index + 1}").strip().lower()
            if step_id in used_ids:
                raise WorkflowValidationError(f"duplicate step id {step_id!r}")
            used_ids.add(step_id)
            data["id"] = step_id
            if data.get("depends_on") is None:
                data["depends_on"] = [parsed[-1].id] if parsed else []
            try:
                parsed.append(WorkflowStep.model_validate(data))
            except Exception as exc:
                raise WorkflowValidationError(f"step {step_id!r}: {exc}") from exc
        return parsed
