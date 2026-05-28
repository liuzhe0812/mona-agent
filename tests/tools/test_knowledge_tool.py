"""Tests for knowledge base tools."""

from __future__ import annotations

from pathlib import Path

import pytest

from mona.agent.tools.knowledge import (
    KbCompileTool,
    KbIngestTool,
    KbQueryTool,
    KbStatusTool,
)


def test_kb_ingest_tool_name() -> None:
    assert KbIngestTool().name == "kb_ingest"


def test_kb_query_tool_name() -> None:
    assert KbQueryTool().name == "kb_query"


def test_kb_status_tool_name() -> None:
    assert KbStatusTool().name == "kb_status"


def test_kb_compile_tool_name() -> None:
    assert KbCompileTool().name == "kb_compile"


@pytest.mark.asyncio
async def test_kb_ingest_creates_index(tmp_path: Path) -> None:
    (tmp_path / "test.md").write_text("# Hello World\nSome content here", encoding="utf-8")

    tool = KbIngestTool(workspace=tmp_path)
    result = await tool.execute(paths=["test.md"])

    assert "test.md" in result
    assert "已入库" in result


@pytest.mark.asyncio
async def test_kb_query_returns_results(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("# Python Tips\nDecorators are useful", encoding="utf-8")

    ingest = KbIngestTool(workspace=tmp_path)
    await ingest.execute(paths=["notes.md"])

    query = KbQueryTool(workspace=tmp_path)
    result = await query.execute(query="Python")

    assert "notes.md" in result


@pytest.mark.asyncio
async def test_kb_status_returns_info(tmp_path: Path) -> None:
    tool = KbStatusTool(workspace=tmp_path)
    result = await tool.execute()

    assert "模式" in result
    assert "文档数" in result
