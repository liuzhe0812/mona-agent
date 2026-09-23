import type { PresetBox, PresetContent, PresetTheme } from './slides-presets'

/**
 * Data-driven layouts are deliberately kept separate from the legacy catalog.
 * The legacy expander owns static primitives; this module only expands the new
 * bounded `kind: 'layout'` elements into the same native slide operations.
 */

export type AdditionalRelation =
  | 'none'
  | 'parallel'
  | 'sequence'
  | 'hierarchy'
  | 'matrix'
  | 'cycle'
  | 'network'

export type AdditionalLayoutName =
  | 'cover-split'
  | 'transition-statement'
  | 'closing-callout'
  | 'editorial-essay'
  | 'team-grid'
  | 'parallel-columns'
  | 'parallel-grid'
  | 'timeline'
  | 'matrix-2x2'
  | 'gallery'
  | 'comparison-split'
  | 'metric-spotlight'
  | 'process-steps'
  | 'hierarchy-branch'
  | 'chart-evidence'

export interface AdditionalLayoutImage {
  dataUrl?: string
  assetPath?: string
  width?: number
  height?: number
  fit?: 'contain'
}

export type AdditionalLayoutFact = string | { id: string; text: string; required?: boolean }

/** Content accepted by the extended catalog. Extra fields are additive. */
export type AdditionalLayoutContent = Omit<PresetContent, 'image' | 'images' | 'facts'> & {
  image?: AdditionalLayoutImage
  images?: AdditionalLayoutImage[]
  /** Optional evidence facts emitted by the content planner. */
  facts?: AdditionalLayoutFact[]
  axes?: { x: string; y: string }
}

/** Structural shape of a new catalog element; no runtime import is needed. */
export interface AdditionalLayoutElement {
  role: string
  kind: 'layout'
  layout: AdditionalLayoutName | 'cycle' | 'network' | string
  box: PresetBox
  minItems?: number
  maxItems?: number
  minNodes?: number
  maxNodes?: number
  minImages?: number
  maxImages?: number
  count?: number
  columns?: number
  axisX?: string
  axisY?: string
}

export interface AdditionalLayoutOperation {
  role: string
  op: string
  payload: Record<string, unknown>
}

export const ADDITIONAL_LAYOUT_NAMES: readonly AdditionalLayoutName[] = [
  'cover-split',
  'transition-statement',
  'closing-callout',
  'editorial-essay',
  'team-grid',
  'parallel-columns',
  'parallel-grid',
  'timeline',
  'matrix-2x2',
  'gallery',
  'comparison-split',
  'metric-spotlight',
  'process-steps',
  'hierarchy-branch',
  'chart-evidence',
]

/** Relationships that are intentionally not represented with fake arrows. */
export const ADDITIONAL_LAYOUT_UNSUPPORTED_RELATIONS = ['cycle', 'network'] as const

type PageScale = number | { x: number; y: number } | { width: number; height: number }
type LayoutTheme = Partial<Pick<
  PresetTheme,
  'fontFamily' | 'background' | 'surface' | 'text' | 'muted' | 'accent' | 'line'
>> & { sizes?: Partial<Record<'metric' | 'hero' | 'title' | 'subtitle' | 'body' | 'caption', number>> }

const BASE_WIDTH = 1280
const BASE_HEIGHT = 720

function themeValues(theme: PresetTheme): Required<Pick<
  LayoutTheme,
  'fontFamily' | 'background' | 'surface' | 'text' | 'muted' | 'accent' | 'line'
>> {
  const value = theme as unknown as LayoutTheme
  return {
    fontFamily: value.fontFamily ?? 'Microsoft YaHei',
    background: value.background ?? '#0B1020',
    surface: value.surface ?? '#141B30',
    text: value.text ?? '#F5F7FA',
    muted: value.muted ?? '#9AA6BD',
    accent: value.accent ?? '#72DFC1',
    line: value.line ?? '#27324A',
  }
}

