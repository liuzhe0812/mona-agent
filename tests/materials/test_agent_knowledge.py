"""回归测试：Agent 私有知识、学习状态与 Services 重启恢复。"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.materials import knowledge
from mona.utils.document import EXTRACTOR_VERSION


@pytest.fixture
def stores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """把 Agent 知识根目录和 Services 数据目录限制在本测试目录内。"""
    data_dir = tmp_path / "data"
    agents_dir = data_dir / "agents"
    agents_dir.mkdir(parents=True)

    def agent_root(agent_id: str) -> Path:
        root = agents_dir / agent_id / "knowledge"
        for name in ("raw", "text", "evidence", "wiki"):
            (root / name).mkdir(parents=True, exist_ok=True)
        return root

    monkeypatch.setattr(knowledge, "get_data_dir", lambda: data_dir)
    monkeypatch.setattr(knowledge, "get_agents_dir", lambda: agents_dir)
    monkeypatch.setattr(knowledge, "get_agent_knowledge_dir", agent_root)
    monkeypatch.setattr("mona.materials.vault.get_vault_path", lambda: None)
    monkeypatch.setattr(
        "mona.agent.user_config.get_agent_user_config_path",
        lambda agent_id: agents_dir / agent_id / "config.json",
    )
    knowledge._LEARNING_TASKS.clear()
    knowledge._AGENT_PIPELINE_LOCKS.clear()
    yield {"data": data_dir, "agents": agents_dir, "agent-a": agent_root("agent-a"), "agent-b": agent_root("agent-b")}
    pending = list(knowledge._LEARNING_TASKS.values())
    for task in pending:
        task.cancel()
    knowledge._LEARNING_TASKS.clear()
    knowledge._AGENT_PIPELINE_LOCKS.clear()


def _read_state(root: Path) -> dict:
    return json.loads((root / "state.json").read_text(encoding="utf-8"))


def _write_state(root: Path, documents: list[dict]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "state.json").write_text(
        json.dumps({"schemaVersion": 1, "documents": documents}, ensure_ascii=False),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_same_agent_md5_deduplicates_but_agents_stay_independent(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """同 Agent 只学习一次；相同内容进入另一 Agent 仍建立独立身份。"""
    running = asyncio.Event()

    async def hold_learning(_agent_id: str, _document_id: str) -> None:
        await running.wait()

    monkeypatch.setattr(knowledge, "_run_learning", hold_learning)
    content = b"same source bytes"
    agent_a = stores["agent-a"]
    agent_b = stores["agent-b"]
    (agent_a / "raw" / "original.txt").write_bytes(content)
    (agent_a / "raw" / "renamed.txt").write_bytes(content)
    (agent_b / "raw" / "copy.txt").write_bytes(content)

    first = knowledge._register_paths("agent-a", agent_a, ["original.txt"])[0]
    duplicate = knowledge._register_paths("agent-a", agent_a, ["renamed.txt"])[0]
    await asyncio.sleep(0)

    assert duplicate["id"] == first["id"]
    assert len([item for item in _read_state(agent_a)["documents"] if item["active"]]) == 1
    assert list(knowledge._LEARNING_TASKS) == [("agent-a", first["id"])]

    other = knowledge._register_paths("agent-b", agent_b, ["copy.txt"])[0]
    await asyncio.sleep(0)

    assert other["id"] != first["id"]
    assert other["md5"] == first["md5"]
    assert list(knowledge._LEARNING_TASKS) == [
        ("agent-a", first["id"]),
        ("agent-b", other["id"]),
    ]
    assert _read_state(agent_a)["documents"][0]["path"] == "original.txt"
    assert _read_state(agent_b)["documents"][0]["path"] == "copy.txt"

    running.set()
    await asyncio.gather(*list(knowledge._LEARNING_TASKS.values()))


@pytest.mark.asyncio
async def test_learning_statuses_and_force_retry(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """重新学习会取消卡住的任务，并从提取阶段强制重新排队。"""
    root = stores["agent-a"]
    (root / "raw" / "source.txt").write_text("source", encoding="utf-8")
    scheduled: list[tuple[str, str]] = []
    monkeypatch.setattr(
        knowledge,
        "_schedule",
        lambda agent_id, document_id: scheduled.append((agent_id, document_id)),
    )

    request = MagicMock()
    request.query = {"agentId": "agent-a"}
    request.json = AsyncMock(return_value={"paths": ["source.txt"]})
    response = await knowledge.handle_agent_knowledge_add(request)
    payload = json.loads(response.text)
    record = payload["documents"][0]
    document_id = record["id"]

    assert response.status == 202
    assert record["status"] == "unavailable"
    assert record["phase"] == "queued"
    assert scheduled == [("agent-a", document_id)]

    retry_request = MagicMock()
    retry_request.query = {"agentId": "agent-a"}
    retry_request.match_info = {"document_id": document_id}

    started = asyncio.Event()

    async def stuck_learning() -> None:
        started.set()
        await asyncio.Event().wait()

    running = asyncio.create_task(stuck_learning())
    await started.wait()
    knowledge._LEARNING_TASKS[("agent-a", document_id)] = running
    state = _read_state(root)
    state["documents"][0].update(
        phase="compiling",
        message="正在整理知识",
        error=None,
        resumeFrom="compiling",
    )
    _write_state(root, state["documents"])

    scheduled.clear()
    response = await knowledge.handle_agent_knowledge_retry(retry_request)
    retry_payload = json.loads(response.text)["document"]
    current = _read_state(root)["documents"][0]

    assert running.cancelled()
    assert response.status == 202
    assert retry_payload["phase"] == "queued"
    assert retry_payload["message"] == "等待重新学习"
    assert current["resumeFrom"] is None
    assert scheduled == [("agent-a", document_id)]

    async def fail_extraction(*_args: object) -> None:
        raise RuntimeError("视觉解析失败")

    monkeypatch.setattr(knowledge, "_extract_one", fail_extraction)
    knowledge._record_phase(root, document_id, "queued", message="等待学习")
    await knowledge._run_learning("agent-a", document_id)

    failed_record = _read_state(root)["documents"][0]
    assert failed_record["phase"] == "failed"
    assert failed_record["error"] == "视觉解析失败"
    public_failed = knowledge._public_record(root, failed_record)
    assert public_failed["status"] == "unavailable"
    assert public_failed["progress"]["stage"] == "failed"

    scheduled.clear()
    response = await knowledge.handle_agent_knowledge_retry(retry_request)
    retry_payload = json.loads(response.text)["document"]
    assert response.status == 202
    assert retry_payload["phase"] == "queued"
    assert retry_payload["status"] == "unavailable"
    assert scheduled == [("agent-a", document_id)]


@pytest.mark.asyncio
async def test_agent_knowledge_graph_is_scoped_and_resolves_wiki_links(
    stores: dict[str, Path],
) -> None:
    agent_a = stores["agent-a"]
    agent_b = stores["agent-b"]
    (agent_a / "wiki" / "concepts").mkdir(parents=True)
    (agent_a / "wiki" / "entities").mkdir(parents=True)
    (agent_a / "wiki" / "concepts" / "ai.md").write_text(
        "---\nid: wiki-ai\ntitle: AI\ntype: concept\n---\n\n"
        "关联 [[entities/Mona|Mona]]、[[助手]] 与 ![[concepts/Missing#说明]]。\n",
        encoding="utf-8",
    )
    (agent_a / "wiki" / "entities" / "Mona.md").write_text(
        "---\nid: wiki-mona\ntitle: Mona\ntype: entity\naliases: [助手]\n---\n\nMona。\n",
        encoding="utf-8",
    )
    (agent_b / "wiki" / "private.md").write_text(
        "---\nid: wiki-private\ntitle: Private\n---\n",
        encoding="utf-8",
    )

    request = MagicMock()
    request.query = {"agentId": "agent-a"}
    response = await knowledge.handle_agent_knowledge_graph(request)
    payload = json.loads(response.text)

    assert {node["id"] for node in payload["nodes"]} == {"wiki-ai", "wiki-mona"}
    assert all(node["sourceKind"] == "wiki" for node in payload["nodes"])
    assert [edge["resolvedTarget"] for edge in payload["edges"][:2]] == [
        "wiki-mona",
        "wiki-mona",
    ]
    assert payload["edges"][2] == {
        "source": "wiki-ai",
        "targetTitle": "concepts/Missing",
        "resolvedTarget": None,
        "kind": "embed",
        "anchor": "说明",
    }


@pytest.mark.asyncio
async def test_services_recovery_resumes_only_interrupted_phases(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Services 重启只恢复 queued/extracting/compiling，不自动恢复 failed。"""
    root = stores["agent-a"]
    documents = [
        {"id": "queued", "active": True, "phase": "queued"},
        {"id": "extracting", "active": True, "phase": "extracting"},
        {"id": "compiling", "active": True, "phase": "compiling"},
        {"id": "failed", "active": True, "phase": "failed", "error": "manual retry"},
        {"id": "ready", "active": True, "phase": "ready"},
    ]
    _write_state(root, documents)
    scheduled: list[tuple[str, str]] = []
    monkeypatch.setattr(
        knowledge,
        "_schedule",
        lambda agent_id, document_id: scheduled.append((agent_id, document_id)),
    )

    await knowledge.recover_agent_knowledge_tasks(None)

    recovered = {item["id"]: item for item in _read_state(root)["documents"]}
    assert {recovered[key]["phase"] for key in ("queued", "extracting", "compiling")} == {"queued"}
    assert recovered["failed"]["phase"] == "failed"
    assert recovered["failed"]["error"] == "manual retry"
    assert recovered["ready"]["phase"] == "ready"
    assert set(scheduled) == {
        ("agent-a", "queued"),
        ("agent-a", "extracting"),
        ("agent-a", "compiling"),
    }
    assert ("agent-a", "failed") not in scheduled


