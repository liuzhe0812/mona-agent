"""Render actual model-source components with explicitly synthetic UI data.

No login, vendor request, local credentials, CLI execution or user project edits.
"""
import argparse
import asyncio
import json
import shutil
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


async def verify(output: str):
    target = (ROOT / output).resolve()
    if not target.is_relative_to(ROOT / "output") or target.exists():
        raise ValueError("Use a new output directory")
    target.mkdir(parents=True)
    process = await asyncio.create_subprocess_exec(shutil.which("node"), str(ROOT / "webui/scripts/model-sources-smoke.mjs"),
        cwd=ROOT / "webui", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    report = {"scope": "Production React components; synthetic source/model/account data, no real authentication or model task", "checks": {}, "errors": []}
    logs = []
    drain = None
    try:
        async def ready():
            while line := await process.stdout.readline():
                text = line.decode("utf8", "replace").strip()
                logs.append(text)
                if text.startswith("SMOKE_URL "):
                    return text[10:]
            raise RuntimeError("UI host exited")
        url = await asyncio.wait_for(ready(), 50)
        async def read_logs():
            while line := await process.stdout.readline():
                logs.append(line.decode("utf8", "replace")[:2000])
                if len(logs) > 100:
                    del logs[:50]
        drain = asyncio.create_task(read_logs())
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
            try:
                page = await browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
                page.on("pageerror", lambda error: report["errors"].append(str(error)))
                await page.route("**/*", lambda route: route.continue_() if route.request.url.startswith("http://127.0.0.1:") else route.abort())
                await page.goto(url, wait_until="networkidle", timeout=90000)
                rail = page.get_by_role("complementary")
                await rail.get_by_role("button").filter(has_text="OpenAI").click()
                await page.get_by_text("检测到本机 Codex", exact=True).wait_for()
                report["checks"]["source_categories"] = all([await rail.get_by_role("button").filter(has_text=name).count() == 1 for name in ["Mona AI", "OpenAI", "Anthropic", "团队模型服务"]])
                await page.screenshot(path=str(target / "01-provider-settings.png"))
                report["checks"]["clean_rows_by_default"] = await page.get_by_role("button", name="GPT-4.1 模型类型", exact=True).count() == 0
                await page.evaluate("document.documentElement.classList.add('dark')")
                await page.screenshot(path=str(target / "01b-provider-settings-dark.png"))
                await page.evaluate("document.documentElement.classList.remove('dark')")
                await page.get_by_role("button", name="连接 ChatGPT", exact=True).click()
                await page.get_by_role("dialog").wait_for()
                report["checks"]["source_connection_dialog"] = await page.get_by_role("dialog").get_by_role("button", name="改用 API Key 接入").count() == 1
                await page.screenshot(path=str(target / "02-provider-connect.png"))
                await page.get_by_role("dialog").get_by_role("button", name="改用 API Key 接入").click()
                await expect(page.get_by_role("dialog").get_by_label("API Key", exact=True)).to_be_visible()
                await page.screenshot(path=str(target / "02b-provider-api-key.png"))
                await page.keyboard.press("Escape")
                await page.get_by_role("button", name="模型选择器", exact=True).click()
                await page.get_by_role("button", name="GPT-4.1", exact=True).click()
                await expect(page.get_by_role("textbox", name="搜索模型", exact=True)).to_be_focused()
                await page.mouse.move(2, 2)
                await page.screenshot(path=str(target / "03-model-selector.png"))
                await page.get_by_role("tab", name="团队模型服务", exact=True).click()
                report["checks"]["custom_source_filter"] = await page.get_by_role("menuitem", name="团队模型服务 · 团队 · 编程模型", exact=True).count() == 1 and await page.get_by_role("menuitem", name="OpenAI · GPT-4.1", exact=True).count() == 0
                search = page.get_by_role("textbox", name="搜索模型", exact=True)
                await search.fill("编程模型")
                await search.press("ArrowDown")
                choice = page.get_by_role("menuitem", name="团队模型服务 · 团队 · 编程模型", exact=True)
                await expect(choice).to_be_focused()
                await choice.press("Enter")
                report["checks"]["search_keyboard_selection"] = True
                await page.get_by_role("button", name="团队 · 编程模型", exact=True).wait_for()
                report["checks"]["selection_updates_trigger"] = await page.get_by_role("button", name="团队 · 编程模型", exact=True).count() == 1
                await page.get_by_role("button", name="团队 · 编程模型", exact=True).click()
                await page.get_by_role("tab", name="全部模型", exact=True).click()
                await page.evaluate("document.documentElement.classList.add('dark')")
                await page.mouse.move(2, 2)
                await page.screenshot(path=str(target / "04-model-selector-dark.png"))
                await page.set_viewport_size({"width": 920, "height": 820})
                await page.screenshot(path=str(target / "05-model-selector-compact.png"))
                bounds = await page.get_by_role("menu").first.bounding_box()
                report["checks"]["popup_fits_compact_viewport"] = bool(bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 921 and bounds["y"] >= 0 and bounds["y"] + bounds["height"] <= 821)
                await page.get_by_role("textbox", name="搜索模型", exact=True).fill("不存在的模型")
                report["checks"]["search_empty_state"] = await page.get_by_text("暂无可选择的模型").count() == 1
                report["checks"]["no_page_errors"] = not report["errors"]
            finally:
                await browser.close()
    except Exception as error:
        report["failure"] = str(error)[:2000]
        raise
    finally:
        report["status"] = "passed" if report["checks"] and all(report["checks"].values()) and not report.get("failure") else "failed"
        (target / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
        if process.returncode is None:
            process.stdin.write(b"stop\n")
            await process.stdin.drain()
            try:
                await asyncio.wait_for(process.wait(), 15)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        if drain:
            await drain
        (target / "ui-host.log").write_text("\n".join(logs), encoding="utf8")
        print(json.dumps(report, ensure_ascii=False))
    assert report["status"] == "passed"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    asyncio.run(verify(args.output))
