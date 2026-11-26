"""Account-scoped state and the existing desktop transcript projection."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.model_policy import model_available
from mona.hosted_work.store import encoded
from mona.webui.session_usage import summarize_session_usage
from mona.webui.transcript import _ui_token_usage, replay_transcript_to_ui_messages


def request_id(value: str, namespace: str = "") -> str:
    if not isinstance(value, str) or not value or len(value) > 200:
        raise WorkError("invalid_request", "请求标识无效。")
    return hashlib.sha256((namespace + ":" + value).encode()).hexdigest()[:32]


def chat_id(value: str) -> str:
    if value.startswith("websocket:"):
        value = value[len("websocket:"):]
    return identifier(value)


def timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def _without_sidebar_sessions(state: dict, deleted: set[str]) -> dict:
    """Remove only keys for this owner's explicitly deleted conversations."""
    if not deleted:
        return dict(state)
    keys = deleted | {"websocket:" + sid for sid in deleted}
    result = dict(state)
    for field in ("pinned_keys", "archived_keys"):
        value = result.get(field)
        if isinstance(value, list):
            result[field] = [item for item in value if not isinstance(item, str) or item not in keys]
    for field in ("title_overrides", "last_read_at_by_key", "tags_by_key"):
        value = result.get(field)
        if isinstance(value, dict):
            result[field] = {key: item for key, item in value.items() if key not in keys}
    return result


