"""Lossless normalization before tool output enters model context.

Content selection belongs to the producing tool. Budget enforcement persists
oversized results separately; this layer must not remove evidence or protocol
fields based on a guessed content type.
"""

from __future__ import annotations

import json
import re

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def compress_tool_result(text: str, *, tool_name: str | None = None) -> str:
    """Remove only transport formatting, preserving all values and source text."""
    if not isinstance(text, str):
        return text
    name = (tool_name or "").lower()
    if name in {"exec", "terminal_exec", "terminal_output", "write_stdin", "run_shell_command"}:
        return _ANSI_RE.sub("", text)
    if not text.lstrip().startswith(("{", "[")):
        return text
    # Source-file tools promise exact text, including whitespace and line ranges.
    if name in {"read_file", "file_read", "document", "skill_read", "skill_reference_read"}:
        return text
    try:
        json.loads(text)
    except (ValueError, RecursionError):
        return text
    # Avoid loads/dumps: reserializing can round long decimal literals or alter
    # their lexical form. Only remove JSON whitespace outside string literals.
    compact: list[str] = []
    quoted = escaped = False
    for character in text:
        if quoted:
            compact.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
            compact.append(character)
        elif character not in " \t\r\n":
            compact.append(character)
    result = "".join(compact)
    return result if len(result) < len(text) else text
