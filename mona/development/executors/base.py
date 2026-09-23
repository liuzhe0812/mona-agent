"""Small host contract, with explicit dispatch and cancellation outcomes."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal, Protocol

from pydantic import Field

from mona.development.contracts import Binding, Capabilities, Contract, ExecutorId


class ExecutorProbe(Contract):
    executor: ExecutorId
    state: Literal["not_detected", "detected", "invalid_path", "unavailable", "ready"]
    executable: str | None = None
    version: str | None = None
    authentication: Literal["unknown", "required", "ready"] = "unknown"
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
    async def create_session(self, project_context: dict[str, Any], model: str | None) -> Binding: ...
    async def resume_session(self, binding: Binding) -> Binding: ...
    async def send(self, binding: Binding, input_id: str, message: str) -> DispatchReceipt: ...
    async def steer(self, binding: Binding, input_id: str, message: str) -> DispatchReceipt: ...
    async def interrupt(self, binding: Binding) -> InterruptReceipt: ...
    async def close_runtime(self, binding: Binding) -> None: ...
    async def get_status(self, binding: Binding) -> str: ...
    async def list_models(self) -> list[str]: ...
    def events(self, binding: Binding) -> AsyncIterator[NativeEvent]: ...
