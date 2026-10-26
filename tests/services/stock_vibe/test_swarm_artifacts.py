from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

_NATIVE_ROUTE_PROBE = r'''from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

import api_server
from src.api import swarm_routes
from src.config.paths import get_runtime_root, get_swarm_runs_dir
from src.swarm.models import RunStatus, SwarmRun, SwarmTask, TaskStatus
from src.swarm.runtime import SwarmRuntime
from src.swarm.store import SwarmStore

native_home = get_runtime_root().resolve()
store = SwarmStore(get_swarm_runs_dir())
runtime = SwarmRuntime(store=store)
swarm_routes._swarm_runtime = runtime
run_id = "artifact-contract-0013"
task_id = "writer_fixture"
run_dir = store.run_dir(run_id)
good_relative = "tasks/writer_fixture/workspace/summary.md"
escape_relative = "../outside-run.md"
junction_relative = "tasks/writer_fixture/workspace/junction/escaped.md"
absolute_relative = str(Path(os.environ["STOCK_VIBE_OUTSIDE_SENTINEL"]).resolve())
good_bytes = b"Synthetic file-export contract fixture. This is not financial data.\n"
outside_run = native_home / "outside-run.md"
outside_run.write_text("outside the seeded run", encoding="utf-8")
outside_runtime = Path(os.environ["STOCK_VIBE_OUTSIDE_SENTINEL"]).resolve()
outside_runtime.parent.mkdir(parents=True, exist_ok=True)
outside_runtime.write_text("outside the private native runtime", encoding="utf-8")

run = SwarmRun(
    id=run_id,
    preset_name="artifact_contract_fixture",
    status=RunStatus.completed,
    created_at=datetime.now(timezone.utc).isoformat(),
    final_report="Synthetic file-export contract fixture; no financial result.",
    tasks=[SwarmTask(
        id=task_id,
        agent_id="fixture_writer",
        prompt_template="Export a non-financial fixture file.",
        status=TaskStatus.completed,
        summary="Synthetic file-export contract fixture.",
        artifacts=[good_relative, escape_relative, absolute_relative, junction_relative],
    )],
)
store.create_run(run)
good_path = run_dir / good_relative
good_path.parent.mkdir(parents=True, exist_ok=True)
good_path.write_bytes(good_bytes)
outside_run_path = run_dir.parent / "outside-run.md"
outside_run_path.write_text("outside the seeded run but inside the private runtime", encoding="utf-8")
junction = run_dir / "tasks" / task_id / "workspace" / "junction"
target = native_home / "junction-target"
target.mkdir(parents=True, exist_ok=True)
(target / "escaped.md").write_text("junction target outside seeded run", encoding="utf-8")
if os.name == "nt":
    import subprocess

    result = subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "mklink", "/J", str(junction), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
else:
    junction.symlink_to(target, target_is_directory=True)

auth = {"Authorization": "Bearer swarm-artifact-test-key"}
client = TestClient(api_server.app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))
base = f"/mona/swarm-runs/{run_id}/artifacts"
try:
    unauthenticated = client.get(base)
    assert unauthenticated.status_code == 401, unauthenticated.text
    manifest_response = client.get(base, headers=auth)
    assert manifest_response.status_code == 200, manifest_response.text
    manifest = manifest_response.json()
    assert set(manifest) == {"artifacts"}, manifest
    assert len(manifest["artifacts"]) == 1, manifest
    item = manifest["artifacts"][0]
    assert set(item) == {"artifact_id", "task_id", "filename", "bytes", "sha256"}, item
    assert item["task_id"] == task_id
    assert item["filename"] == "summary.md"
    assert item["bytes"] == len(good_bytes)
    assert item["sha256"] == hashlib.sha256(good_bytes).hexdigest()
    assert str(native_home).lower() not in json.dumps(manifest).lower()
    assert str(run_dir).lower() not in json.dumps(manifest).lower()
    assert str(outside_runtime).lower() not in json.dumps(manifest).lower()

    unauthenticated_download = client.get(f"{base}/{item['artifact_id']}")
    assert unauthenticated_download.status_code == 401, unauthenticated_download.text
    downloaded = client.get(f"{base}/{item['artifact_id']}", headers=auth)
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.content == good_bytes
    assert "summary.md" in downloaded.headers.get("content-disposition", "")

    unknown_id = client.get(f"{base}/{'f' * 64}", headers=auth)
    assert unknown_id.status_code == 404, unknown_id.text
    unknown_run = client.get("/mona/swarm-runs/no-such-run/artifacts", headers=auth)
    assert unknown_run.status_code == 404, unknown_run.text

    malicious_ids = [
        hashlib.sha256((task_id + "\0" + relative).encode()).hexdigest()
        for relative in (escape_relative, junction_relative, absolute_relative)
    ]
    for artifact_id in malicious_ids:
        assert client.get(f"{base}/{artifact_id}", headers=auth).status_code == 404

    print(json.dumps({
        "status": "passed",
        "run_id": run_id,
        "artifact_id": item["artifact_id"],
        "filename": item["filename"],
        "bytes": item["bytes"],
        "sha256": item["sha256"],
        "unauthenticated_status": unauthenticated.status_code,
        "unknown_artifact_status": unknown_id.status_code,
        "unknown_run_status": unknown_run.status_code,
        "escaped_artifact_statuses": [404, 404, 404],
    }, ensure_ascii=False))
finally:
    if junction.exists():
        if os.name == "nt":
            junction.rmdir()
        else:
            junction.unlink()
'''


