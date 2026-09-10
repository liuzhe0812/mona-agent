"""Versioned, rebuildable package storage for downloadable Agent experts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from filelock import FileLock
from pydantic import AnyHttpUrl, Field, field_validator

from mona.agent.partners import AgentDefinitionError, AgentRegistry, normalize_agent_id
from mona.config.schema import Base

PACKAGE_MANIFEST_SCHEMA_VERSION = 1
PACKAGE_POINTER_SCHEMA_VERSION = 1
DEFAULT_MAX_FILES = 10_000
DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_VERSION_RE = re.compile(r"^[0-9A-Za-z](?:[0-9A-Za-z._+-]{0,62}[0-9A-Za-z])?$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PACK_REF_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:@[0-9A-Za-z][0-9A-Za-z._+-]{0,63})?$"
)


class AgentPackageError(ValueError):
    """Raised when an expert package cannot be verified or activated."""


class AgentPackageManifest(Base):
    """Trusted metadata embedded in one downloaded expert archive."""

    schema_version: int = PACKAGE_MANIFEST_SCHEMA_VERSION
    agent_id: str
    version: str
    min_mona_version: str | None = None
    required_tools: list[str] = Field(default_factory=list)
    runtime_packs: list[str] = Field(default_factory=list)

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: int) -> int:
        if value != PACKAGE_MANIFEST_SCHEMA_VERSION:
            raise ValueError(f"unsupported package manifest schema version {value}")
        return value

    @field_validator("agent_id")
    @classmethod
    def _validate_agent_id(cls, value: str) -> str:
        return normalize_agent_id(value)

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        value = value.strip()
        if not _VERSION_RE.fullmatch(value) or ".." in value:
            raise ValueError(f"invalid package version {value!r}")
        return value

    @field_validator("required_tools")
    @classmethod
    def _dedupe_nonempty(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for raw in values:
            value = raw.strip()
            if not value:
                raise ValueError("package dependency names must not be empty")
            if value not in result:
                result.append(value)
        return result

    @field_validator("runtime_packs")
    @classmethod
    def _validate_runtime_packs(cls, values: list[str]) -> list[str]:
        result = cls._dedupe_nonempty(values)
        for value in result:
            if not _PACK_REF_RE.fullmatch(value):
                raise ValueError(f"invalid runtime pack reference {value!r}")
        return result


class ExpertCatalogEntry(Base):
    """One official expert version advertised by the remote catalog."""

    schema_version: int = PACKAGE_MANIFEST_SCHEMA_VERSION
    id: str
    display_name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2_000)
    version: str
    min_mona_version: str | None = None
    download_url: AnyHttpUrl
    mirrors: list[AnyHttpUrl] = Field(default_factory=list)
    size: int = Field(gt=0)
    sha256: str
    runtime_packs: list[str] = Field(default_factory=list)
    required_tools: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    architectures: list[str] = Field(default_factory=list)

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: int) -> int:
        return AgentPackageManifest._validate_schema_version(value)

    @field_validator("id")
    @classmethod
    def _validate_id(cls, value: str) -> str:
        return normalize_agent_id(value)

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        return AgentPackageManifest._validate_version(value)

    @field_validator("sha256")
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        return ActiveAgentPackage._validate_sha256(value)

    @field_validator("runtime_packs")
    @classmethod
    def _validate_runtime_packs(cls, values: list[str]) -> list[str]:
        return AgentPackageManifest._validate_runtime_packs(values)

    @field_validator("required_tools", "platforms", "architectures")
    @classmethod
    def _dedupe_nonempty(cls, values: list[str]) -> list[str]:
        return AgentPackageManifest._dedupe_nonempty(values)

    @field_validator("mirrors")
    @classmethod
    def _dedupe_mirrors(cls, values: list[AnyHttpUrl]) -> list[AnyHttpUrl]:
        result: list[AnyHttpUrl] = []
        seen: set[str] = set()
        for value in values:
            key = str(value)
            if key not in seen:
                seen.add(key)
                result.append(value)
        return result


class ExpertCatalog(Base):
    """Bounded catalog payload cached by the client."""

    schema_version: int = 1
    generated_at: str
    experts: list[ExpertCatalogEntry] = Field(max_length=10_000)

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: int) -> int:
        if value != 1:
            raise ValueError(f"unsupported expert catalog schema version {value}")
        return value

    @field_validator("generated_at")
    @classmethod
    def _generated_at(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("catalog generatedAt is invalid") from exc
        if parsed.tzinfo is None:
            raise ValueError("catalog generatedAt must include a timezone")
        return value

    @field_validator("experts")
    @classmethod
    def _unique_versions(cls, experts: list[ExpertCatalogEntry]) -> list[ExpertCatalogEntry]:
        identities: set[tuple[str, str]] = set()
        for entry in experts:
            identity = (entry.id, entry.version)
            if identity in identities:
                raise ValueError(f"duplicate expert catalog entry {entry.id}@{entry.version}")
            identities.add(identity)
        return experts


class ActiveAgentPackage(Base):
    """Atomic pointer to the active immutable version of one Agent package."""

    schema_version: int = PACKAGE_POINTER_SCHEMA_VERSION
    agent_id: str
    version: str
    sha256: str
    installed_at: str

    @field_validator("agent_id")
    @classmethod
    def _validate_agent_id(cls, value: str) -> str:
        return normalize_agent_id(value)

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        return AgentPackageManifest._validate_version(value)

    @field_validator("sha256")
    @classmethod
    def _validate_sha256(cls, value: str) -> str:
        value = value.strip().lower()
        if not _SHA256_RE.fullmatch(value):
            raise ValueError("sha256 must be 64 lowercase hex characters")
        return value


@dataclass(frozen=True, slots=True)
class InstalledAgentPackage:
    manifest: AgentPackageManifest
    package_root: Path
    sha256: str
    activated: bool


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_member_path(name: str) -> PurePosixPath:
    if not name or "\x00" in name or "\\" in name:
        raise AgentPackageError(f"invalid archive path {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise AgentPackageError(f"unsafe archive path {name!r}")
    if ":" in path.parts[0]:
        raise AgentPackageError(f"unsafe archive drive path {name!r}")
    return path


class AgentPackageStore:
    """Install immutable Agent versions and atomically select the active one."""

    def __init__(
        self,
        root: Path,
        *,
        known_tool_names: set[str] | None = None,
        max_files: int = DEFAULT_MAX_FILES,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_uncompressed_bytes: int = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    ) -> None:
        self.root = root.resolve()
        self.known_tool_names = known_tool_names
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.max_uncompressed_bytes = max_uncompressed_bytes

    def install_archive(
        self,
        archive: Path,
        *,
        expected_sha256: str,
        expected_agent_id: str,
        expected_version: str,
        activate: bool = True,
    ) -> InstalledAgentPackage:
        """Verify, install and optionally activate one immutable expert ZIP."""
        agent_id = normalize_agent_id(expected_agent_id)
        version = AgentPackageManifest._validate_version(expected_version)
        expected_hash = expected_sha256.strip().lower()
        if not _SHA256_RE.fullmatch(expected_hash):
            raise AgentPackageError("expected_sha256 must be 64 lowercase hex characters")
        actual_hash = sha256_file(archive)
        if actual_hash != expected_hash:
            raise AgentPackageError("agent package sha256 mismatch")

        agent_store = self.root / agent_id
        versions_dir = agent_store / "v"
        lock = FileLock(str(agent_store) + ".install.lock", timeout=60)
        with lock:
            versions_dir.mkdir(parents=True, exist_ok=True)
            final_version_dir = versions_dir / version
            final_package_root = final_version_dir / "p"
            existing_version_dir, existing_package_root = self._existing_version(
                agent_store, agent_id, version
            )
            if existing_version_dir is not None and existing_package_root is not None:
                pointer = self._read_receipt(existing_version_dir)
                if pointer.sha256 != actual_hash:
                    raise AgentPackageError(
                        f"immutable package version {agent_id}@{version} already has different bytes"
                    )
                manifest = self._validate_installed_package(
                    existing_package_root, agent_id, version
                )
                if activate:
                    self._activate(agent_store, pointer)
                return InstalledAgentPackage(
                    manifest=manifest,
                    package_root=existing_package_root,
                    sha256=actual_hash,
                    activated=activate,
                )

            temporary_root = self.root / ".t"
            temporary_root.mkdir(parents=True, exist_ok=True)
            staging_root = Path(tempfile.mkdtemp(prefix="install-", dir=temporary_root))
            try:
                extracted_root = self._extract_archive(
                    archive,
                    staging_root,
                    expected_agent_id=agent_id,
                )
                manifest = self._read_package_manifest(extracted_root)
                if manifest.agent_id != agent_id or manifest.version != version:
                    raise AgentPackageError(
                        "package manifest identity/version does not match catalog metadata"
                    )
                self._validate_installed_package(extracted_root, agent_id, version)
                pointer = ActiveAgentPackage(
                    agentId=agent_id,
                    version=version,
                    sha256=actual_hash,
                    installedAt=datetime.now(timezone.utc).isoformat(),
                )
                staged_version_dir = staging_root / "version"
                staged_version_dir.mkdir()
                os.replace(extracted_root, staged_version_dir / "p")
                self._write_json(
                    staged_version_dir / "receipt.json", pointer.model_dump(by_alias=True)
                )
                os.replace(staged_version_dir, final_version_dir)
                if activate:
                    self._activate(agent_store, pointer)
                return InstalledAgentPackage(
                    manifest=manifest,
                    package_root=final_package_root,
                    sha256=actual_hash,
                    activated=activate,
                )
            finally:
                shutil.rmtree(staging_root, ignore_errors=True)

    def activate(self, agent_id: str, version: str) -> ActiveAgentPackage:
        """Atomically switch an installed Agent to an existing immutable version."""
        agent_id = normalize_agent_id(agent_id)
        version = AgentPackageManifest._validate_version(version)
        agent_store = self.root / agent_id
        with FileLock(str(agent_store) + ".install.lock", timeout=60):
            version_dir, package_root = self._existing_version(agent_store, agent_id, version)
            if version_dir is None or package_root is None:
                raise AgentPackageError(
                    f"installed package version not found: {agent_id}@{version}"
                )
            pointer = self._read_receipt(version_dir)
            if pointer.agent_id != agent_id or pointer.version != version:
                raise AgentPackageError("installed package receipt identity mismatch")
            self._validate_installed_package(package_root, agent_id, version)
            self._activate(agent_store, pointer)
            return pointer

    def active(self, agent_id: str) -> tuple[ActiveAgentPackage, Path] | None:
        """Return the active pointer and package root, ignoring corrupt state."""
        agent_id = normalize_agent_id(agent_id)
        agent_store = self.root / agent_id
        try:
            pointer = ActiveAgentPackage.model_validate_json(
                (agent_store / "current.json").read_text(encoding="utf-8")
            )
            if pointer.agent_id != agent_id:
                return None
            version_dir, package_root = self._existing_version(
                agent_store, agent_id, pointer.version
            )
            if version_dir is None or package_root is None:
                return None
            self._validate_installed_package(package_root, agent_id, pointer.version)
            return pointer, package_root
        except (OSError, ValueError, AgentPackageError, AgentDefinitionError):
            return None

    def deactivate(
        self,
        agent_id: str,
        *,
        expected_version: str | None = None,
    ) -> bool:
        """Remove only the active pointer while preserving versions and user data."""
        agent_id = normalize_agent_id(agent_id)
        agent_store = self.root / agent_id
        with FileLock(str(agent_store) + ".install.lock", timeout=60):
            active = self.active(agent_id)
            if active is None:
                return False
            if expected_version is not None and active[0].version != expected_version:
                raise AgentPackageError("active package changed before deactivation")
            (agent_store / "current.json").unlink(missing_ok=True)
            return True

    def iter_active_package_roots(self) -> Iterator[Path]:
        """Yield valid active package roots without creating user-data directories."""
        if not self.root.is_dir():
            return
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            try:
                active = self.active(child.name)
            except ValueError:
                continue
            if active is not None:
                yield active[1]

    def prune_inactive(self, agent_id: str, *, keep: int = 2) -> list[str]:
        """Delete old rebuildable versions while preserving active and recent copies."""
        if keep < 1:
            raise ValueError("keep must be at least 1")
        agent_id = normalize_agent_id(agent_id)
        agent_store = self.root / agent_id
        removed: list[str] = []
        with FileLock(str(agent_store) + ".install.lock", timeout=60):
            active = self.active(agent_id)
            versions: list[tuple[ActiveAgentPackage, Path]] = []
            for directory in (agent_store / "v", agent_store / "versions"):
                if not directory.is_dir():
                    continue
                for version_dir in directory.iterdir():
                    if not version_dir.is_dir():
                        continue
                    try:
                        versions.append((self._read_receipt(version_dir), version_dir))
                    except AgentPackageError:
                        continue
            versions.sort(key=lambda item: item[0].installed_at, reverse=True)
            protected = {path for _receipt, path in versions[:keep]}
            if active is not None:
                protected.add(active[1].parent)
            for receipt, version_dir in versions:
                if version_dir in protected:
                    continue
                shutil.rmtree(_extended_windows_path(version_dir))
                removed.append(receipt.version)
        return removed

    @staticmethod
    def _existing_version(
        agent_store: Path,
        agent_id: str,
        version: str,
    ) -> tuple[Path | None, Path | None]:
        current = agent_store / "v" / version
        current_package = current / "p"
        if current_package.is_dir():
            return current, current_package
        legacy = agent_store / "versions" / version
        legacy_package = legacy / agent_id
        if legacy_package.is_dir():
            return legacy, legacy_package
        return None, None

    def _extract_archive(
        self,
        archive: Path,
        destination: Path,
        *,
        expected_agent_id: str,
    ) -> Path:
        seen: set[str] = set()
        total_bytes = 0
        file_count = 0
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            for member in members:
                path = _safe_member_path(member.filename)
                normalized = path.as_posix().rstrip("/").casefold()
                if normalized in seen:
                    raise AgentPackageError(f"duplicate archive path {member.filename!r}")
                seen.add(normalized)
                mode = (member.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise AgentPackageError(f"symbolic links are not allowed: {member.filename}")
                if path.parts[0] != expected_agent_id:
                    raise AgentPackageError(f"archive root must be exactly {expected_agent_id!r}")
                if member.is_dir():
                    continue
                file_count += 1
                total_bytes += member.file_size
                if file_count > self.max_files:
                    raise AgentPackageError("agent package contains too many files")
                if member.file_size > self.max_file_bytes:
                    raise AgentPackageError(f"agent package file is too large: {member.filename}")
                if total_bytes > self.max_uncompressed_bytes:
                    raise AgentPackageError("agent package exceeds uncompressed size limit")

            for member in members:
                path = _safe_member_path(member.filename)
                relative_parts = path.parts[1:]
                if not relative_parts:
                    if member.is_dir():
                        os.makedirs(_extended_windows_path(destination / "p"), exist_ok=True)
                        continue
                    raise AgentPackageError("agent package root must be a directory")
                target = (destination / "p").joinpath(*relative_parts)
                if member.is_dir():
                    os.makedirs(_extended_windows_path(target), exist_ok=True)
                    continue
                os.makedirs(_extended_windows_path(target.parent), exist_ok=True)
                with (
                    bundle.open(member) as source,
                    open(_extended_windows_path(target), "xb") as output,
                ):
                    shutil.copyfileobj(source, output, length=1024 * 1024)
        package_root = destination / "p"
        if not package_root.is_dir():
            raise AgentPackageError("agent package root was not extracted")
        return package_root

    def _read_package_manifest(self, package_root: Path) -> AgentPackageManifest:
        path = package_root / "package-manifest.json"
        try:
            return AgentPackageManifest.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise AgentPackageError(f"invalid package-manifest.json: {exc}") from exc

    def _validate_installed_package(
        self,
        package_root: Path,
        expected_agent_id: str,
        expected_version: str,
    ) -> AgentPackageManifest:
        manifest = self._read_package_manifest(package_root)
        if manifest.agent_id != expected_agent_id or manifest.version != expected_version:
            raise AgentPackageError("installed package identity/version mismatch")
        registry = AgentRegistry(
            builtin_dir=package_root.parent,
            installed_dir=package_root.parent / ".no-legacy-agents",
            package_store_dir=package_root.parent / ".no-package-store",
            known_tool_names=self.known_tool_names,
            enforce_package_dir_name=False,
        )
        definition = registry.get(expected_agent_id)
        if definition is None:
            raise AgentPackageError("agent.json could not be loaded from package")
        if definition.package_version != expected_version:
            raise AgentPackageError("agent.json packageVersion does not match package manifest")
        missing_tools = sorted(set(manifest.required_tools) - set(definition.tool_allowlist))
        if missing_tools:
            raise AgentPackageError(
                "package manifest requiredTools are absent from agent allowlist: "
                + ", ".join(missing_tools)
            )
        return manifest

    @staticmethod
    def _read_receipt(version_dir: Path) -> ActiveAgentPackage:
        try:
            return ActiveAgentPackage.model_validate_json(
                (version_dir / "receipt.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError) as exc:
            raise AgentPackageError(f"invalid installed package receipt: {exc}") from exc

    @staticmethod
    def _write_json(path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _activate(self, agent_store: Path, pointer: ActiveAgentPackage) -> None:
        self._write_json(agent_store / "current.json", pointer.model_dump(by_alias=True))


def iter_active_agent_package_roots(root: Path) -> Iterator[Path]:
    """Convenience loader used by AgentRegistry."""
    yield from AgentPackageStore(root).iter_active_package_roots()


def _extended_windows_path(path: Path) -> str:
    absolute = str(path.resolve(strict=False))
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return absolute
    if absolute.startswith("\\\\"):
        return "\\\\?\\UNC\\" + absolute[2:]
    return "\\\\?\\" + absolute


__all__ = [
    "ActiveAgentPackage",
    "AgentPackageError",
    "AgentPackageManifest",
    "AgentPackageStore",
    "ExpertCatalog",
    "ExpertCatalogEntry",
    "InstalledAgentPackage",
    "iter_active_agent_package_roots",
    "sha256_file",
]
