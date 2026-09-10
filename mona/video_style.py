"""Domain services for Mona's video-series style system.

The HTTP layers deliberately do not own the on-disk format.  This module keeps
the format small and deterministic so that a locked style can be rendered years
later without consulting a mutable draft or a current template default.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from PIL import Image, ImageOps

MAX_BACKGROUND_BYTES = 20 * 1024 * 1024
SUPPORTED_BACKGROUND_FORMATS = {"PNG", "JPEG", "WEBP"}
SUPPORTED_BACKGROUND_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
STYLE_SCHEMA_VERSION = 1
SERIES_ID_MAX_LENGTH = 64

_SERIES_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$")
_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class VideoStyleError(Exception):
    """A domain error that can be mapped directly to an HTTP response."""

    status_code = 400
    code = "VIDEO_STYLE_ERROR"

    def __init__(
        self,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
        status_code: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = dict(details or {})
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        # These aliases make the error convenient for aiohttp and FastAPI
        # adapters without coupling this module to either framework.
        self.status = self.status_code
        self.http_status = self.status_code

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.details:
            payload["details"] = self.details
        return payload


class SeriesNotFoundError(VideoStyleError):
    status_code = 404
    code = "SERIES_NOT_FOUND"


class StyleVersionNotFoundError(VideoStyleError):
    status_code = 404
    code = "STYLE_VERSION_NOT_FOUND"


class BackgroundAssetNotFoundError(VideoStyleError):
    status_code = 404
    code = "BACKGROUND_ASSET_NOT_FOUND"


class RevisionConflictError(VideoStyleError):
    status_code = 409
    code = "STYLE_DRAFT_REVISION_CONFLICT"


class ImmutableStyleError(VideoStyleError):
    status_code = 409
    code = "STYLE_VERSION_IMMUTABLE"


class StyleValidationError(VideoStyleError):
    status_code = 422
    code = "STYLE_VALIDATION_FAILED"


class BackgroundAssetError(VideoStyleError):
    status_code = 400
    code = "BACKGROUND_ASSET_INVALID"


class BackgroundAssetInUseError(VideoStyleError):
    status_code = 409
    code = "BACKGROUND_ASSET_IN_USE"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    return (
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write one file using a same-directory temporary file and replace."""

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_path, path)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    _atomic_write_bytes(path, _json_bytes(payload))


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VideoStyleError(
            f"无法读取风格数据: {path.name}",
            code="STYLE_DATA_CORRUPT",
            status_code=500,
            details={"path": str(path)},
        ) from exc
    if not isinstance(value, dict):
        raise VideoStyleError(
            f"风格数据必须是对象: {path.name}",
            code="STYLE_DATA_CORRUPT",
            status_code=500,
            details={"path": str(path)},
        )
    return value


def validate_series_id(value: str) -> str:
    """Validate a path-safe persisted series id and return its lower-case form."""

    if not isinstance(value, str):
        raise VideoStyleError(
            "series id 必须是字符串",
            code="INVALID_SERIES_ID",
            details={"value": repr(value)},
        )
    candidate = value.strip().lower()
    if (
        not candidate
        or len(candidate) > SERIES_ID_MAX_LENGTH
        or candidate in {".", ".."}
        or not _SERIES_ID_RE.fullmatch(candidate)
    ):
        raise VideoStyleError(
            "series id 只能包含小写字母、数字、短横线和下划线，且必须以字母或数字开头和结尾",
            code="INVALID_SERIES_ID",
            details={"value": value},
        )
    return candidate


def safe_series_id(value: str, *, fallback_prefix: str = "series") -> str:
    """Create a safe id from a user-facing name.

    Explicit ids should use :func:`validate_series_id`; this helper is intended
    for UI-generated ids and therefore transliterates ASCII names and provides a
    stable digest fallback for names written entirely in other scripts.
    """

    if not isinstance(value, str):
        raise VideoStyleError("series 名称必须是字符串", code="INVALID_SERIES_ID")
    raw = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    candidate = re.sub(r"[^a-zA-Z0-9]+", "-", raw).strip("-").lower()
    if not candidate:
        candidate = f"{fallback_prefix}-{hashlib.sha256(value.encode('utf-8')).hexdigest()[:10]}"
    candidate = candidate[:SERIES_ID_MAX_LENGTH].strip("-_")
    if not candidate or not candidate[0].isalnum():
        candidate = f"{fallback_prefix}-{candidate}"[:SERIES_ID_MAX_LENGTH]
    return validate_series_id(candidate)


def series_directory(root: Path | str) -> Path:
    """Return the series root for either a workspace root or video_series root."""

    path = Path(root)
    return path if path.name == "video_series" else path / "video_series"


def _series_path(root: Path | str, series_id: str) -> Path:
    return series_directory(root) / validate_series_id(series_id)


def _require_series(root: Path | str, series_id: str) -> Path:
    path = _series_path(root, series_id)
    if not path.is_dir() or not (path / "series.json").is_file():
        raise SeriesNotFoundError(
            f"系列不存在: {series_id}", details={"seriesId": series_id}
        )
    return path


def _template_directory() -> Path:
    return Path(__file__).parent / "skills" / "mona-video" / "templates" / "styles"


_TEMPLATE_ALIASES = {
    "business": "minimal-business",
    "business-light": "minimal-business",
    "minimal": "minimal-business",
    "tech": "tech-dark",
    "technology-dark": "tech-dark",
    "editorial": "editorial-magazine",
    "magazine": "editorial-magazine",
    "knowledge": "knowledge-cards",
    "light-knowledge": "knowledge-cards",
}


def _canonical_template_id(template_id: str) -> str:
    value = str(template_id).strip().lower()
    return _TEMPLATE_ALIASES.get(value, value)


def _custom_template() -> dict[str, Any]:
    """Return the valid component contract used by a blank custom series."""

    template = get_builtin_template("minimal-business")
    template["id"] = "custom"
    template["name"] = "自定义"
    template["description"] = "从标准组件契约开始自定义视觉令牌。"
    template["baseTemplateId"] = "custom"
    return template


def list_builtin_templates() -> list[dict[str, Any]]:
    templates: list[dict[str, Any]] = []
    for path in sorted(_template_directory().glob("*.json")):
        templates.append(_read_json(path))
    return templates


