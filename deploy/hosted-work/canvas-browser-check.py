"""Real canvas save/download acceptance, without model execution.

Pass --output below output/hosted-work and JSON on stdin:
{"url":"http://127.0.0.1:17175/work/","token":"...","synthetic_auth":true}
The script creates two dedicated QA sessions and retains them for inspection.
No credentials, browser storage, traces or raw network frames are persisted.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, quote_plus, urlsplit
from uuid import uuid4

from PIL import Image
from playwright.async_api import async_playwright, expect

BASE = "/api/work/desktop"
SESSION_KEY = "mona-hosted-work-v1"


def known_export_csp_warning(message: str, origin: str, phase: str) -> bool:
    if phase not in {"flowchart_download", "flowchart_pdf_print", "mindmap_download"}:
        return False
    return re.fullmatch(
        rf"Setting the document's base URI to '{re.escape(origin)}/work/assets/[A-Za-z0-9_.-]+\.css' "
        r"violates the following Content Security Policy directive: \"base-uri 'none'\"\. The action has been blocked\.",
        message,
    ) is not None


def image_evidence(path: Path) -> dict:
    raw = path.read_bytes()
    assert raw.startswith(b"\x89PNG\r\n\x1a\n"), "Downloaded file is not PNG"
    with Image.open(path) as picture:
        assert picture.format == "PNG" and min(picture.size) >= 32, "Invalid PNG dimensions"
        assert picture.width * picture.height <= 25_000_000, "Unexpected PNG dimensions"
        dimensions = picture.size
        picture.verify()
    with Image.open(path) as picture:
        assert any(low != high for low, high in picture.convert("RGB").getextrema()), "PNG is uniformly blank"
    return {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "width": dimensions[0], "height": dimensions[1]}


def xml_evidence(path: Path, markers: list[str], *, svg=False) -> dict:
    raw = path.read_bytes()
    assert 0 < len(raw) <= (16 if svg else 2) * 1024 * 1024, "Unexpected XML size"
    document = ET.fromstring(raw)
    if svg:
        assert document.tag.rsplit("}", 1)[-1] == "svg", "Download is not SVG"
        text = " ".join(document.itertext())
    else:
        assert document.tag == "map", "Download is not FreeMind XML"
        text = " ".join(node.get("TEXT", "") for node in document.iter("node"))
    assert all(marker in text for marker in markers), "Exported XML is missing the edited node text"
    return {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "verified_node_text": markers}


def pdf_preview_evidence(path: Path) -> dict:
    import pymupdf as fitz

    raw = path.read_bytes()
    assert raw.startswith(b"%PDF-") and len(raw) > 1000, "Print preview is not a valid nonempty PDF"
    with fitz.open(path) as document:
        assert document.is_pdf and 0 < document.page_count <= 10, "Print preview has no valid PDF pages"
        page = document[0]
        assert min(page.rect.width, page.rect.height) > 0, "Print preview page has no dimensions"
        rendered = path.with_name("flowchart-print-page.png")
        page.get_pixmap(matrix=fitz.Matrix(0.75, 0.75), alpha=False).save(rendered)
        raster = image_evidence(rendered)
        pages = document.page_count
        dimensions = [round(page.rect.width, 2), round(page.rect.height, 2)]
    return {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "pages": pages, "first_page_points": dimensions, "rendered_page": raster,
            "validation": "printing_preview_content", "user_manual_save_verified": False,
            "system_print_dialog_verified": False}


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--browser", type=Path, help="Existing Chromium/Edge executable; nothing is installed")
    parser.add_argument("--headful", action="store_true")
    parser.add_argument("--skip-svg", action="store_true")
    parser.add_argument("--check-pdf", action="store_true",
                        help="Headless print-popup content/PDF validation; does not verify a system save dialog")
    args = parser.parse_args()
    if args.check_pdf and args.headful:
        parser.error("--check-pdf requires headless mode; system print dialogs are outside this acceptance")
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
    report = {"passed": False, "phase": "initializing", "origin": origin,
              "synthetic_auth": credentials.get("synthetic_auth") is True, "mocked_responses": False,
              "model_executed": False, "test_sessions": [], "downloads": {}, "fast_switch_ms": {}}
    errors, failures, console_errors, blocked_models = [], [], [], []
    known_csp_counts, unexpected_csp = {}, []

    def clean(value, limit=700):
        text = str(value)
        for secret in (token, quote(token, safe=""), quote_plus(token, safe=""), json.dumps(token)[1:-1]):
            text = text.replace(secret, "[redacted]")
        text = re.sub(r"(?i)\bbearer\s+[^\s\"',;]+", "Bearer [redacted]", text)
        text = re.sub(r"(?i)\b(?:https?|wss?)://[^\s\"'<>`]+",
                      lambda match: re.split(r"[?#]", match.group(), maxsplit=1)[0], text)
        text = re.sub(r"(?i)(?:blob|data):[^\s\"'<>]+", "[temporary media URL]", text)
        return text[:limit]

    def record(items, value):
        if len(items) < 50 and value not in items:
            items.append(value)

    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return clean(value, 1500) if isinstance(value, str) else value

    async with async_playwright() as playwright:
        executable = args.browser or os.getenv("MONA_HOSTED_UI_BROWSER")
        edge = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
        if not executable and edge.is_file():
            executable = edge
        browser = await playwright.chromium.launch(
            executable_path=str(executable) if executable else None, headless=not args.headful,
        )
        context = await browser.new_context(viewport={"width": 1800, "height": 1100}, locale="zh-CN",
                                            accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(20_000)
        headers = {"Authorization": "Bearer " + token, "Origin": origin}

        async def api(path, *, method="GET", body=None, expected=200):
            response = await context.request.fetch(origin + path, method=method, headers=headers, data=body)
            assert response.status == expected, f"{method} {urlsplit(path).path}: HTTP {response.status}"
            return await response.json()

        async def platform(command, body):
            return await api(BASE + "/platform/invoke", method="POST", body={"command": command, "args": body})

        async def read_canvas(path):
            return await platform("workspace_canvas_read", {"workspaceRoot": "/workspace", "path": path})

        async def saved_canvas(kind, markers):
            async with asyncio.timeout(15):
                while True:
                    canvases = await platform("workspace_canvas_list", {"workspaceRoot": "/workspace", "chatId": sid})
                    for item in canvases:
                        if item["canvas"]["kind"] == kind:
                            value = await read_canvas(item["path"])
                            content = value["canvas"]["contentMarkdown"]
                            if all(marker in content for marker in markers):
                                if kind == "flowchart":
                                    fenced = re.search(r"```mona-flowchart\s*\n(.*?)\n```", content, re.S)
                                    assert fenced, "Saved flowchart has no editable document"
                                    labels = [node.get("label") for node in json.loads(fenced[1])["nodes"]]
                                    assert all(marker in labels for marker in markers), "Saved node text differs from the UI edit"
                                return value
                    await asyncio.sleep(0.1)

        async def ready():
            await page.locator("textarea:visible").first.wait_for()
            await page.wait_for_function("key => !!JSON.parse(sessionStorage.getItem(key) || '{}').selected", arg=SESSION_KEY)

        async def select_session(title, identity):
            await page.get_by_text(title, exact=True).click()
            await page.wait_for_function("value => JSON.parse(sessionStorage.getItem(value.key) || '{}').selected === value.id",
                                         arg={"key": SESSION_KEY, "id": identity})

        async def create_canvas(label):
            expand = page.get_by_role("button", name="展开工作区", exact=True)
            if await expand.is_visible():
                await expand.click()
            await page.get_by_role("button", name="新建标签页", exact=True).click()
            await page.get_by_role("menuitem", name=label, exact=True).click()
            await page.get_by_role("tab", name="未命名" + label, exact=True).wait_for()

        def flow_label():
            return page.locator(f'.react-flow__node[data-id="{flow_node_id}"] [aria-label="Node label"]:visible')

        async def edit_flow(text):
            await flow_label().dblclick()
            editor = page.get_by_role("textbox", name="Node label editor", exact=True)
            await editor.fill(text)
            await editor.press("Enter")

        async def edit_mind(previous, text):
            await page.locator("me-tpc:visible").filter(has_text=previous).first.dblclick()
            editor = page.locator("#input-box")
            await editor.fill(text)
            await editor.press("Enter")

        async def autosaved():
            await expect(page.locator("span:visible").filter(has_text=re.compile(r"^已自动保存$")).last).to_be_visible()

        async def screenshot(name):
            masks = [page.locator('input[type="password"]'), page.get_by_text(token, exact=False)]
            await page.screenshot(path=str(output / name), mask=masks)

        async def download(menu_name, filename):
            await page.locator("button:has(svg.lucide-download):visible").last.click()
            async with page.expect_download(timeout=30_000) as received:
                await page.get_by_role("menuitem", name=menu_name, exact=True).click()
            result = await received.value
            assert not await result.failure(), "Browser download failed"
            destination = output / filename
            await result.save_as(str(destination))
            assert destination.is_file() and destination.stat().st_size > 0, "No downloaded file bytes"
            return destination

        async def check_pdf_preview(marker):
            report["phase"] = "flowchart_pdf_print"
            await page.locator("button:has(svg.lucide-download):visible").last.click()
            start = len(unexpected_csp)
            async with page.expect_popup(timeout=30_000) as opened:
                await page.get_by_role("menuitem", name="PDF（打印）", exact=True).click()
            popup = await opened.value
            try:
                await popup.locator("img").wait_for(state="visible")
                await popup.wait_for_function("""() => {
                    const image = document.querySelector('img');
                    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
                }""")
                state = await popup.evaluate("""async marker => {
                    const image = document.querySelector('img');
                    await image.decode();
                    const source = image.getAttribute('src') || '';
                    const comma = source.indexOf(',');
                    const header = source.slice(0, comma);
                    const body = source.slice(comma + 1);
                    const svg = header.includes(';base64') ? atob(body) : decodeURIComponent(body);
                    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
                    return {
                        decoded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
                        width: image.naturalWidth, height: image.naturalHeight,
                        svg: header.startsWith('data:image/svg+xml'),
                        containsEditedNode: parsed.documentElement.textContent.includes(marker),
                        inlineScripts: document.querySelectorAll('script:not([src])').length,
                        svgScripts: parsed.querySelectorAll('script').length,
                    };
                }""", marker)
                assert state["decoded"] and state["svg"] and state["containsEditedNode"], "Print popup did not decode the actual SVG"
                assert state["inlineScripts"] == 0 and state["svgScripts"] == 0, "Print popup contains inline scripts"
                assert not any("script-src" in message.lower() for message in unexpected_csp[start:]), "Print script was blocked by CSP"
                await popup.emulate_media(media="print")
                await popup.screenshot(path=str(output / "flowchart-print-preview.png"),
                                       mask=[popup.get_by_text(token, exact=False)])
                destination = output / "flowchart-print-preview.pdf"
                await popup.pdf(path=str(destination), print_background=True, prefer_css_page_size=True)
                return {**pdf_preview_evidence(destination), "popup": state,
                        "script_src_csp_violations": [message for message in unexpected_csp[start:]
                                                      if "script-src" in message.lower()]}
            finally:
                await popup.close()

        async def block_model_request(route):
            record(blocked_models, "HTTP model submission blocked")
            await route.abort("blockedbyclient")

        def response_seen(response):
            path = urlsplit(response.url).path
            if response.status >= 400 and (path.startswith("/api/work/") or path.startswith("/work/assets/")):
                record(failures, {"path": clean(path), "status": response.status})

        def console_seen(message):
            text = message.text
            if "MONA_CANVAS_QA_BLOCKED_MODEL" in text:
                record(blocked_models, "WebSocket model submission blocked")
            if message.type == "error":
                safe = clean(text)
                record(console_errors, safe)
                if "content security policy" in safe.lower():
                    if known_export_csp_warning(safe, origin, report["phase"]):
                        known_csp_counts[safe] = known_csp_counts.get(safe, 0) + 1
                    else:
                        record(unexpected_csp, safe)

        def observe_page(value):
            value.on("pageerror", lambda error: record(errors, clean(error)))
            value.on("response", response_seen)
            value.on("console", console_seen)

        observe_page(page)
        context.on("page", observe_page)
        try:
            await page.route(re.compile(r"/api/work/sessions/[a-f0-9]{32}/runs(?:\?|$)"), block_model_request)
            report["phase"] = "creating_qa_sessions"
            stamp = uuid4().hex[:10]
            sid, other_sid = uuid4().hex, uuid4().hex
            title, other_title = "画布验收 " + stamp, "画布切换验收 " + stamp
            for identity, label in ((sid, title), (other_sid, other_title)):
                report["test_sessions"].append({"id": identity, "title": label})
                await api("/api/work/sessions", method="POST", expected=201,
                          body={"request_id": identity, "title": label})
            script = """(value => {
                const href = window.location.href;
                if (href === 'about:blank' || href === 'about:srcdoc') return;
                const target = new URL(href);
                if (window.top !== window || target.origin !== value.origin
                    || !['/work', '/work/'].includes(target.pathname)) return;
                sessionStorage.setItem('mona-hosted-work-v1', JSON.stringify({token:value.token, selected:value.sid}));
                const original = WebSocket.prototype.send;
                WebSocket.prototype.send = function(data) {
                    let frame; try { frame = JSON.parse(data); } catch {}
                    if (frame?.type === 'message') {
                        console.warn('MONA_CANVAS_QA_BLOCKED_MODEL');
                        throw new Error('Canvas acceptance forbids model submission');
                    }
                    return original.call(this, data);
                };
            })(%s)""" % json.dumps({"token": token, "sid": sid, "origin": origin})
            # Authentication belongs only to the Work page. In particular,
            # print popups receive no QA auth initializer or token literal.
            await page.add_init_script(script)
            await page.goto(origin + "/work/")
            await ready()

            report["phase"] = "flowchart_edit_save"
            await create_canvas("流程图")
            await page.get_by_role("button", name="形状库", exact=True).click()
            await page.get_by_role("button", name="添加矩形", exact=True).click()
            inserted = page.locator('[aria-label="Node label"]:visible').filter(has_text=re.compile(r"^新节点$")).last
            flow_node_id = await inserted.locator("xpath=ancestor::*[contains(@class,'react-flow__node')][1]").get_attribute("data-id")
            assert flow_node_id and re.fullmatch(r"[A-Za-z0-9_-]+", flow_node_id), "Inserted node has no stable identity"
            flow_text, flow_fast = "FLOW_SAVE_" + stamp, "FLOW_FAST_" + stamp
            await edit_flow(flow_text)
            await autosaved()
            flow = await saved_canvas("flowchart", [flow_text])
            report["flowchart_path"] = flow["path"]
            report["phase"] = "flowchart_debounce_switch"
            await flow_label().dblclick()
            editor = page.get_by_role("textbox", name="Node label editor", exact=True)
            await editor.fill(flow_fast)
            started = time.perf_counter()
            await editor.press("Enter")
            await page.get_by_text(other_title, exact=True).click()
            elapsed = (time.perf_counter() - started) * 1000
            assert elapsed < 450, "Session switch missed the 450ms debounce window"
            report["fast_switch_ms"]["flowchart"] = round(elapsed, 1)
            flow = await saved_canvas("flowchart", [flow_fast])
            await select_session(title, sid)
            await page.reload()
            await ready()
            await page.get_by_role("tab", name=flow["canvas"]["title"], exact=True).click()
            await expect(flow_label()).to_have_text(flow_fast)
            await autosaved()
            assert (await read_canvas(flow["path"]))["canvas"]["contentMarkdown"] == flow["canvas"]["contentMarkdown"]
            report["flowchart_save_switch_refresh"] = True
            report["phase"] = "flowchart_download"
            report["downloads"]["flowchart_png"] = image_evidence(await download("PNG（标准）", "flowchart.png"))
            if not args.skip_svg:
                report["downloads"]["flowchart_svg"] = xml_evidence(
                    await download("SVG（矢量）", "flowchart.svg"), [flow_fast], svg=True,
                )
            await screenshot("flowchart-ui.png")
            if args.check_pdf:
                report["printing_preview"] = await check_pdf_preview(flow_fast)

            report["phase"] = "mindmap_edit_save"
            await create_canvas("思维导图")
            mind_text, mind_fast, child_text = "MIND_SAVE_" + stamp, "MIND_FAST_" + stamp, "CHILD_" + stamp
            await edit_mind("未命名思维导图", mind_text)
            await page.locator("me-tpc:visible").filter(has_text=mind_text).first.click()
            await page.get_by_role("button", name="子节点", exact=True).click()
            await page.locator("#input-box").fill(child_text)
            await page.locator("#input-box").press("Enter")
            await autosaved()
            mind = await saved_canvas("mindmap", [mind_text, child_text])
            report["mindmap_path"] = mind["path"]
            report["phase"] = "mindmap_debounce_switch"
            await page.locator("me-tpc:visible").filter(has_text=mind_text).first.dblclick()
            await page.locator("#input-box").fill(mind_fast)
            started = time.perf_counter()
            await page.locator("#input-box").press("Enter")
            await page.get_by_text(other_title, exact=True).click()
            elapsed = (time.perf_counter() - started) * 1000
            assert elapsed < 450, "Session switch missed the 450ms debounce window"
            report["fast_switch_ms"]["mindmap"] = round(elapsed, 1)
            mind = await saved_canvas("mindmap", [mind_fast, child_text])
            await select_session(title, sid)
            await page.reload()
            await ready()
            await page.get_by_role("tab", name=mind["canvas"]["title"], exact=True).click()
            await expect(page.locator("me-tpc:visible").filter(has_text=mind_fast).first).to_have_text(mind_fast)
            await expect(page.locator("me-tpc:visible").filter(has_text=child_text).first).to_have_text(child_text)
            await autosaved()
            assert (await read_canvas(mind["path"]))["canvas"]["contentMarkdown"] == mind["canvas"]["contentMarkdown"]
            report["mindmap_save_switch_refresh"] = True
            report["phase"] = "mindmap_download"
            report["downloads"]["mindmap_png"] = image_evidence(await download("导出 PNG 图片", "mindmap.png"))
            report["downloads"]["mindmap_freemind"] = xml_evidence(
                await download("导出 FreeMind (.mm)", "mindmap.mm"), [mind_fast, child_text],
            )
            await screenshot("mindmap-ui.png")
            for identity in (sid, other_sid):
                runs = (await api("/api/work/sessions/" + identity))["runs"]
                if runs:
                    report["model_executed"] = True
                assert not runs, "A model run was unexpectedly created"
            assert not blocked_models, "Unexpected attempt to submit a model request"
            assert not errors and not failures, "Browser errors or failed work requests occurred"
            assert not unexpected_csp, "An unexpected CSP violation occurred"
            report.update(passed=True, phase="completed")
        except Exception as error:
            report.update(error_type=type(error).__name__, error=clean(error, 1500))
            try:
                await screenshot("failure.png")
            except Exception:
                report["failure_screenshot_unavailable"] = True
        finally:
            await browser.close()
            report.update(page_errors=errors, failed_requests=failures, console_errors=console_errors,
                          blocked_model_requests=blocked_models,
                          csp_diagnostics=[error for error in console_errors if "content security policy" in error.lower()],
                          known_export_csp_warnings=[{"message": message, "count": count}
                                                     for message, count in known_csp_counts.items()],
                          unexpected_csp_violations=unexpected_csp)
            safe_report = scrub(report)
            (output / "acceptance.json").write_text(json.dumps(safe_report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(safe_report, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
