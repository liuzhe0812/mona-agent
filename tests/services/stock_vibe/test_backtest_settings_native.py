"""The product form configures original Vibe runs, never a second backtester."""
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
import ast
import hashlib
import json
import math
import time
from datetime import date
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backtest.engines.china_a import ChinaAEngine
from backtest.runner import BacktestConfigSchema
from src.api import mona_backtest_settings as settings
from src.api import mona_operations as operations
from src.api.mona_opportunity_history import list_history
from src.api.security import require_auth
from src.config.paths import get_runs_dir, get_runtime_root

defaults = settings.backtest_defaults()
values = defaults['defaults']
native = BacktestConfigSchema.model_fields
for key in ('source','interval','initial_cash','position_adjustment','rebalance_mask',
            'rebalance_tolerance','warmup_bars','evaluation_start_date'):
    assert values[key] == native[key].default
engine = ChinaAEngine({})
for key in ('commission_rate','commission_min','stamp_tax','transfer_fee'):
    assert values[key] == getattr(engine,key)
assert values['slippage'] == engine.slippage_rate
assert values['codes'] == [] and values['validation'] is None and values['optimizer'] is None
today = date.today()
assert values['end_date'] == today.isoformat()
assert date.fromisoformat(values['start_date']).year == today.year-10
assert set(values) == set(defaults['fields'])
assert defaults['optimizer_parameters']['turnover_aware']['turnover_penalty'] == 0
assert defaults['validation_parameters']['bootstrap'] == {'n_bootstrap':1000,'confidence':.95,'seed':42}
assert {row['name']:row['value'] for row in defaults['templates'][0]['parameters']} == {
    'momentum_window':20,'vol_window':20,'top_n':3,'rebalance_freq':20}
assert all(row['editable'] for row in defaults['templates'][0]['parameters'])
assert settings.backtest_inputs() == {'inputs':[]}

def rejected(payload):
    try: operations._validate_payload(payload)
    except HTTPException as exc: assert exc.status_code in (404,422)
    else: raise AssertionError('unsafe or unsupported backtest input accepted: '+repr(payload))

base = {'operation':'backtest','template_id':'vibe_multifactor_example',
        'settings':{'codes':['600000','000001','688001','920001']}}
for body in (
    {'operation':'backtest'}, {**base,'run_id':'inputrun'},
    {**base,'template_id':'../example'},
    {**base,'strategy_parameters':{'top_n':False}},
    {**base,'strategy_parameters':{'stop_loss':.1}},
    {**base,'strategy_parameters':{'momentum_window':0}},
    {**base,'settings':{'codes':[]}},
    {**base,'settings':{'codes':['600000'],'source':'http://127.0.0.1/private'}},
    {**base,'settings':{'codes':['600000'],'api_key':'not-a-real-key'}},
    {**base,'settings':{'codes':['600000'],'initial_cash':True}},
    {**base,'settings':{'codes':['600000'],'commission_rate':float('nan')}},
    {**base,'settings':{'codes':['600000'],'warmup_bars':2,'evaluation_start_date':'2025-03-03'}},
    {**base,'settings':{'codes':['600000'],'rebalance_mask':'MS'}},
    {**base,'settings':{'codes':['600000'],'optimizer':'../../payload'}},
    {**base,'settings':{'codes':['600000'],'optimizer':'risk_parity','optimizer_params':{'risk_free':.01}}},
    {**base,'settings':{'codes':['600000'],'optimizer':'turnover_aware','optimizer_params':{'max_per_group':{'unmapped':.4}}}},
    {**base,'settings':{'codes':['600000'],'validation':{'bootstrap':{'confidence':1}}}},
    {**base,'settings':{'codes':['600000'],'validation':{'unknown':{}}}},
    {'operation':'backtest','run_id':'../outside'},
): rejected(body)
normalized = settings.validate_settings({'optimizer_params':{'groups':{'600000':'bank','920001':'other'}}})
assert normalized['optimizer_params']['groups']=={'600000.SH':'bank','920001.BJ':'other'}

home = get_runtime_root()
bridge = home/'data-bridge'
bridge.mkdir(parents=True)
symbols = ['600000.SH','000001.SZ','688001.SH','920001.BJ']
dates = pd.bdate_range('2025-01-02',periods=150)
sources = []
for number,symbol in enumerate(symbols+['000300.SH']):
    close = [30+number*4+index*.035+math.sin(index*.41+number)*.7 for index in range(len(dates))]
    frame = pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,
        'high':[value*1.01 for value in close], 'low':[value*.99 for value in close],
        'close':[value*1.002 for value in close],
        'volume':[100000+index*41+number*700 for index in range(len(dates))]})
    path = bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
original,executable = settings._template_source()
input_dir = get_runs_dir()/'inputrun'
(input_dir/'code').mkdir(parents=True)
config = {'source':'local','engine':'daily','codes':symbols,'start_date':dates[0].date().isoformat(),
          'end_date':dates[-1].date().isoformat(),'initial_cash':1000000}
config_bytes = json.dumps(config,indent=2).encode()
(input_dir/'config.json').write_bytes(config_bytes)
(input_dir/'code/signal_engine.py').write_bytes(executable)
snapshot = {str(path.relative_to(input_dir)):path.read_bytes() for path in input_dir.rglob('*') if path.is_file()}
page = settings.backtest_inputs()
item = next(item for item in page['inputs'] if item['run_id']=='inputrun')
assert item['effective_config']['commission_rate']==engine.commission_rate
assert item['effective_config']['initial_cash']==1000000
assert all(not row['editable'] for row in item['strategy_parameters'])
assert item['config_sha256']==hashlib.sha256(config_bytes).hexdigest()
rejected({'operation':'backtest','run_id':'inputrun','strategy_parameters':{'top_n':2}})

