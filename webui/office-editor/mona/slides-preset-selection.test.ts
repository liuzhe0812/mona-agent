import { describe, expect, it } from 'vitest'
import { PRESETS, PRESET_ROLES, expandPreset, rankPresets, type PresetContent } from './slides-presets'
import { PresetContentStore } from './slides-preset-content'

describe('内容先于版式的选页', () => {
  const parallel: PresetContent = { title: '三项独立能力', relation: 'parallel', role: 'breakdown',
    nodes: ['检索', '分析', '执行'], items: ['保留原始证据', '说明推理依据', '输出可编辑结果'] }

  it('并列内容只推荐并列布局，并且每项完整写入', () => {
    const candidates = rankPresets(parallel)
    expect(candidates.length).toBeGreaterThan(0)
    for (const { preset } of candidates) {
      expect(preset.relation).toBe('parallel')
      const output = expandPreset({presetId:preset.id,slideId:'s',content:parallel})
      const text = JSON.stringify(output.operations)
      for (const item of [...parallel.nodes!, ...parallel.items!]) expect(text).toContain(item)
    }
    expect(rankPresets({...parallel,relation:'network'})).toEqual([])
  })

  it('角色覆盖有实际资源，重复惩罚不会改变硬约束', () => {
    for (const role of PRESET_ROLES) expect(PRESETS.some((preset) => preset.roles?.includes(role.id)), role.id).toBe(true)
    const first = rankPresets(parallel, {theme:'dark-product'})[0]!
    const repeated = rankPresets(parallel, {theme:'dark-product',usedPresetIds:[first.preset.id]})
    expect(repeated.every(({preset}) => preset.relation === 'parallel' && preset.theme === 'dark-product')).toBe(true)
    const same = repeated.find(({preset}) => preset.id === first.preset.id)
    if (same) expect(same.score).toBeLessThan(first.score)
  })

  it('自定义角色是软提示，不会禁止已有合适构图', () => {
    expect(rankPresets({ ...parallel, role: 'custom-teaching-goal' }).length).toBeGreaterThan(0)
  })

  it('自动选版不隐式降级，仍可明确选择基础草稿', () => {
    const content: PresetContent = { title: '五项独立分析', relation: 'parallel',
      nodes: ['甲', '乙', '丙', '丁', '戊'], items: ['说明甲', '说明乙', '说明丙', '说明丁', '说明戊'] }
    // The explicit basic page remains available, but it is never an invisible default.
    const result = expandPreset({ slideId: 's', presetId: 'auto-content', content })
    expect(result.presetId).toBe('auto-content')
    const unsupported: PresetContent = { ...content, relation: 'network' }
    expect(() => expandPreset({ slideId: 's', presetId: 'auto', content: unsupported })).toThrow('slide_compose')
  })

  it('三条必含证据不能为迁就两条容量而被删除', () => {
    const content: PresetContent = {title:'三项证据共同支撑结论', relation:'none', role:'observation',
      facts: ['成本下降', '延迟降低', '校准更准确'].map((text,index) => ({id:`f${index}`,text})),
      chart:{kind:'bar',categories:['A','B'],series:[{name:'分数',values:[60,80]}],unit:'分'} }
    const candidates = rankPresets(content)
    expect(candidates.length).toBeGreaterThan(0)
    for (const {preset} of candidates) {
      const result = expandPreset({presetId:preset.id,slideId:'s',content})
      for (const fact of content.facts!) expect(JSON.stringify(result.operations)).toContain(fact.text)
    }
    const recovered = rankPresets({...content,items:['成本下降','延迟降低']})
    expect(recovered.length).toBeGreaterThan(0)
    expect(JSON.stringify(expandPreset({slideId:'s',presetId:recovered[0]!.preset.id,content:{...content,items:['成本下降','延迟降低']}}).operations)).toContain('校准更准确')
    expect(rankPresets({...content,chart:{...content.chart!,categoryUnits:['元','秒']}})).toEqual([])
  })

  it('内容引用保持独立副本，禁止偷偷重写，并在会话清理后失效', () => {
    const store = new PresetContentStore()
    const original = structuredClone(parallel)
    const ref = store.register(original)
    original.items![0] = '修改'
    const resolved = store.resolve(undefined,ref)
    expect(resolved.items![0]).toBe('保留原始证据')
    resolved.items![0] = '再次修改'
    expect(store.resolve(undefined,ref).items![0]).toBe('保留原始证据')
    expect(() => store.resolve(parallel,ref)).toThrow('不要重传')
    store.clear()
    expect(() => store.resolve(undefined,ref)).toThrow('失效')
  })

  it('矩阵维度来自当前内容，缺失时不填模板示例', () => {
    const content: PresetContent = {title:'客户分层',relation:'matrix',nodes:['甲','乙','丙','丁'],items:['一','二','三','四']}
    expect(rankPresets(content)).toEqual([])
    content.axes = {x:'使用频率',y:'采购规模'}
    const candidate = rankPresets(content)[0]!
    expect(candidate).toBeTruthy()
    const output = JSON.stringify(expandPreset({slideId:'s',presetId:candidate.preset.id,content}).operations)
    expect(output).toContain('使用频率')
    expect(output).toContain('采购规模')
    expect(output).not.toContain('实施难度')
  })
})
