"""Sustained goal tools on the main agent (Codex-style).

Follow the built-in **long-goal** skill for lifecycle rules and how to phrase
objectives (especially **idempotent**, compaction-safe goals). Load that skill
from the skills listing (path shown there) before composing ``long_task.goal`` text.

``long_task`` is exposed only for an explicit user ``/goal`` turn and registers that
objective on the session (JSON-serializable metadata).
Active objectives are mirrored each turn into the Runtime Context block (see
``mona.session.goal_state.goal_state_runtime_lines``) so compaction cannot hide them.
Work proceeds in ordinary agent turns (same runner, compaction as configured).
Call ``complete_goal`` when the sustained objective should stop being tracked:
finished successfully, or cancelled / superseded / redirected—in every case the recap should match reality.

There is **no** sub-agent orchestrator and **no** special WebSocket ``agent_ui`` stream.
"""

from __future__ import annotations

from contextvars import ContextVar
from datetime import datetime
from typing import TYPE_CHECKING, Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import StringSchema, tool_parameters_schema
from mona.bus.events import OutboundMessage
from mona.session.goal_state import (
    GOAL_COMMAND_SOURCE,
    GOAL_STATE_KEY,
    discard_legacy_goal_state_key,
    goal_state_raw,
    goal_state_ws_blob,
    parse_goal_state,
    sustained_goal_active,
)

if TYPE_CHECKING:
    from mona.session.manager import SessionManager


_GOAL_REQUEST_CONTEXT: ContextVar[RequestContext | None] = ContextVar(
    "mona_goal_request_context",
    default=None,
)


def _iso_now() -> str:
    return datetime.now().isoformat()


class _GoalToolsMixin(ContextAware):
    """Shared routing context + Session lookup."""

    def __init__(self, sessions: SessionManager, bus: Any | None = None) -> None:
        self._sessions = sessions
        self._bus = bus

    def set_context(self, ctx: RequestContext) -> None:
        _GOAL_REQUEST_CONTEXT.set(ctx)

    @staticmethod
    def _request_context() -> RequestContext | None:
        return _GOAL_REQUEST_CONTEXT.get()

    def _session(self):
        request_ctx = self._request_context()
        if request_ctx is None:
            return None
        key = request_ctx.session_key
        if not key:
            return None
        return self._sessions.get_or_create(key)

    async def _publish_goal_state_ws(self, metadata: dict[str, Any]) -> None:
        """Fan-out authoritative goal snapshot for this WebSocket chat only."""
        bus = self._bus
        rc = self._request_context()
        if bus is None or rc is None or rc.channel != "websocket":
            return
        cid = (rc.chat_id or "").strip()
        if not cid:
            return
        await bus.publish_outbound(
            OutboundMessage(
                channel="websocket",
                chat_id=cid,
                content="",
                metadata={
                    "_goal_state_sync": True,
                    "goal_state": goal_state_ws_blob(metadata),
                },
            ),
        )


