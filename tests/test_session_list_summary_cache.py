"""Persistent summaries keep legacy session-list reads off transcript bodies."""

import builtins
import json
import os
from pathlib import Path
from typing import Any

from mona.session.manager import SessionManager


def _write_legacy_session(
    manager: SessionManager,
    key: str,
    messages: list[dict[str, Any]],
) -> Path:
    path = manager.sessions_dir / f"{manager.safe_key(key)}.jsonl"
    records = [
        {
            "_type": "metadata",
            "key": key,
            "created_at": "2026-01-01T00:00:00",
            "updated_at": "2026-01-01T00:00:00",
            "metadata": {"title": "Legacy task"},
        },
        *messages,
    ]
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    return path


def _track_session_body_reads(monkeypatch, path: Path) -> dict[str, int]:
    counts = {"readline": 0, "read": 0, "readlines": 0, "iterations": 0, "body_lines": 0}
    original_open = builtins.open

    class CountingReader:
        def __init__(self, stream):
            self._stream = stream

        def __enter__(self):
            self._stream.__enter__()
            return self

        def __exit__(self, *args):
            return self._stream.__exit__(*args)

        def readline(self, *args, **kwargs):
            counts["readline"] += 1
            return self._stream.readline(*args, **kwargs)

        def read(self, *args, **kwargs):
            counts["read"] += 1
            return self._stream.read(*args, **kwargs)

        def readlines(self, *args, **kwargs):
            counts["readlines"] += 1
            return self._stream.readlines(*args, **kwargs)

        def __iter__(self):
            counts["iterations"] += 1
            return self

        def __next__(self):
            counts["body_lines"] += 1
            return next(self._stream)

        def __getattr__(self, name):
            return getattr(self._stream, name)

    def tracking_open(file, mode="r", *args, **kwargs):
        stream = original_open(file, mode, *args, **kwargs)
        if isinstance(file, (str, os.PathLike)) and Path(file) == path and "r" in mode:
            return CountingReader(stream)
        return stream

    monkeypatch.setattr(builtins, "open", tracking_open)
    return counts


def _legacy_message(role: str, content: str, timestamp: str) -> dict[str, str]:
    return {"role": role, "content": content, "timestamp": timestamp}


def test_legacy_list_summary_persists_without_rewriting_transcript_and_skips_body_on_restart(
    tmp_path,
    monkeypatch,
):
    manager = SessionManager(tmp_path)
    key = "websocket:legacy-summary"
    path = _write_legacy_session(
        manager,
        key,
        [
            _legacy_message("user", "An earlier request", "2026-01-01T00:01:00"),
            _legacy_message("assistant", "Latest visible reply", "2026-01-01T00:02:00"),
        ],
    )
    original_bytes = path.read_bytes()

    rows = manager.list_sessions()
    assert rows[0]["preview"] == "Latest visible reply"
    manager.persist_list_summaries()
    assert path.read_bytes() == original_bytes

    restored = SessionManager(tmp_path)
    counts = _track_session_body_reads(monkeypatch, path)
    restored_rows = restored.list_sessions()

    assert restored_rows[0]["preview"] == "Latest visible reply"
    assert counts == {"readline": 1, "read": 0, "readlines": 0, "iterations": 0, "body_lines": 0}
    assert path.read_bytes() == original_bytes


def test_changed_session_mtime_and_size_rebuilds_preview(tmp_path):
    manager = SessionManager(tmp_path)
    key = "websocket:changed-summary"
    path = _write_legacy_session(
        manager,
        key,
        [_legacy_message("user", "Old preview", "2026-01-01T00:01:00")],
    )
    assert manager.list_sessions()[0]["preview"] == "Old preview"
    manager.persist_list_summaries()
    old_stat = path.stat()

    _write_legacy_session(
        manager,
        key,
        [_legacy_message("user", "Updated preview after transcript edit", "2026-01-02T00:01:00")],
    )
    os.utime(path, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns + 1_000_000_000))
    new_stat = path.stat()
    assert new_stat.st_mtime_ns != old_stat.st_mtime_ns
    assert new_stat.st_size != old_stat.st_size

    restored = SessionManager(tmp_path)
    assert restored.list_sessions()[0]["preview"] == "Updated preview after transcript edit"
    restored.persist_list_summaries()


def test_empty_summary_is_persisted_and_does_not_rescan_after_restart(tmp_path, monkeypatch):
    manager = SessionManager(tmp_path)
    key = "websocket:empty-summary"
    path = _write_legacy_session(
        manager,
        key,
        [
            _legacy_message("system", "System-only transcript row", "2026-01-01T00:01:00"),
            _legacy_message("tool", "Tool-only transcript row", "2026-01-01T00:02:00"),
        ],
    )

    rows = manager.list_sessions()
    assert rows[0]["preview"] == ""
    manager.persist_list_summaries()

    restored = SessionManager(tmp_path)
    counts = _track_session_body_reads(monkeypatch, path)
    restored_rows = restored.list_sessions()

    assert restored_rows[0]["preview"] == ""
    assert counts == {"readline": 1, "read": 0, "readlines": 0, "iterations": 0, "body_lines": 0}


def test_corrupt_derived_cache_rebuilds_list_and_is_repaired_by_persist(tmp_path):
    manager = SessionManager(tmp_path)
    key = "websocket:corrupt-summary-cache"
    _write_legacy_session(
        manager,
        key,
        [_legacy_message("user", "Recoverable preview", "2026-01-01T00:01:00")],
    )
    assert manager.list_sessions()[0]["preview"] == "Recoverable preview"
    manager.persist_list_summaries()

    cache_path = manager.sessions_dir / ".list-summaries.json"
    cache_path.write_text("{truncated", encoding="utf-8")
    restored = SessionManager(tmp_path)

    rows = restored.list_sessions()
    assert rows[0]["preview"] == "Recoverable preview"
    restored.persist_list_summaries()

    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cache["schema_version"] == 1
    assert isinstance(cache["sessions"], dict)
    assert "websocket:corrupt-summary-cache" in {row["key"] for row in rows}


def test_deleted_session_summary_is_removed_from_disk_and_cannot_be_resurrected(tmp_path):
    manager = SessionManager(tmp_path)
    key = "websocket:deleted-summary"
    path = _write_legacy_session(
        manager,
        key,
        [_legacy_message("user", "Private preview to remove", "2026-01-01T00:01:00")],
    )
    cache_path = manager.sessions_dir / ".list-summaries.json"

    assert manager.list_sessions()[0]["preview"] == "Private preview to remove"
    manager.persist_list_summaries()
    assert json.loads(cache_path.read_text(encoding="utf-8"))["sessions"][path.name]["summary"]["preview"] == (
        "Private preview to remove"
    )

    assert manager.delete_session(key)
    assert not path.exists()
    assert not cache_path.exists()

    manager.persist_list_summaries()
    assert manager.list_sessions() == []
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert cache["sessions"] == {}
    assert "Private preview to remove" not in json.dumps(cache)

    restored = SessionManager(tmp_path)
    assert restored.list_sessions() == []
