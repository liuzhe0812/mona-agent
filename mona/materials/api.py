"""HTTP API handlers for the materials module.

资料库 HTTP 接口：目录管理、文件上传、提取状态、Wiki 读写、搜索。
所有路径操作都限制在 `<vault>/.mona/materials/` 内，通过 canonical path 校验。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.config.paths import get_agent_knowledge_dir, get_data_dir
from mona.materials.catalog import (
    DEFAULT_LIBRARY_ID,
    create_library,
    get_library_root,
    list_libraries,
    remove_library,
    update_library,
    validate_library_id,
)
from mona.materials.frontmatter import _parse_frontmatter, _render_frontmatter
from mona.materials.index import sync_write_point
from mona.materials.vault import get_vault_path
from mona.utils.document import (
    EXTRACTOR_VERSION,
    SUPPORTED_EXTENSIONS,
    ExtractedSegment,
    extract_segments,
)

# 单文件大小上限：50 MB（与 document.py 的 _MAX_EXTRACT_FILE_SIZE 对齐）
MAX_FILE_SIZE = 50 * 1024 * 1024

# 不支持的格式（明确提示用户，不静默失败）
UNSUPPORTED_EXTENSIONS = {".doc", ".xls"}

# 提取任务超时（秒）
EXTRACT_TIMEOUT = 120

# 后台提取任务表：vault 下再以物理知识根目录和相对路径共同隔离任务。
# 进程内状态，重启后由 reconciliation 恢复未完成的提取。
_EXTRACT_TASKS: dict[Path, dict[str, dict[str, Any]]] = {}


def _require_vault() -> Path:
    """获取 vault 路径，未配置则抛出 HTTP 400。"""
    vault = get_vault_path()
    if vault is None:
        raise web.HTTPBadRequest(reason="Notes vault not configured")
    return vault


def _materials_root(vault: Path, library_id: str | None = None) -> Path:
    """返回一个知识库的数据根目录，缺省为迁移后的默认知识库。"""
    return get_library_root(vault, library_id or DEFAULT_LIBRARY_ID)


def _request_library_id(req: web.Request) -> str:
    query = getattr(req, "query", None)
    value = query.get("knowledgeBaseId", DEFAULT_LIBRARY_ID) if hasattr(query, "get") else DEFAULT_LIBRARY_ID
    if not isinstance(value, str):
        value = DEFAULT_LIBRARY_ID
    try:
        return validate_library_id(value)
    except ValueError as exc:
        raise web.HTTPBadRequest(reason=str(exc)) from exc


def _request_materials_root(req: web.Request, vault: Path) -> Path:
    try:
        return _materials_root(vault, _request_library_id(req))
    except KeyError as exc:
        raise web.HTTPNotFound(reason=str(exc)) from exc


def _request_materials_context(req: web.Request) -> tuple[Path, Path]:
    """Resolve either legacy library storage or one Agent's private Wiki."""
    value = req.query.get("agentId", "")
    agent_id = value.strip() if isinstance(value, str) else ""
    if agent_id:
        from mona.agent.partners import normalize_agent_id

        try:
            normalized = normalize_agent_id(agent_id)
        except ValueError as exc:
            raise web.HTTPBadRequest(reason="invalid Agent id") from exc
        return get_data_dir(), get_agent_knowledge_dir(normalized)
    vault = _require_vault()
    return vault, _request_materials_root(req, vault)


