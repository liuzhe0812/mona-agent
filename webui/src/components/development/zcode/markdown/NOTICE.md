# ZCode Markdown renderer source

This renderer is copied from the local checkout at
`D:/liuzhe/Desktop/code/ZCode`, primarily from `packages/ui/src`. ZCode is
licensed under Apache-2.0; the license is retained at `../LICENSE`. ZCode's
`components/ai-elements/message.tsx` derives from Vercel AI Elements
(`packages/elements/src/message.tsx`, Copyright 2023, Apache-2.0).

`upstream-sources.json` lists each copied source file and its SHA-256 from the
local checkout. The MarkdownResponse component keeps the upstream Streamdown
plugins, normalization pipeline, memo comparison, streaming/static modes,
incomplete-Markdown handling, code renderer, and message components. No timed
text throttle is added.

Adaptations are limited to Mona's host boundary and missing desktop services:

- `ZCodeMarkdown` maps Mona's MarkdownContext `rootPath` and `openFile` into
  the original workspace props. Its copied image renderer reads local media
  through MarkdownContext `readMedia` after project-relative path validation.
- `MessageResponse` still exposes the upstream file, code-viewer, and external
  URL callbacks for host renderers. The development transcript only passes the
  `openFile` callback that Mona provides; absent callbacks follow the original
  non-interactive fallback. Without ZCode's desktop platform provider, both
  external-link menu choices go through the supplied Mona URL callback, matching
  the upstream no-platform branch.
- The inline file menu keeps open and path-copy actions. Mona has no installed
  editor or desktop `saveFile` service, so those optional platform actions use
  their upstream unavailable-host branch.
- Shared button and tooltip imports use the copied ZCode primitives. The
  Select primitive, toast host, and display components are copied into this
  directory. Portaled content and the toast root carry `zcode-stream` so the
  separately compiled styles apply outside the transcript subtree.
- Mona's MarkdownContext has no session attachment reader for
  `zcode-artifact://` references. Those references keep the source component's
  missing-reader fallback; workspace-local image paths use `readMedia`.

`tools/fileDisplay.tsx` and `primitives/{button,tooltip,intl}.tsx` are shared
from sibling ZCode adapters under `development/zcode`; their source records are
maintained alongside those modules.
