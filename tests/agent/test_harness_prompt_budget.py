"""Deterministic guards for Mona's fixed harness prompt overhead."""

from __future__ import annotations

import asyncio
import json
from importlib.resources import files as pkg_files
from unittest.mock import AsyncMock, MagicMock

from mona.agent.document_loop import DOCUMENT_PROFILES, DocumentAgentLoop
from mona.agent.loop import _FREE_TIER_CAPABILITY_NOTE, _TASK_PLAN_NOTE, AgentLoop
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.capabilities import (
    LoadCapabilityTool,
    activate_capabilities_for_history,
    activate_capabilities_for_media,
    bind_capability_context,
    tool_enabled_by_capability,
)
from mona.agent.tools.context import RequestContext
from mona.agent.tools.database import DbInspectTool, DbQueryTool, DbSqlDraftTool
from mona.agent.tools.email_intel import EmailSearchTool
from mona.agent.tools.filesystem import WriteFileTool
from mona.agent.tools.long_task import CompleteGoalTool, LongTaskTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.search import GrepTool
from mona.agent.tools.skill_tools import SkillReadTool, SkillReferenceReadTool
from mona.agent.tools.terminal import (
    TerminalExecTool,
    TerminalOutputTool,
    TerminalTaskTool,
    TerminalUploadTool,
)
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.config.schema import ProviderConfig, ToolsConfig, VideoGenerationToolConfig
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.session.goal_state import GOAL_STATE_KEY
from mona.session.manager import SessionManager
from mona.utils.helpers import estimate_message_tokens
from mona.utils.prompt_templates import render_template
from mona.utils.video_generation_intent import (
    is_video_generation_request,
    video_generation_prompt,
)


def _text_tokens(text: str) -> int:
    return estimate_message_tokens({"role": "system", "content": text}) - 4


class _NamedTool(Tool):
    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._name

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs):
        return "ok"


def test_fixed_prompt_sections_stay_compact_and_keep_required_contracts() -> None:
    identity = render_template(
        "agent/identity.md",
        runtime="Windows AMD64, Python 3.11",
        workspace_path="C:/workspace",
        platform_policy="Windows policy",
        channel="websocket",
    )
    contract = render_template("agent/tool_contract.md")
    skills = render_template("agent/skills_section.md", skills_summary="- **sample** — Sample skill")

    assert _text_tokens(identity) < 800
    assert _text_tokens(contract) < 1_800
    assert _text_tokens(skills) < 250
    assert _text_tokens(_TASK_PLAN_NOTE) < 200
    assert _text_tokens(_FREE_TIER_CAPABILITY_NOTE) < 180

    required_rules = (
        "Do not use `exec` as a universal workaround",
        "tool_unavailable:",
        "computer_observe",
        "apply_patch",
        "deliver_file",
        "terminal_task",
        "independent verify step",
        "db_sql_draft",
        "Dream-only `memory_edit`",
    )
    for rule in required_rules:
        assert rule in contract

    assert "Do not use the 'message' tool for normal replies" in identity
    assert "knowledge_read(ref)" in identity
    assert "mona-docx" in skills
    assert "mona-xlsx" in skills
    assert "mona-pptx" in skills


def test_email_search_schema_keeps_fields_and_constraints_with_compact_text() -> None:
    schema = EmailSearchTool().to_schema()["function"]
    parameters = schema["parameters"]
    properties = parameters["properties"]

    assert set(properties) == {
        "account_id",
        "folder",
        "keyword",
        "from_address",
        "from_name",
        "date_from",
        "date_to",
        "is_read",
        "is_starred",
        "has_attachments",
        "limit",
        "offset",
    }
    assert parameters.get("required", []) == []
    assert properties["limit"]["minimum"] == 1
    assert properties["limit"]["maximum"] == 200
    assert properties["offset"]["minimum"] == 0
    assert "#mona-email" in schema["description"]
    assert _text_tokens(json.dumps(schema, ensure_ascii=False, separators=(",", ":"))) < 370


def test_grep_schema_keeps_modes_limits_and_compact_text() -> None:
    schema = GrepTool().to_schema()["function"]
    properties = schema["parameters"]["properties"]

    assert schema["parameters"]["required"] == ["pattern"]
    assert properties["output_mode"]["enum"] == [
        "content",
        "files_with_matches",
        "count",
    ]
    assert properties["head_limit"]["minimum"] == 0
    assert properties["head_limit"]["maximum"] == 1000
    assert properties["offset"]["maximum"] == 100000
    assert "Prefer this over shell grep" in schema["description"]
    assert _text_tokens(json.dumps(schema, ensure_ascii=False, separators=(",", ":"))) < 490


