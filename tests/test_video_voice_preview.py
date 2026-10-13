from __future__ import annotations

import json
import types
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import mona.agent  # noqa: F401  (import first to break the api<->agent import cycle)
import mona.api.server as server


def _request(body: object) -> MagicMock:
    request = MagicMock()
    request.json = AsyncMock(return_value=body)
    return request


def _error_body(response) -> dict:
    return json.loads(response.body)


async def test_edge_voice_preview_uses_selected_voice_and_rate(monkeypatch, tmp_path) -> None:
    import mona.providers.tts as tts

    received = []

    async def synthesize(self, text: str, *, voice: str = "") -> bytes:
        received.append((self.voice, self.rate, text, voice))
        return b"edge-preview-audio"

    monkeypatch.setattr(tts.EdgeTTSProvider, "synthesize_to_bytes", synthesize)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "projects")

    response = await server.handle_video_voice_preview(
        _request({"ttsProvider": "edge", "ttsVoice": "zh-CN-YunxiNeural", "ttsRate": "+15%"})
    )

    assert response.status == 200
    assert response.content_type == "audio/mpeg"
    assert response.headers["Cache-Control"] == "no-cache"
    assert response.body == b"edge-preview-audio"
    assert received == [(
        "zh-CN-YunxiNeural",
        "+15%",
        "你好，我是 Mona。这是我的声音，你可以听听是否适合这个视频。",
        "zh-CN-YunxiNeural",
    )]
    assert not (tmp_path / "projects").exists()


async def test_custom_voice_preview_reuses_global_tts_configuration(monkeypatch, tmp_path) -> None:
    import mona.config.loader as loader
    import mona.providers.tts as tts
    from mona.config.schema import ChannelsConfig

    channels = ChannelsConfig(
        tts_provider="custom",
        tts_api_base="https://speech.example.test/v1",
        tts_api_key="test-only-key",
        tts_model="test-model",
        tts_voice="global-voice",
    )
    monkeypatch.setattr(loader, "load_config", lambda: types.SimpleNamespace(channels=channels))
    received = []

    async def synthesize(self, text: str, *, voice: str = "") -> bytes:
        received.append((self.api_key, self.api_url, self.model, self.voice, self.rate, text, voice))
        return b"custom-preview-audio"

    monkeypatch.setattr(tts.CustomTTSProvider, "synthesize_to_bytes", synthesize)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "projects")

    response = await server.handle_video_voice_preview(
        _request({"ttsProvider": "custom", "ttsRate": "+10%"})
    )

    assert response.status == 200
    assert response.body == b"custom-preview-audio"
    assert received == [(
        "test-only-key",
        "https://speech.example.test/v1/audio/speech",
        "test-model",
        "global-voice",
        "+10%",
        "你好，我是 Mona。这是我的声音，你可以听听是否适合这个视频。",
        "global-voice",
    )]
    assert not (tmp_path / "projects").exists()


@pytest.mark.parametrize(
    "body",
    [
        {"ttsVoice": "zh-CN-XiaoyiNeural", "text": "不接受自定义试音文案"},
        {"ttsProvider": "edge", "ttsRate": "fast"},
        {"project": "video-project"},
    ],
)
async def test_voice_preview_rejects_unknown_or_invalid_settings(body) -> None:
    response = await server.handle_video_voice_preview(_request(body))
    assert response.status == 400


async def test_voice_preview_returns_typed_tts_failure_without_writing_project(monkeypatch, tmp_path) -> None:
    import mona.providers.tts as tts

    async def no_audio(self, *_args, **_kwargs):
        return None

    monkeypatch.setattr(tts.EdgeTTSProvider, "synthesize_to_bytes", no_audio)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "projects")

    response = await server.handle_video_voice_preview(_request({"ttsVoice": "zh-CN-XiaoyiNeural"}))

    assert response.status == 503
    assert _error_body(response)["code"] == "TTS_SERVICE_UNAVAILABLE"
    assert _error_body(response)["retryable"] is True
    assert not (tmp_path / "projects").exists()


async def test_voice_preview_preserves_provider_tts_error(monkeypatch, tmp_path) -> None:
    import mona.providers.tts as tts

    async def fail(self, *_args, **_kwargs):
        raise tts.TTSError("音色暂时不可用", code="TTS_SETTINGS_INVALID", retryable=False)

    monkeypatch.setattr(tts.EdgeTTSProvider, "synthesize_to_bytes", fail)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "projects")

    response = await server.handle_video_voice_preview(_request({"ttsVoice": "zh-CN-XiaoyiNeural"}))

    assert response.status == 422
    assert _error_body(response) == {
        "ok": False,
        "error": "音色暂时不可用",
        "code": "TTS_SETTINGS_INVALID",
        "retryable": False,
    }
    assert not (tmp_path / "projects").exists()


async def test_voice_preview_service_route_is_registered(monkeypatch, tmp_path) -> None:
    import mona.services.server as services

    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "video-preview-route-test-token")
    monkeypatch.setattr(services.imap_pool_manager, "keepalive", lambda *_args: None)
    monkeypatch.setattr(services._idle_manager, "set_loop", lambda _loop: None)
    app = services.create_services_app()

    assert any(
        route.method == "POST"
        and route.resource.canonical == "/api/video/voice-preview"
        for route in app.router.routes()
    )


async def test_voice_preview_requires_services_token(monkeypatch) -> None:
    import mona.materials.auth as auth
    import mona.providers.tts as tts

    monkeypatch.setenv("MONA_SERVICES_TOKEN", "video-preview-test-token")
    monkeypatch.setattr(
        tts.EdgeTTSProvider,
        "synthesize_to_bytes",
        AsyncMock(return_value=b"preview-audio"),
    )
    app = web.Application(middlewares=[auth.materials_auth_middleware])
    app.router.add_post("/api/video/voice-preview", server.handle_video_voice_preview)

    async with TestClient(TestServer(app)) as client:
        denied = await client.post("/api/video/voice-preview", json={"ttsVoice": "zh-CN-XiaoyiNeural"})
        allowed = await client.post(
            "/api/video/voice-preview",
            json={"ttsVoice": "zh-CN-XiaoyiNeural"},
            headers={"X-Mona-Token": "video-preview-test-token"},
        )
        allowed_body = await allowed.read()

    assert denied.status == 401
    assert allowed.status == 200
    assert allowed_body == b"preview-audio"
