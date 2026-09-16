from __future__ import annotations

import json
from pathlib import Path

import pytest

from mona.agent.tools.deliver_file import _musician_score_delivery_error
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.music_score import MusicScoreTool, validate_abc

VALID_PIANO_ABC = """X:1
T:小练习
M:4/4
L:1/8
Q:1/4=96
K:C
V:RH clef=treble
CDEF GABc|cBAG FEDC|
V:LH clef=bass
C,2 E,2 G,2 C2|C,2 G,2 E,2 C2|
"""


def test_validate_abc_accepts_complete_two_staff_score() -> None:
    result = validate_abc(VALID_PIANO_ABC, expected_bars=2)

    assert result["ok"] is True
    assert result["issues"] == []
    assert result["summary"]["barCounts"] == {"RH": 2, "LH": 2}
    assert len(result["summary"]["sha256"]) == 64


def test_validate_abc_reports_measure_and_unsupported_repeat() -> None:
    malformed = VALID_PIANO_ABC.replace("CDEF GABc|", "CDEF|")
    repeated = VALID_PIANO_ABC.replace("CDEF GABc|", "CDEF|: GABc|")

    result = validate_abc(malformed)
    repeat_result = validate_abc(repeated)

    assert result["ok"] is False
    codes = {issue["code"] for issue in result["issues"]}
    assert "measure_duration_mismatch" in codes
    assert "unsupported_repeat" in {issue["code"] for issue in repeat_result["issues"]}


def test_validate_abc_rejects_internal_blank_lines_that_end_the_tune() -> None:
    result = validate_abc(VALID_PIANO_ABC.replace("K:C\n", "K:C\n\n"))

    assert result["ok"] is False
    assert "blank_line_terminates_tune" in {issue["code"] for issue in result["issues"]}


def test_validate_abc_rejects_writing_one_complete_voice_first() -> None:
    source = VALID_PIANO_ABC.replace(
        "CDEF GABc|cBAG FEDC|",
        "CDEF GABc|cBAG FEDC|CDEF GABc|cBAG FEDC|CDEF GABc|",
    )

    result = validate_abc(source)

    assert "voice_order_unsupported" in {issue["code"] for issue in result["issues"]}


def test_musician_cannot_deliver_an_invalid_abc_score(tmp_path: Path) -> None:
    invalid = tmp_path / "invalid.abc"
    invalid.write_text(VALID_PIANO_ABC.replace("K:C\n", "K:C\n\n"), encoding="utf-8")

    error = _musician_score_delivery_error(invalid, "com.mona.musician")

    assert error is not None
    assert "空行" in error
    assert _musician_score_delivery_error(invalid, "mona") is None


@pytest.mark.asyncio
async def test_music_score_tool_only_reads_workspace_abc_files(tmp_path: Path) -> None:
    score = tmp_path / "study.abc"
    score.write_text(VALID_PIANO_ABC, encoding="utf-8")
    tool = MusicScoreTool(workspace=tmp_path, allowed_dir=tmp_path)

    accepted = json.loads(await tool.execute("study.abc", expected_bars=2))
    rejected = json.loads(await tool.execute("study.txt"))

    assert accepted["ok"] is True
    assert rejected["issues"][0]["code"] == "invalid_file_type"


def test_music_score_tool_is_automatically_discoverable() -> None:
    assert MusicScoreTool in ToolLoader().discover()
