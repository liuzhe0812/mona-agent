# Dashi motion effects

Source: `pipeline/动效部件.js` from [dashi-animationstyle](https://github.com/chuspeeism/dashi-animationstyle/tree/aa620f3b859aa5d191b783b2eb0fb59263731c76), under MIT. The complete unchanged upstream tree is preserved at `mona/skills/mona-video/assets/dashi-animationstyle/`; this directory includes the copied `LICENSE`.

The effect algorithms and timing remain unchanged. The only code adaptation replaces the upstream IIFE's `window.动效` assignment with the named ES module export `dashiMotionEffects`, so esbuild can bundle it into Mona's existing Remotion runtime. Canvas and DOM access occurs when the effects are invoked inside the isolated browser rendering context. Upstream installation, subtitle, audio, and Chrome/FFmpeg rendering instructions remain reference material, not runtime entry points.
