"""Todo tool for managing user's unified inbox items.

Distinct from the schedule tool: todos may have no specific time anchor
and follow GTD buckets (inbox / today / next / waiting / someday).

The agent uses this tool to:
- add: create a todo for the user (state=open)
- suggest: create a suggestion (state=suggestion) waiting for user confirm
- list: read todos with filters
- complete: mark a todo done
- update: edit title/notes/due/bucket/priority
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import (
    NumberSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.schedule import TodoServiceUnavailableError, create_todo_id
from mona.schedule.todo_types import TodoItem

_TODO_PARAMETERS = tool_parameters_schema(
    action=StringSchema(
        "Action to perform",
        enum=["add", "suggest", "list", "update", "complete"],
    ),
    title=StringSchema(
        "Short human-readable todo title (≤ 60 chars). Required for add/suggest/update."
    ),
    notes=StringSchema("Optional longer description / context."),
    bucket=StringSchema(
        "GTD bucket. Only valid for open items.",
        enum=["inbox", "today", "next", "waiting", "someday"],
    ),
    due_at=StringSchema(
        "Optional ISO datetime for when the todo is due, e.g. '2026-07-30T17:00:00'. "
        "Naive values use the tool's default timezone."
    ),
    priority=StringSchema(
        "Priority level.",
        enum=["low", "normal", "high"],
    ),
    focus_rank=NumberSchema(
        "Highlight rank for today's top3. Only 1, 2 or 3 — only valid for bucket=today. "
        "Setting it displaces any existing item with the same rank.",
    ),
    item_id=StringSchema(
        "Todo ID. Required for update/complete; obtained via action='list'."
    ),
    state=StringSchema(
        "For update: change state.",
        enum=["suggestion", "open", "done"],
    ),
    source_type=StringSchema(
        "Source type for tracking. Default 'chat' when agent creates it.",
        enum=["manual", "email", "chat", "note"],
    ),
    evidence=StringSchema(
        "Optional evidence snippet from the source (for suggestions). "
        "Helps the user understand why the AI suggested this.",
    ),
    confidence=NumberSchema(
        "Confidence score 0..1 for AI-suggested todos.",
    ),
    required=["action"],
)


@tool_parameters(_TODO_PARAMETERS)
class TodoTool(Tool, ContextAware):
    """Tool to manage user's todo inbox items."""

    def __init__(self, todo_service: Any, default_timezone: str = "UTC"):
        self._svc = todo_service
        self._default_timezone = default_timezone
        self._channel: str = ""
        self._chat_id: str = ""
        self._session_key: str | None = None
        self._message_id: str | None = None

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.todo_service is not None

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(todo_service=ctx.todo_service, default_timezone=ctx.timezone)

    def set_context(self, ctx: RequestContext) -> None:
        self._channel = ctx.channel
        self._chat_id = ctx.chat_id
        self._session_key = ctx.session_key
        self._message_id = ctx.message_id

    @property
    def name(self) -> str:
        return "todo"

    @property
    def description(self) -> str:
        return (
            "Manage the user's unified todo inbox: add tasks, suggest items extracted "
            "from conversation, list/filter, update, and mark complete. "
            "Actions: add, suggest, list, update, complete. "
            "Use 'suggest' (not 'add') when you notice the user committed to something "
            "but they haven't explicitly asked you to track it — the user will confirm. "
            f"Naive ISO times default to {self._default_timezone}."
        )

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        errors = super().validate_params(params)
        action = params.get("action")
        if action in ("add", "suggest"):
            if not str(params.get("title") or "").strip():
                errors.append(f"title is required when action='{action}'")
        elif action in ("update", "complete"):
            if not str(params.get("item_id") or "").strip():
                errors.append(f"item_id is required when action='{action}'")
        rank = params.get("focus_rank")
        if rank is not None and rank not in (1, 2, 3):
            errors.append("focus_rank must be 1, 2 or 3")
        return errors

    async def execute(
        self,
        action: str,
        title: str | None = None,
        notes: str = "",
        bucket: str | None = None,
        due_at: str | None = None,
        priority: str | None = None,
        focus_rank: int | None = None,
        item_id: str | None = None,
        state: str | None = None,
        source_type: str = "chat",
        evidence: str | None = None,
        confidence: float | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            if action == "add":
                return await self._add(
                    title, notes, bucket, due_at, priority, source_type, evidence
                )
            elif action == "suggest":
                return await self._suggest(
                    title, notes, due_at, priority, evidence, confidence
                )
            elif action == "list":
                return await self._list(bucket, state)
            elif action == "update":
                return await self._update(
                    item_id, title, notes, bucket, due_at, priority, focus_rank, state
                )
            elif action == "complete":
                return await self._complete(item_id)
            return f"Unknown action: {action}"
        except TodoServiceUnavailableError as exc:
            return f"Error: {exc}"

    def _parse_iso_to_ms(self, iso_str: str | None) -> tuple[int | None, str | None]:
        if not iso_str:
            return None, None
        try:
            dt = datetime.fromisoformat(iso_str)
        except ValueError:
            return None, f"invalid ISO datetime format '{iso_str}'"
        if dt.tzinfo is None:
            try:
                dt = dt.replace(tzinfo=ZoneInfo(self._default_timezone))
            except Exception:
                return None, f"unknown timezone '{self._default_timezone}'"
        return int(dt.timestamp() * 1000), None

    def _build_source_locator(self, source_type: str) -> dict[str, Any]:
        """Build source locator for agent-created todos."""
        if source_type == "chat":
            loc: dict[str, Any] = {}
            if self._session_key:
                loc["sessionKey"] = self._session_key
            if self._message_id:
                loc["messageId"] = self._message_id
            return loc
        return {}

    def _build_source_snapshot(
        self, title: str, evidence: str | None, source_type: str
    ) -> dict[str, str]:
        snap: dict[str, str] = {"title": title}
        if evidence:
            snap["evidence"] = evidence[:240]
        if source_type == "chat":
            snap["source"] = "对话"
        return snap

    async def _add(
        self,
        title: str | None,
        notes: str,
        bucket: str | None,
        due_at: str | None,
        priority: str | None,
        source_type: str,
        evidence: str | None,
    ) -> str:
        if not title:
            return "Error: title is required for add"
        due_ms, err = self._parse_iso_to_ms(due_at)
        if err:
            return f"Error: {err}"
        item = TodoItem(
            id=create_todo_id(),
            title=title,
            created_at_ms=0,
            updated_at_ms=0,
            state="open",
            bucket=bucket or "inbox",
            notes=notes or "",
            due_at_ms=due_ms,
            priority=priority or "normal",
            source_type=source_type,
            source_locator=self._build_source_locator(source_type),
            source_snapshot=self._build_source_snapshot(title, evidence, source_type),
        )
        try:
            saved = await self._svc.add_item(item)
            bucket_label = saved.bucket
            due_label = f", due {due_at}" if due_at else ""
            return (
                f"Added todo '{saved.title}' (id: {saved.id}, bucket: {bucket_label}"
                f"{due_label})"
            )
        except Exception as exc:
            logger.exception("Todo add failed")
            return f"Error: {exc}"

    async def _suggest(
        self,
        title: str | None,
        notes: str,
        due_at: str | None,
        priority: str | None,
        evidence: str | None,
        confidence: float | None,
    ) -> str:
        """Create a suggestion (state=suggestion) for the user to confirm."""
        if not title:
            return "Error: title is required for suggest"
        due_ms, err = self._parse_iso_to_ms(due_at)
        if err:
            return f"Error: {err}"
        item = TodoItem(
            id=create_todo_id(),
            title=title,
            created_at_ms=0,
            updated_at_ms=0,
            state="suggestion",
            bucket="inbox",
            notes=notes or "",
            due_at_ms=due_ms,
            priority=priority or "normal",
            source_type="chat",
            confidence=confidence,
            source_locator=self._build_source_locator("chat"),
            source_snapshot=self._build_source_snapshot(title, evidence, "chat"),
        )
        try:
            saved = await self._svc.add_item(item)
            return (
                f"Suggested todo '{saved.title}' (id: {saved.id}). "
                f"User will see it in the inbox for confirmation."
            )
        except Exception as exc:
            logger.exception("Todo suggest failed")
            return f"Error: {exc}"

    async def _list(self, bucket: str | None, state: str | None) -> str:
        items = await self._svc.list_items(
            state=state or "open",
            bucket=bucket,
        )
        if not items:
            return "No todos match."
        lines = []
        for it in items:
            due_label = ""
            if it.due_at_ms:
                dt = datetime.fromtimestamp(it.due_at_ms / 1000)
                due_label = f", due {dt.isoformat()}"
            prio_label = f", {it.priority}" if it.priority != "normal" else ""
            focus_label = f", focus={it.focus_rank}" if it.focus_rank else ""
            lines.append(
                f"- {it.title} (id: {it.id}, {it.bucket}{due_label}{prio_label}{focus_label})"
            )
        return f"Todos ({len(items)}):\n" + "\n".join(lines)

    async def _update(
        self,
        item_id: str | None,
        title: str | None,
        notes: str | None,
        bucket: str | None,
        due_at: str | None,
        priority: str | None,
        focus_rank: int | None,
        state: str | None,
    ) -> str:
        if not item_id:
            return "Error: item_id is required for update"
        existing = await self._svc.get_item(item_id)
        if existing is None:
            return f"Error: todo {item_id} not found"
        patch: dict[str, Any] = {}
        if title is not None:
            patch["title"] = title
        if notes is not None:
            patch["notes"] = notes
        if bucket is not None:
            patch["bucket"] = bucket
        if due_at is not None:
            due_ms, err = self._parse_iso_to_ms(due_at)
            if err:
                return f"Error: {err}"
            patch["dueAtMs"] = due_ms
        if priority is not None:
            patch["priority"] = priority
        if focus_rank is not None:
            patch["focusRank"] = focus_rank
        if state is not None:
            patch["state"] = state
        try:
            saved = await self._svc.update_item(item_id, patch)
            return f"Updated todo '{saved.title}' (id: {saved.id})"
        except Exception as exc:
            logger.exception("Todo update failed")
            return f"Error: {exc}"

    async def _complete(self, item_id: str | None) -> str:
        if not item_id:
            return "Error: item_id is required for complete"
        try:
            saved = await self._svc.update_item(item_id, {"state": "done"})
            return f"Completed todo '{saved.title}' (id: {saved.id})"
        except KeyError:
            return f"Error: todo {item_id} not found"
        except Exception as exc:
            logger.exception("Todo complete failed")
            return f"Error: {exc}"
