"""Persist real video samples as reusable, project-independent style versions."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any, Mapping

from PIL import Image

from mona.video_style import (
    RevisionConflictError,
    StyleValidationError,
    VideoStyleError,
    _asset_ids,
    _asset_metadata,
    _atomic_write_json,
    _read_json,
    _require_series,
    _style_asset_path,
    read_style_draft,
    save_style_draft,
    series_directory,
)


def _within(directory: Path, relative: str, *, must_exist: bool = True) -> Path:
    value = str(relative).replace("\\", "/")
    if not value or Path(value).is_absolute() or ".." in Path(value).parts or ":" in value:
        raise StyleValidationError("样片文件路径无效")
    target = (directory / value).resolve()
    if not target.is_relative_to(directory.resolve()):
        raise StyleValidationError("样片文件超出允许范围")
    if must_exist and not target.is_file():
        raise StyleValidationError("样片文件不存在，请重新生成样片")
    return target


def _project(root: Path | str, name: str) -> Path:
    workspace = series_directory(root).parent.resolve()
    projects = workspace / "video_projects"
    if not projects.resolve().is_relative_to(workspace):
        raise StyleValidationError("样片目录超出工作区范围")
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise StyleValidationError("样片项目名称无效")
    project = (projects / name).resolve()
    if not project.is_relative_to(projects.resolve()) or not (project / "meta.json").is_file():
        raise StyleValidationError("样片项目不存在，请重新生成样片")
    _within(project, "meta.json")
    return project


def style_visual_hash(style: Mapping[str, Any]) -> str:
    """Exclude record identity and preview output, retaining all creative inputs."""
    visual = copy.deepcopy(dict(style))
    for key in ("id", "name", "seriesId", "revision", "version", "createdAt", "updatedAt", "lockedAt", "projectTemplate"):
        visual.pop(key, None)
    authoring = style.get("authoring") or {}
    if not isinstance(authoring, Mapping):
        raise StyleValidationError("风格创作数据无效")
    visual["authoring"] = {
        key: authoring.get(key, "") for key in ("description", "rules")
    }
    return hashlib.sha256(json.dumps(visual, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def bind_style_sample(
    root: Path | str,
    series_id: str,
    project_name: str,
    expected_revision: int,
    description: str = "",
) -> dict[str, Any]:
    """Bind an existing normal project to this draft and authorize its sample only."""
    project = _project(root, project_name)
    draft = read_style_draft(root, series_id)
    if int(draft.get("revision", 0)) != expected_revision:
        raise RevisionConflictError("风格草稿已更新，请重新读取")
    meta = _read_json(_within(project, "meta.json"))
    existing = meta.get("styleAuthoring") or {}
    if existing.get("seriesId") not in (None, "", series_id):
        raise StyleValidationError("这个样片已用于其他风格")
    saved = save_style_draft(
        root, series_id,
        {"authoring": {"projectName": project_name, "description": str(description).strip()}},
        expected_revision=expected_revision,
    )
    _materialize_draft_assets(root, series_id, saved, project)
    style_path = _within(project, "style/design-system.json", must_exist=False)
    visual_hash = style_visual_hash(saved)
    if not style_path.is_file() or style_visual_hash(_read_json(style_path)) != visual_hash:
        _atomic_write_json(style_path, saved)
    if existing.get("styleInputHash") != visual_hash:
        for scene in meta.get("scenes") or []:
            scene.pop("motionReview", None)
            scene.pop("motionReviewSourceHash", None)
    meta["styleAuthoring"] = {
        "seriesId": series_id,
        "draftRevision": saved["revision"],
        "description": saved["authoring"]["description"],
        "styleInputHash": visual_hash,
    }
    meta["requirePlanApproval"] = False
    meta["stylePreference"] = "fixed"
    _atomic_write_json(project / "meta.json", meta)
    return saved


def _materialize_draft_assets(
    root: Path | str, series_id: str, draft: Mapping[str, Any], project: Path
) -> None:
    from mona.video_assets import register_project_asset

    directory = _require_series(root, series_id).resolve()
    if not directory.is_relative_to(series_directory(root).resolve()):
        raise StyleValidationError("风格素材目录超出允许范围")
    for asset_id in sorted(_asset_ids(draft)):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", asset_id):
            raise StyleValidationError("风格素材标识无效")
        source = _style_asset_path(directory, asset_id)
        source = _within(directory, source.relative_to(directory).as_posix())
        metadata = _asset_metadata(directory, asset_id) or {}
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        for relative in (f"style/draft/assets/{asset_id}.webp", f"assets/style-draft/{asset_id}.webp"):
            destination = _within(project, relative, must_exist=False)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        _atomic_write_json(
            _within(project, f"style/draft/assets/{asset_id}.json", must_exist=False), metadata
        )
        # Runtime media stays within the existing managed-assets sandbox; the
        # draft's original relative assetPath remains unchanged.
        register_project_asset(project, {
            **metadata, "id": f"style-draft-{digest[:24]}", "kind": "image",
            "path": f"assets/style-draft/{asset_id}.webp", "mimeType": "image/webp",
            "sourceType": metadata.get("sourceType") or "user-upload",
            "rightsStatus": metadata.get("rightsStatus") or "unknown", "sha256": digest,
            "usage": {"type": "style-background", "assetId": asset_id},
        })


def _sample_inputs(
    root: Path | str, series_id: str, draft: Mapping[str, Any]
) -> tuple[Path, dict[str, Any], list[Path], list[Path], list[dict[str, Any]]]:
    from mona.video_assets import VideoAssetError, validate_asset_references
    from mona.video_authoring import authored_scene_source_path

    authoring = draft.get("authoring") or {}
    if not str(authoring.get("rules") or "").strip():
        raise StyleValidationError("请先完成风格规则和动画样片")
    project = _project(root, str(authoring.get("projectName") or ""))
    meta = _read_json(_within(project, "meta.json"))
    binding = meta.get("styleAuthoring") or {}
    sample_style = _read_json(_within(project, "style/design-system.json"))
    current_hash = style_visual_hash(draft)
    if (binding.get("seriesId") != series_id or binding.get("styleInputHash") != current_hash
            or style_visual_hash(sample_style) != current_hash):
        raise StyleValidationError("样片尚未更新到当前风格，请更新样片后保存")
    render_status = project / ".render_status.json"
    if render_status.is_file() and _read_json(_within(project, ".render_status.json")).get("stage") in {"rendering", "queued", "cancelling"}:
        raise StyleValidationError("样片正在处理，完成后可保存风格")
    scenes = meta.get("scenes") or []
    if not scenes:
        raise StyleValidationError("请先生成动画样片")
    files = [_within(project, "style/design-system.json")]
    frames: list[Path] = []
    asset_ids: set[str] = set()
    for scene in scenes:
        if not isinstance(scene, dict) or not scene.get("authored") or scene.get("htmlStatus") not in {"previewing", "confirmed"}:
            raise StyleValidationError("样片尚未制作完成")
        try:
            source = authored_scene_source_path(project, scene)
            relative = source.relative_to(project).as_posix()
        except (KeyError, TypeError, ValueError) as exc:
            raise StyleValidationError("样片场景无效") from exc
        source = _within(project, relative)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != scene.get("sourceHash") or digest != scene.get("motionReviewSourceHash"):
            raise StyleValidationError("样片已修改，请重新检查动画后保存")
        review = scene.get("motionReview") or {}
        if review.get("distinctVisualStates", 0) < 2:
            raise StyleValidationError("样片还没有可用的动画检查结果")
        index = int(scene["index"])
        rendered = _within(project, f"scenes/scene_{index:02d}.html")
        scene_frames = sorted((project / "renders" / "previews" / f"scene_{index:02d}").glob("sample_*.png"), key=lambda path: int(path.stem.split("_")[-1]) if re.fullmatch(r"sample_\d+", path.stem) else -1)
        if len(scene_frames) < 2:
            raise StyleValidationError("缺少样片的实际预览，请重新预览后保存")
        latest_input = max(source.stat().st_mtime_ns, rendered.stat().st_mtime_ns, files[0].stat().st_mtime_ns)
        for frame in scene_frames:
            safe = _within(project, frame.relative_to(project).as_posix())
            if safe.stat().st_mtime_ns < latest_input:
                raise StyleValidationError("样片预览已过期，请重新预览后保存")
            try:
                with Image.open(safe) as image:
                    image.verify()
            except (OSError, ValueError) as exc:
                raise StyleValidationError("样片预览损坏，请重新生成") from exc
        files.extend((source, rendered))
        files.extend(scene_frames)
        frames.extend(scene_frames)
        asset_ids.update(str(value) for value in scene.get("assets") or [])
        for suffix in ("mp3", "timing.json"):
            audio = project / "audio" / f"scene_{index:02d}.{suffix}"
            if audio.is_file():
                files.append(_within(project, audio.relative_to(project).as_posix()))
    try:
        assets = validate_asset_references(project, sorted(asset_ids))
    except VideoAssetError as exc:
        raise StyleValidationError("样片引用的素材不可用，请检查后重试") from exc
    for asset in assets:
        if asset.get("rightsStatus") not in {"owned", "licensed", "public-domain", "permission-granted", "ai-generated"}:
            raise StyleValidationError("请先确认样片素材的使用权限")
        relative = str(asset.get("path") or "")
        if not relative.startswith("assets/"):
            raise StyleValidationError("样片素材路径无效")
        files.append(_within(project, relative))
    if assets:
        files.append(_within(project, "assets/manifest.json"))
    # Keep style dependencies without nesting previously captured sample projects.
    for relative in ("style/assets", "style/draft/assets"):
        for path in (project / relative).rglob("*"):
            if path.is_file():
                files.append(_within(project, path.relative_to(project).as_posix()))
    if (project / "style" / "theme.css").is_file():
        files.append(_within(project, "style/theme.css"))
    return project, meta, list(dict.fromkeys(files)), frames, assets


def snapshot_style_sample(
    root: Path | str, series_id: str, draft: Mapping[str, Any], version_directory: Path
) -> dict[str, Any]:
    """Capture already observed content; never claim creative certification."""
    if not version_directory.resolve().is_relative_to(series_directory(root).resolve()):
        raise StyleValidationError("风格保存目录超出允许范围")
    project, meta, files, frames, assets = _sample_inputs(root, series_id, draft)
    target = version_directory / "authoring"
    target.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}
    input_hashes: dict[str, str] = {}
    for source in files:
        relative = source.relative_to(project).as_posix()
        data = source.read_bytes()
        input_hashes[relative] = hashlib.sha256(data).hexdigest()
        if relative in {"style/design-system.json", "assets/manifest.json"}:
            continue
        hashes[relative] = input_hashes[relative]
        destination = _within(target, relative, must_exist=False)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    _atomic_write_json(target / "assets" / "manifest.json", {"schemaVersion": 1, "assets": assets})
    rules = str(draft["authoring"]["rules"]).strip()
    (target / "rules.md").write_text(rules + "\n", encoding="utf-8")
    previews = target / "previews"
    previews.mkdir()
    with Image.open(frames[len(frames) // 2]) as image:
        image.convert("RGB").save(previews / "poster.png")
    animation = []
    try:
        for source in frames:
            with Image.open(source) as image:
                frame = image.convert("RGB")
                frame.thumbnail((640, 640))
                animation.append(frame)
        animation[0].save(previews / "motion.gif", save_all=True, append_images=animation[1:], duration=350, loop=0)
    finally:
        for frame in animation:
            frame.close()
    sample = {
        "schemaVersion": 1, "resolution": meta.get("resolution"), "scenes": meta["scenes"],
        "narrationEnabled": meta.get("narrationEnabled", False), "subtitleMode": meta.get("subtitleMode", "burned"),
        "assets": assets,
        "styleInputHash": style_visual_hash(draft), "files": hashes,
        "observation": "sampled-frames", "creativeCertification": False,
    }
    _atomic_write_json(target / "sample.json", sample)
    # Reject a capture racing source, settings or draft edits instead of publishing it.
    if (style_visual_hash(read_style_draft(root, series_id)) != style_visual_hash(draft)
            or _read_json(project / "meta.json") != meta
            or any(hashlib.sha256(_within(project, relative).read_bytes()).hexdigest() != digest for relative, digest in input_hashes.items())):
        raise StyleValidationError("保存期间样片已修改，请检查最新结果后重试")
    return {
        "description": str(draft["authoring"].get("description") or ""), "rules": rules,
        "rulesPath": "authoring/rules.md", "samplePath": "authoring/sample.json",
        "poster": "authoring/previews/poster.png", "motion": "authoring/previews/motion.gif",
        "styleInputHash": sample["styleInputHash"],
        "captureHash": hashlib.sha256(json.dumps(sample, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
    }


def capture_style_sample(
    root: Path | str, series_id: str, expected_revision: int | None = None
) -> dict[str, Any]:
    from mona.video_style import lock_style

    draft = read_style_draft(root, series_id)
    if not (draft.get("authoring") or {}).get("projectName"):
        raise StyleValidationError("请先生成动画样片")
    return lock_style(root, series_id, expected_revision=expected_revision)


def resolve_style_sample_media(
    root: Path | str, series_id: str, version: int, relative: str
) -> Path:
    directory = _require_series(root, series_id).resolve()
    if not directory.is_relative_to(series_directory(root).resolve()):
        raise StyleValidationError("风格目录超出允许范围")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise VideoStyleError("风格版本无效", code="STYLE_VERSION_NOT_FOUND", status_code=404)
    version_directory = (directory / "styles" / f"v{version}").resolve()
    if not version_directory.is_relative_to(directory):
        raise StyleValidationError("风格版本目录超出允许范围")
    if not str(relative).startswith("authoring/"):
        raise StyleValidationError("风格样片路径无效")
    return _within(version_directory, relative)


def materialize_style_sample_assets(project: Path) -> list[dict[str, Any]]:
    """Make frozen example asset IDs available to a newly created video project."""
    from mona.video_assets import list_project_assets, register_project_asset

    sample = project / "style" / "authoring"
    manifest = sample / "assets" / "manifest.json"
    if not manifest.is_file():
        return []
    records = _read_json(_within(project, "style/authoring/assets/manifest.json")).get("assets") or []
    existing = {item["id"]: item for item in list_project_assets(project)}
    result = []
    for record in records:
        relative = str(record.get("path") or "")
        if not relative.startswith("assets/"):
            raise StyleValidationError("风格素材路径无效")
        source = _within(sample, relative)
        asset_id = str(record.get("id") or "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", asset_id):
            raise StyleValidationError("风格素材标识无效")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if asset_id in existing:
            previous = _within(project, str(existing[asset_id].get("path") or ""))
            if hashlib.sha256(previous.read_bytes()).hexdigest() != digest:
                raise StyleValidationError("风格素材与项目中的同名素材冲突")
            continue
        target_relative = f"assets/style-sample/{asset_id}{source.suffix.lower()}"
        destination = _within(project, target_relative, must_exist=False)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        result.append(register_project_asset(project, {**record, "path": target_relative, "sha256": digest}))
    return result
