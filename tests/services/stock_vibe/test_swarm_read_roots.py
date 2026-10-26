from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_NATIVE_PROBE = r'''import json
import os
from pathlib import Path

from src.config.paths import get_runtime_root, get_swarm_runs_dir
from src.tools.path_utils import allowed_file_roots, allowed_write_roots
from src.tools.read_file_tool import ReadFileTool


runtime_root = get_runtime_root().resolve()
swarm_root = get_swarm_runs_dir().resolve()
assert swarm_root == runtime_root / "swarm" / "runs"
assert "VIBE_TRADING_ALLOWED_FILE_ROOTS" not in os.environ

peer_evidence = swarm_root / "probe-run" / "tasks" / "peer-worker" / "workspace" / "evidence.md"
peer_evidence.parent.mkdir(parents=True, exist_ok=True)
peer_evidence.write_text("native peer evidence", encoding="utf-8")
outside_sentinel = runtime_root / "outside-sentinel.md"
outside_sentinel.write_text("private sentinel", encoding="utf-8")

file_roots = [path.resolve() for path in allowed_file_roots()]
write_roots = [path.resolve() for path in allowed_write_roots()]
assert swarm_root in file_roots, file_roots
assert not any(swarm_root.is_relative_to(root) for root in write_roots), write_roots

reader = ReadFileTool()
peer_result = json.loads(reader.execute(path=str(peer_evidence)))
assert peer_result["status"] == "ok", peer_result
assert peer_result["content"] == "native peer evidence", peer_result

sentinel_result = json.loads(reader.execute(path=str(outside_sentinel)))
assert sentinel_result["status"] == "error", sentinel_result
assert sentinel_result["error_code"] == "outside_readable_roots", sentinel_result

expected_home = Path(os.environ["STOCK_VIBE_EXPECTED_HOME"]).resolve()
assert Path.home().resolve() == expected_home
assert runtime_root == Path(os.environ["VIBE_TRADING_HOME"]).resolve()
print(json.dumps({
    "status": "ok",
    "swarm_read_root": str(swarm_root),
    "peer_evidence_read": peer_result["content"],
    "outside_sentinel": sentinel_result["error_code"],
    "write_roots_include_swarm": any(swarm_root.is_relative_to(root) for root in write_roots),
    "private_home": str(Path.home()),
    "private_runtime_root": str(runtime_root),
}, ensure_ascii=False))
'''


def _agent_root() -> Path:
    configured = os.environ.get("STOCK_VIBE_NATIVE_ROOT")
    if not configured:
        pytest.skip("set STOCK_VIBE_NATIVE_ROOT to a prepared hosted native build")
    root = Path(configured).resolve()
    agent = root / "agent" if (root / "agent" / "src").is_dir() else root
    if not (agent / "src" / "tools" / "path_utils.py").is_file():
        raise AssertionError(f"controlled native source is missing: {agent}")
    receipt_path = agent / "mona-source.json"
    if not receipt_path.is_file():
        raise AssertionError(f"controlled native build has no receipt: {receipt_path}")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if not any(item.get("path") == "0011-host-swarm-read-roots.json" for item in receipt.get("patches", [])):
        raise AssertionError("controlled native build does not include patch 0011")
    return agent


def test_hosted_swarm_peer_evidence_is_read_only_and_home_is_private(tmp_path: Path) -> None:
    configured_python = os.environ.get("STOCK_VIBE_TEST_PYTHON")
    if not configured_python:
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared stock-vibe interpreter")
    python = Path(configured_python).resolve()
    if not python.is_file():
        raise AssertionError(f"stock-vibe test interpreter does not exist: {python}")
    agent = _agent_root()

    private_root = tmp_path / "probe-private"
    private_home = private_root / "home"
    private_vibe_home = private_root / "vibe-home"
    private_appdata = private_root / "appdata"
    private_localappdata = private_root / "localappdata"
    private_temp = private_root / "temp"
    for directory in (private_home, private_vibe_home, private_appdata, private_localappdata, private_temp):
        directory.mkdir(parents=True, exist_ok=True)

    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    path_entries = [str(python.parent)]
    if (system_root / "System32").is_dir():
        path_entries.extend([str(system_root / "System32"), str(system_root)])
    if os.environ.get("PATH"):
        path_entries.append(os.environ["PATH"])
    env = {
        "PATH": os.pathsep.join(path_entries),
        "HOME": str(private_home),
        "USERPROFILE": str(private_home),
        "APPDATA": str(private_appdata),
        "LOCALAPPDATA": str(private_localappdata),
        "TEMP": str(private_temp),
        "TMP": str(private_temp),
        "PYTHONPATH": str(agent),
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "VIBE_TRADING_HOSTED": "1",
        "VIBE_TRADING_HOME": str(private_vibe_home),
        "STOCK_VIBE_EXPECTED_HOME": str(private_home),
    }
    if system_root.is_dir():
        env["SystemRoot"] = str(system_root)
        env["WINDIR"] = str(system_root)

    result = subprocess.run(
        [str(python), "-c", _NATIVE_PROBE],
        cwd=agent,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, (
        f"native Swarm read-root probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-4000:]}\n"
        f"stderr:\n{result.stderr[-4000:]}"
    )
