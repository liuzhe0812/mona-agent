"""Real loopback transport with a controlled executor, without models or tools.

The production channel, bus, admission, dispatcher and stop controller all run.
This does not exercise browser reconnect logic or external tool cancellation.
"""

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from websockets.asyncio.client import connect

from mona.agent.loop import AgentLoop
from mona.bus.queue import MessageBus
from mona.channels import websocket as websocket_module
from mona.channels.websocket import WebSocketChannel
from mona.command import CommandRouter
from mona.config import loader, paths
from mona.session import manager as session_module
from mona.session.manager import SessionManager
from mona.session.webui_turns import WebuiTurnCoordinator


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0)


class Peer:
    def __init__(self, socket, chat_id):
        self.socket = socket
        self.chat_id = chat_id
        self.pending = []

    async def send(self, **frame):
        await self.socket.send(json.dumps({"chat_id": self.chat_id, **frame}))

    async def receive(self, **fields):
        async with asyncio.timeout(3):
            while True:
                for index, frame in enumerate(self.pending):
                    if all(frame.get(key) == value for key, value in fields.items()):
                        return self.pending.pop(index)
                self.pending.append(json.loads(await self.socket.recv()))


class ControlledExecutor:
    def __init__(self, loop):
        self.loop = loop
        self.messages = []
        self.cancelled = []
        self.releases = {}

    async def __call__(self, message, **_kwargs):
        self.messages.append(message)
        await self.loop._webui_turns.publish_run_status(message, "running")
        try:
            await self.releases.setdefault(message.content, asyncio.Event()).wait()
        except asyncio.CancelledError:
            self.cancelled.append(message.content)
            raise

    def release(self, content):
        self.releases[content].set()

    @property
    def texts(self):
        return [message.content for message in self.messages]


@pytest.fixture
async def transport(tmp_path, monkeypatch):
    # Isolate both the current instance and the legacy cleanup/search roots.
    workspace = tmp_path / "workspace"
    monkeypatch.setattr(loader, "_current_config_path", tmp_path / "instance" / "config.json")
    monkeypatch.setattr(paths, "get_workspace_path", lambda _workspace=None: workspace)
    monkeypatch.setattr(session_module, "get_legacy_sessions_dir", lambda: tmp_path / "legacy-sessions")
    bus = MessageBus()
    sessions = SessionManager(workspace)
    channel = WebSocketChannel(
        {"enabled": True, "host": "127.0.0.1", "port": 0, "allowFrom": ["transport-fixture"]},
        bus, session_manager=sessions,
    )

    # Retain the real channel.start() and real serve(); observe its chosen port.
    real_serve = websocket_module.serve
    listening = asyncio.Event()
    port = None

    @asynccontextmanager
    async def serve(*args, **kwargs):
        nonlocal port
        async with real_serve(*args, **kwargs) as server:
            port = server.sockets[0].getsockname()[1]
            listening.set()
            yield server

    monkeypatch.setattr(websocket_module, "serve", serve)

    loop = AgentLoop.__new__(AgentLoop)
    loop.bus = bus
    loop.sessions = sessions
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
    loop.subagents = SimpleNamespace(
        recover_jobs=AsyncMock(), recover_workflow_runs=AsyncMock(),
        get_running_count_by_session=lambda _key: 0,
    )
    loop.commands = CommandRouter()
    loop._webui_turns = WebuiTurnCoordinator(bus, sessions, loop._schedule_background)
    executor = ControlledExecutor(loop)
    loop._process_message = executor

    async def send_outbound():
        while True:
            await channel.send(await bus.consume_outbound())

    tasks = [asyncio.create_task(channel.start()), asyncio.create_task(loop.run()),
             asyncio.create_task(send_outbound())]
    chat_id = f"transport-{uuid4().hex}"

    @asynccontextmanager
    async def open_peer():
        # The runtime token is ephemeral and is never logged or persisted here.
        uri = f"ws://127.0.0.1:{port}/?client_id=transport-fixture&token={channel._runtime_token}"
        async with connect(uri, proxy=None) as socket:
            peer = Peer(socket, chat_id)
            await peer.receive(event="ready")
            await peer.send(type="attach")
            await peer.receive(event="attached", chat_id=chat_id)
            yield peer

    try:
        await asyncio.wait_for(listening.wait(), 3)
        yield SimpleNamespace(channel=channel, bus=bus, loop=loop, executor=executor,
                              chat_id=chat_id, open_peer=open_peer)
        for task in tasks:
            if task.done():
                task.result()
    finally:
        loop._running = False
        tasks[1].cancel()
        active = [task for group in loop._active_tasks.values() for task in group]
        for task in active:
            task.cancel()
        await asyncio.gather(tasks[1], *active, *loop._background_tasks, return_exceptions=True)
        await channel.stop()
        tasks[2].cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def start(peer, content, input_id):
    await peer.send(type="message", content=content, input_id=input_id, task_id="shared-goal", webui=True)
    await peer.receive(event="work_input_state", input_id=input_id, state="consumed")
    return await peer.receive(event="goal_status", status="running", input_id=input_id)


async def stop(peer, turn_id, request_id):
    await peer.send(type="stop_work_turn", expected_turn_id=turn_id, request_id=request_id)
    return await peer.receive(event="work_turn_stop_result", request_id=request_id, turn_id=turn_id)


