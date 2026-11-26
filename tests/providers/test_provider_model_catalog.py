"""Provider discovery, saved connection, model picker and runtime share the same capability layers."""

from __future__ import annotations

import json

import pytest

from mona.config.schema import Config
from mona.development.model_selection import resolve_coding_model
from mona.providers.context_window import resolve_model_context_window_details
from mona.providers.factory import build_provider_snapshot
from mona.providers.model_metadata import model_selection_row, preset_model_route
from mona.webui import settings_api


@pytest.fixture
def config_store(monkeypatch):
    store = {"config": Config()}
    monkeypatch.setattr(settings_api, "load_config", lambda: store["config"].model_copy(deep=True))
    monkeypatch.setattr(settings_api, "save_config", lambda config: store.update(config=Config.model_validate(config.model_dump())))
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})
    return store


def test_catalog_resolves_the_account_id_without_rewriting_the_discovery_receipt(config_store):
    provider = "aliyun-bailian-token-plan-cn"
    model = "deepseek-v4.1-flash-1017"
    config = Config.model_validate({
        "agents": {"defaults": {"provider": provider, "model": model}},
        "providers": {"cindy": {provider: {"apiKey": "test-key", "enabledModels": [model],
                                           "discoveredModels": [{"id": model, "name": model}]}}},
    })
    payload = settings_api.settings_payload(config=config)
    source = next(row for row in payload["chat_providers"] if row["name"] == provider)
    selected = next(item for item in source["models"] if item["enabled"])
    assert selected["name"] == "DeepSeek V4.1 Flash 1017"
    assert selected["context_window"] == payload["agent"]["context_window_tokens"] == 1_000_000
    assert selected["context_window_source"] == payload["agent"]["context_window_source"] == "catalog"
    assert selected["reasoning_efforts"] == ["low", "high", "max"]
    assert selected["default_reasoning_effort"] == "high"
    assert selected["discovered_metadata"] == {}
    assert build_provider_snapshot(config).provider.generation.reasoning_effort == "high"
    assert resolve_coding_model(config, model, provider, "max", require_visible=True).reasoning_effort == "max"


def test_custom_discovery_overrides_and_reset_survive_save(config_store):
    raw = settings_api._parse_model_details_payload({"data": [{
        "id": "deployment-17", "display_name": "Our model", "limit": {"context": "131072"},
        "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}], "default_effort": "high",
    }]})[0]
    settings_api.update_provider_settings({
        "provider": ["custom"], "custom_name": ["Test relay"], "api_base": ["https://relay.example/v1"],
        "enabled_models": ['["deployment-17"]'], "discovered_models": [json.dumps([{**raw, "type": "chat"}])],
    })
    provider = next(iter(config_store["config"].providers.cindy))
    def selected():
        source = next(row for row in settings_api._chat_provider_rows(config_store["config"]) if row["name"] == provider)
        return source["models"][0]

    model = selected()
    assert (model["name"], model["context_window"], model["reasoning_efforts"]) == ("Our model", 131072, ["low", "high"])
    patch = {"deployment-17": {"context_window": 64000, "reasoning_efforts": ["medium", "high"], "default_reasoning_effort": "medium"}}
    settings_api.update_provider_settings({"provider": [provider], "modelOverrides": [json.dumps(patch)]})
    model = selected()
    assert (model["context_window_source"], model["context_window"], model["default_reasoning_effort"]) == ("configured", 64000, "medium")
    assert model["discovered_metadata"]["context_window"] == 131072
    config = config_store["config"]
    preset = resolve_coding_model(config, "deployment-17", provider, "medium", require_visible=True)
    assert resolve_model_context_window_details(config, preset).tokens == 64000
    with pytest.raises(settings_api.WebUISettingsError, match="默认思考档位必须属于支持列表"):
        settings_api.update_provider_settings({"provider": [provider], "modelOverrides": ['{"deployment-17":{"default_reasoning_effort":"max"}}']})
    assert selected()["context_window"] == 64000
    settings_api.update_provider_settings({"provider": [provider], "modelOverrides": ['{"deployment-17":null}']})
    assert (selected()["context_window_source"], selected()["default_reasoning_effort"]) == ("discovered", "high")
    settings_api.update_provider_settings({"provider": [provider], "api_base": ["https://relay.example/another/v1"]})
    assert selected()["context_window"] is None
    assert not selected().get("reasoning_efforts")


def test_custom_api_keeps_catalog_evidence_with_its_endpoint():
    model = "deepseek-v4.1-flash-1017"
    official = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    exact = model_selection_row("custom-relay", model, {}, api_base=official + "/")
    assert exact["context_window_source"] == "catalog" and exact["default_reasoning_effort"] == "high"
    restricted = model_selection_row("custom-relay", model, {"reasoning": False, "context_window": 65536}, api_base=official)
    assert restricted["reasoning_efforts"] == [] and restricted["default_reasoning_effort"] is None
    assert restricted["context_window"] == 65536
    different = model_selection_row("custom-relay", model, {}, api_base=official.replace("/v1", "/other/v1"))
    assert different.get("context_window_source") != "catalog"
    reference = model_selection_row("custom-relay", "deepseek-flash", {}, api_base="https://other.example/v1")
    assert reference["context_window_source"] == "reference"
    private = model_selection_row("custom-relay", "deepseek-flash", {"opaque_model_id": True}, api_base="https://other.example/v1")
    assert private["context_window"] is None and not private.get("reasoning_efforts")
    assert preset_model_route("cloudflare-ai-gateway", "claude-fable-5", "https://gateway.ai.cloudflare.com/v1/acct/gw/compat") == {
        "api_base": "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic", "wire_api": "anthropic-messages", "wire_model_id": "claude-fable-5",
    }


@pytest.mark.asyncio
async def test_discovery_follows_same_catalog_pages_and_keeps_raw_metadata(config_store, monkeypatch):
    from mona.config.schema import ProviderConfig

    provider = "aliyun-bailian-token-plan-cn"
    model = "deepseek-v4.1-flash-1017"
    config_store["config"].providers.cindy[provider] = ProviderConfig(api_key="test-key")
    calls = []
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, url, headers):
            calls.append(url)
            assert headers["Authorization"] == "Bearer test-key"
            assert "anthropic-version" not in headers
            if len(calls) == 1:
                data = {"data": [{"id": model}], "has_more": True, "last_id": model}
            else:
                data = {"data": [{"id": "another", "model_info": {"max_input_tokens": " 190000 "}}],
                        "next": "https://unrelated.example/models?page=3"}
            return settings_api.httpx.Response(200, json=data)
    monkeypatch.setattr(settings_api.httpx, "AsyncClient", Client)
    monkeypatch.setattr(settings_api, "validate_url_target", lambda *args, **kwargs: (True, ""))
    rows = await settings_api.probe_provider_model_details(provider_name=provider)

    assert len(calls) == 2 and calls[1] == calls[0] + "?after_id=" + model
    assert rows[0]["reasoning_efforts"] == ["low", "high", "max"]
    assert rows[0]["discovered_metadata"] == {}
    assert rows[1]["discovered_metadata"]["context_window"] == 190000


def test_context_and_effort_defaults_remain_bound_to_the_model_connection():
    live = {"context_window_max": 64000, "supported_reasoning_levels": [{"effort": "medium"}, {"effort": "high"}]}
    row = model_selection_row("custom-proxy", "private/v1", live, api_base="https://relay.example/v1")
    assert row["context_window"] == 64000 and row["context_window_source"] == "reference"
    assert row["reasoning_efforts"] == ["medium", "high"]
    assert "context_window" not in row["discovered_metadata"]
