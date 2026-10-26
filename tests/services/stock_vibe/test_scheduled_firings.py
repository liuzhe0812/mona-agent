from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = REPO_ROOT / "third_party" / "vibe-trading"
NATIVE_PYTHON = REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe"

_NATIVE_PROBE = r'''from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import types
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from src.session.events import EventBus
from src.session.models import Message
from src.session.service import SessionService
from src.session.store import SessionStore
from src.scheduled_research.hosted_firings import (
    HostedScheduledFireStore,
    ScheduledFireUnknown,
    dispatch_hosted_scheduled_fire,
    fire_key,
)
from src.scheduled_research.models import JobStatus, ScheduledResearchJob
from src.scheduled_research.store import ScheduledResearchJobStore

home = Path(os.environ["VIBE_TRADING_HOME"])


def new_service() -> SessionService:
    service = SessionService(
        store=SessionStore(base_dir=home / "sessions"),
        event_bus=EventBus(),
        runs_dir=home / "runs",
    )

    async def local_no_model_attempt(self, session, attempt, *, include_shell_tools=False):
        attempt.mark_running()
        self.store.update_attempt(attempt)
        attempt.mark_completed("local no-model attempt")
        self.store.update_attempt(attempt)
        self.store.append_message(
            Message(
                session_id=session.session_id,
                role="assistant",
                content="local no-model attempt",
                linked_attempt_id=attempt.attempt_id,
                metadata={"status": "completed"},
            )
        )
        self.event_bus.emit(
            session.session_id,
            "attempt.completed",
            {"attempt_id": attempt.attempt_id, "status": "completed"},
        )
        self._active_tasks.pop(session.session_id, None)
        self._release_session(session.session_id)

    service._run_attempt = types.MethodType(local_no_model_attempt, service)
    return service


def make_job(job_id: str, scheduled_at: int, prompt: str) -> ScheduledResearchJob:
    return ScheduledResearchJob(
        id=job_id,
        prompt=prompt,
        schedule="60000",
        next_run_at=scheduled_at,
        created_at=scheduled_at - 1,
    )


def host_service(service: SessionService) -> None:
    host = types.ModuleType("api_server")
    host.require_auth = lambda: True
    host._get_session_service = lambda: service
    host._validate_path_param = lambda value, kind: None
    sys.modules["api_server"] = host


async def phase_crash_after_acceptance() -> dict:
    from src.api.scheduled_routes import _dispatch_scheduled_research_job
    from src.scheduled_research.hosted_firings import HostedScheduledFireStore

    service = new_service()
    host_service(service)
    job = make_job("accepted-before-ledger-write", 100000, "local no-model recovery")
    store = HostedScheduledFireStore()
    original_mark_queued = HostedScheduledFireStore.mark_queued
    completion_write_failed = False

    def fail_completion_write(self, *args, **kwargs):
        nonlocal completion_write_failed
        if not completion_write_failed:
            completion_write_failed = True
            raise sqlite3.OperationalError("injected completion write failure")
        return original_mark_queued(self, *args, **kwargs)

    HostedScheduledFireStore.mark_queued = fail_completion_write
    send_calls = 0
    send_before_failure = service.send_message

    async def count_send(*args, **kwargs):
        nonlocal send_calls
        send_calls += 1
        return await send_before_failure(*args, **kwargs)

    service.send_message = count_send
    try:
        await _dispatch_scheduled_research_job(job)
    except ScheduledFireUnknown:
        pass
    else:
        raise AssertionError("failed completion write must return an unknown outcome")
    await asyncio.sleep(0.05)
    HostedScheduledFireStore.mark_queued = original_mark_queued
    key = fire_key(job.id, job.next_run_at)
    row = store.get(key)
    assert send_calls == 1
    assert row["dispatch_status"] == "unknown"
    assert row["session_id"]
    session = service.get_session(row["session_id"])
    attempt = service.store.get_attempt(row["session_id"], session.last_attempt_id)
    assert attempt is not None and attempt.status.value == "completed"
    return {"key": key, "session_id": row["session_id"], "attempt_id": attempt.attempt_id}


async def phase_restart_reconcile(expected: dict) -> dict:
    from src.scheduled_research.hosted_firings import (
        HostedScheduledFireStore,
        public_firings,
    )
    from src.api.scheduled_routes import _dispatch_scheduled_research_job
    from src.api.scheduled_routes import register_scheduled_routes

    # New SessionService and SQLite store objects represent process restart.
    service = new_service()
    host_service(service)
    job = make_job("accepted-before-ledger-write", 100000, "local no-model recovery")
    sends = 0
    send_before_recovery = service.send_message

    async def count_send(*args, **kwargs):
        nonlocal sends
        sends += 1
        return await send_before_recovery(*args, **kwargs)

    service.send_message = count_send
    store = HostedScheduledFireStore()
    recovered_session_id = await _dispatch_scheduled_research_job(job)
    assert recovered_session_id == expected["session_id"]
    assert sends == 0
    row = store.get(expected["key"])
    assert row["dispatch_status"] == "queued"
    assert row["attempt_id"] == expected["attempt_id"]

    app = FastAPI()

    def require_auth(request: Request):
        if request.headers.get("authorization") != "Bearer scheduled-test":
            raise HTTPException(status_code=401, detail="unauthorized")

    register_scheduled_routes(app, require_auth=require_auth)
    with TestClient(app) as client:
        assert client.get("/mona/scheduled-firings").status_code == 401
        response = client.get(
            "/mona/scheduled-firings?job_id=accepted-before-ledger-write",
            headers={"Authorization": "Bearer scheduled-test"},
        )
        assert response.status_code == 200, response.text
        rows = response.json()["firings"]
        assert len(rows) == 1
        firing = rows[0]
        assert firing == {
            "key": expected["key"],
            "job_id": "accepted-before-ledger-write",
            "scheduled_at": 100000,
            "session_id": expected["session_id"],
            "attempt_id": expected["attempt_id"],
            "dispatch_status": "queued",
            "attempt_status": "completed",
        }
    assert sends == 0
    assert public_firings(service, job_id=job.id)[0]["attempt_status"] == "completed"

    # Concurrent and subsequent claims of the same occurrence never send twice.
    concurrent_job = make_job("concurrent-fire", 200000, "local no-model concurrent")
    concurrent_started = asyncio.Event()
    release_send = asyncio.Event()
    concurrent_sends = 0
    send_before_gate = service.send_message

    async def gated_send(*args, **kwargs):
        nonlocal concurrent_sends
        concurrent_sends += 1
        concurrent_started.set()
        await release_send.wait()
        return await send_before_gate(*args, **kwargs)

    service.send_message = gated_send
    first = asyncio.create_task(_dispatch_scheduled_research_job(concurrent_job))
    await concurrent_started.wait()
    try:
        await _dispatch_scheduled_research_job(concurrent_job)
    except ScheduledFireUnknown:
        pass
    else:
        raise AssertionError("concurrent duplicate must be unknown until the first claim resolves")
    release_send.set()
    first_session_id = await first
    await asyncio.sleep(0.05)
    duplicate_session_id = await _dispatch_scheduled_research_job(concurrent_job)
    assert duplicate_session_id == first_session_id
    assert concurrent_sends == 1

    # A claim with no recorded session/attempt remains unknown and is never resent.
    no_evidence = make_job("no-evidence", 300000, "must not be resent")
    no_evidence_store = HostedScheduledFireStore()
    key, _, inserted = no_evidence_store.claim(no_evidence.id, no_evidence.next_run_at, no_evidence.prompt)
    assert inserted
    try:
        await dispatch_hosted_scheduled_fire(no_evidence, service, store=no_evidence_store)
    except ScheduledFireUnknown:
        pass
    else:
        raise AssertionError("unrecoverable claim must stay unknown")
    assert no_evidence_store.get(key)["dispatch_status"] == "unknown"
    assert concurrent_sends == 1

    # A genuinely new scheduled timestamp has a distinct fire key and may dispatch.
    next_fire = make_job("concurrent-fire", 260000, "local no-model concurrent")
    next_session_id = await _dispatch_scheduled_research_job(next_fire)
    await asyncio.sleep(0.05)
    assert next_session_id != first_session_id
    assert concurrent_sends == 2

    return {"restart_reconciled": True, "concurrent_sends": concurrent_sends, "unknown_stays_unknown": True}


async def check_executor_unknown_policy(hosted: bool) -> str:
    from src.scheduled_research.executor import ScheduledResearchExecutor
    from src.scheduled_research.hosted_firings import ScheduledFireUnknown

    job_id = "executor-hosted" if hosted else "executor-standalone"
    store = ScheduledResearchJobStore(home / (job_id + ".json"))
    job = make_job(job_id, 400000, "executor unknown")
    store.upsert(job)

    async def unknown_dispatch(_job):
        raise ScheduledFireUnknown("a" * 64)

    executor = ScheduledResearchExecutor(
        store,
        unknown_dispatch,
        enabled=True,
        now_fn=lambda: 400000,
        max_consecutive_failures=4,
        retry_base_delay_ms=100,
        retry_max_delay_ms=1000,
    )
    await executor._run_job(job, 400000)
    updated = store.get(job_id)
    if hosted:
        assert updated.status == JobStatus.FAILED
        assert updated.next_run_at == 400000
    else:
        assert updated.status == JobStatus.PENDING
        assert updated.next_run_at > 400000
    return updated.status.value


async def main(phase: str) -> None:
    if phase == "crash":
        result = await phase_crash_after_acceptance()
    elif phase == "restart":
        expected = json.loads(os.environ["EXPECTED_FIRE"])
        result = await phase_restart_reconcile(expected)
        os.environ["VIBE_TRADING_HOSTED"] = "1"
        result["hosted_executor_status"] = await check_executor_unknown_policy(True)
        os.environ["VIBE_TRADING_HOSTED"] = "0"
        result["standalone_executor_status"] = await check_executor_unknown_policy(False)
    else:
        raise AssertionError("unknown probe phase")
    print(json.dumps(result, sort_keys=True))


asyncio.run(main(sys.argv[1]))
'''


