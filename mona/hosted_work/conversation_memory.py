"""Project one hosted account's visible transcript through desktop history search."""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import uuid
from contextlib import closing, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

from mona.agent.tools.conversation_history import ConversationReadTool, ConversationSearchTool
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.frontend import _is_link
from mona.session.conversation_history import _SCHEMA, ConversationHistoryStore

_REF = re.compile(r"^conv:([a-f0-9]{32}):([a-f0-9]{32})$")


@dataclass
class _ScanBudget:
    limit: int
    remaining: int
    exhausted: bool = False

    def charge(self, size: int) -> bool:
        # Even an empty or malformed row consumes time and index metadata.
        size = max(64, size)
        if size > self.remaining:
            self.exhausted = True
            return False
        self.remaining -= size
        return True


_QUERY_BUDGET: ContextVar[_ScanBudget | None] = ContextVar("hosted_conversation_query_budget", default=None)
_CANCEL_SIGNAL: ContextVar[threading.Event | None] = ContextVar("hosted_conversation_cancel", default=None)


def _cancelable_connection(db: sqlite3.Connection) -> None:
    signal = _CANCEL_SIGNAL.get()
    if signal is not None:
        db.set_progress_handler(lambda: int(signal.is_set()), 1000)


def _check_cancelled() -> None:
    signal = _CANCEL_SIGNAL.get()
    if signal is not None and signal.is_set():
        raise sqlite3.OperationalError("conversation search interrupted")


@contextmanager
def conversation_query_budget(config):
    """Share one scan allowance across query variants in one search_memory call."""
    limit = config.history_media_expand_bytes
    budget = _ScanBudget(limit, limit)
    token = _QUERY_BUDGET.set(budget)
    try:
        yield
    finally:
        _QUERY_BUDGET.reset(token)


