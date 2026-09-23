import { describe, expect, it } from 'vitest'
import type { RenderNode, RenderSlide, RenderTextLayout } from '@genoffice/pptx-render'
import { composeSlide, isBlockingLayoutWarning, slideLayoutWarnings } from './slides-layout'

const slide = { widthPx: 1280, heightPx: 720 }
const layout = { slideId: 's_1', x: 40, y: 40, width: 1200, height: 640,
  columns: [2, 1], rows: [1, 3], gap: 24 }

function textLayout(lines: Array<{ text: string; top: number; height: number; width: number }>, contentHeight?: number): RenderTextLayout {
  return {
    lines: lines.map((line) => ({
      top: line.top,
      height: line.height,
      runs: [{
        text: line.text, x: 0, baselineY: line.top + line.height * 0.8,
        fontFamily: 'Microsoft YaHei', fontSizePx: line.height,
        color: '#000000', bold: false, italic: false, underline: false, widthPx: line.width,
      }],
    })),
    insets: { l: 0, t: 0, r: 0, b: 0 },
    anchor: 'top', fontScale: 1,
    contentHeight: contentHeight ?? Math.max(0, ...lines.map((line) => line.top + line.height)),
    wrap: true,
  }
}

function textNode(id: string, x: number, y: number, w: number, h: number, text: RenderTextLayout): RenderNode {
  return {
    id, durableId: id, sourceId: id, type: 'text', box: placedBox(x, y, w, h),
    fill: { kind: 'none' }, text,
  } as RenderNode
}

function placedBox(x: number, y: number, w: number, h: number) {
  return { x, y, w, h, rotationDeg: 0, flipH: false, flipV: false, centerX: x + w / 2, centerY: y + h / 2 }
}

function renderSlide(nodes: RenderNode[]): RenderSlide {
  return { widthPx: 1280, heightPx: 720, scale: 1, background: { kind: 'solid', color: '#FFFFFF' }, nodes }
}

