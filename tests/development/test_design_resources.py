from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from mona.development import design_resources
from mona.development.design_resources import (
    DesignResourceCall,
    DesignResourceTool,
    read_design_resource,
)


def _write_image(path: Path, image_format: str) -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2), (12, 34, 56)).save(output, format=image_format)
    data = output.getvalue()
    path.write_bytes(data)
    return data


def test_directory_entries_are_sorted_and_paginated(tmp_path):
    root = tmp_path / "package"
    root.mkdir()
    (root / "c.txt").write_text("c", encoding="utf-8")
    (root / "a-dir").mkdir()
    (root / "b.txt").write_text("b", encoding="utf-8")
    (root / ".private").write_text("hidden", encoding="utf-8")

    first = json.loads(read_design_resource("", root=root, limit=2))
    second = json.loads(read_design_resource("", root=root, offset=2, limit=2))

    assert first == {
        "path": ".",
        "entries": [
            {"path": "a-dir", "type": "directory"},
            {"path": "b.txt", "type": "file"},
        ],
        "nextOffset": 2,
    }
    assert second == {
        "path": ".",
        "entries": [{"path": "c.txt", "type": "file"}],
        "nextOffset": None,
    }


def test_text_is_paginated_and_html_source_is_returned_unchanged(tmp_path):
    root = tmp_path / "package"
    root.mkdir()
    (root / "notes.txt").write_text("0123456789", encoding="utf-8")
    html = '<!doctype html>\n<html><body><b>sample</b></body></html>'
    (root / "example.html").write_bytes(html.encode("utf-8"))

    page = json.loads(read_design_resource("notes.txt", root=root, offset=3, limit=4))
    source = json.loads(read_design_resource("example.html", root=root))

    assert page == {"path": "notes.txt", "offset": 3, "content": "3456", "nextOffset": 7}
    assert source["content"] == html


@pytest.mark.parametrize(
    ("image_format", "mime"),
    [("JPEG", "image/jpeg"), ("PNG", "image/png")],
)
def test_images_are_returned_as_image_blocks(tmp_path, image_format, mime):
    root = tmp_path / "package"
    root.mkdir()
    raw = _write_image(root / f"sample.{image_format.lower()}", image_format)

    result = read_design_resource(f"sample.{image_format.lower()}", root=root)

    assert isinstance(result, list)
    image_block = result[0]
    assert image_block["type"] == "image_url"
    header, encoded = image_block["image_url"]["url"].split(",", 1)
    assert header == f"data:{mime};base64"
    assert base64.b64decode(encoded) == raw
    assert result[1]["type"] == "text"


@pytest.mark.parametrize(
    "path",
    ["../outside.txt", ".private.txt", "nested/.private.txt", r"C:\outside\secret.txt"],
)
def test_rejects_paths_outside_allowed_relative_names(tmp_path, path):
    root = tmp_path / "package"
    root.mkdir()

    with pytest.raises(ValueError):
        read_design_resource(path, root=root)


def test_rejects_absolute_path(tmp_path):
    root = tmp_path / "package"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")

    with pytest.raises(ValueError):
        read_design_resource(str(outside.resolve()), root=root)


def test_rejects_symlink_resolving_outside_package(tmp_path):
    root = tmp_path / "package"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    link = root / "linked.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")

    with pytest.raises(ValueError):
        read_design_resource("linked.txt", root=root)


@pytest.mark.parametrize(
    ("data", "filename"),
    [(b"x" * 2_000_001, "large.bin"), (b"text\0binary", "binary.bin")],
    ids=["oversized", "binary"],
)
def test_rejects_oversized_or_binary_resources(tmp_path, data, filename):
    root = tmp_path / "package"
    root.mkdir()
    (root / filename).write_bytes(data)

    with pytest.raises(ValueError):
        read_design_resource(filename, root=root)


@pytest.mark.asyncio
async def test_tool_is_read_only_reads_package_and_hides_root_parameter(tmp_path, monkeypatch):
    root = tmp_path / "package"
    root.mkdir()
    (root / "SKILL.md").write_text("Design entry", encoding="utf-8")
    monkeypatch.setattr(design_resources, "DESIGN_PACKAGE", root)

    tool = DesignResourceTool()
    result = await tool.execute(path="SKILL.md")

    assert tool.read_only
    assert "root" not in DesignResourceCall.model_fields
    assert "root" not in DesignResourceTool.parameters["properties"]
    assert json.loads(result)["content"] == "Design entry"
