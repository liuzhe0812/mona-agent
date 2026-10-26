"""Retired historical calculations remain readable as immutable native archives."""
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
from copy import deepcopy
from fastapi import HTTPException
from src.api import mona_operations as operations
from src.api import mona_opportunity_history as history
from src.config.paths import get_runtime_root
from src.factors.registry import get_default_registry
from src.tools.backtest_tool import BacktestTool
from backtest.engines.china_a import ChinaAEngine

context = {"plan_id":"multifactor","mode":"swing","universe":"watchlist",
           "symbols":["600000.SH"],"conditions":""}
single_input = {**context,"selection_date":"2025-01-02","horizon":5,"top_n":5}
range_input = {**context,"start_date":"2025-01-02","end_date":"2025-01-10","horizon":5,"top_n":5}
root = (get_runtime_root()/"opportunity-history").resolve()
root.mkdir(parents=True)
def artifact(identity, selection_date="2025-01-02"):
    value = {"kind":"opportunity_history","batch_id":identity,"status":"completed",
        "selection_date":selection_date,"horizon":5,"candidates":[{"symbol":"600000.SH","rank":1}],
        "summary":{"selected":1,"observed":1,"average_return":.02},
        "method":{"version":"archived-method"},"limitations":[]}
    (root/(identity+".json")).write_text(json.dumps(value),encoding="utf-8")
    return value
first_id, second_id, continued_id = ("history_"+str(i)*32 for i in (1,2,3))
single = artifact(first_id)
second = artifact(second_id,"2025-01-03")
second["batch_id"] = first_id
(root/(second_id+".json")).write_text(json.dumps(second),encoding="utf-8")
continued_batch = artifact(continued_id)
continued_batch.update(parent_batch_id=first_id,source_operation_id="2"*32)
(root/(continued_id+".json")).write_text(json.dumps(continued_batch),encoding="utf-8")
single.update(status="incomplete",awaiting_observation=True,
    window={"available_trading_days":2},candidates=[{"symbol":"600000.SH","status":"pending",
    "reason":"观察周期尚未走完，暂不计算最终涨跌。"}])
ranged = {"kind":"opportunity_history_range","status":"completed","sampling":"all_market_days_v1",
    "batches":[{"batch_id":first_id},{"batch_id":second_id},{"batch_id":"history_"+"9"*32},
        {"batch_id":"../outside"}],"summary":{"total_batches":2,"complete_batches":2,"average_return":.02}}
continued_single = {**artifact("history_"+"4"*32),"source_operation_id":"1"*32}
continued_range = {"kind":"opportunity_history_range","status":"completed","source_operation_id":"2"*32,
    "batches":[{"batch_id":continued_id}],"summary":{"total_batches":1,"complete_batches":1}}
store = operations._OperationStore()
def saved(identity,name,payload,result):
    store.create(identity,name,{"operation":name,**payload},{},{})
    store.update(identity,status="completed",raw_result=json.dumps(result))
saved("1"*32,"opportunity_history",single_input,single)
saved("2"*32,"opportunity_history_range",range_input,ranged)
saved("3"*32,"opportunity_history_continue",{"source_operation_id":"1"*32},continued_single)
saved("4"*32,"opportunity_history_continue",{"source_operation_id":"2"*32},continued_range)
saved("5"*32,"backtest",{},ranged)
chained = deepcopy(continued_single)
chained["source_operation_id"] = "3"*32
saved("7"*32,"opportunity_history_continue",{"source_operation_id":"3"*32},chained)
store.create("6"*32,"opportunity_history_range",{"operation":"opportunity_history_range",**range_input},{},{})
before_records = {identity:store.get(identity) for identity in (str(i)*32 for i in range(1,8))}
before_files = {path.name:path.read_bytes() for path in root.glob("*.json")}

page = history.list_history(2,0)
assert page["total"] == 6 and page["limit"] == 2 and len(page["items"]) == 2
all_items = history.list_history(100)["items"]
assert all(item["operation"] in history.HISTORY_OPERATIONS for item in all_items)
assert next(item for item in all_items if item["operation_id"]=="1"*32)["result_status"] == "pending"
assert next(item for item in all_items if item["operation_id"]=="6"*32)["status"] == "queued"
for identity,request in (("1",single_input),("2",range_input),("3",single_input),("4",range_input),("7",single_input)):
    item = next(item for item in all_items if item["operation_id"]==identity*32)
    assert item["input"] == request
    assert not ({"tool_result","tool_result_raw","candidates","method"} & set(item))
assert next(item for item in all_items if item["operation_id"]=="2"*32)["batch_count"] == 4
assert page["items"]+history.list_history(2,2)["items"]+history.list_history(2,4)["items"] == all_items
assert history.list_history(2,99)["items"] == []
assert history.get_history_batch("2"*32,first_id)["method"]["version"] == "archived-method"
assert history.get_history_batch("4"*32,continued_id)["parent_batch_id"] == first_id
for operation_id,batch_id in (("2"*32,continued_id),("4"*32,first_id),("1"*32,first_id),
    ("5"*32,first_id),("a"*32,first_id),("../invalid",first_id),("2"*32,"../outside"),
    ("2"*32,"history_"+"9"*32),("2"*32,second_id)):
    try: history.get_history_batch(operation_id,batch_id)
    except ValueError: pass
    else: raise AssertionError("unowned, missing or malformed archive accepted")
assert history._batch_path(first_id).parent == root
for invalid in ("../outside","history_"+"a"*32+"/file","/private",True):
    try: history._batch_path(invalid)
    except ValueError: pass
    else: raise AssertionError("invalid archive identity accepted")
for limit,offset in ((True,0),(101,0),(1,-1),(1,False)):
    try: history.list_history(limit,offset)
    except ValueError: pass
    else: raise AssertionError("invalid archive pagination accepted")
assert {identity:store.get(identity) for identity in before_records} == before_records
assert {path.name:path.read_bytes() for path in root.glob("*.json")} == before_files

for name in history.HISTORY_OPERATIONS:
    assert name not in operations._OPERATION_NAMES
    try: operations._validate_payload({"operation":name,**single_input})
    except HTTPException as exc:
        assert exc.status_code == 422 and exc.detail == "unsupported native operation"
    else: raise AssertionError("retired historical calculation accepted")
assert not any(hasattr(history,name) for name in ("run_history","run_history_range","run_history_continue",
    "validate_history","compute_opportunities","load_history_prices","load_market_calendar","_observe","_persist"))
assert {"backtest","strategy_oos_validation","strict_factor_validation","alpha_bench","alpha_compare"} <= operations._OPERATION_NAMES
assert "opportunity_screen" not in operations._OPERATION_NAMES
assert callable(BacktestTool.execute) and callable(ChinaAEngine.run_backtest)
assert get_default_registry().list(), "native factor registry must remain available"
print(json.dumps({"immutable_archive":True,"full_input_chain":True,"ownership_and_paths":True,
    "durable_pagination":True,"no_new_dispatch":True,"native_finance_retained":True}))
'''


def test_history_archive_retains_results_without_calculation_or_new_dispatch(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "native-source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "native-home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA",
    }}
    environment.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="c" * 32)
    completed = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=45, check=False)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert all(json.loads(completed.stdout.splitlines()[-1]).values())
