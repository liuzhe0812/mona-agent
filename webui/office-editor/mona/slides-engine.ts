import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { Buffer } from 'buffer'
import {
  parseClrMap,
  parseDecorations,
  parsePlaceholderMap,
  parseMasterTextStyles,
  parseSlide,
  parseTheme,
  preparePptxSave,
  savePptx,
  type OpenedPptx,
  type ParseContext,
  type Slide,
  type SlideDeck,
} from '@genoffice/pptx-engine'
import { parseDefaultTextStyle } from '../vendor/genoffice/packages/pptx-engine/src/placeholder'
import type { Relationship } from '../vendor/genoffice/packages/pptx-engine/src/zip'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import { slideFontMetrics } from './slides-font-metrics'

if (!globalThis.Buffer) globalThis.Buffer = Buffer

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'Relationship' || name === 'p:sldId',
})

type XmlNode = Record<string, unknown>

function asXmlNode(value: unknown): XmlNode {
  return value && typeof value === 'object' ? value as XmlNode : {}
}

function xmlArray(value: unknown): XmlNode[] {
  return Array.isArray(value)
    ? value.map(asXmlNode)
    : value ? [asXmlNode(value)] : []
}

interface BrowserArchive {
  entries: Map<string, Uint8Array>
  has: (path: string) => boolean
  readText: (path: string) => string | null
  readBytes: (path: string) => Uint8Array | null
  readRels: (partPath: string) => Map<string, Relationship>
  readPresentation: () => { size: SlideDeck['size']; slidePaths: string[] }
  resolveSlideChain: (slidePath: string) => { layoutPath?: string; masterPath?: string; themePath?: string }
}

function resolveTarget(basePart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const baseDir = basePart.slice(0, basePart.lastIndexOf('/'))
  const parts = baseDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  const dir = slash >= 0 ? partPath.slice(0, slash) : ''
  const file = slash >= 0 ? partPath.slice(slash + 1) : partPath
  return `${dir ? `${dir}/` : ''}_rels/${file}.rels`
}

