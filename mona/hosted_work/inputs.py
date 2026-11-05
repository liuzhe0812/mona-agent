"""Durable, account-scoped steering for an already running hosted Work turn."""
from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from mona.agent.runner import _MAX_INJECTIONS_PER_TURN
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.desktop_store import DesktopStore, chat_id
from mona.hosted_work.steering_attachments import validate_descriptors, validate_metadata
from mona.hosted_work.store import encoded
from mona.session.work_turns import WorkTurnBlockedError

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_INPUT = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_KEY = "work_inputs:"
Emit = Callable[[str, str, dict], Awaitable[None]]


@dataclass
class _Owner:
    bus: MessageBus = field(default_factory=MessageBus)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    by_run: dict[str, str] = field(default_factory=dict)
    by_turn: dict[str, str] = field(default_factory=dict)
    queued: set[tuple[str, str, str]] = field(default_factory=set)


class HostedInputs:
    """One instance per service; one desktop controller and queue per account.

    Input text is durable before it enters the bus. A poll reserves a bounded
    batch under a caller-stable request ID; only an explicit acknowledgement
    consumes it. A lost response can be retried without making another batch.
    """

    def __init__(self, state: DesktopStore, *, emit: Emit | None = None):
        self.state, self.emit = state, emit
        self._owners: dict[str, _Owner] = {}

    def _owner(self, owner: str) -> _Owner:
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("invalid_identity", "登录身份无效，请重新登录。", 401)
        return self._owners.setdefault(owner, _Owner())

    @staticmethod
    def _input_id(value: str) -> str:
        if not isinstance(value, str) or not _INPUT.fullmatch(value):
            raise WorkError("invalid_request", "输入标识无效。")
        return value

    @staticmethod
    def _session_id(value: str) -> str:
        if not isinstance(value, str):
            raise WorkError("invalid_request", "会话标识无效。")
        return chat_id(value)

    @staticmethod
    def _text(value: str, *, has_attachments: bool = False) -> str:
        if not isinstance(value, str) or not value.strip() and not has_attachments or len(value) > 50000:
            raise WorkError("invalid_request", "追加内容不能为空或超过长度限制。")
        try:
            value.encode("utf-8")
        except UnicodeError as exc:
            raise WorkError("invalid_request", "追加内容格式无效。") from exc
        return value

    def _load(self, owner: str, sid: str) -> dict:
        self.state.session(owner, sid)
        value = self.state.get(owner, _KEY + sid, {"version": 1, "inputs": {}, "batches": {}, "blocked": {}})
        if (not isinstance(value, dict) or value.get("version") != 1
                or not all(isinstance(value.get(key), dict) for key in ("inputs", "batches", "blocked"))):
            raise WorkError("invalid_state", "待处理输入记录不可用，请联系管理员。", 503)
        return value

    def _save(self, owner: str, sid: str, data: dict, *, new_input: dict | None = None) -> None:
        try:
            if len(encoded(data).encode("utf-8")) > self.state.service.config.max_history_bytes:
                raise WorkError("history_limit", "待处理输入超过会话容量，请先处理已有内容。", 409)
        except UnicodeError as exc:
            raise WorkError("invalid_request", "追加内容格式无效。") from exc
        if new_input is not None:
            # Existing pre-transcript sessions must be projected before the first
            # new record; otherwise the presence of that record masks history.
            self.state.records(owner, sid)
        db = self.state.db(owner)
        db.execute("BEGIN IMMEDIATE")
        try:
            if new_input is not None:
                record = {"event": "user", "text": new_input["content"],
                          "input_id": new_input["input_id"], "turn_id": new_input["turn_id"]}
                if new_input.get("attachments"):
                    record["media_paths"] = [item["path"] for item in new_input["attachments"]]
                for key in ("task_id", "quote", "display_content"):
                    if new_input.get("metadata", {}).get(key):
                        record[key] = new_input["metadata"][key]
                self.state.append(owner, sid, record, "work-input:" + new_input["input_id"])
            self.state.set(owner, _KEY + sid, data)
            db.commit()
        except BaseException:
            db.rollback()
            raise

    @staticmethod
    def _snapshot(sid: str, item: dict) -> dict:
        return {"chat_id": sid, "input_id": item["input_id"], "turn_id": item["turn_id"], "state": item["state"]}

    @staticmethod
    def _input(item: dict) -> dict:
        result = {"input_id": item["input_id"], "content": item["content"]}
        if item.get("attachments"):
            result["attachments"] = item["attachments"]
        if item.get("metadata"):
            result["metadata"] = item["metadata"]
        return result

    async def _emit(self, owner: str, sid: str, items: list[dict]) -> None:
        if self.emit is not None:
            for item in items:
                await self.emit(owner, sid, {"event": "work_input_state", **self._snapshot(sid, item)})

    @staticmethod
    def _drain_outbound(runtime: _Owner) -> None:
        while not runtime.bus.outbound.empty():
            runtime.bus.outbound.get_nowait()
            runtime.bus.outbound.task_done()

    def _run(self, owner: str, sid: str, rid: str) -> dict:
        run = self.state.service.store.run(owner, identifier(rid))
        if run["session_id"] != sid:
            raise WorkError("not_found", "未找到当前会话中的任务。", 404)
        return run

    def _live_run(self, owner: str, sid: str, rid: str, data: dict) -> dict:
        run = self._run(owner, sid, rid)
        if run["status"] != "running" or rid in data["blocked"]:
            raise WorkError("input_turn_unavailable", "原任务已停止或结果待核对，未开始追加输入。", 409)
        return run

    @staticmethod
    def _message(sid: str, item: dict, turn_id: str) -> InboundMessage:
        return InboundMessage("websocket", "hosted-user", sid, item["content"], metadata={
            "input_id": item["input_id"], "target_turn_id": turn_id, "hosted_run_id": item["turn_id"]})

    async def _publish(self, runtime: _Owner, sid: str, rid: str, item: dict, internal: str) -> bool:
        key = (sid, rid, item["input_id"])
        if key in runtime.queued:
            return True
        task = asyncio.create_task(runtime.bus.publish_inbound(self._message(sid, item, internal)))
        try:
            published = await asyncio.shield(task)
        except asyncio.CancelledError:
            published = await asyncio.shield(task)
            if published:
                runtime.queued.add(key)
            raise
        if published:
            runtime.queued.add(key)
        return published

    async def _hydrate(self, runtime: _Owner, sid: str, rid: str, data: dict, internal: str) -> None:
        controller = runtime.bus.work_turns
        for item in data["inputs"].values():
            if item.get("turn_id") != rid or item.get("state") != "accepted":
                continue
            current = controller.input_state(sid, item["input_id"])
            if current is None or current["state"] == "paused":
                accepted, publish = controller.accept_input(sid, item["input_id"], internal,
                                                            resume=bool(current))
                if not publish or accepted.state != "accepted":
                    raise WorkError("invalid_state", "待处理输入状态无法恢复。", 503)
            elif current["state"] != "accepted" or current.get("turn_id") != internal:
                raise WorkError("invalid_state", "待处理输入状态无法恢复。", 503)
            if item.get("batch_id"):
                controller.confirm_input(sid, item["input_id"])
            elif not await self._publish(runtime, sid, rid, item, internal):
                raise WorkError("invalid_state", "待处理输入状态无法恢复。", 503)
        self._drain_outbound(runtime)

    async def _start(self, runtime: _Owner, owner: str, sid: str, rid: str, data: dict,
                     task: asyncio.Task | None) -> str:
        self._live_run(owner, sid, rid, data)
        controller = runtime.bus.work_turns
        internal = runtime.by_run.get(rid)
        existing = controller.find(sid, internal) if internal else None
        if existing and existing.state == "running":
            await self._hydrate(runtime, sid, rid, data, internal)
            return internal
        active = controller.current(sid)
        if active is not None:
            raise WorkError("input_turn_conflict", "此会话的原任务仍在执行或等待核对。", 409)

        async def no_cleanup():
            return None

        try:
            turn = controller.start("websocket:" + sid, sid, task, no_cleanup)
        except WorkTurnBlockedError as exc:
            raise WorkError("input_turn_conflict", "原任务状态待核对，未开始追加输入。", 409) from exc
        runtime.by_run[rid] = turn.turn_id
        runtime.by_turn[turn.turn_id] = rid
        # Restore only queued messages, never dispatch a new model turn.
        await self._hydrate(runtime, sid, rid, data, turn.turn_id)
        return turn.turn_id

    async def start(self, owner: str, sid: str, rid: str, *, task: asyncio.Task | None = None) -> None:
        runtime = self._owner(owner)
        sid, rid = self._session_id(sid), identifier(rid)
        async with runtime.lock:
            data = self._load(owner, sid)
            await self._reconcile(runtime, owner, sid, data)
            await self._start(runtime, owner, sid, rid, data, task)

    async def enqueue(self, owner: str, sid: str, rid: str, input_id: str, content: str, *,
                      resume: bool = False, attachments=(), metadata=None) -> dict:
        runtime = self._owner(owner)
        sid, rid, input_id = self._session_id(sid), identifier(rid), self._input_id(input_id)
        attachments, metadata = validate_descriptors(attachments), validate_metadata(metadata)
        content = self._text(content, has_attachments=bool(attachments))
        if not isinstance(resume, bool):
            raise WorkError("invalid_request", "恢复标记无效。")
        async with runtime.lock:
            data = self._load(owner, sid)
            await self._reconcile(runtime, owner, sid, data)
            item = data["inputs"].get(input_id)
            if item is not None:
                if (item.get("content") != content or item.get("attachments", []) != attachments
                        or item.get("metadata", {}) != metadata):
                    raise WorkError("input_conflict", "同一输入标识的内容已变化，未重复执行。", 409)
                if item.get("turn_id") == rid and item.get("state") in {"accepted", "consumed"}:
                    if item["state"] == "accepted":
                        await self._start(runtime, owner, sid, rid, data, None)
                    await self._emit(owner, sid, [item])
                    return self._snapshot(sid, item)
                if item.get("state") == "paused" and not resume:
                    if item.get("turn_id") != rid:
                        raise WorkError("input_conflict", "原输入已暂停，请明确确认恢复。", 409)
                    await self._emit(owner, sid, [item])
                    return self._snapshot(sid, item)
                if item.get("state") == "rejected" and item.get("turn_id") == rid:
                    await self._emit(owner, sid, [item])
                    raise WorkError("input_rejected", "原任务无法接收追加输入。", 409)
                if item.get("state") != "paused" or not resume:
                    raise WorkError("input_conflict", "原输入仍有记录，未把它变成新任务。", 409)
            elif resume:
                raise WorkError("input_not_found", "找不到待恢复的原输入。", 404)

            try:
                internal = await self._start(runtime, owner, sid, rid, data, None)
            except WorkError:
                if item is None:
                    rejected = {"input_id": input_id, "turn_id": rid, "content": content,
                                "state": "rejected", "batch_id": None, "attachments": attachments, "metadata": metadata}
                    data["inputs"][input_id] = rejected
                    self._save(owner, sid, data)
                    await self._emit(owner, sid, [rejected])
                raise
            controller = runtime.bus.work_turns
            previous = controller.input_state(sid, input_id)
            use_resume = bool(previous and previous.get("state") == "paused")
            accepted, publish = controller.accept_input(sid, input_id, internal, resume=use_resume)
            if not publish or accepted.state != "accepted":
                self._drain_outbound(runtime)
                if item is None:
                    rejected = {"input_id": input_id, "turn_id": rid, "content": content,
                                "state": "rejected", "batch_id": None, "attachments": attachments, "metadata": metadata}
                    data["inputs"][input_id] = rejected
                    self._save(owner, sid, data)
                    await self._emit(owner, sid, [rejected])
                raise WorkError("input_rejected", "原任务无法接收追加输入。", 409)
            new_item = {"input_id": input_id, "turn_id": rid, "content": content,
                        "state": "accepted", "batch_id": None, "attachments": attachments, "metadata": metadata}
            data["inputs"][input_id] = new_item
            try:
                self._save(owner, sid, data, new_input=new_item if item is None else None)
            except BaseException:
                controller.reject_input(sid, input_id, internal)
                self._drain_outbound(runtime)
                raise
            published = await self._publish(runtime, sid, rid, new_item, internal)
            self._drain_outbound(runtime)
            if not published:
                new_item["state"] = "paused"
                self._save(owner, sid, data)
                await self._emit(owner, sid, [new_item])
                return self._snapshot(sid, new_item)
            await self._emit(owner, sid, [new_item])
            return self._snapshot(sid, new_item)

    async def poll(self, owner: str, sid: str, rid: str, request_id: str, *,
                   limit: int = _MAX_INJECTIONS_PER_TURN) -> dict:
        runtime = self._owner(owner)
        sid, rid, request_id = self._session_id(sid), identifier(rid), self._input_id(request_id)
        if type(limit) is not int or limit < 1:
            raise WorkError("invalid_request", "输入批次大小无效。")
        limit = min(limit, _MAX_INJECTIONS_PER_TURN)
        async with runtime.lock:
            data = self._load(owner, sid)
            await self._reconcile(runtime, owner, sid, data)
            internal = await self._start(runtime, owner, sid, rid, data, None)
            batch_key = rid + ":" + request_id
            batch = data["batches"].get(batch_key)
            if batch is not None:
                if batch.get("limit") != limit:
                    raise WorkError("input_batch_conflict", "同一批次请求的参数已变化。", 409)
                if batch["state"] == "paused":
                    raise WorkError("input_batch_paused", "原输入批次已暂停，未重新派发。", 409)
                return {"request_id": request_id, "inputs": [
                    self._input(data["inputs"][value]) for value in batch["input_ids"]]}
            if any(value.get("turn_id") == rid and value.get("state") == "offered" for value in data["batches"].values()):
                raise WorkError("input_batch_pending", "上一批输入尚未确认，请核对原请求。", 409)

            queued = []
            while not runtime.bus.inbound.empty():
                queued.append(runtime.bus.inbound.get_nowait())
                runtime.bus.inbound.task_done()
            selected, remaining, selected_ids = [], [], set()
            for message in queued:
                if message.chat_id != sid:
                    remaining.append(message)
                    continue
                item = data["inputs"].get(message.metadata.get("input_id"))
                if (message.chat_id == sid and message.metadata.get("hosted_run_id") == rid
                        and item and item.get("state") == "accepted" and item.get("turn_id") == rid
                        and item.get("batch_id") is None and item["input_id"] not in selected_ids
                        and len(selected) < limit
                        and runtime.bus.work_turns.can_dispatch_input(sid, item["input_id"], internal)):
                    selected.append(message)
                    selected_ids.add(item["input_id"])
                elif (item and item.get("state") == "accepted" and item["input_id"] not in selected_ids
                      and item.get("turn_id") == message.metadata.get("hosted_run_id")):
                    remaining.append(message)
            ids = [message.metadata["input_id"] for message in selected]
            data["batches"][batch_key] = {"turn_id": rid, "input_ids": ids,
                                          "state": "offered" if ids else "acknowledged", "limit": limit}
            for value in ids:
                data["inputs"][value]["batch_id"] = request_id
            try:
                self._save(owner, sid, data)
            except BaseException:
                for message in queued:
                    runtime.bus.inbound.put_nowait(message)
                raise
            for message in remaining:
                runtime.bus.inbound.put_nowait(message)
            remaining_ids = {id(message) for message in remaining}
            for message in queued:
                if id(message) not in remaining_ids:
                    runtime.queued.discard((message.chat_id, message.metadata.get("hosted_run_id"),
                                            message.metadata.get("input_id")))
            for message in remaining:
                runtime.queued.add((message.chat_id, message.metadata.get("hosted_run_id"),
                                    message.metadata.get("input_id")))
            return {"request_id": request_id, "inputs": [
                self._input(data["inputs"][value]) for value in ids]}

    async def acknowledge(self, owner: str, sid: str, rid: str, request_id: str) -> list[dict]:
        runtime = self._owner(owner)
        sid, rid, request_id = self._session_id(sid), identifier(rid), self._input_id(request_id)
        async with runtime.lock:
            data = self._load(owner, sid)
            await self._reconcile(runtime, owner, sid, data)
            internal = await self._start(runtime, owner, sid, rid, data, None)
            batch = data["batches"].get(rid + ":" + request_id)
            if batch is None:
                raise WorkError("input_batch_not_found", "未找到待确认的原输入批次。", 404)
            items = [data["inputs"][value] for value in batch["input_ids"]]
            if batch["state"] == "acknowledged":
                return [self._snapshot(sid, item) for item in items]
            if batch["state"] != "offered" or any(
                    item.get("state") != "accepted" or item.get("turn_id") != rid
                    or item.get("batch_id") != request_id
                    or not runtime.bus.work_turns.can_dispatch_input(sid, item["input_id"], internal)
                    for item in items):
                raise WorkError("input_batch_conflict", "输入批次状态已变化，未重复派发。", 409)
            batch["state"] = "acknowledged"
            for item in items:
                item["state"] = "consumed"
            self._save(owner, sid, data)
            for item in items:
                runtime.bus.work_turns.bind_input(sid, item["input_id"], internal)
                if not runtime.bus.work_turns.consume_input(sid, item["input_id"], internal):
                    raise WorkError("invalid_state", "输入回执状态待核对，不会重新派发。", 503)
            self._drain_outbound(runtime)
            await self._emit(owner, sid, items)
            return [self._snapshot(sid, item) for item in items]

    async def _reconcile(self, runtime: _Owner, owner: str, sid: str, data: dict) -> None:
        paused, runs = [], set()
        for item in data["inputs"].values():
            if item.get("state") != "accepted":
                continue
            rid = item["turn_id"]
            try:
                live = self._run(owner, sid, rid)["status"] == "running" and rid not in data["blocked"]
            except WorkError as exc:
                if exc.status != 404:
                    raise
                live = False
            if not live:
                item["state"] = "paused"
                item["batch_id"] = None
                data["blocked"][rid] = True
                paused.append(item)
                runs.add(rid)
        if not paused:
            return
        for batch in data["batches"].values():
            if batch.get("turn_id") in runs and batch.get("state") == "offered":
                batch["state"] = "paused"
        self._save(owner, sid, data)
        for rid in runs:
            if rid in runtime.by_run:
                runtime.bus.work_turns.pause_inputs(sid, runtime.by_run[rid])
        self._drain_outbound(runtime)
        await self._emit(owner, sid, paused)

    async def snapshot(self, owner: str, sid: str) -> list[dict]:
        runtime = self._owner(owner)
        sid = self._session_id(sid)
        async with runtime.lock:
            data = self._load(owner, sid)
            await self._reconcile(runtime, owner, sid, data)
            return [self._snapshot(sid, item) for item in data["inputs"].values()]

    async def pause(self, owner: str, sid: str, rid: str) -> list[dict]:
        runtime = self._owner(owner)
        sid, rid = self._session_id(sid), identifier(rid)
        async with runtime.lock:
            data = self._load(owner, sid)
            self._run(owner, sid, rid)
            data["blocked"][rid] = True
            self._save(owner, sid, data)
            await self._reconcile(runtime, owner, sid, data)
            return [self._snapshot(sid, item) for item in data["inputs"].values()
                    if item.get("turn_id") == rid and item.get("state") == "paused"]

    async def finish(self, owner: str, sid: str, rid: str) -> None:
        await self.pause(owner, sid, rid)
        runtime = self._owner(owner)
        sid, rid = self._session_id(sid), identifier(rid)
        async with runtime.lock:
            data = self._load(owner, sid)
            data["batches"] = {key: batch for key, batch in data["batches"].items()
                               if batch.get("turn_id") != rid}
            self._save(owner, sid, data)
            internal = runtime.by_run.pop(rid, None)
            if internal:
                runtime.bus.work_turns.finish(internal)
                runtime.by_turn.pop(internal, None)
            queued = []
            while not runtime.bus.inbound.empty():
                message = runtime.bus.inbound.get_nowait()
                runtime.bus.inbound.task_done()
                if message.chat_id != sid or message.metadata.get("hosted_run_id") != rid:
                    queued.append(message)
            for message in queued:
                runtime.bus.inbound.put_nowait(message)
            runtime.queued = {key for key in runtime.queued if key[:2] != (sid, rid)}
