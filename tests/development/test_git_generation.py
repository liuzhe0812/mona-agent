from types import SimpleNamespace

import pytest
from test_git_operations import command
from test_git_operations import repository as repository

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId
from mona.development.git_generation import generate_commit_message
from mona.providers.base import LLMResponse


@pytest.mark.asyncio
async def test_message_generation_uses_staged_diff_and_does_not_write_git(repository, monkeypatch):
    root, service, session = repository
    (root / "selected.txt").write_text("STAGED_SENTINEL\n")
    command(root, "add", "--", "selected.txt")
    (root / "selected.txt").write_text("UNSTAGED_SENTINEL\n")
    preview = await service.preview(session.id, False)
    calls = []
    class Provider:
        async def chat(self, **kwargs):
            calls.append(kwargs)
            return LLMResponse(content="fix: 修复暂存变更")

        async def aclose(self):
            calls.append("closed")

    monkeypatch.setattr("mona.development.git_generation.build_provider_snapshot", lambda *args, **kwargs: SimpleNamespace(provider=Provider(), model="configured-model"))
    _resolve_tool_config_refs()
    runtime = SimpleNamespace(git_operations=service, config_loader=Config, store=service.store)
    before = command(root, "rev-parse", "HEAD"), (root / ".git/index").read_bytes()
    result = await generate_commit_message(runtime, session.id, False, preview["contextToken"])
    assert result["message"] == "fix: 修复暂存变更"
    assert "STAGED_SENTINEL" in str(calls[0]["messages"]) and "UNSTAGED_SENTINEL" not in str(calls[0]["messages"])
    assert calls[0]["tools"] is None and calls[0]["model"] == "configured-model" and calls[-1] == "closed"
    assert before == (command(root, "rev-parse", "HEAD"), (root / ".git/index").read_bytes())
    assert not service.tasks and len(service.store.list_sessions(session.project_id)) == 1
    await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", [ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
async def test_native_generation_is_readonly_isolated_and_releases_only_its_binding(repository, executor):
    root, service, parent = repository
    session = service.store.create_session(parent.project_id, executor, model="native-model")
    (root / "selected.txt").write_text("change\n")
    preview = await service.preview(session.id)
    calls = []
    binding = SimpleNamespace(id="temporary_binding")
    class Host:
        async def create_session(self, start):
            assert start.readonly and start.session.parent_session_id == session.id
            assert start.session.id != session.id and start.model == "native-model"
            assert not start.context.rules and not start.context.skills
            calls.append("create")
            return binding

        async def send(self, target, request, message):
            assert target is binding and "change" in message
            calls.append("send")
            return SimpleNamespace(outcome="accepted")

        async def events(self, target):
            assert target is binding
            yield SimpleNamespace(type="agent.message.completed", payload={"itemId": "message", "text": "fix: 更新文件"})
            yield SimpleNamespace(type="run.completed", payload={})

        async def close_runtime(self, target, *, force):
            assert target is binding and force
            calls.append("close")

    async def host_for(target):
        assert target.id == session.id
        return Host()

    runtime = SimpleNamespace(git_operations=service, config_loader=Config, store=service.store, native=SimpleNamespace(_host=host_for))
    before = command(root, "rev-parse", "HEAD")
    assert (await generate_commit_message(runtime, session.id, True, preview["contextToken"]))["message"] == "fix: 更新文件"
    assert calls == ["create", "send", "close"]
    assert command(root, "rev-parse", "HEAD") == before
    assert len(service.store.list_sessions(parent.project_id)) == 2
    await service.close()