function factors(pageScale: PageScale): { x: number; y: number } {
  if (typeof pageScale === 'number') {
    const value = Number.isFinite(pageScale) && pageScale > 0 ? pageScale : 1
    return { x: value, y: value }
  }
  if ('width' in pageScale && 'height' in pageScale) {
    return {
      x: Number.isFinite(pageScale.width) && pageScale.width > 0 ? pageScale.width / BASE_WIDTH : 1,
      y: Number.isFinite(pageScale.height) && pageScale.height > 0 ? pageScale.height / BASE_HEIGHT : 1,
    }
  }
  return {
    x: Number.isFinite(pageScale.x) && pageScale.x > 0 ? pageScale.x : 1,
    y: Number.isFinite(pageScale.y) && pageScale.y > 0 ? pageScale.y : 1,
  }
}

function scaledBox(box: PresetBox, pageScale: PageScale): PresetBox {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new Error('layout element.box 必须包含有效的正数尺寸。')
  }
  const scale = factors(pageScale)
  return {
    x: box.x * scale.x,
    y: box.y * scale.y,
    width: box.width * scale.x,
    height: box.height * scale.y,
  }
}

function operation(
  slideId: string,
  role: string,
  op: string,
  payload: Record<string, unknown>,
): AdditionalLayoutOperation {
  return { role, op, payload: { slideId, ...payload } }
}

function rectangle(
  slideId: string,
  role: string,
  box: PresetBox,
  fillColor: string,
  strokeColor?: string,
  strokeWidthPt = 1,
): AdditionalLayoutOperation {
  return operation(slideId, role, 'slide_add_shape', {
    ...box,
    shape: 'rect',
    fillColor,
    ...(strokeColor ? { strokeColor, strokeWidthPt } : {}),
  })
}

function ellipse(
  slideId: string,
  role: string,
  box: PresetBox,
  fillColor: string,
  strokeColor?: string,
): AdditionalLayoutOperation {
  return operation(slideId, role, 'slide_add_shape', {
    ...box,
    shape: 'ellipse',
    fillColor,
    ...(strokeColor ? { strokeColor, strokeWidthPt: 1 } : {}),
  })
}

function text(
  slideId: string,
  role: string,
  box: PresetBox,
  value: string,
  colors: ReturnType<typeof themeValues>,
  fontSize: number,
  options: { bold?: boolean; align?: 'left' | 'center' | 'right' } = {},
): AdditionalLayoutOperation {
  return operation(slideId, role, 'slide_add_text', {
    ...box,
    text: value,
    font: {
      fontFamily: colors.fontFamily,
      fontSize: Math.max(16, fontSize),
      color: colors.text,
      ...(options.bold ? { bold: true } : {}),
    },
    ...(options.align ? { align: options.align } : {}),
  })
}

function mutedText(
  slideId: string,
  role: string,
  box: PresetBox,
  value: string,
  colors: ReturnType<typeof themeValues>,
  fontSize = 16,
  options: { bold?: boolean; align?: 'left' | 'center' | 'right' } = {},
): AdditionalLayoutOperation {
  const result = text(slideId, role, box, value, colors, fontSize, options)
  const font = result.payload.font as Record<string, unknown>
  font.color = colors.muted
  return result
}

