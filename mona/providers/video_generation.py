"""Video generation provider helpers.

Video generation is asynchronous: a creation request returns a task/video id,
and the client polls a status endpoint until the video is ready, then returns
the downloadable video URL.  This mirrors the pattern used by Agnes AI's
``agnes-video-v2.0`` model (POST /v1/videos → GET /agnesapi?video_id=…).
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx
from loguru import logger

from mona.providers.registry import find_by_name

_DEFAULT_TIMEOUT_S = 60.0
_DEFAULT_POLL_INTERVAL_S = 5.0
_DEFAULT_POLL_TIMEOUT_S = 600.0

# Agnes AI aspect ratio → (width, height).  Default native size is 1152x768.
_AGNES_ASPECT_RATIO_SIZES = {
    "16:9": (1152, 768),
    "9:16": (768, 1152),
    "1:1": (768, 768),
    "4:3": (1024, 768),
    "3:4": (768, 1024),
}

# Target duration (seconds) → (num_frames, frame_rate).  num_frames must be ≤441
# and follow the 8n+1 rule (see Agnes docs).
_AGNES_DURATION_PRESETS = {
    3: (81, 24),
    5: (121, 24),
    10: (241, 24),
    18: (441, 24),
}


class VideoGenerationError(RuntimeError):
    """Raised when the video generation provider cannot return a video."""


@dataclass(frozen=True)
class GeneratedVideoResponse:
    """Video URL and optional metadata returned by the provider."""

    video_url: str
    content: str
    raw: dict[str, Any]
    status: str
    progress: int
    seconds: str | None = None
    size: str | None = None


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_VIDEO_GEN_PROVIDERS: dict[str, type[VideoGenerationProvider]] = {}


def register_video_gen_provider(cls: type[VideoGenerationProvider]) -> None:
    name = cls.provider_name
    if not name:
        raise ValueError(f"{cls.__name__} must set provider_name")
    _VIDEO_GEN_PROVIDERS[name] = cls


def get_video_gen_provider(name: str) -> type[VideoGenerationProvider] | None:
    return _VIDEO_GEN_PROVIDERS.get(name)


def video_gen_provider_names() -> tuple[str, ...]:
    """Return registered video generation provider names in registry order."""
    return tuple(_VIDEO_GEN_PROVIDERS)


def video_gen_provider_configs(config: Any) -> dict[str, Any]:
    """Return provider configs usable for video generation.

    Includes all non-OAuth providers so the user can pick any one in the
    settings UI and configure credentials + model ID inline.  Only providers
    with a registered video-gen client will actually work at runtime, but
    the config is passed for all to avoid credential lookup failures.
    """
    from mona.providers.registry import PROVIDERS

    providers_cfg = config.providers
    result: dict[str, Any] = {}
    for spec in PROVIDERS:
        if spec.is_oauth or spec.is_local:
            continue
        pc = getattr(providers_cfg, spec.name, None)
        if pc is not None:
            result[spec.name] = pc
    return result


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------


class VideoGenerationProvider(ABC):
    """Base class for video generation provider clients."""

    provider_name: str = ""
    missing_key_message: str = ""
    default_timeout: float = _DEFAULT_TIMEOUT_S

    def __init__(
        self,
        *,
        api_key: str | None,
        api_base: str | None = None,
        extra_headers: dict[str, str] | None = None,
        extra_body: dict[str, Any] | None = None,
        timeout: float | None = None,
        poll_interval: float | None = None,
        poll_timeout: float | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self.api_base = self._resolve_base_url(api_base)
        self.extra_headers = extra_headers or {}
        self.extra_body = extra_body or {}
        self.timeout = timeout if timeout is not None else self.default_timeout
        self.poll_interval = poll_interval if poll_interval is not None else _DEFAULT_POLL_INTERVAL_S
        self.poll_timeout = poll_timeout if poll_timeout is not None else _DEFAULT_POLL_TIMEOUT_S
        self._client = client

    def _resolve_base_url(self, api_base: str | None) -> str:
        if api_base:
            return api_base.rstrip("/")
        spec = find_by_name(self.provider_name)
        if spec and spec.default_api_base:
            return spec.default_api_base.rstrip("/")
        return self._default_base_url()

    def _default_base_url(self) -> str:
        return ""

    @abstractmethod
    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        duration: int | None = None,
    ) -> GeneratedVideoResponse: ...

    async def _http_post(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict[str, Any],
    ) -> httpx.Response:
        if self._client is not None:
            return await self._client.post(url, headers=headers, json=body)
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            return await c.post(url, headers=headers, json=body)


# ---------------------------------------------------------------------------
# Agnes AI video generation (agnes-video-v2.0)
# ---------------------------------------------------------------------------


class AgnesVideoGenerationClient(VideoGenerationProvider):
    """Async client for Agnes AI video generation.

    Flow (per https://agnes-ai.com/zh-Hans/docs/agnes-video-v20):
      1. POST {api_base}/videos  → returns ``video_id`` (status ``queued``)
      2. Poll GET {root}/agnesapi?video_id=<id> until ``status == completed``
      3. Return the ``url`` field (downloadable .mp4)

    ``api_base`` defaults to ``https://apihub.agnes-ai.com/v1``; the polling
    endpoint lives at the domain root (``/agnesapi``), so the ``/v1`` suffix is
    stripped when building the polling URL.
    """

    provider_name = "agnes"
    missing_key_message = (
        "Agnes AI API key is not configured. Set providers.agnes.apiKey."
    )

    def _default_base_url(self) -> str:
        return "https://apihub.agnes-ai.com/v1"

    def _poll_base_url(self) -> str:
        """Root base for the /agnesapi polling endpoint (without /v1)."""
        base = self.api_base or self._default_base_url()
        if base.endswith("/v1"):
            base = base[:-3]
        return base.rstrip("/")

    def _resolve_dimensions(self, aspect_ratio: str | None) -> tuple[int, int]:
        if aspect_ratio and aspect_ratio in _AGNES_ASPECT_RATIO_SIZES:
            return _AGNES_ASPECT_RATIO_SIZES[aspect_ratio]
        return _AGNES_ASPECT_RATIO_SIZES["16:9"]

    def _resolve_frames(self, duration: int | None) -> tuple[int, int]:
        if duration and duration in _AGNES_DURATION_PRESETS:
            return _AGNES_DURATION_PRESETS[duration]
        return _AGNES_DURATION_PRESETS[5]

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        duration: int | None = None,
    ) -> GeneratedVideoResponse:
        if not self.api_key:
            raise VideoGenerationError(self.missing_key_message)

        width, height = self._resolve_dimensions(aspect_ratio)
        num_frames, frame_rate = self._resolve_frames(duration)

        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "width": width,
            "height": height,
            "num_frames": num_frames,
            "frame_rate": frame_rate,
        }

        # Image-to-video: Agnes accepts a single image URL.  Local reference
        # images cannot be uploaded inline (no documented upload endpoint), so
        # only HTTP(S) URLs are forwarded.
        refs = list(reference_images or [])
        if refs:
            image_url = refs[0]
            if isinstance(image_url, str) and image_url.startswith(("http://", "https://")):
                body["image"] = image_url
            else:
                logger.warning(
                    "Agnes video generation only supports reference image URLs; "
                    "ignoring {} local reference image(s)",
                    len(refs),
                )

        body.update(self.extra_body)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.extra_headers,
        }

        create_url = f"{self.api_base}/videos"
        logger.info("Agnes video creation request: POST {} body={}", create_url, body)
        response = await self._http_post(create_url, headers=headers, body=body)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = response.text[:1000]
            logger.error("Agnes video creation failed (HTTP {}): {}", response.status_code, detail)
            raise VideoGenerationError(
                f"Agnes video creation failed (HTTP {response.status_code}): {detail}"
            ) from exc

        payload = response.json()
        video_id = payload.get("video_id") or payload.get("task_id") or payload.get("id")
        if not video_id:
            raise VideoGenerationError(
                f"Agnes video creation returned no task id: {payload}"
            )

        logger.info("Agnes video task created: video_id={} status={}", video_id, payload.get("status"))
        return await self._poll_until_complete(video_id, headers)

    async def _poll_until_complete(
        self,
        video_id: str,
        headers: dict[str, str],
    ) -> GeneratedVideoResponse:
        poll_headers = {"Authorization": headers.get("Authorization", ""), **self.extra_headers}
        poll_url = f"{self._poll_base_url()}/agnesapi"
        loop = asyncio.get_event_loop()
        deadline = loop.time() + self.poll_timeout
        last_progress = -1
        last_status = ""

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            while True:
                if loop.time() >= deadline:
                    raise VideoGenerationError(
                        f"Agnes video generation timed out after {int(self.poll_timeout)}s "
                        f"(video_id={video_id}, last status={last_status or 'unknown'})"
                    )
                await asyncio.sleep(self.poll_interval)
                try:
                    response = await client.get(
                        poll_url, params={"video_id": video_id}, headers=poll_headers
                    )
                except httpx.RequestError as exc:
                    logger.warning("Agnes video poll request failed (will retry): {}", exc)
                    continue

                if response.status_code == 404:
                    raise VideoGenerationError(f"Agnes video task not found: {video_id}")
                if response.status_code >= 500:
                    logger.warning(
                        "Agnes video poll returned HTTP {} (will retry)", response.status_code
                    )
                    continue
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    detail = response.text[:500]
                    raise VideoGenerationError(
                        f"Agnes video poll failed (HTTP {response.status_code}): {detail}"
                    ) from exc

                data = response.json()
                status = str(data.get("status", "")).lower()
                progress = int(data.get("progress", 0) or 0)
                last_status = status
                if progress != last_progress or status != last_status:
                    logger.info("Agnes video {} progress: {}% status={}", video_id, progress, status)
                    last_progress = progress

                if status == "completed":
                    url = data.get("url")
                    if not isinstance(url, str) or not url:
                        raise VideoGenerationError(
                            f"Agnes video completed but no url returned: {data}"
                        )
                    return GeneratedVideoResponse(
                        video_url=url,
                        content="",
                        raw=data,
                        status=status,
                        progress=progress,
                        seconds=data.get("seconds"),
                        size=data.get("size"),
                    )
                if status == "failed":
                    err = data.get("error")
                    msg = (
                        err if isinstance(err, str)
                        else (err.get("message") if isinstance(err, dict) else "")
                        or "unknown error"
                    )
                    raise VideoGenerationError(f"Agnes video generation failed: {msg}")
        finally:
            if owns_client:
                await client.aclose()


async def download_video_bytes(url: str, *, timeout: float = 300.0) -> bytes:
    """Download a generated video from a URL and return its raw bytes."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = response.text[:500]
            raise VideoGenerationError(f"failed to download generated video: {detail}") from exc
        return response.content


# ---------------------------------------------------------------------------
# Provider registration
# ---------------------------------------------------------------------------

register_video_gen_provider(AgnesVideoGenerationClient)
