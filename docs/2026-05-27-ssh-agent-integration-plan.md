# SSH Agent Integration Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance Mona's SSH module with AI Agent integration: session reuse, terminal buffer reading, and risk-graded command execution with approval flow.

**Architecture:** Dual-layer security model — Python-side configurable risk classification (first layer) + Rust-side hardcoded dangerous command guard (second layer). Build on existing `TerminalExecTool`/`TerminalOutputTool` infrastructure rather than building from scratch.

**Tech Stack:** Python 3.11+, Pydantic (config), aiohttp (gateway), Rust/Tauri 2 (backend), russh (SSH client)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `mona/config/schema.py` | Add `TerminalExecMode`, `TerminalToolConfig`, register in `ToolsConfig` |
| `mona/agent/tools/terminal.py` | Risk classification logic in `TerminalExecTool`, config loading, pass `source` param; minor `TerminalOutputTool` tweaks |
| `mona/agent/tools/ssh.py` | Mark `SSHExecTool` as deprecated |
| `src-tauri/src/terminal/commands.rs` | Add `source` param to `terminal_exec_command`, add `is_dangerous_command()` guard |
| `tests/tools/test_terminal_tool.py` | New test file for terminal tool risk classification |

---

### Task 1: Add TerminalToolConfig to schema

**Files:**
- Modify: `mona/config/schema.py:1-20` (add imports)
- Modify: `mona/config/schema.py:270-321` (add enum + config class)
- Modify: `mona/config/schema.py:498-516` (register in `_resolve_tool_config_refs`)
- Test: `tests/tools/test_terminal_tool.py`

- [ ] **Step 1: Write the failing tests for TerminalToolConfig**

```python
"""Tests for TerminalToolConfig and risk classification."""
from __future__ import annotations

import pytest
from pydantic import ValidationError


def test_terminal_config_defaults():
    """Default values should be safe-first."""
    from mona.config.schema import TerminalToolConfig

    cfg = TerminalToolConfig()
    assert cfg.enable is True
    assert cfg.exec_mode.value == "approval"
    assert "rm -rf /" in cfg.dangerous_patterns
    assert "ls" in cfg.safe_patterns


def test_terminal_config_auto_mode():
    """Auto mode should be accepted."""
    from mona.config.schema import TerminalToolConfig, TerminalExecMode

    cfg = TerminalToolConfig(exec_mode=TerminalExecMode.AUTO)
    assert cfg.exec_mode.value == "auto"


def test_terminal_config_custom_patterns():
    """User can override dangerous/safe patterns."""
    from mona.config.schema import TerminalToolConfig

    cfg = TerminalToolConfig(
        dangerous_patterns=["my-danger-cmd"],
        safe_patterns=["my-safe-cmd"],
    )
    assert cfg.dangerous_patterns == ["my-danger-cmd"]
    assert cfg.safe_patterns == ["my-safe-cmd"]


def test_tools_config_has_terminal_field():
    """ToolsConfig should include terminal field."""
    from mona.config.schema import ToolsConfig

    cfg = ToolsConfig()
    assert hasattr(cfg, "terminal")
    assert cfg.terminal.enable is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/tools/test_terminal_tool.py -v`
Expected: FAIL — `ImportError: cannot import name 'TerminalToolConfig'`

- [ ] **Step 3: Add `TerminalExecMode` enum and `TerminalToolConfig` to schema**

In `mona/config/schema.py`, add after line 13 (after existing imports):

```python
class TerminalExecMode(str, Enum):
    AUTO = "auto"
    APPROVAL = "approval"


class TerminalToolConfig(Base):
    """Terminal/SSH agent tool configuration."""

    enable: bool = True
    exec_mode: TerminalExecMode = TerminalExecMode.APPROVAL
    dangerous_patterns: list[str] = Field(
        default_factory=lambda: [
            "rm -rf /", "rm -rf /*", "mkfs", "dd if=", "dd of=",
            "> /dev/sd", "chmod -R 777 /", "chown -R",
            "shutdown", "reboot", "init 0", "init 6",
            ":(){ :|:& };:",
        ],
    )
    safe_patterns: list[str] = Field(
        default_factory=lambda: [
            "ls", "cat", "head", "tail", "grep", "find", "wc",
            "ps", "top", "df", "du", "free", "uptime",
            "echo", "pwd", "whoami", "hostname", "uname",
            "netstat", "ss", "ping", "curl", "wget",
        ],
    )
```

