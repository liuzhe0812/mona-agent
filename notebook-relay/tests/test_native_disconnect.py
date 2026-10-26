import asyncio
import json
import secrets
import socket
import threading
import time
from types import SimpleNamespace

import pytest
import uvicorn

from notebook_relay.app import create_app
from notebook_relay.config import Settings
from notebook_relay.opencode_codec import FREE_MODEL


class BlockingNative:
    def __init__(self, phase):
        self.phase = phase
        self.entered = threading.Event()
        self.cancelled = threading.Event()
        self.finished = threading.Event()
        self.closed = threading.Event()
        self.release = asyncio.Event()
        self.loop = None
        self.jobs = {}
        self.close_calls = 0

    async def start(self):
        self.loop = asyncio.get_running_loop()

    async def stop(self):
        self.release.set()

    async def block(self):
        self.entered.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        finally:
            self.finished.set()

    async def open(self, payload):
        job = SimpleNamespace(id="controlled-job")
        self.jobs[job.id] = job
        try:
            if self.phase == "open":
                await self.block()
            return job
        except BaseException:
            await self.close_job(job)
            raise

    async def completion(self, job):
        await self.block()
        return {"choices": []}

    async def events(self, job, include_usage):
        yield '{"choices":[]}'
        await self.block()

    async def close_job(self, job):
        self.jobs.pop(job.id)
        self.close_calls += 1
        self.closed.set()


def wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition timed out"
        time.sleep(0.01)


@pytest.mark.parametrize(("phase", "streaming"), [
    ("open", False), ("open", True), ("completion", False), ("events", True),
])
def test_full_post_disconnect_cancels_native_request_and_releases_job(monkeypatch, phase, streaming):
    native = BlockingNative(phase)
    monkeypatch.setattr("notebook_relay.app.OpenCodeBridge", lambda settings: native)
    key = secrets.token_urlsafe(32)
    app = create_app(Settings(api_key=key, upstream_provider="opencode_native", request_timeout_seconds=30))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(
            app, log_level="warning", access_log=False, timeout_graceful_shutdown=1,
        ))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            wait_until(lambda: server.started)
            body = json.dumps({"model": FREE_MODEL, "messages": [{"role": "user", "content": "hello"}],
                               "stream": streaming}).encode()
            headers = (f"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
                       f"Authorization: Bearer {key}\r\nContent-Type: application/json\r\n"
                       f"Content-Length: {len(body)}\r\n\r\n").encode()
            with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
                client.sendall(headers + body)
                assert native.entered.wait(3), "native operation never received the complete POST"
                assert app.state.relay.active_requests == 1
                assert native.jobs
            assert native.cancelled.wait(3), "native operation survived client disconnect"
            assert native.finished.wait(3), "native operation was not awaited after cancellation"
            assert native.closed.wait(3), "native job was not closed"
            wait_until(lambda: app.state.relay.active_requests == 0)
            assert native.jobs == {}
            assert native.close_calls == 1
        finally:
            if native.loop is not None:
                native.loop.call_soon_threadsafe(native.release.set)
            server.should_exit = True
            thread.join(timeout=5)
            assert not thread.is_alive(), "relay did not shut down"
