"""Hoard HTTP route handlers.

Hoard is Agent's URL memory layer. Only two routes are exposed to frontend:
  POST   /api/hoard            - add URL (called on browser star click)
  DELETE /api/hoard-by-url     - remove by URL (called on browser star unclick)

Agent tools (hoard_search / hoard_capture) call Python directly, not via HTTP.
"""

from __future__ import annotations

import asyncio

from aiohttp import web
from loguru import logger

from mona.hoard.ingest import ingest_hoard
from mona.hoard.models import HoardManager


def _manager() -> HoardManager:
    return HoardManager()


async def handle_hoard_add(req: web.Request) -> web.Response:
    """POST /api/hoard -- add a new hoard item (browser star click)."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    title = str(body.get("title", "")).strip()
    if not title:
        return web.json_response({"error": "title is required"}, status=400)

    url = body.get("url")
    url = str(url).strip() if url else None
    content = body.get("content")
    content = str(content) if content else None
    source = str(body.get("source", "browser")).strip() or "browser"
    source_ref = body.get("sourceRef")
    source_ref = str(source_ref) if source_ref else None
    tags = body.get("tags") or []
    if not isinstance(tags, list):
        tags = [str(tags)]
    tags = [str(t) for t in tags]
    source_strength = float(body.get("sourceStrength", 1.0))

    try:
        mgr = _manager()
        hoard_id = mgr.add(
            url=url,
            title=title,
            content=content,
            tags=tags,
            source=source,
            source_ref=source_ref,
            source_strength=source_strength,
        )
    except Exception as e:
        logger.warning(f"[hoard] add failed: {e}")
        return web.json_response({"error": str(e)}, status=500)

    # Trigger async ingestion (fetch + summary + tags + embedding + relations).
    try:
        from mona.hoard.ingest import _load_embedding_config

        embedding_config = _load_embedding_config()
        asyncio.create_task(
            ingest_hoard(
                mgr,
                hoard_id,
                fetch_content=bool(url),
                generate_summary=True,
                generate_tags=True,
                generate_embedding=embedding_config is not None,
                embedding_config=embedding_config,
            )
        )
    except Exception as e:
        logger.debug(f"[hoard] ingest scheduling failed: {e}")

    return web.json_response({"id": hoard_id, "queued": bool(url)})


async def handle_hoard_delete_by_url(req: web.Request) -> web.Response:
    """DELETE /api/hoard-by-url?url=xxx

    Remove all hoard items matching the given URL.
    Called when user removes a browser bookmark — keeps hoard in sync.
    """
    url = req.query.get("url")
    if not url:
        return web.json_response({"error": "url is required"}, status=400)
    try:
        mgr = _manager()
        items = mgr.find_by_url(url)
        for item in items:
            mgr.delete(item.id)
    except Exception as e:
        logger.warning(f"[hoard] delete_by_url failed: {e}")
        return web.json_response({"error": str(e)}, status=500)

    return web.json_response({"ok": True, "url": url, "deleted": len(items)})
