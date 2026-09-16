import base64
import json

import httpx
import pytest

import mona.providers.image_generation as image_generation
from mona.config.schema import Config, ProviderConfig, ProvidersConfig
from mona.providers.image_generation import ImageGenerationError, OpenAICompatImageGenerationClient
from mona.providers.mona_managed_media import MonaManagedMediaClient
from mona.providers.video_generation import (
    OpenAICompatVideoGenerationClient,
    VideoGenerationError,
    get_video_gen_provider,
    video_gen_provider_configs,
)

_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0dIDAT"
    b"\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
_PNG_B64 = base64.b64encode(_PNG).decode("ascii")


@pytest.fixture(autouse=True)
def _allow_mock_media_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        image_generation,
        "validate_url_target",
        lambda url, *, allow_private=False: (True, ""),
    )


@pytest.mark.asyncio
async def test_openai_compat_image_optional_key_and_reference_images(tmp_path):
    local_path = tmp_path / "reference.png"
    local_path.write_bytes(_PNG)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == "/v1/images/generations"
        return httpx.Response(200, json={"data": [{"b64_json": _PNG_B64}]}, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        response = await OpenAICompatImageGenerationClient(
            api_key=None,
            api_base="https://media.example/v1",
            client=client,
        ).generate(
            prompt="a cat",
            model="custom-image",
            reference_images=[
                "https://reference.example/cat.png",
                "data:image/png;base64,inline",
                str(local_path),
            ],
            aspect_ratio="16:9",
        )
    finally:
        await client.aclose()

    assert response.images[0].startswith("data:image/png;base64,")
    request = requests[0]
    assert "authorization" not in {key.lower() for key in request.headers}
    body = json.loads(request.content)
    assert body["model"] == "custom-image"
    assert body["prompt"] == "a cat"
    assert body["aspect_ratio"] == "16:9"
    assert "size" not in body
    assert body["reference_images"][:2] == [
        "https://reference.example/cat.png",
        "data:image/png;base64,inline",
    ]
    assert body["reference_images"][2].startswith("data:image/png;base64,")


@pytest.mark.asyncio
async def test_openai_compat_image_sends_bearer_when_key_is_configured():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer secret"
        return httpx.Response(200, json={"data": [{"b64_json": _PNG_B64}]}, request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        await OpenAICompatImageGenerationClient(
            api_key="secret",
            api_base="https://media.example/v1",
            client=client,
        ).generate(prompt="a cat", model="custom-image")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openai_compat_image_polls_async_task_until_file_is_ready(monkeypatch):
    from mona.providers import image_generation

    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "task/1", "status": "processing"}, request=request)
        if request.url.path == "/v1/tasks/task/1":
            return httpx.Response(
                200,
                json={"status": "completed", "files": [{"url": "https://media.example/result.png"}]},
                request=request,
            )
        return httpx.Response(200, content=_PNG, headers={"content-type": "image/png"}, request=request)

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(image_generation.asyncio, "sleep", no_sleep)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        response = await OpenAICompatImageGenerationClient(
            api_key=None,
            api_base="https://media.example/v1",
            client=client,
        ).generate(prompt="a cat", model="custom-image")
    finally:
        await client.aclose()

    assert response.images[0].startswith("data:image/png;base64,")
    assert paths == ["/v1/images/generations", "/v1/tasks/task/1", "/result.png"]


@pytest.mark.asyncio
async def test_openai_compat_image_reports_async_task_failure(monkeypatch):
    from mona.providers import image_generation

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "task-1", "status": "processing"}, request=request)
        return httpx.Response(
            200,
            json={"status": "failed", "error": "workflow timed out"},
            request=request,
        )

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(image_generation.asyncio, "sleep", no_sleep)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(ImageGenerationError, match="workflow timed out"):
            await OpenAICompatImageGenerationClient(
                api_key=None,
                api_base="https://media.example/v1",
                client=client,
            ).generate(prompt="a cat", model="custom-image")
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openai_compat_video_sync_result_and_request_fields():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == "/v1/videos/generations"
        return httpx.Response(
            200,
            json={"status": "success", "result": {"video_url": "https://media.example/out.mp4"}},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        response = await OpenAICompatVideoGenerationClient(
            api_key=None,
            api_base="https://media.example/v1",
            client=client,
        ).generate(
            prompt="a moving cat",
            model="custom-video",
            reference_images=["data:image/png;base64,ref"],
            first_frame="https://media.example/start.png",
            last_frame="data:image/png;base64,end",
            aspect_ratio="16:9",
            duration=5,
        )
    finally:
        await client.aclose()

    assert response.video_url == "https://media.example/out.mp4"
    assert response.status == "success"
    body = json.loads(requests[0].content)
    assert body["model"] == "custom-video"
    assert body["prompt"] == "a moving cat"
    assert body["reference_images"] == ["data:image/png;base64,ref"]
    assert body["first_frame"] == "https://media.example/start.png"
    assert body["last_frame"] == "data:image/png;base64,end"
    assert body["aspect_ratio"] == "16:9"
    assert body["duration"] == 5
    assert "authorization" not in {key.lower() for key in requests[0].headers}


@pytest.mark.asyncio
async def test_openai_compat_video_async_result_polls_task_and_extracts_nested_url():
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "task/1", "status": "queued"}, request=request)
        return httpx.Response(
            200,
            json={"status": "succeeded", "data": {"result": {"url": "https://media.example/out.mp4"}}},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        response = await OpenAICompatVideoGenerationClient(
            api_key="video-secret",
            api_base="https://media.example/v1",
            client=client,
            poll_interval=0,
            poll_timeout=1,
        ).generate(prompt="a moving cat", model="custom-video")
    finally:
        await client.aclose()

    assert response.video_url == "https://media.example/out.mp4"
    assert response.status == "succeeded"
    assert paths == ["/v1/videos/generations", "/v1/tasks/task/1"]


@pytest.mark.asyncio
async def test_openai_compat_video_failure_status_is_reported():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, json={"id": "task-1"}, request=request)
        return httpx.Response(
            200,
            json={"status": "error", "error": {"message": "workflow failed"}},
            request=request,
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(VideoGenerationError, match="workflow failed"):
            await OpenAICompatVideoGenerationClient(
                api_key=None,
                api_base="https://media.example/v1",
                client=client,
                poll_interval=0,
                poll_timeout=1,
            ).generate(prompt="a moving cat", model="custom-video")
    finally:
        await client.aclose()


def test_media_provider_fallback_and_dynamic_cindy_config():
    config = Config(
        providers=ProvidersConfig(
            cindy={
                "cindy-comfy": ProviderConfig(
                    api_base="https://comfy.example/v1",
                    api_key=None,
                    model="video-model",
                )
            }
        )
    )

    assert get_video_gen_provider("cindy-comfy") is OpenAICompatVideoGenerationClient
    assert video_gen_provider_configs(config)["cindy-comfy"].api_base == "https://comfy.example/v1"


def test_video_clients_do_not_apply_a_default_total_poll_timeout():
    assert OpenAICompatVideoGenerationClient(api_key=None).poll_timeout is None
    assert MonaManagedMediaClient().poll_timeout is None