# Versioned configuration preserves the source config and code byte-for-byte.
_name,clean,_refs = operations._validate_payload({'operation':'backtest','run_id':'inputrun',
    'settings':{'initial_cash':125000,'commission_min':2}})
worker,persisted,refs = settings.configured_run(clean)
assert refs['effective_config']['initial_cash']==125000
assert refs['effective_config']['commission_min']==2
assert refs['code_sha256']==operations._run_code_sha256(input_dir)
assert snapshot=={str(path.relative_to(input_dir)):path.read_bytes() for path in input_dir.rglob('*') if path.is_file()}
assert Path(worker['_run_dir']).parent==get_runs_dir().resolve()
assert refs['config_sha256']==hashlib.sha256((Path(worker['_run_dir'])/'config.json').read_bytes()).hexdigest()

# The old generic run_id contract still copies non-A-share inputs unchanged.
crypto = get_runs_dir()/'cryptorun'
(crypto/'code').mkdir(parents=True)
crypto_config = json.dumps({**config,'codes':['BTC-USDT'],'source':'okx'}).encode()
(crypto/'config.json').write_bytes(crypto_config)
(crypto/'code/signal_engine.py').write_bytes(executable)
_name,clean,_refs = operations._validate_payload({'operation':'backtest','run_id':'cryptorun'})
legacy_worker,_persisted,legacy_refs = settings.configured_run(clean)
assert (Path(legacy_worker['_run_dir'])/'config.json').read_bytes()==crypto_config
assert 'commission_rate' not in legacy_refs['effective_config']

# Existing archives stay readable, with no calculation or new dispatch.
store = operations._OperationStore()
store.create('a'*32,'opportunity_history',{'selection_date':'2025-01-02'}, {}, {})
archive = {'kind':'opportunity_history','status':'completed','candidates':[], 'summary':{'selected':0}}
store.update('a'*32,status='completed',raw_result=json.dumps(archive))
saved_archive = store.get('a'*32)
assert list_history()['total']==1

app = FastAPI()
app.dependency_overrides[require_auth] = lambda: None
operations.register_mona_operations(app)
client = TestClient(app)
assert client.get('/mona/backtest-settings/defaults').json()['defaults']==values
assert client.get('/mona/backtest-settings/inputs?limit=0').status_code==422
assert any(item['run_id']=='inputrun' for item in client.get('/mona/backtest-settings/inputs').json()['inputs'])
body = {'operation':'backtest','template_id':'vibe_multifactor_example',
    'strategy_parameters':{'top_n':2,'rebalance_freq':10,'momentum_window':15},
    'settings':{**config,'codes':[code.split('.')[0] for code in symbols],
        'initial_cash':125000,'commission_rate':.0004,'commission_min':2,'stamp_tax':.0003,
        'transfer_fee':.00002,'slippage':.002,'position_adjustment':'rebalance','rebalance_mask':'MS',
        'rebalance_tolerance':.02,'warmup_bars':20,'optimizer':'equal_volatility',
        'optimizer_params':{'lookback':30},'benchmark':'000300.SH',
        'validation':{'bootstrap':{'n_bootstrap':20},'walk_forward':{'n_windows':3}}}}
body['settings'].pop('engine')
response = client.post('/mona/operations',json=body)
assert response.status_code==202,response.text
record = response.json()
deadline = time.monotonic()+60
while record['status'] in {'queued','running'} and time.monotonic()<deadline:
    time.sleep(.1)
    record = client.get('/mona/operations/'+record['operation_id']).json()
assert record['status']=='completed',record
assert record['tool_result']['status']=='ok',record['tool_result']
refs = record['references']
assert refs['strategy_parameters']=={'top_n':2,'rebalance_freq':10,'momentum_window':15,'vol_window':20}
assert refs['effective_config']['codes']==symbols
for key,value in body['settings'].items():
    if key!='codes': assert refs['effective_config'][key]==value,(key,refs['effective_config'][key],value)
out = get_runs_dir()/refs['run_id']
assert refs['config_sha256']==hashlib.sha256((out/'config.json').read_bytes()).hexdigest()
assert refs['code_sha256']==operations._run_code_sha256(out)
assert json.loads((out/'mona_backtest_settings.json').read_text(encoding='utf-8'))==refs
assert (out/'artifacts/metrics.csv').stat().st_size>0
assert (out/'artifacts/equity.csv').stat().st_size>0
assert (out/'artifacts/validation.json').stat().st_size>0
assert {'bootstrap','walk_forward'} <= set(json.loads((out/'artifacts/validation.json').read_text()))
assert len(pd.read_csv(out/'artifacts/trades.csv'))>0
assert store.get('a'*32)==saved_archive
assert snapshot=={str(path.relative_to(input_dir)):path.read_bytes() for path in input_dir.rglob('*') if path.is_file()}
assert any(item['run_id']==refs['run_id'] for item in settings.backtest_inputs()['inputs'])
print(json.dumps({'native_defaults':True,'strict_settings':True,'immutable_inputs':True,
    'native_template_backtest':True,'executed_parameters_and_fingerprints':True,
    'legacy_contract_and_archives':True}))
'''


def test_native_backtest_settings_configure_original_engine_and_preserve_inputs(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "native-source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "native-home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    environment.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="c" * 32,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=100, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
