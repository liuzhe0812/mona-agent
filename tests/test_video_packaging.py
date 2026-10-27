import hashlib
import json
import tomllib
from fnmatch import fnmatch
from pathlib import Path


def test_base_wheel_includes_standard_skill_dependency_manifests() -> None:
    root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))

    assert "mona/skills/**/*.toml" in project["tool"]["hatch"]["build"]["include"]
    for skill in ("mona-docx", "mona-motion", "skill-creator"):
        assert (root / "mona" / "skills" / skill / "pyproject.toml").is_file()
    assert not (root / "mona" / "skills" / "mona-video").exists()
    assert not (root / "mona" / "skills" / "mona-ppt").exists()


def test_huashu_resources_keep_upstream_hashes_and_packaged_licenses() -> None:
    root = Path(__file__).resolve().parent.parent
    assets = root / "mona/skills/mona-motion/assets/huashu-motion"
    provenance = json.loads((assets / "provenance.json").read_text(encoding="utf-8"))
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = project["tool"]["hatch"]["build"]["include"]
    assert provenance["commit"] == "52467f99c602b76ba86d511d37acdfe93fa1e16e"
    assert provenance["version"] == "0.3.1"
    for item in provenance["includedFiles"]:
        path = assets / item["path"]
        data = path.read_bytes()
        assert len(data) == item["sizeBytes"]
        assert hashlib.sha256(data).hexdigest() == item["sha256"], path
        assert item["sourcePath"] == item["path"]
        assert any(fnmatch(path.relative_to(root).as_posix(), pattern) for pattern in patterns), path
    for relative in ("LICENSE", "THIRD_PARTY.md", "runtime/clip/LICENSE", "runtime/clip/NOTICE.md", "fonts/OFL.txt", "fonts/LICENSES.md"):
        assert (assets / relative).is_file()
    assert not (assets / "examples").exists()
    assert not (assets / "templates/storytime").exists()
    assert not (assets / "runtime/clip/grammars/y4_storytime.js").exists()


def test_huashu_builtin_previews_are_animated_real_template_captures() -> None:
    from PIL import Image

    root = Path(__file__).resolve().parent.parent
    assets = root / "mona/skills/mona-motion/assets/huashu-motion"
    manifest = json.loads((assets / "previews/manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["previews"]) == 9
    for item in manifest["previews"]:
        assert not item["pageErrors"]
        assert item["meanFrameDifference"] > 0
        preview = assets / "previews" / item["styleId"].removeprefix("huashu-")
        with Image.open(preview / "poster.png") as image:
            assert image.size == (640, 360)
        with Image.open(preview / "motion.gif") as image:
            assert image.is_animated
            assert image.n_frames > 20
