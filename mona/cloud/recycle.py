"""Cloud recycle UI adapter. No destructive local file or task operations."""
from __future__ import annotations

import asyncio
import copy
import json
import time
import uuid

from mona.cloud.crypto import VaultCipher
from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.cloud.work_files import HEX64, ID32

KINDS = {"work_conversation": "工作会话", "note": "笔记", "todo": "待办", "calendar_event": "日程"}
ACTIONS = ("trash", "restore", "purge")
MAX_CURSOR = 9_007_199_254_740_991


def invalid(message="回收站记录无效，未修改任何内容。"):
    raise CloudTransferError("trash_invalid", message)


class CloudRecycle:
    def __init__(self, owner):
        self.owner, self.draft = owner, None
        with owner.store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS work_cloud_trash (
                vault TEXT NOT NULL, resource TEXT NOT NULL, version INTEGER NOT NULL,
                PRIMARY KEY(vault,resource))""")

    def deleted_version(self, vault, resource):
        with self.owner.store.connection() as db:
            row = db.execute("SELECT version FROM work_cloud_trash WHERE vault=? AND resource=?", (vault, resource)).fetchone()
        return row[0] if row else 0

    def remember(self, vault, version):
        if (version.get("kind") != "work_conversation" or version.get("deleted") is not True
                or not isinstance(version.get("resource_id"), str) or not ID32.fullmatch(version["resource_id"])
                or type(version.get("version")) is not int or not 1 <= version["version"] <= 2_000_000_000
                or version.get("manifest_id") is not None or version.get("object_ids") != []):
            invalid()
        with self.owner.store.connection() as db:
            db.execute("""INSERT INTO work_cloud_trash VALUES(?,?,?)
                ON CONFLICT(vault,resource) DO UPDATE SET version=MAX(version,excluded.version)""",
                (vault, version["resource_id"], version["version"]))

    def forget(self, vault, resource, version):
        with self.owner.store.connection() as db:
            db.execute("DELETE FROM work_cloud_trash WHERE vault=? AND resource=? AND version<?", (vault, resource, version))

    async def context(self):
        context = await self.owner._context()
        self.owner._cloud_ready(context)
        space = context.get("space")
        if not isinstance(space, dict) or not isinstance(space.get("vault_id"), str) or not ID32.fullmatch(space["vault_id"]):
            raise CloudTransferError("cloud_space_missing", "当前账号尚未创建云空间。")
        return context

    async def check(self, context):
        current = await self.context()
        if current["binding"] != context["binding"] or current["space"]["vault_id"] != context["space"]["vault_id"]:
            self.draft = None
            raise CloudTransferError("account_changed", "账号已变化，请重新打开回收站。")

    @staticmethod
    def title(transfer, version):
        kind, resource = version["kind"], version["resource_id"]
        oid = version.get("manifest_id")
        if not isinstance(oid, str) or not HEX64.fullmatch(oid) or oid not in version.get("object_ids", []):
            invalid()
        try:
            bundle = json.loads(transfer._get(oid, "bundle"))
            if not isinstance(bundle, dict) or bundle.get("vault_id") != transfer.cipher.vault_id or bundle.get("resource_id") != resource:
                invalid()
            if kind == "work_conversation":
                transfer._validate_bundle(bundle, version)
                title = bundle["snapshot"]["metadata"].get("title") or KINDS[kind]
            else:
                expected = "mona-note-v1" if kind == "note" else "mona-planning-v1"
                if bundle.get("format") != expected or kind != "note" and bundle.get("kind") != kind:
                    invalid()
                title = bundle["data"]["title"]
            if not isinstance(title, str) or not title or len(title.encode()) > 4096:
                invalid()
            return title
        except (ValueError, TypeError, KeyError):
            invalid("无法核对回收站名称，请刷新后重试。")

    async def list(self, before=MAX_CURSOR):
        if type(before) is not int or not 1 <= before <= MAX_CURSOR:
            invalid()
        async with self.owner.lock:
            context = await self.context()
            transport = self.owner._transport(context)
            data = await asyncio.to_thread(transport.control, "GET", f"/trash?before={before}")
            if (not isinstance(data, dict) or not isinstance(data.get("items"), list) or len(data["items"]) > 10
                    or type(data.get("has_more")) is not bool or type(data.get("next_before")) is not int):
                invalid()
            transfer = None
            if context.get("recovery"):
                cipher = VaultCipher.from_recovery(context["recovery"])
                if cipher.vault_id != context["space"]["vault_id"] or not cipher.matches_key_check(context["space"].get("key_check")):
                    raise CloudTransferError("recovery_required", "请在同步设置中核对当前云空间恢复密钥。")
                transfer = WorkTransfer(cipher, transport)
            items, previous, seen = [], before, set()
            for row in data["items"]:
                if (not isinstance(row, dict) or not isinstance(row.get("resource_id"), str)
                        or not ID32.fullmatch(row["resource_id"]) or row["resource_id"] in seen
                        or not isinstance(row.get("kind"), str) or row["kind"] not in KINDS
                        or type(row.get("version")) is not int or not 1 <= row["version"] <= 2_000_000_000
                        or type(row.get("sequence")) is not int or not 0 < row["sequence"] < previous
                        or not isinstance(row.get("deleted_at"), str)):
                    invalid()
                from datetime import datetime
                datetime.fromisoformat(row["deleted_at"])
                previous = row["sequence"]
                seen.add(row["resource_id"])
                content = row.get("content")
                title = KINDS[row["kind"]] + "（名称未解锁）"
                if content is not None:
                    if (not isinstance(content, dict) or content.get("kind") != row["kind"]
                            or content.get("resource_id") != row["resource_id"] or content.get("deleted") is not False
                            or type(content.get("version")) is not int or not 0 < content["version"] < row["version"]):
                        invalid()
                    if transfer is not None:
                        try:
                            title = await asyncio.to_thread(self.title, transfer, content)
                        except CloudTransferError as error:
                            if error.code != "cloud_download_expired":
                                raise
                            title = KINDS[row["kind"]] + "（下载期已结束）"
                else:
                    title = KINDS[row["kind"]] + "（无可恢复内容）"
                items.append({key: row[key] for key in ("resource_id", "kind", "version", "deleted_at")}
                             | {"title": title, "recoverable": content is not None})
            if (data["next_before"] != previous or data["has_more"] and len(items) != 10):
                invalid()
            await self.check(context)
            return {"items": items, "next_before": previous, "has_more": data["has_more"]}

    async def preview(self, resource_id, version, action):
        if (not isinstance(resource_id, str) or not ID32.fullmatch(resource_id)
                or type(version) is not int or not 1 <= version <= 2_000_000_000 or action not in ACTIONS):
            invalid()
        async with self.owner.lock:
            self.draft = None
            context = await self.context()
            body = {"resource_id": resource_id, "version": version, "action": action}
            data = await asyncio.to_thread(self.owner._transport(context).control, "POST", "/trash/preview", body)
            await self.check(context)
            if (not isinstance(data, dict) or any(data.get(k) != v for k, v in body.items())
                    or not isinstance(data.get("kind"), str) or data["kind"] not in KINDS
                    or not isinstance(data.get("receipt"), str) or not 20 <= len(data["receipt"]) <= 8192
                    or type(data.get("expires_at")) is not int or not time.time() < data["expires_at"] <= time.time() + 610):
                invalid()
            public = {**body, "kind": data["kind"], "draft_id": uuid.uuid4().hex, "expires_at": data["expires_at"]}
            self.draft = {"public": public, "context": context, "receipt": data["receipt"],
                          "expires": time.monotonic() + min(600, data["expires_at"] - time.time()), "result": None}
            return public

    async def apply(self, draft_id, confirmed):
        if confirmed is not True:
            raise CloudTransferError("trash_confirmation_required", "请确认本次回收站操作。")
        async with self.owner.lock:
            draft = self.draft
            if not draft or draft["public"]["draft_id"] != draft_id or draft["expires"] <= time.monotonic():
                raise CloudTransferError("trash_preview_expired", "回收站操作确认已失效，请重新检查。")
            await self.check(draft["context"])
            if draft["result"] is not None:
                return copy.deepcopy(draft["result"])
            data = await asyncio.to_thread(self.owner.transport_factory(draft["context"]["binding"]).control,
                "POST", "/trash/apply", {"receipt": draft["receipt"], "confirmed": True})
            await self.check(draft["context"])
            public = draft["public"]
            expected_version = public["version"] + (public["action"] != "purge")
            if (not isinstance(data, dict) or data.get("complete") is not True or type(data.get("reused")) is not bool
                    or any(data.get(k) != public[k] for k in ("action", "resource_id", "kind"))
                    or type(data.get("version")) is not int or data["version"] != expected_version
                    or type(data.get("released_bytes")) is not int or data["released_bytes"] != 0):
                invalid("回收站操作结果尚未确认，请重试核对。")
            head = data.get("head")
            if (not isinstance(head, dict) or head.get("resource_id") != public["resource_id"]
                    or head.get("kind") != public["kind"] or head.get("version") != expected_version
                    or head.get("deleted") is not (public["action"] != "restore")):
                invalid()
            if public["kind"] == "work_conversation" and public["action"] != "restore":
                self.remember(draft["context"]["space"]["vault_id"], head)
            result = {key: data[key] for key in ("complete", "action", "resource_id", "kind", "version", "reused", "released_bytes")}
            draft["result"] = copy.deepcopy(result)
            self.owner.wake.set()
            return result
