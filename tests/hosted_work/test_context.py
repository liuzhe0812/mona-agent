"""Application context composition and compaction remain inside one hosted account."""
from __future__ import annotations

import copy
import json
import os
import stat
import time
from importlib.resources import files as package_files
from types import SimpleNamespace

import pytest

from mona.agent.context import ContextBuilder
from mona.agent.memory import Consolidator
from mona.config import loader, paths
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.context import HostedTurnContext, build_turn_context, history_fingerprint
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.tools import HostedTools
from mona.providers.base import LLMProvider, LLMResponse
from mona.providers.capabilities import ModelCapabilities
from mona.providers.context_window import ResolvedContextWindow

SID = "a" * 32
RID = "b" * 32
OWNER = owner_key("31")


class Provider(LLMProvider):
    def __init__(self, *, failure=False):
        super().__init__()
        self.requests = []
        self.failure = failure

    def get_default_model(self):
        return "fixture-model"

    def get_capabilities(self, model):
        return ModelCapabilities(supports_tool_calling=True)

    def estimate_prompt_tokens(self, messages, tools=None, model=None):
        return max(1, sum(len(str(message.get("content", ""))) for message in messages) // 4), "fixture_counter"

    async def chat(self, messages, **kwargs):
        self.requests.append(copy.deepcopy(messages))
        return LLMResponse(content="sensitive-provider-text" if self.failure else "Earlier completed work and the user's goal.",
                           finish_reason="error" if self.failure else "stop", error_status_code=400 if self.failure else None)


async def create(tmp_path, *, owner=None, history=None, metadata=None, context_state=None, failure=False):
    config = HostedWorkConfig(state_dir=str(tmp_path / "state"),
                              models={"public": {"label": "Platform model", "model": "fixture-model", "max_output_tokens": 256}})
    events = []
    async def emit(kind, value):
        events.append((kind, copy.deepcopy(value)))
    history = history if history is not None else [{"role": "user", "content": "Create a short document."}]
    payload = {"model_id": "public", "session_id": SID, "run_id": RID, "history": history,
               "metadata": metadata or {}, "context_state": context_state or {}}
    if owner is not None:
        payload["owner"] = owner
    tools = HostedTools(SimpleNamespace(config=config), emit, history=history, config=config)
    provider = Provider(failure=failure)
    context = await build_turn_context(config, payload, tools, provider, emit)
    return context, events, provider, payload, tools


@pytest.mark.asyncio
async def test_injection_keeps_original_body_separate_from_model_projection(tmp_path):
    context, *_ = await create(tmp_path)
    context.register_injection_projection("input-1", "  原文  ", "  原文  \n\nRuntime context")
    context.register_injection_projection("input-2", "", [{"type": "text", "text": "附件上下文"}])
    messages = [*context.messages, {"role": "assistant", "content": "等待"},
                {"role": "user", "id": "input-1", "content": "  原文  \n\nRuntime context"},
                {"role": "user", "id": "input-2", "content": [{"type": "text", "text": "附件上下文"}]}]
    stored = context.history_for_storage(messages)
    assert stored[-2]["content"] == "  原文  " and stored[-1]["content"] == ""
    assert stored[-2]["id"] == "input-1" and stored[-1]["id"] == "input-2"
    assert stored[-2]["timestamp"] and stored[-1]["timestamp"]
    assert messages[-2]["content"].endswith("Runtime context")
    with pytest.raises(WorkError):
        context.register_injection_projection("input-1", "替换原文", "new")
    messages[-2]["content"] = "合并过的正文"
    with pytest.raises(WorkError):
        context.history_for_storage(messages)


@pytest.mark.asyncio
async def test_shared_builder_never_loads_default_private_state_without_an_owner(tmp_path, monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("A transient hosted context cannot load a desktop/private store")
    monkeypatch.setattr("mona.agent.context.MemoryStore", forbidden)
    monkeypatch.setattr("mona.hosted_work.context.MemoryStore", forbidden)
    monkeypatch.setattr("mona.agent.context.SkillsLoader", forbidden)
    monkeypatch.setattr("mona.config.paths.get_agent_memory_dir", forbidden)
    monkeypatch.setattr(ContextBuilder, "_load_shared_user_profile", forbidden)
    monkeypatch.setattr("mona.session.manager.get_legacy_sessions_dir", forbidden)
    original = [{"role": "user", "content": "Read the current slide."}]
    context, events, _, payload, _ = await create(tmp_path, history=original, metadata={
        "office_session_id": "office_public", "office_document_type": "slides", "office_display_name": "User slides",
    })
    assert isinstance(context.builder, ContextBuilder) and isinstance(context.consolidator, Consolidator)
    assert context.model_context_callback is None
    system = context.messages[0]["content"]
    soul = (package_files("mona") / "templates/SOUL.md").read_text(encoding="utf-8")
    assert soul in system and "# Tool Usage Notes" in system and "# Skills" in system
    assert str(tmp_path) not in system and "office_public" not in system
    assert "Active Office Document: User slides" in context.messages[-1]["content"]
    assert "office_public" in context.messages[-1]["content"]
    assert original == payload["history"] == [{"role": "user", "content": "Read the current slide."}]
    assert context.history_for_storage([*context.messages, {"role": "assistant", "content": "Done."}]) == [
        *original, {"role": "assistant", "content": "Done."},
    ]
    saved = next(value for kind, value in events if kind == "context")
    assert saved["source_history_length"] == 1 and saved["source_history_digest"] == history_fingerprint(original)
    assert not (tmp_path / "state").exists()


@pytest.mark.asyncio
async def test_real_memory_and_context_file_are_owned_and_parent_config_is_not_switched(tmp_path, monkeypatch):
    runtime = tmp_path / "state/users" / OWNER / "runtime"
    memory = runtime / "agents/mona/memory"
    memory.mkdir(parents=True)
    (memory / "SOUL.md").write_text("User-owned Mona persona.", encoding="utf-8")
    (memory / "MEMORY.md").write_text("This account likes short reports.", encoding="utf-8")
    active = runtime / "config.json"
    monkeypatch.setattr(loader, "_current_config_path", active)
    monkeypatch.setattr("mona.hosted_work.context.get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))
    monkeypatch.setattr(paths, "get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))
    monkeypatch.setattr("mona.session.manager.get_legacy_sessions_dir", lambda: pytest.fail("legacy migration is not hosted storage"))
    context, events, _, _, _ = await create(tmp_path, owner=OWNER)
    assert loader.get_config_path() == active
    assert context.memory.memory_dir.resolve().is_relative_to(runtime)
    assert "User-owned Mona persona." in context.messages[0]["content"]
    assert "This account likes short reports." in context.messages[0]["content"]
    path = runtime / "_consolidation" / (SID + ".json")
    assert json.loads(path.read_text(encoding="utf-8"))["owner"] == OWNER
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert next(value for kind, value in events if kind == "context")["state"]["session_id"] == SID


@pytest.mark.asyncio
async def test_owner_scope_mismatch_fails_before_reading_memory(tmp_path, monkeypatch):
    active = tmp_path / "different-user/config.json"
    monkeypatch.setattr(loader, "_current_config_path", active)
    monkeypatch.setattr("mona.hosted_work.context.MemoryStore", lambda *_a, **_k: pytest.fail("foreign memory"))
    with pytest.raises(WorkError) as caught:
        await create(tmp_path, owner=OWNER)
    assert caught.value.code == "runtime_scope" and loader.get_config_path() == active


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
async def test_linked_account_files_cannot_redirect_shared_memory(tmp_path, monkeypatch, kind):
    runtime = tmp_path / "state/users" / OWNER / "runtime"
    memory = runtime / "agents/mona/memory"
    memory.mkdir(parents=True)
    outside = tmp_path / "private-outside.md"
    outside.write_text("another account's file", encoding="utf-8")
    try:
        if kind == "symlink":
            (memory / "SOUL.md").symlink_to(outside)
        else:
            os.link(outside, memory / "SOUL.md")
    except OSError:
        pytest.skip("This platform does not permit the requested link")
    monkeypatch.setattr(loader, "_current_config_path", runtime / "config.json")
    with pytest.raises(WorkError) as caught:
        await create(tmp_path, owner=OWNER)
    assert caught.value.code == "invalid_state"
    assert outside.read_text(encoding="utf-8") == "another account's file"


@pytest.mark.asyncio
async def test_shared_consolidator_keeps_whole_turns_and_the_original_storage_log(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.hosted_work.context.model_context_window", lambda _selection: ResolvedContextWindow(16384, "catalog"))
    history = []
    for i in range(3):
        history.extend([{"role": "user", "content": (f"older-turn-{i} plain words " * 1000)},
                        {"role": "assistant", "content": "Completed that earlier turn."}])
    history.append({"role": "user", "content": "Continue the current task."})
    original = copy.deepcopy(history)
    context, events, provider, _, _ = await create(tmp_path, history=history)
    assert provider.requests and context.session.last_consolidated > 0
    assert context.session.messages == original == history
    assert context.session.metadata["_last_summary"]["text"] == "Earlier completed work and the user's goal."
    assert context.session.messages[context.session.last_consolidated]["role"] == "user"
    assert any(kind == "progress" and value.get("kind") == "context_compacting" and value["active"] for kind, value in events)
    assert "[Archived Context Summary]" in context.messages[-1]["content"]
    assert "Earlier completed work and the user's goal." not in context.messages[0]["content"]
    more = [{"role": "assistant", "content": "Done with the current task."}]
    assert context.history_for_storage([*context.messages, *more]) == [*original, *more]
    await context.persist_state([*context.messages, *more])
    envelope = events[-1][1]
    assert envelope["source_history_digest"] == history_fingerprint([*original, *more])


@pytest.mark.asyncio
async def test_failed_archive_retains_history_cursor_and_cross_turn_backoff(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.hosted_work.context.model_context_window", lambda _selection: ResolvedContextWindow(16384, "catalog"))
    history = []
    for i in range(3):
        history.extend([{"role": "user", "content": f"old-{i} words " * 2000}, {"role": "assistant", "content": "done"}])
    history.append({"role": "user", "content": "Next"})
    context, _, provider, _, _ = await create(tmp_path, history=history, failure=True)
    assert len(provider.requests) == 1
    assert context.session.last_consolidated == 0 and "_last_summary" not in context.session.metadata
    assert context.history_for_storage(context.messages) == history
    state = context.context_state
    assert state["compaction_retry"]["until"] > time.time()
    restored, _, second, _, _ = await create(tmp_path, history=history, context_state=state)
    assert second.requests == [] and restored.session.last_consolidated == 0
    assert "sensitive-provider-text" not in json.dumps(state)


@pytest.mark.asyncio
async def test_context_state_cannot_belong_to_another_session_or_changed_prefix(tmp_path):
    context, _, _, _, _ = await create(tmp_path)
    state = context.context_state
    state["session_id"] = "f" * 32
    with pytest.raises(WorkError) as caught:
        await create(tmp_path, context_state=state)
    assert caught.value.code == "context_conflict"
    state = context.context_state
    state["last_consolidated"] = 1
    state["history_prefix_digest"] = history_fingerprint([{"role": "user", "content": "changed"}])
    with pytest.raises(WorkError) as caught:
        await create(tmp_path, context_state=state)
    assert caught.value.code == "context_conflict"


@pytest.mark.asyncio
async def test_model_input_snapshot_keeps_prior_runtime_out_of_raw_history(tmp_path):
    first = {"role": "user", "content": "Read the current document.", "timestamp": "2026-11-05T08:00:00"}
    initial, _, _, _, _ = await create(tmp_path, history=[first], metadata={
        "office_session_id": "office_old", "office_document_type": "slides", "office_display_name": "Old document",
    })
    history = [first, {"role": "assistant", "content": "Read."},
               {"role": "user", "content": "Now read this one.", "timestamp": "2026-11-05T08:01:00"}]
    second, _, _, _, _ = await create(tmp_path, history=history, context_state=initial.context_state, metadata={
        "office_session_id": "office_new", "office_document_type": "slides", "office_display_name": "New document",
    })
    assert "office_old" in second.messages[1]["content"] and "office_new" not in second.messages[1]["content"]
    assert "office_new" in second.messages[-1]["content"]
    assert second.history_for_storage(second.messages) == history
    assert first["content"] == "Read the current document."


@pytest.mark.asyncio
async def test_summary_save_failure_does_not_advance_cursor_or_publish_context(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.hosted_work.context.model_context_window", lambda _selection: ResolvedContextWindow(16384, "catalog"))
    history = []
    for i in range(3):
        history.extend([{"role": "user", "content": f"old-{i} words " * 2000}, {"role": "assistant", "content": "done"}])
    history.append({"role": "user", "content": "Next"})
    config = HostedWorkConfig(models={"public": {"label": "Model", "model": "fixture-model", "max_output_tokens": 256}})
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    tools = HostedTools(SimpleNamespace(config=config), emit, config=config)
    runtime = HostedTurnContext(config, {"model_id": "public", "session_id": SID, "history": history}, tools, Provider(), emit)
    def failed_save():
        raise OSError("isolated persistence failure")
    monkeypatch.setattr(runtime, "_write_state", failed_save)
    with pytest.raises(OSError):
        await runtime.prepare()
    assert runtime.session.last_consolidated == 0 and "_last_summary" not in runtime.session.metadata
    assert runtime.session.messages == history
    assert not any(kind == "context" for kind, _ in events)
