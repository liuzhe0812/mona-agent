"""Regression checks for compact, lossless Skill catalog rendering."""

from pathlib import Path

from mona.agent.skills import SkillsLoader


def _loader(tmp_path: Path, builtin_skills_dir: Path) -> SkillsLoader:
    loader = SkillsLoader(tmp_path, builtin_skills_dir=builtin_skills_dir)
    loader.workspace_skills = tmp_path / "private-skills"
    return loader


def test_explicit_short_description_only_compacts_catalog(tmp_path: Path) -> None:
    builtin = tmp_path / "builtins"
    short_skill = builtin / "short"
    full_skill = builtin / "full"
    short_skill.mkdir(parents=True)
    full_skill.mkdir(parents=True)
    short_skill.joinpath("SKILL.md").write_text(
        "---\n"
        "name: short\n"
        "description: Full trigger and workflow description.\n"
        "short_description: Compact trigger.\n"
        "---\n"
        "# Full instructions\n",
        encoding="utf-8",
    )
    full_skill.joinpath("SKILL.md").write_text(
        "---\n"
        "name: full\n"
        "description: Keep this complete description.\n"
        "---\n"
        "# Full instructions\n",
        encoding="utf-8",
    )

    loader = _loader(tmp_path, builtin)
    summary = loader.build_skills_summary()

    assert "- **short** — Compact trigger." in summary
    assert "Full trigger and workflow description." not in summary
    assert "- **full** — Keep this complete description." in summary
    assert "Full trigger and workflow description." in loader.load_skill("short")


def test_builtin_catalog_keeps_all_names_and_trigger_phrases(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    builtin = repo_root / "mona" / "skills"
    loader = _loader(tmp_path, builtin)
    summary = loader.build_skills_summary()

    for entry in loader.list_skills(filter_unavailable=False):
        assert f"**{entry['name']}**" in summary

    for phrase in (
        '"create PPT"',
        '"make presentation"',
        '"生成PPT"',
        '"制作演示文稿"',
        '"create video"',
        '"制作视频"',
    ):
        assert phrase in summary
