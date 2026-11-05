"""Real hosted Skill/UI acceptance; short-lived website credentials enter on stdin only."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from uuid import uuid4

from playwright.async_api import async_playwright, expect

ORIGIN = "https://mona-ai.cn"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-discovery", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    assert output.is_relative_to(root / "output/hosted-work")
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(sys.stdin.read(65537))
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "start"}
    errors, failures, sent = [], [], []
    closing = False
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1560, "height": 1000}, locale="zh-CN", accept_downloads=True)
            page = await context.new_page()
            page.set_default_timeout(30000)
            await page.goto(ORIGIN + "/")
            await page.evaluate("token=>{sessionStorage.setItem('mona-website-session-v1',JSON.stringify({token,user:{id:'30'}}));localStorage.setItem('mona.locale','zh')}", credentials["token"])
            page.on("pageerror", lambda error: errors.append(str(error)[:500]))
            page.on("response", lambda response: failures.append({"path": response.url.split("?", 1)[0].removeprefix(ORIGIN), "status": response.status})
                    if response.url.startswith(ORIGIN) and response.status >= 400 and not (closing and response.status == 401) else None)
            def socket_created(socket):
                def frame(payload):
                    try:
                        if json.loads(payload).get("type") == "message":
                            sent.append(True)
                    except (ValueError, TypeError):
                        pass
                socket.on("framesent", frame)
            page.on("websocket", socket_created)
            headers = {"Authorization": "Bearer " + credentials["token"], "Origin": ORIGIN}
            async def api(path, method="get", data=None):
                response = await context.request.fetch(ORIGIN + path, method=method, headers=headers, data=data)
                assert response.ok, f"{path.split('?')[0]} returned {response.status}"
                return await response.json()
            async def sid():
                return await page.evaluate("()=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected")
            async def task(prompt):
                previous = {r["id"] for r in (await api("/api/work/sessions/" + await sid()))["runs"]}
                await page.locator("textarea").fill(prompt)
                await page.get_by_role("button", name="发送消息", exact=True).click()
                async with asyncio.timeout(240):
                    while True:
                        detail = await api("/api/work/sessions/" + await sid())
                        run = next((r for r in detail["runs"] if r["id"] not in previous), None)
                        if run:
                            report["current_run"] = run["id"]
                            if run["status"] not in {"running", "cancelling"}:
                                assert run["status"] == "completed" and run["result"].get("workspace_saved") is True
                                await expect(page.get_by_role("button", name="发送消息", exact=True)).to_be_visible()
                                report.setdefault("completed_runs", []).append(run["id"])
                                return detail
                        await asyncio.sleep(0.5)

            await page.goto(ORIGIN + "/work/")
            await page.locator("textarea").wait_for()
            previous_sid = await sid()
            await page.get_by_role("button", name="新建会话", exact=True).click()
            await page.wait_for_function("old=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected!==old", arg=previous_sid)
            await page.locator("textarea").wait_for()
            report["session_id"] = await sid()
            await expect(page.get_by_test_id("mona-welcome-shell")).to_be_visible()
            assert not await page.get_by_text(re.compile("^(今日焦点|继续工作|今天暂无安排|连接主机|连接数据库|新建笔记)$")).count()
            assert not await page.locator(".mona-composer-peek,[data-testid='hero-composer-prelude']").count()
            assert not await page.get_by_role("button", name="退出登录", exact=True).count()
            assert not sent
            report["red_box_sections_removed"] = True
            await page.screenshot(path=str(output / "empty-workspace.png"))

            report["phase"] = "skill_discovery"
            if args.skip_discovery:
                prior = json.loads((output.parent / "production-v1.json").read_text(encoding="utf-8"))
                assert prior["skill_task_completes"] and prior["red_box_sections_removed"]
                report["discovery_evidence"] = "production-v1.json"
            else:
                await task("验收：调用 skill_list 列出内置技能，再用 skill_read 读取 mona-xlsx，并用 skill_reference_read 读取 office-example.md。只说明实际能力和缺少的依赖，不修改文件。")
                report["skill_task_completes"] = True
            report["phase"] = "interactive_widget"
            marker = "MONA_WIDGET_" + uuid4().hex
            await task("读取 mona-visualizer 及 core.md、colors.md 参考，然后实际调用 show_widget 创建 HTML 计数器。标题必须为 " + marker
                       + "。数字用 <output id='count'>0</output>，按钮文字为“加一”，点击后数字增加。只使用片段，不新建文档；要真正显示图形，不只回复代码。")
            frame = page.frame_locator(f'iframe[title="{marker}"]')
            await expect(frame.locator("#count")).to_have_text("0")
            await frame.get_by_role("button", name="加一", exact=True).click()
            await expect(frame.locator("#count")).to_have_text("1")
            report["real_interactive_widget"] = True
            count = len(sent)
            await page.reload()
            await frame.get_by_role("button", name="加一", exact=True).wait_for()
            assert len(sent) == count and await page.locator(f'iframe[title="{marker}"]').count() == 1
            await frame.get_by_role("button", name="加一", exact=True).click()
            await expect(frame.locator("#count")).to_have_text("1")
            report["widget_restore_without_model_replay"] = True
            await page.screenshot(path=str(output / "skill-widget.png"))

            report["phase"] = "skill_asset"
            filename = "skill-resource-" + uuid4().hex + ".json"
            detail = await task("读取 mona-canvas，然后实际用 skill_asset_copy 将它的 transformer-official-demo.patch.json 素材复制到 /workspace/" + filename
                                + "，并调用 deliver_file 交付该文件。保持素材原始字节，不创建替代内容。")
            file = next(item for item in detail["files"] if item["name"] == filename)
            response = await context.request.get(ORIGIN + "/api/work/sessions/" + await sid() + "/files/" + file["id"], headers=headers)
            assert response.ok
            raw = await response.body()
            expected = hashlib.sha256((root / "mona/skills/mona-canvas/assets/transformer-official-demo.patch.json").read_bytes()).hexdigest()
            assert hashlib.sha256(raw).hexdigest() == file["sha256"] == expected
            report["skill_asset_actual_sha256"] = expected
            denied = await context.request.get(ORIGIN + "/api/work/sessions/" + await sid(), headers={"Authorization": "Bearer " + credentials["other_token"], "Origin": ORIGIN})
            assert denied.status == 404
            report["other_account_denied"] = True
            closing = True
            await api("/api/work/auth/logout", "post", {})
            await page.reload()
            await page.get_by_role("button", name="知道了", exact=True).click()
            await page.get_by_role("button", name="登录并开始", exact=True).wait_for()
            assert not await page.locator("iframe").count()
            assert not errors and not failures
            report.update(passed=True, phase="complete", message_frames=len(sent), page_errors=errors, failed_requests=failures,
                          logout_api_preserved=True, unauthorized_clears_private_view=True)
        except Exception as error:
            message = str(error)
            for key in ("token", "other_token"):
                message = message.replace(credentials[key], "[redacted]")
            report.update(error=message[:1800], error_type=type(error).__name__, page_errors=errors, failed_requests=failures)
            if "page" in locals():
                await page.screenshot(path=str(output / "failure.png"))
        finally:
            await browser.close()
            (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
