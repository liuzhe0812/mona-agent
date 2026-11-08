"""Parent-owned, at-most-once image calls with durable results before settlement."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import io
import json
import re
import time
from dataclasses import dataclass

import httpx
from PIL import Image

from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.image_generation import _request_fingerprint
from mona.hosted_work.model_transport import HostedModelTransport
from mona.providers.image_generation import GeneratedImageResponse
from mona.utils.artifacts import decode_image_data_url

_HASH = re.compile(r"^[a-f0-9]{64}$")
_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


class _ImageTransport(httpx.AsyncBaseTransport):
    def __init__(self, endpoint: str, limit: int):
        self.inner, self.limit = HostedModelTransport(endpoint), limit

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self.inner.handle_async_request(request)
        try:
            if not 200 <= response.status_code < 300:
                # Desktop providers log upstream errors; never forward their raw bodies here.
                return httpx.Response(response.status_code, headers={"Content-Type": "application/json"},
                                      content=b'{"error":{"message":"Image service request failed"}}', request=request)
            length = response.headers.get("Content-Length")
            if length and (not length.isdecimal() or int(length) > self.limit):
                raise WorkError("image_limit", "图片服务返回内容超过允许大小。", 503)
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > self.limit:
                    raise WorkError("image_limit", "图片服务返回内容超过允许大小。", 503)
            headers = httpx.Headers(response.headers)
            for name in ("Content-Encoding", "Content-Length", "Transfer-Encoding"):
                headers.pop(name, None)
            return httpx.Response(response.status_code, headers=headers, content=bytes(data), request=request)
        finally:
            await response.aclose()

    async def aclose(self):
        await self.inner.aclose()


def _unknown() -> WorkError:
    return WorkError("image_result_unknown", "图片结果待核对，请勿重复生成。", 503)


@dataclass
class _Flight:
    fingerprint: str
    task: asyncio.Task
    started: bool = False
    cancellable: bool = True
    stop_requested: bool = False


class ImageCoordinator:
    """The caller must drain in-flight tasks before closing the bound run."""

    def __init__(self, config, control, desktop, *, provider_factory=None):
        self.config, self.control, self.desktop = config, control, desktop
        self.provider_factory = provider_factory
        self.flights: dict[tuple[str, str, str], _Flight] = {}
        with self.control.journal.store.transaction():
            self.control.journal.store.db.execute("""
                CREATE TABLE IF NOT EXISTS hosted_image_dispatch_claims (
                    operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
                    run_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created REAL NOT NULL,
                    FOREIGN KEY(operation_id) REFERENCES image_billing_journal(operation_id)
                )
            """)

    def _validate(self, owner, session, run, capability, operation, *, fingerprint, model,
                  prompt, aspect_ratio, image_size, reference_images):
        identifier(session)
        identifier(run)
        identifier(operation)
        binding = self.control._binding(owner, session, run, capability)
        if (not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000
                or not isinstance(model, str) or model != binding.settings.model
                or not isinstance(fingerprint, str) or not _HASH.fullmatch(fingerprint)
                or aspect_ratio is not None and (not isinstance(aspect_ratio, str) or len(aspect_ratio) > 64)
                or image_size is not None and (not isinstance(image_size, str) or len(image_size) > 64)
                or reference_images not in (None, [])):
            raise WorkError("invalid_image_request", "图片请求无效或不支持参考图。", 400)
        if ((image_size and image_size.strip().upper() != "1K")
                or (aspect_ratio and aspect_ratio != "1:1")):
            raise WorkError("invalid_image_request", "当前图片来源仅支持 1K 方图。", 400)
        computed = _request_fingerprint(prompt, model, image_size, aspect_ratio, ())
        row = self.control.journal._row(owner, operation)
        expected = hashlib.sha256(bytes.fromhex(computed)).hexdigest()
        if (row["run_id"] != run or not hmac.compare_digest(fingerprint, computed)
                or not hmac.compare_digest(row["request_fingerprint"], expected)):
            raise WorkError("image_conflict", "图片请求与已授权的操作不一致。", 409)
        return binding

    def _claim(self, owner, session, run, operation, fingerprint):
        store = self.control.journal.store
        with store.transaction():
            row = self.control.journal._row(owner, operation)
            existing = store.db.execute("SELECT * FROM hosted_image_dispatch_claims WHERE operation_id=?",
                                        (operation,)).fetchone()
            if existing:
                if (existing["owner"] != owner or existing["session_id"] != session
                        or existing["run_id"] != run or existing["fingerprint"] != fingerprint):
                    raise WorkError("image_conflict", "图片请求与已授权的操作不一致。", 409)
                return False
            active = store.db.execute("SELECT status,session_id FROM runs WHERE owner=? AND id=?", (owner, run)).fetchone()
            if active is None or active["session_id"] != session or active["status"] != "running" or row["stage"] != "running":
                raise WorkError("execution_stopped", "本轮已停止，未发起图片请求。", 409)
            store.db.execute("INSERT INTO hosted_image_dispatch_claims VALUES(?,?,?,?,?,?)",
                             (operation, owner, session, run, fingerprint, time.time()))
        return True

    def _records(self, owner, session, run, operation):
        key = self.desktop.previews._request_key(session, run, operation, generated=True)
        value = self.desktop.state.get(owner, key)
        if not isinstance(value, dict) or not isinstance(value.get("files"), list) or len(value["files"]) != 1:
            raise _unknown()
        return value["files"]

    def _verified_image(self, owner, session, run, operation):
        record = self._records(owner, session, run, operation)[0]
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            raise _unknown()
        name, data = self.desktop.previews.read(owner, session, record["path"])
        digest = hashlib.sha256(data).hexdigest()
        billing = self.control.journal.get(owner, operation)
        receipt = billing.get("image_result")
        legacy_free = billing.get("stage") == "free_completed" and billing.get("billing_mode") == "free" and receipt is None
        if (name != record.get("name") or len(data) != record.get("size") or digest != record.get("sha256")
                or record.get("mime") not in _EXTENSIONS
                or record["path"] != f"/workspace/.generated-previews/{run}/{operation}/{digest}.{_EXTENSIONS[record['mime']]}"
                or not legacy_free and receipt != {"sha256": digest, "image_count": 1}):
            raise _unknown()
        return record, name, data

    def _saved(self, owner, session, run, operation):
        stage = self.control.journal.get(owner, operation)["stage"]
        if stage not in {"settled", "free_completed"}:
            return {"status": "uncertain"}
        record, name, data = self._verified_image(owner, session, run, operation)
        digest = record["sha256"]
        return {"status": "settled",
                "image": {"path": record["path"], "name": name, "mime": record["mime"], "size": len(data),
                          "sha256": digest, "data": base64.b64encode(data).decode("ascii")}}

    def _write_history(self, owner, session, run, operation, records):
        from mona.hosted_work.desktop_wire import _task

        metadata = self.desktop.state.get(owner, "run:" + run, {})
        if not isinstance(metadata, dict):
            raise _unknown()
        record = {"event": "deliver_files", "inline_media": True, "task_id": _task(metadata, run),
                  "turn_id": run, "input_id": metadata.get("input_id"), "files": records}
        key = f"run:{run}:generated-preview:{operation}"
        self.desktop.state.append(owner, session, record, key)
        return key, record

    def ensure_history(self, owner: str, session: str, run: str, operation: str) -> bool:
        """Verify the persisted output and idempotently restore its hidden history record."""
        record, _, _ = self._verified_image(owner, session, run, operation)
        self._write_history(owner, session, run, operation, [record])
        return True

    async def publish_ready(self, owner: str, session: str, run: str, operation: str) -> bool:
        """Notify connected peers after recovery; history remains authoritative if none are connected."""
        if self.control.journal.get(owner, operation)["stage"] not in {"settled", "free_completed"}:
            return False
        record, _, _ = self._verified_image(owner, session, run, operation)
        key, event = self._write_history(owner, session, run, operation, [record])
        if self.desktop.state.get(owner, key, False):
            return True
        wire = self.desktop.wire
        delivered = False
        for peer in tuple(getattr(wire, "_peers", ())):
            if peer.owner != owner or session not in peer.chats or peer.socket.closed:
                continue
            try:
                await wire._identity(peer.token, owner)
                urls = self.desktop.history_media(owner, peer.token, session, [record["absolute_path"]])
                if len(urls) != 1:
                    continue
                payload = json.dumps({**event, "chat_id": session, "media_urls": urls}, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False)
                async with asyncio.timeout(min(self.config.tool_timeout_seconds, 5)):
                    await peer.socket.send_str(payload)
                delivered = True
            except (WorkError, ConnectionError, RuntimeError, TimeoutError):
                continue
        if delivered:
            self.desktop.state.set(owner, key, True)
        return delivered

    async def _broadcast_ready(self, owner, session, run, operation):
        try:
            await self.publish_ready(owner, session, run, operation)
        except Exception:
            pass  # The durable record is replayed with fresh tickets on history load.

    async def _uncertain(self, owner, session, run, capability, operation, *, missing=False):
        try:
            await self.control.uncertain(owner, session, run, capability, operation, usage_missing=missing)
        except Exception:
            pass  # The persisted dispatch claim still forbids another provider call.

    async def _execute(self, owner, session, run, capability, operation, binding, *, model, prompt,
                       aspect_ratio, image_size):
        provider = None
        provider_started = False
        flight = self.flights[owner, run, operation]
        flight.started = True
        try:
            if flight.stop_requested:
                raise asyncio.CancelledError
            if not callable(self.provider_factory):
                raise WorkError("image_unavailable", "图片服务暂不可用。", 503)
            provider = self.provider_factory(self.config, binding.settings)
            if inspect.isawaitable(provider):
                provider = await provider
            row = self.control.journal.store.db.execute(
                "SELECT status,session_id FROM runs WHERE owner=? AND id=?", (owner, run)).fetchone()
            if row is None or row["session_id"] != session or row["status"] != "running":
                raise WorkError("execution_stopped", "本轮已停止，未发起图片请求。", 409)
            async with asyncio.timeout(self.config.tool_timeout_seconds):
                provider_started = True
                response = await provider.generate(prompt=prompt, model=model, reference_images=None,
                                                   aspect_ratio=aspect_ratio, image_size=image_size)
            # Once the upstream reply has arrived, finishing local verification
            # and settlement cannot consume more model tokens and must not be
            # interrupted halfway through a billing write.
            flight.cancellable = False
            if (not isinstance(response, GeneratedImageResponse) or len(response.images) != 1
                    or not isinstance(response.images[0], str)
                    or len(response.images[0]) > 4 * ((self.config.max_file_bytes + 2) // 3) + 128):
                raise _unknown()
            data, mime = decode_image_data_url(response.images[0])
            if not 0 < len(data) <= self.config.max_file_bytes or mime not in _EXTENSIONS:
                raise _unknown()
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            item = {"name": f"image-{operation}.{_EXTENSIONS[mime]}", "mime": mime, "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode("ascii")}
            self.desktop.previews._prepare_generated_result(owner, session, run, operation, [item])
            receipt = {"sha256": item["sha256"], "image_count": 1}
            self.control.journal.record_image_result(owner, operation, receipt)
            try:
                self.ensure_history(owner, session, run, operation)
            except Exception:
                return  # usage_ready remains recoverable; no wallet settlement has been attempted.
            try:
                await self.control.finish(owner, session, run, capability, operation, receipt)
            except Exception:
                return  # The durable receipt and hidden image remain for reconciliation.
            await self._broadcast_ready(owner, session, run, operation)
        except asyncio.CancelledError:
            flight.cancellable = False
            if not provider_started or getattr(provider, "request_started", True) is False:
                try:
                    await asyncio.shield(self.control.release_not_started(owner, session, run, capability, operation))
                except Exception:
                    await asyncio.shield(self._uncertain(owner, session, run, capability, operation))
            else:
                await asyncio.shield(self._uncertain(owner, session, run, capability, operation))
            raise
        except Exception:
            flight.cancellable = False
            if not provider_started or getattr(provider, "request_started", True) is False:
                try:
                    await self.control.release_not_started(owner, session, run, capability, operation)
                except Exception:
                    await self._uncertain(owner, session, run, capability, operation)
            else:
                await self._uncertain(owner, session, run, capability, operation)
            raise _unknown() from None
        finally:
            if provider is not None:
                close = getattr(provider, "aclose", None) or getattr(provider, "close", None)
                if callable(close):
                    try:
                        async with asyncio.timeout(min(self.config.tool_timeout_seconds, 15)):
                            result = close()
                            if inspect.isawaitable(result):
                                await result
                    except Exception:
                        pass

    async def generate(self, owner: str, session: str, run: str, capability: str, operation: str, *,
                       fingerprint: str, model: str, prompt: str, aspect_ratio: str | None = None,
                       image_size: str | None = None, reference_images: list[str] | None = None) -> dict:
        binding = self._validate(owner, session, run, capability, operation, fingerprint=fingerprint, model=model,
                                 prompt=prompt, aspect_ratio=aspect_ratio, image_size=image_size,
                                 reference_images=reference_images)
        key = (owner, run, operation)
        flight = self.flights.get(key)
        if flight is not None:
            if not hmac.compare_digest(flight.fingerprint, fingerprint):
                raise WorkError("image_conflict", "图片请求与已授权的操作不一致。", 409)
        elif self._claim(owner, session, run, operation, fingerprint):
            task = asyncio.create_task(self._execute(owner, session, run, capability, operation, binding,
                                       model=model, prompt=prompt, aspect_ratio=aspect_ratio, image_size=image_size))
            task.add_done_callback(lambda item: None if item.cancelled() else item.exception())
            flight = self.flights[key] = _Flight(fingerprint, task)
        if flight is not None:
            try:
                await asyncio.shield(flight.task)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # A failed operation remains unavailable and is never re-dispatched.
        return self._saved(owner, session, run, operation)

    async def wait_run(self, owner: str, run: str) -> None:
        tasks = [flight.task for (row_owner, row_run, _), flight in self.flights.items()
                 if row_owner == owner and row_run == run]
        if tasks:
            await asyncio.gather(*(asyncio.shield(task) for task in tasks), return_exceptions=True)

    def cancel_run(self, owner: str, run: str) -> None:
        """Stop only this run's in-flight provider requests, not settled work."""
        identifier(run)
        for key, flight in tuple(self.flights.items()):
            if key[:2] != (owner, run) or flight.task.done() or not flight.cancellable:
                continue
            flight.stop_requested = True
            # If the coroutine hasn't started, let its cancellation handler
            # run so it can release a reservation known not to be dispatched.
            if flight.started and flight.task.cancelling() == 0:
                flight.task.cancel()

    def active(self, owner: str, run: str, operation: str) -> bool:
        flight = self.flights.get((owner, run, operation))
        return flight is not None and not flight.task.done()

    def active_run(self, owner: str, run: str) -> bool:
        return any(not flight.task.done() for (row_owner, row_run, _), flight in self.flights.items()
                   if row_owner == owner and row_run == run)

    def forget_run(self, owner: str, run: str) -> None:
        keys = [key for key in self.flights if key[:2] == (owner, run)]
        if any(not self.flights[key].task.done() for key in keys):
            raise WorkError("image_busy", "图片操作仍在处理。", 409)
        for key in keys:
            del self.flights[key]