class _AccountHistory(ConversationHistoryStore):
    """Use desktop projection/FTS without consulting desktop paths or sessions."""

    def __init__(self, scope, run_id: str):
        self.scope, self.run_id = scope, identifier(run_id)
        self.root = Path(scope.ctx.config.state_dir)
        self.state_db = self.root / "sessions.sqlite3"
        self.transcript_db = self.root / "users" / scope.owner / "desktop.sqlite3"
        self._local = threading.local()
        super().__init__("/workspace", "mona", None, index_path=scope.directory / ".unused-index",
                         transcript_path=lambda key: _Transcript(self, key))

    @contextmanager
    def _operation(self, *, target: str | None, cache_read: bool = False):
        """Each call has an isolated in-memory FTS shared only by its connections."""
        if getattr(self._local, "operation", None) is not None:
            raise OSError("account conversation search is already running")
        limit = self.scope.ctx.config.history_media_expand_bytes
        budget = _QUERY_BUDGET.get() or _ScanBudget(limit, limit)
        uri = f"file:mona-conversation-{uuid.uuid4().hex}?mode=memory&cache=shared"
        anchor = sqlite3.connect(uri, uri=True, timeout=0.25)
        try:
            _cancelable_connection(anchor)
            anchor.execute("PRAGMA temp_store=MEMORY")
            anchor.execute("PRAGMA journal_mode=MEMORY")
            page_size = anchor.execute("PRAGMA page_size").fetchone()[0]
            max_pages = max(1, math.floor(limit / page_size))
            actual_pages = anchor.execute(f"PRAGMA max_page_count={max_pages}").fetchone()[0]
            if actual_pages > max_pages:
                raise OSError("account conversation index budget unavailable")
            anchor.executescript(_SCHEMA)
            self._local.operation = SimpleNamespace(uri=uri, anchor=anchor, budget=budget,
                                                    target=target, omitted=False, cache_read=cache_read,
                                                    read_cache=None, source_changed=False)
            yield
        finally:
            self._local.operation = None
            anchor.close()

    def _safe_file(self, path: Path, *, required: bool) -> bool:
        try:
            if any(_is_link(item) for item in (*reversed(path.parents), path)):
                raise ValueError
            if not path.exists():
                if required:
                    raise ValueError
                return False
            if not path.is_file() or path.stat().st_nlink != 1:
                raise ValueError
            return True
        except (OSError, ValueError):
            raise OSError("account conversation store unavailable") from None

    @contextmanager
    def source(self, *, transcript: bool):
        try:
            self.scope.check()
        except WorkError:
            raise OSError("account conversation scope unavailable") from None
        self._safe_file(self.state_db, required=True)
        present = self._safe_file(self.transcript_db, required=False)
        for database in (self.state_db, self.transcript_db):
            for suffix in ("-wal", "-shm", "-journal"):
                self._safe_file(Path(str(database) + suffix), required=False)
        if transcript and not present:
            raise OSError("account conversation transcript unavailable")
        db = sqlite3.connect(self.state_db.as_uri() + "?mode=ro", uri=True, timeout=0.25)
        try:
            _cancelable_connection(db)
            if present:
                db.execute("ATTACH DATABASE ? AS desktop", (self.transcript_db.as_uri() + "?mode=ro",))
            db.execute("PRAGMA query_only=ON")
            active = db.execute("SELECT 1 FROM runs WHERE owner=? AND id=? AND session_id=? "
                                "AND status IN ('running','cancelling')",
                                (self.scope.owner, self.run_id, self.scope.session_id)).fetchone()
            if active is None:
                raise OSError("account conversation scope unavailable")
            yield db, present
        finally:
            db.close()

    def _eligible_sessions(self) -> dict[str, str]:
        operation = self._local.operation
        with self.source(transcript=False) as (db, present):
            deleted = "AND NOT EXISTS (SELECT 1 FROM desktop.deleted_chats d WHERE d.chat_id=s.id)" if present else ""
            target = " AND s.id=?" if operation.target else ""
            params = [self.scope.owner, *([operation.target] if operation.target else []),
                      self.scope.ctx.config.max_sessions_per_user + 1]
            rows = db.execute("SELECT s.id,s.title FROM sessions s WHERE s.owner=? " + deleted + target +
                              " ORDER BY s.updated DESC,s.id LIMIT ?", params).fetchall()
        if len(rows) > self.scope.ctx.config.max_sessions_per_user:
            operation.omitted = True
            rows = rows[:self.scope.ctx.config.max_sessions_per_user]
        return {"websocket:" + identifier(sid): str(title) for sid, title in rows}

    def _connect(self):
        try:
            self.scope.check()
        except WorkError:
            raise OSError("account conversation index unavailable") from None
        operation = getattr(self._local, "operation", None)
        if operation is None:
            raise OSError("account conversation search is not active")
        db = sqlite3.connect(operation.uri, uri=True, timeout=0.25)
        _cancelable_connection(db)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA temp_store=MEMORY")
        return db

    def sync(self):
        """Index this call's bounded snapshot using the shared desktop projector."""
        eligible = self._eligible_sessions()
        operation = self._local.operation
        stats = {"eligible_sessions": len(eligible), "indexed_sessions": 0,
                 "missing_sessions": 0, "partial_sessions": int(operation.omitted),
                 "budget_exceeded": bool(operation.omitted), "scanned_bytes": 0}
        with closing(self._connect()) as db:
            for index, (key, title) in enumerate(eligible.items()):
                _check_cancelled()
                if operation.budget.exhausted:
                    stats["partial_sessions"] += len(eligible) - index
                    stats["budget_exceeded"] = True
                    break
                path = self._transcript_path(key)
                if not path.is_file():
                    stats["missing_sessions"] += 1
                    continue
                try:
                    before = path.stat()
                    records, bad_lines = self._read_records(path)
                    after = path.stat()
                    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                        stats["partial_sessions"] += 1
                        continue
                except OSError:
                    stats["missing_sessions"] += 1
                    continue
                messages = self._project_messages(key, title, records)
                _check_cancelled()
                try:
                    db.execute("BEGIN")
                    self._replace_source(db, key, title, messages, size=after.st_size,
                                         mtime_ns=after.st_mtime_ns, bad_lines=bad_lines)
                    db.commit()
                except sqlite3.Error as error:
                    if db.in_transaction:
                        db.rollback()
                    if getattr(error, "sqlite_errorcode", None) != sqlite3.SQLITE_FULL:
                        raise
                    # The per-call in-memory FTS reached its page limit; keep
                    # earlier committed sessions and report incomplete coverage.
                    stats["partial_sessions"] += len(eligible) - index
                    stats["budget_exceeded"] = True
                    break
                stats["indexed_sessions"] += 1
                if operation.cache_read and path.sid == operation.target:
                    # Desktop read() projects the transcript again after sync.
                    # Keep this already bounded snapshot so it does not consume
                    # the same request's scan allowance a second time.
                    operation.read_cache = (after.st_size, after.st_mtime_ns, records, bad_lines)
                if bad_lines:
                    stats["partial_sessions"] += 1
                if operation.budget.exhausted:
                    stats["budget_exceeded"] = True
        stats["scanned_bytes"] = operation.budget.limit - operation.budget.remaining
        return stats

    def _read_records(self, path):
        operation = self._local.operation
        cached = operation.read_cache
        if operation.cache_read and cached is not None and path.sid == operation.target:
            current = path.stat()
            if (current.st_size, current.st_mtime_ns) != cached[:2]:
                operation.source_changed = True
                raise OSError("account conversation changed during read")
            return cached[2], cached[3]
        return super()._read_records(path)

    def _message_ref(self, session_key, source_start, record, content):
        # The desktop digest is scoped by workspace; bind the hosted variant to
        # its owner as well, even if two accounts use identical session IDs.
        original = super()._message_ref(session_key, source_start, record, content)
        digest = hashlib.sha256((self.scope.owner + "\0" + original).encode()).hexdigest()[:32]
        return "conv:" + identifier(session_key.removeprefix("websocket:")) + ":" + digest

    def search(self, query, **kwargs):
        session_key = kwargs.get("session_key")
        target = None
        if session_key:
            if not isinstance(session_key, str) or not session_key.startswith("websocket:"):
                raise ValueError("invalid conversation session filter")
            try:
                target = identifier(session_key.removeprefix("websocket:"))
            except WorkError:
                raise ValueError("invalid conversation session filter") from None
        with self._operation(target=target):
            return super().search(query, **kwargs)

    def read(self, ref, **kwargs):
        match = _REF.fullmatch(ref) if isinstance(ref, str) else None
        if match is None:
            return {"status": "stale_reference", "ref": ref, "coverage": {}}
        with self._operation(target=match.group(1), cache_read=True):
            result = super().read(ref, **kwargs)
            operation = self._local.operation
            key = "websocket:" + match.group(1)
            # A delete may race the index lookup. Never return a snapshot after
            # the owner-scoped session or its transcript has disappeared.
            if key not in self._eligible_sessions():
                return {"status": "stale_reference", "ref": ref, "coverage": result.get("coverage", {})}
            try:
                current = self._transcript_path(key).stat()
            except FileNotFoundError:
                return {"status": "stale_reference", "ref": ref, "coverage": result.get("coverage", {})}
            if operation.read_cache and (current.st_size, current.st_mtime_ns) != operation.read_cache[:2]:
                operation.source_changed = True
            coverage = result.get("coverage", {})
            if operation.budget.exhausted:
                coverage = {**coverage, "budget_exceeded": True,
                            "scanned_bytes": operation.budget.limit - operation.budget.remaining}
            if operation.source_changed:
                return {"status": "partial", "ref": ref, "coverage": {**coverage, "source_changed": True}}
            if result.get("status") == "stale_reference" and coverage.get("budget_exceeded"):
                return {"status": "partial", "ref": ref, "coverage": coverage}
            if operation.budget.exhausted:
                result["coverage"] = coverage
                result["status"] = "partial"
            if result.get("session_key") != key:
                return {"status": "stale_reference", "ref": ref, "coverage": result.get("coverage", {})}
            return result


