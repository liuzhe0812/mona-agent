"""Gateway client for the Services-owned Office API."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

import httpx

from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import (
    OFFICE_OWNER_HEADER,
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCommandResult,
    OfficeDocumentType,
    OfficeInspectRequest,
    OfficeInspectResponse,
    OfficeSaveRequest,
    OfficeSessionCreateRequest,
    OfficeSessionState,
)

_TIMEOUT = httpx.Timeout(35.0, connect=5.0)


class OfficeServiceClient:
    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token or get_services_token()
        self._transport = transport

    @classmethod
    def from_port(cls, port: int) -> OfficeServiceClient:
        return cls(f"http://127.0.0.1:{port}")

    async def open(
        self,
        *,
        owner_session_key: str,
        path: str | Path | None = None,
        document_type: OfficeDocumentType | None = None,
        display_name: str | None = None,
    ) -> OfficeSessionState:
        body = OfficeSessionCreateRequest(
            owner_session_key=owner_session_key,
            path=str(path) if path is not None else None,
            type=document_type,
            display_name=display_name,
        )
        payload = await self._request(
            "POST",
            "/api/office/sessions",
            owner_session_key=owner_session_key,
            json_body=body.model_dump(by_alias=True, mode="json"),
        )
        return OfficeSessionState.model_validate(payload)

    async def get(self, session_id: str, *, owner_session_key: str) -> OfficeSessionState:
        payload = await self._request(
            "GET",
            f"/api/office/sessions/{session_id}",
            owner_session_key=owner_session_key,
        )
        return OfficeSessionState.model_validate(payload)

    async def list(self, *, owner_session_key: str) -> list[OfficeSessionState]:
        payload = await self._request(
            "GET",
            "/api/office/sessions",
            owner_session_key=owner_session_key,
        )
        return [OfficeSessionState.model_validate(item) for item in payload["sessions"]]

    async def inspect(
        self,
        request: OfficeInspectRequest,
        *,
        owner_session_key: str,
    ) -> OfficeInspectResponse:
        payload = await self._request(
            "POST",
            f"/api/office/sessions/{request.session_id}/inspect",
            owner_session_key=owner_session_key,
            json_body=request.model_dump(by_alias=True, mode="json"),
            accepted_statuses={200, 409},
        )
        from pydantic import TypeAdapter

        return TypeAdapter(OfficeInspectResponse).validate_python(payload)

    async def apply(
        self,
        command: OfficeApplyCommand,
        *,
        owner_session_key: str,
    ) -> OfficeCommandResult:
        payload = await self._request(
            "POST",
            f"/api/office/sessions/{command.session_id}/apply",
            owner_session_key=owner_session_key,
            json_body=command.model_dump(by_alias=True, mode="json", exclude_unset=True),
            accepted_statuses={200, 409},
        )
        from pydantic import TypeAdapter

        return TypeAdapter(OfficeCommandResult).validate_python(payload)

    async def save(
        self,
        session_id: str,
        *,
        owner_session_key: str,
        overwrite_source: bool = False,
        version: DocumentVersion | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = OfficeSaveRequest(overwrite_source=overwrite_source, version=version)
        return await self._request(
            "POST",
            f"/api/office/sessions/{session_id}/save",
            owner_session_key=owner_session_key,
            json_body=body.model_dump(by_alias=True, mode="json"),
        )

    async def export(
        self,
        session_id: str,
        *,
        owner_session_key: str,
        output: str | Path,
        version: DocumentVersion | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        saved = await self.save(
            session_id,
            owner_session_key=owner_session_key,
            version=version,
        )
        contents = await self.download_file(
            session_id,
            owner_session_key=owner_session_key,
        )
        destination = Path(output).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return {
            "ok": True,
            "fileName": destination.name,
            "version": saved["version"],
        }

    async def download_file(
        self,
        session_id: str,
        *,
        owner_session_key: str,
    ) -> bytes:
        headers = {
            SERVICES_TOKEN_HEADER: self._token,
            OFFICE_OWNER_HEADER: owner_session_key,
        }
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT,
                transport=self._transport,
                trust_env=False,
            ) as client:
                response = await client.get(
                    f"{self._base_url}/api/office/sessions/{session_id}/file",
                    headers=headers,
                )
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 服务不可用，请稍后重试。",
                retryable=True,
            ) from exc
        if response.status_code != 200:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            try:
                code = OfficeErrorCode(error.get("code"))
            except ValueError:
                code = OfficeErrorCode.EDITOR_UNAVAILABLE
            raise OfficeError(
                code,
                str(error.get("message") or f"Office 文件读取失败：HTTP {response.status_code}"),
                retryable=bool(error.get("retryable", False)),
            )
        return response.content

    async def close(self, session_id: str, *, owner_session_key: str) -> None:
        await self._request(
            "DELETE",
            f"/api/office/sessions/{session_id}",
            owner_session_key=owner_session_key,
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        owner_session_key: str,
        json_body: dict[str, Any] | None = None,
        accepted_statuses: set[int] | None = None,
    ) -> Any:
        headers = {
            SERVICES_TOKEN_HEADER: self._token,
            OFFICE_OWNER_HEADER: owner_session_key,
        }
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT,
                transport=self._transport,
                trust_env=False,
            ) as client:
                response = await client.request(
                    method,
                    f"{self._base_url}{path}",
                    headers=headers,
                    json=json_body,
                )
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 服务不可用，请稍后重试。",
                retryable=True,
            ) from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 服务返回了无效响应。",
                retryable=True,
            ) from exc
        allowed = accepted_statuses or {200, 201}
        if response.status_code not in allowed:
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            try:
                code = OfficeErrorCode(error.get("code"))
            except ValueError:
                code = OfficeErrorCode.EDITOR_UNAVAILABLE
            raise OfficeError(
                code,
                str(error.get("message") or f"Office 服务请求失败：HTTP {response.status_code}"),
                retryable=bool(error.get("retryable", False)),
            )
        return payload
