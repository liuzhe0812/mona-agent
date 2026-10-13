"""Real coordinator/Notes client/encryption/ledger; native filesystem is a contract boundary.

The actual Rust Notes owner has matching filesystem/CAS/asset tests in notes/sync_tests.rs.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json

import pytest
from test_cloud_coordinator import desktops as desktops

from mona.cloud.notes import CHUNK, NotesClient, note_data
from mona.cloud.transfer import CloudTransferError
from mona.schedule.sync import encoded, fingerprint


def note(content="PRIVATE_NOTE_BODY", title="第一课", asset=None):
    value = {"notebook": "课程", "title": title, "content": content,
             "created_at": "2026-10-13T00:00:00Z", "updated_at": "2026-10-13T00:00:00Z",
             "note_type": "note", "aliases": ["入门"], "favorite": True, "assets": []}
    if asset is not None:
        sha = hashlib.sha256(asset).hexdigest()
        name = f"cloud-{sha}.png"
        value["assets"] = [{"name": name, "sha256": sha, "size": len(asset)}]
        value["content"] += f"\n![图](assets/{name})"
    return value


class NativeNotes:
    """Replace only Tauri's local storage RPC; not the sync algorithm or its consumer."""
    def __init__(self, boundary):
        self.boundary = boundary
        self.token = hashlib.sha256(f"notes-{boundary.name}".encode()).hexdigest()
        self.rows, self.assets, self.staging = {}, {}, {}
        self.calls = []
        self.broken = False
        self.before_apply = None

    def invoke(self, command, args, **kwargs):
        assert command == "cloud_notes"
        self.calls.append(args["action"])
        if args["binding"] != self.boundary.binding:
            raise CloudTransferError("account_changed", "account changed")
        if self.broken:
            raise OSError("isolated filesystem unavailable")
        action = args["action"]
        if action == "index":
            return {"vault": self.token, "items": [{"id": key, "fingerprint": fingerprint(value)} for key, value in self.rows.items()]}
        if args["vault"] != self.token:
            raise ValueError("vault changed")
        if action in ("read", "asset_read"):
            value = self.rows[args["note_id"]]
            if fingerprint(value) != args["expected"]:
                raise ValueError("local changed")
            if action == "read":
                return {"data": copy.deepcopy(value), "fingerprint": fingerprint(value)}
            assert args["name"] in {item["name"] for item in value["assets"]}
            raw = self.assets[args["name"]]
            end = min(len(raw), args["offset"] + CHUNK)
            return {"data": base64.b64encode(raw[args["offset"]:end]).decode(), "next": end, "complete": end == len(raw)}
        if action == "asset_write":
            name, size = args["name"], args["size"]
            if name in self.assets:
                assert hashlib.sha256(self.assets[name]).hexdigest() == args["sha256"]
                return {"received": size, "complete": True}
            raw = base64.b64decode(args["data"], validate=True)
            buffer = self.staging.setdefault(name, bytearray())
            if args["offset"] == len(buffer):
                buffer.extend(raw)
            else:
                assert buffer[args["offset"]:args["offset"] + len(raw)] == raw
            assert len(buffer) <= size
            if len(buffer) == size:
                assert hashlib.sha256(buffer).hexdigest() == args["sha256"]
                self.assets[name] = bytes(buffer)
            return {"received": len(buffer), "complete": len(buffer) == size}
        if action == "apply":
            if self.before_apply:
                self.before_apply(self.rows, args["note_id"])
                self.before_apply = None
            current = self.rows.get(args["note_id"])
            if current != args["data"] and fingerprint(current) != args["expected"]:
                raise ValueError("concurrent local write")
            if args["data"] is None:
                self.rows.pop(args["note_id"], None)
            else:
                data = note_data(args["data"])
                for asset in data["assets"]:
                    assert hashlib.sha256(self.assets[asset["name"]]).hexdigest() == asset["sha256"]
                self.rows[args["note_id"]] = copy.deepcopy(data)
            return {"applied": True}
        raise AssertionError(action)

    def put(self, item_id="note-a", content="PRIVATE_NOTE_BODY", asset=None):
        self.rows[item_id] = note(content, asset=asset)
        if asset is not None:
            self.assets[self.rows[item_id]["assets"][0]["name"]] = asset


