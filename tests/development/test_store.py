import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import ValidationError

from mona.development.contracts import (
    Binding,
    DevelopmentView,
    ExecutorId,
    InputState,
    Pane,
    RunInput,
    RunStatus,
)
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError


@pytest.fixture
def store(tmp_path):
    return DevelopmentStore(tmp_path / "state" / "development.sqlite3")


@pytest.fixture
def project(store, tmp_path):
    root = tmp_path / "中文 项目"
    root.mkdir()
    (root / "user.py").write_text("# manual work\n", encoding="utf-8")
    return store.open_project(root)


def running(store, session_id, suffix="one"):
    run, created = store.create_run(session_id, f"request_{suffix}", f"message_{suffix}")
    assert created
    run = store.transition_run(run.id, 0, RunStatus.PREPARING)
    return store.transition_run(run.id, run.revision, RunStatus.RUNNING)


def test_project_open_is_canonical_idempotent_and_never_modifies_source(store, project):
    root = Path(project.root_path)
    before = (root / "user.py").read_bytes()
    reopened = store.open_project(root / ".", "My project")
    assert reopened.id == project.id
    assert reopened.display_name == "My project"
    assert (root / "user.py").read_bytes() == before
    assert list(root.iterdir()) == [root / "user.py"]
    assert len(store.list_projects()) == 1


def test_invalid_project_is_not_inserted(store, tmp_path):
    with pytest.raises(DevelopmentError):
        store.open_project(tmp_path / "missing")
    file = tmp_path / "file.txt"
    file.write_text("x")
    with pytest.raises(DevelopmentError):
        store.open_project(file)
    assert store.list_projects() == []


@pytest.mark.parametrize("executor", list(ExecutorId))
def test_each_executor_supports_many_concurrent_sessions_same_project(store, project, executor):
    sessions = [store.create_session(project.id, executor) for _ in range(4)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        runs = list(pool.map(lambda s: running(store, s.id), sessions))
    assert len({run.id for run in runs}) == 4
    assert all(run.status == RunStatus.RUNNING for run in runs)
    assert all(run.executor == executor for run in runs)
    assert len({s.transcript_key for s in sessions}) == 4


def test_duplicate_request_is_atomic_and_conflicting_content_is_rejected(store, project):
    session = store.create_session(project.id)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: store.create_run(session.id, "request_one", "message_one"), range(4)))
    assert sum(created for _, created in results) == 1
    assert len({run.id for run, _ in results}) == 1
    with pytest.raises(ConflictError):
        store.create_run(session.id, "request_one", "message_changed")
    with pytest.raises(ConflictError):
        store.create_run(session.id, "request_two", "message_two")
    assert [e.type for e in store.events_after(session.id)] == ["session.created", "run.queued"]


def test_stale_and_late_terminal_updates_do_not_change_run_or_events(store, project):
    session = store.create_session(project.id)
    run = running(store, session.id)
    with pytest.raises(ConflictError):
        store.transition_run(run.id, 0, RunStatus.SUCCEEDED)
    run = store.transition_run(run.id, run.revision, RunStatus.INTERRUPTING)
    run = store.transition_run(run.id, run.revision, RunStatus.INTERRUPTED)
    before = store.events_after(session.id)
    with pytest.raises(ConflictError):
        store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    assert store.get_run(run.id).status == RunStatus.INTERRUPTED
    assert store.events_after(session.id) == before
    next_run, created = store.create_run(session.id, "request_next", "message_next")
    assert created and next_run.id != run.id


def test_completion_can_win_interrupt_race_only_with_current_revision(store, project):
    session = store.create_session(project.id)
    run = running(store, session.id)
    run = store.transition_run(run.id, run.revision, RunStatus.INTERRUPTING)
    run = store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    assert run.finished_at is not None
    with pytest.raises(ConflictError):
        store.transition_run(run.id, run.revision, RunStatus.INTERRUPTED)


def test_resume_uses_existing_binding_and_parks_others(store, project):
    session = store.create_session(project.id)
    codex = Binding(session_id=session.id, executor=ExecutorId.CODEX,
                    native_session_id="native-codex-thread", working_directory=project.root_path)
    codex = store.activate_binding(codex, 0)
    buddy = Binding(session_id=session.id, executor=ExecutorId.CODEBUDDY,
                    native_session_id="native-buddy-thread", working_directory=project.root_path)
    buddy = store.activate_binding(buddy, 1)
    bindings = {b.id: b for b in store.list_bindings(session.id)}
    assert bindings[codex.id].state == "parked"
    assert bindings[buddy.id].state == "active"
    recovered = store.activate_binding(bindings[codex.id], 2)
    assert recovered.id == codex.id
    assert recovered.native_session_id == codex.native_session_id
    assert store.get_session(session.id).id == session.id
    assert sum(b.state == "active" for b in store.list_bindings(session.id)) == 1
    assert len(store.list_bindings(session.id)) == 2


