"""Unknown steering remains inspectable and can be closed without replaying it."""
import asyncio
import sqlite3

import pytest
from test_workbench_api import AUTH, setup_client
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.development.contracts import (
    SCHEMA_VERSION,
    InputState,
    PermissionMode,
    RunInput,
    RunStatus,
)
from mona.development.store import DevelopmentError


@pytest.mark.asyncio
async def test_compaction_failure_after_durable_guide_exposes_unknown_without_replay(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, model)

    async def compact(context, session, transcript, *args, **kwargs):
        if any(row.get("_steering_input_id") for row in transcript.messages):
            raise DevelopmentError("compaction_failed", "fixture compaction failure")
        return None

    monkeypatch.setattr("mona.development.continuation.compact_if_needed", compact)
    try:
        await runtime.submit(session.id, "original_request", "first")
        await model.entered.wait()
        await runtime.submit(session.id, "guide_request", "keep this correction", intent="steering")
        model.gate.set()
        runs = await wait_done(runtime, session.id)
        assert runs[0].status == RunStatus.FAILED
        item = runtime.store.get_input("guide_request")
        assert item.state == InputState.UNKNOWN
        snapshot = runtime.snapshot(session.id)
        assert [(row["id"], row["canCloseUnknown"]) for row in snapshot["pendingInputs"]] == [(item.id, True)]
        assert sum(row["content"] == "keep this correction" for row in snapshot["messages"]) == 1
        assert len(model.requests) == 1
    finally:
        model.gate.set()
        await runtime.close()


def unknown_guide(runtime, session):
    run, _ = runtime.store.create_run(session.id, "original_request", "original_message")
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    item = runtime.store.enqueue_input(RunInput(id="unknown_guide", session_id=session.id,
        run_id=run.id, message_id="guide_message", intent="steering"))
    item = runtime.store.transition_input(item.id, item.revision, InputState.RESERVED)
    item = runtime.store.transition_input(item.id, item.revision, InputState.UNKNOWN)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "correction", id=item.message_id, _ui_only=True, _input_delivered=True,
        _input_source={"content": "correction", "docPaths": [], "documentNames": []})
    transcript.add_message("user", "correction", id="delivered_guide", run_id=run.id, _steering_input_id=item.id)
    runtime.sessions.save(transcript, fsync=True)
    return run, item


@pytest.mark.asyncio
async def test_unknown_guide_closure_requires_confirmation_finished_run_and_exact_identity(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id)
    run, item = unknown_guide(runtime, session)
    path = f"/api/development/sessions/{session.id}/inputs/{item.id}/close-unknown"
    body = {"revision": item.revision, "confirmed": True}
    try:
        assert (await client.post(path, json=body)).status == 401
        assert (await client.post(path, json={"revision": item.revision}, headers=AUTH)).status == 400
        assert (await client.post(path, json=body, headers=AUTH)).status == 409
        runtime.store.transition_run(run.id, run.revision, RunStatus.INTERRUPTING)
        runtime.store.transition_run(run.id, run.revision + 1, RunStatus.INTERRUPTED)
        other = runtime.store.create_session(project.id)
        wrong = path.replace(session.id, other.id)
        assert (await client.post(wrong, json=body, headers=AUTH)).status == 409
        stale = {**body, "revision": item.revision - 1}
        assert (await client.post(path, json=stale, headers=AUTH)).status == 409

        response = await client.post(path, json=body, headers=AUTH)
        assert response.status == 200
        assert (await response.json())["state"] == "closed_unknown"
        assert (await client.post(path, json=body, headers=AUTH)).status == 200
        assert runtime.store.get_input(item.id).state.value == "closed_unknown"
        assert runtime.snapshot(session.id)["pendingInputs"] == []
        assert runtime.snapshot(session.id)["messages"][0]["content"] == "correction"
        retry = await runtime.submit(session.id, item.id, "correction", intent="steering")
        assert retry["reused"] and retry["input"]["state"] == "closed_unknown"
        assert len(runtime.store.list_runs(session.id)) == 1 and not runtime.tasks
        assert runtime.store.set_permission_mode(session.id, runtime.store.get_session(session.id).revision,
            PermissionMode.AUTO).permission_mode == PermissionMode.AUTO
        restored = type(runtime.store)(runtime.store.path)
        assert restored.get_input(item.id).state.value == "closed_unknown"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_unknown_followup_cannot_be_closed_as_an_injected_guide(tmp_path, monkeypatch):
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    run, item = unknown_guide(runtime, session)
    item.intent = "follow_up"
    with runtime.store._connection(write=True) as db:
        runtime.store._save(db, item)
    runtime.store.transition_run(run.id, run.revision, RunStatus.FAILED)
    try:
        with pytest.raises(DevelopmentError):
            await runtime.close_unknown_input(session.id, item.id, item.revision)
        assert runtime.store.get_input(item.id).state == InputState.UNKNOWN
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_v3_upgrade_preserves_unknown_input_and_older_reader_rejects_new_states(tmp_path, monkeypatch):
    from mona.development.store import DevelopmentStore

    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    run, item = unknown_guide(runtime, session)
    try:
        with sqlite3.connect(runtime.store.path) as db:
            db.execute("DROP TABLE session_creations")
            db.execute("PRAGMA user_version=3")
        restored = DevelopmentStore(runtime.store.path)
        assert restored.get_run(run.id) == run
        assert restored.get_input(item.id) == item
        with sqlite3.connect(restored.path) as db:
            assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
            assert db.execute("SELECT count(*) FROM session_creations").fetchone()[0] == 0
        monkeypatch.setattr("mona.development.store.SCHEMA_VERSION", 3)
        with pytest.raises(DevelopmentError, match="不兼容"):
            DevelopmentStore(restored.path)
    finally:
        await runtime.close()
