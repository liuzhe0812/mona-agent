from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.tools.context import ToolContext
from mona.agent.tools.deliver_file import _musician_guitar_tab_delivery_error
from mona.agent.tools.guitar_tab import GuitarTabTool, validate_guitar_tab
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry

VALID_GUITAR_TAB = r'''\title "卡农练习"
\artist "Mona Musician"
\tempo 70
\track "Acoustic Guitar"
\staff {tabs}
\tuning (E4 B3 G3 D3 A2 E2)
.
\ts (4 4)
(0.1 1.2 0.3 2.4 3.5).4 {ch "C"} 0.1.8 1.2.8 0.3.8 2.4.8 3.5.4 |
(3.1 0.2 0.3 0.4 2.5 3.6).4 {ch "G"} 3.1.8 0.2.8 0.3.8 0.4.8 3.6.4 |
'''


def test_validate_guitar_tab_accepts_dedicated_six_string_score() -> None:
    result = validate_guitar_tab(VALID_GUITAR_TAB, expected_bars=2)

    assert result["ok"] is True
    assert result["issues"] == []
    assert result["summary"]["barCount"] == 2
    assert result["summary"]["stringCount"] == 6


def test_validate_guitar_tab_reports_timing_and_missing_tab_staff() -> None:
    source = VALID_GUITAR_TAB.replace(r"\staff {tabs}", r"\staff {score}").replace(
        "3.5.4 |",
        "3.5.8 |",
        1,
    )

    result = validate_guitar_tab(source)

    codes = {issue["code"] for issue in result["issues"]}
    assert "missing_tab_staff" in codes
    assert "measure_duration_mismatch" in codes


def test_validate_guitar_tab_rejects_two_frets_on_one_string() -> None:
    source = VALID_GUITAR_TAB.replace(
        "(0.1 1.2 0.3 2.4 3.5).4",
        "(0.1 3.1 1.2 0.3 2.4 3.5).4",
        1,
    )

    result = validate_guitar_tab(source)

    assert "duplicate_string" in {issue["code"] for issue in result["issues"]}


def _effect_tab(first_bar: str, second_bar: str = "0.1.4 0.2.4 0.3.4 0.4.4") -> str:
    return r'''\title "效果练习"
\track "Guitar"
\staff {tabs}
\tuning (E4 B3 G3 D3 A2 E2)
.
\ts (4 4)
''' + first_bar + " |\n" + second_bar + " |\n"


def test_validate_guitar_tab_accepts_supported_note_and_beat_effects() -> None:
    source = _effect_tab(
        "0.1{h}.8 2.1.8 3.2{sl}.8 5.2.8 0.3{ss}.4 5.3.4",
        '(0.4{pm} 0.5{pm}).4 {ch "D5" sd} '
        '3.3{lr}.4 5.3{v}.4 7.3{b (0 4 0)}.4 {su}',
    )

    result = validate_guitar_tab(source, expected_bars=2)

    assert result["ok"] is True
    assert result["issues"] == []


def test_validate_guitar_tab_counts_single_augmentation_dot() -> None:
    source = _effect_tab('0.1.4 {ch "G5" d} 0.2.8 0.3.2')

    result = validate_guitar_tab(source, expected_bars=2)

    assert result["ok"] is True
    assert result["issues"] == []


def test_fingerstyle_preserves_sustained_melody_over_moving_bass() -> None:
    source = _effect_tab(
        '(0.1{ac} 3.5).4 {ch "C" dy mf} (0.1{t} 2.4).4 3.2.4 1.2.4',
        '1.2{t}.2 {dy p} 0.2.4 1.2.4',
    )
    assert validate_guitar_tab(source, expected_bars=2)["ok"]


@pytest.mark.parametrize("previous", ["r.4", "1.1.4", "0.2.4", "x.1.4"])
def test_fingerstyle_rejects_ties_without_matching_previous_string_and_fret(previous: str) -> None:
    result = validate_guitar_tab(_effect_tab(f"{previous} 0.1{{t}}.4 0.2.4 0.3.4"))
    assert "invalid_tie" in {issue["code"] for issue in result["issues"]}


