"""Opt-in real browser + HTTP + configured-model workbench acceptance.

Everything runs in a disposable output project and isolated local servers.
Does not restart dev, edit user projects, install runtimes, or use native CLIs.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestServer
from loguru import logger
from playwright.async_api import async_playwright

from mona.config.loader import get_config_path, resolve_config_env_vars
from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.session.manager import SessionManager
from scripts.verify_development_coding import TEST_SOURCE, has_successful_read

ROOT = Path(__file__).resolve().parents[1]


async def main(output: str, browser: str) -> int:
    started = time.monotonic()
    target = (ROOT / output).resolve()
    if not target.is_relative_to(ROOT / "output") or target.exists():
        raise ValueError("Use a new directory under output/")
    target.mkdir(parents=True)
    report = {"scope": "Real workbench React components + authenticated HTTP + production Coding runtime/tools + configured model. Not native desktop or CLI acceptance.",
              "status": "failed", "checks": {}, "step": "setup"}
    server = process = browser_instance = None
    logs, page_errors = [], []
    drain = None
    try:
        _resolve_tool_config_refs()
        config = resolve_config_env_vars(Config.model_validate(json.loads(get_config_path().read_text(encoding="utf-8-sig"))))
        config.development.coding.max_tool_iterations = 24
        report["model"] = config.resolve_preset(config.development.model_preset).model
        root = target / "project"
        root.mkdir()
        (root / "AGENTS.md").write_text("只修改用户指定文件，保留人工注释。不改测试，不安装依赖，不联网，不使用 Git。测试方法见 .agents/skills/unit-check/SKILL.md。", encoding="utf-8")
        skill = root / ".agents/skills/unit-check/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: unit-check\ndescription: 当前项目单元测试\n---\n运行 python -m unittest -v；不要修改测试来掩盖错误。", encoding="utf-8")
        source = root / "totals.py"
        source.write_text("# USER_ORIGINAL_NOTE\ndef invoice_total(items):\n    return sum(price for price, quantity in items)\n", encoding="utf-8")
        tests = root / "test_totals.py"
        tests.write_text(TEST_SOURCE, encoding="utf-8")
        git = shutil.which("git")
        if not git:
            raise RuntimeError("Git is required for the isolated visual acceptance repository")
        git_env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
        for args in [("init", "-q"), ("add", "--", "."), ("-c", "user.name=Mona Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-q", "-m", "acceptance baseline")]:
            result = subprocess.run([git, *args], cwd=root, env=git_env, capture_output=True, timeout=20)
            if result.returncode:
                raise RuntimeError("Isolated Git fixture setup failed")
        immutable = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (tests, skill, root / "AGENTS.md")}
        runtime = DevelopmentRuntime(DevelopmentStore(target / "state.sqlite3"), SessionManager(target / "history"), lambda: config)
        token = secrets.token_hex(32)
        os.environ["MONA_SERVICES_TOKEN"] = token
        app = web.Application()
        app[RUNTIME_KEY] = runtime
        register_development_routes(app)
        server = TestServer(app)
        await server.start_server()
        env = {**os.environ, "MONA_SMOKE_API": str(server.make_url("")).rstrip("/"), "MONA_SMOKE_TOKEN": token, "NO_COLOR": "1"}
        process = await asyncio.create_subprocess_exec(shutil.which("node"), str(ROOT / "webui/scripts/development-smoke-server.mjs"),
            cwd=str(ROOT / "webui"), env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        async def wait_url():
            while line := await process.stdout.readline():
                text = line.decode("utf-8", "replace").strip()
                logs.append(text)
                if text.startswith("SMOKE_URL "):
                    return text.removeprefix("SMOKE_URL ")
            raise RuntimeError("UI host exited before ready")
        url = await asyncio.wait_for(wait_url(), 45)
        async def drain_logs():
            while line := await process.stdout.readline():
                logs.append(line.decode("utf-8", "replace").strip())
                if len(logs) > 500:
                    del logs[:100]
        drain = asyncio.create_task(drain_logs())
        async with async_playwright() as pw:
            browser_instance = await pw.chromium.launch(executable_path=browser, headless=True)
            page = await browser_instance.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            async def add_follows_tabs():
                return await page.evaluate("""() => {
                  const aside = document.querySelector('aside[aria-label="开发工作侧栏"]');
                  const strip = aside.querySelector('[role="tablist"]');
                  const tabs = strip.querySelectorAll('[role="tab"]');
                  const last = tabs[tabs.length - 1].closest('.group') || tabs[tabs.length - 1];
                  const add = aside.querySelector('button[aria-label="打开工作标签"]');
                  const end = Math.min(last.getBoundingClientRect().right, strip.getBoundingClientRect().right);
                  const rect = add.getBoundingClientRect();
                  const controls = aside.querySelector('button[aria-label="放大侧边栏"]');
                  return rect.left >= end && rect.left - end <= 12 && rect.width >= 24
                    && rect.right <= controls.getBoundingClientRect().left;
                }""")
            await page.goto(url, wait_until="networkidle", timeout=90000)
            report["step"] = "open_project"
            await page.get_by_role("button", name="打开本地项目", exact=True).click()
            await page.get_by_role("textbox", name="项目目录").fill(str(root))
            await page.get_by_role("button", name="打开项目", exact=True).click()
            await page.get_by_role("complementary", name="开发项目列表").get_by_role("button", name=f"在 {root.name} 新建会话", exact=True).click()
            await page.get_by_role("textbox", name="开发任务输入").wait_for()
            report["checks"]["direct_creation_without_setup_dialog"] = await page.get_by_role("dialog", name="新建开发任务").count() == 0
            report["checks"]["no_duplicate_engine_selector"] = await page.get_by_role("button", name="主执行引擎").count() == 0
            report["checks"]["new_input_focused"] = await page.get_by_role("textbox", name="开发任务输入").evaluate("node => node === document.activeElement")
            report["checks"]["add_follows_overview"] = await add_follows_tabs()
            await page.screenshot(path=str(target / "00-direct-new-session.png"))
            await page.get_by_role("button", name="打开工作标签").click()
            await page.get_by_role("menuitem", name="文件", exact=True).click()
            await page.get_by_role("tab", name="文件", exact=True).wait_for()
            report["checks"]["add_moves_with_new_tab"] = await add_follows_tabs()
            await page.screenshot(path=str(target / "00-tabs-add-position.png"))
            await page.get_by_role("button", name="关闭 文件", exact=True).click()
            await page.get_by_role("button", name="新开发任务更多操作", exact=True).click()
            await page.get_by_role("menuitem", name="重命名", exact=True).click()
            await page.get_by_role("textbox", name="新的任务名称").fill("修复金额计算")
            await page.get_by_role("button", name="保存", exact=True).click()
            prompt = "修复 invoice_total：输入是 (单价, 数量) 的序列，返回各项单价乘数量的合计；空序列返回 0。先调用 update_plan 记录简短的修复与验证计划，并按实际进展更新。保留注释，不改测试。读取项目测试 Skill 并运行测试后说明结果。"
            await page.get_by_role("textbox", name="开发任务输入").fill(prompt)
            report["step"] = "first_model_turn"
            await page.get_by_role("button", name="发送开发任务", exact=True).click()
            await page.get_by_role("status").filter(has_text="本轮结束").wait_for(timeout=240000)
            project = runtime.store.list_projects()[0]
            session = runtime.store.list_sessions(project.id)[0]
            report["checks"]["project_and_task_created_from_ui"] = len(runtime.store.list_runs(session.id)) == 1
            current_messages = runtime.snapshot(session.id)["messages"]
            tool_calls = [call["id"] for message in current_messages for call in message["toolCalls"]]
            report["checks"]["tool_calls_displayed_once"] = bool(tool_calls) and all([
                await page.locator("[data-tool-call-id]").evaluate_all("(nodes, id) => nodes.filter(n => n.dataset.toolCallId === id).length", call_id) == 1
                for call_id in tool_calls
            ])
            feed = page.locator('main [aria-label="开发会话记录"]')
            scrollable = await feed.evaluate("node => node.scrollHeight > node.clientHeight + 100")
            if scrollable:
                await feed.evaluate("node => { node.scrollTop = 0; }")
                await asyncio.sleep(3)
                report["checks"]["reading_history_not_pulled_to_bottom"] = await feed.evaluate("node => node.scrollTop < 10")
                await feed.evaluate("node => { node.scrollTop = node.scrollHeight; }")
            else:
                report["scrollCheck"] = "Not applicable: this model's first reply did not overflow the conversation view."

            await page.screenshot(path=str(target / "01-completed-chat.png"))
            report["step"] = "manual_file_edit"
            await page.get_by_role("complementary", name="开发工作侧栏").get_by_role("button", name="文件", exact=True).click()
            await page.get_by_role("button", name="totals.py", exact=True).click()
            editor = page.get_by_role("textbox", name="项目文件编辑器")
            text = await editor.input_value()
            await editor.fill(text + "\n# USER_MANUAL_NOTE\n")
            await page.get_by_role("button", name="保存", exact=True).click()
            await page.get_by_role("button", name="保存", exact=True).wait_for(state="visible")
            await asyncio.sleep(0.3)
            assert "USER_MANUAL_NOTE" in source.read_text(encoding="utf-8")
            report["checks"]["manual_edit_saved_from_ui"] = True
            await page.get_by_role("button", name="收起侧边栏").click()
            report["step"] = "continue_model_turn"
            await page.get_by_role("textbox", name="开发任务输入").fill("继续当前任务，只给 invoice_total 增加清楚的 docstring。保留两条人工注释和已有行为，不改测试、不重建项目，重新运行测试。")
            await page.get_by_role("button", name="发送开发任务", exact=True).click()
            async def wait_second():
                while True:
                    runs = runtime.store.list_runs(session.id)
                    if len(runs) == 2 and all(r.status.value in {"succeeded", "failed", "interrupted"} for r in runs):
                        assert all(r.status.value == "succeeded" for r in runs)
                        return
                    await asyncio.sleep(0.5)
            await asyncio.wait_for(wait_second(), 240)
            verify = await asyncio.to_thread(subprocess.run, [sys.executable, "-m", "unittest", "-v"], cwd=root,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            (target / "unit-tests.txt").write_text(verify.stdout + verify.stderr, encoding="utf-8")
            report["checks"]["independent_tests_passed"] = verify.returncode == 0 and "Ran 3 tests" in verify.stderr
            report["checks"]["manual_notes_preserved"] = all(x in source.read_text(encoding="utf-8") for x in ("USER_ORIGINAL_NOTE", "USER_MANUAL_NOTE"))
            report["checks"]["tests_rules_skill_unchanged"] = all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in immutable.items())
            transcript = runtime.sessions.get_or_create(session.transcript_key)
            report["checks"]["project_skill_actually_read"] = has_successful_read(transcript.messages, skill, root, "python -m unittest -v")
            report["checks"]["same_session_continued"] = len(runtime.store.list_sessions(project.id)) == 1 and len(runtime.store.list_runs(session.id)) == 2
            report["checks"]["real_plan_displayed"] = bool(runtime.snapshot(session.id)["plan"])
            report["checks"]["event_driven_observation_enabled"] = bool(runtime.snapshot(session.id).get("watchVersion"))
            report["step"] = "configure_subagent"
            await page.get_by_role("button", name="管理配置", exact=True).click()
            await page.get_by_role("button", name="Code Review", exact=True).click()
            await page.get_by_role("textbox", name="子智能体名称").fill("项目只读审查")
            await page.get_by_role("button", name="关闭 子智能体配置", exact=True).click()
            await page.get_by_role("button", name="管理配置", exact=True).click()
            report["checks"]["subagent_draft_survives_tab_close"] = await page.get_by_role("textbox", name="子智能体名称").input_value() == "项目只读审查"

            await page.get_by_role("button", name="保存子智能体", exact=True).click()
            await page.get_by_role("button", name="编辑 项目只读审查", exact=True).wait_for()
            profile = runtime.store.get_project(project.id).subagents[0]
            report["checks"]["manual_configuration_persisted_without_running"] = profile.name == "项目只读审查" and profile.readonly and not runtime.collaboration.runtime.tasks
            await page.screenshot(path=str(target / "02-subagent-settings.png"))
            await page.get_by_role("button", name="收起侧边栏").click()
            report["step"] = "configured_subagent_review"
            await page.get_by_role("button", name="调用子智能体", exact=True).click()
            await page.get_by_role("combobox", name="子智能体预设").select_option(profile.id)
            review_goal = "只读审查 totals.py 中 invoice_total 的实现；读取文件后简要回答，不运行命令，不修改任何文件。"
            await page.get_by_role("textbox", name="协作目标").fill(review_goal)
            before_review = hashlib.sha256(source.read_bytes()).hexdigest()
            await page.get_by_role("button", name="派发任务", exact=True).click()
            async def wait_review():
                while True:
                    records = await runtime.collaboration.observe(session.id)
                    if records and records[0].get("returnMessageId"):
                        return records[0]
                    await asyncio.sleep(0.5)
            review = await asyncio.wait_for(wait_review(), 180)
            child = runtime.store.get_session(review["childSessionId"])
            report["checks"]["configured_subagent_executed_and_returned"] = child.readonly and child.title.startswith(profile.name) and review["latestRun"]["status"] == "succeeded"
            report["checks"]["review_preserved_manual_code"] = hashlib.sha256(source.read_bytes()).hexdigest() == before_review
            await page.get_by_role("button", name=review_goal, exact=True).click()
            await page.get_by_role("button", name="关闭 子智能体会话", exact=True).wait_for()
            report["checks"]["child_view_keeps_single_main_conversation"] = await page.locator("main").get_by_test_id("development-pane").count() == 1
            await page.screenshot(path=str(target / "03-review-in-sidebar.png"))
            await page.get_by_role("button", name="收起侧边栏").click()
            report["step"] = "actual_diff_review"
            await page.get_by_role("complementary", name="开发工作侧栏").get_by_role("button", name="审查", exact=True).click()
            await page.get_by_role("button", name="totals.py", exact=False).click()
            await page.get_by_label("代码差异", exact=True).wait_for()
            await page.screenshot(path=str(target / "07-versioned-diff.png"))
            await page.get_by_role("button", name="只读审查", exact=True).click()
            await page.get_by_role("combobox", name="审查子智能体").select_option(profile.id)
            before_review = hashlib.sha256(source.read_bytes()).hexdigest()
            dispatched = []
            dispatch_url = f"**/api/development/sessions/{session.id}/subagents/{profile.id}/run"
            async def lose_accepted_reply(route):
                if route.request.method != "POST":
                    await route.continue_()
                    return
                # Execute the actual server request, then lose only its client response.
                response = await route.fetch()
                try:
                    assert response.status == 200, "The injected loss must follow an accepted request"
                    dispatched.append(await response.json())
                finally:
                    await response.dispose()
                await route.abort(error_code="connectionreset")
            await page.route(dispatch_url, lose_accepted_reply)
            await page.get_by_role("button", name="开始只读审查", exact=True).click()
            dialog = page.get_by_role("dialog", name="审查本次差异")
            await dialog.get_by_role("alert").wait_for()
            await dialog.get_by_role("button", name="取消", exact=True).click()
            await page.get_by_role("button", name="关闭 审查", exact=True).click()
            await page.get_by_role("complementary", name="开发工作侧栏").get_by_role("button", name="审查", exact=True).click()
            await page.get_by_role("button", name="核对原派发", exact=True).wait_for()
            report["checks"]["uncertain_review_survives_tab_remount_without_resend"] = len(dispatched) == 1
            await page.screenshot(path=str(target / "08-review-recovery.png"))
            await page.get_by_role("button", name="核对原派发", exact=True).click()
            await page.get_by_role("button", name="查看审查", exact=True).wait_for()
            report["checks"]["accepted_review_recovered_without_second_post"] = len(dispatched) == 1
            await page.unroute(dispatch_url, lose_accepted_reply)
            async def wait_diff_review():
                while True:
                    records = await runtime.collaboration.observe(session.id)
                    matching = [record for record in records if 'diffSha256' in record["goal"]]
                    if matching and matching[0].get("returnMessageId"):
                        return matching[0]
                    await asyncio.sleep(0.5)
            diff_review = await asyncio.wait_for(wait_diff_review(), 180)
            report["checks"]["recovered_review_keeps_original_child_and_request"] = (
                diff_review["id"] == dispatched[0]["id"]
                and diff_review["childSessionId"] == dispatched[0]["childSessionId"]
                and diff_review["requestId"] == dispatched[0]["requestId"]
                and len(runtime.store.list_collaborations(session.id)) == 2)
            report["checks"]["diff_review_receives_actual_version_and_changes"] = ('diff --git' in diff_review["goal"] and 'invoice_total' in diff_review["goal"] and diff_review["readonly"] and diff_review["latestRun"]["status"] == "succeeded")
            report["checks"]["diff_review_preserves_user_code"] = hashlib.sha256(source.read_bytes()).hexdigest() == before_review
            await page.get_by_role("button", name="收起侧边栏").click()
            report["step"] = "process_returned_result"
            followup_url = f"**/api/development/sessions/{session.id}/collaborations/{diff_review['id']}/follow-up"
            followup_posts = []
            async def lose_followup_receipt(route):
                if route.request.method != "POST":
                    await route.continue_()
                    return
                response = await route.fetch()
                try:
                    assert response.status == 200
                    followup_posts.append(await response.json())
                finally:
                    await response.dispose()
                await route.abort(error_code="connectionreset")
            await page.route(followup_url, lose_followup_receipt)
            user_draft = "暂存的后续想法，先不要发送。"
            await page.get_by_role("textbox", name="开发任务输入", exact=True).fill(user_draft)
            card = page.locator(f'[data-collaboration-id="{diff_review["id"]}"]')
            report["checks"]["review_scope_and_version_persisted"] = (diff_review.get("reviewSource", {}).get("path") == "totals.py")
            await card.get_by_role("button", name="核对代码版本", exact=True).click()
            await card.get_by_text("核对时版本未变", exact=True).wait_for()
            report["checks"]["review_source_matches_before_manual_change"] = True
            source.write_text(source.read_text(encoding="utf-8") + "\n# REVIEW_VERSION_CHANGED\n", encoding="utf-8")
            await card.get_by_role("button", name="核对代码版本", exact=True).click()
            await card.get_by_text("代码已变化，原审查需要重新确认", exact=True).wait_for()
            report["checks"]["manual_change_marks_review_stale_without_new_task"] = len(runtime.store.list_runs(session.id)) == 2
            await page.screenshot(path=str(target / "09-review-version-changed.png"))
            await card.get_by_role("button", name="交给主会话处理", exact=True).click()
            await page.get_by_role("dialog", name="处理子任务结果").get_by_text("代码已变化，原审查需要重新确认", exact=True).wait_for()
            report["checks"]["result_confirmation_discloses_changed_source"] = True
            report["checks"]["result_confirmation_does_not_start_task"] = len(runtime.store.list_runs(session.id)) == 2
            await page.get_by_role("button", name="确认交给主会话", exact=True).click()
            async def wait_followup():
                while True:
                    value = runtime.collaboration.inspect_result(session.id, diff_review["id"])["followUp"]
                    if value and value["run"] and value["run"]["status"] in {"succeeded", "failed", "interrupted", "unknown"} and not runtime.tasks:
                        return value
                    await asyncio.sleep(0.25)
            processed = await asyncio.wait_for(wait_followup(), 240)
            parent_transcript = runtime.sessions.get_or_create(session.transcript_key)
            report["checks"]["parent_receives_fresh_source_check"] = any(
                isinstance(message.get("content"), str) and '"sourceCheck"' in message["content"]
                and '"state": "changed"' in message["content"] for message in parent_transcript.messages)
            report["checks"]["parent_actually_processes_selected_result"] = processed["run"]["status"] == "succeeded" and len(runtime.store.list_runs(session.id)) == 3
            report["checks"]["lost_followup_receipt_does_not_duplicate"] = len(followup_posts) == 1 and followup_posts[0]["followUp"]["requestId"] == processed["requestId"]
            report["checks"]["result_processing_preserves_unsent_draft"] = await page.get_by_role("textbox", name="开发任务输入", exact=True).input_value() == user_draft
            report["checks"]["result_processing_never_restarts_child"] = len(runtime.store.list_runs(diff_review["childSessionId"])) == 1
            followup_test = await asyncio.to_thread(subprocess.run, [sys.executable, "-m", "unittest", "-v"], cwd=root,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
            report["checks"]["result_processing_keeps_tests_and_manual_notes"] = followup_test.returncode == 0 and all(
                note in source.read_text(encoding="utf-8") for note in ("USER_ORIGINAL_NOTE", "USER_MANUAL_NOTE"))
            await card.get_by_text("主会话处理 · 本轮已结束，请查看处理结论", exact=True).wait_for()
            await page.screenshot(path=str(target / "09-result-follow-up.png"))
            await page.unroute(followup_url, lose_followup_receipt)
            report["step"] = "switch_project_sessions"
            await page.get_by_role("complementary", name="开发项目列表").get_by_role("button", name=f"在 {root.name} 新建会话", exact=True).click()
            await page.get_by_role("button", name="打开开发任务：新开发任务", exact=True).wait_for()
            report["checks"]["direct_second_session_created"] = len(runtime.store.list_sessions(project.id)) >= 2
            await page.get_by_role("complementary", name="开发项目列表").get_by_role("button", name="打开开发任务：修复金额计算", exact=True).click()
            report["checks"]["switching_sessions_never_reexecutes"] = len(runtime.store.list_runs(session.id)) == 3
            report["checks"]["processed_result_survives_view_remount"] = bool(runtime.collaboration.inspect_result(session.id, diff_review["id"])["followUp"])
            report["checks"]["split_screen_controls_removed"] = await page.get_by_role("button", name="四屏", exact=True).count() == 0 and await page.get_by_role("button", name="双屏", exact=True).count() == 0
            await page.get_by_role("button", name="Git 工具", exact=True).click()
            await page.get_by_role("region", name="Git 工具浮层").wait_for()
            await page.screenshot(path=str(target / "04-floating-git.png"))
            await page.get_by_role("button", name="关闭 Git 工具").click()
            await page.evaluate("document.documentElement.classList.add('dark')")
            await page.screenshot(path=str(target / "05-dark-overview.png"))
            await page.evaluate("document.documentElement.classList.remove('dark')")
            await page.set_viewport_size({"width": 1280, "height": 800})
            await page.screenshot(path=str(target / "06-compact-overview.png"))
            report["checks"]["no_horizontal_overflow"] = await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            report["checks"]["add_visible_after_tabs_in_compact_view"] = await add_follows_tabs()
            report["checks"]["no_uncaught_browser_error"] = not page_errors
            await browser_instance.close()
            browser_instance = None
        report["status"] = "passed" if all(report["checks"].values()) else "failed"
    except Exception as exc:
        report["errorType"] = type(exc).__name__
        report["error"] = str(exc)[:1200]
        if browser_instance:
            try:
                await browser_instance.contexts[0].pages[0].screenshot(path=str(target / "failure.png"))
            except Exception:
                pass
    finally:
        if browser_instance:
            await browser_instance.close()
        if process and process.returncode is None:
            try:
                process.stdin.write(b"stop\n")
                await process.stdin.drain()
                await asyncio.wait_for(process.wait(), 10)
            except Exception:
                process.kill()
                await process.wait()
        if drain:
            await drain
        if server:
            await server.close()
        report["pageErrors"] = page_errors
        report["elapsedSeconds"] = round(time.monotonic() - started, 2)
        (target / "ui-host.txt").write_text("\n".join(logs), encoding="utf-8")
        (target / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--browser", default=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required: this uses the configured model on a disposable project")
    logger.remove()
    raise SystemExit(asyncio.run(main(args.output, args.browser)))
