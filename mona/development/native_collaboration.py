"""Bind a native tool call to the existing project collaboration service."""
from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import ValidationError

from mona.development.contracts import Binding, ExecutorId, RunStatus
from mona.development.executors.host_tools import HostToolCall, tool_result
from mona.development.store import DevelopmentError

if TYPE_CHECKING:
    from mona.development.runtime import DevelopmentRuntime


class NativeCollaboration:
    def __init__(self, runtime: DevelopmentRuntime):
        self.runtime = runtime

    def _owner(self, binding: Binding, turn_id: str):
        store = self.runtime.store
        session = store.get_session(binding.session_id)
        current = store.get_binding(binding.id)
        run = store.active_run(session.id)
        if (self.runtime._closed or session.archived or session.readonly or session.parent_session_id
                or current.state != "active" or current.session_id != session.id
                or current.native_session_id != binding.native_session_id
                or current.executor != binding.executor or current.executor != session.executor
                or current.working_directory != binding.working_directory or current.readonly
                or not current.capabilities.host_subagents or run is None or run.binding_id != current.id
                or run.executor != current.executor
                or run.status not in {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER}):
            raise DevelopmentError("host_tool_unavailable", "当前绑定、轮次或权限不允许宿主调用；没有重新派发。")
        expected = run.native_turn_id
        if expected is None and run.executor in {ExecutorId.CLAUDE, ExecutorId.CODEBUDDY}:
            expected = "sdk:" + run.request_id
        if not turn_id or expected != turn_id:
            raise DevelopmentError("host_tool_unavailable", "原生回调不属于当前轮次；没有重新派发。")
        return session, run

    async def __call__(self, binding: Binding, turn_id: str, arguments: dict) -> dict:
        from mona.development.runtime import stable_id
        try:
            call = HostToolCall.model_validate(arguments)
            session, run = self._owner(binding, turn_id)
            manager = self.runtime.collaboration
            if call.action == "presets":
                value = manager.presets(session.id)
            elif call.action == "list":
                value = await manager.observe(session.id)
            elif call.action == "start":
                def authorize() -> None:
                    self._owner(binding, turn_id)
                request = stable_id("native", session.id, run.id, call.request_id)
                value = await manager.start_preset(session.id, request, call.preset_id, call.goal, call.expected_output,
                    title=call.title,
                    authorize=authorize, parent_run_id=run.id, required=call.required)
            elif call.action == "read_result":
                value = manager.read_result(session.id, call.task_id, call.offset, call.expected_sha,
                                            consumer_run_id=run.id)
            elif call.action == "stop":
                value = await manager.stop(session.id, call.task_id)
            elif call.action == "send_message":
                value = await manager.send_message(session.id, call.task_id, call.request_id, call.message,
                    parent_run_id=run.id, authorize=lambda: self._owner(binding, turn_id))
            else:
                try:
                    value = await manager.wait(session.id, call.task_id, call.seconds, consumer_run_id=run.id)
                except TimeoutError:
                    value = {"status": "still_running", "taskId": call.task_id,
                             "message": "等待结束，原子任务仍保留；可继续wait或list，不要重新start。"}
            return tool_result(value)
        except ValidationError:
            return tool_result({"error": "invalid_host_tool_arguments", "message": "协作参数无效，请按当前工具定义调用。"}, error=True)
        except DevelopmentError as exc:
            return tool_result({"error": exc.code, "message": str(exc)}, error=True)
        except Exception:
            # Upstream exceptions can contain credentials. Preserve the request
            # ledger and report uncertainty rather than changing identity/retrying.
            return tool_result({"error": "host_collaboration_unknown", "message": "协作结果待核对，请先查询本会话原任务。"}, error=True)
