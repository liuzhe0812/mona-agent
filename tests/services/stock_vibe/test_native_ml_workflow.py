"""Execute the bundled ML team's feature/train/OOS/backtest DAG unchanged."""
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
import ast
import csv
import hashlib
import io
import json
import math
import time
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from src.api import mona_native_research as product
from src.config.accessor import get_env_config
from src.config.paths import get_runs_dir,get_runtime_root,get_swarm_runs_dir
from src.providers.chat import LLMResponse,LLMRuntimeSnapshot,ToolCallRequest
from src.swarm import worker
from src.swarm.runtime import SwarmRuntime
from src.swarm.store import SwarmStore

agent=Path(product.__file__).resolve().parents[2]
skill=(agent/'src/skills/ml-strategy/SKILL.md').read_text(encoding='utf-8')
native_code=skill.split('## Complete SignalEngine Example',1)[1].split('```python\n',1)[1].split('```',1)[0]
native_sha=hashlib.sha256(native_code.encode()).hexdigest()
assert native_sha=='6d99e3e0e135fcfd22ee62ca8d7ad30d8ec4ad7b3c499e0d91b88bdfa37d0b55'
symbols=['600000.SH','000001.SZ']
dates=pd.bdate_range('2022-01-03',periods=800)
start,end=dates[0].date().isoformat(),dates[-1].date().isoformat()
evaluation=dates[252].date().isoformat()
home=get_runtime_root()
bridge=home/'data-bridge'
bridge.mkdir(parents=True)
sources=[]
for number,symbol in enumerate(symbols):
    close=[30+number*5+index*.004+math.sin(index*.31+number)*1.1+math.cos(index*.09+number)*.5
           for index in range(len(dates))]
    frame=pd.DataFrame({'date':dates.strftime('%Y-%m-%d'),'open':close,
        'high':[value*1.01 for value in close],'low':[value*.99 for value in close],
        'close':[value*1.002 for value in close],
        'volume':[100000+index*29+int(math.sin(index*.07)*10000) for index in range(len(dates))]})
    path=bridge/(symbol+'.csv')
    frame.to_csv(path,index=False)
    sources.append({'symbol':symbol,'type':'csv','path':str(path),'date_format':'%Y-%m-%d'})
(bridge/'config.yaml').write_text(json.dumps({'sources':sources}),encoding='utf-8')
assert get_env_config().api.vibe_trading_enable_shell_tools is False
calls=[]

COMMON='''
import json
from pathlib import Path
payload=json.loads(Path(__SNAPSHOT__).read_text(encoding="utf-8"))
frames={}
for symbol,rows in payload.items():
    if symbol.startswith("_") or not isinstance(rows,list):
        continue
    frame=pd.DataFrame(rows)
    frame.index=pd.to_datetime(frame.pop("trade_date"))
    frames[symbol]=frame
'''
FEATURE='''
summary={}
for symbol,frame in frames.items():
    features=build_features(frame)
    features.to_csv("features_"+symbol+".csv")
    summary[symbol]={"rows":len(frame),"feature_columns":list(features.columns),
        "valid_feature_rows":int(features.notna().all(axis=1).sum())}
print(json.dumps(summary))
'''
TRAIN='''
from sklearn.metrics import accuracy_score
summary={}
for symbol,frame in frames.items():
    features=build_features(frame)
    horizon=5
    forward=frame["close"].shift(-horizon)/frame["close"]-1
    labels=(forward>0).astype(float).where(forward.notna())
    predictions=walk_forward_predict(features,labels)
    predictions.to_csv("oos_predictions_"+symbol+".csv")
    mask=forward.notna() & (features.index>=features.index[252])
    summary[symbol]={"model_type":"random_forest","n_estimators":100,"max_depth":5,"random_state":42,
        "min_train_size":252,"retrain_freq":20,"prediction_horizon":5,
        "first_evaluation_date":str(features.index[252].date()),
        "oos_observations":int(mask.sum()),"nonzero_predictions":int(predictions.loc[mask].ne(0).sum()),
        "oos_accuracy":float(accuracy_score(labels.loc[mask],predictions.loc[mask].gt(0).astype(float)))}
print(json.dumps(summary,allow_nan=False))
'''

def last(messages):
    raw=next(item['content'] for item in reversed(messages) if item['role']=='tool')
    value=json.loads(raw)
    assert value.get('status')!='error' and not value.get('error'),value
    return value

def upstream(messages,task_id,name):
    prompt=messages[1]['content']
    marker='{"upstream_artifacts":'
    context=json.loads(prompt[prompt.index(marker):])
    files=next(item['artifacts'] for item in context['upstream_artifacts'] if item['task_id']==task_id)
    selected=[path for path in files if Path(path).name==name]
    assert len(selected)==1,(task_id,name,selected)
    return selected[0]

