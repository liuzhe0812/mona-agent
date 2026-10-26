import json

import pytest
from pydantic import ValidationError

from mona.config.loader import load_config, save_config
from mona.config.schema import Config, ModelPresetConfig, StockVibeConfig, _resolve_tool_config_refs


@pytest.fixture(autouse=True)
def resolve_config_types() -> None:
    _resolve_tool_config_refs()


def test_stock_vibe_defaults_and_camel_case_persistence(tmp_path) -> None:
    config = Config()

    assert config.stock_vibe.model_preset is None
    assert config.stock_vibe.proactive_mode == "important_changes"
    assert config.stock_vibe.watched_symbols == []
    assert config.stock_vibe.data_sources == ["tencent", "eastmoney"]
    assert "enabled" not in StockVibeConfig.model_fields
    assert "stock" not in Config.model_fields

    path = tmp_path / "config.json"
    save_config(config, path)

    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert "stockVibe" in persisted
    assert "stock_vibe" not in persisted
    assert persisted["stockVibe"]["modelPreset"] is None
    assert persisted["stockVibe"]["proactiveMode"] == "important_changes"
    assert "enabled" not in persisted["stockVibe"]
    assert load_config(path).stock_vibe == config.stock_vibe


def test_stock_vibe_requires_an_explicit_named_preset_and_round_trips(tmp_path) -> None:
    config = Config(
        model_presets={"stock-research": ModelPresetConfig(model="research-model", provider="openai")},
        stock_vibe={
            "modelPreset": "stock-research",
            "proactiveMode": "continuous",
            "watchedSymbols": ["600519.SH"],
            "notificationStart": "09:00",
            "notificationEnd": "15:30",
            "attentionIntervalSec": 600,
            "dataSources": ["tencent", "gildata", "local"],
        },
    )
    path = tmp_path / "config.json"

    save_config(config, path)
    restored = load_config(path)

    assert restored.stock_vibe.model_preset == "stock-research"
    assert restored.stock_vibe.proactive_mode == "continuous"
    assert restored.stock_vibe.watched_symbols == ["600519.SH"]
    assert restored.stock_vibe.data_sources == ["tencent", "gildata", "local"]


@pytest.mark.parametrize(
    "stock_vibe",
    [
        {"proactiveMode": "automatic"},
        {"idleTimeoutSec": 59},
        {"attentionIntervalSec": 299},
        {"notificationStart": "9:30"},
        {"notificationStart": "16:00", "notificationEnd": "09:30"},
        {"dataSources": ["unsupported"]},
        {"dataSources": ["tencent", "tencent"]},
        {"enabled": True},
    ],
)
def test_stock_vibe_rejects_invalid_values(stock_vibe: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Config.model_validate({"stockVibe": stock_vibe})


def test_stock_vibe_can_explicitly_select_mona_api_defaults(tmp_path) -> None:
    config = Config.model_validate({"stockVibe": {"modelPreset": "default"}})
    path = tmp_path / "config.json"
    save_config(config, path)
    assert load_config(path).stock_vibe.model_preset == "default"
    assert config.resolve_preset("default") == config.resolve_default_preset()


@pytest.mark.parametrize("model_preset", ["missing-preset"])
def test_stock_vibe_rejects_missing_model_presets(model_preset: str) -> None:
    with pytest.raises(ValidationError, match="stock_vibe.model_preset"):
        Config.model_validate({"stockVibe": {"modelPreset": model_preset}})


def test_removed_stock_settings_do_not_block_loading_or_rewrite_user_config(tmp_path) -> None:
    path = tmp_path / "config.json"
    raw = b'{"stock":{"enabled":true,"autoReviewEnabled":true},"stockVibe":{"modelPreset":null}}'
    path.write_bytes(raw)
    config = load_config(path)
    assert "stock" not in config.model_dump()
    assert config.stock_vibe.model_preset is None
    assert path.read_bytes() == raw
