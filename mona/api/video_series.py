"""HTTP handlers for video series, style versions, and background assets."""

from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.config.paths import get_workspace_path
from mona.video_scene_compiler import SceneCompileError, compile_scene_spec
from mona.video_style import (
    VideoStyleError,
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

_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


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
    return web.json_response({"templates": list_builtin_templates()})


def _series_summary(series: dict[str, Any]) -> dict[str, Any]:
    result = dict(series)
    result["episodeCount"] = 0
    projects = get_workspace_path() / "video_projects"
    if projects.is_dir():
        for project in projects.iterdir():
            meta = project / "meta.json"
            if not meta.is_file():
                continue
            try:
                import json

                value = json.loads(meta.read_text(encoding="utf-8"))
            except Exception:
                continue
            if value.get("seriesId") == series.get("id"):
                result["episodeCount"] += 1
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
                or "minimal-business"
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
    projects = _root() / "video_projects"
    references: list[tuple[Path, dict[str, Any]]] = []
    if not projects.is_dir():
        return references
    for project in projects.iterdir():
        meta_path = project / "meta.json"
        if not meta_path.is_file():
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


_PREVIEW_SCENES: dict[str, tuple[str, dict[str, Any]]] = {
    "cover": (
        "cover-split",
        {
            "eyebrow": "系列封面",
            "title": "让复杂知识变得清晰",
            "body": "一套风格贯穿每一期内容",
            "visual": "01 / 08",
            "subtitle": "配色、组件、背景与字幕规则自动继承",
        },
    ),
    "content": (
        "content-standard",
        {
            "eyebrow": "核心内容",
            "title": "稳定的视觉语言",
            "body": "固定组件、版式与动效，只让内容发生变化。",
            "bullets": ["统一标题层级", "统一信息组件", "统一字幕安全区"],
        },
    ),
    "data": (
        "metric-comparison",
        {
            "eyebrow": "数据洞察",
            "title": "效率持续提升",
            "metrics": [
                {"value": "72%", "label": "制作效率"},
                {"value": "3.6×", "label": "内容产能"},
                {"value": "98%", "label": "风格一致"},
            ],
        },
    ),
    "outro": (
        "outro-brand",
        {
            "eyebrow": "系列片尾",
            "title": "下一期见",
            "summary": "风格延续，内容继续。",
        },
    ),
}


async def handle_video_style_preview(request: web.Request) -> web.Response:
    try:
        body = await _json_body(request)
        series_id = request.match_info["series_id"]
        get_series(_root(), series_id)
        role = str(body.get("role") or "cover").strip().lower()
        if role not in _PREVIEW_SCENES:
            raise VideoStyleError("不支持的预览场景", code="STYLE_PREVIEW_ROLE_INVALID")
        aspect = str(body.get("aspectRatio") or "16:9")
        resolution = {
            "16:9": "432x243",
            "9:16": "243x432",
            "1:1": "360x360",
        }.get(aspect)
        if resolution is None:
            raise VideoStyleError("不支持的预览比例", code="STYLE_PREVIEW_ASPECT_INVALID")
        style = body.get("style")
        if not isinstance(style, dict):
            style = read_style_draft(_root(), series_id)
        layout, content = _PREVIEW_SCENES[role]
        spec = {
            "schemaVersion": 1,
            "sceneIndex": {"cover": 1, "content": 2, "data": 3, "outro": 4}[role],
            "role": role,
            "layout": layout,
            "backgroundSlot": role,
            "animationPreset": str(
                ((style.get("motion") or {}).get("enterPreset")) or "fade-rise"
            ),
            "duration": 6,
            "start": 0,
            "content": content,
        }
        brand_logo_data_uri = None
        if role == "outro":
            brand = style.get("brand") if isinstance(style.get("brand"), dict) else {}
            logo = brand.get("logo") if isinstance(brand.get("logo"), dict) else {}
            preferred = "light" if str(style.get("mode") or "dark") == "dark" else "dark"
            logo_record = logo.get(preferred) or logo.get("dark") or logo.get("light")
            if isinstance(logo_record, dict):
                asset_id = str(logo_record.get("assetId") or "")
                if _ASSET_ID_RE.fullmatch(asset_id):
                    logo_path = (
                        series_directory(_root())
                        / validate_series_id(series_id)
                        / "draft"
                        / "assets"
                        / f"{asset_id}.webp"
                    )
                    if logo_path.is_file():
                        brand_logo_data_uri = (
                            "data:image/webp;base64,"
                            + base64.b64encode(logo_path.read_bytes()).decode("ascii")
                        )
        html = compile_scene_spec(
            spec,
            style,
            resolution=resolution,
            brand_logo_data_uri=brand_logo_data_uri,
        )
        return web.json_response({"ok": True, "html": html})
    except VideoStyleError as exc:
        return _domain_error(exc)
    except SceneCompileError as exc:
        return web.json_response(exc.to_dict(), status=exc.status_code)


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
