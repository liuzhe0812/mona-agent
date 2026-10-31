import asyncio
import json
import secrets
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.agent.tools.context import RequestContext
from mona.agent.tools.registry import ToolRegistry
from mona.bus.queue import MessageBus
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.rpc import RpcError
from mona.development.hub import DevelopmentHub
from mona.development.hub_contracts import HubCommand
from mona.development.hub_store import HubRequest
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.providers.base import LLMResponse
from mona.session.manager import SessionManager
from mona.webui.transcript import build_webui_thread_response, read_transcript_lines


def setup_hub(tmp_path, monkeypatch, model=None):
    model = model or Model([LLMResponse("已检查代码；未运行构建或测试。")])
    runtime, project, target, root = make_runtime(tmp_path, monkeypatch, model)
    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path / "display")
    source = runtime.sessions.get_or_create("websocket:hub_source")
    source.add_message("user", "协调开发任务", id="source_request")
    runtime.sessions.save(source)
    context = RequestContext("websocket", "hub_source", "source_request", source.key)
    bus = MessageBus()
    hub = DevelopmentHub(lambda: runtime, runtime.sessions, bus)
    return hub, context, runtime, project, target, root, model


async def send(hub, context, target, request_id="request_hub", **kwargs):
    return await hub.execute(HubCommand(action="send_task", session_id=target.id,
        request_id=request_id, expected_revision=target.revision, content="检查登录实现，不修改文件", **kwargs), context)


