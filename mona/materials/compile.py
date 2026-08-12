"""Wiki backend compile: LLM-driven wiki generation with task management.

资料库 Wiki 后端编译（阶段 3）：

- 用户选择文件/目录，后端等待提取状态 ready 后调用 LLM 生成 Wiki 页面；
- 同一批次先候选化，再按路径合并（同名页面 sources 取并集），最后事务写入
  （全部候选先落临时目录，验证通过后原子替换进 wiki/，任一格式错误则整批
  丢弃，正式目录不发生部分覆盖）；
- 覆盖写保留已有页面 ID、created、人工字段和未被否定的 sources；
- 每页记录完整 materialIds/rawPaths/sourceHashes 和生成模型信息；
- 支持取消（asyncio task cancel），任务进度可轮询。
"""

from __future__ import annotations

import asyncio
import re
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.materials.api import (
    _clean_rel,
    _ensure_within_domain,
    _extract_in_background,
    _materials_root,
    _read_text_status,
    _require_vault,
    _text_path_for_raw,
)
from mona.materials.frontmatter import _parse_frontmatter, _render_frontmatter
from mona.utils.document import IMAGE_EXTENSIONS, SUPPORTED_EXTENSIONS

# 单文件源文本上限（字符）：超出截断，避免上下文爆炸
MAX_SOURCE_CHARS = 200_000

# 等待提取 ready 的轮询参数
_WAIT_EXTRACT_INTERVAL = 1.0
_WAIT_EXTRACT_TIMEOUT = 300.0

# 批次任务表：task_id -> CompileTask（进程内状态）
_COMPILE_TASKS: dict[str, "CompileTask"] = {}

# 编译任务管理的 frontmatter 字段（合并时特殊处理，不当作人工字段保留）
_MANAGED_FM_KEYS = {
    "id",
    "type",
    "title",
    "created",
    "updated",
    "tags",
    "related",
    "sources",
    "materialids",
    "rawpaths",
    "sourcehashes",
    "generatedby",
    "generatedat",
    "stale",
}


# ---------------------------------------------------------------------------
# FILE block parsing（port of webui/src/lib/ingest.ts parseFileBlocks）
# ---------------------------------------------------------------------------

_OPENER_LINE = re.compile(r"^---\s*FILE:\s*(.+?)\s*---\s*$", re.IGNORECASE)
_CLOSER_LINE = re.compile(r"^---\s*END\s+FILE\s*---\s*$", re.IGNORECASE)
_FENCE_LINE = re.compile(r"^\s{0,3}(```+|~~~+)")
_WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {
    f"LPT{i}" for i in range(1, 10)
}


def is_safe_wiki_path(p: str) -> bool:
    """校验 FILE block 路径：必须是 wiki/ 下的相对路径，拒绝逃逸与非法分段。"""
    if not isinstance(p, str) or not p.strip():
        return False
    if p.startswith(("/", "\\")) or re.match(r"^[a-zA-Z]:", p):
        return False
    normalized = p.replace("\\", "/")
    segments = normalized.split("/")
    for seg in segments:
        if seg == ".." or not _is_safe_segment(seg):
            return False
    return normalized.startswith("wiki/")


def _is_safe_segment(segment: str) -> bool:
    if not segment:
        return False
    if re.search(r'[<>:"|?*\x00-\x1f]', segment):
        return False
    if segment.endswith((" ", ".")):
        return False
    stem = segment.split(".")[0].upper()
    return stem not in _WINDOWS_RESERVED


def parse_file_blocks(text: str) -> tuple[list[dict[str, str]], list[str]]:
    """解析 LLM 生成阶段的 FILE 块输出。

    返回 (blocks, warnings)；block = {"path": ..., "content": ...}。
    未闭合（截断）的块丢弃并告警；不安全路径丢弃并告警。
    """
    normalized = text.replace("\r\n", "\n")
    lines = normalized.split("\n")

    blocks: list[dict[str, str]] = []
    warnings: list[str] = []

    i = 0
    while i < len(lines):
        opener = _OPENER_LINE.match(lines[i])
        if not opener:
            i += 1
            continue
        path = opener.group(1).strip()
        i += 1

        content_lines: list[str] = []
        fence_char: str | None = None
        fence_len = 0
        closed = False

        while i < len(lines):
            line = lines[i]
            fence = _FENCE_LINE.match(line)
            if fence:
                run = fence.group(1)
                if fence_char is None:
                    fence_char = run[0]
                    fence_len = len(run)
                elif run[0] == fence_char and len(run) >= fence_len:
                    fence_char = None
                    fence_len = 0
                content_lines.append(line)
                i += 1
                continue
            if fence_char is None and _CLOSER_LINE.match(line):
                closed = True
                i += 1
                break
            content_lines.append(line)
            i += 1

        if not closed:
            warnings.append(
                f'FILE block "{path or "(unnamed)"}" not closed before end of stream '
                "(likely truncation) — dropped"
            )
            continue
        if not path:
            warnings.append("FILE block with empty path — skipped")
            continue
        if not is_safe_wiki_path(path):
            warnings.append(f'FILE block path "{path}" is unsafe or escapes wiki/ — skipped')
            continue
        blocks.append({"path": path, "content": "\n".join(content_lines)})

    return blocks, warnings


