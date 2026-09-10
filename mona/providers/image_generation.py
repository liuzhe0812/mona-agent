"""Image generation provider helpers."""

from __future__ import annotations

import asyncio
import base64
import binascii
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from loguru import logger

from mona.config.schema import ProviderConfig
from mona.providers.mona_managed_media import MonaManagedMediaClient, MonaManagedMediaError
from mona.providers.registry import find_by_name
from mona.utils.helpers import detect_image_mime
from mona.utils.image_upload import ImageUploadError, upload_image_to_mona

_OPENROUTER_ATTRIBUTION_HEADERS = {
    "HTTP-Referer": "https://github.com/HKUDS/mona",
    "X-OpenRouter-Title": "mona",
    "X-OpenRouter-Categories": "cli-agent,personal-agent",
}
_DEFAULT_TIMEOUT_S = 120.0
_TASK_POLL_INTERVAL_S = 2.0
_ASYNC_TASK_TIMEOUT_S = 240.0
_AIHUBMIX_TIMEOUT_S = 300.0
_AIHUBMIX_ASPECT_RATIO_SIZES = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "9:16": "1024x1536",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
}
_GEMINI_DEFAULT_TIMEOUT_S = 120.0
_GEMINI_IMAGEN_ASPECT_RATIOS = {"1:1", "9:16", "16:9", "3:4", "4:3"}


