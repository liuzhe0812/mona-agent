"""Keyword-searchable history projected from durable WebUI transcripts."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from pydantic import ValidationError

from mona.agent.partners import (
    MONA_AGENT_ID,
    ConversationMetadata,
    normalize_agent_id,
)
from mona.config.paths import get_conversation_history_dir
from mona.session.manager import SessionManager
from mona.webui.transcript import webui_transcript_path

_SCHEMA_VERSION = 1
_SHORT_QUERY_LENGTH = 3
_SEARCH_PREVIEW_CHARS = 500
_EXCLUDED_MESSAGE_KINDS = frozenset({"progress", "reasoning", "tool_hint"})

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  session_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  status TEXT NOT NULL,
  bad_lines INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  ref TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL,
  task_id TEXT,
  source_start INTEGER NOT NULL,
  source_end INTEGER NOT NULL,
  completed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session
  ON messages(session_key, source_start);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  ref UNINDEXED,
  title,
  content,
  tokenize='trigram'
);
"""


def _encode_cursor(kind: str, offset: int) -> str:
    raw = f"{kind}:{offset}".encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(kind: str, cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded).decode("ascii")
        prefix, value = raw.split(":", 1)
        if prefix != kind:
            raise ValueError
        offset = int(value)
        if offset < 0:
            raise ValueError
        return offset
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("invalid pagination cursor") from exc


def _created_at(record: dict[str, Any]) -> float | None:
    value = record.get("_recorded_at")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    for key in ("created_at", "timestamp", "createdAt"):
        value = record.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value) / 1000 if value > 10_000_000_000 else float(value)
        if isinstance(value, str) and value.strip():
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.timestamp()
            except ValueError:
                continue
    return None


