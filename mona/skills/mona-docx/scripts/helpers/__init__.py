"""Shared workspace and archive checks for DOCX helpers."""

import os
import stat
import zipfile
from pathlib import Path, PurePosixPath

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_PART_BYTES = 256 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_FILES = 20_000


def workspace_path(value: str | Path) -> Path:
    configured = os.environ.get("MONA_ACTIVE_WORKSPACE")
    if not configured:
        raise ValueError("Missing active workspace")
    root = Path(configured).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Active workspace is not a directory")
    path = Path(value).expanduser()
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("Input and output paths must stay inside the active workspace")
    return resolved


def validate_tree(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError(f"Links are not allowed in unpacked DOCX content: {path}")
        if not path.resolve().is_relative_to(root):
            raise ValueError("Unpacked DOCX content escaped the active workspace")


def validate_archive(archive: zipfile.ZipFile) -> None:
    seen: set[str] = set()
    total = 0
    for info in archive.infolist():
        name = info.filename.rstrip("/")
        path = PurePosixPath(name)
        if (not name or "\\" in name or "\x00" in name or path.is_absolute()
                or ".." in path.parts or any(":" in part for part in path.parts)):
            raise ValueError(f"Unsafe DOCX archive path: {info.filename}")
        normalized = path.as_posix().casefold()
        if normalized in seen:
            raise ValueError(f"Duplicate DOCX archive path: {info.filename}")
        seen.add(normalized)
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode) or info.flag_bits & 1:
            raise ValueError("DOCX archives cannot contain links or encrypted entries")
        total += info.file_size
        if len(seen) > MAX_FILES or info.file_size > MAX_PART_BYTES or total > MAX_ARCHIVE_BYTES:
            raise ValueError("DOCX archive exceeds size limits")
