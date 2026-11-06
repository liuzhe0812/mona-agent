"""Shared ordinary-Work recovery preserves evidence without replaying tools."""
from __future__ import annotations

import copy
from datetime import datetime

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.tools.registry import ToolRegistry
from mona.session.checkpoint_recovery import restore_checkpoint_messages
from mona.session.manager import Session


def _call(call_id: str, name: str = "write_file") -> dict:
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}


def _assistant(*call_ids: str, text: str = "正在继续处理。") -> dict:
    return {"role": "assistant", "content": text, "tool_calls": [_call(value) for value in call_ids]}


def _result(call_id: str, text: str = "已核实完成。") -> dict:
    return {"role": "tool", "tool_call_id": call_id, "name": "write_file", "content": text}


def _session(*messages: dict) -> Session:
    return Session(key="websocket:recovery", messages=copy.deepcopy(list(messages)),
                   metadata={"owner_marker": "unchanged"})


def test_recorded_completed_unknown_and_not_started_outcomes_remain_distinct():
    original = {"role": "user", "content": "完成三个操作。", "timestamp": "2026-11-05T10:00:00+08:00",
                "author_type": "user", "author_id": "user-account"}
    session = _session(original)
    checkpoint = {
        "assistant_message": _assistant("done", "unknown", "not-started"),
        "completed_tool_results": [_result("done")],
        "pending_tool_calls": [_call("unknown"), _call("not-started")],
        "started_tool_call_ids": ["done", "unknown"],
    }
    retained = copy.deepcopy(checkpoint)

    assert restore_checkpoint_messages(session, checkpoint)
    assert session.messages[0] == original
    assert checkpoint == retained
    assert [message["tool_call_id"] for message in session.messages if message["role"] == "tool"] == [
        "done", "unknown", "not-started",
    ]
    assert session.messages[2]["content"] == "已核实完成。"
    assert "TOOL_OUTCOME_UNKNOWN" in session.messages[3]["content"]
    assert "Do not retry blindly" in session.messages[3]["content"]
    assert "TOOL_NOT_STARTED" in session.messages[4]["content"]
    for message in session.messages[1:]:
        assert message["author_type"] == "agent" and message["author_id"] == "mona"
        assert datetime.fromisoformat(message["timestamp"])
    assert session.metadata["owner_marker"] == "unchanged"


def test_retained_suffix_and_repeated_restore_do_not_duplicate_call_ids():
    older = _assistant("older")
    completed = _result("older")
    current = _assistant("new-a", "new-b")
    session = _session({"role": "user", "content": "继续已开始的任务。"},
                       {**older, "timestamp": "old-time", "author_id": "mona"},
                       {**completed, "timestamp": "old-time", "author_id": "mona"})
    retained = copy.deepcopy(session.messages)
    checkpoint = {
        "completed_messages": [older, completed],
        "assistant_message": current,
        "completed_tool_results": [_result("new-a"), _result("new-b")],
    }

    assert restore_checkpoint_messages(session, checkpoint)
    once = copy.deepcopy(session.messages)
    assert session.messages[:len(retained)] == retained
    assert [message["tool_call_id"] for message in session.messages if message["role"] == "tool"] == [
        "older", "new-a", "new-b",
    ]
    assert restore_checkpoint_messages(session, checkpoint)
    assert session.messages == once


@pytest.mark.parametrize("started", [None, ["legacy-call"]])
def test_dispatched_or_legacy_pending_write_is_unknown_and_never_executed(tmp_path, monkeypatch, started):
    marker = tmp_path / "kept.txt"
    marker.write_text("original bytes", encoding="utf-8")
    session = _session({"role": "user", "content": "修改文件。"})
    checkpoint = {"assistant_message": _assistant("legacy-call"), "pending_tool_calls": [_call("legacy-call")]}
    if started is not None:
        checkpoint["started_tool_call_ids"] = started
    def forbidden(*_args, **_kwargs):
        pytest.fail("Recovery projection must not access the filesystem or execute tools")
    with monkeypatch.context() as scoped:
        scoped.setattr("builtins.open", forbidden)
        scoped.setattr(ToolRegistry, "execute", forbidden)
        assert restore_checkpoint_messages(session, checkpoint)
    assert marker.read_text(encoding="utf-8") == "original bytes"
    assert "TOOL_OUTCOME_UNKNOWN" in session.messages[-1]["content"]


