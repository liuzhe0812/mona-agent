import { describe, expect, it } from 'vitest'
import { composeSlide } from './slides-layout'

const slide = { widthPx: 1280, heightPx: 720 }
const layout = { slideId: 's_1', x: 40, y: 40, width: 1200, height: 640,
  columns: [2, 1], rows: [1, 3], gap: 24 }

describe('native mixed slide composition', () => {
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

  it.each([
    { columns: [0, 1] }, { rows: [Infinity] }, { gap: 1000 }, { width: 2000 },
    { items: [{ type: 'text', row: 0, column: 2, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, columnSpan: 3, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, inset: 1000, text: 'outside' }] },
    { items: [{ type: 'text', row: 0, column: 0, text: 'unknown', wrongField: 1 }] },
  ])('rejects invalid geometry and fields before document mutation', (patch) => {
    expect(() => composeSlide({ ...layout, items: [{ type: 'text', row: 0, column: 0, text: 'ok' }], ...patch }, slide)).toThrow()
  })
})
