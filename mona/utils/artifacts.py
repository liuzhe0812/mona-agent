"""Artifact persistence helpers for generated media."""

from __future__ import annotations

import base64
import binascii
import json
import re
import uuid
from datetime import datetime
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any

from mona.config.paths import get_media_dir
from mona.utils.helpers import detect_image_mime, ensure_dir

_DATA_IMAGE_RE = re.compile(r"^data:(image/[A-Za-z0-9.+-]+);base64,(.*)$", re.DOTALL)
_MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

class ArtifactError(ValueError):
    """Raised when an artifact cannot be safely decoded or stored."""


_SLUG_DROP_RE = re.compile("[^0-9a-z\\u3400-\\u9fff]+")
_SLUG_DASH_RE = re.compile(r"-{2,}")


def _prompt_slug(prompt: str, max_len: int = 20) -> str:
    """Derive a filesystem-safe, human-readable slug from a prompt.

    Keeps lowercase alphanumerics and CJK characters; collapses everything
    else into single dashes. Empty result means no usable slug.
    """
    slug = _SLUG_DROP_RE.sub("-", prompt.lower())
    slug = _SLUG_DASH_RE.sub("-", slug).strip("-")
    return slug[:max_len].strip("-")


def _artifact_stem(prefix: str, prompt: str, unique: str) -> str:
    """Build the file stem: ``img_<slug>_<hash12>`` or plain ``img_<hash12>``."""
    slug = _prompt_slug(prompt)
    if slug:
        return f"{prefix}_{slug}_{unique}"
    return f"{prefix}_{unique}"


def decode_image_data_url(data_url: str) -> tuple[bytes, str]:
    """Decode a base64 image data URL and return ``(bytes, mime)``."""
    match = _DATA_IMAGE_RE.match(data_url.strip())
    if match is None:
        raise ArtifactError("expected a base64 image data URL")

    declared_mime, encoded = match.groups()
    try:
        raw = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise ArtifactError("invalid base64 image payload") from exc

    detected_mime = detect_image_mime(raw)
    if detected_mime is None:
        raise ArtifactError("unsupported or unrecognized image data")
    if declared_mime != detected_mime:
        declared_mime = detected_mime
    return raw, declared_mime


def _safe_relative_dir(save_dir: str) -> Path:
    normalized = save_dir.replace("\\", "/").strip("/")
    if not normalized:
        raise ArtifactError("save_dir must not be empty")
    rel = PurePosixPath(normalized)
    if rel.is_absolute() or any(part in {"", ".", ".."} for part in rel.parts):
        raise ArtifactError("save_dir must be a safe relative path")
    return Path(*rel.parts)


def _artifact_root(save_dir: str, artifact_root: Path | None = None) -> Path:
    """Resolve the directory that holds generated artifacts.

    When ``artifact_root`` is provided (e.g. the active session workspace),
    artifacts are stored under ``<artifact_root>/<save_dir>/...`` instead of
    the global media directory. This keeps generated user files inside the
    shared output workspace so they appear in the right-side artifact panel.
    The media root remains the fallback for callers that have not been
    migrated to the dynamic workspace routing.
    """
    safe_rel = _safe_relative_dir(save_dir)
    if artifact_root is not None:
        base = Path(artifact_root).expanduser().resolve()
        root = (base / safe_rel).resolve()
        try:
            root.relative_to(base)
        except ValueError as exc:
            raise ArtifactError("artifact directory escapes workspace root") from exc
        return root
    media_root = get_media_dir().resolve()
    root = (media_root / safe_rel).resolve()
    try:
        root.relative_to(media_root)
    except ValueError as exc:
        raise ArtifactError("artifact directory escapes media root") from exc
    return root


