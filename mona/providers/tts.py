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

import httpx
from loguru import logger

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


class EdgeTTSProvider(TTSProvider):
    """TTS provider using Microsoft Edge TTS (free, no API key)."""

    name = "edge"

    def __init__(self, voice: str = "zh-CN-XiaoyiNeural", rate: str = "+0%"):
        self.voice = voice
        self.rate = rate

    async def synthesize(self, text: str, output_path: str | Path, *, voice: str = "") -> Path | None:
        try:
            import edge_tts
        except ImportError:
            logger.error("edge-tts not installed. Install with: pip install edge-tts")
            return None

        v = voice or self.voice
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            communicate = edge_tts.Communicate(text, voice=v, rate=_normalize_rate(self.rate))
            await communicate.save(str(out))
            return out
        except Exception as e:
            logger.exception("Edge TTS synthesis failed: {}", e)
            return None

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        """Synthesize via Edge TTS streaming — no temp file."""
        result = await self.synthesize_with_timings(text, voice=voice)
        return result.audio if result is not None else None

    async def synthesize_with_timings(
        self, text: str, *, voice: str = ""
    ) -> TTSSynthesisResult | None:
        """Collect audio and word-boundary metadata from the same Edge stream."""
        try:
            import edge_tts
        except ImportError:
            logger.error("edge-tts not installed. Install with: pip install edge-tts")
            return None
        v = voice or self.voice
        try:
            try:
                communicate = edge_tts.Communicate(
                    text,
                    voice=v,
                    rate=_normalize_rate(self.rate),
                    boundary="WordBoundary",
                )
            except TypeError:
                communicate = edge_tts.Communicate(
                    text, voice=v, rate=_normalize_rate(self.rate)
                )
            chunks: list[bytes] = []
            boundaries: list[dict[str, Any]] = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])
                elif chunk["type"] in {"WordBoundary", "SentenceBoundary"}:
                    start_ms = int(round(float(chunk.get("offset") or 0) / 10_000))
                    duration_ms = max(
                        1, int(round(float(chunk.get("duration") or 0) / 10_000))
                    )
                    boundaries.append(
                        {
                            "text": str(chunk.get("text") or ""),
                            "startMs": start_ms,
                            "endMs": start_ms + duration_ms,
                        }
                    )
            if not chunks:
                logger.error("Edge TTS returned no audio data")
                return None
            return TTSSynthesisResult(
                audio=b"".join(chunks),
                boundaries=tuple(boundaries),
                timing_source="provider-boundary" if boundaries else "missing",
            )
        except Exception as e:
            logger.exception("Edge TTS synthesis failed: {}", e)
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
            "language_boost": "zh",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": v,
                "speed": 1.0,
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
                            attempt + 1, _MAX_RETRIES + 1, e,
                        )
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.exception("MiniMax TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("MiniMax TTS error: {}", e)
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
                    logger.exception("MiniMax TTS HTTP error: {}", e)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.exception("MiniMax TTS malformed response: {}", e)
                    return None

                base_resp = data.get("base_resp") or {}
                if base_resp.get("status_code") not in (None, 0, "0"):
                    logger.error("MiniMax TTS failed: {}", data)
                    return None

                audio_hex = (data.get("data") or {}).get("audio")
                if not audio_hex:
                    logger.error("MiniMax TTS response missing audio data: {}", data)
                    return None

                try:
                    out.write_bytes(binascii.unhexlify(audio_hex))
                except (binascii.Error, ValueError) as e:
                    logger.exception("MiniMax TTS invalid hex audio: {}", e)
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
            "language_boost": "zh",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": v,
                "speed": 1.0,
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
                    logger.exception("MiniMax TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("MiniMax TTS error: {}", e)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.exception("MiniMax TTS HTTP error: {}", e)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.exception("MiniMax TTS malformed response: {}", e)
                    return None

                base_resp = data.get("base_resp") or {}
                if base_resp.get("status_code") not in (None, 0, "0"):
                    logger.error("MiniMax TTS failed: {}", data)
                    return None

                audio_hex = (data.get("data") or {}).get("audio")
                if not audio_hex:
                    logger.error("MiniMax TTS response missing audio data: {}", data)
                    return None

                try:
                    return binascii.unhexlify(audio_hex)
                except (binascii.Error, ValueError) as e:
                    logger.exception("MiniMax TTS invalid hex audio: {}", e)
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
    ):
        self.api_key = api_key or os.environ.get("COSYVOICE_API_KEY") or os.environ.get("DASHSCOPE_API_KEY", "")
        base = (api_base or os.environ.get("COSYVOICE_TTS_BASE_URL") or self.DEFAULT_ENDPOINT).rstrip("/")
        self.api_url = base if base.endswith("/SpeechSynthesizer") else base + "/api/v1/services/audio/tts/SpeechSynthesizer"
        self.voice = voice
        self.model = model

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
                            attempt + 1, _MAX_RETRIES + 1, e,
                        )
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.exception("CosyVoice TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("CosyVoice TTS error: {}", e)
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
                    logger.exception("CosyVoice TTS HTTP error: {}", e)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.exception("CosyVoice TTS malformed response: {}", e)
                    return None

                audio_url = (data.get("output") or {}).get("audio", {}).get("url")
                if not audio_url:
                    logger.error("CosyVoice TTS response missing audio URL: {}", data)
                    return None

                # Download the audio file
                try:
                    audio_resp = await client.get(audio_url, timeout=120.0)
                    audio_resp.raise_for_status()
                    out.write_bytes(audio_resp.content)
                except Exception as e:
                    logger.exception("CosyVoice TTS audio download failed: {}", e)
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
                    logger.exception("CosyVoice TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("CosyVoice TTS error: {}", e)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.exception("CosyVoice TTS HTTP error: {}", e)
                    return None

                try:
                    data = response.json()
                except Exception as e:
                    logger.exception("CosyVoice TTS malformed response: {}", e)
                    return None

                audio_url = (data.get("output") or {}).get("audio", {}).get("url")
                if not audio_url:
                    logger.error("CosyVoice TTS response missing audio URL: {}", data)
                    return None

                try:
                    audio_resp = await client.get(audio_url, timeout=120.0)
                    audio_resp.raise_for_status()
                    return audio_resp.content
                except Exception as e:
                    logger.exception("CosyVoice TTS audio download failed: {}", e)
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

    async def _post(self, client: httpx.AsyncClient, text: str) -> httpx.Response:
        payload: dict[str, object] = {
            "model": self.model,
            "input": text,
            "voice": self.voice or "alloy",
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
                    response = await self._post(client, text)
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.exception("Custom TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("Custom TTS error: {}", e)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.exception("Custom TTS HTTP error: {}", e)
                    return None

                try:
                    out.write_bytes(response.content)
                    return out
                except Exception as e:
                    logger.exception("Custom TTS write failed: {}", e)
                    return None
        return None

    async def synthesize_to_bytes(self, text: str, *, voice: str = "") -> bytes | None:
        if not self.api_key or not self.api_url:
            logger.warning("Custom TTS not configured (api_key/api_base missing)")
            return None

        async with httpx.AsyncClient() as client:
            for attempt in range(_MAX_RETRIES + 1):
                try:
                    response = await self._post(client, text)
                except _RETRYABLE_EXCEPTIONS as e:
                    if attempt < _MAX_RETRIES:
                        await asyncio.sleep(_BACKOFF_S[attempt])
                        continue
                    logger.exception("Custom TTS error after {} attempts: {}", _MAX_RETRIES + 1, e)
                    return None
                except Exception as e:
                    logger.exception("Custom TTS error: {}", e)
                    return None

                if response.status_code in _RETRYABLE_STATUS and attempt < _MAX_RETRIES:
                    await asyncio.sleep(_BACKOFF_S[attempt])
                    continue

                try:
                    response.raise_for_status()
                except Exception as e:
                    logger.exception("Custom TTS HTTP error: {}", e)
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
    """Create a TTS provider instance by name.

    Falls back to EdgeTTSProvider for unknown provider names.
    """
    cls = _PROVIDERS.get(provider, EdgeTTSProvider)

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
    if rate and cls is CustomTTSProvider:
        kwargs["rate"] = rate
    return cls(**kwargs)
