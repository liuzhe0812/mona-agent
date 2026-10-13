"""Real Remotion frames follow speech timing and remain stable when seeking back."""

import asyncio
import importlib.util
import io
import json
import tempfile
from pathlib import Path

import pytest
import websockets

from mona.api import server
from mona.api.video_director import _capture_frames
from mona.api.video_runtime import VideoRuntime
from mona.video_authoring import authored_scene_html


def _scene(tmp_path: Path, source: str) -> tuple[Path, dict, dict]:
    scene = {"index": 1, "duration": 3, "authored": True, "authoredRuntime": "remotion", "assets": []}
    meta = {"resolution": "320x180", "narrationEnabled": True, "subtitleMode": "burned"}
    style = json.loads((server._video_skill_dir() / "templates/styles/minimal-business.json").read_text(encoding="utf-8"))
    track = {"cues": [{"text": "choice", "startMs": 1000, "endMs": 2000}], "words": []}
    target = tmp_path / "scene.html"
    target.write_text(authored_scene_html(source, tmp_path, scene, meta, style, track), encoding="utf-8")
    return target, scene, meta


async def _frames(tmp_path: Path, source: str, times: list[float]) -> tuple[list[bytes], list[dict]]:
    browser = VideoRuntime().get_chrome_path()
    if not browser:
        pytest.skip("No local browser available for actual animation capture")
    path, _, _ = _scene(tmp_path, source)
    spec = importlib.util.spec_from_file_location("remotion_frame_capture", server._video_skill_dir() / "scripts/render.py")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    with tempfile.TemporaryDirectory(prefix="mona-remotion-test-", ignore_cleanup_errors=True) as profile:
        port = renderer._find_free_port()
        process = renderer._start_chrome(browser, port, 320, 180, Path(profile))
        try:
            url = await asyncio.to_thread(renderer._read_devtools_url, process, port)
            async with websockets.connect(url, max_size=64 * 1024 * 1024) as socket:
                await renderer._render_scene(socket, path, 3, 60, 320, 180, tmp_path, 0, sample_times=times)
                reports = await renderer._cdp_call(socket, "Runtime.evaluate", {
                    "expression": "JSON.stringify(window.__monaSceneReports)", "returnByValue": True,
                })
        finally:
            await asyncio.to_thread(renderer._terminate_process_tree, process)
    return [file.read_bytes() for file in sorted(tmp_path.glob("frame_*.png"))], json.loads(reports["result"]["value"])


async def test_real_remotion_speech_cue_and_seek_are_deterministic(tmp_path: Path) -> None:
    source = '''import {AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig} from 'remotion';
import {cue} from 'mona-video';
export default function Scene() {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig(); const speech = cue('choice');
  const x = interpolate(frame, [speech.startFrame, speech.endFrame], [20, 250], {extrapolateLeft:'clamp', extrapolateRight:'clamp'});
  const scale = spring({frame:frame-speech.startFrame, fps, config:{damping:14}});
  return <AbsoluteFill><svg width="320" height="180"><path d="M20 70 L270 70" stroke="blue" strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1-scale}/><circle cx={x} cy="70" r="14" fill="red" /></svg></AbsoluteFill>;
}'''
    frames, reports = await _frames(tmp_path, source, [0, 1.5, .5, 1.5, 2.5])
    assert frames[0] == frames[2]  # The explained movement has not started before the speech cue.
    assert frames[1] == frames[3]  # Revisiting a frame does not accumulate animation.
    assert frames[0] != frames[1] != frames[4]
    assert not any(item.get("error") for item in reports)
    assert len({item["motionSignature"] for item in reports}) == 3


async def test_changed_captions_do_not_certify_static_slides_as_motion(tmp_path: Path) -> None:
    frames, reports = await _frames(tmp_path, 'export default function Scene(){return <div>Static</div>}', [.5, 1.5, 2.5])
    assert frames[0] != frames[1]  # Captions are present only during the spoken cue.
    assert len({item["motionSignature"] for item in reports}) == 1


async def test_invalid_scene_code_fails_instead_of_capturing_blank_video(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="动画.*失败"):
        await _frames(tmp_path, "export default function Scene(){ throw new Error('invalid motion'); }", [0])


async def test_mid_scene_delayed_asset_is_ready_before_frame_capture(tmp_path: Path) -> None:
    source = '''import React from 'react';
import {AbsoluteFill, Sequence, delayRender, continueRender} from 'remotion';
function Delayed(){
  const [ready,setReady]=React.useState(false);
  const [handle]=React.useState(()=>delayRender('prepared object'));
  React.useEffect(()=>{const timer=setTimeout(()=>{setReady(true);continueRender(handle)},1200);return ()=>clearTimeout(timer)},[]);
  return <AbsoluteFill style={{background:ready?'red':'blue'}}/>;
}
export default function Scene(){return <AbsoluteFill style={{background:'green'}}><Sequence from={60}><Delayed/></Sequence></AbsoluteFill>}
'''
    frames, _ = await _frames(tmp_path, source, [0, 1, 2])
    from PIL import Image

    with Image.open(io.BytesIO(frames[1])) as image:
        assert image.getpixel((160, 90))[:3] == (255, 0, 0)
    with Image.open(io.BytesIO(frames[2])) as image:
        assert image.getpixel((160, 90))[:3] == (255, 0, 0)


@pytest.mark.parametrize("changes", [False, True])
async def test_animation_review_uses_real_pixels_and_excludes_caption_changes(tmp_path: Path, changes: bool) -> None:
    source = '''import {useCurrentFrame} from 'remotion';
export default function Scene(){const f=useCurrentFrame();return <svg width="320" height="180"><defs><linearGradient id="fill"><stop stopColor={CHANGES && f>=60?'blue':'red'}/><stop offset="1" stopColor="white"/></linearGradient></defs><rect width="320" height="180" fill="url(#fill)"/></svg>}'''.replace('CHANGES', 'true' if changes else 'false')
    path, scene, meta = _scene(tmp_path, source)
    (tmp_path / "scenes").mkdir()
    path.replace(tmp_path / "scenes/scene_01.html")
    review = await _capture_frames(tmp_path, scene, meta)
    assert review["motionReview"]["staticVisual"] is (not changes)
    assert review["motionReview"]["distinctVisualStates"] == (2 if changes else 1)
    assert Path(review["contactSheet"]).is_file()
