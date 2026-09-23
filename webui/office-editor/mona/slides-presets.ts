import catalog from './presets/catalog.json'
import extended from './presets/extended.json'
import roleCatalog from './presets/roles.json'
import legacySemantics from './presets/legacy-semantics.json'
import { expandAdditionalLayout, type AdditionalLayoutElement } from './slides-preset-layouts'
import { missingRequiredFacts, preparePresetContent } from './slides-preset-content'
import { expandContentPage } from './slides-content-page'
import targetIcon from './presets/icons/target.svg?raw'
import layersIcon from './presets/icons/layers.svg?raw'
import workflowIcon from './presets/icons/workflow.svg?raw'
import checkIcon from './presets/icons/check.svg?raw'

/**
 * 幻灯片预设页面：设计好的原生页面由程序稳定实例化。
 *
 * 约定：
 * - 预设只声明受约束的原生对象、区域、内容绑定和主题角色，不含表达式、脚本或自由 HTML/CSS。
 * - 区域使用预览像素，和 slide_compose / 现有 add 操作同一坐标系；需要 EMU 的高级操作按真实比例换算。
 * - 内容与样式分离：样式来自主题角色，内容来自调用方传入的 content。
 * - 容量在展开前校验，不满足时明确报错并且不产生任何操作（不半页成功）。
 * - 图表样式由编辑器在取得元素 ID 后自动应用，同一命令提交或回滚。
 */

export const PRESET_SCHEMA_VERSION = 1

export type PresetThemeId = 'dark-product' | 'light-editorial'
export type PresetColorRole = 'background' | 'surface' | 'text' | 'muted' | 'accent' | 'line'
export type PresetSizeRole = 'metric' | 'hero' | 'title' | 'subtitle' | 'body' | 'caption'
export type PresetAlign = 'left' | 'center' | 'right' | 'justify'
export type PresetRelation = 'none' | 'parallel' | 'sequence' | 'hierarchy' | 'matrix' | 'cycle' | 'network'
export type PresetTextBind = 'title' | 'summary' | 'takeaway'
export type SmartArtLayout = 'list' | 'process' | 'cycle' | 'hierarchy' | 'pyramid' | 'matrix' | 'venn'

export interface PresetBox { x: number; y: number; width: number; height: number }

export interface PresetTheme {
  id: PresetThemeId
  /** 参考来源：用来核对比例，不复制对方的品牌色。 */
  reference: string
  /** System font; substituted fonts still need visual fit review. */
  fontFamily: string
  background: string
  surface: string
  text: string
  muted: string
  accent: string
  line: string
  sizes: Record<PresetSizeRole, number>
  /** 页面安全边距（预览像素），与参考主题的 pad 按画布比例换算。 */
  pad: { x: number; y: number }
  /** 区块间距（预览像素）。 */
  gap: number
  chart: {
    textColor: string
    axisLabelColor: string
    legendColor: string
    dataLabelColor: string
    seriesColors: string[]
    gridColor?: string
    axisLineColor?: string
    axisLabelFontSize?: number
  }
}

export interface PresetChartContent {
  kind: 'bar' | 'line' | 'area' | 'pie' | 'doughnut'
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  catAxisTitle?: string
  valAxisTitle?: string
  legendPos?: 'none' | 'b' | 't' | 'l' | 'r'
  gridlines?: boolean
  dataLabels?: boolean
  gapWidthPct?: number
  unit?: string
  categoryUnits?: string[]
}

export interface PresetContent {
  title: string
  summary?: string
  takeaway?: string
  items?: string[]
  nodes?: string[]
  chart?: PresetChartContent
  image?: { dataUrl: string; width?: number; height?: number; fit?: 'contain' }
  images?: Array<{ dataUrl: string; width?: number; height?: number; fit?: 'contain' }>
  facts?: Array<{ id: string; text: string; required?: boolean }>
  role?: string
  relation?: PresetRelation
  axes?: { x: string; y: string }
  theme?: PresetThemeId
  accentColor?: string
}

