r"""Build the Windows Mona hot-update package.

Usage: python scripts/build_update_package.py <version> <staging_dir> <output_path>
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath, PureWindowsPath

_JUNK_DIR_NAMES = {
    "__pycache__", "tests", "test", "testing", "_pytest", "pytest", "node_modules", ".git",
}
_JUNK_FILE_SUFFIXES = (".pyc", ".pyo")
_JUNK_FILE_NAMES = {"py.typed"}
_MAIN_EXECUTABLE_NAMES = ("Mona.exe", "Mona")
_OFFICE_RELATIVE_PATH = Path("_internal", "desktop-resources", "office-editor")
_OFFICE_TEMPLATE_NAMES = ("blank.docx", "blank.xlsx", "blank.pptx")
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_TARGET_PLATFORM = "windows"
_TARGET_ARCH = "x64"


class UpdatePackageValidationError(ValueError):
    """A staging tree cannot be used for a release update package."""


def _within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _checked_tree(path: Path) -> Path:
    """Resolve a real directory and reject links or resolved-path escapes."""

    if _is_link(path):
        raise UpdatePackageValidationError(f"Staging directory must not be a symlink: {path}")
    root = path.expanduser().resolve(strict=False)
    if not root.is_dir():
        raise UpdatePackageValidationError(f"Staging directory is not a directory: {path}")
    for entry in root.rglob("*"):
        if _is_link(entry):
            raise UpdatePackageValidationError(f"Symlinks are not allowed in staging: {entry}")
        resolved = entry.resolve(strict=False)
        if not _within(resolved, root):
            raise UpdatePackageValidationError(
                f"Staging path resolves outside staging: {entry}"
            )
    return root


def _is_link(path: Path) -> bool:
    # Windows junctions are not reported by Path.is_symlink on Python 3.11.
    return path.is_symlink() or bool(
        getattr(path.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _file(path: Path, label: str, root: Path) -> Path:
    candidate = path.resolve(strict=False)
    if not _within(candidate, root) or not path.is_file():
        raise UpdatePackageValidationError(f"Missing {label}: {path}")
    return candidate


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_office(gateway: Path) -> None:
    office = gateway / _OFFICE_RELATIVE_PATH
    if not office.is_dir():
        raise UpdatePackageValidationError(f"Missing bundled Office resources: {office}")
    manifest_path = _file(office / "manifest.json", "Office manifest", office)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise UpdatePackageValidationError(f"Invalid Office manifest: {manifest_path}") from exc
    if not isinstance(manifest, dict):
        raise UpdatePackageValidationError("Office manifest must be an object")
    if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise UpdatePackageValidationError("Office manifest schemaVersion must be 1")
    if manifest.get("platform") != _TARGET_PLATFORM or manifest.get("arch") != _TARGET_ARCH:
        raise UpdatePackageValidationError("Office manifest target must be windows/x64")

    sidecar = manifest.get("xlsxSidecar")
    if not isinstance(sidecar, dict):
        raise UpdatePackageValidationError("Office manifest must contain xlsxSidecar")
    if not isinstance(sidecar.get("version"), str) or not sidecar["version"].strip():
        raise UpdatePackageValidationError("Office sidecar version is missing")
    raw_path = sidecar.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip() or "\x00" in raw_path:
        raise UpdatePackageValidationError("Office sidecar path must be relative")
    normalized = raw_path.replace("\\", "/")
    posix_path = PurePosixPath(normalized)
    windows_path = PureWindowsPath(raw_path)
    if posix_path.is_absolute() or windows_path.is_absolute() or windows_path.drive or windows_path.root:
        raise UpdatePackageValidationError(f"Office sidecar path must be relative: {raw_path!r}")
    sidecar_path = (office.joinpath(*posix_path.parts)).resolve(strict=False)
    if not _within(sidecar_path, office):
        raise UpdatePackageValidationError(f"Office sidecar path escapes office-editor: {raw_path!r}")

    size = sidecar.get("size")
    digest = sidecar.get("sha256")
    if type(size) is not int or size < 0:
        raise UpdatePackageValidationError("Office sidecar size must be a non-negative integer")
    if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
        raise UpdatePackageValidationError("Office sidecar sha256 must be a 64-character hex digest")
    sidecar_path = _file(sidecar_path, "Office XLSX sidecar", office)
    if sidecar_path.stat().st_size != size:
        raise UpdatePackageValidationError("Office sidecar size mismatch")
    if _sha256(sidecar_path).lower() != digest.lower():
        raise UpdatePackageValidationError("Office sidecar sha256 mismatch")

    templates = office / "templates"
    if not templates.is_dir():
        raise UpdatePackageValidationError(f"Missing Office templates directory: {templates}")
    for name in _OFFICE_TEMPLATE_NAMES:
        _file(templates / name, f"Office template {name}", office)
    licenses = office / "licenses"
    if not licenses.is_dir() or not any(item.is_file() for item in licenses.iterdir()):
        raise UpdatePackageValidationError(f"Missing Office licenses directory: {licenses}")


def _validate_staging(path: Path) -> tuple[Path, Path]:
    staging = _checked_tree(path)
    entries = list(staging.iterdir())
    names = {entry.name for entry in entries}
    mains = [staging / name for name in _MAIN_EXECUTABLE_NAMES if name in names]
    if len(entries) != 2 or len(mains) != 1 or "mona-gateway" not in names:
        extras = ", ".join(sorted(names - set(_MAIN_EXECUTABLE_NAMES) - {"mona-gateway"}))
        raise UpdatePackageValidationError(
            f"Staging root must contain only one Mona executable and mona-gateway (extras: {extras or 'missing'})"
        )
    main = _file(mains[0], "main Mona executable", staging)
    gateway = staging / "mona-gateway"
    if not gateway.is_dir():
        raise UpdatePackageValidationError(f"Missing mona-gateway directory: {gateway}")
    _file(gateway / "mona-gateway.exe", "mona-gateway executable", staging)
    web_dist = gateway / "_internal" / "mona" / "web" / "dist"
    if web_dist.exists():
        raise UpdatePackageValidationError("mona-gateway contains the unused mona/web/dist web bundle")
    _validate_office(gateway)
    return main, gateway


def clean_staging(staging: Path) -> tuple[int, int]:
    """Remove known development-only artifacts from the gateway tree."""

    root = _checked_tree(staging)
    gateway = root / "mona-gateway"
    if not gateway.exists():
        return 0, 0
    deleted_files = deleted_dirs = 0
    for path in sorted(
        gateway.rglob("*"), key=lambda item: len(item.relative_to(gateway).parts), reverse=True
    ):
        if _is_link(path):
            raise UpdatePackageValidationError(f"Symlinks are not allowed in staging: {path}")
        if path.is_dir() and path.name in _JUNK_DIR_NAMES:
            shutil.rmtree(path)
            deleted_dirs += 1
        elif path.is_file() and (path.name in _JUNK_FILE_NAMES or path.name.endswith(_JUNK_FILE_SUFFIXES)):
            path.unlink()
            deleted_files += 1
    return deleted_files, deleted_dirs


def _validate_output(staging: Path, requested: Path) -> Path:
    if (requested.exists() and _is_link(requested)) or requested.is_symlink():
        raise UpdatePackageValidationError(f"Output path must not be a symlink: {requested}")
    if requested.exists() and not requested.is_file():
        raise UpdatePackageValidationError(f"Output path is not a file: {requested}")
    output = requested.expanduser().resolve(strict=False)
    if _within(output, staging):
        raise UpdatePackageValidationError(f"Output path must be outside staging: {output}")
    return output


def build_package(staging_dir: str, output_path: str) -> None:
    """Validate staging, remove development caches, and write the archive."""

    import zstandard

    staging_input = Path(staging_dir)
    if not staging_input.exists() and not staging_input.is_symlink():
        raise FileNotFoundError(f"Staging directory does not exist: {staging_dir}")
    main, gateway = _validate_staging(staging_input)
    staging = main.parent
    output = _validate_output(staging, Path(output_path))
    output.parent.mkdir(parents=True, exist_ok=True)
    deleted_files, deleted_dirs = clean_staging(staging)
    print(f"[clean] Removed {deleted_files} files, {deleted_dirs} dirs from staging")

    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.", suffix=".tmp", dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            with zstandard.ZstdCompressor(level=22, threads=0).stream_writer(stream) as compressor:
                with tarfile.open(fileobj=compressor, mode="w") as tar:
                    tar.add(main, arcname=main.name)
                    tar.add(gateway, arcname=gateway.name)
        os.replace(temp_name, output)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise

    size = output.stat().st_size
    print(f"Package: {output}")
    print(f"Size: {size} bytes ({size / 1_048_576:.1f} MB)")
    print(f"SHA256: {_sha256(output)}")


def main() -> None:
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    _version, staging_dir, output_path = sys.argv[1:4]
    build_package(staging_dir, output_path)


if __name__ == "__main__":
    main()
