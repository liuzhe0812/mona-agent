"""Manual model type overrides survive provider catalog merges."""

from __future__ import annotations

import json

import mona.webui.settings_api as settings_api
from mona.config.loader import load_config


def test_catalog_model_type_can_be_corrected_to_chat(monkeypatch, tmp_path) -> None:
    config = load_config(tmp_path / "config.json")
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    monkeypatch.setattr(settings_api, "save_config", lambda _config: None)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})

    def update(model_type: str) -> dict:
        payload = settings_api.update_provider_settings({
            "provider": ["zhipu-glm-cn"],
            "api_key": ["test-key"],
            "enabled_models": [json.dumps(["glm-5.2"])],
            "discovered_models": [json.dumps([{"id": "glm-5.2", "type": model_type}])],
        })
        return next(row for row in payload["chat_providers"] if row["name"] == "zhipu-glm-cn")

    model = next(item for item in update("image")["models"] if item["id"] == "glm-5.2")
    assert model["type"] == "image"

    model = next(item for item in update("chat")["models"] if item["id"] == "glm-5.2")
    assert model["type"] == "chat"
    assert model["enabled"] is True

    created = settings_api.update_provider_settings({
        "provider": ["custom"],
        "custom_name": ["Local Models"],
        "api_base": ["https://relay.example/v1"],
        "enabled_models": ["[]"],
        "discovered_models": [json.dumps([{"id": "text-model", "type": "image"}])],
    })
    custom = next(row for row in created["chat_providers"] if row.get("is_custom"))
    corrected = settings_api.update_provider_settings({
        "provider": [custom["name"]],
        "discovered_models": [json.dumps([{"id": "text-model", "type": "chat"}])],
    })
    custom = next(row for row in corrected["chat_providers"] if row["name"] == custom["name"])
    assert custom["models"][0]["type"] == "chat"
