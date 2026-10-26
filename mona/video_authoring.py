"""Prepare Huashu Motion's single film for isolated preview and rendering."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote


def _script_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def _resource_root() -> Path:
    return Path(__file__).parent / "skills/mona-video/assets/huashu-motion"


def _script(source: str) -> str:
    return "<script>" + source.replace("</script", "<\\/script") + "</script>"


def _font_stack(value: str, field: str) -> str:
    from mona.video_scene_compiler import _font

    return ",".join(json.dumps(name) for name in dict.fromkeys([
        _font(value, field), "Noto Sans SC", "Microsoft YaHei", "PingFang SC",
    ])) + ",sans-serif"


def _embed_media(source: str, project_dir: Path) -> str:
    types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
             ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".woff2": "font/woff2",
             ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml"}
    root = project_dir.resolve()

    def asset(value: str) -> str:
        value = unquote(value)
        if value.startswith(("data:", "blob:", "#")):
            return value
        if value.startswith("vendor/"):
            return value
        relative = value.removeprefix("../").removeprefix("./")
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not relative.startswith(("assets/", "style/assets/")):
            raise ValueError("画面素材必须来自当前视频的素材目录")
        if not path.is_file() and relative.startswith("assets/fonts/"):
            path = (_resource_root() / "fonts" / Path(relative).name).resolve()
            if not path.is_relative_to((_resource_root() / "fonts").resolve()):
                raise ValueError("字体路径无效")
        mime = types.get(path.suffix.lower())
        if not mime or not path.is_file():
            raise ValueError("画面素材不可用，请先添加素材")
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"

    source = re.sub(r'''(?i)(\b(?:src|poster|href|xlink:href)\s*=\s*)(["'])([^"']+)\2''',
                    lambda m: m[1] + m[2] + asset(m[3]) + m[2], source)
    def css_asset(match: re.Match[str]) -> str:
        value = match[2].strip()
        if not value.startswith(("assets/", "style/assets/", "data:", "blob:", "#")) and ("+" in value or "${" in value):
            return match[0]
        return 'url("' + asset(value) + '")'

    source = re.sub(r'''(?i)url\(\s*(["']?)([^"')]+)\1\s*\)''', css_asset, source)
    return re.sub(r'''(["'])((?:assets|style/assets)/[^"'<>]+\.(?:png|jpe?g|webp|gif|mp4|webm|svg|woff2?|ttf))\1''',
                  lambda m: m[1] + asset(m[2]) + m[1], source)


def _inline_libraries(source: str) -> tuple[str, dict[str, str]]:
    root = _resource_root().resolve()
    fonts: dict[str, str] = {}

    def inline(match: re.Match[str]) -> str:
        name = unquote(match[2]).removeprefix("./")
        if name in {"vendor/gsap.min.js", "vendor/om.js", "vendor/om-engine.js"}:
            return ""
        if not name.startswith("vendor/") or ".." in Path(name).parts or "\\" in name:
            raise ValueError("画面脚本只能使用内置动画资源")
        relative = name.removeprefix("vendor/")
        if relative in {"three.min.js", "om-three.js"}:
            relative = "three/" + relative
        path = (root / "runtime" / relative).resolve()
        if not path.is_relative_to(root / "runtime") or path.suffix != ".js" or not path.is_file():
            raise ValueError("内置动画脚本不可用")
        code = path.read_text(encoding="utf-8")
        if relative == "clip/clip.js":
            for filename in re.findall(r"['\"]([^'\"]+\.woff2?)['\"]", code):
                font = root / "fonts" / filename
                if font.is_file():
                    fonts[filename] = "data:font/woff;base64," + base64.b64encode(font.read_bytes()).decode("ascii")
            code = code.replace("C.fontDir + FACES[f][0]", "window.__monaFonts[FACES[f][0]]")
        return _script(code)

    source = re.sub(r'''(?is)<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>\s*</script\s*>''', inline, source)
    if re.search(r"(?i)<script\b[^>]*\bsrc\s*=", source):
        raise ValueError("画面不能加载外部脚本")
    return source, fonts


def _style_css(style: Mapping[str, Any], width: int, height: int) -> str:
    from mona.video_scene_compiler import _color, _tokens

    t = _tokens(style)
    typography = (style.get("tokens") or {}).get("typography") or {}
    subtitle = style.get("subtitle") or {}
    size = max(48 if height > width else 36, float(subtitle.get("fontSize") or 0))
    bottom = max(.08, float(subtitle.get("safeAreaBottom") or .08))
    accent = _color(((style.get("tokens") or {}).get("colors") or {}).get("accent") or t["primary"], "accent")
    return f""":root{{--mona-primary:{t['primary']};--mona-secondary:{t['secondary']};--mona-accent:{accent};
--mona-bg:{t['background']};--mona-surface:{t['surface']};--mona-text-primary:{t['textPrimary']};
--mona-text-secondary:{t['textSecondary']};--mona-border:{t['border']};
--mona-heading-family:{_font_stack(typography.get('headingFamily') or 'Microsoft YaHei', 'headingFamily')};
--mona-body-family:{_font_stack(typography.get('bodyFamily') or 'Microsoft YaHei', 'bodyFamily')};
--mona-title-size:96px;--mona-body-size:{48 if height > width else 38}px;
--mona-spacing-unit:{t['spacingUnit']}px;--mona-content-padding:{t['contentPadding']}px;--mona-card-radius:{t['radius']};}}
*{{box-sizing:border-box}}html,body{{margin:0;width:{width}px;height:{height}px;overflow:hidden}}
body{{background:var(--mona-bg);color:var(--mona-text-primary);font-family:var(--mona-body-family)}}
#mona-subtitles{{position:absolute;z-index:2147483640;left:8%;right:8%;bottom:{bottom * 100}%;font-family:var(--mona-body-family);
font-size:{size}px;line-height:1.4;color:var(--mona-text-primary);background:var(--mona-bg);padding:.25em .5em;text-align:center;pointer-events:none}}
#mona-subtitles:empty{{display:none}}"""


