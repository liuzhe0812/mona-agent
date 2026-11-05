"""Opt-in real Edge rendering of the packaged v16 UI against local shared protocols.

Identity and model output are synthetic; no provider, production host or Office
editor is started. Question submission, preview staging and WebSocket delivery run
through the real local service.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import socket
from io import BytesIO
from pathlib import Path
from uuid import uuid4

import pytest
from aiohttp import ClientSession, web
from PIL import Image

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import NewSession, NewTurn
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore
from tests.hosted_work.test_shared_ui_browser import (
    BASE,
    OWNER,
    ROOT,
    LocalAuth,
    NoExecution,
    eventually,
)

pytestmark = pytest.mark.skipif(os.getenv("MONA_HOSTED_UI_SMOKE") != "1", reason="Explicit local browser acceptance")


async def test_packaged_shared_questions_preview_plan_goal_context_and_turn_end():
    playwright_api = pytest.importorskip("playwright.async_api")
    frontend = Path(os.getenv("MONA_HOSTED_UI_FRONTEND") or
                    ROOT / "output/hosted-work/hide-web-tools-20261105/main-build").resolve(strict=True)
    assert (frontend / "hosted-work.html").is_file(), "Use the existing packaged v16 frontend"
    output = ROOT / "output/hosted-work" / ("shared-protocol-ui-" + uuid4().hex[:8])
    output.mkdir(parents=True)
    with socket.socket() as free_port:
        free_port.bind(("127.0.0.1", 0))
        port = free_port.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    state_root = "\\\\?\\" + str(output) if os.name == "nt" else str(output)
    config = HostedWorkConfig(enabled=True, state_dir=state_root, frontend_dir=str(frontend), public_origin=origin,
        allow_insecure_lan_http=True, port=port,
        models={"local": HostedWorkModel(label="本地协议验收模型", model="never-executed")})
    store = WorkStore(output / "work.sqlite3", config)
    sid, rid = uuid4().hex, uuid4().hex
    store.create_session(OWNER, NewSession(request_id=sid, title="本地共享协议验收"))
    store.create_run(OWNER, sid, NewTurn(request_id=rid, model_id="local", text="本地协议验收，不调用模型。"))
    executor = NoExecution()
    service = WorkService(config, store, LocalAuth(), executor)
    runner = web.AppRunner(create_app(service))
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", port).start()
    report = {"synthetic_auth": True, "synthetic_model_output": True, "model_executed": False,
              "deployed": False, "frontend": str(frontend),
              "html_sha256": hashlib.sha256((frontend / "hosted-work.html").read_bytes()).hexdigest()}
    answer_request = None
    try:
        async with ClientSession() as http:
            auth = {"Authorization": "Bearer local-ui-a", "Origin": origin}
            ready = await http.get(origin + BASE + "/api/settings", headers=auth)
            assert ready.status == 200 and service.desktop is not None
            api = service.desktop
            api.state.set(OWNER, "run:" + rid, {"input_id": "local-protocol-input", "chat_id": sid,
                "frame": {"input_id": "local-protocol-input", "task_id": "local-protocol-task",
                          "content": "本地协议验收，不调用模型。"}})
            api.wire._record_user(OWNER, store.run(OWNER, rid), api.state.get(OWNER, "run:" + rid))

            async def publish(kind, value):
                store.event(OWNER, rid, kind, value)
                await api.wire.on_run_event(OWNER, store.run(OWNER, rid), kind, value)

            async with playwright_api.async_playwright() as playwright:
                executable = os.getenv("MONA_HOSTED_UI_BROWSER") or (
                    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" if os.name == "nt"
                    else playwright.chromium.executable_path)
                browser = await playwright.chromium.launch(executable_path=executable, headless=True)
                try:
                    context = await browser.new_context(viewport={"width": 1560, "height": 1100})
                    await context.add_init_script("sessionStorage.setItem('mona-hosted-work-v1', "
                        + json.dumps(json.dumps({"token": "local-ui-a", "selected": sid})) + ");")
                    page = await context.new_page()
                    page.set_default_timeout(15000)
                    errors, failures, received = [], [], []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("response", lambda response: failures.append({"path": response.url.removeprefix(origin),
                                                                         "status": response.status})
                            if response.status >= 400 else None)

                    def record_frame(payload):
                        try:
                            frame = json.loads(payload)
                        except (ValueError, TypeError):
                            return
                        received.append(frame)

                    page.on("websocket", lambda connection: connection.on("framereceived", record_frame))
                    await page.goto(origin + "/work/")
                    await page.get_by_role("textbox", name="消息输入框", exact=True).wait_for()
                    await eventually(lambda: any(sid in peer.chats for peer in api.wire._peers))
                    await page.get_by_role("button", name="展开工作区", exact=True).click()
                    plan = {"task_id": "local-protocol-task", "revision": 1, "source": "ai", "steps": [
                        {"id": "step_1", "step": "核对样张与回答", "status": "in_progress"}]}
                    await publish("desktop", {"event": "task_plan", "task_plan": plan})
                    await playwright_api.expect(page.get_by_text("核对样张与回答", exact=True)).to_be_visible()
                    goal = {"active": True, "ui_summary": "本地协议目标", "objective": "确认网页直接使用共同的交互协议。"}
                    await publish("desktop", {"event": "goal_state", "goal_state": goal})
                    await page.get_by_role("button", name="查看完整目标", exact=True).click()
                    await playwright_api.expect(page.get_by_text(goal["objective"], exact=True)).to_be_visible()
                    await page.get_by_role("button", name="关闭目标", exact=True).click()
                    usage = {"context_tokens": 25000, "context_window_tokens": 200000,
                             "context_model": "local", "context_provider": "mona_managed"}
                    await publish("progress", {"kind": "context_usage", "token_usage": usage})
                    await playwright_api.expect(page.get_by_role("img", name="12.5% · 25.0K / 200.0K 上下文已使用", exact=True)).to_be_visible()
                    await playwright_api.expect(page.get_by_role("button", name="停止响应", exact=True)).to_be_visible()
                    report["shared_plan_goal_context_rendered"] = True

                    output_image = BytesIO()
                    Image.new("RGB", (180, 100), (140, 25, 45)).save(output_image, format="PNG")
                    raw = output_image.getvalue()
                    preview = await http.post(origin + BASE + "/internal/tool", headers=auth, json={
                        "session_id": sid, "run_id": rid, "command": "question_preview", "args": {
                            "ask_id": "ui-question", "files": [{"name": "style.png", "mime": "image/png",
                                "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                                "data": base64.b64encode(raw).decode()}]}})
                    assert preview.status == 200 and (await preview.json())["result"]["ok"] is True
                    questions = [{"id": "style", "question": "请选择样张风格", "options": [
                        {"label": "商务"}, {"label": "杂志"}]},
                        {"id": "color", "question": "请补充颜色要求", "options": []}]
                    answer_request = asyncio.create_task(http.post(origin + BASE + "/internal/tool", headers=auth,
                        json={"session_id": sid, "run_id": rid, "command": "user_question", "args": {
                            "ask_id": "ui-question", "questions": questions}}))
                    panel = page.get_by_role("region", name="待回答问题", exact=True)
                    await playwright_api.expect(panel).to_be_visible()
                    await panel.get_by_role("radio", name="商务", exact=True).check()
                    await panel.get_by_role("textbox", name="请补充颜色要求：补充回答", exact=True).fill("保留红黑配色")
                    image = page.locator('img[src*="/api/work/desktop/media/"]').first
                    await playwright_api.expect(image).to_be_visible()
                    await playwright_api.expect(image).to_have_js_property("naturalWidth", 180)
                    await playwright_api.expect(image).to_have_js_property("naturalHeight", 100)
                    await page.screenshot(path=str(output / "question-preview.png"))
                    report["shared_question_options_custom_and_preview_rendered"] = True
                    await panel.get_by_role("button", name="提交回答", exact=True).click()
                    answered = await asyncio.wait_for(answer_request, 5)
                    assert answered.status == 200 and (await answered.json())["result"] == {
                        "status": "answered", "answers": [{"id": "style", "selected": ["商务"]},
                            {"id": "color", "selected": [], "custom": "保留红黑配色"}]}
                    await playwright_api.expect(panel).not_to_be_visible()
                    assert any(frame.get("event") == "answer_user_question_result" and frame.get("ok") is True for frame in received)
                    report["answer_acknowledged_and_panel_closed"] = True

                    plan = {**plan, "revision": 2, "steps": [{**plan["steps"][0], "status": "completed"}]}
                    await publish("desktop", {"event": "task_plan", "task_plan": plan})
                    await playwright_api.expect(page.get_by_text("核对样张与回答", exact=True)).to_have_class(re.compile("line-through"))
                    await publish("desktop", {"event": "goal_state", "goal_state": {"active": False}})
                    result = {"content": "本地协议验收结束。", "usage": {"prompt_tokens": 70000},
                              "final_usage": {**usage, "context_tokens": 10000}, "workspace_saved": True}
                    store.finish(OWNER, rid, "completed", result)
                    await api.wire.on_run_finish(OWNER, store.run(OWNER, rid), result)
                    await playwright_api.expect(page.get_by_role("button", name="停止响应", exact=True)).not_to_be_visible()
                    await playwright_api.expect(page.get_by_role("button", name="查看完整目标", exact=True)).not_to_be_visible()
                    await playwright_api.expect(page.get_by_role("img", name="5.0% · 10.0K / 200.0K 上下文已使用", exact=True)).to_be_visible()
                    await playwright_api.expect(page.get_by_text("本地协议验收结束。", exact=True)).to_be_visible()
                    await page.screenshot(path=str(output / "finished.png"))
                    assert not executor.calls and not errors and not failures
                    report.update(passed=True, final_turn_end_closed=True, page_errors=errors, failed_requests=failures)
                finally:
                    if "page" in locals() and not report.get("passed"):
                        await page.screenshot(path=str(output / "failure.png"))
                        (output / "failure-body.txt").write_text(await page.locator("body").inner_text(), encoding="utf-8")
                    await browser.close()
    finally:
        if answer_request is not None and not answer_request.done():
            answer_request.cancel()
            await asyncio.gather(answer_request, return_exceptions=True)
        await runner.cleanup()
        store.close()
        (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("LOCAL_PROTOCOL_UI_REPORT=" + str(output / "acceptance.json"))