def _timestamp_text(value: float | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()


def _date_bound(value: str | None, *, end: bool) -> float | None:
    if not value:
        return None
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            parsed = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
            return parsed.timestamp() + (86_400 if end else 0)
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError as exc:
        raise ValueError(f"invalid date: {value}") from exc


def _query_tokens(query: str) -> tuple[list[str], list[str]]:
    tokens = re.findall(r"[\w.-]+", query, flags=re.UNICODE)
    return (
        [token for token in tokens if len(token) >= _SHORT_QUERY_LENGTH],
        [token for token in tokens if len(token) < _SHORT_QUERY_LENGTH],
    )


def _fts_expression(tokens: list[str]) -> str | None:
    if not tokens:
        return None
    return " AND ".join(
        f'"{token.replace(chr(34), chr(34) * 2)}"' for token in tokens
    )


def _preview(content: str, query: str) -> str:
    lowered = content.casefold()
    candidates = [query, *re.findall(r"[\w.-]+", query, flags=re.UNICODE)]
    positions = [lowered.find(candidate.casefold()) for candidate in candidates if candidate]
    positions = [pos for pos in positions if pos >= 0]
    center = min(positions) if positions else 0
    start = max(0, center - _SEARCH_PREVIEW_CHARS // 3)
    end = min(len(content), start + _SEARCH_PREVIEW_CHARS)
    start = max(0, end - _SEARCH_PREVIEW_CHARS)
    text = content[start:end]
    return ("…" if start else "") + text + ("…" if end < len(content) else "")


class ConversationHistoryStore:
    """Build and query a per-workspace, per-Agent FTS5 projection."""

    def __init__(
        self,
        workspace: str | Path,
        agent_id: str,
        sessions: SessionManager,
        *,
        index_path: Path | None = None,
        transcript_path: Callable[[str], Path] = webui_transcript_path,
    ) -> None:
        self.workspace = Path(workspace).expanduser().resolve()
        self.agent_id = normalize_agent_id(agent_id)
        self.sessions = sessions
        self._transcript_path = transcript_path
        if index_path is None:
            workspace_hash = hashlib.sha256(
                str(self.workspace).casefold().encode("utf-8")
            ).hexdigest()[:16]
            index_path = (
                get_conversation_history_dir()
                / workspace_hash
                / f"{self.agent_id}.sqlite3"
            )
        self.index_path = index_path

    def _connect(self) -> sqlite3.Connection:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)

        def open_index() -> sqlite3.Connection:
            connection = sqlite3.connect(self.index_path, timeout=3)
            try:
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA busy_timeout=3000")
                version = int(connection.execute("PRAGMA user_version").fetchone()[0])
                if version not in (0, _SCHEMA_VERSION):
                    connection.executescript(
                        "DROP TABLE IF EXISTS messages_fts;"
                        "DROP TABLE IF EXISTS messages;"
                        "DROP TABLE IF EXISTS sources;"
                    )
                connection.executescript(_SCHEMA)
                connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
                connection.commit()
                return connection
            except BaseException:
                connection.close()
                raise

        try:
            return open_index()
        except sqlite3.DatabaseError as exc:
            message = str(exc).casefold()
            if "malformed" not in message and "not a database" not in message:
                raise
            for path in (
                self.index_path,
                Path(f"{self.index_path}-wal"),
                Path(f"{self.index_path}-shm"),
            ):
                path.unlink(missing_ok=True)
            return open_index()

    def _eligible_sessions(self) -> dict[str, str]:
        eligible: dict[str, str] = {}
        for info in self.sessions.list_sessions():
            key = info.get("key")
            if not isinstance(key, str) or not key.startswith("websocket:"):
                continue
            if key.startswith("websocket:ephemeral:"):
                continue
            data = self.sessions.read_session_file(key)
            if data is None:
                continue
            metadata = data.get("metadata")
            metadata = metadata if isinstance(metadata, dict) else {}
            raw_conversation = metadata.get("conversation")
            if raw_conversation is None:
                if self.agent_id != MONA_AGENT_ID:
                    continue
                conversation = ConversationMetadata.direct(MONA_AGENT_ID)
            else:
                try:
                    conversation = ConversationMetadata.model_validate(raw_conversation)
                except ValidationError:
                    continue
            if (
                conversation.type != "direct"
                or conversation.direct_agent_id != self.agent_id
                or conversation.hidden
            ):
                continue
            title = metadata.get("title") or conversation.title or info.get("title") or ""
            eligible[key] = str(title)
        return eligible

    @staticmethod
    def _read_records(path: Path) -> tuple[list[dict[str, Any]], int]:
        records: list[dict[str, Any]] = []
        bad_lines = 0
        with path.open(encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    bad_lines += 1
                    continue
                if isinstance(value, dict):
                    record = dict(value)
                    record["_source_line"] = line_no
                    records.append(record)
                else:
                    bad_lines += 1
        return records, bad_lines

    def _message_ref(
        self,
        session_key: str,
        source_start: int,
        record: dict[str, Any],
        content: str,
    ) -> str:
        event_id = record.get("_event_id")
        stable_event = event_id if isinstance(event_id, str) else str(source_start)
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        digest = hashlib.sha256(
            f"{self.agent_id}\0{session_key}\0{stable_event}\0{content_hash}".encode(
                "utf-8"
            )
        ).hexdigest()[:32]
        return f"conv:{digest}"

    def _project_messages(
        self,
        session_key: str,
        title: str,
        records: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        buffer: list[str] = []
        buffer_start: int | None = None
        buffer_record: dict[str, Any] | None = None

        def add_message(
            role: str,
            content: str,
            source_start: int,
            source_end: int,
            record: dict[str, Any],
            *,
            completed: bool,
        ) -> None:
            content = content.strip()
            if not content:
                return
            if (
                role == "assistant"
                and messages
                and messages[-1]["role"] == "assistant"
                and messages[-1]["content"] == content
            ):
                messages[-1]["source_end"] = source_end
                messages[-1]["completed"] = int(
                    bool(messages[-1]["completed"]) or completed
                )
                return
            messages.append(
                {
                    "ref": self._message_ref(
                        session_key, source_start, record, content
                    ),
                    "session_key": session_key,
                    "title": title,
                    "role": role,
                    "content": content,
                    "created_at": _created_at(record),
                    "task_id": record.get("task_id")
                    if isinstance(record.get("task_id"), str)
                    else None,
                    "source_start": source_start,
                    "source_end": source_end,
                    "completed": int(completed),
                }
            )

        def flush_buffer(source_end: int, *, completed: bool) -> None:
            nonlocal buffer, buffer_start, buffer_record
            if buffer_start is not None and buffer_record is not None:
                add_message(
                    "assistant",
                    "".join(buffer),
                    buffer_start,
                    source_end,
                    buffer_record,
                    completed=completed,
                )
            buffer = []
            buffer_start = None
            buffer_record = None

        for index, record in enumerate(records):
            source_line = int(record["_source_line"])
            event = record.get("event")
            if event == "user":
                if buffer:
                    previous_line = int(records[max(0, index - 1)]["_source_line"])
                    flush_buffer(previous_line, completed=False)
                visible = record.get("display_content")
                if not isinstance(visible, str) or not visible.strip():
                    visible = record.get("text")
                if isinstance(visible, str):
                    add_message(
                        "user", visible, source_line, source_line, record, completed=True
                    )
                continue

            if event == "delta":
                chunk = record.get("text")
                if isinstance(chunk, str) and chunk:
                    if buffer_start is None:
                        buffer_start = source_line
                        buffer_record = record
                    buffer.append(chunk)
                continue

            if event in ("stream_end", "turn_end"):
                if buffer:
                    flush_buffer(source_line, completed=True)
                continue

            if event != "message":
                continue
            if record.get("kind") in _EXCLUDED_MESSAGE_KINDS:
                continue
            content = record.get("text")
            if not isinstance(content, str) or not content.strip():
                continue
            if buffer:
                buffered = "".join(buffer).strip()
                if buffered == content.strip():
                    buffer = []
                    buffer_start = None
                    buffer_record = None
                else:
                    previous_line = int(records[max(0, index - 1)]["_source_line"])
                    flush_buffer(previous_line, completed=True)
            add_message(
                "assistant", content, source_line, source_line, record, completed=True
            )

        if buffer:
            flush_buffer(int(records[-1]["_source_line"]), completed=False)
        return messages

    @staticmethod
    def _delete_source(conn: sqlite3.Connection, session_key: str) -> None:
        refs = [
            row[0]
            for row in conn.execute(
                "SELECT ref FROM messages WHERE session_key = ?", (session_key,)
            )
        ]
        conn.executemany("DELETE FROM messages_fts WHERE ref = ?", ((ref,) for ref in refs))
        conn.execute("DELETE FROM messages WHERE session_key = ?", (session_key,))
        conn.execute("DELETE FROM sources WHERE session_key = ?", (session_key,))

    def _replace_source(
        self,
        conn: sqlite3.Connection,
        session_key: str,
        title: str,
        messages: list[dict[str, Any]],
        *,
        size: int,
        mtime_ns: int,
        bad_lines: int,
    ) -> None:
        self._delete_source(conn, session_key)
        conn.execute(
            "INSERT INTO sources(session_key,title,size,mtime_ns,status,bad_lines) "
            "VALUES(?,?,?,?,?,?)",
            (
                session_key,
                title,
                size,
                mtime_ns,
                "partial" if bad_lines else "complete",
                bad_lines,
            ),
        )
        conn.executemany(
            "INSERT INTO messages(ref,session_key,title,role,content,created_at,task_id,"
            "source_start,source_end,completed) VALUES(:ref,:session_key,:title,:role,"
            ":content,:created_at,:task_id,:source_start,:source_end,:completed)",
            messages,
        )
        conn.executemany(
            "INSERT INTO messages_fts(ref,title,content) VALUES(?,?,?)",
            ((item["ref"], item["title"], item["content"]) for item in messages),
        )

    def sync(self) -> dict[str, int]:
        eligible = self._eligible_sessions()
        stats = {
            "eligible_sessions": len(eligible),
            "indexed_sessions": 0,
            "missing_sessions": 0,
            "partial_sessions": 0,
        }
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = {
                row["session_key"]: row
                for row in conn.execute(
                    "SELECT session_key,title,size,mtime_ns,status FROM sources"
                )
            }
            for stale in set(existing) - set(eligible):
                self._delete_source(conn, stale)

            for session_key, title in eligible.items():
                path = self._transcript_path(session_key)
                if not path.is_file():
                    stats["missing_sessions"] += 1
                    self._delete_source(conn, session_key)
                    continue
                try:
                    before = path.stat()
                    cached = existing.get(session_key)
                    if (
                        cached is not None
                        and int(cached["size"]) == before.st_size
                        and int(cached["mtime_ns"]) == before.st_mtime_ns
                        and str(cached["title"]) == title
                    ):
                        stats["indexed_sessions"] += 1
                        if cached["status"] == "partial":
                            stats["partial_sessions"] += 1
                        continue
                    records, bad_lines = self._read_records(path)
                    after = path.stat()
                    if (
                        before.st_size != after.st_size
                        or before.st_mtime_ns != after.st_mtime_ns
                    ):
                        stats["partial_sessions"] += 1
                        self._delete_source(conn, session_key)
                        continue
                except OSError:
                    stats["missing_sessions"] += 1
                    self._delete_source(conn, session_key)
                    continue
                messages = self._project_messages(session_key, title, records)
                self._replace_source(
                    conn,
                    session_key,
                    title,
                    messages,
                    size=after.st_size,
                    mtime_ns=after.st_mtime_ns,
                    bad_lines=bad_lines,
                )
                stats["indexed_sessions"] += 1
                if bad_lines:
                    stats["partial_sessions"] += 1
            conn.commit()
        return stats

    def search(
        self,
        query: str,
        *,
        limit: int = 5,
        cursor: str | None = None,
        session_key: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query is required")
        limit = max(1, min(int(limit), 20))
        offset = _decode_cursor("search", cursor)
        coverage = self.sync()
        start = _date_bound(date_from, end=False)
        end = _date_bound(date_to, end=True)

        conditions: list[str] = []
        params: list[Any] = []
        if session_key:
            conditions.append("m.session_key = ?")
            params.append(session_key)
        if start is not None:
            conditions.append("m.created_at IS NOT NULL AND m.created_at >= ?")
            params.append(start)
        if end is not None:
            conditions.append("m.created_at IS NOT NULL AND m.created_at < ?")
            params.append(end)
        long_tokens, short_tokens = _query_tokens(query)
        expression = _fts_expression(long_tokens)
        for token in short_tokens:
            conditions.append(
                "(instr(lower(m.content), lower(?)) > 0 "
                "OR instr(lower(m.title), lower(?)) > 0)"
            )
            params.extend((token, token))
        suffix = " AND " + " AND ".join(conditions) if conditions else ""

        with closing(self._connect()) as conn:
            if expression:
                sql = (
                    "SELECT m.*, bm25(messages_fts) AS rank FROM messages_fts "
                    "JOIN messages m ON m.ref = messages_fts.ref "
                    "WHERE messages_fts MATCH ?"
                    f"{suffix} "
                    "ORDER BY CASE WHEN instr(lower(m.content), lower(?)) > 0 THEN 0 ELSE 1 END, "
                    "rank, COALESCE(m.created_at, 0) DESC LIMIT ? OFFSET ?"
                )
                rows = conn.execute(
                    sql, [expression, *params, query, limit + 1, offset]
                ).fetchall()
            else:
                sql = (
                    "SELECT m.*, 0.0 AS rank FROM messages m "
                    "WHERE (instr(lower(m.content), lower(?)) > 0 "
                    "OR instr(lower(m.title), lower(?)) > 0)"
                    f"{suffix} "
                    "ORDER BY COALESCE(m.created_at, 0) DESC LIMIT ? OFFSET ?"
                )
                rows = conn.execute(
                    sql, [query, query, *params, limit + 1, offset]
                ).fetchall()

        eligible_now = self._eligible_sessions()
        rows = [
            row
            for row in rows
            if row["session_key"] in eligible_now
            and self._transcript_path(row["session_key"]).is_file()
        ]
        has_more = len(rows) > limit
        results = []
        for row in rows[:limit]:
            results.append(
                {
                    "ref": row["ref"],
                    "session_key": row["session_key"],
                    "title": row["title"],
                    "role": row["role"],
                    "created_at": _timestamp_text(row["created_at"]),
                    "preview": _preview(row["content"], query),
                    "completed": bool(row["completed"]),
                }
            )
        incomplete = bool(
            coverage["missing_sessions"] or coverage["partial_sessions"]
        )
        return {
            "status": "partial" if incomplete else "ok",
            "coverage": coverage,
            "results": results,
            "next_cursor": _encode_cursor("search", offset + limit)
            if has_more
            else None,
        }

    def read(
        self,
        ref: str,
        *,
        before: int = 2,
        after: int = 2,
        max_chars: int = 8_000,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        before = max(0, min(int(before), 5))
        after = max(0, min(int(after), 5))
        max_chars = max(1_000, min(int(max_chars), 16_000))
        offset = _decode_cursor("read", cursor)
        coverage = self.sync()
        eligible = self._eligible_sessions()
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT session_key,title FROM messages WHERE ref = ?", (ref,)
            ).fetchone()
        if row is None or row["session_key"] not in eligible:
            return {"status": "stale_reference", "ref": ref, "coverage": coverage}

        session_key = row["session_key"]
        path = self._transcript_path(session_key)
        try:
            records, bad_lines = self._read_records(path)
        except OSError:
            return {"status": "stale_reference", "ref": ref, "coverage": coverage}
        messages = self._project_messages(session_key, eligible[session_key], records)
        hit_index = next(
            (index for index, message in enumerate(messages) if message["ref"] == ref),
            None,
        )
        if hit_index is None:
            return {"status": "stale_reference", "ref": ref, "coverage": coverage}

        selected = messages[
            max(0, hit_index - before) : min(len(messages), hit_index + after + 1)
        ]
        blocks = []
        for message in selected:
            stamp = _timestamp_text(message["created_at"]) or "time unknown"
            state = "complete" if message["completed"] else "incomplete"
            blocks.append(
                f"[{message['role']} | {stamp} | {state} | {message['ref']}]\n"
                f"{message['content']}"
            )
        full_text = "\n\n".join(blocks)
        page = full_text[offset : offset + max_chars]
        next_offset = offset + len(page)
        return {
            "status": "partial" if bad_lines else "ok",
            "ref": ref,
            "session_key": session_key,
            "title": row["title"],
            "text": page,
            "truncated": next_offset < len(full_text),
            "next_cursor": _encode_cursor("read", next_offset)
            if next_offset < len(full_text)
            else None,
            "coverage": coverage,
        }
