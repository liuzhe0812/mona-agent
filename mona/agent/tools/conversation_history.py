"""Read-only tools for keyword search over previous visible conversations."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from mona.session.conversation_history import ConversationHistoryStore


def _enabled(ctx: Any) -> bool:
    config = getattr(ctx.config, "conversation_history", None)
    return bool(config is None or getattr(config, "enabled", True))


class _ConversationHistoryTool(Tool):
    _scopes = {"core"}
    system_managed = True

    def __init__(self, workspace: str, agent_id: str, sessions: Any) -> None:
        self._store = ConversationHistoryStore(Path(workspace), agent_id, sessions)

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return _enabled(ctx) and ctx.sessions is not None

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(ctx.workspace, ctx.agent_id, ctx.sessions)

    @property
    def read_only(self) -> bool:
        return True

    @property
    def concurrency_safe(self) -> bool:
        # A read may refresh the derived FTS index before returning results.
        return False


class ConversationSearchTool(_ConversationHistoryTool):
    @property
    def name(self) -> str:
        return "conversation_search"

    @property
    def description(self) -> str:
        return (
            "Search visible messages from this Agent's previous desktop chats using "
            "literal keyword matching only. Use it when the user refers to an earlier "
            "conversation. Results may report partial coverage."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            query=StringSchema(
                "Concrete keywords, phrase, path, number, version, or date to find.",
                min_length=1,
                max_length=500,
            ),
            limit=IntegerSchema(
                5,
                description="Maximum matches (default 5, maximum 20).",
                minimum=1,
                maximum=20,
            ),
            cursor=StringSchema(
                "Opaque pagination cursor returned by a previous search."
            ),
            session_key=StringSchema(
                "Optional exact session key to narrow the search."
            ),
            date_from=StringSchema("Optional inclusive ISO date or timestamp."),
            date_to=StringSchema("Optional inclusive ISO date or timestamp."),
            required=["query"],
        )

    async def execute(
        self,
        query: str | None = None,
        limit: int = 5,
        cursor: str | None = None,
        session_key: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        **_: Any,
    ) -> str:
        try:
            result = await asyncio.to_thread(
                self._store.search,
                query or "",
                limit=limit,
                cursor=cursor,
                session_key=session_key,
                date_from=date_from,
                date_to=date_to,
            )
        except ValueError as exc:
            result = {"status": "error", "error": str(exc)}
        except (OSError, sqlite3.Error):
            result = {"status": "unavailable", "error": "conversation index unavailable"}
        return json.dumps(result, ensure_ascii=False, indent=2)


class ConversationReadTool(_ConversationHistoryTool):
    @property
    def name(self) -> str:
        return "conversation_read"

    @property
    def description(self) -> str:
        return (
            "Read a conversation_search reference with nearby user and assistant "
            "messages. Use the returned pagination cursor when the text is truncated."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            ref=StringSchema(
                "Reference returned by conversation_search.", min_length=1
            ),
            before=IntegerSchema(
                2,
                description="Messages before the match (default 2, maximum 5).",
                minimum=0,
                maximum=5,
            ),
            after=IntegerSchema(
                2,
                description="Messages after the match (default 2, maximum 5).",
                minimum=0,
                maximum=5,
            ),
            max_chars=IntegerSchema(
                8_000,
                description="Maximum characters per page (1000-16000).",
                minimum=1_000,
                maximum=16_000,
            ),
            cursor=StringSchema(
                "Opaque pagination cursor returned by a previous read."
            ),
            required=["ref"],
        )

    async def execute(
        self,
        ref: str | None = None,
        before: int = 2,
        after: int = 2,
        max_chars: int = 8_000,
        cursor: str | None = None,
        **_: Any,
    ) -> str:
        try:
            result = await asyncio.to_thread(
                self._store.read,
                ref or "",
                before=before,
                after=after,
                max_chars=max_chars,
                cursor=cursor,
            )
        except ValueError as exc:
            result = {"status": "error", "error": str(exc)}
        except (OSError, sqlite3.Error):
            result = {"status": "unavailable", "error": "conversation index unavailable"}
        return json.dumps(result, ensure_ascii=False, indent=2)
