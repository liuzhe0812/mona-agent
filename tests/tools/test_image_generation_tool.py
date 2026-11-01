from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from mona.agent.tools.image_generation import ImageGenerationTool
from mona.agent.tools.video_generation import VideoGenerationTool
from mona.config.loader import set_config_path
from mona.config.schema import (
    ImageGenerationToolConfig,
    ModelGenerationParameters,
    ProviderConfig,
    VideoGenerationToolConfig,
)
from mona.providers.image_generation import (
    GeneratedImageResponse,
    ImageGenerationError,
    MonaManagedImageGenerationClient,
)
from mona.providers.mona_managed_media import MonaManagedMediaClient, MonaManagedMediaError
from mona.providers.video_generation import MonaManagedVideoGenerationClient

PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02"
    b"\x00\x00\x00\x0bIDATx\xdacd\xfc\xff\x1f\x00\x03\x03"
    b"\x02\x00\xef\xbf\xa7\xdb\x00\x00\x00\x00IEND\xaeB`\x82"
)
PNG_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class FakeImageClient:
    instances: list["FakeImageClient"] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.calls: list[dict[str, Any]] = []
        self.instances.append(self)

    async def generate(self, **kwargs: Any) -> GeneratedImageResponse:
        self.calls.append(kwargs)
        return GeneratedImageResponse(images=[PNG_DATA_URL], content="", raw={})


@pytest.mark.asyncio
async def test_generate_image_tool_stores_artifact_and_source_images(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_config_path(tmp_path / "config.json")
    FakeImageClient.instances = []
    monkeypatch.setattr(
        "mona.agent.tools.image_generation.get_image_gen_provider",
        lambda name: FakeImageClient if name == "openrouter" else None,
    )
    ref = tmp_path / "ref.png"
    ref.write_bytes(PNG_BYTES)
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(enabled=True, max_images_per_turn=2),
        provider_config=ProviderConfig(api_key="sk-or-test"),
    )

    result = await tool.execute(
        prompt="make this blue",
        reference_images=["ref.png"],
        aspect_ratio="16:9",
        image_size="2K",
        count=2,
    )

    payload = json.loads(result)
    artifacts = payload["artifacts"]
    assert len(artifacts) == 2
    assert Path(artifacts[0]["path"]).is_file()
    assert artifacts[0]["source_images"] == [str(ref.resolve())]
    assert artifacts[0]["model"] == "openai/gpt-5.4-image-2"

    fake = FakeImageClient.instances[0]
    assert fake.kwargs["api_key"] == "sk-or-test"
    assert len(fake.calls) == 2
    assert fake.calls[0]["aspect_ratio"] == "16:9"
    assert fake.calls[0]["image_size"] == "2K"


@pytest.mark.asyncio
async def test_custom_image_model_sends_only_explicitly_enabled_parameters(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeImageClient.instances = []
    monkeypatch.setattr(
        "mona.agent.tools.image_generation.get_image_gen_provider",
        lambda name: FakeImageClient if name == "custom-images" else None,
    )
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(
            enabled=True,
            provider="custom-images",
            model="z-image",
            model_parameters={
                "z-image": ModelGenerationParameters(
                    enabled=["seed", "cfg"],
                    values={"seed": 42, "cfg": 7.0, "steps": 28},
                )
            },
        ),
        provider_configs={
            "custom-images": ProviderConfig(
                api_base="https://media.example/v1",
                extra_body={"quality": "standard"},
            )
        },
    )

    await tool.execute(prompt="draw")

    assert FakeImageClient.instances[0].kwargs["extra_body"] == {
        "quality": "standard",
        "response_format": "b64_json",
        "seed": 42,
        "cfg": 7.0,
    }
    assert FakeImageClient.instances[0].calls[0]["image_size"] == "1024x1024"


@pytest.mark.asyncio
async def test_custom_image_model_converts_size_tier_using_aspect_ratio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeImageClient.instances = []
    monkeypatch.setattr(
        "mona.agent.tools.image_generation.get_image_gen_provider",
        lambda name: FakeImageClient if name == "custom-images" else None,
    )
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(
            enabled=True,
            provider="custom-images",
            model="z-image",
        ),
        provider_configs={
            "custom-images": ProviderConfig(api_base="http://172.31.13.189:30030/v1")
        },
    )

    await tool.execute(prompt="draw", aspect_ratio="16:9")

    assert FakeImageClient.instances[0].calls[0]["image_size"] == "1024x576"
    assert FakeImageClient.instances[0].calls[0]["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_generate_image_tool_reports_missing_key(tmp_path: Path) -> None:
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(enabled=True),
        provider_config=ProviderConfig(),
    )

    result = await tool.execute(prompt="draw")

    assert result.startswith("Error: OpenRouter API key is not configured")


