"""Small durable online session store. No desktop data or credentials are stored here."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, identifier
from mona.hosted_work.history_media import externalize_media, init_history_media, restore_media


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _checkpoint_has_no_unconfirmed_tools(checkpoint: object) -> bool:
    """Only known checkpoint formats can prove no dispatched tool is unresolved."""
    if not isinstance(checkpoint, dict) or checkpoint.get("phase") not in {
        "awaiting_tools", "tools_started", "tools_partial", "tools_completed", "final_response",
    }:
        return False
    pending = checkpoint.get("pending_tool_calls")
    completed = checkpoint.get("completed_tool_results")
    if not isinstance(pending, list) or not isinstance(completed, list):
        return False
    if pending:
        started = checkpoint.get("started_tool_call_ids")
        if not isinstance(started, list) or any(not isinstance(item, str) for item in started):
            return False
        if any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
               or item["id"] in started for item in pending):
            return False
    def unconfirmed(value: object) -> bool:
        if isinstance(value, dict):
            for field in ("status", "code"):
                item = value.get(field)
                if isinstance(item, str) and item.lower() in {
                    "unknown", "outcome_unknown", "result_unknown", "execution_unknown",
                    "tool_outcome_unknown", "media_result_unknown",
                }:
                    return True
            return any(unconfirmed(item) for item in value.values())
        if isinstance(value, list):
            return any(unconfirmed(item) for item in value)
        if isinstance(value, str):
            stripped = value.lstrip()
            if stripped.startswith(("{", "[")):
                try:
                    return unconfirmed(json.loads(value))
                except ValueError:
                    pass
            text = value.lower()
            return any(marker in text for marker in ("tool_outcome_unknown", "media_result_unknown", "outcome_unknown",
                       "execution_unknown", "result_unknown", "结果待核对", "结果尚未确认", "结果未确认", "结果未知"))
        return False

    # Check structured tool receipts and explicit unknown-result markers, not
    # arbitrary words in successful output or the original user request.
    try:
        if unconfirmed(completed):
            return False
    except (RecursionError, TypeError, ValueError):
        return False
    return True


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
            CREATE TABLE IF NOT EXISTS execution_ended (
                owner TEXT NOT NULL, run_id TEXT NOT NULL,
                reason TEXT NOT NULL CHECK(reason IN ('completed','not_dispatched')),
                run_updated REAL NOT NULL, result TEXT NOT NULL, checkpoint TEXT NOT NULL,
                recorded REAL NOT NULL,
                PRIMARY KEY(owner,run_id),
                FOREIGN KEY(owner,run_id) REFERENCES runs(owner,id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS billing_journal (
                owner TEXT NOT NULL, run_id TEXT NOT NULL, charge_id TEXT NOT NULL UNIQUE,
                stage TEXT NOT NULL CHECK(stage IN (
                    'reserving','reserved','dispatching','running','usage_ready',
                    'settled','released','uncertain','rejected'
                )),
                usage TEXT, expected_units INTEGER CHECK(expected_units IS NULL OR expected_units >= 0),
                created REAL NOT NULL, updated REAL NOT NULL,
                PRIMARY KEY(owner,run_id),
                FOREIGN KEY(owner,run_id) REFERENCES runs(owner,id),
                CHECK((usage IS NULL) = (expected_units IS NULL))
            );
            CREATE INDEX IF NOT EXISTS billing_journal_pending ON billing_journal(stage,updated);
            CREATE TABLE IF NOT EXISTS conversation_context (
                owner TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
                PRIMARY KEY(owner,session_id),
                FOREIGN KEY(owner,session_id) REFERENCES sessions(owner,id) ON DELETE CASCADE
            );
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
        init_history_media(self.db)

    def _pack_media(self, owner: str, value):
        return externalize_media(self.db, owner, value, max_image_bytes=self.config.max_file_bytes,
                                 max_storage_bytes=self.config.history_media_storage_bytes,
                                 max_expanded_bytes=self.config.history_media_expand_bytes)

    def _restore_media(self, owner: str, value):
        return restore_media(self.db, owner, value, max_image_bytes=self.config.max_file_bytes,
                             max_storage_bytes=self.config.history_media_storage_bytes,
                             max_expanded_bytes=self.config.history_media_expand_bytes)

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

    @staticmethod
    def _billing_info(row) -> dict:
        return {"owner": row["owner"], "run_id": row["run_id"], "charge_id": row["charge_id"],
                "stage": row["stage"], "usage": json.loads(row["usage"]) if row["usage"] is not None else None,
                "expected_units": row["expected_units"]}

    def billing_begin(self, owner: str, run_id: str, charge_id: str) -> dict:
        """Persist the remote charge identity before the first reserve request."""
        identifier(run_id)
        identifier(charge_id)
        with self.transaction():
            row = self.db.execute("SELECT * FROM billing_journal WHERE owner=? AND run_id=?",
                                  (owner, run_id)).fetchone()
            if row:
                if row["charge_id"] != charge_id:
                    raise WorkError("billing_conflict", "计费记录不一致，请核对后继续。", 409)
                return self._billing_info(row)
            if not self.db.execute("SELECT 1 FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone():
                raise WorkError("not_found", "未找到该任务。", 404)
            if self.db.execute("SELECT 1 FROM billing_journal WHERE charge_id=?", (charge_id,)).fetchone():
                raise WorkError("billing_conflict", "计费记录不一致，请核对后继续。", 409)
            now = time.time()
            self.db.execute("INSERT INTO billing_journal(owner,run_id,charge_id,stage,created,updated) "
                            "VALUES(?,?,?,'reserving',?,?)", (owner, run_id, charge_id, now, now))
            row = self.db.execute("SELECT * FROM billing_journal WHERE owner=? AND run_id=?",
                                  (owner, run_id)).fetchone()
            return self._billing_info(row)

    def billing_update(self, owner: str, run_id: str, stage: str, *,
                       usage: dict | None = None, expected_units: int | None = None) -> dict:
        transitions = {
            "reserving": {"reserved", "released", "rejected", "uncertain"},
            "reserved": {"dispatching", "released", "uncertain"},
            "dispatching": {"running", "uncertain"},
            "running": {"usage_ready", "uncertain"},
            "usage_ready": {"settled", "uncertain"},
            "uncertain": {"settled"},
            "settled": set(), "released": set(), "rejected": set(),
        }
        identifier(run_id)
        if not isinstance(stage, str) or stage not in transitions:
            raise WorkError("billing_conflict", "计费记录状态无效。", 409)
        if (usage is None) != (expected_units is None):
            raise WorkError("billing_conflict", "计费用量记录不完整。", 409)
        if usage is not None:
            keys = ("input_tokens", "cached_input_tokens", "output_tokens")
            if (not isinstance(usage, dict) or set(usage) != set(keys)
                    or any(type(usage[key]) is not int or not 0 <= usage[key] <= 1_000_000_000 for key in keys)
                    or usage["cached_input_tokens"] > usage["input_tokens"]
                    or type(expected_units) is not int or not 0 <= expected_units <= 9_223_372_036_854_775_807):
                raise WorkError("billing_conflict", "计费用量记录无效。", 409)
            usage = {key: usage[key] for key in keys}
        with self.transaction():
            row = self.db.execute("SELECT * FROM billing_journal WHERE owner=? AND run_id=?",
                                  (owner, run_id)).fetchone()
            if row is None:
                raise WorkError("not_found", "未找到该计费记录。", 404)
            previous = row["stage"]
            if stage != previous and stage not in transitions[previous]:
                raise WorkError("billing_conflict", "计费记录状态不一致，请核对后继续。", 409)
            previous_usage = json.loads(row["usage"]) if row["usage"] is not None else None
            if (previous_usage is None) != (row["expected_units"] is None):
                raise WorkError("billing_conflict", "计费用量记录不完整。", 409)
            if usage is not None:
                if stage not in {"usage_ready", "uncertain", "settled"}:
                    raise WorkError("billing_conflict", "当前状态不能保存计费用量。", 409)
                if previous_usage is not None and (previous_usage != usage or row["expected_units"] != expected_units):
                    raise WorkError("billing_conflict", "已保存的计费用量不能更改。", 409)
            saved_usage = previous_usage if previous_usage is not None else usage
            saved_units = row["expected_units"] if previous_usage is not None else expected_units
            if stage in {"usage_ready", "settled"} and saved_usage is None:
                raise WorkError("billing_conflict", "缺少完整计费用量，不能结算。", 409)
            if stage == "settled" and previous_usage is None:
                raise WorkError("billing_conflict", "结算前必须先保存计费用量。", 409)
            self.db.execute("UPDATE billing_journal SET stage=?,usage=?,expected_units=?,updated=? "
                            "WHERE owner=? AND run_id=?", (stage, encoded(saved_usage) if saved_usage is not None else None,
                                                             saved_units, time.time(), owner, run_id))
            row = self.db.execute("SELECT * FROM billing_journal WHERE owner=? AND run_id=?",
                                  (owner, run_id)).fetchone()
            return self._billing_info(row)

    def billing_pending(self) -> list[dict]:
        """Return incomplete charges for recovery without storing account tokens."""
        return [self._billing_info(row) for row in self.db.execute(
            "SELECT * FROM billing_journal WHERE stage NOT IN ('settled','released','rejected') "
            "ORDER BY created,owner,run_id")]

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

    def history(self, owner: str, session_id: str) -> list:
        """Return the exact account-scoped history, restoring any stored images."""
        value = self._restore_media(owner, json.loads(self.session(owner, session_id)["history"]))
        if not isinstance(value, list):
            raise WorkError("invalid_history", "会话记录格式无效。", 409)
        return value

    def clean_rejected_history(self, owner: str, session_id: str):
        """Remove only provably rejected pre-dispatch turns from model history.

        Older releases persisted the input and an error response before the
        wallet rejected it. The creation timestamp is the identity originally
        written into that input; matching text by itself is never sufficient.
        The separate desktop transcript is retained by the caller first.
        """
        from mona.hosted_work.context import history_fingerprint

        with self.transaction():
            self.require_idle(owner)
            history = self.history(owner, session_id)
            if any(not isinstance(message, dict) for message in history):
                raise WorkError("invalid_history", "会话记录格式无效。", 409)
            rows = self.db.execute(
                "SELECT r.*,b.stage AS billing_stage FROM runs r LEFT JOIN billing_journal b "
                "ON b.owner=r.owner AND b.run_id=r.id WHERE r.owner=? AND r.session_id=?",
                (owner, session_id),
            ).fetchall()
            identities = {}
            candidates = []
            for row in rows:
                payload, result = json.loads(row["payload"]), json.loads(row["result"])
                identity = (datetime.fromtimestamp(row["created"], timezone.utc).isoformat(), payload.get("text"))
                identities[identity] = identities.get(identity, 0) + 1
                diagnostic = result.get("diagnostic") if isinstance(result, dict) else None
                if (row["status"] == "failed" and isinstance(diagnostic, dict)
                        and diagnostic.get("stop_reason") == "billing_rejected"):
                    candidates.append((row, identity, result))

            removed = set()
            for row, (created, text), result in candidates:
                matches = [index for index, message in enumerate(history)
                           if message.get("role") == "user" and message.get("timestamp") == created
                           and message.get("content") == text]
                if not matches:
                    continue  # Previously cleaned or no longer present; never match by text alone.
                index = matches[0]
                notice = {"role": "assistant", "content": result.get("message")}
                if (row["billing_stage"] != "rejected" or result.get("workspace_saved") is not False
                        or row["event_bytes"] != 0 or json.loads(row["checkpoint"]) != {}
                        or identities[(created, text)] != 1
                        or len(matches) != 1 or index + 1 >= len(history)
                        or history[index + 1] != notice or index in removed or index + 1 in removed):
                    raise WorkError("history_conflict", "会话记录尚待核对，请新建会话继续。", 409)
                removed.update((index, index + 1))
            if not removed:
                return

            context_row = self.db.execute("SELECT state FROM conversation_context WHERE owner=? AND session_id=?",
                                          (owner, session_id)).fetchone()
            context = self._restore_media(owner, json.loads(context_row[0])) if context_row else {}
            if context:
                cursor = context.get("last_consolidated")
                if (context.get("format") != "mona-hosted-context-v1" or context.get("owner") != owner
                        or context.get("session_id") != session_id or type(cursor) is not int
                        or not 0 <= cursor <= len(history)
                        or context.get("history_prefix_digest") != history_fingerprint(history[:cursor])
                        or any(index < cursor for index in removed)):
                    # Never rewrite an existing summary: it may already contain
                    # rejected content and cannot be safely edited by identity.
                    raise WorkError("history_conflict", "会话记录已整理，请新建会话继续。", 409)
            cleaned = self._pack_media(owner, [message for index, message in enumerate(history) if index not in removed])
            self._check_history(cleaned)
            self.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?",
                            (encoded(cleaned), owner, session_id))

    def turn_state(self, owner: str, session_id: str, *, compact: bool = False) -> tuple[list, dict]:
        """Bound the combined history and context expanded for one turn."""
        history = json.loads(self.session(owner, session_id)["history"])
        row = self.db.execute("SELECT state FROM conversation_context WHERE owner=? AND session_id=?",
                              (owner, session_id)).fetchone()
        context = json.loads(row[0]) if row else {}
        result = self._restore_media(owner, {"history": history, "context": context})
        if not isinstance(result["history"], list) or not isinstance(result["context"], dict):
            raise WorkError("invalid_history", "会话记录格式无效。", 409)
        return (history, context) if compact else (result["history"], result["context"])

    def prune_history_media(self, owner: str, candidates: set[str]) -> int:
        """Remove only this deleted session's now-unreferenced image blobs."""
        if not self.db.in_transaction:
            raise WorkError("invalid_state", "会话图片清理事务不可用。", 503)
        if not candidates:
            return 0
        if (self.db.execute("SELECT 1 FROM runs WHERE owner=? AND status IN ('running','cancelling','unknown') LIMIT 1",
                            (owner,)).fetchone()
                or self.db.execute("SELECT 1 FROM workspace_operations WHERE owner=? AND status IN ('running','unknown') LIMIT 1",
                                   (owner,)).fetchone()):
            return 0
        image_journal = self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_billing_journal'").fetchone()
        if image_journal and self.db.execute(
                "SELECT 1 FROM image_billing_journal WHERE owner=? AND stage NOT IN ('settled','released','rejected','free_completed') LIMIT 1",
                (owner,)).fetchone():
            return 0
        from mona.hosted_work.history_media import media_references, tool_result_image_references

        retained: set[str] = tool_result_image_references(self.db, owner)
        try:
            for table, column in (("sessions", "history"), ("runs", "checkpoint"), ("conversation_context", "state")):
                for row in self.db.execute(f"SELECT {column} FROM {table} WHERE owner=?", (owner,)):
                    retained.update(media_references(json.loads(row[0])))
        except (ValueError, TypeError, RecursionError):
            raise WorkError("invalid_history_media", "会话图片无法核验，已有记录已保留。", 409) from None
        removed = 0
        for digest in candidates - retained:
            removed += self.db.execute("DELETE FROM history_media WHERE owner=? AND digest=?", (owner, digest)).rowcount
        return removed

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
        runs = self.db.execute("SELECT COUNT(*) FROM runs r WHERE r.status='unknown' AND NOT EXISTS "
                               "(SELECT 1 FROM execution_ended e WHERE e.owner=r.owner AND e.run_id=r.id "
                               "AND e.run_updated=r.updated AND e.result=r.result AND e.checkpoint=r.checkpoint)").fetchone()[0]
        operations = self.db.execute("SELECT COUNT(*) FROM workspace_operations WHERE status='unknown'").fetchone()[0]
        return runs + operations

    def unknown_models(self) -> set[str]:
        return {json.loads(row["payload"])["model_id"] for row in self.db.execute(
            "SELECT r.payload FROM runs r WHERE r.status='unknown' AND NOT EXISTS "
            "(SELECT 1 FROM execution_ended e WHERE e.owner=r.owner AND e.run_id=r.id "
            "AND e.run_updated=r.updated AND e.result=r.result AND e.checkpoint=r.checkpoint)")}

    def record_execution_ended(self, owner: str, run_id: str, reason: str) -> bool:
        """Record service-confirmed termination, without changing the run or its charge.

        Called only after the service has proved the process and its dependants
        ended, or proved no model process was ever dispatched. Bound to the
        exact saved run state; changed records no longer release capacity.
        """
        if reason not in {"completed", "not_dispatched"}:
            return False
        identifier(run_id)
        with self.transaction():
            row = self.db.execute("SELECT status,result,checkpoint,updated FROM runs WHERE owner=? AND id=?",
                                  (owner, run_id)).fetchone()
            if row is None or row["status"] != "unknown":
                return False
            result = json.loads(row["result"])
            diagnostic = result.get("diagnostic") if isinstance(result, dict) else None
            if (not isinstance(diagnostic, dict) or diagnostic.get("stop_reason") != "billing_unknown"
                    or result.get("workspace_saved") is not (reason == "completed")):
                return False
            # A successful hosted turn clears its checkpoint after durable
            # history. A leftover checkpoint cannot prove all tools ended.
            if reason == "completed" and json.loads(row["checkpoint"]) != {}:
                return False
            billing = self.db.execute("SELECT stage FROM billing_journal WHERE owner=? AND run_id=?",
                                      (owner, run_id)).fetchone()
            if ((reason == "completed" and billing is None)
                    or billing is not None and billing["stage"] in {"settled", "released", "rejected"}):
                return False
            self.db.execute("INSERT OR REPLACE INTO execution_ended VALUES(?,?,?,?,?,?,?)",
                            (owner, run_id, reason, row["updated"], row["result"], row["checkpoint"], time.time()))
            return True

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
                original_message = result.get("message") or "上一轮未完成，已有进度已保留。结果未知的操作不会自动重做。"
                history = self.history(owner, row["session_id"])
                # finish() may already have merged this checkpoint and added a
                # status notice. Remove only that exact final notice while
                # matching the checkpoint suffix, then restore it unchanged.
                notice = None
                if (history and history[-1].get("role") == "assistant"
                        and history[-1].get("content") == original_message):
                    notice = history.pop()
                from mona.session.checkpoint_recovery import restore_checkpoint_messages
                from mona.session.manager import Session

                projection = Session(key="websocket:" + row["session_id"], messages=history)
                restore_checkpoint_messages(projection, self._restore_media(owner, json.loads(row["checkpoint"])))
                history = projection.messages
                if notice is not None:
                    history.append(notice)
                history.append({"role": "assistant", "content": "上一轮结果未知且已结束跟踪。仅处理新的用户请求；不得重放旧操作。"})
                packed = self._pack_media(owner, history)
                self._check_history(packed)
                result.update(message="管理员核对执行环境后结束了本轮跟踪；原结果仍不确定，不会自动重跑。")
                self.db.execute("UPDATE runs SET status='interrupted',result=?,updated=? WHERE owner=? AND id=?",
                                (encoded(result), time.time(), owner, record_id))
                self.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?",
                                (encoded(packed), owner, row["session_id"]))
            else:
                self.db.execute("UPDATE workspace_operations SET status='finished' WHERE owner=? AND id=?", (owner, record_id))
            self.db.execute("INSERT INTO resolutions VALUES(?,?,?,?,?)", (owner, kind, record_id, time.time(), note.strip()))

    def confirm_cancelled_with_pending_billing(self, owner: str, run_id: str) -> bool:
        """End tracking only after the service has confirmed process cleanup.

        This never settles, releases, or alters the independent billing journal.
        A missing checkpoint, unconfirmed write, or ambiguous record stays unknown.
        """
        identifier(run_id)
        with self.transaction():
            row = self.db.execute("SELECT status,result,checkpoint FROM runs WHERE owner=? AND id=?",
                                  (owner, run_id)).fetchone()
            billing = self.db.execute("SELECT stage FROM billing_journal WHERE owner=? AND run_id=?",
                                      (owner, run_id)).fetchone()
            if row is None or row["status"] != "unknown" or billing is None or billing["stage"] not in {
                "uncertain", "usage_ready", "running", "dispatching",
            }:
                return False
            result = json.loads(row["result"])
            diagnostic = result.get("diagnostic") if isinstance(result, dict) else None
            if (not isinstance(diagnostic, dict) or diagnostic.get("stop_reason") != "billing_unknown"
                    or result.get("workspace_saved") is not True
                    or not _checkpoint_has_no_unconfirmed_tools(json.loads(row["checkpoint"]))):
                return False
            result["message"] = "本轮已停止，计费用量尚待核对，预留余额暂时保留。"
            result["diagnostic"] = {**diagnostic, "execution_status": "cancelled"}
            self.db.execute("UPDATE runs SET status='interrupted',result=?,updated=? WHERE owner=? AND id=?",
                            (encoded(result), time.time(), owner, run_id))
            return True

    def require_idle(self, owner: str):
        if self.db.execute("SELECT 1 FROM workspace_operations WHERE owner=? AND status IN ('running','unknown')", (owner,)).fetchone():
            raise WorkError("workspace_pending", "已有文件操作的结果待核对，已暂停后续工作区操作。", 409)
        if self.db.execute("SELECT 1 FROM runs WHERE owner=? AND status='unknown'", (owner,)).fetchone():
            raise WorkError("work_result_unknown", "上一轮任务结果待核对，请保留当前会话。", 409)
        if self.db.execute("SELECT 1 FROM runs WHERE owner=? AND status IN ('running','cancelling')", (owner,)).fetchone():
            raise WorkError("user_busy", "已有任务正在执行，请等待当前任务结束。", 409)

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
            active = self.db.execute("SELECT COUNT(*) FROM runs r WHERE r.status IN ('running','cancelling') OR "
                                     "(r.status='unknown' AND NOT EXISTS "
                                     "(SELECT 1 FROM execution_ended e WHERE e.owner=r.owner AND e.run_id=r.id "
                                     "AND e.run_updated=r.updated AND e.result=r.result AND e.checkpoint=r.checkpoint))").fetchone()[0]
            if active >= self.config.max_concurrent_runs:
                raise WorkError("capacity", "当前在线任务已满，请稍后发送。", 429)
            count = self.db.execute("SELECT COUNT(*) FROM runs WHERE owner=? AND session_id=?", (owner, session_id)).fetchone()[0]
            if count >= self.config.max_runs_per_session:
                raise WorkError("turn_limit", "此会话已达到轮次上限，请新建会话继续。", 409)
            for file_id in request.attachment_ids:
                self.file(owner, session_id, file_id)
            now = time.time()
            history = self._restore_media(owner, json.loads(session["history"]))
            history.append({"role": "user", "content": request.text,
                            "timestamp": datetime.fromtimestamp(now, timezone.utc).isoformat()})
            packed_history = self._pack_media(owner, history)
            self._check_history(packed_history)
            self.db.execute("INSERT INTO runs(owner,id,session_id,payload,status,created,updated) VALUES(?,?,?,?,?,?,?)",
                            (owner, request.request_id, session_id, payload, "running", now, now))
            title = session["title"]
            if title == "新任务" and len(history) == 1:
                title = " ".join(request.text.split())[:40] or title
            self.db.execute("UPDATE sessions SET history=?,title=?,updated=? WHERE owner=? AND id=?",
                            (encoded(packed_history), title, now, owner, session_id))
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
        if not isinstance(history, list):
            raise WorkError("invalid_history", "会话记录格式无效。", 409)
        with self.transaction():
            run = self.run(owner, run_id)
            packed = self._pack_media(owner, history)
            self._check_history(packed)
            self.db.execute("UPDATE sessions SET history=?,updated=? WHERE owner=? AND id=?",
                            (encoded(packed), time.time(), owner, run["session_id"]))

    def save_checkpoint(self, owner: str, run_id: str, checkpoint: dict):
        with self.transaction():
            self.run(owner, run_id)
            data = encoded(self._pack_media(owner, checkpoint))
            if len(data.encode()) > self.config.max_history_bytes:
                raise WorkError("checkpoint_limit", "本轮执行记录过大，已停止继续执行。", 409)
            self.db.execute("UPDATE runs SET checkpoint=? WHERE owner=? AND id=?", (data, owner, run_id))

    def context_state(self, owner: str, sid: str) -> dict:
        self.session(owner, sid)
        row = self.db.execute("SELECT state FROM conversation_context WHERE owner=? AND session_id=?", (owner, sid)).fetchone()
        return self._restore_media(owner, json.loads(row[0])) if row else {}

    def save_context(self, owner: str, sid: str, value: dict):
        from mona.hosted_work.context import history_fingerprint
        state = value.get("state")
        if (not isinstance(state, dict) or state.get("owner") != owner or state.get("session_id") != sid
                or state.get("format") != "mona-hosted-context-v1" or not isinstance(state.get("metadata"), dict)):
            raise WorkError("context_conflict", "会话上下文归属无效。", 409)
        with self.transaction():
            history = self.history(owner, sid)
            cursor = state.get("last_consolidated")
            if (isinstance(cursor, bool) or not isinstance(cursor, int) or not 0 <= cursor <= len(history)
                    or value.get("source_history_length") != len(history)
                    or value.get("source_history_digest") != history_fingerprint(history)
                    or state.get("history_prefix_digest") != history_fingerprint(history[:cursor])):
                raise WorkError("context_conflict", "会话历史已变化，未覆盖原上下文。", 409)
            previous = self.context_state(owner, sid)
            if previous.get("last_consolidated", 0) > cursor:
                raise WorkError("context_conflict", "会话整理游标不能回退。", 409)
            raw = encoded(self._pack_media(owner, state))
            if len(raw.encode()) > self.config.max_history_bytes:
                raise WorkError("context_limit", "会话上下文超过保存上限。", 413)
            self.db.execute("INSERT INTO conversation_context VALUES(?,?,?) ON CONFLICT(owner,session_id) DO UPDATE SET state=excluded.state",
                            (owner, sid, raw))

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
                self.db.execute("SAVEPOINT hosted_finish_history")
                try:
                    history = self.history(owner, run["session_id"])
                    from mona.session.checkpoint_recovery import restore_checkpoint_messages
                    from mona.session.manager import Session

                    projection = Session(key="websocket:" + run["session_id"], messages=history)
                    restore_checkpoint_messages(projection, self._restore_media(owner, json.loads(row["checkpoint"])))
                    history = projection.messages
                    history.append({"role": "assistant", "content": result.get("message") or
                                    "上一轮未完成，已有进度已保留。结果未知的操作不会自动重做。"})
                    packed = self._pack_media(owner, history)
                    self._check_history(packed)
                    self.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(packed), owner, run["session_id"]))
                except WorkError as exc:
                    self.db.execute("ROLLBACK TO SAVEPOINT hosted_finish_history")
                    self.db.execute("RELEASE SAVEPOINT hosted_finish_history")
                    # An unmerged checkpoint must not be silently treated as
                    # a fully settled turn. Keep all evidence and block new
                    # work until the retained history can be reconciled.
                    diagnostic = result.get("diagnostic")
                    diagnostic = dict(diagnostic) if isinstance(diagnostic, dict) else {}
                    diagnostic.update(stop_reason="recovery_unconfirmed", recovery_error_code=exc.code)
                    uncertain = {**result, "message": "本轮执行记录尚未完整保存，请先核对已有结果。",
                                 "diagnostic": diagnostic}
                    self.db.execute("UPDATE runs SET status='unknown',result=?,updated=? WHERE owner=? AND id=?",
                                    (encoded(uncertain), time.time(), owner, run_id))
                else:
                    self.db.execute("RELEASE SAVEPOINT hosted_finish_history")

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
