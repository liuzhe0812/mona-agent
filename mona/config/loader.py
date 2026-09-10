"""Configuration loading utilities."""

import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pydantic
from loguru import logger
from pydantic import BaseModel

from mona.config.schema import Config

# Global variable to store current config path (for multi-instance support)
_current_config_path: Path | None = None


class ConfigLoadError(ValueError):
    """Raised when an existing config file cannot be loaded safely."""


def set_config_path(path: Path) -> None:
    """Set the current config path (used to derive data directory)."""
    global _current_config_path
    _current_config_path = path


def get_config_path() -> Path:
    """Get the configuration file path."""
    if _current_config_path:
        return _current_config_path
    return Path.home() / ".mona" / "config.json"


def load_config(config_path: Path | None = None) -> Config:
    """
    Load configuration from file or create default.

    Args:
        config_path: Optional path to config file. Uses default if not provided.

    Returns:
        Loaded configuration object.
    """
    path = config_path or get_config_path()

    # Ensure forward references in ToolsConfig/Config are resolved. The eager
    # call at the bottom of schema.py may have failed due to circular imports
    # triggered by the entry point's import order; retry here once the import
    # graph has settled.
    if not Config.__pydantic_complete__:
        from mona.config.schema import _resolve_tool_config_refs
        _resolve_tool_config_refs()

    config = Config()
    if path.exists():
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("config root must be a JSON object")
            data = _migrate_config(data)
            config = Config.model_validate(data)
        except (json.JSONDecodeError, ValueError, pydantic.ValidationError) as e:
            logger.error("Failed to load config from {}: {}", path, e)
            raise ConfigLoadError(f"Invalid Mona config at {path}: {e}") from e

    _apply_ssrf_whitelist(config)
    return config


def _apply_ssrf_whitelist(config: Config) -> None:
    """Apply SSRF whitelist from config to the network security module."""
    from mona.security.network import configure_ssrf_whitelist

    configure_ssrf_whitelist(config.tools.ssrf_whitelist)


def save_config(config: Config, config_path: Path | None = None) -> None:
    """
    Save configuration to file.

    Args:
        config: Configuration to save.
        config_path: Optional path to save to. Uses default if not provided.
    """
    path = config_path or get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    data = config.model_dump(mode="json", by_alias=True)

    with _config_write_lock(path):
        _atomic_write_json(path, data)


