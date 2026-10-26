import { describe, expect, it } from 'vitest'

import { getSlidesCapabilities } from './slides-capabilities'

describe('Slides capabilities', () => {
  it('lists a bounded directory and serves schemas only for selected operations', () => {
    const result = getSlidesCapabilities()

    expect(result.mode).toBe('capabilities')
    expect(result.documentType).toBe('slides')
    expect(result.operations.map(({ op }) => op)).toEqual([
      'slide_replace_colors',
      'slide_add_design',
      'slide_add_path',
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
      'slide_add_preset',
    ])
    expect(result.operations.every((operation) => operation.payloadSchema === undefined)).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThan(12000)
    const detail = getSlidesCapabilities(undefined, ['slide_add_svg', 'slide_add_text'])
    expect(detail.operations.every((operation) => operation.payloadSchema?.type === 'object')).toBe(true)
    expect(detail.operations.find((operation) => operation.op === 'slide_add_svg')?.payloadSchema).toEqual(
      expect.objectContaining({
        required: ['slideId', 'svg', 'x', 'y', 'width', 'height'],
      }),
    )
    const addText = detail.operations.find((operation) => operation.op === 'slide_add_text')
    const addTextProperties = (addText?.payloadSchema?.properties as Record<string, unknown>)?.font as
      | { properties?: Record<string, unknown> }
      | undefined
    expect(addTextProperties?.properties).toHaveProperty('underline')
    expect(addTextProperties?.properties).not.toHaveProperty('strike')
  })

  it('pages detailed schema requests with an explicit continuation', () => {
    const names = ['slide_replace_colors', 'slide_set_fill', 'slide_set_font', 'slide_add_design', 'slide_add_chart']
    const first = getSlidesCapabilities(undefined, names)
    expect(first.operations).toHaveLength(3)
    expect(first.nextOperations).toEqual(names.slice(3))
    const second = getSlidesCapabilities(undefined, first.nextOperations)
    expect(second.operations.map((o) => o.op).sort()).toEqual(names.slice(3).sort())
    expect(second.nextOperations).toEqual([])
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
      'slide_add_design',
      'slide_add',
      'slide_duplicate',
      'slide_delete',
      'slide_move',
      'slide_apply_txn',
      'slide_compose',
      'slide_add_preset',
    ])
  })

  it('reports unknown names without discarding supported operations', () => {
    expect(getSlidesCapabilities(undefined, []).operations.length).toBeGreaterThan(1)
    expect(getSlidesCapabilities(undefined, ['slide_set_geometry', 'slide_set_text']).operations.map(({ op }) => op))
      .toEqual(['slide_set_text', 'slide_set_geometry'])
    expect(getSlidesCapabilities('chart', ['slide_set_text', 'slide_set_chart_style']).operations.map(({ op }) => op))
      .toEqual(['slide_set_chart_style'])
    const mixed = getSlidesCapabilities(undefined, ['slide_set_style', 'slide_set_fill', 'slide_restyle'])
    expect(mixed.operations.map((op) => op.op)).toEqual(['slide_set_fill'])
    expect(mixed.operations[0]?.payloadSchema).toBeDefined()
    expect(mixed.unsupportedOperations).toEqual(['slide_set_style', 'slide_restyle'])
    expect(mixed.availableOperations).toContain('slide_replace_colors')
    const unknown = getSlidesCapabilities(undefined, ['slide_missing'])
    expect(unknown.operations).toEqual([])
    expect(unknown.unsupportedOperations).toEqual(['slide_missing'])
    expect(getSlidesCapabilities('chart', ['slide_set_text']).inapplicableOperations).toEqual(['slide_set_text'])
  })

  it('reuses native compose content for optional atomic page creation without public IDs', () => {
    const detail = getSlidesCapabilities(undefined, ['slide_add', 'slide_compose'])
    const add = detail.operations.find((operation) => operation.op === 'slide_add')!.payloadSchema!
    const compose = detail.operations.find((operation) => operation.op === 'slide_compose')!.payloadSchema!
    const content = (add.properties as Record<string, Record<string, unknown>>).content!
    expect(add.required).toEqual(['slideId'])
    expect(content.required).toEqual(['columns', 'rows', 'items'])
    expect(content.additionalProperties).toBe(false)
    expect(content.properties).toEqual(Object.fromEntries(Object.entries(compose.properties as Record<string, unknown>).filter(([key]) => key !== 'slideId')))
    expect(content.properties).not.toHaveProperty('slideId')
    expect(content.properties).not.toHaveProperty('elementId')
  })

  it('exposes native editing without legacy templates or automatic design recommendations', () => {
    const result = getSlidesCapabilities()
    for (const key of ['designs', 'presets', 'presetScenarios', 'templateScenarios', 'templates']) {
      expect(result).not.toHaveProperty(key)
    }
    expect(result.availableOperations).not.toContain('slide_add_template')
    expect(getSlidesCapabilities(undefined, ['slide_add_template']).unsupportedOperations).toEqual(['slide_add_template'])
    const detail = getSlidesCapabilities(undefined, ['slide_add_image', 'slide_add_preset'])
    const image = detail.operations.find((operation) => operation.op === 'slide_add_image')!.payloadSchema!
    expect(image.properties).not.toHaveProperty('assetId')
    const preset = detail.operations.find((operation) => operation.op === 'slide_add_preset')!.payloadSchema!
    expect(preset.required).toEqual(['slideId', 'presetId', 'content'])
    expect((preset.properties as Record<string, { enum?: string[] }>).presetId!.enum).not.toContain('auto')
  })
})
