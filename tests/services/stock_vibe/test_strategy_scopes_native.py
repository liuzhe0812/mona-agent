"""Stock scopes retain complete membership and expose actual native coverage."""
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
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
from curl_cffi.requests import Response
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient

from src.api import mona_operations as operations
from src.api import mona_strategy_library as library
from src.api import mona_strategy_scope as scopes
from src.api.security import require_auth
from src.config.paths import get_runs_dir,get_runtime_root
from src.tools.market_screener_tool import _MARKET_FS
from src.tools.sector_tool import _RANKING_FS
from backtest import runner as native_runner
from backtest.loaders.base import NoAvailableSourceError

calls=[]
many=[{'f12':f'{number:06d}','f13':0,'f14':f'Fixture {number}'} for number in range(1,6002)]
industries=[{'f12':f'BK{number:04d}','f13':90,'f14':f'行业{number}'} for number in range(1,102)]
small=[{'f12':'600000','f13':1,'f14':'A1'},{'f12':'000001','f13':0,'f14':'A2'},
       {'f12':'920001','f13':0,'f14':'A3'}]
board=[*small[:2],{'f12':'900901','f13':1,'f14':'B-share'}, {'f12':'159919','f13':0,'f14':'ETF'}]
state={'large':True,'incomplete':False,'block':False}
resolving=threading.Event()
release=threading.Event()
patch('backtest.loaders._http._THROTTLE.wait').start()
def provider(url,*,params):
    assert params['fields']=='f12,f13,f14'
    assert int(params['pz'])==100
    fs=params['fs']
    page=int(params['pn'])
    calls.append((fs,page))
    if fs==_RANKING_FS:
        rows=industries
    elif fs==_MARKET_FS['a']:
        rows=many if state['large'] else small
        if state['block'] and page==1:
            resolving.set()
            assert release.wait(15),'scope resolver ran before HTTP acceptance'
    elif fs=='b:BK0001':
        rows=board
    else:
        raise AssertionError('unexpected scope source '+fs)
    part=rows[(page-1)*100:page*100]
    if state['incomplete'] and page==2:
        part=[]
    return {'data':{'total':len(rows),'diff':part}}

def transport(url,*,params,**kwargs):
    response=Response()
    response.status_code=200
    response.ok=True
    response.content=json.dumps(provider(url,params=params)).encode()
    return response

strategy=library.strategy_detail('builtin:multi-factor')
identity={'strategy_id':strategy['strategy_id'],'strategy_version':strategy['version']}
home=get_runtime_root()
settings={'source':'local','start_date':'2025-01-02','end_date':'2025-05-30','initial_cash':100000}
with patch('curl_cffi.requests.Session.get',side_effect=transport):
    directory=scopes.industry_catalog()
    assert len(directory['items'])==101
    assert directory['source']=='eastmoney' and directory['taxonomy']=='东方财富行业'
    calls.clear()
    full=scopes.resolve_scope({'kind':'all_a'})
    assert len(full['codes'])==6001 and full['count']==6001
    assert len(calls)==61 and calls[-1]==(_MARKET_FS['a'],61)
    clean,_=library.validate_strategy_operation({'operation':'strategy_scan',**identity,'scope':{'kind':'all_a'},'settings':settings})
    assert clean['_scope_pending'] is True
    worker,_persisted,refs=library.prepare_scoped_operation(clean)
    config=json.loads((Path(worker['_run_dir'])/'config.json').read_text(encoding='utf-8'))
    assert config['codes']==full['codes'] and len(config['codes'])==6001
    assert (Path(worker['_run_dir'])/'config.json').stat().st_size>65536
    assert not (Path(worker['_run_dir'])/'artifacts').exists(),'large scope must not load market history in this probe'
    saved=scopes.read_scope(Path(worker['_run_dir']))
    assert saved['codes']==full['codes'] and saved['identity']==full['identity']
    assert refs['scope']['identity']==full['identity'] and 'codes' not in refs['scope']
    assert refs['execution_budget']['cold_load_floor_seconds']==0
    remote=scopes.scope_budget(full,'eastmoney',1800)
    assert remote['timeout_seconds']>=1800+4*6001
    assert scopes.scope_budget(full,'eastmoney',None)['timeout_seconds'] is None
    assert scopes.scope_budget(full,'local',1800)['timeout_seconds']==1800
    # Exercise the actual scan reader and operation size gate without loading
    # thousands of quote histories. The artifact retains detailed provenance.
    wide=scopes.resolve_scope({'kind':'watchlist','codes':[f'{number:06d}.SH' for number in range(600000,608000)]})
    scopes.write_scope(Path(worker['_run_dir']),wide)
    artifacts=Path(worker['_run_dir'])/'artifacts'
    artifacts.mkdir()
    result={'status':'ok','kind':'strategy_scan',**identity,
        'signals':[{'symbol':code,'signal':1.0,'target_weight':.000125,'signal_date':'2025-05-30'} for code in wide['codes']],
        'snapshots':[{'symbol':code,'rows':90,'sha256':'f'*64} for code in wide['codes']]}
    artifact=artifacts/'strategy_scan.json'
    artifact.write_text(json.dumps(result,indent=2),encoding='utf-8')
    assert artifact.stat().st_size>2*1024*1024
    assert scopes.scoped_result_limit(Path(worker['_run_dir']),artifact=True)>artifact.stat().st_size
    with patch('src.core.runner.Runner.execute',return_value=SimpleNamespace(success=True)):
        raw,_=operations._tool_call('strategy_scan',worker)
    assert len(json.loads(raw)['signals'])==8000 and 'snapshots' not in json.loads(raw)
    assert len(json.loads(artifact.read_text())['snapshots'])==8000
    assert len(raw.encode())<scopes.scoped_result_limit(Path(worker['_run_dir']))<=6*1024*1024
    assert operations._RESULT_LIMIT==2*1024*1024
    state['incomplete']=True
    with patch.object(scopes,'_INDUSTRY_CACHE',None):
        try: scopes.industry_catalog()
        except scopes.ScopeUnavailableError as exc: assert exc.code=='scope_members_incomplete'
        else: raise AssertionError('truncated industry directory accepted')
    state['incomplete']=False
    state['large']=False
    sector=scopes.resolve_scope({'kind':'industry','industry_code':'BK0001'})
    assert sector['codes']==['600000.SH','000001.SZ']
    assert sector['excluded_non_a']==2 and sector['provider_members']==4
    try: scopes.resolve_scope({'kind':'industry','industry_code':'BK9999'})
    except scopes.ScopeUnavailableError as exc: assert exc.code=='scope_industry_not_found'
    else: raise AssertionError('concept or unknown board accepted as an industry')

