"""Bounded new-file evidence without touching the repository index."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from mona.development.store import DevelopmentError


def _fingerprint(root: Path, relative: str, limit: int) -> tuple[str, int]:
    value = Path(relative)
    target = root / value
    if value.is_absolute() or value.drive or not target.resolve().is_relative_to(root) or target.is_symlink():
        raise DevelopmentError("outside_project", "新文件指向项目范围外或是链接，未读取。")
    if not target.is_file():
        raise DevelopmentError("review_source_changed", "新文件已变化，请重新读取。")
    with target.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise DevelopmentError("file_too_large", "新文件超过差异读取上限，请缩小审查范围。")
    return hashlib.sha256(data).hexdigest(), target.stat().st_mode


async def untracked_diff(root: Path, relative: str, budget: int) -> bytes:
    from mona.development.workspace import MAX_TEXT_BYTES, _git

    args = ("ls-files", "--others", "--exclude-standard", "-z", "--", relative or ".")
    code, listing = await _git(root, *args)
    if code:
        raise DevelopmentError("git_failed", "无法读取新文件列表。")
    names = [name.decode("utf-8") for name in listing.split(b"\0") if name]
    if len(names) > 128:
        raise DevelopmentError("review_too_large", "新文件过多，请缩小到具体文件或目录后审查。")
    chunks: list[bytes] = []
    size = 0
    fingerprints = {}
    for name in names:
        before = _fingerprint(root, name, MAX_TEXT_BYTES)
        code, patch = await _git(root, "diff", "--no-index", "--no-ext-diff", "--no-textconv",
                                "--no-color", "--full-index", "--", os.devnull, name)
        if code not in (0, 1):  # --no-index returns 1 when the files differ.
            raise DevelopmentError("git_failed", "无法读取新文件差异，未暂存或修改文件。")
        if _fingerprint(root, name, MAX_TEXT_BYTES) != before:
            raise DevelopmentError("review_source_changed", "读取期间新文件已变化，请重新读取。")
        size += len(patch)
        if size > budget:
            raise DevelopmentError("git_result_too_large", "差异过大，请缩小审查范围；没有返回截断资料。")
        chunks.append(patch)
        fingerprints[name] = before
    code, current = await _git(root, *args)
    if code or current != listing or any(_fingerprint(root, name, MAX_TEXT_BYTES) != expected for name, expected in fingerprints.items()):
        raise DevelopmentError("review_source_changed", "读取期间新文件列表或内容已变化，请重新读取。")
    return b"".join(chunks)
