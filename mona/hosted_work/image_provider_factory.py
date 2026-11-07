"""Build the desktop Codex image provider with a fixed, bounded network route."""
from __future__ import annotations

import httpx

from mona.config.schema import HostedCodexSettings
from mona.hosted_work.codex_image_provider import (
    HostedCodexImageGenerationClient,
    codex_image_ready,
)
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.providers import codex_operator

_URL = httpx.URL("https://chatgpt.com/backend-api/codex/responses")


class _FixedCodexTransport(httpx.AsyncBaseTransport):
    """Only the fixed HTTPS Codex endpoint may be contacted through the local proxy."""

    def __init__(self, proxy: str, *, transport=None):
        HostedCodexSettings(local_proxy_url=proxy)
        self.inner = transport or httpx.AsyncHTTPTransport(proxy=proxy or None, trust_env=False, retries=0, verify=True)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method != "POST" or request.url != _URL:
            raise WorkError("invalid_image_endpoint", "图片服务地址无效。", 400)
        response = await self.inner.handle_async_request(request)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise WorkError("invalid_image_endpoint", "图片服务发生跳转。", 503)
        return response

    async def aclose(self):
        await self.inner.aclose()


class _Provider:
    def __init__(self, client, provider):
        self.client, self.provider = client, provider

    async def generate(self, **kwargs):
        return await self.provider.generate(**kwargs)

    @property
    def request_started(self):
        return self.provider.request_started

    async def aclose(self):
        await self.client.aclose()


async def make_codex_image_provider(config, _image):
    admin = codex_operator(config)
    profile = admin.profile(config.codex)
    if not codex_image_ready(admin, profile):
        raise WorkError("image_unavailable", "图片账号尚未就绪，请检查登录状态。", 503)
    client = httpx.AsyncClient(transport=_FixedCodexTransport(config.codex.local_proxy_url),
                               timeout=config.tool_timeout_seconds, trust_env=False, follow_redirects=False)
    try:
        provider = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client,
            max_response_bytes=4 * ((config.max_file_bytes + 2) // 3) + 2_000_000)
    except BaseException:
        await client.aclose()
        raise
    return _Provider(client, provider)
