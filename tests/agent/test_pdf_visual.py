from __future__ import annotations

import asyncio
import base64
import copy
import io
import json
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from mona.agent.context import ContextBuilder
from mona.agent.loop import AgentLoop, TurnContext, TurnState
from mona.agent.tools.capabilities import _metadata_capabilities
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.pdf import PdfTool
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.providers.base import LLMProvider, LLMResponse
from mona.session.manager import Session
from mona.utils.document import extract_documents


@pytest.fixture(autouse=True)
def media_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mona.config.paths.get_media_dir", lambda: tmp_path / "media")
    monkeypatch.setattr("mona.agent.tools.path_utils.get_media_dir", lambda: tmp_path / "media")
    monkeypatch.setattr("mona.utils.pdf_visual.get_media_dir", lambda: tmp_path / "media")


def _pdf(path: Path, extra_pages: int = 0) -> Path:
    with pymupdf.open() as doc:
        page = doc.new_page(width=300, height=400)
        page.insert_text((20, 30), "Selectable text beside a photograph")
        bitmap = io.BytesIO()
        Image.new("RGB", (40, 40), (255, 0, 0)).save(bitmap, format="PNG")
        page.insert_image(pymupdf.Rect(50, 50, 100, 100), stream=bitmap.getvalue())
        page = doc.new_page(width=300, height=400)
        page.insert_text((20, 30), "Vector chart")
        page.draw_rect(pymupdf.Rect(50, 50, 100, 100), fill=(0, 0, 1))
        with pymupdf.open() as scan:
            scan_page = scan.new_page(width=300, height=400)
            scan_page.insert_text((20, 30), "SCANNED TEXT ONLY")
            scan_page.draw_rect(pymupdf.Rect(50, 50, 100, 100), fill=(0, 1, 0))
            raw = scan_page.get_pixmap().tobytes("png")
        page = doc.new_page(width=300, height=400)
        page.insert_image(page.rect, stream=raw)
        for number in range(extra_pages):
            page = doc.new_page(width=300, height=400)
            page.insert_text((20, 30), f"Extra page {number + 4}")
        doc.save(path)
    return path


@pytest.mark.asyncio
async def test_inspect_returns_real_raster_vector_and_scan_images(tmp_path: Path) -> None:
    source = _pdf(tmp_path / "图文.pdf")
    original = source.read_bytes()
    result = await PdfTool(workspace=tmp_path).execute(action="inspect", path=source.name)
    assert isinstance(result, list)
    payload = json.loads(result[0]["text"])
    assert "Selectable text" in payload["pages"][0]["text"]
    assert payload["pages"][2]["text"] == ""
    assert payload["truncated"] is False
    images = [block for block in result if block["type"] == "image_url"]
    assert len(images) == 3
    for block, color in zip(images, [(255, 0, 0), (0, 0, 255), (0, 255, 0)], strict=True):
        raw = base64.b64decode(block["image_url"]["url"].split(",", 1)[1])
        assert raw == Path(block["_meta"]["path"]).read_bytes()
        with Image.open(io.BytesIO(raw)) as preview:
            assert preview.getpixel((150, 150)) == color
    assert source.read_bytes() == original


@pytest.mark.asyncio
async def test_inspect_pages_are_bounded_and_continue(tmp_path: Path) -> None:
    source = _pdf(tmp_path / "long.pdf", extra_pages=3)
    tool = PdfTool(workspace=tmp_path)
    first = await tool.execute(action="inspect", path=source.name)
    payload = json.loads(first[0]["text"])
    assert payload["remaining_pages"] == [5, 6]
    assert payload["truncated"] is True
    next_batch = await tool.execute(action="inspect", path=source.name, pages=[5, 6])
    assert [page["page"] for page in json.loads(next_batch[0]["text"])["pages"]] == [5, 6]
    assert "at most 4" in await tool.execute(action="inspect", path=source.name, pages=[1, 2, 3, 4, 5])
    assert "out of range" in await tool.execute(action="inspect", path=source.name, pages=[7])
    restricted = tmp_path / "workspace"
    restricted.mkdir()
    assert "outside" in await PdfTool(workspace=restricted).execute(action="inspect", path=str(source))


