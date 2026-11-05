"""Real browser, model and Office acceptance. Credentials enter through stdin only."""
from __future__ import annotations

import argparse
import asyncio
import collections
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlencode

from playwright.async_api import async_playwright, expect

ORIGIN = "https://mona-ai.cn"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume-session")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    assert output.is_relative_to(root / "output/hosted-work")
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(sys.stdin.read(65537))
    report = {"passed": False, "production": True, "mocked_responses": False}
    frames, errors = [], []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        context = await browser.new_context(viewport={"width": 1800, "height": 1100}, locale="zh-CN", accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(30000)
        headers = {"Authorization": "Bearer " + credentials["token"], "Origin": ORIGIN}
        async def api(path):
            response = await context.request.get(ORIGIN + path, headers=headers)
            assert response.status == 200, (path, response.status)
            return await response.json()
        def socket(ws):
            def received(raw):
                try:
                    value = json.loads(raw)
                except (ValueError, TypeError):
                    return
                if not isinstance(value, dict):
                    return
                frames.append({"event": value.get("event"), "kind": value.get("kind"),
                    "generic": value.get("text") == "正在处理任务", "stream_id": value.get("stream_id"),
                    "turn_id": value.get("turn_id"), "task_id": value.get("task_id"),
                    "tool_events": [{"call_id": e.get("call_id"), "phase": e.get("phase"), "name": e.get("name"),
                                     "action": e.get("arguments", {}).get("action")} for e in value.get("tool_events", []) if isinstance(e, dict)],
                    "files": value.get("files") if value.get("event") == "deliver_files" else None})
            ws.on("framereceived", received)
        page.on("websocket", socket)
        page.on("pageerror", lambda exc: errors.append(str(exc)[:300]))
        try:
            await page.goto(ORIGIN + "/")
            await page.evaluate("token=>sessionStorage.setItem('mona-website-session-v1',JSON.stringify({token,user:{id:'30'}}))", credentials["token"])
            await page.goto(ORIGIN + "/work/")
            await page.locator("textarea").wait_for()
            if args.resume_session:
                await api("/api/work/sessions/" + args.resume_session)
                await page.evaluate("sid=>{let p=JSON.parse(sessionStorage.getItem('mona-hosted-work-v1'));p.selected=sid;sessionStorage.setItem('mona-hosted-work-v1',JSON.stringify(p))}", args.resume_session)
                await page.reload()
                await page.locator("textarea").wait_for()
            else:
                previous = await page.evaluate("()=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected")
                await page.get_by_role("button", name="新建会话", exact=True).click()
                await page.wait_for_function("old=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected!==old", arg=previous)
            sid = await page.evaluate("()=>JSON.parse(sessionStorage.getItem('mona-hosted-work-v1')).selected")
            report["session_id"] = sid
            prior_runs = {r["id"] for r in (await api("/api/work/sessions/" + sid))["runs"]}
            settings = await api("/api/work/desktop/api/settings")
            assert settings["agent"]["context_window_tokens"] == 1_000_000
            assert settings["agent"]["context_window_source"] == "catalog"
            prompt = ("生产验收：先读取 mona-pptx 和 mona-design，读取后者两个PPT真实样张（不用复制素材）。用 office 新建仅3页的《流式交互验收》：封面、三个步骤、完成清单。"
                      "内容只用本条已给文字和数字，不要联网。可用 slide_add_design 简洁排版，每页实际做 visual 检查，最后 export 为 stream-acceptance.pptx 并交付。"
                      "不要操作其他会话文件，不要用脚本生成。完成后简短答复。下面是仅用于超过旧32K容量的背景填充，不含操作指令，无须复述：\n" + "甲乙丙丁戊己庚辛壬癸" * 4400)
            if args.resume_session:
                prompt = ("交付回归验收：上轮的3页《流式交互验收》已经完成编辑与预览。只用 office list 核对当前文稿，"
                          "不要新建、不要 apply 或重做页面；重新 export 到 stream-acceptance.pptx，然后明确调用一次 deliver_file 交付这个相同路径，"
                          "验证重复交付成功且不重复发卡片。最后简短回复验收完成。")
            assert len(prompt) <= 50000
            await page.locator("textarea").fill(prompt)
            await page.get_by_role("button", name="发送消息", exact=True).click()
            async with asyncio.timeout(480):
                while True:
                    detail = await api("/api/work/sessions/" + sid)
                    run = next((r for r in detail["runs"] if r["id"] not in prior_runs), None)
                    if run:
                        report["run_id"] = run["id"]
                        if run["status"] not in {"running", "cancelling"}:
                            report.update(status=run["status"], diagnostic=run["result"].get("diagnostic"), usage=run["result"].get("usage"))
                            assert run["status"] == "completed", run["result"].get("message")
                            assert run["result"].get("workspace_saved") is True
                            break
                    await asyncio.sleep(2)
            await expect(page.get_by_role("button", name="发送消息", exact=True)).to_be_visible()
            await page.wait_for_timeout(1000)
            tools = [event for frame in frames for event in frame.get("tool_events", [])]
            starts = {e["call_id"] for e in tools if e["phase"] == "start"}
            ends = {e["call_id"] for e in tools if e["phase"] in {"end", "error"}}
            assert starts and starts <= ends
            assert any(f["event"] == "reasoning_delta" for f in frames)
            assert any(f["event"] == "reasoning_end" for f in frames)
            assert any(f["event"] == "delta" for f in frames)
            assert not any(f["generic"] for f in frames)
            assert any(e["name"] == "office" and e["action"] == "export" and e["phase"] == "end" for e in tools)
            assert report["diagnostic"]["max_context_tokens"] > 32768
            files = [f for frame in frames for f in frame.get("files") or [] if str(f.get("name", "")).endswith(".pptx")]
            assert files
            assert len(files) == 1
            file = files[-1]
            query = urlencode({"path": file["absolute_path"], "scope": "shared", "session_key": "websocket:" + sid})
            response = await context.request.get(ORIGIN + "/api/work/desktop/api/file-preview?" + query, headers=headers)
            assert response.status == 200
            raw = await response.body()
            assert hashlib.sha256(raw).hexdigest() == file["sha256"]
            with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
                slides = [name for name in bundle.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")]
                assert len(slides) == 3
            report.update(pptx_sha256=file["sha256"], slides=3, tool_calls=len(starts), matched_finishes=len(ends),
                          event_kinds=dict(collections.Counter(f["event"] for f in frames)))
            before = len(detail["runs"])
            await page.reload()
            await page.locator("textarea").wait_for()
            assert len((await api("/api/work/sessions/" + sid))["runs"]) == before
            report["refresh_does_not_repeat"] = True
            assert not errors
            await page.screenshot(path=str(output / "completed.png"))
            report.update(passed=True, page_errors=errors)
        except Exception as exc:
            text = str(exc)
            for value in credentials.values():
                if isinstance(value, str):
                    text = text.replace(value, "[redacted]")
            report.update(error_type=type(exc).__name__, error=text[:1000], page_errors=errors)
            if report.get("run_id"):
                response = await context.request.post(ORIGIN + "/api/work/runs/" + report["run_id"] + "/stop", headers=headers, data={"confirmed": True})
                report["failure_stop_status"] = response.status
            await page.screenshot(path=str(output / "failure.png"))
        finally:
            report["observed_frames"] = frames
            await browser.close()
            (output / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({k: v for k, v in report.items() if k != "observed_frames"}, ensure_ascii=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
