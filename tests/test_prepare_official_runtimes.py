"""Local preparation tests for the pinned Windows runtime components."""

from __future__ import annotations

import gzip
import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest

from scripts import prepare_official_runtimes as prepare


def _manifest(root: Path) -> dict[str, object]:
    return json.loads((root / "runtime-manifest.json").read_text(encoding="utf-8"))


def _zip(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)


def test_prepares_ffmpeg_with_ffprobe_and_license(monkeypatch, tmp_path: Path) -> None:
    ffmpeg_gz = tmp_path / "ffmpeg.exe.gz"
    with gzip.open(ffmpeg_gz, "wb") as bundle:
        bundle.write(b"ffmpeg")
    ffprobe_zip = tmp_path / "ffprobe.zip"
    _zip(ffprobe_zip, {"ffprobe-6.1/ffprobe.exe": b"ffprobe"})
    license_file = tmp_path / "win32-x64.LICENSE"
    license_file.write_text("FFmpeg license", encoding="utf-8")
    monkeypatch.setattr(
        prepare,
        "_output",
        lambda command: "ffmpeg version 6.1.1" if "ffmpeg.exe" in command[0] else "ffprobe version 6.1",
    )

    target = prepare.prepare_ffmpeg(
        ffmpeg_gz,
        ffprobe_zip,
        license_file,
        tmp_path / "components",
    )

    assert (target / "ffmpeg.exe").read_bytes() == b"ffmpeg"
    assert (target / "ffprobe.exe").read_bytes() == b"ffprobe"
    assert (target / "LICENSE.txt").read_text(encoding="utf-8") == "FFmpeg license"
    manifest = _manifest(target)
    assert manifest["id"] == "ffmpeg"
    assert manifest["kind"] == "ffmpeg-runtime"
    assert manifest["entrypoints"] == {"ffmpeg": "ffmpeg.exe", "ffprobe": "ffprobe.exe"}


def test_prepares_pinned_yt_dlp(monkeypatch, tmp_path: Path) -> None:
    executable = tmp_path / "yt-dlp.exe"
    executable.write_bytes(b"yt-dlp")
    monkeypatch.setattr(prepare, "_output", lambda _command: "2026.07.04")

    target = prepare.prepare_yt_dlp(executable, tmp_path / "components")

    assert target.name == "2026.07.04"
    assert (target / "yt-dlp.exe").read_bytes() == b"yt-dlp"
    manifest = _manifest(target)
    assert manifest["id"] == "yt-dlp"
    assert manifest["kind"] == "yt-dlp-runtime"
    assert manifest["entrypoints"] == {"yt_dlp": "yt-dlp.exe"}


def test_prepares_asr_sensevoice_bundle(tmp_path: Path) -> None:
    runtime_zip = tmp_path / "asr-runtime.zip"
    _zip(runtime_zip, {"bin/llama-funasr-sensevoice.exe": b"asr"})
    model = tmp_path / "sensevoice-small-q8.gguf"
    model.write_bytes(b"model")
    vad = tmp_path / "fsmn-vad.gguf"
    vad.write_bytes(b"vad")

    target = prepare.prepare_asr_sensevoice(
        runtime_zip,
        model,
        vad,
        tmp_path / "components",
    )

    manifest = _manifest(target)
    assert manifest["id"] == "asr-sensevoice"
    assert manifest["version"] == "0.2.6+q8"
    assert manifest["kind"] == "asr-runtime"
    assert manifest["entrypoints"] == {
        "transcribe": "bin/llama-funasr-sensevoice.exe",
        "model": "sensevoice-small-q8.gguf",
        "vad": "fsmn-vad.gguf",
    }
    assert manifest["dependencies"] == ["ffmpeg@6.1.1"]
    assert (target / "sensevoice-small-q8.gguf").read_bytes() == b"model"
    assert (target / "fsmn-vad.gguf").read_bytes() == b"vad"


def test_prepares_pandoc_and_cua_archives(monkeypatch, tmp_path: Path) -> None:
    pandoc_zip = tmp_path / "pandoc.zip"
    _zip(pandoc_zip, {"pandoc-3.10.1/pandoc.exe": b"pandoc"})
    cua_zip = tmp_path / "cua-driver.zip"
    _zip(cua_zip, {"cua-driver.exe": b"cua"})
    monkeypatch.setattr(prepare, "_output", lambda _command: "pandoc 3.10.1")

    pandoc_target = prepare.prepare_pandoc(pandoc_zip, tmp_path / "components")
    cua_target = prepare.prepare_cua_driver(cua_zip, tmp_path / "components")

    pandoc_manifest = _manifest(pandoc_target)
    assert pandoc_manifest["id"] == "pandoc"
    assert pandoc_manifest["version"] == "3.10.1"
    assert pandoc_manifest["kind"] == "pandoc-runtime"
    assert pandoc_manifest["entrypoints"] == {"pandoc": "pandoc-3.10.1/pandoc.exe"}
    cua_manifest = _manifest(cua_target)
    assert cua_manifest["id"] == "cua-driver"
    assert cua_manifest["version"] == "0.23.2"
    assert cua_manifest["kind"] == "computer-use-runtime"
    assert cua_manifest["entrypoints"] == {"driver": "cua-driver.exe"}


def test_prepares_westock_from_npm_package(tmp_path: Path) -> None:
    package_tgz = tmp_path / "westock-data-skillhub.tgz"
    package_json = json.dumps(
        {
            "name": "westock-data-skillhub",
            "version": "1.0.5",
            "main": "index.js",
        }
    ).encode()
    with tarfile.open(package_tgz, "w:gz") as bundle:
        for name, content in {
            "package/index.js": b"module.exports = {};",
            "package/package.json": package_json,
        }.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))

    target = prepare.prepare_westock(package_tgz, tmp_path / "components")

    assert (target / "index.js").read_bytes() == b"module.exports = {};"
    manifest = _manifest(target)
    assert manifest["id"] == "westock-data"
    assert manifest["version"] == "1.0.5"
    assert manifest["kind"] == "stock-data-runtime"
    assert manifest["entrypoints"] == {"main": "index.js"}
    assert manifest["dependencies"] == ["node-base@22.23.2"]


def test_westock_rejects_archive_path_escape(tmp_path: Path) -> None:
    package_tgz = tmp_path / "unsafe.tgz"
    with tarfile.open(package_tgz, "w:gz") as bundle:
        content = b"escape"
        info = tarfile.TarInfo("package/../escape.js")
        info.size = len(content)
        bundle.addfile(info, io.BytesIO(content))

    with pytest.raises(RuntimeError, match="unsafe archive path"):
        prepare.prepare_westock(package_tgz, tmp_path / "components")
    assert not (tmp_path / "escape.js").exists()
