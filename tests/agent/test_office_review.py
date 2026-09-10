from __future__ import annotations

import json
from pathlib import Path

import pytest

from mona.agent.tools.office import OfficeTool
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import DocumentVersion, OfficeInspectSuccess, OfficeSessionState


class EditorClient:
    def __init__(self):
        self.pending = ['s_2']
        self.version = DocumentVersion(editor_epoch='epoch', model_revision=3)
        self.exports = []

    async def get(self, session_id, *, owner_session_key):
        return OfficeSessionState(session_id=session_id, display_name='test.pptx', type='slides', version=self.version)

    async def inspect(self, request, *, owner_session_key):
        assert request.query.mode == 'review'
        return OfficeInspectSuccess(ok=True, session_id=request.session_id, request_id='review', version=self.version,
            result={'mode': 'review', 'documentType': 'slides', 'pendingSlideIds': self.pending, 'warnings': ['文字可能溢出']})

    async def export(self, session_id, *, owner_session_key, output, version):
        if version != self.version.model_dump(by_alias=True):
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, 'Changed during export')
        self.exports.append((session_id, version))
        Path(output).write_bytes(b'exported checkpoint')
        return {'ok': True, 'fileName': Path(output).name, 'version': version}


@pytest.mark.asyncio
async def test_export_requires_visual_observation_and_keeps_warnings_afterwards(tmp_path, monkeypatch):
    client = EditorClient()
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    tool = OfficeTool(workspace=tmp_path)
    blocked = json.loads(await tool.execute(action='export', session_id='office_1', output='deck.pptx'))
    assert blocked['error']['code'] == 'REVIEW_REQUIRED'
    assert blocked['nextQueries'] == [{'mode': 'visual', 'slideId': 's_2'}]
    assert not client.exports
    assert not (tmp_path / 'deck.pptx').exists()

    client.pending = []
    exported = json.loads(await tool.execute(action='export', session_id='office_1', output='deck.pptx'))
    assert exported['ok']
    assert exported['review']['status'] == 'no_pending_layout_review'
    assert exported['review']['warnings'] == ['文字可能溢出']
    assert (tmp_path / 'deck.pptx').read_bytes() == b'exported checkpoint'


@pytest.mark.asyncio
async def test_explicit_draft_retains_unreviewed_status(tmp_path, monkeypatch):
    client = EditorClient()
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output='draft.pptx', allow_unreviewed=True))
    assert result['ok']
    assert result['review']['status'] == 'draft'
    assert result['review']['pendingSlideIds'] == ['s_2']
    assert client.pending == ['s_2']


@pytest.mark.asyncio
async def test_review_does_not_silently_advance_requested_export_version(tmp_path, monkeypatch):
    client = EditorClient()
    client.pending = []
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output='deck.pptx',
        expected_version={'editorEpoch': 'epoch', 'modelRevision': 2}))
    assert result['error']['code'] == 'VERSION_CONFLICT'
    assert not client.exports