@contextmanager
def _config_write_lock(path: Path) -> Iterator[None]:
    """Serialize config replacement with the desktop process."""
    lock_path = path.with_name(f"{path.name}.lock")
    with open(lock_path, "a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)

        if os.name == "nt":
            import msvcrt

            msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Replace the config only after a complete JSON file reaches disk."""
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


_ENV_REF_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def resolve_config_env_vars(config: Config) -> Config:
    """Return *config* with ``${VAR}`` env-var references resolved.

    Walks in place so fields declared with ``exclude=True`` (e.g.
    ``DreamConfig.cron``) survive; returns the same instance when no
    references are present. Raises ``ValueError`` if a referenced
    variable is not set.
    """
    return _resolve_in_place(config)


def _resolve_in_place(obj: Any) -> Any:
    if isinstance(obj, str):
        new = _ENV_REF_PATTERN.sub(_env_replace, obj)
        return new if new != obj else obj
    if isinstance(obj, BaseModel):
        updates: dict[str, Any] = {}
        for name in type(obj).model_fields:
            old = getattr(obj, name)
            new = _resolve_in_place(old)
            if new is not old:
                updates[name] = new
        extras = obj.__pydantic_extra__
        new_extras: dict[str, Any] | None = None
        if extras:
            resolved = {k: _resolve_in_place(v) for k, v in extras.items()}
            if any(resolved[k] is not extras[k] for k in extras):
                new_extras = resolved
        if not updates and new_extras is None:
            return obj
        copy = obj.model_copy(update=updates) if updates else obj.model_copy()
        if new_extras is not None:
            copy.__pydantic_extra__ = new_extras
        return copy
    if isinstance(obj, dict):
        resolved = {k: _resolve_in_place(v) for k, v in obj.items()}
        return resolved if any(resolved[k] is not obj[k] for k in obj) else obj
    if isinstance(obj, list):
        resolved = [_resolve_in_place(v) for v in obj]
        return resolved if any(nv is not ov for nv, ov in zip(resolved, obj)) else obj
    return obj


def _env_replace(match: re.Match[str]) -> str:
    name = match.group(1)
    value = os.environ.get(name)
    if value is None:
        raise ValueError(
            f"Environment variable '{name}' referenced in config is not set"
        )
    return value


def _migrate_config(data: dict) -> dict:
    """Migrate old config formats to current."""
    defaults = data.get("agents", {}).get("defaults", {})
    if defaults.get("maxToolIterations") == 200:
        defaults["maxToolIterations"] = 100

    # Move tools.exec.restrictToWorkspace → tools.restrictToWorkspace
    tools = data.get("tools", {})
    exec_cfg = tools.get("exec", {})
    if "restrictToWorkspace" in exec_cfg and "restrictToWorkspace" not in tools:
        tools["restrictToWorkspace"] = exec_cfg.pop("restrictToWorkspace")

    # Move tools.myEnabled / tools.mySet → tools.my.{enable, allowSet}.
    # The old flat keys shipped in the initial MyTool landing; wrapping them in a
    # sub-config keeps `web` / `exec` / `my` symmetric and gives room to grow.
    if "myEnabled" in tools or "mySet" in tools:
        my_cfg = tools.setdefault("my", {})
        if "myEnabled" in tools and "enable" not in my_cfg:
            my_cfg["enable"] = tools.pop("myEnabled")
        else:
            tools.pop("myEnabled", None)
        if "mySet" in tools and "allowSet" not in my_cfg:
            my_cfg["allowSet"] = tools.pop("mySet")
        else:
            tools.pop("mySet", None)

    web_cfg = tools.get("web", {})
    fetch_cfg = web_cfg.get("fetch", {}) if isinstance(web_cfg, dict) else {}
    if isinstance(fetch_cfg, dict):
        fetch_cfg.pop("useJinaReader", None)
        fetch_cfg.pop("use_jina_reader", None)
    search_cfg = web_cfg.get("search", {}) if isinstance(web_cfg, dict) else {}
    search_default_version = (
        search_cfg.get("providerDefaultVersion", search_cfg.get("provider_default_version", 0))
        if isinstance(search_cfg, dict)
        else 0
    )
    if isinstance(search_cfg, dict) and search_default_version < 1:
        provider = str(search_cfg.get("provider") or "").strip().lower()
        api_key = search_cfg.get("apiKey", search_cfg.get("api_key", ""))
        base_url = search_cfg.get("baseUrl", search_cfg.get("base_url", ""))
        if provider in {"", "duckduckgo"} and not api_key and not base_url:
            search_cfg["provider"] = "anysearch"
        search_cfg["providerDefaultVersion"] = 1

    # The built-in Zen free-model catalog was removed. Preserve existing
    # installations by returning its selections to provider auto-detection.
    def migrate_zen_selection(selection: dict) -> None:
        if selection.get("provider") != "zen":
            return
        selection["provider"] = "auto"
        if not selection.get("model") or str(selection["model"]).endswith("-free"):
            selection["model"] = "deepseek-v4-flash"

    migrate_zen_selection(defaults)
    for preset in defaults.get("modelPresets", defaults.get("model_presets", {})).values():
        if isinstance(preset, dict):
            migrate_zen_selection(preset)
    for fallback in defaults.get("fallbackModels", defaults.get("fallback_models", [])):
        if isinstance(fallback, dict):
            migrate_zen_selection(fallback)
    providers = data.get("providers")
    if isinstance(providers, dict):
        providers.pop("zen", None)

    return data
