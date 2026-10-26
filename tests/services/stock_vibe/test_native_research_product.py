"""Bundled team delivery uses original workers/tools and persisted evidence."""
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
import asyncio
import copy
import hashlib
import json
import math
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from src.api import mona_native_research as product
from src.api import mona_operations as operations
from src.api.mona_backtest_settings import _template_source
from src.api.mona_opportunity_records import list_selections
from src.api.security import require_auth
from src.config.paths import get_runs_dir, get_runtime_root, get_swarm_runs_dir
from src.providers.chat import LLMResponse, LLMRuntimeSnapshot, ToolCallRequest
from src.session.events import EventBus
from src.session.service import SessionService
from src.session.store import SessionStore
from src.swarm import worker
from src.swarm.models import TaskStatus
from src.swarm.presets import build_run_from_preset, PRESETS_DIR, USER_PRESETS_DIR, load_preset, resolve_preset_path
from src.swarm.store import SwarmStore
from src.swarm.task_store import TaskStore
from src.tools.opportunity_candidates_tool import ScreenOpportunitiesTool
from src.tools.read_file_tool import ReadFileTool
from src.tools.sdm_register_tool import SdmRegisterTool

home = get_runtime_root()
_symbols,_dates,pairs = product._observations({'600000.SH':[{'trade_date':'2025-01-03'}],
    '000001.SZ':[{'trade_date':'2025-01-02'}]})
assert pairs['000001.SZ']==['2025-01-02'], 'another stock date must not prove this stock observation'
catalog = product.native_catalog(limit=2)
assert {item['name'] for item in catalog['teams']}==set(product.NATIVE_TEAM_NAMES)
assert len(catalog['strategies']['items'])==2 and catalog['strategies']['total']>2
assert all('mona_' not in item['name'] for item in catalog['teams'])
for item in catalog['teams']:
    import yaml
    source = (PRESETS_DIR/(item['name']+'.yaml')).read_bytes()
    original = yaml.safe_load(source)
    assert item['source_sha256']==hashlib.sha256(source).hexdigest()
    assert item['variables']==original['variables']
    assert all('default' not in variable for variable in item['variables'])
USER_PRESETS_DIR.mkdir(parents=True)
(USER_PRESETS_DIR/'quant_strategy_desk.yaml').write_text('name: changed\nagents: []\ntasks: []',encoding='utf-8')
assert resolve_preset_path('quant_strategy_desk')==PRESETS_DIR/'quant_strategy_desk.yaml'
assert load_preset('quant_strategy_desk')['name']=='quant_strategy_desk'
identity = catalog['strategies']['items'][0]['strategy_id']
assert product.native_strategy(identity)['strategy_id']==identity
for invalid in ('../private','sdm:..','sdm:missing_artifact','alpha_zoo:not_registered'):
    try: product.native_strategy(invalid)
    except HTTPException as exc: assert exc.status_code==404
    else: raise AssertionError('unknown native strategy accepted')

# Real native local market tool, original write_file and original BacktestTool;
# only the model's responses are scripted, not any tool or the worker loop.
symbols = ['600000.SH','000001.SZ','688001.SH','920001.BJ']
dates = pd.bdate_range('2025-01-02',periods=130)
bridge = home/'data-bridge'
bridge.mkdir()
sources = []
for number,symbol in enumerate(symbols):
    close = [30+number*3+index*.025+math.sin(index*.35+number)*.6 for index in range(len(dates))]
    frame = pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,
        'high':[value*1.01 for value in close], 'low':[value*.99 for value in close],
        'close':[value*1.002 for value in close], 'volume':[100000+index*37 for index in range(len(dates))]})
    path=bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')

run=build_run_from_preset('quant_strategy_desk',{'market':'A-shares','goal':'Read the explicitly supplied local observations.'})
store=SwarmStore(get_swarm_runs_dir())
run_dir=store.create_run(run)
tasks=TaskStore(run_dir)
for task in run.tasks: tasks.save_task(task)
screen=next(task for task in run.tasks if task.id=='task-screen')
backtest=next(task for task in run.tasks if task.id=='task-backtest')
risk=next(task for task in run.tasks if task.id=='task-risk')
start,end=dates[0].date().isoformat(),dates[-1].date().isoformat()
candidate={'symbol':symbols[0],'name':'','as_of':end,'support':['指定区间的该股行情资料已实际读取，可继续研究。'],
    'risks':['尚未核验公司财报与估值。'],'evidence_refs':['observations-screen']}
_,signal=_template_source()
config={'source':'local','codes':symbols,'start_date':start,'end_date':end,'engine':'daily','initial_cash':100000}
captured=[]
mode='screen'

