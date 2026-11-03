"""Vendor boundary only: run the real worker/IPC with one mixed native/host batch."""
import asyncio
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import sdk_peer


@dataclass
class HookMatcher:
    hooks: list
    matcher: str | None = None
    timeout: float | None = None


class Client(sdk_peer.Client):
    async def connect(self, prompt=None):
        assert self.options.setting_sources == []
        assert self.options.tools == ["Write"]
        assert self.options.allowed_tools == ["mcp__mona_work__mona_tool"]
        assert set(self.options.mcp_servers) == {"mona_work"}
        assert set(self.options.hooks) == {"PreToolUse", "PostToolUse", "PostToolUseFailure"}
        assert self.options.permission_mode == "default"
        self.owner = asyncio.current_task()
        prompt_file = Path(self.options.extra_args["system-prompt-file"])
        sdk_peer.trace({"method": "connect", "nativeId": self.id,
                        "system_sha": hashlib.sha256(prompt_file.read_bytes()).hexdigest()})
        if prompt is not None:
            async for _ in prompt:
                raise AssertionError("initialization cannot submit a model request")

    async def query(self, prompt, session_id="default"):
        messages = [message async for message in prompt]
        assert len(messages) == 1 and messages[0]["session_id"] == self.id
        blocks = messages[0]["message"]["content"]
        sdk_peer.trace({"method": "query", "nativeId": self.id,
                        "has_image": any(block["type"] == "image" for block in blocks)})
        await self.events.put({"type": "system", "subtype": "init", "session_id": self.id,
                               "mcp_servers": [{"name": "mona_work"}]})
        if any(block["type"] == "image" for block in blocks):
            # A replacement receives the exact image and completed operation audit,
            # not an instruction to repeat the first batch's writes.
            text = json.dumps(blocks)
            assert "native-write" in text and "completed" in text
            assert Path("native-once.txt").read_text(encoding="utf8") == "once\n"
            assert Path("business-once.txt").read_text(encoding="utf8") == "once\n"
            await self.finish("mixed task completed")
            return
        self.tasks.append(asyncio.create_task(self.mixed_batch()))

    async def mixed_batch(self):
        native_args = {"file_path": str(Path.cwd() / "native-once.txt"), "content": "once\n"}
        await self.events.put({"type": "assistant", "session_id": self.id, "content": [
            {"type": "tool_use", "id": "native-write", "name": "Write", "input": native_args},
            {"type": "tool_use", "id": "host-image", "name": "mcp__mona_work__mona_tool", "input": {}},
            {"type": "tool_use", "id": "host-save", "name": "mcp__mona_work__mona_tool", "input": {}},
        ]})
        async def native():
            hook_input = {"hook_event_name": "PreToolUse", "session_id": self.id,
                          "tool_use_id": "native-write", "tool_name": "Write", "tool_input": native_args}
            hook = self.options.hooks["PreToolUse"][0].hooks[0]
            approval = await hook(hook_input, "native-write", None)
            assert approval["hookSpecificOutput"]["permissionDecision"] == "allow"
            with Path("native-once.txt").open("a", encoding="utf8") as stream:
                stream.write("once\n")
            sdk_peer.trace({"method": "native-write", "nativeId": self.id})
            await asyncio.sleep(0.05)
            await self.options.hooks["PostToolUse"][0].hooks[0](
                {**hook_input, "hook_event_name": "PostToolUse", "tool_response": {"success": True}}, "native-write", None)
        wrapped = self.options.mcp_servers["mona_work"]["instance"]["mona_tool"]
        async def business(name):
            return await wrapped.handler({"tool": name, "arguments": {}})
        # Ordinary native UserMessage results intentionally wait for the whole
        # batch, reproducing the feedback cycle seen in WorkBuddy.
        await asyncio.gather(native(), business("fixture_image"), business("fixture_business_save"))
        await self.events.put({"type": "user", "session_id": self.id, "content": [
            {"type": "tool_result", "tool_use_id": "native-write", "content": "saved", "is_error": False}]})
        await self.finish("unexpected image stringification")


if __name__ == "__main__":
    sdk_peer.Client = Client
    sdk_peer.HookMatcher = HookMatcher
    sdk_peer.main()
