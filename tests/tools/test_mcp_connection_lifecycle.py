from __future__ import annotations

import asyncio
import sys
from contextlib import AsyncExitStack, asynccontextmanager
from types import ModuleType, SimpleNamespace

import anyio
import pytest

import mona.agent.tools.mcp as mcp_mod
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import MCPServerConfig


@pytest.mark.asyncio
async def test_connect_mcp_servers_survives_config_growth_during_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    servers = {"configured": MCPServerConfig(command="isolated-mcp")}
    initial_stack = AsyncExitStack()
    started = asyncio.Event()
    release = asyncio.Event()

    async def _delayed_connect(name, *_args, **_kwargs):
        assert name == "configured"
        started.set()
        await release.wait()
        return initial_stack

    monkeypatch.setattr(mcp_mod, "connect_single_mcp_server", _delayed_connect)
    connect_task = asyncio.create_task(
        mcp_mod.connect_mcp_servers(servers, ToolRegistry())
    )
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        servers["background_builtin"] = MCPServerConfig(command="isolated-builtin")
        release.set()
        stacks = await connect_task
        assert stacks == {"configured": initial_stack}
    finally:
        release.set()
        if not connect_task.done():
            await connect_task
        await initial_stack.aclose()


def _install_isolated_stdio_mcp(
    monkeypatch: pytest.MonkeyPatch,
    owners: dict[str, object],
    *,
    initialize_started: asyncio.Event | None = None,
    initialize_release: asyncio.Event | None = None,
):
    mcp_package = ModuleType("mcp")
    mcp_package.__path__ = []

    class StdioServerParameters:
        def __init__(self, command, args, env=None):
            self.command = command
            self.args = args
            self.env = env

    class ClientSession:
        def __init__(self, _read, _write):
            pass

        async def __aenter__(self):
            owners["client_enter"] = asyncio.current_task()
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            owners["client_exit"] = asyncio.current_task()
            return False

        async def initialize(self):
            if initialize_started is not None:
                initialize_started.set()
            if initialize_release is not None:
                await initialize_release.wait()
            return None

        async def list_tools(self):
            return SimpleNamespace(tools=[])

        async def list_resources(self):
            return SimpleNamespace(resources=[])

        async def list_prompts(self):
            return SimpleNamespace(prompts=[])

    mcp_package.ClientSession = ClientSession
    mcp_package.StdioServerParameters = StdioServerParameters
    client_package = ModuleType("mcp.client")
    client_package.__path__ = []
    stdio_module = ModuleType("mcp.client.stdio")
    sse_module = ModuleType("mcp.client.sse")
    http_module = ModuleType("mcp.client.streamable_http")

    @asynccontextmanager
    async def stdio_client(_params):
        owners["transport_enter"] = asyncio.current_task()
        async with anyio.create_task_group():
            try:
                yield object(), object()
            finally:
                owners["transport_exit"] = asyncio.current_task()

    @asynccontextmanager
    async def unused_client(*_args, **_kwargs):
        yield object(), object()

    stdio_module.stdio_client = stdio_client
    sse_module.sse_client = unused_client
    http_module.streamable_http_client = unused_client
    client_package.stdio = stdio_module
    client_package.sse = sse_module
    client_package.streamable_http = http_module
    for name, module in (
        ("mcp", mcp_package),
        ("mcp.client", client_package),
        ("mcp.client.stdio", stdio_module),
        ("mcp.client.sse", sse_module),
        ("mcp.client.streamable_http", http_module),
    ):
        monkeypatch.setitem(sys.modules, name, module)


@pytest.mark.asyncio
async def test_cancel_before_ready_closes_anyio_contexts_on_owner_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owners: dict[str, object] = {}
    initialize_started = asyncio.Event()
    initialize_release = asyncio.Event()
    _install_isolated_stdio_mcp(
        monkeypatch,
        owners,
        initialize_started=initialize_started,
        initialize_release=initialize_release,
    )

    connect_task = asyncio.create_task(
        mcp_mod.connect_single_mcp_server(
            "isolated",
            MCPServerConfig(command="isolated-mcp"),
            ToolRegistry(),
        )
    )
    try:
        await asyncio.wait_for(initialize_started.wait(), timeout=1)
        connect_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await connect_task

        owner_task = owners["transport_enter"]
        assert owner_task.done()
        assert owners["client_enter"] is owner_task
        assert owners["client_exit"] is owner_task
        assert owners["transport_exit"] is owner_task
    finally:
        initialize_release.set()
        if not connect_task.done():
            connect_task.cancel()
            await asyncio.gather(connect_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_returned_connection_stack_closes_anyio_contexts_on_owner_task(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owners: dict[str, object] = {}
    _install_isolated_stdio_mcp(monkeypatch, owners)

    connection_task = asyncio.create_task(
        mcp_mod.connect_single_mcp_server(
            "isolated",
            MCPServerConfig(command="isolated-mcp"),
            ToolRegistry(),
        )
    )
    stack = await connection_task
    assert stack is not None

    close_task = asyncio.create_task(stack.aclose())
    close_result = await asyncio.gather(close_task, return_exceptions=True)
    assert close_result == [None]
    assert owners["transport_enter"] is owners["transport_exit"]
    assert owners["client_enter"] is owners["client_exit"]
    assert owners["transport_enter"] is owners["client_enter"]
    assert owners["transport_exit"] is not close_task
