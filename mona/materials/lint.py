"""资料库 lint：LLM Wiki 产物的确定性质量检查（零 LLM 调用）。

LLM Wiki 的典型失效模式是幻觉而非语法错误：幻觉内链、实体分裂、
引用悬空、元数据缺失、内容退化。这些用机械规则即可大量捕获，
因此 lint 只做确定性检查、只报告不修复；修复交给人或 Agent
（前端「让 Mona 修复」把报告转为 Agent 任务）。

规则一览：
- frontmatter-schema（error）：wiki 页面 id/type/title/created/sources 缺失或非法
- thin-page（warning）：正文过短，疑似 LLM 退化输出
- text-extract-error（warning）：text/ 提取状态为 error/unsupported
- broken-wikilink（error）：正文 [[target]] 解析不到任何 wiki 页面
- dangling-source（error）：frontmatter sources 引用不存在的 raw 文件
- duplicate-title（warning）：同一 title slug 出现在多个 wiki 路径
- orphan-page（warning）：零入链且非 source 类型的 wiki 页面
- stale-page（error）：页面来源已删除或内容已变化，需要重新生成
"""

from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from mona.materials.frontmatter import _parse_frontmatter

_WIKILINK_RE = re.compile(r"\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_VALID_TYPES = {"source", "entity", "concept"}
_THIN_PAGE_MIN_CHARS = 100

# 规则的中文标签，前端直接展示，避免再维护一份映射
RULE_LABELS = {
    "frontmatter-schema": "元数据问题",
    "thin-page": "内容过短",
    "text-extract-error": "提取失败",
    "broken-wikilink": "断链",
    "dangling-source": "引用失效",
    "duplicate-title": "重复页面",
    "orphan-page": "孤立页面",
    "stale-page": "页面已过期",
}


def _title_slug(title: str) -> str:
    """title 的 CJK 安全 slug。

    与 compile.py 的 canonical 归并必须保持同一规则，否则 wikilink
    解析结果与实体归并路径会对不上。
    """
    slug = re.sub(r"[^A-Za-z0-9一-鿿]+", "-", title).strip("-").lower()
    return slug or "page"


def _link_slug(target: str) -> str:
    """wikilink 目标归一化：容忍路径式（wiki/entities/foo.md）与标题式写法。"""
    t = target.strip()
    if t.endswith(".md"):
        t = t[:-3]
    # 路径式写法取最后一段作为页面名
    t = t.rsplit("/", 1)[-1]
    return _title_slug(t)


def _scan_wiki_pages(wiki_root: Path) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for md in sorted(wiki_root.rglob("*.md")):
        rel = md.relative_to(wiki_root).as_posix()
        try:
            content = md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body = _parse_frontmatter(content)
        title = fm.get("title")
        pages.append(
            {
                "rel": rel,
                "fm": fm,
                "body": body,
                "title": title if isinstance(title, str) else "",
                "links": [m.group(1).strip() for m in _WIKILINK_RE.finditer(body)],
            }
        )
    return pages


def _check_schema(page: dict[str, Any], add) -> None:
    fm = page["fm"]
    rel = page["rel"]

    page_id = fm.get("id")
    if not (isinstance(page_id, str) and page_id.startswith("wiki-")):
        add("frontmatter-schema", "error", rel, "缺少 id 字段（wiki- 前缀）", {})

    page_type = fm.get("type")
    if page_type not in _VALID_TYPES:
        add(
            "frontmatter-schema",
            "error",
            rel,
            f"type 非法（{page_type!r}），应为 source/entity/concept",
            {"field": "type", "value": page_type},
        )

    if not page["title"]:
        add("frontmatter-schema", "error", rel, "缺少 title 字段", {"field": "title"})

    created = fm.get("created")
    created_ok = isinstance(created, (date, datetime)) or (
        isinstance(created, str) and bool(_DATE_RE.match(created))
    )
    if not created_ok:
        add(
            "frontmatter-schema",
            "error",
            rel,
            "created 缺失或不是 YYYY-MM-DD 日期",
            {"field": "created", "value": created},
        )

    sources = fm.get("sources")
    if not isinstance(sources, list):
        add(
            "frontmatter-schema",
            "error",
            rel,
            "sources 缺失或不是列表",
            {"field": "sources", "value": sources},
        )
    elif not sources:
        add(
            "frontmatter-schema",
            "error",
            rel,
            "sources 为空，页面无法追溯到原始资料",
            {"field": "sources"},
        )
    elif any(not isinstance(s, str) for s in sources):
        add(
            "frontmatter-schema",
            "error",
            rel,
            "sources 含非字符串条目",
            {"field": "sources"},
        )


def lint_materials(vault: Path) -> dict[str, Any]:
    """扫描 `<vault>/.mona/materials/`，返回机器可读 lint 报告。"""
    root = vault / ".mona" / "materials"
    raw_root = root / "raw"
    text_root = root / "text"
    wiki_root = root / "wiki"

    issues: list[dict[str, Any]] = []

    def add(rule: str, severity: str, path: str, message: str, details: dict) -> None:
        issues.append(
            {
                "rule": rule,
                "severity": severity,
                "path": path,
                "message": message,
                "label": RULE_LABELS[rule],
                "details": details,
            }
        )

    pages = _scan_wiki_pages(wiki_root) if wiki_root.exists() else []

    # wikilink 解析索引：title slug 与路径 stem slug 双通道
    slug_to_rels: dict[str, list[str]] = {}
    for page in pages:
        if page["title"]:
            slug_to_rels.setdefault(_title_slug(page["title"]), []).append(page["rel"])
        stem = page["rel"].rsplit("/", 1)[-1].removesuffix(".md")
        slug_to_rels.setdefault(_title_slug(stem), []).append(page["rel"])

    # --- 单文件规则：schema + thin-page ---
    for page in pages:
        _check_schema(page, add)
        if page["fm"].get("stale") is True:
            add(
                "stale-page",
                "error",
                page["rel"],
                "原始资料已删除或内容已变化，需要重新生成 Wiki",
                {"sources": page["fm"].get("sources", [])},
            )
        if len(page["body"].strip()) < _THIN_PAGE_MIN_CHARS:
            add(
                "thin-page",
                "warning",
                page["rel"],
                f"正文仅 {len(page['body'].strip())} 字符，疑似退化输出",
                {"chars": len(page["body"].strip())},
            )

    # --- 跨文件规则：broken-wikilink + orphan 入链统计 ---
    inbound: set[str] = set()
    for page in pages:
        seen_targets: set[str] = set()
        for target in page["links"]:
            slug = _link_slug(target)
            if slug in seen_targets:
                continue
            seen_targets.add(slug)
            rels = slug_to_rels.get(slug)
            if not rels:
                add(
                    "broken-wikilink",
                    "error",
                    page["rel"],
                    f"链接 [[{target}]] 指向不存在的页面",
                    {"target": target},
                )
            else:
                inbound.update(r for r in rels if r != page["rel"])

    # --- dangling-source ---
    for page in pages:
        sources = page["fm"].get("sources")
        if not isinstance(sources, list):
            continue
        for entry in sources:
            if not isinstance(entry, str):
                continue
            raw_rel = entry.removeprefix("raw/")
            if not (raw_root / raw_rel).exists():
                add(
                    "dangling-source",
                    "error",
                    page["rel"],
                    f"sources 引用的原始文件不存在：{entry}",
                    {"source": entry},
                )

    # --- duplicate-title ---
    title_groups: dict[str, list[str]] = {}
    for page in pages:
        if page["title"]:
            title_groups.setdefault(_title_slug(page["title"]), []).append(page["rel"])
    for slug, rels in sorted(title_groups.items()):
        if len(rels) > 1:
            title = next(p["title"] for p in pages if p["rel"] == rels[0])
            add(
                "duplicate-title",
                "warning",
                rels[0],
                f"标题「{title}」出现在 {len(rels)} 个页面：{'、'.join(rels)}",
                {"paths": rels, "slug": slug},
            )

    # --- orphan-page（source 摘要页是入口，不算孤儿） ---
    for page in pages:
        if page["fm"].get("type") == "source":
            continue
        if page["rel"] not in inbound:
            add("orphan-page", "warning", page["rel"], "没有其他页面链接到此页", {})

    # --- text-extract-error ---
    text_count = 0
    if text_root.exists():
        for md in sorted(text_root.rglob("*.md")):
            text_count += 1
            rel = md.relative_to(text_root).as_posix()
            try:
                fm, _ = _parse_frontmatter(md.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            status = fm.get("status")
            if status in ("error", "unsupported"):
                source = fm.get("source", rel.removesuffix(".md"))
                add(
                    "text-extract-error",
                    "warning",
                    f"text/{rel}",
                    f"提取状态为 {status}（源文件 {source}）",
                    {"status": status, "source": source},
                )

    # errors 在前，同级按路径排序，输出稳定
    issues.sort(key=lambda i: (i["severity"] != "error", i["path"], i["rule"]))
    errors = sum(1 for i in issues if i["severity"] == "error")
    return {
        "issues": issues,
        "summary": {
            "errors": errors,
            "warnings": len(issues) - errors,
            "wikiPages": len(pages),
            "textFiles": text_count,
        },
    }
