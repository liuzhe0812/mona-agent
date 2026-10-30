"""Platform model adapters; neither API configuration nor credentials enter a tool sandbox."""
from __future__ import annotations

import json
from pathlib import Path

from mona.config.schema import Config, HostedWorkConfig, HostedWorkModel, ModelPresetConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_access import HostedAPIProvider


def create_provider(config: HostedWorkConfig, selection: HostedWorkModel, empty_native_cwd: Path):
    if selection.source == "mona":
        provider = HostedAPIProvider(config, selection)
    else:
        from mona.config.schema import _resolve_tool_config_refs
        from mona.providers.native_work_provider import NativeWorkProvider

        path = Path(selection.native_config_path)
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise WorkError("native_unavailable", "平台尚未配置该模型来源。", 503)
        _resolve_tool_config_refs()
        native_config = Config.model_validate(json.loads(path.read_text(encoding="utf-8")))
        native_config.agents.defaults.executor = "codex" if selection.source == "codex" else "codebuddy"
        native_config.agents.defaults.native_model = selection.model
        native_config.agents.defaults.native_reasoning_effort = selection.reasoning_effort
        native_config.agents.defaults.fallback_models = []
        # This is a trusted, empty engine cwd, not the user-controlled workspace.
        # Existing Work adapters disable native filesystem/shell/MCP tools and
        # return all tool requests to the sandbox-backed registry below.
        native_home = path.parent / "development" / "native" / native_config.agents.defaults.executor
        provider = NativeWorkProvider(native_config, empty_native_cwd, native_home=native_home)
    provider._CHAT_RETRY_DELAYS = ()
    provider.generation = ModelPresetConfig(model=selection.model, max_tokens=selection.max_output_tokens,
                                            reasoning_effort=selection.reasoning_effort).to_generation_settings()
    return provider
