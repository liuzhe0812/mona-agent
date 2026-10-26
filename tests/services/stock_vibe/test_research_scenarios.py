"""Hosted native scenario artifacts use private runs and observed-only thresholds."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = REPO_ROOT / "third_party" / "vibe-trading"
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "scenarios" / "grounding_evidence.json"

_NATIVE_PROBE = r'''import hashlib
import json
import os
import shutil
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_server
from src.api.mona_scenarios import register_mona_scenarios
from src.api.security import require_auth
from src.config.paths import get_runtime_root
from src.research_scenarios import observe_conditions
from src.tools import build_registry

root = get_runtime_root().resolve()
fixture = Path(os.environ["STOCK_VIBE_SCENARIO_LEDGER_FIXTURE"])
runs = root / "runs"
run1 = runs / "scenario-run-1"
run2 = runs / "scenario-run-2"
for run_dir in (run1, run2):
    (run_dir / "artifacts").mkdir(parents=True)
    shutil.copyfile(fixture, run_dir / "artifacts" / "grounding_evidence.json")

os.environ["VIBE_TRADING_HOSTED"] = "1"
registry = build_registry(interactive=False)
assert not registry.import_failures, registry.import_failures
assert not registry.registration_failures, registry.registration_failures
assert "record_research_scenario" in registry.tool_names
host_routes = set(api_server.app.openapi()["paths"])
assert {"/mona/scenarios", "/mona/scenarios/{artifact_id}"} <= host_routes

base = {
    "symbol": "600519.SH",
    "exchange": "SSE",
    "as_of": "2026-10-15",
    "mode": "swing",
    "horizon": "3、5、10 个交易日",
    "judgment": "watch",
    "next_step": "等待后续观测再复核",
    "conditions": [{
        "field": "close", "operator": "gte", "threshold": 1512.5,
        "fact": {"symbol": "600519.SH", "field": "close", "timestamp": "2026-10-15", "value": 1512.5},
        "missing_data": None,
    }],
    "invalidation": [
        {
            "field": "close", "operator": "lt", "threshold": 1512.5,
            "fact": {"symbol": "600519.SH", "field": "close", "timestamp": "2026-10-15", "value": 1512.5},
            "missing_data": None,
        },
        {"field": "volume", "operator": "gt", "threshold": None, "fact": None,
         "missing_data": "测试账本没有成交量观测"},
    ],
    "review_at": "2026-10-22",
    "supersedes": None,
    "revision_reason": None,
}

missing_source = dict(base)
missing_source["conditions"] = [{
    "field": "close", "operator": "gte", "threshold": 1512.5,
    "fact": None, "missing_data": None,
}]
rejected = json.loads(registry.execute("record_research_scenario", {**missing_source, "run_dir": str(run1)}))
assert rejected["status"] == "error" and "observed market fact" in rejected["error"], rejected
assert not (root / "research_scenarios" / "index.json").exists()
assert not list((run1 / "artifacts").glob("scenarios/*.json"))

outside = root.parent / "external-run"
(outside / "artifacts").mkdir(parents=True)
shutil.copyfile(fixture, outside / "artifacts" / "grounding_evidence.json")
outside_result = json.loads(registry.execute("record_research_scenario", {**base, "run_dir": str(outside)}))
unc_result = json.loads(registry.execute("record_research_scenario", {**base, "run_dir": r"\\server\share\scenario-run"}))
assert outside_result["status"] == "error" and "private runs root" in outside_result["error"], outside_result
assert unc_result["status"] == "error" and "network paths" in unc_result["error"], unc_result

linked = runs / "scenario-run-link"
if os.name == "nt":
    import subprocess
    link_result = subprocess.run(
        [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", "mklink", "/J", str(linked), str(outside)],
        capture_output=True, text=True, check=False,
    )
    assert link_result.returncode == 0, link_result.stdout + link_result.stderr
else:
    linked.symlink_to(outside, target_is_directory=True)
try:
    linked_result = json.loads(registry.execute("record_research_scenario", {**base, "run_dir": str(linked)}))
    assert linked_result["status"] == "error" and "links or junctions" in linked_result["error"], linked_result
finally:
    if os.name == "nt":
        linked.rmdir()
    else:
        linked.unlink()

first = json.loads(registry.execute("record_research_scenario", {**base, "run_dir": str(run1)}))
assert first["status"] == "ok", first
first_artifact = run1 / "artifacts" / "scenarios" / f"{first['artifact_id']}.json"
first_hash = hashlib.sha256(first_artifact.read_bytes()).hexdigest()
assert first["run_id"] == run1.name
assert first["conditions"][0]["evidence_ref"].startswith("sha256:")
assert first["conditions"][0]["source"] == "tencent"
assert first["invalidation"][1]["threshold"] is None
assert first["invalidation"][1]["missing_data"]
assert first["source"]["instance_id"] == "stock-vibe-scenario-test-instance"
assert first["source"]["data_root_sha256"] == hashlib.sha256(str(root).encode()).hexdigest()
assert first["source"]["snapshot_id"] == json.loads((Path(os.environ["PYTHONPATH"]) / "mona-source.json").read_text(encoding="utf-8"))["snapshot_id"]
assert any(item["path"] == "0015-hosted-research-scenarios.json" for item in first["source"]["patches"])
assert "path" not in first and str(root) not in json.dumps(first)

future = [{
    "symbol": "600519.SH", "field": "close", "timestamp": "2026-10-16T10:00:00Z",
    "value": 1513.0, "source": "tencent", "status": "observed",
}]
triggered = observe_conditions(first, future, "2026-10-16T10:05:00Z", timedelta(hours=1))
assert triggered["triggered"] and not triggered["invalidated"] and not triggered["expired"], triggered
assert triggered["conditions"][0]["status"] == "met"

breach = [{**future[0], "value": 1500.0}]
invalidated = observe_conditions(first, breach, "2026-10-16T10:05:00Z", timedelta(hours=1))
assert invalidated["invalidated"] and not invalidated["triggered"], invalidated

stale = observe_conditions(first, future, "2026-10-20T10:05:00Z", timedelta(hours=1))
assert not stale["triggered"] and stale["conditions"][0]["status"] == "stale", stale
expired = observe_conditions(first, future, "2026-10-23T10:05:00Z", timedelta(days=30))
assert expired["expired"] and not expired["triggered"] and expired["conditions"][0]["status"] == "expired", expired

revision_args = {**base, "supersedes": first["artifact_id"], "revision_reason": "补充复核说明"}
second = json.loads(registry.execute("record_research_scenario", {**revision_args, "run_dir": str(run2)}))
assert second["status"] == "ok", second
assert second["supersedes"] == first["artifact_id"]
assert hashlib.sha256(first_artifact.read_bytes()).hexdigest() == first_hash

app = FastAPI()
app.dependency_overrides[require_auth] = lambda: None
register_mona_scenarios(app)
with TestClient(app) as client:
    listed = client.get("/mona/scenarios")
    assert listed.status_code == 200, listed.text
    listed_items = listed.json()["scenarios"]
    assert {item["artifact_id"] for item in listed_items} == {first["artifact_id"], second["artifact_id"]}
    detail = client.get(f"/mona/scenarios/{first['artifact_id']}")
    assert detail.status_code == 200 and detail.json()["artifact_id"] == first["artifact_id"]
    assert client.get("/mona/scenarios/not-an-id").status_code == 404
    assert str(root) not in listed.text and str(root) not in detail.text

os.environ.pop("VIBE_TRADING_HOSTED")
standalone = build_registry(interactive=False)
assert "record_research_scenario" not in standalone.tool_names
standalone_app = FastAPI()
register_mona_scenarios(standalone_app)
assert not any(route.path.startswith("/mona/scenarios") for route in standalone_app.routes)

print(json.dumps({
    "status": "ok",
    "tool_registered_hosted_only": True,
    "threshold_requires_observed_fact": True,
    "old_artifact_hash_preserved": True,
    "future_triggered": triggered["triggered"],
    "invalidation_observed": invalidated["invalidated"],
    "stale_and_expired_not_triggered": True,
    "read_routes": ["/mona/scenarios", "/mona/scenarios/{artifact_id}"],
}, ensure_ascii=False))
'''


def _native_roots(tmp_path: Path) -> tuple[Path, Path]:
    configured = os.environ.get("STOCK_VIBE_NATIVE_ROOT")
    if configured:
        root = Path(configured).resolve()
        agent = root / "agent" if (root / "agent" / "src").is_dir() else root
        receipt_path = agent / "mona-source.json"
        if not receipt_path.is_file():
            raise AssertionError(f"controlled native source receipt missing: {receipt_path}")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        patch_names = {item.get("path") for item in receipt.get("patches", []) if isinstance(item, dict)}
        assert "0015-hosted-research-scenarios.json" in patch_names, "native build must include patch 0015"
    else:
        destination = tmp_path / "prepared-native"
        prepare(SNAPSHOT_ROOT, destination)
        agent = destination / "agent"
    configured_python = os.environ.get("STOCK_VIBE_TEST_PYTHON")
    python = Path(configured_python or (REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe")).resolve()
    if not python.is_file():
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared Python 3.13 environment")
    return agent, python


def _isolated_environment(agent: Path, python: Path, private: Path) -> dict[str, str]:
    home = private / "home"
    vibe_home = private / "vibe-home"
    temp = private / "temp"
    appdata = private / "appdata"
    localappdata = private / "localappdata"
    for directory in (home, vibe_home, temp, appdata, localappdata):
        directory.mkdir(parents=True, exist_ok=True)
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    path_entries = [str(python.parent)]
    if (system_root / "System32").is_dir():
        path_entries.extend([str(system_root / "System32"), str(system_root)])
    if os.environ.get("PATH"):
        path_entries.append(os.environ["PATH"])
    env = {
        "PATH": os.pathsep.join(path_entries),
        "PYTHONPATH": str(agent),
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "VIBE_TRADING_HOSTED": "1",
        "MONA_VIBE_INSTANCE_ID": "stock-vibe-scenario-test-instance",
        "VIBE_TRADING_HOME": str(vibe_home),
        "HOME": str(home),
        "USERPROFILE": str(home),
        "APPDATA": str(appdata),
        "LOCALAPPDATA": str(localappdata),
        "TEMP": str(temp),
        "TMP": str(temp),
        "STOCK_VIBE_SCENARIO_LEDGER_FIXTURE": str(FIXTURE.resolve()),
    }
    if system_root.is_dir():
        env["SystemRoot"] = str(system_root)
        env["WINDIR"] = str(system_root)
    return env


def test_native_hosted_research_scenario_artifacts_are_private_and_evidence_linked(tmp_path: Path) -> None:
    agent, python = _native_roots(tmp_path)
    private = tmp_path / "isolated-native"
    result = subprocess.run(
        [str(python), "-c", _NATIVE_PROBE],
        cwd=agent,
        env=_isolated_environment(agent, python, private),
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    assert result.returncode == 0, (
        f"native scenario probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-6000:]}\n"
        f"stderr:\n{result.stderr[-6000:]}"
    )
    assert json.loads(result.stdout.splitlines()[-1])["status"] == "ok"
