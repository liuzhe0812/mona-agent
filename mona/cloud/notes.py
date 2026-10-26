"""Per-note encrypted sync; native Notes owns all local reads, assets and writes."""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json

from mona.cloud.transfer import CloudTransferError
from mona.cloud.work_files import HEX64, ID32
from mona.schedule.sync import encoded, fingerprint

CHUNK = 256 * 1024
FILE_CHUNK = 4 * 1024 * 1024
EMPTY = fingerprint(None)


def fail(message="笔记同步数据无效，原有笔记已保留。"):
    raise CloudTransferError("notes_invalid", message)


def note_data(value):
    fields = {"notebook", "title", "content", "created_at", "updated_at", "note_type", "aliases", "favorite", "assets"}
    if not isinstance(value, dict) or set(value) != fields:
        fail()
    for field, limit in (("notebook", 240), ("title", 4096), ("content", 2 * 1024 * 1024),
                         ("created_at", 64), ("updated_at", 64), ("note_type", 32)):
        if not isinstance(value[field], str) or len(value[field].encode()) > limit:
            fail()
    if type(value["favorite"]) is not bool or value["note_type"] not in {
            "note", "moc", "daily", "template", "agent-experience", "flowchart", "mindmap", "diagram"}:
        fail()
    if (not isinstance(value["aliases"], list) or len(value["aliases"]) > 100
            or any(not isinstance(v, str) or len(v.encode()) > 1024 for v in value["aliases"])
            or not isinstance(value["assets"], list) or len(value["assets"]) > 128):
        fail()
    names = set()
    for asset in value["assets"]:
        if (not isinstance(asset, dict) or set(asset) != {"name", "sha256", "size"}
                or not isinstance(asset["name"], str) or asset["name"] in names
                or not isinstance(asset["sha256"], str) or not HEX64.fullmatch(asset["sha256"])
                or type(asset["size"]) is not int or not 0 <= asset["size"] <= 10 * 1024 * 1024):
            fail()
        name = asset["name"]
        prefix = f"cloud-{asset['sha256']}."
        if not name.startswith(prefix) or not name[len(prefix):].isascii() or not name[len(prefix):].isalnum() or len(name[len(prefix):]) > 12:
            fail()
        names.add(name)
    if len(encoded(value)) > 6 * 1024 * 1024:
        fail("单篇笔记过大，未截断原文。")
    return value


class NotesClient:
    def __init__(self, invoke, binding: str, vault: str = "", *, initialize: bool = False):
        self.invoke, self.binding, self.vault = invoke, binding, vault
        self.initialize = initialize

    async def request(self, action, **args):
        try:
            result = await asyncio.to_thread(self.invoke, "cloud_notes", {
                "binding": self.binding, "vault": self.vault, "action": action, **args}, timeout=65)
        except CloudTransferError:
            raise
        except Exception:
            raise CloudTransferError("notes_unavailable",
                "笔记同步未完成，请确认本机笔记仓库可用；本地内容已保留。") from None
        if not isinstance(result, dict):
            fail()
        return result

    async def index(self):
        value = await self.request("index", **({"initialize": True} if self.initialize else {}))
        vault, rows = value.get("vault"), value.get("items")
        if (not isinstance(vault, str) or not HEX64.fullmatch(vault)
                or not isinstance(rows, list) or len(rows) > 10_000):
            fail()
        if self.vault and self.vault != vault:
            raise CloudTransferError("notes_vault_changed", "本机笔记仓库已更换，请在同步范围中重新确认。")
        self.vault = vault
        index = {}
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                    or len(row["id"].encode()) > 512 or row["id"] in index
                    or not isinstance(row.get("fingerprint"), str) or not HEX64.fullmatch(row["fingerprint"])):
                fail()
            index[row["id"]] = row["fingerprint"]
        return index

    async def read(self, note_id, expected):
        response = await self.request("read", note_id=note_id, expected=expected)
        data = note_data(response.get("data"))
        if response.get("fingerprint") != expected or fingerprint(data) != expected:
            fail("笔记读取期间发生变化，请重试同步。")
        return data

    async def apply(self, note_id, expected, data):
        response = await self.request("apply", note_id=note_id, expected=expected, data=data)
        if response.get("applied") is not True:
            fail("笔记保存结果尚未确认，请稍后核对。")

    async def asset(self, note_id, expected, asset):
        offset, digest, buffered = 0, hashlib.sha256(), bytearray()
        while True:
            response = await self.request("asset_read", note_id=note_id, expected=expected,
                                          name=asset["name"], offset=offset)
            try:
                raw = response.get("data")
                if not isinstance(raw, str) or len(raw) > CHUNK * 4 // 3 + 8:
                    fail()
                chunk = base64.b64decode(raw, validate=True)
            except (ValueError, TypeError):
                fail()
            if (len(chunk) > CHUNK or offset + len(chunk) > asset["size"]
                    or response.get("next") != offset + len(chunk)
                    or response.get("complete") is not (offset + len(chunk) == asset["size"])
                    or not chunk and offset != asset["size"]):
                fail("笔记附件读取不完整，未发布云版本。")
            digest.update(chunk)
            buffered.extend(chunk)
            offset += len(chunk)
            if len(buffered) >= FILE_CHUNK or response["complete"]:
                yield bytes(buffered)
                buffered.clear()
            if response["complete"]:
                break
        if digest.hexdigest() != asset["sha256"]:
            fail("笔记附件内容已变化，请重试同步。")


