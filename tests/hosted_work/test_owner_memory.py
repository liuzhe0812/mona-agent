"""Shared memory facades only see sources belonging to the hosted account."""
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.memory import MemoryStore
from mona.agent.tools.memory_tools import MemorySearchTool
from mona.agent.tools.unified_memory import ReadMemoryTool, SearchMemoryTool
from mona.config import loader, paths
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.owner_memory import build_memory_tools

SID = "a" * 32


def account(tmp_path, monkeypatch, number):
    owner = owner_key(number)
    runtime = tmp_path / "state" / "users" / owner / "runtime"
    directory = runtime / "agents" / "mona" / "memory"
    directory.mkdir(parents=True)
    monkeypatch.setattr(loader, "_current_config_path", runtime / "config.json")
    monkeypatch.setattr(paths, "get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))
    memory = MemoryStore(Path("/workspace"))
    context = SimpleNamespace(owner=owner, session_id=SID, _runtime=runtime, memory=memory,
                              config=HostedWorkConfig(state_dir=str(tmp_path / "state")))
    return context


async def search(tool, query, **kwargs):
    return json.loads(await tool.execute(query=query, **kwargs))


async def read(tool, ref, **kwargs):
    return json.loads(await tool.execute(ref=ref, **kwargs))


@pytest.mark.asyncio
async def test_memory_search_and_versioned_read_reuse_desktop_sources(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    memory = context.memory
    content = "用户喜欢桂花茶。" + "补" * 1500
    memory.write_memory(content)
    memory.write_soul("Mona 热爱探索。")
    memory.previous_file("memory").write_text("旧版", encoding="utf-8")
    memory.history_file.write_text(json.dumps({"timestamp": "2026-11-05 12:00", "role": "assistant",
        "cursor": 7, "content": "桂花茶讨论的归档摘要"}, ensure_ascii=False) + "\n", encoding="utf-8")

    tools = build_memory_tools(context)
    assert len(tools) == 2 and isinstance(tools[0], SearchMemoryTool) and isinstance(tools[1], ReadMemoryTool)
    found = await search(tools[0], "桂花茶")
    assert found["status"] == "ok" and set(found["sources"]) == {"memory"}
    assert found["results"][0]["kind"] == "summary"
    ref = found["results"][0]["ref"]
    page = await read(tools[1], ref, max_chars=1000)
    assert page["source"] == "memory" and page["content"] == content[:1000]
    assert page["truncated"] and page["next_cursor"]
    more = await read(tools[1], ref, max_chars=1000, cursor=page["next_cursor"])
    assert more["content"] == content[1000:] and not more["truncated"]
    source = tools[0]._registry.get("memory_read")
    receipt = await source.read_result("memory")
    assert receipt["filename"] == "MEMORY.md" and receipt["hasPrevious"] is True
    assert receipt["contentHash"] == hashlib.sha256(content.encode()).hexdigest() and receipt["updatedAt"]

    events = await search(tools[0], "桂花茶", sources=["events"])
    assert events["results"][0]["kind"] == "event_summary"
    event = await read(tools[1], events["results"][0]["ref"])
    assert event["kind"] == "event_summary" and event["event_cursor"] == 7
    assert "归档摘要" in event["content"]
    unavailable = await search(tools[0], "桂花茶", sources=["notes", "knowledge", "conversations"])
    assert unavailable["status"] == "unavailable" and not unavailable["results"]
    assert not any(tools[0]._registry.has(name) for name in ("memory_edit", "notes_search", "knowledge_search", "conversation_search"))

    memory.write_memory("记录已改变")
    stale = await read(tools[1], ref, max_chars=1000, cursor=page["next_cursor"])
    assert stale["status"] == "unavailable" and "stale" in stale["error"]


@pytest.mark.asyncio
async def test_owner_identity_and_active_runtime_cannot_cross_accounts(tmp_path, monkeypatch):
    first = account(tmp_path, monkeypatch, "71")
    first.memory.write_memory("甲账号私有记录：红茶")
    a_search, a_read = build_memory_tools(first)
    first_ref = (await search(a_search, "红茶"))["results"][0]["ref"]

    second = account(tmp_path, monkeypatch, "72")
    second.memory.write_memory("乙账号私有记录：绿茶")
    b_search, b_read = build_memory_tools(second)
    result = await search(a_search, "绿茶")
    assert result["status"] == "unavailable" and not result["results"]
    assert "乙账号" not in json.dumps(result, ensure_ascii=False)
    assert (await read(a_read, first_ref))["status"] == "unavailable"
    assert (await read(b_read, first_ref))["status"] == "unavailable"
    assert (await search(b_search, "绿茶"))["results"]

    wrong = SimpleNamespace(**vars(first))
    wrong.owner = second.owner
    with pytest.raises(WorkError) as error:
        build_memory_tools(wrong)
    assert error.value.code == "runtime_scope"


def test_ownerless_factory_never_touches_private_storage(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail("ownerless memory must not inspect private state")

    monkeypatch.setattr("mona.config.paths.get_agent_memory_dir", forbidden)
    monkeypatch.setattr("mona.config.paths.get_workspace_path", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    assert build_memory_tools(SimpleNamespace(owner=None, _runtime=None)) == ()
    with pytest.raises(WorkError):
        build_memory_tools(SimpleNamespace(owner=None, _runtime=Path("/workspace")))


@pytest.mark.asyncio
@pytest.mark.parametrize("link_type", ["symlink", "hardlink"])
async def test_changed_account_memory_link_is_rejected(tmp_path, monkeypatch, link_type):
    context = account(tmp_path, monkeypatch, "71")
    context.memory.write_memory("本账户内容")
    source = build_memory_tools(context)[0]._registry.get("memory_read")
    path = context.memory.memory_file
    path.unlink()
    other = tmp_path / "foreign.md"
    other.write_text("另一个账户的秘密", encoding="utf-8")
    try:
        if link_type == "symlink":
            path.symlink_to(other)
        else:
            os.link(other, path)
    except OSError:
        pytest.skip("This platform cannot create the required link")
    with pytest.raises(RuntimeError, match="Account memory is unavailable"):
        await source.read_result("memory")
    assert other.read_text(encoding="utf-8") == "另一个账户的秘密"


@pytest.mark.asyncio
async def test_shared_history_search_default_and_injected_path(tmp_path, monkeypatch):
    desktop, hosted = tmp_path / "desktop.jsonl", tmp_path / "hosted.jsonl"
    desktop.write_text('{"content":"desktop-only"}\n', encoding="utf-8")
    hosted.write_text('{"content":"hosted-only"}\n', encoding="utf-8")
    calls = []

    def desktop_path(agent):
        calls.append(agent)
        return desktop

    monkeypatch.setattr("mona.agent.tools.memory_tools._history_path", desktop_path)
    normal = MemorySearchTool("mona")
    assert (await normal.search_results("desktop-only", 5))[0]["content"] == "desktop-only"
    assert calls == ["mona"]
    pinned = MemorySearchTool("mona", history_path=hosted)
    result = await pinned.search_results("hosted-only", 5)
    assert result[0]["content"] == "hosted-only"
    assert (await pinned.read_result(result[0]["ref"]))["content"] == "hosted-only"
    assert calls == ["mona"]
