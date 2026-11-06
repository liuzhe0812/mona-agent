"""Read only the model capabilities from the operator's Codex catalog."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError

_EFFORT = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")


@dataclass(frozen=True)
class CodexModelMetadata:
    efforts: tuple[str, ...] = ()
    default_effort: str | None = None
    context_window: int | None = None


def codex_catalog(config: HostedWorkConfig) -> dict[str, CodexModelMetadata]:
    """Extract capabilities only; never return account identity or raw catalog data."""
    from mona.hosted_work.admin import CodexAdmin

    path = Path(config.operator_config_path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        return {}
    try:
        cache = CodexAdmin(path)._scoped("development/native/codex/models_cache.json")
        if not cache.is_file() or cache.stat().st_size > 10 * 1024 * 1024:
            return {}
        data = json.loads(cache.read_text(encoding="utf-8"))
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list) or len(models) > 512:
            return {}
        result: dict[str, CodexModelMetadata] = {}
        duplicates: set[str] = set()
        for item in models:
            if not isinstance(item, dict):
                continue
            slug = item.get("slug")
            if (not isinstance(slug, str) or not 0 < len(slug) <= 200
                    or any(ord(char) < 33 or ord(char) == 127 for char in slug)):
                continue
            if slug in result or slug in duplicates:
                result.pop(slug, None)
                duplicates.add(slug)
                continue
            raw_levels = item.get("supported_reasoning_levels")
            efforts = tuple(dict.fromkeys(level["effort"] for level in raw_levels
                if isinstance(level, dict) and isinstance(level.get("effort"), str)
                and _EFFORT.fullmatch(level["effort"])))[:16] if isinstance(raw_levels, list) else ()
            default = item.get("default_reasoning_level")
            if not isinstance(default, str) or default not in efforts:
                default = None
            window = item.get("context_window")
            if type(window) is not int or not 0 < window <= 2**53 - 1:
                window = None
            result[slug] = CodexModelMetadata(efforts, default, window)
        return result
    except (OSError, ValueError, WorkError):
        return {}
