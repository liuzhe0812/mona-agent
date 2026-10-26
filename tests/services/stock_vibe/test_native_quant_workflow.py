"""Run the entire original quant desk DAG; script only its model responses."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

_PROBE = r"""
import csv
import hashlib
import io
import json
import math
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from src.api import mona_native_research as product
from src.api.mona_backtest_settings import _template_source
from src.config.accessor import get_env_config
from src.config.paths import get_runs_dir, get_runtime_root, get_swarm_runs_dir
from src.providers.chat import LLMResponse, LLMRuntimeSnapshot, ToolCallRequest
from src.swarm import worker
from src.swarm.runtime import SwarmRuntime
from src.swarm.store import SwarmStore
from src.tools.factor_analysis_tool import FactorAnalysisTool

symbols=['600000.SH','000001.SZ','688001.SH','920001.BJ','600519.SH','300750.SZ']
dates=pd.bdate_range('2025-01-02',periods=180)
start,end=dates[0].date().isoformat(),dates[-1].date().isoformat()
home=get_runtime_root()
bridge=home/'data-bridge'
bridge.mkdir(parents=True)
sources=[]
for number,symbol in enumerate(symbols):
    close=[30+number*4+index*.025+math.sin(index*.37+number)*.7+math.cos(index*.13+number)*.3
           for index in range(len(dates))]
    frame=pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,
        'high':[value*1.01 for value in close],'low':[value*.99 for value in close],
        'close':[value*1.002 for value in close],
        'volume':[100000+index*37+number*1000 for index in range(len(dates))]})
    path=bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
_,signal=_template_source()
assert get_env_config().api.vibe_trading_enable_shell_tools is False
events=[]
calls=[]
lock=threading.Lock()

def last_result(messages):
    item=next(item for item in reversed(messages) if item['role']=='tool')
    result=json.loads(item['content'])
    assert not result.get('error') and result.get('status')!='error',result
    return result

def read_content(messages):
    return last_result(messages)['content']

def snapshot_path(result):
    value=result.get('data_snapshot') or result.get('_mona_data_snapshot')
    assert isinstance(value,dict) and value['path'] and value['sha256'],result
    return value['path']

def upstream_files(messages):
    prompt=messages[1]['content']
    marker='{"upstream_artifacts":'
    assert marker in prompt
    data=json.loads(prompt[prompt.index(marker):])
    result={}
    for item in data['upstream_artifacts']:
        result[item['task_id']]=item['artifacts']
    return result

def artifact(upstream,task_id,name):
    matches=[path for path in upstream[task_id] if Path(path).name==name]
    assert len(matches)==1,(task_id,name,matches)
    return matches[0]

SCREEN_PY='''
import json
from pathlib import Path
payload=json.loads(Path(__SNAPSHOT__).read_text(encoding="utf-8"))
rows=[]
for symbol,observations in payload.items():
    if symbol.startswith("_") or not isinstance(observations,list) or not observations:
        continue
    latest=observations[-1]
    rows.append({"symbol":symbol,"name":"","as_of":latest["trade_date"][:10],
        "support":["已取得区间末日收盘价 "+str(latest["close"])+"，本次读取 "+str(len(observations))+" 根真实工具返回行情。"],
        "risks":["本次用于执行链路检验，尚未覆盖公司财报与估值。"],
        "evidence_refs":["screen-market"]})
print(json.dumps({"candidates":rows},ensure_ascii=False))
'''
FACTOR_PY='''
import json
from pathlib import Path
import pandas as pd
from src.factors.registry import get_default_registry
payload=json.loads(Path(__SNAPSHOT__).read_text(encoding="utf-8"))
frames={}
for symbol,rows in payload.items():
    if symbol.startswith("_") or not isinstance(rows,list):
        continue
    frame=pd.DataFrame(rows)
    frame.index=pd.to_datetime(frame.pop("trade_date"))
    frames[symbol]=frame
close=pd.DataFrame({symbol:frame["close"] for symbol,frame in frames.items()})
factor=get_default_registry().compute("qlib158_roc5",{"close":close})
returns=close.shift(-1)/close-1
factor.to_csv("factor.csv")
returns.to_csv("forward_returns.csv")
print(json.dumps({"factor_id":"qlib158_roc5","rows":len(close),
    "factor_csv":str(Path("factor.csv").resolve()),
    "return_csv":str(Path("forward_returns.csv").resolve())}))
'''
RISK_PY='''
import json
from pathlib import Path
import pandas as pd
from src.quantlib.risk import max_drawdown_analysis,historical_var,historical_cvar
equity=pd.read_csv(__EQUITY__,index_col=0,parse_dates=True)["equity"]
returns=equity.pct_change().dropna()
result={"drawdown":max_drawdown_analysis(equity),
    "historical_var_95":historical_var(returns,confidence=0.95),
    "historical_cvar_95":historical_cvar(returns,confidence=0.95),
    "n_returns":len(returns),"source":"original backtest equity.csv"}
print(json.dumps(result,default=str,allow_nan=False))
'''

