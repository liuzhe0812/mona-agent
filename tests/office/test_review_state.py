from __future__ import annotations

import asyncio
import hashlib

from mona.office.manager import OfficeSessionManager
from mona.office.schemas import (
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCheckpointMetadata,
    OfficeCommandSuccess,
    OfficeInspectCommand,
    OfficeInspectSuccess,
)


def test_pending_visual_pages_survive_checkpoint_and_manager_recovery(tmp_path):
    async def run():
        manager = OfficeSessionManager(sessions_root=tmp_path / 'sessions')
        session = manager.create_session(owner_session_key='test', document_type='slides', workspace_root=tmp_path)
        manager.connect_editor(session.session_id, session.version)
        changed = DocumentVersion(editor_epoch=session.version.editor_epoch, model_revision=1)
        command = OfficeApplyCommand(session_id=session.session_id, operation_id='layout', expected_version=session.version,
            operations=[{'op': 'slide_add_text', 'payload': {'slideId': 's_1', 'text': 'title'}}])

        async def send(outgoing):
            manager.complete_command(OfficeCommandSuccess(ok=True, session_id=session.session_id,
                operation_id=outgoing.operation_id, version=changed, changed_targets=['s_1'], pending_visual_slide_ids=['s_1']))

        await manager.execute_command(command, send)
        contents = session.working_path.read_bytes()
        manager.write_checkpoint(OfficeCheckpointMetadata(session_id=session.session_id, version=changed,
            size=len(contents), sha256=hashlib.sha256(contents).hexdigest()), [contents])
        restored = OfficeSessionManager(sessions_root=tmp_path / 'sessions').get_session(session.session_id)
        assert restored.pending_visual_slide_ids == ['s_1']
        assert restored.to_state().pending_visual_slide_ids == ['s_1']

    asyncio.run(run())


def test_stale_visual_result_cannot_clear_newer_layout_review(tmp_path):
    async def run():
        manager = OfficeSessionManager(sessions_root=tmp_path / 'sessions')
        session = manager.create_session(owner_session_key='test', document_type='slides', workspace_root=tmp_path)
        manager.connect_editor(session.session_id, session.version)
        previous = session.version
        newer = DocumentVersion(editor_epoch=previous.editor_epoch, model_revision=1)
        manager.record_editor_version(session.session_id, newer, changed_targets=['s_1'], pending_visual_slide_ids=['s_1'])
        request = OfficeInspectCommand(session_id=session.session_id, request_id='visual', query={'mode': 'visual', 'slideId': 's_1'})

        async def send(outgoing):
            manager.complete_inspect(OfficeInspectSuccess(ok=True, session_id=session.session_id,
                request_id=outgoing.request_id, version=previous, result={'mode': 'visual',
                    'dataUrl': 'data:image/png;base64,AA==', 'width': 1, 'height': 1, 'target': 's_1', 'pendingVisualSlideIds': []}))

        await manager.execute_inspect(request, send)
        assert session.pending_visual_slide_ids == ['s_1']

    asyncio.run(run())
