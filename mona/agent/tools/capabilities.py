"""Request-scoped discovery and loading for specialized Agent tools."""

from __future__ import annotations

import json
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import RequestContext
from mona.agent.tools.schema import (
    ArraySchema,
    StringSchema,
    tool_parameters_schema,
)

CAPABILITY_TOOL_GROUPS: dict[str, frozenset[str]] = {
    "development": frozenset(
        {"apply_patch", "edit_file", "write_file", "grep", "exec", "write_stdin", "list_exec_sessions"}
    ),
    "skill_resources": frozenset(
        {"skill_reference_read", "skill_script_run", "skill_asset_copy"}
    ),
    "http": frozenset({"http_request"}),
    "office": frozenset({"document", "generate_report", "office", "pdf"}),
    "image": frozenset({"generate_image", "message"}),
    "video": frozenset({"generate_video", "message", "video_extract_frame"}),
    "email": frozenset({"email_action", "email_read", "email_search"}),
    "database": frozenset({"db_inspect", "db_query", "db_sql_draft"}),
    "terminal": frozenset(
        {"terminal_exec", "terminal_output", "terminal_task", "terminal_upload"}
    ),
    "notes_write": frozenset(
        {"notes_create", "notes_save_image", "url2note", "video_extract_frame"}
    ),
    "saved_memory": frozenset({"hoard_capture", "hoard_search"}),
    "messaging": frozenset({"message"}),
    "automation": frozenset({"heartbeat_update", "schedule", "todo"}),
    "browser": frozenset({"browser_act", "browser_observe"}),
    "computer": frozenset({"computer_act", "computer_observe"}),
}
CAPABILITY_NAMES = tuple(CAPABILITY_TOOL_GROUPS)
_TOOL_CAPABILITIES: dict[str, frozenset[str]] = {
    tool_name: frozenset(
        capability
        for capability, tool_names in CAPABILITY_TOOL_GROUPS.items()
        if tool_name in tool_names
    )
    for tool_name in {
        tool_name
        for tool_names in CAPABILITY_TOOL_GROUPS.values()
        for tool_name in tool_names
    }
}
_ACTIVE_CAPABILITIES: ContextVar[set[str] | None] = ContextVar(
    "mona_active_capabilities",
    default=None,
)


def _metadata_capabilities(metadata: dict[str, Any]) -> set[str]:
    active: set[str] = set()
    if metadata.get("office_session_id") or metadata.get("office_document_type"):
        active.add("office")
    if metadata.get("connection_id"):
        active.add("database")
    if metadata.get("terminal_session_id"):
        active.add("terminal")
    if any(
        metadata.get(key)
        for key in ("browser_tab_id", "browser_page_url", "browser_page_title")
    ):
        active.add("browser")
    image_mode = metadata.get("image_generation")
    if isinstance(image_mode, dict) and image_mode.get("enabled") is True:
        active.add("image")
    video_mode = metadata.get("video_generation")
    if isinstance(video_mode, dict) and video_mode.get("enabled") is True:
        active.add("video")
    return active


def bind_capability_context(ctx: RequestContext) -> None:
    """Start an isolated capability view for one request."""
    active = _metadata_capabilities(ctx.metadata or {})
    # Common desktop tools are visible immediately; registry permissions still apply.
    active.add("computer")
    if ctx.terminal_session_id:
        active.add("terminal")
    _ACTIVE_CAPABILITIES.set(active)


def activate_capabilities(capabilities: set[str]) -> set[str]:
    """Activate capabilities in this request and return newly activated names."""
    valid = set(capabilities) & set(CAPABILITY_NAMES)
    active = _ACTIVE_CAPABILITIES.get()
    if active is None:
        active = set()
        _ACTIVE_CAPABILITIES.set(active)
    added = valid - active
    active.update(valid)
    return added


def activate_capabilities_for_media(media: list[str] | None) -> None:
    active: set[str] = set()
    for raw_path in media or []:
        suffix = Path(raw_path).suffix.lower()
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}:
            active.add("image")
        elif suffix in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}:
            active.add("video")
    if active:
        activate_capabilities(active)


def activate_capabilities_for_history(history: list[dict[str, Any]]) -> None:
    """Restore discovery from retained calls without replaying any execution."""
    active: set[str] = set()
    for message in history:
        if message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function", {})
            if not isinstance(function, dict) or not isinstance(function.get("name"), str):
                continue
            name = function.get("name", "")
            if name == "load_capability":
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except (ValueError, TypeError):
                        continue
                if isinstance(arguments, dict) and isinstance(arguments.get("capabilities"), list):
                    active.update(value for value in arguments["capabilities"] if isinstance(value, str))
            elif name == "skill_read":
                active.add("skill_resources")
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except (ValueError, TypeError):
                        arguments = {}
                if isinstance(arguments, dict) and arguments.get("name") in {
                    "pdf", "mona-docx", "mona-xlsx", "mona-pptx",
                }:
                    active.add("office")
            else:
                groups = capabilities_for_tool(name)
                # Shared delivery tools do not imply that every media pack was used.
                if len(groups) == 1:
                    active.update(groups)
    if active:
        activate_capabilities(active)


