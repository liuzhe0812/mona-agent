"""sqlite-vec vector store for hoard embeddings.

Each row is one hoard item. Schema: hoard_id, vector.
Stored in the same hoard.sqlite3 DB as a separate vec0 virtual table.

Vector dimension is determined at first upsert from the embedding config.
"""

from __future__ import annotations

import sqlite3
import struct
from pathlib import Path
from typing import Any

from loguru import logger

TABLE = "hoard_vectors"

# Default dimension if we cannot infer from the first vector.
# Will be overridden by the actual embedding dimension on first upsert.
_DEFAULT_DIM = 1024


def _resolve_db_path(db_path: Path | str | None = None) -> Path:
    if db_path is not None:
        return Path(db_path)
    from mona.hoard.models import _hoard_db_path

    return _hoard_db_path()


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.enable_load_extension(True)
        import sqlite_vec

        sqlite_vec.load(conn)
    except Exception as e:
        logger.debug(f"[hoard-vector] sqlite_vec load failed: {e}")
        raise
    return conn


def _ensure_table(conn: sqlite3.Connection, dim: int) -> None:
    conn.execute(
        f"CREATE VIRTUAL TABLE IF NOT EXISTS {TABLE} "
        f"USING vec0(hoard_id text PRIMARY KEY, vector float[{dim}])"
    )
    conn.commit()


def _get_existing_dim(conn: sqlite3.Connection) -> int | None:
    """Return the dimension of an existing hoard_vectors table, or None."""
    # Query the vec0 table schema
    try:
        rows = conn.execute(f"SELECT vector FROM {TABLE} LIMIT 1").fetchall()
        if rows:
            vec_bytes = rows[0][0]
            if isinstance(vec_bytes, bytes):
                return len(vec_bytes) // 4
    except Exception:
        pass
    return None


def _floats_to_bytes(vectors: list[float]) -> bytes:
    return struct.pack(f"{len(vectors)}f", *vectors)


async def upsert_vector(
    hoard_id: str,
    vector: list[float],
    *,
    db_path: Path | str | None = None,
) -> None:
    """Upsert a single hoard item's vector. Existing vector is replaced."""
    if not vector:
        return

    path = _resolve_db_path(db_path)
    try:
        conn = _connect(path)
        try:
            dim = _get_existing_dim(conn) or len(vector)
            _ensure_table(conn, dim)
            # Delete existing vector for this hoard_id (upsert semantics)
            try:
                conn.execute(f"DELETE FROM {TABLE} WHERE hoard_id = ?", (hoard_id,))
            except Exception:
                pass
            conn.execute(
                f"INSERT INTO {TABLE} (hoard_id, vector) VALUES (?, ?)",
                (hoard_id, _floats_to_bytes(vector)),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning(f"[hoard-vector] upsert failed for {hoard_id}: {e}")


async def search_vectors(
    query_vector: list[float],
    *,
    limit: int = 20,
    db_path: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Search hoard vectors by cosine similarity. Returns list of {hoard_id, score}."""
    if not query_vector:
        return []

    path = _resolve_db_path(db_path)
    try:
        conn = _connect(path)
        try:
            dim = _get_existing_dim(conn) or len(query_vector)
            if dim != len(query_vector):
                logger.debug(
                    f"[hoard-vector] dim mismatch: table={dim}, query={len(query_vector)}"
                )
                return []
            _ensure_table(conn, dim)
            rows = conn.execute(
                f"SELECT hoard_id, distance FROM {TABLE} "
                f"WHERE vector MATCH ? AND k = ? "
                f"ORDER BY distance",
                (_floats_to_bytes(query_vector), limit),
            ).fetchall()
            # sqlite-vec returns cosine distance (smaller = more similar)
            # Convert to similarity score in [0, 1]
            return [
                {"hoard_id": r[0], "score": max(0.0, 1.0 - r[1] / 2.0)}
                for r in rows
            ]
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"[hoard-vector] search failed: {e}")
        return []


def delete_vector(hoard_id: str, *, db_path: Path | str | None = None) -> None:
    """Delete a hoard item's vector."""
    path = _resolve_db_path(db_path)
    try:
        conn = sqlite3.connect(str(path))
        try:
            conn.execute(f"DELETE FROM {TABLE} WHERE hoard_id = ?", (hoard_id,))
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.debug(f"[hoard-vector] delete failed for {hoard_id}: {e}")


def count_vectors(*, db_path: Path | str | None = None) -> int:
    """Return the number of vectors in the store."""
    path = _resolve_db_path(db_path)
    try:
        conn = sqlite3.connect(str(path))
        try:
            row = conn.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()
            return row[0] if row else 0
        finally:
            conn.close()
    except Exception:
        return 0
