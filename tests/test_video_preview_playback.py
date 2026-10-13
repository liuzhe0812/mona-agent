"""Full preview uses the production timeline and waits for playable narration."""

import asyncio
import io
import json
import re
import wave
from array import array
from unittest.mock import MagicMock

import pytest

from mona.api import server
from mona.api.video_runtime import VideoRuntime


async def test_full_preview_uses_metadata_duration_and_compiled_transition(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path)
    project = tmp_path / "preview"
    (project / "scenes").mkdir(parents=True)
    (project / "meta.json").write_text(json.dumps({"resolution": "320x180", "scenes": [{"index": 1, "duration": 3.5, "htmlStatus": "previewing"}]}), encoding="utf-8")
    (project / "storyboard.md").write_text("Resolution: 320x180\n### Scene 1: old\n- Duration: 1s", encoding="utf-8")
    (project / "scenes" / "scene_01.html").write_text('<div data-duration="2" data-transition-preset="fade-rise" data-transition-duration-ms="400">scene</div>', encoding="utf-8")
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "preview"}))
    assert response.status == 200
    entries = json.loads(re.search(r"const entries = (.+);", response.text).group(1))
    assert entries[0][1] == 3.5
    assert entries[0][4:] == ["fade-rise", .4]
    assert "const totalDuration = 3.5;" in response.text


@pytest.mark.parametrize("succeeds", [False, True])
async def test_full_preview_prepares_narration_before_publishing_its_timeline(monkeypatch, tmp_path, succeeds: bool) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path)
    project = tmp_path / "preview"
    (project / "scenes").mkdir(parents=True)
    meta = {"resolution": "320x180", "narrationEnabled": True, "scenes": [{"index": 1, "duration": 1, "narration": "旁白", "title": "内容", "htmlStatus": "previewing"}]}
    (project / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (project / "scenes" / "scene_01.html").write_text('<div data-duration="1">scene</div>', encoding="utf-8")

    async def prepare(_project, scene, _meta):
        if not succeeds:
            return None
        scene["duration"] = 4
        scene["durationRaw"] = "4s"
        return b"prepared narration"

    monkeypatch.setattr(server, "_synthesize_scene_narration", prepare)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "preview"}))
    if succeeds:
        assert response.status == 200
        entries = json.loads(re.search(r"const entries = (.+);", response.text).group(1))
        assert entries[0][1] == 4
        assert "const totalDuration = 4.0;" in response.text
        assert json.loads((project / "meta.json").read_text(encoding="utf-8"))["scenes"][0]["duration"] == 4
    else:
        assert response.status == 503
        payload = json.loads(response.body)
        assert payload["error"] == "PREVIEW_NARRATION_FAILED"
        assert payload["retryable"] is True
        assert "const entries" not in response.text


async def test_full_preview_reports_changed_inputs_without_saving_old_metadata(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path)
    project = tmp_path / "preview"
    (project / "scenes").mkdir(parents=True)
    meta_path = project / "meta.json"
    meta = {"narrationEnabled": True, "scenes": [{"index": 1, "duration": 1, "narration": "旁白", "title": "旧内容", "htmlStatus": "previewing"}]}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    (project / "scenes" / "scene_01.html").write_text('<div data-duration="1">scene</div>', encoding="utf-8")

    async def changed(_project, _scene, _meta):
        meta["scenes"][0]["title"] = "用户的新内容"
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        raise server._VideoNarrationInputChangedError("changed")

    monkeypatch.setattr(server, "_synthesize_scene_narration", changed)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "preview"}))
    assert response.status == 409
    assert json.loads(response.body)["error"] == "NARRATION_INPUT_CHANGED"
    assert json.loads(meta_path.read_text(encoding="utf-8"))["scenes"][0]["title"] == "用户的新内容"


async def test_full_preview_keeps_completed_narration_cache_when_a_later_scene_fails(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path)
    project = tmp_path / "preview"
    (project / "scenes").mkdir(parents=True)
    meta_path = project / "meta.json"
    meta = {"narrationEnabled": True, "scenes": [{"index": index, "duration": 1, "narration": "旁白", "htmlStatus": "previewing"} for index in (1, 2)]}
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    for index in (1, 2):
        (project / "scenes" / f"scene_{index:02d}.html").write_text('<div data-duration="1">scene</div>', encoding="utf-8")

    async def prepare(_project, scene, _meta):
        if scene["index"] == 2:
            return None
        scene["audioInputHash"] = "prepared-first-scene"
        scene["audioMtime"] = 12
        return b"prepared narration"

    monkeypatch.setattr(server, "_synthesize_scene_narration", prepare)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "preview"}))
    assert response.status == 503
    saved = json.loads(meta_path.read_text(encoding="utf-8"))
    assert saved["scenes"][0]["audioInputHash"] == "prepared-first-scene"
    assert saved["scenes"][0]["audioMtime"] == 12


@pytest.mark.parametrize("old_html_exists", [False, True])
async def test_full_preview_blocks_incomplete_scenes_before_preparing_narration(monkeypatch, tmp_path, old_html_exists: bool) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path)
    project = tmp_path / "preview"
    (project / "scenes").mkdir(parents=True)
    meta = {"narrationEnabled": True, "scenes": [{"index": 1, "htmlStatus": "previewing", "narration": "已生成"}, {"index": 2, "htmlStatus": "pending", "narration": "待生成"}]}
    (project / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (project / "scenes" / "scene_01.html").write_text('<div data-duration="1">scene</div>', encoding="utf-8")
    if old_html_exists:
        (project / "scenes" / "scene_02.html").write_text('<div data-duration="1">stale scene</div>', encoding="utf-8")

    async def prepare(*_args):
        raise AssertionError("incomplete previews must not request narration")

    monkeypatch.setattr(server, "_synthesize_scene_narration", prepare)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "preview"}))
    assert response.status == 409
    assert json.loads(response.body)["error"] == "SCENES_NOT_READY"
    assert "全部场景" in json.loads(response.body)["message"]


