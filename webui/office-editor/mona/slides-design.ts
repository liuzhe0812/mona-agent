import type { Paragraph, TextRun } from '@genoffice/pptx-engine'
import { makeViewport, type Viewport } from '@genoffice/pptx-render'
import type { SlidesDocument } from './slides-engine'
import { fitNativeText, measureNativeText } from './slides-typography'
import type { NativePathCommand } from '../vendor/genoffice/packages/pptx-engine/src/custom-path'

type Data = Record<string, unknown>
export type DesignOperation = { op: string; payload: Data }
type Rect = { x: number; y: number; width: number; height: number }
type Palette = { background: string; ink: string; muted: string; accent: string; surface: string; line: string; positive: string; negative: string }
type Item = { label: string; detail?: string; value?: string | number; unit?: string }
const DEFAULT_PALETTE: Palette = { background: '#F4F3ED', ink: '#172621', muted: '#626D66', accent: '#516B30', surface: '#E8ECDE', line: '#CCD1C5', positive: '#438D68', negative: '#BA4C3C' }
const ZERO_INSETS = { l: 0, t: 0, r: 0, b: 0 }

export const DESIGN_CATALOG = [
  { id: 'statement', label: '观点 / 开场', use: '大结论、可选强调短语及支撑事实；不加无意义的标题条。' },
  { id: 'metric', label: '主指标', use: '一个大数字与小单位、解释区、可选辅助指标。' },
  { id: 'evidence', label: '证据与解读', use: '原生图表占主区，旁边解读与可选重点数值。' },
  { id: 'waterfall', label: '变化瀑布', use: '起点、正负变化、累计终点；原生可编辑信息图形，不冒充数据图表。' },
  { id: 'sankey', label: '流向', use: '双侧节点与带权 links；可编辑原生曲线路径与标签。只接受非负流量。' },
  { id: 'agenda', label: '信息地图', use: '编号、层次明确的目录或并列模块；数量和列数可调。' },
  { id: 'comparison', label: '对照分析', use: '两组并列内容，各自标签、说明与数据；不是默认彩色卡片。' },
  { id: 'roadmap', label: '行动路线', use: '有真实时间或先后关系的行动节点，保留独立标签和解释。' },
  { id: 'matrix', label: '四象限', use: '四组内容与明确的 x/y 维度；重点区域可强调。' },
  { id: 'image', label: '主图与解读', use: '实际图片保留比例，标题、说明、来源仍是原生文字。' },
  { id: 'items', label: '编辑式列表', use: '短标签与解释按行对齐；适用于原型未覆盖的并列内容，不丢条目。' },
] as const

