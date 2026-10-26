"""Native API imports stay light while public exports and real tools still work."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]

_PROBE = r'''
import asyncio
import hashlib
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

loop=asyncio.new_event_loop()
asyncio.set_event_loop(loop)
network=[]
def deny(*args,**kwargs):
    network.append(True)
    raise RuntimeError('network forbidden during native startup regression')
socket.create_connection=deny
socket.getaddrinfo=deny
socket.socket.connect=deny
socket.socket.connect_ex=deny
candidate=sys.argv[1]=='candidate'
if candidate:
    import src.agent.frontmatter
    import src.providers.custom_profiles
    import src.swarm.models
    assert 'src.agent.loop' not in sys.modules
    assert 'src.providers.llm' not in sys.modules
    assert 'src.swarm.runtime' not in sys.modules
    assert 'src.swarm.worker' not in sys.modules

import api_server as api
if candidate:
    assert 'langchain_openai' not in sys.modules
    assert 'fastmcp.client' not in sys.modules
    assert 'src.agent.loop' not in sys.modules
    assert 'src.swarm.worker' not in sys.modules

schema=api.app.openapi()
Path('openapi-schema.json').write_text(json.dumps(schema,sort_keys=True,indent=2,ensure_ascii=False),encoding='utf-8')
contract=hashlib.sha256(json.dumps(schema,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
route_count=len(api.app.routes)
context=api._lifespan(api.app)
loop.run_until_complete(context.__aenter__())
attention=next(route.endpoint for route in api.app.routes
    if getattr(route,'path',None)=='/mona/attention' and 'PUT' in (getattr(route,'methods',None) or set()))
payload={'preferences':{'proactive_mode':'manual','watched_symbols':[],'notification_start':'09:30',
    'notification_end':'15:00','attention_interval_sec':300,'data_sources':['tencent','eastmoney']},'execution_allowed':False}
assert loop.run_until_complete(attention(payload))['execution_allowed'] is False

if candidate:
    import src.agent as agent
    import src.providers as providers
    import src.swarm as swarm
    exports={agent:['AgentLoop','WorkspaceMemory','SkillsLoader','BaseTool','ToolRegistry'],
        providers:['build_llm'],swarm:['RunStatus','SwarmAgentSpec','SwarmEvent','SwarmRun','SwarmRuntime',
        'SwarmStore','SwarmTask','TaskStatus','WorkerResult','build_run_from_preset','inspect_preset','list_presets','load_preset','run_worker']}
    for package,names in exports.items():
        assert package.__all__==names
        assert set(names)<=set(dir(package))
        try: getattr(package,'unknown_native_export')
        except AttributeError: pass
        else: raise AssertionError('unknown package attribute accepted')
    from src.agent.loop import AgentLoop
    from src.providers.llm import build_llm
    from src.swarm.runtime import SwarmRuntime
    from src.swarm.worker import run_worker
    assert agent.AgentLoop is AgentLoop and agent.AgentLoop is agent.__dict__['AgentLoop']
    assert providers.build_llm is build_llm
    assert swarm.SwarmRuntime is SwarmRuntime and swarm.run_worker is run_worker
    for package,names in exports.items():
        namespace={}
        exec('from '+package.__name__+' import *',namespace)
        assert all(namespace[name] is getattr(package,name) for name in names)

    from src.providers.chat import LLMResponse,LLMRuntimeSnapshot,ToolCallRequest
    calls=[]
    class Responses:
        model_name='native-startup-tools-regression'
        runtime_snapshot=LLMRuntimeSnapshot(provider='fixture',configured_model=model_name,reasoning_effort='')
        def __init__(self,*args,**kwargs): self.step=0
        def close(self): pass
        def stream_chat(self,messages,**kwargs):
            self.step+=1
            calls.append(self.step)
            if self.step==1:
                return LLMResponse(tool_calls=[ToolCallRequest(id='read-native-skill',name='load_skill',
                    arguments={'name':'strategy-generate'})],finish_reason='tool_calls')
            return LLMResponse(content='已读取现有策略说明，尚未创建策略或运行回测。')

    async def ordinary_session():
        service=api._get_session_service()
        session=service.create_session(title='Native startup tool compatibility')
        with patch('src.providers.chat.ChatLLM',Responses):
            accepted=await service.send_message(session.session_id,'读取策略说明即可。')
            await asyncio.wait_for(service._active_tasks[session.session_id],timeout=50)
        attempt=service.store.get_attempt(session.session_id,accepted['attempt_id'])
        assert attempt.status.value=='completed',attempt.to_dict()
        reply=service.get_messages(session.session_id)[-1]
        assert any(row['tool']=='load_skill' and row['status']=='ok' for row in reply.tool_trail),reply.to_dict()
        assert calls==[1,2]
    loop.run_until_complete(ordinary_session())

loop.run_until_complete(context.__aexit__(None,None,None))
loop.close()
assert network==[]
print(json.dumps({'openapi_sha256':contract,'route_count':route_count,'network_calls':len(network),
    'public_exports_and_discovery':True,'ordinary_session_native_tool':True}))
'''


def test_native_lazy_exports_preserve_routes_and_real_session_tools(tmp_path: Path) -> None:
    python = Path(os.environ.get("MONA_VIBE_TEST_PYTHON", str(ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe")))
    if not python.is_file():
        pytest.skip("explicit native Vibe Python required")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    reference = tmp_path / "reference"
    shutil.copytree(source, reference)
    patch = json.loads((ROOT / "third_party/vibe-trading/patches/0061-native-startup-loading.json").read_text(encoding="utf-8"))
    for item in patch["files"]:
        target = reference / item["path"]
        original = target.read_text(encoding="utf-8")
        for replacement in reversed(item["replacements"]):
            assert original.count(replacement["after"]) == replacement["count"]
            original = original.replace(replacement["after"], replacement["before"])
        content = original.encode("utf-8")
        assert hashlib.sha256(content).hexdigest() == item["sha256"]
        target.write_bytes(content)
    reports = []
    for mode, agent in (("reference", reference / "agent"), ("candidate", source / "agent")):
        home = tmp_path / (mode + "-home")
        home.mkdir()
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"}}
        env.update(PYTHONPATH=str(agent), VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
            ENABLE_SESSION_RUNTIME="true", VIBE_TRADING_ENABLE_SCHEDULER="false", VIBE_TRADING_CHANNELS_AUTO_START="false",
            PYTHONUTF8="1", PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PYTHON_DOTENV_DISABLED="1",
            HOME=str(home), USERPROFILE=str(home), APPDATA=str(home), LOCALAPPDATA=str(home),
            API_AUTH_KEY="native-startup-local-synthetic-key", MONA_VIBE_INSTANCE_ID="0" * 32)
        result = subprocess.run([str(python), "-c", _PROBE, mode], cwd=home, env=env,
            capture_output=True, encoding="utf-8", timeout=95, check=False)
        assert result.returncode == 0, result.stdout + result.stderr
        reports.append(json.loads(result.stdout.splitlines()[-1]))
    assert reports[0]["openapi_sha256"] == reports[1]["openapi_sha256"]
    assert reports[0]["route_count"] == reports[1]["route_count"]
    assert reports[1]["network_calls"] == 0
