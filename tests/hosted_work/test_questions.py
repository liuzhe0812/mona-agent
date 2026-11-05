"""The hosted broker uses desktop question semantics within one account and run."""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from mona.bus.user_questions import UserQuestions
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.questions import HostedQuestions
from mona.hosted_work.store import WorkStore

ALICE, BOB = owner_key("11"), owner_key("22")
SID, OTHER_SID, RID = "a" * 32, "b" * 32, "c" * 32
QUESTION = [{"id": "style", "question": "请选择风格", "options": [
    {"label": "商务", "description": "适合汇报"}, {"label": "杂志"},
]}]
ANSWER = [{"id": "style", "selected": ["商务"]}]


@pytest_asyncio.fixture
async def broker(tmp_path):
    config = HostedWorkConfig(models={"qwen": {"label": "Qwen", "model": "fixture-model"}})
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(ALICE, NewSession(request_id=SID))
    store.create_session(ALICE, NewSession(request_id=OTHER_SID))
    store.create_session(BOB, NewSession(request_id=SID))
    store.create_run(ALICE, SID, NewTurn(request_id=RID, model_id="qwen", text="fixture"))
    published = asyncio.Queue()

    async def emit(owner, sid, value):
        await published.put((owner, sid, value))

    questions = HostedQuestions(store, emit)
    try:
        yield questions, store, published
    finally:
        await questions.close()
        store.close()


async def pending(broker, *, ask_id="ask-1", questions=QUESTION):
    coordinator, _, published = broker
    task = asyncio.create_task(coordinator.ask(ALICE, SID, RID, ask_id, questions))
    owner, sid, frame = await asyncio.wait_for(published.get(), 2)
    assert owner == ALICE and sid == SID and frame["event"] == "user_questions"
    assert frame["chat_id"] == SID and len(frame["requests"]) == 1
    return task, frame["requests"][0]


@pytest.mark.asyncio
async def test_shared_questions_publish_snapshot_and_return_validated_answer(broker):
    coordinator, _, published = broker
    assert isinstance(coordinator.questions, UserQuestions)
    task, request = await pending(broker)
    assert coordinator.snapshot(ALICE, SID) == [request]
    assert request["agent_id"] == "mona" and request["questions"][0]["options"] == QUESTION[0]["options"]
    with pytest.raises(WorkError) as invalid:
        coordinator.answer(ALICE, SID, request["request_id"],
                           [{"id": "style", "selected": ["不存在的选项"]}], attached=True)
    assert invalid.value.code == "invalid_answer" and not task.done()
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    assert await task == {"answers": ANSWER}
    _, _, cleared = await asyncio.wait_for(published.get(), 2)
    assert cleared["requests"] == [] and coordinator.snapshot(ALICE, SID) == []


@pytest.mark.asyncio
async def test_answer_requires_same_owner_session_and_attached_peer(broker):
    coordinator, _, _ = broker
    task, request = await pending(broker)
    for owner, sid, attached in ((BOB, SID, True), (ALICE, OTHER_SID, True), (ALICE, SID, False)):
        with pytest.raises(WorkError) as denied:
            coordinator.answer(owner, sid, request["request_id"], ANSWER, attached=attached)
        assert denied.value.status == 404
    with pytest.raises(WorkError) as cross_session:
        await coordinator.ask(ALICE, OTHER_SID, RID, "wrong-session", QUESTION)
    assert cross_session.value.status == 404 and not task.done()
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    assert (await task)["answers"] == ANSWER


@pytest.mark.asyncio
async def test_identical_ask_is_shared_and_changed_content_is_rejected(broker):
    coordinator, _, published = broker
    first, request = await pending(broker)
    equivalent = [{"options": QUESTION[0]["options"], "question": "请选择风格", "id": "style"}]
    second = asyncio.create_task(coordinator.ask(ALICE, SID, RID, "ask-1", equivalent))
    await asyncio.sleep(0)
    assert published.empty() and coordinator.snapshot(ALICE, SID) == [request]
    with pytest.raises(WorkError) as conflict:
        await coordinator.ask(ALICE, SID, RID, "ask-1", [{**QUESTION[0], "question": "更改后的问题"}])
    assert conflict.value.code == "question_conflict" and conflict.value.status == 409
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    assert await first == await second == {"answers": ANSWER}
    assert await coordinator.ask(ALICE, SID, RID, "ask-1", equivalent) == {"answers": ANSWER}
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    with pytest.raises(WorkError) as changed_answer:
        coordinator.answer(ALICE, SID, request["request_id"],
                           [{"id": "style", "selected": ["杂志"]}], attached=True)
    assert changed_answer.value.code == "question_conflict"


@pytest.mark.asyncio
async def test_disconnected_waiter_can_reobserve_original_question_without_reasking(broker):
    coordinator, _, published = broker
    first, request = await pending(broker)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert coordinator.snapshot(ALICE, SID) == [request]
    second = asyncio.create_task(coordinator.ask(ALICE, SID, RID, "ask-1", QUESTION))
    await asyncio.sleep(0)
    assert published.empty() and coordinator.snapshot(ALICE, SID) == [request]
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    assert (await second)["answers"] == ANSWER


