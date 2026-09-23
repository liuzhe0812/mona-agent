"""Versioned development contracts. Views never own executor lifecycles."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

SCHEMA_VERSION = 1
Identifier = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{1,95}$")]


def new_id(kind: str) -> str:
    return f"{kind}_{uuid4().hex}"


def now() -> datetime:
    return datetime.now(timezone.utc)


class Contract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid",
        validate_assignment=True,
    )


class ExecutorId(str, Enum):
    MONA = "mona"
    CODEX = "codex"
    CLAUDE = "claude"
    CODEBUDDY = "codebuddy"


class Capabilities(Contract):
    """Unknown native capabilities are false, not assumed from a vendor name."""

    resume: bool = False
    steering: bool = False
    interrupt: bool = False
    model_switch: bool = False
    approval: bool = False
    usage: bool = False
    image_input: bool = False
    project_skills: bool = False
    native_subagents: bool = False
    rich_events: bool = False


class Project(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("project"))
    root_path: str = Field(min_length=1)
    display_name: str = Field(min_length=1, max_length=200)
    created_at: datetime = Field(default_factory=now)
    last_opened_at: datetime = Field(default_factory=now)


class DevelopmentSession(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("dev"))
    project_id: Identifier
    title: str = Field(default="新开发任务", min_length=1, max_length=200)
    executor: ExecutorId = ExecutorId.MONA
    model: str | None = Field(default=None, max_length=200)
    pinned: bool = False
    archived: bool = False
    revision: int = Field(default=0, ge=0)
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    @property
    def transcript_key(self) -> str:
        # Reuse SessionManager's transcript format; never alias a normal chat.
        return f"development:{self.id}"


class Binding(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("binding"))
    session_id: Identifier
    executor: ExecutorId
    native_session_id: str = Field(min_length=1, max_length=512)
    working_directory: str = Field(min_length=1)
    state: Literal["active", "parked", "unavailable", "stale"] = "active"
    capabilities: Capabilities = Field(default_factory=Capabilities)
    protocol_version: str | None = None
    context_fingerprint: str | None = None
    created_at: datetime = Field(default_factory=now)
    last_used_at: datetime = Field(default_factory=now)


class RunStatus(str, Enum):
    QUEUED = "queued"
    PREPARING = "preparing"
    RUNNING = "running"
    WAITING_USER = "waiting_user"
    INTERRUPTING = "interrupting"
    INTERRUPTED = "interrupted"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"
    RECOVERING = "recovering"


TERMINAL_RUN_STATUSES = frozenset({
    RunStatus.INTERRUPTED, RunStatus.SUCCEEDED, RunStatus.FAILED,
})
RUN_TRANSITIONS: dict[RunStatus, frozenset[RunStatus]] = {
    RunStatus.QUEUED: frozenset({RunStatus.PREPARING, RunStatus.INTERRUPTED, RunStatus.FAILED}),
    RunStatus.PREPARING: frozenset({RunStatus.RUNNING, RunStatus.WAITING_USER, RunStatus.INTERRUPTING, RunStatus.FAILED, RunStatus.UNKNOWN}),
    RunStatus.RUNNING: frozenset({RunStatus.WAITING_USER, RunStatus.INTERRUPTING, RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.UNKNOWN}),
    RunStatus.WAITING_USER: frozenset({RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.INTERRUPTING, RunStatus.FAILED, RunStatus.UNKNOWN}),
    RunStatus.INTERRUPTING: frozenset({RunStatus.INTERRUPTED, RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.UNKNOWN}),
    RunStatus.UNKNOWN: frozenset({RunStatus.RECOVERING}),
    RunStatus.RECOVERING: frozenset({RunStatus.RUNNING, RunStatus.WAITING_USER, RunStatus.INTERRUPTED, RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.UNKNOWN}),
    RunStatus.INTERRUPTED: frozenset(),
    RunStatus.SUCCEEDED: frozenset(),
    RunStatus.FAILED: frozenset(),
}


class Run(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("run"))
    session_id: Identifier
    request_id: Identifier
    request_message_id: Identifier
    executor: ExecutorId
    binding_id: Identifier | None = None
    status: RunStatus = RunStatus.QUEUED
    revision: int = Field(default=0, ge=0)
    result_message_id: Identifier | None = None
    error_code: str | None = Field(default=None, max_length=100)
    rules_fingerprint: str | None = None
    skills_fingerprint: str | None = None
    created_at: datetime = Field(default_factory=now)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class InputState(str, Enum):
    PENDING = "pending"
    RESERVED = "reserved"
    ACCEPTED = "accepted"
    CONSUMED = "consumed"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


INPUT_TRANSITIONS: dict[InputState, frozenset[InputState]] = {
    InputState.PENDING: frozenset({InputState.RESERVED, InputState.CANCELLED}),
    InputState.RESERVED: frozenset({InputState.PENDING, InputState.ACCEPTED, InputState.REJECTED, InputState.UNKNOWN}),
    InputState.ACCEPTED: frozenset({InputState.CONSUMED, InputState.UNKNOWN}),
    InputState.UNKNOWN: frozenset({InputState.ACCEPTED, InputState.CONSUMED, InputState.REJECTED}),
    InputState.CONSUMED: frozenset(),
    InputState.CANCELLED: frozenset(),
    InputState.REJECTED: frozenset(),
}


class RunInput(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("input"))
    session_id: Identifier
    run_id: Identifier
    message_id: Identifier
    intent: Literal["steering", "follow_up"] = "follow_up"
    state: InputState = InputState.PENDING
    revision: int = Field(default=0, ge=0)
    created_at: datetime = Field(default_factory=now)


class Event(Contract):
    id: Identifier = Field(default_factory=lambda: new_id("event"))
    sequence: int = Field(ge=1)
    project_id: Identifier
    session_id: Identifier
    run_id: Identifier | None = None
    executor: ExecutorId
    type: str = Field(min_length=1, max_length=100)
    timestamp: datetime = Field(default_factory=now)
    payload: dict[str, Any] = Field(default_factory=dict)


class Pane(Contract):
    id: Identifier
    session_id: Identifier | None = None


class DevelopmentView(Contract):
    """Only view bindings; drafts/history belong to the bound session, not its slot."""

    id: Identifier = Field(default_factory=lambda: new_id("view"))
    project_id: Identifier
    layout: Literal["single", "split2", "grid4"] = "single"
    panes: list[Pane] = Field(default_factory=lambda: [Pane(id="pane_1")], min_length=1, max_length=4)
    focused_pane_id: Identifier = "pane_1"
    revision: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_panes(self) -> DevelopmentView:
        count = {"single": 1, "split2": 2, "grid4": 4}[self.layout]
        ids = [pane.id for pane in self.panes]
        if len(ids) != count or len(set(ids)) != count or self.focused_pane_id not in ids:
            raise ValueError("分屏数量、标识和焦点必须与当前布局一致。")
        return self
