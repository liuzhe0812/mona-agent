"""Test-only NDJSON process peer. No model, credentials, network or real CLI.

Exercises production pipes and adapter scheduling against independent v2 wire
shapes. It is not evidence of upstream binary compatibility or model quality.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

lock = threading.Lock()
threads: dict[str, dict] = {}
turns: dict[str, dict] = {}
awaiting: dict[str, tuple[str, str]] = {}
host_calls: dict[str, tuple[str, str, str]] = {}
held = None
counter = 0
root = Path.cwd()
trace_path = root / "peer-trace.jsonl"
mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
state_path = root / "peer-state.json"
auth_ready = mode != "no_auth"
auth_type = "apiKey" if auth_ready else None
login_count = 0

if state_path.exists():
    saved_threads = json.loads(state_path.read_text(encoding="utf8")).get("threads", {})
    if isinstance(saved_threads, dict):
        threads.update(saved_threads)
        turns.update({turn["id"]: turn for thread in threads.values()
                      for turn in thread.get("turns", []) if isinstance(turn, dict) and isinstance(turn.get("id"), str)})
        persisted_ids = [*threads, *turns]
        counter = max((int(value.rsplit("-", 1)[1]) for value in persisted_ids
                       if isinstance(value, str) and value.rsplit("-", 1)[-1].isdigit()), default=counter)


def is_modern_codex() -> bool:
    return mode == "codex_modern"


def persist_peer_state() -> None:
    state_path.write_text(json.dumps({"threads": threads}, ensure_ascii=False), encoding="utf8")


def emit(value):
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"
    with lock:
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()


def result(identifier, value):
    emit({"id": identifier, "result": value})


def notification(method, params):
    emit({"method": method, "params": params})


def complete(owner, turn_id, status="completed"):
    turn = turns[turn_id]
    turn["status"] = status
    threads[owner]["status"] = {"type": "idle"}
    message = {"id": turn_id + "-message", "type": "agentMessage", "text": "完成：" + owner}
    turn["items"] = [message]
    persist_peer_state()
    notification("item/completed", {"threadId": owner, "turnId": turn_id, "item": message})
    notification("turn/completed", {"threadId": owner, "turn": dict(turn)})


def host_call(owner, turn_id, step, arguments):
    call_id = f"host-{turn_id}-{step}"
    host_calls[call_id] = (owner, turn_id, step)
    notification("item/started", {"threadId": owner, "turnId": turn_id, "item": {
        "type": "dynamicToolCall", "id": call_id, "tool": "development_collaboration",
        "arguments": arguments, "contentItems": None}})
    emit({"id": call_id, "method": "item/tool/call", "params": {"threadId": owner,
        "turnId": turn_id, "callId": call_id, "tool": "development_collaboration", "arguments": arguments}})


def host_reply(identifier, reply):
    owner, turn_id, step = host_calls.pop(identifier)
    if not reply.get("success"):
        complete(owner, turn_id, "failed")
        return
    value = json.loads(reply["contentItems"][0]["text"])
    notification("item/completed", {"threadId": owner, "turnId": turn_id, "item": {
        "type": "dynamicToolCall", "id": identifier, "tool": "development_collaboration",
        "success": True, "contentItems": reply["contentItems"]}})
    if step == "presets":
        host_call(owner, turn_id, "start", {"action": "start", "request_id": "review_once",
            "preset_id": next(p["id"] for p in value if p["id"] == "reviewer"), "goal": "Review project; preserve MANUAL_CONTENT"})
    elif step == "start":
        if turns[turn_id].get("skipWait"):
            complete(owner, turn_id)
        else:
            host_call(owner, turn_id, "wait", {"action": "wait", "task_id": value["id"], "seconds": 5})
    else:
        turn = turns[turn_id]
        turn["status"] = "completed"
        message = {"id": turn_id + "-final", "type": "agentMessage",
            "text": "HOST_RESULT_CONSUMED:" + value.get("result", "")}
        turn["items"] = [message]
        notification("item/completed", {"threadId": owner, "turnId": turn_id, "item": message})
        notification("turn/completed", {"threadId": owner, "turn": dict(turn)})


def configuration():
    value = {
        "features": {"hooks": False, "memories": False, "apps": False, "plugins": False,
                     "remote_plugin": False, "goals": False, "multi_agent": False, "multi_agent_v2": False},
        "agents": {"enabled": False},
        "notify": [], "mcp_servers": {}, "project_doc_max_bytes": 0,
        "project_doc_fallback_filenames": [], "project_root_markers": [], "allow_login_shell": False,
        "shell_environment_policy": {"inherit": "core", "ignore_default_excludes": False},
        "windows": {"sandbox": "unelevated"},
    }
    if mode == "unsafe_config":
        value["mcp_servers"] = {"unwanted": {"command": "never-executed"}}
    return {"config": value, "origins": {}}


notification("peer/ready", {"text": "早到的启动事件"})
for raw in sys.stdin.buffer:
    request = json.loads(raw)
    with trace_path.open("a", encoding="utf-8") as trace:
        trace.write(json.dumps(request, ensure_ascii=False) + "\n")
    identifier = request.get("id")
    method = request.get("method")
    params = request.get("params", {})
    if method is None:
        if str(identifier) in host_calls:
            host_reply(str(identifier), request.get("result", {}))
            continue
        pending = awaiting.pop(str(identifier), None)
        if pending:
            complete(*pending)
        continue
    if identifier is None:
        continue
    if method == "initialize":
        reply = {"codexHome": str(root)}
        if mode == "codex_modern":
            reply["userAgent"] = "codex_cli_rs/0.162.0-alpha.2"
        elif mode == "codex_old":
            reply["userAgent"] = "codex_cli_rs/0.124.0"
        elif mode != "codex_unknown":
            reply["userAgent"] = "native-peer/1"
        result(identifier, reply)
    elif method == "config/read":
        result(identifier, configuration())
    elif method == "account/read":
        usage_file = root / "account-usage.json"
        usage = json.loads(usage_file.read_text(encoding="utf8")) if usage_file.exists() else {}
        result(identifier, {"account": usage.get("account", {"type": auth_type}) if auth_type else None, "requiresOpenaiAuth": True})
    elif method == "account/rateLimits/read":
        usage_file = root / "account-usage.json"
        usage = json.loads(usage_file.read_text(encoding="utf8")) if usage_file.exists() else {}
        if usage.get("error"):
            emit({"id": identifier, "error": {"code": -32601, "message": "PRIVATE upstream detail"}})
        else:
            if usage.get("echo"):
                notification("account/rateLimits/updated", {})
            switched = usage.get("switchAccountDuringRead")
            if isinstance(switched, dict):
                updated = {**usage, **switched}
                updated.pop("switchAccountDuringRead", None)
                usage_file.write_text(json.dumps(updated), encoding="utf8")
                notification("account/updated", {"authMode": "chatgpt"})
            result(identifier, usage.get("usage", {}))
    elif method == "test/usage/push":
        notification("account/updated" if params.get("identity") else "account/rateLimits/updated", {})
        result(identifier, {})
    elif method == "account/login/start":
        login_count += 1
        native_login = f"auth-{login_count}"
        settings_file = root / "login-behavior.json"
        settings = json.loads(settings_file.read_text(encoding="utf8")) if settings_file.exists() else {}
        if settings.get("early"):
            notification("account/login/completed", {"loginId": native_login, "success": True})
        if settings.get("silent"):
            continue
        result(identifier, {"type": "chatgpt", "loginId": native_login,
                            "authUrl": settings.get("url", "https://auth.openai.com/test-only-login")})
    elif method == "account/login/cancel":
        notification("account/login/completed", {"loginId": params["loginId"], "success": False, "error": "PRIVATE_LOGIN_DIAGNOSTIC"})
        result(identifier, {"status": "canceled"})
    elif method == "test/auth/complete":
        auth_ready = params["success"]
        auth_type = "chatgpt" if auth_ready else None
        notification("account/login/completed", params)
        notification("account/updated", {"authMode": "chatgpt" if auth_ready else None})
        result(identifier, {})
    elif method == "account/logout":
        auth_ready = False
        auth_type = None
        result(identifier, {})
    elif method == "skills/list":
        result(identifier, {"data": [{"cwd": str(root), "skills": [], "errors": []}]})
    elif method == "thread/start":
        counter += 1
        owner = f"thread-{counter}"
        thread = {"id": owner, "cwd": str(root), "turns": [], "status": {"type": "idle"}}
        threads[owner] = thread
        persist_peer_state()
        notification("thread/started", {"thread": thread})
        approval_policy = "on-request" if mode == "weaker_policy" else params.get("approvalPolicy", "on-request")
        sandbox_type = "workspaceWrite" if mode == "weaker_policy" else {"read-only": "readOnly", "danger-full-access": "dangerFullAccess"}.get(params.get("sandbox"), "workspaceWrite")
        result(identifier, {"thread": thread, "instructionSources": [], "approvalPolicy": approval_policy,
            "approvalsReviewer": "user", "sandbox": {"type": sandbox_type}})
    elif method == "thread/resume":
        owner = params["threadId"]
        if is_modern_codex() and params.get("excludeTurns") is not True:
            emit({"id": identifier, "error": {"code": -32601,
                "message": "thread/resume without excludeTurns is not supported yet"}})
            continue
        if is_modern_codex() and owner not in threads:
            emit({"id": identifier, "error": {"code": -32600,
                "message": f"no rollout found for thread id {owner}"}})
            continue
        error_path = root / "resume-error.json"
        if error_path.exists():
            failure = json.loads(error_path.read_text(encoding="utf8"))
            if failure.get("silence"):
                continue
            emit({"id": identifier, "error": failure})
            continue
        thread = threads.setdefault(owner, {"id": owner, "cwd": str(root), "turns": [], "status": {"type": "idle"}})
        notification("thread/started", {"thread": thread})
        resumed_thread = {key: value for key, value in thread.items() if not (params.get("excludeTurns") is True and key == "turns")}
        result(identifier, {"thread": resumed_thread, "instructionSources": [], "approvalPolicy": params.get("approvalPolicy", "on-request"), "approvalsReviewer": "user",
            "sandbox": {"type": {"read-only": "readOnly", "danger-full-access": "dangerFullAccess"}.get(params.get("sandbox"), "workspaceWrite")}})
        usage_events = root / "usage-events.json"
        if is_modern_codex() and params.get("excludeTurns") is True and usage_events.exists():
            previous = next((turn for turn in reversed(thread.get("turns", []))
                             if isinstance(turn, dict) and isinstance(turn.get("id"), str)), None)
            if previous is not None:
                values = json.loads(usage_events.read_text(encoding="utf8"))
                notification("thread/tokenUsage/updated", {"threadId": owner, "turnId": previous["id"],
                    "tokenUsage": {"last": {"totalTokens": values["replayedContextTokens"]},
                                   "modelContextWindow": 16384}})
    elif method == "turn/start":
        owner = params["threadId"]
        counter += 1
        turn_id = f"turn-{counter}"
        turn = {"id": turn_id, "status": "inProgress", "items": [], "error": None}
        threads[owner]["status"] = {"type": "active"}
        turns[turn_id] = turn
        threads[owner]["turns"].append(turn)
        persist_peer_state()
        text = params["input"][0]["text"].rsplit("[/Mona handoff — current user request follows]", 1)[-1].strip()
        text = text.rsplit("[/Runtime Context]", 1)[-1].strip()
        if text.startswith("协作目标：hold\n"):
            text = "hold"
        if text == "history_only":
            turn["status"] = "completed"
            threads[owner]["status"] = {"type": "idle"}
            turn["items"] = [{"id": turn_id + "-message", "type": "agentMessage", "text": "Recovered native result"}]
            persist_peer_state()
            result(identifier, {"turn": turn})
            continue
        if text == "silent":
            continue
        if text == "reject":
            emit({"id": identifier, "error": {"code": -32001, "message": "unsafe diagnostic must not escape"}})
            continue
        notification("turn/started", {"threadId": owner, "turn": dict(turn)})
        usage_events = root / "usage-events.json"
        if is_modern_codex() and usage_events.exists():
            values = json.loads(usage_events.read_text(encoding="utf8"))
            notification("thread/tokenUsage/updated", {"threadId": owner, "turnId": turn_id,
                "tokenUsage": {"last": {"totalTokens": values["currentContextTokens"]},
                               "modelContextWindow": 16384}})
        notification("item/agentMessage/delta", {"threadId": owner, "turnId": turn_id, "itemId": turn_id + "-message", "delta": "中文：" + owner})
        if text in {"delegate_host", "delegate_early"} and mode == "complete_requests":
            turn["skipWait"] = text == "delegate_early"
            result(identifier, {"turn": dict(turn)})
            host_call(owner, turn_id, "presets", {"action": "presets"})
            continue
        if text == "instant" or (mode == "complete_requests" and text not in {"hold", "approve", "approve_similar", "disconnect", "lost_ack"}):
            complete(owner, turn_id)
        elif text == "lost_ack":
            def late(identifier=identifier, owner=owner, turn_id=turn_id):
                time.sleep(0.3)
                complete(owner, turn_id)
                result(identifier, {"turn": turns[turn_id]})
            threading.Thread(target=late, daemon=True).start()
            continue
        elif text in {"approve", "approve_similar"}:
            approval_id = "approve-" + turn_id
            awaiting[approval_id] = (owner, turn_id)
            params = {
                "threadId": owner, "turnId": turn_id, "itemId": turn_id + "-command", "command": "echo harmless",
                "cwd": str(root), "reason": "Test approval"}
            if text == "approve_similar":
                params.update(proposedExecpolicyAmendment=["echo", "harmless"],
                              availableDecisions=["acceptWithExecpolicyAmendment", "decline"])
            emit({"id": approval_id, "method": "item/commandExecution/requestApproval", "params": params})
        elif text == "disconnect":
            sys.exit(0)
        result(identifier, {"turn": dict(turn)})
    elif method == "turn/steer":
        steering_settings = root / "steering-behavior.json"
        steering_behavior = json.loads(steering_settings.read_text(encoding="utf8")) if steering_settings.exists() else {}
        if steering_behavior.get("loseReceipt"):
            continue
        if any(isinstance(item, dict) and item.get("text") == "steer_no_ack"
               for item in params.get("input", [])):
            continue
        result(identifier, {"turnId": params["expectedTurnId"]})
        if steering_behavior.get("respond"):
            def steering_response(owner=params["threadId"], turn_id=params["expectedTurnId"]):
                time.sleep(0.05)
                item = {"id": turn_id + "-steering", "type": "agentMessage", "text": "Steering observed"}
                notification("item/started", {"threadId": owner, "turnId": turn_id, "item": {**item, "text": ""}})
                notification("item/completed", {"threadId": owner, "turnId": turn_id, "item": item})
            threading.Thread(target=steering_response, daemon=True).start()
    elif method == "turn/interrupt":
        result(identifier, {})
        def interrupted(owner=params["threadId"], turn_id=params["turnId"]):
            time.sleep(0.05)
            complete(owner, turn_id, "interrupted")
        threading.Thread(target=interrupted, daemon=True).start()
    elif method == "thread/read":
        if is_modern_codex() and params.get("includeTurns") is True:
            emit({"id": identifier, "error": {"code": -32601, "message": "list_turns is not supported yet"}})
        else:
            thread = threads[params["threadId"]]
            if params.get("includeTurns") is False:
                thread = {key: value for key, value in thread.items() if key != "turns"}
            result(identifier, {"thread": thread})
    elif method == "thread/unsubscribe":
        result(identifier, {})
    elif method == "model/list":
        result(identifier, {"data": [{"id": "example", "model": "example-model", "displayName": "Example",
            "supportedReasoningEfforts": [{"reasoningEffort": level} for level in ("low", "high", "xhigh")],
            "defaultReasoningEffort": "high"}], "nextCursor": None})
    elif method == "echo":
        result(identifier, params)
    elif method == "reverse":
        if held is None:
            held = (identifier, params)
        else:
            result(identifier, params)
            result(*held)
            held = None
    elif method == "delay":
        def delay(identifier=identifier, params=params):
            time.sleep(0.15)
            result(identifier, params)
        threading.Thread(target=delay, daemon=True).start()
    elif method == "approval":
        emit({"id": 42, "method": "client/confirm", "params": {"label": "Only this request waits"}})
        result(identifier, {})
    elif method == "stderr":
        sys.stderr.buffer.write(b"x" * 150000)
        sys.stderr.buffer.flush()
        result(identifier, {})
    elif method == "malformed":
        with lock:
            sys.stdout.buffer.write(b"{invalid json\n")
            sys.stdout.buffer.flush()
    elif method == "large":
        with lock:
            sys.stdout.buffer.write(b"x" * 3000000 + b"\n")
            sys.stdout.buffer.flush()
    elif method == "error":
        emit({"id": identifier, "error": {"code": -32000, "message": "private diagnostic", "data": "private payload"}})
    else:
        emit({"id": identifier, "error": {"code": -32601, "message": "No such method"}})
