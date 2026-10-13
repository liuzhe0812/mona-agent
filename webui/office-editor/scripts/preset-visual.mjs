import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

const scriptPath = fileURLToPath(import.meta.url)
const officeRoot = resolve(dirname(scriptPath), '..')
const repoRoot = resolve(officeRoot, '../..')
const defaultFixture = resolve(officeRoot, 'tests/presets/quality-content.json')
const defaultOutput = resolve(officeRoot, '.artifacts/preset-visual')
const defaultBlank = resolve(repoRoot, 'src-tauri/resources/office-editor/templates/blank.pptx')
const catalogPath = resolve(officeRoot, 'mona/presets/catalog.json')
const extendedCatalogPath = resolve(officeRoot, 'mona/presets/extended.json')
const scenarioCatalogPath = resolve(officeRoot, 'mona/presets/scenarios.json')
const scenarioPagesPath = resolve(officeRoot, 'mona/presets/scenario-pages.json')
const viteConfigPath = resolve(officeRoot, 'vite.config.ts')
const maxPages = 50
const maxCandidatePages = 2

function usage() {
  return `Usage: node scripts/preset-visual.mjs [options]

Runs real Slides editor preset pages in Edge through the Mona office bridge.

Options:
  --fixture <path>       Fixture JSON (default: tests/presets/quality-content.json)
  --output <path>        Output directory (default: .artifacts/preset-visual)
  --blank <path>         Blank PPTX template (default: src-tauri/resources/office-editor/templates/blank.pptx)
  --server <url>         Use an existing local Vite server instead of starting one
  --deck <name>          Run one named deck from a multi-deck fixture
  --max-pages <count>    Bound pages per deck (default: all, max: ${maxPages})
  --check-candidates      Validate up to ${maxCandidatePages} read-only preset candidates first
  --headed               Show Edge while running
  --list-presets         Print the current preset catalog and exit
  --help                 Show this help
`
}

function parseArgs(argv) {
  const options = {
    fixture: defaultFixture,
    output: defaultOutput,
    blank: defaultBlank,
    server: null,
    deck: null,
    maxPages: maxPages,
    checkCandidates: false,
    headed: false,
    listPresets: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { ...options, help: true }
    if (arg === '--headed') {
      options.headed = true
      continue
    }
    if (arg === '--list-presets') {
      options.listPresets = true
      continue
    }
    if (arg === '--check-candidates') {
      options.checkCandidates = true
      continue
    }
    const [key, inlineValue] = arg.split('=', 2)
    const takesValue = new Set(['--fixture', '--output', '--blank', '--server', '--deck', '--max-pages'])
    if (!takesValue.has(key)) throw new Error(`未知参数：${arg}`)
    const value = inlineValue ?? argv[++index]
    if (!value) throw new Error(`${key} 需要参数。`)
    if (key === '--fixture') options.fixture = value
    if (key === '--output') options.output = value
    if (key === '--blank') options.blank = value
    if (key === '--server') options.server = value
    if (key === '--deck') options.deck = value
    if (key === '--max-pages') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxPages) {
        throw new Error(`--max-pages 必须是 1-${maxPages} 的整数。`)
      }
      options.maxPages = parsed
    }
  }
  return options
}

function assertLocalCliPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是本地路径。`)
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || value.startsWith('\\\\')) {
    throw new Error(`${label} 只能使用本地文件路径。`)
  }
}

function pathWithin(root, candidate, label) {
  const rootValue = resolve(root)
  const candidateValue = resolve(candidate)
  const remaining = relative(rootValue, candidateValue)
  if (remaining === '..' || remaining.startsWith(`..${sep}`) || isAbsolute(remaining)) {
    throw new Error(`${label} 必须位于 ${rootValue} 内：${candidateValue}`)
  }
  return candidateValue
}

async function existingFile(value, label) {
  assertLocalCliPath(value, label)
  const candidate = resolve(value)
  const info = await stat(candidate).catch(() => null)
  if (!info?.isFile()) throw new Error(`${label} 不存在或不是文件：${candidate}`)
  return realpath(candidate)
}

function safeName(value, label) {
  const result = String(value ?? '').trim().replace(/[^\p{L}\p{N}._-]+/gu, '_')
  if (!result || result === '.' || result === '..') throw new Error(`${label} 不能为空。`)
  return result.slice(0, 80)
}

function jsonError(value, max = 1600) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`)
  return value
}

