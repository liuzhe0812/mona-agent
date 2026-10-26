from __future__ import annotations

import json
import os
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.runtime import StockVibeRuntime
from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PREFIX = "/api/stock-vibe"
CONTEXT = {"symbol": "002460.SZ", "task": "technical", "mode": "swing"}


async def host_client(tmp_path, monkeypatch, upstream):
    _resolve_tool_config_refs()
    runtime = StockVibeRuntime(runtime_root=tmp_path / "components", data_root=tmp_path / "native",
                               config_loader=lambda: Config())

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(upstream)) as native:
            yield native

    monkeypatch.setattr(runtime, "lease", lease)
    monkeypatch.setattr(runtime, "source_identity", lambda: {
        "snapshot_id": "sha256:" + "a" * 64, "patches": [],
        "instance_id": "b" * 32, "data_root_sha256": "c" * 64,
    })
    app = web.Application()
    register_stock_vibe_routes(app, runtime=runtime)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


async def test_workbench_partial_portfolio_failure_is_explicit(tmp_path, monkeypatch):
    def native(request):
        if request.url.path == "/api/portfolio":
            return httpx.Response(502, json={"detail": "private upstream detail"})
        assert request.url.path == "/mona/workbench"
        assert dict(request.url.params) == {"symbol": CONTEXT["symbol"]}
        return httpx.Response(200, json={"symbol": CONTEXT["symbol"], "sessions": [], "latest_report": None,
                                        "scheduled_jobs": [], "scheduler": None, "errors": []})

    client = await host_client(tmp_path, monkeypatch, native)
    async with client:
        response = await client.get(PREFIX + "/workbench", params={"symbol": CONTEXT["symbol"]})
        assert response.status == 200
        payload = (await response.json())["native"]
        assert payload["portfolio"] is None
        assert payload["errors"] == [{"section": "portfolio", "code": "read_failed"}]
        assert "private" not in json.dumps(payload)


async def test_workbench_writes_translate_context_and_keep_cancellation_idempotent(tmp_path, monkeypatch):
    calls, receipts, jobs = [], {}, {}

    def native(request):
        path, method = request.url.path, request.method
        calls.append((method, path))
        if path.startswith("/mona/requests/"):
            return httpx.Response(200, json=receipts[path.rsplit("/", 1)[-1]])
        if method == "GET":
            if path.endswith("/other"):
                return httpx.Response(200, json={"config": {}})
            value = jobs.get(path.rsplit("/", 1)[-1])
            return httpx.Response(200 if value else 404, json=value)
        body = json.loads(request.content) if request.content else None
        request_id = request.headers["X-Mona-Request-ID"]
        if method == "POST" and path == "/sessions":
            assert body == {"title": "走势分析", "config": {"mona_workbench": CONTEXT}}
            result, code = {"session_id": "session-1"}, 201
        elif method == "POST":
            assert body["config"] == {"mona_workbench": CONTEXT}
            assert "workbench" not in body and "delivery_channel" not in body
            jobs[body["id"]] = body
            result, code = body, 201
        else:
            jobs.pop(path.rsplit("/", 1)[-1])
            result, code = None, 204
        receipts[request_id] = {"request_id": request_id, "status": "completed",
                                "receipt": {"status_code": code, "body": result}}
        return httpx.Response(code, json=result) if code != 204 else httpx.Response(code)

    client = await host_client(tmp_path, monkeypatch, native)
    async with client:
        created = await client.post(PREFIX + "/sessions", json={"title": "走势分析", "workbench": CONTEXT},
                                    headers={"X-Mona-Request-ID": uuid.uuid4().hex})
        assert created.status == 200, await created.text()
        schedule = {"id": "follow-stock-1", "title": "定时走势分析", "prompt": "研究002460的走势",
                    "schedule": "0 16 * * 1-5", "timezone": "Asia/Shanghai", "workbench": CONTEXT}
        headers = {"X-Mona-Request-ID": uuid.uuid4().hex}
        for _ in range(2):
            response = await client.post(PREFIX + "/scheduled-runs", json=schedule, headers=headers)
            assert response.status == 200, await response.text()
        assert calls.count(("POST", "/scheduled-runs")) == 1
        schedule["prompt"] = "different"
        assert (await client.post(PREFIX + "/scheduled-runs", json=schedule, headers=headers)).status == 409
        assert (await client.delete(PREFIX + "/scheduled-runs/other",
                                    headers={"X-Mona-Request-ID": uuid.uuid4().hex})).status == 404
        cancel_headers = {"X-Mona-Request-ID": uuid.uuid4().hex}
        for _ in range(2):
            response = await client.delete(PREFIX + "/scheduled-runs/follow-stock-1", headers=cancel_headers)
            assert response.status == 200, await response.text()
        assert calls.count(("DELETE", "/scheduled-runs/follow-stock-1")) == 1
        assert calls.count(("GET", "/scheduled-runs/follow-stock-1")) == 1


