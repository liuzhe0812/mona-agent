from __future__ import annotations

from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry


class _FakeTool(Tool):
    def __init__(self, name: str):
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"{self._name} tool"

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> Any:
        return kwargs


def _tool_names(definitions: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for definition in definitions:
        fn = definition.get("function", {})
        names.append(fn.get("name", ""))
    return names


def test_get_definitions_orders_builtins_then_mcp_tools() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("mcp_git_status"))
    registry.register(_FakeTool("write_file"))
    registry.register(_FakeTool("mcp_fs_list"))
    registry.register(_FakeTool("read_file"))

    assert _tool_names(registry.get_definitions()) == [
        "read_file",
        "write_file",
        "mcp_fs_list",
        "mcp_git_status",
    ]


def test_prepare_call_read_file_rejects_non_object_params_with_actionable_hint() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("read_file"))

    tool, params, error = registry.prepare_call("read_file", ["foo.txt"])

    assert tool is None
    assert params == ["foo.txt"]
    assert error is not None
    assert "must be a JSON object" in error
    assert "Use named parameters" in error


def test_prepare_call_other_tools_keep_generic_object_validation() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("grep"))

    tool, params, error = registry.prepare_call("grep", ["TODO"])

    assert tool is not None
    assert params == ["TODO"]
    assert error == "Error: Invalid parameters for tool 'grep': parameters must be an object, got list"


def test_get_definitions_returns_cached_result() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("read_file"))
    first = registry.get_definitions()
    assert registry._cached_definitions is not None
    second = registry.get_definitions()
    assert first == second


def test_register_invalidates_cache() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("read_file"))
    first = registry.get_definitions()
    registry.register(_FakeTool("write_file"))
    second = registry.get_definitions()
    assert first is not second
    assert len(second) == 2


def test_unregister_invalidates_cache() -> None:
    registry = ToolRegistry()
    registry.register(_FakeTool("read_file"))
    registry.register(_FakeTool("write_file"))
    first = registry.get_definitions()
    registry.unregister("write_file")
    second = registry.get_definitions()
    assert first is not second
    assert len(second) == 1


def test_get_definitions_excludes_unavailable_tools() -> None:
    """A tool with ``is_available=False`` is hidden from the model.

    This protects against the LLM seeing a terminal tool that will always
    fail this turn (e.g. no active terminal session) and then misreading
    the error string as "tool does not exist".
    """
    registry = ToolRegistry()
    available_tool = _FakeTool("read_file")
    unavailable_tool = _FakeTool("terminal_exec")
    unavailable_tool.is_available = False
    registry.register(available_tool)
    registry.register(unavailable_tool)

    names = _tool_names(registry.get_definitions())

    assert "read_file" in names
    assert "terminal_exec" not in names


def test_invalidate_definitions_cache_refreshes_after_availability_change() -> None:
    """``invalidate_definitions_cache`` forces the next ``get_definitions``
    call to re-evaluate ``is_available`` flags.

    This is called by AgentLoop after ``set_context`` so that runtime
    availability changes take effect immediately.
    """
    registry = ToolRegistry()
    tool = _FakeTool("terminal_exec")
    registry.register(tool)
    assert "terminal_exec" in _tool_names(registry.get_definitions())

    tool.is_available = False
    # Without invalidation, the stale cache would still return the tool.
    assert "terminal_exec" in _tool_names(registry.get_definitions())

    registry.invalidate_definitions_cache()
    assert "terminal_exec" not in _tool_names(registry.get_definitions())


def test_prepare_call_rejects_unavailable_tool_with_clear_message() -> None:
    """A call to an ``is_available=False`` tool returns an error prefixed
    with ``tool_unavailable:`` so the LLM does not confuse it with a missing
    tool.
    """
    registry = ToolRegistry()
    tool = _FakeTool("terminal_exec")
    tool.is_available = False
    registry.register(tool)

    _tool, _params, error = registry.prepare_call("terminal_exec", {})

    assert error is not None
    assert error.startswith("tool_unavailable:")
    assert "transient state" in error
    assert "not a missing tool" in error
