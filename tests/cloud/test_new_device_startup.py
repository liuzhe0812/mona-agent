"""A new device can reach local cloud settings before selecting a model source."""
import asyncio
import uuid
from types import SimpleNamespace

from aiohttp.test_utils import TestClient, TestServer

from mona.api.server import create_app
from mona.cloud.api import RUNTIME_KEY
from mona.cloud.coordinator import CloudCoordinator
from mona.cloud.transfer import CloudTransferError
from mona.config.schema import Config
from mona.providers.factory import build_provider_snapshot
from mona.session.manager import SessionManager


def test_unconfigured_model_does_not_block_authenticated_local_cloud_settings(monkeypatch, tmp_path):
    config = Config()
    snapshot = build_provider_snapshot(config)
    async def no_model_requests(*args, **kwargs):
        raise AssertionError("Opening cloud settings must not invoke a model")
    monkeypatch.setattr(snapshot.provider, "chat", no_model_requests)
    token = uuid.uuid4().hex
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    async def skip_external_computer_startup(app):
        return None
    monkeypatch.setattr("mona.api.server._computer_use_startup", skip_external_computer_startup)
    manager = SessionManager(tmp_path / "workspace")
    loop = SimpleNamespace(sessions=manager, provider=snapshot.provider, _active_tasks={}, _session_locks={})
    def no_account(command, *args, **kwargs):
        assert command == "cloud_sync_context"
        raise CloudTransferError("account_required", "请登录 Mona。")

    async def exercise():
        app = create_app(loop)
        app[RUNTIME_KEY] = CloudCoordinator(loop, config_path=tmp_path / "config.json",
            state_path=tmp_path / "sync.db", media_root=tmp_path / "media",
            transcript_for=lambda key: tmp_path / "history.jsonl", invoke=no_account)
        async with TestClient(TestServer(app)) as client:
            assert (await client.get("/health")).status == 200
            assert (await client.get("/api/cloud-sync/status")).status == 401
            response = await client.get("/api/cloud-sync/status", headers={"X-Mona-Token": token})
            assert response.status == 200
            data = await response.json()
            assert data["available"] is False and data["problem"]["code"] == "account_required"
            assert data["enabled"] is False
    asyncio.run(asyncio.wait_for(exercise(), timeout=8))
