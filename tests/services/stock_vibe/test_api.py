from __future__ import annotations

import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.paths import get_managed_runtimes_dir
from mona.config.schema import Config, _resolve_tool_config_refs
from mona.materials.auth import get_services_token, materials_auth_middleware
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.python_env import PythonEnvironmentBuilder
from mona.services.stock_vibe.api import register_stock_vibe_routes
from mona.services.stock_vibe.requests import RequestStore
from mona.services.stock_vibe.runtime import StockVibeRuntime, StockVibeUnavailableError

REPO_ROOT = Path(__file__).resolve().parents[3]
PREFIX = "/api/stock-vibe"


def _installed() -> Path:
    root = Path(os.environ.get("STOCK_VIBE_RUNTIME_ROOT") or get_managed_runtimes_dir()).resolve()
    store = RuntimeComponentStore(root)
    active = store.active("stock-vibe")
    if active is None:
        pytest.skip("requires an active Stock Vibe runtime component")
    manifest, _bundle = active
    ref = f"{manifest.id}@{manifest.version}"
    python = PythonEnvironmentBuilder(root, store, environment="stock-vibe").python_for([ref])
    if python is None:
        pytest.skip("requires the active Stock Vibe Python environment")
    return root


async def _app(tmp_path, monkeypatch, *, installed=None, model_writer=None, data_settings_writer=None):
    _resolve_tool_config_refs()
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "mona"))
    monkeypatch.delenv("MONA_SERVICES_TOKEN", raising=False)
    config = Config()
    config.stock_vibe.model_preset = None
    runtime = StockVibeRuntime(runtime_root=installed or tmp_path / "no-runtime", data_root=tmp_path / "stock-vibe/native",
                               config_loader=lambda: config)
    def write_attention(values):
        for key, value in values.items():
            setattr(config.stock_vibe, key, value)

    def write_data_settings(value):
        config.stock_vibe.tushare_token = value

    app = web.Application(middlewares=[materials_auth_middleware])
    register_stock_vibe_routes(app, runtime=runtime,
                               model_writer=lambda value: model_writer(config, value) if model_writer else setattr(config.stock_vibe, "model_preset", value),
                               attention_writer=write_attention,
                               data_settings_writer=data_settings_writer or write_data_settings)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, runtime, {"X-Mona-Token": get_services_token()}


async def test_default_routes_are_authenticated_and_need_no_ownership_record(tmp_path, monkeypatch):
    client, runtime, headers = await _app(tmp_path, monkeypatch)
    async with client:
        assert (await client.get(PREFIX)).status == 401
        status = await client.get(PREFIX, headers=headers)
        status_payload = await status.json()
        assert status_payload["execution_allowed"] is True
        assert status_payload["tushare_token_configured"] is False
        assert (await client.post(PREFIX + "/sessions", json={"title": "unauthenticated"})).status == 401
        assert (await client.get(PREFIX + "/events")).status == 401
        assert (await client.get(PREFIX + "/events/ticket")).status == 401
        assert runtime._process is None
        assert not runtime.data_root.exists()
        assert not (tmp_path / "mona" / "stock-execution").exists()


async def test_retired_lab_routes_and_inputs_do_not_dispatch_native_work(tmp_path, monkeypatch):
    client, runtime, headers = await _app(tmp_path, monkeypatch)
    async with client:
        for path in ("/strategy-lab", "/strategy-lab/compare?left=a&right=b", "/strategy-lab/experiments/old-run"):
            assert (await client.get(PREFIX + path, headers=headers)).status == 404
        for body in ({"operation": "strategy_lab_test", "template_id": "low_volatility", "mode": "swing"},
                     {"operation": "strategy_lab_save", "experiment_id": "old-run", "title": "旧方法"}):
            response = await client.post(PREFIX + "/operations", json=body,
                                        headers={**headers, "X-Mona-Request-ID": uuid.uuid4().hex})
            assert response.status == 400
        response = await client.post(PREFIX + "/sessions", json={"strategy_lab": {}},
                                     headers={**headers, "X-Mona-Request-ID": uuid.uuid4().hex})
        assert response.status == 400
        assert runtime._process is None
        assert not runtime.data_root.exists()


