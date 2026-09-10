"""Deterministic compiler for structured Mona video scene specifications.

The compiler is intentionally small and closed: the model chooses content and
one of the layouts declared by an immutable style, while this module owns all
HTML, CSS, animation and background treatment.
"""

from __future__ import annotations

import copy
import html
import json
import math
import re
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping
from urllib.parse import quote

ROLE_NAMES = (
    "cover",
    "chapter",
    "content",
    "data",
    "comparison",
    "process",
    "quote",
    "outro",
)

LAYOUT_ALIASES = {
    "cover-split": "cover-split",
    "cover-title-right": "cover-split",
    "cover-editorial-masthead": "cover-split",
    "cover-card-stack": "cover-split",
    "chapter-numbered": "content-standard",
    "chapter-glow": "content-standard",
    "chapter-rule": "content-standard",
    "chapter-sticker": "content-standard",
    "content-standard": "content-standard",
    "content-outline": "content-standard",
    "content-column": "content-standard",
    "content-card-grid": "content-standard",
    "metric-comparison": "metric-comparison",
    "data-metric-row": "metric-comparison",
    "metric-large-number": "metric-comparison",
    "data-editorial-stat": "metric-comparison",
    "data-pill-row": "metric-comparison",
    "comparison-columns": "comparison-columns",
    "comparison-ledger": "comparison-columns",
    "comparison-card-pair": "comparison-columns",
    "process-horizontal": "content-standard",
    "process-node-line": "content-standard",
    "process-numbered": "content-standard",
    "process-step-cards": "content-standard",
    "quote-focus": "quote-focus",
    "quote-accent": "quote-focus",
    "quote-terminal": "quote-focus",
    "quote-pull": "quote-focus",
    "quote-bubble": "quote-focus",
    "outro-brand": "outro-brand",
    "outro-editorial": "outro-brand",
    "outro-card": "outro-brand",
}

ANIMATION_NAMES = {
    "fade-rise",
    "stagger-rise",
    "soft-pulse",
    "cross-fade",
}

TEMPLATE_THEMES = {
    "tech-dark": "neon-core",
    "minimal-business": "new-guochao",
    "knowledge-cards": "idea-lab",
    "editorial-magazine": "documentary-collage",
}

_COMPONENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class SceneCompileError(Exception):
    """Stable compiler error that can be mapped to an API response."""

    status_code = 422
    status = 422
    code = "SCENE_SPEC_INVALID"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
            self.status = status_code
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.details:
            result["details"] = self.details
        return result


class SceneSpecParseError(SceneCompileError):
    code = "SCENE_SPEC_JSON_INVALID"


class SceneSpecValidationError(SceneCompileError):
    code = "SCENE_SPEC_INVALID"


class SceneStyleValidationError(SceneCompileError):
    code = "SCENE_STYLE_INVALID"


# Names used by adapters that prefer a single domain exception.
SceneCompilerError = SceneCompileError
SceneSpecError = SceneCompileError


def _error(
    message: str,
    code: str,
    *,
    path: str | None = None,
    status_code: int = 422,
) -> SceneCompileError:
    details = {"path": path} if path else None
    return SceneCompileError(message, code=code, status_code=status_code, details=details)


def _strip_json_fence(text: str) -> str:
    value = text.strip()
    if not value.startswith("```"):
        return value
    lines = value.splitlines()
    if not lines or not lines[0].lstrip().startswith("```"):
        return value
    lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


_FORBIDDEN_KEY_PARTS = (
    "html",
    "css",
    "script",
    "javascript",
    "style",
    "font",
    "color",
    "fill",
    "stroke",
    "shadow",
    "radius",
    "opacity",
    "position",
    "coordinate",
    "markup",
    "dom",
    "class",
    "href",
    "src",
    "url",
    "uri",
)


