"""Video features resolve and install shared runtime components."""

import json
import zipfile
from pathlib import Path

from mona.api import video_runtime
from mona.runtime.manager import RuntimeComponentStore


def test_video_runtime_reuses_managed_node(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "managed"
    archive = tmp_path / "node.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "node-base",
                    "version": "22.23.2",
                    "kind": "node-runtime",
                    "entrypoints": {"node": "node/node.exe"},
                }
            ),
        )
        bundle.writestr("node/node.exe", b"node")
    RuntimeComponentStore(runtime_root).install_archive(archive)
    monkeypatch.setattr("mona.config.paths.get_managed_runtimes_dir", lambda: runtime_root)
    monkeypatch.setattr(video_runtime.shutil, "which", lambda _name: None)

    assert video_runtime.VideoRuntime().get_node_path() == str(
        runtime_root
        / "components"
        / "node-base"
        / "versions"
        / "22.23.2"
        / "node"
        / "node.exe"
    )


def test_video_runtime_resolves_managed_product_components(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "managed"
    fixtures = [
        (
            "ffmpeg",
            "6.1.1",
            "ffmpeg-runtime",
            {"ffmpeg": "bin/ffmpeg.exe", "ffprobe": "bin/ffprobe.exe"},
        ),
        (
            "yt-dlp",
            "2026.07.04",
            "yt-dlp-runtime",
            {"yt_dlp": "bin/yt-dlp.exe"},
        ),
        (
            "asr-sensevoice",
            "0.2.6+q8",
            "asr-runtime",
            {
                "transcribe": "bin/transcribe.exe",
                "model": "models/sensevoice.gguf",
                "vad": "models/vad.gguf",
            },
        ),
    ]
    for component_id, version, kind, entrypoints in fixtures:
        archive = tmp_path / f"{component_id}.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(
                "runtime-manifest.json",
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": component_id,
                        "version": version,
                        "kind": kind,
                        "entrypoints": entrypoints,
                    }
                ),
            )
            for relative in entrypoints.values():
                bundle.writestr(relative, b"fixture")
        RuntimeComponentStore(runtime_root).install_archive(archive)
    monkeypatch.setattr("mona.config.paths.get_managed_runtimes_dir", lambda: runtime_root)
    monkeypatch.setattr(video_runtime.shutil, "which", lambda _name: None)

    runtime = video_runtime.VideoRuntime(tmp_path / "legacy")
    assert Path(runtime.get_ffmpeg_path() or "").name == "ffmpeg.exe"
    assert Path(runtime.get_ffprobe_path() or "").name == "ffprobe.exe"
    assert Path(runtime.get_ytdlp_path() or "").name == "yt-dlp.exe"
    assert runtime.get_asr_paths() is not None


async def test_missing_ffmpeg_uses_unified_runtime_manager(monkeypatch, tmp_path) -> None:
    calls: list[str] = []
    runtime = video_runtime.VideoRuntime(tmp_path / "legacy")
    monkeypatch.setattr(runtime, "_cached_ffmpeg_exe", lambda: None)
    monkeypatch.setattr(runtime, "_cached_ffprobe_exe", lambda: None)
    monkeypatch.setattr(runtime, "get_ffmpeg_path", lambda: "managed/ffmpeg.exe")
    monkeypatch.setattr(runtime, "get_ffprobe_path", lambda: "managed/ffprobe.exe")

    async def ensure(resource: str, _progress=None):
        calls.append(resource)

    monkeypatch.setattr("mona.runtime.official.ensure_official_runtime_resource", ensure)

    result = await runtime._ensure_ffmpeg(None)

    assert result == {
        "ok": True,
        "path": "managed/ffmpeg.exe",
        "ffprobePath": "managed/ffprobe.exe",
    }
    assert calls == ["ffmpeg"]


async def test_managed_runtime_error_does_not_fall_back(monkeypatch, tmp_path) -> None:
    runtime = video_runtime.VideoRuntime(tmp_path / "legacy")
    monkeypatch.setattr(runtime, "get_ytdlp_path", lambda: None)

    async def ensure(_resource: str, _progress=None):
        raise RuntimeError("请在设置的“功能资源”中下载")

    monkeypatch.setattr("mona.runtime.official.ensure_official_runtime_resource", ensure)

    result = await runtime._ensure_ytdlp(None)

    assert result == {"ok": False, "error": "请在设置的“功能资源”中下载"}


def test_ffmpeg_runtime_requires_ffprobe(monkeypatch, tmp_path) -> None:
    runtime = video_runtime.VideoRuntime(tmp_path / "runtime")
    directory = tmp_path / "runtime" / "ffmpeg"
    directory.mkdir(parents=True)
    (directory / "ffmpeg.exe").write_bytes(b"ffmpeg")
    monkeypatch.setattr(
        video_runtime,
        "_run_sync",
        lambda _cmd, timeout=10.0: (0, "ffmpeg version 6.1\n", ""),
    )

    missing = runtime._check_ffmpeg()
    assert missing.ok is False
    assert missing.error == "FFprobe not found"

    (directory / "ffprobe.exe").write_bytes(b"ffprobe")
    ready = runtime._check_ffmpeg()
    assert ready.ok is True
