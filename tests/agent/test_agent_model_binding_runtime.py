from __future__ import annotations

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.model_binding import build_agent_model_snapshot
from mona.agent.partners import AgentDefinition
from mona.agent.user_config import load_agent_user_config, save_agent_user_config
from mona.config.schema import AgentModelBinding, Config, ModelPresetConfig
from mona.providers.context_window import DEFAULT_CONTEXT_WINDOW_TOKENS
from mona.providers.factory import build_provider_snapshot
from mona.providers.fallback_provider import FallbackProvider
from mona.providers.native_work_provider import NativeWorkProvider


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "mona.agent.user_config.get_agent_user_config_path",
        lambda agent_id: tmp_path / agent_id / "config.json",
    )
    monkeypatch.setattr(
        "mona.webui.settings_api._managed_model_catalog",
        lambda: {"available": False, "models": []},
    )
    value = Config()
    value.agents.defaults.workspace = str(tmp_path)
    value.agents.defaults.provider = "openai"
    value.agents.defaults.model = "api-fixture"
    value.agents.defaults.max_tokens = 4096
    value.providers.openai.api_key = "synthetic-local-fixture"
    value.providers.openai.enabled_models = ["api-fixture"]
    value.providers.openai.discovered_models = [{
        "id": "api-fixture", "type": "chat", "reasoning_efforts": ["high"],
    }]
    value.development.enabled_engines = ["codex", "claude", "codebuddy"]
    return value


def _bind(agent_id, executor="codex", model="agent-native", effort="high"):
    current = load_agent_user_config(agent_id)
    return save_agent_user_config(agent_id, {"model_binding": {
        "executor": executor, "model": model, "effort": effort,
    }}, expected_revision=current.revision)


def _loop(config):
    return AgentLoop.from_config(
        config,
        runtime_config_loader=lambda: config,
        provider_snapshot_loader=lambda **kwargs: build_provider_snapshot(config, **kwargs),
    )


def test_native_binding_uses_local_config_and_clears_unrelated_window(config, tmp_path):
    config.agents.defaults.executor = "codex"
    config.agents.defaults.native_model = "global-native"
    config.agents.defaults.native_reasoning_effort = "low"
    config.agents.defaults.native_context_window_tokens = 32768
    before = config.model_dump()
    binding = AgentModelBinding(executor="claude", model="agent-native", effort="high")

    snapshot = build_agent_model_snapshot(config, binding, tmp_path / "job")

    assert isinstance(snapshot.provider, NativeWorkProvider)
    assert snapshot.provider.executor.value == "claude"
    assert snapshot.model == "agent-native"
    assert snapshot.provider.workspace == (tmp_path / "job").resolve()
    assert snapshot.provider.generation.reasoning_effort == "high"
    assert snapshot.context_window_tokens == DEFAULT_CONTEXT_WINDOW_TOKENS
    assert snapshot.context_window_verified is False
    assert config.model_dump() == before


def test_api_binding_always_uses_mona_and_work_generation_settings(config, tmp_path):
    config.agents.defaults.executor = "codex"
    config.agents.defaults.native_model = "global-native"
    config.providers.openai.model_engines = {"api-fixture": "claude"}
    config.development.coding.max_tokens = 9999
    config.agents.defaults.fallback_models = ["other-global-api"]
    binding = AgentModelBinding(
        executor="mona", provider="openai", model="api-fixture", effort="high",
    )

    snapshot = build_agent_model_snapshot(config, binding, tmp_path)

    assert not isinstance(snapshot.provider, NativeWorkProvider)
    assert not isinstance(snapshot.provider, FallbackProvider)
    assert snapshot.model == "api-fixture"
    assert snapshot.provider.generation.max_tokens == 4096
    assert snapshot.provider.generation.reasoning_effort == "high"
    assert config.agents.defaults.executor == "codex"
    assert config.agents.defaults.fallback_models == ["other-global-api"]