def _inner_document(source: str, project: Path, meta: Mapping[str, Any], style: Mapping[str, Any], cues: list[dict], words: list[dict]) -> str:
    if not source.strip() or re.search(r"(?i)<\s*(?:iframe|object|embed|base|form|audio)\b", source):
        raise ValueError("请保存完整动画页面；声音由视频工作台统一管理")
    if not re.search(r"(?i)<head\b[^>]*>", source) or not re.search(r"(?is)</body\s*>.*</html\s*>", source):
        raise ValueError("请保存包含完整 head 和 body 的动画页面")
    if not re.search(r"\bdata-composition-id\s*=", source):
        raise ValueError("画面缺少整片动画标识")
    source = _embed_media(source, project)
    source, fonts = _inline_libraries(source)
    source = re.sub(r'''(?is)<script\b[^>]*\bid\s*=\s*["']om-cues["'][^>]*>.*?</script\s*>''', "", source)
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    policy = "default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;media-src data: blob:;font-src data:;connect-src data:;frame-src 'none';object-src 'none';base-uri 'none';form-action 'none'"
    shown = cues if meta.get("narrationEnabled") and meta.get("subtitleMode", "burned") == "burned" else []
    variables = sorted(set(re.findall(r"var\(\s*(--[\w-]+)\s*\)", source)))
    prefix = f'<meta http-equiv="Content-Security-Policy" content="{policy}"><style>{_style_css(style, width, height)}</style>'
    prefix += _script(f"window.__omConfig={{video:'seek'}};window.__monaFilm={_script_json({'width': width, 'height': height, 'cues': shown, 'styleVariables': variables})};window.__monaFonts={_script_json(fonts)};")
    prefix += '<script type="application/json" id="om-cues">' + _script_json({"words": words}) + '</script>'
    for path in ("runtime/om-engine.js", "templates/blank/vendor/gsap.min.js", "runtime/om.js"):
        prefix += _script((_resource_root() / path).read_text(encoding="utf-8"))
    bridge = Path(__file__).parent / "skills/mona-video/runtime/mona-player.js"
    prefix += _script(bridge.read_text(encoding="utf-8"))
    source = re.sub(r"(?i)<html\b", '<html data-om-signature="off"', source, count=1)
    return re.sub(r"(?i)<head\b[^>]*>", lambda m: m[0] + prefix, source, count=1)


