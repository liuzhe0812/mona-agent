#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const monaRoot = resolve(scriptDir, '../../..')
const selectionPath = resolve(monaRoot, 'webui/office-editor/mona/presets/dashi-selection.json')
const assetManifestPath = resolve(monaRoot, 'mona/skills/mona-pptx/assets/dashi/manifest.json')
const templatesPath = resolve(monaRoot, 'mona/skills/mona-pptx/assets/dashi/templates.json')
const templateAssetsPath = resolve(monaRoot, 'mona/skills/mona-pptx/assets/dashi/template-assets.json')
const outputRoot = resolve(monaRoot, 'output/ppt-dashi-migration-20261014')
const singlePageOutputRoot = resolve(monaRoot, 'output/single-page-import-20261014')
const workerEnv = 'MONA_DASHI_PRESET_IMPORT_WORKER'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const selectionBytes = readFileSync(selectionPath)
const selection = JSON.parse(selectionBytes.toString('utf8'))
const dashiRoot = resolve(monaRoot, selection.sourceRoots.dashiProject)
const dashiPackage = readJson(resolve(dashiRoot, 'package.json'))
const tsxCli = resolve(dashiRoot, 'node_modules/tsx/dist/cli.mjs')

if (!process.env[workerEnv]) {
  if (!existsSync(tsxCli)) throw new Error(`Dashi tsx runner is missing: ${tsxCli}`)
  const result = spawnSync(process.execPath, [tsxCli, scriptPath, ...process.argv.slice(2)], {
    cwd: dashiRoot,
    env: { ...process.env, [workerEnv]: '1', INIT_CWD: monaRoot },
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

const { copySlide, openPptx } = await import('../vendor/genoffice/packages/pptx-engine/src/index.ts')
const assetManifest = readJson(assetManifestPath)
const assetByHash = new Map()
for (const asset of assetManifest.assets ?? []) {
  for (const hash of [asset.sourceSha256, asset.compressedSha256]) {
    if (hash) assetByHash.set(hash.toLowerCase(), asset.id)
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function selectedPages() {
  const pages = new Map()
  for (const scenario of selection.scenarios ?? []) {
    for (const layout of scenario.pages ?? scenario.layouts ?? []) {
      let page = pages.get(layout.sourceLayoutId)
      if (!page) {
        page = { layout, scenarioRefs: [] }
        pages.set(layout.sourceLayoutId, page)
      }
      page.scenarioRefs.push({
        id: scenario.id,
        label: scenario.label,
        use: layout.scenarioUse,
        description: layout.useDescription,
        role: layout.role ?? [],
      })
    }
  }
  return [...pages.values()].sort((left, right) => {
    const a = left.layout
    const b = right.layout
    return a.sourceTheme.localeCompare(b.sourceTheme)
      || a.pageNumber - b.pageNumber
      || a.sourceLayoutId.localeCompare(b.sourceLayoutId)
  })
}

function copyFieldDefinitions(layout) {
  return (layout.availableContentFields?.sourceCopyFields
    ?? layout.availableContentFields?.copyFields
    ?? (layout.availableContentFields?.copyKeys ?? []).map((field) => ({ field })))
    .map((item) => typeof item === 'string' ? { field: item } : item)
    .filter((item) => typeof item?.field === 'string')
}

function copyFieldPatterns(layout) {
  return copyFieldDefinitions(layout).map(({ field }) => field)
}

function compiledDefaultProps(layout, runtimePage) {
  const defaults = layout.compiledDefaultProps ?? layout.defaultProps ?? runtimePage.defaultProps ?? {}
  return JSON.parse(JSON.stringify(defaults))
}

function parseLimit() {
  const index = process.argv.indexOf('--limit')
  if (index < 0) return Number.POSITIVE_INFINITY
  const limit = Number(process.argv[index + 1])
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.')
  return limit
}

function parseThemeFilter() {
  const index = process.argv.indexOf('--theme')
  if (index < 0) return null
  const theme = process.argv[index + 1]
  if (!/^theme\d{2}$/.test(theme ?? '')) throw new Error('--theme must be a Dashi theme key such as theme03.')
  return theme
}

function parsePageFilter() {
  const index = process.argv.indexOf('--page')
  if (index < 0) return null
  const id = process.argv[index + 1]
  if (!selected.some(({ layout }) => layout.sourceLayoutId === id)) throw new Error('--page must be a selected Dashi source layout ID.')
  return id
}

const selected = selectedPages()
const selectedIds = new Set(selected.map(({ layout }) => layout.sourceLayoutId))
const limit = parseLimit()
const themeFilter = parseThemeFilter()
const pageFilter = parsePageFilter()
if (themeFilter && !selected.some(({ layout }) => layout.sourceTheme === themeFilter)) {
  throw new Error(`No selected Dashi pages for ${themeFilter}.`)
}
const filteredPages = selected.filter(({ layout }) => (
  (!themeFilter || layout.sourceTheme === themeFilter)
  && (!pageFilter || layout.sourceLayoutId === pageFilter)
))
const pagesToRender = filteredPages.slice(0, limit)
const groups = new Map()
for (const page of pagesToRender) {
  const theme = page.layout.sourceTheme
  if (!groups.has(theme)) groups.set(theme, [])
  groups.get(theme).push(page)
}

const runtimePagesByTheme = new Map()
for (const page of selected) {
  const theme = page.layout.sourceTheme
  if (runtimePagesByTheme.has(theme)) continue
  const runtimePath = resolve(dashiRoot, `dist/theme-runtime/${theme}.module.mjs`)
  if (!existsSync(runtimePath)) throw new Error(`Compiled Dashi runtime is missing for ${theme}: ${runtimePath}`)
  const runtime = await import(pathToFileURL(runtimePath).href)
  runtimePagesByTheme.set(theme, new Map((runtime.runtimePages ?? []).map((entry) => [entry.key, entry])))
}

for (const { layout } of selected) {
  const sourcePage = runtimePagesByTheme.get(layout.sourceTheme)?.get(layout.sourceLayoutId)
  if (!sourcePage) throw new Error(`Compiled Dashi page is missing: ${layout.sourceLayoutId}`)
  if (!sourcePage.defaultProps || typeof sourcePage.defaultProps !== 'object') {
    throw new Error(`Compiled Dashi page has no defaultProps: ${layout.sourceLayoutId}`)
  }
  const selectedDefaults = layout.compiledDefaultProps ?? layout.defaultProps
  for (const pattern of copyFieldPatterns(layout)) {
    const selectedStrings = stringsAtPattern(selectedDefaults ?? {}, pattern).map(({ path, value }) => ({ path, value }))
    const compiledStrings = stringsAtPattern(sourcePage.defaultProps, pattern).map(({ path, value }) => ({ path, value }))
    if (stableJson(selectedStrings) !== stableJson(compiledStrings)) {
      throw new Error(`Selection copy-string defaults do not match Dashi runtime: ${layout.sourceLayoutId} ${pattern}`)
    }
  }
}

function stringsAtPattern(root, pattern) {
  const segments = pattern.split('.')
  let states = [{ value: root, path: '' }]
  for (const segment of segments) {
    const isArray = segment.endsWith('[]')
    const key = isArray ? segment.slice(0, -2) : segment
    states = states.flatMap(({ value, path }) => {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return []
      const child = value[key]
      const nextPath = path ? `${path}.${key}` : key
      if (isArray) {
        if (!Array.isArray(child)) return []
        return child.map((entry, index) => ({ value: entry, path: `${nextPath}[${index}]` }))
      }
      return [{ value: child, path: nextPath }]
    })
  }
  return states.filter(({ value }) => typeof value === 'string' && value.length > 0)
}

function decodeXmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code === 'amp') return '&'
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    if (code === 'quot') return '"'
    if (code === 'apos') return "'"
    const number = code.toLowerCase().startsWith('#x')
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10)
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity
  })
}

