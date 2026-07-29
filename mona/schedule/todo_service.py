"""TodoService: persistence and state transitions for TodoItem.

Storage mirrors ScheduleService: ``<workspace>/schedule/todos.json`` guarded
by a FileLock, atomic replace via .tmp.

State rules enforced here:
- ``state=done`` must set ``completed_at_ms`` and clear ``focus_rank``
- ``focus_rank`` only valid for ``state=open, bucket=today``; unique within
  the bucket — setting it displaces any existing item with the same rank
- ``state=suggestion`` never participates in counts, today list or briefing
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from filelock import FileLock
from loguru import logger

from mona.schedule.todo_types import TodoItem, TodoStoreState


def _now_ms() -> int:
    return int(time.time() * 1000)


def create_todo_id() -> str:
    return f"todo-{uuid.uuid4().hex[:12]}"


_VALID_STATES = {"suggestion", "open", "done"}
_VALID_BUCKETS = {"inbox", "today", "next", "waiting", "someday"}
_VALID_PRIORITIES = {"low", "normal", "high"}


class TodoService:
    """CRUD + state transitions for TodoItem.

    Storage: ``<workspace>/schedule/todos.json`` (JSON, FileLock-guarded).
    """

    def __init__(self, store_path: Path) -> None:
        self.store_path = store_path
        self._lock = FileLock(str(store_path.parent) + ".todos.lock")
        self._running = False

    # ---- Storage ----

    def _load_store(self) -> TodoStoreState:
        if not self.store_path.exists():
            return TodoStoreState()
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            logger.exception("Failed to load todo store; starting empty")
            return TodoStoreState()
        items: list[TodoItem] = []
        for raw in data.get("items", []):
            try:
                items.append(TodoItem.from_dict(raw))
            except Exception:
                logger.exception("Skipping malformed todo item: {}", raw)
        return TodoStoreState(items=items)

    def _save_store(self, state: TodoStoreState) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 1, "items": [item.to_dict() for item in state.items]}
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.store_path)

    # ---- Lifecycle ----

    async def start(self) -> None:
        self._running = True
        logger.info("TodoService started at {}", self.store_path)

    def stop(self) -> None:
        self._running = False

    # ---- Helpers ----

    @staticmethod
    def _find(items: list[TodoItem], item_id: str) -> TodoItem | None:
        return next((it for it in items if it.id == item_id), None)

    def _displace_focus_rank(
        self, items: list[TodoItem], rank: int, exclude_id: str | None
    ) -> None:
        """Clear focus_rank on any other today-item holding this rank."""
        for it in items:
            if it.id == exclude_id:
                continue
            if it.state == "open" and it.bucket == "today" and it.focus_rank == rank:
                it.focus_rank = None

    # ---- Public API ----

    async def list_items(
        self,
        *,
        state: str | None = None,
        bucket: str | None = None,
        source_type: str | None = None,
    ) -> list[TodoItem]:
        with self._lock:
            items = self._load_store().items
        result = items
        if state:
            result = [it for it in result if it.state == state]
        if bucket:
            # bucket only meaningful for state=open
            result = [it for it in result if it.state == "open" and it.bucket == bucket]
        if source_type:
            result = [it for it in result if it.source_type == source_type]
        return result

    async def get_item(self, item_id: str) -> TodoItem | None:
        with self._lock:
            return self._find(self._load_store().items, item_id)

    async def add_item(self, item: TodoItem) -> TodoItem:
        """Add a new todo. Enforces focus_rank uniqueness on insert."""
        if item.state not in _VALID_STATES:
            raise ValueError(f"invalid state: {item.state}")
        if item.bucket not in _VALID_BUCKETS:
            raise ValueError(f"invalid bucket: {item.bucket}")
        if item.priority not in _VALID_PRIORITIES:
            raise ValueError(f"invalid priority: {item.priority}")
        now = _now_ms()
        if item.created_at_ms == 0:
            item.created_at_ms = now
        item.updated_at_ms = now
        # focus_rank only valid for open+today
        if item.focus_rank is not None:
            if item.state != "open" or item.bucket != "today":
                item.focus_rank = None
            elif item.focus_rank not in (1, 2, 3):
                raise ValueError(f"focus_rank must be 1, 2 or 3, got {item.focus_rank}")
        with self._lock:
            store = self._load_store()
            if item.focus_rank is not None:
                self._displace_focus_rank(store.items, item.focus_rank, exclude_id=item.id)
            store.items.append(item)
            self._save_store(store)
        return item

    async def update_item(self, item_id: str, patch: dict[str, Any]) -> TodoItem:
        """Apply a partial patch and enforce state transitions.

        Special transitions handled here:
        - state=done → set completed_at_ms, clear focus_rank
        - focus_rank set → displace existing holder
        - bucket changed away from today → clear focus_rank
        - state changed away from open → clear focus_rank
        """
        with self._lock:
            store = self._load_store()
            item = self._find(store.items, item_id)
            if item is None:
                raise KeyError(item_id)

            new_state = patch.get("state", item.state)
            new_bucket = patch.get("bucket", item.bucket)
            new_focus_rank = patch.get("focusRank", item.focus_rank)

            if new_state not in _VALID_STATES:
                raise ValueError(f"invalid state: {new_state}")
            if new_bucket not in _VALID_BUCKETS:
                raise ValueError(f"invalid bucket: {new_bucket}")

            # Apply scalar fields
            if "title" in patch:
                item.title = patch["title"]
            if "notes" in patch:
                item.notes = patch["notes"]
            if "dueAtMs" in patch:
                item.due_at_ms = (
                    int(patch["dueAtMs"]) if patch["dueAtMs"] is not None else None
                )
            if "priority" in patch:
                if patch["priority"] not in _VALID_PRIORITIES:
                    raise ValueError(f"invalid priority: {patch['priority']}")
                item.priority = patch["priority"]
            if "sourceLocator" in patch:
                item.source_locator = dict(patch["sourceLocator"] or {})
            if "sourceSnapshot" in patch:
                item.source_snapshot = dict(patch["sourceSnapshot"] or {})
            if "confidence" in patch:
                item.confidence = (
                    float(patch["confidence"]) if patch["confidence"] is not None else None
                )
            if "scheduleId" in patch:
                item.schedule_id = patch["scheduleId"]

            item.state = new_state
            item.bucket = new_bucket

            # focus_rank validity: only for open+today
            if new_state == "done":
                item.completed_at_ms = _now_ms()
                item.focus_rank = None
            elif new_state != "open" or new_bucket != "today":
                item.focus_rank = None
            elif new_focus_rank is not None:
                if new_focus_rank not in (1, 2, 3):
                    raise ValueError(f"focus_rank must be 1, 2 or 3, got {new_focus_rank}")
                self._displace_focus_rank(store.items, new_focus_rank, exclude_id=item.id)
                item.focus_rank = new_focus_rank
            elif "focusRank" in patch and patch["focusRank"] is None:
                # explicit clear
                item.focus_rank = None

            item.updated_at_ms = _now_ms()
            self._save_store(store)
            return item

    async def remove_item(self, item_id: str) -> bool:
        with self._lock:
            store = self._load_store()
            before = len(store.items)
            store.items = [it for it in store.items if it.id != item_id]
            if len(store.items) == before:
                return False
            self._save_store(store)
            return True

    # ---- Briefing ----

    async def get_briefing(self, *, now_ms: int | None = None) -> dict[str, Any]:
        """Return today's briefing payload.

        Includes:
        - confirmed top3: open today items with focus_rank set
        - recommendations: overdue + due today + high priority next
        - overdue_count, due_today_count, suggestion_count
        """
        now = now_ms or _now_ms()
        # Today end = start of tomorrow local
        lt = time.localtime(now / 1000)
        today_end_ms = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 23, 59, 59, 0, 0, 0))) * 1000
        today_start_ms = today_end_ms - 86_399_000

        with self._lock:
            items = self._load_store().items

        open_items = [it for it in items if it.state == "open"]
        suggestions = [it for it in items if it.state == "suggestion"]

        confirmed = [
            it for it in open_items
            if it.bucket == "today" and it.focus_rank is not None
        ]
        confirmed.sort(key=lambda it: (it.focus_rank or 99))

        overdue = [
            it for it in open_items
            if it.due_at_ms is not None and it.due_at_ms < today_start_ms
        ]
        due_today = [
            it for it in open_items
            if it.due_at_ms is not None and today_start_ms <= it.due_at_ms <= today_end_ms
        ]
        high_next = [
            it for it in open_items
            if it.bucket == "next" and it.priority == "high"
        ]

        # Recommendations: overdue first, then due today, then high next
        def _sort_key(it: TodoItem) -> tuple:
            due = it.due_at_ms if it.due_at_ms is not None else float("inf")
            prio_order = {"high": 0, "normal": 1, "low": 2}.get(it.priority, 1)
            return (due, prio_order, it.created_at_ms)

        recs = sorted(overdue + due_today + high_next, key=_sort_key)
        # Dedupe by id while preserving order
        seen: set[str] = set()
        recs_unique: list[TodoItem] = []
        for it in recs:
            if it.id in seen:
                continue
            seen.add(it.id)
            recs_unique.append(it)

        confirmed_ids = {it.id for it in confirmed}
        recommendations = [it for it in recs_unique if it.id not in confirmed_ids][:3]

        top3 = confirmed + recommendations[: max(0, 3 - len(confirmed))]

        return {
            "confirmed": [it.to_dict() for it in confirmed],
            "recommendations": [it.to_dict() for it in recommendations],
            "top3": [it.to_dict() for it in top3],
            "overdueCount": len(overdue),
            "dueTodayCount": len(due_today),
            "suggestionCount": len(suggestions),
        }
