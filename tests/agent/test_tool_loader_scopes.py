from unittest.mock import MagicMock

import pytest

from mona.agent.jobs import AgentJob
from mona.agent.partners import AgentDefinition
from mona.agent.subagent import SubagentManager
from mona.agent.tools import knowledge_search as knowledge_module
from mona.agent.tools.base import Tool
from mona.agent.tools.context import ToolContext
from mona.agent.tools.knowledge_search import (
    KnowledgeSearchTool,
    MaterialsReadTool,
    MaterialsSearchTool,
    NotesSearchTool,
    WikiReadTool,
    WikiSearchTool,
)
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.long_task import CompleteGoalTool, LongTaskTool
from mona.agent.tools.notes import NotesCreateTool, NotesReadTool, NotesSaveImageTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.user_config import (
    USER_GRANTABLE_PLATFORM_TOOLS,
    AgentUserConfig,
    configurable_agent_tools,
    resolve_effective_agent_config,
)
from mona.bus.queue import MessageBus
from mona.config.schema import ToolsConfig
from mona.providers.base import LLMProvider
from mona.session.manager import SessionManager


class _CoreOnlyTool(Tool):
    _scopes = {"core"}

    @property
    def name(self):
        return "core_only"

    @property
    def description(self):
        return "..."

    @property
    def parameters(self):
        return {"type": "object"}

    async def execute(self, **_):
        return "ok"


class _SubagentOnlyTool(Tool):
    _scopes = {"subagent"}

    @property
    def name(self):
        return "sub_only"

    @property
    def description(self):
        return "..."

    @property
    def parameters(self):
        return {"type": "object"}

    async def execute(self, **_):
        return "ok"


class _UniversalTool(Tool):
    _scopes = {"core", "subagent", "memory"}

    @property
    def name(self):
        return "universal"

    @property
    def description(self):
        return "..."

    @property
    def parameters(self):
        return {"type": "object"}

    async def execute(self, **_):
        return "ok"


@pytest.mark.asyncio
async def test_loader_filters_by_scope():
    from mona.agent.tools.registry import ToolRegistry

    loader = ToolLoader(test_classes=[_CoreOnlyTool, _SubagentOnlyTool, _UniversalTool])

    registry = ToolRegistry()
    ctx = ToolContext(config={}, workspace="/tmp")
    loader.load(ctx, registry, scope="core")

    assert registry.has("core_only")
    assert not registry.has("sub_only")
    assert registry.has("universal")


def test_goal_tools_are_available_to_subagents_only_when_allowlisted(tmp_path):
    ctx = ToolContext(
        config={},
        workspace=str(tmp_path),
        sessions=SessionManager(tmp_path / "sessions"),
        agent_id="com.example.partner",
    )
    loader = ToolLoader(test_classes=[LongTaskTool, CompleteGoalTool])

    allowlisted = ToolRegistry()
    registered = loader.load(
        ctx,
        allowlisted,
        scope="subagent",
        tool_allowlist=["long_task", "complete_goal"],
    )
    assert {"long_task", "complete_goal"} <= set(registered)

    narrowed = ToolRegistry()
    registered = loader.load(
        ctx,
        narrowed,
        scope="subagent",
        tool_allowlist=["long_task"],
    )
    assert registered == ["long_task"]
    assert narrowed.has("long_task")
    assert not narrowed.has("complete_goal")


def test_goal_tools_keep_core_scope_for_mona(tmp_path):
    ctx = ToolContext(config={}, workspace=str(tmp_path), sessions=SessionManager(tmp_path / "sessions"))
    registry = ToolRegistry()
    ToolLoader(test_classes=[LongTaskTool, CompleteGoalTool]).load(
        ctx,
        registry,
        scope="core",
        tool_allowlist=["long_task", "complete_goal"],
    )
    assert registry.has("long_task")
    assert registry.has("complete_goal")


def _partner_definition() -> AgentDefinition:
    return AgentDefinition(
        id="com.example.writer",
        display_name="Writer",
        tool_allowlist=["web_search"],
    )


def _subagent_manager(tmp_path, *, has_subscription: bool, tools_config=None):
    provider = MagicMock(spec=LLMProvider)
    provider.get_default_model.return_value = "test"
    return SubagentManager(
        provider=provider,
        workspace=tmp_path,
        bus=MessageBus(),
        model="test",
        max_tool_result_chars=16_000,
        tools_config=tools_config,
        subscription_access_resolver=lambda: has_subscription,
    )


def _definition_names(definitions: list[dict]) -> set[str]:
    names: set[str] = set()
    for schema in definitions:
        function = schema.get("function")
        name = function.get("name") if isinstance(function, dict) else schema.get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def test_subagent_tools_config_inherits_notes_controls(tmp_path):
    manager = _subagent_manager(
        tmp_path,
        has_subscription=True,
        tools_config=ToolsConfig(notes_tools={"enabled": False, "allow_create": False}),
    )

    config = manager._subagent_tools_config()

    assert config.notes_tools.enabled is False
    assert config.notes_tools.allow_create is False


def test_spawn_registry_applies_trusted_subscription_state(tmp_path):
    active = _subagent_manager(tmp_path, has_subscription=True)._build_tools()
    inactive = _subagent_manager(tmp_path, has_subscription=False)._build_tools()

    assert "materials_search" in _definition_names(active.get_definitions())
    tool, _, error = active.prepare_call("materials_search", {"query": "paper"})
    assert tool is not None
    assert error is None

    assert "materials_search" not in _definition_names(inactive.get_definitions())
    tool, _, error = inactive.prepare_call("materials_search", {"query": "paper"})
    assert tool is not None
    assert error is not None and error.startswith("membership_required:")


