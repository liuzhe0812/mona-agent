from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from mona.services.stock_vibe.contracts import OPERATION_INPUT

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "shadow" / "eastmoney-synthetic.csv"
DRIVER = r'''from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

output = Path(sys.argv[1]).resolve()
native_home = Path(sys.argv[2]).resolve()
fixture = Path(sys.argv[3]).resolve()
upload_id = "a" * 32
uploads = native_home / "uploads"
uploads.mkdir(parents=True, exist_ok=True)
shutil.copyfile(fixture, uploads / f"{upload_id}.csv")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api.mona_operations import register_mona_operations
from src.api.request_ledger import register_native_request_ledger
from src.api.security import require_auth

app = FastAPI()
register_native_request_ledger(app, require_auth)
register_mona_operations(app)
client = TestClient(app, client=("127.0.0.1", 50029))
headers = {
    "Authorization": "Bearer eastmoney-synthetic-test-key",
    "X-Mona-Request-ID": "b" * 32,
}
created = client.post(
    "/mona/operations",
    headers=headers,
    json={"operation": "analyze_trade_journal", "upload_id": upload_id},
)
assert created.status_code == 202, created.text
operation_id = created.json()["operation_id"]
deadline = time.monotonic() + 30
detail = client.get(f"/mona/operations/{operation_id}", headers=headers)
while detail.status_code == 200 and detail.json()["status"] in {"queued", "running"}:
    if time.monotonic() >= deadline:
        raise AssertionError("native Eastmoney journal analysis did not finish")
    time.sleep(0.05)
    detail = client.get(f"/mona/operations/{operation_id}", headers=headers)
assert detail.status_code == 200, detail.text
record = detail.json()
assert record["status"] == "completed", record
assert record["operation"] == "analyze_trade_journal"
assert record["references"]["upload_id"] == upload_id
result = record["tool_result"]
assert result["status"] == "ok", result
assert result["format_detected"] == "eastmoney", result
assert result["date_range"] == "2026-06-09 ~ 2026-06-10", result
assert result["total_records"] == 2
assert result["profile"]["total_trades"] == 2
assert result["profile"]["total_roundtrips"] == 1
assert result["profile"]["total_pnl"] == 9.0
assert result["profile"]["roundtrips_sample"][0]["pnl"] == 9.0
assert result["profile"]["top_symbols"][0]["symbol"] == "600519.SH"
assert result["profile"]["profit_loss_ratio"] is None
assert "Infinity" in record["tool_result_raw"]
evidence = {
    "fixture": "synthetic CSV matching the native Eastmoney parser's declared headers; not a broker export",
    "format_detected": result["format_detected"],
    "date_range": result["date_range"],
    "total_trades": result["profile"]["total_trades"],
    "total_roundtrips": result["profile"]["total_roundtrips"],
    "total_pnl": result["profile"]["total_pnl"],
    "roundtrip_pnl": result["profile"]["roundtrips_sample"][0]["pnl"],
    "api_profit_loss_ratio": result["profile"]["profit_loss_ratio"],
    "raw_infinity_preserved": "Infinity" in record["tool_result_raw"],
}
(output / "evidence.json").write_text(
    json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
    encoding="utf-8",
)
print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
'''


def _controlled_runtime() -> tuple[Path, Path]:
    source = (
        os.environ.get("STOCK_VIBE_EASTMONEY_SOURCE_ROOT")
        or os.environ.get("STOCK_VIBE_NATIVE_SOURCE_ROOT")
    )
    python = (
        os.environ.get("STOCK_VIBE_EASTMONEY_PYTHON")
        or os.environ.get("STOCK_VIBE_TEST_PYTHON")
    )
    if not source or not python:
        pytest.skip("set an explicit fresh native source and verify-9 Python 3.13 environment")
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
            "VIBE_TRADING_ALLOWED_FILE_ROOTS": str(native_home / "uploads"),
            "API_AUTH_KEY": "eastmoney-synthetic-test-key",
            "MONA_VIBE_INSTANCE_ID": "eastmoney-synthetic-instance",
            **{key: str(path) for key, path in private_paths.items()},
        }
    )
    return environment


def test_eastmoney_csv_upload_uses_the_native_full_analyzer(tmp_path: Path) -> None:
    body = {"operation": "analyze_trade_journal", "upload_id": "a" * 32}
    assert OPERATION_INPUT.validate_python(body).upload_id == body["upload_id"]

    source_root, python = _controlled_runtime()
    if not source_root.is_dir() or not python.is_file():
        pytest.skip("prepare fresh patches 0001-0025 and verify-9 Python 3.13 first")

    output = tmp_path / "eastmoney-native-route"
    output.mkdir()
    native_home = output / "private-vibe-home"
    native_home.mkdir()
    driver = output / "native_eastmoney_operation.py"
    driver.write_text(DRIVER, encoding="utf-8")
    result = subprocess.run(
        [str(python), "-B", str(driver), str(output), str(native_home), str(FIXTURE)],
        cwd=output,
        env=_child_environment(source_root, native_home),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads((output / "evidence.json").read_text(encoding="utf-8"))
    assert evidence == {
        "fixture": "synthetic CSV matching the native Eastmoney parser's declared headers; not a broker export",
        "format_detected": "eastmoney",
        "date_range": "2026-06-09 ~ 2026-06-10",
        "total_trades": 2,
        "total_roundtrips": 1,
        "total_pnl": 9.0,
        "roundtrip_pnl": 9.0,
        "api_profit_loss_ratio": None,
        "raw_infinity_preserved": True,
    }
