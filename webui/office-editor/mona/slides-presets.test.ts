import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  PRESET_THEMES,
  expandPreset,
  findPreset,
  presetCatalog,
  presetWarnings,
  selectPresets,
  type PresetContent,
} from './slides-presets'
import {
  presetBoundaryContent,
  presetCapacitySlots,
  presetCapacityTable,
  presetOverflowContent,
} from './slides-preset-capacity'

const PAGE = { width: 1280, height: 720 }

const darkChartContent: PresetContent = {
  title: '收入差距来源于结构化升级',
  summary: '2025 全年，单位：千美元，来源：经营台账',
  takeaway: '8 个百分点',
  items: ['A 相比 B 的差距来自高端线占比', '低端线毛利率同比下降 3 个百分点'],
  chart: {
    kind: 'bar',
    categories: ['方案 A', '方案 B', '方案 C'],
    series: [{ name: '完成率', values: [72, 64, 58] }],
    legendPos: 'none',
    gridlines: true,
    dataLabels: true,
    catAxisTitle: '方案',
    valAxisTitle: '百分比',
    gapWidthPct: 60,
  },
}

describe('预设页面契约', () => {
  it('暴露简短目录，不要求调用方加载整个页面库', () => {
    const catalog = presetCatalog()
    expect(new Set(catalog.map((item) => item.id)).size).toBe(catalog.length)
    expect(catalog.some((item) => item.family === 'chart-insight')).toBe(true)
    for (const entry of catalog) {
      expect(entry.capacity.titleCharsMax).toBeGreaterThan(0)
      expect(entry.family).toBeTruthy()
      expect(PRESET_THEMES[entry.theme]).toBeTruthy()
    }
    expect(findPreset('missing-preset')).toBeUndefined()
  })

  it('所有预设元素都落在 1280×720 页内', () => {
    for (const preset of PRESETS) {
      for (const element of preset.elements) {
        const { x, y, width, height } = element.box
        expect(x, `${preset.id}.${element.role}.x`).toBeGreaterThanOrEqual(0)
        expect(y, `${preset.id}.${element.role}.y`).toBeGreaterThanOrEqual(0)
        expect(x + width, `${preset.id}.${element.role} 右边界`).toBeLessThanOrEqual(PAGE.width)
        expect(y + height, `${preset.id}.${element.role} 下边界`).toBeLessThanOrEqual(PAGE.height)
      }
    }
  })

  it('展开深色图表页：主题角色落到原生文本、图表和待应用样式上', () => {
    const expanded = expandPreset({ slideId: 's1', presetId: 'dark-chart-insight', content: darkChartContent })
    expect(expanded.roles).toEqual([
      'background', 'title', 'summary', 'chart', 'takeaway', 'evidence-1', 'evidence-2',
    ])
    const theme = PRESET_THEMES['dark-product']
    const background = expanded.operations[0]!
    expect(background.op).toBe('slide_add_shape')
    expect(background.payload).toMatchObject({ fillColor: theme.background, shape: 'rect' })
    const title = expanded.operations[1]!
    expect(title.op).toBe('slide_add_text')
    expect(title.payload).toMatchObject({ text: darkChartContent.title, x: 72, y: 59, width: 1136, height: 112 })
    expect(title.payload.font).toMatchObject({
      fontFamily: theme.fontFamily, fontSize: theme.sizes.title, color: theme.text, bold: true,
    })

    const chart = expanded.operations.find((item) => item.op === 'slide_add_chart')!
    expect(chart.payload).toMatchObject({
      kind: 'bar', categories: ['方案 A', '方案 B', '方案 C'],
      catAxisTitle: '方案', valAxisTitle: '百分比', gapWidthPct: 60,
    })
    // 系列色绝不能在创建阶段假装写入
    expect(chart.payload).not.toHaveProperty('colorScheme')
    expect(chart.payload).not.toHaveProperty('seriesColors')

    expect(expanded.pendingChartStyles).toEqual([{
      role: 'chart',
      style: {
        textColor: theme.chart.textColor,
        axisLabelColor: theme.chart.axisLabelColor,
        legendColor: theme.chart.legendColor,
        dataLabelColor: theme.chart.dataLabelColor,
          seriesColors: [theme.chart.seriesColors[0]],
          gridColor: theme.line,
          axisLineColor: theme.line,
          axisLabelFontSize: 12,
      },
    }])
  })

  it('主题层级与边距保持参考主题的换算结果', () => {
    // 参考 dashi theme02（画布 1920×1080）：pad 108/88、gap 32、title 58、hero titleScale 72、
    // subtitle 40、body 28、caption 24、metric 112；换算到 1280×720 后取整。
    const dark = PRESET_THEMES['dark-product']
    expect(dark.sizes).toEqual({ metric: 56, hero: 36, title: 29, subtitle: 20, body: 14, caption: 12 })
    expect(dark.pad).toEqual({ x: 72, y: 59 })
    expect(dark.gap).toBe(21)

    // 参考 dashi theme07（画布 1920×1080）：pad 96、gap 24、title 72、subtitle 40、body 28、caption 22、metric 112。
    const light = PRESET_THEMES['light-editorial']
    expect(light.sizes).toEqual({ metric: 56, hero: 36, title: 36, subtitle: 20, body: 14, caption: 11 })
    expect(light.pad).toEqual({ x: 64, y: 64 })
    expect(light.gap).toBe(16)

    for (const theme of [dark, light]) {
      expect(theme.reference).toContain('dashi')
      // 只用系统自带字体；缺字体时探针确认会被优雅替换而不破版
      expect(theme.fontFamily).toBe('Microsoft YaHei')
    }
  })

  it('页面内容不越出主题安全边距', () => {
    for (const preset of PRESETS) {
      const theme = PRESET_THEMES[preset.theme]
      for (const element of preset.elements) {
        if (element.role === 'background' || element.role === 'eyebrow') continue
        const where = `${preset.id}.${element.role}`
        expect(element.box.x, where).toBeGreaterThanOrEqual(48)
        expect(element.box.y, where).toBeGreaterThanOrEqual(48)
        expect(element.box.x + element.box.width, where).toBeLessThanOrEqual(PAGE.width - 48)
        expect(element.box.y + element.box.height, where).toBeLessThanOrEqual(PAGE.height - 48)
      }
    }
  })

  it('每个预设的声明容量在边界值上通过，超出任一槽位都会被拒绝', () => {
    for (const preset of PRESETS) {
      const boundary = presetBoundaryContent(preset)
      expect(presetWarnings(preset, boundary), `${preset.id} 边界内容`).toEqual([])
      // 边界内容必须能真正展开，而不是只过校验
      expect(() => expandPreset({
        slideId: 's1', presetId: preset.id, content: boundary, scale: { x: 9525, y: 9525 },
      }), `${preset.id} 边界展开`).not.toThrow()

      for (const slot of presetCapacitySlots(preset)) {
        const overflow = presetOverflowContent(preset, slot)
        expect(presetWarnings(preset, overflow).length, `${preset.id}.${slot} 超容量应被拒绝`)
          .toBeGreaterThan(0)
        expect(() => expandPreset({
          slideId: 's1', presetId: preset.id, content: overflow, scale: { x: 9525, y: 9525 },
        }), `${preset.id}.${slot} 超容量不应产生操作`).toThrow(/超过声明容量|缺少/)
      }
    }
  })

  it('容量边界记录覆盖全部变体，并列出真正被测到的槽位', () => {
    const table = presetCapacityTable()
    expect(table.map((row) => row.id)).toEqual(PRESETS.map((preset) => preset.id))
    for (const row of table) {
      const preset = findPreset(row.id)!
      expect(row.testedSlots).toEqual(presetCapacitySlots(preset))
      expect(row.testedSlots).toContain('title')
      expect(row.summary).toContain('标题≤')
    }
    // 有内容槽位的页面不能只测标题
    expect(findPreset('dark-chart-insight') && table.find((row) => row.id === 'dark-chart-insight')!.testedSlots)
      .toEqual(['title', 'summary', 'takeaway', 'items', 'series', 'categories'])
    expect(table.find((row) => row.id === 'light-process-map')!.testedSlots)
      .toEqual(['title', 'summary', 'items', 'nodes'])
    expect(table.find((row) => row.id === 'dark-product-hero')!.summary).toContain('必须提供真实素材')
  })

  it('按内容容量拒绝，并且在产生任何操作之前失败', () => {
    const tooLong = presetWarnings(findPreset('dark-chart-insight')!, {
      ...darkChartContent, title: '这是一个明显超过五十八个字符上限的长标题用来验证容量校验是否真的会在写入之前拦截并给出明确的错误提示信息而不是静默截断',
    })
    expect(tooLong.join()).toContain('title 超过声明容量')

    // 单条 items 也有实测上限，不能只限制条目数量
    const longItem = presetWarnings(findPreset('dark-chart-insight')!, {
      ...darkChartContent, items: ['这一条证据明显超过了三十八个字的单条上限所以应当被容量校验拦截而不是写入文档中', darkChartContent.items![1]!],
    })
    expect(longItem.join()).toContain('items[0] 超过声明容量')

    expect(() => expandPreset({
      slideId: 's1', presetId: 'dark-chart-insight',
      content: { ...darkChartContent, chart: { ...darkChartContent.chart!, categories: ['A', 'B', 'C'], series: [{ name: 'x', values: [1, 2] }] } },
    })).toThrow(/数值数量与 categories 不一致/)

    expect(() => expandPreset({ slideId: 's1', presetId: 'dark-product-hero', content: { title: '一屏掌握' } }))
      .toThrow(/缺少必填内容：image/)
    expect(() => expandPreset({ slideId: 's1', presetId: 'light-process-map', content: { title: '实施路径' } }))
      .toThrow(/缺少必填内容：nodes/)
    expect(() => expandPreset({ slideId: 's1', presetId: 'unknown', content: { title: 'x' } }))
      .toThrow(/不存在：unknown/)
  })

  it('产品大图页要求真实素材，并把图注绑定到摘要', () => {
    const content: PresetContent = {
      title: '一屏掌握用户画像',
      summary: '产品实拍，2026 年 9 月',
      items: ['实时聚合行为与画像', '支持按分群下钻'],
      image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    }
    const expanded = expandPreset({ slideId: 's2', presetId: 'dark-product-hero', content })
    const image = expanded.operations.find((item) => item.op === 'slide_add_image')!
    expect(image.payload).toMatchObject({ x: 560, y: 88, width: 648, height: 512 })
    const caption = expanded.operations.find((item) => item.op === 'slide_add_text' && item.payload.text === content.summary)!
    expect(caption.payload).toMatchObject({ x: 560, y: 620, width: 648, height: 30 })
    expect(expanded.pendingChartStyles).toEqual([])
  })

  it('流程页保留每个可编辑节点，并使用主题色与方向箭头', () => {
    const expanded = expandPreset({
      slideId: 's3', presetId: 'light-process-map',
      content: { title: '实施路径', summary: '三个阶段推进，每阶段都有明确验收', nodes: ['输入', '判断', '执行'], items: ['a', 'b', 'c'] },
      scale: { x: 9525, y: 9525 },
    })
    for (const node of ['输入','判断','执行']) expect(expanded.operations.some((op)=>op.payload.text===node)).toBe(true)
    expect(expanded.operations.filter((op)=>op.payload.shape==='rightArrow')).toHaveLength(2)
    expect(expanded.roles).toHaveLength(expanded.operations.length)
    expect(expanded.operations.filter((op)=>op.op==='slide_add_text').every((op)=>(op.payload.font as Record<string,unknown>).fontFamily==='Microsoft YaHei')).toBe(true)
  })

  it('拒绝内容丢失、未知字段和不适用画布，并按容量筛选候选', () => {
    expect(() => expandPreset({
      slideId: 's3', presetId: 'light-process-map',
      content: { title: '实施路径', nodes: ['输入', '判断'], items: ['a', 'b', 'c'] },
    })).toThrow(/nodes 至少需要/)
    expect(()=>expandPreset({slideId:'s1',presetId:'dark-chart-insight',content:{...darkChartContent,unknown:'不可忽略'} as PresetContent})).toThrow(/不支持内容字段/)
    expect(()=>expandPreset({slideId:'s1',presetId:'dark-chart-insight',content:darkChartContent,page:{width:1280,height:960}})).toThrow(/16:9/)
    const matches=selectPresets(darkChartContent,'chart-insight')
    expect(matches.map((p)=>p.id)).toContain('dark-chart-insight')
    expect(matches.length).toBeLessThanOrEqual(3)
  })
})