@pytest.mark.parametrize("status", ["pending", "ok", "unavailable"])
async def test_forecast_progress_uses_authenticated_non_cached_reads(tmp_path, monkeypatch, status):
    client, runtime, headers = await _app(tmp_path, monkeypatch)
    calls = []

    def native(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.url.path == "/mona/workbench-forecast"
        assert dict(request.url.params) == {"symbol": "002460.SZ", "interval": "1D"}
        return httpx.Response(200, json={"symbol": "002460.SZ", "interval": "1D", "status": status,
                                        "experimental": True, "phase": "validation", "retry_after_ms": 2000})

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as upstream:
            yield upstream

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        assert (await client.get(PREFIX + "/forecast?symbol=002460.SZ&interval=1D")).status == 401
        assert calls == []
        response = await client.get(PREFIX + "/forecast?symbol=002460.SZ&interval=1D", headers=headers)
        assert response.status == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert (await response.json())["native"]["status"] == status
        assert len(calls) == 1


async def test_status_exposes_only_tushare_configured_boolean(tmp_path, monkeypatch):
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    client, runtime, headers = await _app(tmp_path, monkeypatch)
    secret = "synthetic-tushare-status-sentinel"
    runtime.config_loader().stock_vibe.tushare_token = secret
    async with client:
        response = await client.get(PREFIX, headers=headers)
        payload = await response.json()
        assert response.status == 200
        assert payload["tushare_token_configured"] is True
        assert secret not in json.dumps(payload)
        assert runtime._process is None


async def test_data_settings_read_only_exposes_effective_token_source(tmp_path, monkeypatch):
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    local_secret = f"synthetic-{uuid.uuid4().hex}"
    env_secret = f"synthetic-{uuid.uuid4().hex}"
    async with client:
        assert (await client.get(PREFIX + "/data-settings")).status == 401
        empty = await client.get(PREFIX + "/data-settings", headers=auth)
        assert await empty.json() == {"tushare_configured": False, "source": "unconfigured"}

        runtime.config_loader().stock_vibe.tushare_token = local_secret
        local = await client.get(PREFIX + "/data-settings", headers=auth)
        local_payload = await local.json()
        assert local_payload == {"tushare_configured": True, "source": "settings"}
        assert local_secret not in await local.text()

        monkeypatch.setenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", env_secret)
        environment = await client.get(PREFIX + "/data-settings", headers=auth)
        assert await environment.json() == {"tushare_configured": True, "source": "environment"}
        assert env_secret not in await environment.text()

        monkeypatch.setenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", "")
        empty_environment = await client.get(PREFIX + "/data-settings", headers=auth)
        assert await empty_environment.json() == {"tushare_configured": False, "source": "environment"}
        assert local_secret not in await empty_environment.text()
        assert env_secret not in await empty_environment.text()
        assert runtime._process is None


async def test_data_settings_write_uses_hashed_request_and_redacted_receipt(tmp_path, monkeypatch):
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    writes = []
    client, runtime, auth = await _app(
        tmp_path, monkeypatch, data_settings_writer=lambda value: (writes.append(value), setattr(runtime.config_loader().stock_vibe, "tushare_token", value))
    )
    secret = f"synthetic-{uuid.uuid4().hex}"
    request_id = uuid.uuid4().hex
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        assert (await client.put(PREFIX + "/data-settings", json={"tushare_token": secret})).status == 401
        response = await client.put(PREFIX + "/data-settings", headers=headers, json={"tushare_token": secret})
        receipt = await response.json()
        assert response.status == 200
        assert receipt["status"] == "completed" and receipt["receipt_owner"] == "mona_settings"
        assert receipt["receipt"]["body"] == {"tushare_configured": True, "source": "settings"}
        assert secret not in await response.text()
        assert writes == [secret]

        request = RequestStore(runtime.data_root.parent / "host" / "requests.sqlite3")
        persisted = request.get(request_id)
        assert persisted["path"] == "/host/data-settings"
        assert persisted["receipt_owner"] == "mona_settings"
        assert persisted["receipt"]["body"] == {"tushare_configured": True, "source": "settings"}
        assert "payload" not in persisted and len(persisted["payload_sha256"]) == 64
        assert secret.encode() not in request.path.read_bytes()

        duplicate = await client.put(PREFIX + "/data-settings", headers=headers, json={"tushare_token": secret})
        assert (await duplicate.json())["receipt"] == receipt["receipt"]
        conflict = await client.put(PREFIX + "/data-settings", headers=headers, json={"tushare_token": "different"})
        assert conflict.status == 409
        assert writes == [secret]

        invalid_headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
        assert (await client.put(PREFIX + "/data-settings", headers=invalid_headers, json={"tushare_token": secret, "extra": "no"})).status == 400
        assert (await client.put(PREFIX + "/data-settings", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json={"tushare_token": "x" * 513})).status == 400
        assert writes == [secret]
        assert runtime._process is None


@pytest.mark.parametrize("commit_before_error,expected_status", [(True, "completed"), (False, "unknown")])
async def test_data_settings_unknown_receipt_is_reconciled_without_replay(tmp_path, monkeypatch, commit_before_error, expected_status):
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    secret = f"synthetic-{uuid.uuid4().hex}"
    writes = []

    def lost_after_possible_commit(value):
        writes.append(value)
        if commit_before_error:
            config.stock_vibe.tushare_token = value
        raise OSError("fixture write acknowledgement lost")

    client, runtime, auth = await _app(tmp_path, monkeypatch, data_settings_writer=lost_after_possible_commit)
    config = runtime.config_loader()
    request_id = uuid.uuid4().hex
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        submitted = await client.put(PREFIX + "/data-settings", headers=headers, json={"tushare_token": secret})
        assert submitted.status == 202 and (await submitted.json())["status"] == "unknown"
        recovered = await client.get(PREFIX + f"/requests/{request_id}", headers=auth)
        record = await recovered.json()
        assert record["status"] == expected_status
        assert writes == [secret]
        assert secret not in await recovered.text()
        if commit_before_error:
            assert record["receipt"]["body"] == {"tushare_configured": True, "source": "settings"}
        else:
            assert record["receipt"] is None
        request = RequestStore(runtime.data_root.parent / "host" / "requests.sqlite3")
        assert secret.encode() not in request.path.read_bytes()


async def test_data_settings_clear_only_clears_local_value(tmp_path, monkeypatch):
    monkeypatch.delenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", raising=False)
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    local_secret = f"synthetic-{uuid.uuid4().hex}"
    env_secret = f"synthetic-{uuid.uuid4().hex}"
    runtime.config_loader().stock_vibe.tushare_token = local_secret
    async with client:
        clear = await client.put(PREFIX + "/data-settings", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json={"tushare_token": "  "})
        assert clear.status == 200
        clear_payload = await clear.json()
        assert clear_payload["receipt"]["body"] == {"tushare_configured": False, "source": "unconfigured"}
        assert runtime.config_loader().stock_vibe.tushare_token == ""

        runtime.config_loader().stock_vibe.tushare_token = local_secret
        monkeypatch.setenv("MONA_STOCK_VIBE__TUSHARE_TOKEN", env_secret)
        still_configured = await client.put(PREFIX + "/data-settings", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json={"tushare_token": ""})
        payload = await still_configured.json()
        assert payload["receipt"]["body"] == {"tushare_configured": True, "source": "environment"}
        assert runtime.config_loader().stock_vibe.tushare_token == ""
        assert env_secret not in await still_configured.text()


def test_save_data_settings_uses_local_config_writer_and_clears_value(tmp_path, monkeypatch):
    from mona.config.loader import load_config
    from mona.services.stock_vibe import settings

    path = tmp_path / "config.json"
    monkeypatch.setattr(settings, "get_config_path", lambda: path)
    secret = f"synthetic-{uuid.uuid4().hex}"
    settings.save_data_settings(secret)
    assert load_config(path).stock_vibe.tushare_token == secret
    settings.save_data_settings("")
    assert load_config(path).stock_vibe.tushare_token == ""


async def test_journal_session_lookup_and_creation_keep_the_original_operation(tmp_path, monkeypatch):
    from mona.services.stock_vibe import api

    client, runtime, auth = await _app(tmp_path, monkeypatch)
    operation_id = "b" * 32
    reads, writes = [], []

    def native(request):
        reads.append(request)
        assert dict(request.url.params) == {"limit": "1", "journal_operation_id": operation_id}
        return httpx.Response(200, json=[{"session_id": "review-session", "journal_operation_id": operation_id}])

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(native)) as upstream:
            yield upstream

    async def submit(request, request_id, method, path, payload, **kwargs):
        writes.append((request_id, method, path, payload))
        return {"request_id": request_id, "status": "completed"}

    monkeypatch.setattr(runtime, "lease", lease)
    monkeypatch.setattr(api, "_submit", submit)
    async with client:
        assert (await client.get(PREFIX + "/sessions?journal_operation_id=" + operation_id)).status == 401
        assert (await client.get(PREFIX + "/sessions?journal_operation_id=../outside", headers=auth)).status == 400
        response = await client.get(PREFIX + "/sessions", params={"limit": 1, "journal_operation_id": operation_id}, headers=auth)
        assert response.status == 200
        assert (await response.json())["native"][0]["journal_operation_id"] == operation_id
        request_id = uuid.uuid4().hex
        response = await client.post(PREFIX + "/sessions", headers={**auth, "X-Mona-Request-ID": request_id},
                                     json={"title": "成交复盘", "journal_operation_id": operation_id})
        assert response.status == 200
        assert writes == [(request_id, "POST", "/sessions", {"title": "成交复盘", "config": {"mona_journal": {"operation_id": operation_id}}})]
        assert len(reads) == 1


