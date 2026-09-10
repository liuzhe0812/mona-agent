"""阶段 3 测试：Wiki 后端编译（候选化/合并/事务写入/取消/stale）。

每个测试对应计划文档阶段 3 的验收项。
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.materials.api as materials_api
import mona.materials.compile as wiki_compile
from mona.materials.catalog import get_library_root
from mona.materials.compile import (
    is_safe_wiki_path,
    merge_page_content,
    parse_file_blocks,
)
from mona.materials.frontmatter import _parse_frontmatter


@pytest.fixture(autouse=True)
def _clear_tasks(monkeypatch):
    materials_api._EXTRACT_TASKS.clear()
    wiki_compile._COMPILE_TASKS.clear()
    monkeypatch.setattr(wiki_compile, "ENABLE_EVIDENCE_VERIFICATION", False)
    yield
    materials_api._EXTRACT_TASKS.clear()
    wiki_compile._COMPILE_TASKS.clear()


@pytest.fixture
def vault(tmp_path, monkeypatch):
    v = tmp_path / "vault"
    monkeypatch.setattr(materials_api, "get_vault_path", lambda: v)
    return v


@pytest.fixture
async def client(vault):
    app = web.Application()
    app.router.add_post(
        "/api/materials/wiki/compile",
        wiki_compile.handle_materials_wiki_compile_start,
    )
    app.router.add_get(
        "/api/materials/wiki/compile/{task_id}",
        wiki_compile.handle_materials_wiki_compile_status,
    )
    app.router.add_post(
        "/api/materials/wiki/compile/{task_id}/cancel",
        wiki_compile.handle_materials_wiki_compile_cancel,
    )
    async with TestClient(TestServer(app)) as c:
        yield c


def _materials(vault: Path) -> Path:
    return get_library_root(vault)


def _write_raw(root: Path, rel: str, content: str = "dummy") -> None:
    p = root / "raw" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _write_text_ready(root: Path, raw_rel: str, body: str, *, material_id: str, sha: str) -> None:
    """写入一份 status: ok 的 text/ 提取产物。"""
    p = root / "text" / f"{raw_rel}.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "---\n"
        f"id: {material_id}\n"
        f"source: {raw_rel}\n"
        f"sha256: {sha}\n"
        "status: ok\n"
        "---\n\n"
        f"{body}\n",
        encoding="utf-8",
    )


def _mock_provider_snapshot(monkeypatch, *, generation: str = ""):
    """Mock load_provider_snapshot，返回假的 provider/model（单次调用：每文件一次 chat）。"""
    provider = MagicMock()

    async def _chat(**kwargs):
        resp = MagicMock()
        resp.finish_reason = "stop"
        resp.content = generation
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )
    return provider


GENERATION_TWO_PAGES = """---FILE: wiki/sources/report.md---
---
type: source
title: "Source: report.pdf"
created: 2026-08-04
updated: 2026-08-04
tags: [demo]
sources: ["report.pdf"]
---

# Source: report.pdf

报告摘要。
---END FILE---

---FILE: wiki/entities/acme.md---
---
type: entity
title: Acme
created: 2026-08-04
updated: 2026-08-04
tags: [org]
sources: ["report.pdf"]
---

# Acme

