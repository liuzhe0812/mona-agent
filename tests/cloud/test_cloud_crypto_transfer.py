"""Two local device fixtures exercising real encryption and Work transfer logic."""
from __future__ import annotations

import copy
import hashlib
import json
from threading import Event

import pytest

from mona.cloud.crypto import CloudCryptoError, VaultCipher, qiniu_etag
from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.cloud.work_snapshot import export_work_snapshot, prepare_work_restore
from mona.session.manager import Session, SessionManager


class ObjectService:
    """Storage/network substitute only; transfer and crypto are production code."""
    def __init__(self, quota=10_000_000_000):
        self.objects = {}
        self.pending = {}
        self.versions = {}
        self.operations = {}
        self.quota = quota
        self.uploads = []
        self.downloads = []
        self.controls = []
        self.lose_commit_response = False

    def control(self, method, path, payload=None):
        self.controls.append((method, path, copy.deepcopy(payload)))
        if path == "/objects/reserve":
            oid = payload["id"]
            if oid in self.objects:
                return {"id": oid, "state": "ready"}
            used = sum(len(data) for data in self.objects.values())
            reserved = sum(item["size"] for key, item in self.pending.items() if key not in self.objects and key != oid)
            if used + reserved + payload["size"] > self.quota:
                raise CloudTransferError("cloud_quota_exceeded", "quota")
            self.pending[oid] = copy.deepcopy(payload)
            return {"id": oid, "state": "pending"}
        if path.endswith("/confirm"):
            oid = path.split("/")[2]
            data = self.objects[oid]
            assert len(data) == self.pending[oid]["size"]
            assert qiniu_etag(data) == self.pending[oid]["etag"]
            return {"id": oid, "state": "ready"}
        if path.endswith("/download"):
            oid = path.split("/")[2]
            return {"sha256": oid, "size": len(self.objects[oid]), "url": oid}
        if path == "/resources/commit":
            operation = payload["operation_id"]
            if operation in self.operations:
                return copy.deepcopy(self.operations[operation])
            rid = payload["resource_id"]
            previous = self.versions.get(rid, [])
            if payload["base_version"] != len(previous):
                raise CloudTransferError("cloud_version_conflict", "version changed")
            assert all(oid in self.objects for oid in payload["object_ids"])
            version = {"sequence": sum(map(len, self.versions.values())) + 1,
                "resource_id": rid, "kind": payload["kind"], "version": len(previous) + 1,
                "manifest_id": payload["manifest_id"], "object_ids": payload["object_ids"], "deleted": payload["deleted"]}
            self.versions.setdefault(rid, []).append(version)
            self.operations[operation] = version
            if self.lose_commit_response:
                self.lose_commit_response = False
                raise TimeoutError("response lost after durable commit")
            return copy.deepcopy(version)
        raise AssertionError(path)

    def upload(self, authorization, ciphertext):
        oid = authorization["id"]
        assert hashlib.sha256(ciphertext).hexdigest() == oid
        self.objects[oid] = ciphertext
        self.uploads.append(oid)

    def download(self, authorization):
        self.downloads.append(authorization["sha256"])
        return self.objects[authorization["sha256"]]


@pytest.fixture
def example(tmp_path):
    root = tmp_path / "a"
    manager = SessionManager(root)
    media = tmp_path / "a-media"
    media.mkdir()
    file = media / "资料.txt"
    file.write_bytes(b"PERSONAL_FILE_BODY")
    session = Session("websocket:sync-1", metadata={"title": "PERSONAL_SESSION_TITLE", "webui": True})
    session.add_message("user", "PERSONAL_MESSAGE_BODY", media=[str(file)])
    session.add_message("assistant", "RESULT")
    manager.save(session)
    transcript = tmp_path / "display.jsonl"
    transcript.write_text(json.dumps({"event": "user", "content": "USER_DISPLAY"}) + "\n", encoding="utf-8")
    cipher = VaultCipher.generate()
    export = export_work_snapshot(manager, session.key, vault_id=cipher.vault_id,
        resource_id="b" * 32, transcript_path=transcript, media_root=media)
    return cipher, export, manager, session, transcript, media


def test_recovery_key_roundtrips_and_invalid_copy_is_rejected():
    cipher = VaultCipher.generate()
    recovered = VaultCipher.from_recovery(cipher.recovery_text())
    assert recovered.matches_key_check(cipher.key_check())
    assert not VaultCipher.generate().matches_key_check(cipher.key_check())
    for text in ("", cipher.recovery_text()[:-1], cipher.recovery_text() + "x", "not-a-key"):
        with pytest.raises(CloudCryptoError):
            VaultCipher.from_recovery(text)


