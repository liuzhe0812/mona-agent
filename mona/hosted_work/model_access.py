"""Operator-owned model connection. No user JWT, Pro status, wallet or desktop credentials."""
from __future__ import annotations

import os
from urllib.parse import urlsplit

import httpx

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import WorkError
from mona.providers.openai_compat_provider import OpenAICompatProvider
from mona.providers.registry import ProviderSpec


def model_endpoint(config: HostedWorkConfig, selection: HostedWorkModel) -> str:
    base = selection.api_base.rstrip("/")
    try:
        parsed = urlsplit(base)
        secure = parsed.scheme == "https"
        local = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1"}
        if (not base or not (secure or local) or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment
                or any(ord(c) < 33 or ord(c) == 127 for c in base) or "\\" in base):
            raise ValueError("invalid operator endpoint")
        parsed.port  # Reject malformed ports before a client is created.
        auth = urlsplit(config.auth_origin)
        if parsed.netloc.lower() == auth.netloc.lower() and (
                parsed.path.rstrip("/") == "/v1" or parsed.path.startswith(("/auth", "/model-access", "/internal/"))):
            raise ValueError("online work must not use the existing account-model gateway")
    except ValueError as exc:
        raise WorkError("model_configuration", "平台模型连接尚未正确配置。", 503) from exc
    return base


def model_secret(selection: HostedWorkModel) -> str:
    if not selection.api_key_env:
        raise WorkError("model_configuration", "平台尚未配置在线 Work 专用的模型凭据。", 503)
    secret = os.environ.get(selection.api_key_env, "")
    if not secret or len(secret) > 8192 or not secret.isascii() or any(ord(c) < 33 or ord(c) == 127 for c in secret):
        raise WorkError("model_configuration", "平台尚未配置在线 Work 专用的模型凭据。", 503)
    return secret


class HostedAPIProvider(OpenAICompatProvider):
    def __init__(self, config: HostedWorkConfig, selection: HostedWorkModel):
        super().__init__(api_key=model_secret(selection), api_base=model_endpoint(config, selection),
            default_model=selection.model,
            spec=ProviderSpec(name="hosted_work_api", keywords=(), env_key="", display_name=selection.label,
                              is_direct=True, allow_auto_fallback=False))
        self.http_client_factory = lambda: httpx.AsyncClient(
            trust_env=False, follow_redirects=False, timeout=min(config.run_timeout_seconds, 120),
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4))

    @staticmethod
    def _safe_failure(response):
        if response.finish_reason == "error":
            messages = {401: "平台模型认证失败，请联系管理员。", 403: "平台模型暂无访问权限，请联系管理员。",
                        429: "平台模型当前繁忙，请稍后重试。"}
            response.content = messages.get(response.error_status_code, "平台模型调用未完成，已有任务记录已保留。")
        return response

    async def chat(self, *args, **kwargs):
        return self._safe_failure(await super().chat(*args, **kwargs))

    async def chat_stream(self, *args, **kwargs):
        return self._safe_failure(await super().chat_stream(*args, **kwargs))
