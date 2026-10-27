"""HTTP handlers for video series, style versions, and background assets."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from aiohttp import web
from loguru import logger
from PIL import Image, UnidentifiedImageError

from mona.config.paths import get_workspace_path
from mona.video_scene_compiler import (
    ROLE_NAMES,
    SceneCompileError,
    compile_scene_spec,
    style_preview_spec,
)
from mona.video_style import (
    VideoStyleError,
    _atomic_write_json,
    create_series,
    create_style_draft_from_version,
    delete_background_asset,
    delete_series,
    get_series,
    import_background_asset,
    list_builtin_templates,
    list_series,
    list_style_versions,
    lock_style,
    read_style_draft,
    read_style_version,
    save_style_draft,
    series_directory,
    update_series,
    validate_series_id,
    validate_style,
)
from mona.video_timeline import VideoTimelineError, build_motion_plan, build_subtitle_track

_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_HUASHU_ASSET_ROOT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "mona-motion"
    / "assets"
    / "huashu-motion"
)
_HUASHU_TEMPLATE_PREVIEWS: dict[str, dict[str, tuple[str, str]]] = {
    f"huashu-{style}": {
        "poster": (f"previews/{style}/poster.png", "PNG"),
        "motion": (f"previews/{style}/motion.gif", "GIF"),
    }
    for style in ("keynote", "whiteboard", "finance", "math", "type", "collage", "science", "3d", "ui-space")
}
_PREVIEW_MIME_TYPES = {"PNG": (".png", "image/png"), "GIF": (".gif", "image/gif")}
_STYLE_REFERENCE_IMAGE_TYPES = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
}
_STYLE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024


def _root() -> Path:
    return get_workspace_path()


def _domain_error(error: VideoStyleError) -> web.Response:
    return web.json_response(error.to_dict(), status=error.status_code)


async def _json_body(request: web.Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise VideoStyleError("请求体不是有效 JSON", code="INVALID_JSON") from exc
    if not isinstance(body, dict):
        raise VideoStyleError("请求体必须是对象", code="INVALID_JSON")
    return body


async def handle_video_style_templates(request: web.Request) -> web.Response:
    del request
    templates = []
    for template in list_builtin_templates():
        item = dict(template)
        template_id = str(item.get("id") or "")
        if template_id in _HUASHU_TEMPLATE_PREVIEWS:
            item["preview"] = {
                kind: f"/api/video/style/templates/{template_id}/preview?kind={kind}&v={(_HUASHU_ASSET_ROOT / relative).stat().st_mtime_ns:x}"
                for kind, (relative, _image_format) in _HUASHU_TEMPLATE_PREVIEWS[template_id].items()
            }
        templates.append(item)
    return web.json_response({"templates": templates})


async def handle_video_style_template_preview(request: web.Request) -> web.StreamResponse:
    template_id = request.match_info.get("template_id", "")
    kind = request.query.get("kind", "")
    if kind not in {"poster", "motion"}:
        return web.json_response(
            {"error": "STYLE_PREVIEW_KIND_INVALID", "message": "预览类型无效"},
            status=400,
        )
    preview = _HUASHU_TEMPLATE_PREVIEWS.get(template_id)
    if preview is None:
        return web.json_response(
            {"error": "STYLE_PREVIEW_NOT_FOUND", "message": "风格预览不存在"},
            status=404,
        )

    relative_path, image_format = preview[kind]
    extension_and_mime = _PREVIEW_MIME_TYPES.get(image_format)
    if extension_and_mime is None:
        return web.json_response(
            {"error": "STYLE_PREVIEW_INVALID", "message": "内置预览资源无效"},
            status=500,
        )
    expected_extension, mime_type = extension_and_mime
    asset_root = _HUASHU_ASSET_ROOT.resolve()
    path = (asset_root / relative_path).resolve()
    if not path.is_relative_to(asset_root):
        return web.json_response(
            {"error": "STYLE_PREVIEW_NOT_FOUND", "message": "风格预览不存在"},
            status=404,
        )
    if not path.is_file():
        return web.json_response(
            {"error": "STYLE_PREVIEW_NOT_FOUND", "message": "风格预览不存在"},
            status=404,
        )
    if path.suffix.lower() != expected_extension:
        return web.json_response(
            {"error": "STYLE_PREVIEW_INVALID", "message": "内置预览资源无效"},
            status=500,
        )
    try:
        with Image.open(path) as image:
            if image.format != image_format:
                raise UnidentifiedImageError("preview format mismatch")
            image.verify()
    except (OSError, UnidentifiedImageError):
        return web.json_response(
            {"error": "STYLE_PREVIEW_INVALID", "message": "内置预览资源无效"},
            status=500,
        )

    response = web.FileResponse(
        path,
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600"},
    )
    response.content_type = mime_type
    return response


def _series_summary(series: dict[str, Any]) -> dict[str, Any]:
    result = dict(series)
    result["episodeCount"] = len(_referencing_projects(str(series.get("id") or "")))
    version = int(series.get("latestStyleVersion") or 0)
    if version:
        try:
            style = read_style_version(_root(), str(series["id"]), version)
            colors = ((style.get("tokens") or {}).get("colors") or {})
            background = ((style.get("backgrounds") or {}).get("default") or {})
            result["styleSummary"] = {
                "version": version,
                "name": style.get("name") or style.get("baseTemplateId") or style.get("id"),
                "baseTemplateId": style.get("baseTemplateId") or style.get("id"),
                "mode": style.get("mode"),
                "primaryColor": colors.get("primary"),
                "backgroundAssetId": background.get("assetId"),
                "hasBackground": bool(background.get("assetId")),
                "enabledAspectRatios": [
                    aspect for aspect in ("16:9", "9:16", "1:1")
                    if ((style.get("aspectVariants") or {}).get(aspect) or {}).get("enabled")
                ],
            }
            authoring = style.get("authoring")
            if (
                isinstance(authoring, dict)
                and authoring.get("samplePath") == "authoring/sample.json"
                and authoring.get("poster") == "authoring/previews/poster.png"
                and authoring.get("motion") == "authoring/previews/motion.gif"
            ):
                result["styleSummary"]["preview"] = {
                    kind: f"/api/video/series/{series['id']}/styles/{version}/preview?kind={kind}"
                    for kind in ("poster", "motion")
                }
        except VideoStyleError:
            pass
    return result


async def handle_video_series_list(request: web.Request) -> web.Response:
    include_archived = str(request.query.get("includeArchived") or "").lower() in {
        "1",
        "true",
        "yes",
    }
    return web.json_response(
        {
            "series": [
                _series_summary(item)
                for item in list_series(_root(), include_archived=include_archived)
            ]
        }
    )


async def handle_video_series_update(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        series_id = validate_series_id(request.match_info["series_id"])
        current = get_series(_root(), series_id)
        name = body.get("name") if "name" in body else None
        archived = body.get("archived") if "archived" in body else None
        if archived is not None and not isinstance(archived, bool):
            raise VideoStyleError("归档状态无效", code="INVALID_ARCHIVED_STATE")
        if name is None and archived is None:
            raise VideoStyleError("没有可更新的字段", code="SERIES_UPDATE_EMPTY")
        updated = update_series(
            _root(),
            series_id,
            name=str(name) if name is not None else None,
            archived=archived,
        )
        if name is not None and updated["name"] != current.get("name"):
            for meta_path, meta in _referencing_projects(series_id):
                meta["seriesName"] = updated["name"]
                _write_project_meta(meta_path, meta)
        return web.json_response({"ok": True, "series": _series_summary(updated)})
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_series_create(request: web.Request) -> web.Response:
    created_series_id: str | None = None
    try:
        from mona.video_brand import (
            BrandKitError,
            apply_brand_kit,
            materialize_brand_assets,
            read_brand_version,
        )

        body = await _json_body(request)
        brand = None
        brand_kit_id = str(body.get("brandKitId") or "").strip()
        if brand_kit_id:
            try:
                brand_version = int(body.get("brandKitVersion") or 0)
            except (TypeError, ValueError) as exc:
                raise BrandKitError(
                    "品牌版本无效", code="BRAND_KIT_VERSION_INVALID"
                ) from exc
            brand = read_brand_version(_root(), brand_kit_id, brand_version)
        series = create_series(
            _root(),
            body.get("id"),
            body.get("name"),
            template_id=str(
                body.get("templateId")
                or body.get("baseTemplateId")
                or "huashu-keynote"
            ),
            default_aspect_ratio=str(body.get("defaultAspectRatio") or "16:9"),
        )
        created_series_id = str(series["id"])
        draft = read_style_draft(_root(), created_series_id)
        if brand is not None:
            brand = materialize_brand_assets(
                _root(), brand, series_directory(_root()) / created_series_id
            )
            draft = save_style_draft(
                _root(),
                created_series_id,
                apply_brand_kit(draft, brand),
                expected_revision=int(draft.get("revision") or 0),
                allow_brand_binding_change=True,
            )
        return web.json_response(
            {"ok": True, "series": series, "draft": draft},
            status=201,
        )
    except BrandKitError as exc:
        if created_series_id is not None:
            try:
                delete_series(_root(), created_series_id)
            except VideoStyleError:
                logger.exception("video series create rollback error")
        return web.json_response(exc.to_dict(), status=exc.status_code)
    except VideoStyleError as exc:
        if created_series_id is not None:
            try:
                delete_series(_root(), created_series_id)
            except VideoStyleError:
                logger.exception("video series create rollback error")
        return _domain_error(exc)
    except Exception as exc:
        if created_series_id is not None:
            try:
                delete_series(_root(), created_series_id)
            except VideoStyleError:
                logger.exception("video series create rollback error")
        logger.exception("video series create error")
        return web.json_response({"error": "SERIES_CREATE_FAILED", "message": str(exc)}, status=500)


async def handle_video_series_get(request: web.Request) -> web.Response:
    try:
        series_id = request.match_info["series_id"]
        series = _series_summary(get_series(_root(), series_id))
        series["draft"] = read_style_draft(_root(), series_id)
        series["styles"] = list_style_versions(_root(), series_id)
        return web.json_response(series)
    except VideoStyleError as exc:
        return _domain_error(exc)


def _referencing_projects(series_id: str) -> list[tuple[Path, dict[str, Any]]]:
    references: list[tuple[Path, dict[str, Any]]] = []
    workspace = _root().resolve()
    for folder in ("video_projects", "video_projects_archived"):
        projects = workspace / folder
        if not projects.resolve().is_relative_to(workspace) or not projects.is_dir():
            continue
        for project in projects.iterdir():
            meta_path = project / "meta.json"
            if not meta_path.resolve().is_relative_to(projects.resolve()) or not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if isinstance(meta, dict) and meta.get("seriesId") == series_id:
                references.append((meta_path, meta))
    return references


def _write_project_meta(path: Path, meta: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(meta, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


async def handle_video_series_delete(request: web.Request) -> web.Response:
    try:
        series_id = validate_series_id(request.match_info["series_id"])
        series = get_series(_root(), series_id)
        references = _referencing_projects(series_id)
        detach_episodes = str(request.query.get("detachEpisodes") or "").lower() == "true"
        if references and not detach_episodes:
            raise VideoStyleError(
                "系列已有视频，请确认保留视频后删除系列",
                code="SERIES_HAS_EPISODES",
                status_code=409,
                details={"seriesId": series_id, "episodeCount": len(references)},
            )
        missing_snapshots = [
            path.parent.name
            for path, _meta in references
            if not (path.parent / "style" / "design-system.json").is_file()
        ]
        if missing_snapshots:
            raise VideoStyleError(
                "部分视频缺少本地风格快照，暂不能安全删除系列",
                code="SERIES_DELETE_UNSAFE",
                status_code=409,
                details={"projects": missing_snapshots},
            )

        originals = [(path, dict(meta)) for path, meta in references]
        try:
            for path, meta in references:
                meta["detachedFromSeries"] = True
                meta["detachedSeriesName"] = series.get("name")
                for key in ("seriesId", "seriesName", "episodeNumber", "backgroundAssetIds"):
                    meta.pop(key, None)
                _write_project_meta(path, meta)
            delete_series(_root(), series_id)
        except Exception:
            for path, meta in originals:
                try:
                    _write_project_meta(path, meta)
                except OSError:
                    logger.exception("restore video project metadata after series delete failure")
            raise
        return web.json_response(
            {"ok": True, "deletedSeriesId": series_id, "detachedEpisodeCount": len(references)}
        )
    except VideoStyleError as exc:
        return _domain_error(exc)
    except Exception as exc:
        logger.exception("video series delete error")
        return web.json_response(
            {"error": "SERIES_DELETE_FAILED", "message": str(exc)}, status=500
        )


async def handle_video_style_draft_get(request: web.Request) -> web.Response:
    try:
        return web.json_response(
            read_style_draft(_root(), request.match_info["series_id"])
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_style_reference(request: web.Request) -> web.StreamResponse:
    try:
        raw_index = request.query.get("index")
        try:
            index = int(raw_index) if raw_index is not None else -1
        except ValueError as exc:
            raise VideoStyleError("参考图编号无效", code="STYLE_REFERENCE_INDEX_INVALID") from exc
        if index < 0:
            raise VideoStyleError("参考图编号无效", code="STYLE_REFERENCE_INDEX_INVALID")

        root = _root().resolve()
        draft = read_style_draft(root, request.match_info["series_id"])
        authoring = draft.get("authoring")
        paths = authoring.get("referencePaths") if isinstance(authoring, dict) else None
        if not isinstance(paths, list) or index >= len(paths):
            raise VideoStyleError("参考图不存在", code="STYLE_REFERENCE_NOT_FOUND", status_code=404)
        raw_path = paths[index]
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise VideoStyleError("参考图不存在", code="STYLE_REFERENCE_NOT_FOUND", status_code=404)

        uploads_root = (root / "uploads").resolve()
        if not uploads_root.is_relative_to(root):
            raise VideoStyleError("参考图路径无效", code="STYLE_REFERENCE_PATH_INVALID", status_code=404)
        reference = Path(raw_path.strip()).expanduser()
        if ".." in reference.parts:
            raise VideoStyleError("参考图路径无效", code="STYLE_REFERENCE_PATH_INVALID", status_code=404)
        if not reference.is_absolute():
            reference = root / reference
        try:
            path = reference.resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise VideoStyleError(
                "参考图不存在", code="STYLE_REFERENCE_NOT_FOUND", status_code=404
            ) from exc
        if path == uploads_root or not path.is_relative_to(uploads_root):
            raise VideoStyleError("参考图路径无效", code="STYLE_REFERENCE_PATH_INVALID", status_code=404)
        if not path.is_file():
            raise VideoStyleError("参考图不存在", code="STYLE_REFERENCE_NOT_FOUND", status_code=404)
        if path.stat().st_size > _STYLE_REFERENCE_MAX_BYTES:
            raise VideoStyleError("参考图过大", code="STYLE_REFERENCE_TOO_LARGE", status_code=413)

        try:
            with Image.open(path) as image:
                image_format = image.format
                if image_format not in _STYLE_REFERENCE_IMAGE_TYPES:
                    raise UnidentifiedImageError("unsupported reference image format")
                if Image.MAX_IMAGE_PIXELS and image.width * image.height > Image.MAX_IMAGE_PIXELS:
                    raise UnidentifiedImageError("reference image dimensions are too large")
                image.verify()
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
            raise VideoStyleError(
                "参考图无法读取", code="STYLE_REFERENCE_INVALID", status_code=422
            ) from exc

        response = web.FileResponse(
            path,
            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"},
        )
        response.content_type = _STYLE_REFERENCE_IMAGE_TYPES[image_format]
        return response
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_style_draft_put(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        style = body.get("style") if isinstance(body.get("style"), dict) else body
        revision = body.get("revision")
        draft = save_style_draft(
            _root(),
            request.match_info["series_id"],
            style,
            expected_revision=int(revision) if revision is not None else None,
        )
        return web.json_response({"ok": True, "draft": draft})
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "INVALID_STYLE_REVISION", "message": "revision 必须是整数"},
            status=400,
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_style_sample_bind(request: web.Request) -> web.Response:
    try:
        from mona.video_style_authoring import bind_style_sample

        body = await _json_body(request)
        revision = body.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int):
            raise VideoStyleError("revision 必须是整数", code="INVALID_STYLE_REVISION")
        raw_project_name = body.get("projectName")
        if not isinstance(raw_project_name, str):
            raise VideoStyleError("projectName 不能为空", code="STYLE_SAMPLE_PROJECT_REQUIRED")
        project_name = raw_project_name.strip()
        if not project_name:
            raise VideoStyleError("projectName 不能为空", code="STYLE_SAMPLE_PROJECT_REQUIRED")
        description = body.get("description")
        if description is not None and not isinstance(description, str):
            raise VideoStyleError("description 必须是文本", code="STYLE_SAMPLE_DESCRIPTION_INVALID")
        refresh = body.get("refresh", False)
        if not isinstance(refresh, bool):
            raise VideoStyleError("refresh 必须是布尔值", code="STYLE_SAMPLE_REFRESH_INVALID")
        seed_version = body.get("seedVersion")
        if seed_version is not None and (
            isinstance(seed_version, bool) or not isinstance(seed_version, int) or seed_version < 1
        ):
            raise VideoStyleError("seedVersion 必须是正整数", code="STYLE_SAMPLE_SEED_VERSION_INVALID")
        root = _root()
        series_id = request.match_info["series_id"]
        seed = _load_style_sample_seed(root, series_id, seed_version) if seed_version is not None else None
        if seed_version is not None:
            project = _sample_project_path(root, project_name)
            meta = _read_project_meta_for_sample(project)
            binding = meta.get("styleAuthoring") or {}
            if binding.get("seriesId") not in (None, series_id):
                raise VideoStyleError(
                    "这个样片已用于其他风格",
                    code="STYLE_SAMPLE_BINDING_CONFLICT",
                    status_code=409,
                )
            _ensure_sample_project_idle(project)
        draft = bind_style_sample(
            root,
            series_id,
            project_name,
            expected_revision=revision,
            description=description or "",
        )
        refreshed = (
            await _refresh_bound_style_sample(root, series_id, project_name, draft, seed=seed)
            if refresh or seed is not None
            else False
        )
        return web.json_response({"ok": True, "draft": draft, "refreshed": refreshed, "seeded": seed is not None})
    except VideoStyleError as exc:
        return _domain_error(exc)


def _read_project_meta_for_sample(project: Path) -> dict[str, Any]:
    try:
        value = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VideoStyleError("样片项目无法读取", code="STYLE_SAMPLE_NOT_FOUND", status_code=404) from exc
    if not isinstance(value, dict):
        raise VideoStyleError("样片项目无法读取", code="STYLE_SAMPLE_NOT_FOUND", status_code=404)
    return value


def _ensure_sample_project_idle(project: Path) -> None:
    status_path = project / ".render_status.json"
    if not status_path.is_file():
        return
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VideoStyleError("样片项目状态无法读取", code="STYLE_SAMPLE_PROJECT_BUSY", status_code=409) from exc
    if isinstance(status, dict) and status.get("stage") in {"rendering", "queued", "cancelling"}:
        raise VideoStyleError("样片正在处理，完成后可恢复风格版本", code="STYLE_SAMPLE_PROJECT_BUSY", status_code=409)


def _load_style_sample_seed(root: Path, series_id: str, version: int) -> dict[str, Any] | None:
    from mona.video_style_authoring import resolve_style_sample_media

    style = read_style_version(root, series_id, version)
    authoring = style.get("authoring")
    if not isinstance(authoring, dict) or not authoring.get("samplePath"):
        return None
    if authoring.get("samplePath") != "authoring/sample.json":
        raise VideoStyleError("风格样片快照无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
    try:
        sample_path = resolve_style_sample_media(root, series_id, version, "authoring/sample.json")
        sample = json.loads(sample_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, VideoStyleError) as exc:
        raise VideoStyleError("风格样片快照无法读取", code="STYLE_SAMPLE_SNAPSHOT_INVALID") from exc
    if not isinstance(sample, dict) or sample.get("schemaVersion") != 1:
        raise VideoStyleError("风格样片快照无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
    resolution = re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", str(sample.get("resolution") or ""))
    if resolution is None or int(resolution.group(1)) < 1 or int(resolution.group(2)) < 1:
        raise VideoStyleError("风格样片画幅无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
    scenes = sample.get("scenes")
    files = sample.get("files")
    assets = sample.get("assets") or []
    if (
        not isinstance(scenes, list)
        or not scenes
        or not isinstance(files, dict)
        or not isinstance(sample.get("narrationEnabled", False), bool)
        or sample.get("subtitleMode", "burned") not in {"burned", "external", "off"}
        or not isinstance(assets, list)
    ):
        raise VideoStyleError("风格样片快照不完整", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
    asset_paths: set[str] = set()
    for asset in assets:
        relative = PurePosixPath(str(asset.get("path") or "")) if isinstance(asset, dict) else PurePosixPath("")
        if (
            not isinstance(asset, dict)
            or not _ASSET_ID_RE.fullmatch(str(asset.get("id") or ""))
            or not relative.is_relative_to("assets")
            or relative.as_posix() == "assets"
            or any(part in {"", ".", ".."} for part in relative.parts)
        ):
            raise VideoStyleError("风格样片素材清单无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        asset_paths.add(relative.as_posix())
    indexes: set[int] = set()
    for scene in scenes:
        if not isinstance(scene, dict) or not scene.get("authored"):
            raise VideoStyleError("风格样片片段无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        try:
            index = int(scene["index"])
        except (KeyError, TypeError, ValueError) as exc:
            raise VideoStyleError("风格样片片段无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID") from exc
        if index < 1 or index in indexes:
            raise VideoStyleError("风格样片片段无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        duration = scene.get("duration")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            raise VideoStyleError("风格样片片段时长无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        indexes.add(index)

    resolved_files: dict[str, Path] = {}
    frame_counts = {index: 0 for index in indexes}
    for raw_relative, expected_hash in files.items():
        if not isinstance(raw_relative, str) or not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
            raise VideoStyleError("风格样片文件清单无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        relative = PurePosixPath(raw_relative)
        if (
            not raw_relative
            or "\\" in raw_relative
            or ":" in raw_relative
            or relative.is_absolute()
            or any(part in {"", ".", ".."} for part in relative.parts)
            or relative.as_posix() != raw_relative
        ):
            raise VideoStyleError("风格样片文件路径无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        allowed = False
        match = re.fullmatch(r"scene_sources/scene_(\d+)\.(?:tsx|html)", raw_relative)
        if match:
            index = int(match.group(1))
            allowed = index in indexes and match.group(1) == f"{index:02d}"
        match = re.fullmatch(r"scenes/scene_(\d+)\.html", raw_relative)
        if match:
            index = int(match.group(1))
            allowed = index in indexes and match.group(1) == f"{index:02d}"
        match = re.fullmatch(r"audio/scene_(\d+)\.(?:mp3|timing\.json)", raw_relative)
        if match:
            index = int(match.group(1))
            allowed = index in indexes and match.group(1) == f"{index:02d}"
        match = re.fullmatch(r"renders/previews/scene_(\d+)/sample_\d+\.png", raw_relative)
        if match:
            index = int(match.group(1))
            allowed = index in indexes and match.group(1) == f"{index:02d}"
            if allowed:
                frame_counts[index] += 1
        allowed = allowed or raw_relative == "style/theme.css"
        allowed = allowed or raw_relative in {"scene_sources/film.html", "composition/index.html"}
        allowed = allowed or raw_relative.startswith("style/assets/") or raw_relative.startswith("style/draft/assets/")
        allowed = allowed or raw_relative in asset_paths
        if not allowed:
            raise VideoStyleError("风格样片文件路径无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        try:
            source = resolve_style_sample_media(root, series_id, version, f"authoring/{raw_relative}")
            if hashlib.sha256(source.read_bytes()).hexdigest() != expected_hash:
                raise VideoStyleError("风格样片文件校验失败", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        except (OSError, VideoStyleError) as exc:
            raise VideoStyleError("风格样片文件校验失败", code="STYLE_SAMPLE_SNAPSHOT_INVALID") from exc
        resolved_files[raw_relative] = source
    for index in indexes:
        scene_data = next(item for item in scenes if int(item["index"]) == index)
        source_suffix = ".tsx" if scene_data.get("authoredRuntime") == "remotion" else ".html"
        source_relative = (
            "scene_sources/film.html"
            if scene_data.get("authoredRuntime") == "huashu-motion"
            else f"scene_sources/scene_{index:02d}{source_suffix}"
        )
        if (
            source_relative not in resolved_files
            or f"scenes/scene_{index:02d}.html" not in resolved_files
            or (scene_data.get("authoredRuntime") == "huashu-motion" and "composition/index.html" not in resolved_files)
            or frame_counts[index] < 2
        ):
            raise VideoStyleError("风格样片文件不完整", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        if scene_data.get("sourceHash") != files.get(source_relative):
            raise VideoStyleError("风格样片源码校验失败", code="STYLE_SAMPLE_SNAPSHOT_INVALID")

    try:
        manifest_path = resolve_style_sample_media(root, series_id, version, "authoring/assets/manifest.json")
        asset_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, VideoStyleError) as exc:
        raise VideoStyleError("风格样片素材清单无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID") from exc
    if (
        not isinstance(assets, list)
        or not isinstance(asset_manifest, dict)
        or asset_manifest.get("assets") != assets
    ):
        raise VideoStyleError("风格样片素材清单无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
    for asset in assets:
        if (
            str(asset.get("path") or "") not in resolved_files
            or asset.get("sha256") not in (None, files.get(str(asset.get("path") or "")))
        ):
            raise VideoStyleError("风格样片素材清单无效", code="STYLE_SAMPLE_SNAPSHOT_INVALID")

    support_files = {}
    for relative in (
        "authoring/sample.json", "authoring/rules.md", "authoring/previews/poster.png",
        "authoring/previews/motion.gif", "authoring/assets/manifest.json",
    ):
        try:
            support_files[relative.removeprefix("authoring/")] = resolve_style_sample_media(
                root, series_id, version, relative
            )
        except VideoStyleError as exc:
            raise VideoStyleError("风格样片快照不完整", code="STYLE_SAMPLE_SNAPSHOT_INVALID") from exc
    return {
        "version": version,
        "sample": sample,
        "files": resolved_files,
        "hashes": files,
        "supportFiles": support_files,
    }


def _refresh_scene_source_hash(project: Path, scene: dict[str, Any]) -> str:
    from mona.video_authoring import authored_scene_source_path

    source = authored_scene_source_path(project, scene)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != scene.get("sourceHash"):
        raise VideoStyleError(
            "样片源码已变化，已保留原样片；请重新检查动画后重试",
            code="STYLE_SAMPLE_REVISION_CONFLICT",
            status_code=409,
        )
    return digest


def _refresh_input_signature(meta: dict[str, Any]) -> str:
    return json.dumps(
        {
            key: meta.get(key)
            for key in (
                "styleAuthoring", "resolution", "language", "narrationEnabled",
                "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode", "audioTracks", "scenes", "composition",
            )
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _copy_refresh_inputs(
    source: Path, target: Path, scenes: list[dict[str, Any]], meta: dict[str, Any]
) -> None:
    target.mkdir(parents=True, exist_ok=False)
    _write_project_meta(target / "meta.json", meta)

    def copy_tree(source_dir: Path, target_dir: Path) -> None:
        root = source_dir.resolve()
        if not source_dir.is_dir():
            return
        for current, directories, files in os.walk(source_dir, followlinks=False):
            current_path = Path(current)
            relative = current_path.relative_to(source_dir)
            destination = target_dir / relative
            destination.mkdir(parents=True, exist_ok=True)
            for directory in tuple(directories):
                path = current_path / directory
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    raise VideoStyleError("样片素材路径无效", code="STYLE_SAMPLE_PATH_INVALID")
            for filename in files:
                path = current_path / filename
                if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
                    raise VideoStyleError("样片素材路径无效", code="STYLE_SAMPLE_PATH_INVALID")
                target_file = destination / filename
                if source_dir.name in {"scenes", "composition"}:
                    shutil.copy2(path, target_file)
                    continue
                try:
                    os.link(path, target_file)
                except OSError:
                    shutil.copy2(path, target_file)

    for directory in ("assets", "audio", "scene_sources", "scenes", "composition", "style"):
        copy_tree(source / directory, target / directory)
        (target / directory).mkdir(exist_ok=True)
    (target / "renders" / "previews").mkdir(parents=True)


def _apply_style_sample_seed(project: Path, meta: dict[str, Any], seed: dict[str, Any]) -> None:
    from mona.video_project import ensure_scene_ids
    from mona.video_style_authoring import materialize_style_sample_assets

    sample = seed["sample"]
    for directory, pattern in (
        (project / "scene_sources", re.compile(r"(?:scene_\d+|film)\.(?:tsx|html)$")),
        (project / "scenes", re.compile(r"scene_\d+\.html$")),
        (project / "composition", re.compile(r"index\.html$")),
        (project / "audio", re.compile(r"scene_\d+\.(?:mp3|timing\.json)$")),
    ):
        if directory.is_dir():
            for path in directory.iterdir():
                if pattern.fullmatch(path.name) and path.is_file():
                    path.unlink()
    previews = project / "renders" / "previews"
    if previews.is_dir():
        for path in previews.iterdir():
            if re.fullmatch(r"scene_\d+", path.name) and path.is_dir():
                shutil.rmtree(path)

    for relative, source in seed["files"].items():
        destination = project.joinpath(*PurePosixPath(relative).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_file():
            destination.unlink()
        shutil.copy2(source, destination)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != seed["hashes"][relative]:
            raise VideoStyleError("风格样片文件校验失败", code="STYLE_SAMPLE_SNAPSHOT_INVALID")

    sample_root = project / "style" / "authoring"
    if sample_root.exists():
        shutil.rmtree(sample_root)
    for relative, source in seed["supportFiles"].items():
        destination = sample_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    for relative, source in seed["files"].items():
        path = PurePosixPath(relative)
        if path.parts[0] == "assets":
            destination = sample_root / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

    scenes = copy.deepcopy(sample["scenes"])
    for scene in scenes:
        index = int(scene["index"])
        source_suffix = ".tsx" if scene.get("authoredRuntime") == "remotion" else ".html"
        scene.pop("id", None)
        scene.pop("motionReview", None)
        scene.pop("motionReviewSourceHash", None)
        scene.pop("confirmedAt", None)
        scene.pop("confirmedMtime", None)
        scene["sourcePath"] = (
            "scene_sources/film.html"
            if scene.get("authoredRuntime") == "huashu-motion"
            else f"scene_sources/scene_{index:02d}{source_suffix}"
        )
        source = project / scene["sourcePath"]
        if hashlib.sha256(source.read_bytes()).hexdigest() != scene["sourceHash"]:
            raise VideoStyleError("风格样片源码校验失败", code="STYLE_SAMPLE_SNAPSHOT_INVALID")
        scene["htmlStatus"] = "previewing"
        scene["htmlPath"] = f"scenes/scene_{index:02d}.html"
        scene.pop("htmlMtime", None)

    meta["scenes"] = scenes
    if any(scene.get("authoredRuntime") == "huashu-motion" for scene in scenes):
        meta["composition"] = {
            **copy.deepcopy(sample.get("composition") or {}),
            "sourcePath": "scene_sources/film.html",
            "htmlPath": "composition/index.html",
            "sourceHash": seed["hashes"]["scene_sources/film.html"],
        }
    else:
        meta.pop("composition", None)
    meta["resolution"] = sample["resolution"]
    meta["narrationEnabled"] = bool(sample.get("narrationEnabled"))
    meta["subtitleMode"] = sample.get("subtitleMode") or "burned"
    width, height = (int(value) for value in re.fullmatch(r"\s*(\d+)\s*x\s*(\d+)\s*", sample["resolution"]).groups())
    meta.pop("aspectVariant", None)
    if width * 9 == height * 16:
        meta["aspectVariant"] = "16:9"
    elif width * 16 == height * 9:
        meta["aspectVariant"] = "9:16"
    elif width == height:
        meta["aspectVariant"] = "1:1"
    meta["outputStale"] = bool(meta.get("outputStale") or (project / "renders" / "output.mp4").is_file())
    authoring = meta.setdefault("styleAuthoring", {})
    authoring["seedVersion"] = seed["version"]
    ensure_scene_ids(meta, project.resolve().as_uri())
    materialize_style_sample_assets(project)


def _replace_refresh_output(source: Path, target: Path, backup: Path) -> tuple[Path, Path, bool]:
    backup.parent.mkdir(parents=True, exist_ok=True)
    had_old = target.exists()
    if had_old:
        os.replace(target, backup)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
    except Exception:
        if had_old and backup.exists():
            os.replace(backup, target)
        raise
    return target, backup, had_old


def _restore_refresh_outputs(replacements: list[tuple[Path, Path, bool]]) -> None:
    for target, backup, had_old in reversed(replacements):
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)
        if had_old and backup.exists():
            os.replace(backup, target)


async def _refresh_bound_style_sample(
    root: Path,
    series_id: str,
    project_name: str,
    draft: dict[str, Any],
    *,
    seed: dict[str, Any] | None = None,
) -> bool:
    from mona.api import server
    from mona.api.video_director import _capture_frames
    from mona.video_authoring import refresh_authored_scene
    from mona.video_style import read_style_draft

    project = _sample_project_path(root, project_name)
    live_meta = server._load_video_meta(project)
    scenes = live_meta.get("scenes") or []
    seeded = seed is not None
    if not seeded and not scenes:
        return False
    if not seeded and (not isinstance(scenes, list) or any(
        not isinstance(scene, dict)
        or not scene.get("authored")
        or not server._video_scene_ready(project, scene)
        for scene in scenes
    )):
        raise VideoStyleError(
            "样片尚未完整生成，已保留原样片；请完成制作后重试",
            code="STYLE_SAMPLE_NOT_READY",
            status_code=409,
        )

    expected_revision = int(draft["revision"])
    expected_signature = _refresh_input_signature(live_meta)
    source_hashes = {} if seeded else {
        int(scene["index"]): _refresh_scene_source_hash(project, scene)
        for scene in scenes
    }

    projects_dir = (root / "video_projects").resolve()
    try:
        with tempfile.TemporaryDirectory(prefix="_style_sample_refresh_", dir=projects_dir) as temporary:
            stage_project = Path(temporary) / project.name
            _copy_refresh_inputs(project, stage_project, scenes, live_meta)
            staged_meta = server._load_video_meta(stage_project)
            if seeded:
                _apply_style_sample_seed(stage_project, staged_meta, seed)
            staged_scenes = staged_meta.get("scenes") or []
            if not staged_scenes or any(
                not isinstance(scene, dict)
                or not scene.get("authored")
                or not server._video_scene_ready(stage_project, scene)
                for scene in staged_scenes
            ):
                raise VideoStyleError(
                    "恢复的风格版本缺少可预览的动画样片",
                    code="STYLE_SAMPLE_SNAPSHOT_INVALID" if seeded else "STYLE_SAMPLE_NOT_READY",
                    status_code=409,
                )
            if seeded:
                source_hashes = {
                    int(scene["index"]): _refresh_scene_source_hash(stage_project, scene)
                    for scene in staged_scenes
                }
            for scene in staged_scenes:
                if not refresh_authored_scene(stage_project, scene, staged_meta):
                    raise VideoStyleError(
                        "样片动画无法更新，已保留原样片",
                        code="STYLE_SAMPLE_REFRESH_FAILED",
                        status_code=503,
                    )
                captured = await _capture_frames(stage_project, scene, staged_meta)
                if not captured.get("motionReviewUpdated") or not isinstance(captured.get("motionReview"), dict):
                    raise VideoStyleError(
                        "样片画面检查未完成，已保留原样片",
                        code="STYLE_SAMPLE_REFRESH_FAILED",
                        status_code=503,
                    )
                index = int(scene["index"])
                if _refresh_scene_source_hash(stage_project, scene) != source_hashes[index]:
                    raise VideoStyleError(
                        "样片源码已变化，已保留原样片；请重新检查动画后重试",
                        code="STYLE_SAMPLE_REVISION_CONFLICT",
                        status_code=409,
                    )
                scene_path = stage_project / "scenes" / f"scene_{index:02d}.html"
                scene["htmlStatus"] = "previewing"
                scene["htmlPath"] = scene_path.relative_to(stage_project).as_posix()
                scene["htmlMtime"] = scene_path.stat().st_mtime
                scene["motionReview"] = captured["motionReview"]
                scene["motionReviewSourceHash"] = scene["sourceHash"]

            current_draft = read_style_draft(root, series_id)
            current_meta = server._load_video_meta(project)
            if int(current_draft.get("revision", 0)) != expected_revision or _refresh_input_signature(current_meta) != expected_signature:
                raise VideoStyleError(
                    "风格或样片已变化，已保留原样片；请重新读取后重试",
                    code="STYLE_SAMPLE_REVISION_CONFLICT",
                    status_code=409,
                )

            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise asyncio.CancelledError

            backup_root = Path(temporary) / "previous"
            replacements: list[tuple[Path, Path, bool]] = []
            bound_meta = copy.deepcopy(live_meta)
            try:
                if seeded:
                    for directory in ("assets", "audio", "scene_sources", "scenes", "composition", "style"):
                        replacements.append(
                            _replace_refresh_output(
                                stage_project / directory,
                                project / directory,
                                backup_root / directory,
                            )
                        )
                    replacements.append(
                        _replace_refresh_output(
                            stage_project / "renders" / "previews",
                            project / "renders" / "previews",
                            backup_root / "renders" / "previews",
                        )
                    )
                else:
                    if staged_meta.get("composition"):
                        replacements.append(
                            _replace_refresh_output(
                                stage_project / "composition" / "index.html",
                                project / "composition" / "index.html",
                                backup_root / "composition" / "index.html",
                            )
                        )
                    for scene in staged_scenes:
                        index = int(scene["index"])
                        staged_html = stage_project / "scenes" / f"scene_{index:02d}.html"
                        live_html = project / "scenes" / f"scene_{index:02d}.html"
                        replacements.append(
                            _replace_refresh_output(
                                staged_html,
                                live_html,
                                backup_root / "scenes" / live_html.name,
                            )
                        )
                        staged_frames = stage_project / "renders" / "previews" / f"scene_{index:02d}"
                        live_frames = project / "renders" / "previews" / f"scene_{index:02d}"
                        replacements.append(
                            _replace_refresh_output(
                                staged_frames,
                                live_frames,
                                backup_root / "renders" / "previews" / live_frames.name,
                            )
                        )
                server._save_video_meta(project, staged_meta)
            except Exception:
                _restore_refresh_outputs(replacements)
                _write_project_meta(project / "meta.json", bound_meta)
                raise
            return True
    except VideoStyleError:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("video style sample refresh failed")
        raise VideoStyleError(
            "样片更新检查失败，已保留原样片，请重试",
            code="STYLE_SAMPLE_REFRESH_FAILED",
            status_code=503,
        ) from exc


def _sample_project_path(root: Path, project_name: str) -> Path:
    if not project_name or "/" in project_name or "\\" in project_name or project_name in {".", ".."}:
        raise VideoStyleError("样片项目名称无效", code="STYLE_SAMPLE_PROJECT_REQUIRED")
    projects = (root / "video_projects").resolve()
    project = (projects / project_name).resolve()
    if not project.is_relative_to(projects) or not (project / "meta.json").is_file():
        raise VideoStyleError(
            "样片项目不存在，请重新生成样片",
            code="STYLE_SAMPLE_NOT_FOUND",
            status_code=404,
        )
    return project


def _style_sample_html(
    root: Path,
    series_id: str,
    sample: dict[str, Any],
    sample_root: Path,
    *,
    version: int | None,
    project_name: str,
    revision: int,
    muted: bool,
) -> dict[str, Any]:
    from mona.api import server
    from mona.video_style_authoring import resolve_style_sample_media

    resolution = re.match(r"(\d+)\s*x\s*(\d+)", str(sample.get("resolution") or ""))
    if resolution is None:
        raise VideoStyleError("样片画幅无效", code="STYLE_SAMPLE_PREVIEW_INVALID", status_code=409)
    width, height = int(resolution.group(1)), int(resolution.group(2))
    scenes = sample.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise VideoStyleError("样片尚未生成画面", code="STYLE_SAMPLE_NOT_READY", status_code=409)

    entries: list[tuple[int, float, str]] = []
    scene_audio: dict[int, str] = {}
    total_duration = 0.0
    narration_enabled = bool(sample.get("narrationEnabled"))
    for scene in sorted(scenes, key=lambda item: int(item.get("index") or 0) if isinstance(item, dict) else 0):
        if not isinstance(scene, dict):
            raise VideoStyleError("样片片段无效", code="STYLE_SAMPLE_PREVIEW_INVALID", status_code=409)
        try:
            index = int(scene.get("index"))
            duration = float(scene.get("duration") or 5)
        except (TypeError, ValueError) as exc:
            raise VideoStyleError("样片片段无效", code="STYLE_SAMPLE_PREVIEW_INVALID", status_code=409) from exc
        if index < 1 or isinstance(scene.get("duration"), bool) or not math.isfinite(duration) or duration <= 0:
            raise VideoStyleError("样片片段无效", code="STYLE_SAMPLE_PREVIEW_INVALID", status_code=409)

        relative_html = f"authoring/scenes/scene_{index:02d}.html" if version is not None else f"scenes/scene_{index:02d}.html"
        if version is not None:
            html_path = resolve_style_sample_media(root, series_id, version, relative_html)
        else:
            html_path = (sample_root / relative_html).resolve()
            if not html_path.is_relative_to(sample_root.resolve()) or not html_path.is_file():
                raise VideoStyleError("样片画面不存在，请重新生成样片", code="STYLE_SAMPLE_NOT_READY", status_code=409)
        scene_html = html_path.read_text(encoding="utf-8")
        prepared_html = server._prepare_scene_html_for_preview(
            scene_html,
            project_name,
            width,
            height,
            project_dir=sample_root,
        )
        entries.append((index, duration, prepared_html))
        total_duration += duration

        narration = str(scene.get("narration") or "").strip()
        if muted or not narration_enabled or not narration:
            continue
        relative_audio = f"authoring/audio/scene_{index:02d}.mp3" if version is not None else f"audio/scene_{index:02d}.mp3"
        if version is not None:
            audio_path = resolve_style_sample_media(root, series_id, version, relative_audio)
        else:
            audio_path = (sample_root / relative_audio).resolve()
            if not audio_path.is_relative_to(sample_root.resolve()) or not audio_path.is_file():
                raise VideoStyleError("样片旁白尚未准备完成", code="STYLE_SAMPLE_AUDIO_NOT_READY", status_code=409)
        try:
            audio = audio_path.read_bytes()
        except OSError as exc:
            raise VideoStyleError("样片旁白无法读取", code="STYLE_SAMPLE_AUDIO_UNAVAILABLE", status_code=503) from exc
        if not audio:
            raise VideoStyleError("样片旁白文件为空", code="STYLE_SAMPLE_AUDIO_UNAVAILABLE", status_code=503)
        scene_audio[index] = "data:audio/mpeg;base64," + base64.b64encode(audio).decode("ascii")

    html = server._build_video_preview_html(
        width,
        height,
        total_duration,
        entries,
        project_name=project_name,
        scene_audio=scene_audio,
    )
    editable_fields = _style_sample_editable_fields(root, series_id, sample, sample_root, version=version)
    return {
        "ok": True,
        "html": html,
        "duration": total_duration,
        "revision": revision,
        "editableFields": editable_fields,
    }


def _style_sample_editable_fields(
    root: Path,
    series_id: str,
    sample: dict[str, Any],
    sample_root: Path,
    *,
    version: int | None,
) -> list[str]:
    from mona.video_style_authoring import resolve_style_sample_media

    fields: set[str] = set()
    for scene in sample.get("scenes") or []:
        if not isinstance(scene, dict):
            continue
        try:
            index = int(scene.get("index"))
            if version is None:
                from mona.video_authoring import authored_scene_source_path

                source = authored_scene_source_path(sample_root, scene)
            else:
                suffix = Path(str(scene.get("sourcePath") or "")).suffix.lower()
                if suffix not in {".tsx", ".html"}:
                    continue
                source = resolve_style_sample_media(
                    root,
                    series_id,
                    version,
                    "authoring/scene_sources/film.html"
                    if scene.get("authoredRuntime") == "huashu-motion"
                    else f"authoring/scene_sources/scene_{index:02d}{suffix}",
                )
            code = source.read_text(encoding="utf-8")
        except (OSError, UnicodeError, TypeError, ValueError, VideoStyleError):
            continue
        if "--mona-primary" in code:
            fields.add("primaryColor")
        if "--mona-bg" in code:
            fields.add("backgroundColor")
        if "--mona-heading-family" in code or "--mona-body-family" in code:
            fields.add("fontFamily")
    order = ("primaryColor", "backgroundColor", "fontFamily")
    return [field for field in order if field in fields]


async def handle_video_style_sample_preview(request: web.Request) -> web.Response:
    try:
        root = _root()
        series_id = request.match_info["series_id"]
        raw_version = request.query.get("version")
        muted = request.query.get("muted") == "1"
        if raw_version is not None:
            try:
                version = int(raw_version)
            except (TypeError, ValueError) as exc:
                raise VideoStyleError("风格版本无效", code="STYLE_VERSION_NOT_FOUND", status_code=404) from exc
            style = read_style_version(root, series_id, version)
            authoring = style.get("authoring")
            if not isinstance(authoring, dict) or authoring.get("samplePath") != "authoring/sample.json":
                raise VideoStyleError("该风格版本没有动画样片", code="STYLE_SAMPLE_NOT_FOUND", status_code=404)
            from mona.video_style_authoring import resolve_style_sample_media

            sample_path = resolve_style_sample_media(root, series_id, version, "authoring/sample.json")
            sample = json.loads(sample_path.read_text(encoding="utf-8"))
            return web.json_response(
                _style_sample_html(
                    root,
                    series_id,
                    sample,
                    sample_path.parent,
                    version=version,
                    project_name="",
                    revision=version,
                    muted=muted,
                )
            )

        draft = read_style_draft(root, series_id)
        authoring = draft.get("authoring") or {}
        project_name = str(authoring.get("projectName") or "")
        if not project_name:
            raise VideoStyleError("尚未绑定动画样片", code="STYLE_SAMPLE_NOT_FOUND", status_code=404)
        project = _sample_project_path(root, project_name)
        meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
        binding = meta.get("styleAuthoring") or {}
        if binding.get("seriesId") != series_id or binding.get("styleInputHash") is None:
            raise VideoStyleError("样片绑定已失效，请重新生成", code="STYLE_SAMPLE_BINDING_INVALID", status_code=409)
        sample = {
            "resolution": meta.get("resolution"),
            "scenes": meta.get("scenes"),
            "narrationEnabled": meta.get("narrationEnabled", False),
        }
        return web.json_response(
            _style_sample_html(
                root,
                series_id,
                sample,
                project,
                version=None,
                project_name=project_name,
                revision=int(binding.get("draftRevision") or 0),
                muted=muted,
            )
        )
    except VideoStyleError as exc:
        return _domain_error(exc)
    except (OSError, UnicodeError, json.JSONDecodeError):
        logger.exception("video style sample preview read error")
        return web.json_response(
            {"error": "STYLE_SAMPLE_PREVIEW_READ_FAILED", "message": "样片无法读取，请重试"},
            status=503,
        )
    except Exception:
        logger.exception("video style sample preview error")
        return web.json_response(
            {"error": "STYLE_SAMPLE_PREVIEW_FAILED", "message": "样片预览失败，请重试"},
            status=500,
        )


async def handle_video_style_version_preview(request: web.Request) -> web.StreamResponse:
    try:
        kind = request.query.get("kind", "")
        paths = {
            "poster": ("authoring/previews/poster.png", "image/png"),
            "motion": ("authoring/previews/motion.gif", "image/gif"),
        }
        if kind not in paths:
            raise VideoStyleError("预览类型无效", code="STYLE_PREVIEW_KIND_INVALID")
        series_id = request.match_info["series_id"]
        version = int(request.match_info["version"])
        style = read_style_version(_root(), series_id, version)
        authoring = style.get("authoring")
        relative, mime_type = paths[kind]
        if not isinstance(authoring, dict) or authoring.get("poster" if kind == "poster" else "motion") != relative:
            raise VideoStyleError("风格预览不存在", code="STYLE_PREVIEW_NOT_FOUND", status_code=404)
        from mona.video_style_authoring import resolve_style_sample_media

        path = resolve_style_sample_media(_root(), series_id, version, relative)
        response = web.FileResponse(
            path,
            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600"},
        )
        response.content_type = mime_type
        return response
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "STYLE_VERSION_NOT_FOUND", "message": "风格版本不存在"}, status=404
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


def _copy_style_version_tree(source: Path, destination: Path) -> None:
    source_root = source.resolve()
    if source.is_symlink() or not source_root.is_dir():
        raise VideoStyleError("已保存风格快照不存在", code="STYLE_VERSION_NOT_FOUND", status_code=404)
    destination.mkdir(parents=True, exist_ok=False)
    destination_root = destination.resolve()
    for current, directories, files in os.walk(source_root, followlinks=False):
        current_path = Path(current)
        relative = current_path.relative_to(source_root)
        output_dir = destination_root / relative
        output_dir.mkdir(parents=True, exist_ok=True)
        for directory in tuple(directories):
            path = current_path / directory
            if path.is_symlink() or not path.resolve().is_relative_to(source_root):
                raise VideoStyleError("风格快照路径无效", code="STYLE_SNAPSHOT_PATH_INVALID")
            (output_dir / directory).mkdir(exist_ok=True)
        for filename in files:
            path = current_path / filename
            resolved = path.resolve()
            target = output_dir / filename
            if (
                path.is_symlink()
                or not resolved.is_relative_to(source_root)
                or not resolved.is_file()
                or not target.resolve().is_relative_to(destination_root)
            ):
                raise VideoStyleError("风格快照路径无效", code="STYLE_SNAPSHOT_PATH_INVALID")
            shutil.copy2(resolved, target)


def _clear_copied_style_binding(style: dict[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(style)
    for key in ("projectName", "chatId", "chat_id"):
        copied.pop(key, None)
    authoring = copied.get("authoring")
    if isinstance(authoring, dict):
        authoring = dict(authoring)
        for key in ("projectName", "chatId", "chat_id"):
            authoring.pop(key, None)
        copied["authoring"] = authoring
    return copied


async def handle_video_series_copy(request: web.Request) -> web.Response:
    root = _root()
    created_id: str | None = None
    try:
        body = await _json_body(request)
        source_id = validate_series_id(request.match_info["series_id"])
        source_series = get_series(root, source_id)
        try:
            source_version = int(source_series.get("latestStyleVersion") or 0)
        except (TypeError, ValueError) as exc:
            raise VideoStyleError("已保存风格版本无效", code="STYLE_VERSION_NOT_FOUND", status_code=404) from exc
        if source_version < 1:
            raise VideoStyleError("风格尚无已保存版本，暂不能复制", code="STYLE_NOT_SAVED", status_code=409)
        source_style = read_style_version(root, source_id, source_version)
        source_series_dir = (series_directory(root) / source_id).resolve()
        source_version_dir = (source_series_dir / "styles" / f"v{source_version}").resolve()
        if not source_version_dir.is_relative_to(source_series_dir):
            raise VideoStyleError("风格快照路径无效", code="STYLE_SNAPSHOT_PATH_INVALID")

        requested_name = body.get("name")
        if requested_name is not None and (not isinstance(requested_name, str) or not requested_name.strip()):
            raise VideoStyleError("新风格名称不能为空", code="INVALID_SERIES_NAME")
        base_name = requested_name.strip() if isinstance(requested_name, str) else f"{source_series.get('name') or '风格'} 副本"
        builtins = {str(item.get("id") or "") for item in list_builtin_templates()}
        base_template = str(source_style.get("baseTemplateId") or source_style.get("id") or "")
        template_id = base_template if base_template in builtins else None
        aspect = str(source_series.get("defaultAspectRatio") or "16:9")
        copied_series = None
        for attempt in range(1, 101):
            name = base_name if requested_name is not None or attempt == 1 else f"{base_name} {attempt}"
            try:
                copied_series = create_series(
                    root,
                    name=name,
                    template_id=template_id,
                    default_aspect_ratio=aspect,
                )
                break
            except VideoStyleError as exc:
                if requested_name is not None or exc.code != "SERIES_EXISTS":
                    raise
        if copied_series is None:
            raise VideoStyleError("无法生成唯一的风格副本", code="SERIES_COPY_FAILED", status_code=409)

        created_id = str(copied_series["id"])
        target_series_dir = series_directory(root) / created_id
        target_version_dir = target_series_dir / "styles" / "v1"
        _copy_style_version_tree(source_version_dir, target_version_dir)
        copied_style = _clear_copied_style_binding(
            json.loads((target_version_dir / "design-system.json").read_text(encoding="utf-8"))
        )
        copied_style["seriesId"] = created_id
        copied_style["version"] = 1
        _atomic_write_json(target_version_dir / "design-system.json", copied_style)

        copied_series = get_series(root, created_id)
        copied_series["latestStyleVersion"] = 1
        _atomic_write_json(target_series_dir / "series.json", copied_series)
        draft = create_style_draft_from_version(root, created_id, 1)
        return web.json_response(
            {"ok": True, "series": _series_summary(get_series(root, created_id)), "draft": draft},
            status=201,
        )
    except VideoStyleError as exc:
        if created_id is not None:
            try:
                delete_series(root, created_id)
            except VideoStyleError:
                logger.exception("video style copy rollback error")
        return _domain_error(exc)
    except Exception:
        if created_id is not None:
            try:
                delete_series(root, created_id)
            except VideoStyleError:
                logger.exception("video style copy rollback error")
        logger.exception("video style copy error")
        return web.json_response(
            {"error": "STYLE_COPY_FAILED", "message": "复制风格失败，请重试"}, status=500
        )


async def handle_video_style_validate(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        series_id = request.match_info["series_id"]
        style = body.get("style") if isinstance(body.get("style"), dict) else read_style_draft(_root(), series_id)
        result = validate_style(style, _root(), series_id)
        issues = [
            {**issue, "severity": "error"}
            for issue in result.get("errors", [])
        ] + [
            {**issue, "severity": "warning"}
            for issue in result.get("warnings", [])
        ]
        return web.json_response(
            {"ok": result["valid"], "valid": result["valid"], "issues": issues}
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


def _draft_image_data_uri(series_id: str, asset_id: str) -> str | None:
    if not asset_id:
        return None
    if not _ASSET_ID_RE.fullmatch(asset_id):
        raise VideoStyleError("图片资产编号无效", code="BACKGROUND_ASSET_ID_INVALID")
    directory = series_directory(_root()) / validate_series_id(series_id) / "draft" / "assets"
    path = (directory / f"{asset_id}.webp").resolve()
    if not directory.resolve().is_relative_to(_root().resolve()) or not path.is_relative_to(directory.resolve()):
        raise VideoStyleError("图片资产路径无效", code="BACKGROUND_ASSET_PATH_INVALID")
    if not path.is_file():
        raise VideoStyleError("图片资产不存在", code="BACKGROUND_ASSET_NOT_FOUND", status_code=404)
    if path.stat().st_size > 10 * 1024 * 1024:
        raise VideoStyleError("预览图片过大", code="BACKGROUND_ASSET_TOO_LARGE")
    return "data:image/webp;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


async def handle_video_style_preview(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        series_id = request.match_info["series_id"]
        get_series(_root(), series_id)
        role = str(body.get("role") or "cover").strip().lower()
        if role not in ROLE_NAMES:
            raise VideoStyleError("不支持的预览场景", code="STYLE_PREVIEW_ROLE_INVALID")
        aspect = str(body.get("aspectRatio") or "16:9")
        resolution = {
            "16:9": "1920x1080",
            "9:16": "1080x1920",
            "1:1": "1080x1080",
        }.get(aspect)
        if resolution is None:
            raise VideoStyleError("不支持的预览比例", code="STYLE_PREVIEW_ASPECT_INVALID")
        style = body.get("style")
        if not isinstance(style, dict):
            style = read_style_draft(_root(), series_id)
        spec = style_preview_spec(style, role)
        backgrounds = style.get("backgrounds") if isinstance(style.get("backgrounds"), dict) else {}
        default = backgrounds.get("default") or {}
        selected = (backgrounds.get("roles") or {}).get(role) or {}
        slot = {**default, **selected} if selected.get("inherit") == "default" else selected or default
        background_data_uri = _draft_image_data_uri(series_id, str(slot.get("assetId") or ""))
        track = build_subtitle_track(str(spec["content"]["subtitle"]), 6000)
        motion = build_motion_plan(
            {"index": spec["sceneIndex"], "role": role}, track,
            allowed_effects=style.get("allowedAnimations") or ("fade-rise", "stagger-rise", "soft-pulse", "cross-fade"),
            motion_preferences=style.get("motion") if isinstance(style.get("motion"), dict) else {},
        )
        brand_logo_data_uri = None
        if role == "outro":
            brand = style.get("brand") if isinstance(style.get("brand"), dict) else {}
            logo = brand.get("logo") if isinstance(brand.get("logo"), dict) else {}
            preferred = "light" if str(style.get("mode") or "dark") == "dark" else "dark"
            logo_record = logo.get(preferred) or logo.get("dark") or logo.get("light")
            if isinstance(logo_record, dict):
                asset_id = str(logo_record.get("assetId") or "")
                brand_logo_data_uri = _draft_image_data_uri(series_id, asset_id)
        html = compile_scene_spec(
            spec,
            style,
            resolution=resolution,
            background_data_uri=background_data_uri,
            brand_logo_data_uri=brand_logo_data_uri,
            motion_plan=motion,
            preview=True,
        )
        return web.json_response({"ok": True, "html": html})
    except VideoStyleError as exc:
        return _domain_error(exc)
    except SceneCompileError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)
    except VideoTimelineError as exc:
        return web.json_response(exc.to_dict(), status=422)


async def handle_video_style_lock(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        revision = body.get("revision")
        style = lock_style(
            _root(),
            request.match_info["series_id"],
            expected_revision=int(revision) if revision is not None else None,
        )
        return web.json_response({"ok": True, "version": style})
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "INVALID_STYLE_REVISION", "message": "revision 必须是整数"},
            status=400,
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_style_versions(request: web.Request) -> web.Response:
    try:
        return web.json_response(
            {"styles": list_style_versions(_root(), request.match_info["series_id"])}
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_style_version_to_draft(request: web.Request) -> web.Response:
    try:
        draft = create_style_draft_from_version(
            _root(),
            request.match_info["series_id"],
            int(request.match_info["version"]),
        )
        return web.json_response({"ok": True, "draft": draft})
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "INVALID_STYLE_VERSION", "message": "风格版本必须是整数"},
            status=400,
        )
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_background_asset_import(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        file_path = str(body.get("filePath") or "").strip()
        if not file_path:
            raise VideoStyleError("filePath 不能为空", code="BACKGROUND_FILE_REQUIRED")
        asset = import_background_asset(
            _root(),
            request.match_info["series_id"],
            file_path,
            source_type=str(body.get("sourceType") or "user-upload"),
            rights_status=str(body.get("rightsStatus") or "unknown"),
            license_name=str(body.get("licenseName") or ""),
        )
        api_asset = {
            **asset,
            "id": asset["assetId"],
            "seriesId": request.match_info["series_id"],
            "name": asset.get("originalName"),
            "mime": asset.get("mimeType"),
            "size": asset.get("bytes"),
        }
        return web.json_response({"ok": True, "asset": api_asset}, status=201)
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_background_asset_delete(request: web.Request) -> web.Response:
    try:
        result = delete_background_asset(
            _root(), request.match_info["series_id"], request.match_info["asset_id"]
        )
        return web.json_response({"ok": True, **result})
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_background_asset_preview(request: web.Request) -> web.StreamResponse:
    try:
        series_id = validate_series_id(request.match_info["series_id"])
        asset_id = request.match_info["asset_id"]
        if not _ASSET_ID_RE.fullmatch(asset_id):
            raise VideoStyleError("背景资产不存在", code="BACKGROUND_ASSET_NOT_FOUND", status_code=404)
        path = series_directory(_root()) / series_id / "draft" / "assets" / f"{asset_id}.webp"
        if not path.is_file():
            raise VideoStyleError("背景资产不存在", code="BACKGROUND_ASSET_NOT_FOUND", status_code=404)
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})
    except VideoStyleError as exc:
        return _domain_error(exc)


async def handle_video_brand_kits(request: web.Request) -> web.Response:
    from mona.video_brand import list_brand_kits

    return web.json_response({"brandKits": list_brand_kits(_root())})


async def handle_video_brand_kit_create(request: web.Request) -> web.Response:
    from mona.video_brand import BrandKitError, create_brand_kit, lock_brand_kit

    try:
        body = await _json_body(request)
        kit = create_brand_kit(
            _root(),
            str(body.get("name") or "").strip(),
            tokens=body.get("tokens") if isinstance(body.get("tokens"), dict) else {},
            display_name=str(body.get("displayName") or ""),
            locked_fields=(
                [str(item) for item in body["lockedFields"]]
                if isinstance(body.get("lockedFields"), list)
                else None
            ),
        )
        version = lock_brand_kit(
            _root(), kit["id"], expected_revision=int(kit["revision"])
        )
        return web.json_response({"ok": True, "brandKit": kit, "version": version}, status=201)
    except BrandKitError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)


async def handle_video_brand_logo_import(request: web.Request) -> web.Response:
    from mona.video_brand import BrandKitError, import_brand_logo

    try:
        body = await _json_body(request)
        logo, draft = import_brand_logo(
            _root(),
            request.match_info["kit_id"],
            str(body.get("filePath") or ""),
            variant=str(body.get("variant") or ""),
            rights_status=str(body.get("rightsStatus") or "unknown"),
            alt=str(body.get("alt") or ""),
        )
        return web.json_response({"ok": True, "logo": logo, "brandKit": draft})
    except BrandKitError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)


async def handle_video_brand_kit_lock(request: web.Request) -> web.Response:
    from mona.video_brand import BrandKitError, lock_brand_kit

    try:
        body = await _json_body(request)
        revision = body.get("revision")
        version = lock_brand_kit(
            _root(),
            request.match_info["kit_id"],
            expected_revision=int(revision) if revision is not None else None,
        )
        return web.json_response({"ok": True, "version": version})
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "BRAND_KIT_REVISION_INVALID", "message": "品牌修订号无效"},
            status=400,
        )
    except BrandKitError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)


async def handle_video_series_apply_brand_kit(request: web.Request) -> web.Response:
    from mona.video_brand import (
        BrandKitError,
        apply_brand_kit,
        materialize_brand_assets,
        read_brand_version,
    )

    try:
        body = await _json_body(request)
        series_id = request.match_info["series_id"]
        kit_id = str(body.get("brandKitId") or "").strip()
        version = int(body.get("version") or 0)
        brand = read_brand_version(_root(), kit_id, version)
        brand = materialize_brand_assets(
            _root(), brand, series_directory(_root()) / validate_series_id(series_id)
        )
        current = read_style_draft(_root(), series_id)
        branded = apply_brand_kit(current, brand)
        saved = save_style_draft(
            _root(),
            series_id,
            branded,
            expected_revision=int(current.get("revision") or 0),
            allow_brand_binding_change=True,
        )
        return web.json_response({"ok": True, "draft": saved})
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "BRAND_KIT_VERSION_INVALID", "message": "品牌版本无效"},
            status=400,
        )
    except BrandKitError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)
    except VideoStyleError as exc:
        return _domain_error(exc)
