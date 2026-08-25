"""Tool-level acceptance for a real, reproducible algorithm comparison loop."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from mona.agent.tools.academic import ResearchRecordTool
from mona.agent.tools.shell import ExecTool


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _metric_record(
    *,
    command: str,
    data_hash: str,
) -> dict[str, object]:
    return {
        "status": "succeeded",
        "exit_code": 0,
        "metric_name": "accuracy",
        "metric_direction": "maximize",
        "metric_unit": "fraction",
        "evaluation_command": "python run.py --mode <mode> > metrics.json",
        "data_hash": data_hash,
        "metrics_source": {
            "kind": "json",
            "path": "workspace/metrics.json",
            "key": "accuracy",
        },
        "command": command,
    }


@pytest.mark.asyncio
async def test_real_exec_and_record_tools_accept_and_reject_algorithm_candidates(tmp_path: Path):
    fixture = tmp_path / "algorithm-fixture"
    fixture.mkdir()
    run_py = fixture / "run.py"
    run_py.write_text(
        "import argparse, json\n"
        "values = {'baseline': 0.75, 'candidate': 0.875, 'no_improvement': 0.75}\n"
        "parser = argparse.ArgumentParser()\n"
        "parser.add_argument('--mode', required=True)\n"
        "args = parser.parse_args()\n"
        "print(json.dumps({'accuracy': values[args.mode]}))\n",
        encoding="utf-8",
    )
    # This is an experiment artifact, not a metric. It proves the isolated
    # candidate carries a patch record without writing a result directly.
    (fixture / "change.patch").write_text(
        "--- a/run.py\n+++ b/run.py\n@@ candidate @@\n",
        encoding="utf-8",
    )
    original_hash = _sha256(run_py)

    records = ResearchRecordTool(workspace=tmp_path)
    executor = ExecTool(
        timeout=30,
        working_dir=str(tmp_path),
        restrict_to_workspace=True,
    )
    init = json.loads(
        await records.execute(
            action="init",
            task_id="algorithm-acceptance",
            goal="Compare a real baseline and algorithm candidates",
        )
    )
    assert init["ok"] is True

    async def run_case(run_id: str, mode: str):
        command = f"python run.py --mode {mode} > metrics.json"
        started = json.loads(
            await records.execute(
                action="experiment_start",
                task_id="algorithm-acceptance",
                record={
                    "run_id": run_id,
                    "status": "planned",
                    "command": command,
                    "data_hash": "fixture-data-v1",
                    "artifact_paths": ["workspace/change.patch"],
                    "source_dir": str(fixture),
                    "max_files": 4,
                    "max_bytes": 20_000,
                },
            )
        )
        assert started["ok"] is True, started
        run_record = started["record"]
        isolated = Path(run_record["isolated_dir"])
        assert run_record["source_dir"] == str(fixture.resolve())
        assert run_record["metadata"]["max_files"] == 4
        assert run_record["metadata"]["max_bytes"] == 20_000
        assert isolated.is_dir()
        assert (isolated / "run.py").is_file()
        assert (isolated / "change.patch").is_file()

        execution = await executor.execute(
            command=command,
            working_dir=str(isolated),
        )
        assert "Exit code: 0" in execution, execution
        assert (isolated / "metrics.json").read_text(encoding="utf-8").strip()

        finished = json.loads(
            await records.execute(
                action="experiment_finish",
                task_id="algorithm-acceptance",
                run_id=run_id,
                record=_metric_record(
                    command=command,
                    data_hash=run_record["data_hash"],
                ),
            )
        )
        assert finished["ok"] is True, finished
        return run_record, finished["record"], isolated

    baseline, baseline_done, baseline_dir = await run_case("baseline", "baseline")
    candidate, candidate_done, candidate_dir = await run_case("candidate", "candidate")
    no_improvement, no_improvement_done, no_improvement_dir = await run_case(
        "candidate-no-improvement", "no_improvement"
    )

    accepted = json.loads(
        await records.execute(
            action="experiment_compare",
            task_id="algorithm-acceptance",
            baseline_run_id="baseline",
            candidate_run_id="candidate",
        )
    )
    rejected = json.loads(
        await records.execute(
            action="experiment_compare",
            task_id="algorithm-acceptance",
            baseline_run_id="baseline",
            candidate_run_id="candidate-no-improvement",
        )
    )
    validation = json.loads(
        await records.execute(action="validate", task_id="algorithm-acceptance")
    )

    assert baseline_done["metrics"]["accuracy"] == 0.75
    assert candidate_done["metrics"]["accuracy"] == 0.875
    assert no_improvement_done["metrics"]["accuracy"] == 0.75
    assert baseline_done["command"]
    assert baseline_done["exit_code"] == 0
    assert candidate_done["artifact_paths"] == ["workspace/change.patch"]
    assert accepted["record"]["status"] == "accepted"
    assert accepted["record"]["comparison"] == "accepted"
    assert accepted["record"]["baseline_value"] == 0.75
    assert accepted["record"]["candidate_value"] == 0.875
    assert accepted["record"]["decision_reason"]
    assert rejected["record"]["status"] == "rejected"
    assert rejected["record"]["comparison"] == "rejected"
    assert rejected["record"]["decision_reason"]
    assert baseline_dir != candidate_dir != no_improvement_dir
    assert validation["validation"]["valid"] is True, validation
    assert _sha256(run_py) == original_hash