def test_native_thread_cannot_be_attached_to_two_product_sessions(store, project):
    first, second = [store.create_session(project.id) for _ in range(2)]
    binding = Binding(session_id=first.id, executor=ExecutorId.CODEX,
                      native_session_id="one-native-thread", working_directory=project.root_path)
    store.activate_binding(binding, 0)
    foreign = Binding(session_id=second.id, executor=ExecutorId.CODEX,
                      native_session_id=binding.native_session_id, working_directory=project.root_path)
    with pytest.raises(ConflictError):
        store.activate_binding(foreign, 0)
    assert store.list_bindings(second.id) == []
    assert store.get_session(second.id).executor == ExecutorId.MONA


def test_binding_rejects_wrong_project_and_running_switch(store, project, tmp_path):
    session = store.create_session(project.id)
    wrong = Binding(session_id=session.id, executor=ExecutorId.CLAUDE,
                    native_session_id="native-thread", working_directory=str(tmp_path))
    with pytest.raises(DevelopmentError):
        store.activate_binding(wrong, 0)
    assert store.list_bindings(session.id) == []
    running(store, session.id)
    correct = wrong.model_copy(update={"working_directory": project.root_path})
    with pytest.raises(ConflictError):
        store.activate_binding(correct, 0)
    assert store.list_bindings(session.id) == []


def test_recovery_marks_unknown_once_and_never_replays(store, project):
    a, b, c = [store.create_session(project.id) for _ in range(3)]
    in_flight = running(store, a.id)
    finished = running(store, b.id)
    finished = store.transition_run(finished.id, finished.revision, RunStatus.SUCCEEDED)
    queued, _ = store.create_run(c.id, "request_queue", "message_queue")
    item = store.enqueue_input(RunInput(session_id=a.id, run_id=in_flight.id, message_id="message_more"))
    store.transition_input(item.id, 0, InputState.RESERVED)
    reopened = DevelopmentStore(store.path)
    assert reopened.get_run(in_flight.id).status == RunStatus.RUNNING  # read/open is not recovery
    assert reopened.reconcile_after_restart() == 1
    assert reopened.reconcile_after_restart() == 0
    assert reopened.get_run(in_flight.id).status == RunStatus.UNKNOWN
    assert reopened.get_run(queued.id).status == RunStatus.QUEUED
    assert reopened.get_run(finished.id).status == RunStatus.SUCCEEDED
    assert reopened.list_inputs(in_flight.id)[0].state == InputState.UNKNOWN
    with pytest.raises(ConflictError):
        reopened.create_run(a.id, "request_again", "message_again")
    with pytest.raises(ConflictError):
        reopened.transition_run(in_flight.id, in_flight.revision + 1, RunStatus.RUNNING)
    recovered = reopened.transition_run(in_flight.id, in_flight.revision + 1, RunStatus.RECOVERING)
    assert reopened.transition_run(recovered.id, recovered.revision, RunStatus.RUNNING).id == in_flight.id


def test_input_edit_cancel_and_dispatch_boundary(store, project):
    session = store.create_session(project.id)
    run = running(store, session.id)
    item = store.enqueue_input(RunInput(session_id=session.id, run_id=run.id, message_id="message_follow"))
    assert store.enqueue_input(item) == item
    item = store.replace_pending_input(item.id, 0, "message_edited")
    assert item.revision == 1
    item = store.transition_input(item.id, 1, InputState.RESERVED)
    with pytest.raises(ConflictError):
        store.replace_pending_input(item.id, item.revision, "message_late")
    with pytest.raises(ConflictError):
        store.transition_input(item.id, item.revision, InputState.CANCELLED)
    item = store.transition_input(item.id, item.revision, InputState.ACCEPTED)
    item = store.transition_input(item.id, item.revision, InputState.CONSUMED)
    assert item.state == InputState.CONSUMED


