
from __future__ import annotations

import json
from contextvars import ContextVar
from typing import Any

from pydantic import ValidationError

from mona.agent.tools.base import Tool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META
from mona.bus.events import OutboundMessage
from mona.bus.user_questions import QuestionInput, UserQuestions


class AskUserQuestionTool(Tool):
    name = "ask_user_question"
    description = (
        "Ask the user a concise question when you need a choice or missing information before proceeding. "
        "Waits for their answer. Supports single choice, multiple choices and custom text. "
        "Call this tool alone and use its answer before continuing. "
        "Use stable question IDs; put a recommended option first. A cancelled question is not an answer."
    )
    parameters = QuestionInput.model_json_schema()
    system_managed = True
    exclusive = True

    def __init__(self, questions: UserQuestions | None = None, agent_id: str = "mona", send_callback=None):
        self._questions = questions
        self._agent_id = agent_id
        self._send_callback = send_callback
        self._context: ContextVar[RequestContext | None] = ContextVar("ask_user_context", default=None)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        bus = getattr(ctx, "bus", None)
        return cls(getattr(bus, "user_questions", None), getattr(ctx, "agent_id", "mona"),
                   getattr(bus, "publish_outbound", None))

    def set_context(self, ctx: RequestContext) -> None:
        self._context.set(ctx)

    def available_in_context(self) -> bool:
        ctx = self._context.get()
        return self._questions is not None and ctx is not None and ctx.channel == "websocket"

    async def execute(self, questions: list[dict], **kwargs: Any) -> Any:
        if not self.available_in_context():
            return "Error: 当前会话没有可用的提问界面，请直接向用户提问。"
        try:
            request = QuestionInput(questions=questions, **kwargs)
        except ValidationError:
            return "Error: 问题格式无效，请检查问题 ID、问题内容和选项。"
        ctx = self._context.get()
        assert ctx is not None and self._questions is not None
        pending_files = ctx.metadata.get(DELIVER_FILES_PENDING_META)
        if isinstance(pending_files, list) and pending_files and self._send_callback:
            # Prepared previews must be visible before this tool waits for an answer.
            await self._send_callback(OutboundMessage(
                channel=ctx.channel, chat_id=ctx.chat_id, content="",
                metadata={"_deliver_files": list(pending_files),
                          "_question_preview": all(str(file.get("mime", "")).startswith("image/")
                                                   for file in pending_files)},
            ))
            pending_files.clear()
        result = await self._questions.ask(ctx.chat_id, self._agent_id, request.questions)
        return json.dumps(result, ensure_ascii=False)
