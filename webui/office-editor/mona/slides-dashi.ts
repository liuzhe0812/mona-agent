import templates from '../../../mona/skills/mona-pptx/assets/dashi/templates.json'
import selection from './presets/dashi-selection.json'
import { materializeSlide, materializeSlideBundle, elementDurableId, elementSpid, type OpenedPptx, type SlideBundle } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { importSourceLayout } from '../vendor/genoffice/packages/pptx-engine/src/slide-transfer'
import { relsPathFor } from '../vendor/genoffice/packages/pptx-engine/src/zip'
import { register, resolveSlide, type Op } from '../vendor/genoffice/apps/slides/src/main/ops/registry'
import { dataUrlImage } from './slides-assets'
import { slideFontMetrics } from './slides-font-metrics'
import { renderedTextBounds } from './slides-layout'

interface TemplateField { path: string; defaultValue: string; textIndexes: number[]; maxChars?: number }
interface Part { xml?: string; base64?: string; assetId?: string }
interface SourceTextLayout {
  xmlTextIndex: number | null; fontSizePx: number; lineHeightPx: number | null
  letterSpacingPx: number | null; baselinePx: number; fontFamily: string
  sourceTextNodeIndex?: number
  rect?: {x: number; y: number; w: number; h: number}
}
interface BundleData extends Omit<SlideBundle, 'parts' | 'chain'> {
  partRefs: Record<string, string>
  chain?: Omit<NonNullable<SlideBundle['chain']>, 'parts'> & { partRefs: Record<string, string> }
}
interface TemplatePage {
  id: string; source?: {theme: string; layoutId: string; label: string; roles: string[]}; bundle: BundleData; fields: TemplateField[]; assetIds: string[]
  fallbackWarnings?: unknown[]
  textLayout?: SourceTextLayout[]
}
const catalog = templates as unknown as { schemaVersion: number; pages: TemplatePage[]; parts: Record<string, Part> }
const pages = new Map(catalog.pages.map((page) => [page.id, page]))

function pageFor(id: unknown): TemplatePage {
  const page = typeof id === 'string' ? pages.get(id) : undefined
  if (!page) throw new Error('请选择目录中登记的 Dashi 模板 ID。')
  return page
}

function fieldValues(page: TemplatePage, value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fields 需要目录中的字段名与文本。')
  const known = new Map(page.fields.filter((field) => field.textIndexes.length).map((field) => [field.path, field]))
  for (const [name, text] of Object.entries(value)) {
    const field = known.get(name)
    if (!field || typeof text !== 'string') throw new Error(`模板不支持文本字段 ${name}；请读取实际字段目录。`)
    // Never silently shorten source facts. Longer copy needs a different page or native editing.
    const limit = field.maxChars ?? Math.max(32, field.defaultValue.length * 3)
    if ([...text].length > limit) throw new Error(`字段 ${name} 超过 ${limit} 字，请换页型或原生排版。`)
  }
  return value as Record<string, string>
}

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function bindDashiText(page: TemplatePage, values: Record<string, string>): string {
  const replacements = new Map<number, string>()
  for (const field of page.fields) if (field.path in values) {
    for (const index of field.textIndexes) replacements.set(index, values[field.path]!)
  }
  let index = 0
  return page.bundle.slideXml.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/g, (whole, open, close) => {
    const replacement = replacements.get(index++)
    return replacement === undefined ? whole : `${open}${xmlText(replacement)}${close}`
  })
}

/** Scale physical DrawingML units; custom-path coordinates and percentages stay in their own coordinate system. */
export function scaleDashiXml(xml: string, scale: number): string {
  return xml.replace(/<(?:a|p):([\w]+)\b[^>]*>/g, (tag, name: string) => {
    if (['latin', 'ea', 'cs'].includes(name)) return tag.replace(/typeface="([^"]*)"/, (_whole: string, font: string) =>
      `typeface="${['Microsoft YaHei', 'Arial', 'Consolas', 'SimSun', 'Georgia'].includes(font) ? font : /mono|consolas|courier/i.test(font) ? 'Consolas' : /serif|song|ming|newsreader|bodoni|garamond|playfair/i.test(font) && !/sans/i.test(font) ? 'SimSun' : 'Microsoft YaHei'}"`)
    const attributes = ['off', 'ext', 'chOff', 'chExt'].includes(name) ? ['x', 'y', 'cx', 'cy']
      : ['rPr', 'defRPr', 'endParaRPr'].includes(name) ? ['sz', 'spc', 'kern']
      : name === 'bodyPr' ? ['lIns', 'rIns', 'tIns', 'bIns']
      : name === 'pPr' ? ['marL', 'marR', 'indent']
      : name === 'ln' ? ['w']
      : ['outerShdw', 'innerShdw', 'glow', 'softEdge', 'blur'].includes(name) ? ['blurRad', 'dist', 'rad']
      : name === 'spcPts' ? ['val'] : []
    return tag.replace(/\b([\w]+)="(-?\d+)"/g, (whole: string, attr: string, value: string) =>
      attributes.includes(attr) ? `${attr}="${Math.round(Number(value) * scale)}"` : whole)
  })
}

