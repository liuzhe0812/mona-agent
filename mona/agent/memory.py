"""Memory system: pure file I/O store, lightweight Consolidator, and Dream processor."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import time
import weakref
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterator

from loguru import logger

from mona.agent.memory_versions import migrate_legacy_memory_versions, write_text_atomic
from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.registry import ToolRegistry
from mona.session.manager import Session
from mona.utils.helpers import (
    estimate_message_tokens,
    estimate_prompt_tokens_chain,
    strip_think,
    truncate_text,
)
from mona.utils.prompt_templates import persona_content, render_template

if TYPE_CHECKING:
    from mona.providers.base import LLMProvider
    from mona.session.manager import SessionManager


# ---------------------------------------------------------------------------
# MemoryStore — pure file I/O layer
# ---------------------------------------------------------------------------

class MemoryStore:
    """Pure file I/O for memory files: MEMORY.md, history.jsonl, SOUL.md, USER.md."""

    _DEFAULT_MAX_HISTORY = 1000
    _LEGACY_ENTRY_START_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*")
    _LEGACY_TIMESTAMP_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*")
    _LEGACY_RAW_MESSAGE_RE = re.compile(
        r"^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:"
    )

    def __init__(
        self,
        workspace: Path,
        max_history_entries: int = _DEFAULT_MAX_HISTORY,
        *,
        agent_id: str = MONA_AGENT_ID,
    ):
        from mona.config.paths import get_agent_memory_dir
        self.workspace = workspace
        self.agent_id = normalize_agent_id(agent_id)
        self.max_history_entries = max_history_entries
        # Memory files live OUTSIDE workspace for hard boundary, under the
        # agent-private dir (~/.mona/agents/<agent_id>/memory/) so each agent
        # gets isolated long-term memory (multi-agent phase 1).
        # Legacy USER/AGENTS files stay available for migration.
        self.memory_dir = get_agent_memory_dir(self.agent_id)
        self.memory_file = self.memory_dir / "MEMORY.md"
        self.history_file = self.memory_dir / "history.jsonl"
        self.legacy_history_file = self.memory_dir / "HISTORY.md"
        self.soul_file = self.memory_dir / "SOUL.md"
        self.user_file = self.memory_dir / "USER.md"
        self.agents_file = self.memory_dir / "AGENTS.md"
        self._cursor_file = self.memory_dir / ".cursor"
        self._dream_cursor_file = self.memory_dir / ".dream_cursor"
        self._corruption_logged = False  # rate-limit non-int cursor warning
        self._oversize_logged = False  # rate-limit oversized-entry warning
        migrate_legacy_memory_versions(
            self.memory_dir,
            {"SOUL.md": self.read_soul(), "MEMORY.md": self.read_memory()},
        )
        self._maybe_migrate_legacy_history()

    # -- generic helpers -----------------------------------------------------

    @staticmethod
    def read_file(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def _maybe_migrate_legacy_history(self) -> None:
        """One-time upgrade from legacy HISTORY.md to history.jsonl.

        The migration is best-effort and prioritizes preserving as much content
        as possible over perfect parsing.
        """
        if not self.legacy_history_file.exists():
            return
        if self.history_file.exists() and self.history_file.stat().st_size > 0:
            return

        try:
            legacy_text = self.legacy_history_file.read_text(
                encoding="utf-8",
                errors="replace",
            )
        except OSError:
            logger.exception("Failed to read legacy HISTORY.md for migration")
            return

        entries = self._parse_legacy_history(legacy_text)
        try:
            if entries:
                self._write_entries(entries)
                last_cursor = entries[-1]["cursor"]
                self._cursor_file.write_text(str(last_cursor), encoding="utf-8")
                # Default to "already processed" so upgrades do not replay the
                # user's entire historical archive into Dream on first start.
                self._dream_cursor_file.write_text(str(last_cursor), encoding="utf-8")

            backup_path = self._next_legacy_backup_path()
            self.legacy_history_file.replace(backup_path)
            logger.info(
                "Migrated legacy HISTORY.md to history.jsonl ({} entries)",
                len(entries),
            )
        except Exception:
            logger.exception("Failed to migrate legacy HISTORY.md")

    def _parse_legacy_history(self, text: str) -> list[dict[str, Any]]:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            return []

        fallback_timestamp = self._legacy_fallback_timestamp()
        entries: list[dict[str, Any]] = []
        chunks = self._split_legacy_history_chunks(normalized)

        for cursor, chunk in enumerate(chunks, start=1):
            timestamp = fallback_timestamp
            content = chunk
            match = self._LEGACY_TIMESTAMP_RE.match(chunk)
            if match:
                timestamp = match.group(1)
                remainder = chunk[match.end():].lstrip()
                if remainder:
                    content = remainder

            entries.append({
                "cursor": cursor,
                "timestamp": timestamp,
                "content": content,
            })
        return entries

    def _split_legacy_history_chunks(self, text: str) -> list[str]:
        lines = text.split("\n")
        chunks: list[str] = []
        current: list[str] = []
        saw_blank_separator = False

        for line in lines:
            if saw_blank_separator and line.strip() and current:
                chunks.append("\n".join(current).strip())
                current = [line]
                saw_blank_separator = False
                continue
            if self._should_start_new_legacy_chunk(line, current):
                chunks.append("\n".join(current).strip())
                current = [line]
                saw_blank_separator = False
                continue
            current.append(line)
            saw_blank_separator = not line.strip()

        if current:
            chunks.append("\n".join(current).strip())
        return [chunk for chunk in chunks if chunk]

    def _should_start_new_legacy_chunk(self, line: str, current: list[str]) -> bool:
        if not current:
            return False
        if not self._LEGACY_ENTRY_START_RE.match(line):
            return False
        if self._is_raw_legacy_chunk(current) and self._LEGACY_RAW_MESSAGE_RE.match(line):
            return False
        return True

    def _is_raw_legacy_chunk(self, lines: list[str]) -> bool:
        first_nonempty = next((line for line in lines if line.strip()), "")
        match = self._LEGACY_TIMESTAMP_RE.match(first_nonempty)
        if not match:
            return False
        return first_nonempty[match.end():].lstrip().startswith("[RAW]")

    def _legacy_fallback_timestamp(self) -> str:
        try:
            return datetime.fromtimestamp(
                self.legacy_history_file.stat().st_mtime,
            ).strftime("%Y-%m-%d %H:%M")
        except OSError:
            return datetime.now().strftime("%Y-%m-%d %H:%M")

    def _next_legacy_backup_path(self) -> Path:
        candidate = self.memory_dir / "HISTORY.md.bak"
        suffix = 2
        while candidate.exists():
            candidate = self.memory_dir / f"HISTORY.md.bak.{suffix}"
            suffix += 1
        return candidate

    # -- MEMORY.md (long-term facts) -----------------------------------------

    def read_memory(self) -> str:
        return self.read_file(self.memory_file)

    def write_memory(self, content: str) -> None:
        self._write_instruction("memory", content)

    # -- SOUL.md -------------------------------------------------------------

    def read_soul(self) -> str:
        return persona_content(self.read_file(self.soul_file), self.read_file(self.agents_file))

    def write_soul(self, content: str) -> None:
        self._write_instruction("soul", content)

    def previous_file(self, key: str) -> Path:
        path = {"soul": self.soul_file, "memory": self.memory_file}[key]
        return path.with_name(path.name + ".previous")

    def read_previous(self, key: str) -> str | None:
        try:
            return self.previous_file(key).read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def _write_instruction(self, key: str, content: str) -> None:
        path = self.soul_file if key == "soul" else self.memory_file
        current = self.read_soul() if key == "soul" else self.read_memory()
        has_legacy_rules = key == "soul" and bool(self.read_file(self.agents_file))
        if path.exists() and current == content and not has_legacy_rules:
            return
        backup_needed = current != content and (path.exists() or has_legacy_rules)
        old_previous = self.read_previous(key) if backup_needed else None
        if backup_needed:
            write_text_atomic(self.previous_file(key), current)
        try:
            write_text_atomic(path, content)
        except Exception:
            if backup_needed:
                if old_previous is None:
                    self.previous_file(key).unlink(missing_ok=True)
                else:
                    write_text_atomic(self.previous_file(key), old_previous)
            raise
        if has_legacy_rules:
            write_text_atomic(self.agents_file, "")

    # -- USER.md -------------------------------------------------------------

    def read_user(self) -> str:
        return self.read_file(self.user_file)

    def write_user(self, content: str) -> None:
        self.user_file.write_text(content, encoding="utf-8")

    # -- context injection (used by context.py) ------------------------------

    def get_memory_context(self) -> str:
        long_term = self.read_memory()
        return f"## Long-term Memory\n{long_term}" if long_term else ""

    # -- history.jsonl — append-only, JSONL format ---------------------------

    def append_history(self, entry: str, *, max_chars: int | None = None) -> int:
        """Append *entry* to history.jsonl and return its auto-incrementing cursor.

        Entries are passed through `strip_think` to drop template-level leaks
        (e.g. unclosed `<think` prefixes, `<channel|>` markers) before being
        persisted. If the cleaned content is empty but the raw entry wasn't,
        the record is persisted with an empty string rather than falling back
        to the raw leak — otherwise `strip_think`'s guarantees would be
        undone by history replay / consolidation downstream.

        A defensive cap (*max_chars*, default ``_HISTORY_ENTRY_HARD_CAP``) is
        applied as a final safety net: individual callers should cap their own
        content more tightly; this default only exists to catch unintentional
        large writes (e.g. an LLM echoing its input back as a "summary").
        """
        limit = max_chars if max_chars is not None else _HISTORY_ENTRY_HARD_CAP
        cursor = self._next_cursor()
        ts = datetime.now().strftime("%Y-%m-%d %H:%M")
        raw = entry.rstrip()
        if len(raw) > limit:
            if not self._oversize_logged:
                self._oversize_logged = True
                logger.warning(
                    "history entry exceeds {} chars ({}); truncating. "
                    "Usually means a caller forgot its own cap; "
                    "further occurrences suppressed.",
                    limit, len(raw),
                )
            raw = truncate_text(raw, limit)
        content = strip_think(raw)
        if raw and not content:
            logger.debug(
                "history entry {} stripped to empty (likely template leak); "
                "persisting empty content to avoid re-polluting context",
                cursor,
            )
        record = {"cursor": cursor, "timestamp": ts, "content": content}
        with open(self.history_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._cursor_file.write_text(str(cursor), encoding="utf-8")
        return cursor

    @staticmethod
    def _valid_cursor(value: Any) -> int | None:
        """Int cursors only — reject bool (``isinstance(True, int)`` is True)."""
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value

    def _iter_valid_entries(self) -> Iterator[tuple[dict[str, Any], int]]:
        """Yield ``(entry, cursor)`` for entries with int cursors; warn once on corruption."""
        poisoned: Any = None
        for entry in self._read_entries():
            raw = entry.get("cursor")
            if raw is None:
                continue
            cursor = self._valid_cursor(raw)
            if cursor is None:
                poisoned = raw
                continue
            yield entry, cursor
        if poisoned is not None and not self._corruption_logged:
            self._corruption_logged = True
            logger.warning(
                "history.jsonl contains a non-int cursor ({!r}); dropping it. "
                "Usually caused by an external writer; further occurrences suppressed.",
                poisoned,
            )

    def _next_cursor(self) -> int:
        """Read the current cursor counter and return the next value."""
        if self._cursor_file.exists():
            with suppress(ValueError, OSError):
                return int(self._cursor_file.read_text(encoding="utf-8").strip()) + 1
        # Fast path: trust the tail when intact.  Otherwise scan the whole
        # file and take ``max`` — that stays correct even if the monotonic
        # invariant was broken by external writes.
        last = self._read_last_entry() or {}
        cursor = self._valid_cursor(last.get("cursor"))
        if cursor is not None:
            return cursor + 1
        return max((c for _, c in self._iter_valid_entries()), default=0) + 1

    def read_unprocessed_history(self, since_cursor: int) -> list[dict[str, Any]]:
        """Return history entries with a valid cursor > *since_cursor*."""
        return [e for e, c in self._iter_valid_entries() if c > since_cursor]

    def compact_history(self) -> None:
        """Drop oldest entries if the file exceeds *max_history_entries*."""
        if self.max_history_entries <= 0:
            return
        entries = self._read_entries()
        if len(entries) <= self.max_history_entries:
            return
        kept = entries[-self.max_history_entries:]
        self._write_entries(kept)

    # -- JSONL helpers -------------------------------------------------------

    def _read_entries(self) -> list[dict[str, Any]]:
        """Read all entries from history.jsonl."""
        entries: list[dict[str, Any]] = []
        with suppress(FileNotFoundError):
            with open(self.history_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue

        return entries

    def _read_last_entry(self) -> dict[str, Any] | None:
        """Read the last entry from the JSONL file efficiently."""
        try:
            with open(self.history_file, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                if size == 0:
                    return None
                read_size = min(size, 4096)
                f.seek(size - read_size)
                data = f.read().decode("utf-8")
                lines = [line for line in data.split("\n") if line.strip()]
                if not lines:
                    return None
                return json.loads(lines[-1])
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _write_entries(self, entries: list[dict[str, Any]]) -> None:
        """Overwrite history.jsonl with the given entries (atomic write)."""
        tmp_path = self.history_file.with_suffix(self.history_file.suffix + ".tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                for entry in entries:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.history_file)

            # fsync the directory so the rename is durable.
            # On Windows, opening a directory with O_RDONLY raises
            # PermissionError — skip the dir sync there (NTFS
            # journals metadata synchronously).
            with suppress(PermissionError):
                fd = os.open(str(self.history_file.parent), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    # -- dream cursor --------------------------------------------------------

    def get_last_dream_cursor(self) -> int:
        if self._dream_cursor_file.exists():
            with suppress(ValueError, OSError):
                return int(self._dream_cursor_file.read_text(encoding="utf-8").strip())
        return 0

    def set_last_dream_cursor(self, cursor: int) -> None:
        self._dream_cursor_file.write_text(str(cursor), encoding="utf-8")

    # -- message formatting utility ------------------------------------------

    @staticmethod
    def _format_messages(messages: list[dict]) -> str:
        lines = []
        for message in messages:
            if not message.get("content"):
                continue
            tools = f" [tools: {', '.join(message['tools_used'])}]" if message.get("tools_used") else ""
            lines.append(
                f"[{message.get('timestamp', '?')[:16]}] {message['role'].upper()}{tools}: {message['content']}"
            )
        return "\n".join(lines)

    def raw_archive(self, messages: list[dict], *, max_chars: int | None = None) -> None:
        """Fallback: dump raw messages to history.jsonl without LLM summarization."""
        limit = max_chars if max_chars is not None else _RAW_ARCHIVE_MAX_CHARS
        formatted = truncate_text(self._format_messages(messages), limit)
        self.append_history(
            f"[RAW] {len(messages)} messages\n"
            f"{formatted}"
        )
        logger.warning(
            "Memory consolidation degraded: raw-archived {} messages", len(messages)
        )



# ---------------------------------------------------------------------------
# Consolidator — lightweight token-budget triggered consolidation
# ---------------------------------------------------------------------------


# Individual history.jsonl writers cap their own payloads tightly; the
# _HISTORY_ENTRY_HARD_CAP at append_history() is a belt-and-suspenders default
# that catches any new caller that forgot to set its own cap.
_RAW_ARCHIVE_MAX_CHARS = 16_000       # fallback dump (LLM failed)
_ARCHIVE_SUMMARY_MAX_CHARS = 8_000    # LLM-produced consolidation summary
_HISTORY_ENTRY_HARD_CAP = 64_000      # emergency cap in append_history


class Consolidator:
    """Lightweight consolidation: summarizes evicted messages into history.jsonl."""

    _MAX_CONSOLIDATION_ROUNDS = 5
    _FAILURE_RETRY_DELAY_SECONDS = 60.0

    _SAFETY_BUFFER = 1024  # extra headroom for tokenizer estimation drift

    def __init__(
        self,
        store: MemoryStore,
        provider: LLMProvider,
        model: str,
        sessions: SessionManager,
        context_window_tokens: int,
        build_messages: Callable[..., list[dict[str, Any]]],
        get_tool_definitions: Callable[[], list[dict[str, Any]]],
        auto_compact_token_limit: int | None = None,
        context_block_limit: int | None = None,
        max_completion_tokens: int = 4096,
        consolidation_ratio: float = 0.2,
    ):
        self.store = store
        self.provider = provider
        self.model = model
        self.sessions = sessions
        self.context_window_tokens = context_window_tokens
        self.auto_compact_token_limit = auto_compact_token_limit
        self.context_block_limit = context_block_limit
        self.max_completion_tokens = max_completion_tokens
        self.consolidation_ratio = consolidation_ratio
        self._build_messages = build_messages
        self._get_tool_definitions = get_tool_definitions
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._retry_after: dict[str, float] = {}
        self._pending_room_summaries: dict[str, dict[str, Any]] = {}

    def set_provider(
        self,
        provider: LLMProvider,
        model: str,
        context_window_tokens: int,
        auto_compact_token_limit: int | None = None,
    ) -> None:
        if provider is not self.provider or model != self.model:
            self._retry_after.clear()
        self.provider = provider
        self.model = model
        self.context_window_tokens = context_window_tokens
        self.auto_compact_token_limit = auto_compact_token_limit
        self.max_completion_tokens = provider.generation.max_tokens

    def get_lock(self, session_key: str) -> asyncio.Lock:
        """Return the shared consolidation lock for one session."""
        return self._locks.setdefault(session_key, asyncio.Lock())

    def _prefix_route(self) -> str | None:
        from mona.providers.openai_compat_provider import OpenAICompatProvider

        provider = self.provider
        spec = getattr(provider, "spec", None)
        if not isinstance(provider, OpenAICompatProvider) or not spec or not spec.supports_prefix_compaction:
            return None
        base = provider._effective_base or spec.default_api_base
        if spec.backend != "mona_managed":
            default = spec.default_api_base.rstrip("/")
            if base.rstrip("/") not in {default, f"{default}/v1"}:
                return None
        return hashlib.sha256(f"{self.store.agent_id}\n{spec.name}\n{base}\n{self.model}".encode()).hexdigest()

    @staticmethod
    def _message_digest(message: dict[str, Any]) -> str:
        return hashlib.sha256(json.dumps(message, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def remember_request(self, session: Session, *, messages: list[dict], tools: list[dict]) -> None:
        route = self._prefix_route()
        if route is None or session.conversation_metadata.type == "room":
            return
        session.metadata["_model_request_head"] = {
            "route": route,
            "system": copy.deepcopy([message for message in messages if message.get("role") == "system"]),
            "tools": copy.deepcopy(tools),
            "history": [self._message_digest(message) for message in messages if message.get("role") != "system"],
        }

    def _prefix_archive_request(
        self, session: Session, messages: list[dict], previous_summary: str | None,
    ) -> tuple[list[dict], list[dict]] | None:
        head = session.metadata.get("_model_request_head")
        if not head or head.get("route") != self._prefix_route():
            return None
        projection = Session(key=session.key, messages=messages, metadata=session.metadata).get_history(
            include_timestamps=True, model_view=True,
        )
        digests = [self._message_digest(message) for message in projection]
        shared = min(len(digests), len(head["history"]))
        if not shared or digests[:shared] != head["history"][:shared]:
            return None
        instruction = render_template("agent/consolidator_archive.md", strip=True)
        instruction += "\n\nSummarize only the conversation above. Do not continue its tasks or call tools."
        if previous_summary:
            instruction += f"\n\nExisting handoff summary:\n{previous_summary}"
        return (
            [*copy.deepcopy(head["system"]), *projection, {"role": "user", "content": instruction}],
            copy.deepcopy(head["tools"]),
        )

    def pick_consolidation_boundary(
        self,
        session: Session,
        tokens_to_remove: int,
    ) -> tuple[int, int] | None:
        """Pick a user-turn boundary that removes enough old prompt tokens."""
        start = session.last_consolidated
        if start >= len(session.messages) or tokens_to_remove <= 0:
            return None

        removed_tokens = 0
        last_boundary: tuple[int, int] | None = None
        for idx in range(start, len(session.messages)):
            message = session.messages[idx]
            if idx > start and message.get("role") == "user":
                last_boundary = (idx, removed_tokens)
                if removed_tokens >= tokens_to_remove:
                    return last_boundary
            removed_tokens += estimate_message_tokens(message)

        return last_boundary

    @staticmethod
    def _full_unconsolidated_history(
        session: Session,
        *,
        include_timestamps: bool = False,
    ) -> list[dict[str, Any]]:
        """Return the whole unconsolidated tail for consolidation decisions."""
        unconsolidated_count = len(session.messages) - session.last_consolidated
        if unconsolidated_count <= 0:
            return []
        return session.get_history(
            max_messages=unconsolidated_count,
            include_timestamps=include_timestamps,
            model_view=include_timestamps,
        )

    def _persist_last_summary(
        self, session: Session, summary: str | None, *, last_active: datetime | None = None,
    ) -> None:
        if summary:
            previous_metadata = session.metadata.copy()
            session.metadata["_last_summary"] = {
                "text": summary,
                "last_active": (last_active or session.updated_at).isoformat(),
            }
            shared = self._pending_room_summaries.pop(session.key, None)
            if shared is not None and shared.pop("_private_summary") != summary:
                shared = None
            if shared is not None:
                session.metadata["_shared_room_summary"] = {
                    **shared, "through_cursor": session.last_consolidated,
                }
            try:
                self.sessions.save(session)
            except BaseException:
                session.metadata = previous_metadata
                raise

    @staticmethod
    def _summary_text(session: Session) -> str | None:
        meta = session.metadata.get("_last_summary")
        value = meta.get("text") if isinstance(meta, dict) else meta
        return value.strip() if isinstance(value, str) and value.strip() else None

    def estimate_session_prompt_tokens(
        self,
        session: Session,
        *,
        current_message: str = "[token-probe]",
        message_metadata: dict[str, Any] | None = None,
    ) -> tuple[int, str]:
        """Estimate prompt size from the full unconsolidated session tail."""
        history = self._full_unconsolidated_history(session, include_timestamps=True)
        channel, chat_id = (session.key.split(":", 1) if ":" in session.key else (None, None))
        # Include archived summary in estimation so the budget accounts for it.
        summary = self._summary_text(session)
        probe_messages = self._build_messages(
            history=history,
            current_message=current_message,
            channel=channel,
            chat_id=chat_id,
            sender_id=None,
            session_summary=summary,
            session_metadata=session.metadata,
            message_metadata=message_metadata,
        )
        return estimate_prompt_tokens_chain(
            self.provider,
            self.model,
            probe_messages,
            self._get_tool_definitions(),
        )

    @property
    def _input_token_budget(self) -> int:
        """Available input token budget for consolidation LLM."""
        model_budget = self.context_window_tokens - self.max_completion_tokens - self._SAFETY_BUFFER
        if self.context_block_limit is None:
            return model_budget
        return min(model_budget, self.context_block_limit)

    @property
    def _auto_compact_trigger_budget(self) -> int:
        hard_budget = self._input_token_budget
        configured = self.auto_compact_token_limit
        default_trigger = int(self.context_window_tokens * 0.8)
        trigger = configured if configured is not None else default_trigger
        return min(trigger, hard_budget)

    async def _archive_session(
        self,
        session: Session,
        messages: list[dict],
        *,
        previous_summary: str | None = None,
    ) -> str | None:
        provider, model = self.provider, self.model
        self._pending_room_summaries.pop(session.key, None)
        is_room = session.conversation_metadata.type == "room"
        if is_room:
            from mona.agent.room import project_history_for_agent

            previous_shared = session.metadata.get("_shared_room_summary")
            shared_text = previous_shared.get("text") if isinstance(previous_shared, dict) else None
            shared_text = shared_text if isinstance(shared_text, str) else None
            legacy_gap = previous_summary is not None and shared_text is None
            public_source = messages
            if legacy_gap:
                public_source = session.messages[:session.last_consolidated] + messages
            public_messages = project_history_for_agent(
                public_source, viewer_agent_id="room-context-viewer", max_messages=0,
            )
            summary = await self.archive(messages, previous_summary=previous_summary, persist=False)
            if summary:
                public_summary = (
                    await self.archive(public_messages, previous_summary=shared_text, persist=False)
                    if public_messages else shared_text or ""
                )
                if public_summary is None:
                    summary = None
                else:
                    shared = {
                        "text": public_summary,
                        "_private_summary": summary,
                        "through_timestamp": messages[-1].get("timestamp"),
                        "coverage": (
                            "retained_history" if legacy_gap
                            else previous_shared.get("coverage", "complete")
                            if isinstance(previous_shared, dict) else "complete"
                        ),
                    }
                    try:
                        self.store.append_history(summary, max_chars=_ARCHIVE_SUMMARY_MAX_CHARS)
                    except Exception as exc:
                        logger.warning("Room summary persistence failed (exception={})", type(exc).__name__)
                        summary = None
                    else:
                        self._pending_room_summaries[session.key] = shared
        else:
            prefix_request = self._prefix_archive_request(session, messages, previous_summary)
            summary = await self.archive(
                messages, previous_summary=previous_summary,
                **({"prefix_request": prefix_request} if prefix_request is not None else {}),
            )
        if provider is not self.provider or model != self.model:
            return summary
        if summary:
            self._retry_after.pop(session.key, None)
        else:
            self._retry_after[session.key] = time.monotonic() + self._FAILURE_RETRY_DELAY_SECONDS
        return summary

    async def archive(
        self,
        messages: list[dict],
        *,
        previous_summary: str | None = None,
        persist: bool = True,
        prefix_request: tuple[list[dict], list[dict]] | None = None,
    ) -> str | None:
        """Summarize messages via LLM and append to history.jsonl.

        Returns the summary text on success, None if nothing to archive.
        """
        if not messages:
            return None
        try:
            formatted = MemoryStore._format_messages(messages)
            if previous_summary:
                formatted = (
                    "Existing handoff summary:\n"
                    f"{previous_summary}\n\n"
                    "Newly archived conversation:\n"
                    f"{formatted}"
                )
            budget = self._input_token_budget
            if budget <= 0:
                logger.warning("Consolidation source exceeds its request budget")
                return None
            request_messages = [
                {"role": "system", "content": render_template("agent/consolidator_archive.md", strip=True)},
                {"role": "user", "content": formatted},
            ]
            tools = None
            estimated = 0
            if prefix_request is not None:
                estimated, _ = estimate_prompt_tokens_chain(self.provider, self.model, *prefix_request)
                if 0 < estimated <= budget:
                    request_messages, tools = prefix_request
                else:
                    estimated = 0
            if estimated <= 0:
                estimated, _ = estimate_prompt_tokens_chain(self.provider, self.model, request_messages, tools)
            if estimated <= 0 or estimated > budget:
                logger.warning("Consolidation request exceeds its input budget")
                return None
            response = await self.provider.chat_with_retry(
                model=self.model,
                messages=request_messages,
                tools=tools,
                tool_choice="none" if tools else None,
            )
            if response.finish_reason == "error":
                logger.warning(
                    "Consolidation LLM call failed (status={}, kind={}); preserving session history",
                    response.error_status_code,
                    response.error_kind,
                )
                return None
            if isinstance(response.tool_calls, list) and response.tool_calls:
                logger.warning("Consolidation returned tool calls instead of a handoff")
                return None
            summary = (response.content or "").strip()
            if not summary or summary == "(nothing)" or len(summary) > _ARCHIVE_SUMMARY_MAX_CHARS:
                logger.warning("Consolidation returned an unusable handoff summary")
                return None
            if persist:
                self.store.append_history(summary, max_chars=_ARCHIVE_SUMMARY_MAX_CHARS)
            return summary
        except Exception as exc:
            logger.warning(
                "Consolidation failed (exception={}); preserving session history",
                type(exc).__name__,
            )
            return None

    async def maybe_consolidate_by_tokens(
        self,
        session: Session,
        *,
        current_message: str | None = None,
        message_metadata: dict[str, Any] | None = None,
        on_compaction: Callable[[bool], Awaitable[None]] | None = None,
    ) -> int | None:
        """Loop: archive old messages until prompt fits within safe budget.

        The budget reserves space for completion tokens and a safety buffer
        so the LLM request never exceeds the context window.
        """
        if self.context_window_tokens <= 0:
            return

        lock = self.get_lock(session.key)
        async with lock:
            # Refresh session reference: AutoCompact may have replaced it.
            fresh = self.sessions.get_or_create(session.key)
            if fresh is not session:
                session = fresh
            if not session.messages:
                return

            # Foreground and post-turn calls share the lock and failure backoff.
            # A waiter must recheck after the previous archive has finished.
            if time.monotonic() < self._retry_after.get(session.key, 0):
                return
            self._retry_after.pop(session.key, None)

            trigger = self._auto_compact_trigger_budget
            target = int(trigger * self.consolidation_ratio)
            estimate_kwargs = (
                {
                    "current_message": current_message,
                    "message_metadata": message_metadata,
                }
                if current_message is not None
                else {}
            )
            last_summary = self._summary_text(session)
            try:
                estimated, source = self.estimate_session_prompt_tokens(session, **estimate_kwargs)
            except Exception:
                logger.exception("Token estimation failed for {}", session.key)
                estimated, source = 0, "error"
            if estimated <= 0:
                self._persist_last_summary(session, last_summary)
                return
            if estimated < trigger:
                unconsolidated_count = len(session.messages) - session.last_consolidated
                logger.debug(
                    "Token consolidation idle {}: {}/{} via {}, msgs={}",
                    session.key,
                    estimated,
                    trigger,
                    source,
                    unconsolidated_count,
                )
                self._persist_last_summary(session, last_summary)
                return estimated

            for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
                if estimated <= target:
                    break

                boundary = self.pick_consolidation_boundary(session, max(1, estimated - target))
                if boundary is None:
                    logger.debug(
                        "Token consolidation: no safe boundary for {} (round {})",
                        session.key,
                        round_num,
                    )
                    break

                end_idx = boundary[0]

                chunk = session.messages[session.last_consolidated:end_idx]
                if not chunk:
                    break

                logger.debug(
                    "Token consolidation round {} for {}: {}/{} via {}, chunk={} msgs",
                    round_num,
                    session.key,
                    estimated,
                    self.context_window_tokens,
                    source,
                    len(chunk),
                )
                if on_compaction is not None:
                    await on_compaction(True)
                try:
                    try:
                        summary = await self._archive_session(session, chunk, previous_summary=last_summary)
                    finally:
                        if on_compaction is not None:
                            await on_compaction(False)
                except BaseException:
                    self._pending_room_summaries.pop(session.key, None)
                    raise
                if not summary:
                    # Keep the source in the session so a later turn can retry
                    # without silently discarding task context.
                    break
                last_summary = summary
                previous_cursor = session.last_consolidated
                session.last_consolidated = end_idx
                try:
                    self._persist_last_summary(session, last_summary)
                except BaseException:
                    session.last_consolidated = previous_cursor
                    raise

                try:
                    estimated, source = self.estimate_session_prompt_tokens(
                        session,
                        **estimate_kwargs,
                    )
                except Exception:
                    logger.exception("Token estimation failed for {}", session.key)
                    estimated, source = 0, "error"
                if estimated <= 0:
                    break

            # Persist the last summary to session metadata so it can be injected
            # into the runtime context on the next prepare_session() call, aligning
            # the summary injection strategy with AutoCompact._archive().
            self._persist_last_summary(session, last_summary)
            return estimated if estimated > 0 else None

    async def compact_idle_session(
        self,
        session_key: str,
        max_suffix: int = 8,
    ) -> str | None:
        """Hard-truncate an idle session under the consolidation lock.

        Used by AutoCompact so all session mutation goes through a single
        lock-protected path.  Returns the summary text on success, ``None``
        if the LLM failed (raw_archive fallback), or ``""`` if there was
        nothing to archive.
        """
        lock = self.get_lock(session_key)
        async with lock:
            self.sessions.invalidate(session_key)
            session = self.sessions.get_or_create(session_key)
            if time.monotonic() < self._retry_after.get(session.key, 0):
                return None

            tail = list(session.messages[session.last_consolidated:])
            if not tail:
                session.updated_at = datetime.now()
                self.sessions.save(session)
                return ""

            probe = Session(
                key=session.key,
                messages=tail.copy(),
                created_at=session.created_at,
                updated_at=session.updated_at,
                metadata={},
                last_consolidated=0,
            )
            probe.retain_recent_legal_suffix(max_suffix)
            kept = probe.messages
            cut = len(tail) - len(kept)
            archive_msgs = tail[:cut]

            if not archive_msgs and not kept:
                session.updated_at = datetime.now()
                self.sessions.save(session)
                return ""

            last_active = session.updated_at
            summary: str | None = ""
            if archive_msgs:
                summary = await self._archive_session(
                    session, archive_msgs,
                    previous_summary=self._summary_text(session),
                )

            if archive_msgs and summary is None:
                return None

            original_messages = session.messages
            original_cursor = session.last_consolidated
            session.messages = kept
            session.last_consolidated = 0
            session.updated_at = datetime.now()
            try:
                if summary:
                    self._persist_last_summary(session, summary, last_active=last_active)
                else:
                    self.sessions.save(session)
            except BaseException:
                session.messages = original_messages
                session.last_consolidated = original_cursor
                session.updated_at = last_active
                raise

            if archive_msgs:
                logger.info(
                    "Idle-session compact for {}: archived={}, kept={}, summary={}",
                    session_key,
                    len(archive_msgs),
                    len(kept),
                    bool(summary),
                )

            return summary


# ---------------------------------------------------------------------------
# Dream — heavyweight cron-scheduled memory consolidation
# ---------------------------------------------------------------------------


class Dream:
    """Two-phase memory processor: analyze history.jsonl, then edit files via AgentRunner.

    Phase 1 produces an analysis summary (plain LLM call).
    Phase 2 delegates to AgentRunner with read_file / edit_file tools so the
    LLM can make targeted, incremental edits instead of replacing entire files.
    """

    # Caps on prompt-bound inputs so Dream's LLM calls never exceed the model's
    # context window just because a file (or a legacy large history entry) grew
    # unexpectedly. Each file still appears in full via read_file when the agent
    # needs it in Phase 2 — these caps only bound the Phase 1/2 prompt preview.
    _MEMORY_FILE_MAX_CHARS = 32_000
    _SOUL_FILE_MAX_CHARS = 16_000
    _HISTORY_ENTRY_PREVIEW_MAX_CHARS = 4_000

    def __init__(
        self,
        store: MemoryStore,
        provider: LLMProvider,
        model: str,
        max_batch_size: int = 20,
        max_iterations: int = 10,
        max_tool_result_chars: int = 16_000,
        # Skill lifecycle (see docs/design/skill-lifecycle-design.md).
        # Automatic archival is OFF by default; CLI injects these from
        # DreamConfig so the same config drives both Phase 1/2 and the
        # maintenance sweep at the top of run().
        skill_prune_enabled: bool = False,
        archive_after_days: int = 90,
        max_active_user_skills: int = 100,
        disabled_skills: list[str] | None = None,
    ):
        self.store = store
        self.provider = provider
        self.model = model
        self.max_batch_size = max_batch_size
        self.max_iterations = max_iterations
        self.max_tool_result_chars = max_tool_result_chars
        self.skill_prune_enabled = skill_prune_enabled
        self.archive_after_days = archive_after_days
        self.max_active_user_skills = max_active_user_skills
        self.disabled_skills = tuple(disabled_skills or ())
        self._runner = AgentRunner(provider)
        self._tools = self._build_tools()

    def set_provider(self, provider: LLMProvider, model: str) -> None:
        self.provider = provider
        self.model = model
        self._runner.provider = provider

    # -- tool registry -------------------------------------------------------

    def _build_tools(self) -> ToolRegistry:
        """Build a minimal tool registry for the Dream agent.

        Dream uses dedicated memory/skill tools instead of _FsTool because
        memory files and skills live OUTSIDE the workspace (~/.mona/memory/,
        ~/.mona/skills/) and the _FsTool hard boundary blocks access.
        """
        from mona.agent.tools.heartbeat_tools import HeartbeatUpdateTool
        from mona.agent.tools.memory_tools import (
            MemoryEditTool,
            MemoryReadTool,
            MemorySearchTool,
        )
        from mona.agent.tools.skill_tools import (
            SkillCreateTool,
            SkillReadTool,
        )

        tools = ToolRegistry()
        # Agent-private persona, long-term memory and history.
        tools.register(MemoryReadTool(self.store.agent_id))
        tools.register(MemoryEditTool(self.store.agent_id))
        tools.register(MemorySearchTool(self.store.agent_id))
        # Skill access (read existing + create new). Dream's maintenance
        # reads must NOT bump access counters — otherwise the inactivity
        # clock would reset on every Dream cycle and archival would never
        # happen. Pass track_usage=False to opt out of telemetry.
        tools.register(SkillReadTool(track_usage=False, agent_id=self.store.agent_id))
        tools.register(SkillCreateTool(
            max_active_user_skills=self.max_active_user_skills,
            agent_id=self.store.agent_id,
        ))
        # Heartbeat (Dream may add recurring tasks discovered from memory)
        tools.register(HeartbeatUpdateTool())
        return tools

    # -- skill listing --------------------------------------------------------

    def _list_existing_skills(self) -> list[str]:
        """List existing skills as 'name — description' for dedup context."""
        import re as _re

        from mona.agent.skills import BUILTIN_SKILLS_DIR
        from mona.config.paths import get_agent_skills_dir

        desc_re = _re.compile(r"^description:\s*(.+)$", _re.MULTILINE | _re.IGNORECASE)
        entries: dict[str, str] = {}
        for base in (get_agent_skills_dir(self.store.agent_id), BUILTIN_SKILLS_DIR):
            if not base.exists():
                continue
            for d in base.iterdir():
                if not d.is_dir():
                    continue
                skill_md = d / "SKILL.md"
                if not skill_md.exists():
                    continue
                # Prefer user skills over builtin (same name)
                if d.name in entries and base == BUILTIN_SKILLS_DIR:
                    continue
                content = skill_md.read_text(encoding="utf-8")[:500]
                m = desc_re.search(content)
                desc = m.group(1).strip() if m else "(no description)"
                entries[d.name] = desc
        return [f"{name} — {desc}" for name, desc in sorted(entries.items())]

    # -- main entry ----------------------------------------------------------

    async def run(self) -> bool:
        """Process unprocessed history entries. Returns True if work was done."""
        from mona.agent import skill_usage
        from mona.agent.skills import BUILTIN_SKILLS_DIR

        # Skill lifecycle maintenance (zero-LLM deterministic path).
        # Runs at the top of every Dream cycle:
        #   1. Reconcile archived_at with actual directory location (in case
        #      the user manually moved a skill in / out of .archive/).
        #   2. If skill_prune_enabled, compute the archive candidate list
        #      and move each to .archive/. Builtin and unknown user skills
        #      are never auto-archived.
        # Failures here are non-fatal — Dream proceeds with Phase 1/2.
        try:
            skill_usage.reconcile_archived_at(self.store.agent_id)
            if self.skill_prune_enabled:
                disabled = set(self.disabled_skills)
                candidates = skill_usage.plan_automatic_archives(
                    archive_after_days=self.archive_after_days,
                    disabled_skills=disabled,
                    agent_id=self.store.agent_id,
                )
                for name in candidates:
                    ok, msg = skill_usage.archive_skill(
                        name, automatic=True, agent_id=self.store.agent_id
                    )
                    if ok:
                        logger.info("Dream: auto-archived skill '{}' ({})", name, msg)
                    else:
                        logger.warning("Dream: auto-archive '{}' skipped: {}", name, msg)
        except Exception as e:
            logger.warning("Dream: skill lifecycle sweep failed: {}", e, exc_info=True)

        last_cursor = self.store.get_last_dream_cursor()
        entries = self.store.read_unprocessed_history(since_cursor=last_cursor)
        if not entries:
            return False

        batch = entries[: self.max_batch_size]
        logger.info(
            "Dream: processing {} entries (cursor {}→{}), batch={}",
            len(entries), last_cursor, batch[-1]["cursor"], len(batch),
        )

        # Build history text for LLM — cap each entry so a legacy oversized
        # record (e.g. pre-#3412 raw_archive dump) can't blow up the prompt.
        history_text = "\n".join(
            f"[{e['timestamp']}] "
            f"{truncate_text(e['content'], self._HISTORY_ENTRY_PREVIEW_MAX_CHARS)}"
            for e in batch
        )

        # Current file contents, without version metadata.
        # Each file is capped in the *prompt preview* only; Phase 2 still sees
        # the full file via the read_file tool.
        current_date = datetime.now().strftime("%Y-%m-%d")
        raw_memory = self.store.read_memory() or "(empty)"
        current_memory = truncate_text(raw_memory, self._MEMORY_FILE_MAX_CHARS)
        current_soul = truncate_text(
            self.store.read_soul() or "(empty)", self._SOUL_FILE_MAX_CHARS,
        )

        file_context = (
            f"## Current Date\n{current_date}\n\n"
            f"## Current MEMORY.md ({len(current_memory)} chars)\n{current_memory}\n\n"
            f"## Current SOUL.md ({len(current_soul)} chars)\n{current_soul}"
        )

        # Phase 1: Analyze (no skills list — dedup is Phase 2's job)
        phase1_prompt = (
            f"## Conversation History\n{history_text}\n\n{file_context}"
        )

        try:
            phase1_response = await self.provider.chat_with_retry(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": render_template(
                            "agent/dream_phase1.md",
                            strip=True,
                        ),
                    },
                    {"role": "user", "content": phase1_prompt},
                ],
                tools=None,
                tool_choice=None,
            )
            analysis = phase1_response.content or ""
            logger.debug("Dream Phase 1 analysis ({} chars)", len(analysis))
        except Exception:
            logger.exception("Dream Phase 1 failed")
            return False

        # Phase 2: Delegate to AgentRunner with read_file / edit_file
        existing_skills = self._list_existing_skills()
        skills_section = ""
        if existing_skills:
            skills_section = (
                "\n\n## Existing Skills\n"
                + "\n".join(f"- {s}" for s in existing_skills)
            )
        phase2_prompt = f"## Analysis Result\n{analysis}\n\n{file_context}{skills_section}"

        tools = self._tools
        skill_creator_path = BUILTIN_SKILLS_DIR / "skill-creator" / "SKILL.md"
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": render_template(
                    "agent/dream_phase2.md",
                    strip=True,
                    skill_creator_path=str(skill_creator_path),
                ),
            },
            {"role": "user", "content": phase2_prompt},
        ]

        try:
            result = await self._runner.run(AgentRunSpec(
                initial_messages=messages,
                tools=tools,
                model=self.model,
                max_iterations=self.max_iterations,
                max_tool_result_chars=self.max_tool_result_chars,
                fail_on_tool_error=False,
            ))
            logger.debug(
                "Dream Phase 2 complete: stop_reason={}, tool_events={}",
                result.stop_reason, len(result.tool_events),
            )
            for ev in (result.tool_events or []):
                logger.debug("Dream tool_event: name={}, status={}, detail={}", ev.get("name"), ev.get("status"), ev.get("detail", "")[:200])
        except Exception:
            logger.exception("Dream Phase 2 failed")
            result = None

        # Build changelog from tool events
        changelog: list[str] = []
        if result and result.tool_events:
            for event in result.tool_events:
                if event["status"] == "ok":
                    changelog.append(f"{event['name']}: {event['detail']}")

        # Only advance cursor on successful completion to prevent silent loss
        if result and result.stop_reason == "completed":
            new_cursor = batch[-1]["cursor"]
            self.store.set_last_dream_cursor(new_cursor)
            logger.info(
                "Dream done: {} change(s), cursor advanced to {}",
                len(changelog), new_cursor,
            )
        else:
            reason = result.stop_reason if result else "exception"
            logger.warning(
                "Dream incomplete ({}): cursor NOT advanced, will retry next cron cycle",
                reason,
            )

        self.store.compact_history()

        return True
