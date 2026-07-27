"""Shared Tauri IPC bridge helper.

Provides `tauri_invoke(cmd, args)` to call Tauri commands from agent tools
via the local HTTP bridge exposed by the Mona desktop app.

This is the same mechanism originally implemented in browser.py; extracted
here so that notes.py and other future tools can reuse it without depending
on the browser module.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from loguru import logger

_GATEWAY_BASE = "http://127.0.0.1"
_FALLBACK_IPC_PORT = 17860
_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"

# Opener that bypasses all proxy settings. The IPC bridge is a localhost
# HTTP server; system proxies (V2Ray/Clash on 127.0.0.1:10809) intercept
# the request and fail to route it back, causing spurious connection errors
# that trigger fail-closed subscription gating (all Pro tools hidden).
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# TTL cache for the subscription access check so we don't hit the IPC bridge
# on every single tool call within a short window. The AgentLoop refreshes
# the ToolRegistry flag once per turn; this cache covers subagents and
# mid-turn tool calls (e.g. hoard_search).
_ACCESS_CACHE: tuple[bool, float] | None = None
_ACCESS_TTL_SECONDS: float = 30.0


def _read_ipc_port() -> int:
    try:
        text = _IPC_PORT_FILE.read_text().strip()
        port = int(text)
        if 1 <= port <= 65535:
            return port
    except (FileNotFoundError, ValueError, PermissionError):
        pass
    return _FALLBACK_IPC_PORT


def tauri_invoke(cmd: str, args: dict[str, Any] | None = None) -> Any:
    """Call a Tauri IPC command via the HTTP bridge.

    Raises RuntimeError if the bridge is unavailable or the command returns
    an error.
    """
    port = _read_ipc_port()
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    url = f"{_GATEWAY_BASE}:{port}"
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with _NO_PROXY_OPENER.open(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            if isinstance(result, dict) and "error" in result:
                logger.warning("IPC bridge error for cmd={!r}: {}", cmd, result["error"])
                raise RuntimeError(result["error"])
            return result.get("result", result)
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"IPC bridge unavailable for {cmd!r}: {e}. "
            "Is the Mona app running?"
        ) from e


def check_subscription_access() -> bool:
    """Check whether the current user has subscription access.

    Returns True when the local license state indicates an active paid
    license, a valid server-cached result, or an unexpired local trial.
    Returns False on any error (fail-closed) so that personal data is
    never exposed without a verified license.

    The result is cached for ``_ACCESS_TTL_SECONDS`` to avoid hammering
    the IPC bridge on every tool call within a short window.
    """
    global _ACCESS_CACHE
    now = time.monotonic()
    if _ACCESS_CACHE is not None and now - _ACCESS_CACHE[1] < _ACCESS_TTL_SECONDS:
        return _ACCESS_CACHE[0]

    try:
        result = tauri_invoke("license_has_access")
        has_access = result is True
    except Exception as e:
        logger.debug("license_has_access IPC failed, failing closed: {}", e)
        has_access = False

    _ACCESS_CACHE = (has_access, now)
    return has_access


def invalidate_subscription_access_cache() -> None:
    """Clear the subscription access cache.

    Called by AgentLoop after it refreshes the ToolRegistry flag so that
    subsequent tool-level checks (e.g. hoard_search) see the fresh value.
    """
    global _ACCESS_CACHE
    _ACCESS_CACHE = None
