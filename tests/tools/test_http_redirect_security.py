from __future__ import annotations

import json
import secrets
import socket

import httpx
import pytest

from mona.agent.tools.http import HttpTool


@pytest.fixture
def mock_client(monkeypatch):
    client_type = httpx.AsyncClient

    def install(handler):
        def client(*args, **kwargs):
            return client_type(*args, **kwargs, transport=httpx.MockTransport(handler))

        def resolve(host, *args):
            if host in {"127.0.0.1", "::ffff:127.0.0.1"}:
                ip = host
            elif host == "private.example":
                ip = "10.0.0.1"
            else:
                ip = "93.184.216.34"
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 0))]

        monkeypatch.setattr("mona.agent.tools.http.httpx.AsyncClient", client)
        monkeypatch.setattr("mona.security.network.socket.getaddrinfo", resolve)

    return install


@pytest.mark.asyncio
@pytest.mark.parametrize("target", [
    "http://127.0.0.1:17173/a",
    "http://private.example/a",
    "http://[::ffff:127.0.0.1]/a",
])
async def test_post_redirect_to_private_address_is_blocked_before_dispatch(mock_client, target):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": target})

    mock_client(handler)
    result = json.loads(await HttpTool().execute("https://origin.example/", method="POST", body="test"))
    assert "Redirect blocked" in result["error"]
    assert len(requests) == 1
    assert requests[0].method == "POST"


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected", [(301, "GET"), (302, "GET"), (303, "GET"), (307, "POST"), (308, "POST")])
async def test_redirect_preserves_http_method_semantics(mock_client, status, expected):
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(status, headers={"Location": "/final"})
        return httpx.Response(200, content=b"ok")

    mock_client(handler)
    result = json.loads(await HttpTool().execute("https://origin.example/start", method="POST", body="data"))
    assert result["status"] == 200
    assert str(requests[1].url) == "https://origin.example/final"
    assert requests[1].method == expected
    assert requests[1].content == (b"data" if expected == "POST" else b"")


@pytest.mark.asyncio
@pytest.mark.parametrize("cross_origin", [False, True])
@pytest.mark.parametrize("status", [302, 307])
async def test_redirect_sensitive_headers_follow_origin_boundary(mock_client, cross_origin, status):
    credential = secrets.token_hex(16)
    requests = []

    def handler(request):
        requests.append(request)
        if len(requests) == 1:
            location = "https://other.example/final" if cross_origin else "/final"
            return httpx.Response(status, headers={"Location": location})
        return httpx.Response(200, content=b"ok")

    mock_client(handler)
    result = json.loads(await HttpTool().execute(
        "https://origin.example/start", method="POST", body="data", headers={
            "Authorization": credential,
            "X-API-Key": credential,
            "Cookie": f"fixture={credential}",
        },
    ))
    assert result["status"] == 200
    assert requests[0].headers["authorization"] == credential
    assert requests[1].method == ("GET" if status == 302 else "POST")
    assert requests[1].content == (b"" if status == 302 else b"data")
    if cross_origin:
        assert "authorization" not in requests[1].headers
        assert "x-api-key" not in requests[1].headers
        assert "cookie" not in requests[1].headers
    else:
        assert requests[1].headers["authorization"] == credential
        assert requests[1].headers["x-api-key"] == credential


@pytest.mark.asyncio
async def test_redirect_limit_and_no_retry_on_unknown_post_result(mock_client):
    requests = []

    def redirect_forever(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "/next"})

    mock_client(redirect_forever)
    result = json.loads(await HttpTool().execute("https://origin.example/"))
    assert "TooManyRedirects" in result["error"]
    assert len(requests) == 6

    requests.clear()

    def timeout(request):
        requests.append(request)
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    mock_client(timeout)
    result = json.loads(await HttpTool().execute("https://origin.example/", method="POST", body="data"))
    assert "timed out" in result["error"].lower()
    assert len(requests) == 1