function detailsAt(content: AdditionalLayoutContent, index: number): string {
  return [content.items?.[index]]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

function arraysLength(content: AdditionalLayoutContent): number {
  return Math.max(content.items?.length ?? 0, content.nodes?.length ?? 0)
}

function countFor(
  element: AdditionalLayoutElement,
  observed: number,
  defaultMin: number,
  defaultMax: number,
  label: string,
): number {
  const min = element.count ?? element.minItems ?? element.minNodes ?? defaultMin
  const max = element.count ?? element.maxItems ?? element.maxNodes ?? defaultMax
  const count = element.count ?? observed
  if (count < min || count > max) throw new Error(`${element.layout} 需要 ${min}-${max} 个${label}，收到 ${count} 个。`)
  if (observed > count) throw new Error(`${element.layout} 的 ${label} 数据超出声明容量：${observed}/${count}。`)
  return count
}

function imagesFor(content: AdditionalLayoutContent): AdditionalLayoutImage[] {
  if (content.images?.length) return content.images
  if (content.image) return [content.image as AdditionalLayoutImage]
  return []
}

function imageOperation(
  slideId: string,
  role: string,
  image: AdditionalLayoutImage,
  box: PresetBox,
): AdditionalLayoutOperation {
  const source = image.assetPath ? { assetPath: image.assetPath } : image.dataUrl ? { dataUrl: image.dataUrl } : null
  if (!source) throw new Error(`图片槽位 ${role} 缺少 assetPath 或 dataUrl。`)
  const width = Number.isFinite(image.width) && (image.width ?? 0) > 0 ? image.width! : box.width
  const height = Number.isFinite(image.height) && (image.height ?? 0) > 0 ? image.height! : box.height
  const ratio = Math.min(box.width / width, box.height / height)
  const fittedWidth = width * ratio
  const fittedHeight = height * ratio
  return operation(slideId, role, 'slide_add_image', {
    ...source,
    x: box.x + (box.width - fittedWidth) / 2,
    y: box.y + (box.height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  })
}

function imageFrame(
  slideId: string,
  role: string,
  image: AdditionalLayoutImage,
  box: PresetBox,
  colors: ReturnType<typeof themeValues>,
): AdditionalLayoutOperation[] {
  return [
    rectangle(slideId, `${role}-frame`, box, colors.surface, colors.line),
    imageOperation(slideId, role, image, {
      x: box.x + 2,
      y: box.y + 2,
      width: Math.max(1, box.width - 4),
      height: Math.max(1, box.height - 4),
    }),
  ]
}

function parallelColumns(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
  grid: boolean,
): AdditionalLayoutOperation[] {
  const observed = arraysLength(content)
  const count = countFor(element, observed, grid ? 5 : 2, grid ? 6 : 4, '项')
  const result: AdditionalLayoutOperation[] = []
  const gap = grid ? 18 : 20
  const columns = grid ? Math.min(3, element.columns ?? 3) : count
  const rows = Math.ceil(count / columns)
  const width = (box.width - gap * (columns - 1)) / columns
  const height = (box.height - gap * (rows - 1)) / rows
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cell = {
      x: box.x + column * (width + gap),
      y: box.y + row * (height + gap),
      width,
      height,
    }
    const heading = content.nodes?.[index] ?? `模块 ${index + 1}`
    const detail = detailsAt(content, index)
    result.push(rectangle(slideId, `${element.role}-panel-${index}`, cell, colors.surface, colors.line))
    const headingHeight = grid ? 50 : 88
    const detailY = grid ? 82 : 112
    const detailHeight = grid ? cell.height - 98 : cell.height - 128
    result.push(text(slideId, `${element.role}-heading-${index}`, {
      x: cell.x + 16,
      y: cell.y + 16,
      width: cell.width - 32,
      height: headingHeight,
    }, heading, colors, 20, { bold: true }))
    if (detail) result.push(mutedText(slideId, `${element.role}-detail-${index}`, {
      x: cell.x + 16,
      y: cell.y + detailY,
      width: cell.width - 32,
      height: Math.max(40, detailHeight),
    }, detail, colors, 16))
  }
  return result
}

function timeline(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const count = countFor(element, arraysLength(content), 2, 5, '时间节点')
  const result: AdditionalLayoutOperation[] = []
  const trackY = box.y + 70
  const gap = Math.min(28, box.width / (count * 5))
  const trackX = box.x + 26
  const trackWidth = box.width - 52
  result.push(rectangle(slideId, `${element.role}-track`, {
    x: trackX,
    y: trackY + 13,
    width: trackWidth,
    height: 3,
  }, colors.line))
  const stepWidth = trackWidth / count
  for (let index = 0; index < count; index += 1) {
    const center = trackX + stepWidth * (index + 0.5)
    const node = content.nodes?.[index] ?? `阶段 ${index + 1}`
    const detail = detailsAt(content, index)
    result.push(ellipse(slideId, `${element.role}-marker-${index}`, {
      x: center - 14,
      y: trackY,
      width: 28,
      height: 28,
    }, colors.accent, colors.background))
    result.push(mutedText(slideId, `${element.role}-index-${index}`, {
      x: center - stepWidth / 2,
      y: trackY - 46,
      width: stepWidth,
      height: 68,
    }, `${String(index + 1).padStart(2, '0')}`, colors, 16, { align: 'center' }))
    result.push(text(slideId, `${element.role}-node-${index}`, {
      x: center - stepWidth / 2 + gap,
      y: trackY + 54,
      width: stepWidth - gap * 2,
      height: 68,
    }, node, colors, 18, { bold: true, align: 'center' }))
    if (detail) result.push(mutedText(slideId, `${element.role}-detail-${index}`, {
      x: center - stepWidth / 2 + gap,
      y: trackY + 132,
      width: stepWidth - gap * 2,
      height: Math.max(56, box.height - 148),
    }, detail, colors, 16, { align: 'center' }))
  }
  return result
}

function matrix(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  if ((content.nodes?.length ?? 0) !== 4) throw new Error('matrix-2x2 必须提供恰好四个 nodes。')
  if ((content.items?.length ?? 0) !== 4) {
    throw new Error('matrix-2x2 必须为四个 nodes 提供四条解释。')
  }
  const result: AdditionalLayoutOperation[] = []
  const axisX = content.axes?.x
  const axisY = content.axes?.y
  if (!axisX || !axisY) throw new Error('matrix-2x2 必须提供 axes.x 与 axes.y，不能捏造矩阵维度。')
  const axisBottom = { x: box.x + 54, y: box.y + box.height - 40, width: box.width - 54, height: 36 }
  const axisSide = { x: box.x, y: box.y + 38, width: 42, height: box.height - 66 }
  result.push(mutedText(slideId, `${element.role}-axis-x`, axisBottom, axisX, colors, 16, { align: 'center' }))
  result.push(mutedText(slideId, `${element.role}-axis-y`, axisSide, axisY, colors, 16, { align: 'center' }))
  const gap = 16
  const originX = box.x + 54
  const originY = box.y + 18
  const cellWidth = (box.width - 54 - gap) / 2
  const cellHeight = (box.height - 52 - gap) / 2
  for (let index = 0; index < 4; index += 1) {
    const column = index % 2
    const row = Math.floor(index / 2)
    const cell = {
      x: originX + column * (cellWidth + gap),
      y: originY + row * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    }
    result.push(rectangle(slideId, `${element.role}-cell-${index}`, cell, colors.surface, colors.line))
    result.push(text(slideId, `${element.role}-node-${index}`, {
      x: cell.x + 14,
      y: cell.y + 14,
      width: cell.width - 28,
      height: 42,
    }, content.nodes![index]!, colors, 19, { bold: true }))
    const detail = detailsAt(content, index) || content.items?.[index] || ''
    result.push(mutedText(slideId, `${element.role}-detail-${index}`, {
      x: cell.x + 14,
      y: cell.y + 66,
      width: cell.width - 28,
      height: Math.max(48, cell.height - 82),
    }, detail, colors, 16))
  }
  return result
}

function gallery(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const images = imagesFor(content)
  const count = countFor(element, Math.max(images.length, arraysLength(content)), 2, 4, '图片')
  if (images.length !== count) throw new Error(`gallery 需要每个槽位一张真实图片，收到 ${images.length}/${count}。`)
  const result: AdditionalLayoutOperation[] = []
  const columns = count === 2 || count === 3 ? count : 2
  const rows = Math.ceil(count / columns)
  const gap = 18
  const width = (box.width - gap * (columns - 1)) / columns
  const height = (box.height - gap * (rows - 1)) / rows
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cell = {
      x: box.x + column * (width + gap),
      y: box.y + row * (height + gap),
      width,
      height,
    }
    const imageBox = { x: cell.x, y: cell.y, width: cell.width, height: Math.max(80, cell.height - 82) }
    result.push(...imageFrame(slideId, `${element.role}-image-${index}`, images[index]!, imageBox, colors))
    const heading = content.nodes?.[index]
    const caption = detailsAt(content, index)
    if (heading) result.push(text(slideId, `${element.role}-heading-${index}`, {
      x: cell.x + 12,
      y: cell.y + cell.height - 80,
      width: cell.width - 24,
      height: 44,
    }, heading, colors, 17, { bold: true }))
    if (caption) result.push(mutedText(slideId, `${element.role}-caption-${index}`, {
      x: cell.x + 12,
      y: cell.y + cell.height - 40,
      width: cell.width - 24,
      height: 44,
    }, caption, colors, 16))
  }
  return result
}

