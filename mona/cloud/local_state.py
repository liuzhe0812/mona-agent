"""Device-local sync positions and recoverable two-file history replacement."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from mona.cloud.transfer import CloudTransferError
from mona.cloud.work_snapshot import (
    MAX_SNAPSHOT_BYTES,
    WorkRestore,
    canonical_bytes,
    is_work_session,
)
from mona.session.manager import SessionManager


def atomic_bytes(path: Path, value: bytes | None) -> None:
    if value is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".cloud-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def existing_bytes(path: Path) -> bytes | None:
    if path.is_symlink():
        raise CloudTransferError("local_history_link", "会话存储目录存在链接，同步已暂停。")
    if not path.exists():
        return None
    if path.stat().st_size > MAX_SNAPSHOT_BYTES:
        raise CloudTransferError("local_history_size", "会话记录过大，未替换本地内容。")
    return path.read_bytes()


def digest(value: bytes | None) -> str | None:
    return hashlib.sha256(value).hexdigest() if value is not None else None


class LocalCloudStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS sync_positions (
                    vault TEXT NOT NULL, resource TEXT NOT NULL, local_key TEXT NOT NULL UNIQUE,
                    local_digest TEXT NOT NULL, version TEXT, conflict_of TEXT,
                    PRIMARY KEY(vault,resource));
                CREATE TABLE IF NOT EXISTS sync_cursors (vault TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS history_journal (
                    local_key TEXT PRIMARY KEY, old_session BLOB, old_display BLOB,
                    new_session_hash TEXT NOT NULL, new_display_hash TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS download_observations (
                    account TEXT NOT NULL, period TEXT NOT NULL, received_bytes INTEGER NOT NULL,
                    complete_downloads INTEGER NOT NULL, incomplete_downloads INTEGER NOT NULL,
                    PRIMARY KEY(account, period));
            """)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def mappings(self, vault: str) -> list[dict]:
        with self.connection() as db:
            rows = db.execute("SELECT * FROM sync_positions WHERE vault=?", (vault,)).fetchall()
        return [{**dict(row), "version": json.loads(row["version"]) if row["version"] else None} for row in rows]

    def owners(self) -> dict[str, str]:
        with self.connection() as db:
            return dict(db.execute("SELECT local_key,vault FROM sync_positions").fetchall())

    def record_download(self, account: str, received_bytes: int, complete: bool) -> None:
        period = datetime.now(timezone.utc).strftime("%Y-%m")
        with self.connection() as db:
            db.execute("""INSERT INTO download_observations VALUES(?,?,?,?,?)
                ON CONFLICT(account,period) DO UPDATE SET
                received_bytes=received_bytes+excluded.received_bytes,
                complete_downloads=complete_downloads+excluded.complete_downloads,
                incomplete_downloads=incomplete_downloads+excluded.incomplete_downloads""",
                (account, period, received_bytes, int(complete), int(not complete)))

    def download_usage(self, account: str) -> dict:
        period = datetime.now(timezone.utc).strftime("%Y-%m")
        with self.connection() as db:
            row = db.execute("SELECT * FROM download_observations WHERE account=? AND period=?",
                             (account, period)).fetchone()
        return {"period": period, "period_timezone": "UTC", "source": "client_observed",
                **{key: row[key] if row else 0 for key in (
                    "received_bytes", "complete_downloads", "incomplete_downloads")}}

    @staticmethod
    def _put(db, vault: str, resource: str, local_key: str, local_digest: str,
             version: dict | None, conflict_of: str | None = None):
        db.execute("""INSERT INTO sync_positions VALUES(?,?,?,?,?,?)
            ON CONFLICT(vault,resource) DO UPDATE SET local_key=excluded.local_key,
            local_digest=excluded.local_digest, version=excluded.version, conflict_of=excluded.conflict_of""",
            (vault, resource, local_key, local_digest, json.dumps(version) if version else None, conflict_of))

    def put(self, vault: str, resource: str, local_key: str, local_digest: str,
            version: dict | None, conflict_of: str | None = None) -> None:
        with self.connection() as db:
            self._put(db, vault, resource, local_key, local_digest, version, conflict_of)

    def cursor(self, vault: str, value: int | None = None) -> int:
        with self.connection() as db:
            if value is not None:
                db.execute("INSERT INTO sync_cursors VALUES(?,?) ON CONFLICT(vault) DO UPDATE SET cursor=excluded.cursor", (vault, value))
            row = db.execute("SELECT cursor FROM sync_cursors WHERE vault=?", (vault,)).fetchone()
            return row[0] if row else 0

    def _rollback(self, row: dict, manager: SessionManager, display_path: Path) -> None:
        session_path = manager.sessions_dir / f"{manager.safe_key(row['local_key'])}.jsonl"
        pairs = [(session_path, row["old_session"], row["new_session_hash"]),
                 (display_path, row["old_display"], row["new_display_hash"])]
        for path, old, expected in pairs:
            if digest(existing_bytes(path)) not in (digest(old), expected):
                raise CloudTransferError("recovery_conflict", "恢复期间本地会话出现新修改，已保留两份记录，未覆盖。")
        for path, old, _ in pairs:
            atomic_bytes(path, old)
        manager.invalidate(row["local_key"])
        with self.connection() as db:
            db.execute("DELETE FROM history_journal WHERE local_key=?", (row["local_key"],))

    def recover(self, manager: SessionManager, transcript_for: Callable[[str], Path]) -> None:
        with self.connection() as db:
            rows = db.execute("SELECT * FROM history_journal").fetchall()
        for row in rows:
            if not is_work_session(row["local_key"], {}):
                raise CloudTransferError("invalid_journal", "本地同步恢复记录无效，未修改会话。")
            self._rollback(dict(row), manager, transcript_for(row["local_key"]))

    def apply(self, manager: SessionManager, restore: WorkRestore, display_path: Path, *,
              vault: str, resource: str, version: dict, local_digest: Callable[[], str],
              fork_local_to: str | None = None, source_resource: str | None = None) -> str:
        key = restore.session.key
        if not is_work_session(key, restore.session.metadata):
            raise CloudTransferError("not_work_session", "不能恢复为开发或隐藏会话。")
        session_path = manager.sessions_dir / f"{manager.safe_key(key)}.jsonl"
        header = {"_type": "metadata", "key": key,
            "created_at": restore.session.created_at.isoformat(), "updated_at": restore.session.updated_at.isoformat(),
            "metadata": restore.session.metadata, "last_consolidated": restore.session.last_consolidated}
        new_session = b"".join(canonical_bytes(item) + b"\n" for item in [header, *restore.session.messages])
        new_display = b"".join(canonical_bytes(item) + b"\n" for item in restore.display)
        journal = {"local_key": key, "old_session": existing_bytes(session_path), "old_display": existing_bytes(display_path),
                   "new_session_hash": digest(new_session), "new_display_hash": digest(new_display)}
        with self.connection() as db:
            db.execute("INSERT INTO history_journal VALUES(:local_key,:old_session,:old_display,:new_session_hash,:new_display_hash)", journal)
        try:
            atomic_bytes(display_path, new_display)
            atomic_bytes(session_path, new_session)
            manager.invalidate(key)
            applied_digest = local_digest()
            with self.connection() as db:
                if fork_local_to:
                    db.execute("""UPDATE sync_positions SET resource=?,local_digest='',conflict_of=?
                        WHERE vault=? AND resource=?""", (fork_local_to, resource, vault, resource))
                self._put(db, vault, resource, key, applied_digest, version, source_resource)
                db.execute("DELETE FROM history_journal WHERE local_key=?", (key,))
            return applied_digest
        except BaseException:
            self._rollback(journal, manager, display_path)
            raise