def _isolated_document(inner: str, width: int, height: int, *, offset: float = 0, duration: float) -> str:
    return f'''<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';img-src data: blob:;media-src data: blob:;font-src data:;frame-src about: data: blob:;connect-src data:;object-src 'none';base-uri 'none'">
<style>html,body{{margin:0;width:{width}px;height:{height}px;overflow:hidden}}iframe{{width:100%;height:100%;border:0}}</style></head><body>
<iframe id="canvas" sandbox="allow-scripts"></iframe><script>
window.__monaSceneReports=[];window.__monaReady=false;window.__monaSceneError='';
let sequence=0;const pending=new Map();const frame=document.getElementById('canvas');
window.addEventListener('message',event=>{{if(event.source!==frame.contentWindow)return;const d=event.data||{{}};
if(d.type==='mona-scene-ready')window.__monaReady=true;
if(d.type==='mona-scene-report'){{window.__monaSceneReports.push({{...d,seconds:d.seconds-{offset}}});if(d.error)window.__monaSceneError=d.error;}}
if(d.type==='mona-scene-seeked'){{const p=pending.get(d.requestId);if(p){{pending.delete(d.requestId);clearTimeout(p.timer);d.error?p.reject(new Error(d.error)):p.resolve(true);}}}}}});
window.__monaSeek=seconds=>new Promise((resolve,reject)=>{{if(window.__monaSceneError){{reject(new Error(window.__monaSceneError));return;}}
const requestId=++sequence;const timer=setTimeout(()=>{{pending.delete(requestId);reject(new Error('动画画面定位超时'));}},30000);
pending.set(requestId,{{resolve,reject,timer}});const send=()=>{{if(!pending.has(requestId))return;if(window.__monaSceneError){{clearTimeout(timer);pending.delete(requestId);reject(new Error(window.__monaSceneError));return;}}if(!window.__monaReady){{setTimeout(send,10);return;}}frame.contentWindow.postMessage({{type:'mona-scene-seek',seconds:Math.max(0,Math.min({duration},Number(seconds)||0))+{offset},requestId}},'*');}};send();}});
window.__timelines={{film:{{pause(){{return this;}},seek(t){{void window.__monaSeek(t).catch(e=>{{window.__monaSceneError=e.message;}});return this;}}}}}};
frame.srcdoc={_script_json(inner)};</script></body></html>'''


def composition_path(project: Path, meta: Mapping[str, Any]) -> Path | None:
    if meta.get("authoringMode") != "huashu-motion" or not meta.get("composition"):
        return None
    composition = meta["composition"]
    path = (project / "composition/index.html").resolve()
    if not isinstance(composition, dict) or composition.get("htmlPath") != "composition/index.html" or not path.is_relative_to(project.resolve()) or not path.is_file():
        raise ValueError("整片动画文件不可用，请重新制作后再预览或导出")
    if composition.get("preparedHash") and hashlib.sha256(path.read_bytes()).hexdigest() != composition["preparedHash"]:
        raise ValueError("整片画面与保存版本不一致，请重新制作后再预览或导出")
    return path


def _write_changed(path: Path, text: str) -> bool:
    if path.is_file() and path.read_text(encoding="utf-8") == text:
        return False
    from mona.video_style import _atomic_write_bytes

    _atomic_write_bytes(path, text.encode("utf-8"))
    return True


