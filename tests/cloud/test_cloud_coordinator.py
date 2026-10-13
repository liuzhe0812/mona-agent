"""Real coordinator, session files and crypto across temporary desktop instances."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest
from test_cloud_crypto_transfer import ObjectService

from mona.cloud.coordinator import CloudCoordinator
from mona.cloud.transfer import CloudTransferError
from mona.session.manager import Session, SessionManager


class CloudService(ObjectService):
    def __init__(self):
        super().__init__()
        self.space = None

    def control(self, method, path, payload=None):
        parsed = urlsplit(path)
        if parsed.path == "/space":
            if method == "POST":
                if self.space is not None:
                    assert self.space["vault_id"] == payload["vault_id"]
                    assert self.space["key_check"] == payload["key_check"]
                else:
                    self.space = {**payload, "quota_bytes": self.quota, "used_bytes": 0,
                                  "reserved_bytes": 0, "object_count": 0}
                return copy.deepcopy(self.space)
            return {"exists": bool(self.space), "space": copy.deepcopy(self.space)}
        if parsed.path == "/changes":
            after = int(parse_qs(parsed.query)["after"][0])
            rows = sorted([v for group in self.versions.values() for v in group], key=lambda v: v["sequence"])
            matches = [v for v in rows if v["sequence"] > after]
            page = matches[:100]
            return {"items": copy.deepcopy(page), "next_cursor": page[-1]["sequence"] if page else after, "has_more": len(matches) > 100}
        if parsed.path.endswith("/history"):
            rid = parsed.path.split("/")[2]
            before = int(parse_qs(parsed.query).get("before", [2**31 - 1])[0])
            rows = [v for v in reversed(self.versions.get(rid, [])) if v["version"] < before]
            return {"items": copy.deepcopy(rows[:50]), "has_more": len(rows) > 50,
                    "next_before": rows[min(len(rows), 50) - 1]["version"] if rows else before}
        return super().control(method, path, payload)


class DesktopBoundary:
    def __init__(self, server, name):
        self.server, self.name = server, name
        self.account_id, self.plan, self.recovery = "1", "pro", None
        self.binding = hashlib.sha256(name.encode()).hexdigest()
        self.calls = []
        self.notifications = []
        self.hook = None

    def invoke(self, command, args=None, **kwargs):
        self.calls.append(command)
        if self.hook:
            self.hook(command)
        if command == "cloud_sync_context":
            return {"account_id": self.account_id, "binding": self.binding, "plan": self.plan,
                "cloud_status": 200, "space": copy.deepcopy(self.server.space), "exists": bool(self.server.space),
                "recovery": self.recovery}
        if command == "cloud_sync_notify":
            if args["binding"] != self.binding:
                raise CloudTransferError("account_changed", "account changed")
            self.notifications.append({"work_keys": args["work_keys"], "planning": args["planning"]})
            return {"emitted": True}
        if command == "cloud_sync_store_key":
            if args["binding"] != self.binding:
                raise CloudTransferError("account_changed", "account changed")
            self.recovery = args["recovery"]
            return {"saved": True}
        raise AssertionError(command)

    def transport(self, binding):
        boundary = self
        class BoundTransport:
            def control(self, method, path, payload=None):
                if binding != boundary.binding:
                    raise CloudTransferError("account_changed", "account changed")
                return boundary.server.control(method, path, payload)

            def upload(self, authorization, ciphertext):
                boundary.server.upload(authorization, ciphertext)

            def download(self, authorization):
                return boundary.server.download(authorization)
        return BoundTransport()


@pytest.fixture
def desktops(tmp_path):
    service = CloudService()
    def create(name):
        root = tmp_path / name
        root.mkdir()
        manager = SessionManager(root / "workspace")
        media = root / "media"
        media.mkdir()
        displays = root / "display"
        displays.mkdir()
        config = root / "config.json"
        config.write_text(json.dumps({"unrelated": {"keep": True}}), encoding="utf-8")
        boundary = DesktopBoundary(service, name)
        loop = SimpleNamespace(sessions=manager, _active_tasks={}, _session_locks={})
        coordinator = CloudCoordinator(loop, config_path=config, state_path=root / "sync.sqlite3",
            media_root=media, transcript_for=lambda key: displays / f"{manager.safe_key(key)}.jsonl",
            invoke=boundary.invoke, transport_factory=boundary.transport)
        return coordinator, boundary
    return service, create


def add_conversation(coordinator, key="websocket:work-one", text="first message", attachment=True):
    session = Session(key, metadata={"title": "My work", "webui": True})
    media = []
    if attachment:
        path = coordinator.media_root / "data.txt"
        path.write_text("ATTACHMENT_BODY", encoding="utf-8")
        media = [str(path)]
    session.add_message("user", text, media=media)
    session.add_message("assistant", "first answer")
    coordinator.manager.save(session)
    coordinator.transcript_for(key).write_text(json.dumps({"event": "user", "content": text, "media_paths": media}) + "\n", encoding="utf-8")
    return session


def add_message(coordinator, key, text):
    session = coordinator.manager.get_or_create(key)
    session.add_message("user", text)
    coordinator.manager.save(session)
    with coordinator.transcript_for(key).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": "user", "content": text}) + "\n")


async def enable(coordinator, keys, recovery=None):
    draft = await coordinator.prepare(recovery)
    await coordinator.enable(draft["draft_id"], keys, True)
    return draft


async def initial_pair(desktops):
    service, create = desktops
    a, native_a = create("a")
    b, native_b = create("b")
    session = add_conversation(a)
    await enable(a, [session.key])
    await a.run_once()
    assert a.problem is None, a.problem
    await enable(b, [], native_a.recovery)
    await b.run_once()
    assert b.problem is None, b.problem
    imported = b.manager.list_sessions()[0]["key"]
    return service, a, b, native_a, native_b, session.key, imported


@pytest.mark.asyncio
async def test_disabled_and_prepare_never_upload_until_explicit_confirmation(desktops):
    service, create = desktops
    a, native = create("a")
    session = add_conversation(a)
    await a.run_once()
    assert native.calls == [] and service.space is None
    draft = await a.prepare()
    assert draft["recovery"] and service.space is None and not service.objects
    with pytest.raises(CloudTransferError):
        await a.enable(draft["draft_id"], [session.key], False)
    assert not a.preferences.read().enabled
    await a.enable(draft["draft_id"], [session.key], True)
    config = json.loads(a.preferences.path.read_text(encoding="utf-8"))
    assert config["unrelated"] == {"keep": True}
    assert native.recovery not in json.dumps(config)
    assert not service.objects
    await a.run_once()
    assert a.problem is None
    assert len(service.versions) == 1


@pytest.mark.asyncio
async def test_two_devices_restore_actual_history_then_idle_has_no_new_versions(desktops):
    service, a, b, _, _, akey, bkey = await initial_pair(desktops)
    assert b.manager.read_session_file(bkey)["messages"][0]["content"] == "first message"
    assert not list(b.media_root.rglob("data.txt"))
    assert b.preferences.read().session_keys == [bkey]
    assert len(service.versions) == 1 and len(next(iter(service.versions.values()))) == 1
    for coordinator in [a, b, a, b]:
        await coordinator.run_once()
        assert coordinator.problem is None, coordinator.problem
    assert sum(map(len, service.versions.values())) == 1
    add_message(b, bkey, "from device B")
    await b.run_once()
    assert b.problem is None, b.problem
    await a.run_once()
    assert a.problem is None, a.problem
    assert a.manager.read_session_file(akey)["messages"][-1]["content"] == "from device B"
    assert sum(map(len, service.versions.values())) == 2
    for coordinator in [a, b, a]:
        await coordinator.run_once()
        assert coordinator.problem is None, coordinator.problem
    assert sum(map(len, service.versions.values())) == 2


@pytest.mark.asyncio
async def test_committed_work_import_invalidates_views_once_without_replaying_tasks(desktops):
    _, a, b, na, nb, akey, bkey = await initial_pair(desktops)
    assert na.notifications == []
    assert nb.notifications == [{"work_keys": [bkey], "planning": False}]
    await b.run_once()
    assert len(nb.notifications) == 1
    add_message(a, akey, "updated on first computer")
    await a.run_once()
    await b.run_once()
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "updated on first computer"
    assert nb.notifications[-1] == {"work_keys": [bkey], "planning": False}
    assert len(nb.notifications) == 2
    assert not b.loop._active_tasks


@pytest.mark.asyncio
async def test_failed_view_notification_does_not_repeat_committed_sync(desktops):
    service, a, b, _, nb, akey, bkey = await initial_pair(desktops)
    def unavailable(command):
        if command == "cloud_sync_notify":
            raise OSError("Isolated native event failure")
    nb.hook = unavailable
    add_message(a, akey, "durably updated")
    await a.run_once()
    await b.run_once()
    assert b.problem is None
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "durably updated"
    count = sum(map(len, service.versions.values()))
    await b.run_once()
    assert b.problem is None and sum(map(len, service.versions.values())) == count


@pytest.mark.asyncio
async def test_development_and_unselected_work_never_upload(desktops):
    service, create = desktops
    a, _ = create("a")
    first = add_conversation(a)
    add_conversation(a, key="websocket:unselected", text="PRIVATE_UNSELECTED", attachment=False)
    add_conversation(a, key="development:dev-one", text="PRIVATE_CODE", attachment=False)
    draft = await a.prepare()
    assert "development:dev-one" not in {row["key"] for row in draft["candidates"]}
    with pytest.raises(CloudTransferError):
        await a.enable(draft["draft_id"], ["development:dev-one"], True)
    await a.enable(draft["draft_id"], [first.key], True)
    await a.run_once()
    assert a.problem is None
    assert len(service.versions) == 1
    assert set(a.store.owners()) == {first.key}


@pytest.mark.asyncio
async def test_pause_and_deselection_do_not_delete_and_reselection_catches_up(desktops):
    service, a, b, _, _, akey, bkey = await initial_pair(desktops)
    await b.select([])
    add_message(a, akey, "remote while excluded")
    await a.run_once()
    await b.run_once()
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "first answer"
    await b.select([bkey])
    await b.run_once()
    assert b.problem is None
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "remote while excluded"
    await b.pause()
    count = len(service.controls)
    add_message(b, bkey, "local while paused")
    await b.run_once()
    assert len(service.controls) == count
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "local while paused"


@pytest.mark.asyncio
async def test_concurrent_offline_edits_preserve_both_branches_without_repeat_fork(desktops):
    service, a, b, _, _, akey, bkey = await initial_pair(desktops)
    add_message(a, akey, "A independently edited")
    add_message(b, bkey, "B independently edited")
    await a.run_once()
    await b.run_once()
    assert b.problem is None, b.problem
    assert len(b.manager.list_sessions()) == 2
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "B independently edited"
    last = [b.manager.read_session_file(row["key"])["messages"][-1]["content"] for row in b.manager.list_sessions()]
    assert set(last) == {"A independently edited", "B independently edited"}
    assert len(service.versions) == 2
    for coordinator in [a, b, a, b]:
        await coordinator.run_once()
        assert coordinator.problem is None, coordinator.problem
    assert len(service.versions) == 2
    assert len(a.manager.list_sessions()) == len(b.manager.list_sessions()) == 2


@pytest.mark.asyncio
async def test_busy_session_defers_remote_update_until_current_task_ends(desktops):
    _, a, b, _, _, akey, bkey = await initial_pair(desktops)
    add_message(a, akey, "new remote")
    await a.run_once()
    lock = b.loop._session_locks.setdefault(bkey, asyncio.Lock())
    await lock.acquire()
    try:
        await b.run_once()
        assert b.phase == "waiting"
        assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "first answer"
    finally:
        lock.release()
    await b.run_once()
    assert b.problem is None
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "new remote"


@pytest.mark.asyncio
async def test_same_account_on_new_device_requires_recovery_key(desktops):
    service, create = desktops
    a, _ = create("a")
    await enable(a, [])
    b, _ = create("b")
    with pytest.raises(CloudTransferError) as exc:
        await b.prepare()
    assert exc.value.code == "recovery_required"
    assert service.space is not None


@pytest.mark.asyncio
async def test_switching_account_stops_sync_and_does_not_adopt_old_histories(desktops):
    service, a, _, native_a, _, akey, _ = await initial_pair(desktops)
    before = len(service.controls)
    native_a.account_id = "2"
    native_a.binding = "f" * 64
    await a.run_once()
    assert a.problem["code"] == "account_changed"
    assert len(service.controls) == before
    state = await a.status()
    assert state["enabled"] is False and state["selected_keys"] == []
    assert a.manager.read_session_file(akey)


@pytest.mark.asyncio
async def test_account_change_between_download_and_local_apply_never_writes(desktops):
    _, a, b, _, native_b, akey, bkey = await initial_pair(desktops)
    add_message(a, akey, "new remote")
    await a.run_once()
    calls = 0
    def switch(command):
        nonlocal calls
        if command == "cloud_sync_context":
            calls += 1
            if calls == 2:
                native_b.account_id = "2"
                native_b.binding = "e" * 64
    native_b.hook = switch
    await b.run_once()
    assert b.problem["code"] == "account_changed"
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "first answer"


@pytest.mark.asyncio
async def test_lost_commit_response_reconciles_without_duplicate_cloud_version(desktops):
    service, create = desktops
    a, _ = create("a")
    session = add_conversation(a)
    await enable(a, [session.key])
    service.lose_commit_response = True
    await a.run_once()
    assert a.problem is not None
    assert sum(map(len, service.versions.values())) == 1
    await a.run_once()
    assert a.problem is None, a.problem
    assert sum(map(len, service.versions.values())) == 1
    assert len(a.manager.list_sessions()) == 1


@pytest.mark.asyncio
async def test_failed_local_apply_rolls_back_both_histories_and_position(desktops, monkeypatch):
    _, a, b, _, _, akey, bkey = await initial_pair(desktops)
    session_path = b.manager.sessions_dir / f"{b.manager.safe_key(bkey)}.jsonl"
    old_session, old_display = session_path.read_bytes(), b.transcript_for(bkey).read_bytes()
    old_position = b.store.mappings(b.preferences.read().vault_id)
    add_message(a, akey, "new remote")
    await a.run_once()
    original_export = b._export
    def fail_after_write(key, vault, resource, origin=None):
        if session_path.read_bytes() != old_session:
            raise ValueError("injected disk validation error")
        return original_export(key, vault, resource, origin)
    monkeypatch.setattr(b, "_export", fail_after_write)
    await b.run_once()
    assert b.problem is not None
    assert session_path.read_bytes() == old_session
    assert b.transcript_for(bkey).read_bytes() == old_display
    assert b.store.mappings(b.preferences.read().vault_id) == old_position
    with b.store.connection() as db:
        assert db.execute("SELECT count(*) FROM history_journal").fetchone()[0] == 0


@pytest.mark.asyncio
async def test_status_never_returns_native_credentials_or_stored_recovery(desktops):
    _, a, _, native_a, _, _, _ = await initial_pair(desktops)
    state = await a.status()
    raw = json.dumps(state)
    assert native_a.binding not in raw and native_a.recovery not in raw
    assert "key_check" not in raw
    assert state["space"]["quota_bytes"] == 10_000_000_000


@pytest.mark.asyncio
async def test_background_worker_is_opt_in_and_closes_without_leaking_tasks(desktops):
    _, create = desktops
    a, native = create("a")
    await a.start()
    await asyncio.sleep(0.02)
    assert native.calls == []
    task = a.task
    await asyncio.wait_for(a.close(), 2)
    assert task.done() and a.task is None


@pytest.mark.asyncio
async def test_new_device_receives_latest_of_multiple_versions_on_first_sync(desktops):
    service, create = desktops
    a, native_a = create("a")
    session = add_conversation(a)
    await enable(a, [session.key])
    await a.run_once()
    for text in ["version two", "version three"]:
        add_message(a, session.key, text)
        await a.run_once()
        assert a.problem is None
    b, _ = create("b")
    await enable(b, [], native_a.recovery)
    await b.run_once()
    assert b.problem is None, b.problem
    records = b.manager.list_sessions()
    assert len(records) == 1
    assert b.manager.read_session_file(records[0]["key"])["messages"][-1]["content"] == "version three"
    assert sum(map(len, service.versions.values())) == 3


@pytest.mark.asyncio
async def test_existing_unmapped_local_history_is_not_overwritten_by_remote_key(desktops):
    _, create = desktops
    a, native_a = create("a")
    session = add_conversation(a)
    await enable(a, [session.key])
    await a.run_once()
    mapping = a.store.mappings(a.preferences.read().vault_id)[0]
    collision = f"websocket:cloud-{a.preferences.read().vault_id[:12]}-{mapping['resource']}"
    b, _ = create("b")
    add_conversation(b, key=collision, text="keep local history", attachment=False)
    await enable(b, [], native_a.recovery)
    await b.run_once()
    assert b.problem is None
    assert b.manager.read_session_file(collision)["messages"][0]["content"] == "keep local history"
    assert len(b.manager.list_sessions()) == 2


@pytest.mark.asyncio
async def test_concurrent_starts_share_exactly_one_worker(desktops):
    _, create = desktops
    a, native = create("a")
    await asyncio.gather(a.start(), a.start(), a.start())
    assert len([task for task in asyncio.all_tasks() if task.get_name() == "work-cloud-sync"]) == 1
    await a.close()
    assert native.calls == []


@pytest.mark.asyncio
async def test_worker_keeps_local_app_alive_with_invalid_sync_config(desktops):
    _, create = desktops
    a, _ = create("a")
    a.preferences.path.write_text("[]", encoding="utf-8")
    await a.start()
    await asyncio.sleep(0.02)
    assert not a.task.done()
    assert a.problem["code"] == "sync_configuration"
    await a.close()


@pytest.mark.asyncio
async def test_user_downloads_only_selected_cloud_file_then_opens_original_reference(desktops):
    _, _, b, _, _, _, bkey = await initial_pair(desktops)
    mapping = b.store.mappings(b.preferences.read().vault_id)[0]
    before = await b.files(mapping["resource"])
    assert len(before["files"]) == 1 and before["files"][0]["local"] is False
    result = await b.download_file(mapping["resource"], before["files"][0]["id"])
    assert result["downloaded"] is True
    restored_message = b.manager.read_session_file(bkey)["messages"][0]
    local_path = restored_message["media"][0]
    from pathlib import Path
    assert Path(local_path).read_text(encoding="utf-8") == "ATTACHMENT_BODY"
    assert (await b.files(mapping["resource"]))["files"][0]["local"] is True
    with pytest.raises(CloudTransferError):
        await b.download_file(mapping["resource"], "f" * 64)


@pytest.mark.asyncio
async def test_historical_restore_is_a_new_conversation_and_retry_is_idempotent(desktops):
    service, a, _, _, _, akey, _ = await initial_pair(desktops)
    mapping = a.store.mappings(a.preferences.read().vault_id)[0]
    add_message(a, akey, "latest must stay intact")
    await a.run_once()
    page = await a.history(mapping["resource"])
    assert [item["version"] for item in page["items"]] == [2, 1]
    with pytest.raises(CloudTransferError):
        await a.restore_version(mapping["resource"], 1, "a" * 32, False)
    result = await a.restore_version(mapping["resource"], 1, "a" * 32, True)
    assert result["restored"] is True and result["key"] != akey
    assert a.manager.read_session_file(akey)["messages"][-1]["content"] == "latest must stay intact"
    assert a.manager.read_session_file(result["key"])["messages"][-1]["content"] == "first answer"
    again = await a.restore_version(mapping["resource"], 1, "a" * 32, True)
    assert again["key"] == result["key"] and again["reused"] is True
    assert len(a.manager.list_sessions()) == 2
    await a.run_once()
    assert a.problem is None, a.problem
    assert len(service.versions) == 2
    assert len(service.versions[mapping["resource"]]) == 2


@pytest.mark.asyncio
async def test_history_rejects_unowned_resource_and_missing_version(desktops):
    _, a, _, _, _, _, _ = await initial_pair(desktops)
    with pytest.raises(CloudTransferError) as exc:
        await a.history("f" * 32)
    assert exc.value.code == "history_missing"
    mapping = a.store.mappings(a.preferences.read().vault_id)[0]
    with pytest.raises(CloudTransferError) as exc:
        await a.restore_version(mapping["resource"], 42, "c" * 32, True)
    assert exc.value.code == "history_missing"
    assert len(a.manager.list_sessions()) == 1


@pytest.mark.asyncio
async def test_downloading_only_does_not_create_cloud_versions_or_conflict_branches(desktops):
    service, a, b, _, _, akey, _ = await initial_pair(desktops)
    mapping = b.store.mappings(b.preferences.read().vault_id)[0]
    file = (await b.files(mapping["resource"]))["files"][0]
    await b.download_file(mapping["resource"], file["id"])
    for coordinator in [b, a, b]:
        await coordinator.run_once()
        assert coordinator.problem is None, coordinator.problem
    assert sum(map(len, service.versions.values())) == 1
    add_message(a, akey, "remote after attachment download")
    await a.run_once()
    await b.run_once()
    assert b.problem is None
    assert len(b.manager.list_sessions()) == 1
    assert sum(map(len, service.versions.values())) == 2


@pytest.mark.asyncio
async def test_auto_new_work_sync_keeps_initial_exclusions_and_survives_restart(desktops):
    service, create = desktops
    a, native = create("a")
    selected = add_conversation(a)
    excluded = add_conversation(a, key="websocket:excluded", attachment=False)
    draft = await a.prepare()
    await a.enable(draft["draft_id"], [selected.key], True, sync_new_conversations=True)
    await a.run_once()
    second = add_conversation(a, key="websocket:new-work", attachment=False)
    add_conversation(a, key="development:new-code", attachment=False)
    restarted = CloudCoordinator(a.loop, config_path=a.preferences.path, state_path=a.store.path,
        media_root=a.media_root, transcript_for=a.transcript_for, invoke=native.invoke,
        transport_factory=native.transport)
    await restarted.run_once()
    assert restarted.problem is None, restarted.problem
    assert set(restarted.preferences.read().session_keys) == {selected.key, second.key}
    assert restarted.preferences.read().excluded_session_keys == [excluded.key]
    assert len(service.versions) == 2
    await restarted.select([selected.key], sync_new_conversations=True)
    await restarted.run_once()
    assert restarted.preferences.read().session_keys == [selected.key]
    assert second.key in restarted.preferences.read().excluded_session_keys


@pytest.mark.asyncio
async def test_new_work_is_not_automatically_opted_in_for_existing_selected_only_setup(desktops):
    service, create = desktops
    a, _ = create("a")
    first = add_conversation(a)
    await enable(a, [first.key])
    add_conversation(a, key="websocket:later", attachment=False)
    await a.run_once()
    assert a.problem is None
    assert a.preferences.read().session_keys == [first.key]
    assert len(service.versions) == 1


@pytest.mark.asyncio
async def test_settings_candidates_use_real_metadata_not_lossy_list_projection(desktops):
    _, create = desktops
    a, _ = create("a")
    first = add_conversation(a)
    disallowed = add_conversation(a, key="websocket:legacy-code", attachment=False)
    disallowed.metadata["mode"] = "code"
    a.manager.save(disallowed)
    assert {item["key"] for item in (await a.prepare())["candidates"]} == {first.key}


@pytest.mark.asyncio
async def test_busy_selected_local_work_is_waiting_not_reported_as_fully_synced(desktops):
    service, create = desktops
    a, _ = create("a")
    session = add_conversation(a)
    await enable(a, [session.key])
    lock = a.loop._session_locks.setdefault(session.key, asyncio.Lock())
    async with lock:
        await a.run_once()
        assert a.phase == "waiting" and a.last_sync is None
        assert not service.versions
    await a.run_once()
    assert a.problem is None and a.phase == "idle" and a.last_sync is not None
    assert len(service.versions) == 1


@pytest.mark.asyncio
async def test_local_deleted_history_is_not_silently_recreated(desktops):
    _, a, b, _, _, akey, bkey = await initial_pair(desktops)
    b.manager.delete_session(bkey, prevent_recreation=True)
    add_message(a, akey, "a remote edit after B deleted local")
    await a.run_once()
    await b.run_once()
    assert b.problem is None
    assert b.manager.read_session_file(bkey) is None


@pytest.mark.asyncio
async def test_missing_selected_attachment_does_not_publish_or_report_complete(desktops):
    service, create = desktops
    a, _ = create("a")
    session = add_conversation(a)
    (a.media_root / "data.txt").unlink()
    await enable(a, [session.key])
    await a.run_once()
    assert a.phase == "error" and a.last_sync is None
    assert a.problem["code"] == "associated_file_unavailable"
    assert not service.versions
    assert a.manager.read_session_file(session.key)["messages"][0]["content"] == "first message"
    (a.media_root / "data.txt").write_text("ATTACHMENT_BODY", encoding="utf-8")
    await a.run_once()
    assert a.problem is None and a.phase == "idle" and a.last_sync is not None
    assert len(service.versions) == 1


@pytest.mark.asyncio
async def test_same_filename_never_hides_a_different_missing_attachment(desktops):
    service, a, b, _, _, _, bkey = await initial_pair(desktops)
    unrelated = b.media_root / "another" / "data.txt"
    unrelated.parent.mkdir()
    session = b.manager.get_or_create(bkey)
    session.add_message("user", "another attachment", media=[str(unrelated)])
    b.manager.save(session)
    previous_count = sum(map(len, service.versions.values()))
    await b.run_once()
    assert b.phase == "error" and b.problem["code"] == "associated_file_unavailable"
    assert sum(map(len, service.versions.values())) == previous_count
    assert b.manager.read_session_file(bkey)["messages"][-1]["content"] == "another attachment"
