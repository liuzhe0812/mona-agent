from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import settle, wait_run

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.api import development_auth
from mona.development.context import ProjectContext
from mona.development.contracts import (
    Binding,
    DevelopmentSession,
    ExecutorId,
    PermissionMode,
    RunStatus,
)
from mona.development.executors.base import DispatchReceipt, NativeEvent, SessionStart
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk import SDKExecutor, _SDKSession
from mona.development.executors.sdk_policy import SDKProfile, prepare_sdk_profile
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.session.manager import SessionManager


async def setup(tmp_path, monkeypatch, executor):
    _resolve_tool_config_refs()
    config = Config()
    setattr(config.development, f"{executor.value}_path", sys.executable)
    config.development.enabled_engines = [executor.value]
    root = tmp_path / "中文 项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("KEEP_PROJECT_RULE", encoding="utf8")
    store = DevelopmentStore(tmp_path / "state.db")
    runtime = DevelopmentRuntime(store, SessionManager(tmp_path / "history"), lambda: config)
    project = store.open_project(root)
    monkeypatch.setattr("mona.development.executors.sdk.sdk_version", lambda _: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.worker_command", lambda: (sys.executable, "-u", str(Path(__file__).with_name("sdk_peer.py"))))
    profile = prepare_sdk_profile(executor, Path(sys.executable), tmp_path / "sdk-home", root)
    async def permission(binding, _method, params):
        return await runtime.native.decisions.request(binding, "permission", params)
    async def question(binding, params):
        return await runtime.native.decisions.request(binding, "question", params)
    host = SDKExecutor(profile, approval_handler=permission, question_handler=question)
    runtime.native.hosts[(project.id, executor)] = host
    return runtime, project, root, host


def _event_host(tmp_path: Path, *, work_mode: bool) -> tuple[SDKExecutor, Binding, _SDKSession]:
    executor = ExecutorId.CODEBUDDY
    project_root = tmp_path / "event-project"
    project_root.mkdir(parents=True)
    session = DevelopmentSession(project_id="event-project", executor=executor)
    context = ProjectContext("work", project_root, (), (), (), "rules", "skills")
    start = SessionStart(session, context, work_prompt="Use Mona tools." if work_mode else None)
    profile = SDKProfile(executor, project_root / "codebuddy", tmp_path / "sdk-home", project_root, {})
    host = SDKExecutor(profile)
    binding = Binding(session_id=session.id, executor=executor, native_session_id="native-session",
                      working_directory=str(project_root))
    runtime = _SDKSession(binding=binding, start=start, status="running", turn_id="turn-1")
    host._sessions[binding.id] = runtime
    return host, binding, runtime


async def _read_queued_events(host: SDKExecutor, binding: Binding, runtime: _SDKSession) -> list[NativeEvent]:
    events = host.events(binding)
    result = []
    while not runtime.queue.empty():
        result.append(await anext(events))
    await events.aclose()
    return result


def _delta(event_type: str, turn_id: str, item_id: str, text: str, event_id: str) -> NativeEvent:
    return NativeEvent(type=event_type, native_turn_id=turn_id, native_event_id=event_id,
                       payload={"itemId": item_id, "delta": text})


def trace(root):
    return [json.loads(line) for line in (root / "sdk-peer-trace.jsonl").read_text(encoding="utf8").splitlines()]


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.asyncio
async def test_sdk_real_worker_multiturn_question_and_owner_lifetime(tmp_path, monkeypatch, executor):
    runtime, project, root, _ = await setup(tmp_path, monkeypatch, executor)
    first = runtime.store.create_session(project.id, executor)
    second = runtime.store.create_session(project.id, executor)
    try:
        await runtime.submit(first.id, "request_question", "question")
        await wait_run(runtime, first.id, RunStatus.WAITING_USER)
        decision = runtime.native.decisions.list_pending(first.id)[0]
        assert decision["kind"] == "question"
        await runtime.submit(second.id, "request_other", "second session")
        await wait_run(runtime, second.id, RunStatus.SUCCEEDED)
        runtime.native.decisions.resolve(first.id, decision["id"], {"question-0": ["内网"]})
        await settle(runtime)
        original = runtime.store.list_bindings(first.id)[0]
        messages = runtime.sessions.get_or_create(first.transcript_key).messages
        assert "内网" in messages[-1]["content"]
        await runtime.submit(first.id, "request_follow", "continue")
        await settle(runtime)
        assert runtime.store.list_bindings(first.id)[0].native_session_id == original.native_session_id
        assert all(r.native_dispatch == "accepted" for r in runtime.store.list_runs(first.id))
        calls = trace(root)
        assert len([r for r in calls if r["method"] == "connect"]) == 2
        assert len([r for r in calls if r["method"] == "query"]) == 3
    finally:
        await runtime.close()
    assert len([r for r in trace(root) if r["method"] == "disconnect" and r["sameOwner"]]) == 2


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.asyncio
async def test_sdk_resume_does_not_create_a_different_product_or_native_session(tmp_path, monkeypatch, executor):
    runtime, project, root, host = await setup(tmp_path, monkeypatch, executor)
    session = runtime.store.create_session(project.id, executor)
    try:
        await runtime.submit(session.id, "request_first", "first")
        await settle(runtime)
        binding = runtime.store.list_bindings(session.id)[0]
        await host._sessions[binding.id].connection.close()
        assert await host.get_status(binding) == "not_loaded"
        await runtime.submit(session.id, "request_next", "next")
        await settle(runtime)
        connects = [r for r in trace(root) if r["method"] == "connect"]
        assert len(connects) == 2 and connects[-1]["resume"] == binding.native_session_id
        assert runtime.store.list_bindings(session.id)[0].id == binding.id
    finally:
        await runtime.close()


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.asyncio
async def test_sdk_permission_mode_round_trips_through_worker_on_same_native_session(tmp_path, monkeypatch, executor):
    runtime, project, root, host = await setup(tmp_path, monkeypatch, executor)
    session = runtime.store.create_session(project.id, executor)
    runtime.store.set_permission_mode(session.id, session.revision, PermissionMode.AUTO)
    try:
        await runtime.submit(session.id, "request_auto", "finish this task")
        await wait_run(runtime, session.id, RunStatus.SUCCEEDED)
        binding = runtime.store.list_bindings(session.id)[0]
        assert binding.permission_mode == PermissionMode.AUTO
        assert binding.capabilities.permission_modes == [PermissionMode.ASK, PermissionMode.AUTO]
        assert host._permission_modes == [PermissionMode.ASK, PermissionMode.AUTO]
        assert host._starts[binding.id].session.permission_mode == PermissionMode.AUTO
        assert any(row.get("method") == "connect" and row.get("nativeId") == binding.native_session_id
                   for row in trace(root))
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_sdk_probe_reports_modes_without_submitting_a_task(tmp_path, monkeypatch):
    runtime, _project, root, host = await setup(tmp_path, monkeypatch, ExecutorId.CLAUDE)
    try:
        result = await host.probe()
        assert result.capabilities.permission_modes == [PermissionMode.ASK, PermissionMode.AUTO]
        assert not [row for row in trace(root) if row.get("method") == "query"]
    finally:
        await runtime.close()


@pytest.mark.parametrize("text,accepted", [("lost_ack", False), ("new_result", True)])
@pytest.mark.asyncio
async def test_sdk_unknown_outcome_is_not_completion_or_automatic_retry(tmp_path, monkeypatch, text, accepted):
    runtime, project, root, _ = await setup(tmp_path, monkeypatch, ExecutorId.CLAUDE)
    session = runtime.store.create_session(project.id, ExecutorId.CLAUDE)
    try:
        await runtime.submit(session.id, "request_unknown", text)
        run = await wait_run(runtime, session.id, RunStatus.UNKNOWN)
        assert (run.native_dispatch == "accepted") == accepted
        again = await runtime.submit(session.id, "request_unknown", text)
        assert again["reused"]
        assert len([r for r in trace(root) if r["method"] == "query"]) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_upstream_queued_receipt_does_not_leave_run_preparing(tmp_path, monkeypatch):
    from test_native_service import setup as native_setup
    service, adapter, store, session, _, _ = await native_setup(tmp_path)
    async def queue(_binding, input_id, _text):
        return DispatchReceipt(input_id=input_id, outcome="queued")
    monkeypatch.setattr(adapter, "send", queue)
    try:
        run = await service.submit(session.id, "request_queued", "work")
        result = await asyncio.wait_for(service.wait_for_dispatch(run.id), 2)
        assert result.status == RunStatus.UNKNOWN and result.native_dispatch == "unknown"
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_transport_unknown_is_http_503_not_definite_client_rejection(monkeypatch):
    monkeypatch.setattr("mona.development.api.is_valid_services_token", lambda value: value == "test-only-token")
    async def endpoint(_request):
        raise RpcError("transport_lost", "do not return native private text", outcome_unknown=True)
    app = web.Application(middlewares=[development_auth])
    app.router.add_post("/api/development/test", endpoint)
    async with TestClient(TestServer(app)) as client:
        response = await client.post("/api/development/test", headers={"X-Mona-Token": "test-only-token"})
        assert response.status == 503
        data = await response.json()
        assert data["error"]["code"] == "transport_lost"
        assert "private text" not in str(data)


@pytest.mark.parametrize("event_type", ["agent.message.delta", "reasoning.delta"])
@pytest.mark.asyncio
async def test_work_mode_long_text_deltas_preserve_content_and_terminal(tmp_path, event_type):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    count = 5001
    expected = "x" * count
    for index in range(count):
        runtime.emit(_delta(event_type, "turn-1", "item-1", "x", f"event-{index}"))
    runtime.emit(NativeEvent(type="run.completed", native_turn_id="turn-1",
                             native_event_id="terminal", payload={"status": "success"}))

    events = await _read_queued_events(host, binding, runtime)
    assert not any(event.type == "run.unknown" for event in events)
    assert any(event.type == "run.completed" and event.native_turn_id == "turn-1" for event in events)
    deltas = [event for event in events if event.type == event_type]
    assert 1 <= len(deltas) < count
    assert "".join(event.payload["delta"] for event in deltas) == expected
    assert max(len(event.payload["delta"]) for event in deltas) <= 16_384


@pytest.mark.asyncio
async def test_work_mode_deltas_do_not_merge_across_tool_item_or_turn_boundaries(tmp_path):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    runtime.emit(_delta("agent.message.delta", "turn-1", "item-a", "before-tool", "delta-1"))
    runtime.emit(NativeEvent(type="tool.started", native_turn_id="turn-1", native_event_id="tool-1",
                             payload={"itemId": "tool-1", "name": "mona_tool"}))
    runtime.emit(_delta("agent.message.delta", "turn-1", "item-a", "after-tool", "delta-2"))
    runtime.emit(_delta("agent.message.delta", "turn-1", "item-b", "other-item", "delta-3"))
    runtime.emit(NativeEvent(type="run.completed", native_turn_id="turn-1",
                             native_event_id="terminal-1", payload={"status": "success"}))
    runtime.turn_id = "turn-2"
    runtime.status = "running"
    runtime.emit(_delta("agent.message.delta", "turn-2", "item-a", "next-turn", "delta-4"))
    runtime.emit(NativeEvent(type="run.completed", native_turn_id="turn-2",
                             native_event_id="terminal-2", payload={"status": "success"}))

    events = await _read_queued_events(host, binding, runtime)
    deltas = [event for event in events if event.type == "agent.message.delta"]
    assert [(event.native_turn_id, event.payload["itemId"], event.payload["delta"]) for event in deltas] == [
        ("turn-1", "item-a", "before-tool"),
        ("turn-1", "item-a", "after-tool"),
        ("turn-1", "item-b", "other-item"),
        ("turn-2", "item-a", "next-turn"),
    ]
    assert [event.type for event in events].count("tool.started") == 1
    assert [event.native_turn_id for event in events if event.type == "run.completed"] == ["turn-1", "turn-2"]


@pytest.mark.asyncio
async def test_consumed_work_delta_is_not_mutated_and_code_mode_keeps_native_event_ids(tmp_path):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    stream = host.events(binding)
    runtime.emit(_delta("agent.message.delta", "turn-1", "item-1", "consumed", "work-1"))
    consumed = await anext(stream)
    runtime.emit(_delta("agent.message.delta", "turn-1", "item-1", "pending", "work-2"))
    pending = await anext(stream)
    await stream.aclose()

    assert consumed.payload["delta"] == "consumed"
    assert consumed.native_event_id == "work-1"
    assert pending.payload["delta"] == "pending"
    assert pending.native_event_id == "work-2"

    code_host, code_binding, code_runtime = _event_host(tmp_path / "code", work_mode=False)
    code_runtime.emit(_delta("agent.message.delta", "turn-1", "item-1", "one", "code-1"))
    code_runtime.emit(_delta("agent.message.delta", "turn-1", "item-1", "two", "code-2"))
    code_events = await _read_queued_events(code_host, code_binding, code_runtime)
    assert [event.native_event_id for event in code_events] == ["code-1", "code-2"]
    assert [event.payload["delta"] for event in code_events] == ["one", "two"]
