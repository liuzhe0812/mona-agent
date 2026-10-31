"""Automatic account receiving and confirmed local uploads, owned by the Gateway."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
import uuid
from pathlib import Path
from threading import Event
from traceback import extract_tb
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
            data.pop("cloudSync", None)
            data["cloud_sync"] = config.model_dump(by_alias=True, mode="json")
            _atomic_write_json(self.path, data)


class CloudCoordinator:
    def __init__(self, agent_loop, *, config_path: Path, state_path: Path,
                 media_root: Path, transcript_for: Callable[[str], Path],
                 invoke=tauri_invoke, transport_factory=BridgeCloudTransport, planning_client=None, notes_client=None, preferences_client=None,
                 operations_client=None):
        self.loop, self.manager = agent_loop, agent_loop.sessions
        self.media_root, self.transcript_for = media_root, transcript_for
        self.preferences = SyncPreferences(config_path)
        self.store = LocalCloudStore(state_path)
        self.invoke, self.transport_factory = invoke, transport_factory
        self.planning_client = planning_client
        self.notes_client = notes_client
        self.preferences_client = preferences_client
        self.operations_client = operations_client
        self._updated_work_keys: set[str] = set()
        self.cancelled = Event()
        self.wake = asyncio.Event()
        self.lock = asyncio.Lock()
        self.start_lock = asyncio.Lock()
        self.task = None
        self.closed = False
        self.phase, self.problem, self.last_sync = "idle", None, None
        self.blocked_keys: list[str] = []
        self.blocked_files: dict[str, list[dict]] = {}
        self.transferred_bytes = 0
        self.draft = None
        self.cleanup_draft = None
        from mona.cloud.history_retention import HistoryRetention
        self.history_retention = HistoryRetention(self)
        from mona.cloud.recycle import CloudRecycle
        self.recycle = CloudRecycle(self)

    async def _context(self) -> dict:
        try:
            context = await asyncio.to_thread(self.invoke, "cloud_sync_context", timeout=65)
        except RuntimeError as exc:
            if str(exc) == "请先登录 Mona。":
                raise CloudTransferError("account_required", "请登录 Mona 后接收云内容。") from None
            raise
        if (not isinstance(context, dict) or not isinstance(context.get("binding"), str)
                or not isinstance(context.get("account_id"), str)):
            raise CloudTransferError("account_required", "请登录并联网核对账号后再同步。")
        return context

    async def _bind_receiver(self, context, config):
        legacy = config.upload_enabled is None
        if legacy:
            config.upload_enabled = bool(config.account_id and config.vault_id)
            if not config.account_id:
                config.enabled = True
        space = context.get("space")
        vault = space.get("vault_id", "") if isinstance(space, dict) else ""
        changed = config.account_id != context["account_id"] or config.vault_id != vault
        if changed:
            config = CloudSyncConfig(enabled=config.enabled, upload_enabled=False,
                account_id=context["account_id"], vault_id=vault, interval_seconds=config.interval_seconds)
            self.last_sync = None
        if legacy or changed:
            await self._guard(context["binding"])
            if vault:
                await asyncio.to_thread(self.store.cursor, vault, 0)
            await asyncio.to_thread(self.preferences.write, config)
        return config

    def _transport(self, context: dict):
        transport = self.transport_factory(context["binding"])
        if isinstance(transport, BridgeCloudTransport):
            account = context["account_id"]
            transport.download_recorder = lambda size, complete: self.store.record_download(account, size, complete)
        return transport

    @staticmethod
    def _cloud_ready(context: dict) -> None:
        if context.get("cloud_status") != 200:
            messages = {
                "cloud_unavailable": "云同步服务尚未开放，本地资料仍可正常使用。",
                "cloud_not_configured": "云同步服务尚未配置完成，本地资料仍可正常使用。",
                "cloud_service_not_ready": "云同步服务尚未就绪，本地资料仍可正常使用。",
            }
            code = context.get("error")
            if not isinstance(code, str) or code not in messages:
                raise CloudTransferError("cloud_unavailable", "云同步服务尚未开放或配置完成。")
            raise CloudTransferError(code, messages[code])

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
            bound = same and config.vault_id == vault
            receiving = config.enabled or (config.upload_enabled is None and not config.account_id)
            # Only public quota fields leave this service; keys and account
            # binding remain confined to the desktop/Python boundary.
            public_space = {k: space[k] for k in ("quota_bytes", "used_bytes", "reserved_bytes", "object_count") if k in space} if isinstance(space, dict) else None
            candidates = await asyncio.to_thread(self._candidates, vault)
            candidate_keys = {item["key"] for item in candidates}
            result.update(available=True, plan=context.get("plan"), space=public_space,
                local_download_usage=await asyncio.to_thread(self.store.download_usage, context["account_id"]),
                enabled=bool(space) and receiving,
                upload_enabled=bool(space) and same and config.vault_id == vault
                    and (config.upload_enabled if config.upload_enabled is not None else bool(config.account_id and config.vault_id)),
                phase=self.phase if bound else "syncing" if space and receiving else "idle",
                last_sync=self.last_sync if bound else None,
                problem=self.problem if bound else None,
                needs_key=bool(space) and not space.get("key_managed") and not context.get("recovery"),
                candidates=candidates,
                selected_keys=[key for key in config.session_keys if key in candidate_keys] if same else [],
                sync_new_conversations=config.sync_new_conversations if same else False,
                sync_planning=config.sync_planning if same else False,
                sync_preferences=config.sync_preferences if same else False,
                sync_notes=config.sync_notes if same else False,
                sync_operations=config.sync_operations if same else False,
                sync_operations_credentials=config.sync_operations_credentials if same else False,
                blocked_keys=[key for key in self.blocked_keys if key in config.session_keys and key in candidate_keys]
                    if same and config.vault_id == vault else [])
            result["blocked_files"] = {key: self.blocked_files[key] for key in result["blocked_keys"]
                                       if key in self.blocked_files}
            rows = await asyncio.to_thread(self.store.mappings, vault) if vault else []
            result["conversations"] = [{"key": row["local_key"], "resource_id": row["resource"],
                "version": row["version"]["version"] if row["version"] and row["version"]["resource_id"] == row["resource"] else 0,
                "conflict_copy": bool(row["conflict_of"]),
                "trashed": self.recycle.deleted_version(vault, row["resource"]) > 0} for row in rows]
        except Exception as exc:
            if not isinstance(exc, CloudTransferError):
                logger.warning("Cloud status unavailable ({})", type(exc).__name__)
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
            transport = self._transport(context)
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
            result = await asyncio.to_thread(self._transport(context).control,
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
                if space.get("key_managed"):
                    raise CloudTransferError("cloud_key_unavailable", "账号密钥尚未加载，请重新打开 Mona 后重试。")
                raise CloudTransferError("recovery_required", "请在原设备启用账号自动恢复，或导入旧密钥完成一次迁移。")
            cipher = VaultCipher.from_recovery(supplied) if supplied else VaultCipher.generate()
            if space and (space.get("vault_id") != cipher.vault_id or not cipher.matches_key_check(space.get("key_check"))):
                raise CloudTransferError("recovery_required", "请提供这个云空间原来的恢复密钥。")
            self.draft = {"id": uuid.uuid4().hex, "expires": time.monotonic() + 600,
                "binding": context["binding"], "account_id": context["account_id"], "cipher": cipher,
                "candidates": await asyncio.to_thread(self._candidates, cipher.vault_id), "new": not bool(space)}
            return {"draft_id": self.draft["id"], "new_space": self.draft["new"],
                "candidates": self.draft["candidates"]}

    async def enable(self, draft_id: str, keys: list[str], confirmed: bool,
                     sync_new_conversations: bool = False, sync_planning: bool = False,
                     sync_notes: bool = False, sync_preferences: bool = False,
                     sync_operations: bool = False, sync_operations_credentials: bool = False) -> dict:
        if sync_operations_credentials and not sync_operations:
            raise CloudTransferError("invalid_scope", "请先选择上传运维主机配置，再选择是否包含登录凭据。")
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
            space = context.get("space")
            notes_vault = await self._notes_scope(context) if sync_notes else ""
            transport = self._transport(context)
            if draft["new"]:
                registered = await asyncio.to_thread(transport.control, "POST", "/space",
                    {"vault_id": cipher.vault_id, "key_check": cipher.key_check(), "recovery": cipher.recovery_text()})
                if registered.get("key_managed") is not True:
                    raise CloudTransferError("cloud_key_unavailable", "账号自动恢复尚未确认，未开启同步。")
            elif not space.get("key_managed"):
                registered = await asyncio.to_thread(transport.control, "POST", "/space/key", {"recovery": cipher.recovery_text()})
                if registered.get("managed") is not True or registered.get("vault_id") != cipher.vault_id:
                    raise CloudTransferError("cloud_key_unavailable", "旧云空间迁移尚未确认，未开启同步。")
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
            config.enabled, config.upload_enabled = True, True
            config.account_id, config.vault_id = context["account_id"], cipher.vault_id
            config.session_keys = list(dict.fromkeys(keys))
            config.sync_new_conversations = sync_new_conversations
            config.sync_planning = sync_planning
            config.sync_notes = sync_notes
            config.sync_preferences = sync_preferences
            config.sync_operations = sync_operations
            config.sync_operations_credentials = sync_operations_credentials
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
            if config.upload_enabled is None:
                config.upload_enabled = bool(config.account_id and config.vault_id)
            config.enabled = False
            await asyncio.to_thread(self.preferences.write, config)
            self.phase = "paused"
            return {"enabled": False}

    async def resume(self) -> dict:
        async with self.lock:
            self.cancelled.clear()
            context = await self._context()
            self._cloud_ready(context)
            config = await self._bind_receiver(context, await asyncio.to_thread(self.preferences.read))
            if not context.get("space"):
                raise CloudTransferError("cloud_space_missing", "账号尚无云内容，请先确认要上传的资料。")
            config.enabled = True
            await asyncio.to_thread(self.preferences.write, config)
            self.problem = None
            self.wake.set()
            return {"enabled": True}

    async def select(self, keys: list[str], sync_new_conversations: bool | None = None,
                     sync_planning: bool | None = None, sync_notes: bool | None = None,
                     sync_preferences: bool | None = None, sync_operations: bool | None = None,
                     sync_operations_credentials: bool | None = None) -> dict:
        async with self.lock:
            context = await self._context()
            config = await asyncio.to_thread(self.preferences.read)
            if config.account_id != context["account_id"]:
                raise CloudTransferError("account_changed", "请先在当前账号启用同步。")
            if config.upload_enabled is False:
                raise CloudTransferError("upload_confirmation_required", "请先确认允许上传的本机资料。")
            candidates = {row["key"] for row in await asyncio.to_thread(self._candidates, config.vault_id)}
            previously_selected = set(config.session_keys)
            if any(key not in candidates and key not in previously_selected for key in keys):
                raise CloudTransferError("invalid_scope", "会话列表已变化，请重新打开上传范围后选择。")
            config.session_keys = list(dict.fromkeys(key for key in keys if key in candidates))
            if sync_new_conversations is not None:
                config.sync_new_conversations = sync_new_conversations
            if sync_planning is not None:
                config.sync_planning = sync_planning
            if sync_preferences is not None:
                config.sync_preferences = sync_preferences
            if sync_operations is not None:
                config.sync_operations = sync_operations
                if not sync_operations:
                    config.sync_operations_credentials = False
            if sync_operations_credentials is not None:
                if sync_operations_credentials and not config.sync_operations:
                    raise CloudTransferError("invalid_scope", "请先选择上传运维主机配置，再选择是否包含登录凭据。")
                config.sync_operations_credentials = sync_operations_credentials
            if sync_notes is not None:
                config.sync_notes = sync_notes
                config.notes_vault_token = await self._notes_scope(context) if sync_notes else ""
            excluded = set(config.excluded_session_keys)
            excluded.difference_update(config.session_keys)
            excluded.update(candidates.difference(config.session_keys))
            excluded.update(previously_selected.difference(candidates))
            if len(excluded) > 10_000:
                raise CloudTransferError("scope_too_large",
                    "本机历史会话的上传选择记录超过 10,000 条，范围未保存。请联系支持处理。")
            config.excluded_session_keys = sorted(excluded)
            space = context.get("space")
            if space and not space.get("key_managed"):
                cipher = VaultCipher.from_recovery(context.get("recovery"))
                registered = await asyncio.to_thread(self._transport(context).control, "POST", "/space/key", {"recovery": cipher.recovery_text()})
                if registered.get("managed") is not True or registered.get("vault_id") != config.vault_id:
                    raise CloudTransferError("cloud_key_unavailable", "旧云空间迁移尚未确认，未保存同步范围。")
            await asyncio.to_thread(self.preferences.write, config)
            self.wake.set()
            await asyncio.to_thread(self.store.cursor, config.vault_id, 0)
            return {"selected_keys": config.session_keys, "sync_new_conversations": config.sync_new_conversations,
                    "sync_planning": config.sync_planning, "sync_notes": config.sync_notes,
                    "sync_preferences": config.sync_preferences, "sync_operations": config.sync_operations,
                    "sync_operations_credentials": config.sync_operations_credentials}

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
        return context, mapping, WorkTransfer(cipher, self._transport(context), self.cancelled)

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
            transfer = WorkTransfer(cipher, self._transport(context), request_cancelled)

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
            if config.upload_enabled and config.account_id == context["account_id"] and key not in config.session_keys:
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

    async def _apply(self, downloaded, context: dict, mapping: dict | None, *, revive_missing=False) -> bool:
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
                if not revive_missing:
                    return True  # Local deletion alone does not authorize resurrection.
                key = f"websocket:restored-{uuid.uuid4().hex}"
            else:
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
            if current_config.upload_enabled and current_config.account_id == context["account_id"] and key not in current_config.session_keys:
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
        client = self.notes_client or NotesClient(self.invoke, context["binding"], config.notes_vault_token, initialize=True)
        await client.index()
        if config.notes_vault_token and client.vault != config.notes_vault_token:
            raise CloudTransferError("notes_vault_changed", "本机笔记仓库已更换，请重新确认同步范围。")
        if not config.notes_vault_token:
            await self._guard(context["binding"])
            current = await asyncio.to_thread(self.preferences.read)
            if current.account_id != config.account_id or current.vault_id != config.vault_id:
                raise CloudTransferError("account_changed", "账号已变化，未更改笔记恢复位置。")
            current.notes_vault_token = client.vault
            await asyncio.to_thread(self.preferences.write, current)
            config.notes_vault_token = client.vault
        return NotesSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def _preferences_sync(self, context, transfer):
        from mona.cloud.preferences import PreferencesClient, PreferencesSync
        client = self.preferences_client or PreferencesClient(self.invoke, context["binding"])
        return PreferencesSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def _operations_sync(self, context, transfer, config):
        from mona.cloud.operations import OperationsClient, OperationsSync
        client = self.operations_client or OperationsClient(self.invoke, context["binding"],
            include_credentials=config.sync_operations_credentials)
        return OperationsSync(self.store, client, transfer, lambda: self._guard(context["binding"]))

    async def run_once(self) -> None:
        if self.lock.locked():
            return
        async with self.lock:
            config = await asyncio.to_thread(self.preferences.read)
            if not config.enabled and (config.upload_enabled is not None or config.account_id):
                return
            self.cancelled.clear()
            self.phase, self.problem = "syncing", None
            self.blocked_keys = []
            self.blocked_files = {}
            context, planning, notes, ui_preferences, operations = None, None, None, None, None
            self._updated_work_keys.clear()
            try:
                context = await self._context()
                self._cloud_ready(context)
                config = await self._bind_receiver(context, config)
                if not context.get("space"):
                    self.phase = "idle"
                    return
                cipher = VaultCipher.from_recovery(context.get("recovery"))
                if not cipher.matches_key_check(context["space"].get("key_check")):
                    raise CloudTransferError("recovery_required", "请导入当前云空间的恢复密钥。")
                transport = self._transport(context)
                transfer = WorkTransfer(cipher, transport, self.cancelled)
                cursor = await asyncio.to_thread(self.store.cursor, config.vault_id)
                page = await asyncio.to_thread(transport.control, "GET", f"/changes?after={cursor}&limit=100")
                rows = page.get("items")
                if not isinstance(rows, list) or len(rows) > 100:
                    raise CloudTransferError("invalid_response", "云会话列表无效。")
                for version in rows:
                    if not isinstance(version, dict) or type(version.get("sequence")) is not int or version["sequence"] <= cursor:
                        raise CloudTransferError("invalid_response", "云同步游标无效。")
                    if version.get("kind") == "work_conversation" and version.get("deleted") is True:
                        await self._guard(context["binding"])
                        self.recycle.remember(config.vault_id, version)
                    if version.get("kind") == "work_conversation" and version.get("deleted") is False:
                        mappings = {row["resource"]: row for row in await asyncio.to_thread(self.store.mappings, config.vault_id)}
                        mapping = mappings.get(version.get("resource_id"))
                        deleted_version = self.recycle.deleted_version(config.vault_id, version.get("resource_id"))
                        if type(version.get("version")) is not int:
                            raise CloudTransferError("invalid_response", "云会话版本无效。")
                        if deleted_version >= version["version"]:
                            cursor = version["sequence"]
                            await asyncio.to_thread(self.store.cursor, config.vault_id, cursor)
                            continue
                        config = await asyncio.to_thread(self.preferences.read)
                        if not config.enabled or self.cancelled.is_set():
                            self.phase = "paused"
                            return
                        local_version = mapping["version"] if mapping else None
                        if (not local_version or local_version.get("resource_id") != version.get("resource_id")
                                or local_version["version"] < version.get("version", 0)):
                            downloaded = await asyncio.to_thread(transfer.pull, version)
                            if not await self._apply(downloaded, context, mapping, revive_missing=deleted_version > 0):
                                self.phase = "waiting"
                                return
                            self.recycle.forget(config.vault_id, version["resource_id"], version["version"])
                    if version.get("kind") in ("todo", "calendar_event"):
                        if planning is None:
                            planning = await self._planning_sync(context, transfer)
                        await planning.receive(version)
                    if version.get("kind") == "note":
                        if notes is None:
                            notes = await self._notes_sync(context, transfer, config)
                        await notes.receive(version)
                    if version.get("kind") == "preferences":
                        if ui_preferences is None:
                            ui_preferences = await self._preferences_sync(context, transfer)
                        await ui_preferences.receive(version)
                    if version.get("kind") == "ops_host":
                        if operations is None:
                            operations = await self._operations_sync(context, transfer, config)
                        await operations.receive(version)
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
                if config.upload_enabled and config.sync_new_conversations:
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
                if config.upload_enabled and context.get("plan") == "pro":
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
                        if mapping and self.recycle.deleted_version(config.vault_id, mapping["resource"]):
                            continue  # Keep local edits without republishing a trashed cloud copy.
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
                        try:
                            version = await asyncio.to_thread(transfer.push, exported, base_version=base_version, previous=previous)
                        except CloudTransferError as exc:
                            if exc.code != "associated_file_unavailable":
                                raise
                            self.blocked_keys.append(key)
                            self.blocked_files[key] = exc.files
                            continue
                        await self._guard(context["binding"])
                        await asyncio.to_thread(self.store.put, config.vault_id, resource, key, content_digest, version,
                            mapping.get("conflict_of") if mapping else None)
                planning_done = True
                if config.upload_enabled and config.sync_planning and context.get("plan") == "pro":
                    if planning is None:
                        planning = await self._planning_sync(context, transfer)
                    planning_done = await planning.send()
                notes_done = True
                if config.upload_enabled and config.sync_notes and context.get("plan") == "pro":
                    if notes is None:
                        notes = await self._notes_sync(context, transfer, config)
                    notes_done = await notes.send()
                if config.upload_enabled and config.sync_preferences and context.get("plan") == "pro":
                    if ui_preferences is None:
                        ui_preferences = await self._preferences_sync(context, transfer)
                    await ui_preferences.send()
                operations_done = True
                if config.upload_enabled and config.sync_operations and context.get("plan") == "pro":
                    if operations is None:
                        operations = await self._operations_sync(context, transfer, config)
                    operations_done = await operations.send()
                self.transferred_bytes = transfer.transferred_bytes
                operations_problem = operations.problem if operations is not None else None
                self.phase = "partial" if self.blocked_keys or operations_problem else "pending" if not planning_done or not notes_done or not operations_done else "waiting" if waiting_for_task else "idle"
                if self.blocked_keys:
                    self.problem = {"code": "associated_file_unavailable",
                        "message": f"{len(self.blocked_keys)} 个会话因关联文件问题暂未上传，其他内容继续同步。可在“上传范围”中查看具体文件或排除会话，均不影响保存范围。"}
                elif operations_problem:
                    self.problem = operations_problem
                if not self.blocked_keys and not operations_problem and not waiting_for_task and planning_done and notes_done and operations_done:
                    self.last_sync = time.time()
                if page.get("has_more"):
                    self.wake.set()
            except Exception as exc:
                if context is None and isinstance(exc, CloudTransferError) and exc.code == "account_required":
                    self.phase, self.problem = "signed_out", None
                    return
                self.phase = "paused" if self.cancelled.is_set() else "error"
                self.problem = {"code": getattr(exc, "code", "sync_unavailable"),
                    "message": str(exc) if isinstance(exc, (CloudTransferError, CloudCryptoError)) else "同步尚未完成，本地内容已保留，请稍后重试。"}
                frame = extract_tb(exc.__traceback__, limit=-1)[0]
                logger.warning("Cloud sync stopped ({}) at {}:{} in {}", type(exc).__name__,
                               Path(frame.filename).name, frame.lineno, frame.name)
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