def test_ciphertext_deduplicates_only_in_same_vault_and_is_purpose_bound():
    cipher = VaultCipher.generate()
    a = cipher.seal(b"same input", "records")
    assert cipher.seal(b"same input", "records") == a
    assert VaultCipher.from_recovery(cipher.recovery_text()).seal(b"same input", "records") == a
    assert VaultCipher.generate().seal(b"same input", "records").id != a.id
    assert cipher.open(a.id, a.ciphertext, "records") == b"same input"
    with pytest.raises(CloudCryptoError):
        cipher.open(a.id, a.ciphertext, "file")
    bad = a.ciphertext[:-1] + bytes([a.ciphertext[-1] ^ 1])
    with pytest.raises(CloudCryptoError):
        cipher.open(hashlib.sha256(bad).hexdigest(), bad, "records")


@pytest.mark.parametrize("data", [b"", b"a" * 1_000_000, bytes(range(256)) * 1000],
                         ids=["empty", "compressible", "binary"])
def test_empty_and_compressed_payloads(data):
    cipher = VaultCipher.generate()
    item = cipher.seal(data, "file")
    assert len(item.ciphertext) >= 35
    assert len(item.reservation["etag"]) == 28
    assert cipher.open(item.id, item.ciphertext, "file") == data


def test_two_device_roundtrip_downloads_history_before_files(example, tmp_path):
    cipher, export, *_ = example
    server = ObjectService()
    a = WorkTransfer(cipher, server)
    version = a.push(export, base_version=0)
    assert version["version"] == 1
    on_wire = json.dumps(server.controls).encode() + b"".join(server.objects.values())
    for secret in [b"PERSONAL_SESSION_TITLE", b"PERSONAL_FILE_BODY", b"PERSONAL_MESSAGE_BODY"]:
        assert secret not in on_wire
    b = WorkTransfer(VaultCipher.from_recovery(cipher.recovery_text()), server)
    downloaded = b.pull(version)
    assert downloaded.snapshot == export.snapshot
    file_blocks = downloaded.bundle["files"][0]["chunks"]
    assert all(oid not in server.downloads for oid in file_blocks)
    root = tmp_path / "device-b"
    root.mkdir()
    media = tmp_path / "device-b-media"
    media.mkdir()
    path = b.materialize(downloaded, export.snapshot["files"][0]["id"], workspace=root, media_root=media)
    assert path.read_bytes() == b"PERSONAL_FILE_BODY"


def test_retry_after_lost_commit_response_does_not_create_another_version(example):
    cipher, export, *_ = example
    server = ObjectService()
    transfer = WorkTransfer(cipher, server)
    server.lose_commit_response = True
    with pytest.raises(TimeoutError):
        transfer.push(export, base_version=0)
    upload_count = len(server.uploads)
    result = transfer.push(export, base_version=0)
    assert result["version"] == 1
    assert len(server.versions[export.snapshot["resource_id"]]) == 1
    assert len(server.uploads) == upload_count


def test_unmodified_file_blocks_reused_for_next_turn(example):
    cipher, export, manager, session, transcript, media = example
    server = ObjectService()
    transfer = WorkTransfer(cipher, server)
    first = transfer.push(export, base_version=0)
    previous = transfer.pull(first)
    file_ids = set(previous.bundle["files"][0]["chunks"])
    upload_count = len(server.uploads)
    session.add_message("user", "second request")
    manager.save(session)
    changed = export_work_snapshot(manager, session.key, vault_id=cipher.vault_id,
        resource_id=export.snapshot["resource_id"], transcript_path=transcript, media_root=media)
    second = transfer.push(changed, base_version=1)
    assert second["version"] == 2
    assert not file_ids.intersection(server.uploads[upload_count:])
    assert file_ids.issubset(second["object_ids"])