def _archived_path(root: Path, domain: str, rel: str) -> Path | None:
    """Resolve a removed Agent source for historical citation preview only."""
    state_path = root / "state.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    documents = state.get("documents") if isinstance(state, dict) else None
    if not isinstance(documents, list):
        return None
    archive_root = root / "archive"
    for record in documents:
        if not isinstance(record, dict) or record.get("active", True):
            continue
        document_id = str(record.get("id", ""))
        if not re.fullmatch(r"document-[A-Za-z0-9-]+", document_id):
            continue
        candidate = archive_root / document_id / domain / rel
        try:
            resolved = candidate.resolve()
            resolved.relative_to(archive_root.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return resolved
    return None


def _ensure_within_materials(path: Path, materials_root: Path) -> Path:
    """canonical path 校验，确保路径在 materials_root 内。"""
    resolved = path.resolve()
    root_resolved = materials_root.resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise web.HTTPBadRequest(reason="Path escapes materials directory") from exc
    return resolved


def _clean_rel(rel: str) -> str:
    """清洗相对路径输入：拒绝绝对路径、`..` 分段和空路径。

    所有 handler 在拼接路径前必须先过此函数，作为 canonical 校验之外的
    第一道防线（P0-6）。
    """
    cleaned = rel.strip().strip("/").replace("\\", "/")
    if not cleaned:
        raise web.HTTPBadRequest(reason="path is required")
    parts = cleaned.split("/")
    if any(part in ("..", "") for part in parts):
        raise web.HTTPBadRequest(reason="Invalid path")
    if ":" in parts[0] or cleaned.startswith("~"):
        raise web.HTTPBadRequest(reason="Absolute paths are not allowed")
    return cleaned


def _ensure_within_domain(path: Path, domain_root: Path) -> Path:
    """canonical path 校验，确保路径在指定数据域（raw/text/wiki）根内。"""
    resolved = path.resolve()
    root_resolved = domain_root.resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise web.HTTPBadRequest(reason="Path escapes domain directory") from exc
    return resolved


def _relative_to_materials(path: Path, materials_root: Path) -> str:
    """返回相对 materials_root 的 POSIX 路径。"""
    return str(path.resolve().relative_to(materials_root.resolve())).replace("\\", "/")


def _text_path_for_raw(raw_rel_path: str, materials_root: Path) -> Path:
    """根据 raw/ 下的相对路径推导对应的 text/ 路径。

    规则：`raw/<rel>.<ext>` → `text/<rel>.<ext>.md`
    """
    return materials_root / "text" / f"{raw_rel_path}.md"


def _is_supported(filename: str) -> tuple[bool, str | None]:
    """检查文件是否支持，返回 (supported, reason)。

    reason 为 None 表示支持，否则为不支持原因。
    """
    ext = Path(filename).suffix.lower()
    if ext in UNSUPPORTED_EXTENSIONS:
        return False, f"格式 {ext} 暂不支持，建议转换为 .docx / .xlsx 后再上传"
    if ext not in SUPPORTED_EXTENSIONS:
        return False, f"格式 {ext} 不在支持列表中"
    return True, None


def _sha256_of(path: Path) -> str:
    """流式计算文件 sha256。"""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write_text(path: Path, content: str) -> None:
    """先写临时文件再原子替换，避免半完成状态。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _evidence_id(
    *,
    material_id: str,
    source_hash: str,
    segment: ExtractedSegment,
) -> str:
    payload = json.dumps(
        {
            "materialId": material_id,
            "sourceHash": source_hash,
            "kind": segment.kind,
            "label": segment.label,
            "meta": segment.meta,
            "textHash": hashlib.sha256(segment.text.encode("utf-8")).hexdigest(),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "ev-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _write_evidence_manifest(
    materials_root: Path,
    *,
    material_id: str,
    source_rel: str,
    source_hash: str,
    segments: list[ExtractedSegment],
) -> None:
    units: list[dict[str, Any]] = []
    for segment in segments:
        if not segment.text.strip():
            continue
        units.append(
            {
                "id": _evidence_id(
                    material_id=material_id,
                    source_hash=source_hash,
                    segment=segment,
                ),
                "kind": segment.kind,
                "label": segment.label,
                "location": segment.meta,
                "textHash": hashlib.sha256(segment.text.encode("utf-8")).hexdigest(),
                "status": "uncovered",
                "wikiRefs": [],
            }
        )
    manifest = {
        "schemaVersion": 1,
        "materialId": material_id,
        "source": source_rel,
        "sourceHash": source_hash,
        "units": units,
    }
    path = materials_root / "evidence" / f"{material_id}.json"
    _atomic_write_text(
        path,
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )


def _write_uncovered_evidence_manifest(
    materials_root: Path,
    *,
    material_id: str,
    source_rel: str,
    source_hash: str,
    kind: str,
    reason: str,
) -> None:
    unit_id = "ev-" + hashlib.sha256(
        f"{material_id}\0{source_hash}\0{kind}\0{reason}".encode("utf-8")
    ).hexdigest()[:32]
    manifest = {
        "schemaVersion": 1,
        "materialId": material_id,
        "source": source_rel,
        "sourceHash": source_hash,
        "units": [
            {
                "id": unit_id,
                "kind": kind,
                "label": Path(source_rel).name,
                "location": {},
                "textHash": "",
                "status": "uncovered",
                "reason": reason,
                "wikiRefs": [],
            }
        ],
    }
    _atomic_write_text(
        materials_root / "evidence" / f"{material_id}.json",
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )


def _read_existing_material_id(text_path: Path) -> str | None:
    """读取已有 text/ 文件的 material ID（重新提取时保留稳定身份）。"""
    try:
        content = text_path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, _ = _parse_frontmatter(content)
    material_id = fm.get("id")
    if isinstance(material_id, str) and material_id.startswith("material-"):
        return material_id
    return None


def _render_text_document(
    segments: list[ExtractedSegment],
    *,
    material_id: str,
    source_rel: str,
    sha256: str,
    size: int,
    mtime_ns: int,
    status: str = "ok",
) -> str:
    """渲染 text/ markdown：frontmatter 元数据 + 带位置标记的 segments。"""
    extension = Path(source_rel).suffix.lower()
    base_fidelity = {
        ".pdf": "text_only",
        ".docx": "paragraphs_only",
        ".pptx": "visible_text_only",
        ".xlsx": "cell_values",
    }.get(extension, "full_text")
    extraction_fidelity = (
        "text_and_visual"
        if any(segment.kind == "visual" for segment in segments)
        else base_fidelity
    )
    fm = _render_frontmatter({
        "id": material_id,
        "source": source_rel,
        "sha256": sha256,
        "size": size,
        "mtimeNs": mtime_ns,
        "extractorVersion": EXTRACTOR_VERSION,
        "extractionFidelity": extraction_fidelity,
        "status": status,
        "truncated": "false",
        "extractedAt": datetime.now().isoformat(timespec="seconds"),
    })
    parts: list[str] = [fm]
    for seg in segments:
        marker = {
            "id": _evidence_id(
                material_id=material_id,
                source_hash=sha256,
                segment=seg,
            ),
            "kind": seg.kind,
            "label": seg.label,
            **seg.meta,
        }
        parts.append(f"<!-- seg {json.dumps(marker, ensure_ascii=False)} -->")
        parts.append(f"## {seg.label}")
        parts.append("")
        parts.append(seg.text)
        parts.append("")
    return "\n".join(parts)


def _read_raw_freshness(raw_path: Path) -> tuple[str, int, int] | None:
    """返回 (sha256, size, mtimeNs)，文件缺失时返回 None。"""
    try:
        stat = raw_path.stat()
    except OSError:
        return None
    return _sha256_of(raw_path), stat.st_size, stat.st_mtime_ns


async def _extract_one(vault: Path, materials_root: Path, raw_rel_path: str) -> str | None:
    """提取单个文件并写入 text/（同步解析放到线程池执行）。

    产物 frontmatter 携带稳定 material ID、sha256、size、mtimeNs 和
    extractorVersion；失败时写入 error 状态文件。
    """
    raw_path = materials_root / "raw" / raw_rel_path
    text_path = _text_path_for_raw(raw_rel_path, materials_root)
    try:
        freshness = _read_raw_freshness(raw_path)
        if freshness is None:
            raise RuntimeError("file not found")
        sha256, size, _mtime_ns = freshness
        if size > MAX_FILE_SIZE:
            raise RuntimeError(
                f"文件超过 {MAX_FILE_SIZE // (1024 * 1024)} MB 大小限制，未提取"
            )

        material_id = _read_existing_material_id(text_path) or f"material-{uuid.uuid4()}"

        # extract_segments 是同步阻塞调用，放到线程池
        result = await asyncio.wait_for(
            asyncio.to_thread(extract_segments, raw_path),
            timeout=EXTRACT_TIMEOUT,
        )
        if result is None:
            raise RuntimeError("unsupported file type")
        if isinstance(result, str):
            raise RuntimeError(result)
        from mona.materials.vision import extract_visual_segments

        extraction_dir = materials_root / "evidence" / "extraction" / sha256
        _atomic_write_text(
            extraction_dir / "text.md",
            _render_text_document(
                result, material_id=material_id, source_rel=raw_rel_path,
                sha256=sha256, size=size, mtime_ns=_mtime_ns, status="partial",
            ),
        )
        visual_segments = await extract_visual_segments(
            raw_path, cache_dir=extraction_dir / "visual",
        )
        result = [*result, *visual_segments]
        if not result or all(not seg.text.strip() for seg in result):
            _write_uncovered_evidence_manifest(
                materials_root,
                material_id=material_id,
                source_rel=raw_rel_path,
                source_hash=sha256,
                kind="document",
                reason="no text extracted; OCR may be required",
            )
            raise RuntimeError("未能提取到文本，可能是扫描件，需要 OCR")

        document = _render_text_document(
            result,
            material_id=material_id,
            source_rel=raw_rel_path,
            sha256=sha256,
            size=size,
            mtime_ns=_mtime_ns,
        )
        _atomic_write_text(text_path, document)
        _write_evidence_manifest(
            materials_root,
            material_id=material_id,
            source_rel=raw_rel_path,
            source_hash=sha256,
            segments=result,
        )
        sync_write_point(vault, library_root=materials_root, text_files=[text_path])
        logger.info("materials: extracted {}", raw_rel_path)
        return None
    except asyncio.TimeoutError:
        _mark_text_error(text_path, raw_rel_path, "提取超时")
        logger.warning("materials: extract timeout {}", raw_rel_path)
        return "提取超时"
    except Exception as e:
        _mark_text_error(text_path, raw_rel_path, str(e))
        logger.exception("materials: extract failed {}", raw_rel_path)
        return str(e) or "资料解析失败"


async def _extract_in_background(
    vault: Path, materials_root: Path, raw_rel_path: str
) -> None:
    """调度后台提取任务（同一路径去重）。"""
    task_key = f"{materials_root.resolve()}\0{raw_rel_path}"
    tasks_for_vault = _EXTRACT_TASKS.setdefault(vault, {})
    existing = tasks_for_vault.get(task_key)
    if existing is not None and not existing["task"].done():
        return  # 已有任务在跑

    entry: dict[str, Any] = {"state": "queued", "task": None}

    async def _run() -> None:
        entry["state"] = "running"
        try:
            await _extract_one(vault, materials_root, raw_rel_path)
        finally:
            tasks_for_vault.pop(task_key, None)

    entry["task"] = asyncio.create_task(_run())
    tasks_for_vault[task_key] = entry


def _mark_text_error(text_path: Path, source_rel: str, error: str) -> None:
    """写入提取失败标记（保留已有 material ID，原子写入）。

    标记写入本身失败（如磁盘错误）时只记录日志——不覆盖已有完整文件，
    也不让后台任务因二次异常崩溃。
    """
    if text_path.exists():
        try:
            existing_fm, _ = _parse_frontmatter(text_path.read_text(encoding="utf-8"))
        except OSError:
            existing_fm = {}
        if existing_fm.get("status") == "ok":
            # A failed re-read must not destroy the last complete evidence layer.
            return
    material_id = _read_existing_material_id(text_path) or f"material-{uuid.uuid4()}"
    fm = _render_frontmatter({
        "id": material_id,
        "source": source_rel,
        "extractorVersion": EXTRACTOR_VERSION,
        "status": "error",
        "error": error,
        "extractedAt": datetime.now().isoformat(timespec="seconds"),
    })
    try:
        _atomic_write_text(text_path, fm)
    except OSError:
        logger.warning("materials: failed to write error marker for {}", source_rel)


def _is_fresh(fm: dict[str, Any], raw_path: Path) -> bool:
    """快速新鲜度判断：size + mtimeNs 与 frontmatter 记录一致。"""
    try:
        stat = raw_path.stat()
    except OSError:
        return False
    try:
        return (
            int(fm.get("size", -1)) == stat.st_size
            and int(fm.get("mtimeNs", -1)) == stat.st_mtime_ns
            and int(fm.get("extractorVersion", 0)) == EXTRACTOR_VERSION
        )
    except (TypeError, ValueError):
        return False


def _read_text_status(
    text_path: Path,
    vault: Path | None = None,
    raw_rel: str | None = None,
    raw_path: Path | None = None,
) -> dict[str, Any]:
    """读取 text/ 文件状态：queued/running/ok/error/unsupported/stale。"""
    if not text_path.exists():
        if raw_rel is not None and raw_path is not None:
            root = raw_path
            for _ in Path(raw_rel).parts:
                root = root.parent
            task_key = f"{root.parent.resolve()}\0{raw_rel}"
            tasks = _EXTRACT_TASKS.get(vault, {}) if vault is not None else {}
            entry = tasks.get(task_key) or tasks.get(raw_rel)
            if entry is not None and not entry["task"].done():
                return {"status": entry["state"]}
        return {"status": "queued"}
    try:
        content = text_path.read_text(encoding="utf-8")
    except Exception:
        return {"status": "error", "error": "无法读取提取结果"}

    fm, body = _parse_frontmatter(content)
    fm_status = fm.get("status")
    if fm_status == "unsupported":
        return {"status": "unsupported"}
    if fm_status == "error" or "error" in fm:
        return {"status": "error", "error": fm.get("error", "提取失败")}
    if raw_path is not None and not _is_fresh(fm, raw_path):
        return {"status": "stale"}
    return {"status": "ok", "chars": len(body)}


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


def _wiki_ingest_states(root: Path) -> dict[str, str]:
    """返回 raw 相对路径对应的入库状态。"""
    refs: dict[str, dict[str, Any]] = {}
    wiki_root = root / "wiki"
    if not wiki_root.exists():
        return {}
    for page in wiki_root.rglob("*.md"):
        try:
            fm, _ = _parse_frontmatter(page.read_text(encoding="utf-8"))
        except OSError:
            continue
        sources = fm.get("sources")
        if not isinstance(sources, list):
            continue
        hashes = fm.get("sourceHashes")
        hashes = set(hashes) if isinstance(hashes, list) else set()
        for source in sources:
            if not isinstance(source, str):
                continue
            raw_rel = source.replace("\\", "/").removeprefix("raw/")
            if not raw_rel:
                continue
            ref = refs.setdefault(raw_rel, {"hashes": set(), "stale": False})
            ref["hashes"].update(hashes)
            ref["stale"] = ref["stale"] or fm.get("stale") is True

    states: dict[str, str] = {}
    for raw_rel, ref in refs.items():
        state = "stale" if ref["stale"] else "ingested"
        text_path = _text_path_for_raw(raw_rel, root)
        try:
            text_fm, _ = _parse_frontmatter(text_path.read_text(encoding="utf-8"))
        except OSError:
            text_fm = {}
        current_hash = text_fm.get("sha256")
        if current_hash and ref["hashes"] and current_hash not in ref["hashes"]:
            state = "stale"
        states[raw_rel] = state
    return states


async def handle_materials_list_libraries(_req: web.Request) -> web.Response:
    vault = _require_vault()
    return web.json_response({"libraries": list_libraries(vault)})


async def handle_materials_create_library(req: web.Request) -> web.Response:
    vault = _require_vault()
    body = await req.json()
    try:
        library = create_library(
            vault,
            str(body.get("name", "")),
            str(body.get("description", "")),
        )
    except ValueError as exc:
        raise web.HTTPBadRequest(reason=str(exc)) from exc
    return web.json_response({"library": library}, status=201)


async def handle_materials_update_library(req: web.Request) -> web.Response:
    vault = _require_vault()
    body = await req.json()
    try:
        library = update_library(
            vault,
            req.match_info.get("library_id", ""),
            name=body.get("name"),
            description=body.get("description"),
        )
    except KeyError as exc:
        raise web.HTTPNotFound(reason=str(exc)) from exc
    except ValueError as exc:
        raise web.HTTPBadRequest(reason=str(exc)) from exc
    return web.json_response({"library": library})


async def handle_materials_delete_library(req: web.Request) -> web.Response:
    vault = _require_vault()
    try:
        target = remove_library(vault, req.match_info.get("library_id", ""))
    except KeyError as exc:
        raise web.HTTPNotFound(reason=str(exc)) from exc
    except ValueError as exc:
        raise web.HTTPBadRequest(reason=str(exc)) from exc
    shutil.rmtree(target, ignore_errors=False)
    affected_agents: list[str] = []
    from mona.agent.user_config import load_agent_user_config, save_agent_user_config
    from mona.config.paths import get_agents_dir

    for agent_dir in get_agents_dir().iterdir():
        if not agent_dir.is_dir() or not (agent_dir / "config.json").is_file():
            continue
        config = load_agent_user_config(agent_dir.name)
        scope = config.knowledge_base_scope
        if scope.mode != "specific" or target.name not in scope.knowledge_base_ids:
            continue
        save_agent_user_config(
            agent_dir.name,
            {
                "knowledge_base_scope": {
                    "mode": "specific",
                    "knowledge_base_ids": [
                        value for value in scope.knowledge_base_ids if value != target.name
                    ],
                }
            },
            expected_revision=None,
        )
        affected_agents.append(agent_dir.name)
    return web.json_response({"deleted": target.name, "affectedAgents": affected_agents})


async def handle_materials_list_files(req: web.Request) -> web.Response:
    """GET /api/materials/files — 递归列出 raw/ 下的文件和目录树。

    查询参数：
      - subdir: 可选，相对于 raw/ 的子目录，默认为空（列根目录）
    """
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    subdir = req.query.get("subdir", "").strip()
    target = raw_root
    if subdir:
        target = _ensure_within_domain(raw_root / _clean_rel(subdir), raw_root)

    if not target.exists():
        return web.json_response({"entries": []})

    ingest_states = _wiki_ingest_states(root)
    entries: list[dict[str, Any]] = []
    for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        rel = _relative_to_materials(child, root)
        if child.is_dir():
            # 计算目录下文件数
            file_count = sum(1 for _ in child.rglob("*") if _.is_file())
            entries.append({
                "name": child.name,
                "path": rel,
                "type": "directory",
                "fileCount": file_count,
            })
        else:
            raw_rel = _relative_to_materials(child, (root / "raw"))
            text_path = _text_path_for_raw(raw_rel, root)
            status = _read_text_status(
                text_path, vault=vault, raw_rel=raw_rel, raw_path=child
            )
            stat = child.stat()
            entries.append({
                "name": child.name,
                "path": rel,
                "type": "file",
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
                "extractStatus": status,
                "ingestStatus": ingest_states.get(raw_rel, "not_ingested"),
            })

    return web.json_response({"entries": entries})


async def handle_materials_create_directory(req: web.Request) -> web.Response:
    """POST /api/materials/directory — 在 raw/ 下创建目录。

    Body: { "path": "relative/path" }
    """
    vault, root = _request_materials_context(req)
    body = await req.json()
    rel = _clean_rel(body.get("path", ""))
    raw_root = root / "raw"
    target = _ensure_within_domain(raw_root / rel, raw_root)
    target.mkdir(parents=True, exist_ok=True)
    return web.json_response({"path": _relative_to_materials(target, root)})


async def handle_materials_delete(req: web.Request) -> web.Response:
    """DELETE /api/materials/files/{path:.*} — 删除 raw/ 下的文件或目录，同步删除 text/ 对应文件。"""
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    rel = _clean_rel(req.match_info.get("path", ""))

    raw_target = _ensure_within_domain(raw_root / rel, raw_root)
    if not raw_target.exists():
        raise web.HTTPNotFound(reason="path not found")

    # text 侧对应路径：文件 -> `<rel>.md`；目录 -> 同名子树
    text_target = root / "text" / (f"{rel}.md" if raw_target.is_file() else rel)

    # 删除前收集受影响 text 文件的 material ID，用于索引同步清理
    removed_ids: list[str] = []
    text_mds: list[Path] = []
    if text_target.is_file():
        text_mds.append(text_target)
    elif text_target.is_dir():
        text_mds.extend(text_target.rglob("*.md"))
    for md in text_mds:
        mid = _read_existing_material_id(md)
        if mid:
            removed_ids.append(mid)

    # 先删 raw（失败则整体未变），再同步删除 text；text 删除失败留下的
    # 孤儿文件由 reconciliation 兜底清理。
    if raw_target.is_file():
        raw_target.unlink()
    else:
        shutil.rmtree(raw_target)

    if text_target.exists():
        try:
            if text_target.is_file():
                text_target.unlink()
            else:
                shutil.rmtree(text_target)
        except OSError:
            logger.warning("materials: text cleanup incomplete for {}", rel)

    if removed_ids:
        for material_id in removed_ids:
            manifest = root / "evidence" / f"{material_id}.json"
            if manifest.exists():
                manifest.unlink()
        sync_write_point(vault, library_root=root, removed_ids=removed_ids)

    return web.json_response({"deleted": rel})


def _rewrite_text_frontmatter_source(text_path: Path, new_source_rel: str) -> None:
    """移动后更新 text 文件的 source 字段（material ID 和其他元数据保持不变）。"""
    if not text_path.exists() or not text_path.is_file():
        return
    try:
        content = text_path.read_text(encoding="utf-8")
    except OSError:
        return
    if not content.startswith("---"):
        return
    end = content.find("\n---", 3)
    if end == -1:
        return
    fm_text = content[3:end]
    new_lines: list[str] = []
    replaced = False
    for line in fm_text.split("\n"):
        if line.strip().startswith("source:"):
            new_lines.append(f"source: {new_source_rel}")
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        new_lines.append(f"source: {new_source_rel}")
    _atomic_write_text(text_path, "---" + "\n".join(new_lines) + content[end:])


def _rewrite_evidence_manifest_source(
    root: Path, text_path: Path, new_source_rel: str
) -> None:
    material_id = _read_existing_material_id(text_path)
    if not material_id:
        return
    manifest_path = root / "evidence" / f"{material_id}.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    manifest["source"] = new_source_rel
    _atomic_write_text(
        manifest_path,
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )


async def handle_materials_move(req: web.Request) -> web.Response:
    """POST /api/materials/move — 移动 raw/ 下的文件或目录，同步移动 text/ 对应文件。

    Body: { "source": "relative/path", "targetDir": "relative/dir" }
    targetDir 为空字符串表示移到 raw/ 根目录。
    """
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    body = await req.json()
    source_rel = _clean_rel(body.get("source", ""))
    target_dir_raw = body.get("targetDir", "").strip().strip("/")
    target_dir = _clean_rel(target_dir_raw) if target_dir_raw else ""
    if target_dir and source_rel == target_dir:
        raise web.HTTPBadRequest(reason="source and targetDir must differ")

    src = _ensure_within_domain(raw_root / source_rel, raw_root)
    if not src.exists():
        raise web.HTTPNotFound(reason="source not found")

    target_dir_path = _ensure_within_domain(
        raw_root / target_dir if target_dir else raw_root, raw_root
    )
    target_dir_path.mkdir(parents=True, exist_ok=True)

    dst = _ensure_within_domain(target_dir_path / src.name, raw_root)
    # src 和 dst 相同：无需移动
    if dst == src:
        return web.json_response({
            "source": source_rel,
            "target": _relative_to_materials(dst, root),
        })
    # 目标已存在则报错
    if dst.exists():
        raise web.HTTPBadRequest(reason="target already exists")

    # 移动前记录类型与 text 侧路径（P0-5：移动后 src 不复存在，无法再判断）
    src_is_file = src.is_file()
    old_text = root / "text" / (f"{source_rel}.md" if src_is_file else source_rel)
    new_rel = str(dst.relative_to(raw_root)).replace("\\", "/")
    new_text = root / "text" / (f"{new_rel}.md" if src_is_file else new_rel)

    # 移动 raw（用 shutil.move 确保跨卷移动也是真移动而非 copy），
    # 再同步移动 text；text 移动失败时回滚 raw，避免半完成状态。
    shutil.move(str(src), str(dst))
    moved_text_mds: list[Path] = []
    try:
        if old_text.exists():
            new_text.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_text), str(new_text))
            # 更新 text frontmatter 的 source 路径（material ID 不变）
            if src_is_file:
                _rewrite_text_frontmatter_source(new_text, new_rel)
                _rewrite_evidence_manifest_source(root, new_text, new_rel)
                moved_text_mds.append(new_text)
            else:
                for moved_md in new_text.rglob("*.md"):
                    old_source_rel = str(
                        moved_md.relative_to(new_text)
                    ).replace("\\", "/")
                    if old_source_rel.endswith(".md"):
                        old_source_rel = old_source_rel[: -len(".md")]
                    _rewrite_text_frontmatter_source(
                        moved_md, f"{new_rel}/{old_source_rel}"
                    )
                    _rewrite_evidence_manifest_source(
                        root, moved_md, f"{new_rel}/{old_source_rel}"
                    )
                    moved_text_mds.append(moved_md)
    except OSError:
        shutil.move(str(dst), str(src))
        raise

    if moved_text_mds:
        sync_write_point(vault, library_root=root, text_files=moved_text_mds)

    return web.json_response({
        "source": source_rel,
        "target": _relative_to_materials(dst, root),
    })


async def handle_materials_extract(req: web.Request) -> web.Response:
    """POST /api/materials/extract — 触发后台提取 raw/ 下指定文件。

    Body: { "path": "relative/path" }  （path 可以是文件或目录）
    """
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    body = await req.json()
    rel = _clean_rel(body.get("path", ""))

    raw_target = _ensure_within_domain(raw_root / rel, raw_root)
    if not raw_target.exists():
        raise web.HTTPNotFound(reason="path not found")

    # 收集需要提取的文件列表
    files_to_extract: list[Path] = []
    if raw_target.is_file():
        files_to_extract.append(raw_target)
    else:
        files_to_extract.extend([p for p in raw_target.rglob("*") if p.is_file()])

    # 逐个触发后台提取
    for f in files_to_extract:
        raw_rel = _relative_to_materials(f, (root / "raw"))
        supported, reason = _is_supported(f.name)
        if not supported:
            # 直接写错误状态
            text_path = _text_path_for_raw(raw_rel, root)
            _mark_text_error(text_path, raw_rel, reason or "unsupported")
            continue
        await _extract_in_background(vault, root, raw_rel)

    return web.json_response({
        "queued": len(files_to_extract),
        "root": rel,
    })


async def handle_materials_get_text(req: web.Request) -> web.Response:
    """GET /api/materials/text/{path:.*} — 读取 text/ 下对应的提取文本。"""
    vault, root = _request_materials_context(req)
    text_root = root / "text"
    rel = _clean_rel(req.match_info.get("path", ""))

    text_path = _ensure_within_domain(text_root / rel, text_root)
    if not text_path.exists() or not text_path.is_file():
        text_path = _archived_path(root, "text", rel)
        if text_path is None:
            raise web.HTTPNotFound(reason="text not found")

    content = text_path.read_text(encoding="utf-8")
    return web.json_response({"path": rel, "content": content})


# 允许直接读取 raw 原文的文本格式扩展名（用于前端预览）
_RAW_READABLE_EXTS = {".md", ".markdown", ".html", ".htm", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".log", ".py", ".js", ".ts", ".css", ".sh", ".toml"}


async def handle_materials_get_raw(req: web.Request) -> web.Response:
    """GET /api/materials/raw/{path:.*} — 读取 raw/ 下原始文件内容（仅文本格式）。

    用于前端直接预览 md/html/txt 等文本文件，不经过提取流程。
    """
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    rel = _clean_rel(req.match_info.get("path", ""))

    raw_path = _ensure_within_domain(raw_root / rel, raw_root)
    if not raw_path.exists() or not raw_path.is_file():
        raw_path = _archived_path(root, "raw", rel)
        if raw_path is None:
            raise web.HTTPNotFound(reason="raw file not found")

    ext = raw_path.suffix.lower()
    if ext not in _RAW_READABLE_EXTS:
        raise web.HTTPBadRequest(reason=f"Extension {ext} not directly readable, use extracted text instead")

    content = raw_path.read_text(encoding="utf-8", errors="replace")
    return web.json_response({"path": rel, "content": content, "ext": ext})


async def handle_materials_get_raw_binary(req: web.Request) -> web.Response:
    """GET /api/materials/raw-binary/{path:.*} — 返回 raw/ 下文件的二进制内容。

    用于前端读取原始文档，交给 Office 编辑器或 PDF 预览。
    """
    vault, root = _request_materials_context(req)
    raw_root = root / "raw"
    rel = _clean_rel(req.match_info.get("path", ""))

    raw_path = _ensure_within_domain(raw_root / rel, raw_root)
    if not raw_path.exists() or not raw_path.is_file():
        raw_path = _archived_path(root, "raw", rel)
        if raw_path is None:
            raise web.HTTPNotFound(reason="raw file not found")

    if raw_path.stat().st_size > MAX_FILE_SIZE:
        raise web.HTTPRequestEntityTooLarge(
            max_size=MAX_FILE_SIZE, actual_size=raw_path.stat().st_size
        )

    data = raw_path.read_bytes()
    return web.Response(body=data, content_type="application/octet-stream")


async def handle_materials_list_wiki(req: web.Request) -> web.Response:
    """GET /api/materials/wiki — 列出 wiki/ 下所有页面。"""
    vault, root = _request_materials_context(req)
    wiki_dir = root / "wiki"

    pages: list[dict[str, Any]] = []
    if not wiki_dir.exists():
        return web.json_response({"pages": pages})

    for md_file in wiki_dir.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
            frontmatter, _ = _parse_frontmatter(content)
            rel = str(md_file.relative_to(wiki_dir)).replace("\\", "/")
            sources = frontmatter.get("sources")
            if isinstance(sources, str):
                # flow 形式 "[a, b]" 或单值字符串兜底归一化
                text = sources.strip()
                if text.startswith("[") and text.endswith("]"):
                    text = text[1:-1]
                    sources = [p.strip().strip('"').strip("'") for p in text.split(",") if p.strip()]
                else:
                    sources = [text] if text else []
            elif not isinstance(sources, list):
                sources = []
            pages.append({
                "path": rel,
                "title": str(frontmatter.get("title") or md_file.stem),
                "id": str(frontmatter.get("id") or ""),
                "sources": sources,
                "stale": str(frontmatter.get("stale", "")).lower() == "true",
                "mtime": int(md_file.stat().st_mtime),
            })
        except Exception:
            continue

    pages.sort(key=lambda p: p["title"].lower())
    return web.json_response({"pages": pages})


async def handle_materials_get_wiki_page(req: web.Request) -> web.Response:
    """GET /api/materials/wiki/{path:.*} — 读取单个 wiki 页面。"""
    vault, root = _request_materials_context(req)
    wiki_root = root / "wiki"
    rel = _clean_rel(req.match_info.get("path", ""))

    wiki_path = _ensure_within_domain(wiki_root / rel, wiki_root)
    if not wiki_path.exists() or not wiki_path.is_file():
        raise web.HTTPNotFound(reason="wiki page not found")

    content = wiki_path.read_text(encoding="utf-8")
    return web.json_response({"path": rel, "content": content})


async def handle_materials_get_evidence(req: web.Request) -> web.Response:
    vault, root = _request_materials_context(req)
    evidence_id = req.match_info.get("evidence_id", "").strip()
    if not re.fullmatch(r"ev-[a-f0-9]{16,64}", evidence_id):
        raise web.HTTPBadRequest(reason="invalid evidence id")
    manifest_paths = list((root / "evidence").glob("*.json"))
    manifest_paths.extend((root / "archive").glob("*/evidence/*.json"))
    for manifest_path in manifest_paths:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        units = manifest.get("units")
        if not isinstance(units, list):
            continue
        unit = next(
            (
                item for item in units
                if isinstance(item, dict) and item.get("id") == evidence_id
            ),
            None,
        )
        if unit is None:
            continue
        return web.json_response({
            "id": evidence_id,
            "materialId": manifest.get("materialId"),
            "source": manifest.get("source"),
            "sourceHash": manifest.get("sourceHash"),
            **unit,
        })
    raise web.HTTPNotFound(reason="evidence not found")


def _ensure_wiki_frontmatter_id(content: str, existing_id: str | None = None) -> str:
    """确保 wiki 页面 frontmatter 含 `id: wiki-<UUID>`。

    若已有非空 id 字段则保留；否则使用 *existing_id*（覆盖写场景沿用旧 ID），
    都没有时生成新的 `wiki-<UUID>`。
    用于让 wiki 节点在统一链接图谱中与笔记节点（`note-<UUID>`）区分。
    """
    if not content.startswith("---"):
        # 无 frontmatter，包一个最小的
        fm = [
            "---",
            f"id: {existing_id or f'wiki-{uuid.uuid4()}'}",
            "---",
            "",
        ]
        return "\n".join(fm) + content

    end = content.find("---", 3)
    if end == -1:
        return content  # 损坏的 frontmatter，原样返回

    fm_text = content[3:end]
    has_id = any(
        line.strip().startswith("id:") and line.strip()[3:].strip()
        for line in fm_text.split("\n")
    )
    if has_id:
        return content

    # 在 frontmatter 顶部插入 id 字段（fm_text 以换行开头，拼接后首行严格为 ---）
    new_id = existing_id or f"wiki-{uuid.uuid4()}"
    return f"---\nid: {new_id}{fm_text}{content[end:]}"


def _read_wiki_existing_id(wiki_path: Path) -> str | None:
    """读取已有 wiki 页面的 frontmatter id（不存在或解析失败返回 None）。"""
    try:
        content = wiki_path.read_text(encoding="utf-8")
    except OSError:
        return None
    frontmatter, _ = _parse_frontmatter(content)
    page_id = frontmatter.get("id")
    if isinstance(page_id, str) and page_id.strip():
        return page_id.strip()
    return None


async def handle_materials_write_wiki_page(req: web.Request) -> web.Response:
    """POST /api/materials/wiki/write — 写入或更新 wiki 页面。

    Body: { "path": "relative/path", "content": "markdown content" }
    """
    vault, root = _request_materials_context(req)
    wiki_root = root / "wiki"
    body = await req.json()
    rel = _clean_rel(body.get("path", ""))
    content = body.get("content", "")

    wiki_path = _ensure_within_domain(wiki_root / rel, wiki_root)
    if not wiki_path.suffix == ".md":
        raise web.HTTPBadRequest(reason="wiki page must be a .md file")
    wiki_path.parent.mkdir(parents=True, exist_ok=True)
    # 覆盖写时沿用已有 ID，保持图谱身份稳定（P0-3）
    existing_id = _read_wiki_existing_id(wiki_path) if wiki_path.exists() else None
    final_content = _ensure_wiki_frontmatter_id(content, existing_id)
    wiki_path.write_text(final_content, encoding="utf-8")
    sync_write_point(vault, library_root=root, wiki_files=[wiki_path])
    return web.json_response({"path": rel, "bytes": len(final_content)})


async def handle_materials_delete_wiki_page(req: web.Request) -> web.Response:
    """DELETE /api/materials/wiki/{path:.*} — 删除 wiki 页面。"""
    vault, root = _request_materials_context(req)
    wiki_root = root / "wiki"
    rel = _clean_rel(req.match_info.get("path", ""))

    wiki_path = _ensure_within_domain(wiki_root / rel, wiki_root)
    if wiki_path.exists():
        existing_id = _read_wiki_existing_id(wiki_path)
        wiki_path.unlink()
        # 索引中的 material_id 是显式 id 或 wiki-<rel> 回退，两者都清
        removed = [existing_id] if existing_id else []
        fallback_id = f"wiki-{rel}"
        if fallback_id != existing_id:
            removed.append(fallback_id)
        sync_write_point(vault, library_root=root, removed_ids=removed)
    return web.json_response({"deleted": rel})


async def handle_materials_search(req: web.Request) -> web.Response:
    """GET /api/materials/search — FTS5 chunk 索引检索资料。

    查询参数：
      - q: 搜索关键词
      - count: 返回上限，默认 10
      - scope: "all"（默认）| "text" | "wiki"

    结果 path 约定：source 为相对 raw/ 的路径，wiki 为相对 wiki/ 的路径；
    locationLabel/stale 由索引透传（写入点同步保证新鲜，reconcile 兜底）。
    """
    vault, root = _request_materials_context(req)
    query = req.query.get("q", "").strip()
    if not query:
        return web.json_response({"results": []})

    count = int(req.query.get("count", "10"))
    scope = req.query.get("scope", "all")
    kinds = {"text": ("source",), "wiki": ("derived",)}.get(
        scope, ("source", "derived")
    )

    from mona.materials.index import MaterialsIndex

    index = MaterialsIndex(
        root / "index.db", vault=vault, library_root=root
    )
    try:
        rows = index.search(query, count=count, kinds=kinds)
    finally:
        index.close()

    results = [
        {
            "kind": r["kind"],
            "title": r["title"],
            "path": r["rawPath"],
            "snippet": r["snippet"],
            "score": r["score"],
            "locationLabel": r.get("locationLabel") or None,
            "stale": bool(r.get("stale")),
        }
        for r in rows
    ]
    return web.json_response({"results": results})


async def handle_materials_reconcile(req: web.Request) -> web.Response:
    """POST /api/materials/reconcile — 轻量对账 raw/text/wiki 一致性。

    - raw 存在、text 缺失或 size/mtime/extractorVersion 不一致 → 重新入队提取
    - text 存在、raw 缺失 → 删除孤儿 text
    - wiki 引用的 raw 缺失或已 stale → wiki frontmatter 标记 stale: true

    进入资料页和手动刷新时由前端调用；进程重启后的任务恢复也依赖此入口。
    """
    vault, root = _request_materials_context(req)
    report = await reconcile_materials(vault, root)
    return web.json_response(report)


async def reconcile_materials(vault: Path, root: Path) -> dict[str, Any]:
    """执行一次 raw/text/wiki 对账，返回处理报告。"""
    raw_root = root / "raw"
    text_root = root / "text"
    wiki_root = root / "wiki"

    requeued: list[str] = []
    removed_orphans: list[str] = []
    stale_wiki: list[str] = []

    # 1. raw → text：缺失或不新鲜则重新入队
    if raw_root.exists():
        for raw_file in sorted(p for p in raw_root.rglob("*") if p.is_file()):
            raw_rel = str(raw_file.relative_to(raw_root)).replace("\\", "/")
            text_path = _text_path_for_raw(raw_rel, root)
            supported, reason = _is_supported(raw_file.name)
            if not supported:
                if not text_path.exists():
                    _mark_text_error(text_path, raw_rel, reason or "unsupported")
                continue
            if not text_path.exists():
                await _extract_in_background(vault, root, raw_rel)
                requeued.append(raw_rel)
                continue
            try:
                fm, _ = _parse_frontmatter(text_path.read_text(encoding="utf-8"))
            except OSError:
                fm = {}
            fm_status = fm.get("status")
            if fm_status == "ok" and _is_fresh(fm, raw_file):
                continue
            if fm_status in ("error", "unsupported"):
                # 失败后只允许用户显式重新学习；刷新页面不能偷偷重试。
                continue
            await _extract_in_background(vault, root, raw_rel)
            requeued.append(raw_rel)

    # 2. text → raw：raw 缺失的孤儿 text 删除
    if text_root.exists():
        for text_file in sorted(text_root.rglob("*.md")):
            rel = str(text_file.relative_to(text_root)).replace("\\", "/")
            raw_rel = rel[: -len(".md")] if rel.endswith(".md") else rel
            try:
                fm, _ = _parse_frontmatter(text_file.read_text(encoding="utf-8"))
                source = fm.get("source")
                if isinstance(source, str) and source.strip():
                    raw_rel = source.strip()
            except OSError:
                pass
            if not (raw_root / raw_rel).exists():
                try:
                    material_id = _read_existing_material_id(text_file)
                    text_file.unlink()
                    if material_id:
                        manifest = root / "evidence" / f"{material_id}.json"
                        if manifest.exists():
                            manifest.unlink()
                    removed_orphans.append(raw_rel)
                    # 清理空父目录
                    parent = text_file.parent
                    while parent != text_root and parent.exists() and not any(parent.iterdir()):
                        parent.rmdir()
                        parent = parent.parent
                except OSError:
                    logger.warning("materials: failed to remove orphan text {}", rel)

    # 3. wiki → raw：引用失效的 wiki 标记 stale
    if wiki_root.exists():
        for wiki_file in sorted(wiki_root.rglob("*.md")):
            try:
                content = wiki_file.read_text(encoding="utf-8")
            except OSError:
                continue
            fm, _ = _parse_frontmatter(content)
            sources = fm.get("sources")
            if isinstance(sources, str):
                sources = [sources]
            if not sources:
                continue
            wiki_rel = str(wiki_file.relative_to(wiki_root)).replace("\\", "/")
            if str(fm.get("stale", "")).lower() == "true":
                continue
            for source in sources:
                if not isinstance(source, str):
                    continue
                raw_rel = source.strip()
                if raw_rel.startswith("raw/"):
                    raw_rel = raw_rel[len("raw/"):]
                raw_path = raw_root / raw_rel
                if not raw_path.exists():
                    _mark_wiki_stale(wiki_file)
                    stale_wiki.append(wiki_rel)
                    break
                text_path = _text_path_for_raw(raw_rel, root)
                try:
                    text_fm, _ = _parse_frontmatter(
                        text_path.read_text(encoding="utf-8")
                    )
                except OSError:
                    text_fm = {}
                if text_fm.get("status") == "ok" and not _is_fresh(text_fm, raw_path):
                    _mark_wiki_stale(wiki_file)
                    stale_wiki.append(wiki_rel)
                    break

    # 4. 同步 FTS5 chunk 索引（reconcile 是索引的指定写入方）
    index_stats: dict[str, int] = {}
    try:
        from mona.materials.index import MaterialsIndex, sync_index

        index = MaterialsIndex(root / "index.db", vault=vault)
        try:
            index_stats = sync_index(vault, index)
        finally:
            index.close()
    except Exception:
        logger.exception("materials: index sync failed during reconcile")

    return {
        "requeued": requeued,
        "removedOrphans": removed_orphans,
        "staleWiki": stale_wiki,
        "index": index_stats,
    }


def _mark_wiki_stale(wiki_path: Path) -> None:
    """在 wiki frontmatter 中标记 stale: true（重复调用幂等）。"""
    try:
        content = wiki_path.read_text(encoding="utf-8")
    except OSError:
        return
    if not content.startswith("---"):
        return
    end = content.find("\n---", 3)
    if end == -1:
        return
    fm_text = content[3:end]
    lines: list[str] = []
    marked = False
    for line in fm_text.split("\n"):
        if line.strip().startswith("stale:"):
            lines.append("stale: true")
            marked = True
        else:
            lines.append(line)
    if not marked:
        lines.append("stale: true")
    _atomic_write_text(wiki_path, "---" + "\n".join(lines) + content[end:])


async def handle_materials_status(req: web.Request) -> web.Response:
    """GET /api/materials/status — 返回资料库整体状态（文件数、提取进度等）。"""
    vault, root = _request_materials_context(req)

    raw_dir = root / "raw"
    text_dir = root / "text"
    wiki_dir = root / "wiki"
    evidence_dir = root / "evidence"

    raw_files = list(raw_dir.rglob("*")) if raw_dir.exists() else []
    raw_file_count = sum(1 for p in raw_files if p.is_file())
    text_files = list(text_dir.rglob("*.md")) if text_dir.exists() else []
    wiki_files = list(wiki_dir.rglob("*.md")) if wiki_dir.exists() else []
    evidence_counts = {"represented": 0, "excluded": 0, "uncovered": 0}
    manifest_material_ids: set[str] = set()
    if evidence_dir.exists():
        for manifest_path in evidence_dir.glob("*.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            units = manifest.get("units")
            material_id = manifest.get("materialId")
            if isinstance(material_id, str) and material_id:
                manifest_material_ids.add(material_id)
            if not isinstance(units, list):
                continue
            for unit in units:
                status = unit.get("status") if isinstance(unit, dict) else "uncovered"
                key = status if status in evidence_counts else "uncovered"
                evidence_counts[key] += 1
    for text_file in text_files:
        material_id = _read_existing_material_id(text_file)
        if material_id and material_id not in manifest_material_ids:
            evidence_counts["uncovered"] += 1

    # 统计提取状态（queued/running/ok/error/unsupported/stale）
    counts: dict[str, int] = {}
    for raw_file in (p for p in raw_files if p.is_file()):
        raw_rel = _relative_to_materials(raw_file, (root / "raw"))
        text_path = _text_path_for_raw(raw_rel, root)
        status = _read_text_status(
            text_path, vault=vault, raw_rel=raw_rel, raw_path=raw_file
        )
        key = status["status"]
        counts[key] = counts.get(key, 0) + 1

    return web.json_response({
        "rawFiles": raw_file_count,
        "textFiles": len(text_files),
        "wikiFiles": len(wiki_files),
        "evidence": {
            **evidence_counts,
            "complete": evidence_counts["uncovered"] == 0,
        },
        "extract": counts,
        "rawRoot": str(raw_dir),
        "vaultRoot": str(vault),
    })


async def handle_materials_lint(req: web.Request) -> web.Response:
    """POST /api/materials/lint — 对 LLM Wiki 产物跑确定性质量检查，返回 lint 报告。

    只报告不修复；前端可把报告注入 Agent 面板走「让 Mona 修复」流程。
    """
    vault, root = _request_materials_context(req)
    from mona.materials.lint import lint_materials

    report = lint_materials(vault, root=root)
    return web.json_response(report)


async def handle_materials_llm_config(_req: web.Request) -> web.Response:
    """GET /api/materials/llm-config — 返回当前 LLM 配置供前端 ingest 流程使用。

    安全约束（阶段 0 / P0-1）：不得返回 API Key / apiBase 等敏感字段——
    本地 HTTP 端点不具备浏览器级防护，密钥只能在后端进程内使用。
    Wiki 编译迁移到后端前，前端生成入口已禁用，此端点仅保留非敏感元数据。
    """
    try:
        from mona.config.loader import load_config, resolve_config_env_vars

        config = resolve_config_env_vars(load_config())
        model = config.agents.defaults.model
        provider_name = config.get_provider_name(model) or ""

        return web.json_response({
            "model": model,
            "providerName": provider_name,
        })
    except Exception as e:
        logger.exception("Failed to get LLM config for materials")
        return web.json_response({"error": str(e)}, status=500)
