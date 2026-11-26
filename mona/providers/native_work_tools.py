"""Remove Mona tools duplicated by native Work engines."""

from pathlib import Path, PureWindowsPath
from typing import Any

from mona.agent.tools.capabilities import capabilities_for_tool, tool_enabled_by_capability
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import Config
from mona.development.executors.rpc import RpcError

NATIVE_BASIC_TOOLS = frozenset({
    "read_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "list_dir",
    "find_files",
    "grep",
    "exec",
    "write_stdin",
    "list_exec_sessions",
})


def filter_native_work_tools(definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep authorized tool definitions other than native basic tools."""
    result = []
    for definition in definitions:
        function = definition.get("function")
        name = function.get("name") if isinstance(function, dict) else definition.get("name")
        if not isinstance(name, str) or name not in NATIVE_BASIC_TOOLS:
            result.append(definition)
    return result


_SDK_SOURCES = {
    "Read": ("read_file",), "NotebookRead": ("read_file",),
    "Glob": ("find_files", "list_dir"), "Grep": ("grep",), "LS": ("list_dir",),
    "Write": ("write_file", "apply_patch"), "Edit": ("edit_file", "apply_patch"),
    "MultiEdit": ("edit_file", "apply_patch"), "NotebookEdit": ("edit_file", "apply_patch"),
    "Bash": ("exec",), "PowerShell": ("exec",),
    "TaskOutput": ("write_stdin",), "BashOutput": ("write_stdin",),
    "TaskStop": ("write_stdin",), "KillShell": ("write_stdin",),
}
_CODEX_SOURCES = {
    "exec_command": ("exec",), "write_stdin": ("write_stdin",),
    "apply_patch": ("apply_patch",), "view_image": ("read_file",),
}


class NativeWorkToolPolicy:
    """Authorize native primitives against the same registered Mona tools."""

    def __init__(self, tools: ToolRegistry, executor: str, workspace: Path):
        self.tools, self.executor, self.workspace = tools, executor, workspace.resolve()
        self.sources = dict(_CODEX_SOURCES if executor == "codex" else _SDK_SOURCES)
        if executor == "claude":
            self.sources.pop("PowerShell")

    def _source(self, name: str):
        return next((self.tools.get(source) for source in self.sources.get(name, ())
                     if self.tools.is_permitted(source)
                     and getattr(self.tools.get(source), "model_visible", True)
                     and self.tools.get(source).available_in_context()), None)

    @property
    def native_tools(self) -> tuple[str, ...]:
        return tuple(name for name in self.sources if self._source(name) is not None)

    def check(self, name: str, arguments: dict) -> dict:
        tool = self._source(name)
        if tool is None:
            return {"allow": False, "message": "当前 Agent 未授权这项基础操作。"}
        if self.tools.has("load_capability") and not tool_enabled_by_capability(tool.name):
            groups = ", ".join(sorted(capabilities_for_tool(tool.name)))
            return {"allow": False, "message": f"请先通过 load_capability 加载 {groups}，再使用原生工具。"}
        updated = dict(arguments)
        try:
            if name in {"Bash", "PowerShell", "exec_command"}:
                command = arguments.get("command", arguments.get("cmd"))
                if not isinstance(command, str) or not command.strip():
                    return {"allow": False, "message": "命令内容无效，本次操作未执行。"}
                raw_cwd = arguments.get("cwd", arguments.get("workdir")) or str(self.workspace)
                cwd = Path(raw_cwd).expanduser()
                cwd = (self.workspace / cwd).resolve() if not cwd.is_absolute() else cwd.resolve()
                if tool.restrict_to_workspace and not cwd.is_relative_to(self.workspace):
                    return {"allow": False, "message": "命令目录不在当前工作区内。"}
                error = tool._guard_command(command, str(cwd))
                if error:
                    return {"allow": False, "message": error}
                if "cwd" in arguments and self.executor != "codex":
                    updated["cwd"] = str(cwd)
                if "workdir" in arguments and self.executor != "codex":
                    updated["workdir"] = str(cwd)
            elif name in {"TaskOutput", "BashOutput", "TaskStop", "KillShell", "write_stdin"}:
                pass  # Continuations stay in their native session's process manager.
            elif name == "apply_patch":
                # Codex reports the requested write root, not the patch, at approval.
                root = Path(arguments.get("grantRoot") or self.workspace).resolve()
                if not root.is_relative_to(self.workspace):
                    return {"allow": False, "message": "文件修改范围不在当前工作区内。"}
            else:
                key = next((key for key in ("file_path", "path", "notebook_path") if arguments.get(key)), None)
                raw = arguments[key] if key else str(self.workspace)
                target = tool._resolve(raw)
                if tool.name == "apply_patch" and not target.is_relative_to(self.workspace):
                    return {"allow": False, "message": "补丁修改范围不在当前工作区内。"}
                if key:
                    updated[key] = str(target)
                else:
                    updated["path"] = str(target)
                for key in (("pattern",) if name == "Glob" else ("glob",) if name == "Grep" else ()):
                    pattern = arguments.get(key)
                    if isinstance(pattern, str) and (".." in pattern or Path(pattern).is_absolute()
                                                    or PureWindowsPath(pattern).is_absolute()):
                        return {"allow": False, "message": "搜索模式必须位于已授权的目录内。"}
        except (OSError, ValueError, TypeError, RuntimeError):
            return {"allow": False, "message": "无法确认本次操作的目录范围。"}
        return {"allow": True, "arguments": updated}


def validate_native_work_policy(config: Config, policy: NativeWorkToolPolicy) -> tuple[str, ...]:
    """Check that the selected engine can enforce this Work tool registry."""
    names = policy.native_tools
    registry = policy.tools
    shell = registry.get("exec")
    if shell is not None and any(name in names for name in ("exec_command", "Bash", "PowerShell")):
        if shell.sandbox or shell.restrict_to_workspace or config.tools.restrict_to_workspace or config.tools.exec.sandbox:
            raise RpcError("native_policy_unavailable", "当前模型无法使用已启用的命令沙箱或严格目录限制，请选择其他模型来源或调整工具权限。")
    if policy.executor == "codex":
        reads = [registry.get(name) for name in ("read_file", "list_dir", "find_files", "grep")
                 if registry.is_permitted(name) and getattr(registry.get(name), "model_visible", True)
                 and registry.get(name).available_in_context()]
        if reads and (config.tools.restrict_to_workspace or config.tools.exec.sandbox
                      or any(getattr(tool, "_allowed_dir", None) is not None for tool in reads)):
            raise RpcError("native_policy_unavailable", "当前模型无法保证已启用的读取目录限制，请选择其他模型来源或调整工具权限。")
        if reads and "exec_command" not in names:
            raise RpcError("native_policy_unavailable", "当前模型需要命令权限才能读取文件，请选择其他模型来源或调整工具权限。")
        if ("exec_command" in names) != ("write_stdin" in names):
            raise RpcError("native_policy_unavailable", "当前模型的命令与进程续接权限不一致，请选择其他模型来源或调整工具权限。")
    return names


def work_model_policy(
    config: Config, executor: str, workspace: Path, source_tools: ToolRegistry | None = None,
) -> NativeWorkToolPolicy:
    """Snapshot Mona's current basic tools and grants without mutating its running loop."""
    from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
    from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config

    registry = ToolRegistry()
    if source_tools is not None:
        for name in NATIVE_BASIC_TOOLS:
            if tool := source_tools.get(name):
                registry.register(tool)
    else:
        from mona.agent.tools.apply_patch import ApplyPatchTool
        from mona.agent.tools.context import ToolContext
        from mona.agent.tools.exec_session import ListExecSessionsTool, WriteStdinTool
        from mona.agent.tools.filesystem import (
            EditFileTool,
            ListDirTool,
            ReadFileTool,
            WriteFileTool,
        )
        from mona.agent.tools.search import FindFilesTool, GrepTool
        from mona.agent.tools.shell import ExecTool

        context = ToolContext(config=config.tools, workspace=str(workspace))
        for tool_type in (ReadFileTool, WriteFileTool, EditFileTool, ListDirTool, FindFilesTool, GrepTool,
                          ApplyPatchTool, ExecTool, WriteStdinTool, ListExecSessionsTool):
            if tool_type.enabled(context):
                registry.register(tool_type.create(context))
    effective = resolve_effective_agent_config(
        AgentRegistry().require(MONA_AGENT_ID), load_agent_user_config(MONA_AGENT_ID),
    )
    registry.set_allowed_tool_names(set(effective.allowed_tools) if effective.allowed_tools is not None else None)
    return NativeWorkToolPolicy(registry, executor, workspace)
