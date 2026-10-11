"""Convert verified native engine artifacts to the shared runtime ZIP format."""

from __future__ import annotations

import json
import os
import stat
import tarfile
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from mona.runtime.manager import RuntimeManagerError

if TYPE_CHECKING:
    from mona.runtime.catalog import RuntimeCatalogEntry

_ENGINE_INFO = {
    "codex-cli": ("codex-runtime", "codex"),
    "claude-code-cli": ("claude-code-runtime", "claude"),
    "codebuddy-cli": ("codebuddy-runtime", "codebuddy"),
}
_MAX_FILES = 20_000
_MAX_FILE_BYTES = 512 * 1024 * 1024
_MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
_CHUNK_SIZE = 1024 * 1024
_RESERVED_NAMES = {"runtime-manifest.json", "executor.json"}
_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class NativeArchiveError(RuntimeManagerError):
    """Raised when a native engine artifact cannot be safely packaged."""


def normalize_engine_archive(
    source: Path,
    entry: RuntimeCatalogEntry,
    destination: Path,
    *,
    current_platform: str,
    current_architecture: str,
) -> Path:
    """Build a regular runtime ZIP from one already-verified native artifact."""
    try:
        expected_kind, executor = _ENGINE_INFO[entry.id]
    except KeyError as exc:
        raise NativeArchiveError(f"unsupported native engine component: {entry.id}") from exc
    if entry.kind != expected_kind:
        raise NativeArchiveError("native engine component kind does not match its ID")

    source = Path(source)
    destination = Path(destination)
    try:
        source_info = source.lstat()
    except OSError as exc:
        raise NativeArchiveError("native engine artifact is unavailable") from exc
    if not stat.S_ISREG(source_info.st_mode):
        raise NativeArchiveError("native engine artifact must be a regular file")
    if source.resolve() == destination.resolve():
        raise NativeArchiveError("native engine output must differ from its input")

    artifact_format = entry.artifact_format
    if entry.id == "claude-code-cli":
        if artifact_format != "native-binary":
            raise NativeArchiveError("Claude Code requires a native binary artifact")
        members, entrypoint = _raw_binary_members(source, current_platform)
    elif entry.id == "codex-cli":
        if artifact_format != "native-tar-gz":
            raise NativeArchiveError("Codex requires a native tar.gz artifact")
        members, entrypoint = _codex_tar_members(source, entry.native_entrypoint, entry.version)
    else:
        is_windows = current_platform in {"win32", "windows"}
        expected_format = "native-zip" if is_windows else "native-tar-gz"
        expected_path = "codebuddy.exe" if is_windows else "codebuddy"
        if artifact_format != expected_format or entry.native_entrypoint != expected_path:
            raise NativeArchiveError("CodeBuddy artifact format does not match the target platform")
        members, entrypoint = _codebuddy_members(source, artifact_format, entry.native_entrypoint)

    if any(name in _RESERVED_NAMES for name, _ in members):
        raise NativeArchiveError("native engine artifact contains a reserved runtime metadata file")
    if entrypoint not in {name for name, _ in members}:
        raise NativeArchiveError("native engine artifact is missing its declared entrypoint")

    manifest = {
        "schemaVersion": 1,
        "id": entry.id,
        "version": entry.version,
        "kind": entry.kind,
        "entrypoints": {executor: entrypoint, "metadata": "executor.json"},
        "dependencies": entry.dependencies,
    }
    executor_metadata = {
        "schemaVersion": 1,
        "executor": executor,
        "platform": current_platform,
        "architecture": current_architecture,
        "nativeVersion": entry.version.split("+", 1)[0],
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")
    executor_bytes = (
        json.dumps(executor_metadata, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")
    if (
        len(members) + 2 > _MAX_FILES
        or sum(member.size for _, member in members) + len(manifest_bytes) + len(executor_bytes)
        > _MAX_EXPANDED_BYTES
    ):
        raise NativeArchiveError("normalized runtime exceeds expanded size limits")

    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as output:
            for name, member in members:
                info = _zip_info(name, member.mode)
                with output.open(info, "w", force_zip64=True) as target:
                    with member.open() as original:
                        _copy_limited(original, target, member.size)
            output.writestr(_zip_info("runtime-manifest.json", 0o644), manifest_bytes)
            output.writestr(_zip_info("executor.json", 0o644), executor_bytes)
        os.replace(temporary, destination)
        return destination
    finally:
        temporary.unlink(missing_ok=True)


class _Member:
    def __init__(self, name: str, size: int, mode: int, opener) -> None:
        self.name = name
        self.size = size
        self.mode = mode
        self.open = opener


def _zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = ((stat.S_IFREG | (mode & 0o777)) << 16) | 0x20
    return info


def _raw_binary_members(source: Path, current_platform: str) -> tuple[list[tuple[str, _Member]], str]:
    size = source.stat().st_size
    _check_limits(1, size)
    suffix = ".exe" if current_platform in {"win32", "windows"} else ""
    name = f"bin/claude{suffix}"
    mode = source.stat().st_mode & 0o777
    if current_platform not in {"win32", "windows"}:
        mode |= 0o111
    return [(name, _Member(name, size, mode, lambda: source.open("rb")))], name


def _codex_tar_members(
    source: Path, native_entrypoint: str | None, version: str
) -> tuple[list[tuple[str, _Member]], str]:
    expected_entrypoint = _safe_path(native_entrypoint)
    try:
        with tarfile.open(source, "r:gz") as archive:
            entries = _tar_entries(archive)
    except (OSError, tarfile.TarError) as exc:
        raise NativeArchiveError("Codex native tar.gz is invalid") from exc
    files = [item for item in entries if item[1] is not None]
    metadata = [item for item in files if item[0].name == "codex-package.json"]
    if len(metadata) != 1:
        raise NativeArchiveError("Codex package metadata must occur exactly once")
    metadata_path = metadata[0][0].as_posix()
    root = metadata_path.rpartition("/")[0]
    selected = _strip_package_root(entries, root)
    selected_files = {
        item[0].as_posix(): item[1] for item in selected if item[1] is not None
    }
    if expected_entrypoint not in selected_files:
        raise NativeArchiveError("Codex package does not contain its declared entrypoint")
    package_metadata = selected_files["codex-package.json"]
    if package_metadata.size > 1024 * 1024:
        raise NativeArchiveError("Codex package metadata is too large")
    try:
        with package_metadata.open() as stream:
            data = json.loads(stream.read().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NativeArchiveError("Codex package metadata is invalid") from exc
    if not isinstance(data, dict) or data.get("version") != version.split("+", 1)[0]:
        raise NativeArchiveError("Codex package version does not match the catalog")
    return [
        (path.as_posix(), member) for path, member in selected if member is not None
    ], expected_entrypoint


def _codebuddy_members(
    source: Path, artifact_format: str, native_entrypoint: str
) -> tuple[list[tuple[str, _Member]], str]:
    expected_entrypoint = _safe_path(native_entrypoint)
    if artifact_format == "native-zip":
        try:
            with zipfile.ZipFile(source) as archive:
                entries = _zip_entries(archive)
        except (OSError, zipfile.BadZipFile) as exc:
            raise NativeArchiveError("CodeBuddy native ZIP is invalid") from exc
    else:
        try:
            with tarfile.open(source, "r:gz") as archive:
                entries = _tar_entries(archive)
        except (OSError, tarfile.TarError) as exc:
            raise NativeArchiveError("CodeBuddy native tar.gz is invalid") from exc
    files = [path.as_posix() for path, member in entries if member is not None]
    matches = [name for name in files if name == expected_entrypoint or name.endswith("/" + expected_entrypoint)]
    if len(matches) != 1:
        raise NativeArchiveError("CodeBuddy declared entrypoint must match exactly one artifact file")
    candidate = matches[0]
    prefix = candidate[: -len(expected_entrypoint)].rstrip("/") if candidate != expected_entrypoint else ""
    root = _common_top_directory(entries, prefix)
    selected = _strip_package_root(entries, root) if root else entries
    selected_files = {
        path.as_posix(): member for path, member in selected if member is not None
    }
    entrypoint = candidate[len(root) + 1 :] if root else candidate
    if entrypoint not in selected_files:
        raise NativeArchiveError("CodeBuddy package does not contain its declared entrypoint")
    return [
        (path.as_posix(), member) for path, member in selected if member is not None
    ], entrypoint


def _zip_entries(archive: zipfile.ZipFile) -> list[tuple[PurePosixPath, _Member | None]]:
    infos = archive.infolist()
    _check_count(len(infos) + 2)
    names: set[str] = set()
    total = 0
    entries: list[tuple[PurePosixPath, _Member | None]] = []
    for info in infos:
        path = _normalize_member(info.filename, directory=info.is_dir())
        if path is None:
            continue
        _add_unique(names, path)
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise NativeArchiveError("native ZIP contains a link or special file")
        is_directory = info.is_dir() or kind == stat.S_IFDIR
        if is_directory:
            if info.file_size:
                raise NativeArchiveError("native ZIP directory contains data")
            entries.append((path, None))
            continue
        _check_limits(1, info.file_size)
        total += info.file_size
        if total > _MAX_EXPANDED_BYTES:
            raise NativeArchiveError("native artifact exceeds expanded size limit")
        mode = mode & 0o777 if mode else 0o644
        member = _Member(
            path.as_posix(),
            info.file_size,
            mode,
            lambda info=info: _open_zip_member(archive.filename, info.filename),
        )
        entries.append((path, member))
    return entries


def _tar_entries(archive: tarfile.TarFile) -> list[tuple[PurePosixPath, _Member | None]]:
    infos = archive.getmembers()
    _check_count(len(infos) + 2)
    names: set[str] = set()
    total = 0
    entries: list[tuple[PurePosixPath, _Member | None]] = []
    for info in infos:
        if info.issym() or info.islnk() or info.isdev() or info.isfifo() or info.sparse:
            raise NativeArchiveError("native tar.gz contains a link or special file")
        if not info.isfile() and not info.isdir():
            raise NativeArchiveError("native tar.gz contains an unsupported member")
        path = _normalize_member(info.name, directory=info.isdir())
        if path is None:
            continue
        _add_unique(names, path)
        if info.isdir():
            entries.append((path, None))
            continue
        _check_limits(1, info.size)
        total += info.size
        if total > _MAX_EXPANDED_BYTES:
            raise NativeArchiveError("native artifact exceeds expanded size limit")
        mode = info.mode & 0o777

        member = _Member(
            path.as_posix(),
            info.size,
            mode,
            lambda info=info: _open_tar_member(archive.name, info.name),
        )
        entries.append((path, member))
    return entries


def _normalize_member(value: str, *, directory: bool) -> PurePosixPath | None:
    if not value or "\\" in value or "\x00" in value or ":" in value:
        raise NativeArchiveError("native artifact contains an unsafe path")
    if value.startswith("/"):
        raise NativeArchiveError("native artifact contains an absolute path")
    parts = [part for part in value.rstrip("/").split("/") if part not in ("", ".")]
    if not parts:
        if directory and value in {".", "./", ""}:
            return None
        raise NativeArchiveError("native artifact contains an empty path")
    if ".." in parts:
        raise NativeArchiveError("native artifact path escapes its package")
    return PurePosixPath(*parts)


def _safe_path(value: str | None) -> str:
    if not isinstance(value, str):
        raise NativeArchiveError("native engine entrypoint is missing")
    path = _normalize_member(value, directory=False)
    if path is None or path.as_posix() != value:
        raise NativeArchiveError("native engine entrypoint is not a normalized relative path")
    return path.as_posix()


def _add_unique(names: set[str], path: PurePosixPath) -> None:
    key = path.as_posix().casefold()
    if key in names:
        raise NativeArchiveError("native artifact contains duplicate normalized paths")
    names.add(key)


def _check_count(count: int) -> None:
    if count > _MAX_FILES:
        raise NativeArchiveError("native artifact contains too many entries")


def _check_limits(count: int, size: int) -> None:
    _check_count(count)
    if size < 0 or size > _MAX_FILE_BYTES:
        raise NativeArchiveError("native artifact file exceeds size limit")


def _common_top_directory(
    entries: list[tuple[PurePosixPath, _Member | None]], candidate_prefix: str
) -> str:
    if not candidate_prefix:
        return ""
    files = [path.parts for path, member in entries if member is not None]
    root = candidate_prefix.split("/", 1)[0]
    if not files or any(len(parts) < 2 or parts[0] != root for parts in files):
        return ""
    return root


def _strip_package_root(
    entries: list[tuple[PurePosixPath, _Member | None]], root: str
) -> list[tuple[PurePosixPath, _Member | None]]:
    prefix = PurePosixPath(root) if root else None
    selected: list[tuple[PurePosixPath, _Member | None]] = []
    for path, member in entries:
        if prefix is None:
            selected.append((path, member))
            continue
        if path == prefix:
            continue
        if path.is_relative_to(prefix):
            relative = PurePosixPath(*path.parts[len(prefix.parts) :])
            if relative.parts:
                selected.append((relative, member))
            continue
        if member is None and prefix.is_relative_to(path):
            continue
        raise NativeArchiveError("native package contains files outside its package root")
    return selected


def _copy_limited(source, destination, expected_size: int) -> None:
    copied = 0
    while chunk := source.read(_CHUNK_SIZE):
        copied += len(chunk)
        if copied > expected_size or copied > _MAX_FILE_BYTES:
            raise NativeArchiveError("native artifact file exceeds its declared size")
        destination.write(chunk)
    if copied != expected_size:
        raise NativeArchiveError("native artifact file size does not match its archive header")


@contextmanager
def _open_zip_member(archive_path: str, member_name: str):
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open(member_name, "r") as stream:
            yield stream


@contextmanager
def _open_tar_member(archive_path: str, member_name: str):
    with tarfile.open(archive_path, "r:gz") as archive:
        member = archive.getmember(member_name)
        stream = archive.extractfile(member)
        if stream is None:
            raise NativeArchiveError("native tar.gz file could not be read")
        with stream:
            yield stream
