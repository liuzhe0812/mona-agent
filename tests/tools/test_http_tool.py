"""Tests for the HTTP request tool."""

from __future__ import annotations

import json
import socket
from unittest.mock import patch

import httpx
import pytest

from mona.agent.tools.http import HttpTool, HttpToolConfig


def _fake_resolve_public(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 0))]


def _fake_resolve_private(hostname, port, family=0, type_=0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("169.254.169.254", 0))]


@pytest.fixture
def tool():
    return HttpTool(config=HttpToolConfig())


@pytest.mark.asyncio
async def test_blocks_private_ip(tool):
    with patch("mona.security.network.socket.getaddrinfo", _fake_resolve_private):
        result = await tool.execute(url="http://169.254.169.254/")
    data = json.loads(result)
    assert "error" in data
    assert "private" in data["error"].lower() or "blocked" in data["error"].lower()


@pytest.mark.asyncio
async def test_blocks_localhost(tool):
    def _resolve(hostname, port, family=0, type_=0):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 0))]
    with patch("mona.security.network.socket.getaddrinfo", _resolve):
        result = await tool.execute(url="http://localhost/admin")
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_blocks_non_http_scheme(tool):
    result = await tool.execute(url="file:///etc/passwd")
    data = json.loads(result)
    assert "error" in data


@pytest.mark.asyncio
async def test_unsupported_method_rejected(tool):
    result = await tool.execute(url="https://example.com", method="TRACE")
    data = json.loads(result)
    assert "error" in data
    assert "Unsupported method" in data["error"]


@pytest.mark.asyncio
async def test_successful_get_request(tool):
    """Mock httpx to return a controlled response."""
    fake_response = httpx.Response(
        status_code=200,
        headers={"content-type": "application/json"},
        content=b'{"ok": true}',
        request=httpx.Request("GET", "https://api.example.com/"),
    )

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, **kwargs):
            return fake_response

    with patch("mona.agent.tools.http.httpx.AsyncClient", FakeClient), \
         patch("mona.security.network.socket.getaddrinfo", _fake_resolve_public), \
         patch("mona.security.network.validate_resolved_url", return_value=(True, "")):
        result = await tool.execute(url="https://api.example.com/")
    data = json.loads(result)
    assert data["status"] == 200
    assert data["method"] == "GET"
    assert '"ok": true' in data["body"]  # pretty-printed JSON


@pytest.mark.asyncio
async def test_redacts_sensitive_headers(tool):
    fake_response = httpx.Response(
        status_code=200,
        headers={"content-type": "text/plain", "set-cookie": "session=abc123; path=/"},
        content=b"hello",
        request=httpx.Request("GET", "https://example.com/"),
    )

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, **kwargs):
            return fake_response

    with patch("mona.agent.tools.http.httpx.AsyncClient", FakeClient), \
         patch("mona.security.network.socket.getaddrinfo", _fake_resolve_public), \
         patch("mona.security.network.validate_resolved_url", return_value=(True, "")):
        result = await tool.execute(url="https://example.com/")
    data = json.loads(result)
    # set-cookie should be redacted
    assert "set-cookie" in data["headers"]
    assert "session=abc123" not in data["headers"]["set-cookie"]


@pytest.mark.asyncio
async def test_json_body_auto_sets_content_type(tool):
    captured_headers: dict[str, str] = {}

    fake_response = httpx.Response(
        status_code=200,
        content=b"ok",
        request=httpx.Request("POST", "https://api.example.com/"),
    )

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, headers=None, **kwargs):
            captured_headers.update(headers or {})
            return fake_response

    with patch("mona.agent.tools.http.httpx.AsyncClient", FakeClient), \
         patch("mona.security.network.socket.getaddrinfo", _fake_resolve_public), \
         patch("mona.security.network.validate_resolved_url", return_value=(True, "")):
        await tool.execute(
            url="https://api.example.com/",
            method="POST",
            body='{"name": "test"}',
        )
    assert captured_headers.get("Content-Type") == "application/json"


@pytest.mark.asyncio
async def test_timeout_returns_error(tool):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, *args, **kwargs):
            raise httpx.TimeoutException("timed out")

    with patch("mona.agent.tools.http.httpx.AsyncClient", FakeClient), \
         patch("mona.security.network.socket.getaddrinfo", _fake_resolve_public):
        result = await tool.execute(url="https://example.com/", timeout=1)
    data = json.loads(result)
    assert "error" in data
    assert "timed out" in data["error"].lower()
