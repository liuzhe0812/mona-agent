"""The authenticated Codex image request cannot be redirected to another host."""
import httpx
import pytest

from mona.hosted_work.contracts import WorkError
from mona.hosted_work.image_provider_factory import _FixedCodexTransport


@pytest.mark.asyncio
async def test_codex_image_transport_rejects_other_destinations_and_redirects():
    async with httpx.AsyncClient(transport=_FixedCodexTransport("", transport=httpx.MockTransport(
        lambda _: httpx.Response(200, text="ok")))) as client:
        response = await client.post("https://chatgpt.com/backend-api/codex/responses")
        assert response.status_code == 200
        with pytest.raises(WorkError):
            await client.post("https://example.com/backend-api/codex/responses")
    async with httpx.AsyncClient(transport=_FixedCodexTransport("", transport=httpx.MockTransport(
        lambda _: httpx.Response(302, headers={"Location": "https://example.com"})))) as client:
        with pytest.raises(WorkError):
            await client.post("https://chatgpt.com/backend-api/codex/responses")


def test_proxy_cannot_be_an_arbitrary_remote_url():
    with pytest.raises(ValueError):
        _FixedCodexTransport("http://example.com:8080")