一家示例公司。
---END FILE---
"""


# ---------------------------------------------------------------------------
# FILE block 解析
# ---------------------------------------------------------------------------


def test_parse_file_blocks_basic():
    blocks, warnings = parse_file_blocks(GENERATION_TWO_PAGES)
    assert warnings == []
    assert [b["path"] for b in blocks] == [
        "wiki/sources/report.md",
        "wiki/entities/acme.md",
    ]
    assert "报告摘要" in blocks[0]["content"]


def test_parse_file_blocks_unclosed_dropped():
    text = "---FILE: wiki/a.md---\ncontent without closer\n"
    blocks, warnings = parse_file_blocks(text)
    assert blocks == []
    assert len(warnings) == 1


def test_parse_file_blocks_fence_aware():
    text = (
        "---FILE: wiki/a.md---\n"
        "```\n"
        "---END FILE---\n"  # 在代码块内，不算闭合
        "```\n"
        "---END FILE---\n"
    )
    blocks, warnings = parse_file_blocks(text)
    assert warnings == []
    assert len(blocks) == 1
    assert "---END FILE---" in blocks[0]["content"]


def test_is_safe_wiki_path():
    assert is_safe_wiki_path("wiki/entities/foo.md")
    assert not is_safe_wiki_path("../escape.md")
    assert not is_safe_wiki_path("wiki/../escape.md")
    assert not is_safe_wiki_path("/abs/path.md")
    assert not is_safe_wiki_path("C:/win/path.md")
    assert not is_safe_wiki_path("notes/foo.md")  # 必须 wiki/ 前缀
    assert not is_safe_wiki_path("wiki/CON.md")


# ---------------------------------------------------------------------------
# 页面合并
# ---------------------------------------------------------------------------


def test_merge_preserves_existing_id_created_and_manual_fields():
    existing = (
        "---\n"
        "id: wiki-EXISTING\n"
        "type: entity\n"
        "title: Acme\n"
        "created: 2026-01-01\n"
        "updated: 2026-01-02\n"
        "myNote: 人工备注\n"
        "sources:\n"
        "  - old.pdf\n"
        "stale: true\n"
        "---\n\n# 旧正文\n"
    )
    candidate = (
        "---\n"
        "type: entity\n"
        "title: Acme\n"
        "created: 2026-08-04\n"
        "updated: 2026-08-04\n"
        'sources: ["report.pdf"]\n'
        "---\n\n# 新正文\n"
    )
    merged = merge_page_content(
        existing,
        candidate,
        new_sources=["report.pdf"],
        new_material_ids=["material-1"],
        new_source_hashes=["hash-1"],
        model="test-model",
    )
    fm, body = _parse_frontmatter(merged)
    assert fm["id"] == "wiki-EXISTING"
    assert str(fm["created"]) == "2026-01-01"  # PyYAML 把日期标量解析为 date 对象
    assert fm["myNote"] == "人工备注"
    assert "stale" not in fm
    assert "旧正文" not in body and "新正文" in body
    # sources 并集：已有 old.pdf 未被否定 + 新增 report.pdf
    assert "old.pdf" in fm["sources"]
    assert "report.pdf" in fm["sources"]
    assert fm["materialIds"] == ["material-1"]
    assert fm["sourceHashes"] == ["hash-1"]
    assert fm["generatedBy"] == "test-model"


def test_merge_new_page_gets_fresh_id():
    merged = merge_page_content(
        None,
        "---\ntype: entity\ntitle: Foo\n---\n\n# Foo\n",
        new_sources=["a.pdf"],
        new_material_ids=[],
        new_source_hashes=[],
        model="m",
    )
    fm, _ = _parse_frontmatter(merged)
    assert str(fm["id"]).startswith("wiki-")


def test_merge_preserves_claims_from_other_sources():
    source_a = wiki_compile._annotate_candidate_content(
        "---\ntype: entity\ntitle: Shared\n---\n\n- Old A [[evidence:ev-a1]]\n",
        raw_rel="a.txt",
        evidence_refs=["ev-a1"],
    )
    source_b = wiki_compile._annotate_candidate_content(
        "---\ntype: entity\ntitle: Shared\n---\n\n"
        "- Fact B first line\n  continuation B [[evidence:ev-b1]]\n",
        raw_rel="b.txt",
        evidence_refs=["ev-b1"],
    )
    existing_body = wiki_compile._merge_candidate_content(source_a, source_b)
    existing = merge_page_content(
        None,
        existing_body,
        new_sources=["a.txt", "b.txt"],
        new_material_ids=["material-a", "material-b"],
        new_source_hashes=["hash-a", "hash-b"],
        new_evidence_refs=["ev-a1", "ev-b1"],
        model="test-model",
    )
    candidate = wiki_compile._annotate_candidate_content(
        "---\ntype: entity\ntitle: Shared\n---\n\n- New A [[evidence:ev-a2]]\n",
        raw_rel="a.txt",
        evidence_refs=["ev-a2"],
    )

    merged = merge_page_content(
        existing,
        candidate,
        new_sources=["a.txt"],
        new_material_ids=["material-a"],
        new_source_hashes=["hash-a2"],
        new_evidence_refs=["ev-a2"],
        model="test-model",
    )
    _, body = _parse_frontmatter(merged)

    assert "New A" in body
    assert "Old A" not in body
    assert "Fact B" in body
    assert "continuation B" in body
    assert "Preserved Evidence-backed Facts" in body


@pytest.mark.asyncio
async def test_evidence_verifier_rejects_unsupported_claim(monkeypatch):
    monkeypatch.setattr(wiki_compile, "ENABLE_EVIDENCE_VERIFICATION", True)
    provider = MagicMock()
    response = MagicMock()
    response.finish_reason = "stop"
    response.content = json.dumps({
        "supportedClaimIds": [],
        "unsupportedClaimIds": ["claim-1"],
        "representedRefs": [],
    })
    provider.chat_with_retry = AsyncMock(return_value=response)

    represented, warnings, rejected = await wiki_compile._verify_batch_evidence(
        provider,
        "test-model",
        {"refs": ["ev-1"], "content": "[EVIDENCE_REF ev-1]\n真实内容"},
        [{"path": "wiki/x.md", "content": "- 错误事实 [[evidence:ev-1]]"}],
    )

    assert represented == set()
    assert rejected is True
    assert "unsupported" in warnings[0]


@pytest.mark.asyncio
async def test_evidence_verifier_receives_complete_multiline_paragraph(monkeypatch):
    monkeypatch.setattr(wiki_compile, "ENABLE_EVIDENCE_VERIFICATION", True)
    provider = MagicMock()
    response = MagicMock()
    response.finish_reason = "stop"
    response.content = json.dumps({
        "supportedClaimIds": ["claim-1"],
        "unsupportedClaimIds": [],
        "representedRefs": ["ev-1"],
    })
    provider.chat_with_retry = AsyncMock(return_value=response)

    represented, warnings, rejected = await wiki_compile._verify_batch_evidence(
        provider,
        "test-model",
        {"refs": ["ev-1"], "content": "[EVIDENCE_REF ev-1]\n完整证据"},
        [{
            "path": "wiki/x.md",
            "content": (
                "---\ntype: concept\ntitle: X\n---\n\n"
                "第一行事实，\n第二行继续说明。[[evidence:ev-1]]\n"
            ),
        }],
    )
    request = provider.chat_with_retry.await_args.kwargs["messages"]
    verifier_payload = json.loads(request[1]["content"])

    assert represented == {"ev-1"}
    assert warnings == []
    assert rejected is False
    assert "第一行事实" in verifier_payload["claims"][0]["text"]
    assert "第二行继续说明" in verifier_payload["claims"][0]["text"]


def test_required_citations_drop_uncited_or_unknown_source_claims():
    pages, used, warnings = wiki_compile._remove_uncited_blocks(
        {"refs": ["ev-known"]},
        [{
            "path": "wiki/x.md",
            "content": (
                "---\ntype: concept\ntitle: X\n---\n\n"
                "# X\n\n"
                "有来源的事实。[[evidence:ev-known]]\n\n"
                "没有来源的事实。\n\n"
                "错误来源。[[evidence:ev-other]]\n"
            ),
        }],
    )

    assert used == {"ev-known"}
    assert len(pages) == 1
    assert "有来源的事实" in pages[0]["content"]
    assert "没有来源的事实" not in pages[0]["content"]
    assert "错误来源" not in pages[0]["content"]
    assert len(warnings) == 2

    _, _, rejected = wiki_compile._validate_batch_citations(
        {"refs": ["ev-known"]},
        [{"path": "wiki/x.md", "content": "没有来源的事实。"}],
    )
    assert rejected is True


# ---------------------------------------------------------------------------
# slug 同名不覆盖
# ---------------------------------------------------------------------------


def test_source_summary_slug_includes_directory():
    s1 = wiki_compile._source_summary_slug("docs/report.pdf")
    s2 = wiki_compile._source_summary_slug("papers/report.pdf")
    assert s1 != s2
    assert s1 == "docs-report"
    assert s2 == "papers-report"


# ---------------------------------------------------------------------------
# 端到端编译流程（mock LLM）
# ---------------------------------------------------------------------------


async def test_compile_end_to_end_merges_two_sources(vault, monkeypatch):
    """两份资料可合并到同一 Wiki 页面，sources 是两个可打开的原始路径。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_raw(root, "sub/b.txt")
    _write_text_ready(root, "a.txt", "正文 A", material_id="material-A", sha="hashA")
    _write_text_ready(root, "sub/b.txt", "正文 B", material_id="material-B", sha="hashB")

    # 两个文件都生成同一个 entity 页面 + 各自的 source summary
    def generation_for(source_rel: str) -> str:
        slug = wiki_compile._source_summary_slug(source_rel)
        return (
            f"---FILE: wiki/sources/{slug}.md---\n"
            "---\ntype: source\ntitle: S\nsources: [x]\n---\n\n# S\n"
            "---END FILE---\n"
            "---FILE: wiki/entities/shared.md---\n"
            "---\ntype: entity\ntitle: Shared\n---\n\n# Shared\n"
            "---END FILE---\n"
        )

    provider = MagicMock()

    async def _chat(**kwargs):
        resp = MagicMock()
        resp.finish_reason = "stop"
        # 单次调用：根据 user 消息里的文件路径区分来源
        user_msg = kwargs["messages"][1]["content"]
        rel = "a.txt" if "a.txt" in user_msg else "sub/b.txt"
        resp.content = generation_for(rel)
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["a.txt", "sub/b.txt"])
    await task.asyncio_task

    assert task.state == "done"
    assert provider.chat_with_retry.call_count == 2  # 单 LLM 调用：N 文件 = N 次
    assert task.pages_written == 3  # 2 个 source summary + 1 个合并 entity
    shared = (root / "wiki" / "entities" / "shared.md").read_text(encoding="utf-8")
    fm, _ = _parse_frontmatter(shared)
    assert str(fm["id"]).startswith("wiki-")
    assert "a.txt" in fm["sources"]
    assert "sub/b.txt" in fm["sources"]
    assert "material-A" in fm["materialIds"]
    assert "material-B" in fm["materialIds"]
    assert fm["generatedBy"] == "test-model"
    # 同名文件在不同目录：各自的 source summary 不互相覆盖
    assert (root / "wiki" / "sources" / "a.md").exists()
    assert (root / "wiki" / "sources" / "sub-b.md").exists()


