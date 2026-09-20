"""Shared Tauri IPC bridge helper.

Provides `tauri_invoke(cmd, args)` to call Tauri commands from agent tools
via the local HTTP bridge exposed by the Mona desktop app.

This is the same mechanism originally implemented in browser.py; extracted
here so that notes.py and other future tools can reuse it without depending
on the browser module.
"""

from __future__ import annotations

import asyncio
import json
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from loguru import logger

_GATEWAY_BASE = "http://127.0.0.1"
_FALLBACK_IPC_PORT = 17860
_IPC_META_FILE = Path.home() / ".mona" / "ipc_bridge.json"
_LEGACY_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"
_TOKEN_HEADER = "x-mona-ipc-token"

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

# Ordinary bridge commands answer in milliseconds; this bound only exists so a
# wedged app cannot hang a tool call forever. Commands whose backend work can
# legitimately take minutes (e.g. a terminal step running apt-get) must pass an
# explicit ``timeout`` — otherwise the transport gives up while the backend is
# still working.
_DEFAULT_TIMEOUT_SECONDS: float = 30.0


class IpcTimeoutError(RuntimeError):
    """The transport gave up waiting; the backend command may still be running.

    Callers must not treat this as "the command failed": the request reached
    the app, the work was likely started, and no result was observed. Only the
    caller that knows the command's semantics can say what to do next.
    """


def _read_ipc_meta() -> tuple[int, str | None]:
    """Read the bridge port + auth token written by the Tauri side.

    Falls back to the legacy token-less port file so an older app build can
    still be reached (that bridge does not enforce authentication).
    """
    try:
        data = json.loads(_IPC_META_FILE.read_text())
        port = int(data.get("port", 0))
        token = data.get("token")
        if 1 <= port <= 65535:
            return port, token if isinstance(token, str) and token else None
    except (FileNotFoundError, ValueError, PermissionError, json.JSONDecodeError):
        pass
    try:
        port = int(_LEGACY_IPC_PORT_FILE.read_text().strip())
        if 1 <= port <= 65535:
            return port, None
    except (FileNotFoundError, ValueError, PermissionError):
        pass
    return _FALLBACK_IPC_PORT, None


def tauri_invoke(
    cmd: str,
    args: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
) -> Any:
    """Call a Tauri IPC command via the HTTP bridge.

    ``timeout`` bounds how long the transport waits for the response. Omit it
    for ordinary commands; pass it when the backend work may take longer than
    ``_DEFAULT_TIMEOUT_SECONDS``.

    Raises ``IpcTimeoutError`` when the transport gave up waiting, and
    ``RuntimeError`` for any other bridge failure or reported command error.
    """
    port, token = _read_ipc_meta()
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    url = f"{_GATEWAY_BASE}:{port}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers[_TOKEN_HEADER] = token
    req = urllib.request.Request(url, data=payload, headers=headers)
    limit = _DEFAULT_TIMEOUT_SECONDS if timeout is None else max(1.0, float(timeout))
    try:
        with _NO_PROXY_OPENER.open(req, timeout=limit) as resp:
            result = json.loads(resp.read().decode())
            if isinstance(result, dict) and "error" in result:
                logger.warning("IPC bridge error for cmd={!r}: {}", cmd, result["error"])
                raise RuntimeError(result["error"])
            return result.get("result", result)
    except (TimeoutError, socket.timeout) as e:
        raise IpcTimeoutError(
            f"IPC bridge timed out for {cmd!r} after {limit:.0f}s"
        ) from e
    except urllib.error.URLError as e:
        # urllib wraps connect-phase socket timeouts in URLError; a read-phase
        # timeout surfaces above. Both mean "no answer yet", not "command
        # failed", so they share one exception type.
        if isinstance(getattr(e, "reason", None), (TimeoutError, socket.timeout)):
            raise IpcTimeoutError(
                f"IPC bridge timed out for {cmd!r} after {limit:.0f}s"
            ) from e
        raise RuntimeError(
            f"IPC bridge unavailable for {cmd!r}: {e}. "
            "Is the Mona app running?"
        ) from e


async def tauri_invoke_async(
    cmd: str,
    args: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
) -> Any:
    """Call a Tauri IPC command without blocking the asyncio event loop."""
    return await asyncio.to_thread(tauri_invoke, cmd, args, timeout=timeout)


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
