import { describe, expect, it } from 'vitest'

import { getSlidesCapabilities } from './slides-capabilities'

describe('Slides capabilities', () => {
  it('lists the implemented direct operations and their payload schemas', () => {
    const result = getSlidesCapabilities()

    expect(result.mode).toBe('capabilities')
    expect(result.documentType).toBe('slides')
    expect(result.operations.map(({ op }) => op)).toEqual([
      'slide_add_chart',
      'slide_set_text',
      'slide_set_font',
      'slide_set_chart_style',
      'slide_set_geometry',
      'slide_set_fill',
      'slide_set_stroke',
      'slide_delete_element',
      'slide_add_text',
      'slide_add_shape',
      'slide_add_image',
      'slide_add_svg',
      'slide_add',
      'slide_duplicate',
      'slide_delete',
      'slide_move',
      'slide_apply_txn',
      'slide_compose',
    ])
    expect(result.operations.every((operation) => operation.payloadSchema.type === 'object')).toBe(true)
    expect(result.operations.find((operation) => operation.op === 'slide_add_svg')?.payloadSchema).toEqual(
      expect.objectContaining({
        required: ['slideId', 'svg', 'x', 'y', 'width', 'height'],
      }),
    )
    const addText = result.operations.find((operation) => operation.op === 'slide_add_text')
    const addTextProperties = (addText?.payloadSchema.properties as Record<string, unknown>)?.font as
      | { properties?: Record<string, unknown> }
      | undefined
    expect(addTextProperties?.properties).not.toHaveProperty('underline')
    expect(addTextProperties?.properties).not.toHaveProperty('strike')
  })

  it('filters operations by the element type they actually support', () => {
    const chartOps = getSlidesCapabilities('chart').operations.map(({ op }) => op)
    expect(chartOps).toEqual(expect.arrayContaining([
      'slide_set_font',
      'slide_set_chart_style',
      'slide_set_geometry',
      'slide_delete_element',
      'slide_apply_txn',
      'slide_compose',
      'slide_add',
      'slide_duplicate',
      'slide_delete',
      'slide_move',
    ]))
    expect(chartOps).not.toEqual(expect.arrayContaining([
      'slide_set_text',
      'slide_set_fill',
      'slide_set_stroke',
      'slide_add_text',
      'slide_add_shape',
      'slide_add_image',
      'slide_add_svg',
    ]))
    expect(getSlidesCapabilities('unsupported').operations.map(({ op }) => op)).toEqual([
      'slide_add',
      'slide_duplicate',
      'slide_delete',
      'slide_move',
      'slide_apply_txn',
      'slide_compose',
    ])
  })

  it('filters by requested operations and rejects unknown operation names', () => {
    expect(getSlidesCapabilities(undefined, []).operations.length).toBeGreaterThan(1)
    expect(getSlidesCapabilities(undefined, ['slide_set_geometry', 'slide_set_text']).operations.map(({ op }) => op))
      .toEqual(['slide_set_text', 'slide_set_geometry'])
    expect(getSlidesCapabilities('chart', ['slide_set_text', 'slide_set_chart_style']).operations.map(({ op }) => op))
      .toEqual(['slide_set_chart_style'])
    expect(() => getSlidesCapabilities(undefined, ['slide_missing'])).toThrow('slide_missing')
  })
})
