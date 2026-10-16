# Huashu Canvas libraries

These adapted source files come from [alchaincyf/huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion), commit `64cb27271ee0ad3375298e2890b33cbec36d4051`.

The upstream MIT license is included in `LICENSE`. Each library is wrapped in an instance installer so its `window` namespace and stage state belong to one `createMotionToolkit` call. No upstream renderer or font binaries are included. The author-specific rig module and `TOON.LOOKS.author` preset are omitted. The generic whiteboard path timeline remains; it accepts paths supplied by the caller and includes no stroke-order dataset.
