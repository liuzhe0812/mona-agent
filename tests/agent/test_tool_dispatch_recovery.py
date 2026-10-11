from __future__ import annotations

import asyncio
import copy
from pathlib import Path
from typing import Any

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.session.manager import SessionManager


class _SequencedProvider:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = list(responses)
        self.requests: list[list[dict[str, Any]]] = []

    async def chat_with_retry(self, **kwargs: Any) -> LLMResponse:
        self.requests.append(copy.deepcopy(kwargs["messages"]))
        if not self.responses:
            raise AssertionError("AgentRunner sent an unexpected extra model request")
        return self.responses.pop(0)


class _CountingTool(Tool):
    def __init__(self, name: str, *, safe: bool = True) -> None:
        self._name = name
        self.safe = safe
        self.calls = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"Test tool {self._name}."

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    @property
    def read_only(self) -> bool:
        return self.safe

    async def execute(self) -> str:
        self.calls += 1
        return f"completed:{self.name}"


class _BlockedTool(_CountingTool):
    def __init__(
        self,
        name: str,
        *,
        workspace: Path,
        session_key: str,
        entered: asyncio.Event,
        release: asyncio.Event,
    ) -> None:
        super().__init__(name, safe=True)
        self.workspace = workspace
        self.session_key = session_key
        self.entered = entered
        self.release = release
        self.checkpoint_at_execute_entry: dict[str, Any] | None = None

    async def execute(self) -> str:
        self.calls += 1
        persisted = SessionManager(self.workspace).get_or_create(self.session_key)
        checkpoint = persisted.metadata.get(AgentLoop._RUNTIME_CHECKPOINT_KEY)
        self.checkpoint_at_execute_entry = copy.deepcopy(checkpoint)
        self.entered.set()
        await self.release.wait()
        return f"completed:{self.name}"


class _RequiredTextTool(_CountingTool):
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        }

    async def execute(self, *, text: str) -> str:
        self.calls += 1
        return text


def _call(call_id: str, name: str, arguments: dict[str, Any] | None = None) -> ToolCallRequest:
    return ToolCallRequest(id=call_id, name=name, arguments=arguments or {})


def _persisted_call(call_id: str, name: str) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": "{}"},
    }


def _assistant_call_message(calls: list[dict[str, Any]]) -> dict[str, Any]:
    return {"role": "assistant", "content": "Working.", "tool_calls": calls}


def _runner_spec(
    tmp_path: Path,
    registry: ToolRegistry,
    *,
    checkpoint_callback: Any = None,
    concurrent_tools: bool = False,
) -> AgentRunSpec:
    return AgentRunSpec(
        initial_messages=[
            {"role": "system", "content": "Use the registered test tools."},
            {"role": "user", "content": "Finish the requested work."},
        ],
        tools=registry,
        model="test-model",
        max_iterations=4,
        max_tool_result_chars=4096,
        workspace=tmp_path,
        checkpoint_callback=checkpoint_callback,
        concurrent_tools=concurrent_tools,
    )


@pytest.mark.asyncio
async def test_validation_failure_never_marks_tool_started(tmp_path: Path) -> None:
    tool = _RequiredTextTool("requires_text")
    registry = ToolRegistry()
    registry.register(tool)
    provider = _SequencedProvider([
        LLMResponse(
            content=None,
            tool_calls=[_call("invalid-call", tool.name)],
            finish_reason="tool_calls",
        ),
        LLMResponse(content="Finished."),
    ])
    checkpoints: list[dict[str, Any]] = []

    async def record_checkpoint(payload: dict[str, Any]) -> None:
        checkpoints.append(copy.deepcopy(payload))

    result = await AgentRunner(provider).run(_runner_spec(
        tmp_path,
        registry,
        checkpoint_callback=record_checkpoint,
    ))

    assert result.final_content == "Finished."
    assert tool.calls == 0
    assert not any(payload.get("phase") == "tools_started" for payload in checkpoints)
    assert all(
        "invalid-call" not in payload.get("started_tool_call_ids", [])
        for payload in checkpoints
    )
    awaiting = next(payload for payload in checkpoints if payload["phase"] == "awaiting_tools")
    assert awaiting["started_tool_call_ids"] == []


