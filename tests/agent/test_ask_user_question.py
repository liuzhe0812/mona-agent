from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from mona.agent.tools.ask_user import AskUserQuestionTool
from mona.agent.tools.context import RequestContext, ToolContext
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META, DeliverFileTool
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.bus.queue import MessageBus
from mona.bus.user_questions import USER_QUESTIONS_META
from mona.channels.websocket import WebSocketChannel

QUESTIONS = [{"id": "style", "question": "选择 PPT 风格，也可以自定义", "options": [
    {"label": "简洁商务", "description": "清楚介绍产品价值"},
    {"label": "技术风格"}, {"label": "杂志排版"},
]}]


class Connection:
    def __init__(self):
        self.messages: list[dict] = []

    async def send(self, raw: str):
        self.messages.append(json.loads(raw))


def registry_for(bus: MessageBus, tmp_path: Path) -> ToolRegistry:
    registry = ToolRegistry()
    ToolLoader(test_classes=[AskUserQuestionTool]).load(
        ToolContext(config=None, workspace=str(tmp_path), bus=bus), registry,
    )
    registry.get("ask_user_question").set_context(RequestContext(
        channel="websocket", chat_id="ppt-chat", session_key="websocket:ppt-chat",
    ))
    return registry


@pytest.mark.asyncio
async def test_question_waits_and_custom_answer_returns_to_the_same_tool_call(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    bus = MessageBus()
    registry = registry_for(bus, tmp_path)
    assert "ask_user_question" in {row["function"]["name"] for row in registry.get_definitions()}
    task = asyncio.create_task(registry.execute("ask_user_question", {"questions": QUESTIONS}))
    requested = await asyncio.wait_for(bus.consume_outbound(), 2)
    assert not task.done()
    question_id = requested.metadata[USER_QUESTIONS_META][0]["request_id"]

    channel = WebSocketChannel({"enabled": True}, bus)
    connection = Connection()
    channel._attach(connection, "ppt-chat")
    await channel.send(requested)
    frame = connection.messages[-1]
    assert frame["event"] == "user_questions"
    assert frame["requests"][0]["questions"][0]["options"] == QUESTIONS[0]["options"]

    reconnected = Connection()
    channel._attach(reconnected, "ppt-chat")
    await channel._hydrate_after_subscribe("ppt-chat")
    assert next(frame for frame in reconnected.messages if frame["event"] == "user_questions")["requests"][0]["request_id"] == question_id

    channel._attach(connection, "other-chat")
    answer = [{"id": "style", "selected": [], "custom": "米白底、墨绿色，不要卡片"}]
    for chat_id, answers in [("other-chat", answer), ("ppt-chat", [{"id": "style", "selected": ["未知选项"]}])]:
        await channel._dispatch_envelope(connection, "client", {
            "type": "answer_user_question", "chat_id": chat_id, "question_id": question_id,
            "answers": answers, "request_id": "answer-attempt",
        })
        assert connection.messages[-1]["ok"] is False
        assert not task.done()

    await channel._dispatch_envelope(connection, "client", {
        "type": "answer_user_question", "chat_id": "ppt-chat", "question_id": question_id,
        "answers": answer, "request_id": "answer-accepted",
    })
    assert connection.messages[-1] == {"event": "answer_user_question_result", "ok": True,
                                       "chat_id": "ppt-chat", "request_id": "answer-accepted"}
    assert json.loads(await asyncio.wait_for(task, 2)) == {"answers": answer}
    await channel.send(await asyncio.wait_for(bus.consume_outbound(), 2))
    assert connection.messages[-1]["requests"] == []
    assert bus.inbound.empty()
    with pytest.raises(ValueError):
        bus.user_questions.answer("ppt-chat", question_id, answer)


@pytest.mark.asyncio
async def test_multiple_questions_accept_multi_select_and_free_text(tmp_path):
    bus = MessageBus()
    registry = registry_for(bus, tmp_path)
    questions = [{**QUESTIONS[0], "multi_select": True}, {"id": "audience", "question": "给谁看？"}]
    task = asyncio.create_task(registry.execute("ask_user_question", {"questions": questions}))
    requested = await asyncio.wait_for(bus.consume_outbound(), 2)
    question_id = requested.metadata[USER_QUESTIONS_META][0]["request_id"]
    answers = [{"id": "style", "selected": ["简洁商务", "杂志排版"]},
               {"id": "audience", "selected": [], "custom": "企业客户"}]
    with pytest.raises(ValueError):
        bus.user_questions.answer("ppt-chat", question_id, answers[:1])
    bus.user_questions.answer("ppt-chat", question_id, answers)
    assert json.loads(await task) == {"answers": answers}


@pytest.mark.asyncio
async def test_prepared_previews_are_delivered_before_waiting_for_an_answer(tmp_path):
    bus = MessageBus()
    pending: list[dict] = []
    ctx = RequestContext(channel="websocket", chat_id="ppt-chat",
                         metadata={DELIVER_FILES_PENDING_META: pending})
    preview = tmp_path / "样张.jpg"
    preview.write_bytes(b"preview")
    delivery = DeliverFileTool(bus.publish_outbound, workspace=tmp_path, restrict_to_workspace=True)
    delivery.set_context(ctx)
    assert await delivery.execute(paths=[str(preview)]) == "Prepared 1 file(s) for final delivery"
    tool = AskUserQuestionTool.create(ToolContext(config=None, workspace=str(tmp_path), bus=bus))
    tool.set_context(ctx)
    task = asyncio.create_task(tool.execute(questions=QUESTIONS))
    media = await asyncio.wait_for(bus.consume_outbound(), 2)
    assert media.metadata["_deliver_files"][0]["absolute_path"] == str(preview)
    assert media.metadata["_question_preview"] is True
    assert pending == []
    question = await asyncio.wait_for(bus.consume_outbound(), 2)
    request_id = question.metadata[USER_QUESTIONS_META][0]["request_id"]
    assert not task.done()
    bus.user_questions.answer("ppt-chat", request_id, None)
    await task


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_task", [False, True])
async def test_cancel_and_task_stop_remove_pending_question(tmp_path, stop_task):
    bus = MessageBus()
    registry = registry_for(bus, tmp_path)
    task = asyncio.create_task(registry.execute("ask_user_question", {"questions": QUESTIONS}))
    requested = await asyncio.wait_for(bus.consume_outbound(), 2)
    question_id = requested.metadata[USER_QUESTIONS_META][0]["request_id"]
    if stop_task:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        bus.user_questions.answer("ppt-chat", question_id, None)
        assert json.loads(await task) == {"cancelled": True, "answers": []}
    assert bus.user_questions.snapshot("ppt-chat") == []
    assert (await bus.consume_outbound()).metadata[USER_QUESTIONS_META] == []


@pytest.mark.asyncio
async def test_question_contexts_and_invalid_questions_are_isolated(tmp_path):
    bus = MessageBus()
    registry = registry_for(bus, tmp_path)
    tool = registry.get("ask_user_question")
    assert (await registry.execute("ask_user_question", {"questions": QUESTIONS * 2})).startswith("Error")
    task_a = asyncio.create_task(registry.execute("ask_user_question", {"questions": QUESTIONS}))
    await bus.consume_outbound()
    tool.set_context(RequestContext(channel="websocket", chat_id="second-chat"))
    task_b = asyncio.create_task(registry.execute("ask_user_question", {"questions": QUESTIONS}))
    await bus.consume_outbound()
    request_a = bus.user_questions.snapshot("ppt-chat")[0]["request_id"]
    request_b = bus.user_questions.snapshot("second-chat")[0]["request_id"]
    bus.user_questions.answer("ppt-chat", request_a, None)
    await task_a
    assert not task_b.done()
    bus.user_questions.answer("second-chat", request_b, None)
    await task_b
    tool.set_context(RequestContext(channel="feishu", chat_id="external-chat"))
    assert not tool.available_in_context()
