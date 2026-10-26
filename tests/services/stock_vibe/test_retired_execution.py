"""Removed stock implementations cannot be revived by persisted tasks or plugins."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.jobs import AgentJob, AgentJobStore, JobTransitionError, RetiredTaskError
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import _RETIRED_STOCK_TOOL_MODULES, ToolRegistry
from mona.agent.workflow import WorkflowDefinition, WorkflowRunner, WorkflowRunStore, WorkflowStep


@pytest.fixture(autouse=True)
def private_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "private" / "config.json")
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))


@pytest.mark.parametrize("agent_id", ["com.mona.stock-tech-analyst", "com.mona.a-share-analyst"])
def test_removed_agents_cannot_create_jobs(tmp_path: Path, agent_id: str) -> None:
    store = AgentJobStore(tmp_path / "jobs")
    with pytest.raises(RetiredTaskError, match="已移除"):
        store.create(room_id="research", requested_by="user", assigned_to=agent_id, task="retired task")
    assert not list(tmp_path.rglob("*.json"))


def _historical_job(tmp_path: Path, agent_id: str, room_id: str) -> tuple[AgentJobStore, AgentJob]:
    store = AgentJobStore(tmp_path / "jobs")
    job = AgentJob(id="job_retired_fixture", assigned_to=agent_id, room_id=room_id,
        requested_by="user", task="persisted old task", user_profile_snapshot={})
    store.jobs_dir.mkdir(parents=True)
    (store.jobs_dir / f"{job.id}.json").write_text(json.dumps(job.model_dump(mode="json")), encoding="utf-8")
    return store, job


def test_historical_stock_job_cannot_transition_to_running(tmp_path: Path) -> None:
    store, job = _historical_job(tmp_path, "com.mona.stock-tech-analyst", "custom")
    with pytest.raises(JobTransitionError, match="已移除"):
        store.mark_running(job.id)
    assert store.load(job.id).status == "queued"


@pytest.mark.parametrize("agent_id,room_id", [
    ("com.mona.stock-tech-analyst", "custom"),
    ("com.mona.a-share-analyst", "custom"),
    ("com.example.researcher", "stock_research"),
])
async def test_retired_queued_jobs_fail_without_resolving_installed_agents(
    tmp_path: Path, agent_id: str, room_id: str,
) -> None:
    from mona.agent.subagent import SubagentManager
    from mona.bus.queue import MessageBus
    from mona.config.schema import _resolve_tool_config_refs

    _resolve_tool_config_refs()
    store, job = _historical_job(tmp_path, agent_id, room_id)
    manager = SubagentManager(provider=None, model="test", workspace=tmp_path,
        bus=MessageBus(), max_tool_result_chars=1000)

    class Registry:
        def get(self, _agent_id):
            raise AssertionError("retired job must fail before resolving its installed agent")

    result = await manager.recover_jobs(registry=Registry(), job_stores=[store])
    assert result == {"restarted": 0, "failed": 1, "skipped": 0}
    assert store.load(job.id).status == "failed"
    assert "已移除" in store.load(job.id).error
    assert manager.get_running_count() == 0


async def test_removed_workflow_cannot_dispatch_but_general_workflows_still_run(tmp_path: Path) -> None:
    calls = []

    async def execute(_run, step, _upstream):
        calls.append(step.agent_id)
        return "complete"

    store = WorkflowRunStore(tmp_path / "runs")
    runner = WorkflowRunner(run_store=store, step_executor=execute)
    retired = WorkflowDefinition(id="retired", room_id="custom", revision=1,
        steps=[WorkflowStep(id="research", agent_id="com.mona.stock-tech-analyst", task="retired")])
    with pytest.raises(RetiredTaskError, match="已移除"):
        await runner.run(room_id="custom", workflow=retired)
    assert calls == []
    assert not list(tmp_path.rglob("*.json"))

    ordinary = WorkflowDefinition(id="ordinary", room_id="custom", revision=1,
        steps=[WorkflowStep(id="research", agent_id="com.example.researcher", task="ordinary")])
    result = await runner.run(room_id="custom", workflow=ordinary)
    assert result.status == "succeeded"
    assert calls == ["com.example.researcher"]


@pytest.mark.parametrize("room_id,template", [
    ("stock_research", ""),
    ("stock_ai_diagnosis", ""),
    ("custom", "package://com.mona.a-share-team/workflows/daily-review.json"),
])
async def test_retired_cron_rejected_before_loading_templates(room_id: str, template: str) -> None:
    from mona.cli.commands import _execute_workflow_run_cron
    from mona.cron.service import CronSkip

    job = SimpleNamespace(payload=SimpleNamespace(room_id=room_id, template_ref=template))
    with pytest.raises(CronSkip, match="已移除"):
        await _execute_workflow_run_cron(job, subagents=None, session_manager=None)


class _RetiredTool(Tool):
    name = "retired_probe"
    description = "Retired tool"
    parameters = {"type": "object", "properties": {}}

    async def execute(self, **kwargs):
        raise AssertionError("retired implementation must not execute")


@pytest.mark.parametrize("module", sorted(_RETIRED_STOCK_TOOL_MODULES))
async def test_stale_tool_registrations_are_rejected(module: str) -> None:
    tool = type("RetiredTool", (_RetiredTool,), {"__module__": module})()
    registry = ToolRegistry()
    registry.register(tool)
    result = await registry.execute(tool.name, {})
    assert "旧股票模块已移除" in result