def test_native_execution_is_sanitized_and_attached_to_retained_assistant():
    assistant = {"role": "assistant", "content": "最后一条已保存回复。", "timestamp": "kept-time"}
    session = _session({"role": "user", "content": "继续。"}, assistant)
    checkpoint = {
        "assistant_message": {"role": "assistant", "content": "最后一条已保存回复。"},
        "native_work": {
            "executor": "codex", "native_session_id": "native-session", "native_turn_id": "native-turn",
            "status": "unexpected-status", "token": "must-not-be-restored",
            "calls": [{"id": "native-call", "name": "native_write", "path": "/workspace/result.txt",
                       "status": "running", "api_key": "must-not-be-restored"}],
        },
    }
    original_checkpoint = copy.deepcopy(checkpoint)

    assert restore_checkpoint_messages(session, checkpoint)
    assert len(session.messages) == 2 and session.messages[-1]["timestamp"] == "kept-time"
    native = session.messages[-1]["native_work"]
    assert native == {
        "executor": "codex", "native_session_id": "native-session", "native_turn_id": "native-turn",
        "status": "unknown", "calls": [{"id": "native-call", "name": "native_write",
                                           "path": "/workspace/result.txt", "status": "unknown"}],
    }
    assert checkpoint == original_checkpoint


def test_native_only_checkpoint_preserves_a_safe_unconfirmed_history_marker():
    session = _session({"role": "user", "content": "写入结果。"})
    assert restore_checkpoint_messages(session, {"native_work": {"executor": "codex", "status": "running"}})
    restored = session.messages[-1]
    assert restored["role"] == "assistant" and "不要重放" in restored["content"]
    assert restored["native_work"]["status"] == "running"
    assert restored["author_id"] == "mona"


def test_final_response_recovery_updates_the_shared_ui_summary_without_erasing_prior_metadata():
    session = _session({"role": "user", "content": "需要结果。"})
    checkpoint = {"assistant_message": {"role": "assistant", "content": "部分结果已经保存。",
                                         "timestamp": "2026-11-05T10:01:00+08:00"}}
    assert restore_checkpoint_messages(session, checkpoint)
    assert session.ui_summary()["preview"] == "部分结果已经保存。"
    assert session.ui_summary()["preview_at"] == "2026-11-05T10:01:00+08:00"
    assert session.metadata["owner_marker"] == "unchanged"


@pytest.mark.parametrize("checkpoint", [None, [], "not a checkpoint"])
def test_absent_or_non_checkpoint_data_does_not_change_session(checkpoint):
    session = _session({"role": "user", "content": "已有用户输入。"})
    original = copy.deepcopy(session)
    assert restore_checkpoint_messages(session, checkpoint) is False
    assert session == original


def test_desktop_entry_delegates_the_same_projection_and_owns_only_its_metadata_cleanup():
    checkpoint = {"assistant_message": _assistant("pending-write"),
                  "pending_tool_calls": [_call("pending-write")], "started_tool_call_ids": []}
    session = _session({"role": "user", "content": "当前任务。"})
    session.metadata.update({AgentLoop._RUNTIME_CHECKPOINT_KEY: copy.deepcopy(checkpoint),
                             AgentLoop._PENDING_USER_TURN_KEY: True})
    ordinary = AgentLoop.__new__(AgentLoop)
    assert ordinary._restore_runtime_checkpoint(session)
    assert session.metadata["owner_marker"] == "unchanged"
    assert AgentLoop._RUNTIME_CHECKPOINT_KEY not in session.metadata
    assert AgentLoop._PENDING_USER_TURN_KEY not in session.metadata
    assert "TOOL_NOT_STARTED" in session.messages[-1]["content"]
    unchanged = copy.deepcopy(session)
    assert ordinary._restore_runtime_checkpoint(session) is False
    assert session == unchanged