In `ToolsConfig` class (around line 304), add field:

```python
class ToolsConfig(Base):
    # ... existing fields ...
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    terminal: TerminalToolConfig = Field(default_factory=TerminalToolConfig)
```

In `_resolve_tool_config_refs()` function (around line 500), add:

```python
from mona.agent.tools.terminal import TerminalToolConfig as _TerminalToolConfig
# ... inside the function body:
mod.TerminalToolConfig = _TerminalToolConfig  # type: ignore[attr-defined]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/tools/test_terminal_tool.py -v`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Verify existing config still works (no regression)**

Run: `python -m pytest tests/tools/test_tool_validation.py -v`
Expected: PASS (no regression)

- [ ] **Step 6: Commit**

```bash
git add mona/config/schema.py tests/tools/test_terminal_tool.py
git commit -m "feat(config): add TerminalToolConfig with exec mode and risk patterns"
```

---

### Task 2: Add risk classification logic to TerminalExecTool

**Files:**
- Modify: `mona/agent/tools/terminal.py` (full rewrite of execute method + helper functions)
- Test: `tests/tools/test_terminal_tool.py`

- [ ] **Step 1: Write failing tests for risk classification**

Add to `tests/tools/test_terminal_tool.py`:

```python
def test_risk_classify_dangerous_always_approval():
    """Dangerous patterns always require approval regardless of exec_mode."""
    from mona.agent.tools.terminal import _classify_risk

    result = _classify_risk("rm -rf /tmp", exec_mode="auto")
    assert result == "approval"

    result = _classify_risk("mkfs.ext4 /dev/sdb1", exec_mode="auto")
    assert result == "approval"

    result = _classify_risk("rm -rf /tmp", exec_mode="approval")
    assert result == "approval"


def test_risk_classify_safe_in_auto_mode():
    """Safe commands skip approval when exec_mode is auto."""
    from mona.agent.tools.terminal import _classify_risk

    result = _classify_risk("ls -la", exec_mode="auto")
    assert result == "direct"

    result = _classify_risk("df -h", exec_mode="auto")
    assert result == "direct"


def test_risk_classify_safe_in_approval_mode():
    """Safe commands still need approval when exec_mode is approval."""
    from mona.agent.tools.terminal import _classify_risk

    result = _classify_risk("ls -la", exec_mode="approval")
    assert result == "approval"


def test_risk_classify_unknown_falls_back_to_exec_mode():
    """Unknown commands follow global exec_mode setting."""
    from mona.agent.tools.terminal import _classify_risk

    result = _classify_risk("some-custom-command --flag", exec_mode="auto")
    assert result == "approval"  # unknown → fallback

    result = _classify_risk("some-custom-command --flag", exec_mode="approval")
    assert result == "approval"


def test_risk_classify_case_insensitive():
    """Pattern matching should be case-insensitive."""
    from mona.agent.tools.terminal import _classify_risk

    result = _classify_risk("RM -RF /tmp", exec_mode="auto")
    assert result == "approval"

    result = _classify_risk("LS -la", exec_mode="auto")
    assert result == "direct"


def test_risk_classify_custom_patterns_from_config():
    """Custom dangerous/safe patterns from config are respected."""
    from mona.agent.tools.terminal import _classify_risk

    custom_dangerous = ["drop-table"]
    custom_safe = ["select-from"]

    result = _classify_risk(
        "DROP TABLE users",
        exec_mode="auto",
        dangerous_patterns=custom_dangerous,
        safe_patterns=custom_safe,
    )
    assert result == "approval"

    result = _classify_risk(
        "SELECT * FROM users",
        exec_mode="auto",
        dangerous_patterns=custom_dangerous,
        safe_patterns=custom_safe,
    )
    assert result == "direct"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/tools/test_terminal_tool.py::test_risk_classify -v`
Expected: FAIL — `_classify_risk` not defined yet

