from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import (
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCheckpointMetadata,
    OfficeCommandSuccess,
)


def _create_sheet_session(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "input.xlsx"
    source.write_bytes(b"initial workbook")
    manager = OfficeSessionManager(sessions_root=tmp_path / "data" / "office" / "sessions")
    session = manager.create_session(
        owner_session_key="chat:1",
        document_type="sheets",
        workspace_root=workspace,
        source_path=source,
    )
    return manager, session, source


def test_create_session_copies_source_into_private_data_dir(tmp_path: Path) -> None:
    manager, session, source = _create_sheet_session(tmp_path)

    assert session.working_path.read_bytes() == source.read_bytes()
    assert session.source_hash == hashlib.sha256(source.read_bytes()).hexdigest()
    assert session.checkpoint_version == session.version
    assert session.saved_version == session.version
    assert not session.dirty
    assert manager.get_session(session.session_id, owner_session_key="chat:1") is session
    assert (session.session_dir / "session.json").is_file()


def test_list_sessions_is_isolated_by_owner(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")
    first = manager.create_session(
        owner_session_key="chat:1",
        document_type="sheets",
        workspace_root=workspace,
    )
    manager.create_session(
        owner_session_key="chat:2",
        document_type="docs",
        workspace_root=workspace,
    )

    assert manager.list_sessions(owner_session_key="chat:1") == [first]
    assert manager.list_sessions(owner_session_key="chat:missing") == []


@pytest.mark.parametrize(
    ("document_type", "extension"),
    [("docs", ".docx"), ("sheets", ".xlsx"), ("slides", ".pptx")],
)
def test_create_blank_session_uses_bundled_native_template(
    tmp_path: Path,
    document_type: str,
    extension: str,
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")

    session = manager.create_session(
        owner_session_key="chat:1",
        document_type=document_type,
        workspace_root=workspace,
    )

    template = (
        Path(__file__).parents[2]
        / "src-tauri"
        / "resources"
        / "office-editor"
        / "templates"
        / f"blank{extension}"
    )
    assert session.working_path.read_bytes() == template.read_bytes()
    assert session.checkpoint_version == session.version
    assert session.saved_version is None
    assert session.dirty
    assert session.save_state == "dirty"


def test_create_blank_session_normalizes_the_visible_native_file_name(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")

    session = manager.create_session(
        owner_session_key="chat:1",
        document_type="sheets",
        workspace_root=workspace,
        display_name="年度销售表",
    )

    assert session.display_name == "年度销售表.xlsx"


def test_create_blank_session_rejects_a_mismatched_visible_extension(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")

    with pytest.raises(OfficeError) as error:
        manager.create_session(
            owner_session_key="chat:1",
            document_type="docs",
            workspace_root=workspace,
            display_name="年度方案.xlsx",
        )

    assert error.value.code == OfficeErrorCode.INVALID_OPERATION


def test_manager_recovers_persisted_session_with_editor_disconnected(tmp_path: Path) -> None:
    manager, session, source = _create_sheet_session(tmp_path)
    revision = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=1,
    )
    manager.record_editor_version(
        session.session_id,
        revision,
        changed_targets=["Sheet1!A1"],
    )

    recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)
    recovered = recovered_manager.get_session(
        session.session_id,
        owner_session_key="chat:1",
    )

    assert recovered.working_path.read_bytes() == source.read_bytes()
    assert recovered.version == recovered.checkpoint_version
    assert recovered.last_error is not None
    assert recovered.last_error.code == OfficeErrorCode.CHECKPOINT_FAILED
    assert "未保存修改未能恢复" in recovered.last_error.message
    assert not recovered.editor_connected
    assert recovered.revision_changes == []


def test_manager_warns_when_recovered_source_changed(tmp_path: Path) -> None:
    manager, session, source = _create_sheet_session(tmp_path)
    source.write_bytes(b"changed outside Mona")

    recovered = OfficeSessionManager(sessions_root=manager.sessions_root).get_session(
        session.session_id,
        owner_session_key="chat:1",
    )

    assert recovered.last_error is not None
    assert recovered.last_error.code == OfficeErrorCode.SAVE_CONFLICT
    assert "源文件已被其他程序修改" in recovered.last_error.message


def test_closed_session_is_not_recovered(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    manager.close_session(session.session_id)

    recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)

    with pytest.raises(OfficeError) as error:
        recovered_manager.get_session(session.session_id, owner_session_key="chat:1")
    assert error.value.code == OfficeErrorCode.SESSION_NOT_FOUND


def test_corrupt_session_metadata_returns_recovery_error(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    (session.session_dir / "session.json").write_text("{broken", encoding="utf-8")

    recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)

    with pytest.raises(OfficeError) as error:
        recovered_manager.get_session(session.session_id, owner_session_key="chat:1")

    assert error.value.code == OfficeErrorCode.CHECKPOINT_FAILED
    assert session.session_id in error.value.message


def test_corrupt_source_identity_returns_recovery_error(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    metadata_path = session.session_dir / "session.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["sourceIdentity"] = 42
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)

    with pytest.raises(OfficeError) as error:
        recovered_manager.get_session(session.session_id, owner_session_key="chat:1")

    assert error.value.code == OfficeErrorCode.CHECKPOINT_FAILED
    assert session.session_id in error.value.message


def test_missing_checkpoint_file_returns_recovery_error(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    session.working_path.unlink()

    recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)

    with pytest.raises(OfficeError) as error:
        recovered_manager.get_session(session.session_id, owner_session_key="chat:1")

    assert error.value.code == OfficeErrorCode.CHECKPOINT_FAILED
    assert "checkpoint file is missing" in error.value.message


def test_create_session_rejects_source_outside_allowed_roots(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = tmp_path / "outside.xlsx"
    source.write_bytes(b"outside")
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")

    with pytest.raises(OfficeError) as error:
        manager.create_session(
            owner_session_key="chat:1",
            document_type="sheets",
            workspace_root=workspace,
            source_path=source,
        )

    assert error.value.code == OfficeErrorCode.INVALID_OPERATION


def test_editor_versions_are_monotonic_and_bound_to_epoch(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    manager.connect_editor(session.session_id, session.version)
    revision_one = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=1,
    )

    assert manager.record_editor_version(
        session.session_id,
        revision_one,
        changed_targets=["Sheet1!A1"],
    )
    assert not manager.record_editor_version(session.session_id, revision_one)

    with pytest.raises(OfficeError) as error:
        manager.record_editor_version(
            session.session_id,
            DocumentVersion(editor_epoch="epoch_old", model_revision=99),
        )

    assert error.value.code == OfficeErrorCode.VERSION_CONFLICT
    assert session.version == revision_one


def test_command_uses_editor_result_as_authoritative_version_and_is_idempotent(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        manager, session, _ = _create_sheet_session(tmp_path)
        manager.connect_editor(session.session_id, session.version)
        command = OfficeApplyCommand(
            session_id=session.session_id,
            operation_id="op_1",
            expected_version=session.version,
            operations=[
                {
                    "op": "set_cell",
                    "payload": {"sheet": "Sheet1", "cell": "A1", "value": "updated"},
                }
            ],
        )
        send_count = 0

        async def send(outgoing: OfficeApplyCommand) -> None:
            nonlocal send_count
            send_count += 1
            result = OfficeCommandSuccess(
                ok=True,
                session_id=session.session_id,
                operation_id=outgoing.operation_id,
                version=DocumentVersion(
                    editor_epoch=session.version.editor_epoch,
                    model_revision=7,
                ),
                changed_targets=["Sheet1!A1"],
                summary="updated",
            )
            asyncio.get_running_loop().call_soon(manager.complete_command, result)

        first = await manager.execute_command(command, send)
        second = await manager.execute_command(command, send)

        assert first == second
        assert send_count == 1
        assert session.version.model_revision == 7
        assert session.dirty

    asyncio.run(run())


@pytest.mark.parametrize("invalid", [None, "version", "targets"])
def test_command_no_change_keeps_version_and_clean_state(tmp_path: Path, invalid: str | None) -> None:
    async def run() -> None:
        manager, session, _ = _create_sheet_session(tmp_path)
        manager.connect_editor(session.session_id, session.version)
        original_version = session.version
        command = OfficeApplyCommand(
            session_id=session.session_id, operation_id="no_change", expected_version=session.version,
            operations=[{"op": "set_cell", "payload": {"sheet": "Sheet1", "cell": "A1", "value": 1}}],
        )

        async def send(outgoing: OfficeApplyCommand) -> None:
            result = OfficeCommandSuccess(
                ok=True, session_id=session.session_id, operation_id=outgoing.operation_id,
                version=DocumentVersion(editor_epoch=session.version.editor_epoch,
                    model_revision=session.version.model_revision + (1 if invalid == "version" else 0)),
                changed_targets=["Sheet1!A1"] if invalid == "targets" else [],
                unchanged=True, summary="Already matches",
            )
            manager.complete_command(result)

        if invalid is None:
            result = await manager.execute_command(command, send)
            assert result.ok
            assert result.unchanged
        else:
            with pytest.raises(OfficeError) as error:
                await manager.execute_command(command, send)
            assert error.value.code == OfficeErrorCode.VERSION_CONFLICT
        assert session.version == original_version
        assert not session.dirty
        assert not session.revision_changes

    asyncio.run(run())


def test_command_precheck_rejects_stale_version_without_sending(tmp_path: Path) -> None:
    async def run() -> None:
        manager, session, _ = _create_sheet_session(tmp_path)
        manager.connect_editor(session.session_id, session.version)
        manager.record_editor_version(
            session.session_id,
            DocumentVersion(
                editor_epoch=session.version.editor_epoch,
                model_revision=1,
            ),
            changed_targets=["Sheet1!B2"],
        )
        command = OfficeApplyCommand(
            session_id=session.session_id,
            operation_id="op_stale",
            expected_version=DocumentVersion(
                editor_epoch=session.version.editor_epoch,
                model_revision=0,
            ),
            operations=[
                {
                    "op": "clear_range",
                    "payload": {"sheet": "Sheet1", "range": "A1:A2"},
                }
            ],
        )

        async def send(_: OfficeApplyCommand) -> None:
            raise AssertionError("stale command must not be sent")

        result = await manager.execute_command(command, send)

        assert not result.ok
        assert result.error.code == OfficeErrorCode.VERSION_CONFLICT
        assert result.current_version == session.version
        assert result.changed_targets == ["Sheet1!B2"]

    asyncio.run(run())


def test_checkpoint_failure_preserves_previous_file_and_version(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    previous = session.working_path.read_bytes()
    previous_version = session.checkpoint_version
    version = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=1,
    )
    manager.record_editor_version(session.session_id, version)
    payload = b"replacement workbook"
    metadata = OfficeCheckpointMetadata(
        session_id=session.session_id,
        version=version,
        size=len(payload),
        sha256="0" * 64,
    )

    with pytest.raises(OfficeError) as error:
        manager.write_checkpoint(metadata, [payload])

    assert error.value.code == OfficeErrorCode.CHECKPOINT_FAILED
    assert session.working_path.read_bytes() == previous
    assert session.checkpoint_version == previous_version


def test_checkpoint_atomically_advances_only_the_serialized_version(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    serialized_version = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=1,
    )
    manager.record_editor_version(session.session_id, serialized_version)
    manager.record_editor_version(
        session.session_id,
        DocumentVersion(
            editor_epoch=session.version.editor_epoch,
            model_revision=2,
        ),
    )
    payload = b"serialized revision one"
    metadata = OfficeCheckpointMetadata(
        session_id=session.session_id,
        version=serialized_version,
        size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
    )

    receipt = manager.write_checkpoint(metadata, [payload[:5], payload[5:]])

    assert session.working_path.read_bytes() == payload
    assert session.checkpoint_version == serialized_version
    assert session.version.model_revision == 2
    assert receipt.working_file_name == "working.xlsx"


def test_stale_checkpoint_cannot_overwrite_newer_working_file(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    revision_one = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=1,
    )
    revision_two = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=2,
    )
    manager.record_editor_version(session.session_id, revision_one)
    manager.record_editor_version(session.session_id, revision_two)
    newest = b"revision two"
    manager.write_checkpoint(
        OfficeCheckpointMetadata(
            session_id=session.session_id,
            version=revision_two,
            size=len(newest),
            sha256=hashlib.sha256(newest).hexdigest(),
        ),
        [newest],
    )
    stale = b"revision one"

    with pytest.raises(OfficeError) as error:
        manager.write_checkpoint(
            OfficeCheckpointMetadata(
                session_id=session.session_id,
                version=revision_one,
                size=len(stale),
                sha256=hashlib.sha256(stale).hexdigest(),
            ),
            [stale],
        )

    assert error.value.code == OfficeErrorCode.VERSION_CONFLICT
    assert session.working_path.read_bytes() == newest
    assert session.checkpoint_version == revision_two


def test_new_editor_epoch_invalidates_old_versions_and_preserves_dirty_state(
    tmp_path: Path,
) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    old_version = session.version
    manager.record_editor_version(
        session.session_id,
        DocumentVersion(
            editor_epoch=old_version.editor_epoch,
            model_revision=1,
        ),
    )
    payload = b"dirty checkpoint"
    manager.write_checkpoint(
        OfficeCheckpointMetadata(
            session_id=session.session_id,
            version=session.version,
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        ),
        [payload],
    )

    new_version = manager.begin_editor_epoch(session.session_id)

    assert new_version.editor_epoch != old_version.editor_epoch
    assert new_version.model_revision == 0
    assert session.dirty
    assert session.saved_version is None
    with pytest.raises(OfficeError) as error:
        manager.connect_editor(session.session_id, old_version)
    assert error.value.code == OfficeErrorCode.VERSION_CONFLICT


def test_overwrite_source_rejects_external_changes(tmp_path: Path) -> None:
    manager, session, source = _create_sheet_session(tmp_path)
    source.write_bytes(b"changed outside Mona")

    with pytest.raises(OfficeError) as error:
        manager.save(session.session_id, overwrite_source=True)

    assert error.value.code == OfficeErrorCode.SAVE_CONFLICT
    assert source.read_bytes() == b"changed outside Mona"


def test_export_stays_inside_workspace_and_marks_checkpoint_saved(tmp_path: Path) -> None:
    manager, session, _ = _create_sheet_session(tmp_path)
    workspace = tmp_path / "workspace"
    output = manager.export(
        session.session_id,
        output_path="output/exported.xlsx",
        workspace_root=workspace,
    )

    assert output == (workspace / "output" / "exported.xlsx").resolve()
    assert output.read_bytes() == session.working_path.read_bytes()
    assert session.saved_version == session.checkpoint_version

    with pytest.raises(OfficeError) as error:
        manager.export(
            session.session_id,
            output_path=tmp_path / "escape.xlsx",
            workspace_root=workspace,
        )
    assert error.value.code == OfficeErrorCode.INVALID_OPERATION
