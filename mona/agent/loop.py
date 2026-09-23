"""Agent loop: the core processing engine."""

from __future__ import annotations

import asyncio
import dataclasses
import os
import shutil
import time
from contextlib import AsyncExitStack, nullcontext
from copy import copy
from dataclasses import dataclass, field
from enum import Enum, auto
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from loguru import logger

from mona.agent import model_presets as preset_helpers
from mona.agent.autocompact import AutoCompact
from mona.agent.context import ContextBuilder
from mona.agent.hook import AgentHook, CompositeHook
from mona.agent.memory import Consolidator, Dream
from mona.agent.progress_hook import AgentProgressHook
from mona.agent.runner import _MAX_INJECTIONS_PER_TURN, AgentRunner, AgentRunSpec
from mona.agent.subagent import SubagentManager
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META
from mona.agent.tools.file_state import FileStateStore, bind_file_states, reset_file_states
from mona.agent.tools.message import MessageTool
from mona.agent.tools.path_utils import (
    get_current_workspace,
    reset_current_workspace,
    set_current_workspace,
)
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.self import MyTool
from mona.bus.events import InboundMessage, OutboundMessage
from mona.bus.queue import MessageBus
from mona.command import CommandContext, CommandRouter, register_builtin_commands
from mona.config.schema import AgentDefaults, ModelPresetConfig
from mona.providers.base import LLMProvider
from mona.providers.context_window import DEFAULT_CONTEXT_WINDOW_TOKENS
from mona.providers.factory import ProviderSnapshot
from mona.session.goal_state import runner_wall_llm_timeout_s
from mona.session.manager import Session, SessionManager, normalize_message_author
from mona.session.task_plan import task_plan_ws_blob
from mona.session.webui_turns import (
    WebuiTurnCoordinator,
    build_bus_progress_callback,
    mark_webui_session,
)
from mona.utils.document import extract_documents
from mona.utils.helpers import (
    detect_image_mime,
    estimate_message_tokens,
    image_placeholder_text,
    safe_filename,
)
from mona.utils.helpers import truncate_text as truncate_text_fn
from mona.utils.image_generation_intent import image_generation_prompt
from mona.utils.llm_runtime import LLMRuntime
from mona.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE
from mona.utils.video_generation_intent import (
    is_video_generation_request,
    video_generation_prompt,
)

if TYPE_CHECKING:
    from mona.config.schema import (
        ChannelsConfig,
        ProviderConfig,
        ToolsConfig,
    )
    from mona.cron.service import CronService


UNIFIED_SESSION_KEY = "unified:default"


def previewable_delivered_media(files: list[dict[str, Any]] | None) -> list[str]:
    """Return existing image/video deliverables for inline reply previews."""
    media: list[str] = []
    seen: set[str] = set()
    for file in files or []:
        mime = str(file.get("mime") or "").lower()
        path = file.get("absolute_path")
        if not mime.startswith(("image/", "video/")) or not isinstance(path, str):
            continue
        if path not in seen and Path(path).is_file():
            media.append(path)
            seen.add(path)
    return media


# Appended to the system prompt when the user has no active subscription or
# trial, so the model knows which capabilities are unavailable and does not
# hallucinate having searched notes or emails.
_FREE_TIER_CAPABILITY_NOTE = (
    "\n\n---\n\n"
    "# Subscription Status\n\n"
    "There is no active subscription or trial. Do not search/read user Notes, "
    "Agent Knowledge evidence, or email; save images to Notes; use database or "
    "terminal AI tools; or use hoard results sourced from Notes/email. Never imply "
    "that these sources were checked. Creating new notes, hoard search over browser/chat "
    "sources, and other offered tools remain available. If the user requests a blocked "
    "source, explain that a subscription or trial is required."
)

_TASK_PLAN_NOTE = (
    "\n\n---\n\n"
    "## Planning\n\n"
    "Use `update_plan` only for complex, ambiguous, or multi-phase work; plans are not for padding out simple work. "
    "Use meaningful, logically ordered steps with no more than 5-7 words each and status `pending`, `in_progress`, or `completed`. "
    "Keep exactly one step `in_progress` until all are complete; update completed work before moving on. "
    "Revise the plan with an explanation when it changes. The harness renders it, so do not repeat it in full."
)


class TurnState(Enum):
    RESTORE = auto()
    COMPACT = auto()
    COMMAND = auto()
    BUILD = auto()
    RUN = auto()
    SAVE = auto()
    RESPOND = auto()
    DONE = auto()


@dataclass
class StateTraceEntry:
    state: TurnState
    started_at: float
    duration_ms: float
    event: str
    error: str | None = None


@dataclass
class TurnContext:
    msg: InboundMessage
    session_key: str
    state: TurnState
    turn_id: str
    session: Session | None = None

    history: list[dict[str, Any]] = field(default_factory=list)
    initial_messages: list[dict[str, Any]] = field(default_factory=list)

    final_content: str | None = None
    tools_used: list[str] = field(default_factory=list)
    all_messages: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str = ""
    had_injections: bool = False

    user_persisted_early: bool = False
    save_skip: int = 0

    outbound: OutboundMessage | None = None

    on_progress: Callable[..., Awaitable[None]] | None = None
    on_stream: Callable[[str], Awaitable[None]] | None = None
    on_stream_end: Callable[..., Awaitable[None]] | None = None
    on_retry_wait: Callable[[str], Awaitable[None]] | None = None

    pending_queue: asyncio.Queue | None = None
    pending_summary: str | None = None

    turn_wall_started_at: float = field(default_factory=time.time)
    turn_latency_ms: int | None = None
    turn_usage: dict[str, int] = field(default_factory=dict)

    delivered_files: list[dict[str, Any]] = field(default_factory=list)
    trace: list[StateTraceEntry] = field(default_factory=list)


