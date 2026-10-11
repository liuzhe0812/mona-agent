from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

from mona.agent.memory import Consolidator, MemoryStore
from mona.session.manager import Session, SessionManager
from mona.utils.helpers import (
    estimate_message_tokens,
    estimate_prompt_tokens,
    estimate_prompt_tokens_chain,
)


@pytest.mark.parametrize(
    "message",
    [
        {"role": "user", "content": "A short plain-text prompt."},
        {
            "role": "tool",
            "name": "read_file",
            "tool_call_id": "call-read-1",
            "content": {"ok": True, "rows": ["one", "two"]},
        },
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call-read-2",
                "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"notes.txt"}'},
            }],
            "reasoning_content": "Check the requested file before responding.",
        },
    ],
)
def test_single_message_and_prompt_estimates_share_text_protocol_basis(
    message: dict[str, Any],
) -> None:
    assert estimate_message_tokens(message) == estimate_prompt_tokens([message])


def test_inline_image_payload_size_does_not_change_text_estimate_or_mutate_message() -> None:
    text = "Describe the attached picture."
    small = {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            {"type": "image", "data": "data:image/jpeg;base64,AAAA"},
        ],
    }
    large = {
        "role": "user",
        "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + "A" * 1_000_000}},
            {"type": "image", "data": "data:image/jpeg;base64," + "B" * 1_000_000},
        ],
    }
    original_large = copy.deepcopy(large)

    assert estimate_message_tokens(small) == estimate_message_tokens(large)
    assert estimate_prompt_tokens([small]) == estimate_prompt_tokens([large])
    assert large == original_large


def test_positive_provider_token_counter_keeps_priority() -> None:
    message = {"role": "user", "content": "provider estimate wins"}

    class ProviderCounter:
        calls = 0

        def estimate_prompt_tokens(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]] | None,
            model: str | None,
        ) -> tuple[int, str]:
            self.calls += 1
            assert messages == [message]
            assert tools is None
            assert model == "test-model"
            return 317, "provider-counter"

    provider = ProviderCounter()
    assert estimate_prompt_tokens_chain(provider, "test-model", [message]) == (
        317,
        "provider-counter",
    )
    assert provider.calls == 1


def test_real_consolidation_boundary_ignores_inline_image_transport_size(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    memory_root = tmp_path / "agent-memory"
    monkeypatch.setattr(
        "mona.config.paths.get_agent_memory_dir",
        lambda _agent_id: memory_root,
    )
    consolidator = Consolidator(
        store=MemoryStore(tmp_path),
        provider=object(),
        model="test-model",
        sessions=SessionManager(tmp_path / "sessions"),
        context_window_tokens=100_000,
        build_messages=lambda **_kwargs: [],
        get_tool_definitions=lambda: [],
        max_completion_tokens=128,
    )

    def make_session(image_url: str) -> Session:
        return Session(
            key="test:boundary",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "x"},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                },
                {"role": "assistant", "content": "y"},
                {"role": "user", "content": "x"},
                {"role": "assistant", "content": "y"},
                {"role": "user", "content": "x"},
                {"role": "assistant", "content": "y"},
                {"role": "user", "content": "current turn"},
            ],
        )

    small = make_session("data:image/png;base64,AAAA")
    huge = make_session("data:image/png;base64," + "A" * 1_000_000)

    small_boundary = consolidator.pick_consolidation_boundary(small, tokens_to_remove=25)
    huge_boundary = consolidator.pick_consolidation_boundary(huge, tokens_to_remove=25)

    assert small_boundary == huge_boundary
    assert small_boundary is not None
    assert small_boundary[0] == 6
