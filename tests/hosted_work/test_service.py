"""Exercise the real HTTP/store/admission boundary; only identity and execution edges are isolated."""
import asyncio
import hashlib

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

SID, RID = "a" * 32, "b" * 32
OWNER = owner_key("1")


class IdentityBoundary:
    async def identity(self, token):
        if token not in {"user-one", "user-two"}:
            raise WorkError("login_required", "请登录", 401)
        return owner_key("1" if token == "user-one" else "2")


class ExecutionBoundary:
    def __init__(self):
        self.calls = []
        self.cancelled = []
        self.release = asyncio.Event()
        self.fail = False

    async def execute(self, payload, emit):
        self.calls.append(payload)
        if self.fail:
            raise OSError("isolated transport failed")
        await emit("progress", {"message": "处理中"})
        await self.release.wait()
        await emit("delta", {"text": "完成"})
        status = "cancelled" if self.cancelled else "completed"
        return {"status": status, "content": "完成", "workspace_saved": True, "artifacts": []}

    def cancel(self, owner, run_id):
        self.cancelled.append((owner, run_id))
        self.release.set()


@pytest_asyncio.fixture
async def online(tmp_path):
    config = HostedWorkConfig(public_origin="https://work.example.invalid", state_dir=str(tmp_path),
        models={"official": {"label": "Mona", "model": "fixture-model"}})
    store = WorkStore(tmp_path / "state.sqlite3", config)
    executor = ExecutionBoundary()
    service = WorkService(config, store, IdentityBoundary(), executor)
    client = TestClient(TestServer(create_app(service)))
    await client.start_server()
    try:
        yield client, service, executor
    finally:
        executor.release.set()
        await service.close()
        await client.close()
        store.close()


def headers(user="user-one"):
    return {"Authorization": "Bearer " + user, "Origin": "https://work.example.invalid"}


async def create(client):
    return await client.post("/api/work/sessions", headers=headers(), json={"request_id": SID})


@pytest.mark.asyncio
async def test_no_desktop_routes_or_anonymous_access(online):
    client, _, _ = online
    assert (await client.get("/api/work/models")).status == 401
    assert (await client.get("/api/work/models", headers={**headers(), "Origin": "https://attacker.invalid"})).status == 403
    assert (await client.post("/api/settings", headers=headers(), json={})).status == 404
    result = await (await client.get("/api/work/models", headers=headers())).json()
    assert result["models"] == [{"id": "official", "label": "Mona", "source": "mona"}]
    assert "native_config_path" not in str(result) and "api_key" not in str(result)


@pytest.mark.asyncio
async def test_submit_and_refresh_never_repeat_execution(online):
    client, service, executor = online
    assert (await create(client)).status == 201
    body = {"request_id": RID, "model_id": "official", "text": "整理资料"}
    first = await client.post(f"/api/work/sessions/{SID}/runs", headers=headers(), json=body)
    assert first.status == 202
    await asyncio.sleep(0)
    again = await client.post(f"/api/work/sessions/{SID}/runs", headers=headers(), json=body)
    assert again.status == 202 and len(executor.calls) == 1
    assert (await client.get(f"/api/work/runs/{RID}/events", headers=headers("user-two"))).status == 404
    executor.release.set()
    await asyncio.gather(*list(service.tasks.values()))
    events = await (await client.get(f"/api/work/runs/{RID}/events?after=0", headers=headers())).json()
    assert events["run"]["status"] == "completed"
    assert [item["kind"] for item in events["events"]] == ["progress", "delta"]
    assert "account_token" not in str(events)
    assert "user-one" not in service.store.db.execute("SELECT payload FROM runs").fetchone()[0]


@pytest.mark.asyncio
async def test_user_cannot_override_provider_or_other_users_session(online):
    client, _, executor = online
    await create(client)
    base = {"request_id": RID, "model_id": "official", "text": "work"}
    assert (await client.post(f"/api/work/sessions/{SID}/runs", headers=headers(), json={**base, "api_key": "untrusted"})).status == 400
    assert (await client.post(f"/api/work/sessions/{SID}/runs", headers=headers(), json={**base, "model_id": "arbitrary-url"})).status == 400
    assert (await client.post(f"/api/work/sessions/{SID}/runs", headers=headers("user-two"), json=base)).status == 404
    assert not executor.calls


@pytest.mark.asyncio
async def test_stop_is_owner_bound_and_retains_original_run(online):
    client, service, executor = online
    await create(client)
    await client.post(f"/api/work/sessions/{SID}/runs", headers=headers(),
                      json={"request_id": RID, "model_id": "official", "text": "work"})
    denied = await client.post(f"/api/work/runs/{RID}/stop", headers=headers("user-two"), json={"confirmed": True})
    assert denied.status == 404 and not executor.cancelled
    assert (await client.post(f"/api/work/runs/{RID}/stop", headers=headers(), json={})).status == 400
    assert (await client.post(f"/api/work/runs/{RID}/stop", headers=headers(), json={"confirmed": True})).status == 200
    await asyncio.gather(*list(service.tasks.values()))
    assert service.store.run(OWNER, RID)["status"] == "cancelled"
    assert executor.cancelled == [(OWNER, RID)]


@pytest.mark.asyncio
async def test_unknown_execution_blocks_next_turn(online):
    _, service, executor = online
    service.store.create_session(OWNER, NewSession(request_id=SID))
    executor.fail = True
    await service.submit(OWNER, "user-one", SID, NewTurn(request_id=RID, model_id="official", text="work"))
    await asyncio.gather(*list(service.tasks.values()))
    assert service.store.run(OWNER, RID)["status"] == "unknown"
    with pytest.raises(WorkError):
        await service.submit(OWNER, "user-one", SID, NewTurn(request_id="c" * 32, model_id="official", text="more"))
    assert len(executor.calls) == 1


@pytest.mark.asyncio
async def test_unknown_upload_is_durable_and_blocks_later_mutations(online):
    client, service, executor = online
    await create(client)
    executor.fail = True
    response = await client.put(f"/api/work/sessions/{SID}/files/{'d' * 32}?name=note.txt", headers=headers(), data=b"hello")
    assert response.status == 503
    with pytest.raises(WorkError) as exc:
        service.store.require_idle(OWNER)
    assert exc.value.code == "workspace_pending"
    assert service.store.db.execute("SELECT status FROM workspace_operations").fetchone()[0] == "unknown"


@pytest.mark.asyncio
async def test_cross_session_attachment_does_not_reach_executor(online):
    _, service, executor = online
    service.store.create_session(OWNER, NewSession(request_id=SID))
    other_sid = "e" * 32
    service.store.create_session(OWNER, NewSession(request_id=other_sid))
    file_id = "d" * 32
    service.store.add_file(OWNER, other_sid, file_id, {"path": "upload.txt", "name": "upload.txt", "size": 3,
        "sha256": hashlib.sha256(b"abc").hexdigest()})
    with pytest.raises(WorkError):
        await service.submit(OWNER, "user-one", SID, NewTurn(request_id=RID, model_id="official", text="read", attachment_ids=[file_id]))
    assert not executor.calls