function cover(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const image = imagesFor(content)[0]
  if (!image) throw new Error('cover-split 需要一张真实图片。')
  return [
    rectangle(slideId, `${element.role}-image-panel`, box, colors.surface, colors.line),
    imageOperation(slideId, `${element.role}-image`, image, {
      x: box.x + 10,
      y: box.y + 10,
      width: Math.max(1, box.width - 20),
      height: Math.max(1, box.height - 20),
    }),
    rectangle(slideId, `${element.role}-accent`, {
      x: box.x - 18,
      y: box.y + 30,
      width: 8,
      height: Math.max(20, box.height - 60),
    }, colors.accent),
  ]
}

function transition(
  element: AdditionalLayoutElement,
  _content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  return [
    rectangle(slideId, `${element.role}-accent`, {
      x: box.x,
      y: box.y + box.height / 2 - 2,
      width: Math.min(180, box.width),
      height: 4,
    }, colors.accent),
    rectangle(slideId, `${element.role}-rule`, {
      x: box.x + Math.min(196, box.width),
      y: box.y + box.height / 2 - 1,
      width: Math.max(1, box.width - Math.min(196, box.width)),
      height: 2,
    }, colors.line),
  ]
}

function closing(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const result: AdditionalLayoutOperation[] = [
    rectangle(slideId, `${element.role}-panel`, box, colors.surface, colors.line),
    rectangle(slideId, `${element.role}-rule`, {
      x: box.x + 28,
      y: box.y + 28,
      width: Math.min(180, box.width - 56),
      height: 4,
    }, colors.accent),
  ]
  if ((content.items?.length ?? 0) > 3) throw new Error('closing-callout 最多接受三条 items。')
  const support = content.items ?? []
  support.forEach((value, index) => result.push(mutedText(slideId, `${element.role}-support-${index}`, {
    x: box.x + 28,
    y: box.y + 88 + index * 54,
    width: box.width - 56,
    height: 46,
  }, value!, colors, 17)))
  return result
}