class DesktopStore:
    def __init__(self, service, files):
        self.service, self.files = service, files
        self.databases: dict[str, sqlite3.Connection] = {}

    def db(self, owner: str) -> sqlite3.Connection:
        if owner in self.databases:
            return self.databases[owner]
        path = self.files.root(owner).parent / "desktop.sqlite3"
        if path.is_symlink() or path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
            raise WorkError("invalid_state", "会话存储不可用。", 503)
        db = sqlite3.connect(path, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS transcript (
                chat_id TEXT NOT NULL, seq INTEGER NOT NULL, event_key TEXT NOT NULL,
                data TEXT NOT NULL, created REAL NOT NULL,
                PRIMARY KEY(chat_id,seq), UNIQUE(chat_id,event_key)
            );
            CREATE TABLE IF NOT EXISTS deleted_chats (chat_id TEXT PRIMARY KEY);
        """)
        os.chmod(path, 0o600)
        self.databases[owner] = db
        return db

    def close(self):
        for db in self.databases.values():
            db.close()
        self.databases.clear()

    def get(self, owner: str, key: str, default=None):
        row = self.db(owner).execute("SELECT data FROM metadata WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, owner: str, key: str, value):
        self.db(owner).execute("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                               (key, encoded(value)))

    def session(self, owner: str, sid: str):
        sid = chat_id(sid)
        if self.db(owner).execute("SELECT 1 FROM deleted_chats WHERE chat_id=?", (sid,)).fetchone():
            raise WorkError("not_found", "会话已删除。", 404)
        return self.service.store.session(owner, sid)

    def append(self, owner: str, sid: str, record: dict, event_key: str):
        self.session(owner, sid)
        db = self.db(owner)
        value = encoded(record)
        if len(value.encode()) > self.service.config.max_history_bytes:
            raise WorkError("event_limit", "会话记录超过允许大小。", 413)
        previous = db.execute("SELECT data FROM transcript WHERE chat_id=? AND event_key=?", (sid, event_key)).fetchone()
        if previous:
            if previous[0] != value:
                raise WorkError("request_conflict", "同一记录的内容已变化。", 409)
            return
        seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM transcript WHERE chat_id=?", (sid,)).fetchone()[0]
        db.execute("INSERT INTO transcript VALUES(?,?,?,?,?)", (sid, seq, event_key, value, time.time()))

    def records(self, owner: str, sid: str):
        session = self.session(owner, sid)
        db = self.db(owner)
        rows = db.execute("SELECT data,created FROM transcript WHERE chat_id=? ORDER BY seq", (sid,)).fetchall()
        if not rows:
            # Existing basic Work sessions are imported as history, never replayed.
            for index, message in enumerate(json.loads(session["history"])):
                role, content = message.get("role"), message.get("content")
                if role not in {"user", "assistant"} or not isinstance(content, str) or not content:
                    continue
                event = "user" if role == "user" else "message"
                self.append(owner, sid, {"event": event, "text": content}, f"legacy:{index}")
            rows = db.execute("SELECT data,created FROM transcript WHERE chat_id=? ORDER BY seq", (sid,)).fetchall()
        return [(json.loads(row[0]), row[1]) for row in rows]

    def history(self, owner: str, sid: str, *, limit: int = 80, before: int | None = None, revision: str | None = None,
                augment_user_media=None):
        sid = chat_id(sid)
        records = self.records(owner, sid)
        current_revision = hashlib.sha256(encoded([row[0] for row in records]).encode()).hexdigest()
        if revision and revision != current_revision:
            raise WorkError("history_changed", "会话历史已更新，请重新读取。", 409)
        messages = replay_transcript_to_ui_messages([row[0] for row in records], augment_user_media=augment_user_media)
        ordinal = 0
        for index, message in enumerate(messages):
            source = message.get("sourceTranscriptIndex", 0)
            message["createdAt"] = int(records[min(source, len(records) - 1)][1] * 1000) if records else 0
            message["historyPosition"] = index
            if message.get("role") == "user" and records:
                input_id = records[min(source, len(records) - 1)][0].get("input_id")
                if isinstance(input_id, str) and input_id:
                    message["id"] = input_id
            if message.get("role") == "assistant" and message.get("kind") != "trace":
                ordinal += 1
                message["assistantOrdinal"] = ordinal
        session_usage = self._session_usage(owner, sid) if before is None else None
        if before is None:
            before = len(messages)
        if not 1 <= limit <= 200 or not 0 <= before <= len(messages):
            raise WorkError("invalid_cursor", "历史位置无效。")
        start = max(0, before - limit)
        return {"schemaVersion": 3, "sessionKey": "websocket:" + sid, "sessionUsage": session_usage,
                "messages": messages[start:before], "pagination": {
                    "hasMore": start > 0, "before": start if start else None,
                    "revision": current_revision, "total": len(messages)}}

    def _session_usage(self, owner: str, sid: str):
        # The desktop events keep the last request's occupancy, while the run
        # result records the cumulative input and output for the entire turn.
        rows = self.service.store.db.execute(
            "SELECT result, created, updated FROM runs WHERE owner=? AND session_id=? "
            "AND status IN ('completed', 'failed', 'cancelled') ORDER BY created",
            (owner, sid),
        )
        turns = []
        for raw_result, created, updated in rows:
            result = json.loads(raw_result)
            usage = result.get("usage")
            if not isinstance(usage, dict):
                continue
            final_usage = result.get("final_usage")
            if isinstance(final_usage, dict) and isinstance(final_usage.get("context_model"), str):
                usage = {**usage, "context_model": final_usage["context_model"]}
            turns.append((
                _ui_token_usage(usage),
                round(max(0, updated - created) * 1000),
            ))
        return summarize_session_usage(turns)

    def sidebar(self, owner: str):
        return self.get(owner, "sidebar", {"schema_version": 5, "pinned_keys": [], "archived_keys": [],
            "title_overrides": {}, "last_read_at_by_key": {}, "project_names": {}, "tags_by_key": {},
            "collapsed_groups": {}, "updated_at": None, "view": {"density": "comfortable", "sort": "updated_desc",
                "show_previews": False, "show_timestamps": False, "show_archived": False}})

    def update_sidebar(self, owner: str, values: dict):
        if not isinstance(values, dict):
            raise WorkError("invalid_request", "会话列表设置无效。")
        db = self.db(owner)
        db.execute("BEGIN IMMEDIATE")
        try:
            state = self.sidebar(owner)
            if not isinstance(state, dict) or set(values) - set(state):
                raise WorkError("invalid_request", "会话列表设置无效。")
            for key, value in values.items():
                if key in {"pinned_keys", "archived_keys"} and (not isinstance(value, list) or len(value) > 1000):
                    raise WorkError("invalid_request", "会话列表设置无效。")
                if key in {"title_overrides", "last_read_at_by_key", "tags_by_key"} and (not isinstance(value, dict) or len(value) > 1000):
                    raise WorkError("invalid_request", "会话列表设置无效。")
            deleted = {row[0] for row in db.execute("SELECT chat_id FROM deleted_chats")}
            state = _without_sidebar_sessions(state, deleted)
            values = _without_sidebar_sessions(values, deleted)
            for key, value in values.items():
                if key in {"pinned_keys", "archived_keys"}:
                    for item in value:
                        if not isinstance(item, str):
                            raise WorkError("invalid_request", "会话列表设置无效。")
                        self.session(owner, item)
                    state[key] = list(dict.fromkeys(value))
                elif key in {"title_overrides", "last_read_at_by_key", "tags_by_key"}:
                    for item, entry in value.items():
                        if not isinstance(item, str):
                            raise WorkError("invalid_request", "会话列表设置无效。")
                        self.session(owner, item)
                        if key == "title_overrides" and (not isinstance(entry, str) or len(entry) > 200):
                            raise WorkError("invalid_request", "会话名称无效。")
                        if key == "last_read_at_by_key" and not isinstance(entry, str):
                            raise WorkError("invalid_request", "会话已读状态无效。")
                    if key == "last_read_at_by_key":
                        existing = state.get(key)
                        if not isinstance(existing, dict):
                            raise WorkError("invalid_state", "会话列表设置无效。", 503)
                        # Stale tabs may not erase or roll back another tab's marker.
                        merged = dict(existing)
                        for item, entry in value.items():
                            previous = merged.get(item)
                            if not isinstance(previous, str) or entry > previous:
                                merged[item] = entry
                        if len(merged) > 1000:
                            raise WorkError("invalid_request", "会话列表设置无效。")
                        state[key] = merged
                    else:
                        state[key] = value
                elif key in {"view", "project_names", "collapsed_groups"}:
                    if not isinstance(value, dict) or len(encoded(value)) > 8192:
                        raise WorkError("invalid_request", "会话列表设置无效。")
                    state[key] = value
                elif key == "schema_version" and value != 5:
                    raise WorkError("invalid_request", "会话列表版本不兼容。")
            state["updated_at"] = timestamp(time.time())
            self.set(owner, "sidebar", state)
            db.execute("COMMIT")
            return state
        except BaseException:
            db.execute("ROLLBACK")
            raise

    def model(self, owner: str) -> str:
        value = self.get(owner, "model_id")
        models = {key: item for key, item in self.service.config.models.items() if model_available(item, self.service.config)}
        return value if value in models else next(iter(models), "")

    def model_effort(self, owner: str, value: str, catalog=None) -> str | None:
        model = self.service.config.models.get(value)
        if model is None:
            return None
        if model.source != "codex":
            return model.reasoning_effort
        if catalog is None:
            from mona.hosted_work.codex_catalog import codex_catalog

            catalog = codex_catalog(self.service.config)
        metadata = catalog.get(model.model)
        if metadata is None:
            return None
        preferences = self.get(owner, "model_efforts", {})
        saved = preferences.get(value) if isinstance(preferences, dict) else None
        if (isinstance(saved, dict) and saved.get("source") == model.source and saved.get("model") == model.model
                and saved.get("effort") in metadata.efforts):
            return saved["effort"]
        return metadata.default_effort

    def set_model(self, owner: str, value: str, effort: str | None = None):
        if value not in self.service.config.models or not model_available(self.service.config.models[value], self.service.config):
            raise WorkError("invalid_model", "此模型未开放。")
        model = self.service.config.models[value]
        if model.source == "codex" and effort is not None:
            from mona.hosted_work.codex_catalog import codex_catalog

            metadata = codex_catalog(self.service.config).get(model.model)
            if metadata is None or effort not in metadata.efforts:
                raise WorkError("unsupported_reasoning_effort", "当前模型不支持该思考强度，请刷新后重试。", 422)
        elif effort is not None and effort != model.reasoning_effort:
            raise WorkError("invalid_model", "此模型未开放所选思考强度。")
        db = self.db(owner)
        db.execute("BEGIN IMMEDIATE")
        try:
            self.set(owner, "model_id", value)
            if model.source == "codex" and effort is not None:
                preferences = self.get(owner, "model_efforts", {})
                if not isinstance(preferences, dict):
                    preferences = {}
                preferences[value] = {"source": model.source, "model": model.model, "effort": effort}
                self.set(owner, "model_efforts", preferences)
            db.execute("COMMIT")
        except BaseException:
            db.execute("ROLLBACK")
            raise

    def summaries(self, owner: str):
        result = []
        for item in self.service.store.list_sessions(owner):
            if self.db(owner).execute("SELECT 1 FROM deleted_chats WHERE chat_id=?", (item["id"],)).fetchone():
                continue
            row = self.session(owner, item["id"])
            history = json.loads(row["history"])
            preview = next((m.get("content") for m in reversed(history) if isinstance(m.get("content"), str)), "")
            running = self.service.store.db.execute("SELECT created FROM runs WHERE owner=? AND session_id=? AND status IN ('running','cancelling') ORDER BY created DESC LIMIT 1", (owner, item["id"])).fetchone()
            result.append({"key": "websocket:" + item["id"], "title": item["title"],
                           "created_at": timestamp(item["created"]), "updated_at": timestamp(item["updated"]),
                           "preview": preview[:200], "preview_at": timestamp(item["updated"]),
                           "run_started_at": running[0] if running else None, "workspace": None})
        return result

    def delete(self, owner: str, sid: str):
        sid = chat_id(sid)
        self.session(owner, sid)
        desktop = self.db(owner)
        desktop_path = next((row["file"] for row in desktop.execute("PRAGMA database_list") if row["name"] == "main"), "")
        if not desktop_path:
            raise WorkError("invalid_state", "会话存储不可用。", 503)
        db = self.service.store.db
        db.execute("ATTACH DATABASE ? AS hosted_delete_desktop", (desktop_path,))
        try:
            # Both local stores participate in one transaction so a failed delete
            # cannot leave a visible session marked as already deleted.
            with self.service.store.transaction():
                self.service.store.session(owner, sid)
                pending = db.execute(
                    "SELECT 1 FROM runs WHERE owner=? AND session_id=? AND status IN ('running','cancelling','unknown')",
                    (owner, sid)).fetchone()
                run_ids = {row[0] for row in db.execute("SELECT id FROM runs WHERE owner=? AND session_id=?", (owner, sid))}
                tasks = getattr(self.service, "tasks", {})
                processes = getattr(getattr(self.service, "executor", None), "processes", {})
                coordinator = getattr(self.service, "image_coordinator", None)
                image_active = getattr(coordinator, "active_run", None)
                cleanup_pending = any(
                    ((owner, rid) in tasks and not tasks[owner, rid].done())
                    or (owner, rid) in processes
                    or (callable(image_active) and image_active(owner, rid))
                    for rid in run_ids
                )
                file_pending = db.execute(
                    "SELECT 1 FROM workspace_operations WHERE owner=? AND status IN ('running','unknown')", (owner,)).fetchone()
                if pending or file_pending or cleanup_pending:
                    raise WorkError("user_busy", "此会话还有任务在进行或结果待核对，请先停止并确认结果后再删除。", 409)
                billing_pending = db.execute(
                    "SELECT 1 FROM billing_journal WHERE owner=? AND stage NOT IN ('settled','released','rejected') "
                    "AND run_id IN (SELECT id FROM runs WHERE owner=? AND session_id=?)", (owner, owner, sid)).fetchone()
                if billing_pending:
                    raise WorkError("billing_pending", "此会话的计费状态尚未确认，请核对后再删除。", 409)
                image_journal = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_billing_journal'").fetchone()
                if image_journal and db.execute(
                    "SELECT 1 FROM image_billing_journal WHERE owner=? AND stage NOT IN ('settled','released','rejected','free_completed') "
                    "AND run_id IN (SELECT id FROM runs WHERE owner=? AND session_id=?)", (owner, owner, sid)
                ).fetchone():
                    raise WorkError("billing_pending", "此会话的图片计费尚未确认，请核对后再删除。", 409)
                from mona.hosted_work.history_media import (
                    media_references,
                    tool_result_image_references,
                )

                # Include results saved before a child could emit its checkpoint.
                candidates: set[str] = tool_result_image_references(db, owner, sid)
                for table, column, identity in (("sessions", "history", "id"),
                                                ("runs", "checkpoint", "session_id"),
                                                ("conversation_context", "state", "session_id")):
                    for row in db.execute(f"SELECT {column} FROM {table} WHERE owner=? AND {identity}=?", (owner, sid)):
                        candidates.update(media_references(json.loads(row[0])))
                # The authoritative charge and idempotency record remain in Auth.
                db.execute("DELETE FROM billing_journal WHERE owner=? AND run_id IN "
                           "(SELECT id FROM runs WHERE owner=? AND session_id=?)", (owner, owner, sid))
                for table in ("events", "runs", "files", "conversation_context"):
                    if table == "events":
                        db.execute("DELETE FROM events WHERE owner=? AND run_id IN (SELECT id FROM runs WHERE owner=? AND session_id=?)", (owner, owner, sid))
                    else:
                        db.execute(f"DELETE FROM {table} WHERE owner=? AND session_id=?", (owner, sid))
                db.execute("DELETE FROM sessions WHERE owner=? AND id=?", (owner, sid))
                db.execute("INSERT OR IGNORE INTO hosted_delete_desktop.deleted_chats VALUES(?)", (sid,))
                db.execute("DELETE FROM hosted_delete_desktop.transcript WHERE chat_id=?", (sid,))
                sidebar_row = db.execute("SELECT data FROM hosted_delete_desktop.metadata WHERE key='sidebar'").fetchone()
                if sidebar_row:
                    sidebar = json.loads(sidebar_row[0])
                    if not isinstance(sidebar, dict):
                        raise WorkError("invalid_state", "会话列表设置无效。", 503)
                    cleaned = _without_sidebar_sessions(sidebar, {sid})
                    if cleaned != sidebar:
                        cleaned["updated_at"] = timestamp(time.time())
                        db.execute("UPDATE hosted_delete_desktop.metadata SET data=? WHERE key='sidebar'", (encoded(cleaned),))
                active = getattr(self.service, "active_users", set())
                tasks = getattr(self.service, "tasks", {})
                if owner not in active and all(key[0] != owner or task.done() for key, task in tasks.items()):
                    self.service.store.prune_history_media(owner, candidates)
        finally:
            db.execute("DETACH DATABASE hosted_delete_desktop")
