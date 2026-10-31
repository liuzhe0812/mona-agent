
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from mona.bus.events import OutboundMessage

USER_QUESTIONS_META = "_user_questions"


class QuestionOption(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    label: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)


class UserQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=100)
    question: str = Field(min_length=1, max_length=4000)
    header: str | None = Field(default=None, max_length=200)
    options: list[QuestionOption] = Field(default_factory=list, max_length=20)
    multi_select: bool = False

    @model_validator(mode="after")
    def unique_options(self):
        if not self.id.strip() or not self.question.strip():
            raise ValueError("问题 ID 和问题内容不能为空。")
        labels = [option.label for option in self.options]
        if any(not label.strip() for label in labels) or len(set(labels)) != len(labels):
            raise ValueError("选项名称不能为空或重复。")
        return self


class QuestionInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    questions: list[UserQuestion] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({question.id for question in self.questions}) != len(self.questions):
            raise ValueError("问题 ID 不能重复。")
        return self


class QuestionAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=100)
    selected: list[str] = Field(max_length=20)
    custom: str | None = Field(default=None, max_length=8000)


@dataclass
class _PendingQuestion:
    chat_id: str
    agent_id: str
    questions: list[UserQuestion]
    future: asyncio.Future[dict[str, Any]]


class UserQuestions:
    def __init__(self, publish: Callable[[OutboundMessage], Awaitable[None]]):
        self._publish = publish
        self._pending: dict[str, _PendingQuestion] = {}

    def snapshot(self, chat_id: str) -> list[dict[str, Any]]:
        return [
            {"request_id": request_id, "agent_id": pending.agent_id,
             "questions": [question.model_dump(exclude_none=True) for question in pending.questions]}
            for request_id, pending in self._pending.items()
            if pending.chat_id == chat_id and not pending.future.done()
        ]

    async def _notify(self, chat_id: str) -> None:
        await self._publish(OutboundMessage(
            channel="websocket", chat_id=chat_id, content="",
            metadata={USER_QUESTIONS_META: self.snapshot(chat_id)},
        ))

    async def ask(self, chat_id: str, agent_id: str, questions: list[UserQuestion]) -> dict[str, Any]:
        request_id = f"question_{uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = _PendingQuestion(chat_id, agent_id, questions, future)
        try:
            await self._notify(chat_id)
            return await future
        finally:
            self._pending.pop(request_id, None)
            await self._notify(chat_id)

    def answer(self, chat_id: str, request_id: str, answers: list[dict] | None) -> None:
        pending = self._pending.get(request_id)
        if pending is None or pending.chat_id != chat_id or pending.future.done():
            raise ValueError("此问题已结束或不属于当前会话，请查看最新会话。")
        if answers is None:
            pending.future.set_result({"cancelled": True, "answers": []})
            return
        if not isinstance(answers, list):
            raise ValueError("请填写问题的回答。")
        validated = [QuestionAnswer.model_validate(answer) for answer in answers]
        by_id = {answer.id: answer for answer in validated}
        if len(by_id) != len(validated) or set(by_id) != {question.id for question in pending.questions}:
            raise ValueError("请逐项回答当前问题。")
        for question in pending.questions:
            answer = by_id[question.id]
            labels = {option.label for option in question.options}
            if (len(set(answer.selected)) != len(answer.selected)
                    or any(value not in labels for value in answer.selected)
                    or (not question.multi_select and len(answer.selected) > 1)):
                raise ValueError("所选回答无效，请重新选择。")
            if not answer.selected and not (answer.custom or "").strip():
                raise ValueError("请选择选项或输入自定义回答。")
        pending.future.set_result({"answers": [by_id[question.id].model_dump(exclude_none=True)
                                               for question in pending.questions]})
