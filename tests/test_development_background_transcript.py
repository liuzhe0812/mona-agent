from __future__ import annotations

import pytest

from mona.webui.transcript import replay_transcript_to_ui_messages


def _background(identifier: str, text: str = "开发任务已完成") -> dict:
    return {
        "event": "background_message",
        "id": identifier,
        "_event_id": identifier,
        "text": text,
        "author_id": "mona",
    }


def _normal_rows(rows: list[dict]) -> list[dict]:
    return [
        {key: value for key, value in row.items() if key not in {"id", "createdAt", "sourceTranscriptIndex"}}
        for row in rows
        if not str(row["id"]).startswith("notice-")
    ]


@pytest.mark.parametrize(
    "events",
    [
        [
            {"event": "user", "text": "请继续", "task_id": "work-task"},
            {"event": "delta", "text": "正在", "task_id": "work-task"},
            {"event": "delta", "text": "处理"},
            {"event": "stream_end"},
            {"event": "turn_end", "task_id": "work-task", "latency_ms": 50},
        ],
        [
            {"event": "user", "text": "请继续", "task_id": "work-task"},
            {"event": "reasoning_delta", "text": "分析"},
            {"event": "reasoning_delta", "text": "问题"},
            {"event": "reasoning_end"},
            {"event": "delta", "text": "处理完成", "task_id": "work-task"},
            {"event": "turn_end", "task_id": "work-task"},
        ],
        [
            {"event": "user", "text": "请继续"},
            {"event": "reasoning_delta", "text": "分析"},
            {"event": "reasoning_delta", "text": "问题"},
            {"event": "reasoning_end"},
            {"event": "message", "text": "处理完成"},
            {"event": "turn_end"},
        ],
        [
            {"event": "user", "text": "选择预览"},
            {"event": "deliver_files", "files": [{"name": "preview.png", "mime": "image/png"}]},
            {"event": "message", "kind": "progress", "tool_events": [
                {"name": "ask_user_question", "phase": "end", "call_id": "question"},
            ]},
            {"event": "turn_end"},
        ],
    ],
)
def test_background_does_not_change_a_running_reply(events: list[dict]) -> None:
    with_background = [*events[:2], _background("notice-1"), *events[2:]]

    baseline = replay_transcript_to_ui_messages(events)
    actual = replay_transcript_to_ui_messages(with_background)

    assert _normal_rows(actual) == _normal_rows(baseline)
    notice = next(row for row in actual if row["id"] == "notice-1")
    assert notice["content"] == "开发任务已完成"
    assert notice["role"] == "assistant"
    assert notice["authorId"] == "mona"
    assert not {"taskId", "reasoning", "latencyMs", "tokenUsage"} & notice.keys()


def test_background_identity_deduplicates_without_reordering_other_turns() -> None:
    rows = replay_transcript_to_ui_messages([
        {"event": "user", "text": "任务一"},
        _background("notice-1", "第一次状态"),
        _background("notice-1", "重复的状态"),
        {"event": "message", "text": "第一轮回复"},
        {"event": "turn_end"},
        _background("notice-2", "第二次状态"),
        {"event": "user", "text": "任务二"},
        {"event": "message", "text": "第二轮回复"},
        {"event": "turn_end"},
    ])

    assert [(row["id"], row["content"]) for row in rows if row["id"].startswith("notice-")] == [
        ("notice-1", "第一次状态"),
        ("notice-2", "第二次状态"),
    ]
    assert [row["content"] for row in rows] == [
        "任务一", "第一次状态", "第一轮回复", "第二次状态", "任务二", "第二轮回复",
    ]


def test_delta_stream_identity_survives_background_and_reasoning_placeholder() -> None:
    rows = replay_transcript_to_ui_messages([
        {"event": "user", "text": "请继续"},
        {"event": "reasoning_delta", "text": "分析", "stream_id": "stream-1"},
        {"event": "reasoning_end", "stream_id": "stream-1"},
        {"event": "delta", "text": "正在", "stream_id": "stream-1"},
        _background("notice-1"),
        {"event": "delta", "text": "处理", "stream_id": "stream-1"},
        {"event": "stream_end", "stream_id": "stream-1"},
        {"event": "turn_end"},
    ])

    answer = next(row for row in rows if row["content"] == "正在处理")
    notice = next(row for row in rows if row["id"] == "notice-1")
    assert answer["reasoning"] == "分析"
    assert answer["streamId"] == "stream-1"
    assert "streamId" not in notice


def test_final_message_keeps_explicit_stream_identity_when_absorbing_reasoning() -> None:
    rows = replay_transcript_to_ui_messages([
        {"event": "user", "text": "请继续"},
        {"event": "reasoning_delta", "text": "分析"},
        {"event": "reasoning_end"},
        {"event": "message", "text": "处理完成", "stream_id": "stream-final"},
        {"event": "turn_end"},
    ])

    answer = next(row for row in rows if row["content"] == "处理完成")
    assert answer["reasoning"] == "分析"
    assert answer["streamId"] == "stream-final"


@pytest.mark.parametrize("include_delta_id", [False, True])
def test_reasoning_stream_identity_available_before_answer(include_delta_id: bool) -> None:
    reasoning = {"event": "reasoning_delta", "text": "分析"}
    if include_delta_id:
        reasoning["stream_id"] = "stream-1"
    events = [
        {"event": "user", "text": "请继续"},
        reasoning,
        _background("notice-1"),
        {"event": "reasoning_end", "stream_id": "stream-1"},
        {"event": "message", "text": "处理完成"},
        {"event": "turn_end"},
    ]

    if include_delta_id:
        partial = replay_transcript_to_ui_messages(events[:3])
        assert next(row for row in partial if row.get("reasoning") == "分析")["streamId"] == "stream-1"
    final = replay_transcript_to_ui_messages(events)
    answer = next(row for row in final if row["content"] == "处理完成")
    assert answer["reasoning"] == "分析"
    assert answer["streamId"] == "stream-1"
