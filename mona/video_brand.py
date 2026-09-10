"""Reusable immutable brand kits for Mona video series."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping

BRAND_SCHEMA_VERSION = 1
BRAND_LOCKABLE_FIELDS = {
    "tokens.colors.primary",
    "tokens.colors.secondary",
    "tokens.colors.accent",
    "tokens.colors.background",
    "tokens.colors.surface",
    "tokens.colors.textPrimary",
    "tokens.colors.textSecondary",
    "tokens.typography.headingFamily",
    "tokens.typography.bodyFamily",
    "brand.displayName",
    "brand.logo.light",
    "brand.logo.dark",
}
_KIT_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$")
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


class BrandKitError(ValueError):
    def __init__(self, message: str, *, code: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": str(self)}


def _now() -> str:
    return datetime.now().isoformat()


def brand_kits_directory(root: Path | str) -> Path:
    path = Path(root)
    return path if path.name == "video_brand_kits" else path / "video_brand_kits"


def _safe_id(value: str) -> str:
    raw = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    candidate = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").lower()
    if not candidate:
        candidate = "brand-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]
    candidate = candidate[:64].strip("-_")
    if not _KIT_ID_RE.fullmatch(candidate):
        raise BrandKitError("品牌套件 ID 无效", code="BRAND_KIT_ID_INVALID")
    return candidate


def _kit_directory(root: Path | str, kit_id: str) -> Path:
    if not _KIT_ID_RE.fullmatch(kit_id):
        raise BrandKitError("品牌套件 ID 无效", code="BRAND_KIT_ID_INVALID")
    return brand_kits_directory(root) / kit_id


def _atomic_write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BrandKitError(
            "品牌套件不存在", code="BRAND_KIT_NOT_FOUND", status_code=404
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise BrandKitError(
            "品牌套件数据损坏", code="BRAND_KIT_INVALID", status_code=409
        ) from exc
    if payload.get("schemaVersion") != BRAND_SCHEMA_VERSION:
        raise BrandKitError("品牌套件版本无效", code="BRAND_KIT_INVALID")
    return payload


def _path_value(value: Mapping[str, Any], path: str) -> Any:
    current: Any = value
    for part in path.split("."):
        if not isinstance(current, Mapping):
            return None
        current = current.get(part)
    return current


def _set_path(value: dict[str, Any], path: str, item: Any) -> None:
    parts = path.split(".")
    current = value
    for part in parts[:-1]:
        nested = current.get(part)
        if not isinstance(nested, dict):
            nested = {}
            current[part] = nested
        current = nested
    current[parts[-1]] = copy.deepcopy(item)


def _validate_draft(draft: Mapping[str, Any]) -> None:
    name = str(draft.get("name") or "").strip()
    if not name:
        raise BrandKitError("品牌套件名称不能为空", code="BRAND_KIT_NAME_REQUIRED")
    locked_fields = draft.get("lockedFields") or []
    if not isinstance(locked_fields, list) or any(
        str(field) not in BRAND_LOCKABLE_FIELDS for field in locked_fields
    ):
        raise BrandKitError("品牌锁定字段无效", code="BRAND_KIT_LOCKS_INVALID")
    colors = ((draft.get("tokens") or {}).get("colors") or {})
    for key, value in colors.items():
        if key in {
            "primary",
            "secondary",
            "accent",
            "background",
            "surface",
            "textPrimary",
            "textSecondary",
        } and not _HEX_RE.fullmatch(str(value or "")):
            raise BrandKitError("品牌颜色必须是六位十六进制", code="BRAND_KIT_COLOR_INVALID")
    typography = ((draft.get("tokens") or {}).get("typography") or {})
    for key, value in typography.items():
        if key in {"headingFamily", "bodyFamily", "numberFamily"} and (
            not isinstance(value, str) or not value.strip() or len(value) > 120
        ):
            raise BrandKitError("品牌字体无效", code="BRAND_KIT_FONT_INVALID")
    logo = ((draft.get("brand") or {}).get("logo") or {})
    if not isinstance(logo, Mapping):
        raise BrandKitError("品牌 Logo 配置无效", code="BRAND_LOGO_INVALID")
    for variant, record in logo.items():
        if variant not in {"light", "dark"} or not isinstance(record, Mapping):
            raise BrandKitError("品牌 Logo 配置无效", code="BRAND_LOGO_INVALID")
        asset_id = str(record.get("assetId") or "")
        if (
            not _ASSET_ID_RE.fullmatch(asset_id)
            or record.get("path") != f"assets/{asset_id}.webp"
        ):
            raise BrandKitError("品牌 Logo 路径无效", code="BRAND_LOGO_PATH_INVALID")


def create_brand_kit(
    root: Path | str,
    name: str,
    *,
    kit_id: str | None = None,
    tokens: Mapping[str, Any] | None = None,
    display_name: str = "",
    locked_fields: list[str] | None = None,
) -> dict[str, Any]:
    clean_name = str(name or "").strip()
    actual_id = _safe_id(kit_id or clean_name)
    directory = _kit_directory(root, actual_id)
    if directory.exists():
        raise BrandKitError(
            "品牌套件已存在", code="BRAND_KIT_EXISTS", status_code=409
        )
    now = _now()
    draft = {
        "schemaVersion": BRAND_SCHEMA_VERSION,
        "id": actual_id,
        "name": clean_name,
        "revision": 0,
        "latestVersion": 0,
        "tokens": copy.deepcopy(dict(tokens or {})),
        "brand": {
            "displayName": str(display_name or clean_name).strip(),
            "logo": {},
        },
        "lockedFields": locked_fields
        or [
            "tokens.colors.primary",
            "tokens.colors.secondary",
            "tokens.typography.headingFamily",
            "tokens.typography.bodyFamily",
            "brand.displayName",
            "brand.logo.light",
            "brand.logo.dark",
        ],
        "createdAt": now,
        "updatedAt": now,
    }
    _validate_draft(draft)
    directory.mkdir(parents=True)
    _atomic_write(directory / "draft.json", draft)
    return copy.deepcopy(draft)


def list_brand_kits(root: Path | str) -> list[dict[str, Any]]:
    directory = brand_kits_directory(root)
    if not directory.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for child in sorted(directory.iterdir()):
        if not child.is_dir():
            continue
        try:
            draft = _read(child / "draft.json")
        except BrandKitError:
            continue
        result.append(draft)
    return result


def read_brand_draft(root: Path | str, kit_id: str) -> dict[str, Any]:
    return _read(_kit_directory(root, kit_id) / "draft.json")


def import_brand_logo(
    root: Path | str,
    kit_id: str,
    source_path: Path | str,
    *,
    variant: str,
    rights_status: str = "unknown",
    alt: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    from PIL import Image, ImageOps

    from mona.video_assets import ASSET_RIGHTS_STATUSES

    if variant not in {"light", "dark"}:
        raise BrandKitError("Logo 版本无效", code="BRAND_LOGO_VARIANT_INVALID")
    if rights_status not in ASSET_RIGHTS_STATUSES:
        raise BrandKitError("Logo 权利状态无效", code="BRAND_LOGO_RIGHTS_INVALID")
    directory = _kit_directory(root, kit_id)
    draft = read_brand_draft(root, kit_id)
    source = Path(source_path)
    try:
        source = source.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise BrandKitError(
            "Logo 文件不存在", code="BRAND_LOGO_NOT_FOUND", status_code=404
        ) from exc
    if source.stat().st_size > 10 * 1024 * 1024:
        raise BrandKitError(
            "Logo 不能超过 10 MiB", code="BRAND_LOGO_TOO_LARGE", status_code=413
        )
    try:
        with Image.open(source) as probe:
            probe.verify()
        with Image.open(source) as image:
            image.load()
            normalized = ImageOps.exif_transpose(image).convert("RGBA")
            if normalized.width < 32 or normalized.height < 32:
                raise BrandKitError(
                    "Logo 尺寸至少为 32×32", code="BRAND_LOGO_TOO_SMALL"
                )
            from io import BytesIO

            output = BytesIO()
            normalized.save(output, format="WEBP", lossless=True, method=6)
            data = output.getvalue()
    except BrandKitError:
        raise
    except Exception as exc:
        raise BrandKitError("Logo 无法解码", code="BRAND_LOGO_INVALID") from exc
    digest = hashlib.sha256(data).hexdigest()
    asset_id = f"brand-logo-{variant}-{digest[:18]}"
    relative = f"assets/{asset_id}.webp"
    target = directory / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{next(tempfile._get_candidate_names())}.tmp")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    commercial_use = rights_status not in {"unknown", "ai-generated"}
    record = {
        "assetId": asset_id,
        "path": relative,
        "alt": str(alt or draft.get("name") or "品牌 Logo")[:200],
        "sha256": digest,
        "width": normalized.width,
        "height": normalized.height,
        "rightsStatus": rights_status,
        "commercialUse": commercial_use,
        "originalName": source.name,
    }
    brand = draft.setdefault("brand", {})
    logo = brand.setdefault("logo", {})
    logo[variant] = record
    draft["revision"] = int(draft.get("revision") or 0) + 1
    draft["updatedAt"] = _now()
    _atomic_write(directory / "draft.json", draft)
    return copy.deepcopy(record), copy.deepcopy(draft)


def lock_brand_kit(
    root: Path | str,
    kit_id: str,
    *,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    directory = _kit_directory(root, kit_id)
    draft = read_brand_draft(root, kit_id)
    if expected_revision is not None and int(draft.get("revision") or 0) != expected_revision:
        raise BrandKitError(
            "品牌套件已被其他编辑更新", code="BRAND_KIT_REVISION_CONFLICT", status_code=409
        )
    _validate_draft(draft)
    version = int(draft.get("latestVersion") or 0) + 1
    version_directory = directory / "versions" / f"v{version}"
    if version_directory.exists():
        raise BrandKitError(
            "品牌套件版本不可覆盖", code="BRAND_KIT_VERSION_EXISTS", status_code=409
        )
    staging = version_directory.with_name(
        f".{version_directory.name}.publishing-{os.getpid()}-{next(tempfile._get_candidate_names())}"
    )
    immutable = copy.deepcopy(draft)
    immutable["version"] = version
    immutable["lockedAt"] = _now()
    logo = ((immutable.get("brand") or {}).get("logo") or {})
    hash_payload = {
        key: value
        for key, value in immutable.items()
        if key not in {"createdAt", "updatedAt", "lockedAt", "snapshotHash"}
    }
    immutable["snapshotHash"] = hashlib.sha256(
        json.dumps(hash_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    try:
        staging.mkdir(parents=True, exist_ok=False)
        for variant, record in logo.items():
            if not isinstance(record, dict) or not record.get("assetId"):
                continue
            source = directory / str(record.get("path") or "")
            if not source.is_file():
                raise BrandKitError(
                    f"品牌 Logo 缺失: {variant}",
                    code="BRAND_LOGO_NOT_FOUND",
                    status_code=409,
                )
            if hashlib.sha256(source.read_bytes()).hexdigest() != record.get("sha256"):
                raise BrandKitError(
                    f"品牌 Logo 校验失败: {variant}",
                    code="BRAND_LOGO_HASH_MISMATCH",
                    status_code=409,
                )
            target_relative = f"assets/{record['assetId']}.webp"
            target = staging / target_relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            record["path"] = target_relative
        _atomic_write(staging / "brand.json", immutable)
        os.rename(staging, version_directory)
    except BrandKitError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise BrandKitError(
            "品牌套件版本写入失败",
            code="BRAND_KIT_WRITE_FAILED",
            status_code=500,
        ) from exc
    draft["latestVersion"] = version
    draft["updatedAt"] = _now()
    _atomic_write(directory / "draft.json", draft)
    return immutable


def read_brand_version(root: Path | str, kit_id: str, version: int) -> dict[str, Any]:
    brand = _read(
        _kit_directory(root, kit_id) / "versions" / f"v{int(version)}" / "brand.json"
    )
    hash_payload = {
        key: value
        for key, value in brand.items()
        if key not in {"createdAt", "updatedAt", "lockedAt", "snapshotHash"}
    }
    expected = hashlib.sha256(
        json.dumps(hash_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    if brand.get("snapshotHash") != expected:
        raise BrandKitError(
            "品牌套件版本校验失败", code="BRAND_KIT_SNAPSHOT_INVALID", status_code=409
        )
    return brand


def apply_brand_kit(
    style: Mapping[str, Any],
    brand: Mapping[str, Any],
) -> dict[str, Any]:
    result = copy.deepcopy(dict(style))
    for field in brand.get("lockedFields") or []:
        value = _path_value(brand, str(field))
        if value is not None:
            _set_path(result, str(field), value)
    result["brandKit"] = {
        "id": brand["id"],
        "version": int(brand["version"]),
        "name": brand["name"],
        "lockedFields": list(brand.get("lockedFields") or []),
        "snapshotHash": brand.get("snapshotHash"),
    }
    return result


def materialize_brand_assets(
    root: Path | str,
    brand: Mapping[str, Any],
    series_directory: Path,
) -> dict[str, Any]:
    result = copy.deepcopy(dict(brand))
    kit_id = str(result.get("id") or "")
    version = int(result.get("version") or 0)
    logo = ((result.get("brand") or {}).get("logo") or {})
    for variant, record in logo.items():
        if not isinstance(record, dict) or not record.get("assetId"):
            continue
        source = (
            _kit_directory(root, kit_id)
            / "versions"
            / f"v{version}"
            / str(record.get("path") or "")
        )
        if not source.is_file():
            raise BrandKitError(
                f"品牌 Logo 缺失: {variant}", code="BRAND_LOGO_NOT_FOUND", status_code=409
            )
        if hashlib.sha256(source.read_bytes()).hexdigest() != record.get("sha256"):
            raise BrandKitError(
                f"品牌 Logo 校验失败: {variant}",
                code="BRAND_LOGO_HASH_MISMATCH",
                status_code=409,
            )
        asset_id = str(record["assetId"])
        relative = f"draft/assets/{asset_id}.webp"
        target = series_directory / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        metadata = {
            "schemaVersion": 1,
            "assetId": asset_id,
            "sha256": record.get("sha256"),
            "mimeType": "image/webp",
            "format": "WEBP",
            "path": relative,
            "width": record.get("width"),
            "height": record.get("height"),
            "bytes": target.stat().st_size,
            "originalName": record.get("originalName"),
            "sourceType": "user-upload",
            "rightsStatus": record.get("rightsStatus") or "unknown",
            "commercialUse": bool(record.get("commercialUse")),
            "createdAt": _now(),
        }
        _atomic_write(series_directory / "draft" / "assets" / f"{asset_id}.json", metadata)
        record["path"] = relative
    return result


def enforce_brand_binding(
    root: Path | str,
    style: Mapping[str, Any],
) -> dict[str, Any]:
    binding = style.get("brandKit")
    if not isinstance(binding, Mapping):
        return copy.deepcopy(dict(style))
    kit_id = str(binding.get("id") or "")
    try:
        version = int(binding.get("version") or 0)
    except (TypeError, ValueError) as exc:
        raise BrandKitError(
            "品牌套件绑定版本无效", code="BRAND_KIT_BINDING_INVALID"
        ) from exc
    brand = read_brand_version(root, kit_id, version)
    if binding.get("snapshotHash") != brand.get("snapshotHash"):
        raise BrandKitError(
            "品牌套件绑定哈希无效", code="BRAND_KIT_BINDING_INVALID", status_code=409
        )
    def locked_value_matches(field: str) -> bool:
        actual = _path_value(style, field)
        expected = _path_value(brand, field)
        if field.startswith("brand.logo.") and isinstance(actual, Mapping) and isinstance(
            expected, Mapping
        ):
            actual_without_path = {
                key: value for key, value in actual.items() if key not in {"path", "assetPath"}
            }
            expected_without_path = {
                key: value for key, value in expected.items() if key not in {"path", "assetPath"}
            }
            asset_id = str(expected.get("assetId") or "")
            allowed_paths = {
                f"assets/{asset_id}.webp",
                f"draft/assets/{asset_id}.webp",
            }
            actual_paths = {
                str(actual.get(key))
                for key in ("path", "assetPath")
                if actual.get(key)
            }
            return (
                actual_without_path == expected_without_path
                and bool(actual_paths)
                and actual_paths.issubset(allowed_paths)
            )
        return actual == expected

    changed = [
        str(field)
        for field in brand.get("lockedFields") or []
        if not locked_value_matches(str(field))
    ]
    if changed:
        raise BrandKitError(
            "品牌套件锁定字段不可修改: " + ", ".join(changed),
            code="BRAND_FIELDS_LOCKED",
            status_code=409,
        )
    normalized = copy.deepcopy(dict(style))
    normalized["brandKit"] = {
        "id": brand["id"],
        "version": int(brand["version"]),
        "name": brand["name"],
        "lockedFields": list(brand.get("lockedFields") or []),
        "snapshotHash": brand["snapshotHash"],
    }
    return normalized


__all__ = [
    "BRAND_LOCKABLE_FIELDS",
    "BrandKitError",
    "apply_brand_kit",
    "brand_kits_directory",
    "create_brand_kit",
    "enforce_brand_binding",
    "import_brand_logo",
    "list_brand_kits",
    "lock_brand_kit",
    "materialize_brand_assets",
    "read_brand_draft",
    "read_brand_version",
]