def test_compile_batches_bound_reference_output_without_losing_evidence():
    segments = [
        {"ref": f"ev-{index:032x}", "label": f"段落 {index}", "content": f"事实 {index}"}
        for index in range(177)
    ]
    batches = wiki_compile._build_evidence_batches(segments)

    assert len(batches) > 1
    assert all(len(batch["refs"]) <= wiki_compile.MAX_EVIDENCE_REFS_PER_BATCH for batch in batches)
    assert [ref for batch in batches for ref in batch["refs"]] == [segment["ref"] for segment in segments]
    assert all(segment["content"] in "\n".join(batch["content"] for batch in batches) for segment in segments)


async def test_compile_considers_all_evidence_without_copying_every_ref_into_wiki(
    vault, monkeypatch
):
    """完整处理原文即可完成；Wiki 只引用真正采用的重点。"""
    root = _materials(vault)
    text_content = (
        "---\nid: material-paper\nsha256: hash-paper\nstatus: ok\n---\n\n"
        '<!-- seg {"id":"ev-one","kind":"block","label":"一"} -->\n'
        "## 一\n\n重点事实\n\n"
        '<!-- seg {"id":"ev-two","kind":"block","label":"二"} -->\n'
        "## 二\n\n补充细节\n"
    )
    provider = MagicMock()

    async def _chat(**kwargs):
        response = MagicMock()
        response.finish_reason = "stop"
        response.content = (
            "---FILE: wiki/sources/paper.md---\n"
            "---\ntype: source\ntitle: Paper\n---\n\n"
            "重点事实。[[evidence:ev-one]]\n"
            "---END FILE---\n"
        )
        return response

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    progress: list[dict] = []
    blocks, warnings, coverage = await wiki_compile._compile_one_file(
        provider,
        "test-model",
        root,
        "paper.txt",
        text_content,
        material_id="material-paper",
        on_progress=progress.append,
    )

    assert warnings == []
    assert blocks
    assert coverage["complete"] is True
    assert coverage["processedSegments"] == 2
    assert coverage["representedSegments"] == 1
    assert blocks[0]["evidenceComplete"] is False
    assert progress[-1] == coverage
    assert provider.chat_with_retry.await_args.kwargs["reasoning_effort"] == "none"


