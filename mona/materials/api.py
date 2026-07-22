"""HTTP API handlers for the materials module.

资料库 HTTP 接口：目录管理、文件上传、提取状态、Wiki 读写、搜索。
所有路径操作都限制在 `<vault>/.mona/materials/` 内，通过 canonical path 校验。
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.materials.search import search_materials
from mona.utils.document import SUPPORTED_EXTENSIONS, extract_text

# 单文件大小上限：50 MB（与 document.py 的 _MAX_EXTRACT_FILE_SIZE 对齐）
MAX_FILE_SIZE = 50 * 1024 * 1024

# 不支持的格式（明确提示用户，不静默失败）
UNSUPPORTED_EXTENSIONS = {".doc", ".xls"}

# 提取任务超时（秒）
EXTRACT_TIMEOUT = 120

# 后台提取任务表：vault_path -> { rel_path -> Future }
# 用 vault_path 隔离不同 vault 的任务，避免互相干扰
_EXTRACT_TASKS: dict[Path, dict[str, asyncio.Future[Any]]] = {}


def _get_vault_path() -> Path | None:
    """通过 Tauri IPC 获取笔记 vault 路径。"""
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke

        result = tauri_invoke("notes_vault_get_path")
    except RuntimeError:
        return None
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return Path(result.strip())
    if isinstance(result, dict):
        v = result.get("path") or result.get("result")
        if isinstance(v, str) and v.strip():
            return Path(v.strip())
    return None


def _require_vault() -> Path:
    """获取 vault 路径，未配置则抛出 HTTP 400。"""
    vault = _get_vault_path()
    if vault is None:
        raise web.HTTPBadRequest(reason="Notes vault not configured")
    return vault


def _materials_root(vault: Path) -> Path:
    """返回资料库根目录 `<vault>/.mona/materials/`，必要时创建子目录。"""
    root = vault / ".mona" / "materials"
    for sub in ("raw", "text", "wiki"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    return root


def _ensure_within_materials(path: Path, materials_root: Path) -> Path:
    """canonical path 校验，确保路径在 materials_root 内。"""
    resolved = path.resolve()
    root_resolved = materials_root.resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError as exc:
        raise web.HTTPBadRequest(reason="Path escapes materials directory") from exc
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


def _write_text_file(text_path: Path, source_rel: str, content: str, truncated: bool) -> None:
    """写入提取的 text/ markdown 文件，带 frontmatter。"""
    text_path.parent.mkdir(parents=True, exist_ok=True)
    frontmatter = {
        "id": f"text-{uuid.uuid4()}",
        "source": source_rel,
        "extractedAt": datetime.now().isoformat(timespec="seconds"),
        "truncated": "true" if truncated else "false",
    }
    fm_lines = ["---"]
    for k, v in frontmatter.items():
        fm_lines.append(f"{k}: {v}")
    fm_lines.append("---")
    fm_lines.append("")
    text_path.write_text("\n".join(fm_lines) + content, encoding="utf-8")


async def _extract_in_background(
    vault: Path, materials_root: Path, raw_rel_path: str
) -> None:
    """后台提取单个文件，写入 text/ 目录。

    失败时写一个带 error 标记的 text/ 文件，便于前端显示状态。
    """
    raw_path = materials_root / "raw" / raw_rel_path
    text_path = _text_path_for_raw(raw_rel_path, materials_root)
    task_key = raw_rel_path

    tasks_for_vault = _EXTRACT_TASKS.setdefault(vault, {})
    if task_key in tasks_for_vault and not tasks_for_vault[task_key].done():
        return  # 已有任务在跑

    async def _do_extract() -> None:
        try:
            # extract_text 是同步阻塞调用，放到线程池
            content = await asyncio.wait_for(
                asyncio.to_thread(extract_text, raw_path),
                timeout=EXTRACT_TIMEOUT,
            )
            if content is None:
                raise RuntimeError("unsupported file type")
            if content.startswith("[error:"):
                raise RuntimeError(content)
            truncated = "... (truncated" in content
            _write_text_file(text_path, raw_rel_path, content, truncated)
            logger.info("materials: extracted {}", raw_rel_path)
        except asyncio.TimeoutError:
            _write_text_file(text_path, raw_rel_path, "", False)
            # 标记提取失败
            _mark_text_error(text_path, raw_rel_path, "提取超时")
            logger.warning("materials: extract timeout {}", raw_rel_path)
        except Exception as e:
            _mark_text_error(text_path, raw_rel_path, str(e))
            logger.exception("materials: extract failed {}", raw_rel_path)
        finally:
            tasks_for_vault.pop(task_key, None)

    tasks_for_vault[task_key] = asyncio.create_task(_do_extract())


def _mark_text_error(text_path: Path, source_rel: str, error: str) -> None:
    """写入提取失败标记。"""
    text_path.parent.mkdir(parents=True, exist_ok=True)
    frontmatter = {
        "id": f"text-{uuid.uuid4()}",
        "source": source_rel,
        "extractedAt": datetime.now().isoformat(timespec="seconds"),
        "error": error,
    }
    fm_lines = ["---"]
    for k, v in frontmatter.items():
        fm_lines.append(f"{k}: {v}")
    fm_lines.append("---")
    fm_lines.append("")
    text_path.write_text("\n".join(fm_lines), encoding="utf-8")


def _read_text_status(text_path: Path) -> dict[str, Any]:
    """读取 text/ 文件的状态（pending/ok/error/truncated）。"""
    if not text_path.exists():
        return {"status": "pending"}
    try:
        content = text_path.read_text(encoding="utf-8")
    except Exception:
        return {"status": "error", "error": "无法读取提取结果"}

    # 解析 frontmatter
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            yaml_text = content[3:end].strip()
            fm: dict[str, Any] = {}
            for line in yaml_text.split("\n"):
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip()
            if "error" in fm:
                return {"status": "error", "error": fm["error"]}
            truncated = fm.get("truncated") == "true"
            return {
                "status": "ok",
                "truncated": truncated,
                "chars": len(content) - end - 3,
            }
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


async def handle_materials_list_files(req: web.Request) -> web.Response:
    """GET /api/materials/files — 递归列出 raw/ 下的文件和目录树。

    查询参数：
      - subdir: 可选，相对于 raw/ 的子目录，默认为空（列根目录）
    """
    vault = _require_vault()
    root = _materials_root(vault)
    subdir = req.query.get("subdir", "").strip()
    target = root / "raw"
    if subdir:
        target = target / subdir
    _ensure_within_materials(target, root)

    if not target.exists():
        return web.json_response({"entries": []})

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
            text_path = _text_path_for_raw(
                _relative_to_materials(child, (root / "raw")), root
            )
            status = _read_text_status(text_path)
            stat = child.stat()
            entries.append({
                "name": child.name,
                "path": rel,
                "type": "file",
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
                "extractStatus": status,
            })

    return web.json_response({"entries": entries})


async def handle_materials_create_directory(req: web.Request) -> web.Response:
    """POST /api/materials/directory — 在 raw/ 下创建目录。

    Body: { "path": "relative/path" }
    """
    vault = _require_vault()
    root = _materials_root(vault)
    body = await req.json()
    rel = body.get("path", "").strip().strip("/")
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")
    target = root / "raw" / rel
    _ensure_within_materials(target, root)
    target.mkdir(parents=True, exist_ok=True)
    return web.json_response({"path": _relative_to_materials(target, root)})


async def handle_materials_delete(req: web.Request) -> web.Response:
    """DELETE /api/materials/files/{path:.*} — 删除 raw/ 下的文件或目录，同步删除 text/ 对应文件。"""
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    raw_target = root / "raw" / rel
    _ensure_within_materials(raw_target, root)

    if not raw_target.exists():
        raise web.HTTPNotFound(reason="path not found")

    # 同步删除对应的 text/ 文件
    if raw_target.is_file():
        text_path = _text_path_for_raw(rel, root)
        if text_path.exists():
            text_path.unlink()
        raw_target.unlink()
    else:
        # 目录：递归删除 text/ 下对应文件
        for raw_file in raw_target.rglob("*"):
            if raw_file.is_file():
                raw_rel = _relative_to_materials(raw_file, (root / "raw"))
                text_path = _text_path_for_raw(raw_rel, root)
                if text_path.exists():
                    text_path.unlink()
        raw_target.rmdir()  # 只删空目录（rmdir 会失败如果有子目录）

    return web.json_response({"deleted": rel})


async def handle_materials_move(req: web.Request) -> web.Response:
    """POST /api/materials/move — 移动 raw/ 下的文件或目录，同步移动 text/ 对应文件。

    Body: { "source": "relative/path", "targetDir": "relative/dir" }
    """
    vault = _require_vault()
    root = _materials_root(vault)
    body = await req.json()
    source_rel = body.get("source", "").strip().strip("/")
    target_dir = body.get("targetDir", "").strip().strip("/")
    if not source_rel or not target_dir:
        raise web.HTTPBadRequest(reason="source and targetDir are required")

    src = root / "raw" / source_rel
    _ensure_within_materials(src, root)
    if not src.exists():
        raise web.HTTPNotFound(reason="source not found")

    target_dir_path = root / "raw" / target_dir
    _ensure_within_materials(target_dir_path, root)
    target_dir_path.mkdir(parents=True, exist_ok=True)

    dst = target_dir_path / src.name
    _ensure_within_materials(dst, root)

    # 移动 raw 文件
    src.rename(dst)

    # 同步移动 text/ 文件（只处理文件场景，目录场景的递归移动较复杂，MVP 不实现）
    if src.is_file():
        old_text = _text_path_for_raw(source_rel, root)
        new_text = _text_path_for_raw(
            _relative_to_materials(dst, (root / "raw")), root
        )
        if old_text.exists():
            new_text.parent.mkdir(parents=True, exist_ok=True)
            old_text.rename(new_text)

    return web.json_response({
        "source": source_rel,
        "target": _relative_to_materials(dst, root),
    })


async def handle_materials_extract(req: web.Request) -> web.Response:
    """POST /api/materials/extract — 触发后台提取 raw/ 下指定文件。

    Body: { "path": "relative/path" }  （path 可以是文件或目录）
    """
    vault = _require_vault()
    root = _materials_root(vault)
    body = await req.json()
    rel = body.get("path", "").strip().strip("/")
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    raw_target = root / "raw" / rel
    _ensure_within_materials(raw_target, root)
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
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    text_path = root / "text" / rel
    _ensure_within_materials(text_path, root)
    if not text_path.exists() or not text_path.is_file():
        raise web.HTTPNotFound(reason="text not found")

    content = text_path.read_text(encoding="utf-8")
    return web.json_response({"path": rel, "content": content})


# 允许直接读取 raw 原文的文本格式扩展名（用于前端预览）
_RAW_READABLE_EXTS = {".md", ".markdown", ".html", ".htm", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml", ".log", ".py", ".js", ".ts", ".css", ".sh", ".toml"}


async def handle_materials_get_raw(req: web.Request) -> web.Response:
    """GET /api/materials/raw/{path:.*} — 读取 raw/ 下原始文件内容（仅文本格式）。

    用于前端直接预览 md/html/txt 等文本文件，不经过提取流程。
    """
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    raw_path = root / "raw" / rel
    _ensure_within_materials(raw_path, root)
    if not raw_path.exists() or not raw_path.is_file():
        raise web.HTTPNotFound(reason="raw file not found")

    ext = raw_path.suffix.lower()
    if ext not in _RAW_READABLE_EXTS:
        raise web.HTTPBadRequest(reason=f"Extension {ext} not directly readable, use extracted text instead")

    content = raw_path.read_text(encoding="utf-8", errors="replace")
    return web.json_response({"path": rel, "content": content, "ext": ext})


async def handle_materials_get_raw_binary(req: web.Request) -> web.Response:
    """GET /api/materials/raw-binary/{path:.*} — 返回 raw/ 下文件的二进制内容。

    用于前端 jit-viewer 预览 docx/xlsx/pptx/pdf 等 Office 文档。
    """
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    raw_path = root / "raw" / rel
    _ensure_within_materials(raw_path, root)
    if not raw_path.exists() or not raw_path.is_file():
        raise web.HTTPNotFound(reason="raw file not found")

    data = raw_path.read_bytes()
    return web.Response(body=data, content_type="application/octet-stream")


async def handle_materials_list_wiki(req: web.Request) -> web.Response:
    """GET /api/materials/wiki — 列出 wiki/ 下所有页面。"""
    vault = _require_vault()
    root = _materials_root(vault)
    wiki_dir = root / "wiki"

    pages: list[dict[str, Any]] = []
    if not wiki_dir.exists():
        return web.json_response({"pages": pages})

    for md_file in wiki_dir.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
            # 简单解析 frontmatter
            frontmatter: dict[str, Any] = {}
            if content.startswith("---"):
                end = content.find("---", 3)
                if end != -1:
                    for line in content[3:end].strip().split("\n"):
                        if ":" in line:
                            k, _, v = line.partition(":")
                            frontmatter[k.strip()] = v.strip()
            rel = str(md_file.relative_to(wiki_dir)).replace("\\", "/")
            pages.append({
                "path": rel,
                "title": frontmatter.get("title", md_file.stem),
                "id": frontmatter.get("id", ""),
                "sources": frontmatter.get("sources", []),
                "mtime": int(md_file.stat().st_mtime),
            })
        except Exception:
            continue

    pages.sort(key=lambda p: p["title"].lower())
    return web.json_response({"pages": pages})


async def handle_materials_get_wiki_page(req: web.Request) -> web.Response:
    """GET /api/materials/wiki/{path:.*} — 读取单个 wiki 页面。"""
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    wiki_path = root / "wiki" / rel
    _ensure_within_materials(wiki_path, root)
    if not wiki_path.exists() or not wiki_path.is_file():
        raise web.HTTPNotFound(reason="wiki page not found")

    content = wiki_path.read_text(encoding="utf-8")
    return web.json_response({"path": rel, "content": content})


def _ensure_wiki_frontmatter_id(content: str) -> str:
    """确保 wiki 页面 frontmatter 含 `id: wiki-<UUID>`。

    若已有非空 id 字段则保留；否则补一个 `wiki-<UUID>`。
    用于让 wiki 节点在统一链接图谱中与笔记节点（`note-<UUID>`）区分。
    """
    if not content.startswith("---"):
        # 无 frontmatter，包一个最小的
        fm = [
            "---",
            f"id: wiki-{uuid.uuid4()}",
            "---",
            "",
        ]
        return "\n".join(fm) + content

    end = content.find("---", 3)
    if end == -1:
        return content  # 损坏的 frontmatter，原样返回

    fm_text = content[3:end]
    # 检查是否已有 id 字段
    has_id = False
    new_fm_lines: list[str] = []
    for line in fm_text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("id:") and stripped[3:].strip():
            has_id = True
        new_fm_lines.append(line)

    if has_id:
        return content

    # 在 frontmatter 顶部插入 id 字段
    new_fm_text = "\n".join([f"id: wiki-{uuid.uuid4()}"] + new_fm_lines)
    return f"---{new_fm_text}{content[end:]}"


async def handle_materials_write_wiki_page(req: web.Request) -> web.Response:
    """POST /api/materials/wiki/write — 写入或更新 wiki 页面。

    Body: { "path": "relative/path", "content": "markdown content" }
    """
    vault = _require_vault()
    root = _materials_root(vault)
    body = await req.json()
    rel = body.get("path", "").strip().strip("/")
    content = body.get("content", "")
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    wiki_path = root / "wiki" / rel
    _ensure_within_materials(wiki_path, root)
    wiki_path.parent.mkdir(parents=True, exist_ok=True)
    # 确保 wiki 页面有 wiki-<UUID> id（统一图谱命名空间）
    final_content = _ensure_wiki_frontmatter_id(content)
    wiki_path.write_text(final_content, encoding="utf-8")
    return web.json_response({"path": rel, "bytes": len(final_content)})


async def handle_materials_delete_wiki_page(req: web.Request) -> web.Response:
    """DELETE /api/materials/wiki/{path:.*} — 删除 wiki 页面。"""
    vault = _require_vault()
    root = _materials_root(vault)
    rel = req.match_info.get("path", "").strip()
    if not rel:
        raise web.HTTPBadRequest(reason="path is required")

    wiki_path = root / "wiki" / rel
    _ensure_within_materials(wiki_path, root)
    if wiki_path.exists():
        wiki_path.unlink()
    return web.json_response({"deleted": rel})


async def handle_materials_search(req: web.Request) -> web.Response:
    """GET /api/materials/search — 关键词搜索资料。

    查询参数：
      - q: 搜索关键词
      - count: 返回上限，默认 10
      - scope: "all"（默认）| "text" | "wiki"
    """
    vault = _require_vault()
    query = req.query.get("q", "").strip()
    if not query:
        return web.json_response({"results": []})

    count = int(req.query.get("count", "10"))
    scope = req.query.get("scope", "all")

    include_text = scope in ("all", "text")
    include_wiki = scope in ("all", "wiki")

    results = search_materials(
        vault, query, count=count,
        include_text=include_text, include_wiki=include_wiki,
    )
    return web.json_response({"results": results})


async def handle_materials_status(req: web.Request) -> web.Response:
    """GET /api/materials/status — 返回资料库整体状态（文件数、提取进度等）。"""
    vault = _require_vault()
    root = _materials_root(vault)

    raw_dir = root / "raw"
    text_dir = root / "text"
    wiki_dir = root / "wiki"

    raw_files = list(raw_dir.rglob("*")) if raw_dir.exists() else []
    raw_file_count = sum(1 for p in raw_files if p.is_file())
    text_files = list(text_dir.rglob("*.md")) if text_dir.exists() else []
    wiki_files = list(wiki_dir.rglob("*.md")) if wiki_dir.exists() else []

    # 统计提取状态
    pending = 0
    ok = 0
    error = 0
    for raw_file in (p for p in raw_files if p.is_file()):
        raw_rel = _relative_to_materials(raw_file, (root / "raw"))
        text_path = _text_path_for_raw(raw_rel, root)
        status = _read_text_status(text_path)
        if status["status"] == "pending":
            pending += 1
        elif status["status"] == "ok":
            ok += 1
        else:
            error += 1

    return web.json_response({
        "rawFiles": raw_file_count,
        "textFiles": len(text_files),
        "wikiFiles": len(wiki_files),
        "extract": {"pending": pending, "ok": ok, "error": error},
    })


async def handle_materials_llm_config(_req: web.Request) -> web.Response:
    """GET /api/materials/llm-config — 返回当前 LLM 配置供前端 ingest 流程使用。

    与 KB 的 /api/kb/llm-config 等价，但路径独立，便于后续删除 KB。
    """
    try:
        from mona.config.loader import load_config, resolve_config_env_vars

        config = resolve_config_env_vars(load_config())
        model = config.agents.defaults.model
        provider_name = config.get_provider_name(model) or ""
        api_key = config.get_api_key(model) or ""
        api_base = config.get_api_base(model) or ""

        return web.json_response({
            "model": model,
            "providerName": provider_name,
            "apiKey": api_key,
            "apiBase": api_base,
        })
    except Exception as e:
        logger.exception("Failed to get LLM config for materials")
        return web.json_response({"error": str(e)}, status=500)
