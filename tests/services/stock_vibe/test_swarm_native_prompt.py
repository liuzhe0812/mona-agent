"""Deterministic native Swarm worker prompt construction checks."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
NATIVE_SOURCE = Path(
    os.environ.get(
        "STOCK_VIBE_NATIVE_SOURCE_ROOT",
        REPO_ROOT / ".codex_tmp" / "t05-swarm-source-final-v4" / "agent",
    )
).resolve()
NATIVE_PYTHON = Path(
    os.environ.get(
        "STOCK_VIBE_NATIVE_PYTHON",
        REPO_ROOT
        / ".codex_tmp"
        / "stock-vibe-runtime-verify-preflight"
        / "python"
        / "stock-vibe-envs"
        / "6fdf4452ae7d59b2ea6e41d352410619"
        / "Scripts"
        / "python.exe",
    )
).resolve()


def test_native_worker_prompt_injects_upstream_summary_and_absolute_evidence_path(
    tmp_path: Path,
) -> None:
    if not (NATIVE_SOURCE / "mona-source.json").is_file() or not NATIVE_PYTHON.is_file():
        pytest.skip("requires a prepared native source tree and its Python runtime")

    source_summary = (
        "EVIDENCE_PATH=C:\\Mona\\swarm\\runs\\fixture\\artifacts\\"
        "tencent_research\\task_tencent_data\\evidence.md"
    )
    code = "\n".join(
        (
            "import json",
            "from src.swarm.presets import build_run_from_preset",
            "from src.swarm.worker import build_worker_prompt",
            "run=build_run_from_preset('mona_ashare_research',{'symbol':'600519.SH','start_date':'2026-09-16','end_date':'2026-10-15'})",
            "agent=next(agent for agent in run.agents if agent.id=='evidence_reviewer')",
            f"summary={json.dumps(source_summary)}",
            "prompt=build_worker_prompt(agent,{'upstream_evidence':summary},'')",
            "print(json.dumps({'summary_present':summary in prompt,'upstream_section':'## Upstream Context (from previous agents)' in prompt,'unresolved_marker':'{upstream_context}' in prompt}))",
        )
    )
    env_keys = {
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
    }
    env = {key: value for key, value in os.environ.items() if key in env_keys}
    env.update(
        {
            "PYTHONPATH": str(NATIVE_SOURCE),
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "VIBE_TRADING_HOME": str(tmp_path / "native-home"),
        }
    )
    result = subprocess.run(
        [str(NATIVE_PYTHON), "-c", code],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload == {
        "summary_present": True,
        "upstream_section": True,
        "unresolved_marker": False,
    }