# ---------------------------------------------------------------------------
# Prompt builders（简化版：不强制 index/log/overview，无 REVIEW 块）
# ---------------------------------------------------------------------------

_LANGUAGE_RULE = "Write all content in the same language as the source document."


def build_compile_prompt(
    source_file_name: str,
    source_raw_rel: str,
    summary_path: str,
) -> str:
    """单次调用 prompt：内部分析源文档，直接生成 Wiki FILE 块。"""
    return "\n".join([
        "You are a research analyst and wiki maintainer. Read the source document, analyze it internally, and generate wiki files in one pass.",
        "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE blocks.",
        "",
        _LANGUAGE_RULE,
        "",
        "## Step 1 — Analyze internally (never output this analysis)",
        "",
        "Identify before writing:",
        "- Key entities: people, organizations, products, datasets, tools; central vs. peripheral.",
        "- Key concepts: theories, methods, techniques, phenomena; why they matter here.",
        "- Main arguments, findings, and the evidence supporting them.",
        "",
        "## IMPORTANT: Source File",
        f"The original source file is: **{source_raw_rel}**",
        "All wiki pages generated from this source MUST include this exact path in their frontmatter `sources` field.",
        "",
        "## Step 2 — What to generate",
        "",
        f"1. A source summary page at **{summary_path}** (MUST use this exact path)",
        "2. Entity pages for key named things identified in the analysis, under wiki/entities/.",
        "3. Concept pages for key ideas, methods, techniques, and abstractions, under wiki/concepts/.",
        "",
        "## Frontmatter Rules (CRITICAL — parser is strict)",
        "",
        "Every page begins with a YAML frontmatter block:",
        "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
        "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
        "2. Each frontmatter line is a `key: value` pair on its own line.",
        "3. The frontmatter ends with another `---` line on its own.",
        "4. The next line after the closing `---` is the start of the page body.",
        "",
        "Required fields:",
        "  - type     — one of: source | entity | concept",
        "  - title    — string (quote it if it contains a colon)",
        "  - created  — date in YYYY-MM-DD form",
        "  - updated  — same as created",
        "  - tags     — array of bare strings: `tags: [a, b]`",
        f"  - sources  — array; MUST include \"{source_raw_rel}\"",
        "",
        "Other rules:",
        "- Use [[wikilink]] syntax in the BODY for cross-references between pages",
        "- Use kebab-case filenames",
        "- Do NOT create index.md, log.md, or overview.md pages",
        "",
        "## Output Format (MUST FOLLOW EXACTLY)",
        "",
        "Your ENTIRE response consists of FILE blocks. Nothing else.",
        "",
        "FILE block template:",
        "```",
        "---FILE: wiki/path/to/page.md---",
        "(complete file content with YAML frontmatter)",
        "---END FILE---",
        "```",
        "",
        "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
        "2. DO NOT output any preamble, analysis, or trailing commentary.",
        "",
        "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    ])


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _strip_frontmatter(content: str) -> str:
    """去掉 frontmatter，只保留正文。"""
    if not content.startswith("---"):
        return content
    end = content.find("---", 3)
    if end == -1:
        return content
    after = content[end + 3 :]
    return after[1:] if after.startswith("\n") else after


def _source_summary_slug(raw_rel: str) -> str:
    """从 raw 相对路径推导 source summary slug。

    含目录段，避免不同目录下的同名文件互相覆盖：
    ``docs/report.pdf`` -> ``docs-report``。
    """
    stem = re.sub(r"\.[^.]+$", "", raw_rel)
    slug = re.sub(r"[^A-Za-z0-9一-鿿]+", "-", stem).strip("-").lower()
    return slug or "source"


# 需要按 title canonical 化的 wiki 子目录（实体/概念跨文件归并）
_CANONICAL_DIRS = ("entities/", "concepts/")


def _title_slug(title: str) -> str:
    """页面 title 的 CJK 安全 slug（与 _source_summary_slug 同一套规则）。"""
    slug = re.sub(r"[^A-Za-z0-9一-鿿]+", "-", title).strip("-").lower()
    return slug or "page"


def _canonical_wiki_rel(wiki_rel: str, content: str) -> str:
    """entities/concepts 页面 canonical 化为 ``{dir}/{slug(title)}.md``。

    同 title 必同页，跨文件归并不再依赖 LLM 两次生成相同路径。
    其他目录（sources 等）或非 markdown 路径原样返回。
    """
    if not wiki_rel.startswith(_CANONICAL_DIRS) or not wiki_rel.endswith(".md"):
        return wiki_rel
    fm, _ = _parse_frontmatter(content)
    title = str(fm.get("title") or "").strip()
    if not title:
        return wiki_rel
    dir_name = wiki_rel.rpartition("/")[0]
    return f"{dir_name}/{_title_slug(title)}.md"


def _coerce_str_list(value: Any) -> list[str]:
    """把 frontmatter 值（字符串/列表/flow 形式）归一化为字符串列表。"""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip().strip('"').strip("'") for v in value if str(v).strip()]
    text = str(value).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
        return [p.strip().strip('"').strip("'") for p in text.split(",") if p.strip()]
    return [text] if text else []


def merge_page_content(
    existing_content: str | None,
    candidate_content: str,
    *,
    new_sources: list[str],
    new_material_ids: list[str],
    new_source_hashes: list[str],
    model: str,
) -> str:
    """合并候选页面与已有页面。

    保留：已有页面 ID、created、人工字段（非受管字段）、未被否定的 sources。
    更新：正文取候选版本，updated 设为今天，补充来源元数据，清除 stale。
    """
    today = datetime.now().strftime("%Y-%m-%d")
    now_iso = datetime.now().isoformat(timespec="seconds")

    cand_fm, cand_body = _parse_frontmatter(candidate_content)
    if not cand_fm and candidate_content.startswith("---"):
        # frontmatter 存在但 YAML 非法（如 title 含未加引号的冒号）：
        # 至少剥离出正文，避免原始 frontmatter 文本混入合并后的 body
        cand_body = _strip_frontmatter(candidate_content)

    exist_fm: dict[str, Any] = {}
    if existing_content:
        exist_fm, _ = _parse_frontmatter(existing_content)

    # ID：已有优先，其次候选，最后新生成
    page_id = exist_fm.get("id") or cand_fm.get("id") or f"wiki-{uuid.uuid4()}"
    # created：已有优先
    created = exist_fm.get("created") or cand_fm.get("created") or today
    # sources：并集（已有在前，保持顺序去重）
    sources = list(dict.fromkeys(
        [*_coerce_str_list(exist_fm.get("sources")), *new_sources]
    ))
    material_ids = list(dict.fromkeys(
        [*_coerce_str_list(exist_fm.get("materialIds")), *new_material_ids]
    ))
    source_hashes = list(dict.fromkeys(
        [*_coerce_str_list(exist_fm.get("sourceHashes")), *new_source_hashes]
    ))

    fields: list[tuple[str, Any]] = [("id", page_id)]
    # 候选 frontmatter 的展示字段（跳过受管字段，后面统一补）
    skip = {"id", "created", "updated", "sources", "materialids", "sourcehashes", "stale"}
    for key, value in cand_fm.items():
        if key.lower() in skip:
            continue
        fields.append((key, value))
    fields.extend([
        ("created", created),
        ("updated", today),
        ("sources", sources),
        ("materialIds", material_ids),
        ("sourceHashes", source_hashes),
        ("generatedBy", model),
        ("generatedAt", now_iso),
    ])
    # 人工字段：已有页面中候选未覆盖、且非受管的字段保留
    emitted = {k.lower() for k, _ in fields}
    for key, value in exist_fm.items():
        kl = key.lower()
        if kl in emitted or kl in _MANAGED_FM_KEYS:
            continue
        fields.append((key, value))

    return _render_frontmatter(fields) + cand_body.strip() + "\n"


# ---------------------------------------------------------------------------
# 编译任务
# ---------------------------------------------------------------------------


@dataclass
class CompileTask:
    task_id: str
    total_files: int
    state: str = "running"  # running | done | error | cancelled
    current_file: str = ""
    completed_files: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    pages_written: int = 0
    written_paths: list[str] = field(default_factory=list)
    asyncio_task: asyncio.Task | None = field(default=None, repr=False)

    def snapshot(self) -> dict[str, Any]:
        return {
            "taskId": self.task_id,
            "state": self.state,
            "currentFile": self.current_file,
            "totalFiles": self.total_files,
            "completedFiles": len(self.completed_files),
            "errors": self.errors,
            "pagesWritten": self.pages_written,
            "writtenPaths": self.written_paths,
        }


async def _wait_text_ready(vault: Path, root: Path, raw_rel: str) -> str | None:
    """等待指定 raw 文件的提取状态变为 ok；失败/超时返回错误描述。"""
    text_path = _text_path_for_raw(raw_rel, root)
    raw_path = root / "raw" / raw_rel
    deadline = asyncio.get_event_loop().time() + _WAIT_EXTRACT_TIMEOUT

    # 状态非 ok 才触发提取（_extract_in_background 内部按路径去重）
    status = _read_text_status(text_path, vault=vault, raw_rel=raw_rel, raw_path=raw_path)
    if status.get("status") != "ok":
        await _extract_in_background(vault, root, raw_rel)

    while asyncio.get_event_loop().time() < deadline:
        status = _read_text_status(text_path, vault=vault, raw_rel=raw_rel, raw_path=raw_path)
        state = status.get("status")
        if state == "ok":
            return None
        if state in ("error", "unsupported"):
            return status.get("error", state)
        await asyncio.sleep(_WAIT_EXTRACT_INTERVAL)
    return "等待提取超时"


async def _llm_call(provider: Any, model: str, messages: list[dict[str, str]], *, max_tokens: int) -> str:
    """调用 LLM，返回文本内容；失败抛出 RuntimeError。"""
    response = await provider.chat_with_retry(
        messages=messages,
        model=model,
        max_tokens=max_tokens,
        temperature=0.1,
    )
    if response.finish_reason == "error" or not response.content:
        raise RuntimeError((response.content or "empty response")[:300])
    return response.content


async def _compile_one_file(
    provider: Any,
    model: str,
    root: Path,
    raw_rel: str,
    text_content: str,
) -> tuple[list[dict[str, str]], list[str]]:
    """对单个文件执行单次 LLM 编译（内部分析 + 直接生成），返回候选 FILE 块与告警。"""
    del root  # 路径推导只依赖 raw_rel，保留参数位与调用方签名一致
    source_file_name = raw_rel.split("/")[-1]
    summary_path = f"wiki/sources/{_source_summary_slug(raw_rel)}.md"
    source_content = text_content[:MAX_SOURCE_CHARS]

    generation = await _llm_call(
        provider,
        model,
        [
            {
                "role": "system",
                "content": build_compile_prompt(source_file_name, raw_rel, summary_path),
            },
            {
                "role": "user",
                "content": (
                    f"Source document: **{source_file_name}** (path: {raw_rel})\n\n"
                    f"---\n\n{source_content}\n\n---\n\n"
                    "Now emit the FILE blocks. Your response MUST begin with `---FILE:` "
                    "as the very first characters."
                ),
            },
        ],
        max_tokens=8192,
    )

    return parse_file_blocks(generation)


def _collect_raw_files(root: Path, paths: list[str]) -> list[str]:
    """把输入路径（文件或目录，相对 raw/）展开为支持的 raw 文件相对路径列表。"""
    raw_root = root / "raw"
    out: list[str] = []
    seen: set[str] = set()

    def add_file(f: Path) -> None:
        ext = f.suffix.lower()
        if ext not in SUPPORTED_EXTENSIONS or ext in IMAGE_EXTENSIONS:
            return
        rel = str(f.relative_to(raw_root)).replace("\\", "/")
        if rel not in seen:
            seen.add(rel)
            out.append(rel)

    for rel in paths:
        target = raw_root / rel
        if target.is_file():
            add_file(target)
        elif target.is_dir():
            for f in sorted(target.rglob("*")):
                if f.is_file():
                    add_file(f)
    return out


async def _run_compile(task: CompileTask, vault: Path, root: Path, raw_files: list[str]) -> None:
    """编译主流程：并发候选化 → canonical 归并 → 事务写入 → 索引同步。"""
    from mona.providers.factory import load_provider_snapshot

    wiki_root = root / "wiki"
    tmp_root = root / f".compile-{task.task_id}"

    try:
        snapshot = await asyncio.to_thread(load_provider_snapshot)
        provider, model = snapshot.provider, snapshot.model

        # 1. 候选化：文件级并发（Semaphore 限流），每文件等待提取 ready 后单次 LLM 调用
        sem = asyncio.Semaphore(3)

        async def _process_file(raw_rel: str) -> dict[str, Any] | None:
            """处理单个文件；成功返回候选块与来源元数据，失败记录错误并返回 None。"""
            async with sem:
                task.current_file = raw_rel
                try:
                    wait_error = await _wait_text_ready(vault, root, raw_rel)
                    if wait_error is not None:
                        task.errors.append(f"{raw_rel}: 提取未就绪（{wait_error}）")
                        return None

                    text_path = _text_path_for_raw(raw_rel, root)
                    full_text = text_path.read_text(encoding="utf-8")
                    text_fm, _ = _parse_frontmatter(full_text)
                    body = _strip_frontmatter(full_text)
                    if not body.strip():
                        task.errors.append(f"{raw_rel}: 提取文本为空")
                        return None

                    try:
                        blocks, warnings = await _compile_one_file(
                            provider, model, root, raw_rel, body
                        )
                    except RuntimeError as e:
                        task.errors.append(f"{raw_rel}: {e}")
                        return None
                    for w in warnings:
                        logger.warning("materials compile {}: {}", raw_rel, w)

                    # 任一 LLM 输出格式错误（0 个有效块）→ 记录错误，该文件不产生候选
                    if not blocks:
                        task.errors.append(f"{raw_rel}: LLM 输出无有效 FILE 块，已跳过")
                        return None

                    return {
                        "raw_rel": raw_rel,
                        "material_id": str(text_fm.get("id", "")),
                        "source_hash": str(text_fm.get("sha256", "")),
                        "blocks": blocks,
                    }
                finally:
                    task.completed_files.append(raw_rel)

        results = await asyncio.gather(*(_process_file(rel) for rel in raw_files))
        task.current_file = ""

        # 2. 归并：gather 之后统一合并（避免并发写共享 dict）；
        #    entities/concepts 页面 canonical 化为 {dir}/{slug(title)}.md，同 title 必同页
        #    candidates: wiki_rel -> {"content", "sources", "materialIds", "sourceHashes", "legacy_rels"}
        candidates: dict[str, dict[str, Any]] = {}
        for result in results:
            if result is None:
                continue
            raw_rel = result["raw_rel"]
            material_id = result["material_id"]
            source_hash = result["source_hash"]
            for block in result["blocks"]:
                block_path = block["path"].replace("\\", "/")
                if not block_path.startswith("wiki/") or not block_path.endswith(".md"):
                    continue
                wiki_rel = block_path[len("wiki/"):]
                canonical_rel = _canonical_wiki_rel(wiki_rel, block["content"])
                entry = candidates.setdefault(canonical_rel, {
                    "content": block["content"],
                    "sources": [],
                    "materialIds": [],
                    "sourceHashes": [],
                    "legacy_rels": [],
                })
                if canonical_rel != wiki_rel and wiki_rel not in entry["legacy_rels"]:
                    entry["legacy_rels"].append(wiki_rel)
                if raw_rel not in entry["sources"]:
                    entry["sources"].append(raw_rel)
                if material_id and material_id not in entry["materialIds"]:
                    entry["materialIds"].append(material_id)
                if source_hash and source_hash not in entry["sourceHashes"]:
                    entry["sourceHashes"].append(source_hash)

        # 3. 事务写入：全部候选先落临时目录，验证通过后原子替换进 wiki/
        if candidates:
            tmp_root.mkdir(parents=True, exist_ok=True)
            staged: list[tuple[Path, Path]] = []
            try:
                for wiki_rel, entry in candidates.items():
                    # 候选路径二次校验（防逃逸）
                    final_path = _ensure_within_domain(wiki_root / wiki_rel, wiki_root)
                    existing: str | None = None
                    if final_path.exists():
                        existing = final_path.read_text(encoding="utf-8")
                    else:
                        # 旧页面渐进迁移：canonical 不存在时回读 LLM 原始路径
                        for legacy_rel in entry["legacy_rels"]:
                            legacy_path = _ensure_within_domain(
                                wiki_root / legacy_rel, wiki_root
                            )
                            if legacy_path.exists():
                                existing = legacy_path.read_text(encoding="utf-8")
                                break
                    merged = merge_page_content(
                        existing,
                        entry["content"],
                        new_sources=entry["sources"],
                        new_material_ids=entry["materialIds"],
                        new_source_hashes=entry["sourceHashes"],
                        model=model,
                    )
                    stage_path = tmp_root / wiki_rel
                    stage_path.parent.mkdir(parents=True, exist_ok=True)
                    stage_path.write_text(merged, encoding="utf-8")
                    staged.append((stage_path, final_path))

                for stage_path, final_path in staged:
                    final_path.parent.mkdir(parents=True, exist_ok=True)
                    # 已有页面 ID 由 merge_page_content 保留，原子替换到位
                    shutil.move(str(stage_path), str(final_path))
                    task.written_paths.append(str(final_path.relative_to(wiki_root)).replace("\\", "/"))
            finally:
                shutil.rmtree(tmp_root, ignore_errors=True)

        task.pages_written = len(task.written_paths)
        # 全部文件都没有产出候选才算失败；部分失败仍算完成（errors 带明细）
        task.state = "done" if candidates else "error"

        # 4. 索引同步：编译写入完成后全量轻量同步（fingerprint skip，成本低）
        if task.written_paths:
            from mona.materials.index import sync_write_point

            sync_write_point(vault, full=True)

    except asyncio.CancelledError:
        task.state = "cancelled"
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise
    except Exception as e:
        logger.exception("materials compile failed")
        task.state = "error"
        task.errors.append(str(e)[:300])
        shutil.rmtree(tmp_root, ignore_errors=True)


async def start_compile(paths: list[str]) -> CompileTask:
    """启动编译任务，返回任务句柄。"""
    vault = _require_vault()
    root = _materials_root(vault)
    raw_root = root / "raw"

    cleaned = [_clean_rel(p) for p in paths]
    for rel in cleaned:
        _ensure_within_domain(raw_root / rel, raw_root)

    raw_files = _collect_raw_files(root, cleaned)
    if not raw_files:
        raise web.HTTPBadRequest(reason="所选路径下没有可编译的资料文件")

    task = CompileTask(task_id=uuid.uuid4().hex[:12], total_files=len(raw_files))
    _COMPILE_TASKS[task.task_id] = task
    task.asyncio_task = asyncio.create_task(_run_compile(task, vault, root, raw_files))
    return task


def get_compile_task(task_id: str) -> CompileTask | None:
    return _COMPILE_TASKS.get(task_id)


def cancel_compile_task(task_id: str) -> bool:
    task = _COMPILE_TASKS.get(task_id)
    if task is None or task.asyncio_task is None or task.asyncio_task.done():
        return False
    task.asyncio_task.cancel()
    return True


# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------


async def handle_materials_wiki_compile_start(req: web.Request) -> web.Response:
    """POST /api/materials/wiki/compile — 启动 Wiki 编译任务。

    Body: { "paths": ["relative/path", ...] }（相对 raw/，可为文件或目录）
    """
    body = await req.json()
    paths = body.get("paths")
    if not isinstance(paths, list) or not paths:
        raise web.HTTPBadRequest(reason="paths is required")
    task = await start_compile([str(p) for p in paths])
    return web.json_response({"taskId": task.task_id, "totalFiles": task.total_files})


async def handle_materials_wiki_compile_status(req: web.Request) -> web.Response:
    """GET /api/materials/wiki/compile/{taskId} — 查询编译任务状态。"""
    task_id = req.match_info.get("task_id", "")
    task = get_compile_task(task_id)
    if task is None:
        raise web.HTTPNotFound(reason="task not found")
    return web.json_response(task.snapshot())


async def handle_materials_wiki_compile_cancel(req: web.Request) -> web.Response:
    """POST /api/materials/wiki/compile/{taskId}/cancel — 取消编译任务。"""
    task_id = req.match_info.get("task_id", "")
    cancelled = cancel_compile_task(task_id)
    if not cancelled:
        task = get_compile_task(task_id)
        if task is None:
            raise web.HTTPNotFound(reason="task not found")
    return web.json_response({"cancelled": cancelled})
