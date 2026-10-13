"""Item-level personal planning sync, sharing Work's encryption and cloud ledger."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from urllib.parse import urlsplit

import httpx

from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.cloud.work_files import HEX64, ID32
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token
from mona.schedule.sync import IDENTIFIER, KINDS, MAX_STORE, encoded, fingerprint, normalize_item


class PlanningClient:
    """Only the Services process may mutate the live calendar/todo stores."""
    def __init__(self, port: int):
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Invalid Services port")
        self.base = f"http://127.0.0.1:{port}"

    async def _request(self, method, kind, body=None):
        if kind not in KINDS or urlsplit(self.base).hostname != "127.0.0.1":
            raise CloudTransferError("planning_invalid", "日程同步请求无效。")
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
                async with client.stream(method, f"{self.base}/api/schedule/sync/{kind}", json=body,
                        headers={SERVICES_TOKEN_HEADER: get_services_token()}) as response:
                    if response.status_code != 200:
                        raise CloudTransferError("planning_unavailable", "日程同步未完成，本地修改已保留，请稍后重试。")
                    data = bytearray()
                    async for chunk in response.aiter_bytes(64 * 1024):
                        if len(data) + len(chunk) > MAX_STORE:
                            raise ValueError("Large response")
                        data.extend(chunk)
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("Invalid response")
            return result
        except (httpx.HTTPError, ValueError, TypeError):
            raise CloudTransferError("planning_unavailable", "暂时无法同步日程，本地内容未丢失。") from None

    async def list(self, kind):
        result = await self._request("GET", kind)
        rows = result.get("items")
        if not isinstance(rows, list) or len(rows) > 10_000:
            raise CloudTransferError("planning_invalid", "日程列表返回异常。")
        items = {}
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not IDENTIFIER.fullmatch(row["id"]) or row["id"] in items:
                raise CloudTransferError("planning_invalid", "日程列表标识无效。")
            items[row["id"]] = normalize_item(kind, row.get("data"), incoming=True)
        return items

    async def apply(self, kind, item_id, before, data):
        result = await self._request("POST", kind, {"id": item_id, "expected": fingerprint(before), "data": data})
        if result.get("applied") is not True or result.get("data") != data:
            raise CloudTransferError("planning_unconfirmed", "日程保存结果尚未确认，请稍后核对。")


class PlanningState:
    def __init__(self, store):
        self.store = store
        with store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS planning_sync_positions (
                vault TEXT NOT NULL, resource TEXT NOT NULL, kind TEXT NOT NULL,
                local_id TEXT NOT NULL, base TEXT NOT NULL, version TEXT,
                conflict INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(vault,resource), UNIQUE(kind,local_id))""")

    def rows(self, vault):
        with self.store.connection() as db:
            rows = db.execute("SELECT * FROM planning_sync_positions WHERE vault=?", (vault,)).fetchall()
        return [{**dict(row), "base": json.loads(row["base"]), "version": json.loads(row["version"]) if row["version"] else None} for row in rows]

    def owners(self):
        with self.store.connection() as db:
            rows = db.execute("SELECT kind,local_id,vault FROM planning_sync_positions").fetchall()
        return {(row["kind"], row["local_id"]): row["vault"] for row in rows}

    def put(self, vault, resource, kind, local_id, base, version, conflict=False):
        with self.store.connection() as db:
            db.execute("""INSERT INTO planning_sync_positions VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(vault,resource) DO UPDATE SET base=excluded.base,
                version=excluded.version, conflict=MAX(conflict,excluded.conflict)""",
                (vault, resource, kind, local_id, json.dumps(base, ensure_ascii=False),
                 json.dumps(version) if version else None, int(conflict)))


def planning_payload(transfer: WorkTransfer, version: dict):
    rid, kind = version.get("resource_id"), version.get("kind")
    if not isinstance(rid, str) or not ID32.fullmatch(rid) or kind not in KINDS or type(version.get("version")) is not int or version["version"] < 1:
        raise CloudTransferError("planning_invalid", "云日程版本无效。")
    if version.get("deleted") is True:
        if version.get("manifest_id") is not None or version.get("object_ids"):
            raise CloudTransferError("planning_invalid", "云日程删除记录无效。")
        return None
    oid = version.get("manifest_id")
    if (version.get("deleted") is not False or not isinstance(oid, str) or not HEX64.fullmatch(oid)
            or version.get("object_ids") != [oid]):
        raise CloudTransferError("planning_invalid", "云日程文件引用无效。")
    try:
        raw = transfer._get(oid, "bundle")
        if len(raw) > 160 * 1024:
            raise ValueError("Large item")
        envelope = json.loads(raw)
        if (set(envelope) != {"format", "vault_id", "resource_id", "kind", "data"}
                or envelope["format"] != "mona-planning-v1" or envelope["vault_id"] != transfer.cipher.vault_id
                or envelope["resource_id"] != rid or envelope["kind"] != kind):
            raise ValueError("Foreign item")
        return normalize_item(kind, envelope["data"], incoming=True)
    except (ValueError, KeyError, TypeError):
        raise CloudTransferError("planning_invalid", "云日程内容校验失败，未覆盖本地数据。") from None


