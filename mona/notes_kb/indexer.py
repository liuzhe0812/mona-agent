"""Notes vault indexing.

Indexes all .md files in the vault root (one level deep — matches Rust-side
`scan_vault_links`) into the sqlite-vec vectorstore. Reuses the KB chunker and
embedding client.

Page IDs use the note id (filename stem) to match the link graph's `node.id`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger

from mona.kb import vectorstore
from mona.kb.chunker import ChunkingOptions, chunk_markdown
from mona.kb.embedding import EmbeddingConfig, fetch_embedding, get_last_embedding_error
from mona.kb.ingest import parse_frontmatter

MONA_DIR_NAME = ".mona"
VECTORSTORE_DB_NAME = "vectorstore.db"


def _vectorstore_db_path(vault: Path) -> Path:
    return vault / MONA_DIR_NAME / VECTORSTORE_DB_NAME


def _scan_note_files(vault: Path) -> list[Path]:
    """Scan one level deep — mirrors Rust-side `scan_vault_links` semantics."""
    if not vault.exists():
        return []
    files: list[Path] = []
    for entry in sorted(vault.iterdir()):
        if entry.is_file() and entry.suffix == ".md":
            files.append(entry)
        elif entry.is_dir() and entry.name != MONA_DIR_NAME and not entry.name.startswith("."):
            for sub in sorted(entry.iterdir()):
                if sub.is_file() and sub.suffix == ".md":
                    files.append(sub)
    return files


async def index_vault(
    vault_path: Path,
    embedding_config: EmbeddingConfig,
    max_chunk_chars: int = 1000,
    overlap_chunk_chars: int = 200,
) -> dict[str, Any]:
    """Index all .md files in the vault into a notes-specific vectorstore.

    Returns {"indexed": int, "failed": int, "skipped": int, "lastError": str | None}.
    """
    if not embedding_config.enabled or not embedding_config.endpoint or not embedding_config.model:
        return {
            "indexed": 0,
            "failed": 0,
            "skipped": 0,
            "lastError": "Embedding not configured",
        }

    if not vault_path.exists():
        return {
            "indexed": 0,
            "failed": 0,
            "skipped": 0,
            "lastError": f"Vault not found: {vault_path}",
        }

    db_path = _vectorstore_db_path(vault_path)
    chunk_opts = ChunkingOptions(
        target_chars=max_chunk_chars,
        overlap_chars=overlap_chunk_chars,
    )

    files = _scan_note_files(vault_path)
    indexed = 0
    failed = 0
    skipped = 0

    for md_file in files:
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning(f"[notes_kb] failed to read {md_file}: {e}")
            failed += 1
            continue

        # page_id is the filename stem (matches Rust-side note id).
        page_id = md_file.stem

        fm, _ = parse_frontmatter(content)
        title = fm.get("title", page_id)

        chunks = chunk_markdown(content, chunk_opts)
        if not chunks:
            skipped += 1
            continue

        rows: list[dict[str, Any]] = []
        for chunk in chunks:
            embed_text = (
                f"{title}\n\n{chunk.heading_path}\n\n{chunk.text}"
                if chunk.heading_path
                else f"{title}\n\n{chunk.text}"
            )
            vec = await fetch_embedding(embed_text, embedding_config)
            if vec:
                rows.append({
                    "chunk_index": chunk.index,
                    "chunk_text": chunk.text,
                    "heading_path": chunk.heading_path,
                    "embedding": vec,
                })
            else:
                failed += 1

        if rows:
            await vectorstore.upsert_chunks(vault_path, page_id, rows, db_path=db_path)
            indexed += 1

    return {
        "indexed": indexed,
        "failed": failed,
        "skipped": skipped,
        "lastError": get_last_embedding_error(),
    }


async def index_vault_status(vault_path: Path) -> dict[str, Any]:
    """Return vectorstore chunk count for the vault."""
    if not vault_path.exists():
        return {"chunkCount": 0, "lastError": None}
    db_path = _vectorstore_db_path(vault_path)
    count = await vectorstore.count_chunks(vault_path, db_path=db_path)
    return {"chunkCount": count, "lastError": get_last_embedding_error()}