@pytest.mark.parametrize("upstream_status,expected_status,error", [
    (502, 502, "market_data_unavailable"),
    (422, 400, "market_query_unsupported"),
    (None, 504, "market_data_unavailable"),
])
async def test_market_failure_reports_quotes_instead_of_model_settings(
    tmp_path, monkeypatch, upstream_status, expected_status, error,
):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    native_requests = []

    def upstream(request):
        native_requests.append(request)
        if upstream_status is None:
            raise httpx.ReadTimeout("private transport detail", request=request)
        return httpx.Response(upstream_status, json={"status": "error", "detail": "private provider detail"})

    @asynccontextmanager
    async def lease():
        async with httpx.AsyncClient(base_url="http://native", transport=httpx.MockTransport(upstream)) as native:
            yield native

    monkeypatch.setattr(runtime, "lease", lease)
    async with client:
        response = await client.get(PREFIX + "/market-data", headers=auth, params={
            "symbol": "002460.SZ", "interval": "1D", "start_date": "2026-06-20", "end_date": "2026-10-18",
        })
        payload = await response.json()
        assert response.status == expected_status
        assert payload["error"] == error
        assert "模型" not in payload["message"] and "资源" not in payload["message"]
        assert "private" not in json.dumps(payload)
        assert len(native_requests) == 1
        assert native_requests[0].url.path == "/mona/market-data"
        assert native_requests[0].url.params["symbol"] == "002460.SZ"


