"""Create and verify the pinned Vibe-Trading source snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tomllib
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

UPSTREAM_URL = "https://github.com/HKUDS/Vibe-Trading"
ARCHIVE_NAME = "vibe-trading-source.zip"
LOCK_NAME = "source-lock.json"
FILES_NAME = "files.json"
ROOT_FILES = (
    "LICENSE",
    "MANIFEST.in",
    "NOTICE",
    "README.md",
    "pyproject.toml",
    "requirements-channels-lock.txt",
    "requirements-lock.txt",
    "desktop/electron/requirements-windows-lock.txt",
)
EXCLUDED_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".ui_runtime",
    ".venv",
    "__pycache__",
    "cache",
    "caches",
    "node_modules",
    "runs",
    "user-data",
    "user_data",
    "userdata",
    "venv",
}
EXCLUDED_FILE_SUFFIXES = {".pyc", ".pyo"}
ALLOWED_ENV_TEMPLATES = {".env.example", ".env.template"}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_tree_hash(files: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for item in files:
        digest.update(item["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(item["size"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(item["sha256"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _excluded_file(name: str) -> bool:
    lower = name.lower()
    return (
        lower.startswith(".env") and lower not in ALLOWED_ENV_TEMPLATES
    ) or Path(name).suffix.lower() in EXCLUDED_FILE_SUFFIXES


def _collect_files(source_root: Path) -> list[tuple[str, Path]]:
    selected: dict[str, Path] = {}
    for relative in ROOT_FILES:
        path = source_root / Path(relative)
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError(f"Required source file missing: {relative}")
        selected[relative] = path

    agent_root = source_root / "agent"
    if not agent_root.is_dir() or agent_root.is_symlink():
        raise FileNotFoundError("Required source directory missing: agent")

    for current, dirnames, filenames in os.walk(agent_root, topdown=True, followlinks=False):
        current_path = Path(current)
        kept_dirs: list[str] = []
        for dirname in sorted(dirnames):
            directory = current_path / dirname
            if directory.is_symlink():
                raise ValueError(f"Source contains a directory symlink: {directory}")
            if dirname.lower() not in EXCLUDED_DIRS:
                kept_dirs.append(dirname)
        dirnames[:] = kept_dirs

        for filename in sorted(filenames):
            path = current_path / filename
            if path.is_symlink():
                raise ValueError(f"Source contains a file symlink: {path}")
            if _excluded_file(filename):
                continue
            relative = path.relative_to(source_root).as_posix()
            selected[relative] = path

    return sorted(selected.items())


def _load_source_metadata(source_root: Path) -> dict[str, Any]:
    pyproject = tomllib.loads((source_root / "pyproject.toml").read_text(encoding="utf-8"))
    project = pyproject["project"]
    return {
        "upstream_url": UPSTREAM_URL,
        "git_metadata": "absent; commit and tag are unknown",
        "declared_package_version": project.get("version"),
        "declared_repository_url": project.get("urls", {}).get("Repository"),
    }


def create_snapshot(source_root: Path, snapshot_root: Path) -> dict[str, Any]:
    source_root = source_root.resolve(strict=True)
    snapshot_root = snapshot_root.resolve()
    if source_root == snapshot_root or source_root in snapshot_root.parents or snapshot_root in source_root.parents:
        raise ValueError("Source and snapshot directories must not contain one another")

    snapshot_root.mkdir(parents=True, exist_ok=True)
    archive_path = snapshot_root / ARCHIVE_NAME
    files_path = snapshot_root / FILES_NAME
    lock_path = snapshot_root / LOCK_NAME
    if any(path.exists() for path in (archive_path, files_path, lock_path)):
        raise FileExistsError(f"Refusing to replace existing snapshot files under {snapshot_root}")

    files: list[dict[str, Any]] = []
    source_entries = _collect_files(source_root)
    archive_temp = snapshot_root / f".{ARCHIVE_NAME}.tmp"
    try:
        with zipfile.ZipFile(
            archive_temp,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for relative, path in source_entries:
                data = path.read_bytes()
                files.append({"path": relative, "sha256": _sha256(data), "size": len(data)})
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.flag_bits = 0
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

        files_bytes = (json.dumps(files, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        files_path.write_bytes(files_bytes)
        archive_bytes = archive_temp.read_bytes()
        lock = {
            "snapshot_id": f"sha256:{_canonical_tree_hash(files)}",
            "source": _load_source_metadata(source_root),
            "archive": {
                "path": ARCHIVE_NAME,
                "sha256": _sha256(archive_bytes),
                "size": len(archive_bytes),
                "format": "zip-deflate-level-9; sorted paths; fixed 1980-01-01 timestamps",
            },
            "files_manifest": {
                "path": FILES_NAME,
                "sha256": _sha256(files_bytes),
                "count": len(files),
                "raw_bytes": sum(item["size"] for item in files),
            },
        }
        lock_bytes = (json.dumps(lock, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        lock_path.write_bytes(lock_bytes)
        archive_temp.rename(archive_path)
        return lock
    except Exception:
        archive_temp.unlink(missing_ok=True)
        files_path.unlink(missing_ok=True)
        lock_path.unlink(missing_ok=True)
        raise


def verify_snapshot(snapshot_root: Path) -> dict[str, Any]:
    """Verify the lock, file manifest, archive membership, and every payload hash."""
    snapshot_root = snapshot_root.resolve(strict=True)
    lock = json.loads((snapshot_root / LOCK_NAME).read_text(encoding="utf-8"))
    files_meta = lock["files_manifest"]
    files_path = _safe_child(snapshot_root, files_meta["path"])
    files_bytes = files_path.read_bytes()
    if _sha256(files_bytes) != files_meta["sha256"]:
        raise ValueError("Files manifest SHA-256 mismatch")
    files = json.loads(files_bytes)
    if len(files) != files_meta["count"] or sum(item["size"] for item in files) != files_meta["raw_bytes"]:
        raise ValueError("Files manifest totals do not match source lock")
    if _canonical_tree_hash(files) != lock["snapshot_id"].removeprefix("sha256:"):
        raise ValueError("Snapshot identity does not match files manifest")

    archive_meta = lock["archive"]
    archive_path = _safe_child(snapshot_root, archive_meta["path"])
    archive_bytes = archive_path.read_bytes()
    if len(archive_bytes) != archive_meta["size"] or _sha256(archive_bytes) != archive_meta["sha256"]:
        raise ValueError("Source archive size or SHA-256 mismatch")

    expected = {item["path"]: item for item in files}
    with zipfile.ZipFile(archive_path, "r") as archive:
        members = archive.namelist()
        if len(members) != len(set(members)) or set(members) != set(expected):
            raise ValueError("Archive members do not match files manifest")
        for name in members:
            _validate_member_path(name)
            data = archive.read(name)
            item = expected[name]
            if len(data) != item["size"] or _sha256(data) != item["sha256"]:
                raise ValueError(f"Archive payload mismatch: {name}")
    return lock


def _validate_member_path(name: str) -> None:
    if "\\" in name or "\0" in name:
        raise ValueError(f"Unsafe archive member path: {name}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe archive member path: {name}")
    if re.match(r"^[A-Za-z]:", name):
        raise ValueError(f"Unsafe archive member path: {name}")


def _safe_child(root: Path, relative: str) -> Path:
    _validate_member_path(relative)
    path = (root / Path(*PurePosixPath(relative).parts)).resolve(strict=True)
    if root != path and root not in path.parents:
        raise ValueError(f"Path escapes snapshot directory: {relative}")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create", help="create a deterministic source snapshot")
    create.add_argument("--source", type=Path, required=True)
    create.add_argument("--snapshot-root", type=Path, default=Path("third_party/vibe-trading"))
    verify = subparsers.add_parser("verify", help="verify an existing source snapshot")
    verify.add_argument("--snapshot-root", type=Path, default=Path("third_party/vibe-trading"))
    args = parser.parse_args()

    if args.command == "create":
        lock = create_snapshot(args.source, args.snapshot_root)
    else:
        lock = verify_snapshot(args.snapshot_root)
    print(json.dumps(lock, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
