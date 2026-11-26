"""Official models follow the server catalog rather than local visibility choices."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

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


@pytest.mark.parametrize("available", [False, True])
def test_catalog_cache_lifetime_starts_when_slow_fetch_finishes(monkeypatch, available):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog

    clock = SimpleNamespace(now=100.0)
    calls = []

    def slow_fetch(_command):
        calls.append(clock.now)
        clock.now += 30.0
        if not available:
            raise TimeoutError("offline fixture")
        return {"available": True, "models": [{"id": "official-current"}]}

    monkeypatch.setattr(managed_catalog, "time", SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(managed_catalog, "_cache", {"available": False, "models": []})
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", slow_fetch)

    assert managed_catalog.managed_model_catalog()["available"] is available
    assert managed_catalog.managed_model_catalog()["available"] is available
    assert len(calls) == 1
    clock.now += 30.01 if available else 3.01
    assert managed_catalog.managed_model_catalog()["available"] is available
    assert len(calls) == 2


def test_older_catalog_failure_cannot_replace_newer_success(monkeypatch):
    from mona.agent.tools import tauri_ipc
    from mona.providers import managed_catalog

    started, release = Event(), Event()
    calls = []
    newer = {"available": True, "models": [{"id": "official-current"}]}

    def fetch(_command):
        calls.append(len(calls))
        if len(calls) == 1:
            started.set()
            assert release.wait(5)
            raise TimeoutError("older request failed")
        return newer

    monkeypatch.setattr(managed_catalog, "_cache", {"available": False, "models": []})
    monkeypatch.setattr(managed_catalog, "_cached_at", 0.0)
    monkeypatch.setattr(managed_catalog, "_next_request", 0)
    monkeypatch.setattr(managed_catalog, "_committed_request", 0)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", fetch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(managed_catalog.managed_model_catalog)
        try:
            assert started.wait(3)
            assert pool.submit(managed_catalog.managed_model_catalog).result(timeout=3) == newer
        finally:
            release.set()
        assert first.result(timeout=3) == newer
    assert managed_catalog.managed_model_catalog() == newer


def test_model_selection_snapshot_does_not_hide_catalog_updates_from_other_requests(monkeypatch):
    from mona.providers import managed_catalog

    older = {"available": True, "models": [{"id": "official-old"}]}
    newer = {"available": True, "models": [{"id": "official-current"}]}
    monkeypatch.setattr(managed_catalog, "_cache", older)
    monkeypatch.setattr(managed_catalog, "_cached_at", managed_catalog.time.monotonic())
    with managed_catalog.use_cached_managed_catalog():
        monkeypatch.setattr(managed_catalog, "_cache", newer)
        assert managed_catalog.managed_model_catalog() == older
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(managed_catalog.managed_model_catalog).result(timeout=3) == newer
    assert managed_catalog.managed_model_catalog() == newer
