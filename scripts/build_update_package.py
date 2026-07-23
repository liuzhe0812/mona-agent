r"""Build Mona hot-update package as a zstd-compressed tar archive.

The package contains Mona.exe and mona-gateway/ directory, ready for
uploading to Qiniu Cloud and distribution via the update manifest.

Usage:
  python scripts/build_update_package.py <version> <staging_dir> <output_path>

Example:
  python scripts/build_update_package.py 1.0.7 \
    "$env:TEMP\mona-update-staging" \
    "dist\mona-1.0.7.tar.zst"
"""

from __future__ import annotations

import hashlib
import shutil
import sys
import tarfile
from pathlib import Path

# Runtime-irrelevant artifacts left behind by PyInstaller COLLECT.
# Stripping them shrinks the update package by ~25-35%.
#
# NOTE: `.dist-info/` and `.egg-info/` are intentionally KEPT — some libs
# read their own version via importlib.metadata at runtime, and PyInstaller's
# metadata hook is not 100% reliable. These dirs are tiny anyway (<3% total).
_JUNK_DIR_NAMES = {
    "__pycache__",
    "tests",
    "test",
    "testing",
    "_pytest",
    "pytest",
}

_JUNK_FILE_SUFFIXES = (
    ".pyc",
    ".pyo",
)

_JUNK_FILE_NAMES = {
    "py.typed",  # PEP 561 marker, unused at runtime
}


def clean_staging(staging: Path) -> tuple[int, int]:
    """Remove runtime-irrelevant files from the staging directory.

    Only touches the mona-gateway/ subtree (where PyInstaller output lives).
    Returns (deleted_files, deleted_dirs) counts for logging.
    """
    gateway_dir = staging / "mona-gateway"
    if not gateway_dir.exists():
        return 0, 0

    deleted_files = 0
    deleted_dirs = 0

    for path in gateway_dir.rglob("*"):
        if not path.exists():
            continue
        if path.is_dir():
            if path.name in _JUNK_DIR_NAMES:
                shutil.rmtree(path, ignore_errors=True)
                deleted_dirs += 1
        elif path.is_file():
            if (
                path.name in _JUNK_FILE_NAMES
                or path.name.endswith(_JUNK_FILE_SUFFIXES)
            ):
                path.unlink(missing_ok=True)
                deleted_files += 1

    return deleted_files, deleted_dirs


def build_package(staging_dir: str, output_path: str) -> None:
    """Create a zstd-compressed tar archive from the staging directory."""
    import zstandard

    staging = Path(staging_dir)
    if not staging.exists():
        raise FileNotFoundError(f"Staging directory does not exist: {staging_dir}")

    del_files, del_dirs = clean_staging(staging)
    print(f"[clean] Removed {del_files} files, {del_dirs} dirs from staging")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Level 22 maximizes compression ratio. Build-time cost is acceptable
    # since releases are infrequent; download size matters more to users.
    cctx = zstandard.ZstdCompressor(level=22, threads=0)

    with open(output, "wb") as f:
        with cctx.stream_writer(f) as compressor:
            with tarfile.open(fileobj=compressor, mode="w") as tar:
                for item in staging.iterdir():
                    tar.add(item, arcname=item.name)

    size = output.stat().st_size
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"Package: {output}")
    print(f"Size: {size} bytes ({size / 1_048_576:.1f} MB)")
    print(f"SHA256: {sha}")


def main() -> None:
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)

    _version, staging_dir, output_path = sys.argv[1:4]
    build_package(staging_dir, output_path)


if __name__ == "__main__":
    main()
