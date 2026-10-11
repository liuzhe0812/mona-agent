from __future__ import annotations

import copy

import pytest

from mona.providers.base import LLMProvider, LLMResponse
from mona.providers.registry import find_by_name


class RecordingProvider(LLMProvider):
    """Fake the provider transport while exercising the base retry path."""

    def __init__(self, responses: list[LLMResponse], model: str = "test-model") -> None:
        super().__init__()
        self.responses = list(responses)
        self.model = model
        self.calls: list[list[dict]] = []

    def _respond(self, messages: list[dict]) -> LLMResponse:
        self.calls.append(copy.deepcopy(messages))
        return self.responses.pop(0)

    async def chat(self, messages: list[dict], **_kwargs) -> LLMResponse:
        return self._respond(messages)

    async def chat_stream(self, messages: list[dict], **_kwargs) -> LLMResponse:
        return self._respond(messages)

    def get_default_model(self) -> str:
        return self.model


def _image_messages() -> list[dict]:
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": "summarize this page"},
            {
                "type": "image_url",
                "image_url": {"url": "data:image/png;base64,abc"},
                "_meta": {"path": "/media/page-1.png"},
            },
        ],
    }]


async def _request(
    provider: RecordingProvider,
    messages: list[dict],
    *,
    streaming: bool,
) -> LLMResponse:
    if streaming:
        return await provider.chat_stream_with_retry(messages=messages, model=provider.model)
    return await provider.chat_with_retry(messages=messages, model=provider.model)


def _content(call: list[dict]) -> list[dict]:
    content = call[0]["content"]
    assert isinstance(content, list)
    return content


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True], ids=["non-streaming", "streaming"])
async def test_known_text_model_strips_images_before_request(streaming: bool) -> None:
    provider = RecordingProvider([LLMResponse(content="ok")], model="deepseek-v3.2")
    provider.spec = find_by_name("deepseek")
    messages = _image_messages()

    response = await _request(provider, messages, streaming=streaming)

    assert response.content == "ok"
    assert len(provider.calls) == 1
    content = _content(provider.calls[0])
    assert all(block.get("type") != "image_url" for block in content)
    assert any(block.get("text") == "summarize this page" for block in content)
    placeholder = next(block["text"] for block in content if "/media/page-1.png" in block.get("text", ""))
    assert "visual content was not read" in placeholder
    assert "model does not support image input" in placeholder
    assert _content(messages) == content


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True], ids=["non-streaming", "streaming"])
async def test_unknown_model_retries_nontransient_image_error_without_images(
    streaming: bool,
) -> None:
    provider = RecordingProvider([
        LLMResponse(content="unsupported image input", finish_reason="error"),
        LLMResponse(content="ok"),
    ])
    messages = _image_messages()

    response = await _request(provider, messages, streaming=streaming)

    assert provider.get_capabilities(provider.model).supports_vision is None
    assert response.content == "ok"
    assert len(provider.calls) == 2
    assert any(block.get("type") == "image_url" for block in _content(provider.calls[0]))
    retry_content = _content(provider.calls[1])
    assert all(block.get("type") != "image_url" for block in retry_content)
    assert any(block.get("text") == "summarize this page" for block in retry_content)
    placeholder = next(block["text"] for block in retry_content if "/media/page-1.png" in block.get("text", ""))
    assert "visual content was not read" in placeholder
    assert "reason is unknown" in placeholder
    assert _content(messages) == retry_content


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True], ids=["non-streaming", "streaming"])
async def test_vision_capable_model_receives_images(streaming: bool) -> None:
    provider = RecordingProvider([LLMResponse(content="ok")], model="gpt-4o")
    provider.spec = find_by_name("openai")
    messages = _image_messages()

    response = await _request(provider, messages, streaming=streaming)

    assert response.content == "ok"
    assert len(provider.calls) == 1
    assert any(block.get("type") == "image_url" for block in _content(provider.calls[0]))
    assert any(block.get("text") == "summarize this page" for block in _content(provider.calls[0]))
    assert any(block.get("type") == "image_url" for block in _content(messages))
