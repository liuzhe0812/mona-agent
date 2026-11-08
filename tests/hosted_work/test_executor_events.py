"""Exercise child JSONL protocol without launching a process or Docker."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work import executor as executor_module
from mona.hosted_work.contracts import WorkError

OWNER = "a" * 64
RUN = "b" * 32


class FakeStdin:
    def __init__(self, process, exit_on_close: bool):
        self.process = process
        self.exit_on_close = exit_on_close
        self.data = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        await asyncio.sleep(0)

    def close(self) -> None:
        self.closed = True
        if self.exit_on_close:
            self.process.returncode = 0
            self.process.finished.set()


class FakeProcess:
    def __init__(self, events: list[dict], *, exit_on_close: bool):
        self.returncode = None
        self.pid = 12345
        self.finished = asyncio.Event()
        self.signals = []
        self.stdin = FakeStdin(self, exit_on_close)
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(b"".join(json.dumps(event).encode() + b"\n" for event in events))
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()

    async def wait(self) -> int:
        await self.finished.wait()
        return self.returncode

    def send_signal(self, value: int) -> None:
        self.signals.append(value)
        self.returncode = -int(value)
        self.finished.set()


@pytest.fixture
def child_fixture(monkeypatch, tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path), models={"qwen": {"label": "Fixture", "model": "fixture"}})
    cleanup = []
    handles = {}

    def pin_fake_process(process, _nonce):
        fd = os.open(os.devnull, os.O_RDONLY)
        handles[fd] = process
        return fd

    def signal_fake_process(fd, value, *_args):
        if value == 0:
            raise ProcessLookupError
        handles[fd].send_signal(value)

    class FakeSandbox:
        def __init__(self, actual_config, owner, run_id, snapshot):
            self.config = actual_config
            self.owner = owner
            self.run_id = run_id
            self.snapshot = snapshot
            self.created = False
            cleanup.append(self)

        async def close(self):
            assert self.created is True
            self.closed = True

    monkeypatch.setattr(executor_module, "sys", SimpleNamespace(platform="linux", executable="fixture-python"))
    monkeypatch.setattr(executor_module, "DockerSandbox", FakeSandbox)
    monkeypatch.setattr(executor_module, "_owned_group_handle", pin_fake_process)
    monkeypatch.setattr(executor_module.signal, "pidfd_send_signal", signal_fake_process, raising=False)
    return config, cleanup


@pytest.mark.asyncio
async def test_widget_child_frame_reaches_event_handler_before_completed_result(monkeypatch, child_fixture):
    config, cleanup = child_fixture
    widget = {"id": "call_1", "title": "图形", "code": '<svg viewBox="0 0 680 80"></svg>',
              "loadingMessages": ["正在绘制"], "status": "complete"}
    completed = {"status": "completed", "workspace_saved": True, "content": "完成"}
    process = FakeProcess([{"kind": "widget", "data": widget}, {"kind": "result", "data": completed}],
                          exit_on_close=True)
    spawn = AsyncMock(return_value=process)
    monkeypatch.setattr(executor_module.asyncio, "create_subprocess_exec", spawn)
    received = []

    async def on_event(kind, value):
        received.append((kind, value))

    payload = {"action": "turn", "owner": OWNER, "run_id": RUN, "model_id": "qwen"}
    executor = executor_module.ProcessExecutor(config)
    result = await executor.execute(payload, on_event)

    assert result == completed and received == [("widget", widget)]
    assert json.loads(process.stdin.data)["payload"] == payload and process.stdin.closed
    assert spawn.await_count == 1 and spawn.await_args.args[:4] == (
        "fixture-python", "-u", "-m", "mona.hosted_work.turn",
    )
    assert cleanup == [] and process.signals == []
    assert not executor.processes and not executor.cancelled


@pytest.mark.asyncio
async def test_child_frame_can_transport_bounded_multi_image_history(monkeypatch, child_fixture):
    config, cleanup = child_fixture
    config.max_history_bytes = 65536
    config.max_file_bytes = 100000
    config.history_media_expand_bytes = 1024 * 1024
    blocks = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," +
               base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes([i]) * 79992).decode("ascii")}}
              for i in (1, 2, 3)]
    history = {"messages": [{"role": "tool", "content": blocks}]}
    events = [{"kind": "history", "data": history},
              {"kind": "result", "data": {"status": "completed", "workspace_saved": True}}]
    encoded_frames = b"".join(json.dumps(item).encode() + b"\n" for item in events)
    # The old 2*file / 2*history framing limit rejected this legal result.
    assert len(encoded_frames) > max(config.max_history_bytes * 2, config.max_file_bytes * 2 + 65536)

    async def spawn(*_args, limit, **_kwargs):
        process = FakeProcess([], exit_on_close=True)
        process.stdout = asyncio.StreamReader(limit=limit)
        process.stdout.feed_data(encoded_frames)
        process.stdout.feed_eof()
        return process

    monkeypatch.setattr(executor_module.asyncio, "create_subprocess_exec", spawn)
    received = []

    async def on_event(kind, data):
        received.append((kind, data))

    result = await executor_module.ProcessExecutor(config).execute(
        {"action": "turn", "owner": OWNER, "run_id": RUN, "model_id": "qwen"}, on_event)
    assert result["status"] == "completed" and received == [("history", history)]
    assert not cleanup


@pytest.mark.asyncio
async def test_stop_after_leader_exit_signals_only_pinned_group_and_cannot_report_success(monkeypatch, child_fixture):
    config, cleanup = child_fixture
    monkeypatch.setattr(executor_module.signal, "SIGKILL", 9, raising=False)
    process = FakeProcess([{"kind": "result", "data": {"status": "completed", "workspace_saved": True}}],
                          exit_on_close=True)
    monkeypatch.setattr(executor_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    executor = executor_module.ProcessExecutor(config)
    first = True

    async def stop_during_cleanup(_process, _handle):
        nonlocal first
        if first:
            first = False
            assert process.returncode == 0
            executor.cancel(OWNER, RUN)
        return False

    monkeypatch.setattr(executor_module, "_stop_remaining_group", stop_during_cleanup)
    with pytest.raises(WorkError) as error:
        await executor.execute({"action": "turn", "owner": OWNER, "run_id": RUN, "model_id": "qwen"}, AsyncMock())
    assert error.value.code == "execution_cleanup_unknown"
    assert process.signals == [signal.SIGKILL]
    assert len(cleanup) == 1 and cleanup[0].closed
    assert not executor.processes and not executor.group_handles and not executor.forced_groups


@pytest.mark.asyncio
async def test_stop_watchdog_kills_pinned_group_after_leader_exits(monkeypatch, child_fixture):
    config, _ = child_fixture
    monkeypatch.setattr(executor_module.signal, "SIGKILL", 9, raising=False)
    process = FakeProcess([], exit_on_close=False)
    executor = executor_module.ProcessExecutor(config)
    key = (OWNER, RUN)
    fd = os.open(os.devnull, os.O_RDONLY)
    executor.processes[key] = process
    executor.group_handles[key] = fd
    signals = []
    group_alive = True

    def signal_group(actual_fd, value, *args):
        nonlocal group_alive
        assert actual_fd == fd
        signals.append((value, args))
        if value == signal.SIGTERM:
            process.returncode = -int(value)
            process.finished.set()
        elif value == signal.SIGKILL:
            group_alive = False

    monkeypatch.setattr(executor_module.signal, "pidfd_send_signal", signal_group, raising=False)
    monkeypatch.setattr(executor_module, "_group_present", lambda _process, _fd: group_alive)
    try:
        executor.cancel(OWNER, RUN)
        await asyncio.wait_for(executor.stop_watchdogs[key], 2)
        assert signals == [(signal.SIGTERM, ()), (signal.SIGKILL, (None, executor_module._PIDFD_PROCESS_GROUP))]
        assert key in executor.forced_groups
    finally:
        os.close(fd)


@pytest.mark.asyncio
@pytest.mark.parametrize("events", [
    [{"kind": "unexpected", "data": {}}, {"kind": "result", "data": {"status": "completed"}}],
    [{"kind": "result", "data": {"status": "completed"}}, {"kind": "widget", "data": {"id": "late"}}],
    [{"kind": "widget", "data": ["not-an-object"]}],
])
async def test_invalid_child_frames_cleanup_only_exact_run(monkeypatch, child_fixture, events):
    config, cleanup = child_fixture
    process = FakeProcess(events, exit_on_close=False)
    monkeypatch.setattr(executor_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    on_event = AsyncMock()
    executor = executor_module.ProcessExecutor(config)
    payload = {"action": "turn", "owner": OWNER, "run_id": RUN, "model_id": "qwen"}

    with pytest.raises(WorkError) as error:
        await executor.execute(payload, on_event)

    assert error.value.code == "protocol_error"
    on_event.assert_not_awaited()
    assert process.signals == [signal.SIGTERM]
    assert len(cleanup) == 1 and cleanup[0].closed
    assert cleanup[0].config is config and cleanup[0].owner == OWNER and cleanup[0].run_id == RUN
    assert cleanup[0].snapshot == Path(config.state_dir) / "users" / OWNER / "workspace.zip"
    assert not executor.processes and not executor.cancelled
