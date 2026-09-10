import { resolve } from 'node:path'

type OfficeAlias = {
  find: string | RegExp
  replacement: string
}

export function officeAliases(officeEditorRoot: string): OfficeAlias[] {
  const vendorRoot = resolve(officeEditorRoot, 'vendor/genoffice')
  const nodeShims = resolve(officeEditorRoot, 'mona/node-shims.ts')

  return [
    {
      find: /^\.\/ai\/AiPanel$/,
      replacement: resolve(officeEditorRoot, 'mona/disabled-genoffice-ai.tsx'),
    },
    {
      find: /^\.\/ai\/AiChatPanel$/,
      replacement: resolve(officeEditorRoot, 'mona/disabled-genoffice-ai.tsx'),
    },
    {
      find: '@mona-xlsx-gateway',
      replacement: resolve(vendorRoot, 'apps/sheets/src/gateway/xlsx-gateway.ts'),
    },
    ...[
      'node:stream/promises',
      'node:fs/promises',
      'node:crypto',
      'node:fs',
      'node:path',
      'node:zlib',
    ].map((find) => ({
      find,
      replacement: nodeShims,
    })),
    {
      find: '@genoffice/ui/tokens.css',
      replacement: resolve(vendorRoot, 'packages/ui/src/tokens.css'),
    },
    {
      find: '@genoffice/ui/screentip.css',
      replacement: resolve(vendorRoot, 'packages/ui/src/screentip.css'),
    },
    {
      find: '@genoffice/ui/color-picker.css',
      replacement: resolve(vendorRoot, 'packages/ui/src/color-picker.css'),
    },
    {
      find: '@genoffice/ui/dropdown.css',
      replacement: resolve(vendorRoot, 'packages/ui/src/dropdown.css'),
    },
    {
      find: /^@genoffice\/ui$/,
      replacement: resolve(vendorRoot, 'packages/ui/src/index.ts'),
    },
    {
      find: /^@genoffice\/i18n$/,
      replacement: resolve(vendorRoot, 'packages/i18n/src/index.ts'),
    },
    {
      find: /^@genoffice\/font-metrics$/,
      replacement: resolve(vendorRoot, 'packages/font-metrics/src/index.ts'),
    },
    {
      find: /^@genoffice\/agent-core$/,
      replacement: resolve(officeEditorRoot, 'mona/disabled-genoffice-ai.tsx'),
    },
    {
      find: /^@genoffice\/ai-provider$/,
      replacement: resolve(vendorRoot, 'packages/ai-provider/src/index.ts'),
    },
    {
      find: /^@genoffice\/ai-search$/,
      replacement: resolve(vendorRoot, 'packages/ai-search/src/index.ts'),
    },
    {
      find: /^@genoffice\/file-parse$/,
      replacement: resolve(vendorRoot, 'packages/file-parse/src/index.ts'),
    },
    {
      find: /^@genoffice\/project-store$/,
      replacement: resolve(vendorRoot, 'packages/project-store/src/index.ts'),
    },
    {
      find: /^@genoffice\/pptx-render$/,
      replacement: resolve(vendorRoot, 'packages/pptx-render/src/index.ts'),
    },
    {
      find: '@genoffice/pptx-render/preset-geometry',
      replacement: resolve(vendorRoot, 'packages/pptx-render/src/preset-geometry.ts'),
    },
    {
      find: /^@genoffice\/pptx-engine$/,
      replacement: resolve(vendorRoot, 'packages/pptx-engine/src/index.ts'),
    },
    {
      find: '@genoffice/pptx-engine/custgeom',
      replacement: resolve(vendorRoot, 'packages/pptx-engine/src/custgeom.ts'),
    },
    {
      find: '@genoffice/pptx-engine/table-grid',
      replacement: resolve(vendorRoot, 'packages/pptx-engine/src/table-grid.ts'),
    },
    {
      find: '@genoffice/pptx-engine/identity',
      replacement: resolve(vendorRoot, 'packages/pptx-engine/src/identity.ts'),
    },
    {
      find: '@genoffice/pptx-engine/background-promote',
      replacement: resolve(vendorRoot, 'packages/pptx-engine/src/background-promote.ts'),
    },
    {
      find: /^@genoffice\/docx-engine$/,
      replacement: resolve(vendorRoot, 'packages/docx-engine/src/index.ts'),
    },
    {
      find: '@genoffice/docx-engine/math',
      replacement: resolve(vendorRoot, 'packages/docx-engine/src/math.ts'),
    },
    {
      find: '@genoffice/docx-engine/metafile',
      replacement: resolve(vendorRoot, 'packages/docx-engine/src/metafile.ts'),
    },
  ]
}
