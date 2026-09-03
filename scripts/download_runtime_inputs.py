"""Download hash-pinned runtime build inputs with mainland-first mirrors."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from mona.runtime.download import VerifiedDownloader


async def download_inputs(manifest_path: Path, output_dir: Path) -> None:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    sources = payload.get("sources") if isinstance(payload, dict) else None
    if not isinstance(sources, list):
        raise ValueError("runtime source manifest must contain a sources list")
    downloader = VerifiedDownloader(read_timeout_seconds=120, lock_timeout_seconds=600)
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("runtime source entries must be objects")
        filename = str(source.get("filename") or "")
        urls = source.get("urls")
        if not filename or Path(filename).name != filename or not isinstance(urls, list):
            raise ValueError("invalid runtime source filename or URLs")
        print(f"Downloading {source.get('id')}@{source.get('version')}...")
        await downloader.download(
            [str(url) for url in urls],
            output_dir / filename,
            expected_sha256=str(source.get("sha256") or ""),
            expected_size=int(source.get("size") or 0),
            progress=lambda current, total: print(
                f"  {current * 100 // total if total else 0}%",
                end="\r",
            ),
        )
        print("  verified")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("runtime-library/sources.json"),
    )
    parser.add_argument("--output", type=Path, default=Path("dist/runtime-inputs"))
    args = parser.parse_args()
    asyncio.run(download_inputs(args.manifest, args.output))


if __name__ == "__main__":
    main()
