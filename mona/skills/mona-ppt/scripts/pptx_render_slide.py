#!/usr/bin/env python3
"""Render the first slide of a PPTX as a preview image.

Strategy:
1. Extract docProps/thumbnail from PPTX (most PPTX files have this)
2. Fallback: generate a simple preview from theme colors + title text
"""

import zipfile
from pathlib import Path


def render_first_slide(pptx_path: Path, output_path: Path, size: tuple[int, int] = (1280, 720)) -> bool:
    """Render first slide of PPTX as preview image.

    Args:
        pptx_path: Path to the PPTX file.
        output_path: Output path WITHOUT extension. The function will add
            the appropriate extension (.png, .jpg, or .svg).
        size: Target size (used for SVG fallback only).

    Returns:
        True if preview was generated successfully.
    """
    # 1. Try extracting docProps/thumbnail
    try:
        with zipfile.ZipFile(str(pptx_path), "r") as zf:
            for name in zf.namelist():
                if name.startswith("docProps/thumbnail"):
                    data = zf.read(name)
                    ext = Path(name).suffix.lower()
                    if ext in (".emf", ".wmf"):
                        continue
                    if ext in (".png", ".jpeg", ".jpg"):
                        out_ext = ".png" if ext == ".png" else ".jpg"
                        out_file = output_path.with_suffix(out_ext)
                        out_file.write_bytes(data)
                        return True
    except (zipfile.BadZipFile, Exception):
        pass

    # 2. Fallback: generate preview from theme colors
    try:
        from pptx import Presentation

        prs = Presentation(str(pptx_path))
        primary_color = "#1A1A1A"
        try:
            master = prs.slide_masters[0]
            ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            color_scheme = master.element.find(".//a:clrScheme", ns)
            if color_scheme is not None:
                dk1 = color_scheme.find("a:dk1/a:srgbClr", ns)
                if dk1 is not None:
                    primary_color = f"#{dk1.get('val', '1A1A1A')}"
        except Exception:
            pass

        title_text = pptx_path.stem
        _label = title_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        svg = (
            f'<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">\n'
            f'  <rect width="1280" height="720" fill="#FFFFFF"/>\n'
            f'  <rect x="0" y="0" width="1280" height="120" fill="{primary_color}"/>\n'
            f'  <text x="640" y="78" text-anchor="middle" fill="#FFFFFF" '
            f'font-family="system-ui, sans-serif" font-size="44" font-weight="bold">'
            f'{_label}</text>\n'
            f'</svg>'
        )
        svg_path = output_path.with_suffix(".svg")
        svg_path.write_text(svg, encoding="utf-8")
        return True
    except Exception:
        return False


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python pptx_render_slide.py <pptx_path> <output_path>")
        sys.exit(1)
    ok = render_first_slide(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"{'OK' if ok else 'FAIL'}: Preview generated")
