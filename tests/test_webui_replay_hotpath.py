from __future__ import annotations

from typing import Any

import pytest

from mona.webui.transcript import replay_transcript_to_ui_messages


def _normalized_replay(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in message.items() if key not in {"id", "createdAt"}}
        for message in replay_transcript_to_ui_messages(lines)
    ]


def test_contiguous_deltas_keep_complete_content_and_latest_task_id() -> None:
    lines = [
        {"event": "user", "text": "hello", "task_id": "task-user"},
        {"event": "delta", "text": "A", "author_id": "agent-a", "task_id": "task-a"},
        {"event": "delta", "text": "B"},
        {"event": "delta", "text": "", "task_id": "task-b"},
        {"event": "delta", "text": "C"},
        {"event": "turn_end", "latency_ms": 12, "task_id": "task-b"},
    ]

    assert _normalized_replay(lines) == [
        {
            "authorType": "user",
            "content": "hello",
            "messageType": "message",
            "role": "user",
            "sourceTranscriptIndex": 0,
            "taskId": "task-user",
        },
        {
            "authorId": "agent-a",
            "authorType": "agent",
            "content": "ABC",
            "latencyMs": 12,
            "messageType": "message",
            "role": "assistant",
            "sourceTranscriptIndex": 5,
            "taskId": "task-b",
        },
    ]


def test_delta_files_tools_reasoning_and_final_message_match_replay_contract() -> None:
    lines = [
        {"event": "user", "text": "question"},
        {"event": "delta", "text": "part-1", "task_id": "task-a"},
        {
            "event": "deliver_files",
            "inline_media": False,
            "files": [
                {
                    "name": "report.txt",
                    "path": "report.txt",
                    "absolute_path": "C:/output/report.txt",
                },
            ],
        },
        {
            "event": "file_edit",
            "edits": [
                {
                    "call_id": "edit-1",
                    "tool": "write_file",
                    "path": "report.txt",
                    "status": "completed",
                },
            ],
        },
        {"event": "message", "kind": "progress", "text": "searching"},
        {"event": "reasoning_delta", "text": "thinking"},
        {"event": "reasoning_delta", "text": " more"},
        {"event": "reasoning_end"},
        {"event": "delta", "text": "part-2", "task_id": "task-b"},
        {"event": "message", "text": "final answer", "task_id": "task-b"},
        {"event": "turn_end", "task_id": "task-b"},
    ]

    assert _normalized_replay(lines) == [
        {
            "authorType": "user",
            "content": "question",
            "messageType": "message",
            "role": "user",
            "sourceTranscriptIndex": 0,
        },
        {
            "authorId": "mona",
            "authorType": "agent",
            "content": "part-1part-2",
            "messageType": "message",
            "role": "assistant",
            "sourceTranscriptIndex": 8,
            "taskId": "task-b",
        },
        {
            "activitySegmentId": "activity-1",
            "content": "",
            "fileEdits": [
                {
                    "call_id": "edit-1",
                    "path": "report.txt",
                    "status": "completed",
                    "tool": "write_file",
                },
            ],
            "kind": "trace",
            "role": "tool",
            "traces": [],
        },
        {
            "activitySegmentId": "activity-2",
            "content": "searching",
            "kind": "trace",
            "role": "tool",
            "traces": ["searching"],
        },
        {
            "activitySegmentId": "activity-3",
            "authorId": "mona",
            "authorType": "agent",
            "content": "final answer",
            "deliveredFiles": [
                {
                    "absolute_path": "C:/output/report.txt",
                    "name": "report.txt",
                    "path": "report.txt",
                },
            ],
            "media": [],
            "messageType": "message",
            "reasoning": "thinking more",
            "role": "assistant",
            "sourceTranscriptIndex": 10,
            "taskId": "task-b",
        },
    ]


