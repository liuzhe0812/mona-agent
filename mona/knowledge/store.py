from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from loguru import logger

from mona.knowledge.models import (
    KnowledgeGraph,
    SourceManifest,
    VaultMeta,
    WikiPage,
)


class VaultStore:
    """Manages the three-layer vault filesystem: raw/, wiki/, state/."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.raw_dir = root / "raw" / "sources"
        self.wiki_dir = root / "wiki"
        self.state_dir = root / "state"
        self.meta_path = self.state_dir / "meta.json"
        self.graph_path = self.state_dir / "graph.json"
        self.manifests_dir = self.state_dir / "manifests"

    def ensure_dirs(self) -> None:
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.wiki_dir.mkdir(parents=True, exist_ok=True)
        (self.wiki_dir / "sources").mkdir(exist_ok=True)
        (self.wiki_dir / "concepts").mkdir(exist_ok=True)
        (self.wiki_dir / "entities").mkdir(exist_ok=True)
        (self.wiki_dir / "outputs").mkdir(exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.manifests_dir.mkdir(parents=True, exist_ok=True)

    def load_meta(self) -> VaultMeta:
        if self.meta_path.exists():
            try:
                data = json.loads(self.meta_path.read_text(encoding="utf-8"))
                return VaultMeta.model_validate(data)
            except Exception:
                logger.warning("Failed to load meta.json, creating new")
        return VaultMeta(name=self.root.name)

    def save_meta(self, meta: VaultMeta) -> None:
        self.meta_path.write_text(
            meta.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def load_graph(self) -> KnowledgeGraph:
        if self.graph_path.exists():
            try:
                data = json.loads(self.graph_path.read_text(encoding="utf-8"))
                return KnowledgeGraph.model_validate(data)
            except Exception:
                logger.warning("Failed to load graph.json, creating new")
        return KnowledgeGraph()

    def save_graph(self, graph: KnowledgeGraph) -> None:
        self.graph_path.write_text(
            graph.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def load_manifest(self, source_id: str) -> SourceManifest | None:
        path = self.manifests_dir / f"{source_id}.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return SourceManifest.model_validate(data)
        except Exception:
            logger.warning("Failed to load manifest for {}", source_id)
            return None

    def save_manifest(self, manifest: SourceManifest) -> None:
        path = self.manifests_dir / f"{manifest.id}.json"
        path.write_text(
            manifest.model_dump_json(indent=2),
            encoding="utf-8",
        )

    def list_manifests(self) -> list[SourceManifest]:
        results: list[SourceManifest] = []
        if not self.manifests_dir.exists():
            return results
        for path in self.manifests_dir.glob("*.json"):
            m = self.load_manifest(path.stem)
            if m:
                results.append(m)
        return results

    def ingest_file(self, source_path: Path) -> SourceManifest | None:
        """Copy file to raw/ and create manifest."""
        if not source_path.exists():
            logger.warning("Source file not found: {}", source_path)
            return None

        content = source_path.read_bytes()
        content_hash = hashlib.sha256(content).hexdigest()[:16]
        source_id = f"{source_path.stem}_{content_hash[:8]}"

        target_path = self.raw_dir / source_path.name
        shutil.copy2(source_path, target_path)

        kind = _infer_source_kind(source_path)
        extracted = _extract_text(source_path, content, kind)

        manifest = SourceManifest(
            id=source_id,
            title=source_path.stem,
            origin_path=str(source_path),
            kind=kind,
            content_hash=content_hash,
            extracted_text=extracted,
            word_count=len(extracted.split()) if extracted else 0,
        )
        self.save_manifest(manifest)

        meta = self.load_meta()
        meta.source_count += 1
        if source_id not in meta.pending_sources:
            meta.pending_sources.append(source_id)
        self.save_meta(meta)

        logger.info("Ingested: {} -> {}", source_path.name, source_id)
        return manifest

    def write_wiki_page(self, page: WikiPage, rel_path: str) -> Path:
        """Write a wiki page to wiki/{rel_path}."""
        path = self.wiki_dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(page.to_markdown(), encoding="utf-8")
        return path

    def read_wiki_page(self, rel_path: str) -> WikiPage | None:
        path = self.wiki_dir / rel_path
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        return WikiPage.from_markdown(text, rel_path)

    def list_wiki_pages(self) -> list[str]:
        """Return list of relative paths to all wiki pages."""
        if not self.wiki_dir.exists():
            return []
        results: list[str] = []
        for path in self.wiki_dir.rglob("*.md"):
            rel = path.relative_to(self.wiki_dir).as_posix()
            results.append(rel)
        return sorted(results)

    def update_index(self, pages: list[WikiPage]) -> None:
        """Regenerate wiki/index.md with catalog of all pages."""
        lines = ["# 知识库索引", ""]
        by_kind: dict[str, list[WikiPage]] = {}
        for page in pages:
            by_kind.setdefault(page.kind.value, []).append(page)

        for kind in ["source", "concept", "entity", "output"]:
            if kind not in by_kind:
                continue
            lines.append(f"## {kind.capitalize()} 页面")
            lines.append("")
            for page in sorted(by_kind[kind], key=lambda p: p.title):
                lines.append(f"- [[{page.title}]]")
            lines.append("")

        index_path = self.wiki_dir / "index.md"
        index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _infer_source_kind(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".md", ".mdx"):
        return "markdown"
    if ext in (
        ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java",
        ".c", ".cpp", ".h", ".rb", ".php", ".sh", ".bash", ".ps1",
        ".swift", ".kt", ".scala", ".dart", ".lua", ".zig",
        ".html", ".css", ".vue", ".svelte", ".sql", ".r",
    ):
        return "code"
    if ext in (".txt", ".rst", ".org", ".adoc", ".asciidoc"):
        return "text"
    if ext == ".pdf":
        return "pdf"
    if ext in (".html", ".htm"):
        return "html"
    if ext in (".docx", ".doc"):
        return "docx"
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"):
        return "image"
    if ext in (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"):
        return "audio"
    if ext in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
        return "video"
    return "binary"


def _extract_text(path: Path, content: bytes, kind: str) -> str | None:
    if kind in ("markdown", "text", "code", "html"):
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            return None
    return None
