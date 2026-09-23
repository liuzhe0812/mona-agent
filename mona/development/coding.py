"""Pi-style development assembly on Mona's existing AgentRunner.

This module selects context and tools. It does not implement another agent loop
or borrow the general assistant's memory, personas, MCP registry or skill loader.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from mona.agent.runner import AgentRunSpec
from mona.agent.tools.context import PROJECT_WORKSPACE_META, RequestContext
from mona.agent.tools.exec_session import ExecSessionManager, ListExecSessionsTool, WriteStdinTool
from mona.agent.tools.file_state import FileStates
from mona.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.shell import ExecTool, ExecToolConfig
from mona.config.schema import AgentDefaults
from mona.development.context import ProjectContext, build_coding_messages
from mona.development.contracts import DevelopmentSession, ExecutorId
from mona.development.store import DevelopmentError
from mona.session.manager import Session


class _ProjectPathScope:
    """Pin tools to their session root, not an ambient UI workspace or media root."""

    _workspace: Path

    def _resolve(self, path: str) -> Path:
        candidate = Path(path).expanduser()
        resolved = (self._workspace / candidate).resolve()
        if not resolved.is_relative_to(self._workspace):
            raise PermissionError("路径超出当前开发项目；请显式添加项目资源，不要换工具绕过。")
        return resolved


class _ProjectRead(_ProjectPathScope, ReadFileTool):
    pass


class _ProjectWrite(_ProjectPathScope, WriteFileTool):
    pass


class _ProjectEdit(_ProjectPathScope, EditFileTool):
    pass


class _ProjectList(_ProjectPathScope, ListDirTool):
    pass


class _ProjectExec(ExecTool):
    owner_session_key: str

    async def execute(self, **kwargs: Any) -> str:
        async def invoke() -> str:
            token = set_current_workspace(Path(self.working_dir))
            self.set_context(RequestContext(channel="development", chat_id=self.owner_session_key,
                session_key=self.owner_session_key, metadata={PROJECT_WORKSPACE_META: True}))
            try:
                return await super(_ProjectExec, self).execute(**kwargs)
            finally:
                reset_current_workspace(token)
        # ContextVars set by the shared shell tool stay inside this task.
        return await asyncio.create_task(invoke())


class CodingTools:
    """Keep one instance per development session, including between its turns."""

    def __init__(self, root: Path, session_key: str, exec_config: ExecToolConfig,
                 *, readonly: bool = False):
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir():
            raise DevelopmentError("invalid_project", "开发工具需要实际项目目录。")
        self.session_key = session_key
        self.readonly = readonly
        self.file_states = FileStates()
        self.exec_sessions = ExecSessionManager()
        self.registry = ToolRegistry()
        file_args = {"workspace": self.root, "allowed_dir": self.root, "file_states": self.file_states}
        self.registry.register(_ProjectRead(**file_args))
        self.registry.register(_ProjectList(**file_args))
        if readonly:
            return
        self.registry.register(_ProjectWrite(**file_args))
        self.registry.register(_ProjectEdit(**file_args))
        if exec_config.enable:
            execute = _ProjectExec(working_dir=str(self.root), timeout=exec_config.timeout,
                restrict_to_workspace=True, sandbox=exec_config.sandbox,
                path_append=exec_config.path_append, allowed_env_keys=exec_config.allowed_env_keys,
                allow_patterns=exec_config.allow_patterns, deny_patterns=exec_config.deny_patterns,
                session_manager=self.exec_sessions, use_agent_runtime=False)
            execute.owner_session_key = session_key
            self.registry.register(execute)
            self.registry.register(WriteStdinTool(manager=self.exec_sessions))
            self.registry.register(ListExecSessionsTool(manager=self.exec_sessions))


def build_coding_run_spec(context: ProjectContext, session: DevelopmentSession,
                          transcript: Session, tools: CodingTools, *, model: str,
                          context_window_tokens: int, defaults: AgentDefaults,
                          summary: str | None = None) -> AgentRunSpec:
    if session.executor != ExecutorId.MONA:
        raise DevelopmentError("wrong_executor", "外部执行者必须使用原生 Adapter，不能降级为 Mona 模型调用。")
    if tools.session_key != session.transcript_key or tools.root != context.root:
        raise DevelopmentError("context_mismatch", "工具集不属于当前开发会话或项目。")
    if context_window_tokens <= defaults.max_tokens or not model:
        raise DevelopmentError("invalid_model", "模型或上下文窗口无效。")
    return AgentRunSpec(
        initial_messages=build_coding_messages(context, session, transcript, summary=summary, readonly=tools.readonly),
        tools=tools.registry, model=model, max_iterations=defaults.max_tool_iterations,
        max_tool_result_chars=defaults.max_tool_result_chars, temperature=defaults.temperature,
        max_tokens=defaults.max_tokens, reasoning_effort=defaults.reasoning_effort,
        workspace=context.root, session_key=session.transcript_key,
        context_window_tokens=context_window_tokens, context_block_limit=defaults.context_block_limit,
        repeat_guard_enabled=True, stream_progress_deltas=True,
    )