def test_stream_end_and_unfinished_deltas_keep_separate_messages() -> None:
    lines = [
        {"event": "user", "text": "hello"},
        {"event": "delta", "text": "first"},
        {"event": "delta", "text": " chunk"},
        {"event": "stream_end"},
        {"event": "delta", "text": "next"},
    ]

    assert _normalized_replay(lines) == [
        {
            "authorType": "user",
            "content": "hello",
            "messageType": "message",
            "role": "user",
            "sourceTranscriptIndex": 0,
        },
        {
            "authorId": "mona",
            "authorType": "agent",
            "content": "first chunk",
            "messageType": "message",
            "role": "assistant",
            "sourceTranscriptIndex": 2,
        },
        {
            "authorId": "mona",
            "authorType": "agent",
            "content": "next",
            "messageType": "message",
            "role": "assistant",
            "sourceTranscriptIndex": 4,
        },
    ]


def test_source_transcript_index_still_identifies_branch_boundary() -> None:
    lines = [
        {"event": "user", "text": "first"},
        {"event": "ignored"},
        {"event": "delta", "text": "one", "task_id": "task-1"},
        {"event": "delta", "text": " two", "task_id": "task-1"},
        {"event": "turn_end", "task_id": "task-1"},
        {"event": "user", "text": "second"},
        {"event": "delta", "text": "later", "task_id": "task-2"},
        {"event": "turn_end", "task_id": "task-2"},
    ]

    assistants = [
        message
        for message in _normalized_replay(lines)
        if message.get("role") == "assistant"
    ]
    branch_end = assistants[0]["sourceTranscriptIndex"]

    assert assistants[0]["content"] == "one two"
    assert branch_end == 4
    assert lines[: branch_end + 1][-1]["event"] == "turn_end"
    assert lines[branch_end + 1]["event"] == "user"


def test_replay_ids_are_stable_across_replay_and_appended_turns() -> None:
    first_turn = [
        {"event": "user", "text": "first"},
        {"event": "delta", "text": "answer", "task_id": "task-1"},
        {"event": "turn_end", "task_id": "task-1"},
    ]
    first_ids = [message["id"] for message in replay_transcript_to_ui_messages(first_turn)]
    replayed_ids = [message["id"] for message in replay_transcript_to_ui_messages(first_turn)]
    extended = first_turn + [
        {"event": "user", "text": "second"},
        {"event": "delta", "text": "another answer", "task_id": "task-2"},
        {"event": "turn_end", "task_id": "task-2"},
    ]
    extended_messages = replay_transcript_to_ui_messages(extended)
    extended_ids = [message["id"] for message in extended_messages]

    assert replayed_ids == first_ids
    assert extended_ids[: len(first_ids)] == first_ids
    assert len(extended_ids) == len(set(extended_ids))


def _style_sample_files() -> list[dict[str, Any]]:
    return [
        {
            "path": "style-samples/A.jpg",
            "absolute_path": "C:/output/style-samples/A.jpg",
            "name": "A.jpg",
            "mime": "image/jpeg",
        },
        {
            "path": "style-samples/B.png",
            "absolute_path": "C:/output/style-samples/B.png",
            "name": "B.png",
            "mime": "image/png",
        },
    ]


def _augment_sample_media(paths: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "url": f"/signed/{path.rsplit('/', 1)[-1]}?v=1",
            "name": path.rsplit("/", 1)[-1],
            "kind": "image",
        }
        for path in paths
    ]


def _completed_tool_record(name: str) -> dict[str, Any]:
    return {
        "event": "message",
        "kind": "progress",
        "text": "",
        "tool_events": [
            {
                "version": 1,
                "phase": "end",
                "call_id": f"call-{name}",
                "name": name,
                "arguments": {},
                "result": "{}",
                "error": None,
                "files": [],
            },
        ],
    }


