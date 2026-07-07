"""Shared Tauri IPC bridge helper.

Provides `tauri_invoke(cmd, args)` to call Tauri commands from agent tools
via the local HTTP bridge exposed by the Mona desktop app.

This is the same mechanism originally implemented in browser.py; extracted
here so that notes.py and other future tools can reuse it without depending
on the browser module.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from loguru import logger

_GATEWAY_BASE = "http://127.0.0.1"
_FALLBACK_IPC_PORT = 17860
_IPC_PORT_FILE = Path.home() / ".mona" / "ipc_bridge_port"


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
        with urllib.request.urlopen(req, timeout=30) as resp:
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
