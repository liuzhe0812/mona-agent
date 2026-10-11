# Upstream source and adaptations

The copied components and locale dictionaries below come from the local
`D:\liuzhe\Desktop\code\ZCode`
checkout. ZCode is Apache-2.0; the license text is retained in `../LICENSE`.
`reasoning.tsx` also retains its Vercel AI Elements attribution and Apache-2.0
header. The corresponding local ZCode third-party notice identifies Vercel, Inc.
Copyright 2023 and `packages/ui/src/components/ai-elements/reasoning.tsx`.

| Mona file | Local ZCode source | Source SHA-256 |
| --- | --- | --- |
| `components/ai-elements/reasoning.tsx` | `packages/ui/src/components/ai-elements/reasoning.tsx` | `a10a38c7b3ca633e9b5480ad94f9c7a1fdd52bc5526ae0801e3e6ed141f2b604` |
| `ToolCallBlocks/QueuedSummaryContent.tsx` | `packages/ui/src/ToolCallBlocks/QueuedSummaryContent.tsx` | `a4ef50ccadba57b42c5300591a0a7c3546a376794f8c0569f9f62bd09dbc0c8f` |
| `ToolCallBlocks/ToolSummaryRow.tsx` | `packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx` | `81a0c2f954a73b81ff4ed113d56a3fb6b594d66e3a8358c910a2a25cef922715` |
| `ToolCallBlocks/ToolLayout.tsx` | `packages/ui/src/ToolCallBlocks/ToolLayout.tsx` | `91ca396f414fcafc915c010d0e67b0199c6c1f7ac090c24d857bb4ea7cb70367` |
| `mentions/components/scrollMask.ts` | `packages/ui/src/mentions/components/scrollMask.ts` | `e542fa2718d6dfb68316a438a7feafb3b29211fcaf9b4ef5ca47dea2c8a4002f` |
| `components/ui/collapsible.tsx` | `packages/ui/src/components/ui/collapsible.tsx` | `e00f7ad26cc4c168f8c6b20e6078512807ddca05e375e47b6c9dbbd50fcbef52` |
| `components/ui/button.tsx` | `packages/ui/src/components/ui/button.tsx` | `3bf0b1573c940999f875a1dd5e67a32e7d9bcb3e320774fa8277f5c00748b32b` |
| `components/ui/tooltip.tsx` | `packages/ui/src/components/ui/tooltip.tsx` | `301dbf3a6f8b1bc496f9bdc6fbc5fe6202ed373182897f39cd1ecd19b00fdfbe` |
| `locales/zh-CN.ts` | `packages/ui/src/i18n/locales/zh-CN.ts` | `7fb2202f7179a24fcbb2b1bc6f820da621fa205f7f6faa4ccd53120734ca9fc6` |
| `locales/en-US.ts` | `packages/ui/src/i18n/locales/en-US.ts` | `ca1ea1321e3de199f7e09864784020041265d2096b56221e352d0742468af1d9` |

Adaptations are limited to import paths, using Mona's `cn`, direct Radix package
entry points, local test-id strings with the same upstream values, and a
`.zcode-stream` host around the Tooltip portal content so the copied scoped
utilities apply after portaling. The reasoning attribution comment points to
this notice. `intl.ts` supplies the original ZCode `zh-CN` and `en-US`
message data for reasoning, history status, tool renderers, and Markdown UI. It
uses the complete source locale dictionaries with the same raw-ID fallback and
`{key}` substitution as ZCode's local `IntlProvider`. Mona's Traditional Chinese
locale uses upstream Simplified
Chinese strings because ZCode ships only `zh-CN` and `en-US` for these messages.
The `uiMemoryDiagnosticsRegistry` registration was removed from `ToolLayout.tsx`;
it only reported the size of its open-state map and did not affect component
behavior.

Dependencies declared by ZCode `packages/ui/package.json` include
`radix-ui@^1.4.3`, `class-variance-authority@^0.7.1`, `motion@^12.38.0`,
`@radix-ui/react-use-controllable-state@^1.2.2`, and `lucide-react@^1.17.0`.
The local ZCode lockfile resolves Motion and controllable-state to `12.38.0` and
`1.2.2`. It resolves `@radix-ui/react-collapsible@1.1.12` transitively through
`radix-ui`; ZCode does not declare it directly in `packages/ui/package.json`.
Mona already declares the direct slot and tooltip packages (`@radix-ui/react-slot`
`^1.1.1`, `@radix-ui/react-tooltip` `^1.1.6`) and the `clsx`,
`tailwind-merge`, and `class-variance-authority` helpers.
