#!/usr/bin/env python3
"""Auto-layout for flowchart nodes using hierarchical layering.

Reads graph.json, computes node coordinates via topological layering,
writes layout.json. Pure Python, no external dependencies.

Algorithm:
  1. Topological sort → assign each node to a hierarchy level
  2. Arrange nodes within each layer (horizontal for TB/BT, vertical for LR/RL)
  3. Compute absolute coordinates with centering
  4. Mirror for BT (bottom-to-top) / RL (right-to-left)
"""

from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

# Node sizes
DEFAULT_WIDTH = 120
DEFAULT_HEIGHT = 60
DECISION_WIDTH = 80
DECISION_HEIGHT = 80

# Spacing
GAP_X = 80  # horizontal gap between sibling nodes
GAP_Y = 60  # vertical gap between layers
START_X = 40
START_Y = 40


def _node_size(node: dict) -> tuple[int, int]:
    """Return (width, height) for a node based on its type."""
    if node.get("type") == "decision":
        return DECISION_WIDTH, DECISION_HEIGHT
    return DEFAULT_WIDTH, DEFAULT_HEIGHT


def _compute_levels(node_ids: set[str], edges: list[dict]) -> dict[str, int]:
    """Assign hierarchy levels via topological layering (longest path).

    Nodes with no incoming edges start at level 0. Each successor's level
    is max(predecessor levels) + 1. Cycle nodes are resolved by assigning
    them based on their already-processed predecessors.
    """
    successors: dict[str, list[str]] = {nid: [] for nid in node_ids}
    in_degree: dict[str, int] = {nid: 0 for nid in node_ids}
    for edge in edges:
        src = edge.get("source")
        tgt = edge.get("target")
        if src in node_ids and tgt in node_ids:
            successors[src].append(tgt)
            in_degree[tgt] += 1

    levels: dict[str, int] = {nid: 0 for nid in node_ids}
    queue: deque[str] = deque(
        sorted(nid for nid in node_ids if in_degree[nid] == 0)
    )
    processed: set[str] = set()

    while queue:
        current = queue.popleft()
        processed.add(current)
        for succ in successors[current]:
            levels[succ] = max(levels[succ], levels[current] + 1)
            in_degree[succ] -= 1
            if in_degree[succ] == 0 and succ not in processed:
                queue.append(succ)

    # Handle cycle nodes: assign based on processed predecessors
    unprocessed = node_ids - processed
    if unprocessed:
        predecessors: dict[str, list[str]] = {nid: [] for nid in node_ids}
        for edge in edges:
            src = edge.get("source")
            tgt = edge.get("target")
            if src in node_ids and tgt in node_ids:
                predecessors[tgt].append(src)
        for nid in unprocessed:
            pred_levels = [levels[p] for p in predecessors[nid] if p in processed]
            if pred_levels:
                levels[nid] = max(pred_levels) + 1

    return levels


def auto_layout(graph: dict) -> dict:
    """计算布局坐标,返回 {node_id: {x, y, width, height}}."""
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    direction = graph.get("metadata", {}).get("direction", "TB").upper()

    if not nodes:
        return {}

    node_ids = {n["id"] for n in nodes}
    levels = _compute_levels(node_ids, edges)

    # Group nodes by level
    level_groups: dict[int, list[dict]] = {}
    for node in nodes:
        lvl = levels.get(node["id"], 0)
        level_groups.setdefault(lvl, []).append(node)

    sorted_levels = sorted(level_groups.keys())
    result: dict[str, dict] = {}

    if direction in ("TB", "BT"):
        # Layers stack vertically; nodes in same layer arranged horizontally
        layer_step = DEFAULT_HEIGHT + GAP_Y
        layer_widths: dict[int, int] = {}
        for lvl, group in level_groups.items():
            total = sum(_node_size(n)[0] for n in group)
            total += GAP_X * max(0, len(group) - 1)
            layer_widths[lvl] = total
        max_width = max(layer_widths.values()) if layer_widths else 0

        for idx, lvl in enumerate(sorted_levels):
            group = level_groups[lvl]
            row_y = START_Y + idx * layer_step
            row_w = layer_widths[lvl]
            x_cursor = START_X + (max_width - row_w) // 2
            for node in group:
                w, h = _node_size(node)
                result[node["id"]] = {
                    "x": x_cursor,
                    "y": row_y,
                    "width": w,
                    "height": h,
                }
                x_cursor += w + GAP_X
    else:
        # LR / RL: layers stack horizontally; nodes in same layer arranged vertically
        layer_step = DEFAULT_WIDTH + GAP_X
        layer_heights: dict[int, int] = {}
        for lvl, group in level_groups.items():
            total = sum(_node_size(n)[1] for n in group)
            total += GAP_Y * max(0, len(group) - 1)
            layer_heights[lvl] = total
        max_height = max(layer_heights.values()) if layer_heights else 0

        for idx, lvl in enumerate(sorted_levels):
            group = level_groups[lvl]
            col_x = START_X + idx * layer_step
            col_h = layer_heights[lvl]
            y_cursor = START_Y + (max_height - col_h) // 2
            for node in group:
                w, h = _node_size(node)
                result[node["id"]] = {
                    "x": col_x,
                    "y": y_cursor,
                    "width": w,
                    "height": h,
                }
                y_cursor += h + GAP_Y

    # Mirror for BT (bottom-to-top) and RL (right-to-left)
    if direction == "BT":
        max_y = max(r["y"] + r["height"] for r in result.values())
        for r in result.values():
            r["y"] = max_y - r["y"] - r["height"]
    elif direction == "RL":
        max_x = max(r["x"] + r["width"] for r in result.values())
        for r in result.values():
            r["x"] = max_x - r["x"] - r["width"]

    return result


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: auto_layout.py <project_path>"}))
        sys.exit(1)

    project = Path(sys.argv[1])
    graph_file = project / "graph.json"
    if not graph_file.exists():
        print(json.dumps({"ok": False, "error": f"graph.json not found: {graph_file}"}))
        sys.exit(1)

    graph = json.loads(graph_file.read_text(encoding="utf-8"))
    layout = auto_layout(graph)

    layout_file = project / "layout.json"
    layout_data = {
        "nodes": [{"id": nid, **coords} for nid, coords in layout.items()]
    }
    layout_file.write_text(
        json.dumps(layout_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "ok": True,
        "layout_file": str(layout_file),
        "nodes": len(layout),
    }))


if __name__ == "__main__":
    main()
