import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const kind of ['docs', 'sheets', 'slides']) {
  const html = await readFile(resolve(root, `entries/${kind}/index.html`), 'utf8')
  assert.match(html, /src="\.\/index\.tsx"/)
}

const config = await readFile(resolve(root, 'vite.config.ts'), 'utf8')
assert.match(config, /sourcemap:\s*false/)
assert.match(config, /shared-react/)
assert.match(config, /shared-genoffice-ui/)
assert.match(config, /shared-format/)
assert.match(config, /docs\/index\.html/)
assert.match(config, /sheets\/index\.html/)
assert.match(config, /slides\/index\.html/)

const sheetsCss = await readFile(resolve(root, 'mona/sheets-editor.css'), 'utf8')
assert.match(
  sheetsCss,
  /\.app-shell\.copilot-collapsed \.sheet-body\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/,
)
assert.match(
  sheetsCss,
  /\.app-shell\.copilot-collapsed \.sheet-main\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/,
)
assert.match(sheetsCss, /\.mona-embedded-bottom-bar\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\);/)
assert.match(sheetsCss, /\.mona-embedded-bottom-bar \.status-bar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?height:\s*36px;/)
assert.match(sheetsCss, /section\[data-range-selector\]:has\(\[data-u-comp="slide-tab-bar"\]\)[\s\S]*?> :first-child\s*\{[\s\S]*?padding-right:\s*var\(--mona-sheet-status-width\);/)

const sheetsEntry = await readFile(resolve(root, 'mona/sheets-entry.tsx'), 'utf8')
assert.match(sheetsEntry, /if \(agentApplyingRef\.current\) setFollowPaused\(true\)/)

const docsEntry = await readFile(resolve(root, 'mona/docs-entry.tsx'), 'utf8')
assert.match(docsEntry, /if \(agentApplyingRef\.current\) setFollowPaused\(true\)/)

const sheetsShell = await readFile(
  resolve(root, 'vendor/genoffice/apps/sheets/src/renderer/ExcelShell.tsx'),
  'utf8',
)
assert.match(sheetsShell, /sheet-main\$\{embedded \? ' mona-embedded-bottom-bar' : ''\}/)
assert.match(sheetsShell, /!embedded && \(\s*<>\s*<button[\s\S]*?SaveIcon/)
assert.match(sheetsShell, /!embedded && \(\s*<label[\s\S]*?autosave-toggle/)
assert.match(sheetsShell, /!embedded && \(\s*<span className="workbook-status"/)
assert.match(sheetsShell, /!embedded && \(\s*<RibbonGroup label=\{t\('appGroupAiAssistant'\)\}>/)
assert.match(sheetsShell, /!embedded && \(\s*<RibbonGroup label=\{t\('appGroupLanguage'\)\}>/)

const sheetsApp = await readFile(
  resolve(root, 'vendor/genoffice/apps/sheets/src/renderer/App.tsx'),
  'utf8',
)
assert.match(sheetsApp, /=> !embeddedController && localStorage\.getItem\('ai-sheets-auto-save'\)/)
assert.match(sheetsApp, /if \(embeddedController \|\| !autoSave\) return/)
assert.match(sheetsApp, /Crash-recovery copy[\s\S]*?if \(embeddedController\) return/)
assert.match(sheetsApp, /if \(applies\.length === 0 \|\| embeddedController\) return/)

const ribbonCss = await readFile(resolve(root, 'mona/ribbon-overflow.css'), 'utf8')
assert.match(ribbonCss, /\.mona-docs-editor \.ribbon,[\s\S]*?overflow-x:\s*auto;/)
assert.match(ribbonCss, /\.mona-slides-editor \.ribbon-body[\s\S]*?overflow:\s*visible;/)
assert.match(ribbonCss, /\.mona-sheets-editor \.excel-header[\s\S]*?overflow-x:\s*auto;/)
assert.match(ribbonCss, /\.mona-docs-editor \.ribbon:hover,[\s\S]*?margin-bottom:\s*-5px;/)
assert.match(ribbonCss, /\.mona-slides-editor \.ribbon-tab[\s\S]*?white-space:\s*nowrap;/)
assert.match(ribbonCss, /\.mona-slides-editor \.ribbon-body\s*\{[\s\S]*?width:\s*100%;/)
assert.match(ribbonCss, /\.mona-sheets-editor \.ribbon-tabs-win\s*\{[\s\S]*?padding-right:\s*0;/)
assert.doesNotMatch(ribbonCss, /width:\s*max-content/)
for (const entry of ['docs-entry.tsx', 'sheets-entry.tsx', 'slides-entry.tsx']) {
  const source = await readFile(resolve(root, `mona/${entry}`), 'utf8')
  assert.match(source, /import ['"]\.\/ribbon-overflow\.css['"];?$/m)
}

const docsApp = await readFile(
  resolve(root, 'vendor/genoffice/apps/docs/src/renderer/App.tsx'),
  'utf8',
)
assert.match(docsApp, /e\.key === 'F7'[\s\S]*?&& !embeddedController/)
assert.match(docsApp, /<EditorContextMenu\s+embedded=\{!!embeddedController\}/)
assert.match(docsApp, /embeddedController \? 'Mona 文档编辑器' : 'GenOffice Docs'/)

const docsContextMenu = await readFile(
  resolve(root, 'vendor/genoffice/apps/docs/src/renderer/components/ContextMenu.tsx'),
  'utf8',
)
assert.match(docsContextMenu, /!embedded && \([\s\S]*?appSynonyms[\s\S]*?appTranslate/)

const slidesApp = await readFile(
  resolve(root, 'vendor/genoffice/apps/slides/src/renderer/App.tsx'),
  'utf8',
)
assert.match(slidesApp, /embeddedController\.requestAi/)
assert.match(slidesApp, /embedded=\{Boolean\(embeddedController\)\}/)
assert.match(slidesApp, /embeddedController \? \([\s\S]*?AI 编辑[\s\S]*?优化当前页/)
assert.match(slidesApp, /!embeddedController && missingFonts\.length > 0/)

const slidesRibbon = await readFile(
  resolve(root, 'vendor/genoffice/apps/slides/src/renderer/components/Ribbon.tsx'),
  'utf8',
)
assert.match(slidesRibbon, /!embedded && !IS_MAC/)
assert.match(slidesRibbon, /!embedded && \([\s\S]*?ribbonSaveTip/)
assert.match(slidesRibbon, /!embedded && \([\s\S]*?autosave-toggle/)
assert.match(slidesRibbon, /ribbonUndo[\s\S]*?ribbonRedo/)

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
assert.equal(packageJson.dependencies.react, '19.2.8')
assert.equal(packageJson.dependencies['react-dom'], '19.2.8')
assert.equal(
  packageJson.scripts['build:tauri'],
  'vite build --outDir ../../../src-tauri/dist/office-editor --emptyOutDir',
)
const entriesRoot = resolve(root, 'entries')
const outputPath = (scriptName) => {
  const match = packageJson.scripts[scriptName].match(/--outDir\s+(\S+)/)
  assert.ok(match, `${scriptName} must declare --outDir`)
  return resolve(entriesRoot, match[1])
}
assert.equal(outputPath('build:tauri'), resolve(root, '../../src-tauri/dist/office-editor'))
