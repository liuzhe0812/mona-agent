"""阶段 1 回归测试：稳定 material ID、元数据、状态机、reconciliation、原子写入。

每个测试对应计划文档阶段 1 的验收项。
"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.materials.api as materials_api
from mona.materials.catalog import get_library_root
from mona.materials.frontmatter import _parse_frontmatter
from mona.utils.document import EXTRACTOR_VERSION, ExtractedSegment


@pytest.fixture(autouse=True)
def _clear_tasks():
    materials_api._EXTRACT_TASKS.clear()
    yield
    materials_api._EXTRACT_TASKS.clear()


@pytest.fixture
def vault(tmp_path, monkeypatch):
    v = tmp_path / "vault"
    monkeypatch.setattr(materials_api, "get_vault_path", lambda: v)
    return v


@pytest.fixture
async def client(vault):
    app = web.Application()
    app.router.add_post("/api/materials/move", materials_api.handle_materials_move)
    app.router.add_post("/api/materials/extract", materials_api.handle_materials_extract)
    app.router.add_post("/api/materials/reconcile", materials_api.handle_materials_reconcile)
    async with TestClient(TestServer(app)) as c:
        yield c


def _materials(vault):
    return get_library_root(vault)


def _read_text_frontmatter(root: Path, raw_rel: str) -> dict:
    content = (root / "text" / f"{raw_rel}.md").read_text(encoding="utf-8")
    fm, _ = _parse_frontmatter(content)
    return fm


async def _extract(vault, root, rel: str) -> None:
    await materials_api._extract_one(vault, root, rel)


# ---------------------------------------------------------------------------
# 稳定 material ID 与元数据
# ---------------------------------------------------------------------------


async def test_extract_writes_stable_id_and_metadata(vault):
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("hello world", encoding="utf-8")

    await _extract(vault, root, "a.txt")

    fm = _read_text_frontmatter(root, "a.txt")
    assert fm["id"].startswith("material-")
    assert fm["source"] == "a.txt"
    assert fm["status"] == "ok"
    assert len(fm["sha256"]) == 64
    assert int(fm["size"]) == 11
    assert int(fm["mtimeNs"]) > 0
    assert int(fm["extractorVersion"]) == EXTRACTOR_VERSION
    assert fm["extractionFidelity"] == "full_text"


async def test_reextract_preserves_id_updates_hash(vault):
    root = _materials(vault)
    raw = root / "raw" / "a.txt"
    raw.write_text("v1 content", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    first = _read_text_frontmatter(root, "a.txt")

    raw.write_text("v2 content changed", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    second = _read_text_frontmatter(root, "a.txt")

    assert second["id"] == first["id"]
    assert second["sha256"] != first["sha256"]


async def test_same_name_different_dirs_have_different_ids(vault):
    root = _materials(vault)
    (root / "raw" / "x").mkdir(parents=True)
    (root / "raw" / "y").mkdir(parents=True)
    (root / "raw" / "x" / "report.txt").write_text("from x", encoding="utf-8")
    (root / "raw" / "y" / "report.txt").write_text("from y", encoding="utf-8")

    await _extract(vault, root, "x/report.txt")
    await _extract(vault, root, "y/report.txt")

    fm_x = _read_text_frontmatter(root, "x/report.txt")
    fm_y = _read_text_frontmatter(root, "y/report.txt")
    assert fm_x["id"] != fm_y["id"]


async def test_move_updates_text_source_but_keeps_id(client, vault):
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("move me", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    before = _read_text_frontmatter(root, "a.txt")

    resp = await client.post(
        "/api/materials/move",
        json={"source": "a.txt", "targetDir": "docs"},
    )
    assert resp.status == 200

    after = _read_text_frontmatter(root, "docs/a.txt")
    assert after["id"] == before["id"]
    assert after["source"] == "docs/a.txt"
    assert after["sha256"] == before["sha256"]


# ---------------------------------------------------------------------------
# 结构化 segment 写入与长文保留
# ---------------------------------------------------------------------------


async def test_text_file_contains_segment_markers(vault):
    root = _materials(vault)
    md = "# 章节一\n\nalpha\n\n# 章节二\n\nbeta\n"
    (root / "raw" / "doc.md").write_text(md, encoding="utf-8")

    await _extract(vault, root, "doc.md")

    content = (root / "text" / "doc.md.md").read_text(encoding="utf-8")
    assert "<!-- seg " in content
    assert '"heading": "章节一"' in content
    assert '"heading": "章节二"' in content


async def test_long_text_tail_preserved(vault):
    root = _materials(vault)
    tail = "unique-tail-marker"
    (root / "raw" / "big.txt").write_text(
        "x" * 250_000 + "\n" + tail, encoding="utf-8"
    )

    await _extract(vault, root, "big.txt")

    content = (root / "text" / "big.txt.md").read_text(encoding="utf-8")
    assert tail in content
    fm = _read_text_frontmatter(root, "big.txt")
    assert fm["status"] == "ok"


# ---------------------------------------------------------------------------
# 状态机
# ---------------------------------------------------------------------------


def test_status_queued_when_text_missing(vault):
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("a", encoding="utf-8")
    status = materials_api._read_text_status(
        root / "text" / "a.txt.md", vault=vault, raw_rel="a.txt",
        raw_path=root / "raw" / "a.txt",
    )
    assert status["status"] == "queued"


def test_status_running_from_task_table(vault):
    root = _materials(vault)
    raw_path = root / "raw" / "a.txt"
    raw_path.write_text("a", encoding="utf-8")
    task = MagicMock()
    task.done.return_value = False
    materials_api._EXTRACT_TASKS[vault] = {
        "a.txt": {"state": "running", "task": task},
    }
    status = materials_api._read_text_status(
        root / "text" / "a.txt.md", vault=vault, raw_rel="a.txt", raw_path=raw_path,
    )
    assert status["status"] == "running"


async def test_status_stale_after_raw_modified(vault):
    root = _materials(vault)
    raw = root / "raw" / "a.txt"
    raw.write_text("v1", encoding="utf-8")
    await _extract(vault, root, "a.txt")

    raw.write_text("v2 modified and longer", encoding="utf-8")

    status = materials_api._read_text_status(
        root / "text" / "a.txt.md", vault=vault, raw_rel="a.txt", raw_path=raw,
    )
    assert status["status"] == "stale"


async def test_image_visual_text_is_saved(vault, monkeypatch):
    root = _materials(vault)
    raw_bytes = b"\x89PNG\r\n\x1a\n fake"
    raw_path = root / "raw" / "photo.png"
    raw_path.write_bytes(raw_bytes)
    visual_kwargs = {}

    async def _visual(_path, **kwargs):
        visual_kwargs.update(kwargs)
        return [
            ExtractedSegment(
                kind="visual",
                label="图片",
                text="图片中的文字",
                meta={"image": "photo.png", "visual": True},
            )
        ]

    monkeypatch.setattr("mona.materials.vision.extract_visual_segments", _visual)

    await _extract(vault, root, "photo.png")

    fm = _read_text_frontmatter(root, "photo.png")
    assert fm["status"] == "ok"
    assert fm["extractionFidelity"] == "text_and_visual"
    assert "图片中的文字" in (root / "text" / "photo.png.md").read_text(encoding="utf-8")
    source_hash = hashlib.sha256(raw_bytes).hexdigest()
    assert visual_kwargs["cache_dir"] == root / "evidence" / "extraction" / source_hash / "visual"
    draft = root / "evidence" / "extraction" / source_hash / "text.md"
    draft_fm, _ = _parse_frontmatter(draft.read_text(encoding="utf-8"))
    assert draft_fm["status"] == "partial"


async def test_scanned_pdf_visual_failure_is_error(vault, monkeypatch):
    fitz = pytest.importorskip("fitz")
    root = _materials(vault)
    doc = fitz.open()
    doc.new_page()
    raw_path = root / "raw" / "scan.pdf"
    doc.save(str(raw_path))
    doc.close()

    async def _failed_visual(_path, **kwargs):
        raise RuntimeError("图片识别失败")

    monkeypatch.setattr("mona.materials.vision.extract_visual_segments", _failed_visual)

    await _extract(vault, root, "scan.pdf")

    fm = _read_text_frontmatter(root, "scan.pdf")
    assert fm["status"] == "error"
    assert "图片识别失败" in fm["error"]
    source_hash = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    draft = root / "evidence" / "extraction" / source_hash / "text.md"
    draft_fm, _ = _parse_frontmatter(draft.read_text(encoding="utf-8"))
    assert draft_fm["status"] == "partial"


# ---------------------------------------------------------------------------
# 原子写入
# ---------------------------------------------------------------------------


async def test_extract_leaves_no_tmp_files(vault):
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("atomic", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    leftovers = list((root / "text").rglob("*.tmp"))
    assert leftovers == []


async def test_failed_write_does_not_corrupt_existing(vault, monkeypatch):
    """写入中途失败时，旧 text 文件保持完整（原子替换）。"""
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("v1", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    good = (root / "text" / "a.txt.md").read_text(encoding="utf-8")

    (root / "raw" / "a.txt").write_text("v2", encoding="utf-8")

    def _boom(path, content, *, encoding="utf-8"):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_text", _boom)
    await _extract(vault, root, "a.txt")
    monkeypatch.undo()

    assert (root / "text" / "a.txt.md").read_text(encoding="utf-8") == good


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------


async def _drain_tasks(vault):
    tasks = materials_api._EXTRACT_TASKS.get(vault, {})
    pending = [entry["task"] for entry in tasks.values()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


async def test_reconcile_requeues_missing_text(client, vault):
    root = _materials(vault)
    (root / "raw" / "new.txt").write_text("fresh", encoding="utf-8")

    resp = await client.post("/api/materials/reconcile")
    assert resp.status == 200
    report = await resp.json()
    assert "new.txt" in report["requeued"]

    await _drain_tasks(vault)
    assert (root / "text" / "new.txt.md").exists()


async def test_reconcile_requeues_stale_text(client, vault):
    root = _materials(vault)
    raw = root / "raw" / "a.txt"
    raw.write_text("v1", encoding="utf-8")
    await _extract(vault, root, "a.txt")

    raw.write_text("v2 changed", encoding="utf-8")

    resp = await client.post("/api/materials/reconcile")
    report = await resp.json()
    assert "a.txt" in report["requeued"]

    await _drain_tasks(vault)
    fm = _read_text_frontmatter(root, "a.txt")
    assert fm["status"] == "ok"
    # 重新提取后内容是新版本
    content = (root / "text" / "a.txt.md").read_text(encoding="utf-8")
    assert "v2 changed" in content


async def test_reconcile_removes_orphan_text(client, vault):
    root = _materials(vault)
    (root / "raw" / "gone.txt").write_text("x", encoding="utf-8")
    await _extract(vault, root, "gone.txt")
    (root / "raw" / "gone.txt").unlink()

    resp = await client.post("/api/materials/reconcile")
    report = await resp.json()
    assert "gone.txt" in report["removedOrphans"]
    assert not (root / "text" / "gone.txt.md").exists()


async def test_reconcile_marks_wiki_stale(client, vault):
    root = _materials(vault)
    (root / "raw" / "a.txt").write_text("evidence", encoding="utf-8")
    await _extract(vault, root, "a.txt")
    wiki = root / "wiki" / "entity" / "foo.md"
    wiki.parent.mkdir(parents=True)
    wiki.write_text(
        "---\nid: wiki-1\ntitle: Foo\nsources:\n  - raw/a.txt\n---\n\nbody\n",
        encoding="utf-8",
    )

    # 删除 raw → wiki 引用失效
    (root / "raw" / "a.txt").unlink()

    resp = await client.post("/api/materials/reconcile")
    report = await resp.json()
    assert "entity/foo.md" in report["staleWiki"]

    content = wiki.read_text(encoding="utf-8")
    fm, _ = _parse_frontmatter(content)
    assert fm.get("stale") is True


async def test_reconcile_recovers_after_restart(client, vault):
    """进程重启（任务表清空）后，reconcile 能恢复未完成的提取。"""
    root = _materials(vault)
    (root / "raw" / "pending.txt").write_text("recover me", encoding="utf-8")
    # 模拟重启：任务表为空、text 未生成
    materials_api._EXTRACT_TASKS.clear()

    resp = await client.post("/api/materials/reconcile")
    assert resp.status == 200
    await _drain_tasks(vault)
    assert (root / "text" / "pending.txt.md").exists()


async def test_reconcile_skips_fresh_files(client, vault):
    root = _materials(vault)
    (root / "raw" / "ok.txt").write_text("fresh", encoding="utf-8")
    await _extract(vault, root, "ok.txt")

    resp = await client.post("/api/materials/reconcile")
    report = await resp.json()
    assert report["requeued"] == []
    assert report["removedOrphans"] == []
