"""Hosted fan-out consumes the existing desktop event contracts without executing tools."""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.desktop_wire import DesktopWire, _Peer
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles

OWNER, OTHER = "a" * 64, "b" * 64
SID, RID = "a" * 32, "b" * 32


class Socket:
    closed = False

    def __init__(self):
        self.events = []

    async def send_json(self, value):
        self.events.append(value)

    async def send_str(self, value):
        self.events.append(json.loads(value))


@pytest.fixture
def bound_wire(tmp_path):
    root = tmp_path / "state"
    if os.name == "nt":
        root = Path("\\\\?\\" + str(root))
    root.mkdir()
    config = HostedWorkConfig(state_dir=str(root), models={"qwen": {"label": "Qwen", "model": "fixture"}})
    store = WorkStore(root / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="qwen", text="fixture input"))

    async def identity(token):
        assert token == "fixture-token"
        return OWNER

    service = SimpleNamespace(config=config, store=store, auth=SimpleNamespace(identity=identity))
    state = DesktopStore(service, TenantFiles(config, store.session))
    state.set(OWNER, "run:" + RID, {"input_id": "input-1", "frame": {"input_id": "input-1", "task_id": "task-1"}})
    wire = DesktopWire(service, state)
    peer = _Peer(Socket(), OWNER, "fixture-token", "client", {SID})
    wire._peers.add(peer)
    try:
        yield wire, state, peer
    finally:
        state.close()
        store.close()


async def publish(wire, kind, data):
    wire.service.store.event(OWNER, RID, kind, data)
    await wire.on_run_event(OWNER, wire.service.store.run(OWNER, RID), kind, data)


async def test_context_and_file_edit_events_keep_shared_shape_and_stream(bound_wire):
    wire, state, peer = bound_wire
    await publish(wire, "delta", {"text": "开始。"})
    usage = {"context_tokens": 435, "context_window_tokens": 1000000, "context_model": "qwen"}
    await publish(wire, "progress", {"kind": "context_usage", "token_usage": usage})
    for active in (True, False):
        await publish(wire, "progress", {"kind": "context_compacting", "active": active})
    edit = {"version": 1, "call_id": "write-1", "tool": "write_file", "path": "notes.md",
            "absolute_path": "/workspace/notes.md", "phase": "end", "added": 3, "deleted": 0,
            "approximate": False, "status": "done"}
    await publish(wire, "progress", {"kind": "file_edit", "edits": [edit]})
    assert next(item for item in peer.socket.events if item["event"] == "context_usage") == {
        "event": "context_usage", "chat_id": SID, "token_usage": usage,
        "task_id": "task-1", "turn_id": RID, "input_id": "input-1"}
    assert [item["context_compacting"] for item in peer.socket.events if "context_compacting" in item] == [True, False]
    assert next(item for item in peer.socket.events if item["event"] == "file_edit")["edits"] == [edit]
    assert wire._streams[(OWNER, RID)] == (1, True)
    records = [item for item, _ in state.records(OWNER, SID)]
    assert not any(item["event"] == "context_usage" for item in records)
    assert any(item["event"] == "file_edit" for item in records)
    assert any(item.get("fileEdits") == [edit] for item in state.history(OWNER, SID)["messages"])

    forged = {**edit, "absolute_path": "/workspace/../other-account/notes.md"}
    with pytest.raises(WorkError):
        await publish(wire, "progress", {"kind": "file_edit", "edits": [forged]})
    failed = {**edit, "phase": "error", "status": "error", "error": "private host details"}
    await publish(wire, "progress", {"kind": "file_edit", "edits": [failed]})
    assert "private host" not in json.dumps(peer.socket.events)


@pytest.mark.parametrize("has_final", [True, False])
async def test_finish_displays_final_context_usage_without_mutating_cumulative_usage(bound_wire, has_final):
    wire, state, peer = bound_wire
    cumulative = {"prompt_tokens": 5000, "completion_tokens": 500}
    final = {"prompt_tokens": 1200, "completion_tokens": 80, "context_tokens": 1280}
    result = {"content": "完成。", "usage": cumulative, **({"final_usage": final} if has_final else {})}
    wire.service.store.finish(OWNER, RID, "completed", result)
    run = wire.service.store.run(OWNER, RID)
    await wire.on_run_finish(OWNER, run, result)
    for event in ("message", "turn_end"):
        assert next(item for item in peer.socket.events if item["event"] == event)["token_usage"] == (
            final if has_final else cumulative)
    assert wire.service.store.run(OWNER, RID)["result"]["usage"] == cumulative
    assert next(item for item, _ in state.records(OWNER, SID) if item["event"] == "turn_end")["token_usage"] == (
        final if has_final else cumulative)


