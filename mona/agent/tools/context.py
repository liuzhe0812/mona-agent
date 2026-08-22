"""Runtime context for tool construction."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable

# Internal routing metadata is written by the room router.  Keep these names
# in one place so tools do not duplicate string literals or accidentally
# expose them as user-facing parameters.
DIRECT_TARGET_AGENT_IDS_META = "_direct_target_agent_ids"
PARTNER_JOBS_DISPATCHED_META = "_partner_jobs_dispatched"


@dataclass(frozen=True)
class RequestContext:
    """Per-request context injected into tools at message-processing time."""
    channel: str
    chat_id: str
    message_id: str | None = None
    session_key: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    terminal_session_id: str | None = None
    terminal_exec_mode: str | None = None


@runtime_checkable
class ContextAware(Protocol):
    def set_context(self, ctx: RequestContext) -> None:
        ...


@dataclass
class ToolContext:
    config: Any
    workspace: str
    bus: Any | None = None
    subagent_manager: Any | None = None
    cron_service: Any | None = None
    schedule_service: Any | None = None
    todo_service: Any | None = None
    sessions: Any | None = None
    file_state_store: Any = field(default=None)
    provider_snapshot_loader: Callable[[], Any] | None = None
    image_generation_provider_configs: dict[str, Any] | None = None
    video_generation_provider_configs: dict[str, Any] | None = None
    timezone: str = "UTC"
    # Multi-agent identity (phase 0): defaults preserve legacy Mona behavior.
    agent_id: str = "mona"
    conversation_id: str | None = None
    room_id: str | None = None
    job_id: str | None = None
    workflow_run_id: str | None = None