function buildArchive(entries: Map<string, Uint8Array>): BrowserArchive {
  const readText = (path: string): string | null => {
    const bytes = entries.get(path)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
  const readRels = (partPath: string): Map<string, Relationship> => {
    const rels = new Map<string, Relationship>()
    const xml = readText(relsPathFor(partPath))
    if (!xml) return rels
    const parsed = xmlParser.parse(xml)
    const root = asXmlNode(asXmlNode(parsed).Relationships)
    for (const raw of xmlArray(root.Relationship)) {
      const id = String(raw['@_Id'] ?? '')
      if (!id) continue
      rels.set(id, {
        id,
        type: String(raw['@_Type'] ?? ''),
        target: String(raw['@_Target'] ?? ''),
        ...(raw['@_TargetMode'] != null ? { targetMode: String(raw['@_TargetMode']) } : {}),
      })
    }
    return rels
  }
  const readPresentation = (): { size: SlideDeck['size']; slidePaths: string[] } => {
    const xml = readText('ppt/presentation.xml')
    if (!xml) throw new Error('pptx 缺少 presentation.xml。')
    const parsed = asXmlNode(xmlParser.parse(xml))
    const root = asXmlNode(parsed['p:presentation'] ?? parsed.presentation)
    const sizeNode = asXmlNode(root['p:sldSz'] ?? root.sldSz)
    const size = {
      cx: Number(sizeNode['@_cx'] ?? 9144000),
      cy: Number(sizeNode['@_cy'] ?? 6858000),
    }
    const rels = readRels('ppt/presentation.xml')
    const list = asXmlNode(root['p:sldIdLst'] ?? root.sldIdLst)
    const slidePaths: string[] = []
    for (const id of xmlArray(list['p:sldId'])) {
      const relId = id['@_r:id'] ?? id['@_id']
      const rel = relId == null ? undefined : rels.get(String(relId))
      if (rel) slidePaths.push(resolveTarget('ppt/presentation.xml', rel.target))
    }
    return { size, slidePaths }
  }
  const resolveSlideChain = (slidePath: string) => {
    const slideRels = readRels(slidePath)
    const layout = [...slideRels.values()].find((rel) => rel.type.endsWith('/slideLayout'))
    const layoutPath = layout ? resolveTarget(slidePath, layout.target) : undefined
    const layoutRels = layoutPath ? readRels(layoutPath) : new Map<string, Relationship>()
    const master = [...layoutRels.values()].find((rel) => rel.type.endsWith('/slideMaster'))
    const masterPath = master && layoutPath ? resolveTarget(layoutPath, master.target) : undefined
    const masterRels = masterPath ? readRels(masterPath) : new Map<string, Relationship>()
    const theme = [...masterRels.values()].find((rel) => rel.type.endsWith('/theme'))
    const themePath = theme && masterPath ? resolveTarget(masterPath, theme.target) : undefined
    return { layoutPath, masterPath, themePath }
  }
  return {
    entries,
    has: (path) => entries.has(path),
    readText,
    readBytes: (path) => entries.get(path) ?? null,
    readRels,
    readPresentation,
    resolveSlideChain,
  }
}

function partMediaRels(archive: BrowserArchive, partPath: string): Map<string, string> {
  const media = new Map<string, string>()
  for (const rel of archive.readRels(partPath).values()) {
    if (rel.type.endsWith('/image')) media.set(rel.id, resolveTarget(partPath, rel.target))
  }
  return media
}

function parseSlideForBrowser(archive: BrowserArchive, slidePath: string): Slide | null {
  const slideXml = archive.readText(slidePath)
  if (!slideXml) return null
  const chain = archive.resolveSlideChain(slidePath)
  const layoutXml = chain.layoutPath ? archive.readText(chain.layoutPath) ?? undefined : undefined
  const masterXml = chain.masterPath ? archive.readText(chain.masterPath) ?? undefined : undefined
  const context: ParseContext = {}
  if (chain.themePath) {
    const themeXml = archive.readText(chain.themePath)
    if (themeXml) {
      context.theme = parseTheme(themeXml)
      context.theme.clrMap = parseClrMap(masterXml, layoutXml, slideXml)
      context.themeMediaRels = partMediaRels(archive, chain.themePath)
    }
  }
  if (layoutXml) {
    context.layoutPlaceholders = parsePlaceholderMap(layoutXml, context.theme)
    context.layoutBg = layoutXml
    if (chain.layoutPath) context.layoutMediaRels = partMediaRels(archive, chain.layoutPath)
  }
  if (masterXml) {
    context.masterPlaceholders = parsePlaceholderMap(masterXml, context.theme)
    context.masterTextStyles = parseMasterTextStyles(masterXml, context.theme)
    context.masterBg = masterXml
    if (chain.masterPath) context.masterMediaRels = partMediaRels(archive, chain.masterPath)
  }
  const presentationXml = archive.readText('ppt/presentation.xml')
  if (presentationXml) context.defaultTextStyle = parseDefaultTextStyle(presentationXml, context.theme)

  const mediaRels = new Map<string, string>()
  const chartXmls = new Map<string, string>()
  const chartMediaRels = new Map<string, Map<string, string>>()
  const hyperlinks = new Map<string, string>()
  const slideOrder = archive.readPresentation().slidePaths
  for (const rel of archive.readRels(slidePath).values()) {
    if (rel.type.endsWith('/image')) {
      mediaRels.set(rel.id, resolveTarget(slidePath, rel.target))
    } else if (rel.type.endsWith('/hyperlink')) {
      hyperlinks.set(rel.id, rel.target)
    } else if (rel.type.endsWith('/slide')) {
      const target = slideOrder.indexOf(resolveTarget(slidePath, rel.target))
      if (target >= 0) hyperlinks.set(rel.id, `slide:${target}`)
    } else if (rel.type.endsWith('/chart') || rel.type.endsWith('/chartEx')) {
      const chartPath = resolveTarget(slidePath, rel.target)
      const chartXml = archive.readText(chartPath)
      if (chartXml) {
        chartXmls.set(rel.id, chartXml)
        chartMediaRels.set(rel.id, partMediaRels(archive, chartPath))
      }
    }
  }
  context.mediaRels = mediaRels
  context.hlinkRels = hyperlinks
  context.chartXmls = chartXmls
  if (chartMediaRels.size) context.chartMediaRels = chartMediaRels
  context.tableStyles = archive.readText('ppt/tableStyles.xml') ?? undefined
  const slide = parseSlide({
    path: slidePath,
    slideXml,
    layoutPath: chain.layoutPath,
    masterPath: chain.masterPath,
    ctx: context,
  })
  const decorations: Slide['elements'] = []
  if (masterXml && chain.masterPath) {
    decorations.push(...parseDecorations(masterXml, {
      theme: context.theme,
      mediaRels: partMediaRels(archive, chain.masterPath),
    }))
  }
  if (layoutXml && chain.layoutPath) {
    decorations.push(...parseDecorations(layoutXml, {
      theme: context.theme,
      mediaRels: partMediaRels(archive, chain.layoutPath),
      masterPlaceholders: context.masterPlaceholders,
      masterTextStyles: context.masterTextStyles,
    }))
  }
  if (decorations.length) slide.decorations = decorations
  return slide
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 0x8000)))
  }
  return btoa(binary)
}