@pytest.mark.asyncio
async def test_parallel_checkpoint_restores_completed_unknown_and_not_started_calls(
    tmp_path: Path,
) -> None:
    session_key = "test:parallel-tool-checkpoint"
    sessions = SessionManager(tmp_path)
    session = sessions.get_or_create(session_key)
    session.add_message("user", "Complete the three tool calls.")
    sessions.save(session)

    loop = AgentLoop.__new__(AgentLoop)
    loop.sessions = sessions
    first = _CountingTool("first_safe_tool")
    entered = asyncio.Event()
    release = asyncio.Event()
    second = _BlockedTool(
        "second_safe_tool",
        workspace=tmp_path,
        session_key=session_key,
        entered=entered,
        release=release,
    )
    third = _CountingTool("later_serial_tool", safe=False)
    registry = ToolRegistry()
    for tool in (first, second, third):
        registry.register(tool)

    async def save_checkpoint(payload: dict[str, Any]) -> None:
        loop._set_runtime_checkpoint(session, payload)

    provider = _SequencedProvider([
        LLMResponse(
            content=None,
            tool_calls=[
                _call("first-call", first.name),
                _call("second-call", second.name),
                _call("third-call", third.name),
            ],
            finish_reason="tool_calls",
        ),
    ])
    task = asyncio.create_task(AgentRunner(provider).run(_runner_spec(
        tmp_path,
        registry,
        checkpoint_callback=save_checkpoint,
        concurrent_tools=True,
    )))

    await asyncio.wait_for(entered.wait(), timeout=2)
    checkpoint_at_entry = second.checkpoint_at_execute_entry
    assert isinstance(checkpoint_at_entry, dict)
    assert checkpoint_at_entry["phase"] == "tools_started"
    assert checkpoint_at_entry["started_tool_call_ids"] == ["first-call", "second-call"]
    assert [message["tool_call_id"] for message in checkpoint_at_entry["completed_tool_results"]] == [
        "first-call"
    ]
    assert [
        call["id"] for call in checkpoint_at_entry["pending_tool_calls"]
    ] == ["second-call", "third-call"]

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert (first.calls, second.calls, third.calls) == (1, 1, 0)
    restored_sessions = SessionManager(tmp_path)
    persisted = restored_sessions.get_or_create(session_key)
    persisted_checkpoint = persisted.metadata[AgentLoop._RUNTIME_CHECKPOINT_KEY]
    assert persisted_checkpoint["started_tool_call_ids"] == ["first-call", "second-call"]
    assert [
        message["tool_call_id"] for message in persisted_checkpoint["completed_tool_results"]
    ] == ["first-call"]

    restored_loop = AgentLoop.__new__(AgentLoop)
    restored_loop.sessions = restored_sessions
    assert restored_loop._restore_runtime_checkpoint(persisted) is True
    restored_sessions.save(persisted)
    restored = SessionManager(tmp_path).get_or_create(session_key)
    assert AgentLoop._RUNTIME_CHECKPOINT_KEY not in restored.metadata

    tool_results = {
        message["tool_call_id"]: message
        for message in restored.messages
        if message.get("role") == "tool"
    }
    assert set(tool_results) == {"first-call", "second-call", "third-call"}
    assert tool_results["first-call"]["content"] == "completed:first_safe_tool"
    assert "TOOL_OUTCOME_UNKNOWN" in tool_results["second-call"]["content"]
    assert "TOOL_NOT_STARTED" in tool_results["third-call"]["content"]
    assert "TOOL_OUTCOME_UNKNOWN" not in tool_results["third-call"]["content"]
    assert (first.calls, second.calls, third.calls) == (1, 1, 0)


def test_legacy_checkpoint_without_started_ids_restores_unknown_without_execution(
    tmp_path: Path,
) -> None:
    sessions = SessionManager(tmp_path)
    session = sessions.get_or_create("test:legacy-checkpoint")
    session.add_message("user", "Continue safely.")
    session.metadata[AgentLoop._RUNTIME_CHECKPOINT_KEY] = {
        "phase": "awaiting_tools",
        "assistant_message": _assistant_call_message([_persisted_call("legacy-call", "side_effect")]),
        "completed_tool_results": [],
        "pending_tool_calls": [_persisted_call("legacy-call", "side_effect")],
    }
    sessions.save(session)

    restored_sessions = SessionManager(tmp_path)
    restored = restored_sessions.get_or_create(session.key)
    loop = AgentLoop.__new__(AgentLoop)
    loop.sessions = restored_sessions

    assert loop._restore_runtime_checkpoint(restored) is True
    restored_sessions.save(restored)
    reloaded = SessionManager(tmp_path).get_or_create(session.key)
    tool_result = next(message for message in reloaded.messages if message.get("role") == "tool")
    assert "TOOL_OUTCOME_UNKNOWN" in tool_result["content"]
    assert "TOOL_NOT_STARTED" not in tool_result["content"]