def test_fingerstyle_rejects_unknown_dynamic_level() -> None:
    result = validate_guitar_tab(_effect_tab("0.1.1 {dy loud}"))
    assert "unsupported_effect" in {issue["code"] for issue in result["issues"]}


@pytest.mark.parametrize("effect", ["p", "dd", "tu 3", "unknown", ""])
def test_validate_guitar_tab_rejects_unknown_or_bass_pop_effects(effect: str) -> None:
    source = _effect_tab(f"0.1.4 {{{effect}}} 0.2.4 0.3.4 0.4.4")

    result = validate_guitar_tab(source, expected_bars=2)

    assert result["ok"] is False
    assert "unsupported_effect" in {issue["code"] for issue in result["issues"]}


def test_validate_guitar_tab_requires_note_effects_before_duration() -> None:
    source = _effect_tab("0.1.4 {h} 0.2.4 0.3.4 0.4.4")

    result = validate_guitar_tab(source, expected_bars=2)

    assert result["ok"] is False
    assert "unsupported_effect" in {issue["code"] for issue in result["issues"]}


def test_validate_guitar_tab_requires_integer_bend_curve() -> None:
    source = _effect_tab("0.1{b (0 2.5)}.4 0.2.4 0.3.4 0.4.4")

    result = validate_guitar_tab(source, expected_bars=2)

    assert result["ok"] is False
    assert "unsupported_effect" in {issue["code"] for issue in result["issues"]}


def test_musician_cannot_deliver_invalid_guitar_tab(tmp_path: Path) -> None:
    invalid = tmp_path / "broken.atex"
    invalid.write_text(VALID_GUITAR_TAB.replace("3.5.4 |", "3.5.8 |", 1), encoding="utf-8")

    error = _musician_guitar_tab_delivery_error(invalid, "com.mona.musician")

    assert error is not None
    assert "时值" in error
    assert _musician_guitar_tab_delivery_error(invalid, "mona") is None


@pytest.mark.asyncio
async def test_guitar_tab_tool_only_reads_workspace_atex_files(tmp_path: Path) -> None:
    tab = tmp_path / "study.atex"
    tab.write_text(VALID_GUITAR_TAB, encoding="utf-8")
    tool = GuitarTabTool(workspace=tmp_path, allowed_dir=tmp_path)

    accepted = json.loads(await tool.execute("study.atex", expected_bars=2))
    rejected = json.loads(await tool.execute("study.abc"))

    assert accepted["ok"] is True
    assert rejected["issues"][0]["code"] == "invalid_file_type"


def test_guitar_tab_tool_is_automatically_discoverable() -> None:
    assert GuitarTabTool in ToolLoader().discover()


def test_guitar_tab_tool_is_not_registered_for_mona(tmp_path: Path) -> None:
    context = ToolContext(
        config=SimpleNamespace(restrict_to_workspace=True),
        workspace=str(tmp_path),
        agent_id="mona",
    )
    registry = ToolRegistry()

    registered = ToolLoader(test_classes=[GuitarTabTool]).load(
        context,
        registry,
        scope="core",
    )

    assert "guitar_tab" not in registered


@pytest.mark.asyncio
async def test_musician_manifest_registers_and_executes_guitar_tab_in_subagent_scope(
    tmp_path: Path,
) -> None:
    manifest = json.loads(
        (
            Path(__file__).parents[2]
            / "expert-library"
            / "agents"
            / "com.mona.musician"
            / "agent.json"
        ).read_text(encoding="utf-8")
    )
    tab = tmp_path / "study.atex"
    tab.write_text(VALID_GUITAR_TAB, encoding="utf-8")
    config = SimpleNamespace(
        restrict_to_workspace=True,
        exec=SimpleNamespace(sandbox=False),
    )
    context = ToolContext(
        config=config,
        workspace=str(tmp_path),
        agent_id=manifest["id"],
    )
    registry = ToolRegistry()

    registered = ToolLoader().load(
        context,
        registry,
        scope="subagent",
        tool_allowlist=manifest["toolAllowlist"],
    )

    assert "guitar_tab" in registered
    result = json.loads(
        await registry.execute("guitar_tab", {"path": "study.atex", "expected_bars": 2})
    )
    assert result["ok"] is True