def test_question_preview_stays_at_delivery_before_later_activity() -> None:
    samples = _style_sample_files()
    ppt = {
        "path": "exports/product.pptx",
        "absolute_path": "C:/output/exports/product.pptx",
        "name": "product.pptx",
        "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
    lines = [
        {"event": "user", "text": "Make a presentation"},
        _completed_tool_record("skill_asset_copy"),
        {"event": "deliver_files", "presentation": "question_preview", "files": samples},
        _completed_tool_record("office"),
        {"event": "delta", "text": "Completed"},
        {"event": "deliver_files", "files": [ppt]},
        {"event": "turn_end"},
    ]
    expected_media = [
        {"url": "/signed/A.jpg?v=1", "name": "A.jpg", "kind": "image"},
        {"url": "/signed/B.png?v=1", "name": "B.png", "kind": "image"},
    ]

    before_turn_end = replay_transcript_to_ui_messages(
        lines[:3], augment_user_media=_augment_sample_media,
    )
    preview = next(message for message in before_turn_end if message.get("media") == expected_media)
    assert (preview["role"], preview["kind"], preview["traces"]) == ("tool", "trace", [])

    messages = replay_transcript_to_ui_messages(lines, augment_user_media=_augment_sample_media)
    preview_index = next(
        i for i, message in enumerate(messages) if message.get("media") == expected_media
    )
    before_index = next(
        i for i, message in enumerate(messages) if "skill_asset_copy()" in message.get("traces", [])
    )
    after_index = next(
        i for i, message in enumerate(messages) if "office()" in message.get("traces", [])
    )
    final_index = next(
        i for i, message in enumerate(messages) if message.get("content") == "Completed"
    )
    assert before_index < preview_index < after_index < final_index
    assert messages[preview_index]["traces"] == []
    assert messages[final_index]["deliveredFiles"] == [ppt]
    assert not messages[final_index].get("media")


def test_legacy_question_preview_precedes_question_without_turn_end() -> None:
    samples = _style_sample_files()
    lines = [
        {"event": "user", "text": "Make a presentation"},
        {"event": "deliver_files", "files": samples},
        _completed_tool_record("ask_user_question"),
        _completed_tool_record("office"),
        {"event": "delta", "text": "Completed"},
        {"event": "turn_end"},
    ]
    expected_media = [
        {"url": "/signed/A.jpg?v=1", "name": "A.jpg", "kind": "image"},
        {"url": "/signed/B.png?v=1", "name": "B.png", "kind": "image"},
    ]

    before_turn_end = replay_transcript_to_ui_messages(
        lines[:3], augment_user_media=_augment_sample_media,
    )
    preview_index = next(
        i for i, message in enumerate(before_turn_end) if message.get("media") == expected_media
    )
    question_index = next(
        i for i, message in enumerate(before_turn_end)
        if "ask_user_question()" in message.get("traces", [])
    )
    preview = before_turn_end[preview_index]
    assert (preview["role"], preview["kind"], preview["traces"]) == ("tool", "trace", [])
    assert preview_index < question_index

    messages = replay_transcript_to_ui_messages(lines, augment_user_media=_augment_sample_media)
    preview = next(message for message in messages if message.get("media") == expected_media)
    final = next(message for message in messages if message.get("content") == "Completed")
    assert preview["traces"] == []
    assert not final.get("deliveredFiles")
    assert not final.get("media")


@pytest.mark.parametrize(
    ("include_document", "next_tool"),
    [(False, "office"), (True, "ask_user_question")],
)
def test_ordinary_deliveries_are_not_mistaken_for_question_previews(
    include_document: bool, next_tool: str,
) -> None:
    files = _style_sample_files()[:1]
    if include_document:
        files.append({
            "path": "exports/product.pptx",
            "absolute_path": "C:/output/exports/product.pptx",
            "name": "product.pptx",
            "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        })
    lines = [
        {"event": "user", "text": "Make a presentation"},
        {"event": "deliver_files", "files": files},
        _completed_tool_record(next_tool),
        {"event": "delta", "text": "Completed"},
        {"event": "turn_end"},
    ]

    messages = replay_transcript_to_ui_messages(lines, augment_user_media=_augment_sample_media)
    final = next(message for message in messages if message.get("content") == "Completed")
    assert final["deliveredFiles"] == files
    assert final["media"] == [{"url": "/signed/A.jpg?v=1", "name": "A.jpg", "kind": "image"}]
    assert not any(message.get("role") == "tool" and message.get("media") for message in messages)