@pytest.mark.asyncio
async def test_pdf_attachment_reaches_context_with_text_images_and_office_capability(tmp_path: Path) -> None:
    source = _pdf(tmp_path / "report.pdf")
    ctx = TurnContext(
        msg=InboundMessage(channel="websocket", sender_id="user", chat_id="chat", content="转为PPT", media=[str(source)]),
        session=Session(key="websocket:chat"), session_key="websocket:chat",
        state=TurnState.RESTORE, turn_id="pdf-test",
    )
    loop = object.__new__(AgentLoop)
    loop.workspace = tmp_path
    token = set_current_workspace(tmp_path)
    try:
        assert await loop._state_restore(ctx) == "ok"
        content = ContextBuilder(tmp_path)._build_user_content(ctx.msg.content, ctx.msg.media)
    finally:
        reset_current_workspace(token)
    assert "office" in _metadata_capabilities(ctx.msg.metadata)
    assert len([item for item in content if item["type"] == "image_url"]) == 3
    assert "Selectable text" in ctx.msg.content
    assert "Page 3:" in ctx.msg.content
    assert "pdf(action='inspect'" in ctx.msg.content


def test_attachment_preview_budget_and_render_failure_keep_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    first = _pdf(tmp_path / "first.pdf", extra_pages=2)
    second = _pdf(tmp_path / "second.pdf")
    text, images = extract_documents("read", [str(first), str(second)], pdf_previews=True)
    assert len(images) == 4
    assert "Extra page 5" in text
    assert "Page images 5–5 have not been included" in text
    assert "No page images included" in text

    def fail(*args: object, **kwargs: object) -> None:
        raise RuntimeError("render failed")

    monkeypatch.setattr("mona.utils.pdf_visual.render_pdf_previews", fail)
    text, images = extract_documents("read", [str(first)], pdf_previews=True)
    assert not images
    assert "Selectable text" in text
    assert "Page images unavailable: render failed" in text


@pytest.mark.asyncio
async def test_pending_pdf_attachment_reaches_model_with_page_images(tmp_path: Path) -> None:
    class RecordingProvider(LLMProvider):
        def __init__(self) -> None:
            super().__init__()
            self.requests: list[list[dict]] = []

        async def chat(self, messages: list[dict], **kwargs: object) -> LLMResponse:
            self.requests.append(copy.deepcopy(messages))
            return LLMResponse(content="done")

        def get_default_model(self) -> str:
            return "gpt-4o"

    source = _pdf(tmp_path / "followup.pdf", extra_pages=2)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    provider = RecordingProvider()
    loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=workspace, model="gpt-4o")
    pending: asyncio.Queue[InboundMessage] = asyncio.Queue()
    await pending.put(InboundMessage(
        channel="cli", sender_id="user", chat_id="chat", content="read PDF", media=[str(source)],
    ))
    result = await loop._run_agent_loop(
        [{"role": "user", "content": "hello"}], channel="cli", chat_id="chat", pending_queue=pending,
    )
    assert result[-1] is True
    content = next(
        message["content"] for message in provider.requests[-1]
        if message["role"] == "user" and isinstance(message["content"], list)
    )
    assert len([block for block in content if block["type"] == "image_url"]) == 4
    assert any("Selectable text" in block.get("text", "") for block in content)
    staged = next((tmp_path / "media").glob("*.pdf"))
    assert any(str(staged) in block.get("text", "") for block in content)
    continued = await PdfTool(workspace=workspace).execute(action="inspect", path=str(staged), pages=[5])
    assert json.loads(continued[0]["text"])["pages"][0]["page"] == 5
