"""Exercise admin/configuration boundaries with isolated identity and native execution.

These checks never log into Codex, start a model task, or validate a production model.
"""
import asyncio
import copy
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer
from pydantic import ValidationError

from mona.config.schema import HostedCodexSettings, HostedWorkConfig, HostedWorkModel
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorModel, ExecutorProbe
from mona.hosted_work.admin import CodexAdmin, SaveCodex
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

ADMIN_URL = "/api/work/admin/codex"
MODEL = "native-fixture"


@pytest.mark.asyncio
async def test_chunked_configuration_reads_the_complete_body_and_bounds_it(online, tmp_path):
    initial = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    body = json.dumps({"expected_revision": initial["revision"], "configuration": configuration(tmp_path)}).encode()
    async def chunks(content):
        yield content[:15]
        await asyncio.sleep(0.01)
        yield content[15:]
    response = await online.client.put(ADMIN_URL, headers=headers(), data=chunks(body))
    assert response.status == 200
    saved = online.path.read_bytes()
    response = await online.client.put(ADMIN_URL, headers=headers(), data=chunks(body + b" " * 8192))
    assert response.status == 413 and online.path.read_bytes() == saved


def operator_file(tmp_path, section="hosted_work"):
    root = tmp_path / "config"
    root.mkdir()
    path = root / "operator.json"
    data = {
        section: {
            "public_origin": "https://work.example.invalid",
            "auth_origin": "https://auth.example.invalid",
            "state_dir": str(tmp_path / "state"),
            "models": {"qwen": {"label": "Qwen 免费", "source": "mona", "model": "qwen-fixture",
                                 "api_base": "https://model.example.invalid/v1",
                                 "api_key_env": "MONA_WORK_MODEL_QWEN_KEY", "billing_mode": "free"}},
            "max_concurrent_runs": 2,
        },
        "unrelated": {"nested": [None, False, 1.25, {"中文": "保留"}], "value": 7},
    }
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path, data


def configuration(tmp_path):
    return HostedCodexSettings(cli_path=str(tmp_path / "codex.exe"), model=MODEL,
                               billing_model="priced-codex-fixture").model_dump()


def headers(token="admin"):
    return {"Authorization": "Bearer " + token, "Origin": "https://work.example.invalid"}


class NoExecution:
    async def execute(self, *_args):
        pytest.fail("Admin configuration must not dispatch a task")

    def cancel(self, *_args):
        pytest.fail("Admin configuration must not cancel a task")


