from mona.development.executors.codex_events import normalize_codex_event, thread_id


def test_never_surface_raw_reasoning_or_infer_success_from_command_exit():
    params = {"threadId": "thread", "turnId": "turn", "item": {
        "id": "secret", "type": "reasoning", "content": ["not-for-display"], "summary": ["not-required"],
    }}
    assert normalize_codex_event("item/completed", params) is None
    params["item"] = {"id": "cmd", "type": "commandExecution", "exitCode": 0, "aggregatedOutput": "ok"}
    event = normalize_codex_event("item/completed", params)
    assert event.type == "command.completed"
    assert event.native_turn_id == "turn"
    assert event.type != "run.completed"


def test_final_message_is_snapshot_not_second_text_delta():
    event = normalize_codex_event("item/completed", {"threadId": "t", "turnId": "r", "item": {
        "type": "agentMessage", "id": "message-1", "text": "Complete message",
    }})
    assert event.type == "agent.message.completed"
    assert event.payload["replaceDelta"] is True
    assert event.payload["itemId"] == "message-1"


def test_file_change_has_honest_attribution_and_proposed_is_not_applied():
    params = {"threadId": "t", "turnId": "r", "item": {
        "type": "fileChange", "id": "f", "status": "inProgress", "changes": [],
    }}
    before = normalize_codex_event("item/started", params)
    after = normalize_codex_event("item/completed", params)
    assert before.type == "file.change_proposed"
    assert after.type == "file.changed"
    assert "not_exclusive" in after.payload["attribution"]


def test_unknown_terminal_status_not_reported_completed_and_bad_owner_ignored():
    event = normalize_codex_event("turn/completed", {"threadId": "t", "turn": {"id": "r", "status": "newStatus"}})
    assert event.type == "run.unknown"
    assert thread_id("thread/started", {"thread": "invalid"}) is None
