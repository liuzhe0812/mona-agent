import { XMLBuilder, XMLParser } from 'fast-xml-parser'

export interface ChartTextColors {
  textColor?: string
  titleColor?: string
  axisLabelColor?: string
  axisTitleColor?: string
  legendColor?: string
  dataLabelColor?: string
}

export const CHART_TEXT_COLOR_KEYS = [
  'textColor', 'titleColor', 'axisLabelColor', 'axisTitleColor', 'legendColor', 'dataLabelColor',
] as const

type Node = Record<string, unknown>
const options = {
  preserveOrder: true, ignoreAttributes: false, parseTagValue: false,
  trimValues: false, processEntities: false, commentPropName: '#comment',
}
const parser = new XMLParser(options)
const builder = new XMLBuilder({ ...options, suppressEmptyNode: true })
const axes = ['c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx']

function tag(node: Node): string {
  return Object.keys(node).find((key) => key !== ':@') ?? ''
}

function children(node: Node): Node[] {
  const value = node[tag(node)]
  return Array.isArray(value) ? value as Node[] : []
}

function child(node: Node, name: string): Node | undefined {
  return children(node).find((item) => tag(item) === name)
}

function descendants(node: Node, names: readonly string[]): Node[] {
  return children(node).flatMap((item) => [
    ...(names.includes(tag(item)) ? [item] : []), ...descendants(item, names),
  ])
}

function insertTextProperties(owner: Node, value: Node): void {
  const items = children(owner)
  const current = items.findIndex((item) => tag(item) === 'c:txPr')
  if (current >= 0) { items[current] = value; return }
  const following = [
    'c:crossAx', 'c:externalData', 'c:printSettings', 'c:userShapes', 'c:extLst',
    'c:dLblPos', 'c:showLegendKey', 'c:showVal', 'c:showCatName', 'c:showSerName',
    'c:showPercent', 'c:showBubbleSize', 'c:separator', 'c:showLeaderLines', 'c:leaderLines',
  ]
  const at = items.findIndex((item) => following.includes(tag(item)))
  items.splice(at < 0 ? items.length : at, 0, value)
}

function setRunColor(properties: Node, color: string): void {
  const items = children(properties)
  const fills = ['a:solidFill', 'a:noFill', 'a:gradFill', 'a:pattFill', 'a:blipFill', 'a:grpFill']
  const retained = items.filter((item) => !fills.includes(tag(item)))
  const at = retained[0] && tag(retained[0]) === 'a:ln' ? 1 : 0
  retained.splice(at, 0, { 'a:solidFill': [{ 'a:srgbClr': [], ':@': { '@_val': color } }] })
  properties[tag(properties)] = retained
}

function colorOwner(owner: Node, color: string): void {
  let tx = child(owner, 'c:txPr')
  if (!tx) {
    tx = { 'c:txPr': [{ 'a:bodyPr': [] }, { 'a:lstStyle': [] }, { 'a:p': [{ 'a:pPr': [{ 'a:defRPr': [] }] }] }] }
    insertTextProperties(owner, tx)
  }
  let paragraph = child(tx, 'a:p')
  if (!paragraph) { paragraph = { 'a:p': [] }; children(tx).push(paragraph) }
  let pPr = child(paragraph, 'a:pPr')
  if (!pPr) { pPr = { 'a:pPr': [] }; children(paragraph).unshift(pPr) }
  if (!child(pPr, 'a:defRPr')) children(pPr).push({ 'a:defRPr': [] })
  const text = child(owner, 'c:tx')
  for (const props of [tx, ...(text ? [text] : [])].flatMap((node) =>
    descendants(node, ['a:defRPr', 'a:rPr', 'a:endParaRPr']))) {
    setRunColor(props, color)
  }
}

