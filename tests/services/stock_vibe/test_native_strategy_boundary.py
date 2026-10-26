from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = REPO_ROOT / "third_party" / "vibe-trading"
PATCH_PATH = SNAPSHOT_ROOT / "patches" / "0014-hosted-strategy-boundary.json"

_NATIVE_PROBE = r'''import ast
import json
import os
import shutil
from pathlib import Path

from backtest.runner import _load_module_from_file, _scan_runtime_reachable, _validate_signal_engine_source
from src.core.runner import Runner, _copy_runtime_env

agent = Path(os.environ["STOCK_VIBE_NATIVE_ROOT"]).resolve()
fixture = Path(os.environ["STOCK_VIBE_FIXTURE_ROOT"]).resolve()
private = Path(os.environ["STOCK_VIBE_PRIVATE_ROOT"]).resolve()
home = private / "home"
runtime = private / "runtime"
scratch = private / "scratch"
for directory in (home, runtime, scratch, runtime / "data-bridge"):
    directory.mkdir(parents=True, exist_ok=True)
os.environ.update({
    "HOME": str(home),
    "USERPROFILE": str(home),
    "TEMP": str(scratch),
    "TMP": str(scratch),
    "VIBE_TRADING_HOME": str(runtime),
    "VIBE_TRADING_HOSTED": "1",
})

# These are inert test sentinels, never real credentials.
secret_names = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "API_AUTH_KEY",
    "MONA_SERVICES_TOKEN",
    "MONA_MODEL_ROUTE_TOKEN",
    "APCA_API_KEY_ID",
    "APCA_API_SECRET_KEY",
    "FUTU_PASSWORD",
    "IBKR_PASSWORD",
)
for name in secret_names:
    os.environ[name] = "test-only-" + name.lower()
assert not set(secret_names) & set(_copy_runtime_env())

env_run = private / "env-run"
env_run.mkdir()
env_entry = env_run / "probe.py"
env_entry.write_text(
    "import json, os\n"
    f"print(json.dumps({{name: name in os.environ for name in {secret_names!r}}}))\n",
    encoding="utf-8",
)
env_result = Runner(timeout=30).execute(env_entry, env_run, cwd=agent)
assert env_result.success, (env_result.exit_code, env_result.stderr[-2000:])
observed = json.loads(env_result.stdout.strip().splitlines()[-1])
assert not any(observed.values()), observed

marker = private / "top-level-effect.txt"
side_effect = private / "side_effect.py"
side_effect.write_text(
    "from pathlib import Path\n"
    f"Path({str(marker)!r}).write_text('executed')\n"
    "class SignalEngine:\n"
    "    def generate(self, data_map):\n"
    "        return {}\n",
    encoding="utf-8",
)
try:
    _load_module_from_file(side_effect, "blocked_module_level_effect")
except ValueError:
    pass
else:
    raise AssertionError("module-level side effect was accepted")
assert not marker.exists(), "strategy code ran before validation"

bad_sources = {
    "read_text": (
        "from pathlib import Path\n",
        "Path('C:/private.txt').read_text()",
    ),
    "read_bytes": (
        "from pathlib import Path as P\n",
        "P('C:/private.txt').read_bytes()",
    ),
    "path_open": (
        "import pathlib as paths\n",
        "paths.Path('C:/private.txt').open('r')",
    ),
    "method_alias": (
        "from pathlib import Path as P\n",
        "reader = P.read_text\n        reader(P('C:/private.txt'))",
    ),
    "dynamic_getattr": (
        "from pathlib import Path\n",
        "getattr(Path('C:/private.txt'), 'read_' + 'text')()",
    ),
    "dynamic_getattr_alias": (
        "from pathlib import Path\n",
        "lookup = getattr\n        lookup(Path('C:/private.txt'), 'read_text')()",
    ),
    "annotated_getattr_alias": (
        "",
        "lookup: object = getattr\n        lookup(object(), 'read_text')",
    ),
    "open_alias": (
        "from io import open as file_open\n",
        "file_open('C:/private.txt').read()",
    ),
}
for name, (imports, operation) in bad_sources.items():
    source = (
        imports
        + "class SignalEngine:\n"
        + "    def generate(self, data_map):\n"
        + "        " + operation.replace("\n        ", "\n        ") + "\n"
        + "        return {}\n"
    )
    source_path = private / f"{name}.py"
    source_path.write_text(source, encoding="utf-8")
    try:
        _validate_signal_engine_source(source_path)
    except ValueError:
        continue
    raise AssertionError(f"hosted strategy file-read path was accepted: {name}")

# The new file-read rule is hosted-only; preserve the existing standalone path.
os.environ.pop("VIBE_TRADING_HOSTED", None)
standalone = private / "standalone_read.py"
standalone.write_text(
    "from pathlib import Path\n"
    "class SignalEngine:\n"
    "    def generate(self, data_map):\n"
    "        return Path('relative.txt').read_text()\n",
    encoding="utf-8",
)
_validate_signal_engine_source(standalone)
os.environ["VIBE_TRADING_HOSTED"] = "1"

# Keep a shipped SignalEngine's harmless dynamic field lookup valid.
harmonic = agent / "src" / "skills" / "harmonic" / "example_signal_engine.py"
harmonic_tree = ast.parse(harmonic.read_text(encoding="utf-8"))
harmonic_engine = next(
    node for node in harmonic_tree.body
    if isinstance(node, ast.ClassDef) and node.name == "SignalEngine"
)
_scan_runtime_reachable(ast.Module(body=[harmonic_engine], type_ignores=[]))

# Exercise the real native backtest subprocess with the local six-bar fixture.
run_dir = private / "sixbar-run"
(run_dir / "code").mkdir(parents=True)
(run_dir / "data").mkdir()
shutil.copy2(fixture / "config.json", run_dir / "config.json")
shutil.copy2(fixture / "signal_engine.py", run_dir / "code" / "signal_engine.py")
bars = run_dir / "data" / "bars.csv"
shutil.copy2(fixture / "bars.csv", bars)
(runtime / "data-bridge" / "config.yaml").write_text(
    "sources:\n"
    "  - symbol: 600000.SH\n"
    "    type: csv\n"
    f"    path: {json.dumps(bars.as_posix())}\n",
    encoding="utf-8",
)
backtest = Runner(timeout=60).execute(
    agent / "backtest" / "runner.py",
    run_dir,
    cwd=agent,
    cli_args=[str(run_dir)],
)
assert backtest.success, (backtest.exit_code, backtest.stderr[-4000:])
metrics = run_dir / "artifacts" / "metrics.csv"
assert metrics.is_file() and len(metrics.read_text(encoding="utf-8").splitlines()) >= 2
print(json.dumps({
    "status": "ok",
    "env_probe": "model/native/Mona/broker sentinels absent from Runner child",
    "top_level_effect": "rejected before module execution",
    "file_read_paths_rejected": sorted(bad_sources),
    "standalone_read": "unchanged",
    "harmonic_dynamic_field_lookup": "allowed",
    "local_six_bar_backtest": "passed",
}, ensure_ascii=False))
'''


