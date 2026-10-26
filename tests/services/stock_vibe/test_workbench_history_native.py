"""Native, read-only workbench history projection over real SessionStore files."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

_PROBE = r'''
import json
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api import security
from src.api.mona_workbench import register_mona_workbench
from src.api.security import require_auth
from src.session.models import Attempt, AttemptStatus, Session
from src.session.store import SessionStore

home = Path(os.environ["VIBE_TRADING_HOME"])
store = SessionStore(home / "sessions")
base = datetime(2025, 1, 1, tzinfo=timezone.utc)

def stamp(seconds):
    return (base + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")

symbol = "002460.SZ"
tasks = ["comprehensive", "fundamental", "technical", "risk"]
statuses = [AttemptStatus.PENDING, AttemptStatus.RUNNING, AttemptStatus.WAITING_USER,
            AttemptStatus.COMPLETED, AttemptStatus.FAILED, AttemptStatus.CANCELLED,
            AttemptStatus.INTERRUPTED]
expected = []

for index in range(130):
    session_id = f"s{index:03d}"
    title = "Alpha report" if index % 13 == 0 else f"Research {index:03d}"
    task = tasks[index % len(tasks)]
    status = statuses[index % len(statuses)]
    attempt_id = f"a{index:03d}"
    completed_at = stamp(index + 1000) if status in {
        AttemptStatus.COMPLETED, AttemptStatus.FAILED, AttemptStatus.CANCELLED,
        AttemptStatus.INTERRUPTED,
    } else None
    session = Session(session_id=session_id, title=title, created_at=stamp(index),
        updated_at=stamp(100000 + 130 - index), last_attempt_id=attempt_id,
        config={"mona_workbench": {"symbol": symbol, "task": task, "mode": "swing"}})
    store.create_session(session)
    store.create_attempt(Attempt(attempt_id=attempt_id, session_id=session_id, status=status,
        prompt="private prompt", summary="private summary", error="private raw error",
        created_at=stamp(index), completed_at=completed_at))
    expected.append({"session_id": session_id, "attempt_id": attempt_id, "title": title,
        "task": task, "mode": "swing", "status": status.value,
        "created_at": stamp(index), "completed_at": completed_at})

# Two attempts in one native session stay as separate history rows. Their equal
# timestamps exercise the deterministic attempt_id tie-break.
multi_context = {"symbol": symbol, "task": "technical", "mode": "swing"}
store.create_session(Session(session_id="multi", title="Alpha multi", created_at=stamp(126),
    updated_at=stamp(100200), last_attempt_id="m-z", config={"mona_workbench": multi_context}))
for attempt_id, status in (("m-z", AttemptStatus.COMPLETED), ("m-a", AttemptStatus.FAILED)):
    completed_at = stamp(1300)
    store.create_attempt(Attempt(attempt_id=attempt_id, session_id="multi", status=status,
        prompt="private prompt", summary="private summary", error="private raw error",
        created_at=stamp(125), completed_at=completed_at))
    expected.append({"session_id": "multi", "attempt_id": attempt_id, "title": "Alpha multi",
        "task": "technical", "mode": "swing", "status": status.value,
        "created_at": stamp(125), "completed_at": completed_at})

# No attempt is represented as idle, never as a synthetic pending attempt.
store.create_session(Session(session_id="idle", title="Idle sample", created_at=stamp(125),
    updated_at=stamp(100201), config={"mona_workbench": multi_context}))
expected.append({"session_id": "idle", "attempt_id": None, "title": "Idle sample",
    "task": "technical", "mode": "swing", "status": "idle",
    "created_at": stamp(125), "completed_at": None})

# Valid but unrelated and malformed contexts are excluded by the native binding.
store.create_session(Session(session_id="other", title="Other stock", config={
    "mona_workbench": {"symbol": "600000.SH", "task": "technical", "mode": "swing"}}))
store.create_attempt(Attempt(attempt_id="other-attempt", session_id="other", created_at=stamp(500)))
store.create_session(Session(session_id="bad-task", title="Bad context", config={
    "mona_workbench": {"symbol": symbol, "task": "unknown", "mode": "swing"}}))
store.create_session(Session(session_id="untagged", title="Untagged"))

host = types.ModuleType("api_server")
host._get_session_service = lambda: types.SimpleNamespace(store=store)
sys.modules["api_server"] = host
app = FastAPI()
register_mona_workbench(app)

def order_key(row):
    instant = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
    return (-instant.timestamp(), row["session_id"], row["attempt_id"] or "")

expected.sort(key=order_key)
assert len(expected) == 133

with TestClient(app) as client:
    with patch.object(security, "_configured_api_key", return_value="test-only-key"):
        denied = client.get("/mona/workbench-history", params={"symbol": symbol})
        assert denied.status_code == 401, denied.text
    app.dependency_overrides[require_auth] = lambda: None

    first = client.get("/mona/workbench-history", params={"symbol": symbol, "limit": 50})
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload == {"symbol": symbol, "offset": 0, "limit": 50,
        "total": len(expected), "items": expected[:50]}
    assert set(payload["items"][0]) == {
        "session_id", "attempt_id", "title", "task", "mode", "status", "created_at", "completed_at"}
    assert "private" not in json.dumps(payload)

    pages = [payload["items"]]
    for offset in (50, 100, 150):
        page = client.get("/mona/workbench-history", params={
            "symbol": symbol, "offset": offset, "limit": 50}).json()
        assert page["total"] == len(expected)
        pages.append(page["items"])
    combined = [item for page in pages for item in page]
    first_difference = next(((index, actual, wanted) for index, (actual, wanted)
                             in enumerate(zip(combined, expected)) if actual != wanted), None)
    assert len(combined) == len(expected) and first_difference is None, (len(combined), len(expected), first_difference)
    assert len({(item["session_id"], item["attempt_id"]) for item in combined}) == len(expected)
    assert combined[-1]["session_id"] == "s000"  # updated most recently, but its attempt is oldest
    assert [item["attempt_id"] for item in combined if item["session_id"] == "multi"] == ["m-a", "m-z"]
    assert next(item for item in combined if item["session_id"] == "idle")["status"] == "idle"

    default_page = client.get("/mona/workbench-history", params={"symbol": symbol}).json()
    assert default_page["limit"] == 10 and default_page["items"] == expected[:10]
    empty_page = client.get("/mona/workbench-history", params={
        "symbol": symbol, "offset": 1000000}).json()
    assert empty_page["total"] == len(expected) and empty_page["items"] == []

    for task in tasks:
        filtered = [item for item in expected if item["task"] == task]
        result = client.get("/mona/workbench-history", params={
            "symbol": symbol, "task": task, "limit": 50}).json()
        assert result["total"] == len(filtered) and result["items"] == filtered[:50]
    state_groups = {
        "completed": {"completed"},
        "active": {"pending", "running", "waiting_user", "idle"},
        "unfinished": {"failed", "cancelled", "interrupted"},
    }
    for state, statuses_for_state in state_groups.items():
        filtered = [item for item in expected if item["status"] in statuses_for_state]
        result = client.get("/mona/workbench-history", params={
            "symbol": symbol, "state": state, "limit": 50}).json()
        assert result["total"] == len(filtered) and result["items"] == filtered[:50]
    alpha = [item for item in expected if "alpha" in item["title"].casefold()]
    result = client.get("/mona/workbench-history", params={
        "symbol": symbol, "q": " ALPHA ", "limit": 50}).json()
    assert result["total"] == len(alpha) and result["items"] == alpha[:50]
    assert client.get("/mona/workbench-history", params={
        "symbol": symbol, "q": "Research 00."}).json()["total"] == 0

    invalid = [
        {},
        {"symbol": "bad"},
        {"symbol": symbol, "unexpected": "1"},
        [("symbol", symbol), ("symbol", symbol)],
        [("symbol", symbol), ("q", "a"), ("q", "b")],
        {"symbol": symbol, "q": "x" * 121},
        {"symbol": symbol, "q": "bad\u0007query"},
        {"symbol": symbol, "task": "unknown"},
        {"symbol": symbol, "state": "failed"},
        {"symbol": symbol, "offset": -1},
        {"symbol": symbol, "offset": 1000001},
        {"symbol": symbol, "offset": "1.5"},
        {"symbol": symbol, "limit": 0},
        {"symbol": symbol, "limit": 51},
        [("symbol", symbol), ("task", "all"), ("task", "risk")],
    ]
    for params in invalid:
        response = client.get("/mona/workbench-history", params=params)
        assert response.status_code == 422, (params, response.status_code, response.text)

print(json.dumps({"all_sessions_and_attempts": True, "stable_pagination": True,
    "symbol_isolation": True, "filters": True, "idle": True, "strict_query": True,
    "auth": True}))
'''


def test_native_workbench_history_projects_all_real_records() -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    with tempfile.TemporaryDirectory(prefix="workbench-history-", dir=ROOT / ".codex_tmp") as temporary:
        temp_root = Path(temporary)
        source = temp_root / "source"
        receipt = prepare(ROOT / "third_party/vibe-trading", source)
        assert any(item["path"] == "0040-workbench-history.json" for item in receipt["patches"])
        home = temp_root / "native-home"
        home.mkdir()
        allowed_environment = {
            "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
            "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
        }
        environment = {key: value for key, value in os.environ.items() if key.upper() in allowed_environment}
        environment.update(
            PYTHONPATH=str(source / "agent"),
            PYTHONUTF8="1",
            PYTHONDONTWRITEBYTECODE="1",
            PYTHONNOUSERSITE="1",
            VIBE_TRADING_HOME=str(home),
            VIBE_TRADING_HOSTED="1",
            PYTHON_DOTENV_DISABLED="1",
        )
        completed = subprocess.run(
            [str(PYTHON), "-B", "-c", _PROBE],
            cwd=source / "agent",
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=90,
            check=False,
        )
        assert completed.returncode == 0, completed.stdout + completed.stderr
        assert all(json.loads(completed.stdout.splitlines()[-1]).values())
