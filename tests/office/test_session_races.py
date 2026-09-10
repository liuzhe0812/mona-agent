from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import (
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCommandFailure,
    OfficeCommandSuccess,
    OfficeErrorPayload,
)


def _create_sheet_session(tmp_path: Path) -> tuple[OfficeSessionManager, object]:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = OfficeSessionManager(sessions_root=tmp_path / "sessions")
    session = manager.create_session(
        owner_session_key="chat:1",
        document_type="sheets",
        workspace_root=workspace,
    )
    manager.connect_editor(session.session_id, session.version)
    return manager, session


def _set_cell_command(
    session_id: str,
    operation_id: str,
    version: DocumentVersion,
    *,
    cell: str = "A1",
    value: str = "value",
) -> OfficeApplyCommand:
    return OfficeApplyCommand(
        session_id=session_id,
        operation_id=operation_id,
        expected_version=version,
        operations=[
            {
                "op": "set_cell",
                "payload": {"sheet": "Sheet1", "cell": cell, "value": value},
            }
        ],
    )


def _success_result(
    command: OfficeApplyCommand,
    version: DocumentVersion,
) -> OfficeCommandSuccess:
    return OfficeCommandSuccess(
        ok=True,
        session_id=command.session_id,
        operation_id=command.operation_id,
        version=version,
        changed_targets=["Sheet1!A1"],
    )


def _conflict_result(
    command: OfficeApplyCommand,
    current_version: DocumentVersion,
) -> OfficeCommandFailure:
    return OfficeCommandFailure(
        ok=False,
        session_id=command.session_id,
        operation_id=command.operation_id,
        current_version=current_version,
        changed_targets=["Sheet1!B2"],
        error=OfficeErrorPayload(
            code=OfficeErrorCode.VERSION_CONFLICT,
            message="Editor document changed before apply.",
            retryable=True,
        ),
    )


async def test_editor_conflicts_update_stale_manager_mirror_1000_times(
    tmp_path: Path,
) -> None:
    manager, session = _create_sheet_session(tmp_path)
    send_count = 0

    for index in range(1000):
        expected_version = session.version
        command = _set_cell_command(
            session.session_id,
            f"race-{index}",
            expected_version,
            value=f"value-{index}",
        )

        async def send(outgoing: OfficeApplyCommand) -> None:
            nonlocal send_count
            send_count += 1
            assert outgoing == command
            assert session.version == expected_version
            current_version = DocumentVersion(
                editor_epoch=expected_version.editor_epoch,
                model_revision=expected_version.model_revision + 1,
            )
            result = _conflict_result(outgoing, current_version)
            asyncio.get_running_loop().call_soon(manager.complete_command, result)

        result = await manager.execute_command(command, send)

        assert not result.ok
        assert result.error.code == OfficeErrorCode.VERSION_CONFLICT
        assert result.current_version.model_revision == expected_version.model_revision + 1
        assert session.version == result.current_version

    assert send_count == 1000


async def test_duplicate_operation_submission_sends_once(tmp_path: Path) -> None:
    manager, session = _create_sheet_session(tmp_path)
    command = _set_cell_command(session.session_id, "duplicate-1", session.version)
    send_count = 0

    async def send(outgoing: OfficeApplyCommand) -> None:
        nonlocal send_count
        send_count += 1
        manager.complete_command(
            _success_result(
                outgoing,
                DocumentVersion(
                    editor_epoch=outgoing.expected_version.editor_epoch,
                    model_revision=outgoing.expected_version.model_revision + 1,
                ),
            )
        )

    first, second = await asyncio.gather(
        manager.execute_command(command, send),
        manager.execute_command(command, send),
    )

    assert first == second
    assert send_count == 1