class NotesSync:
    def __init__(self, store, client, transfer, guard):
        self.store, self.client, self.transfer, self.guard = store, client, transfer, guard
        self.vault, self.local_vault = transfer.cipher.vault_id, client.vault
        self.modified = False
        with store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS notes_sync_positions (
                local_vault TEXT NOT NULL, vault TEXT NOT NULL, resource TEXT NOT NULL,
                local_id TEXT NOT NULL, base TEXT NOT NULL, version TEXT,
                PRIMARY KEY(local_vault,vault,resource), UNIQUE(local_vault,local_id))""")

    def mappings(self):
        with self.store.connection() as db:
            rows = db.execute("SELECT * FROM notes_sync_positions WHERE local_vault=? AND vault=?",
                              (self.local_vault, self.vault)).fetchall()
        return [{**dict(row), "version": json.loads(row["version"]) if row["version"] else None} for row in rows]

    def put(self, resource, local_id, base, version):
        with self.store.connection() as db:
            db.execute("""INSERT INTO notes_sync_positions VALUES(?,?,?,?,?,?)
                ON CONFLICT(local_vault,vault,resource) DO UPDATE SET base=excluded.base,version=excluded.version""",
                (self.local_vault, self.vault, resource, local_id, base, json.dumps(version) if version else None))

    async def push(self, resource, note_id, expected, base_version):
        data, object_ids, files = None, set(), []
        if expected != EMPTY:
            data = await self.client.read(note_id, expected)
            for asset in data["assets"]:
                chunks = []
                async for raw in self.client.asset(note_id, expected, asset):
                    await self.guard()
                    oid = await asyncio.to_thread(self.transfer._put, raw, "file")
                    object_ids.add(oid)
                    chunks.append(oid)
                files.append({"name": asset["name"], "chunks": chunks})
            # A note change while uploading must not be acknowledged as the old snapshot.
            await self.client.read(note_id, expected)
        manifest = None
        if data is not None:
            bundle = {"format": "mona-note-v1", "vault_id": self.vault, "resource_id": resource,
                      "data": data, "files": files}
            manifest = await asyncio.to_thread(self.transfer._put, encoded(bundle), "bundle")
            object_ids.add(manifest)
        payload = {"resource_id": resource, "kind": "note", "base_version": base_version,
            "manifest_id": manifest, "object_ids": sorted(object_ids), "deleted": data is None}
        payload["operation_id"] = hashlib.sha256(encoded(payload)).hexdigest()
        await self.guard()
        version = await asyncio.to_thread(self.transfer.transport.control, "POST", "/resources/commit", payload)
        if (not isinstance(version, dict) or version.get("resource_id") != resource or version.get("kind") != "note"
                or type(version.get("version")) is not int
                or version.get("version") != base_version + 1 or version.get("manifest_id") != manifest
                or version.get("object_ids") != payload["object_ids"] or version.get("deleted") is not (data is None)):
            fail("笔记云版本尚未确认。")
        return version

    async def pull(self, version):
        resource = version.get("resource_id")
        if (version.get("kind") != "note" or not isinstance(resource, str) or not ID32.fullmatch(resource)
                or type(version.get("version")) is not int or version["version"] < 1):
            fail()
        if version.get("deleted") is True:
            if version.get("manifest_id") is not None or version.get("object_ids"):
                fail()
            return None, []
        oid = version.get("manifest_id")
        if version.get("deleted") is not False or not isinstance(oid, str) or not HEX64.fullmatch(oid):
            fail()
        raw = await asyncio.to_thread(self.transfer._get, oid, "bundle")
        try:
            bundle = json.loads(raw)
            if (set(bundle) != {"format", "vault_id", "resource_id", "data", "files"}
                    or bundle["format"] != "mona-note-v1" or bundle["vault_id"] != self.vault
                    or bundle["resource_id"] != resource):
                fail()
            data, files = note_data(bundle["data"]), bundle["files"]
            if not isinstance(files, list) or len(files) != len(data["assets"]):
                fail()
            objects = {oid}
            for file, asset in zip(files, data["assets"]):
                chunks = file["chunks"]
                if (set(file) != {"name", "chunks"} or file["name"] != asset["name"]
                        or not isinstance(chunks, list) or not 1 <= len(chunks) <= 3
                        or any(not isinstance(c, str) or not HEX64.fullmatch(c) for c in chunks)):
                    fail()
                objects.update(chunks)
            if sorted(objects) != sorted(version.get("object_ids", [])):
                fail()
            return data, files
        except (ValueError, TypeError, KeyError):
            fail()

    async def install_assets(self, data, files):
        for asset, file in zip(data["assets"], files):
            digest, offset = hashlib.sha256(), 0
            for oid in file["chunks"]:
                raw = await asyncio.to_thread(self.transfer._get, oid, "file")
                if len(raw) > FILE_CHUNK or offset + len(raw) > asset["size"]:
                    fail()
                digest.update(raw)
                for start in range(0, max(1, len(raw)), CHUNK):
                    piece = raw[start:start + CHUNK]
                    await self.guard()
                    result = await self.client.request("asset_write", **asset, offset=offset,
                        data=base64.b64encode(piece).decode())
                    offset += len(piece)
                    if (type(result.get("received")) is not int or not offset <= result["received"] <= asset["size"]
                            or result.get("complete") is not (result["received"] == asset["size"])):
                        fail("笔记附件保存尚未确认。")
            if offset != asset["size"] or digest.hexdigest() != asset["sha256"]:
                fail("笔记附件校验失败，未替换原笔记。")

    async def receive(self, version):
        resource = version.get("resource_id")
        if (not isinstance(resource, str) or not ID32.fullmatch(resource)
                or type(version.get("version")) is not int or version["version"] < 1):
            fail()
        mapping = next((row for row in self.mappings() if row["resource"] == resource), None)
        if mapping and mapping["version"] and mapping["version"]["version"] >= version.get("version", 0):
            return
        remote, files = await self.pull(version)
        remote_digest = fingerprint(remote)
        local_id = mapping["local_id"] if mapping else f"cloud-{self.vault[:12]}-{resource}"
        index = await self.client.index()
        local, base = index.get(local_id, EMPTY), mapping["base"] if mapping else EMPTY
        if local == base and local != remote_digest:
            if remote is not None:
                await self.install_assets(remote, files)
            await self.guard()
            await self.client.apply(local_id, local, remote)
            self.modified = True
        elif local != remote_digest and remote_digest != base and remote is not None:
            # Keep the local original and one deterministic remote conflict copy.
            clone_resource = hashlib.sha256(f"notes-conflict:{self.vault}:{resource}:{version['version']}".encode()).hexdigest()[:32]
            clone_id = f"cloud-{self.vault[:12]}-{clone_resource}"
            if clone_id not in index:
                clone = copy.deepcopy(remote)
                clone["title"] = clone["title"][:1000] + " · 同步冲突"
                await self.install_assets(clone, files)
                await self.guard()
                await self.client.apply(clone_id, EMPTY, clone)
                self.modified = True
            if not any(row["resource"] == clone_resource for row in self.mappings()):
                self.put(clone_resource, clone_id, EMPTY, None)
        await self.guard()
        self.put(resource, local_id, remote_digest, version)

    async def send(self):
        rows = await self.client.index()
        mappings = {row["local_id"]: row for row in self.mappings()}
        with self.store.connection() as db:
            owners = dict(db.execute("SELECT local_id,vault FROM notes_sync_positions WHERE local_vault=?", (self.local_vault,)))
        sent = 0
        for note_id in sorted(set(rows) | set(mappings)):
            if owners.get(note_id) not in (None, self.vault):
                continue
            mapping, digest = mappings.get(note_id), rows.get(note_id, EMPTY)
            if mapping and mapping["version"] and digest == mapping["base"]:
                continue
            if digest == EMPTY and not (mapping and mapping["version"]):
                continue
            resource = mapping["resource"] if mapping else hashlib.sha256(f"note:{self.vault}:{self.local_vault}:{note_id}".encode()).hexdigest()[:32]
            if mapping is None:
                self.put(resource, note_id, EMPTY, None)
            version = await self.push(resource, note_id, digest, mapping["version"]["version"] if mapping and mapping["version"] else 0)
            await self.guard()
            self.put(resource, note_id, digest, version)
            sent += 1
            if sent >= 20:
                return False
        return True
