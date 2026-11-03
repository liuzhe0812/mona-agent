"""Real store/service/file-helper contracts with a declared local execution dependency.

This fixture operates only on test-owned temporary files. It does not stand in
for successful Linux/gVisor deployment or contact a model.
"""
import copy
import hashlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work import sandbox_files
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_api import PREFIX
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

ALICE, BOB = owner_key("1"), owner_key("2")
FIRST, SECOND = "a" * 32, "b" * 32
FILE, ALIAS, OTHER = "c" * 32, "d" * 32, "e" * 32


class LocalFileExecutionFixture:
    def __init__(self, roots, monkeypatch):
        self.roots, self.monkeypatch = roots, monkeypatch
        self.calls = []
        self.response = None

    async def file(self, owner, operation_id, request, on_event):
        self.calls.append((owner, operation_id, copy.deepcopy(request)))
        if self.response is not None:
            return copy.deepcopy(self.response)
        with self.monkeypatch.context() as patch:
            patch.setattr(sandbox_files, "ROOT", self.roots[owner])
            # Never run sandbox /proc cleanup on the host during a unit test.
            patch.setattr(sandbox_files, "quiesce", lambda: None)
            try:
                result = sandbox_files.operate(request, 4096)
            except sandbox_files.FileOperationError as exc:
                status = "unknown" if exc.code == "file_operation_unknown" else "failed"
                return {"status": status, "workspace_saved": True, "error": {"code": exc.code}}
        return {"status": "completed", "workspace_saved": True, "file": result}

    async def execute(self, payload, on_event):
        raise AssertionError("blocked writes must not reach any execution dependency")


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = Path("\\\\?\\" + str(tmp_path.resolve())) if sys.platform == "win32" else tmp_path
    config = HostedWorkConfig(state_dir=str(root), max_concurrent_runs=4,
                              models={"official": {"label": "Mona", "model": "fixture"}})
    path = root / "state.sqlite3"
    store = WorkStore(path, config)
    roots = {owner: root / owner for owner in (ALICE, BOB)}
    executor = LocalFileExecutionFixture(roots, monkeypatch)
    service = WorkService(config, store, None, executor)
    for owner, directory in roots.items():
        directory.mkdir()
        content = b"private-alice" if owner == ALICE else b"private-bob"
        (directory / "source.txt").write_bytes(content)
        (directory / "other.txt").write_bytes(b"unrelated")
        metadata = {"path": "source.txt", "name": "source.txt", "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest()}
        for sid in (FIRST, SECOND):
            store.create_session(owner, NewSession(request_id=sid))
        store.add_file(owner, FIRST, FILE, metadata)
        store.add_file(owner, SECOND, ALIAS, metadata)
        store.add_file(owner, FIRST, OTHER, {"path": "other.txt", "name": "other.txt", "size": 9,
                                           "sha256": hashlib.sha256(b"unrelated").hexdigest()})
    try:
        yield SimpleNamespace(service=service, store=store, executor=executor, roots=roots, config=config, path=path)
    finally:
        store.close()


def rows(env, owner):
    return [dict(row) for row in env.store.db.execute("SELECT * FROM files WHERE owner=? ORDER BY id", (owner,))]


def pending(env, owner=ALICE):
    row = env.store.db.execute("SELECT * FROM workspace_operations WHERE owner=?", (owner,)).fetchone()
    return dict(row) if row is not None else None


async def mutate(env, action="rename", digest=None):
    if digest is None:
        digest = env.store.file(ALICE, FIRST, FILE)["sha256"]
    return await env.service.mutate_file(ALICE, FIRST, FILE, action, expected_sha256=digest,
                                          destination="/workspace/new.txt" if action == "rename" else None)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["rename", "trash"])
async def test_mutation_updates_all_owner_path_references_and_keeps_other_owner(env, action):
    bob = rows(env, BOB)
    other = env.store.file(ALICE, FIRST, OTHER)
    original = env.store.file(ALICE, FIRST, FILE)
    result = await mutate(env, action)
    assert result["size"] == original["size"] and result["sha256"] == original["sha256"]
    for sid, file_id in ((FIRST, FILE), (SECOND, ALIAS)):
        if action == "rename":
            current = env.store.file(ALICE, sid, file_id)
            assert current == {**original, "id": file_id, "path": "new.txt", "name": "new.txt"}
        else:
            with pytest.raises(WorkError) as exc:
                env.store.file(ALICE, sid, file_id)
            assert exc.value.status == 404
    assert env.store.file(ALICE, FIRST, OTHER) == other
    assert rows(env, BOB) == bob
    assert (env.roots[BOB] / "source.txt").read_bytes() == b"private-bob"
    assert not (env.roots[ALICE] / "source.txt").exists()
    if action == "rename":
        assert (env.roots[ALICE] / "new.txt").read_bytes() == b"private-alice"
    else:
        recycled = list((env.roots[ALICE] / sandbox_files.TRASH).glob("*/file"))
        assert len(recycled) == 1 and recycled[0].read_bytes() == b"private-alice"
    assert pending(env)["status"] == "finished"
    assert not env.service.active_users
    owner, operation, request = env.executor.calls[0]
    assert owner == ALICE and len(operation) == 32
    assert request == {"action": action, "path": "source.txt", "expected_sha256": original["sha256"],
                       **({"destination": "new.txt"} if action == "rename" else {})}


