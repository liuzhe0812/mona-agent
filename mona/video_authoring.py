"""Seekable, isolated scene documents authored by the video Agent."""

from __future__ import annotations

import base64
import html
import json
import math
import re
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote


def _script_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def _embed_media(source: str, project_dir: Path) -> str:
    types = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
             ".webm": "video/webm", ".woff2": "font/woff2", ".woff": "font/woff",
             ".ttf": "font/ttf", ".svg": "image/svg+xml"}
    root = project_dir.resolve()

    def asset(value: str) -> str:
        value = unquote(value)
        if value.startswith(("data:", "blob:", "#")):
            return value
        relative = value.removeprefix("../").removeprefix("./")
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or not relative.startswith(("assets/", "style/assets/")):
            raise ValueError("场景素材必须来自当前视频的素材目录")
        mime = types.get(path.suffix.lower())
        if not mime or not path.is_file():
            raise ValueError("场景素材不可用，请先添加素材")
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"

    source = re.sub(
        r'''(?i)(\b(?:src|poster|href|xlink:href)\s*=\s*)(["'])([^"']+)\2''',
        lambda match: match[1] + match[2] + asset(match[3]) + match[2], source,
    )
    return re.sub(
        r'''(?i)url\(\s*(["']?)([^"')]+)\1\s*\)''',
        lambda match: 'url("' + asset(match[2].strip()) + '")', source,
    )


