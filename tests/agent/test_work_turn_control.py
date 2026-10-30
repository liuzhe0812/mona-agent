import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.partners import CONVERSATION_METADATA_KEY, ConversationMetadata
from mona.bus.events import InboundMessage, OutboundMessage
from mona.bus.queue import MessageBus
from mona.session.manager import SessionManager
from mona.session.webui_turns import WebuiTurnCoordinator
from mona.session.work_turns import WorkTurnBlockedError, WorkTurnController


def held_task():
    return asyncio.create_task(asyncio.Event().wait())


async def cancel_task(task):
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_finished_and_foreign_id_never_cancel_the_new_task():
    control = WorkTurnController()
    first = asyncio.create_task(asyncio.sleep(0))
    one = control.start("session", "chat", first, lambda: cancel_task(first))
    await first
    control.finish(one.turn_id)
    second = held_task()
    two = control.start("session", "chat", second, lambda: cancel_task(second))
    assert two.turn_id != one.turn_id
    assert await control.stop("chat", one.turn_id) == "already_finished"
    assert await control.stop("other-chat", two.turn_id) == "unknown"
    assert await control.stop("chat", "missing") == "unknown"
    assert not second.done()
    assert await control.stop("chat", two.turn_id) == "stopped"


async def test_stop_timeout_keeps_barrier_until_original_cleanup_is_observed():
    control = WorkTurnController(stop_timeout_seconds=0.01)
    task = held_task()
    release = asyncio.Event()
    calls = []

    async def cleanup():
        calls.append(True)
        await cancel_task(task)
        await release.wait()

    turn = control.start("session", "chat", task, cleanup)
    assert await control.stop("chat", turn.turn_id) == "unknown"
    assert control.snapshot("chat")["state"] == "unknown"
    waiting = asyncio.create_task(control.wait_ready("session"))
    await asyncio.sleep(0)
    assert not waiting.done()
    assert await control.stop("chat", turn.turn_id) == "unknown"
    assert calls == [True]
    release.set()
    await turn.cleanup_task
    await waiting
    assert control.current("chat") is None
    assert await control.stop("chat", turn.turn_id) == "already_finished"


async def test_failed_cleanup_keeps_session_blocked():
    control = WorkTurnController()
    task = held_task()

    async def cleanup():
        await cancel_task(task)
        raise RuntimeError("synthetic cleanup failure")

    turn = control.start("session", "chat", task, cleanup)
    assert await control.stop("chat", turn.turn_id) == "unknown"
    with pytest.raises(WorkTurnBlockedError):
        await control.wait_ready("session")


async def test_external_unknown_releases_only_completed_local_barrier():
    control = WorkTurnController()
    task = held_task()

    async def cleanup():
        await cancel_task(task)
        return "unknown"

    turn = control.start("session", "chat", task, cleanup)
    assert await control.stop("chat", turn.turn_id) == "unknown"
    assert control.current("chat") is None
    await control.wait_ready("session")
    newer = held_task()
    next_turn = control.start("session", "chat", newer, lambda: cancel_task(newer))
    assert await control.stop("chat", turn.turn_id) == "unknown"
    assert not newer.done()
    assert await control.stop("chat", next_turn.turn_id) == "stopped"


async def test_finished_identity_retention_is_bounded_and_eviction_never_targets_current():
    control = WorkTurnController(max_finished=2)
    finished = []
    for _ in range(3):
        task = asyncio.create_task(asyncio.sleep(0))
        turn = control.start("session", "chat", task, lambda: cancel_task(task))
        await task
        control.finish(turn.turn_id)
        finished.append(turn.turn_id)
    active = held_task()
    turn = control.start("session", "chat", active, lambda: cancel_task(active))
    assert await control.stop("chat", finished[0]) == "unknown"
    assert not active.done()
    assert await control.stop("chat", turn.turn_id) == "stopped"