@pytest.mark.asyncio
async def test_stale_metadata_digest_and_cross_owner_file_are_rejected_before_execution(env):
    before = rows(env, ALICE)
    with pytest.raises(WorkError) as exc:
        await mutate(env, digest="0" * 64)
    assert (exc.value.code, exc.value.status) == ("file_changed", 409)
    only_alice = "f" * 32
    env.store.add_file(ALICE, FIRST, only_alice, env.store.file(ALICE, FIRST, FILE))
    with pytest.raises(WorkError) as exc:
        await env.service.mutate_file(BOB, FIRST, only_alice, "trash", expected_sha256="0" * 64)
    assert exc.value.status == 404
    assert env.executor.calls == [] and pending(env) is None and pending(env, BOB) is None
    assert rows(env, ALICE)[:len(before)] == before


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["changed", "occupied"])
async def test_helper_rejection_keeps_metadata_and_bytes_and_does_not_report_completion(env, failure):
    before = rows(env, ALICE)
    if failure == "changed":
        (env.roots[ALICE] / "source.txt").write_bytes(b"updated after delivery")
    else:
        (env.roots[ALICE] / "new.txt").write_bytes(b"keep target")
    with pytest.raises(WorkError) as exc:
        await mutate(env)
    assert (exc.value.code, exc.value.status) == ("file_changed" if failure == "changed" else "file_exists", 409)
    assert rows(env, ALICE) == before
    assert (env.roots[ALICE] / "source.txt").exists()
    if failure == "occupied":
        assert (env.roots[ALICE] / "new.txt").read_bytes() == b"keep target"
    assert pending(env)["status"] == "finished"
    env.store.require_idle(ALICE)
    assert not env.service.active_users


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [
    {"status": "failed", "workspace_saved": True},
    {"status": "cancelled", "workspace_saved": True},
    {"status": "unknown", "workspace_saved": True},
    {"status": "completed", "workspace_saved": False},
])
async def test_failed_unknown_or_unsaved_result_never_updates_metadata_as_completed(env, result):
    before, bob = rows(env, ALICE), rows(env, BOB)
    env.executor.response = result
    with pytest.raises(WorkError) as exc:
        await mutate(env)
    assert exc.value.status == 503
    assert rows(env, ALICE) == before and rows(env, BOB) == bob
    assert (env.roots[ALICE] / "source.txt").read_bytes() == b"private-alice"
    assert not env.service.active_users
    if result["status"] == "unknown":
        assert pending(env)["status"] == "unknown"
        with pytest.raises(WorkError) as blocked:
            env.store.require_idle(ALICE)
        assert blocked.value.code == "workspace_pending"


@pytest.mark.asyncio
async def test_unknown_file_operation_durably_blocks_later_writes_without_blocking_other_owner(env):
    env.executor.response = {"status": "unknown", "workspace_saved": False,
                             "error": {"code": "file_operation_unknown"}}
    with pytest.raises(WorkError):
        await mutate(env)
    original_operation = pending(env)
    persisted = WorkStore(env.path, env.config)
    try:
        with pytest.raises(WorkError) as exc:
            persisted.require_idle(ALICE)
        assert exc.value.code == "workspace_pending"
    finally:
        persisted.close()
    env.executor.response = None
    for operation in (
        lambda: mutate(env, "trash"),
        lambda: env.service.upload(ALICE, FIRST, "f" * 32, "new.txt", b"new upload"),
        lambda: env.service.submit(ALICE, "synthetic-account-token", FIRST,
                                   NewTurn(request_id="f" * 32, model_id="official", text="new task")),
    ):
        with pytest.raises(WorkError) as exc:
            await operation()
        assert exc.value.code == "workspace_pending"
    assert len(env.executor.calls) == 1 and pending(env) == original_operation
    bob = env.store.file(BOB, FIRST, FILE)
    await env.service.mutate_file(BOB, FIRST, FILE, "rename", expected_sha256=bob["sha256"], destination="bob.txt")
    assert env.store.file(BOB, FIRST, FILE)["path"] == "bob.txt"
    assert pending(env) == original_operation
    assert not env.service.active_users


@pytest.mark.asyncio
@pytest.mark.parametrize("file_reply", [
    {},
    {"path": "new.txt", "size": -1, "sha256": "a" * 64},
    {"path": "new.txt", "size": 13, "sha256": "invalid"},
    {"path": "unexpected.txt", "size": 13, "sha256": "a" * 64},
])
async def test_unverifiable_completed_reply_remains_unknown_and_blocks_followup(env, file_reply):
    before = rows(env, ALICE)
    env.executor.response = {"status": "completed", "workspace_saved": True, "file": file_reply}
    with pytest.raises(WorkError):
        await mutate(env)
    assert rows(env, ALICE) == before
    assert pending(env)["status"] == "unknown"
    with pytest.raises(WorkError) as exc:
        env.store.require_idle(ALICE)
    assert exc.value.code == "workspace_pending"
    assert not env.service.active_users