async def test_startup_failure_is_known_not_dispatched_and_is_not_retried(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    starts = []

    async def unavailable(_config, _signature):
        starts.append(1)
        raise StockVibeUnavailableError("injected startup failure before any native request")

    monkeypatch.setattr(runtime, "_start", unavailable)
    request_id = uuid.uuid4().hex
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        status = await client.get(PREFIX, headers=auth)
        assert (await status.json())["execution_allowed"] is True
        first = await client.post(PREFIX + "/sessions", headers=headers, json={})
        assert first.status == 503
        record = await first.json()
        assert record["status"] == "rejected"
        assert record["error_category"] == "not_dispatched"
        assert record["receipt"] is None and record["source"] is None
        second = await client.post(PREFIX + "/sessions", headers=headers, json={})
        assert second.status == 503
        assert len(starts) == 1
        assert runtime._process is None
        assert not (tmp_path / "mona" / "stock-execution").exists()


async def test_model_selection_is_a_local_receipt_and_never_starts_financial_tasks(tmp_path, monkeypatch):
    writes = []

    def lost_after_commit(config, value):
        config.stock_vibe.model_preset = value
        writes.append(value)
        raise OSError("injected loss after settings commit")

    client, runtime, auth = await _app(tmp_path, monkeypatch, model_writer=lost_after_commit)
    config = runtime.config_loader()
    config.agents.defaults.provider = "openai"
    config.agents.defaults.model = "fixture-model"
    config.providers.openai.api_key = "synthetic-only-fixture"
    request_id = uuid.uuid4().hex
    headers = {**auth, "X-Mona-Request-ID": request_id}
    async with client:
        assert (await client.get(PREFIX + "/model")).status == 401
        assert (await client.get(PREFIX + "/model", headers=auth)).status == 200
        unknown = await client.put(PREFIX + "/model", headers=headers, json={"model_preset": "default"})
        assert unknown.status == 202, await unknown.text()
        assert (await unknown.json())["status"] == "unknown"
        verified = await client.get(PREFIX + f"/requests/{request_id}", headers=auth)
        record = await verified.json()
        assert record["status"] == "completed" and record["receipt_owner"] == "mona_settings"
        assert record["receipt"]["body"] == {"model_preset": "default"}
        assert record["source"] is None
        replay = await client.put(PREFIX + "/model", headers=headers, json={"model_preset": "default"})
        assert (await replay.json())["receipt"] == record["receipt"]
        assert writes == ["default"]
        conflict = await client.put(PREFIX + "/model", headers=headers, json={"model_preset": None})
        assert conflict.status == 409
        assert runtime._process is None and not runtime.data_root.exists()


async def test_attention_settings_preserve_explicit_scope_without_starting_native(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    async with client:
        initial = await (await client.get(PREFIX + "/attention", headers=auth)).json()
        assert initial["execution_allowed"] is True
        preferences = initial["preferences"]
        preferences.update(proactive_mode="manual", watched_symbols=["600519.SH"])
        headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
        response = await client.put(PREFIX + "/attention", headers=headers, json=preferences)
        assert response.status == 200, await response.text()
        saved = await response.json()
        assert saved["receipt_owner"] == "mona_settings" and saved["source"] is None
        assert saved["receipt"]["body"] == preferences
        duplicate = await client.put(PREFIX + "/attention", headers=headers, json=preferences)
        assert (await duplicate.json())["receipt"] == saved["receipt"]
        invalid = {**preferences, "watched_symbols": ["贵州茅台"]}
        assert (await client.put(PREFIX + "/attention", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json=invalid)).status == 400
        assert runtime.config_loader().stock_vibe.watched_symbols == ["600519.SH"]
        assert runtime._process is None and not runtime.data_root.exists()
        assert not (tmp_path / "mona" / "stock-execution").exists()


async def test_upload_receipt_list_reads_only_confirmed_request_store_records(tmp_path, monkeypatch):
    client, runtime, auth = await _app(tmp_path, monkeypatch)
    requests = RequestStore(runtime.data_root.parent / "host" / "requests.sqlite3")
    source = {
        "data_root_sha256": "a" * 64,
        "instance_id": "b" * 32,
        "snapshot_id": "sha256:" + "c" * 64,
        "patches": [],
    }
    upload_id = "d" * 32
    upload_id_without_file = "e" * 32

    def seed_upload(request_id: str, object_id: str, *, include_file: bool) -> None:
        record, _ = requests.claim(
            request_id,
            "POST",
            "/upload",
            {"upload": {"filename": "trades.csv", "sha256": "f" * 64}},
        )
        requests.bind_source(request_id, source)
        requests.complete(
            request_id,
            status="completed",
            receipt={"status_code": 201, "body": {
                "status": "ok",
                "file_path": f"uploads/{object_id}.csv",
                "filename": f"statement-{object_id[:4]}.csv",
            }},
            source=source,
        )
        if include_file:
            path = runtime.data_root / "uploads" / f"{object_id}.csv"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"csv fixture")

    seed_upload(uuid.uuid4().hex, upload_id, include_file=True)
    seed_upload(uuid.uuid4().hex, upload_id_without_file, include_file=False)
    unknown_id = uuid.uuid4().hex
    requests.claim(unknown_id, "POST", "/upload", {"upload": {"filename": "old.csv"}})
    requests.bind_source(unknown_id, source)
    requests.mark_unknown(unknown_id, "native_unconfirmed")

    async with client:
        response = await client.get(PREFIX + "/uploads", headers=auth)
        assert response.status == 200, await response.text()
        payload = await response.json()
        assert len(payload["uploads"]) == 2
        by_id = {item["upload_id"]: item for item in payload["uploads"]}
        assert by_id[upload_id]["filename"] == f"statement-{upload_id[:4]}.csv"
        assert by_id[upload_id]["size_bytes"] == len(b"csv fixture")
        assert by_id[upload_id]["source"] == source
        assert len(by_id[upload_id]["receipt_sha256"]) == 64
        assert by_id[upload_id_without_file]["size_bytes"] is None
        assert all("file_path" not in item for item in payload["uploads"])
        assert unknown_id not in {item["request_id"] for item in payload["uploads"]}
        assert runtime._process is None


async def test_real_native_receipts_survive_loss_restart_and_duplicate(tmp_path, monkeypatch):
    import mona.services.stock_vibe.client as client_module

    client, runtime, auth = await _app(tmp_path, monkeypatch, installed=_installed())
    request_id = uuid.uuid4().hex
    headers = {**auth, "X-Mona-Request-ID": request_id}
    original = client_module.native_json
    actual_submissions = []

    async def lose_one_receipt(native, method, path, **kwargs):
        result = await original(native, method, path, **kwargs)
        if method == "POST" and path == "/sessions":
            actual_submissions.append(result)
            raise httpx.ReadError("injected loss after the real native commit")
        return result

    async with client:
        # Model override/config injection is rejected before any native dispatch.
        bad = await client.post(PREFIX + "/sessions", headers=headers, json={"config": {"model": "override"}})
        assert bad.status == 400
        assert runtime._process is None
        monkeypatch.setattr(client_module, "native_json", lose_one_receipt)
        response = await client.post(PREFIX + "/sessions", headers=headers, json={"title": "receipt test"})
        assert response.status == 202, await response.text()
        unknown = await response.json()
        assert unknown["status"] == "unknown"
        assert unknown["source"]["snapshot_id"].startswith("sha256:")
        monkeypatch.setattr(client_module, "native_json", original)

        receipt_response = await client.get(PREFIX + f"/requests/{request_id}", headers=auth)
        assert receipt_response.status == 200, await receipt_response.text()
        receipt = await receipt_response.json()
        assert receipt["status"] == "completed"
        assert receipt["receipt"]["status_code"] == 201
        native_id = receipt["receipt"]["body"]["session_id"]
        assert len(actual_submissions) == 1
        first_source = receipt["source"]

        duplicate = await client.post(PREFIX + "/sessions", headers=headers, json={"title": "receipt test"})
        assert duplicate.status == 200
        assert (await duplicate.json())["receipt"] == receipt["receipt"]
        listed = await client.get(PREFIX + "/sessions", headers=auth)
        assert len((await listed.json())["native"]) == 1
        conflict = await client.post(PREFIX + "/sessions", headers=headers, json={"title": "different"})
        assert conflict.status == 409

        detail = await client.get(PREFIX + f"/sessions/{native_id}", headers=auth)
        assert (await detail.json())["source"] == first_source
        await runtime.close()
        # A new instance reads the same native object without relabelling its source.
        detail = await client.get(PREFIX + f"/sessions/{native_id}", headers=auth)
        reread = await detail.json()
        assert reread["native"]["session_id"] == native_id
        assert reread["source"] == first_source
        assert runtime.source_identity()["instance_id"] != first_source["instance_id"]
        assert (await client.post(PREFIX + "/native/trading/place-order", headers=auth, json={})).status == 404


async def test_real_events_require_single_use_ticket_and_keep_native_event_ids(tmp_path, monkeypatch):
    import asyncio

    client, runtime, auth = await _app(tmp_path, monkeypatch, installed=_installed())
    async with client:
        response = await client.post(PREFIX + "/sessions", headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex},
                                     json={"title": "event test without model"})
        assert response.status == 200, await response.text()
        native_id = (await response.json())["receipt"]["body"]["session_id"]
        ticket_path = PREFIX + "/events/ticket"
        assert (await client.post(ticket_path, json={"kind": "session", "object_id": native_id})).status == 401
        issued = await client.post(ticket_path, headers=auth, json={"kind": "session", "object_id": native_id})
        ticket = await issued.json()
        assert "api_key" not in json.dumps(ticket)
        stream = await client.get(ticket["url"])
        assert stream.status == 200
        assert (await client.get(ticket["url"])).status == 401
        assert (await client.get(PREFIX + "/events?ticket=invalid")).status == 401
        message = await client.post(PREFIX + f"/sessions/{native_id}/messages",
                                    headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex},
                                    json={"content": "Without a model this attempt must fail honestly."})
        assert message.status == 200, await message.text()
        data = bytearray()

        async def until_failure():
            async for chunk in stream.content.iter_any():
                data.extend(chunk)
                if b"attempt.failed" in data:
                    break

        try:
            await asyncio.wait_for(until_failure(), timeout=20)
        finally:
            stream.close()
        assert b"id:" in data and b"event: attempt.failed" in data
        assert b"attempt_id" in data
        session = await (await client.get(PREFIX + f"/sessions/{native_id}", headers=auth)).json()
        attempt_id = session["native"]["last_attempt_id"]
        attempt_response = await client.get(PREFIX + f"/sessions/{native_id}/attempts/{attempt_id}", headers=auth)
        assert attempt_response.status == 200, await attempt_response.text()
        attempt = (await attempt_response.json())["native"]
        assert attempt["attempt_id"] == attempt_id and attempt["status"] == "failed"
        assert "react_trace" not in attempt and "run_dir" not in attempt
        async with runtime.lease() as native:
            state = (await native.get("/mona/activity")).json()
        assert state["session_inflight"] == 0