watch=scopes.resolve_scope({'kind':'watchlist','codes':['600000','000001.SZ','600000.SH']})
assert watch['codes']==['600000.SH','000001.SZ'] and watch['count']==2
other=scopes.resolve_scope({'kind':'watchlist','codes':['600000.SH','920001.BJ']})
assert other['count']==watch['count'] and other['identity']!=watch['identity']
assert scopes.scope_metadata(watch)['identity']==watch['identity']
for scope in ({'kind':'watchlist','codes':[]},{'kind':'all_a','codes':['600000.SH']},
              {'kind':'watchlist','codes':['900901.BJ']},{'kind':'watchlist','codes':['159919.SZ']},
              {'kind':'watchlist','codes':['600000.SZ']},
              {'kind':'industry','industry_code':'BK0001','codes':['600000.SH']},
              {'kind':'industry','industry_code':'../BK0001'}):
    try: scopes.validate_scope(scope)
    except HTTPException as exc: assert exc.status_code==422
    else: raise AssertionError('invalid scope accepted')
try: library.validate_strategy_operation({'operation':'strategy_scan',**identity,
    'scope':{'kind':'all_a'},'settings':{**settings,'codes':['600000.SH']}})
except HTTPException as exc: assert exc.status_code==422
else: raise AssertionError('two competing stock pools accepted')

bridge=home/'data-bridge'
bridge.mkdir()
symbols=['600000.SH','000001.SZ']
dates=pd.bdate_range('2025-01-02',periods=90)
sources=[]
for number,symbol in enumerate(symbols):
    close=[30+number*5+index*.04+math.sin(index*.4+number)*.5 for index in range(len(dates))]
    frame=pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,'high':[x*1.01 for x in close],
        'low':[x*.99 for x in close],'close':close,'volume':[1000000+index*10 for index in range(len(dates))]})
    path=bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
settings.update(end_date=dates[-1].date().isoformat())

class FixtureLoader:
    name='local'
    empty=False
    def fetch(self,codes,*args,**kwargs):
        return {} if self.empty else {'600000.SH':frame.set_index(pd.to_datetime(frame['date'])).drop(columns='date')}