@pytest.mark.asyncio
async def test_generate_image_tool_selects_aihubmix_provider(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_config_path(tmp_path / "config.json")
    FakeImageClient.instances = []
    monkeypatch.setattr(
        "mona.agent.tools.image_generation.get_image_gen_provider",
        lambda name: FakeImageClient if name == "aihubmix" else None,
    )
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(
            enabled=True,
            provider="aihubmix",
            model="gpt-image-2-free",
        ),
        provider_configs={
            "openrouter": ProviderConfig(api_key="sk-or-test"),
            "aihubmix": ProviderConfig(api_key="sk-ahm-test", extra_body={"quality": "low"}),
        },
    )

    result = await tool.execute(prompt="draw a poster", aspect_ratio="3:4")

    payload = json.loads(result)
    assert len(payload["artifacts"]) == 1
    fake = FakeImageClient.instances[0]
    assert fake.kwargs["api_key"] == "sk-ahm-test"
    assert fake.kwargs["extra_body"] == {"quality": "low"}
    assert fake.calls[0]["model"] == "gpt-image-2-free"
    assert fake.calls[0]["aspect_ratio"] == "3:4"


@pytest.mark.asyncio
async def test_generate_image_tool_reports_missing_aihubmix_key(tmp_path: Path) -> None:
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(enabled=True, provider="aihubmix"),
        provider_configs={"aihubmix": ProviderConfig()},
    )

    result = await tool.execute(prompt="draw")

    assert result.startswith("Error: AIHubMix API key is not configured")


@pytest.mark.asyncio
async def test_generate_image_tool_rejects_reference_outside_workspace(tmp_path: Path) -> None:
    set_config_path(tmp_path / "config.json")
    outside = tmp_path.parent / "outside.png"
    outside.write_bytes(PNG_BYTES)
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(enabled=True),
        provider_config=ProviderConfig(api_key="sk-or-test"),
    )

    result = await tool.execute(prompt="edit", reference_images=[str(outside)])

    assert "reference_images must be inside the workspace" in result


@pytest.mark.asyncio
async def test_generate_image_tool_preserves_failed_download_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DownloadFailureClient(FakeImageClient):
        async def generate(self, **kwargs: Any) -> GeneratedImageResponse:
            raise ImageGenerationError(
                "download failed",
                code="IMAGE_GENERATION_UNCERTAIN",
                result_url="http://172.31.13.189:30030/outputs/generated.png",
            )

    monkeypatch.setattr(
        "mona.agent.tools.image_generation.get_image_gen_provider",
        lambda name: DownloadFailureClient if name == "custom-images" else None,
    )
    tool = ImageGenerationTool(
        workspace=tmp_path,
        config=ImageGenerationToolConfig(
            enabled=True,
            provider="custom-images",
            model="z-image",
        ),
        provider_configs={
            "custom-images": ProviderConfig(
                api_base="http://172.31.13.189:30030/v1",
            )
        },
    )

    payload = json.loads(await tool.execute(prompt="draw"))

    assert payload["code"] == "IMAGE_GENERATION_UNCERTAIN"
    assert payload["result_url"] == (
        "http://172.31.13.189:30030/outputs/generated.png"
    )
    assert "without resubmitting" in payload["next_step"]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "video"])
