#!/usr/bin/env python3
"""CLI entry point for PPTX template import.

Usage:
    python pptx_template_import.py <pptx_file> -o <output_dir> [--manifest-only]

Options:
    --manifest-only   Only generate manifest.json (skip SVG rendering)
"""

import argparse
import json
import sys
from pathlib import Path

# Ensure the scripts directory is on sys.path so template_import can be found
_scripts_dir = str(Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from template_import.manifest import build_manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Import PPTX as a brand template")
    parser.add_argument("pptx_file", help="Path to the PPTX file to import")
    parser.add_argument("-o", "--output", required=True, help="Output directory")
    parser.add_argument(
        "--manifest-only",
        action="store_true",
        help="Only generate manifest.json (skip SVG rendering)",
    )
    args = parser.parse_args()

    pptx_path = Path(args.pptx_file)
    output_dir = Path(args.output)

    if not pptx_path.exists():
        print(f"Error: {pptx_path} not found", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        manifest = build_manifest(pptx_path, output_dir)

        manifest_path = output_dir / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"[OK] Manifest written to {manifest_path}")
        print(f"     Slides: {len(manifest.get('slides', []))}")
        print(f"     Layouts: {len(manifest.get('layouts', []))}")
        print(f"     Masters: {len(manifest.get('masters', []))}")
        print(f"     Theme colors: {len(manifest.get('theme', {}).get('colors', {}))}")
        print(f"     Assets: {len(manifest.get('assets', {}).get('allAssets', []))}")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
