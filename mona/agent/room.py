"""Room context resolution and routing helpers.

Multi-agent phase 2 (docs/design/multi-agent-development-guide.md section
7.5). Pure functions over ``ConversationMetadata`` and raw session message
dicts:

- parse conversation metadata from a session;
- validate agent membership in a room;
- resolve structured ``@Agent`` targets (never fuzzy display-name matching);
- project the shared room history for one viewing agent, adding author
  labels (e.g. ``[A股分析师]``) for the model without touching the stored
  UI originals.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable, Mapping

from mona.agent.partners import (
    MONA_AGENT_ID,
    AgentRegistry,
    ConversationMetadata,
    conversation_from_session_metadata,
    normalize_agent_id,
)

if TYPE_CHECKING:
    from mona.session.manager import Session

# Message types that may enter the shared model-visible history. Job/run
# status cards and approval cards are UI projections of the job/run files —
# the model reads state from those files, not from card text (guide 6.3).
_SHAREABLE_MESSAGE_TYPES = frozenset({"message"})

_DEFAULT_MAX_MESSAGES = 50


class RoomError(ValueError):
    """Base error for room routing/validation failures."""


class RoomMembershipError(RoomError):
    """Raised when an agent is not a member of the room."""


class NotARoomError(RoomError):
    """Raised when a conversation is not a collaboration room."""


def resolve_conversation(session: Session | Mapping[str, Any] | None) -> ConversationMetadata:
    """Parse conversation metadata from a Session or a metadata mapping.

    Legacy sessions without the key resolve to a Mona direct chat; see
    :func:`conversation_from_session_metadata`.
    """
    metadata = getattr(session, "metadata", session)
    return conversation_from_session_metadata(metadata)


def require_room(conversation: ConversationMetadata) -> ConversationMetadata:
    """Return the conversation when it is a room, else raise NotARoomError."""
    if conversation.type != "room":
        raise NotARoomError(
            f"conversation is a {conversation.type} chat, not a collaboration room"
        )
    return conversation


def is_room_member(conversation: ConversationMetadata, agent_id: str) -> bool:
    try:
        normalized = normalize_agent_id(agent_id)
    except ValueError:
        return False
    return normalized in conversation.agent_ids


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
    if max_messages <= 0:
        max_messages = _DEFAULT_MAX_MESSAGES
    projected: list[dict[str, Any]] = []
    for message in messages[-max_messages:]:
        if message.get("_ui_only") or message.get("injected_event"):
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
    return projected
