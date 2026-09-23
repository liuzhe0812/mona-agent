import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installScreenTips } from '@genoffice/ui'

import {
  copyElementData,
  copySlide as copySlideBundle,
  elementDurableId,
  elementSpid,
  getChartElementData,
  getElementLink,
  getRunLinks,
  getSections,
  getSlideAnimations,
  getSlideComments,
  getSlideLinks,
  getSlideNotes,
  getSlideTransition,
  listMasterParts,
  listSlideLayouts,
  matchesElementRef,
  parseMasterPart,
  patchSlideXml,
  patchedElementXml,
  readHeaderFooter,
  slideDurableId,
  TABLE_STYLE_PRESETS,
  type OpenedPptx,
  type SlideBundle,
} from '@genoffice/pptx-engine'
import { buildRenderSlide, makeViewport, type RenderNode, type RenderSlide } from '@genoffice/pptx-render'
import { nativeParagraphs, nativeBodyPr } from './slides-typography'
import { expandSlideDesign } from './slides-design'
import { colorOperations, inspectSlideColors } from './slides-colors'
import { customPathXml } from '../vendor/genoffice/packages/pptx-engine/src/custom-path'
import { runTxn, type Op } from '../vendor/genoffice/apps/slides/src/main/ops'
import {
  App as GenOfficeSlidesApp,
  type EmbeddedSlidesController,
} from '../vendor/genoffice/apps/slides/src/renderer/App'
import type {
  EditFillOp,
  EditStrokeOp,
  EditTextOp,
  EditTransformOp,
  OpenResult,
  SetElementFontOp,
  SlidesApi,
} from '../vendor/genoffice/apps/slides/src/shared/ipc'
import { MonaOfficeBridge, type DocumentVersion, type HostMessage, type OfficeOpenMessage } from './bridge'
import { pickBrowserImage } from './browser-file-picker'
import {
  openSlidesDocument,
  refreshSlidesDocument,
  saveSlidesDocument,
  snapshotSlidesDocument,
  slideText,
  type SlidesDocument,
} from './slides-engine'
import { composeSlide, isBlockingLayoutWarning, slideLayoutWarnings } from './slides-layout'
import { expandPreset, rankPresets, presetCatalog, presetDiagnostics, findPreset, resolvePresetTheme, PRESET_ROLES, type PresetContent, type PresetRelation } from './slides-presets'
import { PresetContentStore } from './slides-preset-content'
import { dataUrlImage, svgImage } from './slides-assets'
import { getSlidesCapabilities } from './slides-capabilities'
import {
  clearSlidePending,
  createSlidesReviewState,
  markSlidesPending,
  operationsRequireAllSlides,
  operationsRequireVisualReview,
  pendingSlideIdsInOrder,
  resetSlidesReviewState,
  type SlidesReviewState,
} from './slides-review'
import { captureSlide, captureContactSheet, VisualVersionConflict } from './slides-visual'
import './entry.css'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '../vendor/genoffice/apps/slides/src/renderer/styles.css'
import './ribbon-overflow.css'

try {
  localStorage.setItem('ai-slides-show-ai', '0')
} catch {
  // Storage can be unavailable in isolated editor tests.
}

if (typeof document.addEventListener === 'function') installScreenTips()

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload())
}

const FIT_WIDTH = 1280

interface SlideElementView {
  id: string
  slideId?: string
  type: string
  text: string
  x: number
  y: number
  width: number
  height: number
  tableRows?: string[][]
  chart?: Partial<NonNullable<ReturnType<typeof getChartElementData>>>
  style?: SlideElementStyleSummary
}

interface SlideElementStyleSummary {
  fontFamily?: string
  fontSizePt?: number
  fontColor?: string
  fill?: string | null
  stroke?: { color: string; widthPt: number } | null
  align?: 'left' | 'center' | 'right' | 'justify' | 'mixed'
}

const SLIDE_ELEMENT_LABELS: Record<string, string> = {
  shape: '图形',
  text: '文本',
  picture: '图片',
  table: '表格',
  group: '组合',
  chart: '图表',
  'placeholder-chip': '占位符',
}

export function slideElementTypeLabel(type: string): string {
  return SLIDE_ELEMENT_LABELS[type] ?? '元素'
}

interface SlidesCommand {
  sessionId: string
  operationId: string
  expectedVersion: DocumentVersion
  operations: Array<{ op: string; payload: Record<string, unknown> }>
}

interface SlidesInspect {
  sessionId: string
  requestId: string
  query: Record<string, unknown>
}

interface SlidesSelectionState {
  slideIndex: number
  elementIds: string[]
}

interface SlidesSnapshot {
  deck: OpenedPptx['deck']
  entries: Map<string, Uint8Array>
  paths?: ReadonlySet<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value: unknown): value is DocumentVersion {
  return isRecord(value)
    && typeof value.editorEpoch === 'string'
    && Number.isInteger(value.modelRevision)
    && Number(value.modelRevision) >= 0
}

function sameVersion(left: DocumentVersion | null, right: DocumentVersion): boolean {
  return !!left
    && left.editorEpoch === right.editorEpoch
    && left.modelRevision === right.modelRevision
}

function nodeText(node: RenderNode): string {
  if (node.type === 'shape' || node.type === 'text') {
    return node.text?.lines.flatMap((line) => line.runs.map((run) => run.text)).join('') ?? ''
  }
  if (node.type === 'table') {
    return node.cells.flatMap((cell) => (
      cell.text ? [cell.text.lines.flatMap((line) => line.runs.map((run) => run.text)).join('')] : []
    )).join('\n')
  }
  if (node.type === 'group') return node.children.map(nodeText).filter(Boolean).join('\n')
  return ''
}

function textLayouts(node: RenderNode): Array<NonNullable<Extract<RenderNode, { text?: unknown }>['text']>> {
  if (node.type === 'shape' || node.type === 'text') return node.text ? [node.text] : []
  if (node.type === 'table') return node.cells.flatMap((cell) => (cell.text ? [cell.text] : []))
  if (node.type === 'group') return node.children.flatMap(textLayouts)
  return []
}

function fillSummary(value: unknown): string | null | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (value.kind === 'none') return null
  if (value.kind === 'solid' && typeof value.color === 'string') return value.color
  return value.kind
}

function elementStyleSummary(node: RenderNode, scale: number): SlideElementStyleSummary | undefined {
  const style: SlideElementStyleSummary = {}
  if ('fill' in node) {
    const fill = fillSummary(node.fill)
    if (fill !== undefined) style.fill = fill
  }
  if ('stroke' in node) {
    style.stroke = node.stroke
      ? { color: node.stroke.color, widthPt: node.stroke.widthPt }
      : null
  }
  const layouts = textLayouts(node)
  const runs = layouts.flatMap((layout) => layout.lines.flatMap((line) => line.runs))
  const families = new Set(runs.map((run) => run.fontFamily).filter(Boolean))
  if (families.size === 1) style.fontFamily = [...families][0]
  const sizes = new Set(
    runs
      .map((run) => run.fontSizePx)
      .filter((size) => Number.isFinite(size))
      .map((size) => Math.round((size / Math.max(scale, 0.0001)) * 0.75 * 100) / 100),
  )
  if (sizes.size === 1) style.fontSizePt = [...sizes][0]
  const colors = new Set(runs.map((run) => run.color).filter(Boolean))
  if (colors.size === 1) style.fontColor = [...colors][0]
  const aligns = new Set(
    layouts.flatMap((layout) => layout.lines.map((line) => line.align ?? 'left')),
  )
  if (aligns.size === 1) style.align = [...aligns][0]
  else if (aligns.size > 1) style.align = 'mixed'
  return Object.keys(style).length > 0 ? style : undefined
}

function elementViews(slide: RenderSlide, elementIds?: ReadonlySet<string>): SlideElementView[] {
  const views: SlideElementView[] = []
  const visit = (nodes: RenderNode[], offsetX = 0, offsetY = 0): void => {
    for (const node of nodes) {
      if (!node.decoration && node.durableId && (!elementIds || elementIds.has(node.durableId))) {
        const style = elementStyleSummary(node, slide.scale)
        const tableRows = node.type === 'table'
          ? Array.from({ length: Math.max(0, ...node.cells.map((cell) => cell.row + 1)) }, (_row, row) => (
              Array.from({ length: Math.max(0, ...node.cells.map((cell) => cell.col + 1)) }, (_column, column) => {
                const cell = node.cells.find((candidate) => candidate.row === row && candidate.col === column)
                return cell?.text?.lines.flatMap((line) => line.runs.map((run) => run.text)).join('') ?? ''
              })
            ))
          : undefined
        views.push({
          id: node.durableId!,
          type: node.type,
          text: nodeText(node),
          x: node.box.x + offsetX,
          y: node.box.y + offsetY,
          width: node.box.w,
          height: node.box.h,
          ...(tableRows ? { tableRows } : {}),
          ...(style ? { style } : {}),
        })
      }
      if (node.type === 'group' && elementIds) {
        visit(node.children, offsetX + node.box.x, offsetY + node.box.y)
      }
    }
  }
  visit(slide.nodes)
  return views
}

function slideId(document: SlidesDocument, index: number): string {
  const slide = document.opened.deck.slides[index]
  if (!slide) throw new Error(`幻灯片索引越界：${index}`)
  return slideDurableId(slide)
}

function durableIdForSource(slide: RenderSlide, sourceId: string): string | null {
  const visit = (nodes: RenderNode[]): string | null => {
    for (const node of nodes) {
      if (node.sourceId === sourceId) return node.durableId ?? null
      if (node.type === 'group') {
        const found = visit(node.children)
        if (found) return found
      }
    }
    return null
  }
  return visit(slide.nodes)
}

