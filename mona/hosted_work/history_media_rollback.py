"""Offline, lossless conversion before rolling back to a pre-media release.

This does not restore an old database or remove any media or billing record.
The caller must stop Work; active/unknown operations block the conversion.
"""
from __future__ import annotations

import argparse
import json
import re
from contextlib import ExitStack
from pathlib import Path

from filelock import FileLock

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.store import WorkStore, encoded

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_REFERENCE = "mona-history-media:"


def restore_for_legacy(store: WorkStore) -> dict[str, int]:
    """Restore exact data URLs in one transaction; leave blob and billing tables intact."""
    changed = {"sessions": 0, "runs": 0, "conversation_context": 0}
    with store.transaction():
        if (store.db.execute("SELECT 1 FROM runs WHERE status IN ('running','cancelling','unknown') LIMIT 1").fetchone()
                or store.db.execute("SELECT 1 FROM workspace_operations WHERE status IN ('running','unknown') LIMIT 1").fetchone()):
            raise WorkError("work_busy", "仍有任务或文件操作待核对，不能回退。", 409)
        result_table = store.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_tool_results'").fetchone()
        referenced = any(store.db.execute(f"SELECT 1 FROM {table} WHERE {column} LIKE ? LIMIT 1",
                                          ("%mona-tool-result://%",)).fetchone()
                         for table, column in (("sessions", "history"), ("runs", "checkpoint"),
                                               ("conversation_context", "state")))
        if referenced or result_table and store.db.execute("SELECT 1 FROM hosted_tool_results LIMIT 1").fetchone():
            raise WorkError("legacy_tool_results", "旧版本无法读取已保存的工具结果，不能自动回退。", 409)
        tables = (("sessions", "id", "history"), ("runs", "id", "checkpoint"),
                  ("conversation_context", "session_id", "state"))
        for table, identity, column in tables:
            rows = store.db.execute(f"SELECT owner,{identity},{column} FROM {table} WHERE {column} LIKE ?",
                                    (f"%{_REFERENCE}%",)).fetchall()
            for row in rows:
                owner, record_id, raw = row
                restored = store._restore_media(owner, json.loads(raw))
                data = encoded(restored)
                if (len(data.encode()) > store.config.max_history_bytes
                        or table == "sessions" and len(json.dumps(restored).encode()) > store.config.max_history_bytes):
                    # Old Work enforces this limit on expanded JSON. Do not
                    # switch to it when it cannot consume the restored data.
                    raise WorkError("legacy_history_limit", "旧版本无法安全读取现有会话数据，不能自动回退。", 409)
                store.db.execute(f"UPDATE {table} SET {column}=? WHERE owner=? AND {identity}=?",
                                 (data, owner, record_id))
                changed[table] += 1
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    raw = json.loads(args.config.read_text(encoding="utf-8"))
    config = HostedWorkConfig.model_validate(raw.get("hosted_work", raw.get("hostedWork", {})))
    root = Path(config.state_dir).resolve(strict=True)
    database = root / "sessions.sqlite3"
    if not database.is_file() or database.is_symlink():
        raise SystemExit("Existing hosted state database is required.")
    with ExitStack() as locks:
        locks.enter_context(FileLock(str(root / "service.lock"), timeout=0))
        users = root / "users"
        if users.exists():
            if users.is_symlink() or not users.is_dir():
                raise SystemExit("Invalid hosted user directory.")
            for user in users.iterdir():
                if not _OWNER.fullmatch(user.name):
                    continue
                if user.is_symlink() or not user.is_dir():
                    raise SystemExit("Invalid hosted user directory.")
                lock = user / "execution.lock"
                if lock.is_symlink():
                    raise SystemExit("Invalid execution lock.")
                if lock.exists():
                    locks.enter_context(FileLock(str(lock), timeout=0))
        store = WorkStore(database, config)
        try:
            print(json.dumps({"restored": restore_for_legacy(store), "media_deleted": False}, ensure_ascii=False))
        finally:
            store.close()


if __name__ == "__main__":
    main()
