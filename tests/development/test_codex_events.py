from mona.development.executors.codex_events import normalize_codex_event, thread_id


def test_user_message_echo_never_becomes_a_tool():
    params = {"threadId": "thread", "turnId": "turn", "item": {
        "id": "user-1", "type": "userMessage", "content": [{"type": "text", "text": "检查仓库"}],
    }}
    assert normalize_codex_event("item/started", params) is None
    assert normalize_codex_event("item/completed", params) is None


def test_never_surface_raw_reasoning_or_infer_success_from_command_exit():
    params = {"threadId": "thread", "turnId": "turn", "item": {
        "id": "secret", "type": "reasoning", "content": ["not-for-display"], "summary": ["检查项目结构"],
    }}
    reasoning = normalize_codex_event("item/completed", params)
    assert reasoning.type == "reasoning.completed"
    assert reasoning.payload == {"itemId": "secret", "text": "检查项目结构"}
    assert "not-for-display" not in str(reasoning)
    params["item"] = {"id": "cmd", "type": "commandExecution", "exitCode": 0, "aggregatedOutput": "ok"}
    event = normalize_codex_event("item/completed", params)
    assert event.type == "command.completed"
    assert event.native_turn_id == "turn"
    assert event.type != "run.completed"


def test_reasoning_lifecycle_has_only_item_identity_and_native_duration():
    params = {"threadId": "thread", "turnId": "turn", "item": {
        "id": "reasoning-1", "type": "reasoning", "content": ["PRIVATE"],
        "summary": ["检查构建脚本"], "signature": "PRIVATE SIGNATURE", "durationMs": 1250,
    }}
    started = normalize_codex_event("item/started", params)
    completed = normalize_codex_event("item/completed", params)

    assert started.type == "reasoning.started"
    assert started.payload == {"itemId": "reasoning-1"}
    assert completed.type == "reasoning.completed"
    assert completed.payload == {"itemId": "reasoning-1", "text": "检查构建脚本", "durationMs": 1250}
    assert "PRIVATE" not in str([started, completed])


def test_reasoning_without_native_duration_does_not_infer_one():
    event = normalize_codex_event("item/completed", {"item": {
        "id": "reasoning-1", "type": "reasoning", "durationMs": -1,
    }})

    assert event.type == "reasoning.completed"
    assert event.payload == {"itemId": "reasoning-1"}


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


def test_codex_public_summary_delta_keeps_summary_part_identity():
    event = normalize_codex_event("item/reasoning/summaryTextDelta", {
        "threadId": "thread", "turnId": "turn", "itemId": "thought", "summaryIndex": 2, "delta": "检查依赖",
    })
    assert event.type == "reasoning.delta"
    assert event.payload == {"itemId": "thought", "summaryIndex": 2, "delta": "检查依赖"}
    assert normalize_codex_event("item/reasoning/textDelta", {"itemId": "thought", "delta": "raw private"}) is None


def test_codex_usage_reports_last_request_and_runtime_window_without_changing_raw_usage():
    raw_usage = {"total": {"totalTokens": 900}, "last": {"totalTokens": 123}, "modelContextWindow": 272_000}
    event = normalize_codex_event("thread/tokenUsage/updated", {
        "threadId": "thread", "turnId": "turn", "tokenUsage": raw_usage,
    })

    assert event.type == "usage.updated"
    assert event.native_turn_id == "turn"
    assert event.payload == {
        "tokenUsage": raw_usage,
        "contextTokens": 123,
        "contextWindow": 272_000,
    }


def test_codex_usage_omits_unknown_or_invalid_context_values():
    event = normalize_codex_event("thread/tokenUsage/updated", {
        "tokenUsage": {"total": {"totalTokens": 50}, "last": {"totalTokens": True}, "modelContextWindow": 0},
    })

    assert event.payload == {"tokenUsage": {"total": {"totalTokens": 50}, "last": {"totalTokens": True}, "modelContextWindow": 0}}
