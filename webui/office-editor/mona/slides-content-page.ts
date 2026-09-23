import type {
  ExpandedPreset,
  PresetChartContent,
  PresetContent,
  PresetInput,
  PresetOperation,
  PresetTheme,
} from './slides-presets'

type Box = { x: number; y: number; width: number; height: number }
type ImageContent = NonNullable<PresetContent['image']>
type PageContent = PresetContent & { items: string[]; nodes: string[]; media: ImageContent[] }

const WIDTH = 1280
const HEIGHT = 720
const BODY_SIZE = 16
const TITLE_SIZE = 32
const RELATIONS = new Set(['none', 'parallel', 'sequence', 'hierarchy', 'matrix', 'cycle', 'network'])
const CHART_KINDS = new Set(['bar', 'line', 'area', 'pie', 'doughnut'])
const CONTENT_KEYS = new Set([
  'title', 'summary', 'takeaway', 'items', 'nodes', 'chart', 'image', 'images', 'facts',
  'role', 'relation', 'axes', 'theme', 'accentColor',
])
const CHART_KEYS = new Set([
  'kind', 'categories', 'series', 'catAxisTitle', 'valAxisTitle', 'legendPos', 'gridlines',
  'dataLabels', 'gapWidthPct', 'unit', 'categoryUnits',
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内容页需要对象内容。')
  return value as Record<string, unknown>
}

function fail(message: string): never {
  throw new Error(`auto-content ${message}`)
}

function text(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined) {
    if (required) fail(`${name} 必须是非空文本。`)
    return undefined
  }
  if (typeof value !== 'string' || (required && !value.trim())) fail(`${name} 必须是非空文本。`)
  return value
}

function textArray(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail(`${name} 必须是文本数组。`)
  }
  return value as string[]
}

function normalized(value: string): string { return value.replace(/\s+/gu, '') }

function image(value: unknown, name: string): ImageContent {
  const item = record(value)
  const allowed = new Set(['dataUrl', 'width', 'height', 'fit'])
  if (Object.keys(item).some((key) => !allowed.has(key)) || typeof item.dataUrl !== 'string'
    || !/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,.+/is.test(item.dataUrl)) {
    fail(`${name} 必须是有效的真实图片 data URL。`)
  }
  if (item.fit !== undefined && item.fit !== 'contain') fail(`${name}.fit 只支持 contain。`)
  if ((item.width !== undefined || item.height !== undefined)
    && (typeof item.width !== 'number' || typeof item.height !== 'number'
      || !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0)) {
    fail(`${name}.width/height 必须同时为正数。`)
  }
  return item as ImageContent
}

function chart(value: unknown, theme: PresetTheme): PresetChartContent {
  const item = record(value)
  if (Object.keys(item).some((key) => !CHART_KEYS.has(key)) || !CHART_KINDS.has(String(item.kind))) {
    fail('图表类型或字段不受支持。')
  }
  if (!Array.isArray(item.categories) || !item.categories.length
    || item.categories.some((category) => typeof category !== 'string' || !category.trim() || [...category].length > 20)) {
    fail('图表 categories 必须是非空短文本数组。')
  }
  if (item.categories.length > 8 || !Array.isArray(item.series) || !item.series.length
    || item.series.length > theme.chart.seriesColors.length) fail('图表数据超过安全容纳，请拆页。')
  for (const [index, series] of (item.series as unknown[]).entries()) {
    const entry = record(series)
    if (Object.keys(entry).some((key) => !['name', 'values'].includes(key))
      || typeof entry.name !== 'string' || !entry.name.trim() || !Array.isArray(entry.values)
      || entry.values.length !== (item.categories as unknown[]).length
      || entry.values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      fail(`图表 series[${index}] 的数据必须与 categories 对齐且为有限数字。`)
    }
  }
  for (const key of ['catAxisTitle', 'valAxisTitle', 'unit'] as const) {
    if (item[key] !== undefined && (typeof item[key] !== 'string' || !item[key]!.trim())) fail(`图表 ${key} 必须是非空文本。`)
  }
  if (item.legendPos !== undefined && !['none', 'b', 't', 'l', 'r'].includes(String(item.legendPos))) fail('图表 legendPos 不受支持。')
  for (const key of ['gridlines', 'dataLabels'] as const) {
    if (item[key] !== undefined && typeof item[key] !== 'boolean') fail(`图表 ${key} 必须是布尔值。`)
  }
  if (item.gapWidthPct !== undefined && (typeof item.gapWidthPct !== 'number' || !Number.isFinite(item.gapWidthPct) || item.gapWidthPct <= 0)) {
    fail('图表 gapWidthPct 必须是正数。')
  }
  if (item.categoryUnits !== undefined) {
    const units = item.categoryUnits
    if (!Array.isArray(units) || units.length !== (item.categories as unknown[]).length
      || units.some((unit) => typeof unit !== 'string' || !unit.trim()) || new Set(units).size > 1) {
      fail('图表 categoryUnits 必须逐项使用同一明确单位。')
    }
    if (item.unit !== undefined && units.some((unit) => unit !== item.unit)) fail('图表 categoryUnits 与 unit 不一致。')
  }
  return item as unknown as PresetChartContent
}

