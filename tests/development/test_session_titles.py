import pytest

from mona.development.contracts import ExecutorId
from mona.development.store import DevelopmentStore
from tests.development.test_native_workbench import settle
from tests.development.test_native_workbench import setup as setup_native
from tests.development.test_workbench_api import AUTH, setup_client
from tests.development.test_workbench_runtime import Model, make_runtime, wait_done


@pytest.mark.asyncio
async def test_first_message_names_mona_task_once_and_preserves_manual_title(tmp_path, monkeypatch):
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    try:
        await runtime.submit(session.id, "request_first", "  阅读交接文档，\n了解项目背景， 然后讨论工作。  ")
        await wait_done(runtime, session.id)
        expected = "阅读交接文档， 了解项目背景， 然后讨论工作。"
        named = runtime.store.get_session(session.id)
        assert named.title == runtime.snapshot(session.id)["session"]["title"] == expected
        assert named.title_source == "message"
        assert DevelopmentStore(runtime.store.path).get_session(session.id).title == expected
        await runtime.submit(session.id, "request_second", "第二轮追加的内容")
        await wait_done(runtime, session.id)
        assert runtime.snapshot(session.id)["session"]["title"] == expected
        named = runtime.store.get_session(session.id)
        manual = runtime.store.update_session(session.id, named.revision, title="新开发任务")
        assert manual.title_source == "manual"
        assert runtime.snapshot(session.id)["session"]["title"] == "新开发任务"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_existing_default_title_backfills_from_first_visible_input_in_list_and_header(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "内部注入内容", id="message_internal", _runtime_input=True)
    transcript.add_message("user", "附件解析正文不进入标题", id="message_first",
        _display_content="核对接口边界\n\n附件：需求.md", _input_source={"content": "核对接口边界"})
    transcript.add_message("user", "后续消息不作为标题", id="message_second")
    runtime.sessions.save(transcript)
    existing_time = session.updated_at
    custom = runtime.store.create_session(project.id, title="手动名称")
    readonly = runtime.store.create_session(project.id, readonly=True, parent_session_id=session.id)
    for value in (custom, readonly):
        history = runtime.sessions.get_or_create(value.transcript_key)
        history.add_message("user", "不改既有名称")
        runtime.sessions.save(history)
    try:
        response = await client.get(f"/api/development/projects/{project.id}/sessions", headers=AUTH)
        assert response.status == 200
        rows = {item["id"]: item for item in await response.json()}
        assert rows[session.id]["title"] == "核对接口边界"
        assert rows[custom.id]["title"] == "手动名称"
        assert rows[readonly.id]["title"] == "新开发任务"
        header = await (await client.get(f"/api/development/sessions/{session.id}/snapshot", headers=AUTH)).json()
        assert header["session"]["title"] == rows[session.id]["title"]
        assert runtime.store.get_session(session.id).updated_at == existing_time
        assert not runtime.tasks and runtime.store.list_runs(session.id) == []
        # The stored title stays bounded without cutting a Unicode character.
        long = runtime.store.create_session(project.id)
        history = runtime.sessions.get_or_create(long.transcript_key)
        history.add_message("user", "📝" * 201)
        runtime.sessions.save(history)
        assert runtime.snapshot(long.id)["session"]["title"] == "📝" * 199 + "…"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_native_first_input_names_task_without_rebuilding_binding(tmp_path):
    runtime, project, _, _ = await setup_native(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "request_first", "instant")
        await settle(runtime)
        assert runtime.store.get_session(session.id).title == "instant"
        binding = runtime.store.list_bindings(session.id)[0]
        await runtime.submit(session.id, "request_second", "instant")
        await settle(runtime)
        assert runtime.store.list_bindings(session.id)[0].id == binding.id
        assert runtime.snapshot(session.id)["session"]["title"] == "instant"
    finally:
        await runtime.close()