def get_builtin_template(template_id: str) -> dict[str, Any]:
    canonical = _canonical_template_id(template_id)
    path = _template_directory() / f"{canonical}.json"
    if not path.is_file():
        raise VideoStyleError(
            f"内置风格不存在: {template_id}",
            code="STYLE_TEMPLATE_NOT_FOUND",
            status_code=404,
            details={"templateId": template_id},
        )
    template = _read_json(path)
    if template.get("id") != canonical:
        raise VideoStyleError(
            f"内置风格模板 id 不匹配: {canonical}",
            code="STYLE_TEMPLATE_INVALID",
            status_code=500,
        )
    return copy.deepcopy(template)


def _deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(base))
    for key, value in override.items():
        if (
            isinstance(value, Mapping)
            and isinstance(result.get(key), Mapping)
        ):
            result[key] = _deep_merge(result[key], value)  # type: ignore[arg-type]
        else:
            result[key] = copy.deepcopy(value)
    return result


def _draft_from_template(template: Mapping[str, Any], series_id: str) -> dict[str, Any]:
    draft = copy.deepcopy(dict(template))
    draft["schemaVersion"] = STYLE_SCHEMA_VERSION
    draft["seriesId"] = series_id
    draft.pop("version", None)
    draft["revision"] = 0
    draft["updatedAt"] = _now()
    return draft


