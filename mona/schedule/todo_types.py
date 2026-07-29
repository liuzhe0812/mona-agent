"""TodoItem types for the unified planning center.

Todos live alongside ScheduleItem in the schedule module but keep separate
semantics: a ScheduleItem is anchored to a start time, while a TodoItem
represents an action that may have no specific time.

Storage mirrors ScheduleService: a single JSON file in the workspace,
guarded by a FileLock.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

TodoState = Literal["suggestion", "open", "done"]
TodoBucket = Literal["inbox", "today", "next", "waiting", "someday"]
TodoPriority = Literal["low", "normal", "high"]
TodoSourceType = Literal["manual", "email", "chat", "note"]


@dataclass
class TodoItem:
    """A todo action tracked by the planning center.

    State lifecycle:
        suggestion → open (user confirms) → done (user completes)
        suggestion → discarded (removed)
        open → done

    Only ``state=open`` items participate in buckets, counts and briefings.
    ``state=suggestion`` items wait for user confirmation and never enter
    today list or morning briefing.
    """

    id: str
    title: str
    created_at_ms: int
    updated_at_ms: int

    state: TodoState = "open"
    bucket: TodoBucket = "inbox"
    notes: str = ""
    due_at_ms: int | None = None
    priority: TodoPriority = "normal"
    # 1, 2 or 3 — only valid for state=open & bucket=today. Unique within
    # the same bucket; setting it displaces any existing item with the same rank.
    focus_rank: int | None = None

    source_type: TodoSourceType = "manual"
    # Structured locator for jumping back to the source. Shape depends on
    # source_type — see design doc §3.2. Kept as a dict to avoid fragile
    # string concatenation.
    source_locator: dict[str, Any] = field(default_factory=dict)
    # Minimal evidence snapshot so the todo still makes sense if the source
    # is moved or deleted: {"title": "...", "evidence": "..."}
    source_snapshot: dict[str, str] = field(default_factory=dict)

    # AI extraction confidence (0..1). None for manual todos.
    confidence: float | None = None
    # Associated ScheduleItem id once the todo is arranged on the calendar.
    schedule_id: str | None = None
    completed_at_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return a camelCase dict (matches from_dict / JSON convention)."""
        return {
            "id": self.id,
            "title": self.title,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
            "state": self.state,
            "bucket": self.bucket,
            "notes": self.notes,
            "dueAtMs": self.due_at_ms,
            "priority": self.priority,
            "focusRank": self.focus_rank,
            "sourceType": self.source_type,
            "sourceLocator": dict(self.source_locator),
            "sourceSnapshot": dict(self.source_snapshot),
            "confidence": self.confidence,
            "scheduleId": self.schedule_id,
            "completedAtMs": self.completed_at_ms,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TodoItem":
        """Build a TodoItem from a camelCase dict."""
        return cls(
            id=data["id"],
            title=data["title"],
            created_at_ms=int(data["createdAtMs"]),
            updated_at_ms=int(data["updatedAtMs"]),
            state=data.get("state", "open"),
            bucket=data.get("bucket", "inbox"),
            notes=data.get("notes", ""),
            due_at_ms=int(data["dueAtMs"]) if data.get("dueAtMs") is not None else None,
            priority=data.get("priority", "normal"),
            focus_rank=int(data["focusRank"]) if data.get("focusRank") is not None else None,
            source_type=data.get("sourceType", "manual"),
            source_locator=dict(data.get("sourceLocator") or {}),
            source_snapshot=dict(data.get("sourceSnapshot") or {}),
            confidence=float(data["confidence"]) if data.get("confidence") is not None else None,
            schedule_id=data.get("scheduleId"),
            completed_at_ms=int(data["completedAtMs"]) if data.get("completedAtMs") is not None else None,
        )


@dataclass
class TodoStoreState:
    """In-memory state for the todo store."""

    items: list[TodoItem] = field(default_factory=list)
