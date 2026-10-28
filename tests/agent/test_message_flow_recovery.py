from __future__ import annotations

import base64
import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.session.manager import SessionManager
from mona.utils.helpers import estimate_prompt_tokens

_SYSTEM = {"role": "system", "content": "Keep the system message unchanged."}
_INITIAL_MESSAGES = [
    _SYSTEM,
    {"role": "user", "content": "Previously checked log entry. " * 1200},
    {"role": "assistant", "content": "The previous check is complete."},
    {"role": "user", "content": "Append the line once, then finish."},
]
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII="
)
_IMAGE = {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(_PNG).decode()}}


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
        return estimate_prompt_tokens(messages, tools), "test-provider"

    async def chat_with_retry(self, **kwargs: Any) -> LLMResponse:
        self.requests.append(copy.deepcopy(kwargs["messages"]))
        if not self.responses:
            raise AssertionError("AgentRunner sent an unexpected extra model request")
        return self.responses.pop(0)


class _ScreenshotTool(Tool):
    name = "capture_test_image"
    description = "Return the current test screenshot."
    parameters = {"type": "object", "properties": {}}

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self) -> list[dict]:
        self.calls += 1
        return [{"type": "text", "text": "Screenshot metadata stays intact."}, copy.deepcopy(_IMAGE)]


def _capture_call(call_id: str, *, prompt_tokens: int = 20) -> LLMResponse:
    return LLMResponse(
        content=None,
        tool_calls=[ToolCallRequest(id=call_id, name="capture_test_image", arguments={})],
        finish_reason="tool_calls",
        usage={"prompt_tokens": prompt_tokens, "completion_tokens": 0},
    )


def _image_count(messages: list[dict]) -> int:
    return sum(
        block.get("type") == "image_url"
        for message in messages if isinstance(message.get("content"), list)
        for block in message["content"]
    )


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
        context_window_tokens=kwargs.pop("context_window_tokens", 64_000),
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
    monkeypatch.setattr("mona.config.loader.load_config", lambda: test_config)
    monkeypatch.setattr("mona.config.loader.save_config", saved_configs.append)
    target = tmp_path / "tool-side-effect.txt"
    loop.tools = _tool_registry(target)

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
    assert provider.requests[1] != provider.requests[2]
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


@pytest.mark.asyncio
async def test_runner_does_not_retry_when_learning_a_limit_did_not_reduce_the_request(tmp_path: Path) -> None:
    provider = _SequencedProvider([_append_call(), _context_limit()])

    async def accept_limit(_tokens: int) -> bool:
        return True

    spec = _runner_spec(
        tmp_path, _tool_registry(tmp_path / "tool-side-effect.txt"),
        context_limit_callback=accept_limit,
    )
    spec.initial_messages = [_SYSTEM, _INITIAL_MESSAGES[-1]]
    result = await AgentRunner(provider).run(spec)

    assert result.stop_reason == "context_limit"
    assert len(provider.requests) == 2
    assert (tmp_path / "tool-side-effect.txt").read_text(encoding="utf-8") == "completed\n"


async def test_runner_does_not_send_when_the_final_budget_check_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _SequencedProvider([])

    def fail_estimate(*_args: Any, **_kwargs: Any) -> None:
        raise ValueError("token estimate unavailable")

    monkeypatch.setattr("mona.agent.runner.estimate_prompt_tokens_chain", fail_estimate)
    spec = _runner_spec(tmp_path, _tool_registry(tmp_path / "unused.txt"))
    result = await AgentRunner(provider).run(spec)

    assert provider.requests == []
    assert result.stop_reason == "context_limit"
    assert result.messages[:len(spec.initial_messages)] == spec.initial_messages


