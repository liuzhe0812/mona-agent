"""Production wiring for Qiniu-backed official expert distribution."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mona.agent.expert_catalog import ExpertCatalogClient
from mona.agent.expert_installer import ExpertInstaller, ExpertInstallProgress
from mona.agent.expert_jobs import ExpertInstallJobManager
from mona.agent.package_store import AgentPackageStore
from mona.config.loader import load_config
from mona.config.paths import (
    get_agent_packages_dir,
    get_managed_runtimes_dir,
    get_packages_dir,
)
from mona.distribution import DistributionSettings
from mona.providers.image_generation import image_gen_provider_configs
from mona.providers.video_generation import video_gen_provider_configs
from mona.runtime.catalog import RuntimeCatalogClient, RuntimeInstaller
from mona.runtime.download import VerifiedDownloader
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.python_env import PythonEnvironmentBuilder


def build_official_expert_jobs(
    *,
    registry: Any,
    workspace: Path,
    bus: Any = None,
    subagent_manager: Any = None,
    sessions: Any = None,
    settings: DistributionSettings | None = None,
) -> ExpertInstallJobManager:
    settings = settings or DistributionSettings.load()
    packages_root = get_packages_dir()
    known_tool_names = _known_partner_tools(
        workspace,
        bus=bus,
        subagent_manager=subagent_manager,
        sessions=sessions,
    )
    agent_store = AgentPackageStore(get_agent_packages_dir())
    catalog_client = ExpertCatalogClient(
        list(settings.expert_catalog_urls),
        packages_root / "catalogs" / "experts.json",
    )
    runtime_root = get_managed_runtimes_dir()
    runtime_store = RuntimeComponentStore(runtime_root)
    python_builder = PythonEnvironmentBuilder(runtime_root, runtime_store)
    runtime_installer = RuntimeInstaller(
        catalog_client=RuntimeCatalogClient(
            list(settings.runtime_catalog_urls),
            packages_root / "catalogs" / "runtimes.json",
        ),
        downloader=VerifiedDownloader(),
        store=runtime_store,
        cache_dir=packages_root / "downloads" / "runtimes",
        python_environment_builder=python_builder,
    )

    async def install_runtime_packs(refs: list[str], progress: Any = None) -> None:
        def report(ref: str, current: int, total: int) -> None:
            if progress is not None:
                progress(
                    ExpertInstallProgress(
                        stage="runtime",
                        downloaded_bytes=current,
                        total_bytes=total,
                        detail=ref,
                    )
                )

        await runtime_installer.ensure_packs(refs, report)
        from mona.runtime.agent_env import AgentEnvironmentManager

        await AgentEnvironmentManager(
            runtime_root,
            runtime_installer=runtime_installer,
        ).prepare_packs(refs)

    installer = ExpertInstaller(
        catalog_client=catalog_client,
        downloader=VerifiedDownloader(),
        package_store=agent_store,
        download_cache_dir=packages_root / "downloads" / "agents",
        known_tool_names=known_tool_names,
        runtime_pack_installer=install_runtime_packs,
        registry_reload=registry.reload,
    )
    return ExpertInstallJobManager(
        catalog_client=catalog_client,
        package_store=agent_store,
        state_path=packages_root / "jobs" / "expert-installs.json",
        installer=installer,
        installed_definition=registry.get,
        unavailable_reason="官方专家服务暂不可用",
    )


def _known_partner_tools(
    workspace: Path,
    *,
    bus: Any,
    subagent_manager: Any,
    sessions: Any,
) -> set[str]:
    from mona.agent.tools.context import ToolContext
    from mona.agent.tools.loader import ToolLoader
    from mona.agent.tools.registry import ToolRegistry

    config = load_config()
    # Compatibility probes platform support, not the user's current feature toggles.
    probe_tools = config.tools.model_copy(deep=True)
    probe_tools.image_generation.enabled = True
    probe_tools.video_generation.enabled = True
    registry = ToolRegistry()
    ToolLoader().load(
        ToolContext(
            config=probe_tools,
            workspace=str(workspace),
            bus=bus,
            subagent_manager=subagent_manager,
            cron_service=getattr(subagent_manager, "cron_service", None),
            sessions=sessions,
            image_generation_provider_configs=image_gen_provider_configs(config),
            video_generation_provider_configs=video_gen_provider_configs(config),
            timezone=config.agents.defaults.timezone,
            agent_id="com.mona.package-probe",
        ),
        registry,
        scope="subagent",
    )
    return set(registry.tool_names)


__all__ = ["build_official_expert_jobs"]
