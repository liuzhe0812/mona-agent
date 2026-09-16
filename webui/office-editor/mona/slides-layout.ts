import type { RenderNode, RenderSlide, RenderTextLayout } from '@genoffice/pptx-render'

type Payload = Record<string, unknown>
type AddOperation = { op: string; payload: Payload }

export const COMPOSE_FIELDS = {
  slideId: 'Stable slide ID',
  x: 'Optional preview pixels; default 48', y: 'Optional preview pixels; default 48',
  width: 'Optional preview pixels; default slide width minus 96',
  height: 'Optional preview pixels; default slide height minus 96',
  columns: '1–24 positive column weights', rows: '1–24 positive row weights',
  gap: 'Optional spacing in preview pixels; default 24',
  items: '1–50 items in back-to-front order: {type:text|shape|image|svg,column,row,columnSpan?:1,rowSpan?:1,inset?:0, ...native add fields}. Row/column are zero-based. Shared cells intentionally overlap. Image uses assetPath or dataUrl; svg uses svg markup.',
}

function number(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 必须是有限数字。`)
  return value
}

function tracks(value: unknown, extent: number, gap: number, name: string): Array<{ start: number; size: number }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24
    || value.some((weight) => typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)) {
    throw new Error(`${name} 必须包含 1–24 个正数权重。`)
  }
  const available = extent - gap * (value.length - 1)
  if (available <= 0) throw new Error(`${name} 的间距超过可用尺寸。`)
  const total = value.reduce((sum, weight: number) => sum + weight, 0)
  let cursor = 0
  return value.map((weight: number) => {
    const size = available * weight / total
    const track = { start: cursor, size }
    cursor += size + gap
    return track
  })
}

/** Resolves a composition to the same native add operations used by local editing. */
export function composeSlide(payload: Payload, slide: Pick<RenderSlide, 'widthPx' | 'heightPx'>): AddOperation[] {
  const unknown = Object.keys(payload).filter((key) => !(key in COMPOSE_FIELDS))
  if (unknown.length) throw new Error(`slide_compose 不支持字段：${unknown.join(', ')}。`)
  const x = number(payload.x, 'x', 48)
  const y = number(payload.y, 'y', 48)
  const width = number(payload.width, 'width', slide.widthPx - x - 48)
  const height = number(payload.height, 'height', slide.heightPx - y - 48)
  const gap = number(payload.gap, 'gap', 24)
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || gap < 0
    || x + width > slide.widthPx || y + height > slide.heightPx) throw new Error('混排区域超出页面或尺寸无效。')
  const columns = tracks(payload.columns, width, gap, 'columns')
  const rows = tracks(payload.rows, height, gap, 'rows')
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 50) {
    throw new Error('items 必须包含 1–50 个元素。')
  }
  const operations: Record<string, string> = {
    text: 'slide_add_text', shape: 'slide_add_shape', image: 'slide_add_image', svg: 'slide_add_svg',
  }
  const fields: Record<string, string[]> = {
    text: ['text', 'font', 'align', 'fillColor', 'strokeColor', 'strokeWidthPt'],
    shape: ['shape', 'text', 'font', 'align', 'fillColor', 'strokeColor', 'strokeWidthPt'],
    image: ['dataUrl'], svg: ['svg'],
  }
  return payload.items.map((item: unknown, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`items[${index}] 无效。`)
    const entry = item as Payload
    const type = String(entry.type)
    if (!operations[type]) throw new Error(`items[${index}].type 必须是 text、shape、image 或 svg。`)
    const allowed = ['type', 'column', 'row', 'columnSpan', 'rowSpan', 'inset', ...fields[type]!]
    const extras = Object.keys(entry).filter((key) => !allowed.includes(key))
    if (extras.length) throw new Error(`items[${index}] 不支持字段：${extras.join(', ')}。`)
    const col = number(entry.column, 'column')
    const row = number(entry.row, 'row')
    const colSpan = number(entry.columnSpan, 'columnSpan', 1)
    const rowSpan = number(entry.rowSpan, 'rowSpan', 1)
    const inset = number(entry.inset, 'inset', 0)
    if (![col, row, colSpan, rowSpan].every(Number.isInteger) || col < 0 || row < 0
      || colSpan < 1 || rowSpan < 1 || col + colSpan > columns.length || row + rowSpan > rows.length || inset < 0) {
      throw new Error(`items[${index}] 的行列、跨度或 inset 无效。`)
    }
    const firstCol = columns[col]!, lastCol = columns[col + colSpan - 1]!
    const firstRow = rows[row]!, lastRow = rows[row + rowSpan - 1]!
    const box = {
      x: x + firstCol.start + inset, y: y + firstRow.start + inset,
      width: lastCol.start + lastCol.size - firstCol.start - 2 * inset,
      height: lastRow.start + lastRow.size - firstRow.start - 2 * inset,
    }
    if (box.width <= 0 || box.height <= 0) throw new Error(`items[${index}] 的 inset 超过区域尺寸。`)
    return {
      op: operations[type]!,
      payload: { ...Object.fromEntries(fields[type]!.filter((key) => key in entry).map((key) => [key, entry[key]])),
        slideId: payload.slideId, ...box },
    }
  })
}

export function slideLayoutWarnings(slide: RenderSlide, elementIds: ReadonlySet<string>): string[] {
  type Box = { x: number; y: number; w: number; h: number }
  type Item = { id: string; node: RenderNode; box: Box; textBox?: Box }
  const items: Item[] = []
  const visit = (nodes: RenderNode[], offsetX = 0, offsetY = 0): void => {
    for (const node of nodes) {
      const box = { x: node.box.x + offsetX, y: node.box.y + offsetY, w: node.box.w, h: node.box.h }
      if (!node.decoration && node.durableId) {
        const text = (node.type === 'text' || node.type === 'shape') ? node.text : undefined
        items.push({ id: node.durableId, node, box, textBox: textBounds(text, box.x, box.y) })
      }
      if (node.type === 'group') visit(node.children, box.x, box.y)
    }
  }
  visit(slide.nodes)

  const warnings: string[] = []
  const contentItems = items.filter((item) => !item.node.background
    && (item.textBox || ['picture', 'chart', 'table'].includes(item.node.type)))
  const textOnly = contentItems.length <= 2 && contentItems.every((item) => !!item.textBox)
  for (const item of items) {
    if (!elementIds.has(item.id)) continue
    const { box, node } = item
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > slide.widthPx + 0.5 || box.y + box.h > slide.heightPx + 0.5) {
      warnings.push(`[错误] ${item.id} 超出页面边界。`)
    }
    const text = (node.type === 'text' || node.type === 'shape') ? node.text : undefined
    if (text && item.textBox) {
      const lines = text.lines.map((line) => line.runs.map((run) => run.text).join(''))
      if (lines.filter((line) => /[█▓▒■▬━]{3,}/u.test(line) && /\d/u.test(line)).length >= 2) {
        warnings.push(`[需检查] ${item.id} 使用字符条模拟数值图表，长度可能不对应数值；请用 slide_add_chart 保留分类、系列和数值，若是原文引用请说明。`)
      }
      if (textOnly && lines.filter((line) => line.trim()).length >= 6
        && lines.join('').length >= 180 && box.w > slide.widthPx * 0.65) {
        warnings.push(`[需检查] ${item.id} 把长内容集中在单个全宽文本框；请检查是否应拆为独立比较模块、表格或图表。纯文字讲解或引用可在观察整页后说明保留理由。`)
      }
      const availableWidth = Math.max(0, box.w - text.insets.l - text.insets.r)
      const availableHeight = Math.max(0, box.h - text.insets.t - text.insets.b)
      const visibleRuns = text.lines.flatMap((line) => line.runs.filter((run) => run.text.trim()))
      const left = Math.min(...visibleRuns.map((run) => run.x))
      const right = Math.max(...visibleRuns.map((run) => run.x + run.widthPx))
      const actualWidth = Math.max(0, right - left)
      const actualHeight = text.contentHeight
      if (actualHeight > availableHeight + 1
        || left < -1 || right > availableWidth + 1
        || text.lines.some((line) => line.top < -1 || line.top + line.height > availableHeight + 1)) {
        warnings.push(`[错误] ${item.id} 文字溢出：实际约 ${Math.ceil(actualWidth)}×${Math.ceil(actualHeight)}px，`
          + `可用 ${Math.floor(availableWidth)}×${Math.floor(availableHeight)}px；请增大文本区域、调整位置或缩短内容。`)
      }
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    const first = items[index]!
    for (let otherIndex = index + 1; otherIndex < items.length; otherIndex += 1) {
      const second = items[otherIndex]!
      if (!elementIds.has(first.id) && !elementIds.has(second.id)) continue
      if (first.textBox && second.textBox) {
        const overlap = intersection(first.textBox, second.textBox)
        if (overlap) warnings.push(`[错误] ${first.id} 与 ${second.id} 的文字相互重叠`
          + `（约 ${Math.ceil(overlap.w)}×${Math.ceil(overlap.h)}px）；请调整文本区域、位置或文案。`)
        continue
      }
      const textItem = first.textBox ? first : second.textBox ? second : undefined
      const pictureItem = first.node.type === 'picture' ? first : second.node.type === 'picture' ? second : undefined
      if (!textItem?.textBox || !pictureItem || pictureItem.node.background) continue
      const overlap = intersection(textItem.textBox, pictureItem.box)
      if (overlap) warnings.push(`[需检查] ${textItem.id} 的文字与图片 ${pictureItem.id} 交叠`
        + `（约 ${Math.ceil(overlap.w)}×${Math.ceil(overlap.h)}px）；请确认这是有意叠字且文字可读，否则分开图文区域。`)
    }
  }
  return [...new Set(warnings)]
}

export function isBlockingLayoutWarning(warning: string): boolean {
  return warning.startsWith('[错误]')
}

function textBounds(text: RenderTextLayout | undefined, offsetX: number, offsetY: number): { x: number; y: number; w: number; h: number } | undefined {
  if (!text) return undefined
  const runs = text.lines.flatMap((line) => line.runs
    .filter((run) => run.text.trim())
    .map((run) => ({ x: run.x, y: line.top, right: run.x + run.widthPx, bottom: line.top + line.height })))
  if (!runs.length) return undefined
  const left = Math.min(...runs.map((run) => run.x))
  const top = Math.min(...runs.map((run) => run.y))
  const right = Math.max(...runs.map((run) => run.right))
  const bottom = Math.max(...runs.map((run) => run.bottom))
  return {
    x: offsetX + text.insets.l + left,
    y: offsetY + text.insets.t + top,
    w: right - left,
    h: bottom - top,
  }
}

function intersection(first: { x: number; y: number; w: number; h: number }, second: { x: number; y: number; w: number; h: number }): { w: number; h: number } | undefined {
  const width = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x)
  const height = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y)
  return width > 1 && height > 1 ? { w: width, h: height } : undefined
}
