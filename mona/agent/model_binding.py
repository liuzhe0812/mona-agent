"""Resolve an Agent's explicit model source without changing global defaults."""

from __future__ import annotations

from pathlib import Path

from mona.config.schema import AgentModelBinding, Config
from mona.providers.factory import ProviderSnapshot, build_provider_snapshot


def build_agent_model_snapshot(
    config: Config,
    binding: AgentModelBinding,
    workspace: Path,
) -> ProviderSnapshot:
    local = config.model_copy(deep=True)
    if binding.executor == "mona":
        from mona.development.model_selection import coding_models

        choice = next((
            item for item in coding_models(local, include_hidden=True)
            if (item["provider"], item["model"]) == (binding.provider, binding.model)
        ), None)
        if choice is None:
            raise ValueError("Agent 绑定的模型来源不可用，请在 Agent 设置中重新选择模型。")
        if binding.effort is not None and binding.effort not in (choice.get("reasoningEfforts") or []):
            raise ValueError("Agent 绑定的模型不支持所选思考强度，请重新选择模型。")
        local.agents.defaults.fallback_models = []
        preset = local.resolve_default_preset().model_copy(update={
            "provider": binding.provider,
            "model": binding.model,
            "reasoning_effort": binding.effort or choice.get("reasoningEffort"),
        })
        return build_provider_snapshot(local, preset=preset)

    defaults = local.agents.defaults
    # A different model must never reuse the global model's verified window.
    if (defaults.executor, defaults.native_model) != (binding.executor, binding.model):
        defaults.native_context_window_tokens = None
    defaults.executor = binding.executor
    defaults.native_model = binding.model
    defaults.native_reasoning_effort = binding.effort
    defaults.model_preset = None
    defaults.workspace = str(workspace)
    return build_provider_snapshot(local)