function heightOf(value: string, width: number, fontSize: number, maxHeight: number): number {
  // Native font sizes are points; boxes are pixels and include text insets.
  const charsPerLine = Math.max(1, Math.floor((width - 20) / (fontSize * 4 / 3)))
  const lines = value.split(/\r?\n/u).reduce((total, line) => {
    const units = [...line].reduce((sum,char)=>sum + (/^[\x00-\x7f]$/.test(char) ? 0.6 : 1),0)
    return total + Math.max(1,Math.ceil(units / charsPerLine))
  }, 0)
  const height = Math.ceil(lines * fontSize * 1.6 + 12)
  if (height > maxHeight) fail('文本超过安全容纳，请拆页。')
  return height
}

function prepare(input: PresetInput, theme: PresetTheme): PageContent {
  if (typeof input.slideId !== 'string' || !input.slideId.trim()) fail('slideId 必须是非空文本。')
  const raw = record(input.content)
  if (Object.keys(raw).some((key) => !CONTENT_KEYS.has(key))) fail('包含未支持的内容字段。')
  const title = text(raw.title, 'title', true)!
  const items = textArray(raw.items, 'items')
  const nodes = textArray(raw.nodes, 'nodes')
  if (raw.summary !== undefined) text(raw.summary, 'summary')
  if (raw.takeaway !== undefined) text(raw.takeaway, 'takeaway')
  if (raw.role !== undefined && typeof raw.role !== 'string') fail('role 必须是文本。')
  const relation = raw.relation ?? 'none'
  if (!RELATIONS.has(String(relation))) fail('relation 不受支持。')
  if (relation !== 'none' && relation !== 'parallel') fail('当前不能可靠表达该关系，请拆关系页。')
  if (nodes.length && nodes.length !== items.length) fail('节点标签需要与解释逐项对应，请拆关系页。')
  if (raw.axes !== undefined) fail('当前不能可靠表达 axes，请拆关系页。')
  if (raw.facts !== undefined) {
    if (!Array.isArray(raw.facts) || raw.facts.some((fact) => {
      const item = record(fact)
      return Object.keys(item).some((key) => !['id', 'text', 'required'].includes(key))
        || typeof item.id !== 'string' || !item.id.trim() || typeof item.text !== 'string' || !item.text.trim()
        || (item.required !== undefined && typeof item.required !== 'boolean')
    })) fail('facts 必须包含稳定 id、text 和可选 required。')
  }
  const chartValue = raw.chart === undefined ? undefined : chart(raw.chart, theme)
  const media: ImageContent[] = []
  if (raw.image !== undefined) media.push(image(raw.image, 'image'))
  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images)) fail('images 必须是图片数组。')
    raw.images.forEach((item, index) => media.push(image(item, `images[${index}]`)))
  }
  if (media.length > 4) fail('图片数量超过安全容纳，请拆页。')
  if (chartValue && media.length) fail('图表和图片暂不支持同页，请拆页，不能丢弃任一内容。')
  const facts = (raw.facts as Array<{ id: string; text: string; required?: boolean }> | undefined) ?? []
  const visible = normalized([title, String(raw.summary ?? ''), String(raw.takeaway ?? ''), ...items, ...nodes].join('\n'))
  const missing = facts.filter((fact) => fact.required !== false && !visible.includes(normalized(fact.text)))
  if (missing.length && nodes.length) fail(`必含事实无法在当前关系页完整落位，请拆页：${missing.map((fact) => fact.id).join(', ')}。`)
  const projected = [...items]
  for (const fact of missing) if (!projected.some((item) => normalized(item) === normalized(fact.text))) projected.push(fact.text)
  return { ...input.content, title, items: projected, nodes, media, relation: relation as PageContent['relation'] }
}

