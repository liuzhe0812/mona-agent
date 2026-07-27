import pytest

from mona.agent.tools import Url2NoteTool as ExportedUrl2NoteTool
from mona.agent.tools.url2note import Url2NoteTool
from mona.api.url2note import Url2NoteSource


class _Extractor:
    async def extract(self, url: str) -> Url2NoteSource:
        return Url2NoteSource("标题", url, "article", "来源内容")


def test_url2note_is_exported_for_packaged_tool_discovery() -> None:
    assert ExportedUrl2NoteTool is Url2NoteTool


@pytest.mark.asyncio
async def test_url2note_returns_source_for_root_note_creation() -> None:
    result = await Url2NoteTool(extractor=_Extractor()).execute(url="https://example.com")

    assert "notes_create" in result
    assert "notebook_name" not in result
    assert "来源内容" in result
