# Upstream source examples (read-only)

These source examples are included for static reading only. Their source is [huashu-art-motion at commit 64cb27271ee0ad3375298e2890b33cbec36d4051](https://github.com/alchaincyf/huashu-art-motion/tree/64cb27271ee0ad3375298e2890b33cbec36d4051).

They are not Mona modules and must not be executed or imported as-is. SCENES/CLIPS registries, window globals, DOM helpers and drawing APIs belong to a different engine. Read the visual methods, then rewrite them using Mona MotionCanvas draw, kit and cue as described in [Mona runtime](../../runtime.md). No upstream loader, scene index, network loader, image, font, voice, video or other asset is included.

The scenes use generic upstream example characters and recurring sample compositions. They are code illustrations, not default subjects or fixed user templates. A signature string and a diagnostic global write were removed from the source examples; author-specific artwork and character assets were not copied.

## Art-style scene sources

Each local file maps to the correspondingly named source under upstream scripts/engine/scenes/. The original files are all present at the pinned commit. The registry/loading file index.js is excluded.

01_cave.js · 02_egypt.js · 03_greek.js · 04_roman.js · 05_gothic.js · 06_renaissance.js · 08_impressionism.js · 09_postimp.js · 10_nouveau.js · 11_cubism.js · 12_bauhaus.js · 13_pop.js · 14_8bit.js · 15_raytrace.js · 16_2026.js · 17_ink.js · 18_klimt.js · 19_munch.js · 20_dunhuang.js · 21_kusama.js · 22_constructivism.js · 23_dali.js · 24_hopper.js · 25_ghibli.js · 26_vaporwave.js · 27_kirby.js · 28_monet.js · 29_seurat.js · 30_matisse.js · 31_haring.js · 32_rembrandt.js · 33_rubberhose.js · 34_shadowpuppet.js · 35_shinkai.js · 36_picasso_blue.js

## Parameterized narration-grammar sources

These eight files are upstream animation code, not reusable Mona components. Each maps to the same-named file under the pinned commit's scripts/engine/clips/ directory:

- t1_3b1b.js
- t2_keynote_ui.js
- t3_finance_chart.js
- y1_kurzgesagt.js
- y2_vox.js
- y3_whiteboard.js
- y4_storytime.js
- y5_kinetic_type.js

Upstream y6 presenter grammar is a grammar card and full-film code snapshot, not one of these parameterized clips; no source file is fabricated for it.
