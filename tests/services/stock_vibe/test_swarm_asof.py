from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

_NATIVE_PROBE = r'''from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.swarm_routes as swarm_routes
import src.market_data as market_data
from src.swarm import grounding
from src.swarm.models import RunStatus, SwarmRun
from src.swarm.runtime import SwarmRuntime
from src.swarm.store import SwarmStore

user_vars = {
    "symbol": "600519.SH",
    "start_date": "2026-09-16",
    "end_date": "2026-10-15",
}
rows = [
    {"trade_date": "2026-09-16T00:00:00", "open": 1273.93, "high": 1274.98,
     "low": 1254.1, "close": 1258.0, "volume": 26235.0},
    {"trade_date": "2026-10-15T00:00:00", "open": 1286.0, "high": 1317.76,
     "low": 1282.0, "close": 1312.97, "volume": 57677.0},
]
provenance = {
    "source": "tencent", "requested_source": "auto", "detected_source": "tencent",
    "fallback_used": False, "adjustment": "split_dividend_additive", "volume_unit": "lots",
}
fetch_calls = []

def fake_fetch(**kwargs):
    fetch_calls.append(kwargs)
    return json.dumps({"600519.SH": rows, "_provenance": {"600519.SH": provenance}})

with patch.object(market_data, "fetch_market_data_json", side_effect=fake_fetch):
    bars, metadata = grounding.fetch_grounding_snapshot(
        ["600519.SH"], start_date=date(2026, 9, 16), end_date=date(2026, 10, 15),
        today=date(2026, 10, 16),
    )
assert fetch_calls == [{
    "codes": ["600519.SH"], "start_date": "2026-09-16", "end_date": "2026-10-15",
    "source": "auto", "interval": "1D", "max_rows": 0, "include_provenance": True,
}]
item = metadata["600519.SH"]
assert item["provenance"] == provenance
assert "provider" not in item["provenance"]
assert item["coverage"] == {"start_date": "2026-09-16", "end_date": "2026-10-15", "row_count": 2}
block = grounding.format_grounding_block(bars, metadata)
assert "Actual source:** tencent" in block
assert "Requested window:** 2026-09-16 → 2026-10-15" in block
assert "Provider:** not supplied" in block

future_provenance = {**provenance}
future_rows = [*rows, {**rows[-1], "trade_date": "2026-10-16T00:00:00"}]
with patch.object(
    market_data, "fetch_market_data_json",
    return_value=json.dumps({"600519.SH": future_rows, "_provenance": {"600519.SH": future_provenance}}),
):
    try:
        grounding.fetch_grounding_snapshot(
            ["600519.SH"], start_date=date(2026, 9, 16), end_date=date(2026, 10, 15),
            today=date(2026, 10, 16),
        )
    except ValueError as exc:
        assert "outside the requested window" in str(exc)
    else:
        raise AssertionError("an out-of-window market bar was accepted")

try:
    grounding.validate_hosted_asof_window(
        {**user_vars, "end_date": "2026-10-17"}, today=date(2026, 10, 16),
    )
except ValueError as exc:
    assert "future" in str(exc)
else:
    raise AssertionError("a future end_date was accepted")

with tempfile.TemporaryDirectory() as temporary:
    store = SwarmStore(Path(temporary) / "future-runs")
    runtime = SwarmRuntime(store=store)
    runtime._execute_run = lambda *_args, **_kwargs: None
    os.environ["VIBE_TRADING_HOSTED"] = "1"
    try:
        runtime.start_run("mona_ashare_research", {**user_vars, "end_date": "2099-01-01"})
    except ValueError as exc:
        assert "future" in str(exc)
    else:
        raise AssertionError("a hosted future window was persisted as a run")
    assert store.list_runs(limit=10) == []

with tempfile.TemporaryDirectory() as temporary:
    store = SwarmStore(Path(temporary) / "api-runs")
    store.create_run(SwarmRun(
        id="swarm-asof-metadata", preset_name="mona_ashare_research",
        status=RunStatus.completed, user_vars=user_vars,
        created_at="2026-10-16T00:00:00+00:00", grounding_metadata=metadata,
    ))
    host = ModuleType("api_server")
    host._validate_path_param = lambda _value, _kind: None
    host._shell_tools_enabled_for_request = lambda _request: False
    sys.modules["api_server"] = host
    swarm_routes._swarm_runtime = SimpleNamespace(_store=store)
    app = FastAPI()
    swarm_routes.register_swarm_routes(
        app, require_auth=lambda: None, require_event_stream_auth=lambda: None,
    )
    response = TestClient(app).get("/swarm/runs/swarm-asof-metadata")
    assert response.status_code == 200, response.text
    assert response.json()["grounding_metadata"] == metadata

print(json.dumps({
    "asof_window_fixture": "passed",
    "actual_source_preserved": provenance["source"],
    "provider_inferred": False,
    "out_of_window_bar_rejected": True,
    "future_window_rejected_before_persistence": True,
    "get_swarm_run_metadata": "passed",
}, ensure_ascii=False))
'''


