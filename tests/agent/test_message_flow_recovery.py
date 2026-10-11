from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import LLMResponse, ToolCallRequest

_SYSTEM = {"role": "system", "content": "Keep the system message unchanged."}
_INITIAL_MESSAGES = [
    _SYSTEM,
    {"role": "user", "content": "Append the line once, then finish."},
]


class _AppendFileTool(Tool):
    def __init__(self, target: Path) -> None:
        self.target = target

    @property
    def name(self) -> str:
        return "append_test_file"

    @property
    def description(self) -> str:
        return "Append one line to the test's local file."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        }

    async def execute(self, *, text: str) -> str:
        with self.target.open("a", encoding="utf-8") as output:
            output.write(text + "\n")
        return f"Appended line: {text}"


class _SequencedProvider:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = list(responses)
        self.requests: list[list[dict[str, Any]]] = []
        self.generation = SimpleNamespace(max_tokens=128, temperature=0.0, reasoning_effort=None)

    def get_default_model(self) -> str:
        return "test-model"

    def estimate_prompt_tokens(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
    ) -> tuple[int, str]:
        return 128, "test-provider"

    async def chat_with_retry(self, **kwargs: Any) -> LLMResponse:
        self.requests.append(copy.deepcopy(kwargs["messages"]))
        if not self.responses:
            raise AssertionError("AgentRunner sent an unexpected extra model request")
        return self.responses.pop(0)


def _tool_registry(target: Path) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(_AppendFileTool(target))
    return registry


def _append_call() -> LLMResponse:
    return LLMResponse(
        content=None,
        tool_calls=[ToolCallRequest(
            id="append-once",
            name="append_test_file",
            arguments={"text": "completed"},
        )],
        finish_reason="tool_calls",
        usage={"prompt_tokens": 40, "completion_tokens": 8},
    )


def _context_limit() -> LLMResponse:
    return LLMResponse(
        content="Maximum context length is 4096 tokens.",
        finish_reason="error",
        error_type="context_length_exceeded",
    )


def _runner_spec(tmp_path: Path, registry: ToolRegistry, **kwargs: Any) -> AgentRunSpec:
    return AgentRunSpec(
        initial_messages=copy.deepcopy(_INITIAL_MESSAGES),
        tools=registry,
        model="test-model",
        max_iterations=6,
        max_tool_result_chars=4096,
        workspace=tmp_path,
        context_window_tokens=64_000,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_agent_loop_retries_only_failed_request_with_completed_tool_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.agent import partners, user_config
    from mona.agent.loop import AgentLoop
    from mona.agent.user_config import AgentUserConfig
    from mona.bus.queue import MessageBus

    class TestConfig:
        def __init__(self) -> None:
            self.provider = SimpleNamespace(discovered_models=[])

        def resolve_preset(self, _name: str | None) -> SimpleNamespace:
            return SimpleNamespace(model="test-model")

        def get_provider(self, _model: str, *, preset: Any = None) -> SimpleNamespace:
            return self.provider

    class TestAgentRegistry:
        def require(self, agent_id: str) -> partners.AgentDefinition:
            return partners.AgentDefinition(id=agent_id, display_name="Mona")

    test_config = TestConfig()
    saved_configs: list[TestConfig] = []
    monkeypatch.setattr(user_config, "load_agent_user_config", lambda _agent_id: AgentUserConfig())
    monkeypatch.setattr(partners, "AgentRegistry", TestAgentRegistry)
    monkeypatch.setattr("mona.config.loader.load_config", lambda: test_config)
    monkeypatch.setattr("mona.config.loader.save_config", saved_configs.append)

    provider = _SequencedProvider([
        _append_call(),
        _context_limit(),
        LLMResponse(
            content="Finished after the context limit was learned.",
            usage={"prompt_tokens": 60, "completion_tokens": 10},
        ),
    ])
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,  # type: ignore[arg-type]
        workspace=tmp_path,
        model="test-model",
        context_window_tokens=64_000,
    )
    target = tmp_path / "tool-side-effect.txt"
    loop.tools.register(_AppendFileTool(target))

    final, _tools_used, _messages, stop_reason, _had_injections = await loop._run_agent_loop(
        copy.deepcopy(_INITIAL_MESSAGES),
        channel="test",
        chat_id="context-recovery",
    )

    assert final == "Finished after the context limit was learned."
    assert stop_reason == "completed"
    assert len(provider.requests) == 3
    assert all(request[0] == _SYSTEM for request in provider.requests)
    completed_results = [
        message
        for message in provider.requests[2]
        if message.get("role") == "tool" and message.get("tool_call_id") == "append-once"
    ]
    assert len(completed_results) == 1
    assert "Appended line: completed" in completed_results[0]["content"]
    assert target.read_text(encoding="utf-8") == "completed\n"
    assert loop._last_usage["prompt_tokens"] == 100
    assert loop._last_usage["completion_tokens"] == 18
    assert loop.context_window_tokens == 4096
    assert len(saved_configs) == 1
    assert test_config.provider.discovered_models == [{
        "id": "test-model",
        "name": "test-model",
        "context_window": 4096,
    }]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("accept_limit", "repeat_limit", "expected_requests"),
    [(False, False, 2), (True, True, 3)],
)
async def test_runner_stops_after_rejected_or_repeated_context_limit(
    tmp_path: Path,
    accept_limit: bool,
    repeat_limit: bool,
    expected_requests: int,
) -> None:
    provider = _SequencedProvider(
        [_append_call(), _context_limit(), *([_context_limit()] if repeat_limit else [])]
    )
    callback_tokens: list[int] = []

    async def accept_context_limit(tokens: int) -> bool:
        callback_tokens.append(tokens)
        return accept_limit

    result = await AgentRunner(provider).run(_runner_spec(
        tmp_path,
        _tool_registry(tmp_path / "tool-side-effect.txt"),
        context_limit_callback=accept_context_limit,
    ))

    assert result.stop_reason == "context_limit"
    assert len(provider.requests) == expected_requests
    assert callback_tokens == [4096]
    assert (tmp_path / "tool-side-effect.txt").read_text(encoding="utf-8") == "completed\n"
    assert result.usage == {"prompt_tokens": 40, "completion_tokens": 8}
