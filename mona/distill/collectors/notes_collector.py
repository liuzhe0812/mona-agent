"""Notes data collector.

Aggregates note distribution by notebook and tags from the vault.
Uses the Rust-side search/index if available, otherwise scans markdown files.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger


@dataclass
class NotesStats:
    """Aggregated notes statistics."""

    total_notes: int = 0
    total_notebooks: int = 0
    # Notebook distribution: [{notebook, count}]
    notebook_distribution: list[dict[str, Any]] = field(default_factory=list)
    # Tag distribution: [{tag, count}] (top N)
    tag_distribution: list[dict[str, Any]] = field(default_factory=list)
    # Top words in titles (technical keyword frequency)
    title_keywords: list[dict[str, Any]] = field(default_factory=list)
    # Notes created per month: {YYYY-MM: count}
    monthly_distribution: dict[str, int] = field(default_factory=dict)
    # Recent note titles (for LLM context)
    recent_titles: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_notes": self.total_notes,
            "total_notebooks": self.total_notebooks,
            "notebook_distribution": self.notebook_distribution,
            "tag_distribution": self.tag_distribution,
            "title_keywords": self.title_keywords,
            "monthly_distribution": self.monthly_distribution,
            "recent_titles": self.recent_titles,
        }


# 技术关键词（英文小写 + 中文），用于从标题/标签中提取
_TECH_KEYWORDS = {
    # 编程语言
    "python", "rust", "typescript", "javascript", "java", "go", "golang",
    "c++", "c#", "swift", "kotlin",
    # 框架/运行时
    "react", "vue", "tauri", "electron", "godot", "node", "deno",
    # 数据库
    "sql", "postgres", "postgresql", "mysql", "sqlite", "redis", "mongodb",
    # 协议/API
    "api", "http", "grpc", "websocket", "rest", "graphql",
    # AI/ML
    "ai", "ml", "llm", "gpt", "agent", "embedding", "rag",
    # 系统/工具
    "linux", "windows", "macos", "shell", "bash", "powershell",
    "git", "docker", "kubernetes", "nginx", "ci/cd", "vim", "vscode",
    # Web
    "css", "html", "npm", "vite", "webpack",
    # —— 中文技术词 ——
    "架构", "设计模式", "系统设计", "微服务", "分布式",
    "前端", "后端", "全栈", "数据库", "缓存",
    "邮件", "授权", "认证", "加密", "安全",
    "蒸馏", "画像", "可视化", "图表",
    "自动化", "工作流", "效率",
    "终端", "命令行",
    "模型", "降级", "并发", "性能",
    "提示词", "模板",
    "笔记", "知识库",
}


def _extract_keywords(title: str) -> list[str]:
    """Extract technical keywords from a note title (case-insensitive).

    匹配 _TECH_KEYWORDS 中的英文（小写比较）和中文（原样比较）。
    """
    if not title:
        return []
    lowered = title.lower()
    found = []
    for kw in _TECH_KEYWORDS:
        if kw in lowered:
            found.append(kw)
    return found


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """Parse YAML frontmatter from markdown content."""
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    fm_text = parts[1].strip()
    result: dict[str, Any] = {}
    for line in fm_text.splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if val:
            result[key] = val
    return result


def collect_notes_stats(vault: Path | None, top_n: int = 15) -> NotesStats:
    """Scan notes vault and aggregate statistics.

    Args:
        vault: notes vault root path (None if not configured)
        top_n: number of top items to return per category
    """
    stats = NotesStats()

    if vault is None or not vault.exists():
        logger.debug("[notes_collector] no vault configured")
        return stats

    notebook_counter: Counter[str] = Counter()
    tag_counter: Counter[str] = Counter()
    keyword_counter: Counter[str] = Counter()
    monthly: Counter[str] = Counter()
    recent_titles: list[str] = []
    total_notes = 0

    # Scan markdown files
    for md_file in vault.rglob("*.md"):
        # Skip hidden directories and assets
        if any(part.startswith(".") for part in md_file.relative_to(vault).parts):
            continue
        if "assets" in md_file.parts:
            continue

        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue

        frontmatter = _parse_frontmatter(content)
        title = frontmatter.get("title", md_file.stem)
        # notebook：用 vault 下第一级文件夹名；根目录散落笔记用 vault 名
        rel_parts = md_file.relative_to(vault).parts
        if len(rel_parts) > 1:
            notebook = rel_parts[0]
        else:
            notebook = vault.name
        tags_raw = frontmatter.get("tags", "")
        created = frontmatter.get("createdAt") or frontmatter.get("created_at") or frontmatter.get("updated", "")

        notebook_counter[notebook] += 1
        total_notes += 1

        # Parse tags (comma or space separated)
        if tags_raw:
            for tag in str(tags_raw).replace(",", " ").split():
                tag = tag.strip().strip('"').strip("'")
                if tag:
                    tag_counter[tag] += 1

        # Extract technical keywords from title
        for kw in _extract_keywords(title):
            keyword_counter[kw] += 1

        # Also extract keywords from tags
        if tags_raw:
            for tag in str(tags_raw).replace(",", " ").split():
                for kw in _extract_keywords(tag):
                    keyword_counter[kw] += 1

        # Monthly distribution
        if created:
            # Try to extract YYYY-MM
            created_str = str(created)[:7]
            if len(created_str) == 7 and created_str[4] == "-":
                monthly[created_str] += 1

        # Keep recent titles (last 50 by filename)
        if len(recent_titles) < 50:
            recent_titles.append(title)

    stats.total_notes = total_notes
    stats.total_notebooks = len(notebook_counter)
    stats.notebook_distribution = [
        {"notebook": nb, "count": count}
        for nb, count in notebook_counter.most_common(top_n)
    ]
    stats.tag_distribution = [
        {"tag": tag, "count": count}
        for tag, count in tag_counter.most_common(top_n)
    ]
    stats.title_keywords = [
        {"keyword": kw, "count": count}
        for kw, count in keyword_counter.most_common(top_n)
    ]
    stats.monthly_distribution = dict(sorted(monthly.items()))
    stats.recent_titles = recent_titles

    logger.info(
        f"[notes_collector] scanned {total_notes} notes, "
        f"{len(notebook_counter)} notebooks, {len(tag_counter)} tags"
    )
    return stats
