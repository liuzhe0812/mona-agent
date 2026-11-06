"""Administrator edits preserve provider-independent billing and idle guards."""
import asyncio
import copy
import json
import os
import socket
import stat
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedCodexSettings, HostedWorkConfig, HostedWorkPrice
from mona.hosted_work.admin import CodexAdmin, SaveCodex
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.model_admin import ModelAdmin, ModelAdminError, SaveModel
from mona.hosted_work.model_transport import validate_model_endpoint
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

URL = "/api/work/admin/models"
OWNER, SID, RID = owner_key("71"), "a" * 32, "b" * 32
SECRET = "fixture-private-model-key"
PRICE = {"input_amount_per_million": "1.000001", "cached_input_amount_per_million": "0",
         "output_amount_per_million": "1000000000.000000"}


def headers(token="admin"):
    return {"Authorization": "Bearer " + token, "Origin": "https://work.example.invalid"}


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
        pytest.fail("model administration must not dispatch a task")


@pytest_asyncio.fixture
async def online(tmp_path, monkeypatch):
    path = tmp_path / "operator.json"
    data = {"hosted_work": {"public_origin": "https://work.example.invalid", "auth_origin": "https://auth.example.invalid",
            "state_dir": str(tmp_path / "state"), "models": {
                "qwen": {"label": "Qwen", "model": "qwen-old", "api_base": "https://model.example.invalid/v1",
                         "api_key_env": "MONA_WORK_MODEL_QWEN_KEY", "billing_mode": "free"},
                "codex": {"label": "Codex draft", "source": "codex", "model": "codex-fixture",
                          "native_config_path": "/private/native.json"},
                "other": {"label": "Other", "source": "workbuddy", "model": "other-fixture",
                          "native_config_path": "/private/other.json"}}},
            "unrelated": {"nested": [False, None, "保留"]}}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("MONA_WORK_MODEL_QWEN_KEY", SECRET)
    config = HostedWorkConfig.model_validate(data["hosted_work"])
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    service = WorkService(config, store, FakeAuth(), NoExecution(config))
    codex = CodexAdmin(path)
    validator = AsyncMock(side_effect=lambda value, *, allow_loopback: value.rstrip("/"))
    admin = ModelAdmin(codex, service, endpoint_validator=validator)
    app = create_app(service)
    codex.register(app)
    admin.register(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield SimpleNamespace(client=client, path=path, data=data, service=service, store=store,
                              admin=admin, codex=codex, validator=validator)
    finally:
        await client.close()
        store.close()


def configuration(**changes):
    return {"label": "Qwen 更新", "source": "mona", "model": "qwen-new",
            "api_base": "https://model.example.invalid/v1", "api_key_env": "MONA_WORK_MODEL_QWEN_KEY",
            "billing_mode": "free", "billing_model": "",
            "max_output_tokens": 4096, "context_window_tokens": None, "reasoning_effort": None, **changes}


async def put(online, revision, *, model_id="qwen", config=None):
    return await online.client.put(URL, headers=headers(), json={"expected_revision": revision,
        "model_id": model_id, "configuration": configuration() if config is None else config})


@pytest.mark.asyncio
async def test_admin_boundary_snapshot_never_exposes_secrets_or_native_sources(online):
    for token, status in [(None, 401), ("ordinary", 403)]:
        request_headers = headers(token) if token else {}
        for method in ("GET", "PUT"):
            response = await online.client.request(method, URL, headers=request_headers,
                                                   json={} if method == "PUT" else None)
            assert response.status == status
    response = await online.client.get(URL, headers=headers())
    data = await response.json()
    assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
    assert [model["id"] for model in data["models"]] == ["qwen", "codex"]
    assert data["models"][0]["credentials"] == {"configured": True}
    assert data["models"][0]["configuration"]["api_key_env"] == "MONA_WORK_MODEL_QWEN_KEY"
    assert data["models"][0]["configuration"]["enabled"] is True
    assert data["models"][1]["configuration"]["source"] == "codex"
    assert data["models"][1]["availability"]["ready"] is False
    assert data["synchronized"] is True and data["billing"] == {"mode": "shared_wallet", "ready": False}
    assert SECRET not in json.dumps(data, ensure_ascii=False) and "/private/" not in json.dumps(data)
    assert online.validator.await_count == 0


@pytest.mark.asyncio
async def test_save_updates_shared_live_config_and_preserves_unrelated_fields(online):
    before = (await (await online.client.get(URL, headers=headers())).json())
    original = online.path.read_bytes()
    response = await put(online, before["revision"])
    body = await response.json()
    assert response.status == 200 and body["revision"] != before["revision"]
    assert body["models"][0]["configuration"]["model"] == "qwen-new"
    assert online.service.config.models["qwen"].model == "qwen-new"
    assert online.service.store.config is online.service.config is online.service.executor.config
    assert list(online.service.config.models) == ["qwen", "codex", "other"]
    disk = json.loads(online.path.read_text(encoding="utf-8"))
    assert disk["unrelated"] == online.data["unrelated"]
    assert disk["hosted_work"]["models"]["codex"] == online.data["hosted_work"]["models"]["codex"]
    assert disk["hosted_work"]["models"]["other"] == online.data["hosted_work"]["models"]["other"]
    backup = online.path.with_name(online.path.name + ".before-models-" + before["revision"] + ".json")
    assert backup.read_bytes() == original
    if os.name != "nt":
        assert stat.S_IMODE(backup.stat().st_mode) == stat.S_IMODE(online.path.stat().st_mode) == 0o600
    public = await (await online.client.get("/api/work/models", headers=headers("ordinary"))).json()
    assert next(item for item in public["models"] if item["id"] == "qwen")["label"] == "Qwen 更新"
    assert SECRET not in json.dumps(body, ensure_ascii=False)
    stale = await put(online, before["revision"])
    assert stale.status == 409 and (await stale.json())["error"] == "configuration_changed"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["free", "wallet"])
