"""Tests for MCP connection lifecycle in AgentLoop."""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.loop import AgentLoop
from mona.bus.queue import MessageBus
from mona.computer_use.runtime import COMPUTER_PERMISSION_TOOL_NAMES
from mona.config.schema import MCPServerConfig


def _make_loop(tmp_path, *, mcp_servers: dict | None = None) -> AgentLoop:
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 4096
    return AgentLoop(
        bus=bus,
        provider=provider,
        workspace=tmp_path,
        model="test-model",
        mcp_servers=mcp_servers if mcp_servers is not None else {"test": object()},
    )


@pytest.mark.asyncio
async def test_connect_mcp_retries_when_no_servers_connect(tmp_path, monkeypatch: pytest.MonkeyPatch):
    loop = _make_loop(tmp_path)
    attempts = 0

    async def _fake_connect(_servers, _registry, _reconnect=None, **_kwargs):
        nonlocal attempts
        attempts += 1
        return {}

    monkeypatch.setattr("mona.agent.tools.mcp.connect_mcp_servers", _fake_connect)

    await loop._connect_mcp()
    await loop._connect_mcp()

    assert attempts == 2
    assert loop._mcp_connected is False
    assert loop._mcp_stacks == {}


@pytest.mark.asyncio
async def test_dynamic_mcp_stack_added_during_initial_connect_is_preserved(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loop = _make_loop(tmp_path, mcp_servers={"configured": object()})
    initial_stack = AsyncExitStack()
    dynamic_stack = AsyncExitStack()
    started = asyncio.Event()
    release = asyncio.Event()

    async def _delayed_connect(*_args, **_kwargs):
        started.set()
        await release.wait()
        return {"configured": initial_stack}

    async def _connect_dynamic_server(*_args, **_kwargs):
        return dynamic_stack

    monkeypatch.setattr("mona.agent.tools.mcp.connect_mcp_servers", _delayed_connect)
    monkeypatch.setattr(
        "mona.agent.tools.mcp.connect_single_mcp_server", _connect_dynamic_server
    )
    connect_task = asyncio.create_task(loop._connect_mcp())
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        result = await loop.add_mcp_server(
            "background_builtin", MCPServerConfig(command="isolated-mcp")
        )
        assert result["ok"] is True

        release.set()
        await connect_task

        assert loop._mcp_stacks == {
            "configured": initial_stack,
            "background_builtin": dynamic_stack,
        }
    finally:
        release.set()
        if not connect_task.done():
            await connect_task
        await initial_stack.aclose()
        await dynamic_stack.aclose()


@pytest.mark.asyncio
async def test_cancelled_initial_mcp_connect_propagates_and_keeps_dynamic_stack(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loop = _make_loop(tmp_path, mcp_servers={"configured": object()})
    initial_stack = AsyncExitStack()
    dynamic_stack = AsyncExitStack()
    dynamic_closed = asyncio.Event()

    async def _mark_dynamic_closed():
        dynamic_closed.set()

    dynamic_stack.push_async_callback(_mark_dynamic_closed)
    started = asyncio.Event()
    release = asyncio.Event()
    cancel_seen = asyncio.Event()

    async def _delayed_connect(*_args, **_kwargs):
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancel_seen.set()
            raise
        return {"configured": initial_stack}

    async def _connect_dynamic_server(*_args, **_kwargs):
        return dynamic_stack

    monkeypatch.setattr("mona.agent.tools.mcp.connect_mcp_servers", _delayed_connect)
    monkeypatch.setattr(
        "mona.agent.tools.mcp.connect_single_mcp_server", _connect_dynamic_server
    )
    connect_task = asyncio.create_task(loop._connect_mcp())
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        result = await loop.add_mcp_server(
            "background_builtin", MCPServerConfig(command="isolated-mcp")
        )
        assert result["ok"] is True

        connect_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await connect_task

        assert cancel_seen.is_set()
        assert loop._mcp_connecting is False
        assert loop._mcp_stacks["background_builtin"] is dynamic_stack
        assert not dynamic_closed.is_set()
    finally:
        release.set()
        if not connect_task.done():
            connect_task.cancel()
            await asyncio.gather(connect_task, return_exceptions=True)
        await initial_stack.aclose()
        await dynamic_stack.aclose()

    assert dynamic_closed.is_set()


@pytest.mark.asyncio
async def test_turn_sync_connects_authorized_computer_tools_before_model_call(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _make_loop(tmp_path, mcp_servers={})
    loop._mona_effective_config = SimpleNamespace(
        allowed_tools=list(COMPUTER_PERMISSION_TOOL_NAMES)
    )
    manager = SimpleNamespace(
        executable=object(),
        set_connection_result=MagicMock(),
        refresh_health=AsyncMock(return_value={"state": "available"}),
        mcp_config=MagicMock(return_value=object()),
    )
    monkeypatch.setattr(
        "mona.computer_use.runtime.get_cua_driver_manager",
        lambda: manager,
    )
    loop.add_mcp_server = AsyncMock(return_value={"ok": True})

    await loop._sync_computer_use_runtime()

    manager.refresh_health.assert_awaited_once_with()
    loop.add_mcp_server.assert_awaited_once_with(
        "__mona_computer_use",
        manager.mcp_config.return_value,
    )


@pytest.mark.asyncio
async def test_partner_turn_sync_connects_its_own_authorized_computer_tools(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _make_loop(tmp_path, mcp_servers={})
    loop._partner_agent_id = "com.mona.musician"
    loop._effective_config = SimpleNamespace(
        allowed_tools=list(COMPUTER_PERMISSION_TOOL_NAMES)
    )
    manager = SimpleNamespace(
        executable=object(),
        set_connection_result=MagicMock(),
        refresh_health=AsyncMock(return_value={"state": "available"}),
        mcp_config=MagicMock(return_value=object()),
    )
    monkeypatch.setattr(
        "mona.computer_use.runtime.get_cua_driver_manager",
        lambda: manager,
    )
    loop.add_mcp_server = AsyncMock(return_value={"ok": True})

    await loop._sync_computer_use_runtime()

    loop.add_mcp_server.assert_awaited_once_with(
        "__mona_computer_use",
        manager.mcp_config.return_value,
    )


@pytest.mark.asyncio
async def test_reconnect_callback_restarts_server_and_returns_fresh_wrappers(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reconnect callback drives a server restart and returns the new wrappers."""
    from mona.agent.tools.mcp import MCPToolWrapper

    loop = _make_loop(tmp_path)
    loop.restart_mcp_server = AsyncMock(return_value={"ok": True, "name": "test"})
    tool_def = SimpleNamespace(
        name="demo", description="demo", inputSchema={"type": "object", "properties": {}}
    )
    wrapper = MCPToolWrapper(SimpleNamespace(call_tool=None), "test", tool_def)
    registry = SimpleNamespace(
        tool_names=[wrapper.name],
        get=lambda name: wrapper if name == wrapper.name else None,
    )
    loop.tools = registry

    wrappers = await loop._reconnect_mcp_server_tools("test")

    loop.restart_mcp_server.assert_awaited_once_with("test")
    assert set(wrappers) == {"demo"}


@pytest.mark.asyncio
async def test_reconnect_callback_returns_none_when_restart_fails(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop = _make_loop(tmp_path)
    loop.restart_mcp_server = AsyncMock(return_value={"ok": False, "error": "boom"})
    loop.tools = SimpleNamespace(tool_names=[], get=lambda name: None)

    assert await loop._reconnect_mcp_server_tools("test") is None