def test_input_cannot_dispatch_after_parent_completed(store, project):
    session = store.create_session(project.id)
    run = running(store, session.id)
    item = store.enqueue_input(RunInput(session_id=session.id, run_id=run.id, message_id="message_follow"))
    store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    with pytest.raises(ConflictError):
        store.transition_input(item.id, 0, InputState.RESERVED)
    cancelled = store.transition_input(item.id, 0, InputState.CANCELLED)
    assert cancelled.state == InputState.CANCELLED


def test_inputs_cannot_cross_session_boundary(store, project):
    a, b = [store.create_session(project.id) for _ in range(2)]
    run = running(store, a.id)
    with pytest.raises(NotFoundError):
        store.enqueue_input(RunInput(session_id=b.id, run_id=run.id, message_id="message_wrong"))
    assert store.list_inputs(run.id) == []


def test_single_double_quad_views_never_change_runs(store, project):
    sessions = [store.create_session(project.id) for _ in range(4)]
    runs = [running(store, s.id) for s in sessions]
    view = store.save_view(DevelopmentView(project_id=project.id, panes=[Pane(id="pane_1", session_id=sessions[0].id)]), None)
    for layout, count in [("split2", 2), ("grid4", 4), ("single", 1)]:
        view = store.save_view(DevelopmentView(id=view.id, project_id=project.id, layout=layout,
                panes=[Pane(id=f"pane_{i+1}", session_id=sessions[i].id) for i in range(count)]), view.revision)
        assert all(store.get_run(run.id) == run for run in runs)
    assert DevelopmentStore(store.path).get_view(view.id) == view


def test_view_scope_and_revision_are_validated_without_side_effects(store, project, tmp_path):
    session = store.create_session(project.id)
    other = store.open_project(tmp_path)
    view = DevelopmentView(project_id=other.id, panes=[Pane(id="pane_1", session_id=session.id)])
    with pytest.raises(ConflictError):
        store.save_view(view, None)
    with pytest.raises(NotFoundError):
        store.get_view(view.id)
    view = store.save_view(DevelopmentView(project_id=project.id), None)
    with pytest.raises(ConflictError):
        store.save_view(view, 9)
    with pytest.raises(ValidationError):
        store.save_view(view.model_copy(update={"layout": "grid4"}), view.revision)
    assert store.get_view(view.id) == view


def test_unknown_ids_and_malformed_updates_do_not_create_records(store, project):
    with pytest.raises(NotFoundError):
        store.create_session("project_missing")
    session = store.create_session(project.id)
    with pytest.raises(ValidationError):
        store.update_session(session.id, 0, title="")
    assert store.get_session(session.id) == session
    with pytest.raises(ConflictError):
        store.update_session(session.id, 4, title="stale")


def test_events_paginate_without_crossing_sessions(store, project):
    a, b = [store.create_session(project.id) for _ in range(2)]
    running(store, a.id)
    running(store, b.id)
    result, cursor = [], 0
    while True:
        page = store.events_after(a.id, cursor, 1)
        if not page:
            break
        result.extend(page)
        cursor = page[-1].sequence
    assert len(result) == 4
    assert all(e.session_id == a.id and e.project_id == project.id for e in result)
    assert len({e.id for e in result}) == len(result)
    assert result == store.events_after(a.id)
    with pytest.raises(ValueError):
        store.events_after(a.id, -1)


@pytest.mark.parametrize("version", [0, 2])
def test_foreign_or_future_schema_is_never_recreated(tmp_path, version):
    path = tmp_path / "existing.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE user_data (content TEXT)")
        db.execute("INSERT INTO user_data VALUES ('keep')")
        db.execute(f"PRAGMA user_version={version}")
    before = path.read_bytes()
    with pytest.raises(DevelopmentError, match="未覆盖|不兼容"):
        DevelopmentStore(path)
    assert path.read_bytes() == before
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT content FROM user_data").fetchone()[0] == "keep"


def test_archiving_does_not_cancel_and_repeated_request_still_returns_original(store, project):
    session = store.create_session(project.id)
    run = running(store, session.id)
    store.update_session(session.id, 0, archived=True)
    assert store.get_run(run.id) == run
    duplicate, created = store.create_run(session.id, "request_one", "message_one")
    assert not created and duplicate.id == run.id
    store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    with pytest.raises(ConflictError):
        store.create_run(session.id, "request_next", "message_next")
    store.update_session(session.id, 1, archived=False)
    assert store.create_run(session.id, "request_next", "message_next")[1]
