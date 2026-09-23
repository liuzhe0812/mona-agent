import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import { openSlidesDocument, saveSlidesDocument } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'

/**
 * 图表主题化能力探针（Batch A）。
 * 结论只允许是三类：现有公开操作可写 / 底层可写但入口未暴露 / 引擎缺失。
 * 这里对每一类留下可复现证据，避免把读取能力当成写入能力。
 */

const getBuiltinModule = <T,>(name: string): T => {
  const getter = (process as unknown as {
    getBuiltinModule?: (moduleName: string) => unknown
  }).getBuiltinModule
  if (!getter) throw new Error('Node built-in module access is unavailable.')
  return getter(name) as T
}

const fsPromises = getBuiltinModule<{ readFile: (path: string) => Promise<Uint8Array> }>('node:fs/promises')
const pathModule = getBuiltinModule<{
  resolve: (...paths: string[]) => string
  dirname: (path: string) => string
}>('node:path')
const urlModule = getBuiltinModule<{ fileURLToPath: (url: string | URL) => string }>('node:url')
const here = urlModule.fileURLToPath(import.meta.url)
const blankPath = pathModule.resolve(
  pathModule.dirname(here),
  '../../../src-tauri/resources/office-editor/templates/blank.pptx',
)

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

async function newDocument() {
  const blank = await fsPromises.readFile(blankPath)
  return openSlidesDocument(asArrayBuffer(blank))
}

function chartXml(document: Awaited<ReturnType<typeof openSlidesDocument>>): string {
  const path = [...document.opened.archive.entries.keys()].find((entry) => (
    /^ppt\/charts\/chart\d+\.xml$/.test(entry)
  ))
  if (!path) throw new Error('chart part was not written')
  const xml = document.opened.archive.readText(path)
  if (xml == null) throw new Error('chart part is empty')
  return xml
}

async function chartDocument(extraOp: Record<string, unknown> = {}) {
  const document = await newDocument()
  const result = runTxn(document.opened, {
    ops: [{
      op: 'addChart',
      target: { slide: 0 },
      kind: 'bar',
      title: '季度收入',
      categories: ['Q1', 'Q2', 'Q3'],
      series: [
        { name: '收入', values: [1200, 1450, 1610] },
        { name: '成本', values: [720, 810, 900] },
      ],
      offset: { x: 914400, y: 914400, cx: 6400800, cy: 3657600 },
      legendPos: 'b',
      gridlines: true,
      dataLabels: true,
      catAxisTitle: '季度',
      valAxisTitle: '千美元',
      ...extraOp,
    }],
  })
  expect(result.applied, JSON.stringify(result.failures)).toBe(true)
  const chartId = result.records?.[0]?.created?.[0]
  if (!chartId) throw new Error('addChart did not return a chart element id.')
  return { document, chartId }
}

function seriesFillColors(xml: string): string[] {
  const seriesBlocks = xml.split('<c:ser>').slice(1)
  return seriesBlocks
    .map((block) => /<c:spPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"/.exec(block)?.[1])
    .filter((value): value is string => !!value)
}

describe('图表主题化探针', () => {
  it('[可写] 创建时可用双系列、轴标题、网格线、图例和数据标签', async () => {
    const { document } = await chartDocument()
    const xml = chartXml(document)
    expect(xml).toContain('<c:tx>')
    expect(xml).toContain('<c:majorGridlines/>')
    expect(xml).toContain('<c:legend>')
    expect(xml).toContain('<c:showVal val="1"/>')
    // 轴标题写入的是图表文字片段，轴文字颜色可后续统一主题化
    expect(xml).toContain('季度')
    expect(xml).toContain('千美元')
  })

  it('[入口缺口] addChart 静默忽略 colorScheme，创建阶段拿不到主题系列色', async () => {
    const { document } = await chartDocument({ colorScheme: ['#72DFC1', '#6C7CFF'] })
    // 传了 colorScheme 但不报错也不生效：这是最危险的一类，模型会以为已经设色
    expect(seriesFillColors(chartXml(document))).toEqual([])
  })

  it('[可写] setChart 的 colorScheme 能写入逐系列填充色，并在保存重开后保留', async () => {
    const { document, chartId } = await chartDocument()
    const themed = runTxn(document.opened, {
      ops: [{
        op: 'setChart',
        target: { slide: 0, el: chartId },
        patch: {
          colorScheme: ['#72DFC1', '#6C7CFF'],
          textColor: '#F5F7FA',
          axisLabelColor: '#B8C2D6',
          legendColor: '#B8C2D6',
          dataLabelColor: '#F5F7FA',
        },
      }],
    })
    expect(themed.applied, JSON.stringify(themed.failures)).toBe(true)
    expect(seriesFillColors(chartXml(document))).toEqual(['72DFC1', '6C7CFF'])

    const checkpoint = await saveSlidesDocument(document.opened)
    const reopened = await openSlidesDocument(checkpoint)
    const reopenedXml = chartXml(reopened)
    expect(seriesFillColors(reopenedXml)).toEqual(['72DFC1', '6C7CFF'])
    expect(reopenedXml).toContain('val="F5F7FA"')
    expect(reopenedXml).toContain('val="B8C2D6"')
  })

  it('[可写] 单点覆盖色 pointColors 优先级高于系列色', async () => {
    const { document, chartId } = await chartDocument()
    const themed = runTxn(document.opened, {
      ops: [{
        op: 'setChart',
        target: { slide: 0, el: chartId },
        patch: { colorScheme: ['#72DFC1', '#6C7CFF'], pointColors: { 0: { 1: '#FF6B6B' } } },
      }],
    })
    expect(themed.applied, JSON.stringify(themed.failures)).toBe(true)
    const xml = chartXml(document)
    expect(xml).toContain('<c:dPt>')
    expect(xml).toContain('val="FF6B6B"')
  })

  it('[入口缺口] 图例位置、柱间距、网格线开关在创建路径上未全部暴露', async () => {
    // 引擎 addChart 支持 gapWidthPct / pointColors / catAxisTitle，
    // 但 Mona 的 slide_add_chart 白名单只放行 legendPos/gridlines/dataLabels/valAxisTitle。
    const { document } = await chartDocument({ gapWidthPct: 60 })
    expect(chartXml(document)).toContain('<c:gapWidth val="60"/>')
  })

  it('[已补齐] 网格线颜色与坐标轴字号可写入', async () => {
    const { document, chartId } = await chartDocument()
    for (const patch of [{ gridColor: '#27324A' }, { axisLabelFontSize: 12 }, { axisLineColor: '#27324A' }]) {
      const result = runTxn(document.opened, {
        ops: [{ op: 'setChart', target: { slide: 0, el: document.opened.deck.slides[0]!.elements.find((element) => element.type === 'chart')!.id }, patch }],
      })
      expect(result.applied, JSON.stringify(result.failures)).toBe(true)
    }
    expect(chartXml(document)).toContain('27324A')
  })
})
