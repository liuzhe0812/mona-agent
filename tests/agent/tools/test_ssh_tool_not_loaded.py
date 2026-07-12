"""Tests verifying that the deprecated SSHExecTool is not loaded.

SSHExecTool was a standalone ssh command runner that created a new connection
each time without reusing sessions. It has been superseded by terminal_exec
which reuses active SSH sessions and supports risk-based approval workflow.
"""

from __future__ import annotations

from mona.agent.tools.loader import ToolLoader


class TestSshExecToolNotLoaded:
    def test_ssh_exec_not_in_discovered_tools(self) -> None:
        """SSHExecTool should not be discovered by the tool loader."""
        loader = ToolLoader()
        discovered = loader.discover()
        tool_names = [cls.__name__ for cls in discovered]
        assert "SSHExecTool" not in tool_names

    def test_ssh_in_skip_modules(self) -> None:
        """The 'ssh' module name should be in _SKIP_MODULES to prevent
        accidental re-loading if the file is re-created."""
        from mona.agent.tools.loader import _SKIP_MODULES
        assert "ssh" in _SKIP_MODULES
