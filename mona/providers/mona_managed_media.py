from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx
from loguru import logger


class MonaManagedMediaError(RuntimeError):
    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ManagedMediaCredentials:
    access_token: str
    api_base: str


def _tauri_invoke(name: str) -> Any:
    from mona.agent.tools.tauri_ipc import tauri_invoke

    return tauri_invoke(name)


async def managed_media_credentials() -> ManagedMediaCredentials:
    raw = await asyncio.to_thread(_tauri_invoke, "get_model_access_credentials")
    if not isinstance(raw, dict):
        raise MonaManagedMediaError("Mona AI 登录凭据无效")
    token = raw.get("access_token")
    api_base = raw.get("api_base")
    if not isinstance(token, str) or not token:
        raise MonaManagedMediaError("请登录 Mona AI 后再使用托管媒体模型")
    if not isinstance(api_base, str) or not api_base.startswith("https://"):
        raise MonaManagedMediaError("Mona AI 媒体服务地址无效")
    return ManagedMediaCredentials(access_token=token, api_base=api_base.rstrip("/"))


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        detail = payload.get("detail")
        error = payload.get("error")
        if isinstance(detail, str) and detail:
            return detail
        if isinstance(error, dict):
            message = error.get("message") or error.get("detail")
            if isinstance(message, str) and message:
                return message
        if isinstance(error, str) and error:
            return error
    if response.status_code == 402:
        return "模型余额不足，请充值后重试"
    return f"Mona AI 媒体服务请求失败（{response.status_code}）"


def _response_error(response: httpx.Response) -> MonaManagedMediaError:
    code = "insufficient_credits" if response.status_code == 402 else None
    return MonaManagedMediaError(_error_detail(response), code=code)


def _unknown_result(reason: str = "invalid response") -> MonaManagedMediaError:
    logger.warning("Managed media result is unknown: {}", reason)
    return MonaManagedMediaError("媒体任务结果暂时无法确认，请先检查结果再决定是否重新发起。", code="result_unknown")


def _generation_payload(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise _unknown_result() from exc
    if not isinstance(payload, dict):
        raise _unknown_result()
    return payload


class MonaManagedMediaClient:
    def __init__(
        self,
        *,
        poll_interval: float = 5.0,
        poll_timeout: float | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self._client = client
        self._last_credentials: ManagedMediaCredentials | None = None

    async def generate(self, body: dict[str, Any]) -> dict[str, Any]:
        request_id = uuid.uuid4().hex
        credentials = await managed_media_credentials()
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=30, follow_redirects=False)
        try:
            payload, credentials = await self._create(
                client,
                credentials=credentials,
                request_id=request_id,
                body=body,
            )
            if payload.get("status") in {"succeeded", "failed"}:
                self._last_credentials = credentials
                return self._require_success(payload)
            deadline = time.monotonic() + self.poll_timeout if self.poll_timeout is not None else None
            while deadline is None or time.monotonic() < deadline:
                await asyncio.sleep(self.poll_interval)
                response = await client.get(
                    f"{credentials.api_base}/media/generations/{request_id}",
                    headers={"Authorization": f"Bearer {credentials.access_token}"},
                )
                if response.status_code == 401:
                    try:
                        credentials = await managed_media_credentials()
                    except MonaManagedMediaError as exc:
                        raise _unknown_result("poll authorization refresh failed") from exc
                    continue
                if response.status_code >= 400:
                    raise _response_error(response) if response.status_code == 402 else _unknown_result(f"poll HTTP {response.status_code}")
                payload = _generation_payload(response)
                if payload.get("status") in {"pending", "running", "uncertain"}:
                    continue
                self._last_credentials = credentials
                return self._require_success(payload)
            raise _unknown_result("poll timeout")
        except httpx.RequestError as exc:
            raise _unknown_result(f"transport {type(exc).__name__}") from exc
        finally:
            if owns_client:
                await client.aclose()

    async def download_asset(self, asset_url: str) -> tuple[bytes, str]:
        credentials = self._last_credentials or await managed_media_credentials()
        url = urljoin(f"{credentials.api_base}/", asset_url)
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=300, follow_redirects=False)
        try:
            for attempt in range(2):
                response = await client.get(
                    url,
                    headers={"Authorization": f"Bearer {credentials.access_token}"},
                )
                if response.status_code != 401 or attempt == 1:
                    if response.status_code >= 400:
                        raise _response_error(response)
                    return response.content, response.headers.get(
                        "content-type", "application/octet-stream"
                    ).split(";", 1)[0]
                credentials = await managed_media_credentials()
                self._last_credentials = credentials
            raise MonaManagedMediaError("Mona AI 登录状态已失效")
        except httpx.RequestError as exc:
            raise MonaManagedMediaError("无法下载 Mona AI 生成结果") from exc
        finally:
            if owns_client:
                await client.aclose()

    async def _create(
        self,
        client: httpx.AsyncClient,
        *,
        credentials: ManagedMediaCredentials,
        request_id: str,
        body: dict[str, Any],
    ) -> tuple[dict[str, Any], ManagedMediaCredentials]:
        for attempt in range(2):
            response = await client.post(
                f"{credentials.api_base}/media/generations",
                headers={
                    "Authorization": f"Bearer {credentials.access_token}",
                    "X-Request-ID": request_id,
                    "Content-Type": "application/json",
                },
                json=body,
            )
            if response.status_code != 401 or attempt == 1:
                if response.status_code >= 400:
                    if response.status_code >= 500:
                        raise _unknown_result(f"submit HTTP {response.status_code}")
                    raise _response_error(response)
                return _generation_payload(response), credentials
            credentials = await managed_media_credentials()
        raise MonaManagedMediaError("Mona AI 登录状态已失效")

    @staticmethod
    def _require_success(payload: dict[str, Any]) -> dict[str, Any]:
        status = payload.get("status")
        if status == "succeeded" and isinstance(payload.get("result"), dict):
            return payload
        if status != "failed":
            raise _unknown_result()
        code = payload.get("error_code")
        raise MonaManagedMediaError(f"媒体生成失败{f'：{code}' if code else ''}")
