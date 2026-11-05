"""Bind the shared request capability loader to Hosted Work's authorized tools."""
from __future__ import annotations

from typing import Any

from mona.agent.tools.capabilities import LoadCapabilityTool


class HostedLoadCapabilityTool(LoadCapabilityTool):
    async def execute(self, capabilities: list[str], **kwargs: Any) -> str:
        # The desktop loader creates a default (private-inclusive) SkillsLoader
        # for image generation. Hosted must not use that path; an eventual image
        # adapter needs explicit builtin-only loader injection first.
        if ("image" in capabilities and self._registry is not None
                and self._registry.is_permitted("generate_image")):
            return "Error: 图片能力尚未完成当前工作台的隔离接入。"
        return await super().execute(capabilities, **kwargs)


def retained_capability_history(history, successful_skill_reads: set[str]) -> list[dict]:
    """Restore only retained calls; an unsuccessful Skill read grants no resources."""
    retained = []
    for message in history:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        calls = []
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            if (isinstance(function, dict) and function.get("name") == "skill_read"
                    and call.get("id") not in successful_skill_reads):
                continue
            calls.append(call)
        retained.append({"role": "assistant", "tool_calls": calls})
    return retained
