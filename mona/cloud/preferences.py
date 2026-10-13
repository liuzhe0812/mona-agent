"""Explicit desktop preferences only; never copy configuration files or credentials."""
from __future__ import annotations

import asyncio
import hashlib
import json

from mona.cloud.transfer import CloudTransferError
from mona.cloud.work_files import HEX64
from mona.schedule.sync import encoded, fingerprint

FIELDS = frozenset({"send_message_shortcut", "default_view", "quick_ask_mode", "sidebar_modules"})
MODULES = frozenset({"chat", "development", "note", "doc", "email", "schedule", "ssh", "db", "system", "profile", "stock", "settings"})


def validate_preferences(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise CloudTransferError("preferences_invalid", "同步内容包含未允许的设置，未修改本机偏好。")
    if (value["send_message_shortcut"] not in ("enter", "ctrl_enter")
            or value["quick_ask_mode"] not in ("compact", "full")
            or not isinstance(value["default_view"], str) or value["default_view"] not in MODULES
            or not isinstance(value["sidebar_modules"], list) or len(value["sidebar_modules"]) > len(MODULES)):
        raise CloudTransferError("preferences_invalid", "使用偏好格式无效，已保留本机设置。")
    seen = set()
    for module in value["sidebar_modules"]:
        if (not isinstance(module, dict) or set(module) != {"key", "visible", "order"}
                or not isinstance(module["key"], str) or module["key"] not in MODULES or module["key"] in seen
                or type(module["visible"]) is not bool or type(module["order"]) is not int or not 0 <= module["order"] <= 64):
            raise CloudTransferError("preferences_invalid", "侧栏偏好格式无效，已保留本机设置。")
        seen.add(module["key"])
    return value


class PreferencesClient:
    def __init__(self, invoke, binding):
        self.invoke, self.binding = invoke, binding

    async def request(self, action, **kwargs):
        try:
            result = await asyncio.to_thread(self.invoke, "cloud_preferences", {
                "binding": self.binding, "action": action, **kwargs}, timeout=65)
        except CloudTransferError:
            raise
        except Exception:
            raise CloudTransferError("preferences_unavailable", "使用偏好同步尚未完成，本机设置已保留，请稍后重试。") from None
        if not isinstance(result, dict):
            raise CloudTransferError("preferences_invalid", "使用偏好返回异常。")
        return result

    async def read(self):
        reply = await self.request("read")
        data = validate_preferences(reply.get("data"))
        if reply.get("fingerprint") != fingerprint(data):
            raise CloudTransferError("preferences_invalid", "使用偏好版本校验失败。")
        return data

    async def apply(self, before, desired):
        validate_preferences(desired)
        result = await self.request("apply", expected=fingerprint(before), data=desired)
        if result.get("applied") is not True or result.get("data") != desired or result.get("fingerprint") != fingerprint(desired):
            raise CloudTransferError("preferences_unconfirmed", "使用偏好保存尚未确认，请稍后核对。")


class PreferencesSync:
    def __init__(self, store, client, transfer, guard):
        self.store, self.client, self.transfer, self.guard = store, client, transfer, guard
        self.vault = transfer.cipher.vault_id
        self.resource = hashlib.sha256(f"desktop-preferences-v1:{self.vault}".encode()).hexdigest()[:32]
        with store.connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS preferences_sync_positions (
                vault TEXT PRIMARY KEY, base TEXT, version TEXT)""")

    def position(self):
        with self.store.connection() as db:
            row = db.execute("SELECT base,version FROM preferences_sync_positions WHERE vault=?", (self.vault,)).fetchone()
        return {"base": json.loads(row["base"]), "version": json.loads(row["version"])} if row else None

    def put(self, base, version):
        with self.store.connection() as db:
            db.execute("""INSERT INTO preferences_sync_positions VALUES(?,?,?)
                ON CONFLICT(vault) DO UPDATE SET base=excluded.base,version=excluded.version""",
                (self.vault, json.dumps(base, ensure_ascii=False), json.dumps(version)))

    async def receive(self, version):
        if (version.get("resource_id") != self.resource or version.get("kind") != "preferences"
                or type(version.get("version")) is not int or version["version"] < 1):
            raise CloudTransferError("preferences_invalid", "使用偏好不属于当前云空间。")
        position = self.position()
        if position and position["version"] and position["version"]["version"] >= version["version"]:
            return
        if version.get("deleted") is True:
            if version.get("manifest_id") is not None or version.get("object_ids"):
                raise CloudTransferError("preferences_invalid", "使用偏好删除记录无效。")
            await self.guard()
            self.put(await self.client.read(), version)
            return  # Removing a cloud copy never resets a device's own preferences.
        oid = version.get("manifest_id")
        if (version.get("deleted") is not False or not isinstance(oid, str)
                or not HEX64.fullmatch(oid) or version.get("object_ids") != [oid]):
            raise CloudTransferError("preferences_invalid", "使用偏好云文件无效。")
        raw = await asyncio.to_thread(self.transfer._get, oid, "bundle")
        try:
            if len(raw) > 16 * 1024:
                raise ValueError("Large preferences")
            body = json.loads(raw)
            if (not isinstance(body, dict) or set(body) != {"format", "vault_id", "resource_id", "data"}
                    or body["format"] != "mona-preferences-v1" or body["vault_id"] != self.vault
                    or body["resource_id"] != self.resource):
                raise ValueError("Foreign preferences")
            remote = validate_preferences(body["data"])
        except (ValueError, TypeError, KeyError):
            raise CloudTransferError("preferences_invalid", "使用偏好内容校验失败，未修改本机设置。") from None
        await self.guard()
        local = await self.client.read()
        if position is None:
            desired = remote  # First opt-in joins the account's existing preferences.
        elif position["base"] is None:
            desired = local  # Preserve an initial local write whose outcome was unknown.
        else:
            desired = {field: remote[field] if local[field] == position["base"][field] else local[field] for field in FIELDS}
        if desired != local:
            await self.client.apply(local, desired)
        await self.guard()
        self.put(remote, version)

    async def send(self):
        local = await self.client.read()
        position = self.position()
        if position and position["base"] == local:
            return True
        await self.guard()
        if position is None:
            self.put(None, None)
        body = {"format": "mona-preferences-v1", "vault_id": self.vault, "resource_id": self.resource, "data": local}
        oid = await asyncio.to_thread(self.transfer._put, encoded(body), "bundle")
        base = position["version"]["version"] if position and position["version"] else 0
        commit = {"resource_id": self.resource, "kind": "preferences", "base_version": base,
            "manifest_id": oid, "object_ids": [oid], "deleted": False}
        commit["operation_id"] = hashlib.sha256(encoded(commit)).hexdigest()
        await self.guard()
        version = await asyncio.to_thread(self.transfer.transport.control, "POST", "/resources/commit", commit)
        if (not isinstance(version, dict) or version.get("resource_id") != self.resource or version.get("kind") != "preferences"
                or version.get("version") != base + 1 or type(version.get("version")) is not int
                or version.get("manifest_id") != oid or version.get("object_ids") != [oid] or version.get("deleted") is not False):
            raise CloudTransferError("preferences_unconfirmed", "使用偏好云版本尚未确认。")
        await self.guard()
        self.put(local, version)
        return True
