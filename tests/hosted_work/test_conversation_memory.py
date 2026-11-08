"""Hosted conversation memory reuses desktop search without crossing accounts."""
import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.memory import MemoryStore
from mona.config import loader, paths
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, owner_key
from mona.hosted_work.owner_memory import build_memory_tools
from mona.hosted_work.store import WorkStore

SID = "a" * 32
OTHER_SID = "b" * 32
RUN = "c" * 32


def account(tmp_path, monkeypatch, account_id):
    owner = owner_key(account_id)
    state = tmp_path / "state"
    runtime = state / "users" / owner / "runtime"
    (runtime / "agents" / "mona" / "memory").mkdir(parents=True)
    monkeypatch.setattr(loader, "_current_config_path", runtime / "config.json")
    monkeypatch.setattr(paths, "get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))
    config = HostedWorkConfig(state_dir=str(state))
    context = SimpleNamespace(owner=owner, session_id=SID, _runtime=runtime,
                              memory=MemoryStore(Path("/workspace")), config=config, payload={"run_id": RUN})
    return context


def transcript(context, rows):
    path = context._runtime.parent / "desktop.sqlite3"
    db = sqlite3.connect(path)
    db.executescript("""CREATE TABLE transcript(chat_id TEXT,seq INTEGER,event_key TEXT,data TEXT,created REAL,
                      PRIMARY KEY(chat_id,seq)); CREATE TABLE deleted_chats(chat_id TEXT PRIMARY KEY);""")
    db.executemany("INSERT INTO transcript VALUES(?,?,?,?,?)", [
        (sid, seq, f"event:{sid}:{seq}", data if isinstance(data, str) else json.dumps(data, ensure_ascii=False), created)
        for sid, seq, data, created in rows
    ])
    db.commit()
    db.close()
    return path


async def search(tool, query, **kwargs):
    return json.loads(await tool.execute(query=query, sources=["conversations"], **kwargs))


async def read(tool, ref, **kwargs):
    return json.loads(await tool.execute(ref=ref, **kwargs))


@pytest.mark.asyncio
async def test_desktop_projection_pagination_and_deleted_reference(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        for sid, title in ((SID, "当前"), (OTHER_SID, "旧会话")):
            store.create_session(context.owner, NewSession(request_id=sid, title=title))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="正在提问"))
        database = transcript(context, [
            (OTHER_SID, 1, {"event": "user", "text": "项目代号是桂花茶。"}, 100.0),
            (OTHER_SID, 2, {"event": "delta", "text": "记住"}, 101.0),
            (OTHER_SID, 3, {"event": "delta", "text": "桂花茶。"}, 102.0),
            (OTHER_SID, 4, {"event": "stream_end"}, 103.0),
            (OTHER_SID, 5, {"event": "message", "kind": "progress", "text": "不可搜索的工具轨迹"}, 104.0),
            (SID, 1, {"event": "user", "text": "桂花茶后来怎么样？"}, 105.0),
        ])
        search_tool, read_tool = build_memory_tools(context, include_conversations=True)
        result = await search(search_tool, "桂花茶", session_key="websocket:" + OTHER_SID, limit=1)
        assert result["status"] == "ok" and len(result["results"]) == 1
        cursor = result["sources"]["conversations"]["next_cursor"]
        second = await search(search_tool, "桂花茶", session_key="websocket:" + OTHER_SID, limit=1, cursor=cursor)
        assert second["results"] and second["results"][0]["ref"] != result["results"][0]["ref"]
        page = await read(read_tool, result["results"][0]["ref"])
        assert page["status"] == "ok" and "项目代号是桂花茶" in page["text"] and "记住桂花茶" in page["text"]
        assert not (await search(search_tool, "不可搜索的工具轨迹"))["results"]

        store.db.execute("DELETE FROM sessions WHERE owner=? AND id=?", (context.owner, OTHER_SID))
        with sqlite3.connect(database) as db:
            db.execute("INSERT INTO deleted_chats VALUES(?)", (OTHER_SID,))
            db.execute("DELETE FROM transcript WHERE chat_id=?", (OTHER_SID,))
        stale = await read(read_tool, result["results"][0]["ref"])
        assert stale["status"] == "stale_reference"
        assert not (await search(search_tool, "项目代号"))["results"]
    finally:
        store.close()


