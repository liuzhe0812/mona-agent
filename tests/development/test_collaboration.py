import asyncio
import sqlite3

import pytest
from pydantic import ValidationError
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.config.schema import DevelopmentSubagentConfig
from mona.development.collaboration import DevelopmentDelegate
from mona.development.contracts import Collaboration, DevelopmentSession, ExecutorId, RunStatus
from mona.development.store import ConflictError, DevelopmentStore


@pytest.mark.asyncio
async def test_worker_cannot_create_a_nested_collaboration_even_with_enabled_presets(tmp_path, monkeypatch):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        task = await runtime.collaboration.start_preset(parent.id, "worker_request", "builtin_worker", "Inspect a file")
        await wait_done(runtime, task["childSessionId"])
        child = runtime.store.get_session(task["childSessionId"])
        assert not child.readonly
        count = len(model.requests)
        with pytest.raises(ConflictError):
            await runtime.collaboration.start_preset(child.id, "nested_request", "builtin_worker", "Inspect another file")
        assert len(runtime.store.list_sessions(project.id)) == 2
        assert runtime.store.list_collaborations(child.id) == [] and len(model.requests) == count
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_collaboration_progress_uses_public_output_from_the_current_child_run(tmp_path, monkeypatch):
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    try:
        child = runtime.store.create_session(project.id, parent_session_id=parent.id)
        run, _ = runtime.store.create_run(child.id, "progress_request", "progress_message")
        run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        run = runtime.store.transition_run(run.id, run.revision, RunStatus.RUNNING)
        record = Collaboration(parent_session_id=parent.id, child_session_id=child.id,
            request_id=run.request_id, request_fingerprint="progress", goal="核对列表", expected_output="", readonly=True)
        history = runtime.sessions.get_or_create(child.transcript_key)
        history.add_message("assistant", "旧轮次输出", run_id="older_run")
        history.add_message("assistant", [
            {"type": "thinking", "thinking": "不应显示的内部字段"},
            {"type": "text", "text": "正在核对公开接口"},
        ], run_id=run.id)
        runtime.live[child.id] = {"runId": "another_run", "content": "其他轮次输出"}
        assert runtime.collaboration.describe(record)["progress"] == "正在核对公开接口"
        runtime.live[child.id] = {"runId": run.id, "content": "正在检查\n  列表布局"}
        assert runtime.collaboration.describe(record)["progress"] == "正在检查 列表布局"
        runtime.store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
        assert runtime.collaboration.describe(record)["progress"] is None
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_delegation_has_independent_readonly_session_and_idempotent_return(tmp_path, monkeypatch):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        packet = await runtime.collaboration.start(parent.id, "request_review", ExecutorId.MONA, "审查已有文件", readonly=True)
        await wait_done(runtime, packet["childSessionId"])
        first = await runtime.collaboration.observe(parent.id)
        second = await runtime.collaboration.observe(parent.id)
        repeated = await runtime.collaboration.start(parent.id, "request_review", ExecutorId.MONA, "审查已有文件", readonly=True)
        assert repeated["id"] == packet["id"] and len(first) == len(second) == 1
        assert first[0]["title"] == runtime.store.get_session(packet["childSessionId"]).title
        assert first[0]["createdAt"] and first[0]["latestRun"]["finishedAt"]
        child = runtime.store.get_session(packet["childSessionId"])
        child_history = runtime.sessions.get_or_create(child.transcript_key)
        context_ids = {m["id"] for m in child_history.messages if m.get("_collaboration_context")}
        assert context_ids
        assert not context_ids.intersection(m["id"] for m in runtime.snapshot(child.id)["messages"])
        assert len(runtime.store.list_sessions(project.id)) == 2
        transcript = runtime.sessions.get_or_create(parent.transcript_key)
        returned = [m for m in transcript.messages if m.get("source_kind") == "collaboration"]
        assert len(returned) == 1 and returned[0]["author_id"] == "mona"
        assert not runtime.store.list_runs(parent.id)
        definitions = model.requests[0]["tools"]
        assert {d["function"]["name"] for d in definitions} == {"read_file", "list_dir", "grep", "find_files"}
        assert "PROJECT_RULE_SENTINEL" in str(model.requests[0]["messages"])
        with pytest.raises(ConflictError):
            await runtime.collaboration.start(parent.id, "request_review", ExecutorId.MONA, "different", readonly=True)
        with pytest.raises(ConflictError):
            await runtime.collaboration.start(packet["childSessionId"], "request_recursive", ExecutorId.MONA, "must not recurse")
        # Delivery survives a crash between transcript fsync and metadata commit.
        with sqlite3.connect(runtime.store.path) as db:
            db.execute("UPDATE collaborations SET payload=json_set(payload,'$.return_message_id',NULL)")
        await runtime.collaboration.observe(parent.id)
        assert len([m for m in transcript.messages if m.get("source_kind") == "collaboration"]) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_tool_starts_collaborator_without_room_or_project_lock(tmp_path, monkeypatch):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    try:
        tool = DevelopmentDelegate(runtime.collaboration, parent.id)
        runtime.store.save_subagents(project.id, 0, [DevelopmentSubagentConfig(
            id="researcher", name="Researcher", description="调查代码问题", instructions="读取代码并给出证据", readonly=True)])
        with pytest.raises(ValidationError):
            await tool.execute("start", request_id="bypass", executor="mona", goal="不应绕过配置")
        assert not runtime.tasks
        first, second = await asyncio.gather(
            tool.execute("start", request_id="request_first", preset_id="researcher", goal="调查一个问题"),
            tool.execute("start", request_id="request_second", preset_id="researcher", goal="调查另一个问题"))
        assert "childSessionId" in first and "childSessionId" in second
        async with asyncio.timeout(5):
            while runtime.tasks:
                await asyncio.sleep(0.01)
        records = await runtime.collaboration.observe(parent.id)
        assert len(records) == 2 and len(runtime.store.list_sessions(project.id)) == 3
        assert all(r["latestRun"]["status"] == "succeeded" for r in records)
        assert not runtime.store.list_runs(parent.id)
        other = runtime.store.create_session(project.id)
        with pytest.raises(ConflictError):
            await runtime.collaboration.wait(other.id, records[0]["id"], 1)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_wait_returns_the_durable_delivery_marker_when_it_delivers_first(tmp_path, monkeypatch):
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    # Deterministically let wait(), not the background observer, deliver first.
    monkeypatch.setattr(runtime.collaboration, "_monitor", lambda _record: None)
    try:
        packet = await runtime.collaboration.start(parent.id, "wait_first", ExecutorId.MONA, "只读核对", readonly=True)
        await wait_done(runtime, packet["childSessionId"])
        assert runtime.store.get_collaboration(packet["id"]).return_message_id is None
        first = await runtime.collaboration.wait(parent.id, packet["id"], 2)
        record = runtime.store.get_collaboration(packet["id"])
        assert first["returnMessageId"] == record.return_message_id and record.return_message_id
        runtime.sessions.invalidate(parent.transcript_key)
        saved = runtime.sessions.get_or_create(parent.transcript_key)
        assert len([m for m in saved.messages if m.get("id") == first["returnMessageId"]]) == 1
        assert (await runtime.collaboration.wait(parent.id, packet["id"], 2))["returnMessageId"] == first["returnMessageId"]
        assert len(runtime.store.list_runs(packet["childSessionId"])) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_cancelled_start_before_run_is_failed_delivered_and_reused(tmp_path, monkeypatch):
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    runtime.config_loader().development.max_parallel_subagents = 1
    prepared = {}
    submit_entered = asyncio.Event()
    submit_release = asyncio.Event()
    delivery_entered = asyncio.Event()
    delivery_release = asyncio.Event()
    gate_parent_delivery = False
    original_prepare = runtime.store.prepare_collaboration
    original_lock = runtime._lock
    original_save = runtime.sessions.save
    parent_save_failures = 0

    def capture_prepare(*args, **kwargs):
        record, created = original_prepare(*args, **kwargs)
        if created and "record" not in prepared:
            prepared["record"] = record
        return record, created

    def fail_first_parent_fsync(session, *, fsync=False):
        nonlocal parent_save_failures
        if session.key == parent.transcript_key and fsync and parent_save_failures == 0:
            parent_save_failures += 1
            raise OSError("simulated transcript persistence failure")
        return original_save(session, fsync=fsync)

    class GatedLock:
        def __init__(self, lock, entered, release):
            self.lock, self.entered, self.release = lock, entered, release

        async def __aenter__(self):
            self.entered.set()
            await self.release.wait()
            return await self.lock.__aenter__()

        async def __aexit__(self, exc_type, exc, tb):
            return await self.lock.__aexit__(exc_type, exc, tb)

    def controlled_lock(session_id):
        lock = original_lock(session_id)
        record = prepared.get("record")
        if record and session_id == record.child_session_id:
            return GatedLock(lock, submit_entered, submit_release)
        if record and gate_parent_delivery and session_id == parent.id:
            return GatedLock(lock, delivery_entered, delivery_release)
        return lock

    monkeypatch.setattr(runtime.store, "prepare_collaboration", capture_prepare)
    monkeypatch.setattr(runtime, "_lock", controlled_lock)
    request = (parent.id, "cancel_before_run", ExecutorId.MONA, "只读核对", "", True)
    task = asyncio.create_task(runtime.collaboration.start(*request))
    try:
        await asyncio.wait_for(submit_entered.wait(), 2)
        record = prepared["record"]
        assert record.state == "prepared"
        assert runtime.store.find_run_request(record.child_session_id, record.request_id) is None

        parent = runtime.store.update_session(parent.id, parent.revision, archived=True)
        monkeypatch.setattr(runtime.sessions, "save", fail_first_parent_fsync)
        gate_parent_delivery = True
        task.cancel()
        await asyncio.wait_for(delivery_entered.wait(), 2)
        delivery = runtime.collaboration.monitors[record.id]
        assert runtime.store.get_collaboration(record.id).state == "failed"
        assert runtime.store.find_run_request(record.child_session_id, record.request_id) is None

        # A second cancellation can stop the caller without cancelling its durable delivery task.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        delivery_release.set()
        with pytest.raises(OSError, match="simulated transcript persistence failure"):
            await asyncio.wait_for(delivery, 2)
        await asyncio.sleep(0)  # Let the monitor callback persist its failure state.

        failed = runtime.store.get_collaboration(record.id)
        assert failed.state == "failed" and failed.return_message_id is None
        assert runtime.store.find_run_request(record.child_session_id, record.request_id) is None
        assert len(runtime.store.list_sessions(project.id)) == 2

        recovered = await runtime.collaboration.observe(parent.id)
        assert recovered[0]["returnMessageId"] == f"return_{record.id}"
        assert parent_save_failures == 1
        runtime.sessions.invalidate(parent.transcript_key)
        transcript = runtime.sessions.get_or_create(parent.transcript_key)
        returned = [message for message in transcript.messages if message.get("id") == f"return_{record.id}"]
        assert len(returned) == 1 and returned[0]["_ui_only"]
        assert not runtime.store.list_runs(parent.id)

        repeated = await runtime.collaboration.start(*request)
        assert repeated["id"] == record.id
        assert runtime.store.list_runs(record.child_session_id) == []
        assert len(runtime.store.list_sessions(project.id)) == 2
        parent = runtime.store.update_session(parent.id, parent.revision, archived=False)

        # The failed, undispatched row no longer consumes the project's sole slot.
        next_task = await runtime.collaboration.start(parent.id, "next_request", ExecutorId.MONA,
                                                       "另一项只读核对", readonly=True)
        await wait_done(runtime, next_task["childSessionId"])
        assert runtime.store.find_run_request(next_task["childSessionId"], "next_request") is not None
        assert len(runtime.store.list_sessions(project.id)) == 3
    finally:
        submit_release.set()
        delivery_release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await runtime.close()