@pytest.fixture
def loop(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.session.webui_turns._WEBSOCKET_TURN_WALL_STARTED_AT", {})
    loop = AgentLoop.__new__(AgentLoop)
    loop.bus = MessageBus()
    loop._unified_session = False
    loop._session_locks = {}
    loop._concurrency_gate = None
    loop._pending_queues = {}
    loop._pending_turn_latency_ms = {}
    loop._pending_turn_usage = {}
    loop.sessions = SessionManager(tmp_path)
    loop.subagents = SimpleNamespace(get_running_count_by_session=lambda _key: 0)
    loop._restore_runtime_checkpoint = lambda _session: False
    loop._webui_turns = WebuiTurnCoordinator(loop.bus, loop.sessions, lambda coroutine: coroutine.close())
    return loop


@pytest.mark.parametrize("unified", [False, True])
async def test_real_dispatch_new_turn_waits_for_owned_cleanup_without_being_cancelled(loop, monkeypatch, unified):
    loop._unified_session = unified
    started = {key: asyncio.Event() for key in ("A", "B")}
    release_b = asyncio.Event()
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    messages = {}

    async def process(message, **_kwargs):
        messages[message.content] = message
        await loop._webui_turns.publish_run_status(message, "running")
        started[message.content].set()
        await (asyncio.Event() if message.content == "A" else release_b).wait()
        return OutboundMessage("websocket", message.chat_id, "done", metadata=message.metadata)

    real_cleanup = loop._cancel_work_turn

    async def cleanup(task, keys):
        result = await real_cleanup(task, keys)
        cleanup_started.set()
        await cleanup_release.wait()
        return result

    monkeypatch.setattr(loop, "_process_message", process)
    monkeypatch.setattr(loop, "_cancel_work_turn", cleanup)
    first = asyncio.create_task(loop._dispatch(InboundMessage(
        "websocket", "fixture", "chat-a", "A", metadata={"task_id": "shared-goal", "input_id": "input-a"},
    )))
    await started["A"].wait()
    turn_a = loop.bus.work_turns.current("chat-a")
    stopped = asyncio.create_task(loop.bus.work_turns.stop("chat-a", turn_a.turn_id))
    await cleanup_started.wait()
    chat_b = "chat-b" if unified else "chat-a"
    second = asyncio.create_task(loop._dispatch(InboundMessage(
        "websocket", "fixture", chat_b, "B", metadata={"task_id": "shared-goal", "input_id": "input-b"},
    )))
    await asyncio.sleep(0)
    assert not started["B"].is_set()
    cleanup_release.set()
    assert await stopped == "stopped"
    await started["B"].wait()
    turn_b = loop.bus.work_turns.current(chat_b)
    assert turn_a.turn_id != turn_b.turn_id
    assert messages["A"].metadata["task_id"] == messages["B"].metadata["task_id"]
    assert messages["A"].metadata["turn_id"] == turn_a.turn_id
    assert turn_a.session_key == turn_b.session_key
    assert await loop.bus.work_turns.stop("chat-a", turn_a.turn_id) == "already_finished"
    assert not second.done()
    assert loop._pending_queues[turn_b.session_key] is not None
    release_b.set()
    await second
    await asyncio.gather(first, return_exceptions=True)


async def test_precise_owner_stop_leaves_independent_room_job_running(loop, monkeypatch):
    owner = held_task()
    independent = held_task()
    broad_cancel = AsyncMock(return_value=1)
    loop.subagents = SimpleNamespace(get_running_count_by_session=lambda _key: 1, cancel_by_session=broad_cancel)
    result = await loop._cancel_work_turn(owner, ["websocket:chat"])
    assert result == "unknown"
    assert owner.cancelled()
    assert not independent.done()
    broad_cancel.assert_not_awaited()
    await cancel_task(independent)


@pytest.mark.parametrize("route", ["partner", "video"])
async def test_named_and_document_routes_keep_the_outer_turn_owner(loop, monkeypatch, route):
    entered = asyncio.Event()
    seen = []

    async def delegated(message, **_kwargs):
        seen.append((asyncio.current_task(), message.metadata["turn_id"]))
        entered.set()
        await asyncio.Event().wait()

    for name in ("_refresh_provider_snapshot", "_refresh_mona_user_config", "_refresh_media_generation_tools"):
        monkeypatch.setattr(loop, name, Mock())
    monkeypatch.setattr(loop, "_sync_computer_use_runtime", AsyncMock())
    delegate = SimpleNamespace(_process_message=delegated)
    metadata = {"task_id": "same-goal"}
    if route == "video":
        metadata["agent_kind"] = "video"
        monkeypatch.setattr(loop, "_ensure_document_loop", lambda _kind: delegate)
    else:
        session = loop.sessions.get_or_create("websocket:chat-a")
        session.metadata[CONVERSATION_METADATA_KEY] = ConversationMetadata.direct("com.example.fixture").to_session_metadata()
        monkeypatch.setattr(loop, "_ensure_partner_loop", lambda _agent: delegate)
    owner = asyncio.create_task(loop._dispatch(InboundMessage("websocket", "fixture", "chat-a", "request", metadata=metadata)))
    await entered.wait()
    turn = loop.bus.work_turns.current("chat-a")
    assert seen == [(owner, turn.turn_id)]
    assert await loop.bus.work_turns.stop("chat-a", turn.turn_id) == "stopped"
    assert owner.cancelled()