def refresh_huashu_composition(project: Path, meta: dict) -> bool:
    for directory in ("scene_sources", "composition", "scenes", "audio", "style"):
        if not (project / directory).resolve().is_relative_to(project.resolve()):
            raise ValueError("动画资源路径超出当前项目范围")
    source_path = project / "scene_sources/film.html"
    if not source_path.resolve().is_relative_to(project.resolve()) or not source_path.is_file():
        return False
    style = json.loads((project / "style/design-system.json").read_text(encoding="utf-8"))
    cues, words = [], []
    offset = 0.0
    for scene in meta.get("scenes") or []:
        timing = project / "audio" / f"scene_{int(scene['index']):02d}.timing.json"
        track = json.loads(timing.read_text(encoding="utf-8")) if timing.is_file() else {}
        cues.extend({**cue, "startMs": cue["startMs"] + offset * 1000, "endMs": cue["endMs"] + offset * 1000} for cue in track.get("cues") or [])
        raw = track.get("words") or [word for cue in track.get("cues") or [] for word in cue.get("words") or []] or track.get("cues") or []
        words.extend({"word": word.get("text", word.get("word", "")), "start": offset + word["startMs"] / 1000, "end": offset + word["endMs"] / 1000} for word in raw)
        scene["compositionStartSeconds"] = offset
        offset += float(scene.get("duration") or 5)
    inner = _inner_document(source_path.read_text(encoding="utf-8"), project, meta, style, cues, words)
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    documents = {project / "composition/index.html": _isolated_document(inner, width, height, duration=offset)}
    for scene in meta.get("scenes") or []:
        documents[project / "scenes" / f"scene_{int(scene['index']):02d}.html"] = _isolated_document(inner, width, height, offset=scene["compositionStartSeconds"], duration=float(scene.get("duration") or 5))
    previous = {path: path.read_bytes() if path.is_file() else None for path in documents}
    written = []
    changed = False
    try:
        for path, content in documents.items():
            if _write_changed(path, content):
                written.append(path)
                changed = True
    except Exception:
        from mona.video_style import _atomic_write_bytes

        for path in reversed(written):
            if previous[path] is None:
                path.unlink(missing_ok=True)
            else:
                _atomic_write_bytes(path, previous[path])
        raise
    if meta.get("composition"):
        meta["composition"]["preparedHash"] = hashlib.sha256(documents[project / "composition/index.html"].encode("utf-8")).hexdigest()
    for scene in meta.get("scenes") or []:
        path = project / "scenes" / f"scene_{int(scene['index']):02d}.html"
        scene["preparedHash"] = hashlib.sha256(documents[path].encode("utf-8")).hexdigest()
    return changed


def authored_scene_html(source: str, project_dir: Path, scene: Mapping[str, Any], meta: Mapping[str, Any], style: Mapping[str, Any], track: Mapping[str, Any] | None = None) -> str:
    cues = list((track or {}).get("cues") or [])
    raw = (track or {}).get("words") or [word for cue in cues for word in cue.get("words") or []] or cues
    words = [{"word": w.get("text", w.get("word", "")), "start": w["startMs"] / 1000, "end": w["endMs"] / 1000} for w in raw]
    inner = _inner_document(source, project_dir, meta, style, cues, words)
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    return _isolated_document(inner, width, height, duration=float(scene.get("duration") or 5))


def authored_scene_source_path(project_dir: Path, scene: Mapping[str, Any]) -> Path:
    if scene.get("authoredRuntime") == "huashu-motion":
        return project_dir / "scene_sources/film.html"
    suffix = ".tsx" if scene.get("authoredRuntime") == "remotion" else ".html"
    return project_dir / "scene_sources" / f"scene_{int(scene['index']):02d}{suffix}"


def refresh_authored_scene(project_dir: Path, scene: Mapping[str, Any], meta: Mapping[str, Any]) -> bool:
    if meta.get("authoringMode") != "huashu-motion" or not (project_dir / "scene_sources/film.html").is_file():
        return False
    refresh_huashu_composition(project_dir, meta)
    return True
