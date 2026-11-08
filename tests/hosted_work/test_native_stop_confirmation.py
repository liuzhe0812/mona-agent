"""Hosted Codex close must not mistake an interrupt acknowledgement for a stop."""
import asyncio
from types import SimpleNamespace

import pytest

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.executors.rpc import RpcError
from mona.hosted_work.native_provider import HostedNativeWorkProvider


class _Host:
    def __init__(self, outcome="requested"):
        self.outcome = outcome
        self.interrupts = []
        self.shutdown_called = False
        self.sent = asyncio.Event()

    async def interrupt(self, binding, *, native_turn_id=None):
        self.interrupts.append((binding, native_turn_id))
        self.sent.set()
        return SimpleNamespace(outcome=self.outcome)

    async def shutdown(self):
        self.shutdown_called = True


def _provider(tmp_path, host, *, turn_id="turn-a", stage="response"):
    _resolve_tool_config_refs()
    config = Config()
    config.agents.defaults.executor = "codex"
    provider = HostedNativeWorkProvider(config, tmp_path)
    provider._host = host
    provider._binding = object()
    provider._native_turn_id = turn_id
    provider._request_stage = stage
    return provider


async def _events(queue):
    while True:
        yield await queue.get()


@pytest.mark.asyncio
async def test_requested_interrupt_waits_for_the_exact_turn_and_shuts_down(tmp_path):
    host = _Host()
    provider = _provider(tmp_path, host)
    queue = asyncio.Queue()
    provider._events = _events(queue)
    provider._event_task = asyncio.create_task(anext(provider._events))
    await queue.put(SimpleNamespace(native_turn_id="other-turn", type="run.completed", payload={}))
    await queue.put(SimpleNamespace(native_turn_id="turn-a", type="run.interrupted", payload={}))
    binding = provider._binding

    await provider.aclose()

    assert host.interrupts == [(binding, "turn-a")]
    assert host.shutdown_called is True
    assert provider._host is None


@pytest.mark.asyncio
async def test_unconfirmed_interrupt_closes_local_host_but_preserves_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.hosted_work.native_provider._STOP_CONFIRM_TIMEOUT", 0.02)
    host = _Host()
    provider = _provider(tmp_path, host)
    queue = asyncio.Queue()
    provider._events = _events(queue)
    provider._event_task = asyncio.create_task(anext(provider._events))
    # Another turn's completion must not confirm this one.
    await queue.put(SimpleNamespace(native_turn_id="other-turn", type="run.completed", payload={}))

    with pytest.raises(RpcError) as error:
        await provider.aclose()

    assert error.value.code == "native_stop_unconfirmed" and error.value.outcome_unknown is True
    assert provider._native_status == "unknown"
    assert host.shutdown_called is True
    assert len(host.interrupts) == 1
    assert provider.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_confirmed_receipt_needs_no_event_and_does_not_interrupt_twice(tmp_path):
    host = _Host("confirmed")
    provider = _provider(tmp_path, host)
    await provider.aclose()
    assert len(host.interrupts) == 1 and host.shutdown_called


@pytest.mark.asyncio
async def test_interrupt_does_not_wait_for_cancelled_approval_cleanup(tmp_path):
    order = []

    class Host(_Host):
        async def interrupt(self, binding, *, native_turn_id=None):
            order.append("interrupt")
            return await super().interrupt(binding, native_turn_id=native_turn_id)

    async def approval():
        try:
            await asyncio.Event().wait()
        finally:
            order.append("approval_closed")

    host = Host("confirmed")
    provider = _provider(tmp_path, host)
    pending = asyncio.create_task(approval())
    await asyncio.sleep(0)
    provider._native_permissions["item"] = ("fingerprint", pending)
    await provider.aclose()
    assert order == ["interrupt", "approval_closed"]
    assert host.shutdown_called


@pytest.mark.asyncio
async def test_missing_turn_identity_after_dispatch_is_not_reported_stopped(tmp_path):
    host = _Host("already_finished")
    provider = _provider(tmp_path, host, turn_id=None, stage="dispatch")
    with pytest.raises(RpcError) as error:
        await provider.aclose()
    assert error.value.code == "native_stop_unconfirmed" and host.shutdown_called


@pytest.mark.asyncio
async def test_pre_dispatch_close_needs_no_stop_confirmation(tmp_path):
    host = _Host()
    provider = _provider(tmp_path, host, turn_id=None, stage="initialization")
    await provider.aclose()
    assert host.interrupts == [] and host.shutdown_called


@pytest.mark.asyncio
async def test_terminal_receipt_cannot_mask_unconfirmed_local_process_exit(tmp_path):
    class Host(_Host):
        async def shutdown(self):
            self.shutdown_called = True
            raise RpcError("native_exit_unconfirmed", "exit unconfirmed", outcome_unknown=True)

    host = Host("confirmed")
    provider = _provider(tmp_path, host)
    with pytest.raises(RpcError) as error:
        await provider.aclose()
    assert error.value.code == "native_exit_unconfirmed"
    assert host.shutdown_called and provider.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_cancelling_close_still_shuts_down_the_host(tmp_path):
    host = _Host()
    provider = _provider(tmp_path, host)
    queue = asyncio.Queue()
    provider._events = _events(queue)
    provider._event_task = asyncio.create_task(anext(provider._events))
    task = asyncio.create_task(provider.aclose())
    await host.sent.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert host.shutdown_called is True and len(host.interrupts) == 1