@pytest.mark.parametrize("window", [1_000_000, 1_048_576, 2_000_000])
@pytest.mark.parametrize("reject_again", [False, True])
async def test_overflow_offloads_older_images_once_and_preserves_execution(
    tmp_path: Path, window: int, reject_again: bool,
) -> None:
    rejection = LLMResponse(
        content="400 prompt is too long: 1055895 tokens > 1048576 maximum",
        finish_reason="error", error_status_code=400,
    )
    provider = _SequencedProvider([
        _append_call(), _capture_call("old-image"), _capture_call("latest-image"),
        rejection, rejection if reject_again else LLMResponse(content="Recovered."),
    ])
    target = tmp_path / "tool-side-effect.txt"
    registry = _tool_registry(target)
    screenshots = _ScreenshotTool()
    registry.register(screenshots)
    spec = _runner_spec(tmp_path, registry, context_window_tokens=window)
    user = {"role": "user", "content": [
        {"type": "text", "text": "Append once, compare the screenshots, and finish."},
        copy.deepcopy(_IMAGE),
    ]}
    spec.initial_messages = [copy.deepcopy(_SYSTEM), user]

    result = await AgentRunner(provider).run(spec)

    assert result.stop_reason == ("context_limit" if reject_again else "completed")
    assert result.detected_context_window_tokens == 1_048_576
    assert len(provider.requests) == 5
    assert _image_count(provider.requests[3]) == 3
    assert _image_count(provider.requests[4]) == 2
    assert _image_count(result.messages) == 3
    assert all(request[:2] == [_SYSTEM, user] for request in provider.requests)
    old_result = next(m for m in provider.requests[4] if m.get("tool_call_id") == "old-image")
    assert old_result["content"][0]["text"] == "Screenshot metadata stays intact."
    saved = list(tmp_path.glob(".mona/tool-results/**/sha256-*.png"))
    assert len(saved) == 1 and saved[0].read_bytes() == _PNG
    assert str(saved[0]) in old_result["content"][1]["text"]
    assert "read_file" in old_result["content"][1]["text"]
    calls = {call["id"] for m in provider.requests[4] for call in m.get("tool_calls", [])}
    assert all(m["tool_call_id"] in calls for m in provider.requests[4] if m["role"] == "tool")
    assert screenshots.calls == 2
    assert target.read_text(encoding="utf-8") == "completed\n"


@pytest.mark.parametrize(("threshold", "reported", "offloaded"), [
    (None, 51_200, True), (None, 51_199, False),
    (20_000, 20_000, True), (20_000, 19_999, False),
])
async def test_reported_context_pressure_offloads_before_the_next_request(
    tmp_path: Path, threshold: int | None, reported: int, offloaded: bool,
) -> None:
    provider = _SequencedProvider([
        _capture_call("old-image"), _capture_call("latest-image", prompt_tokens=reported),
        LLMResponse(content="Finished."),
    ])
    registry = ToolRegistry()
    registry.register(_ScreenshotTool())
    result = await AgentRunner(provider).run(_runner_spec(
        tmp_path, registry, auto_compact_token_limit=threshold,
    ))

    assert result.stop_reason == "completed"
    assert len(provider.requests) == 3
    assert _image_count(provider.requests[2]) == (1 if offloaded else 2)
    assert _image_count(result.messages) == 2
    assert result.usage["prompt_tokens"] == 20 + reported


@pytest.mark.parametrize("storage_fails", [False, True])
async def test_overflow_without_safe_image_reduction_stops_without_replaying_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, storage_fails: bool,
) -> None:
    if storage_fails:
        def fail_storage(*_args: Any, **_kwargs: Any) -> Path:
            raise OSError("image storage unavailable")
        monkeypatch.setattr("mona.agent.context_recovery.store_media_bytes", fail_storage)
    provider = _SequencedProvider([
        _append_call(), _capture_call("image-one"),
        *([_capture_call("image-two")] if storage_fails else []),
        LLMResponse(content="prompt is too long", finish_reason="error"),
    ])
    registry = _tool_registry(tmp_path / "tool-side-effect.txt")
    screenshots = _ScreenshotTool()
    registry.register(screenshots)

    result = await AgentRunner(provider).run(_runner_spec(tmp_path, registry))

    assert result.stop_reason == "context_limit"
    assert len(provider.requests) == (4 if storage_fails else 3)
    assert screenshots.calls == (2 if storage_fails else 1)
    assert (tmp_path / "tool-side-effect.txt").read_text(encoding="utf-8") == "completed\n"
    assert _image_count(result.messages) == (2 if storage_fails else 1)