class AgentLoop:
    """
    The agent loop is the core processing engine.

    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """

    @property
    def current_iteration(self) -> int:
        return self._current_iteration

    @property
    def tool_names(self) -> list[str]:
        return self.tools.tool_names

    def llm_runtime(self) -> LLMRuntime:
        """Return the current provider/model pair owned by this loop."""
        self._refresh_provider_snapshot()
        return LLMRuntime(self.provider, self.model)

    _RUNTIME_CHECKPOINT_KEY = "runtime_checkpoint"
    _PENDING_USER_TURN_KEY = "pending_user_turn"

    # Event-driven state transition table.
    # Handlers return an event string; the driver looks up the next state here.
    _TRANSITIONS: dict[tuple[TurnState, str], TurnState] = {
        (TurnState.RESTORE, "ok"): TurnState.COMPACT,
        (TurnState.COMPACT, "ok"): TurnState.COMMAND,
        (TurnState.COMMAND, "dispatch"): TurnState.BUILD,
        (TurnState.COMMAND, "shortcut"): TurnState.DONE,
        (TurnState.BUILD, "ok"): TurnState.RUN,
        (TurnState.RUN, "ok"): TurnState.SAVE,
        (TurnState.SAVE, "ok"): TurnState.RESPOND,
        (TurnState.RESPOND, "ok"): TurnState.DONE,
    }

    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int | None = None,
        context_window_tokens: int | None = None,
        auto_compact_token_limit: int | None = None,
        context_block_limit: int | None = None,
        max_tool_result_chars: int | None = None,
        provider_retry_mode: str = "standard",
        tool_hint_max_length: int | None = None,
        cron_service: CronService | None = None,
        schedule_service: Any | None = None,
        todo_service: Any | None = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        mcp_servers: dict | None = None,
        channels_config: ChannelsConfig | None = None,
        timezone: str | None = None,
        session_ttl_minutes: int = 0,
        consolidation_ratio: float = 0.5,
        max_messages: int = 120,
        hooks: list[AgentHook] | None = None,
        unified_session: bool = False,
        disabled_skills: list[str] | None = None,
        tools_config: ToolsConfig | None = None,
        services_port: int = 17174,
        image_generation_provider_configs: dict[str, ProviderConfig] | None = None,
        video_generation_provider_configs: dict[str, ProviderConfig] | None = None,
        runtime_config_loader: Callable[[], Any] | None = None,
        provider_snapshot_loader: Callable[..., ProviderSnapshot] | None = None,
        provider_signature: tuple[object, ...] | None = None,
        model_presets: dict[str, ModelPresetConfig] | None = None,
        model_preset: str | None = None,
        preset_snapshot_loader: preset_helpers.PresetSnapshotLoader | None = None,
        runtime_model_publisher: Callable[[str, str | None], None] | None = None,
        webui_turns: WebuiTurnCoordinator | None = None,
    ):
        from mona.config.schema import ToolsConfig

        _tc = tools_config or ToolsConfig()
        defaults = AgentDefaults()
        self.bus = bus
        self.channels_config = channels_config
        self.provider = provider
        self._runtime_config_loader = runtime_config_loader
        self._provider_snapshot_loader = provider_snapshot_loader
        self._preset_snapshot_loader = preset_snapshot_loader
        self._runtime_model_publisher = runtime_model_publisher
        self._provider_signature = provider_signature
        self._default_selection_signature = preset_helpers.default_selection_signature(
            provider_signature
        )
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_iterations = (
            max_iterations if max_iterations is not None else defaults.max_tool_iterations
        )
        self.context_window_tokens = (
            context_window_tokens
            if context_window_tokens is not None
            else DEFAULT_CONTEXT_WINDOW_TOKENS
        )
        self.auto_compact_token_limit = auto_compact_token_limit
        self.context_block_limit = context_block_limit
        self.max_tool_result_chars = (
            max_tool_result_chars
            if max_tool_result_chars is not None
            else defaults.max_tool_result_chars
        )
        self.provider_retry_mode = provider_retry_mode
        self.tool_hint_max_length = (
            tool_hint_max_length
            if tool_hint_max_length is not None
            else defaults.tool_hint_max_length
        )
        self.tools_config = _tc
        self.services_port = services_port
        self.web_config = _tc.web
        self.exec_config = _tc.exec
        self._image_generation_provider_configs = dict(image_generation_provider_configs or {})
        self._video_generation_provider_configs = dict(video_generation_provider_configs or {})
        self.cron_service = cron_service
        self.schedule_service = schedule_service
        self.todo_service = todo_service
        self.restrict_to_workspace = restrict_to_workspace
        self._start_time = time.time()
        self._last_usage: dict[str, int] = {}
        self._pending_turn_latency_ms: dict[str, int] = {}
        self._pending_turn_usage: dict[str, dict[str, int]] = {}
        self._extra_hooks: list[AgentHook] = hooks or []

        self._base_disabled_skills = set(disabled_skills or [])
        self.context = ContextBuilder(workspace, timezone=timezone, disabled_skills=disabled_skills)
        self.sessions = session_manager or SessionManager(workspace)
        # Delegated loops (document/partner agents) execute their turn through
        # this loop's ``_dispatch`` while ``_process_message`` runs on the
        # delegate. Sharing the coordinator keeps the title context captured by
        # the delegate visible to the turn-end handler, so delegated chats get
        # a generated title like ordinary ones.
        self._webui_turns = webui_turns or WebuiTurnCoordinator(
            bus=self.bus,
            sessions=self.sessions,
            schedule_background=lambda coro: self._schedule_background(coro),
        )
        self.tools = ToolRegistry()
        # Shared ToolContext handed to every loaded tool at registration; its
        # per-request identity fields (conversation_id/room_id/job_id/...) are
        # refreshed in _set_tool_context before tools read them.
        self._tool_ctx: Any | None = None
        # One file-read/write tracker per logical session. The tool registry is
        # shared by this loop, so tools resolve the active state via contextvars.
        self._file_state_store = FileStateStore()
        self.runner = AgentRunner(provider)
        self.subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=self.model,
            tools_config=_tc,
            services_port=self.services_port,
            image_generation_provider_configs=self._image_generation_provider_configs,
            video_generation_provider_configs=self._video_generation_provider_configs,
            max_tool_result_chars=self.max_tool_result_chars,
            restrict_to_workspace=restrict_to_workspace,
            disabled_skills=disabled_skills,
            max_iterations=self.max_iterations,
            llm_wall_timeout_for_session=lambda sk: runner_wall_llm_timeout_s(self.sessions, sk),
            session_manager=self.sessions,
            agent_runtime_resolver=self._resolve_named_agent_runtime,
            subscription_access_resolver=self._resolve_subagent_subscription_access,
        )
        self._unified_session = unified_session
        self._max_messages = max_messages if max_messages > 0 else 120
        self._running = False
        self._mcp_servers = mcp_servers or {}
        self._mcp_stacks: dict[str, AsyncExitStack] = {}
        self._mcp_connected = False
        self._mcp_connecting = False
        self._computer_use_connection_lock = asyncio.Lock()
        self._mcp_reconnect_lock = asyncio.Lock()
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        self._background_tasks: list[asyncio.Task] = []
        self._session_locks: dict[str, asyncio.Lock] = {}
        # Per-session pending queues for mid-turn message injection.
        # When a session has an active task, new messages for that session
        # are routed here instead of creating a new task.
        self._pending_queues: dict[str, asyncio.Queue] = {}
        # mona_MAX_CONCURRENT_REQUESTS: <=0 means unlimited; default 3.
        _max = int(os.environ.get("mona_MAX_CONCURRENT_REQUESTS", "3"))
        self._concurrency_gate: asyncio.Semaphore | None = (
            asyncio.Semaphore(_max) if _max > 0 else None
        )
        self.consolidator = Consolidator(
            store=self.context.memory,
            provider=provider,
            model=self.model,
            sessions=self.sessions,
            context_window_tokens=self.context_window_tokens,
            auto_compact_token_limit=self.auto_compact_token_limit,
            context_block_limit=self.context_block_limit,
            build_messages=self.context.build_messages,
            get_tool_definitions=self.tools.get_definitions,
            max_completion_tokens=provider.generation.max_tokens,
            consolidation_ratio=consolidation_ratio,
        )
        # Kept for loops that re-bind memory helpers (PartnerAgentLoop).
        self._consolidation_ratio = consolidation_ratio
        self._session_ttl_minutes = session_ttl_minutes
        self.auto_compact = AutoCompact(
            sessions=self.sessions,
            consolidator=self.consolidator,
            session_ttl_minutes=session_ttl_minutes,
        )
        self.dream = Dream(
            store=self.context.memory,
            provider=provider,
            model=self.model,
        )
        self.model_presets: dict[str, ModelPresetConfig] = model_presets or {}
        self._active_preset: str | None = None
        self._base_model_preset = model_preset
        if model_preset:
            self.set_model_preset(model_preset, publish_update=False)
        self._mona_config_revision = -1
        self._mona_effective_config: Any | None = None
        self._mona_generation_overrides: tuple[float | None, int | None, str | None] = (
            None,
            None,
            None,
        )
        self._refresh_mona_user_config()
        self._register_default_tools()
        # Document agent loops (lazy-initialized on first session of each kind).
        # Shares this loop's provider/sessions/bus but has its own tool whitelist
        # and DocumentContextBuilder. See _ensure_document_loop().
        self._doc_loops: dict[str, AgentLoop] = {}
        # Partner agent loops for direct chats (lazy, one per agent_id).
        # Shares this loop's provider/sessions/bus but executes under the
        # partner identity with a manifest-filtered tool registry.
        self._partner_loops: dict[str, AgentLoop] = {}
        self._runtime_vars: dict[str, Any] = {}
        self._current_iteration: int = 0
        self.commands = CommandRouter()
        register_builtin_commands(self.commands)

    @classmethod
    def from_config(
        cls,
        config: Any,
        bus: MessageBus | None = None,
        **extra: Any,
    ) -> AgentLoop:
        """Create an AgentLoop from config with the common parameter set.

        Extra keyword arguments are forwarded to ``AgentLoop.__init__``,
        allowing callers to override or extend the standard config-derived
        parameters (e.g. ``cron_service``, ``session_manager``).
        """
        from mona.providers.factory import build_provider_snapshot, make_provider

        if bus is None:
            bus = MessageBus()
        defaults = config.agents.defaults
        provider_override = extra.pop("provider", None)
        resolved = config.resolve_preset()
        model_override = extra.pop("model", None)
        context_window_override = extra.pop("context_window_tokens", None)
        auto_compact_override = extra.pop("auto_compact_token_limit", None)
        if provider_override is None and model_override is None and context_window_override is None:
            snapshot = build_provider_snapshot(config)
            provider = snapshot.provider
            model = snapshot.model
            context_window_tokens = snapshot.context_window_tokens
            auto_compact_token_limit = (
                auto_compact_override
                if auto_compact_override is not None
                else snapshot.auto_compact_token_limit
            )
        else:
            from mona.providers.context_window import resolve_model_context_window

            provider = provider_override or make_provider(config)
            model = model_override or resolved.model
            context_window_tokens = (
                context_window_override
                if context_window_override is not None
                else resolve_model_context_window(config, resolved)
            )
            auto_compact_token_limit = (
                auto_compact_override
                if auto_compact_override is not None
                else resolved.auto_compact_token_limit
            )
        provider_snapshot_loader = extra.pop("provider_snapshot_loader", None)
        runtime_config_loader = extra.pop("runtime_config_loader", None)
        if runtime_config_loader is None and provider_snapshot_loader is not None:
            from mona.config.loader import load_config, resolve_config_env_vars

            def load_runtime_config() -> Any:
                return resolve_config_env_vars(load_config())

            runtime_config_loader = load_runtime_config
        preset_snapshot_loader = extra.pop(
            "preset_snapshot_loader", None
        ) or preset_helpers.make_preset_snapshot_loader(
            config,
            provider_snapshot_loader,
        )
        return cls(
            bus=bus,
            provider=provider,
            workspace=config.workspace_path,
            model=model,
            max_iterations=defaults.max_tool_iterations,
            context_window_tokens=context_window_tokens,
            auto_compact_token_limit=auto_compact_token_limit,
            context_block_limit=defaults.context_block_limit,
            max_tool_result_chars=defaults.max_tool_result_chars,
            provider_retry_mode=defaults.provider_retry_mode,
            tool_hint_max_length=defaults.tool_hint_max_length,
            restrict_to_workspace=config.tools.restrict_to_workspace,
            mcp_servers=config.tools.mcp_servers,
            channels_config=config.channels,
            timezone=defaults.timezone,
            unified_session=defaults.unified_session,
            disabled_skills=defaults.disabled_skills,
            session_ttl_minutes=defaults.session_ttl_minutes,
            consolidation_ratio=defaults.consolidation_ratio,
            max_messages=defaults.max_messages,
            tools_config=config.tools,
            services_port=extra.pop("services_port", config.services.port),
            runtime_config_loader=runtime_config_loader,
            model_presets=preset_helpers.configured_model_presets(config),
            model_preset=defaults.model_preset,
            provider_snapshot_loader=provider_snapshot_loader,
            preset_snapshot_loader=preset_snapshot_loader,
            **extra,
        )

    def _sync_subagent_runtime_limits(self) -> None:
        """Keep subagent runtime limits aligned with mutable loop settings."""
        self.subagents.max_iterations = self.max_iterations

    def _refresh_mona_user_config(self) -> None:
        """Apply Mona's mutable settings before the next turn without a restart."""
        if hasattr(self, "_partner_agent_id"):
            return
        from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
        from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config

        config = load_agent_user_config(MONA_AGENT_ID)
        if config.revision == self._mona_config_revision:
            return
        definition = AgentRegistry().require(MONA_AGENT_ID)
        effective = resolve_effective_agent_config(definition, config)
        self.context.skills.disabled_skills = self._base_disabled_skills | set(
            effective.disabled_skills
        )
        self.subagents.disabled_skills = self._base_disabled_skills | set(effective.disabled_skills)
        self.tools.set_allowed_tool_names(
            set(effective.allowed_tools) if effective.allowed_tools is not None else None
        )
        self._mona_generation_overrides = (
            effective.temperature,
            effective.max_tokens,
            effective.reasoning_effort,
        )
        if effective.model_preset and effective.model_preset != self._active_preset:
            self.set_model_preset(effective.model_preset, publish_update=False)
        elif (
            not effective.model_preset
            and self._base_model_preset
            and self._active_preset != self._base_model_preset
        ):
            self.set_model_preset(self._base_model_preset, publish_update=False)
        self._mona_effective_config = effective
        self._mona_config_revision = config.revision

    def _resolve_named_agent_runtime(self, definition: Any) -> tuple[LLMProvider, str, Any]:
        """Resolve a room agent's model and generation overrides for one job.

        The returned provider is job-local when a model preset is selected, so
        concurrent room agents never mutate Mona's active provider.
        """
        from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config

        effective = resolve_effective_agent_config(
            definition, load_agent_user_config(definition.id)
        )
        provider = self.provider
        model = self.model
        if effective.model_preset:
            try:
                snapshot = preset_helpers.build_runtime_preset_snapshot(
                    name=effective.model_preset,
                    presets=self.model_presets,
                    provider=copy(self.provider),
                    loader=self._preset_snapshot_loader,
                )
                provider, model = snapshot.provider, snapshot.model
            except Exception:
                logger.exception(
                    "Failed to resolve model preset {} for agent {}",
                    effective.model_preset,
                    definition.id,
                )
        elif (definition.model or "").strip().lower() != "inherit":
            model = definition.model
        return provider, model, effective

    def _apply_provider_snapshot(
        self,
        snapshot: ProviderSnapshot,
        *,
        publish_update: bool = True,
        model_preset: str | None = None,
    ) -> None:
        """Swap model/provider for future turns without disturbing an active one."""
        provider = snapshot.provider
        model = snapshot.model
        context_window_tokens = snapshot.context_window_tokens
        auto_compact_token_limit = snapshot.auto_compact_token_limit
        old_model = self.model
        self.provider = provider
        self.model = model
        self.context_window_tokens = context_window_tokens
        self.auto_compact_token_limit = auto_compact_token_limit
        self.runner.provider = provider
        self.subagents.set_provider(provider, model)
        self.consolidator.set_provider(
            provider,
            model,
            context_window_tokens,
            auto_compact_token_limit,
        )
        self.dream.set_provider(provider, model)
        if hasattr(self, "_doc_loops"):
            self._doc_loops.clear()
        if hasattr(self, "_partner_loops"):
            self._partner_loops.clear()
        self._provider_signature = snapshot.signature
        if publish_update and self._runtime_model_publisher is not None:
            self._runtime_model_publisher(
                self.model,
                model_preset if model_preset is not None else self.model_preset,
            )
        logger.info("Runtime model switched for next turn: {} -> {}", old_model, model)

    def _refresh_provider_snapshot(self) -> None:
        if self._provider_snapshot_loader is None:
            return
        try:
            snapshot = self._provider_snapshot_loader()
        except Exception:
            logger.exception("Failed to refresh provider config")
            return
        default_selection = preset_helpers.default_selection_signature(snapshot.signature)
        if self._active_preset and self._default_selection_signature in (None, default_selection):
            self._default_selection_signature = default_selection
            try:
                snapshot = self._build_model_preset_snapshot(self._active_preset)
            except Exception:
                logger.exception("Failed to refresh active model preset")
                return
        else:
            self._active_preset = None
            self._default_selection_signature = default_selection
        if snapshot.signature == self._provider_signature:
            return
        self._default_selection_signature = preset_helpers.default_selection_signature(
            snapshot.signature
        )
        self._apply_provider_snapshot(snapshot)

    @property
    def model_preset(self) -> str | None:
        return self._active_preset

    @model_preset.setter
    def model_preset(self, name: str | None) -> None:
        self.set_model_preset(name)

    def _build_model_preset_snapshot(self, name: str) -> ProviderSnapshot:
        return preset_helpers.build_runtime_preset_snapshot(
            name=name,
            presets=self.model_presets,
            provider=self.provider,
            loader=self._preset_snapshot_loader,
        )

    def set_model_preset(self, name: str | None, *, publish_update: bool = True) -> None:
        """Resolve a preset by name and apply all runtime model dependents."""
        name = preset_helpers.normalize_preset_name(name, self.model_presets)
        snapshot = self._build_model_preset_snapshot(name)
        self._apply_provider_snapshot(snapshot, publish_update=publish_update, model_preset=name)
        self._active_preset = name

    def _effective_workspace(self, session: Session | None) -> Path:
        """Compute the effective workspace for a session.

        - Session with ``metadata.workspace`` set to an absolute path: that
          path (resolved) — project session keeps its own root.
        - Room sessions are views over the executing Agent's output; room
          membership does not create a physical artifact directory.
        - Session with ``metadata.agent_kind`` in ``DOCUMENT_PROFILES``: the
          configured workspace root — dedicated agents keep their existing
          workspace semantics (video_projects/).
        - Default session or no session: the active Agent's
          ``agent-workspaces/<agent_id>/output`` directory.
        """
        from mona.agent.partners import MONA_AGENT_ID
        from mona.config.paths import get_agent_output_dir

        base_workspace = self.workspace
        ws_override = session.metadata.get("workspace") if session is not None else None
        has_override = isinstance(ws_override, str) and ws_override.strip()
        if has_override:
            base_workspace = Path(ws_override).expanduser().resolve()
            # An explicit workspace belongs to a project/direct session and
            # must remain the project's own root.  Rooms are the one
            # exception: their workspace override only selects the base from
            # which the executing Agent's isolated output is resolved.
            is_room = session is not None and session.conversation_metadata.type == "room"
            if not is_room:
                return base_workspace
        from mona.agent.document_loop import DOCUMENT_PROFILES

        profile = getattr(self, "_profile", None)
        agent_kind = getattr(profile, "agent_kind", None)
        if agent_kind is None:
            agent_kind = session.metadata.get("agent_kind") if session is not None else None
        if isinstance(agent_kind, str) and agent_kind in DOCUMENT_PROFILES:
            return base_workspace
        owner_id = getattr(self, "_partner_agent_id", MONA_AGENT_ID)
        return get_agent_output_dir(base_workspace, owner_id)

    def _build_model_history(
        self,
        session: Session,
        *,
        max_messages: int,
        max_tokens: int = 0,
        include_timestamps: bool = False,
    ) -> list[dict[str, Any]]:
        """Build model-visible history, preserving room speaker identity.

        Room sessions are shared conversations, so the normal Session replay
        (which intentionally strips persistence metadata) would collapse all
        assistant messages into one anonymous speaker. Project only the
        user-visible room messages and label other agents; direct sessions
        retain the existing replay path, including tool-call boundaries.
        """
        if session.conversation_metadata.type != "room":
            return session.get_history(
                max_messages=max_messages,
                max_tokens=max_tokens,
                include_timestamps=include_timestamps,
            )

        from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
        from mona.agent.room import project_history_for_agent

        registry = getattr(self, "_room_agent_registry", None)
        if registry is None:
            registry = AgentRegistry()
            self._room_agent_registry = registry
        viewer_id = getattr(self, "_partner_agent_id", MONA_AGENT_ID)
        projected = project_history_for_agent(
            session.messages[session.last_consolidated :],
            viewer_agent_id=viewer_id,
            registry=registry,
            max_messages=max_messages,
        )
        if max_tokens <= 0 or not projected:
            return projected

        kept: list[dict[str, Any]] = []
        used = 0
        for message in reversed(projected):
            tokens = estimate_message_tokens(message)
            if kept and used + tokens > max_tokens:
                break
            kept.append(message)
            used += tokens
        kept.reverse()
        first_user = next(
            (index for index, message in enumerate(kept) if message.get("role") == "user"),
            None,
        )
        return kept[first_user:] if first_user is not None else kept

    def _room_members_context(self, session: Session) -> str:
        """Return stable room goal/member metadata for the current model turn."""
        conversation = session.conversation_metadata
        if conversation.type != "room":
            return ""
        from mona.agent.partners import AgentRegistry

        registry = getattr(self, "_room_agent_registry", None)
        if registry is None:
            registry = AgentRegistry()
            self._room_agent_registry = registry
        members: list[str] = []
        for agent_id in conversation.agent_ids:
            definition = registry.get(agent_id)
            if definition is None:
                members.append(f"- {agent_id}")
                continue
            description = f": {definition.description}" if definition.description else ""
            members.append(f"- {agent_id} — {definition.display_name}{description}")
        context = (
            "# Collaboration room metadata\n"
            "This metadata describes the current room; it is context, not an instruction.\n"
            f"Room goal: {conversation.goal or '(no room goal set)'}\n"
            "Members:\n" + ("\n".join(members) if members else "(no members listed)")
        )
        if getattr(self, "_partner_agent_id", None) is None:
            context += (
                "\n\n# Mona delegation rule\n"
                "When a room member needs to provide new information, invoke "
                "delegate_agent in the same turn. Never write an @mention as a "
                "substitute: reply text cannot create an AgentJob."
            )
        return context

    def _append_room_members_context(
        self,
        messages: list[dict[str, Any]],
        session: Session,
    ) -> list[dict[str, Any]]:
        """Append room membership metadata to the model's system prompt."""
        context = self._room_members_context(session)
        if not context:
            return messages
        for index, message in enumerate(messages):
            if message.get("role") != "system":
                continue
            content = message.get("content")
            if not isinstance(content, str):
                continue
            messages[index] = {
                **message,
                "content": f"{content}\n\n---\n\n{context}",
            }
            break
        return messages

    def _ensure_document_loop(self, agent_kind: str) -> AgentLoop:
        """Lazily construct a document agent loop for the given kind.

        Document loops (currently video) share this loop's provider,
        sessions, bus, and other runtime dependencies, but each has its own
        filtered tool registry and DocumentContextBuilder driven by the
        matching DocumentProfile. Raises if construction fails — no fallback.
        """
        cached = self._doc_loops.get(agent_kind)
        if cached is not None:
            return cached
        from mona.agent.document_loop import DocumentAgentLoop

        loop = DocumentAgentLoop(
            bus=self.bus,
            provider=self.provider,
            workspace=self.workspace,
            model=self.model,
            context_window_tokens=self.context_window_tokens,
            auto_compact_token_limit=self.auto_compact_token_limit,
            max_tool_result_chars=self.max_tool_result_chars,
            restrict_to_workspace=self.restrict_to_workspace,
            session_manager=self.sessions,
            timezone=self.context.timezone,
            max_messages=self._max_messages,
            disabled_skills=None,
            tools_config=self.tools_config,
            services_port=self.services_port,
            image_generation_provider_configs=self._image_generation_provider_configs,
            video_generation_provider_configs=self._video_generation_provider_configs,
            runtime_config_loader=self._runtime_config_loader,
            hooks=list(self._extra_hooks) if self._extra_hooks else None,
            unified_session=self._unified_session,
            agent_kind=agent_kind,
            webui_turns=self._webui_turns,
        )
        self._doc_loops[agent_kind] = loop
        logger.info("DocumentAgentLoop({}) initialized with tool whitelist", agent_kind)
        return loop

    def _ensure_partner_loop(self, agent_id: str) -> AgentLoop | None:
        """Lazily construct a partner agent loop for a direct chat.

        Returns None when the agent is no longer registered (e.g. uninstalled
        after the conversation was created) — the caller must answer with an
        explicit unavailable notice; identity never falls back to Mona.
        """
        from mona.agent.partners import AgentRegistry
        from mona.agent.user_config import load_agent_user_config

        registry = AgentRegistry()
        definition = registry.get(agent_id)
        if definition is None:
            logger.warning(
                "Direct-chat agent {!r} not found; answering with unavailable notice",
                agent_id,
            )
            return None
        config = load_agent_user_config(agent_id)
        if not config.enabled:
            logger.info("Direct-chat agent {!r} is disabled", agent_id)
            return None
        cached = self._partner_loops.get(agent_id)
        if (
            cached is not None
            and getattr(cached, "user_config_revision", None) == config.revision
            and getattr(cached, "package_version", None) == definition.package_version
        ):
            return cached
        if cached is not None:
            self._partner_loops.pop(agent_id, None)
        from mona.agent.partner_loop import PartnerAgentLoop

        loop = PartnerAgentLoop(
            agent_id=agent_id,
            registry=registry,
            bus=self.bus,
            provider=self.provider,
            workspace=self.workspace,
            model=self.model,
            context_window_tokens=self.context_window_tokens,
            auto_compact_token_limit=self.auto_compact_token_limit,
            max_tool_result_chars=self.max_tool_result_chars,
            restrict_to_workspace=self.restrict_to_workspace,
            session_manager=self.sessions,
            timezone=self.context.timezone,
            max_messages=self._max_messages,
            disabled_skills=None,
            tools_config=self.tools_config,
            services_port=self.services_port,
            image_generation_provider_configs=self._image_generation_provider_configs,
            video_generation_provider_configs=self._video_generation_provider_configs,
            hooks=list(self._extra_hooks) if self._extra_hooks else None,
            unified_session=self._unified_session,
            consolidation_ratio=self._consolidation_ratio,
            session_ttl_minutes=self._session_ttl_minutes,
            provider_snapshot_loader=self._provider_snapshot_loader,
            provider_signature=self._provider_signature,
            model_presets=self.model_presets,
            preset_snapshot_loader=self._preset_snapshot_loader,
            runtime_config_loader=self._runtime_config_loader,
            webui_turns=self._webui_turns,
        )
        self._partner_loops[agent_id] = loop
        logger.info("PartnerAgentLoop({}) initialized for direct chat", agent_id)
        return loop

    def _register_default_tools(self) -> None:
        """Register the default set of tools via plugin loader."""
        from mona.agent.tools.context import ToolContext
        from mona.agent.tools.loader import ToolLoader

        ctx = ToolContext(
            config=self.tools_config,
            workspace=str(self.workspace),
            registry=self.tools,
            services_port=self.services_port,
            bus=self.bus,
            subagent_manager=self.subagents,
            cron_service=self.cron_service,
            schedule_service=self.schedule_service,
            todo_service=self.todo_service,
            sessions=self.sessions,
            provider_snapshot_loader=self._provider_snapshot_loader,
            image_generation_provider_configs=self._image_generation_provider_configs,
            video_generation_provider_configs=self._video_generation_provider_configs,
            timezone=self.context.timezone or "UTC",
            agent_id=getattr(self, "_partner_agent_id", "mona"),
            agent_kind=getattr(getattr(self, "_profile", None), "agent_kind", None),
        )
        self._tool_ctx = ctx
        self._tool_scope = "core"
        self._tool_allowlist: set[str] | None = None
        loader = ToolLoader()
        registered = loader.load(ctx, self.tools)

        # MyTool needs runtime state reference — manual registration
        if self.tools_config.my.enable:
            self.tools.register(
                MyTool(runtime_state=self, modify_allowed=self.tools_config.my.allow_set)
            )
            registered.append("my")

        logger.debug("Registered {} tools: {}", len(registered), registered)

    def _refresh_media_generation_tools(self) -> None:
        """Apply image/video settings to the next turn without restarting."""
        if self._runtime_config_loader is None:
            return
        try:
            config = self._runtime_config_loader()
            from mona.providers.image_generation import image_gen_provider_configs
            from mona.providers.video_generation import video_gen_provider_configs

            image_providers = image_gen_provider_configs(config)
            video_providers = video_gen_provider_configs(config)
        except Exception:
            logger.exception("Failed to refresh media generation config")
            return

        image_config = config.tools.image_generation
        video_config = config.tools.video_generation
        if (
            self.tools_config.image_generation == image_config
            and self.tools_config.video_generation == video_config
            and self._image_generation_provider_configs == image_providers
            and self._video_generation_provider_configs == video_providers
        ):
            return

        self.tools_config.image_generation = image_config
        self.tools_config.video_generation = video_config
        self._image_generation_provider_configs = image_providers
        self._video_generation_provider_configs = video_providers
        self.subagents.tools_config = self.tools_config
        self.subagents._image_generation_provider_configs = dict(image_providers)
        self.subagents._video_generation_provider_configs = dict(video_providers)

        if self._tool_ctx is None:
            return
        self._tool_ctx.config = self.tools_config
        self._tool_ctx.image_generation_provider_configs = image_providers
        self._tool_ctx.video_generation_provider_configs = video_providers

        from mona.agent.tools.image_generation import ImageGenerationTool
        from mona.agent.tools.video_generation import VideoGenerationTool

        allowlist = getattr(self, "_tool_allowlist", None)
        scope = getattr(self, "_tool_scope", "core")
        for tool_cls, name in (
            (ImageGenerationTool, "generate_image"),
            (VideoGenerationTool, "generate_video"),
        ):
            allowed = (
                scope in getattr(tool_cls, "_scopes", {"core"})
                and (allowlist is None or name in allowlist)
            )
            if allowed and tool_cls.enabled(self._tool_ctx):
                self.tools.register(tool_cls.create(self._tool_ctx))
            else:
                self.tools.unregister(name)

        logger.info(
            "Media generation config refreshed for next turn: image={}, video={}",
            image_config.enabled,
            video_config.enabled,
        )

    async def _connect_mcp(self) -> None:
        """Connect to configured MCP servers (one-time, lazy)."""
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        self._mcp_connecting = True
        from mona.agent.tools.mcp import connect_mcp_servers

        try:
            self._mcp_stacks = await connect_mcp_servers(
                self._mcp_servers,
                self.tools,
                self._reconnect_mcp_server_tools,
                computer_provider=self.provider,
                computer_model=self.model,
                runtime_config_loader=self._runtime_config_loader,
                computer_provider_loader=lambda: (self.provider, self.model),
                computer_permission_check=self._live_computer_permission,
            )
            if self._mcp_stacks:
                self._mcp_connected = True
            else:
                logger.warning("No MCP servers connected successfully (will retry next message)")
        except asyncio.CancelledError:
            logger.warning("MCP connection cancelled (will retry next message)")
            self._mcp_stacks.clear()
        except BaseException as e:
            logger.warning("Failed to connect MCP servers (will retry next message): {}", e)
            self._mcp_stacks.clear()
        finally:
            self._mcp_connecting = False

    def _set_tool_context(
        self,
        channel: str,
        chat_id: str,
        message_id: str | None = None,
        metadata: dict | None = None,
        session_key: str | None = None,
        session: Session | None = None,
        *,
        reset_capabilities: bool = True,
    ) -> None:
        """Update tool routing; reset capabilities only when starting a turn."""
        from mona.agent.tools.context import (
            PROJECT_WORKSPACE_META,
            ContextAware,
            RequestContext,
        )

        # Multi-agent identity (phase 2): refresh the shared ToolContext
        # before tools read it in set_context. ``agent_id`` is fixed at
        # registry construction time — the reserved Mona agent for the main
        # loop, the partner agent for PartnerAgentLoop — so only the
        # per-request fields are refreshed here. room_id is set only for
        # collaboration rooms, so delegate_agent stays hidden elsewhere.
        if self._tool_ctx is not None:
            self._tool_ctx.conversation_id = chat_id
            self._tool_ctx.job_id = None
            self._tool_ctx.workflow_run_id = None
            is_room = session is not None and session.conversation_metadata.type == "room"
            self._tool_ctx.room_id = chat_id if is_room else None

        if session_key is not None:
            effective_key = session_key
        elif self._unified_session:
            effective_key = UNIFIED_SESSION_KEY
        else:
            effective_key = f"{channel}:{chat_id}"

        meta = dict(metadata or {})
        if session is not None:
            workspace_override = session.metadata.get("workspace")
            meta[PROJECT_WORKSPACE_META] = bool(
                isinstance(workspace_override, str)
                and workspace_override.strip()
                and session.conversation_metadata.type != "room"
            )
        request_ctx = RequestContext(
            channel=channel,
            chat_id=chat_id,
            message_id=message_id,
            session_key=effective_key,
            metadata=meta,
            terminal_session_id=meta.get("terminal_session_id"),
            terminal_exec_mode=meta.get("terminal_exec_mode"),
        )

        from mona.agent.tools.capabilities import bind_capability_context

        if reset_capabilities:
            bind_capability_context(request_ctx)
            from mona.computer_use.session import bind_computer_context

            bind_computer_context(request_ctx)
        if getattr(self, "_profile", None) is not None:
            from mona.agent.tools.capabilities import activate_capabilities

            activate_capabilities({"development", "skill_resources"})

        for name in self.tools.tool_names:
            tool = self.tools.get(name)
            if tool and isinstance(tool, ContextAware):
                tool.set_context(request_ctx)
        # ToolRegistry filters request availability on every read while
        # retaining its stable schema cache across concurrent sessions.

    @staticmethod
    def _runtime_chat_id(msg: InboundMessage) -> str:
        """Return the chat id shown in runtime metadata for the model."""
        return str(msg.metadata.get("context_chat_id") or msg.chat_id)

    async def _build_bus_progress_callback(
        self, msg: InboundMessage
    ) -> Callable[..., Awaitable[None]]:
        """Build a progress callback that publishes to the message bus."""
        return build_bus_progress_callback(
            self.bus,
            msg,
            agent_id=getattr(self, "_partner_agent_id", "mona"),
        )

    async def _build_retry_wait_callback(
        self, msg: InboundMessage
    ) -> Callable[[str], Awaitable[None]]:
        """Build a retry-wait callback that publishes to the message bus."""

        async def _on_retry_wait(content: str) -> None:
            meta = dict(msg.metadata or {})
            meta["_retry_wait"] = True
            await self.bus.publish_outbound(
                OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=content,
                    metadata=meta,
                )
            )

        return _on_retry_wait

    def _persist_user_message_early(
        self,
        msg: InboundMessage,
        session: Session,
        **kwargs: Any,
    ) -> bool:
        """Persist the triggering user message before the turn starts.

        Returns True if the message was persisted.
        """
        media_paths = [p for p in (msg.media or []) if isinstance(p, str) and p]
        has_text = isinstance(msg.content, str) and msg.content.strip()
        if has_text or media_paths:
            extra: dict[str, Any] = {"media": list(media_paths)} if media_paths else {}
            if msg.metadata.get("origin") == "profile_advice":
                extra["origin"] = "profile_advice"
                advice_id = msg.metadata.get("profile_advice_id")
                if isinstance(advice_id, str) and advice_id:
                    extra["profile_advice_id"] = advice_id
            extra.update(kwargs)
            text = msg.content if isinstance(msg.content, str) else ""
            session.add_message("user", text, **extra)
            self._mark_pending_user_turn(session)
            self.sessions.save(session)
            return True
        return False

    def _build_initial_messages(
        self,
        msg: InboundMessage,
        session: Session,
        history: list[dict[str, Any]],
        pending_summary: str | None,
    ) -> list[dict[str, Any]]:
        """Build the initial message list for the LLM turn."""
        from mona.agent.tools.capabilities import (
            activate_capabilities,
            activate_capabilities_for_history,
        )

        activate_capabilities_for_history(history)
        if (
            self.tools.has("generate_video")
            and is_video_generation_request(msg.content, msg.metadata)
        ):
            activate_capabilities({"video"})
        if self.tools.is_visible("generate_image"):
            activate_capabilities({"skill_resources"})
        messages = self.context.build_messages(
            history=history,
            current_message=video_generation_prompt(
                image_generation_prompt(msg.content, msg.metadata),
                msg.metadata,
                media=msg.media,
            ),
            skill_names=(
                ["image-generation"]
                if self.tools.is_visible("generate_image")
                else None
            ),
            media=msg.media if msg.media else None,
            channel=msg.channel,
            chat_id=self._runtime_chat_id(msg),
            sender_id=msg.sender_id,
            session_summary=pending_summary,
            session_metadata=session.metadata,
            message_metadata=msg.metadata,
            tool_names=(
                {item["function"]["name"] for item in self.tools.get_definitions()}
                if self.tools.has("load_capability") else None
            ),
        )
        messages = self._append_room_members_context(messages, session)
        return self._append_mona_direct_mention_boundary(messages, msg, session)

    @staticmethod
    def _routing_agent_ids(value: Any) -> set[str]:
        """Normalize router-owned agent ID metadata without trusting its shape."""
        if not isinstance(value, (list, tuple, set, frozenset)):
            return set()
        from mona.agent.partners import normalize_agent_id

        normalized: set[str] = set()
        for raw in value:
            if not isinstance(raw, str):
                continue
            try:
                normalized.add(normalize_agent_id(raw))
            except ValueError:
                continue
        return normalized

    def _append_mona_direct_mention_boundary(
        self,
        messages: list[dict[str, Any]],
        msg: InboundMessage,
        session: Session,
    ) -> list[dict[str, Any]]:
        """Scope Mona when partners were already dispatched from this turn.

        The boundary is added only to the ephemeral model input. The original
        user message and its persisted representation remain unchanged.
        """
        if (
            not messages
            or getattr(self, "_partner_agent_id", None) is not None
            or session.conversation_metadata.type != "room"
        ):
            return messages
        from mona.agent.partners import MONA_AGENT_ID
        from mona.agent.tools.context import (
            DIRECT_TARGET_AGENT_IDS_META,
            PARTNER_JOBS_DISPATCHED_META,
        )

        metadata = msg.metadata if isinstance(msg.metadata, dict) else {}
        direct_targets = self._routing_agent_ids(metadata.get(DIRECT_TARGET_AGENT_IDS_META))
        dispatched_targets = self._routing_agent_ids(metadata.get(PARTNER_JOBS_DISPATCHED_META))
        if MONA_AGENT_ID not in direct_targets or not dispatched_targets:
            return messages
        first = messages[0]
        if first.get("role") != "system" or not isinstance(first.get("content"), str):
            return messages
        result = list(messages)
        result[0] = {
            **first,
            "content": (
                f"{first['content']}\n\n"
                "# Internal direct-mention boundary\n"
                "本轮用户同时直接 @ 了多个群成员。你当前只以 Mona 身份回答属于 Mona 的部分；"
                "不要介绍、代答或模拟其他被直接 @ 的成员。已由路由器直接派发的成员正在独立回答，"
                "不要再次委派这些成员。"
            ),
        }
        return result

    async def _dispatch_command_inline(
        self,
        msg: InboundMessage,
        key: str,
        raw: str,
        dispatch_fn: Callable[[CommandContext], Awaitable[OutboundMessage | None]],
    ) -> None:
        """Dispatch a command directly from the run() loop and publish the result."""
        ctx = CommandContext(msg=msg, session=None, key=key, raw=raw, loop=self)
        result = await dispatch_fn(ctx)
        if result:
            await self.bus.publish_outbound(result)
        else:
            logger.warning("Command '{}' matched but dispatch returned None", raw)
        active_tasks = self._active_tasks.get(key, ())
        # Inline commands bypass _dispatch; close their idle WebUI turn without
        # finalizing a model turn that is still running for the same session.
        if msg.channel == "websocket" and not any(not task.done() for task in active_tasks):
            await self._webui_turns.handle_turn_end(
                msg,
                session_key=key,
                latency_ms=None,
            )
            await self._webui_turns.publish_run_status(msg, "idle")

    # Grace period a cancelled task gets to unwind before /stop reports it
    # as force-detached instead of cleanly stopped.
    CANCEL_ACTIVE_TASKS_WAIT_SECONDS = 5.0

    async def _cancel_active_tasks(self, key: str) -> int:
        """Cancel and await all active tasks and subagents for *key*.

        Returns the total number of cancelled tasks + subagents.
        """
        from mona.computer_use.session import (
            mark_computer_turn_stopped,
            stop_computer_turns,
        )

        mark_computer_turn_stopped(key)
        tasks = [task for task in self._active_tasks.get(key, []) if not task.done()]
        cancelled = sum(1 for t in tasks if not t.done() and t.cancel())

        async def _wait_for_turns() -> None:
            if not tasks:
                return
            done, pending = await asyncio.wait(
                tasks, timeout=self.CANCEL_ACTIVE_TASKS_WAIT_SECONDS
            )
            if done:
                await asyncio.gather(*done, return_exceptions=True)
            if pending:
                logger.warning(
                    "{} active task(s) did not stop within {}s for session {}",
                    len(pending),
                    self.CANCEL_ACTIVE_TASKS_WAIT_SECONDS,
                    key,
                )

        from mona.agent.tools.exec_session import DEFAULT_EXEC_SESSION_MANAGER
        from mona.agent.tools.terminal import cancel_terminal_tasks_by_session

        _, sub_cancelled, process_cancelled, _, terminal_cancelled = await asyncio.gather(
            _wait_for_turns(),
            self.subagents.cancel_by_session(key),
            DEFAULT_EXEC_SESSION_MANAGER.cancel_by_session(key),
            stop_computer_turns(key),
            cancel_terminal_tasks_by_session(key),
        )
        return cancelled + sub_cancelled + process_cancelled + terminal_cancelled

    def _count_uncancelled_tasks(self, keys: list[str]) -> int:
        """Return turn tasks for *keys* still running after a cancel request.

        A task that ignores cancellation never reaches its ``finally`` block,
        so the run status stays "running" forever unless /stop force-resets it.
        """
        return sum(
            1
            for key in keys
            for task in self._active_tasks.get(key, [])
            if not task.done()
        )

    def _effective_session_key(self, msg: InboundMessage) -> str:
        """Return the session key used for task routing and mid-turn injections."""
        if self._unified_session and not msg.session_key_override:
            return UNIFIED_SESSION_KEY
        return msg.session_key

    def _replay_token_budget(self) -> int:
        """Derive a token budget for session history replay from the context window."""
        if self.context_window_tokens <= 0:
            return 0
        max_output = getattr(getattr(self.provider, "generation", None), "max_tokens", 4096)
        try:
            reserved_output = int(max_output)
        except (TypeError, ValueError):
            reserved_output = 4096
        budget = self.context_window_tokens - max(1, reserved_output) - 1024
        return budget if budget > 0 else max(128, self.context_window_tokens // 2)

    async def _run_agent_loop(
        self,
        initial_messages: list[dict],
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        on_retry_wait: Callable[[str], Awaitable[None]] | None = None,
        *,
        session: Session | None = None,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        session_key: str | None = None,
        pending_queue: asyncio.Queue | None = None,
        return_detected_context_window: bool = False,
    ) -> tuple[str | None, list[str], list[dict], str, bool] | tuple[
        str | None, list[str], list[dict], str, bool, int | None
    ]:
        """Run the agent iteration loop.

        *on_stream*: called with each content delta during streaming.
        *on_stream_end(resuming)*: called when a streaming session finishes.
        ``resuming=True`` means tool calls follow (spinner should restart);
        ``resuming=False`` means this is the final response.

        Returns (final_content, tools_used, messages, stop_reason, had_injections).
        """
        self._sync_subagent_runtime_limits()

        from mona.computer_use.session import get_computer_turn

        computer_turn = get_computer_turn()
        if computer_turn is not None:
            computer_turn.progress = on_progress

        loop_hook = AgentProgressHook(
            on_progress=on_progress,
            on_stream=on_stream,
            on_stream_end=on_stream_end,
            channel=channel,
            chat_id=chat_id,
            message_id=message_id,
            metadata=metadata,
            session_key=session_key,
            tool_hint_max_length=self.tool_hint_max_length,
            set_tool_context=partial(
                self._set_tool_context, session=session, reset_capabilities=False,
            ),
            on_iteration=lambda iteration: setattr(self, "_current_iteration", iteration),
        )
        hook: AgentHook = (
            CompositeHook([loop_hook] + self._extra_hooks) if self._extra_hooks else loop_hook
        )

        async def _checkpoint(payload: dict[str, Any]) -> None:
            if session is None:
                return
            self._set_runtime_checkpoint(session, payload)

        async def _drain_pending(*, limit: int = _MAX_INJECTIONS_PER_TURN) -> list[dict[str, Any]]:
            """Drain follow-up messages from the pending queue.

            When no messages are immediately available but sub-agents
            spawned in this dispatch are still running, blocks until at
            least one result arrives (or timeout).  This keeps the runner
            loop alive so subsequent sub-agent completions are consumed
            in-order rather than dispatched separately.
            """
            if pending_queue is None:
                return []

            def _to_user_message(pending_msg: InboundMessage) -> dict[str, Any]:
                content = pending_msg.content
                media = pending_msg.media if pending_msg.media else None
                if media:
                    content, media = extract_documents(content, media)
                    media = media or None
                user_content = self.context._build_user_content(content, media)
                return {"role": "user", "content": user_content}

            items: list[dict[str, Any]] = []
            while len(items) < limit:
                try:
                    items.append(_to_user_message(pending_queue.get_nowait()))
                except asyncio.QueueEmpty:
                    break

            # Block if nothing drained but sub-agents spawned in this dispatch
            # are still running.  Direct @Agent jobs post their own room result
            # instead of injecting one, so also stop waiting once they finish.
            if (
                not items
                and session is not None
                and self.subagents.get_running_count_by_session(session.key) > 0
            ):
                deadline = asyncio.get_running_loop().time() + 300
                while self.subagents.get_running_count_by_session(session.key) > 0:
                    try:
                        msg = await asyncio.wait_for(
                            pending_queue.get(),
                            timeout=min(0.25, deadline - asyncio.get_running_loop().time()),
                        )
                    except asyncio.TimeoutError:
                        if asyncio.get_running_loop().time() < deadline:
                            continue
                        logger.warning(
                            "Timeout waiting for sub-agent completion in session {}",
                            session.key,
                        )
                        break
                    items.append(_to_user_message(msg))
                    while len(items) < limit:
                        try:
                            items.append(_to_user_message(pending_queue.get_nowait()))
                        except asyncio.QueueEmpty:
                            break
                    break

            return items

        active_session_key = session.key if session else session_key
        file_state_token = bind_file_states(self._file_state_store.for_session(active_session_key))
        # AgentRunSpec.workspace is read from the contextvar so subagents
        # spawned via asyncio.create_task inherit the caller's workspace.
        from mona.agent.tools.path_utils import get_current_workspace

        effective_ws = get_current_workspace(self.workspace)
        try:
            temperature, max_tokens, reasoning_effort = self._mona_generation_overrides
            result = await self.runner.run(
                AgentRunSpec(
                    initial_messages=initial_messages,
                    tools=self.tools,
                    model=self.model,
                    max_iterations=self.max_iterations,
                    max_tool_result_chars=self.max_tool_result_chars,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    reasoning_effort=reasoning_effort,
                    hook=hook,
                    error_message="Sorry, I encountered an error calling the AI model.",
                    concurrent_tools=True,
                    workspace=effective_ws,
                    session_key=session.key if session else None,
                    context_window_tokens=self.context_window_tokens,
                    context_block_limit=self.context_block_limit,
                    provider_retry_mode=self.provider_retry_mode,
                    progress_callback=on_progress,
                    stream_progress_deltas=on_stream is not None,
                    retry_wait_callback=on_retry_wait,
                    checkpoint_callback=_checkpoint,
                    injection_callback=_drain_pending,
                    repeat_guard_enabled=True,
                    # Sustained goals may legitimately exceed mona_LLM_TIMEOUT_S; idle stall
                    # is still capped by mona_STREAM_IDLE_TIMEOUT_S in streaming providers.
                    llm_timeout_s=runner_wall_llm_timeout_s(
                        self.sessions,
                        session.key if session is not None else session_key,
                        metadata=(session.metadata if session is not None else None),
                    ),
                )
            )
        finally:
            reset_file_states(file_state_token)
            from mona.computer_use.session import finish_computer_turn

            await finish_computer_turn()
        self._last_usage = dict(result.usage)
        # ``usage`` is cumulative across this run's LLM calls (billing view);
        # ``context_tokens`` carries the last call's prompt size so the WebUI
        # can show how full the context window actually is.
        final_prompt = (result.final_usage or {}).get("prompt_tokens")
        if final_prompt:
            self._last_usage["context_tokens"] = int(final_prompt)
        if result.stop_reason in {"max_iterations", "loop_detected"}:
            if result.stop_reason == "max_iterations":
                logger.warning("Max iterations ({}) reached", self.max_iterations)
            else:
                logger.warning("Tool loop detected; forced tool-free finalization")
            # Push final content through stream so streaming channels (e.g. Feishu)
            # update the card instead of leaving it empty.
            if on_stream and on_stream_end:
                await on_stream(result.final_content or "")
                await on_stream_end(resuming=False)
        elif result.stop_reason == "error":
            logger.error("LLM returned error: {}", (result.final_content or "")[:200])
        outcome = (
            result.final_content,
            result.tools_used,
            result.messages,
            result.stop_reason,
            result.had_injections,
        )
        if return_detected_context_window:
            return (*outcome, result.detected_context_window_tokens)
        return outcome

    async def run(self) -> None:
        """Run the agent loop, dispatching messages as tasks to stay responsive to /stop."""
        self._running = True
        await self._connect_mcp()
        # Reconcile non-terminal agent jobs left over from a previous process:
        # queued jobs relaunch, running jobs are marked failed (guide 7.4).
        self._schedule_background(self.subagents.recover_jobs())
        # Same reconciliation for workflow runs (guide 7.6): waiting approvals
        # survive, interrupted running runs fail, never-started runs resume.
        self._schedule_background(self.subagents.recover_workflow_runs())
        logger.info("Agent loop started")

        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)
            except asyncio.TimeoutError:
                self.auto_compact.check_expired(
                    self._schedule_background,
                    active_session_keys=self._pending_queues.keys(),
                )
                continue
            except asyncio.CancelledError:
                # Preserve real task cancellation so shutdown can complete cleanly.
                # Only ignore non-task CancelledError signals that may leak from integrations.
                if not self._running or asyncio.current_task().cancelling():
                    raise
                continue
            except Exception as e:
                logger.warning("Error consuming inbound message: {}, continuing...", e)
                continue

            raw = msg.content.strip()
            if self.commands.is_priority(raw):
                priority_key = self._effective_session_key(msg)
                await self._dispatch_command_inline(
                    msg,
                    priority_key,
                    raw,
                    self.commands.dispatch_priority,
                )
                continue
            effective_key = self._effective_session_key(msg)
            # If this session already has an active pending queue (i.e. a task
            # is processing this session), route the message there for mid-turn
            # injection instead of creating a competing task.
            if effective_key in self._pending_queues:
                # Non-priority commands must not be queued for injection;
                # dispatch them directly (same pattern as priority commands).
                if self.commands.is_dispatchable_command(raw):
                    await self._dispatch_command_inline(
                        msg,
                        effective_key,
                        raw,
                        self.commands.dispatch,
                    )
                    continue
                pending_msg = msg
                if effective_key != msg.session_key:
                    pending_msg = dataclasses.replace(
                        msg,
                        session_key_override=effective_key,
                    )
                try:
                    self._pending_queues[effective_key].put_nowait(pending_msg)
                except asyncio.QueueFull:
                    logger.warning(
                        "Pending queue full for session {}, falling back to queued task",
                        effective_key,
                    )
                else:
                    logger.debug(
                        "Routed follow-up message to pending queue for session {}",
                        effective_key,
                    )
                    continue
            # Compute the effective session key before dispatching
            # This ensures /stop command can find tasks correctly when unified session is enabled
            task = asyncio.create_task(self._dispatch(msg))
            self._active_tasks.setdefault(effective_key, []).append(task)
            task.add_done_callback(
                lambda t, k=effective_key: (
                    self._active_tasks.get(k, []) and self._active_tasks[k].remove(t)
                    if t in self._active_tasks.get(k, [])
                    else None
                )
            )

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message: per-session serial, cross-session concurrent."""
        session_key = self._effective_session_key(msg)
        if session_key != msg.session_key:
            msg = dataclasses.replace(msg, session_key_override=session_key)
        lock = self._session_locks.setdefault(session_key, asyncio.Lock())
        gate = self._concurrency_gate or nullcontext()

        # Register a pending queue so follow-up messages for this session are
        # routed here (mid-turn injection) instead of spawning a new task.
        pending = asyncio.Queue(maxsize=20)
        self._pending_queues[session_key] = pending

        try:
            async with lock, gate:
                try:
                    on_stream = on_stream_end = None
                    if msg.metadata.get("_wants_stream"):
                        # Split one answer into distinct stream segments.
                        stream_base_id = f"{msg.session_key}:{time.time_ns()}"
                        stream_segment = 0

                        def _current_stream_id() -> str:
                            return f"{stream_base_id}:{stream_segment}"

                        async def on_stream(delta: str) -> None:
                            meta = dict(msg.metadata or {})
                            meta["_stream_delta"] = True
                            meta["_stream_id"] = _current_stream_id()
                            await self.bus.publish_outbound(
                                OutboundMessage(
                                    channel=msg.channel,
                                    chat_id=msg.chat_id,
                                    content=delta,
                                    metadata=meta,
                                )
                            )

                        async def on_stream_end(*, resuming: bool = False) -> None:
                            nonlocal stream_segment
                            meta = dict(msg.metadata or {})
                            meta["_stream_end"] = True
                            meta["_resuming"] = resuming
                            meta["_stream_id"] = _current_stream_id()
                            await self.bus.publish_outbound(
                                OutboundMessage(
                                    channel=msg.channel,
                                    chat_id=msg.chat_id,
                                    content="",
                                    metadata=meta,
                                )
                            )
                            stream_segment += 1

                    response = await self._process_message(
                        msg,
                        on_stream=on_stream,
                        on_stream_end=on_stream_end,
                        pending_queue=pending,
                    )
                    if response is not None:
                        await self.bus.publish_outbound(response)
                    elif msg.channel == "cli":
                        await self.bus.publish_outbound(
                            OutboundMessage(
                                channel=msg.channel,
                                chat_id=msg.chat_id,
                                content="",
                                metadata=msg.metadata or {},
                            )
                        )
                    if msg.channel == "websocket":
                        turn_lat = self._pending_turn_latency_ms.pop(session_key, None)
                        turn_usage = self._pending_turn_usage.pop(session_key, None)
                        await self._webui_turns.handle_turn_end(
                            msg,
                            session_key=session_key,
                            latency_ms=turn_lat,
                            token_usage=turn_usage,
                        )
                except asyncio.CancelledError:
                    logger.info("Task cancelled for session {}", session_key)
                    # Preserve partial context from the interrupted turn so
                    # the user does not lose tool results and assistant
                    # messages accumulated before /stop.  The checkpoint was
                    # already persisted to session metadata by
                    # _emit_checkpoint during tool execution; materializing
                    # it into session history now makes it visible in the
                    # next conversation turn.
                    try:
                        key = self._effective_session_key(msg)
                        session = self.sessions.get_or_create(key)
                        if self._restore_runtime_checkpoint(session):
                            self._clear_pending_user_turn(session)
                            self.sessions.save(session)
                            logger.info(
                                "Restored partial context for cancelled session {}",
                                key,
                            )
                    except Exception:
                        logger.debug(
                            "Could not restore checkpoint for cancelled session {}",
                            session_key,
                            exc_info=True,
                        )
                    raise
                except Exception:
                    logger.exception("Error processing message for session {}", session_key)
                    await self.bus.publish_outbound(
                        OutboundMessage(
                            channel=msg.channel,
                            chat_id=msg.chat_id,
                            content="Sorry, I encountered an error.",
                        )
                    )
        finally:
            # Drain any messages still in the pending queue and re-publish
            # them to the bus so they are processed as fresh inbound messages
            # rather than silently lost.
            queue = self._pending_queues.pop(session_key, None)
            if queue is not None:
                leftover = 0
                while True:
                    try:
                        item = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    await self.bus.publish_inbound(item)
                    leftover += 1
                if leftover:
                    logger.info(
                        "Re-published {} leftover message(s) to bus for session {}",
                        leftover,
                        session_key,
                    )
            await self._webui_turns.publish_run_status(msg, "idle")
            self._pending_turn_latency_ms.pop(session_key, None)
            self._pending_turn_usage.pop(session_key, None)
            self._webui_turns.discard(session_key)

    async def close_mcp(self) -> None:
        """Drain pending background archives, then close MCP connections."""
        if self._background_tasks:
            await asyncio.gather(*self._background_tasks, return_exceptions=True)
            self._background_tasks.clear()
        for name, stack in self._mcp_stacks.items():
            try:
                await stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                logger.debug("MCP server '{}' cleanup error (can be ignored)", name)
        self._mcp_stacks.clear()

    def _live_computer_permission(self) -> bool:
        from mona.agent.user_config import load_agent_user_config
        from mona.computer_use.runtime import COMPUTER_PERMISSION_TOOL_NAMES

        user = load_agent_user_config(getattr(self, "_partner_agent_id", "mona"))
        return user.enabled and user.granted_tools is not None and set(COMPUTER_PERMISSION_TOOL_NAMES) <= set(user.granted_tools)

    async def _sync_computer_use_runtime(self) -> None:
        if hasattr(self, "_profile"):
            return
        from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME
        from mona.computer_use.runtime import (
            COMPUTER_PERMISSION_TOOL_NAMES,
            get_cua_driver_manager,
        )

        effective = (
            getattr(self, "_effective_config", None)
            if hasattr(self, "_partner_agent_id")
            else getattr(self, "_mona_effective_config", None)
        )
        allowed = getattr(effective, "allowed_tools", None)
        enabled = allowed is not None and set(COMPUTER_PERMISSION_TOOL_NAMES) <= set(allowed)
        async with self._computer_use_connection_lock:
            if not enabled:
                if BUILTIN_COMPUTER_SERVER_NAME in self._mcp_servers:
                    await self.remove_mcp_server(BUILTIN_COMPUTER_SERVER_NAME)
                return

            manager = get_cua_driver_manager()
            if manager.executable is None:
                await manager.start_install()
                status = await manager.wait_install()
            else:
                manager.set_connection_result(None)
                status = await manager.refresh_health()
            if status.get("state") != "available":
                return
            if BUILTIN_COMPUTER_SERVER_NAME in self._mcp_stacks:
                manager.set_connection_result(None)
                return
            if BUILTIN_COMPUTER_SERVER_NAME in self._mcp_servers:
                result = await self.restart_mcp_server(BUILTIN_COMPUTER_SERVER_NAME)
            else:
                result = await self.add_mcp_server(
                    BUILTIN_COMPUTER_SERVER_NAME,
                    manager.mcp_config(),
                )
            manager.set_connection_result(
                None
                if result.get("ok")
                else str(result.get("error") or "MCP connection failed")
            )

    # ------------------------------------------------------------------
    # MCP server runtime management (settings panel)
    # ------------------------------------------------------------------

    def _unregister_mcp_server_tools(self, name: str) -> None:
        """Unregister all tools/resources/prompts belonging to a MCP server."""
        from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

        prefix = "computer_" if name == BUILTIN_COMPUTER_SERVER_NAME else f"mcp_{name}_"
        for tool_name in list(self.tools.tool_names):
            if tool_name.startswith(prefix):
                self.tools.unregister(tool_name)

    def get_mcp_status(self) -> list[dict[str, Any]]:
        """Return per-server status: name / connected / transport / tool_count / ..."""
        from mona.agent.tools.mcp import list_mcp_server_tools

        rows: list[dict[str, Any]] = []
        for name, cfg in self._mcp_servers.items():
            connected = name in self._mcp_stacks
            transport = cfg.type
            if not transport:
                if cfg.command:
                    transport = "stdio"
                elif cfg.url:
                    transport = "sse" if cfg.url.rstrip("/").endswith("/sse") else "streamableHttp"
                else:
                    transport = "unknown"
            tool_count = len(list_mcp_server_tools(self.tools, name)) if connected else 0
            rows.append(
                {
                    "name": name,
                    "connected": connected,
                    "transport": transport,
                    "toolCount": tool_count,
                    "toolTimeout": cfg.tool_timeout,
                    "enabledTools": list(cfg.enabled_tools) if cfg.enabled_tools else ["*"],
                }
            )
        return rows

    async def _reconnect_mcp_server_tools(self, name: str):
        """Rebuild one MCP server and map its original tool names to new wrappers.

        Passed to the tool wrappers as their reconnect callback: when a stdio
        transport dies mid-call there is no way to salvage the old session, so
        the server process is replaced and the triggering call is retried on the
        fresh wrapper.
        """
        from mona.agent.tools.mcp import collect_mcp_tool_wrappers

        async with self._mcp_reconnect_lock:
            result = await self.restart_mcp_server(name)
            if not result.get("ok"):
                logger.warning("MCP server '{}' reconnect failed: {}", name, result.get("error"))
                return None
            return collect_mcp_tool_wrappers(self.tools, name)

    async def restart_mcp_server(self, name: str) -> dict[str, Any]:
        """Close + reconnect a single MCP server without touching others."""
        from mona.agent.tools.mcp import connect_single_mcp_server, list_mcp_server_tools

        if name not in self._mcp_servers:
            return {"ok": False, "name": name, "error": "Server not configured"}
        cfg = self._mcp_servers[name]

        # 1. Close existing stack (if any)
        old_stack = self._mcp_stacks.pop(name, None)
        if old_stack is not None:
            try:
                await old_stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                logger.debug("MCP server '{}' old stack cleanup error on restart", name)
        # 2. Unregister tools
        self._unregister_mcp_server_tools(name)
        # 3. Reconnect
        try:
            stack = await connect_single_mcp_server(
                name,
                cfg,
                self.tools,
                self._reconnect_mcp_server_tools,
                computer_provider=self.provider,
                computer_model=self.model,
                runtime_config_loader=self._runtime_config_loader,
                computer_provider_loader=lambda: (self.provider, self.model),
                computer_permission_check=self._live_computer_permission,
            )
        except Exception as e:
            logger.exception("[mcp] restart '{}' failed", name)
            return {"ok": False, "name": name, "error": str(e)}
        if stack is None:
            return {"ok": False, "name": name, "error": "Connection failed (see logs)"}
        self._mcp_stacks[name] = stack
        self._mcp_connected = True
        tool_count = len(list_mcp_server_tools(self.tools, name))
        return {
            "ok": True,
            "name": name,
            "connected": True,
            "toolCount": tool_count,
        }

    async def reload_mcp(self) -> dict[str, Any]:
        """Close all MCP stacks and reconnect from current config."""
        # 1. Close all stacks
        for name, stack in list(self._mcp_stacks.items()):
            try:
                await stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                logger.debug("MCP server '{}' cleanup error on reload", name)
        self._mcp_stacks.clear()
        # 2. Unregister all MCP tools
        for tool_name in list(self.tools.tool_names):
            if tool_name.startswith(("mcp_", "computer_")):
                self.tools.unregister(tool_name)
        # 3. Reconnect
        self._mcp_connected = False
        await self._connect_mcp()
        return {
            "ok": True,
            "connectedCount": len(self._mcp_stacks),
            "totalConfigured": len(self._mcp_servers),
        }

    async def add_mcp_server(self, name: str, cfg) -> dict[str, Any]:
        """Add a new MCP server to runtime config and connect it immediately."""
        if name in self._mcp_servers:
            return {"ok": False, "name": name, "error": "Server already exists"}
        self._mcp_servers[name] = cfg
        return await self.restart_mcp_server(name)

    async def remove_mcp_server(self, name: str) -> dict[str, Any]:
        """Disconnect + unregister + remove a MCP server from runtime config."""
        if name not in self._mcp_servers:
            return {"ok": False, "name": name, "error": "Server not configured"}
        stack = self._mcp_stacks.pop(name, None)
        if stack is not None:
            try:
                await stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                logger.debug("MCP server '{}' cleanup error on remove", name)
        self._unregister_mcp_server_tools(name)
        del self._mcp_servers[name]
        return {"ok": True, "name": name}

    def _schedule_background(self, coro) -> None:
        """Schedule a coroutine as a tracked background task (drained on shutdown)."""
        task = asyncio.create_task(coro)
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

    async def _process_system_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        pending_queue: asyncio.Queue | None = None,
    ) -> OutboundMessage | None:
        """Process a system inbound message (e.g. subagent announce)."""
        channel, chat_id = msg.chat_id.split(":", 1) if ":" in msg.chat_id else ("cli", msg.chat_id)
        logger.debug("Processing system message from {}", msg.sender_id)
        key = msg.session_key_override or f"{channel}:{chat_id}"
        session = self.sessions.get_or_create(key)
        if self._restore_runtime_checkpoint(session):
            self.sessions.save(session)
        if self._restore_pending_user_turn(session):
            self.sessions.save(session)

        session, pending = self.auto_compact.prepare_session(session, key)
        if pending:
            logger.info("Memory compact triggered for session {}", key)

        await self.consolidator.maybe_consolidate_by_tokens(
            session,
            replay_max_messages=self._max_messages,
        )
        is_subagent = msg.sender_id == "subagent"
        if is_subagent and self._persist_subagent_followup(session, msg):
            logger.debug("Subagent result persisted for session {}", key)
            self.sessions.save(session)
        self._set_tool_context(
            channel,
            chat_id,
            msg.metadata.get("message_id"),
            msg.metadata,
            session_key=key,
            session=session,
        )
        _hist_kwargs: dict[str, Any] = {
            "max_messages": self._max_messages,
            "max_tokens": self._replay_token_budget(),
            "include_timestamps": True,
        }
        history = self._build_model_history(session, **_hist_kwargs)
        current_role = "assistant" if is_subagent else "user"

        ws_token = set_current_workspace(self._effective_workspace(session))
        try:
            messages = self.context.build_messages(
                history=history,
                current_message="" if is_subagent else msg.content,
                channel=channel,
                chat_id=chat_id,
                current_role=current_role,
                sender_id=msg.sender_id,
                session_summary=pending,
                session_metadata=session.metadata,
                message_metadata=msg.metadata,
            )
            messages = self._append_room_members_context(messages, session)
            messages = self._append_mona_direct_mention_boundary(messages, msg, session)
            t_wall = time.time()
            final_content, _, all_msgs, stop_reason, _ = await self._run_agent_loop(
                messages,
                session=session,
                channel=channel,
                chat_id=chat_id,
                message_id=msg.metadata.get("message_id"),
                metadata=msg.metadata,
                session_key=key,
                pending_queue=pending_queue,
            )
        finally:
            reset_current_workspace(ws_token)
        wall_done = time.time()
        latency_ms = max(0, int((wall_done - t_wall) * 1000))
        turn_usage = dict(self._last_usage)
        self._save_turn(
            session,
            all_msgs,
            1 + len(history),
            turn_latency_ms=latency_ms,
            token_usage=turn_usage,
            task_id=msg.metadata.get("task_id"),
        )
        if channel == "websocket":
            self._pending_turn_latency_ms[key] = latency_ms
            self._pending_turn_usage[key] = turn_usage
        session.enforce_file_cap(on_archive=self.context.memory.raw_archive)
        self._clear_runtime_checkpoint(session)
        self.sessions.save(session)
        self._schedule_background(
            self.consolidator.maybe_consolidate_by_tokens(
                session,
                replay_max_messages=self._max_messages,
            )
        )
        content = final_content or "Background task completed."
        outbound_metadata: dict[str, Any] = {}
        if turn_usage:
            outbound_metadata["token_usage"] = turn_usage
        if task_id := msg.metadata.get("task_id"):
            outbound_metadata["task_id"] = task_id
        if channel == "slack" and key.startswith("slack:") and key.count(":") >= 2:
            outbound_metadata["slack"] = {"thread_ts": key.split(":", 2)[2]}
        if origin_message_id := msg.metadata.get("origin_message_id"):
            outbound_metadata["origin_message_id"] = origin_message_id
        return OutboundMessage(
            channel=channel,
            chat_id=chat_id,
            content=content,
            metadata=outbound_metadata,
        )

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        pending_queue: asyncio.Queue | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response."""
        self._refresh_provider_snapshot()
        self._refresh_mona_user_config()
        self._refresh_media_generation_tools()

        if msg.channel == "system":
            return await self._process_system_message(
                msg,
                session_key=session_key,
                on_progress=on_progress,
                on_stream=on_stream,
                on_stream_end=on_stream_end,
                pending_queue=pending_queue,
            )

        await self._sync_computer_use_runtime()

        key = session_key or msg.session_key
        # Pre-fetch session so the workspace contextvar can be set for the
        # entire turn — identity rendering, _FsTool resolution, and AgentRunSpec
        # all read this contextvar.
        session = self.sessions.get_or_create(key)

        # Document agent routing: sessions tagged with agent_kind in
        # DOCUMENT_PROFILES are delegated to DocumentAgentLoop (focused tools,
        # profile-driven soul identity, no memory/history). The document loop
        # shares this loop's provider/sessions but has its own filtered tool
        # registry and DocumentContextBuilder.
        from mona.agent.document_loop import DOCUMENT_PROFILES

        message_agent_kind = msg.metadata.get("agent_kind")
        agent_kind = message_agent_kind or session.metadata.get("agent_kind")
        if agent_kind and agent_kind in DOCUMENT_PROFILES and not hasattr(self, "_profile"):
            doc_loop = self._ensure_document_loop(agent_kind)
            return await doc_loop._process_message(
                msg,
                session_key=key,
                on_progress=on_progress,
                on_stream=on_stream,
                on_stream_end=on_stream_end,
                pending_queue=pending_queue,
            )

        # Partner agent routing: a direct chat with a partner agent executes
        # under that agent's own identity (PartnerAgentLoop) — its package
        # prompt, private memory/skills and manifest-filtered tools — instead
        # of the reserved Mona identity. Partner loops carry
        # ``_partner_agent_id`` and skip this branch, so delegation never
        # recurses. When the agent is uninstalled/disabled the turn is answered
        # with an explicit unavailable notice — identity never falls back to Mona.
        from mona.agent.partners import MONA_AGENT_ID

        conversation = session.conversation_metadata
        if (
            conversation.type == "direct"
            and conversation.direct_agent_id is not None
            and conversation.direct_agent_id != MONA_AGENT_ID
            and not hasattr(self, "_partner_agent_id")
        ):
            partner_loop = self._ensure_partner_loop(conversation.direct_agent_id)
            if partner_loop is not None:
                return await partner_loop._process_message(
                    msg,
                    session_key=key,
                    on_progress=on_progress,
                    on_stream=on_stream,
                    on_stream_end=on_stream_end,
                    pending_queue=pending_queue,
                )
            return await self._partner_unavailable_notice(
                msg,
                session,
                conversation.direct_agent_id,
                on_stream=on_stream,
                on_stream_end=on_stream_end,
            )

        ctx = TurnContext(
            msg=msg,
            session=session,
            session_key=key,
            state=TurnState.RESTORE,
            turn_id=f"{key}:{time.time_ns()}",
            on_progress=on_progress,
            on_stream=on_stream,
            on_stream_end=on_stream_end,
            pending_queue=pending_queue,
        )

        ws_token = set_current_workspace(self._effective_workspace(session))
        try:
            while ctx.state is not TurnState.DONE:
                handler_name = f"_state_{ctx.state.name.lower()}"
                handler = getattr(self, handler_name, None)
                if handler is None:
                    raise RuntimeError(f"Missing state handler for {ctx.state}")

                t0 = time.perf_counter()
                try:
                    event = await handler(ctx)
                except Exception:
                    duration = (time.perf_counter() - t0) * 1000
                    ctx.trace.append(
                        StateTraceEntry(
                            state=ctx.state,
                            started_at=t0,
                            duration_ms=duration,
                            event="",
                            error="exception",
                        )
                    )
                    raise

                duration = (time.perf_counter() - t0) * 1000
                ctx.trace.append(
                    StateTraceEntry(
                        state=ctx.state,
                        started_at=t0,
                        duration_ms=duration,
                        event=event,
                    )
                )
                logger.debug(
                    "[turn {}] State {} took {:.1f}ms -> event {}",
                    ctx.turn_id,
                    ctx.state.name,
                    duration,
                    event,
                )

                next_state = self._TRANSITIONS.get((ctx.state, event))
                if next_state is None:
                    raise RuntimeError(
                        f"[turn {ctx.turn_id}] No transition from {ctx.state} on event {event!r}"
                    )
                ctx.state = next_state
        finally:
            reset_current_workspace(ws_token)

        logger.debug(
            "[turn {}] Turn completed after {} states",
            ctx.turn_id,
            len(ctx.trace),
        )
        return ctx.outbound

    def _assemble_outbound(
        self,
        msg: InboundMessage,
        final_content: str,
        all_msgs: list[dict[str, Any]],
        stop_reason: str,
        had_injections: bool,
        on_stream: Callable[[str], Awaitable[None]] | None,
        *,
        turn_latency_ms: int | None = None,
        token_usage: dict[str, int] | None = None,
        delivered_files: list[dict[str, Any]] | None = None,
        task_plan: dict[str, Any] | None = None,
    ) -> OutboundMessage | None:
        """Assemble the final outbound message from turn results."""
        # MessageTool suppression
        if (mt := self.tools.get("message")) and isinstance(mt, MessageTool) and mt._sent_in_turn:
            if not delivered_files and (
                not had_injections or stop_reason == "empty_final_response"
            ):
                return None

        preview = final_content[:120] + "..." if len(final_content) > 120 else final_content
        logger.debug("Response to {}:{}: {}", msg.channel, msg.sender_id, preview)

        meta = dict(msg.metadata or {})
        meta.pop(DELIVER_FILES_PENDING_META, None)
        if on_stream is not None and stop_reason not in {"error", "tool_error"}:
            meta["_streamed"] = True
        if turn_latency_ms is not None:
            meta["latency_ms"] = int(turn_latency_ms)
        if token_usage:
            meta["token_usage"] = dict(token_usage)
        if delivered_files:
            meta["_deliver_files"] = list(delivered_files)
        if task_plan is not None:
            meta["task_plan"] = task_plan

        already_sent_media = (
            set(mt.turn_delivered_media_paths()) if isinstance(mt, MessageTool) else set()
        )
        media = [
            path
            for path in previewable_delivered_media(delivered_files)
            if path not in already_sent_media
        ]

        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=final_content,
            media=media,
            metadata=meta,
        )

    async def _state_restore(self, ctx: TurnContext) -> TurnState:
        """Restore checkpoint / pending user turn; extract documents."""
        msg = ctx.msg

        if msg.media:
            active_workspace = get_current_workspace(self.workspace)
            staged_media: list[str] = []
            staged_attachment_paths: list[str] = []
            for raw_path in msg.media:
                source = Path(raw_path).expanduser()
                try:
                    if not source.is_file():
                        staged_media.append(raw_path)
                        continue
                    with source.open("rb") as stream:
                        is_image = detect_image_mime(stream.read(16)) is not None
                    resolved_source = source.resolve()
                    if is_image or active_workspace is None:
                        staged_media.append(str(resolved_source))
                        continue
                    workspace_root = active_workspace.expanduser().resolve()
                    try:
                        resolved_source.relative_to(workspace_root)
                        staged_media.append(str(resolved_source))
                        staged_attachment_paths.append(
                            resolved_source.relative_to(workspace_root).as_posix()
                        )
                        continue
                    except ValueError:
                        pass
                    attachment_dir = (
                        workspace_root
                        / ".mona"
                        / "attachments"
                        / safe_filename(ctx.session_key)
                    )
                    attachment_dir.mkdir(parents=True, exist_ok=True)
                    destination = attachment_dir / (safe_filename(source.name) or "attachment")
                    shutil.copy2(resolved_source, destination)
                    staged = destination.resolve()
                    staged_media.append(str(staged))
                    staged_attachment_paths.append(staged.relative_to(workspace_root).as_posix())
                except OSError:
                    logger.exception("Failed to stage attached file {}", source)
                    staged_media.append(raw_path)
            metadata = dict(msg.metadata)
            if staged_attachment_paths:
                metadata["_attachment_paths"] = staged_attachment_paths
            msg = dataclasses.replace(msg, media=staged_media, metadata=metadata)
            ctx.msg = msg
            new_content, image_only = extract_documents(msg.content, msg.media)
            ctx.msg = dataclasses.replace(msg, content=new_content, media=image_only)
            msg = ctx.msg

        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.debug("Processing message from {}:{}: {}", msg.channel, msg.sender_id, preview)

        # Session is already fetched by the caller (_process_message) but
        # ensure it exists in case this handler is invoked independently.
        if ctx.session is None:
            ctx.session = self.sessions.get_or_create(ctx.session_key)
        mark_webui_session(ctx.session, msg.metadata)

        if self._restore_runtime_checkpoint(ctx.session):
            self.sessions.save(ctx.session)
        if self._restore_pending_user_turn(ctx.session):
            self.sessions.save(ctx.session)

        return "ok"

    async def _state_compact(self, ctx: TurnContext) -> str:
        ctx.session, pending = self.auto_compact.prepare_session(ctx.session, ctx.session_key)
        ctx.pending_summary = pending
        return "ok"

    async def _state_command(self, ctx: TurnContext) -> str:
        raw = ctx.msg.content.strip()
        cmd_ctx = CommandContext(
            msg=ctx.msg, session=ctx.session, key=ctx.session_key, raw=raw, loop=self
        )
        result = await self.commands.dispatch(cmd_ctx)
        if result is not None:
            ctx.outbound = result
            # Shortcut commands skip BUILD and SAVE, so we must persist the
            # turn here so WebUI history hydration after _turn_end sees the
            # message.  Mark messages with _command so get_history can filter
            # them out of LLM context.  /new is excluded because it
            # intentionally clears the session.
            if raw.lower() != "/new":
                ctx.user_persisted_early = self._persist_user_message_early(
                    ctx.msg, ctx.session, _command=True
                )
                ctx.session.add_message("assistant", result.content, _command=True)
                self.sessions.save(ctx.session)
                self._clear_pending_user_turn(ctx.session)
            return "shortcut"
        return "dispatch"

    async def _state_build(self, ctx: TurnContext) -> str:
        if ctx.on_progress is None:
            ctx.on_progress = await self._build_bus_progress_callback(ctx.msg)

        async def report_compaction(active: bool) -> None:
            if ctx.msg.channel == "websocket" and ctx.on_progress is not None:
                await ctx.on_progress(
                    "正在整理上下文" if active else "",
                    context_compacting=active,
                )

        ctx.msg.metadata[DELIVER_FILES_PENDING_META] = ctx.delivered_files

        # Bind request-scoped tool state before token estimation and prompt
        # construction so both paths see the same capability set.
        # Fail-closed: any IPC error means no access to personal data.
        await self._refresh_subscription_access()

        self._set_tool_context(
            ctx.msg.channel,
            ctx.msg.chat_id,
            ctx.msg.metadata.get("message_id"),
            ctx.msg.metadata,
            session_key=ctx.session_key,
            session=ctx.session,
        )
        from mona.agent.tools.capabilities import activate_capabilities_for_media

        activate_capabilities_for_media(ctx.msg.media)

        await self.consolidator.maybe_consolidate_by_tokens(
            ctx.session,
            replay_max_messages=self._max_messages,
            current_message=ctx.msg.content,
            message_metadata=ctx.msg.metadata,
            on_compaction=report_compaction,
        )
        ctx.pending_summary = self.auto_compact.summary_for_session(
            ctx.session,
            ctx.session_key,
        )
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        _hist_kwargs: dict[str, Any] = {
            "max_messages": self._max_messages,
            "max_tokens": self._replay_token_budget(),
            "include_timestamps": True,
        }
        ctx.history = self._build_model_history(ctx.session, **_hist_kwargs)
        self._webui_turns.capture_title_context(
            ctx.session_key,
            ctx.msg,
            self.llm_runtime(),
        )

        ctx.initial_messages = self._build_initial_messages(
            ctx.msg, ctx.session, ctx.history, ctx.pending_summary
        )

        # When the user has no active subscription/trial, append a capability
        # note to the system prompt so the model knows notes/email search is
        # unavailable and does not hallucinate having queried them.
        if not self.tools.has_subscription_access:
            ctx.initial_messages = self._inject_capability_note(ctx.initial_messages)
        if self.tools.has("update_plan"):
            ctx.initial_messages = self._inject_task_plan_note(ctx.initial_messages)

        ctx.user_persisted_early = self._persist_user_message_early(ctx.msg, ctx.session)

        if ctx.on_retry_wait is None:
            ctx.on_retry_wait = await self._build_retry_wait_callback(ctx.msg)

        return "ok"

    async def _refresh_subscription_access(self) -> None:
        """Read the local license state and update the ToolRegistry.

        Called once at the start of each turn (in ``_state_build``). Uses
        ``asyncio.to_thread`` because ``tauri_invoke`` is a blocking HTTP
        call to the IPC bridge. Fail-closed: any error means no access.

        ``check_subscription_access`` caches its result with a short TTL, so
        mid-turn tool-level checks (e.g. hoard_search) reuse the same value
        without another IPC round-trip.
        """
        try:
            from mona.agent.tools.tauri_ipc import (
                check_subscription_access,
                invalidate_subscription_access_cache,
            )

            invalidate_subscription_access_cache()
            has_access = await asyncio.to_thread(check_subscription_access)
        except Exception as e:
            logger.debug("subscription access check failed, failing closed: {}", e)
            has_access = False

        self.tools.set_subscription_access(has_access)

    @staticmethod
    def _resolve_subagent_subscription_access() -> bool:
        """Resolve the same trusted, cached entitlement for out-of-band jobs.

        Direct room mentions can launch a named Agent without first entering
        Mona's normal turn builder, so reading only the parent registry's last
        value would incorrectly deny a freshly started subscribed session.
        """
        from mona.agent.tools.tauri_ipc import check_subscription_access

        return bool(check_subscription_access())

    @staticmethod
    def _inject_capability_note(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Append the free-tier capability note to the system prompt."""
        if not messages:
            return messages
        result = list(messages)
        first = result[0]
        if first.get("role") == "system":
            content = first.get("content", "")
            result[0] = {
                **first,
                "content": (
                    content + _FREE_TIER_CAPABILITY_NOTE if isinstance(content, str) else content
                ),
            }
        return result

    @staticmethod
    def _inject_task_plan_note(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not messages:
            return messages
        first = messages[0]
        if first.get("role") != "system" or not isinstance(first.get("content"), str):
            return messages
        result = list(messages)
        result[0] = {**first, "content": first["content"] + _TASK_PLAN_NOTE}
        return result

    async def _learn_context_window(self, tokens: int) -> bool:
        """Apply and persist a provider-confirmed smaller context window."""
        if tokens < 4_096 or tokens >= self.context_window_tokens:
            return False

        self.context_window_tokens = tokens
        self.consolidator.set_provider(
            self.provider,
            self.model,
            tokens,
            self.auto_compact_token_limit,
        )
        try:
            from mona.config.loader import load_config, save_config
            from mona.providers.context_window import record_discovered_context_window

            config = await asyncio.to_thread(load_config)
            configured_preset = config.resolve_preset(self._active_preset)
            if configured_preset.model != self.model:
                logger.warning(
                    "Learned context window for {} was kept for this run only; "
                    "the configured active model changed to {}",
                    self.model,
                    configured_preset.model,
                )
                return True
            if record_discovered_context_window(config, configured_preset, tokens):
                await asyncio.to_thread(save_config, config)
        except Exception:
            logger.exception(
                "Failed to persist learned context window for {}", self.model
            )
        return True

    async def _rebuild_after_context_limit(
        self,
        ctx: TurnContext,
        tokens: int,
    ) -> bool:
        """Learn a confirmed limit, compact the persisted turn, and rebuild it once."""
        if not await self._learn_context_window(tokens):
            return False

        async def report_compaction(active: bool) -> None:
            if ctx.msg.channel == "websocket" and ctx.on_progress is not None:
                await ctx.on_progress(
                    "正在整理上下文" if active else "",
                    context_compacting=active,
                )

        # The current user message was persisted before the first request.
        # Temporarily remove it so the consolidator sees the same history plus
        # current-message shape as the original request, without summarizing
        # or counting the new user input twice.
        persisted_current = None
        if ctx.user_persisted_early and ctx.session.messages:
            last_message = ctx.session.messages[-1]
            if last_message.get("role") == "user":
                persisted_current = ctx.session.messages.pop()
        try:
            await self.consolidator.maybe_consolidate_by_tokens(
                ctx.session,
                replay_max_messages=self._max_messages,
                current_message=ctx.msg.content,
                message_metadata=ctx.msg.metadata,
                on_compaction=report_compaction,
            )
        finally:
            if persisted_current is not None:
                ctx.session.messages.append(persisted_current)
        ctx.pending_summary = self.auto_compact.summary_for_session(
            ctx.session,
            ctx.session_key,
        )
        history = self._build_model_history(
            ctx.session,
            max_messages=self._max_messages,
            max_tokens=self._replay_token_budget(),
            include_timestamps=True,
        )
        if ctx.user_persisted_early and history and history[-1].get("role") == "user":
            history = history[:-1]
        ctx.history = history
        ctx.initial_messages = self._build_initial_messages(
            ctx.msg,
            ctx.session,
            history,
            ctx.pending_summary,
        )
        if not self.tools.has_subscription_access:
            ctx.initial_messages = self._inject_capability_note(ctx.initial_messages)
        if self.tools.has("update_plan"):
            ctx.initial_messages = self._inject_task_plan_note(ctx.initial_messages)
        return True

    async def _state_run(self, ctx: TurnContext) -> str:
        await self._webui_turns.publish_run_status(ctx.msg, "running")
        result = await self._run_agent_loop(
            ctx.initial_messages,
            on_progress=ctx.on_progress,
            on_stream=ctx.on_stream,
            on_stream_end=ctx.on_stream_end,
            on_retry_wait=ctx.on_retry_wait,
            session=ctx.session,
            channel=ctx.msg.channel,
            chat_id=ctx.msg.chat_id,
            message_id=ctx.msg.metadata.get("message_id"),
            metadata=ctx.msg.metadata,
            session_key=ctx.session_key,
            pending_queue=ctx.pending_queue,
            return_detected_context_window=True,
        )
        (
            final_content,
            tools_used,
            all_msgs,
            stop_reason,
            had_injections,
            detected_context_window,
        ) = result
        if detected_context_window is not None and await self._rebuild_after_context_limit(
            ctx,
            detected_context_window,
        ):
            retry_result = await self._run_agent_loop(
                ctx.initial_messages,
                on_progress=ctx.on_progress,
                on_stream=ctx.on_stream,
                on_stream_end=ctx.on_stream_end,
                on_retry_wait=ctx.on_retry_wait,
                session=ctx.session,
                channel=ctx.msg.channel,
                chat_id=ctx.msg.chat_id,
                message_id=ctx.msg.metadata.get("message_id"),
                metadata=ctx.msg.metadata,
                session_key=ctx.session_key,
                pending_queue=ctx.pending_queue,
                return_detected_context_window=True,
            )
            (
                final_content,
                tools_used,
                all_msgs,
                stop_reason,
                had_injections,
                _,
            ) = retry_result
        ctx.final_content = final_content
        ctx.turn_usage = dict(self._last_usage)
        ctx.tools_used = tools_used
        ctx.all_messages = all_msgs
        ctx.stop_reason = stop_reason
        ctx.had_injections = had_injections
        return "ok"

    async def _state_save(self, ctx: TurnContext) -> str:
        if ctx.final_content is None or not ctx.final_content.strip():
            ctx.final_content = EMPTY_FINAL_RESPONSE_MESSAGE

        ctx.save_skip = 1 + len(ctx.history) + (1 if ctx.user_persisted_early else 0)

        ctx.turn_latency_ms = max(0, int((time.time() - ctx.turn_wall_started_at) * 1000))
        self._save_turn(
            ctx.session,
            ctx.all_messages,
            ctx.save_skip,
            turn_latency_ms=ctx.turn_latency_ms,
            token_usage=ctx.turn_usage,
            task_id=ctx.msg.metadata.get("task_id"),
        )
        if ctx.msg.channel == "websocket":
            self._pending_turn_latency_ms[ctx.session_key] = ctx.turn_latency_ms
            self._pending_turn_usage[ctx.session_key] = dict(ctx.turn_usage)
        ctx.session.enforce_file_cap(on_archive=self.context.memory.raw_archive)
        self._clear_pending_user_turn(ctx.session)
        self._clear_runtime_checkpoint(ctx.session)
        self.sessions.save(ctx.session)
        self._record_completed_turn_history(ctx.msg.content, ctx.final_content)
        self._schedule_background(
            self.consolidator.maybe_consolidate_by_tokens(
                ctx.session,
                replay_max_messages=self._max_messages,
            )
        )
        return "ok"

    def _record_completed_turn_history(self, user_content: str, assistant_content: str) -> None:
        """Give this Agent's Dream a bounded per-turn learning signal."""
        user = " ".join((user_content or "").split())
        assistant = " ".join((assistant_content or "").split())
        if not user and not assistant:
            return
        entry = (
            "Conversation turn\n"
            f"User: {truncate_text_fn(user, 1_200)}\n"
            f"Assistant: {truncate_text_fn(assistant, 2_400)}"
        )
        try:
            self.context.memory.append_history(entry, max_chars=4_000)
        except Exception:
            logger.exception(
                "Failed to record completed turn for Agent {}",
                self.context.memory.agent_id,
            )

    async def _state_respond(self, ctx: TurnContext) -> str:
        ctx.outbound = self._assemble_outbound(
            ctx.msg,
            ctx.final_content,
            ctx.all_messages,
            ctx.stop_reason,
            ctx.had_injections,
            ctx.on_stream,
            turn_latency_ms=ctx.turn_latency_ms,
            token_usage=ctx.turn_usage,
            delivered_files=ctx.delivered_files,
            task_plan=task_plan_ws_blob(ctx.session.metadata),
        )
        return "ok"

    def _sanitize_persisted_blocks(
        self,
        content: list[dict[str, Any]],
        *,
        should_truncate_text: bool = False,
        drop_runtime: bool = False,
    ) -> list[dict[str, Any]]:
        """Strip volatile multimodal payloads before writing session history."""
        filtered: list[dict[str, Any]] = []
        for block in content:
            if not isinstance(block, dict):
                filtered.append(block)
                continue

            if (
                drop_runtime
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
                and block["text"].startswith(ContextBuilder._RUNTIME_CONTEXT_TAG)
            ):
                continue

            if block.get("type") == "image_url" and block.get("image_url", {}).get(
                "url", ""
            ).startswith("data:image/"):
                path = (block.get("_meta") or {}).get("path", "")
                filtered.append({"type": "text", "text": image_placeholder_text(path)})
                continue

            if block.get("type") == "text" and isinstance(block.get("text"), str):
                text = block["text"]
                if should_truncate_text and len(text) > self.max_tool_result_chars:
                    text = truncate_text_fn(text, self.max_tool_result_chars)
                filtered.append({**block, "text": text})
                continue

            filtered.append(block)

        return filtered

    async def _partner_unavailable_notice(
        self,
        msg: InboundMessage,
        session: Session,
        agent_id: str,
        *,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage:
        """Answer a direct-chat turn when the bound partner agent is gone.

        The conversation stays bound to the missing agent — identity must not
        silently fall back to Mona. The notice is persisted so it survives
        history reloads, and streamed like a normal reply when possible.
        """
        notice = (
            f"The partner agent '{agent_id}' is unavailable (uninstalled or disabled). "
            "This conversation is bound to that agent and cannot be answered by Mona — "
            "please reinstall the agent or start a new chat."
        )
        self._save_turn(
            session,
            [
                {"role": "user", "content": msg.content},
                {"role": "assistant", "content": notice},
            ],
            0,
        )
        self.sessions.save(session)
        if on_stream is not None:
            await on_stream(notice)
            if on_stream_end is not None:
                await on_stream_end(resuming=False)
        meta = dict(msg.metadata or {})
        if on_stream is not None:
            meta["_streamed"] = True
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=notice,
            metadata=meta,
        )

    def _save_turn(
        self,
        session: Session,
        messages: list[dict],
        skip: int,
        *,
        turn_latency_ms: int | None = None,
        token_usage: dict[str, int] | None = None,
        task_id: str | None = None,
    ) -> None:
        """Save new-turn messages into session, truncating large tool results."""
        from datetime import datetime

        last_assistant_idx: int | None = None
        for m in messages[skip:]:
            entry = dict(m)
            role, content = entry.get("role"), entry.get("content")
            if role == "assistant" and not content and not entry.get("tool_calls"):
                continue  # skip empty assistant messages — they poison session context
            if role == "tool":
                if isinstance(content, str) and len(content) > self.max_tool_result_chars:
                    entry["content"] = truncate_text_fn(content, self.max_tool_result_chars)
                elif isinstance(content, list):
                    filtered = self._sanitize_persisted_blocks(content, should_truncate_text=True)
                    if not filtered:
                        continue
                    entry["content"] = filtered
            elif role == "user":
                if isinstance(content, str) and ContextBuilder._RUNTIME_CONTEXT_TAG in content:
                    # Strip the runtime-context block appended at the end.
                    tag_pos = content.find(ContextBuilder._RUNTIME_CONTEXT_TAG)
                    before = content[:tag_pos].rstrip("\n ")
                    if before:
                        entry["content"] = before
                    else:
                        continue
                if isinstance(content, list):
                    filtered = self._sanitize_persisted_blocks(content, drop_runtime=True)
                    if not filtered:
                        continue
                    entry["content"] = filtered
            entry.setdefault("timestamp", datetime.now().isoformat())
            if task_id:
                entry.setdefault("task_id", task_id)
            # Multi-agent authorship: turns executed by a PartnerAgentLoop are
            # stamped with the partner's agent_id so room/direct history
            # projects the true author; the Mona loop leaves the legacy
            # default (back-filled as Mona on load).
            partner_id = getattr(self, "_partner_agent_id", None)
            if partner_id and role in ("assistant", "tool"):
                entry["author_id"] = partner_id
            normalize_message_author(entry)
            session.messages.append(entry)
            session.update_ui_summary(entry)
            if role == "assistant":
                last_assistant_idx = len(session.messages) - 1
        if turn_latency_ms is not None and last_assistant_idx is not None:
            session.messages[last_assistant_idx]["latency_ms"] = int(turn_latency_ms)
        if token_usage and last_assistant_idx is not None:
            session.messages[last_assistant_idx]["token_usage"] = dict(token_usage)
        plan = task_plan_ws_blob(session.metadata)
        if last_assistant_idx is not None and plan is not None:
            session.messages[last_assistant_idx]["task_plan"] = plan
        session.updated_at = datetime.now()

    def _persist_subagent_followup(self, session: Session, msg: InboundMessage) -> bool:
        """Persist subagent follow-ups before prompt assembly so history stays durable.

        Returns True if a new entry was appended; False if the follow-up was
        deduped (same ``subagent_task_id`` already in session) or carries no
        content worth persisting.
        """
        if not msg.content:
            return False
        task_id = msg.metadata.get("subagent_task_id") if isinstance(msg.metadata, dict) else None
        if task_id and any(
            (m.get("injected_event") == "subagent_result" and m.get("subagent_task_id") == task_id)
            or m.get("job_id") == task_id
            for m in session.messages
        ):
            return False
        extra: dict[str, Any] = {}
        if isinstance(msg.metadata, dict):
            # Named-agent results (multi-agent phase 2): persist the true
            # author and job reference so room history projects correctly.
            agent_author = msg.metadata.get("agent_author_id")
            if isinstance(agent_author, str) and agent_author:
                try:
                    from mona.agent.partners import normalize_agent_id

                    extra["author_id"] = normalize_agent_id(agent_author)
                except ValueError:
                    logger.warning("Ignoring invalid agent_author_id {!r}", agent_author)
            job_id = msg.metadata.get("job_id")
            if isinstance(job_id, str) and job_id:
                extra["job_id"] = job_id
        session.add_message(
            "assistant",
            msg.content,
            sender_id=msg.sender_id,
            injected_event="subagent_result",
            subagent_task_id=task_id,
            **extra,
        )
        return True

    def _set_runtime_checkpoint(self, session: Session, payload: dict[str, Any]) -> None:
        """Keep completed iterations as well as the current in-flight tool batch."""
        previous = session.metadata.get(self._RUNTIME_CHECKPOINT_KEY)
        completed = []
        if isinstance(previous, dict):
            completed = list(previous.get("completed_messages") or [])
            old_assistant = previous.get("assistant_message")
            if isinstance(old_assistant, dict) and old_assistant != payload.get("assistant_message"):
                completed.extend([old_assistant, *(previous.get("completed_tool_results") or [])])
        checkpoint = {**payload, "completed_messages": completed}
        checkpoint["completed_tool_results"] = [
            {
                **message,
                "content": self._sanitize_persisted_blocks(message["content"], should_truncate_text=True),
            }
            if isinstance(message.get("content"), list) else message
            for message in (payload.get("completed_tool_results") or [])
        ]
        session.metadata[self._RUNTIME_CHECKPOINT_KEY] = checkpoint
        self.sessions.save(session)

    def _mark_pending_user_turn(self, session: Session) -> None:
        session.metadata[self._PENDING_USER_TURN_KEY] = True

    def _clear_pending_user_turn(self, session: Session) -> None:
        session.metadata.pop(self._PENDING_USER_TURN_KEY, None)

    def _clear_runtime_checkpoint(self, session: Session) -> None:
        if self._RUNTIME_CHECKPOINT_KEY in session.metadata:
            session.metadata.pop(self._RUNTIME_CHECKPOINT_KEY, None)

    @staticmethod
    def _checkpoint_message_key(message: dict[str, Any]) -> tuple[Any, ...]:
        return (
            message.get("role"),
            message.get("content"),
            message.get("tool_call_id"),
            message.get("name"),
            message.get("tool_calls"),
            message.get("reasoning_content"),
            message.get("thinking_blocks"),
        )

    def _restore_runtime_checkpoint(self, session: Session) -> bool:
        """Materialize an unfinished turn into session history before a new request."""
        from datetime import datetime

        checkpoint = session.metadata.get(self._RUNTIME_CHECKPOINT_KEY)
        if not isinstance(checkpoint, dict):
            return False

        assistant_message = checkpoint.get("assistant_message")
        completed_tool_results = checkpoint.get("completed_tool_results") or []
        pending_tool_calls = checkpoint.get("pending_tool_calls") or []

        restored_messages: list[dict[str, Any]] = [
            {**message, "timestamp": message.get("timestamp") or datetime.now().isoformat()}
            for message in (checkpoint.get("completed_messages") or [])
            if isinstance(message, dict)
        ]
        if isinstance(assistant_message, dict):
            restored = dict(assistant_message)
            restored.setdefault("timestamp", datetime.now().isoformat())
            restored_messages.append(restored)
        for message in completed_tool_results:
            if isinstance(message, dict):
                restored = dict(message)
                restored.setdefault("timestamp", datetime.now().isoformat())
                restored_messages.append(restored)
        for tool_call in pending_tool_calls:
            if not isinstance(tool_call, dict):
                continue
            tool_id = tool_call.get("id")
            name = ((tool_call.get("function") or {}).get("name")) or "tool"
            restored_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "name": name,
                    "content": "Error: Task interrupted before this tool finished.",
                    "timestamp": datetime.now().isoformat(),
                }
            )

        overlap = 0
        max_overlap = min(len(session.messages), len(restored_messages))
        for size in range(max_overlap, 0, -1):
            existing = session.messages[-size:]
            restored = restored_messages[:size]
            if all(
                self._checkpoint_message_key(left) == self._checkpoint_message_key(right)
                for left, right in zip(existing, restored)
            ):
                overlap = size
                break
        session.messages.extend(restored_messages[overlap:])
        for restored in restored_messages[overlap:]:
            normalize_message_author(restored)
            session.update_ui_summary(restored)

        self._clear_pending_user_turn(session)
        self._clear_runtime_checkpoint(session)
        return True

    def _restore_pending_user_turn(self, session: Session) -> bool:
        """Close a turn that only persisted the user message before crashing."""
        from datetime import datetime

        if not session.metadata.get(self._PENDING_USER_TURN_KEY):
            return False

        if session.messages and session.messages[-1].get("role") == "user":
            entry = {
                "role": "assistant",
                "content": "Error: Task interrupted before a response was generated.",
                "timestamp": datetime.now().isoformat(),
            }
            normalize_message_author(entry)
            session.messages.append(entry)
            session.update_ui_summary(entry)
            session.updated_at = datetime.now()

        self._clear_pending_user_turn(session)
        return True

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
        media: list[str] | None = None,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a message directly and return the outbound payload."""
        await self._connect_mcp()
        msg = InboundMessage(
            channel=channel,
            sender_id="user",
            chat_id=chat_id,
            content=content,
            media=media or [],
        )
        return await self._process_message(
            msg,
            session_key=session_key,
            on_progress=on_progress,
            on_stream=on_stream,
            on_stream_end=on_stream_end,
        )
