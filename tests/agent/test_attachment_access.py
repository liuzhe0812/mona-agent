from pathlib import Path

import pytest

from mona.agent.context import ContextBuilder
from mona.agent.loop import AgentLoop, TurnContext, TurnState
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.bus.events import InboundMessage
from mona.session.manager import Session
from mona.utils.document import extract_documents


@pytest.mark.asyncio
async def test_restore_stages_uploaded_document_in_effective_workspace(tmp_path: Path) -> None:
    upload = tmp_path / "workspace" / "uploads" / "chat" / "report.txt"
    upload.parent.mkdir(parents=True)
    upload.write_text("attachment body", encoding="utf-8")
    effective_workspace = tmp_path / "workspace" / "agent-workspaces" / "mona" / "output"
    effective_workspace.mkdir(parents=True)
    session_key = "websocket:chat"
    ctx = TurnContext(
        msg=InboundMessage(
            channel="websocket",
            sender_id="user",
            chat_id="chat",
            content="inspect",
            media=[str(upload)],
        ),
        session=Session(key=session_key),
        session_key=session_key,
        state=TurnState.RESTORE,
        turn_id="test-turn",
    )
    loop = object.__new__(AgentLoop)
    loop.workspace = tmp_path / "workspace"

    token = set_current_workspace(effective_workspace)
    try:
        result = await loop._state_restore(ctx)
        prompt = ContextBuilder(effective_workspace).build_messages(
            history=[],
            current_message=ctx.msg.content,
            message_metadata=ctx.msg.metadata,
        )[-1]["content"]
    finally:
        reset_current_workspace(token)

    expected = (
        effective_workspace
        / ".mona"
        / "attachments"
        / "websocket_chat"
        / "report.txt"
    ).resolve()
    assert result == "ok"
    assert expected.read_text(encoding="utf-8") == "attachment body"
    assert ctx.msg.metadata["_attachment_paths"] == [
        ".mona/attachments/websocket_chat/report.txt"
    ]
    assert "Attached File (workspace-relative): .mona/attachments/" in prompt
    assert str(expected) not in ctx.msg.content
    assert ctx.msg.media == []


def test_extract_documents_exposes_scanned_pdf_page_size(tmp_path: Path) -> None:
    fitz = pytest.importorskip("fitz")
    pdf_path = tmp_path / "scan.pdf"
    doc = fitz.open()
    doc.new_page(width=432, height=720)
    doc.save(str(pdf_path))
    doc.close()

    text, image_paths = extract_documents("inspect", [str(pdf_path)])

    assert image_paths == []
    assert "152.40 x 254.00 mm" in text
