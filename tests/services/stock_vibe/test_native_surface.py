"""Removed product surfaces must not survive in the prepared native application."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

_PROBE = r'''
import json
from fastapi import HTTPException
import api_server
from backtest.engines.china_a import ChinaAEngine
from src.api import mona_operations as operations
from src.api import mona_opportunity_history as history
from src.api import mona_opportunity as legacy_opportunity
from src.api import mona_opportunity_engine as retired_engine
from src.factors.registry import get_default_registry
from src.tools.backtest_tool import BacktestTool

paths = {getattr(route, "path", "") for route in api_server.app.routes}
assert not any(path.startswith("/mona/strategy-lab") for path in paths)
assert {"/mona/operations", "/mona/opportunity-plans", "/mona/workbench",
        "/mona/opportunity-history", "/mona/opportunity-records",
        "/mona/opportunity-history/{operation_id}/batches/{batch_id}"} <= paths
assert {"backtest", "strategy_oos_validation", "strict_factor_validation",
        "alpha_bench", "alpha_compare"} <= operations._OPERATION_NAMES
for name in ("strategy_lab_test", "strategy_lab_save", "opportunity_history",
             "opportunity_history_range", "opportunity_history_continue", "opportunity_screen"):
    assert name not in operations._OPERATION_NAMES
    try:
        operations._validate_payload({"operation": name})
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("retired calculation operation accepted")
assert callable(BacktestTool.execute) and callable(ChinaAEngine.run_backtest)
assert callable(operations._run_strategy_oos_validation)
assert callable(operations._run_strict_factor_validation)
assert callable(history.list_history) and callable(history.get_history_batch)
assert not any(hasattr(history,name) for name in ("run_history","run_history_range","run_history_continue"))
assert not hasattr(retired_engine, "compute_opportunities")
assert not any(hasattr(legacy_opportunity, name) for name in ("run_quant_opportunity", "load_opportunity_panel", "load_research_universe"))
assert get_default_registry().list()
print(json.dumps({"laboratory_absent": True, "shared_execution_retained": True,
                  "history_read_only": True, "native_registry_retained": True}))
'''


def test_native_application_removes_laboratory_keeps_shared_execution(tmp_path: Path) -> None:
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert not any(item["path"].startswith(("0038-", "0041-")) for item in receipt["patches"])
    retired = ("strategy_lab", "strategy_plan", "_cost_backtests", "include_backtests")
    for path in (source / "agent").rglob("*.py"):
        assert not any(name in path.name or name in path.read_text(encoding="utf-8")
                       for name in retired), path
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required for application registration")
    home = tmp_path / "home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA",
    }}
    environment.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1",
                       PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1",
                       VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
                       PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="a" * 32)
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
                            capture_output=True, text=True, encoding="utf-8", timeout=45,
                            check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
