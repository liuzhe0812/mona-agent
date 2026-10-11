import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from mona.development.context import load_project_context
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.base import SessionStart
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import CodexProfile
from mona.development.handoff import build_handoff
from mona.development.native_service import NativeRunService
from mona.development.store import ConflictError, DevelopmentStore
from mona.session.manager import SessionManager

PEER = Path(__file__).with_name("native_peer.py").resolve()


async def setup(tmp_path):
    root = tmp_path / "中文项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("Project rules.", encoding="utf-8")
    home = tmp_path / "native-home"
    home.mkdir()
    store = DevelopmentStore(tmp_path / "metadata.sqlite3")
    project = store.open_project(root)
    session = store.create_session(project.id, ExecutorId.CODEX)
    context = load_project_context(project)
    adapter = CodexExecutor(CodexProfile((sys.executable, "-u", str(PEER)), home, root, dict(os.environ)), request_timeout=1)
    binding = await adapter.create_session(SessionStart(session, context))
    binding = store.activate_binding(binding, session.revision)
    sessions = SessionManager(tmp_path / "history")
    service = NativeRunService(store, sessions)
    service.attach(binding.id, adapter)
    return service, adapter, store, store.get_session(session.id), binding, context


async def wait_status(store, run_id, expected):
    async with asyncio.timeout(6):
        while True:
            run = store.get_run(run_id)
            if run.status in expected:
                return run
            await asyncio.sleep(0.01)


def requests(adapter):
    return [json.loads(line) for line in (adapter.profile.project_root / "peer-trace.jsonl").read_text(encoding="utf-8").splitlines()]


