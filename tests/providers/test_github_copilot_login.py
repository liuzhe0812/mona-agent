import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from oauth_cli_kit.models import OAuthToken

from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel, WebSocketConfig
from mona.providers import github_copilot_provider as copilot
from mona.webui import copilot_login


def _token(value: str) -> OAuthToken:
    return OAuthToken(access=value, refresh="", expires=int((time.time() + 3600) * 1000))


@pytest.mark.asyncio
async def test_device_flow_uses_safe_verification_page_and_does_not_persist(monkeypatch):
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.path)
        if request.url.path == "/login/device/code":
            return httpx.Response(200, json={
                "device_code": "private-device-code", "user_code": "ABCD-EFGH",
                "verification_uri": "https://github.com/login/device?unexpected=private",
                "interval": 1, "expires_in": 60,
            })
        if request.url.path == "/login/oauth/access_token":
            if requests.count("/login/oauth/access_token") == 1:
                return httpx.Response(200, json={"error": "authorization_pending"})
            return httpx.Response(200, json={"access_token": "fake-token", "expires_in": 3600})
        return httpx.Response(200, json={"login": "test-account"})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(copilot.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handle), **kwargs,
    ))
    monkeypatch.setattr(copilot, "get_storage", lambda: pytest.fail("device flow must not save"))
    codes = []
    token = await copilot.request_github_copilot_token(lambda code, url: codes.append((code, url)))
    assert codes == [("ABCD-EFGH", "https://github.com/login/device")]
    assert token.access == "fake-token"
    assert requests == [
        "/login/device/code", "/login/oauth/access_token", "/login/oauth/access_token", "/user",
    ]


@pytest.mark.parametrize("url", [
    "http://github.com/login/device", "https://github.com.evil.test/login/device",
    "https://github.com@evil.test/login/device", "https://github.com:444/login/device",
    "https://github.com/login/oauth/authorize", "javascript:alert(1)",
])
def test_device_login_rejects_untrusted_verification_pages(url):
    with pytest.raises(copilot.CopilotDeviceLoginError):
        copilot._github_verification_url(url)


@pytest.mark.asyncio
async def test_cancelled_or_superseded_attempt_never_saves_or_changes_status(monkeypatch):
    gates = [asyncio.Event(), asyncio.Event(), asyncio.Event()]
    saved = []
    calls = 0

    async def request(on_code):
        nonlocal calls
        index = calls
        calls += 1
        on_code(f"TEST-000{index}", "https://github.com/login/device")
        try:
            await gates[index].wait()
        except asyncio.CancelledError:
            # A response can arrive after cancellation even if an implementation
            # below the session ignores task cancellation.
            await gates[index].wait()
        on_code("LATE-CODE", "https://github.com/login/device")
        return _token(f"fake-token-{index}")

    monkeypatch.setattr(copilot, "request_github_copilot_token", request)
    monkeypatch.setattr(copilot, "get_storage", lambda: SimpleNamespace(save=lambda token: saved.append(token.access)))
    monkeypatch.setattr(copilot_login, "github_copilot_authorized", lambda: bool(saved))
    session = copilot_login.CopilotLoginSession()
    assert session.start() == {"status": "starting"}
    await asyncio.sleep(0)
    assert session.get_status()["status"] == "waiting"

    session.start()
    await asyncio.sleep(0)
    gates[1].set()
    await asyncio.sleep(0)
    assert session.get_status() == {"status": "authorized"}
    gates[0].set()
    await asyncio.sleep(0)
    assert saved == ["fake-token-1"]
    assert session.get_status() == {"status": "authorized"}

    session.start()
    await asyncio.sleep(0)
    assert session.cancel() == {"status": "authorized"}
    gates[2].set()
    await asyncio.sleep(0)
    assert saved == ["fake-token-1"]
    assert session.get_status() == {"status": "authorized"}


@pytest.mark.asyncio
async def test_login_failure_does_not_expose_provider_exception(monkeypatch):
    async def request(_on_code):
        raise RuntimeError("private-device-code and fake-token")

    monkeypatch.setattr(copilot, "request_github_copilot_token", request)
    monkeypatch.setattr(copilot_login, "github_copilot_authorized", lambda: False)
    session = copilot_login.CopilotLoginSession()
    session.start()
    await asyncio.sleep(0)
    status = session.get_status()
    assert status["status"] == "failed"
    assert "private-device-code" not in str(status) and "fake-token" not in str(status)


@pytest.mark.asyncio
async def test_login_http_routes_require_runtime_token_and_never_return_device_secrets(monkeypatch):
    monkeypatch.setattr("mona.channels.websocket._load_or_create_media_secret", lambda: b"x" * 32)
    monkeypatch.setattr(copilot_login, "github_copilot_authorized", lambda: False)
    pending = asyncio.Event()

    async def request(on_code):
        on_code("ABCD-EFGH", "https://github.com/login/device")
        await pending.wait()
        return _token("fake-secret-token")

    monkeypatch.setattr(copilot, "request_github_copilot_token", request)
    channel = WebSocketChannel(WebSocketConfig(), MessageBus())
    channel._runtime_token = "test-runtime-token"
    base = "/api/settings/providers/github-copilot/login/"
    for action in ("start", "status", "cancel"):
        reply = await channel._dispatch_http(None, SimpleNamespace(path=base + action, headers={}))
        assert reply.status_code == 401
    assert channel._copilot_login_session is None

    def authorized(action):
        return SimpleNamespace(path=base + action, headers={"Authorization": "Bearer test-runtime-token"})

    response = await channel._dispatch_http(None, authorized("start"))
    assert json.loads(response.body)["status"] == "starting"
    await asyncio.sleep(0)
    response = await channel._dispatch_http(None, authorized("status"))
    assert json.loads(response.body) == {
        "status": "waiting", "user_code": "ABCD-EFGH", "verification_url": "https://github.com/login/device",
    }
    response = await channel._dispatch_http(None, authorized("cancel"))
    assert json.loads(response.body) == {"status": "idle"}
    assert b"fake-secret-token" not in response.body


def test_authorized_requires_a_saved_unexpired_oauth_token(monkeypatch):
    monkeypatch.setattr(copilot, "_load_github_token", lambda: _token("fake-token"))
    assert copilot.github_copilot_authorized()
    monkeypatch.setattr(copilot, "_load_github_token", lambda: OAuthToken(access="fake", refresh="", expires=1))
    assert not copilot.github_copilot_authorized()
    monkeypatch.setattr(copilot, "_load_github_token", lambda: None)
    assert not copilot.github_copilot_authorized()


def test_legacy_login_uses_the_same_device_flow_and_storage(monkeypatch):
    opened, saved, printed = [], [], []

    async def request(on_code):
        on_code("ABCD-EFGH", "https://github.com/login/device")
        return _token("fake-token")

    monkeypatch.setattr(copilot, "request_github_copilot_token", request)
    monkeypatch.setattr(copilot.webbrowser, "open", opened.append)
    monkeypatch.setattr(copilot, "get_storage", lambda: SimpleNamespace(save=lambda token: saved.append(token.access)))
    assert copilot.login_github_copilot(print_fn=printed.append).access == "fake-token"
    assert opened == ["https://github.com/login/device"]
    assert saved == ["fake-token"]
    assert printed == ["Open: https://github.com/login/device", "Code: ABCD-EFGH"]
