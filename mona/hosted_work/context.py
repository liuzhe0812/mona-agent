"""The ordinary application context pipeline with an account-owned I/O boundary."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from importlib.resources import files as package_files
from pathlib import Path
from typing import Any

from mona.agent.context import ContextBuilder
from mona.agent.memory import Consolidator, MemoryStore
from mona.agent.tools.capabilities import activate_capabilities
from mona.config.loader import get_config_path
from mona.config.paths import get_agent_memory_dir, get_user_profile_dir
from mona.hosted_work.contracts import WorkError, identifier, private_directory
from mona.hosted_work.frontend import _is_link
from mona.hosted_work.model_access import context_provider, model_context_window
from mona.providers.context_window import ResolvedContextWindow
from mona.session.manager import Session
from mona.utils.prompt_templates import render_template

_FORMAT = "mona-hosted-context-v1"
_OWNER = re.compile(r"^[a-f0-9]{64}$")


def history_fingerprint(messages: list[dict]) -> str:
    return hashlib.sha256(_encoded(messages)).hexdigest()


def _encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _scope(config, payload) -> Path | None:
    """Never switch the active global configuration in a shared parent process."""
    owner = payload.get("owner")
    if owner is None:
        return None
    if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
        raise WorkError("invalid_identity", "会话身份无效。", 401)
    root = Path(config.state_dir)
    if not root.is_absolute():
        raise WorkError("invalid_state", "会话运行目录不可用。", 503)
    runtime = root / "users" / owner / "runtime"
    for directory in (*reversed(runtime.parents), runtime):
        if _is_link(directory):
            raise WorkError("invalid_state", "会话运行目录未通过安全检查。", 503)
    if get_config_path().absolute() != runtime / "config.json":
        raise WorkError("runtime_scope", "会话运行环境不匹配，未读取其他账户配置。", 503)
    runtime = private_directory(runtime)
    # The shared memory/profile stores perform file I/O below the active config.
    # Check existing entries before constructing them, including hard links.
    for current, directories, names in os.walk(runtime, followlinks=False):
        for name in directories + names:
            path = Path(current) / name
            if (_is_link(path) or not path.resolve(strict=True).is_relative_to(runtime)
                    or path.is_file() and path.stat().st_nlink != 1):
                raise WorkError("invalid_state", "会话数据目录未通过安全检查。", 503)
    return runtime


class _TransientMemory:
    """Explicit no-private-I/O dependency for isolated run_turn callers/tests."""
    agent_id = "mona"

    def read_soul(self):
        return ""

    def read_memory(self):
        return ""

    def get_memory_context(self):
        return ""

    def append_history(self, entry, *, max_chars=None):
        return 0


class _SkillCatalog:
    def __init__(self, hosted):
        self.hosted = hosted

    def get_always_skills(self):
        ready = {row["name"] for row in self.hosted.catalog() if row["available"]}
        return [name for name in self.hosted.loader.get_always_skills() if name in ready]

    def load_skills_for_context(self, names):
        for name in names:
            self.hosted.file(name, "SKILL.md", loaded=False)
        content = self.hosted._public(self.hosted.loader.load_skills_for_context(names, track_usage=False))
        if content:
            self.hosted.loaded.update(names)
            self.hosted._allow_resources()
            activate_capabilities({"skill_resources"})
        return content

    def build_skills_summary(self, exclude=None):
        return json.dumps([row for row in self.hosted.catalog() if row["name"] not in (exclude or set())], ensure_ascii=False)


class _ContextBuilder(ContextBuilder):
    def __init__(self, skills, memory, runtime, definitions):
        self._runtime = runtime
        self._definitions = definitions
        super().__init__(Path("/workspace"), memory_store=memory, skills_loader=_SkillCatalog(skills))

    def build_system_prompt(self, skill_names=None, channel=None, user_profile_fields=None, tool_names=None):
        if tool_names is None:
            tool_names = {item["function"]["name"] for item in self._definitions()}
        return super().build_system_prompt(skill_names, channel, user_profile_fields, tool_names)

    def _get_identity(self, channel=None):
        # Public execution vocabulary only. Physical paths, host OS and service
        # identity are not the character's identity or part of a user request.
        return render_template("agent/identity.md", workspace_path="/workspace", runtime="Python",
                               platform_policy="", channel=channel or "websocket")

    def _load_bootstrap_files(self):
        content = self.memory.read_soul() or (package_files("mona") / "templates/SOUL.md").read_text(encoding="utf-8")
        return f"## SOUL.md\n\n{content}"

    def _load_shared_user_profile(self, allowed_fields=None):
        if self._runtime is None:
            return ""
        if get_config_path().absolute() != self._runtime / "config.json":
            raise WorkError("runtime_scope", "会话运行环境已变化。", 503)
        if not get_user_profile_dir().resolve(strict=True).is_relative_to(self._runtime):
            raise WorkError("runtime_scope", "会话资料目录不属于当前账户。", 503)
        return super()._load_shared_user_profile(allowed_fields)


class _Sessions:
    """The injected session adapter never constructs SessionManager/legacy I/O."""
    def __init__(self, context):
        self.context = context

    def get_or_create(self, key):
        if key != self.context.session.key:
            raise WorkError("session_scope", "会话上下文不属于当前会话。", 403)
        return self.context.session

    def save(self, session):
        if session is not self.context.session:
            raise WorkError("session_scope", "会话上下文不属于当前会话。", 403)
        self.context._write_state()


class HostedTurnContext:
    """Reuse desktop preflight/compaction; the Runner execution log stays append-only."""
    model_context_callback = None

    def __init__(self, config, payload, tools, provider, emit):
        self.config, self.payload, self.tools, self.provider, self.emit = config, payload, tools, provider, emit
        history = payload.get("history")
        if not isinstance(history, list) or any(not isinstance(message, dict) for message in history):
            raise WorkError("invalid_history", "会话记录格式无效。")
        self._raw_history = copy.deepcopy(history)
        self._runtime = _scope(config, payload)
        self.owner = payload.get("owner")
        self.session_id = payload.get("session_id") or payload.get("run_id") or "direct"
        if self.owner is not None:
            identifier(self.session_id)
        self.selection = config.models[payload["model_id"]]
        self.window = model_context_window(self.selection, config)
        self._route = history_fingerprint([{"source": self.selection.source, "model": self.selection.model,
                                            "api_base": self.selection.api_base}])
        state = self._validate_state(payload.get("context_state") or {})
        self.session = Session(key="websocket:" + self.session_id, messages=copy.deepcopy(history),
                               metadata=copy.deepcopy(state.get("metadata", {})),
                               last_consolidated=state.get("last_consolidated", 0))
        if self._runtime is not None and not get_agent_memory_dir("mona").resolve(strict=True).is_relative_to(self._runtime):
            raise WorkError("runtime_scope", "会话记忆目录不属于当前账户。", 503)
        self.memory = MemoryStore(Path("/workspace")) if self._runtime is not None else _TransientMemory()
        detected = self.session.metadata.get("_detected_context_window", {})
        if (isinstance(detected, dict) and detected.get("route") == self._route
                and isinstance(detected.get("tokens"), int) and not isinstance(detected["tokens"], bool)
                and self.selection.max_output_tokens + 1024 < detected["tokens"] < self.window.tokens):
            self.window = ResolvedContextWindow(detected["tokens"], "discovered")
        self.builder = _ContextBuilder(tools.skills, self.memory, self._runtime, tools.registry.get_definitions)
        self.sessions = _Sessions(self)
        self.consolidator = Consolidator(
            self.memory, provider, self.selection.model, self.sessions, self.window.tokens,
            self.builder.build_messages, tools.registry.get_definitions,
            context_block_limit=self.selection.context_window_tokens,
            max_completion_tokens=self.selection.max_output_tokens,
        )
        retry = state.get("compaction_retry", {})
        if isinstance(retry, dict) and retry.get("route") == self._route and isinstance(retry.get("until"), (int, float)):
            remaining = min(retry["until"] - time.time(), self.consolidator._FAILURE_RETRY_DELAY_SECONDS)
            if remaining > 0:
                self.consolidator._retry_after[self.session.key] = time.monotonic() + remaining
        self.messages: list[dict] = []
        self._initial_count = 0
        self._injected_projections: dict[str, tuple[str, Any, str]] = {}
        self._state_path = None
        if self._runtime is not None:
            directory = private_directory(self._runtime / "_consolidation")
            self._state_path = directory / (identifier(self.session_id) + ".json")

    def _validate_state(self, state):
        if not isinstance(state, dict):
            raise WorkError("invalid_context", "会话上下文格式或大小无效。")
        from mona.hosted_work.history_media import measure_media

        size, _ = measure_media(state, max_image_bytes=self.config.max_file_bytes,
                                max_expanded_bytes=self.config.history_media_expand_bytes)
        if size > self.config.max_history_bytes:
            raise WorkError("invalid_context", "会话上下文格式或大小无效。")
        if not state:
            return {}
        cursor = state.get("last_consolidated")
        if (state.get("format") != _FORMAT or state.get("owner") != self.owner
                or state.get("session_id") != self.session_id or not isinstance(cursor, int) or isinstance(cursor, bool)
                or not 0 <= cursor <= len(self._raw_history) or not isinstance(state.get("metadata"), dict)
                or state.get("history_prefix_digest") != history_fingerprint(self._raw_history[:cursor])):
            raise WorkError("context_conflict", "会话上下文已变化，请重新读取当前会话。", 409)
        return state

    @property
    def context_state(self):
        until = self.consolidator._retry_after.get(self.session.key, 0)
        remaining = max(0.0, until - time.monotonic())
        return {"format": _FORMAT, "owner": self.owner, "session_id": self.session_id,
                "last_consolidated": self.session.last_consolidated,
                "history_prefix_digest": history_fingerprint(self.session.messages[:self.session.last_consolidated]),
                "metadata": copy.deepcopy(self.session.metadata),
                "compaction_retry": {"route": self._route, "until": time.time() + remaining} if remaining else {}}

    def _write_state(self):
        from mona.hosted_work.history_media import measure_media

        state = self.context_state
        size, _ = measure_media(state, max_image_bytes=self.config.max_file_bytes,
                                max_expanded_bytes=self.config.history_media_expand_bytes)
        if size > self.config.max_history_bytes:
            raise WorkError("context_limit", "会话上下文记录超过保存上限。", 413)
        raw = _encoded(state)
        if self._state_path is None:
            return
        if _is_link(self._state_path) or self._state_path.exists() and self._state_path.stat().st_nlink != 1:
            raise WorkError("invalid_state", "会话上下文文件未通过安全检查。", 503)
        descriptor, temporary = tempfile.mkstemp(prefix=".context-", dir=self._state_path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._state_path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    async def prepare(self):
        # Desktop preflight runs before the current user turn is persisted.
        current = self._raw_history[-1] if self._raw_history and self._raw_history[-1].get("role") == "user" else None
        prepared = getattr(self, "_hosted_planning_entry", None)
        current_content = current.get("content", "") if current else ""
        if prepared and prepared[0] == current_content:
            current_content = prepared[1].content
        if current is not None:
            self.session.messages = copy.deepcopy(self._raw_history[:-1])
        if self.session.last_consolidated > len(self.session.messages):
            raise WorkError("context_conflict", "会话上下文游标已变化。", 409)
        try:
            estimate = await self.consolidator.maybe_consolidate_by_tokens(
                self.session, current_message=current_content,
                message_metadata=self._message_metadata(), on_compaction=self._compacting,
            )
            history = self.session.get_history(include_timestamps=True, model_view=True)
            summary = self.consolidator._summary_text(self.session)
            if current is not None:
                self.messages = self.builder.build_messages(
                    history, current_content, channel="websocket", chat_id=self.session_id,
                    session_summary=summary, session_metadata=self.session.metadata,
                    message_metadata=self._message_metadata(),
                )
                self.session.remember_model_input(current, self.messages[-1]["content"])
            else:
                # Legacy observation-only calls still share the actual system composition.
                self.messages = [{"role": "system", "content": self.builder.build_system_prompt(
                    channel="websocket")}, *history]
            self._initial_count = len(self.messages)
        finally:
            self.session.messages = copy.deepcopy(self._raw_history)
        await self.persist_state()
        if estimate is not None:
            usage = {"context_tokens": estimate, "context_model": self.payload["model_id"],
                     "context_provider": context_provider(self.selection)}
            if self.window.source != "default":
                usage["context_window_tokens"] = self.window.tokens
            await self.emit("progress", {"kind": "context_usage", "token_usage": usage})
        return self

    def _message_metadata(self):
        metadata = {key: value for key, value in (self.payload.get("metadata") or {}).items()
                    if key in {"ui_theme", "office_session_id", "office_document_type", "office_display_name"}}
        metadata["_attachment_paths"] = [item["path"] for item in self.payload.get("attachments", [])
                                         if isinstance(item, dict) and isinstance(item.get("path"), str)]
        return metadata

    async def _compacting(self, active):
        await self.emit("progress", {"kind": "context_compacting", "active": active})

    def register_injection_projection(self, input_id, original_text, projected_content):
        if (not isinstance(input_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", input_id)
                or not isinstance(original_text, str) or not isinstance(projected_content, (str, list))
                or len(_encoded(projected_content)) > self.config.max_history_bytes):
            raise WorkError("invalid_input", "追加消息投影无法确认。", 409)
        previous = self._injected_projections.get(input_id)
        if previous is not None and (previous[0] != original_text or previous[1] != projected_content):
            raise WorkError("input_conflict", "原追加消息已变化，未覆盖历史。", 409)
        if previous is None:
            self._injected_projections[input_id] = (original_text, copy.deepcopy(projected_content),
                                                     datetime.now(timezone.utc).isoformat())
        original, projected, timestamp = self._injected_projections[input_id]
        self.session.remember_model_input({"role": "user", "content": original, "timestamp": timestamp}, projected)

    def history_for_storage(self, messages):
        if not self._initial_count:
            return copy.deepcopy(self._raw_history)
        if len(messages) < self._initial_count:
            raise WorkError("history_conflict", "执行记录长度发生变化，未覆盖已有历史。", 409)
        extra = copy.deepcopy(messages[self._initial_count:])
        for message in extra:
            record = self._injected_projections.get(message.get("id")) if message.get("role") == "user" else None
            if record is not None:
                original, projected, timestamp = record
                if message.get("content") != projected:
                    raise WorkError("history_conflict", "追加消息记录已变化，未覆盖原文。", 409)
                message.update(content=original, timestamp=timestamp)
        return [*copy.deepcopy(self._raw_history), *extra]

    async def persist_state(self, messages=None):
        if messages is not None:
            self.session.messages = self.history_for_storage(messages)
        self._write_state()
        await self.emit("context", {"state": self.context_state,
                                   "source_history_length": len(self.session.messages),
                                   "source_history_digest": history_fingerprint(self.session.messages)})

    def request_snapshot_callback(self, *, messages, tools):
        self.consolidator.remember_request(self.session, messages=messages, tools=tools)

    async def context_limit_callback(self, tokens):
        # A verified smaller capacity is retained for diagnosis; without a
        # different projection it must never authorize an identical retry.
        if isinstance(tokens, int) and not isinstance(tokens, bool) and 0 < tokens < self.consolidator.context_window_tokens:
            self.session.metadata["_detected_context_window"] = {"tokens": tokens, "route": self._route}
            self.consolidator.set_provider(self.provider, self.selection.model, tokens)
            await self.persist_state()
        return False


async def build_turn_context(config, payload, tools, provider, emit) -> HostedTurnContext:
    return await HostedTurnContext(config, payload, tools, provider, emit).prepare()
