"""Notes vault hybrid search.

Reuses KB's keyword + vector + RRF pipeline, scoped to the vault root directory
and the notes-specific vectorstore db.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mona.kb.embedding import EmbeddingConfig
from mona.kb.search import search_wiki_hybrid


async def search_notes_hybrid(
    vault_path: Path,
    query: str,
    embedding_config: EmbeddingConfig | None = None,
    count: int = 10,
) -> dict[str, Any]:
    """Hybrid search over notes in the vault.

    Returns {"mode": "keyword"|"vector"|"hybrid", "results": [...]}.
    Gracefully degrades to keyword-only when embedding is unavailable.
    """
    from mona.notes_kb.indexer import _vectorstore_db_path

    db_path = _vectorstore_db_path(vault_path)
    return await search_wiki_hybrid(
        project_path=vault_path,
        query=query,
        embedding_config=embedding_config,
        count=count,
        markdown_dir=vault_path,
        vectorstore_db=db_path,
    )
