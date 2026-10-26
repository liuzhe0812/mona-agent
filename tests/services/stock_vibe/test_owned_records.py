from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


def test_native_file_tools_cannot_rewrite_engine_owned_records(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    native = Path(os.environ.get("STOCK_VIBE_NATIVE_ROOT", repo / ".codex_tmp/vibe-native-final"))
    if (native / "agent").is_dir():
        native /= "agent"
    python = Path(os.environ.get("STOCK_VIBE_TEST_PYTHON", repo / ".codex_tmp/vibe-venv-313/Scripts/python.exe"))
    if not python.is_file() or not (native / "mona-source.json").is_file():
        pytest.skip("requires the controlled native runtime")
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}
    env.update(PYTHONPATH=str(native.resolve()), VIBE_TRADING_HOME=str(tmp_path / "native"), VIBE_TRADING_HOSTED="1", PYTHONUTF8="1")
    probe = '''import json, os
from pathlib import Path
from src.config.paths import get_runtime_root
from src.tools.write_file_tool import WriteFileTool
from src.tools.edit_file_tool import EditFileTool
from src.tools.read_file_tool import ReadFileTool
root = get_runtime_root()
run = root / "runs/probe"
run.mkdir(parents=True)
protected = ["sessions/example/session.json", "research_scenarios/index.json", "scheduled_research/jobs.json", "mona-attention.sqlite3", "mona-requests.sqlite3", "runs/probe/artifacts/grounding_evidence.json", "runs/probe/artifacts/scenarios/example.json"]
write = WriteFileTool()
for name in protected:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("original", encoding="utf-8")
    result = json.loads(write.execute(path=str(path), content="changed", run_dir=str(run)))
    assert result["status"] == "error", (name, result)
    edited = json.loads(EditFileTool().execute(path=str(path), old_text="original", new_text="changed", run_dir=str(run)))
    assert edited["status"] == "error", (name, edited)
    assert path.read_text(encoding="utf-8") == "original"
relative = json.loads(write.execute(path="artifacts/scenarios/new.json", content="forged", run_dir=str(run)))
assert relative["status"] == "error"
assert not (run / "artifacts/scenarios/new.json").exists()
assert json.loads(write.execute(path="report.md", content="public evidence", run_dir=str(run)))["status"] == "ok"
assert json.loads(ReadFileTool().execute(path="report.md", run_dir=str(run)))["status"] == "ok"
os.environ["VIBE_TRADING_HOSTED"] = "0"
assert json.loads(write.execute(path="artifacts/scenarios/standalone.json", content="standalone", run_dir=str(run)))["status"] == "ok"
print("OWNED_RECORD_CONTRACT_OK")
'''
    result = subprocess.run([str(python), "-c", probe], cwd=tmp_path, env=env, capture_output=True, text=True,
                            encoding="utf-8", timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "OWNED_RECORD_CONTRACT_OK" in result.stdout
