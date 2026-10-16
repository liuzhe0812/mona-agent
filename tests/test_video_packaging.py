import hashlib
import json
import tomllib
from fnmatch import fnmatch
from pathlib import Path


def test_base_wheel_includes_standard_skill_dependency_manifests() -> None:
    root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))

    assert "mona/skills/**/*.toml" in project["tool"]["hatch"]["build"]["include"]
    for skill in ("mona-docx", "mona-video", "skill-creator"):
        assert (root / "mona" / "skills" / skill / "pyproject.toml").is_file()
    assert not (root / "mona" / "skills" / "mona-ppt").exists()


def test_video_creative_resources_are_selected_for_the_wheel() -> None:
    root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = project["tool"]["hatch"]["build"]["include"]
    references = root / "mona/skills/mona-video/references"
    required = [references / "huashu/LICENSE", *sorted((references / "examples").glob("*.tsx"))]
    assert len(required) > 1
    for path in required:
        assert path.is_file()
        assert any(fnmatch(path.relative_to(root).as_posix(), pattern) for pattern in patterns), path


def test_copied_dashi_resources_keep_source_hashes_and_package_license() -> None:
    root = Path(__file__).resolve().parent.parent
    assets = root / "mona/skills/mona-video/assets/dashi-animationstyle"
    provenance = json.loads((assets / "provenance.json").read_text(encoding="utf-8"))
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = project["tool"]["hatch"]["build"]["include"]
    for item in provenance["includedFiles"]:
        path = assets / item["path"]
        data = path.read_bytes()
        assert len(data) == item["sizeBytes"]
        assert hashlib.sha256(data).hexdigest() == item["sha256"], path
        assert any(fnmatch(path.relative_to(root).as_posix(), pattern) for pattern in patterns), path
    assert not (assets / "examples/token/口播.wav").exists()
