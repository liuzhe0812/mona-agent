from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from mona.runtime.process_tree import OwnedProcess


def test_native_terminal_exits_respect_rules_and_preserve_open_equity(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[3]
    native = Path(os.environ.get("STOCK_VIBE_TERMINAL_SOURCE", root / ".codex_tmp/vibe-native-terminal/agent"))
    python = root / ".codex_tmp/vibe-venv-313/Scripts/python.exe"
    if not native.is_dir() or not python.is_file():
        pytest.skip("prepared native regression runtime is required")
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}
    env.update(PYTHONPATH=str(native.resolve()), VIBE_TRADING_HOME=str(tmp_path), VIBE_TRADING_HOSTED="1", PYTHONUTF8="1")
    process = OwnedProcess([str(python), str(root / "tests/fixtures/stock_vibe/backtest/terminal_probe.py")],
                           cwd=tmp_path, env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = process.process.communicate(timeout=30)
        assert process.poll() == 0, stderr.decode("utf-8", errors="replace")
        assert all(json.loads(stdout).values())
    finally:
        process.close()