@pytest.mark.asyncio
async def test_cancel_before_native_dispatch_is_confirmed_without_sending(tmp_path):
    service, adapter, store, session, _, _ = await setup(tmp_path)
    try:
        run = await service.submit(session.id, "request_cancel", "hold")
        ended = await service.interrupt(run.id)
        assert ended.status == RunStatus.INTERRUPTED
        assert not any(r.get("method") == "turn/start" for r in requests(adapter))
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_recovery_reads_exact_native_turn_and_never_reruns_prompt(tmp_path):
    service, adapter, store, session, binding, _ = await setup(tmp_path)
    try:
        run = await service.submit(session.id, "request_recover", "history_only")
        await wait_status(store, run.id, {RunStatus.RUNNING})
        await service.close()
        assert store.get_run(run.id).status == RunStatus.UNKNOWN
        service = NativeRunService(DevelopmentStore(store.path), SessionManager(tmp_path / "history"))
        service.attach(binding.id, adapter)
        result = await service.recover(run.id)
        assert result.status == RunStatus.SUCCEEDED
        assert result.result_message_id
        transcript = service.sessions.get_or_create(session.transcript_key)
        assert len(transcript.messages) == 2
        assert transcript.messages[-1]["content"] == "Recovered native result"
        assert len([r for r in requests(adapter) if r.get("method") == "turn/start"]) == 1
        again = await service.recover(run.id)
        assert again == result
        assert len(transcript.messages) == 2
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_persisted_dispatch_and_transcript_survive_service_reopen(tmp_path):
    service, adapter, store, session, binding, _ = await setup(tmp_path)
    try:
        first, duplicate = await asyncio.gather(service.submit(session.id, "request_one", "instant"), service.submit(session.id, "request_one", "instant"))
        assert first.id == duplicate.id
        run = await wait_status(store, first.id, {RunStatus.SUCCEEDED})
        assert run.native_turn_id
        transcript = service.sessions.get_or_create(session.transcript_key)
        assert [m["role"] for m in transcript.messages] == ["user", "assistant"]
        assert transcript.messages[-1]["content"] == "完成：" + binding.native_session_id
        assert len([r for r in requests(adapter) if r.get("method") == "turn/start"]) == 1
        await service.close()
        service = NativeRunService(DevelopmentStore(store.path), SessionManager(tmp_path / "history"))
        service.attach(binding.id, adapter)
        repeated = await service.submit(session.id, "request_one", "instant")
        assert repeated.id == run.id and repeated.status == RunStatus.SUCCEEDED
        with pytest.raises(ConflictError):
            await service.submit(session.id, "request_one", "changed payload")
        second = await service.submit(session.id, "request_two", "instant")
        await wait_status(store, second.id, {RunStatus.SUCCEEDED})
        assert len(service.sessions.get_or_create(session.transcript_key).messages) == 4
        assert len([r for r in requests(adapter) if r.get("method") == "turn/start"]) == 2
        assert len(store.list_sessions(session.project_id)) == 1
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_same_project_sessions_execute_concurrently_and_events_remain_owned(tmp_path):
    service, adapter, store, session, binding, context = await setup(tmp_path)
    try:
        other = store.create_session(session.project_id, ExecutorId.CODEX)
        other_binding = await adapter.create_session(SessionStart(other, context))
        other_binding = store.activate_binding(other_binding, other.revision)
        service.attach(other_binding.id, adapter)
        first = await service.submit(session.id, "request_hold", "hold")
        await wait_status(store, first.id, {RunStatus.RUNNING})
        second = await service.submit(other.id, "request_other", "instant")
        await wait_status(store, second.id, {RunStatus.SUCCEEDED})
        assert store.get_run(first.id).status == RunStatus.RUNNING
        await service.interrupt(first.id)
        await wait_status(store, first.id, {RunStatus.INTERRUPTED})
        assert all(e.session_id == session.id for e in store.events_after(session.id))
        assert all(e.run_id in {None, second.id} for e in store.events_after(other.id))
        other_text = service.sessions.get_or_create(other.transcript_key).messages[-1]["content"]
        assert other_binding.native_session_id in other_text and binding.native_session_id not in other_text
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_handoff_consumed_after_native_acceptance_and_not_sent_next_turn(tmp_path):
    service, adapter, store, session, binding, context = await setup(tmp_path)
    try:
        transcript = service.sessions.get_or_create(session.transcript_key)
        transcript.add_message("user", "Already built the parser")
        service.sessions.save(transcript)
        packet = build_handoff(context, session, transcript, goal="Continue parser work")
        store.prepare_handoff(binding.id, session.revision, packet)
        first = await service.submit(session.id, "request_first", "instant")
        await wait_status(store, first.id, {RunStatus.SUCCEEDED})
        assert store.get_binding(binding.id).handoff.state == "accepted"
        second = await service.submit(session.id, "request_second", "instant")
        await wait_status(store, second.id, {RunStatus.SUCCEEDED})
        sent = [r["params"]["input"][0]["text"] for r in requests(adapter) if r.get("method") == "turn/start"]
        assert packet.content in sent[0]
        assert sent[1] == "instant"
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_unacknowledged_handoff_is_retained_unknown_never_resent_after_restart(tmp_path):
    service, adapter, store, session, binding, context = await setup(tmp_path)
    try:
        packet = build_handoff(context, session, service.sessions.get_or_create(session.transcript_key), goal="Continue")
        store.prepare_handoff(binding.id, session.revision, packet)
        adapter._client._timeout = 0.03
        first = await service.submit(session.id, "request_silent", "silent")
        await wait_status(store, first.id, {RunStatus.UNKNOWN})
        assert store.get_binding(binding.id).handoff.state == "unknown"
        await service.close()
        reopened = DevelopmentStore(store.path)
        reopened.reconcile_after_restart()
        service = NativeRunService(reopened, SessionManager(tmp_path / "history"))
        service.attach(binding.id, adapter)
        assert (await service.submit(session.id, "request_silent", "silent")).id == first.id
        with pytest.raises(ConflictError):
            await service.submit(session.id, "request_new", "instant")
        assert len([r for r in requests(adapter) if r.get("method") == "turn/start"]) == 1
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_definite_rejection_preserves_handoff_for_new_explicit_request(tmp_path):
    service, adapter, store, session, binding, context = await setup(tmp_path)
    try:
        packet = build_handoff(context, session, service.sessions.get_or_create(session.transcript_key), goal="Review")
        store.prepare_handoff(binding.id, session.revision, packet)
        first = await service.submit(session.id, "request_reject", "reject")
        await wait_status(store, first.id, {RunStatus.FAILED})
        assert store.get_binding(binding.id).handoff.state == "pending"
        second = await service.submit(session.id, "request_retry", "instant")
        await wait_status(store, second.id, {RunStatus.SUCCEEDED})
        assert store.get_binding(binding.id).handoff.state == "accepted"
    finally:
        await service.close()
        await adapter.shutdown()
