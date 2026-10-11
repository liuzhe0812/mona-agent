import copy

import pytest

from mona.development.contracts import PermissionMode, RunStatus
from mona.development.fork import fork_session
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.session.manager import SessionManager
from tests.development.test_workbench_api import AUTH, setup_client
from tests.development.test_workbench_runtime import Model, make_runtime, wait_done


@pytest.mark.asyncio
async def test_fork_exact_prefix_survives_reload_and_continues_independently(tmp_path, monkeypatch):
    model = Model([
        LLMResponse("", tool_calls=[ToolCallRequest("read_rules", "read_file", {"path": "AGENTS.md"})]),
        LLMResponse("第一轮已核对。"), LLMResponse("第二轮的新信息。"), LLMResponse("继续分叉。"),
    ])
    runtime, project, session, root = make_runtime(tmp_path, monkeypatch, model)
    reloaded = None
    try:
        session = runtime.store.set_permission_mode(session.id, session.revision, PermissionMode.AUTO)
        await runtime.submit(session.id, "request_first", "只保留第一轮目标")
        await wait_done(runtime, session.id)
        target = runtime.snapshot(session.id)["messages"][-1]["id"]
        session = runtime.store.get_session(session.id)
        prefix = copy.deepcopy(runtime.sessions.get_or_create(session.transcript_key).messages)
        await runtime.submit(session.id, "request_second", "不属于分叉的后续目标")
        await wait_done(runtime, session.id)
        original = copy.deepcopy(runtime.sessions.get_or_create(session.transcript_key).messages)
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        transcript.last_consolidated = len(original)
        transcript.metadata["development_compaction"] = {"through": len(original), "text": "包含第二轮的摘要"}
        runtime.sessions.save(transcript)
        (root / "manual.txt").write_text("人工修改", encoding="utf-8")
        child = await fork_session(runtime, session.id, session.revision, "fork_first", target)
        copied = runtime.sessions.get_or_create(child.transcript_key)
        assert copied.messages == prefix and copied.last_consolidated == 0
        assert "development_compaction" not in copied.metadata
        assert transcript.messages == original
        assert not child.parent_session_id and child.project_id == project.id
        assert child.executor == session.executor and child.permission_mode == PermissionMode.AUTO
        assert runtime.store.list_runs(child.id) == [] and runtime.store.list_bindings(child.id) == []
        assert len(model.requests) == 3 and not runtime.tasks
        assert (root / "manual.txt").read_text(encoding="utf-8") == "人工修改"
        snapshot = runtime.snapshot(child.id)
        assert snapshot["messages"][-1]["id"] == target
        assert len(snapshot["runs"]) == 1 and snapshot["runs"][0]["status"] == "succeeded"
        assert any(e["type"] == "tools.started" for e in snapshot["events"])
        assert any(m["role"] == "tool" and m["toolCallId"] == "read_rules" for m in snapshot["messages"])
        assert snapshot["pendingInputs"] == snapshot["pendingDecisions"] == []
        # A retry returns the same task even after the source metadata changed.
        runtime.store.update_session(session.id, session.revision, title="已改名")
        assert (await fork_session(runtime, session.id, session.revision, "fork_first", target)).id == child.id
        # Restart reads the forked records from its own transcript, not the parent.
        reloaded = DevelopmentRuntime(DevelopmentStore(runtime.store.path), SessionManager(tmp_path / "transcripts"), runtime.config_loader)
        assert reloaded.snapshot(child.id)["messages"] == snapshot["messages"]
        assert reloaded.snapshot(child.id)["runs"] == snapshot["runs"]
        await reloaded.submit(child.id, "request_branch", "从此继续")
        await wait_done(reloaded, child.id)
        sent = str(model.requests[-1]["messages"])
        assert "分叉会话说明" in sent and "核对实际文件和人工修改" in sent
        assert "只保留第一轮目标" in sent and "第一轮已核对" in sent
        assert "不属于分叉的后续目标" not in sent and "第二轮" not in sent
        branch_target = reloaded.snapshot(child.id)["messages"][-1]["id"]
        second_child = await fork_session(reloaded, child.id, child.revision, "fork_again", branch_target)
        assert len(reloaded.snapshot(second_child.id)["runs"]) == 2
        assert [m["content"] for m in reloaded.snapshot(second_child.id)["messages"] if m["role"] == "assistant"][-1] == "继续分叉。"
        runtime.store.delete_session(session.id, runtime.store.get_session(session.id).revision)
        assert reloaded.snapshot(child.id)["messages"][-1]["id"] == branch_target
    finally:
        if reloaded:
            await reloaded.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_fork_api_validates_boundary_revision_and_eligibility(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    source = runtime.store.create_session(project.id)
    run, _ = runtime.store.create_run(source.id, "request_done", "message_user")
    for status in (RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.SUCCEEDED):
        run = runtime.store.transition_run(run.id, run.revision, status)
    transcript = runtime.sessions.get_or_create(source.transcript_key)
    transcript.add_message("user", "需求", id="message_user", run_id=run.id)
    transcript.add_message("assistant", "中间说明", id="message_progress", run_id=run.id)
    transcript.add_message("assistant", "已完成", id="message_final", run_id=run.id)
    runtime.sessions.save(transcript)
    path = f"/api/development/sessions/{source.id}/fork"
    body = {"revision": source.revision, "requestId": "fork_api", "messageId": "message_final"}
    try:
        denied = await client.post(path, json=body)
        assert denied.status == 401
        for invalid in ({"revision": 99}, {"messageId": "message_missing"}, {"messageId": "message_progress"}, {"messageId": "message_user"}):
            response = await client.post(path, headers=AUTH, json={**body, **invalid})
            assert response.status == 409
            assert len(runtime.store.list_sessions(project.id)) == 1
        response = await client.post(path, headers=AUTH, json=body)
        assert response.status == 200
        child = await response.json()
        assert child["forkSource"]["sourceSessionId"] == source.id and child["forkSource"]["sourceMessageId"] == "message_final"
        assert child["forkSource"]["messageCount"] == 3
        assert await (await client.post(path, headers=AUTH, json=body)).json() == child
        different = await client.post(path, headers=AUTH, json={**body, "messageId": "message_progress"})
        assert different.status == 409
        # An active later turn does not block forking an already completed reply.
        active, _ = runtime.store.create_run(source.id, "request_active", "message_active")
        transcript.messages.insert(2, {"id": "message_queued", "role": "user", "content": "未执行的排队请求", "run_id": active.id, "_ui_only": True})
        runtime.sessions.save(transcript)
        active_fork = await client.post(path, headers=AUTH, json={**body, "requestId": "fork_active"})
        assert active_fork.status == 200
        snapshot = runtime.snapshot((await active_fork.json())["id"])
        assert "排队请求" not in str(snapshot["messages"])
        assert snapshot["pendingInputs"] == snapshot["pendingDecisions"] == []
        assert all(r["status"] == "succeeded" for r in snapshot["runs"])
        assert len(runtime.store.list_sessions(project.id)) == 3
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("readonly,child", [(True, False), (False, True)])
async def test_readonly_and_subtasks_cannot_fork(tmp_path, monkeypatch, readonly, child):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    parent = runtime.store.create_session(project.id)
    source = runtime.store.create_session(project.id, readonly=readonly, parent_session_id=parent.id if child else None)
    run, _ = runtime.store.create_run(source.id, "request_done", "message_user")
    for status in (RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.SUCCEEDED):
        run = runtime.store.transition_run(run.id, run.revision, status)
    transcript = runtime.sessions.get_or_create(source.transcript_key)
    transcript.add_message("assistant", "已完成", id="message_final", run_id=run.id)
    runtime.sessions.save(transcript)
    try:
        response = await client.post(f"/api/development/sessions/{source.id}/fork", headers=AUTH,
            json={"revision": source.revision, "requestId": "fork_restricted", "messageId": "message_final"})
        assert response.status == 409
        assert len(runtime.store.list_sessions(project.id)) == 2
    finally:
        await client.close()
