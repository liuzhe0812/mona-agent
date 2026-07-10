"""Hoard search: LIKE substring + optional vector hybrid with RRF fusion.

Dual-path design:
- No embedding config  → keyword-only (LIKE + scoring)
- Embedding configured → hybrid (keyword + vector + RRF fusion)

Scoring (keyword): title hit = 3, tags hit = 2, summary hit = 2, content hit = 1.
Final score = relevance × source_strength.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.hoard.models import HoardManager

RRF_K = 60.0


def search_hoard(
    query: str,
    *,
    source: str | None = None,
    limit: int = 10,
    manager: HoardManager | None = None,
) -> list[dict]:
    """Synchronous keyword-only search (LIKE + scoring).

    Returns list of dicts with item fields + related_sources.
    """
    mgr = manager or HoardManager()
    items = mgr.search(query, source=source, limit=limit)

    results: list[dict] = []
    for item in items:
        d = _item_to_dict(item)
        d["related_sources"] = _safe_relations(mgr, item.id)
        results.append(d)

    return results


async def search_hoard_hybrid(
    query: str,
    *,
    source: str | None = None,
    limit: int = 10,
    embedding_config: Any | None = None,
    manager: HoardManager | None = None,
) -> dict[str, Any]:
    """Hybrid search: keyword + vector with RRF fusion.

    Returns {"mode": "keyword"|"vector"|"hybrid", "results": [...]}.
    Gracefully degrades to keyword-only when embedding is unavailable.
    """
    mgr = manager or HoardManager()
    q = query.strip()
    if not q:
        return {"mode": "keyword", "results": []}

    # -- Phase 1: Keyword search (LIKE + scoring) --
    keyword_items = mgr.search(q, source=source, limit=limit * 3)
    keyword_rank: dict[str, int] = {
        item.id: idx + 1 for idx, item in enumerate(keyword_items)
    }

    # -- Phase 2: Vector search --
    vector_rank: dict[str, int] = {}
    vector_score_map: dict[str, float] = {}
    vector_hits = 0

    if embedding_config and embedding_config.enabled and embedding_config.endpoint and embedding_config.model:
        try:
            from mona.hoard.vectorstore import search_vectors
            from mona.kb.embedding import fetch_embedding

            query_vector = await fetch_embedding(q, embedding_config)
            if query_vector:
                raw_hits = await search_vectors(query_vector, limit=limit * 3)
                vector_hits = len(raw_hits)
                for idx, hit in enumerate(raw_hits):
                    hoard_id = hit["hoard_id"]
                    vector_rank[hoard_id] = idx + 1
                    vector_score_map[hoard_id] = hit["score"]
        except Exception as e:
            logger.warning(f"[hoard] vector search failed, falling back to keyword: {e}")

    # -- Phase 3: Merge + RRF fusion --
    # Build merged item set: keyword hits ∪ vector hits
    merged: dict[str, Any] = {item.id: item for item in keyword_items}

    # Materialize vector-only hits (not in keyword results)
    if vector_hits > 0:
        for hoard_id in vector_rank:
            if hoard_id not in merged:
                item = mgr.get(hoard_id)
                if item is not None:
                    # Apply source filter if set
                    if source and item.source != source:
                        continue
                    merged[hoard_id] = item

    # Compute RRF scores
    results: list[dict] = []
    for hoard_id, item in merged.items():
        t_rank = keyword_rank.get(hoard_id)
        v_rank = vector_rank.get(hoard_id)
        rrf = 0.0
        if t_rank:
            rrf += 1.0 / (RRF_K + t_rank)
        if v_rank:
            rrf += 1.0 / (RRF_K + v_rank)
        # If only keyword hit, use the original score scaled down for comparability
        if not v_rank and t_rank:
            rrf = 1.0 / (RRF_K + t_rank)

        d = _item_to_dict(item)
        d["score"] = rrf
        if hoard_id in vector_score_map:
            d["vector_score"] = vector_score_map[hoard_id]
        d["related_sources"] = _safe_relations(mgr, hoard_id)
        results.append(d)

    # Sort by RRF score descending
    results.sort(key=lambda r: r.get("score", 0.0), reverse=True)

    mode = "hybrid" if keyword_rank and vector_hits else (
        "vector" if vector_hits else "keyword"
    )
    return {"mode": mode, "results": results[:limit]}


def _item_to_dict(item: Any) -> dict[str, Any]:
    return {
        "id": item.id,
        "url": item.url,
        "title": item.title,
        "content": item.content,
        "summary": item.summary,
        "tags": item.tags,
        "source": item.source,
        "source_ref": item.source_ref,
        "source_strength": item.source_strength,
        "asset_path": item.asset_path,
        "created_at": item.created_at,
    }


def _safe_relations(mgr: HoardManager, hoard_id: str) -> list[dict]:
    try:
        return mgr.get_relations(hoard_id)
    except Exception as e:
        logger.debug(f"[hoard] get_relations failed for {hoard_id}: {e}")
        return []