@pytest.mark.asyncio
async def test_read_workbench_and_scoped_project_evidence(tmp_path, monkeypatch):
    hub, context, runtime, project, target, root, _ = setup_hub(tmp_path, monkeypatch)
    try:
        projects = await hub.execute(HubCommand(action="list_projects", query="代码", limit=1), context)
        assert projects["items"][0]["id"] == project.id
        sessions = await hub.execute(HubCommand(action="list_sessions", project_id=project.id), context)
        assert sessions["items"][0]["id"] == target.id
        detail = await hub.execute(HubCommand(action="inspect_session", session_id=target.id), context)
        assert detail["messages"] == [] and detail["runs"] == []
        evidence = await hub.execute(HubCommand(action="read_file", project_id=project.id, path="AGENTS.md"), context)
        assert "PROJECT_RULE_SENTINEL" in evidence["content"]
        outside = root.parent / "private.txt"
        outside.write_text("PRIVATE_SENTINEL", encoding="utf-8")
        with pytest.raises(DevelopmentError, match="项目外"):
            await hub.execute(HubCommand(action="read_file", project_id=project.id, path="../private.txt"), context)
        assert not runtime.tasks
        expert = runtime.sessions.get_or_create("websocket:expert_source")
        expert.metadata["conversation"] = {"type": "direct", "agent_ids": ["com.mona.academic-researcher"],
                                            "direct_agent_id": "com.mona.academic-researcher"}
        assert not hub.allows_context(RequestContext("websocket", "expert_source", session_key=expert.key))
        assert not hub.allows_context(RequestContext("development", target.id, session_key=target.transcript_key))
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_create_session_visible_and_idempotent_without_permission_escalation(tmp_path, monkeypatch):
    hub, context, runtime, project, _, _, _ = setup_hub(tmp_path, monkeypatch)
    command = HubCommand(action="create_session", project_id=project.id, request_id="create_login",
                         title="登录检查", readonly=True)
    try:
        first = await hub.execute(command, context)
        second = await hub.execute(command, context)
        assert first["task"]["sessionId"] == second["task"]["sessionId"]
        assert second["reused"] and first["task"]["session"]["readonly"]
        assert first["task"]["session"]["permissionMode"] == "ask"
        assert len(runtime.store.list_sessions(project.id)) == 2 and not runtime.tasks
        with pytest.raises(ConflictError):
            await hub.execute(command.model_copy(update={"title": "不同任务"}), context)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_real_dispatch_result_replay_and_restart_notice_deduplication(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)
    try:
        packet = await send(hub, context, target)
        await wait_done(runtime, target.id)
        repeated = await send(hub, context, target)
        assert repeated["reused"] and len(model.requests) == 1
        record = hub.store.list(context.session_key)[0]
        assert hub.describe(record)["status"] == "succeeded"
        assert hub.describe(record)["run"]["id"] == packet["task"]["run"]["id"]
        await hub.observe(record)
        source = runtime.sessions.get_existing(context.session_key)
        notices = [m for m in source.messages if m.get("injected_event") == "development_result"]
        assert len(notices) == 1 and "未运行构建或测试" in notices[0]["content"]
        assert notices[0]["role"] == "assistant" and hub.bus.inbound_size == 0
        event = await hub.bus.consume_outbound()
        assert event.metadata == {"_session_updated": True, "_session_update_scope": "thread"}
        display = build_webui_thread_response(context.session_key)["messages"]
        assert len(display) == 1 and display[0]["id"] == notices[0]["id"]
        restarted = DevelopmentHub(lambda: runtime, runtime.sessions, hub.bus)
        await restarted.observe(restarted.store.list(context.session_key)[0])
        assert len(read_transcript_lines(context.session_key)) == 1
        assert len(model.requests) == 1 and hub.bus.outbound_size == 0
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_queued_follow_up_tracks_its_own_run_and_result(tmp_path, monkeypatch):
    gate = asyncio.Event()
    model = Model([LLMResponse("前序任务结果"), LLMResponse("后续任务结果")], gate)
    hub, context, runtime, _, target, _, _ = setup_hub(tmp_path, monkeypatch, model)
    try:
        original = await runtime.submit(target.id, "manual_request", "先检查文件")
        await asyncio.wait_for(model.entered.wait(), 3)
        current = runtime.store.get_session(target.id)
        packet = await send(hub, context, current)
        assert packet["task"]["status"] == "queued"
        record = hub.store.list(context.session_key)[0]
        await hub.observe(record)
        assert hub.bus.outbound_size == 0
        gate.set()
        await wait_done(runtime, target.id)
        task = hub.describe(record)
        assert task["status"] == "succeeded" and task["run"]["id"] != original["run"]["id"]
        await hub.observe(record)
        notice = runtime.sessions.get_existing(context.session_key).messages[-1]
        assert "后续任务结果" in notice["content"] and "前序任务结果" not in notice["content"]
        assert len(model.requests) == 2
    finally:
        gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_run_and_stale_revision_do_not_dispatch_new_work(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)
    try:
        run, _ = runtime.store.create_run(target.id, "unknown_request", "unknown_message")
        run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        runtime.store.transition_run(run.id, run.revision, RunStatus.UNKNOWN)
        with pytest.raises(ConflictError, match="未确认结束"):
            await send(hub, context, runtime.store.get_session(target.id))
        assert len(runtime.store.list_runs(target.id)) == 1 and not model.requests
        other = runtime.store.create_session(target.project_id)
        with pytest.raises(ConflictError, match="主会话已变化"):
            await send(hub, context, other.model_copy(update={"revision": other.revision + 1}), "stale_revision")
        assert runtime.store.list_runs(other.id) == []
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_lost_dispatch_receipt_is_reconciled_without_rerunning(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)
    submit = runtime.submit

    async def lose_receipt(*args, **kwargs):
        await submit(*args, **kwargs)
        raise TimeoutError("simulated lost response")

    monkeypatch.setattr(runtime, "submit", lose_receipt)
    try:
        with pytest.raises(TimeoutError):
            await send(hub, context, target)
        repeated = await send(hub, context, target)
        assert repeated["reused"] and repeated["ok"]
        await wait_done(runtime, target.id)
        assert len(runtime.store.list_runs(target.id)) == 1 and len(model.requests) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_deleted_origin_does_not_reappear_on_late_result(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, _ = setup_hub(tmp_path, monkeypatch)
    try:
        await send(hub, context, target)
        await wait_done(runtime, target.id)
        runtime.sessions.delete_session(context.session_key)
        await hub.observe(hub.store.list(context.session_key)[0])
        assert runtime.sessions.get_existing(context.session_key) is None
        assert read_transcript_lines(context.session_key) == []
        assert hub.bus.outbound_size == 0
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_notice_persistence_retry_keeps_one_visible_message(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, _ = setup_hub(tmp_path, monkeypatch)
    try:
        await send(hub, context, target)
        await wait_done(runtime, target.id)
        record = hub.store.list(context.session_key)[0]
        save = hub.store.save

        def fail_acknowledgment(value):
            if value.notified:
                raise OSError("simulated interrupted acknowledgment")
            save(value)

        monkeypatch.setattr(hub.store, "save", fail_acknowledgment)
        with pytest.raises(OSError):
            await hub.observe(record)
        monkeypatch.setattr(hub.store, "save", save)
        await hub.observe(hub.store.list(context.session_key)[0])
        assert len(build_webui_thread_response(context.session_key)["messages"]) == 1
        assert len([m for m in runtime.sessions.get_existing(context.session_key).messages
                    if m.get("injected_event") == "development_result"]) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_gateway_tool_and_http_share_runtime_and_start_observer(tmp_path, monkeypatch):
    hub, context, runtime, project, target, _, _ = setup_hub(tmp_path, monkeypatch)
    local_token = secrets.token_hex(16)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", local_token)
    registry = ToolRegistry()
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    app["agent_loop"] = SimpleNamespace(sessions=runtime.sessions, bus=hub.bus, tools=registry)
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        tool = registry.get("development_workbench")
        tool.set_context(context)
        result = await registry.execute("development_workbench", {"action": "list_projects"})
        assert project.id in result and runtime.store is app[RUNTIME_KEY].store
        response = await client.get(f"/api/development/projects/{project.id}/sessions", headers={"X-Mona-Token": local_token})
        assert response.status == 200 and (await response.json())[0]["id"] == target.id
        submitted = json.loads(await registry.execute("development_workbench", {"action": "send_task", "session_id": target.id,
            "request_id": "gateway_request", "expected_revision": target.revision, "content": "检查登录实现"}))
        assert submitted["ok"]
        await wait_done(runtime, target.id)
        event = await asyncio.wait_for(hub.bus.consume_outbound(), 3)
        assert event.metadata["_session_updated"]
        assert "开发会话报告" in build_webui_thread_response(context.session_key)["messages"][0]["content"]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_persisted_result_is_reported_after_full_runtime_restart(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)
    await send(hub, context, target)
    await wait_done(runtime, target.id)
    await runtime.close()
    restored = DevelopmentRuntime(DevelopmentStore(runtime.store.path), SessionManager(tmp_path / "transcripts"),
                                  runtime.config_loader)
    restarted = DevelopmentHub(lambda: restored, restored.sessions, MessageBus())
    try:
        await restarted.observe(restarted.store.list(context.session_key)[0])
        source = restored.sessions.get_existing(context.session_key)
        assert len([m for m in source.messages if m.get("injected_event") == "development_result"]) == 1
        assert "未运行构建或测试" in build_webui_thread_response(context.session_key)["messages"][0]["content"]
        assert len(model.requests) == 1
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_prepared_request_without_dispatch_evidence_stays_unknown(tmp_path, monkeypatch):
    hub, context, runtime, project, target, _, model = setup_hub(tmp_path, monkeypatch)
    source = runtime.sessions.get_existing(context.session_key)
    record, _ = hub.store.begin(HubRequest(id="hub_uncertain", action="send_task", fingerprint="fingerprint",
        source_channel=context.channel, source_chat_id=context.chat_id, source_session_key=context.session_key,
        source_created_at=source.created_at.isoformat(), project_id=project.id, session_id=target.id))
    try:
        await hub.observe(record)
        assert hub.describe(record)["status"] == "unknown"
        assert not runtime.tasks and not runtime.store.list_runs(target.id) and not model.requests
        assert "没有重新执行" in runtime.sessions.get_existing(context.session_key).messages[-1]["content"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_each_real_approval_notifies_once_without_answering_it(tmp_path, monkeypatch):
    gate = asyncio.Event()
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch, Model(gate=gate))
    decision = None
    try:
        packet = await send(hub, context, target)
        await asyncio.wait_for(model.entered.wait(), 3)
        record = hub.store.list(context.session_key)[0]
        for count in (1, 2):
            decision = asyncio.create_task(runtime.native.decisions.request_run(packet["task"]["run"]["id"],
                "permission", {"command": f"read-file-{count}"}))
            await asyncio.sleep(0)
            await hub.observe(record)
            await hub.observe(record)
            assert not decision.done()
            notices = [m for m in runtime.sessions.get_existing(context.session_key).messages
                       if m.get("injected_event") == "development_result"]
            assert len(notices) == count and "需要你处理确认" in notices[-1]["content"]
            pending = runtime.native.decisions.list_pending(target.id)[0]
            runtime.native.decisions.resolve(target.id, pending["id"], "accept")
            await decision
    finally:
        if decision is not None and not decision.done():
            decision.cancel()
            await asyncio.gather(decision, return_exceptions=True)
        gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_origin_deleted_while_waiting_for_target_does_not_start_task(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)
    lock = runtime._lock(target.id)
    await lock.acquire()
    pending = asyncio.create_task(send(hub, context, target))
    try:
        await asyncio.sleep(0)
        runtime.sessions.delete_session(context.session_key)
        lock.release()
        with pytest.raises(DevelopmentError, match="来源聊天已删除"):
            await pending
        assert not model.requests and not runtime.store.list_runs(target.id)
        assert runtime.sessions.get_existing(context.session_key) is None
    finally:
        if lock.locked():
            lock.release()
        await asyncio.gather(pending, return_exceptions=True)
        await runtime.close()


@pytest.mark.asyncio
async def test_native_preparation_rechecks_origin_before_dispatch(tmp_path, monkeypatch):
    hub, context, runtime, project, _, _, model = setup_hub(tmp_path, monkeypatch)
    runtime.config_loader().development.enabled_engines = ["codex"]
    target = runtime.store.create_session(project.id, ExecutorId.CODEX)
    entered, release = asyncio.Event(), asyncio.Event()

    async def prepare(_session):
        entered.set()
        await release.wait()

    monkeypatch.setattr(runtime.native, "ensure", prepare)
    pending = asyncio.create_task(send(hub, context, target))
    try:
        await asyncio.wait_for(entered.wait(), 3)
        runtime.sessions.delete_session(context.session_key)
        release.set()
        with pytest.raises(DevelopmentError, match="来源聊天已删除"):
            await pending
        assert not runtime.store.list_runs(target.id) and not model.requests
    finally:
        release.set()
        await asyncio.gather(pending, return_exceptions=True)
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_native_receipt_is_not_recorded_as_rejected(tmp_path, monkeypatch):
    hub, context, runtime, _, target, _, model = setup_hub(tmp_path, monkeypatch)

    async def unconfirmed(*args, **kwargs):
        raise RpcError("native_timeout", "synthetic native failure", outcome_unknown=True)

    monkeypatch.setattr(runtime, "submit", unconfirmed)
    try:
        with pytest.raises(RpcError):
            await send(hub, context, target)
        record = hub.store.list(context.session_key)[0]
        assert record.state == "unknown" and not record.finished
        repeated = await send(hub, context, target)
        assert repeated["reused"] and not repeated["ok"] and not model.requests
    finally:
        await runtime.close()
