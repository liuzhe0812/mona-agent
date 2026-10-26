"""Capture real Huashu Motion frames through Mona's isolated film player."""

import asyncio
import importlib.util
import io
import json
import shutil
import tempfile
from pathlib import Path

import pytest
import websockets
from PIL import Image

from mona.api import server
from mona.api.video_runtime import VideoRuntime
from mona.video_authoring import authored_scene_html, refresh_huashu_composition


def _film(script: str, content: str = '') -> str:
    return f'''<!doctype html><html><head><meta charset="utf-8">
<style>body{{background:white}}svg{{display:block}}</style></head><body>
<div data-composition-id="film" data-width="320" data-height="180">{content}</div>
<script>window.__timelines = window.__timelines || {{}};
const tl = gsap.timeline({{paused:true}});{script}
tl.to({{}}, {{duration:3}}, 0);window.__timelines.film = tl;</script></body></html>'''


def _style() -> dict:
    return json.loads((server._video_skill_dir() / 'templates/styles/huashu-keynote.json').read_text(encoding='utf-8'))


def _scene(project: Path, source: str, track: dict | None = None, *, duration: float = 3,
           resolution: str = '320x180', subtitles: bool = True) -> tuple[Path, dict, dict]:
    project.mkdir(parents=True, exist_ok=True)
    scene = {'index': 1, 'duration': duration, 'authored': True, 'authoredRuntime': 'huashu-motion',
             'sourcePath': 'scene_sources/film.html', 'assets': []}
    meta = {'resolution': resolution, 'authoringMode': 'huashu-motion',
            'narrationEnabled': subtitles, 'subtitleMode': 'burned'}
    if track is None:
        track = {'cues': [{'text': 'first second', 'startMs': 1000, 'endMs': 2600, 'words': [
            {'text': 'first', 'startMs': 1000, 'endMs': 1300},
            {'text': 'second', 'startMs': 1600, 'endMs': 2600},
        ]}]}
    target = project / 'scene.html'
    target.write_text(authored_scene_html(source, project, scene, meta, _style(), track), encoding='utf-8')
    return target, scene, meta


async def _capture(path: Path, times: list[float], *, duration: float = 3,
                   design_size: tuple[int, int] = (320, 180), inspect_fonts: bool = False) -> tuple[list[bytes], list[dict], list[dict]]:
    browser = VideoRuntime().get_chrome_path()
    if not browser:
        pytest.skip('No installed browser available for real animation capture')
    spec = importlib.util.spec_from_file_location('huashu_frame_capture', server._video_skill_dir() / 'scripts/render.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    output = path.parent / f'{path.stem}-frames'
    output.mkdir()
    fonts = []
    with tempfile.TemporaryDirectory(prefix='mona-huashu-test-', ignore_cleanup_errors=True) as profile:
        port = renderer._find_free_port()
        process = renderer._start_chrome(browser, port, 320, 180, Path(profile))
        try:
            url = await asyncio.to_thread(renderer._read_devtools_url, process, port)
            async with websockets.connect(url, max_size=64 * 1024 * 1024) as socket:
                try:
                    await renderer._render_scene(socket, path, duration, 60, 320, 180, output, 0,
                                                 design_size=design_size, sample_times=times)
                except RuntimeError as exc:
                    diagnostic = await renderer._cdp_call(socket, 'Runtime.evaluate', {
                        'expression': 'window.__monaSceneError', 'returnByValue': True,
                    })
                    raise RuntimeError(f"{exc}: {diagnostic.get('result', {}).get('value', '')}") from exc
                result = await renderer._cdp_call(socket, 'Runtime.evaluate', {
                    'expression': 'JSON.stringify(window.__monaSceneReports)', 'returnByValue': True,
                })
                reports = json.loads(result['result']['value'])
                if inspect_fonts:
                    targets = await renderer._cdp_call(socket, 'Target.getTargets')
                    child = next(item for item in targets['targetInfos'] if item['type'] == 'iframe')
                    child_url = url.rsplit('/', 1)[0] + '/' + child['targetId']
                    async with websockets.connect(child_url) as child_socket:
                        result = await renderer._cdp_call(child_socket, 'Runtime.evaluate', {
                            'returnByValue': True,
                            'expression': 'Array.from(document.fonts, f => ({family:f.family,status:f.status}))',
                        })
                    fonts = result['result']['value']
        finally:
            await asyncio.to_thread(renderer._terminate_process_tree, process)
    frames = [file.read_bytes() for file in sorted(output.glob('frame_*.png'))]
    assert len(frames) == len(times)
    assert not any(item.get('error') for item in reports)
    return frames, reports, fonts


def _red_center(frame: bytes) -> float:
    with Image.open(io.BytesIO(frame)) as image:
        points = [x for y in range(45, 96) for x in range(image.width)
                  if (lambda p: p[0] > 200 and p[1] < 80 and p[2] < 80)(image.getpixel((x, y)))]
    assert points, 'The authored SVG object must be visible'
    return sum(points) / len(points)


@pytest.mark.parametrize('template', ['object-3d', 'ui-space'])
async def test_unmodified_depth_templates_use_bundled_scripts_and_inlined_media(tmp_path: Path, template: str) -> None:
    root = server._video_skill_dir() / 'assets/huashu-motion'
    config = json.loads((root / 'templates' / template / 'template.json').read_text(encoding='utf-8'))
    for source, destination in config.get('copy', {}).items():
        if destination.startswith('assets/') and not destination.startswith('assets/fonts/'):
            target = tmp_path / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / source, target)
    for asset in (root / 'templates' / template / 'assets').glob('*'):
        if asset.is_file():
            target = tmp_path / 'assets' / asset.name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(asset, target)
    source = (root / 'templates' / template / 'index.html').read_text(encoding='utf-8')
    path, _, _ = _scene(tmp_path, source, {'cues': []}, duration=8, resolution='1920x1080', subtitles=False)
    frames, _, _ = await _capture(path, [.6, 3.1, .6], duration=8, design_size=(1920, 1080))
    assert frames[0] == frames[2]
    assert frames[0] != frames[1]