function editorial(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const result: AdditionalLayoutOperation[] = [rectangle(slideId, `${element.role}-rule`, {
    x: box.x,
    y: box.y,
    width: 5,
    height: box.height,
  }, colors.accent)]
  if ((content.items?.length ?? 0) > 4) throw new Error('editorial-essay 最多接受四条 items。')
  const paragraphs = content.items ?? []
  paragraphs.forEach((value, index) => result.push(mutedText(slideId, `${element.role}-paragraph-${index}`, {
    x: box.x + 28,
    y: box.y + index * 82,
    width: box.width - 28,
    height: 68,
  }, value!, colors, 18)))
  return result
}

function team(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const images = imagesFor(content)
  const count = countFor(element, Math.max(arraysLength(content), images.length), 2, 4, '成员')
  const result: AdditionalLayoutOperation[] = []
  const columns = count <= 2 ? count : 2
  const rows = Math.ceil(count / columns)
  const gap = 18
  const width = (box.width - gap * (columns - 1)) / columns
  const height = (box.height - gap * (rows - 1)) / rows
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const card = {
      x: box.x + column * (width + gap),
      y: box.y + row * (height + gap),
      width,
      height,
    }
    result.push(rectangle(slideId, `${element.role}-card-${index}`, card, colors.surface, colors.line))
    let textY = card.y + 18
    if (images[index]) {
      result.push(imageOperation(slideId, `${element.role}-portrait-${index}`, images[index]!, {
        x: card.x + 16,
        y: card.y + 16,
        width: Math.min(96, card.width - 32),
        height: 72,
      }))
      textY = card.y + 100
    }
    result.push(text(slideId, `${element.role}-name-${index}`, {
      x: card.x + 16,
      y: textY,
      width: card.width - 32,
      height: 44,
    }, content.nodes?.[index] ?? `成员 ${index + 1}`, colors, 19, { bold: true }))
    const detail = detailsAt(content, index)
    if (detail) result.push(mutedText(slideId, `${element.role}-role-${index}`, {
      x: card.x + 16,
      y: textY + 52,
      width: card.width - 32,
      height: Math.max(36, card.height - (textY - card.y) - 64),
    }, detail, colors, 16))
  }
  return result
}

function comparison(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const observed = Math.max(content.nodes?.length ?? 0, arraysLength(content))
  if (observed > 2 || observed < 2) throw new Error('comparison-split 需要两个对比对象。')
  const gap = 32
  const width = (box.width - gap) / 2
  return [0, 1].flatMap((index) => {
    const panel = { x: box.x + index * (width + gap), y: box.y, width, height: box.height }
    const detail = detailsAt(content, index)
    return [
      rectangle(slideId, `${element.role}-panel-${index}`, panel, colors.surface, colors.line),
      text(slideId, `${element.role}-label-${index}`, {
        x: panel.x + 18,
        y: panel.y + 20,
        width: panel.width - 36,
        height: 44,
      }, content.nodes?.[index] ?? `对象 ${index + 1}`, colors, 20, { bold: true }),
      mutedText(slideId, `${element.role}-detail-${index}`, {
        x: panel.x + 18,
        y: panel.y + 84,
        width: panel.width - 36,
        height: panel.height - 104,
      }, detail, colors, 17),
    ]
  })
}