async def test_administrator_controls_custom_billing_without_source_based_defaults(online, mode):
    revision = online.admin.snapshot()["revision"]
    response = await put(online, revision, config=configuration(billing_mode=mode, billing_model="configured-price"))
    assert response.status == 200
    current = (await response.json())["models"][0]
    assert current["configuration"]["billing_mode"] == mode
    assert current["configuration"]["billing_model"] == "configured-price"
    assert current["availability"]["ready"] is (mode == "free")
    saved = json.loads(online.path.read_text(encoding="utf-8"))["hosted_work"]["models"]["qwen"]
    assert saved["billing_mode"] == mode and saved["billing_model"] == "configured-price"
    public = await (await online.client.get("/api/work/models", headers=headers("ordinary"))).json()
    assert ("qwen" in [item["id"] for item in public["models"]]) is (mode == "free")
    if mode == "wallet":
        with pytest.raises(WorkError) as error:
            online.service._acquire(OWNER, "qwen")
        assert error.value.code == "billing_unavailable"
        assert not online.service.active_users and not online.service.active_engines


@pytest.mark.asyncio
async def test_missing_or_invalid_billing_choice_never_silently_enables_free_access(online):
    revision, original = online.admin.snapshot()["revision"], online.path.read_bytes()
    missing = configuration()
    del missing["billing_mode"]
    for config in (missing, configuration(billing_mode="automatic"), configuration(billing_model="bad\nprice")):
        response = await put(online, revision, config=config)
        assert response.status == 400
        assert online.path.read_bytes() == original


