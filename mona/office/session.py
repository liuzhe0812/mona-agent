"""In-memory state for one Mona Office editing session."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from mona.office.schemas import (
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCommandResult,
    OfficeDocumentType,
    OfficeErrorPayload,
    OfficeSaveState,
    OfficeSessionState,
    RevisionChange,
)


@dataclass(slots=True)
class OfficeSession:
    session_id: str
    owner_session_key: str
    document_type: OfficeDocumentType
    display_name: str
    session_dir: Path
    working_path: Path
    source_path: Path | None
    source_identity: str | None
    source_hash: str | None
    version: DocumentVersion
    checkpoint_version: DocumentVersion | None
    saved_version: DocumentVersion | None
    dirty: bool = False
    editor_connected: bool = False
    closed: bool = False
    save_state: OfficeSaveState = "clean"
    last_error: OfficeErrorPayload | None = None
    recent_changed_targets: list[str] = field(default_factory=list)
    pending_visual_slide_ids: list[str] = field(default_factory=list)
    revision_changes: list[RevisionChange] = field(default_factory=list)
    change_floor_revision: int = 0
    operation_commands: OrderedDict[str, str] = field(default_factory=OrderedDict)
    operation_results: OrderedDict[str, OfficeCommandResult] = field(default_factory=OrderedDict)

    def to_state(self) -> OfficeSessionState:
        return OfficeSessionState(
            session_id=self.session_id,
            display_name=self.display_name,
            type=self.document_type,
            version=self.version,
            checkpoint_version=self.checkpoint_version,
            saved_version=self.saved_version,
            dirty=self.dirty,
            editor_connected=self.editor_connected,
            save_state=self.save_state,
            last_error=self.last_error,
            pending_visual_slide_ids=self.pending_visual_slide_ids,
        )

    def remember_command(self, command: OfficeApplyCommand, *, limit: int) -> str:
        serialized = command.model_dump_json(by_alias=True)
        existing = self.operation_commands.get(command.operation_id)
        if existing is not None:
            return existing
        self.operation_commands[command.operation_id] = serialized
        self.operation_commands.move_to_end(command.operation_id)
        while len(self.operation_commands) > limit:
            operation_id, _ = self.operation_commands.popitem(last=False)
            self.operation_results.pop(operation_id, None)
        return serialized

    def remember_result(self, result: OfficeCommandResult, *, limit: int) -> None:
        self.operation_results[result.operation_id] = result
        self.operation_results.move_to_end(result.operation_id)
        while len(self.operation_results) > limit:
            operation_id, _ = self.operation_results.popitem(last=False)
            self.operation_commands.pop(operation_id, None)