function sourceTextLayout(page: TemplatePage, values: Record<string, string>) {
  const xml = bindDashiText(page, values)
  const positions = [...xml.matchAll(/<a:t\b/g)].map((match) => match.index!)
  const evidence = new Map((page.textLayout ?? []).filter((record) => record.xmlTextIndex !== null).map((record) => [record.xmlTextIndex, record]))
  const layouts = new Map<string, SourceTextLayout>()
  const pointScale = page.bundle.slideSize!.cx / 914400 * 72 / 1920
  const updated = xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (block, offset: number) => {
    const index = positions.findIndex((position) => position >= offset && position < offset + block.length)
    const record = evidence.get(index)
    const spid = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(block)?.[1]
    if (!record || !spid) return block
    layouts.set(spid, record)
    const family = record.fontFamily
    const serif = /newsreader|bodoni|garamond|playfair|noto serif|cormorant|georgia/i.test(family) || (/\bserif\b/i.test(family) && !/sans-serif/i.test(family))
    const cjk = /[\u3400-\u9fff]/.test([...block.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => match[1]).join(''))
    const mappedFont = /mono|consolas|courier/i.test(family) ? 'Consolas' : serif ? (cjk ? 'SimSun' : 'Georgia') : cjk ? 'Microsoft YaHei' : 'Arial'
    let result = block.replace(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*>/g, (tag) => {
      const set = (name: string, value: number) => {
        const attr = `${name}="${Math.round(value * pointScale * 100)}"`
        tag = new RegExp(`\\b${name}="[^"]*"`).test(tag) ? tag.replace(new RegExp(`\\b${name}="[^"]*"`), attr) : tag.replace(/\/?\s*>$/, (close) => ` ${attr}${close}`)
      }
      set('sz', record.fontSizePx)
      if (record.letterSpacingPx !== null) set('spc', record.letterSpacingPx)
      return tag
    })
    if (record.lineHeightPx !== null) result = result.replace(/<a:lnSpc\b[\s\S]*?<\/a:lnSpc>/g,
      `<a:lnSpc><a:spcPts val="${Math.round(record.lineHeightPx * pointScale * 100)}"/></a:lnSpc>`)
    result = result.replace(/(<a:(?:latin|ea|cs)\b[^>]*typeface=")[^"]*(")/g, `$1${mappedFont}$2`)
    // SVG runs can inherit a theme face; make the measured CSS family explicit too.
    return result.replace(/<a:(rPr|defRPr|endParaRPr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)/g, (_whole, name: string, attrs: string, body = '') => {
      const faces = ['latin','ea','cs'].filter((face) => !new RegExp(`<a:${face}\\b`).test(body)).map((face) => `<a:${face} typeface="${mappedFont}"/>`).join('')
      return `<a:${name}${attrs}>${body}${faces}</a:${name}>`
    })
  })
  return {xml: mergeInlineText(updated,layouts), layouts}
}

function mergeInlineText(xml: string, layouts: Map<string, SourceTextLayout>): string {
  const spans = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].flatMap((match) => {
    const block = match[0], texts = [...block.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    const id = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(block)?.[1]
    const source = id ? layouts.get(id) : undefined
    const run = /<a:r\b[^>]*>[\s\S]*?<\/a:r>/.exec(block)?.[0]
    const style = run ? /<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(run)?.[0] : undefined
    return texts.length === 1 && source?.rect && run && style ? [{block, text:texts[0]![1]!, source, run, style}] : []
  })
  const removed = new Set<string>(), replacements = new Map<string,string>()
  for (const parent of spans) {
    const children = spans.filter((child) => {
      if (child === parent || !child.text.trim() || !parent.text.includes(child.text) || parent.text === child.text
        || parent.text.indexOf(child.text)!==parent.text.lastIndexOf(child.text)) return false
      const a=parent.source.rect!, b=child.source.rect!
      return Math.abs(parent.source.baselinePx-child.source.baselinePx)<4 && b.x>=a.x-2 && b.x+b.w<=a.x+a.w+2
    }).sort((a,b)=>a.source.rect!.x-b.source.rect!.x)
    if (!children.length) continue
    let rest=parent.text, rich=''
    for (const child of children) {
      const at=rest.indexOf(child.text)
      if (at<0 || removed.has(child.block)) continue
      rich+=`<a:r>${parent.style}<a:t xml:space="preserve">${rest.slice(0,at)}</a:t></a:r>`
        +`<a:r>${child.style}<a:t>${child.text}</a:t></a:r>`
      rest=rest.slice(at+child.text.length)
      removed.add(child.block)
    }
    if (rich) replacements.set(parent.block,parent.block.replace(parent.run,`${rich}<a:r>${parent.style}<a:t xml:space="preserve">${rest}</a:t></a:r>`))
  }
  // The source exporter can emit a full line plus its highlighted spans twice.
  return xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g,(block)=>removed.has(block)?'':replacements.get(block)??block)
}

