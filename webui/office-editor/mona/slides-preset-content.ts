import type { PresetContent } from './slides-presets'

const normalizeFactText = (text: string): string => text.replace(/\s+/gu, '')

function visibleContentText(content: PresetContent): string {
  const nodes = Array.isArray(content.nodes) ? content.nodes : []
  const items = Array.isArray(content.items) ? content.items : []
  return [content.title, content.summary, content.takeaway, ...nodes, ...items]
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
}

/** All layout candidates share this copy; changing a layout never rewrites facts. */
export function preparePresetContent(input: PresetContent): PresetContent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('content 必须是对象。')
  const content = structuredClone(input)
  if (content.facts !== undefined) {
    if (!Array.isArray(content.facts) || content.facts.some((fact) => !fact || typeof fact.id !== 'string'
      || !fact.id.trim() || typeof fact.text !== 'string' || !fact.text.trim()
      || (fact.required !== undefined && typeof fact.required !== 'boolean')
      || Object.keys(fact).some((key) => !['id', 'text', 'required'].includes(key)))) {
      throw new Error('facts 必须包含稳定 id、text 和可选 required。')
    }
    if (new Set(content.facts.map((fact) => fact.id)).size !== content.facts.length) throw new Error('facts.id 不能重复。')
    const visible = normalizeFactText(visibleContentText(content))
    const missingRequired = content.facts.filter((fact) => fact.required !== false
      && !visible.includes(normalizeFactText(fact.text)))
    // Paired node/item layouts must keep their original cardinality. Leave missing
    // facts in metadata so selection or the caller can report the missing evidence.
    if (content.nodes === undefined && missingRequired.length
      && (content.items === undefined || Array.isArray(content.items))) {
      content.items = [...(content.items ?? []), ...missingRequired.map((fact) => fact.text)]
    }
  }
  return content
}

export function missingRequiredFacts(content: PresetContent, visibleText: string): string[] {
  const visible = normalizeFactText(visibleText)
  return (content.facts ?? []).filter((fact) => fact.required !== false
    && !visible.includes(normalizeFactText(fact.text)))
    .map((fact) => fact.id)
}

/** References belong to the editor session, not the user's saved presentation. */
export class PresetContentStore {
  private readonly contents = new Map<string, PresetContent>()

  register(content: PresetContent): string {
    const value = preparePresetContent(content)
    const ref = `preset-content:${crypto.randomUUID()}`
    this.contents.set(ref, value)
    if (this.contents.size > 128) this.contents.delete(this.contents.keys().next().value!)
    return ref
  }

  resolve(content: unknown, ref: unknown): PresetContent {
    if (ref !== undefined && ref !== null) {
      if (content !== undefined && content !== null) throw new Error('使用 contentRef 时不要重传或改写 content；重新规划请从原始内容查询候选。')
      if (typeof ref !== 'string' || !this.contents.has(ref)) throw new Error('内容引用已失效，请使用原始内容重新查询候选。')
      return structuredClone(this.contents.get(ref)!)
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('需要 content 或有效的 contentRef。')
    return preparePresetContent(content as PresetContent)
  }

  clear(): void { this.contents.clear() }
}
