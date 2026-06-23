"""Tests for the chart rendering tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from mona.agent.tools.chart import ChartTool, ChartToolConfig


@pytest.fixture
def tool(tmp_path):
    return ChartTool(workspace=tmp_path, config=ChartToolConfig())


@pytest.mark.asyncio
async def test_bar_chart_basic(tool, tmp_path):
    out = tmp_path / "bar.svg"
    result = await tool.execute(
        type="bar",
        data=[
            {"label": "A", "value": 10},
            {"label": "B", "value": 20},
            {"label": "C", "value": 15},
        ],
        title="My Bar Chart",
        output=str(out),
    )
    assert "Chart saved" in result
    assert out.exists()
    svg = out.read_text(encoding="utf-8")
    assert "<svg" in svg
    assert "</svg>" in svg
    assert "My Bar Chart" in svg
    # Bars should reference each label in a <title> tag
    assert "A: 10" in svg
    assert "B: 20" in svg
    assert "C: 15" in svg


@pytest.mark.asyncio
async def test_line_chart(tool, tmp_path):
    out = tmp_path / "line.svg"
    result = await tool.execute(
        type="line",
        data=[
            ["Jan", 5],
            ["Feb", 10],
            ["Mar", 8],
        ],
        output=str(out),
    )
    assert "Chart saved" in result
    svg = out.read_text(encoding="utf-8")
    assert "<path" in svg  # line path
    assert "Jan" in svg


@pytest.mark.asyncio
async def test_pie_chart(tool, tmp_path):
    out = tmp_path / "pie.svg"
    result = await tool.execute(
        type="pie",
        data=[
            {"label": "Alpha", "value": 30},
            {"label": "Beta", "value": 70},
        ],
        output=str(out),
    )
    assert "Chart saved" in result
    svg = out.read_text(encoding="utf-8")
    assert "<path" in svg  # pie slices
    assert "Alpha" in svg
    assert "Beta" in svg
    # 30% should be rendered as a percentage label
    assert "30%" in svg or "70%" in svg


@pytest.mark.asyncio
async def test_area_chart(tool, tmp_path):
    out = tmp_path / "area.svg"
    result = await tool.execute(
        type="area",
        data=[["Q1", 100], ["Q2", 200], ["Q3", 150]],
        output=str(out),
    )
    assert "Chart saved" in result
    svg = out.read_text(encoding="utf-8")
    # Area chart has a filled path
    assert "fill-opacity" in svg


@pytest.mark.asyncio
async def test_multi_series_bar(tool, tmp_path):
    out = tmp_path / "multi.svg"
    result = await tool.execute(
        type="bar",
        data=[
            {"label": "A", "values": [10, 20]},
            {"label": "B", "values": [15, 25]},
        ],
        series_names=["2023", "2024"],
        output=str(out),
    )
    assert "Chart saved" in result
    svg = out.read_text(encoding="utf-8")
    assert "2023" in svg and "2024" in svg  # legend


@pytest.mark.asyncio
async def test_unsupported_type(tool):
    result = await tool.execute(
        type="radar",
        data=[{"label": "A", "value": 1}],
    )
    assert "Error" in result
    assert "unsupported" in result.lower()


@pytest.mark.asyncio
async def test_empty_data(tool):
    result = await tool.execute(type="bar", data=[])
    assert "Error" in result


@pytest.mark.asyncio
async def test_default_output_to_media_dir(tool):
    result = await tool.execute(
        type="bar",
        data=[{"label": "X", "value": 1}],
        title="Test Chart",
    )
    assert "Chart saved" in result
    assert "Absolute path:" in result
    # The file should exist somewhere
    abs_path = result.split("Absolute path: ")[1].split("\n")[0]
    assert Path(abs_path).exists()


@pytest.mark.asyncio
async def test_auto_adds_svg_extension(tool, tmp_path):
    out = tmp_path / "noext"
    result = await tool.execute(
        type="bar",
        data=[{"label": "X", "value": 1}],
        output=str(out),
    )
    assert "Chart saved" in result
    assert (tmp_path / "noext.svg").exists()


@pytest.mark.asyncio
async def test_negative_values_bar(tool, tmp_path):
    out = tmp_path / "neg.svg"
    result = await tool.execute(
        type="bar",
        data=[
            {"label": "gain", "value": 50},
            {"label": "loss", "value": -30},
        ],
        output=str(out),
    )
    assert "Chart saved" in result
    svg = out.read_text(encoding="utf-8")
    assert "gain: 50" in svg
    assert "loss: -30" in svg


@pytest.mark.asyncio
async def test_restrict_to_workspace_blocks_outside(tmp_path):
    tool = ChartTool(
        workspace=tmp_path,
        config=ChartToolConfig(),
        restrict_to_workspace=True,
    )
    outside = tmp_path.parent / "outside.svg"
    result = await tool.execute(
        type="bar",
        data=[{"label": "X", "value": 1}],
        output=str(outside),
    )
    assert "Error" in result
    assert "not allowed" in result