@pytest.mark.asyncio
@pytest.mark.parametrize("finished", [False, True], ids=["stopping", "expired"])
async def test_stopped_or_expired_run_cancels_pending_question_without_selecting(broker, finished):
    coordinator, store, published = broker
    task, request = await pending(broker)
    if finished:
        store.finish(ALICE, RID, "failed", {"message": "timeout"})
    else:
        store.cancelling(ALICE, RID)
    await coordinator.cancel_run(ALICE, SID, RID)
    with pytest.raises(asyncio.CancelledError):
        await task
    _, _, cleared = await asyncio.wait_for(published.get(), 2)
    assert cleared["requests"] == [] and coordinator.snapshot(ALICE, SID) == []
    with pytest.raises(WorkError):
        coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    with pytest.raises(WorkError) as stopped:
        await coordinator.ask(ALICE, SID, RID, "ask-1", QUESTION)
    assert stopped.value.code == "execution_stopped"


@pytest.mark.asyncio
async def test_stop_after_an_answer_does_not_resume_the_stopped_run(broker):
    coordinator, store, _ = broker
    task, request = await pending(broker)
    coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    store.cancelling(ALICE, RID)
    with pytest.raises(WorkError) as stopped:
        await task
    assert stopped.value.code == "execution_stopped"
    await coordinator.cancel_run(ALICE, SID, RID)
    assert coordinator.snapshot(ALICE, SID) == []


@pytest.mark.asyncio
async def test_cancel_before_run_state_update_blocks_any_new_question(broker):
    coordinator, store, _ = broker
    task, request = await pending(broker)
    await coordinator.cancel_run(ALICE, SID, RID)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert coordinator.snapshot(ALICE, SID) == []
    with pytest.raises(WorkError) as stopped:
        await coordinator.ask(ALICE, SID, RID, "different-ask-id", QUESTION)
    assert stopped.value.code == "execution_stopped"
    with pytest.raises(WorkError):
        coordinator.answer(ALICE, SID, request["request_id"], ANSWER, attached=True)
    store.cancelling(ALICE, RID)
    await coordinator.cancel_run(ALICE, SID, RID)


@pytest.mark.asyncio
async def test_concurrent_cancellations_do_not_interrupt_the_clear_notification(broker):
    coordinator, store, published = broker
    task, _ = await pending(broker)
    clearing, release = asyncio.Event(), asyncio.Event()
    emit = coordinator.emit

    async def delay_clear(owner, sid, frame):
        if not frame["requests"]:
            clearing.set()
            await release.wait()
        await emit(owner, sid, frame)

    coordinator.emit = delay_clear
    store.cancelling(ALICE, RID)
    first = asyncio.create_task(coordinator.cancel_run(ALICE, SID, RID))
    await asyncio.wait_for(clearing.wait(), 2)
    second = asyncio.create_task(coordinator.cancel_run(ALICE, SID, RID))
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)
    with pytest.raises(asyncio.CancelledError):
        await task
    _, _, cleared = await asyncio.wait_for(published.get(), 2)
    assert cleared["requests"] == []


@pytest.mark.asyncio
async def test_explicit_question_cancel_is_not_an_answer_or_a_reask(broker):
    coordinator, _, _ = broker
    task, request = await pending(broker)
    coordinator.answer(ALICE, SID, request["request_id"], None, attached=True)
    assert await task == {"cancelled": True, "answers": []}
    assert await coordinator.ask(ALICE, SID, RID, "ask-1", QUESTION) == {"cancelled": True, "answers": []}


@pytest.mark.asyncio
async def test_multiple_choices_and_custom_answer_reuse_desktop_validation(broker):
    coordinator, _, _ = broker
    questions = [{**QUESTION[0], "multi_select": True}, {"id": "audience", "question": "给谁看？"}]
    task, request = await pending(broker, questions=questions)
    answers = [{"id": "style", "selected": ["商务", "杂志"]},
               {"id": "audience", "selected": [], "custom": "团队成员"}]
    coordinator.answer(ALICE, SID, request["request_id"], answers, attached=True)
    assert (await task)["answers"] == answers


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [[], [{"id": "", "question": "?"}],
    [{"id": "x", "question": "?", "options": [{"label": "a"}, {"label": "a"}]}]])
async def test_invalid_questions_never_create_pending_request(broker, bad):
    coordinator, _, published = broker
    with pytest.raises(WorkError) as invalid:
        await coordinator.ask(ALICE, SID, RID, "bad", bad)
    assert invalid.value.code == "invalid_request"
    assert coordinator.snapshot(ALICE, SID) == [] and published.empty()


@pytest.mark.asyncio
async def test_close_cancels_waiters_and_refuses_new_questions(broker):
    coordinator, _, _ = broker
    task, _ = await pending(broker)
    await coordinator.close()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert coordinator.snapshot(ALICE, SID) == []
    with pytest.raises(WorkError) as closed:
        await coordinator.ask(ALICE, SID, RID, "another", QUESTION)
    assert closed.value.code == "question_unavailable"