def create_series(
    root: Path | str,
    series_id: str | None = None,
    name: str | None = None,
    *,
    template_id: str | None = "minimal-business",
    default_aspect_ratio: str = "16:9",
) -> dict[str, Any]:
    """Create a series and its revision-zero style draft."""

    if name is None:
        name = series_id or "未命名系列"
    if not isinstance(name, str) or not name.strip():
        raise VideoStyleError("系列名称不能为空", code="INVALID_SERIES_NAME")
    if series_id is None:
        series_id = safe_series_id(name)
    else:
        series_id = validate_series_id(series_id)
    if default_aspect_ratio not in {"16:9", "9:16", "1:1"}:
        raise VideoStyleError(
            "不支持的默认画面比例",
            code="INVALID_ASPECT_RATIO",
            details={"aspectRatio": default_aspect_ratio},
        )
    template = (
        _custom_template()
        if template_id is None
        or str(template_id).strip().lower() in {"", "blank", "custom", "none"}
        else get_builtin_template(template_id)
    )
    directory = _series_path(root, series_id)
    if directory.exists():
        raise VideoStyleError(
            f"系列已存在: {series_id}",
            code="SERIES_EXISTS",
            status_code=409,
            details={"seriesId": series_id},
        )
    draft = _draft_from_template(template, series_id)
    variants = draft.setdefault("aspectVariants", {})
    for aspect in ("16:9", "9:16", "1:1"):
        variant = variants.setdefault(aspect, {})
        variant["enabled"] = bool(variant.get("enabled")) or aspect == default_aspect_ratio
    series = {
        "schemaVersion": 1,
        "id": series_id,
        "name": name.strip(),
        "latestStyleVersion": 0,
        "defaultAspectRatio": default_aspect_ratio,
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    staging = directory.with_name(f".{directory.name}.creating-{os.getpid()}-{next(tempfile._get_candidate_names())}")
    try:
        (staging / "draft" / "assets").mkdir(parents=True, exist_ok=False)
        (staging / "styles").mkdir(parents=True, exist_ok=False)
        _atomic_write_json(staging / "series.json", series)
        _atomic_write_json(staging / "draft" / "style.json", draft)
        directory.parent.mkdir(parents=True, exist_ok=True)
        if directory.exists():
            raise VideoStyleError(
                f"系列已存在: {series_id}",
                code="SERIES_EXISTS",
                status_code=409,
                details={"seriesId": series_id},
            )
        os.rename(staging, directory)
    except VideoStyleError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except FileExistsError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise VideoStyleError(
            f"系列已存在: {series_id}",
            code="SERIES_EXISTS",
            status_code=409,
            details={"seriesId": series_id},
        ) from exc
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise VideoStyleError(
            f"创建系列失败: {series_id}",
            code="SERIES_WRITE_FAILED",
            status_code=500,
        ) from exc
    return copy.deepcopy(series)


def get_series(root: Path | str, series_id: str) -> dict[str, Any]:
    return _read_json(_require_series(root, series_id) / "series.json")


def list_series(
    root: Path | str, *, include_archived: bool = False
) -> list[dict[str, Any]]:
    directory = series_directory(root)
    if not directory.is_dir():
        return []
    result: list[dict[str, Any]] = []
    for child in sorted(directory.iterdir(), key=lambda item: item.name):
        if not child.is_dir() or not (child / "series.json").is_file():
            continue
        try:
            series = _read_json(child / "series.json")
            if include_archived or not series.get("archivedAt"):
                result.append(series)
        except VideoStyleError:
            continue
    return result


def update_series(
    root: Path | str,
    series_id: str,
    *,
    name: str | None = None,
    archived: bool | None = None,
) -> dict[str, Any]:
    directory = _require_series(root, series_id)
    series = _read_json(directory / "series.json")
    if name is not None:
        clean_name = str(name).strip()
        if not clean_name:
            raise VideoStyleError("系列名称不能为空", code="INVALID_SERIES_NAME")
        series["name"] = clean_name
    if archived is True:
        series["archivedAt"] = _now()
    elif archived is False:
        series.pop("archivedAt", None)
        series["restoredAt"] = _now()
    series["updatedAt"] = _now()
    _atomic_write_json(directory / "series.json", series)
    return copy.deepcopy(series)


def delete_series(root: Path | str, series_id: str) -> dict[str, Any]:
    """Delete one series directory after callers have checked project references."""

    directory = _require_series(root, series_id)
    series = _read_json(directory / "series.json")
    staging = directory.with_name(
        f".{directory.name}.deleting-{os.getpid()}-{next(tempfile._get_candidate_names())}"
    )
    try:
        os.rename(directory, staging)
        shutil.rmtree(staging)
    except OSError as exc:
        if staging.exists() and not directory.exists():
            try:
                os.rename(staging, directory)
            except OSError:
                pass
        raise VideoStyleError(
            f"删除系列失败: {series_id}",
            code="SERIES_DELETE_FAILED",
            status_code=500,
            details={"seriesId": series_id},
        ) from exc
    return series


def read_style_draft(root: Path | str, series_id: str) -> dict[str, Any]:
    path = _require_series(root, series_id) / "draft" / "style.json"
    try:
        return _read_json(path)
    except FileNotFoundError as exc:
        raise VideoStyleError(
            "系列风格草稿不存在",
            code="STYLE_DRAFT_NOT_FOUND",
            status_code=404,
            details={"seriesId": series_id},
        ) from exc


def save_style_draft(
    root: Path | str,
    series_id: str,
    style: Mapping[str, Any],
    *,
    expected_revision: int | None = None,
    allow_brand_binding_change: bool = False,
) -> dict[str, Any]:
    """Merge and atomically save a draft, incrementing its revision."""

    if not isinstance(style, Mapping):
        raise VideoStyleError("风格草稿必须是对象", code="INVALID_STYLE_DRAFT")
    directory = _require_series(root, series_id)
    current = read_style_draft(root, series_id)
    current_revision = int(current.get("revision", 0))
    incoming_revision = style.get("revision")
    if expected_revision is None and incoming_revision is not None:
        try:
            expected_revision = int(incoming_revision)
        except (TypeError, ValueError) as exc:
            raise VideoStyleError(
                "revision 必须是整数", code="INVALID_STYLE_REVISION"
            ) from exc
    if expected_revision is not None and expected_revision != current_revision:
        raise RevisionConflictError(
            "风格草稿已被其他编辑更新",
            details={
                "expectedRevision": expected_revision,
                "currentRevision": current_revision,
            },
        )
    patch = dict(style)
    patch.pop("revision", None)
    patch.pop("version", None)
    patch["seriesId"] = validate_series_id(series_id)
    saved = _deep_merge(current, patch)
    from mona.video_brand import BrandKitError, enforce_brand_binding

    try:
        current_binding = current.get("brandKit")
        saved_binding = saved.get("brandKit")

        def binding_key(value: Any) -> tuple[str, int, str] | None:
            if not isinstance(value, Mapping):
                return None
            try:
                version = int(value.get("version") or 0)
            except (TypeError, ValueError) as exc:
                raise BrandKitError(
                    "品牌套件绑定版本无效", code="BRAND_KIT_BINDING_INVALID"
                ) from exc
            return (
                str(value.get("id") or ""),
                version,
                str(value.get("snapshotHash") or ""),
            )
        if (
            not allow_brand_binding_change
            and binding_key(current_binding) != binding_key(saved_binding)
        ):
            raise BrandKitError(
                "品牌套件只能通过专用操作切换",
                code="BRAND_BINDING_CHANGE_REQUIRES_ACTION",
                status_code=409,
            )
        saved = enforce_brand_binding(root, saved)
    except BrandKitError as exc:
        raise VideoStyleError(
            str(exc), code=exc.code, status_code=exc.status_code
        ) from exc
    saved["schemaVersion"] = STYLE_SCHEMA_VERSION
    saved["revision"] = current_revision + 1
    saved["updatedAt"] = _now()
    _atomic_write_json(directory / "draft" / "style.json", saved)
    series = _read_json(directory / "series.json")
    series["updatedAt"] = _now()
    _atomic_write_json(directory / "series.json", series)
    return saved


def _color(value: Any, field: str, issues: list[dict[str, Any]]) -> None:
    if not isinstance(value, str) or not _HEX_COLOR_RE.fullmatch(value):
        issues.append({"code": "INVALID_COLOR", "field": field, "message": "必须是六位十六进制颜色"})


def _contrast_ratio(first: str, second: str) -> float:
    def channel(value: str) -> float:
        raw = int(value, 16) / 255
        return raw / 12.92 if raw <= 0.04045 else ((raw + 0.055) / 1.055) ** 2.4

    def luminance(color: str) -> float:
        return 0.2126 * channel(color[1:3]) + 0.7152 * channel(color[3:5]) + 0.0722 * channel(color[5:7])

    light, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def _contrast_foreground(color: str) -> str:
    return "#000000" if _contrast_ratio(color, "#000000") >= _contrast_ratio(color, "#FFFFFF") else "#FFFFFF"


def _mix_colors(first: str, second: str, second_weight: float) -> str:
    first_weight = 1 - second_weight
    channels = [
        round(int(first[index : index + 2], 16) * first_weight + int(second[index : index + 2], 16) * second_weight)
        for index in (1, 3, 5)
    ]
    return "#" + "".join(f"{channel:02X}" for channel in channels)


def _derive_design_system(style: Mapping[str, Any]) -> dict[str, Any]:
    """Materialize stable values that should not change with app upgrades."""

    result = copy.deepcopy(dict(style))
    tokens = result.setdefault("tokens", {})
    colors = tokens.setdefault("colors", {})
    primary, secondary, background, surface = (
        colors["primary"],
        colors["secondary"],
        colors["background"],
        colors["surface"],
    )
    colors.setdefault("primaryMuted", _mix_colors(primary, background, 0.72))
    colors.setdefault("secondaryMuted", _mix_colors(secondary, background, 0.72))
    colors.setdefault("primaryContrast", _contrast_foreground(primary))
    colors.setdefault("secondaryContrast", _contrast_foreground(secondary))
    colors.setdefault("surfaceElevated", _mix_colors(surface, background, 0.16))
    colors.setdefault("borderMuted", _mix_colors(colors["border"], background, 0.35))
    typography = tokens.setdefault("typography", {})
    typography.setdefault("headingWeight", 700)
    typography.setdefault("bodyWeight", 400)
    typography.setdefault("headingLineHeight", 1.15)
    typography.setdefault("bodyLineHeight", 1.5)
    shape = tokens.setdefault("shape", {})
    shape.setdefault("borderWidth", 1)
    shape.setdefault("shadowOpacity", 0.14)
    spacing = tokens.setdefault("spacing", {})
    unit = spacing.setdefault("unit", 8)
    spacing.setdefault("xs", unit)
    spacing.setdefault("sm", unit * 2)
    spacing.setdefault("md", unit * 3)
    spacing.setdefault("lg", unit * 5)
    motion = result.setdefault("motion", {})
    motion.setdefault("enterDurationMs", {"restrained": 420, "standard": 360, "active": 280}.get(motion.get("intensity"), 360))
    motion.setdefault("exitDurationMs", round(float(motion["enterDurationMs"]) * 0.8))
    motion.setdefault("staggerMs", {"restrained": 90, "standard": 70, "active": 50}.get(motion.get("intensity"), 70))
    motion.setdefault("transitionDurationMs", 420)
    subtitle = result.setdefault("subtitle", {})
    subtitle.setdefault("fontFamily", typography.get("bodyFamily"))
    subtitle.setdefault("fontSize", 28)
    subtitle.setdefault("lineHeight", 1.35)
    subtitle.setdefault("safeAreaBottom", 0.08)
    return result


def _iter_backgrounds(style: Mapping[str, Any]) -> Iterable[tuple[str, Mapping[str, Any]]]:
    backgrounds = style.get("backgrounds")
    if not isinstance(backgrounds, Mapping):
        return
    default = backgrounds.get("default")
    if isinstance(default, Mapping):
        yield "default", default
    roles = backgrounds.get("roles")
    if isinstance(roles, Mapping):
        for role, value in roles.items():
            if isinstance(value, Mapping):
                yield f"roles.{role}", value


def _asset_ids(value: Any) -> set[str]:
    ids: set[str] = set()
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == "assetId" and isinstance(item, str) and item:
                ids.add(item)
            ids.update(_asset_ids(item))
    elif isinstance(value, list):
        for item in value:
            ids.update(_asset_ids(item))
    return ids


def _enabled_aspects(style: Mapping[str, Any]) -> set[str]:
    variants = style.get("aspectVariants")
    if not isinstance(variants, Mapping):
        return {"16:9"}
    return {str(key) for key, value in variants.items() if isinstance(value, Mapping) and value.get("enabled", False)} or {"16:9"}


def _asset_metadata(directory: Path, asset_id: str) -> dict[str, Any] | None:
    metadata = directory / "draft" / "assets" / f"{asset_id}.json"
    if not metadata.is_file():
        return None
    try:
        return _read_json(metadata)
    except VideoStyleError:
        return None


def validate_style(
    style: Mapping[str, Any],
    root: Path | str | None = None,
    series_id: str | None = None,
) -> dict[str, Any]:
    """Return structured validation results; no exception is raised for user input."""

    issues: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if not isinstance(style, Mapping):
        return {"valid": False, "errors": [{"code": "STYLE_NOT_OBJECT", "message": "风格必须是对象"}], "warnings": []}
    if style.get("schemaVersion") != STYLE_SCHEMA_VERSION:
        issues.append({"code": "UNSUPPORTED_STYLE_SCHEMA", "field": "schemaVersion", "message": "不支持的风格 schema"})
    if style.get("mode") not in {"light", "dark", "auto"}:
        issues.append({"code": "INVALID_STYLE_MODE", "field": "mode", "message": "不支持的明暗模式"})
    tokens = style.get("tokens")
    if not isinstance(tokens, Mapping):
        issues.append({"code": "MISSING_TOKENS", "field": "tokens", "message": "缺少设计令牌"})
        tokens = {}
    colors = tokens.get("colors") if isinstance(tokens, Mapping) else {}
    if not isinstance(colors, Mapping):
        issues.append({"code": "MISSING_COLORS", "field": "tokens.colors", "message": "缺少颜色令牌"})
        colors = {}
    for name in ("primary", "secondary", "background", "surface", "textPrimary", "textSecondary", "border"):
        _color(colors.get(name), f"tokens.colors.{name}", issues)
    typography = tokens.get("typography") if isinstance(tokens, Mapping) else {}
    if not isinstance(typography, Mapping) or not typography.get("headingFamily") or not typography.get("bodyFamily"):
        issues.append({"code": "MISSING_TYPOGRAPHY", "field": "tokens.typography", "message": "缺少字体配置"})
    elif any("://" in str(typography.get(key, "")) for key in ("headingFamily", "bodyFamily")):
        issues.append({"code": "EXTERNAL_FONT_FORBIDDEN", "field": "tokens.typography", "message": "字体必须使用本地名称"})
    shape = tokens.get("shape") if isinstance(tokens, Mapping) else {}
    if not isinstance(shape, Mapping) or shape.get("cardStyle") not in {"solid", "outline", "glass", "none"}:
        issues.append({"code": "INVALID_CARD_STYLE", "field": "tokens.shape.cardStyle", "message": "不支持的卡片风格"})
    if isinstance(shape, Mapping) and (not isinstance(shape.get("cardRadius"), (int, float)) or not 0 <= float(shape["cardRadius"]) <= 48):
        issues.append({"code": "INVALID_CARD_RADIUS", "field": "tokens.shape.cardRadius", "message": "卡片圆角必须在 0 到 48 之间"})
    required_components = {"cover", "chapter", "content", "data", "comparison", "process", "quote", "outro"}
    components = style.get("components")
    if not isinstance(components, Mapping):
        issues.append({"code": "MISSING_COMPONENTS", "field": "components", "message": "缺少组件配置"})
    else:
        for role in sorted(required_components - set(components)):
            issues.append({"code": "MISSING_COMPONENT", "field": f"components.{role}", "message": f"缺少 {role} 组件"})
    motion = style.get("motion")
    if not isinstance(motion, Mapping) or motion.get("intensity") not in {"restrained", "standard", "active"}:
        issues.append({"code": "INVALID_MOTION", "field": "motion.intensity", "message": "不支持的动效强度"})
    elif not all(isinstance(motion.get(key), str) and motion.get(key) for key in ("enterPreset", "emphasisPreset", "transitionPreset")):
        issues.append({"code": "MISSING_MOTION_PRESET", "field": "motion", "message": "缺少动效预设"})
    allowed_animations = style.get("allowedAnimations")
    if isinstance(motion, Mapping) and isinstance(allowed_animations, list) and allowed_animations:
        for key in ("enterPreset", "emphasisPreset", "transitionPreset"):
            if motion.get(key) not in allowed_animations:
                issues.append({"code": "UNKNOWN_MOTION_PRESET", "field": f"motion.{key}", "message": f"动效预设未列入允许列表: {motion.get(key)}"})
    backgrounds = style.get("backgrounds")
    if not isinstance(backgrounds, Mapping) or not isinstance(backgrounds.get("default"), Mapping):
        issues.append({"code": "MISSING_BACKGROUND", "field": "backgrounds.default", "message": "缺少默认背景槽位"})
    else:
        for field, value in (("fit", backgrounds["default"].get("fit")), ("assetPolicy", backgrounds["default"].get("assetPolicy"))):
            allowed = {"cover", "contain"} if field == "fit" else {"fixed", "episode-replaceable", "none"}
            if value not in allowed:
                issues.append({"code": "INVALID_BACKGROUND_POLICY", "field": f"backgrounds.default.{field}", "message": f"不支持的背景 {field}"})
        focal = backgrounds["default"].get("focalPoint")
        if not isinstance(focal, Mapping) or not all(isinstance(focal.get(axis), (int, float)) and 0 <= float(focal[axis]) <= 1 for axis in ("x", "y")):
            issues.append({"code": "INVALID_FOCAL_POINT", "field": "backgrounds.default.focalPoint", "message": "背景焦点必须是 0 到 1 的坐标"})
        for location, slot in _iter_backgrounds(style):
            for field, value in (("fit", slot.get("fit", backgrounds["default"].get("fit"))), ("assetPolicy", slot.get("assetPolicy", backgrounds["default"].get("assetPolicy")))):
                allowed = {"cover", "contain"} if field == "fit" else {"fixed", "episode-replaceable", "none"}
                if value not in allowed:
                    issues.append({"code": "INVALID_BACKGROUND_POLICY", "field": f"{location}.{field}", "message": f"不支持的背景 {field}"})
            focal = slot.get("focalPoint")
            if focal is not None and (not isinstance(focal, Mapping) or not all(isinstance(focal.get(axis), (int, float)) and 0 <= float(focal[axis]) <= 1 for axis in ("x", "y"))):
                issues.append({"code": "INVALID_FOCAL_POINT", "field": f"{location}.focalPoint", "message": "背景焦点必须是 0 到 1 的坐标"})
    enabled = _enabled_aspects(style)
    variants = style.get("aspectVariants")
    if variants is not None and not isinstance(variants, Mapping):
        issues.append({"code": "INVALID_ASPECT_VARIANTS", "field": "aspectVariants", "message": "画面比例变体必须是对象"})
    for aspect in enabled:
        if aspect not in {"16:9", "9:16", "1:1"}:
            issues.append({"code": "INVALID_ASPECT", "field": "aspectVariants", "message": f"不支持的画面比例: {aspect}"})
    if root is not None and series_id is not None:
        directory = _require_series(root, series_id)
        for asset_id in sorted(_asset_ids(style)):
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", asset_id):
                issues.append({"code": "INVALID_BACKGROUND_ASSET_ID", "field": "backgrounds", "message": f"背景资产 id 不安全: {asset_id}"})
        for location, slot in _iter_backgrounds(style):
            asset_id = slot.get("assetId")
            if not asset_id:
                continue
            metadata = _asset_metadata(directory, str(asset_id))
            if metadata is None or not (directory / "draft" / "assets" / f"{asset_id}.webp").is_file():
                issues.append({"code": "BACKGROUND_ASSET_NOT_FOUND", "field": f"{location}.assetId", "message": f"背景资产不存在: {asset_id}"})
                continue
            width, height = int(metadata.get("width", 0)), int(metadata.get("height", 0))
            for aspect in enabled:
                target = (1920, 1080) if aspect == "16:9" else ((1080, 1920) if aspect == "9:16" else (1080, 1080))
                if width < target[0] or height < target[1]:
                    issues.append({"code": "BACKGROUND_LOW_RESOLUTION", "field": f"{location}.assetId", "message": f"背景 {asset_id} 低于 {aspect} 交付尺寸 {target[0]}x{target[1]}"})
    # Automatic contrast is conservative.  A custom foreground/background pair
    # that is too close is a hard lock error, because it makes text unreadable.
    if isinstance(colors, Mapping):
        bg, fg = colors.get("background"), colors.get("textPrimary")
        if isinstance(bg, str) and isinstance(fg, str) and _HEX_COLOR_RE.fullmatch(bg) and _HEX_COLOR_RE.fullmatch(fg):
            if _contrast_ratio(bg, fg) < 4.5:
                issues.append({"code": "INSUFFICIENT_CONTRAST", "field": "tokens.colors.textPrimary", "message": "正文与背景对比度不足"})
    return {"valid": not issues, "errors": issues, "warnings": warnings}


def _style_asset_path(directory: Path, asset_id: str) -> Path:
    metadata = _asset_metadata(directory, asset_id)
    candidate = directory / "draft" / "assets" / f"{asset_id}.webp"
    if metadata and isinstance(metadata.get("path"), str):
        stored = Path(metadata["path"])
        if stored.is_absolute() or ".." in stored.parts:
            return candidate
        candidate = directory / stored
    return candidate


def _replace_asset_paths(value: Any, asset_paths: Mapping[str, str]) -> Any:
    if isinstance(value, Mapping):
        result = {key: _replace_asset_paths(item, asset_paths) for key, item in value.items()}
        asset_id = value.get("assetId")
        if isinstance(asset_id, str) and asset_id in asset_paths:
            result["assetPath"] = asset_paths[asset_id]
        elif "assetPath" in value and isinstance(value["assetPath"], str):
            result["assetPath"] = asset_paths.get(value["assetPath"], value["assetPath"])
        return result
    if isinstance(value, list):
        return [_replace_asset_paths(item, asset_paths) for item in value]
    return value


def _theme_css(style: Mapping[str, Any]) -> str:
    tokens = style.get("tokens", {})
    lines = [":root {"]
    def walk(value: Any, prefix: list[str]) -> None:
        if isinstance(value, Mapping):
            for key in sorted(value):
                walk(value[key], prefix + [str(key)])
        elif isinstance(value, (str, int, float, bool)):
            name = "--mona-" + "-".join(re.sub(r"(?<!^)([A-Z])", r"-\1", part).lower() for part in prefix)
            lines.append(f"  {name}: {str(value).lower() if isinstance(value, bool) else value};")
    walk(tokens, [])
    lines.append("}")
    lines.append("")
    lines.append("/* Generated from an immutable Mona video style version. */")
    return "\n".join(lines) + "\n"


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _style_preview_html(style: Mapping[str, Any], role: str) -> str:
    """Compile the same production scene used by the interactive preview."""

    from mona.video_scene_compiler import compile_scene_spec

    layout = {
        "cover": "cover-split",
        "content": "content-standard",
        "data": "metric-comparison",
        "outro": "outro-brand",
    }[role]
    content: dict[str, Any] = {
        "eyebrow": "系列风格预览",
        "title": {
            "cover": "让复杂知识变得清晰",
            "content": "稳定的视觉语言",
            "data": "效率持续提升",
            "outro": "下一期见",
        }[role],
        "body": "配色、组件、背景、字幕和动效规则自动继承",
    }
    if role == "content":
        content["bullets"] = ["统一标题层级", "统一信息组件", "统一字幕安全区"]
    if role == "data":
        content["metrics"] = [
            {"value": "72%", "label": "制作效率"},
            {"value": "3.6×", "label": "内容产能"},
            {"value": "98%", "label": "风格一致"},
        ]
    spec = {
        "schemaVersion": 1,
        "sceneIndex": {"cover": 1, "content": 2, "data": 3, "outro": 4}[role],
        "role": role,
        "layout": layout,
        "backgroundSlot": role,
        "animationPreset": str(
            (_as_mapping(style.get("motion")).get("enterPreset")) or "fade-rise"
        ),
        "duration": 6,
        "start": 0,
        "content": content,
    }
    backgrounds = _as_mapping(style.get("backgrounds"))
    slot = dict(_as_mapping(backgrounds.get("default")))
    slot.update(_as_mapping(_as_mapping(backgrounds.get("roles")).get(role)))
    asset_path = str(slot.get("assetPath") or "")
    background_path = f"../{asset_path}" if asset_path.startswith("assets/") else None
    brand = _as_mapping(style.get("brand"))
    logos = _as_mapping(brand.get("logo"))
    logo = _as_mapping(logos.get("light") or logos.get("dark"))
    logo_path = str(logo.get("assetPath") or "")
    return compile_scene_spec(
        spec,
        style,
        resolution="960x540",
        background_path=background_path,
        brand_logo_path=f"../{logo_path}" if logo_path.startswith("assets/") else None,
    )


def _version_number(directory: Path) -> int:
    series = _read_json(directory / "series.json")
    current = int(series.get("latestStyleVersion", 0) or 0)
    styles = directory / "styles"
    if styles.is_dir():
        for child in styles.iterdir():
            match = re.fullmatch(r"v(\d+)", child.name)
            if match:
                current = max(current, int(match.group(1)))
    return current + 1


def _copy_version_assets(directory: Path, style: Mapping[str, Any], version_directory: Path) -> tuple[dict[str, Any], dict[str, str]]:
    normalized = copy.deepcopy(dict(style))
    ids = _asset_ids(normalized)
    asset_paths: dict[str, str] = {}
    for asset_id in sorted(ids):
        source = _style_asset_path(directory, asset_id)
        if not source.is_file():
            raise StyleValidationError("锁定风格所需背景资产不存在", details={"assetId": asset_id})
        target = version_directory / "assets" / f"{asset_id}.webp"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        metadata_source = directory / "draft" / "assets" / f"{asset_id}.json"
        if metadata_source.is_file():
            metadata = _read_json(metadata_source)
            metadata["path"] = f"assets/{asset_id}.webp"
            _atomic_write_json(
                version_directory / "assets" / f"{asset_id}.json", metadata
            )
        asset_paths[asset_id] = f"assets/{asset_id}.webp"
    return _replace_asset_paths(normalized, asset_paths), asset_paths


def lock_style(
    root: Path | str,
    series_id: str,
    *,
    expected_revision: int | None = None,
    style: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate a draft and publish one immutable ``styles/vN`` snapshot."""

    directory = _require_series(root, series_id)
    draft = read_style_draft(root, series_id)
    if style is not None:
        draft = _deep_merge(draft, style)
    from mona.video_brand import BrandKitError, enforce_brand_binding

    try:
        draft = enforce_brand_binding(root, draft)
    except BrandKitError as exc:
        raise VideoStyleError(
            str(exc), code=exc.code, status_code=exc.status_code
        ) from exc
    current_revision = int(draft.get("revision", 0))
    if expected_revision is not None and expected_revision != current_revision:
        raise RevisionConflictError(
            "风格草稿已被其他编辑更新",
            details={"expectedRevision": expected_revision, "currentRevision": current_revision},
        )
    result = validate_style(draft, root, series_id)
    if not result["valid"]:
        raise StyleValidationError("风格未通过锁定校验", details=result)
    draft = _derive_design_system(draft)
    derived_result = validate_style(draft, root, series_id)
    if not derived_result["valid"]:
        raise StyleValidationError("派生风格未通过锁定校验", details=derived_result)
    version = _version_number(directory)
    version_directory = directory / "styles" / f"v{version}"
    staging = directory / "styles" / f".v{version}.publishing-{os.getpid()}-{next(tempfile._get_candidate_names())}"
    try:
        staging.mkdir(parents=True, exist_ok=False)
        immutable, _asset_paths = _copy_version_assets(directory, draft, staging)
        immutable["schemaVersion"] = STYLE_SCHEMA_VERSION
        immutable["seriesId"] = validate_series_id(series_id)
        immutable["version"] = version
        immutable["lockedAt"] = _now()
        _atomic_write_json(staging / "design-system.json", immutable)
        _atomic_write_bytes(staging / "theme.css", _theme_css(immutable).encode("utf-8"))
        (staging / "previews").mkdir(parents=True, exist_ok=True)
        for role in ("cover", "content", "data", "outro"):
            _atomic_write_bytes(
                staging / "previews" / f"{role}.html",
                _style_preview_html(immutable, role).encode("utf-8"),
            )
        if version_directory.exists():
            raise ImmutableStyleError("风格版本已存在且不可覆盖", details={"version": version})
        os.rename(staging, version_directory)
    except VideoStyleError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except FileExistsError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise ImmutableStyleError("风格版本已存在且不可覆盖", details={"version": version}) from exc
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise VideoStyleError("写入风格版本失败", code="STYLE_VERSION_WRITE_FAILED", status_code=500) from exc
    series = _read_json(directory / "series.json")
    series["latestStyleVersion"] = version
    series["updatedAt"] = _now()
    _atomic_write_json(directory / "series.json", series)
    return read_style_version(root, series_id, version)


def read_style_version(root: Path | str, series_id: str, version: int) -> dict[str, Any]:
    directory = _require_series(root, series_id)
    try:
        return _read_json(directory / "styles" / f"v{int(version)}" / "design-system.json")
    except (FileNotFoundError, TypeError, ValueError) as exc:
        raise StyleVersionNotFoundError(
            f"风格版本不存在: v{version}", details={"seriesId": series_id, "version": version}
        ) from exc


def list_style_versions(root: Path | str, series_id: str) -> list[dict[str, Any]]:
    directory = _require_series(root, series_id) / "styles"
    if not directory.is_dir():
        return []
    versions: list[dict[str, Any]] = []
    for child in sorted(directory.iterdir(), key=lambda item: item.name):
        match = re.fullmatch(r"v(\d+)", child.name)
        if match and (child / "design-system.json").is_file():
            versions.append(_read_json(child / "design-system.json"))
    return versions


def create_style_draft_from_version(
    root: Path | str, series_id: str, version: int
) -> dict[str, Any]:
    """Start a mutable draft from an immutable version without altering it."""

    locked = read_style_version(root, series_id, version)
    draft = copy.deepcopy(locked)
    draft.pop("version", None)
    draft.pop("lockedAt", None)
    draft["revision"] = 0
    draft["updatedAt"] = _now()
    directory = _require_series(root, series_id)
    # A draft must be independently editable. Copy immutable background
    # snapshots back into draft/assets so a later v2 lock does not depend on
    # the old version directory.
    version_directory = directory / "styles" / f"v{int(version)}"
    for asset_id in sorted(_asset_ids(locked)):
        source = version_directory / "assets" / f"{asset_id}.webp"
        if not source.is_file():
            raise StyleValidationError(
                "风格版本缺少背景快照",
                details={"assetId": asset_id, "version": int(version)},
            )
        data = source.read_bytes()
        _atomic_write_bytes(directory / "draft" / "assets" / f"{asset_id}.webp", data)
        try:
            with Image.open(source) as image:
                width, height = image.size
        except (OSError, ValueError) as exc:
            raise StyleValidationError(
                "风格版本背景快照无法解码",
                details={"assetId": asset_id, "version": int(version)},
            ) from exc
        version_metadata = version_directory / "assets" / f"{asset_id}.json"
        if version_metadata.is_file():
            restored_metadata = _read_json(version_metadata)
            restored_metadata["path"] = f"draft/assets/{asset_id}.webp"
        else:
            restored_metadata = {
                "schemaVersion": 1,
                "assetId": asset_id,
                "sha256": hashlib.sha256(data).hexdigest(),
                "mimeType": "image/webp",
                "format": "WEBP",
                "path": f"draft/assets/{asset_id}.webp",
                "width": width,
                "height": height,
                "bytes": len(data),
                "originalName": f"{asset_id}.webp",
                "createdAt": _now(),
                "sourceType": "user-upload",
                "rightsStatus": "unknown",
                "commercialUse": False,
            }
        _atomic_write_json(
            directory / "draft" / "assets" / f"{asset_id}.json",
            restored_metadata,
        )
    _atomic_write_json(directory / "draft" / "style.json", draft)
    series = _read_json(directory / "series.json")
    series["updatedAt"] = _now()
    _atomic_write_json(directory / "series.json", series)
    return draft


def import_background_asset(
    root: Path | str,
    series_id: str,
    source_path: Path | str,
    *,
    asset_id: str | None = None,
    source_type: str = "user-upload",
    rights_status: str = "unknown",
    license_name: str = "",
) -> dict[str, Any]:
    """Decode, orient, metadata-strip and transcode a local image to WebP."""

    from mona.video_assets import ASSET_RIGHTS_STATUSES, ASSET_SOURCE_TYPES

    if source_type not in ASSET_SOURCE_TYPES:
        raise BackgroundAssetError("背景来源类型无效", code="BACKGROUND_SOURCE_INVALID")
    if rights_status not in ASSET_RIGHTS_STATUSES:
        raise BackgroundAssetError("背景权利状态无效", code="BACKGROUND_RIGHTS_INVALID")
    commercial_use = rights_status not in {"unknown", "ai-generated"}
    directory = _require_series(root, series_id)
    source = Path(source_path)
    try:
        source = source.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise BackgroundAssetError("背景文件不存在", code="BACKGROUND_FILE_NOT_FOUND", status_code=404) from exc
    if not source.is_file():
        raise BackgroundAssetError("背景路径不是文件", code="BACKGROUND_FILE_NOT_FOUND", status_code=404)
    try:
        size = source.stat().st_size
    except OSError as exc:
        raise BackgroundAssetError("无法读取背景文件", code="BACKGROUND_FILE_UNREADABLE", status_code=400) from exc
    if size > MAX_BACKGROUND_BYTES:
        raise BackgroundAssetError(
            "背景图片不能超过 20 MiB", code="BACKGROUND_FILE_TOO_LARGE", status_code=413,
            details={"maxBytes": MAX_BACKGROUND_BYTES, "size": size},
        )
    if source.suffix.lower() not in SUPPORTED_BACKGROUND_EXTENSIONS:
        raise BackgroundAssetError("背景图片仅支持 PNG、JPEG 和 WebP", code="BACKGROUND_FORMAT_UNSUPPORTED")
    try:
        with Image.open(source) as probe:
            actual_format = str(probe.format or "").upper()
            if actual_format not in SUPPORTED_BACKGROUND_FORMATS:
                raise BackgroundAssetError("文件内容不是支持的图片格式", code="BACKGROUND_FORMAT_INVALID")
            probe.verify()
        with Image.open(source) as image:
            image.load()
            oriented = ImageOps.exif_transpose(image)
            if oriented.mode in {"RGBA", "LA", "PA"} or "transparency" in oriented.info:
                normalized = oriented.convert("RGBA")
            else:
                normalized = oriented.convert("RGB")
            width, height = normalized.size
            if width <= 0 or height <= 0:
                raise BackgroundAssetError("背景图片尺寸无效", code="BACKGROUND_DIMENSIONS_INVALID")
            from io import BytesIO

            output = BytesIO()
            normalized.save(output, format="WEBP", quality=92, method=6)
            data = output.getvalue()
    except BackgroundAssetError:
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise BackgroundAssetError("背景图片无法解码", code="BACKGROUND_DECODE_FAILED") from exc
    digest = hashlib.sha256(data).hexdigest()
    actual_asset_id = asset_id or f"bg-{digest[:24]}"
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", actual_asset_id):
        raise BackgroundAssetError("背景 asset id 不安全", code="INVALID_BACKGROUND_ASSET_ID")
    assets = directory / "draft" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    image_path = assets / f"{actual_asset_id}.webp"
    metadata_path = assets / f"{actual_asset_id}.json"
    if image_path.is_file() and metadata_path.is_file():
        existing = _read_json(metadata_path)
        if existing.get("sha256") == digest:
            existing.update(
                {
                    "sourceType": source_type,
                    "rightsStatus": rights_status,
                    "commercialUse": commercial_use,
                    "licenseName": str(license_name or "")[:200],
                    "rightsConfirmedAt": _now() if commercial_use else None,
                    "updatedAt": _now(),
                }
            )
            _atomic_write_json(metadata_path, existing)
            return existing
        raise BackgroundAssetError("asset id 已被其他图片占用", code="BACKGROUND_ASSET_ID_EXISTS", status_code=409)
    _atomic_write_bytes(image_path, data)
    metadata = {
        "schemaVersion": 1,
        "assetId": actual_asset_id,
        "sha256": digest,
        "mimeType": "image/webp",
        "format": "WEBP",
        "path": f"draft/assets/{actual_asset_id}.webp",
        "width": width,
        "height": height,
        "bytes": len(data),
        "originalName": source.name,
        "sourceType": source_type,
        "rightsStatus": rights_status,
        "commercialUse": commercial_use,
        "licenseName": str(license_name or "")[:200],
        "rightsConfirmedAt": _now() if commercial_use else None,
        "createdAt": _now(),
        "updatedAt": _now(),
    }
    _atomic_write_json(metadata_path, metadata)
    return metadata


def _asset_referenced(directory: Path, asset_id: str) -> bool:
    try:
        draft = read_style_draft(directory.parent.parent, directory.name)
        if asset_id in _asset_ids(draft):
            return True
    except VideoStyleError:
        pass
    for version in list_style_versions(directory.parent.parent, directory.name):
        if asset_id in _asset_ids(version):
            return True
    projects = directory.parent.parent / "video_projects"
    if projects.is_dir():
        for project in projects.iterdir():
            meta_path = project / "meta.json"
            if not meta_path.is_file():
                continue
            try:
                meta = _read_json(meta_path)
            except VideoStyleError:
                continue
            if meta.get("seriesId") != directory.name:
                continue
            bindings = meta.get("backgroundAssetIds") or {}
            if asset_id in bindings.values():
                return True
    return False


def delete_background_asset(root: Path | str, series_id: str, asset_id: str) -> dict[str, Any]:
    directory = _require_series(root, series_id)
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", asset_id or ""):
        raise BackgroundAssetNotFoundError("背景资产不存在", details={"assetId": asset_id})
    image_path = directory / "draft" / "assets" / f"{asset_id}.webp"
    metadata_path = directory / "draft" / "assets" / f"{asset_id}.json"
    if not image_path.is_file() or not metadata_path.is_file():
        raise BackgroundAssetNotFoundError("背景资产不存在", details={"assetId": asset_id})
    if _asset_referenced(directory, asset_id):
        raise BackgroundAssetInUseError(
            "背景资产仍被草稿或已锁定风格引用", details={"assetId": asset_id}
        )
    # Rename to private tombstones first, so a failed unlink never exposes a
    # half-written replacement at the public asset names.
    tombstones: list[tuple[Path, Path]] = []
    try:
        for path in (image_path, metadata_path):
            tombstone = path.with_name(f".{path.name}.deleting-{os.getpid()}-{next(tempfile._get_candidate_names())}")
            os.replace(path, tombstone)
            tombstones.append((path, tombstone))
        for _public, tombstone in tombstones:
            tombstone.unlink()
    except OSError as exc:
        for public, tombstone in reversed(tombstones):
            if tombstone.exists() and not public.exists():
                os.replace(tombstone, public)
        raise VideoStyleError("删除背景资产失败", code="BACKGROUND_DELETE_FAILED", status_code=500) from exc
    return {"assetId": asset_id, "deleted": True}


# Short aliases used by the HTTP adapters and by downstream integrations.
read_draft = read_style_draft
get_style_draft = read_style_draft
save_draft = save_style_draft
update_style_draft = save_style_draft
lock_version = lock_style
read_version = read_style_version
get_style_version = read_style_version
create_draft_from_version = create_style_draft_from_version
import_background = import_background_asset
delete_background = delete_background_asset
read_series = get_series
create_video_series = create_series
list_video_series = list_series


__all__ = [
    "BackgroundAssetError",
    "BackgroundAssetInUseError",
    "BackgroundAssetNotFoundError",
    "ImmutableStyleError",
    "RevisionConflictError",
    "SeriesNotFoundError",
    "StyleValidationError",
    "StyleVersionNotFoundError",
    "VideoStyleError",
    "MAX_BACKGROUND_BYTES",
    "create_draft_from_version",
    "create_series",
    "create_style_draft_from_version",
    "delete_background",
    "delete_background_asset",
    "delete_series",
    "create_video_series",
    "get_builtin_template",
    "get_series",
    "get_style_draft",
    "get_style_version",
    "import_background",
    "import_background_asset",
    "list_builtin_templates",
    "list_series",
    "list_style_versions",
    "lock_style",
    "lock_version",
    "read_draft",
    "read_series",
    "read_style_draft",
    "read_style_version",
    "read_version",
    "safe_series_id",
    "save_draft",
    "save_style_draft",
    "series_directory",
    "validate_series_id",
    "validate_style",
    "list_video_series",
    "update_style_draft",
    "update_series",
]