- [ ] **Step 3: Implement risk classification and enhanced TerminalExecTool**

Replace the content of `mona/agent/tools/terminal.py` with:

```python
from __future__ import annotations

import json
import urllib.request
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import StringSchema, tool_parameters_schema

_GATEWAY_BASE = "http://127.0.0.1"


def _gateway_port() -> int:
    try:
        import mona.config as _cfg

        cfg = _cfg.load_config()
        return getattr(cfg, "gateway_port", 7860)
    except Exception:
        return 7860


def _tauri_invoke(cmd: str, args: dict[str, Any] | None = None) -> Any:
    port = _gateway_port()
    url = f"{_GATEWAY_BASE}:{port}/api/tauri/invoke"
    payload = json.dumps({"cmd": cmd, "args": args or {}}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
            if isinstance(result, dict) and "error" in result:
                return f"Error: {result['error']}"
            return result
    except Exception as e:
        return f"Error: Tauri invoke failed: {e}"


def _classify_risk(
    command: str,
    *,
    exec_mode: str = "approval",
    dangerous_patterns: list[str] | None = None,
    safe_patterns: list[str] | None = None,
) -> str:
    """Classify command risk level. Returns 'approval' or 'direct'.

    Logic:
    1. If command matches any dangerous pattern → always 'approval'
    2. If exec_mode is 'approval' → 'approval'
    3. If exec_mode is 'auto' and matches safe pattern → 'direct'
    4. Otherwise → 'approval' (safe default)
    """
    cmd_lower = command.lower()

    dangerous = dangerous_patterns or []
    if any(p.lower() in cmd_lower for p in dangerous):
        return "approval"

    if exec_mode != "auto":
        return "approval"

    safe = safe_patterns or []
    if any(p.lower() in cmd_lower for p in safe):
        return "direct"

    return "approval"


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema("Terminal session ID to execute the command in"),
        command=StringSchema("Shell command to execute in the terminal session"),
        source=StringSchema(
            "Source label for the approval dialog (e.g. 'AI Agent')",
            nullable=True,
        ),
        require_approval=StringSchema(
            "Whether to require user approval before executing (true/false)",
            nullable=True,
        ),
        required=["session_id", "command"],
    )
)
class TerminalExecTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal"

    @property
    def name(self) -> str:
        return "terminal_exec"

    @property
    def description(self) -> str:
        return (
            "Execute a command in a Mona terminal session (SSH or local shell). "
            "Commands are classified by risk level based on tools.terminal config. "
            "Dangerous commands always require user approval. "
            "Use terminal_output (no session_id) to discover available sessions."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        session_id: str,
        command: str,
        source: str | None = None,
        require_approval: str | None = None,
        **kwargs: Any,
    ) -> str:
        explicit_approval = (
            require_approval is not None and require_approval.lower() in ("true", "1", "yes")
        )

        if explicit_approval:
            result = _tauri_invoke(
                "terminal_request_exec",
                {
                    "sessionId": session_id,
                    "command": command,
                    "source": source or "AI Agent",
                },
            )
            if isinstance(result, str) and result.startswith("Error:"):
                return result
            return f"Command submitted for approval: {command}"

        cfg = self._load_config()
        risk = _classify_risk(
            command,
            exec_mode=cfg.exec_mode.value if cfg else "approval",
            dangerous_patterns=cfg.dangerous_patterns if cfg else None,
            safe_patterns=cfg.safe_patterns if cfg else None,
        )

        if risk == "approval":
            result = _tauri_invoke(
                "terminal_request_exec",
                {
                    "sessionId": session_id,
                    "command": command,
                    "source": source or "AI Agent",
                },
            )
        else:
            result = _tauri_invoke(
                "terminal_exec_command",
                {
                    "sessionId": session_id,
                    "command": command,
                    "source": source or "ai",
                },
            )

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if risk == "approval":
            return f"Command submitted for approval: {command}"
        return f"Command executed: {command}"

    def _load_config(self):
        try:
            from mona.config.schema import load_config

            cfg = load_config()
            return getattr(getattr(cfg, "tools", None), "terminal", None)
        except Exception:
            return None


@tool_parameters(
    tool_parameters_schema(
        session_id=StringSchema(
            "Terminal session ID to get output from",
            nullable=True,
        ),
        required=[],
    )
)
class TerminalOutputTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "terminal_output"

    @property
    def name(self) -> str:
        return "terminal_output"

    @property
    def description(self) -> str:
        return (
            "Get the current terminal output buffer for a session. "
            "If session_id is not provided, lists all active sessions with their type and status."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> str:
        if session_id:
            result = _tauri_invoke(
                "terminal_get_output", {"sessionId": session_id}
            )
        else:
            result = _tauri_invoke("terminal_list_sessions")

        if isinstance(result, str) and result.startswith("Error:"):
            return result

        if isinstance(result, list):
            if session_id:
                output = str(result)
                return output[-4000:] if len(output) > 4000 else output
            lines = []
            for s in result:
                lines.append(
                    f"  {s.get('id', '?')[:8]}... | "
                    f"{s.get('sessionType', '?')} | "
                    f"{s.get('status', '?')}"
                )
            return "Active sessions:\n" + "\n".join(lines)

        return str(result)
```