class NativeMLResponses:
    model_name='native-ml-team-regression'
    runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
    def __init__(self,*args,**kwargs):
        self.step=0
        self.role=None
        self.system=None
        self.saved={}
    def close(self):pass
    def tool(self,name,args,identity):
        return LLMResponse(tool_calls=[ToolCallRequest(id=identity,name=name,arguments=args)],finish_reason='tool_calls')
    def write(self,path,content,identity):
        return self.tool('write_file',{'path':path,'content':content},identity)
    def stream_chat(self,messages,**kwargs):
        self.step+=1
        system=messages[0]['content']
        if self.system is None:self.system=system
        assert system==self.system
        if self.role is None:
            self.role=next(role for phrase,role in {
                'senior quant feature engineer':'features','senior quant data scientist':'model',
                'senior quant backtest engineer':'backtest'}.items() if phrase in system)
        role=self.role
        calls.append((role,self.step))
        if role in ('features','model'):
            if self.step==1:
                assert 'get_market_data' in {item['function']['name'] for item in kwargs['tools']}
                return self.tool('get_market_data',{'codes':symbols,'start_date':start,'end_date':end,
                    'source':'local','interval':'1D','max_rows':0},role+'-market')
            if self.step==2:
                result=last(messages)
                snapshot=result.get('data_snapshot') or result.get('_mona_data_snapshot')
                assert snapshot and snapshot['path'],result
                assert result['requested_codes']==symbols and result['requested_source']=='local'
                code=native_code+'\n'+COMMON.replace('__SNAPSHOT__',repr(snapshot['path']))+(FEATURE if role=='features' else TRAIN)
                assert code.startswith(native_code)
                return self.write(role+'.py',code,role+'-program')
            if self.step==3:
                return self.tool('bash',{'command':'python '+role+'.py'},role+'-native-python')
            if self.step==4:
                result=last(messages)
                actual=json.loads(result['stdout'])
                self.saved['result']=actual
                if role=='features':
                    assert all(len(row['feature_columns'])==10 and row['valid_feature_rows']>700 for row in actual.values()),actual
                    return self.write('feature_summary.json',json.dumps(actual),'features-save')
                assert all(row['oos_observations']>=504 and row['nonzero_predictions']>0 for row in actual.values()),actual
                return self.write('ml_evaluation.json',json.dumps(actual),'model-save')
            if role=='features':
                return LLMResponse(content='已由原生ml-strategy完整示例的build_features生成十项特征，并保留各股票逐日特征CSV及有效行数。源数据来自本任务真实调用的本地行情快照，未改动示例特征公式。')
            return LLMResponse(content='已使用原生walk_forward_predict执行RandomForest与StandardScaler历史滚动训练，保持252根起训、20根重训、100棵树及原生标签剔除规则，并以随后超过两年的预测记录计算方向准确率。实际输出保存在ml_evaluation.json；合成数据不证明市场效果。')
        if self.step==1:
            return self.tool('read_file',{'path':upstream(messages,'task-features','feature_summary.json')},'backtest-read-features')
        if self.step==2:
            self.saved['features']=json.loads(last(messages)['content'])
            return self.tool('read_file',{'path':upstream(messages,'task-model','ml_evaluation.json')},'backtest-read-model')
        if self.step==3:
            self.saved['evaluation']=json.loads(last(messages)['content'])
            config={'source':'local','codes':symbols,'start_date':start,'end_date':end,'interval':'1D',
                'initial_cash':100000,'engine':'daily','warmup_bars':252}
            return LLMResponse(tool_calls=[
                ToolCallRequest(id='ml-config',name='write_file',arguments={'path':'config.json','content':json.dumps(config)}),
                ToolCallRequest(id='ml-code',name='write_file',arguments={'path':'code/signal_engine.py','content':native_code})],finish_reason='tool_calls')
        if self.step==4:
            return self.tool('backtest',{},'ml-backtest-execute')
        if self.step==5:
            result=last(messages)
            assert result['status']=='ok' and result['exit_code']==0,result
            return self.tool('read_file',{'path':str(Path(result['run_dir'])/'artifacts/metrics.csv')},'ml-read-metrics')
        if self.step==6:
            metrics=next(csv.DictReader(io.StringIO(last(messages)['content'])))
            assert int(float(metrics['trade_count']))>0,metrics
            report=('# 原生机器学习团队执行报告\n\n原生示例代码及参数保持不变；特征、滚动训练与历史预测实际运行。\n\n'
                +'方向评价原始结果：'+json.dumps(self.saved['evaluation'],ensure_ascii=False)+'\n\n'
                +'评价预热252根后，原生回测总收益：'+metrics['total_return']+'；实际交易数量：'+metrics['trade_count']+'。\n\n'
                +'本次固定模型响应、使用本地合成行情，验证原生执行链路与产物，不代表真实模型自主研究或金融有效性。')
            self.saved['report']=report
            return self.write('report.md',report,'ml-final-report')
        return LLMResponse(content=self.saved['report'])

