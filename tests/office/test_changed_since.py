from __future__ import annotations

import asyncio
from pathlib import Path

from mona.office.errors import OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import (
    ChangedSinceResult,
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCommandSuccess,
    OfficeInspectCommand,
)


def _session(tmp_path: Path):
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


async def _inspect_changes(manager, session, version):
    command = OfficeInspectCommand(
        session_id=session.session_id,
        request_id="changes_1",
        query={"mode": "changed_since", "version": version},
    )

    async def send(_):
        raise AssertionError("changed_since must not be forwarded to an editor")

    return await manager.execute_inspect(command, send)


def test_changed_since_combines_user_and_agent_revision_targets(tmp_path: Path) -> None:
    async def run() -> None:
        manager, session = _session(tmp_path)
        initial = session.version
        user_version = DocumentVersion(
            editor_epoch=initial.editor_epoch,
            model_revision=1,
        )
        manager.record_editor_version(
            session.session_id,
            user_version,
            changed_targets=["Sheet1!A1"],
        )
        command = OfficeApplyCommand(
            session_id=session.session_id,
            operation_id="agent_change",
            expected_version=user_version,
            operations=[
                {
                    "op": "set_cell",
                    "payload": {"sheet": "Sheet1", "cell": "B2", "value": 2},
                }
            ],
        )

        async def send(outgoing: OfficeApplyCommand) -> None:
            result = OfficeCommandSuccess(
                ok=True,
                session_id=session.session_id,
                operation_id=outgoing.operation_id,
                version=DocumentVersion(
                    editor_epoch=initial.editor_epoch,
                    model_revision=2,
                ),
                changed_targets=["Sheet1!B2"],
            )
            asyncio.get_running_loop().call_soon(manager.complete_command, result)

        await manager.execute_command(command, send)
        result = await _inspect_changes(manager, session, initial)

        assert result.ok
        assert isinstance(result.result, ChangedSinceResult)
        assert [change.model_dump(by_alias=True) for change in result.result.changes] == [
            {"revision": 1, "actor": "user", "target": "Sheet1!A1", "kind": "cell"},
            {"revision": 2, "actor": "agent", "target": "Sheet1!B2", "kind": "cell"},
        ]

    asyncio.run(run())


def test_changed_since_requires_resync_for_an_old_epoch(tmp_path: Path) -> None:
    async def run() -> None:
        manager, session = _session(tmp_path)
        result = await _inspect_changes(
            manager,
            session,
            DocumentVersion(editor_epoch="epoch_old", model_revision=0),
        )

        assert not result.ok
        assert result.error.code == OfficeErrorCode.RESYNC_REQUIRED
        assert result.current_version == session.version

    asyncio.run(run())
