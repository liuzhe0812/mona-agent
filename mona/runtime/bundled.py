"""Verified offline seed for the existing managed runtime component store."""

from __future__ import annotations

import hashlib
import os
import platform
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base
from mona.runtime.manager import (
    ActiveRuntimeComponent,
    RuntimeComponentManifest,
    RuntimeComponentStore,
    RuntimeManagerError,
)
from mona.runtime.python_env import PythonEnvironmentBuilder
from mona.runtime.skill_env import DEFAULT_NODE_BASE_REF, DEFAULT_PYTHON_BASE_REF

COMMON_PYTHON_PACK_REF = "python-common@1.0.0"
BUNDLED_RUNTIME_REFS = frozenset({DEFAULT_PYTHON_BASE_REF, DEFAULT_NODE_BASE_REF, COMMON_PYTHON_PACK_REF})


class BundledRuntimeComponent(Base):
    archive: str
    size: int = Field(gt=0)
    sha256: str
    manifest: RuntimeComponentManifest

    @field_validator("archive")
    @classmethod
    def _archive(cls, value: str) -> str:
        RuntimeComponentManifest._validate_entrypoints({"archive": value})
        if not value.endswith(".zip"):
            raise ValueError("bundled runtime must be a ZIP archive")
        return value

    @field_validator("sha256")
    @classmethod
    def _sha256(cls, value: str) -> str:
        return ActiveRuntimeComponent._validate_sha256(value)


class BundledRuntimeManifest(Base):
    schema_version: Literal[1] = 1
    platform: Literal["win32", "darwin"]
    architecture: Literal["x64", "arm64"]
    components: list[BundledRuntimeComponent] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def _components(self) -> BundledRuntimeManifest:
        refs = {f"{entry.manifest.id}@{entry.manifest.version}" for entry in self.components}
        if refs != BUNDLED_RUNTIME_REFS:
            raise ValueError("bundled runtimes must contain the Python base, Node base and common Python pack")
        if len({entry.archive for entry in self.components}) != len(self.components):
            raise ValueError("bundled runtime archive names must be unique")
        for entry in self.components:
            if any(ref not in refs for ref in entry.manifest.dependencies):
                raise ValueError("bundled runtime dependency is missing")
        return self


@dataclass(frozen=True)
class BundledRuntimePayload:
    root: Path
    manifest: BundledRuntimeManifest

    @property
    def refs(self) -> list[str]:
        return [f"{entry.manifest.id}@{entry.manifest.version}" for entry in self.manifest.components]

    @property
    def python_refs(self) -> list[str]:
        return [f"{entry.manifest.id}@{entry.manifest.version}" for entry in self.manifest.components
                if "python" in entry.manifest.entrypoints or entry.manifest.python_requirements is not None]

    def archive_path(self, entry: BundledRuntimeComponent) -> Path:
        candidate = self.root / entry.archive
        path = candidate.resolve(strict=True)
        if not path.is_relative_to(self.root) or not path.is_file():
            raise RuntimeManagerError("bundled runtime archive escaped its resource directory")
        current = candidate
        while current != self.root:
            if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                raise RuntimeManagerError("bundled runtime archive must not follow filesystem links")
            current = current.parent
        return path

    def verify_archives(self) -> None:
        for entry in self.manifest.components:
            path = self.archive_path(entry)
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if path.stat().st_size != entry.size or digest.hexdigest() != entry.sha256:
                raise RuntimeManagerError(f"bundled runtime archive verification failed: {entry.manifest.id}")
            with zipfile.ZipFile(path) as archive:
                info = archive.getinfo("runtime-manifest.json")
                if info.file_size > 256 * 1024:
                    raise RuntimeManagerError("bundled runtime manifest exceeds size limit")
                actual = RuntimeComponentManifest.model_validate_json(archive.read(info))
                if actual != entry.manifest:
                    raise RuntimeManagerError("bundled runtime archive manifest does not match its receipt")

    def is_ready(self, store: RuntimeComponentStore, builder: PythonEnvironmentBuilder) -> bool:
        for entry in self.manifest.components:
            active = store.active(entry.manifest.id)
            if active is None or active[0] != entry.manifest:
                return False
            try:
                receipt = ActiveRuntimeComponent.model_validate_json((active[1] / "receipt.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return False
            if receipt.sha256 != entry.sha256:
                return False
        current = builder.current()
        return current is not None and set(self.python_refs) <= set(current.packs)


def bundled_runtime_root() -> Path | None:
    resources = os.environ.get("MONA_RESOURCES_DIR", "").strip()
    if resources:
        return Path(resources).expanduser().resolve() / "runtime-base"
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "desktop-resources" / "runtime-base"
    return None


def load_bundled_runtime(
    root: Path, *, current_platform: str = sys.platform,
    current_architecture: str | None = None, verify_archives: bool = True,
) -> BundledRuntimePayload:
    root = Path(root)
    if root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
        raise RuntimeManagerError("bundled runtime directory must not follow filesystem links")
    try:
        root = root.resolve(strict=True)
        path = root / "manifest.json"
        if path.is_symlink() or path.stat().st_size > 256 * 1024:
            raise RuntimeManagerError("bundled runtime manifest is invalid")
        manifest = BundledRuntimeManifest.model_validate_json(path.read_text(encoding="utf-8"))
        machine = (current_architecture or platform.machine()).lower()
        architecture = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(machine, machine)
        if manifest.platform != current_platform or manifest.architecture != architecture:
            raise RuntimeManagerError("bundled runtime platform or architecture does not match this system")
        payload = BundledRuntimePayload(root, manifest)
        if verify_archives:
            payload.verify_archives()
        return payload
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        raise RuntimeManagerError(f"bundled script runtime is invalid: {exc}") from exc