async def test_delayed_stop_of_finished_a_does_not_cancel_b_over_real_websocket(transport):
    async with transport.open_peer() as peer:
        a = await start(peer, "A", "main-a")
        transport.executor.release("A")
        await peer.receive(event="goal_status", status="idle", turn_id=a["turn_id"])
        b = await start(peer, "B", "main-b")
        assert a["turn_id"] != b["turn_id"]
        result = await stop(peer, a["turn_id"], "late-stop-a")
        assert result["ok"] is True
        assert result["outcome"] == "already_finished"
        current = transport.bus.work_turns.current(transport.chat_id)
        assert current.turn_id == b["turn_id"]
        assert not current.task.done()
        assert transport.executor.cancelled == []
        assert transport.executor.texts == ["A", "B"]
        assert [message.metadata["task_id"] for message in transport.executor.messages] == ["shared-goal", "shared-goal"]
        transport.executor.release("B")
        await peer.receive(event="goal_status", status="idle", turn_id=b["turn_id"])


async def test_unconsumed_guide_stays_paused_until_explicit_same_id_resume_over_real_websocket(transport):
    async with transport.open_peer() as peer:
        a = await start(peer, "A", "main-a")
        guide = {"type": "message", "content": "guide", "input_id": "guide-one",
                 "target_turn_id": a["turn_id"], "webui": True}
        await peer.send(**guide)
        await peer.receive(event="work_input_state", input_id="guide-one", state="accepted", turn_id=a["turn_id"])
        key = f"websocket:{transport.chat_id}"
        await until(lambda: transport.loop._pending_queues[key].qsize() == 1)
        result = await stop(peer, a["turn_id"], "stop-a")
        assert result["outcome"] == "stopped"
        await peer.receive(event="work_input_state", input_id="guide-one", state="paused", turn_id=a["turn_id"])
        await peer.receive(event="goal_status", status="idle", turn_id=a["turn_id"])
        await until(lambda: not transport.loop._active_tasks.get(key))
        assert transport.executor.texts == ["A"]
        assert transport.bus.inbound_size == 0
        assert key not in transport.loop._pending_queues
    await until(lambda: transport.chat_id not in transport.channel._subs)

    async with transport.open_peer() as peer:
        await peer.receive(event="work_input_state", input_id="guide-one", state="paused", turn_id=a["turn_id"])
        await peer.send(**guide)
        await peer.receive(event="work_input_state", input_id="guide-one", state="paused", turn_id=a["turn_id"])
        assert transport.executor.texts == ["A"]
        # An explicit idle resume is a new turn, retaining the original input ID.
        resume = {key: value for key, value in guide.items() if key != "target_turn_id"}
        await peer.send(**resume, resume_input=True)
        await peer.receive(event="work_input_state", input_id="guide-one", state="consumed")
        b = await peer.receive(event="goal_status", status="running", input_id="guide-one")
        assert b["turn_id"] != a["turn_id"]
        await peer.send(**resume, resume_input=True)
        await peer.receive(event="work_input_state", input_id="guide-one", state="consumed")
        assert transport.executor.texts == ["A", "guide"]
        transport.executor.release("guide")
        await peer.receive(event="goal_status", status="idle", turn_id=b["turn_id"])
        assert transport.executor.cancelled == ["A"]


async def test_reattach_replays_accepted_and_consumed_state_without_redispatch_over_real_websocket(transport):
    async with transport.open_peer() as peer:
        a = await start(peer, "A", "main-a")
        await peer.send(type="message", content="guide", input_id="guide-one", target_turn_id=a["turn_id"])
        await peer.receive(event="work_input_state", input_id="guide-one", state="accepted", turn_id=a["turn_id"])
        key = f"websocket:{transport.chat_id}"
        await until(lambda: transport.loop._pending_queues[key].qsize() == 1)
    await until(lambda: transport.chat_id not in transport.channel._subs)

    async with transport.open_peer() as peer:
        await peer.receive(event="work_input_state", input_id="guide-one", state="accepted", turn_id=a["turn_id"])
        snapshot = await peer.receive(event="goal_status", status="running", turn_id=a["turn_id"])
        assert snapshot["input_id"] == "main-a"
        assert transport.executor.texts == ["A"]
        assert transport.loop._pending_queues[key].qsize() == 1
    await until(lambda: transport.chat_id not in transport.channel._subs)

    # Completion consumes the existing leftover while no client can see its receipt.
    transport.executor.release("A")
    await until(lambda: transport.executor.texts == ["A", "guide"])
    resumed = transport.bus.work_turns.current(transport.chat_id)
    assert resumed.turn_id != a["turn_id"]
    async with transport.open_peer() as peer:
        await peer.receive(event="work_input_state", input_id="guide-one", state="consumed", turn_id=a["turn_id"])
        await peer.receive(event="goal_status", status="running", turn_id=resumed.turn_id)
        assert transport.executor.texts == ["A", "guide"]
        assert transport.bus.inbound_size == 0
        assert transport.loop._pending_queues[key].empty()
        transport.executor.release("guide")
        await peer.receive(event="goal_status", status="idle", turn_id=resumed.turn_id)
