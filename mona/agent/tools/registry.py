"""Tool registry for dynamic tool management."""

from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.capabilities import (
    capabilities_for_tool,
    tool_enabled_by_capability,
)

# Stable error identifier returned when a subscription-gated tool is invoked
# without an active subscription or trial. The model and UI can match on this
# prefix to surface an upgrade prompt instead of a generic failure.
MEMBERSHIP_REQUIRED_ERROR = "membership_required"


class ToolRegistry:
    """
    Registry for agent tools.

    Allows dynamic registration and execution of tools.
    """

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._cached_definitions: list[dict[str, Any]] | None = None
        # Optional user-level narrowing. Registration remains unchanged so a
        # later config edit can re-enable a permitted tool without rebuilding
        # plugin/MCP state.
        self._allowed_tool_names: set[str] | None = None
        # Fail closed until the AgentLoop refreshes the trusted license state.
        self._has_subscription_access: bool = False

    def register(self, tool: Tool) -> None:
        """Register a tool."""
        self._tools[tool.name] = tool
        self._cached_definitions = None

    def unregister(self, name: str) -> None:
        """Unregister a tool by name."""
        self._tools.pop(name, None)
        self._cached_definitions = None

    def get(self, name: str) -> Tool | None:
        """Get a tool by name."""
        return self._tools.get(name)

    def has(self, name: str) -> bool:
        """Check if a tool is registered."""
        return name in self._tools

    def set_subscription_access(self, has_access: bool) -> None:
        """Update the subscription access flag.

        When set to False, tools marked ``subscription_required`` are hidden
        from the model (excluded from ``get_definitions``) and rejected at
        execution time (``prepare_call`` returns a ``membership_required``
        error). When set to True, all registered tools are available.
        """
        changed = self._has_subscription_access != has_access
        self._has_subscription_access = has_access
        if changed:
            self._cached_definitions = None

    def set_allowed_tool_names(self, names: set[str] | None) -> None:
        """Narrow model-visible and executable tools without unregistering them."""
        normalized = set(names) if names is not None else None
        if normalized == self._allowed_tool_names:
            return
        self._allowed_tool_names = normalized
        self._cached_definitions = None

    def invalidate_definitions_cache(self) -> None:
        """Clear cached stable tool schemas; request availability is always fresh."""
        self._cached_definitions = None

    def _is_allowed(self, tool: Tool | None) -> bool:
        if tool is None:
            return False
        if getattr(tool, "requires_explicit_permission", False):
            return (
                self._allowed_tool_names is not None
                and tool.name in self._allowed_tool_names
            )
        return (
            self._allowed_tool_names is None
            or tool.name in self._allowed_tool_names
        )

    @property
    def has_subscription_access(self) -> bool:
        return self._has_subscription_access

    def is_subscription_blocked(self, name: str) -> bool:
        """Check if a tool is currently blocked by subscription gating."""
        if self._has_subscription_access:
            return False
        tool = self._tools.get(name)
        if tool is None:
            return False
        return getattr(tool, "subscription_required", False)

    @staticmethod
    def _schema_name(schema: dict[str, Any]) -> str:
        """Extract a normalized tool name from either OpenAI or flat schemas."""
        fn = schema.get("function")
        if isinstance(fn, dict):
            name = fn.get("name")
            if isinstance(name, str):
                return name
        name = schema.get("name")
        return name if isinstance(name, str) else ""

    def _runtime_visible_definitions(
        self,
        definitions: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        use_capability_filter = self.has("load_capability")
        visible = [
            schema
            for schema in definitions
            if (
                (tool := self._tools.get(self._schema_name(schema))) is not None
                and tool.available_in_context()
                and (
                    not use_capability_filter
                    or tool_enabled_by_capability(tool.name)
                )
            )
        ]
        return definitions if len(visible) == len(definitions) else visible

    def is_visible(self, name: str) -> bool:
        """Return whether a registered tool is visible in the current request."""
        return any(self._schema_name(schema) == name for schema in self.get_definitions())

    def get_definitions(self) -> list[dict[str, Any]]:
        """Get tool definitions with stable ordering for cache-friendly prompts.

        Built-in tools are sorted first as a stable prefix, then MCP tools are
        sorted and appended.  The result is cached until the next
        register/unregister call or subscription access change.

        Subscription-gated tools are excluded when the user has no active
        subscription or trial. The cached list contains only stable permission
        and schema decisions; request-scoped availability is filtered on every
        call so concurrent sessions cannot reuse each other's tool view.
        """
        if self._cached_definitions is not None:
            return self._runtime_visible_definitions(self._cached_definitions)

        definitions: list[dict[str, Any]] = []
        for tool in self._tools.values():
            if not self._is_allowed(tool):
                continue
            if not getattr(tool, "model_visible", True):
                continue
            if (
                not self._has_subscription_access
                and getattr(tool, "subscription_required", False)
            ):
                continue
            definitions.append(tool.to_schema())

        builtins: list[dict[str, Any]] = []
        mcp_tools: list[dict[str, Any]] = []
        for schema in definitions:
            name = self._schema_name(schema)
            if name.startswith("mcp_"):
                mcp_tools.append(schema)
            else:
                builtins.append(schema)

        builtins.sort(key=self._schema_name)
        mcp_tools.sort(key=self._schema_name)
        self._cached_definitions = builtins + mcp_tools
        return self._runtime_visible_definitions(self._cached_definitions)

    def prepare_call(
        self,
        name: str,
        params: dict[str, Any],
    ) -> tuple[Tool | None, dict[str, Any], str | None]:
        """Resolve, cast, and validate one tool call."""
        tool = self._tools.get(name)
        if tool is not None and not self._is_allowed(tool):
            return None, params, f"Error: Tool '{name}' is not permitted for this agent."
        if tool is not None and not getattr(tool, "model_visible", True):
            return None, params, f"Error: Tool '{name}' is internal and not model-callable."
        # Guard against invalid parameter types (e.g., list instead of dict)
        if not isinstance(params, dict) and name in ('write_file', 'read_file'):
            return None, params, (
                f"Error: Tool '{name}' parameters must be a JSON object, got {type(params).__name__}. "
                "Use named parameters: tool_name(param1=\"value1\", param2=\"value2\")"
            )

        if not tool:
            return None, params, (
                f"Error: Tool '{name}' not found. Available: {', '.join(self.tool_names)}"
            )

        # Defense-in-depth: even if the model somehow emits a call to a
        # subscription-gated tool (e.g. from historical context or a replayed
        # tool call), reject it here with a stable error identifier.
        if self.is_subscription_blocked(name):
            return tool, params, (
                f"{MEMBERSHIP_REQUIRED_ERROR}: Tool '{name}' requires an active "
                "subscription or trial. The user's subscription has expired or is "
                "not active. Do not claim to have searched notes or emails. Tell "
                "the user they can subscribe to unlock Agent access to existing "
                "notes and emails."
            )

        # Defense-in-depth: a tool hidden via ``is_available=False`` (e.g.
        # terminal tools when no terminal session is active) may still be
        # called from historical context. Reject with a clear, actionable
        # message so the model does not misread "tool unavailable" as
        # "tool does not exist".
        if not tool.available_in_context():
            return tool, params, (
                f"tool_unavailable: Tool '{name}' is registered but not "
                "available in the current context. This is a transient "
                "state, not a missing tool. Ask the user to open the "
                "required panel (e.g. the terminal panel) and try again."
            )
        if self.has("load_capability") and not tool_enabled_by_capability(name):
            groups = ", ".join(sorted(capabilities_for_tool(name)))
            return tool, params, (
                f"tool_unavailable: Tool '{name}' belongs to a deferred capability "
                f"({groups}). Call load_capability first, then retry."
            )

        cast_params = tool.cast_params(params)
        errors = tool.validate_params(cast_params)
        if errors:
            return tool, cast_params, (
                f"Error: Invalid parameters for tool '{name}': " + "; ".join(errors)
            )
        return tool, cast_params, None

    async def execute(self, name: str, params: dict[str, Any]) -> Any:
        """Execute a tool by name with given parameters."""
        hint = "\n\n[Analyze the error above and try a different approach.]"
        tool, params, error = self.prepare_call(name, params)
        if error:
            return error + hint

        try:
            assert tool is not None  # guarded by prepare_call()
            result = await tool.execute(**params)
            if isinstance(result, str) and result.startswith("Error"):
                return result + hint
            return result
        except Exception as e:
            return f"Error executing {name}: {str(e)}" + hint

    @property
    def tool_names(self) -> list[str]:
        """Get list of registered tool names."""
        return list(self._tools.keys())

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: str) -> bool:
        return name in self._tools