@pytest_asyncio.fixture
async def online(tmp_path, monkeypatch):
    path, data = operator_file(tmp_path)
    identity_requests = []

    def identity(request):
        identity_requests.append(request)
        token = request.headers.get("Authorization")
        if token not in {"Bearer admin", "Bearer ordinary"}:
            return httpx.Response(401, json={})
        if request.url.path == "/auth/identity/admin" and token != "Bearer admin":
            return httpx.Response(403, json={})
        return httpx.Response(200, json={"account_id": "1" if token == "Bearer admin" else "2"})

    original_client = httpx.AsyncClient

    def auth_client(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return original_client(transport=httpx.MockTransport(identity), **kwargs)

    monkeypatch.setattr("mona.hosted_work.auth_client.httpx.AsyncClient", auth_client)
    config = HostedWorkConfig.model_validate(data["hosted_work"])
    store = WorkStore(tmp_path / "state.sqlite3", config)
    service = WorkService(config, store, AuthClient(config), NoExecution())
    client = TestClient(TestServer(create_app(service, operator_config_path=path)))
    await client.start_server()
    try:
        yield SimpleNamespace(client=client, service=service, path=path, identity_requests=identity_requests)
    finally:
        await client.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("token,status", [(None, 401), ("ordinary", 403)])
async def test_admin_routes_require_real_admin_identity(online, token, status):
    original = online.path.read_bytes()
    request_headers = headers(token) if token else {}
    for method, url in [("GET", ADMIN_URL), ("PUT", ADMIN_URL), ("POST", ADMIN_URL + "/probe")]:
        response = await online.client.request(method, url, headers=request_headers, json={} if method != "GET" else None)
        assert response.status == status
    assert online.path.read_bytes() == original
    assert all(request.url.path == "/auth/identity/admin" for request in online.identity_requests)
    assert bool(online.identity_requests) == bool(token)


@pytest.mark.asyncio
async def test_admin_can_read_and_save_a_draft_without_publishing(online, tmp_path):
    response = await online.client.get(ADMIN_URL, headers=headers())
    assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
    initial = await response.json()
    response = await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": initial["revision"], "configuration": configuration(tmp_path)})
    assert response.status == 200
    saved = await response.json()
    assert saved["configuration"] == configuration(tmp_path)
    assert saved["revision"] != initial["revision"]
    assert saved["public_enabled"] is False and saved["billing"]["ready"] is False
    assert saved["connection"]["state"] == "not_checked"
    assert saved["billing"]["mode"] == "wallet"
    assert saved["execution"]["ready"] is False and "qwen" not in saved
    stale = await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": initial["revision"], "configuration": configuration(tmp_path)})
    assert stale.status == 409 and (await stale.json())["error"] == "configuration_changed"
    assert all(request.url.path == "/auth/identity/admin" for request in online.identity_requests)


@pytest.mark.asyncio
async def test_detected_cli_is_read_only_and_does_not_override_explicit_path(online, tmp_path, monkeypatch):
    found = tmp_path / "detected" / "codex"
    looked_at = []
    def discover(*, work_root):
        looked_at.append(work_root)
        return found
    monkeypatch.setattr("mona.hosted_work.admin.discover_codex", discover)
    initial = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    assert initial["discovery"] == {"state": "found", "path": str(found)}
    config = configuration(tmp_path)
    saved = await (await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": initial["revision"], "configuration": config})).json()
    assert saved["configuration"]["cli_path"] == config["cli_path"]
    assert saved["configuration"]["cli_path"] != saved["discovery"]["path"]
    after = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    assert after["configuration"]["cli_path"] == config["cli_path"]
    assert all(root == online.path.parent.parent for root in looked_at)
    assert after["execution"]["ready"] is False and after["public_enabled"] is False


@pytest.mark.asyncio
async def test_older_codex_client_cannot_erase_price_or_billing_mapping(online, tmp_path, monkeypatch):
    monkeypatch.setattr("mona.hosted_work.admin.discover_codex", lambda *, work_root: None)
    initial = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    price = {"input_amount_per_million": "2.50", "cached_input_amount_per_million": "0.25",
             "output_amount_per_million": "7"}
    config = {**configuration(tmp_path), "billing_model": "existing-price-reference", "price": price,
              "local_proxy_url": "http://127.0.0.1:7897"}
    saved = await (await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": initial["revision"], "configuration": config})).json()
    legacy = {key: value for key, value in config.items() if key not in {"price", "billing_model", "local_proxy_url"}}
    legacy["label"] = "Legacy editor update"
    response = await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": saved["revision"], "configuration": legacy})
    assert response.status == 200
    updated = await response.json()
    assert updated["configuration"]["price"] == price
    assert updated["configuration"]["billing_model"] == "existing-price-reference"
    assert updated["configuration"]["local_proxy_url"] == "http://127.0.0.1:7897"
    assert updated["configuration"]["label"] == "Legacy editor update"
    response = await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": updated["revision"], "configuration": {**legacy, "price": None}})
    assert response.status == 200
    cleared = await response.json()
    assert cleared["configuration"]["price"] is None
    assert cleared["configuration"]["billing_model"] == "existing-price-reference"
    assert cleared["configuration"]["local_proxy_url"] == "http://127.0.0.1:7897"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["free", "wallet"])
async def test_codex_administrator_controls_same_billing_and_generation_fields(online, tmp_path, mode):
    initial = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    values = {**configuration(tmp_path), "billing_mode": mode, "max_output_tokens": 8192,
              "context_window_tokens": 65536, "reasoning_effort": "high"}
    response = await online.client.put(ADMIN_URL, headers=headers(), json={
        "expected_revision": initial["revision"], "configuration": values})
    assert response.status == 200
    saved = await response.json()
    assert saved["configuration"] == values
    assert saved["billing"]["mode"] == mode and saved["billing"]["ready"] is (mode == "free")
    assert saved["execution"]["ready"] is False and saved["public_enabled"] is False
    assert "qwen" not in saved


@pytest.mark.asyncio
@pytest.mark.parametrize("section", ["hosted_work", "hostedWork"])
async def test_save_preserves_other_json_permissions_and_rejects_stale_revision(tmp_path, monkeypatch, section):
    path, original = operator_file(tmp_path, section)
    original_bytes = path.read_bytes()
    admin = CodexAdmin(path)
    revision = admin.snapshot()["revision"]
    chmod_calls = []
    real_chmod = os.chmod

    def chmod(target, mode, *args, **kwargs):
        chmod_calls.append((Path(target), mode))
        return real_chmod(target, mode, *args, **kwargs)

    monkeypatch.setattr(os, "chmod", chmod)
    request = SaveCodex(expected_revision=revision, configuration=configuration(tmp_path))
    await admin.save(request)
    expected = copy.deepcopy(original)
    expected[section]["codex"] = configuration(tmp_path)
    assert json.loads(path.read_bytes()) == expected
    backup = path.with_name(path.name + ".before-codex-" + revision + ".json")
    assert backup.read_bytes() == original_bytes
    assert (path, 0o600) in chmod_calls and (backup, 0o600) in chmod_calls
    if os.name != "nt":  # Windows reports DOS attributes rather than POSIX owner bits.
        assert stat.S_IMODE(path.stat().st_mode) == stat.S_IMODE(backup.stat().st_mode) == 0o600
    saved_bytes = path.read_bytes()
    with pytest.raises(WorkError) as caught:
        await admin.save(request)
    assert caught.value.code == "configuration_changed" and caught.value.status == 409
    assert path.read_bytes() == saved_bytes


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["api_key", "auth_json", "enabled", "native_home", "public_enabled"])
async def test_form_cannot_inject_credentials_homes_or_enable_codex(online, tmp_path, field):
    initial = await (await online.client.get(ADMIN_URL, headers=headers())).json()
    body = {"expected_revision": initial["revision"], "configuration": configuration(tmp_path)}
    body["configuration"][field] = True if "enabled" in field else "forbidden-input"
    original = online.path.read_bytes()
    response = await online.client.put(ADMIN_URL, headers=headers(), json=body)
    assert response.status == 400
    assert online.path.read_bytes() == original
    assert not list(online.path.parent.glob("*.before-codex-*"))


@pytest.mark.asyncio
async def test_probe_does_not_accept_an_inline_configuration(online):
    response = await online.client.post(ADMIN_URL + "/probe", headers=headers(), json={"enabled": True})
    assert response.status == 400


def test_profile_uses_only_fixed_home_and_empty_bootstrap(tmp_path, monkeypatch):
    path, _ = operator_file(tmp_path)
    executable = tmp_path / "native-codex"
    settings = HostedCodexSettings(cli_path=str(executable))
    resolved = []
    prepared = []
    profile = object()

    def resolve(engine, supplied):
        resolved.append((engine, supplied))
        return executable, False

    def prepare(binary, home, root):
        prepared.append((binary, home, root))
        return profile

    monkeypatch.setattr("mona.development.executors.discovery.resolve_executable", resolve)
    monkeypatch.setattr("mona.development.executors.codex_policy.prepare_codex_profile", prepare)
    admin = CodexAdmin(path)
    assert admin.profile(settings) is profile
    home = path.parent / "development/native/codex"
    bootstrap = path.parent / "codex-bootstrap"
    assert resolved == [(ExecutorId.CODEX, executable)]
    assert prepared == [(executable, home, bootstrap)]
    assert bootstrap.is_dir() and not list(bootstrap.iterdir())
    (bootstrap / "existing.txt").write_text("preserve", encoding="utf-8")
    with pytest.raises(WorkError) as caught:
        admin.profile(settings)
    assert caught.value.code == "bootstrap_not_empty" and len(prepared) == 1


@pytest.mark.parametrize("value", ["https://127.0.0.1:7897", "http://localhost:7897", "http://192.168.1.2:7897",
                                   "http://127.0.0.1", "http://127.0.0.1:0", "http://user:pw@127.0.0.1:7897",
                                   "http://127.0.0.1:7897/path", "http://127.0.0.1:7897/?x=1"])
def test_codex_proxy_rejects_nonlocal_or_credentialed_addresses(value):
    with pytest.raises(ValidationError):
        HostedCodexSettings(local_proxy_url=value)


def test_codex_proxy_is_scoped_to_the_cli_profile(tmp_path, monkeypatch):
    path, _ = operator_file(tmp_path)
    executable = tmp_path / "native-codex"
    settings = HostedCodexSettings(cli_path=str(executable), local_proxy_url="http://127.0.0.1:7897")

    @dataclass(frozen=True)
    class Profile:
        environment: dict

    original = Profile({"PATH": "/usr/bin"})
    monkeypatch.setattr("mona.development.executors.discovery.resolve_executable", lambda *_args: (executable, False))
    monkeypatch.setattr("mona.development.executors.codex_policy.prepare_codex_profile", lambda *_args: original)
    result = CodexAdmin(path).profile(settings)
    assert original.environment == {"PATH": "/usr/bin"}
    assert result.environment == {"PATH": "/usr/bin", "HTTP_PROXY": "http://127.0.0.1:7897",
                                  "HTTPS_PROXY": "http://127.0.0.1:7897", "ALL_PROXY": "http://127.0.0.1:7897"}


@pytest.mark.parametrize("target", ["home", "cache"])
def test_fixed_native_paths_reject_symlink_escape(tmp_path, target):
    path, _ = operator_file(tmp_path)
    home = path.parent / "development/native/codex"
    home.parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    original = b'{"models":[{"slug":"private-fixture"}]}'
    private_cache = outside / "models_cache.json"
    private_cache.write_bytes(original)
    if target == "home":
        link, destination, directory = home, outside, True
    else:
        home.mkdir()
        link, destination, directory = home / "models_cache.json", private_cache, False
    try:
        link.symlink_to(destination, target_is_directory=directory)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"Symbolic links unavailable: {type(exc).__name__}")
    with pytest.raises(WorkError) as caught:
        CodexAdmin(path).snapshot()
    assert caught.value.code == "invalid_configuration" and caught.value.status == 503
    assert private_cache.read_bytes() == original


