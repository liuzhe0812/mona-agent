"""HTTP client for the ScheduleService hosted by the services process.

Implements the subset of the ``ScheduleService`` async interface consumed by
``mona.agent.tools.schedule.ScheduleTool`` so the gateway's agent can manage
schedule items without sharing a process with the service. See
docs/architecture/services-split-design.md §3.3.
"""

from __future__ import annotations

from typing import Any

import httpx
from loguru import logger

from mona.schedule.types import ScheduleItem

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class ScheduleServiceUnavailableError(RuntimeError):
    """Raised when the services process cannot be reached."""


class ScheduleServiceClient:
    """Drop-in async client mirroring ScheduleService's public CRUD API."""

    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    @classmethod
    def from_port(cls, port: int) -> "ScheduleServiceClient":
        return cls(f"http://127.0.0.1:{port}")

    async def _request(
        self, method: str, path: str, *, json_body: Any | None = None
    ) -> tuple[int, Any]:
        url = f"{self._base}{path}"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.request(method, url, json=json_body)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.warning("ScheduleServiceClient: services unreachable: {}", exc)
            raise ScheduleServiceUnavailableError(
                "日程服务不可用（services 进程未启动）。请稍后重试。"
            ) from exc
        except httpx.HTTPError as exc:
            raise ScheduleServiceUnavailableError(f"日程服务请求失败: {exc}") from exc
        try:
            payload = resp.json()
        except Exception:
            payload = None
        return resp.status_code, payload

    async def add_item(self, item: ScheduleItem) -> ScheduleItem:
        status, payload = await self._request(
            "POST", "/api/schedule/items", json_body=item.to_dict()
        )
        if status >= 400 or not isinstance(payload, dict):
            raise ScheduleServiceUnavailableError(
                f"创建日程失败: {(payload or {}).get('error') or status}"
            )
        return ScheduleItem.from_dict(payload)

    async def get_item(self, item_id: str) -> ScheduleItem | None:
        status, payload = await self._request("GET", f"/api/schedule/items/{item_id}")
        if status == 404:
            return None
        if status >= 400 or not isinstance(payload, dict):
            raise ScheduleServiceUnavailableError(f"查询日程失败: HTTP {status}")
        return ScheduleItem.from_dict(payload)

    async def list_items(
        self, from_ms: int | None = None, to_ms: int | None = None
    ) -> list[ScheduleItem]:
        query = ""
        params = []
        if from_ms is not None:
            params.append(f"from={from_ms}")
        if to_ms is not None:
            params.append(f"to={to_ms}")
        if params:
            query = "?" + "&".join(params)
        status, payload = await self._request("GET", f"/api/schedule/items{query}")
        if status >= 400 or not isinstance(payload, dict):
            raise ScheduleServiceUnavailableError(f"列出日程失败: HTTP {status}")
        return [ScheduleItem.from_dict(raw) for raw in payload.get("items", [])]

    async def update_item(self, item: ScheduleItem) -> ScheduleItem:
        status, payload = await self._request(
            "POST",
            f"/api/schedule/items/{item.id}/update",
            json_body=item.to_dict(),
        )
        if status >= 400 or not isinstance(payload, dict):
            raise ScheduleServiceUnavailableError(
                f"更新日程失败: {(payload or {}).get('error') or status}"
            )
        return ScheduleItem.from_dict(payload)

    async def remove_item(self, item_id: str) -> bool:
        status, _ = await self._request(
            "POST", f"/api/schedule/items/{item_id}/remove"
        )
        return status == 200

    async def push_notification(
        self,
        title: str,
        body: str,
        *,
        click_action: str | None = None,
        click_data: dict[str, Any] | None = None,
    ) -> None:
        """Enqueue a system notification on the services process.

        The Tauri side pops it via ``GET /api/schedule/notifications`` and
        fires a native notification window (stock-module T20).
        """
        payload: dict[str, Any] = {"title": title, "body": body}
        if click_action:
            payload["click_action"] = click_action
        if click_data is not None:
            payload["click_data"] = click_data
        status, resp = await self._request(
            "POST", "/api/schedule/notifications/push", json_body=payload
        )
        if status >= 400:
            raise ScheduleServiceUnavailableError(
                f"推送通知失败: {(resp or {}).get('error') or status}"
            )
