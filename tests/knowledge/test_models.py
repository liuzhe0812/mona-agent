from __future__ import annotations

from datetime import datetime, timezone

from mona.knowledge.models import (
    ChangePriority,
    ChangeType,
    FileMeta,
    KnowledgeMeta,
    KnowledgeMode,
    PendingChange,
)


class TestKnowledgeMode:
    def test_document_value(self) -> None:
        assert KnowledgeMode.DOCUMENT == "document"

    def test_notebook_value(self) -> None:
        assert KnowledgeMode.NOTEBOOK == "notebook"

    def test_from_string(self) -> None:
        assert KnowledgeMode("document") is KnowledgeMode.DOCUMENT
        assert KnowledgeMode("notebook") is KnowledgeMode.NOTEBOOK


class TestChangeType:
    def test_added_value(self) -> None:
        assert ChangeType.ADDED == "added"

    def test_modified_value(self) -> None:
        assert ChangeType.MODIFIED == "modified"

    def test_deleted_value(self) -> None:
        assert ChangeType.DELETED == "deleted"

    def test_from_string(self) -> None:
        assert ChangeType("added") is ChangeType.ADDED
        assert ChangeType("modified") is ChangeType.MODIFIED
        assert ChangeType("deleted") is ChangeType.DELETED


class TestChangePriority:
    def test_low_value(self) -> None:
        assert ChangePriority.LOW == "low"

    def test_medium_value(self) -> None:
        assert ChangePriority.MEDIUM == "medium"

    def test_high_value(self) -> None:
        assert ChangePriority.HIGH == "high"

    def test_from_string(self) -> None:
        assert ChangePriority("low") is ChangePriority.LOW
        assert ChangePriority("medium") is ChangePriority.MEDIUM
        assert ChangePriority("high") is ChangePriority.HIGH


class TestFileMeta:
    def test_required_hash(self) -> None:
        meta = FileMeta(hash="abc123")
        assert meta.hash == "abc123"
        assert meta.compiled_at is None
        assert meta.wiki_pages == []
        assert meta.entities == []

    def test_all_fields(self) -> None:
        now = datetime(2025, 1, 1, tzinfo=timezone.utc)
        meta = FileMeta(
            hash="def456",
            compiled_at=now,
            wiki_pages=["Page1", "Page2"],
            entities=["Entity1"],
        )
        assert meta.hash == "def456"
        assert meta.compiled_at == now
        assert meta.wiki_pages == ["Page1", "Page2"]
        assert meta.entities == ["Entity1"]

    def test_camel_case_alias(self) -> None:
        data = {"hash": "abc", "compiledAt": "2025-06-01T00:00:00Z", "wikiPages": ["P1"]}
        meta = FileMeta.model_validate(data)
        assert meta.compiled_at is not None
        assert meta.wiki_pages == ["P1"]

    def test_snake_case_accepted(self) -> None:
        data = {"hash": "abc", "compiled_at": None, "wiki_pages": ["P1"]}
        meta = FileMeta.model_validate(data)
        assert meta.wiki_pages == ["P1"]

    def test_dump_by_alias(self) -> None:
        meta = FileMeta(hash="abc", compiled_at=None, wiki_pages=["P1"])
        dumped = meta.model_dump(by_alias=True)
        assert "compiledAt" in dumped
        assert "wikiPages" in dumped
        assert "compiled_at" not in dumped