@pytest.mark.asyncio
async def test_closing_model_does_not_depend_on_upstream_dns_or_available_credentials(online, monkeypatch):
    initial = online.admin.snapshot()
    qwen = dict(initial["models"][0]["configuration"])
    assert qwen["enabled"] is True and qwen["price"] is None
    monkeypatch.delenv("MONA_WORK_MODEL_QWEN_KEY")
    online.validator.side_effect = WorkError("model_endpoint_unavailable", "offline", 503)
    response = await put(online, initial["revision"], config={**qwen, "enabled": False})
    assert response.status == 200 and online.validator.await_count == 0
    disabled = (await response.json())["models"][0]
    assert disabled["configuration"]["enabled"] is False and disabled["availability"]["ready"] is False
    assert not (await (await online.client.get("/api/work/models", headers=headers("ordinary"))).json())["models"]
    with pytest.raises(WorkError) as error:
        online.service._acquire(OWNER, "qwen")
    assert error.value.code == "model_disabled" and not online.service.active_users

    revision = online.admin.snapshot()["revision"]
    enable = {**qwen, "enabled": True}
    response = await put(online, revision, config=enable)
    assert response.status == 503 and online.validator.await_count == 1
    online.validator.side_effect = lambda value, *, allow_loopback: value.rstrip("/")
    response = await put(online, revision, config=enable)
    assert response.status == 400 and (await response.json())["error"] == "price_required"
    response = await put(online, revision, config={**enable, "price": PRICE})
    assert response.status == 422 and (await response.json())["error"] == "credential_not_ready"
    monkeypatch.setenv("MONA_WORK_MODEL_QWEN_KEY", SECRET)
    response = await put(online, revision, config={**enable, "price": PRICE})
    assert response.status == 200
    assert (await response.json())["models"][0]["configuration"]["enabled"] is True


@pytest.mark.asyncio
async def test_new_models_default_closed_and_enabling_requires_explicit_price(online):
    revision = online.admin.snapshot()["revision"]
    response = await put(online, revision, model_id="new-model", config=configuration(label="New"))
    assert response.status == 200
    saved = await response.json()
    row = next(row for row in saved["models"] if row["id"] == "new-model")
    assert row["configuration"]["enabled"] is False and row["configuration"]["price"] is None
    assert row["availability"]["ready"] is False
    response = await put(online, saved["revision"], model_id="new-model",
                         config=configuration(label="New", enabled=True))
    assert response.status == 400
    assert (await response.json())["field"] == "price"
    zero = {"input_amount_per_million": "0", "cached_input_amount_per_million": "0", "output_amount_per_million": "0"}
    response = await put(online, saved["revision"], model_id="new-model",
                         config=configuration(label="New", enabled=True, price=zero))
    assert response.status == 200
    assert next(row for row in (await response.json())["models"] if row["id"] == "new-model")["availability"]["ready"] is True


@pytest.mark.asyncio
async def test_codex_models_are_individually_configurable_but_not_callable(online):
    revision = online.admin.snapshot()["revision"]
    config = {"source": "codex", "model": "gpt-example", "label": "Codex example",
              "billing_mode": "free", "price": PRICE, "enabled": True}
    response = await put(online, revision, model_id="codex-example", config=config)
    assert response.status == 200 and online.validator.await_count == 0
    data = await response.json()
    item = next(row for row in data["models"] if row["id"] == "codex-example")
    assert item["configuration"]["enabled"] is True and item["configuration"]["price"] == PRICE
    assert item["configuration"]["api_base"] == item["configuration"]["api_key_env"] == ""
    assert item["availability"]["ready"] is False and "执行接入" in item["availability"]["message"]
    assert "native_config_path" not in json.dumps(data)
    with pytest.raises(WorkError) as error:
        online.service._acquire(OWNER, "codex-example")
    assert error.value.code == "provider_unavailable" and not online.service.active_users
    public = await (await online.client.get("/api/work/models", headers=headers("ordinary"))).json()
    assert "codex-example" not in [row["id"] for row in public["models"]]

    original = online.path.read_bytes()
    for changes in ({"native_config_path": "/tmp/escape"}, {"api_base": "https://other.example/v1"},
                    {"api_key_env": "MONA_WORK_MODEL_QWEN_KEY"}):
        rejected = await put(online, data["revision"], model_id="codex-example", config={**config, **changes})
        assert rejected.status == 400 and online.path.read_bytes() == original
    conflict = await put(online, data["revision"], model_id="qwen", config=config)
    assert conflict.status == 409 and (await conflict.json())["error"] == "model_source_conflict"
    assert online.path.read_bytes() == original


