"""Notes knowledge base module.

Reuses KB chunker + embedding + vectorstore with notes-vault-specific paths.

Layout (per vault):
  <vault>/.mona/vectorstore.db   - sqlite-vec embeddings (one row per chunk)
  <vault>/.mona/links.json       - bidirectional link graph cache (owned by Rust)
"""

from __future__ import annotations

from mona.notes_kb.indexer import index_vault, index_vault_status
from mona.notes_kb.search import search_notes_hybrid

__all__ = [
    "index_vault",
    "index_vault_status",
    "search_notes_hybrid",
]
