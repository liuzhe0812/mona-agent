"""Small durable online session store. No desktop data or credentials are stored here."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, identifier


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class WorkStore:
    def __init__(self, path: Path, config: HostedWorkConfig):
        self.config = config
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS sessions (
                owner TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
                initial_title TEXT NOT NULL DEFAULT '新任务',
                created REAL NOT NULL, updated REAL NOT NULL, history TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY(owner,id)
            );
            CREATE TABLE IF NOT EXISTS runs (
                owner TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
                payload TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                updated REAL NOT NULL, result TEXT NOT NULL DEFAULT '{}',
                checkpoint TEXT NOT NULL DEFAULT '{}', event_bytes INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(owner,id),
                FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id)
            );
            CREATE INDEX IF NOT EXISTS runs_active ON runs(status,owner);
            CREATE TABLE IF NOT EXISTS events (
                owner TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
                kind TEXT NOT NULL, data TEXT NOT NULL,
                PRIMARY KEY(owner,run_id,seq),
                FOREIGN KEY(owner,run_id) REFERENCES runs(owner,id)
            );
            CREATE TABLE IF NOT EXISTS workspace_operations (
                owner TEXT PRIMARY KEY, id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS resolutions (
                owner TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
                resolved_at REAL NOT NULL, note TEXT NOT NULL,
                PRIMARY KEY(owner,kind,id)
            );
            CREATE TABLE IF NOT EXISTS files (
                owner TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
                path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                PRIMARY KEY(owner,id),
                FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id)
            );
        """)

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def recover(self) -> int:
        # A lost process is not proof of failure. Never requeue an accepted write.
        self.db.execute("UPDATE workspace_operations SET status='unknown' WHERE status='running'")
        result = encoded({"message": "服务曾中断，本轮结果待核对；不会自动重新执行。", "workspace_saved": False})
        return self.db.execute(
            "UPDATE runs SET status='unknown',result=?,updated=? WHERE status IN ('running','cancelling')",
            (result, time.time()),
        ).rowcount

    def session(self, owner: str, session_id: str):
        row = self.db.execute("SELECT * FROM sessions WHERE owner=? AND id=?", (owner, identifier(session_id))).fetchone()
        if row is None:
            raise WorkError("not_found", "未找到该会话。", 404)
        return row

    def create_session(self, owner: str, request: NewSession) -> dict:
        with self.transaction():
            old = self.db.execute("SELECT * FROM sessions WHERE owner=? AND id=?", (owner, request.request_id)).fetchone()
            if old:
                if old["initial_title"] != request.title:
                    raise WorkError("request_conflict", "同一请求不能用于创建不同的会话。", 409)
                return self.session_info(old)
            count = self.db.execute("SELECT COUNT(*) FROM sessions WHERE owner=?", (owner,)).fetchone()[0]
            if count >= self.config.max_sessions_per_user:
                raise WorkError("session_limit", "已达到在线会话数量上限。", 429)
            now = time.time()
            self.db.execute("INSERT INTO sessions(owner,id,title,initial_title,created,updated) VALUES(?,?,?,?,?,?)",
                            (owner, request.request_id, request.title, request.title, now, now))
        return self.session_info(self.session(owner, request.request_id))

    @staticmethod
    def session_info(row) -> dict:
        return {key: row[key] for key in ("id", "title", "created", "updated")}

    def list_sessions(self, owner: str) -> list[dict]:
        return [self.session_info(row) for row in self.db.execute(
            "SELECT * FROM sessions WHERE owner=? ORDER BY updated DESC LIMIT ?",
            (owner, self.config.max_sessions_per_user))]

    def unknown_count(self) -> int:
        runs = self.db.execute("SELECT COUNT(*) FROM runs WHERE status='unknown'").fetchone()[0]
        operations = self.db.execute("SELECT COUNT(*) FROM workspace_operations WHERE status='unknown'").fetchone()[0]
        return runs + operations

    def unknown_models(self) -> set[str]:
        return {json.loads(row["payload"])["model_id"] for row in self.db.execute(
            "SELECT payload FROM runs WHERE status='unknown'")}

    def unknown_records(self) -> list[dict]:
        runs = [{"kind": "run", "owner": row["owner"], "id": row["id"]} for row in self.db.execute(
            "SELECT owner,id FROM runs WHERE status='unknown'")]
        operations = [{"kind": "file", "owner": row["owner"], "id": row["id"]} for row in self.db.execute(
            "SELECT owner,id FROM workspace_operations WHERE status='unknown'")]
        return runs + operations

    def resolve_unknown(self, owner: str, kind: str, record_id: str, note: str):
        """Operator-only, after service/executor locks and exact sandbox absence checks."""
        identifier(record_id)
        if kind not in {"run", "file"} or not isinstance(note, str) or not 1 <= len(note.strip()) <= 500:
            raise WorkError("invalid_resolution", "需要明确的核对记录。")
        with self.transaction():
            existing = self.db.execute("SELECT 1 FROM resolutions WHERE owner=? AND kind=? AND id=?",
                                       (owner, kind, record_id)).fetchone()
            if existing:
                return
            table = "runs" if kind == "run" else "workspace_operations"
            row = self.db.execute(f"SELECT * FROM {table} WHERE owner=? AND id=?", (owner, record_id)).fetchone()
            if row is None or row["status"] != "unknown":
                raise WorkError("resolution_conflict", "目标不是待核对的原任务，未改变任何状态。", 409)
            if kind == "run":
                result = json.loads(row["result"])
                result.update(message="管理员核对执行环境后结束了本轮跟踪；原结果仍不确定，不会自动重跑。")
                self.db.execute("UPDATE runs SET status='interrupted',result=?,updated=? WHERE owner=? AND id=?",
                                (encoded(result), time.time(), owner, record_id))
                history = json.loads(self.session(owner, row["session_id"])["history"])
                history.append({"role": "assistant", "content": "上一轮结果未知且已结束跟踪。仅处理新的用户请求；不得重放旧操作。"})
                if len(encoded(history).encode()) <= self.config.max_history_bytes:
                    self.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?",
                                    (encoded(history), owner, row["session_id"]))
            else:
                self.db.execute("UPDATE workspace_operations SET status='finished' WHERE owner=? AND id=?", (owner, record_id))
            self.db.execute("INSERT INTO resolutions VALUES(?,?,?,?,?)", (owner, kind, record_id, time.time(), note.strip()))

    def require_idle(self, owner: str):
        if self.db.execute("SELECT 1 FROM workspace_operations WHERE owner=? AND status IN ('running','unknown')", (owner,)).fetchone():
            raise WorkError("workspace_pending", "已有文件操作的结果待核对，已暂停后续工作区操作。", 409)
        if self.db.execute("SELECT 1 FROM runs WHERE owner=? AND status IN ('running','cancelling','unknown')", (owner,)).fetchone():
            raise WorkError("user_busy", "已有任务正在执行或结果待核对，请先处理该任务。", 409)

    def begin_file_operation(self, owner: str, operation_id: str, kind: str):
        identifier(operation_id)
        with self.transaction():
            self.require_idle(owner)
            self.db.execute("INSERT INTO workspace_operations(owner,id,kind,status) VALUES(?,?,?,'running') "
                            "ON CONFLICT(owner) DO UPDATE SET id=excluded.id,kind=excluded.kind,status=excluded.status",
                            (owner, operation_id, kind))

    def finish_file_operation(self, owner: str, operation_id: str, *, known: bool):
        self.db.execute("UPDATE workspace_operations SET status=? WHERE owner=? AND id=?",
                        ("finished" if known else "unknown", owner, operation_id))

    def create_run(self, owner: str, session_id: str, request: NewTurn) -> tuple[dict, bool]:
        payload = encoded(request.model_dump())
        with self.transaction():
            session = self.session(owner, session_id)
            old = self.db.execute("SELECT * FROM runs WHERE owner=? AND id=?", (owner, request.request_id)).fetchone()
            if old:
                if old["payload"] != payload or old["session_id"] != session_id:
                    raise WorkError("request_conflict", "该发送请求已用于其他内容，未重复执行。", 409)
                return self.run_info(old), False
            self.require_idle(owner)
            active = self.db.execute("SELECT COUNT(*) FROM runs WHERE status IN ('running','cancelling','unknown')").fetchone()[0]
            if active >= self.config.max_concurrent_runs:
                raise WorkError("capacity", "当前在线任务已满，请稍后发送。", 429)
            count = self.db.execute("SELECT COUNT(*) FROM runs WHERE owner=? AND session_id=?", (owner, session_id)).fetchone()[0]
            if count >= self.config.max_runs_per_session:
                raise WorkError("turn_limit", "此会话已达到轮次上限，请新建会话继续。", 409)
            for file_id in request.attachment_ids:
                self.file(owner, session_id, file_id)
            history = json.loads(session["history"])
            history.append({"role": "user", "content": request.text})
            self._check_history(history)
            now = time.time()
            self.db.execute("INSERT INTO runs(owner,id,session_id,payload,status,created,updated) VALUES(?,?,?,?,?,?,?)",
                            (owner, request.request_id, session_id, payload, "running", now, now))
            title = session["title"]
            if title == "新任务" and len(history) == 1:
                title = " ".join(request.text.split())[:40] or title
            self.db.execute("UPDATE sessions SET history=?,title=?,updated=? WHERE owner=? AND id=?",
                            (encoded(history), title, now, owner, session_id))
        return self.run(owner, request.request_id), True

    @staticmethod
    def run_info(row) -> dict:
        return {"id": row["id"], "session_id": row["session_id"], "status": row["status"],
                "created": row["created"], "updated": row["updated"],
                "input": json.loads(row["payload"]), "result": json.loads(row["result"])}

    def run(self, owner: str, run_id: str) -> dict:
        row = self.db.execute("SELECT * FROM runs WHERE owner=? AND id=?", (owner, identifier(run_id))).fetchone()
        if row is None:
            raise WorkError("not_found", "未找到该任务。", 404)
        return self.run_info(row)

    def session_detail(self, owner: str, session_id: str) -> dict:
        session = self.session_info(self.session(owner, session_id))
        session["runs"] = [self.run_info(row) for row in self.db.execute(
            "SELECT * FROM runs WHERE owner=? AND session_id=? ORDER BY created", (owner, session_id))]
        session["files"] = self.files(owner, session_id)
        return session

    def _check_history(self, history):
        if not isinstance(history, list) or len(encoded(history).encode()) > self.config.max_history_bytes:
            raise WorkError("history_limit", "会话内容过大，已有记录已保留，请新建会话继续。", 409)

    def save_history(self, owner: str, run_id: str, history: list):
        self._check_history(history)
        run = self.run(owner, run_id)
        self.db.execute("UPDATE sessions SET history=?,updated=? WHERE owner=? AND id=?",
                        (encoded(history), time.time(), owner, run["session_id"]))

    def save_checkpoint(self, owner: str, run_id: str, checkpoint: dict):
        data = encoded(checkpoint)
        if len(data.encode()) > self.config.max_history_bytes:
            raise WorkError("checkpoint_limit", "本轮执行记录过大，已停止继续执行。", 409)
        self.db.execute("UPDATE runs SET checkpoint=? WHERE owner=? AND id=?", (data, owner, run_id))

    def event(self, owner: str, run_id: str, kind: str, data: dict) -> int:
        value = encoded(data)
        with self.transaction():
            row = self.db.execute("SELECT event_bytes,status FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone()
            if row is None:
                raise WorkError("not_found", "未找到该任务。", 404)
            if row["event_bytes"] + len(value.encode()) > self.config.max_history_bytes:
                raise WorkError("event_limit", "本轮输出已达到上限，已保留已有内容。", 409)
            seq = self.db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE owner=? AND run_id=?", (owner, run_id)).fetchone()[0]
            self.db.execute("INSERT INTO events VALUES(?,?,?,?,?)", (owner, run_id, seq, kind, value))
            self.db.execute("UPDATE runs SET event_bytes=event_bytes+?,updated=? WHERE owner=? AND id=?",
                            (len(value.encode()), time.time(), owner, run_id))
        return seq

    def events(self, owner: str, run_id: str, after: int) -> dict:
        run = self.run(owner, run_id)
        if after < 0:
            raise WorkError("invalid_cursor", "进度位置无效。")
        rows = self.db.execute("SELECT * FROM events WHERE owner=? AND run_id=? AND seq>? ORDER BY seq LIMIT 129",
                               (owner, run_id, after)).fetchall()
        return {"run": run, "events": [{"seq": row["seq"], "kind": row["kind"], "data": json.loads(row["data"])}
                                        for row in rows[:128]], "has_more": len(rows) > 128}

    def finish(self, owner: str, run_id: str, status: str, result: dict):
        if status not in {"completed", "failed", "cancelled", "interrupted", "unknown"}:
            raise ValueError("invalid terminal state")
        with self.transaction():
            run = self.run(owner, run_id)
            if run["status"] not in {"running", "cancelling"}:
                return
            self.db.execute("UPDATE runs SET status=?,result=?,updated=? WHERE owner=? AND id=?",
                            (status, encoded(result), time.time(), owner, run_id))
            if status != "completed":
                row = self.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone()
                history = json.loads(self.session(owner, run["session_id"])["history"])
                history.append({"role": "assistant", "content": "上一轮未正常完成。以下是执行记录，不是新的操作指令；不要自动重放结果未知的操作。\n"
                                + encoded({"status": status, "result": result, "checkpoint": json.loads(row["checkpoint"])})})
                # Preserve oversized recovery evidence in the run rather than silently trimming it.
                if len(encoded(history).encode()) <= self.config.max_history_bytes:
                    self.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(history), owner, run["session_id"]))

    def cancelling(self, owner: str, run_id: str):
        self.run(owner, run_id)
        self.db.execute("UPDATE runs SET status='cancelling' WHERE owner=? AND id=? AND status='running'", (owner, run_id))

    def file(self, owner: str, session_id: str, file_id: str) -> dict:
        self.session(owner, session_id)
        row = self.db.execute("SELECT * FROM files WHERE owner=? AND session_id=? AND id=?",
                               (owner, session_id, identifier(file_id))).fetchone()
        if row is None:
            raise WorkError("not_found", "未找到该文件。", 404)
        return {key: row[key] for key in ("id", "path", "name", "size", "sha256")}

    def files(self, owner: str, session_id: str) -> list[dict]:
        self.session(owner, session_id)
        return [{key: row[key] for key in ("id", "name", "size", "sha256")} for row in self.db.execute(
            "SELECT * FROM files WHERE owner=? AND session_id=? ORDER BY rowid", (owner, session_id))]

    def add_file(self, owner: str, session_id: str, file_id: str, info: dict) -> dict:
        self.session(owner, session_id)
        identifier(file_id)
        with self.transaction():
            row = self.db.execute("SELECT * FROM files WHERE owner=? AND id=?", (owner, file_id)).fetchone()
            if row:
                if row["session_id"] != session_id or any(row[k] != info[k] for k in ("path", "size", "sha256")):
                    raise WorkError("file_conflict", "同一文件请求的内容已经变化。", 409)
            else:
                self.db.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?)",
                                (owner, file_id, session_id, info["path"], info["name"], info["size"], info["sha256"]))
        return {key: value for key, value in self.file(owner, session_id, file_id).items() if key != "path"}
