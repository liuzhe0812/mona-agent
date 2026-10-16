"""One project audio recipe for preview and delivery."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Mapping

from aiohttp import web
from loguru import logger

from mona.api.video_runtime import VideoRuntime
from mona.providers.tts import TTSError
from mona.video_assets import validate_asset_references
from mona.video_audio import build_audio_mix_command

_MIX_SUBPROCESS_TIMEOUT_SECONDS = 120.0


class _AudioMixTimeoutError(RuntimeError):
    pass


def _project_media(project: Path, relative: str) -> Path:
    path = (project / relative).resolve(strict=True)
    if not path.is_relative_to(project.resolve()) or not path.is_file():
        raise ValueError("声音素材必须位于当前视频项目内")
    return path


async def audio_asset_durations(project: Path, meta: Mapping[str, Any]) -> dict[str, float]:
    from mona.api import server

    tracks = meta.get("audioTracks") or []
    if not isinstance(tracks, list) or any(not isinstance(item, dict) for item in tracks):
        raise ValueError("声音编排格式无效")
    identifiers = {item.get("assetId") for item in tracks}
    if meta.get("musicPreset", "none") != "none" and meta.get("musicAssetId"):
        identifiers.add(meta["musicAssetId"])
    if any(not isinstance(item, str) or not item for item in identifiers):
        raise ValueError("请指定声音素材")
    records = validate_asset_references(project, sorted(identifiers))
    ffprobe = VideoRuntime().get_ffprobe_path()
    if records and not ffprobe:
        raise RuntimeError("声音处理组件尚未就绪，请准备视频组件后重试")
    result = {}
    for record in records:
        path = _project_media(project, record["path"])
        if not await server._video_output_has_audio(path, ffprobe):
            raise ValueError("所选声音素材没有可用音轨")
        probe = await server._probe_video_output(path, ffprobe)
        result[record["id"]] = float((probe.get("format") or {}).get("duration") or 0)
    return result


async def mix_project_audio(project: Path, meta: Mapping[str, Any], output: Path, *,
                            voice_path: Path | None = None, window_start: float = 0,
                            window_duration: float | None = None,
                            cancel_event: threading.Event | None = None) -> None:
    from mona.api import server

    ffmpeg = VideoRuntime().get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("声音处理组件尚未就绪，请准备视频组件后重试")
    durations = await audio_asset_durations(project, meta)
    total = sum(float(scene.get("duration") or 5) for scene in meta.get("scenes") or [])
    command = build_audio_mix_command(project, meta, ffmpeg_path=ffmpeg, output_path=output,
                                     timeline_duration=total, voice_path=voice_path,
                                     window_start=window_start, window_duration=window_duration,
                                     asset_durations=durations)
    process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.DEVNULL,
                                                   stdout=asyncio.subprocess.DEVNULL,
                                                   stderr=asyncio.subprocess.PIPE,
                                                   creationflags=0x08000000 if sys.platform == "win32" else 0)
    try:
        await asyncio.wait_for(
            server._communicate_video_subprocess(process, cancel_event),
            timeout=_MIX_SUBPROCESS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise _AudioMixTimeoutError("视频声音处理超时，已停止，请重试") from exc
    if process.returncode != 0 or not output.is_file():
        logger.error("Video audio mix failed (exit {})", process.returncode)
        raise RuntimeError("视频声音未能合成，已保留原内容，请重试")


def _audio_fingerprint(project: Path, meta: Mapping[str, Any]) -> str:
    keys = ("narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "musicPreset", "musicAssetId", "audioTracks")
    data = {key: meta.get(key) for key in keys}
    data["scenes"] = [{key: scene.get(key) for key in ("id", "index", "duration", "narration", "audioInputHash")} for scene in meta.get("scenes") or []]
    files = [f"audio/scene_{int(scene['index']):02d}.mp3" for scene in meta.get("scenes") or [] if scene.get("audioInputHash")]
    ids = {item["assetId"] for item in meta.get("audioTracks") or []}
    if meta.get("musicPreset", "none") != "none" and meta.get("musicAssetId"):
        ids.add(meta["musicAssetId"])
    files.extend(record["path"] for record in validate_asset_references(project, sorted(ids)))
    data["media"] = {relative: hashlib.sha256(_project_media(project, relative).read_bytes()).hexdigest() if (project / relative).is_file() else None for relative in files}
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def prepare_preview_audio(project: Path, scene_index: int | None = None) -> Path | None:
    from mona.api import server

    meta = server._load_video_meta(project)
    server._require_video_plan_approval(meta)
    scenes = meta.get("scenes") or []
    if not scenes:
        raise ValueError("请先准备视频方案")
    target = next((scene for scene in scenes if scene["index"] == scene_index), None)
    if scene_index is not None and target is None:
        raise ValueError("视频片段不存在")
    if meta.get("narrationEnabled"):
        for scene in [target] if target else scenes:
            if str(scene.get("narration") or "").strip():
                if not await server._synthesize_scene_narration(project, scene, meta):
                    raise TTSError("旁白尚未完成，请重试配音；已保留当前声音。", code="TTS_SYNTHESIS_FAILED")
                meta = server._save_video_narration_meta(project, scene, meta)
        scenes = meta["scenes"]
        target = next((scene for scene in scenes if scene["index"] == scene_index), None)
    paths = [(project / "audio" / f"scene_{int(scene['index']):02d}.mp3") if meta.get("narrationEnabled") and scene.get("audioInputHash") and (project / "audio" / f"scene_{int(scene['index']):02d}.mp3").is_file() else None for scene in scenes]
    if not any(paths) and meta.get("musicPreset", "none") == "none" and not meta.get("audioTracks"):
        return None
    fingerprint = _audio_fingerprint(project, meta)
    audio_dir = (project / "audio").resolve()
    if not audio_dir.is_relative_to(project.resolve()):
        raise ValueError("声音目录超出视频项目范围")
    audio_dir.mkdir(parents=True, exist_ok=True)
    output = audio_dir / f"preview-mix-{scene_index or 'full'}.m4a"
    receipt = output.with_suffix(".json")
    if output.is_file() and receipt.is_file() and json.loads(receipt.read_text(encoding="utf-8")).get("inputHash") == fingerprint:
        return output
    start = sum(float(scene.get("duration") or 5) for scene in scenes[:scenes.index(target)]) if target else 0
    duration = float(target["duration"]) if target else None
    with tempfile.TemporaryDirectory(prefix="mix-", dir=audio_dir) as temporary:
        directory = Path(temporary)
        voice = None
        if any(paths):
            spec = importlib.util.spec_from_file_location("mona_video_audio_concat", server._video_skill_dir() / "scripts" / "render.py")
            if spec is None or spec.loader is None:
                raise RuntimeError("声音处理组件无法读取，请重试")
            renderer = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(renderer)
            voice = directory / "narration.mp3"
            if not await asyncio.to_thread(renderer._concat_scene_audio, paths, voice, None, VideoRuntime().get_ffmpeg_path(),
                                           durations=[float(scene.get("duration") or 5) for scene in scenes]):
                raise RuntimeError("旁白未能合成，请重试")
        mixed = directory / "mix.m4a"
        await mix_project_audio(project, meta, mixed, voice_path=voice, window_start=start, window_duration=duration)
        if _audio_fingerprint(project, server._load_video_meta(project)) != fingerprint:
            raise server._VideoNarrationInputChangedError("声音或方案已修改，请重新预览")
        mixed.replace(output)
        server._atomic_write_text(receipt, json.dumps({"inputHash": fingerprint}))
    return output


async def handle_video_audio_preview(request: web.Request) -> web.Response:
    from mona.api import server

    try:
        body = request.query if request.method == "GET" else await request.json()
        project, error = server._video_project_dir_or_404(str(body.get("name") or "").strip())
        if error is not None:
            return error
        index = body.get("index")
        if index is not None and (isinstance(index, bool) or not isinstance(index, int) or index < 1):
            raise ValueError("请指定有效的视频片段")
        path = await prepare_preview_audio(project, index)
        if path is None:
            return web.Response(status=204)
        return web.Response(body=path.read_bytes(), content_type="audio/mp4", headers={"Cache-Control": "no-store"})
    except TTSError as exc:
        return server._tts_error_response(exc)
    except _AudioMixTimeoutError as exc:
        return web.json_response({"message": str(exc), "retryable": True}, status=503)
    except server._VideoNarrationInputChangedError:
        return web.json_response({"message": "声音或方案已修改，请重新预览", "retryable": True}, status=409)
    except (TypeError, ValueError) as exc:
        return web.json_response({"message": str(exc)}, status=422)
    except Exception:
        logger.exception("Video audio preview failed")
        return web.json_response({"message": "视频声音未能准备，已保留当前内容，请重试"}, status=503)