async def test_compile_retry_reuses_finished_parts(vault, monkeypatch):
    """部分失败后只重新请求失败部分。"""
    root = _materials(vault)
    monkeypatch.setattr(wiki_compile, "MAX_SOURCE_CHARS", 90)
    tail_marker = "TAIL_RETRY_MARKER"
    body = "FIRST_PART\n" + ("middle " * 20) + f"\n{tail_marker}"
    text_content = (
        "---\nid: material-paper\nsha256: hash-retry\nstatus: ok\n---\n\n"
        f"{body}"
    )
    batches = wiki_compile._build_evidence_batches(
        wiki_compile._source_evidence_segments(text_content, "material-paper")[0]
    )
    provider = MagicMock()
    failed_attempts = 0

    async def _chat(**kwargs):
        nonlocal failed_attempts
        user_content = kwargs["messages"][1]["content"]
        response = MagicMock()
        if tail_marker in user_content and failed_attempts < 2:
            failed_attempts += 1
            response.finish_reason = "error"
            response.content = "temporary failure"
            return response
        evidence_ref = re.search(r"EVIDENCE_REF ([^ |\]]+)", user_content).group(1)
        response.finish_reason = "stop"
        response.content = (
            "---FILE: wiki/sources/paper.md---\n"
            "---\ntype: source\ntitle: Paper\n---\n\n"
            f"已整理内容。[[evidence:{evidence_ref}]]\n"
            "---END FILE---\n"
        )
        return response

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    _, _, first_coverage = await wiki_compile._compile_one_file(
        provider, "test-model", root, "paper.txt", text_content,
        material_id="material-paper",
    )
    _, _, second_coverage = await wiki_compile._compile_one_file(
        provider, "test-model", root, "paper.txt", text_content,
        material_id="material-paper",
    )

    assert len(batches) > 1
    assert first_coverage["complete"] is False
    assert second_coverage["complete"] is True
    assert provider.chat_with_retry.await_count == len(batches) + 2


