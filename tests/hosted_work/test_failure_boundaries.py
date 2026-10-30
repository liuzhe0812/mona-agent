"""Failure paths exercise the real turn lifecycle without executing a model or host command."""
import copy
from unittest.mock import AsyncMock

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work import turn
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.public_web import PublicResolver
from mona.hosted_work.sandbox import SandboxError, verify_inspection
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore

OWNER, SID, RID = owner_key("1"), "a" * 32, "b" * 32


@pytest.fixture
def lifecycle(tmp_path, monkeypatch):
    from mona.config import loader
    monkeypatch.setattr(loader, "_current_config_path", tmp_path / "original.json")
    config = HostedWorkConfig(enabled=True, state_dir=str(tmp_path),
        models={"official": {"label": "Mona", "model": "fixture"}})
    state = {"start_failure": False, "save_failure": False, "close_failure": False,
             "provider_close_failure": False, "artifact_changed": False}
    instances = []
    metadata = {"path": "result.txt", "name": "result.txt", "size": 3, "sha256": "a" * 64}

    class IsolatedSandbox:
        def __init__(self, *_):
            self.started = False
            self.calls = []
            instances.append(self)

        async def start(self):
            self.calls.append("start")
            if state["start_failure"]:
                raise SandboxError()
            self.started = True

        async def save(self):
            self.calls.append("save")
            if state["save_failure"]:
                raise SandboxError()

        async def file(self, request):
            self.calls.append(request["action"])
            return {**metadata, "sha256": "f" * 64 if state["artifact_changed"] else metadata["sha256"]}

        async def close(self):
            self.calls.append("close")
            if state["close_failure"]:
                raise SandboxError()
            self.started = False

    class Provider:
        async def aclose(self):
            if state["provider_close_failure"]:
                raise RuntimeError("must not leak raw diagnostic")

    class Auth:
        def __init__(self, _):
            pass

        async def identity(self, token):
            return OWNER

    provider_calls = []
    def provider_factory(*args):
        provider_calls.append(args)
        return Provider()

    async def runner(config, payload, sandbox, provider, emit, authorize):
        await emit("artifact", metadata)
        return {"status": "completed", "content": "done", "message": ""}

    monkeypatch.setattr(turn, "DockerSandbox", IsolatedSandbox)
    monkeypatch.setattr(turn, "AuthClient", Auth)
    monkeypatch.setattr(turn, "create_provider", provider_factory)
    monkeypatch.setattr(turn, "run_turn", runner)
    payload = {"action": "turn", "owner": OWNER, "run_id": RID, "model_id": "official", "account_token": "synthetic-token"}
    return config, payload, state, instances, provider_calls


async def drive(lifecycle):
    config, payload, *_ = lifecycle
    events = []
    async def emit(kind, value):
        events.append((kind, copy.deepcopy(value)))
    await turn.execute_payload(config, payload, emit)
    assert events[-1][0] == "result"
    return events[-1][1]


@pytest.mark.asyncio
async def test_no_model_is_contacted_when_sandbox_start_fails(lifecycle):
    _, _, state, instances, providers = lifecycle
    state["start_failure"] = True
    result = await drive(lifecycle)
    assert result["status"] == "failed" and not providers
    assert instances[0].calls == ["start", "close"]


@pytest.mark.asyncio
async def test_success_requires_saved_workspace_and_verified_cleanup(lifecycle):
    result = await drive(lifecycle)
    assert result["status"] == "completed" and result["workspace_saved"] is True
    assert result["artifacts"][0]["path"] == "result.txt"
    assert lifecycle[3][0].calls == ["start", "save", "stat", "close"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["save_failure", "artifact_changed"])
async def test_unsaved_or_changed_artifacts_cannot_be_published_as_success(lifecycle, failure):
    lifecycle[2][failure] = True
    result = await drive(lifecycle)
    assert result["status"] == "failed" and result["workspace_saved"] is False
    assert not result.get("artifacts")
    assert lifecycle[3][0].calls[-1] == "close"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["close_failure", "provider_close_failure"])
async def test_unknown_cleanup_never_reports_completion_or_retries(lifecycle, failure):
    lifecycle[2][failure] = True
    result = await drive(lifecycle)
    assert result["status"] == "unknown"
    assert len(lifecycle[4]) == 1
    assert "raw diagnostic" not in str(result)


