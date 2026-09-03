"""Prepare pinned Windows runtime component sources for signed publication."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from packaging.utils import canonicalize_name, parse_wheel_filename

PYTHON_VERSION = "3.13.15"
NODE_VERSION = "22.23.2"
ACADEMIC_PACK_VERSION = "1.0.0"
FFMPEG_VERSION = "6.1.1"
FFPROBE_VERSION = "6.1"
YTDLP_VERSION = "2026.07.04"
ASR_SENSEVOICE_VERSION = "0.2.6+q8"
PANDOC_VERSION = "3.10.1"
CUA_DRIVER_VERSION = "0.23.2"
WESTOCK_VERSION = "1.0.5"


def prepare_python_base(python_home: Path, components_root: Path) -> Path:
    source_python = python_home / "python.exe"
    if not source_python.is_file():
        raise RuntimeError(f"python.exe not found in {python_home}")
    version = _output([str(source_python), "-I", "-c", "import platform;print(platform.python_version())"])
    if version != PYTHON_VERSION:
        raise RuntimeError(f"expected Python {PYTHON_VERSION}, got {version}")
    target = components_root / "python-base" / PYTHON_VERSION
    _replace_directory(target)
    runtime_home = target / "python"
    shutil.copytree(
        python_home,
        runtime_home,
        ignore=shutil.ignore_patterns(
            "__pycache__",
            "*.pyc",
            "*.pyo",
            "Doc",
            "include",
            "Lib/site-packages",
            "Tools",
        ),
    )
    copied_python = runtime_home / "python.exe"
    _run(
        [
            str(copied_python),
            "-I",
            "-c",
            "import ensurepip,ssl,venv;print(ssl.OPENSSL_VERSION)",
        ]
    )
    _write_json(
        target / "runtime-manifest.json",
        {
            "schemaVersion": 1,
            "id": "python-base",
            "version": PYTHON_VERSION,
            "kind": "python-runtime",
            "entrypoints": {"python": "python/python.exe"},
            "dependencies": [],
        },
    )
    _write_distribution(target)
    return target


def prepare_node_base(archive: Path, components_root: Path) -> Path:
    if not archive.is_file():
        raise RuntimeError(f"Node archive not found: {archive}")
    target = components_root / "node-base" / NODE_VERSION
    _replace_directory(target)
    with tempfile.TemporaryDirectory(prefix="mona-node-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            _safe_extract(bundle, temporary_root)
        candidates = list(temporary_root.glob("*/node.exe"))
        if len(candidates) != 1:
            raise RuntimeError("Node archive must contain one top-level node.exe")
        shutil.copytree(candidates[0].parent, target / "node")
    version = _output([str(target / "node" / "node.exe"), "--version"]).removeprefix("v")
    if version != NODE_VERSION:
        raise RuntimeError(f"expected Node {NODE_VERSION}, got {version}")
    _write_json(
        target / "runtime-manifest.json",
        {
            "schemaVersion": 1,
            "id": "node-base",
            "version": NODE_VERSION,
            "kind": "node-runtime",
            "entrypoints": {"node": "node/node.exe"},
            "dependencies": [],
        },
    )
    _write_distribution(target)
    return target


def prepare_ffmpeg(
    ffmpeg_gz: Path,
    ffprobe_zip: Path,
    license_file: Path,
    components_root: Path,
) -> Path:
    _require_file(ffmpeg_gz, "FFmpeg archive")
    _require_file(ffprobe_zip, "FFprobe archive")
    _require_file(license_file, "FFmpeg license")
    target = components_root / "ffmpeg" / FFMPEG_VERSION
    _replace_directory(target)
    with gzip.open(ffmpeg_gz, "rb") as source, (target / "ffmpeg.exe").open("wb") as destination:
        shutil.copyfileobj(source, destination)
    with tempfile.TemporaryDirectory(prefix="mona-ffprobe-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(ffprobe_zip) as bundle:
            _safe_extract(bundle, temporary_root)
        candidates = list(temporary_root.rglob("ffprobe.exe"))
        if len(candidates) != 1:
            raise RuntimeError("FFprobe archive must contain one ffprobe.exe")
        shutil.copyfile(candidates[0], target / "ffprobe.exe")
    ffmpeg_version = _output([str(target / "ffmpeg.exe"), "-version"])
    if FFMPEG_VERSION not in ffmpeg_version:
        raise RuntimeError(f"expected FFmpeg {FFMPEG_VERSION}, got {ffmpeg_version}")
    ffprobe_version = _output([str(target / "ffprobe.exe"), "-version"])
    if FFPROBE_VERSION not in ffprobe_version:
        raise RuntimeError(f"expected FFprobe {FFPROBE_VERSION}, got {ffprobe_version}")
    shutil.copyfile(license_file, target / "LICENSE.txt")
    _write_runtime_manifest(
        target,
        component_id="ffmpeg",
        version=FFMPEG_VERSION,
        kind="ffmpeg-runtime",
        entrypoints={"ffmpeg": "ffmpeg.exe", "ffprobe": "ffprobe.exe"},
    )
    _write_distribution(target)
    return target


def prepare_yt_dlp(executable: Path, components_root: Path) -> Path:
    _require_file(executable, "yt-dlp executable")
    version = _output([str(executable), "--version"])
    if version != YTDLP_VERSION:
        raise RuntimeError(f"expected yt-dlp {YTDLP_VERSION}, got {version}")
    target = components_root / "yt-dlp" / YTDLP_VERSION
    _replace_directory(target)
    shutil.copyfile(executable, target / "yt-dlp.exe")
    _write_runtime_manifest(
        target,
        component_id="yt-dlp",
        version=YTDLP_VERSION,
        kind="yt-dlp-runtime",
        entrypoints={"yt_dlp": "yt-dlp.exe"},
    )
    _write_distribution(target)
    return target


def prepare_asr_sensevoice(
    runtime_zip: Path,
    model: Path,
    vad: Path,
    components_root: Path,
) -> Path:
    _require_file(runtime_zip, "SenseVoice runtime archive")
    _require_file(model, "SenseVoice model")
    _require_file(vad, "SenseVoice VAD model")
    if model.name == vad.name:
        raise RuntimeError("SenseVoice model and VAD model must have different filenames")
    target = components_root / "asr-sensevoice" / ASR_SENSEVOICE_VERSION
    _replace_directory(target)
    with tempfile.TemporaryDirectory(prefix="mona-asr-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(runtime_zip) as bundle:
            _safe_extract(bundle, temporary_root)
        candidates = list(temporary_root.rglob("llama-funasr-sensevoice.exe"))
        if len(candidates) != 1:
            raise RuntimeError(
                "SenseVoice runtime archive must contain one llama-funasr-sensevoice.exe"
            )
        shutil.copytree(temporary_root, target, dirs_exist_ok=True)
        transcribe = candidates[0].relative_to(temporary_root).as_posix()
    shutil.copyfile(model, target / model.name)
    shutil.copyfile(vad, target / vad.name)
    _write_runtime_manifest(
        target,
        component_id="asr-sensevoice",
        version=ASR_SENSEVOICE_VERSION,
        kind="asr-runtime",
        entrypoints={
            "transcribe": transcribe,
            "model": model.name,
            "vad": vad.name,
        },
        dependencies=[f"ffmpeg@{FFMPEG_VERSION}"],
    )
    _write_distribution(target)
    return target


def prepare_pandoc(archive: Path, components_root: Path) -> Path:
    _require_file(archive, "Pandoc archive")
    target = components_root / "pandoc" / PANDOC_VERSION
    _replace_directory(target)
    with tempfile.TemporaryDirectory(prefix="mona-pandoc-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            _safe_extract(bundle, temporary_root)
        candidates = list(temporary_root.rglob("pandoc.exe"))
        if len(candidates) != 1:
            raise RuntimeError("Pandoc archive must contain one pandoc.exe")
        version = _output([str(candidates[0]), "--version"])
        if PANDOC_VERSION not in version:
            raise RuntimeError(f"expected Pandoc {PANDOC_VERSION}, got {version}")
        shutil.copytree(temporary_root, target, dirs_exist_ok=True)
        pandoc = candidates[0].relative_to(temporary_root).as_posix()
    _write_runtime_manifest(
        target,
        component_id="pandoc",
        version=PANDOC_VERSION,
        kind="pandoc-runtime",
        entrypoints={"pandoc": pandoc},
    )
    _write_distribution(target)
    return target


def prepare_cua_driver(archive: Path, components_root: Path) -> Path:
    _require_file(archive, "Cua Driver archive")
    target = components_root / "cua-driver" / CUA_DRIVER_VERSION
    _replace_directory(target)
    with tempfile.TemporaryDirectory(prefix="mona-cua-") as temporary:
        temporary_root = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            _safe_extract(bundle, temporary_root)
        candidates = list(temporary_root.rglob("cua-driver.exe"))
        if len(candidates) != 1:
            raise RuntimeError("Cua Driver archive must contain one cua-driver.exe")
        shutil.copytree(temporary_root, target, dirs_exist_ok=True)
        driver = candidates[0].relative_to(temporary_root).as_posix()
    _write_runtime_manifest(
        target,
        component_id="cua-driver",
        version=CUA_DRIVER_VERSION,
        kind="computer-use-runtime",
        entrypoints={"driver": driver},
    )
    _write_distribution(target)
    return target


def prepare_westock(package_tgz: Path, components_root: Path) -> Path:
    _require_file(package_tgz, "WeStock package")
    target = components_root / "westock-data" / WESTOCK_VERSION
    _replace_directory(target)
    with tarfile.open(package_tgz, "r:gz") as bundle:
        _safe_extract_package(bundle, target)
    package_json = target / "package.json"
    _require_file(package_json, "WeStock package.json")
    try:
        metadata = json.loads(package_json.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("WeStock package.json is invalid") from exc
    if not isinstance(metadata, dict):
        raise RuntimeError("WeStock package.json must be an object")
    if metadata.get("name") != "westock-data-skillhub":
        raise RuntimeError("WeStock package name is invalid")
    if metadata.get("version") != WESTOCK_VERSION:
        raise RuntimeError(
            f"expected WeStock {WESTOCK_VERSION}, got {metadata.get('version')}"
        )
    main = str(metadata.get("main") or "index.js")
    main_path = PurePosixPath(main)
    if (
        main_path.is_absolute()
        or ".." in main_path.parts
        or "\\" in main
        or not main_path.parts
        or not (target.joinpath(*main_path.parts)).is_file()
    ):
        raise RuntimeError("WeStock package main entrypoint is invalid")
    _write_runtime_manifest(
        target,
        component_id="westock-data",
        version=WESTOCK_VERSION,
        kind="stock-data-runtime",
        entrypoints={"main": main_path.as_posix()},
        dependencies=[f"node-base@{NODE_VERSION}"],
    )
    _write_distribution(target)
    return target


def prepare_python_academic(
    components_root: Path,
    requirements: Path,
    *,
    index_url: str,
    expected_lock: Path,
    update_lock: bool = False,
) -> Path:
    base_python = components_root / "python-base" / PYTHON_VERSION / "python" / "python.exe"
    if not base_python.is_file():
        raise RuntimeError("prepare python-base before python-academic")
    target = components_root / "python-academic" / ACADEMIC_PACK_VERSION
    _replace_directory(target)
    wheelhouse = target / "wheels"
    wheelhouse.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="mona-wheel-builder-") as temporary:
        venv = Path(temporary) / "venv"
        _run([str(base_python), "-m", "venv", str(venv)])
        python = venv / "Scripts" / "python.exe"
        _run(
            [
                str(python),
                "-m",
                "pip",
                "download",
                "--only-binary=:all:",
                "--dest",
                str(wheelhouse),
                "--index-url",
                index_url,
                "-r",
                str(requirements.resolve()),
            ]
        )
    generated_lock = target / "requirements.lock"
    _write_hashed_lock(wheelhouse, generated_lock)
    if update_lock:
        expected_lock.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(generated_lock, expected_lock)
    elif not expected_lock.is_file():
        raise RuntimeError(f"expected dependency lock is missing: {expected_lock}")
    elif generated_lock.read_bytes() != expected_lock.read_bytes():
        raise RuntimeError(
            "resolved wheel set differs from the committed lock; "
            "review changes and rerun with --update-lock"
        )
    _write_json(
        target / "runtime-manifest.json",
        {
            "schemaVersion": 1,
            "id": "python-academic",
            "version": ACADEMIC_PACK_VERSION,
            "kind": "python-pack",
            "entrypoints": {},
            "dependencies": [f"python-base@{PYTHON_VERSION}"],
            "pythonRequirements": "requirements.lock",
            "pythonWheelhouse": "wheels",
            "healthImports": [
                "docx",
                "fitz",
                "jsonschema",
                "matplotlib",
                "numpy",
                "pandas",
                "pdfplumber",
                "pypdf",
                "scipy",
                "yaml",
            ],
        },
    )
    _write_distribution(target)
    return target


def _write_hashed_lock(wheelhouse: Path, destination: Path) -> None:
    packages: dict[str, tuple[str, str]] = {}
    for wheel in sorted(wheelhouse.glob("*.whl")):
        name, version, _build, _tags = parse_wheel_filename(wheel.name)
        normalized = canonicalize_name(name)
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        value = (str(version), digest)
        if normalized in packages and packages[normalized] != value:
            raise RuntimeError(f"wheelhouse contains conflicting builds for {normalized}")
        packages[normalized] = value
    if not packages:
        raise RuntimeError("wheelhouse is empty")
    lines = [
        f"{name}=={version} --hash=sha256:{digest}"
        for name, (version, digest) in sorted(packages.items())
    ]
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _safe_extract(bundle: zipfile.ZipFile, destination: Path) -> None:
    for member in bundle.infolist():
        path = Path(member.filename)
        if path.is_absolute() or ".." in path.parts or "\\" in member.filename:
            raise RuntimeError(f"unsafe archive path: {member.filename}")
    bundle.extractall(destination)


def _safe_extract_package(bundle: tarfile.TarFile, destination: Path) -> None:
    members = bundle.getmembers()
    for member in members:
        if "\\" in member.name:
            raise RuntimeError(f"unsafe archive path: {member.name}")
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise RuntimeError(f"unsafe archive path: {member.name}")
        if not path.parts or path.parts[0] != "package":
            continue
        if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
            raise RuntimeError(f"unsupported package archive member: {member.name}")

    extracted = 0
    for member in members:
        path = PurePosixPath(member.name)
        if len(path.parts) <= 1 or path.parts[0] != "package":
            continue
        target = destination.joinpath(*path.parts[1:])
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        source = bundle.extractfile(member)
        if source is None:
            raise RuntimeError(f"package archive member cannot be read: {member.name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as output:
            shutil.copyfileobj(source, output)
        extracted += 1
    if extracted == 0:
        raise RuntimeError("WeStock package archive is empty")


def _require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise RuntimeError(f"{label} not found: {path}")


def _replace_directory(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def _write_runtime_manifest(
    path: Path,
    *,
    component_id: str,
    version: str,
    kind: str,
    entrypoints: dict[str, str],
    dependencies: list[str] | None = None,
) -> None:
    _write_json(
        path / "runtime-manifest.json",
        {
            "schemaVersion": 1,
            "id": component_id,
            "version": version,
            "kind": kind,
            "entrypoints": entrypoints,
            "dependencies": dependencies or [],
        },
    )


def _write_distribution(path: Path) -> None:
    _write_json(
        path / "distribution.json",
        {"platforms": ["win32"], "architectures": ["x64"], "mirrors": []},
    )


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _run(command: list[str]) -> None:
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"command failed with exit code {result.returncode}: {command[0]}")


def _output(command: list[str]) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--components-root",
        type=Path,
        default=Path("runtime-library/components"),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    python_base = subparsers.add_parser("python-base")
    python_base.add_argument("--python-home", type=Path, required=True)
    node_base = subparsers.add_parser("node-base")
    node_base.add_argument("--archive", type=Path, required=True)
    ffmpeg = subparsers.add_parser("ffmpeg")
    ffmpeg.add_argument(
        "--ffmpeg-gz",
        "--ffmpeg-archive",
        "--ffmpeg",
        dest="ffmpeg_gz",
        type=Path,
        required=True,
    )
    ffmpeg.add_argument(
        "--ffprobe-zip",
        "--ffprobe-archive",
        "--ffprobe",
        dest="ffprobe_zip",
        type=Path,
        required=True,
    )
    ffmpeg.add_argument("--license", "--license-file", dest="license_file", type=Path, required=True)
    yt_dlp = subparsers.add_parser("yt-dlp")
    yt_dlp.add_argument("--executable", "--exe", type=Path, required=True)
    asr = subparsers.add_parser("asr-sensevoice")
    asr.add_argument("--runtime-zip", "--runtime", "--archive", dest="runtime_zip", type=Path, required=True)
    asr.add_argument("--model", type=Path, required=True)
    asr.add_argument("--vad", type=Path, required=True)
    pandoc = subparsers.add_parser("pandoc")
    pandoc.add_argument("--archive", type=Path, required=True)
    cua_driver = subparsers.add_parser("cua-driver")
    cua_driver.add_argument("--archive", type=Path, required=True)
    westock = subparsers.add_parser("westock")
    westock.add_argument("--package-tgz", "--tgz", "--archive", dest="package_tgz", type=Path, required=True)
    academic = subparsers.add_parser("python-academic")
    academic.add_argument(
        "--requirements",
        type=Path,
        default=Path("runtime-library/requirements/python-academic.in"),
    )
    academic.add_argument(
        "--index-url",
        default=os.environ.get("PIP_INDEX_URL", "https://pypi.org/simple"),
    )
    academic.add_argument(
        "--expected-lock",
        type=Path,
        default=Path("runtime-library/locks/python-academic-1.0.0.lock"),
    )
    academic.add_argument("--update-lock", action="store_true")
    args = parser.parse_args()
    if args.command == "python-base":
        prepare_python_base(args.python_home, args.components_root)
    elif args.command == "node-base":
        prepare_node_base(args.archive, args.components_root)
    elif args.command == "ffmpeg":
        prepare_ffmpeg(args.ffmpeg_gz, args.ffprobe_zip, args.license_file, args.components_root)
    elif args.command == "yt-dlp":
        prepare_yt_dlp(args.executable, args.components_root)
    elif args.command == "asr-sensevoice":
        prepare_asr_sensevoice(args.runtime_zip, args.model, args.vad, args.components_root)
    elif args.command == "pandoc":
        prepare_pandoc(args.archive, args.components_root)
    elif args.command == "cua-driver":
        prepare_cua_driver(args.archive, args.components_root)
    elif args.command == "westock":
        prepare_westock(args.package_tgz, args.components_root)
    else:
        prepare_python_academic(
            args.components_root,
            args.requirements,
            index_url=args.index_url,
            expected_lock=args.expected_lock,
            update_lock=args.update_lock,
        )


if __name__ == "__main__":
    main()
