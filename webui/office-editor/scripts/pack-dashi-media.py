#!/usr/bin/env python3
"""Store referenced Dashi template PNG media as verified lossless WebP assets."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import posixpath
import re
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image, UnidentifiedImageError

MONA_ROOT = Path(__file__).resolve().parents[3]
_ASSET_RELATIVE_PATH = Path("mona") / "skills" / "mona-pptx" / "assets" / "dashi"
ASSET_ROOT = MONA_ROOT / _ASSET_RELATIVE_PATH
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_COLOR_CHUNK_LENGTHS = {"cHRM": 32, "gAMA": 4, "sRGB": 1}
_FULL_SLIDE_DECORATION_TEXT = (
    "Independent background or decorative media required to preserve the native template; "
    "not a whole-slide screenshot."
)


class DashiMediaError(ValueError):
    """The fixed Dashi media catalog is invalid or unsafe to update."""


def _resolve_asset_root() -> Path:
    project_root = MONA_ROOT.resolve(strict=True)
    root = ASSET_ROOT.resolve(strict=True)
    expected_root = (project_root / _ASSET_RELATIVE_PATH).resolve(strict=True)
    try:
        root.relative_to(project_root)
    except ValueError as exc:
        raise DashiMediaError("Dashi asset root is outside the Mona project") from exc
    if root != expected_root:
        raise DashiMediaError("Dashi asset root does not match the fixed Mona resource path")
    return root


def _resolve_within_root(root: Path, name: str, *, strict: bool) -> Path:
    path = (root / name).resolve(strict=strict)
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise DashiMediaError("Dashi asset path is outside its fixed resource root") from exc
    return path


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _png_color_chunks(data: bytes) -> dict[str, str]:
    chunks: dict[str, str] = {}
    position = len(_PNG_SIGNATURE)
    while position + 12 <= len(data):
        length = int.from_bytes(data[position : position + 4], "big")
        name = data[position + 4 : position + 8].decode("ascii", errors="strict")
        end = position + 12 + length
        if end > len(data):
            raise DashiMediaError("PNG media contains a truncated chunk")
        if name in _PNG_COLOR_CHUNK_LENGTHS:
            payload = data[position + 8 : position + 8 + length]
            if len(payload) != _PNG_COLOR_CHUNK_LENGTHS[name]:
                raise DashiMediaError("PNG media contains invalid color metadata")
            chunks[name] = payload.hex()
        position = end
        if name == "IEND":
            break
    return chunks


def _inspect_png(png_bytes: bytes) -> dict[str, Any]:
    try:
        with Image.open(io.BytesIO(png_bytes)) as image:
            if image.format != "PNG":
                raise DashiMediaError("Referenced PNG media is not a PNG image")
            image.load()
            width, height = image.size
            source_mode = image.mode
            icc_profile = image.info.get("icc_profile")
            if icc_profile is not None and not isinstance(icc_profile, bytes):
                raise DashiMediaError("PNG media has invalid ICC profile metadata")
            rgba = image.convert("RGBA")
            rgba_bytes = rgba.tobytes()
            alpha_bytes = rgba.getchannel("A").tobytes()
    except DashiMediaError:
        raise
    except (OSError, ValueError, UnidentifiedImageError, UnicodeDecodeError) as exc:
        raise DashiMediaError("Referenced PNG media could not be decoded") from exc

    return {
        "width": width,
        "height": height,
        "sourceMode": source_mode,
        "rgbaBytes": rgba_bytes,
        "alphaBytes": alpha_bytes,
        "rgbaSha256": _sha256(rgba_bytes),
        "alphaSha256": _sha256(alpha_bytes),
        "pngColorChunks": _png_color_chunks(png_bytes),
        "iccProfileBytes": icc_profile,
        "iccProfile": {
            "sha256": _sha256(icc_profile) if icc_profile else None,
            "byteLength": len(icc_profile) if icc_profile else 0,
        },
    }


def _visual_key(record: dict[str, Any]) -> tuple[Any, ...] | None:
    width, height = record.get("width"), record.get("height")
    rgba_hash, alpha_hash = record.get("rgbaSha256"), record.get("alphaSha256")
    icc = record.get("iccProfile")
    chunks = record.get("pngColorChunks", {})
    if (
        type(width) is not int
        or type(height) is not int
        or width <= 0
        or height <= 0
        or not isinstance(rgba_hash, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", rgba_hash)
        or not isinstance(alpha_hash, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", alpha_hash)
        or not isinstance(icc, dict)
        or not isinstance(chunks, dict)
        or any(not isinstance(name, str) or not isinstance(value, str) for name, value in chunks.items())
    ):
        return None
    icc_hash, icc_length = icc.get("sha256"), icc.get("byteLength")
    if icc_hash is None:
        if icc_length != 0:
            return None
    elif (
        not isinstance(icc_hash, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", icc_hash)
        or type(icc_length) is not int
        or icc_length < 1
    ):
        return None
    return (
        width,
        height,
        rgba_hash.lower(),
        alpha_hash.lower(),
        icc_hash.lower() if isinstance(icc_hash, str) else None,
        icc_length,
        tuple(sorted(chunks.items())),
    )


def _reuse_existing_asset(
    root: Path,
    entry: dict[str, Any],
    identity: dict[str, Any],
    source_size: int,
) -> int | None:
    if entry.get("format") != "image/webp" or not isinstance(entry.get("file"), str):
        raise DashiMediaError("Matching Dashi asset is not a registered WebP image")
    asset_path = _resolve_within_root(root, entry["file"], strict=True)
    try:
        if asset_path.stat().st_size >= source_size:
            return None
        webp_bytes = asset_path.read_bytes()
        if _sha256(webp_bytes) != entry.get("compressedSha256"):
            raise DashiMediaError("Matching Dashi asset checksum does not match its manifest")
        with Image.open(io.BytesIO(webp_bytes)) as image:
            if image.format != "WEBP" or image.size != (identity["width"], identity["height"]):
                raise DashiMediaError("Matching Dashi WebP dimensions do not match its manifest")
            image.load()
            rgba_bytes = image.convert("RGBA").tobytes()
            if rgba_bytes != identity["rgbaBytes"]:
                raise DashiMediaError("Matching Dashi WebP pixels differ from the source PNG")
            if image.info.get("icc_profile") != identity["iccProfileBytes"]:
                raise DashiMediaError("Matching Dashi WebP ICC profile differs from the source PNG")
    except DashiMediaError:
        raise
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise DashiMediaError("Matching Dashi WebP asset could not be verified") from exc
    return len(webp_bytes)


def _encode_lossless_webp(identity: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    try:
        rgba = Image.frombytes(
            "RGBA",
            (identity["width"], identity["height"]),
            identity["rgbaBytes"],
        )
        options: dict[str, Any] = {
            "format": "WEBP",
            "lossless": True,
            "quality": 100,
            "method": 6,
            "exact": True,
        }
        if identity["iccProfileBytes"]:
            options["icc_profile"] = identity["iccProfileBytes"]
        output = io.BytesIO()
        rgba.save(output, **options)
        webp_bytes = output.getvalue()

        with Image.open(io.BytesIO(webp_bytes)) as decoded:
            if decoded.format != "WEBP":
                raise DashiMediaError("Lossless encoder did not produce WebP media")
            decoded.load()
            if (
                decoded.size != (identity["width"], identity["height"])
                or decoded.convert("RGBA").tobytes() != identity["rgbaBytes"]
            ):
                raise DashiMediaError("Lossless WebP changed source PNG pixels")
            if decoded.info.get("icc_profile") != identity["iccProfileBytes"]:
                raise DashiMediaError("Lossless WebP changed source PNG ICC metadata")
    except DashiMediaError:
        raise
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise DashiMediaError("Referenced PNG media could not be encoded") from exc

    entry_metadata = {
        key: identity[key]
        for key in (
            "width",
            "height",
            "sourceMode",
            "rgbaSha256",
            "alphaSha256",
            "pngColorChunks",
            "iccProfile",
        )
    }
    return webp_bytes, entry_metadata


def _part_references(document: dict[str, Any]) -> dict[str, set[str]]:
    references: dict[str, set[str]] = {}
    for page in document["pages"]:
        bundle = page.get("bundle", {})
        for package in (bundle, bundle.get("chain", {})):
            part_refs = package.get("partRefs", {}) if isinstance(package, dict) else {}
            if not isinstance(part_refs, dict):
                continue
            for path, part_hash in part_refs.items():
                if isinstance(path, str) and isinstance(part_hash, str):
                    references.setdefault(part_hash, set()).add(path)
    return references


def _package_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    if normalized.startswith("/"):
        return posixpath.normpath(normalized).lstrip("/")
    if PurePosixPath(normalized).parts[:1] in (("ppt",), ("docProps",), ("_rels",)):
        return posixpath.normpath(normalized)
    return posixpath.normpath(posixpath.join("ppt/slides", normalized))


def _whole_slide_flatten_parts(document: dict[str, Any]) -> set[str]:
    blocked: set[str] = set()
    for page in document["pages"]:
        bundle = page.get("bundle", {})
        if not isinstance(bundle, dict):
            continue
        slide_xml = bundle.get("slideXml")
        part_refs = bundle.get("partRefs", {})
        rels = bundle.get("rels", [])
        slide_size = bundle.get("slideSize")
        if (
            not isinstance(slide_xml, str)
            or not isinstance(part_refs, dict)
            or not isinstance(rels, list)
            or not isinstance(slide_size, dict)
        ):
            continue
        picture_blocks = re.findall(r"<p:pic\b[\s\S]*?</p:pic>", slide_xml)
        if len(picture_blocks) != 1 or re.search(r"<p:sp\b|<a:t\b", slide_xml):
            continue
        transform = re.search(
            r'<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*/>'
            r'[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*/>[\s\S]*?</a:xfrm>',
            picture_blocks[0],
        )
        size_x, size_y = slide_size.get("cx"), slide_size.get("cy")
        if not transform or not isinstance(size_x, int) or not isinstance(size_y, int):
            continue
        x, y, width, height = (int(value) for value in transform.groups())
        if not (
            x <= size_x * 0.01
            and y <= size_y * 0.01
            and x + width >= size_x * 0.99
            and y + height >= size_y * 0.99
        ):
            continue

        relationship_id = re.search(r'\br:embed="([^"]+)"', picture_blocks[0])
        relationship = next(
            (
                rel
                for rel in rels
                if isinstance(rel, dict)
                and relationship_id
                and rel.get("id") == relationship_id.group(1)
                and isinstance(rel.get("type"), str)
                and rel["type"].endswith("/image")
                and not rel.get("external")
            ),
            None,
        )
        target = relationship.get("target") if relationship else None
        if not isinstance(target, str):
            continue
        target_path = _package_path(target)
        matching_hashes = {
            part_hash
            for part_path, part_hash in part_refs.items()
            if isinstance(part_path, str)
            and part_path.lower().endswith(".png")
            and _package_path(part_path) == target_path
        }
        if not matching_hashes:
            matching_hashes = {
                part_hash
                for part_path, part_hash in part_refs.items()
                if isinstance(part_path, str)
                and part_path.lower().endswith(".png")
                and PurePosixPath(part_path).name == PurePosixPath(target_path).name
            }
        blocked.update(matching_hashes)
    return blocked


def _write_atomic(root: Path, name: str, data: bytes) -> None:
    target = _resolve_within_root(root, name, strict=False)
    temporary = _resolve_within_root(root, f".{name}.tmp", strict=False)
    temporary.write_bytes(data)
    os.replace(temporary, target)


def _write_json(root: Path, name: str, value: Any) -> None:
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _write_atomic(root, name, data)


def pack_dashi_media() -> dict[str, int]:
    """Convert smaller referenced PNG decorations under the fixed Mona asset root."""
    root = _resolve_asset_root()
    templates_path = _resolve_within_root(root, "templates.json", strict=True)
    manifest_path = _resolve_within_root(root, "manifest.json", strict=True)
    try:
        document = json.loads(templates_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DashiMediaError("Dashi templates or asset manifest is unavailable or invalid") from exc
    if (
        not isinstance(document, dict)
        or not isinstance(document.get("pages"), list)
        or not isinstance(document.get("parts"), dict)
        or not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or not isinstance(manifest.get("assets"), list)
    ):
        raise DashiMediaError("Dashi templates or asset manifest has an unsupported structure")

    parts = document["parts"]
    assets = manifest["assets"]
    assets_by_id: dict[str, dict[str, Any]] = {}
    assets_by_visual: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for entry in assets:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise DashiMediaError("Dashi asset manifest contains an invalid entry")
        if entry["id"] in assets_by_id:
            raise DashiMediaError("Dashi asset manifest contains a duplicate ID")
        assets_by_id[entry["id"]] = entry
        visual_key = _visual_key(entry) if entry.get("format") == "image/webp" else None
        if visual_key is not None:
            assets_by_visual.setdefault(visual_key, []).append(entry)

    references = _part_references(document)
    whole_slide_parts = _whole_slide_flatten_parts(document)
    added_assets: list[dict[str, Any]] = []
    pending_webp: dict[str, bytes] = {}
    converted_parts = 0
    source_bytes = 0
    webp_bytes_total = 0
    new_webp_bytes_total = 0
    reused_existing_parts = 0

    pending_encodes: list[tuple[Future[tuple[bytes, dict[str, Any]]], str, set[str], dict[str, Any], bytes, str, dict[str, Any]]] = []

    def register_encoded_asset(
        task: tuple[Future[tuple[bytes, dict[str, Any]]], str, set[str], dict[str, Any], bytes, str, dict[str, Any]]
    ) -> None:
        nonlocal converted_parts, source_bytes, webp_bytes_total, new_webp_bytes_total
        future, part_hash, paths, part, png_bytes, source_hash, identity = task
        webp_data, metadata = future.result()
        if len(webp_data) >= len(png_bytes):
            return
        asset_id = f"derived-{source_hash[:16]}"
        existing = assets_by_id.get(asset_id)
        if existing is not None:
            if existing.get("sourceSha256") != source_hash:
                raise DashiMediaError("Derived Dashi asset ID collides with another source image")
            entry = existing
            webp_size = _reuse_existing_asset(root, existing, identity, len(png_bytes)) or 0
            if webp_size == 0:
                raise DashiMediaError("Existing derived Dashi asset is not smaller than its source PNG")
        else:
            entry = {
                "id": asset_id,
                "file": f"{asset_id}.webp",
                "format": "image/webp",
                **metadata,
                "sourceRelativePath": f"templates.json#parts/{part_hash}",
                "sourcePartPaths": sorted(paths),
                "sourceSha256": source_hash,
                "compressedSha256": _sha256(webp_data),
                "assetRole": "required-template-background-or-decoration",
                "description": _FULL_SLIDE_DECORATION_TEXT,
            }
            assets_by_id[asset_id] = entry
            added_assets.append(entry)
            pending_webp[entry["file"]] = webp_data
            new_webp_bytes_total += len(webp_data)
            webp_size = len(webp_data)

        part.pop("base64", None)
        part["assetId"] = entry["id"]
        converted_parts += 1
        source_bytes += len(png_bytes)
        webp_bytes_total += webp_size

    with ThreadPoolExecutor(max_workers=3) as encoder:
        for part_hash, paths in references.items():
            if part_hash in whole_slide_parts or not any(path.lower().endswith(".png") for path in paths):
                continue
            part = parts.get(part_hash)
            if not isinstance(part, dict) or "assetId" in part or not isinstance(part.get("base64"), str):
                continue
            try:
                png_bytes = base64.b64decode(part["base64"], validate=True)
            except (binascii.Error, ValueError) as exc:
                raise DashiMediaError(f"PNG media part {part_hash} has invalid base64") from exc
            if not png_bytes.startswith(_PNG_SIGNATURE):
                raise DashiMediaError(f"Referenced PNG media part {part_hash} has no PNG signature")

            source_hash = _sha256(png_bytes)
            identity = _inspect_png(png_bytes)
            visual_key = _visual_key(identity)
            entry = None
            for candidate in assets_by_visual.get(visual_key, []) if visual_key is not None else []:
                existing_size = _reuse_existing_asset(root, candidate, identity, len(png_bytes))
                if existing_size is not None:
                    entry = candidate
                    webp_bytes_total += existing_size
                    source_bytes += len(png_bytes)
                    converted_parts += 1
                    reused_existing_parts += 1
                    part.pop("base64", None)
                    part["assetId"] = entry["id"]
                    break
            if entry is not None:
                continue

            pending_encodes.append(
                (
                    encoder.submit(_encode_lossless_webp, identity),
                    part_hash,
                    paths,
                    part,
                    png_bytes,
                    source_hash,
                    identity,
                )
            )
            if len(pending_encodes) >= 3:
                register_encoded_asset(pending_encodes.pop(0))

        while pending_encodes:
            register_encoded_asset(pending_encodes.pop(0))

    if added_assets:
        assets.extend(added_assets)
    manifest["assetCount"] = len(assets)

    for file_name, data in pending_webp.items():
        _resolve_within_root(root, file_name, strict=False)
        _write_atomic(root, file_name, data)

    for page in document["pages"]:
        if not isinstance(page, dict):
            raise DashiMediaError("Dashi template page entry is invalid")
        asset_ids: set[str] = set()
        bundle = page.get("bundle", {})
        for package in (bundle, bundle.get("chain", {}) if isinstance(bundle, dict) else {}):
            part_refs = package.get("partRefs", {}) if isinstance(package, dict) else {}
            if not isinstance(part_refs, dict):
                continue
            for part_hash in part_refs.values():
                part = parts.get(part_hash) if isinstance(part_hash, str) else None
                asset_id = part.get("assetId") if isinstance(part, dict) else None
                if asset_id is not None:
                    if asset_id not in assets_by_id:
                        raise DashiMediaError(f"Dashi template references unregistered asset {asset_id}")
                    asset_ids.add(asset_id)
        page["assetIds"] = sorted(asset_ids)

    registry = {
        "schemaVersion": 1,
        "pages": [
            {"id": page["id"], "assetIds": page["assetIds"]}
            for page in document["pages"]
            if isinstance(page, dict) and isinstance(page.get("id"), str)
        ],
    }
    retained_svg_base64_bytes = 0
    retained_other_base64_bytes = 0
    retained_base64_parts = 0
    for part_hash, part in parts.items():
        if not isinstance(part, dict) or not isinstance(part.get("base64"), str):
            continue
        try:
            encoded_size = len(part["base64"].encode("ascii"))
        except UnicodeEncodeError as exc:
            raise DashiMediaError(f"Template media part {part_hash} has non-ASCII base64") from exc
        retained_base64_parts += 1
        if any(path.lower().endswith(".svg") for path in references.get(part_hash, set())):
            retained_svg_base64_bytes += encoded_size
        else:
            retained_other_base64_bytes += encoded_size

    _write_json(root, "manifest.json", manifest)
    _write_json(root, "templates.json", document)
    _write_json(root, "template-assets.json", registry)
    return {
        "convertedParts": converted_parts,
        "newAssets": len(added_assets),
        "sourceBytes": source_bytes,
        "webpBytes": webp_bytes_total,
        "newWebpBytes": new_webp_bytes_total,
        "savedBytes": source_bytes - webp_bytes_total,
        "reusedExistingParts": reused_existing_parts,
        "retainedSvgBase64Bytes": retained_svg_base64_bytes,
        "retainedOtherBase64Bytes": retained_other_base64_bytes,
        "retainedBase64Bytes": retained_svg_base64_bytes + retained_other_base64_bytes,
        "retainedBase64Parts": retained_base64_parts,
    }


def main() -> None:
    result = pack_dashi_media()
    print(
        "Packed {convertedParts} PNG parts into {newAssets} new WebP assets: "
        "{sourceBytes} source bytes → {webpBytes} WebP bytes, "
        "{newWebpBytes} new media bytes ({savedBytes} bytes saved); "
        "reused {reusedExistingParts} existing assets; retained base64 bytes: "
        "SVG {retainedSvgBase64Bytes}, other {retainedOtherBase64Bytes}.".format(**result)
    )


if __name__ == "__main__":
    main()