@pytest.mark.asyncio
async def test_combined_cleanup_and_save_failure_preserves_unknown(lifecycle):
    lifecycle[2].update(provider_close_failure=True, save_failure=True)
    assert (await drive(lifecycle))["status"] == "unknown"


@pytest.mark.asyncio
async def test_resolver_rejects_mixed_and_private_dns_answers(monkeypatch):
    resolver = PublicResolver()
    try:
        monkeypatch.setattr(resolver.resolver, "resolve", AsyncMock(return_value=[
            {"host": "8.8.8.8"}, {"host": "127.0.0.1"},
        ]))
        with pytest.raises(OSError):
            await resolver.resolve("mixed.example.invalid", 443)
        resolver.resolver.resolve.return_value = [{"host": "192.168.20.1"}]
        with pytest.raises(OSError):
            await resolver.resolve("rebound.example.invalid", 443)
        resolver.resolver.resolve.return_value = [{"host": "8.8.8.8"}]
        assert await resolver.resolve("public.example.invalid", 443) == [{"host": "8.8.8.8"}]
    finally:
        await resolver.close()


def verified_policy(config):
    return {"HostConfig": {"Runtime": "runsc", "NetworkMode": "none", "ReadonlyRootfs": True,
        "Privileged": False, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
        "PidsLimit": 64, "Memory": config.sandbox_memory_mb * 1024 * 1024,
        "MemorySwap": config.sandbox_memory_mb * 1024 * 1024, "NanoCpus": int(config.sandbox_cpus * 1e9),
        "IpcMode": "private", "Tmpfs": {"/tmp": "options", "/workspace": "options"}},
        "Config": {"User": "1000:1000", "Labels": {"mona.hosted-work": "v1", "mona.owner": OWNER}}, "Mounts": []}


@pytest.mark.parametrize("field,value", [("Runtime", "runc"), ("NetworkMode", "host"), ("ReadonlyRootfs", False),
    ("Privileged", True), ("Memory", 0), ("MemorySwap", -1), ("NanoCpus", 0), ("PidsLimit", 0),
    ("Binds", ["/:/host"]), ("CapAdd", ["SYS_ADMIN"]), ("PidMode", "host")])
def test_inspection_refuses_each_downgraded_isolation_property(field, value):
    config = HostedWorkConfig()
    value_before = verified_policy(config)
    verify_inspection(value_before, OWNER, config)
    changed = copy.deepcopy(value_before)
    changed["HostConfig"][field] = value
    with pytest.raises(SandboxError):
        verify_inspection(changed, OWNER, config)


def test_uncertain_native_source_stays_blocked_across_users(tmp_path):
    config = HostedWorkConfig(max_concurrent_runs=3, models={
        "native": {"label": "GPT", "model": "fixture", "source": "codex", "native_config_path": str(tmp_path / "operator.json")}})
    store = WorkStore(tmp_path / "db.sqlite3", config)
    try:
        store.create_session(OWNER, NewSession(request_id=SID))
        store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="native", text="work"))
        store.recover()
        service = WorkService(config, store, None, None)
        with pytest.raises(WorkError) as exc:
            service._acquire(owner_key("2"), "native")
        assert exc.value.code == "model_pending"
    finally:
        store.close()


def test_session_creation_retry_after_automatic_title_is_still_idempotent(tmp_path):
    config = HostedWorkConfig()
    store = WorkStore(tmp_path / "db.sqlite3", config)
    try:
        request = NewSession(request_id=SID)
        store.create_session(OWNER, request)
        store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="official", text="整理课程资料"))
        assert store.create_session(OWNER, request)["title"] == "整理课程资料"
    finally:
        store.close()


@pytest.mark.asyncio
async def test_revoked_authority_stops_before_tool_execution():
    from mona.hosted_work.turn import WorkHook
    async def deny():
        raise WorkError("revoked", "登录已撤销", 401)
    emit = AsyncMock()
    hook = WorkHook(emit, deny)
    with pytest.raises(WorkError):
        await hook.before_execute_tools(None)
    emit.assert_not_called()