def test_hosted_strategy_boundary_in_real_windows_children(tmp_path: Path) -> None:
    if os.name != "nt":
        pytest.skip("native Runner process-boundary check is Windows-specific")
    configured_python = os.environ.get("STOCK_VIBE_TEST_PYTHON")
    if not configured_python:
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared Python 3.13 interpreter")

    python = Path(configured_python).resolve()
    if not python.is_file():
        raise AssertionError(f"prepared Python interpreter does not exist: {python}")
    agent = tmp_path / "prepared-native" / "agent"
    receipt = prepare(SNAPSHOT_ROOT, tmp_path / "prepared-native")
    patch_record = next(
        item for item in receipt["patches"]
        if item["path"] == PATCH_PATH.name
    )
    assert patch_record["sha256"] == hashlib.sha256(PATCH_PATH.read_bytes()).hexdigest()

    private = tmp_path / "private-runtime"
    for name in ("home", "runtime", "scratch", "appdata", "localappdata"):
        (private / name).mkdir(parents=True, exist_ok=True)
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    path_entries = [str(python.parent)]
    if (system_root / "System32").is_dir():
        path_entries.extend([str(system_root / "System32"), str(system_root)])
    if os.environ.get("PATH"):
        path_entries.append(os.environ["PATH"])
    env = {
        "PATH": os.pathsep.join(path_entries),
        "HOME": str(private / "home"),
        "USERPROFILE": str(private / "home"),
        "APPDATA": str(private / "appdata"),
        "LOCALAPPDATA": str(private / "localappdata"),
        "TEMP": str(private / "scratch"),
        "TMP": str(private / "scratch"),
        "PYTHONPATH": str(agent),
        "PYTHONUTF8": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "VIBE_TRADING_HOME": str(private / "runtime"),
        "VIBE_TRADING_HOSTED": "1",
        "STOCK_VIBE_NATIVE_ROOT": str(agent),
        "STOCK_VIBE_FIXTURE_ROOT": str(REPO_ROOT / "tests" / "fixtures" / "stock_vibe" / "backtest"),
        "STOCK_VIBE_PRIVATE_ROOT": str(private),
    }
    if system_root.is_dir():
        env["SystemRoot"] = str(system_root)
        env["WINDIR"] = str(system_root)

    result = subprocess.run(
        [str(python), "-c", _NATIVE_PROBE],
        cwd=agent,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        timeout=150,
    )
    assert result.returncode == 0, (
        f"native boundary probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-4000:]}\nstderr:\n{result.stderr[-4000:]}"
    )
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert report["status"] == "ok", report
