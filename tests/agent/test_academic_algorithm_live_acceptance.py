"""Live model gate for one real algorithm candidate experiment.

The test is skipped by default.  With ``RUN_LIVE_RESEARCH_ACCEPTANCE=1`` and
an active model/provider it drives the shipped partner loop and checks the
actual tool calls and persisted experiment artifacts.  No candidate result is
pre-written by the test.
"""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import pytest

from mona.academic.store import ResearchRecordStore
from mona.agent.partners import AgentRegistry, ConversationMetadata

ACADEMIC_AGENT_ID = "com.mona.academic-researcher"
RUN_LIVE_RESEARCH_ACCEPTANCE = os.getenv("RUN_LIVE_RESEARCH_ACCEPTANCE") == "1"


def _configured_live_skip_reason() -> str | None:
    if not RUN_LIVE_RESEARCH_ACCEPTANCE:
        return "set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live algorithm acceptance"
    try:
        from mona.config.loader import load_config, resolve_config_env_vars
        from mona.providers.registry import find_by_name

        config = resolve_config_env_vars(load_config())
        preset = config.resolve_preset()
        provider_name = config.get_provider_name(preset.model, preset=preset)
        provider_config = config.get_provider(preset.model, preset=preset)
        if not preset.model or not provider_name:
            return "no active model/provider preset is configured"
        provider_spec = find_by_name(provider_name)
        if not provider_config or not provider_config.api_key:
            if not provider_spec or not provider_spec.is_local:
                return "active provider has no configured API key"
        if AgentRegistry().get(ACADEMIC_AGENT_ID) is None:
            return f"agent package is unavailable: {ACADEMIC_AGENT_ID}"
        from mona.agent.user_config import load_agent_user_config

        if not load_agent_user_config(ACADEMIC_AGENT_ID).enabled:
            return "academic-researcher partner is disabled in user configuration"
    except Exception as exc:
        return f"live model configuration unavailable: {type(exc).__name__}: {exc}"
    return None


def _tool_invocations(messages: list[dict]) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []
    for message in messages:
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            name = function.get("name")
            raw_arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_arguments)
            except (TypeError, json.JSONDecodeError):
                arguments = {}
            if isinstance(name, str):
                calls.append((name, arguments if isinstance(arguments, dict) else {}))
    return calls


def _nested_record(arguments: dict) -> dict:
    value = arguments.get("record")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