def _check_forbidden_keys(value: Any, path: str = "$") -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            key_text = str(key)
            compact = re.sub(r"[^a-z0-9]", "", key_text.lower())
            if any(part in compact for part in _FORBIDDEN_KEY_PARTS):
                raise _error(
                    f"场景规格包含未授权样式字段: {key_text}",
                    "SCENE_SPEC_FORBIDDEN_FIELD",
                    path=f"{path}.{key_text}",
                )
            _check_forbidden_keys(child, f"{path}.{key_text}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _check_forbidden_keys(child, f"{path}[{index}]")


def parse_scene_spec(text: str) -> dict[str, Any]:
    """Parse one LLM response and reject free-form presentation fields."""

    if not isinstance(text, str) or not text.strip():
        raise SceneSpecParseError("场景规格不能为空", code="SCENE_SPEC_JSON_EMPTY")
    try:
        value = json.loads(_strip_json_fence(text))
    except (TypeError, json.JSONDecodeError) as exc:
        raise SceneSpecParseError(
            "场景规格不是有效 JSON",
            details={"reason": str(exc)},
        ) from exc
    if not isinstance(value, dict):
        raise SceneSpecParseError("场景规格必须是 JSON 对象", code="SCENE_SPEC_NOT_OBJECT")
    _check_forbidden_keys(value)
    return copy.deepcopy(value)


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _canonical_layout(value: Any) -> str:
    return LAYOUT_ALIASES.get(str(value or "").strip().lower(), str(value or "").strip().lower())


def _layout_values(value: Any) -> tuple[set[str], dict[str, set[str]]]:
    """Return global layouts and optional role-specific layout sets."""

    global_values: set[str] = set()
    role_values: dict[str, set[str]] = {}

    def add_global(items: Any) -> None:
        if isinstance(items, (list, tuple, set)):
            for item in items:
                if isinstance(item, Mapping):
                    item_id = item.get("id") or item.get("name") or item.get("layout")
                else:
                    item_id = item
                if str(item_id or "").strip():
                    global_values.add(_canonical_layout(item_id))
        elif isinstance(items, str) and items.strip():
            global_values.add(_canonical_layout(items))

    if isinstance(value, Mapping):
        for key in ("allowed", "ids", "names", "list"):
            add_global(value.get(key))
        by_role = value.get("byRole") or value.get("roles")
        if isinstance(by_role, Mapping):
            for role, layouts in by_role.items():
                role_values[str(role).strip().lower()] = {
                    _canonical_layout(item)
                    for item in (layouts if isinstance(layouts, (list, tuple, set)) else [layouts])
                    if str(item).strip()
                }
        for key, config in value.items():
            if key in {"allowed", "ids", "names", "list", "byRole", "roles"}:
                continue
            canonical_key = _canonical_layout(key)
            if isinstance(config, Mapping):
                if config.get("enabled", True) is False:
                    continue
                nested = config.get("allowed") or config.get("layouts") or config.get("ids")
                key_role = str(key).strip().lower()
                if key_role in ROLE_NAMES:
                    if nested is not None:
                        role_items = nested if isinstance(nested, (list, tuple, set)) else [nested]
                        role_values[key_role] = {
                            _canonical_layout(
                                item.get("id") or item.get("name") or item.get("layout")
                                if isinstance(item, Mapping)
                                else item
                            )
                            for item in role_items
                            if str(item).strip()
                        }
                    else:
                        global_values.add(canonical_key)
                else:
                    global_values.add(canonical_key)
            elif isinstance(config, (list, tuple, set)):
                role = str(key).strip().lower()
                if role in ROLE_NAMES:
                    role_values[role] = {
                        _canonical_layout(item)
                        for item in config
                        if str(item).strip()
                    }
                else:
                    global_values.add(canonical_key)
            elif config is True:
                global_values.add(canonical_key)
    else:
        add_global(value)
    return global_values, role_values


def _allowed_layouts(style: Mapping[str, Any]) -> tuple[set[str], dict[str, set[str]]]:
    allowed, role_map = _layout_values(style.get("allowedLayouts"))
    nested_allowed, nested_roles = _layout_values(style.get("layouts"))
    allowed.update(nested_allowed)
    for role, layouts in nested_roles.items():
        role_map.setdefault(role, set()).update(layouts)
    components = style.get("components")
    if isinstance(components, Mapping):
        component_allowed, component_roles = _layout_values(components)
        allowed.update(component_allowed)
        for role, layouts in component_roles.items():
            role_map.setdefault(role, set()).update(layouts)
    if not allowed and not role_map:
        allowed = set(LAYOUT_ALIASES)
    return allowed, role_map


def _animation_values(style: Mapping[str, Any]) -> set[str]:
    values: set[str] = set()
    explicit = style.get("allowedAnimations")
    if isinstance(explicit, (list, tuple, set)):
        values.update(str(item).strip() for item in explicit if str(item).strip())
    motion = _as_mapping(style.get("motion"))
    for key in ("allowed", "allowedAnimations", "presets", "animations"):
        item = motion.get(key)
        if isinstance(item, Mapping):
            values.update(str(name).strip() for name in item if str(name).strip())
        elif isinstance(item, (list, tuple, set)):
            values.update(str(name).strip() for name in item if str(name).strip())
    for key, item in motion.items():
        if key not in {"allowed", "allowedAnimations", "presets", "animations", "intensity", "enterPreset", "emphasisPreset", "transitionPreset"}:
            if isinstance(item, Mapping) or item is True:
                values.add(str(key).strip())
    for key in ("enterPreset", "emphasisPreset", "transitionPreset"):
        item = motion.get(key)
        if isinstance(item, str) and item.strip():
            values.add(item.strip())
    return values or set(ANIMATION_NAMES)


def _background_values(style: Mapping[str, Any]) -> set[str]:
    backgrounds = _as_mapping(style.get("backgrounds"))
    roles = backgrounds.get("roles") or backgrounds.get("slots")
    if isinstance(roles, Mapping):
        return {
            str(name).strip()
            for name, value in roles.items()
            if str(name).strip() and not (isinstance(value, Mapping) and value.get("enabled") is False)
        } | ({"default"} if isinstance(backgrounds.get("default"), Mapping) else set())
    slots = {"default"} if isinstance(backgrounds.get("default"), Mapping) else set()
    slots.update(name for name in ROLE_NAMES if isinstance(backgrounds.get(name), Mapping))
    return slots or set(ROLE_NAMES)


def _validate_number(value: Any, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise _error(f"{field} 必须是数字", "SCENE_SPEC_INVALID_NUMBER", path=f"$.{field}")
    number = float(value)
    if minimum is not None and number < minimum:
        raise _error(f"{field} 不能小于 {minimum}", "SCENE_SPEC_INVALID_NUMBER", path=f"$.{field}")
    return number


def validate_scene_spec(
    spec: Mapping[str, Any],
    style: Mapping[str, Any],
    *,
    scene: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate and normalize a spec against one locked style snapshot."""

    if not isinstance(spec, Mapping):
        raise SceneSpecValidationError("场景规格必须是对象", code="SCENE_SPEC_NOT_OBJECT")
    if not isinstance(style, Mapping):
        raise SceneStyleValidationError("设计系统必须是对象")
    _check_forbidden_keys(spec)

    normalized = copy.deepcopy(dict(spec))
    schema_version = normalized.get("schemaVersion", 1)
    if schema_version != 1:
        raise _error("不支持的场景规格 schema", "SCENE_SPEC_SCHEMA_UNSUPPORTED", path="$.schemaVersion")
    normalized["schemaVersion"] = 1

    scene_index = normalized.get("sceneIndex")
    if isinstance(scene_index, bool) or not isinstance(scene_index, int) or scene_index < 1:
        raise _error("sceneIndex 必须是正整数", "SCENE_SPEC_INVALID_SCENE_INDEX", path="$.sceneIndex")
    role = str(normalized.get("role") or "").strip().lower()
    if role not in ROLE_NAMES:
        raise _error("不支持的场景角色", "SCENE_SPEC_UNSUPPORTED_ROLE", path="$.role")
    layout = _canonical_layout(normalized.get("layout"))
    allowed_layouts, role_layouts = _allowed_layouts(style)
    if layout not in allowed_layouts and not (role_layouts.get(role) and layout in role_layouts[role]):
        raise _error("布局不在当前设计系统允许列表中", "SCENE_SPEC_UNSUPPORTED_LAYOUT", path="$.layout")
    if role_layouts.get(role) and layout not in role_layouts[role]:
        raise _error("布局不适用于当前场景角色", "SCENE_SPEC_LAYOUT_ROLE_MISMATCH", path="$.layout")
    background_slot = str(normalized.get("backgroundSlot") or "").strip()
    if background_slot not in _background_values(style):
        raise _error("背景槽位不在当前设计系统允许列表中", "SCENE_SPEC_UNSUPPORTED_BACKGROUND_SLOT", path="$.backgroundSlot")
    animation = str(normalized.get("animationPreset") or "").strip()
    if animation not in _animation_values(style):
        raise _error("动效预设不在当前设计系统允许列表中", "SCENE_SPEC_UNSUPPORTED_ANIMATION", path="$.animationPreset")
    if animation not in ANIMATION_NAMES:
        raise _error("编译器不支持该动效预设", "SCENE_SPEC_ANIMATION_NOT_IMPLEMENTED", path="$.animationPreset")
    content = normalized.get("content", {})
    if not isinstance(content, (Mapping, list, str, int, float, bool)) and content is not None:
        raise _error("content 必须是 JSON 值", "SCENE_SPEC_INVALID_CONTENT", path="$.content")
    normalized["role"] = role
    normalized["layout"] = layout
    normalized["backgroundSlot"] = background_slot
    normalized["animationPreset"] = animation

    source_scene = scene or {}
    source_role = str(source_scene.get("role") or "").strip().lower()
    if source_role and role != source_role:
        raise _error(
            "场景规格不能改变已锁定的场景角色",
            "SCENE_SPEC_ROLE_CHANGED",
            path="$.role",
        )
    source_layout = _canonical_layout(source_scene.get("layout"))
    if source_layout and layout != source_layout:
        raise _error(
            "场景规格不能改变已锁定的布局",
            "SCENE_SPEC_LAYOUT_CHANGED",
            path="$.layout",
        )
    source_background = str(source_scene.get("backgroundSlot") or "").strip()
    if source_background and background_slot != source_background:
        raise _error(
            "场景规格不能改变已锁定的背景槽位",
            "SCENE_SPEC_BACKGROUND_CHANGED",
            path="$.backgroundSlot",
        )
    duration = normalized.get("duration", source_scene.get("duration", source_scene.get("durationSeconds", 5)))
    start = normalized.get("start", source_scene.get("start", source_scene.get("startSeconds", 0)))
    normalized["duration"] = _validate_number(duration, "duration", minimum=0.01)
    normalized["start"] = _validate_number(start, "start", minimum=0)
    return normalized


def _resolution(value: Any) -> tuple[int, int]:
    if isinstance(value, str):
        match = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)(?:@\d+fps)?\s*", value, re.IGNORECASE)
        if match:
            value = (int(match.group(1)), int(match.group(2)))
    if isinstance(value, Mapping):
        value = (value.get("width"), value.get("height"))
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            width, height = int(value[0]), int(value[1])
        except (TypeError, ValueError):
            width = height = 0
        if width > 0 and height > 0:
            return width, height
    raise SceneStyleValidationError("resolution 必须是有效的宽高", code="SCENE_STYLE_INVALID_RESOLUTION")


_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")
_CSS_FUNCTION_COLOR = re.compile(r"^(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\)$", re.IGNORECASE)


def _color(value: Any, field: str) -> str:
    if not isinstance(value, str) or not (_HEX_COLOR.fullmatch(value.strip()) or _CSS_FUNCTION_COLOR.fullmatch(value.strip())):
        raise SceneStyleValidationError(
            f"{field} 必须是安全的颜色值",
            code="SCENE_STYLE_INVALID_COLOR",
            details={"field": field},
        )
    return value.strip()


def _font(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or any(char in value for char in "{}<>;\"'"):
        raise SceneStyleValidationError(
            f"{field} 必须是安全的字体名称",
            code="SCENE_STYLE_INVALID_FONT",
            details={"field": field},
        )
    return value.strip()


def _tokens(style: Mapping[str, Any]) -> dict[str, Any]:
    tokens = _as_mapping(style.get("tokens"))
    colors = _as_mapping(tokens.get("colors") or style.get("colors"))
    typography = _as_mapping(tokens.get("typography") or style.get("typography"))
    shape = _as_mapping(tokens.get("shape") or style.get("shape"))
    result = {
        "primary": _color(colors.get("primary"), "tokens.colors.primary"),
        "secondary": _color(colors.get("secondary"), "tokens.colors.secondary"),
        "background": _color(colors.get("background"), "tokens.colors.background"),
        "surface": _color(colors.get("surface"), "tokens.colors.surface"),
        "textPrimary": _color(colors.get("textPrimary"), "tokens.colors.textPrimary"),
        "textSecondary": _color(colors.get("textSecondary"), "tokens.colors.textSecondary"),
        "border": _color(colors.get("border"), "tokens.colors.border"),
        "headingFamily": _font(typography.get("headingFamily"), "tokens.typography.headingFamily"),
        "bodyFamily": _font(typography.get("bodyFamily"), "tokens.typography.bodyFamily"),
    }
    radius = shape.get("cardRadius")
    if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(float(radius)) or not 0 <= float(radius) <= 96:
        raise SceneStyleValidationError("tokens.shape.cardRadius 必须是 0 到 96 的数字", code="SCENE_STYLE_INVALID_RADIUS")
    result["radius"] = _format_number(float(radius)) + "px"
    return result


def _format_number(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.6f}".rstrip("0").rstrip(".")


def _text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return fallback
    return html.escape(str(value), quote=True)


def _content(spec: Mapping[str, Any], scene: Mapping[str, Any] | None) -> dict[str, Any]:
    content = spec.get("content")
    result = dict(content) if isinstance(content, Mapping) else {}
    if scene:
        if not result.get("title") and scene.get("title") is not None:
            result["title"] = scene.get("title")
        if not result.get("body") and scene.get("visual") is not None:
            result["body"] = scene.get("visual")
    if not result.get("title") and spec.get("title") is not None:
        result["title"] = spec.get("title")
    return result


def _items(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _item_text(value: Any, key: str, fallback: str = "") -> str:
    if isinstance(value, Mapping):
        return _text(value.get(key), fallback)
    return _text(value, fallback)


def _template_theme(style: Mapping[str, Any]) -> str:
    template_id = str(style.get("baseTemplateId") or style.get("id") or "").strip()
    if template_id in TEMPLATE_THEMES:
        return TEMPLATE_THEMES[template_id]
    return "neon-core" if str(style.get("mode") or "dark") == "dark" else "idea-lab"


def _component_id(style: Mapping[str, Any], role: str) -> str:
    components = _as_mapping(style.get("components"))
    component = str(components.get(role) or role).strip().lower()
    if not _COMPONENT_ID_RE.fullmatch(component):
        raise SceneStyleValidationError(
            "场景组件 ID 无效",
            code="SCENE_STYLE_INVALID_COMPONENT",
            details={"role": role},
        )
    return component


def _template_decor(theme: str) -> str:
    decorations = {
        "neon-core": (
            '<div class="template-decor" aria-hidden="true">'
            '<i class="decor-axis"></i><i class="decor-signal"></i></div>'
        ),
        "new-guochao": (
            '<div class="template-decor" aria-hidden="true">'
            '<i class="decor-rule"></i><i class="decor-seal"></i></div>'
        ),
        "idea-lab": (
            '<div class="template-decor" aria-hidden="true">'
            '<i class="decor-band"></i><i class="decor-tab"></i></div>'
        ),
        "documentary-collage": (
            '<div class="template-decor" aria-hidden="true">'
            '<i class="decor-index"></i><i class="decor-rule"></i></div>'
        ),
    }
    return decorations[theme]


def _subtitle_markup(content: Mapping[str, Any], style: Mapping[str, Any]) -> str:
    text = _text(content.get("subtitle"))
    if not text:
        return ""
    subtitle = _as_mapping(style.get("subtitle"))
    position = str(subtitle.get("position") or "bottom-center").strip()
    if position not in {"bottom-center", "bottom-left", "top-center"}:
        raise SceneStyleValidationError(
            "字幕位置无效", code="SCENE_STYLE_INVALID_SUBTITLE_POSITION"
        )
    subtitle_style = str(subtitle.get("style") or "caption-rail").strip().lower()
    if not _COMPONENT_ID_RE.fullmatch(subtitle_style):
        raise SceneStyleValidationError(
            "字幕样式无效", code="SCENE_STYLE_INVALID_SUBTITLE_STYLE"
        )
    max_lines = subtitle.get("maxLines", 2)
    if isinstance(max_lines, bool) or not isinstance(max_lines, int) or not 1 <= max_lines <= 3:
        raise SceneStyleValidationError(
            "字幕行数无效", code="SCENE_STYLE_INVALID_SUBTITLE_LINES"
        )
    return (
        f'<div class="scene-subtitle subtitle-{position} style-{subtitle_style}" '
        f'style="--subtitle-lines:{max_lines}">{text}</div>'
    )


def _subtitle_track_markup(
    track: Mapping[str, Any], style: Mapping[str, Any]
) -> str:
    subtitle = _as_mapping(style.get("subtitle"))
    position = str(subtitle.get("position") or "bottom-center").strip()
    subtitle_style = str(subtitle.get("style") or "caption-rail").strip().lower()
    max_lines = int(subtitle.get("maxLines") or 2)
    cues: list[str] = []
    for cue_index, cue in enumerate(track.get("cues") or []):
        words = cue.get("words") if isinstance(cue, Mapping) else None
        if isinstance(words, list) and words:
            text_markup = "".join(
                f'<span class="subtitle-word" data-start-ms="{int(word["startMs"])}" '
                f'data-end-ms="{int(word["endMs"])}">{_text(word.get("text"))}</span>'
                for word in words
                if isinstance(word, Mapping)
            )
        else:
            text_markup = _text(cue.get("text") if isinstance(cue, Mapping) else "")
        active = " is-active" if cue_index == 0 else ""
        cues.append(
            f'<span class="subtitle-cue{active}" data-start-ms="{int(cue["startMs"])}" '
            f'data-end-ms="{int(cue["endMs"])}">{text_markup}</span>'
        )
    return (
        f'<div class="scene-subtitle subtitle-track subtitle-{position} style-{subtitle_style}" '
        f'style="--subtitle-lines:{max_lines}">{"".join(cues)}</div>'
    )


def _subtitle_track_script(has_track: bool) -> str:
    if not has_track:
        return ""
    return """
window.__monaApplySubtitleTime = function (timeSeconds) {
  var timeMs = Math.round(Number(timeSeconds || 0) * 1000);
  document.querySelectorAll('.subtitle-cue').forEach(function (cue) {
    var active = timeMs >= Number(cue.dataset.startMs) && timeMs < Number(cue.dataset.endMs);
    cue.classList.toggle('is-active', active);
  });
  document.querySelectorAll('.subtitle-word').forEach(function (word) {
    var active = timeMs >= Number(word.dataset.startMs) && timeMs < Number(word.dataset.endMs);
    word.classList.toggle('is-active', active);
  });
};
"""


def _metric_cards(metrics: list[Any]) -> str:
    if not metrics:
        metrics = [{"value": "—", "label": "待补充数据"}]
    cards = []
    for index, metric in enumerate(metrics):
        value = _item_text(metric, "value", "—")
        label = _item_text(metric, "label", "")
        detail = _item_text(metric, "detail", "")
        detail_markup = (
            f'<div class="metric-detail">{detail}</div>' if detail else ""
        )
        cards.append(
            f'<div class="card metric-card" data-motion-target="metric.{index}">'
            f'<div class="metric-value">{value}</div>'
            f'<div class="metric-label">{label}</div>'
            f"{detail_markup}</div>"
        )
    return "".join(cards)


def _bullet_list(values: list[Any]) -> str:
    if not values:
        return ""
    return '<ul class="bullet-list">' + "".join(
        f'<li data-motion-target="item.{index} step.{index}">'
        f"{_item_text(item, 'text', str(item) if not isinstance(item, Mapping) else '')}</li>"
        for index, item in enumerate(values)
    ) + "</ul>"


def _layout_markup(
    layout: str,
    content: Mapping[str, Any],
    style: Mapping[str, Any],
    scene: Mapping[str, Any] | None,
    brand_logo_path: str | Path | None = None,
    brand_logo_data_uri: str | None = None,
) -> str:
    eyebrow = _text(content.get("eyebrow") or content.get("label"))
    title = _text(content.get("title"), "未命名场景")
    body = _text(content.get("body") or content.get("description") or content.get("text"))
    bullets = _bullet_list(_items(content.get("bullets") or content.get("items")))

    if layout == "cover-split":
        visual = _text(content.get("visual") or content.get("highlight") or content.get("subtitle"), "系列主题")
        return (
            '<div class="scene-content cover-copy"><div class="eyebrow">'
            f'{eyebrow}</div><h1 data-motion-target="title">{title}</h1>'
            f'<p class="lede" data-motion-target="body">{body}</p></div>'
            '<div class="scene-visual cover-visual" data-motion-target="visual"><div class="visual-orbit"></div>'
            f"<div class=\"visual-label\">{visual}</div></div>"
        )
    if layout == "content-standard":
        return (
            '<div class="scene-content content-copy"><div class="eyebrow">'
            f'{eyebrow}</div><h1 data-motion-target="title">{title}</h1>'
            f'<p data-motion-target="body">{body}</p>{bullets}</div>'
        )
    if layout == "metric-comparison":
        metrics = _items(content.get("metrics"))
        return (
            '<div class="scene-content metric-copy"><div class="eyebrow">'
            f'{eyebrow}</div><h1 data-motion-target="title">{title}</h1>'
            f'<p data-motion-target="body">{body}</p></div>'
            f'<div class="metric-grid">{_metric_cards(metrics)}</div>'
        )
    if layout == "comparison-columns":
        left = _as_mapping(content.get("left"))
        right = _as_mapping(content.get("right"))
        left_title = _text(left.get("title") or content.get("leftTitle"), "现状")
        right_title = _text(right.get("title") or content.get("rightTitle"), "改造后")
        left_body = _text(left.get("body") or content.get("leftBody"))
        right_body = _text(right.get("body") or content.get("rightBody"))
        left_items = _bullet_list(_items(left.get("items") or content.get("leftItems")))
        right_items = _bullet_list(_items(right.get("items") or content.get("rightItems")))
        return (
            '<div class="scene-content comparison-copy"><div class="eyebrow">'
            f'{eyebrow}</div><h1 data-motion-target="title">{title}</h1>'
            f'<p data-motion-target="body">{body}</p></div>'
            '<div class="comparison-grid"><div class="card comparison-card" data-motion-target="comparison.0"><h2>'
            f"{left_title}</h2><p>{left_body}</p>{left_items}</div>"
            '<div class="card comparison-card emphasis" data-motion-target="comparison.1"><h2>'
            f"{right_title}</h2><p>{right_body}</p>{right_items}</div></div>"
        )
    if layout == "quote-focus":
        quote = _text(content.get("quote") or content.get("text") or body, "请输入引用")
        author = _text(content.get("author") or content.get("source"))
        return (
            '<div class="scene-content quote-copy"><div class="eyebrow">'
            f'{eyebrow}</div><blockquote data-motion-target="body">{quote}</blockquote>'
            f"{('<cite>— ' + author + '</cite>') if author else ''}</div>"
        )
    if layout == "outro-brand":
        brand = _text(
            content.get("brand")
            or content.get("seriesName")
            or _as_mapping(style.get("brand")).get("displayName"),
            "Mona",
        )
        summary = _text(content.get("summary") or body)
        logo_record = _as_mapping(
            _as_mapping(_as_mapping(style.get("brand")).get("logo")).get(
                "light" if str(style.get("mode") or "dark") == "dark" else "dark"
            )
            or _as_mapping(_as_mapping(style.get("brand")).get("logo")).get("dark")
            or _as_mapping(_as_mapping(style.get("brand")).get("logo")).get("light")
        )
        logo_path = (
            _safe_image_data_uri(brand_logo_data_uri)
            if brand_logo_data_uri
            else (_safe_relative_path(brand_logo_path) if brand_logo_path else "")
        )
        logo_markup = (
            f'<img class="brand-logo" src="{logo_path}" '
            f'alt="{html.escape(str(logo_record.get("alt") or brand))}">'
            if logo_path
            else ""
        )
        return (
            '<div class="scene-content outro-copy"><div class="brand-mark" data-motion-target="brand">'
            f'{logo_markup}<span>{brand}</span></div><h1 data-motion-target="title">{title}</h1>'
            f'<p data-motion-target="body">{summary}</p></div>'
        )
    raise _error("编译器不支持该布局", "SCENE_SPEC_LAYOUT_NOT_IMPLEMENTED", path="$.layout")


def _background_slot(style: Mapping[str, Any], slot_name: str) -> Mapping[str, Any]:
    backgrounds = _as_mapping(style.get("backgrounds"))
    default = _as_mapping(backgrounds.get("default"))
    roles = _as_mapping(backgrounds.get("roles") or backgrounds.get("slots"))
    selected = _as_mapping(roles.get(slot_name) or backgrounds.get(slot_name))
    if selected.get("inherit") == "default":
        merged = dict(default)
        merged.update(selected)
        return merged
    return selected or default


def _safe_relative_path(value: Any) -> str:
    if value is None or not str(value).strip():
        return ""
    raw = str(value).strip().replace("\\", "/")
    if (
        raw.startswith(("/", "\\"))
        or re.match(r"^[A-Za-z]:", raw)
        or "://" in raw
        or raw.startswith(("data:", "javascript:"))
        or any(char in raw for char in ('"', "'", "(", ")", "\r", "\n", "\x00"))
    ):
        raise SceneCompileError("背景路径必须是本地相对路径", code="SCENE_BACKGROUND_PATH_INVALID")
    # Keep a leading ../ usable for a scene under scenes/, but do not permit an
    # unbounded traversal chain or a hidden absolute path.
    parts = PurePosixPath(raw).parts
    if sum(part == ".." for part in parts) > 2 or not parts:
        raise SceneCompileError("背景路径不是安全的相对路径", code="SCENE_BACKGROUND_PATH_INVALID")
    return quote(raw, safe="/._-~")


def _safe_image_data_uri(value: str) -> str:
    raw = str(value or "")
    if len(raw) > 15 * 1024 * 1024 or not re.fullmatch(
        r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+", raw
    ):
        raise SceneCompileError(
            "品牌 Logo 预览数据无效", code="SCENE_BRAND_LOGO_DATA_INVALID"
        )
    return raw


def _asset_media_markup(assets: Iterable[Mapping[str, Any]] | None) -> str:
    visual_assets = [
        asset
        for asset in assets or []
        if str(asset.get("kind") or "").lower() == "image"
        and str(asset.get("path") or "").strip()
    ]
    if not visual_assets:
        return ""
    asset = visual_assets[0]
    path = _safe_relative_path(asset.get("path"))
    alt = html.escape(str(asset.get("alt") or asset.get("originalName") or "场景素材"))
    return (
        '<figure class="scene-media" data-motion-target="visual">'
        f'<img src="{path}" alt="{alt}" loading="eager" decoding="sync">'
        "</figure>"
    )


def _background_css(
    style: Mapping[str, Any],
    slot_name: str,
    background_path: str | Path | None,
) -> str:
    slot = _background_slot(style, slot_name)
    path_value = background_path if background_path is not None else slot.get("assetPath")
    path = _safe_relative_path(path_value)
    focal = _as_mapping(slot.get("focalPoint"))
    x = focal.get("x", 0.5)
    y = focal.get("y", 0.5)
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not 0 <= float(x) <= 1:
        raise SceneStyleValidationError("背景 focalPoint.x 无效", code="SCENE_STYLE_INVALID_FOCAL_POINT")
    if isinstance(y, bool) or not isinstance(y, (int, float)) or not 0 <= float(y) <= 1:
        raise SceneStyleValidationError("背景 focalPoint.y 无效", code="SCENE_STYLE_INVALID_FOCAL_POINT")
    overlay = _as_mapping(slot.get("overlay"))
    token_colors = _as_mapping(_as_mapping(style.get("tokens")).get("colors") or style.get("colors"))
    overlay_color = overlay.get("color") or token_colors.get("background")
    overlay_color = _color(overlay_color, "backgrounds.overlay.color")
    opacity = overlay.get("opacity", 0)
    if isinstance(opacity, bool) or not isinstance(opacity, (int, float)) or not 0 <= float(opacity) <= 1:
        raise SceneStyleValidationError("背景 overlay.opacity 无效", code="SCENE_STYLE_INVALID_OVERLAY")
    overlay_type = str(overlay.get("type") or "solid").strip().lower()
    if overlay_type == "linear-gradient":
        direction = str(overlay.get("direction") or "left-to-right").strip().lower()
        direction_map = {
            "left-to-right": "to right",
            "right-to-left": "to left",
            "top-to-bottom": "to bottom",
            "bottom-to-top": "to top",
            "diagonal": "135deg",
        }
        css_direction = direction_map.get(direction, "to right")
        overlay_css = f"linear-gradient({css_direction}, {overlay_color}, {overlay_color})"
    else:
        overlay_css = overlay_color
    fit = str(slot.get("fit") or "cover").strip().lower()
    if fit not in {"cover", "contain"}:
        raise SceneStyleValidationError("背景 fit 无效", code="SCENE_STYLE_INVALID_BACKGROUND_FIT")
    blur = slot.get("blur", 0)
    if isinstance(blur, bool) or not isinstance(blur, (int, float)) or not 0 <= float(blur) <= 32:
        raise SceneStyleValidationError("背景 blur 无效", code="SCENE_STYLE_INVALID_BACKGROUND_BLUR")
    tint = slot.get("tint", 0)
    if isinstance(tint, bool) or not isinstance(tint, (int, float)) or not 0 <= float(tint) <= 1:
        raise SceneStyleValidationError("背景 tint 无效", code="SCENE_STYLE_INVALID_BACKGROUND_TINT")
    image_css = f'background-image: url("{path}");' if path else ""
    background_color = "var(--mona-bg)" if path else "transparent"
    return (
        image_css
        +
        f"background-color: {background_color};background-size: {fit};"
        f"background-position: {_format_number(float(x) * 100)}% {_format_number(float(y) * 100)}%;"
        f"--mona-bg-blur: {_format_number(float(blur))}px;"
        f"--mona-bg-tint: {_format_number(float(tint))};"
        f"--mona-overlay: {overlay_css};--mona-overlay-opacity: {_format_number(float(opacity))};"
    )


def _motion_script(animation: str) -> str:
    selectors = {
        "fade-rise": "timeline.fromTo('.scene-content, .scene-visual', {opacity: 0, y: 24}, {opacity: 1, y: 0, duration: 0.6, ease: 'power2.out'});",
        "stagger-rise": "timeline.fromTo('.scene-content > *, .scene-visual, .card, .bullet-list li', {opacity: 0, y: 18}, {opacity: 1, y: 0, duration: 0.45, stagger: 0.08, ease: 'power2.out'});",
        "soft-pulse": "timeline.fromTo('.accent, .visual-orbit, .brand-mark', {scale: 1}, {scale: 1.04, duration: 0.7, repeat: 1, yoyo: true, ease: 'sine.inOut'});",
        "cross-fade": "timeline.fromTo('.scene-content, .scene-visual', {opacity: 0}, {opacity: 1, duration: 0.7, ease: 'power1.inOut'});",
    }
    return selectors[animation]


def _motion_plan_script(plan: Mapping[str, Any]) -> str:
    lines: list[str] = []
    for beat in plan.get("beats") or []:
        target = str(beat["target"])
        selector = json.dumps(f'[data-motion-target~="{target}"]')
        start = _format_number(float(beat["startMs"]) / 1000)
        duration = max(0.05, (float(beat["endMs"]) - float(beat["startMs"])) / 1000)
        duration_text = _format_number(duration)
        effect = str(beat["effect"])
        intensity = str(beat.get("intensity") or "standard")
        distance = {"restrained": 12, "standard": 24, "active": 36}.get(
            intensity, 24
        )
        if effect == "fade-rise":
            line = (
                f"timeline.fromTo({selector}, {{opacity:0,y:{distance}}}, "
                f"{{opacity:1,y:0,duration:{duration_text},ease:'power2.out'}}, {start});"
            )
        elif effect == "stagger-rise":
            line = (
                f"timeline.fromTo({selector}, {{opacity:0,y:{distance}}}, "
                f"{{opacity:1,y:0,duration:{duration_text},stagger:0.08,ease:'power2.out'}}, {start});"
            )
        elif effect == "soft-pulse":
            half = _format_number(max(0.05, duration / 2))
            line = (
                f"timeline.fromTo({selector}, {{scale:1}}, "
                f"{{scale:1.04,duration:{half},repeat:1,yoyo:true,ease:'sine.inOut'}}, {start});"
            )
        elif effect == "draw-line":
            line = (
                f"timeline.fromTo({selector}, {{opacity:0,scale:0.85}}, "
                f"{{opacity:1,scale:1,duration:{duration_text},ease:'power2.out'}}, {start});"
            )
        else:
            line = (
                f"timeline.fromTo({selector}, {{opacity:0}}, "
                f"{{opacity:1,duration:{duration_text},ease:'power1.inOut'}}, {start});"
            )
        lines.append(line)
    return "\n    ".join(lines)


def _theme_css(theme: str, width: int, height: int) -> str:
    scale = max(1, round(width / 960, 3))
    themes = {
        "neon-core": f"""
.template-neon-core {{ background-image: radial-gradient(circle at 82% 24%, color-mix(in srgb, var(--mona-primary) 18%, transparent), transparent 34%), linear-gradient(145deg, #070b18 0%, var(--mona-bg) 62%, #0c1428 100%); }}
.template-neon-core::after {{ content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 36%; z-index: 0; border-left: 1px solid color-mix(in srgb, var(--mona-secondary) 22%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--mona-primary) 8%, transparent), transparent 72%); }}
.template-neon-core .decor-axis {{ position: absolute; left: 6.5%; top: 8%; bottom: 8%; width: 1px; background: color-mix(in srgb, var(--mona-secondary) 54%, transparent); }}
.template-neon-core .decor-signal {{ position: absolute; top: 8%; right: 7%; width: 9%; height: {max(2, round(2 * scale))}px; background: var(--mona-secondary); box-shadow: calc(-1 * {round(18 * scale)}px) 0 0 color-mix(in srgb, var(--mona-primary) 78%, transparent); }}
.template-neon-core .card, .template-neon-core .cover-visual {{ border: 1px solid color-mix(in srgb, var(--mona-secondary) 38%, var(--mona-border)); background: linear-gradient(145deg, color-mix(in srgb, var(--mona-surface) 94%, transparent), color-mix(in srgb, var(--mona-primary) 5%, var(--mona-surface))); box-shadow: 0 {round(18 * scale)}px {round(48 * scale)}px rgba(0,0,0,.28); }}
.template-neon-core h1 {{ letter-spacing: -.015em; }}
.template-neon-core .eyebrow {{ color: var(--mona-secondary); }}
.template-neon-core .metric-value {{ color: var(--mona-secondary); }}
.template-neon-core .visual-orbit {{ position: relative; width: 72%; aspect-ratio: 1.55; border: 1px solid var(--mona-secondary); border-radius: {round(8 * scale)}px; background: linear-gradient(90deg, color-mix(in srgb, var(--mona-secondary) 8%, transparent), transparent); }}
.template-neon-core .visual-orbit::before {{ content: ""; position: absolute; left: 10%; right: 10%; top: 24%; height: 1px; background: color-mix(in srgb, var(--mona-secondary) 52%, transparent); box-shadow: 0 {round(28 * scale)}px 0 color-mix(in srgb, var(--mona-primary) 42%, transparent), 0 {round(56 * scale)}px 0 color-mix(in srgb, var(--mona-secondary) 28%, transparent); }}
.template-neon-core .visual-label {{ right: 18%; bottom: 28%; }}
""",
        "new-guochao": f"""
.template-new-guochao {{ background-image: linear-gradient(120deg, rgba(121,87,48,.045) 0 1px, transparent 1px), linear-gradient(145deg, #f6eddd, var(--mona-bg)); background-size: {round(72 * scale)}px 100%, auto; color: var(--mona-text-primary); }}
.template-new-guochao::after {{ content: ""; position: absolute; left: 6.5%; right: 6.5%; bottom: 8%; height: 1px; background: color-mix(in srgb, var(--mona-secondary) 42%, transparent); pointer-events: none; z-index: 0; }}
.template-new-guochao .decor-rule {{ position: absolute; left: 6.5%; top: 8%; bottom: 8%; width: {max(2, round(3 * scale))}px; background: var(--mona-secondary); }}
.template-new-guochao .decor-seal {{ position: absolute; right: 7%; top: 8%; width: 5.5%; aspect-ratio: 1; background: var(--mona-primary); opacity: .9; }}
.template-new-guochao h1 {{ color: var(--mona-primary); letter-spacing: .025em; }}
.template-new-guochao .eyebrow {{ display: inline-block; padding-bottom: .35em; color: var(--mona-secondary); border-bottom: 1px solid color-mix(in srgb, var(--mona-secondary) 58%, transparent); }}
.template-new-guochao .card, .template-new-guochao .cover-visual {{ background: color-mix(in srgb, var(--mona-surface) 94%, #fff); border: 1px solid color-mix(in srgb, var(--mona-secondary) 48%, var(--mona-border)); border-radius: 2px; box-shadow: 0 {round(14 * scale)}px {round(34 * scale)}px rgba(65,42,18,.13); }}
.template-new-guochao .metric-value {{ color: var(--mona-primary); }}
.template-new-guochao blockquote {{ color: var(--mona-primary); }}
""",
        "idea-lab": f"""
.template-idea-lab {{ background-image: linear-gradient(150deg, #f8f5ed 0%, var(--mona-bg) 58%, #eef3f8 100%); }}
.template-idea-lab::after {{ content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 31%; background: color-mix(in srgb, var(--mona-primary) 5%, transparent); z-index: 0; }}
.template-idea-lab .decor-band {{ position: absolute; left: 6.5%; right: 6.5%; top: 8%; height: {max(2, round(2 * scale))}px; background: color-mix(in srgb, var(--mona-primary) 62%, transparent); }}
.template-idea-lab .decor-tab {{ position: absolute; right: 7%; top: 8%; width: 8%; height: 6%; background: var(--mona-secondary); opacity: .92; }}
.template-idea-lab h1 {{ color: var(--mona-primary); letter-spacing: -.01em; }}
.template-idea-lab .card, .template-idea-lab .cover-visual {{ border: 1px solid color-mix(in srgb, var(--mona-border) 72%, var(--mona-primary)); background: color-mix(in srgb, var(--mona-surface) 96%, #fff); box-shadow: 0 {round(14 * scale)}px {round(36 * scale)}px rgba(35,50,80,.12); }}
.template-idea-lab .metric-card:nth-child(2n) {{ border-top: {max(2, round(3 * scale))}px solid var(--mona-secondary); }}
.template-idea-lab .visual-orbit {{ position: relative; width: 72%; aspect-ratio: 1.5; border: 0; border-radius: {round(10 * scale)}px; background: linear-gradient(90deg, var(--mona-surface) 0 48%, transparent 48% 52%, var(--mona-surface) 52%); box-shadow: 0 {round(10 * scale)}px {round(24 * scale)}px rgba(35,50,80,.12); }}
.template-idea-lab .visual-orbit::before {{ content: ""; position: absolute; left: 8%; top: 15%; width: 27%; height: {max(3, round(4 * scale))}px; background: var(--mona-primary); box-shadow: 0 {round(24 * scale)}px 0 color-mix(in srgb, var(--mona-primary) 28%, transparent), 0 {round(48 * scale)}px 0 color-mix(in srgb, var(--mona-primary) 16%, transparent); }}
.template-idea-lab .visual-label {{ right: 18%; bottom: 28%; }}
""",
        "documentary-collage": f"""
.template-documentary-collage {{ background-image: linear-gradient(145deg, #171716 0%, var(--mona-bg) 66%, #20201d 100%); }}
.template-documentary-collage::after {{ content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), rgba(255,255,255,.035) calc(25% - 1px) 25%); z-index: 0; }}
.template-documentary-collage .decor-index {{ position: absolute; left: 6.5%; top: 8%; width: {max(5, round(6 * scale))}px; height: 18%; background: var(--mona-primary); }}
.template-documentary-collage .decor-rule {{ position: absolute; left: 6.5%; right: 6.5%; bottom: 8%; height: 1px; background: rgba(255,255,255,.22); }}
.template-documentary-collage h1 {{ letter-spacing: -.025em; }}
.template-documentary-collage .eyebrow {{ display: inline-block; color: var(--mona-primary); padding-bottom: .35em; border-bottom: 1px solid color-mix(in srgb, var(--mona-primary) 64%, transparent); }}
.template-documentary-collage .card, .template-documentary-collage .cover-visual {{ background: #e7ddca; color: #171514; border: 1px solid rgba(255,255,255,.08); border-radius: 0; box-shadow: 0 {round(18 * scale)}px {round(46 * scale)}px rgba(0,0,0,.32); }}
.template-documentary-collage .card p, .template-documentary-collage .card li, .template-documentary-collage .metric-label, .template-documentary-collage .metric-detail {{ color: #403b35; }}
.template-documentary-collage .comparison-card.emphasis {{ border-top: {max(2, round(3 * scale))}px solid var(--mona-primary); }}
.template-documentary-collage .metric-value {{ color: var(--mona-primary); }}
.template-documentary-collage .visual-orbit {{ width: 58%; aspect-ratio: .82; border: 0; border-left: {max(4, round(5 * scale))}px solid var(--mona-primary); border-radius: 0; background: rgba(255,255,255,.34); }}
.template-documentary-collage .cover-visual .visual-label {{ color: #171514; }}
""",
    }
    return themes[theme]


def _aspect_css(width: int, height: int) -> str:
    if height > width:
        return f"""
.scene-content {{ padding: {max(24, round(width * 0.1))}px; }}
.scene h1 {{ font-size: {max(34, round(width * 0.075))}px; }}
.scene h2 {{ font-size: {max(20, round(width * 0.045))}px; }}
.scene p, .scene li {{ font-size: {max(16, round(width * 0.035))}px; line-height: 1.45; }}
.cover-split {{ grid-template-columns: 1fr; grid-template-rows: 1.05fr .95fr; gap: 0; }}
.cover-copy {{ align-self: end; }} .cover-copy h1, .cover-copy .lede {{ max-width: 100%; }}
.cover-copy .lede {{ margin-top: 14px; }}
.cover-visual {{ margin: 2% 10% 12%; min-height: 0; height: 80%; }}
.content-copy, .quote-copy, .outro-copy {{ width: 86%; }}
.metric-comparison, .comparison-columns {{ gap: 2%; }}
.metric-copy, .comparison-copy {{ padding-bottom: 0; }}
.metric-grid {{ grid-template-columns: 1fr; gap: {max(6, round(width * 0.02))}px; padding: 0 10% 8%; }}
.metric-card {{ padding: {max(10, round(width * 0.035))}px {max(14, round(width * 0.045))}px; }}
.metric-value {{ font-size: {max(30, round(width * 0.065))}px; }}
.metric-label {{ margin-top: 2px; font-size: {max(14, round(width * 0.032))}px; }}
.metric-detail {{ display: none; }}
.comparison-grid {{ grid-template-columns: 1fr; gap: {max(8, round(width * 0.025))}px; padding: 0 9% 8%; }}
.comparison-card {{ min-height: 0; padding: {max(14, round(width * 0.045))}px; }}
blockquote {{ font-size: {max(28, round(width * 0.065))}px; }}
"""
    if width == height:
        return f"""
.scene-content {{ padding: {max(28, round(width * 0.075))}px; }}
.scene h1 {{ font-size: {max(38, round(width * 0.06))}px; }}
.cover-split {{ grid-template-columns: 1fr; grid-template-rows: 1fr .85fr; gap: 0; }}
.cover-copy {{ align-self: end; }} .cover-copy h1, .cover-copy .lede {{ max-width: 100%; }}
.cover-visual {{ margin: 0 18% 10%; min-height: 0; }}
.metric-grid {{ gap: 10px; padding-inline: 7%; }} .metric-card {{ padding: 16px; }}
.comparison-grid {{ gap: 14px; padding-inline: 7%; }} .comparison-card {{ padding: 18px; }}
"""
    return ""


def _css(
    tokens: Mapping[str, Any],
    width: int,
    height: int,
    theme: str,
) -> str:
    return f"""\
:root {{
  --mona-primary: {tokens['primary']};
  --mona-secondary: {tokens['secondary']};
  --mona-bg: {tokens['background']};
  --mona-surface: {tokens['surface']};
  --mona-text-primary: {tokens['textPrimary']};
  --mona-text-secondary: {tokens['textSecondary']};
  --mona-border: {tokens['border']};
  --mona-heading-family: {tokens['headingFamily']};
  --mona-body-family: {tokens['bodyFamily']};
  --mona-card-radius: {tokens['radius']};
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--mona-bg); }}
body {{ font-family: var(--mona-body-family); color: var(--mona-text-primary); }}
.scene {{ position: relative; overflow: hidden; width: {width}px; height: {height}px; }}
.scene-background {{ position: absolute; inset: -2%; z-index: 0; background-repeat: no-repeat; filter: blur(var(--mona-bg-blur)); transform: scale(1.04); }}
.scene-background::after {{ content: ""; position: absolute; inset: 0; background: var(--mona-primary); opacity: var(--mona-bg-tint); }}
.scene::before {{ content: ""; position: absolute; inset: 0; pointer-events: none; background: var(--mona-overlay); opacity: var(--mona-overlay-opacity); z-index: 1; }}
.template-decor {{ position: absolute; inset: 0; z-index: 2; pointer-events: none; }}
.template-decor i {{ display: block; }}
.scene-content, .scene-visual {{ position: relative; z-index: 3; }}
.scene-subtitle {{ position: absolute; z-index: 4; left: 50%; bottom: 3%; max-width: 78%; padding: .55em 1em; color: var(--mona-text-primary); background: color-mix(in srgb, var(--mona-bg) 82%, transparent); border: 1px solid color-mix(in srgb, var(--mona-border) 72%, transparent); border-radius: calc(var(--mona-card-radius) * .55); font-size: {max(12, round(width * 0.012))}px; line-height: 1.45; text-align: center; transform: translateX(-50%); display: -webkit-box; -webkit-line-clamp: var(--subtitle-lines); -webkit-box-orient: vertical; overflow: hidden; }}
.scene-subtitle.subtitle-bottom-left {{ left: 7%; transform: none; text-align: left; }}
.scene-subtitle.subtitle-top-center {{ top: 5%; bottom: auto; }}
.scene-subtitle.style-caption-card {{ padding: .7em 1.15em; background: color-mix(in srgb, var(--mona-surface) 94%, transparent); box-shadow: 0 .45em 1.4em rgba(0,0,0,.18); }}
.scene-subtitle.style-caption-outline {{ background: transparent; border-color: transparent; font-weight: 700; text-shadow: -1px -1px 0 var(--mona-bg), 1px -1px 0 var(--mona-bg), -1px 1px 0 var(--mona-bg), 1px 1px 0 var(--mona-bg), 0 .15em .45em rgba(0,0,0,.55); }}
.subtitle-cue {{ display: none; }}
.subtitle-cue.is-active {{ display: block; }}
.subtitle-word {{ transition: color .12s linear, opacity .12s linear; }}
.subtitle-word.is-active {{ color: var(--mona-primary); }}
.scene-media {{ position: absolute; z-index: 2; right: 6%; top: 18%; bottom: 16%; width: 38%; margin: 0; overflow: hidden; border: var(--mona-border-width) solid var(--mona-border); border-radius: var(--mona-card-radius); background: var(--mona-surface); box-shadow: 0 1em 2.8em rgba(0,0,0,var(--mona-shadow-opacity)); }}
.scene-media img {{ width: 100%; height: 100%; display: block; object-fit: cover; }}
.scene.has-media .content-copy, .scene.has-media .quote-copy {{ width: 48%; margin-left: 7%; margin-right: auto; }}
.scene.has-media .cover-visual {{ opacity: .2; }}
.scene.has-media .metric-grid, .scene.has-media .comparison-grid {{ max-width: 50%; margin-right: 48%; }}
.brand-logo {{ display: block; max-width: min(36vw, 420px); max-height: 18vh; margin: 0 auto 18px; object-fit: contain; }}
.scene-content {{ padding: {max(32, round(width * 0.08))}px; }}
.scene h1, .scene h2, .scene p {{ margin: 0; }}
.scene h1 {{ font-family: var(--mona-heading-family); font-size: {max(24, round(width * 0.045))}px; line-height: 1.12; letter-spacing: -0.02em; }}
.scene h2 {{ font-family: var(--mona-heading-family); font-size: {max(16, round(width * 0.022))}px; line-height: 1.2; }}
.scene p, .scene li {{ color: var(--mona-text-secondary); font-size: {max(12, round(width * 0.017))}px; line-height: 1.55; }}
.eyebrow {{ color: var(--mona-secondary); font-size: {max(10, round(width * 0.012))}px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: {max(10, round(height * 0.025))}px; }}
.card {{ background: var(--mona-surface); border: 1px solid var(--mona-border); border-radius: var(--mona-card-radius); }}
.cover-split {{ display: grid; grid-template-columns: 1.05fr .95fr; align-items: center; gap: 4%; padding-bottom: 7%; }}
.cover-copy h1 {{ max-width: 92%; }} .cover-copy .lede {{ margin-top: 24px; max-width: 80%; }}
.cover-visual {{ margin: 8%; min-height: 56%; display: grid; place-items: center; border: 1px solid var(--mona-border); border-radius: var(--mona-card-radius); background: var(--mona-surface); }}
.visual-orbit {{ width: 46%; aspect-ratio: 1; border: max(2px, {round(width * 0.002)}px) solid var(--mona-primary); border-radius: 50%; }}
.visual-label {{ position: absolute; color: var(--mona-text-primary); font-size: {max(20, round(width * 0.018))}px; }}
.content-standard {{ display: grid; place-items: center; }} .content-copy {{ width: 78%; }} .content-copy p {{ margin-top: 28px; }}
.bullet-list {{ margin: 28px 0 0; padding-left: 1.4em; }} .bullet-list li + li {{ margin-top: 12px; }}
.metric-comparison {{ display: grid; align-content: center; gap: 6%; padding-bottom: 7%; }} .metric-copy {{ padding-bottom: 0; }} .metric-copy p {{ margin-top: 20px; }}
.metric-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 0 8%; position: relative; z-index: 1; }} .metric-card {{ padding: 28px; }}
.metric-value {{ color: var(--mona-primary); font-family: var(--mona-heading-family); font-size: {max(26, round(width * 0.042))}px; font-weight: 700; }} .metric-label {{ margin-top: 10px; font-size: {max(12, round(width * 0.015))}px; }} .metric-detail {{ margin-top: 8px; color: var(--mona-text-secondary); }}
.comparison-columns {{ display: grid; align-content: center; gap: 6%; padding-bottom: 7%; }} .comparison-copy {{ padding-bottom: 0; }} .comparison-copy p {{ margin-top: 18px; }}
.comparison-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 28px; padding: 0 8%; position: relative; z-index: 1; }} .comparison-card {{ padding: 30px; min-height: 30%; }} .comparison-card p {{ margin-top: 14px; }} .comparison-card.emphasis {{ border-color: var(--mona-primary); }}
.quote-focus {{ display: grid; place-items: center; padding-bottom: 7%; }} .quote-copy {{ width: 72%; text-align: center; }} blockquote {{ margin: 20px 0 0; color: var(--mona-text-primary); font-family: var(--mona-heading-family); font-size: {max(26, round(width * 0.035))}px; line-height: 1.25; }} cite {{ display: block; margin-top: 28px; color: var(--mona-secondary); font-style: normal; font-size: {max(12, round(width * 0.014))}px; }}
.outro-brand {{ display: grid; place-items: center; text-align: center; }} .outro-copy {{ width: 72%; }} .brand-mark {{ color: var(--mona-primary); font-family: var(--mona-heading-family); font-size: {max(24, round(width * 0.02))}px; font-weight: 700; margin-bottom: 26px; }} .outro-copy p {{ margin: 24px auto 0; max-width: 80%; }}
{_aspect_css(width, height)}
{_theme_css(theme, width, height)}
"""


def _fallback_gsap() -> str:
    return """\
(function () {
  if (window.gsap && typeof window.gsap.timeline === 'function') return;

  function selectTargets(target) {
    if (typeof target === 'string') return Array.from(document.querySelectorAll(target));
    if (target instanceof Element) return [target];
    return Array.from(target || []);
  }

  function clamp(value) { return Math.max(0, Math.min(1, value)); }

  function eased(name, progress) {
    var p = clamp(progress);
    if (name === 'power2.out') return 1 - Math.pow(1 - p, 2);
    if (name === 'power1.inOut') return p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    if (name === 'sine.inOut') return -(Math.cos(Math.PI * p) - 1) / 2;
    return p;
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function Timeline() {
    this.steps = [];
    this.length = 0;
  }

  Timeline.prototype.fromTo = function (target, fromVars, toVars, position) {
    var elements = selectTargets(target);
    var duration = Math.max(.001, number(toVars.duration, .001));
    var stagger = Math.max(0, number(toVars.stagger, 0));
    var repeat = Math.max(0, Math.floor(number(toVars.repeat, 0)));
    var start = position === undefined ? this.length : Math.max(0, number(position, this.length));
    var end = start + duration * (repeat + 1) + stagger * Math.max(0, elements.length - 1);
    this.steps.push({
      elements: elements,
      from: Object.assign({}, fromVars),
      to: Object.assign({}, toVars),
      start: start,
      duration: duration,
      stagger: stagger,
      repeat: repeat,
      yoyo: toVars.yoyo === true
    });
    this.length = Math.max(this.length, end);
    return this;
  };

  Timeline.prototype.to = function (target, toVars, position) {
    return this.fromTo(target, {}, toVars, position);
  };

  Timeline.prototype.seek = function (time) {
    var t = Math.max(0, number(time, 0));
    this.steps.forEach(function (step) {
      step.elements.forEach(function (element, index) {
        var local = t - step.start - step.stagger * index;
        var total = step.duration * (step.repeat + 1);
        var progress;
        if (local <= 0) {
          progress = 0;
        } else if (local >= total) {
          progress = step.yoyo && step.repeat % 2 === 1 ? 0 : 1;
        } else {
          var cycle = Math.floor(local / step.duration);
          var cycleProgress = (local - cycle * step.duration) / step.duration;
          progress = step.yoyo && cycle % 2 === 1 ? 1 - cycleProgress : cycleProgress;
        }
        progress = eased(step.to.ease, progress);

        if (element.__monaBaseTransform === undefined) {
          var computed = window.getComputedStyle(element).transform;
          element.__monaBaseTransform = computed && computed !== 'none' ? computed : '';
        }
        if (step.from.opacity !== undefined || step.to.opacity !== undefined) {
          var fromOpacity = number(step.from.opacity, number(window.getComputedStyle(element).opacity, 1));
          var toOpacity = number(step.to.opacity, fromOpacity);
          element.style.opacity = String(fromOpacity + (toOpacity - fromOpacity) * progress);
        }

        var hasTransform = ['x', 'y', 'scale', 'rotation'].some(function (key) {
          return step.from[key] !== undefined || step.to[key] !== undefined;
        });
        if (hasTransform) {
          var fromX = number(step.from.x, 0);
          var toX = number(step.to.x, fromX);
          var fromY = number(step.from.y, 0);
          var toY = number(step.to.y, fromY);
          var fromScale = number(step.from.scale, 1);
          var toScale = number(step.to.scale, fromScale);
          var fromRotation = number(step.from.rotation, 0);
          var toRotation = number(step.to.rotation, fromRotation);
          var x = fromX + (toX - fromX) * progress;
          var y = fromY + (toY - fromY) * progress;
          var scale = fromScale + (toScale - fromScale) * progress;
          var rotation = fromRotation + (toRotation - fromRotation) * progress;
          element.style.transform = [
            element.__monaBaseTransform,
            'translate3d(' + x + 'px,' + y + 'px,0)',
            'scale(' + scale + ')',
            'rotate(' + rotation + 'deg)'
          ].filter(Boolean).join(' ');
        }
      });
    });
    if (typeof window.__monaApplySubtitleTime === 'function') {
      window.__monaApplySubtitleTime(t);
    }
    return this;
  };

  Timeline.prototype.pause = function () { return this; };
  Timeline.prototype.duration = function () { return this.length; };

  window.gsap = {
    timeline: function () { return new Timeline(); },
    globalTimeline: {
      pause: function () { return this; },
      seek: function () { return this; }
    }
  };
})();
"""


def compile_scene_spec(
    spec: Mapping[str, Any],
    style: Mapping[str, Any],
    *,
    scene: Mapping[str, Any] | None = None,
    resolution: Any = None,
    background_path: str | Path | None = None,
    motion_plan: Mapping[str, Any] | None = None,
    subtitle_track: Mapping[str, Any] | None = None,
    asset_media: Iterable[Mapping[str, Any]] | None = None,
    brand_logo_path: str | Path | None = None,
    brand_logo_data_uri: str | None = None,
    show_subtitles: bool = True,
) -> str:
    """Validate and compile one spec into deterministic, self-contained HTML."""

    normalized = validate_scene_spec(spec, style, scene=scene)
    width, height = _resolution(
        resolution
        if resolution is not None
        else (scene or {}).get("resolution", style.get("resolution", "1920x1080"))
    )
    tokens = _tokens(style)
    layout = normalized["layout"]
    theme = _template_theme(style)
    component = _component_id(style, normalized["role"])
    content = _content(normalized, scene)
    background = _background_css(style, normalized["backgroundSlot"], background_path)
    # The class is also used as a stable selector by fixed animation presets.
    markup = _layout_markup(
        layout,
        content,
        style,
        scene,
        brand_logo_path,
        brand_logo_data_uri,
    )
    media_markup = _asset_media_markup(asset_media)
    if not show_subtitles:
        subtitle_markup = ""
    elif subtitle_track is not None:
        from mona.video_timeline import validate_subtitle_track

        validate_subtitle_track(subtitle_track)
        subtitle_markup = _subtitle_track_markup(subtitle_track, style)
    else:
        subtitle_markup = _subtitle_markup(content, style)
    start = _format_number(float(normalized["start"]))
    duration = _format_number(float(normalized["duration"]))
    animation = normalized["animationPreset"]
    if motion_plan is not None:
        from mona.video_timeline import validate_motion_plan

        validate_motion_plan(motion_plan, allowed_effects=_animation_values(style))
        animation_line = _motion_plan_script(motion_plan)
    else:
        animation_line = _motion_script(animation)
    subtitle_script = _subtitle_track_script(subtitle_track is not None)
    css = _css(tokens, width, height, theme)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width={width}, initial-scale=1">
  <title>Scene {normalized['sceneIndex']}</title>
  <style>
{css}  </style>
</head>
<body>
  <div id="scene-{normalized['sceneIndex']}" class="scene {layout} template-{theme} component-{component}{' has-media' if media_markup else ''}" data-composition-id="scene-{normalized['sceneIndex']}" data-width="{width}" data-height="{height}" data-start="{start}" data-duration="{duration}" data-role="{html.escape(normalized['role'], quote=True)}" data-layout="{html.escape(layout, quote=True)}" data-template="{theme}" data-component="{component}">
<div class="scene-background" data-layout-allow-overflow style="{background}"></div>
{_template_decor(theme)}
{markup}
{media_markup}
{subtitle_markup}
  </div>
  <script>
{_fallback_gsap()}
{subtitle_script}
(function () {{
  window.__timelines = window.__timelines || [];
  function setup() {{
    var timeline = window.gsap.timeline({{ paused: true }});
    {animation_line}
    if (typeof window.__timelines.push === 'function') window.__timelines.push(timeline);
    else window.__timelines['scene-{normalized['sceneIndex']}'] = timeline;
    if (typeof timeline.pause === 'function') timeline.pause(0);
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
}})();
  </script>
</body>
</html>
"""


def compile_scene_html(
    spec: Mapping[str, Any],
    style: Mapping[str, Any],
    **kwargs: Any,
) -> str:
    """Compatibility alias used by callers that name the output explicitly."""

    return compile_scene_spec(spec, style, **kwargs)


__all__ = [
    "ANIMATION_NAMES",
    "LAYOUT_ALIASES",
    "ROLE_NAMES",
    "SceneCompileError",
    "SceneCompilerError",
    "SceneSpecError",
    "SceneSpecParseError",
    "SceneSpecValidationError",
    "SceneStyleValidationError",
    "compile_scene_html",
    "compile_scene_spec",
    "parse_scene_spec",
    "validate_scene_spec",
]
