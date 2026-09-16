from __future__ import annotations

import json
import re
from pathlib import Path

from mona.agent.partners import AgentRegistry
from mona.agent.tools.guitar_tab import validate_guitar_tab
from mona.agent.tools.loader import ToolLoader

AGENT_ID = "com.mona.musician"
ROOT = Path(__file__).parents[2] / "expert-library" / "agents" / AGENT_ID


def test_musician_package_loads_with_dedicated_guitar_tab_tool() -> None:
    registry = AgentRegistry(
        builtin_dir=ROOT.parent,
        installed_dir=ROOT.parent / "missing",
        package_store_dir=ROOT.parent / "missing-packages",
    )

    definition = registry.require(AGENT_ID)
    assert definition.display_name == "音乐人"
    assert definition.package_version == "1.3.2"
    assert definition.can_delegate is False
    assert definition.skills == ["skills/music-compose", "skills/guitar-tab"]
    assert "guitar_tab" in definition.tool_allowlist
    assert "music_score" in definition.tool_allowlist
    assert any(cls.__name__ == "GuitarTabTool" for cls in ToolLoader().discover())
    assert any(cls.__name__ == "MusicScoreTool" for cls in ToolLoader().discover())


def test_musician_guitar_tab_skill_teaches_the_dedicated_format() -> None:
    skill_root = ROOT / "skills" / "guitar-tab"

    assert (skill_root / "SKILL.md").is_file()
    for reference in ("tab-syntax.md", "fingering.md", "strumming.md"):
        assert (skill_root / "references" / reference).is_file(), reference
    syntax = (skill_root / "references" / "tab-syntax.md").read_text(encoding="utf-8")
    assert ".atex" in syntax
    assert "\\staff {tabs}" in syntax
    assert "% mona-tab" in syntax
    assert "不要写 ABC" in syntax
    example = syntax.split("```text\n", 1)[1].split("```", 1)[0]
    assert validate_guitar_tab(example, expected_bars=2)["ok"] is True


def test_musician_package_declares_both_dedicated_score_tools() -> None:
    package = json.loads((ROOT / "package-manifest.json").read_text(encoding="utf-8"))

    assert package["agentId"] == AGENT_ID
    assert package["runtimePacks"] == []
    assert package["requiredTools"] == ["guitar_tab", "music_score"]
    assert "调用 `music_score` 检查每次修改后的文件" in (ROOT / "skills/music-compose/SKILL.md").read_text(encoding="utf-8")
    assert (ROOT / "avatar.webp").is_file()


def test_guitar_practice_examples_pass_delivery_validation() -> None:
    examples = (ROOT / "skills/guitar-tab/references/examples.md").read_text(encoding="utf-8")
    sources = re.findall(r"```text\n(.*?)```", examples, re.DOTALL)
    assert len(sources) == 4
    for source in sources:
        result = validate_guitar_tab(source, expected_bars=2)
        assert result["ok"], result["issues"]


def test_complete_guitar_arrangements_pass_delivery_validation() -> None:
    examples = (ROOT / "skills/guitar-tab/references/complete-examples.md").read_text(encoding="utf-8")
    sources = re.findall(r"```text\n(.*?)```", examples, re.DOTALL)
    assert len(sources) == 2
    for source in sources:
        result = validate_guitar_tab(source, expected_bars=16)
        assert result["ok"], result["issues"]