class ScriptedDeskLLM:
    model_name='original-quant-desk-workflow-regression'
    runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
    def __init__(self,*args,**kwargs):
        self.step=0
        self.role=None
        self.first_system=None
        self.saved={}
    def close(self): pass
    def tool(self,name,args,identity):
        return LLMResponse(tool_calls=[ToolCallRequest(id=identity,name=name,arguments=args)],finish_reason='tool_calls')
    def write(self,path,content,identity):
        return self.tool('write_file',{'path':path,'content':content},identity)
    def stream_chat(self,messages,**kwargs):
        self.step+=1
        system=messages[0]['content']
        if self.first_system is None: self.first_system=system
        assert self.first_system==system,'runtime metadata must not mutate the system prompt'
        if self.role is None:
            mapping={'quant stock-screening specialist':'screen','quant factor researcher':'factor',
                'strategy backtest specialist':'backtest','quant risk auditor':'risk',
                'quantitative research editor':'report'}
            self.role=next(role for phrase,role in mapping.items() if phrase in system)
        role=self.role
        with lock: calls.append((role,self.step))
        if role in ('screen','factor'):
            if self.step==1:
                names={item['function']['name'] for item in kwargs['tools']}
                assert 'get_market_data' in names,names
                assert 'bash' in names
                return self.tool('get_market_data',{'codes':symbols,'start_date':start,'end_date':end,
                    'source':'local','interval':'1D','max_rows':0},role+'-market')
            if self.step==2:
                response=last_result(messages)
                assert response['requested_codes']==symbols and response['requested_source']=='local',response
                path=snapshot_path(response)
                code=(SCREEN_PY if role=='screen' else FACTOR_PY).replace('__SNAPSHOT__',repr(path))
                return self.write(role+'.py',code,role+'-program')
            if self.step==3:
                return self.tool('bash',{'command':'python '+role+'.py'},role+'-python')
            if self.step==4:
                calculation=last_result(messages)
                computed=json.loads(calculation['stdout'])
                self.saved['computed']=computed
                if role=='screen':
                    assert len(computed['candidates'])==len(symbols)
                    return self.write('candidates.json',json.dumps(computed,ensure_ascii=False),'screen-candidates')
                assert computed['rows']==len(dates) and computed['factor_id']=='qlib158_roc5'
                return self.tool('factor_analysis',{'factor_csv':computed['factor_csv'],
                    'return_csv':computed['return_csv'],'output_dir':'analysis'},'factor-native-analysis')
            if role=='screen':
                return LLMResponse(content='已依据本轮原生行情工具实际返回的资料保存六只股票及来源。当前样本条件仅核对行情覆盖，不宣称已完成财报筛查或产生投资效果。')
            if self.step==5:
                result=last_result(messages)
                assert result['status']=='ok' and result['ic_count']>5,result
                self.saved['factor']=result
                return self.write('factor_report.json',json.dumps(result,ensure_ascii=False),'factor-report')
            value=self.saved['factor']
            return LLMResponse(content='已调用原生 qlib158_roc5 计算因子，并以原生factor_analysis评测其后续一根行情收益，IC均值为 '+str(value['ic_mean'])+'，IR为 '+str(value['ir'])+'。IC及分组曲线保存在本任务原始产物，未将其当作策略收益。')
        upstream=upstream_files(messages)
        if role=='backtest':
            if self.step==1:
                return self.tool('read_file',{'path':artifact(upstream,'task-screen','candidates.json')},'backtest-read-candidates')
            if self.step==2:
                self.saved['candidates']=json.loads(read_content(messages))['candidates']
                return self.tool('read_file',{'path':artifact(upstream,'task-factor','ic_summary.json')},'backtest-read-factors')
            if self.step==3:
                self.saved['factor']=json.loads(read_content(messages))
                config={'source':'local','codes':[row['symbol'] for row in self.saved['candidates']],
                    'start_date':start,'end_date':end,'interval':'1D','initial_cash':100000,'engine':'daily'}
                return LLMResponse(tool_calls=[
                    ToolCallRequest(id='backtest-config',name='write_file',arguments={'path':'config.json','content':json.dumps(config)}),
                    ToolCallRequest(id='backtest-code',name='write_file',arguments={'path':'code/signal_engine.py','content':signal.decode()})],finish_reason='tool_calls')
            if self.step==4:
                return self.tool('backtest',{},'backtest-execute')
            result=last_result(messages)
            assert result['status']=='ok' and result['exit_code']==0,result
            return LLMResponse(content='已读取上游候选和原生因子评测，并在指定六股、日期及资金条件下执行原生完整多因子示例。实际交易、净值和指标已生成；该示例含四个既定因子，本轮ROC5研究不代表示例全部方法，也不构成金融有效性证明。')
        if role=='risk':
            if self.step==1:
                return self.tool('read_file',{'path':artifact(upstream,'task-backtest','metrics.csv')},'risk-read-metrics')
            if self.step==2:
                metrics=next(csv.DictReader(io.StringIO(read_content(messages))))
                assert metrics['total_return']
                code=RISK_PY.replace('__EQUITY__',repr(artifact(upstream,'task-backtest','equity.csv')))
                return self.write('risk.py',code,'risk-program')
            if self.step==3:
                return self.tool('bash',{'command':'python risk.py'},'risk-native-quantlib')
            if self.step==4:
                result=last_result(messages)
                risk=json.loads(result['stdout'])
                assert risk['n_returns']>10 and risk['drawdown']['max_drawdown']>=0,risk
                self.saved['risk']=risk
                return self.write('risk_analysis.json',json.dumps(risk,ensure_ascii=False),'risk-save-analysis')
            risk=self.saved['risk']
            return LLMResponse(content='已读取本次回测原始指标和净值，并调用原生quantlib计算最大回撤、95%历史VaR与CVaR。最大回撤为 '+str(risk['drawdown']['max_drawdown'])+'。本次没有独立样本外检验，不宣称策略稳健性已经得到证明。')
        if self.step==1:
            return self.tool('read_file',{'path':artifact(upstream,'task-screen','candidates.json')},'report-read-candidates')
        if self.step==2:
            self.saved['candidates']=json.loads(read_content(messages))['candidates']
            return self.tool('read_file',{'path':artifact(upstream,'task-factor','ic_summary.json')},'report-read-factor')
        if self.step==3:
            self.saved['factor']=json.loads(read_content(messages))
            return self.tool('read_file',{'path':artifact(upstream,'task-backtest','metrics.csv')},'report-read-metrics')
        if self.step==4:
            self.saved['metrics']=next(csv.DictReader(io.StringIO(read_content(messages))))
            return self.tool('read_file',{'path':artifact(upstream,'task-risk','risk_analysis.json')},'report-read-risk')
        if self.step==5:
            risk=json.loads(read_content(messages))
            value=self.saved
            report=('# 原生量化团队执行报告\n\n'
                +'候选股票数量：'+str(len(value['candidates']))+'。来源为本次原生行情调用及已保存快照。\n\n'
                +'因子：qlib158_roc5；原生因子评测 IC均值：'+str(value['factor']['ic_mean'])+'；IR：'+str(value['factor']['ir'])+'。\n\n'
                +'原生示例策略总收益：'+value['metrics']['total_return']+'；实际交易数量：'+value['metrics']['trade_count']+'。\n\n'
                +'原生风险复核最大回撤：'+str(risk['drawdown']['max_drawdown'])+'；95%历史VaR：'+str(risk['historical_var_95'])+'。\n\n'
                +'报告数字逐项来自本轮原生文件。模型响应为执行链路测试脚本，行情为本地合成数据，不代表真实市场验证、原生示例收益有效或今天推荐。')
            self.saved['final_report']=report
            return self.write('report.md',report,'report-save-final')
        return LLMResponse(content=self.saved['final_report'])