def test_default_partners_do_not_import_monas_legacy_knowledge(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from mona.materials.catalog import get_library_root

    vault = stores["data"] / "legacy-vault"
    legacy_root = get_library_root(vault)
    source = legacy_root / "raw" / "legacy.txt"
    source.write_text("Mona legacy knowledge", encoding="utf-8")
    monkeypatch.setattr("mona.materials.vault.get_vault_path", lambda: vault)

    for agent_id in ("agent-a", "agent-b"):
        state = knowledge.ensure_agent_knowledge_state(agent_id)
        assert state["documents"] == []
        assert not list((stores[agent_id] / "raw").rglob("*.txt"))

    mona_state = knowledge.ensure_agent_knowledge_state("mona")
    assert len(mona_state["documents"]) == 1
    assert mona_state["documents"][0]["path"] == "kb-default/legacy.txt"
    assert source.read_text(encoding="utf-8") == "Mona legacy knowledge"


def test_existing_implicit_legacy_copies_are_withdrawn_without_losing_uploads(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from mona.materials.index import MaterialsIndex, sync_index

    root = stores["agent-a"]
    raw = root / "raw" / "kb-default" / "legacy.txt"
    raw.parent.mkdir(parents=True)
    raw.write_text("inherited-only-fact", encoding="utf-8")
    own_raw = root / "raw" / "own.txt"
    own_raw.write_text("own source", encoding="utf-8")
    text = root / "text" / "kb-default" / "legacy.txt.md"
    text.parent.mkdir(parents=True)
    text.write_text(
        "---\nid: material-legacy\nsource: kb-default/legacy.txt\nstatus: ok\n---\n\n"
        "inherited-only-fact\n",
        encoding="utf-8",
    )
    (root / "evidence" / "material-legacy.json").write_text("{}", encoding="utf-8")
    legacy_page = root / "wiki" / "legacy.md"
    legacy_page.write_text(
        "---\nid: wiki-legacy\ntitle: Inherited\nsources: [kb-default/legacy.txt]\n"
        "materialIds: [material-legacy]\n---\n\ninherited-only-fact\n",
        encoding="utf-8",
    )
    own_page = root / "wiki" / "own.md"
    own_page.write_text(
        "---\nid: wiki-own\ntitle: Own\nsources: [own.txt]\n---\n\nown fact\n",
        encoding="utf-8",
    )
    _write_state(root, [
        {"id": "legacy", "path": "kb-default/legacy.txt", "active": True,
         "phase": "failed", "md5": knowledge._hash_file(raw, "md5"),
         "sha256": knowledge._hash_file(raw, "sha256"), "legacyKnowledgeBaseId": "kb-default"},
        {"id": "own", "path": "own.txt", "active": True, "phase": "failed"},
    ])
    index = MaterialsIndex(root / "index.db", vault=stores["data"], library_root=root)
    try:
        sync_index(stores["data"], index, library_root=root)
        assert index.search("inherited-only-fact", count=5)
    finally:
        index.close()

    state = knowledge.ensure_agent_knowledge_state("agent-a")
    records = {item["id"]: item for item in state["documents"]}
    assert not records["legacy"]["active"]
    assert records["own"]["active"]
    assert own_raw.read_text(encoding="utf-8") == "own source"
    assert own_page.is_file()
    assert not legacy_page.exists()
    assert (root / "archive" / "legacy" / "raw" / "kb-default" / "legacy.txt").read_text(
        encoding="utf-8"
    ) == "inherited-only-fact"
    assert "wiki-legacy" not in {node["id"] for node in knowledge._build_agent_knowledge_graph(root)["nodes"]}
    index = MaterialsIndex(root / "index.db", vault=stores["data"], library_root=root)
    try:
        assert index.search("inherited-only-fact", count=5) == []
    finally:
        index.close()

    uploaded = root / "raw" / "uploaded.txt"
    uploaded.write_text("inherited-only-fact", encoding="utf-8")
    monkeypatch.setattr(knowledge, "_schedule", lambda *_args: None)
    registered = knowledge._register_paths("agent-a", root, ["uploaded.txt"])[0]
    assert registered["active"]
    assert registered["path"] == "uploaded.txt"
    assert knowledge.ensure_agent_knowledge_state("agent-a")["documents"][0]["active"]


@pytest.mark.parametrize("agent_id", ["mona", "agent-a"])
def test_legacy_repair_preserves_mona_and_explicit_assignments(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch, agent_id: str
) -> None:
    from mona.agent.user_config import AgentUserConfig, KnowledgeBaseScope

    root = knowledge.get_agent_knowledge_dir(agent_id)
    raw = root / "raw" / "legacy.txt"
    raw.write_text("explicit knowledge", encoding="utf-8")
    _write_state(root, [{
        "id": "legacy", "path": "legacy.txt", "active": True,
        "phase": "failed", "legacyKnowledgeBaseId": "kb-default",
    }])
    config = AgentUserConfig(knowledge_base_scope=KnowledgeBaseScope(
        mode="specific", knowledge_base_ids=["kb-default"]
    )) if agent_id != "mona" else AgentUserConfig()
    monkeypatch.setattr("mona.agent.user_config.load_agent_user_config", lambda _agent_id: config)

    assert knowledge.ensure_agent_knowledge_state(agent_id)["documents"][0]["active"]
    assert raw.read_text(encoding="utf-8") == "explicit knowledge"


def test_legacy_knowledge_migration_is_conservative_and_relearns_visual_sources(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """旧资料复制到 Agent 私有目录，原库保留，PDF 必须重新学习。"""
    import mona.materials.vault as materials_vault

    legacy_vault = stores["data"] / "legacy-vault"
    legacy_root = legacy_vault / ".mona" / "materials"
    for name in ("raw", "text", "evidence", "wiki"):
        (legacy_root / name).mkdir(parents=True, exist_ok=True)

    text_raw = legacy_root / "raw" / "manual.txt"
    text_bytes = b"legacy text source"
    text_raw.write_bytes(text_bytes)
    text_sha = knowledge._hash_file(text_raw, "sha256")
    text_doc = legacy_root / "text" / "manual.txt.md"
    text_doc.write_text(
        "---\n"
        "id: material-legacy-text\n"
        "source: manual.txt\n"
        f"sha256: {text_sha}\n"
        "status: ok\n"
        "---\n\nLegacy extracted text\n",
        encoding="utf-8",
    )
    (legacy_root / "evidence" / "material-legacy-text.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "materialId": "material-legacy-text",
                "source": "manual.txt",
                "sourceHash": text_sha,
                "units": [{"id": "ev-legacy-text", "status": "represented"}],
            }
        ),
        encoding="utf-8",
    )

    pdf_raw = legacy_root / "raw" / "scan.pdf"
    pdf_bytes = b"legacy pdf bytes"
    pdf_raw.write_bytes(pdf_bytes)
    pdf_sha = knowledge._hash_file(pdf_raw, "sha256")
    pdf_doc = legacy_root / "text" / "scan.pdf.md"
    pdf_doc.write_text(
        "---\n"
        "id: material-legacy-pdf\n"
        "source: scan.pdf\n"
        f"sha256: {pdf_sha}\n"
        "status: ok\n"
        "---\n\nLegacy PDF text layer\n",
        encoding="utf-8",
    )

    legacy_page = legacy_root / "wiki" / "topic.md"
    legacy_page.write_text(
        "---\n"
        "id: wiki-legacy-topic\n"
        "title: Legacy topic\n"
        "sources:\n"
        "  - manual.txt\n"
        "  - scan.pdf\n"
        "sourceHashes:\n"
        f"  - {text_sha}\n"
        f"  - {pdf_sha}\n"
        "---\n\nLegacy Wiki knowledge\n",
        encoding="utf-8",
    )
    original_page = legacy_page.read_text(encoding="utf-8")

    monkeypatch.setattr(materials_vault, "get_vault_path", lambda: legacy_vault)
    monkeypatch.setattr(knowledge, "allowed_library_ids", lambda _vault, _agent: ["kb-default"])
    monkeypatch.setattr(knowledge, "get_library_root", lambda _vault, _library_id: legacy_root)
    monkeypatch.setattr(knowledge, "sync_write_point", lambda *_args, **_kwargs: None)

    state = knowledge.ensure_agent_knowledge_state("agent-a")
    records = {item["name"]: item for item in state["documents"]}
    agent_root = stores["agent-a"]

    assert (agent_root / "raw" / "kb-default" / "manual.txt").read_bytes() == text_bytes
    assert (agent_root / "raw" / "kb-default" / "scan.pdf").read_bytes() == pdf_bytes
    assert records["manual.txt"]["phase"] == "ready"
    assert records["manual.txt"]["path"] == "kb-default/manual.txt"
    assert records["scan.pdf"]["phase"] == "failed"
    assert "识别图片内容" in records["scan.pdf"]["error"]

    migrated_text = agent_root / "text" / "kb-default" / "manual.txt.md"
    assert "source: kb-default/manual.txt" in migrated_text.read_text(encoding="utf-8")
    assert not (agent_root / "wiki" / "legacy" / "kb-default" / "topic.md").exists()

    assert text_raw.read_bytes() == text_bytes
    assert pdf_raw.read_bytes() == pdf_bytes
    assert legacy_page.read_text(encoding="utf-8") == original_page


@pytest.mark.asyncio
async def test_incomplete_knowledge_organization_keeps_evidence_available(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Wiki 整理失败不能撤销已经完整入库的原文证据。"""
    root = stores["agent-a"]
    raw = root / "raw" / "source.txt"
    raw.write_text("source", encoding="utf-8")
    raw_sha = knowledge._hash_file(raw, "sha256")
    text_path = root / "text" / "source.txt.md"
    text_path.write_text(
        "---\n"
        "id: material-source\n"
        "source: source.txt\n"
        f"sha256: {raw_sha}\n"
        f"size: {raw.stat().st_size}\n"
        f"mtimeNs: {raw.stat().st_mtime_ns}\n"
        f"extractorVersion: {EXTRACTOR_VERSION}\n"
        "status: ok\n"
        "---\n\nExtracted source\n",
        encoding="utf-8",
    )
    (root / "evidence" / "material-source.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "materialId": "material-source",
            "source": "source.txt",
            "sourceHash": raw_sha,
            "units": [{"id": "ev-source", "status": "uncovered"}],
        }),
        encoding="utf-8",
    )
    document = {
        "id": "document-source",
        "name": "source.txt",
        "path": "source.txt",
        "size": raw.stat().st_size,
        "md5": knowledge._hash_file(raw, "md5"),
        "sha256": raw_sha,
        "active": True,
        "phase": "queued",
        "message": "等待学习",
        "error": None,
        "updatedAt": "now",
    }
    _write_state(root, [document])

    compile_calls: list[dict[str, object]] = []
    incomplete_task = SimpleNamespace(
        state="done",
        total_segments=2,
        processed_segments=1,
        failed_batches=0,
        missing_segments=["Page 2"],
        errors=[],
        warnings=["证据不完整"],
        asyncio_task=None,
        snapshot=lambda: {
            "coverage": {
                "totalSegments": 2,
                "processedSegments": 1,
                "totalBatches": 2,
                "processedBatches": 1,
            }
        },
    )

    async def fake_start_compile_at(paths: list[str], **kwargs: object) -> SimpleNamespace:
        compile_calls.append({"paths": paths, **kwargs})
        return incomplete_task

    async def successful_extraction(*_args: object) -> None:
        return None

    monkeypatch.setattr(knowledge, "_extract_one", successful_extraction)
    monkeypatch.setattr(knowledge, "start_compile_at", fake_start_compile_at)

    await knowledge._run_learning("agent-a", "document-source")

    assert len(compile_calls) == 1
    assert compile_calls[0]["require_complete_evidence"] is True
    result = _read_state(root)["documents"][0]
    assert result["phase"] == "failed"
    assert result["evidenceReady"] is True
    assert result["error"] == "原文已可检索；证据不完整，可重新学习继续整理"
    assert knowledge._public_record(root, result)["status"] == "available"


def test_learning_progress_reports_the_current_business_step(stores: dict[str, Path]) -> None:
    root = stores["agent-a"]
    _write_state(root, [{
        "id": "document-source",
        "name": "source.txt",
        "path": "source.txt",
        "size": 6,
        "active": True,
        "phase": "compiling",
        "updatedAt": "now",
    }])

    knowledge._record_compile_progress(root, "document-source", {
        "coverage": {
            "processedBatches": 1,
            "totalBatches": 6,
            "currentBatch": 2,
        }
    })

    progress = _read_state(root)["documents"][0]["progress"]
    assert progress["stage"] == "organizing"
    assert progress["completed"] == 1
    assert progress["total"] == 6
    assert progress["detail"] == "原文已可检索，正在整理第 2/6 部分"


@pytest.mark.asyncio
async def test_agent_knowledge_becomes_available_when_evidence_is_ready(
    stores: dict[str, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """失败状态仍以完整证据为准开放原文和有引用的 Wiki。"""
    from mona.agent.tools import knowledge_search as search_module
    from mona.agent.tools.knowledge_search import (
        MaterialsReadTool,
        MaterialsSearchTool,
        WikiSearchTool,
    )
    from mona.materials.index import MaterialsIndex, sync_index

    root = stores["agent-a"]
    data_dir = stores["data"]
    raw = root / "raw" / "source.txt"
    raw.write_text("agent-only-fact", encoding="utf-8")
    raw_sha = knowledge._hash_file(raw, "sha256")
    text = root / "text" / "source.txt.md"
    text.write_text(
        "---\n"
        "id: material-source\n"
        "source: source.txt\n"
        f"sha256: {raw_sha}\n"
        f"size: {raw.stat().st_size}\n"
        f"mtimeNs: {raw.stat().st_mtime_ns}\n"
        f"extractorVersion: {EXTRACTOR_VERSION}\n"
        "status: ok\n"
        "---\n\n"
        '<!-- seg {"id":"ev-source","kind":"block","label":"正文"} -->\n'
        "## 正文\n\nagent-only-fact\n",
        encoding="utf-8",
    )
    evidence_manifest = root / "evidence" / "material-source.json"
    wiki = root / "wiki" / "topic.md"
    wiki.write_text(
        "---\n"
        "id: wiki-topic\n"
        "title: Topic\n"
        "evidenceRefs:\n"
        "  - ev-source\n"
        "materialIds:\n"
        "  - material-source\n"
        "sources:\n"
        "  - source.txt\n"
        "---\n\nagent-only-fact\n",
        encoding="utf-8",
    )
    _write_state(
        root,
        [
            {
                "id": "document-source",
                "name": "source.txt",
                "path": "source.txt",
                "size": raw.stat().st_size,
                "md5": knowledge._hash_file(raw, "md5"),
                "sha256": raw_sha,
                "active": True,
                "phase": "failed",
                "message": "学习失败",
                "error": "证据不完整",
                "updatedAt": "now",
            }
        ],
    )

    monkeypatch.setattr(search_module, "get_data_dir", lambda: data_dir)
    monkeypatch.setattr(search_module, "get_agent_knowledge_dir", lambda _agent_id: root)
    monkeypatch.setattr(search_module, "_get_vault_path", lambda: data_dir)
    index = MaterialsIndex(root / "index.db", vault=data_dir, library_root=root)
    try:
        sync_index(data_dir, index, library_root=root)
        source_rows = index.search("agent-only-fact", count=5, kinds=("source",))
        wiki_rows = index.search("agent-only-fact", count=5, kinds=("derived",))
    finally:
        index.close()
    assert source_rows and wiki_rows
    source_ref = source_rows[0]["ref"]

    materials_out = await MaterialsSearchTool("agent-a").execute(
        query="agent-only-fact"
    )
    wiki_out = await WikiSearchTool("agent-a").execute(query="agent-only-fact")
    read_out = await MaterialsReadTool("agent-a").execute(ref=f"ak:{source_ref}")
    assert "Ref: ak:" not in materials_out
    assert "Ref: ak:" not in wiki_out
    assert "not available" in read_out

    evidence_manifest.write_text(
        json.dumps({
            "schemaVersion": 1,
            "materialId": "material-source",
            "source": "source.txt",
            "sourceHash": raw_sha,
            "units": [{"id": "ev-source", "status": "represented"}],
        }),
        encoding="utf-8",
    )

    materials_out = await MaterialsSearchTool("agent-a").execute(
        query="agent-only-fact"
    )
    wiki_out = await WikiSearchTool("agent-a").execute(query="agent-only-fact")
    read_out = await MaterialsReadTool("agent-a").execute(ref=f"ak:{source_ref}")
    assert "agent-only-fact" in materials_out
    assert "agent-only-fact" in wiki_out
    assert "agent-only-fact" in read_out
