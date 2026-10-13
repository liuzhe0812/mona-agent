"""Portable Work histories. This module never resumes tasks or reads project trees."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import stat
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from mona.agent.partners import ConversationMetadata
from mona.cloud.work_files import (
    HEX64,
    ID32,
    MAX_FILES,
    WorkFileError,
    WorkFileSource,
    collect_work_files,
    portable_path,
    restored_file_path,
)
from mona.session.manager import Session, SessionManager

FORMAT = "mona-work-snapshot"
MAX_RECORD_BYTES = 8 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
_KEY = re.compile(r"^websocket:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_METADATA_FIELDS = frozenset({"title", "webui", "agent_kind", "conversation", "_last_summary", "task_plan"})
_MESSAGE_FIELDS = frozenset({"id", "role", "content", "timestamp", "author_type", "author_id", "message_type",
    "tool_calls", "tool_call_id", "name", "reasoning_content", "thinking_blocks", "media", "task_id"})
_DISPLAY_AUTHORITY_FIELDS = frozenset({"authorization", "cookie", "access_token", "refresh_token", "api_key", "private_key"})


class WorkSnapshotError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _conversation(metadata: dict) -> ConversationMetadata:
    raw = metadata.get("conversation")
    if raw is None:
        return ConversationMetadata.direct("mona")
    return ConversationMetadata.model_validate(raw)


def is_work_session(key: Any, metadata: Any) -> bool:
    if not isinstance(key, str) or not _KEY.fullmatch(key) or not isinstance(metadata, dict):
        return False
    if metadata.get("hidden") or metadata.get("ephemeral"):
        return False
    if any(metadata.get(field) for field in ("development_session_id", "native_session_id", "executor")):
        return False
    for field in ("mode", "session_mode", "execution_mode"):
        value = metadata.get(field)
        if value is not None and (not isinstance(value, str) or value not in {"", "work"}):
            return False
    try:
        return not _conversation(metadata).hidden
    except (ValueError, TypeError):
        return False


def canonical_bytes(value: Any) -> bytes:
    try:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeError):
        raise WorkSnapshotError("invalid_snapshot", "会话包含无法同步的数据。") from None
    if len(raw) > MAX_SNAPSHOT_BYTES:
        raise WorkSnapshotError("snapshot_too_large", "会话记录过大，尚未完成同步。")
    return raw


def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON member")
        result[key] = value
    return result


def _stamp(path: Path) -> tuple[int, int, int, int] | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise WorkSnapshotError("linked_history", "会话记录不是普通文件，未同步。")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _read_records(path: Path, *, optional: bool = False) -> tuple[list[dict], tuple | None]:
    stamp = _stamp(path)
    if stamp is None:
        if optional:
            return [], None
        raise WorkSnapshotError("session_missing", "会话记录尚未保存。")
    if stamp[2] > MAX_SNAPSHOT_BYTES:
        raise WorkSnapshotError("snapshot_too_large", "会话记录过大，尚未完成同步。")
    records: list[dict] = []
    try:
        with path.open("rb") as handle:
            while line := handle.readline(MAX_RECORD_BYTES + 2):
                if len(line) > MAX_RECORD_BYTES or not line.endswith(b"\n"):
                    raise WorkSnapshotError("incomplete_history", "会话仍在写入或记录不完整，请稍后同步。")
                if not line.strip():
                    continue
                item = json.loads(line, object_pairs_hook=_unique_object,
                                  parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                if not isinstance(item, dict):
                    raise ValueError("Record is not an object")
                records.append(item)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, WorkSnapshotError):
            raise
        raise WorkSnapshotError("invalid_history", "会话记录不完整，未跳过原文或覆盖云版本。") from None
    if _stamp(path) != stamp:
        raise WorkSnapshotError("history_changed", "会话已变化，请稍后重试同步。")
    return records, stamp


def _metadata(metadata: dict) -> dict:
    result = {key: copy.deepcopy(value) for key, value in metadata.items() if key in _METADATA_FIELDS}
    conversation = _conversation(metadata)
    result["conversation"] = conversation.model_copy(update={
        "active_workflow_id": None, "active_workflow_revision": None,
    }).to_session_metadata()
    result["webui"] = True
    return result


@dataclass(frozen=True)
class WorkExport:
    snapshot: dict[str, Any]
    sources: tuple[WorkFileSource, ...]
    sha256: str

    def bytes(self) -> bytes:
        data = canonical_bytes(self.snapshot)
        if hashlib.sha256(data).hexdigest() != self.sha256:
            raise WorkSnapshotError("snapshot_changed", "同步快照已被修改。")
        return data


def read_work_metadata(manager: SessionManager, key: str) -> dict | None:
    """Inspect saved scope before offering it in settings, without replaying history."""
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        return None
    path = manager.sessions_dir / f"{manager.safe_key(key)}.jsonl"
    try:
        if _stamp(path) is None or not path.resolve().is_relative_to(manager.sessions_dir.resolve()):
            return None
        with path.open("rb") as handle:
            line = handle.readline(MAX_RECORD_BYTES + 1)
        if len(line) > MAX_RECORD_BYTES or not line.endswith(b"\n"):
            return None
        header = json.loads(line, object_pairs_hook=_unique_object)
        if not isinstance(header, dict) or header.get("_type") != "metadata" or header.get("key", key) != key:
            return None
        metadata = header.get("metadata")
        return metadata if is_work_session(key, metadata) else None
    except (OSError, ValueError, TypeError):
        return None


def work_content_fingerprint(snapshot: dict) -> str:
    """Local change detection must not treat downloading a cloud file as editing it."""
    content = dict(snapshot)
    files = snapshot.get("files", [])
    source_paths = {item["source_path"] for item in files if isinstance(item.get("source_path"), str)}
    content["files"] = sorted((
        {key: item[key] for key in ("id", "sha256", "size", "area", "relative_path", "name", "origin") if key in item}
        for item in files
    ), key=lambda item: item["id"])
    content["unavailable_files"] = [item for item in snapshot.get("unavailable_files", [])
        if not (item.get("reason") == "missing" and item.get("source_path") in source_paths)]
    return hashlib.sha256(canonical_bytes(content)).hexdigest()


def export_work_snapshot(manager: SessionManager, key: str, *, vault_id: str, resource_id: str,
                         transcript_path: Path, media_root: Path) -> WorkExport:
    if not ID32.fullmatch(vault_id) or not ID32.fullmatch(resource_id):
        raise WorkSnapshotError("invalid_identity", "云同步标识无效。")
    # Reject Code/CLI/IM keys before opening any file, even when their transcripts
    # are stored by the same SessionManager.
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise WorkSnapshotError("not_work_session", "本期只同步普通工作会话。")
    session_path = manager.sessions_dir / f"{manager.safe_key(key)}.jsonl"
    if not session_path.resolve().is_relative_to(manager.sessions_dir.resolve()):
        raise WorkSnapshotError("invalid_identity", "会话路径无效。")
    records, session_stamp = _read_records(session_path)
    if not records or records[0].get("_type") != "metadata":
        raise WorkSnapshotError("invalid_history", "会话缺少持久化元数据。")
    header, messages = records[0], records[1:]
    metadata = header.get("metadata")
    if header.get("key", key) != key or not is_work_session(key, metadata):
        raise WorkSnapshotError("not_work_session", "该会话不属于可同步的普通工作会话。")
    if any(message.get("_type") == "metadata" for message in messages):
        raise WorkSnapshotError("invalid_history", "会话包含重复元数据，未同步。")
    display, display_stamp = _read_records(transcript_path, optional=True)
    conversation = _conversation(metadata)
    sources, unavailable = collect_work_files(workspace=manager.workspace, media_root=media_root,
        session_key=key, agent_ids=conversation.agent_ids, messages=messages, display=display,
        project_bound=bool(metadata.get("workspace")))
    previous = metadata.get("cloud_history")
    previous_files = {}
    if (isinstance(previous, dict) and previous.get("vault_id") == vault_id
            and previous.get("resource_id") == resource_id):
        for item in previous.get("files", []) if isinstance(previous.get("files"), list) else []:
            try:
                path = restored_file_path(item, workspace=manager.workspace,
                    media_root=media_root, vault_id=vault_id)
                previous_files[str(path)] = item
                if item["area"].startswith("agent_output/") and item["area"].removeprefix("agent_output/") not in conversation.agent_ids:
                    previous_files.pop(str(path), None)
            except (ValueError, TypeError, KeyError):
                continue
    descriptors = []
    normalized_sources = []
    materialized_ids: set[str] = set()
    for source in sources:
        source_path = str(source.root / source.relative_path)
        descriptor = dict(source.descriptor)
        prior = previous_files.get(source_path)
        if prior is not None:
            # Preserve the same logical file when an imported conversation is
            # edited on device B; do not create another identity per device.
            for field in ("id", "area", "relative_path", "name"):
                descriptor[field] = prior[field]
        descriptors.append({**descriptor, "source_path": source_path,
                            "source_relative_path": source.relative_path})
        normalized_sources.append(WorkFileSource(descriptor, source.root, source.relative_path, source.signature, source.anchor))
        materialized_ids.add(descriptor["id"])
    # Not downloading an attachment on device B is not a deletion request.
    for local_path, prior in previous_files.items():
        if prior["id"] in materialized_ids:
            continue
        descriptors.append({**{key: value for key, value in prior.items() if key != "local_path"},
            "source_path": local_path, "availability": "cloud"})
        materialized_ids.add(prior["id"])
    snapshot = {"format": FORMAT, "version": 1, "mode": "work", "vault_id": vault_id,
        "resource_id": resource_id, "source_key": key, "created_at": header.get("created_at"),
        "updated_at": header.get("updated_at"), "metadata": _metadata(metadata),
        "last_consolidated": header.get("last_consolidated", 0), "messages": _rewrite(messages, {}),
        "display": _rewrite(display, {}), "files": descriptors, "unavailable_files": unavailable,
        "runtime_migrated": False}
    validate_work_snapshot(snapshot)
    if _stamp(session_path) != session_stamp or _stamp(transcript_path) != display_stamp:
        raise WorkSnapshotError("history_changed", "会话已变化，请稍后重试同步。")
    return WorkExport(snapshot, tuple(normalized_sources), hashlib.sha256(canonical_bytes(snapshot)).hexdigest())


def validate_work_snapshot(snapshot: Any, *, vault_id: str | None = None,
                           resource_id: str | None = None) -> dict:
    if (not isinstance(snapshot, dict) or snapshot.get("format") != FORMAT
            or type(snapshot.get("version")) is not int or snapshot["version"] != 1
            or snapshot.get("mode") != "work" or snapshot.get("runtime_migrated") is not False):
        raise WorkSnapshotError("invalid_snapshot", "不支持此会话同步格式。")
    for key, expected in (("vault_id", vault_id), ("resource_id", resource_id)):
        value = snapshot.get(key)
        if not isinstance(value, str) or not ID32.fullmatch(value) or expected is not None and expected != value:
            raise WorkSnapshotError("foreign_snapshot", "会话不属于当前云空间或版本。")
    if not is_work_session(snapshot.get("source_key"), snapshot.get("metadata")):
        raise WorkSnapshotError("not_work_session", "开发会话和隐藏任务不参与同步。")
    for date_key in ("created_at", "updated_at"):
        try:
            datetime.fromisoformat(snapshot[date_key])
        except (KeyError, TypeError, ValueError):
            raise WorkSnapshotError("invalid_snapshot", "会话日期无效。") from None
    for field in ("messages", "display"):
        values = snapshot.get(field)
        if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
            raise WorkSnapshotError("invalid_snapshot", "会话记录格式无效。")
        if any(len(canonical_bytes(value)) > MAX_RECORD_BYTES for value in values):
            raise WorkSnapshotError("record_too_large", "会话记录过大，未截断原文。")
    if any(not isinstance(m.get("role"), str) or m["role"] not in {"user", "assistant", "tool", "system"}
           for m in snapshot["messages"]):
        raise WorkSnapshotError("invalid_snapshot", "会话消息角色无效。")
    for message in snapshot["messages"]:
        if message["role"] == "tool" and not isinstance(message.get("tool_call_id"), str):
            raise WorkSnapshotError("invalid_snapshot", "工具结果缺少有效调用标识。")
        if "tool_calls" in message:
            calls = message["tool_calls"]
            if (not isinstance(calls, list) or any(not isinstance(call, dict)
                    or not isinstance(call.get("id"), str) or not call["id"]
                    or not isinstance(call.get("function"), dict)
                    or not isinstance(call["function"].get("name"), str)
                    or not isinstance(call["function"].get("arguments"), (str, dict)) for call in calls)):
                raise WorkSnapshotError("invalid_snapshot", "工具调用记录格式无效。")
    consolidated = snapshot.get("last_consolidated")
    if type(consolidated) is not int or not 0 <= consolidated <= len(snapshot["messages"]):
        raise WorkSnapshotError("invalid_snapshot", "会话摘要位置无效。")
    files = snapshot.get("files")
    agents = set(_conversation(snapshot["metadata"]).agent_ids)
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise WorkSnapshotError("invalid_snapshot", "文件清单无效。")
    ids: set[str] = set()
    for item in files:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not HEX64.fullmatch(item["id"]) or item["id"] in ids):
            raise WorkSnapshotError("invalid_snapshot", "文件清单包含重复或无效记录。")
        try:
            area = item.get("area")
            if isinstance(area, str) and area.startswith("agent_output/") and area.removeprefix("agent_output/") not in agents:
                raise WorkFileError("foreign_owner", "文件不属于会话智能体。")
            restored_file_path(item, workspace=Path("."), media_root=Path("."), vault_id=snapshot["vault_id"])
            portable_path(item.get("relative_path"))
            if "source_relative_path" in item:
                portable_path(item["source_relative_path"])
            if "source_path" in item and not isinstance(item["source_path"], str):
                raise WorkFileError("invalid_path", "文件来源描述无效。")
        except (ValueError, TypeError, KeyError):
            raise WorkSnapshotError("invalid_snapshot", "会话文件清单或归属无效。") from None
        ids.add(item["id"])
    canonical_bytes(snapshot)
    return snapshot


def _rewrite(value: Any, aliases: dict[str, str]) -> Any:
    if isinstance(value, str):
        if value in aliases:
            return aliases[value]
        for source, target in aliases.items():
            if len(source) > 3 and ("/" in source or "\\" in source):
                value = value.replace(f"]({source})", f"]({target})")
        return value
    if isinstance(value, list):
        return [_rewrite(item, aliases) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite(item, aliases) for key, item in value.items() if key.lower() not in _DISPLAY_AUTHORITY_FIELDS}
    return value


def _close_unfinished_calls(messages: list[dict]) -> list[dict]:
    restored = []
    pending: dict[str, dict] = {}

    def close_pending() -> None:
        for call_id in pending:
            restored.append({"role": "tool", "tool_call_id": call_id,
                "content": "此调用的结果尚未包含在同步快照中。本机未执行该操作；请先核对结果，不要自动重跑。",
                "cloud_result_unknown": True})
        pending.clear()

    for message in messages:
        role = message.get("role")
        if role != "tool":
            close_pending()
        elif message.get("tool_call_id") not in pending:
            # Keep unmatched result evidence as history text, not an invalid
            # executable tool-result protocol pair.
            restored.append({"role": "assistant", "content": message.get("content", ""),
                             "cloud_orphan_result": True})
            continue
        restored.append(message)
        if role == "assistant":
            for call in message.get("tool_calls", []) if isinstance(message.get("tool_calls"), list) else []:
                if isinstance(call, dict) and isinstance(call.get("id"), str):
                    pending[call["id"]] = call
        elif role == "tool":
            pending.pop(message.get("tool_call_id"), None)
    close_pending()
    return restored


def _restore_media(record: dict, original: dict, aliases: dict[str, str]) -> None:
    missing = []
    for field in ("media", "media_paths"):
        raw = original.get(field)
        if not isinstance(raw, list):
            continue
        record[field] = [aliases[path] for path in raw if isinstance(path, str) and path in aliases]
        missing.extend(path.replace("\\", "/").rsplit("/", 1)[-1] for path in raw
                       if isinstance(path, str) and path not in aliases)
    if missing:
        record["cloud_unavailable_media"] = list(dict.fromkeys(missing))


@dataclass(frozen=True)
class WorkRestore:
    session: Session
    display: list[dict]
    destinations: dict[str, Path]
    snapshot_sha256: str


def prepare_work_restore(snapshot: dict, *, vault_id: str, resource_id: str,
                         workspace: Path, media_root: Path,
                         target_key: str | None = None) -> WorkRestore:
    """Prepare history and immutable file destinations; caller commits only while idle.

    No account credentials, permission grants, pending inputs, native bindings,
    live Office/SSH/browser sessions or runnable task state are restored.
    """
    validate_work_snapshot(snapshot, vault_id=vault_id, resource_id=resource_id)
    target_key = target_key or f"websocket:{uuid.uuid4()}"
    if not _KEY.fullmatch(target_key):
        raise WorkSnapshotError("not_work_session", "只能恢复到普通工作会话。")
    aliases: dict[str, str] = {}
    destinations = {}
    artifact_targets: dict[tuple[str, str], tuple[dict, Path]] = {}
    for descriptor in snapshot["files"]:
        target = restored_file_path(descriptor, workspace=workspace, media_root=media_root, vault_id=vault_id)
        destinations[descriptor["id"]] = target
        if descriptor["area"].startswith("agent_output/"):
            owner = descriptor["area"].removeprefix("agent_output/")
            artifact_targets[(owner, descriptor["relative_path"])] = (descriptor, target)
            if isinstance(descriptor.get("source_relative_path"), str):
                artifact_targets[(owner, descriptor["source_relative_path"])] = (descriptor, target)
        source = descriptor.get("source_path")
        if isinstance(source, str):
            aliases[source] = str(target)
            aliases[source.replace("\\", "/")] = str(target)
    metadata = _metadata(snapshot["metadata"])
    digest = hashlib.sha256(canonical_bytes(snapshot)).hexdigest()
    metadata["cloud_history"] = {"vault_id": vault_id, "resource_id": resource_id,
        "snapshot_sha256": digest, "source_key": snapshot["source_key"],
        "files": [{**item, "local_path": str(destinations[item["id"]])} for item in snapshot["files"]],
        "unavailable_files": copy.deepcopy(snapshot.get("unavailable_files", []))}
    # Plans and summaries are knowledge, never restored job ownership/approval.
    if isinstance(metadata.get("task_plan"), dict):
        metadata["task_plan"].pop("task_id", None)
    messages = []
    for original in snapshot["messages"]:
        if original.get("_command") or original.get("_ui_only") or original.get("role") == "system":
            continue
        message = {key: copy.deepcopy(value) for key, value in original.items() if key in _MESSAGE_FIELDS}
        message = _rewrite(message, aliases)
        _restore_media(message, original, aliases)
        messages.append(message)
    messages = _close_unfinished_calls(messages)
    session = Session(key=target_key, messages=messages, metadata=metadata,
        created_at=datetime.fromisoformat(snapshot["created_at"]),
        updated_at=datetime.fromisoformat(snapshot["updated_at"]), last_consolidated=0)
    display = []
    for raw in snapshot["display"]:
        record = _rewrite(copy.deepcopy(raw), aliases)
        if raw.get("event") == "user":
            _restore_media(record, raw, aliases)
        field = "files" if raw.get("event") == "deliver_files" else "edits" if raw.get("event") == "file_edit" else None
        if field is not None and isinstance(record.get(field), list):
            for item in record[field]:
                if not isinstance(item, dict):
                    continue
                ref = item.get("artifact_ref")
                ref = ref if isinstance(ref, dict) else {}
                owner = ref.get("owner_id") or ref.get("ownerId")
                relative = ref.get("relative_path") or ref.get("relativePath")
                mapped = artifact_targets.get((owner, relative)) if isinstance(owner, str) and isinstance(relative, str) else None
                if mapped:
                    descriptor, path = mapped
                    root = workspace / "agent-workspaces" / owner / "output"
                    local_relative = path.relative_to(root).as_posix()
                    for old_key in ("ownerKind", "ownerId", "relativePath", "sessionId", "job_id", "workflow_run_id", "workflow_step_id"):
                        ref.pop(old_key, None)
                    ref.update(owner_kind="agent", owner_id=owner, relative_path=local_relative,
                               session_id=target_key, size=descriptor["size"])
                    item.update(artifact_ref=ref, path=local_relative, absolute_path=str(path),
                                name=descriptor["name"], cloud_file_id=descriptor["id"], cloud_only=True)
                elif isinstance(item.get("absolute_path"), str) and item["absolute_path"] in {str(path) for path in destinations.values()}:
                    item["cloud_only"] = True
                else:
                    item.pop("artifact_ref", None)
                    item.pop("absolute_path", None)
                    item.pop("path", None)
                    item["missing"] = True
        if "chat_id" in record:
            record["chat_id"] = target_key.removeprefix("websocket:")
        record["_cloud_history"] = True
        display.append(record)
    return WorkRestore(session, display, destinations, digest)
