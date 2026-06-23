"""Schedule tool for managing user calendar items.

Higher-level than the cron tool: supports personal reminders (no AI execution)
and AI automated tasks, with calendar semantics (start time, end time,
recurrence). Other modules' AI can use this to add schedule entries for the
user.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import (
    BooleanSchema,
    StringSchema,
    tool_parameters_schema,
)

_SCHEDULE_PARAMETERS = tool_parameters_schema(
    action=StringSchema(
        "Action to perform",
        enum=["add", "list", "update", "remove", "complete"],
    ),
    title=StringSchema(
        "Schedule item title (required for add/update). A short human-readable summary."
    ),
    start_at=StringSchema(
        "ISO datetime for when the item starts, e.g. '2026-06-22T14:30:00'. "
        "Naive values use the tool's default timezone."
    ),
    end_at=StringSchema(
        "Optional ISO datetime for when the item ends. Must be after start_at."
    ),
    all_day=BooleanSchema(description="Whether this is an all-day event (default false)."),
    recurrence=StringSchema(
        "Recurrence pattern: 'none' (default), 'daily', 'weekly', 'monthly', or 'cron_expr'.",
        enum=["none", "daily", "weekly", "monthly", "cron_expr"],
    ),
    cron_expr=StringSchema(
        "Cron expression (e.g. '0 9 * * 1-5') required when recurrence='cron_expr'."
    ),
    tz=StringSchema(
        "Optional IANA timezone (e.g. 'America/Vancouver'). Defaults to the tool's timezone."
    ),
    kind=StringSchema(
        "Item type: 'personal' (default, just a reminder) or 'ai_task' "
        "(triggers AI execution at the scheduled time).",
        enum=["personal", "ai_task"],
    ),
    ai_message=StringSchema(
        "Required when kind='ai_task': the instruction for the AI to execute at the scheduled time."
    ),
    ai_deliver=BooleanSchema(
        description="When kind='ai_task', whether to deliver the AI result to the user (default true)."
    ),
    description=StringSchema("Optional longer description / notes."),
    color=StringSchema("Optional color label (e.g. 'blue', 'green', 'purple')."),
    item_id=StringSchema(
        "Schedule item ID. Required for update/remove/complete; obtained via action='list'."
    ),
    required=["action"],
)


@tool_parameters(_SCHEDULE_PARAMETERS)
class ScheduleTool(Tool, ContextAware):
    """Tool to manage user schedule items."""

    def __init__(self, schedule_service: Any, default_timezone: str = "UTC"):
        self._svc = schedule_service
        self._default_timezone = default_timezone
        self._channel: str = ""
        self._chat_id: str = ""
        self._session_key: str | None = None

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.schedule_service is not None

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(schedule_service=ctx.schedule_service, default_timezone=ctx.timezone)

    def set_context(self, ctx: RequestContext) -> None:
        self._channel = ctx.channel
        self._chat_id = ctx.chat_id
        self._session_key = ctx.session_key

    @property
    def name(self) -> str:
        return "schedule"

    @property
    def description(self) -> str:
        return (
            "Manage user schedule (calendar) items: personal reminders and AI automated tasks. "
            "Actions: add, list, update, remove, complete. "
            f"Naive ISO times default to {self._default_timezone}."
        )

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        errors = super().validate_params(params)
        action = params.get("action")
        if action == "add":
            if not str(params.get("title") or "").strip():
                errors.append("title is required when action='add'")
            if not str(params.get("start_at") or "").strip():
                errors.append("start_at is required when action='add'")
            if params.get("kind") == "ai_task" and not str(
                params.get("ai_message") or ""
            ).strip():
                errors.append("ai_message is required when kind='ai_task'")
            if params.get("recurrence") == "cron_expr" and not str(
                params.get("cron_expr") or ""
            ).strip():
                errors.append("cron_expr is required when recurrence='cron_expr'")
        elif action in ("update", "remove", "complete"):
            if not str(params.get("item_id") or "").strip():
                errors.append(f"item_id is required when action='{action}'")
        return errors

    async def execute(
        self,
        action: str,
        title: str | None = None,
        start_at: str | None = None,
        end_at: str | None = None,
        all_day: bool = False,
        recurrence: str = "none",
        cron_expr: str | None = None,
        tz: str | None = None,
        kind: str = "personal",
        ai_message: str | None = None,
        ai_deliver: bool = True,
        description: str = "",
        color: str | None = None,
        item_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if action == "add":
            return await self._add(
                title, start_at, end_at, all_day, recurrence, cron_expr, tz,
                kind, ai_message, ai_deliver, description, color,
            )
        elif action == "list":
            return await self._list()
        elif action == "update":
            return await self._update(
                item_id, title, start_at, end_at, all_day, recurrence, cron_expr,
                tz, kind, ai_message, ai_deliver, description, color,
            )
        elif action == "remove":
            return await self._remove(item_id)
        elif action == "complete":
            return await self._complete(item_id)
        return f"Unknown action: {action}"

    def _parse_iso_to_ms(self, iso_str: str | None, tz: str | None) -> tuple[int | None, str | None]:
        """Parse an ISO datetime string to ms. Returns (ms, error_message)."""
        if not iso_str:
            return None, None
        try:
            dt = datetime.fromisoformat(iso_str)
        except ValueError:
            return None, f"invalid ISO datetime format '{iso_str}'"
        if dt.tzinfo is None:
            effective_tz = tz or self._default_timezone
            try:
                dt = dt.replace(tzinfo=ZoneInfo(effective_tz))
            except Exception:
                return None, f"unknown timezone '{effective_tz}'"
        return int(dt.timestamp() * 1000), None

    async def _add(
        self, title, start_at, end_at, all_day, recurrence, cron_expr, tz,
        kind, ai_message, ai_deliver, description, color,
    ) -> str:
        from mona.schedule import ScheduleItem, create_schedule_item_id

        if not title:
            return "Error: title is required for add"
        if not start_at:
            return "Error: start_at is required for add"
        start_ms, err = self._parse_iso_to_ms(start_at, tz)
        if err:
            return f"Error: {err}"
        end_ms, err2 = self._parse_iso_to_ms(end_at, tz) if end_at else (None, None)
        if err2:
            return f"Error: {err2}"

        item = ScheduleItem(
            id=create_schedule_item_id(),
            title=title,
            start_at_ms=start_ms,
            end_at_ms=end_ms,
            all_day=all_day,
            recurrence=recurrence,
            cron_expr=cron_expr,
            tz=tz,
            kind=kind,
            ai_message=ai_message,
            ai_deliver=ai_deliver,
            description=description or "",
            color=color,
            source_module="agent",
            source_chat_id=self._chat_id or None,
        )
        saved = await self._svc.add_item(item)
        return (
            f"Created schedule item '{saved.title}' (id: {saved.id}) "
            f"at {start_at} ({kind})"
        )

    async def _update(
        self, item_id, title, start_at, end_at, all_day, recurrence, cron_expr,
        tz, kind, ai_message, ai_deliver, description, color,
    ) -> str:
        if not item_id:
            return "Error: item_id is required for update"
        existing = await self._svc.get_item(item_id)
        if not existing:
            return f"Error: schedule item {item_id} not found"

        start_ms, err = self._parse_iso_to_ms(start_at, tz) if start_at else (existing.start_at_ms, None)
        if err:
            return f"Error: {err}"
        end_ms, err2 = self._parse_iso_to_ms(end_at, tz) if end_at else (existing.end_at_ms, None)
        if err2:
            return f"Error: {err2}"

        existing.title = title or existing.title
        existing.start_at_ms = start_ms
        existing.end_at_ms = end_ms
        existing.all_day = all_day if all_day is not None else existing.all_day
        existing.recurrence = recurrence or existing.recurrence
        existing.cron_expr = cron_expr if cron_expr is not None else existing.cron_expr
        existing.tz = tz if tz is not None else existing.tz
        existing.kind = kind or existing.kind
        existing.ai_message = ai_message if ai_message is not None else existing.ai_message
        existing.ai_deliver = ai_deliver if ai_deliver is not None else existing.ai_deliver
        existing.description = description if description is not None else existing.description
        existing.color = color if color is not None else existing.color

        saved = await self._svc.update_item(existing)
        return f"Updated schedule item '{saved.title}' (id: {saved.id})"

    async def _list(self) -> str:
        items = await self._svc.list_items()
        if not items:
            return "No schedule items."
        lines = []
        for it in items:
            dt = datetime.fromtimestamp(it.start_at_ms / 1000)
            kind_label = "AI" if it.kind == "ai_task" else "personal"
            status = ""
            if it.done:
                status = " [done]"
            elif not it.enabled:
                status = " [paused]"
            recur = f", {it.recurrence}" if it.recurrence != "none" else ""
            lines.append(
                f"- {it.title} (id: {it.id}, {dt.isoformat()}, {kind_label}{recur}){status}"
            )
        return "Schedule items:\n" + "\n".join(lines)

    async def _remove(self, item_id: str | None) -> str:
        if not item_id:
            return "Error: item_id is required for remove"
        ok = await self._svc.remove_item(item_id)
        if not ok:
            return f"Error: schedule item {item_id} not found"
        return f"Removed schedule item {item_id}"

    async def _complete(self, item_id: str | None) -> str:
        if not item_id:
            return "Error: item_id is required for complete"
        ok = await self._svc.complete_item(item_id)
        if not ok:
            return f"Error: schedule item {item_id} not found"
        return f"Marked schedule item {item_id} as done"
