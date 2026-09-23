"""Regression cases for dispatch after budgets, revocation and provider errors."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.computer_use import executor
from mona.config.schema import Config


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "disabled", "permission", "low_confidence", "provider_error"])
async def test_run_preserves_handoff_and_does_not_dispatch_after_guard(monkeypatch, failure):
    state = SimpleNamespace(disabled=False, observation=None, observations=0)
    candidate = {"id": "button", "role": "button", "label": "Continue", "actions": ["click"], "element_token": "s1:0"}

    async def observe():
        state.observations += 1
        if failure == "timeout":
            await asyncio.sleep(0.1)
        state.observation = {"pid": 1, "window_id": 2, "candidates": [candidate], "summary": "fixture"}

    async def decide(**_kwargs):
        if failure in {"disabled", "permission"}:
            state.disabled = True
        if failure == "provider_error" and state.observations > 1:
            raise RuntimeError("provider unavailable")
        confidence = 0.1 if failure == "low_confidence" else 1
        return {"operation": {"choice": "CLICK", "confidence": confidence}, "click_target": {"choice": "button", "confidence": 1}}

    monkeypatch.setattr(executor, "request_decisions", decide)
    act = AsyncMock(return_value="dispatched")
    result = await executor.run_computer_goal(
        pid=1, window_id=2, goal="continue", completion_criteria="next page", text_values=[],
        max_steps=3, max_duration_seconds=0.01 if failure == "timeout" else 5,
        decision_config=Config().tools.jev,
        observe=observe, act=act, get_observation=lambda: state.observation,
        is_stopped=lambda: False,
        guard=lambda: failure if state.disabled else None, settle_seconds=0,
    )
    assert result["status"] in {"handoff", "time_limit"}
    assert act.await_count == (1 if failure == "provider_error" else 0)
    assert len(result["actions"]) == act.await_count
    if failure == "provider_error":
        assert result["snapshot_current"] is True
        assert result["observation"] is not None


@pytest.mark.asyncio
async def test_cancel_during_decision_propagates_without_dispatch(monkeypatch):
    entered = asyncio.Event()
    async def decide(**kwargs):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(executor, "request_decisions", decide)
    act = AsyncMock()
    task = asyncio.create_task(executor.run_computer_goal(
        pid=1, window_id=2, goal="continue", completion_criteria="next page", text_values=[],
        max_steps=3, max_duration_seconds=5, decision_config=Config().tools.jev,
        observe=AsyncMock(), act=act, get_observation=lambda: {"candidates": []},
        is_stopped=lambda: False,
    ))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    act.assert_not_awaited()
