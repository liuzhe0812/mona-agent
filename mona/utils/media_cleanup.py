"""Conservative reclamation of duplicate WebSocket preview copies."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import stat
import threading
from pathlib import Path
from typing import Any

from loguru import logger

from mona.utils.media_store import stage_media_file

_LEGACY_PREVIEW = re.compile(r"^[0-9a-f]{12}-.+")
_BLOB = re.compile(r"^sha256-[0-9a-f]{64}(?:\.[a-z0-9]+)?$")
_FILE_ID = re.compile(r"sha256-[0-9a-f]{64}|[0-9a-f]{12}-")
_MEDIA_URL = re.compile(r"/api/media/[A-Za-z0-9_-]+/([A-Za-z0-9_-]+)")


class MediaCleanupState:
    """Keep media issued to live clients out of background reclamation."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.paths: set[Path] = set()
        self.stopped = threading.Event()

    def protect(self, path: Path) -> None:
        if _LEGACY_PREVIEW.fullmatch(path.name):
            with self.lock:
                self.paths.add(path.resolve())


def _fingerprint(path: Path) -> tuple[int, ...]:
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise OSError(f"not a regular media/reference file: {path}")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _reference_files(roots: list[Path]) -> dict[Path, tuple[int, ...]]:
    files: dict[Path, tuple[int, ...]] = {}
    for root in roots:
        if not root.exists():
            continue
        if root.is_symlink():
            raise OSError(f"linked reference directory: {root}")
        for path in root.iterdir():
            if path.suffix.lower() in {".json", ".jsonl"}:
                files[path] = _fingerprint(path)
    return files


def _referenced_ids(files: dict[Path, tuple[int, ...]]) -> set[str]:
    referenced: set[str] = set()

    def collect(value: Any) -> None:
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, str):
                # Protect even paths embedded in tool output or free-form text.
                referenced.update(_FILE_ID.findall(item))
                for match in _MEDIA_URL.finditer(item):
                    payload = match[1]
                    try:
                        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
                        referenced.update(_FILE_ID.findall(decoded.decode("utf-8")))
                    except (ValueError, UnicodeError, binascii.Error) as exc:
                        raise ValueError("unreadable persisted media URL") from exc

    for path in files:
        with path.open(encoding="utf-8") as stream:
            if path.suffix.lower() == ".jsonl":
                for line in stream:
                    if line.strip():
                        collect(json.loads(line))
            else:
                collect(json.load(stream))
    return referenced


def cleanup_duplicate_websocket_media(
    media_dir: Path, reference_roots: list[Path], state: MediaCleanupState | None = None,
) -> dict[str, int]:
    """Remove only unreferenced duplicate previews, never the last content copy.

    Legacy uploads (UUID without a dash), unknown files, links and all
    persisted path/URL references survive. Live clients protect issued paths.
    An incomplete reference scan aborts reclamation rather than guessing.
    """
    result = {"removed_files": 0, "reclaimed_bytes": 0}
    state = state or MediaCleanupState()
    if not media_dir.exists():
        return result
    if media_dir.is_symlink() or media_dir.resolve() != media_dir.parent.resolve() / media_dir.name:
        raise OSError(f"linked media directory: {media_dir}")
    root = media_dir.resolve()
    by_size: dict[int, list[tuple[Path, tuple[int, ...]]]] = {}
    for path in root.iterdir():
        if state.stopped.is_set():
            return result
        if not (_LEGACY_PREVIEW.fullmatch(path.name) or _BLOB.fullmatch(path.name)):
            continue
        if path.is_symlink() or path.resolve().parent != root:
            continue
        try:
            fingerprint = _fingerprint(path)
        except OSError:
            continue
        by_size.setdefault(fingerprint[2], []).append((path, fingerprint))
    candidates = [
        group for group in by_size.values()
        if len(group) > 1 and any(_LEGACY_PREVIEW.fullmatch(path.name) for path, _ in group)
    ]
    if not candidates:
        return result

    duplicates: list[list[tuple[Path, tuple[int, ...]]]] = []
    for group in candidates:
        by_hash: dict[tuple[str, str], list[tuple[Path, tuple[int, ...]]]] = {}
        for path, fingerprint in group:
            if state.stopped.is_set():
                return result
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if _fingerprint(path) != fingerprint:
                raise OSError(f"media changed during duplicate scan: {path}")
            by_hash.setdefault((digest, path.suffix.lower()), []).append((path, fingerprint))
        duplicates.extend(items for items in by_hash.values() if len(items) > 1)

    references = _reference_files(reference_roots)
    referenced = _referenced_ids(references)
    if _reference_files(reference_roots) != references:
        raise OSError("conversation references changed during media scan")
    for group in duplicates:
        if state.stopped.is_set():
            return result
        # Prefer a referenced copy, then a canonical blob, then a stable legacy name.
        group.sort(key=lambda item: (
            _FILE_ID.match(item[0].name)[0] not in referenced,
            not item[0].name.startswith("sha256-"),
            item[0].name,
        ))
        keeper, keeper_fingerprint = group[0]
        with state.lock:
            disposable = [
                (path, fingerprint) for path, fingerprint in group
                if _LEGACY_PREVIEW.fullmatch(path.name)
                and _FILE_ID.match(path.name)[0] not in referenced
                and path not in state.paths
            ]
        if not disposable:
            continue
        if _fingerprint(keeper) != keeper_fingerprint:
            raise OSError("media changed before duplicate migration")
        # Promote the surviving bytes to the same cache used by future replays.
        # Never rename a legacy file: existing signed URLs keep their paths.
        canonical = stage_media_file(keeper, root)
        if _fingerprint(keeper) != keeper_fingerprint:
            raise OSError("media changed during duplicate migration")
        keeper, keeper_fingerprint = canonical, _fingerprint(canonical)
        added_bytes = keeper_fingerprint[2] if all(path != canonical for path, _ in group) else 0
        result["reclaimed_bytes"] -= added_bytes
        for path, fingerprint in disposable:
            with state.lock:
                if state.stopped.is_set():
                    return result
                if path in state.paths:
                    continue
                if path.resolve().parent != root or keeper.resolve().parent != root:
                    raise OSError("media escaped its directory during duplicate scan")
                if _fingerprint(keeper) != keeper_fingerprint or _fingerprint(path) != fingerprint:
                    raise OSError("media changed before duplicate removal")
                path.unlink()
                result["removed_files"] += 1
                result["reclaimed_bytes"] += fingerprint[2]
    if result["removed_files"]:
        logger.info("WebSocket media cleanup: removed {} duplicate files, reclaimed {} bytes",
                    result["removed_files"], result["reclaimed_bytes"])
    return result
