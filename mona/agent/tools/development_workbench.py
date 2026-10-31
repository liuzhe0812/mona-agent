"""Main-assistant tool for the desktop development workbench."""

from __future__ import annotations

import json
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from loguru import logger
from pydantic import ValidationError

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.development.executors.diagnostics import ERRORS as NATIVE_ERRORS
from mona.development.executors.rpc import RpcError
from mona.development.hub_contracts import HubCommand
from mona.development.store import DevelopmentError

if TYPE_CHECKING:
    from mona.development.hub import DevelopmentHub


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Operation: list_projects, list_sessions, inspect_session, inspect_project, "
            "read_file, read_diff, read_message, create_session, send_task, or list_tasks.",
            enum=["list_projects", "list_sessions", "inspect_session", "inspect_project", "read_file",
                  "read_diff", "read_message", "create_session", "send_task", "list_tasks"],
        ),
        project_id=StringSchema("Project ID returned by list_projects.", min_length=2, max_length=96),
        session_id=StringSchema("Development session ID returned by list_sessions or create_session.", min_length=2, max_length=96),
        request_id=StringSchema(
            "Required for create_session and send_task. Give each operation a unique stable ID "
            "starting with a lowercase letter and using lowercase letters, digits, underscores or hyphens; "
            "reuse exactly the same ID and arguments when retrying.", min_length=2, max_length=96,
        ),
        message_id=StringSchema("Message ID returned by inspect_session, for read_message.", min_length=2, max_length=96),
        query=StringSchema("Optional project or session name filter.", max_length=200),
        offset=IntegerSchema(description="List page offset, or message text offset for read_message.", minimum=0),
        limit=IntegerSchema(description="List or history page size; default 20, maximum 100.", minimum=1, maximum=100),
        before=IntegerSchema(description="Earlier history cursor returned by inspect_session.", minimum=0),
        after=IntegerSchema(description="Event cursor for inspect_session.", minimum=0),
        path=StringSchema("Project-relative path for read_file or read_diff. An empty diff path covers the project.", max_length=4096),
        title=StringSchema("Optional title of a new development session.", min_length=1, max_length=200),
        executor=StringSchema("New session executor; defaults to mona.", enum=["mona", "codex", "claude", "codebuddy"]),
        model=StringSchema("Optional model or preset for a new session.", max_length=200),
        model_provider=StringSchema("Optional Mona model provider for a new session.", min_length=1, max_length=200),
        model_reasoning_effort=StringSchema("Optional supported reasoning effort for the selected source.", max_length=32),
        readonly=BooleanSchema(description="Create a read-only development session.", default=False),
        content=StringSchema("Task or follow-up to send to the selected session.", max_length=200_000),
        intent=StringSchema(
            "send_task: follow_up (default) queues the next task; steering explicitly adjusts the current run.",
            enum=["follow_up", "steering"],
        ),
        expected_revision=IntegerSchema(description="Required for send_task: latest session revision from inspect_session.", minimum=0),
        target_run_id=StringSchema("Required for steering: current run ID from inspect_session.", min_length=2, max_length=96),
        expected_sha256=StringSchema("Optional message content hash for read_message.", min_length=64, max_length=64),
        include_archived=BooleanSchema(description="Include archived sessions when listing.", default=False),
        required=["action"],
    )
)
class DevelopmentWorkbenchTool(Tool, ContextAware):
    """Expose the existing development service to the main desktop assistant."""

    _plugin_discoverable = False
    _scopes = {"core"}
    system_managed = True
    agent_allowlist = frozenset({"mona"})
    name = "development_workbench"
    description = (
        "Inspect development workbench projects, sessions, plans, files, Git changes and messages; "
        "create a development session or send work to an existing one when the user requests it. "
        "Use list_tasks to find work dispatched from this chat. Reuse an appropriate existing session "
        "when continuing its task. A dispatch receipt means accepted or queued, not completed; "
        "check the actual run and validation evidence before claiming completion or readiness. "
        "Background results are reported to this chat; their arrival is not a new instruction "
        "and does not authorize automatically dispatching more work."
    )

    def __init__(self, hub: DevelopmentHub):
        self._hub = hub
        self._source: ContextVar[RequestContext | None] = ContextVar(
            f"development_workbench_source_{id(self)}", default=None
        )

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return False

    def set_context(self, ctx: RequestContext) -> None:
        self._source.set(ctx)

    def available_in_context(self) -> bool:
        source = self._source.get()
        return source is not None and self._hub.allows_context(source)

    async def execute(self, **kwargs: Any) -> str:
        source = self._source.get()
        if source is None or not self._hub.allows_context(source):
            result = {"ok": False, "error": {"code": "unavailable", "message": "当前聊天无法访问开发工作台。"}}
        else:
            try:
                command = HubCommand.model_validate(kwargs)
                result = await self._hub.execute(command, source)
            except ValidationError as exc:
                issues = [{"field": ".".join(map(str, item["loc"])), "code": item["type"], "message": item["msg"]}
                          for item in exc.errors(include_url=False, include_input=False, include_context=False)]
                result = {"ok": False, "error": {"code": "invalid_request", "message": "请求参数无效，请检查目标和操作。", "issues": issues}}
            except RpcError as exc:
                known = NATIVE_ERRORS.get(exc.code)
                message = f"{known[1]}{known[2]}" if known else "执行者连接未完成，请检查模型来源设置。"
                if exc.outcome_unknown:
                    message = "执行结果暂时无法确认，请查询原任务核对结果；没有自动重新执行。"
                result = {"ok": False, "error": {"code": exc.code, "message": message}}
            except DevelopmentError as exc:
                result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
            except PermissionError:
                result = {"ok": False, "error": {"code": "access_denied", "message": "当前操作不在允许范围内。"}}
            except FileNotFoundError:
                result = {"ok": False, "error": {"code": "path_missing", "message": "项目文件或目录不存在，请重新查询。"}}
            except ValueError:
                result = {"ok": False, "error": {"code": "invalid_request", "message": "项目、模型来源或请求参数无效，请核对后重试。"}}
            except Exception as exc:
                logger.error("Development workbench {} failed ({})", command.action, type(exc).__name__)
                result = {"ok": False, "error": {"code": "operation_unconfirmed",
                    "message": "开发工作台操作未能确认完成。请先查询原任务状态，重试时沿用相同请求标识，不要重复派发。"}}
        return json.dumps(result, ensure_ascii=False)
