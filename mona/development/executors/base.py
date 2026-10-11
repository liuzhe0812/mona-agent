"""Small host contract, with explicit dispatch and cancellation outcomes."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import Field

from mona.development.context import ProjectContext
from mona.development.contracts import (
    Binding,
    Capabilities,
    Contract,
    DevelopmentSession,
    ExecutorId,
)
from mona.development.input_content import MessageContent


@dataclass(frozen=True)
class SessionStart:
    session: DevelopmentSession
    context: ProjectContext
    model: str | None = None
    readonly: bool = False
    # Only a durable absence of runs permits reopening an allocated SDK ID as new.
    resume_history: bool = True
    context_window_tokens: int | None = None


class ExecutorModel(Contract):
    id: str = Field(min_length=1, max_length=512)
    label: str = Field(min_length=1, max_length=256)
    description: str | None = Field(default=None, max_length=2000)
    context_window: int | None = Field(default=None, strict=True, gt=0)
    reasoning_efforts: list[str] = Field(default_factory=list, max_length=16)
    reasoning_effort: str | None = Field(default=None, max_length=32)


class ExecutorProbe(Contract):
    executor: ExecutorId
    state: Literal["not_detected", "detected", "invalid_path", "unavailable", "ready"]
    executable: str | None = None
    version: str | None = None
    sdk_version: str | None = None
    source: str | None = None
    stage: Literal["discovery", "dependency", "launch", "protocol", "authentication", "models", "ready"] = "discovery"
    error_code: str | None = None
    next_action: str = ""
    protocol_verified: bool = False
    authentication: Literal["unknown", "required", "ready"] = "unknown"
    auth_mode: Literal["unknown", "chatgpt", "api_key"] = "unknown"
    model_catalog_state: Literal["unknown", "ready", "empty", "unavailable"] = "unknown"
    model_details: list[ExecutorModel] = Field(default_factory=list, max_length=512)
    default_model: str | None = None
    capabilities: Capabilities = Field(default_factory=Capabilities)
    isolation_verified: bool = False
    reason: str = ""


class DispatchReceipt(Contract):
    input_id: str
    outcome: Literal["accepted", "queued", "rejected", "unknown"]
    native_turn_id: str | None = None
    reason: str | None = None


class InterruptReceipt(Contract):
    outcome: Literal["requested", "confirmed", "already_finished", "unsupported", "unknown"]
    # A turn interrupt is not evidence that its descendant processes stopped.
    child_processes_stopped: bool = False


class NativeEvent(Contract):
    native_event_id: str | None = None
    native_turn_id: str | None = None
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


class Executor(Protocol):
    """No adapter writes product storage or fabricates a missing native capability."""

    id: ExecutorId

    async def probe(self) -> ExecutorProbe: ...
    async def begin_login(self) -> dict: ...
    def login_status(self) -> dict: ...
    async def cancel_login(self, login_id: str) -> dict: ...
    async def create_session(self, start: SessionStart) -> Binding: ...
    async def attach_session(self, start: SessionStart, binding: Binding) -> Binding: ...
    async def resume_session(self, binding: Binding) -> Binding: ...
    async def send(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt: ...
    async def steer(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt: ...
    async def interrupt(self, binding: Binding, *, native_turn_id: str | None = None) -> InterruptReceipt: ...
    async def close_runtime(self, binding: Binding, *, force: bool = False) -> None: ...
    async def shutdown(self) -> None: ...
    async def get_status(self, binding: Binding) -> str: ...
    async def inspect_turn(self, binding: Binding, native_turn_id: str) -> list[NativeEvent]: ...
    async def list_models(self) -> list[str]: ...
    def events(self, binding: Binding) -> AsyncIterator[NativeEvent]: ...