store=SwarmStore(get_swarm_runs_dir())
runtime=SwarmRuntime(store=store,max_workers=4)
goal='仅验收原生团队执行链路；使用六位股票代码 '+','.join(symbol.split('.')[0] for symbol in symbols)+\
    '；行情来源local；日期'+start+'至'+end+'；初始资金100000；明确区分原生示例回测与方法有效性。'
with patch.object(worker,'ChatLLM',ScriptedDeskLLM):
    launched=runtime.start_run('quant_strategy_desk',{'market':'A-shares','goal':goal},
        live_callback=lambda event:events.append(event),include_shell_tools=False)
    deadline=time.monotonic()+145
    while time.monotonic()<deadline:
        saved=store.load_run(launched.id)
        if saved.status.value in {'completed','failed','cancelled'}:
            break
        time.sleep(.1)
    if saved.status.value!='completed':
        runtime.cancel_run(launched.id)
    assert saved.status.value=='completed',saved.model_dump()

assert len(saved.agents)==len(saved.tasks)==5
assert {task.id for task in saved.tasks}=={'task-screen','task-factor','task-backtest','task-risk','task-report'}
assert all(task.status.value=='completed' for task in saved.tasks)
assert saved.final_report and '原生量化团队执行报告' in saved.final_report
assert {role for role,step in calls}=={'screen','factor','backtest','risk','report'}
task_map={task.id:task for task in saved.tasks}
for task in saved.tasks:
    for dependency in task.depends_on:
        assert task.started_at>=task_map[dependency].completed_at,(task.id,dependency)
