"""Check hosted PPT controls with a caller-provided QA token; never call a model.

Read JSON from stdin: {"url":"https://mona-ai.cn/work/","token":"..."}.
Only --output and --browser are CLI options. Create one dedicated QA conversation
and a presentation through the real UI. The caller owns token revocation.
No credentials, browser storage, traces or raw WebSocket frames are written.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import re
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import quote, quote_plus, urlsplit
from uuid import uuid4

from playwright.async_api import async_playwright, expect

BASE = "/api/work/desktop"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--browser", type=Path, help="Existing Chromium/Edge executable; nothing is installed")
    args = parser.parse_args()
    credentials = json.loads(sys.stdin.read(65_537))
    token, target = credentials.get("token"), credentials.get("url")
    assert isinstance(token, str) and re.fullmatch(r"[\x21-\x7e]{1,8192}", token), "Invalid stdin token"
    assert isinstance(target, str) and len(target) <= 2048, "Invalid stdin URL"
    parts = urlsplit(target)
    assert (parts.scheme in {"http", "https"} and parts.hostname and not parts.username and not parts.password
            and not parts.query and not parts.fragment and parts.path in {"", "/", "/work", "/work/"}), "Invalid work URL"
    origin = f"{parts.scheme}://{parts.netloc}"
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    assert output.is_relative_to((root / "output/hosted-work").resolve()), "Output must stay below output/hosted-work"
    output.mkdir(parents=True, exist_ok=False)
    report = {"passed": False, "phase": "initializing", "origin": origin, "mocked_responses": False,
              "synthetic_auth": credentials.get("synthetic_auth") is True, "model_executed": False,
              "test_sessions": [], "control_checks": []}
    errors, failures, console_errors, blocked_models = [], [], [], []
    message_frames_sent = 0
    started = time.monotonic()

    def clean(value, limit=1200):
        text = str(value)
        for secret in (token, quote(token, safe=""), quote_plus(token, safe=""), json.dumps(token)[1:-1]):
            text = text.replace(secret, "[redacted]")
        text = re.sub(r"(?i)\bbearer\s+[^\s\"',;]+", "Bearer [redacted]", text)
        text = re.sub(r"(?i)\b(?:https?|wss?)://[^\s\"'<>`]+",
                      lambda match: re.split(r"[?#]", match.group(), maxsplit=1)[0], text)
        return text[:limit]

    def record(items, value):
        if len(items) < 30 and value not in items:
            items.append(value)

    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return clean(value, 1800) if isinstance(value, str) else value

    browser = page = playwright = None
    try:
        playwright = await async_playwright().start()
        edge = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
        executable = args.browser or (edge if edge.is_file() else None)
        browser = await playwright.chromium.launch(executable_path=str(executable) if executable else None,
                                                   headless=True)
        context = await browser.new_context(viewport={"width": 1800, "height": 1100}, locale="zh-CN")
        page = await context.new_page()
        page.set_default_timeout(20_000)
        headers = {"Authorization": "Bearer " + token, "Origin": origin}

        async def api(path, *, method="GET", body=None, office=False, expected=200, binary=False):
            extra = {"X-Mona-Session-Key": "websocket:" + sid} if office else {}
            response = await context.request.fetch(origin + path, method=method, headers={**headers, **extra}, data=body)
            assert response.status == expected, f"{method} {urlsplit(path).path}: HTTP {response.status}"
            return await response.body() if binary else await response.json()

        async def screenshot(name):
            await page.screenshot(path=str(output / name), mask=[page.get_by_text(token, exact=False),
                                                                 page.locator('input[type="password"]')])

        def websocket(connection):
            def sent(raw):
                nonlocal message_frames_sent
                try:
                    frame = json.loads(raw)
                except (ValueError, TypeError):
                    return
                if isinstance(frame, dict) and frame.get("type") == "message":
                    message_frames_sent += 1
            connection.on("framesent", sent)

        def console(message):
            if "MONA_OFFICE_CONTROLS_BLOCKED_MODEL" in message.text:
                record(blocked_models, {"transport": "websocket"})
            elif message.type == "error":
                record(console_errors, clean(message.text))

        def response_seen(response):
            path = urlsplit(response.url).path
            if response.status >= 400 and path.startswith(("/api/work/", "/work/assets/", "/work/office-editor/")):
                record(failures, {"path": path, "status": response.status})

        async def block_model(route):
            if route.request.method == "POST":
                record(blocked_models, {"transport": "http", "path": urlsplit(route.request.url).path})
                await route.abort()
            else:
                await route.continue_()

        page.on("websocket", websocket)
        page.on("pageerror", lambda error: record(errors, clean(error)))
        page.on("console", console)
        page.on("response", response_seen)
        await context.route(re.compile(r"/api/work/sessions/[a-f0-9]{32}/runs(?:\?|$)"), block_model)
        await context.add_init_script("""(() => {
            const original = WebSocket.prototype.send;
            WebSocket.prototype.send = function(data) {
                let frame; try { frame = JSON.parse(data); } catch {}
                if (frame?.type === 'message') {
                    console.warn('MONA_OFFICE_CONTROLS_BLOCKED_MODEL');
                    throw new Error('Office controls acceptance forbids model submission');
                }
                return original.call(this, data);
            };
        })();""")

        report["phase"] = "creating_qa_session"
        sid = uuid4().hex
        title = "PPT控件验收 " + uuid4().hex[:10]
        report["test_sessions"].append({"id": sid, "title": title})
        created = await api("/api/work/sessions", method="POST", body={"request_id": sid, "title": title}, expected=201)
        assert created.get("id") == sid, "QA conversation identity differs"
        await page.add_init_script("""(value => {
            if (window.top !== window || location.origin !== value.origin || !['/work','/work/'].includes(location.pathname)) return;
            sessionStorage.setItem('mona-hosted-work-v1', JSON.stringify({token:value.token, selected:value.sid}));
        })(%s);""" % json.dumps({"origin": origin, "token": token, "sid": sid}))
        await page.goto(origin + "/work/")
        await page.get_by_role("button", name="发送消息", exact=True).wait_for()
        await page.get_by_text(title, exact=True).first.wait_for()
        expand = page.get_by_role("button", name="展开工作区", exact=True)
        if await expand.is_visible():
            await expand.click()
        await page.get_by_role("button", name="新建标签页", exact=True).click()
        await page.get_by_role("menuitem", name="PPT", exact=True).click()

        async def hidden_controls(phase):
            frame = page.frame_locator('iframe[title="幻灯片编辑器"]:visible')
            await frame.locator(".mona-slides-editor").wait_for(state="visible", timeout=60_000)
            await expect(frame.locator(".slide-list")).to_be_visible(timeout=30_000)
            menus = frame.locator(".mona-stage-ai-menu")
            await expect(menus.first).to_be_attached(timeout=30_000)
            evidence = await menus.evaluate_all("nodes => nodes.map(node => ({display:getComputedStyle(node).display, text:node.textContent || ''}))")
            assert evidence and all(item["display"] == "none" for item in evidence), "Native AI menus are not hidden"
            assert any("AI编辑" in re.sub(r"\s+", "", item["text"]) for item in evidence), "Native AI edit control did not load"
            labels = frame.get_by_text(re.compile(r"^AI\s*编辑$"))
            assert await labels.count() > 0, "Native AI edit label is missing"
            for label in await labels.all():
                await expect(label).not_to_be_visible()
            await expect(frame.locator("#mona-hosted-slides-controls")).to_have_count(1)
            report["control_checks"].append({"phase": phase, "native_editor_loaded": True,
                "native_ai_menu_count": len(evidence), "computed_display": [item["display"] for item in evidence],
                "ai_edit_visible": False, "hosted_style_present": True})
            return frame

        report["phase"] = "native_editor_controls"
        frame = await hidden_controls("initial")
        sessions = (await api(BASE + "/api/office/sessions", office=True))["sessions"]
        presentations = [item for item in sessions if item.get("type") == "slides"]
        assert len(presentations) == 1, "The new QA conversation did not create exactly one presentation"
        state = presentations[0]
        office_id = state["sessionId"]
        report["office_session_id"] = office_id
        thumbs = frame.locator(".slide-list .thumb-num")
        add = frame.get_by_role("button", name="新建幻灯片", exact=True).first
        if not await add.is_visible():
            await frame.locator('[data-rbgroup="slides"]').get_by_role("button", name="幻灯片", exact=True).click()
        await expect(add).to_be_enabled()
        await expect(thumbs.first).to_be_visible()
        before = await thumbs.count()
        await add.click()
        await expect(thumbs).to_have_count(before + 1)
        await page.keyboard.press("Escape")
        report.update(native_slide_count_before=before, native_slide_count_after=before + 1, native_new_slide_clicks=1)

        report["phase"] = "saving_native_slide"
        save = page.get_by_role("button", name="保存", exact=True)
        await expect(save).to_be_enabled()
        save_path = BASE + "/api/office/sessions/" + office_id + "/save"
        async with page.expect_response(lambda response: urlsplit(response.url).path == save_path and response.request.method == "POST") as saving:
            await save.click()
        saved = await saving.value
        assert saved.status == 200 and (await saved.json()).get("ok") is True, "Native save was not acknowledged"
        saved_state = await api(BASE + "/api/office/sessions/" + office_id, office=True)
        assert saved_state.get("dirty") is False and saved_state.get("saveState") == "clean", "Presentation remains unsaved"
        raw = await api(BASE + "/api/office/sessions/" + office_id + "/file", office=True, binary=True)
        assert 1000 < len(raw) <= 32 * 1024 * 1024 and raw.startswith(b"PK"), "Saved work is not a PPTX"
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            slide_names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide[0-9]+\.xml", name)]
        assert len(slide_names) == before + 1, "Saved PPTX does not contain the native new slide"
        report["saved_work"] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "slides": len(slide_names)}
        await screenshot("native-slide-saved.png")

        report["phase"] = "refreshing_editor"
        await page.reload()
        await page.get_by_role("button", name="发送消息", exact=True).wait_for()
        expand = page.get_by_role("button", name="展开工作区", exact=True)
        if await expand.is_visible():
            await expand.click()
        await page.get_by_role("tab", name=state["displayName"], exact=True).click()
        frame = await hidden_controls("fresh_iframe_after_page_reload")
        await expect(frame.locator(".slide-list .thumb-num")).to_have_count(before + 1)
        report["refresh_preserves_native_slide_and_hidden_controls"] = True
        await screenshot("native-slide-refreshed.png")
        assert not (await api("/api/work/sessions/" + sid))["runs"], "A model run was unexpectedly created"
        assert not message_frames_sent and not blocked_models, "Unexpected model submission attempt"
        assert not errors and not failures, "Browser errors or failed work requests occurred"
        report.update(passed=True, phase="completed")
        await browser.close()
        browser = None
    except Exception as error:
        report.update(error_type=type(error).__name__, error=clean(error))
        if page is not None and not page.is_closed():
            try:
                await screenshot("failure.png")
            except Exception:
                report["failure_screenshot_unavailable"] = True
    finally:
        if browser is not None:
            await browser.close()
        if playwright is not None:
            await playwright.stop()
        report.update(elapsed_seconds=round(time.monotonic() - started, 1), page_errors=errors,
                      failed_requests=failures, console_errors=console_errors,
                      blocked_model_requests=blocked_models, model_message_frames_sent=message_frames_sent)
        safe_report = scrub(report)
        (output / "acceptance.json").write_text(json.dumps(safe_report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(safe_report, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
