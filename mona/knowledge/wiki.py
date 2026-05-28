from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

from loguru import logger

from mona.knowledge.models import ChangeType, FileMeta, KnowledgeMeta, PendingChange
from mona.knowledge.store import KnowledgeStore


class WikiCompiler:
    def __init__(self, store: KnowledgeStore, workspace: Path) -> None:
        self.store = store
        self.workspace = workspace
        self.wiki_dir = store.wiki_dir

    def compile_batch(
        self, changes: list[PendingChange], meta: KnowledgeMeta
    ) -> list[str]:
        compiled: list[str] = []
        for change in changes:
            filename = self._compile_single(change, meta)
            if filename:
                compiled.append(filename)
        self._update_backlinks()
        self._update_index(meta)
        return compiled

    def _compile_single(
        self, change: PendingChange, meta: KnowledgeMeta
    ) -> str | None:
        if change.type is ChangeType.DELETED:
            return None

        file_path = self.workspace / change.path
        try:
            content = file_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            logger.warning("Source file not found: {}", change.path)
            return None

        title = self._extract_title(file_path)
        filename = self._make_filename(change.path)
        tags = self._extract_tags(content)
        source_files = [change.path]

        page = self._build_wiki_page(title, content, source_files, tags)
        target = self.wiki_dir / filename
        target.write_text(page, encoding="utf-8")

        file_meta = meta.files.get(change.path)
        if file_meta is None:
            file_meta = FileMeta(hash="")
            meta.files[change.path] = file_meta

        file_meta.compiled_at = datetime.now(UTC)
        if filename not in file_meta.wiki_pages:
            file_meta.wiki_pages.append(filename)

        logger.info("Compiled wiki page: {} -> {}", change.path, filename)
        return filename

    def _build_wiki_page(
        self,
        title: str,
        content: str,
        source_files: list[str],
        tags: list[str],
    ) -> str:
        compiled_at = datetime.now(UTC).isoformat()
        source_lines = "\n".join(f"  - {s}" for s in source_files)
        tag_line = ", ".join(tags) if tags else ""
        frontmatter = (
            "---\n"
            f"title: {title}\n"
            f"source_files:\n{source_lines}\n"
            f"tags: [{tag_line}]\n"
            f"compiled_at: {compiled_at}\n"
            "---\n"
        )
        body = f"# {title}\n\n{content}\n\n## 相关链接\n\n## 反向链接\n\n"
        return frontmatter + body

    def _extract_title(self, path: Path) -> str:
        try:
            first_line = path.read_text(encoding="utf-8").splitlines()[0]
            return first_line.lstrip("# ").strip()
        except (FileNotFoundError, IndexError):
            return path.stem

    def _make_filename(self, rel_path: str) -> str:
        stem = Path(rel_path).stem.lower().replace(" ", "-")
        return f"{stem}.md"

    def _extract_tags(self, content: str) -> list[str]:
        tags: list[str] = []
        for line in content.splitlines():
            stripped = line.strip()
            if re.match(r"^[Tt]ags:\s*", stripped):
                tag_part = re.sub(r"^[Tt]ags:\s*", "", stripped)
                tags.extend(
                    t.strip() for t in tag_part.split(",") if t.strip()
                )
        return tags

    def _update_backlinks(self) -> None:
        link_map: dict[str, list[str]] = {}
        wiki_files = list(self.wiki_dir.glob("*.md"))

        for wiki_file in wiki_files:
            try:
                text = wiki_file.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue

            in_related = False
            source_filename = wiki_file.name
            for line in text.splitlines():
                if line.strip() == "## 相关链接":
                    in_related = True
                    continue
                if line.startswith("## "):
                    in_related = False
                    continue
                if in_related:
                    match = re.search(r"\]\(([^)]+\.md)\)", line)
                    if match:
                        target = match.group(1)
                        link_map.setdefault(target, [])
                        if source_filename not in link_map[target]:
                            link_map[target].append(source_filename)

        for wiki_file in wiki_files:
            try:
                text = wiki_file.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue

            backlinks = link_map.get(wiki_file.name, [])
            lines = text.splitlines()
            new_lines: list[str] = []
            in_backlinks = False
            backlinks_written = False

            for line in lines:
                if line.strip() == "## 反向链接":
                    in_backlinks = True
                    new_lines.append(line)
                    for bl in backlinks:
                        new_lines.append(f"- [{bl}]({bl})")
                    backlinks_written = True
                    continue
                if in_backlinks and line.startswith("## "):
                    in_backlinks = False
                    new_lines.append(line)
                    continue
                if in_backlinks:
                    continue
                new_lines.append(line)

            if not backlinks_written:
                new_lines.append("## 反向链接")
                for bl in backlinks:
                    new_lines.append(f"- [{bl}]({bl})")

            wiki_file.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    def _update_index(self, meta: KnowledgeMeta) -> None:
        wiki_files = sorted(self.wiki_dir.glob("*.md"))
        index_files = [f for f in wiki_files if f.name != "_index.md"]

        lines = ["# 知识库概览", "", "## 主要主题", ""]
        for wf in index_files:
            try:
                text = wf.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            title = wf.stem
            for tline in text.splitlines():
                if tline.startswith("title:"):
                    title = tline.removeprefix("title:").strip()
                    break
            lines.append(f"- [{title}]({wf.name})")

        index_path = self.wiki_dir / "_index.md"
        index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
