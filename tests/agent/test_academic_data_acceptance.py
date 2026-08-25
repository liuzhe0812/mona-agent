"""Direct acceptance for academic data analysis and reproducible execution."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

import pytest

from mona.academic.models import ExperimentRun
from mona.academic.store import ResearchRecordStore
from mona.agent.tools.dataframe import DataframeTool, DataframeToolConfig
from mona.agent.tools.shell import ExecTool

REPO_ROOT = Path(__file__).parents[2]
DATA_ROOT = REPO_ROOT / "tests" / "fixtures" / "academic_research" / "data"
DATA_FILES = ("synthetic.csv", "synthetic.json", "synthetic.xlsx")


def _markdown_table_row(result: str) -> dict[str, str]:
    rows = [
        [cell.strip() for cell in line.strip().strip("|").split("|")]
        for line in result.splitlines()
        if line.strip().startswith("|")
    ]
    assert len(rows) >= 3, result
    return dict(zip(rows[0], rows[2], strict=True))


def _exit_code(result: str) -> int:
    match = re.search(r"\nExit code:\s*(-?\d+)\s*$", result)
    assert match, result
    return int(match.group(1))


@pytest.mark.asyncio
async def test_dataframe_tool_reads_equivalent_csv_json_xlsx_data() -> None:
    tool = DataframeTool(
        workspace=REPO_ROOT,
        config=DataframeToolConfig(restrict_to_workspace=True),
        restrict_to_workspace=True,
    )
    means: list[float] = []
    for filename in DATA_FILES:
        relative = Path("tests/fixtures/academic_research/data") / filename
        result = await tool.execute(
            sql=(
                "SELECT COUNT(*) AS row_count, AVG(score) AS mean_score, "
                "SUM(CASE WHEN score IS NULL THEN 1 ELSE 0 END) AS missing_score "
                "FROM synthetic"
            ),
            files=[str(relative)],
        )
        row = _markdown_table_row(result)
        assert int(row["row_count"]) == 4
        assert float(row["missing_score"]) == 0
        means.append(float(row["mean_score"]))

        fields_result = await tool.execute(
            sql="PRAGMA table_info(synthetic)",
            files=[str(relative)],
        )
        assert "| id | INTEGER |" in fields_result
        assert "| score | REAL |" in fields_result
        assert "| group | TEXT |" in fields_result
    assert means == [0.75, 0.75, 0.75]


@pytest.mark.asyncio
async def test_exec_tool_runs_analysis_records_metric_and_reproduces_result(
    tmp_path: Path,
) -> None:
    fixture = DATA_ROOT / "synthetic.csv"
    fixture_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
    store = ResearchRecordStore(tmp_path)
    store.init("data-execution", "Run a real analysis script")
    run = store.experiment_start(
        "data-execution",
        ExperimentRun(
            run_id="analysis-1",
            status="planned",
            command="python analysis.py",
        ),
    )
    run_dir = store.task_dir("data-execution") / "experiments" / run.run_id
    shutil.copy2(fixture, run_dir / "synthetic.csv")
    (run_dir / "analysis.py").write_text(
        """
import csv
import json
from pathlib import Path

rows = list(csv.DictReader(Path('synthetic.csv').open(newline='', encoding='utf-8')))
scores = [float(row['score']) for row in rows if row['score'] != '']
result = {
    'rows': len(rows),
    'mean_score': sum(scores) / len(scores),
    'missing_score': len(rows) - len(scores),
}
Path('analysis_result.json').write_text(json.dumps(result), encoding='utf-8')
print(json.dumps(result, sort_keys=True))
""".strip()
        + "\n",
        encoding="utf-8",
    )
    tool = ExecTool(
        working_dir=tmp_path,
        timeout=30,
        restrict_to_workspace=True,
    )
    first_output = await tool.execute(
        command="python analysis.py",
        working_dir=str(run_dir),
    )
    assert _exit_code(first_output) == 0
    first_result = json.loads((run_dir / "analysis_result.json").read_text(encoding="utf-8"))

    second_output = await tool.execute(
        command="python analysis.py",
        working_dir=str(run_dir),
    )
    assert _exit_code(second_output) == 0
    second_result = json.loads((run_dir / "analysis_result.json").read_text(encoding="utf-8"))
    assert second_result == first_result

    stdout_path = run_dir / "stdout.txt"
    stdout_path.write_text(second_output, encoding="utf-8")
    finished = store.experiment_finish(
        "data-execution",
        run.run_id,
        status="succeeded",
        exit_code=_exit_code(second_output),
        stdout_path="experiments/analysis-1/stdout.txt",
        metric_name="mean_score",
        metric_direction="maximize",
        evaluation_command="python analysis.py",
        data_hash=fixture_hash,
        metrics_source={
            "kind": "json",
            "path": "analysis_result.json",
            "key": "mean_score",
        },
    )
    assert finished.exit_code == 0
    assert finished.metrics["mean_score"] == first_result["mean_score"]
    assert finished.metrics["mean_score"] == 0.75
    assert finished.input_hashes == {}
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == fixture_hash

    validation = store.validate("data-execution")
    assert validation["valid"] is True, validation