@pytest.mark.asyncio
async def test_old_editor_preserves_closed_state_and_hidden_reasoning_effort(online):
    initial = online.admin.snapshot()
    response = await put(online, initial["revision"], config=configuration(enabled=False, reasoning_effort="high", price=PRICE))
    assert response.status == 200
    saved = await response.json()
    legacy = configuration(label="Legacy update")
    del legacy["reasoning_effort"]
    response = await put(online, saved["revision"], config=legacy)
    assert response.status == 200
    config = (await response.json())["models"][0]["configuration"]
    assert config["enabled"] is False and config["reasoning_effort"] == "high" and config["price"] == PRICE


@pytest.mark.asyncio
async def test_model_save_preserves_current_verified_codex_connection(online):
    initial = online.admin.snapshot()
    connection = {"state": "ready", "message": "已验证", "models": [{"id": "gpt-example", "label": "GPT"}]}
    online.codex.checked = (initial["revision"], connection)
    response = await put(online, initial["revision"], config=configuration(price=PRICE))
    assert response.status == 200
    current = await response.json()
    assert current["revision"] != initial["revision"]
    assert online.codex.checked == (current["revision"], connection)
    assert online.codex.snapshot()["connection"] == connection


@pytest.mark.asyncio
async def test_model_save_discards_stale_or_changed_codex_connection(online, monkeypatch):
    initial = online.admin.snapshot()
    connection = {"state": "ready", "message": "旧连接", "models": [{"id": "old", "label": "Old"}]}
    online.codex.checked = ("0" * 64, connection)
    response = await put(online, initial["revision"], config=configuration(price=PRICE))
    assert response.status == 200 and online.codex.checked is None

    revision = (await response.json())["revision"]
    online.codex.checked = (revision, connection)
    write = online.codex._write_locked
    def simulate_out_of_band_codex_change(data, key, revision, *, backup_kind):
        write(data, key, revision, backup_kind=backup_kind)
        changed = json.loads(online.path.read_text(encoding="utf-8"))
        changed["hosted_work"]["codex"] = {"label": "External change"}
        online.path.write_text(json.dumps(changed), encoding="utf-8")
    monkeypatch.setattr(online.codex, "_write_locked", simulate_out_of_band_codex_change)
    response = await put(online, revision, config=configuration(label="Updated again"))
    assert response.status == 200 and online.codex.checked is None


@pytest.mark.asyncio
async def test_independent_model_prices_are_saved_per_model_and_hidden_from_public(online):
    initial = online.admin.snapshot()
    assert initial["models"][0]["configuration"]["price"] is None
    response = await put(online, initial["revision"], config=configuration(price=PRICE, billing_mode="wallet"))
    assert response.status == 200
    saved = await response.json()
    assert saved["models"][0]["configuration"]["price"] == PRICE
    assert saved["models"][0]["availability"]["ready"] is False
    assert online.service.config.models["qwen"].price.model_dump() == PRICE
    second_price = {"input_amount_per_million": "0", "cached_input_amount_per_million": "0.000000",
                    "output_amount_per_million": "1.00"}
    response = await put(online, saved["revision"], model_id="second",
                         config=configuration(label="Second", price=second_price, billing_mode="free", enabled=True))
    assert response.status == 200
    data = await response.json()
    by_id = {row["id"]: row["configuration"]["price"] for row in data["models"]}
    assert by_id == {"qwen": PRICE, "codex": None, "second": second_price}
    persisted = json.loads(online.path.read_text(encoding="utf-8"))["hosted_work"]["models"]
    assert persisted["qwen"]["price"] == PRICE and persisted["second"]["price"] == second_price
    public = await (await online.client.get("/api/work/models", headers=headers("ordinary"))).json()
    assert [row["id"] for row in public["models"]] == ["second"]
    assert "price" not in json.dumps(public)
    assert "prices_endpoint" not in json.dumps(data) and data["billing"]["ready"] is False


