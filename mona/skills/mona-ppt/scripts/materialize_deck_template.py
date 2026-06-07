#!/usr/bin/env python3
"""Materialize a PPTX import workspace into a deck template directory.

Usage:
    python materialize_deck_template.py <workspace_dir> -o <deck_dir> --name <display_name>

Reads:
    <workspace_dir>/manifest.json
    <workspace_dir>/svg-flat/slide_*.svg
    <workspace_dir>/assets/

Writes:
    <deck_dir>/design_spec.md
    <deck_dir>/manifest.json
    <deck_dir>/01.svg ... <deck_dir>/NN.svg
    <deck_dir>/assets/
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path


def _slugify(name: str) -> str:
    """Convert a display name to a safe directory id."""
    slug = re.sub(r"[^\w\u4e00-\u9fff-]", "_", name.strip())
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug or "deck"


def _build_design_spec(name: str, page_count: int, canvas: str, primary_color: str) -> str:
    """Generate design_spec.md with Page Roster."""
    roster_rows = []
    for i in range(1, page_count + 1):
        roster_rows.append(f"| {i:02d}.svg | source-order | {i} | 源 PPT 第 {i} 页 |")

    roster = "\n".join(roster_rows)

    return (
        f"---\n"
        f"name: {name}\n"
        f"kind: deck\n"
        f"canvas: {canvas}\n"
        f"replication_mode: mirror\n"
        f"primary_color: \"{primary_color}\"\n"
        f"---\n\n"
        f"# Template Overview\n\n"
        f"这是一套从用户上传 PPTX 导入的完整模板。生成时优先复用页面结构，再替换内容。\n\n"
        f"# Page Roster\n\n"
        f"| Template SVG | Page Type | Source Slide | Use When |\n"
        f"| --- | --- | --- | --- |\n"
        f"{roster}\n\n"
        f"# Usage Rules\n\n"
        f"- Strategist 必须从 Page Roster 里为每页选择模板。\n"
        f"- 选择结果必须写入 `spec_lock.md` 的 `page_layouts`。\n"
        f"- Executor 必须先读取对应 SVG，再替换内容，不要自由重画整页。\n"
        f"- 如果没有合适模板页，才允许自由设计，并在 `spec_lock.md` 写明原因。\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize deck template from import workspace")
    parser.add_argument("workspace", help="Import workspace directory (contains manifest.json + svg-flat/)")
    parser.add_argument("-o", "--output", required=True, help="Output deck directory")
    parser.add_argument("--name", required=True, help="Display name for the template")
    parser.add_argument("--canvas", default="ppt169", help="Canvas format (default: ppt169)")
    args = parser.parse_args()

    workspace = Path(args.workspace)
    output_dir = Path(args.output)

    if not workspace.is_dir():
        print(f"Error: workspace not found: {workspace}", file=sys.stderr)
        return 1

    manifest_path = workspace / "manifest.json"
    if not manifest_path.exists():
        print("Error: manifest.json not found in workspace", file=sys.stderr)
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Find svg-flat slides
    svg_flat_dir = workspace / "svg-flat"
    if not svg_flat_dir.is_dir():
        print("Error: svg-flat/ not found in workspace", file=sys.stderr)
        return 1

    svg_files = sorted(svg_flat_dir.glob("slide_*.svg"))
    if not svg_files:
        print("Error: no slide_*.svg found in svg-flat/", file=sys.stderr)
        return 1

    # Extract primary color from manifest
    theme_colors = manifest.get("theme", {}).get("colors", {})
    primary_color = theme_colors.get("primary", "#1A1A1A")
    if not primary_color:
        primary_color = theme_colors.get("dk1", "#1A1A1A")

    page_count = len(svg_files)

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # Copy SVG files with sequential naming
    for i, svg_file in enumerate(svg_files, start=1):
        dest = output_dir / f"{i:02d}.svg"
        shutil.copy2(svg_file, dest)

    # Copy manifest.json
    shutil.copy2(manifest_path, output_dir / "manifest.json")

    # Copy assets/ if exists
    assets_src = workspace / "assets"
    if assets_src.is_dir():
        shutil.copytree(assets_src, output_dir / "assets", dirs_exist_ok=True)

    # Copy template.pptx if exists
    template_pptx = workspace / "template.pptx"
    if template_pptx.exists():
        shutil.copy2(template_pptx, output_dir / "template.pptx")

    # Generate design_spec.md
    design_spec = _build_design_spec(args.name, page_count, args.canvas, primary_color)
    (output_dir / "design_spec.md").write_text(design_spec, encoding="utf-8")

    print(f"[OK] Deck template materialized: {output_dir}")
    print(f"     Pages: {page_count}")
    print(f"     Canvas: {args.canvas}")
    print(f"     Primary color: {primary_color}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
