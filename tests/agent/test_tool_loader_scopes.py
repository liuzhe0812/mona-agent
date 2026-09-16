import json
from unittest.mock import MagicMock

import pytest

import mona.agent.user_config as user_config
from mona.agent.jobs import AgentJob
from mona.agent.partners import AgentDefinition
from mona.agent.subagent import SubagentManager
from mona.agent.tools import knowledge_search as knowledge_module
from mona.agent.tools.base import Tool
from mona.agent.tools.context import ToolContext
from mona.agent.tools.knowledge_search import (
    KnowledgeReadTool,
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
    AGENT_EXCLUSIVE_TOOLS,
    AGENT_USER_CONFIG_SCHEMA_VERSION,
    COMMON_AGENT_TOOLS,
    REQUIRED_AGENT_TOOLS,
    USER_GRANTABLE_PLATFORM_TOOLS,
    AgentUserConfig,
    configurable_agent_tools,
    load_agent_user_config,
    resolve_effective_agent_config,
    tool_available_to_agent,
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


class _ForgedStockTool(_SubagentOnlyTool):
    @property
    def name(self):
        return "stock_quote"


class _ForgedTerminalTool(_SubagentOnlyTool):
    @property
    def name(self):
        return "terminal_task"


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


def test_exclusive_tool_ownership_rejects_a_forged_expert_allowlist():
    loader = ToolLoader(test_classes=[_ForgedStockTool])
    forged = ToolRegistry()
    owner = ToolRegistry()

    loader.load(
        ToolContext(config={}, workspace="/tmp", agent_id="com.example.forged"),
        forged,
        scope="subagent",
        tool_allowlist=["stock_quote"],
    )
    loader.load(
        ToolContext(config={}, workspace="/tmp", agent_id="com.mona.a-share-analyst"),
        owner,
        scope="subagent",
        tool_allowlist=["stock_quote"],
    )

    assert not forged.has("stock_quote")
    assert owner.has("stock_quote")
    assert tool_available_to_agent("stock_quote", "com.mona.a-share-analyst")


def test_terminal_module_tools_are_reserved_for_mona():
    registry = ToolRegistry()
    ToolLoader(test_classes=[_ForgedTerminalTool]).load(
        ToolContext(config={}, workspace="/tmp", agent_id="com.example.partner"),
        registry,
        scope="subagent",
        tool_allowlist=["terminal_task"],
    )

    assert not registry.has("terminal_task")


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

    assert "knowledge_search" in _definition_names(active.get_definitions())
    tool, _, error = active.prepare_call("knowledge_search", {"query": "paper"})
    assert tool is not None
    assert error is None

    assert "knowledge_search" not in _definition_names(inactive.get_definitions())
    tool, _, error = inactive.prepare_call("knowledge_search", {"query": "paper"})
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

    assert {"knowledge_search", "knowledge_read"} <= _definition_names(
        active_tools.get_definitions()
    )
    tool, _, error = active_tools.prepare_call(
        "knowledge_read", {"ref": "paper:1"}
    )
    assert tool is not None
    assert error is None

    assert not ({"knowledge_search", "knowledge_read"} & _definition_names(
        inactive_tools.get_definitions()
    ))
    tool, _, error = inactive_tools.prepare_call(
        "knowledge_read", {"ref": "paper:1"}
    )
    assert tool is not None
    assert error is not None and error.startswith("membership_required:")


def test_partner_knowledge_tools_are_part_of_agent_knowledge():
    definition = _partner_definition()
    inherited = resolve_effective_agent_config(definition, AgentUserConfig())
    assert set(inherited.allowed_tools or []) == REQUIRED_AGENT_TOOLS | {
        "web_search",
        "knowledge_search",
        "knowledge_read",
    }

    granted = resolve_effective_agent_config(
        definition,
        AgentUserConfig(
            granted_tools=["web_search", "notes_search", "notes_read", "exec"]
        ),
    )
    assert set(granted.allowed_tools or []) == REQUIRED_AGENT_TOOLS | {
        "web_search",
        "notes_search",
        "notes_read",
        "exec",
        "knowledge_search",
        "knowledge_read",
    }


def test_partner_tool_catalog_includes_user_grantable_knowledge_tools():
    configurable = configurable_agent_tools(_partner_definition())
    assert configurable is not None
    assert USER_GRANTABLE_PLATFORM_TOOLS <= set(configurable)


def test_every_expert_can_configure_the_same_common_tools_plus_only_its_exclusives():
    generic = AgentDefinition(id="com.example.generic", display_name="Generic")
    academic = AgentDefinition(
        id="com.mona.academic-researcher",
        display_name="Academic",
    )
    musician = AgentDefinition(id="com.mona.musician", display_name="Musician")

    generic_tools = set(configurable_agent_tools(generic) or [])
    academic_tools = set(configurable_agent_tools(academic) or [])
    musician_tools = set(configurable_agent_tools(musician) or [])

    assert generic_tools == COMMON_AGENT_TOOLS
    assert academic_tools == COMMON_AGENT_TOOLS | AGENT_EXCLUSIVE_TOOLS[academic.id]
    assert musician_tools == COMMON_AGENT_TOOLS | AGENT_EXCLUSIVE_TOOLS[musician.id]
    assert not (AGENT_EXCLUSIVE_TOOLS[academic.id] & musician_tools)
    assert not (AGENT_EXCLUSIVE_TOOLS[musician.id] & academic_tools)

    musician_defaults = resolve_effective_agent_config(musician, AgentUserConfig())
    assert musician_defaults.allowed_tools is not None
    assert AGENT_EXCLUSIVE_TOOLS[musician.id] <= set(musician_defaults.allowed_tools)


def test_v1_default_permissions_do_not_keep_new_explicit_tools_enabled(
    tmp_path,
    monkeypatch,
):
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "schema_version": 1,
            "revision": 4,
            "granted_tools": ["web_search", "crypto", "config_set_provider"],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(user_config, "get_agent_user_config_path", lambda _agent_id: config_path)

    config = load_agent_user_config("mona")

    assert config.schema_version == AGENT_USER_CONFIG_SCHEMA_VERSION
    assert config.revision == 4
    assert config.granted_tools == ["web_search"]


def test_note_image_permission_requires_note_creation():
    effective = resolve_effective_agent_config(
        _partner_definition(),
        AgentUserConfig(granted_tools=["notes_save_image"]),
    )
    assert set(effective.allowed_tools or []) == REQUIRED_AGENT_TOOLS | {
        "knowledge_search",
        "knowledge_read",
    }


@pytest.mark.parametrize(
    "granted",
    [
        ["knowledge_search"],
        ["knowledge_read"],
        ["notes_search"],
        ["notes_read"],
    ],
)
def test_query_permissions_require_search_and_read_pair(granted):
    effective = resolve_effective_agent_config(
        _partner_definition(),
        AgentUserConfig(granted_tools=granted),
    )
    assert set(effective.allowed_tools or []) == REQUIRED_AGENT_TOOLS | {
        "knowledge_search",
        "knowledge_read",
    }


def test_user_granted_knowledge_tools_load_in_subagent_scope(tmp_path):
    classes = [
        KnowledgeSearchTool,
        KnowledgeReadTool,
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
    assert {"knowledge_search", "knowledge_read"} <= set(registry.tool_names)


def test_mona_core_exposes_only_notes_and_agent_knowledge_business_tools(tmp_path):
    registry = ToolRegistry()
    ToolLoader(
        test_classes=[
            KnowledgeReadTool,
            KnowledgeSearchTool,
            MaterialsReadTool,
            MaterialsSearchTool,
            NotesSearchTool,
            WikiReadTool,
            WikiSearchTool,
        ]
    ).load(
        ToolContext(config=ToolsConfig(), workspace=str(tmp_path), agent_id="mona"),
        registry,
        scope="core",
    )
    registry.set_subscription_access(True)
    assert registry.has("knowledge_search")
    assert registry.has("notes_search")
    assert registry.has("knowledge_read")
    assert {"knowledge_search", "knowledge_read", "notes_search"} <= _definition_names(
        registry.get_definitions()
    )
    assert not {
        "materials_search", "materials_read", "wiki_search", "wiki_read"
    } & _definition_names(registry.get_definitions())


def test_v3_storage_layer_permissions_migrate_to_agent_knowledge(
    tmp_path,
    monkeypatch,
):
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({
            "schema_version": 3,
            "revision": 7,
            "granted_tools": [
                "notes_search",
                "notes_read",
                "materials_search",
                "materials_read",
                "wiki_search",
                "wiki_read",
            ],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(user_config, "get_agent_user_config_path", lambda _agent_id: config_path)

    config = load_agent_user_config("mona")

    assert config.schema_version == AGENT_USER_CONFIG_SCHEMA_VERSION
    assert config.granted_tools == [
        "notes_search",
        "notes_read",
        "knowledge_search",
        "knowledge_read",
    ]


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