class ScriptedLLM:
    model_name='native-product-regression'
    runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
    def __init__(self,*args,**kwargs): self.calls=0
    def close(self): pass
    def stream_chat(self,messages,**kwargs):
        self.calls+=1
        captured.append((mode,copy.deepcopy(messages)))
        assert 'Product artifact delivery' not in messages[0]['content']
        assert 'Product artifact delivery' in messages[1]['content']
        if mode=='screen':
            if self.calls==1:
                return LLMResponse(tool_calls=[ToolCallRequest(id='observations-screen',name='get_market_data',arguments={
                    'codes':symbols,'start_date':start,'end_date':end,'source':'local','max_rows':5})],finish_reason='tool_calls')
            if self.calls==2:
                result=next(item['content'] for item in reversed(messages) if item['role']=='tool')
                assert symbols[0] in result and end in result
                return LLMResponse(tool_calls=[ToolCallRequest(id='candidates-screen',name='write_file',arguments={
                    'path':'candidates.json','content':json.dumps({'candidates':[candidate]},ensure_ascii=False)})],finish_reason='tool_calls')
            return LLMResponse(content='已读取指定股票与日期区间的行情，并保存候选及资料来源。当前仅确认行情覆盖，未核验财报与估值，后续研究须保留这些缺项。')
        if mode=='backtest':
            if self.calls==1:
                return LLMResponse(tool_calls=[ToolCallRequest(id='config-backtest',name='write_file',arguments={
                    'path':'config.json','content':json.dumps(config)}),ToolCallRequest(id='code-backtest',name='write_file',arguments={
                    'path':'code/signal_engine.py','content':signal.decode()})],finish_reason='tool_calls')
            if self.calls==2:
                return LLMResponse(tool_calls=[ToolCallRequest(id='execute-backtest',name='backtest',arguments={})],finish_reason='tool_calls')
            result=json.loads(next(item['content'] for item in reversed(messages) if item['role']=='tool'))
            assert result['status']=='ok',result
            return LLMResponse(content='已按原生策略代码和明确的本地行情区间执行回测，交易、净值和指标均以原始产物为准。该区间结果不能作为未来效果保证，尚需独立风险复核。')
        if mode=='risk':
            if self.calls==1:
                path=worker.agent_artifact_dir(run_dir,backtest.agent_id,backtest.id)/'artifacts/metrics.csv'
                return LLMResponse(tool_calls=[ToolCallRequest(id='read-original-metrics',name='read_file',arguments={'path':str(path)})],finish_reason='tool_calls')
            result=json.loads(next(item['content'] for item in reversed(messages) if item['role']=='tool'))
            assert 'error' not in result,result
            assert 'max_drawdown' in json.dumps(result),result
            return LLMResponse(content='已直接读取同一次回测的原始指标文件。尚未执行额外统计检验，不宣称已完成稳健性验证；此结论保留原始指标作为可复查依据。')

def execute(task):
    agent=next(item for item in run.agents if item.id==task.agent_id)
    with patch.object(worker,'ChatLLM',ScriptedLLM):
        result=worker.run_worker(agent,task,{},run.user_vars,run_dir)
    assert result.status=='completed',result
    task=task.model_copy(update={'status':TaskStatus.completed,'summary':result.summary,
        'artifacts':result.artifact_paths,'worker_iterations':result.iterations})
    tasks.save_task(task)
    run.tasks=[task if item.id==task.id else item for item in run.tasks]
    store.update_run(run)
    return task

screen=execute(screen)
result=product.native_research(run.id)
assert len(result['candidates'])==1,result
selected=result['candidates'][0]
assert selected['symbol']==symbols[0] and selected['as_of']==end and selected['task_id']==screen.id
assert selected['evidence_refs'][0]['call_id']=='observations-screen'
receipt_id=selected['evidence_refs'][0]['receipt_id']
receipt=next(item for item in product._receipts(run.id) if item['receipt_id']==receipt_id)
assert symbols[0] in receipt['result'] and end in receipt['observation_dates']
assert not product._receipt_root(run.id).resolve().is_relative_to((run_dir/'artifacts').resolve())
assert result['final_report'] is None and result['status']==run.status.value