def test_remote_only_files_survive_next_message_on_device_b(example, tmp_path):
    cipher, export, *_ = example
    server = ObjectService()
    transfer = WorkTransfer(cipher, server)
    previous = transfer.pull(transfer.push(export, base_version=0))
    root = tmp_path / "b"
    root.mkdir()
    media = tmp_path / "b-media"
    media.mkdir()
    restored = prepare_work_restore(previous.snapshot, vault_id=cipher.vault_id,
        resource_id=export.snapshot["resource_id"], workspace=root, media_root=media)
    manager = SessionManager(root)
    restored.session.add_message("user", "continue without opening files")
    manager.save(restored.session)
    display = tmp_path / "b-display.jsonl"
    display.write_text("".join(json.dumps(r) + "\n" for r in restored.display), encoding="utf-8")
    changed = export_work_snapshot(manager, restored.session.key, vault_id=cipher.vault_id,
        resource_id=export.snapshot["resource_id"], transcript_path=display, media_root=media)
    assert not changed.sources
    result = transfer.push(changed, base_version=1, previous=previous)
    recovered = transfer.pull(result)
    assert recovered.bundle["files"] == previous.bundle["files"]


def test_missing_original_attachment_reuses_its_exact_confirmed_cloud_copy(example):
    cipher, exported, manager, session, transcript, media = example
    service = ObjectService()
    transfer = WorkTransfer(cipher, service)
    previous = transfer.pull(transfer.push(exported, base_version=0))
    (media / "资料.txt").unlink()
    session.add_message("user", "continue after removing local cached file")
    manager.save(session)
    changed = export_work_snapshot(manager, session.key, vault_id=cipher.vault_id,
        resource_id=exported.snapshot["resource_id"], transcript_path=transcript, media_root=media)
    assert not changed.sources
    version = transfer.push(changed, base_version=1, previous=previous)
    restored = transfer.pull(version)
    assert restored.bundle["files"] == previous.bundle["files"]
    assert restored.snapshot["files"][0]["id"] == exported.snapshot["files"][0]["id"]
    assert restored.snapshot["unavailable_files"] == []
    assert changed.snapshot["unavailable_files"]  # Immutable caller snapshot was not altered.


def test_unavailable_attachments_report_each_file_before_any_upload(example, monkeypatch):
    cipher, exported, manager, session, transcript, media = example
    (media / "资料.txt").unlink()
    large = media / "video.mp4"
    large.write_bytes(b"x" * 20)
    session.add_message("user", "another attachment", media=[str(large)])
    manager.save(session)
    monkeypatch.setattr("mona.cloud.work_files.MAX_FILE_BYTES", 10)
    monkeypatch.setattr("mona.cloud.transfer.MAX_FILE_BYTES", 10)
    changed = export_work_snapshot(manager, session.key, vault_id=cipher.vault_id,
        resource_id=exported.snapshot["resource_id"], transcript_path=transcript, media_root=media)
    service = ObjectService()
    with pytest.raises(CloudTransferError) as exc:
        WorkTransfer(cipher, service).push(changed, base_version=0)
    assert exc.value.code == "associated_file_unavailable"
    assert exc.value.files == [
        {"name": "资料.txt", "reason": "missing", "source_path": str(media / "资料.txt")},
        {"name": "video.mp4", "reason": "file_too_large", "source_path": str(large),
         "size": 20, "limit_bytes": 10},
    ]
    assert not service.uploads and not service.versions
    changed.bytes()


def test_stale_write_preserves_original_cloud_version(example):
    cipher, export, *_ = example
    server = ObjectService()
    transfer = WorkTransfer(cipher, server)
    version = transfer.push(export, base_version=0)
    # Same content with a different expected base is a distinct CAS operation.
    with pytest.raises(CloudTransferError) as error:
        transfer.push(export, base_version=5)
    assert error.value.code == "cloud_version_conflict"
    assert server.versions[export.snapshot["resource_id"]] == [version]


def test_cancel_and_quota_failure_do_not_publish_incomplete_manifest(example):
    cipher, export, *_ = example
    event = Event()
    event.set()
    server = ObjectService()
    with pytest.raises(CloudTransferError):
        WorkTransfer(cipher, server, cancelled=event).push(export, base_version=0)
    assert not server.objects and not server.versions
    constrained = ObjectService(quota=40)
    with pytest.raises(CloudTransferError):
        WorkTransfer(cipher, constrained).push(export, base_version=0)
    assert not constrained.versions


def test_wrong_vault_and_corrupt_object_never_restore_data(example):
    cipher, export, *_ = example
    server = ObjectService()
    version = WorkTransfer(cipher, server).push(export, base_version=0)
    with pytest.raises(CloudTransferError):
        WorkTransfer(VaultCipher.generate(), server).pull(version)
    oid = version["manifest_id"]
    data = bytearray(server.objects[oid])
    data[-1] ^= 1
    server.objects[oid] = bytes(data)
    with pytest.raises(CloudTransferError):
        WorkTransfer(cipher, server).pull(version)
