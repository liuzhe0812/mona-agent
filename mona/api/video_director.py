"""Services-owned operations for the video creator Agent."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.materials.auth import SERVICES_TOKEN_HEADER, is_valid_services_token
from mona.video_authoring import (
    authored_scene_html,
    authored_scene_source_path,
    refresh_authored_scene,
)
from mona.video_style import VideoStyleError

OWNER_HEADER = "X-Mona-Video-Chat-Id"
_MAX_EXPLICIT_PREVIEW_TIMESTAMPS = 8
_MAX_REPRESENTATIVE_CUES = 4
_REVIEW_FRAME_MAX_DIMENSION = 160
_REVIEW_PIXEL_DELTA = 16
_REVIEW_CHANGED_PIXEL_PERCENT = 0.1


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _validate_preview_timestamps(timestamps: Any, duration: float) -> list[float]:
    if not _is_finite_number(duration) or duration <= 0:
        raise ValueError("当前视频片段时长无效，无法定位审片时间")
    if not isinstance(timestamps, list) or not 1 <= len(timestamps) <= _MAX_EXPLICIT_PREVIEW_TIMESTAMPS:
        raise ValueError(f"指定审片时间需为 1 到 {_MAX_EXPLICIT_PREVIEW_TIMESTAMPS} 个")
    result = []
    for timestamp in timestamps:
        if not _is_finite_number(timestamp):
            raise ValueError("审片时间必须是有限的秒数")
        seconds = float(timestamp)
        if seconds < 0 or seconds >= duration:
            raise ValueError("审片时间必须位于当前片段的 0 秒至片段结束前")
        seconds = round(seconds, 4)
        if seconds >= duration:
            raise ValueError("审片时间超出当前片段可播放范围")
        result.append(seconds)
    return result


def _motion_sample_times(duration: float, cues: list[dict[str, Any]]) -> list[float]:
    duration = max(0.01, duration)
    last_sample = max(0.0, duration - 0.01)
    times = [duration * ratio for ratio in (.01, .08, .2, .35, .5, .65, .8, .92)]
    valid_cues = []
    for cue in cues:
        if not isinstance(cue, dict):
            continue
        start_ms, end_ms = cue.get("startMs"), cue.get("endMs")
        if (not _is_finite_number(start_ms) or not _is_finite_number(end_ms)
                or end_ms <= start_ms or start_ms < 0 or start_ms > duration * 1000):
            continue
        valid_cues.append(cue)

    valid_cues.sort(key=lambda cue: cue["startMs"])
    if len(valid_cues) > _MAX_REPRESENTATIVE_CUES:
        representatives = []
        for bucket in range(_MAX_REPRESENTATIVE_CUES):
            start = bucket * len(valid_cues) // _MAX_REPRESENTATIVE_CUES
            end = (bucket + 1) * len(valid_cues) // _MAX_REPRESENTATIVE_CUES
            representatives.append(max(
                valid_cues[start:end],
                key=lambda cue: (len(str(cue.get("text") or "")), -cue["startMs"]),
            ))
    else:
        representatives = valid_cues

    for cue in representatives:
        start = cue["startMs"] / 1000
        end = min(duration, cue["endMs"] / 1000)
        times.extend((start - 0.08, (start + end) / 2, end + 0.12))
    return sorted({round(min(last_sample, max(0.0, value)), 3) for value in times})


def _speech_timing_observation(
    duration: float, cues: list[dict[str, Any]], timing_source: str | None,
) -> dict[str, Any]:
    duration = max(0.0, duration)
    duration_ms = duration * 1000
    source = timing_source if isinstance(timing_source, str) else ""
    if source == "provider-boundary":
        timing_basis = "provider-boundary"
        timing_basis_label = "配音服务返回的时间边界"
    elif source in {"estimated", "acoustic-sentence-alignment"}:
        timing_basis = "estimated"
        timing_basis_label = "估算的口播时间"
    else:
        timing_basis = "unknown"
        timing_basis_label = "来源未知的时间轴"

    valid_cues = []
    for cue in cues if isinstance(cues, list) else []:
        if not isinstance(cue, dict) or not str(cue.get("text") or "").strip():
            continue
        start_ms, end_ms = cue.get("startMs"), cue.get("endMs")
        if (not _is_finite_number(start_ms) or not _is_finite_number(end_ms)
                or start_ms < 0 or end_ms <= start_ms or start_ms >= duration_ms):
            continue
        clipped_end = min(duration_ms, end_ms)
        if clipped_end > start_ms:
            valid_cues.append((start_ms, clipped_end))

    scene_end = round(duration, 3)
    if not valid_cues:
        return {
            "status": "unavailable",
            "reason": "no-valid-cues",
            "timingSource": source or "missing",
            "timingBasis": timing_basis,
            "timingBasisLabel": timing_basis_label,
            "validCueCount": 0,
            "sceneEndSeconds": scene_end,
            "reviewNote": "没有有效口播时间边界，无法计算末尾无口播时长。",
        }

    first_start = min(start for start, _ in valid_cues) / 1000
    last_end = max(end for _, end in valid_cues) / 1000
    return {
        "status": "available",
        "timingSource": source or "unknown",
        "timingBasis": timing_basis,
        "timingBasisLabel": timing_basis_label,
        "validCueCount": len(valid_cues),
        "speechStartSeconds": round(first_start, 3),
        "lastCueEndSeconds": round(last_end, 3),
        "speechCoverageSeconds": round(last_end - first_start, 3),
        "sceneEndSeconds": scene_end,
        "trailingNoNarrationSeconds": round(max(0.0, duration - last_end), 3),
        "reviewNote": (
            "口播覆盖时长按第一个到最后一个有效 cue 计算，包含中间停顿；末尾区间只表示时间差。"
            "请结合实际画面判断它用于阅读、过渡或内容动作，还是无目的等待；长停顿本身不代表问题，"
            "呼吸或闪烁也不能单独证明画面合格。"
        ),
    }


def _review_motion_samples(
    image_paths: list[dict[str, Any]], caption_masks: list[list[float]], width: int, height: int, duration: float,
) -> dict[str, Any]:
    from PIL import Image, ImageDraw

    visual_states = set()
    samples = []
    scale = min(1.0, _REVIEW_FRAME_MAX_DIMENSION / max(width, height))
    review_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    for item in image_paths:
        with Image.open(item["path"]) as frame:
            content = frame.convert("RGB")
            mask = ImageDraw.Draw(content)
            for left, top, right, bottom in caption_masks:
                mask.rectangle((math.floor(left) - 1, math.floor(top) - 1,
                                math.ceil(right) + 1, math.ceil(bottom) + 1), fill="black")
            # Keep the existing full-resolution, subtitle-masked signature contract.
            visual_states.add(hashlib.sha256(content.tobytes()).hexdigest())

            reduced = content.resize(review_size, Image.Resampling.LANCZOS)
            reduced_mask = ImageDraw.Draw(reduced)
            scale_x, scale_y = review_size[0] / width, review_size[1] / height
            for left, top, right, bottom in caption_masks:
                reduced_mask.rectangle((math.floor(left * scale_x) - 1, math.floor(top * scale_y) - 1,
                                         math.ceil(right * scale_x) + 1, math.ceil(bottom * scale_y) + 1), fill="black")
            samples.append((float(item["seconds"]), reduced.tobytes()))

    comparisons = []
    still_intervals = []
    open_interval = None
    pixel_count = review_size[0] * review_size[1]
    for (from_seconds, before), (to_seconds, after) in zip(samples, samples[1:]):
        absolute_sum = 0
        changed_pixels = 0
        for offset in range(0, len(before), 3):
            red = abs(before[offset] - after[offset])
            green = abs(before[offset + 1] - after[offset + 1])
            blue = abs(before[offset + 2] - after[offset + 2])
            absolute_sum += red + green + blue
            if max(red, green, blue) >= _REVIEW_PIXEL_DELTA:
                changed_pixels += 1
        changed_percent = changed_pixels / max(1, pixel_count) * 100
        comparison = {
            "fromSeconds": round(from_seconds, 3), "toSeconds": round(to_seconds, 3),
            "changedPixelPercent": round(changed_percent, 3),
            "meanAbsoluteDifference": round(absolute_sum / max(1, pixel_count * 3), 2),
        }
        comparisons.append(comparison)
        if changed_percent < _REVIEW_CHANGED_PIXEL_PERCENT:
            if open_interval is None:
                open_interval = {"fromSeconds": from_seconds, "toSeconds": to_seconds, "samplePairs": 1}
            else:
                open_interval["toSeconds"] = to_seconds
                open_interval["samplePairs"] += 1
        elif open_interval is not None:
            still_intervals.append(open_interval)
            open_interval = None
    if open_interval is not None:
        still_intervals.append(open_interval)

    minimum_still_seconds = max(1.5, duration * 0.25)
    long_still_intervals = [
        {**interval, "durationSeconds": round(interval["toSeconds"] - interval["fromSeconds"], 3)}
        for interval in still_intervals
        if interval["toSeconds"] - interval["fromSeconds"] >= minimum_still_seconds
    ]
    distinct_states = len(visual_states)
    return {
        "distinctVisualStates": distinct_states,
        "staticVisual": distinct_states == 1,
        "requiresCreativeReview": True,
        "adjacentComparisons": comparisons,
        "longStillIntervals": long_still_intervals,
        "comparisonNotes": (
            f"对字幕遮罩后的缩小画面比较相邻采样；通道差低于 {_REVIEW_PIXEL_DELTA} 的像素变化会忽略，"
            f"变化比例低于 {_REVIEW_CHANGED_PIXEL_PERCENT:g}% 的连续区间列为低变化。仅供审片参考，不代表连续画面或审美质量结论。"
        ),
    }


class _ScenePreviewError(ValueError):
    def __init__(self, diagnostics: list[dict[str, Any]]) -> None:
        super().__init__("这个片段的动画没有执行成功，请修改画面后重试")
        self.diagnostics = diagnostics


def _project(request: web.Request, name: str):
    from mona.api import server

    if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
        raise web.HTTPUnauthorized(reason="invalid services token")
    project, error = server._video_project_dir_or_404(name)
    if error is not None:
        raise web.HTTPNotFound(reason="视频项目不存在")
    assert project is not None
    binding = project / ".chat_id"
    if not binding.is_file() or not request.headers.get(OWNER_HEADER) or binding.read_text(encoding="utf-8").strip() != request.headers[OWNER_HEADER]:
        raise web.HTTPForbidden(reason="视频不属于当前会话")
    return project


def _saved_video_style(root: Path, series_id: str) -> tuple[dict[str, Any], dict[str, Any], Path]:
    from mona.video_style import (
        get_series,
        read_style_version,
        series_directory,
        validate_series_id,
    )

    styles_root = series_directory(root).resolve()
    if not styles_root.is_relative_to(Path(root).resolve()):
        raise ValueError("风格目录超出工作区范围")
    directory = (styles_root / validate_series_id(series_id)).resolve()
    if not directory.is_relative_to(styles_root) or not (directory / "series.json").resolve().is_relative_to(directory):
        raise ValueError("风格快照超出允许范围")
    series = get_series(root, series_id)
    version = int(series.get("latestStyleVersion") or 0)
    if version < 1 or series.get("archivedAt") or series.get("archived"):
        raise ValueError("这个风格尚未保存或暂不可用")
    source = (styles_root / series["id"] / "styles" / f"v{version}").resolve()
    if not source.is_relative_to(directory):
        raise ValueError("风格快照超出允许范围")
    if any(path.is_symlink() or not path.resolve().is_relative_to(source) for path in source.rglob("*")):
        raise ValueError("风格快照包含不可用文件")
    style = read_style_version(root, series_id, version)
    if style.get("version") != version:
        raise ValueError("风格快照版本不一致")
    authoring = style.get("authoring")
    if authoring:
        from mona.video_style_authoring import resolve_style_sample_media

        if not isinstance(authoring, dict) or not str(authoring.get("rules") or "").strip():
            raise ValueError("风格创作规则不可用")
        for field in ("rulesPath", "samplePath", "poster", "motion"):
            resolve_style_sample_media(root, series_id, version, str(authoring.get(field) or ""))
        if not any((source / "authoring" / "scene_sources").glob("scene_*.*")):
            raise ValueError("风格示例不可用")
    return series, style, source


def _available_video_styles(root: Path) -> list[dict[str, Any]]:
    from mona.video_style import list_builtin_templates, series_directory

    available = [
        {**{key: item.get(key) for key in ("id", "name", "description", "mode")},
         "source": "builtin", "version": item.get("schemaVersion", 1)}
        for item in list_builtin_templates()
    ]
    directory = series_directory(root)
    if not directory.is_dir():
        return available
    for child in sorted(directory.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        try:
            series, style, _source = _saved_video_style(root, child.name)
        except (VideoStyleError, OSError, TypeError, ValueError):
            logger.debug("Saved video style is unavailable: {}", child.name)
            continue
        available.append({
            "id": f"saved:{series['id']}", "name": series["name"], "mode": style.get("mode"),
            "description": (style.get("authoring") or {}).get("description") or style.get("description", ""),
            "source": "saved", "version": style["version"], "seriesId": series["id"],
        })
    return available


def _active_video_style_id(meta: dict[str, Any]) -> str | None:
    series_id = meta.get("styleSourceSeriesId") if "styleSourceSeriesId" in meta else meta.get("seriesId")
    return f"saved:{series_id}" if series_id else meta.get("templateId")


def _replace_video_style(project: Path, style: dict[str, Any], source: Path | None) -> None:
    from mona.video_style import _atomic_write_bytes
    from mona.video_style_authoring import materialize_style_sample_assets

    root = project.resolve()
    target = project / "style"
    assets = project / "assets"
    if target.is_symlink() or assets.is_symlink() or not target.resolve().is_relative_to(root) or not assets.resolve().is_relative_to(root):
        raise ValueError("项目风格或素材目录超出允许范围")
    manifest = assets / "manifest.json"
    if not manifest.resolve().is_relative_to(root):
        raise ValueError("项目素材台账超出允许范围")
    previous_manifest = manifest.read_bytes() if manifest.is_file() else None
    previous_files = {path for path in assets.rglob("*") if path.is_file()}
    with tempfile.TemporaryDirectory(prefix=".style-selection-", dir=project) as temporary:
        staging = Path(temporary) / "style"
        backup = Path(temporary) / "previous"
        if source is not None:
            shutil.copytree(source, staging)
        else:
            staging.mkdir()
            (staging / "design-system.json").write_text(json.dumps(style, ensure_ascii=False, indent=2), encoding="utf-8")
        sample_manifest = staging / "authoring" / "assets" / "manifest.json"
        if sample_manifest.is_file():
            for asset in json.loads(sample_manifest.read_text(encoding="utf-8")).get("assets") or []:
                path = Path(str(asset.get("path") or ""))
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", str(asset.get("id") or "")) or not path.as_posix().startswith("assets/") or ".." in path.parts:
                    raise ValueError("风格素材路径无效")
                incoming = (staging / "authoring" / path).resolve()
                if not incoming.is_relative_to(staging.resolve()) or not incoming.is_file():
                    raise ValueError("风格素材文件不可用")
                destination = (assets / "style-sample" / f"{asset.get('id')}{incoming.suffix.lower()}").resolve()
                if not destination.is_relative_to(root):
                    raise ValueError("风格素材路径超出项目范围")
                if destination.is_file() and destination.read_bytes() != incoming.read_bytes():
                    raise ValueError("风格素材与项目中的同名文件冲突，已保留当前风格")
        if target.exists():
            target.rename(backup)
        try:
            staging.rename(target)
            materialize_style_sample_assets(project)
        except Exception:
            if target.is_dir():
                shutil.rmtree(target)
            if backup.exists():
                backup.rename(target)
            if previous_manifest is None:
                manifest.unlink(missing_ok=True)
            else:
                _atomic_write_bytes(manifest, previous_manifest)
            for path in assets.rglob("*"):
                if path.is_file() and path not in previous_files and path.resolve().is_relative_to(root):
                    path.unlink()
            raise


async def _capture_frames(
    project: Path, scene: dict, meta: dict, timestamps: list[float] | None = None,
) -> dict[str, Any]:
    import websockets

    from mona.api import server
    from mona.api.video_runtime import VideoRuntime

    runtime = VideoRuntime()
    browser = runtime.get_chrome_path()
    if not browser:
        raise ValueError("视频预览组件尚未准备好")
    script = server._video_skill_dir() / "scripts" / "render.py"
    spec = importlib.util.spec_from_file_location("mona_director_capture", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("视频预览组件不可用")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    duration = float(scene.get("duration") or 5)
    frames_dir = project / "renders" / "previews" / f"scene_{int(scene['index']):02d}"
    frames_dir.mkdir(parents=True, exist_ok=True)
    image_paths = []
    diagnostics = []
    cues = []
    timing_source = None
    timing_path = project / "audio" / f"scene_{int(scene['index']):02d}.timing.json"
    if timing_path.is_file():
        try:
            track = json.loads(timing_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            track = {}
        if isinstance(track, dict):
            track_cues = track.get("cues")
            cues = track_cues if isinstance(track_cues, list) else []
            timing_source = track.get("timingSource")
    times = timestamps if timestamps is not None else _motion_sample_times(duration, cues)
    with tempfile.TemporaryDirectory(prefix="mona-video-preview-", ignore_cleanup_errors=True) as profile:
        port = renderer._find_free_port()
        process = renderer._start_chrome(browser, port, width, height, Path(profile))
        try:
            socket_url = await asyncio.to_thread(renderer._read_devtools_url, process, port)
            async with websockets.connect(socket_url, max_size=64 * 1024 * 1024) as socket:
                try:
                    await renderer._render_scene(
                        socket, project / "scenes" / f"scene_{int(scene['index']):02d}.html",
                        duration, 60, width, height, frames_dir, 0, sample_times=times,
                    )
                except RuntimeError as exc:
                    reports = await renderer._cdp_call(socket, "Runtime.evaluate", {
                        "expression": "JSON.stringify(window.__monaSceneReports || [])", "returnByValue": True,
                    })
                    errors = [{"error": str(item["error"])[:2000]} for item in json.loads(reports.get("result", {}).get("value") or "[]") if item.get("error")]
                    raise _ScenePreviewError(errors) from exc
                for ordinal, seconds in enumerate(times):
                    captured = frames_dir / f"frame_{ordinal:06d}.png"
                    target = frames_dir / f"sample_{ordinal}.png"
                    captured.replace(target)
                    image_paths.append({"timestamp": round(seconds, 4), "seconds": round(seconds, 4), "path": str(target)})
                report = await renderer._cdp_call(socket, "Runtime.evaluate", {
                    "expression": "JSON.stringify(window.__monaSceneReports || [])", "returnByValue": True,
                })
                diagnostics.extend(json.loads(report.get("result", {}).get("value") or "[]"))
        finally:
            await asyncio.to_thread(renderer._terminate_process_tree, process)
    from PIL import Image, ImageDraw

    tile_width = 480
    tile_height = round(height * tile_width / width)
    rows = math.ceil(len(image_paths) / 4)
    sheet = Image.new("RGB", (tile_width * 4, (tile_height + 26) * rows), "#ffffff")
    draw = ImageDraw.Draw(sheet)
    caption_masks = [item["captionBounds"] for item in diagnostics if item.get("captionBounds")]
    for ordinal, item in enumerate(image_paths):
        x, y = ordinal % 4 * tile_width, ordinal // 4 * (tile_height + 26)
        with Image.open(item["path"]) as frame:
            sheet.paste(frame.convert("RGB").resize((tile_width, tile_height)), (x, y))
        draw.text((x + 8, y + tile_height + 5), f"{item['timestamp']:g}s", fill="#111111")
    contact = frames_dir / "motion-review.png"
    sheet.save(contact)
    result = {
        "frames": image_paths if timestamps is not None else [image_paths[0], image_paths[len(image_paths) // 2], image_paths[-1]],
        "motionFrames": image_paths, "contactSheet": str(contact), "diagnostics": diagnostics,
        "observationScope": "selected-timestamps" if timestamps is not None else "automatic-scene-sampling",
        "motionReviewUpdated": timestamps is None,
        "speechTiming": _speech_timing_observation(duration, cues, timing_source),
    }
    if timestamps is None:
        result["motionReview"] = _review_motion_samples(image_paths, caption_masks, width, height, duration)
    return result


async def handle_video_agent(request: web.Request) -> web.Response:
    from mona.api import server

    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("视频操作格式无效")
        name = str(body.get("name") or "").strip()
        project = _project(request, name)
        meta = server._load_video_meta(project)
        action = body.get("action")
        if action == "inspect":
            from mona.video_assets import list_project_assets

            style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
            shared_style = {key: style.get(key) for key in ("name", "tokens", "motion", "subtitle", "brand", "authoring")}
            shared_style.update({"id": _active_video_style_id(meta), "version": meta.get("styleVersion")})
            examples = []
            if style.get("authoring"):
                for path in sorted((project / "style" / "authoring" / "scene_sources").glob("scene_*.*")):
                    if not path.resolve().is_relative_to((project / "style").resolve()):
                        raise ValueError("风格示例超出项目范围")
                    if path.is_file():
                        examples.append(str(path))
            if meta.get("authoringMode") == "remotion":
                shared_style["motion"] = {key: value for key, value in (style.get("motion") or {}).items()
                                          if key in {"intensity", "enterDurationMs", "exitDurationMs", "transitionDurationMs"}}
            return web.json_response({
                "ok": True, "name": name, "projectPath": str(project),
                "settings": {key: meta.get(key) for key in ("resolution", "language", "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode", "musicPreset", "musicAssetId", "audioTracks")},
                "style": shared_style,
                "styleAuthoring": meta.get("styleAuthoring"),
                "styleExamples": examples,
                "stylePreference": meta.get("stylePreference", "fixed"),
                "availableStyles": _available_video_styles(server.get_workspace_path()),
                "scenes": meta.get("scenes") or [], "assets": list_project_assets(project),
                "requirePlanApproval": meta.get("requirePlanApproval", False),
                "planRevision": meta.get("planRevision", 0),
                "approvedPlanRevision": meta.get("approvedPlanRevision"),
                "sources": [str(path) for path in sorted((project / "sources").glob("source-*")) if path.is_file()],
                "draftDirectory": str(project / "drafts"),
                "renderStatus": server._read_render_status(project),
                "authoringContract": "Apply the active creative direction and content-to-library router. When stylePreference is auto, select an available style before the final plan; preserve fixed user choices. Save the director plan and wait for its initial confirmation. Then audio(plan_revision) supplies actual speech timing. Reuse copied Dashi templates and motion source where appropriate. Write drafts/scene_NN.tsx with a default React component and sync it. Modules: react, remotion, @remotion/shapes, @remotion/paths, @remotion/transitions (+ /fade, /slide, /wipe), mona-video (asset, cue => startFrame/endFrame, MotionCanvas, createMotionToolkit, Dashi). Drive React/SVG/Canvas from useCurrentFrame/useVideoConfig at 60 fps, real speech cues, shared style and authorized scene assets. Narration, music, effects and source sound use managed project audioTracks in global seconds; never add Audio or unmuted video to scene code. Explicit local user revisions use edit with current plan_revision and the user's instruction; preserve other segments and use the returned approved revision. sync refines implementation and may append assets for approved intent. preview returns real images and diagnostics; timestamps selects up to eight scene-relative seconds without replacing full review. Observe actual actions and readability, repair, then run full preview before export. Screenshots and motion counters do not certify continuity or aesthetics. Canonical scenes/scene_sources/meta belong to the tool. No fixed scene or effect menu limits composition.",
            })
        if action == "style_rules":
            from mona.video_style import RevisionConflictError, read_style_draft, save_style_draft
            from mona.video_style_authoring import bind_style_sample, style_visual_hash

            binding = meta.get("styleAuthoring") or {}
            series_id = binding.get("seriesId")
            if not series_id:
                raise ValueError("请在自定义风格样片中保存创作规则")
            rules = body.get("instruction")
            if not isinstance(rules, str) or not rules.strip() or len(rules) > 8000:
                raise ValueError("请提供完整的风格与动画规则")
            patch = body.get("settings") or {}
            if not isinstance(patch, dict) or set(patch) - {"tokens", "subtitle", "backgrounds", "mode"}:
                raise ValueError("风格设置包含不支持的内容")
            root = server.get_workspace_path()
            draft = read_style_draft(root, series_id)
            expected_revision = binding.get("draftRevision")
            if expected_revision != draft["revision"]:
                if binding.get("styleInputHash") != style_visual_hash(draft):
                    raise RevisionConflictError("风格已更新，请读取最新样片后再修改")
                # A rename does not invalidate the inspected visual inputs.
                expected_revision = draft["revision"]
            authoring = {**(draft.get("authoring") or {}), "rules": rules.strip()}
            saved = save_style_draft(root, series_id, {**patch, "authoring": authoring},
                                     expected_revision=expected_revision)
            saved = bind_style_sample(root, series_id, name, expected_revision=saved["revision"],
                                      description=authoring.get("description", ""))
            return web.json_response({"ok": True, "draftRevision": saved["revision"], "rules": rules.strip()})
        if action == "style":
            from mona.video_style import get_builtin_template

            if meta.get("styleAuthoring"):
                raise ValueError("请保留当前样片的画风，通过创作规则和样式调整，不自动替换风格")
            if isinstance(body.get("plan_revision"), bool) or not isinstance(body.get("plan_revision"), int) or body.get("plan_revision") != meta.get("planRevision", 0):
                raise ValueError("方案已更新，请读取当前视频后再选择风格")
            if meta.get("approvedPlanRevision") == meta.get("planRevision", 0):
                raise ValueError("风格已确认，改变整体风格须先准备新版方案")
            style_id = body.get("style_id")
            if not isinstance(style_id, str):
                raise ValueError("请选择可用风格")
            current_id = _active_video_style_id(meta)
            instruction = str(body.get("instruction") or "").strip()
            fixed = meta.get("stylePreference", "fixed") != "auto"
            if fixed and style_id != current_id and not instruction:
                raise ValueError("请保留用户已选择的风格，或说明用户本次更换风格的要求")
            if fixed and style_id == current_id and not instruction:
                style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
                return web.json_response({"ok": True, "style": {**{key: style.get(key) for key in ("name", "tokens", "authoring")}, "id": current_id, "version": meta.get("styleVersion")},
                                          "planRevision": meta.get("planRevision", 0)})
            source = None
            series = None
            if style_id.startswith("saved:"):
                series, style, source = _saved_video_style(server.get_workspace_path(), style_id.removeprefix("saved:"))
            else:
                style = get_builtin_template(style_id)
                style["projectTemplate"] = True
            changed = style_id != current_id or bool(series and not fixed and style["version"] != meta.get("styleVersion"))
            if changed or bool(series and instruction and style["version"] != meta.get("styleVersion")):
                if meta.get("scenes"):
                    server._create_video_project_version(project, label="调整风格前", reason="style-selection")
                _replace_video_style(project, style, source)
                server._invalidate_video_outputs(project, meta, None, reset_html=True, reset_audio=False)
                meta["templateId"] = style.get("baseTemplateId") or style.get("id") or "custom"
                meta["styleSourceSeriesId"] = series["id"] if series else None
                if series:
                    meta["styleVersion"] = style["version"]
                else:
                    meta.pop("styleVersion", None)
                server._video_plan_changed(meta)
                server._save_video_meta(project, meta)
                server._schedule_video_push(name, "settings")
            else:
                style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
            return web.json_response({"ok": True, "style": {**{key: style.get(key) for key in ("name", "tokens", "authoring")}, "id": _active_video_style_id(meta), "version": meta.get("styleVersion")},
                                      "planRevision": meta.get("planRevision", 0)})
        if action == "plan":
            from mona.video_assets import validate_asset_references

            values = body.get("scenes")
            if not isinstance(values, list) or not values:
                raise ValueError("请提供至少一个片段的分镜方案")
            planned = []
            for index, value in enumerate(values, start=1):
                if not isinstance(value, dict) or set(value) - {"title", "duration", "visual", "animation", "narration", "assets"}:
                    raise ValueError("分镜方案包含不支持的内容")
                duration = value.get("duration", 5)
                if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
                    raise ValueError("片段时长必须大于零")
                scene = {key: value.get(key, "") for key in ("title", "visual", "animation", "narration")}
                if any(not isinstance(text, str) for text in scene.values()) or not scene["title"].strip():
                    raise ValueError("请为每个片段填写标题，画面和旁白使用文字描述")
                assets = value.get("assets", [])
                if not isinstance(assets, list) or any(not isinstance(asset, str) for asset in assets):
                    raise ValueError("片段素材格式无效")
                validate_asset_references(project, assets)
                scene.update({"index": index, "duration": duration, "durationRaw": f"{duration:g}s",
                              "assets": assets, "role": "content", "layout": "authored", "backgroundSlot": "content",
                              "authored": True, "authoredRuntime": "remotion" if meta.get("authoringMode") == "remotion" else "html", "htmlStatus": "pending"})
                planned.append(scene)
            previous = meta.get("scenes") or []
            if [server._scene_content(scene) for scene in previous] != [server._scene_content(scene) for scene in planned]:
                if previous:
                    server._create_video_project_version(project, label="修改分镜方案前", reason="plan-change")
                server._invalidate_video_outputs(project, meta, None, reset_html=True)
                meta["scenes"] = planned
                server._video_plan_changed(meta)
                server._sync_storyboard(project, planned)
                server._save_video_meta(project, meta)
                server._schedule_video_push(name, "scenes")
            return web.json_response({"ok": True, "scenes": meta.get("scenes") or [], "planRevision": meta.get("planRevision", 0),
                                      "awaitingConfirmation": bool(meta.get("requirePlanApproval")) and meta.get("approvedPlanRevision") != meta.get("planRevision", 0)})
        if action == "status":
            return await server.handle_video_project_export_status(_QueryRequest(name))
        if action == "edit":
            from mona.video_assets import validate_asset_references
            from mona.video_project import approve_scoped_edit, scene_edit_changes

            server._require_video_plan_approval(meta, body.get("plan_revision"), check_revision=True)
            if body.get("plan_revision") != meta.get("planRevision", 0):
                raise ValueError("片段内容已更新，请读取当前方案后再修改")
            index = body.get("scene_index")
            if isinstance(index, bool) or not isinstance(index, int) or index < 1:
                raise ValueError("请指定有效的视频片段")
            scene = next((item for item in meta.get("scenes") or [] if item.get("index") == index), None)
            if scene is None:
                raise ValueError("视频片段不存在")
            instruction = body.get("instruction")
            if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 8000:
                raise ValueError("请保留用户本次对这个片段的具体修改要求")
            changes = scene_edit_changes(scene, body.get("scene"))
            validate_asset_references(project, changes.get("assets", scene.get("assets") or []))
            if changes:
                server._create_video_project_version(project, label=f"调整片段 {index} 前", reason="user-scoped-edit", changed_scene_indices=[index])
                server._invalidate_video_outputs(project, meta, {index}, reset_html=True,
                                                 reset_audio=bool(set(changes) & {"narration", "duration"}))
                approve_scoped_edit(meta, scene, changes, instruction.strip())
                server._sync_storyboard(project, meta["scenes"])
                server._save_video_meta(project, meta)
                server._schedule_video_push(name, "scenes")
            return web.json_response({"ok": True, "scene": scene, "planRevision": meta.get("planRevision", 0),
                                      "awaitingConfirmation": False, "changedFields": sorted(changes)})
        if action == "cancel":
            return await server.handle_video_project_export_cancel(_BodyRequest({"name": name}))
        if action == "remove":
            return await server.handle_video_project_scene_delete(_QueryRequest(name, index=body.get("scene_index")))
        if action == "reorder":
            return await server.handle_video_project_scene_reorder(_BodyRequest({"name": name, "indices": body.get("order")}))
        if action == "export":
            return await server.handle_video_project_export(_BodyRequest({"name": name, "quality": body.get("quality") or "standard"}))
        if action == "assets":
            asset = body.get("asset") or {}
            if not isinstance(asset, dict) or set(asset) - {"sourcePath", "sourceType", "rightsStatus", "licenseName", "creator", "attribution"}:
                raise ValueError("素材信息格式无效")
            return await server.handle_video_project_asset_import(_BodyRequest({**asset, "name": name}))
        if action == "settings":
            settings = body.get("settings") or {}
            if not isinstance(settings, dict):
                raise ValueError("视频设置格式无效")
            if set(settings) - {"resolution", "language", "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode", "musicPreset", "musicAssetId", "audioTracks"}:
                raise ValueError("视频设置包含不支持的选项")
            settings = dict(settings)
            sound = {key: settings.pop(key) for key in ("musicPreset", "musicAssetId", "audioTracks") if key in settings}
            resolution = settings.pop("resolution", None)
            language = settings.pop("language", None)
            server._video_settings_payload(settings)
            if resolution is not None and resolution not in {"1920x1080", "1080x1920", "1080x1080"}:
                raise ValueError("请选择横屏、竖屏或方形画面")
            if language is not None and language not in server.VIDEO_LANGUAGE_PRESETS:
                raise ValueError("视频语言暂不支持")
            task = server._video_render_tasks.get(name)
            if task is not None and not task.done():
                raise ValueError("视频正在导出，请完成或取消导出后再调整设置")
            if sound:
                from mona.api.video_audio import audio_asset_durations
                from mona.api.video_runtime import VideoRuntime
                from mona.video_audio import build_audio_mix_command

                server._require_video_plan_approval(meta, body.get("plan_revision"), check_revision=True)
                proposed = {**meta, **sound}
                durations = await audio_asset_durations(project, proposed)
                build_audio_mix_command(project, proposed, ffmpeg_path=VideoRuntime().get_ffmpeg_path() or "ffmpeg",
                                        output_path=project / "audio" / "validate-mix.m4a",
                                        timeline_duration=sum(float(scene.get("duration") or 5) for scene in meta.get("scenes") or []),
                                        asset_durations=durations)
                if any(value != meta.get(key) for key, value in sound.items()):
                    server._create_video_project_version(project, label="调整视频声音前", reason="audio-track-change")
                    meta.update(sound)
                    meta["outputStale"] = (project / "renders" / "output.mp4").is_file()
                    server._save_video_meta(project, meta)
                    server._schedule_video_push(name, "settings")
            if (resolution is not None and resolution != meta.get("resolution")) or (language is not None and language != meta.get("language")):
                server._invalidate_video_outputs(project, meta, None, reset_html=True)
                if resolution:
                    meta["resolution"] = resolution
                    meta["aspectVariant"] = {"1920x1080": "16:9", "1080x1920": "9:16", "1080x1080": "1:1"}[resolution]
                if language:
                    meta["language"] = language
                    if meta.get("ttsProvider", "edge") == "edge":
                        meta["ttsVoice"] = server.VIDEO_LANGUAGE_PRESETS[language]["edgeVoice"]
                server._video_plan_changed(meta)
                server._save_video_meta(project, meta)
                server._schedule_video_push(name, "scenes")
            return await server.handle_video_project_settings(_BodyRequest({"name": name, **settings}))
        scenes = meta.get("scenes") or []
        index = body.get("scene_index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 1:
            raise ValueError("请指定有效的视频片段")
        target = next((scene for scene in scenes if scene.get("index") == index), None)
        if action == "sync":
            server._require_video_plan_approval(meta, body.get("plan_revision"), check_revision=True)
            values = body.get("scene") or {}
            if not isinstance(values, dict):
                raise ValueError("片段内容格式无效")
            if meta.get("requirePlanApproval"):
                if target is None:
                    raise ValueError("请先在导演台添加并确认这个片段")
                allowed = {"title", "duration", "narration", "visual", "animation", "assets", "role", "layout", "backgroundSlot"}
                additions = values.get("assets", target.get("assets") or [])
                assets_added = isinstance(additions, list) and all(isinstance(item, str) for item in additions) and set(target.get("assets") or []).issubset(additions)
                if set(values) - allowed or any(value != target.get(key) for key, value in values.items() if key != "assets") or not assets_added:
                    raise ValueError("制作时不能改写已确认的分镜方案，请先回导演台调整并确认")
            if target is None and index != len(scenes) + 1:
                raise ValueError("新片段应按顺序添加")
            duration = values.get("duration", (target or {}).get("duration", 5))
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
                raise ValueError("片段时长必须大于零")
            remotion = (target or {}).get("authoredRuntime") == "remotion" or meta.get("authoringMode") == "remotion"
            suffix = ".tsx" if remotion else ".html"
            source = project / "scene_sources" / f"scene_{index:02d}{suffix}"
            source_path = Path(str(body.get("source_file") or project / "drafts" / source.name))
            if not source_path.is_absolute():
                source_path = project / source_path
            source_path = source_path.resolve()
            if not source_path.is_relative_to(project.resolve()) or not source_path.is_file():
                raise ValueError("场景代码必须位于当前视频项目内")
            if target is not None and source_path == source.resolve():
                raise ValueError("请先将修改稿保存到 drafts 目录，再同步片段")
            if remotion and source_path.suffix.lower() != ".tsx":
                raise ValueError("请保存对应口播的动画组件后再同步片段")
            if source_path.suffix.lower() == ".tsx":
                remotion = True
            original = source_path.read_text(encoding="utf-8")
            edited = {**(target or {}), **{key: value for key, value in values.items() if key in {"title", "narration", "visual", "animation", "assets", "role"}},
                      "index": index, "duration": duration, "durationRaw": f"{duration:g}s", "authored": True, "layout": "authored"}
            if remotion:
                edited["authoredRuntime"] = "remotion"
            source = authored_scene_source_path(project, edited)
            edited.pop("motionReviewSourceHash", None)
            edited.pop("motionReview", None)
            from mona.video_assets import validate_asset_references

            validate_asset_references(project, [str(item) for item in edited.get("assets") or []])
            edited.setdefault("title", f"片段 {index}")
            edited.setdefault("role", "content")
            edited.setdefault("backgroundSlot", "content")
            for key in ("title", "narration", "visual", "role"):
                if key in edited and not isinstance(edited[key], str):
                    raise ValueError("片段文字内容格式无效")
            cached_audio = {
                key: value for key, value in (target or {}).items()
                if key.startswith("audio")
            } if (target or {}).get("narration") == edited.get("narration") else {}
            timing_path = project / "audio" / f"scene_{index:02d}.timing.json"
            cached_timing = timing_path.read_bytes() if cached_audio and timing_path.is_file() else None
            style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
            rendered = authored_scene_html(original, project, edited, meta, style, json.loads(cached_timing) if cached_timing else None)
            if target is not None:
                server._create_video_project_version(project, label=f"修改片段 {index} 前", reason="scene-code-save", changed_scene_indices=[index])
            if target is None:
                scenes.append(edited)
            else:
                scenes[scenes.index(target)] = edited
            meta["scenes"] = scenes
            server._invalidate_video_outputs(project, meta, {index}, reset_html=False)
            edited.update(cached_audio)
            if cached_timing is not None:
                timing_path.write_bytes(cached_timing)
            source.parent.mkdir(parents=True, exist_ok=True)
            server._atomic_write_text(source, original)
            scene_path = project / "scenes" / f"scene_{index:02d}.html"
            scene_path.parent.mkdir(parents=True, exist_ok=True)
            server._atomic_write_text(scene_path, rendered)
            edited.update({"htmlStatus": "previewing", "htmlPath": scene_path.relative_to(project).as_posix(), "sourcePath": source.relative_to(project).as_posix(), "sourceHash": hashlib.sha256(source.read_bytes()).hexdigest(), "htmlMtime": scene_path.stat().st_mtime})
            meta.update({"authoringMode": "remotion" if remotion else "agent", "structuredCompiler": False, "phase": "exportable" if all(server._video_scene_ready(project, s) for s in scenes) else "producing"})
            server._write_scene_motion_without_narration(project, edited)
            server._sync_storyboard(project, scenes)
            server._save_video_meta(project, meta)
            server._schedule_video_push(name, "scenes")
            return web.json_response({"ok": True, "scene": edited, "needsVisualReview": True})
        if target is None:
            raise ValueError("视频片段不存在")
        if action == "audio":
            server._require_video_plan_approval(meta, body.get("plan_revision"), check_revision=True)
            if not meta.get("narrationEnabled") or not str(target.get("narration") or "").strip():
                return web.json_response({"ok": True, "scene": target, "subtitleTrack": None, "audioPath": None})
            if not await server._synthesize_scene_narration(project, target, meta):
                raise server.TTSError("配音服务没有返回可用声音，请检查服务配置或稍后重试；已保留当前声音。", code="TTS_SYNTHESIS_FAILED")
            meta = server._save_video_narration_meta(project, target, meta)
            server._schedule_video_push(name, "scenes")
            track = json.loads((project / "audio" / f"scene_{index:02d}.timing.json").read_text(encoding="utf-8"))
            return web.json_response({"ok": True, "scene": target, "subtitleTrack": track,
                                      "audioPath": f"audio/scene_{index:02d}.mp3", "planRevision": meta.get("planRevision", 0)})
        if action == "preview":
            server._require_video_plan_approval(meta, body.get("plan_revision"), check_revision=True)
            if not server._video_scene_ready(project, target):
                raise ValueError("请先保存这个片段的场景代码")
            timestamps = (
                _validate_preview_timestamps(body["timestamps"], float(target.get("duration") or 5))
                if "timestamps" in body else None
            )
            if meta.get("narrationEnabled") and str(target.get("narration") or "").strip():
                if not await server._synthesize_scene_narration(project, target, meta):
                    raise server.TTSError("配音服务没有返回可用声音，请检查服务配置或稍后重试；已保留当前声音。", code="TTS_SYNTHESIS_FAILED")
                meta = server._save_video_narration_meta(project, target, meta)
            refresh_authored_scene(project, target, meta)
            server._schedule_video_push(name, "scenes")
            if timestamps is None:
                captured = await _capture_frames(project, target, meta)
            else:
                captured = await _capture_frames(project, target, meta, timestamps=timestamps)
            if target.get("authoredRuntime") == "remotion":
                current = server._load_video_meta(project)
                server._require_video_plan_approval(current, body.get("plan_revision"), check_revision=True)
                current_scene = next((scene for scene in current.get("scenes") or [] if scene.get("index") == index), None)
                if current_scene is None or any(current_scene.get(key) != target.get(key) for key in ("sourceHash", "audioInputHash", "audioMtime", "duration")):
                    raise ValueError("检查画面时片段已修改，请读取当前画面后重新预览")
                if captured.get("motionReviewUpdated"):
                    current_scene["motionReview"] = captured["motionReview"]
                    current_scene["motionReviewSourceHash"] = target.get("sourceHash")
                    server._save_video_meta(project, current)
            return web.json_response({"ok": True, "scene": target, **captured})
        raise ValueError("视频操作暂不支持")
    except web.HTTPException:
        raise
    except server._VideoNarrationInputChangedError:
        return web.json_response({"ok": False, "error": "制作期间分镜或声音设置已修改，请读取当前方案后再继续", "code": "NARRATION_INPUT_CHANGED"}, status=409)
    except server.TTSError as exc:
        return server._tts_error_response(exc)
    except _ScenePreviewError as exc:
        return web.json_response({"ok": False, "error": str(exc), "diagnostics": exc.diagnostics}, status=422)
    except VideoStyleError as exc:
        return web.json_response({"ok": False, **exc.to_dict()}, status=exc.status_code)
    except (ValueError, OSError) as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=422)
    except Exception:
        logger.exception("video creator operation failed")
        return web.json_response({"ok": False, "error": "视频操作失败，请检查项目状态后重试"}, status=500)


class _BodyRequest:
    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


class _QueryRequest:
    def __init__(self, name: str, **params: Any) -> None:
        self.query = {"name": name, **params}
