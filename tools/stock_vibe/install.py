"""Install a locked local Stock Vibe runtime into Mona's managed runtime store."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import re
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mona.config.paths import get_managed_runtimes_dir  # noqa: E402
from mona.runtime.manager import (  # noqa: E402
    RuntimeComponentManifest,
    RuntimeComponentStore,
    RuntimeManagerError,
)
from mona.runtime.python_env import PythonEnvironmentBuilder  # noqa: E402

STOCK_ID = "stock-vibe"
STOCK_ENVIRONMENT = "stock-vibe"
PYTHON_BASE_REF = "python-base@3.13.15"


class InstallError(ValueError):
    """Raised when the local runtime archive cannot be safely installed."""


def _resolve_archive(value: str) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    try:
        archive = candidate.resolve(strict=True)
    except OSError as exc:
        raise InstallError("Archive file does not exist") from exc
    if not archive.is_relative_to(REPO_ROOT):
        raise InstallError("Archive must resolve inside this repository")
    if not archive.is_file():
        raise InstallError("Archive must be a regular file")
    return archive


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_manifest(archive: Path) -> RuntimeComponentManifest:
    try:
        with zipfile.ZipFile(archive) as bundle:
            manifest = RuntimeComponentManifest.model_validate_json(
                bundle.read("runtime-manifest.json")
            )
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        raise InstallError("Archive has no valid runtime-manifest.json") from exc
    if manifest.id != STOCK_ID:
        raise InstallError("Archive runtime id must be stock-vibe")
    if manifest.python_environment != STOCK_ENVIRONMENT:
        raise InstallError("Archive must declare the stock-vibe Python environment")
    if PYTHON_BASE_REF not in manifest.dependencies:
        raise InstallError(f"Archive must declare dependency {PYTHON_BASE_REF}")
    return manifest


def install(archive_arg: str, expected_sha256: str) -> tuple[str, str]:
    expected = expected_sha256.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise InstallError("--sha256 must be a 64-character SHA-256 hex digest")

    archive = _resolve_archive(archive_arg)
    if _sha256_file(archive) != expected:
        raise InstallError("Archive SHA-256 does not match --sha256")
    manifest = _read_manifest(archive)

    runtime_root = get_managed_runtimes_dir()
    store = RuntimeComponentStore(runtime_root)
    python_base = store.active("python-base")
    if python_base is None or python_base[0].version != "3.13.15":
        raise InstallError(
            f"Required managed runtime {PYTHON_BASE_REF} is not active; this command does not download it"
        )
    if "python" not in python_base[0].entrypoints:
        raise InstallError(f"Managed runtime {PYTHON_BASE_REF} has no Python entrypoint")

    installed = store.install_archive(archive)
    component_ref = f"{installed.id}@{installed.version}"
    environment = PythonEnvironmentBuilder(
        runtime_root,
        store,
        environment=STOCK_ENVIRONMENT,
    )
    ready = asyncio.run(environment.ensure([*manifest.dependencies, component_ref]))
    return component_ref, ready.generation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="Locked runtime ZIP inside this repository")
    parser.add_argument("--sha256", required=True, help="Expected SHA-256 of the runtime ZIP")
    args = parser.parse_args(argv)
    try:
        component_ref, generation = install(args.archive, args.sha256)
    except (InstallError, OSError, RuntimeManagerError) as exc:
        parser.error(str(exc))
    print(f"component={component_ref}")
    print(f"python_environment={STOCK_ENVIRONMENT} ready (generation={generation})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
