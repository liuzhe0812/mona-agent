"""Real public acceptance for the shared desktop UI. Sessions enter only on stdin."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from urllib.parse import quote, quote_plus, urlsplit, urlunsplit
from uuid import uuid4

from playwright.async_api import async_playwright, expect

ORIGIN = "https://mona-ai.cn"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    assert output.is_relative_to((root / "output/hosted-work").resolve())
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(sys.stdin.read(65537))
    assert all(isinstance(credentials.get(key), str) and re.fullmatch(r"[\x21-\x7e]{1,8192}", credentials[key])
               for key in ("token", "other_token"))
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "start"}
    page_errors, failures, request_failures, console_errors = [], [], [], []

    def sanitize(value, limit=500):
        text = str(value)
        for key in ("token", "other_token"):
            secret = credentials[key]
            for encoded in (secret, quote(secret, safe=""), quote_plus(secret, safe=""), json.dumps(secret)[1:-1]):
                text = text.replace(encoded, "[redacted]")
        text = re.sub(r"(?i)\b(?:https?|wss?)://[^\s\"'<>`]+",
                      lambda match: re.split(r"[?#]", match.group(), maxsplit=1)[0], text)
        text = re.sub(r"(/[^\s\"'<>?]+)\?[^\s\"'<>]*", r"\1", text)
        text = re.sub(r"(?i)\bbearer\s+[^\s\"',;]+", "Bearer [redacted]", text)
        text = re.sub(r"(?i)(\b(?:access[_-]?token|refresh[_-]?token|token|ticket|secret|api[_-]?key|password|authorization)\b[\"']?\s*[:=]\s*[\"']?)[^\s\"',;&}\]]+",
                      r"\1[redacted]", text)
        return text[:limit]

    def clean_url(value, *, path_only=False):
        try:
            parts = urlsplit(value)
            value = parts.path if path_only else urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, "", ""))
        except ValueError:
            value = "[invalid URL]"
        return sanitize(value)

    def record(items, value):
        if len(items) < 100:
            items.append(value)

    async def frame_diagnostics(page):
        async def inspect(frame):
            value = {"url": clean_url(frame.url)}
            try:
                data = await asyncio.wait_for(frame.evaluate("""() => {
                    const style = (selector) => {
                        const node = document.querySelector(selector);
                        if (!node) return null;
                        const value = getComputedStyle(node);
                        return { display: value.display, font: value.font, fontFamily: value.fontFamily, fontSize: value.fontSize };
                    };
                    return {
                        readyState: document.readyState,
                        bodyClass: document.body?.className ?? null,
                        roots: {
                            docs: style('.mona-docs-editor'),
                            sheets: style('.mona-sheets-editor'),
                            slides: style('.mona-slides-editor'),
                        },
                        app: style('.app'),
                        ribbonTabs: style('.ribbon-tabs'),
                        stylesheets: Array.from(document.styleSheets).slice(0, 50).map(sheet => ({
                            href: sheet.href, disabled: sheet.disabled, media: sheet.media.mediaText,
                        })),
                    };
                }"""), timeout=2)
                value["readyState"] = sanitize(data["readyState"])
                value["bodyClass"] = sanitize(data["bodyClass"]) if data["bodyClass"] is not None else None
                def clean_style(style):
                    return {key: sanitize(item) for key, item in style.items()} if style else None
                value["roots"] = {key: clean_style(style) for key, style in data["roots"].items()}
                value["app"] = clean_style(data["app"])
                value["ribbonTabs"] = clean_style(data["ribbonTabs"])
                value["stylesheets"] = [{"href": clean_url(sheet["href"]) if sheet["href"] else None,
                                         "disabled": bool(sheet["disabled"]), "media": sanitize(sheet["media"])}
                                        for sheet in data["stylesheets"]]
            except Exception as error:
                value["inspection_error_type"] = type(error).__name__
            return value

        frames = [frame for frame in page.frames if frame != page.main_frame]
        return {"frames": await asyncio.gather(*(inspect(frame) for frame in frames[:25])),
                "omitted_frames": max(0, len(frames) - 25)}

    browser = None
    async with async_playwright() as playwright:
        try:
            browser = await playwright.chromium.launch(executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
            context = await browser.new_context(viewport={"width": 1560, "height": 1000}, locale="zh-CN", accept_downloads=True)
            async def seed(ctx, token):
                await ctx.add_init_script("sessionStorage.setItem('mona-website-session-v1'," + json.dumps(json.dumps({"token": token, "user": {"id": "30"}}))
                                          + ");localStorage.setItem('mona.locale','zh');")
            await seed(context, credentials["token"])
            page = await context.new_page()
            page.set_default_timeout(25000)
            sent, offices = [], []
            closing = [False]
            def socket_created(socket):
                assert all(credentials[key] not in socket.url for key in ("token", "other_token"))
                def frame(payload):
                    try:
                        value = json.loads(payload)
                        if value.get("type") == "message":
                            sent.append({key: value.get(key) for key in ("chat_id", "input_id")})
                    except (ValueError, TypeError):
                        pass
                socket.on("framesent", frame)
            page.on("websocket", socket_created)
            page.on("pageerror", lambda error: record(page_errors, sanitize(error)))
            page.on("console", lambda message: record(console_errors, sanitize(message.text)) if message.type == "error" else None)
            page.on("requestfailed", lambda request: record(request_failures, {"path": clean_url(request.url, path_only=True),
                                                                                "failure": sanitize(request.failure or "unknown")}))
            async def failed_response(response):
                if not response.url.startswith(ORIGIN) or response.status < 400 or (closing[0] and response.status == 401):
                    return
                item = {"path": clean_url(response.url, path_only=True), "status": response.status}
                record(failures, item)
                if "/office/" in item["path"]:
                    try:
                        body = await asyncio.wait_for(response.json(), timeout=2)
                        item["error"] = sanitize(json.dumps(body.get("error", {}), ensure_ascii=False), 1800)
                        if item["path"].endswith("/engine/range"):
                            payload = response.request.post_data_json
                            item["range_request"] = {key: payload.get(key) for key in ("sheetId", "range")}
                    except Exception:
                        pass
            page.on("response", failed_response)
            headers = {"Authorization": "Bearer " + credentials["token"], "Origin": ORIGIN}
            async def api(path, *, method="get", data=None, account_headers=None):
                response = await context.request.fetch(ORIGIN + path, method=method,
                    headers=account_headers or headers, data=data)
                if not response.ok:
                    body = await response.json()
                    raise AssertionError(f"API {path.split('?')[0]} returned {response.status}: " + sanitize(json.dumps(body), 1200))
                return None if response.status == 204 else await response.json()
            async def sid():
                value = await page.evaluate("JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected")
                assert isinstance(value, str) and re.fullmatch(r"[a-f0-9]{32}", value)
                return value
            async def detail():
                return await api("/api/work/sessions/" + await sid())
            async def begin(prompt):
                old = {run["id"] for run in (await detail())["runs"]}
                await page.locator("textarea").fill(prompt)
                await page.get_by_role("button", name="发送消息", exact=True).click()
                async with asyncio.timeout(40):
                    while True:
                        value = await detail()
                        new = [run for run in value["runs"] if run["id"] not in old]
                        if new:
                            report["current_run"] = new[-1]["id"]
                            return new[-1]["id"]
                        await asyncio.sleep(0.5)
            async def finish(rid):
                async with asyncio.timeout(240):
                    while True:
                        value = await detail()
                        run = next(run for run in value["runs"] if run["id"] == rid)
                        if run["status"] not in {"running", "cancelling"}:
                            assert run["status"] == "completed", "Task finished as " + run["status"]
                            assert run["result"].get("workspace_saved") is True
                            await expect(page.get_by_role("button", name="发送消息", exact=True)).to_be_visible()
                            return run, value
                        await asyncio.sleep(1)
            async def new_office(label, frame_title):
                await page.get_by_role("button", name="新建标签页", exact=True).click()
                async with page.expect_response(lambda response: response.url == ORIGIN + "/api/work/desktop/api/office/sessions" and response.request.method == "POST") as created:
                    await page.get_by_role("menuitem", name=label, exact=True).click()
                response = await created.value
                assert response.status == 201
                state = await response.json()
                offices.append(state["sessionId"])
                report["office_sessions"] = list(offices)
                frame = page.frame_locator(f'iframe[title="{frame_title}"]:visible')
                await frame.locator("body").wait_for()
                await expect(page.get_by_role("button", name="导出", exact=True)).to_be_enabled(timeout=60000)
                await expect(frame.locator(".ribbon-tabs").first).to_have_css("display", "flex")
                return frame, state
            async def export(name):
                async with page.expect_download(timeout=60000) as download:
                    await page.get_by_role("button", name="导出", exact=True).click()
                result = await download.value
                assert not await result.failure()
                target = output / name
                await result.save_as(str(target))
                return target

            report["phase"] = "shared_ui_and_model"
            await page.goto(ORIGIN + "/work/")
            await page.locator("textarea").wait_for()
            assert await page.evaluate("JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).token") == credentials["token"]
            report["website_shared_session"] = True
            if credentials.get("resume_session") and await sid() != credentials["resume_session"]:
                await page.evaluate("selected=>{const key='mona-hosted-work-v1';const value=JSON.parse(sessionStorage.getItem(key));sessionStorage.setItem(key,JSON.stringify({...value,selected}));}", credentials["resume_session"])
                await page.reload()
                await page.locator("textarea").wait_for()
            if credentials.get("resume_session"):
                value = await detail()
                source_file = next(file for file in value["files"] if file["name"] == "online-input.txt")
                response = await context.request.get(ORIGIN + "/api/work/sessions/" + await sid() + "/files/" + source_file["id"], headers=headers)
                assert response.ok
                nonce = (await response.body()).decode()
                assert re.fullmatch(r"MONA_PUBLIC_[a-f0-9]{32}", nonce)
                filename = next(file["name"] for file in value["files"] if file["name"].startswith("shared-online-"))
                run = next(run for run in value["runs"] if filename in run["input"]["text"])
                assert run["status"] == "completed"
                rid = run["id"]
                report["observed_original_task"] = True
            else:
                previous_sid = await sid()
                await page.get_by_role("button", name="新建会话", exact=True).click()
                await page.wait_for_function("old=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected!==old", arg=previous_sid)
                await page.locator("textarea").wait_for()
                nonce = "MONA_PUBLIC_" + uuid4().hex
                source = output / "online-input.txt"
                source.write_text(nonce, encoding="utf-8")
                await page.locator('input[type="file"]').set_input_files(str(source))
                await expect(page.get_by_text("online-input.txt", exact=True).first).to_be_visible()
                filename = "shared-online-" + uuid4().hex + ".txt"
                rid = await begin(f"上线验收：读取刚上传的 online-input.txt（以实际附件路径为准），将原文加换行及 PUBLIC_OK 写入 /workspace/{filename}，调用 deliver_file 交付该文件。不要只输出说明。")
                run, value = await finish(rid)
            report["session_id"] = await sid()
            file = next(item for item in value["files"] if item["name"] == filename)
            if await page.get_by_role("button", name="展开工作区", exact=True).count():
                await page.get_by_role("button", name="展开工作区", exact=True).click()
            await page.get_by_role("button", name="概览", exact=True).click()
            await page.get_by_role("button", name=re.compile(re.escape(filename))).last.click(button="right")
            async with page.expect_download() as download:
                await page.get_by_role("menuitem", name="下载文件", exact=True).click()
            downloaded = output / "model-result.txt"
            await (await download.value).save_as(str(downloaded))
            actual = downloaded.read_bytes()
            assert actual.splitlines() == [nonce.encode(), b"PUBLIC_OK"]
            assert hashlib.sha256(actual).hexdigest() == file["sha256"]
            count = len(sent)
            await page.reload()
            await page.locator("textarea").wait_for()
            await asyncio.sleep(2)
            assert len(sent) == count and len((await detail())["runs"]) == len(value["runs"])
            report.update(model_run=rid, session_id=await sid(), real_model=True, file_download_sha256=file["sha256"], refresh_no_replay=True,
                          usage=run["result"].get("usage"))

            report["phase"] = "word"
            report["model_session_id"] = await sid()
            previous_sid = await sid()
            await page.get_by_role("button", name="新建会话", exact=True).click()
            await page.wait_for_function("old=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected!==old", arg=previous_sid)
            await page.locator("textarea").wait_for()
            report["session_id"] = await sid()
            report["phase"] = "identity_and_completion"
            who, _ = await finish(await begin("你是谁？"))
            identity = who["result"].get("content", "")
            assert "mona" in identity.lower()
            assert not any(word in identity for word in ("助手", "在线", "Work", "隔离"))
            report["mona_identity_reply"] = identity[:600]
            report["reply_completes_in_ui"] = True
            report["phase"] = "word"
            if await page.get_by_role("button", name="展开工作区", exact=True).count():
                await page.get_by_role("button", name="展开工作区", exact=True).click()
            frame, state = await new_office("Word", "文档编辑器")
            marker = "MONA_WORD_" + uuid4().hex
            await frame.locator('.doc-page[contenteditable="true"]').first.fill(marker)
            await page.get_by_role("button", name="保存", exact=True).click()
            await expect(page.get_by_text("已保存", exact=True)).to_be_visible()
            inspection = await api("/api/work/desktop/api/office/sessions/" + state["sessionId"] + "/inspect", method="post",
                account_headers={**headers, "X-Mona-Session-Key": "websocket:" + await sid()},
                data={"sessionId": state["sessionId"], "query": {"mode": "summary"}})
            assert inspection.get("ok") is True, "Office renderer did not acknowledge its real document"
            report["word_direct_inspection"] = True
            ai_marker = "MONA_AI_WORD_" + uuid4().hex
            await finish(await begin(f"请用 office 编辑当前 Word，在现有正文末尾新增独立一段：{ai_marker}。保留原文，不新建文档，不只回复文字。"))
            word = await export("word.docx")
            with zipfile.ZipFile(word) as archive:
                text = "".join(ET.fromstring(archive.read("word/document.xml")).itertext())
                assert marker in text and ai_marker in text
            await page.reload()
            await page.get_by_role("tab", name=state["displayName"], exact=True).click()
            await expect(frame.locator(".doc-page").first).to_contain_text(ai_marker)
            await expect(frame.locator(".ribbon-tabs").first).to_have_css("display", "flex")
            report["word_edit_ai_save_export_restore"] = True
            await page.screenshot(path=str(output / "word.png"))

            report["phase"] = "excel"
            frame, state = await new_office("Excel", "表格编辑器")
            await finish(await begin("用 office 编辑当前 Excel 的 Sheet1，写 A1=6、B1=7、C1 的公式为 =A1*B1。操作当前工作簿，保留其余内容，不新建文件；完成后确认 C1 为42。"))
            inspected = await api("/api/work/desktop/api/office/sessions/" + state["sessionId"] + "/inspect", method="post",
                account_headers={**headers, "X-Mona-Session-Key": "websocket:" + await sid()},
                data={"sessionId": state["sessionId"], "query": {"mode": "range", "sheet": "Sheet1", "range": "A1:C1", "includeFormula": True}})
            assert inspected.get("ok") is True
            assert [cell["value"] for cell in inspected["result"]["rows"][0]] == [6, 7, 42]
            report["excel_actual_calculated_values"] = [6, 7, 42]
            excel = await export("excel.xlsx")
            with zipfile.ZipFile(excel) as archive:
                tree = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
                cells = {cell.attrib["r"]: cell for cell in tree.findall(".//{*}c")}
                assert float(cells["A1"].findtext("{*}v")) == 6 and float(cells["B1"].findtext("{*}v")) == 7
                assert cells["C1"].findtext("{*}f").lstrip("=").replace(" ", "") == "A1*B1"
            report["excel_ai_formula_export"] = True
            await page.reload()
            await page.get_by_role("tab", name=state["displayName"], exact=True).click()
            await expect(frame.locator(".ribbon-tabs").first).to_have_css("display", "flex")
            await expect(page.get_by_role("button", name="导出", exact=True)).to_be_enabled(timeout=60000)
            restored = await api("/api/work/desktop/api/office/sessions/" + state["sessionId"] + "/inspect", method="post",
                account_headers={**headers, "X-Mona-Session-Key": "websocket:" + await sid()},
                data={"sessionId": state["sessionId"], "query": {"mode": "range", "sheet": "Sheet1", "range": "A1:C1", "includeFormula": True}})
            assert restored.get("ok") is True
            assert [cell["value"] for cell in restored["result"]["rows"][0]] == [6, 7, 42]
            report["excel_formula_refresh_restore"] = True
            await page.screenshot(path=str(output / "excel.png"))

            report["phase"] = "ppt"
            frame, state = await new_office("PPT", "幻灯片编辑器")
            marker = "MONA_PPT_" + uuid4().hex
            await finish(await begin(f"用 office 编辑当前 PPT，在第一页放入标题文本 {marker}。操作当前演示文稿，不新建文件，不只回复文字。"))
            ppt = await export("slides.pptx")
            with zipfile.ZipFile(ppt) as archive:
                assert any(marker in "".join(ET.fromstring(archive.read(name)).itertext()) for name in archive.namelist()
                           if re.fullmatch(r"ppt/slides/slide[0-9]+\.xml", name))
            report["ppt_ai_export"] = True
            await page.screenshot(path=str(output / "ppt.png"))

            report["phase"] = "canvas"
            await page.get_by_role("button", name="新建标签页", exact=True).click()
            await page.get_by_role("menuitem", name="思维导图", exact=True).click()
            await page.locator("me-tpc").first.dblclick()
            await page.locator("#input-box").fill("MONA_PUBLIC_CANVAS")
            await page.locator("#input-box").press("Enter")
            await expect(page.get_by_text("已自动保存", exact=True)).to_be_visible()
            await asyncio.sleep(1)
            await page.reload()
            await page.get_by_role("tab", name="未命名思维导图", exact=True).click()
            await expect(page.locator("me-tpc").first).to_have_text("MONA_PUBLIC_CANVAS")
            report["canvas_save_refresh"] = True

            report["phase"] = "stop_and_isolation"
            rid = await begin("请用 exec 执行 python3 -c 'import time; time.sleep(25)'，结束后再回复。只执行一次，不重试。")
            async with asyncio.timeout(120):
                while True:
                    events = await api("/api/work/runs/" + rid + "/events?after=0")
                    if any("exec" in event.get("data", {}).get("tools", []) for event in events["events"]):
                        break
                    await asyncio.sleep(0.5)
            await page.get_by_role("button", name=re.compile("^停止")).first.click()
            async with asyncio.timeout(80):
                while True:
                    run = next(run for run in (await detail())["runs"] if run["id"] == rid)
                    if run["status"] not in {"running", "cancelling"}:
                        assert run["status"] == "cancelled" and run["result"].get("workspace_saved") is True
                        break
                    await asyncio.sleep(0.5)
            report["stop_real_exec"] = True
            other_headers = {"Authorization": "Bearer " + credentials["other_token"], "Origin": ORIGIN}
            denied = await context.request.get(ORIGIN + "/api/work/sessions/" + await sid(), headers=other_headers)
            assert denied.status == 404
            for office in offices:
                denied = await context.request.get(ORIGIN + "/api/work/desktop/api/office/sessions/" + office,
                    headers={**other_headers, "X-Mona-Session-Key": "websocket:" + await sid()})
                assert denied.status == 404
                await api("/api/work/desktop/api/office/sessions/" + office, method="delete",
                    account_headers={**headers, "X-Mona-Session-Key": "websocket:" + await sid()})
            report["two_account_isolation"] = True
            closing[0] = True
            await page.get_by_role("button", name="退出登录", exact=True).click()
            await page.get_by_role("button", name="登录并开始", exact=True).wait_for()
            assert await page.locator("iframe,me-tpc").count() == 0
            denied = await context.request.get(ORIGIN + "/api/work/sessions", headers=headers)
            assert denied.status == 401
            assert not page_errors and not failures, "Unexpected UI/network failures"
            report.update(logout_revoked=True, page_errors=page_errors, failed_requests=failures,
                          request_failures=request_failures, console_errors=console_errors, office_styles_applied=True,
                          message_frames=len(sent), passed=True, phase="complete")
        except Exception as error:
            report.update(error_type=type(error).__name__, error=sanitize(error, 1800),
                          page_errors=page_errors, failed_requests=failures,
                          request_failures=request_failures, console_errors=console_errors)
            if "page" in locals():
                try:
                    report["iframe_diagnostics"] = await asyncio.wait_for(frame_diagnostics(page), timeout=5)
                except Exception as diagnostic_error:
                    report["iframe_diagnostics_error_type"] = type(diagnostic_error).__name__
                try:
                    await asyncio.wait_for(page.screenshot(path=str(output / "failure.png")), timeout=5)
                except Exception as screenshot_error:
                    report["screenshot_error_type"] = type(screenshot_error).__name__
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:
                    if report["passed"]:
                        raise
            (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
