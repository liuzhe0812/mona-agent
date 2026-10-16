"""Verified PNG access for bundled Dashi PowerPoint assets."""

from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, PngImagePlugin, UnidentifiedImageError

ASSET_ROOT = (
    Path(__file__).resolve().parents[1] / "skills" / "mona-pptx" / "assets" / "dashi"
).resolve()
_MANIFEST_NAME = "manifest.json"
_PNG_COLOR_CHUNK_LENGTHS = {"cHRM": 32, "gAMA": 4, "sRGB": 1}


class PptAssetError(ValueError):
    """A bundled PowerPoint image is missing or failed its integrity checks."""


def _resolve_within_root(root: Path, relative_path: str) -> Path:
    if not isinstance(relative_path, str) or not relative_path:
        raise PptAssetError("PPT asset path is invalid")
    try:
        resolved = (root / relative_path).resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise PptAssetError("PPT asset path is outside its fixed resource root") from exc
    return resolved


def _load_registry(root: Path) -> dict[str, dict[str, Any]]:
    manifest_path = _resolve_within_root(root, _MANIFEST_NAME)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PptAssetError("PPT asset manifest is unavailable or invalid") from exc

    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise PptAssetError("PPT asset manifest version is unsupported")
    assets = manifest.get("assets")
    if not isinstance(assets, list):
        raise PptAssetError("PPT asset manifest entries are invalid")

    registry: dict[str, dict[str, Any]] = {}
    for entry in assets:
        if not isinstance(entry, dict):
            raise PptAssetError("PPT asset manifest entry is invalid")
        asset_id = entry.get("id")
        if not isinstance(asset_id, str) or not asset_id or asset_id in registry:
            raise PptAssetError("PPT asset manifest contains an invalid ID")
        registry[asset_id] = entry
    return registry


def _matches_sha256(data: bytes, expected: Any) -> bool:
    return (
        isinstance(expected, str)
        and len(expected) == 64
        and hashlib.sha256(data).hexdigest() == expected
    )


def get_ppt_asset_png_bytes(asset_id: str) -> bytes:
    """Decode one registered WebP asset and return a verified PNG payload."""
    if not isinstance(asset_id, str) or not asset_id:
        raise PptAssetError("A registered PPT asset ID is required")

    try:
        root = ASSET_ROOT.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PptAssetError("PPT asset resource root is unavailable") from exc
    entry = _load_registry(root).get(asset_id)
    if entry is None:
        raise PptAssetError("Unknown PPT asset ID")
    if entry.get("format") != "image/webp":
        raise PptAssetError("PPT asset format is unsupported")

    asset_path = _resolve_within_root(root, entry.get("file"))
    if not asset_path.is_file():
        raise PptAssetError("PPT asset file is unavailable")
    try:
        webp_bytes = asset_path.read_bytes()
    except OSError as exc:
        raise PptAssetError("PPT asset file is unavailable") from exc
    if not _matches_sha256(webp_bytes, entry.get("compressedSha256")):
        raise PptAssetError("PPT asset checksum does not match its manifest")

    try:
        with Image.open(io.BytesIO(webp_bytes)) as image:
            if image.format != "WEBP":
                raise PptAssetError("PPT asset bytes are not WebP")
            image.load()
            width, height = entry.get("width"), entry.get("height")
            if type(width) is not int or type(height) is not int or image.size != (width, height):
                raise PptAssetError("PPT asset dimensions do not match its manifest")

            rgba = image.convert("RGBA")
            rgba_bytes = rgba.tobytes()
            alpha_bytes = rgba.getchannel("A").tobytes()
            if not _matches_sha256(rgba_bytes, entry.get("rgbaSha256")):
                raise PptAssetError("PPT asset pixels do not match its manifest")
            if not _matches_sha256(alpha_bytes, entry.get("alphaSha256")):
                raise PptAssetError("PPT asset transparency does not match its manifest")

            icc_profile = image.info.get("icc_profile")
            icc_record = entry.get("iccProfile")
            if not isinstance(icc_record, dict):
                raise PptAssetError("PPT asset color profile metadata is invalid")
            expected_icc = icc_record.get("sha256")
            expected_icc_bytes = icc_record.get("byteLength")
            if expected_icc is None:
                if icc_profile is not None or expected_icc_bytes != 0:
                    raise PptAssetError("PPT asset color profile does not match its manifest")
            elif (
                not isinstance(icc_profile, bytes)
                or len(icc_profile) != expected_icc_bytes
                or not _matches_sha256(icc_profile, expected_icc)
            ):
                raise PptAssetError("PPT asset color profile does not match its manifest")

            color_chunks = entry.get("pngColorChunks", {})
            if not isinstance(color_chunks, dict):
                raise PptAssetError("PPT asset PNG color metadata is invalid")
            png_info = PngImagePlugin.PngInfo()
            for name, encoded in color_chunks.items():
                expected_length = _PNG_COLOR_CHUNK_LENGTHS.get(name)
                if expected_length is None or not isinstance(encoded, str):
                    raise PptAssetError("PPT asset PNG color metadata is invalid")
                try:
                    payload = bytes.fromhex(encoded)
                except ValueError as exc:
                    raise PptAssetError("PPT asset PNG color metadata is invalid") from exc
                if len(payload) != expected_length:
                    raise PptAssetError("PPT asset PNG color metadata is invalid")
                png_info.add(name.encode("ascii"), payload)

            png_buffer = io.BytesIO()
            save_options: dict[str, Any] = {"format": "PNG"}
            if png_info.chunks:
                save_options["pnginfo"] = png_info
            if icc_profile:
                save_options["icc_profile"] = icc_profile
            rgba.save(png_buffer, **save_options)
            return png_buffer.getvalue()
    except PptAssetError:
        raise
    except (OSError, UnidentifiedImageError, ValueError) as exc:
        raise PptAssetError("PPT asset could not be decoded") from exc


def get_ppt_asset_data_url(asset_id: str) -> str:
    """Return a PNG data URL for a registered asset for trusted Office templates."""
    encoded = base64.b64encode(get_ppt_asset_png_bytes(asset_id)).decode("ascii")
    return f"data:image/png;base64,{encoded}"
