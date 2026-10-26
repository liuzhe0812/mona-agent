"""Per-host encrypted synchronization for terminal connection profiles."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import sqlite3

from mona.cloud.transfer import CloudTransferError
from mona.cloud.work_files import HEX64, ID32
from mona.schedule.sync import encoded, fingerprint

EMPTY = fingerprint(None)
_FIELDS = {"name", "protocol", "host", "port", "username", "auth_type", "credentials"}
_PROTOCOLS = {"ssh", "sftp", "ftp", "vnc"}
_AUTH_TYPES = {"password", "key", "agent"}
_MAX_ITEMS = 10_000
_MAX_DATA = 2 * 1024 * 1024


def _invalid(message="运维主机同步数据无效，本机配置已保留。"):
    raise CloudTransferError("operations_invalid", message)


def _credential_error():
    raise CloudTransferError("operations_credentials_invalid",
        "运维主机登录凭据无效或缺失，该主机已跳过；其他同步内容会继续处理。")


def validate_data(value):
    if not isinstance(value, dict) or set(value) != _FIELDS:
        _invalid()
    if (not isinstance(value["name"], str) or len(value["name"].encode()) > 240
            or not isinstance(value["protocol"], str) or value["protocol"] not in _PROTOCOLS
            or not isinstance(value["host"], str) or len(value["host"].encode()) > 1024
            or type(value["port"]) is not int or not 1 <= value["port"] <= 65535
            or not isinstance(value["username"], str) or len(value["username"].encode()) > 1024
            or not isinstance(value["auth_type"], str) or value["auth_type"] not in _AUTH_TYPES):
        _invalid()
    if value["protocol"] in {"ftp", "vnc"} and value["auth_type"] != "password":
        _invalid("该协议只支持密码认证。")

    credentials = value["credentials"]
    auth_type = value["auth_type"]
    if credentials is None:
        pass
    elif auth_type == "password":
        if (not isinstance(credentials, dict) or set(credentials) != {"password"}
                or not isinstance(credentials["password"], str)
                or len(credentials["password"].encode()) > 16 * 1024):
            _credential_error()
    elif auth_type == "key":
        if (not isinstance(credentials, dict) or set(credentials) != {"private_key", "passphrase"}
                or not isinstance(credentials["private_key"], str) or not credentials["private_key"]
                or len(credentials["private_key"].encode()) > 1024 * 1024
                or credentials["passphrase"] is not None and not isinstance(credentials["passphrase"], str)
                or isinstance(credentials["passphrase"], str) and len(credentials["passphrase"].encode()) > 16 * 1024):
            _credential_error()
    elif credentials is not None:
        _invalid()

    if len(encoded(value)) > _MAX_DATA:
        _invalid("运维主机配置过大，本机配置已保留。")
    return value


class OperationsClient:
    def __init__(self, invoke, binding, include_credentials=False):
        if type(include_credentials) is not bool:
            raise ValueError("include_credentials must be a boolean")
        self.invoke, self.binding = invoke, binding
        self.include_credentials = include_credentials
        self.local_store = ""

    async def request(self, action, **kwargs):
        try:
            result = await asyncio.to_thread(self.invoke, "cloud_operations", {
                "binding": self.binding, "action": action,
                "include_credentials": self.include_credentials, **kwargs}, timeout=65)
        except CloudTransferError as exc:
            if exc.code == "operations_credentials_invalid":
                _credential_error()
            raise CloudTransferError("operations_unavailable",
                "运维主机同步未完成，本机配置已保留，请稍后重试。") from None
        except Exception:
            raise CloudTransferError("operations_unavailable",
                "运维主机同步未完成，本机配置已保留，请稍后重试。") from None
        error = result.get("error") if isinstance(result, dict) else None
        error_code = error.get("code") if isinstance(error, dict) else error
        if error_code == "operations_credentials_invalid":
            _credential_error()
        if error is not None:
            raise CloudTransferError("operations_unavailable",
                "运维主机同步未完成，本机配置已保留，请稍后重试。")
        if not isinstance(result, dict):
            _invalid("运维主机本机存储返回异常，本机配置已保留。")
        return result

    async def index(self):
        result = await self.request("index")
        local_store, rows = result.get("vault"), result.get("items")
        if (not isinstance(local_store, str) or not HEX64.fullmatch(local_store)
                or not isinstance(rows, list) or len(rows) > _MAX_ITEMS):
            _invalid("运维主机本机索引无效，本机配置已保留。")
        if self.local_store and self.local_store != local_store:
            raise CloudTransferError("operations_store_changed",
                "运维主机本机存储位置已变化，未覆盖现有配置。")
        self.local_store = local_store
        index = {}
        for row in rows:
            if (not isinstance(row, dict) or set(row) != {"id", "fingerprint"}
                    or not isinstance(row["id"], str) or not row["id"] or len(row["id"].encode()) > 160
                    or row["id"] in index or not isinstance(row["fingerprint"], str)
                    or not HEX64.fullmatch(row["fingerprint"])):
                _invalid("运维主机本机索引无效，本机配置已保留。")
            index[row["id"]] = row["fingerprint"]
        return index

    async def read(self, connection_id, expected):
        if (not isinstance(connection_id, str) or not connection_id or len(connection_id.encode()) > 160
                or not isinstance(expected, str) or not HEX64.fullmatch(expected)):
            _invalid()
        result = await self.request("read", connection_id=connection_id, expected=expected)
        if result.get("fingerprint") != expected:
            raise CloudTransferError("operations_changed", "运维主机在读取期间发生变化，请重试同步。")
        data = result.get("data")
        if not self.include_credentials and isinstance(data, dict) and set(data) == _FIELDS:
            data = {**data, "credentials": None}
        return validate_data(data)

    async def apply(self, connection_id, expected, data):
        if (not isinstance(connection_id, str) or not connection_id or len(connection_id.encode()) > 160
                or not isinstance(expected, str) or not HEX64.fullmatch(expected)):
            _invalid()
        if data is not None:
            validate_data(data)
        result = await self.request("apply", connection_id=connection_id, expected=expected, data=data)
        applied_fingerprint = result.get("fingerprint")
        if result.get("applied") is not True or not isinstance(applied_fingerprint, str) or not HEX64.fullmatch(applied_fingerprint):
            raise CloudTransferError("operations_unconfirmed", "运维主机保存结果尚未确认，请稍后核对。")
        return applied_fingerprint


class OperationsSync:
    def __init__(self, store, client, transfer, guard):
        self.store, self.client, self.transfer, self.guard = store, client, transfer, guard
        self.vault = transfer.cipher.vault_id
        self.local_store = ""
        self.modified = False
        self.problem = None
        self._credential_issues = {}
        with store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS operations_sync_positions (
                local_store TEXT NOT NULL, vault TEXT NOT NULL, resource TEXT NOT NULL,
                local_id TEXT NOT NULL, local_fingerprint TEXT NOT NULL, manifest_id TEXT,
                version TEXT, PRIMARY KEY(local_store,vault,resource), UNIQUE(local_store,local_id))""")

    async def _index(self):
        rows = await self.client.index()
        if self.local_store and self.local_store != self.client.local_store:
            raise CloudTransferError("operations_store_changed",
                "运维主机本机存储位置已变化，未覆盖现有配置。")
        self.local_store = self.client.local_store
        return rows

    def mappings(self):
        if not self.local_store:
            return []
        with self.store.connection() as db:
            rows = db.execute("SELECT * FROM operations_sync_positions WHERE local_store=? AND vault=?",
                              (self.local_store, self.vault)).fetchall()
        return [{**dict(row), "version": json.loads(row["version"]) if row["version"] else None} for row in rows]

    def owners(self):
        if not self.local_store:
            return {}
        with self.store.connection() as db:
            rows = db.execute("SELECT local_id,vault,resource FROM operations_sync_positions WHERE local_store=?",
                              (self.local_store,)).fetchall()
        return {row["local_id"]: {"vault": row["vault"], "resource": row["resource"]} for row in rows}

    def put(self, resource, local_id, local_fingerprint, manifest_id, version):
        try:
            with self.store.connection() as db:
                db.execute("""INSERT INTO operations_sync_positions VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(local_store,vault,resource) DO UPDATE SET
                    local_fingerprint=excluded.local_fingerprint,manifest_id=excluded.manifest_id,
                    version=excluded.version""",
                    (self.local_store, self.vault, resource, local_id, local_fingerprint, manifest_id,
                     json.dumps(version, separators=(",", ":")) if version else None))
        except sqlite3.IntegrityError:
            raise CloudTransferError("operations_account_conflict",
                "运维主机已关联到其他云空间，未转移本机配置。") from None

    def _credential_problem(self, resource, connection_id=None):
        key = (resource, connection_id)
        self._credential_issues[key] = {"resource_id": resource,
            **({"connection_id": connection_id} if connection_id else {})}
        self.problem = {"code": "operations_credentials_invalid",
            "message": "部分运维主机的密码或私钥不可用；请在运维中补全，或在上传范围关闭“包含密码和 SSH 私钥”。其他内容会继续同步。",
            "items": list(self._credential_issues.values())}

    def _resource_for(self, local_id):
        return hashlib.sha256(f"mona-ops-host-v1:{self.vault}:{self.local_store}:{local_id}".encode()).hexdigest()[:32]

    def _mapping_for_resource(self, resource):
        return next((row for row in self.mappings() if row["resource"] == resource), None)

    def _remote_local_id(self, resource, index, owners):
        base = f"cloud-{self.vault[:12]}-{resource}"
        candidates = [base, f"cloud-{self.vault[:12]}-{hashlib.sha256((self.local_store + resource).encode()).hexdigest()[:32]}"]
        for candidate in candidates:
            owner = owners.get(candidate)
            if candidate not in index and owner is None:
                return candidate
        raise CloudTransferError("operations_mapping_conflict",
            "运维主机本机标识冲突，未覆盖已有配置。")

    async def _matches(self, local_id, current, desired):
        expected = copy.deepcopy(desired)
        if expected["credentials"] is None:
            expected["credentials"] = None
            reader = self.client
            try:
                existing = await reader.read(local_id, current)
            except CloudTransferError as exc:
                if exc.code != "operations_credentials_invalid":
                    raise
                reader = OperationsClient(self.client.invoke, self.client.binding, include_credentials=False)
                index = await reader.index()
                if reader.local_store != self.local_store or local_id not in index:
                    return False
                existing = await reader.read(local_id, index[local_id])
            existing["credentials"] = None
        elif self.client.include_credentials:
            existing = await self.client.read(local_id, current)
        else:
            reader = OperationsClient(self.client.invoke, self.client.binding, include_credentials=True)
            index = await reader.index()
            if reader.local_store != self.local_store or local_id not in index:
                return False
            try:
                existing = await reader.read(local_id, index[local_id])
            except CloudTransferError as exc:
                if exc.code == "operations_credentials_invalid":
                    return False
                raise
        return encoded(existing) == encoded(expected)

    @staticmethod
    def _conflict_copy(data):
        clone = copy.deepcopy(data)
        suffix = "（同步冲突）"
        prefix = clone["name"].encode()[:240 - len(suffix.encode())].decode("utf-8", "ignore")
        clone["name"] = prefix + suffix
        return clone

    @staticmethod
    def _validate_version(version):
        resource = version.get("resource_id") if isinstance(version, dict) else None
        number = version.get("version") if isinstance(version, dict) else None
        if (not isinstance(version, dict) or version.get("kind") != "ops_host"
                or not isinstance(resource, str) or not ID32.fullmatch(resource)
                or type(number) is not int or number < 1 or type(version.get("deleted")) is not bool):
            _invalid("运维主机云版本无效，本机配置已保留。")
        return resource

    def _pull(self, version):
        resource = self._validate_version(version)
        if version["deleted"] is True:
            if version.get("manifest_id") is not None or version.get("object_ids") != []:
                _invalid("运维主机删除记录无效，本机配置已保留。")
            return resource, None, None
        oid = version.get("manifest_id")
        if (not isinstance(oid, str) or not HEX64.fullmatch(oid) or version.get("object_ids") != [oid]):
            _invalid("运维主机云文件引用无效，本机配置已保留。")
        raw = self.transfer._get(oid, "bundle")
        if len(raw) > _MAX_DATA + 4096:
            _invalid("运维主机云配置过大，本机配置已保留。")
        try:
            bundle = json.loads(raw)
            if (not isinstance(bundle, dict)
                    or set(bundle) != {"format", "vault_id", "resource_id", "include_credentials", "data"}
                    or bundle["format"] != "mona-ops-host-v1" or bundle["vault_id"] != self.vault
                    or bundle["resource_id"] != resource or type(bundle["include_credentials"]) is not bool):
                _invalid()
            data = validate_data(bundle["data"])
            if not bundle["include_credentials"] and data["credentials"] is not None:
                _invalid()
            return resource, data, oid
        except CloudTransferError:
            raise
        except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
            _invalid("运维主机云内容校验失败，本机配置已保留。")

    async def _commit(self, resource, base_version, manifest_id, deleted):
        object_ids = [] if deleted else [manifest_id]
        payload = {"resource_id": resource, "kind": "ops_host", "base_version": base_version,
            "manifest_id": manifest_id, "object_ids": object_ids, "deleted": deleted}
        payload["operation_id"] = hashlib.sha256(encoded(payload)).hexdigest()
        await self.guard()
        version = await asyncio.to_thread(self.transfer.transport.control, "POST", "/resources/commit", payload)
        if (not isinstance(version, dict) or version.get("resource_id") != resource or version.get("kind") != "ops_host"
                or type(version.get("version")) is not int or version["version"] != base_version + 1
                or version.get("manifest_id") != manifest_id or version.get("object_ids") != object_ids
                or version.get("deleted") is not deleted):
            raise CloudTransferError("operations_unconfirmed", "运维主机云版本尚未确认。")
        return version

    async def receive(self, version):
        index = await self._index()
        owners = self.owners()
        resource = self._validate_version(version)
        mapping = self._mapping_for_resource(resource)
        if mapping and mapping["version"] and mapping["version"]["version"] >= version["version"]:
            return

        if version["deleted"]:
            _, remote, _ = await asyncio.to_thread(self._pull, version)
            if remote is not None:
                _invalid()
            if mapping:
                local_id = mapping["local_id"]
            else:
                local_id = self._remote_local_id(resource, index, owners)
            owner = owners.get(local_id)
            if owner and (owner["vault"], owner["resource"]) != (self.vault, resource):
                _invalid("运维主机已关联到其他云空间，未删除本机配置。")
            current = index.get(local_id, EMPTY)
            if mapping and current != EMPTY and current == mapping["local_fingerprint"]:
                deleted_fingerprint = await self.client.apply(local_id, current, None)
                if deleted_fingerprint != EMPTY:
                    _invalid("运维主机删除结果不一致，本机配置已保留。")
                current = EMPTY
                self.modified = True
            await self.guard()
            self.put(resource, local_id, current, None, version)
            return

        try:
            _, remote, remote_manifest = await asyncio.to_thread(self._pull, version)
        except CloudTransferError as exc:
            if exc.code != "operations_credentials_invalid":
                raise
            self._credential_problem(resource)
            return
        if remote is None:
            _invalid()
        local_id = mapping["local_id"] if mapping else self._remote_local_id(resource, index, owners)
        owner = owners.get(local_id)
        if owner and (owner["vault"], owner["resource"]) != (self.vault, resource):
            raise CloudTransferError("operations_account_conflict",
                "运维主机已关联到其他云空间，未覆盖本机配置。")
        if mapping is None:
            # Record the target before applying so a lost Native reply is reconciled
            # against the same connection_id on the next receive.
            await self.guard()
            self.put(resource, local_id, EMPTY, remote_manifest, None)
            mapping = self._mapping_for_resource(resource)
        current = index.get(local_id, EMPTY)
        local_unchanged = current == mapping["local_fingerprint"]
        remote_unchanged = mapping["manifest_id"] == remote_manifest

        pending_apply = (mapping["manifest_id"] == remote_manifest
            and (mapping["version"] is None or mapping["version"].get("manifest_id") != remote_manifest))
        if pending_apply:
            if current != EMPTY and await self._matches(local_id, current, remote):
                await self.guard()
                self.put(resource, local_id, current, remote_manifest, version)
                return
            if current == mapping["local_fingerprint"]:
                await self.guard()
                current = await self.client.apply(local_id, current, remote)
                self.modified = True
                await self.guard()
                self.put(resource, local_id, current, remote_manifest, version)
                return
            local_unchanged = remote_unchanged = False

        if not local_unchanged and not remote_unchanged:
            conflict_resource = hashlib.sha256(
                f"ops-host-conflict-v1:{self.vault}:{resource}:{version['version']}".encode()).hexdigest()[:32]
            conflict = self._mapping_for_resource(conflict_resource)
            conflict_id = conflict["local_id"] if conflict else self._remote_local_id(conflict_resource, index, owners)
            conflict_current = index.get(conflict_id, EMPTY)
            clone = self._conflict_copy(remote)
            if conflict_current == EMPTY:
                await self.guard()
                self.put(conflict_resource, conflict_id, EMPTY, None, None)
                conflict_current = await self.client.apply(conflict_id, EMPTY, clone)
                self.modified = True
            else:
                # A previous apply may have completed before its response was lost.
                if not await self._matches(conflict_id, conflict_current, clone):
                    raise CloudTransferError("operations_mapping_conflict",
                        "运维主机冲突副本标识已被占用，本机配置已保留。")
            await self.guard()
            self.put(conflict_resource, conflict_id, conflict_current, None, None)
            await self.guard()
            self.put(resource, local_id, mapping["local_fingerprint"], remote_manifest, version)
            return

        if local_unchanged and (current == EMPTY or not remote_unchanged):
            await self.guard()
            self.put(resource, local_id, current, remote_manifest, None)
            current = await self.client.apply(local_id, current, remote)
            self.modified = True
            await self.guard()
            self.put(resource, local_id, current, remote_manifest, version)
            return
        elif local_unchanged and remote_unchanged:
            pass
        elif remote_unchanged:
            # Keep an unpublished local edit when only the cloud sequence changed.
            await self.guard()
            self.put(resource, local_id, mapping["local_fingerprint"], remote_manifest, version)
            return
        await self.guard()
        self.put(resource, local_id, current, remote_manifest, version)

    async def send(self):
        index = await self._index()
        owners = self.owners()
        mappings = self.mappings()
        by_local = {row["local_id"]: row for row in mappings}
        sent = 0
        for local_id in sorted(set(index) | set(by_local)):
            owner = owners.get(local_id)
            if owner and owner["vault"] != self.vault:
                continue
            mapping = by_local.get(local_id)
            current = index.get(local_id, EMPTY)
            if current == EMPTY:
                if not mapping or not mapping["version"] or mapping["version"].get("deleted"):
                    continue
                resource = mapping["resource"]
                await self.guard()
                self.put(resource, local_id, mapping["local_fingerprint"], None, mapping["version"])
                version = await self._commit(resource, mapping["version"]["version"], None, True)
                await self.guard()
                self.put(resource, local_id, EMPTY, None, version)
                sent += 1
                if sent >= 20:
                    return False
                continue

            if mapping is None:
                resource = self._resource_for(local_id)
                mapping = self._mapping_for_resource(resource)
                if mapping and mapping["local_id"] != local_id:
                    raise CloudTransferError("operations_mapping_conflict",
                        "运维主机映射冲突，本机配置已保留。")
            if (mapping and mapping["version"] and not mapping["version"].get("deleted")
                    and current == mapping["local_fingerprint"]):
                continue
            try:
                data = await self.client.read(local_id, current)
            except CloudTransferError as exc:
                if exc.code != "operations_credentials_invalid":
                    raise
                if mapping is None:
                    resource = self._resource_for(local_id)
                else:
                    resource = mapping["resource"]
                self._credential_problem(resource, local_id)
                continue

            resource = mapping["resource"] if mapping else self._resource_for(local_id)
            envelope = {"format": "mona-ops-host-v1", "vault_id": self.vault,
                "resource_id": resource, "include_credentials": self.client.include_credentials,
                "data": data}
            raw = encoded(envelope)
            sealed = self.transfer.cipher.seal(raw, "bundle")
            if mapping and mapping["version"] and not mapping["version"].get("deleted"):
                if sealed.id == mapping["version"].get("manifest_id"):
                    await self.guard()
                    self.put(resource, local_id, current, sealed.id, mapping["version"])
                    continue

            await self.guard()
            manifest = await asyncio.to_thread(self.transfer._put, raw, "bundle")
            if manifest != sealed.id:
                _invalid("运维主机加密对象标识不一致。")
            await self.client.read(local_id, current)
            base = mapping["version"]["version"] if mapping and mapping["version"] else 0
            baseline = mapping["local_fingerprint"] if mapping else current
            pending_version = mapping["version"] if mapping else None
            await self.guard()
            self.put(resource, local_id, baseline, manifest, pending_version)
            version = await self._commit(resource, base, manifest, False)
            await self.guard()
            self.put(resource, local_id, current, manifest, version)
            sent += 1
            if sent >= 20:
                return False
        return True