function partData(refs: Record<string, string>, assets: Record<string, unknown>, scale: number): Record<string, string> {
  return Object.fromEntries(Object.entries(refs).map(([path, hash]) => {
    const part = catalog.parts[hash]
    if (!part) throw new Error('模板依赖资源缺失。')
    let base64: string
    if (part.xml !== undefined) base64 = Buffer.from(scaleDashiXml(part.xml, scale)).toString('base64')
    else if (part.assetId) {
      const dataUrl = assets[part.assetId]
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw new Error(`模板素材 ${part.assetId} 未准备好。`)
      const image = dataUrlImage(dataUrl)
      base64 = Buffer.from(image.bytes).toString('base64')
    } else if (part.base64 !== undefined) base64 = part.base64
    else throw new Error('模板依赖资源格式无效。')
    return [path, base64]
  }))
}

export function dashiTemplateCatalog(scenario?: string, templateId?: string) {
  const scenes = (selection as unknown as { scenarios: Array<{ id: string; label: string; pages: Array<{ sourceLayoutId?: string; id?: string }> }> }).scenarios
  if (scenario && !scenes.some((scene) => scene.id === scenario)) throw new Error('未知用途场景。')
  if (templateId) pageFor(templateId)
  const ids = scenario ? new Set(scenes.find((scene) => scene.id === scenario)!.pages.map((page) => page.sourceLayoutId ?? page.id)) : null
  return catalog.pages.filter((page) => (!ids || ids.has(page.id)) && (!templateId || page.id === templateId)).map((page) => ({
    id: page.id, source: page.source ? {theme:page.source.theme,layoutId:page.source.layoutId,label:page.source.label,roles:page.source.roles} : undefined,
    scenarios: scenes.filter((scene) => scene.pages.some((p) => (p.sourceLayoutId ?? p.id) === page.id)).map((s) => s.id),
    editable: ['text', 'shape'], graphics: page.fallbackWarnings?.length ? '部分装饰或 SVG 图形保留为图片；没有原生图表数据表' : '原生对象与独立素材',
    ...(templateId ? { fields: page.fields.filter((field) => field.textIndexes.length).map((field) => ({name: field.path, example: field.defaultValue, maxChars: field.maxChars ?? Math.max(32, field.defaultValue.length * 3)})) } : { fieldNames: page.fields.filter((field) => field.textIndexes.length).map((field) => field.path) }),
  }))
}

export function dashiScenarioCatalog() {
  const scenes = (selection as unknown as {scenarios: Array<{id: string; label: string; sourceThemes: string[]; pages: Array<{sourceLayoutId: string; role: string; label: string}>}>}).scenarios
  return scenes.map((scene) => ({id: scene.id, label: scene.label, sourceThemes: scene.sourceThemes, pageCount: scene.pages.length}))
}