@pytest.mark.asyncio
async def test_cancelled_start_after_submit_keeps_the_original_run(tmp_path, monkeypatch):
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    submitted = asyncio.Event()
    release = asyncio.Event()
    original_submit = runtime.submit
    submit_calls = 0

    async def pause_after_real_submit(*args, **kwargs):
        nonlocal submit_calls
        submit_calls += 1
        result = await original_submit(*args, **kwargs)
        submitted.set()
        await release.wait()
        return result

    monkeypatch.setattr(runtime, "submit", pause_after_real_submit)
    task = asyncio.create_task(runtime.collaboration.start(
        parent.id, "cancel_after_submit", ExecutorId.MONA, "只读核对", readonly=True))
    try:
        await asyncio.wait_for(submitted.wait(), 2)
        record = runtime.store.find_collaboration_request(parent.id, "cancel_after_submit")
        run = runtime.store.find_run_request(record.child_session_id, record.request_id)
        assert run is not None

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await wait_done(runtime, record.child_session_id)

        repeated = await runtime.collaboration.start(
            parent.id, "cancel_after_submit", ExecutorId.MONA, "只读核对", readonly=True)
        observed = await runtime.collaboration.observe(parent.id)
        final_run = runtime.store.find_run_request(record.child_session_id, record.request_id)
        assert repeated["id"] == record.id
        assert final_run.id == run.id and len(runtime.store.list_runs(record.child_session_id)) == 1
        assert submit_calls == 1 and observed[0]["returnMessageId"] == f"return_{record.id}"
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await runtime.close()


