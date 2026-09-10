import { XMLParser, XMLValidator } from 'fast-xml-parser'

const MAX_SVG_BYTES = 1_048_576
const MAX_IMAGE_DATA_URL_LENGTH = 14_000_000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XML_NAMED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
const SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'title',
  'desc',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'use',
])
const SVG_UNSAFE_TAGS = new Set(['script', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'animatecolor', 'set', 'discard', 'mpath'])
const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/

type ParsedXmlNode = Record<string, unknown>

interface SvgValidationState {
  ids: Set<string>
  references: string[]
  rootPrefix: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function localName(name: string): string {
  const separator = name.indexOf(':')
  return separator >= 0 ? name.slice(separator + 1) : name
}

function namespacePrefix(name: string): string | null {
  const separator = name.indexOf(':')
  return separator >= 0 ? name.slice(0, separator) : null
}

function attributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([name, attributeValue]) => [
      name.startsWith('@_') ? name.slice(2) : name,
      String(attributeValue),
    ]),
  )
}

function rejectXmlDeclarations(svg: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(svg)) {
    throw new Error('SVG 不允许 DOCTYPE 或实体声明。')
  }
  if (/<!\s*(?!--|\[CDATA\[)/i.test(svg)) {
    throw new Error('SVG 只允许注释和 CDATA，不允许其它 XML 声明。')
  }
  if (/<\?(?!xml(?:\s|\?|$))/i.test(svg)) {
    throw new Error('SVG 不允许外部处理指令。')
  }
  for (const match of svg.matchAll(/&([A-Za-z_][A-Za-z0-9_.-]*);/g)) {
    if (!XML_NAMED_ENTITIES.has(match[1]!.toLowerCase())) {
      throw new Error(`SVG 不允许实体引用：&${match[1]};`)
    }
  }
}

function internalUrlReferences(value: string): string[] {
  const references: string[] = []
  const pattern = /url\s*\(\s*([^)]*?)\s*\)/gi
  for (const match of value.matchAll(pattern)) {
    let reference = match[1]!.trim()
    if ((reference.startsWith('"') && reference.endsWith('"'))
      || (reference.startsWith("'") && reference.endsWith("'"))) {
      reference = reference.slice(1, -1).trim()
    }
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(reference)) {
      throw new Error('SVG 只允许通过 url(#id) 使用内部资源。')
    }
    references.push(reference.slice(1))
  }
  if (/url\s*\(/i.test(value.replace(pattern, ''))) {
    throw new Error('SVG 的 CSS url() 引用格式无效。')
  }
  return references
}

function validateAttributes(
  attrs: Record<string, string>,
  state: SvgValidationState,
  isRoot: boolean,
): void {
  for (const [name, rawValue] of Object.entries(attrs)) {
    const value = rawValue.trim()
    const lowerName = name.toLowerCase()
    if (/^on(?:[a-z]|:)/i.test(localName(name))) {
      throw new Error(`SVG 不允许事件属性：${name}。`)
    }
    if (lowerName === 'xml:base') {
      throw new Error('SVG 不允许 xml:base。')
    }
    if (!isRoot && lowerName.startsWith('xmlns')) {
      throw new Error('SVG 只允许根节点声明命名空间。')
    }
    if (lowerName === 'href' || lowerName.endsWith(':href')) {
      if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) {
        throw new Error('SVG 的 href 只允许指向 #id 内部资源。')
      }
      state.references.push(value.slice(1))
    }
    if (/^\s*(?:javascript|vbscript):/i.test(value)) {
      throw new Error('SVG 不允许脚本协议。')
    }
    if (lowerName === 'style' && /(?:@import|(?:https?|file|data|javascript|vbscript):)/i.test(value)) {
      throw new Error('SVG 不允许外部 CSS 或 URL。')
    }
    state.references.push(...internalUrlReferences(rawValue))
    if (name === 'id') {
      if (!XML_NAME.test(rawValue) || state.ids.has(rawValue)) {
        throw new Error(`SVG 的 id 无效或重复：${rawValue}。`)
      }
      state.ids.add(rawValue)
    }
  }
}

