#!/usr/bin/env python3
"""Build a local, offline Vibe-Trading runtime ZIP from a verified snapshot.

This checks snapshot, lock, and wheel identity. It does not install dependencies,
run the upstream server, or prove that the full dependency closure is usable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from email.parser import BytesParser
from email.policy import default
from pathlib import Path, PurePosixPath

from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import InvalidWheelFilename, canonicalize_name, parse_wheel_filename
from packaging.version import InvalidVersion, Version

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mona.runtime.manager import RuntimeComponentManifest  # noqa: E402
from tools.stock_vibe.prepare import prepare  # noqa: E402

_LOCK_HASH = re.compile(r"(?<!\S)--hash=sha256:([0-9a-fA-F]{64})(?=\s|$)", re.IGNORECASE)
_CHUNK_SIZE = 1024 * 1024
_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
_ROOT_FILES = ("LICENSE", "NOTICE")
_EXCLUDED_DIRS = {
    ".cache",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".ui_runtime",
    ".venv",
    "__pycache__",
    "cache",
    "caches",
    "data-bridge",
    "desktop",
    "downloads",
    "electron",
    "evals",
    "frontend",
    "node_modules",
    "logs",
    "runs",
    "sessions",
    "shadow_accounts",
    "shadow_reports",
    "temp",
    "tests",
    "tmp",
    "user-data",
    "user_data",
    "userdata",
    "uploads",
    "venv",
}
_EXCLUDED_SUFFIXES = {".db", ".log", ".pyc", ".pyo", ".sqlite", ".sqlite3", ".tmp"}


class PackagingError(ValueError):
    """Raised when an offline runtime package cannot be verified."""


@dataclass(frozen=True)
class LockedPackage:
    name: str
    version: Version
    hashes: frozenset[str]


@dataclass(frozen=True)
class ArchiveEntry:
    path: str
    role: str
    size: int
    sha256: str
    source: Path | None = None
    data: bytes | None = None


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _bytes_entry(path: str, role: str, data: bytes) -> ArchiveEntry:
    return ArchiveEntry(path, role, len(data), _sha256_bytes(data), data=data)


def _file_entry(path: str, role: str, source: Path) -> ArchiveEntry:
    if source.is_symlink() or not source.is_file():
        raise PackagingError(f"package input must be a regular file: {source}")
    size, digest = _hash_file(source)
    return ArchiveEntry(path, role, size, digest, source=source)


def _parse_requirements_lock(raw: bytes) -> dict[tuple[str, Version], LockedPackage]:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise PackagingError("requirements lock must be UTF-8") from exc

    logical_lines: list[str] = []
    pending = ""
    for source_line in text.splitlines():
        line = source_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.endswith("\\"):
            pending += line[:-1].strip() + " "
            continue
        logical_lines.append((pending + line).strip())
        pending = ""
    if pending:
        raise PackagingError("requirements lock ends with an incomplete continuation")
    if not logical_lines:
        raise PackagingError("requirements lock is empty")

    locked: dict[tuple[str, Version], LockedPackage] = {}
    for line_number, line in enumerate(logical_lines, start=1):
        hashes = frozenset(match.lower() for match in _LOCK_HASH.findall(line))
        requirement_text = _LOCK_HASH.sub("", line).strip()
        if "--hash" in requirement_text or requirement_text.startswith("-"):
            raise PackagingError(f"unsupported pip option in requirements lock line {line_number}")
        if not hashes:
            raise PackagingError(f"missing sha256 wheel hash on requirements lock line {line_number}")
        try:
            requirement = Requirement(requirement_text)
        except InvalidRequirement as exc:
            raise PackagingError(f"invalid requirement on lock line {line_number}: {exc}") from exc
        specs = list(requirement.specifier)
        if requirement.url or requirement.marker or requirement.extras or len(specs) != 1:
            raise PackagingError(f"lock line {line_number} must be one unconditional exact requirement")
        spec = specs[0]
        if spec.operator != "==" or spec.version.endswith(".*"):
            raise PackagingError(f"lock line {line_number} must pin one exact version with ==")
        try:
            version = Version(spec.version)
        except InvalidVersion as exc:
            raise PackagingError(f"invalid version on lock line {line_number}") from exc
        name = canonicalize_name(requirement.name)
        key = (name, version)
        if key in locked:
            raise PackagingError(f"duplicate package in requirements lock: {name}=={version}")
        locked[key] = LockedPackage(name, version, hashes)
    return locked


def _logical_wheel_metadata(path: Path, expected_name: str, expected_version: Version) -> None:
    try:
        with zipfile.ZipFile(path) as wheel:
            names = wheel.namelist()
            for info in wheel.infolist():
                member = info.filename
                safe = PurePosixPath(member.rstrip("/"))
                mode = (info.external_attr >> 16) & 0xFFFF
                if (
                    "\\" in member
                    or safe.is_absolute()
                    or ".." in safe.parts
                    or re.match(r"^[A-Za-z]:", member)
                    or stat.S_ISLNK(mode)
                ):
                    raise PackagingError(f"unsafe wheel member in {path.name}: {member}")
            metadata_paths = [name for name in names if name.endswith(".dist-info/METADATA")]
            if len(metadata_paths) != 1 or not metadata_paths[0].endswith(".dist-info/METADATA"):
                raise PackagingError(f"wheel must contain one dist-info/METADATA: {path.name}")
            prefix = metadata_paths[0].removesuffix("METADATA")
            if prefix + "WHEEL" not in names or prefix + "RECORD" not in names:
                raise PackagingError(f"wheel is missing WHEEL or RECORD metadata: {path.name}")
            metadata_info = wheel.getinfo(metadata_paths[0])
            if metadata_info.file_size > 1024 * 1024:
                raise PackagingError(f"wheel metadata is too large: {path.name}")
            metadata = BytesParser(policy=default).parsebytes(wheel.read(metadata_info))
            actual_name = canonicalize_name(metadata.get("Name", ""))
            actual_version = Version(metadata.get("Version", ""))
    except PackagingError:
        raise
    except (OSError, KeyError, zipfile.BadZipFile, InvalidVersion) as exc:
        raise PackagingError(f"invalid wheel archive {path.name}: {exc}") from exc
    if actual_name != expected_name or actual_version != expected_version:
        raise PackagingError(f"wheel metadata does not match filename and lock: {path.name}")


def _validate_wheelhouse(
    wheelhouse: Path,
    locked: dict[tuple[str, Version], LockedPackage],
) -> list[ArchiveEntry]:
    if wheelhouse.is_symlink() or not wheelhouse.is_dir():
        raise PackagingError("--wheelhouse must name an existing directory, not a symlink")
    children = sorted(wheelhouse.iterdir(), key=lambda path: path.name.casefold())
    if not children:
        raise PackagingError("wheelhouse contains no wheels")

    entries: list[ArchiveEntry] = []
    matched_hashes: dict[tuple[str, Version], set[str]] = {key: set() for key in locked}
    seen_names: set[str] = set()
    for path in children:
        if path.is_symlink() or not path.is_file() or path.suffix.lower() != ".whl":
            raise PackagingError("wheelhouse may contain only regular .whl files")
        if path.name.casefold() in seen_names:
            raise PackagingError(f"duplicate wheel filename: {path.name}")
        seen_names.add(path.name.casefold())
        try:
            project, version, _build, _tags = parse_wheel_filename(path.name)
        except InvalidWheelFilename as exc:
            raise PackagingError(f"invalid wheel filename {path.name}: {exc}") from exc
        key = (canonicalize_name(str(project)), version)
        requirement = locked.get(key)
        if requirement is None:
            raise PackagingError(f"wheel is not pinned in requirements lock: {path.name}")
        entry = _file_entry(f"python/wheelhouse/{path.name}", "wheel", path)
        if entry.sha256 not in requirement.hashes:
            raise PackagingError(f"wheel hash does not match requirements lock: {path.name}")
        _logical_wheel_metadata(path, requirement.name, requirement.version)
        matched_hashes[key].add(entry.sha256)
        entries.append(entry)

    for key, requirement in locked.items():
        matched = matched_hashes[key]
        if not matched:
            raise PackagingError(f"no wheel supplied for locked package {requirement.name}=={requirement.version}")
        if matched != requirement.hashes:
            raise PackagingError(
                f"requirements lock contains hashes without matching wheels for "
                f"{requirement.name}=={requirement.version}"
            )
    return entries


def _skip_directory(relative_parts: tuple[str, ...], name: str) -> bool:
    lowered = name.casefold()
    if lowered in _EXCLUDED_DIRS or lowered == ".vibe-trading":
        return True
    if lowered == "assets" and not relative_parts:
        return True
    # Skill-owned scripts are part of the preserved skill package.
    if lowered == "scripts" and "skills" not in {part.casefold() for part in relative_parts}:
        return True
    return False


def _program_entries(prepared_root: Path) -> list[ArchiveEntry]:
    agent_root = prepared_root / "agent"
    if not agent_root.is_dir() or not (agent_root / "api_server.py").is_file():
        raise PackagingError("prepared snapshot must contain agent/api_server.py")
    entries = [_file_entry(name, "license", prepared_root / name) for name in _ROOT_FILES]
    for current, directories, filenames in os.walk(agent_root, topdown=True, followlinks=False):
        current_path = Path(current)
        relative_parts = current_path.relative_to(agent_root).parts
        kept: list[str] = []
        for directory in sorted(directories):
            path = current_path / directory
            if path.is_symlink():
                raise PackagingError(f"prepared source contains a directory symlink: {path}")
            if not _skip_directory(relative_parts, directory):
                kept.append(directory)
        directories[:] = kept
        for filename in sorted(filenames):
            path = current_path / filename
            if path.is_symlink():
                raise PackagingError(f"prepared source contains a file symlink: {path}")
            if filename.casefold().startswith(".env") or path.suffix.casefold() in _EXCLUDED_SUFFIXES:
                continue
            relative = path.relative_to(prepared_root).as_posix()
            entries.append(_file_entry(relative, "program", path))
    return entries


def _records(entries: list[ArchiveEntry]) -> list[dict[str, object]]:
    return [
        {"path": entry.path, "role": entry.role, "bytes": entry.size, "sha256": entry.sha256}
        for entry in sorted(entries, key=lambda item: item.path)
    ]


def _inventory_sha256(entries: list[ArchiveEntry]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: item.path):
        digest.update(entry.path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(entry.size).encode("ascii"))
        digest.update(b"\0")
        digest.update(entry.sha256.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _manifest_bytes(version: str) -> bytes:
    manifest = RuntimeComponentManifest.model_validate(
        {
            "id": "stock-vibe",
            "version": version,
            "kind": "stock-vibe-runtime",
            "dependencies": ["python-base@3.13.15"],
            "entrypoints": {"server": "agent/api_server.py"},
            "pythonRequirements": "python/requirements.lock",
            "pythonWheelhouse": "python/wheelhouse",
            "pythonEnvironment": "stock-vibe",
        }
    )
    data = manifest.model_dump(mode="json", by_alias=True)
    return (json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _write_entry(archive: zipfile.ZipFile, entry: ArchiveEntry) -> None:
    info = _zip_info(entry.path)
    if entry.data is not None:
        archive.writestr(info, entry.data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        return
    if entry.source is None:
        raise PackagingError(f"missing package input for {entry.path}")
    digest = hashlib.sha256()
    size = 0
    with entry.source.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
        while chunk := source.read(_CHUNK_SIZE):
            digest.update(chunk)
            size += len(chunk)
            target.write(chunk)
    if size != entry.size or digest.hexdigest() != entry.sha256:
        raise PackagingError(f"package input changed during build: {entry.path}")


def _write_json(path: Path, payload: dict[str, object]) -> None:
    data = (json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(data)


def build_runtime(
    *,
    snapshot_root: Path,
    wheelhouse: Path,
    requirements_lock: Path,
    output: Path,
    version: str,
) -> dict[str, object]:
    """Validate all inputs, prepare the fixed snapshot, and publish a ZIP plus receipt."""
    snapshot_input = Path(snapshot_root)
    wheelhouse_input = Path(wheelhouse)
    lock_input = Path(requirements_lock)
    output_input = Path(output)
    if output_input.exists() or output_input.is_symlink():
        raise PackagingError("refusing to replace an existing package")
    if snapshot_input.is_symlink():
        raise PackagingError("--snapshot-root must not be a symlink")
    if wheelhouse_input.is_symlink():
        raise PackagingError("--wheelhouse must not be a symlink")
    if lock_input.is_symlink():
        raise PackagingError("--requirements-lock must not be a symlink")
    if output_input.is_symlink():
        raise PackagingError("--output must not be a symlink")
    snapshot_root = snapshot_input.resolve(strict=True)
    wheelhouse = wheelhouse_input.resolve(strict=True)
    requirements_lock = lock_input.resolve(strict=True)
    output = output_input.resolve()
    sidecar = Path(f"{output}.receipt.json")
    if output.suffix.lower() != ".zip":
        raise PackagingError("--output must end in .zip")
    if output.exists() or sidecar.exists() or sidecar.is_symlink():
        raise PackagingError("refusing to replace an existing package or receipt")
    if snapshot_root == output or snapshot_root in output.parents:
        raise PackagingError("package output must not be inside the immutable source snapshot")
    if wheelhouse == output.parent or wheelhouse in output.parents:
        raise PackagingError("package output must not be inside the wheelhouse")
    if requirements_lock.is_symlink() or not requirements_lock.is_file():
        raise PackagingError("--requirements-lock must name a regular file")

    try:
        source_lock_bytes = (snapshot_root / "source-lock.json").read_bytes()
        source_lock = json.loads(source_lock_bytes)
        lock_bytes = requirements_lock.read_bytes()
        locked = _parse_requirements_lock(lock_bytes)
        wheel_entries = _validate_wheelhouse(wheelhouse, locked)

        with tempfile.TemporaryDirectory(prefix="stock-vibe-build-") as temporary:
            prepared_root = Path(temporary) / "prepared"
            prepared_receipt = prepare(snapshot_root, prepared_root)
            if prepared_receipt.get("snapshot_id") != source_lock.get("snapshot_id"):
                raise PackagingError("prepared source does not match the pinned snapshot")
            if (snapshot_root / "source-lock.json").read_bytes() != source_lock_bytes:
                raise PackagingError("source lock changed during package preparation")

            upstream_lock = prepared_root / "requirements-lock.txt"
            if not upstream_lock.is_file():
                raise PackagingError("prepared source is missing the upstream requirements lock")
            program_entries = _program_entries(prepared_root)
            lock_entry = _bytes_entry("python/requirements.lock", "requirements", lock_bytes)
            payload_entries = [*program_entries, lock_entry, *wheel_entries]
            manifest_bytes = _manifest_bytes(version)
            manifest_entry = _bytes_entry("runtime-manifest.json", "manifest", manifest_bytes)
            inventory_entries = [*payload_entries, manifest_entry]

            program_entries_only = [entry for entry in program_entries if entry.role == "program"]
            upstream_lock_size, upstream_lock_sha = _hash_file(upstream_lock)
            prepared_source_receipt = prepared_root / "agent" / "mona-source.json"
            if not prepared_source_receipt.is_file():
                raise PackagingError("prepared source is missing its patch receipt")
            prepared_receipt_sha = _hash_file(prepared_source_receipt)[1]
            patches = prepared_receipt.get("patches", [])
            receipt_data: dict[str, object] = {
                "schema_version": 1,
                "verification_scope": (
                    "snapshot, patch, exact requirement pins, wheel filenames, metadata and hashes verified; "
                    "this does not prove the full wheel closure or upstream build chain; "
                    "no dependency installation or upstream server run performed"
                ),
                "required_before_t02_complete": (
                    "install through the unified runtime catalog and PythonEnvironmentBuilder in an isolated "
                    "runtime, then verify imports and the hosted startup lifecycle"
                ),
                "source": {
                    "upstream": source_lock["source"],
                    "snapshot_id": source_lock["snapshot_id"],
                    "source_lock_sha256": _sha256_bytes(source_lock_bytes),
                    "source_archive_sha256": source_lock["archive"]["sha256"],
                    "source_files_manifest_sha256": source_lock["files_manifest"]["sha256"],
                    "upstream_requirements_lock_sha256": upstream_lock_sha,
                    "upstream_requirements_lock_bytes": upstream_lock_size,
                    "prepared_patch_receipt_sha256": prepared_receipt_sha,
                    "patches": patches,
                },
                "build": {
                    "requirements_lock_sha256": _sha256_bytes(lock_bytes),
                    "input_inventory_sha256": _inventory_sha256(payload_entries),
                },
                "inventory": {
                    "files": _records(inventory_entries),
                    "program_file_count": len(program_entries_only),
                    "program_bytes": sum(entry.size for entry in program_entries_only),
                    "wheel_count": len(wheel_entries),
                    "wheel_bytes": sum(entry.size for entry in wheel_entries),
                    "payload_bytes_excluding_source_receipt": sum(
                        entry.size for entry in inventory_entries
                    ),
                    "source_receipt_is_excluded_from_its_own_inventory": True,
                },
            }
            source_receipt_bytes = (
                json.dumps(receipt_data, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
            ).encode("utf-8")
            source_receipt_entry = _bytes_entry(
                "source-receipt.json", "source-receipt", source_receipt_bytes
            )
            archive_entries = [*payload_entries, manifest_entry, source_receipt_entry]
            uncompressed_bytes = sum(entry.size for entry in archive_entries)

            output.parent.mkdir(parents=True, exist_ok=True)
            archive_fd, archive_temp_name = tempfile.mkstemp(
                prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
            )
            os.close(archive_fd)
            archive_temp = Path(archive_temp_name)
            receipt_temp = output.parent / f".{sidecar.name}.{os.getpid()}.tmp"
            try:
                with zipfile.ZipFile(
                    archive_temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
                ) as archive:
                    for entry in sorted(archive_entries, key=lambda item: item.path):
                        _write_entry(archive, entry)
                archive_size, archive_sha = _hash_file(archive_temp)
                sidecar_data: dict[str, object] = {
                    "schema_version": 1,
                    "source_receipt": "source-receipt.json",
                    "source_receipt_sha256": _sha256_bytes(source_receipt_bytes),
                    "package": {
                        "filename": output.name,
                        "sha256": archive_sha,
                        "bytes": archive_size,
                        "uncompressed_bytes": uncompressed_bytes,
                    },
                    "verification_scope": receipt_data["verification_scope"],
                    "required_before_t02_complete": receipt_data["required_before_t02_complete"],
                }
                _write_json(receipt_temp, sidecar_data)
                os.replace(archive_temp, output)
                try:
                    os.replace(receipt_temp, sidecar)
                except Exception:
                    output.unlink(missing_ok=True)
                    raise
            finally:
                archive_temp.unlink(missing_ok=True)
                receipt_temp.unlink(missing_ok=True)

        return sidecar_data
    except PackagingError:
        raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        raise PackagingError(str(exc)) from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot-root", type=Path, default=REPO_ROOT / "third_party" / "vibe-trading")
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--requirements-lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args(argv)
    try:
        receipt = build_runtime(
            snapshot_root=args.snapshot_root,
            wheelhouse=args.wheelhouse,
            requirements_lock=args.requirements_lock,
            output=args.output,
            version=args.version,
        )
    except PackagingError as exc:
        parser.error(str(exc))
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
