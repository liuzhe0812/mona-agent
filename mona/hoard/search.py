"""Hoard search: LIKE substring matching with scoring.

Scoring: title hit = 3, tags hit = 2, summary hit = 2, content hit = 1.
Final score = relevance × source_strength.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.hoard.models import HoardManager


async def search_hoard_hybrid(
    query: str,
    *,
    source: str | None = None,
    limit: int = 10,
    manager: HoardManager | None = None,
    exclude_sources: list[str] | None = None,
) -> dict[str, Any]:
    """Keyword search over hoard items. Returns {"mode": "keyword", "results": [...]}.

    When ``exclude_sources`` is provided, items from those sources are excluded
    at the SQL level, and related sources of those types are also filtered out
    from the results. This is used by the subscription gate to hide note/email
    sources for free-tier users.
    """
    mgr = manager or HoardManager()
    q = query.strip()
    if not q:
        return {"mode": "keyword", "results": []}

    items = mgr.search(
        q, source=source, limit=limit, exclude_sources=exclude_sources
    )
    results: list[dict] = []
    exclude_set = set(exclude_sources) if exclude_sources else None
    for item in items:
        d = _item_to_dict(item)
        relations = _safe_relations(mgr, item.id)
        # Also filter related sources to avoid leaking note/email metadata
        # through cross-source associations when the user has no subscription.
        if exclude_set:
            relations = [
                r for r in relations if r.get("type") not in exclude_set
            ]
        d["related_sources"] = relations
        results.append(d)

    return {"mode": "keyword", "results": results}


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
