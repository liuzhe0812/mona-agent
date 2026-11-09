"""Bind the shared request capability loader to Hosted Work's authorized tools."""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from mona.agent.tools.capabilities import LoadCapabilityTool


class HostedLoadCapabilityTool(LoadCapabilityTool):
    def __init__(self, *, skills, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._hosted_skills = skills
        self._image_skill: ContextVar[str | None] = ContextVar("hosted_image_skill", default=None)

    def _load_image_skill(self) -> str:
        content = self._image_skill.get()
        if not content:
            return ""
        self._hosted_skills.loaded.add("image-generation")
        self._hosted_skills._allow_resources()
        return self._hosted_skills._public(content)

    async def execute(self, capabilities: list[str], **kwargs: Any) -> str:
        content = None
        if (any(isinstance(name, str) and name.strip() == "image" for name in capabilities)
                and self._registry is not None and self._registry.is_permitted("generate_image")):
            try:
                if "image-generation" in self._hosted_skills.project:
                    source = self._hosted_skills.project["image-generation"]["content"]
                    content = "### Skill: image-generation\n\n" + self._hosted_skills.loader._strip_frontmatter(source)
                else:
                    self._hosted_skills.file("image-generation", "SKILL.md", loaded=False)
                    content = self._hosted_skills.loader.load_skills_for_context(["image-generation"], track_usage=False)
                if not content:
                    raise ValueError("missing builtin image skill")
            except (OSError, ValueError, TypeError):
                return "Error: 图片技能不可用，未启用图片能力。"
        context = self._image_skill.set(content)
        try:
            return await super().execute(capabilities, **kwargs)
        finally:
            self._image_skill.reset(context)


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