def test_prompt_templates_are_packaged() -> None:
    templates = pkg_files("mona") / "templates" / "agent"
    for name in ("identity.md", "tool_contract.md", "capability_contract.md", "skills_section.md"):
        assert (templates / name).is_file()


def test_database_query_tools_follow_connection_context() -> None:
    inspect = DbInspectTool()
    query = DbQueryTool()
    draft = DbSqlDraftTool()
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=".", agent_id="mona", registry=registry)
    for tool in (loader, inspect, query, draft):
        registry.register(tool)
    registry.set_subscription_access(True)

    empty = RequestContext(channel="websocket", chat_id="chat", metadata={})
    bind_capability_context(empty)
    inspect.set_context(empty)
    query.set_context(empty)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability"
    ]

    connected = RequestContext(
        channel="websocket",
        chat_id="chat",
        metadata={"connection_id": "db-1", "database": "main"},
    )
    bind_capability_context(connected)
    inspect.set_context(connected)
    query.set_context(connected)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "db_inspect",
        "db_query",
        "db_sql_draft",
        "load_capability",
    ]


def test_database_execution_uses_request_scoped_connection(monkeypatch) -> None:
    import mona.agent.tools.database as database_module

    calls: list[tuple[str, dict]] = []

    async def invoke(command: str, arguments: dict) -> list[dict]:
        calls.append((command, arguments))
        return []

    monkeypatch.setattr(database_module, "_tauri_invoke_async", invoke)
    query = DbQueryTool()
    query.set_context(
        RequestContext(
            channel="websocket",
            chat_id="chat",
            metadata={"connection_id": "db-1", "database": "main"},
        )
    )

    asyncio.run(query.execute("SELECT 1"))

    assert calls == [
        (
            "db_execute_ai_read",
            {"connectionId": "db-1", "sql": "SELECT 1", "database": "main"},
        )
    ]


def test_terminal_entry_stays_visible_while_session_tools_follow_context() -> None:
    task = TerminalTaskTool()
    session_tools = (TerminalExecTool(), TerminalOutputTool(), TerminalUploadTool())
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=".", agent_id="mona", registry=registry)
    for tool in (loader, task, *session_tools):
        registry.register(tool)
    registry.set_subscription_access(True)

    no_terminal = RequestContext(channel="websocket", chat_id="chat")
    bind_capability_context(no_terminal)
    for tool in (task, *session_tools):
        tool.set_context(no_terminal)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability"
    ]

    terminal = RequestContext(
        channel="websocket",
        chat_id="chat",
        terminal_session_id="terminal-1",
    )
    bind_capability_context(terminal)
    for tool in (task, *session_tools):
        tool.set_context(terminal)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability",
        "terminal_exec",
        "terminal_output",
        "terminal_task",
        "terminal_upload",
    ]


def test_terminal_task_unlocks_session_tools_in_the_same_turn(monkeypatch) -> None:
    import mona.agent.tools.terminal as terminal_module

    async def invoke(command: str, arguments: dict | None = None):
        if command == "terminal_list_sessions":
            return [{"id": "terminal-1", "sessionType": "ssh", "status": "connected"}]
        if command == "terminal_maintenance_start":
            return {"taskId": "task-1", "stepIds": ["step-1"]}
        raise AssertionError(command)

    monkeypatch.setattr(terminal_module, "_tauri_invoke_async", invoke)
    task = TerminalTaskTool()
    execute = TerminalExecTool()
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=".", agent_id="mona", registry=registry)
    registry.register(loader)
    registry.register(task)
    registry.register(execute)
    registry.set_subscription_access(True)
    ctx = RequestContext(channel="websocket", chat_id="chat")
    bind_capability_context(ctx)
    task.set_context(ctx)
    execute.set_context(ctx)
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability"
    ]

    asyncio.run(loader.execute(["terminal"]))
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability",
        "terminal_task",
    ]

    async def start_in_tool_task() -> str:
        return await task.execute(
            action="start",
            goal="inspect server",
            steps=[{"title": "inspect status", "kind": "inspect"}],
        )

    async def run() -> str:
        return await asyncio.create_task(start_in_tool_task())

    result = asyncio.run(run())

    assert "task-1" in result
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability",
        "terminal_exec",
        "terminal_task",
    ]


