from __future__ import annotations

import importlib.util
import json
import secrets
import sqlite3
import sys
import threading
import types
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
from starlette.testclient import TestClient

from tools.stock_vibe.prepare import prepare

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = REPO_ROOT / "third_party" / "vibe-trading"
PATCH_PATH = SNAPSHOT_ROOT / "patches" / "0004-host-requests.json"
TEST_TOKEN = secrets.token_urlsafe(32)


def _load_native_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    patch = json.loads(PATCH_PATH.read_text(encoding="utf-8"))
    source = patch["additions"]["agent/src/api/request_ledger.py"]
    module_path = tmp_path / "native_agent" / "src" / "api" / "request_ledger.py"
    module_path.parent.mkdir(parents=True)
    module_path.write_text(source, encoding="utf-8")

    for name in ("src", "src.api", "src.config"):
        package = types.ModuleType(name)
        package.__path__ = []  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, name, package)

    security = types.ModuleType("src.api.security")

    def validate_api_auth(*, request: Request, cred: Any, allow_query: bool = False):
        if cred is not None and cred.scheme.lower() == "bearer" and cred.credentials == TEST_TOKEN:
            return True
        raise HTTPException(status_code=401, detail="Invalid or missing API key")

    security._validate_api_auth = validate_api_auth  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "src.api.security", security)

    paths = types.ModuleType("src.config.paths")
    paths.get_runtime_root = lambda: tmp_path / "native-home"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "src.config.paths", paths)

    spec = importlib.util.spec_from_file_location("native_request_ledger_under_test", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def _require_auth(request: Request):
    authorization = request.headers.get("authorization", "")
    scheme, separator, credential = authorization.partition(" ")
    auth = (
        HTTPAuthorizationCredentials(scheme=scheme, credentials=credential.strip())
        if separator and scheme.lower() == "bearer" and credential.strip()
        else None
    )
    from src.api.security import _validate_api_auth

    return _validate_api_auth(request=request, cred=auth, allow_query=False)


def _auth_headers(request_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {TEST_TOKEN}", "X-Mona-Request-ID": request_id}


def test_patch_prepares_from_locked_snapshot(tmp_path: Path) -> None:
    destination = tmp_path / "prepared-native"
    receipt = prepare(SNAPSHOT_ROOT, destination)

    assert [patch["path"] for patch in receipt["patches"]][:4] == [
        "0001-host-isolation.json",
        "0002-cli-host-alias.json",
        "0003-shadow-data-source.json",
        "0004-host-requests.json",
    ]
    assert (destination / "agent" / "src" / "api" / "request_ledger.py").is_file()
    assert "register_native_request_ledger(app, require_auth)" in (
        destination / "agent" / "api_server.py"
    ).read_text(encoding="utf-8")


def test_hosted_write_claims_replay_conflict_and_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VIBE_TRADING_HOSTED", "1")
    module = _load_native_module(tmp_path, monkeypatch)
    app = FastAPI()
    module.register_native_request_ledger(app, _require_auth)
    effects: list[dict[str, Any]] = []
    failure_calls: list[int] = []
    rejected_calls: list[int] = []

    @app.post("/sessions")
    async def create_session(payload: dict[str, Any]):
        effects.append(payload)
        return JSONResponse({"session_id": f"session-{len(effects)}"}, status_code=201)

    @app.post("/swarm/runs")
    async def fail_after_claim():
        failure_calls.append(1)
        return JSONResponse({"detail": "native handler failed"}, status_code=503)

    @app.post("/scheduled-runs")
    async def reject_request():
        rejected_calls.append(1)
        return JSONResponse({"detail": "invalid schedule"}, status_code=422)

    body = b'{"title":"one"}'
    with TestClient(app) as client:
        unauthorized = client.post(
            "/sessions",
            content=body,
            headers={"Content-Type": "application/json", "X-Mona-Request-ID": "unauthorized"},
        )
        assert unauthorized.status_code == 401
        assert client.get("/mona/requests/unauthorized", headers=_auth_headers("ignored")).status_code == 404

        first = client.post(
            "/sessions",
            content=body,
            headers={"Content-Type": "application/json", **_auth_headers("session-create")},
        )
        replay = client.post(
            "/sessions",
            content=body,
            headers={"Content-Type": "application/json", **_auth_headers("session-create")},
        )
        conflict = client.post(
            "/sessions",
            content=b'{"title":"different"}',
            headers={"Content-Type": "application/json", **_auth_headers("session-create")},
        )
        missing_id = client.post(
            "/sessions", content=body, headers={"Content-Type": "application/json", "Authorization": f"Bearer {TEST_TOKEN}"}
        )

        assert first.status_code == 201
        assert replay.status_code == first.status_code
        assert replay.content == first.content
        assert conflict.status_code == 409
        assert missing_id.status_code == 400
        assert len(effects) == 1

        receipt = client.get("/mona/requests/session-create", headers=_auth_headers("ignored"))
        assert receipt.status_code == 200
        assert receipt.json() == {
            "request_id": "session-create",
            "status": "completed",
            "receipt": {"status_code": 201, "body": first.json()},
        }
        database = tmp_path / "native-home" / "mona-requests.sqlite3"
        with sqlite3.connect(database) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(requests)")}
            stored_sha, stored_state = connection.execute(
                "SELECT payload_sha256, status FROM requests WHERE request_id = ?",
                ("session-create",),
            ).fetchone()
        assert len(stored_sha) == 64 and stored_state == "completed"
        assert not {"request_body", "authorization", "auth_header"} & columns
        database_bytes = database.read_bytes()
        assert TEST_TOKEN.encode() not in database_bytes
        assert body not in database_bytes

        started_scope = {
            "method": "POST",
            "path": "/sessions",
            "raw_path": b"/sessions",
            "query_string": b"",
        }
        started_id = "recovered-started"
        payload_sha = module._fingerprint(started_scope, body)
        module.RequestLedger().claim(started_id, payload_sha)
        unknown = client.post(
            "/sessions",
            content=body,
            headers={"Content-Type": "application/json", **_auth_headers(started_id)},
        )
        assert unknown.status_code == 409
        assert unknown.json() == {"request_id": started_id, "status": "unknown"}
        unknown_status = client.get(f"/mona/requests/{started_id}", headers=_auth_headers("ignored"))
        assert unknown_status.json() == {"request_id": started_id, "status": "unknown"}

        server_error = client.post(
            "/swarm/runs",
            json={"preset_name": "fixture"},
            headers=_auth_headers("server-error"),
        )
        server_error_retry = client.post(
            "/swarm/runs",
            json={"preset_name": "fixture"},
            headers=_auth_headers("server-error"),
        )
        assert server_error.status_code == 503
        assert server_error_retry.status_code == 409
        assert server_error_retry.json()["status"] == "unknown"
        assert len(failure_calls) == 1

        rejected = client.post(
            "/scheduled-runs",
            json={"schedule": "bad"},
            headers=_auth_headers("known-rejection"),
        )
        rejected_retry = client.post(
            "/scheduled-runs",
            json={"schedule": "bad"},
            headers=_auth_headers("known-rejection"),
        )
        assert rejected.status_code == rejected_retry.status_code == 422
        assert rejected.content == rejected_retry.content
        assert len(rejected_calls) == 1


def test_non_hosted_api_is_unchanged_and_excluded_paths_are_not_claimed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VIBE_TRADING_HOSTED", raising=False)
    module = _load_native_module(tmp_path, monkeypatch)
    app = FastAPI()
    module.register_native_request_ledger(app, _require_auth)
    calls: list[int] = []

    @app.post("/sessions")
    async def create_session():
        calls.append(1)
        return {"status": "created"}

    with TestClient(app) as client:
        response = client.post("/sessions")
        assert response.status_code == 200
        assert client.get("/mona/requests/any-id").status_code == 404
    assert calls == [1]

    assert module._matches_write({"type": "http", "method": "POST", "path": "/sessions"})
    for method, path in (
        ("POST", "/auth/sse-ticket"),
        ("POST", "/system/shutdown"),
        ("POST", "/upload"),
        ("GET", "/sessions/session-1/events"),
        ("PUT", "/api/portfolio/settings"),
    ):
        assert not module._matches_write({"type": "http", "method": method, "path": path})


def test_activity_is_a_locked_read_only_projection_and_fails_on_bad_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = _load_native_module(tmp_path, monkeypatch)

    state = types.ModuleType("src.api.state")
    state._session_service = types.SimpleNamespace(
        _inflight_lock=threading.Lock(), _inflight={"session-1"}
    )
    swarm = types.ModuleType("src.api.swarm_routes")
    swarm._swarm_runtime = types.SimpleNamespace(
        _lock=threading.Lock(), _cancel_events={"run-1": object()}
    )
    alpha = types.ModuleType("src.api.alpha_routes")
    alpha._JOBS_LOCK = threading.Lock()
    alpha.ALPHA_BENCH_JOBS = {"bench-1": {"status": "queued"}, "done": {"status": "done"}}
    alpha.ALPHA_COMPARE_JOBS = {"compare-1": {"status": "running"}}
    scheduled = types.ModuleType("src.api.scheduled_routes")
    scheduled._scheduled_research_scheduler_enabled = lambda: False
    for name, module_value in (
        ("src.api.state", state),
        ("src.api.swarm_routes", swarm),
        ("src.api.alpha_routes", alpha),
        ("src.api.scheduled_routes", scheduled),
    ):
        monkeypatch.setitem(sys.modules, name, module_value)

    assert module._activity_snapshot() == {
        "session_inflight": 1,
        "swarm_active": 1,
        "alpha_bench_active": 1,
        "alpha_compare_active": 1,
        "scheduler_enabled": False,
        "active": True,
    }

    state._session_service = None
    swarm._swarm_runtime = None
    alpha.ALPHA_BENCH_JOBS.clear()
    alpha.ALPHA_COMPARE_JOBS.clear()
    scheduled._scheduled_research_scheduler_enabled = lambda: True
    scheduler_only = module._activity_snapshot()
    assert scheduler_only["scheduler_enabled"] is True
    assert scheduler_only["active"] is True
    assert scheduler_only["session_inflight"] == scheduler_only["swarm_active"] == 0
    assert scheduler_only["alpha_bench_active"] == scheduler_only["alpha_compare_active"] == 0

    state._session_service = object()
    with pytest.raises(AttributeError):
        module._activity_snapshot()
