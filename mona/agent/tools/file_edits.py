"""Exact, single-file batch edits shared by Work and Code tool assemblies."""
from __future__ import annotations

import difflib
import hashlib
import os
import re
import stat
import tempfile
from bisect import bisect_left
from pathlib import Path

MAX_EDIT_BYTES = 8 * 1024 * 1024


def apply_exact_edits(path: Path, edits: list[dict], expected_sha256: str | None = None) -> dict:
    """Preflight all replacements against one source, then atomically replace it.

    The caller resolves/authorizes the path. The final source check is optimistic,
    not an OS-level compare-and-swap against unrelated editors.
    """
    if not isinstance(edits, list) or not 1 <= len(edits) <= 100:
        raise ValueError("edits must contain 1–100 exact replacements")
    if expected_sha256 is not None and not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("expected_sha256 must be a SHA256 returned by a file read")
    with path.open("rb") as stream:
        raw = stream.read(MAX_EDIT_BYTES + 1)
    if len(raw) > MAX_EDIT_BYTES:
        raise ValueError("File exceeds the 8 MiB batch-edit limit; narrow the operation")
    before_sha = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and expected_sha256 != before_sha:
        raise ValueError("File changed since the supplied SHA256; re-read before editing")
    source = raw.decode("utf-8-sig")
    normalized = source.replace("\r\n", "\n")
    # Map normalized offsets back to original characters, preserving even mixed
    # line endings in every unchanged region instead of rewriting the whole file.
    crlf = [match.start() - index for index, match in enumerate(re.finditer("\r\n", source))]
    spans: list[tuple[int, int, str]] = []
    for index, edit in enumerate(edits):
        if not isinstance(edit, dict) or set(edit) != {"old_text", "new_text"}:
            raise ValueError(f"edits[{index}] requires only old_text and new_text")
        old, new = edit["old_text"], edit["new_text"]
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError(f"edits[{index}] requires nonempty old_text and string new_text")
        old = old.replace("\r\n", "\n")
        first = normalized.find(old)
        if first < 0:
            raise ValueError(f"edits[{index}].old_text not found in the original file; no edits applied")
        if normalized.find(old, first + 1) >= 0:
            raise ValueError(f"edits[{index}].old_text is not unique; add exact context")
        start = first + bisect_left(crlf, first)
        end = first + len(old) + bisect_left(crlf, first + len(old))
        replacement = new.replace("\r\n", "\n")
        if "\r\n" in source[start:end] or ("\n" not in source[start:end] and crlf):
            replacement = replacement.replace("\n", "\r\n")
        spans.append((start, end, replacement))
    spans.sort(key=lambda item: item[0])
    if any(right[0] < left[1] for left, right in zip(spans, spans[1:])):
        raise ValueError("edits overlap in the original file; combine them into one replacement")
    result = source
    for start, end, replacement in reversed(spans):
        result = result[:start] + replacement + result[end:]
    output = (b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b"") + result.encode("utf-8")
    if len(output) > MAX_EDIT_BYTES:
        raise ValueError("Edited file exceeds the 8 MiB batch-edit limit; no edits applied")
    patch = "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
                    for line in difflib.unified_diff(source.splitlines(keepends=True), result.splitlines(keepends=True),
                                                   fromfile=str(path), tofile=str(path)))
    effective = [span for span in spans if source[span[0]:span[1]] != span[2]]
    changed = output != raw
    if changed:
        mode = stat.S_IMODE(path.stat().st_mode)
        fd, name = tempfile.mkstemp(prefix=".mona-edit-", dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(output)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, mode)
            with path.open("rb") as stream:
                current = stream.read(MAX_EDIT_BYTES + 1)
            if current != raw:
                raise ValueError("File changed during edit preparation; no edits applied")
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                os.chmod(temporary, mode | stat.S_IWUSR)
                temporary.unlink()
    return {"ok": True, "path": str(path), "unchanged": not changed, "replacements": len(spans),
            "beforeSha256": before_sha, "sha256": hashlib.sha256(output).hexdigest(),
            "firstChangedLine": source.count("\n", 0, effective[0][0]) + 1 if effective else None,
            "diff": patch}
