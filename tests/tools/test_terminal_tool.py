from mona.config.schema import TerminalExecMode, TerminalToolConfig, ToolsConfig


def test_terminal_config_defaults():
    cfg = TerminalToolConfig()
    assert cfg.enable is True
    assert cfg.exec_mode == TerminalExecMode.APPROVAL
    assert "rm -rf /" in cfg.dangerous_patterns
    assert "ls" in cfg.safe_patterns


def test_terminal_config_auto_mode():
    cfg = TerminalToolConfig(exec_mode=TerminalExecMode.AUTO)
    assert cfg.exec_mode == TerminalExecMode.AUTO
    assert cfg.exec_mode.value == "auto"


def test_terminal_config_custom_patterns():
    cfg = TerminalToolConfig(
        dangerous_patterns=["wipe"],
        safe_patterns=["git status"],
    )
    assert cfg.dangerous_patterns == ["wipe"]
    assert cfg.safe_patterns == ["git status"]


def test_tools_config_has_terminal_field():
    tools = ToolsConfig()
    assert hasattr(tools, "terminal")
    assert isinstance(tools.terminal, TerminalToolConfig)
    assert tools.terminal.enable is True
    assert tools.terminal.exec_mode == TerminalExecMode.APPROVAL


def test_risk_classify_dangerous_always_approval():
    from mona.agent.tools.terminal import _classify_risk

    assert _classify_risk("rm -rf /tmp", exec_mode="auto") == "approval"
    assert _classify_risk("mkfs.ext4 /dev/sdb1", exec_mode="auto") == "approval"
    assert _classify_risk("rm -rf /tmp", exec_mode="approval") == "approval"


def test_risk_classify_safe_in_auto_mode():
    from mona.agent.tools.terminal import _classify_risk

    assert _classify_risk("ls -la", exec_mode="auto") == "direct"
    assert _classify_risk("df -h", exec_mode="auto") == "direct"


def test_risk_classify_safe_in_approval_mode():
    from mona.agent.tools.terminal import _classify_risk

    assert _classify_risk("ls -la", exec_mode="approval") == "approval"


def test_risk_classify_unknown_falls_back_to_exec_mode():
    from mona.agent.tools.terminal import _classify_risk

    assert _classify_risk("some-custom-command --flag", exec_mode="auto") == "approval"
    assert _classify_risk("some-custom-command --flag", exec_mode="approval") == "approval"


def test_risk_classify_case_insensitive():
    from mona.agent.tools.terminal import _classify_risk

    assert _classify_risk("RM -RF /tmp", exec_mode="auto") == "approval"
    assert _classify_risk("LS -la", exec_mode="auto") == "direct"


def test_risk_classify_custom_patterns_from_config():
    from mona.agent.tools.terminal import _classify_risk

    assert (
        _classify_risk(
            "DROP TABLE users",
            exec_mode="auto",
            dangerous_patterns=["drop-table"],
            safe_patterns=["select-from"],
        )
        == "approval"
    )
    assert (
        _classify_risk(
            "SELECT * FROM users",
            exec_mode="auto",
            dangerous_patterns=["drop-table"],
            safe_patterns=["select-from"],
        )
        == "direct"
    )
