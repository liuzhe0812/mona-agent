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
import sys
import tarfile
from pathlib import Path


def build_package(staging_dir: str, output_path: str) -> None:
    """Create a zstd-compressed tar archive from the staging directory."""
    import zstandard

    staging = Path(staging_dir)
    if not staging.exists():
        raise FileNotFoundError(f"Staging directory does not exist: {staging_dir}")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Use zstd level 19 for a good balance between size and speed.
    # Level 22 is very slow for large packages; 19 is close in ratio.
    cctx = zstandard.ZstdCompressor(level=19, threads=0)

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
