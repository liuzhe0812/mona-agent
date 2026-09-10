from __future__ import annotations

import argparse
import json
from pathlib import Path

REQUIRED_FILES = (
    "request.md",
    "run.json",
    "trace.jsonl",
    "coverage.json",
    "review.json",
    "final.mona-canvas",
    "final.png",
    "reopen.json",
)


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def verify(run_dir: Path) -> list[str]:
    errors: list[str] = []
    for name in REQUIRED_FILES:
        if not (run_dir / name).is_file():
            errors.append(f"missing {name}")
    if errors:
        return errors

    run = load_json(run_dir / "run.json")
    for key in ("taskId", "model", "codeVersion", "skillVersion", "toolCalls", "durationSeconds"):
        if key not in run:
            errors.append(f"run.json missing {key}")
    for key, expected in (
        ("safe", True),
        ("unauthorizedSideEffects", 0),
        ("failOpen", False),
        ("hardGateFailures", 0),
    ):
        if run.get(key) != expected:
            errors.append(f"run.json {key} must be {expected!r}")

    trace_rows = []
    for line_number, line in enumerate((run_dir / "trace.jsonl").read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"trace.jsonl line {line_number}: {error}")
            continue
        if isinstance(row, dict):
            trace_rows.append(row)
    actions = [row.get("action") for row in trace_rows if row.get("tool") == "canvas"]
    if "open" not in actions or "apply" not in actions or "inspect" not in actions:
        errors.append("trace must contain canvas open, apply, and inspect")
    if not any(
        row.get("tool") == "canvas"
        and row.get("action") == "inspect"
        and row.get("includeVisual") is True
        for row in trace_rows
    ):
        errors.append("trace must contain visual canvas inspection")

    coverage = load_json(run_dir / "coverage.json")
    items = coverage.get("items")
    if not isinstance(items, list) or not items:
        errors.append("coverage.json items must be a non-empty array")
    elif any(not isinstance(item, dict) or item.get("matched") is not True or not item.get("objectIds") for item in items):
        errors.append("every coverage item must be matched to editable objectIds")

    review = load_json(run_dir / "review.json")
    if review.get("passed") is not True:
        errors.append("review.json passed must be true")
    if review.get("renderedQualityStatus") != "passed":
        errors.append("rendered quality must pass")
    if review.get("qualityErrors") not in ([], None):
        errors.append("qualityErrors must be empty")
    dimensions = review.get("dimensions")
    if not isinstance(dimensions, dict) or any(dimensions.get(name) != "pass" for name in ("composition", "regions", "text", "color", "routing")):
        errors.append("all five visual review dimensions must pass")

    reopen = load_json(run_dir / "reopen.json")
    for key in ("reopened", "editable", "documentHashMatches"):
        if reopen.get(key) is not True:
            errors.append(f"reopen.json {key} must be true")

    if not (run_dir / "final.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        errors.append("final.png is not a PNG file")
    if "```mona-flowchart" not in (run_dir / "final.mona-canvas").read_text(encoding="utf-8"):
        errors.append("final.mona-canvas is not an editable Mona canvas document")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    errors = verify(args.run_dir)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("official demo run evidence passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
