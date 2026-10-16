# Narration-led motion design

The purpose of a scene is the change in the viewer's understanding. Identify
that change before choosing effects. A confirmed plan sets the story and visual
intention; the Agent remains free to compose and choreograph its implementation.

Read this before video.plan as well as during production. Use the
[creative-library index](huashu/index.md) to select deeper art/grammar references.
The core skill already carries the essential director knowledge; do not load all
style recipes into every turn or require the user to choose library categories.

## Choose a visual mechanism

| Content goal | Mechanism to study and adapt |
| --- | --- |
| Explain scale or a mechanism | A spatial world with layers; follow one subject through changing scales rather than unrelated title pages. |
| Explain evidence | A real document/image fills the frame; marks reveal the relevant evidence; the camera follows a connection to the next source. |
| Build a relationship | Draw a cumulative board; keep earlier objects; connect them when the relationship is spoken; pull back to the complete model. |
| Tell a personal incident | Character poses and reaction shots carry cause and consequence; expressions and pauses give the incident rhythm. |
| Emphasize a short phrase | Let the word act through weight, collision, scale and rhythm; avoid making the whole narration a succession of giant words. |
| Explain mathematical change | Preserve object identity across transformations; map geometry/data to the actual operation, not an arbitrary morph. |
| Demonstrate a product | Use genuine UI/images; isolate the action with crops, masks and camera attention. Lighting/glass is optional, never mandatory decoration. |
| Explain quantities | Establish axes and units, grow the real data, reveal the important comparison, then hold the result. |
| Presenter-led explanation | Use an authorized character with gestures and expressions that respond to what is said; keep the explained object the main subject. |

These are composable mechanisms, not layouts. The library also contains art
recipes for material, shape, color and texture when that treatment suits the
subject. Start from the user's style, not an automatic visual overhaul.

## Design a continuous sequence

Write internal beats as time/anchor → object → action → camera → resolved state.
Several beats can fit inside one user-facing scene. Keep a concrete example
across related beats. A change in a criterion should change the comparison; a
signal should travel the connection just explained; a shape should transform
into the next concept while retaining recognizable features.

Reading time starts after the last item is fully legible. Use smooth camera
arrivals and meaningful pauses; a camera that repeatedly zooms every page can
still feel like a slide deck. A long quiet hold may be necessary for a diagram.
Choose durations, density and text length from the actual narration and audience,
not universal quotas. Use deterministic seeded textures and cached drawings;
changing noise on every frame is not explanatory animation.

The [runtime guide](runtime.md) documents ready-to-use mechanisms and complete
Remotion examples. Their content is illustrative: replace it with confirmed
narration, truthful data and authorized assets; keep freedom to implement a
better mechanism directly in React, SVG or Canvas.

## Translate speech into visible actions

| Spoken idea | Useful on-screen development |
| --- | --- |
| A process or causal chain | The active object moves through stages; its state changes; connections trace when the relationship is explained. |
| A comparison or decision | Alternatives share a baseline; a criterion becomes visible; consequences change the objects; the selected result settles. |
| A trend or quantity | Axes establish the scale; lines or bars grow at the narrated point; the meaningful difference receives focus. Never invent values. |
| A definition or transformation | A concrete object decomposes, rearranges or morphs to expose the idea; labels attach when useful. |
| An interface or product | Authentic footage provides context; a crop, camera move or annotation directs attention to the narrated action. |

Combine purposeful anticipation, spatial continuity, staggered actions, arcs,
path drawing, morphing, depth/parallax, spring settling, masks and camera movement.
Select the treatment for the subject and existing style. Avoid the same list
entrance throughout a video. Preserve time to understand the resolved result.

Each substantial scene has an initial state, a development tied to the spoken
point and an intelligible resolved state. Write the dominant action and its
speech anchor before coding. A background pulse or subtitle update does not
implement that action.

## A real speech anchor, free composition

```tsx
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {cue} from 'mona-video';

export default function Scene() {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const spoken = cue('比较方案'); // This phrase must exist in the confirmed speech.
  const progress = interpolate(frame, [spoken.startFrame, spoken.endFrame], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const settle = spring({frame: frame - spoken.startFrame, fps, config: {damping: 18}});
  return <AbsoluteFill style={{background: 'var(--mona-bg)'}}>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={`M ${width*.2} ${height*.4} L ${width*.75} ${height*.4}`}
        fill="none" stroke="var(--mona-border)" strokeWidth={6}
        pathLength={1} strokeDasharray={1} strokeDashoffset={1-progress}/>
      <circle cx={width*(.2+.55*progress)} cy={height*.4} r={30+8*settle}
        fill="var(--mona-primary)"/>
    </svg>
  </AbsoluteFill>;
}
```

This demonstrates a timing mechanism, not a visual template. Use Sequence/Series
for layered phases, path utilities for revealing/morphing geometry and
TransitionSeries for motivated handoffs. Camera transforms retain spatial
continuity and focus on the spoken idea. Clamp extrapolation and revisit frames
in reverse order during diagnosis to catch stateful animation.

## Inspect the work, not just the code

Read the contact sheet in time order. Locate the planned action's before, during
and after states and compare them with the real speech timestamps. Check that
information changes, the viewer can follow the active object, labels stay
readable, and the result holds before the next idea begins.

Playback remains necessary to judge continuous pacing and sound. A contact
sheet cannot certify smoothness, intelligibility or artistic quality. Technical
checks prevent silent/static/broken outputs; visual criticism evaluates whether
motion explains the content.

Review each important spoken claim against its visual action and timestamp.
Also review the complete sequence for attention, continuity, density and sound.
For a failure, record what was observed, its likely cause, the repair and the
frames/playback that verify it. Repeated motion does not demonstrate that a
concept was explained. Avoid grading your own intentions instead of the output.
The upstream fast-motion/color heuristics are not Mona's quality definition.

## Reference sources

- [Remotion animation guidance](https://www.remotion.dev/docs/animating-properties): frame-driven deterministic animation.
- [Remotion spring](https://www.remotion.dev/docs/spring): physical easing.
- [Remotion paths](https://www.remotion.dev/docs/paths): drawing, sampling and morphing geometry.
- [Huashu Art Motion](huashu/index.md): locally bundled art recipes, animation grammar, camera and review knowledge, adapted to Mona's existing execution contract.
- [Huashu Design](https://github.com/alchaincyf/huashu-design): lightweight storyboard cards, art direction and motion critique.
- [HyperFrames animation](https://github.com/heygen-com/hyperframes/tree/main/skills/hyperframes-animation): choreography, phases, transitions and runtime recipes.
- [Remotion motion graphics examples](https://github.com/Liamrjohnston/remotion-motion-graphics-skill): continuous spatial worlds and camera choreography. Evaluate examples without inheriting product-specific approval gates or marketing quality claims.