@tool_parameters(
    tool_parameters_schema(
        goal=StringSchema(
            "Sustained objective from the user's current /goal command. First read the built-in "
            "**long-goal** skill, especially its Start fast section, then call this promptly. "
            "The goal must still be idempotent, self-contained, bounded, and explicit about done-ness; "
            "do not delay this tool call to over-plan, research, or decide execution details.",
            max_length=12_000,
        ),
        ui_summary=StringSchema(
            "Optional one-line label for session lists / logs (≤120 chars).",
            max_length=120,
            nullable=True,
        ),
        required=["goal"],
    )
)
class LongTaskTool(Tool, _GoalToolsMixin):
    """Begin or replace focus on a long-running objective stored on the session."""

    _scopes = {"core", "subagent"}
    system_managed = True

    def __init__(self, sessions: Any, bus: Any | None = None) -> None:
        _GoalToolsMixin.__init__(self, sessions, bus)

    def set_context(self, ctx: RequestContext) -> None:
        _GoalToolsMixin.set_context(self, ctx)

    @property
    def is_available(self) -> bool:
        return self.available_in_context()

    def available_in_context(self) -> bool:
        ctx = self._request_context()
        return bool(
            ctx and ctx.metadata.get("original_command") == GOAL_COMMAND_SOURCE
        )

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        sess = getattr(ctx, "sessions", None)
        assert sess is not None  # guarded by enabled()
        return cls(sessions=sess, bus=getattr(ctx, "bus", None))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return getattr(ctx, "sessions", None) is not None

    @property
    def name(self) -> str:
        return "long_task"

    @property
    def description(self) -> str:
        return (
            "Record the sustained goal requested by the user's current /goal command. "
            "First read the built-in **long-goal** skill, especially its Start fast section; then call this "
            "as soon as the command's intent is clear. Write a good idempotent goal, but do not delay the tool "
            "call with long planning, research, or execution-detail thinking. "
            "The active goal is mirrored in Runtime Context each turn. Use normal tools until done, then call "
            "complete_goal when the objective is satisfied, cancelled, or replaced. "
            "If a goal is already active, finish it or call complete_goal before registering another."
        )

    async def execute(self, goal: str, ui_summary: str | None = None, **kwargs: Any) -> str:
        if not self.is_available:
            return "Error: long_task can only be started by the user's explicit /goal command."
        sess = self._session()
        if sess is None:
            return (
                "Error: long_task requires an active chat session (missing routing context)."
            )
        if sustained_goal_active(sess.metadata):
            return (
                "Error: a sustained goal is already active. "
                "Use complete_goal when finished, or ask the user before replacing it."
            )

        summary = (ui_summary or "").strip()[:120]
        blob = {
            "status": "active",
            "source": GOAL_COMMAND_SOURCE,
            "objective": goal.strip(),
            "ui_summary": summary,
            "started_at": _iso_now(),
        }
        sess.metadata[GOAL_STATE_KEY] = blob
        discard_legacy_goal_state_key(sess.metadata)
        self._sessions.save(sess)
        await self._publish_goal_state_ws(sess.metadata)
        extra = f"\nSummary line: {summary}" if summary else ""
        return (
            "Goal recorded. Keep working toward the objective using ordinary tools. "
            "When fully done (verified against what was asked), call complete_goal with a "
            f"short recap.{extra}"
        )


@tool_parameters(
    tool_parameters_schema(
        recap=StringSchema(
            "Brief recap for the user (plain text). When the goal succeeded, confirm outcomes; "
            "if the user cancelled, pivoted, or replaced the objective, say so honestly.",
            max_length=8000,
            nullable=True,
        ),
        required=[],
    )
)
class CompleteGoalTool(Tool, _GoalToolsMixin):
    """Mark the active sustained goal finished after all required work is verified."""

    _scopes = {"core", "subagent"}
    system_managed = True

    def __init__(self, sessions: Any, bus: Any | None = None) -> None:
        _GoalToolsMixin.__init__(self, sessions, bus)

    def set_context(self, ctx: RequestContext) -> None:
        _GoalToolsMixin.set_context(self, ctx)

    @property
    def is_available(self) -> bool:
        return self.available_in_context()

    def available_in_context(self) -> bool:
        ctx = self._request_context()
        if ctx is None:
            return False
        session = self._session()
        return bool(
            ctx.metadata.get("original_command") == GOAL_COMMAND_SOURCE
            or (session is not None and sustained_goal_active(session.metadata))
        )

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        sess = getattr(ctx, "sessions", None)
        assert sess is not None
        return cls(sessions=sess, bus=getattr(ctx, "bus", None))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return getattr(ctx, "sessions", None) is not None

    @property
    def name(self) -> str:
        return "complete_goal"

    @property
    def description(self) -> str:
        return (
            "End bookkeeping for the active sustained goal. "
            "Use when the objective is fully achieved and verified—recap what was delivered. "
            "Also call when the user cancels, redirects, or replaces the goal: recap must reflect "
            "what actually happened (not necessarily success). "
            "If no goal is active, the tool reports that and leaves metadata unchanged."
        )

    async def execute(self, recap: str | None = None, **kwargs: Any) -> str:
        sess = self._session()
        if sess is None:
            return "Error: complete_goal requires an active chat session."
        prior = parse_goal_state(goal_state_raw(sess.metadata))
        if not isinstance(prior, dict) or prior.get("status") != "active":
            return "No active goal to complete."

        ended = _iso_now()
        sess.metadata[GOAL_STATE_KEY] = {
            **prior,
            "status": "completed",
            "completed_at": ended,
            "recap": (recap or "").strip(),
        }
        discard_legacy_goal_state_key(sess.metadata)
        self._sessions.save(sess)
        await self._publish_goal_state_ws(sess.metadata)
        tail = (recap or "").strip()
        if tail:
            return f"Goal marked complete ({ended}). Recap:\n{tail}"
        return f"Goal marked complete ({ended})."
