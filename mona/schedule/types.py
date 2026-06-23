"""Schedule types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class ScheduleItem:
    """A schedule entry stored in SQLite."""

    id: str
    title: str
    start_at_ms: int
    description: str = ""
    end_at_ms: int | None = None
    all_day: bool = False
    recurrence: str = "none"  # none|daily|weekly|monthly|cron_expr
    cron_expr: str | None = None
    tz: str | None = None
    kind: Literal["personal", "ai_task"] = "personal"
    ai_message: str | None = None
    ai_deliver: bool = True
    done: bool = False
    enabled: bool = True
    color: str | None = None
    source_module: str | None = None
    source_chat_id: str | None = None
    last_run_at_ms: int | None = None
    next_run_at_ms: int | None = None
    last_status: Literal["ok", "error", "skipped"] | None = None
    last_error: str | None = None
    created_at_ms: int = 0
    updated_at_ms: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Return a camelCase dict (matches from_dict / JSON convention)."""
        return {
            "id": self.id,
            "title": self.title,
            "startAtMs": self.start_at_ms,
            "description": self.description,
            "endAtMs": self.end_at_ms,
            "allDay": self.all_day,
            "recurrence": self.recurrence,
            "cronExpr": self.cron_expr,
            "tz": self.tz,
            "kind": self.kind,
            "aiMessage": self.ai_message,
            "aiDeliver": self.ai_deliver,
            "done": self.done,
            "enabled": self.enabled,
            "color": self.color,
            "sourceModule": self.source_module,
            "sourceChatId": self.source_chat_id,
            "lastRunAtMs": self.last_run_at_ms,
            "nextRunAtMs": self.next_run_at_ms,
            "lastStatus": self.last_status,
            "lastError": self.last_error,
            "createdAtMs": self.created_at_ms,
            "updatedAtMs": self.updated_at_ms,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScheduleItem":
        """Build a ScheduleItem from a camelCase dict (Tauri/JSON payload)."""
        return cls(
            id=data["id"],
            title=data["title"],
            start_at_ms=int(data["startAtMs"]),
            description=data.get("description", ""),
            end_at_ms=int(data["endAtMs"]) if data.get("endAtMs") is not None else None,
            all_day=bool(data.get("allDay", False)),
            recurrence=data.get("recurrence", "none"),
            cron_expr=data.get("cronExpr"),
            tz=data.get("tz"),
            kind=data.get("kind", "personal"),
            ai_message=data.get("aiMessage"),
            ai_deliver=bool(data.get("aiDeliver", True)),
            done=bool(data.get("done", False)),
            enabled=bool(data.get("enabled", True)),
            color=data.get("color"),
            source_module=data.get("sourceModule"),
            source_chat_id=data.get("sourceChatId"),
            last_run_at_ms=int(data["lastRunAtMs"]) if data.get("lastRunAtMs") is not None else None,
            next_run_at_ms=int(data["nextRunAtMs"]) if data.get("nextRunAtMs") is not None else None,
            last_status=data.get("lastStatus"),
            last_error=data.get("lastError"),
            created_at_ms=int(data.get("createdAtMs", 0)),
            updated_at_ms=int(data.get("updatedAtMs", 0)),
        )


@dataclass
class ScheduleState:
    items: list[ScheduleItem] = field(default_factory=list)
