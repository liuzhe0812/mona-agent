"""Local confirmation for old-history cleanup; no cloud receipts exposed to React."""
from __future__ import annotations

import asyncio
import copy
import time
import uuid

from mona.cloud.transfer import CloudTransferError


class HistoryRetention:
    def __init__(self, coordinator):
        self.owner = coordinator
        self.draft = None

    async def preview(self):
        async with self.owner.lock:
            self.draft = None
            context = await self.owner._context()
            self.owner._cloud_ready(context)
            data = await asyncio.to_thread(self.owner.transport_factory(context["binding"]).control, "GET", "/retention")
            if (await self.owner._context())["binding"] != context["binding"]:
                raise CloudTransferError("account_changed", "账号已变化，请重新检查历史版本。")
            if (not isinstance(data, dict) or type(data.get("count")) is not int or not 0 <= data["count"] <= 50
                    or type(data.get("retention_days")) is not int or not 1 <= data["retention_days"] <= 3650
                    or type(data.get("has_more")) is not bool or data["has_more"] and data["count"] != 50
                    or type(data.get("expires_at")) is not int or not time.time() < data["expires_at"] <= time.time() + 610
                    or type(data.get("referenced_bytes")) is not int or not 0 <= data["referenced_bytes"] <= 10_000_000_000_000
                    or data["count"] and (not isinstance(data.get("receipt"), str) or not 20 <= len(data["receipt"]) <= 32_768)):
                raise CloudTransferError("retention_invalid", "历史检查结果无效，未清理任何内容。")
            public = {key: data[key] for key in ("count", "retention_days", "has_more", "expires_at")}
            public["draft_id"] = uuid.uuid4().hex if data["count"] else None
            if data["count"]:
                self.draft = {"id": public["draft_id"], "binding": context["binding"], "receipt": data["receipt"],
                    "expires": time.monotonic() + min(600, data["expires_at"] - time.time()),
                    "count": data["count"], "result": None}
            return public

    async def apply(self, draft_id, confirmed):
        if confirmed is not True:
            raise CloudTransferError("retention_confirmation_required", "请确认清理过期历史版本。")
        async with self.owner.lock:
            draft = self.draft
            if not draft or draft["id"] != draft_id or draft["expires"] <= time.monotonic():
                raise CloudTransferError("retention_preview_expired", "历史清理确认已失效，请重新检查。")
            context = await self.owner._context()
            self.owner._cloud_ready(context)
            if context["binding"] != draft["binding"]:
                self.draft = None
                raise CloudTransferError("account_changed", "账号已变化，未使用之前的历史清理确认。")
            if draft["result"] is not None:
                return copy.deepcopy(draft["result"])
            result = await asyncio.to_thread(self.owner.transport_factory(context["binding"]).control,
                "POST", "/retention", {"receipt": draft["receipt"], "confirmed": True})
            if (await self.owner._context())["binding"] != context["binding"]:
                self.draft = None
                raise CloudTransferError("account_changed", "账号已变化，请切回原账号核对清理结果。")
            counts = ("retired", "already_retired", "retained")
            if (not isinstance(result, dict) or result.get("complete") is not True
                    or any(type(result.get(key)) is not int or not 0 <= result[key] <= draft["count"] for key in counts)
                    or sum(result[key] for key in counts) != draft["count"]
                    or type(result.get("released_bytes")) is not int or result["released_bytes"] != 0):
                raise CloudTransferError("retention_unconfirmed", "历史清理结果尚未确认，请重试核对。")
            public = {key: result[key] for key in (*counts, "complete", "released_bytes")}
            draft["result"] = copy.deepcopy(public)
            return public
