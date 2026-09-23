"""Opt-in live acceptance for the development Coding assembly (not CLI integration).

Uses the configured provider on a disposable project under output/. Does not
start/restart Mona services, change the user's config, or edit the real project.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from loguru import logger

from mona.agent.runner import AgentRunner
from mona.config.loader import get_config_path, resolve_config_env_vars
from mona.config.schema import Config
from mona.development.coding import CodingTools, build_coding_run_spec
from mona.development.context import load_project_context
from mona.development.contracts import RunStatus, new_id
from mona.development.executors.discovery import discover_executors
from mona.development.store import DevelopmentStore
from mona.providers.factory import build_provider_snapshot
from mona.session.manager import SessionManager

ROOT = Path(__file__).resolve().parents[1]
TEST_SOURCE = """import unittest
from totals import invoice_total

class TotalsTests(unittest.TestCase):
    def test_quantities(self):
        self.assertEqual(invoice_total([(5, 3), (2, 4)]), 23)
    def test_empty(self):
        self.assertEqual(invoice_total([]), 0)
    def test_zero_and_negative(self):
        self.assertEqual(invoice_total([(8, 0), (3, -2)]), -6)
"""


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def has_successful_read(messages: list[dict], target: Path, root: Path, expected_text: str) -> bool:
    """Match decoded tool arguments to the successful result, not escaped JSON text."""
    calls: set[str] = set()
    for message in messages:
        if message.get("role") == "assistant":
            for call in message.get("tool_calls", []):
                function = call.get("function", {})
                if function.get("name") != "read_file":
                    continue
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        continue
                if not isinstance(arguments, dict) or not isinstance(arguments.get("path"), str):
                    continue
                if (root / Path(arguments["path"])).resolve() == target.resolve():
                    calls.add(call["id"])
        if message.get("role") == "tool" and message.get("tool_call_id") in calls:
            content = message.get("content")
            if isinstance(content, str) and not content.lstrip().lower().startswith("error") and expected_text in content:
                return True
    return False


async def main(output: str) -> int:
    started = time.monotonic()
    target = (ROOT / output).resolve()
    if not target.is_relative_to(ROOT / "output"):
        raise ValueError("Acceptance output must be inside project/output")
    if target.exists() and any(target.iterdir()):
        raise ValueError("Use a new output directory; prior evidence is immutable")
    target.mkdir(parents=True, exist_ok=True)
    report = {"scope": "Live configured model + development Coding assembly + real file/exec tools; no UI or native CLI acceptance", "checks": {}, "status": "failed"}
    tools = None
    active_run = None
    store = None
    try:
        # Read-only configuration load: avoid load_config's legacy migration write.
        if not Config.__pydantic_complete__:
            from mona.config.schema import _resolve_tool_config_refs
            _resolve_tool_config_refs()
        config = resolve_config_env_vars(Config.model_validate(json.loads(get_config_path().read_text(encoding="utf-8-sig"))))
        snapshot = build_provider_snapshot(config, preset_name=config.development.model_preset)
        report["model"] = snapshot.model
        report["nativeDiscovery"] = [p.model_dump(mode="json") for p in discover_executors(config.development)]
        project_dir = target / "project"
        project_dir.mkdir()
        rules = project_dir / "AGENTS.md"
        rules.write_text("只修改用户要求的源文件，保留人工注释。不要修改 test_totals.py，不要安装依赖、联网或使用 Git。验证前读取 .agents/skills/unit-check/SKILL.md。\n", encoding="utf-8")
        skill = project_dir / ".agents/skills/unit-check/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: unit-check\ndescription: 项目专用 Python 单元测试方法\n---\n修改后运行 python -m unittest -v。不要改测试来掩盖失败；如失败请修复源代码。\n", encoding="utf-8")
        source = project_dir / "totals.py"
        source.write_text("# USER_ORIGINAL_NOTE: preserve this comment\ndef invoice_total(items):\n    return sum(price for price, quantity in items)\n", encoding="utf-8")
        test = project_dir / "test_totals.py"
        test.write_text(TEST_SOURCE, encoding="utf-8")
        immutable = {p.name: digest(p) for p in (rules, skill, test)}
        store = DevelopmentStore(target / "state.sqlite3")
        project = store.open_project(project_dir)
        session = store.create_session(project.id, title="Coding real-provider acceptance")
        manager = SessionManager(target / "state")
        transcript = manager.get_or_create(session.transcript_key)
        tools = CodingTools(project_dir, session.transcript_key, config.tools.exec)
        report["sessionId"] = session.id
        report["turns"] = []
        checkpoints = []
        for index, prompt in enumerate((
            "修复 invoice_total：输入是 (单价, 数量) 的序列，返回各项 单价×数量 的合计；空序列返回 0，零数量和负数量按普通乘法处理。保留我的注释，不改测试。按项目 Skill 运行测试后说明结果。",
            "我刚在 totals.py 末尾手动增加了 USER_MANUAL_NOTE 注释。继续当前会话，只给 invoice_total 增加清楚的 docstring，保留已有行为和两条人工注释，不要重新生成项目或改测试；重新运行测试。",
        )):
            if index:
                with source.open("a", encoding="utf-8") as stream:
                    stream.write("\n# USER_MANUAL_NOTE: preserve this later edit\n")
                # A new SessionManager instance proves replay uses saved history.
                manager = SessionManager(target / "state")
                transcript = manager.get_or_create(session.transcript_key)
            message_id = new_id("message")
            transcript.add_message("user", prompt, id=message_id)
            manager.save(transcript, fsync=True)
            active_run, _ = store.create_run(session.id, new_id("request"), message_id)
            active_run = store.transition_run(active_run.id, 0, RunStatus.PREPARING)
            context = load_project_context(project, config.development)
            spec = build_coding_run_spec(context, session, transcript, tools, model=snapshot.model,
                context_window_tokens=snapshot.context_window_tokens,
                defaults=config.agents.defaults.model_copy(update={"max_tool_iterations": 24}))
            spec.llm_timeout_s = 150
            spec.enforce_llm_timeout_for_streaming = True
            baseline = copy.deepcopy(transcript.messages)
            initial_length = len(spec.initial_messages)
            rounds = {}

            async def checkpoint(event):
                iteration = event["iteration"]
                rounds[iteration] = copy.deepcopy(event)
                transcript.messages = copy.deepcopy(baseline)
                for _, row in sorted(rounds.items()):
                    transcript.messages.append(row["assistant_message"])
                    transcript.messages.extend(row.get("completed_tool_results", []))
                manager.save(transcript, fsync=True)
                calls = [c.get("function", {}) for c in event["assistant_message"].get("tool_calls", [])]
                checkpoints.append({"turn": index, "iteration": iteration, "phase": event["phase"], "calls": calls})
                (target / "trace.json").write_text(json.dumps(checkpoints, ensure_ascii=False, indent=2), encoding="utf-8")
                if event["phase"] == "tools_completed":
                    print(json.dumps({"turn": index, "iteration": iteration, "tools": [c.get("name") for c in calls]}), flush=True)

            spec.checkpoint_callback = checkpoint
            active_run = store.transition_run(active_run.id, active_run.revision, RunStatus.RUNNING)
            result = await AgentRunner(snapshot.provider).run(spec)
            transcript.messages = baseline + copy.deepcopy(result.messages[initial_length:])
            manager.save(transcript, fsync=True)
            active_run = store.transition_run(active_run.id, active_run.revision,
                RunStatus.SUCCEEDED if result.stop_reason == "completed" and not result.error else RunStatus.FAILED,
                error_code=None if not result.error else "runner_error")
            report["turns"].append({"runId": active_run.id, "stopReason": result.stop_reason,
                "status": active_run.status.value, "usage": result.usage, "tools": result.tools_used,
                "final": result.final_content})
            if result.error or result.stop_reason != "completed":
                break
        verification = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=project_dir,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        (target / "verification.txt").write_text(verification.stdout + verification.stderr, encoding="utf-8")
        text = source.read_text(encoding="utf-8")
        import ast
        function = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == "invoice_total")
        report["checks"] = {
            "two_turns_completed": len(report["turns"]) == 2 and all(t["status"] == "succeeded" for t in report["turns"]),
            "tests_passed_independently": verification.returncode == 0 and "Ran 3 tests" in verification.stderr,
            "tests_rules_skills_unchanged": all(digest(p) == immutable[p.name] for p in (rules, skill, test)),
            "original_manual_edit_preserved": "USER_ORIGINAL_NOTE" in text,
            "later_manual_edit_preserved": "USER_MANUAL_NOTE" in text,
            "docstring_added": bool(ast.get_docstring(function)),
            "same_product_session": len(store.list_sessions(project.id)) == 1,
            "project_skill_read": has_successful_read(transcript.messages, skill, project_dir, "python -m unittest -v"),
            "no_business_tools": not any(t in {"office", "memory", "my", "browser"} for turn in report["turns"] for t in turn["tools"]),
        }
        report["status"] = "passed" if all(report["checks"].values()) else "failed"
    except Exception as exc:
        # Config/provider exceptions can contain secrets; do not persist their repr.
        report["errorType"] = type(exc).__name__
        if store is not None and active_run is not None and active_run.status == RunStatus.RUNNING:
            store.transition_run(active_run.id, active_run.revision, RunStatus.UNKNOWN, error_code="acceptance_exception")
    finally:
        if tools is not None:
            await tools.exec_sessions.cancel_by_session(tools.session_key)
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        (target / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: report.get(k) for k in ("status", "model", "checks", "errorType", "elapsedSeconds")}, ensure_ascii=False), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--live", action="store_true", help="Explicitly use the configured provider on this synthetic project.")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required; this test invokes the configured model.")
    logger.remove()
    raise SystemExit(asyncio.run(main(args.output)))
