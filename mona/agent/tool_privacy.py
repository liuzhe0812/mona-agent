"""Redaction for sensitive text typed through interactive automation tools."""

from __future__ import annotations

import json
from typing import Any

_REDACTED = "<redacted>"


def redact_tool_arguments(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    safe = dict(arguments)
    if name == "browser_type" and "text" in safe:
        safe["text"] = _REDACTED
    elif name == "browser_act" and safe.get("kind") in {"type", "fill"}:
        if "text" in safe:
            safe["text"] = _REDACTED
    elif name == "computer_type_text" and "text" in safe:
        safe["text"] = _REDACTED
    elif name == "computer_set_value" and "value" in safe:
        safe["value"] = _REDACTED
    elif name == "computer_act" and safe.get("action") in {"type", "set_value"}:
        nested = safe.get("arguments")
        if isinstance(nested, dict):
            nested_safe = dict(nested)
            sensitive_key = "text" if safe.get("action") == "type" else "value"
            if sensitive_key in nested_safe:
                nested_safe[sensitive_key] = _REDACTED
                safe["arguments"] = nested_safe
    return safe


def redact_persisted_tool_call(call: dict[str, Any]) -> dict[str, Any]:
    """Return a history-safe OpenAI tool-call copy without typed user text."""
    safe = dict(call)
    function = call.get("function")
    if not isinstance(function, dict):
        return safe
    function_safe = dict(function)
    safe["function"] = function_safe
    name = str(function.get("name") or "")
    raw = function.get("arguments")
    if not isinstance(raw, str):
        return safe
    try:
        arguments = json.loads(raw)
    except json.JSONDecodeError:
        return safe
    if not isinstance(arguments, dict):
        return safe

    redacted = redact_tool_arguments(name, arguments)
    if redacted != arguments:
        function_safe["arguments"] = json.dumps(redacted, ensure_ascii=False)
    return safe