@pytest.mark.asyncio
async def test_restart_closes_unsubmitted_preparation_without_dispatching(tmp_path, monkeypatch):
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, Model())
    child = DevelopmentSession(project_id=project.id, parent_session_id=parent.id, readonly=True)
    # Seed the durable boundary that a process exit can leave before submit.
    record, _ = runtime.store.prepare_collaboration(parent.id, "restart_prepare", "pending", child,
        goal="Inspect source", expected_output="Findings")
    try:
        runtime.store.reconcile_after_restart()
        assert runtime.store.get_collaboration(record.id).state == "failed"
        observed = await runtime.collaboration.observe(parent.id)
        assert observed[0]["id"] == record.id and observed[0]["returnMessageId"] == f"return_{record.id}"
        assert runtime.store.list_runs(child.id) == [] and not runtime.tasks
        assert len(runtime.store.list_sessions(project.id)) == 2
        runtime.store.reconcile_after_restart()
        assert (await runtime.collaboration.observe(parent.id))[0]["returnMessageId"] == f"return_{record.id}"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_restart_preserves_prepared_collaboration_with_existing_run_as_unknown(tmp_path, monkeypatch):
    model = Model()
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    child = DevelopmentSession(project_id=project.id, parent_session_id=parent.id, readonly=True)
    record, _ = runtime.store.prepare_collaboration(parent.id, "restart_submitted", "pending", child,
        goal="Inspect source", expected_output="Findings")
    run, _ = runtime.store.create_run(child.id, record.request_id, "child_request")
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    runtime.store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    try:
        assert runtime.store.reconcile_after_restart() == 1
        observed = (await runtime.collaboration.observe(parent.id))[0]
        assert observed["state"] == "prepared" and observed["returnMessageId"] is None
        assert observed["latestRun"]["id"] == run.id and observed["latestRun"]["status"] == "unknown"
        assert len(runtime.store.list_runs(child.id)) == 1 and not runtime.tasks and not model.requests
        assert runtime.store.reconcile_after_restart() == 0
    finally:
        await runtime.close()


def test_schema_one_migration_preserves_existing_sessions(tmp_path):
    path = tmp_path / "state.sqlite3"
    root = tmp_path / "project"
    root.mkdir()
    original = DevelopmentStore(path)
    project = original.open_project(root)
    session = original.create_session(project.id)
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE collaborations")
        db.execute("PRAGMA user_version=1")
    upgraded = DevelopmentStore(path)
    assert upgraded.get_session(session.id) == session
    assert upgraded.list_collaborations(session.id) == []
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 3
