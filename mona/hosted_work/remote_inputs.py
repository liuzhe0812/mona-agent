"""Deliver the shared Runner's steering callback over the run-bound channel."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import re
from uuid import uuid4

from mona.agent.runner import _MAX_INJECTIONS_PER_TURN
from mona.agent.tools.capabilities import activate_capabilities, activate_capabilities_for_media
from mona.hosted_work.question_tool import RunRPC
from mona.hosted_work.steering_attachments import (
    build_image_content,
    sandbox_target,
    validate_descriptors,
    validate_metadata,
)

_INPUT_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


class RemoteInputs(RunRPC):
    def __init__(self, config, payload, emit, *, sandbox=None, runtime=None):
        super().__init__(config, payload, sandbox, emit, [])
        self.runtime = runtime
        self._request_id = None
        self._lock = asyncio.Lock()
        self._stopped = False

    async def poll(self, *, limit=3, phase=""):
        async with self._lock:
            if self._stopped:
                raise asyncio.CancelledError("追加消息状态无法确认，本轮已停止。")
            try:
                return await self._poll(limit)
            except asyncio.CancelledError:
                self._stopped = True
                raise
            except Exception:
                self._stopped = True
                await self._stop("追加消息状态无法确认，本轮已停止并保留进度。")

    async def _poll(self, limit):
        if type(limit) is not int or limit < 1:
            await self._stop("追加消息参数无法确认，本轮已停止并保留进度。")
        limit = min(limit, _MAX_INJECTIONS_PER_TURN)
        # Keep the ID across transport retries. The parent will offer exactly
        # the same batch until its acknowledgement has been confirmed.
        self._request_id = self._request_id or uuid4().hex
        value = await self._post("input_poll", {"request_id": self._request_id, "limit": limit})
        items = value.get("inputs")
        if (value.get("request_id") != self._request_id or not isinstance(items, list)
                or len(items) > limit or any(not isinstance(item, dict)
                or not {"input_id", "content"} <= set(item) or set(item) - {"input_id", "content", "attachments", "metadata"}
                or not isinstance(item["input_id"], str)
                or not _INPUT_ID.fullmatch(item["input_id"])
                or not isinstance(item["content"], str) or not item["content"].strip() and not item.get("attachments")
                or len(item["content"]) > 50000 for item in items)
                or len({item["input_id"] for item in items}) != len(items)):
            await self._stop("追加消息回执无法确认，本轮已停止并保留进度。")
        try:
            for item in items:
                item["content"].encode("utf-8")
        except UnicodeError:
            await self._stop("追加消息回执无法确认，本轮已停止并保留进度。")
        projected = [await self._project(item) for item in items]
        if items:
            response = await self._post("input_ack", {"request_id": self._request_id})
            states = response.get("states")
            if (not isinstance(states, list) or len(states) != len(items)
                    or any(not isinstance(state, dict) or state.get("state") != "consumed"
                           or not isinstance(state.get("input_id"), str)
                           or state.get("chat_id") != self.session_id or state.get("turn_id") != self.run_id
                           for state in states)
                    or {state["input_id"] for state in states} != {item["input_id"] for item in items}):
                await self._stop("追加消息状态无法确认，本轮已停止并保留进度。")
        for item in items:
            activate_capabilities_for_media([attachment["target_path"] for attachment in item.get("attachments", [])])
            if item.get("metadata", {}).get("office_session_id"):
                activate_capabilities({"office"})
        self._request_id = None
        return projected

    async def _project(self, item):
        metadata = validate_metadata(item.get("metadata"))
        supplied = item.get("attachments", [])
        if not isinstance(supplied, list) or len(supplied) > 8:
            await self._stop("追加附件无法确认，本轮已停止并保留进度。")
        if (supplied or metadata) and (self.sandbox is None or self.runtime is None):
            await self._stop("追加附件或消息上下文不可用，本轮已停止并保留进度。")
        descriptors, verified = [], []
        for value in supplied:
            if not isinstance(value, dict) or set(value) != {"path", "name", "size", "sha256", "target_path", "data"}:
                await self._stop("追加附件无法确认，本轮已停止并保留进度。")
            descriptor = {key: value[key] for key in ("path", "name", "size", "sha256")}
            validate_descriptors([descriptor])
            target, data = value["target_path"], value["data"]
            if (target != sandbox_target(self.session_id, item["input_id"], descriptor)
                    or not isinstance(data, str) or len(data) > 4 * ((self.config.max_file_bytes + 2) // 3)):
                await self._stop("追加附件无法确认，本轮已停止并保留进度。")
            try:
                raw = base64.b64decode(data, validate=True)
            except (ValueError, binascii.Error):
                await self._stop("追加附件无法确认，本轮已停止并保留进度。")
            if (len(raw) != descriptor["size"] or len(raw) > self.config.max_file_bytes
                    or hashlib.sha256(raw).hexdigest() != descriptor["sha256"]):
                await self._stop("追加附件已变化，本轮已停止并保留进度。")
            descriptors.append(descriptor)
            verified.append({"path": target, "data": raw, "encoded": data, "descriptor": descriptor})
        validate_descriptors(descriptors)
        for entry in verified:
            result = await self.sandbox.file({"action": "upload", "path": entry["path"], "data": entry["encoded"]})
            descriptor = entry["descriptor"]
            if (not isinstance(result, dict) or result.get("path") != entry["path"]
                    or result.get("name") != descriptor["name"] or result.get("size") != descriptor["size"]
                    or result.get("sha256") != descriptor["sha256"]):
                await self._stop("追加附件保存状态无法确认，本轮已停止并保留进度。")
        content = item["content"]
        if self.runtime is not None:
            projected_metadata = {key: metadata[key] for key in ("ui_theme", "office_session_id",
                                  "office_document_type", "office_display_name") if key in metadata}
            projected_metadata["_attachment_paths"] = [entry["path"] for entry in verified]
            message = self.runtime.builder.build_messages([], content, channel="websocket", chat_id=self.session_id,
                session_metadata=self.runtime.session.metadata, message_metadata=projected_metadata)[-1]
            content = build_image_content(message["content"], verified)
            self.runtime.register_injection_projection(item["input_id"], item["content"], content)
        return {"role": "user", "content": content, "id": item["input_id"], "source_kind": "steering"}