@pytest.mark.asyncio
@pytest.mark.parametrize("change,cache,expected", [
    ({}, {"models": [{"slug": MODEL}]}, "ready"),
    ({"authentication": "required"}, {"models": [{"slug": MODEL}]}, "login_required"),
    ({"auth_mode": "api_key"}, {"models": [{"slug": MODEL}]}, "auth_mode_mismatch"),
    ({"protocol_verified": False}, {"models": [{"slug": MODEL}]}, "unavailable"),
    ({"isolation_verified": False}, {"models": [{"slug": MODEL}]}, "unavailable"),
    ({"protocol_verified": False, "error_code": "native_request_timeout"}, None, "timeout"),
    ({}, None, "ready"),
    ({}, {"models": [{"slug": "other-fixture"}]}, "ready"),
    ({}, {"data": [{"model": MODEL}]}, "ready"),
    ({"model_details": []}, {"models": [{"slug": MODEL}]}, "models_unavailable"),
])
async def test_probe_requires_auth_protocol_isolation_and_live_model_list(tmp_path, monkeypatch, change, cache, expected):
    path, _ = operator_file(tmp_path)
    admin = CodexAdmin(path)
    await admin.save(SaveCodex(expected_revision=admin.snapshot()["revision"], configuration=configuration(tmp_path)))
    if cache is not None:
        cache_path = path.parent / "development/native/codex/models_cache.json"
        cache_path.parent.mkdir(parents=True)
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
    result = ExecutorProbe(executor=ExecutorId.CODEX, state="ready", authentication="ready",
                           auth_mode="chatgpt", protocol_verified=True, isolation_verified=True,
                           model_details=[ExecutorModel(id=MODEL, label=MODEL)])
    result = result.model_copy(update=change)
    profile = object()
    operations = []
    monkeypatch.setattr(CodexAdmin, "profile", lambda self, settings: profile)

    class IsolatedExecutor:
        def __init__(self, supplied_profile, *, request_timeout):
            assert supplied_profile is profile and request_timeout == 15

        async def probe(self):
            operations.append("probe")
            return result

        async def shutdown(self):
            operations.append("shutdown")

    monkeypatch.setattr("mona.development.executors.codex.CodexExecutor", IsolatedExecutor)
    snapshot = await admin.probe()
    assert snapshot["connection"]["state"] == expected
    if expected == "timeout":
        assert "超时" in snapshot["connection"]["message"] and "版本" not in snapshot["connection"]["message"]
    assert snapshot["connection"]["models"] == ([{"id": MODEL, "label": MODEL}] if expected == "ready" else [])
    assert snapshot["public_enabled"] is False and snapshot["billing"]["ready"] is False
    assert operations == ["probe", "shutdown"]


