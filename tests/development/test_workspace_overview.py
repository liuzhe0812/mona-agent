"""Overview state and project presets exercise production stores/tools/dispatch."""
import json

import pytest
from pydantic import ValidationError
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.config.schema import DevelopmentSubagentConfig, ProviderConfig
from mona.development.plan import DevelopmentPlan, DevelopmentPlanTool, normalize_plan
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.providers.base import LLMResponse, ToolCallRequest


def preset(**kwargs):
    return DevelopmentSubagentConfig(id="reviewer_test", name="项目审查员", instructions="REVIEW_DUTY_SENTINEL: only inspect this change", **kwargs)


def test_native_plan_normalization_never_invents_steps():
    assert normalize_plan({"plan": [{"step": "native task", "status": "inProgress"}]})["plan"][0]["status"] == "in_progress"
    assert normalize_plan({"plan": None})["issue"]
    assert normalize_plan({"plan": [{"status": "complete"}]})["plan"] == []


def test_preset_validation_has_no_credentials_or_extra_fields():
    with pytest.raises(ValidationError):
        DevelopmentSubagentConfig(id="reviewer_test", name=" ", instructions="inspect")
    with pytest.raises(ValidationError):
        DevelopmentSubagentConfig(id="reviewer_test", name="review", instructions="inspect", api_key="forbidden")
    with pytest.raises(ValidationError):
        preset(executor="codex", provider="unrelated-source")
    assert preset(executor="codex", model="native-model", effort="high").effort == "high"
    with pytest.raises(ValidationError):
        preset(executor="codex", effort="high")


