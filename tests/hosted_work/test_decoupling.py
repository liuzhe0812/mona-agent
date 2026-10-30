"""Prove online Work consumes identity only, with a separately configured model connection."""
import ast
import inspect
import json
from pathlib import Path

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer
from pydantic import ValidationError

from mona.config.schema import Config, HostedWorkConfig, HostedWorkModel
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.executor import child_environment
from mona.hosted_work.model_access import HostedAPIProvider, model_endpoint
from mona.hosted_work.providers import create_provider
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore


def model_config(**changes):
    return HostedWorkModel(label="平台模型", model="fixture-model", api_base="https://models.example.invalid/v1",
                           api_key_env="MONA_WORK_MODEL_PRIMARY_KEY", **changes)


def mock_auth_transport(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr("mona.hosted_work.auth_client.httpx.AsyncClient",
                        lambda **kwargs: real(transport=httpx.MockTransport(handler), **kwargs))


@pytest.mark.asyncio
async def test_identity_reads_only_generic_account_contract(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"account_id": "17"})
    mock_auth_transport(monkeypatch, handler)
    auth = AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid"))
    assert await auth.identity("synthetic-account-token") == owner_key("17")
    assert len(calls) == 1 and calls[0].url.path == "/auth/identity"
    assert calls[0].method == "GET"
    assert calls[0].headers["authorization"] == "Bearer synthetic-account-token"
    assert "x-hosted-work-key" not in calls[0].headers
    assert not hasattr(auth, "model_token")


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [httpx.Response(200, text="<html>site fallback</html>"),
    httpx.Response(302, headers={"Location": "https://elsewhere.invalid/auth/identity"}),
    httpx.Response(200, json={"pro": True, "balance": 100}), httpx.Response(200, json={"account_id": 17}),
    httpx.Response(200, json={"account_id": "17", "padding": "x" * 17000})])
async def test_identity_rejects_html_redirects_and_nonidentity_success(monkeypatch, response):
    mock_auth_transport(monkeypatch, lambda request: response)
    with pytest.raises(WorkError) as exc:
        await AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid")).identity("account-token")
    assert exc.value.status == 503


