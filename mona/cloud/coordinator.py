"""Opt-in Work synchronization owned by the Gateway, never an Agent task."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
import uuid
from pathlib import Path
from threading import Event
from typing import Callable

from loguru import logger

from mona.agent.tools.tauri_ipc import tauri_invoke
from mona.cloud.crypto import CloudCryptoError, VaultCipher
from mona.cloud.local_state import LocalCloudStore
from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.cloud.transport import BridgeCloudTransport
from mona.cloud.work_files import ID32, restored_file_path
from mona.cloud.work_snapshot import (
    WorkExport,
    canonical_bytes,
    export_work_snapshot,
    is_work_session,
    prepare_work_restore,
    read_work_metadata,
    work_content_fingerprint,
)
from mona.config.loader import _atomic_write_json, _config_write_lock
from mona.config.schema import CloudSyncConfig


class SyncPreferences:
    def __init__(self, config_path: Path):
        self.path = config_path

    def read(self) -> CloudSyncConfig:
        if not self.path.exists():
            return CloudSyncConfig()
        with _config_write_lock(self.path):
            data = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise CloudTransferError("config_invalid", "同步设置无法读取，未覆盖现有配置。")
        return CloudSyncConfig.model_validate(data.get("cloudSync", data.get("cloud_sync", {})))

    def write(self, config: CloudSyncConfig) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with _config_write_lock(self.path):
            data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
            if not isinstance(data, dict):
                raise CloudTransferError("config_invalid", "设置文件无效，未覆盖现有配置。")
            data.pop("cloud_sync", None)
            data["cloudSync"] = config.model_dump(by_alias=True, mode="json")
            _atomic_write_json(self.path, data)


class CloudCoordinator:
    def __init__(self, agent_loop, *, config_path: Path, state_path: Path,
                 media_root: Path, transcript_for: Callable[[str], Path],
                 invoke=tauri_invoke, transport_factory=BridgeCloudTransport, planning_client=None, notes_client=None, preferences_client=None):
        self.loop, self.manager = agent_loop, agent_loop.sessions
        self.media_root, self.transcript_for = media_root, transcript_for
        self.preferences = SyncPreferences(config_path)
        self.store = LocalCloudStore(state_path)
        self.invoke, self.transport_factory = invoke, transport_factory
        self.planning_client = planning_client
        self.notes_client = notes_client
        self.preferences_client = preferences_client
        self._updated_work_keys: set[str] = set()
        self.cancelled = Event()
        self.wake = asyncio.Event()
        self.lock = asyncio.Lock()
        self.start_lock = asyncio.Lock()
        self.task = None
        self.closed = False
        self.phase, self.problem, self.last_sync = "idle", None, None
        self.transferred_bytes = 0
        self.draft = None
        self.cleanup_draft = None

    async def _context(self) -> dict:
        context = await asyncio.to_thread(self.invoke, "cloud_sync_context", timeout=65)
        if (not isinstance(context, dict) or not isinstance(context.get("binding"), str)
                or not isinstance(context.get("account_id"), str)):
            raise CloudTransferError("account_required", "请登录并联网核对账号后再同步。")
        return context

    @staticmethod
    def _cloud_ready(context: dict) -> None:
        if context.get("cloud_status") != 200:
            raise CloudTransferError("cloud_unavailable", "云同步服务尚未开放或配置完成。")

    async def _guard(self, binding: str) -> None:
        if self.cancelled.is_set():
            raise CloudTransferError("cancelled", "同步已暂停，本地内容保持不变。")
        current = await self._context()
        if self.cancelled.is_set():
            raise CloudTransferError("cancelled", "同步已暂停，本地内容保持不变。")
        if current["binding"] != binding:
            self.cancelled.set()
            raise CloudTransferError("account_changed", "账号已变化，同步已暂停。")

    def _candidates(self, vault: str) -> list[dict]:
        owners = self.store.owners()
        return [{"key": row["key"], "title": row.get("title") or "未命名会话"}
            for row in self.manager.list_sessions()
            if owners.get(row["key"]) in (None, vault) and read_work_metadata(self.manager, row["key"]) is not None]

    async def status(self) -> dict:
        config = await asyncio.to_thread(self.preferences.read)
        result = {"enabled": False, "phase": self.phase, "problem": self.problem,
                  "last_sync": self.last_sync, "transferred_bytes": self.transferred_bytes}
        try:
            context = await self._context()
            self._cloud_ready(context)
            space = context.get("space")
            same = config.account_id == context["account_id"]
            vault = space.get("vault_id", "") if isinstance(space, dict) else ""
            # Only public quota fields leave this service; keys and account
            # binding remain confined to the desktop/Python boundary.
            public_space = {k: space[k] for k in ("quota_bytes", "used_bytes", "reserved_bytes", "object_count") if k in space} if isinstance(space, dict) else None
            result.update(available=True, plan=context.get("plan"), space=public_space,
                enabled=same and config.enabled and config.vault_id == vault,
                needs_key=bool(space) and not context.get("recovery"),
                candidates=await asyncio.to_thread(self._candidates, vault),
                selected_keys=config.session_keys if same else [],
                sync_new_conversations=config.sync_new_conversations if same else False,
                sync_planning=config.sync_planning if same else False,
                sync_preferences=config.sync_preferences if same else False,
                sync_notes=config.sync_notes if same else False)
            rows = await asyncio.to_thread(self.store.mappings, vault) if vault else []
            result["conversations"] = [{"key": row["local_key"], "resource_id": row["resource"],
                "version": row["version"]["version"] if row["version"] and row["version"]["resource_id"] == row["resource"] else 0,
                "conflict_copy": bool(row["conflict_of"])} for row in rows]
        except Exception as exc:
            result.update(available=False, problem={"code": getattr(exc, "code", "service_unavailable"),
                "message": str(exc) if isinstance(exc, CloudTransferError) else "暂时无法读取云空间，请登录并联网后重试。"})
        return result

    async def cleanup_preview(self) -> dict:
        async with self.lock:
            self.cleanup_draft = None
            context = await self._context()
            self._cloud_ready(context)
            if not isinstance(context.get("space"), dict):
                raise CloudTransferError("cloud_space_missing", "当前账号尚未创建云空间。")
            transport = self.transport_factory(context["binding"])
            data = await asyncio.to_thread(transport.control, "GET", "/cleanup")
            current = await self._context()
            if current["binding"] != context["binding"]:
                raise CloudTransferError("account_changed", "账号已变化，请重新检查可释放空间。")
            if (not isinstance(data, dict) or type(data.get("count")) is not int or not 0 <= data["count"] <= 10
                    or type(data.get("bytes")) is not int or not 0 <= data["bytes"] <= data["count"] * 8 * 1024 * 1024
                    or type(data.get("expires_at")) is not int or data["expires_at"] <= time.time()
                    or type(data.get("has_more")) is not bool or data["has_more"] and data["count"] != 10
                    or type(data.get("minimum_age_seconds")) is not int or not 3600 <= data["minimum_age_seconds"] <= 604800
                    or data["count"] and (not isinstance(data.get("receipt"), str) or not 20 <= len(data["receipt"]) <= 16_000)):
                raise CloudTransferError("cleanup_invalid", "云空间检查结果无效，未清理任何内容。")
            public = {key: data[key] for key in ("count", "bytes", "expires_at", "has_more", "minimum_age_seconds")}
            public["draft_id"] = uuid.uuid4().hex if data["count"] else None
            if data["count"]:
                self.cleanup_draft = {"id": public["draft_id"], "binding": context["binding"],
                    "expires": time.monotonic() + min(600, data["expires_at"] - time.time()),
                    "receipt": data["receipt"], "public": public, "result": None}
            # React sees counts and a local confirmation id, not the signed
            # control-plane receipt or its internal object storage keys.
            return public

    async def cleanup_uploads(self, draft_id: str, confirmed: bool) -> dict:
        if not confirmed:
            raise CloudTransferError("cleanup_confirmation_required", "请先确认清理上传残留。")
        async with self.lock:
            draft = self.cleanup_draft
            if not draft or draft["id"] != draft_id or draft["expires"] <= time.monotonic():
                raise CloudTransferError("cleanup_preview_expired", "清理确认已失效，请重新检查。")
            context = await self._context()
            self._cloud_ready(context)
            if draft["binding"] != context["binding"]:
                self.cleanup_draft = None
                raise CloudTransferError("account_changed", "账号已变化，请重新检查可释放空间。")
            if draft["result"] is not None:
                return copy.deepcopy(draft["result"])
            result = await asyncio.to_thread(self.transport_factory(context["binding"]).control,
                "POST", "/cleanup", {"receipt": draft["receipt"], "confirmed": True})
            current = await self._context()
            if current["binding"] != context["binding"]:
                self.cleanup_draft = None
                raise CloudTransferError("account_changed", "账号已变化，请切回原账号核对清理结果。")
            counts = ("removed", "already_removed", "retained", "failed", "pending")
            if (not isinstance(result, dict) or type(result.get("complete")) is not bool
                    or any(type(result.get(key)) is not int or not 0 <= result[key] <= draft["public"]["count"] for key in counts)
                    or sum(result[key] for key in counts) != draft["public"]["count"]
                    or result["complete"] != (result["failed"] == 0 and result["pending"] == 0)
                    or type(result.get("released_bytes")) is not int or not 0 <= result["released_bytes"] <= draft["public"]["bytes"]
                    or result["removed"] == 0 and result["released_bytes"] != 0):
                raise CloudTransferError("cleanup_unconfirmed", "清理结果尚未确认，请重试核对，未重复扩大清理范围。")
            result = {key: result[key] for key in (*counts, "released_bytes", "complete")}
            if result["complete"]:
                draft["result"] = copy.deepcopy(result)
            return result

    async def prepare(self, recovery: str | None = None) -> dict:
        async with self.lock:
            context = await self._context()
            self._cloud_ready(context)
            space = context.get("space")
            if context.get("plan") != "pro" and not space:
                raise CloudTransferError("cloud_pro_required", "创建云空间需要 Pro，基础本地功能不受影响。")
            supplied = recovery or context.get("recovery")
            if space and not supplied:
                raise CloudTransferError("recovery_required", "请提供这个云空间原来的恢复密钥。")
            cipher = VaultCipher.from_recovery(supplied) if supplied else VaultCipher.generate()
            if space and (space.get("vault_id") != cipher.vault_id or not cipher.matches_key_check(space.get("key_check"))):
                raise CloudTransferError("recovery_required", "请提供这个云空间原来的恢复密钥。")
            self.draft = {"id": uuid.uuid4().hex, "expires": time.monotonic() + 600,
                "binding": context["binding"], "account_id": context["account_id"], "cipher": cipher,
                "candidates": await asyncio.to_thread(self._candidates, cipher.vault_id), "new": not bool(space)}
            return {"draft_id": self.draft["id"], "new_space": self.draft["new"],
                "recovery": cipher.recovery_text() if self.draft["new"] else None,
                "candidates": self.draft["candidates"]}

    async def enable(self, draft_id: str, keys: list[str], confirmed: bool,
                     sync_new_conversations: bool = False, sync_planning: bool = False,
                     sync_notes: bool = False, sync_preferences: bool = False) -> dict:
        async with self.lock:
            draft = self.draft
            if not confirmed or not draft or draft["id"] != draft_id or draft["expires"] < time.monotonic():
                raise CloudTransferError("setup_expired", "启用确认已失效，请重新打开云同步设置。")
            if any(key not in {row["key"] for row in draft["candidates"]} for key in keys):
                raise CloudTransferError("invalid_scope", "同步范围已变化，请重新选择工作会话。")
            context = await self._context()
            if context["binding"] != draft["binding"]:
                self.draft = None
                raise CloudTransferError("account_changed", "账号已变化，请重新确认同步范围。")
            cipher = draft["cipher"]
            notes_vault = await self._notes_scope(context) if sync_notes else ""
            transport = self.transport_factory(context["binding"])
            if draft["new"]:
                await asyncio.to_thread(transport.control, "POST", "/space",
                    {"vault_id": cipher.vault_id, "key_check": cipher.key_check()})
            saved = await asyncio.to_thread(self.invoke, "cloud_sync_store_key",
                {"binding": context["binding"], "vault_id": cipher.vault_id, "recovery": cipher.recovery_text()}, timeout=65)
            if not isinstance(saved, dict) or saved.get("saved") is not True:
                raise CloudTransferError("key_not_saved", "恢复密钥尚未安全保存，请保留密钥并重试。")
            config = await asyncio.to_thread(self.preferences.read)
            if (set(keys).difference(config.session_keys)
                    or sync_planning and not config.sync_planning
                    or sync_preferences and not config.sync_preferences
                    or sync_notes and (not config.sync_notes or config.notes_vault_token != notes_vault)):
                # Earlier changes may have been intentionally skipped before this
                # data type was selected. Re-read them without replaying writes.
                await asyncio.to_thread(self.store.cursor, cipher.vault_id, 0)
            config.enabled, config.account_id, config.vault_id = True, context["account_id"], cipher.vault_id
            config.session_keys = list(dict.fromkeys(keys))
            config.sync_new_conversations = sync_new_conversations
            config.sync_planning = sync_planning
            config.sync_notes = sync_notes
            config.sync_preferences = sync_preferences
            config.notes_vault_token = notes_vault
            config.excluded_session_keys = [item["key"] for item in draft["candidates"] if item["key"] not in keys]
            await asyncio.to_thread(self.preferences.write, config)
            self.draft, self.problem = None, None
            self.cancelled.clear()
            self.wake.set()
            return {"enabled": True}

    async def pause(self) -> dict:
        self.cancelled.set()
        async with self.lock:
            self.cancelled.set()
            self.draft = None
            config = await asyncio.to_thread(self.preferences.read)
            config.enabled = False
            await asyncio.to_thread(self.preferences.write, config)
            self.phase = "paused"
            return {"enabled": False}

    async def select(self, keys: list[str], sync_new_conversations: bool | None = None,
                     sync_planning: bool | None = None, sync_notes: bool | None = None,
                     sync_preferences: bool | None = None) -> dict:
        async with self.lock:
            context = await self._context()
            config = await asyncio.to_thread(self.preferences.read)
            if config.account_id != context["account_id"]:
                raise CloudTransferError("account_changed", "请先在当前账号启用同步。")
            candidates = {row["key"] for row in await asyncio.to_thread(self._candidates, config.vault_id)}
            if any(key not in candidates for key in keys):
                raise CloudTransferError("invalid_scope", "请选择本机普通工作会话。")
            config.session_keys = list(dict.fromkeys(keys))
            if sync_new_conversations is not None:
                config.sync_new_conversations = sync_new_conversations
            if sync_planning is not None:
                config.sync_planning = sync_planning
            if sync_preferences is not None:
                config.sync_preferences = sync_preferences
            if sync_notes is not None:
                config.sync_notes = sync_notes
                config.notes_vault_token = await self._notes_scope(context) if sync_notes else ""
            config.excluded_session_keys = sorted(candidates.difference(keys))
            await asyncio.to_thread(self.preferences.write, config)
            self.wake.set()
            await asyncio.to_thread(self.store.cursor, config.vault_id, 0)
            return {"selected_keys": config.session_keys, "sync_new_conversations": config.sync_new_conversations,
                    "sync_planning": config.sync_planning, "sync_notes": config.sync_notes,
                    "sync_preferences": config.sync_preferences}

    async def _owned_reader(self, resource: str):
        if not isinstance(resource, str) or not ID32.fullmatch(resource):
            raise CloudTransferError("invalid_resource", "会话标识无效。")
        context = await self._context()
        self._cloud_ready(context)
        config = await asyncio.to_thread(self.preferences.read)
        space = context.get("space")
        if (config.account_id != context["account_id"] or not isinstance(space, dict)
                or space.get("vault_id") != config.vault_id):
            raise CloudTransferError("account_changed", "此会话不属于当前云空间。")
        mapping = next((row for row in await asyncio.to_thread(self.store.mappings, config.vault_id)
                        if row["resource"] == resource), None)
        if not mapping or not mapping["version"]:
            raise CloudTransferError("history_missing", "该会话尚无已确认的云版本。")
        cipher = VaultCipher.from_recovery(context.get("recovery"))
        if not cipher.matches_key_check(space.get("key_check")):
            raise CloudTransferError("recovery_required", "请先导入当前云空间的恢复密钥。")
        self.cancelled.clear()
        return context, mapping, WorkTransfer(cipher, self.transport_factory(context["binding"]), self.cancelled)

    async def history(self, resource: str, before: int = 2_147_483_647) -> dict:
        async with self.lock:
            _, mapping, transfer = await self._owned_reader(resource)
            source = mapping["version"]["resource_id"]
            page = await asyncio.to_thread(transfer.transport.control, "GET", f"/resources/{source}/history?before={before}")
            rows = page.get("items")
            if not isinstance(rows, list) or len(rows) > 50:
                raise CloudTransferError("invalid_history", "会话版本列表无效。")
            return {"items": [{"version": item["version"], "created_at": item.get("created_at"),
                               "deleted": bool(item.get("deleted"))} for item in rows
                              if item.get("resource_id") == source and item.get("kind") == "work_conversation"],
                    "has_more": page.get("has_more") is True, "next_before": page.get("next_before", before)}

    async def files(self, resource: str) -> dict:
        async with self.lock:
            context, mapping, transfer = await self._owned_reader(resource)
            downloaded = await asyncio.to_thread(transfer.pull, mapping["version"])
            await self._guard(context["binding"])
            files = []
            for item in downloaded.snapshot["files"]:
                target = restored_file_path(item, workspace=self.manager.workspace,
                    media_root=self.media_root, vault_id=transfer.cipher.vault_id)
                files.append({"id": item["id"], "name": item["name"], "size": item["size"],
                              "local": target.is_file() and not target.is_symlink()})
            return {"files": files}

    async def download_file(self, resource: str, file_id: str) -> dict:
        async with self.lock:
            context, mapping, transfer = await self._owned_reader(resource)
            downloaded = await asyncio.to_thread(transfer.pull, mapping["version"])
            await self._guard(context["binding"])
            await asyncio.to_thread(transfer.materialize, downloaded, file_id,
                workspace=self.manager.workspace, media_root=self.media_root)
            await self._guard(context["binding"])
            return {"downloaded": True, "file_id": file_id}

    async def ensure_file(self, session_key: str | None, path: Path) -> bool:
        """Hydrate an exact recorded version, never an arbitrary path or latest replacement."""
        from mona.cloud.file_access import is_cloud_file_path
        from mona.cloud.work_files import WorkFileError

        if not path.is_absolute() or not is_cloud_file_path(path):
            return False
        if session_key is not None and not is_work_session(session_key, {}):
            return False
        if path.is_file():
            return True
        async with self.lock:
            if path.is_file():
                return True
            context = await self._context()
            self._cloud_ready(context)
            config = await asyncio.to_thread(self.preferences.read)
            space = context.get("space")
            if (config.account_id != context["account_id"] or not isinstance(space, dict)
                    or config.vault_id != space.get("vault_id")):
                raise CloudTransferError("account_changed", "此文件不属于当前账号的云空间，请切回原账号后重试。")
            mappings = await asyncio.to_thread(self.store.mappings, config.vault_id)
            selected = None
            for mapping in mappings:
                if session_key is not None and mapping["local_key"] != session_key:
                    continue
                if not mapping["version"]:
                    continue
                metadata = await asyncio.to_thread(read_work_metadata, self.manager, mapping["local_key"])
                history = metadata.get("cloud_history") if metadata else None
                if not isinstance(history, dict) or history.get("vault_id") != config.vault_id:
                    continue
                files = history.get("files", [])
                if not isinstance(files, list):
                    continue
                for descriptor in files:
                    try:
                        target = restored_file_path(descriptor, workspace=self.manager.workspace,
                            media_root=self.media_root, vault_id=config.vault_id)
                    except (WorkFileError, TypeError, KeyError):
                        continue
                    if target.absolute() == path.absolute():
                        selected = (mapping, descriptor)
                        break
                if selected:
                    break
            if selected is None:
                raise CloudTransferError("file_unavailable", "文件不属于当前会话已确认的云版本，未下载其他内容。")
            mapping, descriptor = selected
            cipher = VaultCipher.from_recovery(context.get("recovery"))
            if cipher.vault_id != config.vault_id or not cipher.matches_key_check(space.get("key_check")):
                raise CloudTransferError("recovery_required", "请在云同步设置中导入原恢复密钥后再打开文件。")
            from threading import Event as ReadEvent
            request_cancelled = ReadEvent()
            transfer = WorkTransfer(cipher, self.transport_factory(context["binding"]), request_cancelled)

            def before_publish():
                transfer._check_cancel()
                if self.closed:
                    raise CloudTransferError("cancelled", "应用已停止同步，未保存本次下载内容。")
                current = self.invoke("cloud_sync_context", timeout=65)
                transfer._check_cancel()
                if not isinstance(current, dict) or current.get("binding") != context["binding"]:
                    raise CloudTransferError("account_changed", "账号已变化，未保存本次下载内容。")

            try:
                downloaded = await asyncio.to_thread(transfer.pull, mapping["version"])
                exact = next((item for item in downloaded.snapshot["files"] if item["id"] == descriptor["id"]), None)
                if (exact is None or exact["sha256"] != descriptor["sha256"]
                        or exact["size"] != descriptor["size"]
                        or restored_file_path(exact, workspace=self.manager.workspace, media_root=self.media_root,
                            vault_id=config.vault_id).absolute() != path.absolute()):
                    raise CloudTransferError("file_version_changed", "文件版本已变化，请刷新会话后重新打开，原文件未被覆盖。")
                target = await asyncio.to_thread(transfer.materialize, downloaded, descriptor["id"],
                    workspace=self.manager.workspace, media_root=self.media_root, before_publish=before_publish)
                return target == path
            except asyncio.CancelledError:
                request_cancelled.set()
                raise

    async def restore_version(self, resource: str, version_number: int, request_id: str, confirmed: bool) -> dict:
        if not confirmed or not isinstance(request_id, str) or not ID32.fullmatch(request_id):
            raise CloudTransferError("confirmation_required", "请确认将历史版本恢复为新会话。")
        async with self.lock:
            context, mapping, transfer = await self._owned_reader(resource)
            vault = transfer.cipher.vault_id
            new_resource = hashlib.sha256(f"restore:{vault}:{resource}:{version_number}:{request_id}".encode()).hexdigest()[:32]
            existing = next((row for row in await asyncio.to_thread(self.store.mappings, vault)
                             if row["resource"] == new_resource), None)
            if existing:
                return {"restored": True, "key": existing["local_key"], "reused": True}
            source = mapping["version"]["resource_id"]
            page = await asyncio.to_thread(transfer.transport.control, "GET",
                f"/resources/{source}/history?before={version_number + 1}")
            version = next((item for item in page.get("items", []) if item.get("version") == version_number
                            and item.get("resource_id") == source and item.get("deleted") is False), None)
            if version is None:
                raise CloudTransferError("history_missing", "所选会话版本不存在或不是可恢复的内容。")
            downloaded = await asyncio.to_thread(transfer.pull, version)
            key = f"websocket:restored-{new_resource}"
            if await asyncio.to_thread(self.manager.read_session_file, key) is not None:
                raise CloudTransferError("restore_conflict", "本机已有同名恢复记录，未覆盖。")
            restore = prepare_work_restore(downloaded.snapshot, vault_id=vault, resource_id=source,
                workspace=self.manager.workspace, media_root=self.media_root, target_key=key)
            restore.session.metadata["title"] = f"{restore.session.metadata.get('title') or '会话'} · 恢复版本 {version_number}"
            lock = self.loop._session_locks.setdefault(key, asyncio.Lock())
            async with lock:
                await self._guard(context["binding"])
                await asyncio.to_thread(self.store.apply, self.manager, restore, self.transcript_for(key),
                    vault=vault, resource=new_resource, version=version, local_digest=lambda: "",
                    source_resource=source)
            config = await asyncio.to_thread(self.preferences.read)
            if config.account_id == context["account_id"] and key not in config.session_keys:
                config.session_keys.append(key)
                await asyncio.to_thread(self.preferences.write, config)
            self.wake.set()
            await self._notify_views(context, [key])
            return {"restored": True, "key": key, "reused": False}

    def _busy(self, key: str) -> bool:
        tasks = getattr(self.loop, "_active_tasks", {}).get(key, [])
        lock = getattr(self.loop, "_session_locks", {}).get(key)
        return any(not task.done() for task in tasks) or bool(lock and lock.locked())

    def _export(self, key: str, vault: str, resource: str, origin: str | None = None):
        exported = export_work_snapshot(self.manager, key, vault_id=vault, resource_id=origin or resource,
            transcript_path=self.transcript_for(key), media_root=self.media_root)
        if origin and origin != resource:
            exported.snapshot["resource_id"] = resource
            return WorkExport(exported.snapshot, exported.sources, hashlib.sha256(canonical_bytes(exported.snapshot)).hexdigest())
        return exported

    async def _apply(self, downloaded, context: dict, mapping: dict | None) -> bool:
        resource, vault = downloaded.version["resource_id"], downloaded.snapshot["vault_id"]
        key = mapping["local_key"] if mapping else f"websocket:cloud-{vault[:12]}-{resource}"
        if mapping is None and await asyncio.to_thread(self.manager.read_session_file, key) is not None:
            key = f"websocket:cloud-{uuid.uuid4().hex}"
        if self._busy(key):
            return False
        fork, before = None, None
        if mapping:
            current = await asyncio.to_thread(self.manager.read_session_file, key)
            if current is None:
                return True  # Local deletion never authorizes resurrection or cloud deletion.
            exported = await asyncio.to_thread(self._export, key, vault, resource, mapping.get("conflict_of"))
            before = work_content_fingerprint(exported.snapshot)
            if before == work_content_fingerprint(downloaded.snapshot):
                await asyncio.to_thread(self.store.put, vault, resource, key, before, downloaded.version, mapping.get("conflict_of"))
                return True
            if before != mapping["local_digest"]:
                fork = uuid.uuid4().hex
                key = f"websocket:cloud-{uuid.uuid4().hex}"
        restore = prepare_work_restore(downloaded.snapshot, vault_id=vault, resource_id=resource,
            workspace=self.manager.workspace, media_root=self.media_root, target_key=key)
        if fork:
            restore.session.metadata["title"] = f"{restore.session.metadata.get('title') or '会话'} · 同步分支"
        locks = getattr(self.loop, "_session_locks", None)
        if locks is None:
            raise CloudTransferError("runtime_unavailable", "会话服务尚未就绪，未恢复历史。")
        lock = locks.setdefault(key, asyncio.Lock())
        if lock.locked():
            return False
        async with lock:
            await self._guard(context["binding"])
            if before is not None and not fork:
                latest = await asyncio.to_thread(self._export, key, vault, resource, mapping.get("conflict_of"))
                if work_content_fingerprint(latest.snapshot) != before:
                    return False
            await asyncio.to_thread(self.store.apply, self.manager, restore, self.transcript_for(key),
                vault=vault, resource=resource, version=downloaded.version,
                local_digest=lambda: work_content_fingerprint(self._export(key, vault, resource).snapshot), fork_local_to=fork)
            current_config = await asyncio.to_thread(self.preferences.read)
            if current_config.account_id == context["account_id"] and key not in current_config.session_keys:
                current_config.session_keys.append(key)
                await asyncio.to_thread(self.preferences.write, current_config)
            self._updated_work_keys.add(key)
        return True

    async def _notify_views(self, context: dict, work_keys=(), planning: bool = False) -> None:
        if not work_keys and not planning:
            return
        try:
            result = await asyncio.to_thread(self.invoke, "cloud_sync_notify", {
                "binding": context["binding"], "work_keys": sorted(work_keys), "planning": planning,
            }, timeout=10)
            if not isinstance(result, dict) or result.get("emitted") is not True:
                raise ValueError("Notification not confirmed")
        except Exception as exc:
            # Saving has already succeeded. A view notification must not replay
            # a committed download or present the user's data as unsaved.
            logger.warning("Cloud view refresh deferred ({})", type(exc).__name__)

    async def _planning_sync(self, context, transfer):
        from mona.cloud.planning import PlanningClient, PlanningSync
        client = self.planning_client
        if client is None:
            from mona.config.loader import load_config
            config = await asyncio.to_thread(load_config, self.preferences.path)
            client = PlanningClient(config.services.port)
        return PlanningSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def _notes_scope(self, context):
        from mona.cloud.notes import NotesClient
        client = self.notes_client or NotesClient(self.invoke, context["binding"])
        await client.index()
        return client.vault

    async def _notes_sync(self, context, transfer, config):
        from mona.cloud.notes import NotesClient, NotesSync
        if not config.notes_vault_token:
            raise CloudTransferError("notes_scope_required", "请在同步范围中确认本机笔记仓库。")
        client = self.notes_client or NotesClient(self.invoke, context["binding"], config.notes_vault_token)
        await client.index()
        if client.vault != config.notes_vault_token:
            raise CloudTransferError("notes_vault_changed", "本机笔记仓库已更换，请重新确认同步范围。")
        return NotesSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def _preferences_sync(self, context, transfer):
        from mona.cloud.preferences import PreferencesClient, PreferencesSync
        client = self.preferences_client or PreferencesClient(self.invoke, context["binding"])
        return PreferencesSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def run_once(self) -> None:
        if self.lock.locked():
            return
        async with self.lock:
            config = await asyncio.to_thread(self.preferences.read)
            if not config.enabled:
                return
            self.cancelled.clear()
            self.phase, self.problem = "syncing", None
            context, planning, notes, ui_preferences = None, None, None, None
            self._updated_work_keys.clear()
            try:
                context = await self._context()
                self._cloud_ready(context)
                if (context["account_id"] != config.account_id or not context.get("space")
                        or context["space"].get("vault_id") != config.vault_id):
                    raise CloudTransferError("account_changed", "账号或云空间已变化，请重新确认同步范围。")
                cipher = VaultCipher.from_recovery(context.get("recovery"))
                if not cipher.matches_key_check(context["space"].get("key_check")):
                    raise CloudTransferError("recovery_required", "请导入当前云空间的恢复密钥。")
                transport = self.transport_factory(context["binding"])
                transfer = WorkTransfer(cipher, transport, self.cancelled)
                cursor = await asyncio.to_thread(self.store.cursor, config.vault_id)
                planning = await self._planning_sync(context, transfer) if config.sync_planning else None
                notes = await self._notes_sync(context, transfer, config) if config.sync_notes else None
                ui_preferences = await self._preferences_sync(context, transfer) if config.sync_preferences else None
                page = await asyncio.to_thread(transport.control, "GET", f"/changes?after={cursor}&limit=100")
                rows = page.get("items")
                if not isinstance(rows, list) or len(rows) > 100:
                    raise CloudTransferError("invalid_response", "云会话列表无效。")
                for version in rows:
                    if not isinstance(version, dict) or type(version.get("sequence")) is not int or version["sequence"] <= cursor:
                        raise CloudTransferError("invalid_response", "云同步游标无效。")
                    if version.get("kind") == "work_conversation" and version.get("deleted") is False:
                        mappings = {row["resource"]: row for row in await asyncio.to_thread(self.store.mappings, config.vault_id)}
                        mapping = mappings.get(version.get("resource_id"))
                        config = await asyncio.to_thread(self.preferences.read)
                        if not config.enabled or self.cancelled.is_set():
                            self.phase = "paused"
                            return
                        if mapping and mapping["local_key"] not in config.session_keys:
                            cursor = version["sequence"]
                            await asyncio.to_thread(self.store.cursor, config.vault_id, cursor)
                            continue
                        local_version = mapping["version"] if mapping else None
                        if (not local_version or local_version.get("resource_id") != version.get("resource_id")
                                or local_version["version"] < version.get("version", 0)):
                            downloaded = await asyncio.to_thread(transfer.pull, version)
                            if not await self._apply(downloaded, context, mapping):
                                self.phase = "waiting"
                                return
                    if planning is not None and version.get("kind") in ("todo", "calendar_event"):
                        await planning.receive(version)
                    if notes is not None and version.get("kind") == "note":
                        await notes.receive(version)
                    if ui_preferences is not None and version.get("kind") == "preferences":
                        await ui_preferences.receive(version)
                    cursor = version["sequence"]
                    await asyncio.to_thread(self.store.cursor, config.vault_id, cursor)
                if page.get("has_more"):
                    self.wake.set()
                    return
                mappings = await asyncio.to_thread(self.store.mappings, config.vault_id)
                mapped = {row["local_key"]: row for row in mappings}
                owners = await asyncio.to_thread(self.store.owners)
                config = await asyncio.to_thread(self.preferences.read)
                if not config.enabled or self.cancelled.is_set():
                    self.phase = "paused"
                    return
                if config.sync_new_conversations:
                    excluded = set(config.excluded_session_keys)
                    selected = list(dict.fromkeys(config.session_keys))
                    for item in await asyncio.to_thread(self._candidates, config.vault_id):
                        if item["key"] not in selected and item["key"] not in excluded:
                            selected.append(item["key"])
                    if selected != config.session_keys:
                        config.session_keys = selected
                        await asyncio.to_thread(self.preferences.write, config)
                candidates = list(dict.fromkeys(config.session_keys))
                waiting_for_task = False
                if context.get("plan") == "pro":
                    for key in candidates:
                        if owners.get(key) not in (None, config.vault_id):
                            continue
                        if self._busy(key):
                            waiting_for_task = True
                            continue
                        data = await asyncio.to_thread(self.manager.read_session_file, key)
                        if data is None or not is_work_session(key, data.get("metadata")):
                            continue
                        mapping = mapped.get(key)
                        resource = mapping["resource"] if mapping else uuid.uuid4().hex
                        exported = await asyncio.to_thread(self._export, key, config.vault_id, resource,
                            mapping.get("conflict_of") if mapping else None)
                        content_digest = work_content_fingerprint(exported.snapshot)
                        if mapping and mapping["version"] and mapping["local_digest"] == content_digest:
                            continue
                        if mapping is None:
                            await asyncio.to_thread(self.store.put, config.vault_id, resource, key, content_digest, None)
                        previous = await asyncio.to_thread(transfer.pull, mapping["version"]) if mapping and mapping["version"] else None
                        base_version = previous.version["version"] if previous else 0
                        if previous and previous.version["resource_id"] != resource:
                            # Preserve verified cloud-only file chunks when retaining
                            # a local conflict as a new independent conversation.
                            previous = copy.deepcopy(previous)
                            previous.bundle["resource_id"] = resource
                            previous.version["resource_id"] = resource
                            previous.snapshot["resource_id"] = resource
                            base_version = 0
                        version = await asyncio.to_thread(transfer.push, exported, base_version=base_version, previous=previous)
                        await self._guard(context["binding"])
                        await asyncio.to_thread(self.store.put, config.vault_id, resource, key, content_digest, version,
                            mapping.get("conflict_of") if mapping else None)
                planning_done = True
                if planning is not None and context.get("plan") == "pro":
                    planning_done = await planning.send()
                notes_done = await notes.send() if notes is not None and context.get("plan") == "pro" else True
                if ui_preferences is not None and context.get("plan") == "pro":
                    await ui_preferences.send()
                self.transferred_bytes = transfer.transferred_bytes
                self.phase = "pending" if not planning_done or not notes_done else "waiting" if waiting_for_task else "idle"
                if not waiting_for_task and planning_done and notes_done:
                    self.last_sync = time.time()
                if page.get("has_more"):
                    self.wake.set()
            except Exception as exc:
                self.phase = "paused" if self.cancelled.is_set() else "error"
                self.problem = {"code": getattr(exc, "code", "sync_unavailable"),
                    "message": str(exc) if isinstance(exc, (CloudTransferError, CloudCryptoError)) else "同步尚未完成，本地内容已保留，请稍后重试。"}
                logger.warning("Cloud sync stopped ({})", type(exc).__name__)
            finally:
                if context is not None:
                    await self._notify_views(context, self._updated_work_keys,
                                            planning.modified if planning is not None else False)

    async def start(self):
        async with self.start_lock:
            if self.task is not None and not self.task.done():
                return
            await asyncio.to_thread(self.store.recover, self.manager, self.transcript_for)
            self.closed = False
            async def worker():
                while not self.closed:
                    self.wake.clear()
                    interval = 60
                    try:
                        await self.run_once()
                        config = await asyncio.to_thread(self.preferences.read)
                        interval = config.interval_seconds
                    except Exception as exc:
                        self.phase = "error"
                        self.problem = {"code": "sync_configuration", "message": "同步设置或本地记录尚未就绪，请检查设置后重试。"}
                        logger.warning("Cloud worker waiting ({})", type(exc).__name__)
                    try:
                        await asyncio.wait_for(self.wake.wait(), interval)
                    except asyncio.TimeoutError:
                        pass
            self.task = asyncio.create_task(worker(), name="work-cloud-sync")

    async def close(self):
        self.closed = True
        self.cancelled.set()
        self.wake.set()
        if self.task:
            await self.task
            self.task = None