fixture_loader=FixtureLoader()
with patch('backtest.runner.resolve_loader',return_value=fixture_loader), patch('backtest.runner.FALLBACK_CHAINS',{}):
    request={**settings,'source':'auto','codes':['600000.SH','920001.BJ']}
    try: native_runner.fetch_data_map(request)
    except NoAvailableSourceError: pass
    else: raise AssertionError('legacy auto silently accepted incomplete data')
    partial=native_runner.fetch_data_map({**request,'_mona_scope_allow_partial':True})
    assert set(partial.data_map)=={'600000.SH'} and len(partial.codes)==2
    assert partial.effective_sources==['local']
    fixture_loader.empty=True
    empty=native_runner.fetch_data_map({**request,'_mona_scope_allow_partial':True})
    assert empty.data_map=={} and len(empty.codes)==2

app=FastAPI()
app.dependency_overrides[require_auth]=lambda:None
operations.register_mona_operations(app)
client=TestClient(app)

def finish(record,expected='completed'):
    deadline=time.monotonic()+85
    while record['status'] in {'queued','running'} and time.monotonic()<deadline:
        time.sleep(.1)
        record=client.get('/mona/operations/'+record['operation_id']).json()
    if record['status']!=expected:
        print(json.dumps(record,ensure_ascii=False),flush=True)
        if record.get('references',{}).get('run_id'):
            folder=get_runs_dir()/record['references']['run_id']
            for log in folder.rglob('*.txt'):
                print(str(log),log.read_text(encoding='utf-8',errors='replace')[-3000:],flush=True)
    assert record['status']==expected,record
    return record

with patch('curl_cffi.requests.Session.get',side_effect=transport):
    assert len(client.get('/mona/strategy-library/industries').json()['items'])==101
    state['incomplete']=True
    with patch.object(scopes,'_INDUSTRY_CACHE',None):
        assert client.get('/mona/strategy-library/industries').status_code==502
    state['incomplete']=False
    state['block']=True
    before_dirs={entry.name for entry in get_runs_dir().iterdir()}
    response=client.post('/mona/operations',json={'operation':'strategy_scan',**identity,
        'scope':{'kind':'all_a'},'settings':settings})
    assert response.status_code==202,response.text
    accepted=response.json()
    assert resolving.wait(5)
    assert 'run_id' not in accepted['references']
    assert {entry.name for entry in get_runs_dir().iterdir()}==before_dirs
    release.set()
    state['block']=False
    scan=finish(accepted)
    assert scan['tool_result']['coverage']=={'requested':3,'loaded':2,'evaluated':2,'missing':1,'complete':False}
    assert scan['references']['effective_config']['codes']==['600000.SH','000001.SZ','920001.BJ']
    assert scan['tool_result']['scope']['count']==3 and 'codes' not in scan['tool_result']['scope']
    assert any(row['symbol']=='920001.BJ' for row in scan['tool_result']['missing'])
    assert '部分' in scan['tool_result']['note']
    response=client.post('/mona/operations',json={'operation':'backtest',**identity,
        'scope':{'kind':'all_a'},'settings':settings})
    assert response.status_code==202,response.text
    backtest=finish(response.json())
    assert backtest['tool_result']['coverage']==scan['tool_result']['coverage']
    assert backtest['references']['scope']['identity']==scan['references']['scope']['identity']
    assert len(backtest['tool_result']['missing'])==1
    assert backtest['tool_result']['scope']['membership_basis']=='current_snapshot'
    assert backtest['tool_result']['scope']['point_in_time'] is False
    response=client.post('/mona/operations',json={'operation':'strategy_scan',**identity,
        'scope':{'kind':'watchlist','codes':['920001.BJ']},'settings':settings})
    assert response.status_code==202,response.text
    unavailable=finish(response.json(),'failed')
    assert unavailable['tool_result']['status']=='error'
    assert unavailable['tool_result']['coverage']=={'requested':1,'loaded':0,'evaluated':0,'missing':1,'complete':False}
    assert unavailable['tool_result']['missing']==[{'symbol':'920001.BJ','reason':'price_data_missing'}]

assert library.history(strategy_id=identity['strategy_id'])['total']==3
print(json.dumps({'complete_industries_and_6001_members':True,'large_pool_config_without_history_download':True,
    'industry_a_share_intersection':True,'truncation_rejected':True,'scope_identity_not_count':True,
    'worker_resolves_after_acceptance':True,'scan_and_backtest_actual_coverage':True,
    'native_timeout_and_unlimited_preserved':True,'watchlist_and_no_implicit_pool':True}))
'''


def test_native_strategy_scopes_preserve_members_and_coverage(tmp_path: Path) -> None:
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
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="e" * 32,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(python), "-c", _PROBE], cwd=home, env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=240, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
