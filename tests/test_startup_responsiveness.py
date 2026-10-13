"""Regression coverage for blocking startup work on the gateway event loop."""

from __future__ import annotations

import asyncio
import socket
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from mona.bus.queue import MessageBus
from mona.channels import websocket as websocket_module
from mona.channels.websocket import WebSocketChannel


@pytest.fixture(autouse=True)
def isolate_config_path(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")


def test_importing_feishu_metadata_does_not_import_lark_sdk() -> None:
    code = """
import sys
from mona.channels.feishu import FeishuChannel, FeishuConfig

assert FeishuChannel.display_name == "Feishu"
assert FeishuConfig.model_fields["app_id"].default == ""
assert "lark_oapi" not in sys.modules
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _http_get(url: str, headers: dict[str, str] | None = None) -> httpx.Response:
    return await asyncio.to_thread(
        httpx.get,
        url,
        headers=headers or {},
        timeout=2.0,
        trust_env=False,
    )


def _channel(port: int, workspace: Any, session_manager: Any = None) -> WebSocketChannel:
    manager = session_manager or SimpleNamespace(workspace=workspace)
    return WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": port,
            "path": "/ws",
            "websocketRequiresToken": True,
        },
        MessageBus(),
        session_manager=manager,
    )


async def _start_channel(channel: WebSocketChannel, port: int) -> asyncio.Task[None]:
    async def skip_startup_cleanup() -> None:
        return None

    channel._cleanup_duplicate_media = skip_startup_cleanup  # type: ignore[method-assign]
    server_task = asyncio.create_task(channel.start())
    try:
        deadline = asyncio.get_running_loop().time() + 3.0
        while asyncio.get_running_loop().time() < deadline:
            try:
                response = await _http_get(f"http://127.0.0.1:{port}/health")
                if response.status_code == 200:
                    return server_task
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.01)
        pytest.fail("WebSocketChannel did not serve its health endpoint")
    except BaseException:
        await channel.stop()
        await asyncio.gather(server_task, return_exceptions=True)
        raise


async def _stop_channel(channel: WebSocketChannel, server_task: asyncio.Task[None]) -> None:
    await channel.stop()
    await server_task


@pytest.mark.asyncio
async def test_slow_mcp_sdk_load_leaves_heartbeat_and_health_http_responsive(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mona.agent.tools import mcp as mcp_tools
    from mona.agent.tools.registry import ToolRegistry

    monkeypatch.setattr(websocket_module, "_load_or_create_media_secret", lambda: b"test-secret")
    port = _free_port()
    channel = _channel(port, tmp_path)
    server_task = await _start_channel(channel, port)

    loader_started = threading.Event()
    release_loader = threading.Event()
    release_timer = threading.Timer(0.75, release_loader.set)
    release_timer.daemon = True
    original_loader = mcp_tools._load_mcp_client_sdk

    def delayed_loader() -> Any:
        loader_started.set()
        if not release_loader.wait(timeout=5.0):
            raise TimeoutError("test did not release the MCP SDK loader")
        return original_loader()

    monkeypatch.setattr(mcp_tools, "_load_mcp_client_sdk", delayed_loader)
    load_task: asyncio.Task[Any] | None = None
    try:
        release_timer.start()
        load_task = asyncio.create_task(
            mcp_tools.connect_single_mcp_server(
                "startup-probe",
                SimpleNamespace(type=None, command=None, url=None),
                ToolRegistry(),
            )
        )
        assert await asyncio.to_thread(loader_started.wait, 2.0)

        heartbeat = asyncio.Event()

        async def event_loop_heartbeat() -> None:
            await asyncio.sleep(0.01)
            heartbeat.set()

        heartbeat_task = asyncio.create_task(event_loop_heartbeat())
        response = await _http_get(f"http://127.0.0.1:{port}/health")
        await heartbeat_task

        assert response.status_code == 200
        assert heartbeat.is_set()
        assert not release_loader.is_set()
        release_loader.set()
        assert await load_task is None
    finally:
        release_loader.set()
        release_timer.cancel()
        if load_task is not None:
            await asyncio.gather(load_task, return_exceptions=True)
        await _stop_channel(channel, server_task)


@pytest.mark.asyncio
async def test_unauthorized_sessions_request_does_not_list_or_persist(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(websocket_module, "_load_or_create_media_secret", lambda: b"test-secret")
    list_started = threading.Event()
    persistence_started = threading.Event()

    def list_sessions() -> list[dict[str, Any]]:
        list_started.set()
        return []

    def persist_list_summaries() -> None:
        persistence_started.set()

    manager = SimpleNamespace(
        workspace=tmp_path,
        list_sessions=list_sessions,
        persist_list_summaries=persist_list_summaries,
    )
    port = _free_port()
    channel = _channel(port, tmp_path, manager)
    server_task = await _start_channel(channel, port)

    try:
        response = await _http_get(f"http://127.0.0.1:{port}/api/sessions")
        await asyncio.sleep(0)

        assert response.status_code == 401
        assert not list_started.is_set()
        assert not persistence_started.is_set()
        assert channel._list_summary_flush_task is None
    finally:
        await _stop_channel(channel, server_task)


@pytest.mark.asyncio
async def test_sessions_response_returns_while_summary_persistence_is_blocked(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(websocket_module, "_load_or_create_media_secret", lambda: b"test-secret")
    persistence_started = threading.Event()
    release_persistence = threading.Event()
    release_timer = threading.Timer(4.0, release_persistence.set)
    release_timer.daemon = True

    expected_rows = [
        {
            "key": "websocket:summary-flush",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:01:00Z",
            "title": "Summary flush",
            "preview": "response first",
        }
    ]

    def persist_list_summaries() -> None:
        persistence_started.set()
        if not release_persistence.wait(timeout=5.0):
            raise TimeoutError("test did not release list summary persistence")

    manager = SimpleNamespace(
        workspace=tmp_path,
        list_sessions=lambda: expected_rows,
        persist_list_summaries=persist_list_summaries,
    )
    port = _free_port()
    channel = _channel(port, tmp_path, manager)
    server_task = await _start_channel(channel, port)

    try:
        bootstrap = await _http_get(f"http://127.0.0.1:{port}/webui/bootstrap")
        assert bootstrap.status_code == 200
        token = bootstrap.json()["token"]
        release_timer.start()

        response = await _http_get(
            f"http://127.0.0.1:{port}/api/sessions",
            {"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 200
        assert response.json()["sessions"][0]["key"] == "websocket:summary-flush"
        assert response.json()["sessions"][0]["preview"] == "response first"
        assert await asyncio.to_thread(persistence_started.wait, 2.0)
        assert not release_persistence.is_set()
        flush_task = channel._list_summary_flush_task
        assert flush_task is not None
        assert not flush_task.done()

        release_persistence.set()
        await asyncio.wait_for(flush_task, timeout=2.0)
    finally:
        release_persistence.set()
        release_timer.cancel()
        await _stop_channel(channel, server_task)


@pytest.mark.asyncio
async def test_session_list_responds_while_settings_payload_is_blocked(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(websocket_module, "_load_or_create_media_secret", lambda: b"test-secret")
    settings_started = threading.Event()
    release_settings = threading.Event()
    release_timer = threading.Timer(2.0, release_settings.set)
    release_timer.daemon = True

    def blocked_settings_payload(**_kwargs: Any) -> dict[str, Any]:
        settings_started.set()
        if not release_settings.wait(timeout=5.0):
            raise TimeoutError("test did not release settings payload")
        return {"startup_probe": "ready"}

    monkeypatch.setattr(websocket_module, "settings_payload", blocked_settings_payload)
    expected_rows = [
        {
            "key": "websocket:settings-overlap",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:01:00Z",
            "title": "Settings overlap",
            "preview": "session list first",
        }
    ]
    manager = SimpleNamespace(
        workspace=tmp_path,
        list_sessions=lambda: expected_rows,
        persist_list_summaries=lambda: None,
    )
    port = _free_port()
    channel = _channel(port, tmp_path, manager)
    server_task = await _start_channel(channel, port)
    settings_task: asyncio.Task[httpx.Response] | None = None

    try:
        bootstrap = await _http_get(f"http://127.0.0.1:{port}/webui/bootstrap")
        assert bootstrap.status_code == 200
        token = bootstrap.json()["token"]
        release_timer.start()
        settings_task = asyncio.create_task(
            _http_get(
                f"http://127.0.0.1:{port}/api/settings",
                {"Authorization": f"Bearer {token}"},
            )
        )
        assert await asyncio.to_thread(settings_started.wait, 2.0)

        sessions = await _http_get(
            f"http://127.0.0.1:{port}/api/sessions",
            {"Authorization": f"Bearer {token}"},
        )
        assert sessions.status_code == 200
        assert sessions.json()["sessions"][0]["key"] == "websocket:settings-overlap"
        assert sessions.json()["sessions"][0]["preview"] == "session list first"
        assert not release_settings.is_set()

        release_settings.set()
        settings = await settings_task
        assert settings.status_code == 200
        assert settings.json()["startup_probe"] == "ready"
    finally:
        release_settings.set()
        release_timer.cancel()
        if settings_task is not None:
            await asyncio.gather(settings_task, return_exceptions=True)
        await _stop_channel(channel, server_task)


@pytest.mark.asyncio
async def test_slow_session_list_does_not_block_bootstrap_and_returns_rows(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(websocket_module, "_load_or_create_media_secret", lambda: b"test-secret")
    list_started = threading.Event()
    release_list = threading.Event()
    release_timer = threading.Timer(2.0, release_list.set)
    release_timer.daemon = True

    expected_rows = [
        {
            "key": "websocket:slow-list",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:01:00Z",
            "title": "Slow list",
            "preview": "ready",
        }
    ]

    def slow_list_sessions() -> list[dict[str, Any]]:
        list_started.set()
        if not release_list.wait(timeout=5.0):
            raise TimeoutError("test did not release the session list")
        return expected_rows

    manager = SimpleNamespace(workspace=tmp_path, list_sessions=slow_list_sessions)
    port = _free_port()
    channel = _channel(port, tmp_path, manager)
    server_task = await _start_channel(channel, port)
    list_task: asyncio.Task[httpx.Response] | None = None

    try:
        bootstrap = await _http_get(f"http://127.0.0.1:{port}/webui/bootstrap")
        assert bootstrap.status_code == 200
        token = bootstrap.json()["token"]
        release_timer.start()
        list_task = asyncio.create_task(
            _http_get(
                f"http://127.0.0.1:{port}/api/sessions",
                {"Authorization": f"Bearer {token}"},
            )
        )
        assert await asyncio.to_thread(list_started.wait, 2.0)

        health = await _http_get(f"http://127.0.0.1:{port}/health")
        assert health.status_code == 200
        assert not release_list.is_set()

        release_list.set()
        sessions = await list_task
        assert sessions.status_code == 200
        assert sessions.json()["sessions"][0]["key"] == "websocket:slow-list"
        assert sessions.json()["sessions"][0]["preview"] == "ready"
    finally:
        release_list.set()
        release_timer.cancel()
        if list_task is not None:
            await asyncio.gather(list_task, return_exceptions=True)
        await _stop_channel(channel, server_task)
