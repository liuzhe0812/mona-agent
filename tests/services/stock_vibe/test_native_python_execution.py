"""Native team calculations run without enabling arbitrary hosted shell access."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"
_PROBE = r'''
import json
from pathlib import Path
from src.config.paths import get_swarm_runs_dir
from src.tools import build_registry
from src.tools.mona_python_tool import HostedPythonTool, _AnalysisRunner

registry = build_registry(include_shell_tools=False)
tool = registry.get('bash')
assert isinstance(tool, HostedPythonTool)
assert registry.get('background_run') is None
swarm = get_swarm_runs_dir() / ('a'*32)
upstream = swarm / 'artifacts' / 'backtester'
workspace = swarm / 'artifacts' / 'risk_auditor'
upstream.mkdir(parents=True)
workspace.mkdir(parents=True)
(upstream / 'equity.csv').write_text('equity\n100\n80\n90\n110\n',encoding='utf-8')
outside = swarm / 'private.txt'
outside.write_text('unrelated private fixture',encoding='utf-8')

def run(command):
    return json.loads(tool.execute(command=command,run_dir=str(workspace)))

source = "import json; import pandas as pd; from src.quantlib.risk import max_drawdown_analysis; equity=pd.read_csv('../backtester/equity.csv')['equity']; print(json.dumps(max_drawdown_analysis(equity),default=str))"
result = run('python -c '+json.dumps(source))
assert result['status']=='ok', result
assert 'drawdown' in result['stdout'].lower(),result
assert result['exit_code']==0
assert (Path(result['artifacts']['stdout'])).read_text(encoding='utf-8').strip()
for command in ('echo unsafe','python -c "import subprocess; subprocess.run([\'whoami\'])"',
                'python -c "import socket; socket.socket()"',
                'python -c "__import__(\'os\').system(\'whoami\')"'):
    assert run(command)['status']=='error',command
result = run('python -c '+json.dumps("print(open("+repr(str(outside))+").read())"))
assert result['status']=='error' and 'unrelated private fixture' not in result.get('stdout',''),result
assert outside.read_text(encoding='utf-8')=='unrelated private fixture'
assert all(not any(marker in key.upper() for marker in ('TOKEN','API_KEY','PASSWORD','SECRET','COOKIE','PRIVATE_KEY'))
           for key in _AnalysisRunner()._build_runtime_env(workspace))
print(json.dumps({'native_quantlib_executed':True,'upstream_read_only':True,'shell_and_network_refused':True,
                  'private_files_not_read':True,'owned_runner_outputs_persist':True}))
'''


def test_hosted_native_python_is_owned_and_workspace_bound(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("Managed test interpreter is unavailable")
    source = tmp_path / "source"
    prepare(ROOT / "third_party/vibe-trading", source)
    data = tmp_path / "native"
    profile = tmp_path / "profile"
    profile.mkdir()
    environment = {
        key: value for key, value in os.environ.items()
        if key.upper() in {"PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"}
    }
    environment.update({"VIBE_TRADING_HOME": str(data), "VIBE_TRADING_HOSTED": "1",
                        "HOME": str(profile), "USERPROFILE": str(profile),
                        "PYTHONPATH": str(source / "agent"), "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    result = subprocess.run([str(PYTHON), "-c", _PROBE], cwd=source / "agent", env=environment,
                            capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert result.returncode == 0, result.stdout[-7000:] + result.stderr[-7000:]