# Structured prose or fake IDs alone never become candidate facts.
candidate_path=worker.agent_artifact_dir(run_dir,screen.agent_id,screen.id)/'candidates.json'
original_candidate=candidate_path.read_bytes()
bad={**candidate,'symbol':'600999.SH'}
candidate_path.write_text(json.dumps({'candidates':[bad]}),encoding='utf-8')
assert not product.native_research(run.id)['candidates']
bad={**candidate,'evidence_refs':['unexecuted-call']}
candidate_path.write_text(json.dumps({'candidates':[bad]}),encoding='utf-8')
assert not product.native_research(run.id)['candidates']
candidate_path.write_bytes(original_candidate)
assert product.resolve_native_research_context({'swarm_id':run.id,'task_id':screen.id,'symbol':'600000'})['candidate']['symbol']==symbols[0]
for bad_context in ({'swarm_id':run.id,'strategy_id':identity},{'swarm_id':run.id,'task_id':'not-in-run'},
                    {'swarm_id':run.id,'symbol':'600999'},{'swarm_id':'../outside'}):
    try: product.resolve_native_research_context(bad_context)
    except (ValueError,HTTPException): pass
    else: raise AssertionError('unbound native source accepted')

mode='backtest'
backtest=execute(backtest)
result=product.native_research(run.id)
assert len(result['linked_runs'])==1,result
linked=result['linked_runs'][0]
out=get_runs_dir()/linked['run_id']
source=worker.agent_artifact_dir(run_dir,backtest.agent_id,backtest.id)
assert linked['task_id']==backtest.id and linked['call_id']=='execute-backtest'
for relative in ('config.json','code/signal_engine.py','artifacts/metrics.csv','artifacts/equity.csv','artifacts/trades.csv'):
    assert (out/relative).read_bytes()==(source/relative).read_bytes(),relative
assert result['historical_signals'] and all(item['kind']=='backtest_target' for item in result['historical_signals'])
assert all(item['as_of']==end for item in result['historical_signals'])
assert len(pd.read_csv(out/'artifacts/trades.csv'))>0
# Original strategy registration points to its actual source code; a product
# report link must follow the recorded source snapshot, never a guessed id.
registration=json.loads(SdmRegisterTool().execute(artifact_type='strategy',name='Native product source',
    universe='A-shares',signal_definition='Bundled native example',entry_rules='Original signal',
    exit_rules='Original signal',position_sizing='Original weights',
    signal_engine_path=str(source/'code/signal_engine.py')))
assert registration['status']=='ok',registration
strategy_id='sdm:'+registration['artifact']['id']
evidence=product.native_strategy(strategy_id)
assert evidence['linked_run']['run_id']==linked['run_id'],evidence
assert evidence['found'] is False, 'registration alone must not manufacture performance evidence'
assert product.resolve_native_research_context({'strategy_id':strategy_id})['native_read_tools']
mode='risk'
risk=execute(risk)
for label in ('screen','backtest','risk'):
    system=[messages[0]['content'] for current,messages in captured if current==label]
    assert all(value==system[0] for value in system)

own=worker.agent_artifact_dir(run_dir,risk.agent_id,risk.id)
outside=home/'outside.json'
outside.write_text('private',encoding='utf-8')
args=product.shared_read_arguments('read_file',{'path':str(outside),'run_dir':str(own)},run_dir)
assert args['run_dir']==str(own)
assert json.loads(ReadFileTool().execute(**args))['status']=='error'
args=product.shared_read_arguments('write_file',{'path':str(source/'config.json'),'run_dir':str(own)},run_dir)
assert args['run_dir']==str(own)

# Old selection artifacts remain in the real original operation store.
ops=operations._OperationStore()
old={'plan_id':'multifactor','mode':'swing','universe':'watchlist','symbols':[symbols[0]],'conditions':''}
ops.create('a'*32,'opportunity_screen',{'operation':'opportunity_screen',**old},{},{})
ops.update('a'*32,status='completed',raw_result=json.dumps({'kind':'opportunity_screen','candidates':[],'as_of':end}))
before=ops.get('a'*32)
assert list_selections()['total']>=1
assert 'opportunity_screen' not in operations._OPERATION_NAMES
try: operations._validate_payload({'operation':'opportunity_screen',**old})
except HTTPException as exc: assert exc.status_code==422
else: raise AssertionError('custom quantitative operation still dispatches')
assert json.loads(ScreenOpportunitiesTool('session','attempt',old).execute(plan_id='multifactor'))['error_code']=='custom_quant_screen_retired'
assert ops.get('a'*32)==before

app=FastAPI()
app.dependency_overrides[require_auth]=lambda:None
product.register_native_research(app)
with TestClient(app) as client:
    assert client.get('/mona/native-research/catalog?limit=2').status_code==200
    assert client.get('/mona/native-research/'+run.id).json()['linked_runs'][0]['run_id']==linked['run_id']
    response=client.get('/mona/native-research/'+run.id+'/evidence/'+receipt_id)
    assert response.status_code==200 and response.json()['call_id']=='observations-screen'
    assert client.get('/mona/native-research/'+run.id+'/evidence/'+'0'*64).status_code==404
