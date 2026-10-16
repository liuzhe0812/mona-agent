# U: util

Methods are available from createMotionToolkit / MotionCanvas kit. These are signatures from the adapted source, not executable code. P means PAINT; R means RIG. Use shared theme and actual speech timing.

```js
U.clamp(x, a=0, b=1)
U.lerp(a, b, progress)
U.rng(seed) => seeded random function
U.ss(start, end, seconds)
U.seg(progress, start, end)
U.stepTime(seconds, fps)
U.onStage = f => ...
U.setStage = (w, h) => ...
U.loadCmaps = async (faces = window.FONT_FACES || []) => ...
U.missingGlyphs = (font, text) => ...
U.assertGlyphs = (font, text, where = '') => ...
```

Source: [upstream MIT library](https://github.com/alchaincyf/huashu-art-motion/blob/64cb27271ee0ad3375298e2890b33cbec36d4051/scripts/engine/lib/util.js). Mona uses isolated instances; omit external engine globals, author presets and external resource loaders. Font binaries/stroke-order data are not bundled.
