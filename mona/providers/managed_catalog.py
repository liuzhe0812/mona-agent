"""Shared access to Mona's server-managed model catalogue."""

from __future__ import annotations

import time
from typing import Any

_CACHE_TTL_SECONDS = 30.0
_cached_at = 0.0
_cache: dict[str, Any] = {"available": False, "models": []}


def managed_model_catalog() -> dict[str, Any]:
    global _cached_at, _cache
    now = time.monotonic()
    cache_ttl = _CACHE_TTL_SECONDS if _cache["available"] else 3.0
    if now - _cached_at < cache_ttl:
        return _cache

    catalog: dict[str, Any] = {"available": False, "models": []}
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke

        raw = tauri_invoke("get_managed_model_catalog")
        if isinstance(raw, dict):
            models = raw.get("models")
            if isinstance(models, list):
                catalog = {
                    "available": raw.get("available") is True and len(models) > 0,
                    "models": [model for model in models if isinstance(model, dict)],
                }
    except Exception:
        pass
    _cache = catalog
    _cached_at = now
    return catalog