@pytest.mark.asyncio
async def test_revoked_auth_never_becomes_local_fallback(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(401)
    mock_auth_transport(monkeypatch, handler)
    with pytest.raises(WorkError) as exc:
        await AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid")).identity("account-token")
    assert exc.value.status == 401 and len(calls) == 1


@pytest.mark.asyncio
async def test_login_only_forwards_to_existing_account_login(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        assert json.loads(request.content) == {"account": "student", "password": "synthetic-password"}
        return httpx.Response(200, json={"access_token": "synthetic-account-token", "expires_in": 300, "irrelevant": "ignored"})
    mock_auth_transport(monkeypatch, handler)
    result = await AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid")).login("student", "synthetic-password")
    assert result == {"access_token": "synthetic-account-token"}
    assert calls[0].url.path == "/auth/web/login" and calls[0].method == "POST"
    assert "authorization" not in calls[0].headers


@pytest.mark.asyncio
async def test_logout_revokes_upstream_website_session_without_business_calls(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"message": "logged out"})
    mock_auth_transport(monkeypatch, handler)
    await AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid")).logout("synthetic-account-token")
    assert len(calls) == 1 and calls[0].url.path == "/auth/web/logout"
    assert calls[0].headers["authorization"] == "Bearer synthetic-account-token"
    assert json.loads(calls[0].content) == {}


@pytest.mark.asyncio
async def test_logout_failure_is_not_reported_as_success(monkeypatch):
    mock_auth_transport(monkeypatch, lambda _: httpx.Response(503, json={"message": "temporarily unavailable"}))
    with pytest.raises(WorkError) as exc:
        await AuthClient(HostedWorkConfig(auth_origin="https://accounts.example.invalid")).logout("synthetic-account-token")
    assert exc.value.code == "logout_unconfirmed"


def test_direct_model_does_not_receive_a_user_token(monkeypatch, tmp_path):
    monkeypatch.setenv("MONA_WORK_MODEL_PRIMARY_KEY", "synthetic-platform-key")
    config = HostedWorkConfig(auth_origin="https://accounts.example.invalid")
    provider = create_provider(config, model_config(), tmp_path / "engine")
    assert isinstance(provider, HostedAPIProvider)
    assert provider.api_key == "synthetic-platform-key"
    assert provider.api_base == "https://models.example.invalid/v1"
    assert not hasattr(provider, "account_token")
    assert "account_token" not in inspect.signature(create_provider).parameters
    assert provider._CHAT_RETRY_DELAYS == ()
    assert "X-Hosted-Work-Key" not in provider._default_headers
    assert "hosted_work" not in Config.model_fields
    assert "worker_key_env" not in HostedWorkConfig.model_fields


def test_missing_platform_key_does_not_borrow_desktop_or_account_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv("MONA_WORK_MODEL_PRIMARY_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "unrelated-desktop-key")
    monkeypatch.setenv("MONA_HOSTED_WORK_KEY", "old-node-key")
    with pytest.raises(WorkError) as exc:
        create_provider(HostedWorkConfig(), model_config(), tmp_path)
    assert exc.value.code == "model_configuration"
    with pytest.raises(ValidationError):
        HostedWorkModel(label="bad", model="fixture", api_key_env="OPENAI_API_KEY")


@pytest.mark.parametrize("endpoint", ["https://accounts.example.invalid/v1", "https://accounts.example.invalid/internal/hosted-work/model-token",
    "http://example.invalid/v1", "https://user:password@models.example.invalid/v1", "https://models.example.invalid/v1?key=value"])
def test_online_model_configuration_cannot_fall_back_to_current_business_gateway(endpoint):
    selection = model_config().model_copy(update={"api_base": endpoint})
    with pytest.raises(WorkError):
        model_endpoint(HostedWorkConfig(auth_origin="https://accounts.example.invalid"), selection)


def test_child_only_receives_selected_platform_model_credential(monkeypatch):
    for key in ("MONA_WORK_MODEL_PRIMARY_KEY", "MONA_WORK_MODEL_OTHER_KEY", "OPENAI_API_KEY", "MONA_HOSTED_WORK_KEY", "LANGFUSE_SECRET_KEY", "MONA_APP_DATA_DIR"):
        monkeypatch.setenv(key, "synthetic")
    config = HostedWorkConfig(models={"chosen": model_config()})
    env = child_environment(config, {"action": "turn", "model_id": "chosen"})
    assert env["MONA_WORK_MODEL_PRIMARY_KEY"] == "synthetic"
    for key in ("MONA_WORK_MODEL_OTHER_KEY", "OPENAI_API_KEY", "MONA_HOSTED_WORK_KEY", "LANGFUSE_SECRET_KEY", "MONA_APP_DATA_DIR"):
        assert key not in env
    assert "MONA_WORK_MODEL_PRIMARY_KEY" not in child_environment(config, {"action": "upload"})


def test_hosted_modules_have_no_business_service_imports():
    forbidden = ("mona.cloud", "mona.services", "mona.channels", "mona.license",
                 "mona.providers.mona_managed_provider", "app.")
    for source in Path("mona/hosted_work").glob("*.py"):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or ""] if isinstance(node, ast.ImportFrom) else []
            assert not any(name.startswith(forbidden) for name in names), source


@pytest.mark.asyncio
async def test_standalone_frontend_and_health_do_not_depend_on_auth_or_other_modules(tmp_path):
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "hosted-work.html").write_text("<html>Independent Work</html>", encoding="utf-8")
    (static / "assets/app.js").write_text("window.Work=true", encoding="utf-8")
    config = HostedWorkConfig(public_origin="https://work.example.invalid", frontend_dir=str(static))
    class AccountBoundary:
        async def identity(self, token):
            raise WorkError("auth_unavailable", "认证暂不可用", 503)
        async def login(self, account, password):
            return {"access_token": "synthetic"}
    store = WorkStore(tmp_path / "work.sqlite3", config)
    client = TestClient(TestServer(create_app(WorkService(config, store, AccountBoundary(), None))))
    await client.start_server()
    try:
        response = await client.get("/work/")
        assert response.status == 200 and "Independent Work" in await response.text()
        assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
        assert (await client.get("/work/assets/app.js")).status == 200
        assert (await client.get("/work/assets/")).status in {403, 404}
        health = await (await client.get("/healthz")).json()
        assert health["status"] == "alive" and health["models_configured"] is False
        assert (await client.get("/api/work/sessions", headers={"Authorization": "Bearer token"})).status == 503
        response = await client.post("/api/work/auth/login", json={"account": "a", "password": "b"})
        assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
        assert (await client.post("/api/work/auth/login", json={"account": "a", "password": "b", "api_key": "denied"})).status == 400
        assert (await client.post("/api/work/auth/login", json={"account": "a", "password": "b"}, headers={"Origin": "https://other.invalid"})).status == 403
    finally:
        await client.close()
        store.close()
