from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from mona.agent.tools.tauri_ipc import tauri_invoke
from mona.providers.openai_compat_provider import OpenAICompatProvider
from mona.providers.registry import ProviderSpec


class MonaManagedProvider(OpenAICompatProvider):
    def __init__(self, *, default_model: str, spec: ProviderSpec):
        super().__init__(
            api_key="pending-model-access-token",
            api_base=spec.default_api_base,
            default_model=default_model,
            spec=spec,
        )
        self._credential_expiry = 0.0
        self._credential_lock = asyncio.Lock()

    async def _refresh_credentials(self, *, force: bool = False) -> None:
        if not force and time.monotonic() < self._credential_expiry:
            return
        async with self._credential_lock:
            if not force and time.monotonic() < self._credential_expiry:
                return
            credentials = await asyncio.to_thread(tauri_invoke, "get_model_access_credentials")
            if not isinstance(credentials, dict):
                raise RuntimeError("Invalid managed model credentials")
            token = credentials.get("access_token")
            api_base = credentials.get("api_base")
            expires_in = credentials.get("expires_in")
            if not isinstance(token, str) or not token:
                raise RuntimeError("Managed model token is missing")
            if not isinstance(api_base, str) or not api_base.startswith("https://"):
                raise RuntimeError("Managed model API base is invalid")
            if not isinstance(expires_in, int) or expires_in <= 0:
                raise RuntimeError("Managed model token expiry is invalid")

            previous_client = self._client
            self._client = None
            self._api_key_for_client = token
            self.api_base = api_base
            self._effective_base = api_base
            self._credential_expiry = time.monotonic() + max(1, expires_in * 60 - 60)
            if previous_client is not None:
                await previous_client.close()

    def _build_kwargs(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        request = super()._build_kwargs(*args, **kwargs)
        request["extra_headers"] = {"X-Request-ID": uuid.uuid4().hex}
        return request

    @staticmethod
    def _friendly_error(response: Any) -> Any:
        messages = {
            402: "模型余额不足，请在账户中充值后重试。",
            429: "当前请求过于频繁，请稍后重试。",
            503: "Mona AI 暂时繁忙，请稍后重试或切换到我的 API Key。",
        }
        if response.error_status_code in messages:
            response.content = messages[response.error_status_code]
        if response.finish_reason == "error" or response.error_status_code is not None:
            response.error_should_retry = False
        return response

    async def chat(self, *args: Any, **kwargs: Any):
        await self._refresh_credentials()
        response = await super().chat(*args, **kwargs)
        if response.error_status_code == 401:
            await self._refresh_credentials(force=True)
            response = await super().chat(*args, **kwargs)
        return self._friendly_error(response)

    async def chat_stream(self, *args: Any, **kwargs: Any):
        await self._refresh_credentials()
        response = await super().chat_stream(*args, **kwargs)
        if response.error_status_code == 401:
            await self._refresh_credentials(force=True)
            response = await super().chat_stream(*args, **kwargs)
        return self._friendly_error(response)