function mediaMime(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return {
    bmp: 'image/bmp',
    emf: 'image/emf',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    wmf: 'image/wmf',
  }[ext]
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return ''
  const copy = bytes.slice()
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

export interface SlidesDocument {
  opened: OpenedPptx
  slides: RenderSlide[]
  media: Map<string, string>
  mediaBytes?: Map<string, Uint8Array>
}

export function refreshSlidesDocument(
  document: SlidesDocument,
  fitWidthPx = 1280,
  affectedPaths?: ReadonlySet<string>,
): SlidesDocument {
  const entries = document.opened.archive.entries as Map<string, Uint8Array>
  const media = new Map<string, string>()
  const mediaBytes = new Map<string, Uint8Array>()
  let sharedMediaChanged = false
  for (const [path, data] of entries) {
    const mime = mediaMime(path)
    if (!mime) continue
    const previous = document.mediaBytes?.get(path)
    mediaBytes.set(path, data)
    if (previous === data && document.media.has(path)) media.set(path, document.media.get(path)!)
    else {
      media.set(path, `data:${mime};base64,${bytesToBase64(data)}`)
      if (previous) sharedMediaChanged = true
    }
  }
  const mediaResolver = (path: string): string | undefined => media.get(path)
  const slides = document.opened.deck.slides.map((slide, index) => {
    const previous = document.slides[index]
    if (affectedPaths && !sharedMediaChanged && !affectedPaths.has(slide.path)
      && previous?.widthPx === fitWidthPx) return previous
    return buildRenderSlide(slide, document.opened.deck.size, {
      fitWidthPx, media: mediaResolver, slideNo: index + 1, metrics: slideFontMetrics(),
    })
  })
  return { opened: document.opened, slides, media, mediaBytes }
}

export function snapshotSlidesDocument(opened: OpenedPptx): () => Promise<ArrayBuffer> {
  const save = preparePptxSave(opened)
  let file: Promise<ArrayBuffer> | undefined
  return () => file ??= save().then(asArrayBuffer)
}

export async function openSlidesDocument(
  file: ArrayBuffer,
  fitWidthPx = 1280,
): Promise<SlidesDocument> {
  const bytes = new Uint8Array(file.slice(0))
  const zip = await JSZip.loadAsync(bytes)
  const entries = new Map<string, Uint8Array>()
  for (const [path, item] of Object.entries(zip.files)) {
    if (!item.dir) entries.set(path, await item.async('uint8array'))
  }
  const archive = buildArchive(entries)
  const presentation = archive.readPresentation()
  const slides = presentation.slidePaths
    .map((path) => parseSlideForBrowser(archive, path))
    .filter((slide): slide is Slide => slide !== null)
  if (slides.length === 0) throw new Error('PPTX 中没有可显示的幻灯片。')
  const opened = {
    deck: { slides, size: presentation.size, originalHash: await sha256(bytes) },
    archive,
  } as unknown as OpenedPptx
  return refreshSlidesDocument({ opened, slides: [], media: new Map() }, fitWidthPx)
}

export async function saveSlidesDocument(opened: OpenedPptx): Promise<ArrayBuffer> {
  return asArrayBuffer(await savePptx(opened))
}

export function slideText(slide: RenderSlide): string {
  const chunks: string[] = []
  const visit = (node: RenderSlide['nodes'][number]): void => {
    if ((node.type === 'shape' || node.type === 'text') && node.text) {
      chunks.push(node.text.lines.flatMap((line) => line.runs.map((run) => run.text)).join(''))
    } else if (node.type === 'group') {
      node.children.forEach(visit)
    } else if (node.type === 'table') {
      node.cells.forEach((cell) => {
        if (cell.text) chunks.push(cell.text.lines.flatMap((line) => line.runs.map((run) => run.text)).join(''))
      })
    }
  }
  slide.nodes.forEach(visit)
  return chunks.join('\n')
}

export function slideMediaCount(slide: RenderSlide): number {
  let count = 0
  const visit = (node: RenderSlide['nodes'][number]): void => {
    if (node.type === 'picture' && node.dataUrl) count += 1
    else if (node.type === 'group') node.children.forEach(visit)
  }
  slide.nodes.forEach(visit)
  return count
}