def _native_roots() -> tuple[Path, Path]:
    configured = os.environ.get("STOCK_VIBE_NATIVE_ROOT")
    agent_root = Path(
        configured or REPO_ROOT / ".codex_tmp" / "t05-swarm-source-with-12" / "agent"
    ).resolve()
    if (agent_root / "agent" / "src").is_dir():
        agent_root /= "agent"
    if not (agent_root / "src" / "swarm" / "grounding.py").is_file():
        pytest.skip("set STOCK_VIBE_NATIVE_ROOT to a prepared native build including patch 0012")
    receipt = json.loads((agent_root / "mona-source.json").read_text(encoding="utf-8"))
    if not any(item.get("path") == "0012-host-swarm-asof.json" for item in receipt.get("patches", [])):
        pytest.skip("prepared native build does not include patch 0012")

    configured_python = os.environ.get("STOCK_VIBE_TEST_PYTHON")
    native_python = Path(
        configured_python or REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe"
    ).resolve()
    if not native_python.is_file():
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared Python 3.13 interpreter")
    return agent_root, native_python


def test_hosted_swarm_asof_grounding_is_bounded_and_provenance_is_visible(
    tmp_path: Path,
) -> None:
    agent_root, native_python = _native_roots()
    private_root = tmp_path / "native-private"
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    env_keys = (
        "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
    )
    env = {key: os.environ[key] for key in env_keys if key in os.environ}
    env.update({
        "PATH": os.pathsep.join([str(native_python.parent), *([env["PATH"]] if env.get("PATH") else [])]),
        "PYTHONPATH": str(agent_root),
        "PYTHONUTF8": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_DOTENV_DISABLED": "1",
        "VIBE_TRADING_HOSTED": "1",
        "HOSTED": "1",
        "VIBE_TRADING_HOME": str(private_root / "vibe-home"),
        "HOME": str(private_root / "home"),
        "USERPROFILE": str(private_root / "home"),
        "APPDATA": str(private_root / "appdata"),
        "LOCALAPPDATA": str(private_root / "localappdata"),
        "TEMP": str(private_root / "temp"),
        "TMP": str(private_root / "temp"),
    })
    for name in ("vibe-home", "home", "appdata", "localappdata", "temp"):
        (private_root / name).mkdir(parents=True, exist_ok=True)
    if system_root.is_dir():
        env["SystemRoot"] = str(system_root)
        env["WINDIR"] = str(system_root)

    result = subprocess.run(
        [str(native_python), "-c", _NATIVE_PROBE],
        cwd=agent_root,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
    )
    assert result.returncode == 0, (
        f"native as-of probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-4000:]}\n"
        f"stderr:\n{result.stderr[-4000:]}"
    )
    evidence = json.loads(result.stdout.splitlines()[-1])
    assert evidence == {
        "asof_window_fixture": "passed",
        "actual_source_preserved": "tencent",
        "provider_inferred": False,
        "out_of_window_bar_rejected": True,
        "future_window_rejected_before_persistence": True,
        "get_swarm_run_metadata": "passed",
    }
