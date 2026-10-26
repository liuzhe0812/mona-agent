"""Subtitle timing and semantic motion plan contracts."""

import json

import pytest

from mona.video_timeline import (
    SUBTITLE_GROUPING_VERSION,
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
    assert track["groupingVersion"] == SUBTITLE_GROUPING_VERSION
    assert len(track["cues"]) == 2
    assert track["cues"][0]["startMs"] == 120
    assert track["cues"][1]["endMs"] == 3200
    assert track["audioHash"] == "audio-hash"


def test_provider_words_restore_script_punctuation_and_english_spacing_only_on_exact_alignment() -> None:
    narration = "AI 模型通过 5.5 倍权重，提高指标权重的比例。"
    words = [
        {"text": text, "startMs": index * 300, "endMs": index * 300 + 200}
        for index, text in enumerate(("AI", "模型", "通过", "5.5", "倍", "权重", "提高", "指标", "权重", "的", "比例"))
    ]
    track = build_subtitle_track(narration, 4_000, word_timings=words)

    assert [cue["text"] for cue in track["cues"]] == [
        "AI 模型通过 5.5 倍权重，",
        "提高指标权重的比例。",
    ]
    assert [word for cue in track["cues"] for word in cue["words"]] == words

    mismatch = build_subtitle_track(
        "这个比例很重要。",
        1_500,
        word_timings=[
            {"text": "这个", "startMs": 0, "endMs": 400},
            {"text": "比例也", "startMs": 410, "endMs": 800},
            {"text": "很重要", "startMs": 810, "endMs": 1_200},
        ],
    )
    assert "".join(cue["text"] for cue in mismatch["cues"]) == "这个比例也很重要"
    assert "。" not in "".join(cue["text"] for cue in mismatch["cues"])


def test_long_provider_sentence_fills_readable_lines_without_splitting_spoken_words() -> None:
    narration = "权重表示每项数据对选择结果的影响程度需要结合当前预算与业务目标综合判断。"
    assert 18 < len(narration.rstrip("。")) < 36
    words = []
    cursor = 300
    for index, character in enumerate(narration.rstrip("。")):
        words.append({"text": character, "startMs": cursor, "endMs": cursor + 80})
        cursor += 780 if index == 17 else 100

    track = build_subtitle_track(
        narration,
        cursor + 500,
        word_timings=words,
        max_chars=18,
    )
    cues = track["cues"]

    assert len(cues) == 2
    assert "".join(word["text"] for word in cues[0]["words"]) == narration[0:18]
    assert "".join(word["text"] for word in cues[1]["words"]) == narration[18:-1]
    assert all(len(cue["words"]) > 1 for cue in cues)
    assert cues[0]["words"][-1]["endMs"] < cues[1]["words"][0]["startMs"]
    assert "".join(cue["text"] for cue in cues) == narration
    assert [word for cue in cues for word in cue["words"]] == words


@pytest.mark.parametrize(
    ("prefix_words", "tail", "tail_start", "tail_end"),
    [
        (("权重", "会", "综合考虑", "各项指标", "对", "最终评价", "结果"), "的比例", 9_762, 10_212),
        (("产品界面", "通过", "真实操作", "展示", "用户", "如何", "配置"), "说明", 6_750, 7_188),
    ],
)
def test_long_weighted_and_product_phrases_do_not_orphan_provider_tail_words(
    prefix_words: tuple[str, ...], tail: str, tail_start: int, tail_end: int
) -> None:
    prefix = "".join(prefix_words)
    assert len(prefix) == 18
    narration = f"{prefix}{tail}。"
    words = [
        {"text": word, "startMs": index * 700, "endMs": index * 700 + 400}
        for index, word in enumerate(prefix_words)
    ]
    words.append({"text": tail, "startMs": tail_start, "endMs": tail_end})
    track = build_subtitle_track(narration, 12_000, word_timings=words)
    tail_cue = next(
        cue for cue in track["cues"] if any(word["text"] == tail for word in cue["words"])
    )

    assert len(tail_cue["words"]) > 1
    assert tail_cue["text"].endswith(f"{tail}。")
    assert "".join(cue["text"] for cue in track["cues"]) == narration
    assert [word for cue in track["cues"] for word in cue["words"]] == words


def test_short_complete_provider_sentence_is_not_forced_to_maximum_length() -> None:
    track = build_subtitle_track(
        "好。",
        900,
        word_timings=[{"text": "好", "startMs": 100, "endMs": 500}],
    )

    assert [cue["text"] for cue in track["cues"]] == ["好。"]
    assert track["cues"][0]["words"] == [{"text": "好", "startMs": 100, "endMs": 500}]


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
