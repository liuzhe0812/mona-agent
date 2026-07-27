"""Tool result compression: shrink verbose tool output before it enters the LLM context.

Inspired by OpenHuman's TokenJuice, but kept as a single pure function with no
framework, no config surface, and no new tools. Compression is best-effort and
never amplifies: if a compressed form is not shorter than the input, the
original is returned unchanged.

Design:
- Only content larger than ``_MIN_COMPRESS_CHARS`` is considered; small results pass through.
- Content kind is detected from explicit ``tool_name`` hints, then structural heuristics.
- CJK / emoji are handled grapheme-safely by operating on whole characters
  (Python strings are already code-point sequences; we avoid slicing inside
  surrogate pairs by never indexing into the middle of a character — Python 3
  strings do not contain surrogates for valid Unicode, so standard slicing is
  safe for the cases below).
- The original full text is expected to be persisted separately by
  ``maybe_persist_tool_result`` when still oversized after compression; this
  module only rewrites the in-context string.
"""

from __future__ import annotations

import json
import re
from typing import Any

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_JSON_ARRAY_RE = re.compile(r"^\s*\[\s*\{")
_HTML_TAG_RE = re.compile(r"<[a-zA-Z/!][^>]*>")
_DIFF_HUNK_RE = re.compile(r"^@@ ", re.MULTILINE)
_REPEAT_LINE_RE = re.compile(r"^(.*)$")

_MIN_COMPRESS_CHARS = 2048
_HEAD_TAIL_LINES = 30
_TABLE_MAX_ROWS = 40
_TABLE_HEAD_TAIL = 5


def compress_tool_result(text: str, *, tool_name: str | None = None) -> str:
    """Compress a tool result string in-place (pure function).

    Returns a string no longer than ``text``. If no compression applies or the
    result would be larger, ``text`` is returned unchanged.
    """
    if not isinstance(text, str) or len(text) <= _MIN_COMPRESS_CHARS:
        return text

    kind = _detect_kind(text, tool_name=tool_name)
    if kind == "json":
        compressed = _compress_json(text)
    elif kind == "log":
        compressed = _compress_log(text)
    elif kind == "html":
        compressed = _compress_html(text)
    elif kind == "diff":
        compressed = _compress_diff(text)
    else:
        compressed = _compress_text(text)

    if not isinstance(compressed, str) or len(compressed) >= len(text):
        return text
    return compressed


def _detect_kind(text: str, *, tool_name: str | None) -> str:
    """Classify content kind from tool name hint then structural heuristics."""
    name = (tool_name or "").lower()
    if name:
        if any(k in name for k in ("shell", "exec", "terminal", "run_command")):
            return "log"
        if any(k in name for k in ("imap", "email", "mail")):
            return "html" if "<" in text[:512] and ">" in text[:512] else "text"
        if any(k in name for k in ("grep", "search", "rg")):
            return "log"
        if name in ("read_file", "file_read", "edit_file"):
            return "text"

    stripped = text.lstrip()
    if stripped.startswith("{") or _JSON_ARRAY_RE.match(stripped):
        return "json"
    if _DIFF_HUNK_RE.search(text):
        return "diff"
    if "<html" in text[:2048].lower() or _HTML_TAG_RE.search(text[:1024]):
        return "html"
    return "text"


