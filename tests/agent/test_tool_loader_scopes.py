import pytest

from mona.agent.tools.base import Tool
from mona.agent.tools.context import ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.long_task import CompleteGoalTool, LongTaskTool
from mona.agent.tools.registry import ToolRegistry
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