@pytest.mark.asyncio
async def test_http_legacy_rename_inventory_and_cas_trash_preserve_other_account(env):
    async def identity(token):
        if token not in {"fixture-alice", "fixture-bob"}:
            raise WorkError("login_required", "请登录。", 401)
        return ALICE if token == "fixture-alice" else BOB

    env.config.public_origin = "https://work.example.invalid"
    env.service.auth = SimpleNamespace(identity=identity)
    client = TestClient(TestServer(create_app(env.service)))
    await client.start_server()
    alice_headers = {"Authorization": "Bearer fixture-alice", "Origin": env.config.public_origin}
    bob_headers = {**alice_headers, "Authorization": "Bearer fixture-bob"}
    route = PREFIX + "/api/artifacts"
    query = {"session_key": "websocket:" + FIRST}
    try:
        initial = await client.get(route, headers=alice_headers, params=query)
        assert initial.status == 200
        api = env.service.desktop
        for owner in (ALICE, BOB):
            stored = env.store.file(owner, FIRST, FILE)
            delivered = {"path": "source.txt", "task_id": "delivered-task", "delivered": True,
                         "file": {**stored, "path": "/workspace/source.txt",
                                  "absolute_path": "/workspace/source.txt"}}
            for sid in (FIRST, SECOND):
                api.state.set(owner, "artifact_index:" + sid, [delivered])
            api.state.set(owner, "upload:/workspace/source.txt", {**stored, "path": "/workspace/source.txt"})
            # The legacy file exists only behind the isolated file transport.
            assert not (api.files.root(owner) / "source.txt").exists()
        bob_rows = rows(env, BOB)
        bob_index = api.state.get(BOB, "artifact_index:" + FIRST)
        renamed = await client.get(PREFIX + "/api/artifact-rename", headers=alice_headers,
            params={**query, "path": "/workspace/source.txt", "new_name": "renamed.txt"})
        assert renamed.status == 200 and await renamed.json() == {"path": "renamed.txt", "name": "renamed.txt"}
        for sid, file_id in ((FIRST, FILE), (SECOND, ALIAS)):
            refreshed = await client.get(route, headers=alice_headers, params={"session_key": "websocket:" + sid})
            assert refreshed.status == 200
            inventory = await refreshed.json()
            assert [row["name"] for row in inventory["session_files"]] == ["renamed.txt"]
            assert "source.txt" not in {row["name"] for row in inventory["files"]}
            assert env.store.file(ALICE, sid, file_id)["path"] == "renamed.txt"
            recorded = api.state.get(ALICE, "artifact_index:" + sid)
            assert recorded[0]["path"] == "renamed.txt"
            assert recorded[0]["file"]["absolute_path"] == "/workspace/renamed.txt"
        assert api.state.get(ALICE, "upload:/workspace/source.txt") is None
        assert api.state.get(ALICE, "upload:/workspace/renamed.txt")["name"] == "renamed.txt"
        observed = inventory["session_files"][0]["sha256"]
        delete = {"command": "move_to_trash", "args": {"path": "/workspace/renamed.txt", "expectedSha256": "0" * 64}}
        denied = await client.post(PREFIX + "/platform/invoke", headers=alice_headers, json=delete)
        assert denied.status == 409 and (await denied.json())["code"] == "file_changed"
        assert len(env.executor.calls) == 1
        assert (env.roots[ALICE] / "renamed.txt").read_bytes() == b"private-alice"
        delete["args"]["expectedSha256"] = observed
        removed = await client.post(PREFIX + "/platform/invoke", headers=alice_headers, json=delete)
        assert removed.status == 200 and await removed.json() is None
        for sid, file_id in ((FIRST, FILE), (SECOND, ALIAS)):
            refreshed = await client.get(route, headers=alice_headers, params={"session_key": "websocket:" + sid})
            inventory = await refreshed.json()
            assert inventory["session_files"] == []
            assert not {"source.txt", "renamed.txt"}.intersection(row["name"] for row in inventory["files"])
            assert api.state.get(ALICE, "artifact_index:" + sid) == []
            with pytest.raises(WorkError) as missing:
                env.store.file(ALICE, sid, file_id)
            assert missing.value.status == 404
        assert api.state.get(ALICE, "upload:/workspace/renamed.txt") is None
        assert [call[2]["action"] for call in env.executor.calls] == ["rename", "trash"]
        assert not (env.roots[ALICE] / "renamed.txt").exists()
        assert rows(env, BOB) == bob_rows
        assert api.state.get(BOB, "artifact_index:" + FIRST) == bob_index
        assert api.state.get(BOB, "artifact_index:" + SECOND) == bob_index
        bob_response = await client.get(route, headers=bob_headers, params=query)
        assert [row["name"] for row in (await bob_response.json())["session_files"]] == ["source.txt"]
        assert (env.roots[BOB] / "source.txt").read_bytes() == b"private-bob"
    finally:
        await client.close()
