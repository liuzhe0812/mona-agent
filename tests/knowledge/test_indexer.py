from __future__ import annotations

from pathlib import Path

import pytest

from mona.knowledge.indexer import Indexer


@pytest.fixture
def indexer(tmp_path: Path) -> Indexer:
    db_path = tmp_path / "test.db"
    idx = Indexer(db_path)
    idx.initialize()
    yield idx
    idx.close()


def test_indexer_initialize(tmp_path: Path) -> None:
    db_path = tmp_path / "sub" / "dir" / "test.db"
    idx = Indexer(db_path)
    idx.initialize()
    assert db_path.exists()
    assert idx.get_doc_count() == 0
    idx.close()


def test_indexer_upsert_and_search(indexer: Indexer) -> None:
    indexer.upsert(
        path="doc1.md",
        title="Python 编程指南",
        content="这是一篇关于 Python 编程的入门教程",
        hash="abc123",
    )
    results = indexer.search("Python")
    assert len(results) == 1
    assert results[0]["path"] == "doc1.md"
    assert results[0]["title"] == "Python 编程指南"

    results_cn = indexer.search("编程")
    assert len(results_cn) == 1
    assert results_cn[0]["path"] == "doc1.md"


def test_indexer_upsert_update(indexer: Indexer) -> None:
    indexer.upsert(
        path="doc1.md",
        title="旧标题",
        content="旧内容",
        hash="hash1",
    )
    indexer.upsert(
        path="doc1.md",
        title="新标题",
        content="新内容关于机器学习",
        hash="hash2",
    )
    assert indexer.get_doc_count() == 1
    results = indexer.search("机器学习")
    assert len(results) == 1
    assert results[0]["title"] == "新标题"
    assert results[0]["hash"] == "hash2"


def test_indexer_delete(indexer: Indexer) -> None:
    indexer.upsert(
        path="doc1.md",
        title="待删除文档",
        content="这段内容即将被删除",
        hash="hash1",
    )
    assert indexer.get_doc_count() == 1
    indexer.delete("doc1.md")
    assert indexer.get_doc_count() == 0
    results = indexer.search("删除")
    assert len(results) == 0


def test_indexer_search_returns_path_and_score(indexer: Indexer) -> None:
    indexer.upsert(
        path="doc1.md",
        title="测试文档",
        content="包含关键词的内容",
        hash="hash1",
    )
    results = indexer.search("关键词")
    assert len(results) == 1
    result = results[0]
    assert "path" in result
    assert "title" in result
    assert "hash" in result
    assert "last_updated" in result
    assert "rank" in result
    assert result["path"] == "doc1.md"
    assert isinstance(result["rank"], (int, float))


def test_indexer_search_top_k(indexer: Indexer) -> None:
    for i in range(10):
        indexer.upsert(
            path=f"doc{i}.md",
            title=f"文档 {i}",
            content=f"这是第 {i} 篇关于 Python 的文章",
            hash=f"hash{i}",
        )
    results = indexer.search("Python", top_k=3)
    assert len(results) == 3
    paths = {r["path"] for r in results}
    assert len(paths) == 3