function walkNode(node: ParsedXmlNode, state: SvgValidationState, isRoot: boolean): void {
  const elements = Object.entries(node).filter(([name]) => name !== ':@' && !name.startsWith('#'))
  if (elements.length === 0) return
  if (elements.length !== 1) throw new Error('SVG XML 节点结构无效。')
  const [rawTag, rawChildren] = elements[0]!
  const tag = localName(rawTag)
  const tagLower = tag.toLowerCase()
  if (SVG_UNSAFE_TAGS.has(tagLower)) {
    throw new Error(`SVG 不允许动态或脚本元素：${tag}。`)
  }
  if (!SVG_TAGS.has(tagLower)) {
    throw new Error(`SVG 元素不在静态白名单中：${tag}。`)
  }
  const prefix = namespacePrefix(rawTag)
  if (isRoot) {
    if (tagLower !== 'svg') throw new Error('SVG 根元素必须是 svg。')
    state.rootPrefix = prefix
  } else if (prefix !== state.rootPrefix) {
    throw new Error(`SVG 子元素命名空间无效：${rawTag}。`)
  }
  const attrs = attributes(node[':@'])
  validateAttributes(attrs, state, isRoot)
  if (isRoot) {
    const namespaceAttribute = prefix ? `xmlns:${prefix}` : 'xmlns'
    if (attrs[namespaceAttribute] !== SVG_NAMESPACE) {
      throw new Error(`SVG 根节点必须声明 ${SVG_NAMESPACE} 命名空间。`)
    }
    const viewBox = attrs.viewBox?.trim()
    const hasDimensions = !!attrs.width?.trim() && !!attrs.height?.trim()
    if (!viewBox && !hasDimensions) {
      throw new Error('SVG 根节点必须提供 viewBox 或 width/height。')
    }
    if (viewBox) {
      const values = viewBox.split(/[\s,]+/).filter(Boolean).map(Number)
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2]! <= 0 || values[3]! <= 0) {
        throw new Error('SVG 的 viewBox 必须包含四个有效数值。')
      }
    }
  }
  const children = Array.isArray(rawChildren) ? rawChildren : []
  for (const child of children) {
    if (isRecord(child)) walkNode(child, state, false)
  }
}

function validateSvg(svg: string): Uint8Array {
  const bytes = new TextEncoder().encode(svg)
  if (bytes.byteLength > MAX_SVG_BYTES) {
    throw new Error('SVG 必须小于或等于 1MB。')
  }
  if (svg.trim().length === 0) throw new Error('SVG 不能为空。')
  rejectXmlDeclarations(svg)
  const validation = XMLValidator.validate(svg)
  if (validation !== true) {
    throw new Error(`SVG XML 无效：${validation.err.msg}`)
  }
  let parsed: unknown
  try {
    parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      maxNestedTags: 512,
    }).parse(svg)
  } catch (error) {
    throw new Error(`SVG 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('SVG 必须只有一个根元素。')
  }
  const state: SvgValidationState = { ids: new Set(), references: [], rootPrefix: null }
  walkNode(parsed[0], state, true)
  for (const reference of state.references) {
    if (!state.ids.has(reference)) throw new Error(`SVG 引用了不存在的内部资源：#${reference}。`)
  }
  return bytes
}

export function svgImage(svg: string): { bytes: Uint8Array; ext: 'svg' } {
  if (typeof svg !== 'string') throw new Error('svg 必须是字符串。')
  return { bytes: validateSvg(svg), ext: 'svg' }
}

function decodeBase64(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('图片 data URL 的 base64 内容无效。')
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeSvgText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('SVG data URL 必须使用有效的 UTF-8 内容。')
  }
}

export function dataUrlImage(value: unknown): { bytes: Uint8Array; ext: string } {
  if (typeof value !== 'string') throw new Error('dataUrl 必须是字符串。')
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    throw new Error('图片必须是 10MB 以内的受支持数据地址。')
  }
  const svgBase64 = /^data:image\/svg\+xml(?:;[^;,]+)*;base64,(.*)$/is.exec(value)
  if (svgBase64) return svgImage(decodeSvgText(decodeBase64(svgBase64[1]!)))
  const svgText = /^data:image\/svg\+xml(?:;[^;,]+)*,(.*)$/is.exec(value)
  if (svgText) {
    let decoded: string
    try {
      decoded = decodeURIComponent(svgText[1]!)
    } catch {
      throw new Error('SVG data URL 的 URL 编码无效。')
    }
    return svgImage(decoded)
  }
  const raster = /^data:image\/(png|jpeg|gif|bmp|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(value)
  if (!raster) throw new Error('图片必须是受支持的 PNG、JPEG、GIF、BMP、WebP 或 SVG data URL。')
  return {
    bytes: decodeBase64(raster[2]!),
    ext: raster[1]!.toLowerCase() === 'jpeg' ? 'jpg' : raster[1]!.toLowerCase(),
  }
}