def test_named_agent_registry_applies_trusted_subscription_state(tmp_path):
    definition = AgentDefinition(
        id="com.example.materials-runtime-scope-test",
        display_name="Materials test agent",
        tool_allowlist=["materials_search", "materials_read"],
    )
    job = AgentJob(
        id="job_materials_runtime_scope_test",
        room_id="room_materials_runtime_scope_test",
        requested_by="mona",
        assigned_to=definition.id,
        task="Find the source evidence.",
    )

    active = _subagent_manager(tmp_path, has_subscription=True)
    active_tools = active._build_named_agent_tools(definition, job)
    inactive = _subagent_manager(tmp_path, has_subscription=False)
    inactive_tools = inactive._build_named_agent_tools(definition, job)

    assert {"materials_search", "materials_read"} <= _definition_names(
        active_tools.get_definitions()
    )
    tool, _, error = active_tools.prepare_call(
        "materials_read", {"ref": "paper:1"}
    )
    assert tool is not None
    assert error is None

    assert not ({"materials_search", "materials_read"} & _definition_names(
        inactive_tools.get_definitions()
    ))
    tool, _, error = inactive_tools.prepare_call(
        "materials_read", {"ref": "paper:1"}
    )
    assert tool is not None
    assert error is not None and error.startswith("membership_required:")


def test_partner_knowledge_tools_are_part_of_agent_knowledge():
    definition = _partner_definition()
    inherited = resolve_effective_agent_config(definition, AgentUserConfig())
    assert inherited.allowed_tools == [
        "web_search",
        "materials_search",
        "materials_read",
        "wiki_search",
        "wiki_read",
    ]

    granted = resolve_effective_agent_config(
        definition,
        AgentUserConfig(
            granted_tools=["web_search", "notes_search", "notes_read", "exec"]
        ),
    )
    assert granted.allowed_tools == [
        "web_search",
        "notes_search",
        "notes_read",
        "materials_search",
        "materials_read",
        "wiki_search",
        "wiki_read",
    ]


def test_partner_tool_catalog_includes_user_grantable_knowledge_tools():
    configurable = configurable_agent_tools(_partner_definition())
    assert configurable is not None
    assert USER_GRANTABLE_PLATFORM_TOOLS <= set(configurable)


def test_note_image_permission_requires_note_creation():
    effective = resolve_effective_agent_config(
        _partner_definition(),
        AgentUserConfig(granted_tools=["notes_save_image"]),
    )
    assert effective.allowed_tools == [
        "materials_search",
        "materials_read",
        "wiki_search",
        "wiki_read",
    ]


@pytest.mark.parametrize(
    "granted",
    [
        ["materials_search"],
        ["materials_read"],
        ["notes_search"],
        ["notes_read"],
    ],
)
def test_query_permissions_require_search_and_read_pair(granted):
    effective = resolve_effective_agent_config(
        _partner_definition(),
        AgentUserConfig(granted_tools=granted),
    )
    assert effective.allowed_tools == [
        "materials_search",
        "materials_read",
        "wiki_search",
        "wiki_read",
    ]


def test_user_granted_knowledge_tools_load_in_subagent_scope(tmp_path):
    classes = [
        KnowledgeSearchTool,
        MaterialsReadTool,
        MaterialsSearchTool,
        NotesCreateTool,
        NotesReadTool,
        NotesSaveImageTool,
        NotesSearchTool,
        WikiReadTool,
        WikiSearchTool,
    ]
    registry = ToolRegistry()
    ToolLoader(test_classes=classes).load(
        ToolContext(
            config=ToolsConfig(),
            workspace=str(tmp_path),
            agent_id="com.example.writer",
        ),
        registry,
        scope="subagent",
        tool_allowlist=USER_GRANTABLE_PLATFORM_TOOLS,
    )

    assert USER_GRANTABLE_PLATFORM_TOOLS <= set(registry.tool_names)
    assert not registry.has("knowledge_search")


def test_mona_core_keeps_only_unified_search_entry(tmp_path):
    registry = ToolRegistry()
    ToolLoader(
        test_classes=[KnowledgeSearchTool, MaterialsSearchTool, NotesSearchTool]
    ).load(
        ToolContext(config=ToolsConfig(), workspace=str(tmp_path), agent_id="mona"),
        registry,
        scope="core",
    )
    assert registry.has("knowledge_search")
    assert not registry.has("materials_search")
    assert not registry.has("notes_search")


@pytest.mark.asyncio
async def test_split_search_tools_do_not_cross_sources(monkeypatch, tmp_path):
    calls: list[str] = []
    monkeypatch.setattr(knowledge_module, "_vault_ready", lambda: True)
    monkeypatch.setattr(knowledge_module, "_get_vault_path", lambda: tmp_path)
    async def fake_search_notes(query, limit):
        calls.append(f"notes:{query}:{limit}")
        return []

    monkeypatch.setattr(knowledge_module, "_search_notes_async", fake_search_notes)
    monkeypatch.setattr(
        knowledge_module,
        "_search_materials",
        lambda vault, query, limit, scope, **_kwargs: calls.append(
            f"materials:{query}:{limit}:{scope}"
        )
        or [],
    )

    await NotesSearchTool().execute(query="Mona", limit=3)
    assert calls == ["notes:Mona:3"]

    calls.clear()
    await MaterialsSearchTool().execute(query="Mona", limit=4, scope="wiki")
    assert calls == ["materials:Mona:4:wiki"]
