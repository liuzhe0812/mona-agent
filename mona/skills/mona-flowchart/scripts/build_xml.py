#!/usr/bin/env python3
"""Build mxGraph XML (draw.io format) from graph.json.

Reads graph.json (logical structure), calls auto_layout to compute
coordinates, writes diagram.drawio (mxGraph XML).

Usage:
    python build_xml.py <project_path>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

# Ensure auto_layout module is importable when run as a standalone script
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from auto_layout import auto_layout  # noqa: E402

NODE_STYLES: dict[str, str] = {
    "start": "ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
    "end": "ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;",
    "process": "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;",
    "decision": "rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;",
    "data": "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;",
    "document": "shape=document;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=#f5f5f5;strokeColor=#666666;",
}

EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;"


def build_xml(graph: dict, layout: dict | None = None) -> str:
    """Generate mxGraph XML from logical graph.

    Args:
        graph: Logical graph dict with metadata, nodes, edges.
        layout: Optional pre-computed layout {node_id: {x, y, width, height}}.
            If None, auto_layout(graph) is called to compute coordinates.

    Returns:
        mxGraph XML string (pretty-printed).
    """
    if layout is None:
        layout = auto_layout(graph)

    mxfile = ET.Element("mxfile")
    title = graph.get("metadata", {}).get("title", "Page-1")
    diagram = ET.SubElement(mxfile, "diagram", {"name": title, "id": "page1"})
    model = ET.SubElement(diagram, "mxGraphModel")
    root = ET.SubElement(model, "root")

    # Root cells required by mxGraph
    ET.SubElement(root, "mxCell", {"id": "0"})
    ET.SubElement(root, "mxCell", {"id": "1", "parent": "0"})

    # Nodes (vertices)
    for node in graph.get("nodes", []):
        node_id = node["id"]
        node_type = node.get("type", "process")
        label = node.get("label", "")
        style = NODE_STYLES.get(node_type, NODE_STYLES["process"])

        pos = layout.get(node_id, {"x": 0, "y": 0, "width": 120, "height": 60})
        cell = ET.SubElement(root, "mxCell", {
            "id": node_id,
            "value": label,
            "style": style,
            "vertex": "1",
            "parent": "1",
        })
        ET.SubElement(cell, "mxGeometry", {
            "x": str(pos.get("x", 0)),
            "y": str(pos.get("y", 0)),
            "width": str(pos.get("width", 120)),
            "height": str(pos.get("height", 60)),
            "as": "geometry",
        })

    # Edges
    for i, edge in enumerate(graph.get("edges", [])):
        edge_id = f"e{i + 1}"
        cell = ET.SubElement(root, "mxCell", {
            "id": edge_id,
            "value": edge.get("label", ""),
            "style": EDGE_STYLE,
            "edge": "1",
            "parent": "1",
            "source": edge["source"],
            "target": edge["target"],
        })
        ET.SubElement(cell, "mxGeometry", {"relative": "1", "as": "geometry"})

    # Pretty-print with 2-space indentation
    ET.indent(mxfile, space="  ")
    return ET.tostring(mxfile, encoding="unicode")


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: build_xml.py <project_path>"}))
        sys.exit(1)

    project = Path(sys.argv[1])
    graph_file = project / "graph.json"
    if not graph_file.exists():
        print(json.dumps({"ok": False, "error": f"graph.json not found: {graph_file}"}))
        sys.exit(1)

    graph = json.loads(graph_file.read_text(encoding="utf-8"))
    xml = build_xml(graph)

    drawio_file = project / "diagram.drawio"
    drawio_file.write_text(xml, encoding="utf-8")
    print(json.dumps({"ok": True, "drawio_file": str(drawio_file)}))


if __name__ == "__main__":
    main()
