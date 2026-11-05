"""Use the shared subagent lifecycle with approved hosted execution inputs."""
from __future__ import annotations

import asyncio
import copy
import inspect
from pathlib import Path

from mona.agent.runner import AgentRunSpec
from mona.agent.subagent import SubagentManager
from mona.agent.tools.context import RequestContext
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.spawn import SpawnTool
from mona.hosted_work.contracts import WorkError

_PARENT_TOOLS = frozenset({
    "ask_user_question", "long_task", "complete_goal", "update_plan", "spawn",
    "delegate_agent", "propose_workflow", "run_collaboration",
})


class _ResultBus:
    def __init__(self, runtime, on_result):
        self.runtime, self.on_result = runtime, on_result
        self.delivery_failed = False

    async def publish_inbound(self, message):
        runtime, metadata = self.runtime, message.metadata
        task_id = metadata.get("subagent_task_id")
        if (message.channel != "system" or message.sender_id != "subagent"
                or message.chat_id != runtime.session_key
                or message.session_key_override != runtime.session_key
                or metadata.get("injected_event") != "subagent_result"
                or not isinstance(task_id, str) or task_id not in runtime.manager._task_statuses
                or metadata.get("origin_message_id") != runtime.run_id
                or set(metadata) - {"injected_event", "subagent_task_id", "origin_message_id"}):
            self.delivery_failed = True
            raise WorkError("subagent_scope", "子任务结果不属于当前会话。", 403)
        try:
            await self.on_result(copy.deepcopy(message))
        except Exception:
            self.delivery_failed = True
            raise
        return True

    async def publish_outbound(self, message):
        self.delivery_failed = True
        raise WorkError("invalid_event", "子任务状态无法确认。", 503)


class _BoundSpawnTool(SpawnTool):
    def __init__(self, runtime):
        self.runtime = runtime
        super().__init__(runtime.manager)
        self.set_context(RequestContext("websocket", runtime.session_id,
                                        message_id=runtime.run_id, session_key=runtime.session_key))

    def set_context(self, context):
        runtime = self.runtime
        if (context.channel != "websocket" or context.chat_id != runtime.session_id
                or context.session_key != runtime.session_key):
            raise WorkError("session_scope", "子任务工具不属于当前会话。", 403)
        super().set_context(RequestContext("websocket", runtime.session_id,
                                           message_id=runtime.run_id, session_key=runtime.session_key))

    async def execute(self, task, label=None, **kwargs):
        if self.runtime.closed:
            return "Error: 本轮已结束，不能再创建子任务。"
        return await super().execute(task, label, **kwargs)


