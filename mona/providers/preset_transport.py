"""Request-scoped connection details for provider presets with a special wire contract."""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx

model_session_key: ContextVar[str | None] = ContextVar("mona_model_session_key", default=None)


def opencode_session_headers(api_base: str | None, existing: Mapping[str, str] | None = None) -> dict[str, str]:
    if not api_base or urlsplit(api_base).hostname != "opencode.ai":
        return {}
    if any(name.lower() == "x-opencode-session" and value.strip() for name, value in (existing or {}).items()):
        return {}
    key = model_session_key.get()
    identity = hashlib.sha256(f"{key}\n{api_base.rstrip('/')}".encode()).hexdigest()[:32] if key else uuid.uuid4().hex
    return {"x-opencode-session": "ses_" + identity}


def openai_compatible_preset(provider: str | None, api: str, base: str) -> tuple[str, str]:
    """Use the published chat-compatibility API where Mona speaks a different wire."""
    url = urlsplit(base)
    if api == "google-generative-ai" and provider in {"opencode", "opencode-go"} and url.hostname == "opencode.ai":
        # Console's harness API translates every paid/Go text model, including Gemini.
        plan = "go/" if provider == "opencode-go" else ""
        return "openai-completions", f"https://opencode.ai/inference/{plan}openai/v1"
    if api == "google-generative-ai" and url.hostname == "generativelanguage.googleapis.com":
        return "openai-completions", "https://generativelanguage.googleapis.com/v1beta/openai"
    if api == "mistral-conversations" and url.hostname == "api.mistral.ai":
        return "openai-completions", "https://api.mistral.ai/v1"
    return api, base


def cloudflare_gateway_headers(api_base: str, api_key: str) -> dict[str, str]:
    url = urlsplit(api_base)
    if (url.scheme != "https" or url.hostname != "gateway.ai.cloudflare.com" or url.port not in {None, 443}
            or url.username is not None or url.password is not None or url.query or url.fragment
            or not re.fullmatch(r"/v1/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/(?:compat|anthropic|openai)/?", url.path)):
        raise ValueError("请填写含 Cloudflare 账户和网关 ID 的官方 AI Gateway 地址。")
    return {"cf-aig-authorization": f"Bearer {api_key}"} if api_key else {}


def cloudflare_client_factory(api_base: str, api_key: str, client_factory: Callable | None):
    auth_headers = cloudflare_gateway_headers(api_base, api_key)
    endpoint = httpx.URL(api_base)

    async def authenticate(request: httpx.Request) -> None:
        if (request.url.scheme != endpoint.scheme or request.url.host != endpoint.host or request.url.port != endpoint.port
                or not request.url.path.startswith(endpoint.path.rstrip("/") + "/")):
            raise ValueError("Cloudflare 网关凭据仅允许发送到已配置的网关。")
        request.headers.pop("authorization", None)
        request.headers.pop("x-api-key", None)
        request.headers.update(auth_headers)

    def create() -> httpx.AsyncClient:
        client = client_factory() if client_factory else httpx.AsyncClient()
        client.follow_redirects = False
        client.event_hooks["request"].append(authenticate)
        return client

    return create
