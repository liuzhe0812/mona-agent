"""Bind the application's plan/goal tools to one hosted conversation."""
from __future__ import annotations

import copy
from dataclasses import dataclass, replace

from mona.agent.tools.context import RequestContext
from mona.agent.tools.long_task import CompleteGoalTool, LongTaskTool
from mona.agent.tools.task_plan import UpdatePlanTool
from mona.bus.events import InboundMessage
from mona.command.builtin import cmd_goal
from mona.command.router import CommandContext, CommandRouter
from mona.hosted_work.contracts import WorkError

_GOAL_ROUTER = CommandRouter()
_GOAL_ROUTER.exact("/goal", cmd_goal)
_GOAL_ROUTER.prefix("/goal ", cmd_goal)
_COMMAND_METADATA = {"original_command", "original_content", "goal_started_at"}


@dataclass(frozen=True)
class PlanningEntry:
    """Command projection only; the original user record remains unchanged."""

    content: str
    metadata: dict
    reply: str | None = None


def _scope(runtime_context, payload):
    session = runtime_context.session
    session_id = payload.get("session_id") or payload.get("run_id") or "direct"
    if (not isinstance(session_id, str) or session.key != "websocket:" + session_id
            or getattr(runtime_context, "session_id", session_id) != session_id
            or runtime_context.sessions.get_or_create(session.key) is not session):
        raise WorkError("session_scope", "任务计划不属于当前会话。", 403)
    return session_id


def _current_content(payload):
    history = payload.get("history") or []
    current = history[-1] if history and isinstance(history[-1], dict) else {}
    content = current.get("content") if current.get("role") == "user" else None
    return content if isinstance(content, str) else ""


async def prepare_planning_entry(runtime_context, payload) -> PlanningEntry:
    """Run the same explicit /goal handler, never infer a goal from model text.

    Call before constructing tools and use ``content`` as the current model-input
    projection. A non-None ``reply`` completes the command without a model call.
    """
    session_id = _scope(runtime_context, payload)
    raw = _current_content(payload)
    metadata = {key: value for key, value in (payload.get("metadata") or {}).items()
                if key not in _COMMAND_METADATA}
    message = InboundMessage("websocket", "user", session_id, raw, metadata=copy.deepcopy(metadata))
    command = raw.strip()
    reply = None
    if _GOAL_ROUTER.is_dispatchable_command(command):
        reply = await _GOAL_ROUTER.dispatch(CommandContext(
            msg=message, session=runtime_context.session, key=runtime_context.session.key, raw=command,
        ))
    entry = PlanningEntry(message.content, copy.deepcopy(message.metadata), reply.content if reply else None)
    runtime_context._hosted_planning_entry = (raw, entry)
    return entry


class _PlanningBus:
    def __init__(self, session_id, emit):
        self.session_id, self.emit = session_id, emit

    async def publish_outbound(self, message):
        if message.channel != "websocket" or message.chat_id != self.session_id:
            raise WorkError("session_scope", "任务状态不属于当前会话。", 403)
        events = [name for name in ("task_plan", "goal_state")
                  if message.metadata.get("_" + name + "_sync") is True]
        if len(events) != 1 or not isinstance(message.metadata.get(events[0]), dict):
            raise WorkError("invalid_event", "任务状态无法确认。", 503)
        name = events[0]
        await self.emit("desktop", {"event": name, name: copy.deepcopy(message.metadata[name])})


class _BoundContext:
    """Keep routing and the command gate local, including across concurrent tasks.

    The shared goal mixin uses a module ContextVar; returning this instance's
    validated context avoids another conversation's binding changing its gate.
    """

    def __init__(self, runtime_context, session_id, metadata, bus):
        self._session_key = runtime_context.session.key
        self._session_id = session_id
        self._metadata = copy.deepcopy(metadata)
        super().__init__(sessions=runtime_context.sessions, bus=bus)
        self.set_context(RequestContext("websocket", session_id, session_key=self._session_key))

    def set_context(self, context):
        if (context.channel != "websocket" or context.chat_id != self._session_id
                or context.session_key != self._session_key):
            raise WorkError("session_scope", "任务工具不属于当前会话。", 403)
        # Only cmd_goal can supply the internal command marker. Registry refresh
        # may add routing metadata but cannot forge or remove that authority.
        self._request_ctx = replace(context, metadata=copy.deepcopy(self._metadata))

    def _request_context(self):
        return self._request_ctx


class _UpdatePlanTool(_BoundContext, UpdatePlanTool):
    pass


class _LongTaskTool(_BoundContext, LongTaskTool):
    pass


class _CompleteGoalTool(_BoundContext, CompleteGoalTool):
    pass


def build_planning_tools(runtime_context, payload, emit) -> tuple:
    """Reuse shared lifecycle/state implementations, with account-owned storage.

    No scheduler is created. Cancelling a turn preserves a tracked goal;
    ``complete_goal`` closes it with the application's truthful recap semantics.
    """
    session_id = _scope(runtime_context, payload)
    prepared = getattr(runtime_context, "_hosted_planning_entry", None)
    metadata = prepared[1].metadata if prepared and prepared[0] == _current_content(payload) else {}
    bus = _PlanningBus(session_id, emit)
    return tuple(tool(runtime_context, session_id, metadata, bus)
                 for tool in (_UpdatePlanTool, _LongTaskTool, _CompleteGoalTool))