type PresetElement =
  | AdditionalLayoutElement
  /** 面板/色块。参考主题的 cardTreatment 用 1–1.5px 细边描出卡片，因此 rect 支持可选描边。 */
  | {
    role: string; kind: 'rect'; box: PresetBox; fill: PresetColorRole
    stroke?: PresetColorRole; strokeWidthPt?: number
  }
  | {
    role: string; kind: 'text'; box: PresetBox; bind: PresetTextBind | `items[${number}]` | `nodes[${number}]`
    size: PresetSizeRole; color: PresetColorRole; bold?: boolean; align?: PresetAlign; fontSize?: number
  }
  | { role: string; kind: 'chart'; box: PresetBox }
  | { role: string; kind: 'image'; box: PresetBox }
  /**
   * SmartArt 只能写入结构与节点文案：引擎的 addSmartArt 不接受填充色，
   * 生成的是带 Office 默认配色的可编辑形状组。主题色暂不可控，不要在这里声明 fill。
   */
  | { role: string; kind: 'smartart'; box: PresetBox; layout: SmartArtLayout }
  | { role: string; kind: 'diagram'; box: PresetBox; layout: 'process' | 'hierarchy' | 'vertical' }
  | { role: string; kind: 'icon'; box: PresetBox; icon: 'target' | 'layers' | 'workflow' | 'check'; color: PresetColorRole }

export interface PresetCapacity {
  titleCharsMax: number
  summaryCharsMax: number
  takeawayCharsMax: number
  itemsMax: number
  itemsMin?: number
  /** 单条 items 文案上限；由实际字号、可用宽度和行数测得，不是按字符数估算。 */
  itemCharsMax: number
  nodesMax: number
  nodesMin?: number
  /** 单个 SmartArt 节点文案上限；0 表示该页面没有节点槽位。 */
  nodeCharsMax: number
  seriesMax: number
  categoriesMax: number
  imageRequired: boolean
  imagesMin?: number
  imagesMax?: number
}

export interface PresetDefinition {
  schemaVersion: typeof PRESET_SCHEMA_VERSION
  id: string
  family: string
  roles?: string[]
  relation?: PresetRelation
  composition?: string
  theme: PresetThemeId
  capacity: PresetCapacity
  elements: PresetElement[]
}

export interface PresetInput {
  slideId: string
  presetId: string
  content: PresetContent
  /** 页面像素 → EMU 的比例，用于 SmartArt 这类只有 EMU 入口的高级操作。 */
  scale?: { x: number; y: number }
  page?: { width: number; height: number }
}

export interface PresetOperation { op: string; payload: Record<string, unknown> }

export interface ExpandedPreset {
  presetId: string
  theme: PresetThemeId
  /** 与实际创建顺序一致的角色列表；createdElements 的第 i 项对应 roles[i]。 */
  roles: string[]
  operations: PresetOperation[]
  /** 需要在创建后按稳定 ID 应用的图表样式（系列色与文字色）。 */
  pendingChartStyles: Array<{ role: string; style: Record<string, unknown> }>
}

// Geometry and theme definitions have a single, data-only source.
export const PRESET_THEMES = catalog.themes as Record<PresetThemeId, PresetTheme>
export const PRESET_ROLES = roleCatalog
export const PRESETS: PresetDefinition[] = [
  ...catalog.presets.map((preset) => ({ ...preset, ...((legacySemantics as Record<string, object>)[preset.id] ?? {}) })),
  ...extended.presets,
] as PresetDefinition[]

const ICONS = { target: targetIcon, layers: layersIcon, workflow: workflowIcon, check: checkIcon }