async def test_image_offload_targets_occurrences_when_tool_call_ids_are_reused(tmp_path: Path) -> None:
    from mona.agent.context_recovery import offload_tool_images, project_tool_images
    from mona.agent.tools.filesystem import ReadFileTool

    source = [
        {"role": "tool", "tool_call_id": "reused-id", "content": [copy.deepcopy(_IMAGE)]},
        {"role": "tool", "tool_call_id": "reused-id", "content": [copy.deepcopy(_IMAGE)]},
    ]
    original = copy.deepcopy(source)

    projected = project_tool_images(source, offload_tool_images(source, tmp_path, "test"))

    assert _image_count(projected) == 1
    assert projected[-1] == original[-1]
    assert source == original
    assert offload_tool_images(projected, tmp_path, "test") == {}
    saved = next(tmp_path.glob(".mona/tool-results/**/sha256-*.png"))
    reader = ReadFileTool(workspace=tmp_path, allowed_dir=tmp_path)
    restored = await reader.execute(path=str(saved))
    assert restored[0]["type"] == "image_url"
    assert restored[0]["image_url"] == _IMAGE["image_url"]


@pytest.mark.parametrize("stop_at_limit", [False, True])
async def test_tool_free_finalization_keeps_the_image_projection(tmp_path: Path, stop_at_limit: bool) -> None:
    captures = 3 if stop_at_limit else 5
    provider = _SequencedProvider([
        *[_capture_call(f"image-{index}", prompt_tokens=51_200) for index in range(captures)],
        LLMResponse(content="Recorded the completed work."),
    ])
    registry = ToolRegistry()
    screenshots = _ScreenshotTool()
    registry.register(screenshots)
    spec = _runner_spec(tmp_path, registry)
    spec.max_iterations = captures if stop_at_limit else 8

    result = await AgentRunner(provider).run(spec)

    assert result.stop_reason == ("max_iterations" if stop_at_limit else "loop_detected")
    assert screenshots.calls == captures
    assert len(provider.requests) == captures + 1
    assert _image_count(provider.requests[-1]) == 1
    assert _image_count(result.messages) == captures
    assert all(request[0] == _SYSTEM for request in provider.requests)


async def test_saved_history_and_checkpoints_keep_recoverable_tool_image_paths(tmp_path: Path) -> None:
    from mona.agent.loop import AgentLoop
    from mona.agent.tools.filesystem import ReadFileTool

    sessions = SessionManager(tmp_path)
    session = sessions.get_or_create("test:image-restore")
    loop = object.__new__(AgentLoop)
    loop.sessions = sessions
    loop.max_tool_result_chars = 4096
    checkpoints = []

    async def checkpoint(payload: dict) -> None:
        loop._set_runtime_checkpoint(session, payload)
        checkpoints.append(copy.deepcopy(session.metadata[loop._RUNTIME_CHECKPOINT_KEY]))

    provider = _SequencedProvider([
        _capture_call("old-image"), _capture_call("latest-image", prompt_tokens=51_200),
        LLMResponse(content="Finished."),
    ])
    registry = ToolRegistry()
    registry.register(_ScreenshotTool())
    spec = _runner_spec(tmp_path, registry, checkpoint_callback=checkpoint)
    result = await AgentRunner(provider).run(spec)
    saved = next(tmp_path.glob(".mona/tool-results/**/sha256-*.png"))

    recorded = [*checkpoints[-1]["completed_messages"], *checkpoints[-1]["completed_tool_results"]]
    assert any(
        str(saved) in block.get("text", "")
        for message in recorded if isinstance(message.get("content"), list)
        for block in message["content"]
    )
    assert "data:image/" not in str(checkpoints[-1])
    loop._save_turn(session, result.messages, 1)
    sessions.save(session)
    restored = SessionManager(tmp_path).get_or_create(session.key)
    image_results = [m for m in restored.messages if m.get("role") == "tool"]
    assert len(image_results) == 2
    assert all(
        any(str(saved) in block.get("text", "") for block in message["content"])
        for message in image_results
    )
    assert "data:image/" not in str(restored.messages)
    image = await ReadFileTool(workspace=tmp_path, allowed_dir=tmp_path).execute(path=str(saved))
    assert image[0]["image_url"] == _IMAGE["image_url"]
