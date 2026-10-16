"""TTS boundary metadata must stay bound to the exact synthesized audio."""

import asyncio
import sys
import types

import httpx
import pytest

import mona.providers.tts as tts
from mona.providers.tts import EdgeTTSProvider, TTSSynthesisResult


async def test_edge_retry_keeps_voice_and_discards_partial_failed_audio(monkeypatch) -> None:
    import aiohttp

    voices = []

    class Communicate:
        def __init__(self, _text, **kwargs):
            voices.append(kwargs["voice"])
            self.attempt = len(voices)

        async def stream(self):
            if self.attempt == 1:
                yield {"type": "audio", "data": b"partial-failed-audio"}
                raise aiohttp.ClientConnectionError("network failure")
            yield {"type": "audio", "data": b"complete-audio"}
            yield {"type": "WordBoundary", "offset": 100_000, "duration": 200_000, "text": "验证"}

    async def retry_delay(_seconds):
        pass

    monkeypatch.setitem(sys.modules, "edge_tts", types.SimpleNamespace(Communicate=Communicate))
    monkeypatch.setattr(tts.asyncio, "sleep", retry_delay)
    result = await EdgeTTSProvider("zh-CN-XiaoyiNeural").synthesize_with_timings("验证")
    assert result.audio == b"complete-audio"
    assert result.boundaries == ({"text": "验证", "startMs": 10, "endMs": 30},)
    assert voices == ["zh-CN-XiaoyiNeural", "zh-CN-XiaoyiNeural"]


async def test_missing_speech_component_is_non_retryable_and_does_not_create_audio(monkeypatch, tmp_path) -> None:
    monkeypatch.setitem(sys.modules, "edge_tts", None)
    with pytest.raises(tts.TTSError) as raised:
        await EdgeTTSProvider().synthesize("验证", tmp_path / "missing.mp3")
    assert raised.value.code == "TTS_COMPONENT_MISSING"
    assert raised.value.retryable is False
    assert not (tmp_path / "missing.mp3").exists()


async def test_old_edge_protocol_is_reported_before_any_synthesis(monkeypatch, tmp_path) -> None:
    from unittest.mock import Mock

    communicate = Mock()
    monkeypatch.setitem(sys.modules, "edge_tts", types.SimpleNamespace(__version__="7.2.8", Communicate=communicate))
    with pytest.raises(tts.TTSError) as raised:
        await EdgeTTSProvider().synthesize("验证", tmp_path / "old.mp3")
    assert raised.value.code == "TTS_COMPONENT_OUTDATED"
    assert raised.value.retryable is False
    communicate.assert_not_called()
    assert not (tmp_path / "old.mp3").exists()


async def test_edge_tts_collects_audio_and_word_boundaries_from_one_stream(
    monkeypatch,
) -> None:
    calls: list[dict] = []

    class Communicate:
        def __init__(self, text, **kwargs) -> None:
            calls.append({"text": text, **kwargs})

        async def stream(self):
            yield {"type": "audio", "data": b"first"}
            yield {
                "type": "WordBoundary",
                "offset": 1_200_000,
                "duration": 3_400_000,
                "text": "系列视频",
            }
            yield {"type": "audio", "data": b"second"}

    monkeypatch.setitem(sys.modules, "edge_tts", types.SimpleNamespace(Communicate=Communicate))
    monkeypatch.setattr(tts, "getproxies", lambda: {"https": "http://127.0.0.1:8877"})
    monkeypatch.setattr(tts, "proxy_bypass", lambda _host: False)
    provider = EdgeTTSProvider(voice="zh-CN-Test", rate="+10%")

    result = await provider.synthesize_with_timings("系列视频")

    assert isinstance(result, TTSSynthesisResult)
    assert result.audio == b"firstsecond"
    assert result.timing_source == "provider-boundary"
    assert result.boundaries == (
        {"text": "系列视频", "startMs": 120, "endMs": 460},
    )
    assert calls == [
        {
            "text": "系列视频",
            "voice": "zh-CN-Test",
            "rate": "+10%",
            "boundary": "WordBoundary",
            "proxy": "http://127.0.0.1:8877",
        }
    ]


async def test_edge_tts_bytes_api_remains_backward_compatible(monkeypatch) -> None:
    class Communicate:
        def __init__(self, _text, **_kwargs) -> None:
            pass

        async def stream(self):
            yield {"type": "audio", "data": b"audio"}

    monkeypatch.setitem(sys.modules, "edge_tts", types.SimpleNamespace(Communicate=Communicate))
    provider = EdgeTTSProvider()
    assert await provider.synthesize_to_bytes("兼容") == b"audio"