@pytest.mark.asyncio
async def test_legacy_save_preserves_price_and_legacy_mapping_but_explicit_null_clears_price(online):
    initial = online.admin.snapshot()
    response = await put(online, initial["revision"],
                         config=configuration(price=PRICE, billing_model="legacy-mapping"))
    assert response.status == 200
    revision = (await response.json())["revision"]
    legacy = configuration(label="Legacy client update")
    del legacy["billing_model"]
    response = await put(online, revision, config=legacy)
    assert response.status == 200
    current = (await response.json())["models"][0]["configuration"]
    assert current["label"] == "Legacy client update" and current["price"] == PRICE
    assert current["billing_model"] == "legacy-mapping"
    response = await put(online, online.admin.snapshot()["revision"], config={**legacy, "price": None})
    assert response.status == 200
    current = (await response.json())["models"][0]["configuration"]
    assert current["price"] is None and current["billing_model"] == "legacy-mapping"


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["", "-1", "+1", "01", "1e3", "NaN", "Infinity", "1\n", "１",
                                    "1.0000001", "1000000000.000001", "1000000001", 1, 1.5, False, None])
async def test_price_rejects_invalid_values_without_writes(online, invalid):
    initial, original = online.admin.snapshot(), online.path.read_bytes()
    price = {**PRICE, "input_amount_per_million": invalid}
    response = await put(online, initial["revision"], config=configuration(price=price))
    data = await response.json()
    assert response.status == 400 and data["error"] == "invalid_model"
    assert data["field"] == "input_amount_per_million"
    assert online.path.read_bytes() == original and online.service.config.models["qwen"].price is None
    assert online.validator.await_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["cached_input_amount_per_million", "output_amount_per_million"])
async def test_price_errors_identify_the_failing_amount_field(online, field):
    revision = online.admin.snapshot()["revision"]
    response = await put(online, revision, config=configuration(price={**PRICE, field: "-1"}))
    assert response.status == 400 and (await response.json())["field"] == field


@pytest.mark.asyncio
async def test_price_must_be_complete_and_cannot_include_foreign_fields(online):
    revision, original = online.admin.snapshot()["revision"], online.path.read_bytes()
    missing = dict(PRICE)
    del missing["output_amount_per_million"]
    for price, field in [(missing, "output_amount_per_million"), ({**PRICE, "currency": "USD"}, "price")]:
        response = await put(online, revision, config=configuration(price=price))
        assert response.status == 400 and (await response.json())["field"] == field
        assert online.path.read_bytes() == original


def test_codex_and_model_schema_share_exact_optional_price_contract():
    assert HostedCodexSettings().price is None
    codex = HostedCodexSettings.model_validate({"price": PRICE})
    assert codex.price == HostedWorkPrice.model_validate(PRICE)
    assert codex.model_dump()["price"] == PRICE


@pytest.mark.asyncio
async def test_can_add_first_model_when_saved_config_omits_models(online):
    data = copy.deepcopy(online.data)
    del data["hosted_work"]["models"]
    online.path.write_text(json.dumps(data), encoding="utf-8")
    online.service.config.models = {}
    initial = online.admin.snapshot()
    assert initial["models"] == [] and initial["synchronized"]
    response = await put(online, initial["revision"], model_id="first")
    assert response.status == 200 and list(online.service.config.models) == ["first"]
    assert json.loads(online.path.read_text(encoding="utf-8"))["hosted_work"]["models"]["first"]["model"] == "qwen-new"


