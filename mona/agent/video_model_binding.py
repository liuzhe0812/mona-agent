"""Validate a video's model choice against Mona's existing model sources."""

from __future__ import annotations

import asyncio
from pathlib import Path

from mona.config.schema import AgentModelBinding, Config


async def validate_video_model_binding(raw: object, config: Config) -> dict | None:
    if raw is None:
        return None
    binding = AgentModelBinding.model_validate(raw)
    if binding.executor == "mona":
        from mona.development.model_selection import resolve_coding_model

        resolve_coding_model(config, binding.model, binding.provider, binding.effort, require_visible=True)
    else:
        from mona.config.paths import get_data_dir
        from mona.development.contracts import ExecutorId
        from mona.development.executors.codex import CodexExecutor
        from mona.development.executors.codex_policy import prepare_codex_profile
        from mona.development.executors.discovery import discover_executors
        from mona.development.executors.sdk import SDKExecutor
        from mona.development.executors.sdk_policy import prepare_sdk_profile

        development = config.development
        if binding.executor not in development.enabled_engines:
            raise ValueError("此模型来源已停用，请在模型设置中启用后重新选择。")
        probes = await asyncio.to_thread(discover_executors, development)
        discovery = next((item for item in probes if item.executor.value == binding.executor), None)
        if discovery is None or discovery.state != "detected" or not discovery.executable:
            raise ValueError("未找到此模型来源的本地程序，请在模型设置中检查连接。")
        executor = ExecutorId(binding.executor)
        # Use the same managed account home and probe context as model settings.
        root = get_data_dir() / "development" / "provider-context" / binding.executor
        root.mkdir(parents=True, exist_ok=True)
        home = get_data_dir() / "development" / "native" / binding.executor
        if executor == ExecutorId.CODEX:
            host = CodexExecutor(prepare_codex_profile(Path(discovery.executable), home, root))
        else:
            host = SDKExecutor(prepare_sdk_profile(
                executor, Path(discovery.executable), home, root,
                credential_env=None if executor == ExecutorId.CLAUDE else development.codebuddy_api_key_env,
                codebuddy_environment=development.codebuddy_environment,
            ))
        try:
            async with asyncio.timeout(30):
                probe = await host.probe()
            if not probe.protocol_verified or probe.authentication == "required":
                raise ValueError("此模型来源尚未连接或需要登录，请在模型设置中检查连接。")
            choice = next((item for item in probe.model_details if item.id == binding.model), None)
            if choice is None:
                raise ValueError("此模型已不在可用列表中，请刷新模型设置后重新选择。")
            if binding.effort is not None and binding.effort not in choice.reasoning_efforts:
                raise ValueError("当前模型不支持所选思考强度，请重新选择。")
        finally:
            await host.shutdown()
    return binding.model_dump(mode="json", by_alias=False)