@pytest.mark.asyncio
async def test_account_scope_never_reads_another_owner_or_a_link(tmp_path, monkeypatch):
    first = account(tmp_path, monkeypatch, "71")
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", first.config)
    try:
        store.create_session(first.owner, NewSession(request_id=SID, title="甲"))
        store.create_run(first.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="甲"))
        first_db = transcript(first, [(SID, 1, {"event": "user", "text": "甲的紫藤花"}, 1.0)])
        first_search, first_read = build_memory_tools(first, include_conversations=True)
        ref = (await search(first_search, "紫藤花"))["results"][0]["ref"]

        second = account(tmp_path, monkeypatch, "72")
        store.create_session(second.owner, NewSession(request_id=SID, title="乙"))
        store.create_run(second.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="乙"))
        second_db = transcript(second, [(SID, 1, {"event": "user", "text": "乙的玫瑰花"}, 1.0)])
        second_search, second_read = build_memory_tools(second, include_conversations=True)
        assert not (await search(second_search, "紫藤花"))["results"]
        assert (await read(second_read, ref))["status"] == "unavailable"
        assert (await search(second_search, "玫瑰花"))["results"]

        monkeypatch.setattr(loader, "_current_config_path", first._runtime / "config.json")
        assert not (await search(first_search, "玫瑰花"))["results"]
        first_db.unlink()
        try:
            os.link(second_db, first_db)
        except OSError:
            pytest.skip("hard links unavailable")
        blocked = await search(first_search, "玫瑰花")
        assert blocked["status"] == "unavailable" and not blocked["results"]
    finally:
        store.close()