async def test_compile_batches_long_source_and_processes_tail(vault, monkeypatch):
    """超长资料必须分批送入 LLM，尾部内容不能被静默截断。"""
    root = _materials(vault)
    tail_marker = "TAIL_MARKER_MUST_BE_PROCESSED"
    body = "HEAD_MARKER\n" + ("middle " * 40) + f"\n{tail_marker}"
    _write_raw(root, "paper.txt", body)
    _write_text_ready(
        root,
        "paper.txt",
        body,
        material_id="material-paper",
        sha="hash-paper",
    )
    monkeypatch.setattr(wiki_compile, "MAX_SOURCE_CHARS", 128)

    user_inputs: list[str] = []
    provider = MagicMock()

    async def _chat(**kwargs):
        user_content = kwargs["messages"][1]["content"]
        user_inputs.append(user_content)
        resp = MagicMock()
        resp.finish_reason = "stop"
        resp.content = (
            "---FILE: wiki/sources/paper.md---\n"
            "---\ntype: source\ntitle: Paper\nsources: [paper.txt]\n---\n\n"
            "# Paper\n"
            "---END FILE---\n"
        )
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["paper.txt"])
    await task.asyncio_task

    assert task.state == "done"
    assert len(user_inputs) >= 2
    assert any(tail_marker in content for content in user_inputs)


