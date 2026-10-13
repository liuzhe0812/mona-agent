"""Text-to-speech providers (Edge TTS, MiniMax, CosyVoice).

Mirrors the transcription.py pattern: a thin async provider layer that
channels and the HTTP API can reuse without depending on the PPT skill.
"""

from __future__ import annotations

import asyncio
import binascii
import contextlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.request import getproxies, proxy_bypass

import aiohttp
import httpx
from loguru import logger

from mona.security.network import validate_url_target

# Up to 2 retries (3 attempts total) with exponential backoff.
_MAX_RETRIES = 2
_BACKOFF_S = (1.0, 2.0)
_RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
_RETRYABLE_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
)


class TTSError(RuntimeError):
    def __init__(self, message: str, *, code: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class TTSSynthesisResult:
    audio: bytes
    boundaries: tuple[dict[str, Any], ...] = ()
    timing_source: str = "missing"


class TTSProvider:
    """Base class for TTS providers."""

    name: str = "base"

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        """Synthesize *text* to an audio file at *output_path*.

        Returns the Path on success, None on failure.
        """
        raise NotImplementedError

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        """Synthesize *text* and return raw audio bytes (no temp file).

        Default implementation calls synthesize() to a temp file then reads
        it back.  Subclasses may override for true in-memory synthesis.
        """
        import tempfile
        tmp = Path(tempfile.mktemp(suffix=".mp3"))
        try:
            result = await self.synthesize(text, tmp, voice=voice)
            if result is None:
                return None
            return result.read_bytes()
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()

    async def synthesize_with_timings(
        self, text: str, *, voice: str = ""
    ) -> TTSSynthesisResult | None:
        audio = await self.synthesize_to_bytes(text, voice=voice)
        return TTSSynthesisResult(audio=audio) if audio is not None else None


# ---------------------------------------------------------------------------
# Edge TTS (free, no API key required)
# ---------------------------------------------------------------------------

def _normalize_rate(rate: str) -> str:
    """Normalize a rate string into edge-tts format (e.g. '+0%', '+10%')."""
    value = rate.strip()
    if not value:
        return "+0%"
    if value.endswith("%"):
        return value if value[0] in "+-" else f"+{value}"
    if re.fullmatch(r"[+-]?\d+", value):
        return f"{int(value):+d}%"
    return value


def _native_tts_speed(rate: str) -> float:
    normalized = _normalize_rate(rate)
    if not re.fullmatch(r"[+-]?\d+%", normalized):
        raise TTSError("配音语速设置无效，请重新选择语速。", code="TTS_RATE_UNSUPPORTED")
    speed = 1.0 + int(normalized.rstrip("%")) / 100.0
    if not 0.5 <= speed <= 2.0:
        raise TTSError("所选配音服务支持 0.5 到 2 倍语速，请调整语速。", code="TTS_RATE_UNSUPPORTED")
    return speed


def _edge_proxy() -> str | None:
    if proxy_bypass("speech.platform.bing.com"):
        return None
    proxies = getproxies()
    # aiohttp looks up wss directly; Windows commonly configures only https.
    return proxies.get("wss") or proxies.get("https")


class EdgeTTSProvider(TTSProvider):
    """Stream speech and its timing together; transient recovery keeps the voice."""

    name = "edge"

    def __init__(self, voice: str = "zh-CN-XiaoyiNeural", rate: str = "+0%"):
        self.voice = voice
        self.rate = rate

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        result = await self.synthesize_with_timings(text, voice=voice)
        if result is None:
            return None
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(result.audio)
        return out

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        result = await self.synthesize_with_timings(text, voice=voice)
        return result.audio if result is not None else None

    async def synthesize_with_timings(self, text: str, *, voice: str = "") -> TTSSynthesisResult | None:
        try:
            import edge_tts
        except ImportError as exc:
            logger.error("Speech component missing in the application environment")
            raise TTSError("配音组件未准备好，请更新应用后重试。", code="TTS_COMPONENT_MISSING") from exc
        chosen_voice = voice or self.voice
        for attempt in range(_MAX_RETRIES + 1):
            chunks: list[bytes] = []
            boundaries: list[dict[str, Any]] = []
            try:
                communicate = edge_tts.Communicate(
                    text, voice=chosen_voice, rate=_normalize_rate(self.rate),
                    boundary="WordBoundary", proxy=_edge_proxy(),
                )
                async with asyncio.timeout(30):
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            chunks.append(chunk["data"])
                        elif chunk["type"] in {"WordBoundary", "SentenceBoundary"}:
                            start_ms = int(round(float(chunk.get("offset") or 0) / 10_000))
                            duration_ms = max(1, int(round(float(chunk.get("duration") or 0) / 10_000)))
                            boundaries.append({"text": str(chunk.get("text") or ""),
                                               "startMs": start_ms, "endMs": start_ms + duration_ms})
                if not chunks:
                    raise TTSError("配音服务没有返回声音，请稍后重试；已保留当前声音设置。",
                                   code="TTS_SERVICE_UNAVAILABLE", retryable=True)
                return TTSSynthesisResult(audio=b"".join(chunks), boundaries=tuple(boundaries),
                                          timing_source="provider-boundary" if boundaries else "missing")
            except Exception as exc:
                status = getattr(exc, "status", None)
                transient = (isinstance(exc, (asyncio.TimeoutError, aiohttp.ClientConnectionError))
                             or type(exc).__name__ in {"NoAudioReceived", "WebSocketError"}
                             or status in _RETRYABLE_STATUS
                             or isinstance(exc, TTSError) and exc.retryable)
                logger.warning("Speech request failed: {} (HTTP {}, attempt {})", type(exc).__name__, status, attempt + 1)
                if transient and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue
                if isinstance(exc, TTSError):
                    raise
                if isinstance(exc, TypeError):
                    raise TTSError("配音组件版本不匹配，请更新应用后重试。", code="TTS_COMPONENT_OUTDATED") from None
                if isinstance(exc, ValueError):
                    raise TTSError("配音参数无效，请检查声音和语速设置。", code="TTS_SETTINGS_INVALID") from None
                raise TTSError("配音服务暂时未能完成请求；已保留当前声音设置，请稍后重试。",
                               code="TTS_SERVICE_UNAVAILABLE", retryable=transient) from None
        return None


# ---------------------------------------------------------------------------
# MiniMax TTS
# ---------------------------------------------------------------------------

class MiniMaxTTSProvider(TTSProvider):
    """TTS provider using MiniMax T2A v2 API."""

    name = "minimax"

    DEFAULT_ENDPOINT = "https://api.minimaxi.com/v1/t2a_v2"
    DEFAULT_MODEL = "speech-2.8-hd"

    def __init__(
        self,
        api_key: str | None = None,
        api_base: str | None = None,
        voice: str = "female-shaonv",
        model: str = DEFAULT_MODEL,
        rate: str = "+0%",
    ):
        self.api_key = api_key or os.environ.get("MINIMAX_API_KEY", "")
        base = (api_base or os.environ.get("MINIMAX_TTS_BASE_URL") or self.DEFAULT_ENDPOINT).rstrip("/")
        if base.endswith("/t2a_v2"):
            self.api_url = base
        elif base.endswith("/v1"):
            self.api_url = base + "/t2a_v2"
        else:
            self.api_url = base + "/v1/t2a_v2"
        self.voice = voice
        self.model = model
        self.speed = _native_tts_speed(rate)

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        if not self.api_key:
            logger.warning("MiniMax API key not configured for TTS")
            return None

        v = voice or self.voice
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        payload = {
            "model": self.model,
            "text": text,
            "stream": False,
            "language_boost": "auto",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": v,
                "speed": self.speed,
                "vol": 1.0,
                "pitch": 0,
            },
            "audio_setting": {
                "sample_rate": 24000,
                "bitrate": 128000,
                "format": "mp3",
                "channel": 1,
            },
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await client.post(
                        self.api_url, json=payload, headers=headers, timeout=60.0
                    )
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        logger.warning(
                            "MiniMax TTS transient error (attempt {}/{}): {}",
                            attempt + 1, _MAX_RETRIES + 1, type(e).__name__,
                        )
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("MiniMax TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("MiniMax TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    logger.warning(
                        "MiniMax TTS transient HTTP {} (attempt {}/{})",
                        response.status_code, attempt + 1, _MAX_RETRIES + 1,
                    )
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("MiniMax TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.error("MiniMax TTS malformed response: {}", type(e).__name__)
                    return None

                base_resp = data.get("base_resp") or {}
                if base_resp.get("status_code") not in (None, 0, "0"):
                    status = base_resp.get("status_code")
                    logger.error("MiniMax TTS service error (status {})", status if isinstance(status, int) else None)
                    return None

                audio_hex = (data.get("data") or {}).get("audio")
                if not audio_hex:
                    logger.error("MiniMax TTS response missing audio data")
                    return None

                try:
                    out.write_bytes(binascii.unhexlify(audio_hex))
                except (binascii.Error, ValueError) as e:
                    logger.error("MiniMax TTS invalid hex audio: {}", type(e).__name__)
                    return None

                return out

        return None

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        """Synthesize via MiniMax API — returns bytes directly, no temp file."""
        if not self.api_key:
            logger.warning("MiniMax API key not configured for TTS")
            return None

        v = voice or self.voice
        payload = {
            "model": self.model,
            "text": text,
            "stream": False,
            "language_boost": "auto",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": v,
                "speed": self.speed,
                "vol": 1.0,
                "pitch": 0,
            },
            "audio_setting": {
                "sample_rate": 24000,
                "bitrate": 128000,
                "format": "mp3",
                "channel": 1,
            },
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await client.post(
                        self.api_url, json=payload, headers=headers, timeout=60.0
                    )
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("MiniMax TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("MiniMax TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("MiniMax TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.error("MiniMax TTS malformed response: {}", type(e).__name__)
                    return None

                base_resp = data.get("base_resp") or {}
                if base_resp.get("status_code") not in (None, 0, "0"):
                    status = base_resp.get("status_code")
                    logger.error("MiniMax TTS service error (status {})", status if isinstance(status, int) else None)
                    return None

                audio_hex = (data.get("data") or {}).get("audio")
                if not audio_hex:
                    logger.error("MiniMax TTS response missing audio data")
                    return None

                try:
                    return binascii.unhexlify(audio_hex)
                except (binascii.Error, ValueError) as e:
                    logger.error("MiniMax TTS invalid hex audio: {}", type(e).__name__)
                    return None

        return None


# ---------------------------------------------------------------------------
# CosyVoice (Alibaba DashScope)
# ---------------------------------------------------------------------------

class CosyVoiceTTSProvider(TTSProvider):
    """TTS provider using Alibaba CosyVoice via DashScope API."""

    name = "cosyvoice"

    DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"
    DEFAULT_MODEL = "cosyvoice-v3-flash"

    def __init__(
        self,
        api_key: str | None = None,
        api_base: str | None = None,
        voice: str = "longxiaoxia",
        model: str = DEFAULT_MODEL,
        rate: str = "+0%",
    ):
        self.api_key = api_key or os.environ.get("COSYVOICE_API_KEY") or os.environ.get("DASHSCOPE_API_KEY", "")
        base = (api_base or os.environ.get("COSYVOICE_TTS_BASE_URL") or self.DEFAULT_ENDPOINT).rstrip("/")
        self.api_url = base if base.endswith("/SpeechSynthesizer") else base + "/api/v1/services/audio/tts/SpeechSynthesizer"
        self.voice = voice
        self.model = model
        self.speed = _native_tts_speed(rate)

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        if not self.api_key:
            logger.warning("CosyVoice API key not configured for TTS")
            return None

        v = voice or self.voice
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        input_payload: dict[str, object] = {
            "text": text,
            "voice": v,
            "format": "mp3",
            "sample_rate": 24000,
            "rate": self.speed,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await client.post(
                        self.api_url,
                        json={"model": self.model, "input": input_payload},
                        headers=headers,
                        timeout=60.0,
                    )
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        logger.warning(
                            "CosyVoice TTS transient error (attempt {}/{}): {}",
                            attempt + 1, _MAX_RETRIES + 1, type(e).__name__,
                        )
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("CosyVoice TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("CosyVoice TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    logger.warning(
                        "CosyVoice TTS transient HTTP {} (attempt {}/{})",
                        response.status_code, attempt + 1, _MAX_RETRIES + 1,
                    )
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("CosyVoice TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.error("CosyVoice TTS malformed response: {}", type(e).__name__)
                    return None

                audio_url = (data.get("output") or {}).get("audio", {}).get("url")
                if not audio_url:
                    logger.error("CosyVoice TTS response missing audio URL")
                    return None

                safe, _reason = validate_url_target(str(audio_url))
                if not safe:
                    logger.error("CosyVoice TTS returned an unsafe audio URL")
                    return None

                # Download the audio file
                try:
                    audio_resp = await client.get(audio_url, timeout=120.0)
                    audio_resp.raise_for_status()
                    out.write_bytes(audio_resp.content)
                except Exception as e:
                    logger.error("CosyVoice TTS audio download failed: {}", type(e).__name__)
                    return None

                return out

        return None

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        """Synthesize via CosyVoice API — returns bytes directly, no temp file."""
        if not self.api_key:
            logger.warning("CosyVoice API key not configured for TTS")
            return None

        v = voice or self.voice
        input_payload: dict[str, object] = {
            "text": text,
            "voice": v,
            "format": "mp3",
            "sample_rate": 24000,
            "rate": self.speed,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await client.post(
                        self.api_url,
                        json={"model": self.model, "input": input_payload},
                        headers=headers,
                        timeout=60.0,
                    )
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("CosyVoice TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("CosyVoice TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("CosyVoice TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.error("CosyVoice TTS malformed response: {}", type(e).__name__)
                    return None

                audio_url = (data.get("output") or {}).get("audio", {}).get("url")
                if not audio_url:
                    logger.error("CosyVoice TTS response missing audio URL")
                    return None

                safe, _reason = validate_url_target(str(audio_url))
                if not safe:
                    logger.error("CosyVoice TTS returned an unsafe audio URL")
                    return None

                try:
                    audio_resp = await client.get(audio_url, timeout=120.0)
                    audio_resp.raise_for_status()
                    return audio_resp.content
                except Exception as e:
                    logger.error("CosyVoice TTS audio download failed: {}", type(e).__name__)
                    return None

        return None


# ---------------------------------------------------------------------------
# Custom TTS (OpenAI-compatible /audio/speech endpoint)
# ---------------------------------------------------------------------------

class CustomTTSProvider(TTSProvider):
    """TTS provider using an OpenAI-compatible /v1/audio/speech endpoint.

    The user supplies api_base, api_key, model and voice. Works with any
    provider that mirrors the OpenAI TTS API (MiniMax, SiliconFlow, etc.).
    """

    name = "custom"

    def __init__(
        self,
        api_key: str | None = None,
        api_base: str | None = None,
        voice: str = "",
        model: str = "tts-1",
        rate: str = "+0%",
    ):
        self.api_key = api_key or ""
        base = (api_base or "").rstrip("/")
        if not base:
            self.api_url = ""
        elif base.endswith("/v1/audio/speech"):
            self.api_url = base
        elif base.endswith("/v1"):
            self.api_url = base + "/audio/speech"
        elif base.endswith("/audio/speech"):
            self.api_url = base
        else:
            self.api_url = base + "/v1/audio/speech"
        self.voice = voice
        self.model = model or "tts-1"
        self.rate = rate

    async def _post(self, client: httpx.AsyncClient, text: str, *, voice: str = "") -> httpx.Response:
        payload: dict[str, object] = {
            "model": self.model,
            "input": text,
            "voice": voice or self.voice or "alloy",
            "response_format": "mp3",
        }
        # OpenAI TTS supports speed in [0.25, 4.0]; pass only if non-default.
        rate_value = _normalize_rate(self.rate)
        if rate_value not in ("+0%", "0%"):
            try:
                pct = int(rate_value.rstrip("%").replace("+", ""))
                speed = max(0.25, min(4.0, 1.0 + pct / 100.0))
                payload["speed"] = speed
            except ValueError:
                pass

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        return await client.post(self.api_url, json=payload, headers=headers, timeout=60.0)

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        if not self.api_key or not self.api_url:
            logger.warning("Custom TTS not configured (api_key/api_base missing)")
            return None
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await self._post(client, text, voice=voice)
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("Custom TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("Custom TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("Custom TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                try:
                    out.write_bytes(response.content)
                    return out
                except Exception as e:
                    logger.error("Custom TTS write failed: {}", type(e).__name__)
                    return None
        return None

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        if not self.api_key or not self.api_url:
            logger.warning("Custom TTS not configured (api_key/api_base missing)")
            return None

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await self._post(client, text, voice=voice)
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.error("Custom TTS error after {} attempts: {}", _MAX_RETRIES + 1, type(e).__name__)
                    return None
                except Exception as e:
                    logger.error("Custom TTS error: {}", type(e).__name__)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.error("Custom TTS HTTP error (status {}): {}", response.status_code, type(e).__name__)
                    return None

                return response.content
        return None


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

_PROVIDERS: dict[str, type[TTSProvider]] = {
    "edge": EdgeTTSProvider,
    "minimax": MiniMaxTTSProvider,
    "cosyvoice": CosyVoiceTTSProvider,
    "custom": CustomTTSProvider,
}


def get_tts_provider(
    provider: str = "edge",
    *,
    api_key: str | None = None,
    api_base: str | None = None,
    voice: str = "",
    model: str = "",
    rate: str = "",
) -> TTSProvider:
    """Create a TTS provider instance by its explicit protocol name."""
    cls = _PROVIDERS.get(provider)
    if cls is None:
        raise TTSError("所选配音服务不受支持，请检查配音服务设置。", code="TTS_PROVIDER_UNSUPPORTED")

    if cls is EdgeTTSProvider:
        return cls(voice=voice or "zh-CN-XiaoyiNeural", rate=rate or "+0%")

    kwargs: dict[str, Any] = {}
    if api_key:
        kwargs["api_key"] = api_key
    if api_base:
        kwargs["api_base"] = api_base
    if voice:
        kwargs["voice"] = voice
    if model:
        kwargs["model"] = model
    if rate:
        kwargs["rate"] = rate
    return cls(**kwargs)
