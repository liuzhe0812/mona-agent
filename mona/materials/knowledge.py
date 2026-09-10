"""Persistent per-Agent knowledge learning orchestration and HTTP handlers."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.agent.partners import normalize_agent_id
from mona.config.paths import get_agent_knowledge_dir, get_agents_dir, get_data_dir
from mona.materials.access import allowed_library_ids
from mona.materials.api import (
    _atomic_write_text,
    _clean_rel,
    _ensure_within_domain,
    _extract_one,
    _read_existing_material_id,
    _read_text_status,
    _rewrite_evidence_manifest_source,
    _rewrite_text_frontmatter_source,
    _text_path_for_raw,
    _wiki_ingest_states,
)
from mona.materials.catalog import get_library_root
from mona.materials.compile import _refresh_navigation_files, start_compile_at
from mona.materials.frontmatter import _parse_frontmatter, _render_frontmatter
from mona.materials.index import sync_write_point

_STATE_SCHEMA_VERSION = 1
_LEARNING_TASKS: dict[tuple[str, str], asyncio.Task[None]] = {}
_AGENT_PIPELINE_LOCKS: dict[str, asyncio.Lock] = {}
_WIKI_LINK_PATTERN = re.compile(r"(!?)\[\[([^\[\]\n]+)\]\]")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _state_path(root: Path) -> Path:
    return root / "state.json"


def _empty_state() -> dict[str, Any]:
    return {"schemaVersion": _STATE_SCHEMA_VERSION, "documents": []}


def _read_state(root: Path) -> dict[str, Any]:
    path = _state_path(root)
    if not path.exists():
        return _empty_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Agent 知识状态文件无法读取") from exc
    if (
        not isinstance(state, dict)
        or state.get("schemaVersion") != _STATE_SCHEMA_VERSION
        or not isinstance(state.get("documents"), list)
    ):
        raise RuntimeError("Agent 知识状态版本不受支持")
    return state


def _write_state(root: Path, state: dict[str, Any]) -> None:
    _atomic_write_text(
        _state_path(root),
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
    )


def _hash_file(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


_VISUAL_SOURCE_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
}


def ensure_agent_knowledge_state(agent_id: str) -> dict[str, Any]:
    """Create private state and conservatively copy the Agent's legacy scope."""
    root = get_agent_knowledge_dir(agent_id)
    if _state_path(root).exists():
        return _read_state(root)

    from mona.materials.vault import get_vault_path

    vault = get_vault_path()
    if vault is None:
        state = _empty_state()
        _write_state(root, state)
        return state

    state = _empty_state()
    migrated_hashes: set[str] = set()
    for library_id in allowed_library_ids(vault, agent_id):
        legacy_root = get_library_root(vault, library_id)
        ingest_states = _wiki_ingest_states(legacy_root)
        source_map: dict[str, str] = {}
        ready_sources: set[str] = set()
        for raw_path in sorted((legacy_root / "raw").rglob("*")):
            if not raw_path.is_file():
                continue
            old_rel = raw_path.relative_to(legacy_root / "raw").as_posix()
            md5 = _hash_file(raw_path, "md5")
            if md5 in migrated_hashes:
                continue
            migrated_hashes.add(md5)
            new_rel = f"{library_id}/{old_rel}"
            source_map[old_rel] = new_rel
            target_raw = root / "raw" / new_rel
            target_raw.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(raw_path, target_raw)

            legacy_text = _text_path_for_raw(old_rel, legacy_root)
            target_text = _text_path_for_raw(new_rel, root)
            material_id: str | None = None
            extract_ok = False
            evidence_ok = False
            if legacy_text.is_file():
                target_text.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(legacy_text, target_text)
                _rewrite_text_frontmatter_source(target_text, new_rel)
                material_id = _read_existing_material_id(target_text)
                try:
                    fm, _ = _parse_frontmatter(target_text.read_text(encoding="utf-8"))
                    extract_ok = fm.get("status") == "ok"
                except OSError:
                    extract_ok = False
            if material_id:
                old_manifest = legacy_root / "evidence" / f"{material_id}.json"
                if old_manifest.is_file():
                    target_manifest = root / "evidence" / old_manifest.name
                    shutil.copy2(old_manifest, target_manifest)
                    _rewrite_evidence_manifest_source(root, target_text, new_rel)
                    try:
                        manifest = json.loads(target_manifest.read_text(encoding="utf-8"))
                        evidence_ok = bool(manifest.get("units"))
                    except (OSError, json.JSONDecodeError):
                        evidence_ok = False

            visual_relearn = raw_path.suffix.lower() in _VISUAL_SOURCE_EXTENSIONS
            ready = (
                extract_ok
                and evidence_ok
                and ingest_states.get(old_rel) == "ingested"
                and not visual_relearn
            )
            if ready:
                ready_sources.add(old_rel)
            state["documents"].append(
                {
                    "id": f"document-{uuid.uuid4()}",
                    "name": raw_path.name,
                    "path": new_rel,
                    "size": target_raw.stat().st_size,
                    "md5": md5,
                    "sha256": _hash_file(target_raw, "sha256"),
                    "active": True,
                    "phase": "ready" if ready else "failed",
                    "message": "" if ready else "需要重新学习",
                    "error": (
                        "需要重新学习以识别图片内容"
                        if visual_relearn
                        else None if ready else "旧资料尚未完成学习"
                    ),
                    "createdAt": _now(),
                    "updatedAt": _now(),
                    "legacyKnowledgeBaseId": library_id,
                }
            )

        legacy_wiki = legacy_root / "wiki"
        for page in sorted(legacy_wiki.rglob("*.md")):
            rel = page.relative_to(legacy_wiki).as_posix()
            if rel in {"index.md", "log.md"}:
                continue
            try:
                content = page.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, body = _parse_frontmatter(content)
            sources = fm.get("sources")
            if isinstance(sources, str):
                sources = [sources]
            if not isinstance(sources, list) or not sources:
                continue
            normalized_sources = [str(source).removeprefix("raw/") for source in sources]
            if any(source not in ready_sources for source in normalized_sources):
                continue
            rewritten_sources = [
                source_map.get(source, "") for source in normalized_sources
            ]
            if any(not source for source in rewritten_sources):
                continue
            fm["sources"] = rewritten_sources
            target_page = root / "wiki" / "legacy" / library_id / rel
            target_page.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(
                target_page,
                _render_frontmatter(fm) + body.lstrip() + "\n",
            )

    _write_state(root, state)
    sync_write_point(get_data_dir(), library_root=root, full=True)
    return state