export function dashiOperation(payload: Record<string, unknown>): Op {
  if (Object.keys(payload).some((key) => !['slideId', 'templateId', 'fields', 'templateAssets'].includes(key))) throw new Error('模板只接受 slideId、templateId、fields。')
  const page = pageFor(payload.templateId)
  fieldValues(page, payload.fields)
  return {op: 'monaDashiTemplate', target: {slide: String(payload.slideId)}, templateId: page.id, fields: payload.fields, templateAssets: payload.templateAssets}
}

function fitTemplateTextFrames(opened: OpenedPptx, index: number): void {
  const slide = opened.deck.slides[index]!
  const units = opened.deck.size.cx / 1280
  const previous = new Map<string, {x: number; y: number}>()
  const rendered = buildRenderSlide(slide, opened.deck.size, {fitWidthPx:1280,metrics:slideFontMetrics()})
  for (const node of rendered.nodes) {
    if ((node.type !== 'shape' && node.type !== 'text') || !node.text) continue
    const element = slide.elements.find((element) => elementDurableId(element) === node.durableId)
    const run = node.text.lines[0]?.runs[0]
    if (!element || !run) continue
    const runs = node.text.lines.flatMap((line) => line.runs)
    const vertical = runs.some((run)=>run.rotate90||run.rotate270)
    const ink=renderedTextBounds(node.text,0,0)
    const left = Math.min(0, ...runs.map((run) => run.x), ...ink.map((box)=>box.x))
    const right = Math.max(...runs.map((run) => run.x + run.widthPx), ...ink.map((box)=>box.x+box.w))
    const top=Math.min(0,...ink.map((box)=>box.y))
    const bottom = Math.max(node.text.contentHeight, ...node.text.lines.map((line) => line.top + line.height), ...ink.map((box)=>box.y+box.h))
    const width = Math.max(node.box.w, vertical ? Math.max(...ink.map((box)=>box.x+box.w))-Math.min(0,...ink.map((box)=>box.x))+2 : right - left + node.text.insets.l + node.text.insets.r + 2)
    const height = Math.max(node.box.h, bottom - top + node.text.insets.t + node.text.insets.b + 2)
    if (width === node.box.w && height === node.box.h) continue
    const painted=renderedTextBounds(node.text,node.box.x,node.box.y,node.box)[0]
    if (!painted) continue
    previous.set(String(elementSpid(element)), {x:painted.x,y:painted.y})
    element.transform.offset.cx = Math.ceil(width * units)
    element.transform.offset.cy = Math.ceil(height * units)
    element.dirtyTransform = true
  }
  if (!previous.size) return
  let fresh = materializeSlide(opened, index)!
  const adjusted = buildRenderSlide(fresh, opened.deck.size, {fitWidthPx:1280,metrics:slideFontMetrics()})
  for (const node of adjusted.nodes) {
    if ((node.type !== 'shape' && node.type !== 'text') || !node.text) continue
    const painted=renderedTextBounds(node.text,node.box.x,node.box.y,node.box)[0]
    const element = fresh.elements.find((element) => elementDurableId(element) === node.durableId)
    const old = element ? previous.get(String(elementSpid(element))) : undefined
    if (!old || !painted || !element) continue
    // Resizing a middle/right anchored box must not move its visible copy.
    element.transform.offset.x += Math.round((old.x - painted.x) * units)
    element.transform.offset.y += Math.round((old.y - painted.y) * units)
    element.dirtyTransform = true
  }
  if (!materializeSlide(opened, index)) throw new Error('模板文字区域无法适配系统字体。')
}