def _wave_bytes() -> bytes:
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(array("h", [1500 if index % 20 < 10 else -1500 for index in range(8000)]).tobytes())
    return stream.getvalue()


@pytest.fixture
async def browser():
    playwright = pytest.importorskip("playwright.async_api")
    executable = VideoRuntime().get_chrome_path()
    if not executable:
        pytest.skip("The existing browser runtime is required")
    async with playwright.async_playwright() as runtime:
        instance = await runtime.chromium.launch(executable_path=executable, headless=True)
        yield instance
        await instance.close()


def _preview() -> str:
    scenes = [(1, 1.0, '<html><body style="background:red">one</body></html>'), (2, 1.0, '<html><body style="background:blue">two</body></html>')]
    return server._build_video_preview_html(320, 180, 2, scenes, project_name="preview", audio_scene_indices={1}, scene_transitions={2: ("stagger-rise", .4)})


async def test_preparing_audio_holds_clock_and_cancel_does_not_resume_after_response(browser) -> None:
    page = await browser.new_page()
    release = asyncio.Event()
    requested = asyncio.Event()

    async def narration(route):
        requested.set()
        await release.wait()
        await route.fulfill(content_type="audio/wav", body=_wave_bytes())

    await page.route("**/preview", lambda route: route.fulfill(content_type="text/html", body=_preview()))
    await page.route("**/scene/narration?*", narration)
    await page.goto("http://127.0.0.1:43210/preview", wait_until="domcontentloaded")
    await asyncio.wait_for(requested.wait(), 5)
    await page.locator("#play-toggle").click()
    await page.wait_for_timeout(150)
    assert await page.locator("#play-toggle").inner_text() == "取消准备"
    assert await page.locator("#time").inner_text() == "0.0s / 2.0s"
    await page.locator("#play-toggle").click()
    release.set()
    await page.wait_for_function("audioTracks[0].readyState >= 1")
    await page.wait_for_timeout(100)
    assert await page.evaluate("audioTracks[0].paused") is True
    assert await page.locator("#time").inner_text() == "0.0s / 2.0s"
    await page.locator("#play-toggle").click()
    await page.wait_for_function("audioTracks[0].currentTime > .1")
    assert await page.locator("#play-toggle").inner_text() == "暂停"
    await page.close()


async def test_seek_during_audio_preparation_does_not_restart_the_previous_scene(browser) -> None:
    page = await browser.new_page()
    release = asyncio.Event()

    async def narration(route):
        await release.wait()
        await route.fulfill(content_type="audio/wav", body=_wave_bytes())

    await page.route("**/preview", lambda route: route.fulfill(content_type="text/html", body=_preview()))
    await page.route("**/scene/narration?*", narration)
    await page.goto("http://127.0.0.1:43210/preview", wait_until="domcontentloaded")
    await page.locator("#play-toggle").click()
    await page.evaluate("window.postMessage({type:'mona-video-seek',seconds:1.2}, '*')")
    await page.wait_for_function("currentIndex === 1 && playing")
    release.set()
    await page.wait_for_function("audioTracks[0].readyState >= 1")
    assert await page.evaluate("audioTracks[0].paused") is True
    assert await page.evaluate("currentIndex") == 1
    bands = await page.locator(".scene-frame").nth(1).evaluate("frame=>frame.style.maskImage")
    assert "linear-gradient" in bands
    await page.close()


@pytest.mark.parametrize("embedded", [False, True])
async def test_audio_play_rejection_reports_failure_and_keeps_clock_paused(browser, embedded: bool) -> None:
    page = await browser.new_page()
    await page.add_init_script("HTMLMediaElement.prototype.play = function() { return Promise.reject(new DOMException('denied','NotAllowedError')); }")
    await page.route("**/preview", lambda route: route.fulfill(content_type="text/html", body=_preview()))
    await page.route("**/scene/narration?*", lambda route: route.fulfill(content_type="audio/wav", body=_wave_bytes()))
    context = page
    if embedded:
        outer = '<iframe id="preview-frame" src="/preview"></iframe><script>window.errors=[];window.addEventListener("message",event=>{if(event.source===document.getElementById("preview-frame").contentWindow)errors.push(event.data)});</script>'
        await page.route("**/outer", lambda route: route.fulfill(content_type="text/html", body=outer))
        await page.goto("http://127.0.0.1:43210/outer", wait_until="domcontentloaded")
        await page.frame_locator("#preview-frame").locator("#play-toggle").wait_for()
        context = page.frame(url="http://127.0.0.1:43210/preview")
    else:
        await page.goto("http://127.0.0.1:43210/preview", wait_until="domcontentloaded")
    await context.locator("#play-toggle").click()
    if embedded:
        await page.wait_for_function("errors.length === 1")
        error = (await page.evaluate("errors"))[0]
        assert error["type"] == "mona-video-playback-error"
        assert error["sceneIndex"] == 1
        assert "旁白播放失败，画面已暂停" in error["message"]
        assert await context.locator("#playback-error").is_hidden()
    else:
        await context.locator("#playback-error").wait_for(state="visible")
        assert "旁白播放失败，画面已暂停" in await context.locator("#playback-error").inner_text()
    assert await context.locator("#time").inner_text() == "0.0s / 2.0s"
    assert await context.evaluate("playing") is False
    await page.close()