def _agent_context(req: web.Request) -> tuple[str, Path]:
    value = req.query.get("agentId", "").strip()
    if not value:
        raise web.HTTPBadRequest(reason="agentId is required")
    try:
        agent_id = normalize_agent_id(value)
    except ValueError as exc:
        raise web.HTTPBadRequest(reason="invalid Agent id") from exc
    return agent_id, get_agent_knowledge_dir(agent_id)


def _find_record(state: dict[str, Any], document_id: str) -> dict[str, Any] | None:
    return next(
        (
            item
            for item in state["documents"]
            if isinstance(item, dict) and item.get("id") == document_id
        ),
        None,
    )


def _has_complete_evidence(root: Path, record: dict[str, Any]) -> bool:
    if not record.get("active", True):
        return False
    raw_rel = str(record.get("path", ""))
    text_path = _text_path_for_raw(raw_rel, root)
    material_id = _read_existing_material_id(text_path)
    if not material_id:
        return False
    status = _read_text_status(
        text_path,
        vault=get_data_dir(),
        raw_rel=raw_rel,
        raw_path=root / "raw" / raw_rel,
    )
    if status.get("status") != "ok":
        return False
    try:
        manifest = json.loads(
            (root / "evidence" / f"{material_id}.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError):
        return False
    return (
        manifest.get("sourceHash") == record.get("sha256")
        and isinstance(manifest.get("units"), list)
        and bool(manifest["units"])
    )


def _progress_for_phase(
    phase: str,
    *,
    evidence_ready: bool,
    detail: str = "",
) -> dict[str, Any]:
    if phase == "queued":
        return {
            "stage": "queued",
            "label": "等待开始",
            "detail": detail or "资料已加入学习队列",
            "evidenceReady": evidence_ready,
            "percent": 0,
        }
    if phase == "extracting":
        return {
            "stage": "extracting",
            "label": "正在读取资料",
            "detail": detail or "正在提取文字并识别图片",
            "evidenceReady": False,
            "percent": 25,
        }
    if phase == "compiling":
        return {
            "stage": "organizing",
            "label": "正在整理知识",
            "detail": detail or "原文已可检索，正在整理重点和关联",
            "evidenceReady": True,
            "percent": 50,
        }
    if phase == "ready":
        return {
            "stage": "ready",
            "label": "学习完成",
            "detail": detail or "原文和整理后的知识均可使用",
            "evidenceReady": True,
            "percent": 100,
        }
    return {
        "stage": "failed",
        "label": "知识整理未完成" if evidence_ready else "学习失败",
        "detail": detail or "请重新学习",
        "evidenceReady": evidence_ready,
    }


def _public_record(root: Path, record: dict[str, Any]) -> dict[str, Any]:
    phase = str(record.get("phase") or "failed")
    evidence_ready = _has_complete_evidence(root, record)
    progress = dict(record.get("progress") or _progress_for_phase(
        phase,
        evidence_ready=evidence_ready,
        detail=str(record.get("error") or record.get("message") or ""),
    ))
    progress["evidenceReady"] = evidence_ready
    public_phase = {
        "extracting": "learning",
        "compiling": "learning",
        "ready": "ready",
        "queued": "queued",
        "failed": "failed",
    }.get(phase, "failed")
    return {
        "id": record["id"],
        "name": record["name"],
        "path": f"raw/{record['path']}",
        "size": record["size"],
        "status": "available" if evidence_ready else "unavailable",
        "phase": public_phase,
        "message": record.get("error") or record.get("message"),
        "progress": progress,
        "updatedAt": record["updatedAt"],
    }


def ready_knowledge_access(root: Path) -> tuple[set[str], set[str]]:
    """Return material and evidence IDs belonging to currently usable documents."""
    state = _read_state(root)
    material_ids: set[str] = set()
    evidence_ids: set[str] = set()
    for record in state["documents"]:
        if (
            not isinstance(record, dict)
            or not record.get("active", True)
            or not _has_complete_evidence(root, record)
        ):
            continue
        text_path = _text_path_for_raw(str(record.get("path", "")), root)
        material_id = _read_existing_material_id(text_path)
        if not material_id:
            continue
        material_ids.add(material_id)
        manifest_path = root / "evidence" / f"{material_id}.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        units = manifest.get("units")
        if not isinstance(units, list):
            continue
        evidence_ids.update(
            str(unit["id"])
            for unit in units
            if isinstance(unit, dict) and isinstance(unit.get("id"), str)
        )
    return material_ids, evidence_ids


def _user_learning_error(message: str, *, evidence_ready: bool) -> str:
    normalized = message.strip() or "学习失败"
    lowered = normalized.lower()
    if "timed out" in lowered or "timeout" in lowered or "超时" in normalized:
        reason = "知识整理等待超时" if evidence_ready else "读取资料超时"
    elif "余额不足" in normalized:
        reason = "学习服务余额不足"
    elif "no valid file" in lowered or "file block" in lowered or "输出无有效" in normalized:
        reason = "知识整理结果格式不完整"
    elif "unsupported generated" in lowered or "unassessed generated" in lowered:
        reason = "知识整理结果未通过来源核对"
    else:
        reason = (
            normalized.replace("LLM", "学习服务")
            .replace("FILE block", "知识页面")
            .replace("batch", "部分")
            .replace("批次", "部分")
            .replace("编译", "知识整理")
            .replace("evidence verifier", "来源核对")
        )
    if evidence_ready:
        return f"原文已可检索；{reason}，可重新学习继续整理"
    return reason


def _record_error(root: Path, document_id: str, message: str) -> None:
    state = _read_state(root)
    record = _find_record(state, document_id)
    if record is None:
        return
    failed_phase = record.get("phase")
    evidence_ready = _has_complete_evidence(root, record)
    public_error = _user_learning_error(message, evidence_ready=evidence_ready)
    record.update(
        phase="failed",
        error=public_error[:500],
        message="学习失败",
        evidenceReady=evidence_ready,
        progress=_progress_for_phase(
            "failed", evidence_ready=evidence_ready, detail=public_error
        ),
        resumeFrom="compiling" if failed_phase == "compiling" else None,
        updatedAt=_now(),
    )
    _write_state(root, state)


def _record_phase(
    root: Path,
    document_id: str,
    phase: str,
    *,
    message: str,
) -> dict[str, Any] | None:
    state = _read_state(root)
    record = _find_record(state, document_id)
    if record is None or not record.get("active", True):
        return None
    evidence_ready = (
        phase in {"compiling", "ready"}
        or (phase != "extracting" and _has_complete_evidence(root, record))
    )
    record.update(
        phase=phase,
        message=message,
        error=None,
        evidenceReady=evidence_ready,
        progress=_progress_for_phase(
            phase, evidence_ready=evidence_ready, detail=message
        ),
        updatedAt=_now(),
    )
    if phase in {"extracting", "ready"}:
        record["resumeFrom"] = None
    _write_state(root, state)
    return dict(record)


def _record_compile_progress(
    root: Path,
    document_id: str,
    snapshot: dict[str, Any],
) -> None:
    state = _read_state(root)
    record = _find_record(state, document_id)
    if record is None or record.get("phase") != "compiling":
        return
    coverage = snapshot.get("coverage") or {}
    completed = int(coverage.get("processedBatches") or 0)
    total = int(coverage.get("totalBatches") or 0)
    current = int(coverage.get("currentBatch") or 0)
    attempt = int(coverage.get("currentAttempt") or 0)
    if total > 0:
        detail = (
            f"原文已可检索，正在重新整理第 {current}/{total} 部分"
            if current > completed and attempt > 1
            else f"原文已可检索，正在整理第 {current}/{total} 部分"
            if current > completed
            else f"原文已可检索，已整理 {completed}/{total} 部分"
        )
        percent = 50 + round(45 * min(completed, total) / total)
    else:
        detail = "原文已可检索，正在准备整理重点和关联"
        percent = 50
    progress = {
        "stage": "organizing",
        "label": "正在整理知识",
        "detail": detail,
        "completed": completed,
        "total": total,
        "percent": percent,
        "evidenceReady": True,
    }
    if record.get("progress") == progress:
        return
    record.update(
        message=detail,
        evidenceReady=True,
        progress=progress,
        updatedAt=_now(),
    )
    _write_state(root, state)


async def _run_learning(agent_id: str, document_id: str) -> None:
    root = get_agent_knowledge_dir(agent_id)
    lock = _AGENT_PIPELINE_LOCKS.setdefault(agent_id, asyncio.Lock())
    async with lock:
        state = _read_state(root)
        current = _find_record(state, document_id)
        if current is None or not current.get("active", True):
            return
        raw_rel = str(current["path"])
        try:
            text_path = _text_path_for_raw(raw_rel, root)
            status = _read_text_status(
                text_path,
                vault=get_data_dir(),
                raw_rel=raw_rel,
                raw_path=root / "raw" / raw_rel,
            )
            can_resume_compile = (
                current.get("resumeFrom") == "compiling"
                and status.get("status") == "ok"
            )
            if not can_resume_compile:
                if _record_phase(
                    root,
                    document_id,
                    "extracting",
                    message="正在读取资料",
                ) is None:
                    return
                extract_error = await _extract_one(get_data_dir(), root, raw_rel)
                if extract_error:
                    raise RuntimeError(extract_error)
                status = _read_text_status(
                    text_path,
                    vault=get_data_dir(),
                    raw_rel=raw_rel,
                    raw_path=root / "raw" / raw_rel,
                )
                if status.get("status") != "ok":
                    raise RuntimeError(str(status.get("error") or "资料解析失败"))

            if _record_phase(
                root,
                document_id,
                "compiling",
                message="正在整理知识",
            ) is None:
                return
            compile_task = await start_compile_at(
                [raw_rel],
                vault=get_data_dir(),
                root=root,
                scope_id=f"agent:{agent_id}",
                require_complete_evidence=True,
            )
            if compile_task.asyncio_task is not None:
                while not compile_task.asyncio_task.done():
                    _record_compile_progress(
                        root, document_id, compile_task.snapshot()
                    )
                    await asyncio.wait(
                        {compile_task.asyncio_task}, timeout=0.75
                    )
                await compile_task.asyncio_task
            _record_compile_progress(root, document_id, compile_task.snapshot())
            coverage_complete = (
                compile_task.total_segments > 0
                and compile_task.processed_segments == compile_task.total_segments
                and compile_task.failed_batches == 0
                and not compile_task.missing_segments
            )
            if compile_task.state != "done" or not coverage_complete:
                details = compile_task.errors or compile_task.warnings
                raise RuntimeError(details[0] if details else "知识整理未完整完成")

            _record_phase(root, document_id, "ready", message="")
        except Exception as exc:
            logger.exception("Agent knowledge learning failed for {} / {}", agent_id, document_id)
            _record_error(root, document_id, str(exc) or "学习失败")
        finally:
            _LEARNING_TASKS.pop((agent_id, document_id), None)


def _schedule(agent_id: str, document_id: str) -> None:
    key = (agent_id, document_id)
    current = _LEARNING_TASKS.get(key)
    if current is not None and not current.done():
        return
    _LEARNING_TASKS[key] = asyncio.create_task(_run_learning(agent_id, document_id))


def _register_paths(agent_id: str, root: Path, paths: list[str]) -> list[dict[str, Any]]:
    state = _read_state(root)
    results: list[dict[str, Any]] = []
    raw_root = root / "raw"
    now = _now()
    for value in paths:
        rel = _clean_rel(value.removeprefix("raw/"))
        raw_path = _ensure_within_domain(raw_root / rel, raw_root)
        if not raw_path.is_file():
            raise web.HTTPBadRequest(reason=f"资料不存在：{rel}")
        md5 = _hash_file(raw_path, "md5")
        sha256 = _hash_file(raw_path, "sha256")
        existing = next(
            (
                item
                for item in state["documents"]
                if isinstance(item, dict) and item.get("md5") == md5
            ),
            None,
        )
        if existing is not None and existing.get("sha256") != sha256:
            raise web.HTTPConflict(reason="文件内容校验冲突，未合并资料")
        if existing is not None and existing.get("active", True):
            existing_raw = root / "raw" / str(existing.get("path", ""))
            if existing_raw.is_file():
                if raw_path != existing_raw:
                    raw_path.unlink()
                results.append(existing)
                continue
        stat = raw_path.stat()
        if existing is None:
            existing = {
                "id": f"document-{uuid.uuid4()}",
                "createdAt": now,
            }
            state["documents"].append(existing)
        existing.update(
            name=raw_path.name,
            path=rel,
            size=stat.st_size,
            md5=md5,
            sha256=sha256,
            active=True,
            phase="queued",
            message="等待学习",
            error=None,
            evidenceReady=False,
            progress=_progress_for_phase(
                "queued", evidence_ready=False, detail="资料已加入学习队列"
            ),
            resumeFrom=None,
            updatedAt=now,
        )
        results.append(existing)
    _write_state(root, state)
    for record in results:
        if record.get("phase") == "queued":
            _schedule(agent_id, str(record["id"]))
    return results


async def handle_agent_knowledge_list(req: web.Request) -> web.Response:
    agent_id, root = _agent_context(req)
    state = ensure_agent_knowledge_state(agent_id)
    for record in state["documents"]:
        if record.get("active", True) and record.get("phase") == "queued":
            _schedule(agent_id, str(record["id"]))
    documents = [
        _public_record(root, record)
        for record in state["documents"]
        if isinstance(record, dict) and record.get("active", True)
    ]
    documents.sort(key=lambda item: str(item["updatedAt"]), reverse=True)
    return web.json_response({"documents": documents})


def _wiki_graph_key(value: str) -> str:
    normalized = value.strip().replace("\\", "/")
    if normalized.startswith("wiki/"):
        normalized = normalized[5:]
    if normalized.endswith(".md"):
        normalized = normalized[:-3]
    return normalized.strip("/").casefold()


def _frontmatter_strings(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if not isinstance(value, str):
        return []
    text = value.strip()
    if text.startswith("[") and text.endswith("]"):
        return [item.strip().strip('"').strip("'") for item in text[1:-1].split(",") if item.strip()]
    return [text] if text else []


def _build_agent_knowledge_graph(root: Path) -> dict[str, Any]:
    wiki_root = root / "wiki"
    pages: list[dict[str, Any]] = []
    if wiki_root.exists():
        for page in sorted(wiki_root.rglob("*.md")):
            try:
                content = page.read_text(encoding="utf-8")
                frontmatter, body = _parse_frontmatter(content)
            except OSError:
                continue
            rel = page.relative_to(wiki_root).as_posix()
            pages.append(
                {
                    "id": str(frontmatter.get("id") or f"wiki-{rel}"),
                    "title": str(frontmatter.get("title") or page.stem),
                    "path": rel,
                    "aliases": _frontmatter_strings(frontmatter.get("aliases")),
                    "noteType": str(frontmatter.get("type") or "wiki"),
                    "sourceKind": "wiki",
                    "body": body,
                }
            )

    lookup: dict[str, str | None] = {}

    def register(value: str, page_id: str) -> None:
        key = _wiki_graph_key(value)
        if not key:
            return
        if key not in lookup:
            lookup[key] = page_id
        elif lookup[key] != page_id:
            lookup[key] = None

    for page in pages:
        rel = str(page["path"])
        register(rel, page["id"])
        register(Path(rel).stem, page["id"])
        register(str(page["title"]), page["id"])
        for alias in page["aliases"]:
            register(alias, page["id"])

    edges: list[dict[str, Any]] = []
    seen_edges: set[tuple[str, str, str, str | None]] = set()
    for page in pages:
        for match in _WIKI_LINK_PATTERN.finditer(str(page["body"])):
            target = match.group(2).split("|", 1)[0].strip()
            target_path, separator, anchor = target.partition("#")
            if target_path.casefold().startswith("evidence:"):
                continue
            resolved = lookup.get(_wiki_graph_key(target_path))
            kind = "embed" if match.group(1) else "link"
            edge_key = (str(page["id"]), target_path, kind, anchor or None)
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            edges.append(
                {
                    "source": page["id"],
                    "targetTitle": target_path,
                    "resolvedTarget": resolved,
                    "kind": kind,
                    "anchor": anchor if separator else None,
                }
            )

    return {
        "nodes": [{key: value for key, value in page.items() if key != "body"} for page in pages],
        "edges": edges,
        "positions": {},
        "lastScanAt": _now(),
    }


async def handle_agent_knowledge_graph(req: web.Request) -> web.Response:
    _, root = _agent_context(req)
    return web.json_response(_build_agent_knowledge_graph(root))


async def handle_agent_knowledge_add(req: web.Request) -> web.Response:
    agent_id, root = _agent_context(req)
    body = await req.json()
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        raise web.HTTPBadRequest(reason="paths is required")
    records = _register_paths(agent_id, root, [str(path) for path in paths])
    return web.json_response(
        {"documents": [_public_record(root, record) for record in records]},
        status=202,
    )


async def handle_agent_knowledge_retry(req: web.Request) -> web.Response:
    agent_id, root = _agent_context(req)
    document_id = req.match_info.get("document_id", "")
    key = (agent_id, document_id)
    running = _LEARNING_TASKS.get(key)
    if running is not None and not running.done():
        running.cancel()
        try:
            await running
        except asyncio.CancelledError:
            pass
    _LEARNING_TASKS.pop(key, None)

    lock = _AGENT_PIPELINE_LOCKS.setdefault(agent_id, asyncio.Lock())
    async with lock:
        state = _read_state(root)
        record = _find_record(state, document_id)
        if record is None or not record.get("active", True):
            raise web.HTTPNotFound(reason="资料不存在")
        evidence_ready = _has_complete_evidence(root, record)
        record.update(
            phase="queued",
            message="等待重新学习",
            error=None,
            evidenceReady=evidence_ready,
            progress=_progress_for_phase(
                "queued",
                evidence_ready=evidence_ready,
                detail=(
                    "原文已可检索，等待继续整理知识"
                    if evidence_ready
                    else "等待重新读取资料"
                ),
            ),
            resumeFrom="compiling" if evidence_ready else None,
            updatedAt=_now(),
        )
        _write_state(root, state)
    _schedule(agent_id, document_id)
    return web.json_response({"document": _public_record(root, record)}, status=202)


def _archive_file(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, destination)


def _remove_under_lock(
    root: Path,
    state: dict[str, Any],
    record: dict[str, Any],
) -> list[str]:
    document_id = str(record["id"])
    raw_rel = str(record["path"])
    text_path = _text_path_for_raw(raw_rel, root)
    material_id = _read_existing_material_id(text_path)
    archive = root / "archive" / document_id
    _archive_file(root / "raw" / raw_rel, archive / "raw" / raw_rel)
    _archive_file(text_path, archive / "text" / f"{raw_rel}.md")
    if material_id:
        _archive_file(
            root / "evidence" / f"{material_id}.json",
            archive / "evidence" / f"{material_id}.json",
        )
    source_hash = str(record.get("sha256") or "")[:16]
    if source_hash:
        _archive_file(
            root / "evidence" / "compilation" / source_hash,
            archive / "evidence" / "compilation" / source_hash,
        )

    affected = False
    wiki_root = root / "wiki"
    for page in list(wiki_root.rglob("*.md")):
        if page.name in {"index.md", "log.md"}:
            continue
        try:
            fm, _ = _parse_frontmatter(page.read_text(encoding="utf-8"))
        except OSError:
            continue
        sources = fm.get("sources")
        if isinstance(sources, str):
            sources = [sources]
        material_ids = fm.get("materialIds")
        if isinstance(material_ids, str):
            material_ids = [material_ids]
        if raw_rel in (sources or []) or (material_id and material_id in (material_ids or [])):
            page.unlink()
            affected = True

    record.update(active=False, removedAt=_now(), updatedAt=_now())
    recompile: list[str] = []
    if affected:
        _refresh_navigation_files(
            root,
            learned_sources=[],
            written_paths=[],
        )
        for item in state["documents"]:
            if not item.get("active", True) or item.get("phase") != "ready":
                continue
            item.update(
                phase="queued",
                message="正在更新知识",
                error=None,
                evidenceReady=True,
                progress=_progress_for_phase(
                    "queued",
                    evidence_ready=True,
                    detail="原文已可检索，等待更新知识关联",
                ),
                resumeFrom="compiling",
                updatedAt=_now(),
            )
            recompile.append(str(item["id"]))
    _write_state(root, state)
    sync_write_point(get_data_dir(), library_root=root, full=True)
    return recompile


async def handle_agent_knowledge_remove(req: web.Request) -> web.Response:
    agent_id, root = _agent_context(req)
    document_id = req.match_info.get("document_id", "")
    state = _read_state(root)
    record = _find_record(state, document_id)
    if record is None or not record.get("active", True):
        raise web.HTTPNotFound(reason="资料不存在")

    running = _LEARNING_TASKS.get((agent_id, document_id))
    if running is not None and not running.done():
        running.cancel()
        try:
            await running
        except asyncio.CancelledError:
            pass

    lock = _AGENT_PIPELINE_LOCKS.setdefault(agent_id, asyncio.Lock())
    async with lock:
        current_state = _read_state(root)
        current_record = _find_record(current_state, document_id)
        if current_record is None or not current_record.get("active", True):
            raise web.HTTPNotFound(reason="资料不存在")
        recompile = _remove_under_lock(root, current_state, current_record)
    for active_document_id in recompile:
        _schedule(agent_id, active_document_id)

    return web.json_response({"removed": document_id})


async def recover_agent_knowledge_tasks(_app: web.Application) -> None:
    """Resume persisted queued or interrupted tasks when Services starts."""
    agents_root = get_agents_dir()
    for agent_dir in agents_root.iterdir():
        state_file = agent_dir / "knowledge" / "state.json"
        if not (
            state_file.is_file()
            or (agent_dir / "config.json").is_file()
            or (agent_dir / "agent.json").is_file()
        ):
            continue
        try:
            agent_id = normalize_agent_id(agent_dir.name)
            root = get_agent_knowledge_dir(agent_id)
            state = await asyncio.to_thread(ensure_agent_knowledge_state, agent_id)
        except Exception:
            logger.exception("Failed to recover Agent knowledge state at {}", state_file)
            continue
        changed = False
        for record in state["documents"]:
            if not record.get("active", True):
                continue
            if record.get("phase") in {"queued", "extracting", "compiling"}:
                interrupted_phase = record.get("phase")
                evidence_ready = _has_complete_evidence(root, record)
                record.update(
                    phase="queued",
                    message="等待继续学习",
                    error=None,
                    evidenceReady=evidence_ready,
                    progress=_progress_for_phase(
                        "queued",
                        evidence_ready=evidence_ready,
                        detail=(
                            "原文已可检索，等待继续整理知识"
                            if evidence_ready
                            else "等待继续读取资料"
                        ),
                    ),
                    resumeFrom=(
                        "compiling"
                        if interrupted_phase == "compiling" and evidence_ready
                        else None
                    ),
                    updatedAt=_now(),
                )
                changed = True
        if changed:
            _write_state(root, state)
        for record in state["documents"]:
            if record.get("active", True) and record.get("phase") == "queued":
                _schedule(agent_id, str(record["id"]))


async def shutdown_agent_knowledge_tasks() -> None:
    tasks = [task for task in _LEARNING_TASKS.values() if not task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
