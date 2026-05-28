"""Knowledge base tools: ingest, query, status, compile."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.knowledge.indexer import Indexer
from mona.knowledge.models import (
    ChangePriority,
    ChangeType,
    FileMeta,
    KnowledgeMode,
    PendingChange,
)
from mona.knowledge.store import KnowledgeStore

_SUPPORTED_EXTENSIONS = frozenset(
    {".md", ".txt", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".toml", ".rst"}
)


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _extract_title(path: Path) -> str:
    try:
        first_line = path.read_text(encoding="utf-8").splitlines()[0]
        stripped = first_line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        return stripped or path.stem
    except (IndexError, UnicodeDecodeError):
        return path.stem


def _estimate_tokens(text: str) -> int:
    return len(text) // 3


class _KbTool(Tool):
    _scopes = {"core", "subagent"}

    def __init__(self, workspace: Path | None = None) -> None:
        self._workspace = workspace

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(workspace=Path(ctx.workspace))

    def _get_store(self, instance: str | None = None) -> KnowledgeStore:
        name = instance or "default"
        store = KnowledgeStore(
            self._workspace / ".knowledge" / name,
            KnowledgeMode.NOTEBOOK,
        )
        store.ensure_dirs()
        return store

    def _get_indexer(self, store: KnowledgeStore) -> Indexer:
        indexer = Indexer(store.db_path)
        indexer.initialize()
        return indexer


@tool_parameters({
    "type": "object",
    "properties": {
        "paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "要入库的文件或目录路径列表（相对于 workspace）",
        },
        "recursive": {
            "type": "boolean",
            "description": "是否递归扫描子目录（默认 false）",
        },
        "exclude": {
            "type": "array",
            "items": {"type": "string"},
            "description": "要排除的路径模式列表（glob 语法）",
        },
        "instance": {
            "type": "string",
            "description": "知识库实例名，留空则使用默认实例",
        },
    },
})
class KbIngestTool(_KbTool):
    @property
    def name(self) -> str:
        return "kb_ingest"

    @property
    def description(self) -> str:
        return (
            "将文件或目录添加到知识库，建立 FTS5 全文索引。"
            "支持 .md, .txt, .py, .js, .ts, .json, .yaml, .yml, .toml, .rst 格式。"
        )

    async def execute(
        self,
        paths: list[str] | None = None,
        recursive: bool = False,
        exclude: list[str] | None = None,
        instance: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not self._workspace:
            return "Error: workspace not configured"

        store = self._get_store(instance)
        indexer = self._get_indexer(store)
        meta = store.load_meta()

        exclude_set = set(exclude or [])
        target_paths = paths or ["."]
        collected: list[Path] = []

        for raw in target_paths:
            target = self._workspace / raw
            if not target.exists():
                continue
            if target.is_file():
                collected.append(target)
            elif target.is_dir():
                if recursive:
                    for dirpath, dirnames, filenames in os.walk(target):
                        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
                        for fn in sorted(filenames):
                            collected.append(Path(dirpath) / fn)
                else:
                    for fn in sorted(os.listdir(target)):
                        child = target / fn
                        if child.is_file():
                            collected.append(child)

        ingested: list[str] = []
        for fpath in collected:
            if fpath.name.startswith("."):
                continue
            if fpath.suffix.lower() not in _SUPPORTED_EXTENSIONS:
                continue
            rel = fpath.relative_to(self._workspace).as_posix()
            if any(rel.startswith(p) or rel == p for p in exclude_set):
                continue
            try:
                content = fpath.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            h = _file_hash(fpath)
            title = _extract_title(fpath)
            indexer.upsert(path=rel, title=title, content=content, hash=h)

            existing = meta.files.get(rel)
            if existing and existing.hash != h:
                meta.pending_changes.append(
                    PendingChange(
                        path=rel,
                        type=ChangeType.MODIFIED,
                        priority=ChangePriority.MEDIUM,
                        old_hash=existing.hash,
                        new_hash=h,
                    )
                )
                meta.files[rel] = FileMeta(hash=h)
            elif not existing:
                meta.pending_changes.append(
                    PendingChange(
                        path=rel,
                        type=ChangeType.ADDED,
                        priority=ChangePriority.HIGH,
                        new_hash=h,
                    )
                )
                meta.files[rel] = FileMeta(hash=h)
            ingested.append(rel)

        store.save_meta(meta)
        indexer.close()

        if not ingested:
            return "没有找到可入库的文件"
        return f"已入库 {len(ingested)} 个文件: {', '.join(ingested)}"


@tool_parameters({
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "查询字符串",
            "minLength": 1,
        },
        "top_k": {
            "type": "integer",
            "description": "返回的最大结果数（默认 5）",
            "minimum": 1,
            "maximum": 20,
        },
        "max_tokens": {
            "type": "integer",
            "description": "返回内容的最大 token 预算（默认 8000）",
            "minimum": 1000,
        },
        "instance": {
            "type": "string",
            "description": "知识库实例名，留空则使用默认实例",
        },
    },
    "required": ["query"],
})
class KbQueryTool(_KbTool):
    @property
    def name(self) -> str:
        return "kb_query"

    @property
    def description(self) -> str:
        return (
            "查询知识库，使用 FTS5 全文搜索定位相关文档，返回匹配内容。"
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        query: str,
        top_k: int = 5,
        max_tokens: int = 8000,
        instance: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not self._workspace:
            return "Error: workspace not configured"

        store = self._get_store(instance)
        indexer = self._get_indexer(store)
        results = indexer.search(query, top_k=top_k)
        indexer.close()

        if not results:
            return f"未找到与「{query}」相关的文档"

        parts: list[str] = []
        total_tokens = 0
        for row in results:
            rel_path = row["path"]
            title = row["title"]
            full_path = self._workspace / rel_path
            try:
                content = full_path.read_text(encoding="utf-8")
            except (FileNotFoundError, UnicodeDecodeError):
                continue
            tokens = _estimate_tokens(content)
            if total_tokens + tokens > max_tokens:
                break
            parts.append(f"### 📄 {title} ({rel_path})\n\n{content}")
            total_tokens += tokens

        if not parts:
            return f"未找到与「{query}」相关的文档"

        header = f"## 知识库搜索结果：{query}"
        footer = f"共 {len(parts)} 个结果，约 {total_tokens} tokens"
        return f"{header}\n\n" + "\n\n".join(parts) + f"\n\n{footer}"


@tool_parameters({
    "type": "object",
    "properties": {
        "instance": {
            "type": "string",
            "description": "知识库实例名，留空则使用默认实例",
        },
    },
})
class KbStatusTool(_KbTool):
    @property
    def name(self) -> str:
        return "kb_status"

    @property
    def description(self) -> str:
        return "查看知识库状态，包括模式、文档数、待编译变更数等信息。"

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        instance: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not self._workspace:
            return "Error: workspace not configured"

        store = self._get_store(instance)
        indexer = self._get_indexer(store)
        meta = store.load_meta()
        doc_count = indexer.get_doc_count()
        indexer.close()

        pending_count = len(meta.pending_changes)
        lines = [
            f"模式: {meta.mode.value}",
            f"文档数: {doc_count}",
            f"待编译变更: {pending_count}",
            f"索引路径: {store.db_path}",
        ]
        return "\n".join(lines)


@tool_parameters({
    "type": "object",
    "properties": {
        "paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "指定路径编译，留空则编译 pending_changes",
        },
        "all": {
            "type": "boolean",
            "description": "是否强制全量重新编译（慎用）",
        },
        "instance": {
            "type": "string",
            "description": "知识库实例名，留空则使用默认实例",
        },
    },
})
class KbCompileTool(_KbTool):
    @property
    def name(self) -> str:
        return "kb_compile"

    @property
    def description(self) -> str:
        return "手动编译 Wiki（仅 Document 模式可用）。Notebook 模式不支持编译。"

    async def execute(self, **kwargs: Any) -> Any:
        instance = kwargs.get("instance")
        compile_all = kwargs.get("all", False)
        store = self._get_store(instance)
        meta = store.load_meta()

        if meta.mode != KnowledgeMode.DOCUMENT:
            return "当前为 Notebook 模式，不支持 Wiki 编译"

        from mona.knowledge.compiler import IncrementalCompiler
        from mona.knowledge.wiki import WikiCompiler

        wiki = WikiCompiler(store, self._workspace)
        compiler = IncrementalCompiler(store, wiki, meta)

        if compile_all:
            meta.pending_changes = [
                PendingChange(
                    path=p,
                    type=ChangeType.ADDED,
                    priority=ChangePriority.HIGH,
                    new_hash=fm.hash,
                )
                for p, fm in meta.files.items()
            ]

        count = compiler.compile_pending()
        return f"Wiki 编译完成，共编译 {count} 个页面"
