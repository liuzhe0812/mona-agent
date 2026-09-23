import { XMLBuilder, XMLParser } from 'fast-xml-parser'

export interface ChartStylePatch {
  /** Major gridline color, as #RRGGBB or 6-digit HEX. */
  gridColor?: string
  /** Axis line color, as #RRGGBB or 6-digit HEX. */
  axisLineColor?: string
  /** Axis tick-label size in points. */
  axisLabelFontSize?: number
}

type Node = Record<string, unknown>

const options = {
  preserveOrder: true,
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  commentPropName: '#comment',
}
const parser = new XMLParser(options)
const builder = new XMLBuilder({ ...options, suppressEmptyNode: true })
const AXES = ['c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx']
const FILL_TAGS = ['a:solidFill', 'a:noFill', 'a:gradFill', 'a:pattFill', 'a:blipFill', 'a:grpFill']

function tag(node: Node): string {
  return Object.keys(node).find((key) => key !== ':@') ?? ''
}

function children(node: Node): Node[] {
  const value = node[tag(node)]
  return Array.isArray(value) ? value as Node[] : []
}

function setChildren(node: Node, value: Node[]): void {
  node[tag(node)] = value
}

function child(node: Node, name: string): Node | undefined {
  return children(node).find((item) => tag(item) === name)
}

function descendants(node: Node, names: readonly string[]): Node[] {
  return children(node).flatMap((item) => [
    ...(names.includes(tag(item)) ? [item] : []),
    ...descendants(item, names),
  ])
}

function node(name: string, value: Node[] = []): Node {
  return { [name]: value }
}

function insertChild(owner: Node, value: Node, before: readonly string[] = []): Node {
  const items = children(owner)
  const index = items.findIndex((item) => before.includes(tag(item)))
  items.splice(index < 0 ? items.length : index, 0, value)
  setChildren(owner, items)
  return value
}

function ensureChild(owner: Node, name: string, before: readonly string[] = []): Node {
  return child(owner, name) ?? insertChild(owner, node(name), before)
}

function setAttribute(owner: Node, name: string, value: string): void {
  const attrs = owner[':@'] && typeof owner[':@'] === 'object'
    ? owner[':@'] as Node
    : {}
  attrs[`@_${name}`] = value
  owner[':@'] = attrs
}

function colorValue(color: string): string {
  return color.replace(/^#/, '').toUpperCase()
}

function setLineColor(owner: Node, color: string): void {
  const line = ensureChild(owner, 'a:ln')
  const retained = children(line).filter((item) => !FILL_TAGS.includes(tag(item)))
  retained.push(node('a:solidFill', [node('a:srgbClr')]))
  setChildren(line, retained)
  const fill = child(line, 'a:solidFill')!
  const srgb = child(fill, 'a:srgbClr')!
  setAttribute(srgb, 'val', colorValue(color))
}

function setGridColor(axis: Node, color: string): void {
  const grid = child(axis, 'c:majorGridlines')
  if (!grid) return
  const spPr = ensureChild(grid, 'c:spPr')
  setLineColor(spPr, color)
}

function setAxisLabelSize(axis: Node, sizePt: number): void {
  const txPr = ensureChild(axis, 'c:txPr', ['c:crossAx', 'c:crosses', 'c:crossesAt'])
  ensureChild(txPr, 'a:bodyPr')
  ensureChild(txPr, 'a:lstStyle')
  const paragraph = ensureChild(txPr, 'a:p')
  const pPr = ensureChild(paragraph, 'a:pPr')
  const defRPr = ensureChild(pPr, 'a:defRPr')
  setAttribute(defRPr, 'sz', String(Math.round(sizePt * 100)))
}

function documentRoot(xml: string): { nodes: Node[]; chart: Node } {
  const nodes = parser.parse(xml) as Node[]
  const root = nodes.find((item) => tag(item) === 'c:chartSpace')
  const chart = root && child(root, 'c:chart')
  if (!root || !chart) throw new Error('Chart XML has no chartSpace/chart element.')
  return { nodes, chart }
}

/**
 * Patch native axis/gridline styles after a chart rebuild. The operation only
 * touches the requested style owners and leaves caches, series data, and
 * unrelated text formatting intact.
 */
export function patchChartStyles(xml: string, patch: ChartStylePatch): string {
  if (
    patch.gridColor === undefined &&
    patch.axisLineColor === undefined &&
    patch.axisLabelFontSize === undefined
  ) return xml

  const { nodes, chart } = documentRoot(xml)
  const axes = descendants(chart, AXES)
  for (const axis of axes) {
    if (patch.axisLineColor !== undefined) {
      const spPr = ensureChild(axis, 'c:spPr')
      setLineColor(spPr, patch.axisLineColor)
    }
    if (patch.axisLabelFontSize !== undefined) setAxisLabelSize(axis, patch.axisLabelFontSize)
    if (patch.gridColor !== undefined) setGridColor(axis, patch.gridColor)
  }
  return builder.build(nodes)
}
