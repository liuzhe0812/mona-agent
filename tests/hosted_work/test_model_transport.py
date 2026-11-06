"""No real model calls: exercise pinning, the installed httpcore ABI and policy."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
from unittest.mock import AsyncMock

import httpx
import pytest

from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_transport import HostedModelTransport, validate_model_endpoint

BASE = "https://api.example.com/v1"


def records(*addresses, port=443):
    return [(socket.AF_INET if ipaddress.ip_address(address.split("%")[0]).version == 4 else socket.AF_INET6,
             socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port) if ":" not in address else (address, port, 0, 0))
            for address in addresses]


class Chunks(httpx.AsyncByteStream):
    def __init__(self):
        self.closed = False

    async def __aiter__(self):
        yield b"data: first\n\n"
        yield b"data: [DONE]\n\n"

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_pins_public_ip_and_preserves_original_host_sni_body_and_stream():
    seen, stream = [], Chunks()
    resolver = AsyncMock(return_value=records("2606:4700:4700::1111", "8.8.8.8"))

    async def upstream(request):
        seen.append((request, await request.aread()))
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=stream)

    transport = HostedModelTransport(BASE, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        async with client.stream("POST", BASE + "/chat/completions?stream=true", content=b"model-input",
                                 headers={"Host": "127.0.0.1", "Authorization": "Bearer synthetic-test"},
                                 extensions={"sni_hostname": "unapproved.invalid"}) as response:
            assert response.url == BASE + "/chat/completions?stream=true"
            chunks = [chunk async for chunk in response.aiter_raw()]
    pinned, body = seen[0]
    assert pinned.url.host == "8.8.8.8" and pinned.url.path == "/v1/chat/completions"
    assert pinned.headers["Host"] == "api.example.com" and pinned.headers["Authorization"] == "Bearer synthetic-test"
    assert pinned.extensions["sni_hostname"] == "api.example.com" and body == b"model-input"
    assert chunks == [b"data: first\n\n", b"data: [DONE]\n\n"] and stream.closed
    resolver.assert_awaited_once_with("api.example.com", 443)


class NetworkStream:
    def __init__(self):
        self.response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
        self.writes, self.tls = [], []
        self.closed = False

    async def read(self, max_bytes, timeout=None):
        value, self.response = self.response[:max_bytes], self.response[max_bytes:]
        return value

    async def write(self, buffer, timeout=None):
        self.writes.append(buffer)

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls.append(server_hostname)
        assert ssl_context.verify_mode == ssl.CERT_REQUIRED and ssl_context.check_hostname
        return self

    def get_extra_info(self, _name):
        return None

    async def aclose(self):
        self.closed = True


@pytest.mark.asyncio
async def test_installed_httpx_httpcore_connect_to_ip_but_start_tls_for_approved_host():
    # Exercise the real AsyncHTTPTransport -> httpcore connection path. Only
    # socket I/O is injected; this catches an unsupported SNI extension ABI.
    network = NetworkStream()
    connect = AsyncMock(return_value=network)
    inner = httpx.AsyncHTTPTransport(trust_env=False)
    inner._pool._network_backend = type("Backend", (), {"connect_tcp": connect})()
    resolver = AsyncMock(return_value=records("8.8.8.8", port=8443))
    transport = HostedModelTransport("https://api.example.com:8443/v1", resolver=resolver, transport=inner)
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        response = await client.post("https://api.example.com:8443/v1/chat/completions", content=b"payload")
        assert response.text == "OK"
    assert connect.await_args.kwargs["host"] == "8.8.8.8" and connect.await_args.kwargs["port"] == 8443
    assert network.tls == ["api.example.com"] and network.closed
    assert b"Host: api.example.com:8443\r\n" in b"".join(network.writes)


@pytest.mark.asyncio
@pytest.mark.parametrize("unsafe", [
    "10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.0.8", "192.0.0.9", "192.88.99.1",
    "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "3fff::1", "2002:0808:0808::1", "::ffff:8.8.8.8",
])
async def test_any_nonpublic_or_special_dns_record_refuses_the_entire_answer(unsafe):
    resolver = AsyncMock(return_value=records("8.8.8.8", unsafe, "1.1.1.1"))
    upstream = AsyncMock(return_value=httpx.Response(200))
    transport = HostedModelTransport(BASE, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        with pytest.raises(WorkError) as error:
            await client.post(BASE + "/chat/completions")
    assert error.value.code == "invalid_model_endpoint"
    upstream.assert_not_awaited()


@pytest.mark.asyncio
async def test_resolves_each_request_instead_of_trusting_the_preflight_or_a_stale_dns_cache():
    resolver = AsyncMock(side_effect=[records("8.8.8.8"), records("127.0.0.1")])
    upstream = AsyncMock(return_value=httpx.Response(200))
    transport = HostedModelTransport(BASE, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        assert (await client.post(BASE + "/chat/completions")).status_code == 200
        with pytest.raises(WorkError):
            await client.post(BASE + "/chat/completions")
    assert resolver.await_count == 2 and upstream.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["https://private.invalid/chat", "/v2/chat/completions"])
async def test_redirect_is_closed_and_never_followed_even_when_the_client_requests_it(location):
    stream, requests = Chunks(), []

    async def upstream(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": location}, stream=stream)

    resolver = AsyncMock(return_value=records("8.8.8.8"))
    transport = HostedModelTransport(BASE, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=True) as client:
        with pytest.raises(WorkError, match="跳转"):
            await client.post(BASE + "/chat/completions")
    assert stream.closed and len(requests) == resolver.await_count == 1


@pytest.mark.asyncio
async def test_cross_origin_request_is_refused_before_dns_or_upstream_access():
    resolver, upstream = AsyncMock(), AsyncMock()
    transport = HostedModelTransport(BASE, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        for address in ("https://elsewhere.example.com/v1/chat", "http://api.example.com/v1/chat",
                        "https://api.example.com:8443/v1/chat", "https://api.example.com:0/v1/chat"):
            with pytest.raises(WorkError, match="批准"):
                await client.post(address)
    resolver.assert_not_awaited()
    upstream.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])
async def test_explicit_loopback_switch_allows_only_literal_local_lines_without_dns(url):
    resolver = AsyncMock(side_effect=AssertionError("literal loopback must not use DNS"))
    with pytest.raises(WorkError):
        await validate_model_endpoint(url)
    assert await validate_model_endpoint(url, allow_loopback=True, resolver=resolver) == url
    upstream = AsyncMock(return_value=httpx.Response(200, content=b"local"))
    transport = HostedModelTransport(url, allow_loopback=True, resolver=resolver, transport=httpx.MockTransport(upstream))
    async with httpx.AsyncClient(transport=transport, trust_env=False) as client:
        assert (await client.post(url + "/chat/completions")).text == "local"
    resolver.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["http://api.example.com/v1", "http://192.168.1.1/v1", "https://172.16.0.1/v1",
                                 "http://127.0.0.2/v1", "https://localhost/v1", "https://[fe80::1%25lo0]/v1"])
async def test_loopback_switch_does_not_allow_private_networks_or_hostname_aliases(url):
    with pytest.raises(WorkError):
        await validate_model_endpoint(url, allow_loopback=True)
    with pytest.raises(WorkError):
        await validate_model_endpoint(BASE, allow_loopback=True, resolver=AsyncMock(return_value=records("127.0.0.1")))


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["false", 1, None])
async def test_loopback_requires_an_explicit_boolean_flag(flag):
    with pytest.raises(WorkError):
        await validate_model_endpoint("http://127.0.0.1:8000/v1", allow_loopback=flag)


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["https://user:password@api.example.com/v1", "https://api.example.com/v1?key=value",
                                 "https://api.example.com/v1#fragment", "https://api.example.com:0/v1",
                                 "https://api.example.com\\@127.0.0.1/v1", " https://api.example.com/v1"])
async def test_endpoint_rejects_credentials_queries_fragments_and_ambiguous_addresses(url):
    with pytest.raises(WorkError) as error:
        await validate_model_endpoint(url)
    assert "password" not in error.value.message and "key=value" not in error.value.message


@pytest.mark.asyncio
async def test_preflight_uses_async_getaddrinfo_and_returns_canonical_base(monkeypatch):
    resolve = AsyncMock(return_value=records("8.8.8.8", "1.1.1.1"))
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
    assert await validate_model_endpoint("https://API.EXAMPLE.COM:443/v1/") == BASE
    resolve.assert_awaited_once_with("api.example.com", 443, family=socket.AF_UNSPEC,
                                    type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)


@pytest.mark.asyncio
async def test_dns_failure_timeout_and_empty_answers_fail_without_leaking_hostnames():
    for resolver in (AsyncMock(side_effect=socket.gaierror("private-name.internal")), AsyncMock(return_value=[])):
        with pytest.raises(WorkError) as error:
            await validate_model_endpoint(BASE, resolver=resolver)
        assert "private-name" not in error.value.message

    async def blocked(*_args):
        await asyncio.Event().wait()

    with pytest.raises(WorkError) as error:
        await validate_model_endpoint(BASE, resolver=blocked, dns_timeout=0.001)
    assert error.value.code == "model_endpoint_unavailable"


@pytest.mark.asyncio
async def test_close_releases_inner_transport_once_and_default_transport_disables_environment(monkeypatch):
    inner = httpx.MockTransport(lambda _request: httpx.Response(200))
    inner.aclose = AsyncMock()
    options = {}

    def construct(**kwargs):
        options.update(kwargs)
        return inner

    monkeypatch.setattr("mona.hosted_work.model_transport.httpx.AsyncHTTPTransport", construct)
    transport = HostedModelTransport(BASE)
    assert options["trust_env"] is False and options["verify"] is True and options["retries"] == 0
    assert options["http2"] is False and "proxy" not in options and "uds" not in options
    await transport.aclose()
    await transport.aclose()
    inner.aclose.assert_awaited_once()
