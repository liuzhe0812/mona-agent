from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from mona.agent.tools.video_generation import VideoGenerationTool
from mona.config.schema import ProviderConfig, VideoGenerationToolConfig
from mona.providers.video_generation import (
    GeneratedVideoResponse,
    OpenAICompatVideoGenerationClient,
    VideoGenerationError,
    download_video_bytes,
)


@pytest.mark.asyncio
async def test_openai_compat_video_resolves_relative_result_url() -> None:
    api_base = "http://172.31.13.189:30030/v1"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "success", "result": {"video_url": "/outputs/video.mp4"}},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        response = await OpenAICompatVideoGenerationClient(
            api_key=None,
            api_base=api_base,
            client=client,
        ).generate(prompt="a moving cat", model="custom-video")
    finally:
        await client.aclose()

    assert response.video_url == "http://172.31.13.189:30030/outputs/video.mp4"


@pytest.mark.asyncio
async def test_video_download_allows_same_origin_private_redirect() -> None:
    api_base = "http://172.31.13.189:30030/v1"
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/outputs/video.mp4":
            return httpx.Response(
                302,
                headers={"location": "/generated/video.mp4"},
                request=request,
            )
        return httpx.Response(200, content=b"video", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        content = await download_video_bytes(
            "/outputs/video.mp4",
            api_base=api_base,
            client=client,
        )
    finally:
        await client.aclose()

    assert content == b"video"
    assert paths == ["/outputs/video.mp4", "/generated/video.mp4"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "redirect_url",
    [
        "http://10.0.0.8/secret/video.mp4",
        "http://169.254.169.254/latest/meta-data/video.mp4",
    ],
)
async def test_video_download_blocks_private_redirect_to_other_origin(
    redirect_url: str,
) -> None:
    api_base = "http://172.31.13.189:30030/v1"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": redirect_url}, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(VideoGenerationError, match="not allowed"):
            await download_video_bytes(
                "/outputs/video.mp4",
                api_base=api_base,
                client=client,
            )
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_video_download_does_not_trust_private_url_without_api_base() -> None:
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=b"video", request=request)
        )
    )
    try:
        with pytest.raises(VideoGenerationError, match="not allowed"):
            await download_video_bytes(
                "http://172.31.13.189:30030/outputs/video.mp4",
                client=client,
            )
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openai_compat_video_blocks_private_result_from_other_origin() -> None:
    api_base = "http://172.31.13.189:30030/v1"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "success",
                "result": {"video_url": "http://10.0.0.8/secret/video.mp4"},
            },
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(VideoGenerationError, match="not allowed"):
            await OpenAICompatVideoGenerationClient(
                api_key=None,
                api_base=api_base,
                client=client,
            ).generate(prompt="a moving cat", model="custom-video")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_video_tool_preserves_result_url_and_passes_api_base(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class ResultClient:
        provider_name = "openai_compat"

        def __init__(self, **kwargs: Any) -> None:
            self.api_base = kwargs["api_base"]

        async def generate(self, **kwargs: Any) -> GeneratedVideoResponse:
            return GeneratedVideoResponse(
                video_url="http://172.31.13.189:30030/outputs/video.mp4",
                content="",
                raw={},
                status="completed",
                progress=100,
            )

    async def fail_download(url: str, **kwargs: Any) -> bytes:
        captured.update({"url": url, **kwargs})
        raise VideoGenerationError("download failed", result_url=url)

    monkeypatch.setattr(
        "mona.agent.tools.video_generation.get_video_gen_provider",
        lambda name: ResultClient if name == "custom-video" else None,
    )
    monkeypatch.setattr(
        "mona.agent.tools.video_generation.download_video_bytes",
        fail_download,
    )
    tool = VideoGenerationTool(
        workspace=tmp_path,
        config=VideoGenerationToolConfig(
            enabled=True,
            provider="custom-video",
            model="MiniMax-H3-Fast",
        ),
        provider_configs={
            "custom-video": ProviderConfig(
                api_base="http://172.31.13.189:30030/v1",
            )
        },
    )

    payload = json.loads(await tool.execute(prompt="a moving cat"))

    assert captured["api_base"] == "http://172.31.13.189:30030/v1"
    assert payload["error"]["code"] == "VIDEO_RESULT_UNAVAILABLE"
    assert payload["error"]["result_url"] == captured["url"]
    assert "without resubmitting" in payload["error"]["next_step"]