def _controlled_native() -> tuple[Path, Path]:
    repo_root = Path(__file__).resolve().parents[3]
    native_value = os.environ.get("STOCK_VIBE_NATIVE_ROOT")
    if not native_value:
        pytest.skip("set STOCK_VIBE_NATIVE_ROOT to the prepared hosted native source")
    native_root = Path(native_value).resolve()
    if not native_root.is_dir():
        pytest.skip("set STOCK_VIBE_NATIVE_ROOT to the prepared hosted native source")
    agent = native_root / "agent" if (native_root / "agent" / "src").is_dir() else native_root
    python = Path(os.environ.get(
        "STOCK_VIBE_TEST_PYTHON",
        repo_root / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe",
    )).resolve()
    if not python.is_file():
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared Python 3.13 interpreter")
    receipt_path = agent / "mona-source.json"
    assert receipt_path.is_file(), f"controlled native receipt missing: {receipt_path}"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    patch_names = {item.get("path") for item in receipt.get("patches", []) if isinstance(item, dict)}
    assert "0013-host-swarm-artifacts.json" in patch_names, "prepared build must include patch 0013"
    return agent, python


def test_hosted_swarm_artifacts_are_opaque_authenticated_and_contained(tmp_path: Path) -> None:
    agent, python = _controlled_native()
    native_home = tmp_path / "private-vibe-home"
    private_home = tmp_path / "private-user-home"
    temp_root = tmp_path / "temp"
    outside_sentinel = tmp_path / "outside-native-root" / "sentinel.md"
    for directory in (native_home, private_home, temp_root, outside_sentinel.parent):
        directory.mkdir(parents=True, exist_ok=True)

    env_keys = (
        "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
        "APPDATA", "LOCALAPPDATA", "COMSPEC",
    )
    env = {key: os.environ[key] for key in env_keys if key in os.environ}
    env.update({
        "PATH": os.pathsep.join([str(python.parent), *([os.environ["PATH"]] if os.environ.get("PATH") else [])]),
        "PYTHONPATH": str(agent),
        "PYTHONUTF8": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "VIBE_TRADING_HOSTED": "1",
        "HOSTED": "1",
        "VIBE_TRADING_HOME": str(native_home),
        "API_AUTH_KEY": "swarm-artifact-test-key",
        "HOME": str(private_home),
        "USERPROFILE": str(private_home),
        "TEMP": str(temp_root),
        "TMP": str(temp_root),
        "STOCK_VIBE_OUTSIDE_SENTINEL": str(outside_sentinel),
    })

    result = subprocess.run(
        [str(python), "-c", _NATIVE_ROUTE_PROBE],
        cwd=agent,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert result.returncode == 0, (
        f"native Swarm artifact route probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-4000:]}\n"
        f"stderr:\n{result.stderr[-4000:]}"
    )
    evidence = json.loads(result.stdout.splitlines()[-1])
    assert evidence["status"] == "passed"
    assert evidence["unauthenticated_status"] == 401
    assert evidence["unknown_artifact_status"] == 404
    assert evidence["unknown_run_status"] == 404
