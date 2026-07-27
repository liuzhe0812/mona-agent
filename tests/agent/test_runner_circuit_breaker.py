"""Tests for the tool failure circuit-breaker in AgentRunner."""

from __future__ import annotations

from unittest.mock import MagicMock

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.providers.base import ToolCallRequest


def _spec(max_failures: int = 3) -> AgentRunSpec:
    return AgentRunSpec(
        initial_messages=[],
        tools=MagicMock(),
        model="test-model",
        max_iterations=1,
        max_tool_result_chars=4096,
        max_tool_failures=max_failures,
    )


def _call(name: str) -> ToolCallRequest:
    return ToolCallRequest(id=f"call-{name}", name=name, arguments={})


def test_success_resets_counter():
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    AgentRunner._update_failure_counts(
        counts, disabled, [_call("t1")], [{"name": "t1", "status": "ok"}],
        spec=_spec(),
    )
    assert counts["t1"] == 0
    assert not disabled


def test_failure_below_threshold_does_not_disable():
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    for _ in range(2):
        AgentRunner._update_failure_counts(
            counts, disabled, [_call("t1")], [{"name": "t1", "status": "error"}],
            spec=_spec(max_failures=3),
        )
    assert counts["t1"] == 2
    assert not disabled


def test_failure_at_threshold_disables_tool():
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    spec = _spec(max_failures=3)
    for _ in range(3):
        AgentRunner._update_failure_counts(
            counts, disabled, [_call("t1")], [{"name": "t1", "status": "error"}],
            spec=spec,
        )
    assert "t1" in disabled


def test_already_disabled_tool_not_counted_again():
    counts: dict[str, int] = {"t1": 3}
    disabled: set[str] = {"t1"}
    AgentRunner._update_failure_counts(
        counts, disabled, [_call("t1")], [{"name": "t1", "status": "error"}],
        spec=_spec(),
    )
    # Counter unchanged because the tool was already disabled and skipped.
    assert counts["t1"] == 3


def test_mixed_calls_count_independently():
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    spec = _spec(max_failures=2)
    AgentRunner._update_failure_counts(
        counts, disabled,
        [_call("good"), _call("bad")],
        [{"name": "good", "status": "ok"}, {"name": "bad", "status": "error"}],
        spec=spec,
    )
    assert counts["good"] == 0
    assert counts["bad"] == 1
    assert not disabled
    AgentRunner._update_failure_counts(
        counts, disabled,
        [_call("good"), _call("bad")],
        [{"name": "good", "status": "ok"}, {"name": "bad", "status": "error"}],
        spec=spec,
    )
    assert "bad" in disabled
    assert "good" not in disabled


def test_max_failures_zero_disables_feature():
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    spec = _spec(max_failures=0)
    AgentRunner._update_failure_counts(
        counts, disabled, [_call("t1")], [{"name": "t1", "status": "error"}],
        spec=spec,
    )
    assert not counts
    assert not disabled


def test_same_tool_called_twice_in_one_turn_counts_once():
    """Repeated calls to the same tool in one iteration count as a single failure."""
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    spec = _spec(max_failures=3)
    AgentRunner._update_failure_counts(
        counts, disabled,
        [_call("t1"), _call("t1")],
        [{"name": "t1", "status": "error"}, {"name": "t1", "status": "error"}],
        spec=spec,
    )
    assert counts["t1"] == 1
    assert not disabled


def test_mixed_success_failure_marks_as_error():
    """If one call succeeds and another fails, the tool is still counted as failed."""
    counts: dict[str, int] = {}
    disabled: set[str] = set()
    spec = _spec(max_failures=1)
    AgentRunner._update_failure_counts(
        counts, disabled,
        [_call("t1"), _call("t1")],
        [{"name": "t1", "status": "ok"}, {"name": "t1", "status": "error"}],
        spec=spec,
    )
    assert counts["t1"] == 1
    assert "t1" in disabled
