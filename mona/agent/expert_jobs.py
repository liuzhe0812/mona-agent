"""Persistent background jobs for official expert catalog installation."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from filelock import FileLock
from packaging.version import InvalidVersion, Version
from pydantic import Field

from mona.agent.expert_catalog import ExpertCatalogClient, ExpertCatalogSnapshot
from mona.agent.expert_installer import ExpertInstaller, ExpertInstallProgress
from mona.agent.package_store import AgentPackageStore, ExpertCatalogEntry
from mona.config.schema import Base


class ExpertInstallUnavailableError(RuntimeError):
    """Raised when the release has no expert installer configured."""


class ExpertInstallJob(Base):
    schema_version: int = 1
    job_id: str
    expert_id: str
    version: str | None = None
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    stage: str = "queued"
    downloaded_bytes: int = Field(default=0, ge=0)
    total_bytes: int = Field(default=0, ge=0)
    detail: str = ""
    error: str | None = None
    cached_download: bool | None = None
    installed_version: str | None = None
    created_at: int
    updated_at: int
    finished_at: int | None = None


class ExpertInstallJobManager:
    """Run one install per expert and expose restart-safe polling snapshots."""

    def __init__(
        self,
        *,
        catalog_client: ExpertCatalogClient,
        package_store: AgentPackageStore,
        state_path: Path,
        installer: ExpertInstaller | None,
        installed_definition: Callable[[str], object | None] | None = None,
        unavailable_reason: str = "官方专家服务暂不可用",
    ) -> None:
        self.catalog_client = catalog_client
        self.package_store = package_store
        self.state_path = state_path
        self.installer = installer
        self.installed_definition = installed_definition
        self.unavailable_reason = unavailable_reason
        self._jobs: dict[str, ExpertInstallJob] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._catalog_snapshot: ExpertCatalogSnapshot | None = None
        self._catalog_refresh_task: asyncio.Task[None] | None = None
        self._last_persisted = 0.0
        self._load()

    async def catalog_payload(self) -> dict[str, object]:
        snapshot = self._catalog_snapshot
        if snapshot is None:
            snapshot = self.catalog_client.load_cached_snapshot()
            if snapshot is None:
                snapshot = await self.catalog_client.fetch()
            self._catalog_snapshot = snapshot
            if snapshot.source == "cache":
                self._start_catalog_refresh()
        else:
            self._start_catalog_refresh()
        latest: dict[str, ExpertCatalogEntry] = {}
        for entry in snapshot.catalog.experts:
            current = latest.get(entry.id)
            if current is None or self._newer(entry.version, current.version):
                latest[entry.id] = entry
        experts: list[dict[str, object]] = []
        for entry in sorted(latest.values(), key=lambda item: item.display_name.casefold()):
            active = self.package_store.active(entry.id)
            definition = self.installed_definition(entry.id) if self.installed_definition else None
            installed_version = (
                active[0].version if active else getattr(definition, "package_version", None)
            )
            compatibility_error = (
                self.installer.compatibility_error(entry) if self.installer else None
            )
            experts.append(
                {
                    "id": entry.id,
                    "displayName": entry.display_name,
                    "description": entry.description,
                    "version": entry.version,
                    "minMonaVersion": entry.min_mona_version,
                    "downloadBytes": entry.size,
                    "runtimePacks": entry.runtime_packs,
                    "requiredTools": entry.required_tools,
                    "installed": installed_version is not None,
                    "installedVersion": installed_version,
                    "updateAvailable": bool(
                        installed_version and self._newer(entry.version, str(installed_version))
                    ),
                    "compatible": self.installer is not None and compatibility_error is None,
                    "unavailableReason": compatibility_error,
                }
            )
        return {
            "schemaVersion": 1,
            "generatedAt": snapshot.catalog.generated_at,
            "source": snapshot.source,
            "stale": snapshot.stale,
            "installEnabled": self.installer is not None,
            "installUnavailableReason": None if self.installer else self.unavailable_reason,
            "experts": experts,
        }

    def _start_catalog_refresh(self) -> None:
        if self._catalog_refresh_task is not None and not self._catalog_refresh_task.done():
            return
        task = asyncio.create_task(self._refresh_catalog())
        self._catalog_refresh_task = task
        task.add_done_callback(self._clear_catalog_refresh_task)

    async def _refresh_catalog(self) -> None:
        try:
            self._catalog_snapshot = await self.catalog_client.fetch()
        except Exception:
            # The already validated cache remains usable until a later refresh.
            return

    def _clear_catalog_refresh_task(self, task: asyncio.Task[None]) -> None:
        if self._catalog_refresh_task is task:
            self._catalog_refresh_task = None

    def start(self, expert_id: str, version: str | None = None) -> ExpertInstallJob:
        if self.installer is None:
            raise ExpertInstallUnavailableError(self.unavailable_reason)
        expert_id = expert_id.strip()
        if not expert_id:
            raise ValueError("expert_id is required")
        for job in self._jobs.values():
            if (
                job.expert_id == expert_id
                and job.version == version
                and job.state in {"queued", "running"}
            ):
                return job.model_copy(deep=True)
        now = _now_ms()
        job = ExpertInstallJob(
            jobId=uuid.uuid4().hex,
            expertId=expert_id,
            version=version,
            state="queued",
            createdAt=now,
            updatedAt=now,
        )
        self._jobs[job.job_id] = job
        self._tasks[job.job_id] = asyncio.create_task(self._run(job.job_id))
        self._prune()
        self._persist(force=True)
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> ExpertInstallJob:
        try:
            return self._jobs[job_id].model_copy(deep=True)
        except KeyError as exc:
            raise KeyError("expert install job not found") from exc

    def list(self) -> list[ExpertInstallJob]:
        return [
            job.model_copy(deep=True)
            for job in sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)
        ]

    async def cancel(self, job_id: str) -> ExpertInstallJob:
        job = self._jobs.get(job_id)
        task = self._tasks.get(job_id)
        if job is None:
            raise KeyError("expert install job not found")
        if task is None or task.done() or job.state not in {"queued", "running"}:
            raise ValueError("expert install job is not running")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return self.get(job_id)

    async def _run(self, job_id: str) -> None:
        job = self._jobs[job_id]
        installer = self.installer
        if installer is None:
            return
        job.state = "running"
        job.stage = "catalog"
        job.updated_at = _now_ms()
        self._persist(force=True)

        def progress(value: ExpertInstallProgress) -> None:
            job.stage = value.stage
            job.downloaded_bytes = max(0, value.downloaded_bytes)
            job.total_bytes = max(0, value.total_bytes)
            job.detail = value.detail
            job.updated_at = _now_ms()
            self._persist()

        try:
            result = await installer.install(
                job.expert_id,
                version=job.version,
                progress=progress,
            )
            job.state = "completed"
            job.stage = "ready"
            job.cached_download = result.cached_download
            job.installed_version = result.entry.version
        except asyncio.CancelledError:
            job.state = "cancelled"
            job.stage = "cancelled"
            job.error = "安装已取消，可稍后继续下载"
        except Exception as exc:
            job.state = "failed"
            job.stage = "failed"
            job.error = str(exc)[:2_000]
        finally:
            job.updated_at = _now_ms()
            job.finished_at = job.updated_at
            self._persist(force=True)

    def _load(self) -> None:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        rows = payload.get("jobs") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return
        recovered = False
        for raw in rows[-50:]:
            try:
                job = ExpertInstallJob.model_validate(raw)
            except ValueError:
                continue
            if job.state in {"queued", "running"}:
                recovered = True
                job.state = "failed"
                job.stage = "failed"
                job.error = "应用在安装完成前退出，可重新开始并断点续传"
                job.updated_at = _now_ms()
                job.finished_at = job.updated_at
            self._jobs[job.job_id] = job
        if recovered:
            self._persist(force=True)

    def _persist(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_persisted < 0.5:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.state_path) + ".lock", timeout=30):
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.state_path.name}.", dir=self.state_path.parent
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(
                        {
                            "schemaVersion": 1,
                            "jobs": [
                                job.model_dump(by_alias=True, mode="json")
                                for job in self._jobs.values()
                            ],
                        },
                        handle,
                        ensure_ascii=False,
                        indent=2,
                        sort_keys=True,
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.state_path)
                self._last_persisted = now
            finally:
                temporary.unlink(missing_ok=True)

    def _prune(self) -> None:
        terminal = sorted(
            (job for job in self._jobs.values() if job.finished_at is not None),
            key=lambda item: item.updated_at,
            reverse=True,
        )
        for stale in terminal[50:]:
            self._jobs.pop(stale.job_id, None)
            self._tasks.pop(stale.job_id, None)

    @staticmethod
    def _newer(candidate: str, current: str) -> bool:
        try:
            return Version(candidate) > Version(current)
        except InvalidVersion:
            return candidate > current


def _now_ms() -> int:
    return int(time.time() * 1_000)


__all__ = [
    "ExpertInstallJob",
    "ExpertInstallJobManager",
    "ExpertInstallUnavailableError",
]
