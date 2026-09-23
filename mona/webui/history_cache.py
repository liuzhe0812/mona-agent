"""Rebuildable, paged display history. JSONL remains the authoritative record."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, unquote

from loguru import logger

from mona.config.paths import get_conversation_history_dir
from mona.webui.transcript import (
    WEBUI_TRANSCRIPT_SCHEMA_VERSION,
    _infer_media_kind,
    _resolve_legacy_artifact_paths,
    compact_transcript_object,
    replay_transcript_to_ui_messages,
    webui_transcript_path,
)

_CACHE_VERSION = 1  # Bump when the persisted display projection changes.
_MEDIA_PREFIX = "mona-history-media:"
_locks_guard = threading.Lock()
_locks: dict[str, Any] = {}


class HistoryRevisionChangedError(ValueError):
    """A page cursor belongs to a different source snapshot."""


def _cache_key(session_key: str) -> str:
    source = webui_transcript_path(session_key)
    return hashlib.sha256(str(source.resolve()).encode("utf-8")).hexdigest()


def thread_history_lock(session_key: str) -> Any:
    with _locks_guard:
        return _locks.setdefault(_cache_key(session_key), threading.RLock())


def delete_cached_thread(session_key: str) -> None:
    with thread_history_lock(session_key):
        path = get_conversation_history_dir() / "display" / f"{_cache_key(session_key)}.sqlite3"
        path.unlink(missing_ok=True)


def _signature(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}"


def _media_refs(paths: list[str], revision: str) -> list[dict[str, str]]:
    # Sign only the selected page, with the current process's media secret.
    return [
        {"kind": _infer_media_kind(Path(path).name, path),
         "name": Path(path).name, "url": _MEDIA_PREFIX + revision + ":" + quote(path, safe="")}
        for path in paths
    ]


def _hydrate_media(
    messages: list[dict[str, Any]],
    augment: Callable[[list[str]], list[dict[str, Any]]] | None,
    revision: str,
) -> None:
    prefix = _MEDIA_PREFIX + revision + ":"
    resolved: dict[str, dict[str, Any] | None] = {}
    for message in messages:
        for field in ("images", "media"):
            if not isinstance(message.get(field), list):
                continue
            hydrated = []
            for media in message[field]:
                url = media.get("url", "") if isinstance(media, dict) else ""
                if not isinstance(url, str) or not url.startswith(_MEDIA_PREFIX):
                    hydrated.append(media)
                    continue
                if not url.startswith(prefix):
                    # An ordinary recorded URL cannot grant filesystem access.
                    continue
                if url not in resolved:
                    path = unquote(url[len(prefix):])
                    signed = augment([path]) if augment else []
                    resolved[url] = signed[0] if signed else None
                signed_media = resolved[url]
                if signed_media is not None:
                    hydrated.append({**media, **signed_media})
            message[field] = hydrated


def _read_snapshot(path: Path) -> list[dict[str, Any]]:
    records = []
    # Bound the read to the file size at open, even while a reply is streaming.
    with path.open("rb") as stream:
        remaining = os.fstat(stream.fileno()).st_size
        while remaining > 0:
            raw = stream.readline(remaining)
            if not raw:
                break
            remaining -= len(raw)
            if not raw.strip():
                continue
            try:
                record = json.loads(raw)
            except (ValueError, UnicodeError):
                logger.warning("Skipped malformed WebUI history record")
                continue
            if isinstance(record, dict):
                records.append(compact_transcript_object(record))
    return records


def _annotate_ordinals(messages: list[dict[str, Any]]) -> None:
    ordinal = 0
    for position, message in enumerate(messages):
        message["historyPosition"] = position
        if (message.get("role") == "assistant"
                and message.get("kind") not in {"trace", "workflowRun", "discussion"}
                and str(message.get("content") or "").strip()):
            ordinal += 1
            message["assistantOrdinal"] = ordinal


def _write_cache(
    path: Path, signature: str, revision: str, messages: list[dict[str, Any]],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.stem + ".", suffix=".tmp", dir=path.parent)
    os.close(descriptor)
    try:
        with closing(sqlite3.connect(temporary)) as connection, connection:
            connection.execute("CREATE TABLE metadata (version INTEGER, signature TEXT, revision TEXT, total INTEGER)")
            connection.execute("CREATE TABLE messages (position INTEGER PRIMARY KEY, role TEXT, payload TEXT)")
            connection.execute("INSERT INTO metadata VALUES (?, ?, ?, ?)",
                               (_CACHE_VERSION, signature, revision, len(messages)))
            connection.executemany("INSERT INTO messages VALUES (?, ?, ?)", (
                (index, message.get("role"), json.dumps(message, ensure_ascii=False, separators=(",", ":")))
                for index, message in enumerate(messages)
            ))
        # A closed connection is required for atomic replacement on Windows.
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _read_page(
    path: Path, signature: str, limit: int | None, before: int | None,
    revision: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]] | None:
    if not path.is_file():
        return None
    connection = sqlite3.connect(path)
    try:
        metadata = connection.execute("SELECT version, signature, revision, total FROM metadata").fetchone()
        if not metadata or metadata[:2] != (_CACHE_VERSION, signature):
            return None
        _, _, current_revision, total = metadata
        if revision is not None and revision != current_revision:
            raise HistoryRevisionChangedError("History changed; reload the latest page")
        end = min(before, total) if before is not None else total
        start = max(0, end - limit) if limit is not None else 0
        # Include the beginning of a nearby turn without unbounded expansion.
        if start:
            row = connection.execute(
                "SELECT MAX(position) FROM messages WHERE role = 'user' AND position BETWEEN ? AND ?",
                (max(0, start - (limit or 0)), start),
            ).fetchone()
            if row and row[0] is not None:
                start = row[0]
        messages = [json.loads(row[0]) for row in connection.execute(
            "SELECT payload FROM messages WHERE position >= ? AND position < ? ORDER BY position",
            (start, end),
        )]
        return messages, {"hasMore": start > 0, "before": start if start else None,
                          "revision": current_revision, "total": total}
    finally:
        connection.close()


def build_cached_thread_response(
    session_key: str, *, limit: int | None = None, before: int | None = None,
    revision: str | None = None,
    augment_user_media: Callable[[list[str]], list[dict[str, Any]]] | None = None,
) -> dict[str, Any] | None:
    if limit is not None and not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    if before is not None and (before < 0 or not revision):
        raise ValueError("before requires a non-negative offset and a revision")
    source = webui_transcript_path(session_key)
    if not source.is_file():
        return None
    cache_key = _cache_key(session_key)
    cache = get_conversation_history_dir() / "display" / f"{cache_key}.sqlite3"
    started = time.perf_counter()
    hit = False
    read_ms = replay_ms = 0.0
    with thread_history_lock(session_key):
        if not source.is_file():
            return None
        signature = _signature(source)
        try:
            page = _read_page(cache, signature, limit, before, revision)
        except (sqlite3.DatabaseError, json.JSONDecodeError):
            logger.warning("Rebuilding invalid WebUI display cache {}", cache_key[:12])
            page = None
        hit = page is not None
        if page is None:
            if revision is not None:
                raise HistoryRevisionChangedError("History changed; reload the latest page")
            read_started = time.perf_counter()
            records = _read_snapshot(source)
            read_ms = (time.perf_counter() - read_started) * 1000
            if not records:
                return None
            current_revision = uuid.uuid4().hex
            replay_started = time.perf_counter()
            messages = replay_transcript_to_ui_messages(
                records, augment_user_media=lambda paths: _media_refs(paths, current_revision),
            )
            _annotate_ordinals(messages)
            replay_ms = (time.perf_counter() - replay_started) * 1000
            if signature == _signature(source):
                try:
                    _write_cache(cache, signature, current_revision, messages)
                    page = _read_page(cache, signature, limit, before, None)
                except (OSError, sqlite3.DatabaseError) as error:
                    logger.warning("WebUI display cache unavailable: {}", type(error).__name__)
            if page is None:
                # An active append or an unavailable cache must not hide history.
                end = len(messages)
                start = max(0, end - limit) if limit is not None else 0
                page = messages[start:end], {"hasMore": start > 0, "before": start or None,
                                            "revision": current_revision, "total": end}
    messages, pagination = page
    _hydrate_media(messages, augment_user_media, pagination["revision"])
    _resolve_legacy_artifact_paths(messages)
    elapsed_ms = (time.perf_counter() - started) * 1000
    log = logger.info if elapsed_ms >= 500 else logger.debug
    log("WebUI history cache_hit={} rows={}/{} read_ms={:.1f} replay_ms={:.1f} total_ms={:.1f}",
        hit, len(messages), pagination["total"], read_ms, replay_ms, elapsed_ms)
    return {"schemaVersion": WEBUI_TRANSCRIPT_SCHEMA_VERSION, "sessionKey": session_key,
            "messages": messages, "pagination": pagination}
