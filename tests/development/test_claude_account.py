"""Local-account binding contract; all credentials and SDK replies are synthetic."""
from __future__ import annotations

import json
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import wait_run
from test_sdk_workbench import setup, trace

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors import claude_account
from mona.development.executors.base import ExecutorProbe
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk import SDKExecutor


def credential_file(tmp_path, monkeypatch):
    directory = tmp_path / "system-claude"
    directory.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(directory))
    monkeypatch.setattr(claude_account.sys, "platform", "win32")
    target = directory / ".credentials.json"
    target.write_text(json.dumps({"other": {"preserved": True}, "claudeAiOauth": {
        "accessToken": "synthetic-local-access", "refreshToken": "synthetic-local-refresh",
        "expiresAt": (time.time() + 3600) * 1000, "scopes": ["user:inference", "user:profile"],
        "subscriptionType": "max", "rateLimitTier": "test-tier",
    }}), encoding="utf-8")
    return target


def test_binding_and_spawn_match_cindy_without_copying_or_removing_system_credentials(tmp_path, monkeypatch):
    target = credential_file(tmp_path, monkeypatch)
    original = target.read_bytes()
    home = tmp_path / "managed"
    home.mkdir()
    assert claude_account.local_account_env(home) == {}
    claude_account.bind_local_account(home)
    env = claude_account.local_account_env(home)
    assert env == {"CLAUDE_CODE_OAUTH_TOKEN": "synthetic-local-access",
        "CLAUDE_CODE_OAUTH_SCOPES": "user:inference user:profile", "CLAUDE_CODE_SUBSCRIPTION_TYPE": "max",
        "CLAUDE_CODE_RATE_LIMIT_TIER": "test-tier"}
    assert all("synthetic" not in path.read_text() for path in home.iterdir())
    updated = json.loads(target.read_text())
    updated["claudeAiOauth"]["accessToken"] = "synthetic-renewed-access"
    target.write_text(json.dumps(updated), encoding="utf-8")
    assert claude_account.local_account_env(home)["CLAUDE_CODE_OAUTH_TOKEN"] == "synthetic-renewed-access"
    current = target.read_bytes()
    claude_account.unbind_local_account(home)
    assert target.read_bytes() == current and original != current
    assert claude_account.local_account_env(home) == {}


@pytest.mark.parametrize("value", ["not-json", '{"claudeAiOauth":{}}',
    '{"claudeAiOauth":{"accessToken":"synthetic-expired","expiresAt":1}}'])
def test_missing_or_expired_local_login_never_binds_or_exposes_credentials(tmp_path, monkeypatch, value):
    target = credential_file(tmp_path, monkeypatch)
    target.write_text(value, encoding="utf-8")
    with pytest.raises(RpcError) as error:
        claude_account.bind_local_account(tmp_path)
    assert "synthetic" not in str(error.value)
    assert not (tmp_path / "claude-local-account.json").exists()


def test_macos_reads_the_native_keychain_without_writing_it(monkeypatch):
    monkeypatch.setattr(claude_account.sys, "platform", "darwin")
    monkeypatch.setenv("USER", "synthetic-user")
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout='{"claudeAiOauth":{"accessToken":"synthetic-keychain"}}')
    monkeypatch.setattr(claude_account.subprocess, "run", run)
    assert claude_account.read_local_account()["accessToken"] == "synthetic-keychain"
    assert calls == [["/usr/bin/security", "find-generic-password", "-a", "synthetic-user", "-w", "-s", "Claude Code-credentials"]]


@pytest.mark.asyncio
async def test_configured_model_bridge_does_not_receive_local_oauth(tmp_path, monkeypatch):
    credential_file(tmp_path, monkeypatch)
    runtime, _, root, host = await setup(tmp_path, monkeypatch, ExecutorId.CLAUDE)
    claude_account.bind_local_account(host.profile.home)
    bridged = SDKExecutor(replace(host.profile, environment={**host.profile.environment,
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:1", "ANTHROPIC_API_KEY": "synthetic-session-route"}))
    try:
        await bridged.probe()
        connect = next(row for row in trace(root) if row["method"] == "connect")
        assert connect["apiKeyPresent"] and not connect["localOAuth"]
    finally:
        await bridged.shutdown()
        await runtime.close()


@pytest.mark.asyncio
async def test_existing_http_login_probe_logout_use_local_account_and_real_worker_pipes(tmp_path, monkeypatch):
    target = credential_file(tmp_path, monkeypatch)
    original = target.read_bytes()
    runtime, project, root, host = await setup(tmp_path, monkeypatch, ExecutorId.CLAUDE)
    runtime.native.hosts[("", ExecutorId.CLAUDE)] = host
    monkeypatch.setattr("mona.development.native_manager.discover_executors", lambda _: [
        ExecutorProbe(executor=ExecutorId.CLAUDE, state="detected", executable=str(host.profile.executable))])
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-local-account-test")
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    base = "/api/development/provider-executors/claude"
    headers = {"X-Mona-Token": "synthetic-local-account-test"}
    try:
        assert (await client.post(base + "/login")).status == 401
        assert (await (await client.get(base + "/login", headers=headers)).json())["state"] == "idle"
        reply = await (await client.post(base + "/login", headers=headers)).json()
        assert reply["state"] == "succeeded" and not reply["authUrl"]
        assert "synthetic-local-access" not in json.dumps(reply)
        result = await (await client.post(base + "/probe", headers=headers)).json()
        assert result["authentication"] == "ready" and result["models"] == ["peer-model"]
        assert all(row["method"] != "query" for row in trace(root))
        connect = next(row for row in trace(root) if row["method"] == "connect")
        assert connect["localOAuth"] and not connect["apiKeyPresent"] and connect["hostManaged"]
        assert runtime.store.list_sessions(project.id) == []
        session = runtime.store.create_session(project.id, ExecutorId.CLAUDE)
        await runtime.submit(session.id, "local-task", "synthetic task")
        await wait_run(runtime, session.id, RunStatus.SUCCEEDED)
        binding = runtime.store.list_bindings(session.id)[0]
        assert (await client.post(base + "/logout", headers=headers)).status == 200
        assert target.read_bytes() == original
        receipt = await host.send(binding, "after-disconnect", "must not reach the worker")
        assert receipt.outcome == "rejected"
        assert not any(row.get("input") == "must not reach the worker" for row in trace(root))
        assert (await (await client.get(base + "/login", headers=headers)).json())["state"] == "idle"
        result = await (await client.post(base + "/probe", headers=headers)).json()
        assert result["authentication"] == "required"
        assert [row for row in trace(root) if row["method"] == "connect"][-1]["hostManaged"]
        assert not any("synthetic-local-access" in json.dumps(row) for row in trace(root))
    finally:
        await client.close()
