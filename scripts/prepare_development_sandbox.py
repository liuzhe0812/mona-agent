"""Build the pinned Windows ACL sandbox runner as a managed runtime component."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mona.config.paths import get_managed_runtimes_dir  # noqa: E402
from mona.runtime.manager import RuntimeComponentManifest, RuntimeComponentStore  # noqa: E402

SOURCE_RECORD = REPO_ROOT / "mona" / "development" / "sandbox_node" / "UPSTREAM.json"
LICENSE_DIR = REPO_ROOT / "mona" / "development" / "sandbox_node"
_ARCHIVE_METADATA_KEYS = {"archiveFile", "archiveSha256", "archiveSizeBytes"}
_SOURCE_PATHS = (
    "packages/sandbox/sandbox-windows-acl",
    "packages/subprocess/win32-process",
    "packages/subprocess/subprocess",
    "packages/util/lazy-require",
)


def _load_record() -> dict[str, Any]:
    return json.loads(SOURCE_RECORD.read_text(encoding="utf-8"))


def _run(args: list[str], *, cwd: Path) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except OSError as exc:
        raise RuntimeError(f"could not run {args[0]}: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"command failed ({result.returncode}): {args[0]}: {detail}")
    return result.stdout.strip()


def _validate_source(source: Path, record: dict[str, Any]) -> None:
    actual_commit = _run(["git", "rev-parse", "HEAD"], cwd=source)
    if actual_commit != record["commit"]:
        raise RuntimeError(
            f"DSH checkout must be at pinned commit {record['commit']}; found {actual_commit}"
        )
    changes = _run(["git", "status", "--porcelain", "--", *_SOURCE_PATHS], cwd=source)
    if changes:
        raise RuntimeError("DSH sandbox runner source or dependency closure has local changes")

    package_versions = {
        "packages/sandbox/sandbox-windows-acl/package.json": record["packageVersion"],
        "packages/subprocess/win32-process/package.json": record["win32ProcessVersion"],
        "packages/util/lazy-require/package.json": record["lazyRequireVersion"],
        "packages/subprocess/subprocess/package.json": record["subprocessVersion"],
    }
    for relative, expected in package_versions.items():
        package = json.loads((source / relative).read_text(encoding="utf-8"))
        if package.get("version") != expected:
            raise RuntimeError(f"unexpected DSH package version in {relative}")
    acl_package = json.loads(
        (source / "packages/sandbox/sandbox-windows-acl/package.json").read_text(encoding="utf-8")
    )
    if acl_package.get("name") != record["package"]:
        raise RuntimeError("unexpected DSH Windows ACL package name")


def _managed_node(record: dict[str, Any]) -> Path:
    store = RuntimeComponentStore(get_managed_runtimes_dir())
    active = store.active("node-base")
    if active is None:
        raise RuntimeError("managed node-base runtime is not installed or active")
    manifest, root = active
    if manifest.version != record["nodeBaseVersion"]:
        raise RuntimeError(
            f"build requires managed node-base@{record['nodeBaseVersion']}, "
            f"but {manifest.version} is active"
        )
    relative = manifest.entrypoints.get("node")
    if not relative:
        raise RuntimeError("managed node-base runtime has no node entrypoint")
    node = (root / Path(relative)).resolve(strict=True)
    if not node.is_file() or not node.is_relative_to(root.resolve(strict=True)):
        raise RuntimeError("managed node-base entrypoint is invalid")
    actual_version = _run([str(node), "--version"], cwd=REPO_ROOT)
    if actual_version != f"v{record['nodeBaseVersion']}":
        raise RuntimeError(f"managed Node reported unexpected version {actual_version}")
    return node


def _required_file(path: Path, label: str) -> Path:
    if not path.is_file():
        raise RuntimeError(f"required {label} is missing: {path}")
    return path.resolve(strict=True)


def _copy_koffi(source: Path, destination: Path, record: dict[str, Any]) -> None:
    store = source / "node_modules" / ".pnpm"
    koffi_root = store / f"koffi@{record['koffiVersion']}" / "node_modules" / "koffi"
    native_root = (
        store
        / f"@koromix+koffi-win32-x64@{record['koffiVersion']}"
        / "node_modules"
        / "@koromix"
        / "koffi-win32-x64"
    )
    package = json.loads(_required_file(koffi_root / "package.json", "Koffi package metadata").read_text(encoding="utf-8"))
    if package.get("name") != "koffi" or package.get("version") != record["koffiVersion"]:
        raise RuntimeError("unexpected Koffi package identity")

    native_package = json.loads(
        _required_file(native_root / "package.json", "Koffi Windows x64 native package").read_text(encoding="utf-8")
    )
    if native_package.get("version") != record["koffiVersion"]:
        raise RuntimeError("unexpected Koffi Windows x64 native package version")

    koffi_destination = destination / "node_modules" / "koffi"
    (koffi_destination / "src" / "koffi" / "src").mkdir(parents=True)
    for relative in (
        "package.json",
        "index.cjs",
        "src/koffi/index.cjs",
        "src/koffi/src/static.cjs",
    ):
        shutil.copy2(koffi_root / relative, koffi_destination / relative)
    native_destination = destination / "node_modules" / "@koromix" / "koffi-win32-x64"
    shutil.copytree(native_root, native_destination, symlinks=False)


def _zip_component(source_dir: Path, output: Path, manifest: RuntimeComponentManifest) -> None:
    manifest_path = source_dir / "runtime-manifest.json"
    manifest_path.write_text(manifest.model_dump_json(by_alias=True, indent=2) + "\n", encoding="utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise RuntimeError(f"refusing to overwrite existing archive: {output}")

    temporary = output.with_name(f".{output.name}.tmp")
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in source_dir.rglob("*") if item.is_file()):
                relative = path.relative_to(source_dir).as_posix()
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def build(source: Path, output: Path) -> tuple[str, int]:
    if os.name != "nt":
        raise RuntimeError("the DSH Windows ACL component must be built on Windows x64")
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise RuntimeError("DSH source must be a directory")
    record = _load_record()
    _validate_source(source, record)
    node = _managed_node(record)

    esbuild = _required_file(
        source
        / "node_modules"
        / ".pnpm"
        / f"esbuild@{record['esbuildVersion']}"
        / "node_modules"
        / "esbuild"
        / "bin"
        / "esbuild",
        "pinned esbuild CLI",
    )
    runner_entry = _required_file(
        source / "packages" / "sandbox" / "sandbox-windows-acl" / "lib" / "runner.js",
        "DSH Windows ACL runner entry",
    )

    with tempfile.TemporaryDirectory(prefix="mona-development-sandbox-") as temporary_dir:
        component_root = Path(temporary_dir)
        bin_dir = component_root / "bin"
        bin_dir.mkdir()
        bundled_runner = bin_dir / "runner.mjs"
        _run(
            [
                str(node),
                str(esbuild),
                str(runner_entry),
                "--bundle",
                "--platform=node",
                "--format=esm",
                "--target=node22",
                f"--outfile={bundled_runner}",
            ],
            cwd=source,
        )
        _run([str(node), "--check", str(bundled_runner)], cwd=source)
        _copy_koffi(source, component_root, record)
        component_record = {
            key: value for key, value in record.items() if key not in _ARCHIVE_METADATA_KEYS
        }
        with (component_root / "UPSTREAM.json").open(
            "w", encoding="utf-8", newline="\n"
        ) as handle:
            json.dump(component_record, handle, ensure_ascii=False, indent=2)
            handle.write("\n")

        license_dir = component_root / "licenses"
        license_dir.mkdir()
        for source_name, target_name in (
            ("LICENSE-DeepSeek-Harness-MIT.txt", "DeepSeek-Harness-MIT.txt"),
            ("LICENSE-Koffi-MIT.txt", "Koffi-MIT.txt"),
        ):
            shutil.copy2(_required_file(LICENSE_DIR / source_name, source_name), license_dir / target_name)

        manifest = RuntimeComponentManifest(
            id=record["componentId"],
            version=record["componentVersion"],
            kind="development-sandbox",
            entrypoints={"runner": "bin/runner.mjs"},
            dependencies=[f"node-base@{record['nodeBaseVersion']}"],
        )
        _zip_component(component_root, output.resolve(), manifest)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    size = output.stat().st_size
    expected_digest = record.get("archiveSha256")
    expected_size = record.get("archiveSizeBytes")
    if expected_digest and digest != expected_digest:
        raise RuntimeError("built archive does not match the pinned SHA-256 in UPSTREAM.json")
    if expected_size and size != expected_size:
        raise RuntimeError("built archive size does not match UPSTREAM.json")
    return digest, size


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsh-source", type=Path, required=True, help="DSH checkout at the pinned commit")
    parser.add_argument("--output", type=Path, required=True, help="new ZIP path for RuntimeComponentStore.install_archive")
    args = parser.parse_args()
    try:
        digest, size = build(args.dsh_source, args.output)
    except (OSError, ValueError, RuntimeError) as exc:
        parser.error(str(exc))
    print(f"archive={args.output.resolve()}")
    print(f"size={size}")
    print(f"sha256={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
