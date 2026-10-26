"""Model references only; provider credentials remain in Mona configuration."""

import copy
import json
import os

from mona.config.loader import (
    _atomic_write_json,
    _config_write_lock,
    _migrate_config,
    get_config_path,
)
from mona.config.schema import Config, StockVibeConfig, StockVibeModelBinding
from mona.providers.registry import find_by_name
from mona.services.stock_vibe.runtime import _TUSHARE_CONFIG_ENV

ATTENTION_FIELDS = ("proactive_mode", "watched_symbols", "notification_start", "notification_end",
                    "attention_interval_sec", "data_sources")


def attention_preferences(config: Config) -> dict:
    return config.stock_vibe.model_dump(mode="json", include=set(ATTENTION_FIELDS))


def model_selection(config: Config) -> dict:
    binding = config.stock_vibe.model_binding
    if binding is not None:
        return {"model_preset": None, "model_binding": binding.model_dump(mode="json")}
    return {"model_preset": config.stock_vibe.model_preset}


def model_options(config: Config) -> dict:
    choices = []
    for name in ["default", *config.model_presets]:
        preset = config.resolve_preset(name)
        provider_name = config.get_provider_name(preset.model, preset=preset)
        spec = find_by_name(provider_name) if provider_name else None
        provider = config.get_provider(preset.model, preset=preset)
        choices.append({"preset": name, "label": "沿用 Mona API" if name == "default" else name,
                        "model": preset.model, "protocol_supported": bool(spec and spec.backend == "openai_compat"),
                        "credentials_configured": bool(spec and (not spec.api_key_required or provider and provider.api_key))})
    return {"model_preset": config.stock_vibe.model_preset,
            "model_binding": (config.stock_vibe.model_binding.model_dump(mode="json")
                              if config.stock_vibe.model_binding is not None else None),
            "choices": choices}


def data_settings(config: Config) -> dict:
    environment_token = os.environ.get(_TUSHARE_CONFIG_ENV)
    if environment_token is not None:
        return {"tushare_configured": bool(environment_token), "source": "environment"}
    token = config.stock_vibe.tushare_token
    return {"tushare_configured": bool(token), "source": "settings" if token else "unconfigured"}


def save_model_selection(selection: str | None) -> None:
    _save_stock_settings({"model_preset": selection, "model_binding": None})


def save_model_binding(value: dict) -> None:
    binding = StockVibeModelBinding.model_validate(value)
    _save_stock_settings({"model_preset": None, "model_binding": binding})


def save_attention_preferences(values: dict) -> None:
    if set(values) != set(ATTENTION_FIELDS):
        raise ValueError("invalid attention settings")
    _save_stock_settings(values)


def save_data_settings(tushare_token: str) -> None:
    _save_stock_settings({"tushare_token": tushare_token})


def _save_stock_settings(values: dict) -> None:
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _config_write_lock(path):
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        candidate = copy.deepcopy(raw)
        stock = dict(candidate.get("stockVibe", candidate.get("stock_vibe", {})))
        for key, value in values.items():
            field = StockVibeConfig.model_fields[key]
            stock.pop(key, None)
            stock[field.alias or key] = value
        candidate["stockVibe"] = stock
        candidate.pop("stock_vibe", None)
        config = Config.model_validate(_migrate_config(candidate))
        raw["stockVibe"] = config.stock_vibe.model_dump(mode="json", by_alias=True)
        raw.pop("stock_vibe", None)
        _atomic_write_json(path, raw)