parallel=[task_map[identity] for identity in ('task-screen','task-factor')]
assert max(task.started_at for task in parallel)<min(task.completed_at for task in parallel)

projection=product.native_research(saved.id)
assert projection['status']=='completed' and len(projection['tasks'])==5
assert len(projection['candidates'])==6 and len(projection['linked_runs'])==1,projection
receipts=product._receipts(saved.id)
for task_id in ('task-screen','task-factor'):
    market=next(row for row in receipts if row['task_id']==task_id and row['tool']=='get_market_data')
    assert market['arguments']['codes']==symbols and market['arguments']['source']=='local'
    assert market['arguments']['start_date']==start and market['arguments']['end_date']==end
    assert market['data_snapshot_matches'] is True
    snapshot=json.loads(Path(market['data_snapshot']['path']).read_text(encoding='utf-8'))
    assert snapshot==market['result']
    for symbol in symbols:
        assert len(snapshot[symbol])==len(dates)
        assert snapshot[symbol][0]['trade_date'][:10]==start and snapshot[symbol][-1]['trade_date'][:10]==end
assert any(row['tool']=='factor_analysis' and row['result']['status']=='ok' for row in receipts)
factor_dir=worker.agent_artifact_dir(store.run_dir(saved.id),'factor_miner','task-factor')
assert (factor_dir/'analysis/ic_series.csv').stat().st_size>0
assert (factor_dir/'analysis/group_equity.csv').stat().st_size>0
factor=json.loads((factor_dir/'analysis/ic_summary.json').read_text())
linked=projection['linked_runs'][0]
out=get_runs_dir()/linked['run_id']
metrics=next(csv.DictReader((out/'artifacts/metrics.csv').open(encoding='utf-8-sig',newline='')))
assert int(float(metrics['trade_count']))>0
assert len(pd.read_csv(out/'artifacts/equity.csv'))>10
assert len(pd.read_csv(out/'artifacts/trades.csv'))>0
risk_path=worker.agent_artifact_dir(store.run_dir(saved.id),'risk_auditor','task-risk')/'risk_analysis.json'
risk=json.loads(risk_path.read_text())
assert metrics['total_return'] in saved.final_report
assert str(factor['ic_mean']) in saved.final_report
assert str(risk['drawdown']['max_drawdown']) in saved.final_report
assert any(row['tool']=='bash' and row['task_id']=='task-risk' and row['result']['status']=='ok' for row in receipts)
assert all(row['status']=='ok' for row in receipts),receipts

