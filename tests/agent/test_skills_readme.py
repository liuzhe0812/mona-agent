"""Tests verifying that the skills README matches the actual skill directories.

The README.md in mona/skills/ should list every skill directory that contains
a SKILL.md file, and should not list any skill that does not exist.
"""

from __future__ import annotations

import re
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parents[2] / "mona" / "skills"
README_PATH = SKILLS_DIR / "README.md"


def _actual_skill_dirs() -> set[str]:
    """Return the set of skill directory names that contain a SKILL.md."""
    return {
        p.parent.name
        for p in SKILLS_DIR.glob("*/SKILL.md")
    }


def _readme_listed_skills() -> set[str]:
    """Extract skill names from the README's Available Skills table."""
    content = README_PATH.read_text(encoding="utf-8")
    # Match table rows like: | `skill-name` | description |
    return set(re.findall(r"^\|\s*`([a-z0-9_-]+)`", content, re.MULTILINE))


class TestSkillsReadmeMatchesDirectory:
    def test_all_actual_skills_are_listed_in_readme(self) -> None:
        """Every skill directory with a SKILL.md should be listed in README."""
        actual = _actual_skill_dirs()
        listed = _readme_listed_skills()
        missing = actual - listed
        assert not missing, (
            f"Skills exist on disk but are missing from README.md: {sorted(missing)}. "
            f"Update mona/skills/README.md to include them."
        )

    def test_all_readme_listed_skills_exist_on_disk(self) -> None:
        """Every skill listed in README should have a SKILL.md on disk."""
        actual = _actual_skill_dirs()
        listed = _readme_listed_skills()
        phantom = listed - actual
        assert not phantom, (
            f"README.md lists skills that do not exist on disk: {sorted(phantom)}. "
            f"Remove them from mona/skills/README.md."
        )
