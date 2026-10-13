"""Services-owned operations for the video creator Agent."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import math
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

OWNER_HEADER = "X-Mona-Video-Chat-Id"


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


async def _capture_frames(project: Path, scene: dict, meta: dict) -> dict[str, Any]:
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
    times = [duration * ratio for ratio in (.01, .08, .2, .35, .5, .65, .8, .92)]
    timing_path = project / "audio" / f"scene_{int(scene['index']):02d}.timing.json"
    if timing_path.is_file():
        track = json.loads(timing_path.read_text(encoding="utf-8"))
        times.extend(min(duration - .01, cue["startMs"] / 1000 + .12) for cue in track.get("cues", [])[:8])
    times = sorted(set(round(max(0, value), 3) for value in times))
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
                    image_paths.append({"seconds": round(seconds, 3), "path": str(target)})
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
    visual_states = set()
    for ordinal, item in enumerate(image_paths):
        x, y = ordinal % 4 * tile_width, ordinal // 4 * (tile_height + 26)
        with Image.open(item["path"]) as frame:
            sheet.paste(frame.convert("RGB").resize((tile_width, tile_height)), (x, y))
            content = frame.convert("RGB")
            mask = ImageDraw.Draw(content)
            for left, top, right, bottom in caption_masks:
                mask.rectangle((math.floor(left) - 1, math.floor(top) - 1, math.ceil(right) + 1, math.ceil(bottom) + 1), fill="black")
            visual_states.add(hashlib.sha256(content.tobytes()).hexdigest())
        draw.text((x + 8, y + tile_height + 5), f"{item['seconds']:g}s", fill="#111111")
    contact = frames_dir / "motion-review.png"
    sheet.save(contact)
    return {"frames": [image_paths[0], image_paths[len(image_paths) // 2], image_paths[-1]],
            "motionFrames": image_paths, "contactSheet": str(contact), "diagnostics": diagnostics,
            "motionReview": {"distinctVisualStates": len(visual_states),
                             "staticVisual": len(visual_states) == 1,
                             "requiresCreativeReview": True}}


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
            shared_style = {key: style.get(key) for key in ("name", "tokens", "motion", "subtitle", "brand")}
            if meta.get("authoringMode") == "remotion":
                shared_style["motion"] = {key: value for key, value in (style.get("motion") or {}).items()
                                          if key in {"intensity", "enterDurationMs", "exitDurationMs", "transitionDurationMs"}}
            return web.json_response({
                "ok": True, "name": name, "projectPath": str(project),
                "settings": {key: meta.get(key) for key in ("resolution", "language", "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode")},
                "style": shared_style,
                "scenes": meta.get("scenes") or [], "assets": list_project_assets(project),
                "requirePlanApproval": meta.get("requirePlanApproval", False),
                "planRevision": meta.get("planRevision", 0),
                "approvedPlanRevision": meta.get("approvedPlanRevision"),
                "sources": [str(path) for path in sorted((project / "sources").glob("source-*")) if path.is_file()],
                "draftDirectory": str(project / "drafts"),
                "renderStatus": server._read_render_status(project),
                "authoringContract": "Prepare the storyboard with plan and wait for user approval. After approval call audio with plan_revision for actual speech timing; read the motion-design skill reference. Write drafts/scene_NN.tsx default-exporting a React component. Built-in modules: react, remotion, @remotion/shapes, @remotion/paths, @remotion/transitions (+ /fade, /slide, /wipe), mona-video (asset(id), cue(phrase) => startFrame/endFrame). useCurrentFrame/useVideoConfig/spring/interpolate drive all animation; the composition fps is 60. Use exact speech cues, shared --mona-* CSS variables, and imported project assets. SVG/Canvas are allowed inside React. Narration/music are managed by the workbench; do not add Audio or unmuted video tracks. sync publishes source only without changing the approved plan. Preview returns real key frames, an animation contact sheet, execution errors and static-visual diagnostics. Inspect and repair before export. Canonical scenes/scene_sources/meta belong to the tool. No fixed layout or effect menu limits composition.",
            })
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
            if set(settings) - {"resolution", "language", "narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode"}:
                raise ValueError("视频设置包含不支持的选项")
            settings = dict(settings)
            resolution = settings.pop("resolution", None)
            language = settings.pop("language", None)
            server._video_settings_payload(settings)
            task = server._video_render_tasks.get(name)
            if task is not None and not task.done():
                raise ValueError("视频正在导出，请完成或取消导出后再调整设置")
            if resolution is not None and resolution not in {"1920x1080", "1080x1920", "1080x1080"}:
                raise ValueError("请选择横屏、竖屏或方形画面")
            if language is not None and language not in server.VIDEO_LANGUAGE_PRESETS:
                raise ValueError("视频语言暂不支持")
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
                if set(values) - allowed or any(value != target.get(key) for key, value in values.items()):
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
            if meta.get("narrationEnabled") and str(target.get("narration") or "").strip():
                if not await server._synthesize_scene_narration(project, target, meta):
                    raise server.TTSError("配音服务没有返回可用声音，请检查服务配置或稍后重试；已保留当前声音。", code="TTS_SYNTHESIS_FAILED")
                meta = server._save_video_narration_meta(project, target, meta)
            refresh_authored_scene(project, target, meta)
            server._schedule_video_push(name, "scenes")
            captured = await _capture_frames(project, target, meta)
            if target.get("authoredRuntime") == "remotion":
                current = server._load_video_meta(project)
                server._require_video_plan_approval(current, body.get("plan_revision"), check_revision=True)
                current_scene = next((scene for scene in current.get("scenes") or [] if scene.get("index") == index), None)
                if current_scene is None or any(current_scene.get(key) != target.get(key) for key in ("sourceHash", "audioInputHash", "audioMtime", "duration")):
                    raise ValueError("检查画面时片段已修改，请读取当前画面后重新预览")
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
