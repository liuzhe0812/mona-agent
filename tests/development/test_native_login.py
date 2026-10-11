"""Production authentication lifecycle over real pipes; vendor responses are fixtures."""
from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import setup, trace
from test_sdk_workbench import setup as sdk_setup

from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId
from mona.development.executors.login import NativeLogin
from mona.development.executors.rpc import RpcError
from mona.development.store import ConflictError, DevelopmentError


async def state(host, expected):
    async with asyncio.timeout(5):
        while host.login_status()["state"] != expected:
            await asyncio.sleep(.01)
    return host.login_status()


def test_attempt_early_identity_terminal_and_private_url():
    attempt = NativeLogin()
    attempt.notify("wrong-id", True)
    attempt.notify("correct-id", False)
    attempt.attach("correct-id", "https://auth.openai.com/PRIVATE_URL")
    assert attempt.state == "failed" and attempt.public()["authUrl"] == ""
    attempt.notify("correct-id", True)
    attempt.disconnected()
    assert attempt.state == "failed" and "PRIVATE_URL" not in repr(attempt)
    pending = NativeLogin()
    pending.attach("pending-id", "https://auth.openai.com/PRIVATE_URL")
    pending.notify("other-id", True)
    pending.notify("pending-id", "true")
    assert pending.state == "waiting"


