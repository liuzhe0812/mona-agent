"""Hoard data models and SQLite operations.

The hoard.sqlite3 DB is created and managed by the Rust side (hoard.rs).
Python side accesses it via direct sqlite3 connection (same file).
Tauri commands are used for CRUD operations from the frontend.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def _tokenize_query(query: str) -> list[str]:
    """查询分词：空白切分拉丁文，CJK 连续段切 2-gram。

    对齐 mona/kb/search.py 的实现，保证 Rust/Python/KB 三侧分词一致。
    """
    tokens: list[str] = []
    for raw in query.split():
        if not raw.strip():
            continue
        if _CJK_RE.search(raw):
            for run in _CJK_RE.findall(raw):
                if len(run) == 1:
                    tokens.append(run.lower())
                else:
                    for i in range(len(run) - 1):
                        tokens.append(run[i : i + 2].lower())
            for part in _CJK_RE.split(raw):
                if part.strip():
                    tokens.append(part.lower())
        else:
            tokens.append(raw.lower())
    return tokens


def _hoard_db_path() -> Path:
    """Resolve hoard.sqlite3 path under app data dir.

    Must match Rust's app_data_dir() = dirs::data_dir().join("mona").
    - Windows: %APPDATA%/mona/hoard/hoard.sqlite3
    - macOS: ~/Library/Application Support/mona/hoard/hoard.sqlite3
    - Linux: ~/.local/share/mona/hoard/hoard.sqlite3
    """
    import os
    import sys

    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))

    return base / "mona" / "hoard" / "hoard.sqlite3"


@dataclass
class HoardItem:
    """A single hoard entry (URL or fragment)."""

    id: str
    url: str | None = None
    title: str = ""
    content: str | None = None
    summary: str | None = None
    tags: list[str] = field(default_factory=list)
    source: str = "manual"  # 'browser'|'email'|'note'|'chat'|'manual'
    source_ref: str | None = None
    source_strength: float = 1.0
    asset_path: str | None = None
    created_at: int = 0
    last_accessed_at: int | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["tags"] = json.dumps(self.tags, ensure_ascii=False)
        return d

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> HoardItem:
        tags_raw = row["tags"]
        tags = json.loads(tags_raw) if tags_raw else []
        return cls(
            id=row["id"],
            url=row["url"],
            title=row["title"],
            content=row["content"],
            summary=row["summary"],
            tags=tags,
            source=row["source"],
            source_ref=row["source_ref"],
            source_strength=row["source_strength"],
            asset_path=row["asset_path"],
            created_at=row["created_at"],
            last_accessed_at=row["last_accessed_at"],
        )


class HoardManager:
    """Direct SQLite access to hoard.sqlite3 (bypassing Tauri for Python-side tools)."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or _hoard_db_path()
        self._ensure_db()

    def _ensure_db(self) -> None:
        """Create tables if missing. Rust side also does this; both sides are idempotent."""
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = self._connect_raw()
            try:
                conn.executescript(
                    """
                    PRAGMA journal_mode=WAL;
                    CREATE TABLE IF NOT EXISTS hoards (
                        id TEXT PRIMARY KEY,
                        url TEXT,
                        title TEXT NOT NULL,
                        content TEXT,
                        summary TEXT,
                        tags TEXT,
                        source TEXT NOT NULL,
                        source_ref TEXT,
                        source_strength REAL DEFAULT 1.0,
                        asset_path TEXT,
                        created_at INTEGER NOT NULL,
                        last_accessed_at INTEGER
                    );
                    CREATE INDEX IF NOT EXISTS idx_hoards_url ON hoards(url);
                    CREATE INDEX IF NOT EXISTS idx_hoards_source ON hoards(source);
                    CREATE INDEX IF NOT EXISTS idx_hoards_created ON hoards(created_at);
                    CREATE TABLE IF NOT EXISTS hoard_relations (
                        hoard_id TEXT NOT NULL,
                        related_type TEXT NOT NULL,
                        related_id TEXT NOT NULL,
                        related_meta TEXT,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY (hoard_id, related_type, related_id)
                    );
                    """
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.debug(f"[hoard] _ensure_db skipped: {e}")

    def _connect_raw(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=5.0)
        return conn

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def add(
        self,
        *,
        url: str | None = None,
        title: str,
        content: str | None = None,
        summary: str | None = None,
        tags: list[str] | None = None,
        source: str = "manual",
        source_ref: str | None = None,
        source_strength: float = 1.0,
        asset_path: str | None = None,
    ) -> str:
        """Insert a new hoard item. Returns the hoard id."""
        import time
        import uuid

        hoard_id = f"hoard-{uuid.uuid4()}"
        now = int(time.time())
        tags_json = json.dumps(tags or [], ensure_ascii=False)

        conn = self._connect()
        try:
            conn.execute(
                """INSERT INTO hoards
                   (id, url, title, content, summary, tags, source, source_ref, source_strength, asset_path, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (hoard_id, url, title, content, summary, tags_json, source, source_ref, source_strength, asset_path, now),
            )
            conn.commit()
            return hoard_id
        finally:
            conn.close()

    def update(
        self,
        hoard_id: str,
        *,
        title: str | None = None,
        content: str | None = None,
        summary: str | None = None,
        tags: list[str] | None = None,
        asset_path: str | None = None,
    ) -> None:
        """Update fields of a hoard item."""
        updates: list[str] = []
        params: list[Any] = []
        if title is not None:
            updates.append("title = ?")
            params.append(title)
        if content is not None:
            updates.append("content = ?")
            params.append(content)
        if summary is not None:
            updates.append("summary = ?")
            params.append(summary)
        if tags is not None:
            updates.append("tags = ?")
            params.append(json.dumps(tags, ensure_ascii=False))
        if asset_path is not None:
            updates.append("asset_path = ?")
            params.append(asset_path)
        if not updates:
            return
        params.append(hoard_id)
        conn = self._connect()
        try:
            conn.execute(f"UPDATE hoards SET {', '.join(updates)} WHERE id = ?", params)
            conn.commit()
        finally:
            conn.close()

    def delete(self, hoard_id: str) -> None:
        conn = self._connect()
        try:
            conn.execute("DELETE FROM hoard_relations WHERE hoard_id = ?", (hoard_id,))
            conn.execute("DELETE FROM hoards WHERE id = ?", (hoard_id,))
            conn.commit()
        finally:
            conn.close()

    def get(self, hoard_id: str) -> HoardItem | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM hoards WHERE id = ?", (hoard_id,)
            ).fetchone()
            return HoardItem.from_row(row) if row else None
        finally:
            conn.close()

    def list_items(
        self, source: str | None = None, limit: int = 100, offset: int = 0
    ) -> list[HoardItem]:
        conn = self._connect()
        try:
            if source:
                rows = conn.execute(
                    "SELECT * FROM hoards WHERE source = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    (source, limit, offset),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM hoards ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                ).fetchall()
            return [HoardItem.from_row(r) for r in rows]
        finally:
            conn.close()

    def search(
        self,
        query: str,
        source: str | None = None,
        limit: int = 20,
        exclude_sources: list[str] | None = None,
    ) -> list[HoardItem]:
        """Multi-token LIKE search with additive scoring.

        Query is split on whitespace into tokens; each token independently
        matches (title +3, tags +2, summary +2, content +1). Total score is
        summed across tokens and multiplied by source_strength.

        When ``exclude_sources`` is provided, matching rows from those sources
        are excluded at the SQL level — this is used by the subscription gate
        to filter out ``note`` and ``email`` sources for free-tier users.
        """
        tokens = _tokenize_query(query)
        if not tokens:
            return []

        conn = self._connect()
        try:
            # Build per-token scoring expression summed across all tokens.
            # Each token contributes: title hit +3, tags +2, summary +2, content +1.
            score_terms: list[str] = []
            score_params: list[str] = []
            where_clauses: list[str] = []
            where_params: list[str] = []

            for tok in tokens:
                pat = f"%{tok}%"
                score_terms.append(
                    "(CASE WHEN LOWER(title) LIKE ? THEN 3 ELSE 0 END"
                    " + CASE WHEN LOWER(tags) LIKE ? THEN 2 ELSE 0 END"
                    " + CASE WHEN LOWER(summary) LIKE ? THEN 2 ELSE 0 END"
                    " + CASE WHEN LOWER(COALESCE(content,'')) LIKE ? THEN 1 ELSE 0 END)"
                )
                score_params.extend([pat, pat, pat, pat])
                where_clauses.append(
                    "(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? "
                    "OR LOWER(tags) LIKE ? OR LOWER(COALESCE(content,'')) LIKE ?)"
                )
                where_params.extend([pat, pat, pat, pat])

            order_expr = f"({' + '.join(score_terms)}) * source_strength"
            where_sql = " OR ".join(where_clauses)

            # Apply exclusions even when a specific source is requested.
            source_filters: list[str] = []
            source_params: list[str] = []
            if source:
                source_filters.append("source = ?")
                source_params.append(source)
            if exclude_sources:
                placeholders = ", ".join("?" for _ in exclude_sources)
                source_filters.append(f"source NOT IN ({placeholders})")
                source_params.extend(exclude_sources)
            source_clause = (
                " AND ".join(source_filters) + " AND " if source_filters else ""
            )

            sql = (
                f"SELECT * FROM hoards WHERE {source_clause}({where_sql}) "
                f"ORDER BY {order_expr} DESC LIMIT ?"
            )
            rows = conn.execute(
                sql,
                [*source_params, *where_params, *score_params, limit],
            ).fetchall()
            return [HoardItem.from_row(r) for r in rows]
        finally:
            conn.close()

    def count(self) -> int:
        conn = self._connect()
        try:
            return conn.execute("SELECT COUNT(*) FROM hoards").fetchone()[0]
        finally:
            conn.close()

    def add_relation(
        self,
        hoard_id: str,
        related_type: str,
        related_id: str,
        related_meta: dict | None = None,
    ) -> None:
        import time

        conn = self._connect()
        try:
            conn.execute(
                "INSERT OR IGNORE INTO hoard_relations (hoard_id, related_type, related_id, related_meta, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    hoard_id,
                    related_type,
                    related_id,
                    json.dumps(related_meta, ensure_ascii=False) if related_meta else None,
                    int(time.time()),
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def get_relations(self, hoard_id: str) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT related_type, related_id, related_meta, created_at FROM hoard_relations WHERE hoard_id = ? ORDER BY created_at",
                (hoard_id,),
            ).fetchall()
            result = []
            for r in rows:
                meta = json.loads(r["related_meta"]) if r["related_meta"] else None
                result.append({
                    "type": r["related_type"],
                    "id": r["related_id"],
                    "meta": meta,
                    "created_at": r["created_at"],
                })
            return result
        finally:
            conn.close()

    def find_by_url(self, url: str) -> list[HoardItem]:
        """Find all hoard items with matching URL (for cross-source association)."""
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM hoards WHERE url = ? ORDER BY created_at DESC",
                (url,),
            ).fetchall()
            return [HoardItem.from_row(r) for r in rows]
        except Exception as e:
            logger.debug(f"[hoard] find_by_url failed: {e}")
            return []
        finally:
            conn.close()
