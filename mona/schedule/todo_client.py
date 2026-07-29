"""HTTP client for the TodoService hosted by the services process.

Mirrors the subset of TodoService's async API consumed by the gateway's
agent tools (added in phase 2). Phase 1 only needs list/add/update/remove
so the agent can manage todos via tools.
"""

from __future__ import annotations

from typing import Any

import httpx
from loguru import logger

from mona.schedule.todo_types import TodoItem

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class TodoServiceUnavailableError(RuntimeError):
    """Raised when the services process cannot be reached."""


class TodoServiceClient:
    """Drop-in async client mirroring TodoService's public CRUD API."""

    def __init__(self, base_url: str) -> None:
        self._base = base_url.rstrip("/")

    @classmethod
    def from_port(cls, port: int) -> "TodoServiceClient":
        return cls(f"http://127.0.0.1:{port}")

    async def _request(
        self, method: str, path: str, *, json_body: Any | None = None
    ) -> tuple[int, Any]:
        url = f"{self._base}{path}"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.request(method, url, json=json_body)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.warning("TodoServiceClient: services unreachable: {}", exc)
            raise TodoServiceUnavailableError(
                "待办服务不可用（services 进程未启动）。请稍后重试。"
            ) from exc
        except httpx.HTTPError as exc:
            raise TodoServiceUnavailableError(f"待办服务请求失败: {exc}") from exc
        try:
            payload = resp.json()
        except Exception:
            payload = None
        return resp.status_code, payload

    async def list_items(
        self,
        *,
        state: str | None = None,
        bucket: str | None = None,
        source_type: str | None = None,
    ) -> list[TodoItem]:
        params = []
        if state is not None:
            params.append(f"state={state}")
        if bucket is not None:
            params.append(f"bucket={bucket}")
        if source_type is not None:
            params.append(f"sourceType={source_type}")
        query = "?" + "&".join(params) if params else ""
        status, payload = await self._request("GET", f"/api/schedule/todos{query}")
        if status >= 400 or not isinstance(payload, dict):
            raise TodoServiceUnavailableError(f"列出待办失败: HTTP {status}")
        return [TodoItem.from_dict(raw) for raw in payload.get("items", [])]

    async def get_item(self, item_id: str) -> TodoItem | None:
        status, payload = await self._request("GET", f"/api/schedule/todos/{item_id}")
        if status == 404:
            return None
        if status >= 400 or not isinstance(payload, dict):
            raise TodoServiceUnavailableError(f"查询待办失败: HTTP {status}")
        return TodoItem.from_dict(payload)

    async def add_item(self, item: TodoItem) -> TodoItem:
        status, payload = await self._request(
            "POST", "/api/schedule/todos", json_body=item.to_dict()
        )
        if status >= 400 or not isinstance(payload, dict):
            raise TodoServiceUnavailableError(
                f"创建待办失败: {(payload or {}).get('error') or status}"
            )
        return TodoItem.from_dict(payload)

    async def update_item(self, item_id: str, patch: dict[str, Any]) -> TodoItem:
        status, payload = await self._request(
            "POST", f"/api/schedule/todos/{item_id}/update", json_body=patch
        )
        if status >= 400 or not isinstance(payload, dict):
            raise TodoServiceUnavailableError(
                f"更新待办失败: {(payload or {}).get('error') or status}"
            )
        return TodoItem.from_dict(payload)

    async def remove_item(self, item_id: str) -> bool:
        status, _ = await self._request("POST", f"/api/schedule/todos/{item_id}/remove")
        return status == 200

    async def get_briefing(self) -> dict[str, Any]:
        status, payload = await self._request("GET", "/api/schedule/briefing")
        if status >= 400 or not isinstance(payload, dict):
            raise TodoServiceUnavailableError(f"获取早报失败: HTTP {status}")
        return payload
