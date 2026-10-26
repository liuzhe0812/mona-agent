"""Frozen Huashu samples retain the film source and its compiled composition."""

import hashlib
import json
from pathlib import Path

import pytest

from mona.api.video_series import (
    _apply_style_sample_seed,
    _copy_refresh_inputs,
    _load_style_sample_seed,
)
from mona.video_style import VideoStyleError, create_series, get_builtin_template


def _saved_film(root: Path) -> Path:
    create_series(root, "film-style", "样片风格", template_id="huashu-keynote")
    version = root / "video_series/film-style/styles/v1"
    authoring = version / "authoring"
    files = {
        "scene_sources/film.html": b"<html>film source --mona-primary</html>",
        "composition/index.html": b"<html>compiled whole film</html>",
        "scenes/scene_01.html": b"<html>scene wrapper</html>",
        "renders/previews/scene_01/sample_0.png": b"frame one",
        "renders/previews/scene_01/sample_1.png": b"frame two",
    }
    for relative, data in files.items():
        path = authoring / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    source_hash = hashlib.sha256(files["scene_sources/film.html"]).hexdigest()
    sample = {
        "schemaVersion": 1,
        "resolution": "1920x1080",
        "narrationEnabled": False,
        "assets": [],
        "scenes": [{
            "index": 1, "duration": 3, "authored": True,
            "authoredRuntime": "huashu-motion", "sourcePath": "scene_sources/film.html",
            "sourceHash": source_hash, "compositionStartSeconds": 0,
        }],
        "composition": {"sourcePath": "scene_sources/film.html", "htmlPath": "composition/index.html", "planRevision": 2},
        "files": {relative: hashlib.sha256(data).hexdigest() for relative, data in files.items()},
    }
    for relative, content in {
        "sample.json": json.dumps(sample),
        "rules.md": "使用连贯镜头表达变化",
        "assets/manifest.json": '{"assets": []}',
        "previews/poster.png": "poster",
        "previews/motion.gif": "motion",
    }.items():
        path = authoring / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    style = get_builtin_template("huashu-keynote")
    style.update(version=1, authoring={"samplePath": "authoring/sample.json"})
    (version / "design-system.json").write_text(json.dumps(style), encoding="utf-8")
    return authoring


def test_frozen_huashu_sample_restores_the_shared_film_and_composition(tmp_path: Path) -> None:
    authoring = _saved_film(tmp_path)
    seed = _load_style_sample_seed(tmp_path, "film-style", 1)
    project = tmp_path / "video_projects/example"
    project.mkdir(parents=True)
    meta = {"planRevision": 2}

    _apply_style_sample_seed(project, meta, seed)

    assert (project / "scene_sources/film.html").read_bytes() == (authoring / "scene_sources/film.html").read_bytes()
    assert (project / "composition/index.html").read_bytes() == (authoring / "composition/index.html").read_bytes()
    assert meta["scenes"][0]["sourcePath"] == "scene_sources/film.html"
    assert meta["scenes"][0]["compositionStartSeconds"] == 0
    assert meta["composition"]["htmlPath"] == "composition/index.html"
    assert meta["composition"]["planRevision"] == 2
    assert not (project / "scene_sources/scene_01.html").exists()


@pytest.mark.parametrize("relative", ["scene_sources/film.html", "composition/index.html"])
def test_frozen_huashu_sample_rejects_tampered_film_files(tmp_path: Path, relative: str) -> None:
    authoring = _saved_film(tmp_path)
    (authoring / relative).write_text("changed", encoding="utf-8")

    with pytest.raises(VideoStyleError, match="校验失败"):
        _load_style_sample_seed(tmp_path, "film-style", 1)


def test_staging_a_composition_refresh_cannot_change_the_live_preview(tmp_path: Path) -> None:
    project = tmp_path / "live"
    composition = project / "composition/index.html"
    composition.parent.mkdir(parents=True)
    composition.write_text("live composition", encoding="utf-8")
    staged = tmp_path / "staged"

    _copy_refresh_inputs(project, staged, [], {})
    (staged / "composition/index.html").write_text("new preview", encoding="utf-8")

    assert composition.read_text(encoding="utf-8") == "live composition"