async def test_workbench_market_queries_are_narrow_and_keep_unavailable_payloads(tmp_path, monkeypatch):
    calls = []

    def native(request):
        calls.append(request)
        return httpx.Response(200, json={"symbol": CONTEXT["symbol"], "interval": "intraday",
                                        "status": "unavailable", "reason": "insufficient_history"})

    client = await host_client(tmp_path, monkeypatch, native)
    async with client:
        for path in ("workbench-market", "forecast"):
            response = await client.get(PREFIX + "/" + path, params={"symbol": CONTEXT["symbol"], "interval": "intraday"})
            assert response.status == 200
            assert (await response.json())["native"]["status"] == "unavailable"
            assert (await client.get(PREFIX + "/" + path + "?symbol=002460.SZ&interval=1m")).status == 400
            assert (await client.get(PREFIX + "/" + path + "?symbol=002460.SZ&symbol=000001.SZ")).status == 400
            assert (await client.get(PREFIX + "/" + path + "?symbol=002460.SZ&url=http://private")).status == 400
        assert [request.url.path for request in calls] == ["/mona/workbench-market", "/mona/workbench-forecast"]


_NATIVE_PROBE = r'''
import json
import os
import sys
import types
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.security import require_auth
from src.api.mona_workbench import register_mona_workbench
from src.api.request_ledger import register_native_request_ledger
from src.api.scheduled_routes import register_scheduled_routes, _get_scheduled_research_store
from src.session.events import EventBus
from src.session.models import Attempt, AttemptStatus, Session
from src.session.service import SessionService
from src.session.store import SessionStore

home = Path(os.environ["VIBE_TRADING_HOME"])
store = SessionStore(home / "sessions")
service = SessionService(store=store, event_bus=EventBus(), runs_dir=home / "runs")
host = types.ModuleType("api_server")
host.require_auth = require_auth
host._get_session_service = lambda: service
host._validate_path_param = lambda value, kind: None
sys.modules["api_server"] = host
context = {"symbol": "002460.SZ", "task": "technical", "mode": "swing"}
session = service.create_session(title="actual research", config={"mona_workbench": context})
store.create_session(Session(session_id="title-only", title="002460.SZ", config={}))
store.create_session(Session(session_id="other-stock", config={"mona_workbench": {**context, "symbol": "002460.SH"}}))
report = Attempt(session_id=session.session_id)
report.mark_completed("Actual persisted report with [source](https://example.com)")
store.update_attempt(report)
pending = Attempt(session_id=session.session_id)
store.update_attempt(pending)
session.last_attempt_id = pending.attempt_id
store.update_session(session)

app = FastAPI()
register_scheduled_routes(app)
register_mona_workbench(app)
register_native_request_ledger(app, require_auth)
with TestClient(app) as client:
    job = {"id": "follow-stock", "title": "follow", "prompt": "technical research", "schedule": "60000",
           "timezone": "Asia/Shanghai", "config": {"mona_workbench": context}}
    headers = {"X-Mona-Request-ID": "create-schedule"}
    first = client.post("/scheduled-runs", json=job, headers=headers)
    assert first.status_code == 201, first.text
    second = client.post("/scheduled-runs", json=job, headers=headers)
    assert second.status_code == 201 and second.json() == first.json()
    scheduled = _get_scheduled_research_store()
    assert len(scheduled.load()) == 1
    changed = {**job, "config": {"mona_workbench": {**context, "symbol": "600000.SH"}}}
    conflict = client.post("/scheduled-runs", json=changed, headers={"X-Mona-Request-ID": "change-context"})
    assert conflict.status_code == 409, conflict.text
    result = client.get("/mona/workbench", params={"symbol": "002460.SZ"})
    assert result.status_code == 200, result.text
    payload = result.json()
    assert len(payload["sessions"]) == 1
    assert payload["sessions"][0]["attempt"]["status"] == "pending"
    assert payload["latest_report"]["attempt_id"] == report.attempt_id
    assert payload["latest_report"]["summary"] == report.summary
    assert payload["latest_report"]["completed_at"] == report.completed_at
    assert "run_dir" not in json.dumps(payload) and "config" not in payload["sessions"][0]
    assert len(payload["scheduled_jobs"]) == 1 and payload["errors"] == []
    assert client.get("/mona/workbench", params={"symbol": "bad"}).status_code == 422
    empty = client.get("/mona/workbench", params={"symbol": "600000.SH"}).json()
    assert empty["sessions"] == [] and empty["latest_report"] is None and empty["scheduled_jobs"] == []
    scheduled.path.write_text("invalid-json", encoding="utf-8")
    broken = client.get("/mona/workbench", params={"symbol": "002460.SZ"}).json()
    assert broken["latest_report"]["attempt_id"] == report.attempt_id
    assert broken["errors"] == [{"section": "scheduled", "code": "read_failed"}]
print("WORKBENCH_NATIVE_OK")
'''


def test_native_workbench_reads_real_records_and_native_schedule_ledger(tmp_path):
    native_python = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"
    if not native_python.is_file():
        pytest.skip("isolated native dependency environment is required")
    native = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", native)
    safe_names = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}
    env = {key: value for key, value in os.environ.items() if key.upper() in safe_names}
    env.update(PYTHONPATH=str(native / "agent"), PYTHONUTF8="1", PYTHON_DOTENV_DISABLED="1",
               VIBE_TRADING_HOME=str(tmp_path / "native-state"), VIBE_TRADING_HOSTED="1")
    result = subprocess.run([str(native_python), "-c", _NATIVE_PROBE], cwd=native / "agent", env=env,
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "WORKBENCH_NATIVE_OK" in result.stdout