store=SwarmStore(get_swarm_runs_dir())
runtime=SwarmRuntime(store=store,max_workers=3)
goal='验收原生机器学习执行链路；股票600000、000001；来源local；日期'+start+'至'+end+'；初始资金100000；保持原生完整示例算法与默认参数。'
with patch.object(worker,'ChatLLM',NativeMLResponses):
    launched=runtime.start_run('ml_quant_lab',{'market':'A-shares','target_variable':'direction','goal':goal},include_shell_tools=False)
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        run=store.load_run(launched.id)
        if run.status.value in {'completed','failed','cancelled'}:break
        time.sleep(.1)
    if run.status.value!='completed':runtime.cancel_run(run.id)
    assert run.status.value=='completed',run.model_dump()
assert len(run.tasks)==len(run.agents)==3 and all(task.status.value=='completed' for task in run.tasks)
task_map={task.id:task for task in run.tasks}
assert {task.id for task in run.tasks}=={'task-features','task-model','task-backtest'}
parallel=[task_map['task-features'],task_map['task-model']]
assert max(task.started_at for task in parallel)<min(task.completed_at for task in parallel)
assert task_map['task-backtest'].started_at>=max(task.completed_at for task in parallel)
root=store.run_dir(run.id)
feature_dir=worker.agent_artifact_dir(root,'feature_engineer','task-features')
model_dir=worker.agent_artifact_dir(root,'data_scientist','task-model')
backtest_dir=worker.agent_artifact_dir(root,'backtest_engineer','task-backtest')
for directory,filename in ((feature_dir,'features.py'),(model_dir,'model.py')):
    assert (directory/filename).read_text(encoding='utf-8').startswith(native_code)
    prefix=ast.parse((directory/filename).read_text(encoding='utf-8')).body[:len(ast.parse(native_code).body)]
    assert ast.dump(ast.Module(body=prefix,type_ignores=[]))==ast.dump(ast.parse(native_code))
assert (backtest_dir/'code/signal_engine.py').read_text(encoding='utf-8')==native_code
evaluation_result=json.loads((model_dir/'ml_evaluation.json').read_text())
for symbol,row in evaluation_result.items():
    assert row['first_evaluation_date']==evaluation and row['oos_observations']>=504
    assert row['min_train_size']==252 and row['retrain_freq']==20 and row['n_estimators']==100
    assert row['model_type']=='random_forest' and 0<=row['oos_accuracy']<=1
    predictions=pd.read_csv(model_dir/('oos_predictions_'+symbol+'.csv'),index_col=0)
    assert len(predictions)==800 and predictions.iloc[:252,0].eq(0).all()
    assert predictions.iloc[252:,0].ne(0).sum()>0
projection=product.native_research(run.id)
assert projection['status']=='completed' and len(projection['linked_runs'])==1
linked=projection['linked_runs'][0]
out=get_runs_dir()/linked['run_id']
assert (out/'code/signal_engine.py').read_text(encoding='utf-8')==native_code
metrics=next(csv.DictReader((out/'artifacts/metrics.csv').open(encoding='utf-8-sig',newline='')))
assert int(float(metrics['trade_count']))>0
equity=pd.read_csv(out/'artifacts/equity.csv')
assert len(equity)>=504 and equity.iloc[0]['timestamp'][:10]==evaluation
assert metrics['total_return'] in run.final_report
assert all(str(row['oos_accuracy']) in run.final_report for row in evaluation_result.values())
receipts=product._receipts(run.id)
assert all(row['status']=='ok' for row in receipts)
assert sum(row['tool']=='get_market_data' for row in receipts)==2
for receipt in receipts:
    if receipt['tool']=='get_market_data':
        assert receipt['arguments']['codes']==symbols and receipt['arguments']['source']=='local'
        assert receipt['data_snapshot_matches'] is True
count=len(calls)
assert product.native_research(run.id)['linked_runs']==projection['linked_runs'] and len(calls)==count
evidence={'swarm_id':run.id,'linked_run_id':linked['run_id'],'native_example_sha256':native_sha,
    'native_source_unchanged':True,'real_sklearn_training_oos':True,'real_native_backtest':True,
    'original_three_role_dag':True,'oos_trading_bars':len(equity),'trade_count':int(float(metrics['trade_count'])),
    'model_evaluation_path':str(model_dir/'ml_evaluation.json'),'run_artifacts':str(out/'artifacts')}
print(json.dumps(evidence,ensure_ascii=False))
"""


def test_native_ml_team(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    home = tmp_path / "home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    }}
    environment.update(PYTHONPATH=str(source / "agent"), PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1", VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1", MONA_VIBE_INSTANCE_ID="e" * 32, VIBE_TRADING_DATA_CACHE="false",
        HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home))
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=home, env=environment,
        capture_output=True, text=True, encoding="utf-8", timeout=210, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    evidence = json.loads(result.stdout.splitlines()[-1])
    assert evidence["native_source_unchanged"] and evidence["real_sklearn_training_oos"]
    assert evidence["real_native_backtest"] and evidence["original_three_role_dag"]
    (tmp_path / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
