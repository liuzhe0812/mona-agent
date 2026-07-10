"""Schedule service: coordinates personal reminders and AI automated tasks.

Personal reminders (kind="personal") are kept in a workspace JSON file and
fired by an in-process asyncio timer.

AI automated tasks (kind="ai_task") are mirrored into CronService so the
existing cron loop handles dispatch and persistence of run state.

Storage mirrors the CronService pattern: a single JSON file in the workspace,
guarded by a FileLock.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock
from loguru import logger

from mona.schedule.types import ScheduleItem, ScheduleState


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cron_expr_for_recurrence(item: ScheduleItem) -> str | None:
    """Map a recurrence to a cron expression, or return the explicit cron_expr."""
    if item.recurrence == "cron_expr":
        return item.cron_expr
    if item.recurrence == "daily":
        dt = time.localtime(item.start_at_ms / 1000)
        return f"{dt.tm_min} {dt.tm_hour} * * *"
    if item.recurrence == "weekly":
        dt = time.localtime(item.start_at_ms / 1000)
        # tm_wday: 0=Mon .. 6=Sun; cron day-of-week: 0=Sun .. 6=Sat.
        cron_dow = (dt.tm_wday + 1) % 7
        return f"{dt.tm_min} {dt.tm_hour} * * {cron_dow}"
    if item.recurrence == "monthly":
        dt = time.localtime(item.start_at_ms / 1000)
        return f"{dt.tm_min} {dt.tm_hour} {dt.tm_mday} * *"
    return None


def _compute_next_run_ms(item: ScheduleItem) -> int | None:
    """Compute the next run time for a recurring personal reminder."""
    from mona.cron.service import _compute_next_run
    from mona.cron.types import CronSchedule

    if item.recurrence == "none":
        return None
    expr = _cron_expr_for_recurrence(item)
    if not expr:
        return None
    schedule = CronSchedule(kind="cron", expr=expr, tz=item.tz)
    return _compute_next_run(schedule, _now_ms())


class ScheduleService:
    """Coordinates personal reminders and AI tasks.

    Storage: ``<workspace>/schedule/items.json`` (JSON, FileLock-guarded).
    AI tasks are mirrored into CronService for dispatch.
    """

    def __init__(
        self,
        store_path: Path,
        cron_service: Any | None = None,
        notify_callback: Any | None = None,
    ) -> None:
        self.store_path = store_path
        self._lock = FileLock(str(store_path.parent) + ".lock")
        self._cron = cron_service
        # notify_callback(item: ScheduleItem) -> coroutine; called when a
        # personal reminder fires. The HTTP layer injects a callback that
        # publishes to the message bus so the frontend can show a notification.
        self._notify_callback = notify_callback
        # item_id -> asyncio.TimerHandle for personal reminders
        self._timers: dict[str, asyncio.TimerHandle] = {}
        # item_id -> cron job_id for AI tasks
        self._cron_job_ids: dict[str, str] = {}
        # Pending system notifications fired by personal reminders, consumed
        # via pop_pending_notifications() by the HTTP layer. Each entry is a
        # dict with title/body/item_id. This decouples firing (asyncio timer)
        # from delivery (Tauri native toast via HTTP polling).
        self._pending_notifications: list[dict[str, Any]] = []
        self._running = False

    # ---- Storage ----

    def _load_store(self) -> ScheduleState:
        """Load items from disk. Returns empty state if file missing/corrupt."""
        if not self.store_path.exists():
            return ScheduleState()
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            logger.exception("Failed to load schedule store; starting empty")
            return ScheduleState()
        items = []
        for raw in data.get("items", []):
            try:
                items.append(ScheduleItem.from_dict(raw))
            except Exception:
                logger.exception("Skipping malformed schedule item: {}", raw)
        return ScheduleState(items=items)

    def _save_store(self, state: ScheduleState) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "items": [item.to_dict() for item in state.items]}
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.store_path)

    def _load_items(self) -> list[ScheduleItem]:
        return self._load_store().items

    def _find_item(self, items: list[ScheduleItem], item_id: str) -> ScheduleItem | None:
        return next((it for it in items if it.id == item_id), None)

    # ---- Lifecycle ----

    async def start(self) -> None:
        self._running = True
        await self._refresh_from_storage()
        logger.info("Schedule service started")

    def stop(self) -> None:
        self._running = False
        for handle in self._timers.values():
            handle.cancel()
        self._timers.clear()

    async def _refresh_from_storage(self) -> None:
        items = self._load_items()
        for item in items:
            if not item.enabled or item.done:
                continue
            if item.kind == "personal":
                self._arm_personal_timer(item)
            elif item.kind == "ai_task":
                self._mirror_ai_task(item)

    # ---- Personal reminder timers ----

    def _arm_personal_timer(self, item: ScheduleItem) -> None:
        """Arm (or re-arm) the asyncio timer for a personal reminder."""
        if not item.enabled or item.done:
            return
        old = self._timers.pop(item.id, None)
        if old:
            old.cancel()

        # Determine the next fire time. For one-shot reminders whose time has
        # passed, skip (no retroactive firing on startup). For recurring
        # reminders whose start_at_ms is in the past, compute the next run.
        fire_at_ms = item.start_at_ms
        if fire_at_ms <= _now_ms():
            if item.recurrence == "none":
                return
            next_ms = _compute_next_run_ms(item)
            if next_ms is None or next_ms <= _now_ms():
                return
            fire_at_ms = next_ms

        delay_s = max(0.1, (fire_at_ms - _now_ms()) / 1000)
        loop = asyncio.get_running_loop()
        handle = loop.call_later(
            delay_s, lambda: asyncio.create_task(self._fire_personal(item.id))
        )
        self._timers[item.id] = handle
        logger.info("Armed personal reminder '{}' at +{:.1f}s", item.title, delay_s)

    async def _fire_personal(self, item_id: str) -> None:
        """Fire a personal reminder: invoke notify callback and update state."""
        self._timers.pop(item_id, None)
        item = self._get_item_sync(item_id)
        if not item or not item.enabled or item.done:
            return
        logger.info("Schedule: firing personal reminder '{}'", item.title)

        # Enqueue a system notification so the Tauri Rust side can pop it
        # via HTTP polling and show a native Windows toast — this works even
        # when the app window is minimized to the tray.
        body = item.description or item.title
        self._pending_notifications.append(
            {"title": f"日程提醒 · {item.title}", "body": body, "item_id": item.id}
        )

        if self._notify_callback:
            try:
                await self._notify_callback(item)
            except Exception:
                logger.exception("Schedule notify callback failed for '{}'", item.title)

        if item.recurrence == "none":
            item.done = True
            item.last_run_at_ms = _now_ms()
            item.last_status = "ok"
            self._save_item_sync(item)
        else:
            item.last_run_at_ms = _now_ms()
            item.next_run_at_ms = _compute_next_run_ms(item)
            self._save_item_sync(item)
            self._arm_personal_timer(item)

    # ---- AI task mirroring ----

    def _mirror_ai_task(self, item: ScheduleItem) -> None:
        """Mirror an AI task into CronService so its loop dispatches it."""
        if not self._cron:
            return
        from mona.cron.types import CronSchedule

        if item.recurrence == "none":
            schedule = CronSchedule(kind="at", at_ms=item.start_at_ms)
            delete_after_run = True
        else:
            expr = _cron_expr_for_recurrence(item)
            if not expr:
                logger.warning(
                    "Schedule: cannot mirror AI task '{}': no cron expr", item.title
                )
                return
            schedule = CronSchedule(kind="cron", expr=expr, tz=item.tz)
            delete_after_run = False

        old_job_id = self._cron_job_ids.pop(item.id, None)
        if old_job_id:
            self._cron.remove_job(old_job_id)

        job = self._cron.add_job(
            name=f"schedule:{item.id}",
            schedule=schedule,
            message=item.ai_message or item.title,
            deliver=item.ai_deliver,
            channel="api",
            to=item.source_chat_id or "direct",
            delete_after_run=delete_after_run,
            channel_meta={
                "schedule_item_id": item.id,
                "source_module": item.source_module or "",
            },
            session_key=f"schedule:{item.id}",
        )
        self._cron_job_ids[item.id] = job.id
        logger.debug("Mirrored AI task '{}' to cron job {}", item.title, job.id)

    # ---- Sync helpers (operate on the JSON store directly) ----

    def _get_item_sync(self, item_id: str) -> ScheduleItem | None:
        with self._lock:
            return self._find_item(self._load_items(), item_id)

    def _save_item_sync(self, item: ScheduleItem) -> None:
        with self._lock:
            items = self._load_items()
            existing = self._find_item(items, item.id)
            if existing:
                idx = items.index(existing)
                items[idx] = item
            else:
                items.append(item)
            self._save_store(ScheduleState(items=items))

    def _delete_item_sync(self, item_id: str) -> bool:
        with self._lock:
            items = self._load_items()
            before = len(items)
            items = [it for it in items if it.id != item_id]
            if len(items) == before:
                return False
            self._save_store(ScheduleState(items=items))
            return True

    # ---- Public API (async, used by HTTP layer and agent tool) ----

    async def add_item(self, item: ScheduleItem) -> ScheduleItem:
        if item.created_at_ms == 0:
            item.created_at_ms = _now_ms()
        item.updated_at_ms = _now_ms()
        self._save_item_sync(item)
        # Done/disabled items: cancel any active timer/cron job and skip arming.
        if item.done or not item.enabled:
            handle = self._timers.pop(item.id, None)
            if handle:
                handle.cancel()
            job_id = self._cron_job_ids.pop(item.id, None)
            if job_id and self._cron:
                self._cron.remove_job(job_id)
            return item
        if item.kind == "personal":
            self._arm_personal_timer(item)
        elif item.kind == "ai_task":
            self._mirror_ai_task(item)
        return item

    async def update_item(self, item: ScheduleItem) -> ScheduleItem:
        return await self.add_item(item)

    async def remove_item(self, item_id: str) -> bool:
        handle = self._timers.pop(item_id, None)
        if handle:
            handle.cancel()
        job_id = self._cron_job_ids.pop(item_id, None)
        if job_id and self._cron:
            self._cron.remove_job(job_id)
        return self._delete_item_sync(item_id)

    async def toggle_item(self, item_id: str, enabled: bool) -> bool:
        item = self._get_item_sync(item_id)
        if not item:
            return False
        item.enabled = enabled
        item.updated_at_ms = _now_ms()
        self._save_item_sync(item)
        if item.kind == "personal":
            if enabled:
                self._arm_personal_timer(item)
            else:
                handle = self._timers.pop(item_id, None)
                if handle:
                    handle.cancel()
        elif item.kind == "ai_task":
            job_id = self._cron_job_ids.get(item_id)
            if job_id and self._cron:
                self._cron.enable_job(job_id, enabled)
        return True

    async def list_items(
        self, from_ms: int | None = None, to_ms: int | None = None
    ) -> list[ScheduleItem]:
        items = self._load_items()
        if from_ms is not None:
            items = [it for it in items if it.start_at_ms >= from_ms]
        if to_ms is not None:
            items = [it for it in items if it.start_at_ms <= to_ms]
        items.sort(key=lambda it: (it.start_at_ms, it.id))
        return items

    async def get_item(self, item_id: str) -> ScheduleItem | None:
        return self._get_item_sync(item_id)

    def pop_pending_notifications(self) -> list[dict[str, Any]]:
        """Return and clear pending system notifications.

        Called by the HTTP layer when Tauri polls ``/api/schedule/notifications``.
        Each entry: ``{title, body, item_id}``.
        """
        pending = self._pending_notifications
        self._pending_notifications = []
        return pending


def create_schedule_item_id() -> str:
    return f"schedule-{uuid.uuid4()}"