def test_mona_binding_survives_default_changes_and_restores_current_default(config):
    _bind("mona")
    loop = _loop(config)
    config.agents.defaults.executor = "claude"
    config.agents.defaults.native_model = "new-global-native"

    loop._refresh_provider_snapshot()

    assert isinstance(loop.provider, NativeWorkProvider)
    assert loop.provider.executor.value == "codex"
    assert loop.model == "agent-native"
    current = load_agent_user_config("mona")
    save_agent_user_config("mona", {"model_binding": None, "model_preset": None},
                           expected_revision=current.revision)
    loop._refresh_mona_user_config()
    assert loop.provider.executor.value == "claude"
    assert loop.model == "new-global-native"


def test_named_agents_resolve_independent_bindings_without_changing_mona(config):
    _bind("agent.one", executor="codex", model="one-native")
    _bind("agent.two", executor="claude", model="two-native", effort=None)
    loop = _loop(config)
    main_provider = loop.provider

    first = loop._resolve_named_agent_runtime(AgentDefinition(id="agent.one", display_name="One"))
    second = loop._resolve_named_agent_runtime(AgentDefinition(id="agent.two", display_name="Two"))

    assert first[0].executor.value == "codex" and first[1] == "one-native"
    assert first[2].reasoning_effort == "high"
    assert first[3].model == "one-native" and first[3].context_provider == "native:codex"
    assert second[0].executor.value == "claude" and second[1] == "two-native"
    assert second[0].generation.reasoning_effort is None
    assert first[0].config is not second[0].config
    assert loop.provider is main_provider and loop.model == "api-fixture"
    assert config.agents.defaults.executor == "mona"


def test_named_agent_inheritance_does_not_take_mona_private_binding(config):
    _bind("mona")
    loop = _loop(config)

    provider, model, _, _ = loop._resolve_named_agent_runtime(
        AgentDefinition(id="agent.inherited", display_name="Inherited"),
    )

    assert not isinstance(provider, NativeWorkProvider)
    assert model == "api-fixture"
    assert loop.provider.executor.value == "codex"


def test_missing_api_binding_fails_without_falling_back_to_default(config, tmp_path):
    binding = AgentModelBinding(executor="mona", provider="openai", model="missing")

    with pytest.raises(ValueError, match="绑定的模型来源不可用"):
        build_agent_model_snapshot(config, binding, tmp_path)


@pytest.mark.parametrize("direct_partner", [False, True])
def test_legacy_agent_preset_stays_pinned_when_global_engine_changes(config, direct_partner):
    from types import SimpleNamespace

    from mona.agent.partner_loop import PartnerAgentLoop

    config.model_presets["review"] = ModelPresetConfig(model="review-api", provider="openai")
    agent_id = "agent.preset" if direct_partner else "mona"
    save_agent_user_config(agent_id, {"model_preset": "review"}, expected_revision=0)
    main = _loop(config)
    if direct_partner:
        definition = AgentDefinition(id=agent_id, display_name="Review")
        loop = PartnerAgentLoop(
            agent_id=agent_id,
            registry=SimpleNamespace(require=lambda _: definition, resolve_skill_dirs=lambda _: []),
            bus=main.bus, provider=main.provider, model=main.model, workspace=main.workspace,
            model_presets=main.model_presets, preset_snapshot_loader=main._preset_snapshot_loader,
            runtime_config_loader=lambda: config,
            provider_snapshot_loader=lambda: build_provider_snapshot(config),
        )
    else:
        loop = main
    config.agents.defaults.executor = "codex"
    config.agents.defaults.native_model = "new-global-model"

    loop._refresh_provider_snapshot()

    assert not isinstance(loop.provider, NativeWorkProvider)
    assert loop.model == "review-api" and loop.model_preset == "review"
    if not direct_partner:
        current = load_agent_user_config(agent_id)
        save_agent_user_config(agent_id, {"model_preset": None}, expected_revision=current.revision)
        loop._refresh_mona_user_config()
        assert loop.provider.executor.value == "codex"
        assert loop.model == "new-global-model"
