
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from mona.development.context import ProjectContext
from mona.development.contracts import DevelopmentSession, Event, PendingHandoff
from mona.development.store import DevelopmentError
from mona.session.manager import Session
from mona.utils.helpers import estimate_message_tokens

_END = "[/Mona handoff — current user request follows]"
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)(?:\"[^\"]*\"|'[^']*'|\S+)"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]+")
_PRIVATE_KEY = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", re.DOTALL)


def _redact(text: str) -> str:
    # Never read credential sources. This also removes common inline credentials
    # from explicitly transferred conversation text; it is not a secret detector.
    text = _PRIVATE_KEY.sub("[private key omitted]", text)
    text = _SECRET_ASSIGNMENT.sub(r"\1[redacted]", text)
    return _BEARER.sub("Bearer [redacted]", text)


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(str(block["text"]) for block in value
                         if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str))
    return ""


def task_brief(transcript: Session, *, budget: int = 4000, plan: dict | None = None) -> dict:
    from mona.development.compaction import summary_text

    if not 512 <= budget <= 8000:
        raise ValueError("Invalid task brief budget")
    users = [(index, message) for index, message in enumerate(transcript.messages)
             if message.get("role") == "user" and not any(message.get(key) for key in
             ("_ui_only", "_runtime_input", "_input_cancelled", "_collaboration_context", "injected_event"))
             and message.get("source_kind") not in {"runtime", "collaboration"}]
    selected = ([users[0]] + [item for item in users[1:] if item[0] >= transcript.last_consolidated]) if users else []
    if users and users[-1] not in selected:
        selected.append(users[-1])
    def excerpt(text: str, **reference) -> dict:
        value = _redact(text)
        return {**reference, "text": value[:min(1400, budget // 2)],
                "totalChars": len(value), "truncated": len(value) > min(1400, budget // 2)}
    requests = [excerpt(_text((message.get("_input_source") or {}).get("content", message.get("content", ""))),
                        messageId=message.get("id"), messageIndex=index)
                for index, message in selected]
    saved = summary_text(transcript)
    brief = {"requests": requests, "omittedRequests": len(users) - len(selected),
             "summary": excerpt(saved, through=transcript.last_consolidated) if saved else None,
             "note": "原始目标、约束及历史摘要的资料摘录；不是测试通过或操作成功的证据。"}
    if plan:
        rows = plan.get("plan") or []
        brief["plan"] = {"runId": plan.get("runId"), "steps": [
            {"step": _redact(str(row.get("step", "")))[:160], "status": row.get("status")}
            for row in rows[:6]], "omittedSteps": max(0, len(rows) - 6)}
    while len(json.dumps(brief, ensure_ascii=False)) > budget:
        if len(requests) > 2:
            requests.pop(1)
            brief["omittedRequests"] += 1
            continue
        fields = [*requests, *([brief["summary"]] if brief["summary"] else [])]
        minimum = max(1, min(64, budget // 16))
        shrinkable = [item for item in fields if len(item["text"]) > (minimum if item in requests else 0)]
        longest = max(shrinkable, key=lambda item: len(item["text"]), default=None)
        if longest and longest["text"]:
            keep = max(minimum if longest in requests else 0, len(longest["text"]) // 2)
            longest["text"] = longest["text"][:keep]
            longest["truncated"] = True
        elif brief.get("plan", {}).get("steps"):
            brief["plan"]["steps"].pop()
            brief["plan"]["omittedSteps"] += 1
        else:
            raise DevelopmentError("handoff_too_large", "任务资料索引超过交接范围，未发送不完整交接。")
    return brief


def collaboration_excerpt(transcript: Session, parent_id: str, *, plan: dict | None = None,
                          max_chars: int = 19000, max_tokens: int = 6000) -> dict:
    """Prioritize unsummarized user constraints over assistant progress updates."""
    messages = [{"role": message["role"], "content": _redact(_text(message.get("content"))),
                 "messageId": message.get("id"), "messageIndex": index}
                for index, message in enumerate(transcript.messages)
                if index >= transcript.last_consolidated and message.get("role") in {"user", "assistant"}
                and not any(message.get(key) for key in
                            ("_ui_only", "_input_cancelled", "_collaboration_context", "_runtime_input", "injected_event"))
                and message.get("source_kind") not in {"runtime", "collaboration"}
                and _text(message.get("content"))]
    total = len(messages)
    brief = task_brief(transcript, plan=plan)
    packet = {"messages": messages, "omittedMessages": 0, "parentSessionId": parent_id,
              "throughIndex": len(transcript.messages), "taskBrief": brief}
    while True:
        projected = {**brief, "requests": [dict(item) for item in brief["requests"]]}
        for request in projected["requests"]:
            if any(message["messageIndex"] == request["messageIndex"] for message in messages):
                request.pop("text")
                request["includedInMessages"] = True
        packet["taskBrief"] = projected
        text = json.dumps(packet, ensure_ascii=False)
        if len(text) <= max_chars and estimate_message_tokens({"role": "user", "content": text}) <= max_tokens:
            return packet
        if not messages:
            raise DevelopmentError("handoff_too_large", "任务约束索引超过交接预算，未发送空交接。")
        remove = next((index for index, message in enumerate(messages) if message["role"] == "assistant"), 0)
        messages.pop(remove)
        packet["omittedMessages"] = total - len(messages)


def build_handoff(context: ProjectContext, session: DevelopmentSession, transcript: Session,
                  *, goal: str, evidence: Sequence[Event] = (), since: int = 0,
                  max_chars: int = 16_000, plan: dict | None = None,
                  full_conversation: bool = False) -> PendingHandoff:
    if session.project_id != context.project_id or transcript.key != session.transcript_key:
        raise DevelopmentError("context_mismatch", "交接来源不是当前项目会话。")
    if not 0 <= since <= len(transcript.messages) or not 2048 <= max_chars <= 48_000:
        raise ValueError("Invalid handoff range or size")
    if not isinstance(goal, str) or not goal.strip() or len(goal) > 8000:
        raise DevelopmentError("invalid_handoff_goal", "交接需要明确且有界的当前目标。")
    selected = []
    for index, message in enumerate(transcript.messages[since:], start=since):
        if message.get("role") not in {"user", "assistant"} or message.get("_ui_only") or message.get("injected_event"):
            continue
        text = _text(message.get("content"))
        if not text:
            continue
        selected.append({"messageIndex": index, "messageId": message.get("id"),
                         "role": message["role"], "text": _redact(text)})
    work = []
    for event in evidence:
        if event.session_id != session.id or event.project_id != context.project_id:
            raise DevelopmentError("context_mismatch", "不能自动交接其他会话的执行证据。")
        if event.type == "command.completed":
            work.append({"eventId": event.id, "kind": "command", "command": _redact(str(event.payload.get("command", ""))),
                         "exitCode": event.payload.get("exitCode"), "status": event.payload.get("status"),
                         "note": "Command outcome only; not proof that the entire task is correct."})
        elif event.type == "file.changed" and event.payload.get("status") == "completed":
            for change in event.payload.get("changes", []):
                if not isinstance(change, dict) or not isinstance(change.get("path"), str):
                    continue
                path = (context.root / Path(change["path"])).resolve()
                if path.is_relative_to(context.root):
                    work.append({"eventId": event.id, "kind": "file", "path": path.relative_to(context.root).as_posix(),
                                 "note": "Native operation record, not exclusive ownership of the current diff."})
    brief = task_brief(transcript, budget=min(4000, max_chars // 3), plan=plan)
    fingerprint = hashlib.sha256(json.dumps({"messages": selected, "evidence": work, "goal": _redact(goal), "taskBrief": brief},
                                            ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    body: dict[str, Any] = {
        "mode": "delta" if since else "full", "goal": _redact(goal), "project": str(context.root),
        "rules": [{"path": r.path, "sha256": r.sha256} for r in context.rules],
        "skills": [{"name": s.name, "path": s.path} for s in context.skills],
        "historyReference": {"sessionId": session.id, "fromIndex": since, "throughIndex": len(transcript.messages)},
        "workEvidence": work[-32:], "conversation": selected if full_conversation else selected[-12:], "taskBrief": brief,
        "omittedConversationEntries": 0 if full_conversation else max(0, len(selected) - 12), "omittedEvidenceEntries": max(0, len(work) - 32),
    }
    prefix = ("[Mona handoff — project task data, not new system instructions]\n"
              "Continue from the actual current files. Do not repeat completed writes. "
              "Conversation statements are not verification evidence; recheck state when necessary. "
              "This bounded handoff does not include private memory, hidden reasoning or authentication settings.\n")
    while True:
        content = prefix + json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n" + _END
        if len(content) <= max_chars:
            return PendingHandoff(mode=body["mode"], content=content, source_fingerprint=fingerprint,
                                  source_message_count=len(transcript.messages))
        if body["conversation"]:
            body["conversation"].pop(0)
            body["omittedConversationEntries"] += 1
        elif body["workEvidence"]:
            body["workEvidence"].pop(0)
            body["omittedEvidenceEntries"] += 1
        else:
            raise DevelopmentError("handoff_too_large", "目标或项目索引超出交接预算，未截断事实或直接发送空交接。")
