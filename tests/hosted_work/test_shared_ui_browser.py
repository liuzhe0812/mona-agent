"""Opt-in local browser acceptance; Auth is synthetic and no model/container is run."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import zipfile
from pathlib import Path
from uuid import uuid4

import pytest
from aiohttp import ClientSession, web

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import NewTurn, WorkError
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

pytestmark = pytest.mark.skipif(os.getenv("MONA_HOSTED_UI_SMOKE") != "1", reason="Explicit local browser acceptance")
ROOT = Path(__file__).resolve().parents[2]
OWNER = "a" * 64
BASE = "/api/work/desktop"


class LocalAuth:
    def __init__(self):
        self.tokens = {"local-ui-a": OWNER, "local-ui-b": "b" * 64}

    async def identity(self, token):
        if token not in self.tokens:
            raise WorkError("login_required", "本地测试账号已退出。", 401)
        return self.tokens[token]

    async def logout(self, token):
        self.tokens.pop(token, None)


class NoExecution:
    calls = 0

    async def execute(self, *_args):
        self.calls += 1
        raise AssertionError("This acceptance must never execute a model or a host command")

    def cancel(self, *_args):
        pass


async def eventually(predicate):
    async with asyncio.timeout(10):
        while not predicate():
            await asyncio.sleep(0.05)


async def test_shared_editor_save_restore_download_and_account_isolation():
    playwright_api = pytest.importorskip("playwright.async_api")
    frontend = ROOT / "webui/dist-hosted-work"
    assert (frontend / "office-editor/docs/index.html").is_file(), "Run npm run build:hosted first"
    output = ROOT / "output/hosted-work" / ("shared-ui-local-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    with socket.socket() as free_port:
        free_port.bind(("127.0.0.1", 0))
        port = free_port.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    state = "\\\\?\\" + str(output) if os.name == "nt" else str(output)
    config = HostedWorkConfig(enabled=True, state_dir=state, frontend_dir=str(frontend), public_origin=origin,
        allow_insecure_lan_http=True, port=port,
        models={"local": HostedWorkModel(label="本地界面验收", model="not-executed")})
    store = WorkStore(output / "work.sqlite3", config)
    executor = NoExecution()
    service = WorkService(config, store, LocalAuth(), executor)
    runner = web.AppRunner(create_app(service))
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    report = {"synthetic_auth": True, "model_executed": False, "deployed": False}
    try:
        async with playwright_api.async_playwright() as playwright:
            executable = os.getenv("MONA_HOSTED_UI_BROWSER") or (
                "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" if os.name == "nt"
                else playwright.chromium.executable_path)
            browser = await playwright.chromium.launch(executable_path=executable, headless=True)
            try:
                context = await browser.new_context(viewport={"width": 1560, "height": 1000}, accept_downloads=True)
                await context.add_init_script("sessionStorage.setItem('mona-hosted-work-v1', JSON.stringify({token:'local-ui-a'}));")
                page = await context.new_page()
                page.set_default_timeout(15000)
                errors, failures = [], []
                logging_out = [False]
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("response", lambda response: failures.append(response.url.split("?", 1)[0].removeprefix(origin))
                        if response.status >= 400 and not (logging_out[0] and response.status == 401) else None)
                await page.goto(origin + "/work/")
                await page.get_by_role("button", name="展开工作区", exact=True).click()
                await page.get_by_role("button", name="新建标签页", exact=True).click()
                await page.get_by_role("menuitem", name="Word", exact=True).click()
                document = page.frame_locator('iframe[title="文档编辑器"]:visible').locator('.doc-page[contenteditable="true"]').first
                await document.fill("MONA_LOCAL_DOC_SAVED")
                await page.get_by_role("button", name="保存", exact=True).click()
                await playwright_api.expect(page.get_by_text("已保存", exact=True)).to_be_visible()
                async with page.expect_download() as download:
                    await page.get_by_role("button", name="导出", exact=True).click()
                await (await download.value).save_as(str(output / "edited.docx"))
                with zipfile.ZipFile(output / "edited.docx") as exported:
                    assert "MONA_LOCAL_DOC_SAVED" in exported.read("word/document.xml").decode()
                report["word_edit_save_download"] = True
                await page.screenshot(path=str(output / "office.png"))
                sid = store.list_sessions(OWNER)[0]["id"]
                background = await context.request.post(origin + BASE + "/api/office/sessions",
                    headers={"Authorization": "Bearer local-ui-a", "X-Mona-Session-Key": "websocket:" + sid},
                    data={"ownerSessionKey": "websocket:" + sid, "type": "docs", "displayName": "后台恢复文档"})
                assert background.status == 201
                background_state = await background.json()
                await service.desktop.wire.emit_to_chat(OWNER, sid, {"event": "attached", "chat_id": sid,
                    "office_sessions": await service.desktop.office.list_states(OWNER, sid)})
                await page.get_by_role("tab", name=background_state["displayName"], exact=True).wait_for()
                await playwright_api.expect(page.get_by_role("tab", name="新建 Word.docx", exact=True)).to_have_attribute("aria-selected", "true")
                report["editor_restore_preserves_focus"] = True

                await page.get_by_role("button", name="新建标签页", exact=True).click()
                await page.get_by_role("menuitem", name="思维导图", exact=True).click()
                await page.get_by_role("tab", name="未命名思维导图", exact=True).wait_for()
                await page.locator("me-tpc").first.dblclick()
                await page.locator("#input-box").fill("MONA_LOCAL_CANVAS_SAVED")
                await page.locator("#input-box").press("Enter")
                folder = Path(state) / "users" / OWNER / "documents/canvases"
                await eventually(lambda: any("MONA_LOCAL_CANVAS_SAVED" in path.read_text(encoding="utf-8") for path in folder.glob("*.mona-canvas")))
                saved_path = next(folder.glob("*.mona-canvas"))
                saved = json.loads(saved_path.read_text(encoding="utf-8"))
                sid = store.list_sessions(OWNER)[0]["id"]
                assert len(sid) == 32 and not store.session_detail(OWNER, sid)["runs"]
                await page.reload()
                await page.get_by_role("tab", name="新建 Word.docx", exact=True).click()
                await playwright_api.expect(document).to_contain_text("MONA_LOCAL_DOC_SAVED")
                await page.get_by_role("tab", name=saved["title"], exact=True).click()
                await playwright_api.expect(page.locator("me-tpc").first).to_have_text("MONA_LOCAL_CANVAS_SAVED")
                assert "处理完成" not in await page.locator("body").inner_text()
                report["word_canvas_refresh_restore"] = True

                # Seed only a running renderer-protocol context; never simulate a model reply.
                rid = uuid4().hex
                store.create_run(OWNER, sid, NewTurn(request_id=rid, model_id="local", text="本地编辑协议验收"))
                headers = {"Authorization": "Bearer local-ui-a", "Origin": origin}
                body = {"run_id": rid, "session_id": sid, "command": "canvas_agent_request", "args": {
                    "requestId": uuid4().hex, "canvasId": saved["id"], "path": "/workspace/canvases/" + saved_path.name,
                    "action": "inspect"}}
                async with ClientSession() as http:
                    response = await http.post(origin + BASE + "/internal/tool", headers=headers, json=body)
                    inspected = (await response.json())["result"]
                    assert response.status == 200 and inspected["ok"]
                    body["args"].update(requestId=uuid4().hex, action="apply", patch={
                        "baseHash": inspected["semanticHash"], "baseDocumentHash": inspected["documentHash"],
                        "ops": [{"name": "updateTopic", "path": [], "expectedTopic": "MONA_LOCAL_CANVAS_SAVED", "topic": "MONA_RENDERER_RPC"}]})
                    applied = await http.post(origin + BASE + "/internal/tool", headers=headers, json=body)
                    assert (await applied.json())["result"]["ok"]
                    repeat = await http.post(origin + BASE + "/internal/tool", headers=headers, json=body)
                    assert repeat.status == 409
                await eventually(lambda: "MONA_RENDERER_RPC" in saved_path.read_text(encoding="utf-8"))
                report["real_canvas_renderer_protocol"] = True
                await page.mouse.move(300, 100)
                await page.screenshot(path=str(output / "canvas.png"))

                await page.get_by_role("button", name="新建标签页", exact=True).click()
                await page.get_by_role("menuitem", name="流程图", exact=True).click()
                await eventually(lambda: len(list(folder.glob("*.mona-canvas"))) == 2)
                flow_path = next(path for path in folder.glob("*.mona-canvas") if path != saved_path)
                flow = json.loads(flow_path.read_text(encoding="utf-8"))
                body["args"] = {"requestId": uuid4().hex, "canvasId": flow["id"], "path": "/workspace/canvases/" + flow_path.name, "action": "open"}
                async with ClientSession() as http:
                    opened = await http.post(origin + BASE + "/internal/tool", headers=headers, json=body)
                    current = (await opened.json())["result"]
                    assert current["ok"]
                    body["args"].update(requestId=uuid4().hex, action="apply", patch={
                        "baseHash": current["semanticHash"], "baseDocumentHash": current["documentHash"],
                        "ops": [{"name": "replaceGraph", "graph": {"direction": "TB", "nodes": [
                            {"id": "start", "kind": "start", "label": "MONA_FLOW_START"},
                            {"id": "end", "kind": "end", "label": "MONA_FLOW_END"}],
                            "edges": [{"id": "link", "source": "start", "target": "end"}]}}]})
                    applied = await http.post(origin + BASE + "/internal/tool", headers=headers, json=body)
                    assert (await applied.json())["result"]["ok"]
                await eventually(lambda: "MONA_FLOW_START" in flow_path.read_text(encoding="utf-8"))
                await playwright_api.expect(page.locator(".react-flow__node")).to_have_count(2)
                report["real_flowchart_renderer_protocol"] = True
                store.finish(OWNER, rid, "completed", {"workspace_saved": True})

                other = await browser.new_context()
                await other.add_init_script("sessionStorage.setItem('mona-hosted-work-v1', JSON.stringify({token:'local-ui-b'}));")
                other_page = await other.new_page()
                await other_page.goto(origin + "/work/")
                await other_page.get_by_role("button", name="展开工作区", exact=True).wait_for()
                assert await other_page.locator("iframe,me-tpc").count() == 0
                denied = await other.request.get(origin + BASE + f"/api/sessions/websocket:{sid}/webui-thread",
                    headers={"Authorization": "Bearer local-ui-b"})
                assert denied.status == 404
                await other.close()
                report["other_account_isolated"] = True
                logging_out[0] = True
                await page.get_by_role("button", name="退出登录", exact=True).click()
                await page.get_by_role("button", name="登录并开始", exact=True).wait_for()
                await playwright_api.expect(page.get_by_role("dialog")).not_to_be_visible()
                assert await page.locator("iframe,me-tpc").count() == 0
                assert not await page.evaluate("Object.keys(sessionStorage).some(key=>key.startsWith('mona.office.sessions.v1:'))")
                report["logout_clears_editors"] = True
                assert not executor.calls and not errors and not failures
                report.update(passed=True, page_errors=errors, failed_requests=failures)
            finally:
                if "page" in locals() and not report.get("passed"):
                    await page.screenshot(path=str(output / "failure.png"))
                await browser.close()
    finally:
        await runner.cleanup()
        store.close()
        (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("LOCAL_UI_REPORT=" + str(output / "acceptance.json"))
