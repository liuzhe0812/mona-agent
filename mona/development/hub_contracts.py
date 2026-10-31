"""The bounded main-assistant view of the development workbench."""
from typing import Literal

from pydantic import Field, model_validator

from mona.development.contracts import Contract, ExecutorId, Identifier


class HubCommand(Contract):
    action: Literal["list_projects", "list_sessions", "inspect_session", "inspect_project",
                    "read_file", "read_diff", "read_message", "create_session", "send_task", "list_tasks"]
    project_id: Identifier | None = None
    session_id: Identifier | None = None
    request_id: Identifier | None = None
    message_id: Identifier | None = None
    query: str = Field(default="", max_length=200)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=100)
    before: int | None = Field(default=None, ge=0)
    after: int = Field(default=0, ge=0)
    path: str = Field(default="", max_length=4096)
    title: str = Field(default="新开发任务", min_length=1, max_length=200)
    executor: ExecutorId = ExecutorId.MONA
    model: str | None = Field(default=None, max_length=200)
    model_provider: str | None = Field(default=None, min_length=1, max_length=200)
    model_reasoning_effort: str | None = Field(default=None, max_length=32)
    readonly: bool = False
    content: str = Field(default="", max_length=200_000)
    intent: Literal["follow_up", "steering"] = "follow_up"
    expected_revision: int | None = Field(default=None, ge=0)
    target_run_id: Identifier | None = None
    expected_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    include_archived: bool = False

    @model_validator(mode="after")
    def validate_action(self):
        if self.action in {"list_sessions", "inspect_project", "read_file", "read_diff", "create_session"} and not self.project_id:
            raise ValueError("此操作需要 project_id。")
        if self.action in {"inspect_session", "read_message", "send_task"} and not self.session_id:
            raise ValueError("此操作需要 session_id。")
        if self.action == "read_message" and not self.message_id:
            raise ValueError("读取完整消息需要 message_id。")
        if self.action in {"create_session", "send_task"} and not self.request_id:
            raise ValueError("创建或发送需要稳定的 request_id；重试必须沿用原标识。")
        if self.action == "send_task":
            if not self.content.strip() or self.expected_revision is None:
                raise ValueError("发送任务需要内容和最近读取的 expected_revision。")
            if self.intent == "steering" and not self.target_run_id:
                raise ValueError("补充当前任务必须指定已读取的 target_run_id。")
        return self
