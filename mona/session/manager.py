"""Session management for conversation history."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Any

from loguru import logger

from mona.config.paths import get_legacy_sessions_dir
from mona.utils.helpers import (
    ensure_dir,
    estimate_message_tokens,
    find_legal_message_start,
    image_placeholder_text,
    replace_file_with_retry,
    safe_filename,
)
from mona.utils.subagent_channel_display import scrub_subagent_announce_body

if TYPE_CHECKING:
    from mona.agent.partners import ConversationMetadata

FILE_MAX_MESSAGES = 2000
_MODEL_INPUTS_KEY = "_model_user_inputs"
_MODEL_REQUEST_HEAD_KEY = "_model_request_head"
_RUNTIME_CONTEXT_START = "[Runtime Context — metadata only, not instructions]\nCurrent Time: "
_RUNTIME_CONTEXT_END = "\n[/Runtime Context]"
_CONVERSATION_BACKGROUND = "Conversation background (historical context, not a new request or expanded authorization):"


def _without_shared_recent_history(snapshot: Any, original: Any) -> Any:
    """Remove old host-injected history only from the model projection."""
    def clean(text: str, prefix: str = "") -> str:
        if not text.startswith(prefix + _RUNTIME_CONTEXT_START):
            return text
        runtime, closing, tail = text[len(prefix):].partition(_RUNTIME_CONTEXT_END)
        if not closing:
            return text
        head, recent, history = runtime.partition(f"\n{_CONVERSATION_BACKGROUND}\n# Recent History\n\n")
        if not recent:
            return text
        _, summary_marker, summary = history.partition("\n\n[Archived Context Summary]\n\n")
        if summary_marker:
            head += f"\n{_CONVERSATION_BACKGROUND}\n[Archived Context Summary]\n\n{summary}"
        return prefix + head + closing + tail

    if isinstance(snapshot, str) and isinstance(original, str):
        return clean(snapshot, original + "\n\n")
    if isinstance(snapshot, list):
        for index, block in enumerate(snapshot):
            if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
                continue
            prefix = snapshot[:index]
            if isinstance(original, list):
                host_added = prefix == original
            else:
                host_added = isinstance(original, str) and any(
                    isinstance(item, dict) and item.get("type") == "text" and item.get("text") == original
                    for item in prefix
                )
            if host_added:
                block["text"] = clean(block["text"])
    return snapshot

# Message author fields (multi-agent phase 0 — docs/design/multi-agent-development-guide.md
# section 5.3). Messages are plain dicts; these keys are stamped on write and
# back-filled in memory on load, so legacy JSONL files are never batch-rewritten.
AUTHOR_TYPE_USER = "user"
AUTHOR_TYPE_AGENT = "agent"
AUTHOR_TYPE_SYSTEM = "system"
MESSAGE_TYPE_MESSAGE = "message"

_AUTHOR_TYPE_BY_ROLE = {
    "user": AUTHOR_TYPE_USER,
    "assistant": AUTHOR_TYPE_AGENT,
    "system": AUTHOR_TYPE_SYSTEM,
    "tool": AUTHOR_TYPE_AGENT,
}


def normalize_message_author(message: dict[str, Any]) -> dict[str, Any]:
    """Back-fill author fields on a message dict in place; returns the message.

    New authors pass ``author_type`` / ``author_id`` / ``message_type``
    explicitly via ``Session.add_message`` kwargs; legacy messages without
    them map assistant/tool roles to the reserved Mona agent, matching the
    pre-multi-agent single-author reality. Present values are never
    overwritten, so newer schema values survive a round-trip untouched.
    """
    from mona.agent.partners import MONA_AGENT_ID  # lazy: breaks the agent->session cycle

    author_type = message.get("author_type")
    if not isinstance(author_type, str) or not author_type:
        author_type = _AUTHOR_TYPE_BY_ROLE.get(str(message.get("role") or ""))
        if author_type:
            message["author_type"] = author_type
    if message.get("author_type") == AUTHOR_TYPE_AGENT:
        author_id = message.get("author_id")
        if not isinstance(author_id, str) or not author_id:
            message["author_id"] = MONA_AGENT_ID
    message_type = message.get("message_type")
    if not isinstance(message_type, str) or not message_type:
        message["message_type"] = MESSAGE_TYPE_MESSAGE
    return message


_MESSAGE_TIME_PREFIX_RE = re.compile(r"^\[Message Time: [^\]]+\]\n?")
_LOCAL_IMAGE_BREADCRUMB_RE = re.compile(r"^\[image: (?:/|~)[^\]]+\]\s*$")
_TOOL_CALL_ECHO_RE = re.compile(r'^\s*(?:generate_image|message)\([^)]*\)\s*$')
_SESSION_PREVIEW_MAX_CHARS = 120


def _sanitize_assistant_replay_text(content: str) -> str:
    """Remove internal replay artifacts that the model may have copied before.

    These strings are useful as runtime/session metadata, but when they appear
    in assistant examples they become demonstrations for the model to repeat.
    """
    content = _MESSAGE_TIME_PREFIX_RE.sub("", content, count=1)
    lines = [
        line
        for line in content.splitlines()
        if not _LOCAL_IMAGE_BREADCRUMB_RE.match(line)
        and not _TOOL_CALL_ECHO_RE.match(line)
    ]
    return "\n".join(lines).strip()


def _text_preview(content: Any) -> str:
    """Return compact display text for session lists."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                value = block.get("text")
                if isinstance(value, str):
                    parts.append(value)
        text = " ".join(parts)
    else:
        return ""
    text = _sanitize_assistant_replay_text(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > _SESSION_PREVIEW_MAX_CHARS:
        text = text[: _SESSION_PREVIEW_MAX_CHARS - 1].rstrip() + "…"
    return text


def _message_preview_text(message: dict[str, Any]) -> str:
    """Session list preview text; subagent inject blobs are shortened for display."""
    content: Any = message.get("content")
    if message.get("injected_event") == "subagent_result" and isinstance(content, str):
        content = scrub_subagent_announce_body(content)
    return _text_preview(content)


# IM list summary cache (IM plan 12.2): persisted inside session metadata so
# ``/api/sessions`` never replays transcripts to find the last visible message.
UI_SUMMARY_SCHEMA_VERSION = 1
_UI_SUMMARY_KEY = "ui_summary"

_IMAGE_PREVIEW_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif", ".avif",
})