function imageMime(filePath) {
  const extension = extname(filePath).toLowerCase()
  const known = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }
  const mime = known[extension]
  if (!mime) throw new Error(`不支持的图片资产扩展名：${filePath}`)
  return mime
}

function dataUrl(filePath, bytes) {
  return `data:${imageMime(filePath)};base64,${bytes.toString('base64')}`
}

async function resolveFixtureAssets(value, fixtureDirectory) {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveFixtureAssets(item, fixtureDirectory)))
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'assetPath') {
      if (typeof item !== 'string' || !item.trim()) throw new Error('assetPath 必须是非空字符串。')
      const candidate = resolve(fixtureDirectory, item)
      const resolved = await existingFile(candidate, 'fixture assetPath')
      pathWithin(fixtureDirectory, resolved, 'fixture assetPath')
      result.dataUrl = dataUrl(resolved, await readFile(resolved))
      continue
    }
    result[key] = await resolveFixtureAssets(item, fixtureDirectory)
  }
  return result
}

function pageOperations(page, content) {
  if (typeof page.presetId === 'string' && page.presetId.trim()) {
    return [{
      op: 'slide_add_preset',
      payload: { slideId: '$slideId', presetId: page.presetId, content },
    }]
  }
  const operations = page.operations ?? page.rawOperations ?? page.commands
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('页面必须提供 presetId 或非空 operations。')
  }
  return operations
}

function replaceSlideId(value, slideId) {
  if (Array.isArray(value)) return value.map((item) => replaceSlideId(item, slideId))
  if (!value || typeof value !== 'object') return value === '$slideId' || value === '<slide-id>' ? slideId : value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceSlideId(item, slideId)]))
}

async function readFixture(fixturePath) {
  const source = JSON.parse(await readFile(fixturePath, 'utf8'))
  const root = asRecord(source, 'fixture')
  const decks = Array.isArray(root.decks) ? root.decks : [root]
  if (decks.length === 0 || decks.length > 20) throw new Error('fixture decks 数量必须是 1-20。')
  const fixtureDirectory = dirname(fixturePath)
  const normalized = []
  for (const [deckIndex, value] of decks.entries()) {
    const deck = asRecord(value, `fixture.decks[${deckIndex}]`)
    if (!Array.isArray(deck.pages) || deck.pages.length === 0) throw new Error(`deck[${deckIndex}] 缺少非空 pages。`)
    if (deck.pages.length > maxPages) throw new Error(`deck[${deckIndex}] 超过 ${maxPages} 页上限。`)
    const pages = []
    for (const [pageIndex, pageValue] of deck.pages.entries()) {
      const page = asRecord(pageValue, `deck[${deckIndex}].pages[${pageIndex}]`)
      const content = await resolveFixtureAssets(page.content ?? {}, fixtureDirectory)
      pages.push({
        ...page,
        content,
        operations: await resolveFixtureAssets(pageOperations(page, content), fixtureDirectory),
      })
    }
    normalized.push({
      name: safeName(deck.name ?? `deck-${deckIndex + 1}`, `deck[${deckIndex}].name`),
      pages,
    })
  }
  return { schemaVersion: root.schemaVersion ?? 1, decks: normalized }
}

async function readPresetCatalog() {
  const sources = [
    { group: 'catalog', path: catalogPath },
    { group: 'extended', path: extendedCatalogPath },
    { group: 'scenario-pages', path: scenarioPagesPath },
  ]
  const presets = []
  const seen = new Set()
  const metadata = []
  for (const source of sources) {
    const bytes = await readFile(source.path).catch(() => null)
    if (!bytes) throw new Error(`找不到预设目录：${source.path}`)
    const catalog = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(catalog?.presets)) throw new Error(`预设目录格式无效：${source.path}`)
    for (const preset of catalog.presets) {
      if (!preset || typeof preset.id !== 'string' || !preset.id.trim()) {
        throw new Error(`预设目录包含无效 ID：${source.path}`)
      }
      if (seen.has(preset.id)) throw new Error(`预设目录存在重复 ID：${preset.id}`)
      seen.add(preset.id)
      presets.push({
        id: preset.id,
        family: preset.family,
        theme: preset.theme,
        capacity: preset.capacity,
        sourceGroup: source.group,
      })
    }
    metadata.push({
      group: source.group,
      path: source.path,
      sha256: sha256(bytes),
      presetCount: catalog.presets.length,
    })
  }
  const scenarioBytes = await readFile(scenarioCatalogPath).catch(() => null)
  if (!scenarioBytes) throw new Error(`找不到场景目录：${scenarioCatalogPath}`)
  const scenarioCatalog = JSON.parse(scenarioBytes.toString('utf8'))
  if (!Array.isArray(scenarioCatalog?.scenarios)) throw new Error(`场景目录格式无效：${scenarioCatalogPath}`)
  metadata.push({
    group: 'scenarios',
    path: scenarioCatalogPath,
    sha256: sha256(scenarioBytes),
    scenarioCount: scenarioCatalog.scenarios.length,
  })
  return { presets, scenarios: scenarioCatalog.scenarios, sources: metadata }
}

function localServerUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`--server 不是有效 URL：${value}`)
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('--server 只能连接本机 HTTP Vite 服务。')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path.endsWith('/slides') ? `${path}/` : `${path}/slides/`}`
}

async function startVite(serverOption) {
  if (serverOption) return { baseUrl: localServerUrl(serverOption), server: null, cacheDirectory: null }
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'mona-preset-visual-vite-'))
  let server
  try {
    server = await createServer({
      configFile: viteConfigPath,
      cacheDir: cacheDirectory,
      server: { host: '127.0.0.1', port: 0, strictPort: true },
      logLevel: 'error',
    })
    await server.listen()
    const address = server.httpServer?.address()
    const port = typeof address === 'object' && address ? address.port : undefined
    if (!port) throw new Error('Vite 服务未报告本地端口。')
    return { baseUrl: `http://127.0.0.1:${port}/slides/`, server, cacheDirectory }
  } catch (error) {
    if (server) await server.close().catch((closeError) => {
      process.stderr.write(`清理临时 Vite 服务失败：${closeError instanceof Error ? closeError.message : String(closeError)}\n`)
    })
    await cleanupViteCache(cacheDirectory)
    throw error
  }
}

async function cleanupViteCache(cacheDirectory) {
  try {
    const temporaryRoot = await realpath(tmpdir())
    const cachePath = await realpath(cacheDirectory).catch(() => resolve(cacheDirectory))
    const safeCachePath = pathWithin(temporaryRoot, cachePath, 'Vite 临时缓存')
    await rm(safeCachePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    process.stderr.write(`清理临时 Vite 缓存失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function playwrightChromium() {
  const require = createRequire(import.meta.url)
  const attempts = []
  const runtimeRoot = process.env.RUNTIME_NODE_MODULES
  if (runtimeRoot) {
    assertLocalCliPath(runtimeRoot, 'RUNTIME_NODE_MODULES')
    const entry = resolve(runtimeRoot, 'playwright')
    attempts.push(entry)
    try {
      return { chromium: require(entry).chromium, source: entry }
    } catch (error) {
      attempts.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const searchPath of [officeRoot, process.cwd()]) {
    try {
      const entry = require.resolve('playwright', { paths: [searchPath] })
      return { chromium: require(entry).chromium, source: entry }
    } catch (error) {
      attempts.push(`${searchPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法加载 Playwright。优先设置 RUNTIME_NODE_MODULES 指向 node_modules，或在 office-editor 中安装 package Playwright。\n${attempts.join('\n')}`)
}

async function existingExecutable(candidate) {
  if (!candidate) return null
  assertLocalCliPath(candidate, 'browser executable')
  const info = await stat(resolve(candidate)).catch(() => null)
  return info?.isFile() ? realpath(resolve(candidate)) : null
}

async function browserExecutable(chromium) {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.MONA_EDGE_PATH,
  ]
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:/Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
    candidates.push(
      join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
    )
  }
  for (const candidate of candidates) {
    const executablePath = await existingExecutable(candidate)
    if (executablePath) return { executablePath, source: 'local browser executable' }
  }
  const bundled = typeof chromium.executablePath === 'function' ? chromium.executablePath() : ''
  const bundledPath = await existingExecutable(bundled)
  if (bundledPath) return { executablePath: bundledPath, source: 'Playwright bundled Chromium' }
  throw new Error('找不到浏览器。Windows 请安装 Edge 或设置 BROWSER_EXECUTABLE_PATH；CI 请安装 Playwright Chromium。')
}

async function setupBridge(page) {
  await page.evaluate(() => {
    const channel = new MessageChannel()
    const queue = []
    const encodeCheckpoint = (message) => {
      const file = message?.file
      if (!(file instanceof ArrayBuffer) && !ArrayBuffer.isView(file)) return message
      const bytes = file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(file.buffer, file.byteOffset, file.byteLength)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + 0x8000)))
      }
      const encoded = btoa(binary)
      const copy = { ...message, fileBase64: encoded }
      delete copy.file
      return copy
    }
    channel.port1.addEventListener('message', (event) => queue.push(encodeCheckpoint(event.data)))
    channel.port1.start()
    window.__monaPresetVisualQueue = queue
    window.__monaPresetVisualPort = channel.port1
    window.postMessage({ type: 'mona_office_connect' }, '*', [channel.port2])
  })
}

async function sendBridge(page, message, fileBytes) {
  await page.evaluate(({ value, bytes }) => {
    const copy = { ...value }
    if (bytes) {
      const file = Uint8Array.from(bytes).buffer
      copy.file = file
      window.__monaPresetVisualPort.postMessage(copy, [file])
      return
    }
    window.__monaPresetVisualPort.postMessage(copy)
  }, { value: message, bytes: fileBytes ? [...fileBytes] : null })
}

async function takeBridgeMessage(page, predicate, label, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const messages = await page.evaluate(() => window.__monaPresetVisualQueue.splice(0))
    for (const message of messages) {
      if (predicate(message)) return message
    }
    await page.waitForTimeout(40)
  }
  throw new Error(`等待 ${label} 超时。`)
}

function assertVersion(actual, expected, label) {
  if (!actual || actual.editorEpoch !== expected.editorEpoch || actual.modelRevision !== expected.modelRevision) {
    throw new Error(`${label} 版本不匹配：expected=${jsonError(expected)} actual=${jsonError(actual)}`)
  }
}

async function openDeck(page, bytes, sessionId, version) {
  await sendBridge(page, {
    type: 'office_open', sessionId, documentType: 'slides', version,
  }, bytes)
  const ready = await takeBridgeMessage(page, (message) => (
    message?.type === 'office_editor_ready' && message.sessionId === sessionId
  ), 'office_editor_ready')
  assertVersion(ready.version, version, 'office_editor_ready')
}

async function apply(page, sessionId, version, operationId, operations) {
  await sendBridge(page, {
    type: 'office_command',
    command: { sessionId, operationId, expectedVersion: version, operations },
  })
  const response = await takeBridgeMessage(page, (message) => (
    message?.type === 'office_command_result' && message.result?.operationId === operationId
  ), `office_command_result(${operationId})`)
  const result = response.result
  if (!result?.ok) throw new Error(`${operationId} 失败：${jsonError(result?.error ?? result)}`)
  assertVersion(
    result.version,
    result.unchanged
      ? version
      : { editorEpoch: version.editorEpoch, modelRevision: version.modelRevision + 1 },
    `${operationId}.version`,
  )
  return result
}

async function inspect(page, sessionId, version, requestId, query) {
  await sendBridge(page, {
    type: 'office_inspect', command: { sessionId, requestId, query },
  })
  const response = await takeBridgeMessage(page, (message) => (
    message?.type === 'office_inspect_result' && message.result?.requestId === requestId
  ), `office_inspect_result(${requestId})`)
  const result = response.result
  if (!result?.ok) throw new Error(`${requestId} 失败：${jsonError(result?.error ?? result)}`)
  assertVersion(result.version, version, `${requestId}.version`)
  return result.result
}

async function slideIds(page, sessionId, version, requestId) {
  const result = await inspect(page, sessionId, version, requestId, { mode: 'slides', limit: 100 })
  if (!Array.isArray(result?.slides) || result.slides.length === 0) throw new Error('blank.pptx 没有可用幻灯片。')
  return result.slides.map((slide) => String(slide.id))
}

async function visual(page, sessionId, version, requestId, slideId) {
  const result = await inspect(page, sessionId, version, requestId, { mode: 'visual', slideId })
  if (typeof result?.dataUrl !== 'string' || !/^data:image\/png;base64,/.test(result.dataUrl)) {
    throw new Error(`${requestId} 没有返回 PNG。`)
  }
  return result
}

async function candidateVisual(page, sessionId, version, requestId, presetId, presetContentRef) {
  const result = await inspect(page, sessionId, version, requestId, {
    mode: 'visual', presetId, presetContentRef,
  })
  if (result?.target !== `preset:${presetId}`) {
    throw new Error(`${requestId} 返回了错误的候选目标：${String(result?.target)}`)
  }
  if (typeof result?.dataUrl !== 'string' || !/^data:image\/png;base64,/.test(result.dataUrl)) {
    throw new Error(`${requestId} 没有返回 PNG。`)
  }
  return result
}

function pngBytes(dataUrlValue) {
  const encoded = /^data:image\/png;base64,(.+)$/.exec(dataUrlValue)?.[1]
  if (!encoded) throw new Error('视觉回执不是 PNG data URL。')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < 100) throw new Error('视觉 PNG 为空或过小。')
  return bytes
}

function blockingWarnings(warnings) {
  return (Array.isArray(warnings) ? warnings : []).filter((warning) => (
    typeof warning === 'string' && warning.startsWith('[错误]')
  ))
}

async function writeVisual(outputDirectory, fileName, result, label = fileName) {
  const filePath = resolve(outputDirectory, fileName)
  const bytes = pngBytes(result.dataUrl)
  const warnings = Array.isArray(result.warnings) ? result.warnings : []
  const blocking = blockingWarnings(warnings)
  await writeFile(filePath, bytes)
  if (blocking.length > 0) {
    await writeFile(`${filePath}.warnings.json`, JSON.stringify({ label, warnings, passed: false }, null, 2))
    throw new Error(`${label} 存在阻塞性布局警告：${jsonError(blocking)}`)
  }
  return {
    file: fileName,
    width: result.width,
    height: result.height,
    target: result.target,
    sha256: sha256(bytes),
    warnings,
    pendingVisualSlideIds: result.pendingVisualSlideIds ?? [],
  }
}

function slideStructure(result) {
  if (!Array.isArray(result?.slides)) throw new Error('slides inspect 未返回页面列表。')
  return result.slides.map((slide) => ({
    id: slide.id,
    index: slide.index,
    width: slide.width,
    height: slide.height,
    elements: Array.isArray(slide.elements) ? slide.elements.map((element) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      text: element.text ?? '',
    })) : [],
  }))
}

function assertSameSlideStructure(before, after, label) {
  if (JSON.stringify(slideStructure(before)) !== JSON.stringify(slideStructure(after))) {
    throw new Error(`${label} 改变了当前文档页面结构。`)
  }
}

async function checkpoint(page, sessionId, version) {
  await sendBridge(page, { type: 'office_checkpoint_request', version })
  const response = await takeBridgeMessage(page, (message) => (
    message?.type === 'office_checkpoint'
      && message.sessionId === sessionId
      && message.version?.editorEpoch === version.editorEpoch
      && message.version?.modelRevision === version.modelRevision
  ), 'office_checkpoint')
  if (typeof response.fileBase64 !== 'string') throw new Error('office_checkpoint 缺少 file。')
  assertVersion(response.version, version, 'office_checkpoint')
  return Buffer.from(response.fileBase64, 'base64')
}

function candidatePages(decks) {
  const selected = []
  const presetIds = new Set()
  for (const deck of decks) {
    for (const [pageIndex, page] of deck.pages.entries()) {
      if (selected.length >= maxCandidatePages || !page.presetId || !page.content) continue
      if (presetIds.has(page.presetId)) continue
      selected.push({ deckName: deck.name, pageIndex, page })
      presetIds.add(page.presetId)
    }
  }
  return selected
}

async function runCandidates(page, blankBytes, decks, outputRoot, runId, catalog) {
  const samples = candidatePages(decks)
  if (samples.length === 0) return []
  const directory = resolve(outputRoot, 'candidates')
  await mkdir(directory, { recursive: true })
  const sessionId = `preset-visual-${runId}-candidates`
  const version = { editorEpoch: `preset-visual-${runId}`, modelRevision: 0 }
  await openDeck(page, blankBytes, sessionId, version)
  const baseline = await inspect(page, sessionId, version, 'candidate-baseline', {
    mode: 'slides', limit: 100, includeData: false,
  })
  const catalogById = new Map(catalog.map((item) => [item.id, item]))
  const results = []
  for (const [index, sample] of samples.entries()) {
    const definition = catalogById.get(sample.page.presetId)
    const capabilities = await inspect(page, sessionId, version, `candidate-capabilities-${index}`, {
      mode: 'capabilities',
      presetContent: sample.page.content,
      ...(typeof sample.page.presetFamily === 'string'
        ? { presetFamily: sample.page.presetFamily }
        : definition?.family ? { presetFamily: definition.family } : {}),
      ...(typeof sample.page.presetTheme === 'string'
        ? { presetTheme: sample.page.presetTheme }
        : definition?.theme ? { presetTheme: definition.theme } : {}),
    })
    if (!Array.isArray(capabilities?.presets)
      || !capabilities.presets.some((preset) => preset?.id === sample.page.presetId)) {
      throw new Error(`候选 ${sample.page.presetId} 未通过生产 capabilities 选择。`)
    }
    if (typeof capabilities.contentRef !== 'string' || !capabilities.contentRef.trim()) {
      throw new Error(`候选 ${sample.page.presetId} capabilities 未返回 contentRef。`)
    }
    const captured = await candidateVisual(
      page,
      sessionId,
      version,
      `candidate-visual-${index}`,
      sample.page.presetId,
      capabilities.contentRef,
    )
    const visualRecord = await writeVisual(
      directory,
      `${String(index + 1).padStart(2, '0')}-${safeName(sample.page.presetId, 'presetId')}.png`,
      captured,
      `候选 ${sample.page.presetId}`,
    )
    const after = await inspect(page, sessionId, version, `candidate-after-${index}`, {
      mode: 'slides', limit: 100, includeData: false,
    })
    assertSameSlideStructure(baseline, after, `候选 ${sample.page.presetId}`)
    results.push({
      deck: sample.deckName,
      pageIndex: sample.pageIndex,
      presetId: sample.page.presetId,
      contentRef: capabilities.contentRef,
      version: { ...version },
      visual: visualRecord,
    })
  }
  return results
}

async function runDeck(page, blankBytes, deck, outputRoot, runId) {
  const deckDirectoryName = safeName(deck.name, 'deck.name')
  const deckDirectory = resolve(outputRoot, deckDirectoryName)
  await mkdir(deckDirectory, { recursive: true })
  const sessionId = `preset-visual-${runId}-${deckDirectoryName}`
  let version = { editorEpoch: `preset-visual-${runId}`, modelRevision: 0 }
  await openDeck(page, blankBytes, sessionId, version)
  let ids = await slideIds(page, sessionId, version, `${deckDirectoryName}-initial-slides`)
  let currentSlideId = ids[0]
  const pages = []

  for (const [pageIndex, pageValue] of deck.pages.entries()) {
    if (pageIndex > 0) {
      const added = await apply(page, sessionId, version, `${deckDirectoryName}-add-${pageIndex}`, [{
        op: 'slide_add', payload: { slideId: currentSlideId },
      }])
      version = added.version
      currentSlideId = String(added.createdSlides?.[0]?.id ?? '')
      if (!currentSlideId) {
        ids = await slideIds(page, sessionId, version, `${deckDirectoryName}-slides-${pageIndex}`)
        currentSlideId = ids.at(-1)
      }
      if (!currentSlideId) throw new Error(`第 ${pageIndex + 1} 页没有创建出幻灯片。`)
    }

    const operations = replaceSlideId(pageValue.operations, currentSlideId)
    const created = await apply(page, sessionId, version, `${deckDirectoryName}-page-${pageIndex}`, operations)
    version = created.version
    const pendingStyles = created.presetPages?.flatMap((presetPage) => presetPage.pendingChartStyles ?? []) ?? []
    for (const [styleIndex, pending] of pendingStyles.entries()) {
      if (typeof pending.elementId !== 'string' || !pending.elementId) {
        throw new Error(`${deckDirectoryName} 第 ${pageIndex + 1} 页的 pendingChartStyles 缺少 elementId。`)
      }
      const styled = await apply(page, sessionId, version, `${deckDirectoryName}-style-${pageIndex}-${styleIndex}`, [{
        op: 'slide_set_chart_style',
        payload: { slideId: currentSlideId, elementId: pending.elementId, style: pending.style },
      }])
      version = styled.version
    }

    pages.push({
      index: pageIndex,
      presetId: pageValue.presetId ?? null,
      scenario: typeof pageValue.content?.scenario === 'string' ? pageValue.content.scenario : null,
      slideId: currentSlideId,
      pendingChartStyles: pendingStyles.map((item) => ({ role: item.role, elementId: item.elementId, style: item.style })),
    })
  }

  // Capture every page after the deck has reached one exact revision. The
  // checkpoint and the reopened captures below therefore share this version.
  for (const pageRecord of pages) {
    const captured = await visual(
      page,
      sessionId,
      version,
      `${deckDirectoryName}-visual-${pageRecord.index}`,
      pageRecord.slideId,
    )
    pageRecord.version = { ...version }
    pageRecord.live = await writeVisual(
      deckDirectory,
      `${String(pageRecord.index + 1).padStart(2, '0')}-live.png`,
      captured,
      `${deckDirectoryName} 第 ${pageRecord.index + 1} 页 live`,
    )
  }

  const checkpointBytes = await checkpoint(page, sessionId, version)
  const pptxFile = `${deckDirectoryName}.pptx`
  await writeFile(resolve(deckDirectory, pptxFile), checkpointBytes)

  const reopenedSessionId = `${sessionId}-reopened`
  await openDeck(page, checkpointBytes, reopenedSessionId, version)
  ids = await slideIds(page, reopenedSessionId, version, `${deckDirectoryName}-reopened-slides`)
  if (ids.length !== pages.length) throw new Error(`${deckDirectoryName} 重开后页数变化：${ids.length}/${pages.length}`)
  for (const [pageIndex, pageRecord] of pages.entries()) {
    const reopenedSlideId = ids[pageIndex]
    const captured = await visual(page, reopenedSessionId, version, `${deckDirectoryName}-reopened-visual-${pageIndex}`, reopenedSlideId)
    const reopened = await writeVisual(
      deckDirectory,
      `${String(pageIndex + 1).padStart(2, '0')}-reopened.png`,
      captured,
      `${deckDirectoryName} 第 ${pageIndex + 1} 页 reopened`,
    )
    if (pageRecord.live.sha256 !== reopened.sha256
      || pageRecord.live.width !== reopened.width
      || pageRecord.live.height !== reopened.height) {
      throw new Error(`${deckDirectoryName} 第 ${pageIndex + 1} 页 live/reopened PNG 不一致。`)
    }
    pageRecord.reopened = reopened
    pageRecord.reopenedVersion = { ...version }
    pageRecord.reopenedSlideId = reopenedSlideId
  }

  return {
    name: deck.name,
    file: relative(outputRoot, resolve(deckDirectory, pptxFile)),
    version,
    pages,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }
  if (options.listPresets) {
    const catalog = await readPresetCatalog()
    process.stdout.write(`${JSON.stringify(catalog.presets.map(({ sourceGroup, ...preset }) => preset), null, 2)}\n`)
    return
  }

  assertLocalCliPath(options.fixture, '--fixture')
  assertLocalCliPath(options.output, '--output')
  assertLocalCliPath(options.blank, '--blank')
  const fixturePath = await existingFile(options.fixture, '--fixture')
  const blankPath = await existingFile(options.blank, '--blank')
  const outputRoot = resolve(options.output)
  await mkdir(outputRoot, { recursive: true })
  const fixture = await readFixture(fixturePath)
  const selectedDecks = options.deck
    ? fixture.decks.filter((deck) => deck.name === options.deck)
    : fixture.decks
  if (selectedDecks.length === 0) throw new Error(`fixture 中找不到 deck：${options.deck}`)
  const boundedDecks = selectedDecks.map((deck) => ({ ...deck, pages: deck.pages.slice(0, options.maxPages) }))
  const blankBytes = await readFile(blankPath)
  const fixtureBytes = await readFile(fixturePath)
  const { baseUrl, server, cacheDirectory } = await startVite(options.server)
  let browser
  let page
  try {
    const playwright = playwrightChromium()
    const executable = await browserExecutable(playwright.chromium)
    browser = await playwright.chromium.launch({
      executablePath: executable.executablePath,
      headless: !options.headed,
    })
    page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    const consoleErrors = []
    page.on('pageerror', (error) => consoleErrors.push(String(error)))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }))
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-editor-kind="slides"]').waitFor({ state: 'attached', timeout: 60_000 })
    await setupBridge(page)
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fixtureSha256 = sha256(fixtureBytes)
    const blankSha256 = sha256(blankBytes)
    const catalogInfo = await readPresetCatalog()
    const catalog = options.checkCandidates ? catalogInfo.presets : []
    const candidateChecks = options.checkCandidates
      ? await runCandidates(page, blankBytes, boundedDecks, outputRoot, runId, catalog)
      : []
    const decks = []
    for (const deck of boundedDecks) decks.push(await runDeck(page, blankBytes, deck, outputRoot, runId))
    const previewIndexPath = resolve(repoRoot, 'mona/skills/mona-pptx/assets/presets/index.json')
    const previewIndex = JSON.parse(await readFile(previewIndexPath, 'utf8'))
    const catalogById = new Map(catalogInfo.presets.map((item) => [item.id, item]))
    const baselineDiffs = decks.flatMap((deck) => deck.pages.map((item) => {
      const definition = catalogById.get(item.presetId)
      const sourceGroup = definition?.sourceGroup ?? 'unknown'
      const previousGroup = previewIndex.groups?.[sourceGroup]
      const previousFixtureSha256 = previousGroup?.fixtureSha256
        ?? (sourceGroup === 'catalog' ? previewIndex.fixtureSha256 : null)
      const previous = previewIndex.entries.find((entry) => entry.id === item.presetId)
      return {
        presetId: item.presetId,
        sourceGroup,
        fixtureSha256,
        previousFixtureSha256,
        previous: previous?.sha256 ?? null,
        current: item.live.sha256,
        reviewRequired: previousFixtureSha256 === fixtureSha256
          && previous?.sha256 !== item.live.sha256,
      }
    }))
    const fixtureGroups = Object.fromEntries(
      [...new Set(decks.flatMap((deck) => deck.pages.map((item) => (
        catalogById.get(item.presetId)?.sourceGroup ?? 'unknown'
      ))))].map((group) => [group, {
        fixtureSha256,
        presetIds: decks.flatMap((deck) => deck.pages
          .filter((item) => (catalogById.get(item.presetId)?.sourceGroup ?? 'unknown') === group)
          .map((item) => item.presetId)),
      }]),
    )
    const report = {
      fixture: fixturePath,
      fixtureSha256,
      blank: { path: blankPath, sha256: blankSha256 },
      source: {
        presetCatalog: catalogInfo.sources.find((item) => item.group === 'catalog'),
        presetExtended: catalogInfo.sources.find((item) => item.group === 'extended'),
        presetScenarioPages: catalogInfo.sources.find((item) => item.group === 'scenario-pages'),
        presetScenarioCatalog: catalogInfo.sources.find((item) => item.group === 'scenarios'),
        nativeDesign: { path: resolve(officeRoot, 'mona/slides-design.ts'), sha256: sha256(await readFile(resolve(officeRoot, 'mona/slides-design.ts'))) },
        nativeTypography: { path: resolve(officeRoot, 'mona/slides-typography.ts'), sha256: sha256(await readFile(resolve(officeRoot, 'mona/slides-typography.ts'))) },
        nativePath: { path: resolve(officeRoot, 'vendor/genoffice/packages/pptx-engine/src/custom-path.ts'), sha256: sha256(await readFile(resolve(officeRoot, 'vendor/genoffice/packages/pptx-engine/src/custom-path.ts'))) },
        presetBuilder: { path: resolve(officeRoot, 'mona/slides-presets.ts'), sha256: sha256(await readFile(resolve(officeRoot, 'mona/slides-presets.ts'))) },
        presetLayouts: { path: resolve(officeRoot, 'mona/slides-preset-layouts.ts'), sha256: sha256(await readFile(resolve(officeRoot, 'mona/slides-preset-layouts.ts'))) },
        fixture: { path: fixturePath, sha256: fixtureSha256 },
        blank: { path: blankPath, sha256: blankSha256 },
      },
      server: baseUrl,
      browser: executable.executablePath,
      browserSource: executable.source,
      playwright: playwright.source,
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      maxPages: options.maxPages,
      checkCandidates: options.checkCandidates,
      candidateChecks,
      fixtureGroups,
      baselineDiffs,
      decks,
      consoleErrors,
    }
    await writeFile(resolve(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify({
      output: resolve(outputRoot, 'report.json'),
      candidates: candidateChecks.length,
      decks: decks.map((deck) => ({ name: deck.name, pages: deck.pages.length, version: deck.version })),
    }, null, 2)}\n`)
  } finally {
    if (page) await page.close().catch(() => undefined)
    if (browser) await browser.close().catch(() => undefined)
    if (server) await server.close().catch(() => undefined)
    if (cacheDirectory) await cleanupViteCache(cacheDirectory)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
