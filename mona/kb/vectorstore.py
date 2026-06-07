"""LanceDB v2 chunk-level vector store for knowledge base embeddings.

Ported from llm_wiki_tmp/src-tauri/src/commands/vectorstore.rs.

Each row is one CHUNK of a wiki page. Multiple rows per page.
Schema: chunk_id, page_id, chunk_index, chunk_text, heading_path, vector.

Upsert semantics: DELETE all rows for page_id, then ADD new chunks.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import lancedb
import pyarrow as pa
from loguru import logger

TABLE_V2 = "wiki_chunks_v2"


def _db_path(project_path: Path) -> str:
    return str(project_path / ".llm-wiki" / "lancedb").replace("\\", "/")


def _validate_page_id(page_id: str) -> None:
    if not page_id or len(page_id) > 256:
        raise ValueError(f"Invalid page_id: {page_id!r}")
    if not all(c.isalnum() or c in "-_." for c in page_id):
        raise ValueError(f"Invalid page_id: {page_id!r}")


def _make_schema(dim: int) -> pa.Schema:
    return pa.schema([
        pa.field("chunk_id", pa.utf8(), nullable=False),
        pa.field("page_id", pa.utf8(), nullable=False),
        pa.field("chunk_index", pa.uint32(), nullable=False),
        pa.field("chunk_text", pa.utf8(), nullable=False),
        pa.field("heading_path", pa.utf8(), nullable=False),
        pa.field("vector", pa.list_(pa.float32(), dim), nullable=False),
    ])


def _make_batch(
    page_id: str,
    chunks: list[dict[str, Any]],
    dim: int,
) -> pa.RecordBatch:
    chunk_ids = [f"{page_id}#{c['chunk_index']}" for c in chunks]
    page_ids = [page_id] * len(chunks)
    indexes = [c["chunk_index"] for c in chunks]
    texts = [c["chunk_text"] for c in chunks]
    heading_paths = [c["heading_path"] for c in chunks]
    flat_vectors: list[float] = []
    for c in chunks:
        emb = c["embedding"]
        if len(emb) != dim:
            raise ValueError(f"Chunk #{c['chunk_index']} has dim {len(emb)}, expected {dim}")
        flat_vectors.extend(emb)

    vector_array = pa.FixedSizeListArray.from_arrays(
        pa.array(flat_vectors, type=pa.float32()),
        dim,
    )

    return pa.RecordBatch.from_pydict({
        "chunk_id": chunk_ids,
        "page_id": page_ids,
        "chunk_index": indexes,
        "chunk_text": texts,
        "heading_path": heading_paths,
        "vector": vector_array,
    }, schema=_make_schema(dim))


async def upsert_chunks(project_path: Path, page_id: str, chunks: list[dict[str, Any]]) -> None:
    """Upsert a batch of chunks for a single page. Existing chunks are deleted first."""
    _validate_page_id(page_id)
    if not chunks:
        return

    dim = len(chunks[0]["embedding"])
    if dim == 0:
        raise ValueError("Chunk #0 has empty embedding")

    db = lancedb.connect(_db_path(project_path))
    batch = _make_batch(page_id, chunks, dim)
    data = [batch]

    table_names = db.table_names()
    if TABLE_V2 in table_names:
        table = db.open_table(TABLE_V2)
        try:
            table.delete(f"page_id = '{page_id}'")
        except Exception as e:
            logger.warning(f"[vectorstore] delete before upsert failed for {page_id}: {e}")
        table.add(data)
    else:
        db.create_table(TABLE_V2, data)


async def search_chunks(
    project_path: Path,
    query_embedding: list[float],
    top_k: int = 30,
) -> list[dict[str, Any]]:
    """Search for similar chunks by embedding vector."""
    db = lancedb.connect(_db_path(project_path))

    if TABLE_V2 not in db.table_names():
        return []

    table = db.open_table(TABLE_V2)
    results = table.search(query_embedding).limit(top_k).to_list()

    out: list[dict[str, Any]] = []
    for row in results:
        distance = row.get("_distance", 1.0)
        out.append({
            "chunk_id": row.get("chunk_id", ""),
            "page_id": row.get("page_id", ""),
            "chunk_index": row.get("chunk_index", 0),
            "chunk_text": row.get("chunk_text", ""),
            "heading_path": row.get("heading_path", ""),
            "score": 1.0 / (1.0 + distance),
        })
    return out


async def delete_page(project_path: Path, page_id: str) -> None:
    """Delete all chunks for a page."""
    _validate_page_id(page_id)
    db = lancedb.connect(_db_path(project_path))

    if TABLE_V2 not in db.table_names():
        return

    table = db.open_table(TABLE_V2)
    table.delete(f"page_id = '{page_id}'")


async def count_chunks(project_path: Path) -> int:
    """Count total chunks in the v2 index."""
    db = lancedb.connect(_db_path(project_path))

    if TABLE_V2 not in db.table_names():
        return 0

    table = db.open_table(TABLE_V2)
    return table.count_rows()