def capabilities_for_tool(tool_name: str) -> frozenset[str]:
    return _TOOL_CAPABILITIES.get(tool_name, frozenset())


def tool_enabled_by_capability(tool_name: str) -> bool:
    """Keep compatibility outside a bound Agent turn; filter inside one."""
    groups = capabilities_for_tool(tool_name)
    active = _ACTIVE_CAPABILITIES.get()
    return not groups or active is None or bool(groups & active)


@tool_parameters(
    tool_parameters_schema(
        capabilities=ArraySchema(
            StringSchema(enum=CAPABILITY_NAMES),
            description="Specialized capability packs needed for the current task.",
            min_items=1,
            max_items=len(CAPABILITY_NAMES),
        ),
        required=["capabilities"],
    )
)
class LoadCapabilityTool(Tool):
    """Load specialized tool definitions after the model understands the task."""

    _scopes = {"core"}
    system_managed = True
    name = "load_capability"
    description = (
        "Load specialized tools from natural-language intent without asking the user "
        "to name a tool or mode. Packs: development (edit/write files, search code, run commands), "
        "skill_resources (skill references/scripts/assets; also enabled by skill_read), "
        "http (direct API requests), office (documents/spreadsheets/slides/PDF), image, "
        "video, email, database, terminal, notes_write (create/save notes), saved_memory "
        "(previously saved links/fragments), messaging (proactive/cross-channel), "
        "automation (reminders/todos/heartbeat), browser (Mona's built-in browser), "
        "computer (desktop screenshots, applications, external browsers and games; "
        "already visible when authorized). "
        "Load every pack required by a mixed task before using its tools."
    )

    def __init__(
        self,
        *,
        workspace: str | Path,
        agent_id: str,
        registry: Any | None = None,
    ) -> None:
        self._workspace = Path(workspace)
        self._agent_id = agent_id
        self._registry = registry

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            workspace=ctx.workspace,
            agent_id=getattr(ctx, "agent_id", "mona"),
            registry=getattr(ctx, "registry", None),
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, capabilities: list[str], **kwargs: Any) -> str:
        requested = {
            name.strip()
            for name in capabilities
            if isinstance(name, str) and name.strip()
        }
        invalid = sorted(requested - set(CAPABILITY_NAMES))
        if invalid:
            return f"Error: unknown capabilities: {', '.join(invalid)}"
        if not requested:
            return "Error: at least one capability is required"

        added = activate_capabilities(requested)
        requested_tools = {
            name
            for capability in requested
            for name in CAPABILITY_TOOL_GROUPS[capability]
        }
        available_tools: list[str] = []
        if self._registry is not None:
            available_tools = sorted(
                definition["function"]["name"]
                for definition in self._registry.get_definitions()
                if definition["function"]["name"] in requested_tools
            )

        parts = [
            f"Loaded capabilities: {', '.join(sorted(requested))}.",
            "Available tools: "
            + (", ".join(available_tools) if available_tools else "none in this configuration"),
        ]
        from mona.utils.prompt_templates import render_template

        newly_loaded_tools = {
            name for capability in added for name in CAPABILITY_TOOL_GROUPS[capability]
        } & set(available_tools)
        instructions = render_template(
            "agent/capability_contract.md", tool_names=newly_loaded_tools, strip=True,
        )
        if instructions:
            parts.append(instructions)
        if "image" in added and "generate_image" in available_tools:
            from mona.agent.skills import SkillsLoader

            skill = SkillsLoader(
                self._workspace,
                agent_id=self._agent_id,
            ).load_skills_for_context(["image-generation"])
            if skill:
                activate_capabilities({"skill_resources"})
                parts.append("# Required image-generation instructions\n\n" + skill)
                parts.append("Skill resource tools are now available for references, scripts and assets.")
        return "\n\n".join(parts)


__all__ = [
    "CAPABILITY_NAMES",
    "CAPABILITY_TOOL_GROUPS",
    "LoadCapabilityTool",
    "activate_capabilities",
    "activate_capabilities_for_media",
    "activate_capabilities_for_history",
    "bind_capability_context",
    "capabilities_for_tool",
    "tool_enabled_by_capability",
]
