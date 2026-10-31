"""A session creation request keeps its identity across retries and deletion."""

import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from test_workbench_api import AUTH, setup_client

from mona.config.schema import Config, DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.store import ConflictError, DevelopmentStore


def make_store(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    store = DevelopmentStore(tmp_path / "state.sqlite3")
    return store, store.open_project(root)


def test_concurrent_creation_is_atomic_project_scoped_and_survives_reopen(tmp_path):
    store, project = make_store(tmp_path)
    with ThreadPoolExecutor(max_workers=8) as workers:
        sessions = list(workers.map(lambda _: store.create_session(project.id, title="Original",
            request_id="request_same"), range(16)))
    assert len({session.id for session in sessions}) == 1
    session = sessions[0]
    assert [value.id for value in store.list_sessions(project.id)] == [session.id]
    assert [event.type for event in store.events_after(session.id)].count("session.created") == 1

    reopened = DevelopmentStore(store.path)
    assert reopened.create_session(project.id, title="Original", request_id="request_same").id == session.id
    with pytest.raises(ConflictError) as error:
        reopened.create_session(project.id, title="Different", request_id="request_same")
    assert error.value.code == "creation_request_conflict"

    other_root = tmp_path / "other"
    other_root.mkdir()
    other = reopened.open_project(other_root)
    assert reopened.create_session(other.id, title="Original", request_id="request_same").id != session.id


def test_deleted_creation_cannot_be_recreated_and_legacy_requests_still_create(tmp_path):
    store, project = make_store(tmp_path)
    session = store.create_session(project.id, request_id="request_deleted")
    store.delete_session(session.id, session.revision)
    reopened = DevelopmentStore(store.path)
    with pytest.raises(ConflictError) as error:
        reopened.create_session(project.id, request_id="request_deleted")
    assert error.value.code == "creation_request_deleted"
    assert reopened.list_sessions(project.id) == []
    first = reopened.create_session(project.id)
    second = reopened.create_session(project.id)
    assert first.id != second.id and first.id != session.id and second.id != session.id


def test_creation_fingerprint_is_independent_of_later_session_edits(tmp_path):
    store, project = make_store(tmp_path)
    session = store.create_session(project.id, title="Original", request_id="request_edited")
    updated = store.update_session(session.id, session.revision, title="Renamed")
    repeated = store.create_session(project.id, title="Original", request_id="request_edited")
    assert repeated.id == session.id and repeated.title == updated.title
    with pytest.raises(ConflictError) as error:
        store.create_session(project.id, title="Renamed", request_id="request_edited")
    assert error.value.code == "creation_request_conflict"


def test_every_creation_field_is_bound_to_request_identity(tmp_path):
    store, project = make_store(tmp_path)
    session = store.create_session(project.id, request_id="request_fields")
    for changes in ({"executor": ExecutorId.CODEX}, {"title": "Changed"}, {"model": "other"},
                    {"readonly": True}, {"parent_session_id": "dev_parent"},
                    {"model_provider": "other"}, {"model_reasoning_effort": "high"}):
        with pytest.raises(ConflictError) as error:
            store.create_session(project.id, request_id="request_fields", **changes)
        assert error.value.code == "creation_request_conflict"
    assert [value.id for value in store.list_sessions(project.id)] == [session.id]


def test_legacy_database_adds_creation_journal_without_changing_sessions(tmp_path):
    store, project = make_store(tmp_path)
    existing = store.create_session(project.id, title="Old")
    with sqlite3.connect(store.path) as db:
        db.execute("DROP TABLE session_creations")
    reopened = DevelopmentStore(store.path)
    new = reopened.create_session(project.id, request_id="request_after_upgrade")
    assert {value.id for value in reopened.list_sessions(project.id)} == {existing.id, new.id}
    assert reopened.get_session(existing.id).title == "Old"
    assert DevelopmentStore(store.path).create_session(project.id, request_id="request_after_upgrade").id == new.id


def test_failed_creation_rolls_back_request_and_session_together(tmp_path, monkeypatch):
    store, project = make_store(tmp_path)
    original = store._event

    def fail(*_args):
        raise RuntimeError("fixture persistence failure")

    monkeypatch.setattr(store, "_event", fail)
    with pytest.raises(RuntimeError, match="fixture persistence failure"):
        store.create_session(project.id, request_id="request_retry")
    assert store.list_sessions(project.id) == []
    monkeypatch.setattr(store, "_event", original)
    session = store.create_session(project.id, request_id="request_retry")
    assert store.create_session(project.id, request_id="request_retry").id == session.id


@pytest.mark.asyncio
async def test_api_retry_uses_existing_creation_before_current_model_settings(tmp_path, monkeypatch):
    config = Config(development=DevelopmentConfig(enabled_engines=["codex"]))
    client, runtime, root = await setup_client(tmp_path, monkeypatch, config_loader=lambda: config)
    project = runtime.store.open_project(root)
    url = f"/api/development/projects/{project.id}/sessions"
    body = {"requestId": "request_native", "executor": "codex", "title": "Native"}
    try:
        responses = await asyncio.gather(*(client.post(url, headers=AUTH, json=body) for _ in range(4)))
        assert all(response.status == 200 for response in responses)
        results = [await response.json() for response in responses]
        assert len({result["id"] for result in results}) == 1
        assert len(runtime.store.list_sessions(project.id)) == 1 and not runtime.tasks

        config.development.enabled_engines = []
        config.development.permissions.default_mode = "auto"
        retry = await client.post(url, headers=AUTH, json=body)
        assert retry.status == 200
        recovered = await retry.json()
        assert recovered["id"] == results[0]["id"] and recovered["permissionMode"] == "ask"
        mismatch = await client.post(url, headers=AUTH, json={**body, "title": "Other"})
        assert mismatch.status == 409
        assert (await mismatch.json())["error"]["code"] == "creation_request_conflict"

        runtime.store.delete_session(results[0]["id"], results[0]["revision"])
        deleted = await client.post(url, headers=AUTH, json=body)
        assert deleted.status == 409
        assert (await deleted.json())["error"]["code"] == "creation_request_deleted"
        assert runtime.store.list_sessions(project.id) == [] and not runtime.tasks
        invalid = await client.post(url, headers=AUTH, json={"requestId": "invalid/id"})
        assert invalid.status == 400 and runtime.store.list_sessions(project.id) == []
        legacy = [await client.post(url, headers=AUTH, json={}) for _ in range(2)]
        assert all(response.status == 200 for response in legacy)
        assert len({(await response.json())["id"] for response in legacy}) == 2
        assert not runtime.tasks
    finally:
        await client.close()
