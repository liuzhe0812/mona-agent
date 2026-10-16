"""Dependency seam for the production SDK worker, not an official CLI emulator.

The worker, pipes, permission bridge, SDK adapter and database remain production
code. Only vendor SDK calls are substituted; this is not vendor acceptance.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any


@dataclass
class Options:
    cwd: str = ""
    setting_sources: list = field(default_factory=list)
    mcp_servers: dict = field(default_factory=dict)
    hooks: dict = field(default_factory=dict)
    can_use_tool: Any = None
    extra_args: dict = field(default_factory=dict)
    include_partial_messages: bool = True
    resume: str | None = None
    session_id: str | None = None
    tools: list | None = None
    strict_mcp_config: bool = False
    settings: str | None = None
    cli_path: str | None = None
    codebuddy_code_path: str | None = None
    plugins: list = field(default_factory=list)
    skills: list = field(default_factory=list)
    system_prompt: Any = None
    permission_mode: str = "default"
    allowed_tools: list = field(default_factory=list)
    disallowed_tools: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    model: str | None = None
    effort: str | None = None
    stderr: Any = None


@dataclass
class Allow:
    updated_input: dict


@dataclass
class Deny:
    message: str
    interrupt: bool = False


@dataclass
class AppendPrompt:
    append: str


@dataclass
class HookMatcher:
    hooks: list


def trace(row):
    with (Path.cwd() / "sdk-peer-trace.jsonl").open("a", encoding="utf8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")


@dataclass
class SdkTool:
    name: str
    description: str
    input_schema: dict
    handler: Any


def tool(name, description, input_schema):
    return lambda handler: SdkTool(name, description, input_schema, handler)


def create_sdk_mcp_server(*, name, version="1.0.0", tools=None):
    return {"type": "sdk", "name": name, "instance": {t.name: t for t in tools or []}}


class Client:
    def __init__(self, options):
        self.options = options
        self.events = asyncio.Queue()
        self.tasks = []
        self.id = options.resume or options.session_id or options.extra_args.get("session-id")
        self.owner = None

    async def connect(self, prompt=None):
        assert self.options.setting_sources == []
        assert set(self.options.hooks).issubset({"PreToolUse"})
        assert set(self.options.mcp_servers).issubset({"mona_development", "mona_work"})
        if "mona_work" in self.options.mcp_servers:
            assert self.options.tools == []
            assert self.options.allowed_tools == ["mcp__mona_work__mona_tool"]
        elif self.options.mcp_servers:
            assert self.options.allowed_tools == ["mcp__mona_development__development_collaboration"]
        assert self.options.env == {} and self.options.permission_mode == "default"
        assert "Skill" in self.options.disallowed_tools
        self.owner = asyncio.current_task()
        system = self.options.system_prompt
        prompt_file = system.get("path") if isinstance(system, dict) and system.get("type") == "file" else (
            self.options.extra_args.get("system-prompt-file") if "mona_work" in self.options.mcp_servers else None)
        if prompt_file:
            prompt_text = Path(prompt_file).read_text(encoding="utf-8")
            system = {"type": "file", "sha256": hashlib.sha256(prompt_text.encode("utf-8")).hexdigest(),
                      "length": len(prompt_text)}
        elif hasattr(system, "append"):
            system = system.append
        trace({"method": "connect", "localOAuth": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")),
               "apiKeyPresent": bool(os.environ.get("ANTHROPIC_API_KEY")),
               "hostManaged": os.environ.get("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") == "1", "nativeId": self.id, "resume": self.options.resume,
               "model": self.options.model, "effort": self.options.effort,
               "system": system})

        if prompt is not None:
            async for message in prompt:
                raise AssertionError("Initialization must not submit a user message")

    async def get_server_info(self):
        return {"models": [{"value": "peer-model", "supportsEffort": True,
            "supportedEffortLevels": ["low", "high"], "defaultEffort": "high"}],
            "mcpServers": list(self.options.mcp_servers)}

    async def query(self, text, session_id="default"):
        structured = None
        if not isinstance(text, str):
            messages = [message async for message in text]
            assert len(messages) == 1 and messages[0]["type"] == "user"
            assert messages[0]["session_id"] == session_id
            structured = messages[0]["message"]["content"]
            text = "\n\n".join(block["text"] for block in structured if block["type"] == "text")
        trace({"method": "query", "nativeId": self.id, "input": text, "sessionId": session_id,
               **({"content": structured} if structured is not None else {})})
        text = text.rsplit("[/Mona handoff — current user request follows]", 1)[-1].strip()
        text = text.rsplit("[/Runtime Context]", 1)[-1].strip()
        if text.startswith("协作目标：hold\n"):
            text = "hold"
        if text == "require_history":
            history = Path(f"sdk-peer-history-{self.id}")
            if self.options.resume and not history.exists():
                await self.events.put({"type": "error", "session_id": self.id,
                    "error": f"No conversation found with session ID: {self.id}"})
                return
            history.write_text("native history created by first prompt", encoding="utf8")
        if text == "lost_ack":
            raise ConnectionError("response unavailable after query was written")
        await self.events.put({"type": "system", "subtype": "init", "session_id": self.id,
                               "mcp_servers": [{"name": name} for name in self.options.mcp_servers]})
        if text in {"delegate_host", "delegate_early"}:
            self.tasks.append(asyncio.create_task(self.delegate_host(skip_wait=text == "delegate_early")))
            return
        if text == "work_tool":
            self.tasks.append(asyncio.create_task(self.call_work_tool()))
            return
        if text == "hold":
            return
        if "READONLY_NATIVE_TOOLS_FIXTURE" in text:
            self.tasks.append(asyncio.create_task(self.readonly_native_tools()))
            return
        if text in {"question", "permission"}:
            task = asyncio.create_task(self.request_decision(text))
            self.tasks.append(task)
            return
        if "SPLIT_ENVELOPE_PROTOCOL_FIXTURE" in text:
            async def stream(event, key):
                await self.events.put({"type": "stream_event", "event": event, "uuid": key, "session_id": self.id})
            await stream({"type": "message_start", "message": {"id": "fixture-message"}}, "message-start")
            await stream({"type": "content_block_start", "index": 0,
                "content_block": {"type": "thinking", "thinking": "Inspect source."}}, "thinking-start")
            await stream({"type": "content_block_stop", "index": 0}, "thinking-stop")
            await stream({"type": "content_block_start", "index": 1,
                "content_block": {"type": "text", "text": ""}}, "text-start")
            await stream({"type": "content_block_delta", "index": 1,
                "delta": {"type": "text_delta", "text": "Inspecting"}}, "text-delta")
            await stream({"type": "content_block_start", "index": 2,
                "content_block": {"type": "tool_use", "id": "read-source", "name": "Read", "input": {}}}, "tool-start")
            for block in ({"type": "thinking", "thinking": "Inspect source."},
                          {"type": "text", "text": "Inspecting source."},
                          {"type": "tool_use", "id": "read-source", "name": "Read", "input": {"file_path": "manual.txt"}}):
                await self.events.put({"type": "assistant", "content": [block]})
            await self.events.put({"type": "user", "content": [{"type": "tool_result", "tool_use_id": "read-source",
                "content": Path("manual.txt").read_text(encoding="utf8")}]})
            await self.finish("SPLIT_RESULT_VERIFIED")
            return
        await self.finish("ok:" + text, "new_result_type" if text == "new_result" else "success")

    async def delegate_host(self, *, skip_wait=False):
        wrapped = self.options.mcp_servers["mona_development"]["instance"]["development_collaboration"]
        async def invoke(step, arguments):
            name = "mcp__mona_development__development_collaboration"
            call_id = "host-" + step
            permission = await self.options.can_use_tool(name, arguments, None)
            assert isinstance(permission, Allow)
            await self.events.put({"type": "assistant", "content": [{"type": "tool_use",
                "id": call_id, "name": name, "input": arguments}]})
            result = await wrapped.handler(arguments)
            await self.events.put({"type": "user", "content": [{"type": "tool_result",
                "tool_use_id": call_id, "content": result["content"], "is_error": result.get("isError", False)}]})
            trace({"method": "host-tool-result", "nativeId": self.id, "step": step, "result": result})
            if result.get("isError"):
                raise ValueError("Host call rejected")
            return json.loads(result["content"][0]["text"])
        try:
            presets = await invoke("presets", {"action": "presets"})
            child = await invoke("start", {"action": "start", "request_id": "review_once",
                "preset_id": next(p["id"] for p in presets if p["id"] == "reviewer"), "goal": "Review project; preserve MANUAL_CONTENT"})
            if skip_wait:
                await self.finish("LEADER_PREMATURE_END")
                return
            value = await invoke("wait", {"action": "wait", "task_id": child["id"], "seconds": 5})
            await self.finish("HOST_RESULT_CONSUMED:" + value.get("result", ""))
        except Exception as exc:
            await self.finish("Host callback failed: " + type(exc).__name__, "error")

    async def call_work_tool(self):
        wrapped = self.options.mcp_servers["mona_work"]["instance"]["mona_tool"]
        arguments = {"tool": "read_file", "arguments": {"path": "manual.txt"}}
        name = "mcp__mona_work__mona_tool"
        permission = await self.options.can_use_tool(name, arguments, None)
        assert isinstance(permission, Allow)
        await self.events.put({"type": "assistant", "content": [{"type": "tool_use",
            "id": "work-tool-call", "name": name, "input": arguments}]})
        result = await wrapped.handler(arguments)
        await self.events.put({"type": "user", "content": [{"type": "tool_result",
            "tool_use_id": "work-tool-call", "content": result["content"],
            "is_error": result.get("isError", False)}]})
        await self.finish("WORK_TOOL_RESULT:" + result["content"][0]["text"])

    async def request_decision(self, text):
        arguments = {"questions": [{"question": "选择目标环境", "header": "环境", "options": [{"label": "内网"}, {"label": "测试"}]}]} if text == "question" else {"command": "echo harmless"}
        result = await self.options.can_use_tool("AskUserQuestion" if text == "question" else "Bash", arguments, None)
        if isinstance(result, Allow):
            await self.finish("answer:" + json.dumps(result.updated_input, ensure_ascii=False))
        else:
            await self.finish("denied", "interrupted" if result.interrupt else "success")

    async def finish(self, text, subtype="success"):
        await self.events.put({"type": "assistant", "content": [{"type": "text", "text": text}]})
        await self.events.put({"type": "result", "subtype": subtype, "is_error": False,
                               "session_id": self.id, "result": text, "usage": {"input_tokens": 9, "output_tokens": 4}})

    async def receive_messages(self):
        while True:
            yield await self.events.get()

    async def readonly_native_tools(self):
        assert self.options.tools is None and "tools" not in self.options.extra_args
        assert "Bash" not in self.options.disallowed_tools
        hook = self.options.hooks["PreToolUse"][0].hooks[0]
        denied = await hook({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                             "tool_input": {"command": "echo side effect"}}, "denied-tool", {})
        assert denied["continue_"] is True
        assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
        allowed = await hook({"hook_event_name": "PreToolUse", "tool_name": "Read",
                              "tool_input": {"file_path": "AGENTS.md"}}, "read-tool", {})
        assert allowed["hookSpecificOutput"]["permissionDecision"] == "allow"
        path = Path(allowed["hookSpecificOutput"]["updatedInput"]["file_path"])
        await self.finish(path.read_text(encoding="utf8"))

    async def interrupt(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.finish("interrupted", "interrupted")

    async def disconnect(self):
        assert asyncio.current_task() is self.owner, "SDK lifetime crossed owner task"
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        trace({"method": "disconnect", "nativeId": self.id, "sameOwner": True})


class AuthFlow:
    auth_url = "https://codebuddy.cn/test-only-login"

    def __init__(self):
        self.owner = asyncio.current_task()
        trace({"method": "auth-start"})

    async def wait(self):
        while not Path("auth-outcome.txt").exists():
            await asyncio.sleep(.01)
        if Path("auth-outcome.txt").read_text() == "timeout":
            raise TimeoutError("PRIVATE_AUTH_DIAGNOSTIC")
        if Path("auth-outcome.txt").read_text() == "failed":
            raise RuntimeError("PRIVATE_AUTH_DIAGNOSTIC")
        return {}

    def __await__(self):
        return self.wait().__await__()

    async def cancel(self):
        assert asyncio.current_task() is self.owner
        trace({"method": "auth-release", "sameOwner": True})


async def authenticate(**kwargs):
    assert kwargs["env"] == {} and kwargs["timeout"] == 300
    return AuthFlow()


def main():
    from mona.development.executors import sdk_worker
    for name in ("claude_agent_sdk", "codebuddy_agent_sdk"):
        module = ModuleType(name)
        module.ClaudeAgentOptions = module.CodeBuddyAgentOptions = Options
        module.ClaudeSDKClient = module.CodeBuddySDKClient = Client
        module.PermissionResultAllow, module.PermissionResultDeny = Allow, Deny
        module.AppendSystemPrompt = AppendPrompt
        module.HookMatcher = HookMatcher
        module.authenticate = authenticate
        module.tool = tool
        module.create_sdk_mcp_server = create_sdk_mcp_server
        sys.modules[name] = module
    sdk_worker.sdk_version = lambda _executor: "test-peer"
    async def version(*_args, **_kwargs):
        trace({"method": "version"})
        return "0.0.0-test-peer"
    sdk_worker.native_version = version
    sdk_worker.main()


if __name__ == "__main__":
    main()
