import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const cli = process.argv.slice(2)
const reportArgument = cli.shift()
if (!reportArgument) throw new Error('Usage: node preset-assets.mjs <scenario-render-report.json> [--legacy-report <catalog-or-extended-report.json>]...')
const legacyReportArguments = []
while (cli.length) {
  const argument = cli.shift()
  if (argument !== '--legacy-report' || !cli[0]) throw new Error(`未知参数或缺少报告路径：${argument}`)
  legacyReportArguments.push(cli.shift())
}

const reportPath = resolve(reportArgument)
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const legacyReports = await Promise.all(legacyReportArguments.map(async (argument) => ({
  path: resolve(argument),
  report: JSON.parse(await readFile(resolve(argument), 'utf8')),
})))
const skill = resolve(root, 'mona/skills/mona-pptx')
const assetRoot = resolve(skill, 'assets')
const dest = resolve(assetRoot, 'presets')
const indexPath = resolve(dest, 'index.json')
const presetPaths = [
  { group: 'catalog', path: resolve(root, 'webui/office-editor/mona/presets/catalog.json') },
  { group: 'extended', path: resolve(root, 'webui/office-editor/mona/presets/extended.json') },
  { group: 'scenario-pages', path: resolve(root, 'webui/office-editor/mona/presets/scenario-pages.json') },
]
const scenarioPath = resolve(root, 'webui/office-editor/mona/presets/scenarios.json')
const builderPath = resolve(root, 'webui/office-editor/mona/slides-presets.ts')
const layoutPath = resolve(root, 'webui/office-editor/mona/slides-preset-layouts.ts')
const semanticsBytes = await readFile(resolve(root, 'webui/office-editor/mona/presets/legacy-semantics.json'))
const legacySemantics = JSON.parse(semanticsBytes.toString('utf8'))

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pathWithin(rootPath, candidate, label) {
  const rootValue = resolve(rootPath)
  const candidateValue = resolve(candidate)
  const remainder = relative(rootValue, candidateValue)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} 路径越界：${candidateValue}`)
  }
  return candidateValue
}

function assertSourceHash(reportSource, expectedHash, label) {
  if (!reportSource || typeof reportSource.sha256 !== 'string') {
    throw new Error(`渲染报告缺少 ${label} 来源哈希，请重新渲染 fixture。`)
  }
  if (reportSource.sha256 !== expectedHash) {
    throw new Error(`${label} 已修改，请重新渲染 fixture。`)
  }
}

async function readPresetFile(source) {
  const bytes = await readFile(source.path)
  const value = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(value?.presets)) throw new Error(`预设目录格式无效：${source.path}`)
  return {
    ...source,
    bytes,
    sha256: digest(bytes),
    presets: value.presets.map((preset) => ({ ...preset, ...(source.group === 'catalog' ? legacySemantics[preset.id] : {}), sourceGroup: source.group })),
  }
}

const presetFiles = await Promise.all(presetPaths.map(readPresetFile))
const scenarioBytes = await readFile(scenarioPath)
const scenarioCatalog = JSON.parse(scenarioBytes.toString('utf8'))
if (!Array.isArray(scenarioCatalog?.scenarios) || scenarioCatalog.scenarios.length !== 12) {
  throw new Error(`场景目录必须包含 12 个场景：${scenarioPath}`)
}
const currentHashes = {
  presetCatalogSha256: presetFiles.find((item) => item.group === 'catalog').sha256,
  presetExtendedSha256: presetFiles.find((item) => item.group === 'extended').sha256,
  presetScenarioPagesSha256: presetFiles.find((item) => item.group === 'scenario-pages').sha256,
  presetScenarioCatalogSha256: digest(scenarioBytes),
  presetBuilderSha256: digest(await readFile(builderPath)),
  presetLayoutsSha256: digest(await readFile(layoutPath)),
}

function verifyReportSources(candidate, label) {
  assertSourceHash(candidate.source?.presetCatalog, currentHashes.presetCatalogSha256, `${label} 的基础预设目录`)
  assertSourceHash(candidate.source?.presetExtended, currentHashes.presetExtendedSha256, `${label} 的扩展预设目录`)
  assertSourceHash(candidate.source?.presetScenarioPages, currentHashes.presetScenarioPagesSha256, `${label} 的场景特色页目录`)
  assertSourceHash(candidate.source?.presetScenarioCatalog, currentHashes.presetScenarioCatalogSha256, `${label} 的场景目录`)
  assertSourceHash(candidate.source?.presetBuilder, currentHashes.presetBuilderSha256, `${label} 的预设构建实现`)
  assertSourceHash(candidate.source?.presetLayouts, currentHashes.presetLayoutsSha256, `${label} 的扩展布局实现`)
}

verifyReportSources(report, '当前渲染报告')
for (const item of legacyReports) verifyReportSources(item.report, `旧模板报告 ${item.path}`)

const presetById = new Map()
const legacyPresetIds = new Set()
for (const presetFile of presetFiles) {
  for (const preset of presetFile.presets) {
    if (typeof preset.id !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(preset.id)) {
      throw new Error(`预设 ID 无效：${presetFile.path}`)
    }
    if (presetById.has(preset.id)) throw new Error(`预设目录存在重复 ID：${preset.id}`)
    presetById.set(preset.id, preset)
    if (preset.sourceGroup !== 'scenario-pages') legacyPresetIds.add(preset.id)
  }
}

const scenarioById = new Map()
const templateOwners = new Map()
for (const scenario of scenarioCatalog.scenarios) {
  if (!scenario || typeof scenario.id !== 'string' || !Array.isArray(scenario.templateIds)) {
    throw new Error('场景目录包含无效定义。')
  }
  if (scenarioById.has(scenario.id)) throw new Error(`场景 ID 重复：${scenario.id}`)
  scenarioById.set(scenario.id, scenario)
  for (const id of scenario.templateIds) {
    if (!presetById.has(id)) throw new Error(`${scenario.id} 引用了不存在的预设：${id}`)
    templateOwners.set(id, [...(templateOwners.get(id) ?? []), scenario.id])
  }
}

const previousIndex = JSON.parse(await readFile(indexPath, 'utf8').catch(() => '{"entries":[]}'))
const previousEntries = Array.isArray(previousIndex.entries) ? previousIndex.entries : []
const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]))
const scenarioPresetIds = new Set(presetFiles.find((item) => item.group === 'scenario-pages').presets.map((preset) => preset.id))

function flattenPages(candidate, candidatePath) {
  return (Array.isArray(candidate.decks) ? candidate.decks : []).flatMap((deck) => (
    Array.isArray(deck.pages)
      ? deck.pages.map((page) => ({ ...page, directory: dirname(deck.file) }))
      : []
  ))
}

const pages = flattenPages(report, reportPath)
const scenarioReport = pages.some((page) => typeof page.scenario === 'string')
const pageById = new Map(pages.filter((page) => typeof page.presetId === 'string').map((page) => [page.presetId, page]))
if (pages.length === 0 || pageById.size === 0) throw new Error('渲染报告没有可发布的预设页面。')

async function checkedVisualPair(candidatePage, reportDirectory, label) {
  if (!candidatePage.live || !candidatePage.reopened || !Array.isArray(candidatePage.live.warnings)
    || !Array.isArray(candidatePage.reopened.warnings)) {
    throw new Error(`${label} 缺少保存重开前后的真实视觉回执。`)
  }
  if ([...candidatePage.live.warnings, ...candidatePage.reopened.warnings]
    .some((warning) => typeof warning === 'string' && warning.startsWith('[错误]'))) {
    throw new Error(`${label} 的真实渲染包含阻塞性布局警告。`)
  }
  const livePath = pathWithin(reportDirectory,
    resolve(reportDirectory, candidatePage.directory, candidatePage.live.file), `${label} live PNG`)
  const reopenedPath = pathWithin(reportDirectory,
    resolve(reportDirectory, candidatePage.directory, candidatePage.reopened.file), `${label} reopened PNG`)
  const [liveBytes, reopenedBytes] = await Promise.all([readFile(livePath), readFile(reopenedPath)])
  const liveHash = digest(liveBytes)
  const reopenedHash = digest(reopenedBytes)
  if (candidatePage.live.sha256 !== liveHash || candidatePage.reopened.sha256 !== reopenedHash) {
    throw new Error(`${label} 的 PNG 文件与渲染报告哈希不一致。`)
  }
  if (liveHash !== reopenedHash || candidatePage.live.width !== candidatePage.reopened.width
    || candidatePage.live.height !== candidatePage.reopened.height) {
    throw new Error(`${label} 保存重开后的 PNG 哈希或尺寸不一致。`)
  }
  return { livePath, liveHash, reopenedHash, width: candidatePage.live.width, height: candidatePage.live.height }
}

async function loadExistingAsset(preset, label) {
  const previous = previousById.get(preset.id)
  if (!previous || typeof previous.asset !== 'string' || typeof previous.sha256 !== 'string') {
    throw new Error(`${label} 缺少旧预览：${preset.id}`)
  }
  const source = pathWithin(assetRoot, resolve(assetRoot, previous.asset), `${label} 旧预览`)
  const bytes = await readFile(source)
  const imageHash = digest(bytes)
  if (imageHash !== previous.sha256) throw new Error(`${label} 旧预览文件已变化：${preset.id}`)
  return { previous, source, imageHash }
}

const refreshedLegacyById = new Map()
if (legacyReports.length) {
  const refreshedPages = new Map()
  for (const item of legacyReports) {
    const candidatePages = flattenPages(item.report, item.path)
    const localIds = new Set()
    for (const page of candidatePages) {
      if (typeof page.scenario === 'string') throw new Error(`旧模板报告不能使用场景调色：${item.path}`)
      if (typeof page.presetId !== 'string' || !legacyPresetIds.has(page.presetId)) {
        throw new Error(`旧模板报告包含未知或非旧预设页：${page.presetId ?? '(missing)'}`)
      }
      if (localIds.has(page.presetId) || refreshedPages.has(page.presetId)) {
        throw new Error(`旧模板重渲染报告重复包含预设：${page.presetId}`)
      }
      localIds.add(page.presetId)
      refreshedPages.set(page.presetId, { page, report: item.report, reportPath: item.path })
    }
  }
  const missing = [...legacyPresetIds].filter((id) => !refreshedPages.has(id))
  if (missing.length) throw new Error(`旧模板重渲染报告未覆盖全部 ${legacyPresetIds.size} 个旧 ID；缺少 ${missing.join(', ')}`)
  for (const presetId of legacyPresetIds) {
    const preset = presetById.get(presetId)
    const item = refreshedPages.get(presetId)
    const visuals = await checkedVisualPair(item.page, dirname(item.reportPath), `旧预设 ${presetId}`)
    const { previous, imageHash } = await loadExistingAsset(preset, '旧预设')
    if (visuals.liveHash !== imageHash) {
      throw new Error(`旧预设 ${presetId} 的新实现渲染与已验收 PNG 不一致；保留原图并交由视觉审阅。`)
    }
    const sourceHashes = {
      presetCatalogSha256: item.report.source.presetCatalog.sha256,
      presetExtendedSha256: item.report.source.presetExtended.sha256,
      presetScenarioPagesSha256: item.report.source.presetScenarioPages.sha256,
      presetScenarioCatalogSha256: item.report.source.presetScenarioCatalog.sha256,
      presetBuilderSha256: item.report.source.presetBuilder.sha256,
      presetLayoutsSha256: item.report.source.presetLayouts.sha256,
    }
    refreshedLegacyById.set(presetId, {
      ...previous,
      id: preset.id,
      family: preset.family,
      theme: preset.theme,
      capacity: preset.capacity,
      asset: `presets/${preset.id}.png`,
      sha256: imageHash,
      sourceGroup: preset.sourceGroup,
      roles: Array.isArray(preset.roles) ? preset.roles : [],
      relation: preset.relation ?? null,
      scenario: null,
      presetBuilderSha256: sourceHashes.presetBuilderSha256,
      presetLayoutsSha256: sourceHashes.presetLayoutsSha256,
      fixtureSha256: item.report.fixtureSha256,
      provenance: {
        ...sourceHashes,
        fixtureSha256: item.report.fixtureSha256,
        livePngSha256: visuals.liveHash,
        reopenedPngSha256: visuals.reopenedHash,
        viewport: item.report.viewport,
      },
    })
  }
}

const scenarioPageById = new Map()
if (scenarioReport) {
  const renderedScenarioIds = new Set(pages.map((page) => page.scenario).filter((id) => typeof id === 'string'))
  for (const scenario of scenarioCatalog.scenarios) {
    if (!renderedScenarioIds.has(scenario.id)) throw new Error(`渲染报告缺少场景：${scenario.id}`)
  }
  for (const scenarioId of renderedScenarioIds) {
    if (!scenarioById.has(scenarioId)) throw new Error(`渲染报告包含未知场景：${scenarioId}`)
  }
  for (const presetId of scenarioPresetIds) {
    const owners = templateOwners.get(presetId) ?? []
    if (owners.length !== 1) throw new Error(`场景特色页必须只属于一个场景：${presetId}`)
    const matchingPages = pages.filter((page) => page.presetId === presetId && page.scenario === owners[0])
    if (matchingPages.length !== 1) throw new Error(`渲染报告中 ${owners[0]} 的 ${presetId} 页面必须恰好出现一次。`)
    scenarioPageById.set(presetId, matchingPages[0])
  }
}

function currentProvenance(entry) {
  const provenance = entry?.provenance
  return provenance?.presetCatalogSha256 === currentHashes.presetCatalogSha256
    && provenance?.presetExtendedSha256 === currentHashes.presetExtendedSha256
    && provenance?.presetScenarioPagesSha256 === currentHashes.presetScenarioPagesSha256
    && provenance?.presetScenarioCatalogSha256 === currentHashes.presetScenarioCatalogSha256
    && provenance?.presetBuilderSha256 === currentHashes.presetBuilderSha256
    && provenance?.presetLayoutsSha256 === currentHashes.presetLayoutsSha256
}

const hasPreviousScenarioEntries = [...scenarioPresetIds].some((id) => previousById.has(id))
const completePreviousScenarioEntries = [...scenarioPresetIds].every((id) => previousById.has(id))
  && [...scenarioPresetIds].every((id) => currentProvenance(previousById.get(id)))
const includeScenarioPages = scenarioReport || completePreviousScenarioEntries
if (hasPreviousScenarioEntries && !scenarioReport && !completePreviousScenarioEntries) {
  throw new Error('场景来源或预设实现已变化；请重新渲染 tests/scenarios/content.json。')
}

const verifiedLegacyById = new Map(refreshedLegacyById)
if (scenarioReport) {
  const missingProof = []
  for (const id of legacyPresetIds) {
    if (verifiedLegacyById.has(id)) continue
    const previous = previousById.get(id)
    if (!currentProvenance(previous)) {
      missingProof.push(id)
      continue
    }
    const preset = presetById.get(id)
    const { previous: validPrevious, imageHash } = await loadExistingAsset(preset, '旧预设')
    if (validPrevious.provenance.livePngSha256 !== imageHash
      || validPrevious.provenance.reopenedPngSha256 !== imageHash) {
      missingProof.push(id)
      continue
    }
    verifiedLegacyById.set(id, validPrevious)
  }
  if (missingProof.length) {
    throw new Error(`旧模板 PNG 尚未由当前 slides-presets.ts 保存重开验证（${missingProof.length} 项）；请用 --legacy-report 提供覆盖全部 48 个旧预设的真实渲染报告。`)
  }
}

async function installGenerated(preset, page, outputReportPath, outputReport) {
  const visuals = await checkedVisualPair(page, dirname(outputReportPath), `预设 ${preset.id}`)
  const target = resolve(dest, `${preset.id}.png`)
  if (visuals.livePath !== target) await copyFile(visuals.livePath, target)
  const provenance = {
    presetCatalogSha256: outputReport.source.presetCatalog.sha256,
    presetExtendedSha256: outputReport.source.presetExtended.sha256,
    presetScenarioPagesSha256: outputReport.source.presetScenarioPages.sha256,
    presetScenarioCatalogSha256: outputReport.source.presetScenarioCatalog.sha256,
    presetBuilderSha256: outputReport.source.presetBuilder.sha256,
    presetLayoutsSha256: outputReport.source.presetLayouts.sha256,
    fixtureSha256: outputReport.fixtureSha256,
    livePngSha256: visuals.liveHash,
    reopenedPngSha256: visuals.reopenedHash,
    viewport: outputReport.viewport,
  }
  return {
    id: preset.id,
    family: preset.family,
    theme: preset.theme,
    capacity: preset.capacity,
    asset: `presets/${preset.id}.png`,
    sha256: visuals.liveHash,
    sourceGroup: preset.sourceGroup,
    roles: Array.isArray(preset.roles) ? preset.roles : [],
    relation: preset.relation ?? null,
    scenario: preset.sourceGroup === 'scenario-pages' ? page.scenario : null,
    presetBuilderSha256: provenance.presetBuilderSha256,
    presetLayoutsSha256: provenance.presetLayoutsSha256,
    fixtureSha256: outputReport.fixtureSha256,
    provenance,
  }
}

async function preserveExisting(preset) {
  if (preset.sourceGroup === 'scenario-pages' && !includeScenarioPages) return null
  if (preset.sourceGroup === 'extended' && previousIndex.extendedBuilderSha256 !== currentHashes.presetLayoutsSha256) {
    throw new Error(`扩展布局实现已修改，不能复用旧预览：${preset.id}`)
  }
  const previous = verifiedLegacyById.get(preset.id) ?? previousById.get(preset.id)
  if (!previous || typeof previous.asset !== 'string' || typeof previous.sha256 !== 'string') {
    throw new Error(`缺少合格预览：${preset.id}`)
  }
  const catalog = presetFiles.find((item) => item.group === preset.sourceGroup)
  if (preset.sourceGroup !== 'scenario-pages') {
    const previousCatalogSha256 = preset.sourceGroup === 'catalog'
      ? previousIndex.catalogSha256
      : previousIndex.extendedCatalogSha256
    if (previousCatalogSha256 && previousCatalogSha256 !== catalog.sha256) {
      throw new Error(`${preset.sourceGroup} 预设定义已改变，不能复用旧预览：${preset.id}`)
    }
  }
  const { imageHash } = await loadExistingAsset(preset, '已有预览')
  if (previous.provenance?.livePngSha256 && previous.provenance.livePngSha256 !== imageHash) {
    throw new Error(`已有预览与其 live provenance 不一致：${preset.id}`)
  }
  if (previous.provenance?.reopenedPngSha256 && previous.provenance.reopenedPngSha256 !== imageHash) {
    throw new Error(`已有预览与其 reopened provenance 不一致：${preset.id}`)
  }
  return {
    ...previous,
    id: preset.id,
    family: preset.family,
    theme: preset.theme,
    capacity: preset.capacity,
    asset: `presets/${preset.id}.png`,
    sha256: imageHash,
    sourceGroup: previous.sourceGroup ?? preset.sourceGroup,
    roles: previous.roles ?? (Array.isArray(preset.roles) ? preset.roles : []),
    relation: previous.relation ?? preset.relation ?? null,
    scenario: preset.sourceGroup === 'scenario-pages' ? previous.scenario : null,
    presetBuilderSha256: previous.presetBuilderSha256 ?? null,
    presetLayoutsSha256: previous.presetLayoutsSha256 ?? null,
    fixtureSha256: previous.fixtureSha256
      ?? previousIndex.groups?.[preset.sourceGroup]?.fixtureSha256
      ?? previousIndex.fixtureSha256,
  }
}

await mkdir(dest, { recursive: true })
const entries = []
for (const presetFile of presetFiles) {
  for (const preset of presetFile.presets) {
    if (preset.sourceGroup === 'scenario-pages') {
      if (scenarioReport) entries.push(await installGenerated(preset, scenarioPageById.get(preset.id), reportPath, report))
      else if (includeScenarioPages) entries.push(await preserveExisting(preset))
      continue
    }
    // Old previews are refreshed only from neutral-theme reports or explicit
    // save/reopen proof. Scenario-tinted pages share the existing legacy PNG.
    if (scenarioReport) entries.push(await preserveExisting(preset))
    else {
      const rendered = pageById.get(preset.id)
      if (rendered) entries.push(await installGenerated(preset, rendered, reportPath, report))
      else entries.push(await preserveExisting(preset))
    }
  }
}

const entryById = new Map(entries.filter(Boolean).map((entry) => [entry.id, entry]))
const scenarios = includeScenarioPages ? scenarioCatalog.scenarios.map((scenario) => ({
  id: scenario.id,
  label: scenario.label,
  description: scenario.description,
  defaultTheme: scenario.defaultTheme,
  palette: scenario.palette,
  templateIds: [...scenario.templateIds],
  templates: scenario.templateIds.map((id) => {
    const preset = presetById.get(id)
    const entry = entryById.get(id)
    if (!entry) throw new Error(`${scenario.id} 缺少索引预览：${id}`)
    return {
      id,
      family: preset.family,
      theme: preset.theme,
      relation: preset.relation ?? null,
      roles: Array.isArray(preset.roles) ? preset.roles : [],
      asset: entry.asset,
      sha256: entry.sha256,
    }
  }),
  signaturePages: Array.isArray(scenario.signaturePages) ? scenario.signaturePages : [],
})) : []

const groups = Object.fromEntries(presetFiles.map(({ group }) => {
  const groupEntries = entries.filter((entry) => entry?.sourceGroup === group)
  const fixtureSha256 = group === 'scenario-pages' && scenarioReport
    ? report.fixtureSha256
    : groupEntries.find((entry) => entry.fixtureSha256)?.fixtureSha256
      ?? previousIndex.groups?.[group]?.fixtureSha256
      ?? (group === 'catalog' ? previousIndex.fixtureSha256 : null)
  return [group, {
    fixtureSha256,
    presetBuilderSha256: groupEntries.length > 0 && groupEntries.every((entry) => entry.presetBuilderSha256 === currentHashes.presetBuilderSha256)
      ? currentHashes.presetBuilderSha256
      : null,
    presetLayoutsSha256: groupEntries.length > 0 && groupEntries.every((entry) => entry.presetLayoutsSha256 === currentHashes.presetLayoutsSha256)
      ? currentHashes.presetLayoutsSha256
      : null,
    pages: groupEntries.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
  }]
}))
const index = {
  schemaVersion: 1,
  legacySemanticsSha256: digest(semanticsBytes),
  catalogSha256: currentHashes.presetCatalogSha256,
  extendedCatalogSha256: currentHashes.presetExtendedSha256,
  scenarioCatalogSha256: currentHashes.presetScenarioCatalogSha256,
  scenarioPagesSha256: currentHashes.presetScenarioPagesSha256,
  presetBuilderSha256: currentHashes.presetBuilderSha256,
  extendedBuilderSha256: currentHashes.presetLayoutsSha256,
  fixtureSha256: previousIndex.fixtureSha256 ?? null,
  groups,
  entries: entries.filter(Boolean),
  ...(includeScenarioPages ? { scenarios } : {}),
}
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)

const entryRows = index.entries.map((entry) => (
  `| ${entry.sourceGroup} | ${entry.id} | ${entry.family} | ${entry.theme} | ${entry.relation ?? '—'} | ${entry.roles?.join('、') || '—'} | ${entry.asset} |`
))
const scenarioSections = scenarios.flatMap((scenario) => [
  `## ${scenario.label}（${scenario.id}）`,
  '',
  `主题：${scenario.defaultTheme}。${scenario.description}`,
  '',
  '| 页面 | 预设 ID | 关系 | 资源路径 |',
  '|---|---|---|---|',
  ...scenario.templates.map((template, index) => {
    const signature = scenario.signaturePages.find((page) => page.preferredPresetId === template.id)
    return `| ${signature?.label ?? `页面 ${index + 1}`} | ${template.id} | ${template.relation ?? '—'} | ${template.asset} |`
  }),
  '',
])
await writeFile(resolve(skill, 'references/preset-index.md'), [
  '# 原生预设预览索引',
  '',
  '预览来自真实 SlideCanvas。场景表中的相同预设 ID 共用同一 PNG；新增场景特色页使用所属场景的真实渲染。容量以编辑器当前能力回执为准。',
  '',
  '`skill_asset_copy` 参数：`skill: "mona-pptx"`、`asset: 表内资源路径`、`dest: 当前工作区路径`；复制后用 `read_file` 查看真实图像。',
  '',
  ...scenarioSections,
  '## 全部预设资源与兼容 ID',
  '',
  '| 分组 | 预设 ID | 家族 | 主题 | 关系 | 角色 | 资源路径 |',
  '|---|---|---|---|---|---|---|',
  ...entryRows,
  '',
].join('\n'))
console.log(JSON.stringify({
  previews: index.entries.length,
  scenarios: scenarios.length,
  scenarioPages: scenarioPresetIds.size,
  refreshedLegacyPages: refreshedLegacyById.size,
  catalogSha256: index.catalogSha256,
  extendedCatalogSha256: index.extendedCatalogSha256,
  groups: Object.fromEntries(Object.entries(groups).map(([group, value]) => [group, value.pages.length])),
}))
