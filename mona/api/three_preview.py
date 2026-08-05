"""Sandbox iframe postMessage protocol for 3D preview.

Defines the allowed message types between the host page and the sandboxed
Three.js preview iframe, plus validation helpers. The sandbox must never
accept arbitrary code execution messages (e.g. ``eval-code``).
"""

from __future__ import annotations

ALLOWED_MESSAGE_TYPES: frozenset[str] = frozenset(
    {
        "load-model",
        "set-camera",
        "reset-view",
        "set-grid",
        "get-bounds",
        "select-node",
        "capture-screenshot",
    }
)


def validate_message(msg: dict) -> dict:
    """Validate a postMessage payload against the sandbox protocol.

    Args:
        msg: Decoded message dict with a ``type`` field.

    Returns:
        The message unchanged when valid.

    Raises:
        ValueError: If the message type is not in the whitelist.
    """
    mtype = msg.get("type")
    if mtype not in ALLOWED_MESSAGE_TYPES:
        raise ValueError(f"unknown message type: {mtype}")
    return msg
