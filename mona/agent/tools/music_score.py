"""Restricted ABC score validation for music-composer agents."""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

from mona.agent.tools.base import tool_parameters
from mona.agent.tools.filesystem import _FsTool
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema

_HEADER_RE = re.compile(r"^([A-Z]):(.*)$")
_VOICE_RE = re.compile(r"^[A-Za-z0-9_-]+(?:\s+.*)?$")
_METER_RE = re.compile(r"^(\d+)\s*/\s*(\d+)$")
_UNIT_RE = re.compile(r"^1\s*/\s*(\d+)$")
_KEY_RE = re.compile(r"^[A-G](?:b|#)?(?:m|maj|min|mix|dor|phr|lyd|loc)?$")
_TEMPO_RE = re.compile(r"^(?:\d+\s*/\s*\d+\s*=\s*)?\d+$")
_TOKEN_RE = re.compile(
    r"(?:\[[A-Ga-gzZxX^_=,']+\]|[\^_=]{0,2}[A-Ga-gzZxX][,']*)(?:\d+(?:/\d+)?|/\d+|/)?"
)
_DECORATION_RE = re.compile(r"![A-Za-z-]+!|\"[^\"\r\n]*\"")


@dataclass(frozen=True)
class ScoreIssue:
    code: str
    message: str
    line: int | None = None
    column: int | None = None
    voice: str | None = None
    measure: int | None = None

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.line is not None:
            result["line"] = self.line
        if self.column is not None:
            result["column"] = self.column
        if self.voice is not None:
            result["voice"] = self.voice
        if self.measure is not None:
            result["measure"] = self.measure
        return result


def _duration(token: str) -> Fraction:
    suffix = re.search(r"(\d+(?:/\d+)?|/\d+|/)$", token)
    if not suffix:
        return Fraction(1)
    value = suffix.group(1)
    if value == "/":
        return Fraction(1, 2)
    if value.startswith("/"):
        return Fraction(1, int(value[1:]))
    if "/" in value:
        top, bottom = value.split("/", 1)
        return Fraction(int(top), int(bottom))
    return Fraction(int(value))


def _parse_voice(raw: str) -> str:
    return raw.strip().split(maxsplit=1)[0]


