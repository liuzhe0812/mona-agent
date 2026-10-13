"""Subtitle timing and semantic motion plan contracts."""

import json

import pytest

from mona.video_timeline import (
    VideoTimelineError,
    build_motion_plan,
    build_subtitle_track,
    split_subtitle_text,
    subtitle_cues_to_srt,
    subtitle_cues_to_vtt,
    summarize_motion_plan,
    validate_motion_plan,
    validate_subtitle_track,
    write_timeline_json,
)


def test_subtitle_text_splits_sentences_and_long_clauses() -> None:
    parts = split_subtitle_text(
        "第一句话说明背景。第二句话比较长，需要拆成适合屏幕阅读的多个片段！",
        max_chars=12,
    )
    assert parts[0] == "第一句话说明背景。"
    assert all(0 < len(item) <= 12 for item in parts)
    assert "".join(parts).replace(" ", "") == (
        "第一句话说明背景。第二句话比较长，需要拆成适合屏幕阅读的多个片段！"
    )


def test_estimated_subtitles_fill_scene_duration_without_claiming_precision() -> None:
    track = build_subtitle_track("先解释问题。再给出方案。最后总结。", 6000)
    assert track["timingSource"] == "estimated"
    assert track["cues"][0]["startMs"] == 0
    assert track["cues"][-1]["endMs"] == 6000
    assert all(cue["words"] == [] for cue in track["cues"])
    validate_subtitle_track(track)


def test_provider_word_boundaries_are_grouped_into_cues() -> None:
    track = build_subtitle_track(
        "效率提升百分之七十二。系列风格保持一致。",
        5000,
        word_timings=[
            {"text": "效率提升", "startMs": 120, "endMs": 700},
            {"text": "百分之七十二。", "startMs": 720, "endMs": 1550},
            {"text": "系列风格", "startMs": 1900, "endMs": 2450},
            {"text": "保持一致。", "startMs": 2470, "endMs": 3200},
        ],
        audio_hash="audio-hash",
    )
    assert track["timingSource"] == "provider-boundary"
    assert len(track["cues"]) == 2
    assert track["cues"][0]["startMs"] == 120
    assert track["cues"][1]["endMs"] == 3200
    assert track["audioHash"] == "audio-hash"


def test_acoustic_alignment_source_and_confidence_are_not_mislabeled() -> None:
    track = build_subtitle_track(
        "第一句。第二句。",
        2400,
        word_timings=[
            {"text": "第一句。", "startMs": 0, "endMs": 900},
            {"text": "第二句。", "startMs": 1200, "endMs": 2200},
        ],
        timing_source="acoustic-sentence-alignment",
        alignment_confidence="high",
    )
    assert track["timingSource"] == "acoustic-sentence-alignment"
    assert track["alignmentConfidence"] == "high"


@pytest.mark.parametrize(
    ("role", "expected_target"),
    [
        ("cover", "visual"),
        ("content", "body"),
        ("data", "metric.0"),
        ("comparison", "comparison.0"),
        ("process", "step.0"),
        ("outro", "brand"),
    ],
)
def test_motion_plan_uses_scene_role_and_subtitle_cues(
    role: str, expected_target: str
) -> None:
    track = build_subtitle_track("先讲重点。再解释细节。最后总结。", 6000)
    plan = build_motion_plan(
        {"index": 2, "role": role},
        track,
        allowed_effects=("fade-rise", "stagger-rise", "soft-pulse", "cross-fade"),
        intensity="standard",
    )
    assert plan["sceneIndex"] == 2
    assert plan["scriptHash"] == track["sourceTextHash"]
    assert any(beat["target"] == expected_target for beat in plan["beats"])
    assert all(0 <= beat["startMs"] < beat["endMs"] <= 6000 for beat in plan["beats"])
    validate_motion_plan(
        plan,
        allowed_effects=("fade-rise", "stagger-rise", "soft-pulse", "cross-fade"),
    )
    assert summarize_motion_plan(plan)


def test_timeline_validation_rejects_overlap_and_unsafe_targets() -> None:
    track = build_subtitle_track("第一句。第二句。", 3000)
    track["cues"][1]["startMs"] = track["cues"][0]["endMs"] - 1
    with pytest.raises(VideoTimelineError):
        validate_subtitle_track(track)

    valid_track = build_subtitle_track("第一句。第二句。", 3000)
    plan = build_motion_plan({"index": 1, "role": "content"}, valid_track)
    plan["beats"][0]["target"] = "title<script>"
    with pytest.raises(VideoTimelineError):
        validate_motion_plan(plan)


def test_timeline_json_is_written_atomically(tmp_path) -> None:
    track = build_subtitle_track("一句可以显示的字幕。", 1800)
    target = tmp_path / "audio" / "scene_01.timing.json"
    write_timeline_json(target, track)
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["sourceTextHash"] == track["sourceTextHash"]
    assert not list(target.parent.glob("*.tmp"))


def test_subtitle_cues_export_to_srt_and_vtt() -> None:
    cues = [
        {"startMs": 120, "endMs": 1_550, "text": "第一句字幕。"},
        {"startMs": 61_000, "endMs": 62_345, "text": "第二句字幕。"},
    ]
    srt = subtitle_cues_to_srt(cues)
    vtt = subtitle_cues_to_vtt(cues)
    assert "00:00:00,120 --> 00:00:01,550" in srt
    assert "00:01:01,000 --> 00:01:02,345" in srt
    assert vtt.startswith("WEBVTT\n")
    assert "00:00:00.120 --> 00:00:01.550" in vtt


def test_provider_rounding_overlap_does_not_abort_narration_subtitles():
    track = build_subtitle_track("第一句。第二句。", 2200, word_timings=[
        {"text": "第一句。", "startMs": 0, "endMs": 1001},
        {"text": "第二句。", "startMs": 1000, "endMs": 2000},
    ])
    assert track["timingSource"] == "provider-boundary"
    assert track["cues"][0]["endMs"] == track["cues"][1]["startMs"] == 1000
    assert track["cues"][0]["words"][0]["endMs"] == 1001
    assert "".join(cue["text"] for cue in track["cues"]) == "第一句。第二句。"
