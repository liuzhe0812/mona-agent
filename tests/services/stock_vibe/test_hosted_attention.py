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
import threading
import types
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from src.scheduled_research.hosted_attention import (
    HostedAttentionStore,
    attention_runtime_active,
    events_snapshot,
    validate_attention_request,
)
from src.scheduled_research.models import JobStatus, ScheduledResearchJob
from src.scheduled_research.store import ScheduledResearchJobStore

BASE = int(datetime(2026, 10, 16, 10, 30, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)
SYMBOL = "600519.SH"


def prefs(mode="important_changes", symbols=None, start="09:00", end="14:00", interval=300):
    return {
        "proactive_mode": mode,
        "watched_symbols": [SYMBOL] if symbols is None else symbols,
        "notification_start": start,
        "notification_end": end,
        "attention_interval_sec": interval,
        "data_sources": ["tencent"],
    }


def request(preferences, allowed=True):
    return {"preferences": preferences, "execution_allowed": allowed}


def artifact(*, artifact_id="a" * 32, review_at="2026-10-20T00:00:00Z", symbol=SYMBOL):
    return {
        "artifact_id": artifact_id,
        "created_at": "2026-10-14T09:00:00Z",
        "symbol": symbol,
        "as_of": "2026-10-14",
        "review_at": review_at,
        "next_step": "Check whether the condition remains supported.",
        "conditions": [
            {
                "field": "close",
                "operator": "gt",
                "threshold": 10,
                "evidence_ref": "sha256:" + "b" * 64,
            }
        ],
        "invalidation": [],
    }


def market_fetcher(*, source="tencent", trade_date="2026-10-15", close=10.5, calls=None, entered=None, release=None, **kwargs):
    if calls is not None:
        calls.append({"source": source, **kwargs})
    if entered is not None:
        entered.set()
        if release is not None and not release.wait(10):
            raise TimeoutError("fixture fetch release timed out")
    return json.dumps(
        {
            SYMBOL: [{"trade_date": trade_date, "close": close}],
            "_provenance": {SYMBOL: {"source": source}},
        }
    )


def make_executor(job_store, now_ms, dispatched):
    from src.scheduled_research.executor import ScheduledResearchExecutor

    async def dispatch(job):
        dispatched.append(job)
        return "local-no-model-session"

    # Supply all retry values so this contract test does not need user config.
    return ScheduledResearchExecutor(
        job_store,
        dispatch,
        enabled=True,
        now_fn=lambda: now_ms,
        max_consecutive_failures=3,
        retry_base_delay_ms=100,
        retry_max_delay_ms=1000,
    )


def host_routes(service=None):
    host = types.ModuleType("api_server")

    def require_auth(request: Request):
        if request.headers.get("authorization") != "Bearer attention-test":
            raise HTTPException(status_code=401, detail="unauthorized")
        return True

    host.require_auth = require_auth
    host._get_session_service = lambda: service
    host._validate_path_param = lambda value, kind: None
    sys.modules["api_server"] = host
    return require_auth


async def phase_seed(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    store = HostedAttentionStore()
    job_store = ScheduledResearchJobStore(home / "scheduled_jobs.json")
    import src.api.scheduled_routes as scheduled_routes

    scheduled_routes._scheduled_research_store = job_store
    auth = host_routes()
    app = FastAPI()
    scheduled_routes.register_scheduled_routes(app, require_auth=auth)
    client = TestClient(app)
    headers = {"Authorization": "Bearer attention-test"}

    assert client.get("/mona/attention").status_code == 401
    default = client.get("/mona/attention", headers=headers)
    assert default.status_code == 200 and default.json()["enabled"] is False
    invalid = client.put(
        "/mona/attention",
        headers=headers,
        json=request(prefs(symbols=["600519.XS"])),
    )
    assert invalid.status_code == 422
    body = request(prefs())
    configured = client.put("/mona/attention", headers=headers, json=body)
    assert configured.status_code == 200 and configured.json()["enabled"] is True
    version = configured.json()["version"]
    assert client.put("/mona/attention", headers=headers, json=body).json()["version"] == version

    scenarios = [artifact(), artifact(artifact_id="f" * 32, symbol="000001.SZ")]
    dispatched = []
    calls = []
    fetcher = lambda **kwargs: market_fetcher(calls=calls, **kwargs)
    with patch("src.research_scenarios.list_scenarios", return_value=scenarios):
        with patch("src.market_data.fetch_market_data_json", side_effect=fetcher):
            executor = make_executor(job_store, BASE, dispatched)
            await executor.tick(BASE)

    assert len(calls) == 1 and calls[0]["source"] == "tencent"
    assert calls[0]["interval"] == "1D" and calls[0]["max_rows"] == 0
    assert len(dispatched) == 1
    assert dispatched[0].config["mona_attention"]["policy_version"] == version

    events_response = client.get("/mona/attention/events", headers=headers)
    assert events_response.status_code == 200
    events = events_response.json()["events"]
    assert len(events) == 1
    event = events[0]
    assert {
        "event_id", "kind", "symbol", "artifact_id", "session_id", "attempt_id",
        "created_at", "delivery_status", "payload",
    } <= set(event)
    assert event["kind"] == "condition_met" and event["delivery_status"] == "pending"
    assert event["payload"]["condition"]["source"] == "tencent"
    assert event["payload"]["artifact_version"] == scenarios[0]["created_at"]
    assert client.post(f"/mona/attention/events/{event['event_id']}/ack", headers=headers).status_code == 409
    assert client.post(f"/mona/attention/events/{event['event_id']}/claim", headers=headers).json() == {
        "claimed": True,
        "event_id": event["event_id"],
    }
    assert client.post(f"/mona/attention/events/{event['event_id']}/claim", headers=headers).json()["claimed"] is False
    assert client.post(f"/mona/attention/events/{event['event_id']}/ack", headers=headers).json()["delivery_status"] == "delivered"
    assert client.post(f"/mona/attention/events/{event['event_id']}/ack", headers=headers).json()["delivery_status"] == "delivered"

    import threading

    sys.modules["src.api.state"] = SimpleNamespace(_session_service=None)
    sys.modules["src.api.swarm_routes"] = SimpleNamespace(_swarm_runtime=None)
    sys.modules["src.api.alpha_routes"] = SimpleNamespace(
        _JOBS_LOCK=threading.Lock(),
        ALPHA_BENCH_JOBS={},
        ALPHA_COMPARE_JOBS={},
    )
    sys.modules["src.api.scheduled_routes"] = SimpleNamespace(
        _scheduled_research_scheduler_enabled=lambda: False
    )
    sys.modules["src.api.mona_operations"] = SimpleNamespace(active_operation_count=lambda: 0)
    from src.api.request_ledger import _activity_snapshot

    activity = _activity_snapshot()
    assert activity["active"] is True
    assert activity["work_active"] is False and activity["attention_enabled"] is True

    from src.api.request_ledger import _matches_write

    claim_scope = {"type": "http", "method": "POST", "path": f"/mona/attention/events/{event['event_id']}/claim"}
    ack_scope = {"type": "http", "method": "POST", "path": f"/mona/attention/events/{event['event_id']}/ack"}
    assert _matches_write(claim_scope) and _matches_write(ack_scope)
    assert not _matches_write({**claim_scope, "path": "/mona/attention/events/not-safe/claim"})
    assert attention_runtime_active(store)
    return {"event_id": event["event_id"], "version": version, "dispatches": len(dispatched)}


async def phase_restart(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    store = HostedAttentionStore()
    job_store = ScheduledResearchJobStore(home / "scheduled_jobs.json")
    dispatched = []
    calls = []
    with patch("src.research_scenarios.list_scenarios", return_value=[artifact()]):
        with patch(
            "src.market_data.fetch_market_data_json",
            side_effect=lambda **kwargs: market_fetcher(calls=calls, **kwargs),
        ):
            executor = make_executor(job_store, BASE + 300_000, dispatched)
            await executor.tick(BASE + 300_000)
    events = store.list_events()
    assert len(events) == 1 and events[0]["kind"] == "condition_met"
    assert not dispatched
    with sqlite3.connect(store.path) as connection:
        state = connection.execute("SELECT status FROM condition_states").fetchone()[0]
    assert state == "met"
    return {"event_count_after_restart": len(events), "condition_state": state, "fetches": len(calls)}


async def phase_modes(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    store = HostedAttentionStore()
    job_store = ScheduledResearchJobStore(home / "mode-jobs.json")
    calls = []
    dispatched = []
    with patch("src.research_scenarios.list_scenarios", return_value=[]):
        for body, at in (
            (request(prefs("manual"), True), BASE),
            (request(prefs("important_changes"), False), BASE + 300_000),
            (request(prefs("important_changes", start="12:00", end="12:30")), BASE + 600_000),
            (request(prefs("important_changes", start="09:00", end="10:00")), BASE + 900_000),
            (request(prefs("important_changes", symbols=[])), BASE + 1_200_000),
        ):
            normalized, allowed = validate_attention_request(body)
            store.set_policy(normalized, allowed)
            with patch(
                "src.market_data.fetch_market_data_json",
                side_effect=lambda **kwargs: market_fetcher(calls=calls, **kwargs),
            ):
                executor = make_executor(job_store, at, dispatched)
                await executor.tick(at)
        active, allowed = validate_attention_request(request(prefs("important_changes")))
        store.set_policy(active, allowed)
        with patch("src.market_data.fetch_market_data_json") as fetch:
            executor = make_executor(job_store, BASE + 1_500_000, dispatched)
            await executor.tick(BASE + 1_500_000)
        assert fetch.call_count == 0
    assert not calls and not dispatched
    return {"blocked_modes_and_windows": True, "fetches": 0}


async def phase_continuous(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    store = HostedAttentionStore()
    store.set_policy(*validate_attention_request(request(prefs("continuous"))))
    job_store = ScheduledResearchJobStore(home / "continuous-jobs.json")
    dispatched = []
    calls = []
    with patch("src.research_scenarios.list_scenarios", return_value=[]):
        with patch(
            "src.market_data.fetch_market_data_json",
            side_effect=lambda **kw: market_fetcher(calls=calls, **kw),
        ):
            executor = make_executor(job_store, BASE, dispatched)
            await executor.tick(BASE)
            await executor.tick(BASE + 60_000)
            await executor.tick(BASE + 300_000)
            await executor.tick(BASE + 360_000)
    assert len(dispatched) == 2
    ids = [job.id for job in dispatched]
    assert len(set(ids)) == 2
    assert all(job.config["mona_attention"]["symbol"] == SYMBOL for job in dispatched)
    assert len(calls) == 2
    return {"continuous_dispatches": len(dispatched), "distinct_job_ids": True}


async def phase_downgrade(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    policy_store = HostedAttentionStore()
    active, allowed = validate_attention_request(request(prefs()))
    policy, _ = policy_store.set_policy(active, allowed)
    job_store = ScheduledResearchJobStore(home / "downgrade-jobs.json")
    queued = ScheduledResearchJob(
        id="auto-before-fetch",
        prompt="old policy job",
        schedule="300000",
        next_run_at=BASE,
        end_at=BASE + 90_000,
        created_at=BASE - 1,
        config={"mona_attention": {"policy_version": policy["policy_version"], "symbol": SYMBOL}},
    )
    job_store.upsert(queued)
    entered, release = threading.Event(), threading.Event()
    dispatched = []
    fetcher = lambda **kwargs: market_fetcher(entered=entered, release=release, **kwargs)
    with patch("src.research_scenarios.list_scenarios", return_value=[artifact()]):
        with patch("src.market_data.fetch_market_data_json", side_effect=fetcher):
            executor = make_executor(job_store, BASE, dispatched)
            task = asyncio.create_task(executor.tick(BASE))
            assert await asyncio.to_thread(entered.wait, 5)
            manual, manual_allowed = validate_attention_request(request(prefs("manual"), True))
            policy_store.set_policy(manual, manual_allowed)
            release.set()
            await task
    updated = job_store.get(queued.id)
    assert not dispatched and updated is not None and updated.status == JobStatus.CANCELLED
    return {"dispatched": 0, "old_job_status": updated.status.value}


async def phase_stale_and_expired(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    store = HostedAttentionStore()
    prefs_value, allowed = validate_attention_request(request(prefs()))
    store.set_policy(prefs_value, allowed)
    job_store = ScheduledResearchJobStore(home / "stale-jobs.json")
    dispatched = []
    # A source-backed but stale daily bar is recorded as stale, never as met.
    stale = artifact()
    stale["as_of"] = "2026-10-08"
    with patch("src.research_scenarios.list_scenarios", return_value=[stale]):
        with patch(
            "src.market_data.fetch_market_data_json",
            side_effect=lambda **kw: market_fetcher(trade_date="2026-10-10", **kw),
        ):
            executor = make_executor(job_store, BASE, dispatched)
            await executor.tick(BASE)
    with sqlite3.connect(store.path) as connection:
        status = connection.execute("SELECT status FROM condition_states").fetchone()[0]
    assert status == "stale" and not store.list_events() and not dispatched

    # A bar without actual source provenance cannot be used as an observation.
    os.environ["VIBE_TRADING_HOME"] = str(home / "no-provenance")
    missing_store = HostedAttentionStore()
    missing_store.set_policy(prefs_value, allowed)
    missing_jobs = ScheduledResearchJobStore(home / "no-provenance" / "jobs.json")
    with patch("src.research_scenarios.list_scenarios", return_value=[artifact(artifact_id="e" * 32)]):
        with patch(
            "src.market_data.fetch_market_data_json",
            return_value=json.dumps({SYMBOL: [{"trade_date": "2026-10-15", "close": 10.5}]}),
        ):
            executor = make_executor(missing_jobs, BASE, dispatched)
            await executor.tick(BASE)
    assert not missing_store.list_events() and not dispatched

    # A future bar is discarded; it cannot satisfy the scenario.
    os.environ["VIBE_TRADING_HOME"] = str(home / "future")
    future_store = HostedAttentionStore()
    future_store.set_policy(prefs_value, allowed)
    future_jobs = ScheduledResearchJobStore(home / "future" / "jobs.json")
    with patch("src.research_scenarios.list_scenarios", return_value=[artifact(artifact_id="c" * 32)]):
        with patch(
            "src.market_data.fetch_market_data_json",
            side_effect=lambda **kw: market_fetcher(trade_date="2026-10-17", **kw),
        ):
            executor = make_executor(future_jobs, BASE, dispatched)
            await executor.tick(BASE)
    assert not future_store.list_events() and len(dispatched) == 0

    # Expired conditions are stored as expired without creating an event or fetching.
    os.environ["VIBE_TRADING_HOME"] = str(home / "expired")
    expired_store = HostedAttentionStore()
    expired_store.set_policy(prefs_value, allowed)
    expired_jobs = ScheduledResearchJobStore(home / "expired" / "jobs.json")
    expired_calls = []
    with patch(
        "src.research_scenarios.list_scenarios",
        return_value=[artifact(artifact_id="d" * 32, review_at="2026-10-15T00:00:00Z")],
    ):
        with patch(
            "src.market_data.fetch_market_data_json",
            side_effect=lambda **kw: market_fetcher(calls=expired_calls, **kw),
        ):
            executor = make_executor(expired_jobs, BASE, dispatched)
            await executor.tick(BASE)
    with sqlite3.connect(expired_store.path) as connection:
        expired_status = connection.execute("SELECT status FROM condition_states").fetchone()[0]
    assert expired_status == "expired" and not expired_store.list_events() and not expired_calls
    return {"stale": status, "future_event_count": 0, "expired": expired_status}


async def phase_terminal(home: Path) -> dict:
    os.environ["VIBE_TRADING_HOME"] = str(home)
    from src.session.events import EventBus
    from src.session.models import Message
    from src.session.service import SessionService
    from src.session.store import SessionStore
    from src.scheduled_research.hosted_firings import HostedScheduledFireStore

    policy_store = HostedAttentionStore()
    policy, allowed = validate_attention_request(request(prefs()))
    policy_row, _ = policy_store.set_policy(policy, allowed)
    job_store = ScheduledResearchJobStore(home / "terminal-jobs.json")
    job = ScheduledResearchJob(
        id="attention-terminal",
        prompt="local no-model terminal probe",
        schedule="300000",
        next_run_at=BASE,
        created_at=BASE - 1,
        config={
            "mona_attention": {
                "policy_version": policy_row["policy_version"],
                "symbol": SYMBOL,
                "source_event_ids": [],
            }
        },
    )
    job_store.upsert(job)
    running = asyncio.Event()
    finish = asyncio.Event()
    service = SessionService(
        store=SessionStore(base_dir=home / "sessions"),
        event_bus=EventBus(),
        runs_dir=home / "runs",
    )

    async def local_attempt(self, session, attempt, *, include_shell_tools=False):
        attempt.mark_running()
        self.store.update_attempt(attempt)
        running.set()
        await finish.wait()
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
        self.event_bus.emit(session.session_id, "attempt.completed", {"attempt_id": attempt.attempt_id, "status": "completed"})
        self._active_tasks.pop(session.session_id, None)
        self._release_session(session.session_id)

    service._run_attempt = types.MethodType(local_attempt, service)
    session = service.create_session(title="attention-terminal", config={})
    accepted = await service.send_message(session.session_id, "local no-model terminal probe")
    await asyncio.wait_for(running.wait(), timeout=5)
    task = service._active_tasks[session.session_id]
    fires = HostedScheduledFireStore()
    key, _record, inserted = fires.claim(job.id, BASE, job.prompt)
    assert inserted
    fires.bind_session(key, session.session_id)
    fires.mark_queued(key, session.session_id, accepted["attempt_id"])

    assert not any(event["kind"] == "research_completed" for event in events_snapshot(service, job_store))
    finish.set()
    await task
    events = events_snapshot(service, job_store)
    terminal = [event for event in events if event["kind"] == "research_completed"]
    assert len(terminal) == 1
    assert terminal[0]["attempt_id"] == accepted["attempt_id"]
    assert terminal[0]["payload"]["attempt_status"] == "completed"
    return {"queued_not_completed": True, "completed_events": len(terminal)}


async def main(phase: str, root: Path) -> None:
    phases = {
        "seed": phase_seed,
        "restart": phase_restart,
        "modes": phase_modes,
        "continuous": phase_continuous,
        "downgrade": phase_downgrade,
        "stale_expired": phase_stale_and_expired,
        "terminal": phase_terminal,
    }
    result = await phases[phase](root)
    print(json.dumps(result, sort_keys=True))


asyncio.run(main(sys.argv[1], Path(os.environ["VIBE_TRADING_HOME"])))
'''


@pytest.fixture(scope="module")
def prepared_native(tmp_path_factory: pytest.TempPathFactory) -> Path:
    destination = tmp_path_factory.mktemp("hosted-attention-native") / "prepared"
    receipt = prepare(SNAPSHOT_ROOT, destination)
    names = [patch["path"] for patch in receipt["patches"]]
    assert names.index("0015-hosted-research-scenarios.json") < names.index("0016-hosted-scheduled-firings.json")
    assert names.index("0017-hosted-runner-process-tree.json") < names.index("0018-hosted-attention-policy.json")
    return destination / "agent"


def _run_probe(native_agent: Path, home: Path, phase: str) -> dict:
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
            "VIBE_TRADING_HOME": str(home.resolve()),
            "VIBE_TRADING_HOSTED": "1",
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


def test_hosted_attention_persists_condition_and_notification_state_across_restart(
    tmp_path: Path, prepared_native: Path
) -> None:
    home = tmp_path / "attention-home"
    home.mkdir()
    seeded = _run_probe(prepared_native, home, "seed")
    restarted = _run_probe(prepared_native, home, "restart")
    assert seeded["dispatches"] == 1
    assert restarted["event_count_after_restart"] == 1
    assert restarted["condition_state"] == "met"


@pytest.mark.parametrize("phase", ["modes", "continuous", "downgrade", "stale_expired", "terminal"])
def test_hosted_attention_contract_probes(
    tmp_path: Path, prepared_native: Path, phase: str
) -> None:
    home = tmp_path / phase
    home.mkdir()
    result = _run_probe(prepared_native, home, phase)
    assert result