function record(value: unknown, label: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`)
  return value as Data
}
function keys(value: Data, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} 不支持字段 ${unknown.join(', ')}，没有忽略内容。可改用原生操作。`)
}
function str(value: unknown, label: string, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > 4000 || (required && !value.trim())) throw new Error(`${label} 需要${required ? '非空' : ''}文本（最多 4000 字符）。`)
  return value
}
function finite(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e15) throw new Error(`${label} 必须是绝对值不超过 1e15 的有限数值。`)
  return value
}
function list(value: unknown, label: string, min = 0, max = 12): unknown[] {
  if (value === undefined && min === 0) return []
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} 需要 ${min}–${max} 项。超出单页时可以分区或原生构图，内容未被截断。`)
  return value
}
function items(value: unknown, label = 'items', min = 0, max = 8): Item[] {
  return list(value, label, min, max).map((entry, index) => {
    const item = typeof entry === 'string' ? { label: entry } : record(entry, `${label}[${index}]`)
    keys(item, ['label', 'detail', 'value', 'unit'], label)
    const result: Item = { label: str(item.label, `${label}[${index}].label`, true) }
    if (item.detail !== undefined) result.detail = str(item.detail, 'detail')
    if (item.value !== undefined) result.value = typeof item.value === 'number' ? finite(item.value, 'value') : str(item.value, 'value', true)
    if (item.unit !== undefined) result.unit = str(item.unit, 'unit')
    if (result.unit && result.value === undefined) throw new Error('unit 必须与 value 一起提供。')
    return result
  })
}
function palette(input: unknown): Palette {
  if (input === undefined) return { ...DEFAULT_PALETTE }
  const p = record(input, 'palette')
  keys(p, Object.keys(DEFAULT_PALETTE), 'palette')
  for (const value of Object.values(p)) if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('palette 颜色须为 #RRGGBB。')
  return { ...DEFAULT_PALETTE, ...p } as Palette
}
const format = (value: number | string) => typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 }).format(value) : value
const valueOf = (item: Item) => `${item.value === undefined ? '' : format(item.value)}${item.unit ?? ''}`

/** One drawing implementation for whole pages and user-chosen regions. No second renderer. */
class Designer {
  operations: DesignOperation[] = []
  readonly unit: number
  readonly vp: Viewport
  constructor(readonly slideId: string, readonly region: Rect, readonly colors: Palette, size: { cx: number; cy: number }, previewWidth = 1280, readonly partial = false) {
    this.unit = partial ? 1 : region.width / 1280
    this.vp = makeViewport(size, previewWidth)
  }
  box(x: number, y: number, width: number, height: number): Rect {
    if (this.partial) return { x: this.region.x + x, y: this.region.y + y, width, height }
    return { x: this.region.x + x * this.region.width / 1280, y: this.region.y + y * this.region.height / 720, width: width * this.region.width / 1280, height: height * this.region.height / 720 }
  }
  shape(x: number, y: number, width: number, height: number, fill: string, shape = 'rect', stroke?: string) {
    this.operations.push({ op: 'slide_add_shape', payload: { slideId: this.slideId, ...this.box(x, y, width, height), shape, fillColor: fill, ...(stroke ? { strokeColor: stroke, strokeWidthPt: 0.6 } : {}) } })
  }
  line(x: number, y: number, width: number, color = this.colors.line) { this.shape(x, y, width, 1.2, color) }
  path(box: Rect, path: NativePathCommand[], fill: string, stroke?: string) {
    this.operations.push({ op: 'slide_add_path', payload: { slideId: this.slideId, ...this.box(box.x, box.y, box.width, box.height), path, fillColor: fill, ...(stroke ? { strokeColor: stroke, strokeWidthPt: 0.8 } : {}) } })
  }
  text(value: string | TextRun[], x: number, y: number, width: number, height: number, px: number, color = this.colors.ink, bold = false, align: 'left' | 'center' | 'right' = 'left', minRatio = 0.8): number {
    const box = this.box(x, y, width, height)
    const scale = this.unit
    const pt = px * scale * 0.75 / this.vp.scale
    const runs: TextRun[] = (typeof value === 'string' ? [{ text: value }] : value).map((r) => ({ fontFamily: 'Microsoft YaHei', fontSize: pt, bold, color, ...r, ...(r.fontSize !== undefined ? { fontSize: r.fontSize * scale * 0.75 / this.vp.scale } : {}) }))
    const paragraphs: Paragraph[] = [{ runs, align, lineHeight: 110, spaceBefore: 0, spaceAfter: 0 }]
    const fitted = fitNativeText(paragraphs, box.width, box.height, this.vp, minRatio)
    const measured = measureNativeText(fitted, box.width, box.height, this.vp)
    this.operations.push({ op: 'slide_add_text', payload: { slideId: this.slideId, ...box, paragraphs: fitted, body: { insets: ZERO_INSETS, anchor: 'top', wrap: true } } })
    return this.partial ? measured.contentHeight : measured.contentHeight * 720 / this.region.height
  }
  metric(item: Item, rect: Rect, px: number) {
    const { x, y, width, height } = rect
    const valueHeight = Math.min(height * 0.58, px * 1.35)
    this.text(item.label, x, y, width, 30, 16, this.colors.muted)
    this.text([{ text: item.value === undefined ? '—' : format(item.value), color: this.colors.accent }, { text: item.unit ? ` ${item.unit}` : '', fontSize: Math.max(16, px * 0.23), color: this.colors.ink }], x, y + 36, width, valueHeight, px, this.colors.accent, true, 'left', 0.60)
    if (item.detail) this.text(item.detail, x, y + 42 + valueHeight, width, Math.max(32, height - valueHeight - 42), 18, this.colors.muted)
  }
  itemRows(entries: Item[], rect: Rect, focus: number) {
    const { x, y, width, height } = rect
    const rowHeight = height / entries.length
    entries.forEach((item, index) => {
      const top = y + index * rowHeight
      this.line(x, top, width)
      this.text(String(index + 1).padStart(2, '0'), x, top + 15, 52, rowHeight - 21, 20, this.colors.accent)
      const labelWidth = width * 0.29
      this.text(item.label, x + 72, top + 15, labelWidth, rowHeight - 22, 24, index === focus ? this.colors.accent : this.colors.ink, true)
      const description = [valueOf(item), item.detail].filter(Boolean).join('  ·  ')
      if (description) this.text(description, x + 92 + labelWidth, top + 16, width - labelWidth - 92, rowHeight - 23, 20, this.colors.muted)
    })
  }
}

const CONTENT_FIELDS: Record<string, string[]> = {
  statement: ['emphasis', 'items'], metric: ['metric', 'items'], evidence: ['chart', 'metric', 'items'],
  waterfall: ['steps', 'start', 'unit', 'totalLabel'], sankey: ['sources', 'targets', 'links', 'unit'],
  agenda: ['items', 'columns'], comparison: ['groups'], roadmap: ['items'], matrix: ['items', 'axes'], image: ['image', 'items'], items: ['items'],
}

/** Regions are actual components at readable sizes, not a miniature full-slide screenshot. */
function regionDesign(d: Designer, design: string, content: Data, focus: number): DesignOperation[] {
  const p = d.colors, width = d.region.width, height = d.region.height
  const allowed = ['metric', 'items', 'waterfall', 'sankey', 'evidence']
  if (!allowed.includes(design)) throw new Error(`${design} 是整页构图；局部区域可组合 ${allowed.join(' / ')} 或使用原生文字、形状与图表。`)
  d.shape(0, 0, width, height, p.background)
  let y = 16
  const title = str(content.title, 'title'), summary = str(content.summary, 'summary')
  const eyebrow = str(content.eyebrow, 'eyebrow'), source = str(content.source, 'source'), pageLabel = str(content.pageLabel, 'pageLabel')
  if (eyebrow || pageLabel) { d.text([eyebrow, pageLabel].filter(Boolean).join(' · '), 20, y, width - 40, 26, 12, p.muted); y += 30 }
  if (title) y += d.text(title, 20, y, width - 40, 78, 28, p.ink, true) + 14
  if (summary) y += d.text(summary, 20, y, width - 40, 70, 18, p.muted) + 16
  const bottom = source ? height - 44 : height - 16
  if (source) d.text(source, 20, height - 35, width - 40, 28, 11, p.muted)
  const body = { x: 20, y, width: width - 40, height: bottom - y }
  if (body.height < 100) throw new Error('区域标题和说明占用过多空间；请扩大区域或用原生对象组合，内容未被截断。')
  if (design === 'metric') {
    const main = items([content.metric], 'metric', 1, 1)[0]!
    if (main.value === undefined) throw new Error('metric.value 必填。')
    const support = items(content.items, 'items', 0, 3)
    const reserved = support.length * 62
    d.metric(main, { ...body, height: body.height - reserved }, Math.min(112, body.width * 0.30))
    if (support.length) d.itemRows(support, { ...body, y: bottom - reserved, height: reserved }, focus)
  } else if (design === 'items') {
    d.itemRows(items(content.items, 'items', 1, 8), body, focus)
  } else if (design === 'waterfall') {
    if (body.height < 200) throw new Error('瀑布区域正文至少需要 200px 高度，以保留数值与标签。')
    waterfall(d, content, body, focus)
  } else if (design === 'sankey') {
    if (body.width < 480 || body.height < 260) throw new Error('流向区域正文至少 480×260px；较小区域请用原生图形简化表达。')
    sankey(d, content, body, focus)
  } else {
    const chart = record(content.chart, 'chart')
    keys(chart, ['kind', 'categories', 'series', 'unit', 'title', 'style'], 'chart')
    const notes = items(content.items, 'items', 1, 4)
    const noteHeight = notes.length * 54
    const metric = content.metric === undefined ? undefined : items([content.metric], 'metric', 1, 1)[0]!
    const metricHeight = metric ? 160 : 0
    const chartHeight = body.height - noteHeight - metricHeight - 14
    if (chartHeight < 150) throw new Error('图表与解读在当前区域无法同时保持可读，请扩大区域或分别创建图表和文字。')
    d.operations.push({ op: 'slide_add_chart', payload: { slideId: d.slideId, ...d.box(body.x, y, body.width, chartHeight), kind: chart.kind, categories: chart.categories, series: chart.series, title: chart.title ?? '', valAxisTitle: str(chart.unit, 'chart.unit'), legendPos: Array.isArray(chart.series) && chart.series.length > 1 ? 'b' : 'none', gridlines: true, dataLabels: true, style: { textColor: p.ink, gridColor: p.line, seriesColors: [p.accent, p.muted, p.positive], ...(chart.style === undefined ? {} : record(chart.style, 'chart.style')) } } })
    if (metric) d.metric(metric, { ...body, y: y + chartHeight + 8, height: metricHeight }, 56)
    d.itemRows(notes, { ...body, y: bottom - noteHeight, height: noteHeight }, focus)
  }
  return d.operations
}

export function expandSlideDesign(payload: Data, document: SlidesDocument): DesignOperation[] {
  keys(payload, ['slideId', 'design', 'content', 'region', 'palette', 'focusIndex'], 'slide_add_design')
  const id = str(payload.slideId, 'slideId', true)
  const design = str(payload.design, 'design', true)
  if (!CONTENT_FIELDS[design]) throw new Error(`未知 design：${design}。可查询 capabilities 或直接使用原生操作。`)
  const content = record(payload.content, 'content')
  keys(content, ['title', 'summary', 'eyebrow', 'source', 'pageLabel', ...CONTENT_FIELDS[design]], 'content')
  const focus = finite(payload.focusIndex, 'focusIndex', 0)
  if (!Number.isInteger(focus) || focus < 0) throw new Error('focusIndex 必须是非负整数。')
  const first = document.slides[0]!
  const region = payload.region === undefined ? { x: 0, y: 0, width: first.widthPx, height: first.heightPx } : record(payload.region, 'region')
  keys(region, ['x', 'y', 'width', 'height'], 'region')
  const rect = { x: finite(region.x, 'x'), y: finite(region.y, 'y'), width: finite(region.width, 'width'), height: finite(region.height, 'height') }
  if (rect.x < 0 || rect.y < 0 || rect.width < 300 || rect.height < 180 || rect.x + rect.width > first.widthPx + 0.1 || rect.y + rect.height > first.heightPx + 0.1) throw new Error('设计区域须在当前画布内，至少 300×180 像素。小元素请使用原生操作。')
  if (payload.region !== undefined) return regionDesign(new Designer(id, rect, palette(payload.palette), document.opened.deck.size, first.widthPx, true), design, content, focus)
  const d = new Designer(id, rect, palette(payload.palette), document.opened.deck.size, first.widthPx)
  const p = d.colors
  const title = str(content.title, 'title', true)
  const summary = str(content.summary, 'summary')
  const eyebrow = str(content.eyebrow, 'eyebrow')
  const source = str(content.source, 'source')
  const pageLabel = str(content.pageLabel, 'pageLabel')
  d.shape(0, 0, 1280, 720, p.background)
  if (eyebrow) d.text(eyebrow, 64, 30, 1080, 25, 13, p.muted)
  if (pageLabel) d.text(pageLabel, 1154, 30, 62, 25, 13, p.muted, false, 'right')
  d.line(64, 658, 1152)
  if (source) d.text(source, 64, 673, 1120, 36, 11, p.muted)

  if (design === 'statement') {
    const emphasis = str(content.emphasis, 'emphasis')
    if (emphasis && !title.includes(emphasis)) throw new Error('emphasis 必须是标题中的真实连续文字。')
    const runs: TextRun[] = []
    if (emphasis) { const at = title.indexOf(emphasis); runs.push({ text: title.slice(0, at) }, { text: emphasis, color: p.accent }, { text: title.slice(at + emphasis.length) }) }
    const h = d.text(emphasis ? runs : title, 64, 136, 1096, 220, 66, p.ink, true)
    d.shape(64, 112, 54, 5, p.accent)
    if (summary) d.text(summary, 70, 164 + h, 1050, 94, 24, p.muted)
    const support = items(content.items, 'items', 0, 4)
    const w = 1152 / Math.max(1, support.length)
    support.forEach((item, i) => { const x = 64 + i * w; d.line(x, 502, w - 32, i === focus ? p.accent : p.line); d.text(item.label, x, 523, w - 32, 52, 23, p.ink, true); const body = [valueOf(item), item.detail].filter(Boolean).join(' · '); if (body) d.text(body, x, 579, w - 32, 60, 17, p.muted) })
    return d.operations
  }

  const titleHeight = d.text(title, 64, 72, 1152, 108, 43, p.ink, true, 'left', 0.84)
  let bodyY = 92 + titleHeight
  if (summary) bodyY += d.text(summary, 64, bodyY, 1152, 82, 21, p.muted) + 22
  else bodyY += 18
  const body: Rect = { x: 64, y: bodyY, width: 1152, height: 636 - bodyY }
  if (body.height < 260) throw new Error('标题与摘要占用过多正文空间，请使用等义简写或观点页；未删除内容。')

  if (design === 'metric') {
    const metric = items([content.metric], 'metric', 1, 1)[0]!
    if (metric.value === undefined) throw new Error('metric.value 必填。')
    const support = items(content.items, 'items', 0, 6)
    const mainHeight = support.length ? body.height * 0.66 : body.height
    d.metric({ ...metric, detail: undefined }, { x: body.x, y: body.y + 14, width: metric.detail ? 738 : 1110, height: mainHeight - 25 }, 164)
    if (metric.detail) { d.shape(858, body.y + 24, 2, mainHeight - 58, p.line); d.text(metric.detail, 894, body.y + 34, 300, mainHeight - 74, 26, p.ink) }
    const width = body.width / Math.max(1, support.length)
    support.forEach((item, i) => { const x = 64 + i * width; d.line(x, body.y + mainHeight, width - 24); d.metric(item, { x, y: body.y + mainHeight + 13, width: width - 24, height: body.height - mainHeight - 13 }, support.length > 4 ? 36 : 48) })
  } else if (design === 'evidence') {
    const chart = record(content.chart, 'chart')
    keys(chart, ['kind', 'categories', 'series', 'unit', 'title', 'style'], 'chart')
    const chartBox = d.box(64, bodyY + 14, 760, body.height - 26)
    const chartStyle = chart.style === undefined ? {} : record(chart.style, 'chart.style')
    const legend = Array.isArray(chart.series) && chart.series.length > 1 ? 'b' : 'none'
    d.operations.push({ op: 'slide_add_chart', payload: { slideId: id, ...chartBox, kind: chart.kind, categories: chart.categories, series: chart.series, title: chart.title ?? '', valAxisTitle: str(chart.unit, 'chart.unit'), legendPos: legend, gridlines: true, dataLabels: true, style: { textColor: p.ink, axisLabelColor: p.muted, gridColor: p.line, axisLineColor: p.line, seriesColors: [p.accent, p.muted, p.positive, p.negative], axisLabelFontSize: 11, ...chartStyle } } })
    d.shape(862, bodyY + 18, 1.5, body.height - 30, p.line)
    let y = bodyY + 12
    if (content.metric !== undefined) { const m = items([content.metric], 'metric', 1, 1)[0]!; d.metric(m, { x: 896, y, width: 310, height: 178 }, 68); y += 191 }
    const explanations = items(content.items, 'items', 1, 4)
    const height = (636 - y) / explanations.length
    explanations.forEach((item, index) => { const top = y + index * height; d.text(item.label, 898, top, 305, Math.min(58, height * 0.36), 22, index === focus ? p.accent : p.ink, true); const text = [valueOf(item), item.detail].filter(Boolean).join(' · '); if (text) d.text(text, 898, top + Math.min(62, height * 0.38), 305, height * 0.58, 18, p.muted) })
  } else if (design === 'waterfall') {
    waterfall(d, content, body, focus)
  } else if (design === 'sankey') {
    sankey(d, content, body, focus)
  } else if (design === 'items') {
    d.itemRows(items(content.items, 'items', 1, 8), body, focus)
  } else if (design === 'agenda') {
    const entries = items(content.items, 'items', 1, 12)
    const columns = finite(content.columns, 'columns', entries.length <= 4 ? 2 : entries.length <= 9 ? 3 : 4)
    if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw new Error('columns 支持 1–4 列。')
    const rows = Math.ceil(entries.length / columns), w = (1152 - (columns - 1) * 22) / columns, h = (body.height - (rows - 1) * 22) / rows
    entries.forEach((item, i) => { const x = 64 + i % columns * (w + 22), y = bodyY + Math.floor(i / columns) * (h + 22); if (i === focus) d.shape(x, y, w, h, p.ink); else d.line(x, y, w); const ink = i === focus ? p.background : p.ink, muted = i === focus ? p.surface : p.muted; d.text(String(i + 1).padStart(2, '0'), x + 20, y + 14, w - 40, 46, 34, i === focus ? p.surface : p.accent); d.text(item.label, x + 20, y + 73, w - 40, Math.max(42, h * 0.27), 26, ink, true); const extra = [valueOf(item), item.detail].filter(Boolean).join(' · '); if (extra) d.text(extra, x + 20, y + 82 + h * 0.27, w - 40, Math.max(34, h * 0.73 - 96), 18, muted) })
  } else if (design === 'comparison') {
    const groups = list(content.groups, 'groups', 2, 2).map((g) => { const r = record(g, 'group'); keys(r, ['label', 'detail', 'items'], 'group'); return { label: str(r.label, 'group.label', true), detail: str(r.detail, 'group.detail'), items: items(r.items, 'group.items', 1, 5) } })
    d.shape(638, bodyY, 1.5, body.height, p.line)
    groups.forEach((g, i) => { const x = i ? 684 : 64; d.text(g.label, x, bodyY, 510, 56, 31, i === focus ? p.accent : p.ink, true); let y = bodyY + 74; if (g.detail) y += d.text(g.detail, x, y, 510, 60, 20, p.muted) + 14; const row = (636 - y) / g.items.length; g.items.forEach((it, j) => { const top = y + j * row; d.line(x, top, 510); d.text(it.label, x, top + 12, 220, row - 16, 22, p.ink, true); const extra = [valueOf(it), it.detail].filter(Boolean).join(' · '); if (extra) d.text(extra, x + 244, top + 12, 266, row - 16, 19, p.muted) }) })
  } else if (design === 'roadmap') {
    const entries = items(content.items, 'items', 2, 6), w = 1152 / entries.length
    const axisY = bodyY + 88
    d.line(64 + w / 2, axisY, 1152 - w, p.line)
    entries.forEach((item, i) => { const x = 64 + i * w; d.text(String(i + 1).padStart(2, '0'), x + 8, bodyY + 12, w - 16, 52, 40, i === focus ? p.accent : p.muted); d.shape(x + w / 2 - 7, axisY - 6, 14, 14, i === focus ? p.accent : p.ink, 'ellipse'); d.text(item.label, x + 8, axisY + 33, w - 24, 78, 27, p.ink, true); const extra = [valueOf(item), item.detail].filter(Boolean).join('\n'); if (extra) d.text(extra, x + 8, axisY + 128, w - 24, body.height - 225, 20, p.muted) })
  } else if (design === 'matrix') {
    const entries = items(content.items, 'items', 4, 4), axes = record(content.axes, 'axes')
    keys(axes, ['x', 'y'], 'axes')
    const axisX = str(axes.x, 'axes.x', true), axisY = str(axes.y, 'axes.y', true)
    const h = (body.height - 36) / 2, w = 540
    d.text(axisY, 64, bodyY, 40, body.height - 40, 16, p.muted)
    entries.forEach((item, i) => { const x = 122 + i % 2 * 551, y = bodyY + Math.floor(i / 2) * h; d.shape(x, y, w, h - 10, i === focus ? p.surface : p.background, 'rect', p.line); d.text(item.label, x + 24, y + 18, w - 48, 45, 25, i === focus ? p.accent : p.ink, true); const extra = [valueOf(item), item.detail].filter(Boolean).join(' · '); if (extra) d.text(extra, x + 24, y + 76, w - 48, h - 96, 19, p.muted) })
    d.text(axisX, 122, 612, 1090, 25, 16, p.muted, false, 'center')
  } else if (design === 'image') {
    const image = record(content.image, 'image')
    keys(image, ['dataUrl', 'width', 'height', 'fit'], 'image')
    const ratio = finite(image.width, 'image.width') / finite(image.height, 'image.height')
    if (ratio <= 0 || !Number.isFinite(ratio)) throw new Error('图片实际宽高无效。')
    const w = Math.min(794, (body.height - 8) * ratio), h = w / ratio
    d.shape(64, bodyY, 810, body.height, p.surface)
    d.operations.push({ op: 'slide_add_image', payload: { slideId: id, ...d.box(72 + (794 - w) / 2, bodyY + (body.height - h) / 2, w, h), dataUrl: image.dataUrl } })
    const entries = items(content.items, 'items', 1, 4), row = body.height / entries.length
    entries.forEach((it, i) => { const y = bodyY + i * row; d.line(914, y, 294, i === focus ? p.accent : p.line); d.text(it.label, 914, y + 16, 294, row * 0.32, 25, p.ink, true); const extra = [valueOf(it), it.detail].filter(Boolean).join(' · '); if (extra) d.text(extra, 914, y + row * 0.38, 294, row * 0.58, 19, p.muted) })
  }
  if (d.operations.length > 220) throw new Error('设计组件展开超过单页 220 个对象，请分区创建。')
  return d.operations
}

function waterfall(d: Designer, content: Data, area: Rect, focus: number) {
  const p = d.colors, unit = str(content.unit, 'unit'), totalLabel = str(content.totalLabel ?? '合计', 'totalLabel')
  const steps = list(content.steps, 'steps', 1, 12).map((v) => { const step = record(v, 'step'); keys(step, ['label', 'value'], 'step'); return { label: str(step.label, 'step.label', true), value: finite(step.value, 'step.value') } })
  let start = 0
  let startLabel = ''
  if (content.start !== undefined) { const s = record(content.start, 'start'); keys(s, ['label', 'value'], 'start'); start = finite(s.value, 'start.value'); startLabel = str(s.label, 'start.label', true) }
  let cumulative = start
  const bars = steps.map((step) => { const from = cumulative; cumulative += step.value; finite(cumulative, '累计值'); return { ...step, from, to: cumulative, total: false } })
  if (startLabel) bars.unshift({ label: startLabel, value: start, from: 0, to: start, total: true })
  bars.push({ label: totalLabel, value: cumulative, from: 0, to: cumulative, total: true })
  const low = Math.min(0, ...bars.flatMap((b) => [b.from, b.to])), high = Math.max(0, ...bars.flatMap((b) => [b.from, b.to])), span = high - low || 1
  const chartY = area.y + 64, chartH = area.height - 136, baseline = chartY + high / span * chartH
  const y = (v: number) => chartY + (high - v) / span * chartH
  const slot = area.width / bars.length, bw = Math.min(108, slot * 0.58)
  d.text(unit ? `单位：${unit}` : '累计变化', area.x, area.y, Math.min(850, area.width), 30, 15, p.muted)
  d.line(area.x, baseline, area.width, p.line)
  bars.forEach((bar, i) => {
    const x = area.x + slot * (i + 0.5) - bw / 2, top = Math.min(y(bar.from), y(bar.to)), height = Math.abs(y(bar.from) - y(bar.to))
    const color = bar.total ? p.ink : bar.value < 0 ? p.negative : i === focus + Number(!!startLabel) ? p.accent : p.positive
    d.shape(x, top, bw, Math.max(1, height), color)
    if (i < bars.length - 1) d.line(x + bw, y(bar.to), slot - bw, p.line)
    const label = bar.total ? format(bar.value) : `${bar.value > 0 ? '+' : ''}${format(bar.value)}`
    d.text(label, x - (slot - bw) / 2, top - 32, slot, 29, 21, color, true, 'center')
    d.text(bar.label, x - (slot - bw) / 2 + 3, chartY + chartH + 20, slot - 6, 51, 17, p.ink, bar.total, 'center')
  })
}

function sankey(d: Designer, content: Data, area: Rect, focus: number) {
  const parseNodes = (value: unknown, name: string) => list(value, name, 1, 8).map((v) => { const node = record(v, name); keys(node, ['id', 'label'], name); return { id: str(node.id, `${name}.id`, true), label: str(node.label, `${name}.label`, true), value: 0, y: 0, height: 0, offset: 0 } })
  const sources = parseNodes(content.sources, 'sources'), targets = parseNodes(content.targets, 'targets'), unit = str(content.unit, 'unit')
  if (new Set(sources.map((n) => n.id)).size !== sources.length || new Set(targets.map((n) => n.id)).size !== targets.length) throw new Error('同一侧节点 ID 不能重复。')
  const sourceById = new Map(sources.map((n) => [n.id, n])), targetById = new Map(targets.map((n) => [n.id, n]))
  const links = list(content.links, 'links', 1, 32).map((v) => { const link = record(v, 'link'); keys(link, ['source', 'target', 'value'], 'link'); const source = sourceById.get(str(link.source, 'source', true)), target = targetById.get(str(link.target, 'target', true)), value = finite(link.value, 'link.value'); if (!source || !target || value < 0) throw new Error('流向需引用实际节点，并提供非负流量。'); source.value += value; target.value += value; return { source, target, value } })
  const total = finite(sources.reduce((n, s) => n + s.value, 0), '流量合计')
  const gap = 17, maxNodes = Math.max(sources.length, targets.length), usable = area.height - 44 - gap * (maxNodes - 1)
  const scale = total > 0 ? usable / total : 0
  const place = (nodes: typeof sources) => { const used = total * scale + gap * (nodes.length - 1); let y = area.y + 16 + (area.height - 44 - used) / 2; for (const n of nodes) { n.y = y; n.height = n.value * scale; y += n.height + gap } }
  place(sources); place(targets)
  const labelWidth = Math.min(256, area.width * 0.23), width = 16
  const left = area.x + labelWidth + 20, right = area.x + area.width - labelWidth - 20 - width
  const colors = [d.colors.accent, d.colors.positive, '#7D88A4', '#9A8A61', '#728676', '#A06B63', '#6C8792', '#958697']
  for (const link of links) {
    const sy = link.source.y + link.source.offset, ty = link.target.y + link.target.offset, h = link.value * scale
    link.source.offset += h; link.target.offset += h
    if (h <= 0) continue
    const top = Math.min(sy, ty), extent = Math.max(sy + h, ty + h) - top
    const a = (sy - top) / extent, b = (ty - top) / extent, c = (sy + h - top) / extent, e = (ty + h - top) / extent
    const selected = sources.indexOf(link.source) === focus
    d.path({ x: left + width, y: top, width: right - left - width, height: extent }, [['M', 0, a], ['C', 0.42, a, 0.58, b, 1, b], ['L', 1, e], ['C', 0.58, e, 0.42, c, 0, c], ['Z']], `${colors[sources.indexOf(link.source)]}${selected ? 'B8' : '55'}`)
  }
  const labels = (nodes: typeof sources, isSource: boolean) => {
    const lineHeight = Math.min(54, (area.height - 28) / nodes.length), centers = nodes.map((n) => n.y + n.height / 2)
    if (total === 0) centers.forEach((_c, i) => { centers[i] = area.y + 28 + i * (area.height - 50) / Math.max(1, nodes.length - 1) })
    for (let i = 1; i < centers.length; i++) centers[i] = Math.max(centers[i]!, centers[i - 1]! + lineHeight)
    centers[centers.length - 1] = Math.min(centers.at(-1)!, area.y + area.height - 28)
    for (let i = centers.length - 2; i >= 0; i--) centers[i] = Math.min(centers[i]!, centers[i + 1]! - lineHeight)
    nodes.forEach((node, i) => { const ink = isSource ? colors[i]! : d.colors.ink, x = isSource ? left : right, cy = centers[i]!; d.shape(x, node.y, width, Math.max(1, node.height), ink); const labelX = isSource ? area.x : right + width + 20; d.text(node.label, labelX, cy - 28, labelWidth, 29, 20, ink, true, isSource ? 'right' : 'left'); d.text(`${format(node.value)}${unit ? ` ${unit}` : ''}`, labelX, cy + 4, labelWidth, 26, 16, d.colors.muted, false, isSource ? 'right' : 'left') })
  }
  labels(sources, true); labels(targets, false)
}