def test_live_model_list_is_deduplicated_and_hides_unusable_metadata():
    details = [ExecutorModel(id="first", label="First model"), ExecutorModel(id="first", label="Duplicate"),
               ExecutorModel(id="second", label="Long " + "x" * 100), ExecutorModel(id="bad\nid", label="Invalid")]
    assert CodexAdmin._live_models(details) == [{"id": "first", "label": "First model"},
                                                {"id": "second", "label": "second"}]


@pytest.mark.asyncio
async def test_manual_codex_public_configuration_cannot_run_unbilled_but_explicit_free_model_can(online):
    service = online.service
    service.config.models["manual-codex"] = HostedWorkModel(label="Codex", model=MODEL, source="codex")
    response = await online.client.get("/api/work/models", headers=headers("ordinary"))
    assert response.status == 200
    assert [model["id"] for model in (await response.json())["models"]] == ["qwen"]
    with pytest.raises(WorkError) as caught:
        service._acquire(owner_key("2"), "manual-codex")
    assert caught.value.code == "provider_unavailable" and caught.value.status == 503
    assert not service.active_users and not service.active_engines
    for account in ("2", "3"):
        owner = owner_key(account)
        assert service._acquire(owner, "qwen") is None
        assert owner in service.active_users
        service._release(owner, None)