async def test_compile_preserves_evidence_refs_to_source_material(vault, monkeypatch):
    """Wiki 产物保留稳定 chunk ref，且 ref 前缀可追溯到源资料 ID。"""
    root = _materials(vault)
    _write_raw(root, "paper.txt", "论文正文")
    _write_text_ready(
        root,
        "paper.txt",
        "论文正文",
        material_id="material-paper",
        sha="hash-paper",
    )
    used_ref = ""
    provider = MagicMock()

    async def _chat(**kwargs):
        nonlocal used_ref
        user_content = kwargs["messages"][1]["content"]
        used_ref = re.search(r"EVIDENCE_REF ([^ |\]]+)", user_content).group(1)
        resp = MagicMock()
        resp.finish_reason = "stop"
        resp.content = (
            "---FILE: wiki/entities/study.md---\n"
            "---\n"
            "type: entity\n"
            "title: Study\n"
            f"evidenceRefs: [{used_ref}]\n"
            "sources: [paper.txt]\n"
            "---\n\n"
            "# Study\n"
            f"Evidence ref: {used_ref} [[evidence:{used_ref}]]\n"
            "---END FILE---\n"
        )
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock(provider=provider, model="test-model")
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["paper.txt"])
    await task.asyncio_task

    assert task.state == "done"
    content = (root / "wiki" / "entities" / "study.md").read_text(encoding="utf-8")
    fm, body = _parse_frontmatter(content)
    source_fm, _ = _parse_frontmatter(
        (root / "text" / "paper.txt.md").read_text(encoding="utf-8")
    )
    assert fm["evidenceRefs"] == [used_ref]
    assert used_ref in body
    assert source_fm["id"] == "material-paper"
    assert all(ref.startswith("ev-") for ref in fm["evidenceRefs"])


async def test_compile_canonical_entity_keeps_both_source_candidates(vault, monkeypatch):
    """同一 canonical entity 的候选正文与证据不能只保留第一份。"""
    root = _materials(vault)
    for rel, material_id, sha in (
        ("a.txt", "material-A", "hashA"),
        ("b.txt", "material-B", "hashB"),
    ):
        _write_raw(root, rel, f"正文 {rel}")
        _write_text_ready(
            root,
            rel,
            f"正文 {rel}",
            material_id=material_id,
            sha=sha,
        )

    provider = MagicMock()
    seen_refs: set[str] = set()

    async def _chat(**kwargs):
        user_content = kwargs["messages"][1]["content"]
        evidence_ref = re.search(r"EVIDENCE_REF ([^ |\]]+)", user_content).group(1)
        seen_refs.add(evidence_ref)
        source_rel, material_id, finding = (
            ("a.txt", "material-A", "Finding from source A")
            if "a.txt" in user_content
            else ("b.txt", "material-B", "Finding from source B")
        )
        resp = MagicMock()
        resp.finish_reason = "stop"
        resp.content = (
            "---FILE: wiki/entities/shared.md---\n"
            "---\n"
            "type: entity\n"
            "title: Shared\n"
                f"evidenceRefs: [{evidence_ref}]\n"
            f"sources: [{source_rel}]\n"
            "---\n\n"
            "# Shared\n"
                f"{finding} [[evidence:{evidence_ref}]]\n"
            "---END FILE---\n"
        )
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["a.txt", "b.txt"])
    await task.asyncio_task

    assert task.state == "done"
    canonical = root / "wiki" / "entities" / "shared.md"
    content = canonical.read_text(encoding="utf-8")
    fm, body = _parse_frontmatter(content)
    assert "Finding from source A" in body
    assert "Finding from source B" in body
    assert set(fm["evidenceRefs"]) == seen_refs


async def test_compile_snapshot_reports_incomplete_batch(vault, monkeypatch):
    """批次编译中途失败时，任务快照必须暴露错误而非静默 done。"""
    root = _materials(vault)
    tail_marker = "TAIL_BATCH_FAILURE_MARKER"
    body = "HEAD_MARKER\n" + ("middle " * 40) + f"\n{tail_marker}"
    _write_raw(root, "paper.txt", body)
    _write_text_ready(
        root,
        "paper.txt",
        body,
        material_id="material-paper",
        sha="hash-paper",
    )
    monkeypatch.setattr(wiki_compile, "MAX_SOURCE_CHARS", 128)

    user_inputs: list[str] = []
    provider = MagicMock()

    async def _chat(**kwargs):
        user_content = kwargs["messages"][1]["content"]
        user_inputs.append(user_content)
        resp = MagicMock()
        resp.finish_reason = "stop"
        if tail_marker in user_content:
            resp.content = "LLM output truncated before a FILE block"
        else:
            resp.content = (
                "---FILE: wiki/sources/paper.md---\n"
                "---\ntype: source\ntitle: Paper\n---\n\n# Paper\n"
                "---END FILE---\n"
            )
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["paper.txt"])
    await task.asyncio_task

    status = task.snapshot()
    assert len(user_inputs) >= 2
    assert any(tail_marker in content for content in user_inputs)
    assert status["errors"], status


