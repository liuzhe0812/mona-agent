import tomllib
from pathlib import Path


def test_base_wheel_includes_standard_skill_dependency_manifests() -> None:
    root = Path(__file__).resolve().parent.parent
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))

    assert "mona/skills/**/*.toml" in project["tool"]["hatch"]["build"]["include"]
    for skill in ("mona-docx", "mona-video", "skill-creator"):
        assert (root / "mona" / "skills" / skill / "pyproject.toml").is_file()
    assert not (root / "mona" / "skills" / "mona-ppt").exists()
