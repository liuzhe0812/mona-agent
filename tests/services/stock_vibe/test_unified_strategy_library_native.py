"""Original strategies share one controlled signal and backtest execution path."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]

_PROBE = r'''
import hashlib
import json
import math
import time
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from src.api import mona_strategy_library as library
from src.api import mona_operations as operations
from src.api.security import require_auth
from src.config.paths import get_runs_dir, get_runtime_root
from src.strategy_store.models import Artifact, ArtifactType
from src.strategy_store._shared import get_store

catalog = library.strategy_catalog()
assert library._daily_cutoff(datetime(2026,10,21,14,59,tzinfo=ZoneInfo('Asia/Shanghai'))) == '2026-10-20'
assert library._daily_cutoff(datetime(2026,10,21,15,0,tzinfo=ZoneInfo('Asia/Shanghai'))) == '2026-10-21'
assert library._daily_cutoff(datetime(2026,10,21,16,30,tzinfo=ZoneInfo('Asia/Shanghai'))) == '2026-10-21'
assert catalog['total'] == 20
assert len({row['strategy_id'] for row in catalog['items']}) == 20
assert all(row['source'] == 'builtin' and row['example'] for row in catalog['items'])
assert sum(row['market'] == 'options' for row in catalog['items']) == 5
assert library.strategy_catalog(limit=3,offset=3)['items'] == catalog['items'][3:6]
assert library.strategy_catalog(q='波动')['total'] > 0
assert library.strategy_catalog(market='china_a')['total'] == 15
assert not library.strategy_detail('builtin:cross-market-strategy')['can_backtest']
assert not library.strategy_detail('builtin:pair-trading')['can_scan']
assert not library.strategy_detail('builtin:elliott-wave')['can_backtest']
assert '请选择其他策略' in library.strategy_detail('builtin:elliott-wave')['unavailable_reason']
assert not library.strategy_detail('builtin:options-strategy-iron-condor')['can_backtest']
assert all('AI' not in library.strategy_detail('builtin:'+slug)['unavailable_reason']
    for slug in ('event-driven','elliott-wave'))
assert len({library.strategy_detail('builtin:options-strategy-'+slug)['version']
    for slug in ('cash-secured-put','iron-condor','vol-gated-strangle','covered-call','protective-put')}) == 5
store = get_store()
factor_id = store.register_artifact(Artifact(id='',type=ArtifactType.FACTOR,name='Not a trading strategy',universe='equity_cn'))
draft_id = store.register_artifact(Artifact(id='',type=ArtifactType.STRATEGY,name='Research draft',universe='equity_cn'))
assert library.strategy_catalog()['total'] == 21
assert not library.strategy_detail('sdm:'+draft_id)['can_scan']
try: library.strategy_detail('sdm:'+factor_id)
except HTTPException as exc: assert exc.status_code == 404
else: raise AssertionError('factor admitted to executable strategy library')

strategy = library.strategy_detail('builtin:multi-factor')
identity = {'strategy_id':strategy['strategy_id'],'strategy_version':strategy['version']}
assert {item['name'] for item in strategy['parameters'] if item['editable']} == {'momentum_window','vol_window','top_n','rebalance_freq'}
for body in (
    {'operation':'strategy_scan',**identity,'run_id':'arbitrary'},
    {'operation':'strategy_scan',**identity,'strategy_version':'0'*64},
    {'operation':'strategy_scan',**identity,'settings':{'codes':[]}},
    {'operation':'strategy_scan',**identity,'strategy_parameters':{'top_n':True}},
    {'operation':'strategy_scan',**identity,'strategy_parameters':{'stop_loss':.1}},
    {'operation':'strategy_scan',**identity,'settings':{'codes':['600000'],'source':'http://127.0.0.1'}},
):
    try: operations._validate_payload(body)
    except HTTPException as exc: assert exc.status_code in (409,422)
    else: raise AssertionError('invalid strategy request accepted: '+repr(body))

home = get_runtime_root()
bridge = home/'data-bridge'
bridge.mkdir(parents=True)
symbols = ['600000.SH','000001.SZ','688001.SH','920001.BJ']
dates = pd.bdate_range('2025-01-02',periods=150)
sources = []
for number,symbol in enumerate(symbols):
    close = [30+number*4+index*.035+math.sin(index*.41+number)*.7 for index in range(len(dates))]
    frame = pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,
        'high':[value*1.01 for value in close], 'low':[value*.99 for value in close],
        'close':[value*1.002 for value in close],
        'volume':[100000+index*41+number*700 for index in range(len(dates))]})
    path = bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
settings = {'source':'local','codes':symbols,'start_date':dates[0].date().isoformat(),
            'end_date':dates[-1].date().isoformat(),'initial_cash':100000}
app=FastAPI()
app.dependency_overrides[require_auth]=lambda:None
operations.register_mona_operations(app)
client=TestClient(app)
assert client.get('/mona/strategy-library?limit=2&offset=1').json()['total']==21
assert client.get('/mona/strategy-library?source=factors').status_code==422
assert client.get('/mona/strategy-library?q=a&q=b').status_code==422

def run_operation(body, expected_status='completed'):
    response = client.post('/mona/operations',json=body)
    assert response.status_code==202,response.text
    record=response.json()
    deadline=time.monotonic()+80
    while record['status'] in {'queued','running'} and time.monotonic()<deadline:
        time.sleep(.1)
        record=client.get('/mona/operations/'+record['operation_id']).json()
    if record['status']!=expected_status:
        run=get_runs_dir()/record['references']['run_id']
        logs={str(path.relative_to(run)):path.read_text(encoding='utf-8',errors='replace')[-5000:]
              for path in run.rglob('*') if path.is_file() and path.suffix in {'.log','.txt'}}
        raise AssertionError((record,logs))
    return record

scan=run_operation({'operation':'strategy_scan',**identity,'settings':settings})
result=scan['tool_result']
assert result['status']=='ok' and result['kind']=='strategy_scan'
assert result['strategy_version']==strategy['version']
assert result['data_as_of']==dates[-1].date().isoformat()
assert all(row['signal_date']==result['data_as_of'] for row in result['signals'])
assert len(result['signals'])==3
assert sum(row['target_weight'] for row in result['signals']) <= 1.0000001
assert result['effective_at'] is None
assert result['snapshots'] and all(row['rows']==150 for row in result['snapshots'])

backtest=run_operation({'operation':'backtest',**identity,'settings':settings})
assert backtest['tool_result']['status']=='ok'
scan_dir=get_runs_dir()/scan['references']['run_id']
backtest_dir=get_runs_dir()/backtest['references']['run_id']
assert scan['references']['code_sha256']==backtest['references']['code_sha256']
assert (scan_dir/'code/signal_engine.py').read_bytes()==(backtest_dir/'code/signal_engine.py').read_bytes()
assert (backtest_dir/'artifacts/equity.csv').is_file()
assert not (scan_dir/'artifacts/equity.csv').exists()
assert library.history(strategy_id=identity['strategy_id'])['total']==2
assert library.history(limit=1,offset=1)['items'][0]['operation_id']==scan['operation_id']
assert library.history(operation='backtest')['total']==1
assert library.history(operation='strategy_scan')['total']==1
assert client.get('/mona/strategy-library/history?operation=invalid').status_code==422

# Observation uses this bar; execution keeps the original next-bar shift.
from backtest.engines.base import _align
index=pd.bdate_range('2025-01-02',periods=4)
data={'600000.SH':pd.DataFrame({'close':[10.,11.,12.,13.]},index=index)}
signals={'600000.SH':pd.Series([0.,0.,0.,1.],index=index)}
assert _align(data,signals,list(data))[3].iloc[-1,0]==0
assert _align(data,signals,list(data),signal_shift=0)[3].iloc[-1,0]==1

# A real successful write receipt is necessary for automatic creation.
generation=get_runs_dir()/'generated-current'
(generation/'code').mkdir(parents=True)
code='import pandas as pd\nclass SignalEngine:\n    def generate(self, data_map):\n        return {code: pd.Series(1.0,index=df.index) for code,df in data_map.items()}\n'
(generation/'code/signal_engine.py').write_text(code,encoding='utf-8')
(generation/'config.json').write_text(json.dumps({**settings,'engine':'daily'}),encoding='utf-8')
session=SimpleNamespace(config={'mona_strategy_creation':True},title='Generated strategy',session_id='sessiontest')
attempt=SimpleNamespace(attempt_id='attempttest')
plain={'status':'success','run_dir':str(generation),'tool_trail':[]}
for action in (lambda:library.creation_context({'mona_strategy_creation':True,'mona_native_research':identity}),
    lambda:library.finish_creation(SimpleNamespace(config={'mona_strategy_creation':True,'mona_native_research':identity}),attempt,plain)):
    try: action()
    except HTTPException as exc: assert exc.status_code==422
    else: raise AssertionError('built-in strategy admitted as an AI modification parent')
assert library.creation_context({'mona_native_research':identity})==''
assert '<strategy_creation_context>' in library.creation_context({'mona_strategy_creation':True})
assert 'existing-research' in library.creation_context({'mona_strategy_creation':True,
    'mona_native_research':{'swarm_id':'existing-research'}})
def incomplete_registration(result):
    try: library.finish_creation(session,attempt,result)
    except ValueError as exc: assert str(exc)=='strategy_registration_incomplete'
    else: raise AssertionError('strategy files without current receipts were silently ignored')
incomplete_registration(plain)
from src.tools.write_file_tool import WriteFileTool
from src.tools.sdm_register_tool import SdmRegisterTool
def write_receipt(path,content,call_id):
    raw=WriteFileTool().execute(path=str(path),content=content,run_dir=str(path.parent.parent if path.parent.name=='code' else path.parent))
    assert json.loads(raw)['status']=='ok',raw
    receipt=library.strategy_tool_receipt('write_file',raw)
    assert receipt['kind']=='file' and receipt['sha256']==hashlib.sha256(path.read_bytes()).hexdigest()
    return {'tool':'write_file','status':'ok','call_id':call_id,'strategy_receipt':receipt,'arguments':{'path':str(path)}}
code_receipt=write_receipt(generation/'code/signal_engine.py',code,'code-1')
incomplete_registration({**plain,'tool_trail':[code_receipt]})
config_receipt=write_receipt(generation/'config.json',json.dumps({**settings,'engine':'daily'}),'config-1')
incomplete_registration({**plain,'tool_trail':[{'tool':'sdm_register','status':'ok',
    'call_id':'old-name','arguments':{'name':'Research draft'}}]})
output=library.finish_creation(session,attempt,{**plain,'tool_trail':[code_receipt,config_receipt]})
assert len(output)==1
custom=library.strategy_detail(output[0]['strategy_id'])
assert custom['source']=='custom' and custom['can_scan'] and not custom['has_evidence']
snapshot=get_runs_dir()/custom['linked_run']['run_id']
assert snapshot!=generation and (snapshot/'code/signal_engine.py').read_text(encoding='utf-8')==code
custom_scan=run_operation({'operation':'strategy_scan','strategy_id':custom['strategy_id'],
    'strategy_version':custom['version'],'settings':settings})
assert len(custom_scan['tool_result']['signals'])==4
assert all(row['target_weight']==.25 for row in custom_scan['tool_result']['signals'])
assert store.get_artifact(custom['strategy_id'].split(':')[1]).derived_from is None
assert library.strategy_catalog(source='custom')['total']==2
custom_identity={'strategy_id':custom['strategy_id'],'strategy_version':custom['version']}
session.config={'mona_strategy_creation':True,'mona_native_research':custom_identity}
assert custom['strategy_id'] in library.creation_context(session.config)
for action in (lambda:library.creation_context({'mona_strategy_creation':True,'mona_native_research':{**custom_identity,'strategy_version':'0'*64}}),
    lambda:library.finish_creation(SimpleNamespace(config={'mona_strategy_creation':True,
        'mona_native_research':{**custom_identity,'strategy_version':'0'*64}}),attempt,plain)):
    try: action()
    except HTTPException as exc: assert exc.status_code==409
    else: raise AssertionError('changed custom parent version accepted')

# Real registration receipt identifies the new artifact even if another has a similar title.
generation2=get_runs_dir()/'generated-register'
(generation2/'code').mkdir(parents=True)
code2=code.replace('1.0','0.0')
trails=[write_receipt(generation2/'code/signal_engine.py',code2,'code-2'),
    write_receipt(generation2/'config.json',json.dumps({**settings,'engine':'daily'}),'config-2')]
registered=SdmRegisterTool().execute(artifact_type='strategy',name='Registered generated strategy',
    universe='equity_cn',signal_engine_path=str(generation2/'code/signal_engine.py'),signal_definition='Always flat')
registration=library.strategy_tool_receipt('sdm_register',registered)
assert registration['kind']=='registration',registered
registered_id=registration['artifact_id']
trails.append({'tool':'sdm_register','status':'ok','call_id':'register-2','strategy_receipt':registration,
    'arguments':{'name':'Research draft'}})
out2=library.finish_creation(session,attempt,{'status':'success','run_dir':str(generation2),'tool_trail':trails})
assert out2[0]['strategy_id']=='sdm:'+registered_id
assert len(out2)==1 and library.strategy_catalog(source='custom')['total']==3
assert Path(store.get_artifact(registered_id).run_dir)!=generation2
zero_strategy=library.strategy_detail('sdm:'+registered_id)
zero=run_operation({'operation':'strategy_scan','strategy_id':zero_strategy['strategy_id'],
    'strategy_version':zero_strategy['version'],'settings':settings})
assert zero['tool_result']['status']=='ok' and zero['tool_result']['signals']==[]

# A strategy omitting the newest bar is not a valid zero-signal result.
generation3=get_runs_dir()/'generated-missing-latest'
(generation3/'code').mkdir(parents=True)
missing_code=code.replace('index=df.index','index=df.index[:-1]')
missing_trail=[write_receipt(generation3/'code/signal_engine.py',missing_code,'code-latest'),
    write_receipt(generation3/'config.json',json.dumps({**settings,'engine':'daily'}),'config-latest')]
latest_session=SimpleNamespace(config=session.config,title='Missing latest strategy',session_id='latest-session')
missing_asset=library.finish_creation(latest_session,attempt,{'status':'success','run_dir':str(generation3),'tool_trail':missing_trail})[0]
missing_latest=run_operation({'operation':'strategy_scan','strategy_id':missing_asset['strategy_id'],
    'strategy_version':missing_asset['version'],'settings':settings},expected_status='failed')
assert missing_latest['tool_result']['error_code']=='no_signals_at_data_cutoff'
assert len(missing_latest['tool_result']['missing'])==4
assert missing_latest['tool_result']['signals']==[]

# Required fields and warm-up failures are not disguised as an empty successful screen.
from backtest.runner import _load_module_from_file
from backtest.strategy_scan import scan_signals
sample_data={symbol:pd.read_csv(bridge/(symbol+'.csv'),parse_dates=['date']).set_index('date') for symbol in symbols}
def unavailable_data(slug,requirements,frames):
    directory=get_runs_dir()/('requirements-'+slug)
    (directory/'code').mkdir(parents=True)
    _raw,engine_code,_path=library._builtin_code(library._builtin(slug))
    (directory/'code/signal_engine.py').write_bytes(engine_code)
    (directory/'mona_strategy_source.json').write_text(json.dumps({**identity,'data_requirements':requirements}))
    engine=_load_module_from_file(directory/'code/signal_engine.py','signal_engine').SignalEngine()
    scan_signals(settings,frames,engine,directory)
    payload=json.loads((directory/'artifacts/strategy_scan.json').read_text(encoding='utf-8'))
    assert payload['status']=='error' and payload['error_code']=='strategy_data_unavailable'
    return {row['reason'] for row in payload['missing']}
assert unavailable_data('event-driven',{'event_score':True},sample_data)=={'required_fields_missing'}
assert unavailable_data('fundamental-filter',{'fundamentals':True},sample_data)=={'required_fundamental_fields_missing'}
assert unavailable_data('multi-factor',{'min_bars':21,'minimum_symbols':2},
    {code:frame.iloc[:5] for code,frame in sample_data.items()})=={'insufficient_history'}

# Full Session -> AgentLoop -> native ToolLifecycle -> writes/register -> persisted artifact.
import asyncio
from unittest.mock import patch
from src.providers.chat import LLMResponse,LLMRuntimeSnapshot,ToolCallRequest
from src.session.service import SessionService
from src.session.store import SessionStore
from src.session.events import EventBus
model_calls=[]
class CreationResponses:
    model_name='strategy-creation-regression'
    runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
    def __init__(self,*args,**kwargs):
        self.step=0
        self.system=None
    def close(self): pass
    def stream_chat(self,messages,**kwargs):
        self.step+=1
        if self.system is None: self.system=messages[0]['content']
        assert self.system==messages[0]['content']
        assert '<strategy_creation_context>' not in self.system
        model_calls.append(self.step)
        if self.step==1:
            user=next(message['content'] for message in reversed(messages) if message['role']=='user')
            assert '<strategy_creation_context>' in user
            assert custom_identity['strategy_id'] in user
            return LLMResponse(tool_calls=[ToolCallRequest(id='creation-skill',name='load_skill',
                arguments={'name':'strategy-generate'})],finish_reason='tool_calls')
        if self.step==2:
            return LLMResponse(tool_calls=[
                ToolCallRequest(id='creation-config',name='write_file',arguments={'path':'config.json','content':json.dumps({**settings,'engine':'daily'})}),
                ToolCallRequest(id='creation-code',name='write_file',arguments={'path':'code/signal_engine.py','content':code})],finish_reason='tool_calls')
        if self.step==3:
            return LLMResponse(tool_calls=[
                ToolCallRequest(id='creation-edit-code',name='edit_file',arguments={'path':'code/signal_engine.py',
                    'old_text':'pd.Series(1.0,','new_text':'pd.Series(0.5,'}),
                ToolCallRequest(id='creation-edit-config',name='edit_file',arguments={'path':'config.json',
                    'old_text':'"initial_cash": 100000','new_text':'"initial_cash": 125000'})],finish_reason='tool_calls')
        if self.step==4:
            engine_path=None
            for message in messages:
                if message.get('role')!='tool': continue
                try: payload=json.loads(message['content'])
                except (ValueError,TypeError): continue
                if isinstance(payload,dict) and str(payload.get('path','')).endswith('signal_engine.py'):
                    engine_path=payload['path']
            assert engine_path, messages[-2:]
            return LLMResponse(tool_calls=[ToolCallRequest(id='creation-register',name='sdm_register',arguments={
                'artifact_type':'strategy','name':'Conversation generated strategy','universe':'equity_cn',
                'signal_engine_path':engine_path,'signal_definition':'Constant native target signals; no historical performance claimed.'})],finish_reason='tool_calls')
        return LLMResponse(content='已按本轮明确规则写入策略代码与配置并登记为自定义策略。尚未运行回测，不能据此声称历史有效性；可在同一策略库继续选股或回测。')

class IncompleteCreationResponses(CreationResponses):
    def stream_chat(self,messages,**kwargs):
        self.step+=1
        if self.step==1:
            return LLMResponse(tool_calls=[ToolCallRequest(id='incomplete-config',name='write_file',
                arguments={'path':'config.json','content':json.dumps({**settings,'engine':'daily'})})],finish_reason='tool_calls')
        return LLMResponse(content='本次只写入了策略配置，尚未形成完整策略代码；请保留当前资料供后续完善。')

async def actual_creation():
    service=SessionService(SessionStore(home/'conversation-sessions'),EventBus(),get_runs_dir())
    original_session_count=len(service.list_sessions())
    with patch('src.providers.chat.ChatLLM',CreationResponses):
        try: service.create_session(title='Forbidden built-in modification',config={
            'mona_strategy_creation':True,'mona_native_research':identity})
        except HTTPException as exc: assert exc.status_code==422
        else: raise AssertionError('native create_session accepted built-in modification')
    assert not model_calls and len(service.list_sessions())==original_session_count
    research=service.create_session(title='Read built-in rules',config={'mona_native_research':identity})
    research_calls=[]
    class ResearchResponses(CreationResponses):
        def stream_chat(self,messages,**kwargs):
            user=next(message['content'] for message in reversed(messages) if message['role']=='user')
            assert 'Native research source (read-only runtime context)' in user
            assert identity['strategy_id'] in user and '<strategy_creation_context>' not in user
            research_calls.append(True)
            return LLMResponse(content='这里只解释内置策略现有规则。')
    with patch('src.providers.chat.ChatLLM',ResearchResponses):
        accepted=await service.send_message(research.session_id,'解释原有选股规则。')
        await asyncio.wait_for(service._active_tasks[research.session_id],timeout=70)
    assert research_calls and service.store.get_attempt(research.session_id,accepted['attempt_id']).status.value=='completed'
    research.config['mona_strategy_creation']=True
    service.update_session(research)
    before_messages=len(service.get_messages(research.session_id))
    with patch('src.providers.chat.ChatLLM',CreationResponses):
        try: await service.send_message(research.session_id,'继续此前的内置策略修改。')
        except HTTPException as exc: assert exc.status_code==422
        else: raise AssertionError('old built-in modification session continued to the model')
    assert not model_calls and len(service.get_messages(research.session_id))==before_messages
    assert research.session_id not in service._active_tasks
    session=service.create_session(title='Conversation strategy',config={'mona_strategy_creation':True,
        'mona_native_research':custom_identity})
    before=library.strategy_catalog(source='custom')['total']
    with patch('src.providers.chat.ChatLLM',CreationResponses):
        accepted=await service.send_message(session.session_id,'生成这套明确规则的测试策略，保存以便之后使用；本次不回测。')
        await asyncio.wait_for(service._active_tasks[session.session_id],timeout=70)
    attempt=service.store.get_attempt(session.session_id,accepted['attempt_id'])
    assert attempt.status.value=='completed',attempt.to_dict()
    reply=service.get_messages(session.session_id)[-1]
    artifacts=reply.metadata.get('strategy_artifacts')
    assert len(artifacts)==1,reply.to_dict()
    assert library.strategy_catalog(source='custom')['total']==before+1
    register=next(row for row in reply.tool_trail if row['tool']=='sdm_register')
    assert register['strategy_receipt']['artifact_id']==artifacts[0]['strategy_id'].split(':',1)[1]
    actual_writes=[row for row in reply.tool_trail if row['tool']=='write_file']
    assert len(actual_writes)==2 and all(row.get('call_id') and row['strategy_receipt']['sha256'] for row in actual_writes)
    actual_edits=[row for row in reply.tool_trail if row['tool']=='edit_file']
    assert len(actual_edits)==2 and all(row.get('call_id') and row['strategy_receipt']['sha256'] for row in actual_edits)
    custom=library.strategy_detail(artifacts[0]['strategy_id'])
    assert custom['can_scan'] and not custom['has_evidence']
    assert store.get_artifact(custom['strategy_id'].split(':',1)[1]).derived_from==custom_identity['strategy_id']
    assert library.strategy_detail(custom_identity['strategy_id'])['version']==custom_identity['strategy_version']
    snapshot=get_runs_dir()/custom['linked_run']['run_id']
    assert 'pd.Series(0.5,' in (snapshot/'code/signal_engine.py').read_text(encoding='utf-8')
    assert json.loads((snapshot/'config.json').read_text(encoding='utf-8'))['initial_cash']==125000
    events=service.event_bus.replay(session.session_id,replay_all=True)
    completed=next(event for event in events if event.event_type=='attempt.completed')
    assert completed.data['strategy_artifacts']==artifacts
    incomplete=service.create_session(title='Incomplete strategy',config={'mona_strategy_creation':True})
    registered_count=library.strategy_catalog(source='custom')['total']
    with patch('src.providers.chat.ChatLLM',IncompleteCreationResponses):
        accepted=await service.send_message(incomplete.session_id,'创建并保存策略。')
        await asyncio.wait_for(service._active_tasks[incomplete.session_id],timeout=70)
    incomplete_reply=service.get_messages(incomplete.session_id)[-1]
    assert '策略保存未完成' in incomplete_reply.content,incomplete_reply.to_dict()
    assert not incomplete_reply.metadata.get('strategy_artifacts')
    assert library.strategy_catalog(source='custom')['total']==registered_count
    return artifacts[0]

conversation_strategy=asyncio.run(actual_creation())
conversation_scan=run_operation({'operation':'strategy_scan','strategy_id':conversation_strategy['strategy_id'],
    'strategy_version':conversation_strategy['version'],'settings':settings})
assert len(conversation_scan['tool_result']['signals'])==4
assert all(row['signal']==.5 for row in conversation_scan['tool_result']['signals'])
history_before=library.history(strategy_id=conversation_strategy['strategy_id'])
deleted=run_operation({'operation':'strategy_delete','strategy_id':conversation_strategy['strategy_id'],
    'strategy_version':conversation_strategy['version']})
assert deleted['tool_result']['deleted'] is True
assert library.history(strategy_id=conversation_strategy['strategy_id'])==history_before
assert client.get('/mona/operations/'+conversation_scan['operation_id']).json()['tool_result']==conversation_scan['tool_result']
assert (get_runs_dir()/conversation_scan['references']['run_id']/'artifacts/strategy_scan.json').is_file()
try: library.creation_context({'mona_strategy_creation':True,'mona_native_research':{
    'strategy_id':conversation_strategy['strategy_id'],'strategy_version':conversation_strategy['version']}})
except HTTPException as exc: assert exc.status_code==409
else: raise AssertionError('deleted custom parent accepted')
print(json.dumps({'catalogue_all_sources':True,'factor_separation':True,'native_scan_and_backtest':True,
    'correct_signal_timing':True,'immutable_generation_registration':True,'custom_uses_same_runner':True,
    'concrete_registration_identity':True,'missing_data_not_empty_signals':True,'history_filter':True,
    'session_agent_tools_and_registration':True,'completed_daily_cutoff':True,
    'actual_edit_receipts_registered':True,'incomplete_registration_visible':True,
    'missing_latest_not_zero_signals':True,'builtins_cannot_be_ai_modified':True,
    'ordinary_builtin_research_available':True,'custom_parent_version_and_derivation':True,
    'deleted_strategy_history_preserved':True}))
'''


def test_unified_native_strategy_library(tmp_path: Path) -> None:
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
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="c" * 32,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(python), "-c", _PROBE], cwd=home, env=env,
        capture_output=True, text=True, encoding="utf-8", timeout=240, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