@pytest.mark.parametrize("proxies,bypass,expected", [
    ({}, False, None),
    ({"https": "http://127.0.0.1:8877"}, False, "http://127.0.0.1:8877"),
    ({"https": "http://127.0.0.1:8877", "wss": "http://127.0.0.1:8878"}, False, "http://127.0.0.1:8878"),
    ({"https": "http://127.0.0.1:8877"}, True, None),
])
def test_edge_tts_respects_system_websocket_proxy_and_bypass(monkeypatch, proxies, bypass, expected):
    monkeypatch.setattr(tts, "getproxies", lambda: proxies)
    monkeypatch.setattr(tts, "proxy_bypass", lambda _host: bypass)
    assert tts._edge_proxy() == expected


async def test_custom_tts_uses_each_call_voice_without_mutating_provider(monkeypatch) -> None:
    import json

    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, content=b"audio")

    client_type = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda: client_type(transport=httpx.MockTransport(respond)))
    provider = tts.CustomTTSProvider(api_base="https://speech.example.test", api_key="test-only", voice="default")
    assert await asyncio.gather(
        provider.synthesize_to_bytes("第一句", voice="first"),
        provider.synthesize_to_bytes("第二句", voice="second"),
        provider.synthesize_to_bytes("默认声音"),
    ) == [b"audio", b"audio", b"audio"]
    assert [request["voice"] for request in requests] == ["first", "second", "default"]
    assert provider.voice == "default"


def test_tts_factory_rejects_unknown_provider() -> None:
    with pytest.raises(tts.TTSError) as error:
        tts.get_tts_provider("unknown")
    assert error.value.code == "TTS_PROVIDER_UNSUPPORTED"


@pytest.mark.parametrize("provider_name", ["minimax", "cosyvoice"])
@pytest.mark.parametrize("method", ["synthesize", "synthesize_to_bytes"])
async def test_native_tts_sends_configured_rate_on_both_apis(monkeypatch, tmp_path, provider_name, method) -> None:
    import json
    import socket

    requests = []

    def respond(request):
        if request.method == "GET":
            return httpx.Response(200, content=b"audio")
        requests.append(json.loads(request.content))
        if provider_name == "minimax":
            return httpx.Response(200, json={"data": {"audio": b"audio".hex()}, "base_resp": {"status_code": 0}})
        return httpx.Response(200, json={"output": {"audio": {"url": "https://speech.example.test/audio.mp3"}}})

    client_type = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda: client_type(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr("mona.security.network.socket.getaddrinfo", lambda *_args: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    provider = tts.get_tts_provider(provider_name, api_key="test-only", api_base="https://speech.example.test", rate="+20%")
    if method == "synthesize":
        result = await provider.synthesize("语速测试", tmp_path / "speech.mp3")
        assert result.read_bytes() == b"audio"
    else:
        assert await provider.synthesize_to_bytes("语速测试") == b"audio"
    if provider_name == "minimax":
        assert requests[0]["voice_setting"]["speed"] == 1.2
        assert requests[0]["language_boost"] == "auto"
    else:
        assert requests[0]["input"]["rate"] == 1.2


@pytest.mark.parametrize("provider_name", ["minimax", "cosyvoice"])
@pytest.mark.parametrize("rate", ["-51%", "+101%", "fast"])
def test_native_tts_rejects_unsupported_rate(provider_name, rate) -> None:
    with pytest.raises(tts.TTSError) as error:
        tts.get_tts_provider(provider_name, rate=rate)
    assert error.value.code == "TTS_RATE_UNSUPPORTED"


@pytest.mark.parametrize("method", ["synthesize", "synthesize_to_bytes"])
@pytest.mark.parametrize("audio_url", ["http://127.0.0.1/audio.mp3", "http://169.254.169.254/audio.mp3", "file:///audio.mp3"])
async def test_cosyvoice_rejects_unsafe_result_audio_before_download(monkeypatch, tmp_path, method, audio_url) -> None:
    downloads = []

    def respond(request):
        if request.method == "POST":
            return httpx.Response(200, json={"output": {"audio": {"url": audio_url}}})
        downloads.append(request.url)
        return httpx.Response(200, content=b"audio")

    client_type = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda: client_type(transport=httpx.MockTransport(respond)))
    provider = tts.CosyVoiceTTSProvider(api_key="test-only", api_base="https://speech.example.test")
    if method == "synthesize":
        result = await provider.synthesize("网址校验", tmp_path / "speech.mp3")
    else:
        result = await provider.synthesize_to_bytes("网址校验")
    assert result is None
    assert downloads == []


@pytest.mark.parametrize("provider_name", ["custom", "minimax", "cosyvoice"])
async def test_provider_http_failure_logs_status_without_request_url(monkeypatch, provider_name) -> None:
    records = []
    client_type = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda: client_type(transport=httpx.MockTransport(lambda _request: httpx.Response(403))))
    provider = tts.get_tts_provider(provider_name, api_key="test-only", api_base="https://speech.example.test?signature=private-test-marker")
    sink = tts.logger.add(lambda message: records.append(str(message)))
    try:
        assert await provider.synthesize_to_bytes("日志校验") is None
    finally:
        tts.logger.remove(sink)
    logs = "".join(records)
    assert "403" in logs
    assert "private-test-marker" not in logs
    assert "speech.example.test" not in logs