class TestPendingChange:
    def test_required_fields(self) -> None:
        change = PendingChange(path="src/main.py", type=ChangeType.ADDED, priority=ChangePriority.HIGH)
        assert change.path == "src/main.py"
        assert change.type is ChangeType.ADDED
        assert change.priority is ChangePriority.HIGH
        assert change.old_hash is None
        assert change.new_hash is None
        assert isinstance(change.detected_at, datetime)

    def test_all_fields(self) -> None:
        now = datetime(2025, 6, 1, tzinfo=timezone.utc)
        change = PendingChange(
            path="src/util.py",
            type=ChangeType.MODIFIED,
            priority=ChangePriority.MEDIUM,
            old_hash="aaa",
            new_hash="bbb",
            detected_at=now,
        )
        assert change.old_hash == "aaa"
        assert change.new_hash == "bbb"
        assert change.detected_at == now

    def test_camel_case_alias(self) -> None:
        data = {
            "path": "src/main.py",
            "type": "deleted",
            "priority": "low",
            "oldHash": "old",
            "newHash": "new",
        }
        change = PendingChange.model_validate(data)
        assert change.type is ChangeType.DELETED
        assert change.priority is ChangePriority.LOW
        assert change.old_hash == "old"
        assert change.new_hash == "new"

    def test_dump_by_alias(self) -> None:
        change = PendingChange(
            path="a.py",
            type=ChangeType.MODIFIED,
            priority=ChangePriority.MEDIUM,
            old_hash="x",
            new_hash="y",
        )
        dumped = change.model_dump(by_alias=True)
        assert "oldHash" in dumped
        assert "newHash" in dumped
        assert "detectedAt" in dumped
        assert "old_hash" not in dumped


class TestKnowledgeMeta:
    def test_defaults(self) -> None:
        meta = KnowledgeMeta()
        assert meta.version == 1
        assert meta.mode is KnowledgeMode.DOCUMENT
        assert meta.files == {}
        assert meta.pending_changes == []
        assert meta.last_batch_compile is None

    def test_with_files_and_changes(self) -> None:
        file_meta = FileMeta(hash="h1", wiki_pages=["P1"])
        change = PendingChange(path="a.py", type=ChangeType.ADDED, priority=ChangePriority.HIGH)
        now = datetime(2025, 6, 1, tzinfo=timezone.utc)
        meta = KnowledgeMeta(
            version=2,
            mode=KnowledgeMode.NOTEBOOK,
            files={"a.py": file_meta},
            pending_changes=[change],
            last_batch_compile=now,
        )
        assert meta.version == 2
        assert meta.mode is KnowledgeMode.NOTEBOOK
        assert "a.py" in meta.files
        assert len(meta.pending_changes) == 1
        assert meta.last_batch_compile == now

    def test_camel_case_alias(self) -> None:
        data = {
            "version": 3,
            "mode": "notebook",
            "files": {"b.py": {"hash": "h2"}},
            "pendingChanges": [{"path": "b.py", "type": "modified", "priority": "medium"}],
            "lastBatchCompile": "2025-06-01T00:00:00Z",
        }
        meta = KnowledgeMeta.model_validate(data)
        assert meta.version == 3
        assert meta.mode is KnowledgeMode.NOTEBOOK
        assert "b.py" in meta.files
        assert len(meta.pending_changes) == 1
        assert meta.last_batch_compile is not None

    def test_dump_by_alias(self) -> None:
        meta = KnowledgeMeta(version=1, mode=KnowledgeMode.DOCUMENT)
        dumped = meta.model_dump(by_alias=True)
        assert "pendingChanges" in dumped
        assert "lastBatchCompile" in dumped
        assert "pending_changes" not in dumped
        assert "last_batch_compile" not in dumped

    def test_nested_file_meta_camel_case(self) -> None:
        data = {
            "files": {
                "readme.md": {
                    "hash": "abc",
                    "compiledAt": "2025-01-01T00:00:00Z",
                    "wikiPages": ["Intro"],
                    "entities": ["Project"],
                }
            }
        }
        meta = KnowledgeMeta.model_validate(data)
        file_meta = meta.files["readme.md"]
        assert file_meta.compiled_at is not None
        assert file_meta.wiki_pages == ["Intro"]
        assert file_meta.entities == ["Project"]

    def test_nested_pending_change_camel_case(self) -> None:
        data = {
            "pendingChanges": [
                {
                    "path": "x.py",
                    "type": "added",
                    "priority": "high",
                    "oldHash": None,
                    "newHash": "new1",
                }
            ]
        }
        meta = KnowledgeMeta.model_validate(data)
        change = meta.pending_changes[0]
        assert change.type is ChangeType.ADDED
        assert change.priority is ChangePriority.HIGH
        assert change.old_hash is None
        assert change.new_hash == "new1"