@pytest.fixture
def notes_pair(desktops):
    service, create = desktops
    devices = []
    for name in ("a", "b"):
        coordinator, boundary = create(name)
        native = NativeNotes(boundary)
        coordinator.notes_client = NotesClient(native.invoke, boundary.binding)
        devices.append((coordinator, boundary, native))
    return service, *devices


async def enable(device, recovery=None, notes=True):
    coordinator, _, _ = device
    draft = await coordinator.prepare(recovery)
    await coordinator.enable(draft["draft_id"], [], True, sync_notes=notes)
    await coordinator.run_once()
    assert coordinator.problem is None, coordinator.problem


async def settle(*devices, rounds=2):
    for _ in range(rounds):
        for coordinator, _, _ in devices:
            await coordinator.run_once()
            assert coordinator.problem is None, coordinator.problem


def versions(service):
    return sum(map(len, service.versions.values()))


@pytest.mark.asyncio
async def test_real_encryption_two_devices_preserve_text_assets_and_followup_edits(notes_pair):
    service, a, b = notes_pair
    image = b"PRIVATE_IMAGE_BYTES" * 270_000
    a[2].put(asset=image)
    await enable(a)
    await enable(b, a[1].recovery)
    assert len(b[2].rows) == 1
    imported_id, imported = next(iter(b[2].rows.items()))
    assert imported == a[2].rows["note-a"]
    assert b[2].assets[imported["assets"][0]["name"]] == image
    wire = json.dumps(service.controls).encode() + b"".join(service.objects.values())
    assert b"PRIVATE_NOTE_BODY" not in wire and b"PRIVATE_IMAGE_BYTES" not in wire
    b[2].rows[imported_id]["content"] += "\n从另一台电脑继续编辑"
    await settle(b, a)
    assert a[2].rows["note-a"]["content"].endswith("从另一台电脑继续编辑")
    count = versions(service)
    await settle(a, b)
    assert versions(service) == count == 2
    assert len(service.uploads) == len(set(service.uploads))


@pytest.mark.asyncio
async def test_notes_are_opt_in_and_disabling_does_not_delete_local_or_cloud_data(notes_pair):
    service, a, b = notes_pair
    a[2].put()
    await enable(a, notes=False)
    assert a[2].calls == [] and versions(service) == 0
    await a[0].select([], sync_notes=True)
    await settle(a)
    await enable(b, a[1].recovery)
    await b[0].select([], sync_notes=False)
    a[2].rows["note-a"]["title"] = "新标题"
    await settle(a, b)
    assert next(iter(b[2].rows.values()))["title"] == "第一课"
    await b[0].select([], sync_notes=True)
    await settle(b, a)
    assert next(iter(b[2].rows.values()))["title"] == "新标题"
    assert versions(service) == 2


@pytest.mark.asyncio
async def test_enabling_notes_when_resuming_catches_up_previously_skipped_history(notes_pair):
    service, a, b = notes_pair
    a[2].put()
    await enable(a)
    await enable(b, a[1].recovery, notes=False)
    assert b[2].rows == {} and b[0].store.cursor(service.space["vault_id"]) > 0
    await b[0].pause()
    await enable(b, a[1].recovery, notes=True)
    assert list(b[2].rows.values()) == [a[2].rows["note-a"]]
    assert versions(service) == 1


@pytest.mark.asyncio
async def test_offline_conflicting_edits_preserve_both_versions_without_duplicate_copies(notes_pair):
    service, a, b = notes_pair
    a[2].put()
    await enable(a)
    await enable(b, a[1].recovery)
    imported = next(iter(b[2].rows))
    a[2].rows["note-a"]["content"] = "A端修改"
    b[2].rows[imported]["content"] = "B端修改"
    await settle(a, b, rounds=3)
    for device in (a, b):
        assert {row["content"] for row in device[2].rows.values()} == {"A端修改", "B端修改"}
        assert sum("同步冲突" in row["title"] for row in device[2].rows.values()) == 1
    before = versions(service)
    await settle(a, b)
    assert versions(service) == before


@pytest.mark.asyncio
async def test_confirmed_note_deletion_syncs_but_concurrent_local_edit_is_kept(notes_pair):
    _, a, b = notes_pair
    a[2].put()
    await enable(a)
    await enable(b, a[1].recovery)
    imported = next(iter(b[2].rows))
    del a[2].rows["note-a"]
    b[2].rows[imported]["content"] = "未丢失的本地修改"
    await settle(a, b, rounds=3)
    assert a[2].rows["note-a"]["content"] == "未丢失的本地修改"
    del a[2].rows["note-a"]
    await settle(a, b)
    assert a[2].rows == b[2].rows == {}


