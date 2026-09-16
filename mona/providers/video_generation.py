"""Video generation provider helpers.

Video generation is asynchronous: a creation request returns a task/video id,
and the client polls a status endpoint until the video is ready, then returns
the downloadable video URL.  This mirrors the pattern used by Agnes AI's
``agnes-video-v2.0`` model (POST /v1/videos → GET /agnesapi?video_id=…).
"""

from __future__ import annotations

import asyncio
import ipaddress
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
from loguru import logger

from mona.providers.mona_managed_media import MonaManagedMediaClient, MonaManagedMediaError
from mona.providers.registry import find_by_name
from mona.security.network import validate_url_target

_DEFAULT_TIMEOUT_S = 60.0
_DEFAULT_POLL_INTERVAL_S = 5.0

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

    def __init__(self, message: str, *, result_url: str | None = None) -> None:
        super().__init__(message)
        self.result_url = result_url


def _origin(value: str) -> tuple[str, str, int | None]:
    parsed = urlparse(value)
    port = parsed.port
    if port is None:
        port = 443 if parsed.scheme.lower() == "https" else 80 if parsed.scheme.lower() == "http" else None
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


def _resolve_provider_video_url(api_base: str, value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme:
        return value
    return urljoin(f"{api_base.rstrip('/')}/", value)


def _is_private_literal_url(value: str) -> bool:
    hostname = urlparse(value).hostname
    if not hostname or hostname.lower() == "localhost":
        return bool(hostname)
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local


def _validate_provider_video_url(url: str, *, api_base: str = "") -> None:
    allow_private = bool(api_base) and _origin(url) == _origin(api_base)
    ok, error = validate_url_target(url, allow_private=allow_private)
    if not ok:
        raise VideoGenerationError(
            f"Video service URL is not allowed: {error}",
            result_url=url,
        )


def _normalize_provider_video_url(api_base: str, value: str) -> str:
    url = _resolve_provider_video_url(api_base, value) if api_base else value
    # Keep public result URLs provider agnostic.  Literal private results must
    # still belong to the configured service origin before they are downloaded.
    if _is_private_literal_url(url):
        _validate_provider_video_url(url, api_base=api_base)
    return url


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
    return _VIDEO_GEN_PROVIDERS.get(name) or _VIDEO_GEN_PROVIDERS.get("openai_compat")


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
    for name, pc in getattr(providers_cfg, "cindy", {}).items():
        result[name] = pc
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
        self.poll_timeout = poll_timeout
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
        first_frame: str | None = None,
        last_frame: str | None = None,
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
        first_frame: str | None = None,
        last_frame: str | None = None,
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
        refs = [first_frame] if first_frame else list(reference_images or [])
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
        deadline = loop.time() + self.poll_timeout if self.poll_timeout is not None else None
        last_progress = -1
        last_status = ""

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            while True:
                if deadline is not None and loop.time() >= deadline:
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
                    url = _normalize_provider_video_url(self.api_base, url)
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


def _video_url_from_payload(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("url", "video_url", "videoUrl"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
        for value in payload.values():
            url = _video_url_from_payload(value)
            if url:
                return url
    elif isinstance(payload, list):
        for value in payload:
            url = _video_url_from_payload(value)
            if url:
                return url
    return None


def _video_task_id_from_payload(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("id", "task_id", "video_id"):
            value = payload.get(key)
            if isinstance(value, (str, int)) and str(value):
                return str(value)
        for value in payload.values():
            task_id = _video_task_id_from_payload(value)
            if task_id:
                return task_id
    elif isinstance(payload, list):
        for value in payload:
            task_id = _video_task_id_from_payload(value)
            if task_id:
                return task_id
    return None


def _video_status_from_payload(payload: dict[str, Any]) -> str:
    for key in ("status", "state"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value.lower()
    for key in ("result", "data"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            status = _video_status_from_payload(nested)
            if status:
                return status
    return ""


def _video_progress_from_payload(payload: dict[str, Any], default: int = 0) -> int:
    value = payload.get("progress")
    if value is None:
        for key in ("result", "data"):
            nested = payload.get(key)
            if isinstance(nested, dict) and nested.get("progress") is not None:
                value = nested["progress"]
                break
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _video_error_message(payload: dict[str, Any]) -> str:
    value = payload.get("error") or payload.get("message")
    if isinstance(value, dict):
        value = value.get("message") or value.get("detail")
    return str(value) if value else "unknown error"


class OpenAICompatVideoGenerationClient(VideoGenerationProvider):
    """Generic video client for an OpenAI-compatible media endpoint."""

    provider_name = "openai_compat"

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        first_frame: str | None = None,
        last_frame: str | None = None,
        aspect_ratio: str | None = None,
        duration: int | None = None,
    ) -> GeneratedVideoResponse:
        body: dict[str, Any] = {"model": model, "prompt": prompt}
        references = list(reference_images or [])
        if references:
            body["reference_images"] = references
        if first_frame:
            body["first_frame"] = first_frame
        if last_frame:
            body["last_frame"] = last_frame
        if aspect_ratio:
            body["aspect_ratio"] = aspect_ratio
        if duration is not None:
            body["duration"] = duration
        body.update(self.extra_body)

        headers = {
            "Content-Type": "application/json",
            **{
                key: value
                for key, value in self.extra_headers.items()
                if key.lower() != "authorization"
            },
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        response = await self._http_post(
            f"{self.api_base}/videos/generations",
            headers=headers,
            body=body,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = response.text[:1000]
            raise VideoGenerationError(
                f"Video generation failed (HTTP {response.status_code}): {detail}"
            ) from exc

        payload = response.json()
        video_url = _video_url_from_payload(payload)
        if video_url:
            status = _video_status_from_payload(payload) or "completed"
            return self._response_from_payload(
                payload,
                video_url,
                status=status,
                default_progress=100,
            )

        task_id = _video_task_id_from_payload(payload)
        if not task_id:
            raise VideoGenerationError("Video generation returned no video URL or task id")
        return await self._poll_until_complete(task_id, headers)

    def _response_from_payload(
        self,
        payload: dict[str, Any],
        video_url: str,
        *,
        status: str,
        default_progress: int,
    ) -> GeneratedVideoResponse:
        video_url = _normalize_provider_video_url(self.api_base, video_url)
        duration = payload.get("seconds") or payload.get("duration")
        size = payload.get("size") or payload.get("resolution")
        return GeneratedVideoResponse(
            video_url=video_url,
            content="",
            raw=payload,
            status=status,
            progress=_video_progress_from_payload(payload, default=default_progress),
            seconds=str(duration) if duration is not None else None,
            size=str(size) if size is not None else None,
        )

    async def _poll_until_complete(
        self,
        task_id: str,
        headers: dict[str, str],
    ) -> GeneratedVideoResponse:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + self.poll_timeout if self.poll_timeout is not None else None
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        poll_url = f"{self.api_base}/tasks/{quote(task_id, safe='')}"
        try:
            while True:
                if deadline is not None and loop.time() >= deadline:
                    raise VideoGenerationError(
                        f"Video generation timed out after {int(self.poll_timeout)}s "
                        f"(task_id={task_id})"
                    )
                await asyncio.sleep(self.poll_interval)
                try:
                    response = await client.get(poll_url, headers=headers)
                except httpx.RequestError as exc:
                    logger.warning("Video poll request failed (will retry): {}", exc)
                    continue
                if response.status_code == 404:
                    raise VideoGenerationError(f"Video task not found: {task_id}")
                if response.status_code >= 500:
                    logger.warning(
                        "Video poll returned HTTP {} (will retry)", response.status_code
                    )
                    continue
                try:
                    response.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    detail = response.text[:500]
                    raise VideoGenerationError(
                        f"Video poll failed (HTTP {response.status_code}): {detail}"
                    ) from exc

                payload = response.json()
                status = _video_status_from_payload(payload)
                if status in {"failed", "error"}:
                    raise VideoGenerationError(
                        f"Video generation failed: {_video_error_message(payload)}"
                    )
                video_url = _video_url_from_payload(payload)
                if status in {"completed", "succeeded", "success"} or (
                    video_url and not status
                ):
                    if not video_url:
                        raise VideoGenerationError(
                            "Video task completed but no video URL was returned"
                        )
                    return self._response_from_payload(
                        payload,
                        video_url,
                        status=status or "completed",
                        default_progress=100,
                    )
        finally:
            if owns_client:
                await client.aclose()


class MonaManagedVideoGenerationClient(VideoGenerationProvider):
    provider_name = "mona_managed"
    missing_key_message = "请登录 Mona AI 后再使用托管视频模型"

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        first_frame: str | None = None,
        last_frame: str | None = None,
        aspect_ratio: str | None = None,
        duration: int | None = None,
    ) -> GeneratedVideoResponse:
        try:
            service = MonaManagedMediaClient(
                poll_interval=self.poll_interval,
                poll_timeout=self.poll_timeout,
                client=self._client,
            )
            payload = await service.generate(
                {
                    "model": model,
                    "prompt": prompt,
                    "input_image_urls": ([first_frame] if first_frame else list(reference_images or []))[:1],
                    "resolution": "720P",
                    "aspect_ratio": aspect_ratio or "16:9",
                    "duration": duration or 5,
                    "watermark": False,
                }
            )
        except MonaManagedMediaError as exc:
            raise VideoGenerationError(str(exc)) from exc
        result = payload.get("result") or {}
        asset = result.get("asset") if isinstance(result, dict) else None
        video_url = asset.get("url") if isinstance(asset, dict) else None
        if not isinstance(video_url, str) or not video_url:
            raise VideoGenerationError("Mona AI 未返回生成视频")
        try:
            video_bytes, content_type = await service.download_asset(video_url)
        except MonaManagedMediaError as exc:
            raise VideoGenerationError(str(exc)) from exc
        if not content_type.startswith(("video/", "application/octet-stream")):
            raise VideoGenerationError("Mona AI 返回了不支持的视频格式")
        usage = payload.get("usage") or {}
        raw_payload = dict(payload)
        raw_payload["_video_bytes"] = video_bytes
        return GeneratedVideoResponse(
            video_url=video_url,
            content="",
            raw=raw_payload,
            status="completed",
            progress=100,
            seconds=str(usage.get("duration")) if usage.get("duration") is not None else None,
            size=f"{usage.get('SR')}P" if usage.get("SR") is not None else None,
        )


async def download_video_bytes(
    url: str,
    *,
    timeout: float = 300.0,
    api_base: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> bytes:
    """Download a generated video while validating every redirect target."""
    current = _resolve_provider_video_url(api_base, url) if api_base else url
    trusted_base = api_base or ""
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=timeout)
    try:
        for _ in range(6):
            _validate_provider_video_url(current, api_base=trusted_base)
            try:
                response = await client.get(current, follow_redirects=False)
            except (httpx.TimeoutException, httpx.RequestError) as exc:
                raise VideoGenerationError(
                    f"failed to download generated video: {exc}",
                    result_url=current,
                ) from exc
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("location")
            if not location:
                raise VideoGenerationError(
                    "generated video redirect did not include a location",
                    result_url=current,
                )
            current = urljoin(current, location)
        else:
            raise VideoGenerationError(
                "generated video download exceeded the redirect limit",
                result_url=current,
            )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = response.text[:500]
            raise VideoGenerationError(
                f"failed to download generated video: {detail}",
                result_url=current,
            ) from exc
        return response.content
    finally:
        if owns_client:
            await client.aclose()


# ---------------------------------------------------------------------------
# Provider registration
# ---------------------------------------------------------------------------

register_video_gen_provider(AgnesVideoGenerationClient)
register_video_gen_provider(MonaManagedVideoGenerationClient)
register_video_gen_provider(OpenAICompatVideoGenerationClient)
