import { describe, expect, it } from 'vitest'
import { missingRequiredFacts, preparePresetContent } from './slides-preset-content'
import type { PresetContent } from './slides-presets'

describe('预设内容 facts 规范化', () => {
  it('只把未出现的必含事实追加到 items，并保留已有内容', () => {
    const content: PresetContent = {
      title: '结果：营收增长',
      summary: '摘要：成本下降',
      takeaway: '结论：利润改善',
      items: ['结论：利润改善', '已有说明'],
      facts: [
        { id: 'revenue', text: '营收增长' },
        { id: 'cost', text: '成本 \n下降' },
        { id: 'delay', text: '延迟 \n降低' },
        { id: 'optional', text: '可选补充', required: false },
      ],
    }

    const prepared = preparePresetContent(content)

    expect(prepared.items).toEqual(['结论：利润改善', '已有说明', '延迟 \n降低'])
    expect(prepared.facts).toEqual(content.facts)
    expect(prepared.title).toBe(content.title)
    expect(prepared.summary).toBe(content.summary)
    expect(prepared.takeaway).toBe(content.takeaway)
  })

  it('按去空白后的事实文本判断，并且重复准备保持幂等', () => {
    const content: PresetContent = {
      title: '空白归一化',
      items: ['已有项'],
      facts: [{ id: 'f1', text: '证据 \n已确认' }],
    }

    const prepared = preparePresetContent(content)

    expect(prepared.items).toEqual(['已有项', '证据 \n已确认'])
    expect(preparePresetContent(prepared)).toEqual(prepared)
  })

  it('存在 nodes 时不追加破坏配对，并保留缺失事实供后续报告', () => {
    const content: PresetContent = {
      title: '结构化页',
      nodes: ['输入', '输出'],
      items: ['说明输入', '说明输出'],
      facts: [
        { id: 'node-fact', text: '输入' },
        { id: 'missing-fact', text: '待补证据' },
        { id: 'optional', text: '可选补充', required: false },
      ],
    }

    const prepared = preparePresetContent(content)
    const visible = [prepared.title, ...(prepared.nodes ?? []), ...(prepared.items ?? [])].join('\n')

    expect(prepared).toEqual(content)
    expect(missingRequiredFacts(prepared, visible)).toEqual(['missing-fact'])
  })

  it('可选 facts 不会在缺少 items 时强行生成可见内容', () => {
    const content: PresetContent = {
      title: '只有可选事实',
      facts: [{ id: 'optional', text: '可选补充', required: false }],
    }

    expect(preparePresetContent(content)).toEqual(content)
  })
})
