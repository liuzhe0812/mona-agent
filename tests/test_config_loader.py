import json
from pathlib import Path

import pytest

from mona.config import loader as config_loader
from mona.config.loader import ConfigLoadError, load_config, save_config
from mona.config.schema import Config
from mona.providers.context_window import (
    context_window_from_error,
    record_discovered_context_window,
    resolve_model_context_window_details,
)


def test_save_config_round_trips_model_configuration(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.provider = "deepseek"
    config.agents.defaults.model = "deepseek-chat"
    config.providers.deepseek.api_key = "test-key"

    save_config(config, path)

    restored = load_config(path)
    assert restored.agents.defaults.provider == "deepseek"
    assert restored.agents.defaults.model == "deepseek-chat"
    assert "contextWindowTokens" not in json.loads(path.read_text(encoding="utf-8"))["agents"]["defaults"]
    assert restored.providers.deepseek.api_key == "test-key"


def test_save_config_failure_preserves_previous_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "config.json"
    previous = b'{"sentinel":"keep"}'
    path.write_bytes(previous)

    def fail_after_partial_write(data: object, stream: object, **kwargs: object) -> None:
        del data, kwargs
        stream.write('{"partial"')
        raise RuntimeError("simulated write failure")

    monkeypatch.setattr(config_loader.json, "dump", fail_after_partial_write)

    with pytest.raises(RuntimeError, match="simulated write failure"):
        save_config(Config(), path)

    assert path.read_bytes() == previous
    assert not list(tmp_path.glob(".config.json.*.tmp"))


def test_load_config_rejects_invalid_json_without_changing_it(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    invalid = b'{"providers":'
    path.write_bytes(invalid)

    with pytest.raises(ConfigLoadError, match="Invalid Mona config"):
        load_config(path)

    assert path.read_bytes() == invalid


def test_context_limit_error_is_learned_as_provider_model_capability() -> None:
    config = Config()
    config.agents.defaults.provider = "deepseek"
    config.agents.defaults.model = "unlisted-model"
    preset = config.resolve_preset()

    learned = context_window_from_error(
        "This model's maximum context length is 200000 tokens. "
        "Your request contains 245000 tokens.",
    )

    assert learned == 200_000
    assert record_discovered_context_window(config, preset, learned)
    resolved = resolve_model_context_window_details(config, preset)
    assert resolved.tokens == 200_000
    assert resolved.source == "discovered"


def test_qwen_coding_plan_catalog_overrides_legacy_context_config() -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "aliyun-bailian-coding",
                "model": "qwen3.7-plus",
                "contextWindowTokens": 65_536,
            }
        },
        "providers": {
            "cindy": {"aliyun-bailian-coding": {"apiKey": "test-key"}},
        },
    })

    resolved = resolve_model_context_window_details(config, config.resolve_preset())

    assert resolved.tokens == 1_000_000
    assert resolved.source == "catalog"


def test_load_config_removes_legacy_context_window_settings(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({
        "agents": {
            "defaults": {
                "model": "unknown-model",
                "contextWindowTokens": 65_536,
                "fallbackModels": [{
                    "model": "fallback-model",
                    "provider": "custom",
                    "context_window_tokens": 32_768,
                }],
            },
        },
        "modelPresets": {
            "fast": {
                "model": "fast-model",
                "contextWindowTokens": 16_384,
            },
        },
    }), encoding="utf-8")

    config = load_config(path)
    saved = json.loads(path.read_text(encoding="utf-8"))

    assert not hasattr(config.agents.defaults, "context_window_tokens")
    assert not hasattr(config.model_presets["fast"], "context_window_tokens")
    assert "contextWindowTokens" not in saved["agents"]["defaults"]
    assert "contextWindowTokens" not in saved["model_presets"]["fast"]
    assert "contextWindowTokens" not in saved["agents"]["defaults"]["fallbackModels"][0]