function fitTemplateInlineSpacing(opened: OpenedPptx, index: number, layouts: Map<string, SourceTextLayout>): void {
  const slide = opened.deck.slides[index]!
  const rendered = buildRenderSlide(slide, opened.deck.size, {fitWidthPx:1280,metrics:slideFontMetrics()})
  const spans = rendered.nodes.flatMap((node) => {
    if ((node.type !== 'shape' && node.type !== 'text') || !node.text || node.box.rotationDeg) return []
    const element = slide.elements.find((element) => elementDurableId(element) === node.durableId)
    const source = element ? layouts.get(String(elementSpid(element))) : undefined
    return element && source?.rect ? [{element, source, text:node.text.lines.flatMap((line)=>line.runs.map((run)=>run.text)).join(''), bounds:renderedTextBounds(node.text,node.box.x,node.box.y)}] : []
  }).sort((a,b) => a.source.rect!.x - b.source.rect!.x)
  let changed = false
  for (const first of spans) for (const second of spans) {
    const a = first.source.rect!, b = second.source.rect!
    const gap = b.x - a.x - a.w
    const adjacentGap = Math.min(48,Math.max(first.source.fontSizePx,second.source.fontSizePx)*0.4)
    if (first === second || gap < -12 || gap > adjacentGap || Math.min(a.y+a.h,b.y+b.h) <= Math.max(a.y,b.y)) continue
    const shift = Math.max(0, ...first.bounds.flatMap((left) => second.bounds.map((right) =>
      Math.min(left.y+left.h,right.y+right.h) > Math.max(left.y,right.y)
        ? left.x + left.w + 2 - right.x : 0)))
    if (shift <= 0) continue
    // Inline copy keeps its source order when a substitute font has wider glyphs.
    second.element.transform.offset.x += Math.ceil(shift * opened.deck.size.cx / 1280)
    second.element.dirtyTransform = true
    for (const box of second.bounds) box.x += shift
    changed = true
  }
  const stacked = spans.filter((span)=>/^[\u3400-\u9fff]$/.test(span.text)
    && span.source.lineHeightPx !== null && span.source.lineHeightPx<span.source.fontSizePx).sort((a,b)=>a.source.rect!.y-b.source.rect!.y)
  for (let index=1; index<stacked.length; index++) {
    const current=stacked[index]!
    const shift=Math.max(0,...stacked.slice(0,index).flatMap((previous)=>previous.bounds.flatMap((a)=>current.bounds.map((b)=>
      Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x) ? a.y+a.h+2-b.y : 0))))
    if (!shift) continue
    current.element.transform.offset.y+=Math.ceil(shift*opened.deck.size.cx/1280)
    current.element.dirtyTransform=true
    for (const box of current.bounds) box.y+=shift
    changed=true
  }
  const lines=spans.filter((span)=>span.source.sourceTextNodeIndex!==undefined).sort((a,b)=>a.source.baselinePx-b.source.baselinePx)
  for (const current of lines) {
    const earlier=lines.filter((span)=>span.source.sourceTextNodeIndex===current.source.sourceTextNodeIndex
      && span.source.baselinePx<current.source.baselinePx-4)
    const shift=Math.max(0,...earlier.flatMap((previous)=>previous.bounds.flatMap((a)=>current.bounds.map((b)=>
      Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x) ? a.y+a.h+2-b.y : 0))))
    if (!shift) continue
    current.element.transform.offset.y+=Math.ceil(shift*opened.deck.size.cx/1280)
    current.element.dirtyTransform=true
    for (const box of current.bounds) box.y+=shift
    changed=true
  }
  for (const quote of spans.filter((span)=>span.text==='“'&&span.source.fontSizePx>=96)) {
    const overlapping=spans.filter((span)=>span!==quote&&quote.bounds.some((a)=>span.bounds.some((b)=>
      Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y))))
    if (!overlapping.length) continue
    const shift=Math.min(...overlapping.flatMap((span)=>span.bounds.map((box)=>box.y)))-Math.max(...quote.bounds.map((box)=>box.y+box.h))-2
    quote.element.transform.offset.y+=Math.floor(shift*opened.deck.size.cx/1280)
    quote.element.dirtyTransform=true
    changed=true
  }
  if (changed && !materializeSlide(opened,index)) throw new Error('模板内联文字间距无法应用。')
}