function textIndexes(slideXml) {
  return [...slideXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlText(match[1]))
}

function xmlTextRuns(slideXml, slideSize) {
  const scaleX = 1920 / (Number(slideSize?.cx) || 1920)
  const scaleY = 1080 / (Number(slideSize?.cy) || 1080)
  const containers = [...slideXml.matchAll(/<(p:sp|p:graphicFrame|p:cxnSp)\b[\s\S]*?<\/\1>/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    bounds: (() => {
      const transform = /<([ap]):xfrm\b[^>]*>([\s\S]*?)<\/\1:xfrm>/.exec(match[0])?.[2]
      const offset = /<(?:a|p):off\b[^>]*\/>/.exec(transform ?? '')?.[0]
      const extent = /<(?:a|p):ext\b[^>]*\/>/.exec(transform ?? '')?.[0]
      const number = (tag, name) => {
        const value = new RegExp(`\\b${name}="(-?\\d+)"`).exec(tag ?? '')?.[1]
        return value === undefined ? null : Number(value)
      }
      const x = number(offset, 'x')
      const y = number(offset, 'y')
      const cx = number(extent, 'cx')
      const cy = number(extent, 'cy')
      return [x, y, cx, cy].every(Number.isFinite)
        ? {x: x * scaleX, y: y * scaleY, w: cx * scaleX, h: cy * scaleY}
        : null
    })(),
  }))
  let containerIndex = 0
  return [...slideXml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match, index) => {
    const position = match.index ?? 0
    while (containerIndex < containers.length && containers[containerIndex].end <= position) containerIndex += 1
    const container = containers[containerIndex]
    return {
      index,
      text: decodeXmlText(match[1]),
      shapeBounds: container && container.start <= position && position < container.end ? container.bounds : null,
    }
  })
}

function matchTextLayoutToXml(segmentCandidates, slideXml, slideSize, candidateLimitExceededIndexes = []) {
  const candidateLimitExceeded = new Set(candidateLimitExceededIndexes)
  return xmlTextRuns(slideXml, slideSize).map((run) => {
    if (candidateLimitExceeded.has(run.index)) {
      return {text: run.text, xmlTextIndex: null, xmlTextIndexes: [], xmlTextMatch: 'ambiguous', candidateLimitExceeded: true}
    }
    const candidates = segmentCandidates.filter((item) => item.xmlTextIndex === run.index)
    const wholeTextMatches = candidates.filter((item) => item.wholeTextNode)
    const preferred = wholeTextMatches.length ? wholeTextMatches : candidates
    if (!preferred.length) {
      return {text: run.text, xmlTextIndex: null, xmlTextIndexes: [], xmlTextMatch: 'unmatched'}
    }

    let selected = preferred[0]
    if (preferred.length > 1 && run.shapeBounds) {
      const centerX = run.shapeBounds.x + run.shapeBounds.w / 2
      const centerY = run.shapeBounds.y + run.shapeBounds.h / 2
      const ranked = preferred.map((item) => ({
        item,
        distance: Math.hypot(item.rect.x + item.rect.w / 2 - centerX, item.rect.y + item.rect.h / 2 - centerY),
      })).sort((a, b) => a.distance - b.distance)
      if (ranked.length > 1 && Math.abs(ranked[1].distance - ranked[0].distance) <= 0.5) {
        return {
          text: run.text,
          xmlTextIndex: null,
          xmlTextIndexes: [],
          xmlTextMatch: 'ambiguous',
          candidateSourceTextNodeIndexes: [...new Set(preferred.map((item) => item.sourceTextNodeIndex))],
        }
      }
      selected = ranked[0].item
    } else if (preferred.length > 1) {
      return {
        text: run.text,
        xmlTextIndex: null,
        xmlTextIndexes: [],
        xmlTextMatch: 'ambiguous',
        candidateSourceTextNodeIndexes: [...new Set(preferred.map((item) => item.sourceTextNodeIndex))],
      }
    }

    return {
      ...selected,
      text: run.text,
      xmlTextIndex: run.index,
      xmlTextIndexes: [run.index],
      xmlTextMatch: selected.wholeTextNode ? 'exact' : 'substring',
      xmlShapeBounds: run.shapeBounds,
    }
  })
}

function bindFields(layout, sourcePage, slideXml) {
  const values = new Map()
  const availableCopyFields = copyFieldDefinitions(layout)
  for (const copyField of availableCopyFields) {
    const key = typeof copyField === 'string' ? copyField : copyField.field
    if (typeof key !== 'string') continue
    for (const field of stringsAtPattern(sourcePage.defaultProps, key)) {
      values.set(field.path, { ...field, sourceKey: key, maxChars: copyField.maxChars })
    }
  }
  const slideTexts = textIndexes(slideXml)
  const pathsByValue = new Map()
  const pathsByCaseFoldedValue = new Map()
  for (const [path, field] of values) {
    if (!pathsByValue.has(field.value)) pathsByValue.set(field.value, [])
    pathsByValue.get(field.value).push(path)
    const caseFolded = field.value.toUpperCase()
    if (!pathsByCaseFoldedValue.has(caseFolded)) pathsByCaseFoldedValue.set(caseFolded, [])
    pathsByCaseFoldedValue.get(caseFolded).push(path)
  }
  return [...values.entries()].map(([path, field]) => {
    const exactCandidates = []
    const caseCandidates = []
    slideTexts.forEach((text, index) => {
      if (text === field.value) exactCandidates.push(index)
      else if (text.toUpperCase() === field.value.toUpperCase()) caseCandidates.push(index)
    })
    const candidates = exactCandidates.length ? exactCandidates : caseCandidates
    const duplicatedDefault = (pathsByValue.get(field.value)?.length ?? 0) > 1
      || (pathsByCaseFoldedValue.get(field.value.toUpperCase())?.length ?? 0) > 1
    const status = duplicatedDefault || candidates.length > 1
      ? 'ambiguous'
      : candidates.length === 1
        ? exactCandidates.length ? 'matched' : 'matched-case-insensitive'
        : 'unmatched'
    return {
      path,
      defaultValue: status === 'matched-case-insensitive' ? slideTexts[candidates[0]] : field.value,
      ...(status === 'matched-case-insensitive' ? {
        sourceDefaultValue: field.value,
        valueTransform: slideTexts[candidates[0]] === field.value.toUpperCase()
          ? 'uppercase'
          : slideTexts[candidates[0]] === field.value.toLowerCase() ? 'lowercase' : 'case-transformed',
      } : {}),
      textIndexes: status === 'matched' ? candidates : [],
      ...(status === 'matched-case-insensitive' ? { textIndexes: candidates } : {}),
      matchStatus: status,
      ...(status === 'ambiguous' ? { candidateTextIndexes: candidates } : {}),
      ...(Number.isFinite(field.maxChars) ? { maxChars: field.maxChars } : {}),
    }
  })
}

