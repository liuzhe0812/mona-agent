import { describe, expect, it } from 'vitest'
import { PRESET_THEMES, type PresetContent, type PresetInput } from './slides-presets'
import { expandContentPage } from './slides-content-page'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const input = (content: PresetContent): PresetInput => ({ slideId: 's1', presetId: 'auto-content', content })

describe('自动内容页 fallback', () => {
  it('保留财务事实与费用条目，并使用原生图表', () => {
    const content: PresetContent = {
      title: '费用结构推动利润改善', summary: '2026 年第一季度，单位：百万元', takeaway: '费用率下降 3 个百分点',
      facts: [{ id: 'f1', text: '研发费用下降', required: true }, { id: 'f2', text: '销售费用保持稳定', required: true }],
      items: ['人工费用下降 8%', '材料费用下降 5%', '物流费用下降 2%'],
      chart: { kind: 'bar', categories: ['一季度', '二季度', '三季度'], series: [{ name: '费用', values: [100, 92, 86] }], unit: '百万元' },
    }
    const expanded = expandContentPage(input(content), PRESET_THEMES['light-editorial'])
    const payload = JSON.stringify(expanded.operations)
    expect(expanded.presetId).toBe('auto-content')
    expect(payload).toContain('研发费用下降')
    expect(payload).toContain('销售费用保持稳定')
    for (const item of content.items!) expect(payload).toContain(item)
    expect(expanded.operations.some((operation) => operation.op === 'slide_add_chart')).toBe(true)
    expect(expanded.operations.find((operation) => operation.op === 'slide_add_chart')?.payload.kind).toBe('bar')
    expect(expanded.roles).toHaveLength(expanded.operations.length)
    expect(expanded.operations.length).toBeLessThanOrEqual(50)
  })

  it('文本超过安全容纳时明确要求拆页', () => {
    expect(() => expandContentPage(input({ title: '超长内容', items: Array.from({ length: 40 }, () => '这是一条很长的费用说明，用于验证内容页不会缩小文字或静默裁剪。') }), PRESET_THEMES['light-editorial']))
      .toThrow(/拆页/)
  })

  it('不伪造未支持的关系', () => {
    expect(() => expandContentPage(input({ title: '流程关系', relation: 'sequence', nodes: ['开始', '结束'], items: ['说明', '完成'] }), PRESET_THEMES['light-editorial']))
      .toThrow(/关系页|拆页/)
  })
})
