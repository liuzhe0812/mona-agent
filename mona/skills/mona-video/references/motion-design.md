# Narration-led motion design

The purpose of a scene is the change in the viewer's understanding. Identify
that change before choosing effects. A confirmed plan sets the story and visual
intention; the Agent remains free to compose and choreograph its implementation.

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

## Reference sources

- [Remotion animation guidance](https://www.remotion.dev/docs/animating-properties): frame-driven deterministic animation.
- [Remotion spring](https://www.remotion.dev/docs/spring): physical easing.
- [Remotion paths](https://www.remotion.dev/docs/paths): drawing, sampling and morphing geometry.
- [Huashu Design](https://github.com/alchaincyf/huashu-design): lightweight storyboard cards, art direction and motion critique.
- [HyperFrames animation](https://github.com/heygen-com/hyperframes/tree/main/skills/hyperframes-animation): choreography, phases, transitions and runtime recipes.
- [Remotion motion graphics examples](https://github.com/Liamrjohnston/remotion-motion-graphics-skill): continuous spatial worlds and camera choreography. Evaluate examples without inheriting product-specific approval gates or marketing quality claims.
