import asyncio
import base64
import json
import traceback
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from mona.development.executors import codex
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import CodexProfile
from mona.development.executors.codex_work_auth import read_codex_work_auth
from mona.development.executors.rpc import RpcError


def _jwt(account_id):
    body = json.dumps({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}).encode()
    return ".".join((uuid4().hex, base64.urlsafe_b64encode(body).decode().rstrip("="), uuid4().hex))


@pytest.fixture
def setup_host(tmp_path, monkeypatch):
    executable = tmp_path / "native.exe"
    executable.write_bytes(b"fixture")
    root = tmp_path / "project"
    root.mkdir()
    client = SimpleNamespace(request=AsyncMock())
    host = SimpleNamespace(_ensure_started=AsyncMock(return_value=client), shutdown=AsyncMock())
    monkeypatch.setattr(codex, "CodexExecutor", lambda _profile: host)
    return executable, tmp_path / "home", root, host, client


async def test_reads_work_account_and_rechecks_identity(setup_host):
    executable, home, root, host, client = setup_host
    selected = uuid4().hex
    token = _jwt(uuid4().hex)
    status = {"authMethod": "chatgpt", "authToken": token}
    client.request.side_effect = [status, {"account": {"type": "chatgpt", "planType": "plus"},
                                          "workspaceRouting": {"chatgptAccountId": selected}}, status]

    result = await read_codex_work_auth(executable, home, root, refresh=True, expected_account_id=selected)

    assert result == {"type": "chatgptAuthTokens", "accessToken": token,
                      "chatgptAccountId": selected, "chatgptPlanType": "plus"}
    assert client.request.await_args_list[0].args == ("getAuthStatus", {"includeToken": True, "refreshToken": True})
    assert client.request.await_args_list[-1].args == ("getAuthStatus", {"includeToken": True, "refreshToken": False})
    host.shutdown.assert_awaited_once()
    assert not (home / "auth.json").exists()


async def test_uses_jwt_workspace_only_when_routing_is_unavailable(setup_host):
    executable, home, root, host, client = setup_host
    account_id = uuid4().hex
    status = {"authMethod": "chatgpt", "authToken": _jwt(account_id)}
    client.request.side_effect = [status, {"account": {"type": "chatgpt"}}, status]

    result = await read_codex_work_auth(executable, home, root)

    assert result["chatgptAccountId"] == account_id
    assert result["chatgptPlanType"] is None
    host.shutdown.assert_awaited_once()


async def test_reads_api_key_account_without_exposing_it_to_files(setup_host):
    executable, home, root, host, client = setup_host
    token = uuid4().hex
    status = {"authMethod": "apikey", "authToken": token}
    client.request.side_effect = [status, {"account": {"type": "apiKey"}}, status]

    assert await read_codex_work_auth(executable, home, root) == {"type": "apiKey", "apiKey": token}
    host.shutdown.assert_awaited_once()
    assert not (home / "auth.json").exists()


@pytest.mark.parametrize("failure", ["missing_token", "missing_account_id", "account_changed", "status_changed", "wrong_type"])
async def test_rejects_unverified_or_changed_account(setup_host, failure):
    executable, home, root, host, client = setup_host
    account_id = uuid4().hex
    status = {"authMethod": "chatgpt", "authToken": _jwt(account_id)}
    account = {"account": {"type": "chatgpt"}, "workspaceRouting": {"chatgptAccountId": account_id}}
    current = status.copy()
    if failure == "missing_token":
        status["authToken"] = None
    elif failure == "missing_account_id":
        status["authToken"] = current["authToken"] = uuid4().hex
        account["workspaceRouting"] = None
    elif failure == "status_changed":
        current["authToken"] = _jwt(account_id)
    elif failure == "wrong_type":
        account["account"] = {"type": "apiKey"}
    expected = uuid4().hex if failure == "account_changed" else account_id
    client.request.side_effect = [status, account, current]

    with pytest.raises(RpcError) as error:
        await read_codex_work_auth(executable, home, root, expected_account_id=expected)

    assert error.value.code == "native_auth_binding_unavailable"
    host.shutdown.assert_awaited_once()


async def test_failure_and_cleanup_never_surface_credential_contents(setup_host):
    executable, home, root, host, client = setup_host
    secret = uuid4().hex
    client.request.side_effect = ValueError(secret)
    with pytest.raises(RpcError) as error:
        await read_codex_work_auth(executable, home, root)
    assert error.value.code == "native_auth_binding_unavailable"
    assert secret not in "".join(traceback.format_exception(error.value))
    host.shutdown.assert_awaited_once()

    client.request.reset_mock(side_effect=True)
    host.shutdown.reset_mock()
    status = {"authMethod": "apikey", "authToken": secret}
    client.request.side_effect = [status, {"account": {"type": "apiKey"}}, status]
    host.shutdown.side_effect = ValueError(secret)
    with pytest.raises(RpcError) as error:
        await read_codex_work_auth(executable, home, root)
    assert error.value.code == "native_exit_unconfirmed" and error.value.outcome_unknown
    assert secret not in "".join(traceback.format_exception(error.value))


async def test_cancellation_closes_account_host(setup_host):
    executable, home, root, host, client = setup_host
    client.request.side_effect = asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await read_codex_work_auth(executable, home, root)
    host.shutdown.assert_awaited_once()


async def test_repeated_cancellation_waits_for_starting_account_host_to_close(setup_host, monkeypatch):
    executable, home, root, _, _ = setup_host
    profile = CodexProfile((str(executable), "app-server"), home, root, {})
    host = CodexExecutor(profile)
    started = asyncio.Event()
    finish_start = asyncio.Event()
    cleaning = asyncio.Event()
    client = SimpleNamespace(closed=False, close=AsyncMock())

    async def start():
        started.set()
        await finish_start.wait()
        host._client = client
        return client

    shutdown = host.shutdown

    async def track_shutdown():
        cleaning.set()
        await shutdown()

    monkeypatch.setattr(host, "_start", start)
    monkeypatch.setattr(host, "shutdown", track_shutdown)
    monkeypatch.setattr(codex, "CodexExecutor", lambda _profile: host)

    task = asyncio.create_task(read_codex_work_auth(executable, home, root))
    await started.wait()
    task.cancel()
    await cleaning.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    finish_start.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    client.close.assert_awaited_once()
