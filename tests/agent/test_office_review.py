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
        self.warnings = ['[错误] e_1 文字溢出']
        self.version = DocumentVersion(editor_epoch='epoch', model_revision=3)
        self.exports = []

    async def get(self, session_id, *, owner_session_key):
        return OfficeSessionState(session_id=session_id, display_name='test.pptx', type='slides', version=self.version)

    async def inspect(self, request, *, owner_session_key):
        assert request.query.mode == 'review'
        return OfficeInspectSuccess(ok=True, session_id=request.session_id, request_id='review', version=self.version,
            result={'mode': 'review', 'documentType': 'slides', 'pendingSlideIds': self.pending, 'warnings': self.warnings})

    async def export(self, session_id, *, owner_session_key, output, version):
        if version != self.version.model_dump(by_alias=True):
            raise OfficeError(OfficeErrorCode.VERSION_CONFLICT, 'Changed during export')
        self.exports.append((session_id, version))
        Path(output).write_bytes(b'exported checkpoint')
        return {'ok': True, 'fileName': Path(output).name, 'version': version}


@pytest.mark.asyncio
async def test_export_requires_visual_observation_and_resolved_errors(tmp_path, monkeypatch):
    client = EditorClient()
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    tool = OfficeTool(workspace=tmp_path)
    blocked = json.loads(await tool.execute(action='export', session_id='office_1', output='deck.pptx'))
    assert blocked['error']['code'] == 'REVIEW_REQUIRED'
    assert blocked['nextQueries'] == [{'mode': 'visual', 'slideId': 's_2'}]
    assert not client.exports
    assert not (tmp_path / 'deck.pptx').exists()

    client.pending = []
    still_blocked = json.loads(await tool.execute(action='export', session_id='office_1', output='deck.pptx'))
    assert still_blocked['error']['code'] == 'REVIEW_REQUIRED'
    assert still_blocked['blockingWarnings'] == ['[错误] e_1 文字溢出']
    assert not client.exports

    client.warnings = []
    exported = json.loads(await tool.execute(action='export', session_id='office_1', output='deck.pptx'))
    assert exported['ok']
    assert exported['review']['status'] == 'no_pending_quality_review'
    assert exported['review']['warnings'] == []
    assert (tmp_path / 'deck.pptx').read_bytes() == b'exported checkpoint'


@pytest.mark.asyncio
async def test_agent_cannot_self_authorize_unreviewed_ppt_export(tmp_path, monkeypatch):
    client = EditorClient()
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output='draft.pptx', allow_unreviewed=True))
    assert result['ok'] is False
    assert result['error']['code'] == 'REVIEW_REQUIRED'
    assert '不能自行跳过' in result['error']['message']
    assert client.pending == ['s_2']
    assert not client.exports
    assert not (tmp_path / 'draft.pptx').exists()


@pytest.mark.asyncio
async def test_review_only_overlap_does_not_block_after_visual_observation(tmp_path, monkeypatch):
    client = EditorClient()
    client.pending = []
    client.warnings = ['[需检查] e_1 的文字与图片 e_2 交叠']
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output='reviewed.pptx'))
    assert result['ok']
    assert result['review']['warnings'] == client.warnings


@pytest.mark.asyncio
async def test_design_warning_requires_pending_review_before_export(tmp_path, monkeypatch):
    client = EditorClient()
    client.warnings = ['[需检查] e_1 把长内容集中在单个全宽文本框']
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output='deck.pptx'))
    assert result['error']['code'] == 'REVIEW_REQUIRED'
    assert result['review']['warnings'] == client.warnings
    assert not client.exports


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("document_type", "pending_targets", "next_query"),
    [
        ("docs", ["document"], {"mode": "visual", "pageIndex": 0}),
        ("sheets", ["Data!A1:C4"], {
            "mode": "range", "sheet": "Data", "range": "A1:C4",
            "includeFormula": True, "includeStyle": True,
        }),
    ],
)
async def test_docs_and_sheets_require_quality_review(
    tmp_path, monkeypatch, document_type, pending_targets, next_query,
):
    class QualityClient(EditorClient):
        async def get(self, session_id, *, owner_session_key):
            return OfficeSessionState(
                session_id=session_id, display_name=f"test.{document_type}",
                type=document_type, version=self.version,
            )

        async def inspect(self, request, *, owner_session_key):
            return OfficeInspectSuccess(
                ok=True, session_id=request.session_id, request_id="review", version=self.version,
                result={"mode": "review", "documentType": document_type,
                        "pendingTargets": pending_targets, "warnings": []},
            )

    client = QualityClient()
    monkeypatch.setattr('mona.agent.tools.office.OfficeServiceClient.from_port', lambda _: client)
    result = json.loads(await OfficeTool(workspace=tmp_path).execute(
        action='export', session_id='office_1', output=f'deck.{"docx" if document_type == "docs" else "xlsx"}'))
    assert result['error']['code'] == 'REVIEW_REQUIRED'
    assert result['nextQueries'] == [next_query]
    assert not client.exports


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
