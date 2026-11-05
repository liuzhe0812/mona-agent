"""Real administrator UI acceptance; short-lived credentials arrive on stdin only."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright, expect

ORIGIN = "https://mona-ai.cn"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    assert output.is_relative_to(Path(__file__).resolve().parents[2] / "output/hosted-work")
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(sys.stdin.read(65537))
    report = {"passed": False, "production": True, "mocked_responses": False, "model_task_sent": False}
    errors = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 1100}, locale="zh-CN")
        page = await context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)[:300]))
        saved = False
        original = None
        headers = {"Authorization": "Bearer " + credentials["other_token"], "Origin": ORIGIN}
        async def get_status():
            response = await context.request.get(ORIGIN + "/api/work/admin/codex", headers=headers)
            assert response.status == 200
            return await response.json()
        try:
            await page.goto(ORIGIN + "/work/admin/")
            await expect(page.get_by_role("link", name="前往管理员登录", exact=True)).to_be_visible()
            report["anonymous_ui"] = True
            anonymous = await context.request.get(ORIGIN + "/api/work/admin/codex")
            assert anonymous.status == 401
            report["anonymous_api"] = 401

            await page.evaluate("token=>sessionStorage.setItem('mona-website-session-v1',JSON.stringify({token,user:{id:'30'}}))", credentials["token"])
            await page.reload()
            await expect(page.get_by_role("dialog")).to_contain_text("没有管理权限")
            assert await page.evaluate("!!sessionStorage.getItem('mona-website-session-v1')")
            report["ordinary_account_denied"] = True
            await page.evaluate("token=>{sessionStorage.removeItem('mona-website-session-v1');sessionStorage.setItem('admin_token',token)}", credentials["other_token"])
            await page.reload()
            await expect(page.get_by_text("所有账号免费，不扣余额。", exact=True)).to_be_visible()
            await expect(page.get_by_text("余额计费尚未接通，Codex 未向用户开放。", exact=True)).to_be_visible()
            original = await get_status()
            assert not original["public_enabled"] and not original["billing"]["ready"]
            # Change only a harmless label, verify reload, then restore through the same UI/API contract.
            label = original["configuration"]["label"]
            await page.get_by_label("显示名称", exact=True).fill("Codex 配置验收")
            await page.get_by_role("button", name="保存配置", exact=True).click()
            await expect(page.get_by_role("status")).to_contain_text("配置已保存")
            saved = True
            await page.reload()
            await expect(page.get_by_label("显示名称", exact=True)).to_have_value("Codex 配置验收")
            report["save_and_reload"] = True
            stale = await context.request.put(ORIGIN + "/api/work/admin/codex", headers=headers,
                data={"expected_revision": original["revision"], "configuration": original["configuration"]})
            assert stale.status == 409
            report["stale_revision"] = 409
            await page.get_by_label("显示名称", exact=True).fill(label)
            await page.get_by_role("button", name="保存配置", exact=True).click()
            await expect(page.get_by_role("status")).to_contain_text("配置已保存")
            saved = False
            restored = await get_status()
            assert restored["configuration"] == original["configuration"]
            await page.get_by_text("Ubuntu 登录说明", exact=True).click()
            await expect(page.locator("pre")).to_contain_text("mona.hosted_work.admin")
            assert not await page.get_by_role("button", name="启用", exact=True).count()
            report["login_instructions_and_no_unbilled_switch"] = True
            await page.screenshot(path=str(output / "admin-config.png"), full_page=True)
            model_response = await context.request.get(ORIGIN + "/api/work/models",
                headers={"Authorization": "Bearer " + credentials["token"], "Origin": ORIGIN})
            assert model_response.status == 200
            public = (await model_response.json())["models"]
            assert public and all(model["source"] != "codex" for model in public)
            report["public_models"] = public
            report["page_errors"] = errors
            assert not errors
            report["passed"] = True
        finally:
            if saved and original is not None:
                current = await get_status()
                # Do not overwrite an intervening operator change.
                if current["configuration"] == {**original["configuration"], "label": "Codex 配置验收"}:
                    restored = await context.request.put(ORIGIN + "/api/work/admin/codex", headers=headers,
                        data={"expected_revision": current["revision"], "configuration": original["configuration"]})
                    report["failure_cleanup_restored"] = restored.status == 200
            await browser.close()
            (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))


if __name__ == "__main__":
    asyncio.run(main())