export function expandContentPage(input: PresetInput, theme: PresetTheme): ExpandedPreset {
  const content = prepare(input, theme)
  const pageWidth = input.page?.width ?? WIDTH
  const pageHeight = input.page?.height ?? HEIGHT
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) fail('页面尺寸必须是正数。')
  const sx = pageWidth / WIDTH
  const sy = pageHeight / HEIGHT
  const padX = Math.max(48, theme.pad.x)
  const padY = Math.max(48, theme.pad.y)
  const contentWidth = WIDTH - padX * 2
  const operations: PresetOperation[] = []
  const roles: string[] = []
  const add = (role: string, op: string, payload: Record<string, unknown>) => {
    if (operations.length >= 50) fail('对象数量超过 50 个，请拆页。')
    roles.push(role)
    operations.push({ op, payload: { slideId: input.slideId, ...payload } })
  }
  const scaleBox = (box: Box): Box => ({ x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy })
  const addText = (role: string, value: string, box: Box, size: number, color: string, bold = false) => {
    const height = heightOf(value, box.width, size, box.height)
    add(role, 'slide_add_text', { ...scaleBox({ ...box, height }), text: value, font: { fontFamily: theme.fontFamily, fontSize: size, color, ...(bold ? { bold: true } : {}) } })
  }
  add('background', 'slide_add_shape', { x: 0, y: 0, width: pageWidth, height: pageHeight, shape: 'rect', fillColor: theme.background })
  const titleHeight = heightOf(content.title, contentWidth, TITLE_SIZE, 144)
  addText('title', content.title, { x: padX, y: padY, width: contentWidth, height: titleHeight }, TITLE_SIZE, theme.text, true)
  let cursor = padY + titleHeight + theme.gap
  if (content.summary) {
    const summaryHeight = heightOf(content.summary, contentWidth, BODY_SIZE, 72)
    addText('summary', content.summary, { x: padX, y: cursor, width: contentWidth, height: summaryHeight }, BODY_SIZE, theme.muted)
    cursor += summaryHeight + theme.gap / 2
  }
  if (content.takeaway) {
    const takeawayHeight = heightOf(content.takeaway, contentWidth, 20, 64)
    addText('takeaway', content.takeaway, { x: padX, y: cursor, width: contentWidth, height: takeawayHeight }, 20, theme.accent, true)
    cursor += takeawayHeight + theme.gap
  }
  const startY = Math.max(150, cursor + theme.gap)
  const availableHeight = HEIGHT - padY - startY
  if (availableHeight < 110) fail('标题区过高，内容超过安全容纳，请拆页。')
  const chartValue = content.chart
  const values = [...content.nodes, ...content.items]
  const renderList = (list: string[], x: number, y: number, width: number, available: number, prefix: string) => {
    if (!list.length) return
    const heights = list.map((value) => heightOf(value, width, BODY_SIZE, 140))
    const total = heights.reduce((sum, height) => sum + height, 0) + theme.gap * (list.length - 1)
    if (total > available) fail('正文超过安全容纳，请拆页。')
    let yy = y
    list.forEach((value, index) => {
      addText(`${prefix}-${index}`, value, { x, y: yy, width, height: heights[index]! }, BODY_SIZE, theme.text)
      yy += heights[index]! + theme.gap
    })
  }
  const renderParallel = (x: number, y: number, width: number, available: number) => {
    const nodeWidth = Math.min(190, width * 0.36)
    const detailX = x + nodeWidth + theme.gap
    const detailWidth = width - nodeWidth - theme.gap
    const rowHeights = content.nodes.map((node, index) => Math.max(heightOf(node, nodeWidth, BODY_SIZE, 140), heightOf(content.items[index]!, detailWidth, BODY_SIZE, 140)))
    const total = rowHeights.reduce((sum, height) => sum + height, 0) + theme.gap * (rowHeights.length - 1)
    if (total > available) fail('并列内容超过安全容纳，请拆页。')
    let yy = y
    rowHeights.forEach((height, index) => {
      addText(`node-${index}`, content.nodes[index]!, { x, y: yy, width: nodeWidth, height }, BODY_SIZE, theme.text, true)
      addText(`item-${index}`, content.items[index]!, { x: detailX, y: yy, width: detailWidth, height }, BODY_SIZE, theme.text)
      yy += height + theme.gap
    })
  }
  const renderColumns = (list: string[], x: number, y: number, width: number, available: number) => {
    const gap = theme.gap
    const columnWidth = (width - gap) / 2
    const split = Math.ceil(list.length / 2)
    renderList(list.slice(0, split), x, y, columnWidth, available, 'content-left')
    renderList(list.slice(split), x + columnWidth + gap, y, columnWidth, available, 'content-right')
  }
  const renderImages = (list: ImageContent[], x: number, y: number, width: number, height: number) => {
    const columns = list.length <= 2 ? list.length : 2
    const rows = Math.ceil(list.length / columns)
    const gap = theme.gap
    const cellWidth = (width - gap * (columns - 1)) / columns
    const cellHeight = (height - gap * (rows - 1)) / rows
    list.forEach((item, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      let box = { x: x + column * (cellWidth + gap), y: y + row * (cellHeight + gap), width: cellWidth, height: cellHeight }
      if (item.width && item.height) {
        const ratio = Math.min(box.width / item.width, box.height / item.height)
        const widthFit = item.width * ratio
        const heightFit = item.height * ratio
        box = { ...box, x: box.x + (box.width - widthFit) / 2, y: box.y + (box.height - heightFit) / 2, width: widthFit, height: heightFit }
      }
      add(`image-${index}`, 'slide_add_image', { ...scaleBox(box), dataUrl: item.dataUrl })
    })
  }
  let chartStyle: ExpandedPreset['pendingChartStyles'] = []
  if (chartValue) {
    const chartWidth = contentWidth * 0.58
    const sideX = padX + chartWidth + theme.gap
    const sideWidth = contentWidth - chartWidth - theme.gap
    add('chart', 'slide_add_chart', {
      ...scaleBox({ x: padX, y: startY, width: chartWidth, height: availableHeight }),
      kind: chartValue.kind, categories: chartValue.categories, series: chartValue.series,
      ...(chartValue.legendPos ? { legendPos: chartValue.legendPos } : {}),
      ...(chartValue.gridlines !== undefined ? { gridlines: chartValue.gridlines } : {}),
      ...(chartValue.dataLabels !== undefined ? { dataLabels: chartValue.dataLabels } : {}),
      ...(chartValue.catAxisTitle ? { catAxisTitle: chartValue.catAxisTitle } : {}),
      ...((chartValue.valAxisTitle || chartValue.unit || chartValue.categoryUnits?.[0])
        ? { valAxisTitle: chartValue.valAxisTitle ?? chartValue.unit ?? chartValue.categoryUnits?.[0] } : {}),
      ...(chartValue.gapWidthPct !== undefined ? { gapWidthPct: chartValue.gapWidthPct } : {}),
    })
    chartStyle = [{ role: 'chart', style: {
      textColor: theme.chart.textColor, axisLabelColor: theme.chart.axisLabelColor, legendColor: theme.chart.legendColor,
      dataLabelColor: theme.chart.dataLabelColor, seriesColors: theme.chart.seriesColors.slice(0, chartValue.series.length),
      gridColor: theme.chart.gridColor ?? theme.line, axisLineColor: theme.chart.axisLineColor ?? theme.line,
      axisLabelFontSize: theme.chart.axisLabelFontSize ?? 12,
    } }]
    if (content.nodes.length) renderParallel(sideX, startY, sideWidth, availableHeight)
    else renderList(content.items.length ? content.items : content.nodes, sideX, startY, sideWidth, availableHeight, 'content')
  } else if (content.media.length) {
    const imageWidth = contentWidth * 0.46
    renderImages(content.media, padX, startY, imageWidth, availableHeight)
    if (content.nodes.length) renderParallel(padX + imageWidth + theme.gap, startY, contentWidth - imageWidth - theme.gap, availableHeight)
    else renderList(values, padX + imageWidth + theme.gap, startY, contentWidth - imageWidth - theme.gap, availableHeight, 'content')
  } else if (content.nodes.length) renderParallel(padX, startY, contentWidth, availableHeight)
  else renderColumns(values, padX, startY, contentWidth, availableHeight)
  return { presetId: 'auto-content', theme: theme.id, roles, operations, pendingChartStyles: chartStyle }
}
