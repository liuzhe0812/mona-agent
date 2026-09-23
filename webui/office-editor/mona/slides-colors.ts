import { elementDurableId, materializeSlide, patchedElementXml, slideDurableId, type OpenedPptx, type Slide, type SlideElement } from '@genoffice/pptx-engine'
import { resolveTarget } from '../vendor/genoffice/packages/pptx-engine/src/zip'
import { register, resolveSlide, type Op } from '../vendor/genoffice/apps/slides/src/main/ops/registry'

type Data = Record<string, unknown>
type ColorField = 'text' | 'fill' | 'stroke' | 'chart'
const FIELDS: ColorField[] = ['text', 'fill', 'stroke', 'chart']
const HEX = /^#[0-9a-f]{6}$/i
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>/g
const ID = /\br:id\s*=\s*(["'])([^"']+)\1/
const NOTE = '只统计/替换原生对象中显式 RGB 颜色。保留透明度、渐变及全部非颜色内容；图片像素、母版/主题继承色、SmartArt 等未展开对象不自动改色。相同 RGB 不等于相同语义，请按对象范围保护警告、正负值和人工特殊配色。'

function strings(value: unknown, name: string, max: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max || value.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`${name} 需要最多 ${max} 个实际 ID。`)
  return [...new Set(value as string[])]
}
function fields(value: unknown): ColorField[] {
  if (value === undefined) return FIELDS
  if (!Array.isArray(value) || !value.length || value.some((x) => !FIELDS.includes(x))) throw new Error('fields 仅支持 text/fill/stroke/chart。')
  return [...new Set(value)] as ColorField[]
}
function replacements(value: unknown): Map<string, string> {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error('replacements 需要 1–24 个 {from,to} 精确颜色映射。')
  const map = new Map<string, string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((k) => !['from', 'to'].includes(k))
      || !HEX.test(item.from) || !HEX.test(item.to)) throw new Error('from/to 必须是 #RRGGBB，不接受代码或模糊颜色名。')
    const from = item.from.slice(1).toUpperCase(), to = item.to.slice(1).toUpperCase()
    if (map.has(from)) throw new Error('同一来源颜色不能重复映射。')
    map.set(from, to)
  }
  return map
}

