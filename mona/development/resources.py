"""Per-source engine resources backed by the one shared runtime job owner."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from packaging.version import InvalidVersion, Version

from mona.config.schema import DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.codex_policy import _ENV_KEYS
from mona.development.executors.diagnostics import native_version
from mona.development.executors.discovery import discover_executors
from mona.development.executors.rpc import RpcError
from mona.development.store import ConflictError, DevelopmentError, NotFoundError
from mona.runtime.executors import EXECUTOR_RUNTIMES, managed_executor_path
from mona.runtime.manager import RuntimeManagerError, parse_runtime_pack_ref
from mona.runtime.official import get_official_runtime_jobs


def _executor(value: str) -> str:
    if value not in EXECUTOR_RUNTIMES:
        raise DevelopmentError("invalid_executor", "请选择支持的模型引擎。")
    return value


def _job(job) -> dict:
    return {"id": job.job_id, "state": job.state, "stage": job.stage,
        "downloadedBytes": job.downloaded_bytes, "totalBytes": job.total_bytes, "error": job.error}


async def resource_status(config: DevelopmentConfig, executor: str, *, refresh: bool = False) -> dict:
    executor = _executor(executor)
    manager = get_official_runtime_jobs()
    component, kind = EXECUTOR_RUNTIMES[executor]
    probe = next(item for item in discover_executors(config) if item.executor.value == executor)
    component_root = manager.component_store.root / "components" / component
    configured = getattr(config, f"{executor}_path")
    system_config = config.model_copy(update={f"{executor}_path": None}) if configured and Path(configured).resolve().is_relative_to(component_root.resolve()) else config
    system_probe = next(item for item in discover_executors(system_config, include_managed=False) if item.executor.value == executor)
    system_path = system_probe.executable if system_probe.state == "detected" and system_probe.executable and not Path(system_probe.executable).resolve().is_relative_to(component_root.resolve()) else None
    system = system_path is not None
    explicit = getattr(config, f"{executor}_path") is not None
    repair, active, managed_path = False, None, None
    try:
        active = manager.component_store.active(component)
        managed_path = managed_executor_path(executor, manager.component_store)
    except RuntimeManagerError:
        repair = True
    managed_version = active[0].version.split("+", 1)[0] if active else None
    system_version = None
    error = None
    reason = probe.reason
    for path, ownership in ((system_path, "system"), (managed_path, "managed")):
        if not path:
            continue
        try:
            version = await native_version(Path(path), probe.executor, cwd=Path(path).parent,
                env={key: value for key, value in os.environ.items() if key.upper() in _ENV_KEYS})
            if ownership == "system":
                system_version = version
            else:
                managed_version = version
        except RpcError:
            reason = "当前程序未通过版本检查，请重新检测或选择有效程序。"
    cached = manager.catalog_client.load_cached()
    catalog = cached.catalog if cached else None
    if refresh or catalog is None or manager._latest(catalog, kind) is None:
        try:
            catalog = await manager.catalog_client.fetch_resource(executor)
        except Exception as exc:
            from loguru import logger
            logger.warning("Engine release lookup failed for {} ({})", executor, type(exc).__name__)
            error = "暂时无法检查官方程序版本，请稍后重试。"
    entry = manager._latest(catalog, kind) if catalog else None
    latest_version = entry.version.split("+", 1)[0] if entry else None
    try:
        newer = bool(latest_version and managed_version and Version(latest_version) > Version(managed_version))
    except InvalidVersion:
        newer = False
    job = next((item for item in manager.list() if item.component == executor), None)
    ready = probe.state == "detected"
    managed = bool(active) or repair or component_root.exists()
    repair = repair or (managed and managed_path is None)
    return {"components": [{"executor": executor, "source": probe.source or "not_detected",
        "executable": probe.executable, "systemAvailable": system, "installed": ready,
        "systemExecutable": system_path, "systemVersion": system_version, "systemReason": system_probe.reason,
        "managedExecutable": str(managed_path) if managed_path else None, "managedVersion": managed_version,
        "managedInstalled": managed, "canPrepare": bool(entry and not managed), "canDelete": managed,
        "canUpdate": bool(entry and managed and newer),
        "repairRequired": repair or probe.error_code == "managed_runtime_invalid", "explicitPath": explicit,
        "packRef": f"{entry.id}@{entry.version}" if entry else None, "version": latest_version,
        "installedVersion": system_version if system else managed_version, "downloadBytes": entry.size if entry else 0,
        "reason": reason, "catalogError": error, "job": _job(job) if job else None}],
        "catalogAvailable": entry is not None or system}


async def prepare_resource(executor: str, pack_ref: str, config: DevelopmentConfig, *, repair: bool = False) -> dict:
    executor = _executor(executor)
    if parse_runtime_pack_ref(pack_ref)[0] != EXECUTOR_RUNTIMES[executor][0]:
        raise DevelopmentError("invalid_runtime_resource", "下载目标与模型引擎不一致。")
    manager = get_official_runtime_jobs()
    try:
        job = await manager.start(executor, repair=repair, expected_pack_ref=pack_ref, allow_system_install=True)
    except ValueError as exc:
        raise ConflictError("官方程序版本已变化，请刷新后重新安装。") from exc
    return {"installed": False, "job": _job(job)}


async def remove_managed_resource(executor: str, native, *, expected_version: str | None = None) -> dict:
    executor = _executor(executor)
    manager = get_official_runtime_jobs()
    component, _kind = EXECUTOR_RUNTIMES[executor]
    component_root = manager.component_store.root / "components" / component
    if any(job.component == executor and (job.state in {"queued", "running"} or
            (job.job_id in manager._tasks and not manager._tasks[job.job_id].done())) for job in manager.list()):
        raise ConflictError("此程序正在下载或更新，请先完成或取消操作，再删除。")
    async with manager._install_lock:
        from mona.development.settings import read_settings, update_settings
        settings = await asyncio.to_thread(read_settings)
        try:
            active = manager.component_store.active(component)
        except RuntimeManagerError:
            active = None
        if expected_version is not None and (not active or active[0].version.split("+", 1)[0] != expected_version):
            raise ConflictError("程序版本已变化，请刷新后重新删除。")
        async with native.managed_program_change(ExecutorId(executor), component_root):
            try:
                await asyncio.to_thread(manager.component_store.remove_component, component)
            except (OSError, RuntimeManagerError) as exc:
                raise DevelopmentError("engine_remove_failed", "Mona 管理的程序未删除完成，请确认它已停止使用后重试。") from exc
            configured = settings["values"].get(f"{executor}Path")
            if configured and Path(configured).resolve().is_relative_to(component_root.resolve()):
                try:
                    await asyncio.to_thread(update_settings, settings["revision"], {f"{executor}Path": None})
                except (OSError, DevelopmentError):
                    return {"deleted": True, "warning": "程序已删除，但旧路径设置未能清空。请清空程序路径并保存，以恢复自动检测。"}
    return {"deleted": True}


async def resource_job(executor: str, job_id: str, *, cancel: bool = False) -> dict:
    executor = _executor(executor)
    manager = get_official_runtime_jobs()
    try:
        job = manager.get(job_id)
    except KeyError as exc:
        raise NotFoundError() from exc
    if job.component != executor or parse_runtime_pack_ref(job.pack_ref)[0] != EXECUTOR_RUNTIMES[executor][0]:
        raise NotFoundError()
    if cancel and job.state in {"queued", "running"}:
        try:
            job = await manager.cancel(job_id)
        except ValueError:
            job = manager.get(job_id)
    return _job(job)
