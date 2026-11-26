"""Shared access to Mona's server-managed model catalogue."""

from __future__ import annotations

import time
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from typing import Any

_CACHE_TTL_SECONDS = 30.0
_cached_at = 0.0
_cache: dict[str, Any] = {"available": False, "models": []}
_cache_lock = Lock()
_next_request = 0
_committed_request = 0
_request_snapshot: ContextVar[dict[str, Any] | None] = ContextVar("managed_catalog_snapshot", default=None)


@contextmanager
def use_cached_managed_catalog():
    """Keep an unrelated model change independent of catalogue refresh latency."""
    with _cache_lock:
        token = _request_snapshot.set(_cache)
    try:
        yield
    finally:
        _request_snapshot.reset(token)


def managed_model_catalog(*, timeout: float | None = None) -> dict[str, Any]:
    global _cached_at, _cache, _next_request, _committed_request
    snapshot = _request_snapshot.get()
    if snapshot is not None:
        return snapshot
    now = time.monotonic()
    with _cache_lock:
        cache_ttl = _CACHE_TTL_SECONDS if _cache["available"] else 3.0
        if now - _cached_at < cache_ttl:
            return _cache
        _next_request += 1
        request = _next_request

    catalog: dict[str, Any] = {"available": False, "models": []}
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke

        raw = (tauri_invoke("get_managed_model_catalog") if timeout is None
               else tauri_invoke("get_managed_model_catalog", timeout=timeout))
        if isinstance(raw, dict):
            models = raw.get("models")
            if isinstance(models, list):
                catalog = {
                    "available": raw.get("available") is True and len(models) > 0,
                    "models": [model for model in models if isinstance(model, dict)],
                }
    except Exception:
        pass
    with _cache_lock:
        if request > _committed_request:
            _cache = catalog
            _cached_at = time.monotonic()
            _committed_request = request
        return _cache
