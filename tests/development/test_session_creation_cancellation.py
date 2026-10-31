"""Creation cancellation and first-input admission share durable identity and transactions."""
import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from test_session_creation_idempotency import make_store
from test_workbench_api import AUTH, setup_client

from mona.development.api import SessionBody
from mona.development.contracts import SCHEMA_VERSION, ExecutorId, RunInput, RunStatus
from mona.development.store import DevelopmentError, DevelopmentStore


def fields(executor=ExecutorId.MONA):
    return SessionBody(executor=executor, title="Original").model_dump(mode="json", exclude={"request_id"})


@pytest.mark.parametrize("executor", list(ExecutorId))
def test_cancel_before_creation_survives_restart_and_preserves_other_requests(tmp_path, executor):
    store, project = make_store(tmp_path)
    result = store.cancel_session_creation(project.id, "request_original", fields(executor), "send_original")
    assert result == {"state": "cancelled", "sessionId": None}
    restored = DevelopmentStore(store.path)
    assert restored.cancel_session_creation(project.id, "request_original", fields(executor), "send_original") == result
    with pytest.raises(DevelopmentError) as error:
        restored.create_session(project.id, request_id="request_original", **fields(executor))
    assert error.value.code == "creation_request_cancelled"
    assert restored.list_sessions(project.id) == []
    assert restored.create_session(project.id, request_id="request_new").id
    with pytest.raises(DevelopmentError) as error:
        restored.cancel_session_creation(project.id, "request_original", fields(executor), "send_different")
    assert error.value.code == "creation_request_conflict"


def test_cancellation_keeps_created_session_and_blocks_late_first_run_or_queue(tmp_path):
    store, project = make_store(tmp_path)
    session = store.create_session(project.id, request_id="request_original", **fields())
    result = store.cancel_session_creation(project.id, "request_original", fields(), "send_original")
    assert result == {"state": "cancelled", "sessionId": session.id}
    assert store.get_session(session.id) == session
    with pytest.raises(DevelopmentError, match="放弃"):
        store.create_run(session.id, "send_original", "first_message")
    run, _ = store.create_run(session.id, "unrelated_run", "unrelated_message")
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    with pytest.raises(DevelopmentError, match="放弃"):
        store.enqueue_input(RunInput(id="send_original", session_id=session.id, run_id=run.id, message_id="first_message"))
    assert store.list_inputs(run.id) == []
    assert store.get_run(run.id).status == RunStatus.RUNNING


@pytest.mark.parametrize("queued", [False, True])
def test_already_accepted_input_is_not_stopped_removed_or_reclassified(tmp_path, queued):
    store, project = make_store(tmp_path)
    session = store.create_session(project.id, request_id="request_original", **fields())
    run, _ = store.create_run(session.id, "owner" if queued else "send_original", "owner_message")
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    item = store.enqueue_input(RunInput(id="send_original", session_id=session.id, run_id=run.id,
        message_id="first_message")) if queued else None
    result = store.cancel_session_creation(project.id, "request_original", fields(), "send_original")
    assert result == {"state": "accepted", "sessionId": session.id}
    assert store.get_run(run.id) == run
    if item:
        assert store.get_input(item.id) == item
        store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
        assert store.create_run(session.id, item.id, item.message_id)[1]
    else:
        assert not store.create_run(session.id, "send_original", "owner_message")[1]
    assert store.create_session(project.id, request_id="request_original", **fields()).id == session.id


def test_creation_and_cancellation_race_cannot_revive_or_delete_a_session(tmp_path):
    store, project = make_store(tmp_path)

    def create():
        try:
            return store.create_session(project.id, request_id="request_original", **fields())
        except DevelopmentError as error:
            assert error.code == "creation_request_cancelled"
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        created = pool.submit(create)
        cancelled = pool.submit(store.cancel_session_creation, project.id, "request_original", fields(), "send_original")
        original, result = created.result(), cancelled.result()
    assert result["state"] == "cancelled"
    assert len(store.list_sessions(project.id)) == (1 if original else 0)
    with pytest.raises(DevelopmentError, match="放弃"):
        store.create_session(project.id, request_id="request_original", **fields())


@pytest.mark.asyncio
async def test_cancel_api_is_authenticated_confirmed_and_independent_of_native_availability(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    path = f"/api/development/projects/{project.id}/session-creations/request_original/cancel"
    body = {**fields(ExecutorId.CODEX), "sendRequestId": "send_original", "confirmed": True}
    try:
        assert (await client.post(path, json=body)).status == 401
        assert (await client.post(path, headers=AUTH, json={**body, "confirmed": False})).status == 400
        responses = await asyncio.gather(*(client.post(path, headers=AUTH, json=body) for _ in range(3)))
        assert all(response.status == 200 for response in responses)
        results = [await response.json() for response in responses]
        assert all(result["state"] == "cancelled" for result in results)
        assert runtime.store.list_sessions(project.id) == [] and not runtime.tasks
        changed = await client.post(path, headers=AUTH, json={**body, "title": "Different"})
        assert changed.status == 200 and (await changed.json())["state"] == "rejected"
        late = await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH,
            json={**fields(ExecutorId.CODEX), "requestId": "request_original"})
        assert late.status == 409 and (await late.json())["error"]["code"] == "creation_request_cancelled"
    finally:
        await client.close()


def test_rejected_parameters_release_only_that_intent_and_do_not_cancel_the_original(tmp_path):
    store, project = make_store(tmp_path)
    original = store.create_session(project.id, request_id="request_original", **fields())
    rejected = store.cancel_session_creation(project.id, "request_original", {**fields(), "title": "Different"}, "send_other")
    assert rejected == {"state": "rejected", "sessionId": original.id}
    assert store.create_session(project.id, request_id="request_original", **fields()).id == original.id
    assert store.create_run(original.id, "send_original", "first_message")[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", list(ExecutorId))
async def test_late_first_input_is_rejected_before_model_checks_or_history_changes(tmp_path, monkeypatch, executor):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id, request_id="request_original", **fields(executor))
    run, _ = runtime.store.create_run(session.id, "unrelated_request", "unrelated_message")
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    runtime.store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    runtime.store.cancel_session_creation(project.id, "request_original", fields(executor), "send_original")
    try:
        response = await client.post(f"/api/development/sessions/{session.id}/send", headers=AUTH,
            json={"requestId": "send_original", "content": "late first message"})
        assert response.status == 409
        assert (await response.json())["error"]["code"] == "creation_request_cancelled"
        assert runtime.sessions.get_or_create(session.transcript_key).messages == []
        assert runtime.store.list_inputs(run.id) == [] and not runtime.tasks
        assert runtime.store.get_run(run.id).status == RunStatus.RUNNING
    finally:
        await client.close()


def test_v4_creation_receipts_survive_upgrade_and_older_readers_cannot_bypass_cancellation(tmp_path, monkeypatch):
    store, project = make_store(tmp_path)
    original = store.create_session(project.id, request_id="request_original", **fields())
    with sqlite3.connect(store.path) as db:
        db.execute("DROP TABLE session_creation_cancellations")
        db.execute("PRAGMA user_version=4")
    restored = DevelopmentStore(store.path)
    assert restored.get_session(original.id) == original
    assert restored.create_session(project.id, request_id="request_original", **fields()).id == original.id
    assert restored.cancel_session_creation(project.id, "request_original", fields(), "send_original")["state"] == "cancelled"
    with sqlite3.connect(restored.path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    monkeypatch.setattr("mona.development.store.SCHEMA_VERSION", 4)
    with pytest.raises(DevelopmentError, match="不兼容"):
        DevelopmentStore(restored.path)
