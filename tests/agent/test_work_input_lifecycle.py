import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.runner import AgentRunResult
from mona.bus.events import InboundMessage, OutboundMessage
from mona.bus.queue import MessageBus
from mona.command import CommandRouter, register_builtin_commands
from mona.session.manager import SessionManager
from mona.session.webui_turns import WebuiTurnCoordinator
from mona.session.work_turns import WorkTurnController


def start(control, *, chat="guide-chat"):
    task = asyncio.create_task(asyncio.Event().wait())

    async def cancel():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    return task, control.start(f"websocket:{chat}", chat, task, cancel)


async def until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


async def test_resume_requires_paused_identity_and_never_repeats_consumed_input():
    control = WorkTurnController()
    task_a, a = start(control)
    item, publish = control.accept_input("guide-chat", "guide-one", a.turn_id)
    assert publish
    control.confirm_input("guide-chat", "guide-one")
    assert not control.accept_input("guide-chat", "guide-one", a.turn_id)[1]
    assert await control.stop("guide-chat", a.turn_id) == "stopped"
    assert item.state == "paused"
    assert not control.accept_input("guide-chat", "guide-one", a.turn_id)[1]
    task_b, b = start(control)
    assert control.accept_input("guide-chat", "guide-one", b.turn_id, resume=True)[1]
    control.confirm_input("guide-chat", "guide-one")
    control.bind_input("guide-chat", "guide-one", b.turn_id)
    assert control.consume_input("guide-chat", "guide-one", b.turn_id)
    assert not control.accept_input("guide-chat", "guide-one", b.turn_id, resume=True)[1]
    await control.stop("guide-chat", a.turn_id)
    assert control.input_state("guide-chat", "guide-one")["state"] == "consumed"
    assert not task_b.done()
    await control.stop("guide-chat", b.turn_id)
    assert control.input_state("guide-chat", "guide-one")["state"] == "consumed"
    assert not control.accept_input("guide-chat", "guide-one", b.turn_id, resume=True)[1]
    await asyncio.gather(task_a, return_exceptions=True)


async def test_capacity_is_reclaimed_when_consuming_turn_finishes():
    control = WorkTurnController(max_inputs=1)
    task, turn = start(control)
    assert control.accept_input("guide-chat", "first", turn.turn_id)[1]
    control.confirm_input("guide-chat", "first")
    control.bind_input("guide-chat", "first", turn.turn_id)
    assert control.consume_input("guide-chat", "first", turn.turn_id)
    assert not control.accept_input("guide-chat", "second", turn.turn_id)[1]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    control.finish(turn.turn_id)
    newer, next_turn = start(control)
    assert control.accept_input("guide-chat", "second", next_turn.turn_id)[1]
    await control.stop("guide-chat", next_turn.turn_id)
    await asyncio.gather(newer, return_exceptions=True)


async def test_foreign_chat_stop_cannot_pause_another_turn_pending_inputs():
    control = WorkTurnController()
    task_a, a = start(control, chat="chat-a")
    task_b, b = start(control, chat="chat-b")
    control.accept_input("chat-b", "guide-b", b.turn_id)
    control.confirm_input("chat-b", "guide-b")
    control.bind_input("chat-b", "guide-b", b.turn_id)
    assert await control.stop("chat-a", b.turn_id) == "unknown"
    assert control.input_state("chat-b", "guide-b")["state"] == "accepted"
    assert not task_b.done()
    await control.stop("chat-a", a.turn_id)
    await control.stop("chat-b", b.turn_id)
    await asyncio.gather(task_a, task_b, return_exceptions=True)


async def test_normal_leftover_can_continue_but_old_stop_pauses_only_unconsumed_input():
    control = WorkTurnController()
    task, old = start(control)
    control.accept_input("guide-chat", "leftover", old.turn_id)
    control.confirm_input("guide-chat", "leftover")
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    control.finish(old.turn_id)
    assert control.can_dispatch_input("guide-chat", "leftover", old.turn_id)
    assert await control.stop("guide-chat", old.turn_id) == "already_finished"
    assert control.input_state("guide-chat", "leftover")["state"] == "paused"
    assert not control.can_dispatch_input("guide-chat", "leftover", old.turn_id)


