"""Recovery of inputs that were never dispatched across a host restart."""

import asyncio

import pytest

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import (
    Binding,
    DevelopmentSession,
    ExecutorId,
    InputState,
    RunInput,
    RunStatus,
)
from mona.development.runtime import DevelopmentRuntime, stable_id
from mona.development.store import DevelopmentStore
from mona.session.manager import SessionManager


def make_store(tmp_path, executor=ExecutorId.MONA):
    _resolve_tool_config_refs()
    root = tmp_path / "project"
    root.mkdir()
    store = DevelopmentStore(tmp_path / "development.sqlite3")
    project = store.open_project(root)
    session = store.create_session(project.id, executor)
    binding_id = None
    if executor != ExecutorId.MONA:
        binding = store.activate_binding(Binding(session_id=session.id, executor=executor,
            native_session_id="fixture-native-session", working_directory=str(root)), session.revision)
        binding_id = binding.id
    return store, session, binding_id


def make_runtime(store, tmp_path, config=None):
    config = config or Config()
    return DevelopmentRuntime(DevelopmentStore(store.path), SessionManager(tmp_path / "history"), lambda: config)


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", [ExecutorId.MONA, ExecutorId.CODEX])
@pytest.mark.parametrize("persisted_message", [False, True])
async def test_queued_crash_is_closed_as_unsent_without_replaying(tmp_path, executor, persisted_message):
    store, session, binding_id = make_store(tmp_path, executor)
    request_id = "original_request"
    message_id = stable_id("message", session.id, request_id)
    run, _ = store.create_run(session.id, request_id, message_id, binding_id)
    if persisted_message:
        sessions = SessionManager(tmp_path / "history")
        transcript = sessions.get_or_create(session.transcript_key)
        transcript.add_message("user", "original", id=message_id, run_id=run.id,
            _input_source={"content": "original", "docPaths": [], "documentNames": []})
        sessions.save(transcript, fsync=True)

    runtime = make_runtime(store, tmp_path)
    try:
        restored = runtime.store.get_run(run.id)
        assert restored.status == RunStatus.FAILED
        assert restored.error_code == "host_restarted_before_dispatch"
        assert restored.finished_at is not None
        assert runtime.store.active_run(session.id) is None
        repeated = await runtime.submit(session.id, request_id, "original")
        assert repeated["reused"] and repeated["run"]["id"] == run.id
        assert repeated["run"]["status"] == "failed"
        assert (await runtime.interrupt(session.id, run.id)).status == RunStatus.FAILED
        next_run, created = runtime.store.create_run(session.id, "new_request", "new_message", binding_id)
        assert created and next_run.id != run.id
        assert not runtime.tasks
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_queued_crash_preserves_reserved_followup_without_dispatch(tmp_path, monkeypatch):
    store, session, _ = make_store(tmp_path)
    run, _ = store.create_run(session.id, "owner", "owner_message")
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    item = store.enqueue_input(RunInput(id="followup", session_id=session.id, run_id=run.id,
        message_id=stable_id("message", session.id, "followup")))
    run = store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    store.reserve_follow_up(item.id, item.revision)
    dispatch, _ = store.create_run(session.id, item.id, item.message_id)

    sessions = SessionManager(tmp_path / "history")
    transcript = sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "keep this", id=item.message_id, _ui_only=True,
        _input_source={"content": "keep this", "docPaths": [], "documentNames": []})
    sessions.save(transcript, fsync=True)

    runtime = make_runtime(store, tmp_path)
    async def no_dispatch(*_args, **_kwargs):
        pytest.fail("a previously journaled request must not be redispatched")
    monkeypatch.setattr(runtime, "_dispatch_start", no_dispatch)
    try:
        assert runtime.store.get_run(dispatch.id).status == RunStatus.FAILED
        restored = runtime.store.get_input(item.id)
        assert restored.state == InputState.PENDING
        await runtime._next_input(session.id, run.id)
        assert runtime.store.get_input(item.id).state == InputState.PENDING
        assert runtime.snapshot(session.id)["pendingInputs"][0]["id"] == item.id
        await runtime.cancel_input(session.id, item.id)
        assert runtime.store.get_input(item.id).state == InputState.CANCELLED
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_queued_crash_does_not_replay_internal_result_continuation(tmp_path):
    store, session, _ = make_store(tmp_path)
    run, _ = store.create_run(session.id, "owner", "owner_message")
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    child = DevelopmentSession(project_id=session.project_id, parent_session_id=session.id)
    record, _ = store.prepare_collaboration(session.id, "child", "fingerprint", child,
        goal="inspect", expected_output="", parent_run_id=run.id, required=True)
    store.set_collaboration_state(record.id, "failed")
    store.mark_collaboration_returned(record.id, "returned_message")
    run = store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    item = store.prepare_result_continuation(run.id, "result_request", "result_message")
    store.reserve_follow_up(item.id, item.revision)
    dispatch, _ = store.create_run(session.id, item.id, item.message_id)

    runtime = make_runtime(store, tmp_path)
    try:
        await asyncio.sleep(0)
        assert runtime.store.get_run(dispatch.id).status == RunStatus.FAILED
        assert runtime.store.get_input(item.id).state == InputState.REJECTED
        assert runtime.store.pending_result_runs() == []
        assert not runtime.tasks
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_disabled_native_source_preserves_editable_queue(tmp_path, monkeypatch):
    store, session, binding_id = make_store(tmp_path, ExecutorId.CODEX)
    run, _ = store.create_run(session.id, "owner", "owner_message", binding_id)
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    item = store.enqueue_input(RunInput(id="followup", session_id=session.id, run_id=run.id,
        message_id=stable_id("message", session.id, "followup")))
    run = store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    source = {"content": "keep this", "docPaths": ["upload/fixture.png"], "documentNames": ["fixture.png"]}
    sessions = SessionManager(tmp_path / "history")
    transcript = sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "keep this", id=item.message_id, _ui_only=True, _input_source=source)
    sessions.save(transcript, fsync=True)

    config = Config()
    config.development.enabled_engines = []
    runtime = make_runtime(store, tmp_path, config)
    async def no_dispatch(*_args, **_kwargs):
        pytest.fail("the disabled source must not receive a follow-up")
    monkeypatch.setattr(runtime, "_dispatch_start", no_dispatch)
    try:
        await runtime._next_input(session.id, run.id)
        restored = runtime.store.get_input(item.id)
        assert restored.state == InputState.PENDING and restored.revision == item.revision
        pending = runtime.snapshot(session.id)["pendingInputs"]
        assert len(pending) == 1 and pending[0]["id"] == item.id and pending[0]["source"] == source
        assert runtime.store.find_run_request(session.id, item.id) is None
        config.development.enabled_engines = ["codex"]
        repeated = await runtime.submit(session.id, item.id, source["content"],
            doc_paths=source["docPaths"], document_names=source["documentNames"])
        assert repeated["reused"] and repeated["input"]["state"] == "pending"
        assert runtime.store.find_run_request(session.id, item.id) is None
        await runtime.cancel_input(session.id, item.id)
        assert runtime.store.get_input(item.id).state == InputState.CANCELLED
    finally:
        await runtime.close()