def authored_scene_html(
    source: str,
    project_dir: Path,
    scene: Mapping[str, Any],
    meta: Mapping[str, Any],
    style: Mapping[str, Any],
    track: Mapping[str, Any] | None = None,
) -> str:
    """Apply shared style/subtitles without prescribing the scene's composition."""
    from mona.video_scene_compiler import _color, _fallback_gsap, _font, _tokens

    if not isinstance(source, str) or not source.strip():
        raise ValueError("场景代码不能为空")
    remotion = scene.get("authoredRuntime") == "remotion"
    if not remotion and re.search(r"(?i)<\s*(?:iframe|object|embed|base|form)\b|<script\b[^>]*\bsrc\s*=", source):
        raise ValueError("场景不能加载外部页面或脚本，请使用本地素材和内置动画能力")
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    index = int(scene["index"])
    duration = float(scene.get("duration") or 5)
    tokens = _tokens(style)
    tokens["accent"] = _color(((style.get("tokens") or {}).get("colors") or {}).get("accent") or tokens["primary"], "accent")
    typography = (style.get("tokens") or {}).get("typography") or {}
    subtitle = style.get("subtitle") or {}
    font_size = max(48 if height > width else 36, float(subtitle.get("fontSize") or 0))
    bottom = max(.08, float(subtitle.get("safeAreaBottom") or .08))
    style_css = f"""
:root {{ --mona-primary:{tokens['primary']}; --mona-secondary:{tokens['secondary']};
--mona-accent:{tokens['accent']}; --mona-bg:{tokens['background']};
--mona-surface:{tokens['surface']}; --mona-text-primary:{tokens['textPrimary']};
--mona-text-secondary:{tokens['textSecondary']}; --mona-border:{tokens['border']};
--mona-heading-family:{json.dumps(_font(typography.get('headingFamily') or 'Microsoft YaHei', 'headingFamily'))};
--mona-body-family:{json.dumps(_font(typography.get('bodyFamily') or 'Microsoft YaHei', 'bodyFamily'))};
--mona-title-size:96px; --mona-body-size:{48 if height > width else 38}px;
--mona-spacing-unit:{tokens['spacingUnit']}px; --mona-content-padding:{tokens['contentPadding']}px;
--mona-card-radius:{tokens['radius']};
--mona-heading-weight:{int(typography.get('headingWeight') or 700)};
--mona-body-weight:{int(typography.get('bodyWeight') or 400)}; }}
* {{ box-sizing:border-box; }} html,body {{ margin:0; width:{width}px; height:{height}px; overflow:hidden; }}
body {{ background:var(--mona-bg); color:var(--mona-text-primary); font-family:var(--mona-body-family),sans-serif;
font-size:var(--mona-body-size); font-weight:var(--mona-body-weight); line-height:{float(typography.get('bodyLineHeight') or 1.5)}; }}
h1,h2,h3 {{ font-family:var(--mona-heading-family),'Microsoft YaHei','PingFang SC',sans-serif; font-weight:var(--mona-heading-weight); line-height:{tokens['headingLineHeight']}; }}
h1 {{ font-size:var(--mona-title-size); }}
#mona-subtitles {{ position:absolute; z-index:2147483640; left:8%; right:8%; bottom:{bottom * 100}%;
font-family:var(--mona-body-family),sans-serif; font-size:{font_size}px; line-height:1.4;
color:var(--mona-text-primary); background:var(--mona-bg); padding:.25em .5em; text-align:center;
pointer-events:none; }} #mona-subtitles:empty {{ display:none; }}
"""
    if remotion:
        return _remotion_scene_html(source, project_dir, scene, meta, track, style_css, tokens["background"])
    source = _embed_media(source, project_dir)
    policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    prefix = f'<meta http-equiv="Content-Security-Policy" content="{policy}"><style>{style_css}</style><script>{_fallback_gsap()}\nwindow.__timelines = window.__timelines || {{}};</script>'
    if re.search(r"(?i)<head\b[^>]*>", source):
        if not re.search(r"(?i)</body\s*>", source) or not re.search(r"(?i)</html\s*>", source):
            raise ValueError("场景代码不完整，请保存完整页面后重试")
        source = re.sub(r"(?i)<head\b[^>]*>", lambda match: match[0] + prefix, source, count=1)
    else:
        source = '<!doctype html><html><head>' + prefix + '</head><body>' + source + '</body></html>'
    cues = list((track or {}).get("cues") or []) if meta.get("narrationEnabled") and meta.get("subtitleMode", "burned") == "burned" else []
    runtime = f"""<script>
(function() {{
  const cues={_script_json(cues)};
  const caption=document.createElement('div'); caption.id='mona-subtitles'; document.body.appendChild(caption);
  window.addEventListener('message',function(event) {{
    if(event.source!==window.parent || event.data?.type!=='mona-scene-seek') return;
    const seconds=Math.max(0,Math.min({duration},Number(event.data.seconds)||0));
    for(const timeline of Object.values(window.__timelines||{{}})) {{
      if(typeof timeline.pause==='function') timeline.pause(); if(typeof timeline.seek==='function') timeline.seek(seconds);
    }}
    if(typeof window.__monaSeek==='function') window.__monaSeek(seconds);
    const cue=cues.find(c=>seconds*1000>=c.startMs && seconds*1000<c.endMs);
    caption.textContent=cue?.text||'';
    const outside=[...document.querySelectorAll('h1,h2,h3,p,li,svg text')].filter(e=>{{
      const css=getComputedStyle(e),r=e.getBoundingClientRect();
      return css.display!=='none' && css.visibility!=='hidden' && Number(css.opacity)>0.1 && r.width>0 && r.height>0 &&
        (r.left < -1 || r.top < -1 || r.right>{width}+1 || r.bottom>{height}+1);
    }}).map(e=>e.textContent||'');
    window.parent.postMessage({{type:'mona-scene-report',seconds,outside}},'*');
  }});
}})();</script>"""
    source = re.sub(r"(?i)</body\s*>", lambda _m: runtime + '</body>', source, count=1)
    # An opaque iframe keeps authored JavaScript away from local files, app tokens,
    # and parent controls. The outer document owns all timeline seeking.
    outer_policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; frame-src about: data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{outer_policy}">
