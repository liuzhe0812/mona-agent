"""Private stdio bridge to official Python Agent SDKs in a clean process.

The SDK client connects/disconnects in the same owner task (AnyIO task-group
requirement). Only this worker inherits the allowlisted execution environment.
No model API, login impersonation, shell wrapper or user MCP is used.
The only optional SDK server is Mona's in-process, session-bound collaboration tool.
Read-only pre-tool checks are adapted from Cindy's claude-code adapter (Apache-2.0).
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import re
import sys
import types
import uuid
from contextlib import suppress
from pathlib import Path, PureWindowsPath
from typing import Any, Literal, Union, get_args, get_origin, get_type_hints

from mona.development.contracts import ExecutorId, PermissionMode
from mona.development.executors.diagnostics import ERRORS, native_version
from mona.development.executors.host_tools import (
    DELEGATION_INSTRUCTIONS,
    HOST_DESCRIPTION,
    HOST_SERVER,
    HOST_TOOL,
    SDK_HOST_TOOL,
    SDK_WORK_TOOL,
    SUBAGENT_INSTRUCTIONS,
    WORK_DESCRIPTION,
    WORK_SERVER,
    WORK_TOOL,
    HostToolCall,
    WorkToolCall,
    host_servers_valid,
    tool_unavailable,
)
from mona.development.executors.login import AUTH_FAILURE_REASONS
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_policy import SDK_MODULES, sdk_version
from mona.development.input_content import MAX_NATIVE_FRAME_BYTES, sdk_content

MAX_FRAME = MAX_NATIVE_FRAME_BYTES
READ_TOOLS = {"Read", "Glob", "Grep", "LS", "NotebookRead"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
CODEBUDDY_WINDOWS_INSTRUCTIONS = (
    "On Windows, use the PowerShell tool for terminal commands. "
    "Do not call Bash unless it is listed in this session's available tools."
)
CODEBUDDY_READONLY_INSTRUCTIONS = (
    "This task is read-only. Use Read, Glob, and Grep to inspect project files. "
    "Do not call shell or write tools."
)


def _supports_permission_mode(options_class: type, mode: str) -> bool:
    """Only enable bypass when the installed SDK type explicitly declares it."""
    try:
        parameter = inspect.signature(options_class).parameters.get("permission_mode")
    except (TypeError, ValueError):
        return False
    if parameter is None:
        return False
    try:
        annotation = get_type_hints(options_class.__init__).get("permission_mode", parameter.annotation)
    except (NameError, TypeError):
        annotation = parameter.annotation
    return _literal_contains(annotation, mode)


def _literal_contains(annotation: Any, value: str) -> bool:
    origin = get_origin(annotation)
    if origin is Literal:
        return value in get_args(annotation)
    if origin in {Union, types.UnionType}:
        return any(_literal_contains(option, value) for option in get_args(annotation))
    return False


def _supported_permission_modes(options_class: type) -> list[str]:
    modes = [PermissionMode.ASK.value, PermissionMode.AUTO.value]
    if _supports_permission_mode(options_class, "bypassPermissions"):
        modes.append(PermissionMode.FULL_ACCESS.value)
    return modes


def _sdk_permission_mode(start: dict, options_class: type) -> str:
    mode = PermissionMode(start["permissionMode"])
    if start["readonly"] or mode != PermissionMode.FULL_ACCESS:
        return "default"
    if not _supports_permission_mode(options_class, "bypassPermissions"):
        raise ValueError("sdk_contract_incompatible")
    return "bypassPermissions"


def _resolve_file_path(cwd: str, value: str) -> tuple[Path, Path]:
    root = Path(cwd).resolve()
    return root, (root / value).resolve()


class Worker:
    def __init__(self):
        self.output = sys.stdout
        self.client = None
        self.sdk = None
        self.projector = None
        self.options = None
        self.effort_supported = False
        self.start = None
        self.owner: asyncio.Task | None = None
        self.ready: asyncio.Future | None = None
        self.closing = asyncio.Event()
        self.pending: dict[str, asyncio.Future] = {}
        self.next_request = 0
        self.dispatch = asyncio.Lock()
        self.active: str | None = None
        self.tasks: set[asyncio.Task] = set()
        self.auth_owner: asyncio.Task | None = None
        self.auth_ready: asyncio.Future | None = None

    def write(self, value: dict) -> None:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(text.encode("utf8")) > MAX_FRAME:
            raise ValueError("worker_frame_too_large")
        self.output.write(text + "\n")
        self.output.flush()

    async def ask(self, method: str, params: dict) -> Any:
        self.next_request += 1
        key = f"sdk-permission-{self.next_request}"
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        self.write({"id": key, "method": method, "params": params})
        try:
            return await future
        finally:
            self.pending.pop(key, None)

    def _current_turn(self, turn_id: str | None) -> bool:
        return bool(turn_id) and self.active == turn_id and not self.closing.is_set() and (
            self.projector is not None and self.projector.turn_id == turn_id
            and not self.projector.finished and not self.projector.uncertain)

    async def host_collaboration(self, arguments: dict) -> dict:
        turn_id = self.active
        work_mode = bool(self.start and self.start.get("workPrompt") is not None)
        collaboration = bool(self.start and self.start.get("hostCollaboration") and not self.start["readonly"])
        if not self._current_turn(turn_id) or not self.start or not (work_mode or collaboration):
            return tool_unavailable()
        self.projector.resuming = False
        reply = await self.ask("host/collaboration", {"turnId": turn_id, "arguments": arguments})
        if not self._current_turn(turn_id) or not isinstance(reply, dict) or not isinstance(reply.get("content"), list):
            return tool_unavailable()
        return reply

    async def permission(self, name: str, arguments: dict, context: Any):
        sdk, start = self.sdk, self.start
        assert sdk is not None and start is not None
        turn_id = self.active
        if not self._current_turn(turn_id):
            return sdk.PermissionResultDeny(message="原任务已结束、正在关闭或结果待核对，未接受本次操作。")
        self.projector.resuming = False
        if start.get("workPrompt") is not None:
            if name == SDK_WORK_TOOL:
                return sdk.PermissionResultAllow(updated_input=arguments)
            return sdk.PermissionResultDeny(message="Work 工具只允许通过 Mona 工具通道调用。")
        if name == "AskUserQuestion":
            questions = arguments.get("questions")
            if (not isinstance(questions, list) or not 1 <= len(questions) <= 20
                    or any(not isinstance(q, dict) or not isinstance(q.get("question"), str)
                           or not q["question"] or len(q["question"]) > 4000 for q in questions)):
                return sdk.PermissionResultDeny(message="问题格式无效，未提交回答。")
            wire = [{"id": f"question-{i}", "question": q["question"],
                     "options": q.get("options", [])} for i, q in enumerate(questions)]
            response = await self.ask("question", {"turnId": turn_id, "questions": wire})
            if not self._current_turn(turn_id) or not isinstance(response, dict) or set(response) != {q["id"] for q in wire}:
                return sdk.PermissionResultDeny(message="尚未获得当前全部问题的回答。")
            answers = {}
            for question in wire:
                values = response[question["id"]]
                if not isinstance(values, list) or not values or len(values) > 20 or any(
                        not isinstance(v, str) or not v.strip() or len(v) > 8000 for v in values):
                    return sdk.PermissionResultDeny(message="回答格式无效。")
                answers[question["question"]] = ", ".join(values)
            return sdk.PermissionResultAllow(updated_input={**arguments, "answers": answers})
        if name == SDK_HOST_TOOL and self.active and start.get("hostCollaboration") and not start["readonly"]:
            return sdk.PermissionResultAllow(updated_input=arguments)
        if not self.active or name.startswith("mcp__") or name in {"Skill", "Task", "Agent"} or start["readonly"] and name not in READ_TOOLS:
            return sdk.PermissionResultDeny(message="不在当前项目授权能力范围内。")
        if start["readonly"]:
            selector = arguments.get("pattern") if name == "Glob" else arguments.get("glob")
            if name == "Glob" or name == "Grep" and "glob" in arguments:
                if isinstance(selector, str):
                    selector = selector.strip()
                if (not isinstance(selector, str) or Path(selector).is_absolute()
                        or PureWindowsPath(selector).is_absolute() or ".." in selector
                        or re.search(r"[\\\[\]]|(^|[{(,|])(?:/|[a-zA-Z]:/)", selector)):
                    return sdk.PermissionResultDeny(message="搜索范围必须位于当前项目内。")
            key = {"Read": "file_path", "NotebookRead": "notebook_path"}.get(name, "path")
            raw = arguments.get(key)
            if raw is None and name in {"Glob", "Grep", "LS"}:
                arguments = {**arguments, key: start["cwd"]}
            elif not isinstance(raw, str) or not raw.strip():
                return sdk.PermissionResultDeny(message="无法确认目标文件路径。")
        path_keys = [key for key in ("file_path", "path", "notebook_path")
                     if isinstance(arguments.get(key), str) and arguments[key]]
        path_key = path_keys[0] if path_keys else None
        raw_path = arguments.get(path_key) if path_key else None
        root = target = None
        for key in path_keys:
            try:
                current_root, current_target = _resolve_file_path(start["cwd"], arguments[key])
            except (OSError, RuntimeError, ValueError):
                return sdk.PermissionResultDeny(message="无法确认目标文件路径。")
            if root is not None and (current_root != root or current_target != target):
                return sdk.PermissionResultDeny(message="本次操作包含多个不同目标，无法确认执行范围。")
            root, target = current_root, current_target
        inside_project = target is None or target.is_relative_to(root)
        permission_mode = PermissionMode(start["permissionMode"])
        file_tool = name in READ_TOOLS or name in WRITE_TOOLS
        if start["readonly"] and not inside_project:
            return sdk.PermissionResultDeny(message="只读会话只能访问当前项目文件。")
        if (target is not None and not inside_project and permission_mode != PermissionMode.FULL_ACCESS
                and not file_tool):
            return sdk.PermissionResultDeny(message="目标路径不属于当前项目。")
        request_review = (
            target is not None and not inside_project and permission_mode != PermissionMode.FULL_ACCESS and file_tool
        ) or (permission_mode == PermissionMode.AUTO and name in WRITE_TOOLS)
        if request_review:
            if target is not None:
                reason = (f"请求访问项目外文件：{target}。是否允许本次操作？" if not inside_project
                          else f"自动审批请求修改项目文件：{target}。")
            else:
                reason = "自动审批请求确认文件修改。"
            reply = await self.ask("permission", {"turnId": turn_id, "toolName": name,
                "command": "", "cwd": start["cwd"], "reason": reason,
                **({"pathKey": path_key, "path": raw_path, "filePath": str(target),
                    **{key: arguments[key] for key in path_keys}} if target is not None else {})})
            if not self._current_turn(turn_id):
                return sdk.PermissionResultDeny(message="原任务状态已变化，本次确认已失效。")
            if reply != "accept":
                return sdk.PermissionResultDeny(message="用户未同意本次操作。", interrupt=reply == "cancel")
            updated_input = arguments
            if target is not None:
                for key in path_keys:
                    try:
                        _, resolved_again = _resolve_file_path(start["cwd"], arguments[key])
                    except (OSError, RuntimeError, ValueError):
                        return sdk.PermissionResultDeny(message="目标文件路径已变化，本次操作未执行。")
                    if resolved_again != target:
                        return sdk.PermissionResultDeny(message="目标文件路径已变化，本次操作未执行。")
                updated_input = {**arguments, **{key: str(target) for key in path_keys}}
            return sdk.PermissionResultAllow(updated_input=updated_input)
        if name in READ_TOOLS or name in WRITE_TOOLS and not start["readonly"]:
            if start["readonly"]:
                arguments = {**arguments, **{key: str(target) for key in path_keys}}
            return sdk.PermissionResultAllow(updated_input=arguments)
        reply = await self.ask("permission", {"turnId": turn_id, "toolName": name,
            "command": str(arguments.get("command", "")), "cwd": start["cwd"], "reason": "原生执行者请求本次操作权限。"})
        if not self._current_turn(turn_id):
            return sdk.PermissionResultDeny(message="原任务状态已变化，本次确认已失效。")
        if reply == "accept":
            return sdk.PermissionResultAllow(updated_input=arguments)
        return sdk.PermissionResultDeny(message="用户未同意本次操作。", interrupt=reply == "cancel")

    async def readonly_pre_tool(self, data: dict, _tool_use_id: str | None, context: Any) -> dict:
        name, arguments = data.get("tool_name"), data.get("tool_input")
        if data.get("hook_event_name") != "PreToolUse" or name not in READ_TOOLS or not isinstance(arguments, dict):
            decision = {"permissionDecision": "deny", "permissionDecisionReason": "只读任务只能读取当前项目文件。"}
        else:
            result = await self.permission(name, arguments, context)
            if isinstance(result, self.sdk.PermissionResultAllow):
                decision = {"permissionDecision": "allow", "updatedInput": result.updated_input}
            else:
                decision = {"permissionDecision": "deny", "permissionDecisionReason": result.message}
        return {"continue_": True, "hookSpecificOutput": {"hookEventName": "PreToolUse", **decision}}

    def build_options(self, start: dict):
        executor = ExecutorId(start["executor"])
        version = sdk_version(executor)
        sdk = importlib.import_module(SDK_MODULES[executor])
        self.sdk = sdk
        cls = sdk.ClaudeAgentOptions if executor == ExecutorId.CLAUDE else sdk.CodeBuddyAgentOptions
        fields = inspect.signature(cls).parameters
        self.effort_supported = executor == ExecutorId.CLAUDE and "effort" in fields
        required = {"cwd", "setting_sources", "mcp_servers", "hooks", "can_use_tool", "extra_args",
                    "include_partial_messages", "resume", "permission_mode"}
        if not required.issubset(fields):
            raise ValueError("sdk_contract_incompatible")
        self.permission_modes = _supported_permission_modes(cls)
        if start["permissionMode"] not in self.permission_modes:
            raise ValueError("sdk_contract_incompatible")
        permission_mode = _sdk_permission_mode(start, cls)
        work_mode = start.get("workPrompt") is not None
        if work_mode and (not isinstance(start["workPrompt"], str) or not start["workPrompt"].strip()
                          or start.get("hostCollaboration") or start.get("isSubagent")):
            raise ValueError("invalid_worker_options")
        if work_mode and executor == ExecutorId.CLAUDE and "tools" not in fields:
            raise ValueError("sdk_isolation_unsupported")
        host_tools = start.get("hostCollaboration") is True and not start["readonly"] and start.get("isSubagent") is not True
        system_prompt_append = start["context"] if not work_mode else start["workPrompt"]
        if host_tools:
            system_prompt_append = f"{system_prompt_append}\n\n{DELEGATION_INSTRUCTIONS}"
        elif start.get("isSubagent") is True:
            system_prompt_append = f"{system_prompt_append}\n\n{SUBAGENT_INSTRUCTIONS}"
        if not work_mode and executor == ExecutorId.CODEBUDDY and sys.platform == "win32":
            system_prompt_append = f"{system_prompt_append}\n\n{CODEBUDDY_WINDOWS_INSTRUCTIONS}"
        if not work_mode and executor == ExecutorId.CODEBUDDY and start["readonly"]:
            system_prompt_append = f"{system_prompt_append}\n\n{CODEBUDDY_READONLY_INSTRUCTIONS}"
        settings = {"disableAllHooks": work_mode or not start["readonly"], "autoMemoryEnabled": False,
                    "disableClaudeAiConnectors": True}
        options = {"cwd": start["cwd"], "setting_sources": [], "mcp_servers": {}, "hooks": {},
            "can_use_tool": self.permission, "include_partial_messages": True,
            "permission_mode": permission_mode, "allowed_tools": [],
            "disallowed_tools": ["mcp__*", "Skill", "Task", "Agent"],
            "env": {}, "extra_args": {}, "model": start.get("model"),
            "stderr": lambda _: None}
        if start["readonly"]:
            if not callable(getattr(sdk, "HookMatcher", None)):
                raise ValueError("sdk_contract_incompatible")
            options["hooks"] = {"PreToolUse": [sdk.HookMatcher(hooks=[self.readonly_pre_tool])]}
        if executor == ExecutorId.CLAUDE:
            if start.get("effort") is not None:
                if "effort" not in fields:
                    raise ValueError("sdk_contract_incompatible")
                options["effort"] = start["effort"]
            if not {"tools", "strict_mcp_config", "settings", "session_id", "cli_path"}.issubset(fields):
                raise ValueError("sdk_isolation_unsupported")
            options.update({"cli_path": start["executable"], "strict_mcp_config": True,
                "settings": json.dumps(settings), "plugins": [],
                "system_prompt": start["workPrompt"] if work_mode else {
                    "type": "preset", "preset": "claude_code", "append": system_prompt_append}})
            if "skills" in fields:
                options["skills"] = []
            if start.get("resume"):
                options["resume"] = start["nativeSessionId"]
            else:
                options["session_id"] = start["nativeSessionId"]
        else:
            if start.get("effort") is not None:
                raise ValueError("sdk_contract_incompatible")
            if "codebuddy_code_path" not in fields:
                raise ValueError("sdk_cli_path_unsupported")
            options["codebuddy_code_path"] = start["executable"]
            options["system_prompt"] = start["workPrompt"] if work_mode else sdk.AppendSystemPrompt(append=system_prompt_append)
            # Official CodeBuddy supports custom session IDs; unsupported native
            # versions reject startup instead of silently using another identity.
            options["extra_args"] = {"strict-mcp-config": None, "settings": json.dumps(settings)}
            if start.get("resume"):
                options["resume"] = start["nativeSessionId"]
            else:
                options["extra_args"]["session-id"] = start["nativeSessionId"]
        if work_mode:
            if not callable(getattr(sdk, "tool", None)) or not callable(getattr(sdk, "create_sdk_mcp_server", None)):
                raise ValueError("sdk_host_tools_unsupported")
            async def call_work_tool(arguments: dict) -> dict:
                return await self.host_collaboration(arguments)
            tool = sdk.tool(WORK_TOOL, WORK_DESCRIPTION, WorkToolCall.model_json_schema())(call_work_tool)
            options["mcp_servers"] = {WORK_SERVER: sdk.create_sdk_mcp_server(name=WORK_SERVER, version="1.0.0", tools=[tool])}
            options["allowed_tools"] = [SDK_WORK_TOOL]
            if "tools" in fields:
                options["tools"] = []
            else:
                options["extra_args"]["tools"] = ""
            options["disallowed_tools"] = [name for name in options["disallowed_tools"] if name != "mcp__*"]
        elif host_tools:
            if not callable(getattr(sdk, "tool", None)) or not callable(getattr(sdk, "create_sdk_mcp_server", None)):
                raise ValueError("sdk_host_tools_unsupported")
            async def collaborate(arguments: dict) -> dict:
                return await self.host_collaboration(arguments)
            tool = sdk.tool(HOST_TOOL, HOST_DESCRIPTION, HostToolCall.model_json_schema())(collaborate)
            options["mcp_servers"] = {HOST_SERVER: sdk.create_sdk_mcp_server(name=HOST_SERVER, version="1.0.0", tools=[tool])}
            options["allowed_tools"] = [SDK_HOST_TOOL]
            options["disallowed_tools"] = [name for name in options["disallowed_tools"] if name != "mcp__*"]
        self.options = cls(**options)
        if getattr(self.options, "permission_mode", None) != permission_mode:
            raise ValueError("sdk_contract_incompatible")
        self.projector = SDKEventProjector(start["nativeSessionId"], host_collaboration=host_tools,
                                           work_tool=work_mode,
                                           resuming=start.get("resume") is True)
        client_cls = sdk.ClaudeSDKClient if executor == ExecutorId.CLAUDE else sdk.CodeBuddySDKClient
        return client_cls(options=self.options), version

    async def connect_client(self, start: dict) -> dict:
        if start["executor"] == ExecutorId.CODEBUDDY.value:
            # connect(None) only spawns. An empty public input stream waits for
            # initialize but sends no user message; drain it before any real turn.
            drained = asyncio.Event()
            async def no_messages():
                for message in ():
                    yield message
                drained.set()
            await self.client.connect(prompt=no_messages())
            await asyncio.wait_for(drained.wait(), 5)
            # This SDK exposes no initialization server/model catalog. Native
            # init/tool events still enforce the exact host-tool allowlist.
            return {"models": []}
        await self.client.connect()
        query = getattr(self.client, "get_server_info", None)
        if not callable(query):
            raise ValueError("sdk_contract_incompatible")
        info = await query()
        if not isinstance(info, dict):
            raise ValueError("native_protocol_error")
        return info

    async def own_client(self, start: dict) -> None:
        receiver = None
        try:
            self.client, version = self.build_options(start)
            info = await self.connect_client(start)
            work_mode = self.projector.work_tool
            expected_server = WORK_SERVER if work_mode else HOST_SERVER
            server_enabled = work_mode or self.projector.host_collaboration
            if not host_servers_valid(info.get("mcp_servers", info.get("mcpServers", [])), server_enabled,
                                      server=expected_server):
                raise ValueError("sdk_unexpected_mcp")
            self.ready.set_result({"sdkVersion": version, "nativeSessionId": start["nativeSessionId"],
                "identityConfirmed": False, "models": info.get("models", []),
                "effortSupported": self.effort_supported,
                "hostCollaboration": self.projector.host_collaboration,
                "workMode": self.projector.work_tool,
                "permissionModes": self.permission_modes,
                "permissionMode": start["permissionMode"]})
            receiver = asyncio.create_task(self.receive())
            await self.closing.wait()
        except BaseException as exc:
            if self.ready is not None and not self.ready.done():
                self.ready.set_exception(exc if isinstance(exc, Exception) else RuntimeError("sdk_start_cancelled"))
        finally:
            if receiver:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
            for future in self.pending.values():
                if not future.done():
                    future.cancel()
            if self.client:
                with suppress(Exception, asyncio.CancelledError):
                    await self.client.disconnect()

    async def receive(self) -> None:
        try:
            async for message in self.client.receive_messages():
                for event in self.projector.consume(message):
                    self.write({"method": "event", "params": event.model_dump(mode="json")})
                    if event.type in {"run.completed", "run.failed", "run.interrupted"}:
                        self.active = None
            if self.active:
                self.write({"method": "event", "params": {"type": "run.unknown", "native_turn_id": self.active,
                    "payload": {"reason": "sdk_stream_ended_without_result"}}})
            self.closing.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.write({"method": "event", "params": {"type": "run.unknown", "native_turn_id": self.active,
                "payload": {"reason": "sdk_event_stream_failed"}}})
            self.closing.set()

    async def own_auth(self, executable: str) -> None:
        flow = sdk = None
        success = cancelled = False
        error_code = "native_authentication_failed"
        try:
            sdk_version(ExecutorId.CODEBUDDY)
            sdk = importlib.import_module(SDK_MODULES[ExecutorId.CODEBUDDY])
            region = os.environ.get("CODEBUDDY_INTERNET_ENVIRONMENT", "internal")
            if region not in {"internal", "external"}:
                raise ValueError("sdk_contract_incompatible")
            flow = await sdk.authenticate(environment=region, codebuddy_code_path=executable, env={}, timeout=300)
            self.auth_ready.set_result({"authUrl": flow.auth_url, "loginId": "codebuddy-managed"})
            await flow
            success = True
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception as exc:
            # Only typed SDK failures or its exact connection-ended diagnostic
            # become public codes. Never forward exception text, URLs or stderr.
            is_auth = isinstance(exc, getattr(sdk, "AuthenticationError", ()))
            if isinstance(exc, TimeoutError) or is_auth and getattr(exc, "error_type", None) == "timeout":
                error_code = "native_authentication_timeout"
            elif isinstance(exc, getattr(sdk, "ProcessError", ())) or (is_auth
                    and getattr(exc, "error_type", None) == "auth_failed"
                    and str(exc) in {"Authentication flow ended unexpectedly", "Connection closed before auth URL received"}):
                error_code = "native_authentication_connection_lost"
        finally:
            if flow:
                try:
                    await flow.cancel()
                except Exception:
                    success = False
                    error_code = "native_authentication_cleanup_failed"
            if not cancelled:
                if not self.auth_ready.done():
                    self.auth_ready.set_exception(RpcError(error_code, AUTH_FAILURE_REASONS[error_code]))
                else:
                    self.write({"method": "auth.completed", "params": {"success": success,
                        **({"errorCode": error_code} if not success else {})}})

    async def probe(self, params: dict) -> dict:
        if self.owner or self.auth_owner or set(params) != {"executor", "executable", "cwd"}:
            raise ValueError("invalid_probe")
        executor = ExecutorId(params["executor"])
        version = sdk_version(executor)
        cli_version = await native_version(Path(params["executable"]), executor,
            cwd=Path.home(), env=os.environ)
        self.start = {**params, "nativeSessionId": str(uuid.uuid4()), "readonly": True,
                      "context": "", "model": None, "resume": False,
                      "permissionMode": PermissionMode.ASK.value}
        self.ready = asyncio.get_running_loop().create_future()
        self.owner = asyncio.create_task(self.own_client(self.start))
        try:
            info = await asyncio.shield(self.ready)
            return {"sdkVersion": version, "version": cli_version, "protocolVerified": True,
                    "authentication": "required" if executor == ExecutorId.CLAUDE and not (os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")) else "unknown",
                    "models": info.get("models", []), "effortSupported": info.get("effortSupported", False),
                    "permissionModes": info.get("permissionModes", [])}
        finally:
            self.closing.set()
            await self.owner

    async def handle(self, method: str, params: dict) -> Any:
        if method == "probe":
            return await self.probe(params)
        if method == "auth/cancel":
            if params or self.auth_owner is None:
                raise ValueError("invalid_auth_request")
            if self.auth_owner.done():
                return {"cancelled": False}
            self.auth_owner.cancel()
            try:
                await self.auth_owner
            except asyncio.CancelledError:
                return {"cancelled": True}
            return {"cancelled": False}
        if method == "auth/start":
            if self.owner or self.auth_owner or set(params) != {"executable"}:
                raise ValueError("invalid_auth_request")
            executable = Path(params["executable"])
            if not executable.is_absolute() or not executable.is_file():
                raise ValueError("invalid_auth_executable")
            self.auth_ready = asyncio.get_running_loop().create_future()
            self.auth_owner = asyncio.create_task(self.own_auth(str(executable)))
            return await asyncio.shield(self.auth_ready)
        if method == "initialize":
            if self.owner:
                raise ValueError("worker_already_initialized")
            if set(params) - {"executor", "cwd", "executable", "nativeSessionId", "readonly", "isSubagent", "context", "model", "resume", "hostCollaboration", "workPrompt", "effort", "permissionMode"}:
                raise ValueError("invalid_worker_options")
            if params["executor"] not in {"claude", "codebuddy"} or not Path(params["cwd"]).is_dir():
                raise ValueError("invalid_worker_options")
            if not isinstance(params.get("permissionMode"), str) or params["permissionMode"] not in {mode.value for mode in PermissionMode}:
                raise ValueError("invalid_worker_options")
            if type(params.get("hostCollaboration", False)) is not bool:
                raise ValueError("invalid_worker_options")
            if type(params.get("isSubagent", False)) is not bool or params.get("isSubagent") and params.get("hostCollaboration"):
                raise ValueError("invalid_worker_options")
            work_prompt = params.get("workPrompt")
            if work_prompt is not None and (not isinstance(work_prompt, str) or not work_prompt.strip()
                                            or params.get("hostCollaboration")):
                raise ValueError("invalid_worker_options")
            if params.get("effort") is not None and (not isinstance(params["effort"], str) or not 0 < len(params["effort"]) <= 32):
                raise ValueError("invalid_worker_options")
            self.start = params
            self.ready = asyncio.get_running_loop().create_future()
            self.owner = asyncio.create_task(self.own_client(params))
            return await asyncio.shield(self.ready)
        if not self.client or not self.owner or self.owner.done():
            raise ValueError("sdk_not_connected")
        if method == "send":
            content = sdk_content(params["text"])
            async def prompt():
                yield {"type": "user", "message": {"role": "user", "content": content},
                       "session_id": self.start["nativeSessionId"]}
            async with self.dispatch:
                if self.active:
                    raise ValueError("sdk_busy")
                self.active = "sdk:" + params["inputId"]
                self.projector.begin(self.active)
                try:
                    await self.client.query(params["text"] if isinstance(params["text"], str) else prompt(),
                                            session_id=self.start["nativeSessionId"])
                except BaseException:
                    self.write({"method": "event", "params": {"type": "run.unknown", "native_turn_id": self.active,
                        "payload": {"reason": "sdk_dispatch_outcome_unknown"}}})
                    raise
                return {"inputId": params["inputId"], "turnId": self.projector.turn_id,
                        "turnIdentitySource": "host_dispatch"}
        if method == "interrupt":
            await self.client.interrupt()
            return {"outcome": "requested"}
        if method == "status":
            return {"status": "running" if self.active else "idle", "identityConfirmed": self.projector.confirmed}
        if method == "close":
            if self.active:
                raise ValueError("sdk_busy")
            self.closing.set()
            await self.owner
            return {"closed": True}
        raise ValueError("unsupported_worker_method")

    async def request(self, message: dict) -> None:
        try:
            result = await self.handle(message["method"], message.get("params", {}))
            self.write({"id": message["id"], "result": result})
        except Exception as exc:
            # Never send exception strings or SDK stderr: they can contain keys.
            code = exc.code if isinstance(exc, RpcError) and exc.code in ERRORS else (
                str(exc) if type(exc) is ValueError and str(exc) in ERRORS else
                "sdk_dependency_missing" if isinstance(exc, ImportError) else
                "executable_access_denied" if isinstance(exc, PermissionError) else
                "native_authentication_failed" if type(exc).__name__ == "AuthenticationError" else "native_startup_failed")
            self.write({"id": message.get("id"), "error": {"code": -32000,
                "message": "SDK request failed", "data": {"monaCode": code}}})

    async def serve(self) -> None:
        try:
            while True:
                raw = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME + 1)
                if not raw:
                    break
                if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
                    raise ValueError("invalid_frame")
                message = json.loads(raw)
                if "method" in message:
                    task = asyncio.create_task(self.request(message))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                elif message.get("id") in self.pending:
                    future = self.pending[message["id"]]
                    if not future.done():
                        future.set_result(message.get("result", "decline"))
        finally:
            self.closing.set()
            for task in list(self.tasks):
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            if self.auth_owner:
                self.auth_owner.cancel()
                await asyncio.gather(self.auth_owner, return_exceptions=True)
            if self.owner:
                await self.owner


def main() -> None:
    asyncio.run(Worker().serve())


if __name__ == "__main__":
    main()