async def test_compile_regenerate_preserves_id(vault, monkeypatch):
    """重复生成保留 Wiki ID 和已有 sources。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_text_ready(root, "a.txt", "正文", material_id="material-A", sha="hashA")

    wiki_dir = root / "wiki" / "entities"
    wiki_dir.mkdir(parents=True)
    (wiki_dir / "shared.md").write_text(
        "---\nid: wiki-KEEPME\ntype: entity\ntitle: Shared\ncreated: 2026-01-01\n"
        "sources:\n  - legacy.pdf\n---\n\n# 旧\n",
        encoding="utf-8",
    )

    generation = (
        "---FILE: wiki/entities/shared.md---\n"
        "---\ntype: entity\ntitle: Shared\n---\n\n# 新\n"
        "---END FILE---\n"
    )
    _mock_provider_snapshot(monkeypatch, generation=generation)

    task = await wiki_compile.start_compile(["a.txt"])
    await task.asyncio_task

    assert task.state == "done"
    content = (wiki_dir / "shared.md").read_text(encoding="utf-8")
    fm, body = _parse_frontmatter(content)
    assert fm["id"] == "wiki-KEEPME"
    assert str(fm["created"]) == "2026-01-01"
    assert "legacy.pdf" in fm["sources"]
    assert "a.txt" in fm["sources"]
    assert "# 新" in body


async def test_compile_llm_format_error_no_partial_write(vault, monkeypatch):
    """LLM 输出格式错误（无有效 FILE 块）时，wiki 目录不发生写入。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_text_ready(root, "a.txt", "正文", material_id="material-A", sha="hashA")
    _mock_provider_snapshot(monkeypatch, generation="抱歉，我无法处理这个文档。")

    task = await wiki_compile.start_compile(["a.txt"])
    await task.asyncio_task

    assert task.state == "error"
    assert any("无有效 FILE 块" in e for e in task.errors)
    assert list((root / "wiki").rglob("*.md")) == []


async def test_compile_cancel(vault, monkeypatch):
    """取消后任务进入 cancelled，不写 wiki。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_text_ready(root, "a.txt", "正文", material_id="material-A", sha="hashA")

    provider = MagicMock()

    async def _slow_chat(**kwargs):
        await asyncio.sleep(60)
        return MagicMock()

    provider.chat_with_retry = AsyncMock(side_effect=_slow_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "m"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["a.txt"])
    await asyncio.sleep(0.2)
    assert wiki_compile.cancel_compile_task(task.task_id)
    with pytest.raises(asyncio.CancelledError):
        await task.asyncio_task
    assert task.state == "cancelled"
    assert list((root / "wiki").rglob("*.md")) == []


async def test_compile_http_flow(client, vault, monkeypatch):
    """HTTP 路由：start → status → done。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_text_ready(root, "a.txt", "正文", material_id="material-A", sha="hashA")
    generation = (
        "---FILE: wiki/sources/a.md---\n"
        "---\ntype: source\ntitle: A\n---\n\n# A\n"
        "---END FILE---\n"
    )
    _mock_provider_snapshot(monkeypatch, generation=generation)

    resp = await client.post("/api/materials/wiki/compile", json={"paths": ["a.txt"]})
    assert resp.status == 200
    data = await resp.json()
    task_id = data["taskId"]

    task = wiki_compile.get_compile_task(task_id)
    await task.asyncio_task

    resp = await client.get(f"/api/materials/wiki/compile/{task_id}")
    data = await resp.json()
    assert data["state"] == "done"
    assert data["pagesWritten"] == 1
    assert data["totalFiles"] == 1


async def test_compile_rejects_path_outside_raw(client, vault):
    resp = await client.post("/api/materials/wiki/compile", json={"paths": ["../evil"]})
    assert resp.status == 400