@pytest.mark.asyncio
async def test_missing_transcript_reports_partial_and_subagents_do_not_gain_history(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        core, _ = build_memory_tools(context, include_conversations=True)
        subagent, _ = build_memory_tools(context)
        assert not subagent._registry.has("conversation_search")
        result = await search(core, "测试")
        assert result["status"] == "partial" and result["sources"]["conversations"]["coverage"]["missing_sessions"] == 1
    finally:
        store.close()


@pytest.mark.asyncio
async def test_read_pages_and_a_session_deleted_during_read_is_stale(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        for sid in (SID, OTHER_SID):
            store.create_session(context.owner, NewSession(request_id=sid, title="会话"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        text = "月桂花" + "文字" * 1400
        transcript(context, [(SID, 1, {"event": "user", "text": "当前"}, 1.0),
                             (OTHER_SID, 1, {"event": "user", "text": text}, 2.0)])
        search_tool, read_tool = build_memory_tools(context, include_conversations=True)
        ref = (await search(search_tool, "月桂花"))["results"][0]["ref"]
        first = await read(read_tool, ref, max_chars=1000, before=0, after=0)
        second = await read(read_tool, ref, max_chars=1000, before=0, after=0, cursor=first["next_cursor"])
        assert first["truncated"] and second["status"] == "ok" and first["text"] != second["text"]

        source = search_tool._registry.get("conversation_read")._store
        original = source._read_records
        calls = []
        def delete_during_read(path):
            records = original(path)
            calls.append(1)
            if len(calls) == 2:
                with sqlite3.connect(tmp_path / "state" / "sessions.sqlite3") as db:
                    db.execute("DELETE FROM sessions WHERE owner=? AND id=?", (context.owner, OTHER_SID))
            return records
        monkeypatch.setattr(source, "_read_records", delete_during_read)
        result = await read(read_tool, ref, before=0, after=0)
        assert len(calls) == 2 and result["status"] == "stale_reference" and "text" not in result
    finally:
        store.close()


@pytest.mark.asyncio
async def test_search_reports_partial_when_transcript_expansion_is_bounded(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        transcript(context, [(SID, 1, {"event": "message", "kind": "progress", "text": "不纳入正文" * 300}, 0.0),
                             (SID, 2, {"event": "user", "text": "月桂花"}, 1.0),
                             (SID, 3, {"event": "message", "text": "后续正文" * 100000}, 2.0)])
        tool, _ = build_memory_tools(context, include_conversations=True)
        result = await search(tool, "月桂花")
        assert result["status"] == "partial" and result["results"]
        assert result["sources"]["conversations"]["coverage"]["partial_sessions"] == 1
    finally:
        store.close()


@pytest.mark.asyncio
async def test_total_scan_budget_is_shared_and_target_read_has_own_budget(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        for sid in (SID, OTHER_SID):
            store.create_session(context.owner, NewSession(request_id=sid, title="会话"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        store.db.execute("UPDATE sessions SET updated=2 WHERE owner=? AND id=?", (context.owner, SID))
        store.db.execute("UPDATE sessions SET updated=1 WHERE owner=? AND id=?", (context.owner, OTHER_SID))
        transcript(context, [(SID, 1, {"event": "user", "text": "当前"}, 1.0),
                             (SID, 2, {"event": "message", "kind": "progress", "text": "a" * 600000}, 2.0),
                             (SID, 3, {"event": "message", "kind": "progress", "text": "b" * 600000}, 3.0),
                             (OTHER_SID, 1, {"event": "user", "text": "只有目标会话有石榴茶"}, 4.0)])
        search_tool, read_tool = build_memory_tools(context, include_conversations=True)
        target = await search(search_tool, "石榴茶", session_key="websocket:" + OTHER_SID)
        ref = target["results"][0]["ref"]
        from mona.hosted_work.conversation_memory import _ScanBudget

        charged = []
        original = _ScanBudget.charge
        def observe_charge(budget, size):
            before = budget.remaining
            accepted = original(budget, size)
            charged.append(before - budget.remaining)
            return accepted
        monkeypatch.setattr(_ScanBudget, "charge", observe_charge)
        result = await search(search_tool, "石榴茶", alternatives=["石榴", "果茶"])
        coverage = result["sources"]["conversations"]["coverage"]
        assert result["status"] == "partial" and coverage["budget_exceeded"]
        assert 600000 <= coverage["scanned_bytes"] <= context.config.history_media_expand_bytes
        assert sum(charged) <= context.config.history_media_expand_bytes
        assert not result["results"]
        restored = await read(read_tool, ref)
        assert restored["status"] == "ok" and "只有目标会话有石榴茶" in restored["text"]
    finally:
        store.close()


@pytest.mark.asyncio
async def test_read_reuses_bounded_projection_without_scanning_target_twice(tmp_path, monkeypatch):
    from mona.hosted_work.conversation_memory import _Transcript

    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        transcript(context, [(SID, 1, {"event": "user", "text": "开头"}, 1.0),
                             (SID, 2, {"event": "message", "kind": "progress", "text": "a" * 650000}, 2.0),
                             (SID, 3, {"event": "user", "text": "目标消息是月桂花"}, 3.0)])
        search_tool, read_tool = build_memory_tools(context, include_conversations=True)
        ref = (await search(search_tool, "月桂花"))["results"][0]["ref"]
        scans = []
        original_rows = _Transcript._rows
        def track_rows(path, db):
            scans.append(path.sid)
            return original_rows(path, db)
        monkeypatch.setattr(_Transcript, "_rows", track_rows)
        result = await read(read_tool, ref, before=0, after=0)
        assert result["status"] == "ok" and "目标消息是月桂花" in result["text"]
        assert scans == [SID]
        assert 650000 <= result["coverage"]["scanned_bytes"] <= context.config.history_media_expand_bytes
    finally:
        store.close()


@pytest.mark.asyncio
async def test_second_scan_exhaustion_returns_partial_instead_of_stale(tmp_path, monkeypatch):
    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        transcript(context, [(SID, 1, {"event": "user", "text": "开头"}, 1.0),
                             (SID, 2, {"event": "message", "kind": "progress", "text": "a" * 650000}, 2.0),
                             (SID, 3, {"event": "user", "text": "目标消息是月桂花"}, 3.0)])
        search_tool, read_tool = build_memory_tools(context, include_conversations=True)
        ref = (await search(search_tool, "月桂花"))["results"][0]["ref"]
        backend = search_tool._registry.get("conversation_read")._store
        original_read = backend._read_records
        calls = []
        def bypass_cache_once(path):
            calls.append(1)
            if len(calls) != 2:
                return original_read(path)
            operation = backend._local.operation
            cache = operation.read_cache
            operation.read_cache = None
            try:
                return original_read(path)
            finally:
                operation.read_cache = cache
        monkeypatch.setattr(backend, "_read_records", bypass_cache_once)
        result = await read(read_tool, ref, before=0, after=0)
        assert len(calls) == 2 and result["status"] == "partial" and "text" not in result
        assert result["coverage"]["budget_exceeded"]
        assert result["coverage"]["scanned_bytes"] <= context.config.history_media_expand_bytes
    finally:
        store.close()


@pytest.mark.asyncio
async def test_each_search_uses_bounded_memory_index_without_disk_residue(tmp_path, monkeypatch):
    import asyncio
    from contextlib import closing

    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        transcript(context, [(SID, 1, {"event": "user", "text": "桂花茶和茉莉花茶"}, 1.0)])
        tool, _ = build_memory_tools(context, include_conversations=True)
        backend = tool._registry.get("conversation_search")._store
        with backend._operation(target=None):
            first_uri = backend._local.operation.uri
            with closing(sqlite3.connect(first_uri, uri=True)) as other:
                pages = other.execute("PRAGMA max_page_count").fetchone()[0]
                page_size = other.execute("PRAGMA page_size").fetchone()[0]
                assert pages * page_size <= context.config.history_media_expand_bytes
                assert other.execute("PRAGMA database_list").fetchone()[2] == ""
                other.execute("CREATE TABLE shared_marker(value INTEGER)")
        with closing(sqlite3.connect(first_uri, uri=True)) as reopened:
            assert reopened.execute("SELECT 1 FROM sqlite_master WHERE name='shared_marker'").fetchone() is None
        with backend._operation(target=None):
            assert backend._local.operation.uri != first_uri
            assert backend._local.operation.anchor.execute(
                "SELECT 1 FROM sqlite_master WHERE name='shared_marker'").fetchone() is None

        first, second = await asyncio.gather(search(tool, "桂花茶"), search(tool, "茉莉花茶"))
        assert first["results"] and second["results"]
        assert not list(context._runtime.rglob("*conversation-index*"))
        assert not list(context._runtime.rglob("*.sqlite3"))
    finally:
        store.close()


@pytest.mark.asyncio
async def test_fts_page_limit_reports_partial_instead_of_claiming_no_matches(tmp_path, monkeypatch):
    import random
    import string

    context = account(tmp_path, monkeypatch, "71")
    context.config.history_media_expand_bytes = 1024 * 1024
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        rng = random.Random(71)
        large = "needle " + "".join(rng.choices(string.ascii_letters + string.digits, k=350000))
        transcript(context, [(SID, 1, {"event": "user", "text": large}, 1.0)])
        tool, _ = build_memory_tools(context, include_conversations=True)
        result = await search(tool, "needle")
        coverage = result["sources"]["conversations"]["coverage"]
        assert result["status"] == "partial" and coverage["budget_exceeded"]
        assert coverage["scanned_bytes"] <= context.config.history_media_expand_bytes
        assert not list(context._runtime.rglob("*conversation-index*"))
    finally:
        store.close()


@pytest.mark.asyncio
async def test_cancellation_stops_worker_and_closes_memory_index(tmp_path, monkeypatch):
    import asyncio
    import threading
    from contextlib import closing

    from mona.hosted_work.conversation_memory import _CANCEL_SIGNAL

    context = account(tmp_path, monkeypatch, "71")
    store = WorkStore(tmp_path / "state" / "sessions.sqlite3", context.config)
    try:
        store.create_session(context.owner, NewSession(request_id=SID, title="当前"))
        store.create_run(context.owner, SID, NewTurn(request_id=RUN, model_id="qwen", text="当前"))
        transcript(context, [(SID, 1, {"event": "user", "text": "桂花茶"}, 1.0)])
        tool, _ = build_memory_tools(context, include_conversations=True)
        backend = tool._registry.get("conversation_search")._store
        entered, finished = threading.Event(), threading.Event()
        uris = []
        original_read, original_search = backend._read_records, backend.search

        def wait_for_cancel(path):
            uris.append(backend._local.operation.uri)
            entered.set()
            signal = _CANCEL_SIGNAL.get()
            assert signal is not None and signal.wait(timeout=3)
            return original_read(path)

        def track_search(*args, **kwargs):
            try:
                return original_search(*args, **kwargs)
            finally:
                finished.set()

        monkeypatch.setattr(backend, "_read_records", wait_for_cancel)
        monkeypatch.setattr(backend, "search", track_search)
        task = asyncio.create_task(search(tool, "桂花茶"))
        assert await asyncio.to_thread(entered.wait, 3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert await asyncio.to_thread(finished.wait, 3)
        with closing(sqlite3.connect(uris[0], uri=True)) as reopened:
            assert reopened.execute("SELECT 1 FROM sqlite_master WHERE name='messages'").fetchone() is None
        assert not list(context._runtime.rglob("*conversation-index*"))
    finally:
        store.close()
