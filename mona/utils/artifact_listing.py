"""Shared output directory artifact scanning."""

from __future__ import annotations

import hashlib
import mimetypes
import stat as stat_module
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

MAX_ARTIFACT_FILES = 1000

@dataclass
class ArtifactFile:
    path: str            # 相对 output_dir 的 POSIX 路径（如 "子目录/报告.docx"）
    absolute_path: str   # 绝对路径字符串
    name: str            # 文件名（如 "报告.docx"）
    size: int            # 字节数
    size_human: str      # 人类可读大小（如 "11.8 KB"）
    mime: str            # MIME 类型（基于扩展名猜测，未知则为 "application/octet-stream"）
    modified_at: str     # ISO 8601 格式的时间戳（如 "2026-07-22T10:00:00+08:00"）
    is_dir: bool = False
    is_symlink: bool = False


@dataclass
class _ScannedEntry:
    path: Path
    relative_path: str
    modified_at: float
    size: int
    is_dir: bool
    is_symlink: bool


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


def _scan_files(
    root: Path,
    *,
    raise_root_errors: bool = False,
    max_entries: int | None = None,
) -> list[_ScannedEntry]:
    """Collect files, directories, and symlinks under *root*.

    Symlink targets are represented as entries but are never traversed. A
    failure enumerating the root is optionally raised; races on descendants
    only skip the affected entry or subtree.
    """
    results: list[_ScannedEntry] = []
    pending: deque[Path] = deque([root])
    while pending:
        current = pending.popleft()
        try:
            entries = list(current.iterdir())
        except (FileNotFoundError, OSError):
            if current == root and raise_root_errors:
                raise
            continue
        current_entries: list[_ScannedEntry] = []
        for entry in entries:
            try:
                metadata = entry.lstat()
                reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
                is_symlink = stat_module.S_ISLNK(metadata.st_mode) or bool(
                    reparse_flag
                    and getattr(metadata, "st_file_attributes", 0) & reparse_flag
                )
                is_dir = entry.is_dir()
                if not is_symlink and not (is_dir or stat_module.S_ISREG(metadata.st_mode)):
                    continue
            except (FileNotFoundError, OSError):
                continue
            try:
                rel = entry.relative_to(root)
            except ValueError:
                continue
            current_entries.append(
                _ScannedEntry(
                    path=entry,
                    relative_path=rel.as_posix(),
                    modified_at=metadata.st_mtime,
                    size=metadata.st_size,
                    is_dir=is_dir,
                    is_symlink=is_symlink,
                )
            )
        current_entries.sort(
            key=lambda item: (
                not item.is_dir,
                Path(item.relative_path).name.casefold(),
                item.relative_path,
            )
        )
        for entry in current_entries:
            results.append(entry)
            if max_entries is not None and len(results) >= max_entries:
                return results
            if entry.is_dir and not entry.is_symlink:
                pending.append(entry.path)
    return results


def _to_result(
    scanned: list[_ScannedEntry],
) -> ArtifactListResult:
    """Sort, cap, and hydrate scanned entries into an ``ArtifactListResult``."""
    # Order breadth-first so the cap preserves shallow workspace entries before
    # descendants, then sort each directory's children naturally.
    def sort_key(item: _ScannedEntry) -> tuple[int, str, bool, str, str]:
        parts = item.relative_path.split("/")
        return (
            len(parts),
            "/".join(parts[:-1]).casefold(),
            not item.is_dir,
            parts[-1].casefold(),
            item.relative_path,
        )

    scanned.sort(key=sort_key)

    truncated = len(scanned) > MAX_ARTIFACT_FILES
    if truncated:
        scanned = scanned[:MAX_ARTIFACT_FILES]

    files: list[ArtifactFile] = []
    for entry in scanned:
        guessed, _ = mimetypes.guess_type(entry.path.name)
        modified_at = datetime.fromtimestamp(
            entry.modified_at, tz=timezone.utc
        ).astimezone().isoformat()
        files.append(
            ArtifactFile(
                path=entry.relative_path,
                absolute_path=str(entry.path),
                name=entry.path.name,
                size=entry.size,
                size_human=_human_size(entry.size),
                mime=("inode/directory" if entry.is_dir else guessed)
                or "application/octet-stream",
                modified_at=modified_at,
                is_dir=entry.is_dir,
                is_symlink=entry.is_symlink,
            )
        )
    return ArtifactListResult(files=files, truncated=truncated)


def list_artifacts(output_dir: Path) -> ArtifactListResult:
    """Scan the shared output directory and return all directory entries.

    The directory is walked recursively without filtering names. Symlinks are
    listed but not traversed. Returns at most MAX_ARTIFACT_FILES entries;
    ``truncated`` is True if the limit was hit.
    """
    root = Path(output_dir).resolve(strict=False)
    return _to_result(
        _scan_files(
            root,
            raise_root_errors=True,
            max_entries=MAX_ARTIFACT_FILES + 1,
        )
    )


def list_project_files(project_dir: Path) -> ArtifactListResult:
    """Scan a project session's workspace directory and return all entries.

    Same recursive scan and cap as :func:`list_artifacts`; no names or
    dependency/build directories are filtered.
    """
    root = Path(project_dir).resolve(strict=False)
    return _to_result(
        _scan_files(
            root,
            raise_root_errors=True,
            max_entries=MAX_ARTIFACT_FILES + 1,
        )
    )


def artifact_signature(output_dir: Path) -> str:
    """Cheap change-detection signature over the shared output directory.

    Aggregates relative path + mtime + size of every entry (same traversal as
    ``list_artifacts``) into a stable hex digest.
    File content is never read, so polling stays inexpensive.
    """
    root = Path(output_dir).resolve(strict=False)
    scanned = _scan_files(root)
    digest = hashlib.blake2b(digest_size=16)
    for entry in sorted(scanned, key=lambda item: item.relative_path):
        digest.update(entry.relative_path.encode("utf-8", "surrogateescape"))
        digest.update(b"\0")
        digest.update(b"d" if entry.is_dir else b"f")
        digest.update(b"l" if entry.is_symlink else b"r")
        digest.update(b"\0")
        digest.update(str(entry.size).encode("ascii"))
        digest.update(b"\0")
        digest.update(str(entry.modified_at).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()
