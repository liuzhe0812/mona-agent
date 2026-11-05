"""Hosted steering reuses the desktop controller without replaying a turn."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from mona.bus.queue import MessageBus
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.inputs import HostedInputs
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles
from mona.session.work_turns import WorkTurnController

OWNER, OTHER = owner_key("11"), owner_key("12")
SID, OTHER_SID = "a" * 32, "b" * 32
RID, NEXT_RID = "c" * 32, "d" * 32


@pytest_asyncio.fixture
async def scene(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    config = HostedWorkConfig(state_dir=str(state_dir), max_concurrent_runs=4,
        models={"official": {"label": "Mona", "model": "fixture"}})
    store = WorkStore(state_dir / "sessions.sqlite3", config)
    service = SimpleNamespace(config=config, store=store)
    state = DesktopStore(service, TenantFiles(config, authorize_session=lambda *_: None))
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="official", text="原任务"))
    emit = AsyncMock()
    inputs = HostedInputs(state, emit=emit)
    try:
        yield SimpleNamespace(config=config, store=store, state=state, inputs=inputs, emit=emit)
    finally:
        state.close()
        store.close()


@pytest.mark.asyncio
async def test_admission_is_idempotent_and_original_text_is_durable(scene):
    await scene.inputs.start(OWNER, SID, RID, task=None)
    runtime = scene.inputs._owner(OWNER)
    assert isinstance(runtime.bus, MessageBus) and isinstance(runtime.bus.work_turns, WorkTurnController)
    expected = {"chat_id": SID, "input_id": "guide-1", "turn_id": RID, "state": "accepted"}
    assert await scene.inputs.enqueue(OWNER, SID, RID, "guide-1", "请调整标题") == expected
    assert await scene.inputs.enqueue(OWNER, SID, RID, "guide-1", "请调整标题") == expected
    assert runtime.bus.inbound.qsize() == 1
    with pytest.raises(WorkError) as error:
        await scene.inputs.enqueue(OWNER, SID, RID, "guide-1", "内容被替换")
    assert error.value.code == "input_conflict"
    records = [record for record, _ in scene.state.records(OWNER, SID)]
    assert [record["text"] for record in records if record["event"] == "user"] == ["原任务", "请调整标题"]
    assert (await scene.inputs.snapshot(OWNER, SID)) == [expected]
    assert all(call.args[:2] == (OWNER, SID) for call in scene.emit.await_args_list)


@pytest.mark.asyncio
async def test_poll_and_ack_retries_keep_one_bounded_batch(scene):
    await scene.inputs.start(OWNER, SID, RID)
    for index in range(4):
        await scene.inputs.enqueue(OWNER, SID, RID, f"guide-{index}", f"追加 {index}")
    first = await scene.inputs.poll(OWNER, SID, RID, "poll-1", limit=99)
    assert [item["input_id"] for item in first["inputs"]] == ["guide-0", "guide-1", "guide-2"]
    assert await scene.inputs.poll(OWNER, SID, RID, "poll-1", limit=3) == first
    with pytest.raises(WorkError) as error:
        await scene.inputs.poll(OWNER, SID, RID, "poll-2")
    assert error.value.code == "input_batch_pending"
    consumed = await scene.inputs.acknowledge(OWNER, SID, RID, "poll-1")
    assert [item["state"] for item in consumed] == ["consumed"] * 3
    assert await scene.inputs.acknowledge(OWNER, SID, RID, "poll-1") == consumed
    assert await scene.inputs.poll(OWNER, SID, RID, "poll-1") == first
    second = await scene.inputs.poll(OWNER, SID, RID, "poll-2")
    assert second["inputs"] == [{"input_id": "guide-3", "content": "追加 3"}]
    assert [item["state"] for item in await scene.inputs.snapshot(OWNER, SID)] == ["consumed"] * 3 + ["accepted"]
    await scene.inputs.finish(OWNER, SID, RID)
    assert scene.state.get(OWNER, "work_inputs:" + SID)["batches"] == {}
    assert [item["state"] for item in await scene.inputs.snapshot(OWNER, SID)] == ["consumed"] * 3 + ["paused"]


@pytest.mark.asyncio
async def test_empty_poll_stays_empty_when_retried_after_new_input(scene):
    assert await scene.inputs.poll(OWNER, SID, RID, "empty") == {"request_id": "empty", "inputs": []}
    await scene.inputs.enqueue(OWNER, SID, RID, "guide", "后来发来")
    assert await scene.inputs.poll(OWNER, SID, RID, "empty") == {"request_id": "empty", "inputs": []}
    assert (await scene.inputs.poll(OWNER, SID, RID, "next"))["inputs"] == [{"input_id": "guide", "content": "后来发来"}]


@pytest.mark.asyncio
async def test_owner_isolation_and_conflicting_concurrent_sends(scene):
    scene.store.create_session(OTHER, NewSession(request_id=SID))
    scene.store.create_run(OTHER, SID, NewTurn(request_id=RID, model_id="official", text="另一个用户"))
    first, second = await asyncio.gather(
        scene.inputs.enqueue(OWNER, SID, RID, "same-id", "用户一"),
        scene.inputs.enqueue(OTHER, SID, RID, "same-id", "用户二"),
    )
    assert first["state"] == second["state"] == "accepted"
    assert (await scene.inputs.poll(OWNER, SID, RID, "poll"))["inputs"][0]["content"] == "用户一"
    assert (await scene.inputs.poll(OTHER, SID, RID, "poll"))["inputs"][0]["content"] == "用户二"
    scene.store.create_session(OTHER, NewSession(request_id=OTHER_SID))
    with pytest.raises(WorkError) as error:
        await scene.inputs.snapshot(OWNER, OTHER_SID)
    assert error.value.status == 404

    result = await asyncio.gather(
        scene.inputs.enqueue(OWNER, SID, RID, "racing-id", "先到"),
        scene.inputs.enqueue(OWNER, SID, RID, "racing-id", "不同内容"), return_exceptions=True)
    assert sum(isinstance(value, WorkError) for value in result) == 1
    assert len([record for record, _ in scene.state.records(OWNER, SID) if record.get("input_id") == "racing-id"]) == 1


@pytest.mark.asyncio
async def test_same_input_id_in_different_chats_does_not_discard_other_queue(scene):
    scene.store.create_session(OWNER, NewSession(request_id=OTHER_SID))
    scene.store.db.execute("UPDATE runs SET status='completed' WHERE owner=? AND id=?", (OWNER, RID))
    scene.store.create_run(OWNER, OTHER_SID, NewTurn(request_id=NEXT_RID, model_id="official", text="第二会话"))
    # Exercise the controller with two active sessions even though normal hosted
    # admission presently serializes one account's model runs.
    scene.store.db.execute("UPDATE runs SET status='running' WHERE owner=? AND id=?", (OWNER, RID))
    await scene.inputs.enqueue(OWNER, SID, RID, "same", "第一会话")
    await scene.inputs.enqueue(OWNER, OTHER_SID, NEXT_RID, "same", "第二会话")
    assert (await scene.inputs.poll(OWNER, SID, RID, "poll-a"))["inputs"][0]["content"] == "第一会话"
    assert (await scene.inputs.poll(OWNER, OTHER_SID, NEXT_RID, "poll-b"))["inputs"][0]["content"] == "第二会话"


@pytest.mark.asyncio
async def test_stop_pauses_unacknowledged_inputs_and_requires_explicit_resume(scene):
    await scene.inputs.enqueue(OWNER, SID, RID, "guide", "保留原文")
    assert (await scene.inputs.poll(OWNER, SID, RID, "poll-old"))["inputs"]
    assert (await scene.inputs.pause(OWNER, SID, RID))[0]["state"] == "paused"
    with pytest.raises(WorkError):
        await scene.inputs.acknowledge(OWNER, SID, RID, "poll-old")
    with pytest.raises(WorkError):
        await scene.inputs.enqueue(OWNER, SID, RID, "new-id", "停止后不能加入")
    await scene.inputs.finish(OWNER, SID, RID)
    scene.store.finish(OWNER, RID, "cancelled", {"message": "已停止"})
    scene.store.create_run(OWNER, SID, NewTurn(request_id=NEXT_RID, model_id="official", text="新轮次"))
    with pytest.raises(WorkError):
        await scene.inputs.enqueue(OWNER, SID, NEXT_RID, "guide", "保留原文")
    resumed = await scene.inputs.enqueue(OWNER, SID, NEXT_RID, "guide", "保留原文", resume=True)
    assert resumed == {"chat_id": SID, "input_id": "guide", "turn_id": NEXT_RID, "state": "accepted"}
    batch = await scene.inputs.poll(OWNER, SID, NEXT_RID, "poll-new")
    assert batch["inputs"] == [{"input_id": "guide", "content": "保留原文"}]
    assert (await scene.inputs.acknowledge(OWNER, SID, NEXT_RID, "poll-new"))[0]["state"] == "consumed"
    assert len([record for record, _ in scene.state.records(OWNER, SID) if record.get("input_id") == "guide"]) == 1


@pytest.mark.asyncio
async def test_recovery_marks_unknown_run_inputs_paused_without_replaying(scene):
    await scene.inputs.enqueue(OWNER, SID, RID, "guide", "恢复证据")
    await scene.inputs.poll(OWNER, SID, RID, "lost-response")
    assert scene.store.recover() == 1
    replacement = HostedInputs(scene.state)
    with pytest.raises(WorkError):
        await replacement.poll(OWNER, SID, RID, "lost-response")
    state = await replacement.snapshot(OWNER, SID)
    assert state == [{"chat_id": SID, "input_id": "guide", "turn_id": RID, "state": "paused"}]
    assert replacement._owner(OWNER).bus.inbound.empty()
    assert any(record.get("text") == "恢复证据" for record, _ in scene.state.records(OWNER, SID))


@pytest.mark.asyncio
async def test_duplicate_bus_delivery_is_not_dispatched_twice(scene):
    await scene.inputs.enqueue(OWNER, SID, RID, "guide", "只处理一次")
    runtime = scene.inputs._owner(OWNER)
    duplicate = runtime.bus.inbound._queue[0]
    runtime.bus.inbound.put_nowait(duplicate)
    batch = await scene.inputs.poll(OWNER, SID, RID, "poll")
    assert batch["inputs"] == [{"input_id": "guide", "content": "只处理一次"}]
    await scene.inputs.acknowledge(OWNER, SID, RID, "poll")
    assert (await scene.inputs.poll(OWNER, SID, RID, "next"))["inputs"] == []


@pytest.mark.asyncio
async def test_cancelled_admission_finishes_publishing_once(scene, monkeypatch):
    runtime = scene.inputs._owner(OWNER)
    original = runtime.bus.publish_inbound
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_publish(message):
        entered.set()
        await release.wait()
        return await original(message)

    monkeypatch.setattr(runtime.bus, "publish_inbound", slow_publish)
    task = asyncio.create_task(scene.inputs.enqueue(OWNER, SID, RID, "guide", "消息不能丢"))
    await entered.wait()
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await scene.inputs.snapshot(OWNER, SID))[0]["state"] == "accepted"
    assert (await scene.inputs.poll(OWNER, SID, RID, "retry"))["inputs"] == [{"input_id": "guide", "content": "消息不能丢"}]
    assert runtime.bus.inbound.empty()


@pytest.mark.asyncio
async def test_store_failure_rolls_back_original_input_and_allows_retry(scene, monkeypatch):
    original = scene.state.set
    failed = False

    def fail_once(owner, key, value):
        nonlocal failed
        if key.startswith("work_inputs:") and not failed:
            failed = True
            raise OSError("fixture failure")
        return original(owner, key, value)

    monkeypatch.setattr(scene.state, "set", fail_once)
    with pytest.raises(OSError):
        await scene.inputs.enqueue(OWNER, SID, RID, "guide", "只保存一次")
    assert not any(record.get("input_id") == "guide" for record, _ in scene.state.records(OWNER, SID))
    assert (await scene.inputs.enqueue(OWNER, SID, RID, "guide", "只保存一次"))["state"] == "accepted"
    assert len([record for record, _ in scene.state.records(OWNER, SID) if record.get("input_id") == "guide"]) == 1


@pytest.mark.asyncio
async def test_attachment_only_input_and_metadata_are_idempotent_and_durable(scene):
    attachment = {"path": "/workspace/uploads/" + "1" * 32 + "/plan.txt", "name": "plan.txt",
                  "size": 3, "sha256": "a" * 64}
    metadata = {"ui_theme": "dark", "task_id": "task-1", "display_content": "文件说明",
                "quote": {"author": "Mona", "content": "引用"}}
    result = await scene.inputs.enqueue(OWNER, SID, RID, "attachment", "", attachments=[attachment], metadata=metadata)
    assert result["state"] == "accepted"
    assert await scene.inputs.enqueue(OWNER, SID, RID, "attachment", "", attachments=[attachment], metadata=metadata) == result
    batch = await scene.inputs.poll(OWNER, SID, RID, "poll-attachment")
    assert batch["inputs"] == [{"input_id": "attachment", "content": "", "attachments": [attachment], "metadata": metadata}]
    records = [record for record, _ in scene.state.records(OWNER, SID)]
    record = next(record for record in records if record.get("input_id") == "attachment")
    assert record["media_paths"] == [attachment["path"]] and record["quote"] == metadata["quote"]
    assert record["task_id"] == "task-1" and record["display_content"] == "文件说明"
    with pytest.raises(WorkError) as error:
        await scene.inputs.enqueue(OWNER, SID, RID, "attachment", "", attachments=[{**attachment, "sha256": "b" * 64}], metadata=metadata)
    assert error.value.code == "input_conflict"
    with pytest.raises(WorkError) as error:
        await scene.inputs.enqueue(OWNER, SID, RID, "attachment", "", attachments=[attachment], metadata={**metadata, "ui_theme": "light"})
    assert error.value.code == "input_conflict"