assert product.format_native_research_context(product.resolve_native_research_context({'strategy_id':identity})).startswith('## Native research source')

# Follow a recorded candidate or registered strategy through the real Session,
# AgentLoop and ToolLifecycle. Only model responses are fixed; native source
# resolution, file reads, evidence lookup and adaptation guards really execute.
session_prompts=[]
session_kind='swarm'
swarm_origin={'swarm_id':run.id,'task_id':screen.id,'symbol':'600000'}
strategy_origin={'strategy_id':strategy_id}
session_store=SessionStore(home/'sessions')
source_service=SessionService(session_store,EventBus(),get_runs_dir())
question='解释这只股票在那次研究中的入选依据'

class SourceResponses:
    model_name='native-source-session-regression'
    runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
    def __init__(self,*args,**kwargs):
        self.calls=0
        self.system=None
    def close(self):pass
    def stream_chat(self,messages,**kwargs):
        self.calls+=1
        current=copy.deepcopy(messages)
        session_prompts.append((session_kind,current))
        system=messages[0]['content']
        if self.system is None:self.system=system
        assert self.system==system
        assert '## Native research source' not in system and run.id not in system and strategy_id not in system
        runtime=next(item['content'] for item in reversed(messages)
            if item['role']=='user' and '## Native research source' in item.get('content',''))
        context=json.JSONDecoder().raw_decode(runtime[runtime.index('{"source":'):])[0]
        if session_kind=='swarm':
            assert context['source']=='swarm' and context['swarm_id']==run.id
            assert context['task_id']==screen.id and context['symbol']==symbols[0]
            assert context['candidate']['evidence_refs'][0]['call_id']=='observations-screen'
            if self.calls==1:
                command=next(item for item in context['native_read_tools']
                    if item['tool']=='read_file' and Path(item['arguments']['path']).name=='candidates.json')
                return LLMResponse(tool_calls=[ToolCallRequest(id='source-read-candidates',name='read_file',
                    arguments=command['arguments'])],finish_reason='tool_calls')
            result=json.loads(next(item['content'] for item in reversed(messages) if item['role']=='tool'))
            assert result['status']=='ok',result
            actual=next(item for item in json.loads(result['content'])['candidates'] if item['symbol']==symbols[0])
            assert actual['as_of']==end and actual['support']==candidate['support']
            return LLMResponse(content='依据已读取的原始候选文件：'+actual['support'][0]+'；原记录也说明：'+actual['risks'][0])
        assert context['source']=='strategy' and context['strategy_id']==strategy_id
        assert context['evidence']['found'] is False
        if self.calls==1:
            return LLMResponse(tool_calls=[ToolCallRequest(id='source-strategy-evidence',name='get_strategy_evidence',
                arguments={'strategy_id':strategy_id})],finish_reason='tool_calls')
        result=json.loads(next(item['content'] for item in reversed(messages) if item['role']=='tool'))
        if self.calls==2:
            assert result['status']=='ok' and result['found'] is False and not result['rows'],result
            return LLMResponse(tool_calls=[ToolCallRequest(id='source-adaptation-skill',name='load_skill',
                arguments={'name':'strategy-generate','section':'Adapting a registered strategy'})],finish_reason='tool_calls')
        if self.calls==3:
            assert 'adapt_strategy' in result['content'] and 'stale' in result['content'],result
            return LLMResponse(tool_calls=[ToolCallRequest(id='source-native-adapt',name='adapt_strategy',arguments={
                'strategy_id':strategy_id,'name':'Source evidence controlled child','universe':'Explicit local A-share sample',
                'config':config})],finish_reason='tool_calls')
        assert result['status']=='error' and any(word in result.get('error','').lower() for word in ('evidence','adequate')),result
        return LLMResponse(content='原生证据查询确认这个策略还没有验证记录；原生复用约束因此拒绝创建子策略。本次保留来源及原报告，不把登记当作有效性证明，也没有绕过原生规则生成替代策略。')

async def complete_source_turn(service,session_id,content):
    with patch('src.providers.chat.ChatLLM',SourceResponses):
        submitted=await service.send_message(session_id,content)
        active=service._active_tasks[session_id]
        await asyncio.wait_for(active,timeout=40)
    attempt=service.store.get_attempt(session_id,submitted['attempt_id'])
    assert attempt.status.value=='completed',attempt.to_dict()
    assert not service._inflight and not service._active_loops
    return attempt

