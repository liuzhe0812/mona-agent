import type { Paragraph, TextRun, TextBody } from '@genoffice/pptx-engine'
import { layoutText, type Viewport } from '@genoffice/pptx-render'
import { slideFontMetrics } from './slides-font-metrics'

type RecordValue = Record<string, unknown>
const object = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const fontKeys = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'color', 'letterSpacing', 'baseline']
export function nativeFont(value: unknown): Partial<TextRun> {
  if (value === undefined) return {}
  if (!object(value)) throw new Error('font 必须是对象。')
  const unknown = Object.keys(value).filter((key) => !fontKeys.includes(key))
  if (unknown.length) throw new Error(`不支持的字体字段：${unknown.join(', ')}`)
  for (const key of ['bold', 'italic', 'underline']) if (key in value && typeof value[key] !== 'boolean') throw new Error(`${key} 必须为布尔值。`)
  if ('fontFamily' in value && (typeof value.fontFamily !== 'string' || !value.fontFamily.trim() || value.fontFamily.length > 200)) throw new Error('字体名称无效。')
  if ('fontSize' in value && (typeof value.fontSize !== 'number' || !Number.isFinite(value.fontSize) || value.fontSize <= 0 || value.fontSize > 400)) throw new Error('字号须为 0–400pt 的有限正数。')
  if ('color' in value && (typeof value.color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value.color))) throw new Error('文字颜色须为 #RRGGBB 或 #RRGGBBAA。')
  for (const key of ['letterSpacing', 'baseline']) if (key in value && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Math.abs(value[key]) > (key === 'baseline' ? 100 : 20))) throw new Error(`${key} 超出允许范围。`)
  return { ...value } as Partial<TextRun>
}

export function nativeParagraphs(payload: RecordValue): Paragraph[] | undefined {
  const base = nativeFont(payload.font)
  if (payload.paragraphs === undefined && payload.text === undefined) return undefined
  if (payload.paragraphs !== undefined && payload.text !== undefined) throw new Error('text 与 paragraphs 二选一。')
  const raw = payload.paragraphs ?? [{ runs: [{ text: payload.text }], ...(payload.align ? { align: payload.align } : {}) }]
  if (!Array.isArray(raw) || !raw.length || raw.length > 80) throw new Error('paragraphs 需要 1–80 个段落。')
  let characters = 0
  return raw.map((p): Paragraph => {
    if (!object(p) || Object.keys(p).some((key) => !['runs', 'align', 'lineHeight', 'spaceBefore', 'spaceAfter'].includes(key))) throw new Error('段落字段仅支持 runs/align/lineHeight/spaceBefore/spaceAfter。')
    if (!Array.isArray(p.runs) || !p.runs.length || p.runs.length > 80) throw new Error('段落 runs 需要 1–80 个文字片段。')
    if (p.align !== undefined && !['left', 'center', 'right', 'justify'].includes(String(p.align))) throw new Error('段落 align 无效。')
    for (const key of ['lineHeight', 'spaceBefore', 'spaceAfter']) if (key in p && (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 400)) throw new Error(`${key} 无效。`)
    const runs = p.runs.map((r): TextRun => {
      if (!object(r) || typeof r.text !== 'string') throw new Error('每个 run 必须有 text。')
      characters += r.text.length
      if (characters > 30000) throw new Error('单个文字对象超过 30000 字符。')
      const { text, ...style } = r
      return { ...base, ...nativeFont(style), text }
    })
    return { ...p, runs } as Paragraph
  })
}

export function nativeBodyPr(value: unknown, vp: Viewport) {
  if (value === undefined) return undefined
  if (!object(value) || Object.keys(value).some((k) => !['insets', 'anchor', 'wrap'].includes(k))) throw new Error('body 仅支持 insets/anchor/wrap。')
  if (value.anchor !== undefined && !['top', 'middle', 'bottom'].includes(String(value.anchor))) throw new Error('body.anchor 无效。')
  if (value.wrap !== undefined && typeof value.wrap !== 'boolean') throw new Error('body.wrap 必须是布尔值。')
  const insets = value.insets
  if (insets !== undefined && (!object(insets) || Object.keys(insets).some((k) => !['l', 't', 'r', 'b'].includes(k)) || ['l', 't', 'r', 'b'].some((k) => typeof insets[k] !== 'number' || !Number.isFinite(insets[k]) || (insets[k] as number) < 0 || (insets[k] as number) > 500))) throw new Error('insets 需为 l/t/r/b 非负像素。')
  return {
    ...(object(insets) ? { insetsEmu: Object.fromEntries(['l', 't', 'r', 'b'].map((k) => [k, Math.round(Number(insets[k]) * 9525 / vp.scale)])) as { l: number; t: number; r: number; b: number } } : {}),
    ...(value.anchor ? { anchor: ({ top: 't', middle: 'ctr', bottom: 'b' } as const)[value.anchor as 'top' | 'middle' | 'bottom'] } : {}),
    ...(value.wrap !== undefined ? { wrap: value.wrap ? 'square' as const : 'none' as const } : {}),
  }
}

/** Same line layout and metrics provider as the editor, not a second character-count algorithm. */
export function measureNativeText(paragraphs: Paragraph[], width: number, height: number, vp: Viewport, body: Partial<TextBody> = {}) {
  return layoutText({ body: { insets: { l: 0, t: 0, r: 0, b: 0 }, ...body, paragraphs }, boxWidthPx: width, boxHeightPx: height, metrics: slideFontMetrics(), vp })
}

export function fitNativeText(paragraphs: Paragraph[], width: number, height: number, vp: Viewport, minimumRatio = 0.78): Paragraph[] {
  for (let step = 0; step <= 12; step++) {
    const ratio = 1 - (1 - minimumRatio) * step / 12
    const fitted = paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, fontSize: Math.floor((r.fontSize ?? 18) * ratio * 100) / 100 })) }))
    const layout = measureNativeText(fitted, width, height, vp)
    if (layout.contentHeight <= height - 1 && layout.lines.every((line) => line.runs.every((r) => r.x >= -0.5 && r.x + r.widthPx <= width + 0.5))) return fitted
  }
  const layout = measureNativeText(paragraphs, width, height, vp)
  throw new Error(`该区域文字不适配（实际约 ${Math.ceil(layout.contentHeight)}px，可用 ${Math.floor(height)}px）。请扩大区域、换构图或使用等义简写；没有截断或删除内容。`)
}
