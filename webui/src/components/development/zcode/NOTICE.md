# ZCode streaming surface

The implementation baseline is the local source distribution at
`D:/liuzhe/Desktop/code/ZCode`. No GitHub source was fetched. The directory has
no Git metadata, so `upstream-sources.json` records original paths and SHA-256.
ZCode's Apache-2.0 license is retained in `LICENSE`; component-specific Vercel
attribution and the Material Icon Theme MIT notice are retained with their copies.

## Copied implementation

- Turn flow, work segments, duration formatting, loading rules, tool command
  classification, scroll ownership decisions, scroll memory, row-height cache,
  live-tail split, work header, marker row, copy action and time labels.
- `primitives/`: original reasoning/disclosure/summary queue/tool layout and UI
  primitives, plus complete upstream locale dictionaries.
- `tools/`: original tool identity registry, partial-input parser, grouping,
  execute/read/search/edit/todo/fallback renderers, outputs, file summaries,
  diffs and local icon assets.
- `markdown/`: original MessageResponse/Streamdown configuration, normalization,
  code/table/image/list/quote renderers, media dialogs and toast implementation.
- `preview/`: original DiffViewer and patch fallback used by Mona's right pane.
- `upstream-styles.css`: original stylesheet, compiled with Tailwind 4 and scoped
  to `.zcode-stream`. Generated CSS lives beside its source and is rebuilt by the predev/build
  hooks. Versioned aliases preserve upstream Lucide and class-merging behavior
  without changing the rest of Mona.

The subdirectories retain their detailed source manifests and adaptation notes.

## Pending guide queue

These UI files are directly adapted from the ZCode UI package, distributed under
Apache-2.0. The project-level `LICENSE` is retained above.

- `packages/ui/src/v4/pendingGuideProjection.ts` — SHA-256
  `93d206baa6636f0a02c9a645c026e5a201c7457036c4129889bc8a638300ff15`.
  Only host type imports are redirected; admitted-delivery projection behavior
  is unchanged.
- `packages/ui/src/v4/ConversationPendingGuideList.tsx` — SHA-256
  `1eee028e6bd1c32b9fc66dbd7e0e135b0a5bc85d83a97c2598773fbe67c186da`.
  Host queue/render types and intl imports are adapted, and Mona's
  `renderUserInput` callback replaces ZCode's `ConversationTurnRow` component.

## Host boundary

Mona maps its stable run/message/item IDs and tool names into the source row
contract. Its existing project API, file editor, native executors and right pane
provide real file/media/log/preview actions. Tooltip providers and portal scope
are supplied where ZCode's app Root formerly supplied them. Tailwind 3 host
transforms are neutralized inside the copied surface so they do not compose twice
with Tailwind 4 individual transforms.

The timeline binds the copied scroll logic to Mona's scroll element and navigator;
its measured history is virtualized and the active tail stays in normal document
flow. The adapter preserves the original visibility, grouping, disclosure,
summary playback, reading-position and streaming/static rendering decisions.

Platform-only services, workflow/communication protocols and `zcode-artifact://`
attachment readers are not fabricated. Missing host capabilities follow upstream
unavailable-host branches; Mona project resources keep their authenticated path
checks. Provider displayable thinking is a separate timeline stream. Codex raw
reasoning content, encrypted payloads and SDK signatures/redacted blocks are not
forwarded.