def _compress_json(text: str) -> str:
    """Render JSON object arrays as a Markdown table; keep head+tail for long arrays."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return text

    rows: list[dict[str, Any]] = []
    if isinstance(data, list) and all(isinstance(item, dict) for item in data):
        rows = data
    elif isinstance(data, dict) and all(
        isinstance(v, dict) for v in data.values()
    ):
        rows = list(data.values())
    if not rows:
        return text

    columns: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                columns.append(str(key))

    def _cell(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            s = json.dumps(value, ensure_ascii=False)
            return s if len(s) <= 60 else s[:57] + "..."
        return str(value).replace("|", "\\|").replace("\n", " ")

    def _render_table(selected: list[dict[str, Any]]) -> str:
        header = "| " + " | ".join(columns) + " |"
        sep = "| " + " | ".join("---" for _ in columns) + " |"
        body = "\n".join(
            "| " + " | ".join(_cell(row.get(c)) for c in columns) + " |"
            for row in selected
        )
        return f"{header}\n{sep}\n{body}"

    if len(rows) <= _TABLE_MAX_ROWS:
        return _render_table(rows)

    head = rows[:_TABLE_HEAD_TAIL]
    tail = rows[-_TABLE_HEAD_TAIL:]
    omitted = len(rows) - _TABLE_HEAD_TAIL * 2
    return (
        _render_table(head)
        + f"\n\n... ({omitted} rows omitted) ...\n\n"
        + _render_table(tail)
    )


def _compress_log(text: str) -> str:
    """Strip ANSI codes, collapse repeated lines, keep head+tail."""
    cleaned = _ANSI_RE.sub("", text)
    lines = cleaned.split("\n")
    if len(lines) <= _HEAD_TAIL_LINES * 2:
        return cleaned if len(cleaned) < len(text) else text

    deduped = _dedup_consecutive(lines)
    if len(deduped) <= _HEAD_TAIL_LINES * 2:
        return "\n".join(deduped)

    head = deduped[:_HEAD_TAIL_LINES]
    tail = deduped[-_HEAD_TAIL_LINES:]
    omitted = len(deduped) - _HEAD_TAIL_LINES * 2
    return "\n".join(head) + f"\n... ({omitted} lines omitted) ...\n" + "\n".join(tail)


def _dedup_consecutive(lines: list[str]) -> list[str]:
    """Collapse runs of identical lines into one with a count suffix."""
    result: list[str] = []
    prev: str | None = None
    count = 0
    for line in lines:
        if line == prev:
            count += 1
            continue
        if prev is not None:
            result.append(prev if count <= 1 else f"{prev}  (×{count + 1})")
        prev = line
        count = 0
    if prev is not None:
        result.append(prev if count <= 1 else f"{prev}  (×{count + 1})")
    return result


def _compress_html(text: str) -> str:
    """Linear HTML-to-text: drop tags, collapse whitespace, keep text content.

    Deliberately avoids html2md / lxml to avoid the memory blowup seen in
    OpenHuman (10KB HTML peaked at ~894MB). This is a single-pass scanner.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    in_tag = False
    # Skip <script>/<style> blocks entirely.
    while i < n:
        if not in_tag and text[i] == "<":
            low = text[i:i + 8].lower()
            if low.startswith("<script") or low.startswith("<style"):
                close = text.lower().find(
                    "</script>" if low.startswith("<script") else "</style>",
                    i,
                )
                if close == -1:
                    break
                i = close + (9 if low.startswith("<script") else 8)
                continue
            in_tag = True
            i += 1
            continue
        if in_tag:
            if text[i] == ">":
                in_tag = False
                # Insert a newline where block tags likely ended, to preserve
                # some structure without keeping the tag.
                out.append("\n")
            i += 1
            continue
        out.append(text[i])
        i += 1

    rendered = "".join(out)
    # Collapse runs of whitespace.
    rendered = re.sub(r"[ \t]+", " ", rendered)
    rendered = re.sub(r"\n[ \t]*\n+", "\n\n", rendered)
    rendered = rendered.strip()
    return rendered if rendered else text


def _compress_diff(text: str) -> str:
    """Keep added/removed lines and hunk headers; fold long unchanged runs."""
    lines = text.split("\n")
    kept: list[str] = []
    unchanged_run = 0
    for line in lines:
        if line.startswith("@@ ") or line.startswith("+") or line.startswith("-"):
            if unchanged_run >= 4:
                kept.append(f"... ({unchanged_run} unchanged lines) ...")
            unchanged_run = 0
            kept.append(line)
        else:
            unchanged_run += 1
    if unchanged_run >= 4:
        kept.append(f"... ({unchanged_run} unchanged lines) ...")
    return "\n".join(kept)


def _compress_text(text: str) -> str:
    """Generic fallback: keep head+tail with an omitted marker for the middle."""
    lines = text.split("\n")
    if len(lines) <= _HEAD_TAIL_LINES * 2:
        return text
    head = lines[:_HEAD_TAIL_LINES]
    tail = lines[-_HEAD_TAIL_LINES:]
    omitted = len(lines) - _HEAD_TAIL_LINES * 2
    return "\n".join(head) + f"\n... ({omitted} lines omitted) ...\n" + "\n".join(tail)
