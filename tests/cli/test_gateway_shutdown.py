import asyncio
import threading
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mona.cli.commands import app
from mona.config.schema import Config
from mona.providers.factory import ProviderSnapshot

runner = CliRunner()


def test_gateway_health_endpoint_uses_create_app_on_dynamic_port(monkeypatch, tmp_path: Path) -> None:
    pytest.importorskip("aiohttp")
    from aiohttp.test_utils import TestClient, TestServer

    from mona import __version__
    from mona.api.server import create_app

    async def _skip_computer_use_startup(_app) -> None:
        return None

    monkeypatch.setattr("mona.api.server._computer_use_startup", _skip_computer_use_startup)
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))

    async def _exercise() -> None:
        async with TestClient(TestServer(create_app(object()))) as client:
            response = await client.get("/health")
            assert response.status == 200
            assert await response.json() == {
                "status": "ok",
                "service": "mona-gateway",
                "version": __version__,
                "capabilities": ["agent-http-v1"],
            }

    asyncio.run(asyncio.wait_for(_exercise(), timeout=8.0))


def test_gateway_shutdown_stops_long_running_runtime_and_flushes_sessions(
    monkeypatch, tmp_path: Path
) -> None:
    aiohttp = pytest.importorskip("aiohttp")
    from aiohttp import web

    config = Config()
    config.gateway.host = "127.0.0.1"
    config.gateway.port = 0
    config.agents.defaults.workspace = str(tmp_path / "workspace")

    port_ready = threading.Event()
    agent_started = threading.Event()
    channels_started = threading.Event()
    agent_cancelled = threading.Event()
    channels_cancelled = threading.Event()
    channels_stopped = threading.Event()
    sessions_flushed = threading.Event()
    runtime_finished = threading.Event()
    force_finish = threading.Event()
    captured_port: dict[str, int] = {}
    cli_results = []
    cli_errors = []

    class _FakeDream:
        model = None
        max_batch_size = 0
        max_iterations = 0

        async def run(self) -> None:
            return None

    class _FakeSessions:
        def flush_all(self) -> int:
            sessions_flushed.set()
            return 0

    class _FakeAgentLoop:
        @classmethod
        def from_config(cls, _config, bus=None, **extra):
            return cls(**extra)

        def __init__(self, **_kwargs) -> None:
            self.model = "test-model"
            self.provider = object()
            self.dream = _FakeDream()
            self.sessions = _FakeSessions()
            self.subagents = type("_Subagents", (), {"cron_service": None})()
            self.tools = {}

        def llm_runtime(self) -> None:
            return None

        async def run(self) -> None:
            agent_started.set()
            try:
                while not force_finish.is_set():
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                agent_cancelled.set()
                raise

        async def close_mcp(self) -> None:
            return None

        def stop(self) -> None:
            return None

    class _FakeChannelManager:
        def __init__(self, _config, _bus, **_kwargs) -> None:
            self.enabled_channels = ["test"]

        async def start_all(self) -> None:
            channels_started.set()
            try:
                while not force_finish.is_set():
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                channels_cancelled.set()
                raise

        async def stop_all(self) -> None:
            channels_stopped.set()

    class _FakeCronService:
        def __init__(self, _store_path: Path) -> None:
            self.on_job = None

        async def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

        def status(self) -> dict[str, int]:
            return {"jobs": 0}

        def register_system_job(self, _job) -> None:
            return None

    class _FakeHeartbeatService:
        def __init__(self, **_kwargs) -> None:
            return None

        async def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

    class _FakeAgentRegistry:
        def list_agents(self) -> list[object]:
            return []

    original_tcp_site = web.TCPSite

    class _CapturingTCPSite(original_tcp_site):
        async def start(self) -> None:
            await super().start()
            captured_port["port"] = self._server.sockets[0].getsockname()[1]
            port_ready.set()

    async def _skip_computer_use_startup(_app) -> None:
        return None

    monkeypatch.setenv("MONA_PROCESS_ROLE", "test")
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setattr("mona.cli.commands._load_runtime_config", lambda *_args, **_kwargs: config)
    monkeypatch.setattr("mona.cli.commands.run_startup_migrations", lambda *_args: None)
    monkeypatch.setattr("mona.providers.factory.build_provider_snapshot", lambda _config: ProviderSnapshot(
        provider=object(),
        model="test-model",
        context_window_tokens=8192,
        signature=("test",),
    ))
    monkeypatch.setattr("mona.bus.queue.MessageBus", lambda: object())
    monkeypatch.setattr("mona.session.manager.SessionManager", lambda _workspace: object())
    monkeypatch.setattr("mona.cli.commands.AgentLoop", _FakeAgentLoop)
    monkeypatch.setattr("mona.channels.manager.ChannelManager", _FakeChannelManager)
    monkeypatch.setattr("mona.cron.service.CronService", _FakeCronService)
    monkeypatch.setattr("mona.heartbeat.service.HeartbeatService", _FakeHeartbeatService)
    monkeypatch.setattr("mona.api.server._computer_use_startup", _skip_computer_use_startup)
    monkeypatch.setattr("mona.agent.pack_bootstrap.ensure_stock_pack", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("mona.agent.partners.AgentRegistry", _FakeAgentRegistry)
    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config",
        lambda _agent_id: type("_UserConfig", (), {"disabled_skills": []})(),
    )
    monkeypatch.setattr(web, "TCPSite", _CapturingTCPSite)

    def _run_gateway_cli() -> None:
        try:
            cli_results.append(runner.invoke(app, ["gateway"]))
        except BaseException as exc:
            cli_errors.append(exc)
        finally:
            runtime_finished.set()

    cli_thread = threading.Thread(target=_run_gateway_cli, daemon=True)
    cli_thread.start()

    async def _wait_for_event(event: threading.Event, label: str, timeout: float = 4.0) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while not event.is_set():
            if runtime_finished.is_set():
                details = cli_errors or [cli_results[0].exception, cli_results[0].stdout]
                raise AssertionError(f"Gateway exited before {label}: {details}")
            if loop.time() >= deadline:
                raise AssertionError(f"Timed out waiting for {label}")
            await asyncio.sleep(0.01)

    async def _request_shutdown() -> None:
        await _wait_for_event(agent_started, "agent runtime startup")
        await _wait_for_event(channels_started, "channel runtime startup")
        await _wait_for_event(port_ready, "Gateway HTTP listener")
        async with aiohttp.ClientSession() as client:
            health_response = await asyncio.wait_for(
                client.get(f"http://127.0.0.1:{captured_port['port']}/health"),
                timeout=3.0,
            )
            assert health_response.status == 200
            assert (await health_response.json())["service"] == "mona-gateway"

            response = await asyncio.wait_for(
                client.post(f"http://127.0.0.1:{captured_port['port']}/shutdown"),
                timeout=3.0,
            )
            assert response.status == 200
            assert await response.json() == {"status": "shutting down"}
        await _wait_for_event(runtime_finished, "Gateway CLI shutdown", timeout=4.0)

    try:
        asyncio.run(asyncio.wait_for(_request_shutdown(), timeout=12.0))
    finally:
        force_finish.set()
        cli_thread.join(timeout=2.0)

    assert not cli_thread.is_alive()
    assert not cli_errors
    assert len(cli_results) == 1
    assert cli_results[0].exit_code == 0, cli_results[0].stdout
    assert agent_cancelled.is_set()
    assert channels_cancelled.is_set()
    assert channels_stopped.is_set()
    assert sessions_flushed.is_set()