async def test_managed_media_balance_error_stops_tool_and_keeps_completed_images(
    kind, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.providers import mona_managed_media

    set_config_path(tmp_path / "config.json")
    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "managed-token", "api_base": "https://mona.example/v1",
    })
    posts = []

    def handler(request):
        if request.method == "POST":
            posts.append(request)
            if kind == "image" and len(posts) == 1:
                return httpx.Response(200, json={
                    "status": "succeeded",
                    "result": {"assets": [{"url": "/v1/media/generations/one/assets/0"}]},
                })
            return httpx.Response(402, json={"error": "insufficient_credits", "detail": "No funds"})
        return httpx.Response(200, content=PNG_BYTES, headers={"content-type": "image/png"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        if kind == "image":
            provider = MonaManagedImageGenerationClient(api_key=None)
            tool = ImageGenerationTool(
                workspace=tmp_path,
                config=ImageGenerationToolConfig(
                    enabled=True, provider="mona_managed", model="qwen-image", max_images_per_turn=2,
                ),
            )
            kwargs = {"count": 2}
        else:
            provider = MonaManagedVideoGenerationClient(api_key=None)
            tool = VideoGenerationTool(
                workspace=tmp_path,
                config=VideoGenerationToolConfig(enabled=True, provider="mona_managed", model="video"),
            )
            kwargs = {}
        provider._client = client
        monkeypatch.setattr(tool, "_provider_client", lambda: provider)
        result = json.loads(await tool.execute(prompt="draw", **kwargs))

    assert result["ok"] is False
    assert result["code"] == "INSUFFICIENT_CREDITS"
    assert result["message"] == "模型余额不足，请充值后继续。"
    assert result["retryable"] is False
    if kind == "image":
        assert len(posts) == 2
        assert len(result["artifacts"]) == 1
        assert Path(result["artifacts"][0]["path"]).is_file()
    else:
        assert len(posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(402, "insufficient_credits"), (400, None)])
async def test_managed_media_balance_code_depends_on_status(status, code, monkeypatch):
    from mona.providers import mona_managed_media

    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "managed-token", "api_base": "https://mona.example/v1",
    })
    transport = httpx.MockTransport(lambda _: httpx.Response(status, json={"error": "insufficient_credits"}))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(MonaManagedMediaError) as raised:
            await MonaManagedMediaClient(client=client).generate({"model": "model"})

    assert raised.value.code == code


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["post_disconnect", "post_502", "post_invalid", "poll_disconnect", "poll_503", "poll_invalid"])
async def test_managed_media_uncertain_submission_does_not_reissue(monkeypatch, failure):
    from mona.providers import mona_managed_media

    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "test", "api_base": "https://mona.example/v1",
    })
    calls = []

    def handler(request: httpx.Request):
        calls.append((request.method, request.url.path, request.headers.get("x-request-id")))
        if request.method == "POST":
            if failure == "post_disconnect":
                raise httpx.ConnectError("connection lost", request=request)
            if failure == "post_502":
                return httpx.Response(502)
            if failure == "post_invalid":
                return httpx.Response(200, text="invalid")
            return httpx.Response(202, json={"status": "running"})
        if failure == "poll_disconnect":
            raise httpx.ReadError("connection lost", request=request)
        if failure == "poll_503":
            return httpx.Response(503)
        return httpx.Response(200, text="invalid")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MonaManagedMediaError) as raised:
            await MonaManagedMediaClient(client=client, poll_interval=0).generate({"model": "test"})

    assert raised.value.code == "result_unknown"
    assert [call[0] for call in calls].count("POST") == 1
    if len(calls) > 1:
        assert calls[1][1].endswith("/" + calls[0][2])


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "video"])
async def test_managed_media_unknown_result_is_non_retryable(kind, tmp_path, monkeypatch):
    from mona.providers import mona_managed_media

    set_config_path(tmp_path / "config.json")
    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "test", "api_base": "https://mona.example/v1",
    })
    requests = []

    def handler(request):
        requests.append(request.method)
        return httpx.Response(502)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        if kind == "image":
            provider = MonaManagedImageGenerationClient(api_key=None)
            tool = ImageGenerationTool(workspace=tmp_path, config=ImageGenerationToolConfig(
                enabled=True, provider="mona_managed", model="image",
            ))
        else:
            provider = MonaManagedVideoGenerationClient(api_key=None)
            tool = VideoGenerationTool(workspace=tmp_path, config=VideoGenerationToolConfig(
                enabled=True, provider="mona_managed", model="video",
            ))
        provider._client = client
        monkeypatch.setattr(tool, "_provider_client", lambda: provider)
        result = json.loads(await tool.execute(prompt="draw"))

    assert requests == ["POST"]
    assert result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["retryable"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "video"])
@pytest.mark.parametrize("status,code", [(402, "INSUFFICIENT_CREDITS"), (503, "MEDIA_RESULT_UNKNOWN")])
async def test_managed_media_download_failure_retains_generated_result_url(
    kind, status, code, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.providers import mona_managed_media

    set_config_path(tmp_path / "config.json")
    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "managed-token", "api_base": "https://mona.example/v1",
    })
    asset_url = "/v1/media/generations/one/assets/0"
    calls = []

    def handler(request):
        calls.append(request.method)
        if request.method == "POST":
            result = {"assets": [{"url": asset_url}]} if kind == "image" else {"asset": {"url": asset_url}}
            return httpx.Response(200, json={"status": "succeeded", "result": result})
        return httpx.Response(status, json={"error": "insufficient_credits"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        if kind == "image":
            provider = MonaManagedImageGenerationClient(api_key=None)
            tool = ImageGenerationTool(
                workspace=tmp_path,
                config=ImageGenerationToolConfig(enabled=True, provider="mona_managed", model="image"),
            )
        else:
            provider = MonaManagedVideoGenerationClient(api_key=None)
            tool = VideoGenerationTool(
                workspace=tmp_path,
                config=VideoGenerationToolConfig(enabled=True, provider="mona_managed", model="video"),
            )
        provider._client = client
        monkeypatch.setattr(tool, "_provider_client", lambda: provider)
        result = json.loads(await tool.execute(prompt="draw"))

    assert calls == ["POST", "GET"]
    assert result["code"] == code
    assert result["result_url"] == asset_url
    assert result["retryable"] is False
