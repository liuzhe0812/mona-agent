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


def _scene(tmp_path: Path, source: str, track: dict | None = None) -> tuple[Path, dict, dict]:
    scene = {"index": 1, "duration": 3, "authored": True, "authoredRuntime": "remotion", "assets": []}
    meta = {"resolution": "320x180", "narrationEnabled": True, "subtitleMode": "burned"}
    style = json.loads((server._video_skill_dir() / "templates/styles/minimal-business.json").read_text(encoding="utf-8"))
    if track is None:
        track = {"cues": [{"text": "choice", "startMs": 1000, "endMs": 2000}], "words": []}
    target = tmp_path / "scene.html"
    target.write_text(authored_scene_html(source, tmp_path, scene, meta, style, track), encoding="utf-8")
    return target, scene, meta


async def _frames(tmp_path: Path, source: str, times: list[float], *, asset_ids: list[str] | None = None, track: dict | None = None) -> tuple[list[bytes], list[dict]]:
    browser = VideoRuntime().get_chrome_path()
    if not browser:
        pytest.skip("No local browser available for actual animation capture")
    path, scene, meta = _scene(tmp_path, source, track)
    if asset_ids:
        scene["assets"] = asset_ids
        style = json.loads((server._video_skill_dir() / "templates/styles/minimal-business.json").read_text(encoding="utf-8"))
        if track is None:
            track = {"cues": [{"text": "choice", "startMs": 1000, "endMs": 2000}], "words": []}
        path.write_text(authored_scene_html(source, tmp_path, scene, meta, style, track), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("remotion_frame_capture", server._video_skill_dir() / "scripts/render.py")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    with tempfile.TemporaryDirectory(prefix="mona-remotion-test-", ignore_cleanup_errors=True) as profile:
        port = renderer._find_free_port()
        process = renderer._start_chrome(browser, port, 320, 180, Path(profile))
        try:
            url = await asyncio.to_thread(renderer._read_devtools_url, process, port)
            async with websockets.connect(url, max_size=64 * 1024 * 1024) as socket:
                try:
                    await renderer._render_scene(socket, path, 3, 60, 320, 180, tmp_path, 0, sample_times=times)
                except RuntimeError as exc:
                    diagnostic = await renderer._cdp_call(socket, "Runtime.evaluate", {
                        "expression": "window.__monaSceneError", "returnByValue": True,
                    })
                    raise RuntimeError(f"{exc}: {diagnostic.get('result', {}).get('value', '')}") from exc
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


async def test_phrase_cue_uses_provider_words_nested_in_subtitle_cues(tmp_path: Path) -> None:
    track = {"cues": [{"text": "first second", "startMs": 1000, "endMs": 2000, "words": [
        {"text": "first", "startMs": 1000, "endMs": 1250},
        {"text": "second", "startMs": 1600, "endMs": 2000},
    ]}]}
    source = '''import {useCurrentFrame} from 'remotion';
import {cue} from 'mona-video';
export default function Scene(){const a=cue('first'), b=cue('second'); return <svg width="320" height="180"><circle cx={useCurrentFrame()<b.startFrame?20:250} cy="60" r="14" fill="blue"/><text x="20" y="35">{a.startFrame}:{b.startFrame}:{b.endFrame}</text></svg>}'''
    frames, reports = await _frames(tmp_path, source, [1.4, 1.7], track=track)
    sample = next(item for item in reports if item["seconds"] == 1.4)
    assert sample["textObservations"][0]["text"] == "60:96:120"
    assert frames[0] != frames[1]


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


@pytest.mark.parametrize("example,phrase", [
    ("object-transform", "改变形状"), ("whiteboard", "建立关系"), ("data-change", "增长"),
])
async def test_bundled_canvas_examples_follow_speech_and_repeat_frames(tmp_path: Path, example: str, phrase: str) -> None:
    source = (server._video_skill_dir() / "references" / "examples" / f"{example}.tsx").read_text(encoding="utf-8")
    source = source.replace(phrase, "choice")
    frames, reports = await _frames(tmp_path, source, [0, 1.4, 2.8, 1.4, 0])
    assert frames[0] == frames[4]
    assert frames[1] == frames[3]
    assert frames[0] != frames[1] != frames[2]
    assert not any(item.get("error") for item in reports)


async def test_canvas_waits_for_authorized_image_and_rejects_missing_id(tmp_path: Path) -> None:
    from PIL import Image

    from mona.video_assets import register_project_asset

    assets = tmp_path / "assets"
    assets.mkdir()
    Image.new("RGB", (80, 60), "red").save(assets / "image.png")
    register_project_asset(tmp_path, {"id": "asset-image", "path": "assets/image.png", "sourceType": "user-upload", "rightsStatus": "owned"})
    source = '''import {MotionCanvas} from 'mona-video';
export default function Scene(){return <MotionCanvas assets={{photo:'asset-image'}} draw={(c,t,k)=>k.MD.cover(c,k.images.photo)}/>}
'''
    frames, _ = await _frames(tmp_path, source, [0, 1], asset_ids=["asset-image"])
    with Image.open(io.BytesIO(frames[0])) as image:
        assert image.getpixel((160, 60))[:3] == (255, 0, 0)
    with pytest.raises(RuntimeError, match="动画.*失败"):
        await _frames(tmp_path, source.replace("asset-image", "asset-missing"), [0], asset_ids=["asset-image"])


async def test_toolkit_character_brush_and_instances_are_seek_safe(tmp_path: Path) -> None:
    source = '''import {MotionCanvas,createMotionToolkit} from 'mona-video';
const first=createMotionToolkit(320,180), second=createMotionToolkit(1080,1920);
if(first.PAINT.canvas().width!==320 || second.PAINT.canvas().width!==1080)throw new Error('shared stage');
const origin=first.CAM.toScreen({x:0,y:0,z:1},0,0);
if(origin[0]!==160 || origin[1]!==90)throw new Error('shared camera');
export default function Scene(){return <MotionCanvas draw={(c,t,{PAINT,MO,TOON},{width,height,theme,cue,fps})=>{
  const speech=cue('choice'), p=MO.seg(t,speech.startFrame/fps,speech.endFrame/fps);
  const paper=PAINT.cached('paper',width,height,g=>{g.fillStyle=theme.bg;g.fillRect(0,0,width,height)});
  c.drawImage(paper,0,0);
  PAINT.brush(c,[[width*.1,height*.65],[width*.9,height*.65]],{w:5,reveal:p,seed:42,bristles:3,col:PAINT.hex(theme.primary)});
  TOON.bean(c,{x:width*.65,y:height*.65,s:height*.18,char:'neutral',pose:TOON.POSES[p>.5?'point':'rest'],mouth:0,blink:0});
}}/>}
'''
    frames, reports = await _frames(tmp_path, source, [0, 1.4, 2.8, 1.4, 0])
    assert frames[0] == frames[4]
    assert frames[1] == frames[3]
    assert frames[0] != frames[1] != frames[2]
    assert not any(item.get("error") for item in reports)


async def test_copied_dashi_code_is_available_in_frame_runtime_and_seek_safe(tmp_path: Path) -> None:
    source = '''import {MotionCanvas,Dashi} from 'mona-video';
export default function Scene(){return <MotionCanvas draw={(c,t,k,{theme,cue,fps})=>{
  if(k.DASHI!==Dashi)throw new Error('missing Dashi module');
  const speech=cue('choice'), p=Dashi.ease.inOutCubic(Dashi.prog(t,speech.startFrame/fps,(speech.endFrame-speech.startFrame)/fps));
  c.translate(20+140*p,35);
  Dashi.paper(c,'evidence-'+theme.surface,110,60,theme.surface);
  c.fillStyle=theme.primary;c.fillRect(15,15,70*p+5,20);
}}/>}
'''
    frames, reports = await _frames(tmp_path, source, [0, 1.4, 2.8, 1.4, 0])
    assert frames[0] == frames[4]
    assert frames[1] == frames[3]
    assert frames[0] != frames[1] != frames[2]
    assert not any(item.get("error") for item in reports)


@pytest.mark.parametrize(("style", "is_undefined"), [
    ("color:'var(--mona-success)'", True),
    ("'--mona-success':'green',color:'var(--mona-success)'", False),
    ("color:'var(--mona-success, green)'", False),
])
async def test_seek_reports_undefined_style_variables_without_flagging_scoped_or_fallback_values(
    tmp_path: Path, style: str, is_undefined: bool,
) -> None:
    source = f'''export default function Scene(){{return <div style={{{{{style}}}}}>Visible</div>}}'''
    _, reports = await _frames(tmp_path, source, [1.5])
    assert bool(reports[0]["undefinedStyleVariables"]) is is_undefined
    if is_undefined:
        assert reports[0]["undefinedStyleVariables"] == ["--mona-success"]


async def test_seek_reports_visible_text_size_and_subtitle_overlap(tmp_path: Path) -> None:
    source = '''export default function Scene(){return <p style={{position:'absolute',bottom:'10%',left:'15%',margin:0,fontSize:'7px'}}>tiny overlap</p>}'''
    _, reports = await _frames(tmp_path, source, [1.5])
    sample = next(item for item in reports if item["seconds"] == 1.5)
    observation = next(item for item in sample["textObservations"] if item["text"] == "tiny overlap")
    assert observation["fontSizePx"] == 7
    assert observation["overlapsCaption"] is True


async def test_text_observations_exclude_labels_under_an_invisible_group(tmp_path: Path) -> None:
    source = '''import {useCurrentFrame} from 'remotion';
export default function Scene(){return <svg width="320" height="180"><g opacity={useCurrentFrame()<60?0:1}><text x="50" y="40">revealed label</text></g></svg>}'''
    _, reports = await _frames(tmp_path, source, [0, 1.5])
    assert not reports[0]["textObservations"]
    sample = next(item for item in reports if item["seconds"] == 1.5)
    assert sample["textObservations"][0]["text"] == "revealed label"


async def test_preview_observes_svg_paths_with_unresolved_expressions(tmp_path: Path) -> None:
    source = '''export default function Scene(){return <svg width="320" height="180"><path d="M 10 10 L ${x} ${y}"/></svg>}'''
    _, reports = await _frames(tmp_path, source, [0])
    assert reports[0]["invalidSvgPaths"] == ["M 10 10 L ${x} ${y}"]


async def test_caption_wrap_balances_lines_instead_of_leaving_an_orphan_word(tmp_path: Path) -> None:
    track = {"cues": [{"text": "一二三四五六七", "startMs": 1000, "endMs": 2000}]}
    _, reports = await _frames(tmp_path, 'export default function Scene(){return <div/>}', [1.5], track=track)
    sample = next(item for item in reports if item["seconds"] == 1.5)
    widths = sample["captionLineWidths"]
    assert len(widths) == 2
    assert min(widths) / max(widths) > .6


async def test_caption_wrap_keeps_provider_word_groups_together(tmp_path: Path) -> None:
    track = {"cues": [{"text": "有一个好方法吧", "startMs": 1000, "endMs": 2000, "words": [
        {"text": "有一个", "startMs": 1000, "endMs": 1400},
        {"text": "好方法", "startMs": 1400, "endMs": 1800},
        {"text": "吧", "startMs": 1800, "endMs": 2000},
    ]}]}
    _, reports = await _frames(tmp_path, 'export default function Scene(){return <div/>}', [1.5], track=track)
    sample = next(item for item in reports if item["seconds"] == 1.5)
    widths = sample["captionLineWidths"]
    assert len(widths) == 2
    # Whole-word wrapping keeps 好方法 on the second line: three characters, then four.
    assert widths[0] < widths[1]


async def test_restored_punctuation_keeps_subtitle_words_together(tmp_path: Path) -> None:
    from mona.video_timeline import build_subtitle_track

    words = [
        {"text": "有一个", "startMs": 1000, "endMs": 1400},
        {"text": "好方法", "startMs": 1400, "endMs": 1800},
        {"text": "吧", "startMs": 1800, "endMs": 2000},
    ]
    track = build_subtitle_track("有一个好方法吧。", 3000, word_timings=words)
    assert track["cues"][0]["words"] == words
    assert "".join(track["cues"][0]["displayWords"]) == "有一个好方法吧。"
    _, reports = await _frames(tmp_path, 'export default function Scene(){return <div/>}', [1.5], track=track)
    sample = next(item for item in reports if item["seconds"] == 1.5)
    widths = sample["captionLineWidths"]
    assert len(widths) == 2
    assert widths[0] < widths[1]
