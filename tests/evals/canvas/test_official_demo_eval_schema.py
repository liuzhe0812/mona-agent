from __future__ import annotations

import json
from pathlib import Path


def test_official_demo_suite_has_six_strata_and_three_trials_each():
    path = Path(__file__).with_name("official-demo-tasks.jsonl")
    tasks = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    assert len(tasks) == 18
    assert len({task["task_id"] for task in tasks}) == 18
    counts: dict[str, int] = {}
    for task in tasks:
        prefix = task["task_id"].split("-")[2]
        counts[prefix] = counts.get(prefix, 0) + 1
        assert task["outcome_verifier"] == "tests/evals/canvas/verify_official_demo_run.py"
        assert "canvas.inspect" in task["allowed_actions"]
        assert task["budgets"]["max_repair_rounds"] == 3
    assert counts == {letter: 3 for letter in "abcdef"}