async def test_real_native_upload_operation_and_artifact_roundtrip(tmp_path, monkeypatch):
    import asyncio
    import base64
    import shutil

    from tools.stock_vibe.baseline import _render_local_config

    client, runtime, auth = await _app(tmp_path, monkeypatch, installed=_installed())
    fixture = REPO_ROOT / "tests/fixtures/stock_vibe/backtest"
    run = runtime.data_root / "runs/host-contract"
    (run / "code").mkdir(parents=True)
    for name in ("config.json", "bars.csv", "halt_gap.csv"):
        shutil.copy2(fixture / name, run / name)
    shutil.copy2(fixture / "signal_engine.py", run / "code/signal_engine.py")
    bridge = runtime.data_root / "data-bridge/config.yaml"
    bridge.parent.mkdir(parents=True)
    bridge.write_text(_render_local_config(run / "bars.csv", run / "halt_gap.csv"), encoding="utf-8")
    source_before = (run / "config.json").read_bytes()
    async with client:
        upload_body = {"filename": "public-fixture.csv", "data_base64": base64.b64encode((fixture / "bars.csv").read_bytes()).decode()}
        upload_headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
        uploaded = await client.post(PREFIX + "/uploads", headers=upload_headers, json=upload_body)
        assert uploaded.status == 200, await uploaded.text()
        upload_receipt = await uploaded.json()
        assert upload_receipt["status"] == "completed" and upload_receipt["source"]["snapshot_id"]
        duplicate = await client.post(PREFIX + "/uploads", headers=upload_headers, json=upload_body)
        assert (await duplicate.json())["receipt"] == upload_receipt["receipt"]
        assert len(list((runtime.data_root / "uploads").iterdir())) == 1

        operation_headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
        payload = {"operation": "backtest", "run_id": "host-contract"}
        accepted = await client.post(PREFIX + "/operations", headers=operation_headers, json=payload)
        assert accepted.status == 200, await accepted.text()
        receipt = await accepted.json()
        assert receipt["status"] == "completed"
        operation_id = receipt["receipt"]["body"]["operation_id"]
        for _ in range(120):
            detail_response = await client.get(PREFIX + f"/operations/{operation_id}", headers=auth)
            assert detail_response.status == 200, await detail_response.text()
            detail = (await detail_response.json())["native"]
            if detail["status"] not in {"queued", "running"}:
                break
            await asyncio.sleep(0.25)
        assert detail["status"] == "completed", detail
        new_run = detail["references"]["run_id"]
        assert new_run != "host-contract" and new_run.startswith("mona-")
        repeated = await client.post(PREFIX + "/operations", headers=operation_headers, json=payload)
        assert (await repeated.json())["receipt"] == receipt["receipt"]
        assert (run / "config.json").read_bytes() == source_before
        exported = await client.get(PREFIX + f"/artifacts/run-equity/{new_run}", headers=auth)
        assert exported.status == 200, await exported.text()
        assert "attachment" in exported.headers["Content-Disposition"]
        assert exported.headers["Cache-Control"] == "no-store"
        assert await exported.read() == (runtime.data_root / "runs" / new_run / "artifacts/equity.csv").read_bytes()
        assert (await client.get(PREFIX + f"/artifacts/run-equity/{new_run}")).status == 401
        assert (await client.get(PREFIX + "/artifacts/run-equity/missing", headers=auth)).status == 404