@pytest.fixture(scope="module")
def prepared_native(tmp_path_factory: pytest.TempPathFactory) -> Path:
    destination = tmp_path_factory.mktemp("scheduled-firings-native") / "prepared"
    receipt = prepare(SNAPSHOT_ROOT, destination)
    names = [patch["path"] for patch in receipt["patches"]]
    assert names.index("0013-host-swarm-artifacts.json") < names.index("0016-hosted-scheduled-firings.json")
    return destination / "agent"


def _run_probe(native_agent: Path, vibe_home: Path, phase: str, expected: dict | None = None) -> dict:
    if not NATIVE_PYTHON.is_file():
        pytest.skip("isolated Python 3.13 native dependency environment is required")
    safe_names = {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME",
        "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in safe_names}
    env.update(
        {
            "PYTHONPATH": str(native_agent.resolve()),
            "PYTHONUTF8": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "VIBE_TRADING_HOME": str(vibe_home.resolve()),
            "VIBE_TRADING_HOSTED": "1",
            "EXPECTED_FIRE": json.dumps(expected or {}),
        }
    )
    result = subprocess.run(
        [str(NATIVE_PYTHON), "-c", _NATIVE_PROBE, phase],
        cwd=native_agent,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=90,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    return json.loads(result.stdout.decode("utf-8"))


def test_hosted_scheduled_firings_are_restart_safe_and_reference_real_attempts(
    tmp_path: Path, prepared_native: Path
) -> None:
    vibe_home = tmp_path / "private-vibe-home"
    vibe_home.mkdir()
    accepted = _run_probe(prepared_native, vibe_home, "crash")
    assert accepted["session_id"] and accepted["attempt_id"]
    recovered = _run_probe(prepared_native, vibe_home, "restart", accepted)
    assert recovered["restart_reconciled"] is True
    assert recovered["concurrent_sends"] == 2
    assert recovered["unknown_stays_unknown"] is True
    assert recovered["hosted_executor_status"] == "failed"
    assert recovered["standalone_executor_status"] == "pending"
