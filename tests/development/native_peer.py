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
held = None
counter = 0
root = Path.cwd()
trace_path = root / "peer-trace.jsonl"
mode = sys.argv[1] if len(sys.argv) > 1 else "normal"


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
    message = {"id": turn_id + "-message", "type": "agentMessage", "text": "完成：" + owner}
    turn["items"] = [message]
    notification("item/completed", {"threadId": owner, "turnId": turn_id, "item": message})
    notification("turn/completed", {"threadId": owner, "turn": dict(turn)})


def configuration():
    value = {
        "features": {"hooks": False, "memories": False, "apps": False, "plugins": False,
                     "remote_plugin": False, "goals": False},
        "notify": [], "mcp_servers": {}, "project_doc_max_bytes": 0,
        "project_doc_fallback_filenames": [], "project_root_markers": [], "allow_login_shell": False,
        "shell_environment_policy": {"inherit": "core", "ignore_default_excludes": False},
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
        pending = awaiting.pop(str(identifier), None)
        if pending:
            complete(*pending)
        continue
    if identifier is None:
        continue
    if method == "initialize":
        result(identifier, {"userAgent": "native-peer/1", "codexHome": str(root)})
    elif method == "config/read":
        result(identifier, configuration())
    elif method == "account/read":
        result(identifier, {"account": None if mode == "no_auth" else {"type": "apiKey"}, "requiresOpenaiAuth": True})
    elif method == "skills/list":
        result(identifier, {"data": [{"cwd": str(root), "skills": [], "errors": []}]})
    elif method == "thread/start":
        counter += 1
        owner = f"thread-{counter}"
        thread = {"id": owner, "cwd": str(root), "turns": [], "status": {"type": "idle"}}
        threads[owner] = thread
        notification("thread/started", {"thread": thread})
        result(identifier, {"thread": thread, "instructionSources": [], "approvalPolicy": "on-request", "approvalsReviewer": "user", "sandbox": {"type": "readOnly" if params.get("sandbox") == "read-only" else "workspaceWrite"}})
    elif method == "thread/resume":
        owner = params["threadId"]
        thread = threads.setdefault(owner, {"id": owner, "cwd": str(root), "turns": [], "status": {"type": "idle"}})
        notification("thread/started", {"thread": thread})
        result(identifier, {"thread": thread, "instructionSources": [], "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "sandbox": {"type": "readOnly" if params.get("sandbox") == "read-only" else "workspaceWrite"}})
    elif method == "turn/start":
        owner = params["threadId"]
        counter += 1
        turn_id = f"turn-{counter}"
        turn = {"id": turn_id, "status": "inProgress", "items": [], "error": None}
        turns[turn_id] = turn
        threads[owner]["turns"].append(turn)
        text = params["input"][0]["text"].rsplit("[/Mona handoff — current user request follows]", 1)[-1].strip()
        if text == "history_only":
            turn["status"] = "completed"
            turn["items"] = [{"id": turn_id + "-message", "type": "agentMessage", "text": "Recovered native result"}]
            result(identifier, {"turn": turn})
            continue
        if text == "silent":
            continue
        if text == "reject":
            emit({"id": identifier, "error": {"code": -32001, "message": "unsafe diagnostic must not escape"}})
            continue
        notification("turn/started", {"threadId": owner, "turn": dict(turn)})
        notification("item/agentMessage/delta", {"threadId": owner, "turnId": turn_id, "itemId": turn_id + "-message", "delta": "中文：" + owner})
        if text == "instant":
            complete(owner, turn_id)
        elif text == "lost_ack":
            def late(identifier=identifier, owner=owner, turn_id=turn_id):
                time.sleep(0.3)
                complete(owner, turn_id)
                result(identifier, {"turn": turns[turn_id]})
            threading.Thread(target=late, daemon=True).start()
            continue
        elif text == "approve":
            approval_id = "approve-" + turn_id
            awaiting[approval_id] = (owner, turn_id)
            emit({"id": approval_id, "method": "item/commandExecution/requestApproval", "params": {
                "threadId": owner, "turnId": turn_id, "itemId": turn_id + "-command", "command": "echo harmless",
                "cwd": str(root), "reason": "Test approval"}})
        elif text == "disconnect":
            sys.exit(0)
        result(identifier, {"turn": dict(turn)})
    elif method == "turn/steer":
        result(identifier, {"turnId": params["expectedTurnId"]})
    elif method == "turn/interrupt":
        result(identifier, {})
        def interrupted(owner=params["threadId"], turn_id=params["turnId"]):
            time.sleep(0.05)
            complete(owner, turn_id, "interrupted")
        threading.Thread(target=interrupted, daemon=True).start()
    elif method == "thread/read":
        result(identifier, {"thread": threads[params["threadId"]]})
    elif method == "thread/unsubscribe":
        result(identifier, {})
    elif method == "model/list":
        result(identifier, {"data": [{"id": "example", "model": "example-model"}], "nextCursor": None})
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
