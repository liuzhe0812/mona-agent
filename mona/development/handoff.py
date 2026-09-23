"""Project-scoped handoff, not shared private memory or a second agent planner.

Uses Cindy's full/delta and accepted-only consumption ideas. The actual delivery
journal is stored on the native binding by DevelopmentStore.
"""

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


def build_handoff(context: ProjectContext, session: DevelopmentSession, transcript: Session,
                  *, goal: str, evidence: Sequence[Event] = (), since: int = 0,
                  max_chars: int = 16_000) -> PendingHandoff:
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
    fingerprint = hashlib.sha256(json.dumps({"messages": selected, "evidence": work, "goal": _redact(goal)},
                                            ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    body: dict[str, Any] = {
        "mode": "delta" if since else "full", "goal": _redact(goal), "project": str(context.root),
        "rules": [{"path": r.path, "sha256": r.sha256} for r in context.rules],
        "skills": [{"name": s.name, "path": s.path} for s in context.skills],
        "historyReference": {"sessionId": session.id, "fromIndex": since, "throughIndex": len(transcript.messages)},
        "workEvidence": work[-32:], "conversation": selected[-12:],
        "omittedConversationEntries": max(0, len(selected) - 12), "omittedEvidenceEntries": max(0, len(work) - 32),
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