async def test_old_target_stop_cannot_requeue_leftover_already_consumed_by_a_new_turn():
    control = WorkTurnController()
    task, old = start(control)
    control.accept_input("guide-chat", "leftover", old.turn_id)
    control.confirm_input("guide-chat", "leftover")
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    control.finish(old.turn_id)
    newer, current = start(control)
    control.bind_input("guide-chat", "leftover", current.turn_id)
    assert control.consume_input("guide-chat", "leftover", old.turn_id)
    assert control.input_state("guide-chat", "leftover")["turn_id"] == old.turn_id
    assert await control.stop("guide-chat", old.turn_id) == "already_finished"
    assert control.input_state("guide-chat", "leftover")["state"] == "consumed"
    assert not newer.done()
    await control.stop("guide-chat", current.turn_id)


@pytest.fixture
def loop(tmp_path, monkeypatch):
    loop = AgentLoop.__new__(AgentLoop)
    loop.bus = MessageBus()
    loop._unified_session = False
    loop._session_locks = {}
    loop._concurrency_gate = None
    loop._pending_queues = {}
    loop._active_tasks = {}
    loop._pending_turn_latency_ms = {}
    loop._pending_turn_usage = {}
    loop._background_tasks = []
    loop._connect_mcp = AsyncMock()
    loop._restore_runtime_checkpoint = lambda _session: False
    loop.auto_compact = SimpleNamespace(check_expired=Mock())
    loop.sessions = SessionManager(tmp_path)
    loop.subagents = SimpleNamespace(recover_jobs=AsyncMock(), recover_workflow_runs=AsyncMock(),
                                    get_running_count_by_session=lambda _key: 0, cancel_by_session=AsyncMock(return_value=0))
    loop.commands = CommandRouter()
    register_builtin_commands(loop.commands)
    loop._webui_turns = WebuiTurnCoordinator(loop.bus, loop.sessions, lambda coroutine: coroutine.close())
    monkeypatch.setattr("mona.agent.tools.exec_session.DEFAULT_EXEC_SESSION_MANAGER.cancel_by_session", AsyncMock(return_value=0))
    monkeypatch.setattr("mona.agent.tools.terminal.cancel_terminal_tasks_by_session", AsyncMock(return_value=0))
    monkeypatch.setattr("mona.computer_use.session.mark_computer_turn_stopped", Mock())
    monkeypatch.setattr("mona.computer_use.session.stop_computer_turns", AsyncMock())
    return loop


@pytest.mark.parametrize("stop_kind", ["structured", "typed"])
@pytest.mark.parametrize("guides", [1, 21])
async def test_stopping_unconsumed_guides_never_republishes_them_as_tasks(loop, monkeypatch, stop_kind, guides):
    entered = asyncio.Event()
    calls = []

    async def process(message, **_kwargs):
        calls.append(message.content)
        entered.set()
        await asyncio.Event().wait()
        return OutboundMessage("websocket", message.chat_id, "done", metadata=message.metadata)

    monkeypatch.setattr(loop, "_process_message", process)
    driver = asyncio.create_task(loop.run())
    try:
        await loop.bus.publish_inbound(InboundMessage("websocket", "fixture", "guide-chat", "primary"))
        await asyncio.wait_for(entered.wait(), 1)
        turn = loop.bus.work_turns.current("guide-chat")
        for index in range(guides):
            identity = f"guide-{index}"
            loop.bus.work_turns.accept_input("guide-chat", identity, turn.turn_id)
            await loop.bus.publish_inbound(InboundMessage("websocket", "fixture", "guide-chat", identity,
                metadata={"input_id": identity, "target_turn_id": turn.turn_id}))
        await until(lambda: loop._pending_queues[turn.session_key].qsize() == min(guides, 20))
        if guides == 21:
            await until(lambda: len(loop._active_tasks.get(turn.session_key, [])) >= 2)
        if stop_kind == "structured":
            assert await loop.bus.work_turns.stop("guide-chat", turn.turn_id) == "stopped"
        else:
            await loop.bus.publish_inbound(InboundMessage("websocket", "fixture", "guide-chat", "/stop"))
        await until(lambda: loop.bus.work_turns.current("guide-chat") is None)
        for _ in range(5):
            await asyncio.sleep(0)
        assert calls == ["primary"]
        assert all(loop.bus.work_turns.input_state("guide-chat", f"guide-{index}")["state"] == "paused"
                   for index in range(guides))
        assert loop.bus.inbound_size == 0
    finally:
        loop._running = False
        driver.cancel()
        for tasks in loop._active_tasks.values():
            for task in tasks:
                task.cancel()
        await asyncio.gather(driver, return_exceptions=True)


