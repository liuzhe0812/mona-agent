"""Room context resolution and routing helpers.

Multi-agent phase 2 (docs/design/multi-agent-development-guide.md section
7.5). Pure functions over ``ConversationMetadata`` and raw session message
dicts:

- validate agent membership in a room;
- resolve structured ``@Agent`` targets (never fuzzy display-name matching);
- project the shared room history for one viewing agent, adding author
  labels (e.g. ``[A股分析师]``) for the model without touching the stored
  UI originals.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable

from mona.agent.partners import (
    MONA_AGENT_ID,
    AgentRegistry,
    ConversationMetadata,
    normalize_agent_id,
)
from mona.agent.tools.base import Tool, tool_parameters

# Message types that may enter the shared model-visible history. Job/run
# status cards and approval cards are UI projections of the job/run files —
# the model reads state from those files, not from card text (guide 6.3).
_SHAREABLE_MESSAGE_TYPES = frozenset({"message"})

_DEFAULT_MAX_MESSAGES = 50


def shared_context_ref(scope: str, text: str) -> str:
    return f"{scope}:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


class RoomContextSnapshot(str):
    """Prompt preview carrying its immutable, public-only source documents."""

    sources: dict[str, str]

    def __new__(cls, preview: str, sources: dict[str, str]) -> RoomContextSnapshot:
        snapshot = super().__new__(cls, preview)
        snapshot.sources = dict(sources)
        return snapshot


@tool_parameters({
    "type": "object",
    "properties": {
        "reference": {"type": "string", "description": "Exact reference from this job's shared context."},
        "offset": {"type": "integer", "minimum": 0, "default": 0},
        "limit": {"type": "integer", "minimum": 1, "maximum": 8000, "default": 8000},
    },
    "required": ["reference"],
    "additionalProperties": False,
})
class CollaborationReadTool(Tool):
    """Read only the public documents explicitly handed to this job."""

    name = "collaboration_read"
    description = (
        "Read a page of the complete room context or upstream result using a reference "
        "from this job's context. Sources stay fixed at job start; offsets count characters."
    )
    read_only = True
    system_managed = True
    _plugin_discoverable = False

    def __init__(self, sources: dict[str, str]):
        self._sources = dict(sources)

    async def execute(self, reference: str, offset: int = 0, limit: int = 8000, **kwargs: Any) -> str:
        if not isinstance(reference, str):
            return "Error: reference must be a string."
        text = self._sources.get(reference)
        if text is None:
            return "Error: This reference was not shared with the current job."
        if type(offset) is not int or type(limit) is not int or offset < 0 or not 1 <= limit <= 8000:
            return "Error: offset must be nonnegative and limit must be between 1 and 8000."
        if offset > len(text):
            return "Error: offset exceeds the source length."
        end = min(len(text), offset + limit)
        return json.dumps({
            "reference": reference,
            "offset": offset,
            "total_chars": len(text),
            "content": text[offset:end],
            "complete": end == len(text),
            "next_offset": end if end < len(text) else None,
        }, ensure_ascii=False)


class RoomError(ValueError):
    """Base error for room routing/validation failures."""


class RoomMembershipError(RoomError):
    """Raised when an agent is not a member of the room."""


class NotARoomError(RoomError):
    """Raised when a conversation is not a collaboration room."""


def require_room(conversation: ConversationMetadata) -> ConversationMetadata:
    """Return the conversation when it is a room, else raise NotARoomError."""
    if conversation.type != "room":
        raise NotARoomError(
            f"conversation is a {conversation.type} chat, not a collaboration room"
        )
    return conversation


def require_room_member(conversation: ConversationMetadata, agent_id: str) -> str:
    """Validate room membership; returns the normalized agent ID."""
    normalized = normalize_agent_id(agent_id)
    if normalized not in conversation.agent_ids:
        raise RoomMembershipError(
            f"agent {normalized!r} is not a member of this room "
            f"(members: {', '.join(conversation.agent_ids)})"
        )
    return normalized


def resolve_target_agents(
    conversation: ConversationMetadata,
    target_agent_ids: Iterable[str] | None,
) -> list[str]:
    """Validate structured ``@Agent`` targets against room membership.

    The frontend ``@`` picker produces agent IDs; the backend never trusts
    display names and re-validates every ID (guide 7.5). Returns the
    normalized, de-duplicated target list (empty when no targets given).
    """
    if not target_agent_ids:
        return []
    require_room(conversation)
    targets: list[str] = []
    for raw in target_agent_ids:
        normalized = require_room_member(conversation, raw)
        if normalized not in targets:
            targets.append(normalized)
    return targets


def author_label(agent_id: str, registry: AgentRegistry | None = None) -> str:
    """Human label for an agent author (display name, falling back to the ID)."""
    if registry is not None:
        definition = registry.get(agent_id)
        if definition is not None:
            return definition.display_name
    return agent_id


def project_history_for_agent(
    messages: list[dict[str, Any]],
    *,
    viewer_agent_id: str,
    registry: AgentRegistry | None = None,
    max_messages: int = _DEFAULT_MAX_MESSAGES,
) -> list[dict[str, Any]]:
    """Project shared room history for the viewing agent's model input.

    - Only user-readable messages are shared (guide 5.3): tool traces,
      UI-only events, status cards and internal injections are excluded.
    - Assistant messages authored by *other* agents get an author label
      prefix (``[display name]``) so the model can tell speakers apart.
    - The stored message dicts are never modified; new dicts are returned.
    """
    viewer = normalize_agent_id(viewer_agent_id)
    projected: list[dict[str, Any]] = []
    # Filter internal/tool records before applying the cap. Session history
    # can contain many tool calls between two visible turns; slicing first
    # would otherwise hide the older shared messages that matter to the room.
    for message in messages:
        if (
            message.get("_ui_only") or message.get("_command") or message.get("injected_event")
            or message.get("source_kind") == "runtime"
            or message.get("_runtime_input") or message.get("_input_cancelled")
        ):
            continue
        message_type = message.get("message_type") or "message"
        if message_type not in _SHAREABLE_MESSAGE_TYPES:
            continue
        role = message.get("role")
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        if role == "user":
            projected.append({"role": "user", "content": content})
            continue
        if role != "assistant" or message.get("tool_calls"):
            continue
        author = message.get("author_id") or MONA_AGENT_ID
        if author == viewer:
            projected.append({"role": "assistant", "content": content})
        else:
            label = author_label(author, registry)
            projected.append({"role": "assistant", "content": f"[{label}] {content}"})
    return projected[-max_messages:] if max_messages > 0 else projected
