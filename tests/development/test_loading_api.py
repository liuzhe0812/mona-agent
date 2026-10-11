import asyncio
import secrets
import threading
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.development.api import RUNTIME_KEY, register_development_routes


class Store:
    def list_projects(self):
        return []


class Runtime:
    def __init__(self, describe, config):
        self.native = SimpleNamespace(describe=describe)
        self.store = Store()
        self.config_loader = lambda: config

    async def close(self):
        pass


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["provider-executors", "capabilities"])
async def test_slow_executor_description_does_not_block_project_list(
    endpoint, monkeypatch
):
    token = secrets.token_hex(32)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    release = threading.Event()
    entered = threading.Event()
    finished = threading.Event()
    calls = []
    native_rows = [{
        "id": "codex",
        "name": "Codex",
        "available": True,
        "programAvailable": True,
        "enabled": True,
        "reason": "detected",
        "nextAction": "",
        "detection": "detected",
        "executable": "codex.exe",
        "probe": {"state": "detected"},
        "models": [{"id": "", "label": "执行者默认模型"}],
    }]

    def slow_describe(project_id=None):
        calls.append(project_id)
        entered.set()
        release.wait()
        finished.set()
        return native_rows

    preset = SimpleNamespace(provider="openai", model="default-model")
    config = SimpleNamespace(
        development=SimpleNamespace(model_preset="default"),
        model_presets={},
        resolve_preset=lambda _name: preset,
        get_provider_name=lambda _model: "openai",
    )
    source_model = {"id": "source-model", "engine": "mona", "preset": False}
    monkeypatch.setattr("mona.development.api.coding_models", lambda _config: [source_model])

    runtime = Runtime(slow_describe, config)
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    auth = {"X-Mona-Token": token}
    timer = threading.Timer(2, release.set)
    timer.daemon = True

    async with TestClient(TestServer(app)) as client:
        timer.start()
        path = f"/api/development/{endpoint}"
        if endpoint == "capabilities":
            path += "?projectId=project-test"
        detection_request = asyncio.create_task(client.get(path, headers=auth))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            projects = await client.get("/api/development/projects", headers=auth)
            assert projects.status == 200 and await projects.json() == []
            assert not finished.is_set()

            release.set()
            response = await detection_request
            assert response.status == 200
            body = await response.json()
            if endpoint == "provider-executors":
                assert body == {"executors": native_rows}
                assert calls == [None]
            else:
                assert body["schemaVersion"] == 1
                assert body["executors"] == [
                    {
                        "id": "mona",
                        "name": "Mona Coding",
                        "available": True,
                        "reason": "",
                        "models": [
                            {
                                "id": "",
                                "label": "默认 · default-model",
                                "model": "default-model",
                                "provider": "openai",
                                "providerLabel": "openai",
                                "preset": True,
                            },
                            source_model,
                        ],
                    },
                    *native_rows,
                ]
                assert calls == ["project-test"]
        finally:
            release.set()
            timer.cancel()
            if not detection_request.done():
                await detection_request
