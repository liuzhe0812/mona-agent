"""Focused tests for plot_renderer and page_visual_plan parsing."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# plot_renderer import – mona-ppt has a hyphen so it cannot be a Python package.
# Add the scripts directory to sys.path and import the module directly.
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent.parent / "mona" / "skills" / "mona-ppt" / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import plot_renderer as _pr  # type: ignore[import-untyped]

_to_float = _pr._to_float
_rows_from_json = _pr._rows_from_json
_headers = _pr._headers
_choose_y_columns = _pr._choose_y_columns
_choose_x_values = _pr._choose_x_values
_nice_range = _pr._nice_range
load_rows = _pr.load_rows
render_plot = _pr.render_plot


class TestToFloat:
    def test_int(self):
        assert _to_float(42) == 42.0

    def test_float(self):
        assert _to_float(3.14) == 3.14

    def test_string(self):
        assert _to_float("2.5") == 2.5

    def test_comma_separated(self):
        assert _to_float("1,000") == 1000.0

    def test_none(self):
        assert _to_float(None) is None

    def test_empty_string(self):
        assert _to_float("") is None

    def test_whitespace(self):
        assert _to_float("  ") is None

    def test_invalid(self):
        assert _to_float("abc") is None


class TestRowsFromJson:
    def test_array_of_objects(self):
        data = [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
        result = _rows_from_json(data)
        assert len(result) == 2
        assert result[0] == {"a": 1, "b": 2}

    def test_column_list_object(self):
        data = {"x": [1, 2, 3], "y": [4, 5, 6]}
        result = _rows_from_json(data)
        assert len(result) == 3
        assert result[0] == {"x": 1, "y": 4}

    def test_column_list_uneven(self):
        data = {"x": [1, 2], "y": [3]}
        result = _rows_from_json(data)
        assert len(result) == 2
        assert result[1] == {"x": 2, "y": None}

    def test_single_object(self):
        data = {"a": 1}
        result = _rows_from_json(data)
        assert result == [{"a": 1}]

    def test_data_key_wrapping(self):
        data = {"data": [{"a": 1}]}
        result = _rows_from_json(data)
        assert result == [{"a": 1}]

    def test_invalid_type(self):
        with pytest.raises(ValueError, match="JSON must be"):
            _rows_from_json("not valid")


class TestHeaders:
    def test_basic(self):
        rows = [{"a": 1, "b": 2}, {"b": 3, "c": 4}]
        assert _headers(rows) == ["a", "b", "c"]

    def test_empty(self):
        assert _headers([]) == []


class TestChooseYColumns:
    def test_explicit_columns(self):
        rows = [{"x": 1, "a": 2, "b": 3}]
        assert _choose_y_columns(rows, ["a", "b"]) == ["a", "b"]

    def test_missing_column(self):
        rows = [{"x": 1}]
        with pytest.raises(ValueError, match="Unknown y column"):
            _choose_y_columns(rows, ["z"])

    def test_auto_detect_numeric(self):
        rows = [{"name": "A", "val1": 1, "val2": 2}, {"name": "B", "val1": 3, "val2": 4}]
        result = _choose_y_columns(rows, [])
        assert "val1" in result
        assert "val2" in result

    def test_no_numeric(self):
        rows = [{"name": "A"}]
        with pytest.raises(ValueError, match="No numeric columns"):
            _choose_y_columns(rows, [])


class TestChooseXValues:
    def test_explicit_x(self):
        rows = [{"x": 1, "y": 2}, {"x": 3, "y": 4}]
        name, values = _choose_x_values(rows, "x", ["y"])
        assert name == "x"
        assert values == [1.0, 3.0]

    def test_auto_detect_numeric_x(self):
        rows = [{"x": 1, "y": 10}, {"x": 2, "y": 20}]
        name, values = _choose_x_values(rows, None, ["y"])
        assert name == "x"
        assert values == [1.0, 2.0]

    def test_no_numeric_non_y_falls_to_index(self):
        rows = [{"label": "A", "value": 10}, {"label": "B", "value": 20}]
        name, values = _choose_x_values(rows, None, ["value"])
        assert name == "index"
        assert values == [1, 2]

    def test_fallback_index(self):
        rows = [{"value": 10}, {"value": 20}]
        name, values = _choose_x_values(rows, None, ["value"])
        assert name == "index"
        assert values == [1, 2]


class TestNiceRange:
    def test_basic(self):
        lo, hi = _nice_range([0, 10])
        assert lo < 0
        assert hi > 10

    def test_same_value(self):
        lo, hi = _nice_range([5, 5])
        assert lo < 5
        assert hi > 5

    def test_negative(self):
        lo, hi = _nice_range([-10, -5])
        assert lo < -10
        assert hi > -5


class TestLoadRows:
    def test_csv(self, tmp_path: Path):
        csv_file = tmp_path / "data.csv"
        csv_file.write_text("name,value\nA,1\nB,2\n", encoding="utf-8")
        rows = load_rows(csv_file)
        assert len(rows) == 2
        assert rows[0]["name"] == "A"

    def test_json(self, tmp_path: Path):
        json_file = tmp_path / "data.json"
        json_file.write_text('[{"x":1,"y":2}]', encoding="utf-8")
        rows = load_rows(json_file)
        assert len(rows) == 1

    def test_unsupported(self, tmp_path: Path):
        bad = tmp_path / "data.txt"
        bad.write_text("hello", encoding="utf-8")
        with pytest.raises(ValueError, match="Unsupported input type"):
            load_rows(bad)


class TestRenderPlotSvgFallback:
    def test_line_svg(self, tmp_path: Path):
        csv_file = tmp_path / "data.csv"
        csv_file.write_text("x,y\n1,10\n2,20\n3,30\n", encoding="utf-8")
        out = tmp_path / "chart.svg"
        render_plot(
            csv_file, out, kind="line",
            x_column=None, y_columns=[],
            title="Test", x_label=None, y_label=None,
            width=4, height=3, dpi=100,
        )
        assert out.exists()
        content = out.read_text(encoding="utf-8")
        assert "<svg" in content
        assert "Test" in content

    def test_bar_svg(self, tmp_path: Path):
        csv_file = tmp_path / "data.csv"
        csv_file.write_text("x,y\n1,10\n2,20\n", encoding="utf-8")
        out = tmp_path / "chart.svg"
        render_plot(
            csv_file, out, kind="bar",
            x_column=None, y_columns=[],
            title=None, x_label=None, y_label=None,
            width=4, height=3, dpi=100,
        )
        assert out.exists()
        content = out.read_text(encoding="utf-8")
        assert "<rect" in content

    def test_scatter_svg(self, tmp_path: Path):
        csv_file = tmp_path / "data.csv"
        csv_file.write_text("x,y\n1,10\n2,20\n", encoding="utf-8")
        out = tmp_path / "chart.svg"
        render_plot(
            csv_file, out, kind="scatter",
            x_column=None, y_columns=[],
            title=None, x_label=None, y_label=None,
            width=4, height=3, dpi=100,
        )
        assert out.exists()
        content = out.read_text(encoding="utf-8")
        assert "<circle" in content

    def test_empty_data_raises(self, tmp_path: Path):
        csv_file = tmp_path / "empty.csv"
        csv_file.write_text("x,y\n", encoding="utf-8")
        out = tmp_path / "chart.svg"
        with pytest.raises(ValueError, match="empty"):
            render_plot(
                csv_file, out, kind="line",
                x_column=None, y_columns=[],
                title=None, x_label=None, y_label=None,
                width=4, height=3, dpi=100,
            )


# ---------------------------------------------------------------------------
# page_visual_plan parsing tests
# ---------------------------------------------------------------------------

class TestPageVisualPlanParsing:
    """Test that page_visual_plan.json can be correctly parsed and validated."""

    def _make_plan(self, pages: list[dict] | None = None) -> dict:
        if pages is None:
            pages = [
                {
                    "page": "P01",
                    "file": "01_cover.svg",
                    "title": "Cover",
                    "visual_type": "text_layout",
                    "chart_template": None,
                    "layout_template": "01_cover",
                    "has_ai_image": False,
                    "notes": "",
                },
                {
                    "page": "P02",
                    "file": "02_chart.svg",
                    "title": "Market Share",
                    "visual_type": "data_chart",
                    "chart_template": "bar_chart",
                    "layout_template": None,
                    "has_ai_image": False,
                    "notes": "Bar chart showing share",
                },
            ]
        return {"pages": pages}

    def test_parse_valid_plan(self, tmp_path: Path):
        plan = self._make_plan()
        plan_file = tmp_path / "page_visual_plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")

        data = json.loads(plan_file.read_text(encoding="utf-8"))
        assert "pages" in data
        assert len(data["pages"]) == 2
        assert data["pages"][1]["visual_type"] == "data_chart"

    def test_visual_type_values(self):
        valid_types = {
            "text_layout", "data_chart", "flowchart", "architecture",
            "timeline", "matrix", "comparison", "ai_image", "mixed",
        }
        plan = self._make_plan()
        for page in plan["pages"]:
            assert page["visual_type"] in valid_types

    def test_empty_plan(self, tmp_path: Path):
        plan_file = tmp_path / "page_visual_plan.json"
        plan_file.write_text('{"pages": []}', encoding="utf-8")

        data = json.loads(plan_file.read_text(encoding="utf-8"))
        assert data["pages"] == []

    def test_page_with_chart_template(self):
        plan = self._make_plan([
            {
                "page": "P03",
                "file": "03_revenue.svg",
                "title": "Revenue",
                "visual_type": "data_chart",
                "chart_template": "line_chart",
                "layout_template": None,
                "has_ai_image": False,
                "notes": "Revenue trend",
            },
        ])
        page = plan["pages"][0]
        assert page["chart_template"] == "line_chart"
        assert page["visual_type"] == "data_chart"

    def test_page_with_ai_image(self):
        plan = self._make_plan([
            {
                "page": "P04",
                "file": "04_hero.svg",
                "title": "Hero",
                "visual_type": "ai_image",
                "chart_template": None,
                "layout_template": None,
                "has_ai_image": True,
                "notes": "AI-generated hero image",
            },
        ])
        page = plan["pages"][0]
        assert page["has_ai_image"] is True
        assert page["visual_type"] == "ai_image"
