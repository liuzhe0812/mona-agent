"""Project-local video asset registry with explicit provenance and usage rights."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

MAX_VIDEO_ASSET_BYTES = 200 * 1024 * 1024
SUPPORTED_VIDEO_ASSET_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".mp4",
    ".webm",
    ".mp3",
    ".wav",
    ".m4a",
}
ASSET_SOURCE_TYPES = {
    "user-upload",
    "document",
    "ai-generated",
    "licensed-library",
    "generated-chart",
}
ASSET_RIGHTS_STATUSES = {
    "unknown",
    "owned",
    "licensed",
    "public-domain",
    "ai-generated",
    "permission-granted",
}
_ASSET_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class VideoAssetError(ValueError):
    def __init__(self, message: str, *, code: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": str(self)}


def _now() -> str:
    return datetime.now().isoformat()


def _manifest_path(project_dir: Path) -> Path:
    return project_dir / "assets" / "manifest.json"


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_asset_manifest(project_dir: Path) -> dict[str, Any]:
    path = _manifest_path(project_dir)
    if not path.is_file():
        return {"schemaVersion": 1, "assets": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VideoAssetError(
            "素材台账无法读取", code="VIDEO_ASSET_MANIFEST_INVALID", status_code=409
        ) from exc
    if payload.get("schemaVersion") != 1 or not isinstance(payload.get("assets"), list):
        raise VideoAssetError(
            "素材台账格式无效", code="VIDEO_ASSET_MANIFEST_INVALID", status_code=409
        )
    return payload


def list_project_assets(project_dir: Path) -> list[dict[str, Any]]:
    return [dict(item) for item in read_asset_manifest(project_dir)["assets"]]


def register_project_asset(
    project_dir: Path,
    asset: Mapping[str, Any],
) -> dict[str, Any]:
    asset_id = str(asset.get("id") or "")
    if not _ASSET_ID_RE.fullmatch(asset_id):
        raise VideoAssetError("素材 ID 无效", code="VIDEO_ASSET_ID_INVALID")
    source_type = str(asset.get("sourceType") or "user-upload")
    rights_status = str(asset.get("rightsStatus") or "unknown")
    _validate_metadata(source_type, rights_status)
    relative = str(asset.get("path") or "").replace("\\", "/")
    if not relative.startswith("assets/") or ".." in Path(relative).parts:
        raise VideoAssetError("素材路径无效", code="VIDEO_ASSET_PATH_INVALID")
    source = (project_dir / relative).resolve()
    assets_root = (project_dir / "assets").resolve()
    if (
        not source.is_file()
        or os.path.commonpath([str(source), str(assets_root)]) != str(assets_root)
    ):
        raise VideoAssetError(
            "素材文件不存在", code="VIDEO_ASSET_FILE_NOT_FOUND", status_code=404
        )
    record = dict(asset)
    record.update(
        {
            "schemaVersion": 1,
            "id": asset_id,
            "path": relative,
            "sourceType": source_type,
            "rightsStatus": rights_status,
            "commercialUse": rights_status not in {"unknown", "ai-generated"},
            "updatedAt": str(asset.get("updatedAt") or _now()),
            "createdAt": str(asset.get("createdAt") or _now()),
        }
    )
    manifest = read_asset_manifest(project_dir)
    index = next(
        (
            index
            for index, item in enumerate(manifest["assets"])
            if item.get("id") == asset_id
        ),
        None,
    )
    if index is None:
        manifest["assets"].append(record)
    else:
        manifest["assets"][index] = record
    _atomic_write_json(_manifest_path(project_dir), manifest)
    return dict(record)


def _validate_metadata(source_type: str, rights_status: str) -> None:
    if source_type not in ASSET_SOURCE_TYPES:
        raise VideoAssetError("素材来源类型无效", code="VIDEO_ASSET_SOURCE_INVALID")
    if rights_status not in ASSET_RIGHTS_STATUSES:
        raise VideoAssetError("素材权利状态无效", code="VIDEO_ASSET_RIGHTS_INVALID")


def _validate_asset_content(source: Path, extension: str) -> None:
    image_formats = {
        ".png": "PNG",
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".webp": "WEBP",
        ".gif": "GIF",
    }
    if extension in image_formats:
        try:
            from PIL import Image

            with Image.open(source) as image:
                actual = str(image.format or "").upper()
                image.verify()
        except Exception as exc:
            raise VideoAssetError(
                "图片内容无法解码", code="VIDEO_ASSET_CONTENT_INVALID"
            ) from exc
        if actual != image_formats[extension]:
            raise VideoAssetError(
                "图片扩展名与实际格式不一致", code="VIDEO_ASSET_CONTENT_INVALID"
            )
        return
    with source.open("rb") as stream:
        header = stream.read(16)
    valid = {
        ".mp4": len(header) >= 8 and header[4:8] == b"ftyp",
        ".m4a": len(header) >= 8 and header[4:8] == b"ftyp",
        ".webm": header.startswith(b"\x1aE\xdf\xa3"),
        ".wav": header.startswith(b"RIFF") and header[8:12] == b"WAVE",
        ".mp3": header.startswith(b"ID3")
        or (len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0),
    }.get(extension, False)
    if not valid:
        raise VideoAssetError(
            "素材扩展名与文件内容不一致", code="VIDEO_ASSET_CONTENT_INVALID"
        )


def import_project_asset(
    project_dir: Path,
    source_path: Path | str,
    *,
    source_type: str = "user-upload",
    rights_status: str = "unknown",
    license_name: str = "",
    source_url: str = "",
    creator: str = "",
    attribution: str = "",
    ai_provider: str = "",
    generation_prompt: str = "",
) -> dict[str, Any]:
    _validate_metadata(source_type, rights_status)
    try:
        source = Path(source_path).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise VideoAssetError(
            "素材文件不存在", code="VIDEO_ASSET_FILE_NOT_FOUND", status_code=404
        ) from exc
    if not source.is_file():
        raise VideoAssetError(
            "素材路径不是文件", code="VIDEO_ASSET_FILE_NOT_FOUND", status_code=404
        )
    extension = source.suffix.lower()
    if extension not in SUPPORTED_VIDEO_ASSET_EXTENSIONS:
        raise VideoAssetError(
            "素材格式仅支持常用图片、视频和音频", code="VIDEO_ASSET_FORMAT_UNSUPPORTED"
        )
    size = source.stat().st_size
    if size <= 0 or size > MAX_VIDEO_ASSET_BYTES:
        raise VideoAssetError(
            "素材文件大小无效或超过 200 MiB",
            code="VIDEO_ASSET_FILE_TOO_LARGE",
            status_code=413,
        )
    _validate_asset_content(source, extension)
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    asset_id = f"asset-{sha256[:24]}"
    manifest = read_asset_manifest(project_dir)
    existing = next(
        (item for item in manifest["assets"] if item.get("sha256") == sha256), None
    )
    if existing is not None:
        return dict(existing)
    library = project_dir / "assets" / "library"
    library.mkdir(parents=True, exist_ok=True)
    relative = f"assets/library/{asset_id}{extension}"
    target = project_dir / relative
    temporary = target.with_name(f".{target.name}.{next(tempfile._get_candidate_names())}.tmp")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    mime_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    asset = {
        "schemaVersion": 1,
        "id": asset_id,
        "kind": mime_type.split("/", 1)[0],
        "path": relative,
        "originalName": source.name,
        "mimeType": mime_type,
        "bytes": size,
        "sha256": sha256,
        "sourceType": source_type,
        "rightsStatus": rights_status,
        "commercialUse": rights_status not in {"unknown", "ai-generated"},
        "licenseName": str(license_name or "")[:200],
        "sourceUrl": str(source_url or "")[:2_000],
        "creator": str(creator or "")[:200],
        "attribution": str(attribution or "")[:1_000],
        "aiProvider": str(ai_provider or "")[:200],
        "generationPrompt": str(generation_prompt or "")[:4_000],
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    manifest["assets"].append(asset)
    _atomic_write_json(_manifest_path(project_dir), manifest)
    return dict(asset)


def update_project_asset(
    project_dir: Path,
    asset_id: str,
    patch: Mapping[str, Any],
) -> dict[str, Any]:
    if not _ASSET_ID_RE.fullmatch(asset_id):
        raise VideoAssetError("素材 ID 无效", code="VIDEO_ASSET_ID_INVALID")
    manifest = read_asset_manifest(project_dir)
    target = next((item for item in manifest["assets"] if item.get("id") == asset_id), None)
    if target is None:
        raise VideoAssetError(
            "素材不存在", code="VIDEO_ASSET_NOT_FOUND", status_code=404
        )
    source_type = str(patch.get("sourceType", target.get("sourceType") or "user-upload"))
    rights_status = str(patch.get("rightsStatus", target.get("rightsStatus") or "unknown"))
    _validate_metadata(source_type, rights_status)
    target["sourceType"] = source_type
    target["rightsStatus"] = rights_status
    target["commercialUse"] = rights_status not in {"unknown", "ai-generated"}
    for key, limit in (
        ("licenseName", 200),
        ("sourceUrl", 2_000),
        ("creator", 200),
        ("attribution", 1_000),
        ("aiProvider", 200),
        ("generationPrompt", 4_000),
    ):
        if key in patch:
            target[key] = str(patch.get(key) or "")[:limit]
    target["updatedAt"] = _now()
    _atomic_write_json(_manifest_path(project_dir), manifest)
    return dict(target)


def validate_asset_references(
    project_dir: Path,
    asset_ids: Iterable[str],
) -> list[dict[str, Any]]:
    assets = {item.get("id"): item for item in list_project_assets(project_dir)}
    result: list[dict[str, Any]] = []
    for value in asset_ids:
        asset_id = str(value or "")
        asset = assets.get(asset_id)
        if asset is None:
            raise VideoAssetError(
                f"素材不存在: {asset_id}", code="VIDEO_ASSET_NOT_FOUND", status_code=404
            )
        result.append(dict(asset))
    return result


def asset_rights_issues(
    project_dir: Path,
    asset_ids: Iterable[str],
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for asset in validate_asset_references(project_dir, asset_ids):
        if asset.get("rightsStatus") == "unknown" or not asset.get("commercialUse"):
            issues.append(
                {
                    "assetId": asset["id"],
                    "name": asset.get("originalName"),
                    "code": "ASSET_RIGHTS_UNCONFIRMED",
                }
            )
    return issues


__all__ = [
    "ASSET_RIGHTS_STATUSES",
    "ASSET_SOURCE_TYPES",
    "VideoAssetError",
    "asset_rights_issues",
    "import_project_asset",
    "list_project_assets",
    "read_asset_manifest",
    "register_project_asset",
    "update_project_asset",
    "validate_asset_references",
]
