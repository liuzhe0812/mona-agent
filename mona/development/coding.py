"""Pi-style development assembly on Mona's existing AgentRunner.

This module selects context and tools. It does not implement another agent loop
or borrow the general assistant's memory, personas, MCP registry or skill loader.
"""

from __future__ import annotations

import asyncio
import copy
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from mona.agent.runner import AgentRunSpec
from mona.agent.tools.context import PROJECT_WORKSPACE_META, RequestContext
from mona.agent.tools.exec_session import (
    DEFAULT_YIELD_MS,
    ExecSessionManager,
    ListExecSessionsTool,
    WriteStdinTool,
)
from mona.agent.tools.file_state import FileStates
from mona.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.search import FindFilesTool, GrepTool
from mona.agent.tools.shell import ExecTool, ExecToolConfig
from mona.config.schema import CodingConfig
from mona.development.context import ProjectContext, build_coding_messages
from mona.development.contracts import DevelopmentSession, ExecutorId, PermissionMode
from mona.development.store import DevelopmentError
from mona.session.manager import Session

_approved_file: ContextVar[Path | None] = ContextVar("development_approved_file", default=None)
_approved_unsandboxed: ContextVar[bool] = ContextVar("development_approved_unsandboxed", default=False)


class _CodingRegistry(ToolRegistry):
    permission = None

    def register(self, tool) -> None:
        original = getattr(tool, "_development_execute", tool.execute)
        tool._development_execute = original

        async def guarded_execute(**params):
            return await self._invoke(tool, original, params)

        # AgentRunner executes the prepared tool directly, while other callers
        # use registry.execute. Both paths must reach this same permission gate.
        tool.execute = guarded_execute
        super().register(tool)

    async def _invoke(self, tool, execute, params: dict[str, Any]) -> Any:
        name = tool.name
        permission = self.permission
        arguments = copy.deepcopy(tool.cast_params(params))
        errors = tool.validate_params(arguments)
        if errors:
            return f"Error: Invalid parameters for tool '{name}': " + "; ".join(errors)
        escalation = name == "exec" and arguments.get("sandbox_permissions") is not None
        if name == "exec" and (escalation != bool(arguments.get("justification", "").strip())):
            return "Error: 申请工作区外执行时必须同时提供权限范围和具体理由。"
        target = None
        if isinstance(tool, _ProjectPathScope) and isinstance(arguments.get("path"), str):
            target = (tool._workspace / arguments["path"]).resolve()
            arguments["path"] = str(target)
        if permission is not None and await permission(name, arguments) not in {"accept", "accept_similar"}:
            return "Error: 本次操作未获授权，未执行。请调整方案或等待用户授权。"
        token = _approved_file.set(target) if permission is not None else None
        command_token = _approved_unsandboxed.set(escalation and permission is not None)
        try:
            return await execute(**arguments)
        finally:
            if token is not None:
                _approved_file.reset(token)
            _approved_unsandboxed.reset(command_token)


class _ProjectPathScope:
    """Pin tools to their session root, not an ambient UI workspace or media root."""

    _workspace: Path
    allow_external_paths: bool = False
    readonly_scope: bool = False

    def _resolve(self, path: str) -> Path:
        candidate = Path(path).expanduser()
        resolved = (self._workspace / candidate).resolve()
        grant = _approved_file.get()
        if grant is not None and resolved != grant:
            raise PermissionError("授权目标已经变化，本次操作未执行。")
        if not self.allow_external_paths and not resolved.is_relative_to(self._workspace) and (self.readonly_scope or grant != resolved):
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


class _ProjectFind(_ProjectPathScope, FindFilesTool):
    pass


class _ProjectGrep(_ProjectPathScope, GrepTool):
    pass


class _ProjectExec(ExecTool):
    owner_session_key: str
    sandbox_runner = None

    @property
    def description(self) -> str:
        return (
            "Execute a command in the current project. Short commands return their output and exit code. "
            "Commands still running after yield_time_ms (default 1000 ms) return a session_id; "
            "use write_stdin to read output, send input, or terminate that same process. "
            "For dev servers, check readiness and continue the task instead of waiting for the server to exit. "
            "The command timeout still applies (default 60 seconds, max 600). "
            "Python/Node commands use the project's .venv and node_modules. "
            "Prefer file and search tools for inspection and file changes."
        )

    @property
    def parameters(self):
        schema = copy.deepcopy(super().parameters)
        schema["properties"]["yield_time_ms"].update({
            "default": DEFAULT_YIELD_MS,
            "description": "Milliseconds to wait before returning output (default 1000, max 30000). "
                "A still-running command returns a session_id for write_stdin, even when this field is omitted.",
        })
        schema["properties"].update({
            "sandbox_permissions": {"type": "string", "enum": ["danger-full-access"],
                "description": "After a sandbox denial, inspect prior effects and request approval to retry this exact "
                "command once outside the workspace write sandbox. Never replay automatically."},
            "justification": {"type": "string", "minLength": 1,
                "description": "Why this command needs the wider scope. Never replay a write whose result is unknown."},
        })
        return schema

    async def _spawn(self, command, cwd, env, shell_program=None, login=True):
        if self.sandbox_runner is None or _approved_unsandboxed.get():
            return await super()._spawn(command, cwd, env, shell_program, login)
        return await self.sandbox_runner.spawn(command, cwd, env, shell_program, login, stdin=asyncio.subprocess.DEVNULL)

    def _execution_diagnostics(self, exit_code, stderr):
        if self.sandbox_runner is None or _approved_unsandboxed.get():
            return ""
        return self.sandbox_runner.diagnostics(exit_code, stderr)

    async def execute(self, **kwargs: Any) -> str:
        if kwargs.get("yield_time_ms") is None:
            kwargs["yield_time_ms"] = DEFAULT_YIELD_MS

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