def _media_preview_text(media: Any) -> str:
    """Localized placeholder summary for attachments, e.g. "[图片]" / "[文件] 报告.pdf"."""
    if not isinstance(media, list):
        return ""
    parts: list[str] = []
    for raw in media:
        if not isinstance(raw, str) or not raw.strip():
            continue
        name = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
        suffix = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if f".{suffix}" in _IMAGE_PREVIEW_SUFFIXES:
            placeholder = "[图片]"
        else:
            placeholder = f"[文件] {name}" if name else "[文件]"
        if placeholder not in parts:
            parts.append(placeholder)
    return " ".join(parts)


def build_ui_summary(message: dict[str, Any]) -> dict[str, Any] | None:
    """Build the cached session-list summary from one persisted message.

    Only user-visible content may feed the IM list preview (IM plan 10.5):
    user text/media and agent final text are eligible; system prompts, tool
    results, reasoning/thinking, trace lines and protocol-only records never
    become previews. Subagent announce blobs are scrubbed to their
    user-readable job summary by ``_message_preview_text``.
    """
    if message.get("_command") or message.get("_ui_only"):
        return None
    if message.get("role") not in ("user", "assistant"):
        return None
    text = _message_preview_text(message)
    if not text:
        text = _media_preview_text(message.get("media"))
    if not text:
        return None
    timestamp = message.get("timestamp")
    return {
        "schema_version": UI_SUMMARY_SCHEMA_VERSION,
        "preview": text,
        "preview_at": timestamp if isinstance(timestamp, str) else None,
        "preview_author_type": message.get("author_type"),
        "preview_author_id": message.get("author_id"),
        "preview_message_type": message.get("message_type") or MESSAGE_TYPE_MESSAGE,
    }


def _valid_ui_summary(value: Any) -> dict[str, Any] | None:
    """Return the cached summary dict when present and on the current schema."""
    if (
        isinstance(value, dict)
        and value.get("schema_version") == UI_SUMMARY_SCHEMA_VERSION
        and isinstance(value.get("preview"), str)
        and value["preview"]
    ):
        return value
    return None