async def test_stop_while_guide_media_is_preparing_does_not_consume_it(loop_factory, tmp_path, monkeypatch):
    from tests.agent.conftest import make_provider

    loop = loop_factory(provider=make_provider(spec=False))
    pending = asyncio.Queue()
    prepare_started, release = asyncio.Event(), asyncio.Event()
    begin = asyncio.Event()
    projected = []
    real_to_thread = asyncio.to_thread
    from mona.agent import loop as module

    async def preparing(function, *args, **kwargs):
        if function is module.extract_documents:
            prepare_started.set()
            await release.wait()
            return "prepared", []
        return await real_to_thread(function, *args, **kwargs)

    monkeypatch.setattr(module.asyncio, "to_thread", preparing)

    async def run(spec):
        projected.extend(await spec.injection_callback())
        return AgentRunResult("done", spec.initial_messages, stop_reason="completed")

    monkeypatch.setattr(loop.runner, "run", run)

    async def work():
        await begin.wait()
        await loop._run_agent_loop([{"role": "user", "content": "primary"}], channel="websocket", chat_id="guide-chat",
            metadata={"turn_id": turn.turn_id}, pending_queue=pending)

    owner = asyncio.create_task(work())

    async def cleanup():
        release.set()
        await owner

    turn = loop.bus.work_turns.start("websocket:guide-chat", "guide-chat", owner, cleanup)
    loop.bus.work_turns.accept_input("guide-chat", "media-guide", turn.turn_id)
    loop.bus.work_turns.confirm_input("guide-chat", "media-guide")
    pending.put_nowait(InboundMessage("websocket", "fixture", "guide-chat", "guide", media=[str(tmp_path / "guide.txt")],
        metadata={"input_id": "media-guide", "target_turn_id": turn.turn_id}))
    begin.set()
    await asyncio.wait_for(prepare_started.wait(), 1)
    assert await loop.bus.work_turns.stop("guide-chat", turn.turn_id) == "stopped"
    assert projected == []
    assert loop.bus.work_turns.input_state("guide-chat", "media-guide")["state"] == "paused"


async def test_priority_stop_input_is_consumed_before_pausing_other_guides(loop, monkeypatch):
    entered = asyncio.Event()

    async def process(_message, **_kwargs):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(loop, "_process_message", process)
    driver = asyncio.create_task(loop.run())
    try:
        await loop.bus.publish_inbound(InboundMessage("websocket", "fixture", "guide-chat", "primary"))
        await asyncio.wait_for(entered.wait(), 1)
        turn = loop.bus.work_turns.current("guide-chat")
        loop.bus.work_turns.accept_input("guide-chat", "stop-command", turn.turn_id)
        await loop.bus.publish_inbound(InboundMessage("websocket", "fixture", "guide-chat", "/stop",
            metadata={"input_id": "stop-command", "target_turn_id": turn.turn_id}))
        await until(lambda: loop.bus.work_turns.current("guide-chat") is None)
        notifications = []
        while loop.bus.outbound_size:
            event = await loop.bus.consume_outbound()
            if event.metadata.get("_work_input_state"):
                notifications.append(event.metadata["_work_input_state"])
        assert any(item["input_id"] == "stop-command" and item["state"] == "consumed" for item in notifications)
        assert not any(item["input_id"] == "stop-command" and item["state"] == "paused" for item in notifications)
    finally:
        loop._running = False
        driver.cancel()
        await asyncio.gather(driver, return_exceptions=True)
