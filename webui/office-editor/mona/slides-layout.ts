import type { RenderSlide } from '@genoffice/pptx-render'

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
  const warnings: string[] = []
  for (const node of slide.nodes) {
    if (!node.durableId || !elementIds.has(node.durableId)) continue
    const box = node.box
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.w > slide.widthPx + 0.5 || box.y + box.h > slide.heightPx + 0.5) {
      warnings.push(`${node.durableId} 超出页面边界。`)
    }
    if ((node.type === 'text' || node.type === 'shape') && node.text
      && node.text.lines.some((line) => line.runs.some((run) => run.text.trim()))) {
      const text = node.text
      if (text.contentHeight > box.h - text.insets.t - text.insets.b + 1
        || text.lines.some((line) => line.runs.some((run) => run.x + run.widthPx > box.w - text.insets.r + 1))) {
        warnings.push(`${node.durableId} 文字可能溢出，请增大文本区域或缩短内容并检查画面。`)
      }
    }
  }
  return warnings
}
