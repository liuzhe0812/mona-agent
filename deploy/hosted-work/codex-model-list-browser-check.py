"""Read-only browser check for compact Codex model controls."""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import runpy
from pathlib import Path

import httpx
from playwright.async_api import async_playwright, expect

helpers = runpy.run_path(str(Path(__file__).with_name("automatic-models-browser-check.py")))
Guard, require, CheckError = (helpers[name] for name in ("Guard", "require", "CheckError"))
MODEL_PATH, CODEX_PATH = "/api/work/admin/models", "/api/work/admin/codex"


async def check(target: str, tokens: dict, report: dict, screenshot: Path) -> None:
    headers = {"Authorization": "Bearer " + tokens["admin_token"], "Origin": "https://mona-ai.cn"}
    async with httpx.AsyncClient(timeout=20, trust_env=False, follow_redirects=False) as client:
        responses = [await client.get("https://mona-ai.cn" + path, headers=headers) for path in (MODEL_PATH, CODEX_PATH)]
        require(all(response.status_code == 200 for response in responses), "admin_snapshot_unavailable")
        settings, codex = [response.json() for response in responses]
        require(settings.get("revision") == codex.get("revision"), "configuration_changed")
        rows = settings.get("models", [])
        selected = next((row for row in rows if row.get("id") == "qwen"), None)
        require(isinstance(selected, dict) and isinstance(selected.get("configuration"), dict), "model_unavailable")
        config = selected["configuration"]
        vendor = {"api_base": config["api_base"], "api_key_env": config["api_key_env"]}
        catalog = codex.get("connection", {}).get("models", [])
        require(isinstance(catalog, list) and len(catalog) > 0, "codex_catalog_unavailable")
        existing = {row["configuration"]["model"] for row in rows if row.get("configuration", {}).get("source") == "codex"}
        item = next((item for item in catalog if item.get("id") not in existing), catalog[0])
        name = item["label"] if item["id"] not in existing else next(
            row["configuration"]["label"] for row in rows if row.get("configuration", {}).get("source") == "codex"
            and row["configuration"].get("model") == item["id"])
    guard, errors = Guard(tokens, vendor), []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN", service_workers="block")
            await context.add_init_script("if(location.origin==='https://mona-ai.cn' && window===window.top)sessionStorage.setItem('admin_token'," + json.dumps(tokens["admin_token"]) + ");")
            await context.route("**/*", guard.route)
            await context.route_web_socket("**/*", lambda socket: socket.close())
            page = await context.new_page()
            page.set_default_timeout(25000)
            page.on("pageerror", lambda _error: errors.append("pageerror"))
            response = await page.goto(target, wait_until="domcontentloaded")
            require(response is not None and response.status == 200, "page_unavailable")
            await expect(page.get_by_role("heading", name="工作台模型与计费", exact=True)).to_be_visible()
            await page.get_by_role("button", name="Codex CLI", exact=True).click()
            for text in ("CLI 程序路径", "已检测到 Codex CLI", "使用检测到的路径", "Ubuntu 登录说明",
                         "Codex CLI 执行接入尚未完成", "检测已完成，请查看连接状态和模型列表。"):
                require(await page.get_by_text(text, exact=False).count() == 0, "unnecessary_detail_visible")
            await expect(page.get_by_role("button", name="检测连接", exact=True)).to_be_visible()
            groups = page.get_by_role("group", name=re.compile(r"^模型 "))
            await expect(groups.first).to_be_visible(timeout=25000)
            require(await groups.count() >= len(catalog), "catalog_not_displayed")
            await groups.first.scroll_into_view_if_needed()
            await page.screenshot(path=str(screenshot))
            row = page.get_by_role("group", name="模型 " + name, exact=True)
            await expect(row).to_be_visible()
            height = (await row.bounding_box())["height"]
            require(height <= 100, "model_row_too_tall")
            await row.get_by_role("button", name="设置 " + name, exact=True).click()
            dialog = page.get_by_role("dialog", name="设置 " + name, exact=True)
            await expect(dialog).to_be_visible()
            for field in ("输入价格", "缓存输入价格", "输出价格"):
                await expect(dialog.get_by_label(field, exact=True)).to_be_visible()
            await dialog.get_by_role("button", name="取消", exact=True).click()
            await expect(dialog).to_have_count(0)
            report["checks"].update(compact_rows=True, settings_open_and_cancel=True, unnecessary_details_removed=True)
            if item["id"] not in existing:
                await row.get_by_role("switch", name="开放 " + name, exact=True).click()
                await expect(dialog).to_be_visible()
                await dialog.get_by_role("button", name="取消", exact=True).click()
                await expect(dialog).to_have_count(0)
                report["checks"]["new_model_open_requires_settings"] = True
            current = await helpers["api"](page, MODEL_PATH, tokens["admin_token"])
            require(current["status"] == 200 and current["value"].get("revision") == settings["revision"], "configuration_changed")
            require(not errors and guard.blocked_writes == 0 and guard.blocked_external == 0
                    and guard.forbidden_price_requests == 0, "unexpected_browser_activity")
            report.update(passed=True, safe={"model_count": len(catalog), "row_height": height,
                                           "configuration_writes": 0, "model_tasks": 0})
            await context.close()
        finally:
            await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Check deployed compact Codex model controls")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    base = helpers["helpers"]["helpers"]
    target = base["report_path"](args.output)
    report = {"production": True, "mocked_responses": False, "passed": False, "checks": {}}
    try:
        asyncio.run(check(base["target_url"](args.url), base["read_tokens"](), report, target.parent / "model-list.png"))
    except CheckError as exc:
        report["error"] = str(exc)
    except Exception as exc:
        report["error"] = "check_failed"
        report["error_type"] = type(exc).__name__
    finally:
        with target.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