@asynccontextmanager
async def _live_bot(tmp_path: Path):
    reason = _configured_live_skip_reason()
    if reason:
        pytest.skip(reason)
    from mona.config.paths import get_agent_output_dir
    from mona.mona import Mona

    bot = Mona.from_config(workspace=tmp_path)
    agent_workspace = get_agent_output_dir(tmp_path, ACADEMIC_AGENT_ID)
    session_key = f"live-academic-algorithm:{uuid4().hex}"
    session = bot._loop.sessions.get_or_create(session_key)
    session.metadata["conversation"] = ConversationMetadata.direct(
        ACADEMIC_AGENT_ID,
        title="Academic algorithm live acceptance",
    ).to_session_metadata()
    bot._loop.sessions.save(session)
    try:
        yield bot, session_key, agent_workspace
    finally:
        await bot._loop.close_mcp()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live algorithm acceptance",
)
async def test_live_model_runs_one_real_algorithm_candidate_and_preserves_source(
    tmp_path: Path,
):
    async with _live_bot(tmp_path) as runtime:
        bot, session_key, agent_workspace = runtime
        task_id = "live_algorithm_candidate"
        source = agent_workspace / "algorithm-fixture"
        source.mkdir(parents=True, exist_ok=True)
        run_py = source / "run.py"
        run_py.write_text(
            "import json\n"
            "DATA = [(0, 0), (1, 1), (1, 1), (0, 0)]\n"
            "\n"
            "def predict(value):\n"
            "    return 0  # baseline defect: ignores the feature\n"
            "\n"
            "def main():\n"
            "    correct = sum(predict(value) == label for value, label in DATA)\n"
            "    print(json.dumps({'accuracy': correct / len(DATA)}))\n"
            "\n"
            "if __name__ == '__main__':\n"
            "    main()\n",
            encoding="utf-8",
        )
        original_hash = _sha256(run_py)
        prompt = f"""
You are the academic-researcher partner in a live algorithm acceptance test.
Use real tool calls and do not merely describe a plan.  Work only inside the
current agent workspace and never modify the original source directory:
{source}

The fixed development dataset is embedded in run.py.  The baseline has one
obvious single-point defect in predict(value), and changing only that point to
use the feature can improve accuracy.  This is one candidate budget: do not
try a second candidate.

Required workflow:
1. Read the research-execution Skill with skill_read.
2. Use research_record.init for task {task_id}.
3. Use research_record.experiment_start with run_id baseline, source_dir
   {source}, max_files 4, max_bytes 20000, data_hash fixture-data-v1, and the
   command `python run.py > metrics.json`.  Preserve the returned isolated_dir.
4. Use the real exec tool in that isolated_dir to run exactly
   `python run.py > metrics.json`.  Finish baseline with
   metrics_source {{"kind":"json","path":"workspace/metrics.json","key":"accuracy"}},
   metric_name accuracy, metric_direction maximize, evaluation_command
   `python run.py > metrics.json`, exit_code 0, and data_hash fixture-data-v1.
5. Inspect the actual baseline code and propose exactly one evidence-based
   candidate.  Start a separate candidate experiment with source_dir {source}
   and the same contract.  Apply the candidate only in its returned isolated
   directory using apply_patch or edit_file; do not edit the original source.
6. Use real exec to run the same evaluation command in the candidate isolated
   directory, finish from the real JSON metric, then call
   research_record.experiment_compare with baseline and candidate IDs.
7. Call research_record.validate.  Deliver the non-empty candidate patch and
   a short Markdown report with deliver_file.  Never write a metric directly
   from this prompt or claim success without the tool result.

Use at most one candidate.  A candidate that does not improve must be recorded
as rejected honestly; do not fabricate an improvement.
"""
        result = await bot.run(prompt, session_key=session_key)
        invocations = _tool_invocations(result.messages)
        names = [name for name, _ in invocations]
        assert "skill_read" in names, names
        assert any(
            arguments.get("name") == "research-execution"
            for name, arguments in invocations
            if name == "skill_read"
        ), invocations
        assert "exec" in names, names
        assert "research_record" in names, names
        assert "apply_patch" in names or "edit_file" in names, names
        assert "deliver_file" in names, names
        delivered_paths = [
            raw_path
            for name, arguments in invocations
            if name == "deliver_file"
            for raw_path in (arguments.get("paths") or [])
            if isinstance(raw_path, str)
        ]
        patch_paths = [
            path
            for path in delivered_paths
            if path.lower().endswith((".patch", ".diff"))
        ]
        markdown_paths = [path for path in delivered_paths if path.lower().endswith(".md")]
        assert patch_paths, delivered_paths
        assert markdown_paths, delivered_paths
        resolved_deliveries: dict[str, Path] = {}
        for raw_path in delivered_paths:
            delivered = Path(raw_path)
            if not delivered.is_absolute():
                delivered = agent_workspace / delivered
            assert delivered.resolve().is_relative_to(agent_workspace.resolve()), delivered
            assert delivered.is_file() and delivered.stat().st_size > 0, delivered
            resolved_deliveries[raw_path] = delivered
        patch_text = "\n".join(
            resolved_deliveries[path].read_text(encoding="utf-8") for path in patch_paths
        )
        assert "---" in patch_text and "+++" in patch_text, patch_text
        assert "predict" in patch_text, patch_text
        assert "-    return 0" in patch_text, patch_text
        assert "+    return value" in patch_text, patch_text

        record_calls = [
            arguments for name, arguments in invocations if name == "research_record"
        ]
        assert any(
            arguments.get("action") == "init" and arguments.get("task_id") == task_id
            for arguments in record_calls
        ), record_calls
        starts = [
            arguments
            for arguments in record_calls
            if arguments.get("action") == "experiment_start"
        ]
        start_ids = [_nested_record(arguments).get("run_id") for arguments in starts]
        candidate_start_ids = {
            run_id
            for run_id in start_ids
            if isinstance(run_id, str) and not run_id.startswith("baseline")
        }
        assert len(candidate_start_ids) <= 1, starts
        compare_calls = [
            arguments
            for arguments in record_calls
            if arguments.get("action") == "experiment_compare"
        ]
        assert any(
            arguments.get("baseline_run_id", "").startswith("baseline")
            and arguments.get("candidate_run_id") in candidate_start_ids
            for arguments in compare_calls
        ), record_calls
        assert any(arguments.get("action") == "validate" for arguments in record_calls)

        exec_calls = [arguments for name, arguments in invocations if name == "exec"]
        evaluations = [
            arguments
            for arguments in exec_calls
            if "> metrics.json" in str(arguments.get("command") or arguments.get("cmd"))
        ]
        assert len(evaluations) >= 2, exec_calls
        evaluation_dirs = [
            Path(arguments.get("working_dir") or arguments.get("workdir"))
            for arguments in evaluations[:2]
        ]
        assert all(
            directory.is_dir() and (directory / "run.py").is_file()
            for directory in evaluation_dirs
        ), evaluations
        assert len({directory.resolve() for directory in evaluation_dirs}) == 2

        store = ResearchRecordStore(agent_workspace)
        persisted_runs = store.read_experiments(task_id)
        baseline_runs = [
            run
            for run in persisted_runs
            if run.run_id.startswith("baseline") and run.status == "succeeded"
        ]
        candidate_runs = [
            run for run in persisted_runs if not run.run_id.startswith("baseline")
        ]
        assert baseline_runs
        assert len(candidate_runs) == 1, persisted_runs
        baseline = baseline_runs[-1]
        candidate = candidate_runs[0]
        assert baseline.status == "succeeded"
        assert baseline.exit_code == 0
        assert baseline.metrics["accuracy"] == 0.5
        assert candidate.status in {"accepted", "rejected"}
        assert candidate.exit_code == 0
        assert candidate.metrics["accuracy"] in {0.5, 1.0}
        assert candidate.metric_name == baseline.metric_name == "accuracy"
        assert candidate.metric_direction == baseline.metric_direction == "maximize"
        assert candidate.evaluation_command == baseline.evaluation_command
        assert candidate.data_hash == baseline.data_hash == "fixture-data-v1"
        assert candidate.decision_reason

        baseline_dir = Path(baseline.isolated_dir or "")
        candidate_dir = Path(candidate.isolated_dir or "")
        assert baseline_dir.is_dir() and candidate_dir.is_dir()
        assert baseline_dir != candidate_dir
        assert _sha256(run_py) == original_hash
        assert _sha256(candidate_dir / "run.py") != original_hash
        candidate_diff = candidate_dir / "run.py"
        assert candidate_diff.read_text(encoding="utf-8") != run_py.read_text(encoding="utf-8")
        assert store.validate(task_id)["valid"] is True
        assert result.content.strip()
