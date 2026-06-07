import pytest

from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META, DeliverFileTool
from mona.bus.events import OutboundMessage


@pytest.mark.asyncio
async def test_deliver_file_collects_for_final_message(tmp_path) -> None:
    created = tmp_path / "report.md"
    created.write_text("# report\n", encoding="utf-8")
    sent: list[OutboundMessage] = []

    async def _send(msg: OutboundMessage) -> None:
        sent.append(msg)

    pending: list[dict] = []
    tool = DeliverFileTool(send_callback=_send, workspace=tmp_path)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="chat-1",
            metadata={DELIVER_FILES_PENDING_META: pending},
        )
    )

    result = await tool.execute(paths=["report.md"])

    assert result == "Prepared 1 file(s) for final delivery"
    assert sent == []
    assert pending[0]["name"] == "report.md"
    assert pending[0]["path"] == "report.md"
