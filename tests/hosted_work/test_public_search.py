"""Search uses the desktop implementation without bypassing hosted isolation."""
import asyncio
import json
import socket

import httpx
import pytest

from mona.agent.tools.web import WebSearchTool
from mona.hosted_work.model_transport import HostedModelTransport
from mona.hosted_work.public_search import HostedWebSearchTool


def client(resolver, handler):
    return httpx.AsyncClient(
        transport=HostedModelTransport(
            "https://api.anysearch.com", resolver=resolver, transport=httpx.MockTransport(handler),
        ),
        trust_env=False,
        follow_redirects=False,
    )


async def public_dns(host, port):
    assert (host, port) == ("api.anysearch.com", 443)
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]


@pytest.mark.asyncio
async def test_hosted_search_reuses_desktop_output_with_pinned_public_connection(monkeypatch):
    monkeypatch.delenv("ANYSEARCH_API_KEY", raising=False)
    seen = []

    def provider(request):
        seen.append(request)
        assert request.url.host == "8.8.8.8"
        assert request.headers["host"] == "api.anysearch.com"
        assert request.extensions["sni_hostname"] == "api.anysearch.com"
        assert "authorization" not in request.headers
        assert json.loads(request.content)["query"] == "Mona 产品"
        return httpx.Response(200, json={"code": 0, "data": {"results": [
            {"title": "Mona", "url": "https://example.org", "snippet": "产品资料"},
        ]}})

    search = HostedWebSearchTool()
    assert isinstance(search, WebSearchTool)
    search._anysearch_client_factory = lambda: client(public_dns, provider)
    result = await search.execute("Mona 产品", count=1)
    assert len(seen) == 1 and "Mona" in result and "https://example.org" in result and "产品资料" in result


@pytest.mark.asyncio
async def test_hosted_search_rejects_private_dns_and_does_not_fallback_to_ddgs(monkeypatch):
    monkeypatch.delenv("ANYSEARCH_API_KEY", raising=False)

    async def private_dns(_host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]

    def forbidden(_request):
        pytest.fail("must not connect to a private address")

    async def desktop_fallback(*_args, **_kwargs):
        pytest.fail("desktop fallback does not enforce the hosted network boundary")

    monkeypatch.setattr(WebSearchTool, "_search_duckduckgo", desktop_fallback)
    search = HostedWebSearchTool()
    search._anysearch_client_factory = lambda: client(private_dns, forbidden)
    assert "搜索暂时不可用" in await search.execute("Mona")


@pytest.mark.asyncio
async def test_hosted_search_is_cancellable(monkeypatch):
    monkeypatch.delenv("ANYSEARCH_API_KEY", raising=False)
    entered = asyncio.Event()

    async def provider(_request):
        entered.set()
        await asyncio.Event().wait()

    search = HostedWebSearchTool()
    search._anysearch_client_factory = lambda: client(public_dns, provider)
    task = asyncio.create_task(search.execute("Mona"))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
