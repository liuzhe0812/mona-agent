"""Tests for the document parsing tool."""

from __future__ import annotations

import json

import pytest

from mona.agent.tools.document import DocumentTool, DocumentToolConfig


@pytest.fixture
def tool(tmp_path):
    return DocumentTool(workspace=tmp_path, config=DocumentToolConfig())


@pytest.mark.asyncio
async def test_parse_text_file(tool, tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("hello world\nsecond line", encoding="utf-8")
    result = await tool.execute(path=str(f))
    assert "hello world" in result
    assert "second line" in result
    assert "Parsed from: note.txt" in result


@pytest.mark.asyncio
async def test_parse_python_file_wraps_in_code_block(tool, tmp_path):
    f = tmp_path / "script.py"
    f.write_text("print('hi')\n", encoding="utf-8")
    result = await tool.execute(path=str(f))
    assert "```py" in result
    assert "print('hi')" in result


@pytest.mark.asyncio
async def test_parse_json_file(tool, tmp_path):
    f = tmp_path / "data.json"
    f.write_text(json.dumps({"a": 1, "b": [2, 3]}), encoding="utf-8")
    result = await tool.execute(path=str(f))
    assert "```json" in result
    assert '"a": 1' in result


@pytest.mark.asyncio
async def test_parse_csv_file(tool, tmp_path):
    f = tmp_path / "data.csv"
    f.write_text("name,age\nAlice,30\nBob,25\n", encoding="utf-8")
    result = await tool.execute(path=str(f))
    assert "| name | age |" in result
    assert "| Alice | 30 |" in result
    assert "| Bob | 25 |" in result


@pytest.mark.asyncio
async def test_parse_html_file(tool, tmp_path):
    f = tmp_path / "page.html"
    f.write_text(
        "<html><head><title>My Page</title></head>"
        "<body><h1>Hello</h1><p>World</p></body></html>",
        encoding="utf-8",
    )
    result = await tool.execute(path=str(f))
    assert "My Page" in result  # title
    assert "# Hello" in result or "Hello" in result
    assert "World" in result


@pytest.mark.asyncio
async def test_parse_nonexistent_file(tool, tmp_path):
    result = await tool.execute(path=str(tmp_path / "missing.txt"))
    assert "Error" in result
    assert "not found" in result


@pytest.mark.asyncio
async def test_parse_unsupported_extension(tool, tmp_path):
    f = tmp_path / "file.xyz"
    f.write_text("data", encoding="utf-8")
    result = await tool.execute(path=str(f))
    assert "Error" in result
    assert "unsupported" in result.lower()


@pytest.mark.asyncio
async def test_parse_truncates_long_output(tool, tmp_path):
    f = tmp_path / "big.txt"
    f.write_text("x" * 10000, encoding="utf-8")
    result = await tool.execute(path=str(f), max_chars=1000)
    assert "truncated" in result
    assert len(result) < 2000  # truncated + overhead


@pytest.mark.asyncio
async def test_parse_xlsx_file(tool, tmp_path):
    try:
        from openpyxl import Workbook
    except ImportError:
        pytest.skip("openpyxl not installed")
    wb = Workbook()
    ws = wb.active
    ws.append(["name", "value"])
    ws.append(["alpha", 10])
    ws.append(["beta", 20])
    f = tmp_path / "data.xlsx"
    wb.save(str(f))
    result = await tool.execute(path=str(f))
    assert "Sheet" in result
    assert "name" in result and "value" in result
    assert "alpha" in result and "10" in result


@pytest.mark.asyncio
async def test_parse_docx_file(tool, tmp_path):
    try:
        from docx import Document
    except ImportError:
        pytest.skip("python-docx not installed")
    doc = Document()
    doc.add_heading("Title", level=1)
    doc.add_paragraph("Hello paragraph")
    f = tmp_path / "doc.docx"
    doc.save(str(f))
    result = await tool.execute(path=str(f))
    assert "Title" in result
    assert "Hello paragraph" in result


@pytest.mark.asyncio
async def test_parse_pptx_file(tool, tmp_path):
    try:
        from pptx import Presentation
    except ImportError:
        pytest.skip("python-pptx not installed")
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[5])  # blank
    txbox = slide.shapes.add_textbox(0, 0, 200, 50)
    tf = txbox.text_frame
    tf.text = "Slide content here"
    f = tmp_path / "deck.pptx"
    prs.save(str(f))
    result = await tool.execute(path=str(f))
    assert "Slide 1" in result
    assert "Slide content here" in result


@pytest.mark.asyncio
async def test_restrict_to_workspace_blocks_outside(tmp_path):
    tool = DocumentTool(
        workspace=tmp_path,
        config=DocumentToolConfig(),
        restrict_to_workspace=True,
    )
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    try:
        result = await tool.execute(path=str(outside))
        assert "Error" in result
        assert "not allowed" in result
    finally:
        outside.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_relative_path_resolves_against_workspace(tool, tmp_path):
    f = tmp_path / "rel.txt"
    f.write_text("relative content", encoding="utf-8")
    result = await tool.execute(path="rel.txt")
    assert "relative content" in result
