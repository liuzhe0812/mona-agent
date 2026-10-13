"""Explicit Work file references, never recursive workspace or project scans."""
from __future__ import annotations

import hashlib
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Callable, Iterable, Iterator

HEX64 = re.compile(r"^[a-f0-9]{64}$")
ID32 = re.compile(r"^[a-f0-9]{32}$")
CHUNK_BYTES = 4 * 1024 * 1024
MAX_FILES = 2048
MAX_FILE_BYTES = 10_000_000_000
_SECRET_NAMES = frozenset({".env", "auth_token", "license.jwt", "credentials.json", "id_rsa", "id_dsa", "id_ed25519", "id_ecdsa"})
_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__", ".ssh", ".codex", ".claude", ".codebuddy", "target"})
_RESERVED_NAME = re.compile(r"^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", re.I)


class WorkFileError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def portable_path(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise WorkFileError("invalid_path", "文件相对路径无效。")
    path = PurePosixPath(value)
    parts = value.split("/")
    if (path.is_absolute() or PureWindowsPath(value).drive or "\\" in value
            or any(part in {"", ".", ".."} or part.endswith((".", " "))
                   or _RESERVED_NAME.match(part) or re.search(r'[<>:"|?*\x00-\x1f]', part)
                   for part in parts)):
        raise WorkFileError("invalid_path", "文件路径无法安全地跨设备使用。")
    return path.as_posix()


def _signature(info: os.stat_result) -> tuple[int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _safe_file(root: Path, relative: str, anchor: Path | None = None) -> tuple[Path, os.stat_result]:
    relative = portable_path(relative)
    if anchor is not None:
        cursor = anchor.resolve(strict=True)
        try:
            directory_parts = root.absolute().relative_to(cursor).parts
        except ValueError:
            raise WorkFileError("outside_sync_scope", "文件目录不属于同步范围。") from None
        for part in directory_parts:
            cursor = cursor / part
            directory_info = cursor.lstat()
            if stat.S_ISLNK(directory_info.st_mode) or getattr(directory_info, "st_file_attributes", 0) & 0x400:
                raise WorkFileError("linked_path", "关联目录包含链接，不自动上传。")
    root_info = root.lstat()
    if stat.S_ISLNK(root_info.st_mode) or getattr(root_info, "st_file_attributes", 0) & 0x400:
        raise WorkFileError("linked_path", "关联目录包含链接，不自动上传。")
    base = root.resolve(strict=True)
    target = base
    for part in PurePosixPath(relative).parts:
        target = target / part
        try:
            info = target.lstat()
        except FileNotFoundError:
            raise WorkFileError("missing", "关联文件尚未在本机可用。") from None
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise WorkFileError("linked_path", "关联文件是链接，不自动上传。")
    if not target.resolve(strict=True).is_relative_to(base) or not stat.S_ISREG(info.st_mode):
        raise WorkFileError("invalid_file", "只同步已关联的普通文件。")
    if info.st_nlink > 1:
        raise WorkFileError("linked_path", "关联文件是硬链接，不自动上传。")
    if info.st_size > MAX_FILE_BYTES:
        raise WorkFileError("file_too_large", "关联文件超过个人空间上限。")
    lowered = [part.casefold() for part in PurePosixPath(relative).parts]
    if (any(part in _SKIP_DIRS for part in lowered[:-1]) or lowered[-1] in _SECRET_NAMES
            or lowered[-1].startswith(".env.") or lowered[-1].endswith((".pem", ".key", ".p12", ".pfx"))):
        raise WorkFileError("excluded_file", "凭据和运行依赖不参与文件同步。")
    return target, info


@dataclass(frozen=True)
class WorkFileSource:
    descriptor: dict[str, Any]
    root: Path
    relative_path: str
    signature: tuple[int, int, int, int]
    anchor: Path | None = None

    def chunks(self, chunk_bytes: int = CHUNK_BYTES) -> Iterator[bytes]:
        if not 1 <= chunk_bytes <= 8 * 1024 * 1024:
            raise ValueError("Invalid chunk size")
        target, before = _safe_file(self.root, self.relative_path, self.anchor)
        if _signature(before) != self.signature:
            raise WorkFileError("file_changed", "关联文件已变化，请重新同步。")
        digest, size = hashlib.sha256(), 0
        with target.open("rb") as handle:
            if _signature(os.fstat(handle.fileno())) != self.signature:
                raise WorkFileError("file_changed", "关联文件已变化，请重新同步。")
            while chunk := handle.read(chunk_bytes):
                size += len(chunk)
                if size > self.descriptor["size"]:
                    raise WorkFileError("file_changed", "关联文件已变化，请重新同步。")
                digest.update(chunk)
                yield chunk
        _, after = _safe_file(self.root, self.relative_path, self.anchor)
        if (_signature(after) != self.signature or size != self.descriptor["size"]
                or digest.hexdigest() != self.descriptor["sha256"]):
            raise WorkFileError("file_changed", "关联文件已变化，请重新同步。")


def collect_work_files(*, workspace: Path, media_root: Path, session_key: str,
                       agent_ids: Iterable[str], messages: list[dict], display: list[dict],
                       project_bound: bool = False) -> tuple[list[WorkFileSource], list[dict]]:
    workspace = workspace.resolve()
    agents = set(agent_ids)
    roots: dict[str, Path] = {"uploads": workspace / "uploads", "media": media_root}
    if not project_bound:
        roots["shared_output"] = workspace / "output"
        roots.update({f"agent_output/{agent}": workspace / "agent-workspaces" / agent / "output" for agent in agents})
    candidates: list[tuple[str, str, str]] = []
    unavailable: list[dict] = []

    def unavailable_file(raw: Any, reason: str, source_path: str | None = None) -> None:
        name = str(raw).replace("\\", "/").rsplit("/", 1)[-1][:255]
        item = {"name": name, "reason": reason}
        if source_path is not None:
            item["source_path"] = source_path
        if item not in unavailable:
            unavailable.append(item)

    def add_path(raw: Any, origin: str) -> None:
        if not isinstance(raw, str) or not raw:
            return
        candidate = Path(raw)
        if not candidate.is_absolute():
            if PureWindowsPath(raw).drive:
                unavailable_file(raw, "other_device_path")
                return
            candidate = workspace / candidate
        for area, root in roots.items():
            # lexical containment first: do not follow a symlink as authority.
            try:
                relative = candidate.absolute().relative_to(root.absolute()).as_posix()
            except ValueError:
                continue
            candidates.append((area, relative, origin))
            return
        unavailable_file(raw, "outside_sync_scope")

    def add_artifact(item: Any, origin: str) -> None:
        if not isinstance(item, dict):
            return
        ref = item.get("artifact_ref")
        if isinstance(ref, dict):
            owner = ref.get("owner_id") or ref.get("ownerId")
            owner_kind = ref.get("owner_kind") or ref.get("ownerKind")
            source_session = ref.get("session_id") or ref.get("sessionId")
            relative = ref.get("relative_path") or ref.get("relativePath")
            if (not isinstance(owner, str) or owner not in agents or owner_kind != "agent"
                    or source_session not in (None, session_key)):
                unavailable_file(relative, "foreign_owner")
                return
            if project_bound:
                unavailable_file(relative, "project_not_synced")
                return
            candidates.append((f"agent_output/{owner}", relative, origin))
        else:
            raw = item.get("absolute_path") or item.get("path")
            if project_bound:
                unavailable_file(raw, "project_not_synced")
            elif isinstance(raw, str) and not Path(raw).is_absolute() and not PureWindowsPath(raw).drive:
                owner = next(iter(agents)) if len(agents) == 1 else None
                if owner:
                    candidates.append((f"agent_output/{owner}", raw, origin))
            else:
                add_path(raw, origin)

    for message in messages:
        if message.get("role") == "user":
            for raw in message.get("media", []) if isinstance(message.get("media"), list) else []:
                add_path(raw, "attachment")
    for record in display:
        event = record.get("event")
        if event == "user":
            for raw in record.get("media_paths", []) if isinstance(record.get("media_paths"), list) else []:
                add_path(raw, "attachment")
        elif event == "deliver_files":
            for item in record.get("files", []) if isinstance(record.get("files"), list) else []:
                add_artifact(item, "delivery")
        elif event == "file_edit":
            for item in record.get("edits", []) if isinstance(record.get("edits"), list) else []:
                if isinstance(item, dict) and item.get("status") == "done":
                    add_artifact(item, "file_edit")
    if len(candidates) > 100_000:
        raise WorkFileError("too_many_files", "关联文件记录过多，请缩小同步范围。")
    sources: list[WorkFileSource] = []
    seen: set[tuple[str, str]] = set()
    for area, relative, origin in candidates:
        try:
            relative = portable_path(relative)
            identity = (area, relative)
            if identity in seen:
                continue
            seen.add(identity)
            anchor = media_root.resolve() if area == "media" else workspace
            target, before = _safe_file(roots[area], relative, anchor)
            digest = hashlib.sha256()
            with target.open("rb") as handle:
                if _signature(os.fstat(handle.fileno())) != _signature(before):
                    raise WorkFileError("file_changed", "文件已变化。")
                while chunk := handle.read(CHUNK_BYTES):
                    digest.update(chunk)
            _, after = _safe_file(roots[area], relative, anchor)
            if _signature(before) != _signature(after):
                raise WorkFileError("file_changed", "文件已变化。")
            file_id = hashlib.sha256(f"{area}/{relative}".encode()).hexdigest()
            descriptor = {"id": file_id, "area": area, "relative_path": relative,
                          "name": target.name, "sha256": digest.hexdigest(), "size": before.st_size,
                          "origin": origin}
            sources.append(WorkFileSource(descriptor, roots[area].resolve(), relative, _signature(before), anchor))
        except (WorkFileError, FileNotFoundError) as exc:
            code = exc.code if isinstance(exc, WorkFileError) else "missing"
            if code == "file_changed":
                raise
            unavailable_file(relative, code, str(roots[area] / relative) if code == "missing" else None)
        if len(sources) > MAX_FILES:
            raise WorkFileError("too_many_files", "关联文件过多，请缩小同步范围。")
    return sources, unavailable


def restored_file_path(descriptor: dict, *, workspace: Path, media_root: Path, vault_id: str) -> Path:
    if not ID32.fullmatch(vault_id):
        raise WorkFileError("invalid_vault", "云空间标识无效。")
    for field in ("id", "sha256"):
        if not isinstance(descriptor.get(field), str) or not HEX64.fullmatch(descriptor[field]):
            raise WorkFileError("invalid_file", "云文件标识无效。")
    name = portable_path(descriptor.get("name"))
    if "/" in name or type(descriptor.get("size")) is not int or not 0 <= descriptor["size"] <= MAX_FILE_BYTES:
        raise WorkFileError("invalid_file", "云文件描述无效。")
    area = descriptor.get("area")
    if area == "media":
        root = media_root
    elif area == "uploads":
        root = workspace / "uploads"
    elif area == "shared_output":
        root = workspace / "output"
    elif isinstance(area, str) and area.startswith("agent_output/"):
        from mona.agent.partners import normalize_agent_id
        agent = normalize_agent_id(area.removeprefix("agent_output/"))
        root = workspace / "agent-workspaces" / agent / "output"
    else:
        raise WorkFileError("invalid_file", "云文件不属于工作文件范围。")
    # Combine logical file and version identities instead of nesting two full
    # digests: the former layout exceeded MAX_PATH in ordinary Windows roots.
    version_key = hashlib.sha256(f"{descriptor['id']}:{descriptor['sha256']}".encode()).hexdigest()
    return root / "cloud" / vault_id / version_key / name


def materialize_work_file(descriptor: dict, chunks: Iterable[bytes], *, workspace: Path,
                          media_root: Path, vault_id: str,
                          before_publish: Callable[[], None] | None = None) -> Path:
    """Publish one verified immutable version. A mismatched existing file is never overwritten."""
    target = restored_file_path(descriptor, workspace=workspace, media_root=media_root, vault_id=vault_id)
    allowed = media_root.resolve() if descriptor["area"] == "media" else workspace.resolve()
    cursor = allowed
    relative = target.absolute().relative_to(allowed).as_posix()
    for part in PurePosixPath(relative).parts[:-1]:
        cursor = cursor / part
        cursor.mkdir(exist_ok=True)
        info = cursor.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400 or not cursor.resolve().is_relative_to(allowed):
            raise WorkFileError("linked_path", "恢复目录包含链接，未写入文件。")
    temporary = allowed / f".sync-{uuid.uuid4().hex}"
    digest, count = hashlib.sha256(), 0
    try:
        with temporary.open("xb") as handle:
            for chunk in chunks:
                if not isinstance(chunk, bytes) or len(chunk) > 8 * 1024 * 1024:
                    raise WorkFileError("invalid_chunk", "云文件分片无效。")
                count += len(chunk)
                if count > descriptor["size"]:
                    raise WorkFileError("size_mismatch", "云文件大小校验失败。")
                digest.update(chunk)
                handle.write(chunk)
            if count != descriptor["size"] or digest.hexdigest() != descriptor["sha256"]:
                raise WorkFileError("hash_mismatch", "云文件内容校验失败。")
            handle.flush()
            os.fsync(handle.fileno())
        if before_publish is not None:
            before_publish()
        if target.exists() or target.is_symlink():
            existing, info = _safe_file(allowed, relative)
            if info.st_size != count:
                raise WorkFileError("restore_conflict", "本机同版本文件已变化，未覆盖。")
            existing_hash = hashlib.sha256()
            with existing.open("rb") as handle:
                while chunk := handle.read(CHUNK_BYTES):
                    existing_hash.update(chunk)
            if existing_hash.hexdigest() != descriptor["sha256"]:
                raise WorkFileError("restore_conflict", "本机同版本文件已变化，未覆盖。")
        else:
            # Exclusive publication rather than replace: do not overwrite a
            # concurrently created local file even after the existence check.
            os.link(temporary, target)
        return target
    finally:
        temporary.unlink(missing_ok=True)