async def test_plan_and_goal_snapshots_restore_latest_without_replaying_transcript(bound_wire):
    wire, state, peer = bound_wire
    plan = {"task_id": "task-1", "revision": 1, "source": "ai", "steps": [
        {"id": "step_1", "step": "整理资料", "status": "in_progress"}]}
    await publish(wire, "desktop", {"event": "task_plan", "task_plan": plan})
    plan = {**plan, "revision": 2, "steps": [{**plan["steps"][0], "status": "completed"}]}
    await publish(wire, "desktop", {"event": "task_plan", "task_plan": plan})
    goal = {"active": True, "objective": "完成文档", "ui_summary": "文档"}
    await publish(wire, "desktop", {"event": "goal_state", "goal_state": goal})
    assert not any(item["event"] in {"task_plan", "goal_state"} for item, _ in state.records(OWNER, SID))
    peer.socket.events.clear()
    await wire._attach(peer, SID)
    assert next(item for item in peer.socket.events if item["event"] == "task_plan") == {
        "event": "task_plan", "chat_id": SID, "task_plan": plan}
    assert next(item for item in peer.socket.events if item["event"] == "goal_state") == {
        "event": "goal_state", "chat_id": SID, "goal_state": goal}

    # A reconnect after another turn starts must not resurrect the previous task plan.
    wire.service.store.finish(OWNER, RID, "completed", {"content": "完成。"})
    wire.service.store.create_run(OWNER, SID, NewTurn(request_id="c" * 32, model_id="qwen", text="new task"))
    peer.socket.events.clear()
    await wire._attach(peer, SID)
    assert not any(item["event"] == "task_plan" for item in peer.socket.events)
    assert next(item for item in peer.socket.events if item["event"] == "goal_state")["goal_state"] == goal


async def test_task_state_rejects_other_chat_turn_task_and_owner_bindings(bound_wire):
    wire, state, peer = bound_wire
    plan = {"task_id": "task-1", "revision": 1, "steps": []}
    event = {"event": "task_plan", "task_plan": plan}
    for forged in ({**event, "chat_id": "c" * 32}, {**event, "turn_id": "c" * 32},
                   {**event, "input_id": "other-input"},
                   {**event, "task_plan": {**plan, "task_id": "other-task"}}):
        with pytest.raises(WorkError) as rejected:
            await publish(wire, "desktop", forged)
        assert rejected.value.code == "protocol_error"
    assert state.get(OWNER, "task_plan:" + SID) is None
    with pytest.raises(WorkError) as foreign:
        await wire.on_run_event(OTHER, wire.service.store.run(OWNER, RID), "desktop", event)
    assert foreign.value.status == 404
    state.set(OWNER, "goal_state:" + SID, {"run_id": RID, "snapshot": {
        "event": "goal_state", "chat_id": "c" * 32, "goal_state": {"active": False}}})
    with pytest.raises(WorkError) as restored:
        await wire._attach(peer, SID)
    assert restored.value.code == "protocol_error"


async def test_widget_streaming_is_transient_and_never_displays_unvalidated_code(bound_wire):
    wire, state, peer = bound_wire
    widget = {"id": "widget-1", "title": "图形", "code": "", "loadingMessages": ["正在绘制"], "status": "streaming"}
    await publish(wire, "widget", widget)
    assert next(item for item in peer.socket.events if item["event"] == "widget")["widget"] == widget
    assert not any(item["event"] == "widget" for item, _ in state.records(OWNER, SID))
    code = '<svg viewBox="0 0 680 80"><text x="10" y="30">图形</text></svg>'
    with pytest.raises(WorkError):
        await publish(wire, "widget", {**widget, "code": code})
    await publish(wire, "widget", {**widget, "code": code, "status": "complete"})
    assert sum(item["event"] == "widget" for item, _ in state.records(OWNER, SID)) == 1
    assert len([item for item in state.history(OWNER, SID)["messages"] if item.get("kind") == "widget"]) == 1


async def test_question_snapshots_and_error_ack_survive_unrelated_controller(bound_wire):
    wire, _, peer = bound_wire
    wire.controller = SimpleNamespace(questions=SimpleNamespace())
    await wire._attach(peer, SID)
    assert next(item for item in peer.socket.events if item["event"] == "user_questions")["requests"] == []
    await wire._dispatch(peer, {"type": "answer_user_question", "chat_id": SID,
                               "request_id": "answer-1", "question_id": "question-1", "answers": []})
    result = peer.socket.events[-1]
    assert result["event"] == "answer_user_question_result" and result["ok"] is False
    assert result["request_id"] == "answer-1" and result["code"] == "question_unavailable"


def test_history_restores_appended_input_ids_from_the_source_record(bound_wire):
    _, state, _ = bound_wire
    for index, record in enumerate((
        {"event": "message", "text": "上一轮回答。"},
        {"event": "user", "text": "追加一项", "input_id": "appended-input-1"},
        {"event": "message", "kind": "progress", "text": "正在整理"},
        {"event": "user", "text": "还有一项", "input_id": "appended-input-2"},
    )):
        state.append(OWNER, SID, record, "fixture:" + str(index))
    users = [item for item in state.history(OWNER, SID)["messages"] if item["role"] == "user"]
    assert [item["id"] for item in users] == ["appended-input-1", "appended-input-2"]
    assert [item["sourceTranscriptIndex"] for item in users] == [1, 3]
