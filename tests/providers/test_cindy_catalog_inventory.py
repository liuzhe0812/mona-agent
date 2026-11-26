from mona.providers import cindy_catalog
from mona.providers.cindy_catalog import (
    CINDY_CHAT_PROVIDER_BY_ID,
    CINDY_CHAT_PROVIDERS,
    CINDY_PROVIDER_ID_ALIASES,
    bundled_model_catalog,
)
from mona.providers.model_sources import CHAT_SOURCE_PROVIDER_BY_ID, CHAT_SOURCE_PROVIDERS


def test_cindy_provider_inventory_keeps_protocols_and_authentication_distinct():
    assert len(CINDY_CHAT_PROVIDERS) == len(CINDY_CHAT_PROVIDER_BY_ID) == 62
    assert len(CHAT_SOURCE_PROVIDERS) == len(CHAT_SOURCE_PROVIDER_BY_ID) == 64
    assert "openai-api" not in CHAT_SOURCE_PROVIDER_BY_ID
    assert "anthropic-api" not in CHAT_SOURCE_PROVIDER_BY_ID
    assert CHAT_SOURCE_PROVIDER_BY_ID["openai"].catalog_models
    assert CHAT_SOURCE_PROVIDER_BY_ID["anthropic"].catalog_models
    assert CINDY_CHAT_PROVIDER_BY_ID["amazon-bedrock"].auth_method == "aws"
    assert CINDY_CHAT_PROVIDER_BY_ID["google-vertex"].auth_method == "google-adc"
    assert CINDY_CHAT_PROVIDER_BY_ID["github-copilot"].auth_method == "github-copilot"
    assert CINDY_CHAT_PROVIDER_BY_ID["azure-openai-responses"].wire_api == "azure-openai-responses"
    assert CINDY_CHAT_PROVIDER_BY_ID["lmstudio"].allow_private is True
    assert CINDY_CHAT_PROVIDER_BY_ID["lmstudio"].auth_method == "none"
    assert CINDY_CHAT_PROVIDER_BY_ID["deepseek"].allow_private is False


def test_exact_model_defaults_are_scoped_to_the_cindy_provider():
    zhipu = CINDY_CHAT_PROVIDER_BY_ID["zhipu-glm-cn"]
    glm = next(model for model in zhipu.models if model.id == "glm-5.2")
    assert glm.context_window == 1_000_000
    assert glm.reasoning_efforts == ("minimal", "high", "max")
    assert glm.default_reasoning_effort == "high"

    kimi = CINDY_CHAT_PROVIDER_BY_ID["moonshot-kimi-cn"]
    model = next(model for model in kimi.models if model.id == "kimi-k3.1-pro")
    assert model.default_reasoning_effort == "max"

    bailian = CINDY_CHAT_PROVIDER_BY_ID["aliyun-bailian-token-plan-cn"]
    model = next(model for model in bailian.catalog_models if model.id == "deepseek-v4.1-flash-1017")
    assert model.name == "DeepSeek V4.1 Flash 1017"
    assert model.context_window == 1_000_000
    assert model.reasoning_efforts == ("low", "high", "max")
    assert model.default_enabled is False
    assert all(model.id != "deepseek-v4.1-flash-1017" for model in bailian.models)


def test_exact_route_window_overrides_inherited_registry_base_window():
    catalog = bundled_model_catalog()
    layers = catalog["registry_routes"]["deepseek"]["deepseek-v4-flash"]
    assert layers["base_defaults"]["context_window"] == 1_048_576
    assert "context_window" not in layers["entry_defaults"]
    assert "context_window" not in layers["route_defaults"]
    defaults = catalog["preset_models"]["deepseek"]["deepseek-v4-flash"]
    assert defaults["context_window"] == 1_000_000
    assert defaults["_provenance"]["context_window"] == "exact_pi"
    provider = CINDY_CHAT_PROVIDER_BY_ID["deepseek"]
    model = next(model for model in provider.catalog_models if model.id == "deepseek-v4-flash")
    assert model.context_window == 1_000_000


def test_hidden_catalog_entries_are_not_restored_as_default_models():
    for preset in bundled_model_catalog()["presets"]:
        provider = CHAT_SOURCE_PROVIDER_BY_ID[CINDY_PROVIDER_ID_ALIASES.get(preset["id"], preset["id"])]
        explicit = {row["id"] for row in preset["models"]}
        hidden = {row["id"] for row in preset["models"] if row.get("default_enabled") is False}
        hidden.update(row["id"] for row in preset["candidates"]
                      if row.get("default_enabled") is False and row["id"] not in explicit)
        assert hidden.isdisjoint(model.id for model in provider.models), preset["id"]


def test_candidate_uses_its_own_endpoint_window_not_another_route(monkeypatch):
    asset = {
        "routes": {
            "https://example.test/v1": {"same-model": {"context_window": 100_000}},
            "https://example.test/other": {"same-model": {"context_window": 200_000}},
        },
        "preset_models": {"sample": {"same-model": {
            "context_window": 100_000, "_provenance": {"context_window": "exact_pi"},
        }}},
        "presets": [{
            "id": "sample", "name": "Sample", "api_base": "https://example.test/v1",
            "wire_api": "openai-completions", "auth_method": "apiKey", "models": [],
            "candidates": [
                {"id": "same-model", "default_enabled": False},
                {"id": "same-model", "api_base": "https://example.test/other", "default_enabled": False},
            ],
        }],
    }
    monkeypatch.setattr(cindy_catalog, "bundled_model_catalog", lambda: asset)
    provider = next(item for item in cindy_catalog._snapshot_providers() if item.id == "sample")
    assert [model.context_window for model in provider.catalog_models] == [100_000, 200_000]


def test_generated_candidates_keep_wire_identity_and_do_not_become_enabled_models():
    fireworks = CINDY_CHAT_PROVIDER_BY_ID["fireworks"]
    assert fireworks.models == ()
    assert fireworks.catalog_models
    candidate = next(model for model in fireworks.catalog_models if model.wire_api == "anthropic-messages")
    assert candidate.default_enabled is False
    assert candidate.wire_model_id == candidate.id
    assert candidate.api_base == "https://api.fireworks.ai/inference"

    cloudflare = CINDY_CHAT_PROVIDER_BY_ID["cloudflare-workers-ai"]
    candidate = next(model for model in cloudflare.catalog_models if model.id.startswith("@cf/"))
    assert candidate.wire_model_id == candidate.id
    assert "{CLOUDFLARE_ACCOUNT_ID}" in cloudflare.api_base
    assert candidate.metadata and candidate.metadata["context_window"] > 0

    opencode = CINDY_CHAT_PROVIDER_BY_ID["opencode-go"]
    model = next(model for model in opencode.models if model.id == "minimax-m3")
    assert model.api_base == "https://opencode.ai/zen/go"
    assert model.wire_api == "anthropic-messages"
