"""Selection discovery uses native operations and sessions, not a UI index."""
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
from src.api.mona_operations import _OperationStore
from src.api.mona_opportunity_records import list_selections
from src.api.mona_opportunity import _save_projection, _session_result
from src.config.paths import get_sessions_dir
from src.session.models import Session, Attempt, AttemptStatus
from src.session.store import SessionStore

context = {"plan_id":"multifactor","mode":"swing","universe":"watchlist",
           "symbols":["600000.SH"],"conditions":""}
operations = _OperationStore()
def completed(identity, operation, payload):
    operations.create(identity,operation,{"operation":operation,**payload},{},{})
    operations.update(identity,status="completed",raw_result=json.dumps({"status":"completed"}))
completed("1"*32,"opportunity_screen",context)
completed("2"*32,"backtest",{"run_id":"unrelated"})
completed("3"*32,"opportunity_screen",{**context,"unexpected":True})
sessions = SessionStore(get_sessions_dir())
research = Session(session_id="selection-research",title="自己的条件",
    config={"mona_opportunity":{**context,"plan_id":"custom","conditions":"低波动且经营稳定"}},
    last_attempt_id="selection-attempt",created_at="2024-01-02T00:00:00Z",updated_at="2024-01-03T00:00:00Z")
sessions.create_session(research)
sessions.create_attempt(Attempt(session_id=research.session_id,attempt_id=research.last_attempt_id,
    status=AttemptStatus.CANCELLED,created_at="2024-01-06T00:00:00Z"))
for index,identity in enumerate(("historical-success","historical-second"),3):
    sessions.create_attempt(Attempt(session_id=research.session_id,attempt_id=identity,
        status=AttemptStatus.COMPLETED,created_at=f"2024-01-0{index}T00:00:00Z"))
    _save_projection(research.session_id,identity,{"session_id":research.session_id,"attempt_id":identity,
        "candidates":[{"symbol":"600000.SH","rank":1}],"limitations":[]})
sessions.create_attempt(Attempt(session_id=research.session_id,attempt_id="ordinary-followup",
    status=AttemptStatus.COMPLETED,created_at="2024-01-05T00:00:00Z"))
sessions.create_attempt(Attempt(session_id=research.session_id,attempt_id="forged-candidates",
    status=AttemptStatus.COMPLETED))
_save_projection(research.session_id,"forged-candidates",{"session_id":"ordinary-chat",
    "attempt_id":"forged-candidates","candidates":[]})
draft = Session(session_id="selection-draft",config={"mona_opportunity":context},
    created_at="2024-01-01T00:00:00Z",updated_at="2024-01-01T00:00:00Z")
sessions.create_session(draft)
sessions.create_session(Session(session_id="ordinary-chat",title="普通研究",
    config={},created_at="2024-01-04T00:00:00Z"))
sessions.create_session(Session(session_id="invalid-selection",config={"mona_opportunity":{
    **context,"mode":"unknown"}}))
operations.create("4"*32,"opportunity_screen",{"operation":"opportunity_screen",**context},{},{})

all_records = list_selections(100)
assert all_records["total"] == 6 and all_records["excluded"] == 3
assert {item["kind"] for item in all_records["items"]} == {"quant","research"}
quant = next(item for item in all_records["items"] if item["id"]=="1"*32)
assert quant["operationId"] == "1"*32 and quant["input"] == context and quant["status"] == "completed"
assert next(item for item in all_records["items"] if item["id"]=="4"*32)["status"] == "queued"
research_item = next(item for item in all_records["items"] if item.get("attemptId")==research.last_attempt_id)
assert research_item["status"] == "cancelled"
assert research_item["title"] == research.title and research_item["input"]["conditions"] == "低波动且经营稳定"
historical = [item for item in all_records["items"] if item.get("sessionId")==research.session_id]
assert {item["attemptId"] for item in historical} == {research.last_attempt_id,"historical-success","historical-second"}
assert len({item["id"] for item in historical}) == 3
restored = _session_result(sessions,research.session_id,"historical-success")
assert restored["candidates"] == [{"symbol":"600000.SH","rank":1}], "cancelled followup must not hide the original result"
draft_item = next(item for item in all_records["items"] if item.get("sessionId")==draft.session_id)
assert draft_item["status"] == "not_started" and "attemptId" not in draft_item
assert all(item.get("sessionId") != "ordinary-chat" for item in all_records["items"])
first, second = list_selections(3,0), list_selections(3,3)
assert first["items"] + second["items"] == all_records["items"]
assert first["total"] == second["total"] == 6 and second["offset"] == 3
assert list_selections(2,99)["items"] == []
for limit,offset in ((True,0),(101,0),(1,-1),(1,False)):
    try: list_selections(limit,offset)
    except ValueError: pass
    else: raise AssertionError("invalid pagination accepted")
print(json.dumps({"durable_operations":True,"durable_sessions":True,
    "unrelated_excluded":True,"queued_and_draft":True,"stable_pagination":True,
    "historical_attempts_survive_followup":True,"artifact_identity_checked":True}))
'''


def test_selection_records_recover_native_operations_and_research_sessions(tmp_path: Path) -> None:
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
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="e" * 32)
    completed = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert all(json.loads(completed.stdout.splitlines()[-1]).values())