describe('native mixed slide composition', () => {
  it('flags the reported single-box comparison and character charts without classifying them as geometry errors', () => {
    const content = ['Model A 编码能力、科学推理和价格比较', '指标需要在相同测试条件下横向比较，说明各项指标的限制',
      'Model B 编码能力、科学推理和价格比较', '指标需要在相同测试条件下横向比较，说明各项指标的限制',
      'Model C 编码能力、科学推理和价格比较', '指标需要在相同测试条件下横向比较，说明各项指标的限制',
      '附加说明：本页文字全部堆在同一文本框，模型名和指标没有独立布局，读者难以对应价格和能力之间的关系']
    const title = textNode('title', 48, 48, 1184, 100, textLayout([{ text: '模型对比', top: 0, height: 40, width: 300 }]))
    const body = textNode('body', 48, 210, 1184, 462, textLayout(content.map((text, index) => ({ text, top: index * 38, height: 24, width: 700 }))))
    const warnings = slideLayoutWarnings(renderSlide([title, body]), new Set(['body']))
    expect(warnings).toEqual([expect.stringContaining('单个全宽文本框')])
    expect(warnings.some(isBlockingLayoutWarning)).toBe(false)
    const bars = textNode('bars', 48, 210, 1184, 462, textLayout([
      { text: 'A ███████████ 95%', top: 0, height: 24, width: 400 },
      { text: 'B ██████ 90%', top: 50, height: 24, width: 350 },
    ]))
    expect(slideLayoutWarnings(renderSlide([bars]), new Set(['bars']))).toEqual([expect.stringContaining('字符条模拟')])
  })

  it('allows short text-only slides, intentional whitespace and independently arranged modules', () => {
    const quote = textNode('quote', 300, 250, 600, 90, textLayout([{ text: '一个清楚的结论', top: 0, height: 40, width: 300 }]))
    expect(slideLayoutWarnings(renderSlide([quote]), new Set(['quote']))).toEqual([])
    const modules = [0, 1, 2].map((index) => textNode(`m${index}`, 48 + index * 400, 210, 350, 460,
      textLayout(Array.from({ length: 8 }, (_, i) => ({ text: '每个比较对象有独立的指标和价格说明', top: i * 40, height: 24, width: 320 })))))
    expect(slideLayoutWarnings(renderSlide(modules), new Set(['m0', 'm1', 'm2']))).toEqual([])
  })
  it('lays out weighted tracks, spanning elements and intentional overlays deterministically', () => {
    const ops = composeSlide({ ...layout, items: [
      { type: 'text', row: 0, column: 0, columnSpan: 2, text: '标题', font: { fontSize: 36 } },
      { type: 'image', row: 1, column: 0, dataUrl: 'photo' },
      { type: 'shape', row: 1, column: 1, shape: 'rect', fillColor: '#112233' },
      { type: 'svg', row: 1, column: 1, inset: 24, svg: '<svg/>' },
    ] }, slide)
    expect(ops.map((op) => op.op)).toEqual(['slide_add_text', 'slide_add_image', 'slide_add_shape', 'slide_add_svg'])
    expect(ops[0]!.payload).toEqual(expect.objectContaining({ x: 40, y: 40, width: 1200, height: 154 }))
    expect(ops[1]!.payload).toEqual(expect.objectContaining({ x: 40, y: 218, width: 784, height: 462 }))
    expect(ops[2]!.payload).toEqual(expect.objectContaining({ x: 848, y: 218, width: 392, height: 462 }))
    expect(ops[3]!.payload).toEqual(expect.objectContaining({ x: 872, y: 242, width: 344, height: 414 }))
  })

  it('composes a native chart and its creation style without losing data', () => {
    const series = [{ name: '交付周期', values: [50, 30] }]
    const style = { seriesColors: ['#25856B'], axisLabelColor: '#223344' }
    const [operation] = composeSlide({ ...layout, items: [{
      type: 'chart', column: 0, row: 1, kind: 'bar', categories: ['基期', '当前'],
      series, style, valAxisTitle: '分钟',
    }] }, slide)
    expect(operation).toMatchObject({ op: 'slide_add_chart', payload: {
      slideId: 's_1', x: 40, y: 218, width: 784, height: 462, series, style, valAxisTitle: '分钟',
    } })
  })

  it.each([
    { columns: [0, 1] }, { rows: [Infinity] }, { gap: 1000 }, { width: 2000 },
    { items: [{ type: 'text', row: 0, column: 2, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, columnSpan: 3, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, inset: 1000, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, text: 'unknown', wrongField: 1 }] },
  ])('rejects invalid geometry and fields before document mutation', (patch) => {
    expect(() => composeSlide({ ...layout, items: [{ type: 'text', row: 0, column: 0, text: 'ok' }], ...patch }, slide)).toThrow()
  })

  it('reports rendered text overflow and overlap with the adjacent paragraph as blocking errors', () => {
    const title = textNode('e_title', 500, 290, 280, 40, textLayout([
      { text: '自然光影 · 丰富', top: 0, height: 29, width: 260 },
      { text: '质感', top: 29, height: 29, width: 58 },
    ], 58))
    const body = textNode('e_body', 500, 340, 280, 120, textLayout([
      { text: '更真实的光照效果', top: 0, height: 20, width: 180 },
    ]))
    const warnings = slideLayoutWarnings(renderSlide([title, body]), new Set(['e_title', 'e_body']))
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('[错误] e_title 文字溢出'),
      expect.stringContaining('[错误] e_title 与 e_body 的文字相互重叠'),
    ]))
    expect(warnings.filter(isBlockingLayoutWarning)).toHaveLength(2)
  })

  it('reports text placed over a picture as a visual-review issue', () => {
    const picture = {
      id: 'pic', durableId: 'e_picture', sourceId: 'pic', type: 'picture',
      box: placedBox(56, 320, 564, 344),
    } as RenderNode
    const caption = textNode('e_caption', 80, 580, 500, 40, textLayout([
      { text: '产品照 · 社交媒体 · 海报设计', top: 0, height: 24, width: 360 },
    ]))
    const warnings = slideLayoutWarnings(renderSlide([picture, caption]), new Set(['e_picture', 'e_caption']))
    expect(warnings).toEqual([
      expect.stringContaining('[需检查] e_caption 的文字与图片 e_picture 交叠'),
    ])
    expect(warnings.some(isBlockingLayoutWarning)).toBe(false)
  })

  it('checks text inside groups using its absolute slide position', () => {
    const child = textNode('e_child', 10, 10, 40, 20, textLayout([
      { text: '组合内溢出文字', top: 0, height: 24, width: 120 },
    ], 24))
    const group = {
      id: 'group', durableId: 'e_group', sourceId: 'group', type: 'group',
      box: placedBox(100, 100, 300, 200),
      children: [child],
    } as RenderNode
    const warnings = slideLayoutWarnings(renderSlide([group]), new Set(['e_child']))
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('[错误] e_child 文字溢出')]))
  })
})
