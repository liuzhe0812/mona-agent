"""Fork a completed reply's transcript without replaying project operations."""
from __future__ import annotations

import copy
from typing import TYPE_CHECKING

from mona.development.contracts import DevelopmentSession, ForkSource, RunStatus
from mona.development.store import ConflictError, NotFoundError
from mona.session.manager import Session

if TYPE_CHECKING:
    from mona.development.runtime import DevelopmentRuntime

HISTORY_KEY = "development_fork_history"


def history(transcript: Session) -> dict:
    return transcript.metadata.get(HISTORY_KEY, {"runs": [], "events": []})


def snapshot_history(runtime: DevelopmentRuntime, session_id: str, transcript: Session, after: int) -> tuple[list, list]:
    saved = history(transcript)
    # Imported records describe past work; they never become executable DB runs.
    runs = [r.model_dump(mode="json", by_alias=True) for r in runtime.store.list_runs(session_id, 20)]
    runs.extend(saved["runs"])
    events = [event for event in saved["events"] if event["sequence"] > after]
    events.extend(e.model_dump(mode="json", by_alias=True) for e in runtime.store.events_after(session_id, after, 100))
    return runs, events[:100]


async def fork_session(runtime: DevelopmentRuntime, source_id: str, revision: int, request_id: str,
                       message_id: str) -> DevelopmentSession:
    from mona.development.runtime import stable_id

    async with runtime._lock(source_id):
        child_id = stable_id("dev", source_id, request_id, "fork")
        try:
            existing = runtime.store.get_session(child_id)
        except NotFoundError:
            existing = None
        if existing:
            if existing.fork_source and existing.fork_source.source_message_id == message_id:
                return existing
            raise ConflictError("分叉请求已用于另一条回复，请重新选择。")
        source = runtime.store.get_session(source_id)
        if source.revision != revision:
            raise ConflictError()
        transcript = runtime.sessions.get_or_create(source.transcript_key)
        boundary = next((i for i, message in enumerate(transcript.messages) if message.get("id") == message_id), None)
        if boundary is None:
            raise ConflictError("所选回复不存在，请刷新后重新选择。")
        target = transcript.messages[boundary]
        run_id = target.get("run_id")
        try:
            run = runtime.store.get_run(run_id).model_dump(mode="json", by_alias=True) if run_id else None
            if run and run["sessionId"] != source.id:
                run = None
        except NotFoundError:
            run = None
        if run is None:
            run = next((r for r in history(transcript)["runs"] if r["id"] == run_id), None)
        final = next((m for m in reversed(transcript.messages) if m.get("run_id") == run_id
                      and m.get("role") == "assistant" and not m.get("tool_calls")
                      and not m.get("_ui_only") and m.get("content")), None)
        if (not run or run["status"] != RunStatus.SUCCEEDED or target is not final
                or run.get("resultMessageId") not in {None, message_id}):
            raise ConflictError("只能从已成功完成的回复分叉。")
        messages = copy.deepcopy([m for m in transcript.messages[:boundary + 1]
            if not m.get("_input_cancelled") and not m.get("_input_delivered")
            and not (m.get("_ui_only") and m.get("source_kind") != "collaboration")])
        run_ids = {m["run_id"] for m in messages if m.get("run_id")}
        saved = runtime.store.fork_history(source.id, run_ids)
        inherited = history(transcript)
        known_runs = {r["id"] for r in saved["runs"]}
        saved["runs"].extend(r for r in inherited["runs"] if r["id"] in run_ids and r["id"] not in known_runs)
        saved["events"] = sorted([*(e for e in inherited["events"] if e["runId"] in run_ids),
                                  *saved["events"]], key=lambda e: e["sequence"])
        child = DevelopmentSession(id=child_id, project_id=source.project_id,
            title=f"{source.title[:196]}（分叉）", executor=source.executor, model=source.model,
            model_provider=source.model_provider, model_reasoning_effort=source.model_reasoning_effort,
            permission_mode=source.permission_mode, fork_source=ForkSource(source_session_id=source.id,
                source_message_id=message_id, source_title=source.title, request_id=request_id, message_count=len(messages)))
        # Fresh metadata prevents a later source summary, approval, or queue from
        # crossing this exact reply boundary. Native bindings are created on send.
        copied = Session(key=child.transcript_key, messages=messages, metadata={HISTORY_KEY: copy.deepcopy(saved)})
        try:
            runtime.sessions.save(copied, fsync=True)
            return runtime.store.publish_fork(child, revision)
        except Exception:
            runtime.sessions.delete_session(child.transcript_key)
            raise
