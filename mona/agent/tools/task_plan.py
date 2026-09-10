"""Structured task-plan tool with durable WebUI updates."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import ArraySchema, ObjectSchema, StringSchema
from mona.bus.events import OutboundMessage
from mona.session.task_plan import (
    ARTIFACT_TASK_STATE_KEY,
    TASK_PLAN_KEY,
    TASK_PLAN_STATUSES,
    task_plan_ws_blob,
)


class _TaskPlanMixin(ContextAware):
    def __init__(self, sessions: Any, bus: Any | None = None) -> None:
        self._sessions = sessions
        self._bus = bus
        self._request_ctx: RequestContext | None = None

    def set_context(self, ctx: RequestContext) -> None:
        self._request_ctx = ctx

    def _session(self):
        if self._request_ctx is None or not self._request_ctx.session_key:
            return None
        return self._sessions.get_or_create(self._request_ctx.session_key)

    async def _publish(self, blob: dict[str, Any]) -> None:
        rc = self._request_ctx
        if self._bus is None or rc is None or rc.channel != "websocket" or not rc.chat_id:
            return
        await self._bus.publish_outbound(OutboundMessage(
            channel="websocket",
            chat_id=rc.chat_id,
            content="",
            metadata={"_task_plan_sync": True, "task_plan": blob},
        ))


@tool_parameters(
    ObjectSchema(
        properties={
            "plan": ArraySchema(
                ObjectSchema(
                    properties={
                        "step": StringSchema("Task step text."),
                        "status": StringSchema(
                            "Step status.",
                            enum=TASK_PLAN_STATUSES,
                        ),
                    },
                    required=["step", "status"],
                    additional_properties=False,
                ),
                description="The list of steps.",
            ),
            "explanation": StringSchema("Optional explanation for this plan update."),
        },
        required=["plan"],
        additional_properties=False,
    ).to_json_schema()
)
class UpdatePlanTool(Tool, _TaskPlanMixin):
    _scopes = {"core"}

    def __init__(self, sessions: Any, bus: Any | None = None) -> None:
        _TaskPlanMixin.__init__(self, sessions, bus)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(sessions=ctx.sessions, bus=getattr(ctx, "bus", None))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return getattr(ctx, "sessions", None) is not None

    @property
    def name(self) -> str:
        return "update_plan"

    @property
    def description(self) -> str:
        return (
            "Updates the task plan.\n"
            "Provide an optional explanation and a list of plan items, each with a step and status.\n"
            "At most one step can be in_progress at a time."
        )

    async def execute(
        self,
        plan: list[dict[str, Any]],
        explanation: str | None = None,
        **kwargs: Any,
    ) -> str:
        session = self._session()
        if session is None:
            return "Error: update_plan requires an active chat session."
        in_progress = sum(1 for item in plan if item.get("status") == "in_progress")
        if in_progress > 1:
            return "Error: update_plan allows at most one in_progress step."
        current = session.metadata.get(TASK_PLAN_KEY)
        revision = current.get("revision", 0) if isinstance(current, dict) else 0
        previous_steps: dict[str, dict[str, Any]] = {}
        if isinstance(current, dict):
            for item in current.get("steps", []):
                if isinstance(item, dict) and item.get("step"):
                    previous_steps[str(item["step"])] = item
        task_state = session.metadata.get(ARTIFACT_TASK_STATE_KEY)
        task_id = task_state.get("id") if isinstance(task_state, dict) else None
        steps: list[dict[str, str]] = []
        used_ids: set[str] = set()
        for index, item in enumerate(plan):
            text = str(item.get("step") or "").strip()[:400]
            previous = previous_steps.get(text, {})
            step_id = str(previous.get("id") or f"step_{index + 1}").strip()[:80]
            while step_id in used_ids:
                step_id = f"step_{index + 1}_{len(used_ids) + 1}"
            used_ids.add(step_id)
            steps.append({
                "id": step_id,
                "step": text,
                "status": str(item.get("status") or "pending"),
            })
        stored = {
            "task_id": task_id if isinstance(task_id, str) else None,
            "revision": int(revision) + 1,
            "steps": steps,
            "explanation": (explanation or "").strip()[:800],
            "updated_at": datetime.now().isoformat(),
            "source": "ai",
        }
        session.metadata[TASK_PLAN_KEY] = stored
        self._sessions.save(session)
        blob = task_plan_ws_blob(session.metadata) or {"revision": 0, "steps": []}
        await self._publish(blob)
        return "Plan updated"
