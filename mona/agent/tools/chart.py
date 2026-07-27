"""Chart rendering tool: generate SVG charts from data.

Pure-Python SVG generation — no external dependencies. Supports:
    - bar    : vertical bar chart
    - line   : line chart with optional markers
    - pie    : pie chart
    - area   : area chart (line chart with filled area)

Input data is a list of (label, value) pairs or a list of (label, [series1, series2, ...])
for multi-series bar/line charts. Output is an SVG file saved to the workspace
media directory, returned as an artifact path.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import Field

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.path_utils import get_current_workspace, resolve_workspace_path
from mona.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.schema import Base
from mona.utils.helpers import ensure_dir

_CHART_TYPES = ("bar", "line", "pie", "area")
_DEFAULT_WIDTH = 720
_DEFAULT_HEIGHT = 480
_DEFAULT_PALETTE = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
]


class ChartToolConfig(Base):
    """Chart rendering tool configuration."""

    enable: bool = True
    default_width: int = Field(default=_DEFAULT_WIDTH, ge=200, le=2400)
    default_height: int = Field(default=_DEFAULT_HEIGHT, ge=200, le=2400)
    restrict_to_workspace: bool = False


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _format_number(v: float) -> str:
    if v == int(v):
        return str(int(v))
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _nice_ticks(low: float, high: float, n: int = 5) -> list[float]:
    """Generate "nice" axis tick values between low and high."""
    if low == high:
        high = low + 1
    span = high - low
    raw_step = span / max(n - 1, 1)
    mag = 10 ** math.floor(math.log10(raw_step)) if raw_step > 0 else 1
    norm = raw_step / mag
    if norm < 1.5:
        step = 1 * mag
    elif norm < 3:
        step = 2 * mag
    elif norm < 7:
        step = 5 * mag
    else:
        step = 10 * mag
    start = math.floor(low / step) * step
    ticks: list[float] = []
    v = start
    while v <= high + step * 0.001:
        if v >= low - step * 0.001:
            ticks.append(v)
        v += step
    return ticks


def _normalize_data(data: list[Any]) -> tuple[list[str], list[list[float]]]:
    """Normalize input data into (labels, series_values).

    Accepts:
        [{"label": "A", "value": 10}, ...]
        [["A", 10], ["B", 20], ...]
        [{"label": "A", "values": [10, 20]}, ...]  # multi-series
        [["A", [10, 20]], ...]                      # multi-series
    """
    labels: list[str] = []
    series_count = 1
    raw_rows: list[list[float]] = []

    for item in data:
        if isinstance(item, dict):
            label = str(item.get("label", item.get("name", item.get("x", ""))))
            if "values" in item:
                vals = item["values"]
                if not isinstance(vals, list):
                    vals = [vals]
                series_count = max(series_count, len(vals))
                raw_rows.append([float(v) for v in vals])
            else:
                v = item.get("value", item.get("y", 0))
                raw_rows.append([float(v)])
            labels.append(label)
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            labels.append(str(item[0]))
            rest = item[1:]
            if len(rest) == 1 and isinstance(rest[0], list):
                vals = [float(v) for v in rest[0]]
                series_count = max(series_count, len(vals))
                raw_rows.append(vals)
            else:
                vals = [float(v) for v in rest]
                series_count = max(series_count, len(vals))
                raw_rows.append(vals)
        else:
            labels.append(str(item))
            raw_rows.append([0.0])

    # Pad rows to series_count
    for row in raw_rows:
        while len(row) < series_count:
            row.append(0.0)

    return labels, raw_rows


def _render_bar(
    labels: list[str],
    series: list[list[float]],
    width: int,
    height: int,
    title: str,
    series_names: list[str] | None,
) -> str:
    margin_l, margin_r, margin_t, margin_b = 60, 20, 40, 60
    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b

    n = len(labels)
    series_count = len(series[0]) if series else 1
    palette = _DEFAULT_PALETTE

    all_vals = [v for row in series for v in row]
    max_v = max(all_vals) if all_vals else 1
    min_v = min(0, min(all_vals) if all_vals else 0)
    ticks = _nice_ticks(min_v, max_v, 6)

    group_w = plot_w / max(n, 1)
    bar_w = (group_w * 0.7) / max(series_count, 1)

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="sans-serif" font-size="12">'
    ]
    if title:
        parts.append(f'<text x="{width/2:.0f}" y="20" text-anchor="middle" font-size="16" font-weight="bold">{_escape_xml(title)}</text>')

    # Y-axis grid + labels
    for t in ticks:
        y = margin_t + plot_h - (t - min_v) / (max_v - min_v or 1) * plot_h
        parts.append(f'<line x1="{margin_l}" y1="{y:.1f}" x2="{margin_l+plot_w}" y2="{y:.1f}" stroke="#e5e5e5" stroke-width="1"/>')
        parts.append(f'<text x="{margin_l-6}" y="{y+4:.1f}" text-anchor="end" fill="#666">{_format_number(t)}</text>')

    # Bars
    for i, label in enumerate(labels):
        x0 = margin_l + i * group_w + group_w * 0.15
        for s in range(series_count):
            v = series[i][s]
            y = margin_t + plot_h - (v - min_v) / (max_v - min_v or 1) * plot_h
            if v >= 0:
                y_top = y
                bar_h = margin_t + plot_h - y
            else:
                y_top = margin_t + plot_h - (0 - min_v) / (max_v - min_v or 1) * plot_h
                bar_h = y - y_top
            color = palette[s % len(palette)]
            parts.append(
                f'<rect x="{x0 + s * bar_w:.1f}" y="{y_top:.1f}" '
                f'width="{bar_w:.1f}" height="{max(bar_h, 0):.1f}" fill="{color}">'
                f'<title>{_escape_xml(label)}: {_format_number(v)}</title></rect>'
            )
        # X-axis label
        lx = margin_l + i * group_w + group_w / 2
        parts.append(f'<text x="{lx:.1f}" y="{margin_t+plot_h+18}" text-anchor="middle" fill="#333">{_escape_xml(label)}</text>')

    # Axes
    parts.append(f'<line x1="{margin_l}" y1="{margin_t}" x2="{margin_l}" y2="{margin_t+plot_h}" stroke="#333" stroke-width="1"/>')
    parts.append(f'<line x1="{margin_l}" y1="{margin_t+plot_h}" x2="{margin_l+plot_w}" y2="{margin_t+plot_h}" stroke="#333" stroke-width="1"/>')

    # Legend (multi-series)
    if series_count > 1 and series_names:
        for s, name in enumerate(series_names[:series_count]):
            lx = margin_l + plot_w - 100
            ly = margin_t + 10 + s * 18
            color = palette[s % len(palette)]
            parts.append(f'<rect x="{lx}" y="{ly}" width="12" height="12" fill="{color}"/>')
            parts.append(f'<text x="{lx+18}" y="{ly+10}" fill="#333">{_escape_xml(name)}</text>')

    parts.append("</svg>")
    return "\n".join(parts)


def _render_line(
    labels: list[str],
    series: list[list[float]],
    width: int,
    height: int,
    title: str,
    series_names: list[str] | None,
    fill_area: bool = False,
) -> str:
    margin_l, margin_r, margin_t, margin_b = 60, 20, 40, 60
    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b

    n = len(labels)
    series_count = len(series[0]) if series else 1
    palette = _DEFAULT_PALETTE

    all_vals = [v for row in series for v in row]
    max_v = max(all_vals) if all_vals else 1
    min_v = min(0, min(all_vals) if all_vals else 0)
    ticks = _nice_ticks(min_v, max_v, 6)

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="sans-serif" font-size="12">'
    ]
    if title:
        parts.append(f'<text x="{width/2:.0f}" y="20" text-anchor="middle" font-size="16" font-weight="bold">{_escape_xml(title)}</text>')

    # Y-axis grid + labels
    for t in ticks:
        y = margin_t + plot_h - (t - min_v) / (max_v - min_v or 1) * plot_h
        parts.append(f'<line x1="{margin_l}" y1="{y:.1f}" x2="{margin_l+plot_w}" y2="{y:.1f}" stroke="#e5e5e5" stroke-width="1"/>')
        parts.append(f'<text x="{margin_l-6}" y="{y+4:.1f}" text-anchor="end" fill="#666">{_format_number(t)}</text>')

    # X positions
    x_positions = []
    for i in range(n):
        x = margin_l + (i / max(n - 1, 1)) * plot_w if n > 1 else margin_l + plot_w / 2
        x_positions.append(x)

    # Draw each series
    for s in range(series_count):
        color = palette[s % len(palette)]
        pts = [(x_positions[i], margin_t + plot_h - (series[i][s] - min_v) / (max_v - min_v or 1) * plot_h) for i in range(n)]
        if fill_area and pts:
            # Area path
            path = f"M {pts[0][0]:.1f},{margin_t+plot_h:.1f} "
            for x, y in pts:
                path += f"L {x:.1f},{y:.1f} "
            path += f"L {pts[-1][0]:.1f},{margin_t+plot_h:.1f} Z"
            parts.append(f'<path d="{path}" fill="{color}" fill-opacity="0.2"/>')
        # Line
        if len(pts) >= 2:
            path = "M " + " L ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
            parts.append(f'<path d="{path}" fill="none" stroke="{color}" stroke-width="2"/>')
        # Markers
        for x, y in pts:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}"><title>{_format_number(series[pts.index((x,y))][s])}</title></circle>')

    # X-axis labels
    for i, label in enumerate(labels):
        parts.append(f'<text x="{x_positions[i]:.1f}" y="{margin_t+plot_h+18}" text-anchor="middle" fill="#333">{_escape_xml(label)}</text>')

    # Axes
    parts.append(f'<line x1="{margin_l}" y1="{margin_t}" x2="{margin_l}" y2="{margin_t+plot_h}" stroke="#333" stroke-width="1"/>')
    parts.append(f'<line x1="{margin_l}" y1="{margin_t+plot_h}" x2="{margin_l+plot_w}" y2="{margin_t+plot_h}" stroke="#333" stroke-width="1"/>')

    # Legend
    if series_count > 1 and series_names:
        for s, name in enumerate(series_names[:series_count]):
            lx = margin_l + plot_w - 100
            ly = margin_t + 10 + s * 18
            color = palette[s % len(palette)]
            parts.append(f'<line x1="{lx}" y1="{ly+6}" x2="{lx+18}" y2="{ly+6}" stroke="{color}" stroke-width="2"/>')
            parts.append(f'<text x="{lx+24}" y="{ly+10}" fill="#333">{_escape_xml(name)}</text>')

    parts.append("</svg>")
    return "\n".join(parts)


def _render_pie(
    labels: list[str],
    values: list[float],
    width: int,
    height: int,
    title: str,
) -> str:
    cx, cy = width / 2, height / 2 + (10 if title else 0)
    radius = min(width, height) / 2 - 60
    if radius < 20:
        radius = 20

    total = sum(values)
    if total <= 0:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"><text x="{width/2}" y="{height/2}" text-anchor="middle">No data</text></svg>'

    palette = _DEFAULT_PALETTE
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="sans-serif" font-size="12">'
    ]
    if title:
        parts.append(f'<text x="{width/2:.0f}" y="20" text-anchor="middle" font-size="16" font-weight="bold">{_escape_xml(title)}</text>')

    angle = -math.pi / 2  # start at top
    for i, (label, v) in enumerate(zip(labels, values)):
        if v <= 0:
            continue
        sweep = (v / total) * 2 * math.pi
        x1 = cx + radius * math.cos(angle)
        y1 = cy + radius * math.sin(angle)
        angle2 = angle + sweep
        x2 = cx + radius * math.cos(angle2)
        y2 = cy + radius * math.sin(angle2)
        large_arc = 1 if sweep > math.pi else 0
        color = palette[i % len(palette)]
        path = (
            f"M {cx:.1f},{cy:.1f} "
            f"L {x1:.1f},{y1:.1f} "
            f"A {radius:.1f},{radius:.1f} 0 {large_arc} 1 {x2:.1f},{y2:.1f} "
            f"Z"
        )
        pct = v / total * 100
        parts.append(
            f'<path d="{path}" fill="{color}" stroke="white" stroke-width="1">'
            f'<title>{_escape_xml(label)}: {_format_number(v)} ({pct:.1f}%)</title></path>'
        )
        # Label at midpoint
        mid_angle = angle + sweep / 2
        lx = cx + (radius * 0.7) * math.cos(mid_angle)
        ly = cy + (radius * 0.7) * math.sin(mid_angle)
        if pct >= 5:
            parts.append(f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="middle" fill="white" font-weight="bold">{pct:.0f}%</text>')
        angle = angle2

    # Legend
    legend_x = width - 130
    legend_y = 40
    for i, (label, v) in enumerate(zip(labels, values)):
        if v <= 0:
            continue
        color = palette[i % len(palette)]
        ly = legend_y + i * 18
        parts.append(f'<rect x="{legend_x}" y="{ly}" width="12" height="12" fill="{color}"/>')
        pct = v / total * 100
        parts.append(f'<text x="{legend_x+18}" y="{ly+10}" fill="#333">{_escape_xml(label)} ({pct:.1f}%)</text>')

    parts.append("</svg>")
    return "\n".join(parts)


@tool_parameters(
    tool_parameters_schema(
        type=StringSchema("Chart type", enum=list(_CHART_TYPES)),
        data=ArraySchema(
            ObjectSchema(
                description="One data point. Accepts {label, value} or {label, values:[...]} for multi-series.",
                additional_properties=True,
            ),
            description="Chart data as a list of points. Each point is {label, value} or {label, values:[...]} for multi-series.",
            min_items=1,
        ),
        title=StringSchema("Optional chart title"),
        series_names=ArraySchema(
            StringSchema("Series name (for legend)"),
            description="Optional names for each series (multi-series charts).",
        ),
        width=IntegerSchema(
            720,
            description="SVG width in pixels (200-2400).",
            minimum=200,
            maximum=2400,
        ),
        height=IntegerSchema(
            480,
            description="SVG height in pixels (200-2400).",
            minimum=200,
            maximum=2400,
        ),
        output=StringSchema(
            "Optional output file path (absolute or workspace-relative). "
            "If omitted, the SVG is saved to the media directory.",
        ),
        required=["type", "data"],
    )
)
class ChartTool(Tool):
    """Render data as an SVG chart and save it as an artifact."""

    _scopes = {"core", "subagent"}
    config_key = "chart"

    name = "chart"
    description = (
        "Render data as an SVG chart (bar/line/pie/area) and save it as an artifact. "
        "Input is a list of {label, value} points (or {label, values:[...]} for multi-series). "
        "Returns the saved SVG file path. Use this for data visualization instead of generate_image "
        "when you need precise data-driven charts."
    )

    @classmethod
    def config_cls(cls):
        return ChartToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.chart.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            config=ctx.config.chart,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        config: ChartToolConfig | None = None,
        restrict_to_workspace: bool = False,
    ) -> None:
        from mona.config.paths import get_workspace_path

        self._workspace = Path(workspace).expanduser() if workspace else get_workspace_path()
        self.config = config or ChartToolConfig()
        self._restrict = restrict_to_workspace or self.config.restrict_to_workspace

    def _active_workspace(self) -> Path:
        """Return the active session workspace (contextvar) or configured fallback."""
        ws = get_current_workspace(self._workspace)
        return ws if ws is not None else self._workspace

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        type: str,
        data: list[Any],
        title: str = "",
        series_names: list[str] | None = None,
        width: int | None = None,
        height: int | None = None,
        output: str | None = None,
        **kwargs: Any,
    ) -> str:
        chart_type = (type or "").lower().strip()
        if chart_type not in _CHART_TYPES:
            return f"Error: unsupported chart type '{type}'. Supported: {', '.join(_CHART_TYPES)}"

        if not data or not isinstance(data, list):
            return "Error: data must be a non-empty list"

        try:
            labels, series = _normalize_data(data)
        except (ValueError, TypeError) as e:
            return f"Error: failed to parse data: {e}"

        if not labels:
            return "Error: no data points after parsing"

        w = width or self.config.default_width
        h = height or self.config.default_height
        w = max(200, min(2400, w))
        h = max(200, min(2400, h))

        try:
            if chart_type == "bar":
                svg = _render_bar(labels, series, w, h, title, series_names)
            elif chart_type == "line":
                svg = _render_line(labels, series, w, h, title, series_names, fill_area=False)
            elif chart_type == "area":
                svg = _render_line(labels, series, w, h, title, series_names, fill_area=True)
            elif chart_type == "pie":
                # Pie uses only the first series
                values = [row[0] for row in series]
                svg = _render_pie(labels, values, w, h, title)
            else:
                return f"Error: unsupported chart type '{chart_type}'"
        except Exception as e:
            logger.exception("Chart rendering failed")
            return f"Error rendering chart: {type(e).__name__}: {e}"

        # Resolve output path against the active session workspace so charts
        # land in ``workspace/output/`` for normal sessions instead of the
        # global media directory.
        active_ws = self._active_workspace()
        if output:
            if self._restrict:
                try:
                    out_path = resolve_workspace_path(output, active_ws, active_ws)
                except (OSError, PermissionError, ValueError) as e:
                    return f"Error: output path not allowed: {e}"
            else:
                p = Path(output).expanduser()
                out_path = p if p.is_absolute() else active_ws / p
            # Ensure .svg extension
            if out_path.suffix.lower() != ".svg":
                out_path = out_path.with_suffix(".svg")
        else:
            # Default: <active_ws>/generated/YYYY-MM-DD/<safe_title>.svg
            day = datetime.now().strftime("%Y-%m-%d")
            out_dir = ensure_dir(active_ws / "generated" / day)
            safe_title = re.sub(r"[^A-Za-z0-9_-]", "_", title or "chart")[:40] or "chart"
            out_path = out_dir / f"{safe_title}.svg"

        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(svg, encoding="utf-8")
        except OSError as e:
            return f"Error saving chart: {e}"

        try:
            display_path = out_path.relative_to(active_ws).as_posix()
        except ValueError:
            display_path = str(out_path)

        return f"Chart saved to: {display_path}\nAbsolute path: {out_path}\nType: {chart_type}, Points: {len(labels)}"
