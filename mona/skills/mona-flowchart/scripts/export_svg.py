#!/usr/bin/env python3
"""Export draw.io diagram to SVG/PNG.

Phase 4 placeholder: validates XML and reports status.
Actual SVG/PNG rendering will use draw.io CLI or headless browser.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET


def validate_drawio(drawio_path: Path) -> dict:
    """Validate mxGraph XML structure."""
    if not drawio_path.exists():
        return {"ok": False, "error": f"File not found: {drawio_path}"}

    try:
        tree = ET.parse(drawio_path)
        root = tree.getroot()
    except ET.ParseError as e:
        return {"ok": False, "error": f"XML parse error: {e}"}

    if root.tag != "mxfile":
        return {"ok": False, "error": "Root element must be <mxfile>"}

    # Count cells
    cells = root.findall(".//mxCell")
    vertices = [c for c in cells if c.get("vertex") == "1"]
    edges = [c for c in cells if c.get("edge") == "1"]

    return {
        "ok": True,
        "vertices": len(vertices),
        "edges": len(edges),
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: export_svg.py <project_path>"}))
        sys.exit(1)

    project = Path(sys.argv[1])
    drawio_file = project / "diagram.drawio"

    result = validate_drawio(drawio_file)
    if not result["ok"]:
        print(json.dumps(result))
        sys.exit(1)

    # Phase 4: actual SVG/PNG export
    output_dir = project / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    print(json.dumps({
        "ok": False,
        "error": "SVG/PNG export pending (Phase 4)",
        **result,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