<style>html,body{{margin:0;width:{width}px;height:{height}px;overflow:hidden;background:{tokens['background']}}}
.scene,iframe{{position:absolute;inset:0;width:100%;height:100%;border:0}}</style></head><body>
<div class="scene" data-composition-id="scene-{index}" data-width="{width}" data-height="{height}" data-start="0" data-duration="{duration}">
<iframe id="canvas" sandbox="allow-scripts" srcdoc="{html.escape(source, quote=True)}"></iframe></div>
<script>{_fallback_gsap()}
window.__monaSceneReports=[];
window.addEventListener('message',event=>{{if(event.source===document.getElementById('canvas').contentWindow && event.data?.type==='mona-scene-report') window.__monaSceneReports.push(event.data);}});
window.__timelines={{'scene-{index}':{{pause(){{return this;}},seek(seconds){{document.getElementById('canvas').contentWindow.postMessage({{type:'mona-scene-seek',seconds}},'*');return this;}}}}}};
</script></body></html>"""


def authored_scene_source_path(project_dir: Path, scene: Mapping[str, Any]) -> Path:
    suffix = ".tsx" if scene.get("authoredRuntime") == "remotion" else ".html"
    return project_dir / "scene_sources" / f"scene_{int(scene['index']):02d}{suffix}"


def _remotion_scene_html(
    source: str, project_dir: Path, scene: Mapping[str, Any], meta: Mapping[str, Any],
    track: Mapping[str, Any] | None, style_css: str, background: str,
) -> str:
    from mona.video_assets import list_project_assets

    bundle = Path(__file__).parent / "skills" / "mona-video" / "runtime" / "remotion.js"
    if not bundle.is_file():
        raise ValueError("视频动画组件未随应用准备好，请更新应用后重试")
    width, height = map(int, str(meta.get("resolution") or "1920x1080").split("x"))
    duration = float(scene.get("duration") or 5)
    # A fixed composition clock remains independent of draft/output frame rate.
    fps = 60
    assets: dict[str, str] = {}
    for item in list_project_assets(project_dir):
        if item["id"] not in (scene.get("assets") or []):
            continue
        uri = re.search(r'src="([^"]+)"', _embed_media(f'<img src="{item["path"]}">', project_dir))
        if uri:
            assets[item["id"]] = uri[1]
            assets[item["path"]] = uri[1]
    payload = {"source": source, "scene": dict(scene), "width": width, "height": height,
               "fps": fps, "durationInFrames": max(1, math.ceil(duration * fps)),
               "assets": assets, "track": dict(track or {}),
               "showCaptions": bool(meta.get("narrationEnabled")) and meta.get("subtitleMode", "burned") == "burned"}
    policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    engine = bundle.read_text(encoding="utf-8").replace("</script", "<\\/script")
    inner = f'''<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{policy}"><style>{style_css}</style></head><body><div id="root"></div><div id="mona-subtitles"></div><script>window.__monaRemotion={_script_json(payload)};</script><script>{engine}</script></body></html>'''
    return f'''<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; frame-src about: data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<style>html,body{{margin:0;width:{width}px;height:{height}px;overflow:hidden;background:{background}}}iframe{{width:100%;height:100%;border:0}}</style></head><body>
<iframe id="canvas" sandbox="allow-scripts" srcdoc="{html.escape(inner, quote=True)}"></iframe>
<script>
window.__monaSceneReports=[]; window.__monaReady=false; window.__monaSceneError='';
let sequence=0; const pending=new Map();
window.addEventListener('message',event=>{{
  if(event.source!==document.getElementById('canvas').contentWindow) return;
  const data=event.data||{{}};
  if(data.type==='mona-scene-ready') window.__monaReady=true;
  if(data.type==='mona-scene-report'){{window.__monaSceneReports.push(data);if(data.error)window.__monaSceneError=data.error;}}
  if(data.type==='mona-scene-seeked'){{const task=pending.get(data.requestId);if(task){{pending.delete(data.requestId);clearTimeout(task.timer);data.error?task.reject(new Error(data.error)):task.resolve(true);}}}}
}});
window.__monaSeek=seconds=>new Promise((resolve,reject)=>{{
  if(window.__monaSceneError){{reject(new Error(window.__monaSceneError));return;}}
  const requestId=++sequence;
  const timer=setTimeout(()=>{{pending.delete(requestId);reject(new Error('动画画面定位超时'));}},30000);
  pending.set(requestId,{{resolve,reject,timer}});
  document.getElementById('canvas').contentWindow.postMessage({{type:'mona-scene-seek',seconds,requestId}},'*');
}});
window.__timelines={{'scene-{int(scene['index'])}':{{pause(){{return this;}},seek(seconds){{void window.__monaSeek(seconds).catch(error=>{{window.__monaSceneError=error.message;}});return this;}}}}}};
</script></body></html>'''


def refresh_authored_scene(project_dir: Path, scene: Mapping[str, Any], meta: Mapping[str, Any]) -> bool:
    if not scene.get("authored"):
        return False
    index = int(scene["index"])
    source_path = authored_scene_source_path(project_dir, scene)
    style_path = project_dir / "style" / "design-system.json"
    timing_path = project_dir / "audio" / f"scene_{index:02d}.timing.json"
    style = json.loads(style_path.read_text(encoding="utf-8"))
    track = json.loads(timing_path.read_text(encoding="utf-8")) if timing_path.is_file() else None
    rendered = authored_scene_html(source_path.read_text(encoding="utf-8"), project_dir, scene, meta, style, track)
    target = project_dir / "scenes" / f"scene_{index:02d}.html"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(target)
    return True
