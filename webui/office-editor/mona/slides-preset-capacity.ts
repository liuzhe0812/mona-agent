/**
 * 制作工具链：按预设声明的容量生成边界输入。
 *
 * 存在的理由：容量表如果只是估算，几何就会在真实排版时溢出。边界内容让
 * "声明容量真的放得下"变成可执行的检查，而不是靠人工比划。
 */
import { PRESETS, type PresetCapacity, type PresetContent, type PresetDefinition } from './slides-presets'

/** 接近真实中文正文的填充样本；只用于边界验证，不会进入交付内容。 */
const FILLER = '经营台账口径下结构化升级与毛利率变化来自高端线占比提升和低端线成本回落需按季度复核'

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function fill(length: number, offset = 0): string {
  const chars = [...FILLER]
  const out: string[] = []
  for (let index = 0; index < length; index += 1) out.push(chars[(offset + index) % chars.length]!)
  return out.join('')
}

export type PresetCapacitySlot =
  | 'title' | 'summary' | 'takeaway' | 'items' | 'nodes' | 'series' | 'categories' | 'images'

/** 该预设真正绑定、因而值得写容量测试的槽位。 */
export function presetCapacitySlots(preset: PresetDefinition): PresetCapacitySlot[] {
  const binds = preset.elements.flatMap((element) => (element.kind === 'text' ? [element.bind] : []))
  const slots: PresetCapacitySlot[] = ['title']
  if (binds.includes('summary')) slots.push('summary')
  if (binds.includes('takeaway')) slots.push('takeaway')
  if (binds.some((bind) => bind.startsWith('items[')) || preset.elements.some((element) => element.kind === 'diagram' && element.layout === 'vertical')) slots.push('items')
  if (binds.some((bind) => bind.startsWith('nodes[')) || preset.elements.some((element) => element.kind === 'smartart' || element.kind === 'diagram')) slots.push('nodes')
  if (preset.elements.some((element) => element.kind === 'chart')) slots.push('series', 'categories')
  if (preset.elements.some((element) => element.kind === 'layout')) {
    if (preset.capacity.takeawayCharsMax > 0 && !slots.includes('takeaway')) slots.push('takeaway')
    if (preset.capacity.itemsMax > 0 && !slots.includes('items')) slots.push('items')
    if (preset.capacity.nodesMax > 0 && !slots.includes('nodes')) slots.push('nodes')
    if (preset.capacity.imagesMax) slots.push('images')
  }
  return slots
}

function chartAt(preset: PresetDefinition, categories: number, series: number) {
  return {
    kind: 'bar' as const,
    categories: Array.from({ length: categories }, (_, index) => fill(4, index * 2)),
    series: Array.from({ length: series }, (_, index) => ({
      name: fill(4, index),
      values: Array.from({ length: categories }, (_, point) => 10 + point * 7 + index),
    })),
    legendPos: 'none' as const,
    gridlines: true,
    dataLabels: true,
  }
}

/** 边界内容：每个已绑定槽位都取到声明上限。 */
export function presetBoundaryContent(preset: PresetDefinition): PresetContent {
  const capacity = preset.capacity
  const slots = new Set(presetCapacitySlots(preset))
  return {
    title: fill(capacity.titleCharsMax),
    ...(preset.elements.some((element) => element.kind === 'layout' && element.layout === 'matrix-2x2') ? {axes:{x:'影响程度',y:'实施难度'}} : {}),
    ...(slots.has('summary') ? { summary: fill(capacity.summaryCharsMax, 7) } : {}),
    ...(slots.has('takeaway') ? { takeaway: fill(capacity.takeawayCharsMax, 13) } : {}),
    ...(slots.has('items') ? {
      items: Array.from({ length: capacity.itemsMax }, (_, index) => fill(capacity.itemCharsMax, index * 5)),
    } : {}),
    ...(slots.has('nodes') ? {
      nodes: Array.from({ length: capacity.nodesMax }, (_, index) => fill(capacity.nodeCharsMax, index * 3)),
    } : {}),
    ...(capacity.imageRequired ? { image: { dataUrl: TINY_PNG } } : {}),
    ...(slots.has('images') ? {images:Array.from({length:capacity.imagesMax!},()=>({dataUrl:TINY_PNG}))} : {}),
    ...(slots.has('series') || slots.has('categories')
      ? { chart: chartAt(preset, capacity.categoriesMax, Math.max(1, capacity.seriesMax)) }
      : {}),
  }
}

export interface PresetCapacityRow {
  id: string
  family: string
  theme: string
  /** 该预设有内容槽位、因而执行了边界测试的维度。 */
  testedSlots: PresetCapacitySlot[]
  /** 人读的容量摘要，可直接作为制作记录。 */
  summary: string
  capacity: PresetCapacity
}

function summarizeCapacity(capacity: PresetCapacity): string {
  const parts = [
    `标题≤${capacity.titleCharsMax}`,
    `摘要≤${capacity.summaryCharsMax}`,
  ]
  if (capacity.takeawayCharsMax > 0) parts.push(`聚焦≤${capacity.takeawayCharsMax}`)
  if (capacity.itemsMax > 0) parts.push(`条目 ${capacity.itemsMax}×≤${capacity.itemCharsMax}`)
  if (capacity.nodesMax > 0) parts.push(`节点 ${capacity.nodesMax}×≤${capacity.nodeCharsMax}`)
  if (capacity.seriesMax > 0) parts.push(`系列≤${capacity.seriesMax}`, `分类≤${capacity.categoriesMax}`)
  if (capacity.imageRequired) parts.push('必须提供真实素材')
  return parts.join('、')
}

/**
 * 容量边界记录：变体清单驱动，不需要在测试里手工维护一份内容清单。
 * 每个条目都对应 slides-entry.test.ts 里"声明容量上限"用例的一次实测。
 */
export function presetCapacityTable(): PresetCapacityRow[] {
  return PRESETS.map((preset) => ({
    id: preset.id,
    family: preset.family,
    theme: preset.theme,
    testedSlots: presetCapacitySlots(preset),
    summary: summarizeCapacity(preset.capacity),
    capacity: preset.capacity,
  }))
}

/**
 * 只把一个槽位推到上限之外，其余保持边界值；用来确认超容量会被明确拒绝，
 * 而不是静默截断或写坏半页。
 */
export function presetOverflowContent(
  preset: PresetDefinition,
  slot: PresetCapacitySlot,
): PresetContent {
  const capacity = preset.capacity
  const content = presetBoundaryContent(preset)
  if (slot === 'title') return { ...content, title: fill(capacity.titleCharsMax + 1) }
  if (slot === 'summary') return { ...content, summary: fill(capacity.summaryCharsMax + 1) }
  if (slot === 'takeaway') return { ...content, takeaway: fill(capacity.takeawayCharsMax + 1) }
  if (slot === 'items') {
    const items = [...(content.items ?? [])]
    items[0] = fill(capacity.itemCharsMax + 1)
    return { ...content, items }
  }
  if (slot === 'nodes') {
    const nodes = [...(content.nodes ?? [])]
    nodes[0] = fill(capacity.nodeCharsMax + 1)
    return { ...content, nodes }
  }
  if (slot === 'series') {
    return { ...content, chart: chartAt(preset, capacity.categoriesMax, capacity.seriesMax + 1) }
  }
  if (slot === 'images') return {...content, images:Array.from({length:capacity.imagesMax!+1},()=>({dataUrl:TINY_PNG}))}
  return { ...content, chart: chartAt(preset, capacity.categoriesMax + 1, Math.max(1, capacity.seriesMax)) }
}
