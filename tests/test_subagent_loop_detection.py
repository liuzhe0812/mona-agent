"""Loop stops remain failures while returning completed work to the parent."""

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.jobs import AgentJobStore
from mona.agent.partners import AgentDefinition, AgentRegistry
from mona.agent.runner import AgentRunResult
from mona.agent.subagent import SubagentManager, SubagentStatus
from mona.agent.tools.registry import ToolRegistry
from mona.agent.user_config import AgentUserConfig
from mona.bus.queue import MessageBus
from mona.providers.base import LLMProvider

LOOP_ERROR = "重复操作未产生新进展，任务已停止。"
PARTIAL_RESULT = "已完成资料整理，结果保存在 report.md。"


def _manager(tmp_path):
    provider = MagicMock(spec=LLMProvider)
    provider.get_default_model.return_value = "test-model"
    return SubagentManager(
        provider=provider, workspace=tmp_path, bus=MessageBus(), model="test-model",
        max_tool_result_chars=16_000,
    )


def _loop_result():
    return AgentRunResult(
        final_content=PARTIAL_RESULT, messages=[], stop_reason="loop_detected", error=LOOP_ERROR,
        tool_events=[
            {"name": "write_file", "status": "ok", "detail": "report.md"},
            {"name": "read_file", "status": "error", "detail": "previous error"},
        ],
    )


@pytest.mark.asyncio
async def test_subagent_loop_detected_reports_failure_and_preserves_progress(tmp_path):
    manager = _manager(tmp_path)
    manager.runner.run = AsyncMock(return_value=_loop_result())
    status = SubagentStatus(
        task_id="t1", label="label", task_description="do task", started_at=time.monotonic(),
    )

    await manager._run_subagent(
        "t1", "do task", "label", {"channel": "cli", "chat_id": "direct"}, status,
    )

    message = manager.bus.inbound.get_nowait()
    assert "failed" in message.content
    assert "completed successfully" not in message.content
    assert LOOP_ERROR in message.content
    assert PARTIAL_RESULT in message.content
    assert status.phase == "error"
    assert status.stop_reason == "loop_detected"
    assert status.error == LOOP_ERROR


@pytest.mark.asyncio
async def test_workflow_loop_detected_persists_failure_with_progress(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    definition = AgentDefinition(id="com.mona.researcher", display_name="Researcher")
    registry = AgentRegistry(installed_dir=tmp_path / "installed")
    store = AgentJobStore(tmp_path / "jobs")
    job = store.create(
        room_id="room", requested_by="mona", assigned_to=definition.id, task="analyse",
        workflow_run_id="run1", workflow_step_id="step1", user_profile_snapshot={},
    )
    status = SubagentStatus(
        task_id="t1", label="Researcher", task_description=job.task, started_at=time.monotonic(),
    )
    monkeypatch.setattr("mona.agent.user_config.load_agent_user_config", lambda _: AgentUserConfig())
    monkeypatch.setattr(manager, "_build_named_agent_tools", lambda *args, **kwargs: ToolRegistry())
    monkeypatch.setattr(manager, "_build_named_agent_prompt", lambda *args: "Analyse the task.")
    manager.runner.run = AsyncMock(return_value=_loop_result())

    await manager._run_named_agent(
        "t1", job, definition, {"channel": "cli", "chat_id": "room"}, status, registry, store,
    )

    finished = store.load(job.id)
    assert finished.status == "failed"
    assert finished.result is None
    assert finished.error.startswith(f"Failure:\n- {LOOP_ERROR}")
    assert PARTIAL_RESULT in finished.error
    assert manager.runner.run.call_args.args[0].repeat_guard_enabled is True
    message = manager.bus.inbound.get_nowait()
    assert message.metadata["job_id"] == job.id
    assert "failed" in message.content
    assert "completed successfully" not in message.content
    assert PARTIAL_RESULT in message.content
    assert status.phase == "error"
    assert status.stop_reason == "loop_detected"
    assert status.error == LOOP_ERROR