def push_planning(transfer, resource, kind, data, base_version):
    data = normalize_item(kind, data, incoming=True) if data is not None else None
    oid = None
    if data is not None:
        envelope = {"format": "mona-planning-v1", "vault_id": transfer.cipher.vault_id,
                    "resource_id": resource, "kind": kind, "data": data}
        oid = transfer._put(encoded(envelope), "bundle")
    body = {"resource_id": resource, "kind": kind, "base_version": base_version,
            "manifest_id": oid, "object_ids": [oid] if oid else [], "deleted": data is None}
    body["operation_id"] = hashlib.sha256(encoded(body)).hexdigest()
    transfer._check_cancel()
    version = transfer.transport.control("POST", "/resources/commit", body)
    if (not isinstance(version, dict) or version.get("resource_id") != resource or version.get("kind") != kind
            or type(version.get("version")) is not int or version["version"] != base_version + 1
            or version.get("manifest_id") != oid or version.get("object_ids") != ([oid] if oid else [])
            or version.get("deleted") is not (data is None)):
        raise CloudTransferError("planning_unconfirmed", "云日程提交尚未确认，请稍后核对。")
    return version


class PlanningSync:
    def __init__(self, store, client, transfer, guard):
        self.state, self.client, self.transfer, self.guard = PlanningState(store), client, transfer, guard
        self.vault = transfer.cipher.vault_id
        self.cache = {}
        self.conflicts = 0
        self.modified = False

    async def local(self, kind, refresh=False):
        if refresh or kind not in self.cache:
            self.cache[kind] = await self.client.list(kind)
        return self.cache[kind]

    async def receive(self, version):
        kind, resource = version["kind"], version["resource_id"]
        mapping = next((row for row in self.state.rows(self.vault) if row["resource"] == resource), None)
        if mapping and mapping["version"] and mapping["version"]["version"] >= version["version"]:
            return
        if mapping and mapping["kind"] != kind:
            raise CloudTransferError("planning_invalid", "云日程类型发生变化。")
        remote = await asyncio.to_thread(planning_payload, self.transfer, version)
        local_id = mapping["local_id"] if mapping else f"cloud-{self.vault[:12]}-{resource}"
        rows = await self.local(kind)
        local = rows.get(local_id)
        base = mapping["base"] if mapping else None
        await self.guard()
        if mapping is None and local is not None and local != remote:
            raise CloudTransferError("planning_conflict", "本机已有同名日程记录，未覆盖。")
        if local == base and local != remote:
            await self.client.apply(kind, local_id, local, remote)
            self.modified = True
            if remote is None:
                rows.pop(local_id, None)
            else:
                rows[local_id] = remote
        elif local != remote and remote != base:
            # Concurrent changes preserve the local original and a deterministic
            # remote copy. A repeated response cannot create duplicate copies.
            self.conflicts += 1
            if remote is not None:
                clone_resource = hashlib.sha256(f"planning-conflict:{self.vault}:{resource}:{version['version']}".encode()).hexdigest()[:32]
                clone_id = f"cloud-{self.vault[:12]}-{clone_resource}"
                clone = copy.deepcopy(remote)
                clone["title"] = clone["title"][:985] + " · 同步冲突"
                if kind == "todo":
                    clone["focusRank"] = None
                else:
                    clone["enabled"] = False  # A conflict copy is not a second active reminder.
                if clone_id not in rows:
                    await self.client.apply(kind, clone_id, None, clone)
                    self.modified = True
                    rows[clone_id] = clone
                if not any(row["resource"] == clone_resource for row in self.state.rows(self.vault)):
                    self.state.put(self.vault, clone_resource, kind, clone_id, None, None, True)
        await self.guard()
        self.state.put(self.vault, resource, kind, local_id, remote, version, self.conflicts > 0)

    async def send(self):
        sent = 0
        for kind in KINDS:
            rows = await self.local(kind, refresh=True)
            mappings = self.state.rows(self.vault)
            by_local = {row["local_id"]: row for row in mappings if row["kind"] == kind}
            owners = self.state.owners()
            for item_id in sorted(set(rows) | set(by_local)):
                if owners.get((kind, item_id)) not in (None, self.vault):
                    continue
                mapping = by_local.get(item_id)
                data = rows.get(item_id)
                if mapping and mapping["version"] and data == mapping["base"]:
                    continue
                if data is None and (mapping is None or mapping["version"] is None):
                    continue
                await self.guard()
                resource = mapping["resource"] if mapping else hashlib.sha256(f"planning:{self.vault}:{kind}:{item_id}".encode()).hexdigest()[:32]
                if mapping is None:
                    self.state.put(self.vault, resource, kind, item_id, None, None)
                version = await asyncio.to_thread(push_planning, self.transfer, resource, kind, data,
                    mapping["version"]["version"] if mapping and mapping["version"] else 0)
                await self.guard()
                self.state.put(self.vault, resource, kind, item_id, data, version)
                sent += 1
                if sent >= 30:
                    return False  # Bound each pass; the ordinary sync timer continues.
        return True
