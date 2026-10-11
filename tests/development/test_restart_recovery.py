"""Cold recovery observes old execution, never resends it or stops a successor."""
import asyncio
import json
import sqlite3
from dataclasses import replace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_service import setup as setup_service
from test_native_workbench import setup, trace, wait_run
from test_workbench_api import AUTH
from test_workbench_runtime import Model, make_runtime

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.codex import CodexExecutor
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentStore
from mona.session.manager import SessionManager


async def restart(runtime, root, host, run):
    """Retain the pre-crash DB state; the replacement peer owns no old work."""
    await runtime.close()
    with sqlite3.connect(runtime.store.path) as db:
        db.execute("UPDATE runs SET status=?,payload=? WHERE id=?", (run.status.value, run.model_dump_json(), run.id))
    path = root / "peer-state.json"
    state = json.loads(path.read_text(encoding="utf8"))
    for thread in state["threads"].values():
        thread["status"] = {"type": "idle"}
    path.write_text(json.dumps(state), encoding="utf8")
    restored = DevelopmentRuntime(DevelopmentStore(runtime.store.path), SessionManager(root.parent / "history"), runtime.config_loader)
    adapter = CodexExecutor(host.profile, request_timeout=2)
    project_id = restored.store.get_session(run.session_id).project_id
    restored.native.hosts[(project_id, ExecutorId.CODEX)] = adapter
    return restored


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["normal", "codex_modern"])
async def test_snapshot_closes_idle_interrupted_tracking_once_without_replaying(tmp_path, monkeypatch, mode):
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-development-test")
    runtime, project, root, host = await setup(tmp_path)
    host.profile = replace(host.profile, command=(*host.profile.command, mode))
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(session.id, "original_request", "hold")
    run = await wait_run(runtime, session.id, RunStatus.RUNNING)
    manual = root / "manual.txt"
    manual.write_text("preserve human changes", encoding="utf8")
    runtime = await restart(runtime, root, host, run)
    assert runtime.store.get_run(run.id).error_code == "host_restarted"
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        path = f"/api/development/sessions/{session.id}/snapshot"
        first = await client.get(path, headers=AUTH)
        assert first.status == 200
        await wait_run(runtime, session.id, RunStatus.CLOSED_UNKNOWN)
        snapshot = await (await client.get(path, headers=AUTH)).json()
        assert snapshot["runs"][0]["status"] == "closed_unknown"
        assert snapshot["nativeBinding"] is None
        assert runtime.store.active_run(session.id) is None
        assert (await runtime.interrupt(session.id, run.id)).id == run.id
        repeat = await runtime.submit(session.id, run.request_id, "hold")
        assert repeat["reused"] and repeat["run"]["id"] == run.id
        assert manual.read_text(encoding="utf8") == "preserve human changes"
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
        assert sum(call.get("method") == "thread/resume" for call in trace(root)) == 1
        assert len(runtime.store.list_runs(session.id)) == 1
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_completed_original_history_restores_result_without_draining_queued_work(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(session.id, "original_request", "history_only")
    run = await wait_run(runtime, session.id, RunStatus.RUNNING)
    queued = await runtime.submit(session.id, "queued_request", "instant")
    assert queued["queued"]
    runtime = await restart(runtime, root, host, run)
    try:
        runtime.schedule_recovery(session.id)
        runtime.schedule_recovery(session.id)
        await wait_run(runtime, session.id, RunStatus.SUCCEEDED)
        assert any(message["content"] == "Recovered native result" for message in runtime.snapshot(session.id)["messages"])
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
        assert len(runtime.store.list_runs(session.id)) == 1
        assert runtime.store.get_input("queued_request").state.value == "pending"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_live_turn_can_be_stopped_by_original_identity_when_history_is_unsupported(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    host.profile = replace(host.profile, command=(*host.profile.command, "codex_modern"))
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    other = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "original_request", "hold")
        run = await wait_run(runtime, session.id, RunStatus.RUNNING)
        host._runtime(runtime.store.get_binding(run.binding_id)).fault("native_event_stream_failed")
        run = await wait_run(runtime, session.id, RunStatus.UNKNOWN)
        with pytest.raises(ConflictError):
            await runtime.interrupt(other.id, run.id)
        await runtime.interrupt(session.id, run.id)
        await wait_run(runtime, session.id, RunStatus.INTERRUPTED)
        calls = trace(root)
        interrupted = next(call for call in calls if call.get("method") == "turn/interrupt")
        assert interrupted["params"]["turnId"] == run.native_turn_id
        assert sum(call.get("method") == "turn/start" for call in calls) == 1
        assert not runtime.store.list_runs(other.id)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_mona_stop_after_restart_closes_tracking_without_claiming_result_or_replaying(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)
    reply = await runtime.submit(session.id, "original_request", "hold")
    await model.entered.wait()
    await runtime.close()
    runtime = DevelopmentRuntime(runtime.store, SessionManager(tmp_path / "transcripts"), runtime.config_loader)
    try:
        result = await runtime.interrupt(session.id, reply["run"]["id"])
        assert result.status == RunStatus.CLOSED_UNKNOWN
        assert result.result_message_id is None and result.error_code == "host_shutdown"
        assert runtime.store.active_run(session.id) is None
        assert (await runtime.interrupt(session.id, result.id)) == result
        repeat = await runtime.submit(session.id, "original_request", "hold")
        assert repeat["reused"] and repeat["run"]["status"] == "closed_unknown"
        assert len(model.requests) == 1 and not runtime.tasks
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_live_original_turn_reconciles_repeatedly_without_replaying_started_event(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "original_request", "hold")
        run = await wait_run(runtime, session.id, RunStatus.RUNNING)
        for _ in range(2):
            run = runtime.store.transition_run(run.id, run.revision, RunStatus.UNKNOWN)
            run = await runtime.native.recover(session.id, run.id)
            assert run.status == RunStatus.RUNNING
        await runtime.interrupt(session.id, run.id)
        await wait_run(runtime, session.id, RunStatus.INTERRUPTED)
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_missing_in_memory_dispatch_after_restart_does_not_prove_request_unsent(tmp_path):
    service, host, store, session, binding, _ = await setup_service(tmp_path)
    try:
        run, _ = store.create_run(session.id, "lost_request", "old_message", binding.id)
        run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        run = store.transition_run(run.id, run.revision, RunStatus.UNKNOWN, error_code="host_restarted")
        result = await service.interrupt(run.id)
        assert result.status == RunStatus.UNKNOWN
        assert result.finished_at is None
        assert not any(call.get("method") == "turn/start" for call in trace(host.profile.project_root))
    finally:
        await service.close()
        await host.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("native_status", ["idle", "active", "systemError"])
async def test_restart_without_turn_id_closes_tracking_only_after_native_idle(tmp_path, monkeypatch, native_status):
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-development-test")
    runtime, project, root, host = await setup(tmp_path)
    host.profile = replace(host.profile, command=(*host.profile.command, "codex_modern"))
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(session.id, "completed_request", "instant")
    await wait_run(runtime, session.id, RunStatus.SUCCEEDED)
    binding = runtime.store.list_bindings(session.id)[0]
    run, _ = runtime.store.create_run(session.id, "lost_request", "lost_message", binding.id)
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    runtime.store.transition_run(run.id, run.revision, RunStatus.UNKNOWN, error_code="native_event_stream_failed")
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "preserve original question", id="lost_message", run_id=run.id)
    runtime.sessions.save(transcript, fsync=True)
    await runtime.close()
    path = root / "peer-state.json"
    state = json.loads(path.read_text(encoding="utf8"))
    state["threads"][binding.native_session_id]["status"] = {"type": native_status}
    path.write_text(json.dumps(state), encoding="utf8")
    restored = DevelopmentRuntime(DevelopmentStore(runtime.store.path), runtime.sessions, runtime.config_loader)
    restored.native.hosts[(project.id, ExecutorId.CODEX)] = CodexExecutor(host.profile, request_timeout=2)
    app = web.Application()
    app[RUNTIME_KEY] = restored
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.get(f"/api/development/sessions/{session.id}/snapshot", headers=AUTH)
        assert response.status == 200
        async with asyncio.timeout(5):
            while restored._recovery_tasks:
                await asyncio.sleep(.01)
        result = restored.store.get_run(run.id)
        expected = RunStatus.CLOSED_UNKNOWN if native_status == "idle" else RunStatus.UNKNOWN
        assert result.status == expected and result.native_turn_id is None and result.result_message_id is None
        assert restored.store.get_binding(binding.id).state == ("stale" if native_status == "idle" else "active")
        repeated = await restored.submit(session.id, "lost_request", "preserve original question")
        assert repeated["reused"] and repeated["run"]["id"] == run.id
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
        assert not restored.tasks
        assert any(message.get("id") == "lost_message" for message in restored.sessions.get_or_create(session.transcript_key).messages)
    finally:
        await client.close()
        await restored.close()