async def test_operation_id_with_different_command_is_rejected(tmp_path: Path) -> None:
    manager, session = _create_sheet_session(tmp_path)
    first_command = _set_cell_command(session.session_id, "same-id", session.version)
    different_command = _set_cell_command(
        session.session_id,
        "same-id",
        session.version,
        cell="B1",
        value="different",
    )
    send_count = 0

    async def send(outgoing: OfficeApplyCommand) -> None:
        nonlocal send_count
        send_count += 1
        manager.complete_command(
            _success_result(
                outgoing,
                DocumentVersion(
                    editor_epoch=outgoing.expected_version.editor_epoch,
                    model_revision=1,
                ),
            )
        )

    await manager.execute_command(first_command, send)

    with pytest.raises(OfficeError) as error:
        await manager.execute_command(different_command, send)

    assert error.value.code == OfficeErrorCode.INVALID_OPERATION
    assert send_count == 1


async def test_old_epoch_result_does_not_advance_current_version(
    tmp_path: Path,
) -> None:
    manager, session = _create_sheet_session(tmp_path)
    old_version = session.version
    command = _set_cell_command(session.session_id, "old-epoch", old_version)
    send_started = asyncio.Event()
    release_send = asyncio.Event()

    async def send(_: OfficeApplyCommand) -> None:
        send_started.set()
        await release_send.wait()

    command_task = asyncio.create_task(manager.execute_command(command, send, timeout=1))
    await send_started.wait()
    current_version = manager.begin_editor_epoch(session.session_id)
    release_send.set()

    with pytest.raises(OfficeError) as error:
        await command_task
    assert error.value.code == OfficeErrorCode.EDITOR_UNAVAILABLE

    stale_result = _conflict_result(
        command,
        DocumentVersion(editor_epoch=old_version.editor_epoch, model_revision=99),
    )

    assert not manager.complete_command(stale_result)
    assert session.version == current_version


async def test_same_session_apply_commands_are_serial(tmp_path: Path) -> None:
    manager, session = _create_sheet_session(tmp_path)
    first_command = _set_cell_command(session.session_id, "serial-1", session.version)
    second_version = DocumentVersion(
        editor_epoch=session.version.editor_epoch,
        model_revision=session.version.model_revision + 1,
    )
    second_command = _set_cell_command(
        session.session_id,
        "serial-2",
        second_version,
        cell="B1",
    )
    send_order: list[str] = []
    active_sends = 0
    max_active_sends = 0
    first_send_started = asyncio.Event()
    release_first_send = asyncio.Event()

    async def send(outgoing: OfficeApplyCommand) -> None:
        nonlocal active_sends, max_active_sends
        active_sends += 1
        max_active_sends = max(max_active_sends, active_sends)
        send_order.append(outgoing.operation_id)
        if outgoing.operation_id == first_command.operation_id:
            first_send_started.set()
            await release_first_send.wait()
        manager.complete_command(
            _success_result(
                outgoing,
                DocumentVersion(
                    editor_epoch=outgoing.expected_version.editor_epoch,
                    model_revision=outgoing.expected_version.model_revision + 1,
                ),
            )
        )
        active_sends -= 1

    first_task = asyncio.create_task(manager.execute_command(first_command, send))
    await first_send_started.wait()
    second_task = asyncio.create_task(manager.execute_command(second_command, send))
    release_first_send.set()
    await asyncio.gather(first_task, second_task)

    assert send_order == ["serial-1", "serial-2"]
    assert max_active_sends == 1


async def test_late_editor_result_is_committed_after_the_agent_request_is_cancelled(
    tmp_path: Path,
) -> None:
    manager, session = _create_sheet_session(tmp_path)
    command = _set_cell_command(session.session_id, "cancelled-1", session.version)
    sent = asyncio.Event()

    async def send(_: OfficeApplyCommand) -> None:
        sent.set()

    command_task = asyncio.create_task(manager.execute_command(command, send))
    await sent.wait()
    command_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await command_task

    result = _success_result(
        command,
        DocumentVersion(
            editor_epoch=command.expected_version.editor_epoch,
            model_revision=command.expected_version.model_revision + 1,
        ),
    )
    assert manager.complete_command(result)
    assert session.version == result.version
    assert session.operation_results[command.operation_id] == result