@pytest.mark.asyncio
async def test_out_of_band_saved_models_report_mismatch_and_do_not_overwrite_live_config(online):
    data = copy.deepcopy(online.data)
    data["hosted_work"]["models"]["qwen"]["model"] = "changed-outside"
    online.path.write_text(json.dumps(data), encoding="utf-8")
    status = online.admin.snapshot()
    assert status["synchronized"] is False
    assert status["models"][0]["configuration"]["model"] == "qwen-old"
    response = await put(online, status["revision"])
    assert response.status == 409 and (await response.json())["error"] == "configuration_changed"
    assert online.service.config.models["qwen"].model == "qwen-old"
    assert json.loads(online.path.read_text(encoding="utf-8"))["hosted_work"]["models"]["qwen"]["model"] == "changed-outside"


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["user", "engine", "process", "running", "cancelling", "unknown", "file-running", "file-unknown"])
async def test_busy_or_unknown_never_writes_or_applies(online, reason):
    initial = online.admin.snapshot()
    original, models = online.path.read_bytes(), copy.deepcopy(online.service.config.models)
    if reason == "user":
        online.service.active_users.add(OWNER)
    elif reason == "engine":
        online.service.active_engines.add("fixture")
    elif reason == "process":
        online.service.executor.processes[(OWNER, RID)] = object()
    elif reason.startswith("file-"):
        online.store.db.execute("INSERT INTO workspace_operations VALUES(?,?,?,?)", (OWNER, RID, "upload", reason[5:]))
    else:
        online.store.create_session(OWNER, NewSession(request_id=SID))
        online.store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="qwen", text="测试"))
        online.store.db.execute("UPDATE runs SET status=? WHERE owner=? AND id=?", (reason, OWNER, RID))
    response = await put(online, initial["revision"])
    assert response.status == 409 and (await response.json())["error"] == "work_busy"
    assert online.path.read_bytes() == original and online.service.config.models == models
    assert not list(online.path.parent.glob("*.before-models-*"))


@pytest.mark.asyncio
async def test_env_missing_raw_key_and_native_overwrite_are_rejected(online, monkeypatch):
    initial, original = online.admin.snapshot(), online.path.read_bytes()
    monkeypatch.delenv("MONA_WORK_MODEL_QWEN_KEY")
    response = await put(online, initial["revision"])
    assert response.status == 422 and (await response.json())["error"] == "credential_not_ready"
    assert online.admin.snapshot()["models"][0]["credentials"]["configured"] is False
    monkeypatch.setenv("MONA_WORK_MODEL_QWEN_KEY", SECRET)
    for changes in ({"api_key": SECRET}, {"native_config_path": ""}, {"source": "codex"}):
        response = await put(online, initial["revision"], config=configuration(**changes))
        assert response.status == 400 and SECRET not in await response.text()
    response = await put(online, initial["revision"], model_id="codex")
    assert response.status == 409 and (await response.json())["error"] == "model_source_conflict"
    assert online.path.read_bytes() == original and online.service.config.models["codex"].source == "codex"


@pytest.mark.asyncio
async def test_validation_failure_is_sanitized_and_field_specific(online):
    online.validator.side_effect = WorkError("invalid_model_endpoint", "private endpoint detail", 400)
    request = SaveModel(expected_revision=online.admin.snapshot()["revision"], model_id="qwen", configuration=configuration())
    with pytest.raises(ModelAdminError) as error:
        await online.admin.save(request)
    assert error.value.code == "invalid_endpoint" and error.value.field == "api_base"
    response = await put(online, request.expected_revision)
    assert response.status == 400 and (await response.json())["error"] == "invalid_endpoint"
    assert "private endpoint detail" not in await response.text()


