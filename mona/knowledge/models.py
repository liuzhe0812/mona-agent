from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import Field

from mona.config.schema import Base


class KnowledgeMode(StrEnum):
    DOCUMENT = "document"
    NOTEBOOK = "notebook"


class ChangeType(StrEnum):
    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"


class ChangePriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class FileMeta(Base):
    hash: str
    compiled_at: datetime | None = None
    wiki_pages: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)


class PendingChange(Base):
    path: str
    type: ChangeType
    priority: ChangePriority
    old_hash: str | None = None
    new_hash: str | None = None
    detected_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class KnowledgeMeta(Base):
    version: int = 1
    mode: KnowledgeMode = KnowledgeMode.DOCUMENT
    files: dict[str, FileMeta] = Field(default_factory=dict)
    pending_changes: list[PendingChange] = Field(default_factory=list)
    last_batch_compile: datetime | None = None
