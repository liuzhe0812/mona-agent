import json
from unittest.mock import AsyncMock, MagicMock

import pytest

import mona.api.server as server
from mona.api.url2note import Url2NoteSource


@pytest.mark.asyncio
async def test_url2note_extract_returns_shared_source(monkeypatch: pytest.MonkeyPatch) -> None:
    class Extractor:
        async def extract(self, url: str) -> Url2NoteSource:
            return Url2NoteSource("标题", url, "article", "正文")

    monkeypatch.setattr(server, "Url2NoteExtractor", Extractor, raising=False)
    request = MagicMock()
    request.json = AsyncMock(return_value={"url": "https://example.com"})

    response = await server.handle_url2note_extract(request)

    assert response.status == 200
    assert json.loads(response.body) == {
        "title": "标题",
        "url": "https://example.com",
        "kind": "article",
        "text": "正文",
    }