register({
  name: 'monaDashiTemplate',
  validate(op, ctx) {
    const {slide} = resolveSlide(ctx, op)
    if (slide.elements.length) throw new Error('整页模板只能填入空白页；已有内容请按对象 ID 修改。')
    fieldValues(pageFor(op.templateId), op.fields)
    const size = pageFor(op.templateId).bundle.slideSize!
    if (Math.abs(ctx.opened.deck.size.cx / size.cx - ctx.opened.deck.size.cy / size.cy) > 0.001) throw new Error('Dashi 模板适用于 16:9 页面，请保持页面比例。')
  },
  apply(op, ctx) {
    const {slide, index} = resolveSlide(ctx, op), page = pageFor(op.templateId)
    if (slide.elements.length) throw new Error('整页模板只能填入空白页；本次事务已增加的内容也必须保留。')
    const scale = ctx.opened.deck.size.cx / page.bundle.slideSize!.cx
    const assets = (op.templateAssets ?? {}) as Record<string, unknown>
    const values = fieldValues(page, op.fields)
    const text = sourceTextLayout(page, values)
    const {chain, partRefs: _partRefs, ...data} = page.bundle
    const bundle: SlideBundle = {
      ...data, slideXml: scaleDashiXml(text.xml, scale),
      parts: partData(page.bundle.partRefs, assets, scale),
      ...(chain ? {chain: {...chain, parts: partData(chain.partRefs, assets, scale)}} : {}),
    }
    const layout = importSourceLayout(ctx.opened.archive, bundle)
    if (!layout) throw new Error('模板母版无法导入，已取消本页写入。')
    const rels = materializeSlideBundle(ctx.opened.archive, bundle, slide.path, layout)
    ctx.opened.archive.entries.set(relsPathFor(slide.path), new TextEncoder().encode(rels))
    // Reparse into the existing slide part: durable slide ID and page order stay stable.
    slide.bodyPrefix = bundle.slideXml; slide.bodySuffix = ''; slide.elements = []; slide.structureDirty = true
    let fresh = materializeSlide(ctx.opened, index)
    if (!fresh) throw new Error('模板原生对象解析失败，已取消本页写入。')
    // Align actual source CSS baselines to PowerPoint's line model after font substitution.
    const rendered = buildRenderSlide(fresh, ctx.opened.deck.size, {fitWidthPx:1920,metrics:slideFontMetrics()})
    for (const node of rendered.nodes) {
      if (node.type !== 'shape' && node.type !== 'text') continue
      const run = node.text?.lines[0]?.runs[0]
      const element = fresh.elements.find((element) => elementDurableId(element) === node.durableId)
      const source = element ? text.layouts.get(String(elementSpid(element))) : undefined
      if (!source || !run || !element) continue
      if (Math.abs(node.box.rotationDeg) > 10) {
        if (!source.rect) continue
        const ink = renderedTextBounds(node.text,node.box.x,node.box.y,node.box)
        if (!ink.length) continue
        element.transform.offset.x += Math.round((source.rect.x-Math.min(...ink.map((box)=>box.x))) * ctx.opened.deck.size.cx / 1920)
        element.transform.offset.y += Math.round((source.rect.y-Math.min(...ink.map((box)=>box.y))) * ctx.opened.deck.size.cx / 1920)
        element.dirtyTransform = true
        continue
      }
      if (run.rotate90 || run.rotate270) continue
      const delta = source.baselinePx - (node.box.y + node.text!.insets.t + run.baselineY)
      element.transform.offset.y += Math.round(delta * ctx.opened.deck.size.cx / 1920)
      if (source.rect) element.transform.offset.x += Math.round((source.rect.x - node.box.x - node.text!.insets.l - run.x) * ctx.opened.deck.size.cx / 1920)
      element.dirtyTransform = true
    }
    fresh = materializeSlide(ctx.opened, index)
    if (!fresh) throw new Error('模板文字位置无法应用，已取消本页写入。')
    fitTemplateTextFrames(ctx.opened, index)
    fitTemplateInlineSpacing(ctx.opened,index,text.layouts)
    fresh = ctx.opened.deck.slides[index]!
    return {op, created: fresh.elements.map((element) => elementDurableId(element)!).filter(Boolean), after: {templateId: page.id, fields: Object.keys(values)}}
  },
})

export const dashiCapability = {
  op: 'slide_add_template', description: '按用途复用真实 Dashi 原生模板，填入空白页并保留可编辑文字、形状与独立素材。先用 capabilities 的 templateId 读取文本字段；复杂 SVG 图形为图片，改图表数据用原生图表操作。',
  payloadSchema: {type: 'object', additionalProperties: false, required: ['slideId', 'templateId'], properties: {
    slideId: {type: 'string'}, templateId: {type: 'string', enum: catalog.pages.map((page) => page.id)},
    fields: {type: 'object', additionalProperties: {type: 'string'}, description: '实际目录中的文本字段名。省略字段保留模板示例；制作成稿必须替换示例内容，不能将示例数字冒充真实证据。'},
  }},
}