async def test_real_gsap_uses_actual_word_seconds_and_repeatable_seeks(tmp_path: Path) -> None:
    source = _film("tl.to('#dot',{attr:{cx:250},duration:1,ease:'none'},OM.cue('second'));",
                   '<svg width="320" height="180"><circle id="dot" cx="20" cy="70" r="14" fill="red"/></svg>')
    path, _, _ = _scene(tmp_path, source, subtitles=False)
    frames, reports, _ = await _capture(path, [.5, 1.4, 1.8, .5, 1.8, 2.7])
    assert frames[0] == frames[1] == frames[3]  # The phrase starts before the actual second word.
    assert frames[2] == frames[4]
    assert _red_center(frames[0]) == pytest.approx(20, abs=1)
    assert _red_center(frames[2]) == pytest.approx(66, abs=1)
    assert _red_center(frames[5]) == pytest.approx(250, abs=1)
    assert len({item['motionSignature'] for item in reports}) == 3


async def test_caption_changes_do_not_count_as_subject_animation(tmp_path: Path) -> None:
    path, _, _ = _scene(tmp_path, _film('', '<p>Static subject</p>'))
    frames, reports, _ = await _capture(path, [.5, 1.8, 2.8])
    assert frames[0] != frames[1]
    assert frames[0] == frames[2]
    assert len({item['motionSignature'] for item in reports}) == 1


async def test_scene_slice_matches_same_frame_in_shared_film(tmp_path: Path) -> None:
    source = _film("tl.to('#dot',{attr:{cx:250},duration:2,ease:'none'},OM.cue('move'));",
                   '<svg width="320" height="180"><circle id="dot" cx="20" cy="70" r="14" fill="red"/></svg>')
    for name in ('scene_sources', 'style', 'audio'):
        (tmp_path / name).mkdir()
    (tmp_path / 'scene_sources/film.html').write_text(source, encoding='utf-8')
    (tmp_path / 'style/design-system.json').write_text(json.dumps(_style()), encoding='utf-8')
    (tmp_path / 'audio/scene_02.timing.json').write_text(json.dumps({
        'words': [{'text': 'move', 'startMs': 0, 'endMs': 2000}], 'cues': [],
    }), encoding='utf-8')
    scenes = [{'index': i, 'duration': length, 'authoredRuntime': 'huashu-motion',
               'sourcePath': 'scene_sources/film.html'} for i, length in ((1, 1), (2, 2))]
    meta = {'resolution': '320x180', 'authoringMode': 'huashu-motion', 'narrationEnabled': False,
            'scenes': scenes, 'composition': {'sourcePath': 'scene_sources/film.html',
                                            'htmlPath': 'composition/index.html'}}
    assert refresh_huashu_composition(tmp_path, meta)
    assert [scene['compositionStartSeconds'] for scene in scenes] == [0, 1]
    full, _, _ = await _capture(tmp_path / 'composition/index.html', [.5, 1.5])
    sliced, _, _ = await _capture(tmp_path / 'scenes/scene_02.html', [.5], duration=2)
    assert sliced[0] == full[1]
    assert _red_center(full[0]) == pytest.approx(20, abs=1)
    assert _red_center(sliced[0]) == pytest.approx(77.5, abs=1)


async def test_missing_cue_and_javascript_exception_fail_explicitly(tmp_path: Path) -> None:
    for name, script, message in (
        ('cue', "OM.cue('missing-word');", 'no cue "missing-word"'),
        ('exception', "throw new Error('broken-authored-film');", 'broken-authored-film'),
    ):
        path, _, _ = _scene(tmp_path / name, _film(script))
        with pytest.raises(RuntimeError, match=message):
            await _capture(path, [0])


def test_external_scripts_and_unsafe_or_missing_assets_are_rejected(tmp_path: Path) -> None:
    outside = tmp_path / 'outside.png'
    Image.new('RGB', (2, 2), 'red').save(outside)
    for content in (
        '<script src="https://example.com/remote.js"></script>',
        '<script src="vendor/../../outside.js"></script>',
        '<img src="assets/../../outside.png">',
        '<img src="assets/%2e%2e/%2e%2e/outside.png">',
        '<img src="assets/missing.png">',
    ):
        with pytest.raises(ValueError, match='素材|脚本'):
            _scene(tmp_path / 'project', _film('', content))


async def test_unmodified_whiteboard_template_loads_fonts_and_renders(tmp_path: Path) -> None:
    source = (server._video_skill_dir() / 'assets/huashu-motion/templates/whiteboard/index.html').read_text(encoding='utf-8')
    path, _, _ = _scene(tmp_path, source, {}, duration=10, resolution='1920x1080', subtitles=False)
    frames, reports, fonts = await _capture(path, [1.5, 5, 9, 5], duration=10,
                                          design_size=(1920, 1080), inspect_fonts=True)
    assert frames[1] == frames[3]
    assert len(set(frames)) == 3
    for frame in frames:
        with Image.open(io.BytesIO(frame)) as image:
            dark = sum(count for count, color in image.convert('RGB').getcolors(320 * 180)
                       if max(color) < 150)
        assert dark > 30, 'The real template must draw content rather than an empty canvas'
    assert len({item['motionSignature'] for item in reports}) >= 3
    assert fonts and all(face['status'] == 'loaded' for face in fonts)
    assert any(face['family'] == 'LXGWWenKai-500' for face in fonts)