@pytest.mark.asyncio
async def test_status_is_read_only_and_does_not_start_an_executor(tmp_path):
    runtime, project, _, host = await setup(tmp_path)
    try:
        assert (await runtime.native.login_status(project.id, ExecutorId.CODEX))["state"] == "idle"
        assert host._client is None and runtime.store.list_sessions(project.id) == []
        assert not runtime.tasks
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_codex_duplicate_begin_other_project_and_completion_are_same_attempt(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    other_root = tmp_path / "other-project"
    other_root.mkdir()
    other = runtime.store.open_project(other_root)
    try:
        first, again = await asyncio.gather(runtime.native.login(project.id, ExecutorId.CODEX),
                                           runtime.native.login(other.id, ExecutorId.CODEX))
        assert first == again and first["state"] == "waiting"
        assert len([call for call in trace(root) if call.get("method") == "account/login/start"]) == 1
        assert (await runtime.native.login_status(other.id, ExecutorId.CODEX))["loginId"] == first["loginId"]
        with pytest.raises(ConflictError):
            await runtime.native.reset_idle_hosts()
        await host._client.request("test/auth/complete", {"loginId": host._login.native_id, "success": True, "error": "PRIVATE_DETAILS"})
        result = await state(host, "succeeded")
        assert result["authUrl"] == "" and "PRIVATE_DETAILS" not in str(result)
        assert not any(call.get("method") in {"thread/start", "turn/start"} for call in trace(root))
        assert runtime.store.list_sessions(project.id) == []
        assert (await host.probe()).authentication == "ready"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_codex_early_completion_and_unrelated_notifications(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    (root / "login-behavior.json").write_text(json.dumps({"early": True}), encoding="utf8")
    try:
        first = await runtime.native.login(project.id, ExecutorId.CODEX)
        assert first["state"] == "succeeded" and not first["authUrl"]
        (root / "login-behavior.json").write_text("{}")
        second = await runtime.native.login(project.id, ExecutorId.CODEX)
        assert second["loginId"] != first["loginId"]
        await host._client.request("test/auth/complete", {"loginId": "auth-1", "success": True})
        assert host.login_status()["state"] == "waiting"
        with pytest.raises(RpcError) as error:
            await host.cancel_login(first["loginId"])
        assert error.value.code == "login_not_current"
        result = await runtime.native.login_status(project.id, ExecutorId.CODEX, cancel_id=second["loginId"])
        assert result["state"] == "cancelled"
        assert "PRIVATE_LOGIN_DIAGNOSTIC" not in str(result)
        assert (await host.cancel_login(second["loginId"])) == result
        assert sum(c.get("method") == "account/login/cancel" for c in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_codex_unknown_login_does_not_resend_and_does_not_close_development(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    (root / "login-behavior.json").write_text(json.dumps({"silent": True}), encoding="utf8")
    try:
        with pytest.raises(RpcError):
            await runtime.native.login(project.id, ExecutorId.CODEX)
        result = await runtime.native.login_status(project.id, ExecutorId.CODEX)
        assert result["state"] == "unknown" and not result["authUrl"]
        assert await runtime.native.login(project.id, ExecutorId.CODEX) == result
        assert sum(c.get("method") == "account/login/start" for c in trace(root)) == 1
        assert host._client and not host._client.closed
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["http://auth.openai.com/login", "https://auth.openai.com.evil.invalid/login", "https://auth.openai.com:8443/login", "https://user:pass@auth.openai.com/login"])
async def test_unsafe_auth_urls_are_not_exposed(tmp_path, url):
    runtime, project, root, host = await setup(tmp_path)
    (root / "login-behavior.json").write_text(json.dumps({"url": url}), encoding="utf8")
    try:
        with pytest.raises(DevelopmentError) as error:
            await runtime.native.login(project.id, ExecutorId.CODEX)
        assert error.value.code == "invalid_login_url" and url not in str(error.value)
        assert not runtime.tasks and runtime.store.list_sessions(project.id) == []
        await host.cancel_login(host.login_status()["loginId"])
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_codex_probe_refreshes_account_without_login_or_turn(tmp_path):
    runtime, _, root, host = await setup(tmp_path)
    try:
        assert (await host.probe()).authentication == "ready"
        await host._client.request("test/auth/complete", {"loginId": "external", "success": False})
        assert (await host.probe()).authentication == "required"
        assert all(c.get("method") not in {"account/login/start", "thread/start", "turn/start"} for c in trace(root))
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["succeeded", "failed", "cancelled", "timeout"])
async def test_codebuddy_login_owner_completion_cancellation_and_no_query(tmp_path, monkeypatch, outcome):
    runtime, project, _, host = await sdk_setup(tmp_path, monkeypatch, ExecutorId.CODEBUDDY)
    try:
        first = await runtime.native.login(project.id, ExecutorId.CODEBUDDY)
        assert first["state"] == "waiting" and await host.begin_login() == first
        if outcome == "cancelled":
            await host.cancel_login(first["loginId"])
        else:
            # Publish the cross-process signal atomically; a newly created empty
            # file is not evidence that the fixture should finish successfully.
            pending = host.profile.home / "auth-outcome.pending"
            pending.write_text(outcome)
            pending.replace(host.profile.home / "auth-outcome.txt")
        result = await state(host, "failed" if outcome == "timeout" else outcome)
        assert result["authUrl"] == "" and "PRIVATE_AUTH_DIAGNOSTIC" not in str(result)
        if outcome == "timeout":
            assert result["errorCode"] == "native_authentication_timeout" and "超时" in result["reason"]
        elif outcome == "failed":
            assert result["errorCode"] == "native_authentication_failed"
        calls = [json.loads(line) for line in (host.profile.home / "sdk-peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
        assert [call["method"] for call in calls] == ["auth-start", "auth-release"]
        assert calls[-1]["sameOwner"]
        assert not host._sessions and not runtime.tasks and runtime.store.list_sessions(project.id) == []
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_ended_callback_connection_can_be_rechecked_without_replaying_login(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    try:
        await runtime.native.login(project.id, ExecutorId.CODEX)
        await host._client.close()
        assert host.login_status()["state"] == "unknown"
        await host.probe()
        assert host.login_status()["state"] == "failed"
        assert sum(call.get("method") == "account/login/start" for call in trace(root)) == 1
        assert not host._threads and not runtime.tasks
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_login_http_requires_token_and_exact_attempt_and_does_not_make_tasks(tmp_path, monkeypatch):
    runtime, project, _, host = await setup(tmp_path)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-login-test")
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    url = f"/api/development/projects/{project.id}/executors/codex/login"
    headers = {"X-Mona-Token": "synthetic-login-test"}
    try:
        assert (await client.get(url)).status == 401
        first = await (await client.post(url, headers=headers)).json()
        assert first["state"] == "waiting"
        assert (await (await client.get(url, headers=headers)).json())["loginId"] == first["loginId"]
        assert (await client.delete(url + "/wrong", headers=headers)).status == 422
        assert host.login_status()["state"] == "waiting"
        cancelled = await (await client.delete(url + "/" + first["loginId"], headers=headers)).json()
        assert cancelled["state"] == "cancelled"
        assert not runtime.tasks and runtime.store.list_sessions(project.id) == []
        assert (await client.get(url.replace("codex/login", "claude/login"), headers=headers)).status == 200
    finally:
        await client.close()
