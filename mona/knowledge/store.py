from __future__ import annotations

import json
from pathlib import Path

from loguru import logger

from mona.knowledge.models import KnowledgeMeta, KnowledgeMode


class KnowledgeStore:
    def __init__(self, root: Path, mode: KnowledgeMode) -> None:
        self.root = root
        self.mode = mode

    def ensure_dirs(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        if self.mode is KnowledgeMode.DOCUMENT:
            self.wiki_dir.mkdir(parents=True, exist_ok=True)

    @property
    def db_path(self) -> Path:
        return self.root / "index.db"

    @property
    def meta_path(self) -> Path:
        return self.root / "meta.json"

    @property
    def wiki_dir(self) -> Path:
        return self.root / "wiki"

    def load_meta(self) -> KnowledgeMeta:
        try:
            text = self.meta_path.read_text(encoding="utf-8")
            return KnowledgeMeta.model_validate_json(text)
        except (FileNotFoundError, json.JSONDecodeError, ValueError):
            logger.error("Failed to load knowledge meta from {}", self.meta_path)
            return KnowledgeMeta(mode=self.mode)

    def save_meta(self, meta: KnowledgeMeta) -> None:
        self.meta_path.write_text(
            meta.model_dump_json(indent=2),
            encoding="utf-8",
        )
