import react from '@vitejs/plugin-react'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { officeAliases } from './mona/build-aliases'

const officeEditorRoot = fileURLToPath(new URL('.', import.meta.url))
const entriesRoot = resolve(officeEditorRoot, 'entries')
const outputRoot = resolve(officeEditorRoot, '../dist/office-editor')

function systemFontsOnly(): Plugin {
  const isEditorStylesheet = (id: string) => {
    const sourcePath = id.replaceAll('\\', '/').split('?', 1)[0]
    return sourcePath.endsWith('/apps/slides/src/renderer/styles.css')
      || sourcePath.endsWith('/apps/sheets/src/renderer/styles.css')
  }
  const stripFontFaces = (code: string) => code.replace(/@font-face\s*\{[^}]*\}/g, '')
  return {
    name: 'mona-office-system-fonts-only',
    enforce: 'pre',
    resolveId(source, importer) {
      const parent = importer?.replaceAll('\\', '/') ?? ''
      if (/\.ttf(?:\?|$)/i.test(source) && parent.includes('/apps/sheets/src/renderer/')) {
        return { id: 'data:font/ttf;base64,', external: true }
      }
      return null
    },
    async load(id) {
      if (!isEditorStylesheet(id)) return null
      const code = await readFile(id.split('?', 1)[0], 'utf8')
      return { code: stripFontFaces(code), map: null }
    },
    transform(code, id) {
      if (!isEditorStylesheet(id)) return null
      return { code: stripFontFaces(code), map: null }
    },
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/\.(?:ttf|otf|woff2?)$/i.test(fileName)) delete bundle[fileName]
      }
    },
  }
}

function productionBoundary(): Plugin {
  const forbidden = /(^|[\\/_.-])(electron|pdf|ocr|example|fixture|test)(?=$|[\\/_.-])/i
  return {
    name: 'mona-office-production-boundary',
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith('.map') || /\.(?:ttf|otf|woff2?)$/i.test(fileName) || forbidden.test(fileName)) {
          const output = bundle[fileName]
          const sources = output?.type === 'asset' ? output.originalFileNames.join(', ') : ''
          throw new Error(`Disallowed production asset: ${fileName}${sources ? ` (${sources})` : ''}`)
        }
      }
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const moduleId of Object.keys(output.modules)) {
          if (forbidden.test(moduleId)) {
            throw new Error(`Disallowed production module: ${moduleId}`)
          }
        }
      }
    },
  }
}

function manualChunk(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/')
  if (
    normalized.includes('/node_modules/react/') ||
    normalized.includes('/node_modules/react-dom/') ||
    normalized.includes('/node_modules/scheduler/')
  ) {
    return 'shared-react'
  }
  // Let Rollup keep the Sheets engine and its dependencies out of other entries.
  if (
    normalized.includes('/vendor/genoffice/packages/ui/') ||
    normalized.includes('/vendor/genoffice/packages/i18n/') ||
    normalized.includes('/node_modules/@genoffice/')
  ) {
    return 'shared-genoffice-ui'
  }
  if (
    normalized.includes('/node_modules/harfbuzzjs/') ||
    normalized.includes('/node_modules/fast-xml-parser/') ||
    normalized.includes('/node_modules/jszip/') ||
    normalized.includes('/node_modules/bidi-js/') ||
    normalized.includes('/node_modules/opentype.js/') ||
    normalized.includes('/node_modules/utif2/') ||
    normalized.includes('/vendor/genoffice/packages/pptx-engine/') ||
    normalized.includes('/vendor/genoffice/packages/pptx-render/') ||
    normalized.includes('/vendor/genoffice/packages/docx-engine/')
  ) {
    return 'shared-format'
  }
  return undefined
}

export default defineConfig({
  root: entriesRoot,
  base: './',
  plugins: [react(), systemFontsOnly(), productionBoundary()],
  publicDir: false,
  resolve: { alias: officeAliases(officeEditorRoot) },
  css: { postcss: { plugins: [] } },
  esbuild: {
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        jsx: 'automatic',
        target: 'ES2022',
      },
    }),
  },
  build: {
    outDir: outputRoot,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        docs: resolve(entriesRoot, 'docs/index.html'),
        sheets: resolve(entriesRoot, 'sheets/index.html'),
        slides: resolve(entriesRoot, 'slides/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks: manualChunk,
      },
    },
  },
})