function pictureUsages(bundle) {
  const xml = bundle.slideXml
  const imageRels = new Map(bundle.rels
    .filter((rel) => rel.type.endsWith('/image') && !rel.external)
    .map((rel) => [rel.id, rel.target]))
  const pictureBlocks = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)].map((match) => match[0])
  const hasEditableText = /<a:t\b[^>]*>/.test(xml)
  const editableShapeCount = [...xml.matchAll(/<p:sp\b/g)].length
  return pictureBlocks.flatMap((block) => {
    const relationshipId = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(block)?.[1]
    const partPath = relationshipId ? imageRels.get(relationshipId) : undefined
    if (!partPath) return []
    const transform = /<a:xfrm\b[^>]*>[\s\S]*?<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>[\s\S]*?<\/a:xfrm>/.exec(block)
    const geometry = transform ? {
      x: Number(transform[1]),
      y: Number(transform[2]),
      cx: Number(transform[3]),
      cy: Number(transform[4]),
    } : null
    const slideSize = bundle.slideSize
    const fullBleed = geometry && slideSize?.cx && slideSize?.cy
      && geometry.x <= slideSize.cx * 0.01
      && geometry.y <= slideSize.cy * 0.01
      && geometry.x + geometry.cx >= slideSize.cx * 0.99
      && geometry.y + geometry.cy >= slideSize.cy * 0.99
    const classification = !geometry
      ? 'unclassified-picture'
      : fullBleed
        ? editableShapeCount || hasEditableText || pictureBlocks.length > 1
          ? 'full-slide-background-with-editable-content'
          : 'whole-slide-flatten'
        : 'independent-picture'
    return [{ partPath, geometry, classification, editableShapeCount, hasEditableText }]
  })
}

function mediaPartDetails(encodedParts, contentTypes, usages, pageId, packageKind) {
  const usageByPath = new Map()
  for (const usage of usages) {
    if (!usageByPath.has(usage.partPath)) usageByPath.set(usage.partPath, [])
    usageByPath.get(usage.partPath).push(usage)
  }
  const rows = []
  for (const [partPath, base64] of Object.entries(encodedParts)) {
    const contentType = partContentType(partPath, contentTypes)
    if (!contentType.startsWith('image/') && !/\.(png|jpe?g|svg|webp|gif|bmp|emf|wmf)$/i.test(partPath)) continue
    const bytes = Buffer.from(base64, 'base64')
    rows.push({
      pageId,
      packageKind,
      partPath,
      sha256: hashBytes(bytes),
      contentType,
      sourceBytes: bytes.length,
      assetId: assetByHash.get(hashBytes(bytes)) ?? null,
      usages: usageByPath.get(partPath)?.map(({ geometry, classification, editableShapeCount, hasEditableText }) => ({
        geometry,
        classification,
        editableShapeCount,
        hasEditableText,
      })) ?? [{ classification: packageKind === 'chain' ? 'layout-chain-resource' : 'related-media-resource' }],
    })
  }
  return rows
}

function partContentType(path, contentTypes) {
  const ext = extname(path).slice(1).toLowerCase()
  return contentTypes[path] ?? contentTypes[ext] ?? ''
}

function partIsXml(path, contentType) {
  return path.toLowerCase().endsWith('.xml')
    || path.toLowerCase().endsWith('.rels')
    || contentType.includes('xml')
}

const collectedParts = new Map()
const referencedAssets = new Set()

function collectPartRefs(encodedParts, contentTypes) {
  const partRefs = {}
  for (const [path, base64] of Object.entries(encodedParts)) {
    const bytes = Buffer.from(base64, 'base64')
    const hash = hashBytes(bytes)
    const assetId = assetByHash.get(hash)
    if (assetId) referencedAssets.add(assetId)
    if (!collectedParts.has(hash)) {
      const contentType = partContentType(path, contentTypes)
      collectedParts.set(hash, assetId
        ? { assetId }
        : partIsXml(path, contentType)
          ? { xml: bytes.toString('utf8') }
          : { base64: bytes.toString('base64') })
    }
    partRefs[path] = hash
  }
  return partRefs
}

function buildPage(selectedPage, bundle, warningList) {
  const { layout, scenarioRefs } = selectedPage
  const sourcePage = runtimePagesByTheme.get(layout.sourceTheme).get(layout.sourceLayoutId)
  const contentTypes = bundle.contentTypes ?? {}
  const partRefs = collectPartRefs(bundle.parts ?? {}, contentTypes)
  const chain = bundle.chain ? {
    layoutPath: bundle.chain.layoutPath,
    masterPath: bundle.chain.masterPath,
    ...(bundle.chain.themePath ? { themePath: bundle.chain.themePath } : {}),
    partRefs: collectPartRefs(bundle.chain.parts ?? {}, bundle.chain.contentTypes ?? {}),
    contentTypes: bundle.chain.contentTypes ?? {},
  } : undefined
  const roles = [...new Set(scenarioRefs.flatMap((item) => item.role))]
  const assets = new Set()
  for (const part of Object.values(partRefs)) {
    const stored = collectedParts.get(part)
    if (stored?.assetId) assets.add(stored.assetId)
  }
  for (const part of Object.values(chain?.partRefs ?? {})) {
    const stored = collectedParts.get(part)
    if (stored?.assetId) assets.add(stored.assetId)
  }
  const template = {
    id: layout.sourceLayoutId,
    source: {
      theme: layout.sourceTheme,
      layoutId: layout.sourceLayoutId,
      pageNumber: layout.pageNumber,
      label: layout.label,
      roles,
      scenarios: scenarioRefs,
      sourceShaEvidence: layout.sourceShaEvidence ?? null,
      sourceRendering: layout.sourceRendering ?? null,
      renderPropsMode: 'compiled-runtime-defaultProps',
      defaultPropsSha256: hashBytes(Buffer.from(stableJson(compiledDefaultProps(layout, sourcePage)), 'utf8')),
    },
    bundle: {
      slideXml: bundle.slideXml,
      rels: bundle.rels,
      partRefs,
      contentTypes,
      slideSize: bundle.slideSize ?? null,
      ...(chain ? { chain } : {}),
    },
    fields: bindFields(layout, { defaultProps: compiledDefaultProps(layout, sourcePage) }, bundle.slideXml),
    assetIds: [...assets].sort(),
    fallbackWarnings: warningList,
  }
  const usages = pictureUsages(bundle)
  return {
    template,
    media: [
      ...mediaPartDetails(bundle.parts ?? {}, contentTypes, usages, template.id, 'slide'),
      ...(bundle.chain ? mediaPartDetails(bundle.chain.parts ?? {}, bundle.chain.contentTypes ?? {}, [], template.id, 'chain') : []),
    ],
  }
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
}

