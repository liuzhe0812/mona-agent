import { describe, expect, it } from 'vitest'
import { PRESETS, PRESET_SCENARIOS, PRESET_THEMES, expandPreset, findPreset, findPresetScenario, presetScenarioCatalog, rankPresets, resolvePresetTheme } from './slides-presets'
import { presetBoundaryContent } from './slides-preset-capacity'
import { getSlidesCapabilities } from './slides-capabilities'

describe('按用途选择原生 PPT 场景', () => {
  it('12个场景都有完整页组，重复构图共享稳定ID', () => {
    expect(PRESET_SCENARIOS).toHaveLength(12)
    expect(new Set(PRESET_SCENARIOS.map((scenario) => scenario.id)).size).toBe(12)
    expect(new Set(PRESET_SCENARIOS.flatMap((scenario) => scenario.sourceThemes)).size).toBe(12)
    const references = PRESET_SCENARIOS.flatMap((scenario) => scenario.templateIds)
    expect(new Set(references).size).toBeLessThan(references.length)
    expect(PRESETS.filter((preset) => !preset.scenarios?.length)).toEqual([])
    for (const scenario of PRESET_SCENARIOS) {
      expect(scenario.templateIds.length, scenario.id).toBeGreaterThanOrEqual(8)
      expect(scenario.templateIds.length, scenario.id).toBeLessThanOrEqual(12)
      expect(new Set(scenario.templateIds).size).toBe(scenario.templateIds.length)
      for (const id of scenario.templateIds) expect(findPreset(id)?.scenarios, id).toContain(scenario.id)
      for (const page of scenario.signaturePages) {
        expect(scenario.templateIds, page.id).toContain(page.preferredPresetId)
        expect(findPreset(page.preferredPresetId)?.relation ?? 'none', page.id).toBe(page.relation)
      }
    }
    expect(presetScenarioCatalog().map((scenario) => scenario.id)).toEqual(PRESET_SCENARIOS.map((scenario) => scenario.id))
  })

  it('所有场景特色页能自动匹配并把真实内容写入原生对象', () => {
    for (const scenario of PRESET_SCENARIOS) {
      const preset = PRESETS.find((item) => item.id === scenario.id) ?? findPreset(scenario.signaturePages.at(-1)!.preferredPresetId)!
      const content = { ...presetBoundaryContent(preset), scenario: scenario.id, relation: preset.relation }
      const candidates = rankPresets(content)
      expect(candidates.length, scenario.id).toBeGreaterThan(0)
      for (const candidate of candidates) expect(scenario.templateIds).toContain(candidate.preset.id)
      const expanded = expandPreset({ slideId: 'test-slide', presetId: preset.id, content })
      expect(expanded.operations.length).toBeLessThanOrEqual(50)
      const visible = expanded.operations.map((operation) => operation.payload.text ?? '').join('\n')
      for (const text of [content.title, content.summary, content.takeaway, ...(content.items ?? []), ...(content.nodes ?? [])].filter(Boolean)) {
        expect(visible, `${scenario.id} 必含内容`).toContain(text)
      }
    }
  })

  it('场景调色与品牌强调色用于创建，不改共享主题或原文', () => {
    const before = structuredClone(PRESET_THEMES)
    for (const scenario of PRESET_SCENARIOS) {
      const content = { title: '保持事实与单位', scenario: scenario.id, accentColor: '#C65B35' }
      const theme = resolvePresetTheme(content)
      expect(theme.id).toBe(scenario.defaultTheme)
      expect(theme.background).toBe(scenario.palette.background)
      expect(theme.accent).toBe('#C65B35')
      expect(theme.chart.seriesColors[0]).toBe('#C65B35')
      expect(content.title).toBe('保持事实与单位')
      const otherTheme = scenario.defaultTheme === 'light-editorial' ? 'dark-product' : 'light-editorial'
      expect(resolvePresetTheme({ ...content, theme: otherTheme }).background).toBe(PRESET_THEMES[otherTheme].background)
    }
    expect(PRESET_THEMES).toEqual(before)
  })

  it('未知场景明确失败，能力目录公开实际可用场景', () => {
    expect(() => findPresetScenario('missing')).toThrow('未知 PPT 场景')
    expect(() => rankPresets({ title: '标题', scenario: 'missing' })).toThrow('未知 PPT 场景')
    const capabilities = getSlidesCapabilities(undefined, ['slide_add_preset'])
    expect(capabilities.presetScenarios).toHaveLength(12)
    const schema = capabilities.operations[0]!.payloadSchema as { properties: { content: { properties: { scenario: { enum: string[] } } } } }
    expect(schema.properties.content.properties.scenario.enum).toEqual(PRESET_SCENARIOS.map((scenario) => scenario.id))
  })
})
