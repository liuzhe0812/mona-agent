import { build, loadConfigFromFile } from 'vite'
import type { OutputChunk, OutputOptions } from 'rollup'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
const { mkdtemp, mkdir, rm, writeFile } = nodeRequire('node:fs/promises') as typeof import('node:fs/promises')
const { isAbsolute, join, relative, resolve, sep } = nodeRequire('node:path') as typeof import('node:path')
const { tmpdir } = nodeRequire('node:os') as typeof import('node:os')

const normalizePath = (value: string) => value.replaceAll('\\', '/')

const isUniverModule = (moduleId: string) =>
  normalizePath(moduleId).includes('/node_modules/@univerjs/')

const isSharedUiModule = (moduleId: string) =>
  normalizePath(moduleId).endsWith('/vendor/genoffice/packages/ui/index.js')

const isSharedReactModule = (moduleId: string) =>
  normalizePath(moduleId).endsWith('/node_modules/react/index.js')

function outputChunks(result: Awaited<ReturnType<typeof build>>): OutputChunk[] {
  const outputs = Array.isArray(result)
    ? result
    : 'output' in result
      ? [result]
      : []
  return outputs.flatMap(({ output }) =>
    output.filter((item): item is OutputChunk => item.type === 'chunk'),
  )
}

function reachableModules(entry: OutputChunk, chunksByFileName: Map<string, OutputChunk>) {
  const visitedChunks = new Set<string>()
  const modules = new Set<string>()

  const visit = (fileName: string) => {
    if (visitedChunks.has(fileName)) return
    const chunk = chunksByFileName.get(fileName)
    if (!chunk) throw new Error(`Missing statically imported output chunk: ${fileName}`)

    visitedChunks.add(fileName)
    for (const moduleId of Object.keys(chunk.modules)) modules.add(moduleId)
    for (const importedFileName of chunk.imports) visit(importedFileName)
  }

  visit(entry.fileName)
  return modules
}

async function removeOwnedTempDirectory(directory: string) {
  const resolvedDirectory = resolve(directory)
  const resolvedTempDirectory = resolve(tmpdir())
  const relativeDirectory = relative(resolvedTempDirectory, resolvedDirectory)
  if (
    !relativeDirectory
    || relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`)
    || isAbsolute(relativeDirectory)
  ) {
    throw new Error(`Refusing to remove a directory outside the system temp directory: ${directory}`)
  }
  await rm(resolvedDirectory, { force: true, recursive: true })
}

test('keeps Univer reachable only from sheets in the production chunk graph', async () => {
  const configFile = resolve(import.meta.dirname, '../vite.config.ts')
  const loadedConfig = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile)
  expect(loadedConfig).not.toBeNull()
  if (!loadedConfig) return

  const configuredOutput = loadedConfig.config.build?.rollupOptions?.output
  expect(Array.isArray(configuredOutput)).toBe(false)
  expect(configuredOutput).toBeDefined()
  if (!configuredOutput || Array.isArray(configuredOutput)) return

  const output = configuredOutput as OutputOptions
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'mona-office-build-chunks-'))

  try {
    await Promise.all([
      mkdir(resolve(fixtureRoot, 'entries/docs'), { recursive: true }),
      mkdir(resolve(fixtureRoot, 'entries/slides'), { recursive: true }),
      mkdir(resolve(fixtureRoot, 'entries/sheets'), { recursive: true }),
      mkdir(resolve(fixtureRoot, 'vendor/genoffice/packages/ui'), { recursive: true }),
      mkdir(resolve(fixtureRoot, 'node_modules/react'), { recursive: true }),
      mkdir(resolve(fixtureRoot, 'node_modules/@univerjs/core'), { recursive: true }),
    ])

    await Promise.all([
      writeFile(
        resolve(fixtureRoot, 'vendor/genoffice/packages/ui/index.js'),
        "import { reactMarker } from 'react'\nexport const sharedUi = `ui:${reactMarker}`\n",
        'utf8',
      ),
      writeFile(resolve(fixtureRoot, 'node_modules/react/package.json'), '{"type":"module"}\n', 'utf8'),
      writeFile(resolve(fixtureRoot, 'node_modules/react/index.js'), "export const reactMarker = 'react'\n", 'utf8'),
      writeFile(
        resolve(fixtureRoot, 'node_modules/@univerjs/core/package.json'),
        '{"name":"@univerjs/core","type":"module","exports":"./index.js"}\n',
        'utf8',
      ),
      writeFile(
        resolve(fixtureRoot, 'node_modules/@univerjs/core/index.js'),
        "export const univerMarker = 'univer'\n",
        'utf8',
      ),
      writeFile(
        resolve(fixtureRoot, 'entries/docs/index.js'),
        "import { sharedUi } from '../../vendor/genoffice/packages/ui/index.js'\nexport const docs = sharedUi\n",
        'utf8',
      ),
      writeFile(
        resolve(fixtureRoot, 'entries/slides/index.js'),
        "import { sharedUi } from '../../vendor/genoffice/packages/ui/index.js'\nexport const slides = sharedUi\n",
        'utf8',
      ),
      writeFile(
        resolve(fixtureRoot, 'entries/sheets/index.js'),
        "import { sharedUi } from '../../vendor/genoffice/packages/ui/index.js'\nimport { univerMarker } from '@univerjs/core'\nexport const sheets = `${sharedUi}:${univerMarker}`\n",
        'utf8',
      ),
    ])

    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [],
      root: fixtureRoot,
      build: {
        minify: false,
        write: false,
        rollupOptions: {
          input: {
            docs: resolve(fixtureRoot, 'entries/docs/index.js'),
            sheets: resolve(fixtureRoot, 'entries/sheets/index.js'),
            slides: resolve(fixtureRoot, 'entries/slides/index.js'),
          },
          preserveEntrySignatures: 'strict',
          output,
        },
      },
    })
    const chunks = outputChunks(result)
    const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
    const entries = new Map(
      chunks
        .filter((chunk) => chunk.isEntry)
        .map((chunk) => [chunk.name, chunk]),
    )

    const docsEntry = entries.get('docs')
    const sheetsEntry = entries.get('sheets')
    const slidesEntry = entries.get('slides')
    expect(docsEntry).toBeDefined()
    expect(sheetsEntry).toBeDefined()
    expect(slidesEntry).toBeDefined()
    if (!docsEntry || !sheetsEntry || !slidesEntry) return

    const docsModules = reachableModules(docsEntry, chunksByFileName)
    const sheetsModules = reachableModules(sheetsEntry, chunksByFileName)
    const slidesModules = reachableModules(slidesEntry, chunksByFileName)

    expect([...docsModules].some(isUniverModule)).toBe(false)
    expect([...slidesModules].some(isUniverModule)).toBe(false)
    expect([...sheetsModules].some(isUniverModule)).toBe(true)

    for (const modules of [docsModules, sheetsModules, slidesModules]) {
      expect([...modules].some(isSharedUiModule)).toBe(true)
      expect([...modules].some(isSharedReactModule)).toBe(true)
    }
  } finally {
    await removeOwnedTempDirectory(fixtureRoot)
  }
})
