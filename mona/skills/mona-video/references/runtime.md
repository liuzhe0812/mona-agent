# Mona animation runtime

Use the existing Remotion composition clock and production tools. The bundled
Huashu drawing code is an optional toolkit, not another renderer or a restricted
scene menu. Read the matching [creative references](huashu/index.md) first.

The copied Dashi library is available as `Dashi` from mona-video and as
`kit.DASHI` in MotionCanvas. Its drawing/easing/transition algorithms retain the
upstream source; only the module boundary is adapted. Use frame/fps for its
seconds and cue() for speech anchors. Functions include paper/paperDrop,
neonText, push/shift, erase/pageTurn/iris/sweep, shake/anticipate, ease and hash.
Read the copied function signatures before use; transitions and secondary
effects serve the actual scene, not a quota. The complete style templates are
available through the [creative library](creative-library.md).

## MotionCanvas

```tsx
import {MotionCanvas} from 'mona-video';

export default function Scene() {
  return <MotionCanvas draw={(ctx, seconds, kit, clock) => {
    const {frame, fps, width, height, theme, cue} = clock;
    const spoken = cue('the actual spoken phrase');
    const progress = kit.MO.seg(seconds, spoken.startFrame / fps, spoken.endFrame / fps);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = theme.primary;
    ctx.beginPath();
    ctx.arc(width * (.2 + .6 * progress), height * .4, height * .06, 0, Math.PI * 2);
    ctx.fill();
  }} />;
}
```

The component creates one isolated toolkit per Canvas, clears drawing state at
each frame, and invokes draw at frame/fps. Forward, backward and repeated seeks
must produce the same image. Reconstruct or memoize a timeline from immutable
data; never append strokes or accumulate transforms during draw. The clear does
not clear cached artwork, so cache keys must include the content/style they hold.
Do not depend on timers, mutable counters, Date.now or unseeded randomness.

clock.theme supplies actual shared CSS values: bg, surface, primary, secondary,
accent, text-primary, text-secondary, border, heading-family and body-family.
Canvas cannot interpret CSS var() as a color: use these resolved values.
Pass theme fonts/colors to library methods when appropriate; built-in recipe
palettes are examples, not an override of the approved style. Sizes use the
actual width/height; redesign portrait compositions instead of squeezing a wide
scene into a tall viewport. Keep the project subtitle safe area clear.

cue(phrase) uses provider word boundaries, including words nested in subtitle
cues, before falling back to whole-cue timing. If the supplied track is estimated
or has no word boundaries, treat its anchors at that precision and verify the
resulting actions. Preview also reports invalidSvgPaths when a path contains an
unresolved literal expression, captionLineWidths and undefinedStyleVariables;
these are specific execution/layout observations, not a complete SVG validator
or a creative score.

Authorized images can be prepared with `assets={{evidence: 'approved-asset-id'}}`.
MotionCanvas waits for decoding before capture and exposes them as kit.images.
Use `kit.MD.cover(ctx, kit.images.evidence, {fx, fy, z})` or Canvas drawImage.
An ID must already belong to this scene. Missing or invalid images fail the
preview; never put URLs, file paths or image-download logic in this property.
Use muted Remotion video components for footage. Narration and imported music,
effects or source sound use the workbench's audioTracks in project-global seconds.
The same mix plays in preview and export; Canvas introduces no separate audio track.

## Mechanisms available

| Toolkit namespace | Useful capabilities |
| --- | --- |
| U | Seeded randomness, geometry, interpolation and per-instance stage dimensions |
| PAINT / BRUSH / RENDER / POST | Cached artwork, texture, brush/stroke treatments, painting and post effects |
| PAL / KIT | Art palettes, patterns and reusable illustration details |
| MO | Easing, stagger, spring, pose settling and intentional stepped time |
| CAM | Keyframe cameras, push/pull/glide/emphasis, parallax and motion blur |
| DG | Arc-length drawing, geometry resampling/morphs, diagrams, signal flow, cumulative whiteboard and pen |
| TY | Typography, word entrance, counters and writing/reveals |
| CH | Scales, grids, bars, lines, candles and timed annotations |
| UI | UI/spotlight/material primitives for relevant product explanations |
| CL / MD | Paper/collage treatments, authentic image framing, crop/focus and labels |
| TOON / RIG | Neutral character drawing, poses, expressions, blink and generic joint rigs |

`createMotionToolkit(width, height, {images?, voiceEnvelope?})` is also exported
for custom React/SVG/Canvas integrations. It returns these namespaces plus
images. It does not load scripts, fonts, URLs or audio. Use a memoized instance
with actual composition dimensions. A voice envelope, if independently prepared
from authorized audio, has `{fps, a: number[]}`; without one, mouth motion is not
speech-envelope driven. Do not claim accurate lip sync from arbitrary oscillation.

Detailed function signatures are in the [API index](runtime-api/index.md).
Load only the needed namespace. Upstream examples using window globals should
instead use the returned kit. Author-specific shapes, character art, font
payloads, external renderer and third-party Chinese stroke data are not bundled.

## Complete source examples

- [Object transformation](examples/object-transform.tsx): preserve object identity while morphing; move the camera only to explain the next view.
- [Cumulative whiteboard](examples/whiteboard.tsx): relationships build on the same board, then a pullback reveals the whole.
- [Data development](examples/data-change.tsx): axes, growing values and a timed comparison. Values are expressly demonstration data and must be replaced with grounded content.

These sources default-export real Remotion components. Read them with
skill_reference_read and adapt them into drafts/. Their cue phrases must exist
in the confirmed narration. They illustrate mechanisms, not required compositions.
Use React/SVG freely for labels, transitions or a more suitable custom treatment.

## Observe

Preview at speech anchors and between them. Read motionReview as observations
about sampled pixels: it can highlight a still interval, not prove that an action
explains speech, is smooth or has good rhythm. Review complete playback for those
questions. Verify important frames in reverse/repeated order, and inspect image
loading and neutral character details in a real browser before exporting.

Upstream: [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion/tree/64cb27271ee0ad3375298e2890b33cbec36d4051), MIT code/docs with explicit asset exceptions.