def test_complete_goal_is_visible_only_for_goal_lifecycle(tmp_path) -> None:
    sessions = SessionManager(tmp_path)
    start = LongTaskTool(sessions=sessions)
    complete = CompleteGoalTool(sessions=sessions)
    registry = ToolRegistry()
    registry.register(start)
    registry.register(complete)

    ordinary = RequestContext(
        channel="websocket",
        chat_id="chat",
        session_key="websocket:chat",
    )
    start.set_context(ordinary)
    complete.set_context(ordinary)
    registry.invalidate_definitions_cache()
    assert registry.get_definitions() == []

    session = sessions.get_or_create("websocket:chat")
    session.metadata[GOAL_STATE_KEY] = {
        "status": "active",
        "source": "/goal",
        "objective": "finish the audit",
    }
    sessions.save(session)
    start.set_context(ordinary)
    complete.set_context(ordinary)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "complete_goal"
    ]

    goal_turn = RequestContext(
        channel="websocket",
        chat_id="chat",
        session_key="websocket:chat",
        metadata={"original_command": "/goal"},
    )
    start.set_context(goal_turn)
    complete.set_context(goal_turn)
    registry.invalidate_definitions_cache()
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "complete_goal",
        "long_task",
    ]


def test_contextual_tool_views_are_isolated_between_concurrent_sessions() -> None:
    inspect = DbInspectTool()
    draft = DbSqlDraftTool()
    terminal_task = TerminalTaskTool()
    terminal_exec = TerminalExecTool()
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=".", agent_id="mona", registry=registry)
    for tool in (loader, inspect, draft, terminal_task, terminal_exec):
        registry.register(tool)
    registry.set_subscription_access(True)

    async def visible(ctx: RequestContext) -> list[str]:
        bind_capability_context(ctx)
        for tool in (inspect, terminal_task, terminal_exec):
            tool.set_context(ctx)
        await asyncio.sleep(0)
        return [item["function"]["name"] for item in registry.get_definitions()]

    async def run() -> tuple[list[str], list[str]]:
        return tuple(
            await asyncio.gather(
                visible(RequestContext(channel="websocket", chat_id="plain")),
                visible(
                    RequestContext(
                        channel="websocket",
                        chat_id="active",
                        terminal_session_id="terminal-1",
                        metadata={"connection_id": "db-1"},
                    )
                ),
            )
        )

    plain, active = asyncio.run(run())

    assert plain == ["load_capability"]
    assert active == [
        "db_inspect",
        "db_sql_draft",
        "load_capability",
        "terminal_exec",
        "terminal_task",
    ]


def test_capability_loader_keeps_core_tools_and_loads_image_skill(tmp_path) -> None:
    registry = ToolRegistry()
    loader = LoadCapabilityTool(
        workspace=tmp_path,
        agent_id="mona",
        registry=registry,
    )
    for tool in (
        loader,
        _NamedTool("my"),
        _NamedTool("notes_search"),
        _NamedTool("knowledge_search"),
        _NamedTool("generate_image"),
        _NamedTool("message"),
    ):
        registry.register(tool)
    bind_capability_context(RequestContext(channel="websocket", chat_id="chat"))

    initial = [item["function"]["name"] for item in registry.get_definitions()]
    assert initial == [
        "knowledge_search",
        "load_capability",
        "my",
        "notes_search",
    ]
    assert tool_enabled_by_capability("office") is False
    assert "natural-language intent" in loader.description

    result = asyncio.run(loader.execute(["image"]))

    assert "### Skill: image-generation" in result
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "generate_image",
        "knowledge_search",
        "load_capability",
        "message",
        "my",
        "notes_search",
    ]


def test_registry_without_loader_keeps_full_internal_tool_view() -> None:
    registry = ToolRegistry()
    registry.register(_NamedTool("office"))
    bind_capability_context(RequestContext(channel="internal", chat_id="job"))

    first = registry.get_definitions()
    second = registry.get_definitions()

    assert [item["function"]["name"] for item in first] == ["office"]
    assert second is registry._cached_definitions


def test_document_profiles_can_discover_deferred_image_tools() -> None:
    assert set(DOCUMENT_PROFILES) == {"video"}
    for profile in DOCUMENT_PROFILES.values():
        assert "load_capability" in profile.tools_whitelist
        assert "generate_image" in profile.tools_whitelist


def test_document_loop_preloads_pipeline_tools_and_matching_contract(tmp_path) -> None:
    loop = DocumentAgentLoop(
        bus=MessageBus(), provider=MagicMock(), workspace=tmp_path,
        model="test", agent_kind="video",
    )
    session = loop.sessions.get_or_create("websocket:document")
    loop._set_tool_context("websocket", "document", session=session)
    assert loop.tools.is_visible("exec")
    assert loop.tools.is_visible("skill_script_run")
    messages = loop._build_initial_messages(
        InboundMessage(channel="websocket", sender_id="user", chat_id="document", content="制作视频"),
        session, [], None,
    )
    assert "## Process Execution" in messages[0]["content"]
    assert "## Browser Use" not in messages[0]["content"]
    assert "## Computer Use" not in messages[0]["content"]


