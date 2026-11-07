"""Codex image settings require an administrator and an explicit per-image price."""
import copy
import json
from types import SimpleNamespace

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work import image_admin, image_policy
from mona.hosted_work.admin import CodexAdmin
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.model_admin import ModelAdmin
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

URL, OWNER, SECRET = "/api/work/admin/image", owner_key("72"), "fixture-secret-never-return"


class FakeAuth:
    async def identity(self, token):
        if token not in {"admin", "ordinary"}:
            raise WorkError("login_required", "请先登录。", 401)
        return OWNER

    async def admin_identity(self, token):
        await self.identity(token)
        if token != "admin":
            raise WorkError("admin_required", "仅管理员可访问。", 403)
        return OWNER


class NoExecution:
    def __init__(self, config):
        self.config, self.processes = config, {}

    async def execute(self, *_args):
        pytest.fail("image settings must not dispatch a task")


@pytest_asyncio.fixture
async def online(tmp_path, monkeypatch):
    data = {"hosted_work": {"public_origin": "https://work.example.invalid", "auth_origin": "https://auth.example.invalid",
                            "state_dir": str(tmp_path / "state"), "models": {
                                "qwen": {"label": "Qwen", "model": "qwen", "billing_mode": "free"}}},
            "unrelated": {"keep": True}}
    path = tmp_path / "operator.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setenv("MONA_WORK_MODEL_IMAGE_KEY", SECRET)
    monkeypatch.setattr(image_policy, "model_available", lambda model, config: True)
    monkeypatch.setattr(image_admin, "image_ready", lambda config: config.image_generation.enabled
                        and bool(image_policy.resolve_image_model(config)))
    config = HostedWorkConfig.model_validate(data["hosted_work"])
    store = WorkStore(tmp_path / "work.sqlite3", config)
    service = WorkService(config, store, FakeAuth(), NoExecution(config))
    admin = CodexAdmin(path)
    models = ModelAdmin(admin, service)
    app = create_app(service)
    admin.register(app)
    models.register(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield SimpleNamespace(client=client, path=path, service=service, store=store, data=data)
    finally:
        await client.close()
        store.close()


def headers(token="admin"):
    return {"Authorization": "Bearer " + token, "Origin": "https://work.example.invalid"}


async def put(online, revision, *, enabled=True, price=None, **extra):
    configuration = {"enabled": enabled, "price": price, **extra}
    return await online.client.put(URL, headers=headers(), json={"expected_revision": revision, "configuration": configuration})


@pytest.mark.asyncio
async def test_admin_only_defaults_and_exact_price_without_model_or_credentials(online):
    for token, status in [(None, 401), ("ordinary", 403)]:
        for method in ("GET", "PUT"):
            response = await online.client.request(method, URL, headers=headers(token) if token else {},
                                                   json={} if method == "PUT" else None)
            assert response.status == status
    response = await online.client.get(URL, headers=headers())
    initial = await response.json()
    assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
    assert initial["configuration"] == {"enabled": False, "price": None}
    assert not initial["availability"]["ready"] and "开放" in initial["availability"]["message"]

    response = await put(online, initial["revision"], price={"amount_per_image": "1.234567"})
    result = await response.json()
    assert response.status == 200 and result["configuration"] == {"enabled": True, "price": {"amount_per_image": "1.234567"}}
    assert not result["availability"]["ready"] and SECRET not in json.dumps(result)
    saved = json.loads(online.path.read_text(encoding="utf-8"))
    expected = copy.deepcopy(online.data)
    expected["hosted_work"]["image_generation"] = {"enabled": True, "provider": "codex", "model": "",
        "billing_mode": "wallet", "price": {"amount_per_image": "1.234567"}}
    assert saved == expected


@pytest.mark.asyncio
async def test_free_is_only_selected_by_explicit_zero_price(online):
    initial = await (await online.client.get(URL, headers=headers())).json()
    assert online.service.config.image_generation.billing_mode == "wallet"
    absent = await put(online, initial["revision"], price=None)
    assert absent.status == 400 and (await absent.json())["field"] == "price"
    free = await put(online, initial["revision"], price={"amount_per_image": "0.000000"})
    assert free.status == 200 and online.service.config.image_generation.billing_mode == "free"
    current = await free.json()
    disabled = await put(online, current["revision"], enabled=False, price=None)
    assert disabled.status == 200 and online.service.config.image_generation.billing_mode == "wallet"
    assert online.service.config.image_generation.price is None


@pytest.mark.asyncio
async def test_readiness_tracks_open_codex_models_without_exposing_selection(online):
    initial = await (await online.client.get(URL, headers=headers())).json()
    response = await put(online, initial["revision"], price={"amount_per_image": "1"})
    assert not (await response.json())["availability"]["ready"]
    model = HostedWorkModel(label="Codex", source="codex", model="gpt-example", enabled=True)
    online.service.config.models["codex"] = model
    ready = await (await online.client.get(URL, headers=headers())).json()
    assert ready["availability"] == {"ready": True, "message": "配置已就绪，实际调用以上游结果为准。"}
    assert online.service.config.image_generation.model == "" and "model" not in ready["configuration"]
    model.enabled = False
    unavailable = await (await online.client.get(URL, headers=headers())).json()
    assert not unavailable["availability"]["ready"] and "开放" in unavailable["availability"]["message"]


@pytest.mark.asyncio
async def test_revision_conflict_and_busy_work_preserve_configuration(online):
    initial = await (await online.client.get(URL, headers=headers())).json()
    assert (await put(online, initial["revision"], price={"amount_per_image": "1"})).status == 200
    before = online.path.read_bytes()
    stale = await put(online, initial["revision"], price={"amount_per_image": "2"})
    assert stale.status == 409 and (await stale.json())["error"] == "configuration_changed"
    assert online.path.read_bytes() == before
    current = await (await online.client.get(URL, headers=headers())).json()
    online.store.create_session(OWNER, NewSession(request_id="a" * 32))
    online.store.create_run(OWNER, "a" * 32, NewTurn(request_id="b" * 32, model_id="qwen", text="active"))
    busy = await put(online, current["revision"], enabled=False)
    assert busy.status == 409 and (await busy.json())["error"] == "work_busy"
    assert online.path.read_bytes() == before


@pytest.mark.asyncio
async def test_invalid_prices_and_hidden_connection_fields_are_rejected(online):
    initial = await (await online.client.get(URL, headers=headers())).json()
    before = online.path.read_bytes()
    for bad in ({"amount_per_image": "-1"}, {"amount_per_image": "0.0000001"},
                {"amount_per_image": True}, {"amount_per_image": "1000000001"}):
        response = await put(online, initial["revision"], price=bad)
        assert response.status == 400 and (await response.json())["field"] == "price"
    for extra in ({"model": "other"}, {"api_key": SECRET}, {"api_base": "https://example.invalid"},
                  {"reserve_units": 0}, {"billing_mode": "free"}):
        response = await put(online, initial["revision"], price={"amount_per_image": "0"}, **extra)
        assert response.status == 400 and SECRET not in await response.text()
    assert online.path.read_bytes() == before
