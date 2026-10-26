"""Custom strategy deletion preserves native evidence and historical reports."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]

_PROBE = r'''
import json
import math
import time
from dataclasses import replace

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from src.api import mona_operations as operations
from src.api import mona_strategy_library as library
from src.api.security import require_auth
from src.config.paths import get_runs_dir, get_runtime_root
from src.session.events import EventBus
from src.session.models import Message
from src.session.service import SessionService
from src.session.store import SessionStore
from src.strategy_store._shared import get_store
from src.strategy_store.models import Artifact, ArtifactStatus, ArtifactType, MONA_DELETED_STRATEGY_PREFIX
from src.strategy_store.store import InMemoryStrategyStore
from src.tools.sdm_status_tool import SdmStatusTool

home = get_runtime_root()
runs = get_runs_dir()
source = runs/'deletion-source'
(source/'code').mkdir(parents=True)
code = 'import pandas as pd\nclass SignalEngine:\n    def generate(self, data_map):\n        return {code:pd.Series(0.5,index=df.index) for code,df in data_map.items()}\n'
(source/'code/signal_engine.py').write_text(code,encoding='utf-8')
store = get_store()
artifact_id = store.register_artifact(Artifact(id='',type=ArtifactType.STRATEGY,name='Custom strategy to delete',
    universe='equity_cn',run_dir=str(source),signal_engine_path=str(source/'code/signal_engine.py')))
identity = 'sdm:'+artifact_id
symbols = ['600000.SH','000001.SZ']
dates = pd.bdate_range('2025-01-02',periods=45)
settings = {'source':'local','codes':symbols,'start_date':dates[0].date().isoformat(),
    'end_date':dates[-1].date().isoformat(),'initial_cash':100000}
(source/'config.json').write_text(json.dumps({**settings,'engine':'daily','artifact_id':artifact_id,'bench_type':'manual'}),encoding='utf-8')
bridge=home/'data-bridge'
bridge.mkdir()
sources=[]
for number,symbol in enumerate(symbols):
    close=[20+number*5+index*.05+math.sin(index*.3)*.1 for index in range(len(dates))]
    frame=pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,'high':[x*1.01 for x in close],
        'low':[x*.99 for x in close],'close':close,'volume':[1000000]*len(dates)})
    path=bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
detail=library.strategy_detail(identity)
version=detail['version']
deletion={'operation':'strategy_delete','strategy_id':identity,'strategy_version':version}
scan={'operation':'strategy_scan','strategy_id':identity,'strategy_version':version,'settings':settings}
scan_clean,_=library.validate_strategy_operation(scan)
sessions=SessionService(SessionStore(home/'delete-sessions'),EventBus(),runs)
old_session=sessions.create_session(title='Historical source session',config={'mona_native_research':{
    'strategy_id':identity,'strategy_version':version}})
sessions.store.append_message(Message(session_id=old_session.session_id,role='user',content='Keep this historical research.'))

app=FastAPI()
app.dependency_overrides[require_auth]=lambda:None
operations.register_mona_operations(app)
client=TestClient(app)

for body,status in (
    ({'operation':'strategy_delete','strategy_id':'builtin:multi-factor','strategy_version':version},422),
    ({'operation':'strategy_delete','strategy_id':'alpha_zoo:alpha1','strategy_version':version},422),
    ({**deletion,'strategy_version':'0'*64},409),
    ({**deletion,'strategy_version':'invalid'},422),
    ({**deletion,'settings':{}},422),
    ({**deletion,'strategy_id':'sdm:../outside'},422),
):
    response=client.post('/mona/operations',json=body)
    assert response.status_code==status,response.text

# Reuse the real durable-operation busy gate, including before run preparation.
jobs=operations._OperationStore()
blocker='b'*32
jobs.create(blocker,'backtest',{}, {'strategy_id':'sdm:unrelated'},{})
before_dirs={path.name for path in runs.iterdir()}
assert client.post('/mona/operations',json=deletion).status_code==409
assert client.post('/mona/operations',json=scan).status_code==409
assert {path.name for path in runs.iterdir()}==before_dirs
assert not library.strategy_detail(identity)['deleted']
jobs.update(blocker,status='interrupted')

def completed(body):
    response=client.post('/mona/operations',json=body)
    assert response.status_code==202,response.text
    record=response.json()
    deadline=time.monotonic()+70
    while record['status'] in {'queued','running'} and time.monotonic()<deadline:
        time.sleep(.1)
        record=client.get('/mona/operations/'+record['operation_id']).json()
    assert record['status']=='completed',record
    return record

screen=completed(scan)
backtest=completed({**scan,'operation':'backtest'})
assert screen['tool_result']['status']=='ok'
assert backtest['tool_result']['status']=='ok'
history_before=library.history(strategy_id=identity)
assert history_before['total']==2
benches=store.get_bench_history(artifact_id)
assert benches
report_runs=[runs/screen['references']['run_id'],runs/backtest['references']['run_id'],source]
snapshots={str(path):path.read_bytes() for directory in report_runs for path in directory.rglob('*') if path.is_file()}

deleted=completed(deletion)
assert deleted['tool_result']=={'status':'ok','kind':'strategy_delete','deleted':True,
    'strategy_id':identity,'strategy_version':version,'already_deleted':False}
after=client.get('/mona/strategy-library/'+identity)
assert after.status_code==200,after.text
after=after.json()
assert after['deleted'] and after['version']==version and not after['can_scan'] and not after['can_backtest']
assert after['linked_run']==detail['linked_run']
assert identity not in {item['strategy_id'] for item in library.strategy_catalog()['items']}
assert library.history(strategy_id=identity)==history_before
assert store.get_bench_history(artifact_id)==benches
assert all(Path(path).read_bytes()==value for path,value in snapshots.items())
assert sessions.get_messages(old_session.session_id)[0].content=='Keep this historical research.'
assert client.get('/mona/operations/'+screen['operation_id']).json()['tool_result']==screen['tool_result']
assert client.get('/mona/operations/'+backtest['operation_id']).json()['tool_result']==backtest['tool_result']

for body in (scan,{**scan,'operation':'backtest'}):
    assert client.post('/mona/operations',json=body).status_code==409
try: library.prepare_operation(scan_clean)
except HTTPException as exc: assert exc.status_code==409
else: raise AssertionError('prevalidated scan ran after deletion')
context={'mona_strategy_creation':True,'mona_native_research':{'strategy_id':identity,'strategy_version':version}}
try: library.creation_context(context)
except HTTPException as exc: assert exc.status_code==409
else: raise AssertionError('deleted strategy accepted as a new modification source')
try: sessions.create_session(title='Must not modify deleted strategy',config=context)
except HTTPException as exc: assert exc.status_code==409
else: raise AssertionError('deleted strategy accepted at creation-session boundary')

deleted_record=store.get_artifact(artifact_id)
again=completed(deletion)
assert again['tool_result']['already_deleted'] is True
assert store.get_artifact(artifact_id)==deleted_record
assert library.history(strategy_id=identity)==history_before
assert json.loads(SdmStatusTool().execute(action='enable',artifact_id=artifact_id))['status']=='error'
assert store.get_artifact(artifact_id)==deleted_record
try: store.update_artifact(replace(deleted_record,disabled_reason=None,status=ArtifactStatus.ACTIVE))
except ValueError: pass
else: raise AssertionError('artifact update resurrected a deleted strategy')

# Worker rechecks the latest version; draft deletion preserves its original version.
draft_id=store.register_artifact(Artifact(id='',type=ArtifactType.STRATEGY,name='Draft deletion',universe='equity_cn'))
draft_identity='sdm:'+draft_id
draft_version=library.strategy_detail(draft_identity)['version']
draft_payload={'operation':'strategy_delete','strategy_id':draft_identity,'strategy_version':draft_version}
accepted,_=library.validate_delete(draft_payload)
store.update_artifact(replace(store.get_artifact(draft_id),signal_definition='Newer draft rules'))
conflict,_=library.execute_delete(accepted)
assert json.loads(conflict)['error_code']=='strategy_version_changed'
assert not library.strategy_detail(draft_identity)['deleted']
draft_version=library.strategy_detail(draft_identity)['version']
draft_payload['strategy_version']=draft_version
completed(draft_payload)
assert library.strategy_detail(draft_identity)['version']==draft_version
draft_record=store.get_artifact(draft_id)
completed(draft_payload)
assert store.get_artifact(draft_id)==draft_record

# The native reference store protects the same retained-deletion invariant.
memory=InMemoryStrategyStore()
memory_id=memory.register_artifact(Artifact(id='',type=ArtifactType.STRATEGY,name='Memory record',universe='equity_cn'))
memory.update_status(memory_id,ArtifactStatus.DISABLED,reason=MONA_DELETED_STRATEGY_PREFIX+version)
memory_record=memory.get_artifact(memory_id)
assert memory.update_status(memory_id,ArtifactStatus.DISABLED)==memory_record
for change in (lambda:memory.update_status(memory_id,ArtifactStatus.ACTIVE),
               lambda:memory.update_artifact(replace(memory_record,disabled_reason=None))):
    try: change()
    except ValueError: pass
    else: raise AssertionError('native reference store resurrected a deleted strategy')
print(json.dumps({'custom_only_and_version_conflict':True,'active_operation_gate':True,
    'durable_delete_and_idempotency':True,'history_and_reports_preserved':True,
    'deleted_execution_and_modification_rejected':True,'worker_version_recheck':True,
    'draft_version_preserved':True,'native_lifecycle_cannot_resurrect':True}))
'''


def test_custom_strategy_delete_preserves_native_history(tmp_path: Path) -> None:
    python = Path(os.environ.get("MONA_VIBE_TEST_PYTHON", str(ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe")))
    if not python.is_file():
        pytest.skip("explicit native Vibe Python environment required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "home"
    home.mkdir()
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    env.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="d" * 32,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(python), "-c", "from pathlib import Path\n" + _PROBE], cwd=home, env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