export function resolvePresetTheme(content: PresetContent, fallback: PresetThemeId = 'light-editorial'): PresetTheme {
  const base = PRESET_THEMES[content.theme ?? fallback]
  if (!base) throw new Error('theme 必须是 light-editorial 或 dark-product。')
  if (content.accentColor === undefined) return base
  if (!/^#[0-9a-f]{6}$/i.test(content.accentColor)) throw new Error('accentColor 必须是 #RRGGBB 颜色。')
  return {...base,accent:content.accentColor,chart:{...base.chart,seriesColors:[content.accentColor,...base.chart.seriesColors.slice(1)]}}
}

/** Capacity and declared relationships are hard constraints; roles and rhythm are preferences. */
export function rankPresets(input: PresetContent, options: {
  family?: string; theme?: string; role?: string; relation?: PresetRelation; usedPresetIds?: string[]; limit?: number
} = {}): Array<{ preset: PresetDefinition; score: number; reasons: string[] }> {
  const content = preparePresetContent(input)
  resolvePresetTheme(content)
  const theme = options.theme ?? content.theme
  const role = options.role ?? content.role
  const relation = options.relation ?? content.relation
  if (content.nodes?.length && !relation) return []
  const history = (options.usedPresetIds ?? []).map((id) => findPreset(id)).filter((item): item is PresetDefinition => !!item)
  return PRESETS.filter((preset) => (!options.family || preset.family === options.family)
    && (!theme || preset.theme === theme) && (!relation || preset.relation === relation)
    && presetWarnings(preset, content).length === 0)
    .map((preset) => {
      const reasons = ['容量与必需对象匹配']
      let score = 100
      if (role && preset.roles?.includes(role)) { score += 40; reasons.push('页面用途匹配') }
      if (content.items?.length) score += Math.round(20 * content.items.length / Math.max(1, preset.capacity.itemsMax))
      if (content.nodes?.length) score += Math.round(15 * content.nodes.length / Math.max(1, preset.capacity.nodesMax))
      if (content.images?.length) score += Math.round(15 * content.images.length / Math.max(1, preset.capacity.imagesMax ?? 1))
      score -= Math.min(12, history.filter((item) => item.id === preset.id).length * 4)
      const previous = history.at(-1)
      if (previous?.composition && previous.composition === preset.composition) score -= 6
      else if (history.length) reasons.push('与前页构图有变化')
      return { preset, score, reasons }
    })
    .sort((a, b) => b.score - a.score || a.preset.id.localeCompare(b.preset.id))
    .slice(0, Math.max(1, Math.min(5, options.limit ?? 3)))
}

export function presetDiagnostics(content: PresetContent, family?: string, theme?: string): Array<{id:string;reasons:string[]}> {
  if (content.nodes?.length && !content.relation) return [{ id: 'content', reasons: ['节点选版需要声明真实 relation（如 parallel、sequence）；也可直接使用原生操作自由构图。'] }]
  return PRESETS.filter((preset) => (!family || preset.family === family) && (!theme || preset.theme === theme))
    .map((preset) => ({id:preset.id,reasons:presetWarnings(preset,content)}))
    .filter((entry) => entry.reasons.length).sort((a,b) => a.reasons.length-b.reasons.length).slice(0,3)
}

export function selectPresets(content: PresetContent, family?: string, theme?: string): PresetDefinition[] {
  return rankPresets(content, {family, theme}).map((entry) => entry.preset)
}

export function findPreset(presetId: string): PresetDefinition | undefined {
  return PRESETS.find((preset) => preset.id === presetId)
}

/** 能力目录：模型只需要看到简短索引，不加载整个页面库。 */
export function presetCatalog(): Array<{
  id: string
  family: string
  theme: PresetThemeId
  relation?: PresetRelation
  roles?: string[]
  capacity: PresetCapacity
}> {
  return PRESETS.map(({ id, family, theme, relation, roles, capacity }) => ({
    id, family, theme, relation, roles, capacity,
  }))
}

function fail(message: string): never {
  throw new Error(`预设 ${message}`)
}

function textLength(value: string): number {
  return [...value].length
}

function needs(presetId: string, slot: string): never {
  return fail(`${presetId} 缺少必需内容：${slot}。`)
}

export function presetWarnings(preset: PresetDefinition, content: PresetContent): string[] {
  const capacity = preset.capacity
  const warnings: string[] = []
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ['content 必须是对象']
  try { content = preparePresetContent(content) } catch (error) { return [error instanceof Error ? error.message : '内容无效'] }
  const allowed = ['title', 'summary', 'takeaway', 'items', 'nodes', 'chart', 'image', 'images', 'facts', 'role', 'relation', 'axes', 'theme', 'accentColor']
  try { resolvePresetTheme(content) } catch (error) { return [String(error)] }
  for (const key of Object.keys(content)) if (!allowed.includes(key)) warnings.push(`不支持内容字段：${key}`)
  for (const key of ['title', 'summary', 'takeaway'] as const) {
    if (content[key] !== undefined && typeof content[key] !== 'string') warnings.push(`${key} 必须是文本`)
  }
  for (const key of ['items', 'nodes'] as const) {
    if (content[key] !== undefined && (!Array.isArray(content[key]) || content[key]!.some((item) => typeof item !== 'string' || !item.trim()))) warnings.push(`${key} 必须是非空文本数组`)
  }
  if (content.chart && (typeof content.chart !== 'object' || !Array.isArray(content.chart.categories)
    || !Array.isArray(content.chart.series) || !content.chart.categories.length || !content.chart.series.length
    || content.chart.categories.some((item) => typeof item !== 'string')
    || content.chart.series.some((item) => !item || typeof item.name !== 'string' || !Array.isArray(item.values)))) warnings.push('chart 必须有合法的分类与系列数组')
  if (warnings.length) return warnings
  if (content.role !== undefined && typeof content.role !== 'string') warnings.push('role 必须是文本提示')
  const matrix = preset.elements.some((element) => element.kind === 'layout' && element.layout === 'matrix-2x2')
  if (matrix || content.axes !== undefined) {
    if (!matrix) warnings.push('axes 仅适用于矩阵页')
    if (!content.axes || typeof content.axes !== 'object'
      || Object.keys(content.axes).some((key) => !['x','y'].includes(key))
      || [content.axes.x,content.axes.y].some((value) => typeof value !== 'string' || !value.trim() || textLength(value) > 6)) warnings.push('矩阵 axes.x / axes.y 必须明确声明，每个维度 1–6 字')
  }
  if (content.relation && content.relation !== preset.relation) warnings.push(`本页关系是 ${content.relation}，预设只能表达 ${preset.relation}，请选择合适的布局。`)
  const flexible = preset.elements.some((element) => element.kind === 'layout')
  for (const element of preset.elements) {
    if (element.kind !== 'layout') continue
    if (['parallel-columns','parallel-grid','timeline','matrix-2x2','comparison-split','process-steps','team-grid'].includes(element.layout)
      && (content.items?.length ?? 0) !== (content.nodes?.length ?? 0)) warnings.push('解释条数必须与节点数一致，不自动补造节点')
    if (element.layout === 'hierarchy-branch' && content.items?.length
      && content.items.length !== (content.nodes?.length ?? 0) - 1) warnings.push('层级页解释应逐项对应子节点')
    if (element.layout === 'chart-evidence' && content.nodes?.length
      && content.nodes.length !== (content.items?.length ?? 0)) warnings.push('证据标签必须与证据条数一致')
  }
  const check = (slot: string, value: string | undefined, max: number, required = false) => {
    if (value == null || value === '') {
      if (required) warnings.push(`缺少必填内容：${slot}`)
      return
    }
    const bound = flexible || preset.elements.some((element) => element.kind === 'text' && element.bind === slot)
    if (!bound) { warnings.push(`${slot} 在此预设没有可见落点`); return }
    const length = textLength(value)
    if (length > max) warnings.push(`${slot} 超过声明容量：${length}/${max} 字，请改写或改用更合适的变体`)
  }
  const titleRequired = flexible || preset.elements.some((element) => element.kind === 'text' && element.bind === 'title')
  check('title', content.title, capacity.titleCharsMax, titleRequired)
  check('summary', content.summary, capacity.summaryCharsMax)
  const prominentTakeaway = preset.elements.some((element) => element.kind === 'text' && element.bind === 'takeaway'
    && (element.fontSize ?? PRESET_THEMES[preset.theme].sizes[element.size]) >= 28)
  check('takeaway', content.takeaway, capacity.takeawayCharsMax, prominentTakeaway)

  const itemSlots = preset.elements.filter((element) => element.kind === 'text' && element.bind.startsWith('items['))
  for (const element of itemSlots) {
    if (element.kind !== 'text') continue
    const index = Number(/items\[(\d+)\]/.exec(element.bind)?.[1] ?? NaN)
    const value = content.items?.[index]
    if (value == null || value === '') {
      warnings.push(`缺少必填内容：items[${index}]`)
      continue
    }
    const length = textLength(value)
    if (length > capacity.itemCharsMax) {
      warnings.push(`items[${index}] 超过声明容量：${length}/${capacity.itemCharsMax} 字，请改写或拆页`)
    }
  }
  if (preset.elements.some((element) => element.kind === 'diagram' && element.layout === 'vertical')) {
    if ((content.items?.length ?? 0) !== (content.nodes?.length ?? 0)) warnings.push('纵向流程的解释条数必须与节点数一致')
    for (const [index, item] of (content.items ?? []).entries()) if (textLength(item) > capacity.itemCharsMax) warnings.push(`items[${index}] 超过声明容量`)
  }
  if ((content.nodes?.length ?? 0) < (capacity.nodesMin ?? 0)) warnings.push(`nodes 至少需要 ${capacity.nodesMin} 项`)
  if ((content.items?.length ?? 0) < (capacity.itemsMin ?? 0)) warnings.push(`items 至少需要 ${capacity.itemsMin} 项`)
  if (flexible) for (const [index, item] of (content.items ?? []).entries()) {
    if (textLength(item) > capacity.itemCharsMax) warnings.push(`items[${index}] 超过声明容量：${textLength(item)}/${capacity.itemCharsMax}`)
  }
  if ((content.items?.length ?? 0) > capacity.itemsMax) {
    warnings.push(`items 超过声明容量：${content.items!.length}/${capacity.itemsMax}`)
  }
  if ((content.nodes?.length ?? 0) > capacity.nodesMax) {
    warnings.push(`nodes 超过声明容量：${content.nodes!.length}/${capacity.nodesMax}`)
  }
  for (const [index, node] of (content.nodes ?? []).entries()) {
    const length = textLength(node)
    if (length > capacity.nodeCharsMax) {
      warnings.push(`nodes[${index}] 超过声明容量：${length}/${capacity.nodeCharsMax} 字，请改写为短标签`)
    }
  }
  if (content.chart) {
    const keys = ['kind','categories','series','catAxisTitle','valAxisTitle','legendPos','gridlines','dataLabels','gapWidthPct','unit','categoryUnits']
    for (const key of Object.keys(content.chart)) if (!keys.includes(key)) warnings.push(`不支持 chart 字段：${key}`)
    if (!['bar','line','area','pie','doughnut'].includes(content.chart.kind)) warnings.push('不支持的 chart.kind')
    if (content.chart.unit !== undefined && (typeof content.chart.unit !== 'string' || !content.chart.unit.trim())) warnings.push('chart.unit 必须是明确的单位')
    if (content.chart.categoryUnits !== undefined) {
      const units = content.chart.categoryUnits
      if (!Array.isArray(units) || units.length !== content.chart.categories.length || units.some((unit) => typeof unit !== 'string' || !unit.trim())) warnings.push('categoryUnits 必须逐项对应分类单位')
      else if (new Set(units.map((unit) => unit.trim())).size > 1) warnings.push('同一图表的分类单位不一致，请拆成独立图表或先明确归一化口径。')
      else if (content.chart.unit && units.some((unit) => unit !== content.chart!.unit)) warnings.push('categoryUnits 与 chart.unit 不一致')
    }
    if (content.chart.categories.some((item) => textLength(item) > 12)) warnings.push('图表分类标签最多 12 字，请使用简称并在解读区说明')
    if (content.chart.series.length > capacity.seriesMax) {
      warnings.push(`series 超过声明容量：${content.chart.series.length}/${capacity.seriesMax}`)
    }
    if (content.chart.categories.length > capacity.categoriesMax) {
      warnings.push(`categories 超过声明容量：${content.chart.categories.length}/${capacity.categoriesMax}`)
    }
    const mismatched = content.chart.series.findIndex((series) => series.values.length !== content.chart!.categories.length)
    if (mismatched >= 0) warnings.push(`series[${mismatched}] 数值数量与 categories 不一致`)
    if (content.chart.series.some((series) => series.values.some((value) => !Number.isFinite(value)))) warnings.push('图表数值必须是有限数字')
  }
  if (content.image) {
    for (const key of Object.keys(content.image)) if (!['dataUrl','width','height','fit'].includes(key)) warnings.push(`不支持 image 字段：${key}`)
    if (content.image.fit && content.image.fit !== 'contain') warnings.push('图片仅支持保留完整画面的 contain 模式')
    if ((content.image.width !== undefined || content.image.height !== undefined) && (!Number.isFinite(content.image.width) || !Number.isFinite(content.image.height) || content.image.width! <= 0 || content.image.height! <= 0)) warnings.push('图片 width/height 必须同时为正数')
    if (!preset.elements.some((element) => element.kind === 'image') && !capacity.imageRequired) warnings.push('此预设没有图片槽位，请改选图片页')
  }
  if (content.images !== undefined) {
    if (!Array.isArray(content.images) || content.images.some((image) => !image || typeof image.dataUrl !== 'string')) warnings.push('images 必须是合法图片数组')
    else if (content.images.length > (capacity.imagesMax ?? 0)) warnings.push('图片数超过声明容量，请选择多图页或拆页')
    else for (const image of content.images) {
      if (Object.keys(image).some((key) => !['dataUrl','width','height','fit'].includes(key))) warnings.push('images 包含不支持的图片字段')
      if (image.fit && image.fit !== 'contain') warnings.push('图片仅支持 contain 模式')
      if ((image.width !== undefined || image.height !== undefined)
        && (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width! <= 0 || image.height! <= 0)) warnings.push('图片 width/height 必须同时为正数')
    }
  }
  if ((content.images?.length ?? 0) < (capacity.imagesMin ?? 0)) warnings.push(`此页至少需要 ${capacity.imagesMin} 张真实图片`)
  if (capacity.imageRequired && !content.image?.dataUrl) warnings.push('缺少必填内容：image')

  const requiredObjects = preset.elements.filter((element) => element.kind === 'chart' || element.kind === 'image' || element.kind === 'smartart' || element.kind === 'diagram')
  for (const element of requiredObjects) {
    if (element.kind === 'chart' && !content.chart) warnings.push('缺少必填内容：chart')
    if (element.kind === 'image' && !content.image?.dataUrl) warnings.push('缺少必填内容：image')
    if ((element.kind === 'smartart' || element.kind === 'diagram') && !content.nodes?.length) warnings.push('缺少必填内容：nodes')
  }
  const visible = [content.title, content.summary, content.takeaway, ...(content.items ?? []), ...(content.nodes ?? [])].filter(Boolean).join('\n')
  const missing = missingRequiredFacts(content, visible)
  if (missing.length) warnings.push(`缺少必含事实：${missing.join(', ')}；请换版式或恢复原文，不要删减证据。`)
  if (flexible && !warnings.length) {
    try {
      const rendered = preset.elements.flatMap((element) => element.kind === 'layout'
        ? expandAdditionalLayout(element, content, PRESET_THEMES[preset.theme], 'capacity-check', 1) : [])
      const text = rendered.map((item) => String(item.payload.text ?? '')).join('\n')
      for (const value of [...(content.items ?? []), ...(content.nodes ?? [])]) {
        if (!text.includes(value)) warnings.push(`内容没有可见落点：${value}；请换布局。`)
      }
    } catch (error) { warnings.push(error instanceof Error ? error.message : '布局内容不匹配') }
  }
  return warnings
}

/** 展开预设为现有 Office 原生操作；容量或内容不满足时在产生任何操作之前失败。 */
export function expandPreset(input: PresetInput): ExpandedPreset {
  if (input.presetId === 'auto' || input.presetId === 'auto-content') {
    const content = preparePresetContent(input.content)
    if (content.nodes?.length && !content.relation) fail('请声明节点的真实 relation（如 parallel、sequence 或 hierarchy），不按数量猜关系。')
    const theme = resolvePresetTheme(content)
    const candidate = input.presetId === 'auto' ? rankPresets(content,{theme:theme.id,limit:1})[0]?.preset : undefined
    if (candidate) return expandPreset({...input,presetId:candidate.id,content})
    if (input.presetId === 'auto') {
      const reasons = presetDiagnostics(content, undefined, theme.id).slice(0, 3)
        .map((entry) => `${entry.id}: ${entry.reasons.join('；')}`).join('\n')
      fail(`没有适配本页的预设。预设不是必需步骤；保留内容，使用 slide_compose 或原生文字、图表、形状自行构图。不要反复改写内容以套模板。${reasons ? `\n${reasons}` : ''}`)
    }
    const expanded = expandContentPage({...input,content},theme)
    const missing = missingRequiredFacts(content,expanded.operations.map((operation)=>String(operation.payload.text ?? '')).join('\n'))
    if (missing.length) fail(`必含事实没有可见落点：${missing.join(', ')}；请将这些事实安排到独立页面。`)
    return expanded
  }
  const preset = findPreset(input.presetId)
  if (!preset) fail(`不存在：${input.presetId}。可用：${PRESETS.map((item) => item.id).join(', ')}。`)
  const content = preparePresetContent(input.content)
  if (!content || typeof content !== 'object') fail(`${preset.id} 需要 content 对象。`)
  const problems = presetWarnings(preset, content)
  if (problems.length) fail(`${preset.id} 内容不符：${problems.join('；')}。`)
  if (content.chart && content.chart.series.some((series) => series.values.some((value) => !Number.isFinite(value)))) {
    fail(`${preset.id} 的图表数值必须是有限数字。`)
  }

  const theme = resolvePresetTheme(content, preset.theme)
  const scale = input.scale
  const operations: PresetOperation[] = []
  const roles: string[] = []
  const pendingChartStyles: ExpandedPreset['pendingChartStyles'] = []
  if (input.page && Math.abs(input.page.width / input.page.height - 16 / 9) > 0.02) fail('当前预设仅适用于 16:9 页面，请使用原生排版处理当前比例。')
  const k = (input.page?.width ?? 1280) / 1280
  const add = (role: string, op: string, payload: Record<string, unknown>) => {
    roles.push(role)
    operations.push({ op, payload: { slideId: input.slideId, ...payload } })
  }

  for (const element of preset.elements) {
    const { x, y, width, height } = element.box
    const box = { x: x*k, y: y*k, width: width*k, height: height*k }
    if (element.kind === 'layout') {
      for (const item of expandAdditionalLayout(element, content, theme, input.slideId, k)) {
        roles.push(item.role)
        operations.push({op:item.op,payload:item.payload})
      }
      continue
    }
    if (element.kind === 'diagram') {
      const nodes = content.nodes!, n = nodes.length
      const label = (role: string, text: string, bx: PresetBox, accent = false, fontSize = 17) => add(role, 'slide_add_text', { ...bx, text,
        font: { fontFamily: theme.fontFamily, fontSize, color: accent ? theme.accent : theme.text, bold: accent } })
      const panel = (role: string, bx: PresetBox) => add(role, 'slide_add_shape', { ...bx, shape: 'rect', fillColor: theme.surface, strokeColor: theme.line, strokeWidthPt: 1 })
      const line = (role: string, bx: PresetBox) => add(role, 'slide_add_shape', { ...bx, shape: 'rect', fillColor: theme.accent })
      if (element.layout === 'vertical') {
        const row = box.height / n
        nodes.forEach((node, i) => {
          const yy = box.y + i * row
          label(`${element.role}-number-${i}`, `${i+1}`.padStart(2,'0'), { x:box.x,y:yy,width:100*k,height:64*k },true,28)
          label(`${element.role}-node-${i}`, node, { x:box.x+116*k,y:yy,width:270*k,height:60*k },false,20)
          label(`${element.role}-detail-${i}`, content.items![i]!, { x:box.x+405*k,y:yy,width:box.width-405*k,height:row-8*k },false,16)
          if (i<n-1) line(`${element.role}-line-${i}`,{x:box.x+116*k,y:yy+row-10*k,width:box.width-116*k,height:k})
        })
      } else if (element.layout === 'hierarchy') {
        const root = {x:box.x+box.width/2-155*k,y:box.y,width:310*k,height:74*k}
        panel(`${element.role}-root`,root);label(`${element.role}-label-0`,nodes[0]!,{...root,x:root.x+20*k,y:root.y+15*k,width:root.width-40*k,height:52*k},true,20)
        line(`${element.role}-trunk`,{x:box.x+box.width/2,y:box.y+74*k,width:2*k,height:50*k})
        const w = box.width/(n-1), mid=box.y+124*k
        line(`${element.role}-bar`,{x:box.x+w/2,y:mid,width:box.width-w,height:2*k})
        nodes.slice(1).forEach((node,i)=>{
          const cx=box.x+w*(i+0.5),bx={x:box.x+w*i+10*k,y:box.y+177*k,width:w-20*k,height:83*k}
          line(`${element.role}-branch-${i}`,{x:cx,y:mid,width:2*k,height:53*k})
          panel(`${element.role}-child-${i}`,bx);label(`${element.role}-label-${i+1}`,node,{...bx,x:bx.x+15*k,y:bx.y+18*k,width:bx.width-30*k,height:58*k})
        })
      } else {
        const gap=48*k,w=(box.width-gap*(n-1))/n,yy=box.y+box.height/2-54*k
        nodes.forEach((node,i)=>{
          const xx=box.x+(w+gap)*i
          label(`${element.role}-number-${i}`,`${i+1}`.padStart(2,'0'),{x:xx,y:yy-56*k,width:w,height:50*k},true,24)
          panel(`${element.role}-panel-${i}`,{x:xx,y:yy,width:w,height:104*k})
          label(`${element.role}-label-${i}`,node,{x:xx+16*k,y:yy+30*k,width:w-32*k,height:65*k},false,20)
          if(i<n-1)add(`${element.role}-arrow-${i}`,'slide_add_shape',{x:xx+w+12*k,y:yy+42*k,width:24*k,height:18*k,shape:'rightArrow',fillColor:theme.accent})
        })
      }
      continue
    }
    roles.push(element.role)
    if (element.kind === 'rect') {
      operations.push({
        op: 'slide_add_shape',
        payload: {
          slideId: input.slideId, ...box, shape: 'rect', fillColor: theme[element.fill],
          ...(element.stroke ? {
            strokeColor: theme[element.stroke],
            strokeWidthPt: element.strokeWidthPt ?? 1,
          } : {}),
        },
      })
      continue
    }
    if (element.kind === 'text') {
      const text = element.bind === 'title' ? content.title
        : element.bind === 'summary' ? content.summary
          : element.bind === 'takeaway' ? content.takeaway
            : element.bind.startsWith('nodes[') ? content.nodes?.[Number(/\[(\d+)\]/.exec(element.bind)?.[1])]
              : content.items?.[Number(/items\[(\d+)\]/.exec(element.bind)?.[1] ?? 0)]
      operations.push({
        op: 'slide_add_text',
        payload: {
          slideId: input.slideId, ...box,
          text: text == null ? '' : String(text),
          font: {
            fontFamily: theme.fontFamily,
            fontSize: element.fontSize ?? theme.sizes[element.size],
            color: theme[element.color],
            ...(element.bold ? { bold: true } : {}),
          },
          ...(element.align ? { align: element.align } : {}),
        },
      })
      continue
    }
    if (element.kind === 'chart') {
      const chart = content.chart
      if (!chart) needs(preset.id, 'chart')
      operations.push({
        op: 'slide_add_chart',
        payload: {
          slideId: input.slideId, ...box,
          kind: chart.kind, categories: chart.categories, series: chart.series,
          ...(chart.legendPos ? { legendPos: chart.legendPos } : {}),
          ...(chart.gridlines !== undefined ? { gridlines: chart.gridlines } : {}),
          ...(chart.dataLabels !== undefined ? { dataLabels: chart.dataLabels } : {}),
          ...(chart.catAxisTitle ? { catAxisTitle: chart.catAxisTitle } : {}),
          ...(chart.valAxisTitle || chart.unit ? { valAxisTitle: chart.valAxisTitle ?? chart.unit } : {}),
          ...(chart.gapWidthPct !== undefined ? { gapWidthPct: chart.gapWidthPct } : {}),
        },
      })
      // 创建阶段写不了系列色：声明为待应用样式，由调用方拿到稳定 ID 后应用。
      pendingChartStyles.push({
        role: element.role,
        style: {
          textColor: theme.chart.textColor,
          axisLabelColor: theme.chart.axisLabelColor,
          legendColor: theme.chart.legendColor,
          dataLabelColor: theme.chart.dataLabelColor,
          seriesColors: theme.chart.seriesColors.slice(0, chart.series.length),
          gridColor: theme.chart.gridColor ?? theme.line,
          axisLineColor: theme.chart.axisLineColor ?? theme.line,
          axisLabelFontSize: theme.chart.axisLabelFontSize ?? 12,
        },
      })
      continue
    }
    if (element.kind === 'image') {
      const dataUrl = content.image?.dataUrl
      if (!dataUrl) needs(preset.id, 'image')
      if (content.image?.width && content.image?.height) {
        const ratio = Math.min(box.width/content.image.width,box.height/content.image.height)
        const w = content.image.width*ratio, h = content.image.height*ratio
        box.x += (box.width-w)/2; box.y += (box.height-h)/2; box.width=w; box.height=h
      }
      operations.push({ op: 'slide_add_image', payload: { slideId: input.slideId, ...box, dataUrl } })
      continue
    }
    if (element.kind === 'icon') {
      operations.push({op:'slide_add_svg',payload:{slideId:input.slideId,...box,svg:ICONS[element.icon].replaceAll('currentColor',theme[element.color])}})
      continue
    }
    if (element.kind === 'smartart') {
      const nodes = content.nodes
      if (!nodes?.length) needs(preset.id, 'nodes')
      if (!scale) fail(`${preset.id} 的 SmartArt 需要页面像素到 EMU 的比例（scale）。`)
      operations.push({
        op: 'slide_apply_txn',
        payload: {
          ops: [{
            op: 'addSmartArt',
            target: { slide: input.slideId },
            layout: element.layout,
            items: nodes,
            offset: {
              x: Math.round(x * scale.x), y: Math.round(y * scale.y),
              cx: Math.round(width * scale.x), cy: Math.round(height * scale.y),
            },
          }],
        },
      })
      continue
    }
  }

  const missing = missingRequiredFacts(content, operations.map((operation) => String(operation.payload.text ?? '')).join('\n'))
  if (missing.length) fail(`必含事实没有写入页面：${missing.join(', ')}。请换布局。`)
  if (operations.length > 50) fail('预设展开超过 50 个对象，请拆页。')
  return { presetId: preset.id, theme: theme.id, roles, operations, pendingChartStyles }
}