class ImageGenerationError(RuntimeError):
    """Raised when the image generation provider cannot return images.

    ``code`` and ``supported_sizes`` let the agent recover from a provider
    rejecting an output size without having to parse a human-readable error.
    ``retry_safe`` describes whether the same request can safely be submitted
    again.  Generation requests that time out or lose transport connectivity
    leave that status unknown and are therefore never marked safe.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        supported_sizes: list[str] | None = None,
        retry_safe: bool = False,
        task_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.supported_sizes = list(supported_sizes or [])
        self.retry_safe = retry_safe
        self.task_id = task_id


def _merge_extra_body(
    body: dict[str, Any],
    extra_body: dict[str, Any],
    *,
    protected: set[str] = frozenset(),
) -> None:
    """Merge provider preconfiguration without replacing request fields.

    ``extra_body`` is intentionally useful when a self-hosted service needs
    fields that Mona does not know about.  Fields that are part of the current
    request (especially model, prompt, and dimensions) must remain authoritative.
    Nested dictionaries are merged so a configured ``generationConfig`` or
    ``image_config`` can retain unrelated fields while the request overrides
    the fields it actually selected.
    """
    for key, value in extra_body.items():
        if key in protected:
            continue
        current = body.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged = dict(value)
            merged.update(current)
            body[key] = merged
        elif key not in body:
            body[key] = value


def _request_error(
    label: str,
    exc: Exception,
    *,
    task_id: str | None = None,
) -> ImageGenerationError:
    """Create a non-retryable error for an uncertain network outcome."""
    if task_id:
        message = (
            f"{label} image task request failed (task_id={task_id}); "
            "the generation result is unknown, so do not submit the request again automatically"
        )
    else:
        message = (
            f"{label} image generation request failed; cannot confirm whether the request "
            "was submitted, so it is unsafe to retry automatically"
        )
    if str(exc):
        message = f"{message}: {exc}"
    return ImageGenerationError(
        message,
        code="IMAGE_GENERATION_UNCERTAIN",
        retry_safe=False,
        task_id=task_id,
    )


def _response_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except (TypeError, ValueError):
        return None


def _structured_error_values(payload: Any, key: str) -> list[str]:
    """Read an explicitly structured error list without parsing free text."""
    if isinstance(payload, dict):
        value = payload.get(key)
        if isinstance(value, list):
            result: list[str] = []
            for item in value:
                if isinstance(item, str) and item.strip() and item.strip() not in result:
                    result.append(item.strip())
            return result
        for child_key in ("error", "details", "metadata", "data"):
            child = payload.get(child_key)
            values = _structured_error_values(child, key)
            if values:
                return values
    elif isinstance(payload, list):
        for child in payload:
            values = _structured_error_values(child, key)
            if values:
                return values
    return []


def _structured_error_code(payload: Any) -> str:
    if isinstance(payload, dict):
        for key in ("code", "type", "reason", "category"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
        for child_key in ("error", "details", "metadata", "data"):
            value = _structured_error_code(payload.get(child_key))
            if value:
                return value
    elif isinstance(payload, list):
        for child in payload:
            value = _structured_error_code(child)
            if value:
                return value
    return ""


def _is_auth_or_quota_error(payload: Any) -> bool:
    code = _structured_error_code(payload)
    if not code:
        return False
    return any(
        marker in code
        for marker in (
            "auth",
            "api_key",
            "apikey",
            "permission",
            "credential",
            "quota",
            "billing",
            "credit",
            "rate_limit",
            "ratelimit",
        )
    )


def _http_image_generation_error(
    response: httpx.Response,
    *,
    label: str,
) -> ImageGenerationError:
    """Turn an HTTP error into a structured provider error."""
    payload = _response_json(response)
    if response.status_code in (400, 422) and not _is_auth_or_quota_error(payload):
        supported_sizes = _structured_error_values(payload, "supported_sizes")
        if not supported_sizes:
            supported_sizes = _structured_error_values(payload, "allowed_sizes")
        if supported_sizes:
            return ImageGenerationError(
                f"{label} rejected the requested image size; supported sizes: "
                + ", ".join(supported_sizes),
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=supported_sizes,
                retry_safe=True,
            )
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        if isinstance(error, dict) and error.get("param") in {"size", "image_size", "aspect_ratio", "resolution", "width", "height"}:
            return ImageGenerationError(
                f"{label} rejected the requested image output (HTTP {response.status_code}): {_http_error_detail(response)}",
                code="UNSUPPORTED_IMAGE_SIZE",
                retry_safe=True,
            )
    detail = _http_error_detail(response)
    if response.status_code in (401, 403):
        code = "IMAGE_AUTHENTICATION_FAILED"
    elif response.status_code == 402:
        code = "IMAGE_QUOTA_EXCEEDED"
    elif response.status_code == 429:
        code = "IMAGE_RATE_LIMITED"
    elif response.status_code >= 500:
        code = "IMAGE_PROVIDER_UNAVAILABLE"
    else:
        code = "IMAGE_GENERATION_FAILED"
    return ImageGenerationError(
        f"{label} image generation failed (HTTP {response.status_code}): {detail}",
        code=code,
    )


def _parse_image_dimensions(value: str) -> tuple[int, int] | None:
    normalized = value.strip().replace("×", "x").replace("X", "x")
    width, separator, height = normalized.partition("x")
    if not separator or not width.isdecimal() or not height.isdecimal():
        return None
    width_value, height_value = int(width), int(height)
    if width_value <= 0 or height_value <= 0:
        return None
    return width_value, height_value


@dataclass(frozen=True)
class GeneratedImageResponse:
    """Images and optional text returned by the provider."""

    images: list[str]
    content: str
    raw: dict[str, Any]


def _read_image_b64(path: str | Path) -> tuple[str, str]:
    """Return ``(mime, base64)`` for the image at ``path``."""
    p = Path(path).expanduser()
    raw = p.read_bytes()
    mime = detect_image_mime(raw)
    if mime is None:
        raise ImageGenerationError(f"unsupported reference image: {p}")
    return mime, base64.b64encode(raw).decode("ascii")


def image_path_to_data_url(path: str | Path) -> str:
    """Convert a local image path to an image data URL."""
    mime, encoded = _read_image_b64(path)
    return f"data:{mime};base64,{encoded}"


def image_path_to_inline_data(path: str | Path) -> dict[str, str]:
    """Convert a local image path to a Gemini ``inlineData`` payload dict."""
    mime, encoded = _read_image_b64(path)
    return {"mimeType": mime, "data": encoded}


def _b64_image_data_url(value: str) -> str:
    encoded = "".join(value.split())
    try:
        raw = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise ImageGenerationError("generated image payload was not valid base64") from exc
    mime = detect_image_mime(raw)
    if mime is None:
        raise ImageGenerationError("generated image payload was not a supported image")
    return f"data:{mime};base64,{encoded}"


def _aihubmix_size(aspect_ratio: str | None, image_size: str | None) -> str | None:
    """Return an OpenAI Images API size string for AIHubMix.

    AIHubMix's Images API expects OpenAI-style dimensions.  A requested
    concrete size is passed through unchanged; an aspect ratio uses the
    existing known orientation mapping.  With neither value supplied, the
    service chooses its own default.
    """
    if image_size:
        if image_size.strip().lower() == "auto":
            return "auto"
        tier = image_size.strip().upper()
        if tier == "1K":
            ratio = aspect_ratio or "1:1"
            if ratio in _AIHUBMIX_ASPECT_RATIO_SIZES:
                return _AIHUBMIX_ASPECT_RATIO_SIZES[ratio]
            raise ImageGenerationError(
                f"AIHubMix does not support aspect ratio '{ratio}'",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(_AIHUBMIX_ASPECT_RATIO_SIZES.values())),
                retry_safe=True,
            )
        if _parse_image_dimensions(image_size) is None:
            raise ImageGenerationError(
                f"AIHubMix does not support image size '{image_size}'; "
                "use a concrete WIDTHxHEIGHT size or the provider default 1K",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(_AIHUBMIX_ASPECT_RATIO_SIZES.values())),
                retry_safe=True,
            )
        return image_size.strip()
    if aspect_ratio:
        if aspect_ratio not in _AIHUBMIX_ASPECT_RATIO_SIZES:
            raise ImageGenerationError(
                f"AIHubMix does not support aspect ratio '{aspect_ratio}'"
            )
        return _AIHUBMIX_ASPECT_RATIO_SIZES[aspect_ratio]
    return None


def _aihubmix_model_path(model: str) -> str:
    if "/" in model:
        return model
    if model.startswith(("gpt-image-", "dall-e-")):
        return f"openai/{model}"
    return model


async def _download_image_data_url(
    client: httpx.AsyncClient,
    url: str,
) -> str:
    try:
        response = await client.get(url)
    except (httpx.TimeoutException, httpx.RequestError) as exc:
        raise _request_error("Generated image download", exc) from exc
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = response.text[:500]
        raise ImageGenerationError(f"failed to download generated image: {detail}") from exc
    raw = response.content
    mime = detect_image_mime(raw)
    if mime is None:
        raise ImageGenerationError("generated image URL did not return a supported image")
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{encoded}"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_IMAGE_GEN_PROVIDERS: dict[str, type[ImageGenerationProvider]] = {}


def register_image_gen_provider(cls: type[ImageGenerationProvider]) -> None:
    name = cls.provider_name
    if not name:
        raise ValueError(f"{cls.__name__} must set provider_name")
    _IMAGE_GEN_PROVIDERS[name] = cls


def get_image_gen_provider(name: str) -> type[ImageGenerationProvider] | None:
    cls = _IMAGE_GEN_PROVIDERS.get(name)
    if cls is not None:
        return cls
    # Fallback: any provider not in the registry uses the OpenAI-compatible
    # Images API client.  This allows providers like siliconflow, volcengine,
    # dashscope, custom, etc. to work for image generation without a dedicated
    # implementation.
    return _IMAGE_GEN_PROVIDERS.get("openai_compat")


def image_gen_provider_names() -> tuple[str, ...]:
    """Return registered image generation provider names in registry order."""
    return tuple(_IMAGE_GEN_PROVIDERS)


def image_gen_provider_configs(config: Any) -> dict[str, Any]:
    providers_cfg = config.providers
    # Start with registered image-gen providers.
    result: dict[str, Any] = {
        name: pc
        for name in _IMAGE_GEN_PROVIDERS
        if (pc := getattr(providers_cfg, name, None)) is not None
    }
    # Also include any other provider that has credentials configured — they
    # will fall back to the OpenAI-compatible image generation client.
    for field_name in providers_cfg.model_fields_set:
        if field_name in result:
            continue
        pc = getattr(providers_cfg, field_name, None)
        if isinstance(pc, ProviderConfig) and (pc.api_key or pc.api_base):
            result[field_name] = pc
    for field_name, pc in getattr(providers_cfg, "cindy", {}).items():
        if isinstance(pc, ProviderConfig):
            result[field_name] = pc
    return result


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------


class ImageGenerationProvider(ABC):
    """Base class for image generation provider clients."""

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
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_key = api_key
        self.api_base = self._resolve_base_url(api_base)
        self.extra_headers = extra_headers or {}
        self.extra_body = extra_body or {}
        self.timeout = timeout if timeout is not None else self.default_timeout
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
        image_size: str | None = None,
    ) -> GeneratedImageResponse: ...

    def _require_images(self, images: list[str], data: dict[str, Any]) -> None:
        if images:
            return
        provider_error = data.get("error") if isinstance(data, dict) else None
        label = self.provider_name
        if provider_error:
            raise ImageGenerationError(f"{label} returned no images: {provider_error}")
        raise ImageGenerationError(f"{label} returned no images for this request")

    async def _http_post(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict[str, Any],
    ) -> httpx.Response:
        try:
            if self._client is not None:
                return await self._client.post(url, headers=headers, json=body)
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                return await c.post(url, headers=headers, json=body)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise _request_error(self.provider_name or "Image", exc) from exc


class OpenRouterImageGenerationClient(ImageGenerationProvider):
    """Small async client for OpenRouter Chat Completions image generation."""

    provider_name = "openrouter"
    missing_key_message = (
        "OpenRouter API key is not configured. Set providers.openrouter.apiKey."
    )

    def _default_base_url(self) -> str:
        return "https://openrouter.ai/api/v1"

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)

        content: str | list[dict[str, Any]]
        references = list(reference_images or [])
        if references:
            blocks: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            blocks.extend(
                {"type": "image_url", "image_url": {"url": image_path_to_data_url(path)}}
                for path in references
            )
            content = blocks
        else:
            content = prompt

        body: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "modalities": ["image", "text"],
            "stream": False,
        }
        image_config: dict[str, str] = {}
        if aspect_ratio:
            image_config["aspect_ratio"] = aspect_ratio
        if image_size:
            image_config["image_size"] = image_size
        if image_config:
            body["image_config"] = image_config
        _merge_extra_body(body, self.extra_body, protected={"model", "prompt", "messages"})
        if image_config:
            configured = body.get("image_config")
            merged_config = (
                {
                    key: value
                    for key, value in configured.items()
                    if key not in {"size", "resolution", "width", "height", "aspect_ratio", "image_size"}
                }
                if isinstance(configured, dict)
                else {}
            )
            merged_config.update(image_config)
            body["image_config"] = merged_config

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **_OPENROUTER_ATTRIBUTION_HEADERS,
            **self.extra_headers,
        }
        url = f"{self.api_base}/chat/completions"
        response = await self._http_post(url, headers=headers, body=body)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _http_image_generation_error(response, label="OpenRouter") from exc

        data = response.json()
        images: list[str] = []
        text_parts: list[str] = []
        for choice in data.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message") or {}
            if isinstance(message.get("content"), str):
                text_parts.append(message["content"])
            for image in message.get("images") or []:
                if not isinstance(image, dict):
                    continue
                image_url = image.get("image_url") or image.get("imageUrl") or {}
                url_value = image_url.get("url") if isinstance(image_url, dict) else None
                if isinstance(url_value, str) and url_value.startswith("data:image/"):
                    images.append(url_value)

        self._require_images(images, data)

        return GeneratedImageResponse(
            images=images,
            content="\n".join(part for part in text_parts if part).strip(),
            raw=data,
        )

class AIHubMixImageGenerationClient(ImageGenerationProvider):
    """Small async client for AIHubMix unified image generation."""

    provider_name = "aihubmix"
    missing_key_message = (
        "AIHubMix API key is not configured. Set providers.aihubmix.apiKey."
    )
    default_timeout = _AIHUBMIX_TIMEOUT_S

    def _default_base_url(self) -> str:
        return "https://aihubmix.com/v1"

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)

        refs = list(reference_images or [])
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            **self.extra_headers,
        }
        size = _aihubmix_size(aspect_ratio, image_size)

        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            return await self._generate_with_client(
                client,
                prompt=prompt,
                model=model,
                reference_images=refs,
                size=size,
                headers=headers,
            )
        finally:
            if self._client is None:
                await client.aclose()

    async def _generate_with_client(
        self,
        client: httpx.AsyncClient,
        *,
        prompt: str,
        model: str,
        reference_images: list[str],
        size: str | None,
        headers: dict[str, str],
    ) -> GeneratedImageResponse:
        image_input: str | list[str] | None = None
        if reference_images:
            image_refs = [image_path_to_data_url(path) for path in reference_images]
            image_input = image_refs[0] if len(image_refs) == 1 else image_refs

        input_body: dict[str, Any] = {
            "prompt": prompt,
            "n": 1,
        }
        _merge_extra_body(input_body, self.extra_body, protected={"model", "prompt"})
        if image_input is not None:
            input_body["image"] = image_input
        if size is not None:
            for key in ("size", "resolution", "width", "height", "aspect_ratio", "image_config"):
                input_body.pop(key, None)
            input_body["size"] = size

        body = {"input": input_body}
        model_path = _aihubmix_model_path(model)
        url = f"{self.api_base}/models/{model_path}/predictions"
        try:
            response = await client.post(
                url,
                headers={**headers, "Content-Type": "application/json"},
                json=body,
            )
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise _request_error("AIHubMix", exc) from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _http_image_generation_error(response, label="AIHubMix") from exc

        payload = response.json()
        images = await _aihubmix_images_from_payload(client, payload)

        self._require_images(images, payload)

        return GeneratedImageResponse(images=images, content="", raw=payload)


def _http_error_detail(response: httpx.Response) -> str:
    """Extract a readable error message from an HTTP error response."""
    try:
        data = response.json()
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                return err.get("message") or str(err)
            if err:
                return str(err)
    except Exception:
        pass
    return response.text[:500] or "<empty response body>"


class GeminiImageGenerationClient(ImageGenerationProvider):
    """Async client for Gemini/Imagen image generation via the Generative Language API."""

    provider_name = "gemini"
    missing_key_message = (
        "Gemini API key is not configured. Set providers.gemini.apiKey."
    )
    default_timeout = _GEMINI_DEFAULT_TIMEOUT_S

    def _default_base_url(self) -> str:
        return "https://generativelanguage.googleapis.com/v1beta"

    def _resolve_base_url(self, api_base: str | None) -> str:
        # The Gemini provider's registry default_api_base is the OpenAI-compat
        # shim (.../v1beta/openai/), which has no image endpoints.
        # Skip the registry lookup and use the native API base directly.
        if api_base:
            return api_base.rstrip("/")
        return self._default_base_url()

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)
        if "imagen" in model.lower():
            if reference_images:
                logger.warning(
                    "Imagen models do not support reference images; "
                    "ignoring {} reference image(s) for {}",
                    len(reference_images),
                    model,
                )
            return await self._generate_imagen(
                prompt=prompt,
                model=model,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
            )
        if (
            (image_size and image_size.strip().upper() != "1K")
            or (aspect_ratio and aspect_ratio != "1:1")
        ):
            raise ImageGenerationError(
                "Gemini Flash image generation does not support explicit output "
                "aspect ratio or image size",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=["1K"],
                retry_safe=True,
            )
        return await self._generate_gemini_flash(
            prompt=prompt, model=model, reference_images=reference_images or []
        )

    async def _generate_imagen(
        self,
        *,
        prompt: str,
        model: str,
        aspect_ratio: str | None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if image_size and image_size.strip().upper() != "1K":
            raise ImageGenerationError(
                "Gemini Imagen does not support this image_size; use the provider default 1K or aspect_ratio",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=["1K"],
                retry_safe=True,
            )
        if aspect_ratio and aspect_ratio not in _GEMINI_IMAGEN_ASPECT_RATIOS:
            raise ImageGenerationError(
                f"Gemini Imagen does not support aspect ratio '{aspect_ratio}'"
            )
        parameters: dict[str, Any] = {"sampleCount": 1}
        if aspect_ratio:
            parameters["aspectRatio"] = aspect_ratio
        body: dict[str, Any] = {
            "instances": [{"prompt": prompt}],
            "parameters": parameters,
        }
        _merge_extra_body(body, self.extra_body, protected={"prompt", "instances", "parameters"})
        configured = body.get("parameters")
        merged_parameters = dict(configured) if isinstance(configured, dict) else {}
        merged_parameters.update(parameters)
        body["parameters"] = merged_parameters

        url = f"{self.api_base}/models/{model}:predict"
        headers = {
            "x-goog-api-key": self.api_key or "",
            "Content-Type": "application/json",
            **self.extra_headers,
        }
        response = await self._http_post(url, headers=headers, body=body)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error = _http_image_generation_error(response, label="Gemini Imagen")
            logger.error("Gemini Imagen generation failed (HTTP {}): {}", response.status_code, error)
            raise error from exc

        data = response.json()
        images: list[str] = []
        for prediction in data.get("predictions") or []:
            if not isinstance(prediction, dict):
                continue
            b64 = prediction.get("bytesBase64Encoded")
            mime = prediction.get("mimeType", "image/png")
            if isinstance(b64, str) and b64:
                images.append(f"data:{mime};base64,{b64}")

        self._require_images(images, data)

        return GeneratedImageResponse(images=images, content="", raw=data)

    async def _generate_gemini_flash(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str],
    ) -> GeneratedImageResponse:
        parts: list[dict[str, Any]] = [
            {"inlineData": image_path_to_inline_data(path)} for path in reference_images
        ]
        parts.append({"text": prompt})

        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
        }
        _merge_extra_body(body, self.extra_body, protected={"prompt", "contents", "generationConfig"})
        configured = body.get("generationConfig")
        generation_config = dict(configured) if isinstance(configured, dict) else {}
        generation_config["responseModalities"] = ["TEXT", "IMAGE"]
        body["generationConfig"] = generation_config

        url = f"{self.api_base}/models/{model}:generateContent"
        headers = {
            "x-goog-api-key": self.api_key or "",
            "Content-Type": "application/json",
            **self.extra_headers,
        }
        response = await self._http_post(url, headers=headers, body=body)

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error = _http_image_generation_error(response, label="Gemini")
            logger.error("Gemini image generation failed (HTTP {}): {}", response.status_code, error)
            raise error from exc

        data = response.json()
        images: list[str] = []
        text_parts: list[str] = []
        for candidate in data.get("candidates") or []:
            if not isinstance(candidate, dict):
                continue
            content = candidate.get("content") or {}
            for part in content.get("parts") or []:
                if not isinstance(part, dict):
                    continue
                if "text" in part:
                    text_parts.append(part["text"])
                inline = part.get("inlineData")
                if isinstance(inline, dict):
                    mime = inline.get("mimeType", "image/png")
                    b64 = inline.get("data", "")
                    if b64:
                        images.append(f"data:{mime};base64,{b64}")

        self._require_images(images, data)

        return GeneratedImageResponse(
            images=images,
            content="\n".join(t for t in text_parts if t).strip(),
            raw=data,
        )


async def _aihubmix_images_from_payload(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
) -> list[str]:
    images: list[str] = []
    candidates: list[Any] = []
    if "data" in payload:
        candidates.append(payload["data"])
    if "output" in payload:
        candidates.append(payload["output"])

    async def collect(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                await collect(item)
            return
        if isinstance(value, str):
            if value.startswith("data:image/"):
                images.append(value)
            elif value.startswith(("http://", "https://")):
                images.append(await _download_image_data_url(client, value))
            return
        if not isinstance(value, dict):
            return

        b64_json = value.get("b64_json")
        if isinstance(b64_json, str) and b64_json:
            images.append(_b64_image_data_url(b64_json))
        elif b64_json is not None:
            await collect(b64_json)

        bytes_base64 = value.get("bytesBase64") or value.get("bytes_base64") or value.get("base64")
        if isinstance(bytes_base64, str) and bytes_base64:
            images.append(_b64_image_data_url(bytes_base64))

        image_url = value.get("image_url") or value.get("imageUrl")
        if isinstance(image_url, dict):
            await collect(image_url.get("url"))
        elif image_url is not None:
            await collect(image_url)

        url_value = value.get("url")
        if url_value is not None:
            await collect(url_value)

        for key in ("images", "image", "output"):
            if key in value:
                await collect(value[key])

    for candidate in candidates:
        await collect(candidate)
    return images


_MINIMAX_TIMEOUT_S = 300.0

_MINIMAX_ASPECT_RATIO_SIZES = {
    "1:1": "1:1",
    "16:9": "16:9",
    "4:3": "4:3",
    "3:2": "3:2",
    "2:3": "2:3",
    "3:4": "3:4",
    "9:16": "9:16",
    "21:9": "21:9",
}


class MiniMaxImageGenerationClient(ImageGenerationProvider):
    """Async client for MiniMax image generation API."""

    provider_name = "minimax"
    missing_key_message = (
        "MiniMax API key is not configured. Set providers.minimax.apiKey."
    )
    default_timeout = _MINIMAX_TIMEOUT_S

    def _default_base_url(self) -> str:
        return "https://api.minimaxi.com/v1"

    def _resolve_aspect_ratio(self, aspect_ratio: str | None) -> str | None:
        if not aspect_ratio:
            return None
        if aspect_ratio in _MINIMAX_ASPECT_RATIO_SIZES:
            return _MINIMAX_ASPECT_RATIO_SIZES[aspect_ratio]
        raise ImageGenerationError(
            f"MiniMax does not support aspect ratio '{aspect_ratio}'"
        )

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)
        if image_size and image_size.strip().upper() != "1K":
            raise ImageGenerationError(
                "MiniMax does not support this image_size; use the provider default 1K or aspect_ratio",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=["1K"],
                retry_safe=True,
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.extra_headers,
        }

        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "response_format": "base64",
        }

        resolved_ratio = self._resolve_aspect_ratio(aspect_ratio)
        _merge_extra_body(body, self.extra_body, protected={"model", "prompt"})
        if resolved_ratio is not None:
            for key in ("size", "resolution", "width", "height", "aspect_ratio", "image_config"):
                body.pop(key, None)
            body["aspect_ratio"] = resolved_ratio

        refs = list(reference_images or [])
        if refs:
            image_refs = [image_path_to_data_url(path) for path in refs]
            body["subject_reference"] = [
                {"type": "character", "image_file": ref} for ref in image_refs
            ]

        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            return await self._generate_with_client(client, body, headers)
        finally:
            if self._client is None:
                await client.aclose()

    async def _generate_with_client(
        self,
        client: httpx.AsyncClient,
        body: dict[str, Any],
        headers: dict[str, str],
    ) -> GeneratedImageResponse:
        url = f"{self.api_base}/image_generation"
        try:
            response = await client.post(url, headers=headers, json=body)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise _request_error("MiniMax", exc) from exc

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _http_image_generation_error(response, label="MiniMax") from exc

        payload = response.json()
        images = _minimax_images_from_payload(payload)

        self._require_images(images, payload)

        return GeneratedImageResponse(images=images, content="", raw=payload)


def _minimax_images_from_payload(payload: dict[str, Any]) -> list[str]:
    """Extract base64 images from MiniMax API response.

    MiniMax returns images in ``data.image_base64`` (list of base64 strings).
    """
    images: list[str] = []
    data = payload.get("data")
    if not isinstance(data, dict):
        return images
    for b64 in data.get("image_base64") or []:
        if isinstance(b64, str) and b64:
            images.append(_b64_image_data_url(b64))
    return images


# ---------------------------------------------------------------------------
# OpenAI image generation
# ---------------------------------------------------------------------------

_OPENAI_DALLE2_SUPPORTED_SIZES = {"256x256", "512x512", "1024x1024"}
_OPENAI_DALLE3_SUPPORTED_SIZES = {"1024x1024", "1792x1024", "1024x1792"}
_OPENAI_GPT_IMAGE_SUPPORTED_SIZES = {
    "1024x1024",
    "1536x1024",
    "1024x1536",
    "auto",
}
_OPENAI_DALLE2_ASPECT_RATIO_SIZES = {
    "1:1": "1024x1024",
    "16:9": "1024x1024",
    "9:16": "1024x1024",
    "3:4": "1024x1024",
    "4:3": "1024x1024",
}
_OPENAI_DALLE3_ASPECT_RATIO_SIZES = {
    "1:1": "1024x1024",
    "16:9": "1792x1024",
    "9:16": "1024x1792",
    "3:4": "1024x1792",
    "4:3": "1792x1024",
}
_OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
}
_AGNES_IMAGE_ASPECT_RATIO_SIZES = {
    "3:4": "768x1024",
}


class OpenAIImageGenerationClient(ImageGenerationProvider):
    """OpenAI Images API using an API key (``providers.openai.apiKey``)."""

    provider_name = "openai"
    missing_key_message = (
        "OpenAI API key is not configured. Set providers.openai.apiKey."
    )

    def _default_base_url(self) -> str:
        return "https://api.openai.com/v1"

    @staticmethod
    def _strip_model_prefix(model: str) -> str:
        """Remove ``openai/`` prefix if present (OpenRouter convention)."""
        if model.startswith("openai/") or model.startswith("openai_codex/"):
            return model.split("/", 1)[1]
        return model

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)

        if reference_images:
            logger.warning(
                "DALL-E models do not support reference images; "
                "ignoring {} reference image(s) for {}",
                len(reference_images),
                model,
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.extra_headers,
        }

        clean_model = self._strip_model_prefix(model)
        body: dict[str, Any] = {
            "model": clean_model,
            "prompt": prompt,
        }
        _merge_extra_body(body, self.extra_body, protected={"model", "prompt"})

        if not _openai_is_gpt_image_model(clean_model):
            body["response_format"] = "b64_json"
            body["n"] = 1

        size = _openai_size(clean_model, aspect_ratio, image_size)
        if size:
            for key in ("size", "resolution", "width", "height", "aspect_ratio", "image_config"):
                body.pop(key, None)
            body["size"] = size

        logger.debug("OpenAI Images API request: POST {}/images/generations", self.api_base)

        response = await self._http_post(
            f"{self.api_base}/images/generations",
            headers=headers,
            body=body,
        )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error = _http_image_generation_error(response, label="OpenAI")
            logger.error("OpenAI Images API error ({}): {}", response.status_code, error)
            raise error from exc

        payload = response.json()
        logger.debug("OpenAI Images API response ({})", response.status_code)

        client = self._client
        owns_client = client is None
        if owns_client:
            client = httpx.AsyncClient(timeout=self.timeout)
        try:
            images = await _openai_images_from_payload(client, payload)
        finally:
            if owns_client:
                await client.aclose()

        self._require_images(images, payload)

        return GeneratedImageResponse(images=images, content="", raw=payload)


# ---------------------------------------------------------------------------
# OpenAI Codex image generation
# ---------------------------------------------------------------------------


def _image_task_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("task_id") or payload.get("image_id")
    if isinstance(value, (str, int)) and str(value):
        return str(value)
    return None


def _image_task_status(payload: dict[str, Any]) -> str:
    value = payload.get("status") or payload.get("state")
    return value.lower() if isinstance(value, str) else ""


def _image_task_error(payload: dict[str, Any]) -> str:
    value = payload.get("error") or payload.get("message")
    if isinstance(value, dict):
        value = value.get("message") or value.get("detail")
    return str(value) if value else "unknown error"


class OpenAICompatImageGenerationClient(ImageGenerationProvider):
    """Generic OpenAI-compatible Images API client.

    Used as the fallback for any provider that doesn't have a dedicated
    ``ImageGenerationProvider`` implementation.  Calls the standard
    ``/images/generations`` endpoint using the provider's configured
    ``api_key`` and ``api_base``.
    """

    provider_name = "openai_compat"
    default_timeout = _ASYNC_TASK_TIMEOUT_S
    missing_key_message = (
        "API key is not configured for this provider. "
        "Set the provider's apiKey in the Providers settings."
    )

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
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

        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": 1,
        }

        references = []
        for value in reference_images or []:
            if value.startswith(("http://", "https://", "data:")):
                references.append(value)
            else:
                references.append(image_path_to_data_url(value))
        if references:
            body["reference_images"] = references

        # Only request b64_json for models known to support it (OpenAI native
        # models).  Third-party gateways like Agnes AI reject this parameter.
        if _model_supports_b64_response(model):
            body["response_format"] = "b64_json"

        _merge_extra_body(body, self.extra_body, protected={"model", "prompt"})
        if image_size or aspect_ratio:
            for key in ("size", "resolution", "width", "height", "aspect_ratio", "image_config"):
                body.pop(key, None)
            if image_size:
                body["size"] = image_size.strip()
            if aspect_ratio:
                body["aspect_ratio"] = aspect_ratio

        logger.debug(
            "OpenAI-compat Images API request: POST {}/images/generations",
            self.api_base,
        )

        response = await self._http_post(
            f"{self.api_base}/images/generations",
            headers=headers,
            body=body,
        )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error = _http_image_generation_error(response, label="Image")
            logger.error(
                "OpenAI-compat Images API error ({}): {}",
                response.status_code,
                error,
            )
            raise error from exc

        payload = response.json()

        client = self._client
        owns_client = client is None
        if owns_client:
            client = httpx.AsyncClient(timeout=self.timeout)
        try:
            images = await _openai_images_from_payload(client, payload)
            if not images:
                task_id = _image_task_id(payload)
                if task_id:
                    images, payload = await self._poll_task_images(
                        client,
                        task_id,
                        headers,
                    )
        finally:
            if owns_client:
                await client.aclose()

        self._require_images(images, payload)

        return GeneratedImageResponse(images=images, content="", raw=payload)

    async def _poll_task_images(
        self,
        client: httpx.AsyncClient,
        task_id: str,
        headers: dict[str, str],
    ) -> tuple[list[str], dict[str, Any]]:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + self.timeout
        task_url = f"{self.api_base}/tasks/{quote(task_id, safe='')}"
        while True:
            if loop.time() >= deadline:
                raise ImageGenerationError(
                    f"Image generation timed out after {int(self.timeout)}s (task_id={task_id}); "
                    "the task may still be running, so do not submit the request again automatically",
                    code="IMAGE_GENERATION_UNCERTAIN",
                    retry_safe=False,
                    task_id=task_id,
                )
            await asyncio.sleep(_TASK_POLL_INTERVAL_S)
            try:
                response = await client.get(task_url, headers=headers)
            except (httpx.TimeoutException, httpx.RequestError) as exc:
                raise _request_error("Image", exc, task_id=task_id) from exc
            if response.status_code == 404:
                raise ImageGenerationError(f"Image task not found: {task_id}")
            if response.status_code >= 500:
                logger.warning("Image task poll returned HTTP {} (will retry)", response.status_code)
                continue
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise _http_image_generation_error(response, label="Image task poll") from exc
            payload = response.json()
            if not isinstance(payload, dict):
                raise ImageGenerationError("Image task returned an invalid response")
            status = _image_task_status(payload)
            if status in {"failed", "error"}:
                raise ImageGenerationError(
                    f"Image generation failed: {_image_task_error(payload)}"
                )
            images = await _openai_images_from_payload(client, payload)
            if images:
                return images, payload
            if status in {"completed", "succeeded", "success"}:
                raise ImageGenerationError("Image task completed but returned no images")


# ---------------------------------------------------------------------------
# OpenAI Codex image generation (original)
# ---------------------------------------------------------------------------


class CodexImageGenerationClient(ImageGenerationProvider):
    """OpenAI image generation via Codex subscription OAuth.

    Uses the Codex Responses API with the ``image_generation`` tool
    (the same mechanism ChatGPT uses internally).  No API key required —
    the Codex OAuth token from ``oauth_cli_kit`` is used instead.
    """

    provider_name = "openai_codex"
    missing_key_message = (
        "Codex OAuth token is unavailable. "
        "Log in with Codex subscription first."
    )

    def _default_base_url(self) -> str:
        return "https://chatgpt.com/backend-api"

    def _codex_model(self, model: str) -> str:
        """Strip the ``openai-codex/`` prefix if present."""
        if model.startswith(("openai-codex/", "openai_codex/")):
            return model.split("/", 1)[1]
        return model

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        try:
            from oauth_cli_kit import get_token as get_codex_token
        except ImportError:
            raise ImageGenerationError(self.missing_key_message)

        try:
            token = await asyncio.to_thread(get_codex_token)
        except Exception as exc:
            raise ImageGenerationError(self.missing_key_message) from exc
        if not token or not token.access:
            raise ImageGenerationError(self.missing_key_message)

        if (
            (image_size and image_size.strip().upper() != "1K")
            or (aspect_ratio and aspect_ratio != "1:1")
        ):
            raise ImageGenerationError(
                "Codex image generation supports only its default 1K 1:1 output",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=["1K"],
                retry_safe=True,
            )

        logger.debug("Using Codex OAuth token for image generation")

        if reference_images:
            logger.warning(
                "Codex image generation does not support reference images; "
                "ignoring {} reference image(s)",
                len(reference_images),
            )

        headers = {
            "Authorization": f"Bearer {token.access}",
            "chatgpt-account-id": token.account_id,
            "OpenAI-Beta": "responses=experimental",
            "originator": "mona",
            "User-Agent": "mona (python)",
            "Content-Type": "application/json",
            **self.extra_headers,
        }

        body: dict[str, Any] = {
            "model": self._codex_model(model),
            "instructions": "Generate an image based on the user's request.",
            "input": [{"role": "user", "content": prompt}],
            "tools": [{"type": "image_generation"}],
            "tool_choice": "auto",
            "stream": True,
            "store": False,
        }
        _merge_extra_body(
            body,
            self.extra_body,
            protected={"model", "instructions", "input", "tools", "tool_choice", "stream", "store"},
        )

        logger.debug("Codex Responses API request: POST {}/codex/responses", self.api_base)

        response = await self._http_post(
            f"{self.api_base}/codex/responses",
            headers=headers,
            body=body,
        )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            error = _http_image_generation_error(response, label="Codex")
            logger.error("Codex Responses API error ({}): {}", response.status_code, error)
            raise error from exc

        try:
            images, content_text = await _parse_codex_sse_images(response)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise _request_error("Codex", exc) from exc

        raw = {"status": "completed"}
        self._require_images(images, raw)

        return GeneratedImageResponse(images=images, content=content_text, raw=raw)


def _model_supports_b64_response(model: str) -> bool:
    """Return True if the model is known to support ``response_format=b64_json``."""
    m = model.lower()
    return any(m.startswith(p) for p in ("dall-e-", "gpt-image-", "o3-", "o4-"))


def _openai_size(
    model: str,
    aspect_ratio: str | None,
    image_size: str | None,
) -> str | None:
    """Resolve aspect ratio or image_size to an OpenAI Images API size string."""
    sizes, supported_sizes = _openai_size_options(model)
    explicit_size = _normalize_openai_image_size(image_size)
    if explicit_size:
        # The built-in 1K default is represented by the existing model/ratio
        # pixel mapping.  Higher tiers are only valid when a provider has an
        # explicit pixel-size contract; never pretend that they were applied.
        if explicit_size == "1k":
            default_ratio = aspect_ratio or "1:1"
            if default_ratio in sizes:
                return sizes[default_ratio]
            raise ImageGenerationError(
                f"OpenAI image model {model} does not support aspect ratio '{default_ratio}'",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(sizes.values())),
                retry_safe=True,
            )
        if not _openai_explicit_size_supported(
            explicit_size,
            supported_sizes=supported_sizes,
        ):
            raise ImageGenerationError(
                f"OpenAI image size '{image_size}' is not supported by {model}; "
                "use one of the supported pixel sizes",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(supported_sizes or sizes.values())),
                retry_safe=True,
            )
        return explicit_size
    if aspect_ratio:
        if aspect_ratio not in sizes:
            raise ImageGenerationError(
                f"OpenAI image model {model} does not support aspect ratio '{aspect_ratio}'"
            )
        return sizes[aspect_ratio]
    return None


def _openai_is_gpt_image_model(model: str) -> bool:
    normalized = model.lower()
    return normalized.startswith(("gpt-image", "chatgpt-image"))


def _openai_size_options(model: str) -> tuple[dict[str, str], set[str] | None]:
    normalized = model.lower()
    if normalized.startswith("agnes-image-"):
        return _AGNES_IMAGE_ASPECT_RATIO_SIZES, None
    if normalized.startswith("dall-e-2"):
        return _OPENAI_DALLE2_ASPECT_RATIO_SIZES, _OPENAI_DALLE2_SUPPORTED_SIZES
    if normalized.startswith("dall-e-3"):
        return _OPENAI_DALLE3_ASPECT_RATIO_SIZES, _OPENAI_DALLE3_SUPPORTED_SIZES
    if normalized.startswith("gpt-image-2"):
        return _OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES, None
    return _OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES, _OPENAI_GPT_IMAGE_SUPPORTED_SIZES


def _normalize_openai_image_size(image_size: str | None) -> str | None:
    if not image_size:
        return None
    normalized = image_size.strip().lower()
    return normalized or None


def _openai_explicit_size_supported(
    size: str,
    *,
    supported_sizes: set[str] | None,
) -> bool:
    if supported_sizes is not None:
        return size in supported_sizes
    if size == "auto":
        return True
    width, sep, height = size.partition("x")
    return bool(sep and width.isdecimal() and height.isdecimal())


async def _openai_images_from_payload(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
) -> list[str]:
    """Extract images from OpenAI Images API response.

    Handles both ``b64_json`` (preferred) and ``url`` (downloaded) formats.
    """
    images: list[str] = []
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if isinstance(b64, str) and b64:
            images.append(_b64_image_data_url(b64))
            continue
        url = item.get("url")
        if isinstance(url, str) and url:
            images.append(await _download_image_data_url(client, url))
    for item in payload.get("files") or []:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if isinstance(url, str) and url:
            images.append(await _download_image_data_url(client, url))
    return images


def _codex_responses_images_from_payload(payload: dict[str, Any]) -> list[str]:
    """Extract images from Codex Responses API ``image_generation_call`` output."""
    images: list[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "image_generation_call":
            continue
        result = item.get("result")
        if isinstance(result, str):
            images.append(result if result.startswith("data:image/") else _b64_image_data_url(result))
            continue
        if isinstance(result, dict):
            image_url = result.get("image_url") or result.get("image") or ""
            if isinstance(image_url, str):
                images.append(image_url if image_url.startswith("data:image/") else _b64_image_data_url(image_url))
    return images


async def _parse_codex_sse_images(
    response: httpx.Response,
) -> tuple[list[str], str]:
    """Parse a Codex Responses API SSE stream for image generation output.

    Returns ``(images, content_text)``.
    """
    import json as _json

    images: list[str] = []
    text_parts: list[str] = []

    buffer: list[str] = []
    async for line_bytes in response.aiter_lines():
        line = line_bytes.strip()
        if line == "":
            if buffer:
                data_lines = []
                for bl in buffer:
                    if bl.startswith("data:"):
                        data_lines.append(bl[5:].strip())
                buffer.clear()
                if data_lines:
                    raw = "".join(data_lines)
                    if raw == "[DONE]":
                        break
                    try:
                        event = _json.loads(raw)
                    except Exception:
                        continue
                    ev_type = event.get("type", "")
                    if ev_type in ("error", "response.failed"):
                        logger.error("Codex SSE failure: {}", raw[:2000])
                    _collect_images_from_sse_event(event, images)
                    _collect_text_from_sse_event(event, text_parts)
            continue
        buffer.append(line)

    # flush remaining
    if buffer:
        data_lines = [bl[5:].strip() for bl in buffer if bl.startswith("data:")]
        raw = "".join(data_lines)
        if raw and raw != "[DONE]":
            try:
                event = _json.loads(raw)
            except Exception:
                pass
            else:
                _collect_images_from_sse_event(event, images)
                _collect_text_from_sse_event(event, text_parts)

    return images, "".join(text_parts).strip()


def _collect_images_from_sse_event(event: dict[str, Any], images: list[str]) -> None:
    if event.get("type") != "response.output_item.done":
        return
    item = event.get("item") or {}
    if item.get("type") != "image_generation_call":
        return
    result = item.get("result")
    if isinstance(result, str):
        if result.startswith("data:image/"):
            images.append(result)
        else:
            images.append(_b64_image_data_url(result))
    elif isinstance(result, dict):
        image_url = result.get("image_url") or result.get("image") or ""
        if isinstance(image_url, str):
            if image_url.startswith("data:image/"):
                images.append(image_url)
            else:
                images.append(_b64_image_data_url(image_url))


def _collect_text_from_sse_event(event: dict[str, Any], text_parts: list[str]) -> None:
    if event.get("type") == "response.output_text.delta":
        delta = event.get("delta")
        if isinstance(delta, str) and delta:
            text_parts.append(delta)


# ---------------------------------------------------------------------------
# StepFun (阶跃星辰) image generation
# ---------------------------------------------------------------------------

_STEPFUN_ASPECT_RATIO_SIZES = {
    "1:1": "1024x1024",
    "16:9": "1280x800",
    "9:16": "800x1280",
    "3:4": "768x1360",
    "4:3": "1360x768",
}


class StepFunImageGenerationClient(ImageGenerationProvider):
    """Async client for StepFun (阶跃星辰) image generation.

    Supports:
    - Text-to-image via step-image-edit-2 (default model)
    - Reference-image-guided generation via style_reference (step-1x-medium)
    """

    provider_name = "stepfun"
    missing_key_message = (
        "StepFun API key is not configured. Set providers.stepfun.apiKey."
    )
    default_timeout = 120.0

    def _default_base_url(self) -> str:
        return "https://api.stepfun.com/v1"

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        if not self.api_key:
            raise ImageGenerationError(self.missing_key_message)

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            **self.extra_headers,
        }

        body: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "response_format": "b64_json",
            "n": 1,
        }

        # Map aspect ratio / image_size to StepFun size string
        size = _stepfun_size(aspect_ratio, image_size)
        _merge_extra_body(body, self.extra_body, protected={"model", "prompt"})

        # step-1x-medium supports style_reference for reference-image-guided generation
        refs = list(reference_images or [])
        if refs and "1x" in model:
            body["style_reference"] = {
                "source_url": image_path_to_data_url(refs[0]),
            }

        if size is not None:
            for key in ("size", "resolution", "width", "height", "aspect_ratio", "image_config"):
                body.pop(key, None)
            body["size"] = size

        response = await self._http_post(
            f"{self.api_base}/images/generations",
            headers=headers,
            body=body,
        )

        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _http_image_generation_error(response, label="StepFun") from exc

        payload = response.json()
        images = _stepfun_images_from_payload(payload)

        self._require_images(images, payload)

        return GeneratedImageResponse(images=images, content="", raw=payload)


def _stepfun_size(
    aspect_ratio: str | None,
    image_size: str | None,
) -> str | None:
    """Resolve aspect ratio / image_size to StepFun size string.

    StepFun expects ``WIDTHxHEIGHT`` (note: width x height, not the more
    common ``HxW`` order used by other providers).  The accepted sizes are
    ``1024x1024``, ``768x1360``, ``896x1184``, ``1360x768``, ``1184x896``.
    """
    if image_size:
        tier = image_size.strip().upper()
        if tier == "1K":
            ratio = aspect_ratio or "1:1"
            if ratio in _STEPFUN_ASPECT_RATIO_SIZES:
                return _STEPFUN_ASPECT_RATIO_SIZES[ratio]
            raise ImageGenerationError(
                f"StepFun does not support aspect ratio '{ratio}'",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(_STEPFUN_ASPECT_RATIO_SIZES.values())),
                retry_safe=True,
            )
        if _parse_image_dimensions(image_size) is None:
            raise ImageGenerationError(
                f"StepFun does not support image size '{image_size}'; "
                "use a concrete WIDTHxHEIGHT size or the provider default 1K",
                code="UNSUPPORTED_IMAGE_SIZE",
                supported_sizes=sorted(set(_STEPFUN_ASPECT_RATIO_SIZES.values())),
                retry_safe=True,
            )
        return image_size.strip()
    if aspect_ratio:
        if aspect_ratio not in _STEPFUN_ASPECT_RATIO_SIZES:
            raise ImageGenerationError(
                f"StepFun does not support aspect ratio '{aspect_ratio}'"
            )
        return _STEPFUN_ASPECT_RATIO_SIZES[aspect_ratio]
    return None


def _stepfun_images_from_payload(payload: dict[str, Any]) -> list[str]:
    """Extract base64 images from StepFun API response.

    StepFun returns images in ``data[].b64_json`` (base64 strings).
    """
    images: list[str] = []
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if isinstance(b64, str) and b64:
            images.append(_b64_image_data_url(b64))
    return images


_MONA_IMAGE_SIZES = {
    "1K": {
        "1:1": "1024*1024",
        "16:9": "1344*768",
        "9:16": "768*1344",
        "4:3": "1152*864",
        "3:4": "864*1152",
    },
    "2K": {
        "1:1": "2048*2048",
        "16:9": "2048*1152",
        "9:16": "1152*2048",
        "4:3": "1792*1344",
        "3:4": "1344*1792",
    },
}


class MonaManagedImageGenerationClient(ImageGenerationProvider):
    provider_name = "mona_managed"
    missing_key_message = "请登录 Mona AI 后再使用托管图片模型"

    @staticmethod
    def _size(aspect_ratio: str | None, image_size: str | None) -> str | None:
        if image_size:
            normalized = image_size.strip().upper().replace("X", "*").replace("×", "*")
            if "*" in normalized:
                dimensions = _parse_image_dimensions(normalized.replace("*", "x"))
                if dimensions is None:
                    raise ImageGenerationError(
                        f"Mona AI does not support image size '{image_size}'"
                    )
                return normalized
            if normalized not in _MONA_IMAGE_SIZES:
                raise ImageGenerationError(
                    f"Mona AI does not support image size '{image_size}'"
                )
            tier = normalized
        else:
            if not aspect_ratio:
                return None
            tier = "1K"
        if aspect_ratio:
            sizes = _MONA_IMAGE_SIZES[tier]
            if aspect_ratio not in sizes:
                raise ImageGenerationError(
                    f"Mona AI does not support aspect ratio '{aspect_ratio}'"
                )
            return sizes[aspect_ratio]
        return _MONA_IMAGE_SIZES[tier]["1:1"]

    async def generate(
        self,
        *,
        prompt: str,
        model: str,
        reference_images: list[str] | None = None,
        aspect_ratio: str | None = None,
        image_size: str | None = None,
    ) -> GeneratedImageResponse:
        try:
            references = [
                await upload_image_to_mona(value)
                for value in list(reference_images or [])[:3]
            ]
            service = MonaManagedMediaClient(client=self._client)
            request_body: dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "input_image_urls": references,
                "n": 1,
                "watermark": False,
            }
            _merge_extra_body(
                request_body,
                self.extra_body,
                protected={"model", "prompt", "input_image_urls"},
            )
            size = self._size(aspect_ratio, image_size)
            if size is not None:
                request_body["size"] = size
            payload = await service.generate(request_body)
            assets = (payload.get("result") or {}).get("assets") or []
            if not assets:
                raise ImageGenerationError("Mona AI 未返回生成图片")
            images: list[str] = []
            for asset in assets:
                asset_url = asset.get("url") if isinstance(asset, dict) else None
                if not isinstance(asset_url, str) or not asset_url:
                    raise ImageGenerationError("Mona AI 图片地址无效")
                raw, _content_type = await service.download_asset(asset_url)
                mime = detect_image_mime(raw)
                if mime is None:
                    raise ImageGenerationError("Mona AI 返回了不支持的图片格式")
                images.append(f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}")
            return GeneratedImageResponse(images=images, content="", raw=payload)
        except (ImageUploadError, MonaManagedMediaError) as exc:
            raise ImageGenerationError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Provider registration
# ---------------------------------------------------------------------------

register_image_gen_provider(AIHubMixImageGenerationClient)
register_image_gen_provider(CodexImageGenerationClient)
register_image_gen_provider(GeminiImageGenerationClient)
register_image_gen_provider(MiniMaxImageGenerationClient)
register_image_gen_provider(MonaManagedImageGenerationClient)
register_image_gen_provider(OpenAICompatImageGenerationClient)
register_image_gen_provider(OpenAIImageGenerationClient)
register_image_gen_provider(OpenRouterImageGenerationClient)
register_image_gen_provider(StepFunImageGenerationClient)
