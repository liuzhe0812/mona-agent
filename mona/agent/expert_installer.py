"""End-to-end official expert download, verification and activation service."""

from __future__ import annotations

import inspect
import platform
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from loguru import logger
from packaging.version import InvalidVersion, Version

import mona
from mona.agent.expert_catalog import ExpertCatalogClient
from mona.agent.package_store import (
    ActiveAgentPackage,
    AgentPackageStore,
    ExpertCatalogEntry,
    InstalledAgentPackage,
)
from mona.runtime.download import ProgressCallback, VerifiedDownloader


class ExpertInstallError(RuntimeError):
    """Raised when an expert cannot safely become active."""


@dataclass(frozen=True, slots=True)
class ExpertInstallProgress:
    stage: str
    downloaded_bytes: int = 0
    total_bytes: int = 0
    detail: str = ""


@dataclass(frozen=True, slots=True)
class ExpertInstallResult:
    entry: ExpertCatalogEntry
    package: InstalledAgentPackage
    cached_download: bool


ProgressReporter = Callable[[ExpertInstallProgress], None]
RuntimePackInstaller = Callable[[list[str], ProgressReporter | None], Awaitable[None]]


def _current_architecture() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(
        machine,
        machine,
    )


class ExpertInstaller:
    """Install one official expert without exposing incomplete packages."""

    def __init__(
        self,
        *,
        catalog_client: ExpertCatalogClient,
        downloader: VerifiedDownloader,
        package_store: AgentPackageStore,
        download_cache_dir: Path,
        known_tool_names: set[str],
        runtime_pack_installer: RuntimePackInstaller | None = None,
        registry_reload: Callable[[], object] | None = None,
        mona_version: str = mona.__version__,
        current_platform: str = sys.platform,
        current_architecture: str | None = None,
    ) -> None:
        self.catalog_client = catalog_client
        self.downloader = downloader
        self.package_store = package_store
        self.download_cache_dir = download_cache_dir
        self.known_tool_names = known_tool_names
        self.runtime_pack_installer = runtime_pack_installer
        self.registry_reload = registry_reload
        self.mona_version = mona_version
        self.current_platform = current_platform
        self.current_architecture = current_architecture or _current_architecture()

    async def install(
        self,
        expert_id: str,
        *,
        version: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> ExpertInstallResult:
        self._report(progress, "catalog")
        snapshot = await self.catalog_client.fetch()
        entry = self._select_entry(snapshot.catalog.experts, expert_id, version)
        self._validate_compatibility(entry)
        previous_active = self.package_store.active(entry.id)
        archive = self.download_cache_dir / entry.id / f"{entry.version}.zip"
        self._report(progress, "downloading", total_bytes=entry.size)
        download = await self.downloader.download(
            [str(entry.download_url), *(str(url) for url in entry.mirrors)],
            archive,
            expected_sha256=entry.sha256,
            expected_size=entry.size,
            progress=self._download_progress(progress, entry.size),
        )
        self._report(progress, "verifying", entry.size, entry.size)
        package = self.package_store.install_archive(
            archive,
            expected_sha256=entry.sha256,
            expected_agent_id=entry.id,
            expected_version=entry.version,
            activate=False,
        )
        if package.manifest.required_tools != entry.required_tools:
            raise ExpertInstallError("package requiredTools do not match catalog metadata")
        if package.manifest.runtime_packs != entry.runtime_packs:
            raise ExpertInstallError("package runtimePacks do not match catalog metadata")
        if entry.runtime_packs:
            if self.runtime_pack_installer is None:
                raise ExpertInstallError(
                    "expert package requires runtime packs that are not installed"
                )
            self._report(progress, "runtime", detail=", ".join(entry.runtime_packs))
            await self.runtime_pack_installer(entry.runtime_packs, progress)
        self.package_store.activate(entry.id, entry.version)
        activated = InstalledAgentPackage(
            manifest=package.manifest,
            package_root=package.package_root,
            sha256=package.sha256,
            activated=True,
        )
        try:
            if self.registry_reload is not None:
                result = self.registry_reload()
                if inspect.isawaitable(result):
                    await result
        except Exception as exc:
            await self._rollback_activation(entry, previous_active)
            raise ExpertInstallError("expert activation failed; previous version restored") from exc
        try:
            self.package_store.prune_inactive(entry.id)
        except Exception as exc:
            logger.warning("failed to prune old expert versions for {}: {}", entry.id, exc)
        self._report(progress, "ready", entry.size, entry.size)
        return ExpertInstallResult(
            entry=entry,
            package=activated,
            cached_download=download.cached,
        )

    async def _rollback_activation(
        self,
        entry: ExpertCatalogEntry,
        previous_active: tuple[ActiveAgentPackage, Path] | None,
    ) -> None:
        if previous_active is None:
            self.package_store.deactivate(entry.id, expected_version=entry.version)
        else:
            self.package_store.activate(entry.id, previous_active[0].version)
        if self.registry_reload is not None:
            try:
                result = self.registry_reload()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                pass

    def _validate_compatibility(self, entry: ExpertCatalogEntry) -> None:
        if entry.platforms and self.current_platform not in entry.platforms:
            raise ExpertInstallError(f"expert does not support platform {self.current_platform}")
        if entry.architectures and self.current_architecture not in entry.architectures:
            raise ExpertInstallError(
                f"expert does not support architecture {self.current_architecture}"
            )
        missing_tools = sorted(set(entry.required_tools) - self.known_tool_names)
        if missing_tools:
            raise ExpertInstallError(
                "expert requires a newer Mona tool set: " + ", ".join(missing_tools)
            )
        if entry.min_mona_version:
            try:
                if Version(self.mona_version) < Version(entry.min_mona_version):
                    raise ExpertInstallError(
                        f"expert requires Mona {entry.min_mona_version} or newer"
                    )
            except InvalidVersion as exc:
                raise ExpertInstallError("expert or client version metadata is invalid") from exc

    def compatibility_error(self, entry: ExpertCatalogEntry) -> str | None:
        try:
            self._validate_compatibility(entry)
        except ExpertInstallError as exc:
            return str(exc)
        return None

    @staticmethod
    def _select_entry(
        entries: list[ExpertCatalogEntry],
        expert_id: str,
        version: str | None,
    ) -> ExpertCatalogEntry:
        candidates = [
            entry
            for entry in entries
            if entry.id == expert_id and (version is None or entry.version == version)
        ]
        if not candidates:
            raise ExpertInstallError(f"expert {expert_id!r} is not in the catalog")
        if version is not None:
            return candidates[0]
        try:
            return max(candidates, key=lambda entry: Version(entry.version))
        except InvalidVersion as exc:
            raise ExpertInstallError("expert catalog contains an invalid version") from exc

    @staticmethod
    def _report(
        reporter: ProgressReporter | None,
        stage: str,
        downloaded_bytes: int = 0,
        total_bytes: int = 0,
        detail: str = "",
    ) -> None:
        if reporter:
            reporter(
                ExpertInstallProgress(
                    stage=stage,
                    downloaded_bytes=downloaded_bytes,
                    total_bytes=total_bytes,
                    detail=detail,
                )
            )

    @staticmethod
    def _download_progress(
        reporter: ProgressReporter | None,
        total_bytes: int,
    ) -> ProgressCallback | None:
        if reporter is None:
            return None
        return lambda current, _total: reporter(
            ExpertInstallProgress(
                stage="downloading",
                downloaded_bytes=current,
                total_bytes=total_bytes,
            )
        )


__all__ = [
    "ExpertInstallError",
    "ExpertInstallProgress",
    "ExpertInstallResult",
    "ExpertInstaller",
]
