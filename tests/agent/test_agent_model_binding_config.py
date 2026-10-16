from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

import mona.agent.user_config as user_config
from mona.agent.partners import AgentDefinition
from mona.agent.user_config import (
    AgentUserConfig,
    load_agent_user_config,
    resolve_effective_agent_config,
    save_agent_user_config,
)
from mona.config.schema import AgentModelBinding


def test_model_binding_has_camel_case_shape_and_source_constraints() -> None:
    binding = AgentModelBinding(
        executor="mona",
        model=" api-model ",
        provider="openai",
        effort="high",
    )

    assert binding.model_dump(by_alias=True) == {
        "executor": "mona",
        "model": "api-model",
        "provider": "openai",
        "effort": "high",
    }
    assert AgentModelBinding(executor="codex", model="codex-model").provider is None

    with pytest.raises(ValidationError, match="require a provider"):
        AgentModelBinding(executor="mona", model="api-model")
    with pytest.raises(ValidationError, match="Only Mona"):
        AgentModelBinding(executor="claude", model="claude-model", provider="openai")
    with pytest.raises(ValidationError, match="model must not be empty"):
        AgentModelBinding(executor="codex", model="   ")


def test_agent_model_binding_round_trips_and_switches_legacy_selection(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "agent-config.json"
    monkeypatch.setattr(
        user_config,
        "get_agent_user_config_path",
        lambda _agent_id: config_path,
    )

    legacy = save_agent_user_config(
        "com.example.agent",
        {"model_preset": "review"},
        expected_revision=0,
    )
    assert legacy.model_binding is None

    saved = save_agent_user_config(
        "com.example.agent",
        {
            "model_binding": {
                "executor": "codex",
                "model": "codex-model",
                "effort": "high",
            }
        },
        expected_revision=legacy.revision,
    )
    assert saved.model_preset is None
    assert saved.model_binding == AgentModelBinding(
        executor="codex",
        model="codex-model",
        effort="high",
    )
    assert load_agent_user_config("com.example.agent").model_binding == saved.model_binding

    stored = json.loads(config_path.read_text(encoding="utf-8"))
    assert stored["modelPreset"] is None
    assert stored["modelBinding"] == {
        "executor": "codex",
        "model": "codex-model",
        "provider": None,
        "effort": "high",
    }
    effective = resolve_effective_agent_config(
        AgentDefinition(id="com.example.agent", display_name="Agent"),
        saved,
    )
    assert effective.model_binding == saved.model_binding
    assert effective.reasoning_effort == "high"

    selected_preset = save_agent_user_config(
        "com.example.agent",
        {"model_preset": "fast"},
        expected_revision=saved.revision,
    )
    assert selected_preset.model_preset == "fast"
    assert selected_preset.model_binding is None

    inherited = save_agent_user_config(
        "com.example.agent",
        {"model_binding": None, "model_preset": None},
        expected_revision=selected_preset.revision,
    )
    assert inherited.model_binding is None
    assert inherited.model_preset is None


def test_binding_effort_overrides_legacy_effort_even_when_unset() -> None:
    definition = AgentDefinition(id="com.example.agent", display_name="Agent")
    bound = AgentUserConfig(
        model_binding=AgentModelBinding(executor="codex", model="codex-model"),
        reasoning_effort="high",
    )

    assert resolve_effective_agent_config(definition, bound).reasoning_effort is None


def test_update_rejects_two_model_selections() -> None:
    config = AgentUserConfig()

    with pytest.raises(ValidationError, match="cannot both be set"):
        AgentUserConfig.model_validate(
            {
                **config.model_dump(),
                "model_preset": "review",
                "model_binding": {
                    "executor": "codex",
                    "model": "codex-model",
                },
            }
        )
