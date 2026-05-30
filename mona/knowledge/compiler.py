from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol, runtime_checkable

from loguru import logger

from mona.knowledge.models import (
    ChangePriority,
    ChangeType,
    KnowledgeMeta,
    PendingChange,
)
from mona.knowledge.store import KnowledgeStore


@runtime_checkable
class WikiCompiler(Protocol):
    def compile_batch(
        self, changes: list[PendingChange], meta: KnowledgeMeta
    ) -> int: ...


class ChangeClassifier:
    def __init__(
        self,
        minor_threshold: float = 0.1,
        moderate_threshold: float = 0.5,
    ) -> None:
        self.minor_threshold = minor_threshold
        self.moderate_threshold = moderate_threshold

    def classify(
        self,
        path: str,
        old_hash: str | None,
        new_hash: str | None,
        diff_ratio: float = 0.0,
    ) -> PendingChange:
        if old_hash is None and new_hash is not None:
            change_type = ChangeType.ADDED
            priority = ChangePriority.HIGH
        elif new_hash is None and old_hash is not None:
            change_type = ChangeType.DELETED
            priority = ChangePriority.MEDIUM
        else:
            change_type = ChangeType.MODIFIED
            if diff_ratio < self.minor_threshold:
                priority = ChangePriority.LOW
            elif diff_ratio < self.moderate_threshold:
                priority = ChangePriority.MEDIUM
            else:
                priority = ChangePriority.HIGH

        return PendingChange(
            path=path,
            type=change_type,
            priority=priority,
            old_hash=old_hash,
            new_hash=new_hash,
        )


class IncrementalCompiler:
    def __init__(
        self,
        store: KnowledgeStore,
        wiki: WikiCompiler,
        meta: KnowledgeMeta,
    ) -> None:
        self.store = store
        self.wiki = wiki
        self.meta = meta

    def get_compilable_changes(self) -> list[PendingChange]:
        return [
            c
            for c in self.meta.pending_changes
            if c.type in (ChangeType.ADDED, ChangeType.DELETED)
            or c.priority != ChangePriority.LOW
        ]

    def compile_pending(self) -> int:
        changes = self.get_compilable_changes()
        if not changes:
            return 0

        compiled = self.wiki.compile_batch(changes, self.meta)
        compiled_count = len(compiled) if isinstance(compiled, list) else int(compiled)

        compiled_paths = {c.path for c in changes}
        self.meta.pending_changes = [
            c for c in self.meta.pending_changes if c.path not in compiled_paths
        ]
        self.meta.last_batch_compile = datetime.now(UTC)
        self.store.save_meta(self.meta)

        logger.info(
            "Incremental compile done: {} pages from {} changes",
            compiled_count,
            len(changes),
        )
        return compiled_count
