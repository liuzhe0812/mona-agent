"""Real hosted-model acceptance; URL/account token enter through stdin only.

Example stdin: {"url":"https://mona-ai.cn/work/","token":"..."}
Creates a disposable QA conversation and sends an ordinary presentation request.
Use --check-identity only when the separate identity check has not already passed.
No model responses, WebSocket frames or preview responses are mocked. A failed
check requests stopping only unfinished runs belonging to these new sessions;
the caller still owns account-token revocation and executor cleanup checks.
Use --observe-session/--observe-run/--prior-report together to validate only
delivery and restoration of an already completed QA run, without model input.
Use --preview-only to validate real style images and the pending question,
then cancel only this check's new run; this does not validate a finished PPT.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import hashlib
import io
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from urllib.parse import quote, quote_plus, urlencode, urlsplit
from uuid import uuid4

from PIL import Image
from playwright.async_api import async_playwright, expect

BASE = "/api/work/desktop"
STORE = "mona-hosted-work-v1"
ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
SHA = re.compile(r"^[a-f0-9]{64}$")
IDENTITY_PROMPT = "你是谁，用一句自然的话介绍自己。"
PPT_PROMPT = "做一份3页Mona产品介绍PPT，讲清主要用途和适用人群；先给几个真实风格样张让我选，再制作可编辑PPTX并给下载。"
PREFERENCE = "采用第一推荐方向，红黑配色，正文清晰，保持原生可编辑。"


def image_info(raw: bytes) -> dict:
    assert 0 < len(raw) <= 10 * 1024 * 1024, "Unexpected style-preview size"
    with Image.open(io.BytesIO(raw)) as image:
        kind, dimensions = image.format, image.size
        assert kind in {"JPEG", "PNG", "WEBP"} and min(dimensions) >= 32, "Invalid style preview"
        assert dimensions[0] * dimensions[1] <= 25_000_000, "Unexpected style-preview dimensions"
        image.verify()
    return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "width": dimensions[0], "height": dimensions[1], "format": kind}


def pptx_info(raw: bytes, expected: dict) -> dict:
    assert len(raw) == expected["size"] and hashlib.sha256(raw).hexdigest() == expected["sha256"], "PPTX delivery digest/size mismatch"
    assert raw.startswith(b"PK"), "Delivery is not a PPTX archive"
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = sorted(name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide[0-9]+\.xml", name))
        assert len(names) == 3, "The editable presentation does not have exactly three slides"
        counts = []
        for name in names:
            slide = ET.fromstring(archive.read(name))
            shapes = [shape for shape in slide.iter("{http://schemas.openxmlformats.org/presentationml/2006/main}sp")
                      if any((text.text or "").strip() for text in shape.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}t"))]
            counts.append(len(shapes))
        assert all(counts), "A slide has no native editable text shapes"
    return {"file": "mona-product-intro.pptx", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "slides": len(names), "native_text_shapes_per_slide": counts}


def prior_proof(path: Path, root: Path, sid: str, rid: str) -> dict:
    """Validate existing model evidence; never rewrite or bless its failed tail."""
    path = path.resolve(strict=True)
    assert path.is_relative_to((root / "output/hosted-work").resolve()), "Prior report must stay below output/hosted-work"
    raw = path.read_bytes()
    assert 0 < len(raw) <= 2 * 1024 * 1024, "Unexpected prior-report size"
    prior = json.loads(raw)
    run = next((item for item in prior.get("runs", []) if item.get("session_id") == sid and item.get("run_id") == rid), None)
    assert (run and run.get("status") == "completed" and run.get("workspace_saved") is True
            and prior.get("real_model") is True and prior.get("mocked_responses") is False), "Prior report has no completed real run proof"
    protocol = prior.get("protocol", {}).get(sid, {})
    assert (protocol.get("tool_starts", 0) > 0 and protocol.get("missing_tool_finishes") == []
            and protocol.get("generic_processing_frames") == 0 and rid in protocol.get("turn_end_ids", [])
            and protocol.get("question_frames", 0) > 0 and protocol.get("answer_acks", 0) > 0
            and protocol.get("context_usage")), "Prior style/answer/stream completion proof is incomplete"
    answers = prior.get("question_answers", [])
    assert answers and all(item.get("custom_preference_entered") is True
                           and item.get("first_options_selected", 0) > 0 for item in answers), "Prior report has no real style-choice answer"
    styles = prior.get("style_previews", [])
    assert len(styles) >= 3 and len({item.get("sha256") for item in styles}) >= 3, "Prior report has fewer than three real samples"
    verified = []
    for item in styles[:3]:
        assert item.get("matches_bundled_sample") is True and item.get("naturally_loaded_in_ui") is True, "Prior preview was not verified in the browser"
        name = item.get("file")
        assert isinstance(name, str) and Path(name).name == name and "/" not in name and "\\" not in name, "Invalid prior preview filename"
        image = (path.parent / name).resolve(strict=True)
        assert image.is_relative_to(path.parent), "Prior preview escaped its evidence directory"
        actual = image_info(image.read_bytes())
        assert all(actual[key] == item.get(key) for key in ("sha256", "bytes", "width", "height")), "Prior preview evidence changed"
        verified.append({**actual, "file": str(image.relative_to(root)).replace("\\", "/")})
    return {"report": str(path.relative_to(root)).replace("\\", "/"), "report_sha256": hashlib.sha256(raw).hexdigest(),
            "prior_report_passed": prior.get("passed") is True, "session_id": sid, "run_id": rid,
            "scope": "prior_real_model_style_choice_and_stream_completion",
            "completed_workspace_saved": True, "style_previews": verified,
            "answered_question_requests": len(answers), "custom_preference_entered": True,
            "tool_starts": protocol["tool_starts"], "tool_ends": protocol.get("tool_ends", 0),
            "tool_errors": protocol.get("tool_errors", 0), "missing_tool_finishes": [],
            "context_usage_samples": len(protocol["context_usage"]), "turn_end_observed": True,
            "generic_processing_frames": 0}


class Trace:
    """Retain only protocol facts; URLs, message bodies and arguments stay out."""

    def __init__(self):
        self.events = collections.Counter()
        self.calls = {}
        self.context_usage = []
        self.turn_ends = set()
        self.generic = 0
        self.sent = 0
        self.answer_acks = 0
        self.question_frames = 0
        self.pending_questions = []
        self.preview = None
        self.delivery = None

    def received(self, frame):
        name = frame.get("event")
        if isinstance(name, str) and re.fullmatch(r"[a-z_]{1,80}", name):
            self.events[name] += 1
        if name == "user_questions":
            self.question_frames += 1
            self.pending_questions = [item["request_id"] for item in frame.get("requests", [])
                                      if isinstance(item, dict) and isinstance(item.get("request_id"), str)]
        if name == "answer_user_question_result" and frame.get("ok") is True:
            self.answer_acks += 1
        if name == "deliver_files":
            if frame.get("presentation") == "question_preview":
                self.preview = {"files": frame.get("files", []), "media": frame.get("media_urls", [])}
            else:
                for item in frame.get("files", []):
                    if isinstance(item, dict) and str(item.get("name", "")).lower().endswith(".pptx"):
                        self.delivery = dict(item)
        if name == "turn_end" and isinstance(frame.get("turn_id"), str):
            self.turn_ends.add(frame["turn_id"])
        if str(frame.get("text", "")).strip() == "正在处理任务":
            self.generic += 1
        usage = frame.get("token_usage")
        if isinstance(usage, dict):
            allowed = {key: value for key, value in usage.items() if key in {
                "context_tokens", "context_window_tokens", "prompt_tokens", "completion_tokens", "total_tokens",
                "cached_tokens", "cache_read_tokens", "cache_write_tokens",
            } and type(value) in {int, float} and 0 <= value < 10**12}
            if allowed and allowed not in self.context_usage and len(self.context_usage) < 100:
                self.context_usage.append(allowed)
        for item in frame.get("tool_events") or []:
            if not isinstance(item, dict):
                continue
            call, tool, phase = item.get("call_id"), item.get("name"), item.get("phase")
            if (not isinstance(call, str) or not ID.fullmatch(call) or not isinstance(tool, str)
                    or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", tool) or phase not in {"start", "end", "error"}):
                continue
            record = self.calls.setdefault(call, {"call_id": call, "name": tool, "phases": []})
            if phase not in record["phases"]:
                record["phases"].append(phase)
            skill = (item.get("arguments") or {}).get("name") if isinstance(item.get("arguments"), dict) else None
            if tool == "skill_read" and isinstance(skill, str) and re.fullmatch(r"[a-z0-9-]{1,80}", skill):
                record["skill"] = skill
            reference = (item.get("arguments") or {}).get("skill") if isinstance(item.get("arguments"), dict) else None
            if tool == "skill_reference_read" and reference in {"mona-design", "mona-pptx"}:
                record["reference_skill"] = reference

    def summary(self):
        calls = list(self.calls.values())
        return {"event_counts": dict(self.events), "tool_calls": calls,
                "tool_starts": sum("start" in call["phases"] for call in calls),
                "tool_ends": sum("end" in call["phases"] for call in calls),
                "tool_errors": sum("error" in call["phases"] for call in calls),
                "missing_tool_finishes": [call["call_id"] for call in calls if "start" in call["phases"]
                                          and not {"end", "error"}.intersection(call["phases"])],
                "context_usage": self.context_usage, "turn_end_ids": sorted(self.turn_ends),
                "generic_processing_frames": self.generic, "message_frames_sent": self.sent,
                "question_frames": self.question_frames, "answer_acks": self.answer_acks}


def presentation_route_verified(trace: Trace) -> bool:
    ended = [item for item in trace.calls.values() if "end" in item["phases"]]
    return (any(item.get("skill") == "mona-pptx" for item in ended)
            and any(item.get("skill") == "mona-design" or item.get("reference_skill") == "mona-design" for item in ended))


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--browser", type=Path)
    parser.add_argument("--timeout", type=int, default=700)
    parser.add_argument("--check-identity", action="store_true", help="Also run a separate real self-introduction task")
    parser.add_argument("--observe-session", help="Existing disposable QA session; sends no model request")
    parser.add_argument("--observe-run", help="Completed run whose delivery should be checked")
    parser.add_argument("--prior-report", type=Path, help="Original real style/answer/stream evidence, retained unchanged")
    parser.add_argument("--preview-only", action="store_true", help="Verify real style previews, then cancel this new QA run; no PPT completion claim")
    args = parser.parse_args()
    observe = bool(args.observe_session or args.observe_run or args.prior_report)
    if observe and (not all((args.observe_session, args.observe_run, args.prior_report)) or args.check_identity):
        parser.error("Observation requires all three --observe-* / --prior-report arguments and excludes --check-identity")
    if observe and not all(re.fullmatch(r"[a-f0-9]{32}", value) for value in (args.observe_session, args.observe_run)):
        parser.error("Observed session and run IDs must be 32 lowercase hexadecimal characters")
    if args.preview_only and (observe or args.check_identity):
        parser.error("--preview-only requires its own new QA run and excludes observation/identity modes")
    assert 60 <= args.timeout <= 700, "Timeout must be between 60 and 700 seconds"
    credentials = json.loads(sys.stdin.read(65_537))
    token, target = credentials.get("token"), credentials.get("url")
    assert isinstance(token, str) and re.fullmatch(r"[\x21-\x7e]{1,8192}", token), "Invalid stdin token"
    assert isinstance(target, str) and len(target) <= 2048, "Invalid stdin URL"
    parts = urlsplit(target)
    assert (parts.scheme in {"https", "http"} and parts.hostname and not parts.username and not parts.password
            and not parts.query and not parts.fragment and parts.path in {"", "/", "/work", "/work/"}), "Invalid work URL"
    origin = f"{parts.scheme}://{parts.netloc}"
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    assert output.is_relative_to((root / "output/hosted-work").resolve()), "Output must stay below output/hosted-work"
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    report = {"passed": False, "phase": "initializing", "origin": origin, "real_model": True,
              "mocked_responses": False, "test_sessions": [], "runs": [], "question_answers": [],
              "mode": "observe_completed_run" if observe else "new_real_model_run",
              "preview_only": args.preview_only, "scope": "style_preview" if args.preview_only else "complete_presentation",
              "cancelled_by_qa": False}
    traces, errors, failures, console_errors = {}, [], [], []
    secrets = {token, quote(token, safe=""), quote_plus(token, safe=""), json.dumps(token)[1:-1]}

    def clean(value, limit=1000):
        text = str(value).split("Aria snapshot:", 1)[0]
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[redacted]")
        text = re.sub(r"(/api/work/desktop/media/)[A-Za-z0-9_-]+", r"\1[redacted]", text)
        text = re.sub(r"(?i)\bbearer\s+[^\s\"',;]+", "Bearer [redacted]", text)
        text = re.sub(r"(?i)\b(?:https?|wss?)://[^\s\"'<>`]+",
                      lambda match: re.split(r"[?#]", match.group(), maxsplit=1)[0], text)
        return text[:limit]

    def safe(value):
        if isinstance(value, dict):
            return {key: safe(item) for key, item in value.items()}
        if isinstance(value, list):
            return [safe(item) for item in value]
        return clean(value) if isinstance(value, str) else value

    def record(items, value):
        if len(items) < 50 and value not in items:
            items.append(value)

    def progress(phase, **fields):
        report["phase"] = phase
        print(json.dumps(safe({"phase": phase, "elapsed_seconds": round(time.monotonic() - started, 1), **fields})), flush=True)

    async with async_playwright() as playwright:
        executable = args.browser
        edge = Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe")
        if not executable and edge.is_file():
            executable = edge
        browser = await playwright.chromium.launch(executable_path=str(executable) if executable else None, headless=True)
        context = await browser.new_context(viewport={"width": 1800, "height": 1100}, locale="zh-CN", accept_downloads=True)
        page = await context.new_page()
        page.set_default_timeout(25_000)
        headers = {"Authorization": "Bearer " + token, "Origin": origin}

        async def api(path, *, method="GET", body=None, extra=None):
            response = await context.request.fetch(origin + path, method=method, headers={**headers, **(extra or {})}, data=body, timeout=20_000)
            assert response.ok, f"{method} {clean(urlsplit(path).path)}: HTTP {response.status}"
            return await response.json()

        async def screenshot(name):
            await page.screenshot(path=str(output / name), mask=[page.get_by_text(token, exact=False),
                                                                 page.locator('input[type="password"]')])

        def websocket(socket):
            for value in (urlsplit(socket.url).query.split("&") if "?" in socket.url else []):
                if "=" in value:
                    secrets.add(value.split("=", 1)[1])

            def received(raw):
                try:
                    frame = json.loads(raw)
                except (ValueError, TypeError):
                    return
                if isinstance(frame, dict) and frame.get("chat_id") in traces:
                    traces[frame["chat_id"]].received(frame)

            def sent(raw):
                try:
                    frame = json.loads(raw)
                except (ValueError, TypeError):
                    return
                if isinstance(frame, dict) and frame.get("chat_id") in traces and frame.get("type") == "message":
                    traces[frame["chat_id"]].sent += 1

            socket.on("framereceived", received)
            socket.on("framesent", sent)

        page.on("websocket", websocket)
        page.on("pageerror", lambda error: record(errors, clean(error)))
        page.on("console", lambda message: record(console_errors, clean(message.text)) if message.type == "error" else None)

        def response_seen(response):
            path = urlsplit(response.url).path
            if response.status >= 400 and path.startswith(("/api/work/", "/work/assets/", "/work/office-editor/")):
                record(failures, {"path": clean(path), "status": response.status})

        page.on("response", response_seen)

        async def select_session(identity, title):
            await page.get_by_text(title, exact=True).click()
            await page.wait_for_function("value => JSON.parse(sessionStorage.getItem(value.key) || '{}').selected === value.id",
                                         arg={"key": STORE, "id": identity})

        async def verify_styles(trace):
            async with asyncio.timeout(30):
                while trace.preview is None:
                    await asyncio.sleep(0.1)
            files, media = trace.preview["files"], trace.preview["media"]
            assert len(files) >= 3 and len(media) >= 3, "Three actual style previews were not delivered"
            expected = {hashlib.sha256(path.read_bytes()).hexdigest()
                        for path in (root / "mona/skills/mona-design/assets/style-specimens").rglob("*.jpg")}
            selected, seen, selected_urls = [], set(), []
            for file, item in zip(files, media):
                if file.get("sha256") in seen:
                    continue
                url = item.get("url") if isinstance(item, dict) else None
                assert isinstance(url, str), "Style preview has no authenticated media URL"
                from urllib.parse import urljoin

                address = urljoin(origin + "/", url)
                parsed = urlsplit(address)
                assert (f"{parsed.scheme}://{parsed.netloc}" == origin and not parsed.query
                        and re.fullmatch(BASE + r"/media/[A-Za-z0-9_-]{32,128}", parsed.path)), "Invalid preview URL"
                secrets.add(parsed.path.rsplit("/", 1)[1])
                await page.wait_for_function("""url => Array.from(document.images).some(image =>
                    image.src === url && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)""", arg=address)
                image = page.locator(f'img[src="{address}"]:visible').first
                await expect(image).to_be_visible()
                await image.scroll_into_view_if_needed()
                response = await context.request.get(address, headers=headers, timeout=20_000)
                assert response.ok, "Style-preview bytes were unavailable"
                raw = await response.body()
                evidence = image_info(raw)
                assert evidence["sha256"] == file.get("sha256") and evidence["bytes"] == file.get("size"), "Style preview digest/size mismatch"
                assert evidence["sha256"] in expected, "Preview is not a real bundled style sample"
                dimensions = await image.evaluate("image => ({width:image.naturalWidth,height:image.naturalHeight})")
                assert dimensions["width"] == evidence["width"] and dimensions["height"] == evidence["height"], "The visible preview differs from the verified image bytes"
                extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[evidence["format"]]
                name = f"style-{len(selected) + 1}" + extension
                (output / name).write_bytes(raw)
                selected.append({**evidence, "file": name, "matches_bundled_sample": True,
                                 "naturally_loaded_in_ui": True, "visible_in_ui": True,
                                 "natural_width": dimensions["width"], "natural_height": dimensions["height"]})
                selected_urls.append(address)
                seen.add(evidence["sha256"])
                if len(selected) == 3:
                    break
            assert len(selected) == 3, "Fewer than three distinct actual samples were shown"
            await page.wait_for_function("""urls => urls.every(url => Array.from(document.images).some(image => {
                if (image.src !== url) return false;
                const rect = image.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.left < 0
                    || rect.bottom > innerHeight || rect.right > innerWidth) return false;
                return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === image;
            }))""", arg=selected_urls)
            report["style_previews"] = selected
            report["simultaneously_visible_style_previews"] = 3

        async def cancel_preview_run(sid, run, trace, summary):
            assert any(item["id"] == sid and item.get("created_by_this_check") is True
                       for item in report["test_sessions"]), "Preview cancellation is limited to this check's new QA session"
            assert run["session_id"] == sid and run["status"] == "running", "Preview QA run is not the current waiting task"
            panel = page.get_by_role("region", name="待回答问题", exact=True).first
            await expect(panel).to_be_visible()
            await verify_styles(trace)
            assert presentation_route_verified(trace), "Preview did not follow the shared PPT/design reference route"
            await expect(panel).to_be_visible()
            report["question_panel_visible"] = True
            await screenshot("style-preview-visible.png")
            progress("cancelling_new_preview_qa_run", session_id=sid, run_id=run["id"])
            await api("/api/work/runs/" + run["id"] + "/stop", method="POST", body={"confirmed": True})
            report["preview_stop_requested"] = True
            while True:
                detail = await api("/api/work/sessions/" + sid)
                current = next(item for item in detail["runs"] if item["id"] == run["id"])
                if current["status"] not in {"running", "cancelling"}:
                    break
                await asyncio.sleep(0.25)
            summary.update(status=current["status"], workspace_saved=current["result"].get("workspace_saved") is True,
                           stop_reason=(current["result"].get("diagnostic") or {}).get("stop_reason"))
            assert current["status"] == "cancelled" and summary["workspace_saved"], "QA cancellation/workspace save was not confirmed"
            await expect(page.get_by_role("button", name="停止响应", exact=True)).not_to_be_visible()
            await expect(panel).not_to_be_visible()
            report.update(cancelled_by_qa=True, full_presentation_completed=False, preview_workspace_saved=True)
            return current

        async def answer_question(sid, answered):
            trace = traces[sid]
            pending = next((identity for identity in trace.pending_questions if identity not in answered), None)
            panel = page.get_by_role("region", name="待回答问题", exact=True).first
            if pending is None or not await panel.is_visible():
                return
            if not report.get("style_previews"):
                await verify_styles(trace)
            fields = panel.locator("fieldset")
            count = await fields.count()
            assert count > 0, "Question panel has no real questions"
            selected = 0
            for index in range(count):
                field = fields.nth(index)
                options = field.locator('input[type="radio"], input[type="checkbox"]')
                if await options.count():
                    await options.first.check()
                    selected += 1
                await field.get_by_role("textbox").fill(PREFERENCE)
            await screenshot(f"style-question-{len(answered) + 1}.png")
            await panel.get_by_role("button", name="提交回答", exact=True).click()
            answered.add(pending)
            report["question_answers"].append({"request_id": pending, "questions": count,
                                                "first_options_selected": selected, "custom_preference_entered": True})
            progress("question_answered", session_id=sid, questions=count)

        async def task(sid, prompt, *, questions=False, preview_only=False):
            trace = traces[sid]
            prior = {run["id"] for run in (await api("/api/work/sessions/" + sid))["runs"]}
            await page.locator("textarea:visible").last.fill(prompt)
            await page.get_by_role("button", name="发送消息", exact=True).click()
            answered, heartbeat, summary = set(), 0.0, None
            while True:
                detail = await api("/api/work/sessions/" + sid)
                run = next((item for item in detail["runs"] if item["id"] not in prior), None)
                if run:
                    if summary is None:
                        summary = {"session_id": sid, "run_id": run["id"], "status": run["status"]}
                        report["runs"].append(summary)
                        progress("run_started", session_id=sid, run_id=run["id"])
                    summary["status"] = run["status"]
                    if run["status"] not in {"running", "cancelling"}:
                        diagnostic = run["result"].get("diagnostic") or {}
                        summary["stop_reason"] = diagnostic.get("stop_reason")
                        summary["workspace_saved"] = run["result"].get("workspace_saved") is True
                        assert run["status"] == "completed" and summary["workspace_saved"], "Real model task did not complete and save its workspace"
                        break
                if questions:
                    if preview_only:
                        if run and trace.pending_questions:
                            panel = page.get_by_role("region", name="待回答问题", exact=True).first
                            if await panel.is_visible():
                                return await cancel_preview_run(sid, run, trace, summary)
                    else:
                        await answer_question(sid, answered)
                if time.monotonic() - heartbeat >= 15:
                    heartbeat = time.monotonic()
                    progress("waiting_for_real_model", session_id=sid, run_id=run["id"] if run else None,
                             tool_calls=len(trace.calls), answered_questions=len(answered))
                await asyncio.sleep(0.5)
            await expect(page.get_by_role("button", name="停止响应", exact=True)).not_to_be_visible()
            await expect(page.get_by_role("button", name="发送消息", exact=True)).to_be_visible()
            async with asyncio.timeout(10):
                while run["id"] not in trace.turn_ends:
                    await asyncio.sleep(0.1)
            assert not trace.summary()["missing_tool_finishes"], "Tool starts have no matching terminal events"
            assert trace.generic == 0, "Streaming fell back to generic processing messages"
            return run

        async def editor_visible(sid):
            expand = page.get_by_role("button", name="展开工作区", exact=True)
            if await expand.is_visible():
                await expand.click()
            sessions = await api(BASE + "/api/office/sessions", extra={"X-Mona-Session-Key": "websocket:" + sid})
            slides = [item for item in sessions["sessions"] if item.get("type") == "slides"]
            assert slides, "There is no actual presentation editor session to restore"
            state = slides[-1]
            await page.get_by_role("tab", name=state["displayName"], exact=True).click()
            frame = page.frame_locator('iframe[title="幻灯片编辑器"]:visible')
            await expect(frame.locator(".slide-list .thumb-num")).to_have_count(3, timeout=30_000)
            return state["sessionId"]

        async def open_overview():
            expand = page.get_by_role("button", name="展开工作区", exact=True)
            if await expand.is_visible():
                await expand.click()
            await page.get_by_role("button", name="概览", exact=True).click()

        async def completed_delivery(sid):
            # The existing transcript projection contains verified delivery
            # descriptors. Read bodies only in memory; persist no transcript.
            history = await api(BASE + "/api/sessions/websocket:" + sid + "/webui-thread?limit=200")
            files = [file for message in history.get("messages", []) for file in message.get("deliveredFiles", [])
                     if isinstance(file, dict) and str(file.get("name", "")).lower().endswith(".pptx")]
            assert files, "The completed session has no persisted PPTX delivery card"
            return dict(files[-1])

        try:
            async with asyncio.timeout(max(1, args.timeout - 15)):
                if observe:
                    progress("observing_completed_qa_run", session_id=args.observe_session, run_id=args.observe_run)
                    ppt_sid = identity_sid = args.observe_session
                    report["combined_prior_proof"] = prior_proof(args.prior_report, root, ppt_sid, args.observe_run)
                    detail = await api("/api/work/sessions/" + ppt_sid)
                    completed = next((run for run in detail["runs"] if run["id"] == args.observe_run), None)
                    assert (completed and completed["status"] == "completed"
                            and completed["result"].get("workspace_saved") is True), "The observed real run is not completed with saved workspace"
                    assert not any(run["status"] in {"running", "cancelling", "unknown"} for run in detail["runs"]), "Observed QA session has unresolved work"
                    observed_runs = {run["id"] for run in detail["runs"]}
                    names = {ppt_sid: detail["title"]}
                    traces[ppt_sid] = Trace()
                    report["test_sessions"].append({"id": ppt_sid, "title": detail["title"], "created_by_this_check": False})
                    report["runs"].append({"session_id": ppt_sid, "run_id": args.observe_run, "status": "completed",
                                           "workspace_saved": True, "observed_existing": True})
                else:
                    progress("creating_qa_sessions")
                    stamp = uuid4().hex[:10]
                    ppt_sid = uuid4().hex
                    identity_sid = uuid4().hex if args.check_identity else ppt_sid
                    names = {ppt_sid: "Mona介绍PPT验收 " + stamp}
                    if args.check_identity:
                        names[identity_sid] = "Mona人设验收 " + stamp
                    for sid, title in names.items():
                        traces[sid] = Trace()
                        report["test_sessions"].append({"id": sid, "title": title, "created_by_this_check": True})
                        await api("/api/work/sessions", method="POST", body={"request_id": sid, "title": title})
                await page.add_init_script("""(value => {
                    if (!['/work','/work/'].includes(location.pathname) || location.origin !== value.origin || top !== window) return;
                    let prior; try { prior = JSON.parse(sessionStorage.getItem(value.key) || 'null'); } catch {}
                    sessionStorage.setItem(value.key, JSON.stringify({token:value.token,
                        selected:prior?.token === value.token ? prior.selected : value.sid}));
                    if (value.observe) {
                        const send = WebSocket.prototype.send;
                        WebSocket.prototype.send = function(data) {
                            let frame; try { frame = JSON.parse(data); } catch {}
                            if (frame?.type === 'message') throw new Error('Observation cannot submit model input');
                            return send.call(this, data);
                        };
                    }
                })(%s)""" % json.dumps({"token": token, "sid": identity_sid, "key": STORE, "origin": origin,
                                         "observe": observe}))
                await page.goto(origin + "/work/")
                await page.get_by_role("button", name="发送消息", exact=True).wait_for()
                if not observe:
                    models = (await api("/api/work/models"))["models"]
                    current = (await api(BASE + "/api/settings"))["agent"]["model"]
                    selected = next((item for item in models if item["id"] == current), None)
                    assert selected and selected.get("source") == "mona" and "qwen" in selected["label"].lower(), "QA account is not on the free Qwen platform route"
                    report["model"] = {"id": selected["id"], "label": selected["label"], "source": selected["source"]}
                if args.check_identity:
                    progress("identity_request")
                    identity = await task(identity_sid, IDENTITY_PROMPT)
                    content = str(identity["result"].get("content") or "").strip()
                    assert "mona" in content.lower() and 0 < len(content) <= 300, "Mona did not give a brief natural self-introduction"
                    assert not re.search(r"在线|线上工作台|\bwork\b|隔离|沙箱|(?:AI|工作|智能)助手|\bassistant\b", content, re.I), "Mona exposed the hosted execution identity"
                    report["identity"] = {"natural_mona_identity": True, "characters": len(content),
                                          "response_sha256": hashlib.sha256(content.encode()).hexdigest()}
                    await screenshot("identity-completed.png")
                    await select_session(ppt_sid, names[ppt_sid])
                trace = traces[ppt_sid]
                if observe:
                    file = await completed_delivery(ppt_sid)
                else:
                    progress("presentation_request", session_id=ppt_sid)
                    await task(ppt_sid, PPT_PROMPT, questions=True, preview_only=args.preview_only)
                    if args.preview_only:
                        assert report["cancelled_by_qa"] and report.get("preview_workspace_saved"), "Preview QA cleanup was not confirmed"
                        assert not errors and not failures, "Unexpected browser errors or failed preview requests occurred"
                        assert traces[ppt_sid].sent == 1 and not report["question_answers"], "Preview-only check must not submit an answer or another task"
                        report["new_model_messages_sent"] = traces[ppt_sid].sent
                        report.update(passed=True, phase="style_preview_completed")
                        return 0
                    assert report.get("style_previews") and report["question_answers"] and trace.answer_acks, "The real style-choice/answer loop was not completed"
                    assert trace.context_usage, "No actual context-usage events were observed"
                    assert presentation_route_verified(trace), "Natural presentation routing did not read the shared presentation/design entry"
                    file = trace.delivery
                assert (file and isinstance(file.get("sha256"), str) and SHA.fullmatch(file["sha256"])
                        and type(file.get("size")) is int and file["size"] > 0), "No verified PPTX delivery event was observed"
                progress("presentation_file_card")
                await open_overview()
                card = page.get_by_role("button", name=re.compile(re.escape(file["name"]))).last
                await expect(card).to_be_visible()
                report["ui_file_card_visible"] = True
                report["office_session_id"] = await editor_visible(ppt_sid)
                await screenshot("presentation-completed.png")
                progress("presentation_download")
                await open_overview()
                card = page.get_by_role("button", name=re.compile(re.escape(file["name"]))).last
                await card.click(button="right")
                menu = page.get_by_role("menuitem", name="下载文件", exact=True)
                destination = output / "mona-product-intro.pptx"
                try:
                    await menu.wait_for(timeout=3000)
                    async with page.expect_download(timeout=30_000) as received:
                        await menu.click()
                    downloaded = await received.value
                    assert not await downloaded.failure(), "The UI file download failed"
                    await downloaded.save_as(str(destination))
                    method = "ui_file_menu"
                except Exception:
                    await page.keyboard.press("Escape")
                    query = urlencode({"path": file["absolute_path"], "scope": "shared", "session_key": "websocket:" + ppt_sid})
                    response = await context.request.get(origin + BASE + "/api/file-preview?" + query, headers=headers, timeout=20_000)
                    assert response.ok, "The delivered PPTX could not be downloaded with the same account"
                    destination.write_bytes(await response.body())
                    method = "authenticated_api_fallback"
                report["presentation"] = {**pptx_info(destination.read_bytes(), file), "download_method": method}
                before_runs = {item["id"] for item in (await api("/api/work/sessions/" + ppt_sid))["runs"]}
                if observe:
                    assert before_runs == observed_runs, "Observation created another model run"
                before_sent = sum(item.sent for item in traces.values())
                progress("refresh_restore")
                await page.reload()
                await page.get_by_role("button", name="发送消息", exact=True).wait_for()
                await open_overview()
                await expect(page.get_by_role("button", name=re.compile(re.escape(file["name"]))).last).to_be_visible()
                await editor_visible(ppt_sid)
                await asyncio.sleep(1)
                assert {item["id"] for item in (await api("/api/work/sessions/" + ppt_sid))["runs"]} == before_runs, "Refreshing created another model run"
                expected_sent = 0 if observe else (2 if args.check_identity else 1)
                assert sum(item.sent for item in traces.values()) == before_sent == expected_sent, "Refreshing replayed a model message"
                report["new_model_messages_sent"] = before_sent
                await expect(page.get_by_role("button", name="停止响应", exact=True)).not_to_be_visible()
                report["refresh_preserves_editor_and_delivery_without_replay"] = True
                await screenshot("presentation-restored.png")
                assert not errors and not failures, "Unexpected browser errors or failed work requests occurred"
                report.update(passed=True, phase="completed")
        except Exception as error:
            report.update(error_type=type(error).__name__, error=clean(error, 1800))
            try:
                await screenshot("failure.png")
            except Exception:
                report["failure_screenshot_unavailable"] = True
            cleanup = []
            try:
                async with asyncio.timeout(10):
                    for sid in (() if observe else traces):
                        try:
                            detail = await api("/api/work/sessions/" + sid)
                            for run in detail["runs"]:
                                if run["status"] in {"running", "cancelling"}:
                                    response = await context.request.post(origin + "/api/work/runs/" + run["id"] + "/stop",
                                                                          headers=headers, data={"confirmed": True}, timeout=5000)
                                    cleanup.append({"run_id": run["id"], "stop_request_status": response.status})
                        except Exception:
                            cleanup.append({"session_id": sid, "stop_request_unconfirmed": True})
            except TimeoutError:
                cleanup.append({"cleanup_timeout": True, "stop_request_unconfirmed": True})
            report["failure_cleanup_requests"] = cleanup
        finally:
            await browser.close()
            report.update(elapsed_seconds=round(time.monotonic() - started, 1), page_errors=errors,
                          failed_requests=failures, console_errors=console_errors,
                          protocol={sid: trace.summary() for sid, trace in traces.items()})
            result = safe(report)
            (output / "acceptance.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=True), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