@pytest.mark.asyncio
async def test_failed_upload_and_corrupt_native_store_never_publish_empty_notes(notes_pair):
    service, a, _ = notes_pair
    a[2].put()
    await enable(a)
    before = versions(service)
    a[2].rows["note-a"]["content"] = "配额不足仍留在本机"
    service.quota = sum(map(len, service.objects.values()))
    await a[0].run_once()
    assert a[0].problem["code"] == "cloud_quota_exceeded"
    assert versions(service) == before
    a[2].broken = True
    await a[0].run_once()
    assert a[0].problem["code"] == "notes_unavailable"
    assert versions(service) == before and a[2].rows["note-a"]["content"] == "配额不足仍留在本机"


@pytest.mark.asyncio
async def test_account_or_vault_change_stops_before_writing_to_new_location(notes_pair):
    service, a, b = notes_pair
    a[2].put()
    await enable(a)
    await enable(b, a[1].recovery)
    baseline = copy.deepcopy(b[2].rows)
    b[2].token = hashlib.sha256(b"replacement-vault").hexdigest()
    a[2].rows["note-a"]["content"] = "new content"
    await settle(a)
    before = versions(service)
    await b[0].run_once()
    assert b[0].problem["code"] == "notes_vault_changed"
    assert b[2].rows == baseline and versions(service) == before
    b[1].account_id, b[1].binding = "2", "a" * 64
    await b[0].run_once()
    assert b[0].problem["code"] == "account_changed"
    assert b[2].rows == baseline


@pytest.mark.asyncio
async def test_lost_commit_response_reconciles_without_a_second_note(notes_pair):
    service, a, b = notes_pair
    a[2].put()
    draft = await a[0].prepare()
    await a[0].enable(draft["draft_id"], [], True, sync_notes=True)
    service.lose_commit_response = True
    await a[0].run_once()
    assert a[0].problem is not None and versions(service) == 1
    await settle(a)
    await enable(b, a[1].recovery)
    assert len(a[2].rows) == len(b[2].rows) == versions(service) == 1


@pytest.mark.asyncio
async def test_edit_during_native_apply_fails_cas_and_is_preserved(notes_pair):
    _, a, b = notes_pair
    a[2].put()
    await enable(a)
    await enable(b, a[1].recovery)
    a[2].rows["note-a"]["content"] = "remote update"
    await settle(a)
    b[2].before_apply = lambda rows, key: rows[key].update(content="local unsaved race")
    await b[0].run_once()
    assert b[0].problem is not None
    assert next(iter(b[2].rows.values()))["content"] == "local unsaved race"
    await settle(b, a, rounds=3)
    assert {row["content"] for row in b[2].rows.values()} == {"local unsaved race", "remote update"}


@pytest.mark.asyncio
async def test_empty_asset_and_asset_corruption_are_not_confused_with_missing_file(notes_pair):
    service, a, b = notes_pair
    a[2].put(asset=b"")
    await enable(a)
    await enable(b, a[1].recovery)
    name = next(iter(b[2].assets))
    assert b[2].assets[name] == b""
    a[2].put("other", asset=b"original")
    name = a[2].rows["other"]["assets"][0]["name"]
    a[2].assets[name] = b"changed!"
    before = versions(service)
    await a[0].run_once()
    assert a[0].problem is not None and versions(service) == before


@pytest.mark.parametrize("field,value", [("assets", [None]), ("favorite", "true"), ("title", []),
    ("permissions", "all"), ("aliases", "array")])
def test_portable_note_shape_rejects_extra_authority_or_malformed_fields(field, value):
    data = note()
    data[field] = value
    with pytest.raises(CloudTransferError):
        note_data(data)


def test_python_canonical_contract_matches_native_fixture():
    expected = '{"aliases":["入门"],"assets":[],"content":"body","created_at":"2026-10-13T00:00:00Z","favorite":true,"note_type":"note","notebook":"课程","title":"第一课","updated_at":"2026-10-13T00:00:00Z"}'
    assert encoded(note("body")).decode() == expected