function metric(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const metricValue = content.takeaway
  if (!metricValue) throw new Error('metric-spotlight 需要 takeaway。')
  const support = content.items ?? []
  const result: AdditionalLayoutOperation[] = [
    rectangle(slideId, `${element.role}-panel`, box, colors.surface, colors.line),
    text(slideId, `${element.role}-metric`, {
      x: box.x + 28,
      y: box.y + 30,
      width: box.width - 56,
      height: Math.min(100, box.height * 0.32),
    }, metricValue, colors, 42, { bold: true }),
  ]
  support.forEach((value, index) => result.push(mutedText(slideId, `${element.role}-support-${index}`, {
    x: box.x + 28,
    y: box.y + 150 + index * 52,
    width: box.width - 56,
    height: 44,
  }, value!, colors, 17)))
  return result
}

function processSteps(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const count = countFor(element, arraysLength(content), 2, 5, '步骤')
  const result: AdditionalLayoutOperation[] = []
  const rowHeight = box.height / count
  for (let index = 0; index < count; index += 1) {
    const y = box.y + index * rowHeight
    result.push(text(slideId, `${element.role}-index-${index}`, {
      x: box.x,
      y: y + 10,
      width: 64,
      height: 44,
    }, `${String(index + 1).padStart(2, '0')}`, colors, 20, { bold: true }))
    result.push(rectangle(slideId, `${element.role}-rule-${index}`, {
      x: box.x + 74,
      y: y + 28,
      width: 3,
      height: Math.max(2, rowHeight - 14),
    }, colors.accent))
    result.push(text(slideId, `${element.role}-node-${index}`, {
      x: box.x + 100,
      y: y + 8,
      width: box.width - 100,
      height: 44,
    }, content.nodes?.[index] ?? `步骤 ${index + 1}`, colors, 19, { bold: true }))
    const detail = detailsAt(content, index)
    if (detail) result.push(mutedText(slideId, `${element.role}-detail-${index}`, {
      x: box.x + 100,
      y: y + 50,
      width: box.width - 100,
      height: Math.max(40, rowHeight - 50),
    }, detail, colors, 16))
  }
  return result
}

function hierarchy(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const nodes = content.nodes ?? []
  if (nodes.length < 3 || nodes.length > 5) throw new Error('hierarchy-branch 需要 3-5 个 nodes。')
  if ((content.items?.length ?? 0) > nodes.length - 1) throw new Error('hierarchy-branch 不能丢弃未绑定的 items。')
  const result: AdditionalLayoutOperation[] = []
  const rootWidth = Math.min(320, box.width * 0.34)
  const root = { x: box.x + (box.width - rootWidth) / 2, y: box.y, width: rootWidth, height: 66 }
  result.push(rectangle(slideId, `${element.role}-root-panel`, root, colors.surface, colors.line))
  result.push(text(slideId, `${element.role}-root`, {
    x: root.x + 16,
    y: root.y + 11,
    width: root.width - 32,
    height: 44,
  }, nodes[0]!, colors, 20, { bold: true, align: 'center' }))
  const childCount = nodes.length - 1
  const gap = 16
  const childWidth = (box.width - gap * (childCount - 1)) / childCount
  const childY = box.y + 144
  result.push(rectangle(slideId, `${element.role}-trunk`, {
    x: box.x + box.width / 2 - 2,
    y: root.y + root.height,
    width: 4,
    height: 44,
  }, colors.accent))
  result.push(rectangle(slideId, `${element.role}-branch`, {
    x: box.x + childWidth / 2,
    y: root.y + root.height + 42,
    width: Math.max(2, box.width - childWidth),
    height: 3,
  }, colors.accent))
  for (let index = 0; index < childCount; index += 1) {
    const child = {
      x: box.x + index * (childWidth + gap),
      y: childY,
      width: childWidth,
      height: Math.max(96, box.height - 144),
    }
    result.push(rectangle(slideId, `${element.role}-child-panel-${index}`, child, colors.surface, colors.line))
    result.push(rectangle(slideId, `${element.role}-child-link-${index}`, {
      x: child.x + child.width / 2 - 2,
      y: root.y + root.height + 44,
      width: 4,
      height: Math.max(2, child.y - (root.y + root.height + 44)),
    }, colors.accent))
    result.push(text(slideId, `${element.role}-child-${index}`, {
      x: child.x + 14,
      y: child.y + 16,
      width: child.width - 28,
      height: 44,
    }, nodes[index + 1]!, colors, 18, { bold: true }))
    const detail = detailsAt(content, index)
    if (detail) result.push(mutedText(slideId, `${element.role}-child-detail-${index}`, {
      x: child.x + 14,
      y: child.y + 72,
      width: child.width - 28,
      height: child.height - 88,
    }, detail, colors, 16))
  }
  return result
}