- [ ] **Step 4: Run all terminal tool tests**

Run: `python -m pytest tests/tools/test_terminal_tool.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add mona/agent/tools/terminal.py tests/tools/test_terminal_tool.py
git commit -m "feat(terminal): add risk classification to TerminalExecTool"
```

---

### Task 3: Deprecate SSHExecTool

**Files:**
- Modify: `mona/agent/tools/ssh.py`

- [ ] **Step 1: Update SSHExecTool description to guide toward terminal_exec**

Replace the `description` property in `SSHExecTool` (line 41-46):

```python
@property
def description(self) -> str:
    return (
        "[DEPRECATED] Execute a command on a remote SSH server via system ssh. "
        "This tool creates a new connection each time and does not reuse existing sessions. "
        "Prefer using 'terminal_exec' instead, which reuses active SSH sessions "
        "and supports risk-based approval workflow."
    )
```

- [ ] **Step 2: Commit**

```bash
git add mona/agent/tools/ssh.py
git commit -m "chore(ssh): deprecate SSHExecTool in favor of terminal_exec"
```

---

### Task 4: Add Rust-side dangerous command guard

**Files:**
- Modify: `src-tauri/src/terminal/commands.rs:714-736`

- [ ] **Step 1: Add `is_dangerous_command` function and update `terminal_exec_command` signature**

Replace the `terminal_exec_command` function (lines 714-736):

```rust
fn is_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    let patterns = [
        "rm -rf /",
        "rm -rf /*",
        "mkfs.",
        "dd if=",
        "> /dev/sd",
        ":(){ :|:& };:",
    ];
    patterns.iter().any(|p| lower.contains(p))
}

#[tauri::command]
pub async fn terminal_exec_command(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    source: Option<String>,
) -> Result<(), String> {
    if source.as_deref() == Some("ai") && is_dangerous_command(&command) {
        return Err(
            "Dangerous command requires approval. Use terminal_request_exec instead.".into(),
        );
    }

    let data = format!("{}\n", command);
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => client
            .write(data.as_bytes())
            .await
            .map_err(|e| e.to_string()),
        SessionHandle::Local(shell) => shell.write(data.as_bytes()).map_err(|e| e.to_string()),
        SessionHandle::Sftp(_) => Err("Cannot execute command in SFTP session".into()),
        SessionHandle::Desktop(_) => Err("Cannot write to desktop session".into()),
    }
}
```

- [ ] **Step 2: Verify Rust compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/terminal/commands.rs
git commit -m "feat(rust): add AI source guard to terminal_exec_command"
```

---

### Task 5: Integration verification

**Files:** No new files

- [ ] **Step 1: Run full test suite for tools**

Run: `python -m pytest tests/tools/ -v`
Expected: All tests PASS, no regressions

- [ ] **Step 2: Verify config loads correctly with new field**

Run: `python -c "from mona.config.schema import Config; c = Config(); print(c.terminal.exec_mode)"`
Expected: Prints `TerminalExecMode.APPROVAL`

- [ ] **Step 3: Final commit if needed**

If any fixes were needed during verification, commit them.
