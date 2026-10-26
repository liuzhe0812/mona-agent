"""Encrypted per-host operations sync using the real transfer and local store."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import secrets

import pytest
from test_cloud_crypto_transfer import ObjectService

from mona.cloud.crypto import VaultCipher
from mona.cloud.local_state import LocalCloudStore
from mona.cloud.operations import EMPTY, OperationsClient, OperationsSync, validate_data
from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.schedule.sync import fingerprint


def host(name="Build", *, auth_type="agent", credentials=None, host_name="build.internal", port=22):
    return {"name": name, "protocol": "ssh", "host": host_name, "port": port,
        "username": "operator", "auth_type": auth_type, "credentials": copy.deepcopy(credentials)}


def test_protocol_authentication_matches_terminal_contract_and_allows_empty_vnc_fields():
    vnc = host(auth_type="password", host_name="screen.internal", port=5900)
    vnc.update(protocol="vnc", username="", credentials={"password": ""})
    assert validate_data(vnc) is vnc

    for protocol in ("ftp", "vnc"):
        invalid = host(auth_type="agent")
        invalid["protocol"] = protocol
        with pytest.raises(CloudTransferError):
            validate_data(invalid)


class NativeOperations:
    def __init__(self, name, *, local_store=None):
        self.local_store = local_store or hashlib.sha256(f"test-local-store:{name}".encode()).hexdigest()
        self.connections = {}
        self.calls = []
        self.credential_errors = set()
        self.lose_apply_response = False

    @staticmethod
    def _fingerprint(data, include_credentials):
        if data is None:
            return EMPTY
        visible = copy.deepcopy(data)
        if not include_credentials:
            visible["credentials"] = None
        return fingerprint({"include_credentials": include_credentials, "data": visible})

    def invoke(self, command, args, **kwargs):
        assert command == "cloud_operations"
        action = args["action"]
        include_credentials = args["include_credentials"]
        connection_id = args.get("connection_id")
        self.calls.append((action, include_credentials, connection_id))
        if action == "index":
            return {"vault": self.local_store, "items": [
                {"id": item, "fingerprint": self._fingerprint(data, include_credentials)}
                for item, data in sorted(self.connections.items())]}
        if action == "read":
            if connection_id in self.credential_errors:
                return {"error": {"code": "operations_credentials_invalid"}}
            data = self.connections.get(connection_id)
            expected = self._fingerprint(data, include_credentials)
            if args["expected"] != expected or data is None:
                raise RuntimeError("local record changed")
            visible = copy.deepcopy(data)
            if not include_credentials:
                visible["credentials"] = None
            return {"data": visible, "fingerprint": expected}
        if action == "apply":
            data = self.connections.get(connection_id)
            current = self._fingerprint(data, include_credentials)
            if args["expected"] != current:
                raise RuntimeError("local record changed")
            incoming = args["data"]
            if incoming is None:
                self.connections.pop(connection_id, None)
                return {"applied": True, "fingerprint": EMPTY}
            incoming = copy.deepcopy(incoming)
            if incoming["credentials"] is None and data is not None:
                incoming["credentials"] = copy.deepcopy(data["credentials"])
            self.connections[connection_id] = incoming
            if self.lose_apply_response:
                self.lose_apply_response = False
                raise RuntimeError("apply response was lost")
            return {"applied": True,
                "fingerprint": self._fingerprint(incoming, include_credentials)}
        raise AssertionError(action)


def make_sync(store, service, native, *, vault=None, include_credentials=False):
    cipher = vault or VaultCipher.generate()
    transfer = WorkTransfer(cipher, service)
    client = OperationsClient(native.invoke, "b" * 64, include_credentials=include_credentials)
    return OperationsSync(store, client, transfer, lambda: asyncio.sleep(0))


def cloud_versions(service):
    return sorted((version for versions in service.versions.values() for version in versions),
        key=lambda value: value["sequence"])


def contains_credential(raw, credential):
    return credential.encode() in raw


@pytest.mark.asyncio
async def test_new_device_receives_hosts_without_uploading_its_local_hosts(tmp_path):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / "source.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / "receiver.sqlite3")
    source_native = NativeOperations("source")
    receiver_native = NativeOperations("receiver")
    source_native.connections["source-host"] = host()
    receiver_native.connections["receiver-private"] = host("Private", host_name="private.internal")
    source = make_sync(source_store, service, source_native)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher)

    assert await source.send() is True
    before_versions, before_uploads = cloud_versions(service), list(service.uploads)
    await receiver.receive(before_versions[0])

    assert len(receiver_native.connections) == 2
    assert any(value["host"] == "build.internal" for value in receiver_native.connections.values())
    assert receiver_native.connections["receiver-private"]["host"] == "private.internal"
    assert cloud_versions(service) == before_versions
    assert service.uploads == before_uploads
    assert len(receiver.mappings()) == 1


@pytest.mark.asyncio
async def test_mapped_unchanged_host_applies_a_new_cloud_version(tmp_path):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / "source.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / "receiver.sqlite3")
    source_native = NativeOperations("source")
    receiver_native = NativeOperations("receiver")
    source_native.connections["source-host"] = host()
    source = make_sync(source_store, service, source_native)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher)

    await source.send()
    await receiver.receive(cloud_versions(service)[0])
    local_id = next(iter(receiver_native.connections))
    source_native.connections["source-host"]["port"] = 2200
    await source.send()

    await receiver.receive(cloud_versions(service)[-1])

    assert receiver_native.connections[local_id]["port"] == 2200
    assert len(receiver_native.connections) == 1


@pytest.mark.asyncio
async def test_first_receive_reconciles_a_lost_native_apply_reply_without_duplicate_hosts(tmp_path):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / "source.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / "receiver.sqlite3")
    source_native = NativeOperations("source")
    receiver_native = NativeOperations("receiver")
    source_native.connections["source-host"] = host()
    source = make_sync(source_store, service, source_native)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher)
    await source.send()
    remote = cloud_versions(service)[0]
    receiver_native.lose_apply_response = True

    with pytest.raises(CloudTransferError, match="运维主机同步未完成"):
        await receiver.receive(remote)
    assert len(receiver_native.connections) == 1
    assert receiver.mappings()[0]["version"] is None

    await receiver.receive(remote)

    assert len(receiver_native.connections) == 1
    assert receiver.mappings()[0]["version"]["version"] == 1


@pytest.mark.asyncio
async def test_source_commit_reply_loss_is_reconciled_without_reapplying_its_own_host(tmp_path):
    service = ObjectService()
    store = LocalCloudStore(tmp_path / "state.sqlite3")
    native = NativeOperations("source")
    native.connections["source-host"] = host()
    sync = make_sync(store, service, native)
    service.lose_commit_response = True

    with pytest.raises(TimeoutError):
        await sync.send()
    assert len(cloud_versions(service)) == 1
    pending = sync.mappings()[0]
    assert pending["version"] is None

    await sync.receive(cloud_versions(service)[0])
    await sync.send()

    assert len(cloud_versions(service)) == 1
    assert set(native.connections) == {"source-host"}
    assert not any(action == "apply" for action, _, _ in native.calls)
    assert sync.mappings()[0]["version"]["version"] == 1


@pytest.mark.asyncio
async def test_credential_mode_changes_publish_encrypted_updates_without_plaintext_storage(tmp_path):
    service = ObjectService()
    store = LocalCloudStore(tmp_path / "state.sqlite3")
    native = NativeOperations("source")
    secret = secrets.token_urlsafe(48)
    native.connections["source-host"] = host(auth_type="password", credentials={"password": secret})

    metadata_only = make_sync(store, service, native, include_credentials=False)
    assert await metadata_only.send() is True
    versions = cloud_versions(service)
    first = json.loads(metadata_only.transfer._get(versions[-1]["manifest_id"], "bundle"))
    assert first["include_credentials"] is False
    assert first["data"]["credentials"] is None

    with_credentials = make_sync(store, service, native, vault=metadata_only.transfer.cipher,
        include_credentials=True)
    assert await with_credentials.send() is True
    versions = cloud_versions(service)
    second = json.loads(with_credentials.transfer._get(versions[-1]["manifest_id"], "bundle"))
    assert second["include_credentials"] is True
    assert secrets.compare_digest(second["data"]["credentials"]["password"], secret)

    metadata_again = make_sync(store, service, native, vault=metadata_only.transfer.cipher,
        include_credentials=False)
    assert await metadata_again.send() is True
    versions = cloud_versions(service)
    third = json.loads(metadata_again.transfer._get(versions[-1]["manifest_id"], "bundle"))
    assert third["include_credentials"] is False
    assert third["data"]["credentials"] is None
    assert len(versions) == 3
    assert len({item["manifest_id"] for item in versions}) == 2
    assert versions[0]["manifest_id"] == versions[2]["manifest_id"]
    assert not contains_credential(b"".join(service.objects.values()), secret)
    assert not contains_credential(store.path.read_bytes(), secret)


@pytest.mark.asyncio
async def test_receiver_restores_included_credentials_even_when_its_upload_mode_is_off(tmp_path):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / "source.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / "receiver.sqlite3")
    source_native = NativeOperations("source")
    receiver_native = NativeOperations("receiver")
    secret = secrets.token_urlsafe(48)
    source_native.connections["source-host"] = host(auth_type="password", credentials={"password": secret})
    source = make_sync(source_store, service, source_native, include_credentials=True)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher,
        include_credentials=False)

    assert await source.send() is True
    versions_before = cloud_versions(service)
    await receiver.receive(versions_before[0])

    received = next(iter(receiver_native.connections.values()))
    assert secrets.compare_digest(received["credentials"]["password"], secret)
    assert cloud_versions(service) == versions_before
    assert not contains_credential(b"".join(service.objects.values()), secret)
    assert not contains_credential(source_store.path.read_bytes(), secret)
    assert not contains_credential(receiver_store.path.read_bytes(), secret)


@pytest.mark.asyncio
async def test_local_host_mapping_is_not_reclaimed_by_another_cloud_vault(tmp_path):
    service = ObjectService()
    store = LocalCloudStore(tmp_path / "state.sqlite3")
    native = NativeOperations("same-local-store")
    native.connections["local-host"] = host()
    first_vault = VaultCipher.generate()
    first = make_sync(store, service, native, vault=first_vault)
    assert await first.send() is True
    first_versions = cloud_versions(service)

    second = make_sync(store, service, native, vault=VaultCipher.generate())
    assert await second.send() is True

    assert cloud_versions(service) == first_versions
    assert {row["vault"] for row in first.mappings()} == {first_vault.vault_id}
    assert second.mappings() == []


@pytest.mark.asyncio
async def test_remote_conflict_copy_is_idempotent_and_preserves_publishable_local_edit(tmp_path):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / "source.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / "receiver.sqlite3")
    source_native = NativeOperations("source")
    receiver_native = NativeOperations("receiver")
    source_native.connections["source-host"] = host()
    source = make_sync(source_store, service, source_native)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher)

    await source.send()
    first = cloud_versions(service)[0]
    await receiver.receive(first)
    local_id = next(iter(receiver_native.connections))

    source_native.connections["source-host"]["port"] = 2200
    await source.send()
    second = cloud_versions(service)[-1]
    receiver_native.connections[local_id]["port"] = 2022
    await receiver.receive(second)
    assert receiver_native.connections[local_id]["port"] == 2022
    assert len(receiver_native.connections) == 2
    assert any(value["port"] == 2200 and value["name"].endswith("（同步冲突）")
        for value in receiver_native.connections.values())
    await receiver.receive(second)
    assert len(receiver_native.connections) == 2

    resource = first["resource_id"]
    await receiver.send()
    assert len(service.versions[resource]) == 3
    uploaded_local = service.versions[resource][-1]
    bundle = json.loads(receiver.transfer._get(uploaded_local["manifest_id"], "bundle"))
    assert bundle["data"]["port"] == 2022
    assert sum(len(rows) for key, rows in service.versions.items() if key != resource) == 1



@pytest.mark.asyncio
@pytest.mark.parametrize("changed", [False, True])
async def test_remote_deletion_only_removes_an_unchanged_mapped_host(tmp_path, changed):
    service = ObjectService()
    source_store = LocalCloudStore(tmp_path / f"source-{changed}.sqlite3")
    receiver_store = LocalCloudStore(tmp_path / f"receiver-{changed}.sqlite3")
    source_native = NativeOperations(f"source-{changed}")
    receiver_native = NativeOperations(f"receiver-{changed}")
    source_native.connections["source-host"] = host()
    source = make_sync(source_store, service, source_native)
    receiver = make_sync(receiver_store, service, receiver_native, vault=source.transfer.cipher)

    await source.send()
    await receiver.receive(cloud_versions(service)[0])
    local_id = next(iter(receiver_native.connections))
    if changed:
        receiver_native.connections[local_id]["port"] = 2022
    del source_native.connections["source-host"]
    await source.send()
    deletion = cloud_versions(service)[-1]

    await receiver.receive(deletion)
    await receiver.receive(deletion)
    assert (local_id in receiver_native.connections) is changed
    if changed:
        assert receiver_native.connections[local_id]["port"] == 2022


@pytest.mark.asyncio
async def test_missing_source_credentials_skip_only_that_host_and_report_a_redacted_problem(tmp_path):
    service = ObjectService()
    store = LocalCloudStore(tmp_path / "state.sqlite3")
    native = NativeOperations("source")
    native.connections["invalid-password-host"] = host(auth_type="password")
    native.connections["agent-host"] = host("Agent", auth_type="agent", host_name="agent.internal")
    native.credential_errors.add("invalid-password-host")
    sync = make_sync(store, service, native, include_credentials=True)

    assert await sync.send() is True

    assert len(cloud_versions(service)) == 1
    assert sync.problem == {
        "code": "operations_credentials_invalid",
        "message": "部分运维主机的密码或私钥不可用；请在运维中补全，或在上传范围关闭“包含密码和 SSH 私钥”。其他内容会继续同步。",
        "items": [{"resource_id": sync._resource_for("invalid-password-host"), "connection_id": "invalid-password-host"}],
    }
    assert "invalid-password-host" not in b"".join(service.objects.values()).decode("latin1")
