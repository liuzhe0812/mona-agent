"""Discovered model reasoning metadata remains in saved settings and rows."""

from __future__ import annotations

import json

import pytest

import mona.webui.settings_api as settings_api
from mona.config.loader import load_config
from mona.providers.mona_managed_provider import MonaManagedProvider
from mona.providers.reasoning import managed_reasoning_metadata, normalize_reasoning_metadata
from mona.providers.registry import find_by_name


def test_live_shaped_managed_catalog_has_glm_effort_without_server_metadata(monkeypatch, tmp_path):
    config = load_config(tmp_path / "config.json")
    catalog = {"available": True, "models": [
        {"id": "glm-5.3", "name": "glm-5.3", "input_amount_per_million": "8", "output_amount_per_million": "28"},
        {"id": "qwen3.7-plus", "name": "qwen3.7-plus"},
    ]}
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: catalog)
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    models = next(row for row in settings_api._chat_provider_rows(config) if row["name"] == "mona_managed")["models"]
    glm = next(model for model in models if model["id"] == "glm-5.3")
    assert glm["reasoning_efforts"] == ["low", "high", "max"]
    assert glm["default_reasoning_effort"] == "high"
    assert "reasoning_efforts" not in next(model for model in models if model["id"] == "qwen3.7-plus")
    config.agents.defaults.provider, config.agents.defaults.model = "mona_managed", "glm-5.3"
    settings_api.update_agent_settings({"reasoning_effort": ["max"]})
    provider = MonaManagedProvider(default_model="glm-5.3", spec=find_by_name("mona_managed"))
    request = provider._build_kwargs(messages=[{"role": "user", "content": "test"}], tools=None,
        model="glm-5.3", max_tokens=100, temperature=1,
        reasoning_effort=config.agents.defaults.reasoning_effort, tool_choice=None)
    assert request["reasoning_effort"] == "max"


def test_managed_baseline_does_not_override_server_or_other_sources():
    assert managed_reasoning_metadata({"id": "glm-5.3", "reasoning": False}) == {"reasoning_efforts": []}
    assert managed_reasoning_metadata({"id": "glm-5.3", "reasoning_efforts": []}) == {"reasoning_efforts": []}
    assert managed_reasoning_metadata({"id": "glm-5.3", "reasoning_efforts": ["high"], "default_reasoning_effort": "high"}) == {
        "reasoning_efforts": ["high"], "default_reasoning_effort": "high"}
    assert managed_reasoning_metadata({"id": "glm-5.3-unknown"}) == {}
    assert normalize_reasoning_metadata({"id": "glm-5.3"}) == {}


def test_discovery_parser_preserves_per_model_levels_and_omits_unknown_metadata() -> None:
    models = settings_api._parse_model_details_payload(
        {
            "data": [
                {"id": "model-high", "reasoning_efforts": ["high", "low"], "default_reasoning_effort": "low"},
                {"id": "model-max", "reasoning": {"supported_efforts": ["max"], "default_effort": "max"}},
                {"id": "model-empty", "supported_efforts": []},
                {"id": "model-unknown", "capabilities": {"thinking": {"supported": False}}},
            ]
        }
    )

    by_id = {model["id"]: model for model in models}
    assert by_id["model-high"]["reasoning_efforts"] == ["high", "low"]
    assert by_id["model-high"]["default_reasoning_effort"] == "low"
    assert by_id["model-max"]["reasoning_efforts"] == ["max"]
    assert by_id["model-max"]["default_reasoning_effort"] == "max"
    assert by_id["model-empty"]["reasoning_efforts"] == []
    assert "reasoning_efforts" not in by_id["model-unknown"]


def test_saved_discovery_and_provider_rows_keep_metadata_on_sparse_type_save(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    config = load_config(tmp_path / "config.json")
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})

    created = settings_api.update_provider_settings(
        {
            "provider": ["custom"],
            "custom_name": ["Metadata Relay"],
            "api_base": ["https://relay.example/v1"],
            "discovered_models": [
                json.dumps(
                    [
                        {
                            "id": "model-a",
                            "reasoningEfforts": ["high", "low", "none"],
                            "defaultReasoningEffort": "low",
                            "supportsAdaptiveThinking": False,
                        },
                        {
                            "id": "model-empty",
                            "reasoningEfforts": ["low"],
                            "defaultReasoningEffort": "low",
                        },
                        {"id": "model-unknown", "capabilities": {"thinking": {"supported": False}}},
                    ]
                )
            ],
        }
    )
    provider = next(row for row in created["chat_providers"] if row.get("is_custom"))

    settings_api.update_provider_settings(
        {
            "provider": [provider["name"]],
            "discovered_models": [
                json.dumps(
                    [
                        {"id": "model-a", "type": "image"},
                        {"id": "model-empty", "reasoningEfforts": []},
                    ]
                )
            ],
        }
    )

    row = next(
        row
        for row in settings_api._chat_provider_rows(config)
        if row["name"] == provider["name"]
    )
    models = {model["id"]: model for model in row["models"]}
    assert models["model-a"]["type"] == "image"
    assert models["model-a"]["reasoning_efforts"] == ["high", "low"]
    assert models["model-a"]["default_reasoning_effort"] == "low"
    assert models["model-a"]["supports_adaptive_thinking"] is False
    assert models["model-empty"]["reasoning_efforts"] == []
    assert "default_reasoning_effort" not in models["model-empty"]
    assert "reasoning_efforts" not in models["model-unknown"]


def test_managed_catalog_keeps_explicit_effort_and_adaptive_thinking_metadata(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    config = load_config(tmp_path / "config.json")
    monkeypatch.setattr(
        settings_api,
        "_managed_model_catalog",
        lambda: {
            "available": True,
            "models": [
                {
                    "id": "managed-reasoning",
                    "billing_type": "token",
                    "capabilities": {
                        "effort": {
                            "supported": True,
                            "levels": {
                            "low": {"supported": True},
                                "high": {"supported": False},
                            },
                            "default_level": "low",
                        },
                        "thinking": {
                            "types": {"adaptive": {"supported": True}}
                        },
                    },
                }
            ],
        },
    )

    managed = next(
        row for row in settings_api._chat_provider_rows(config) if row["name"] == "mona_managed"
    )
    model = next(model for model in managed["models"] if model["id"] == "managed-reasoning")
    assert model["reasoning_efforts"] == ["low"]
    assert model["default_reasoning_effort"] == "low"
    assert model["supports_adaptive_thinking"] is True


def test_invalid_discovered_reasoning_metadata_is_rejected_on_save(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    config = load_config(tmp_path / "config.json")
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})

    with pytest.raises(settings_api.WebUISettingsError, match="reasoning efforts"):
        settings_api.update_provider_settings(
            {
                "provider": ["custom"],
                "custom_name": ["Bad Metadata"],
                "api_base": ["https://relay.example/v1"],
                "discovered_models": [
                    json.dumps([{"id": "model-a", "reasoningEfforts": "high"}])
                ],
            }
        )