# A snapshot is a model-readable copy, not authority to rewrite its actual tool receipt.
market=next(row for row in receipts if row['task_id']=='task-screen' and row['tool']=='get_market_data')
snapshot_path=Path(market['data_snapshot']['path'])
original=snapshot_path.read_bytes()
trusted=product._receipt_root(saved.id)/(market['receipt_id']+'.json')
trusted_before=trusted.read_bytes()
snapshot_path.write_bytes(original+b'\n')
changed=product.native_research(saved.id)
assert not changed['candidates'] and trusted.read_bytes()==trusted_before
assert any('快照' in warning for warning in changed['warnings'])
snapshot_path.write_bytes(original)
assert len(product.native_research(saved.id)['candidates'])==6

# Reads and recovery never redispatch the graph or its financial computations.
before_calls=list(calls)
before_events=(store.run_dir(saved.id)/'events.jsonl').read_bytes()
before_receipts={path.name:path.read_bytes() for path in product._receipt_root(saved.id).glob('*.json')}
for _ in range(3):
    assert product.native_research(saved.id)['linked_runs']==projection['linked_runs']
    assert store.load_run(saved.id).final_report==saved.final_report
assert calls==before_calls
assert (store.run_dir(saved.id)/'events.jsonl').read_bytes()==before_events
assert {path.name:path.read_bytes() for path in product._receipt_root(saved.id).glob('*.json')}==before_receipts

outside=home/'outside.csv'
outside.write_text('date,x\n2025-01-01,1\n',encoding='utf-8')
rejected=json.loads(FactorAnalysisTool().execute(factor_csv=str(outside),return_csv=str(outside),
    output_dir=str(home/'outside-output'),run_dir=str(factor_dir)))
assert rejected['status']=='error' and not (home/'outside-output').exists()
print(json.dumps({'full_native_dag':True,'parallel_and_dependencies':True,'actual_data_snapshots':True,
    'actual_native_factor_analysis':True,'actual_native_backtest':True,'actual_quantlib_risk':True,
    'report_uses_original_values':True,'candidate_sources_verified':True,'snapshot_not_authority':True,
    'reads_do_not_redispatch':True,'shell_flag_stays_off':True}))
"""


def test_original_quant_desk_complete_workflow_and_persisted_product_result(tmp_path: Path) -> None:
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
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="f" * 32, VIBE_TRADING_DATA_CACHE="false",
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=175, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
