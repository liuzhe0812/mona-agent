"""Versioned managed runtime component store."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from filelock import FileLock
from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base

RUNTIME_COMPONENT_SCHEMA_VERSION = 1
_COMPONENT_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_VERSION_RE = re.compile(r"^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,62}[0-9A-Za-z])?$")
_PACK_REF_RE = re.compile(
    r"^(?P<id>[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)@(?P<version>[0-9A-Za-z][0-9A-Za-z._+-]{0,63})$"
)


class RuntimeManagerError(RuntimeError):
    """Base class for managed runtime failures."""


class RuntimeComponentManifest(Base):
    """Manifest embedded in one immutable runtime component archive."""

    schema_version: int = RUNTIME_COMPONENT_SCHEMA_VERSION
    id: str
    version: str
    kind: str
    entrypoints: dict[str, str] = Field(default_factory=dict)
    dependencies: list[str] = Field(default_factory=list)
    python_requirements: str | None = None
    python_wheelhouse: str | None = None
    health_imports: list[str] = Field(default_factory=list)

    @field_validator("schema_version")
    @classmethod
    def _validate_schema(cls, value: int) -> int:
        if value != RUNTIME_COMPONENT_SCHEMA_VERSION:
            raise ValueError(f"unsupported runtime component schema version {value}")
        return value

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        value = value.strip()
        if not _COMPONENT_ID_RE.fullmatch(value) or ".." in value:
            raise ValueError(f"invalid runtime component id {value!r}")
        return value

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        value = value.strip()
        if not _VERSION_RE.fullmatch(value) or ".." in value:
            raise ValueError(f"invalid runtime component version {value!r}")
        return value

    @field_validator("entrypoints")
    @classmethod
    def _validate_entrypoints(cls, values: dict[str, str]) -> dict[str, str]:
        for key, raw in values.items():
            if not key or not _COMPONENT_ID_RE.fullmatch(key):
                raise ValueError(f"invalid runtime entrypoint name {key!r}")
            _safe_relative_path(raw)
        return values

    @field_validator("dependencies")
    @classmethod
    def _validate_dependencies(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            parse_runtime_pack_ref(value)
            if value not in result:
                result.append(value)
        return result

    @field_validator("python_requirements", "python_wheelhouse")
    @classmethod
    def _validate_optional_path(cls, value: str | None) -> str | None:
        if value is not None:
            _safe_relative_path(value)
        return value

    @field_validator("health_imports")
    @classmethod
    def _validate_health_imports(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", value):
                raise ValueError(f"invalid Python health import {value!r}")
            if value not in result:
                result.append(value)
        return result

    @model_validator(mode="after")
    def _validate_python_pack(self) -> RuntimeComponentManifest:
        configured = (self.python_requirements is not None, self.python_wheelhouse is not None)
        if configured[0] != configured[1]:
            raise ValueError("pythonRequirements and pythonWheelhouse must be declared together")
        return self


class ActiveRuntimeComponent(Base):
    schema_version: int = 1
    id: str
    version: str
    sha256: str
    installed_at: str

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return RuntimeComponentManifest._validate_id(value)

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        return RuntimeComponentManifest._validate_version(value)

    @field_validator("sha256")
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError("runtime sha256 must be 64 lowercase hex characters")
        return value


def parse_runtime_pack_ref(value: str) -> tuple[str, str]:
    match = _PACK_REF_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"invalid runtime pack reference {value!r}")
    return match.group("id"), match.group("version")


def _safe_relative_path(value: str) -> PurePosixPath:
    if not value or "\\" in value or "\x00" in value:
        raise ValueError(f"invalid runtime path {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        raise ValueError(f"unsafe runtime path {value!r}")
    return path


class RuntimeComponentStore:
    """Install immutable runtime component ZIPs and atomically activate versions."""

    def __init__(
        self,
        root: Path,
        *,
        max_files: int = 20_000,
        max_file_bytes: int = 512 * 1024 * 1024,
        max_uncompressed_bytes: int = 2 * 1024 * 1024 * 1024,
    ) -> None:
        self.root = root.resolve()
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.max_uncompressed_bytes = max_uncompressed_bytes

    def install_archive(
        self,
        archive: Path,
        *,
        activate: bool = True,
        replace: bool = False,
    ) -> RuntimeComponentManifest:
        archive_sha256 = _sha256_file(archive)
        with zipfile.ZipFile(archive) as bundle:
            manifest = self._manifest_from_bundle(bundle)
        component_root = self.root / "components" / manifest.id
        versions_dir = component_root / "versions"
        with FileLock(str(component_root) + ".install.lock", timeout=120):
            versions_dir.mkdir(parents=True, exist_ok=True)
            final = versions_dir / manifest.version
            if final.exists() and not replace:
                installed = self._read_manifest(final)
                receipt = self._read_receipt(final)
                if installed != manifest or receipt.sha256 != archive_sha256:
                    raise RuntimeManagerError(
                        f"immutable runtime {manifest.id}@{manifest.version} already differs"
                    )
                if activate:
                    self._activate(component_root, receipt)
                return installed
            staging = Path(tempfile.mkdtemp(prefix=".install-", dir=component_root))
            backup_parent: Path | None = None
            try:
                self._extract(archive, staging)
                installed = self._read_manifest(staging)
                if installed != manifest:
                    raise RuntimeManagerError("runtime manifest changed during extraction")
                self._validate_entrypoints(staging, installed)
                receipt = ActiveRuntimeComponent(
                    id=installed.id,
                    version=installed.version,
                    sha256=archive_sha256,
                    installedAt=datetime.now(timezone.utc).isoformat(),
                )
                self._write_json(staging / "receipt.json", receipt.model_dump(by_alias=True))
                if final.exists():
                    backup_parent = Path(
                        tempfile.mkdtemp(prefix=".repair-backup-", dir=component_root)
                    )
                    backup = backup_parent / "previous"
                    os.replace(final, backup)
                    try:
                        os.replace(staging, final)
                        if activate:
                            self._activate(component_root, receipt)
                    except Exception:
                        shutil.rmtree(final, ignore_errors=True)
                        os.replace(backup, final)
                        raise
                else:
                    os.replace(staging, final)
                    if activate:
                        self._activate(component_root, receipt)
                return installed
            finally:
                shutil.rmtree(staging, ignore_errors=True)
                if backup_parent is not None:
                    shutil.rmtree(backup_parent, ignore_errors=True)

    def active(self, component_id: str) -> tuple[RuntimeComponentManifest, Path] | None:
        component_id = RuntimeComponentManifest._validate_id(component_id)
        component_root = self.root / "components" / component_id
        try:
            pointer = ActiveRuntimeComponent.model_validate_json(
                (component_root / "current.json").read_text(encoding="utf-8")
            )
            if pointer.id != component_id:
                return None
            version_root = component_root / "versions" / pointer.version
            manifest = self._read_manifest(version_root)
            receipt = self._read_receipt(version_root)
            if (
                manifest.id != component_id
                or manifest.version != pointer.version
                or receipt != pointer
            ):
                return None
            self._validate_entrypoints(version_root, manifest)
            return manifest, version_root
        except (OSError, ValueError, RuntimeManagerError):
            return None

    def activate(self, component_id: str, version: str) -> ActiveRuntimeComponent:
        component_id = RuntimeComponentManifest._validate_id(component_id)
        version = RuntimeComponentManifest._validate_version(version)
        component_root = self.root / "components" / component_id
        with FileLock(str(component_root) + ".install.lock", timeout=120):
            version_root = component_root / "versions" / version
            manifest = self._read_manifest(version_root)
            receipt = self._read_receipt(version_root)
            if (
                manifest.id != component_id
                or receipt.id != component_id
                or receipt.version != version
            ):
                raise RuntimeManagerError("runtime component receipt identity mismatch")
            self._validate_entrypoints(version_root, manifest)
            self._activate(component_root, receipt)
            return receipt

    def deactivate(self, component_id: str) -> None:
        component_id = RuntimeComponentManifest._validate_id(component_id)
        component_root = self.root / "components" / component_id
        with FileLock(str(component_root) + ".install.lock", timeout=120):
            (component_root / "current.json").unlink(missing_ok=True)

    def prune_inactive(self, component_id: str, *, keep: int = 2) -> list[str]:
        if keep < 1:
            raise ValueError("keep must be at least 1")
        component_id = RuntimeComponentManifest._validate_id(component_id)
        component_root = self.root / "components" / component_id
        removed: list[str] = []
        with FileLock(str(component_root) + ".install.lock", timeout=120):
            active = self.active(component_id)
            versions: list[tuple[ActiveRuntimeComponent, Path]] = []
            versions_dir = component_root / "versions"
            if versions_dir.is_dir():
                for version_dir in versions_dir.iterdir():
                    if not version_dir.is_dir():
                        continue
                    try:
                        versions.append((self._read_receipt(version_dir), version_dir))
                    except RuntimeManagerError:
                        continue
            versions.sort(key=lambda item: item[0].installed_at, reverse=True)
            protected = {path for _receipt, path in versions[:keep]}
            if active is not None:
                protected.add(active[1])
            for receipt, version_dir in versions:
                if version_dir in protected:
                    continue
                shutil.rmtree(version_dir)
                removed.append(receipt.version)
        return removed

    @staticmethod
    def _manifest_from_bundle(bundle: zipfile.ZipFile) -> RuntimeComponentManifest:
        try:
            raw = bundle.read("runtime-manifest.json")
            return RuntimeComponentManifest.model_validate_json(raw)
        except (KeyError, ValueError) as exc:
            raise RuntimeManagerError(f"invalid runtime-manifest.json: {exc}") from exc

    @staticmethod
    def _read_manifest(root: Path) -> RuntimeComponentManifest:
        try:
            return RuntimeComponentManifest.model_validate_json(
                (root / "runtime-manifest.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as exc:
            raise RuntimeManagerError(f"invalid installed runtime manifest: {exc}") from exc

    @staticmethod
    def _read_receipt(root: Path) -> ActiveRuntimeComponent:
        try:
            return ActiveRuntimeComponent.model_validate_json(
                (root / "receipt.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as exc:
            raise RuntimeManagerError(f"invalid installed runtime receipt: {exc}") from exc

    def _extract(self, archive: Path, destination: Path) -> None:
        seen: set[str] = set()
        total = 0
        files = 0
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            for member in members:
                path = _safe_relative_path(member.filename.rstrip("/"))
                normalized = path.as_posix().casefold()
                if normalized in seen:
                    raise RuntimeManagerError(f"duplicate runtime archive path {member.filename!r}")
                seen.add(normalized)
                mode = (member.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise RuntimeManagerError("runtime archives must not contain symbolic links")
                if member.is_dir():
                    continue
                files += 1
                total += member.file_size
                if files > self.max_files:
                    raise RuntimeManagerError("runtime archive contains too many files")
                if member.file_size > self.max_file_bytes:
                    raise RuntimeManagerError(f"runtime file is too large: {member.filename}")
                if total > self.max_uncompressed_bytes:
                    raise RuntimeManagerError("runtime archive exceeds uncompressed size limit")
            for member in members:
                path = _safe_relative_path(member.filename.rstrip("/"))
                target = destination.joinpath(*path.parts)
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                mode = (member.external_attr >> 16) & 0o777
                if mode:
                    target.chmod(mode)

    @staticmethod
    def _validate_entrypoints(root: Path, manifest: RuntimeComponentManifest) -> None:
        for relative in manifest.entrypoints.values():
            path = _safe_relative_path(relative)
            resolved = root.joinpath(*path.parts)
            if not resolved.is_file():
                raise RuntimeManagerError(f"runtime entrypoint is missing: {relative}")

    @staticmethod
    def _write_json(path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _activate(self, component_root: Path, pointer: ActiveRuntimeComponent) -> None:
        self._write_json(component_root / "current.json", pointer.model_dump(by_alias=True))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


__all__ = [
    "ActiveRuntimeComponent",
    "RuntimeComponentManifest",
    "RuntimeComponentStore",
    "RuntimeManagerError",
    "parse_runtime_pack_ref",
]