@pytest.mark.asyncio
async def test_project_presets_persist_with_revision_and_do_not_spawn(tmp_path, monkeypatch):
    runtime, project, parent, root = make_runtime(tmp_path, monkeypatch, Model())
    before = {p: p.read_bytes() for p in root.iterdir() if p.is_file()}
    try:
        configured = preset(description="主引擎根据此描述选择审查任务")
        updated = runtime.store.save_subagents(project.id, 0, [configured])
        assert updated.subagents_revision == 1
        restored = DevelopmentStore(runtime.store.path).get_project(project.id)
        assert restored.subagents == [configured]
        with pytest.raises(ConflictError):
            runtime.store.save_subagents(project.id, 0, [])
        with pytest.raises(DevelopmentError):
            runtime.store.save_subagents(project.id, 1, [preset(), preset()])
        assert not runtime.tasks and not runtime.native.hosts
        assert runtime.store.list_sessions(project.id) == [parent]
        assert all(p.read_bytes() == data for p, data in before.items())
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_native_preset_rejects_unsupported_effort_before_creating_child(tmp_path, monkeypatch):
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    monkeypatch.setattr(runtime.native, "describe", lambda _project: [{"id": "codex", "models": [
        {"id": "native-model", "reasoningEfforts": ["high"]}]}])
    try:
        runtime.store.save_subagents(project.id, 0, [preset(executor="codex", model="native-model", effort="invalid")])
        with pytest.raises(DevelopmentError, match="思考强度"):
            await runtime.collaboration.start_preset(parent.id, "invalid_effort", "reviewer_test", "检查文件")
        assert runtime.store.list_sessions(project.id) == [parent]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_preset_dispatch_uses_exact_model_source_duty_and_permissions(tmp_path, monkeypatch):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    config = runtime.config_loader()
    config.providers.cindy["custom-team"] = ProviderConfig(display_name="Team", api_key="synthetic-not-sent",
        api_base="http://127.0.0.1:9999/v1", discovered_models=[{"id": "team-model", "type": "chat"}], enabled_models=["team-model"])
    try:
        runtime.store.save_subagents(project.id, 0, [preset(model="team-model", provider="custom-team", readonly=True)])
        packet = await runtime.collaboration.start_preset(parent.id, "request_preset", "reviewer_test", "检查代码")
        child = runtime.store.get_session(packet["childSessionId"])
        await wait_done(runtime, child.id)
        assert (child.executor.value, child.model, child.model_provider, child.readonly) == ("mona", "team-model", "custom-team", True)
        assert "REVIEW_DUTY_SENTINEL" in str(model.requests[0]["messages"])
        assert "synthetic-not-sent" not in str(model.requests)
        assert {t["function"]["name"] for t in model.requests[0]["tools"]} == {"read_file", "list_dir", "grep", "find_files"}
        repeated = await runtime.collaboration.start_preset(parent.id, "request_preset", "reviewer_test", "检查代码")
        assert repeated["id"] == packet["id"] and len(runtime.store.list_runs(child.id)) == 1
        runtime.store.save_subagents(project.id, 1, [preset(enabled=False)])
        with pytest.raises(DevelopmentError, match="已停用"):
            await runtime.collaboration.start_preset(parent.id, "request_disabled", "reviewer_test", "不应运行")
        assert len(runtime.store.list_sessions(project.id)) == 2
        assert not runtime.store.list_runs(parent.id)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_routing_descriptions_reach_root_each_turn_and_child_receives_instructions(tmp_path, monkeypatch):
    from dataclasses import replace

    from mona.development.context import build_coding_messages, load_project_context

    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    configured = preset(description="ROUTING_DESCRIPTION", readonly=True)
    disabled = configured.model_copy(update={"id": "disabled_agent", "description": "DISABLED_DESCRIPTION", "enabled": False})
    try:
        runtime.store.save_subagents(project.id, 0, [configured, disabled])
        catalog = runtime.collaboration.presets(parent.id)
        assert catalog == [{"id": configured.id, "name": configured.name, "description": "ROUTING_DESCRIPTION", "readonly": True}]
        await runtime.submit(parent.id, "routing_first", "检查当前代码")
        await wait_done(runtime, parent.id)
        messages = model.requests[0]["messages"]
        assert "ROUTING_DESCRIPTION" in str(messages)
        assert "REVIEW_DUTY_SENTINEL" not in str(messages) and "DISABLED_DESCRIPTION" not in str(messages)
        assert "ROUTING_DESCRIPTION" not in messages[0]["content"]
        assert "ROUTING_DESCRIPTION" not in str(runtime.snapshot(parent.id)["messages"])
        context = replace(load_project_context(runtime.store.get_project(project.id)),
            subagent_context=runtime.collaboration.scheduling_context(parent.id))
        rebuilt = build_coding_messages(context, parent, runtime.sessions.get_or_create(parent.transcript_key), summary="previous work")
        assert "ROUTING_DESCRIPTION" in str(rebuilt) and rebuilt[0] == messages[0]
        runtime.store.save_subagents(project.id, 1, [configured.model_copy(update={"description": "UPDATED_ROUTING"})])
        await runtime.submit(parent.id, "routing_second", "继续检查")
        await wait_done(runtime, parent.id)
        assert "UPDATED_ROUTING" in str(model.requests[-1]["messages"])
        assert "ROUTING_DESCRIPTION" not in str(model.requests[-1]["messages"])
        child = await runtime.collaboration.start_preset(parent.id, "child_instructions", configured.id, "查看文件")
        await wait_done(runtime, child["childSessionId"])
        assert "REVIEW_DUTY_SENTINEL" in str(model.requests[-1]["messages"])
        assert "developmentSubagents" not in str(model.requests[-1]["messages"])
        assert not runtime.collaboration.scheduling_context(child["childSessionId"])
        runtime.store.save_subagents(project.id, 2, [preset()])
        assert runtime.collaboration.presets(parent.id)[0]["description"] == preset().instructions
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_real_plan_tool_persists_without_auto_completion_or_event_page_loss(tmp_path, monkeypatch):
    steps = [{"step": "读取代码", "status": "completed"}, {"step": "等待用户确认", "status": "pending"}]
    model = Model([
        LLMResponse("", tool_calls=[ToolCallRequest("load_plan", "load_coding_tools", {"capability": "plan"})]),
        LLMResponse("", tool_calls=[ToolCallRequest("plan_call", "update_plan", {"plan": steps})]),
        LLMResponse("请确认下一步。"),
    ])
    runtime, project, session, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        assert runtime.snapshot(session.id)["plan"] is None
        await runtime.submit(session.id, "request_plan", "需要计划的任务")
        await wait_done(runtime, session.id)
        value = runtime.snapshot(session.id, after=100000)["plan"]
        assert value["plan"] == steps
        with pytest.raises(ConflictError):
            await DevelopmentPlanTool(runtime.store, value["runId"]).execute([])
        assert DevelopmentStore(runtime.store.path).latest_plan(session.id) == value
        other = runtime.store.create_session(project.id)
        assert runtime.snapshot(other.id)["plan"] is None
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        result = next(m for m in transcript.messages if m.get("role") == "tool" and m.get("name") == "update_plan")
        assert json.loads(result["content"])["ok"]
        with pytest.raises(ValidationError):
            DevelopmentPlan(plan=[{"step": "one", "status": "in_progress"}, {"step": "two", "status": "in_progress"}])
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_subagent_routes_require_auth_and_enforce_revision(tmp_path, monkeypatch):
    from test_workbench_api import AUTH, setup_client
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    try:
        project = runtime.store.open_project(root)
        url = f"/api/development/projects/{project.id}/subagents"
        assert (await client.get(url)).status == 401
        assert (await client.get(url, headers=AUTH)).status == 200
        body = {"revision": 0, "presets": [preset().model_dump(mode="json", by_alias=True)]}
        response = await client.put(url, headers=AUTH, json=body)
        assert response.status == 200 and (await response.json())["revision"] == 1
        assert (await client.put(url, headers=AUTH, json=body)).status == 409
        assert runtime.store.list_sessions(project.id) == [] and not runtime.native.hosts
    finally:
        await client.close()
