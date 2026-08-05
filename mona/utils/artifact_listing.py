"""Shared output directory artifact scanning."""

from __future__ import annotations

import hashlib
import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

MAX_ARTIFACT_FILES = 1000

_TEMP_EXTENSIONS = {".tmp", ".part"}

# Generated media sidecar metadata (img_<hash12>.json / vid_<slug>_<hash12>.json
# etc.) is internal bookkeeping, not a user deliverable — hidden from the panel.
_SIDECAR_RE = re.compile(r"^(?:img|vid)_(?:.*_)?[0-9a-f]{12}\.json$")


@dataclass
class ArtifactFile:
    path: str            # 相对 output_dir 的 POSIX 路径（如 "子目录/报告.docx"）
    absolute_path: str   # 绝对路径字符串
    name: str            # 文件名（如 "报告.docx"）
    size: int            # 字节数
    size_human: str      # 人类可读大小（如 "11.8 KB"）
    mime: str            # MIME 类型（基于扩展名猜测，未知则为 "application/octet-stream"）
    modified_at: str     # ISO 8601 格式的时间戳（如 "2026-07-22T10:00:00+08:00"）


@dataclass
class ArtifactListResult:
    files: list[ArtifactFile]
    truncated: bool


def _human_size(size: int) -> str:
    """Convert byte count to a human-readable 1024-based string."""
    if size < 1024:
        return f"{size} B"
    units = ("KB", "MB", "GB")
    value = float(size)
    for unit in units:
        value /= 1024.0
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}"
    return f"{value:.1f} GB"


def _is_temp_file(name: str) -> bool:
    """Return True for ``.tmp``/``.part`` extensions or names trailing ``~``."""
    if name.endswith("~"):
        return True
    return Path(name).suffix.lower() in _TEMP_EXTENSIONS


def _scan_files(root: Path) -> list[tuple[Path, str, float, int]]:
    """Collect real files under root as ``(path, rel_posix, mtime, size)``.

    Symlinks, dot-segment paths, and temp files are skipped. Errors on
    individual entries are swallowed so a single vanishing file cannot
    fail the whole scan.
    """
    results: list[tuple[Path, str, float, int]] = []
    stack: list[Path] = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except (FileNotFoundError, OSError):
            continue
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_symlink():
                    continue
            except OSError:
                continue
            try:
                if entry.is_dir():
                    stack.append(entry)
                    continue
                if not entry.is_file():
                    continue
            except (FileNotFoundError, OSError):
                continue
            if _is_temp_file(entry.name):
                continue
            if _SIDECAR_RE.match(entry.name):
                continue
            try:
                stat = entry.stat()
            except (FileNotFoundError, OSError):
                continue
            try:
                rel = entry.relative_to(root)
            except ValueError:
                continue
            results.append((entry, rel.as_posix(), stat.st_mtime, stat.st_size))
    return results


def list_artifacts(output_dir: Path) -> ArtifactListResult:
    """Scan the shared output directory and return artifact files.

    The directory is walked recursively. Files are sorted by mtime desc,
    then by relative path asc. Symlinks, dotfiles, and temp files are
    skipped. Returns at most MAX_ARTIFACT_FILES entries (most recent
    first); ``truncated`` is True if the limit was hit.
    """
    root = Path(output_dir).resolve(strict=False)

    scanned = _scan_files(root)
    # Sort by mtime desc, then relative path asc. Combined key is a total
    # order (relative paths are unique), so the stable sort is deterministic.
    scanned.sort(key=lambda item: (-item[2], item[1]))

    truncated = len(scanned) > MAX_ARTIFACT_FILES
    if truncated:
        scanned = scanned[:MAX_ARTIFACT_FILES]

    files: list[ArtifactFile] = []
    for entry, rel_posix, mtime, size in scanned:
        guessed, _ = mimetypes.guess_type(entry.name)
        modified_at = datetime.fromtimestamp(mtime, tz=timezone.utc).astimezone().isoformat()
        files.append(
            ArtifactFile(
                path=rel_posix,
                absolute_path=str(entry),
                name=entry.name,
                size=size,
                size_human=_human_size(size),
                mime=guessed or "application/octet-stream",
                modified_at=modified_at,
            )
        )
    return ArtifactListResult(files=files, truncated=truncated)


def artifact_signature(output_dir: Path) -> str:
    """Cheap change-detection signature over the shared output directory.

    Aggregates relative path + mtime + size of every deliverable file
    (same filtering as ``list_artifacts``: symlinks, dotfiles, temp files
    and generated-media sidecars are skipped) into a stable hex digest.
    File content is never read, so polling stays inexpensive.
    """
    root = Path(output_dir).resolve(strict=False)
    scanned = _scan_files(root)
    digest = hashlib.blake2b(digest_size=16)
    for _entry, rel_posix, mtime, size in sorted(scanned, key=lambda item: item[1]):
        digest.update(rel_posix.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(mtime).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()
