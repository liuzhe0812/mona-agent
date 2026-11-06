"""Platform model adapters; neither API configuration nor credentials enter a tool sandbox."""
from __future__ import annotations

import json
from pathlib import Path

from mona.config.schema import Config, HostedWorkConfig, HostedWorkModel, ModelPresetConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_access import HostedAPIProvider
from mona.hosted_work.model_policy import require_model_available


def codex_operator(config: HostedWorkConfig):
    from mona.hosted_work.admin import CodexAdmin

    path = Path(config.operator_config_path)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise WorkError("native_unavailable", "平台尚未配置该模型来源。", 503)
    try:
        return CodexAdmin(path)
    except OSError as exc:
        raise WorkError("native_unavailable", "平台尚未配置该模型来源。", 503) from exc


def codex_native_home(admin) -> Path:
    return admin._scoped("development/native/codex")


def create_provider(config: HostedWorkConfig, selection: HostedWorkModel, empty_native_cwd: Path, *,
                    billing_authorized: bool = False):
    require_model_available(selection, config, billing_authorized=billing_authorized)
    if selection.source == "mona":
        provider = HostedAPIProvider(config, selection)
    elif selection.source == "codex":
        from mona.config.schema import _resolve_tool_config_refs
        from mona.hosted_work.native_provider import HostedNativeWorkProvider

        admin = codex_operator(config)
        profile = admin.profile(config.codex)
        _resolve_tool_config_refs()
        native_config = Config()
        native_config.development.enabled_engines = ["codex"]
        native_config.development.codex_path = profile.command[0]
        native_config.agents.defaults.executor = "codex"
        native_config.agents.defaults.native_model = selection.model
        native_config.agents.defaults.native_reasoning_effort = selection.reasoning_effort
        native_config.agents.defaults.fallback_models = []
        provider = HostedNativeWorkProvider(native_config, empty_native_cwd, native_home=profile.home)
    else:
        from mona.config.schema import _resolve_tool_config_refs
        from mona.providers.native_work_provider import NativeWorkProvider

        path = Path(selection.native_config_path)
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise WorkError("native_unavailable", "平台尚未配置该模型来源。", 503)
        _resolve_tool_config_refs()
        native_config = Config.model_validate(json.loads(path.read_text(encoding="utf-8")))
        native_config.agents.defaults.executor = "codebuddy"
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