@pytest.mark.asyncio
async def test_real_endpoint_validator_allows_public_and_refuses_private_dns(online):
    async def public(_host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", port))]
    async def private(_host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", port))]
    async def validate(value, *, allow_loopback):
        resolver = private if "private.example" in value else public
        return await validate_model_endpoint(value, allow_loopback=allow_loopback, resolver=resolver)

    online.admin.endpoint_validator = validate
    initial = online.admin.snapshot()
    response = await put(online, initial["revision"], config=configuration(api_base="https://public.example/v1/"))
    assert response.status == 200 and online.service.config.models["qwen"].api_base == "https://public.example/v1"
    revision, previous = online.admin.snapshot()["revision"], online.path.read_bytes()
    response = await put(online, revision, config=configuration(api_base="https://private.example/v1"))
    assert response.status == 400 and (await response.json())["error"] == "invalid_endpoint"
    assert online.path.read_bytes() == previous and online.service.config.models["qwen"].api_base == "https://public.example/v1"


@pytest.mark.asyncio
async def test_model_cannot_be_repointed_at_account_service(online):
    revision, previous = online.admin.snapshot()["revision"], online.path.read_bytes()
    response = await put(online, revision, config=configuration(api_base="https://auth.example.invalid/auth/identity"))
    assert response.status == 400 and (await response.json())["error"] == "invalid_endpoint"
    assert online.path.read_bytes() == previous and online.service.config.models["qwen"].model == "qwen-old"


@pytest.mark.asyncio
async def test_same_revision_codex_save_wins_during_endpoint_validation(online):
    entered, release = asyncio.Event(), asyncio.Event()
    async def waiting(value, *, allow_loopback):
        entered.set()
        await release.wait()
        return value
    online.admin.endpoint_validator = waiting
    revision = online.admin.snapshot()["revision"]
    task = asyncio.create_task(put(online, revision))
    await entered.wait()
    await online.codex.save(SaveCodex(expected_revision=revision, configuration=HostedCodexSettings(label="新草稿")))
    release.set()
    response = await task
    assert response.status == 409 and (await response.json())["error"] == "configuration_changed"
    assert online.service.config.models["qwen"].model == "qwen-old"
    assert json.loads(online.path.read_text(encoding="utf-8"))["hosted_work"]["codex"]["label"] == "新草稿"


@pytest.mark.asyncio
async def test_task_can_start_during_endpoint_validation_but_blocks_commit(online):
    entered, release = asyncio.Event(), asyncio.Event()
    async def waiting(value, *, allow_loopback):
        entered.set()
        await release.wait()
        return value
    online.admin.endpoint_validator = waiting
    revision, original = online.admin.snapshot()["revision"], online.path.read_bytes()
    task = asyncio.create_task(put(online, revision))
    await entered.wait()
    online.service.active_users.add(OWNER)
    release.set()
    response = await task
    assert response.status == 409 and (await response.json())["error"] == "work_busy"
    assert online.path.read_bytes() == original and online.service.config.models["qwen"].model == "qwen-old"


@pytest.mark.asyncio
async def test_loopback_cannot_be_added_but_existing_origin_can_be_retained(online):
    initial = online.admin.snapshot()
    response = await put(online, initial["revision"], config=configuration(api_base="http://127.0.0.1:18000/v1"))
    assert response.status == 400 and (await response.json())["error"] == "invalid_endpoint"
    assert online.validator.await_args.kwargs == {"allow_loopback": False}
    original = json.loads(online.path.read_text(encoding="utf-8"))
    original["hosted_work"]["models"]["qwen"]["api_base"] = "http://127.0.0.1:18000/v1"
    online.path.write_text(json.dumps(original), encoding="utf-8")
    online.service.config.models = HostedWorkConfig.model_validate(original["hosted_work"]).models
    revision = online.admin.snapshot()["revision"]
    response = await put(online, revision, config=configuration(api_base="http://127.0.0.1:18000/v2"))
    assert response.status == 200 and online.validator.await_args.kwargs == {"allow_loopback": True}
    changed = await put(online, online.admin.snapshot()["revision"], config=configuration(api_base="http://127.0.0.1:18001/v1"))
    assert changed.status == 400 and online.validator.await_args.kwargs == {"allow_loopback": False}