async def test_real_native_schedule_patch_keeps_workbench_identity_and_is_idempotent(tmp_path, monkeypatch):
    import mona.services.stock_vibe.client as client_module

    client, runtime, auth = await _app(tmp_path, monkeypatch, installed=_installed())
    context = {"symbol": "002460.SZ", "task": "technical", "mode": "swing"}
    job_id = f"follow-{uuid.uuid4().hex[:12]}"
    create_headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
    patch_headers = {**auth, "X-Mona-Request-ID": uuid.uuid4().hex}
    initial_schedule = "60000"
    updated_schedule = "0 16 * * 1-5"
    async with client:
        created = await client.post(PREFIX + "/scheduled-runs", headers=create_headers, json={
            "id": job_id, "title": "定时走势分析", "prompt": "研究 002460 的走势",
            "schedule": initial_schedule, "timezone": "Asia/Shanghai", "workbench": context,
        })
        assert created.status == 200, await created.text()
        creation_receipt = await created.json()
        assert creation_receipt["status"] == "completed"
        assert creation_receipt["receipt"]["status_code"] == 201
        assert creation_receipt["receipt"]["body"]["id"] == job_id

        original_native_json = client_module.native_json
        dispatched = []

        async def track_schedule_requests(native, method, path, **kwargs):
            if path == f"/scheduled-runs/{job_id}" and method in {"GET", "PATCH"}:
                dispatched.append((method, path))
            return await original_native_json(native, method, path, **kwargs)

        monkeypatch.setattr(client_module, "native_json", track_schedule_requests)
        update = {"schedule": updated_schedule, "timezone": "Asia/Shanghai"}
        patched = await client.patch(PREFIX + f"/scheduled-runs/{job_id}", headers=patch_headers, json=update)
        assert patched.status == 200, await patched.text()
        patch_receipt = await patched.json()
        assert patch_receipt["status"] == "completed"
        assert patch_receipt["receipt"]["status_code"] == 200
        assert patch_receipt["receipt"]["body"]["id"] == job_id
        assert patch_receipt["receipt"]["body"]["schedule"] == updated_schedule

        duplicate = await client.patch(PREFIX + f"/scheduled-runs/{job_id}", headers=patch_headers, json=update)
        assert duplicate.status == 200
        assert (await duplicate.json())["receipt"] == patch_receipt["receipt"]
        assert dispatched == [("GET", f"/scheduled-runs/{job_id}"), ("PATCH", f"/scheduled-runs/{job_id}")]

        workbench = await client.get(PREFIX + "/workbench", params={"symbol": context["symbol"]}, headers=auth)
        assert workbench.status == 200, await workbench.text()
        jobs = (await workbench.json())["native"]["scheduled_jobs"]
        saved = next(job for job in jobs if job["id"] == job_id)
        assert saved["schedule"] == updated_schedule
        assert saved["config"]["mona_workbench"] == context
        assert saved["prompt"] == "研究 002460 的走势"

        extra = await client.patch(PREFIX + f"/scheduled-runs/{job_id}",
                                   headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex},
                                   json={**update, "prompt": "replace prompt"})
        assert extra.status == 400
        unknown = await client.patch(PREFIX + "/scheduled-runs/missing-workbench-job",
                                     headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json=update)
        assert unknown.status == 404

        no_workbench_id = f"legacy-{uuid.uuid4().hex[:12]}"
        async with runtime.lease() as native:
            unrelated = await native.post("/scheduled-runs", json={
                "id": no_workbench_id, "title": "generic task", "prompt": "generic scheduled task",
                "schedule": initial_schedule, "timezone": "Asia/Shanghai", "config": {},
            }, headers={"X-Mona-Request-ID": uuid.uuid4().hex})
        assert unrelated.status_code == 201, unrelated.text
        rejected = await client.patch(PREFIX + f"/scheduled-runs/{no_workbench_id}",
                                      headers={**auth, "X-Mona-Request-ID": uuid.uuid4().hex}, json=update)
        assert rejected.status == 404
        assert dispatched.count(("PATCH", f"/scheduled-runs/{job_id}")) == 1
