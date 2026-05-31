from __future__ import annotations

import re
import sqlite3
from pathlib import Path


def _preprocess_cjk(text: str) -> str:
    """Insert spaces between CJK characters for FTS5 tokenization."""
    return re.sub(
        r"([\u4e00-\u9fff])([\u4e00-\u9fff])",
        r"\1 \2",
        text,
    )


class WikiIndexer:
    """SQLite FTS5 index for wiki page content."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def initialize(self) -> None:
        conn = self._connect()
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages USING fts5(
                path,
                title,
                content,
                kind,
                tokenize='unicode61'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS wiki_meta (
                path TEXT PRIMARY KEY,
                title TEXT,
                kind TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()
        conn.close()

    def index_page(self, path: str, title: str, content: str, kind: str) -> None:
        conn = self._connect()
        processed = _preprocess_cjk(content)
        conn.execute(
            "INSERT OR REPLACE INTO wiki_pages (path, title, content, kind) VALUES (?, ?, ?, ?)",
            (path, title, processed, kind),
        )
        conn.execute(
            "INSERT OR REPLACE INTO wiki_meta (path, title, kind, updated_at) VALUES (?, ?, ?, datetime('now'))",
            (path, title, kind),
        )
        conn.commit()
        conn.close()

    def remove_page(self, path: str) -> None:
        conn = self._connect()
        conn.execute("DELETE FROM wiki_pages WHERE path = ?", (path,))
        conn.execute("DELETE FROM wiki_meta WHERE path = ?", (path,))
        conn.commit()
        conn.close()

    def search(self, query: str, limit: int = 10) -> list[dict]:
        conn = self._connect()
        processed = _preprocess_cjk(query)
        try:
            cursor = conn.execute(
                """
                SELECT path, title, content, rank
                FROM wiki_pages
                WHERE wiki_pages MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (processed, limit),
            )
            rows = cursor.fetchall()
        except sqlite3.OperationalError:
            rows = []
        conn.close()

        results: list[dict] = []
        for row in rows:
            content = row[2] or ""
            snippet = content[:300] + "..." if len(content) > 300 else content
            results.append({
                "path": row[0],
                "title": row[1],
                "snippet": snippet,
                "rank": row[3],
            })
        return results

    def get_doc_count(self) -> int:
        conn = self._connect()
        cursor = conn.execute("SELECT COUNT(*) FROM wiki_meta")
        count = cursor.fetchone()[0]
        conn.close()
        return count

    def clear(self) -> None:
        conn = self._connect()
        conn.execute("DELETE FROM wiki_pages")
        conn.execute("DELETE FROM wiki_meta")
        conn.commit()
        conn.close()