before_sessions={item.session_id for item in source_service.list_sessions(100)}
for invalid in ({'swarm_id':'missing-swarm'},{'swarm_id':run.id,'task_id':'unknown-task'},
                {'strategy_id':'sdm:missing_artifact'},{'swarm_id':run.id,'strategy_id':strategy_id}):
    try:source_service.create_session(config={'mona_native_research':invalid})
    except (HTTPException,ValueError):pass
    else:raise AssertionError('invalid source silently created a blank research session')
assert {item.session_id for item in source_service.list_sessions(100)}==before_sessions

source_session=source_service.create_session(title='Candidate source follow-up',config={'mona_native_research':swarm_origin})
first_attempt=asyncio.run(complete_source_turn(source_service,source_session.session_id,question))
assert '## Native research source' in first_attempt.prompt and run.id in first_attempt.prompt
transcript=source_service.get_messages(source_session.session_id)
assert transcript[0].content==question and transcript[0].metadata['native_research']==swarm_origin
assert '## Native research source' not in transcript[0].content
assert candidate['support'][0] in transcript[-1].content
assert any(row['tool']=='read_file' and row['status']=='ok' for row in transcript[-1].tool_trail)

# A new service/store restores the disk-backed source and emits the source
# context again on a follow-up; it does not fall back to a blank new session.
restored=SessionService(SessionStore(home/'sessions'),EventBus(),get_runs_dir())
assert restored.get_session(source_session.session_id).config['mona_native_research']==swarm_origin
assert restored.get_messages(source_session.session_id)[0].metadata['native_research']==swarm_origin
second_attempt=asyncio.run(complete_source_turn(restored,source_session.session_id,'继续核对同一次研究的资料范围'))
assert second_attempt.parent_attempt_id==first_attempt.attempt_id
assert second_attempt.session_id==source_session.session_id
assert restored.get_messages(source_session.session_id)[2].metadata['native_research']==swarm_origin
assert len(restored.get_messages(source_session.session_id))==4

invalid_session=restored.create_session(config={'mona_native_research':swarm_origin})
invalid_session.config['mona_native_research']={'swarm_id':run.id,'task_id':'source-removed'}
restored.update_session(invalid_session)
before_attempts=len(restored.store.list_attempts())
before_model_calls=len(session_prompts)
async def reject_stale_source():
    try:await restored.send_message(invalid_session.session_id,'不能丢掉原来源继续执行')
    except (HTTPException,ValueError):pass
    else:raise AssertionError('stale source silently started a blank new research')
asyncio.run(reject_stale_source())
assert not restored.get_messages(invalid_session.session_id)
assert len(restored.store.list_attempts())==before_attempts and len(session_prompts)==before_model_calls

session_kind='strategy'
registered=restored.create_session(title='Native strategy source',config={'mona_native_research':strategy_origin})
strategies_before=product.native_catalog(limit=100,source='sdm')['strategies']['total']
adaptations_before={path.name for path in get_runs_dir().glob('adaptation-*')}
strategy_attempt=asyncio.run(complete_source_turn(restored,registered.session_id,'查看原策略证据并沿原生约束尝试复用'))
strategy_messages=restored.get_messages(registered.session_id)
assert strategy_messages[0].metadata['native_research']==strategy_origin
trail=strategy_messages[-1].tool_trail
assert any(row['tool']=='get_strategy_evidence' and row['status']=='ok' for row in trail)
assert any(row['tool']=='load_skill' and row['status']=='ok' for row in trail)
assert any(row['tool']=='adapt_strategy' and row['status']=='error' for row in trail)
assert product.native_catalog(limit=100,source='sdm')['strategies']['total']==strategies_before
assert {path.name for path in get_runs_dir().glob('adaptation-*')}==adaptations_before
reopened=SessionService(SessionStore(home/'sessions'),EventBus(),get_runs_dir())
assert reopened.get_session(registered.session_id).config['mona_native_research']==strategy_origin
assert reopened.get_messages(registered.session_id)[0].metadata['native_research']==strategy_origin
print(json.dumps({'bundled_catalog':True,'real_worker_tools':True,'candidate_evidence_bound':True,
    'original_backtest_artifacts_linked':True,'upstream_read_only':True,'source_context':True,
    'no_custom_quant_dispatch':True,'archive_retained':True,'real_source_session':True,
    'source_persisted_and_restored':True,'invalid_source_does_not_create_or_execute':True,
    'native_adaptation_guard_preserved':True}))
'''


def test_native_research_catalog_workers_and_verified_product_artifacts(tmp_path: Path) -> None:
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
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="d" * 32,
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=110, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