def test_ui_context_and_media_preload_capabilities() -> None:
    bind_capability_context(
        RequestContext(
            channel="websocket",
            chat_id="chat",
            metadata={
                "office_session_id": "office-1",
                "image_generation": {"enabled": True},
            },
        )
    )

    assert tool_enabled_by_capability("office") is True
    assert tool_enabled_by_capability("generate_image") is True
    assert tool_enabled_by_capability("email_search") is False

    activate_capabilities_for_media(["clip.mp4"])
    assert tool_enabled_by_capability("generate_video") is True


def test_explicit_video_generation_request_preloads_video_tool(tmp_path) -> None:
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 4096
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,
        workspace=tmp_path,
        model="test-model",
        tools_config=ToolsConfig(
            video_generation=VideoGenerationToolConfig(enabled=True),
        ),
        video_generation_provider_configs={"agnes": ProviderConfig(api_key="test-key")},
    )
    session = loop.sessions.get_or_create("websocket:chat-video")
    loop._set_tool_context("websocket", "chat-video", session=session)

    assert loop.tools.is_visible("generate_video") is False
    messages = loop._build_initial_messages(
        InboundMessage(
            channel="websocket",
            sender_id="user",
            chat_id="chat-video",
            content="重试生成视频",
        ),
        session,
        [],
        None,
    )

    assert loop.tools.is_visible("generate_video") is True
    assert "Use the generate_video tool directly" in messages[-1]["content"]


def test_video_generation_intent_is_explicit_and_does_not_capture_diagnosis() -> None:
    content = "重试生成视频"
    assert is_video_generation_request(content, {}) is True
    prompt = video_generation_prompt(content, {})
    assert "Use the generate_video tool directly" in prompt
    assert "do not use terminal tools" in prompt

    diagnostic = "为什么视频生成会失败？"
    assert is_video_generation_request(diagnostic, {}) is False
    assert video_generation_prompt(diagnostic, {}) == diagnostic


def test_unavailable_tool_does_not_assume_a_terminal_panel() -> None:
    registry = ToolRegistry()
    tool = _NamedTool("terminal_exec")
    tool.is_available = False
    registry.register(tool)

    _tool, _params, error = registry.prepare_call("terminal_exec", {})

    assert error is not None
    assert "Only ask the user to open a UI panel" in error
    assert "terminal panel" not in error


def test_runner_expands_capability_tools_on_the_next_model_call(tmp_path) -> None:
    registry = ToolRegistry()
    loader = LoadCapabilityTool(
        workspace=tmp_path,
        agent_id="mona",
        registry=registry,
    )
    registry.register(loader)
    registry.register(WriteFileTool(workspace=tmp_path, allowed_dir=tmp_path))
    bind_capability_context(RequestContext(channel="websocket", chat_id="chat"))

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(
        side_effect=[
            LLMResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[
                    ToolCallRequest(
                        id="load-development",
                        name="load_capability",
                        arguments={"capabilities": ["development"]},
                    )
                ],
            ),
            LLMResponse(
                content="",
                finish_reason="tool_calls",
                tool_calls=[
                    ToolCallRequest(
                        id="write-note",
                        name="write_file",
                        arguments={"path": str(tmp_path / "result.txt"), "content": "verified"},
                    )
                ],
            ),
            LLMResponse(content="done", finish_reason="stop"),
        ]
    )
    result = asyncio.run(
        AgentRunner(provider).run(
            AgentRunSpec(
                initial_messages=[
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "新建 result.txt，写入 verified"},
                ],
                tools=registry,
                model="test",
                max_iterations=4,
                max_tool_result_chars=4_000,
                workspace=tmp_path,
            )
        )
    )

    first_tools = provider.chat_with_retry.await_args_list[0].kwargs["tools"]
    second_tools = provider.chat_with_retry.await_args_list[1].kwargs["tools"]
    assert [item["function"]["name"] for item in first_tools] == ["load_capability"]
    assert [item["function"]["name"] for item in second_tools] == [
        "load_capability",
        "write_file",
    ]
    assert result.final_content == "done"
    assert result.tools_used == ["load_capability", "write_file"]
    assert (tmp_path / "result.txt").read_text(encoding="utf-8") == "verified"
    assert all(
        call.kwargs["messages"][0] == {"role": "system", "content": "system"}
        for call in provider.chat_with_retry.await_args_list
    )


