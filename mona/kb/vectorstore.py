"""sqlite-vec chunk-level vector store for knowledge base embeddings.

Replaces LanceDB with sqlite-vec for a much smaller footprint (~0.3MB vs ~241MB).

Each row is one CHUNK of a wiki page. Multiple rows per page.
Schema: chunk_id, page_id, chunk_index, chunk_text, heading_path, vector.

Upsert semantics: DELETE all rows for page_id, then ADD new chunks.

Data is stored as a single SQLite database file at
  <project_path>/.llm-wiki/vectorstore.db
"""

from __future__ import annotations

import sqlite3
import struct
from pathlib import Path
from typing import Any

import sqlite_vec
from loguru import logger

TABLE_V2 = "wiki_chunks_v2"


def _db_path(project_path: Path) -> Path:
    return project_path / ".llm-wiki" / "vectorstore.db"


def _validate_page_id(page_id: str) -> None:
    if not page_id or len(page_id) > 256:
        raise ValueError(f"Invalid page_id: {page_id!r}")
    if not all(c.isalnum() or c in "-_." for c in page_id):
        raise ValueError(f"Invalid page_id: {page_id!r}")


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    return conn


def _ensure_table(conn: sqlite3.Connection, dim: int) -> None:
    conn.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS {TABLE_V2} "
        f"USING vec0(chunk_id text PRIMARY KEY, page_id text, chunk_index integer, "
        f"chunk_text text, heading_path text, vector float[{dim}])"
    )
    conn.commit()


def _floats_to_bytes(vectors: list[float]) -> bytes:
    return struct.pack(f"{len(vectors)}f", *vectors)


async def upsert_chunks(project_path: Path, page_id: str, chunks: list[dict[str, Any]]) -> None:
    """Upsert a batch of chunks for a single page. Existing chunks are deleted first."""
    _validate_page_id(page_id)
    if not chunks:
        return

    dim = len(chunks[0]["embedding"])
    if dim == 0:
        raise ValueError("Chunk #0 has empty embedding")

    conn = _connect(_db_path(project_path))
    try:
        _ensure_table(conn, dim)

        # Delete existing chunks for this page
        try:
            conn.execute(f"DELETE FROM {TABLE_V2} WHERE page_id = ?", (page_id,))
        except Exception as e:
            logger.warning(f"[vectorstore] delete before upsert failed for {page_id}: {e}")

        # Insert new chunks
        for c in chunks:
            chunk_id = f"{page_id}#{c['chunk_index']}"
            vector_bytes = _floats_to_bytes(c["embedding"])
            conn.execute(
                f"INSERT INTO {TABLE_V2}(chunk_id, page_id, chunk_index, chunk_text, heading_path, vector) "
                f"VALUES (?, ?, ?, ?, ?, ?)",
                (chunk_id, page_id, c["chunk_index"], c["chunk_text"], c["heading_path"], vector_bytes),
            )

        conn.commit()
    finally:
        conn.close()


async def search_chunks(
    project_path: Path,
    query_embedding: list[float],
    top_k: int = 30,
) -> list[dict[str, Any]]:
    """Search for similar chunks by embedding vector."""
    db_path = _db_path(project_path)
    if not db_path.exists():
        return []

    conn = _connect(db_path)
    try:
        # Check table exists
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (TABLE_V2,)
        ).fetchall()
        if not tables:
            return []

        query_bytes = _floats_to_bytes(query_embedding)
        rows = conn.execute(
            f"SELECT chunk_id, page_id, chunk_index, chunk_text, heading_path, distance "
            f"FROM {TABLE_V2} WHERE vector MATCH ? ORDER BY distance LIMIT ?",
            (query_bytes, top_k),
        ).fetchall()

        out: list[dict[str, Any]] = []
        for row in rows:
            distance = row[5] if row[5] is not None else 1.0
            out.append({
                "chunk_id": row[0] or "",
                "page_id": row[1] or "",
                "chunk_index": row[2] or 0,
                "chunk_text": row[3] or "",
                "heading_path": row[4] or "",
                "score": 1.0 / (1.0 + distance),
            })
        return out
    finally:
        conn.close()


async def delete_page(project_path: Path, page_id: str) -> None:
    """Delete all chunks for a page."""
    _validate_page_id(page_id)
    db_path = _db_path(project_path)
    if not db_path.exists():
        return

    conn = _connect(db_path)
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (TABLE_V2,)
        ).fetchall()
        if not tables:
            return

        conn.execute(f"DELETE FROM {TABLE_V2} WHERE page_id = ?", (page_id,))
        conn.commit()
    finally:
        conn.close()


async def count_chunks(project_path: Path) -> int:
    """Count total chunks in the v2 index."""
    db_path = _db_path(project_path)
    if not db_path.exists():
        return 0

    conn = _connect(db_path)
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (TABLE_V2,)
        ).fetchall()
        if not tables:
            return 0

        row = conn.execute(f"SELECT count(*) FROM {TABLE_V2}").fetchone()
        return row[0] if row else 0
    finally:
        conn.close()