class _Transcript:
    """Present a read-only owner-bound SQLite transcript to the desktop index."""

    def __init__(self, store: _AccountHistory, key: str):
        if not isinstance(key, str) or not key.startswith("websocket:"):
            raise ValueError("invalid conversation key")
        self.store, self.sid = store, identifier(key.removeprefix("websocket:"))

    def _rows(self, db):
        return db.execute(
            "SELECT t.seq,t.event_key,length(CAST(t.data AS BLOB)),t.created FROM desktop.transcript t "
            "JOIN sessions s ON s.id=t.chat_id AND s.owner=? "
            "WHERE t.chat_id=? AND NOT EXISTS "
            "(SELECT 1 FROM desktop.deleted_chats d WHERE d.chat_id=t.chat_id) ORDER BY t.seq",
            (self.store.scope.owner, self.sid),
        )

    def stat(self):
        with self.store.source(transcript=False) as (db, present):
            if not present:
                raise FileNotFoundError
            row = db.execute(
                "SELECT COALESCE(MAX(t.seq),0) FROM desktop.transcript t "
                "JOIN sessions s ON s.id=t.chat_id AND s.owner=? WHERE t.chat_id=? "
                "AND NOT EXISTS (SELECT 1 FROM desktop.deleted_chats d WHERE d.chat_id=t.chat_id)",
                (self.store.scope.owner, self.sid),
            ).fetchone()
        if not row or not row[0]:
            raise FileNotFoundError
        # Hosted transcripts are append-only; max(seq) changes on each append.
        return SimpleNamespace(st_size=row[0], st_mtime_ns=row[0])

    def is_file(self):
        try:
            self.stat()
            return True
        except FileNotFoundError:
            return False

    @contextmanager
    def open(self, *, encoding: str):
        if encoding != "utf-8":
            raise ValueError("invalid transcript encoding")
        with self.store.source(transcript=True) as (db, _):
            def lines():
                budget = self.store._local.operation.budget
                for seq, event_key, raw_size, created in self._rows(db):
                    _check_cancelled()
                    try:
                        if type(raw_size) is not int or raw_size < 0:
                            raise ValueError
                        if not budget.charge(raw_size):
                            yield "{conversation scan budget exhausted}"
                            return
                        if raw_size > self.store.scope.ctx.config.max_history_bytes:
                            raise ValueError
                        row = db.execute(
                            "SELECT t.data FROM desktop.transcript t JOIN sessions s "
                            "ON s.id=t.chat_id AND s.owner=? WHERE t.chat_id=? AND t.seq=? "
                            "AND NOT EXISTS (SELECT 1 FROM desktop.deleted_chats d WHERE d.chat_id=t.chat_id)",
                            (self.store.scope.owner, self.sid, seq),
                        ).fetchone()
                        if row is None or not isinstance(row[0], str):
                            raise ValueError
                        raw = row[0]
                        if len(raw.encode("utf-8")) != raw_size:
                            raise ValueError
                        record = json.loads(raw)
                        if not isinstance(record, dict):
                            raise ValueError
                        event = record.get("event")
                        if event not in {"user", "delta", "stream_end", "turn_end", "message"}:
                            continue
                        if event == "message" and record.get("kind") in {"progress", "reasoning", "tool_hint"}:
                            continue
                        record = {key: record[key] for key in ("event", "text", "display_content", "kind", "task_id",
                                  "_event_id", "_recorded_at", "created_at", "timestamp", "createdAt") if key in record}
                        record.setdefault("_event_id", event_key)
                        record.setdefault("_recorded_at", created)
                        line = json.dumps(record, ensure_ascii=False)
                        yield line
                    except (TypeError, ValueError):
                        yield "{invalid transcript record}"
            yield lines()


def conversation_tools(ctx, scope):
    """Desktop search/read tool facades with a hosted-only source adapter."""
    try:
        run_id = ctx.payload["run_id"]
    except (AttributeError, KeyError, TypeError):
        raise WorkError("runtime_scope", "会话记忆不属于当前账户。", 403) from None
    store = _AccountHistory(scope, run_id)
    return _ConversationSearch(store), _ConversationRead(store)


class _CancelableConversation:
    async def execute(self, *args, **kwargs):
        # The desktop tool runs its index in a worker thread. Cancelling an
        # await does not stop that thread; signal the bounded SQLite scan too.
        signal = threading.Event()
        token = _CANCEL_SIGNAL.set(signal)
        try:
            return await super().execute(*args, **kwargs)
        finally:
            signal.set()
            _CANCEL_SIGNAL.reset(token)


class _ConversationSearch(_CancelableConversation, ConversationSearchTool):
    def __init__(self, store):
        self._store = store


class _ConversationRead(_CancelableConversation, ConversationReadTool):
    def __init__(self, store):
        self._store = store
