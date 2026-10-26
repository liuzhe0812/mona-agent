"""Thin, non-retrying native client with durable submission receipts."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from pathlib import PurePosixPath
from typing import Any

import httpx

from mona.services.stock_vibe.requests import RequestStore
from mona.services.stock_vibe.runtime import StockVibeRuntime, StockVibeUnavailableError

_OBJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_MAX_RESPONSE_BYTES = 16 * 1024 * 1024


class NativeProtocolError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def object_id(value: str) -> str:
    if not _OBJECT_ID.fullmatch(value):
        raise ValueError("对象标识无效")
    return value


async def native_json(client: httpx.AsyncClient, method: str, path: str, **kwargs) -> tuple[int, Any]:
    async with client.stream(method, path, **kwargs) as response:
        chunks = bytearray()
        async for chunk in response.aiter_bytes():
            chunks.extend(chunk)
            if len(chunks) > _MAX_RESPONSE_BYTES:
                raise NativeProtocolError("原生响应超出大小限制")
        try:
            return response.status_code, json.loads(chunks) if chunks else None
        except (ValueError, UnicodeDecodeError) as exc:
            raise NativeProtocolError("原生响应格式无效") from exc


class StockVibeClient:
    def __init__(self, runtime: StockVibeRuntime, requests: RequestStore) -> None:
        self.runtime = runtime
        self.requests = requests

    def _references(self, path: str, body: Any) -> list[tuple[str, str]]:
        path = path.partition("?")[0]
        if not isinstance(body, dict):
            return []
        if path == "/sessions" and body.get("session_id"):
            return [("session", object_id(body["session_id"]))]
        if path.startswith("/sessions/") and path.endswith("/messages") and body.get("attempt_id"):
            return [("attempt", object_id(body["attempt_id"]))]
        if (path == "/swarm/runs" or path.endswith("/retry") and path.startswith("/swarm/runs/")) and body.get("id"):
            return [("swarm", object_id(body["id"]))]
        if path == "/upload" and body.get("file_path"):
            uploaded = PurePosixPath(body["file_path"])
            resolved = (self.runtime.data_root / str(uploaded)).resolve()
            if (len(uploaded.parts) != 2 or uploaded.parts[0] != "uploads"
                or not re.fullmatch(r"[a-f0-9]{32}", uploaded.stem)
                or not resolved.is_relative_to((self.runtime.data_root / "uploads").resolve())):
                raise NativeProtocolError("附件来源无效")
            return [("upload", uploaded.stem)]
        if path == "/mona/operations" and body.get("operation_id"):
            return [("operation", object_id(body["operation_id"]))]
        return []

    def _finish(self, request_id: str, record: dict, source: dict) -> dict:
        receipt = record.get("receipt")
        status = record.get("status")
        if status not in {"completed", "rejected"} or not isinstance(receipt, dict):
            return self._unknown(request_id, "native_unconfirmed")
        code = receipt.get("status_code")
        if (not isinstance(code, int) or isinstance(code, bool)
            or status == "completed" and not 200 <= code < 300
            or status == "rejected" and not 400 <= code < 500):
            return self._unknown(request_id, "invalid_native_receipt")
        result = self.requests.complete(request_id, status=status, receipt=receipt, source=source)
        self._record_references(result)
        return result

    def _record_references(self, record: dict) -> None:
        if record["status"] == "completed":
            for kind, value in self._references(record["path"], record["receipt"].get("body")):
                self.requests.record_reference(kind, value, record["request_id"], record["source"])

    def _unknown(self, request_id: str, category: str) -> dict:
        record = self.requests.get(request_id)
        if record and record["status"] in {"completed", "rejected"}:
            self._record_references(record)
            return record
        return self.requests.mark_unknown(request_id, category)

    async def submit(self, request_id: str, method: str, path: str, payload: dict | None = None,
                     *, params: dict | None = None, upload: tuple[str, bytes] | None = None) -> dict:
        fingerprint = {"body": payload, "query": params}
        if upload is not None:
            fingerprint["upload"] = {"filename": upload[0], "sha256": hashlib.sha256(upload[1]).hexdigest()}
        record, claimed = self.requests.claim(request_id, method, path, fingerprint)
        if not claimed:
            return await self.request(record["request_id"])
        request_id = record["request_id"]
        source = None
        dispatched = False
        try:
            async with self.runtime.lease() as client:
                source = self.runtime.source_identity()
                # Bind before dispatch so a lost receipt can be reconciled after restart.
                self.requests.bind_source(request_id, source)
                kwargs = {"files": {"file": upload}} if upload is not None else {"json": payload}
                dispatched = True
                await native_json(client, method, path, params=params,
                                  headers={"X-Mona-Request-ID": request_id}, **kwargs)
                code, native = await native_json(client, "GET", f"/mona/requests/{request_id}")
                if code == 200 and isinstance(native, dict) and native.get("request_id") == request_id:
                    return self._finish(request_id, native, source)
        except asyncio.CancelledError:
            self._unknown(request_id, "host_interrupted")
            raise
        except (httpx.HTTPError, NativeProtocolError, StockVibeUnavailableError):
            # A transport error may follow a committed native write. Never resend it.
            if not dispatched and source is None:
                return self.requests.reject_before_dispatch(request_id)
        return self._unknown(request_id, "receipt_unconfirmed")

    async def request(self, request_id: str) -> dict:
        record = self.requests.get(request_id)
        if record is None:
            raise KeyError(request_id)
        if record["status"] in {"completed", "rejected"} or not record.get("source"):
            self._record_references(record)
            return record
        try:
            async with self.runtime.lease() as client:
                current = self.runtime.source_identity()
                if current["data_root_sha256"] != record["source"]["data_root_sha256"]:
                    return record
                code, native = await native_json(client, "GET", f"/mona/requests/{record['request_id']}")
                if code == 200 and isinstance(native, dict) and native.get("request_id") == record["request_id"]:
                    # Keep the original dispatch source, even after a runtime upgrade.
                    return self._finish(record["request_id"], native, record["source"])
        except (httpx.HTTPError, NativeProtocolError, StockVibeUnavailableError):
            pass
        return record

    async def read(self, path: str, *, kind: str | None = None, value: str | None = None,
                   params: dict | None = None) -> dict:
        async with self.runtime.lease() as client:
            code, native = await native_json(client, "GET", path, params=params)
        if code >= 400:
            raise NativeProtocolError(f"原生读取失败（{code}）", status_code=code)
        return {"native": native,
                "source": self.requests.reference(kind, value) if kind and value else None}
