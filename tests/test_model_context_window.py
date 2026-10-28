from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from mona.agent.loop import AgentLoop
from mona.bus.queue import MessageBus
from mona.config.schema import Config
from mona.providers.context_window import (
    resolve_model_context_window,
    resolve_model_context_window_details,
)
from mona.providers.factory import build_provider_snapshot


def test_static_catalog_context_window_overrides_legacy_default() -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "contextWindowTokens": 65_536,
            }
        },
        "providers": {"deepseek": {"apiKey": "test-key"}},
    })

    assert resolve_model_context_window(config, config.resolve_preset()) == 1_000_000
    with patch("mona.providers.openai_compat_provider.AsyncOpenAI"):
        assert build_provider_snapshot(config).context_window_tokens == 1_000_000


def test_loop_startup_uses_model_catalog_context_window(tmp_path) -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "contextWindowTokens": 65_536,
                "workspace": str(tmp_path),
            }
        },
        "providers": {"deepseek": {"apiKey": "test-key"}},
    })
    provider = MagicMock()
    provider.get_default_model.return_value = "deepseek-v4-flash"
    provider.generation = SimpleNamespace(max_tokens=8192)

    with patch("mona.providers.factory.make_provider", return_value=provider):
        loop = AgentLoop.from_config(config, MessageBus())

    assert loop.context_window_tokens == 1_000_000


def test_managed_catalog_context_window_is_used_when_available() -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "mona_managed",
                "model": "deepseek-v4-flash-0731",
                "contextWindowTokens": 65_536,
            }
        }
    })

    resolved = resolve_model_context_window(
        config,
        config.resolve_preset(),
        managed_catalog={
            "available": True,
            "models": [{"id": "deepseek-v4-flash-0731", "context_window": 1_000_000}],
        },
    )

    assert resolved == 1_000_000


def test_versioned_managed_model_uses_known_family_window() -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "mona_managed",
                "model": "deepseek-v4-flash-0731",
                "contextWindowTokens": 65_536,
            }
        }
    })

    resolved = resolve_model_context_window(
        config,
        config.resolve_preset(),
        managed_catalog={
            "available": True,
            "models": [{"id": "deepseek-v4-flash-0731"}],
        },
    )

    assert resolved == 1_000_000


def test_unknown_model_ignores_legacy_config_and_uses_product_default() -> None:
    config = Config.model_validate({
        "agents": {
            "defaults": {
                "provider": "openrouter",
                "model": "vendor/unknown-model",
                "contextWindowTokens": 96_000,
            }
        },
        "providers": {"openrouter": {"apiKey": "test-key"}},
    })

    assert resolve_model_context_window(config, config.resolve_preset()) == 1_000_000
    assert resolve_model_context_window_details(
        config,
        config.resolve_preset(),
    ).source == "default"
    with patch("mona.providers.factory.make_provider", return_value=MagicMock()):
        snapshot = build_provider_snapshot(config)
    assert snapshot.context_window_tokens == 1_000_000
    assert snapshot.context_window_verified is False
    assert snapshot.context_provider == "openrouter"


def test_provider_discovery_window_is_verified_in_runtime_snapshot() -> None:
    config = Config.model_validate({
        "agents": {"defaults": {"provider": "openrouter", "model": "vendor/model"}},
        "providers": {"openrouter": {"discoveredModels": [
            {"id": "vendor/model", "context_window": 128_000},
        ]}},
    })
    with patch("mona.providers.factory.make_provider", return_value=MagicMock()):
        snapshot = build_provider_snapshot(config)
    assert snapshot.context_window_tokens == 128_000
    assert snapshot.context_window_verified is True
