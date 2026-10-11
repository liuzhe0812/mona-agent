"""Small Code-only extension loader; never consults Work capabilities or Skills."""
from __future__ import annotations

import json

from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry


class CodingExtensionLoader(Tool):
    def __init__(self, registry: ToolRegistry, base: set[str], extensions: dict[str, Tool]):
        self.registry, self.base, self.extensions = registry, set(base), dict(extensions)
        self.loaded: set[str] = set()

    @property
    def name(self) -> str:
        return "load_coding_tools"

    @property
    def description(self) -> str:
        options = "; ".join(f"{name}: {tool.description}" for name, tool in self.extensions.items())
        return "Load optional development tools only when needed. Simple tasks use the base tools directly. " + options

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {"capability": {"type": "string", "enum": list(self.extensions)}},
                "required": ["capability"], "additionalProperties": False}

    def restore(self, messages: list[dict]) -> None:
        # Only restore schema visibility, never replay calls. Current assembly
        # supplies the allowlist and new per-run tool instances.
        called = {call.get("function", {}).get("name") for message in messages
                  for call in message.get("tool_calls", []) if isinstance(call, dict)}
        self.loaded = {name for name, tool in self.extensions.items() if tool.name in called}
        self._refresh()

    def _refresh(self) -> None:
        self.registry.set_allowed_tool_names(self.base | {self.name}
            | {self.extensions[name].name for name in self.loaded})

    async def execute(self, capability: str) -> str:
        if capability not in self.extensions:
            return "Error: This coding capability is not available in the current session."
        self.loaded.add(capability)
        self._refresh()
        return json.dumps({"loaded": capability, "tool": self.extensions[capability].to_schema()}, ensure_ascii=False)
