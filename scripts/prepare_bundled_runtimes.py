"""Prepare verified, offline runtime components for a desktop build."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform as host_platform
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from packaging.tags import compatible_tags, cpython_tags, mac_platforms
from packaging.utils import canonicalize_name, parse_wheel_filename

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from mona.runtime.download import VerifiedDownloader  # noqa: E402
from mona.runtime.manager import RuntimeComponentManifest  # noqa: E402

SOURCES = REPO_ROOT / "runtime-library" / "bundled-sources.json"
DEFAULT_OUTPUT = REPO_ROOT / "src-tauri" / "resources" / "runtime-base"
DEFAULT_CACHE = REPO_ROOT / "dist" / "runtime-inputs" / "bundled-runtimes"
PYTHON_VERSION = "3.13.15"
NODE_VERSION = "22.23.2"
COMMON_VERSION = "1.0.0"
COMMON_REQUIREMENTS = {
    "defusedxml": "0.7.1",
    "lxml": "6.1.2",
    "pillow": "12.3.0",
    "pymupdf": "1.26.4",
    "pyyaml": "6.0.3",
    "websockets": "17.1",
}
HOSTED_DOCUMENT_REQUIREMENTS = {
    "defusedxml": "0.7.1",
    "et-xmlfile": "2.0.0",
    "loguru": "0.7.3",
    "lxml": "6.1.2",
    "openpyxl": "3.1.5",
    "pillow": "12.3.0",
    "pymupdf": "1.26.4",
    "python-docx": "1.2.0",
    "python-pptx": "1.0.2",
    "typing-extensions": "4.15.0",
    "xlsxwriter": "3.2.5",
}
HOSTED_DOCUMENT_VERSION = "1.0.0+linux.x64.cp311"
_MAX_FILES = 20_000
_MAX_FILE_BYTES = 512 * 1024 * 1024
_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _verify_source(path: Path, source: dict[str, Any]) -> None:
    if not path.is_file() or path.stat().st_size != source["size"] or _sha256(path) != source["sha256"]:
        raise ValueError(f"runtime input does not match its fixed size and SHA-256: {path.name}")


async def _obtain(
    source: dict[str, Any],
    cache: Path,
    local: Path | None,
    downloader: VerifiedDownloader,
    *,
    offline: bool,
) -> Path:
    filename = source["filename"]
    if not isinstance(filename, str) or Path(filename).name != filename or "\\" in filename:
        raise ValueError("invalid runtime input filename")
    destination = cache / filename
    if destination.exists():
        _verify_source(destination, source)
        return destination
    if local is not None and local.is_file():
        _verify_source(local, source)
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cache, prefix=".input-", delete=False) as temporary:
            staged = Path(temporary.name)
        try:
            shutil.copyfile(local, staged)
            _verify_source(staged, source)
            os.replace(staged, destination)
        finally:
            staged.unlink(missing_ok=True)
        return destination
    if offline:
        raise FileNotFoundError(f"offline runtime input is missing: {filename}")
    await downloader.download(
        source["urls"], destination,
        expected_sha256=source["sha256"], expected_size=source["size"],
    )
    _verify_source(destination, source)
    return destination


def _manifest(kind: str, platform: str) -> RuntimeComponentManifest:
    if kind == "python-base":
        entry = "python/python.exe" if platform == "win32" else "python/bin/python3"
        return RuntimeComponentManifest(
            id=kind, version=PYTHON_VERSION, kind="python-runtime", entrypoints={"python": entry},
        )
    if kind == "node-base":
        entry = "node/node.exe" if platform == "win32" else "node/node"
        return RuntimeComponentManifest(
            id=kind, version=NODE_VERSION, kind="node-runtime", entrypoints={"node": entry},
        )
    if kind == "python-common":
        return RuntimeComponentManifest(
            id=kind, version=COMMON_VERSION, kind="python-pack",
            dependencies=[f"python-base@{PYTHON_VERSION}"],
            pythonRequirements="requirements.lock", pythonWheelhouse="wheels",
            healthImports=["defusedxml", "lxml.etree", "PIL", "pymupdf", "yaml", "websockets"],
        )
    raise ValueError(f"unknown runtime component: {kind}")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _archive_name(raw: str) -> PurePosixPath:
    if not raw or "\\" in raw or "\x00" in raw:
        raise ValueError(f"unsafe archive path: {raw!r}")
    path = PurePosixPath(raw)
    if path.is_absolute() or not path.parts or ".." in path.parts or any(":" in part for part in path.parts):
        raise ValueError(f"unsafe archive path: {raw!r}")
    return path


def _verify_component(path: Path, expected: RuntimeComponentManifest) -> RuntimeComponentManifest:
    with zipfile.ZipFile(path) as archive:
        manifest = RuntimeComponentManifest.model_validate_json(archive.read("runtime-manifest.json"))
        if manifest != expected:
            raise ValueError(f"component manifest does not match expected {expected.id}@{expected.version}")
        seen: set[str] = set()
        total = 0
        files = 0
        for item in archive.infolist():
            name = _archive_name(item.filename.rstrip("/"))
            key = name.as_posix().casefold()
            if key in seen:
                raise ValueError(f"duplicate component path: {item.filename}")
            seen.add(key)
            if stat.S_ISLNK((item.external_attr >> 16) & 0xFFFF):
                raise ValueError(f"component contains a symbolic link: {item.filename}")
            if not item.is_dir():
                files += 1
                total += item.file_size
                if files > _MAX_FILES or item.file_size > _MAX_FILE_BYTES or total > _MAX_TOTAL_BYTES:
                    raise ValueError("component exceeds runtime extraction limits")
        if any(value.casefold() not in seen for value in manifest.entrypoints.values()):
            raise ValueError(f"component entrypoint is missing: {expected.id}")
        if archive.testzip() is not None:
            raise ValueError(f"component archive is corrupt: {path.name}")
        if expected.id == "node-base" and expected.entrypoints["node"] == "node/node":
            for name in ("node/node", "node/npm", "node/npx"):
                if not (archive.getinfo(name).external_attr >> 16) & 0o111:
                    raise ValueError(f"macOS executable permission is missing: {name}")
            for name in ("node/node_modules/npm/bin/npm-cli.js", "node/node_modules/npm/bin/npx-cli.js"):
                archive.getinfo(name)
    return manifest


def _wheel_versions(platform: str, architecture: str, files: list[str]) -> dict[str, str]:
    if platform == "win32" and architecture == "x64":
        platforms = ["win_amd64"]
    elif platform == "darwin" and architecture in {"x64", "arm64"}:
        platforms = list(mac_platforms(version=(11, 0), arch="x86_64" if architecture == "x64" else "arm64"))
    else:
        raise ValueError(f"unsupported bundled runtime target: {platform}/{architecture}")
    compatible = set(cpython_tags((3, 13), abis=["cp313"], platforms=platforms))
    compatible.update(compatible_tags((3, 13), interpreter="cp313", platforms=platforms))
    versions: dict[str, str] = {}
    for filename in files:
        name, version, _build, tags = parse_wheel_filename(filename)
        normalized = canonicalize_name(name)
        if normalized in versions or not compatible.intersection(tags):
            raise ValueError(f"wheel is duplicated or incompatible with {platform}/{architecture}: {filename}")
        versions[normalized] = str(version)
    if versions != COMMON_REQUIREMENTS:
        raise ValueError("bundled Python dependencies do not match the required common set")
    return versions


def _hosted_document_wheel_versions(files: list[str]) -> dict[str, str]:
    # The current Work image uses CPython 3.11 on Linux x64. The minimum
    # supported libc for this pack is glibc 2.28; it is not a macOS/Windows pack.
    platforms = [f"manylinux_2_{version}_x86_64" for version in range(28, 16, -1)]
    platforms += ["manylinux2014_x86_64", "manylinux2010_x86_64", "manylinux1_x86_64"]
    compatible = set(cpython_tags((3, 11), abis=["cp311"], platforms=platforms))
    compatible.update(compatible_tags((3, 11), interpreter="cp311", platforms=platforms))
    versions: dict[str, str] = {}
    for filename in files:
        name, version, _build, tags = parse_wheel_filename(filename)
        normalized = canonicalize_name(name)
        if normalized in versions or not compatible.intersection(tags):
            raise ValueError(f"wheel is duplicated or incompatible with hosted Linux CPython 3.11: {filename}")
        versions[normalized] = str(version)
    if versions != HOSTED_DOCUMENT_REQUIREMENTS:
        raise ValueError("hosted document dependencies do not match the required locked set")
    return versions


def _zip_info(name: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | (mode & 0o777)) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def _build_wheel_pack(path: Path, wheels: dict[str, Path], sources: dict[str, dict[str, Any]],
                      manifest: RuntimeComponentManifest) -> None:
    requirements = []
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for filename in sorted(wheels):
            name, version, _build, _tags = parse_wheel_filename(filename)
            requirements.append(f"{canonicalize_name(name)}=={version} --hash=sha256:{sources[filename]['sha256']}")
            with wheels[filename].open("rb") as source, archive.open(_zip_info(f"wheels/{filename}"), "w") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
        archive.writestr(_zip_info("requirements.lock"), "\n".join(sorted(requirements)) + "\n")
        archive.writestr(_zip_info("runtime-manifest.json"), _json_bytes(manifest.model_dump(mode="json", by_alias=True)))
    _verify_component(path, manifest)


def _build_common(path: Path, wheels: dict[str, Path], sources: dict[str, dict[str, Any]]) -> None:
    _build_wheel_pack(path, wheels, sources, _manifest("python-common", "win32"))


async def prepare_hosted_document_pack(*, output: Path, cache: Path, wheelhouse: Path | None = None,
                                       offline: bool = False, sources_file: Path = SOURCES) -> dict[str, Any]:
    """Build an immutable standard runtime wheel pack for an offline Work image build."""
    sources = json.loads(sources_file.read_text(encoding="utf-8"))
    if sources.get("schemaVersion") != 1:
        raise ValueError("unsupported bundled runtime sources schema")
    wheel_names = sources["hostedDocumentPacks"]["linux-x64-cp311"]
    _hosted_document_wheel_versions(wheel_names)
    sources_by_wheel = {name: {"filename": name, **sources["wheels"][name]} for name in wheel_names}
    downloader = VerifiedDownloader()
    cache = cache.resolve()
    local = wheelhouse.resolve() if wheelhouse else None
    inputs = await asyncio.gather(*(
        _obtain(source, cache, local / name if local else None, downloader, offline=offline)
        for name, source in sources_by_wheel.items()
    ))
    manifest = RuntimeComponentManifest(
        id="python-hosted-documents", version=HOSTED_DOCUMENT_VERSION, kind="python-pack",
        pythonEnvironment="hosted-work", pythonRequirements="requirements.lock", pythonWheelhouse="wheels",
        healthImports=["fitz", "docx", "openpyxl", "pptx"],
    )
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"python-hosted-documents-{HOSTED_DOCUMENT_VERSION}.zip"
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("refusing to replace an existing hosted runtime pack")
    with tempfile.TemporaryDirectory(prefix="mona-hosted-wheel-pack-") as temporary:
        archive = Path(temporary) / destination.name
        _build_wheel_pack(archive, dict(zip(wheel_names, inputs, strict=True)), sources_by_wheel, manifest)
        record = {"archive": destination.name, "size": archive.stat().st_size, "sha256": _sha256(archive),
                  "platform": "linux", "architecture": "x64", "pythonVersion": "3.11", "glibcMinimum": "2.28",
                  "manifest": manifest.model_dump(mode="json", by_alias=True)}
        # Stage in the same output directory before atomic publication.
        with tempfile.NamedTemporaryFile(dir=output, prefix=".hosted-pack-", delete=False) as staged:
            stage = Path(staged.name)
        try:
            shutil.copyfile(archive, stage)
            # Do not replace a concurrently created artifact.
            os.link(stage, destination)
        finally:
            stage.unlink(missing_ok=True)
    return record


def _link_target(path: PurePosixPath, member: tarfile.TarInfo, root: str) -> PurePosixPath:
    raw = member.linkname
    target = PurePosixPath(raw)
    if not raw or "\\" in raw or "\x00" in raw or target.is_absolute() or any(":" in p for p in target.parts):
        raise ValueError(f"unsafe archive link: {path}")
    parts = [] if member.islnk() else list(path.parent.parts)
    for part in target.parts:
        if part == "..":
            if len(parts) <= 1:
                raise ValueError(f"archive link escapes its root: {path}")
            parts.pop()
        elif part != ".":
            parts.append(part)
    if not parts or parts[0] != root:
        raise ValueError(f"archive link escapes its root: {path}")
    return PurePosixPath(*parts)


def _tar_files(bundle: tarfile.TarFile, expected_root: str) -> list[tuple[PurePosixPath, tarfile.TarInfo]]:
    members: dict[PurePosixPath, tarfile.TarInfo] = {}
    directories: set[PurePosixPath] = {PurePosixPath(expected_root)}
    for member in bundle.getmembers():
        name = member.name.rstrip("/")
        if name in {"", "."}:
            continue
        path = _archive_name(name)
        if path.parts[0] != expected_root or path in members:
            raise ValueError(f"unexpected or duplicate tar path: {member.name}")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError(f"unsupported tar member: {member.name}")
        members[path] = member
        directories.update(parent for parent in path.parents if parent.parts)
        if member.isdir():
            directories.add(path)
        if member.issym() or member.islnk():
            _link_target(path, member, expected_root)
    children: dict[PurePosixPath, set[PurePosixPath]] = {}
    for path in set(members) | directories:
        if len(path.parts) > 1:
            children.setdefault(path.parent, set()).add(path)

    def resolve(path: PurePosixPath) -> PurePosixPath:
        visited: set[PurePosixPath] = set()
        while True:
            for count in range(1, len(path.parts) + 1):
                prefix = PurePosixPath(*path.parts[:count])
                member = members.get(prefix)
                if member is not None and (member.issym() or member.islnk()):
                    if prefix in visited:
                        raise ValueError(f"archive link cycle: {prefix}")
                    visited.add(prefix)
                    path = _link_target(prefix, member, expected_root).joinpath(*path.parts[count:])
                    break
            else:
                return path

    result: list[tuple[PurePosixPath, tarfile.TarInfo]] = []
    total = 0

    def walk(real: PurePosixPath, relative: PurePosixPath, parents: frozenset[PurePosixPath]) -> None:
        nonlocal total
        resolved = resolve(real)
        member = members.get(resolved)
        if resolved in directories and (member is None or member.isdir()):
            if resolved in parents:
                raise ValueError(f"archive directory link cycle: {real}")
            for child in sorted(children.get(resolved, set()), key=str):
                walk(child, relative / child.name, parents | {resolved})
            return
        if member is None or not member.isfile():
            raise ValueError(f"archive link target is missing: {real}")
        total += member.size
        if len(result) >= _MAX_FILES or member.size > _MAX_FILE_BYTES or total > _MAX_TOTAL_BYTES:
            raise ValueError("tar archive exceeds runtime extraction limits")
        result.append((relative, member))

    walk(PurePosixPath(expected_root), PurePosixPath(), frozenset())
    return result


def _node_path(path: PurePosixPath) -> PurePosixPath | None:
    if path == PurePosixPath("bin/node"):
        return PurePosixPath("node/node")
    if path.parts[:2] == ("lib", "node_modules"):
        return PurePosixPath("node/node_modules", *path.parts[2:])
    if path.parts[0] == "bin" and path.name in {"npm", "npx", "corepack"}:
        return None
    return PurePosixPath("node", *path.parts)


def _node_wrapper(target: str) -> bytes:
    return (
        '#!/bin/sh\n'
        'node_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\n'
        f'exec "$node_dir/node" "$node_dir/node_modules/{target}" "$@"\n'
    ).encode("utf-8")


def _build_macos_component(source: Path, output: Path, kind: str, architecture: str = "arm64") -> None:
    root = "python" if kind == "python-base" else f"node-v{NODE_VERSION}-darwin-{architecture}"
    manifest = _manifest(kind, "darwin")
    names: set[str] = set()
    with tarfile.open(source, "r:gz") as bundle, zipfile.ZipFile(
        output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6,
    ) as archive:
        # Reading gzip members in source order avoids repeatedly decompressing the archive.
        files = sorted(_tar_files(bundle, root), key=lambda item: (item[1].offset_data, item[0].as_posix()))
        for path, member in files:
            target = PurePosixPath("python", *path.parts) if kind == "python-base" else _node_path(path)
            if target is None:
                continue
            key = target.as_posix().casefold()
            if key in names:
                raise ValueError(f"duplicate materialized component path: {target}")
            names.add(key)
            source_file = bundle.extractfile(member)
            if source_file is None:
                raise ValueError(f"unable to read tar member: {member.name}")
            with source_file, archive.open(_zip_info(target.as_posix(), member.mode), "w") as output_file:
                shutil.copyfileobj(source_file, output_file, length=1024 * 1024)
        if kind == "node-base":
            for name, target in {
                "npm": "npm/bin/npm-cli.js", "npx": "npm/bin/npx-cli.js",
                "corepack": "corepack/dist/corepack.js",
            }.items():
                if f"node/node_modules/{target}" in names:
                    archive.writestr(_zip_info(f"node/{name}", 0o755), _node_wrapper(target))
        archive.writestr(_zip_info("runtime-manifest.json"), _json_bytes(manifest.model_dump(mode="json", by_alias=True)))
    _verify_component(output, manifest)


async def prepare(
    *,
    platform: str,
    architecture: str,
    output: Path,
    cache: Path,
    components_dir: Path | None = None,
    wheelhouse: Path | None = None,
    offline: bool = False,
    sources_file: Path = SOURCES,
) -> dict[str, Any]:
    sources = json.loads(sources_file.read_text(encoding="utf-8"))
    if sources.get("schemaVersion") != 1:
        raise ValueError("unsupported bundled runtime sources schema")
    target = sources["targets"].get(f"{platform}-{architecture}")
    if target is None:
        raise ValueError(f"unsupported bundled runtime target: {platform}/{architecture}")
    wheel_names = target["wheels"]
    _wheel_versions(platform, architecture, wheel_names)
    downloader = VerifiedDownloader()
    cache = cache.resolve()
    output = output.resolve()
    components = components_dir.resolve() if components_dir else None
    wheels_dir = wheelhouse.resolve() if wheelhouse else None
    python_source = target["pythonBase"]
    node_source = target["nodeBase"]
    sources_by_wheel = {
        filename: {"filename": filename, **sources["wheels"][filename]} for filename in wheel_names
    }
    python_local = components / "python-base" / f"{PYTHON_VERSION}.zip" if components and platform == "win32" else None
    node_local = components / "node-base" / f"{NODE_VERSION}.zip" if components and platform == "win32" else None
    inputs = await asyncio.gather(
        _obtain(python_source, cache, python_local, downloader, offline=offline),
        _obtain(node_source, cache, node_local, downloader, offline=offline),
        *(
            _obtain(source, cache, wheels_dir / filename if wheels_dir else None, downloader, offline=offline)
            for filename, source in sources_by_wheel.items()
        ),
    )
    wheels = dict(zip(wheel_names, inputs[2:], strict=True))
    with tempfile.TemporaryDirectory(prefix="mona-bundled-runtime-") as temp:
        stage = Path(temp)
        names = {
            "python-base": f"python-base-{PYTHON_VERSION}.zip",
            "node-base": f"node-base-{NODE_VERSION}.zip",
            "python-common": f"python-common-{COMMON_VERSION}.zip",
        }
        for kind, source in (("python-base", inputs[0]), ("node-base", inputs[1])):
            destination = stage / names[kind]
            if platform == "win32":
                shutil.copyfile(source, destination)
                _verify_component(destination, _manifest(kind, platform))
            else:
                _build_macos_component(source, destination, kind, architecture)
        _build_common(stage / names["python-common"], wheels, sources_by_wheel)
        components_data = []
        for kind, filename in names.items():
            path = stage / filename
            manifest = _verify_component(path, _manifest(kind, platform))
            components_data.append({
                "archive": filename, "size": path.stat().st_size, "sha256": _sha256(path),
                "manifest": manifest.model_dump(mode="json", by_alias=True),
            })
        result = {"schemaVersion": 1, "platform": platform, "architecture": architecture, "components": components_data}
        (stage / "manifest.json").write_bytes(_json_bytes(result))
        output.mkdir(parents=True, exist_ok=True)
        for filename in [*names.values(), "manifest.json"]:
            destination = output / filename
            if destination.is_symlink():
                raise ValueError(f"bundled output must not be a symbolic link: {filename}")
            with tempfile.NamedTemporaryFile(dir=output, prefix=".bundled-", delete=False) as temporary:
                staged = Path(temporary.name)
            try:
                shutil.copyfile(stage / filename, staged)
                os.replace(staged, destination)
            finally:
                staged.unlink(missing_ok=True)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    machine = host_platform.machine().lower()
    default_arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    parser.add_argument("--platform", choices=["win32", "darwin", "linux"], default=sys.platform)
    parser.add_argument("--architecture", choices=["x64", "arm64"], default=default_arch)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--components-dir", type=Path)
    parser.add_argument("--wheelhouse", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--hosted-document-pack", action="store_true",
                        help="build the locked Linux CPython 3.11 Work wheel pack only")
    args = parser.parse_args()
    if args.hosted_document_pack:
        if args.output == DEFAULT_OUTPUT:
            parser.error("--hosted-document-pack requires an explicit --output directory")
        if args.architecture != "x64":
            parser.error("--hosted-document-pack currently supports Linux x64 only")
        result = asyncio.run(prepare_hosted_document_pack(
            output=args.output, cache=args.cache, wheelhouse=args.wheelhouse, offline=args.offline,
        ))
    else:
        result = asyncio.run(prepare(
            platform=args.platform, architecture=args.architecture, output=args.output,
            cache=args.cache, components_dir=args.components_dir, wheelhouse=args.wheelhouse,
            offline=args.offline,
        ))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