function staticServer(root) {
  const rootPath = resolve(root)
  return createServer((request, response) => {
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end('Bad request')
      return
    }
    const candidate = resolve(rootPath, `.${pathname === '/' ? '/index.html' : pathname}`)
    const remainder = relative(rootPath, candidate)
    if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
      response.writeHead(403).end('Forbidden')
      return
    }
    try {
      const bytes = readFileSync(candidate)
      response.writeHead(200, {
        'content-type': mimeTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      response.end(bytes)
    } catch {
      response.writeHead(404).end('Not found')
    }
  })
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function materializeCompiledDefaults(htmlPath, pages) {
  const html = readFileSync(htmlPath, 'utf8')
  const opening = '<script id="deck-view-model" type="application/json">'
  const markerIndex = html.indexOf(opening)
  if (markerIndex < 0) throw new Error('Dashi rendered HTML has no deck-view-model script.')
  const jsonStart = markerIndex + opening.length
  const jsonEnd = html.indexOf('</script>', jsonStart)
  if (jsonEnd < 0) throw new Error('Dashi rendered HTML has an unterminated deck-view-model script.')
  const viewModel = JSON.parse(html.slice(jsonStart, jsonEnd))
  if (viewModel.slides?.length !== pages.length) {
    throw new Error(`Dashi view model contains ${viewModel.slides?.length ?? 0} slides; expected ${pages.length}.`)
  }
  pages.forEach(({ selected: entry, source }, index) => {
    const slide = viewModel.slides[index]
    if (slide.layout !== entry.layout.sourceLayoutId) {
      throw new Error(`Dashi view model slide ${index + 1} layout ${slide.layout} does not match ${entry.layout.sourceLayoutId}.`)
    }
    slide.materializedProps = compiledDefaultProps(entry.layout, source)
  })
  const encoded = JSON.stringify(viewModel).replaceAll('<', '\\u003c')
  writeFileSync(htmlPath, `${html.slice(0, jsonStart)}${encoded}${html.slice(jsonEnd)}`, 'utf8')
}

function writeTextLayoutEvidence(existingRows, newRows, evidenceRoot = outputRoot) {
  const rowsById = new Map(existingRows.filter((row) => selectedIds.has(row.id)).map((row) => [row.id, row]))
  for (const row of newRows) rowsById.set(row.id, row)
  writeJsonAtomic(resolve(evidenceRoot, 'text-layout-evidence.json'), {
    schemaVersion: 1,
    coordinateUnit: 'css-px relative to the rendered slide',
    source: 'Dashi exportEditablePptxFromPage internal DOM collector',
    pages: [...rowsById.values()].sort((a, b) => a.theme.localeCompare(b.theme) || a.pageNumber - b.pageNumber),
  })
}

function evaluatePageWithTimeout(page, evaluate, argument, label, timeoutMs = 30_000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} DOM evaluation exceeded ${timeoutMs}ms.`)), timeoutMs)
  })
  return Promise.race([page.evaluate(evaluate, argument), timeout]).finally(() => clearTimeout(timer))
}

function collectDomTextLayout(entry) {
  const slide = document.querySelectorAll('#deck > .slide')[window.__currentSlideIndex || 0]
  if (!slide) throw new Error(`Dashi source slide is missing for ${entry.id}.`)
  const slideRect = slide.getBoundingClientRect()
  const scaleX = slideRect.width ? 1920 / slideRect.width : 1
  const scaleY = slideRect.height ? 1080 / slideRect.height : 1
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  const sourceTextNodes = []
  const candidateCache = new Map()
  const candidateLimitExceededIndexes = []
  const maxCandidatesPerRun = 256
  const nonRenderableTextTags = new Set(['STYLE', 'SCRIPT', 'DEFS', 'METADATA', 'TITLE', 'DESC', 'TEMPLATE', 'NOSCRIPT'])
  let sourceTextNodeIndex = 0

  for (const element of slide.querySelectorAll('*')) {
    if (nonRenderableTextTags.has(element.tagName)) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0.01) continue
    if (!element.getClientRects().length && style.display !== 'contents') continue
    const directTextNodes = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim())
    if (!directTextNodes.length) continue
    const fontSize = Number.parseFloat(style.fontSize)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const letterSpacing = Number.parseFloat(style.letterSpacing)
    for (const node of directTextNodes) {
      const sourceText = node.textContent ?? ''
      const fullRange = document.createRange()
      fullRange.selectNodeContents(node)
      const fullRect = fullRange.getBoundingClientRect()
      if (fullRect.width <= 0 || fullRect.height <= 0) continue
      const visualText = style.textTransform === 'uppercase'
        ? sourceText.toUpperCase()
        : style.textTransform === 'lowercase' ? sourceText.toLowerCase() : sourceText
      sourceTextNodes.push({
        node,
        sourceText,
        sourceTextNodeIndex: sourceTextNodeIndex++,
        visualText,
        fontSizePx: Number.isFinite(fontSize) ? fontSize : null,
        lineHeightPx: Number.isFinite(lineHeight) ? lineHeight : null,
        letterSpacingPx: Number.isFinite(letterSpacing) ? letterSpacing : null,
        fontFamily: style.fontFamily,
        fontStyle: style.fontStyle,
        fontWeight: style.fontWeight,
        textTransform: style.textTransform,
      })
    }
  }

  const isVisibleText = (text) => text.trim() && !/^[\u200B-\u200D\u2060\uFEFF]+$/.test(text)
  const candidatesFor = (targetText) => {
    if (candidateCache.has(targetText)) return candidateCache.get(targetText)
    const matches = []
    const fullMatches = sourceTextNodes.filter((source) => source.visualText === targetText)
      .map((source) => ({source, start: 0, end: source.sourceText.length, wholeTextNode: true}))
    let limitExceeded = fullMatches.length > maxCandidatesPerRun
    if (!limitExceeded && fullMatches.length) matches.push(...fullMatches)
    if (!fullMatches.length) {
      for (const source of sourceTextNodes) {
        if (source.visualText.length !== source.sourceText.length) continue
        let start = source.visualText.indexOf(targetText)
        while (start >= 0) {
          if (matches.length >= maxCandidatesPerRun) {
            limitExceeded = true
            break
          }
          matches.push({source, start, end: start + targetText.length, wholeTextNode: false})
          const nextStart = start + 1
          if (nextStart <= start) break
          start = source.visualText.indexOf(targetText, nextStart)
        }
        if (limitExceeded) break
      }
    }
    if (limitExceeded) {
      const result = {items: [], limitExceeded: true}
      candidateCache.set(targetText, result)
      return result
    }
    const items = matches.map(({source, start, end, wholeTextNode}) => {
      const range = document.createRange()
      range.setStart(source.node, start)
      range.setEnd(source.node, end)
      const rect = range.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const logicalY = (rect.top - slideRect.top) * scaleY
      let metrics = null
      if (context && Number.isFinite(source.fontSizePx)) {
        context.font = `${source.fontStyle} ${source.fontWeight} ${source.fontSizePx}px ${source.fontFamily}`
        metrics = context.measureText(targetText)
      }
      const fontAscent = Number.isFinite(metrics?.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : null
      return {
        sourceTextNodeIndex: source.sourceTextNodeIndex,
        sourceText: source.sourceText,
        sourceRange: {startOffset: start, endOffset: end},
        wholeTextNode,
        rect: {
          x: (rect.left - slideRect.left) * scaleX,
          y: logicalY,
          w: rect.width * scaleX,
          h: rect.height * scaleY,
        },
        fontSizePx: source.fontSizePx,
        lineHeightPx: source.lineHeightPx,
        letterSpacingPx: source.letterSpacingPx,
        fontFamily: source.fontFamily,
        fontWeight: source.fontWeight,
        textTransform: source.textTransform,
        baselinePx: fontAscent == null ? null : logicalY + fontAscent,
        fontBoundingBoxAscentPx: fontAscent,
        fontBoundingBoxDescentPx: Number.isFinite(metrics?.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : null,
        actualBoundingBoxAscentPx: Number.isFinite(metrics?.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : null,
        actualBoundingBoxDescentPx: Number.isFinite(metrics?.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : null,
      }
    }).filter(Boolean)
    const result = {items, limitExceeded: false}
    candidateCache.set(targetText, result)
    return result
  }

  const segmentCandidates = []
  for (const xmlRun of entry.xmlRuns) {
    if (!isVisibleText(xmlRun.text)) continue
    const result = candidatesFor(xmlRun.text)
    if (result.limitExceeded) {
      candidateLimitExceededIndexes.push(xmlRun.index)
      continue
    }
    for (const item of result.items) segmentCandidates.push({...item, xmlTextIndex: xmlRun.index})
  }
  return {
    id: entry.id,
    theme: entry.theme,
    pageNumber: entry.pageNumber,
    logicalSlide: {width: 1920, height: 1080},
    renderedSlideRect: {x: slideRect.x, y: slideRect.y, width: slideRect.width, height: slideRect.height},
    segmentCandidates,
    candidateLimitExceededIndexes,
  }
}

function loadExistingDocument() {
  if (!existsSync(templatesPath)) return { pages: [], parts: {} }
  const document = readJson(templatesPath)
  if (document.sourceRootVersion && document.sourceRootVersion !== dashiPackage.version) {
    throw new Error(`templates.json was generated from Dashi ${document.sourceRootVersion}, current source is ${dashiPackage.version}.`)
  }
  return document
}

function writeDocument(existingPages, existingParts, newPages) {
  const pagesById = new Map(existingPages.filter((page) => selectedIds.has(page.id)).map((page) => [page.id, page]))
  for (const page of newPages) pagesById.set(page.id, page)
  const pages = [...pagesById.values()].sort((a, b) => a.source.theme.localeCompare(b.source.theme)
    || a.source.pageNumber - b.source.pageNumber
    || a.id.localeCompare(b.id))
  const allParts = new Map([...Object.entries(existingParts), ...[...collectedParts.entries()]])
  const usedHashes = new Set()
  for (const page of pages) {
    for (const hash of Object.values(page.bundle.partRefs)) usedHashes.add(hash)
    for (const hash of Object.values(page.bundle.chain?.partRefs ?? {})) usedHashes.add(hash)
  }
  const parts = Object.fromEntries([...usedHashes].sort().flatMap((hash) => {
    const value = allParts.get(hash)
    return value ? [[hash, value]] : []
  }))
  const document = {
    schemaVersion: 1,
    sourceRootVersion: dashiPackage.version,
    sourceSelectionSha256: hashBytes(selectionBytes),
    sourceEvidence: selection.sourceEvidence,
    slideSizeUnits: 'EMU',
    pages,
    parts,
  }
  writeJsonAtomic(templatesPath, document)
  writeJsonAtomic(templateAssetsPath, {
    schemaVersion: 1,
    pages: pages.map((page) => ({ id: page.id, assetIds: page.assetIds })),
  })
  return { pages, parts }
}

async function captureThemeTextLayout(theme, selectedThemePages, document, existingEvidence) {
  const pptRoot = resolve(outputRoot, 'source', theme, 'ppt')
  const htmlPath = resolve(pptRoot, 'index.html')
  if (!existsSync(htmlPath)) throw new Error(`Rendered Dashi deck is missing for ${theme}: ${htmlPath}`)
  const screenshotsRoot = resolve(outputRoot, 'previews')
  mkdirSync(screenshotsRoot, { recursive: true })
  const pages = selectedThemePages.map(({ layout }) => ({
    selected: selected.find((candidate) => candidate.layout.sourceLayoutId === layout.sourceLayoutId),
    source: runtimePagesByTheme.get(theme).get(layout.sourceLayoutId),
  }))
  const server = staticServer(pptRoot)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(`Local Dashi preview server failed for ${theme}.`)
  const dashiRequire = createRequire(resolve(dashiRoot, 'package.json'))
  const { chromium } = dashiRequire('playwright-core')
  const { launchExportBrowser } = await import(pathToFileURL(resolve(dashiRoot, 'scripts/preview/launch-export-browser.mjs')).href)
  let browser
  try {
    browser = await launchExportBrowser(chromium, { fallbackTmpDirs: [resolve(outputRoot, '.browser-tmp')] })
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__renderRuntimeSlide === 'function', null, { timeout: 60_000 })
    const slides = page.locator('#deck > .slide')
    await slides.first().waitFor({ state: 'attached', timeout: 60_000 })
    if (await slides.count() !== pages.length) throw new Error(`${theme}: source DOM has ${await slides.count()} slides; expected ${pages.length}.`)
    for (let index = 0; index < pages.length; index += 1) {
      const rendered = await slides.nth(index).evaluate((slide, props) => (
        window.__renderRuntimeSlide(slide, props, { trusted: true })
      ), compiledDefaultProps(pages[index].selected.layout, pages[index].source))
      if (!rendered) throw new Error(`${theme}: Dashi runtime could not materialize ${pages[index].selected.layout.sourceLayoutId}.`)
    }
    await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 60_000 })
    const pageEntries = pages.map(({ selected: entry }) => {
      const templatePage = document.pages.find((candidate) => candidate.id === entry.layout.sourceLayoutId)
      if (!templatePage) throw new Error(`Manifest is missing ${entry.layout.sourceLayoutId} while recording text geometry.`)
      return {
        id: entry.layout.sourceLayoutId,
        theme,
        pageNumber: entry.layout.pageNumber,
        xmlRuns: xmlTextRuns(templatePage.bundle.slideXml, templatePage.bundle.slideSize),
      }
    })
    const rows = []
    for (let index = 0; index < pageEntries.length; index += 1) {
      await page.evaluate((slideIndex) => {
        const dot = document.querySelectorAll('#nav .dot')[slideIndex]
        if (!dot) throw new Error(`Dashi navigation is missing slide ${slideIndex + 1}.`)
        dot.click()
      }, index)
      await page.waitForFunction((slideIndex) => {
        const slide = document.querySelectorAll('#deck > .slide')[slideIndex]
        return window.__currentSlideIndex === slideIndex && slide?.classList.contains('active') && slide.getBoundingClientRect().width > 0
      }, index, { timeout: 30_000 })
      const slideId = pageEntries[index].id
      await evaluatePageWithTimeout(page, async () => {
        await document.fonts?.ready
        await new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))
      }, undefined, `${theme} font readiness for ${slideId}`)
      await slides.nth(index).screenshot({ path: resolve(screenshotsRoot, `${slideId}.png`) })
      rows.push(await evaluatePageWithTimeout(page, (entry) => {
        const slide = document.querySelectorAll('#deck > .slide')[window.__currentSlideIndex]
        const slideRect = slide.getBoundingClientRect()
        const scaleX = slideRect.width ? 1920 / slideRect.width : 1
        const scaleY = slideRect.height ? 1080 / slideRect.height : 1
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        const sourceTextNodes = []
        const candidateCache = new Map()
        const candidateLimitExceededIndexes = []
        const maxCandidatesPerRun = 256
        const nonRenderableTextTags = new Set(['STYLE', 'SCRIPT', 'DEFS', 'METADATA', 'TITLE', 'DESC', 'TEMPLATE', 'NOSCRIPT'])
        let sourceTextNodeIndex = 0
        for (const element of slide.querySelectorAll('*')) {
          if (nonRenderableTextTags.has(element.tagName)) continue
          const style = getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) <= 0.01) continue
          if (!element.getClientRects().length && style.display !== 'contents') continue
          const directTextNodes = [...element.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim())
          if (!directTextNodes.length) continue
          const fontSize = Number.parseFloat(style.fontSize)
          const lineHeight = Number.parseFloat(style.lineHeight)
          const letterSpacing = Number.parseFloat(style.letterSpacing)
          for (const node of directTextNodes) {
            const sourceText = node.textContent ?? ''
            const fullRange = document.createRange()
            fullRange.selectNodeContents(node)
            const fullRect = fullRange.getBoundingClientRect()
            if (fullRect.width <= 0 || fullRect.height <= 0) continue
            const visualText = style.textTransform === 'uppercase'
              ? sourceText.toUpperCase()
              : style.textTransform === 'lowercase' ? sourceText.toLowerCase() : sourceText
            sourceTextNodes.push({
              node,
              sourceText,
              sourceTextNodeIndex: sourceTextNodeIndex++,
              visualText,
              fontSizePx: Number.isFinite(fontSize) ? fontSize : null,
              lineHeightPx: Number.isFinite(lineHeight) ? lineHeight : null,
              letterSpacingPx: Number.isFinite(letterSpacing) ? letterSpacing : null,
              fontFamily: style.fontFamily,
              fontStyle: style.fontStyle,
              fontWeight: style.fontWeight,
              textTransform: style.textTransform,
            })
          }
        }
        const isVisibleText = (text) => text.trim() && !/^[\u200B-\u200D\u2060\uFEFF]+$/.test(text)
        const candidatesFor = (targetText) => {
          if (candidateCache.has(targetText)) return candidateCache.get(targetText)
          const matches = []
          const fullMatches = sourceTextNodes.filter((source) => source.visualText === targetText)
            .map((source) => ({source, start: 0, end: source.sourceText.length, wholeTextNode: true}))
          let limitExceeded = fullMatches.length > maxCandidatesPerRun
          if (!limitExceeded && fullMatches.length) matches.push(...fullMatches)
          if (!fullMatches.length) {
            for (const source of sourceTextNodes) {
              if (source.visualText.length !== source.sourceText.length) continue
              let start = source.visualText.indexOf(targetText)
              while (start >= 0) {
                if (matches.length >= maxCandidatesPerRun) {
                  limitExceeded = true
                  break
                }
                matches.push({source, start, end: start + targetText.length, wholeTextNode: false})
                const nextStart = start + 1
                if (nextStart <= start) break
                start = source.visualText.indexOf(targetText, nextStart)
              }
              if (limitExceeded) break
            }
          }
          if (limitExceeded) {
            const result = {items: [], limitExceeded: true}
            candidateCache.set(targetText, result)
            return result
          }
          const items = matches.map(({source, start, end, wholeTextNode}) => {
            const range = document.createRange()
            range.setStart(source.node, start)
            range.setEnd(source.node, end)
            const rect = range.getBoundingClientRect()
            const logicalY = (rect.top - slideRect.top) * scaleY
            let metrics = null
            if (context && Number.isFinite(source.fontSizePx)) {
              context.font = `${source.fontStyle} ${source.fontWeight} ${source.fontSizePx}px ${source.fontFamily}`
              metrics = context.measureText(targetText)
            }
            const fontAscent = Number.isFinite(metrics?.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : null
            return {
              sourceTextNodeIndex: source.sourceTextNodeIndex,
              sourceText: source.sourceText,
              sourceRange: {startOffset: start, endOffset: end},
              wholeTextNode,
              rect: {
                x: (rect.left - slideRect.left) * scaleX,
                y: logicalY,
                w: rect.width * scaleX,
                h: rect.height * scaleY,
              },
              fontSizePx: source.fontSizePx,
              lineHeightPx: source.lineHeightPx,
              letterSpacingPx: source.letterSpacingPx,
              fontFamily: source.fontFamily,
              fontWeight: source.fontWeight,
              textTransform: source.textTransform,
              baselinePx: fontAscent == null ? null : logicalY + fontAscent,
              fontBoundingBoxAscentPx: fontAscent,
              fontBoundingBoxDescentPx: Number.isFinite(metrics?.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : null,
              actualBoundingBoxAscentPx: Number.isFinite(metrics?.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : null,
              actualBoundingBoxDescentPx: Number.isFinite(metrics?.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : null,
            }
          })
          const result = {items, limitExceeded: false}
          candidateCache.set(targetText, result)
          return result
        }
        const segmentCandidates = []
        for (const xmlRun of entry.xmlRuns) {
          if (!isVisibleText(xmlRun.text)) continue
          const result = candidatesFor(xmlRun.text)
          if (result.limitExceeded) {
            candidateLimitExceededIndexes.push(xmlRun.index)
            continue
          }
          for (const item of result.items) {
            segmentCandidates.push({...item, xmlTextIndex: xmlRun.index})
          }
        }
        return {
          id: entry.id,
          theme: entry.theme,
          pageNumber: entry.pageNumber,
          logicalSlide: { width: 1920, height: 1080 },
          renderedSlideRect: { x: slideRect.x, y: slideRect.y, width: slideRect.width, height: slideRect.height },
          segmentCandidates,
          candidateLimitExceededIndexes,
        }
      }, pageEntries[index], `${theme} text geometry for ${slideId}`))
    }

    for (const row of rows) {
      const templatePage = document.pages.find((candidate) => candidate.id === row.id)
      if (!templatePage) throw new Error(`Manifest is missing ${row.id} while recording text geometry.`)
      row.textLayout = matchTextLayoutToXml(row.segmentCandidates, templatePage.bundle.slideXml, templatePage.bundle.slideSize, row.candidateLimitExceededIndexes)
      delete row.segmentCandidates
      delete row.candidateLimitExceededIndexes
      templatePage.textLayout = row.textLayout
    }
    writeJsonAtomic(templatesPath, document)
    writeTextLayoutEvidence(existingEvidence, rows)
    return rows
  } finally {
    if (browser) await browser.close()
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
}

async function exportTheme(theme, selectedThemePages) {
  if (selectedThemePages.length !== 1) throw new Error(`${theme}: every Dashi source export must contain exactly one selected page.`)
  const pageId = selectedThemePages[0].layout.sourceLayoutId
  const outputThemeRoot = resolve(singlePageOutputRoot, 'source', pageId)
  const pptRoot = resolve(outputThemeRoot, 'ppt')
  const goalPath = resolve(outputThemeRoot, 'goal.json')
  const htmlPath = resolve(pptRoot, 'index.html')
  const pptxPath = resolve(outputThemeRoot, 'source-export.pptx')
  const reportPath = resolve(outputThemeRoot, 'export-report.json')
  const screenshotsRoot = resolve(singlePageOutputRoot, 'previews')
  mkdirSync(pptRoot, { recursive: true })
  mkdirSync(screenshotsRoot, { recursive: true })

  const pages = selectedThemePages.map(({ layout }) => ({
    selected: selected.find((candidate) => candidate.layout.sourceLayoutId === layout.sourceLayoutId),
    source: runtimePagesByTheme.get(theme).get(layout.sourceLayoutId),
  }))
  const goal = {
    title: `Dashi ${pageId} single-page source export`,
    goal: 'Build-time source export for Mona editable native PowerPoint layout templates.',
    themePack: theme,
    pageCount: pages.length,
    language: 'zh',
    slides: pages.map(({ selected: entry, source }) => ({
      id: entry.layout.sourceLayoutId,
      key: entry.layout.sourceLayoutId,
      role: entry.layout.role?.[0] ?? 'content',
      layout: entry.layout.sourceLayoutId,
      props: {},
    })),
  }
  writeJsonAtomic(goalPath, goal)
  const renderScript = resolve(dashiRoot, 'scripts/render-goal-deck.jsx')
  const render = spawnSync(process.execPath, [tsxCli, renderScript, goalPath, htmlPath], {
    cwd: dashiRoot,
    env: { ...process.env, INIT_CWD: monaRoot },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (render.error) throw render.error
  if (render.status !== 0) throw new Error(`Dashi ${theme} render failed (${render.status}):\n${render.stdout}\n${render.stderr}`)
  materializeCompiledDefaults(htmlPath, pages)

  const server = staticServer(pptRoot)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(`Local Dashi preview server failed for ${theme}.`)

  let browser
  let exporterReport
  let textLayoutEvidence
  let sourceDeck
  let builtPages
  let textLayoutSummary
  const pageErrors = []
  const dashiRequire = createRequire(resolve(dashiRoot, 'package.json'))
  const { chromium } = dashiRequire('playwright-core')
  const { launchExportBrowser } = await import(pathToFileURL(resolve(dashiRoot, 'scripts/preview/launch-export-browser.mjs')).href)
  const { exportEditablePptxFromPage } = await import(pathToFileURL(resolve(dashiRoot, 'packages/html-deck-to-pptx/index.mjs')).href)
  try {
    browser = await launchExportBrowser(chromium, { fallbackTmpDirs: [resolve(singlePageOutputRoot, '.browser-tmp')] })
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => typeof window.__renderRuntimeSlide === 'function', null, { timeout: 60_000 })
    const slides = page.locator('#deck > .slide')
    await slides.first().waitFor({ state: 'attached', timeout: 60_000 })
    const renderedSlideCount = await slides.count()
    if (renderedSlideCount !== pages.length) throw new Error(`${theme}: expected ${pages.length} rendered slides, found ${renderedSlideCount}.`)
    for (let index = 0; index < pages.length; index += 1) {
      const rendered = await slides.nth(index).evaluate((slide, props) => (
        window.__renderRuntimeSlide(slide, props, { trusted: true })
      ), compiledDefaultProps(pages[index].selected.layout, pages[index].source))
      if (!rendered) throw new Error(`${theme}: Dashi runtime could not materialize ${pages[index].selected.layout.sourceLayoutId}.`)
    }
    await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 60_000 })
    await page.evaluate(async () => {
      await document.fonts?.ready
      await new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise)))
    })
    for (let index = 0; index < pages.length; index += 1) {
      await slides.nth(index).screenshot({ path: resolve(screenshotsRoot, `${pages[index].selected.layout.sourceLayoutId}.png`) })
    }
    exporterReport = await exportEditablePptxFromPage(page, {
      outFile: pptxPath,
      reportFile: reportPath,
      title: goal.title,
    })
    textLayoutEvidence = await page.evaluate(async (pageEntries) => {
      if (typeof window.__collectEditablePptxSlide !== 'function') {
        throw new Error('Dashi exporter did not install __collectEditablePptxSlide.')
      }
      const rows = []
      for (let index = 0; index < pageEntries.length; index += 1) {
        const slide = await window.__collectEditablePptxSlide(index + 1)
        const textNodes = []
        const walk = (node) => {
          if (!node) return
          if (typeof node.text === 'string' && node.text.trim()) {
            const style = node.style ?? {}
            textNodes.push({
              index: textNodes.length,
              text: node.text,
              rect: node.rect ?? null,
              renderRect: node.renderRect ?? null,
              fontFamily: style.fontFamily ?? null,
              fontSize: style.fontSize ?? null,
              fontWeight: style.fontWeight ?? null,
              lineHeight: style.lineHeight ?? null,
              letterSpacing: style.letterSpacing ?? null,
              textAlign: style.textAlign ?? null,
              textTransform: style.textTransform ?? null,
              color: style.color ?? null,
              source: node.source ?? null,
            })
          }
          for (const child of node.children ?? []) walk(child)
        }
        walk(slide?.root)
        rows.push({
          id: pageEntries[index].id,
          theme: pageEntries[index].theme,
          pageNumber: pageEntries[index].pageNumber,
          slideIndex: slide?.index ?? index + 1,
          summary: slide?.summary ?? null,
          warnings: slide?.warnings ?? [],
          textNodes,
        })
      }
      return rows
    }, pages.map(({ selected: entry }) => ({
      id: entry.layout.sourceLayoutId,
      theme,
      pageNumber: entry.layout.pageNumber,
    })))
    sourceDeck = await openPptx(readFileSync(pptxPath))
    if (sourceDeck.deck.slides.length !== 1) {
      throw new Error(`${pageId}: expected a one-page source PPTX, found ${sourceDeck.deck.slides.length}.`)
    }
    const bundle = copySlide(sourceDeck, 0)
    if (!bundle) throw new Error(`Mona copySlide returned no bundle for ${pageId}.`)
    const layoutEntry = pages[0].selected.layout
    const rangeData = await evaluatePageWithTimeout(page, collectDomTextLayout, {
      id: pageId,
      theme,
      pageNumber: layoutEntry.pageNumber,
      xmlRuns: xmlTextRuns(bundle.slideXml, bundle.slideSize),
    }, `${theme} text geometry for ${pageId}`)
    const textLayout = matchTextLayoutToXml(rangeData.segmentCandidates, bundle.slideXml, bundle.slideSize, rangeData.candidateLimitExceededIndexes)
    const warningList = (exporterReport.warnings ?? []).filter((warning) => warning.slide === 1)
    const builtPage = buildPage(pages[0].selected, bundle, warningList)
    builtPage.template.textLayout = textLayout
    builtPages = [builtPage]
    if (textLayoutEvidence[0]) {
      textLayoutEvidence[0].renderedSlideRect = rangeData.renderedSlideRect
      textLayoutEvidence[0].textLayout = textLayout
    }
    textLayoutSummary = {
      xmlTextRuns: textLayout.length,
      matchedExactOrSubstring: textLayout.filter((item) => item.xmlTextMatch === 'exact' || item.xmlTextMatch === 'substring').length,
      ambiguous: textLayout.filter((item) => item.xmlTextMatch === 'ambiguous').length,
      unmatched: textLayout.filter((item) => item.xmlTextMatch === 'unmatched').length,
      candidateLimitExceeded: textLayout.filter((item) => item.candidateLimitExceeded).length,
    }
  } finally {
    if (browser) await browser.close()
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
  if (pageErrors.length) throw new Error(`${theme} Dashi renderer reported page errors: ${pageErrors.join('\n')}`)
  if (!exporterReport || exporterReport.slideCount !== pages.length) {
    throw new Error(`${theme} Dashi exporter returned ${exporterReport?.slideCount ?? 0} pages; expected ${pages.length}.`)
  }

  if (!sourceDeck || sourceDeck.deck.slides.length !== 1) throw new Error(`${pageId}: no one-page source PPTX was imported.`)
  const sourceScreenshotPath = resolve(screenshotsRoot, `${pageId}.png`)
  writeJsonAtomic(resolve(outputThemeRoot, 'template.json'), builtPages[0].template)
  writeJsonAtomic(resolve(outputThemeRoot, 'import-report.json'), {
    templateId: pageId,
    theme,
    sourceGoal: goalPath,
    sourceHtml: htmlPath,
    sourcePptx: pptxPath,
    sourcePptxSha256: hashBytes(readFileSync(pptxPath)),
    sourceScreenshot: sourceScreenshotPath,
    sourceScreenshotSha256: existsSync(sourceScreenshotPath) ? hashBytes(readFileSync(sourceScreenshotPath)) : null,
    slideCount: sourceDeck.deck.slides.length,
    templatePartCount: Object.keys(builtPages[0].template.bundle.partRefs).length,
    assetIds: builtPages[0].template.assetIds,
    exporterWarningCount: (exporterReport.warnings ?? []).length,
    textLayout: textLayoutSummary,
  })
  return { builtPages, exporterReport, textLayoutEvidence }
}

function buildMediaReport(mediaRows, storedParts = Object.fromEntries(collectedParts.entries())) {
  const unique = new Map()
  for (const row of mediaRows) {
    const current = unique.get(row.sha256)
    if (!current) unique.set(row.sha256, row)
  }
  const uniqueMedia = [...unique.values()]
  const sourceDependencyBytes = mediaRows.reduce((sum, row) => sum + row.sourceBytes, 0)
  const uniqueSourceBytes = uniqueMedia.reduce((sum, row) => sum + row.sourceBytes, 0)
  const inlineBytes = uniqueMedia.filter((row) => !row.assetId).reduce((sum, row) => sum + row.sourceBytes, 0)
  const inlineBase64Bytes = uniqueMedia.filter((row) => !row.assetId).reduce((sum, row) => {
    const stored = storedParts[row.sha256]
    return sum + (typeof stored?.base64 === 'string' ? Buffer.byteLength(stored.base64) : 0)
  }, 0)
  const assetIds = [...new Set(uniqueMedia.flatMap((row) => row.assetId ? [row.assetId] : []))].sort()
  const installedAssetBytes = assetIds.reduce((sum, id) => {
    const asset = assetManifest.assets.find((item) => item.id === id)
    if (!asset) return sum
    const filePath = resolve(monaRoot, 'mona/skills/mona-pptx/assets/dashi', asset.file)
    return sum + (existsSync(filePath) ? statSync(filePath).size : 0)
  }, 0)
  return {
    schemaVersion: 1,
    totals: {
      mediaPartReferences: mediaRows.length,
      uniqueMediaHashes: uniqueMedia.length,
      sourceDependencyBytes,
      uniqueSourceMediaBytes: uniqueSourceBytes,
      bytesSavedByHashDeduplication: sourceDependencyBytes - uniqueSourceBytes,
      uniqueInlineSourceMediaBytes: inlineBytes,
      uniqueInlineBase64Bytes: inlineBase64Bytes,
      manifestAssetIds: assetIds,
      installedManifestAssetBytes: installedAssetBytes,
    },
    pages: mediaRows,
  }
}

async function main() {
  mkdirSync(singlePageOutputRoot, { recursive: true })
  const priorTemplatesPath = resolve(singlePageOutputRoot, 'prior-templates.json')
  const priorTemplateAssetsPath = resolve(singlePageOutputRoot, 'prior-template-assets.json')
  if (existsSync(templatesPath) && !existsSync(priorTemplatesPath)) writeFileSync(priorTemplatesPath, readFileSync(templatesPath))
  if (existsSync(templateAssetsPath) && !existsSync(priorTemplateAssetsPath)) writeFileSync(priorTemplateAssetsPath, readFileSync(templateAssetsPath))
  const existing = loadExistingDocument()
  if (process.argv.includes('--capture-text-layout')) {
    const manifestIds = new Set((existing.pages ?? []).map((page) => page.id))
    const missing = pagesToRender.filter(({ layout }) => !manifestIds.has(layout.sourceLayoutId)).map(({ layout }) => layout.sourceLayoutId)
    if (missing.length) throw new Error(`Cannot capture text layout before blueprint pages exist: ${missing.slice(0, 8).join(', ')}`)
    const evidencePath = resolve(outputRoot, 'text-layout-evidence.json')
    for (const [theme, themePages] of groups) {
      const rows = await captureThemeTextLayout(theme, themePages, existing, existsSync(evidencePath) ? readJson(evidencePath).pages ?? [] : [])
      process.stdout.write(`${JSON.stringify({ theme, pages: rows.length, textNodes: rows.reduce((count, row) => count + row.textLayout.length, 0) })}\n`)
    }
    const completed = loadExistingDocument()
    const textLayoutPages = (completed.pages ?? []).filter((page) => page.textLayout)
    const mediaReportPath = resolve(outputRoot, 'media-report.json')
    if (existsSync(mediaReportPath)) {
      const mediaRows = readJson(mediaReportPath).pages ?? []
      writeJsonAtomic(mediaReportPath, buildMediaReport(mediaRows, completed.parts ?? {}))
    }
    process.stdout.write(`${JSON.stringify({
      capturedPages: textLayoutPages.length,
      textNodes: textLayoutPages.reduce((count, page) => count + page.textLayout.length, 0),
      templates: templatesPath,
      textEvidence: evidencePath,
      templatesBytes: statSync(templatesPath).size,
      outputRoot,
    }, null, 2)}\n`)
    return
  }
  const existingPages = existing.pages ?? []
  const existingParts = existing.parts ?? {}
  const mediaReportPath = resolve(singlePageOutputRoot, 'media-report.json')
  const existingMediaRows = existsSync(mediaReportPath) ? readJson(mediaReportPath).pages ?? [] : []
  const generatedPages = []
  const generatedMedia = []
  const generatedTextEvidence = []
  const summary = []
  for (const [theme, themePages] of groups) {
    const pageArtifacts = []
    const textEvidence = []
    let warningCount = 0
    for (const selectedPage of themePages) {
      const { builtPages, exporterReport, textLayoutEvidence } = await exportTheme(theme, [selectedPage])
      if (builtPages.length !== 1) throw new Error(`${theme}: single-page exporter returned ${builtPages.length} blueprints.`)
      pageArtifacts.push(...builtPages)
      generatedPages.push(...builtPages.map(({ template }) => template))
      generatedMedia.push(...builtPages.flatMap(({ media }) => media))
      textEvidence.push(...textLayoutEvidence)
      generatedTextEvidence.push(...textLayoutEvidence)
      warningCount += exporterReport.warnings?.length ?? 0
      for (const assetId of builtPages[0].template.assetIds) referencedAssets.add(assetId)
      process.stdout.write(`${JSON.stringify({theme,pageId:selectedPage.layout.sourceLayoutId,sourcePptx:resolve(singlePageOutputRoot,'source',selectedPage.layout.sourceLayoutId,'source-export.pptx'),slideCount:exporterReport.slideCount,assetCount:builtPages[0].template.assetIds.length})}\n`)
    }
    const document = writeDocument(existingPages, existingParts, generatedPages)
    const regeneratedIds = new Set(generatedPages.map((page) => page.id))
    const mergedMedia = [
      ...existingMediaRows.filter((row) => !regeneratedIds.has(row.pageId)),
      ...generatedMedia,
    ]
    const mediaReport = buildMediaReport(mergedMedia, document.parts)
    writeJsonAtomic(mediaReportPath, mediaReport)
    const targetTextEvidencePath = resolve(singlePageOutputRoot, 'text-layout-evidence.json')
    const existingTextEvidence = existsSync(targetTextEvidencePath)
      ? readJson(targetTextEvidencePath).pages ?? []
      : []
    writeTextLayoutEvidence(existingTextEvidence, generatedTextEvidence, singlePageOutputRoot)
    summary.push({
      theme,
      pageCount: pageArtifacts.length,
      warningCount,
      matchedFields: pageArtifacts.reduce((count, { template }) => count + template.fields.filter((field) => field.textIndexes.length > 0).length, 0),
      ambiguousFields: pageArtifacts.reduce((count, { template }) => count + template.fields.filter((field) => field.matchStatus === 'ambiguous').length, 0),
      manifestPages: document.pages.length,
      sharedParts: Object.keys(document.parts).length,
      mediaReferences: mediaReport.totals.mediaPartReferences,
      uniqueMediaHashes: mediaReport.totals.uniqueMediaHashes,
      deduplicatedMediaBytes: mediaReport.totals.bytesSavedByHashDeduplication,
      textNodes: textEvidence.reduce((count, page) => count + page.textNodes.length, 0),
    })
    process.stdout.write(`${JSON.stringify(summary.at(-1))}\n`)
  }
  process.stdout.write(`${JSON.stringify({
    templates: templatesPath,
    templateAssets: templateAssetsPath,
    sourceRootVersion: dashiPackage.version,
    selectedPages: pagesToRender.length,
    renderedPages: generatedPages.length,
    assetIds: [...referencedAssets].sort(),
    media: buildMediaReport([
      ...existingMediaRows.filter((row) => !new Set(generatedPages.map((page) => page.id)).has(row.pageId)),
      ...generatedMedia,
    ], loadExistingDocument().parts ?? {}).totals,
    templatesBytes: statSync(templatesPath).size,
    outputRoot: singlePageOutputRoot,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
