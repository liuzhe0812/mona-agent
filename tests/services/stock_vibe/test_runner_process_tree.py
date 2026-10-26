from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from mona.runtime.process_tree import OwnedProcess


def test_packaged_process_owner_matches_shared_platform_source():
    root = Path(__file__).resolve().parents[3]
    patch = json.loads((root / "third_party/vibe-trading/patches/0017-hosted-runner-process-tree.json").read_text(encoding="utf-8"))
    shared = (root / "mona/runtime/process_tree.py").read_text(encoding="utf-8").replace("\r\n", "\n")
    assert patch["additions"]["agent/src/core/mona_process_tree.py"] == shared
    assert patch["shared_platform_source"]["sha256"] == hashlib.sha256(shared.encode()).hexdigest()


@pytest.mark.skipif(os.name != "nt", reason="Windows per-backtest Job contract")
def test_real_native_runner_timeout_and_success_leave_no_descendants(tmp_path):
    root = Path(__file__).resolve().parents[3]
    native = Path(os.environ.get("STOCK_VIBE_NATIVE_ROOT", root / ".codex_tmp/vibe-native-final"))
    if (native / "agent").is_dir():
        native /= "agent"
    python = Path(os.environ.get("STOCK_VIBE_TEST_PYTHON", root / ".codex_tmp/vibe-venv-313/Scripts/python.exe"))
    if not (native / "src/core/mona_process_tree.py").is_file() or not python.is_file():
        pytest.skip("requires a controlled source including patch 0017 and the managed Python")
    env = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}
    env.update(PYTHONPATH=str(native.resolve()), VIBE_TRADING_HOME=str(tmp_path / "native"), VIBE_TRADING_HOSTED="1", PYTHONUTF8="1")
    driver = tmp_path / "probe.py"
    driver.write_text('''import json, os, subprocess, sys, time
from pathlib import Path
from src.core.runner import Runner
from src.core.mona_process_tree import _get_windows_api

root = Path(sys.argv[1])
api = _get_windows_api()
def alive(pid):
    handle = api.open_process(0x00100000, False, pid)
    if not handle:
        return False
    try:
        return api.wait_for_single_object(handle, 0) == 0x102
    finally:
        api.close_handle(handle)

checks = {}
for mode in ("timeout", "normal"):
    run = root / mode
    run.mkdir(parents=True)
    child = "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"
    script = run / "entry.py"
    script.write_text("import os,pathlib,subprocess,sys,time\\n"
        + "pathlib.Path('parent.pid').write_text(str(os.getpid()))\\n"
        + "subprocess.Popen([sys.executable,'-c'," + repr(child) + ",'child.pid'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\\n"
        + "while not pathlib.Path('child.pid').is_file(): time.sleep(0.01)\\n"
        + ("time.sleep(60)\\n" if mode == "timeout" else "print('normal-completion')\\n"), encoding="utf-8")
    runner = Runner(timeout=3)
    runner._pick_python_interpreter = lambda: sys.executable
    timed_out = False
    try:
        result = runner.execute(script, run)
        assert mode == "normal" and result.success and "normal-completion" in result.stdout
    except subprocess.TimeoutExpired:
        timed_out = True
    assert timed_out == (mode == "timeout")
    pids = [int((run / name).read_text()) for name in ("parent.pid", "child.pid")]
    assert all(not alive(pid) for pid in pids), pids
    checks[mode] = {"timed_out": timed_out, "pids": pids, "all_stopped": True}
print("OWNED_RUNNER_RESULT=" + json.dumps(checks))
''', encoding="utf-8")
    owner = OwnedProcess([str(python), str(driver), str(tmp_path / "cases")], cwd=tmp_path, env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = owner.process.communicate(timeout=25)
        assert owner.poll() == 0, stderr.decode("utf-8", errors="replace") + stdout.decode("utf-8", errors="replace")
        marker = next(line for line in stdout.decode("utf-8").splitlines() if line.startswith("OWNED_RUNNER_RESULT="))
        evidence = json.loads(marker.split("=", 1)[1])
        assert all(item["all_stopped"] for item in evidence.values())
        (tmp_path / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    finally:
        owner.close()
