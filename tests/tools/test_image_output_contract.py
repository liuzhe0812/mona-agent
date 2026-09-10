from __future__ import annotations

import json
from pathlib import Path

import pytest

from mona.agent.tools.image_generation import ImageGenerationTool, ImageGenerationToolConfig
from mona.providers.image_generation import GeneratedImageResponse, ImageGenerationError

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="


def make_tool(tmp_path, monkeypatch, **defaults):
    tool = ImageGenerationTool(workspace=tmp_path, config=ImageGenerationToolConfig(**defaults))
    calls = []
    class Client:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            return GeneratedImageResponse(images=[PNG], content="", raw={})
    monkeypatch.setattr(tool, "_provider_client", lambda: Client())
    return tool, calls


@pytest.mark.asyncio
async def test_omitted_parameters_use_user_defaults_without_discovery(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch, default_image_size="2K", default_aspect_ratio="9:16")
    assert "image_size" in tool.parameters["properties"]
    assert "aspect_ratio" in tool.parameters["properties"]
    assert "enum" not in tool.parameters["properties"]["image_size"]
    result = json.loads(await tool.execute(prompt="illustration"))
    assert calls[0]["image_size"] == "2K"
    assert calls[0]["aspect_ratio"] == "9:16"
    assert result["artifacts"][0]["requested_size"] == "2K"


@pytest.mark.asyncio
async def test_ai_overrides_defaults_for_one_call_only(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch, default_image_size="1K", default_aspect_ratio="1:1")
    await tool.execute(prompt="cover", image_size="2K", aspect_ratio="16:9")
    await tool.execute(prompt="icon")
    assert (calls[0]["image_size"], calls[0]["aspect_ratio"]) == ("2K", "16:9")
    assert (calls[1]["image_size"], calls[1]["aspect_ratio"]) == ("1K", "1:1")
    assert tool.config.default_image_size == "1K"


@pytest.mark.asyncio
async def test_explicit_pixels_override_default_ratio_and_report_actual_output(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch, default_aspect_ratio="1:1")
    result = json.loads(await tool.execute(prompt="portrait", image_size="768×1024"))
    assert result["ok"] is True
    assert calls[0]["image_size"] == "768x1024"
    assert calls[0]["aspect_ratio"] is None
    artifact = result["artifacts"][0]
    assert artifact["actual_size"] == "1x1"
    assert "notices" not in artifact
    stored = json.loads(Path(artifact["path"]).with_suffix(".json").read_text(encoding="utf-8"))
    assert stored["actual_size"] == "1x1"
    assert stored["requested_size"] == "768x1024"
    assert "notices" not in stored
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_default_pixel_canvas_does_not_override_explicit_ratio(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch, default_image_size="1024x1024")
    await tool.execute(prompt="portrait", aspect_ratio="9:16")
    assert calls[0]["image_size"] is None
    assert calls[0]["aspect_ratio"] == "9:16"


@pytest.mark.asyncio
@pytest.mark.parametrize(("size", "ratio"), [("nonsense", None), ("1024x1536", "9:16"), ("1K", "0:1")])
async def test_invalid_or_conflicting_parameters_do_not_submit(tmp_path, monkeypatch, size, ratio):
    tool, calls = make_tool(tmp_path, monkeypatch)
    error = json.loads(await tool.execute(prompt="draw", image_size=size, aspect_ratio=ratio))
    assert error["code"] == "INVALID_IMAGE_SIZE"
    assert error["retry_safe"] is True
    assert not calls


@pytest.mark.asyncio
async def test_size_rejection_exposes_alternatives_without_changing_defaults(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch)
    class Client:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise ImageGenerationError("unsupported size", code="UNSUPPORTED_IMAGE_SIZE",
                                           supported_sizes=["768x1024"], retry_safe=True)
            return GeneratedImageResponse(images=[PNG], content="", raw={})
    monkeypatch.setattr(tool, "_provider_client", lambda: Client())
    result = json.loads(await tool.execute(prompt="portrait", image_size="2K"))
    assert result["supported_sizes"] == ["768x1024"]
    assert result["retry_safe"] is True
    assert len(calls) == 1
    await tool.execute(prompt="portrait", image_size="768x1024")
    assert calls[1]["image_size"] == "768x1024"
    assert tool.config.default_image_size == "1K"


@pytest.mark.asyncio
async def test_uncertain_submission_is_not_retried(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch)
    class Client:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            raise ImageGenerationError("submission unknown", code="IMAGE_GENERATION_UNCERTAIN", retry_safe=False)
    monkeypatch.setattr(tool, "_provider_client", lambda: Client())
    result = json.loads(await tool.execute(prompt="draw"))
    assert result["retry_safe"] is False
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_partial_success_survives_later_failure(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch)
    class Client:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 2:
                raise ImageGenerationError("failed")
            return GeneratedImageResponse(images=[PNG], content="", raw={})
    monkeypatch.setattr(tool, "_provider_client", lambda: Client())
    result = json.loads(await tool.execute(prompt="draw", count=2))
    assert result["ok"] is False
    assert len(result["artifacts"]) == 1
    assert result["retry_safe"] is False
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_empty_images_do_not_loop(tmp_path, monkeypatch):
    tool, calls = make_tool(tmp_path, monkeypatch)
    class Client:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            return GeneratedImageResponse(images=[], content="", raw={})
    monkeypatch.setattr(tool, "_provider_client", lambda: Client())
    assert "未返回图片" in await tool.execute(prompt="draw")
    assert len(calls) == 1