function documentRoot(xml: string): { nodes: Node[]; root: Node; chart: Node } {
  const nodes = parser.parse(xml) as Node[]
  const root = nodes.find((node) => tag(node) === 'c:chartSpace')
  const chart = root && child(root, 'c:chart')
  if (!root || !chart) throw new Error('Chart XML has no chartSpace/chart element.')
  return { nodes, root, chart }
}

/** Edits only text properties; series, source references and unmodeled chart parts survive. */
export function patchChartTextColors(xml: string, patch: ChartTextColors): string {
  const colors: ChartTextColors = {}
  for (const key of CHART_TEXT_COLOR_KEYS) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'string' || !/^#?[0-9a-f]{6}$/i.test(patch[key]!)) {
      throw new Error(`${key} must be a six-digit RGB color.`)
    }
    colors[key] = patch[key]!.replace(/^#/, '').toUpperCase()
  }
  if (Object.keys(colors).length === 0) return xml
  const { nodes, root, chart } = documentRoot(xml)
  const before = JSON.stringify(nodes)
  const axisNodes = descendants(chart, axes)
  const owners = [root, ...descendants(chart, ['c:title', 'c:legend', 'c:dLbls', 'c:dLbl', ...axes])]
  if (colors.textColor) for (const owner of owners) colorOwner(owner, colors.textColor)
  const title = child(chart, 'c:title')
  if (title && colors.titleColor) colorOwner(title, colors.titleColor)
  for (const axis of axisNodes) {
    if (colors.axisLabelColor) colorOwner(axis, colors.axisLabelColor)
    const axisTitle = child(axis, 'c:title')
    if (axisTitle && colors.axisTitleColor) colorOwner(axisTitle, colors.axisTitleColor)
  }
  const legend = child(chart, 'c:legend')
  if (legend && colors.legendColor) colorOwner(legend, colors.legendColor)
  if (colors.dataLabelColor) {
    for (const labels of descendants(chart, ['c:dLbls', 'c:dLbl'])) colorOwner(labels, colors.dataLabelColor)
  }
  return JSON.stringify(nodes) === before ? xml : builder.build(nodes)
}

/** Keep text formatting when the existing data/type editor rebuilds the chart. */
export function preserveChartTextProperties(original: string, rebuilt: string): string {
  const source = documentRoot(original)
  const target = documentRoot(rebuilt)
  let changed = false
  const copy = (from: Node | undefined, to: Node | undefined) => {
    if (!from || !to) return
    const tx = child(from, 'c:txPr')
    if (tx) { insertTextProperties(to, structuredClone(tx)); changed = true }
    const rich = child(from, 'c:tx')
    const nextRich = child(to, 'c:tx')
    const properties = rich && descendants(rich, ['a:rPr', 'a:defRPr'])[0]
    if (properties && nextRich) {
      for (const run of descendants(nextRich, ['a:r'])) {
        const items = children(run)
        const index = items.findIndex((item) => tag(item) === 'a:rPr')
        const replacement = { 'a:rPr': structuredClone(children(properties)), ...(properties[':@'] ? { ':@': structuredClone(properties[':@']) } : {}) }
        if (index < 0) items.unshift(replacement)
        else items[index] = replacement
      }
      changed = true
    }
  }
  copy(source.root, target.root)
  copy(child(source.chart, 'c:title'), child(target.chart, 'c:title'))
  copy(child(source.chart, 'c:legend'), child(target.chart, 'c:legend'))
  for (const name of axes) {
    const previous = descendants(source.chart, [name])
    descendants(target.chart, [name]).forEach((axis, index) => {
      copy(previous[index], axis)
      copy(previous[index] && child(previous[index]!, 'c:title'), child(axis, 'c:title'))
    })
  }
  const labels = descendants(source.chart, ['c:dLbls', 'c:dLbl'])
  descendants(target.chart, ['c:dLbls', 'c:dLbl']).forEach((node, index) => copy(labels[index], node))
  return changed ? builder.build(target.nodes) : rebuilt
}
