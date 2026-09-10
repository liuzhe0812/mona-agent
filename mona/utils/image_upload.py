"""Upload local images to Mona's auth server to obtain an HTTP URL.

This mirrors the Tauri ``upload_image`` command (``src-tauri/src/license.rs``) so
that the agent backend can convert local media paths / data URLs into public
URLs required by providers that only accept remote references (e.g. Agnes
image-to-video). Target host is the fixed Mona auth server — not user input —
so SSRF validation against ``mona-ai.cn`` is unnecessary here, matching the
Rust implementation.
"""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

# Must stay in sync with ``src-tauri/src/license.rs::AUTH_SERVER_URL_PRIMARY``
# and ``AUTH_SERVER_URL_FALLBACK``.
_AUTH_SERVER_URL_PRIMARY = "https://mona-ai.cn"
_AUTH_SERVER_URL_FALLBACK = "https://www.mona-ai.cn"
_UPLOAD_ENDPOINT = "/upload/image"
_DEFAULT_TIMEOUT_S = 60.0

# Allow uploads only from Mona's own media directory to prevent the LLM from
# exfiltrating arbitrary user files (e.g. /etc/passwd, ~/.ssh/id_rsa) by
# passing them as reference_images. Resolved lazily to avoid running config
# loader at import time.
_ALLOWED_MEDIA_ROOT: Path | None = None


def _allowed_media_root() -> Path:
    global _ALLOWED_MEDIA_ROOT
    if _ALLOWED_MEDIA_ROOT is None:
        from mona.config.paths import get_data_dir

        _ALLOWED_MEDIA_ROOT = get_data_dir() / "media"
    return _ALLOWED_MEDIA_ROOT


def _is_under_allowed_root(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError):
        return False
    try:
        resolved.relative_to(_allowed_media_root())
        return True
    except ValueError:
        return False


def _guess_mime(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
    }.get(ext, mimetypes.guess_type(path.name)[0] or "application/octet-stream")


class ImageUploadError(RuntimeError):
    """Raised when an image cannot be uploaded to the Mona auth server."""


async def upload_image_to_mona(source: str) -> str:
    """Upload a local file path or ``data:`` URL and return a public URL.

    ``source`` may be:
      * an absolute path under ``~/.mona/media/`` or ``~/.mona/generated/``
      * a ``data:<mime>;base64,...`` URL

    HTTP(S) URLs are returned unchanged so callers can pass any reference image
    through this normalizer.
    """
    if not isinstance(source, str) or not source.strip():
        raise ImageUploadError("empty image source")

    if source.startswith(("http://", "https://")):
        return source

    if source.startswith("data:"):
        return await _upload_data_url(source)

    path = Path(source).expanduser()
    if not path.is_file():
        raise ImageUploadError(f"image file not found: {source}")
    if not _is_under_allowed_root(path):
        raise ImageUploadError(
            "refusing to upload image outside Mona media directories"
        )
    return await _upload_file(path)


async def _upload_file(path: Path) -> str:
    raw = path.read_bytes()
    mime = _guess_mime(path)
    filename = path.name or "upload.bin"
    return await _post_multipart(raw, mime, filename)


async def _upload_data_url(data_url: str) -> str:
    # Accept ``data:<mime>;base64,<payload>`` (the only form the rest of Mona
    # produces). Reject ``data:<mime>,<text>`` plain form to avoid surprises.
    try:
        header, b64_payload = data_url.split(",", 1)
    except ValueError as exc:
        raise ImageUploadError("malformed data URL") from exc
    if not header.startswith("data:") or ";base64" not in header:
        raise ImageUploadError("only base64 data URLs are supported")
    mime = header[len("data:") :].split(";")[0] or "application/octet-stream"
    try:
        raw = base64.b64decode(b64_payload)
    except (ValueError, base64.binascii.Error) as exc:
        raise ImageUploadError("invalid base64 payload") from exc
    ext = mimetypes.guess_extension(mime) or ".bin"
    filename = f"upload{ext}"
    return await _post_multipart(raw, mime, filename)


async def _post_multipart(raw: bytes, mime: str, filename: str) -> str:
    files = {"file": (filename, raw, mime)}
    resp: httpx.Response | None = None
    last_exc: httpx.HTTPError | None = None
    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_S) as client:
        for base in (_AUTH_SERVER_URL_PRIMARY, _AUTH_SERVER_URL_FALLBACK):
            url = f"{base}{_UPLOAD_ENDPOINT}"
            logger.info("Uploading image to {} ({} bytes, {})", url, len(raw), mime)
            try:
                resp = await client.post(url, files=files)
                break
            except httpx.HTTPError as exc:
                last_exc = exc
                continue
    if resp is None:
        raise ImageUploadError(f"upload request failed: {last_exc}") from last_exc

    if resp.status_code >= 400:
        raise ImageUploadError(
            f"upload server returned HTTP {resp.status_code}: {resp.text[:300]}"
        )

    try:
        payload: Any = resp.json()
    except ValueError as exc:
        raise ImageUploadError(f"upload server returned non-JSON: {resp.text[:300]}") from exc

    url_value = payload.get("url") if isinstance(payload, dict) else None
    if not isinstance(url_value, str) or not url_value.strip():
        raise ImageUploadError(f"upload server response missing 'url': {payload}")
    logger.info("Image uploaded: {}", url_value)
    return url_value
