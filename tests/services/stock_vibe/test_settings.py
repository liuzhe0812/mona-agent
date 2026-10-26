import json

import pytest
from pydantic import ValidationError

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.services.stock_vibe.contracts import ModelSelection
from mona.services.stock_vibe.settings import (
    attention_preferences,
    model_options,
    model_selection,
    save_attention_preferences,
    save_model_binding,
    save_model_selection,
)


def test_model_selection_preserves_provider_placeholders_and_unrelated_raw_fields(tmp_path, monkeypatch):
    _resolve_tool_config_refs()
    path = tmp_path / "config.json"
    raw = {"providers": {"openai": {"apiKey": "${SYNTHETIC_KEY}"}}, "api": {"host": "127.0.0.1", "port": 8900},
           "agents": {"defaults": {"executor": "codebuddy", "model": "fixture-model", "provider": "openai"}}}
    path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr("mona.services.stock_vibe.settings.get_config_path", lambda: path)
    save_model_selection("default")
    preferences = attention_preferences(Config())
    preferences.update(proactive_mode="manual", watched_symbols=["600519.SH"])
    save_attention_preferences(preferences)
    actual = json.loads(path.read_text(encoding="utf-8"))
    assert actual["providers"] == raw["providers"]
    assert actual["agents"] == raw["agents"]
    assert actual["api"] == raw["api"]
    assert actual["stockVibe"]["modelPreset"] == "default"
    assert actual["stockVibe"]["proactiveMode"] == "manual"
    assert actual["stockVibe"]["watchedSymbols"] == ["600519.SH"]
    config = Config.model_validate(actual)
    option = model_options(config)["choices"][0]
    assert option["preset"] == "default" and option["protocol_supported"] is True
    assert option["model"] == "fixture-model"
    assert "apiKey" not in json.dumps(option)


def test_native_stock_model_selection_is_exclusive_and_omits_empty_binding():
    native = {"executor": "codebuddy", "model": "account-model", "provider": None, "effort": None}
    assert ModelSelection.model_validate({"model_preset": "default"}).model_dump() == {
        "model_preset": "default"
    }
    selection = ModelSelection.model_validate({"model_preset": None, "model_binding": native})
    assert selection.model_dump() == {"model_preset": None, "model_binding": native}
    assert ModelSelection.model_validate({"model_binding": native}).model_dump() == {
        "model_preset": None, "model_binding": native
    }

    for value in (
        {},
        {"model_preset": "default", "model_binding": native},
        {"model_preset": None, "model_binding": {**native, "executor": "mona", "provider": "openai"}},
        {"model_preset": None, "model_binding": {**native, "provider": "openai"}},
    ):
        with pytest.raises(ValidationError):
            ModelSelection.model_validate(value)

    with pytest.raises(ValidationError, match="mutually exclusive"):
        Config.model_validate({"stockVibe": {"modelPreset": "default", "modelBinding": native}})


def test_native_model_binding_round_trips_without_changing_global_model_or_credentials(tmp_path, monkeypatch):
    _resolve_tool_config_refs()
    path = tmp_path / "config.json"
    raw = {
        "providers": {"openai": {"apiKey": "${SYNTHETIC_KEY}"}},
        "agents": {"defaults": {"executor": "codebuddy", "model": "global-account-model", "provider": "openai"}},
    }
    path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr("mona.services.stock_vibe.settings.get_config_path", lambda: path)

    native = {"executor": "codebuddy", "model": "stock-account-model", "provider": None, "effort": None}
    save_model_binding(native)
    actual = json.loads(path.read_text(encoding="utf-8"))
    assert actual["stockVibe"]["modelPreset"] is None
    assert actual["stockVibe"]["modelBinding"] == native
    assert actual["providers"] == raw["providers"]
    assert actual["agents"] == raw["agents"]
    config = Config.model_validate(actual)
    assert model_selection(config) == {"model_preset": None, "model_binding": native}
    assert model_options(config)["model_binding"] == native

    save_model_selection("default")
    restored = json.loads(path.read_text(encoding="utf-8"))
    assert restored["stockVibe"]["modelPreset"] == "default"
    assert restored["stockVibe"]["modelBinding"] is None
    assert restored["providers"] == raw["providers"]
    assert restored["agents"] == raw["agents"]
    assert model_selection(Config.model_validate(restored)) == {"model_preset": "default"}