@dataclass
class Session:
    """A conversation session."""

    key: str  # channel:chat_id
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    last_consolidated: int = 0  # Number of messages already consolidated to files

    @property
    def conversation_metadata(self) -> ConversationMetadata:
        """Conversation shape for this session (multi-agent phase 0, guide 5.2).

        Legacy sessions without ``metadata["conversation"]`` map to a Mona
        direct chat. The stored payload is validated on read but never
        rewritten here, so old JSONL files stay untouched until the normal
        save path runs.
        """
        from mona.agent.partners import conversation_from_session_metadata

        return conversation_from_session_metadata(self.metadata)

    @staticmethod
    def _annotate_message_time(message: dict[str, Any], content: Any) -> Any:
        """Expose persisted turn timestamps to the model for relative-date reasoning.

        Annotating *every* assistant turn trains the model (via in-context
        demonstrations) to start its own replies with the same
        ``[Message Time: ...]`` prefix, which leaks metadata back to the user.
        We therefore only annotate user turns. User-side stamps are enough to
        pin adjacent assistant replies for relative-time reasoning, including
        proactive messages the user replies to later.
        """
        timestamp = message.get("timestamp")
        if not timestamp or not isinstance(content, str):
            return content
        role = message.get("role")
        if role != "user":
            return content
        return f"[Message Time: {timestamp}]\n{content}"

    def add_message(self, role: str, content: str, **kwargs: Any) -> None:
        """Add a message to the session."""
        msg = {
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat(),
            **kwargs
        }
        normalize_message_author(msg)
        self.messages.append(msg)
        self.updated_at = datetime.now()
        self.update_ui_summary(msg)

    def remember_model_input(self, message: dict[str, Any], content: Any) -> None:
        """Keep the model projection separate from the original user message."""
        if message.get("role") == "user" and message.get("timestamp"):
            self.metadata.setdefault(_MODEL_INPUTS_KEY, {})[message["timestamp"]] = copy.deepcopy(content)

    def update_ui_summary(self, message: dict[str, Any]) -> None:
        """Refresh the cached IM list summary from a newly persisted message.

        Shared write path (IM plan 12.2): every user-visible message entering
        the session funnels through here so callers never duplicate preview
        logic. Non-visible messages leave the cache untouched.
        """
        summary = build_ui_summary(message)
        if summary is not None:
            self.metadata[_UI_SUMMARY_KEY] = summary

    def ui_summary(self) -> dict[str, Any]:
        """Return the cached IM list summary; legacy sessions fall back to scanning.

        Sessions saved before the cache existed derive the summary from their
        last user-visible message; the result is cached in memory here and
        persisted by the next normal save.
        """
        cached = _valid_ui_summary(self.metadata.get(_UI_SUMMARY_KEY))
        if cached is not None:
            return cached
        for message in reversed(self.messages):
            summary = build_ui_summary(message)
            if summary is not None:
                self.metadata[_UI_SUMMARY_KEY] = summary
                return summary
        return {}

    def get_history(
        self,
        max_messages: int = 0,
        *,
        max_tokens: int = 0,
        include_timestamps: bool = False,
        model_view: bool = False,
    ) -> list[dict[str, Any]]:
        """Return unconsolidated messages for LLM input.

        Replay the full legal history unless the caller explicitly requests
        a message-count or token limit. Zero means no limit.
        """
        unconsolidated = self.messages[self.last_consolidated:]
        sliced = unconsolidated[-max_messages:] if max_messages > 0 else unconsolidated

        # Avoid starting mid-turn when possible, except for proactive
        # assistant deliveries that the user may be replying to.
        for i, message in enumerate(sliced):
            if message.get("role") == "user":
                start = i
                if i > 0 and sliced[i - 1].get("_channel_delivery"):
                    start = i - 1
                sliced = sliced[start:]
                break

        # Drop orphan tool results at the front.
        start = find_legal_message_start(sliced)
        if start:
            sliced = sliced[start:]

        out: list[dict[str, Any]] = []
        for message in sliced:
            if message.get("_command"):
                continue
            snapshots = self.metadata.get(_MODEL_INPUTS_KEY, {}) if model_view else {}
            snapshot = snapshots.get(message.get("timestamp")) if message.get("role") == "user" else None
            content = copy.deepcopy(snapshot) if snapshot is not None else message.get("content", "")
            if snapshot is not None:
                content = _without_shared_recent_history(content, message.get("content", ""))
            role = message.get("role")
            if role == "assistant" and isinstance(content, str):
                content = _sanitize_assistant_replay_text(content)
            # Synthesize an ``[image: path]`` breadcrumb from the persisted
            # ``media`` kwarg so LLM replay still sees *something* where the
            # image used to be. Without this, an image-only user turn
            # replays as an empty user message — the assistant's reply then
            # looks like it's responding to nothing.
            media = message.get("media")
            if snapshot is None and role == "user" and isinstance(media, list) and media and isinstance(content, str):
                breadcrumbs = "\n".join(
                    image_placeholder_text(p) for p in media if isinstance(p, str) and p
                )
                content = f"{content}\n{breadcrumbs}" if content else breadcrumbs
            if include_timestamps and snapshot is None:
                content = self._annotate_message_time(message, content)
            if role == "assistant" and isinstance(content, str) and not content.strip():
                if not any(key in message for key in ("tool_calls", "reasoning_content", "thinking_blocks")):
                    continue
            entry: dict[str, Any] = {"role": message["role"], "content": content}
            for key in ("tool_calls", "tool_call_id", "name", "reasoning_content", "thinking_blocks"):
                if key in message:
                    entry[key] = message[key]
            out.append(entry)

        if max_tokens > 0 and out:
            kept: list[dict[str, Any]] = []
            used = 0
            for message in reversed(out):
                tokens = estimate_message_tokens(message)
                if kept and used + tokens > max_tokens:
                    break
                kept.append(message)
                used += tokens
            kept.reverse()

            # Keep history aligned to the first visible user turn.
            first_user = next((i for i, m in enumerate(kept) if m.get("role") == "user"), None)
            if first_user is not None:
                kept = kept[first_user:]
            else:
                # Tight token budgets can otherwise leave assistant-only tails.
                # If a user turn exists in the unsliced output, recover the
                # nearest one even if it slightly exceeds the token budget.
                recovered_user = next(
                    (i for i in range(len(out) - 1, -1, -1) if out[i].get("role") == "user"),
                    None,
                )
                if recovered_user is not None:
                    kept = out[recovered_user:]

            # And keep a legal tool-call boundary at the front.
            start = find_legal_message_start(kept)
            if start:
                kept = kept[start:]
            out = kept
        return out

    def clear(self) -> None:
        """Clear all messages and reset session to initial state."""
        self.messages = []
        self.last_consolidated = 0
        self.updated_at = datetime.now()
        self.metadata.pop("_last_summary", None)
        self.metadata.pop("_shared_room_summary", None)
        self.metadata.pop(_MODEL_INPUTS_KEY, None)
        self.metadata.pop(_MODEL_REQUEST_HEAD_KEY, None)
        self.metadata.pop(_UI_SUMMARY_KEY, None)

    def retain_recent_legal_suffix(self, max_messages: int) -> None:
        """Keep a legal recent suffix constrained by a hard message cap."""
        if max_messages <= 0:
            self.clear()
            return
        if len(self.messages) <= max_messages:
            return

        retained = list(self.messages[-max_messages:])

        # Prefer starting at a user turn when one exists within the tail.
        first_user = next((i for i, m in enumerate(retained) if m.get("role") == "user"), None)
        if first_user is not None:
            retained = retained[first_user:]
        else:
            # If the tail is assistant/tool-only, anchor to the latest user in
            # the full session and take a capped forward window from there.
            latest_user = next(
                (i for i in range(len(self.messages) - 1, -1, -1)
                 if self.messages[i].get("role") == "user"),
                None,
            )
            if latest_user is not None:
                retained = list(self.messages[latest_user: latest_user + max_messages])

        # Mirror get_history(): avoid persisting orphan tool results at the front.
        start = find_legal_message_start(retained)
        if start:
            retained = retained[start:]

        # Hard-cap guarantee: never keep more than max_messages.
        if len(retained) > max_messages:
            retained = retained[-max_messages:]
            start = find_legal_message_start(retained)
            if start:
                retained = retained[start:]

        dropped = len(self.messages) - len(retained)
        self.messages = retained
        self.last_consolidated = max(0, self.last_consolidated - dropped)
        self.updated_at = datetime.now()

    def enforce_file_cap(
        self,
        on_archive: Any = None,
        limit: int = FILE_MAX_MESSAGES,
    ) -> None:
        """Reclaim summarized prefixes without evicting unconsolidated history."""
        if limit <= 0 or len(self.messages) <= limit:
            return
        # Only reclaim summarized prefixes; message count cannot evict an active goal.
        if len(self.messages) - self.last_consolidated > limit:
            return

        before = list(self.messages)
        before_last_consolidated = self.last_consolidated
        before_count = len(before)
        self.retain_recent_legal_suffix(limit)
        dropped_count = before_count - len(self.messages)
        if dropped_count <= 0:
            return

        dropped = before[:dropped_count]
        already_consolidated = min(before_last_consolidated, dropped_count)
        archive_chunk = dropped[already_consolidated:]
        if archive_chunk and on_archive:
            on_archive(archive_chunk)
        logger.info(
            "Session file cap hit for {}: dropped {}, raw-archived {}, kept {}",
            self.key,
            dropped_count,
            len(archive_chunk),
            len(self.messages),
        )


