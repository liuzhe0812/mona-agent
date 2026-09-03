"""Production wiring for Qiniu-backed managed runtime downloads."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import httpx

from mona.config.paths import (
    get_legacy_managed_runtimes_dir,
    get_managed_runtimes_dir,
    get_packages_dir,
    get_target_managed_runtimes_dir,
)
from mona.distribution import DistributionSettings
from mona.runtime.catalog import RuntimeCatalogClient, RuntimeInstaller
from mona.runtime.download import VerifiedDownloader
from mona.runtime.jobs import RuntimeInstallJob, RuntimeInstallJobManager
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.python_env import PythonEnvironmentBuilder

_runtime_jobs: RuntimeInstallJobManager | None = None


def _auto_download_enabled() -> bool:
    from mona.config.loader import load_config

    return load_config().runtime.auto_download


def _migration_status() -> dict[str, object]:
    from mona.runtime.migration import runtime_migration_status

    return runtime_migration_status(
        get_legacy_managed_runtimes_dir(),
        get_target_managed_runtimes_dir(),
    )


def _cleanup_legacy() -> dict[str, int]:
    from mona.runtime.migration import cleanup_legacy_runtime_root

    return cleanup_legacy_runtime_root(
        get_legacy_managed_runtimes_dir(),
        get_target_managed_runtimes_dir(),
    )


def build_official_runtime_installer(
    settings: DistributionSettings | None = None,
) -> RuntimeInstaller:
    settings = settings or DistributionSettings.load()
    packages_root = get_packages_dir()
    runtime_root = get_managed_runtimes_dir()
    store = RuntimeComponentStore(runtime_root)
    return RuntimeInstaller(
        catalog_client=RuntimeCatalogClient(
            list(settings.runtime_catalog_urls),
            packages_root / "catalogs" / "runtimes.json",
        ),
        downloader=VerifiedDownloader(),
        store=store,
        cache_dir=runtime_root / "downloads",
        python_environment_builder=PythonEnvironmentBuilder(runtime_root, store),
    )


def build_official_runtime_jobs(
    settings: DistributionSettings | None = None,
) -> RuntimeInstallJobManager:
    settings = settings or DistributionSettings.load()
    packages_root = get_packages_dir()
    runtime_root = get_managed_runtimes_dir()
    store = RuntimeComponentStore(runtime_root)
    client = RuntimeCatalogClient(
        list(settings.runtime_catalog_urls),
        packages_root / "catalogs" / "runtimes.json",
    )
    installer = build_official_runtime_installer(settings)
    return RuntimeInstallJobManager(
        catalog_client=client,
        component_store=store,
        state_path=runtime_root / "jobs" / "runtime-installs.json",
        installer=installer,
        unavailable_reason="官方运行组件服务暂不可用",
        auto_download_enabled=_auto_download_enabled,
        migration_status=_migration_status,
        cleanup_legacy=_cleanup_legacy,
    )


def get_official_runtime_jobs() -> RuntimeInstallJobManager:
    """Return the process-wide runtime job owner."""
    global _runtime_jobs
    if _runtime_jobs is None:
        _runtime_jobs = build_official_runtime_jobs()
    return _runtime_jobs


async def ensure_official_runtime_resource(
    resource: str,
    progress: Callable[[str, int, int], None] | None = None,
) -> RuntimeInstallJob:
    """Install a product resource through the shared user-facing job manager."""
    if os.environ.get("MONA_PROCESS_ROLE") == "services":
        return await _ensure_runtime_resource_via_gateway(resource, progress)
    job = await get_official_runtime_jobs().ensure(resource)
    if progress is not None:
        progress(job.pack_ref, job.downloaded_bytes, job.total_bytes)
    return job


async def _ensure_runtime_resource_via_gateway(
    resource: str,
    progress: Callable[[str, int, int], None] | None,
) -> RuntimeInstallJob:
    """Let Services request downloads from the Gateway-owned global manager."""
    from mona.channels.websocket import WebSocketConfig
    from mona.config.loader import load_config

    section = getattr(load_config().channels, "websocket", None)
    if hasattr(section, "model_dump"):
        section = section.model_dump()
    websocket = WebSocketConfig.model_validate(section if isinstance(section, dict) else {})
    secret = websocket.token_issue_secret.strip() or websocket.token.strip()
    headers = {"Authorization": f"Bearer {secret}"} if secret else {}
    base = f"http://127.0.0.1:{websocket.port}"
    timeout = httpx.Timeout(30.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        token = await _gateway_api_token(client, base, headers)
        auth = {"Authorization": f"Bearer {token}"}
        response = await client.get(
            f"{base}/api/runtimes/install/required",
            params={"component": resource},
            headers=auth,
        )
        _raise_gateway_error(response)
        job = RuntimeInstallJob.model_validate(response.json().get("job"))
        while job.state in {"queued", "running"}:
            if progress is not None:
                progress(job.pack_ref, job.downloaded_bytes, job.total_bytes)
            await asyncio.sleep(0.5)
            response = await client.get(
                f"{base}/api/runtimes/install/status",
                params={"job_id": job.job_id},
                headers=auth,
            )
            if response.status_code == 401:
                token = await _gateway_api_token(client, base, headers)
                auth = {"Authorization": f"Bearer {token}"}
                response = await client.get(
                    f"{base}/api/runtimes/install/status",
                    params={"job_id": job.job_id},
                    headers=auth,
                )
            _raise_gateway_error(response)
            job = RuntimeInstallJob.model_validate(response.json().get("job"))
    if progress is not None:
        progress(job.pack_ref, job.downloaded_bytes, job.total_bytes)
    if job.state != "completed":
        raise RuntimeError(job.error or "功能资源下载失败")
    return job


async def _gateway_api_token(
    client: httpx.AsyncClient, base: str, headers: dict[str, str]
) -> str:
    bootstrap = await client.get(f"{base}/webui/bootstrap", headers=headers)
    _raise_gateway_error(bootstrap)
    token = str(bootstrap.json().get("token") or "")
    if not token:
        raise RuntimeError("功能资源服务没有返回访问凭据")
    return token


def _raise_gateway_error(response: httpx.Response) -> None:
    if response.is_success:
        return
    message = response.text.strip() or "功能资源服务不可用"
    raise RuntimeError(message)


def ensure_official_runtime_resource_sync(resource: str) -> RuntimeInstallJob:
    """Run the shared async installer for legacy synchronous call sites."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(ensure_official_runtime_resource(resource))
    with ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(
            lambda: asyncio.run(ensure_official_runtime_resource(resource))
        ).result()
__all__ = [
    "build_official_runtime_installer",
    "build_official_runtime_jobs",
    "ensure_official_runtime_resource",
    "ensure_official_runtime_resource_sync",
    "get_official_runtime_jobs",
]
