# PAL: palettes

Methods are available from createMotionToolkit / MotionCanvas kit. These are signatures from the adapted source, not executable code. P means PAINT; R means RIG. Use shared theme and actual speech timing.

```js
PAL.names()
PAL.resolve(theme) // palette name or {name?, bg, surface, ink, sub, accent, accent2}; see PAL.KEYS at runtime
PAL.rgb(color)
PAL.hex(rgb)
PAL.mix(colorA, colorB, progress)
PAL.alpha(color, opacity)
PAL.lum(color)
PAL.contrast(colorA, colorB)
PAL.dark(palette)
PAL.on(background, candidates)
```

Source: [upstream MIT library](https://github.com/alchaincyf/huashu-art-motion/blob/64cb27271ee0ad3375298e2890b33cbec36d4051/scripts/engine/lib/palettes.js). Mona uses isolated instances; omit external engine globals, author presets and external resource loaders. Font binaries/stroke-order data are not bundled.
