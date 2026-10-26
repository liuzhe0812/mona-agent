from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DRIVER = r'''from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sys
import time
from datetime import date, timedelta
from pathlib import Path

output, native_home, fixture_root = map(lambda value: Path(value).resolve(), sys.argv[1:])
runs = native_home / "runs"
runs.mkdir(parents=True, exist_ok=True)
data_bridge = native_home / "data-bridge"
data_bridge.mkdir(parents=True, exist_ok=True)
bars_path = data_bridge / "oos-contract-bars.csv"
with bars_path.open("w", encoding="utf-8", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["date", "open", "high", "low", "close", "volume"])
    day = date(2025, 6, 2)
    index = 0
    while day <= date(2025, 6, 25):
        if day.weekday() < 5:
            close = 10.0 + index * 0.12
            writer.writerow([day.isoformat(), close - 0.03, close + 0.15, close - 0.15, close, 100000])
            index += 1
        day += timedelta(days=1)
(data_bridge / "config.yaml").write_text(
    "sources:\n  - symbol: 600000.SH\n    type: csv\n    path: "
    + json.dumps(bars_path.as_posix()) + "\n",
    encoding="utf-8",
)

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.mona_operations import _run_code_sha256, register_mona_operations
from src.api.request_ledger import register_native_request_ledger
from src.api.security import require_auth
from src.tools.backtest_tool import BacktestTool

auth = {"Authorization": "Bearer strategy-validation-synthetic-token"}
source_run_id = "source-run"
source_run = runs / source_run_id
(source_run / "code").mkdir(parents=True)
shutil.copyfile(fixture_root / "signal_engine.py", source_run / "code" / "signal_engine.py")
source_config = {
    "codes": ["local:600000.SH"],
    "start_date": "2025-06-02",
    "end_date": "2025-06-09",
    "engine": "daily",
    "initial_cash": 100000,
    "interval": "1D",
    "position_adjustment": "hold",
    "source": "local",
    "commission_rate": 0.00025,
    "commission_min": 5.0,
    "stamp_tax": 0.0005,
    "transfer_fee": 0.00001,
    "slippage": 0.001,
}
(source_run / "config.json").write_text(json.dumps(source_config, indent=2) + "\n", encoding="utf-8")
development = json.loads(BacktestTool().execute(run_dir=str(source_run)))
assert development["status"] == "ok", development
assert (source_run / "artifacts" / "equity.csv").is_file()
assert (source_run / "artifacts" / "metrics.csv").is_file()
source_config_bytes = (source_run / "config.json").read_bytes()
source_code_bytes = (source_run / "code" / "signal_engine.py").read_bytes()
source_code_sha256 = _run_code_sha256(source_run)

app = FastAPI()
register_native_request_ledger(app, require_auth)
register_mona_operations(app)
client = TestClient(app, client=("127.0.0.1", 50031))

def submit(request_id: str, body: dict) -> dict:
    response = client.post(
        "/mona/operations",
        headers={**auth, "X-Mona-Request-ID": request_id},
        json=body,
    )
    assert response.status_code == 202, response.text
    return response.json()

def wait_for(operation_id: str, timeout: float = 240) -> dict:
    deadline = time.monotonic() + timeout
    response = client.get(f"/mona/operations/{operation_id}", headers=auth)
    while response.status_code == 200 and response.json()["status"] in {"queued", "running"}:
        if time.monotonic() >= deadline:
            raise AssertionError("native strategy OOS operation did not finish")
        time.sleep(0.05)
        response = client.get(f"/mona/operations/{operation_id}", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()

payload = {
    "operation": "strategy_oos_validation",
    "run_id": source_run_id,
    "window_start": "2025-06-10",
    "window_end": "2025-06-25",
    "cost_scenarios": [
        {"scenario_id": "source_config", "overrides": {}},
        {"scenario_id": "stress", "overrides": {"commission_rate": 0.02, "slippage": 0.05}},
    ],
}
created = submit("1" * 32, payload)
record = wait_for(created["operation_id"])
assert record["status"] == "completed", record
result = record["tool_result"]
assert result["status"] == "ok" and result["experiment_status"] == "completed", result
assert result["input_run_id"] == source_run_id
assert result["development_window"] == ["2025-06-02", "2025-06-09"]
assert result["test_window"] == ["2025-06-10", "2025-06-25"]
assert result["code_sha256"] == source_code_sha256
assert result["strict_factor_validation"] == {
    "status": "not_applicable",
    "executed": False,
    "reason_code": "cross_sectional_factor_inputs_required",
}
assert record["references"]["input_run_id"] == source_run_id
assert record["references"]["code_sha256"] == source_code_sha256
assert set(record["references"]["run_ids"]) == {item["run_id"] for item in result["scenarios"]}
assert len({item["run_id"] for item in result["scenarios"]}) == 2
assert all(item["status"] == "completed" for item in result["scenarios"]), result
base, stress = result["scenarios"]
assert base["scenario_id"] == "source_config" and stress["scenario_id"] == "stress"
assert base["code_sha256"] == stress["code_sha256"] == source_code_sha256
assert base["effective_cost_config"] == {
    "commission_rate": 0.00025,
    "commission_min": 5.0,
    "stamp_tax": 0.0005,
    "transfer_fee": 0.00001,
    "slippage": 0.001,
}
assert stress["effective_cost_config"] == {
    **base["effective_cost_config"],
    "commission_rate": 0.02,
    "slippage": 0.05,
}
base_metrics = base["backtest_summary"]["metrics"]
stress_metrics = stress["backtest_summary"]["metrics"]
assert isinstance(base_metrics.get("total_return"), (int, float))
assert isinstance(stress_metrics.get("total_return"), (int, float))
assert stress_metrics["total_return"] < base_metrics["total_return"], (base_metrics, stress_metrics)
for scenario in result["scenarios"]:
    validation = scenario["validation"]
    assert validation["status"] in {"completed", "partial", "not_applicable"}, validation
    assert validation["outcome"] == "unavailable"
    assert validation["outcome_reason_code"] == "no_native_aggregate_gate"
    assert validation["artifact_available"] is True
    assert set(validation["checks"]) == {"monte_carlo", "bootstrap", "walk_forward"}
    assert (runs / scenario["run_id"] / "artifacts" / "validation.json").is_file()
    child_config = json.loads((runs / scenario["run_id"] / "config.json").read_text(encoding="utf-8"))
    assert child_config["start_date"] == "2025-06-10"
    assert child_config["end_date"] == "2025-06-25"
assert (source_run / "config.json").read_bytes() == source_config_bytes
assert (source_run / "code" / "signal_engine.py").read_bytes() == source_code_bytes
assert str(native_home) not in json.dumps(result, sort_keys=True)
assert str(native_home) not in record["tool_result_raw"]
assert record["cancellation_supported"] is False

# An owned draft without a completed development result remains not applicable.
draft_id = "draft-run"
draft = runs / draft_id
(draft / "code").mkdir(parents=True)
shutil.copyfile(fixture_root / "signal_engine.py", draft / "code" / "signal_engine.py")
(draft / "config.json").write_bytes(source_config_bytes)
draft_record = wait_for(submit("2" * 32, {
    "operation": "strategy_oos_validation",
    "run_id": draft_id,
    "window_start": "2025-06-10",
    "window_end": "2025-06-25",
})["operation_id"])
assert draft_record["status"] == "completed", draft_record
draft_result = draft_record["tool_result"]
assert draft_result["experiment_status"] == "not_applicable", draft_result
assert all(item["status"] == "not_applicable" and item["run_id"] is None for item in draft_result["scenarios"])

# Overlapping periods and arbitrary paths are rejected before queueing.
overlap = client.post(
    "/mona/operations",
    headers={**auth, "X-Mona-Request-ID": "3" * 32},
    json={
        "operation": "strategy_oos_validation",
        "run_id": source_run_id,
        "window_start": "2025-06-09",
        "window_end": "2025-06-25",
    },
)
assert overlap.status_code == 422, overlap.text
path_probe = client.post(
    "/mona/operations",
    headers={**auth, "X-Mona-Request-ID": "4" * 32},
    json={**payload, "source_path": "C:/outside/config.json"},
)
assert path_probe.status_code == 422, path_probe.text

# Missing local bars fail with no fabricated zero summary or validation result.
missing = wait_for(submit("5" * 32, {
    "operation": "strategy_oos_validation",
    "run_id": source_run_id,
    "window_start": "2025-08-01",
    "window_end": "2025-08-15",
})["operation_id"])
assert missing["status"] == "failed", missing
missing_result = missing["tool_result"]
assert missing_result["experiment_status"] == "failed", missing_result
assert missing_result["scenarios"][0]["status"] == "failed"
assert missing_result["scenarios"][0]["backtest_summary"] is None
assert missing_result["scenarios"][0]["validation"]["status"] == "not_run"

evidence = {
    "source_run_id": source_run_id,
    "development_window": result["development_window"],
    "test_window": result["test_window"],
    "code_sha256": result["code_sha256"],
    "run_ids": record["references"]["run_ids"],
    "source_total_return": base_metrics["total_return"],
    "stress_total_return": stress_metrics["total_return"],
    "validation_outcome": base["validation"]["outcome"],
    "validation_artifacts": [item["validation"]["artifact_available"] for item in result["scenarios"]],
    "strict_factor_validation": result["strict_factor_validation"],
    "draft_not_applicable": draft_result["experiment_status"] == "not_applicable",
    "missing_data_failed_without_metrics": missing_result["scenarios"][0]["backtest_summary"] is None,
}
(output / "evidence.json").write_text(
    json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = (
        os.environ.get("STOCK_VIBE_STRATEGY_VALIDATION_SOURCE_ROOT")
        or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT")
    )
    python = (
        os.environ.get("STOCK_VIBE_STRATEGY_VALIDATION_PYTHON")
        or os.environ.get("STOCK_VIBE_TEST_PYTHON")
    )
    if not source or not python:
        pytest.skip("set an explicit fresh 1–26 native source and controlled Python 3.13 environment")
    return Path(source).resolve(), Path(python).resolve()


def _child_environment(source_root: Path, native_home: Path) -> dict[str, str]:
    inherited = (
        "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "HOME",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC",
    )
    environment = {key: os.environ[key] for key in inherited if key in os.environ}
    private_paths = {
        "TEMP": native_home / "temp",
        "TMP": native_home / "temp",
        "APPDATA": native_home / "appdata",
        "LOCALAPPDATA": native_home / "localappdata",
        "XDG_CACHE_HOME": native_home / "cache",
        "XDG_CONFIG_HOME": native_home / "config",
        "MPLCONFIGDIR": native_home / "matplotlib",
    }
    for path in private_paths.values():
        path.mkdir(parents=True, exist_ok=True)
    environment.update(
        {
            "PYTHONPATH": str(source_root),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHON_DOTENV_DISABLED": "1",
            "VIBE_TRADING_HOME": str(native_home),
            "VIBE_TRADING_HOSTED": "1",
            "HOSTED": "1",
            "API_AUTH_KEY": "strategy-validation-synthetic-token",
            "MONA_VIBE_INSTANCE_ID": "strategy-validation-synthetic-instance",
            "MARKET_DATA_ORDER_A_SHARE": "local",
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_strategy_oos_validation_runs_native_cost_scenarios_and_validation() -> None:
    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare fresh source 1–26 and a controlled Python 3.13 environment first")

    output = REPO_ROOT / ".codex_tmp" / f"strategy-oos-validation-{uuid.uuid4().hex}"
    output.mkdir(parents=True)
    native_home = output / "native"
    native_home.mkdir()
    driver = output / "strategy_oos_validation.py"
    driver.write_text(DRIVER, encoding="utf-8")
    result = subprocess.run(
        [
            str(python), "-B", str(driver), str(output), str(native_home),
            str(REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "backtest"),
        ],
        cwd=output,
        env=_child_environment(source_root, native_home),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence_path = output / "evidence.json"
    assert evidence_path.is_file(), result.stdout + result.stderr
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    assert evidence["development_window"] == ["2025-06-02", "2025-06-09"]
    assert evidence["test_window"] == ["2025-06-10", "2025-06-25"]
    assert evidence["code_sha256"]
    assert len(evidence["run_ids"]) == 2
    assert evidence["source_total_return"] != evidence["stress_total_return"]
    assert evidence["validation_outcome"] == "unavailable"
    assert evidence["validation_artifacts"] == [True, True]
    assert evidence["strict_factor_validation"]["executed"] is False
    assert evidence["draft_not_applicable"] is True
    assert evidence["missing_data_failed_without_metrics"] is True
