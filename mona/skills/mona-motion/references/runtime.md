# Mona · Mona Motion runtime

The sole new-film runtime is Mona Motion v0.3.1. Its exact source, templates,
fonts and license notices live at assets/huashu-motion/ (fixed provenance.json).
Creative references are in huashu-motion/. The standalone installer, Studio,
voice and renderer commands are not Mona's execution interface.

Write drafts/film.html with a complete head/body and a root such as:

```html
<div id="film" data-composition-id="film" data-width="1920" data-height="1080">
  <svg width="1920" height="1080"><circle id="subject" cx="200" cy="400" r="80" fill="var(--mona-primary)"/></svg>
</div>
<script>
const tl = gsap.timeline({paused: true});
tl.to('#subject', {attr:{cx:1000}, duration:1, ease:'power2.inOut'}, OM.cue('关键字'));
tl.to({}, {duration:.8});
window.__timelines = {film: tl};
</script>
```

Mona injects the actual GSAP, om-engine and OM scripts before author code.
Upstream vendor/gsap.min.js and vendor/om.js tags are recognized; vendor/clip/,
vendor/three/ and vendor/camera-rig.js load only matching bundled Huashu files.
Other script paths and network loading fail. Local assets/ and style/assets/
media are inlined after resolved-path checking. Import/register project media
before using it; never substitute guessed file paths or remote URLs.

The one film spans sum(scene.duration) seconds, using actual post-TTS durations.
OM.cue('word', nth?, 'end'?) and OM.words() use measured project-global cue times
in seconds; a missing word is an error. Use returned timing, not guessed reading
speed. See the original Huashu contract, grammars and camera/3D references for
actual helper APIs; reuse their source rather than inventing method names.

OM.clock(tl, t => draw(t), duration), OM.spring, OM.random(seed), OM.camera and
new Huashu template grammars are available. Canvas/WebGL must redraw from the
current time and await preparation with OM.ready. Forward/backward seeking must
produce the same frame. Preserve the shared style variables, subtitle safe area
and muted media contract. No React/TSX/Remotion or independent old drawing kit.

sync saves scene_sources/film.html and prepared composition/index.html. Per-scene
HTML files are generated time slices of this composition. The full preview and
export load that single full document; a segment preview maps local seconds to
its cumulative global offset. Do not write canonical files or forge metadata.