def validate_abc(source: str, *, expected_bars: int | None = None) -> dict[str, Any]:
    """Validate Mona's intentionally small ABC subset without changing score text."""
    issues: list[ScoreIssue] = []
    headers: dict[str, tuple[str, int]] = {}
    declared_voices: set[str] = set()
    voices: dict[str, Fraction] = defaultdict(Fraction)
    measures: dict[str, int] = defaultdict(int)
    current_voice = "default"
    body_started = False
    voice_order_reported = False
    meter: Fraction | None = None
    unit = Fraction(1, 8)

    lines = source.splitlines()
    last_content_line = max(
        (index for index, value in enumerate(lines, start=1) if value.strip()),
        default=0,
    )
    seen_tune_start = False
    for line_number, raw_line in enumerate(lines, start=1):
        if raw_line.startswith("X:"):
            seen_tune_start = True
        if seen_tune_start and not raw_line.strip() and line_number < last_content_line:
            issues.append(ScoreIssue(
                "blank_line_terminates_tune",
                "ABC 文件内部不能有空行；空行会提前结束乐曲。",
                line_number,
                1,
            ))
            continue
        line = raw_line.split("%", 1)[0].rstrip()
        if not line.strip():
            continue
        header = _HEADER_RE.match(line)
        if header and not body_started:
            name, value = header.groups()
            headers[name] = (value.strip(), line_number)
            if name == "M":
                match = _METER_RE.match(value.strip())
                if not match:
                    issues.append(ScoreIssue("invalid_meter", "M: 必须是如 4/4 的拍号。", line_number, 3))
                else:
                    numerator, denominator = map(int, match.groups())
                    if not (1 <= numerator <= 12 and denominator in {1, 2, 4, 8, 16}):
                        issues.append(ScoreIssue("unsupported_meter", "首版只支持 1–12/1、2、4、8、16 拍号。", line_number, 3))
                    else:
                        meter = Fraction(numerator, denominator)
            elif name == "L":
                match = _UNIT_RE.match(value.strip())
                if not match:
                    issues.append(ScoreIssue("invalid_unit_length", "L: 必须是如 1/8 的单位时值。", line_number, 3))
                else:
                    denominator = int(match.group(1))
                    if denominator not in {1, 2, 4, 8, 16, 32}:
                        issues.append(ScoreIssue("unsupported_unit_length", "首版只支持 1/1 到 1/32 的单位时值。", line_number, 3))
                    else:
                        unit = Fraction(1, denominator)
            elif name == "K" and not _KEY_RE.match(value.strip()):
                issues.append(ScoreIssue("invalid_key", "K: 不是支持的调号。", line_number, 3))
            elif name == "Q" and not _TEMPO_RE.match(value.strip()):
                issues.append(ScoreIssue("invalid_tempo", "Q: 必须是如 90 或 1/4=90 的速度。", line_number, 3))
            elif name == "V" and not _VOICE_RE.match(value.strip()):
                issues.append(ScoreIssue("invalid_voice", "V: 声部名称只能包含字母、数字、下划线和连字符。", line_number, 3))
            elif name == "V":
                current_voice = _parse_voice(value)
                declared_voices.add(current_voice)
                measures[current_voice] += 0
            continue

        if header and header.group(1) == "V":
            current_voice = _parse_voice(header.group(2))
            if not current_voice:
                issues.append(ScoreIssue("invalid_voice", "V: 缺少声部名称。", line_number, 3))
            else:
                declared_voices.add(current_voice)
                measures[current_voice] += 0
                completed = [measures[voice] for voice in declared_voices]
                if (
                    len(completed) > 1
                    and max(completed) - min(completed) > 4
                    and not voice_order_reported
                ):
                    issues.append(ScoreIssue(
                        "voice_order_unsupported",
                        "双声部必须按最多四小节的等长片段交替书写，不能先写完整的一个声部。",
                        line_number,
                        1,
                        current_voice,
                    ))
                    voice_order_reported = True
            continue

        body_started = True
        if any(marker in line for marker in (":|", "|:", "[1", "[2")):
            issues.append(ScoreIssue("unsupported_repeat", "首版不支持反复跳转和第一、第二结尾。", line_number, 1, current_voice))
            continue
        if "&" in line or "{" in line or "}" in line:
            issues.append(ScoreIssue("unsupported_syntax", "首版不支持叠置声部或装饰音。", line_number, 1, current_voice))
            continue

        music = _DECORATION_RE.sub("", line)
        start = 0
        for segment in re.split(r"(\|(?:\]|\|)?)", music):
            if not segment:
                continue
            if segment.startswith("|"):
                if meter is not None and voices[current_voice] * unit != meter:
                    issues.append(ScoreIssue(
                        "measure_duration_mismatch",
                        f"本小节时值为 {voices[current_voice] * unit}，应为 {meter}。",
                        line_number,
                        start + 1,
                        current_voice,
                        measures[current_voice] + 1,
                    ))
                measures[current_voice] += 1
                voices[current_voice] = Fraction()
                start += len(segment)
                continue
            index = 0
            while index < len(segment):
                if segment[index].isspace() or segment[index] in "()":
                    index += 1
                    continue
                matched = _TOKEN_RE.match(segment, index)
                if not matched:
                    issues.append(ScoreIssue("unsupported_syntax", "不支持的 ABC 记谱语法。", line_number, start + index + 1, current_voice, measures[current_voice] + 1))
                    break
                token = matched.group(0)
                try:
                    voices[current_voice] += _duration(token)
                except (ValueError, ZeroDivisionError):
                    issues.append(ScoreIssue("invalid_duration", "音符时值无效。", line_number, start + index + 1, current_voice, measures[current_voice] + 1))
                    break
                index = matched.end()
            start += len(segment)

        if len(declared_voices) > 1 and not voice_order_reported:
            completed = [measures[voice] for voice in declared_voices]
            if max(completed) - min(completed) > 4:
                issues.append(ScoreIssue(
                    "voice_order_unsupported",
                    "双声部必须按最多四小节的等长片段交替书写，不能先写完整的一个声部。",
                    line_number,
                    1,
                    current_voice,
                ))
                voice_order_reported = True

    for required in ("X", "T", "M", "L", "K"):
        if required not in headers:
            issues.append(ScoreIssue("missing_header", f"缺少必要头字段 {required}:。"))
    if not body_started:
        issues.append(ScoreIssue("missing_music", "乐谱没有音符内容。"))
    for voice, duration in voices.items():
        if duration:
            issues.append(ScoreIssue("unterminated_measure", "最后一个小节必须以小节线结束，且时值完整。", voice=voice, measure=measures[voice] + 1))
    if expected_bars is not None:
        for voice, count in measures.items():
            if count != expected_bars:
                issues.append(ScoreIssue("bar_count_mismatch", f"声部共有 {count} 小节，应为 {expected_bars}。", voice=voice))
    if len(set(measures.values())) > 1:
        issues.append(ScoreIssue("voice_length_mismatch", "各声部的小节数不一致。"))

    return {
        "ok": not issues,
        "issues": [issue.as_dict() for issue in issues],
        "summary": {
            "sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "voices": sorted(measures),
            "barCounts": dict(measures),
            "lineCount": len(lines),
        },
    }


@tool_parameters(
    tool_parameters_schema(
        path=StringSchema("Workspace-relative path to the UTF-8 .abc score."),
        expected_bars=IntegerSchema(description="Expected bar count when the request specifies one.", minimum=1, maximum=256, nullable=True),
        required=["path"],
    )
)
class MusicScoreTool(_FsTool):
    """Validate the supported ABC score subset in the active workspace."""

    _scopes = {"core", "subagent"}
    agent_allowlist = frozenset({"com.mona.musician"})

    @property
    def name(self) -> str:
        return "music_score"

    @property
    def description(self) -> str:
        return "Validate a workspace .abc score before delivery. Returns exact ABC subset errors, voice/bar counts, and a SHA-256 binding for the checked content."

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, path: str, expected_bars: int | None = None, **kwargs: Any) -> str:
        try:
            score_path = self._resolve(path)
        except (OSError, PermissionError, ValueError) as exc:
            return json.dumps({"ok": False, "issues": [{"code": "path_not_allowed", "message": str(exc)}]})
        if score_path.suffix.lower() != ".abc":
            return json.dumps({"ok": False, "issues": [{"code": "invalid_file_type", "message": "只接受 .abc 乐谱文件。"}]}, ensure_ascii=False)
        try:
            source = score_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return json.dumps({"ok": False, "issues": [{"code": "file_not_found", "message": "乐谱文件不存在。"}]}, ensure_ascii=False)
        except UnicodeDecodeError:
            return json.dumps({"ok": False, "issues": [{"code": "invalid_encoding", "message": "乐谱必须为 UTF-8 文本。"}]}, ensure_ascii=False)
        return json.dumps(validate_abc(source, expected_bars=expected_bars), ensure_ascii=False)