class HostedSubagents:
    """One parent conversation; no registry discovery, private stores or scheduler.

    ``spawn_spec_factory`` supplies approved tools and the existing shared
    prompt/context. It must retain the supplied hook/checkpoint callback and
    configure the same hosted model limits and authorization as the parent.
    ``on_result`` optionally observes/persists the shared notice. Results are
    queued internally for the parent Runner; the observer must not start a new
    turn or enqueue the same notice into a second injection source.
    """

    def __init__(self, runtime_context, payload, provider, spawn_spec_factory, on_result):
        self.session_id = payload.get("session_id") or payload.get("run_id") or "direct"
        self.session_key, self.run_id = runtime_context.session.key, payload.get("run_id")
        if (not isinstance(self.session_id, str) or self.session_key != "websocket:" + self.session_id
                or getattr(runtime_context, "session_id", self.session_id) != self.session_id
                or runtime_context.sessions.get_or_create(self.session_key) is not runtime_context.session):
            raise WorkError("session_scope", "子任务不属于当前会话。", 403)
        self.closed = False
        self._results = asyncio.Queue()

        async def receive_result(message):
            if on_result is not None:
                await on_result(message)
            self._results.put_nowait(message)

        self.bus = _ResultBus(self, receive_result)

        async def build_spec(task_id, task, origin, hook, checkpoint):
            if (origin.get("channel") != "websocket" or origin.get("chat_id") != self.session_id
                    or origin.get("session_key") != self.session_key):
                raise WorkError("session_scope", "子任务不属于当前会话。", 403)
            spec = await spawn_spec_factory(task_id, task, origin, hook, checkpoint)
            if (not isinstance(spec, AgentRunSpec) or not isinstance(spec.tools, ToolRegistry)
                    or spec.session_key != self.session_key or _PARENT_TOOLS.intersection(spec.tools.tool_names)
                    or spec.model != runtime_context.selection.model):
                raise WorkError("subagent_scope", "子任务运行配置不属于当前会话。", 403)
            return spec

        self.manager = SubagentManager(
            provider=provider, workspace=Path("/workspace"), bus=self.bus,
            model=runtime_context.selection.model, max_iterations=runtime_context.config.max_iterations,
            max_tool_result_chars=100_000, session_manager=runtime_context.sessions,
            run_spec_factory=build_spec,
        )
        self.spawn_tool = _BoundSpawnTool(self)

    @property
    def pending_result_count(self):
        return self._results.qsize()

    async def injection_callback(self, *, limit=3, phase=""):
        """Continue the same Runner after a tentative final response.

        Tool boundaries only drain ready results, so the parent can keep
        working. At its final boundary, wait on the shared manager's existing
        tasks before allowing the Runner to end this turn.
        """
        if limit <= 0:
            return []
        if self.bus.delivery_failed:
            raise WorkError("subagent_result", "子任务结果无法确认，已有进度已保留。", 503)
        if phase == "after final response" and self._results.empty() and not self.closed:
            await self.wait()
        if self.bus.delivery_failed:
            raise WorkError("subagent_result", "子任务结果无法确认，已有进度已保留。", 503)
        messages = []
        while len(messages) < limit:
            try:
                message = self._results.get_nowait()
            except asyncio.QueueEmpty:
                break
            messages.append({"role": "user", "content": message.content, "source_kind": "runtime"})
        return messages

    def compose_injections(self, existing=None):
        """Prefer real user follow-ups and keep them separate from runtime results."""
        if existing is None:
            return self.injection_callback
        parameters = inspect.signature(existing).parameters
        variadic = any(item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values())

        async def combined(*, limit=3, phase=""):
            if self.bus.delivery_failed:
                raise WorkError("subagent_result", "子任务结果无法确认，已有进度已保留。", 503)
            kwargs = {name: value for name, value in {"limit": limit, "phase": phase}.items()
                      if variadic or name in parameters}
            messages = await existing(**kwargs)
            if messages:
                # The ordinary Work merge combines adjacent user messages.
                # Deliver each source separately so a child result can never
                # inherit a user-input authority marker from that merge.
                return messages
            return await self.injection_callback(limit=limit, phase=phase)

        return combined

    async def wait(self):
        """Wait on the manager's actual tasks; never start or replay work."""
        tasks = tuple(self.manager._running_tasks.values())
        results = await asyncio.gather(*tasks, return_exceptions=True)
        if self.bus.delivery_failed or any(isinstance(result, BaseException) for result in results):
            raise WorkError("subagent_result", "子任务结果无法确认，已有进度已保留。", 503)

    async def close(self):
        """Stop this conversation through the shared lifecycle and verify exit."""
        self.closed = True
        await self.manager.cancel_by_session(self.session_key)
        if any(not task.done() for task in self.manager._running_tasks.values()):
            raise WorkError("subagent_cleanup", "子任务尚未确认停止，请保留已有进度并核对结果。", 503)
        if self.bus.delivery_failed:
            raise WorkError("subagent_result", "子任务结果无法确认，已有进度已保留。", 503)


def build_subagent_runtime(runtime_context, payload, provider, spawn_spec_factory, *, on_result=None) -> HostedSubagents:
    return HostedSubagents(runtime_context, payload, provider, spawn_spec_factory, on_result)