def store_generated_image_artifact(
    data_url: str,
    *,
    prompt: str,
    model: str,
    source_images: list[str] | None = None,
    save_dir: str = "generated",
    provider: str = "openrouter",
    created_at: datetime | None = None,
    artifact_root: Path | None = None,
    requested_size: str | None = None,
    requested_aspect_ratio: str | None = None,
) -> dict[str, Any]:
    """Persist a generated image and sidecar metadata.

    When ``artifact_root`` is provided, the image and its sidecar JSON are
    written under ``<artifact_root>/<save_dir>/YYYY-MM-DD/``; otherwise they
    fall back to the global media directory.
    """
    raw, mime = decode_image_data_url(data_url)
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(BytesIO(raw)) as image:
            width, height = image.size
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ArtifactError("generated image dimensions could not be read") from exc
    ext = _MIME_EXTENSIONS.get(mime)
    if ext is None:
        raise ArtifactError(f"unsupported image MIME type: {mime}")

    now = created_at or datetime.now().astimezone()
    day_dir = ensure_dir(_artifact_root(save_dir, artifact_root) / now.strftime("%Y-%m-%d"))
    artifact_id = _artifact_stem("img", prompt, uuid.uuid4().hex[:12])
    image_path = day_dir / f"{artifact_id}{ext}"
    metadata_path = day_dir / f"{artifact_id}.json"

    image_path.write_bytes(raw)
    metadata: dict[str, Any] = {
        "id": artifact_id,
        "path": str(image_path),
        "mime": mime,
        "prompt": prompt,
        "model": model,
        "provider": provider,
        "source_images": list(source_images or []),
        "created_at": now.isoformat(),
        "width": width,
        "height": height,
        "actual_size": f"{width}x{height}",
        "requested_size": requested_size,
        "requested_aspect_ratio": requested_aspect_ratio,
    }
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return metadata


def generated_image_tool_result(artifacts: list[dict[str, Any]]) -> str:
    """Return the compact structured result exposed to the LLM."""
    return json.dumps(
        {
            "ok": True,
            "artifacts": artifacts,
            "next_step": (
                "Generated images are automatically delivered as chat previews and "
                "session artifacts. Generation succeeded: use these images as returned. "
                "Do not compare their dimensions with the requested size, regenerate, crop, "
                "or upscale to correct the provider's output. Actual dimensions are informational. "
                "Only edit or generate again if the user requests it. Keep raw paths internal "
                "unless the user asks for them."
            ),
        },
        ensure_ascii=False,
    )


# ---------------------------------------------------------------------------
# Video artifacts
# ---------------------------------------------------------------------------

_VIDEO_MIME_EXTENSIONS = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}


def store_generated_video_artifact(
    raw: bytes,
    *,
    prompt: str,
    model: str,
    provider: str,
    video_url: str = "",
    source_images: list[str] | None = None,
    save_dir: str = "generated",
    mime: str = "video/mp4",
    duration: str | None = None,
    size: str | None = None,
    created_at: datetime | None = None,
    artifact_root: Path | None = None,
) -> dict[str, Any]:
    """Persist a generated video and sidecar metadata.

    When ``artifact_root`` is provided, the video and its sidecar JSON are
    written under ``<artifact_root>/<save_dir>/YYYY-MM-DD/``; otherwise they
    fall back to the global media directory.
    """
    ext = _VIDEO_MIME_EXTENSIONS.get(mime, ".mp4")

    now = created_at or datetime.now().astimezone()
    day_dir = ensure_dir(_artifact_root(save_dir, artifact_root) / now.strftime("%Y-%m-%d"))
    artifact_id = _artifact_stem("vid", prompt, uuid.uuid4().hex[:12])
    video_path = day_dir / f"{artifact_id}{ext}"
    metadata_path = day_dir / f"{artifact_id}.json"

    video_path.write_bytes(raw)
    metadata: dict[str, Any] = {
        "id": artifact_id,
        "path": str(video_path),
        "mime": mime,
        "prompt": prompt,
        "model": model,
        "provider": provider,
        "video_url": video_url,
        "source_images": list(source_images or []),
        "duration": duration,
        "size": size,
        "created_at": now.isoformat(),
    }
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return metadata


def generated_video_tool_result(artifacts: list[dict[str, Any]]) -> str:
    """Return the compact structured result exposed to the LLM."""
    return json.dumps(
        {
            "artifacts": artifacts,
            "next_step": (
                "Generated videos are automatically delivered as chat previews and "
                "session artifacts. Keep raw paths internal unless the user asks for "
                "debug details."
            ),
        },
        ensure_ascii=False,
    )
