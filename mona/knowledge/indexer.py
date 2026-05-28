from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any

from loguru import logger

_CJK_RE = re.compile(r"([\u4e00-\u9fff])")


def _preprocess_cjk(text: str | None) -> str:
    if not text:
        return ""
    return _CJK_RE.sub(r" \1 ", text)


_SCHEMA_SQL = """\
CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hash TEXT NOT NULL,
    content TEXT NOT NULL,
    last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title,
    content,
    content=docs,
    content_rowid=id,
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, preprocess_cjk(new.title), preprocess_cjk(new.content));
END;

CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.id, preprocess_cjk(old.title), preprocess_cjk(old.content));
END;

CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.id, preprocess_cjk(old.title), preprocess_cjk(old.content));
    INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, preprocess_cjk(new.title), preprocess_cjk(new.content));
END;
"""


class Indexer:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self.initialize()
        return self._conn  # type: ignore[return-value]

    def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.create_function("preprocess_cjk", 1, _preprocess_cjk)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA_SQL)
        self._conn.commit()
        logger.info("Indexer initialized at {}", self.db_path)

    def upsert(self, *, path: str, title: str, content: str, hash: str) -> None:
        self.conn.execute(
            """INSERT INTO docs (path, title, hash, content)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                   title=excluded.title,
                   hash=excluded.hash,
                   content=excluded.content,
                   last_updated=CURRENT_TIMESTAMP""",
            (path, title, hash, content),
        )
        self._conn.commit()

    def delete(self, path: str) -> None:
        self.conn.execute("DELETE FROM docs WHERE path = ?", (path,))
        self._conn.commit()

    def search(self, query: str, top_k: int = 10) -> list[dict[str, Any]]:
        processed_query = _preprocess_cjk(query)
        try:
            cursor = self.conn.execute(
                """SELECT d.path, d.title, d.hash, d.last_updated, f.rank
                   FROM docs_fts f
                   JOIN docs d ON d.id = f.rowid
                   WHERE docs_fts MATCH ?
                   ORDER BY f.rank
                   LIMIT ?""",
                (processed_query, top_k),
            )
            columns = ["path", "title", "hash", "last_updated", "rank"]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]
        except sqlite3.OperationalError:
            return []

    def get_doc_count(self) -> int:
        cursor = self.conn.execute("SELECT COUNT(*) FROM docs")
        return cursor.fetchone()[0]

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