async def test_compile_entity_pages_canonicalized_by_title(vault, monkeypatch):
    """D3：不同 LLM 路径但同 title 的 entity 页面归并到同一 canonical 路径。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_raw(root, "b.txt")
    _write_text_ready(root, "a.txt", "正文 A", material_id="material-A", sha="hashA")
    _write_text_ready(root, "b.txt", "正文 B", material_id="material-B", sha="hashB")

    def generation_for(source_rel: str) -> str:
        slug = wiki_compile._source_summary_slug(source_rel)
        # 两个文件给出不同的 LLM 原始路径，但 title 相同
        llm_path = "entities/acme-corp.md" if source_rel == "a.txt" else "entities/acme.md"
        return (
            f"---FILE: wiki/sources/{slug}.md---\n"
            "---\ntype: source\ntitle: S\n---\n\n# S\n"
            "---END FILE---\n"
            f"---FILE: wiki/{llm_path}---\n"
            "---\ntype: entity\ntitle: Acme Corp\n---\n\n# Acme Corp\n"
            "---END FILE---\n"
        )

    provider = MagicMock()

    async def _chat(**kwargs):
        resp = MagicMock()
        resp.finish_reason = "stop"
        user_msg = kwargs["messages"][1]["content"]
        rel = "a.txt" if "a.txt" in user_msg else "b.txt"
        resp.content = generation_for(rel)
        return resp

    provider.chat_with_retry = AsyncMock(side_effect=_chat)
    snapshot = MagicMock()
    snapshot.provider = provider
    snapshot.model = "test-model"
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot", lambda *a, **k: snapshot
    )

    task = await wiki_compile.start_compile(["a.txt", "b.txt"])
    await task.asyncio_task

    assert task.state == "done"
    # canonical 路径：entities/acme-corp.md（slug(title)），两个 LLM 路径都不写入
    canonical = root / "wiki" / "entities" / "acme-corp.md"
    assert canonical.exists()
    assert not (root / "wiki" / "entities" / "acme.md").exists()
    fm, _ = _parse_frontmatter(canonical.read_text(encoding="utf-8"))
    assert "a.txt" in fm["sources"]
    assert "b.txt" in fm["sources"]


async def test_compile_legacy_path_migration_preserves_id(vault, monkeypatch):
    """D3：canonical 不存在时回读 LLM 原始路径（旧页面渐进迁移），保留其 ID。"""
    root = _materials(vault)
    _write_raw(root, "a.txt")
    _write_text_ready(root, "a.txt", "正文", material_id="material-A", sha="hashA")

    # 旧页面在非 canonical 路径（title 与路径 slug 不一致）
    wiki_dir = root / "wiki" / "entities"
    wiki_dir.mkdir(parents=True)
    (wiki_dir / "legacy-name.md").write_text(
        "---\nid: wiki-LEGACY\ntype: entity\ntitle: Acme Corp\ncreated: 2026-01-01\n"
        "---\n\n# 旧\n",
        encoding="utf-8",
    )

    generation = (
        "---FILE: wiki/entities/legacy-name.md---\n"
        "---\ntype: entity\ntitle: Acme Corp\n---\n\n# 新\n"
        "---END FILE---\n"
    )
    _mock_provider_snapshot(monkeypatch, generation=generation)

    task = await wiki_compile.start_compile(["a.txt"])
    await task.asyncio_task

    assert task.state == "done"
    # 写入 canonical 路径，ID 继承自 legacy 页面
    canonical = wiki_dir / "acme-corp.md"
    assert canonical.exists()
    fm, _ = _parse_frontmatter(canonical.read_text(encoding="utf-8"))
    assert fm["id"] == "wiki-LEGACY"
    assert str(fm["created"]) == "2026-01-01"


async def test_compile_waits_for_extraction(vault, monkeypatch):
    """text 未 ready 时触发提取并等待（这里提取会失败，记录错误但不崩溃）。"""
    root = _materials(vault)
    _write_raw(root, "a.txt", "hello world")
    # 不写 text/ —— 编译会触发提取，.txt 可以被 document extractor 处理或报错，
    # 两条路径都必须是受控结果而不是异常。
    _mock_provider_snapshot(monkeypatch, generation=GENERATION_TWO_PAGES)

    task = await wiki_compile.start_compile(["a.txt"])
    await task.asyncio_task

    assert task.state in ("done", "error")
    if task.state == "done":
        assert task.pages_written > 0
    else:
        assert task.errors
