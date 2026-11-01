"""Official models follow the server catalog rather than local visibility choices."""

import pytest

from mona.config.schema import Config, ProviderConfig
from mona.webui import settings_api


@pytest.mark.parametrize("selected", [None, [], ["official-current"], ["retired-model"]])
def test_official_catalog_updates_are_always_visible(monkeypatch, selected):
    config = Config()
    config.providers.mona_managed.enabled_models = selected
    catalog = {"available": True, "models": [
        {"id": "official-current", "billing_type": "token"},
        {"id": "official-image", "billing_type": "image"},
    ]}
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: catalog)

    def models():
        return settings_api._chat_provider_rows(config)[0]["models"]

    assert [(item["id"], item["enabled"]) for item in models()] == [("official-current", True)]
    catalog["models"].append({"id": "official-new", "billing_type": "token"})
    assert [(item["id"], item["enabled"]) for item in models()] == [
        ("official-current", True), ("official-new", True),
    ]
    catalog["models"].pop(0)
    assert [(item["id"], item["enabled"]) for item in models()] == [("official-new", True)]


@pytest.mark.parametrize("selected", ['[]', '["official-current"]'])
def test_official_visibility_cannot_be_restricted(monkeypatch, selected):
    config = Config()
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    saved = []
    monkeypatch.setattr(settings_api, "save_config", saved.append)

    with pytest.raises(settings_api.WebUISettingsError, match="官方统一提供"):
        settings_api.update_provider_settings({"provider": ["mona_managed"], "enabledModels": [selected]})
    assert not saved


def test_official_legacy_visibility_can_be_cleared_without_changing_default(monkeypatch):
    config = Config()
    config.providers.mona_managed.enabled_models = ["retired-model"]
    config.agents.defaults.provider = "mona_managed"
    config.agents.defaults.model = "chosen-model"
    monkeypatch.setattr(settings_api, "load_config", lambda: config)
    saved = []
    monkeypatch.setattr(settings_api, "save_config", saved.append)
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {
        "available": True, "models": [{"id": "chosen-model", "billing_type": "token"}],
    })
    monkeypatch.setattr(settings_api, "settings_payload", lambda: {})

    settings_api.update_provider_settings({"provider": ["mona_managed"], "enabledModels": ["null"]})

    assert config.providers.mona_managed.enabled_models is None
    assert config.agents.defaults.model == "chosen-model"
    assert saved == [config]


def test_custom_provider_visibility_is_preserved(monkeypatch):
    config = Config()
    config.providers.cindy["custom-example"] = ProviderConfig(
        api_base="https://example.invalid/v1", display_name="Custom", enabled_models=["shown"],
        discovered_models=[{"id": "shown", "type": "chat"}, {"id": "hidden", "type": "chat"}],
    )
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})

    custom = next(row for row in settings_api._chat_provider_rows(config) if row["name"] == "custom-example")

    assert [(model["id"], model["enabled"]) for model in custom["models"]] == [("shown", True), ("hidden", False)]