function chartEvidence(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  colors: ReturnType<typeof themeValues>,
  slideId: string,
  box: PresetBox,
): AdditionalLayoutOperation[] {
  const observed = arraysLength(content)
  const count = countFor(element, observed, 3, 4, '证据项')
  const result: AdditionalLayoutOperation[] = []
  const rowHeight = box.height / count
  for (let index = 0; index < count; index += 1) {
    const y = box.y + index * rowHeight
    result.push(rectangle(slideId, `${element.role}-rule-${index}`, {
      x: box.x,
      y: y + rowHeight - 3,
      width: box.width,
      height: 2,
    }, colors.line))
    result.push(text(slideId, `${element.role}-label-${index}`, {
      x: box.x,
      y: y + 12,
      width: Math.min(220, box.width * 0.35),
      height: 68,
    }, content.nodes?.[index] ?? `证据 ${index + 1}`, colors, 18, { bold: true }))
    result.push(mutedText(slideId, `${element.role}-detail-${index}`, {
      x: box.x + Math.min(236, box.width * 0.38),
      y: y + 12,
      width: box.width - Math.min(236, box.width * 0.38),
      height: Math.max(40, rowHeight - 24),
    }, detailsAt(content, index), colors, 16))
  }
  return result
}

/**
 * Expand one extended data-driven layout into native editable Office
 * operations. The caller is responsible for the static background/title/
 * summary primitives and for validating catalog capacities before this call.
 */
export function expandAdditionalLayout(
  element: AdditionalLayoutElement,
  content: AdditionalLayoutContent,
  theme: PresetTheme,
  slideId: string,
  pageScale: PageScale = 1,
): AdditionalLayoutOperation[] {
  if (!element || element.kind !== 'layout') throw new Error('expandAdditionalLayout 只接受 kind: layout 元素。')
  const colors = themeValues(theme)
  const box = scaledBox(element.box, pageScale)
  switch (element.layout) {
    case 'cover-split':
      return cover(element, content, colors, slideId, box)
    case 'transition-statement':
      return transition(element, content, colors, slideId, box)
    case 'closing-callout':
      return closing(element, content, colors, slideId, box)
    case 'editorial-essay':
      return editorial(element, content, colors, slideId, box)
    case 'team-grid':
      return team(element, content, colors, slideId, box)
    case 'parallel-columns':
      return parallelColumns(element, content, colors, slideId, box, false)
    case 'parallel-grid':
      return parallelColumns(element, content, colors, slideId, box, true)
    case 'timeline':
      return timeline(element, content, colors, slideId, box)
    case 'matrix-2x2':
      return matrix(element, content, colors, slideId, box)
    case 'gallery':
      return gallery(element, content, colors, slideId, box)
    case 'comparison-split':
      return comparison(element, content, colors, slideId, box)
    case 'metric-spotlight':
      return metric(element, content, colors, slideId, box)
    case 'process-steps':
      return processSteps(element, content, colors, slideId, box)
    case 'hierarchy-branch':
      return hierarchy(element, content, colors, slideId, box)
    case 'chart-evidence':
      return chartEvidence(element, content, colors, slideId, box)
    case 'cycle':
    case 'network':
      throw new Error(`additional layout ${element.layout} 尚未实现；不生成伪造关系箭头。`)
    default:
      throw new Error(`不支持的 additional layout：${element.layout}。`)
  }
}