class SessionDeletedError(RuntimeError):
    """A late write attempted to recreate a permanently deleted conversation."""


class SessionSaveError(OSError):
    """Conversation persistence failed; already completed tools must not be replayed."""


class SessionLoadError(OSError):
    """Existing history could not be recovered and must not be overwritten."""


class SessionManager:
    """
    Manages conversation sessions.

    Sessions are stored as JSONL files in the sessions directory.
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.sessions_dir = ensure_dir(self.workspace / "sessions")
        self.legacy_sessions_dir = get_legacy_sessions_dir()
        self._cache: dict[str, Session] = {}
        self._deleted_keys: set[str] = set()
        # Legacy files without a persisted UI summary need one transcript scan
        # the first time they appear in the list. Keep that result for the
        # unchanged file so repeated sidebar refreshes stay metadata-only.
        self._list_summary_cache: dict[Path, tuple[int, int, dict[str, Any]]] = {}
        self._list_summary_cache_path = self.sessions_dir / ".list-summaries.json"
        self._list_summary_generation = object()
        self._persisted_list_summary_generation = self._list_summary_generation
        self._list_summary_persist_lock = Lock()
        self._load_list_summaries()

    def _load_list_summaries(self) -> None:
        if not self._list_summary_cache_path.exists():
            return
        try:
            payload = json.loads(self._list_summary_cache_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or payload.get("schema_version") != 1:
                raise ValueError("unsupported summary cache schema")
            entries = payload.get("sessions")
            if not isinstance(entries, dict):
                raise ValueError("invalid summary cache entries")
            for name, entry in entries.items():
                if not isinstance(name, str) or Path(name).name != name or not name.endswith(".jsonl"):
                    continue
                if not isinstance(entry, dict):
                    continue
                mtime, size, summary = entry.get("mtime_ns"), entry.get("size"), entry.get("summary")
                if type(mtime) is not int or type(size) is not int or mtime < 0 or size < 0:
                    continue
                if summary != {} and _valid_ui_summary(summary) is None:
                    continue
                self._list_summary_cache[self.sessions_dir / name] = (mtime, size, summary)
        except (OSError, ValueError) as exc:
            logger.warning("Session list summary cache unavailable ({}); rebuilding", type(exc).__name__)

    def _remember_list_summary(
        self, path: Path, signature: tuple[int, int], summary: dict[str, Any],
    ) -> None:
        value = (signature[0], signature[1], summary)
        if self._list_summary_cache.get(path) != value:
            self._list_summary_cache[path] = value
            self._list_summary_generation = object()

    def persist_list_summaries(self) -> None:
        """Persist only derived previews; never rewrite conversation files."""
        with self._list_summary_persist_lock:
            if self._persisted_list_summary_generation is self._list_summary_generation:
                return
            generation = self._list_summary_generation
            snapshot = dict(self._list_summary_cache)
            entries = {}
            for path, (mtime, size, summary) in snapshot.items():
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                if (stat.st_mtime_ns, stat.st_size) == (mtime, size):
                    entries[path.name] = {"mtime_ns": mtime, "size": size, "summary": summary}
            temporary: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=self.sessions_dir,
                    prefix=".list-summaries-", suffix=".tmp", delete=False,
                ) as stream:
                    temporary = Path(stream.name)
                    json.dump({"schema_version": 1, "sessions": entries}, stream, ensure_ascii=False)
                temporary.replace(self._list_summary_cache_path)
                self._persisted_list_summary_generation = generation
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

    @staticmethod
    def safe_key(key: str) -> str:
        """Public helper used by HTTP handlers to map an arbitrary key to a stable filename stem."""
        if len(key) <= 180 and re.fullmatch(r"[a-z0-9-]+:[a-z0-9_.-]+", key):
            return key.replace(":", "_")
        return "~s-" + hashlib.sha256(key.encode("utf-8")).hexdigest()

    @staticmethod
    def legacy_safe_key(key: str) -> str:
        return safe_filename(key.replace(":", "_"))

    @staticmethod
    def _stored_session_key(path: Path) -> str | None:
        try:
            with open(path, encoding="utf-8") as stream:
                for line in stream:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict) and record.get("_type") == "metadata":
                        return record.get("key")
        except (OSError, UnicodeError) as exc:
            raise SessionLoadError("Conversation history could not be read; the original file was preserved") from exc
        return None

    def _get_session_path(self, key: str) -> Path:
        """Resolve one session, migrating only legacy files with proven ownership."""
        path = self.sessions_dir / f"{self.safe_key(key)}.jsonl"
        if path.exists():
            stored_key = self._stored_session_key(path)
            if stored_key is not None and stored_key != key:
                raise SessionLoadError("Conversation history belongs to a different session; the original file was preserved")
            if stored_key is None and key.startswith("websocket:"):
                from mona.webui.transcript import ensure_transcript_owner

                ensure_transcript_owner(key, path)
            return path
        legacy_name = self.legacy_safe_key(key) + ".jsonl"
        sources = (self.sessions_dir / legacy_name, self.legacy_sessions_dir / legacy_name) if len(legacy_name) <= 240 else ()
        for source in sources:
            if source == path or not source.exists():
                continue
            stored_key = self._stored_session_key(source)
            if stored_key is None:
                raise SessionLoadError("Legacy conversation ownership could not be verified; the original file was preserved")
            if stored_key != key:
                continue
            from mona.webui.thread_disk import migrate_legacy_webui_thread

            try:
                migrate_legacy_webui_thread(key)
                shutil.move(str(source), str(path))
            except OSError as exc:
                raise SessionLoadError("Conversation history could not be migrated; the original files were preserved") from exc
            break
        if key.startswith("websocket:"):
            from mona.webui.transcript import ensure_transcript_owner

            ensure_transcript_owner(key, path)
        return path

    def _get_legacy_session_path(self, key: str) -> Path:
        """Legacy global session path (~/.mona/sessions/)."""
        return self.legacy_sessions_dir / f"{self.legacy_safe_key(key)}.jsonl"

    def get_or_create(self, key: str) -> Session:
        """
        Get an existing session or create a new one.

        Args:
            key: Session key (usually channel:chat_id).

        Returns:
            The session.
        """
        if key in self._deleted_keys:
            raise SessionDeletedError("Session has been permanently deleted")
        if key in self._cache:
            return self._cache[key]

        session = self._load(key)
        if session is None:
            session = Session(key=key)

        self._cache[key] = session
        return session

    def _load(self, key: str) -> Session | None:
        """Load a session from disk."""
        path = self._get_session_path(key)
        if not path.exists():
            return None

        try:
            messages = []
            metadata = {}
            created_at = None
            updated_at = None
            last_consolidated = 0

            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue

                    data = json.loads(line)

                    if data.get("_type") == "metadata":
                        if data.get("key") not in (None, key):
                            raise SessionLoadError("Conversation history belongs to a different session")
                        metadata = data.get("metadata", {})
                        if not isinstance(metadata, dict):
                            raise ValueError("Invalid session metadata")
                        created_at = datetime.fromisoformat(data["created_at"]) if data.get("created_at") else None
                        updated_at = datetime.fromisoformat(data["updated_at"]) if data.get("updated_at") else None
                        last_consolidated = data.get("last_consolidated", 0)
                    else:
                        messages.append(data)

            for message in messages:
                normalize_message_author(message)

            return Session(
                key=key,
                messages=messages,
                created_at=created_at or datetime.now(),
                updated_at=updated_at or datetime.now(),
                metadata=metadata,
                last_consolidated=last_consolidated
            )
        except Exception as e:
            logger.warning("Failed to load session {}: {}", key, e)
            repaired = self._repair(key)
            if repaired is not None:
                logger.info("Recovered session {} from corrupt file ({} messages)", key, len(repaired.messages))
            elif path.exists():
                raise SessionLoadError("Conversation history could not be read; the original file was preserved") from e
            return repaired

    def _repair(self, key: str) -> Session | None:
        """Attempt to recover a session from a corrupt JSONL file."""
        path = self._get_session_path(key)
        if not path.exists():
            return None

        try:
            messages: list[dict[str, Any]] = []
            metadata: dict[str, Any] = {}
            created_at: datetime | None = None
            updated_at: datetime | None = None
            last_consolidated = 0
            skipped = 0

            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        skipped += 1
                        continue

                    if not isinstance(data, dict):
                        skipped += 1
                        continue
                    if data.get("_type") == "metadata":
                        if data.get("key") not in (None, key):
                            raise SessionLoadError("Conversation history belongs to a different session")
                        if not isinstance(data.get("metadata", {}), dict):
                            skipped += 1
                            continue
                        metadata = data.get("metadata", {})
                        if data.get("created_at"):
                            with suppress(ValueError, TypeError):
                                created_at = datetime.fromisoformat(data["created_at"])
                        if data.get("updated_at"):
                            with suppress(ValueError, TypeError):
                                updated_at = datetime.fromisoformat(data["updated_at"])
                        last_consolidated = data.get("last_consolidated", 0)
                    else:
                        messages.append(data)

            if skipped:
                logger.warning("Skipped {} corrupt lines in session {}", skipped, key)

            if not messages and not metadata:
                return None

            for message in messages:
                normalize_message_author(message)

            return Session(
                key=key,
                messages=messages,
                created_at=created_at or datetime.now(),
                updated_at=updated_at or datetime.now(),
                metadata=metadata,
                last_consolidated=last_consolidated
            )
        except Exception as e:
            logger.warning("Repair failed for session {}: {}", key, e)
            return None

    @staticmethod
    def _session_payload(session: Session) -> dict[str, Any]:
        return {
            "key": session.key,
            "created_at": session.created_at.isoformat(),
            "updated_at": session.updated_at.isoformat(),
            "metadata": {
                key: value for key, value in session.metadata.items()
                if key not in (_MODEL_INPUTS_KEY, _MODEL_REQUEST_HEAD_KEY)
            },
            "messages": session.messages,
        }

    def save(self, session: Session, *, fsync: bool = False) -> None:
        """Save a session to disk atomically.

        When *fsync* is ``True`` the final file and its parent directory are
        explicitly flushed to durable storage.  This is intentionally off by
        default (the OS page-cache is sufficient for normal operation) but
        should be enabled during graceful shutdown so that filesystems with
        write-back caching (e.g. rclone VFS, NFS, FUSE mounts) do not lose
        the most recent writes.
        """
        if session.key in self._deleted_keys:
            raise SessionDeletedError("Session has been permanently deleted")
        if session.last_consolidated >= len(session.messages):
            session.metadata.pop(_MODEL_REQUEST_HEAD_KEY, None)
        if _MODEL_INPUTS_KEY in session.metadata:
            retained = {
                message.get("timestamp") for message in session.messages[session.last_consolidated:]
                if message.get("role") == "user"
            }
            session.metadata[_MODEL_INPUTS_KEY] = {
                key: value for key, value in session.metadata[_MODEL_INPUTS_KEY].items() if key in retained
            }
        path = self._get_session_path(session.key)
        tmp_path: Path | None = None

        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=path.parent,
                prefix=f".{path.name}.", suffix=".tmp", delete=False,
            ) as f:
                tmp_path = Path(f.name)
                metadata_line = {
                    "_type": "metadata",
                    "key": session.key,
                    "created_at": session.created_at.isoformat(),
                    "updated_at": session.updated_at.isoformat(),
                    "metadata": session.metadata,
                    "last_consolidated": session.last_consolidated
                }
                f.write(json.dumps(metadata_line, ensure_ascii=False) + "\n")
                for msg in session.messages:
                    f.write(json.dumps(msg, ensure_ascii=False) + "\n")
                if fsync:
                    f.flush()
                    os.fsync(f.fileno())

            replace_file_with_retry(tmp_path, path)

            if fsync:
                # fsync the directory so the rename is durable.
                # On Windows, opening a directory with O_RDONLY raises
                # PermissionError — skip the dir sync there (NTFS
                # journals metadata synchronously).
                with suppress(PermissionError):
                    fd = os.open(str(path.parent), os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
        except OSError as exc:
            raise SessionSaveError("Conversation history could not be saved") from exc
        finally:
            if tmp_path is not None:
                with suppress(OSError):
                    tmp_path.unlink(missing_ok=True)

        self._cache[session.key] = session
        try:
            stat = path.stat()
        except OSError:
            self._list_summary_cache.pop(path, None)
        else:
            # Cache the in-memory summary after the atomic replace. This also
            # avoids rescanning a legacy session that was saved without a
            # visible message (and therefore still has no persisted summary).
            summary = session.ui_summary()
            self._remember_list_summary(path, (stat.st_mtime_ns, stat.st_size), summary)
            if not summary:
                try:
                    with self._list_summary_persist_lock:
                        self._list_summary_cache_path.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning("Session list summary cache could not be invalidated ({})", type(exc).__name__)
                self._list_summary_generation = object()

    def flush_all(self) -> int:
        """Re-save every cached session with fsync for durable shutdown.

        Returns the number of sessions flushed.  Errors on individual
        sessions are logged but do not prevent other sessions from being
        flushed.
        """
        flushed = 0
        for key, session in list(self._cache.items()):
            try:
                self.save(session, fsync=True)
                flushed += 1
            except Exception:
                logger.warning("Failed to flush session {}", key, exc_info=True)
        return flushed

    def invalidate(self, key: str) -> None:
        """Remove a session from the in-memory cache."""
        self._cache.pop(key, None)
        self._list_summary_cache.pop(self.sessions_dir / f"{self.safe_key(key)}.jsonl", None)
        self._list_summary_generation = object()

    def delete_session(self, key: str, *, prevent_recreation: bool = False) -> bool:
        """Remove a session from disk and the in-memory cache.

        Returns True if a JSONL file was found and unlinked.
        """
        if prevent_recreation:
            self._deleted_keys.add(key)
        path = self._get_session_path(key)
        with self._list_summary_persist_lock:
            self.invalidate(key)
            try:
                self._list_summary_cache_path.unlink(missing_ok=True)
                if not path.exists():
                    return False
                path.unlink()
                return True
            except OSError as e:
                logger.warning("Failed to delete session file {}: {}", path, e)
                if prevent_recreation:
                    raise
                return False

    def read_session_file(self, key: str) -> dict[str, Any] | None:
        """Load a session from disk without caching; intended for read-only HTTP endpoints.

        Returns ``{"key", "created_at", "updated_at", "metadata", "messages"}`` or
        ``None`` when the session file does not exist. Unrecoverable files raise.
        """
        path = self._get_session_path(key)
        if not path.exists():
            return None
        try:
            messages: list[dict[str, Any]] = []
            metadata: dict[str, Any] = {}
            created_at: str | None = None
            updated_at: str | None = None
            stored_key: str | None = None
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    data = json.loads(line)
                    if data.get("_type") == "metadata":
                        if data.get("key") not in (None, key):
                            raise SessionLoadError("Conversation history belongs to a different session")
                        metadata = data.get("metadata", {})
                        if not isinstance(metadata, dict):
                            raise ValueError("Invalid session metadata")
                        created_at = data.get("created_at")
                        updated_at = data.get("updated_at")
                        stored_key = data.get("key")
                    else:
                        messages.append(data)
            for message in messages:
                normalize_message_author(message)
            return {
                "key": stored_key or key,
                "created_at": created_at,
                "updated_at": updated_at,
                "metadata": {
                    key: value for key, value in metadata.items()
                    if key not in (_MODEL_INPUTS_KEY, _MODEL_REQUEST_HEAD_KEY)
                },
                "messages": messages,
            }
        except Exception as e:
            logger.warning("Failed to read session {}: {}", key, e)
            repaired = self._repair(key)
            if repaired is not None:
                logger.info("Recovered read-only session view {} from corrupt file", key)
                return self._session_payload(repaired)
            if path.exists():
                raise SessionLoadError("Conversation history could not be read; the original file was preserved") from e
            return None

    def list_sessions(self) -> list[dict[str, Any]]:
        """
        List all sessions.

        Returns:
            List of session info dicts.
        """
        sessions = []

        for path in self.sessions_dir.glob("*.jsonl"):
            fallback_key = path.stem.replace("_", ":", 1)
            try:
                stat = path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                # Read the metadata line and the IM summary for WebUI/session lists.
                with open(path, encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if first_line:
                        data = json.loads(first_line)
                        if data.get("_type") == "metadata":
                            key = data.get("key") or path.stem.replace("_", ":", 1)
                            fallback_key = key
                            metadata = data.get("metadata", {})
                            if not isinstance(metadata, dict):
                                metadata = {}
                            title = metadata.get("title")
                            summary = _valid_ui_summary(metadata.get(_UI_SUMMARY_KEY))
                            if summary is None:
                                cached = self._list_summary_cache.get(path)
                                if cached is not None and cached[:2] == signature:
                                    summary = cached[2]
                                else:
                                    # Legacy session without a cached summary:
                                    # scan for the LAST user-visible message
                                    # (IM plan 12.2 fallback). Cache even an
                                    # empty result so sessions with no visible
                                    # messages do not get rescanned.
                                    summary = {}
                                    for line in f:
                                        if not line.strip():
                                            continue
                                        item = json.loads(line)
                                        if item.get("_type") == "metadata":
                                            continue
                                        normalize_message_author(item)
                                        candidate = build_ui_summary(item)
                                        if candidate is not None:
                                            summary = candidate
                                    self._remember_list_summary(path, signature, summary)
                            else:
                                self._remember_list_summary(path, signature, summary)
                            summary = summary or {}
                            row = {
                                "key": key,
                                "created_at": data.get("created_at"),
                                "updated_at": data.get("updated_at"),
                                "title": title if isinstance(title, str) else "",
                                "preview": summary.get("preview", ""),
                                "preview_at": summary.get("preview_at"),
                                "preview_author_type": summary.get("preview_author_type"),
                                "preview_author_id": summary.get("preview_author_id"),
                                "preview_message_type": summary.get("preview_message_type"),
                                "workspace": metadata.get("workspace"),
                                "agent_kind": metadata.get("agent_kind"),
                                "path": str(path)
                            }
                            # Multi-agent conversation shape (phase 2d): stored
                            # as a camelCase ``to_session_metadata()`` dump;
                            # absent on legacy sessions, which the UI treats as
                            # a direct chat with Mona.
                            conversation = metadata.get("conversation")
                            if isinstance(conversation, dict):
                                row["conversation"] = conversation
                            sessions.append(row)
            except Exception:
                repaired = self._repair(fallback_key)
                if repaired is not None:
                    summary = repaired.ui_summary()
                    sessions.append({
                        "key": repaired.key,
                        "created_at": repaired.created_at.isoformat(),
                        "updated_at": repaired.updated_at.isoformat(),
                        "title": (
                            repaired.metadata.get("title")
                            if isinstance(repaired.metadata.get("title"), str)
                            else ""
                        ),
                        "preview": summary.get("preview", ""),
                        "preview_at": summary.get("preview_at"),
                        "preview_author_type": summary.get("preview_author_type"),
                        "preview_author_id": summary.get("preview_author_id"),
                        "preview_message_type": summary.get("preview_message_type"),
                        "workspace": repaired.metadata.get("workspace"),
                        "agent_kind": repaired.metadata.get("agent_kind"),
                        "path": str(path)
                    })
                continue

        # IM list ordering (IM plan 12.1): sort by the last visible message
        # time, falling back to the session timestamps for legacy rows.
        return sorted(
            sessions,
            key=lambda x: x.get("preview_at") or x.get("updated_at") or x.get("created_at") or "",
            reverse=True,
        )