function slideIndex(document: SlidesDocument, value: unknown): number {
  const id = String(value ?? '')
  const index = document.opened.deck.slides.findIndex((slide) => slideDurableId(slide) === id)
  if (index < 0) throw new Error(`找不到幻灯片：${id}`)
  return index
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串。`)
  return value
}

function targetOf(payload: Record<string, unknown>): { slide: string; el?: string } {
  const slide = requiredText(payload.slideId, 'slideId')
  return {
    slide,
    ...(payload.elementId == null ? {} : { el: requiredText(payload.elementId, 'elementId') }),
  }
}

function numeric(value: unknown, fallback: number): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function operationBox(
  document: SlidesDocument,
  payload: Record<string, unknown>,
): { x: number; y: number; cx: number; cy: number } {
  const index = slideIndex(document, payload.slideId)
  const slide = document.slides[index]!
  const existing = payload.elementId == null
    ? undefined
    : elementViews(slide).find((element) => element.id === payload.elementId)
  const x = numeric(payload.x, existing?.x ?? 60)
  const y = numeric(payload.y, existing?.y ?? 60)
  const width = numeric(payload.width, existing?.width ?? 360)
  const height = numeric(payload.height, existing?.height ?? 120)
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > slide.widthPx || y + height > slide.heightPx) {
    throw new Error('元素位置或尺寸超出幻灯片边界。')
  }
  const scaleX = document.opened.deck.size.cx / slide.widthPx
  const scaleY = document.opened.deck.size.cy / slide.heightPx
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
    cx: Math.round(width * scaleX),
    cy: Math.round(height * scaleY),
  }
}

function paragraphAlign(value: unknown): 'left' | 'center' | 'right' | 'justify' | undefined {
  return value === 'left' || value === 'center' || value === 'right' || value === 'justify'
    ? value
    : undefined
}

function addedTextParagraphs(payload: Record<string, unknown>) {
  return nativeParagraphs(payload)
}

async function preparePresetImage(operation: SlidesCommand['operations'][number]): Promise<SlidesCommand['operations'][number]> {
  if (!['slide_add_preset', 'slide_add_design'].includes(operation.op) || !isRecord(operation.payload.content)) return operation
  if (typeof Image === 'undefined') return operation
  const measure = async (image: unknown) => {
    if (!isRecord(image) || typeof image.dataUrl !== 'string') throw new Error('预设图片需要合法数据。')
    dataUrlImage(image.dataUrl)
    const bitmap = new Image()
    bitmap.src = image.dataUrl
    await bitmap.decode()
    if (!bitmap.naturalWidth || !bitmap.naturalHeight) throw new Error('预设图片无法解码。')
    return {...image,width:bitmap.naturalWidth,height:bitmap.naturalHeight,fit:'contain'}
  }
  const content = {...operation.payload.content}
  if (content.image) content.image = await measure(content.image)
  if (Array.isArray(content.images)) content.images = await Promise.all(content.images.map(measure))
  return {...operation,payload:{...operation.payload,content}}
}

function translateOperation(
  document: SlidesDocument,
  operation: SlidesCommand['operations'][number],
): {
  op?: Op
  ops?: Op[]
  targets: string[]
  chartStyles?: Array<{ opOffset: number; slideId: string; style: Record<string, unknown> }>
  preset?: {
    presetId: string
    slideId: string
    roles: string[]
    design: Pick<PresetContent, 'theme' | 'accentColor'>
    pendingChartStyles: Array<{ role: string; style: Record<string, unknown> }>
  }
} {
  if (!isRecord(operation) || typeof operation.op !== 'string' || !isRecord(operation.payload)) {
    throw new Error('幻灯片操作格式无效。')
  }
  const payload = operation.payload
  if (operation.op === 'slide_replace_colors') {
    const ops = colorOperations(document.opened, payload)
    return { ops, targets: ops.map((op) => String(op.target!.slide)) }
  }
  if (operation.op === 'slide_add_design') {
    const index = slideIndex(document, payload.slideId)
    if (payload.region === undefined && document.opened.deck.slides[index]!.elements.length) {
      throw new Error('完整设计页只写入空白页；已有内容请按真实 ID 局部修改，或指定明确 region 组合组件。')
    }
    const native = expandSlideDesign(payload, document).map((item) => translateOperation(document, item))
    const ops: Op[] = []
    const chartStyles: NonNullable<ReturnType<typeof translateOperation>['chartStyles']> = []
    for (const item of native) {
      for (const pending of item.chartStyles ?? []) chartStyles.push({ ...pending, opOffset: ops.length + pending.opOffset })
      ops.push(...(item.ops ?? (item.op ? [item.op] : [])))
    }
    return { ops, chartStyles, targets: [String(payload.slideId)] }
  }
  if (operation.op === 'slide_compose') {
    const slide = document.slides[slideIndex(document, payload.slideId)]!
    const translated = composeSlide(payload, slide).map((item) => translateOperation(document, item))
    const ops: Op[] = []
    const chartStyles: NonNullable<ReturnType<typeof translateOperation>['chartStyles']> = []
    for (const item of translated) {
      for (const pending of item.chartStyles ?? []) chartStyles.push({ ...pending, opOffset: ops.length + pending.opOffset })
      ops.push(...(item.ops ?? (item.op ? [item.op] : [])))
    }
    return { ops, chartStyles, targets: [String(payload.slideId)] }
  }
  if (operation.op === 'slide_add_preset') {
    const unknown = Object.keys(payload).filter((key) => !['slideId','presetId','content'].includes(key))
    if (unknown.length) throw new Error(`slide_add_preset 不支持字段：${unknown.join(', ')}`)
    const slide = document.slides[slideIndex(document, payload.slideId)]!
    const modelSlide = document.opened.deck.slides[slideIndex(document, payload.slideId)]!
    if (!isRecord(payload.content)) throw new Error('slide_add_preset 需要 content 对象。')
    const expanded = expandPreset({
      slideId: requiredText(payload.slideId, 'slideId'),
      presetId: payload.presetId === undefined ? 'auto' : requiredText(payload.presetId, 'presetId'),
      content: payload.content as unknown as PresetContent,
      page: { width: slide.widthPx, height: slide.heightPx },
      // 预设按页面真实尺寸布局：EMU 比例取自当前文档，不假定所有预览尺度相同。
      scale: {
        x: document.opened.deck.size.cx / slide.widthPx,
        y: document.opened.deck.size.cy / slide.heightPx,
      },
    })
    if (modelSlide.elements.length) throw new Error('整页预设只能写入空白页；已有页面请按稳定元素 ID 局部修改或新建页面。')
    const translated = expanded.operations.map((item) => translateOperation(document, item))
    return {
      ops: translated.flatMap((item) => item.ops ?? (item.op ? [item.op] : [])),
      targets: [String(payload.slideId)],
      preset: { presetId: expanded.presetId, slideId: String(payload.slideId), roles: expanded.roles,
        design:{theme:expanded.theme,accentColor:(payload.content as unknown as PresetContent).accentColor}, pendingChartStyles: expanded.pendingChartStyles },
    }
  }
  if (operation.op === 'slide_apply_txn') {
    if (!Array.isArray(payload.ops) || payload.ops.length === 0 || payload.ops.length > 50
      || payload.ops.some((op) => !isRecord(op) || typeof op.op !== 'string')) {
      throw new Error('slide_apply_txn.ops 必须包含 1–50 个 GenOffice 结构化操作。')
    }
    const ops = (payload.ops as Op[]).map((op) => {
      const source = op.op === 'setImageFill' && isRecord(op.source) ? op.source : op
      if (!['addPicture', 'replacePicture', 'setImageFill'].includes(op.op) || String(source.ext).toLowerCase() !== 'svg') return op
      const bytes = source.bytes instanceof Uint8Array ? source.bytes
        : Array.isArray(source.bytes) ? Uint8Array.from(source.bytes) : null
      if (!bytes) throw new Error('SVG 图片需要有效字节数据。')
      const image = svgImage(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return op.op === 'setImageFill' ? { ...op, source: { ...source, ...image } } : { ...op, ...image }
    })
    const targets = ops.map((op) => {
      const slide = op.target?.slide
      const element = op.target?.el
      return element == null ? String(slide ?? 'document') : `${String(slide)}/${element}`
    })
    return { ops, targets }
  }
  const target = targetOf(payload)
  const changed = [target.el ? `${target.slide}/${target.el}` : target.slide]
  if (operation.op === 'slide_add_chart') {
    const allowed = ['slideId', 'x', 'y', 'width', 'height', 'kind', 'title', 'categories', 'series', 'legendPos', 'gridlines', 'dataLabels', 'catAxisTitle', 'valAxisTitle', 'gapWidthPct', 'style']
    const extras = Object.keys(payload).filter((key) => !allowed.includes(key))
    if (extras.length) throw new Error(`slide_add_chart 不支持字段：${extras.join(', ')}。`)
    if (['x', 'y', 'width', 'height'].some((key) => typeof payload[key] !== 'number' || !Number.isFinite(payload[key]))) {
      throw new Error('slide_add_chart 需要有限数值的 x、y、width、height（预览像素）。')
    }
    if (['title', 'catAxisTitle', 'valAxisTitle'].some((key) => key in payload && typeof payload[key] !== 'string')
      || ['gridlines', 'dataLabels'].some((key) => key in payload && typeof payload[key] !== 'boolean')
      || ('gapWidthPct' in payload && (typeof payload.gapWidthPct !== 'number' || !Number.isFinite(payload.gapWidthPct) || payload.gapWidthPct <= 0))
      || ('legendPos' in payload && !['none', 'b', 't', 'l', 'r'].includes(String(payload.legendPos)))) {
      throw new Error('图表 title/catAxisTitle/valAxisTitle 必须是文本，gridlines/dataLabels 必须是布尔值，gapWidthPct 必须是正数，legendPos 必须是 none/b/t/l/r。')
    }
    if (!['bar', 'line', 'area', 'pie', 'doughnut'].includes(String(payload.kind))) {
      throw new Error('slide_add_chart.kind 必须是 bar、line、area、pie 或 doughnut。')
    }
    if (!Array.isArray(payload.categories) || !payload.categories.length
      || payload.categories.some((value) => typeof value !== 'string')
      || !Array.isArray(payload.series) || !payload.series.length
      || payload.series.some((series) => !isRecord(series) || typeof series.name !== 'string'
        || Object.keys(series).some((key) => !['name', 'values'].includes(key))
        || !Array.isArray(series.values) || series.values.length !== (payload.categories as unknown[]).length
        || series.values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new Error('图表需要非空 categories 和 series，每个系列的有限数值数量必须与分类一致。')
    }
    const chart = Object.fromEntries(['kind', 'title', 'categories', 'series', 'legendPos', 'gridlines', 'dataLabels', 'catAxisTitle', 'valAxisTitle', 'gapWidthPct']
      .filter((key) => key in payload).map((key) => [key, payload[key]]))
    if (payload.style !== undefined && !isRecord(payload.style)) throw new Error('slide_add_chart.style 必须是图表样式对象。')
    return {
      op: { ...chart, op: 'addChart', target, offset: operationBox(document, payload) } as Op,
      targets: changed,
      ...(isRecord(payload.style) ? { chartStyles: [{ opOffset: 0, slideId: target.slide, style: payload.style }] } : {}),
    }
  }
  if (operation.op === 'slide_set_chart_style') {
    if (!isRecord(payload.style)) throw new Error('slide_set_chart_style 需要 style 对象。')
    const style = payload.style
    const colors = ['textColor', 'titleColor', 'axisLabelColor', 'axisTitleColor', 'legendColor', 'dataLabelColor', 'gridColor', 'axisLineColor']
    const unknown = Object.keys(style).filter((key) => ![...colors, 'seriesColors', 'axisLabelFontSize'].includes(key))
    if (unknown.length) throw new Error(`不支持的图表样式：${unknown.join(', ')}。`)
    if (colors.some((key) => key in style && (typeof style[key] !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(style[key] as string)))) {
      throw new Error('图表样式颜色必须是 #RRGGBB。')
    }
    if ('axisLabelFontSize' in payload.style && (typeof payload.style.axisLabelFontSize !== 'number' || !Number.isFinite(payload.style.axisLabelFontSize) || payload.style.axisLabelFontSize <= 0)) {
      throw new Error('axisLabelFontSize 必须是正数磅值。')
    }
    const { seriesColors, ...textStyle } = payload.style
    const patch: Record<string, unknown> = { ...textStyle }
    if (seriesColors !== undefined) {
      if (!Array.isArray(seriesColors) || !seriesColors.length
        || seriesColors.some((color) => typeof color !== 'string' || !/^#?[0-9a-fA-F]{6}$/.test(color))) {
        throw new Error('slide_set_chart_style.seriesColors 必须是 1 个以上 #RRGGBB 颜色。')
      }
      // 引擎的系列调色板字段名是 colorScheme；这里做一层显式映射，避免模型直接猜底层字段。
      patch.colorScheme = seriesColors
    }
    if (!Object.keys(patch).length) throw new Error('slide_set_chart_style.style 至少需要一个字段。')
    return { op: { op: 'setChart', target, patch }, targets: changed }
  }
  if (operation.op === 'slide_set_text') {
    return {
      op: {
        op: 'setText',
        target,
        paragraphs: nativeParagraphs(payload) ?? (() => { throw new Error('需要 text 或 paragraphs。') })(),
      },
      targets: changed,
    }
  }
  if (operation.op === 'slide_set_font') {
    const font = isRecord(payload.font) ? payload.font : {}
    const slide = document.opened.deck.slides[slideIndex(document, target.slide)]!
    const element = target.el ? slide.elements.find((node) => matchesElementRef(node, target.el!)) : undefined
    if (element?.type === 'chart') {
      if (Object.keys(font).length !== 1 || typeof font.color !== 'string') {
        throw new Error('图表改色请使用 slide_set_chart_style 的 style.textColor；普通文本框字体字段不适用于图表。')
      }
      return { op: { op: 'setChart', target, patch: { textColor: font.color } }, targets: changed }
    }
    return {
      op: {
        op: 'setFont',
        target,
        font: {
          ...(typeof font.fontFamily === 'string' ? { fontFamily: font.fontFamily } : {}),
          ...(Number.isFinite(Number(font.fontSize)) ? { fontSizePt: Number(font.fontSize) } : {}),
          ...(typeof font.bold === 'boolean' ? { bold: font.bold } : {}),
          ...(typeof font.italic === 'boolean' ? { italic: font.italic } : {}),
          ...(typeof font.underline === 'boolean' ? { underline: font.underline } : {}),
          ...(typeof font.strike === 'boolean' ? { strike: font.strike } : {}),
          ...(typeof font.color === 'string' ? { color: font.color } : {}),
        },
      },
      targets: changed,
    }
  }
  if (operation.op === 'slide_set_geometry') {
    return { op: { op: 'setTransform', target, box: operationBox(document, payload) }, targets: changed }
  }
  if (operation.op === 'slide_set_fill') {
    const fill = payload.color === null ? 'none' : requiredText(payload.color, 'color')
    return { op: { op: 'setFill', target, fill }, targets: changed }
  }
  if (operation.op === 'slide_set_stroke') {
    const stroke = payload.color === null
      ? null
      : {
          color: requiredText(payload.color, 'color'),
          widthEmu: Math.round(Math.max(0.1, numeric(payload.widthPt, 1)) * 12700),
        }
    return { op: { op: 'setStroke', target, stroke }, targets: changed }
  }
  if (operation.op === 'slide_delete_element') {
    return { op: { op: 'deleteElement', target }, targets: changed }
  }
  if (operation.op === 'slide_add_text' || operation.op === 'slide_add_shape' || operation.op === 'slide_add_path') {
    const box = operationBox(document, payload)
    const vp = makeViewport(document.opened.deck.size, document.slides[slideIndex(document, payload.slideId)]!.widthPx)
    const bodyPr = nativeBodyPr(payload.body, vp)
    if (operation.op === 'slide_add_path') {
      customPathXml(payload.path)
      if (payload.fillColor !== undefined && (typeof payload.fillColor !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(payload.fillColor))) throw new Error('自由形状填充必须是 #RRGGBB 或 #RRGGBBAA。')
      if (payload.strokeColor !== undefined && payload.strokeColor !== null && (typeof payload.strokeColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(payload.strokeColor))) throw new Error('自由形状描边必须是 #RRGGBB。')
      if (payload.strokeWidthPt !== undefined && (typeof payload.strokeWidthPt !== 'number' || !Number.isFinite(payload.strokeWidthPt) || payload.strokeWidthPt <= 0)) throw new Error('自由形状描边宽度必须是正数。')
    }
    const kind = operation.op === 'slide_add_text'
      ? 'textbox'
      : requiredText(payload.shape ?? 'rect', 'shape')
    const paragraphs = addedTextParagraphs(payload)
    const strokeColor = typeof payload.strokeColor === 'string' ? payload.strokeColor : null
    return {
      op: {
        op: 'addElement',
        target: { slide: target.slide },
        kind,
        offset: box,
        ...(paragraphs ? { paragraphs } : {}),
        ...(typeof payload.fillColor === 'string' ? { fill: payload.fillColor } : {}),
        ...(bodyPr ? { bodyPr } : {}),
        ...(operation.op === 'slide_add_path' ? { customPath: payload.path } : {}),
        ...(strokeColor ? {
          stroke: {
            color: strokeColor,
            widthEmu: Math.round(Math.max(0.1, numeric(payload.strokeWidthPt, 1)) * 12700),
          },
        } : {}),
      },
      targets: [target.slide],
    }
  }
  if (operation.op === 'slide_add_image' || operation.op === 'slide_add_svg') {
    const image = operation.op === 'slide_add_svg'
      ? svgImage(requiredText(payload.svg, 'svg')) : dataUrlImage(payload.dataUrl)
    return {
      op: {
        op: 'addPicture',
        target: { slide: target.slide },
        bytes: image.bytes,
        ext: image.ext,
        offset: operationBox(document, payload),
      },
      targets: [target.slide],
    }
  }
  if (operation.op === 'slide_add') {
    return { op: { op: 'addBlankSlide', target: { slide: target.slide } }, targets: [target.slide] }
  }
  if (operation.op === 'slide_duplicate') {
    return { op: { op: 'duplicateSlide', target: { slide: target.slide } }, targets: [target.slide] }
  }
  if (operation.op === 'slide_delete') {
    return { op: { op: 'deleteSlide', target: { slide: target.slide } }, targets: [target.slide] }
  }
  if (operation.op === 'slide_move') {
    const to = Number(payload.toIndex)
    if (!Number.isInteger(to) || to < 0 || to >= document.slides.length) throw new Error('toIndex 超出范围。')
    return { op: { op: 'moveSlide', target: { slide: target.slide }, to }, targets: [target.slide] }
  }
  throw new Error(`不支持的幻灯片操作：${operation.op}`)
}

function takeSnapshot(document: SlidesDocument, paths?: ReadonlySet<string>): SlidesSnapshot {
  const entries = document.opened.archive.entries as Map<string, Uint8Array>
  return {
    deck: { ...document.opened.deck, size: { ...document.opened.deck.size }, slides: document.opened.deck.slides.map(
      (slide) => !paths || paths.has(slide.path) ? structuredClone(slide) : slide,
    ) },
    entries: new Map(entries),
    paths,
  }
}

function restoreSnapshot(document: SlidesDocument, snapshot: SlidesSnapshot): SlidesDocument {
  const current = new Map(document.opened.deck.slides.map((slide) => [slide.path, slide]))
  document.opened.deck = { ...snapshot.deck, size: { ...snapshot.deck.size }, slides: snapshot.deck.slides.map(
    (slide) => snapshot.paths && !snapshot.paths.has(slide.path) ? current.get(slide.path)! : structuredClone(slide),
  ) }
  const entries = document.opened.archive.entries as Map<string, Uint8Array>
  entries.clear()
  for (const [path, bytes] of snapshot.entries) entries.set(path, bytes)
  return refreshSlidesDocument(document, FIT_WIDTH, snapshot.paths)
}

function unchangedDocument(document: SlidesDocument, before: SlidesSnapshot): boolean {
  const current = document.opened
  if (JSON.stringify(current.deck.size) !== JSON.stringify(before.deck.size)
    || current.deck.slides.map((slide) => slide.path).join('|') !== before.deck.slides.map((slide) => slide.path).join('|')) return false
  if (current.deck.slides.some((slide, index) => (!before.paths || before.paths.has(slide.path))
    && patchSlideXml(slide) !== patchSlideXml(before.deck.slides[index]!))) return false
  const entries = current.archive.entries as Map<string, Uint8Array>
  return entries.size === before.entries.size && [...before.entries].every(([path, bytes]) => {
    const after = entries.get(path)
    return after === bytes || (!!after && bytes.length === after.length && bytes.every((value, index) => value === after[index]))
  })
}

const LOCAL_OPERATIONS = new Set([
  'monaReplaceColors',
  'setText', 'setFont', 'setParagraphFormat', 'setTransform', 'setFill', 'setStroke',
  'setChart', 'addElement', 'addPicture', 'addChart', 'addTable', 'deleteElement',
  'setTableCell', 'setTableStyle', 'setPictureSrcRect', 'setPictureOpacity',
])

function affectedSlidePaths(document: SlidesDocument, operations: Op[]): ReadonlySet<string> | undefined {
  if (operations.some((op) => !LOCAL_OPERATIONS.has(op.op) || op.target?.part || op.target?.slide == null)) return undefined
  return new Set(operations.map((op) => {
    const ref = op.target!.slide
    return typeof ref === 'number' ? document.opened.deck.slides[ref]?.path
      : document.opened.deck.slides.find((slide) => slideDurableId(slide) === ref)?.path
  }).filter((path): path is string => !!path))
}

function slideIdsOf(document: SlidesDocument): string[] {
  return document.opened.deck.slides.map(slideDurableId)
}

function createdSlidesOf(
  before: SlidesSnapshot,
  document: SlidesDocument,
): Array<{ id: string; index: number; width: number; height: number }> {
  const previousPaths = new Set(before.deck.slides.map((slide) => slide.path))
  return document.opened.deck.slides.flatMap((slide, index) => {
    if (previousPaths.has(slide.path)) return []
    const rendered = document.slides[index]
    return rendered
      ? [{ id: slideDurableId(slide), index, width: rendered.widthPx, height: rendered.heightPx }]
      : []
  })
}

function slideElementIds(slide: RenderSlide): ReadonlySet<string> {
  const ids = new Set<string>()
  const visit = (nodes: RenderNode[]): void => {
    for (const node of nodes) {
      if (!node.decoration && node.durableId) ids.add(node.durableId)
      if (node.type === 'group') visit(node.children)
    }
  }
  visit(slide.nodes)
  return ids
}

function reviewWarnings(document: SlidesDocument, slideIds: readonly string[]): string[] {
  const requested = new Set(slideIds)
  return document.slides.flatMap((slide, index) => (
    requested.has(slideId(document, index))
      ? slideLayoutWarnings(slide, slideElementIds(slide))
      : []
  ))
}

interface ReviewRecord {
  op: Op
  slideId?: string
}

function slideIdFromSnapshot(snapshot: SlidesSnapshot, value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const slide = snapshot.deck.slides[value]
    return slide ? slideDurableId(slide) : undefined
  }
  if (typeof value === 'string') {
    return snapshot.deck.slides.some((slide) => slideDurableId(slide) === value) ? value : undefined
  }
  return undefined
}

function reviewScope(
  before: SlidesSnapshot,
  operations: readonly Op[],
  records?: readonly ReviewRecord[],
): { slideIds: string[]; allSlides: boolean; operations: Op[] } {
  const actualOperations = records?.map((record) => record.op) ?? [...operations]
  const slideIds = new Set(records?.flatMap((record) => record.slideId ? [record.slideId] : []) ?? [])
  let allSlides = operationsRequireAllSlides(actualOperations)
  for (const operation of actualOperations) {
    if (operation.target?.part !== undefined || operation.target?.slide === undefined) {
      allSlides = true
      continue
    }
    const id = slideIdFromSnapshot(before, operation.target.slide)
    if (id) slideIds.add(id)
  }
  if (slideIds.size > 1) allSlides = true
  return { slideIds: [...slideIds], allSlides, operations: actualOperations }
}

function MonaSlidesEditor(): React.JSX.Element {
  const bridgeRef = useRef<MonaOfficeBridge | null>(null)
  if (!bridgeRef.current) bridgeRef.current = new MonaOfficeBridge('slides')
  const sessionRef = useRef<OfficeOpenMessage | null>(null)
  const versionRef = useRef<DocumentVersion | null>(null)
  const documentRef = useRef<SlidesDocument | null>(null)
  const reviewStateRef = useRef<SlidesReviewState>(createSlidesReviewState())
  const observedSlideVersionsRef = useRef(new Map<string, DocumentVersion>())
  const selectionRef = useRef<SlidesSelectionState>({ slideIndex: 0, elementIds: [] })
  const revisionFilesRef = useRef(new Map<number, () => Promise<ArrayBuffer>>())
  const operationCacheRef = useRef(new Map<string, { fingerprint: string; result: unknown }>())
  const presetContentsRef = useRef(new PresetContentStore())
  const presetHistoryRef = useRef(new Map<string, { presetId: string; anchor: string }>())
  const presetDesignRef = useRef<Pick<PresetContent, 'theme' | 'accentColor'>>({})
  const undoRef = useRef<SlidesSnapshot[]>([])
  const redoRef = useRef<SlidesSnapshot[]>([])
  const deckListenersRef = useRef(new Set<(state: { slides: RenderSlide[]; size: { cx: number; cy: number } }) => void>())
  const openedListenersRef = useRef(new Set<(result: OpenResult) => void>())
  const historyListenersRef = useRef(new Set<(state: { canUndo: boolean; canRedo: boolean }) => void>())
  const pendingOpenResolversRef = useRef<Array<(result: OpenResult) => void>>([])
  const openedInGenOfficeRef = useRef(false)
  const dirtyRef = useRef(false)
  const transformPreviewRef = useRef(new Map<string, SlidesSnapshot>())
  const elementClipboardRef = useRef<{ items: unknown[]; pasteCount: number } | null>(null)
  const slideClipboardRef = useRef<{ bundle: SlideBundle; png?: string } | null>(null)
  const masterPartRef = useRef<string | null>(null)
  const transitionsRef = useRef(new Map<number, Parameters<SlidesApi['setTransition']>[0]['kind']>())
  const animationsRef = useRef(new Map<number, Awaited<ReturnType<SlidesApi['getAnimations']>>>())
  const [status, setStatus] = useState('等待 Mona 打开幻灯片…')
  const [error, setError] = useState<string | null>(null)

  function currentPendingVisualSlideIds(document = documentRef.current): string[] {
    return document
      ? pendingSlideIdsInOrder(reviewStateRef.current, slideIdsOf(document))
      : []
  }

  function postWithPendingReview(message: Record<string, unknown>): void {
    bridgeRef.current?.post({
      ...message,
      pendingVisualSlideIds: currentPendingVisualSlideIds(),
    } as unknown as Parameters<MonaOfficeBridge['post']>[0])
  }

  function updateReviewAfterMutation(
    document: SlidesDocument,
    before: SlidesSnapshot,
    operations: readonly Op[],
    records?: readonly ReviewRecord[],
  ): void {
    observedSlideVersionsRef.current.clear()
    const scope = reviewScope(before, operations, records)
    const current = slideIdsOf(document)
    const warningTargets = scope.allSlides ? current : scope.slideIds
    const warnings = reviewWarnings(document, warningTargets)
    markSlidesPending(reviewStateRef.current, current, scope.slideIds, {
      allSlides: scope.allSlides,
      requiresVisual: operationsRequireVisualReview(scope.operations),
      hasWarnings: warnings.length > 0,
    })
  }

  function rememberFile(version: DocumentVersion, document: SlidesDocument): void {
    revisionFilesRef.current.set(version.modelRevision, snapshotSlidesDocument(document.opened))
    while (revisionFilesRef.current.size > 32) {
      const first = revisionFilesRef.current.keys().next().value
      if (first === undefined) break
      revisionFilesRef.current.delete(first)
    }
  }

  async function displayDocument(document: SlidesDocument): Promise<void> {
    documentRef.current = document
    if (openedInGenOfficeRef.current) {
      const state = { slides: document.slides, size: document.opened.deck.size }
      for (const listener of deckListenersRef.current) listener(state)
    }
  }

  async function reparseDocument(document: SlidesDocument): Promise<SlidesDocument> {
    const reparsed = await openSlidesDocument(await saveSlidesDocument(document.opened), FIT_WIDTH)
    await displayDocument(reparsed)
    const version = versionRef.current
    if (version) rememberFile(version, reparsed)
    return reparsed
  }

  function asOpenResult(document: SlidesDocument): OpenResult {
    return {
      path: sessionRef.current ? `mona://${sessionRef.current.sessionId}` : '',
      slides: document.slides,
      size: document.opened.deck.size,
    }
  }

  function notifyHistory(): void {
    const state = { canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0 }
    for (const listener of historyListenersRef.current) listener(state)
  }

  async function openDocument(message: OfficeOpenMessage): Promise<void> {
    const sameSession = sessionRef.current?.sessionId === message.sessionId
    observedSlideVersionsRef.current.clear()
    if (message.documentType !== 'slides' || !isVersion(message.version)) {
      throw new Error('当前入口不能打开这个文档。')
    }
    setStatus('正在打开幻灯片…')
    setError(null)
    const loaded = await openSlidesDocument(message.file, FIT_WIDTH)
    sessionRef.current = message
    versionRef.current = message.version
    const restoredPending = (message as OfficeOpenMessage & { pendingVisualSlideIds?: unknown }).pendingVisualSlideIds
    resetSlidesReviewState(
      reviewStateRef.current,
      Array.isArray(restoredPending) ? restoredPending.filter((id): id is string => typeof id === 'string') : [],
      slideIdsOf(loaded),
    )
    selectionRef.current = { slideIndex: 0, elementIds: [] }
    revisionFilesRef.current.clear()
    revisionFilesRef.current.set(message.version.modelRevision, () => Promise.resolve(message.file.slice(0)))
    operationCacheRef.current.clear()
    presetContentsRef.current.clear()
    presetHistoryRef.current.clear()
    if (!sameSession) presetDesignRef.current = {}
    undoRef.current = []
    redoRef.current = []
    await displayDocument(loaded)
    dirtyRef.current = false
    const opened = asOpenResult(loaded)
    if (pendingOpenResolversRef.current.length > 0) {
      openedInGenOfficeRef.current = true
      for (const resolve of pendingOpenResolversRef.current.splice(0)) resolve(opened)
    } else {
      openedInGenOfficeRef.current = true
      for (const listener of openedListenersRef.current) listener(opened)
    }
    notifyHistory()
    bridgeRef.current?.post({
      type: 'office_editor_ready',
      sessionId: message.sessionId,
      version: message.version,
    })
    setStatus('')
  }

  async function checkpoint(version: DocumentVersion): Promise<void> {
    const session = sessionRef.current
    const filePromise = revisionFilesRef.current.get(version.modelRevision)
    if (!session || !filePromise || version.editorEpoch !== versionRef.current?.editorEpoch) return
    const file = (await filePromise()).slice(0)
    bridgeRef.current?.post({ type: 'office_checkpoint', sessionId: session.sessionId, version, file }, [file])
  }

  async function inspect(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.sessionId !== 'string'
      || typeof value.requestId !== 'string' || !isRecord(value.query)) return
    const command = value as unknown as SlidesInspect
    const session = sessionRef.current
    const version = versionRef.current
    const document = documentRef.current
    if (!session || !version || !document || command.sessionId !== session.sessionId) return
    try {
      const mode = command.query.mode
      const pageIndexes = (query: Record<string, unknown>): number[] => {
        if (query.slideIds === undefined || (Array.isArray(query.slideIds) && query.slideIds.length === 0)) {
          return document.slides.map((_slide, index) => index)
        }
        if (!Array.isArray(query.slideIds)) throw new Error('slideIds 必须是字符串数组。')
        const requested = query.slideIds.map((value, index) => requiredText(value, `slideIds[${index}]`))
        const available = new Set(document.opened.deck.slides.map(slideDurableId))
        const missing = [...new Set(requested.filter((id) => !available.has(id)))]
        if (missing.length > 0) throw new Error(`找不到幻灯片：${missing.join(', ')}`)
        const ids = new Set(requested)
        return document.slides.flatMap((_slide, index) => ids.has(slideId(document, index)) ? [index] : [])
      }
      const elementIdsForPages = (query: Record<string, unknown>, indexes: readonly number[]): string[] | undefined => {
        if (query.elementIds === undefined || (Array.isArray(query.elementIds) && query.elementIds.length === 0)) {
          return undefined
        }
        if (!Array.isArray(query.elementIds)) throw new Error('elementIds 必须是字符串数组。')
        const requested = query.elementIds.map((value, index) => requiredText(value, `elementIds[${index}]`))
        const available = new Set(indexes.flatMap((index) => [...slideElementIds(document.slides[index]!)]))
        const missing = [...new Set(requested.filter((id) => !available.has(id)))]
        if (missing.length > 0) throw new Error(`找不到元素：${missing.join(', ')}`)
        return requested
      }
      const chartSummary = (
        modelSlide: OpenedPptx['deck']['slides'][number],
        element: SlideElementView,
      ): Partial<NonNullable<ReturnType<typeof getChartElementData>>> | null => {
        if (element.type !== 'chart') return null
        const chart = getChartElementData(modelSlide, element.id)
        return chart ? {
          kind: chart.kind,
          title: chart.title,
          textStyle: chart.textStyle,
          axisTextStyles: chart.axisTextStyles,
          supportedTextStyleFields: chart.supportedTextStyleFields,
        } : null
      }
      const page = (index: number, includeElements = true): Record<string, unknown> => {
        const slide = document.slides[index]!
        const modelSlide = document.opened.deck.slides[index]!
        const elements = includeElements
          ? elementViews(slide).map((element) => {
              const chart = chartSummary(modelSlide, element)
              const link = getElementLink(document.opened, index, element.id)
              return {
                ...element,
                ...(chart ? { chart } : {}),
                ...(link ? { link } : {}),
              }
            })
          : []
        const title = includeElements
          ? elements.find((element) => element.text.trim())?.text.split('\n')[0] ?? ''
          : slideText(slide).split('\n').find((text) => text.trim()) ?? ''
        return {
          id: slideId(document, index),
          index,
          title,
          width: slide.widthPx,
          height: slide.heightPx,
          elements,
          notes: getSlideNotes(document.opened.archive, modelSlide.path),
          transition: getSlideTransition(modelSlide),
          animations: getSlideAnimations(modelSlide).length,
          comments: getSlideComments(document.opened.archive, modelSlide.path).length,
        }
      }
      let result: unknown
      if (mode === 'palette') {
        result = inspectSlideColors(document.opened, command.query)
      } else if (mode === 'capabilities') {
        const elementType = typeof command.query.elementType === 'string'
          ? command.query.elementType
          : undefined
        const requestedOperations = command.query.operations === undefined
          ? undefined
          : Array.isArray(command.query.operations)
            ? command.query.operations.map((operation, index) => requiredText(operation, `operations[${index}]`))
            : (() => { throw new Error('operations 必须是字符串数组。') })()
        const capabilities = getSlidesCapabilities(elementType, requestedOperations)
        if (isRecord(command.query.presetContent) || typeof command.query.presetContentRef === 'string') {
          const content = {...presetDesignRef.current,...presetContentsRef.current.resolve(command.query.presetContent, command.query.presetContentRef)}
          if (typeof command.query.presetTheme === 'string') content.theme = command.query.presetTheme as PresetContent['theme']
          content.theme = resolvePresetTheme(content).id
          if (typeof command.query.presetRelation === 'string') {
            if (content.relation && content.relation !== command.query.presetRelation) throw new Error('候选关系与原始内容声明不一致，请先确认本页真实关系。')
            content.relation = command.query.presetRelation as PresetRelation
          }
          if (!content.role && typeof command.query.presetRole === 'string') content.role = command.query.presetRole
          const used = document.opened.deck.slides.flatMap((slide) => {
            const entry = presetHistoryRef.current.get(slideDurableId(slide))
            return entry && slide.elements.some((element) => matchesElementRef(element, entry.anchor)) ? [entry.presetId] : []
          })
          const provided = Array.isArray(command.query.usedPresetIds) ? command.query.usedPresetIds.filter((id): id is string => typeof id === 'string') : []
          const candidates = rankPresets(content, {
            family: typeof command.query.presetFamily === 'string' ? command.query.presetFamily : undefined,
            theme: typeof command.query.presetTheme === 'string' ? command.query.presetTheme : undefined,
            role: typeof command.query.presetRole === 'string' ? command.query.presetRole : undefined,
            relation: typeof command.query.presetRelation === 'string' ? command.query.presetRelation as PresetRelation : undefined,
            usedPresetIds: provided.length ? provided : used,
            limit: typeof command.query.presetLimit === 'number' ? command.query.presetLimit : undefined,
          })
          const presets: Array<Record<string,unknown>> = candidates.map(({preset,score,reasons})=>({id:preset.id,family:preset.family,theme:preset.theme,
            roles:preset.roles,relation:preset.relation,composition:preset.composition,capacity:preset.capacity,score,reasons}))
          const diagnostics = candidates.length ? [] : presetDiagnostics(content,
            typeof command.query.presetFamily === 'string' ? command.query.presetFamily : undefined, content.theme)
          result = {...capabilities, contentRef: presetContentsRef.current.register(content),presets,
            ...(diagnostics.length ? {presetDiagnostics:diagnostics} : {})}
        } else {
          const theme = typeof command.query.presetTheme === 'string' ? command.query.presetTheme : undefined
          result = {
            ...capabilities,
            presetRoles: PRESET_ROLES,
            presets: presetCatalog().filter((item) => !theme || item.theme === theme),
          }
        }
      } else if (mode === 'summary') {
        const elementCount = document.slides.reduce(
          (sum, slide) => sum + slide.nodes.filter((node) => !node.decoration && !!node.durableId).length,
          0,
        )
        const imageCount = document.slides.reduce(
          (sum, slide) => sum + slide.nodes.filter((node) => !node.decoration && node.type === 'picture').length,
          0,
        )
        result = {
          mode,
          documentType: 'slides',
          slideCount: document.slides.length,
          elementCount,
          slideWidthEmu: document.opened.deck.size.cx,
          slideHeightEmu: document.opened.deck.size.cy,
          imageCount,
        }
      } else if (mode === 'outline') {
        const limit = Math.max(1, Math.min(200, Number(command.query.limit) || 100))
        result = {
          mode,
          items: pageIndexes(command.query).slice(0, limit).map((index) => {
            const { elements: _elements, ...outlinePage } = page(index, false)
            return outlinePage
          }),
        }
      } else if (mode === 'search') {
        const text = requiredText(command.query.text, 'text').toLocaleLowerCase()
        const limit = Math.max(1, Math.min(100, Number(command.query.limit) || 20))
        const pages = pageIndexes(command.query).map((index) => page(index))
        result = {
          mode,
          matches: pages.flatMap((currentPage) => (
            (currentPage.elements as SlideElementView[]).map((element) => ({
              ...element,
              slideId: currentPage.id,
            }))
          ))
            .filter((element) => element.text.toLocaleLowerCase().includes(text))
            .slice(0, limit),
        }
      } else if (mode === 'slides') {
        const limit = Math.max(1, Math.min(100, Number(command.query.limit) || 20))
        const indexes = pageIndexes(command.query)
        const selectedElementIds = elementIdsForPages(command.query, indexes)
        const elementIds = selectedElementIds ? new Set(selectedElementIds) : undefined
        result = {
          mode,
          slides: indexes.slice(0, limit).map((index) => {
            const slide = document.slides[index]!
            const modelSlide = document.opened.deck.slides[index]!
            const elements = elementViews(slide, elementIds).map((element) => {
              const chart = command.query.includeData === false ? chartSummary(modelSlide, element)
                : element.type === 'chart' ? getChartElementData(modelSlide, element.id) : null
              const link = getElementLink(document.opened, index, element.id)
              return {
                ...element,
                ...(chart ? { chart } : {}),
                ...(link ? { link } : {}),
              }
            })
            const { elements: _unused, ...slideInfo } = page(index, false)
            return { ...slideInfo, elements }
          }),
        }
      } else if (mode === 'selection') {
        const index = Math.min(
          Math.max(selectionRef.current.slideIndex, 0),
          Math.max(0, document.slides.length - 1),
        )
        const slide = document.slides[index]
        const modelSlide = document.opened.deck.slides[index]
        const selectedIds = selectionRef.current.elementIds
        const selectedViews = slide && selectedIds.length > 0
          ? elementViews(slide, new Set(selectedIds))
          : []
        const elements = modelSlide
          ? selectedIds.flatMap((elementId) => {
              const element = selectedViews.find((candidate) => candidate.id === elementId)
              if (!element) return []
              const chart = chartSummary(modelSlide, element)
              const link = getElementLink(document.opened, index, element.id)
              return [{
                ...element,
                ...(chart ? { chart } : {}),
                ...(link ? { link } : {}),
              }]
            })
          : []
        result = {
          mode,
          documentType: 'slides',
          slideId: slide ? slideId(document, index) : null,
          elementIds: selectedIds,
          elements,
          slideWidth: slide?.widthPx ?? 0,
          slideHeight: slide?.heightPx ?? 0,
        }
      } else if (mode === 'review') {
        const pending = currentPendingVisualSlideIds(document)
        result = {
          mode,
          documentType: 'slides',
          pendingSlideIds: pending,
          warnings: reviewWarnings(document, slideIdsOf(document)),
        }
      } else if (mode === 'visual' && Array.isArray(command.query.slideIds) && command.query.slideIds.length) {
        if (command.query.slideIds.length > 12 || command.query.slideId || command.query.presetId || command.query.region || command.query.acceptWarnings || (Array.isArray(command.query.elementIds) && command.query.elementIds.length)) throw new Error('总览请只提供 1–12 个 slideIds；不能代替单页验收或接受警告。')
        const indexes = pageIndexes(command.query)
        const pages = indexes.map((index) => ({ id: slideId(document, index), slide: document.slides[index]! }))
        const captured = await captureContactSheet(pages, version, () => versionRef.current, command.query.columns === undefined ? 2 : Number(command.query.columns))
        result = { mode: 'visual', ...captured, target: 'overview', overview: true, slideIds: pages.map((p) => p.id),
          warnings: reviewWarnings(document, pages.map((p) => p.id)), pendingVisualSlideIds: currentPendingVisualSlideIds(document) }
      } else if (mode === 'visual' && command.query.presetId) {
        const content = presetContentsRef.current.resolve(command.query.presetContent, command.query.presetContentRef)
        if (command.query.acceptWarnings || command.query.region || (Array.isArray(command.query.elementIds) && command.query.elementIds.length)) throw new Error('预设候选只支持整页预览，不能接受当前文档的审核提示。')
        const scratch = await openSlidesDocument(await snapshotSlidesDocument(document.opened)())
        const blank = runTxn(scratch.opened, { isolation: 'atomic', ops: [{op:'addBlankSlide',target:{slide:0}}] })
        if (!blank.applied) throw new Error('无法创建临时预览页。')
        const prepared = refreshSlidesDocument(scratch)
        const target = slideId(prepared,1)
        const operation = await preparePresetImage({op:'slide_add_preset',payload:{
          slideId:target,presetId:command.query.presetId,content,
        }})
        const translated = translateOperation(prepared,operation)
        const outcome = runTxn(prepared.opened,{isolation:'atomic',ops:translated.ops ?? []})
        if (!outcome.applied) throw new Error(outcome.failures?.map((f)=>f.error).join('\n') || '预设预览失败。')
        for (const pending of translated.preset?.pendingChartStyles ?? []) {
          const position=translated.preset!.roles.indexOf(pending.role)
          const id=outcome.records?.[position]?.created?.[0]
          if (!id) throw new Error('预览图表缺少稳定 ID。')
          const styled=translateOperation(prepared,{op:'slide_set_chart_style',payload:{slideId:target,elementId:id,style:pending.style}})
          const applied=runTxn(prepared.opened,{isolation:'atomic',ops:styled.op ? [styled.op] : []})
          if (!applied.applied) throw new Error('预览图表主题无法应用。')
        }
        const rendered=refreshSlidesDocument(prepared).slides[1]!
        const captured=await captureSlide(rendered,version,()=>versionRef.current)
        result={mode:'visual',...captured,target:`preset:${String(command.query.presetId)}`,
          warnings:slideLayoutWarnings(rendered,slideElementIds(rendered))}
      } else if (mode === 'visual') {
        const requestedSlideId = command.query.slideId === undefined || command.query.slideId === null
          ? null
          : requiredText(command.query.slideId, 'slideId')
        const index = requestedSlideId
          ? slideIndex(document, requestedSlideId)
          : Math.min(Math.max(selectionRef.current.slideIndex, 0), document.slides.length - 1)
        const targetSlide = document.slides[index]
        if (!targetSlide) throw new Error('找不到要检查的幻灯片。')
        const target = slideId(document, index)
        if (!sameVersion(versionRef.current, version)) {
          throw new VisualVersionConflict('检查画面前文档已变化，请重新读取后检查。')
        }
        const selectedElementIds = elementIdsForPages(command.query, [index])
        const elementIds = selectedElementIds
        const region = isRecord(command.query.region)
          ? {
              x: Number(command.query.region.x),
              y: Number(command.query.region.y),
              width: Number(command.query.region.width),
              height: Number(command.query.region.height),
            }
          : undefined
        const padding = command.query.padding === undefined ? undefined : Number(command.query.padding)
        const captureOptions = {
          ...(elementIds ? { elementIds } : {}),
          ...(region ? { region } : {}),
          ...(padding === undefined ? {} : { padding }),
        }
        const fullPage = !elementIds && !region
        const acceptWarnings = command.query.acceptWarnings === true
        const reviewReason = typeof command.query.reviewReason === 'string' ? command.query.reviewReason.trim() : ''
        const observationKey = `${session.sessionId}/${target}`
        if (acceptWarnings && (!fullPage || !reviewReason
          || !sameVersion(observedSlideVersionsRef.current.get(observationKey) ?? null, version))) {
          throw new Error('接受设计提示前请先查看当前版本的整页画面，并通过 reviewReason 说明保留理由；局部截图不能代替整页检查。')
        }
        const captured = Object.keys(captureOptions).length > 0
          ? await captureSlide(targetSlide, version, () => versionRef.current, captureOptions)
          : await captureSlide(targetSlide, version, () => versionRef.current)
        if (!sameVersion(versionRef.current, version)) {
          throw new VisualVersionConflict('检查画面时文档已变化，请重新检查。')
        }
        const warnings = slideLayoutWarnings(targetSlide, slideElementIds(targetSlide))
        if (fullPage) observedSlideVersionsRef.current.set(observationKey, { ...version })
        if (fullPage && !warnings.some(isBlockingLayoutWarning) && (warnings.length === 0 || acceptWarnings)) {
          clearSlidePending(reviewStateRef.current, target, slideIdsOf(document))
        }
        result = {
          mode,
          dataUrl: captured.dataUrl,
          width: captured.width,
          height: captured.height,
          target,
          warnings,
          ...(acceptWarnings ? { reviewReason } : {}),
          pendingVisualSlideIds: currentPendingVisualSlideIds(document),
        }
      } else {
        throw new Error(`幻灯片不支持此检查模式：${String(mode)}`)
      }
      bridgeRef.current?.post({
        type: 'office_inspect_result',
        result: { ok: true, requestId: command.requestId, sessionId: session.sessionId, version, result },
      })
    } catch (reason) {
      const conflict = reason instanceof VisualVersionConflict
      bridgeRef.current?.post({
        type: 'office_inspect_result',
        result: {
          ok: false,
          requestId: command.requestId,
          sessionId: session.sessionId,
          currentVersion: version,
          error: {
            code: conflict ? 'VERSION_CONFLICT' : 'INVALID_OPERATION',
            message: reason instanceof Error ? reason.message : '无法读取幻灯片。',
            retryable: conflict,
          },
        },
      })
    }
  }

  async function apply(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.sessionId !== 'string'
      || typeof value.operationId !== 'string' || !isVersion(value.expectedVersion)
      || !Array.isArray(value.operations)) return
    const command = value as unknown as SlidesCommand
    const session = sessionRef.current
    const currentVersion = versionRef.current
    const document = documentRef.current
    if (!session || !currentVersion || !document || command.sessionId !== session.sessionId) return
    const fingerprint = JSON.stringify(command)
    const cached = operationCacheRef.current.get(command.operationId)
    if (cached) {
      if (cached.fingerprint === fingerprint) bridgeRef.current?.post({ type: 'office_command_result', result: cached.result })
      return
    }
    if (!sameVersion(currentVersion, command.expectedVersion)) {
      const result = {
        ok: false,
        sessionId: session.sessionId,
        operationId: command.operationId,
        currentVersion,
        changedTargets: [],
        error: { code: 'VERSION_CONFLICT', message: '幻灯片已发生变化，请重新读取相关页面。', retryable: true },
      }
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
      return
    }
    if (command.operations.length === 0 || command.operations.length > 50) return
    let before: SlidesSnapshot | undefined
    try {
      const resolved = command.operations.map((operation) => {
        if (operation.op !== 'slide_add_preset' || !isRecord(operation.payload)) return operation
        const {contentRef, content, ...payload} = operation.payload
        const explicitPreset = typeof payload.presetId === 'string' ? findPreset(payload.presetId) : undefined
        const canonical = {...presetDesignRef.current,...(explicitPreset ? {theme:explicitPreset.theme} : {}),
          ...presetContentsRef.current.resolve(content,contentRef)}
        canonical.theme = resolvePresetTheme(canonical).id
        const presetId = payload.presetId === undefined || payload.presetId === 'auto'
          ? rankPresets(canonical,{theme:canonical.theme,usedPresetIds:[...presetHistoryRef.current.values()].map((entry)=>entry.presetId),limit:1})[0]?.preset.id ?? 'auto'
          : payload.presetId
        return {...operation, payload:{...payload,presetId,content:canonical}}
      })
      const preparedOperations = await Promise.all(resolved.map(preparePresetImage))
      if (!sameVersion(versionRef.current, currentVersion)) throw new VisualVersionConflict('准备素材时文档已变化，请重新读取后编辑。')
      const translated = preparedOperations.map((operation) => translateOperation(document, operation))
      const ops: Op[] = []
      const presetPlans: Array<NonNullable<ReturnType<typeof translateOperation>['preset']> & {opOffset:number}> = []
      const chartStyles: NonNullable<ReturnType<typeof translateOperation>['chartStyles']> = []
      for (const item of translated) {
        const itemOps = item.ops ?? (item.op ? [item.op] : [])
        if (item.preset) presetPlans.push({ ...item.preset, opOffset: ops.length })
        for (const pending of item.chartStyles ?? []) chartStyles.push({ ...pending, opOffset: ops.length + pending.opOffset })
        ops.push(...itemOps)
      }
      for (const plan of presetPlans) for (const pending of plan.pendingChartStyles) {
        chartStyles.push({ opOffset: plan.opOffset + plan.roles.indexOf(pending.role), slideId: plan.slideId, style: pending.style })
      }
      const hasDesign = command.operations.some((operation) => operation.op === 'slide_add_design')
      // Public requests stay bounded at 50; vetted semantic components expand internally.
      const limit = hasDesign ? 256 : 50
      const rawCount = translated.reduce((sum, item, index) => sum + (command.operations[index]!.op === 'slide_add_design' ? 0
        : (item.ops?.length ?? (item.op ? 1 : 0)) + (item.chartStyles?.length ?? 0) + (item.preset?.pendingChartStyles.length ?? 0)), 0)
      if (ops.length === 0 || rawCount > 50 || ops.length + chartStyles.length > limit) throw new Error(`单次事务最多 50 个原始操作，设计组件展开后最多 ${limit} 个操作；请按页或区域提交。`)
      const paths = affectedSlidePaths(document, ops)
      before = takeSnapshot(document, paths)
      const outcome = runTxn(document.opened, { isolation: 'atomic', ops })
      if (!outcome.applied) throw new Error(outcome.failures?.map((failure) => failure.error).join('\n') || '幻灯片事务失败。')
      const presetElementIds = new Map<string,string>()
      for (const plan of presetPlans) {
        const slide = document.opened.deck.slides[slideIndex(document,plan.slideId)]!
        plan.roles.forEach((_role,position) => {
          const created = outcome.records?.[plan.opOffset+position]?.created?.[0]
          const element = created ? slide.elements.find((item)=>matchesElementRef(item,created)) : undefined
          if (created && element) presetElementIds.set(`${plan.slideId}/${created}`,elementDurableId(element) ?? created)
        })
      }
      const styleOps = chartStyles.flatMap((pending) => {
        const created = outcome.records?.[pending.opOffset]?.created?.[0]
        const slide = document.opened.deck.slides[slideIndex(document, pending.slideId)]!
        const element = created ? slide.elements.find((item) => matchesElementRef(item, created)) : undefined
        // New native nodes receive durable IDs during refresh; the engine's
        // returned ID is authoritative inside this uncommitted transaction.
        const elementId = element ? elementDurableId(element) ?? created : undefined
        if (!elementId) throw new Error(`第 ${pending.opOffset + 1} 个操作的图表 ${created ?? '(无 ID)'} 无法在页面 ${pending.slideId} 定位，已取消本页写入。`)
        const styled = translateOperation(document, { op: 'slide_set_chart_style', payload: { slideId: pending.slideId, elementId, style: pending.style } })
        return styled.op ? [styled.op] : []
      })
      if (styleOps.length) {
        const result = runTxn(document.opened, { isolation: 'atomic', ops: styleOps })
        if (!result.applied) throw new Error(`图表样式应用失败，已取消本页写入：${result.failures?.map((failure) => failure.error).join('；') ?? ''}`)
      }
      if (unchangedDocument(document, before)) {
        await displayDocument(restoreSnapshot(document, before))
        const result = {
          ok: true, sessionId: session.sessionId, operationId: command.operationId,
          version: currentVersion, changedTargets: [], unchanged: true,
          createdSlides: [],
          pendingVisualSlideIds: currentPendingVisualSlideIds(document),
          summary: '文档已经是请求的状态，没有产生新的修改。',
        }
        operationCacheRef.current.set(command.operationId, { fingerprint, result })
        bridgeRef.current?.post({ type: 'office_command_result', result })
        return
      }
      undoRef.current.push(before)
      if (undoRef.current.length > 32) undoRef.current.shift()
      redoRef.current = []
      dirtyRef.current = true
      const refreshed = refreshSlidesDocument(document, FIT_WIDTH, paths)
      await displayDocument(refreshed)
      const version = { ...currentVersion, modelRevision: currentVersion.modelRevision + 1 }
      versionRef.current = version
      rememberFile(version, refreshed)
      notifyHistory()
      updateReviewAfterMutation(refreshed, before, ops, outcome.records)
      const createdElements: SlideElementView[] = []
      const updatedElements: SlideElementView[] = []
      const warnings: string[] = []
      for (const [index, slide] of refreshed.opened.deck.slides.entries()) {
        if (paths && !paths.has(slide.path)) continue
        const previous = before.deck.slides.find((item) => item.path === slide.path)
        const previousElements = new Map(previous?.elements.map((element) => [elementDurableId(element), element]) ?? [])
        const requested = new Set(ops.filter((op) => op.target?.slide === slideDurableId(slide) || op.target?.slide === index)
          .map((op) => op.target?.el))
        for (const record of outcome.records ?? []) {
          if (record.slideId !== slideDurableId(slide) || record.op.op !== 'monaReplaceColors' || !isRecord(record.after)) continue
          for (const id of Array.isArray(record.after.elementIds) ? record.after.elementIds : []) requested.add(String(id))
        }
        const changed = new Set<string>()
        for (const view of elementViews(refreshed.slides[index]!)) {
          const old = previousElements.get(view.id)
          const current = slide.elements.find((item) => matchesElementRef(item, view.id))!
          if (old && !requested.has(view.id) && !requested.has(current.id)
            && patchedElementXml(old) === patchedElementXml(current)) continue
          changed.add(view.id)
          view.slideId = slideDurableId(slide)
          if (view.type === 'chart') {
            const chart = getChartElementData(slide, view.id)
            if (chart) view.chart = {
              textStyle: chart.textStyle, axisTextStyles: chart.axisTextStyles,
              supportedTextStyleFields: chart.supportedTextStyleFields,
            }
          }
          if (old) updatedElements.push(view)
          else createdElements.push(view)
        }
        warnings.push(...slideLayoutWarnings(refreshed.slides[index]!, changed))
      }
      // 预设的局部角色与实际创建 ID 一一对应（原子事务里 records 与 ops 同序）；
      // 系列色等只能创建后应用的样式在这里以真实 ID 交回，不假造元素 ID。
      const durableIdOf = (createdId: string): string => {
        for (const slide of refreshed.opened.deck.slides) {
          const element = slide.elements.find((item) => matchesElementRef(item, createdId))
          if (element) return elementDurableId(element) ?? createdId
        }
        return createdId
      }
      const presetPages = presetPlans.map((plan) => {
        const elements: Record<string, string> = {}
        plan.roles.forEach((role, position) => {
          const created = outcome.records?.[plan.opOffset + position]?.created?.[0]
          if (created) elements[role] = presetElementIds.get(`${plan.slideId}/${created}`) ?? durableIdOf(created)
        })
        const anchor = Object.values(elements)[0]
        if (anchor) presetHistoryRef.current.set(plan.slideId, {presetId:plan.presetId,anchor})
        presetDesignRef.current = plan.design
        return {
          presetId: plan.presetId,
          slideId: plan.slideId,
          roles: plan.roles,
          elements,
          pendingChartStyles: [],
        }
      })
      const result = {
        ok: true,
        sessionId: session.sessionId,
        operationId: command.operationId,
        version,
        changedTargets: [...new Set(translated.flatMap((item) => item.targets))],
        createdElements,
        createdSlides: createdSlidesOf(before, refreshed),
        updatedElements,
        warnings,
        ...(command.operations.some((op) => op.op === 'slide_replace_colors') ? {
          colorChanges: (outcome.records ?? []).filter((r) => r.op.op === 'monaReplaceColors').map((r) => ({ slideId: r.slideId, ...(isRecord(r.after) ? r.after : {}) })),
        } : {}),
        ...(presetPages.length ? { presetPages } : {}),
        pendingVisualSlideIds: currentPendingVisualSlideIds(refreshed),
        summary: `已完成 ${command.operations.length} 项幻灯片修改`,
      }
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
    } catch (reason) {
      if (before) await displayDocument(restoreSnapshot(document, before))
      const conflict = reason instanceof VisualVersionConflict
      const result = {
        ok: false,
        sessionId: session.sessionId,
        operationId: command.operationId,
        currentVersion: conflict ? versionRef.current : currentVersion,
        changedTargets: [],
        error: {
          code: conflict ? 'VERSION_CONFLICT' : 'INVALID_OPERATION',
          message: reason instanceof Error ? reason.message : '幻灯片修改失败。',
          retryable: conflict,
        },
      }
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
    }
  }

  async function applyUserOperations(
    operations: Op[],
    changedTargets: string[],
    beforeOverride?: SlidesSnapshot,
    isolation: 'atomic' | 'per_op' = 'atomic',
  ): Promise<SlidesDocument | null> {
    const document = documentRef.current
    const session = sessionRef.current
    const currentVersion = versionRef.current
    if (!document || !session || !currentVersion || operations.length === 0) return null
    const paths = beforeOverride?.paths ?? affectedSlidePaths(document, operations)
    const before = beforeOverride ?? takeSnapshot(document, paths)
    const outcome = runTxn(document.opened, { isolation, ops: operations })
    if (!outcome.applied) {
      setError(outcome.failures?.map((failure) => failure.error).join('\n') || '幻灯片修改失败。')
      return null
    }
    undoRef.current.push(before)
    if (undoRef.current.length > 32) undoRef.current.shift()
    redoRef.current = []
    dirtyRef.current = true
    const refreshed = refreshSlidesDocument(document, FIT_WIDTH, beforeOverride ? undefined : paths)
    await displayDocument(refreshed)
    const version = { ...currentVersion, modelRevision: currentVersion.modelRevision + 1 }
    versionRef.current = version
    rememberFile(version, refreshed)
    notifyHistory()
    updateReviewAfterMutation(refreshed, before, operations, outcome.records)
    postWithPendingReview({
      type: 'office_user_change',
      sessionId: session.sessionId,
      version,
      changedTargets,
    })
    return refreshed
  }

  async function restoreHistory(from: SlidesSnapshot[], to: SlidesSnapshot[]): Promise<void> {
    const document = documentRef.current
    const session = sessionRef.current
    const currentVersion = versionRef.current
    const snapshot = from.pop()
    if (!document || !session || !currentVersion || !snapshot) return
    to.push(takeSnapshot(document))
    const restored = restoreSnapshot(document, snapshot)
    await displayDocument(restored)
    const version = { ...currentVersion, modelRevision: currentVersion.modelRevision + 1 }
    versionRef.current = version
    rememberFile(version, restored)
    dirtyRef.current = true
    const currentSlideIds = slideIdsOf(restored)
    markSlidesPending(reviewStateRef.current, currentSlideIds, currentSlideIds, {
      allSlides: true,
      requiresVisual: true,
    })
    notifyHistory()
    postWithPendingReview({
      type: 'office_user_change',
      sessionId: session.sessionId,
      version,
      changedTargets: [slideId(restored, 0)],
    })
  }

  const slidesApi = useMemo<SlidesApi>(() => {
    const slideAfter = (document: SlidesDocument | null, index: number): RenderSlide | null => (
      document?.slides[index] ?? null
    )
    const renderMasterPart = (partPath: string, fitWidthPx = FIT_WIDTH): RenderSlide | null => {
      const document = documentRef.current
      if (!document) return null
      const slide = parseMasterPart(document.opened.archive, partPath)
      if (!slide) return null
      masterPartRef.current = partPath
      return buildRenderSlide(slide, document.opened.deck.size, {
        fitWidthPx,
        media: (path) => document.media.get(path),
      })
    }
    const base: Partial<SlidesApi> = {
      getLanguage: async () => 'zh',
      onLanguageChanged: () => () => undefined,
      getTheme: async () => 'system',
      onThemeChanged: () => () => undefined,
      onChromePressed: () => () => undefined,
      setShowFullScreen: async () => undefined,
      openPptx: async () => {
        setError('请使用 Mona 顶部的“+”打开演示文稿。')
        return null
      },
      openPptxPath: async () => {
        setError('请从 Mona 文件列表打开演示文稿。')
        return null
      },
      newBlank: async () => {
        const document = documentRef.current
        if (!document) throw new Error('请先由 Mona 创建演示文稿。')
        setError('请使用 Mona 顶部的“+”新建演示文稿。')
        return asOpenResult(document)
      },
      consumePendingOpen: async () => new Promise<OpenResult>((resolve) => {
        const document = documentRef.current
        if (document) {
          openedInGenOfficeRef.current = true
          resolve(asOpenResult(document))
        } else {
          pendingOpenResolversRef.current.push(resolve)
        }
      }),
      onOpened: (listener) => {
        openedListenersRef.current.add(listener)
        return () => openedListenersRef.current.delete(listener)
      },
      onRenamed: () => () => undefined,
      privateFontFaces: async () => [],
      privateFontData: async () => null,
      fontCatalog: async () => [],
      fontDownload: async () => ({ ok: false }),
      fontInstallLocal: async () => ({ families: [] }),
      fontMissing: async () => [],
      onFontsChanged: () => () => undefined,
      clipboardProbe: async () => !!elementClipboardRef.current?.items.length || slideClipboardRef.current !== null,
      clipboardExternal: async () => elementClipboardRef.current?.items.length
        ? { kind: 'internal' }
        : slideClipboardRef.current
          ? { kind: 'slide' }
          : { kind: 'none' },
      hasSlideClipboard: async () => slideClipboardRef.current !== null,
      getRenderSlides: async () => documentRef.current?.slides ?? null,
      getSlideSize: async () => documentRef.current?.opened.deck.size ?? null,
      getRecentFiles: async () => [],
      getAiSettings: async () => ({ provider: 'anthropic', providers: {} } as never),
      setAiSettings: async () => undefined,
      cloudGenStatus: async () => ({ enabled: false }),
      presenterStart: async () => ({ audience: false }),
      presenterSync: () => undefined,
      presenterInk: () => undefined,
      presenterSwap: async () => false,
      presenterEnd: async () => undefined,
      audienceReady: async () => null,
      audienceNav: () => undefined,
      onShowSync: () => () => undefined,
      onShowInk: () => () => undefined,
      onAudienceNav: () => () => undefined,
      insertMedia: async () => {
        setError('音视频插入需要接入 Mona 系统文件选择与媒体预览，当前未开放。')
        return null
      },
      addMediaBytes: async () => {
        setError('媒体字节插入尚未开放。')
        return null
      },
      getMediaData: async () => null,
      insertModel3d: async () => {
        setError('3D 模型的系统缩略图依赖桌面能力，当前未开放。')
        return null
      },
      pickExportDir: async () => {
        setError('请使用 Mona 顶部导出功能。')
        return null
      },
      pickExportPdfPath: async () => {
        setError('PDF 导出需要接入 Mona 桌面打印能力，当前未开放。')
        return null
      },
      printSlides: async () => ({ ok: false, error: '系统打印需要接入 Mona 桌面打印能力。' }),
      getTransition: async (slideIndex) => {
        const slide = documentRef.current?.opened.deck.slides[slideIndex]
        return slide ? getSlideTransition(slide) : 'none'
      },
      setTransition: async (op) => {
        const document = documentRef.current
        if (!document) return false
        const indexes = op.slideIndex === -1
          ? document.slides.map((_slide, index) => index)
          : [op.slideIndex]
        const operations = indexes.map((index) => ({
          op: 'setTransition',
          target: { slide: slideId(document, index) },
          kind: op.kind,
        }))
        const updated = await applyUserOperations(operations, indexes.map((index) => slideId(document, index)))
        if (!updated) return false
        for (const index of indexes) transitionsRef.current.set(index, op.kind)
        return true
      },
      setAdvanceTimes: async (op) => {
        const document = documentRef.current
        if (!document || op.times.length === 0) return false
        const operations = op.times.map((item) => ({
          op: 'setAdvanceTime',
          target: { slide: slideId(document, item.slideIndex) },
          ms: item.ms,
        }))
        return !!(await applyUserOperations(
          operations,
          op.times.map((item) => slideId(document, item.slideIndex)),
        ))
      },
      getAnimations: async (slideIndex) => {
        const slide = documentRef.current?.opened.deck.slides[slideIndex]
        if (!slide) return []
        const bySpid = new Map(slide.elements.map((element) => [elementSpid(element), element]))
        return getSlideAnimations(slide).flatMap((animation) => {
          const element = bySpid.get(animation.spid)
          if (!element) return []
          return [{
            sourceId: element.id,
            targetName: element.name || slideElementTypeLabel(element.type),
            effect: animation.effect,
            trigger: animation.trigger,
            durationMs: animation.durationMs,
            delayMs: animation.delayMs,
            ...(animation.motionPath == null ? {} : { motionPath: animation.motionPath }),
            ...(animation.paragraph == null ? {} : { paragraph: animation.paragraph }),
          }]
        })
      },
      setAnimations: async (op) => {
        const document = documentRef.current
        if (!document) return false
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setAnimations',
          target: { slide: sid },
          items: op.items,
        }], [sid])
        if (!updated) return false
        animationsRef.current.set(op.slideIndex, op.items.map((item) => ({
          ...item,
          targetName: item.sourceId,
        })))
        return true
      },
      getShapeKeys: async (slideIndex) => {
        const slide = documentRef.current?.opened.deck.slides[slideIndex]
        return slide?.elements.map((element) => ({
          sourceId: element.id,
          spid: elementSpid(element),
          name: element.name ?? '',
        })) ?? []
      },
      getSections: async () => documentRef.current ? getSections(documentRef.current.opened) : [],
      setSections: async (sections) => {
        const updated = await applyUserOperations([{ op: 'setSections', sections }], ['document:sections'])
        return updated ? getSections(updated.opened) : null
      },
      addSection: async (op) => {
        const updated = await applyUserOperations([{
          op: 'addSection',
          atSlideIndex: op.atSlideIndex,
          name: op.name,
        }], ['document:sections'])
        return updated ? getSections(updated.opened) : null
      },
      renameSection: async (op) => {
        const updated = await applyUserOperations([{
          op: 'renameSection',
          id: op.id,
          name: op.name,
        }], ['document:sections'])
        return updated ? getSections(updated.opened) : null
      },
      removeSection: async (op) => {
        const updated = await applyUserOperations([{ op: 'removeSection', id: op.id }], ['document:sections'])
        return updated ? getSections(updated.opened) : null
      },
      moveSection: async (op) => {
        const updated = await applyUserOperations([{
          op: 'moveSection',
          id: op.id,
          dir: op.dir,
        }], ['document:sections'])
        return updated ? { slides: updated.slides, sections: getSections(updated.opened) } : null
      },
      getNotes: async (slideIndex) => {
        const document = documentRef.current
        const slide = document?.opened.deck.slides[slideIndex]
        return document && slide ? getSlideNotes(document.opened.archive, slide.path) : ''
      },
      setNotes: async (op) => {
        const document = documentRef.current
        if (!document) return false
        const sid = slideId(document, op.slideIndex)
        return !!(await applyUserOperations([{
          op: 'setNotes',
          target: { slide: sid },
          text: op.text,
        }], [sid]))
      },
      getComments: async (slideIndex) => {
        const document = documentRef.current
        const slide = document?.opened.deck.slides[slideIndex]
        return document && slide ? getSlideComments(document.opened.archive, slide.path) : []
      },
      addComment: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'addComment',
          target: { slide: sid },
          author: 'Mona 用户',
          text: op.text,
        }], [sid])
        const slide = updated?.opened.deck.slides[op.slideIndex]
        return updated && slide ? getSlideComments(updated.opened.archive, slide.path) : null
      },
      deleteComment: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'deleteComment',
          target: { slide: sid },
          authorId: op.authorId,
          idx: op.idx,
        }], [sid])
        const slide = updated?.opened.deck.slides[op.slideIndex]
        return updated && slide ? getSlideComments(updated.opened.archive, slide.path) : null
      },
      isDirty: async () => dirtyRef.current,
      setAutoSavePref: () => undefined,
      onCloseSaveRequest: () => () => undefined,
      reportCloseSaveResult: () => undefined,
      onHistoryChanged: (listener) => {
        historyListenersRef.current.add(listener)
        listener({ canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0 })
        return () => historyListenersRef.current.delete(listener)
      },
      onDeckChanged: (listener) => {
        deckListenersRef.current.add(listener)
        return () => deckListenersRef.current.delete(listener)
      },
      onMenuCommand: () => () => undefined,
      nativeClipboard: async (operation) => {
        document.execCommand(operation)
      },
      applyTxn: async (request) => {
        const current = documentRef.current
        const session = sessionRef.current
        const currentVersion = versionRef.current
        const operations = Array.isArray(request.ops) ? request.ops as Op[] : []
        if (!current || !session || !currentVersion || operations.length === 0 || operations.length > 50) {
          return null
        }
        if (request.dryRun) {
          const preview = runTxn(current.opened, {
            ops: operations,
            isolation: request.isolation === 'per_op' ? 'per_op' : 'atomic',
            dryRun: true,
          })
          return {
            applied: preview.applied,
            dryRun: true,
            plan: preview.plan,
            failures: preview.failures,
          }
        }
        const before = takeSnapshot(current)
        const outcome = runTxn(current.opened, {
          ops: operations,
          isolation: request.isolation === 'per_op' ? 'per_op' : 'atomic',
        })
        if (!outcome.applied) return { applied: false, failures: outcome.failures }
        undoRef.current.push(before)
        redoRef.current = []
        dirtyRef.current = true
        const refreshed = refreshSlidesDocument(current, FIT_WIDTH)
        await displayDocument(refreshed)
        const version = { ...currentVersion, modelRevision: currentVersion.modelRevision + 1 }
        versionRef.current = version
        rememberFile(version, refreshed)
        updateReviewAfterMutation(refreshed, before, operations, outcome.records)
        notifyHistory()
        const changedTargets = operations.map((operation) => {
          const slide = operation.target?.slide
          const element = operation.target?.el
          return element == null ? String(slide ?? 'document') : `${String(slide)}/${element}`
        })
        postWithPendingReview({
          type: 'office_user_change',
          sessionId: session.sessionId,
          version,
          changedTargets,
        })
        return {
          applied: true,
          failures: outcome.failures,
          records: outcome.records?.map((record) => ({
            op: record.op.op,
            target: record.op.target ? JSON.stringify(record.op.target) : undefined,
            created: record.created,
          })),
          slides: refreshed.slides,
        }
      },
      editText: async (op: EditTextOp) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setText',
          target: { slide: sid, el: op.sourceId },
          paragraphs: op.paragraphs,
          ...(op.groupId ? { group: op.groupId } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setElementFont: async (op: SetElementFontOp) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations(op.sourceIds.map((sourceId) => ({
          op: 'setFont',
          target: { slide: sid, el: sourceId },
          font: {
            fontFamily: op.fontFamily,
            fontSizePt: op.fontSizePt,
            bold: op.bold,
            italic: op.italic,
            underline: op.underline,
            strike: op.strike,
            color: op.color,
          },
          ...(op.groupId ? { group: op.groupId } : {}),
        })), op.sourceIds.map((sourceId) => `${sid}/${sourceId}`), undefined, 'per_op')
        return slideAfter(updated, op.slideIndex)
      },
      setElementParagraphFormat: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations(op.sourceIds.map((sourceId) => ({
          op: 'setParagraphFormat',
          target: { slide: sid, el: sourceId },
          format: {
            bullet: op.bullet,
            bulletChar: op.bulletChar,
            bulletHangEmu: op.bulletHangEmu,
            bulletSizePct: op.bulletSizePct,
            bulletColor: op.bulletColor,
            lineSpacingPct: op.lineSpacingPct,
            spaceBeforePt: op.spaceBeforePt,
            spaceAfterPt: op.spaceAfterPt,
            align: op.align,
            indentDelta: op.indentDelta,
          },
          ...(op.groupId ? { group: op.groupId } : {}),
        })), op.sourceIds.map((sourceId) => `${sid}/${sourceId}`), undefined, 'per_op')
        return slideAfter(updated, op.slideIndex)
      },
      editTransform: async (op: EditTransformOp) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const box = operationBox(document, {
          slideId: sid,
          elementId: op.sourceId,
          x: op.xPx,
          y: op.yPx,
          width: op.wPx,
          height: op.hPx,
        })
        const operation = {
          op: 'setTransform',
          target: { slide: sid, el: op.sourceId },
          box,
          rotDeg: op.rotationDeg,
          resizeTableGrid: true,
          ...(op.groupId ? { group: op.groupId } : {}),
        }
        const previewKey = `${sid}/${op.groupId ?? ''}/${op.sourceId}`
        if (op.preview) {
          if (!transformPreviewRef.current.has(previewKey)) {
            transformPreviewRef.current.set(previewKey, takeSnapshot(document))
          }
          const outcome = runTxn(document.opened, { isolation: 'atomic', ops: [operation] })
          if (!outcome.applied) return null
          const preview = refreshSlidesDocument(document, FIT_WIDTH)
          await displayDocument(preview)
          return slideAfter(preview, op.slideIndex)
        }
        const before = transformPreviewRef.current.get(previewKey)
        transformPreviewRef.current.delete(previewKey)
        const updated = await applyUserOperations([operation], [`${sid}/${op.sourceId}`], before)
        return slideAfter(updated, op.slideIndex)
      },
      batchEditTransform: async (op) => {
        const document = documentRef.current
        if (!document || op.items.length === 0) return null
        const sid = slideId(document, op.slideIndex)
        const operations = op.items.map((item) => ({
          op: 'setTransform',
          target: { slide: sid, el: item.sourceId },
          box: operationBox(document, {
            slideId: sid,
            elementId: item.sourceId,
            x: item.xPx,
            y: item.yPx,
            width: item.wPx,
            height: item.hPx,
          }),
          rotDeg: item.rotationDeg,
        }))
        const updated = await applyUserOperations(
          operations,
          op.items.map((item) => `${sid}/${item.sourceId}`),
        )
        return slideAfter(updated, op.slideIndex)
      },
      editConnectorEndpoints: async (op) => {
        const document = documentRef.current
        const slide = document?.slides[op.slideIndex]
        if (!document || !slide) return null
        const sid = slideId(document, op.slideIndex)
        const scaleX = document.opened.deck.size.cx / slide.widthPx
        const scaleY = document.opened.deck.size.cy / slide.heightPx
        const updated = await applyUserOperations([{
          op: 'setConnectorEndpoints',
          target: { slide: sid, el: op.sourceId },
          p1: { x: Math.round(op.x1Px * scaleX), y: Math.round(op.y1Px * scaleY) },
          p2: { x: Math.round(op.x2Px * scaleX), y: Math.round(op.y2Px * scaleY) },
          start: op.start,
          end: op.end,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editFill: async (op: EditFillOp) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const fill = typeof op.fill === 'string'
          ? op.fill
          : {
              stops: op.fill.gradient.stops ?? [
                { pos: 0, color: op.fill.gradient.from },
                { pos: 1, color: op.fill.gradient.to },
              ],
              ...(op.fill.gradient.path || op.fill.gradient.radial
                ? {
                    path: op.fill.gradient.path ?? 'circle',
                    ...(op.fill.gradient.center
                      ? {
                          fillTo: {
                            l: op.fill.gradient.center.x,
                            t: op.fill.gradient.center.y,
                            r: 1 - op.fill.gradient.center.x,
                            b: 1 - op.fill.gradient.center.y,
                          },
                        }
                      : {}),
                  }
                : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) }),
            }
        const updated = await applyUserOperations([{
          op: 'setFill',
          target: { slide: sid, el: op.sourceId },
          fill,
          ...(op.groupId ? { group: op.groupId } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editStroke: async (op: EditStrokeOp) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const stroke = op.stroke ? {
          color: op.stroke.color,
          widthEmu: Math.round(op.stroke.widthPt * 12700),
          ...(op.stroke.dash ? { dash: op.stroke.dash } : {}),
          ...(op.stroke.cap ? { cap: op.stroke.cap } : {}),
          ...(op.stroke.join ? { join: op.stroke.join } : {}),
          ...(op.stroke.compound ? { compound: op.stroke.compound } : {}),
          ...(op.stroke.gradient ? {
            gradient: {
              stops: op.stroke.gradient.stops,
              angle: Math.round(op.stroke.gradient.angleDeg * 60000),
            },
          } : {}),
        } : null
        const updated = await applyUserOperations([{
          op: 'setStroke',
          target: { slide: sid, el: op.sourceId },
          stroke,
          ...(op.groupId ? { group: op.groupId } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      deleteElement: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'deleteElement',
          target: { slide: sid, el: op.sourceId },
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      addElement: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const offset = operationBox(document, {
          slideId: sid,
          x: op.xPx,
          y: op.yPx,
          width: op.wPx,
          height: op.hPx,
        })
        const paragraphs = op.paragraphs?.length
          ? op.paragraphs
          : op.text
            ? op.text.split('\n').map((text) => ({ runs: [{ text }] }))
            : undefined
        const updated = await applyUserOperations([{
          op: 'addElement',
          target: { slide: sid },
          kind: op.kind,
          offset,
          ...(paragraphs ? { paragraphs } : {}),
          ...(op.fillColor ? { fill: op.fillColor } : {}),
          ...(op.stroke ? {
            stroke: { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * 12700) },
          } : {}),
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      addTable: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const offset = operationBox(document, {
          slideId: sid,
          x: op.xPx,
          y: op.yPx,
          width: op.wPx,
          height: op.hPx,
        })
        const updated = await applyUserOperations([{
          op: 'addTable',
          target: { slide: sid },
          rows: op.rows,
          cols: op.cols,
          offset,
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      addChart: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const updated = await applyUserOperations([{
          op: 'addChart',
          target: { slide: sid },
          kind: op.kind === 'barH' ? 'bar' : op.kind,
          ...(op.kind === 'barH' ? { barDir: 'bar' } : {}),
          title: op.title,
          categories: op.categories,
          series: op.series,
          offset: operationBox(document, {
            slideId: sid,
            x: op.xPx,
            y: op.yPx,
            width: op.wPx,
            height: op.hPx,
          }),
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'chart' && !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      addSmartArt: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const updated = await applyUserOperations([{
          op: 'addSmartArt',
          target: { slide: sid },
          layout: op.layout,
          items: op.items,
          offset: operationBox(document, {
            slideId: sid,
            x: op.xPx,
            y: op.yPx,
            width: op.wPx,
            height: op.hPx,
          }),
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'group' && !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      addInk: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const bytes = Uint8Array.from(atob(op.base64), (character) => character.charCodeAt(0))
        const updated = await applyUserOperations([{
          op: 'addPicture',
          target: { slide: sid },
          bytes,
          ext: 'png',
          offset: operationBox(document, {
            slideId: sid,
            x: op.xPx,
            y: op.yPx,
            width: op.wPx,
            height: op.hPx,
          }),
          descr: `genoffice-ink:${op.payload}`,
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'picture' && !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      addImageBytes: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const bytes = Uint8Array.from(atob(op.base64), (character) => character.charCodeAt(0))
        const updated = await applyUserOperations([{
          op: 'addPicture',
          target: { slide: sid },
          bytes,
          ext: op.ext,
          offset: operationBox(document, {
            slideId: sid,
            x: op.xPx,
            y: op.yPx,
            width: op.wPx,
            height: op.hPx,
          }),
          ...(op.name ? { name: op.name } : {}),
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'picture' && !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      replacePictureBytes: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const bytes = Uint8Array.from(atob(op.base64), (character) => character.charCodeAt(0))
        const updated = await applyUserOperations([{
          op: 'replacePicture',
          target: { slide: sid, el: op.sourceId },
          bytes,
          ext: op.ext,
          ...(op.keepSrcRect ? { keepSrcRect: true } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      copyElements: async (op) => {
        const document = documentRef.current
        const slide = document?.opened.deck.slides[op.slideIndex]
        if (!document || !slide) return 0
        const items = op.sourceIds.flatMap((sourceId) => {
          const element = slide.elements.find((candidate) => candidate.id === sourceId)
          return element ? [copyElementData(document.opened, slide, element)] : []
        })
        elementClipboardRef.current = items.length > 0 ? { items, pasteCount: 0 } : null
        return items.length
      },
      pasteElements: async (op) => {
        const document = documentRef.current
        const clipboard = elementClipboardRef.current
        const slide = document?.slides[op.slideIndex]
        if (!document || !slide || !clipboard?.items.length) return null
        const sid = slideId(document, op.slideIndex)
        const shiftPx = 16 * (clipboard.pasteCount + 1)
        const updated = await applyUserOperations([{
          op: 'pasteElements',
          target: { slide: sid },
          items: clipboard.items,
          dx: shiftPx * (document.opened.deck.size.cx / slide.widthPx),
          dy: shiftPx * (document.opened.deck.size.cy / slide.heightPx),
        }], [sid])
        if (!updated) return null
        clipboard.pasteCount += 1
        const rendered = slideAfter(updated, op.slideIndex)
        const sourceIds = rendered?.nodes.slice(-clipboard.items.length).map((node) => node.sourceId) ?? []
        return rendered ? { slide: rendered, sourceIds } : null
      },
      duplicateElements: async (op) => {
        const document = documentRef.current
        const modelSlide = document?.opened.deck.slides[op.slideIndex]
        const renderSlide = document?.slides[op.slideIndex]
        if (!document || !modelSlide || !renderSlide) return null
        const items = op.sourceIds.flatMap((sourceId) => {
          const element = modelSlide.elements.find((candidate) => candidate.id === sourceId)
          return element ? [copyElementData(document.opened, modelSlide, element)] : []
        })
        if (items.length === 0) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'pasteElements',
          target: { slide: sid },
          items,
          dx: op.dxPx * (document.opened.deck.size.cx / renderSlide.widthPx),
          dy: op.dyPx * (document.opened.deck.size.cy / renderSlide.heightPx),
        }], [sid])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceIds = slide?.nodes.slice(-items.length).map((node) => node.sourceId) ?? []
        return slide ? { slide, sourceIds } : null
      },
      insertImage: async (slideIndex) => {
        const document = documentRef.current
        const picked = await pickBrowserImage()
        if (!document || !picked) return null
        const sid = slideId(document, slideIndex)
        const slideBefore = document.slides[slideIndex]
        if (!slideBefore) return null
        const before = new Set(slideBefore.nodes.map((node) => node.sourceId))
        const image = dataUrlImage(`data:${picked.mime};base64,${picked.base64}`)
        const width = Math.min(480, Math.max(120, slideBefore.widthPx - 200))
        const height = Math.min(320, Math.max(90, width * 0.6))
        const offset = operationBox(document, {
          slideId: sid,
          x: Math.max(0, (slideBefore.widthPx - width) / 2),
          y: Math.max(0, (slideBefore.heightPx - height) / 2),
          width,
          height,
        })
        const updated = await applyUserOperations([{
          op: 'addPicture',
          target: { slide: sid },
          bytes: image.bytes,
          ext: image.ext,
          offset,
        }], [sid])
        const slide = slideAfter(updated, slideIndex)
        const sourceId = slide?.nodes.find((node) => !before.has(node.sourceId))?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      editTableCell: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTableCell',
          target: { slide: sid, el: op.sourceId },
          row: op.row,
          col: op.col,
          paragraphs: op.paragraphs,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      tableStructure: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'tableStructure',
          target: { slide: sid, el: op.sourceId },
          kind: op.kind,
          index: op.index,
          ...(op.before ? { before: true } : {}),
        }], [`${sid}/${op.sourceId}`])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'table')?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      tableMerge: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'tableMerge',
          target: { slide: sid, el: op.sourceId },
          kind: op.kind,
          row: op.row,
          col: op.col,
        }], [`${sid}/${op.sourceId}`])
        const slide = slideAfter(updated, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.type === 'table')?.sourceId
        return slide && sourceId ? { slide, sourceId } : null
      },
      setTableColWidth: async (op) => {
        const document = documentRef.current
        const slide = document?.slides[op.slideIndex]
        if (!document || !slide) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTableColWidth',
          target: { slide: sid, el: op.sourceId },
          col: op.col,
          wEmu: op.wPx * (document.opened.deck.size.cx / slide.widthPx),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setTableRowHeight: async (op) => {
        const document = documentRef.current
        const slide = document?.slides[op.slideIndex]
        if (!document || !slide) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTableRowHeight',
          target: { slide: sid, el: op.sourceId },
          row: op.row,
          hEmu: op.hPx * (document.opened.deck.size.cy / slide.heightPx),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setTableCellAnchor: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTableCellAnchor',
          target: { slide: sid, el: op.sourceId },
          row: op.row,
          col: op.col,
          anchor: op.anchor,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editTableStyle: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const preset = op.styleName ? TABLE_STYLE_PRESETS[op.styleName] : undefined
        const edit = preset ? {
          tblPrXml: preset.tblPrXml,
          clearDirectFormatting: true,
          ...(preset.border ? {
            borderPreset: 'all',
            borderColor: preset.border.color,
            borderWidthEmu: preset.border.widthEmu,
          } : {}),
        } : {
          ...(op.firstRow !== undefined ? { firstRow: op.firstRow } : {}),
          ...(op.bandRow !== undefined ? { bandRow: op.bandRow } : {}),
          ...(op.shadingColor !== undefined ? { shadingColor: op.shadingColor } : {}),
          ...(op.borderPreset !== undefined ? { borderPreset: op.borderPreset } : {}),
          ...(op.borderColor !== undefined ? { borderColor: op.borderColor } : {}),
          ...(op.borderWidthPt != null ? { borderWidthEmu: Math.round(op.borderWidthPt * 12700) } : {}),
          ...(op.cells ? { cells: op.cells } : {}),
        }
        const updated = await applyUserOperations([{
          op: 'setTableStyle',
          target: { slide: sid, el: op.sourceId },
          edit,
          ...(preset?.styleId ? {
            stylePart: { styleId: preset.styleId, styleDefXml: preset.styleDefXml },
          } : {}),
        }], [`${sid}/${op.sourceId}`])
        const reparsed = updated ? await reparseDocument(updated) : null
        const slide = slideAfter(reparsed, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.sourceId === op.sourceId)?.sourceId
          ?? slide?.nodes.find((node) => node.type === 'table')?.sourceId
          ?? null
        return slide ? { slide, sourceId } : null
      },
      editChart: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const patch = {
          ...(op.kind ? { kind: op.kind === 'barH' ? 'bar' : op.kind } : {}),
          ...(op.kind === 'barH' ? { barDir: 'bar' } : {}),
          ...(op.categories ? { categories: op.categories } : {}),
          ...(op.series ? { series: op.series } : {}),
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.legendPos ? { legendPos: op.legendPos } : {}),
          ...(op.dataLabels !== undefined ? { dataLabels: op.dataLabels } : {}),
          ...(op.gridlines !== undefined ? { gridlines: op.gridlines } : {}),
          ...(op.catAxisTitle !== undefined ? { catAxisTitle: op.catAxisTitle } : {}),
          ...(op.valAxisTitle !== undefined ? { valAxisTitle: op.valAxisTitle } : {}),
          ...(op.gapWidthPct !== undefined ? { gapWidthPct: op.gapWidthPct } : {}),
          ...(op.switchRowCol ? { switchRowCol: true } : {}),
          ...(op.pointColors ? { pointColors: op.pointColors } : {}),
        }
        const updated = await applyUserOperations([{
          op: 'setChart',
          target: { slide: sid, el: op.sourceId },
          patch,
        }], [`${sid}/${op.sourceId}`])
        const reparsed = updated ? await reparseDocument(updated) : null
        const slide = slideAfter(reparsed, op.slideIndex)
        const sourceId = slide?.nodes.find((node) => node.sourceId === op.sourceId)?.sourceId
          ?? slide?.nodes.find((node) => node.type === 'chart')?.sourceId
          ?? null
        return slide ? { slide, sourceId } : null
      },
      getChartData: async (slideIndex, sourceId) => {
        const slide = documentRef.current?.opened.deck.slides[slideIndex]
        return slide ? getChartElementData(slide, sourceId) : null
      },
      reorderElement: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'reorderElement',
          target: { slide: sid, el: op.sourceId },
          dir: op.dir,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      flipElements: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'flipElements',
          target: { slide: sid },
          els: op.sourceIds,
          axis: op.axis,
          ...(op.groupId ? { group: op.groupId } : {}),
        }], op.sourceIds.map((sourceId) => `${sid}/${sourceId}`))
        return slideAfter(updated, op.slideIndex)
      },
      changeShape: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setShapeGeometry',
          target: { slide: sid, el: op.sourceId },
          prst: op.prst,
          ...(op.groupId ? { group: op.groupId } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setShapeAdjust: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const operation = {
          op: 'setShapeAdjust',
          target: { slide: sid, el: op.sourceId },
          adjust: op.adjust,
          ...(op.groupId ? { group: op.groupId } : {}),
        }
        const previewKey = `adjust:${sid}/${op.groupId ?? ''}/${op.sourceId}`
        if (op.preview) {
          if (!transformPreviewRef.current.has(previewKey)) {
            transformPreviewRef.current.set(previewKey, takeSnapshot(document))
          }
          const outcome = runTxn(document.opened, { isolation: 'atomic', ops: [operation] })
          if (!outcome.applied) return null
          const preview = refreshSlidesDocument(document, FIT_WIDTH)
          await displayDocument(preview)
          return slideAfter(preview, op.slideIndex)
        }
        const before = transformPreviewRef.current.get(previewKey)
        transformPreviewRef.current.delete(previewKey)
        const updated = await applyUserOperations([operation], [`${sid}/${op.sourceId}`], before)
        return slideAfter(updated, op.slideIndex)
      },
      groupElements: async (op) => {
        const document = documentRef.current
        if (!document || op.sourceIds.length < 2) return null
        const sid = slideId(document, op.slideIndex)
        const before = new Set(document.slides[op.slideIndex]?.nodes.map((node) => node.sourceId) ?? [])
        const updated = await applyUserOperations([{
          op: 'groupElements',
          target: { slide: sid },
          els: op.sourceIds,
        }], op.sourceIds.map((sourceId) => `${sid}/${sourceId}`))
        const slide = slideAfter(updated, op.slideIndex)
        const groupId = slide?.nodes.find((node) => node.type === 'group' && !before.has(node.sourceId))?.sourceId
        return slide && groupId ? { slide, groupId } : null
      },
      ungroupElement: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'ungroupElement',
          target: { slide: sid, el: op.sourceId },
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editImageFill: async (op) => {
        const document = documentRef.current
        if (!document || op.targets.length === 0) return null
        const picked = op.source ? null : await pickBrowserImage()
        const source = op.source ?? (picked ? {
          base64: picked.base64,
          ext: picked.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png',
        } : null)
        if (!source) return null
        const sid = slideId(document, op.slideIndex)
        const bytes = Uint8Array.from(atob(source.base64), (character) => character.charCodeAt(0))
        const operations: Op[] = op.targets.map((target) => ({
          op: 'setImageFill',
          target: { slide: sid, el: target.sourceId },
          source: { bytes, ext: source.ext },
          tile: op.mode === 'tile',
          ...(target.groupId ? { group: target.groupId } : {}),
        }))
        const updated = await applyUserOperations(
          operations,
          op.targets.map((target) => `${sid}/${target.sourceId}`),
        )
        return slideAfter(updated, op.slideIndex)
      },
      setTextAnchor: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTextAnchor',
          target: { slide: sid, el: op.sourceId },
          anchor: op.anchor,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setTextBodyProps: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setTextBodyProps',
          target: { slide: sid, el: op.sourceId },
          props: op.props,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setEffects: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setEffects',
          target: { slide: sid, el: op.sourceId },
          effects: op.effects,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editPictureSrcRect: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const box = op.boxPx ? operationBox(document, {
          slideId: sid,
          elementId: op.sourceId,
          x: op.boxPx.x,
          y: op.boxPx.y,
          width: op.boxPx.w,
          height: op.boxPx.h,
        }) : undefined
        const updated = await applyUserOperations([{
          op: 'setPictureSrcRect',
          target: { slide: sid, el: op.sourceId },
          srcRect: op.srcRect,
          ...(box ? { box } : {}),
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      editPictureOpacity: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setPictureOpacity',
          target: { slide: sid, el: op.sourceId },
          opacity: op.opacity,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      setLink: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setLink',
          target: { slide: sid, el: op.sourceId },
          link: op.target,
        }], [`${sid}/${op.sourceId}`])
        return slideAfter(updated, op.slideIndex)
      },
      getLink: async (slideIndex, sourceId) => {
        const document = documentRef.current
        return document ? getElementLink(document.opened, slideIndex, sourceId) : null
      },
      getSlideLinks: async (slideIndex) => {
        const document = documentRef.current
        return document ? getSlideLinks(document.opened, slideIndex).map(({ elementId, target }) => ({
          sourceId: elementId,
          target,
        })) : []
      },
      getRunLinks: async (slideIndex) => {
        const document = documentRef.current
        return document ? getRunLinks(document.opened, slideIndex).map(({ elementId, ...link }) => ({
          sourceId: elementId,
          ...link,
        })) : []
      },
      applyHeaderFooter: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const updated = await applyUserOperations([{
          op: 'applyHeaderFooter',
          settings: {
            footer: op.footer ?? null,
            slideNum: !!op.slideNum,
            date: op.date ?? null,
            ...(op.dateAuto ? { dateAuto: true } : {}),
          },
        }], ['document:header-footer'])
        return updated?.slides ?? null
      },
      getHeaderFooter: async (slideIndex) => {
        const slide = documentRef.current?.opened.deck.slides[slideIndex]
        return slide ? readHeaderFooter(slide) : { footer: null, slideNum: false, date: null }
      },
      applyTheme: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const updated = await applyUserOperations([{
          op: 'applyTheme',
          name: op.name,
          colors: op.colors,
          ...(op.majorFont ? { majorFont: op.majorFont } : {}),
          ...(op.minorFont ? { minorFont: op.minorFont } : {}),
        }], ['document:theme'])
        return updated ? (await reparseDocument(updated)).slides : null
      },
      setSlideLayout: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setSlideLayout',
          target: { slide: sid },
          ...(op.layoutPath ? { layoutPath: op.layoutPath } : {}),
        }], [sid])
        return slideAfter(updated ? await reparseDocument(updated) : null, op.slideIndex)
      },
      getLayouts: async () => {
        const document = documentRef.current
        return document ? {
          layouts: listSlideLayouts(document.opened.archive),
          size: { ...document.opened.deck.size },
        } : null
      },
      addSlideWithLayout: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.sourceIndex)
        const updated = await applyUserOperations([{
          op: 'addSlideWithLayout',
          target: { slide: sid },
          layoutPath: op.layoutPath,
        }], [sid])
        return updated ? { slides: updated.slides, index: op.sourceIndex + 1 } : null
      },
      masterEnter: async (fitWidthPx) => {
        const document = documentRef.current
        if (!document) return null
        const items = listMasterParts(document.opened.archive).flatMap((part) => {
          const slide = renderMasterPart(part.partPath, fitWidthPx)
          return slide ? [{ ...part, slide }] : []
        })
        if (items.length > 0) masterPartRef.current = items[0]!.partPath
        return items.length > 0 ? { items } : null
      },
      masterOpen: async (partPath) => renderMasterPart(partPath),
      masterClose: async () => {
        masterPartRef.current = null
        const document = documentRef.current
        return document ? (await reparseDocument(document)).slides : null
      },
      masterEditText: async (op) => {
        const part = masterPartRef.current
        if (!part) return null
        const updated = await applyUserOperations([{
          op: 'setText',
          target: { part, el: op.sourceId },
          paragraphs: op.paragraphs,
        }], [`${part}/${op.sourceId}`])
        return updated ? renderMasterPart(part) : null
      },
      masterEditTransform: async (op) => {
        const document = documentRef.current
        const part = masterPartRef.current
        if (!document || !part) return null
        const scale = document.opened.deck.size.cx / op.fitWidthPx
        const updated = await applyUserOperations([{
          op: 'setTransform',
          target: { part, el: op.sourceId },
          box: {
            x: Math.round(op.xPx * scale),
            y: Math.round(op.yPx * scale),
            cx: Math.round(op.wPx * scale),
            cy: Math.round(op.hPx * scale),
          },
          rotDeg: op.rotationDeg,
        }], [`${part}/${op.sourceId}`])
        return updated ? renderMasterPart(part, op.fitWidthPx) : null
      },
      masterEditFill: async (op) => {
        const part = masterPartRef.current
        if (!part) return null
        const fill = typeof op.fill === 'string' ? op.fill : {
          stops: op.fill.gradient.stops ?? [
            { pos: 0, color: op.fill.gradient.from },
            { pos: 1, color: op.fill.gradient.to },
          ],
          ...(op.fill.gradient.path || op.fill.gradient.radial
            ? { path: op.fill.gradient.path ?? 'circle' }
            : { angle: Math.round((op.fill.gradient.angleDeg ?? 0) * 60000) }),
        }
        const updated = await applyUserOperations([{
          op: 'setFill',
          target: { part, el: op.sourceId },
          fill,
        }], [`${part}/${op.sourceId}`])
        return updated ? renderMasterPart(part) : null
      },
      masterEditStroke: async (op) => {
        const part = masterPartRef.current
        if (!part) return null
        const updated = await applyUserOperations([{
          op: 'setStroke',
          target: { part, el: op.sourceId },
          stroke: op.stroke ? {
            color: op.stroke.color,
            widthEmu: Math.round(op.stroke.widthPt * 12700),
          } : null,
        }], [`${part}/${op.sourceId}`])
        return updated ? renderMasterPart(part) : null
      },
      masterDeleteElement: async (op) => {
        const part = masterPartRef.current
        if (!part) return null
        const updated = await applyUserOperations([{
          op: 'deleteElement',
          target: { part, el: op.sourceId },
        }], [`${part}/${op.sourceId}`])
        return updated ? renderMasterPart(part) : null
      },
      setSlideHidden: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.slideIndex)
        const updated = await applyUserOperations([{
          op: 'setHidden',
          target: { slide: sid },
          hidden: op.hidden,
        }], [sid])
        return slideAfter(updated, op.slideIndex)
      },
      setSlideSize: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const updated = await applyUserOperations([{
          op: 'setSlideSize',
          cx: op.cx,
          cy: op.cy,
        }], ['document:slide-size'])
        return updated?.slides ?? null
      },
      editBackground: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const indexes = op.slideIndex === -1
          ? document.slides.map((_slide, index) => index)
          : [op.slideIndex]
        let image: { bytes: Uint8Array; ext: string } | null = null
        if (op.kind === 'image' && op.pick !== false) {
          const picked = await pickBrowserImage()
          if (!picked) return null
          image = dataUrlImage(`data:${picked.mime};base64,${picked.base64}`)
        }
        const operations = indexes.map((index): Op => {
          const target = { slide: slideId(document, index) }
          if (op.kind === 'solid') return { op: 'setBackground', target, kind: 'solid', color: op.color }
          if (op.kind === 'gradient') return {
            op: 'setBackground',
            target,
            kind: 'gradient',
            from: op.from,
            to: op.to,
            angleDeg: op.angleDeg,
            radial: op.radial,
          }
          if (op.kind === 'reset') return { op: 'setBackground', target, kind: 'reset' }
          if (op.kind === 'hideGraphics') return {
            op: 'setBackground',
            target,
            kind: 'graphics',
            hidden: op.hidden,
          }
          if (!image) return { op: 'setBackground', target, kind: 'reset' }
          return {
            op: 'setBackground',
            target,
            kind: 'image',
            source: image,
            tile: op.mode === 'tile',
          }
        })
        const updated = await applyUserOperations(operations, indexes.map((index) => slideId(document, index)))
        return updated?.slides ?? null
      },
      findReplace: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const haystacks = document.slides.map(slideText)
        const count = haystacks.reduce((total, text) => {
          if (!op.find) return total
          const source = op.matchCase ? text : text.toLocaleLowerCase()
          const needle = op.matchCase ? op.find : op.find.toLocaleLowerCase()
          return total + source.split(needle).length - 1
        }, 0)
        if (count === 0) return { count: 0, slides: null }
        const updated = await applyUserOperations([{
          op: 'findReplace',
          find: op.find,
          replace: op.replace,
          matchCase: op.matchCase,
          firstOnly: op.firstOnly,
          slideIndex: op.slideIndex,
          elementId: op.elementId,
        }], ['document:find-replace'])
        return updated ? { count: op.firstOnly ? 1 : count, slides: updated.slides } : null
      },
      moveSlide: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.fromIndex)
        const updated = await applyUserOperations([{
          op: 'moveSlide',
          target: { slide: sid },
          to: op.toIndex,
        }], [sid])
        return updated ? { slides: updated.slides, sections: getSections(updated.opened) } : null
      },
      addSlide: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.sourceIndex)
        const updated = await applyUserOperations([{
          op: 'duplicateSlide',
          target: { slide: sid },
          ...(op.clearText ? { clearText: true } : {}),
        }], [sid])
        return updated ? { slides: updated.slides, index: op.sourceIndex + 1 } : null
      },
      addBlankSlide: async (op) => {
        const document = documentRef.current
        if (!document) return null
        const sid = slideId(document, op.sourceIndex)
        const updated = await applyUserOperations([{
          op: 'addBlankSlide',
          target: { slide: sid },
        }], [sid])
        return updated ? { slides: updated.slides, index: op.sourceIndex + 1 } : null
      },
      copySlide: async (slideIndex, pngBase64) => {
        const document = documentRef.current
        if (!document) return false
        const bundle = copySlideBundle(document.opened, slideIndex)
        if (!bundle) return false
        slideClipboardRef.current = { bundle, ...(pngBase64 ? { png: pngBase64 } : {}) }
        return true
      },
      pasteSlide: async (op) => {
        const clipboard = slideClipboardRef.current
        if (!clipboard || (op.mode === 'picture' && !clipboard.png)) return null
        const updated = await applyUserOperations([{
          op: 'pasteSlide',
          afterIndex: op.afterIndex,
          mode: op.mode,
          ...(op.mode === 'picture' ? { png: clipboard.png } : { bundle: clipboard.bundle }),
        }], ['document:slides'])
        if (!updated) return null
        const index = Math.min(op.afterIndex + 1, updated.slides.length - 1)
        const sourceId = op.mode === 'picture'
          ? updated.slides[index]?.nodes.find((node) => node.type === 'picture')?.sourceId
          : undefined
        return { slides: updated.slides, index, ...(sourceId ? { sourceId } : {}) }
      },
      deleteSlide: async (index) => {
        const document = documentRef.current
        if (!document || document.slides.length <= 1) return null
        const sid = slideId(document, index)
        const updated = await applyUserOperations([{ op: 'deleteSlide', target: { slide: sid } }], [sid])
        return updated?.slides ?? null
      },
      undo: async () => {
        await restoreHistory(undoRef.current, redoRef.current)
        return documentRef.current?.slides ?? null
      },
      redo: async () => {
        await restoreHistory(redoRef.current, undoRef.current)
        return documentRef.current?.slides ?? null
      },
      save: async () => {
        const version = versionRef.current
        if (version) await checkpoint(version)
        dirtyRef.current = false
        return { ok: true, path: sessionRef.current ? `mona://${sessionRef.current.sessionId}` : '' }
      },
      saveAs: async () => {
        const version = versionRef.current
        if (version) await checkpoint(version)
        dirtyRef.current = false
        return { ok: true, path: sessionRef.current ? `mona://${sessionRef.current.sessionId}` : '' }
      },
    }
    return new Proxy(base as SlidesApi, {
      get: (target, property) => {
        const existing = Reflect.get(target, property)
        if (existing !== undefined) return existing
        if (typeof property === 'string' && property.startsWith('on')) return () => () => undefined
        return async () => null
      },
    })
  }, [])

  const embeddedController = useMemo<EmbeddedSlidesController>(() => ({
    requestAi: ({ prompt, displayText }) => {
      const session = sessionRef.current
      if (!session) return
      try {
        bridgeRef.current?.post({
          type: 'office_ai_request',
          sessionId: session.sessionId,
          prompt,
          ...(displayText ? { displayText } : {}),
        })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法调用 Mona AI。')
      }
    },
    selectionChanged: ({ slideIndex, sourceIds }) => {
      const document = documentRef.current
      if (!document || document.slides.length === 0) return
      const index = Math.min(Math.max(Math.trunc(slideIndex), 0), document.slides.length - 1)
      const slide = document.slides[index]!
      selectionRef.current = {
        slideIndex: index,
        elementIds: sourceIds.flatMap((sourceId) => {
          const durableId = durableIdForSource(slide, sourceId)
          return durableId ? [durableId] : []
        }),
      }
    },
  }), [])

  ;(window as unknown as { slidesApi: SlidesApi }).slidesApi = slidesApi
  if (!(window as unknown as { desktop?: unknown }).desktop) {
    ;(window as unknown as { desktop: Record<string, unknown> }).desktop = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'getPathForFile') return () => ''
        return async () => null
      },
    })
  }

  useEffect(() => {
    const bridge = bridgeRef.current!
    return bridge.onMessage((message: HostMessage) => {
      if (message.type === 'office_open') void openDocument(message).catch((reason) => {
        setError(reason instanceof Error ? reason.message : '幻灯片打开失败。')
        setStatus('')
      })
      else if (message.type === 'office_checkpoint_request') void checkpoint(message.version).catch((reason) => {
        setError(reason instanceof Error ? reason.message : '幻灯片保存失败。')
      })
      else if (message.type === 'office_inspect') void inspect(message.command)
      else if (message.type === 'office_command') void apply(message.command)
    })
  })

  useEffect(() => () => bridgeRef.current?.close(), [])
  return (
    <main className="mona-slides-editor" data-editor-kind="slides">
      <GenOfficeSlidesApp embeddedController={embeddedController} />
      {(error || status) ? (
        <div className="mona-slides-status" role={error ? 'alert' : 'status'}>{error ?? status}</div>
      ) : null}
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少应用根节点。')
createRoot(root).render(<MonaSlidesEditor />)