class _ProjectExecSessions(ExecSessionManager):
    sandbox_runner = None

    def _execution_diagnostics(self):
        if self.sandbox_runner is None or _approved_unsandboxed.get():
            return None
        return self.sandbox_runner.diagnostics

    async def _spawn(self, command, cwd, env, shell_program, login):
        if self.sandbox_runner is None or _approved_unsandboxed.get():
            return await super()._spawn(command, cwd, env, shell_program, login)
        return await self.sandbox_runner.spawn(command, cwd, env, shell_program, login, stdin=asyncio.subprocess.PIPE)


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
        self.exec_sessions = _ProjectExecSessions(observe_output=True)
        self.registry = _CodingRegistry()
        file_args = {"workspace": self.root, "allowed_dir": self.root, "file_states": self.file_states}
        self.registry.register(_ProjectRead(**file_args))
        self.registry.register(_ProjectList(**file_args))
        self.registry.register(_ProjectFind(**file_args))
        self.registry.register(_ProjectGrep(**file_args))
        if readonly:
            return
        self.registry.register(_ProjectWrite(**file_args))
        self.registry.register(_ProjectEdit(**file_args))
        self.configure_exec(exec_config)

    def configure_exec(self, exec_config: ExecToolConfig) -> None:
        """Refresh next-turn policy without discarding running commands or file state."""
        for name in ("exec", "write_stdin", "list_exec_sessions"):
            self.registry.unregister(name)
        if not self.readonly and exec_config.enable:
            execute = _ProjectExec(working_dir=str(self.root), timeout=exec_config.timeout,
                restrict_to_workspace=True, sandbox=exec_config.sandbox,
                path_append=exec_config.path_append, allowed_env_keys=exec_config.allowed_env_keys,
                allow_patterns=exec_config.allow_patterns, deny_patterns=exec_config.deny_patterns,
                session_manager=self.exec_sessions, use_agent_runtime=False)
            execute.owner_session_key = self.session_key
            self.registry.register(execute)
            self.registry.register(WriteStdinTool(manager=self.exec_sessions))
            self.registry.register(ListExecSessionsTool(manager=self.exec_sessions))

    def configure_permissions(self, mode: PermissionMode, decide) -> None:
        from mona.development.sandbox import DevelopmentSandbox
        self.registry.permission = decide
        full_access = mode == PermissionMode.FULL_ACCESS and not self.readonly
        runner = None if full_access or self.readonly else DevelopmentSandbox(self.root, self.session_key)
        self.exec_sessions.sandbox_runner = runner
        for name in self.registry.tool_names:
            tool = self.registry.get(name)
            if isinstance(tool, _ProjectPathScope):
                tool.allow_external_paths = full_access
                tool.readonly_scope = self.readonly
            if isinstance(tool, _ProjectExec):
                tool.sandbox_runner = runner
                # The process sandbox owns file effects; command paths can name
                # installed toolchains outside the project without a string fence.
                tool.restrict_to_workspace = False
                tool.sandbox = ""


def prepare_coding_extensions(tools: CodingTools, extensions: dict, messages: list[dict]) -> None:
    from mona.development.extensions import CodingExtensionLoader
    for name in ("update_plan", "development_collaboration", "development_browser", "load_coding_tools"):
        tools.registry.unregister(name)
    tools.registry.set_allowed_tool_names(None)
    base = set(tools.registry.tool_names)
    if extensions:
        for tool in extensions.values():
            tools.registry.register(tool)
        loader = CodingExtensionLoader(tools.registry, base, extensions)
        tools.registry.register(loader)
        loader.restore(messages)


def build_coding_run_spec(context: ProjectContext, session: DevelopmentSession,
                          transcript: Session, tools: CodingTools, *, model: str,
                          context_window_tokens: int, defaults: CodingConfig,
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