def test_capability_contract_follows_loaded_tools_without_changing_base_rules(tmp_path) -> None:
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=tmp_path, agent_id="mona", registry=registry)
    for tool in (loader, _NamedTool("browser_observe"), _NamedTool("terminal_task"), _NamedTool("exec")):
        registry.register(tool)
    bind_capability_context(RequestContext(channel="websocket", chat_id="plain"))
    initial = render_template("agent/tool_contract.md", tool_names={"load_capability"})
    assert "## Browser Use" not in initial
    assert "## Computer Use" not in initial
    assert "Remote Terminal and SSH Sessions" not in initial
    assert "Do not use `exec` as a universal workaround" in initial
    result = asyncio.run(loader.execute(["browser", "terminal", "development"]))
    assert "## Browser Use" in result
    assert "## Computer Use" not in result
    assert "independent verify step" in result
    assert "deliver_file" in result
    repeated = asyncio.run(loader.execute(["browser", "terminal", "development"]))
    assert "## Browser Use" not in repeated
    assert "independent verify step" not in repeated
    preloaded = render_template("agent/tool_contract.md", tool_names={"browser_observe"})
    assert "## Browser Use" in preloaded
    assert "## Computer Use" not in preloaded
    assert "Remote Terminal and SSH Sessions" not in preloaded
    computer = render_template("agent/tool_contract.md", tool_names={"computer_observe", "computer_act"})
    assert "## Computer Use" in computer
    assert "element_token" in computer
    assert "## Browser Use" not in computer
    assert "Do not ask the user to upload a screenshot before trying" in computer


def test_skill_read_unlocks_resources_only_after_success(monkeypatch, tmp_path) -> None:
    import mona.agent.tools.skill_tools as skill_tools
    from mona.agent.skills import SkillsLoader

    skills = SkillsLoader(tmp_path)
    monkeypatch.setattr(skill_tools, "_skills_loader", lambda _agent_id: skills)
    registry = ToolRegistry()
    registry.register(LoadCapabilityTool(workspace=tmp_path, agent_id="mona", registry=registry))
    registry.register(SkillReadTool(track_usage=False))
    registry.register(SkillReferenceReadTool(track_usage=False))
    bind_capability_context(RequestContext(channel="websocket", chat_id="skill"))
    assert not registry.is_visible("skill_reference_read")
    assert "not found" in asyncio.run(registry.execute("skill_read", {"name": "absent-skill"}))
    assert not registry.is_visible("skill_reference_read")
    assert "# Self-Awareness" in asyncio.run(registry.execute("skill_read", {"name": "my"}))
    assert registry.is_visible("skill_reference_read")
    result = asyncio.run(registry.execute("skill_reference_read", {"skill": "my", "ref_path": "examples.md"}))
    assert not result.startswith("Error")


def test_retained_calls_restore_capabilities_without_replaying_or_expanding_permissions(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(LoadCapabilityTool(workspace=tmp_path, agent_id="mona", registry=registry))
    registry.register(_NamedTool("exec"))
    registry.register(_NamedTool("office"))
    registry.set_allowed_tool_names({"load_capability", "exec"})
    bind_capability_context(RequestContext(channel="websocket", chat_id="continued"))
    activate_capabilities_for_history([
        {"role": "user", "tool_calls": [{"function": {"name": "generate_image"}}]},
        {"role": "assistant", "tool_calls": [
            {"function": None},
            {"function": {"name": "load_capability", "arguments": "invalid-json"}},
            {"function": {"name": "exec", "arguments": {}}},
            {"function": {"name": "load_capability", "arguments": json.dumps({"capabilities": ["office"]})}},
        ]},
    ])
    assert registry.is_visible("exec")
    assert not registry.is_visible("office")
    assert not tool_enabled_by_capability("generate_image")
    bind_capability_context(RequestContext(channel="websocket", chat_id="other"))
    assert not registry.is_visible("exec")


def test_capability_loading_never_expands_agent_permissions(tmp_path) -> None:
    registry = ToolRegistry()
    loader = LoadCapabilityTool(
        workspace=tmp_path,
        agent_id="mona",
        registry=registry,
    )
    registry.register(loader)
    registry.register(_NamedTool("office"))
    registry.set_allowed_tool_names({"load_capability"})
    bind_capability_context(RequestContext(channel="websocket", chat_id="chat"))

    result = asyncio.run(loader.execute(["office"]))

    assert "none in this configuration" in result
    assert [item["function"]["name"] for item in registry.get_definitions()] == [
        "load_capability"
    ]
