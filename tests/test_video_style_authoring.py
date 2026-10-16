"""Real-file contracts for authored style samples and immutable publication."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

import pytest
from PIL import Image

from mona.video_style import (
    RevisionConflictError,
    StyleValidationError,
    create_series,
    import_background_asset,
    lock_style,
    read_style_draft,
    read_style_version,
    save_style_draft,
)
from mona.video_style_authoring import (
    bind_style_sample,
    capture_style_sample,
    materialize_style_sample_assets,
    resolve_style_sample_media,
    style_visual_hash,
)


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _sample(tmp_path: Path) -> tuple[Path, dict]:
    create_series(tmp_path, "paper", "我的纸张风格")
    project = tmp_path / "video_projects" / "纸张样片"
    _write(project / "meta.json", {"name": project.name, "resolution": "1920x1080"})
    draft = bind_style_sample(tmp_path, "paper", project.name, 0, "温暖纸张，图形讲解")
    draft = save_style_draft(tmp_path, "paper", {"authoring": {"rules": "纸张质感，跟随旁白逐步折叠图形；对象保持连续。"}}, expected_revision=draft["revision"])
    _write(project / "style" / "design-system.json", draft)
    source = project / "scene_sources" / "scene_01.tsx"
    source.parent.mkdir(parents=True)
    source.write_text("export default function Scene(){return <div>样片</div>}", encoding="utf-8")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    rendered = project / "scenes" / "scene_01.html"
    rendered.parent.mkdir()
    rendered.write_text("<!doctype html><html><body>已运行样片</body></html>", encoding="utf-8")
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    meta["styleAuthoring"].update({"draftRevision": draft["revision"], "styleInputHash": style_visual_hash(draft)})
    meta["scenes"] = [{"index": 1, "title": "图形跟随内容变化", "duration": 12, "authored": True,
                       "authoredRuntime": "remotion", "htmlStatus": "previewing", "sourceHash": digest,
                       "motionReviewSourceHash": digest, "motionReview": {"distinctVisualStates": 3, "requiresCreativeReview": True}, "assets": []}]
    _write(project / "meta.json", meta)
    frames = project / "renders" / "previews" / "scene_01"
    frames.mkdir(parents=True)
    latest = max(source.stat().st_mtime_ns, rendered.stat().st_mtime_ns, (project / "style" / "design-system.json").stat().st_mtime_ns)
    for index, color in enumerate(("#f4ede0", "#233c55", "#c17843")):
        path = frames / f"sample_{index}.png"
        Image.new("RGB", (64, 36), color).save(path)
        os.utime(path, ns=(latest + 1_000_000, latest + 1_000_000))
    return project, draft


def test_bind_authorizes_only_existing_sample_and_keeps_rules(tmp_path: Path) -> None:
    create_series(tmp_path, "paper", "纸张")
    draft = save_style_draft(tmp_path, "paper", {"authoring": {"rules": "保留画法"}}, expected_revision=0)
    project = tmp_path / "video_projects" / "样片"
    _write(project / "meta.json", {"requirePlanApproval": True, "scenes": []})
    saved = bind_style_sample(tmp_path, "paper", "样片", draft["revision"], "温暖纸张")
    assert saved["revision"] == 2
    assert saved["authoring"] == {"projectName": "样片", "description": "温暖纸张", "rules": "保留画法"}
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["requirePlanApproval"] is False
    assert meta["styleAuthoring"]["styleInputHash"] == style_visual_hash(saved)
    assert json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8")) == saved
    with pytest.raises(RevisionConflictError):
        bind_style_sample(tmp_path, "paper", "样片", 0)


def test_bind_copies_legacy_background_and_logo_without_changing_paths(tmp_path: Path) -> None:
    from mona.video_assets import list_project_assets
    from mona.video_authoring import _embed_media

    create_series(tmp_path, "paper", "纸张")
    for asset_id in ("background", "logo"):
        image = tmp_path / f"{asset_id}.png"
        Image.new("RGB", (64, 36), "#eadcc4").save(image)
        import_background_asset(tmp_path, "paper", image, asset_id=asset_id, rights_status="owned")
    draft = save_style_draft(tmp_path, "paper", {
        "backgrounds": {"default": {"assetId": "background", "assetPath": "draft/assets/background.webp"}},
        "brand": {"logo": {"light": {"assetId": "logo", "assetPath": "draft/assets/logo.webp"}}},
    }, expected_revision=0)
    project = tmp_path / "video_projects" / "样片"
    _write(project / "meta.json", {"scenes": []})
    saved = bind_style_sample(tmp_path, "paper", project.name, draft["revision"])
    assert saved["backgrounds"]["default"]["assetPath"] == "draft/assets/background.webp"
    assert saved["brand"]["logo"]["light"]["assetPath"] == "draft/assets/logo.webp"
    project_style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
    assert style_visual_hash(project_style) == style_visual_hash(saved)
    for asset_id in ("background", "logo"):
        source = tmp_path / "video_series" / "paper" / "draft" / "assets" / f"{asset_id}.webp"
        copied = project / "style" / "draft" / "assets" / f"{asset_id}.webp"
        assert copied.read_bytes() == source.read_bytes()
    records = list_project_assets(project)
    assert len(records) == 1  # Identical image content reuses one registry identity.
    assert records[0]["rightsStatus"] == "owned"
    assert "data:image/webp;base64," in _embed_media(f'<img src="{records[0]["path"]}">', project)


def test_visual_rebind_invalidates_review_without_removing_source_or_sound(tmp_path: Path) -> None:
    project, draft = _sample(tmp_path)
    audio = project / "audio" / "scene_01.mp3"
    audio.parent.mkdir()
    audio.write_bytes(b"existing-narration")
    source = (project / "scene_sources" / "scene_01.tsx").read_bytes()
    changed = save_style_draft(tmp_path, "paper", {"tokens": {"colors": {"primary": "#123456"}}}, expected_revision=draft["revision"])
    saved = bind_style_sample(tmp_path, "paper", project.name, changed["revision"], changed["authoring"]["description"])
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert "motionReview" not in meta["scenes"][0]
    assert "motionReviewSourceHash" not in meta["scenes"][0]
    assert (project / "scene_sources" / "scene_01.tsx").read_bytes() == source
    assert audio.read_bytes() == b"existing-narration"
    assert meta["styleAuthoring"]["styleInputHash"] == style_visual_hash(saved)
    with pytest.raises(StyleValidationError):
        capture_style_sample(tmp_path, "paper", saved["revision"])


def test_management_only_rebind_keeps_current_preview_valid(tmp_path: Path) -> None:
    project, draft = _sample(tmp_path)
    style_path = project / "style" / "design-system.json"
    previous_mtime = style_path.stat().st_mtime_ns
    saved = bind_style_sample(tmp_path, "paper", project.name, draft["revision"], draft["authoring"]["description"])
    assert style_path.stat().st_mtime_ns == previous_mtime
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["scenes"][0]["motionReview"]["distinctVisualStates"] == 3
    assert capture_style_sample(tmp_path, "paper", saved["revision"])["version"] == 1


def test_hash_ignores_management_fields_but_tracks_visual_inputs(tmp_path: Path) -> None:
    _, draft = _sample(tmp_path)
    renamed = {**draft, "name": "新名字", "revision": 99, "updatedAt": "later"}
    assert style_visual_hash(renamed) == style_visual_hash(draft)
    renamed["authoring"] = {**draft["authoring"], "rules": "改变画法"}
    assert style_visual_hash(renamed) != style_visual_hash(draft)


def test_capture_rejects_missing_rules_and_revision_conflict(tmp_path: Path) -> None:
    _, draft = _sample(tmp_path)
    with pytest.raises(RevisionConflictError):
        capture_style_sample(tmp_path, "paper", draft["revision"] - 1)
    draft = save_style_draft(tmp_path, "paper", {"authoring": {"rules": ""}}, expected_revision=draft["revision"])
    with pytest.raises(StyleValidationError, match="风格规则"):
        capture_style_sample(tmp_path, "paper", draft["revision"])


def test_publish_contains_actual_sources_previews_and_independent_snapshot(tmp_path: Path) -> None:
    project, draft = _sample(tmp_path)
    saved = capture_style_sample(tmp_path, "paper", draft["revision"])
    assert saved["version"] == 1
    assert "projectName" not in saved["authoring"]
    package = tmp_path / "video_series" / "paper" / "styles" / "v1"
    assert (package / "authoring" / "scene_sources" / "scene_01.tsx").read_bytes() == (project / "scene_sources" / "scene_01.tsx").read_bytes()
    assert (package / "authoring" / "rules.md").read_text(encoding="utf-8").strip() == draft["authoring"]["rules"]
    observation = json.loads((package / "authoring" / "sample.json").read_text(encoding="utf-8"))
    assert observation["creativeCertification"] is False
    assert observation["observation"] == "sampled-frames"
    with Image.open(resolve_style_sample_media(tmp_path, "paper", 1, saved["authoring"]["motion"])) as image:
        assert image.n_frames == 3
    assert not (package / "previews" / "content.html").exists()
    assert capture_style_sample(tmp_path, "paper", draft["revision"]) == saved
    assert not (package.parent / "v2").exists()
    new_project = tmp_path / "video_projects" / "新主题"
    shutil.copytree(package, new_project / "style")
    shutil.rmtree(project)
    assert (new_project / "style" / "authoring" / "scene_sources" / "scene_01.tsx").is_file()
    assert read_style_version(tmp_path, "paper", 1) == saved


@pytest.mark.parametrize("change", ["missing-source", "changed-source", "missing-review", "missing-frame", "stale-frame", "changed-style", "running"])
def test_reject_unfinished_or_stale_sample_without_version(tmp_path: Path, change: str) -> None:
    project, draft = _sample(tmp_path)
    meta_path = project / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if change == "missing-source":
        (project / "scene_sources" / "scene_01.tsx").unlink()
    elif change == "changed-source":
        (project / "scene_sources" / "scene_01.tsx").write_text("changed", encoding="utf-8")
    elif change == "missing-review":
        meta["scenes"][0].pop("motionReview")
        _write(meta_path, meta)
    elif change == "missing-frame":
        shutil.rmtree(project / "renders" / "previews")
    elif change == "stale-frame":
        os.utime(project / "renders" / "previews" / "scene_01" / "sample_0.png", ns=(1, 1))
    elif change == "changed-style":
        draft = save_style_draft(tmp_path, "paper", {"tokens": {"colors": {"primary": "#123456"}}}, expected_revision=draft["revision"])
    elif change == "running":
        _write(project / ".render_status.json", {"stage": "rendering"})
    with pytest.raises(StyleValidationError):
        capture_style_sample(tmp_path, "paper", draft["revision"])
    assert not (tmp_path / "video_series" / "paper" / "styles" / "v1").exists()


def test_unknown_asset_rights_block_reuse_and_owned_asset_is_frozen(tmp_path: Path) -> None:
    project, draft = _sample(tmp_path)
    image = project / "assets" / "paper.png"
    image.parent.mkdir()
    Image.new("RGB", (16, 16), "white").save(image)
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    meta["scenes"][0]["assets"] = ["paper"]
    _write(project / "meta.json", meta)
    manifest = {"schemaVersion": 1, "assets": [{"id": "paper", "path": "assets/paper.png", "rightsStatus": "unknown"}]}
    _write(project / "assets" / "manifest.json", manifest)
    with pytest.raises(StyleValidationError, match="权限"):
        capture_style_sample(tmp_path, "paper", draft["revision"])
    manifest["assets"][0]["rightsStatus"] = "owned"
    _write(project / "assets" / "manifest.json", manifest)
    capture_style_sample(tmp_path, "paper", draft["revision"])
    snapshot = resolve_style_sample_media(tmp_path, "paper", 1, "authoring/assets/paper.png")
    assert snapshot.read_bytes() == image.read_bytes()
    new_project = tmp_path / "video_projects" / "另一个主题"
    shutil.copytree(tmp_path / "video_series" / "paper" / "styles" / "v1", new_project / "style")
    registered = materialize_style_sample_assets(new_project)
    assert registered[0]["id"] == "paper"
    assert registered[0]["rightsStatus"] == "owned"
    assert (new_project / registered[0]["path"]).read_bytes() == image.read_bytes()
    assert materialize_style_sample_assets(new_project) == []
    (new_project / registered[0]["path"]).write_bytes(b"another image")
    with pytest.raises(StyleValidationError, match="冲突"):
        materialize_style_sample_assets(new_project)


@pytest.mark.parametrize("relative", ["../series.json", "authoring/../../series.json", "C:/outside.png", "/outside.png", "authoring/../design-system.json"])
def test_media_resolver_rejects_path_escape(tmp_path: Path, relative: str) -> None:
    _, draft = _sample(tmp_path)
    capture_style_sample(tmp_path, "paper", draft["revision"])
    with pytest.raises(StyleValidationError):
        resolve_style_sample_media(tmp_path, "paper", 1, relative)


def test_existing_legacy_style_still_publishes_without_sample(tmp_path: Path) -> None:
    create_series(tmp_path, "legacy", "旧风格")
    saved = lock_style(tmp_path, "legacy", expected_revision=0)
    assert saved["version"] == 1
    assert (tmp_path / "video_series" / "legacy" / "styles" / "v1" / "previews" / "content.html").is_file()
    assert read_style_draft(tmp_path, "legacy")["revision"] == 0


def test_sample_cannot_bind_project_outside_workspace(tmp_path: Path) -> None:
    create_series(tmp_path, "paper", "纸张")
    with pytest.raises(StyleValidationError):
        bind_style_sample(tmp_path, "paper", "../private", 0)
    outside = tmp_path / "outside"
    _write(outside / "meta.json", {})
    projects = tmp_path / "video_projects"
    projects.mkdir()
    try:
        (projects / "escaped").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("This host cannot create directory symlinks")
    with pytest.raises(StyleValidationError):
        bind_style_sample(tmp_path, "paper", "escaped", 0)


def test_capture_aborts_if_draft_changes_during_publication(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import mona.video_style_authoring as authoring

    _, draft = _sample(tmp_path)
    write = authoring._atomic_write_json

    def update_while_writing(path: Path, value: dict) -> None:
        write(path, value)
        if path.name == "sample.json":
            save_style_draft(tmp_path, "paper", {"tokens": {"colors": {"primary": "#123456"}}}, expected_revision=draft["revision"])

    monkeypatch.setattr(authoring, "_atomic_write_json", update_while_writing)
    with pytest.raises(StyleValidationError, match="保存期间"):
        capture_style_sample(tmp_path, "paper", draft["revision"])
    assert not (tmp_path / "video_series" / "paper" / "styles" / "v1").exists()


def test_media_resolver_rejects_symlink_escape(tmp_path: Path) -> None:
    _, draft = _sample(tmp_path)
    capture_style_sample(tmp_path, "paper", draft["revision"])
    outside = tmp_path / "outside.png"
    Image.new("RGB", (8, 8)).save(outside)
    link = tmp_path / "video_series" / "paper" / "styles" / "v1" / "authoring" / "escaped.png"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("This host cannot create file symlinks")
    with pytest.raises(StyleValidationError):
        resolve_style_sample_media(tmp_path, "paper", 1, "authoring/escaped.png")