/** Only color-node attributes are patched. Text, numbers, IDs, alpha and geometry stay byte-identical. */
export function mapXmlColors(xml: string, visit: (color: string, field: ColorField) => string | undefined, chart = false) {
  const stack: string[] = []
  let inherited = 0
  const text = xml.replace(TAG, (tag) => {
    if (tag.startsWith('<!') || tag.startsWith('<?')) return tag
    const name = /^<\/?\s*([\w:.-]+)/.exec(tag)?.[1]
    if (!name) return tag
    if (/^<\//.test(tag)) { stack.pop(); return tag }
    const blocked = stack.includes('p:pic') || stack.includes('a:blip') || stack.includes('p:oleObj')
    const field: ColorField = chart ? 'chart' : stack.some((x) => ['a:rPr', 'a:defRPr', 'a:endParaRPr', 'a:fontRef', 'a:buClr'].includes(x)) ? 'text'
      : stack.some((x) => ['a:ln', 'a:lnRef'].includes(x)) ? 'stroke' : 'fill'
    let result = tag
    if (!blocked && name === 'a:schemeClr') inherited++
    if (!blocked && name === 'a:srgbClr') {
      result = tag.replace(/(\bval\s*=\s*)(["'])([0-9a-f]{6})\2/i, (whole, prefix, quote, hex) => {
        const color = visit(hex.toUpperCase(), field)
        return color === undefined || color.toUpperCase() === hex.toUpperCase() ? whole : `${prefix}${quote}${color}${quote}`
      })
    }
    if (!/\/\s*>$/.test(tag)) stack.push(name)
    return result
  })
  return { text, inherited }
}

function slidesFor(opened: OpenedPptx, ids: unknown): Slide[] {
  const requested = strings(ids, 'slideIds', 50)
  if (!requested.length) {
    if (opened.deck.slides.length > 50) throw new Error('超过 50 页，请用 slideIds 分批选择实际页面。')
    return opened.deck.slides
  }
  return requested.map((id) => {
    const slide = opened.deck.slides.find((s) => slideDurableId(s) === id)
    if (!slide) throw new Error(`找不到页面 ${id}；请 inspect outline，不要新建文稿。`)
    return slide
  })
}
function elementsFor(slides: Slide[], ids: unknown, excludes: unknown) {
  const selected = strings(ids, 'elementIds', 100), excluded = strings(excludes, 'excludeElementIds', 100)
  const available = new Set(slides.flatMap((s) => s.elements.map((e) => elementDurableId(e))))
  for (const id of [...selected, ...excluded]) if (!available.has(id)) throw new Error(`找不到顶层对象 ${id}；组合请使用组 ID，先读取当前页面。`)
  return (e: SlideElement) => (!selected.length || selected.includes(elementDurableId(e)!)) && !excluded.includes(elementDurableId(e)!)
}
function chartsIn(opened: OpenedPptx, slide: Slide, xml: string): string[] {
  const paths = new Set<string>()
  for (const match of xml.matchAll(/<c:chart\b[^>]*\br:id\s*=\s*(["'])[^"']+\1[^>]*\/?\s*>/g)) {
    const rid = ID.exec(match[0])?.[2], rel = rid ? opened.archive.readRels(slide.path).get(rid) : undefined
    if (!rel || rel.targetMode === 'External' || !rel.type.endsWith('/chart')) throw new Error('图表引用无效；未修改文稿。')
    const path = resolveTarget(slide.path, rel.target)
    if (!/^ppt\/charts\/[^/]+\.xml$/.test(path) || !opened.archive.has(path)) throw new Error('图表不在有效原生图表范围内。')
    paths.add(path)
  }
  return [...paths]
}
function elementText(e: SlideElement): string {
  if (e.type === 'group') return e.children.map(elementText).join(' ').slice(0, 80)
  return (e.type === 'shape' || e.type === 'text') ? (e.text?.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ') ?? '').slice(0, 80) : ''
}

export function inspectSlideColors(opened: OpenedPptx, query: Data) {
  const slides = slidesFor(opened, query.slideIds), select = elementsFor(slides, query.elementIds, undefined)
  const colors = new Map<string, { color: string; occurrences: number; properties: Set<string>; samples: Data[] }>()
  let inheritedReferences = 0, skippedObjects = 0
  for (const slide of slides) for (const element of slide.elements) {
    if (!select(element)) continue
    if (element.type === 'picture' || element.type === 'passthrough') { skippedObjects++; continue }
    const sample = { slideId: slideDurableId(slide), elementId: elementDurableId(element), type: element.type, text: elementText(element) }
    const visit = (hex: string, field: ColorField) => {
      const value = colors.get(hex) ?? { color: `#${hex}`, occurrences: 0, properties: new Set<string>(), samples: [] }
      value.occurrences++; value.properties.add(field)
      if (value.samples.length < 4 && !value.samples.some((s) => s.slideId === sample.slideId && s.elementId === sample.elementId)) value.samples.push(sample)
      colors.set(hex, value)
      return undefined
    }
    const xml = patchedElementXml(element)
    inheritedReferences += mapXmlColors(xml, visit).inherited
    for (const path of chartsIn(opened, slide, xml)) inheritedReferences += mapXmlColors(opened.archive.readText(path)!, visit, true).inherited
  }
  const values = [...colors.values()].sort((a, b) => b.occurrences - a.occurrences)
  return { mode: 'palette', slideIds: slides.map(slideDurableId), colors: values.slice(0, 64).map((c) => ({ ...c, properties: [...c.properties] })),
    totalColors: values.length, truncated: values.length > 64, inheritedReferences, skippedObjects, note: NOTE }
}

export function colorOperations(opened: OpenedPptx, payload: Data): Op[] {
  if (Object.keys(payload).some((k) => !['slideIds', 'elementIds', 'excludeElementIds', 'replacements', 'fields'].includes(k))) throw new Error('slide_replace_colors 只接受 slideIds/elementIds/excludeElementIds/replacements/fields。')
  replacements(payload.replacements); fields(payload.fields)
  const slides = slidesFor(opened, payload.slideIds), select = elementsFor(slides, payload.elementIds, payload.excludeElementIds)
  return slides.map((s) => ({ op: 'monaReplaceColors', target: { slide: slideDurableId(s) }, replacements: payload.replacements, fields: payload.fields,
    elementIds: s.elements.filter(select).map((e) => elementDurableId(e)!) }))
}

function plan(opened: OpenedPptx, slide: Slide, op: Op) {
  const map = replacements(op.replacements), allowed = fields(op.fields)
  const ids = strings(op.elementIds, 'elementIds', 2000)
  for (const id of ids) if (!slide.elements.some((e) => elementDurableId(e) === id)) throw new Error(`改色目标 ${id} 已变化，请重新读取。`)
  const elements: Array<{ element: SlideElement; xml: string }> = [], parts = new Map<string, string>(), changedIds: string[] = []
  let count = 0
  const visit = (hex: string, field: ColorField) => {
    const next = allowed.includes(field) ? map.get(hex) : undefined
    if (next !== undefined && next !== hex) count++
    return next
  }
  for (const element of slide.elements) {
    if (!ids.includes(elementDurableId(element)!) || element.type === 'picture' || element.type === 'passthrough') continue
    const before = count, xml = patchedElementXml(element), updated = mapXmlColors(xml, visit).text
    if (updated !== xml) elements.push({ element, xml: updated })
    if (allowed.includes('chart')) for (const path of chartsIn(opened, slide, xml)) {
      const original = opened.archive.readText(path)!, changed = mapXmlColors(original, visit, true).text
      if (changed === original) continue
      // Shared chart parts must not make a scoped recolor affect another frame or slide.
      let references = 0
      for (const s of opened.deck.slides) for (const e of s.elements) if (chartsIn(opened, s, patchedElementXml(e)).includes(path)) references++
      if (references > 1) throw new Error('该图表由多个对象共享，批量改色已取消以免影响未选对象；请使用单图表样式编辑。')
      parts.set(path, changed)
    }
    if (before !== count) changedIds.push(elementDurableId(element)!)
  }
  return { elements, parts, changedIds, count }
}

register({
  name: 'monaReplaceColors',
  validate(op, ctx) { const { slide } = resolveSlide(ctx, op); plan(ctx.opened, slide, op) },
  apply(op, ctx) {
    const { slide, index } = resolveSlide(ctx, op), result = plan(ctx.opened, slide, op)
    if (result.count) {
      for (const { element, xml } of result.elements) {
        element.anchor.originalXml = xml
        delete element.dirty; delete element.dirtyTransform; delete element.dirtyFill; delete element.dirtyStroke; delete element.dirtySrcRect; delete element.dirtyPPr
      }
      for (const [path, xml] of result.parts) ctx.opened.archive.entries.set(path, new TextEncoder().encode(xml))
      slide.structureDirty = true
      if (!materializeSlide(ctx.opened, index)) throw new Error('改色后无法重新解析页面，事务已取消。')
    }
    return { op, after: { colorReplacements: result.count, elementIds: result.changedIds } }
  },
})

export const replaceColorsCapability = {
  op: 'slide_replace_colors',
  description: '在当前文稿原位批量换色，不关闭、不新建、不重建页面。先 inspect palette/visual 判断品牌色，显式提供精确 from/to；保留文字、数据、位置、对象ID和透明度。可限定页面/顶层对象或排除特殊配色。图片及母版继承色不改。',
  supportedElementTypes: ['text', 'shape', 'chart', 'table', 'group'],
  payloadSchema: { type: 'object', additionalProperties: false, required: ['replacements'], properties: {
    replacements: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, to: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } } } },
    slideIds: { type: 'array', maxItems: 50, items: { type: 'string' }, description: '省略为当前文稿全部页（最多50页），不改变页面顺序。' },
    elementIds: { type: 'array', maxItems: 100, items: { type: 'string' }, description: '可选顶层对象ID；组ID表示组内非图片对象。' },
    excludeElementIds: { type: 'array', maxItems: 100, items: { type: 'string' }, description: '排除警告、正负值、人工特殊配色等对象。' },
    fields: { type: 'array', minItems: 1, items: { enum: FIELDS }, description: '可选text/fill/stroke/chart属性范围；省略为全部显式颜色。' },
  } },
}
