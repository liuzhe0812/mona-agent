"""Regression tests for multi-agent profile collector attribution."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from mona.agent.partners import MONA_AGENT_ID, ConversationMetadata
from mona.distill.collectors.notes_collector import collect_notes_stats
from mona.distill.collectors.session_collector import collect_session_topics
from mona.distill.collectors.tool_call_collector import collect_tool_calls

AGENT_A = "com.example.agent-a"
AGENT_B = "com.example.agent-b"


def _write_session(
    workspace: Path,
    name: str,
    metadata: dict,
    messages: list[dict],
) -> None:
    sessions = workspace / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    lines = [
        {
            "_type": "metadata",
            "key": f"websocket:{name}",
            "created_at": "2026-08-31T09:00:00",
            "updated_at": "2026-08-31T12:00:00",
            "metadata": metadata,
        },
        *messages,
    ]
    (sessions / f"{name}.jsonl").write_text(
        "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n",
        encoding="utf-8",
    )


def _tool_call(call_id: str, name: str) -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": "{}"},
    }


def test_session_topics_accept_only_real_user_messages(tmp_path: Path) -> None:
    conversation = ConversationMetadata.room(
        [MONA_AGENT_ID, AGENT_A], title="协作房间"
    ).to_session_metadata()
    _write_session(
        tmp_path,
        "room",
        {"title": "协作房间", "conversation": conversation},
        [
            {
                "role": "user",
                "content": "真实用户主题",
                "author_type": "user",
                "author_id": "user-1",
                "message_type": "message",
            },
            {
                "role": "user",
                "content": "/help",
                "author_type": "user",
                "author_id": "user-1",
                "message_type": "message",
                "_command": True,
            },
            {
                "role": "user",
                "content": "UI 状态",
                "author_type": "user",
                "author_id": "user-1",
                "message_type": "message",
                "_ui_only": True,
            },
            {
                "role": "user",
                "content": "内部注入任务",
                "author_type": "user",
                "author_id": "user-1",
                "message_type": "message",
                "injected_event": "subagent_result",
            },
            {
                "role": "user",
                "content": "Agent 冒充用户",
                "author_type": "agent",
                "author_id": AGENT_A,
                "message_type": "message",
            },
            {
                "role": "assistant",
                "content": "回答",
                "author_type": "agent",
                "author_id": AGENT_A,
                "reasoning_content": "不可进入画像的内部推理",
                "tool_calls": [_tool_call("call-1", "read_file")],
            },
        ],
    )

    stats = collect_session_topics(tmp_path)

    assert stats.total_sessions == 1
    topic = stats.topics[0]
    assert topic.user_messages == "真实用户主题"
    assert topic.tools_used == ["read_file"]
    assert topic.conversation_type == "room"
    assert topic.agent_ids == [MONA_AGENT_ID, AGENT_A]
    assert "reasoning" not in topic.to_dict()
    assert "不可进入画像的内部推理" not in topic.user_messages


def test_session_topics_skip_hidden_rooms_and_support_legacy_sessions(tmp_path: Path) -> None:
    hidden = ConversationMetadata.room([MONA_AGENT_ID, AGENT_B], hidden=True)
    _write_session(
        tmp_path,
        "hidden-room",
        {"conversation": hidden.to_session_metadata()},
        [{"role": "user", "content": "后台任务文本"}],
    )
    _write_session(
        tmp_path,
        "legacy",
        {"title": "旧会话"},
        [
            {"role": "user", "content": "旧用户消息"},
            {"role": "assistant", "content": "旧助手回答"},
        ],
    )

    stats = collect_session_topics(tmp_path)

    assert stats.total_sessions == 1
    topic = stats.topics[0]
    assert topic.user_messages == "旧用户消息"
    assert topic.conversation_type == "direct"
    assert topic.direct_agent_id == MONA_AGENT_ID


def test_profile_advice_seed_is_not_a_user_profile_signal(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "advice-seed",
        {"title": "建议会话"},
        [
            {
                "role": "user",
                "content": "系统生成的起步请求",
                "origin": "profile_advice",
                "profile_advice_id": "advice-1",
                "timestamp": "2026-08-31T10:00:00+08:00",
            },
            {
                "role": "user",
                "content": "我补充一个真实目标",
                "timestamp": "2026-08-31T10:01:00+08:00",
            },
        ],
    )

    stats = collect_session_topics(tmp_path)

    assert stats.total_messages == 1
    assert stats.topics[0].user_messages == "我补充一个真实目标"


def test_tool_calls_are_attributed_by_agent_context_and_source(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "direct-partner",
        {"conversation": ConversationMetadata.direct(AGENT_A).to_session_metadata()},
        [
            {
                "role": "assistant",
                "content": "",
                "timestamp": "2026-08-31T10:00:00",
                "tool_calls": [_tool_call("direct-1", "web_search")],
            },
            {
                "role": "tool",
                "name": "web_search",
                "tool_call_id": "direct-1",
                "content": "ok",
                "timestamp": "2026-08-31T10:00:01",
            },
        ],
    )
    _write_session(
        tmp_path,
        "room-workflow",
        {
            "conversation": ConversationMetadata.room(
                [MONA_AGENT_ID, AGENT_A]
            ).to_session_metadata()
        },
        [
            {
                "role": "assistant",
                "author_type": "agent",
                "author_id": AGENT_A,
                "job_id": "job-1",
                "workflow_run_id": "run-1",
                "timestamp": "2026-08-31T11:00:00",
                "tool_calls": [_tool_call("workflow-1", "read_file")],
            },
            {
                "role": "tool",
                "name": "read_file",
                "tool_call_id": "workflow-1",
                "content": "Error: missing",
                "timestamp": "2026-08-31T11:00:01",
            },
        ],
    )
    _write_session(
        tmp_path,
        "hidden-room",
        {
            "conversation": ConversationMetadata.room(
                [MONA_AGENT_ID, AGENT_B], hidden=True
            ).to_session_metadata()
        },
        [
            {
                "role": "assistant",
                "author_type": "agent",
                "author_id": AGENT_B,
                "timestamp": "2026-08-31T12:00:00",
                "tool_calls": [_tool_call("hidden-1", "read_file")],
            }
        ],
    )
    _write_session(
        tmp_path,
        "cron-room",
        {"conversation": ConversationMetadata.direct(MONA_AGENT_ID).to_session_metadata()},
        [
            {
                "role": "assistant",
                "timestamp": "2026-08-31T13:00:00",
                "tool_calls": [_tool_call("cron-1", "web_search")],
            }
        ],
    )

    stats = collect_tool_calls(tmp_path)
    payload = stats.to_dict()

    assert stats.total_calls == 4
    assert stats.tool_success["web_search"] == {"success": 1, "total": 2}
    assert stats.tool_success["read_file"] == {"success": 0, "total": 2}
    assert stats.by_agent[AGENT_A]["total_calls"] == 2
    assert stats.by_agent[AGENT_B]["total_calls"] == 1
    assert stats.by_agent[MONA_AGENT_ID]["total_calls"] == 1
    assert stats.by_conversation_type["direct"]["total_calls"] == 2
    assert stats.by_conversation_type["room"]["total_calls"] == 2
    assert payload["tool_usage_scope"] == "agent_execution"
    assert payload["user_preference_tools"] == []

    workflow = next(item for item in stats.attributions if item["job_id"] == "job-1")
    assert workflow["agent_id"] == AGENT_A
    assert workflow["conversation_type"] == "room"
    assert workflow["source"] == "workflow"
    assert workflow["background"] is True

    hidden = next(item for item in stats.attributions if item["hidden"] is True)
    assert hidden["agent_id"] == AGENT_B
    assert hidden["background"] is True

    cron = next(item for item in stats.attributions if item["source"] == "background")
    assert cron["agent_id"] == MONA_AGENT_ID
    assert cron["hidden"] is False


def test_session_events_use_message_time_and_round_robin_sampling(tmp_path: Path) -> None:
    current = ConversationMetadata.direct(MONA_AGENT_ID, title="当前").to_session_metadata()
    for name, conversation, messages in [
        (
            "a",
            current,
            [
                {"role": "user", "content": "a-old", "timestamp": "2026-08-20T10:00:00+08:00"},
                {"role": "user", "content": "a-new", "timestamp": "2026-09-07T10:00:00+08:00"},
            ],
        ),
        (
            "b",
            ConversationMetadata.direct(MONA_AGENT_ID, title="B").to_session_metadata(),
            [{"role": "user", "content": "b-new", "timestamp": "2026-09-06T10:00:00+08:00"}],
        ),
        (
            "c",
            ConversationMetadata.direct(MONA_AGENT_ID, title="C").to_session_metadata(),
            [{"role": "user", "content": "c-new", "timestamp": "2026-09-05T10:00:00+08:00"}],
        ),
    ]:
        _write_session(tmp_path, name, {"conversation": conversation}, messages)

    stats = collect_session_topics(
        tmp_path,
        periods={
            "current": (
                datetime(2026, 8, 25, tzinfo=timezone.utc),
                datetime(2026, 9, 8, tzinfo=timezone.utc),
            ),
            "previous": (
                datetime(2026, 8, 1, tzinfo=timezone.utc),
                datetime(2026, 8, 25, tzinfo=timezone.utc),
            ),
        },
        max_sessions=2,
        max_messages=2,
        max_previous_messages=1,
    )

    assert stats.windows["current"]["total_messages"] == 3
    assert stats.windows["previous"]["total_messages"] == 1
    assert stats.total_messages == 4
    assert stats.windows["current"]["sampled_messages"] == 2
    assert stats.windows["previous"]["sampled_messages"] == 1
    refs = [event["ref"] for event in stats.message_events]
    assert len(refs) == len(set(refs))
    assert all(event["ref"].startswith("session-message:") for event in stats.message_events)
    assert {event["session_key"] for event in stats.message_events if event["window"] == "current"} == {
        "websocket:a",
        "websocket:b",
    }


def test_session_events_mark_unknown_time_and_truncation(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "timed",
        {"title": "截断"},
        [
            {"role": "user", "content": "无时间消息"},
            {
                "role": "user",
                "content": "x" * 100,
                "timestamp": "2026-09-07T10:00:00+08:00",
            },
        ],
    )
    stats = collect_session_topics(
        tmp_path,
        periods={
            "current": (
                datetime(2026, 9, 1, tzinfo=timezone.utc),
                datetime(2026, 9, 8, tzinfo=timezone.utc),
            )
        },
        max_message_chars=40,
    )
    assert stats.total_messages == 1
    assert stats.coverage["unknown_time_count"] == 1
    assert stats.message_events[0]["truncated"] is True


def test_notes_stats_deduplicate_keywords_and_sort_recent_records(tmp_path: Path) -> None:
    vault = tmp_path / "notes"
    (vault / "AI").mkdir(parents=True)
    (vault / "AI" / "old.md").write_text(
        "---\ntitle: Python API\ntags: [Python, api]\ncreatedAt: 2026-08-01T09:00:00+08:00\n---\nold",
        encoding="utf-8",
    )
    (vault / "AI" / "new.md").write_text(
        "---\ntitle: Python\ntags: [Python, rust]\ncreatedAt: 2026-09-01T09:00:00+08:00\n---\nnew",
        encoding="utf-8",
    )

    stats = collect_notes_stats(
        vault,
        since=datetime(2026, 8, 15, tzinfo=timezone.utc),
        until=datetime(2026, 9, 8, tzinfo=timezone.utc),
    )

    assert stats.total_notes == 1
    assert stats.recent_titles == ["Python"]
    assert stats.title_keywords == [
        {"keyword": "python", "count": 1},
        {"keyword": "rust", "count": 1},
    ]
    assert stats.records[0]["ref"].startswith("note:")
    assert stats.records[0]["relative_path"] == "AI/new.md"
