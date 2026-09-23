import { describe, expect, it } from 'vitest'

import { openSlidesDocument, saveSlidesDocument } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'
import { buildChartNode } from '../vendor/genoffice/packages/pptx-render/src/build-chart'
import { makeViewport } from '../vendor/genoffice/packages/pptx-render/src/coords'
import { HeuristicMetrics } from '../vendor/genoffice/packages/pptx-render/src/metrics'

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

function chartXml(document: Awaited<ReturnType<typeof openSlidesDocument>>): string {
  const path = [...document.opened.archive.entries.keys()].find((entry) => (
    /^ppt\/charts\/chart\d+\.xml$/.test(entry)
  ))
  if (!path) throw new Error('chart part was not written')
  const xml = document.opened.archive.readText(path)
  if (xml == null) throw new Error('chart part is empty')
  return xml
}

async function newChartDocument(): Promise<{
  document: Awaited<ReturnType<typeof openSlidesDocument>>
  chartId: string
}> {
  const blank = await fsPromises.readFile(blankPath)
  const document = await openSlidesDocument(asArrayBuffer(blank))
  const result = runTxn(document.opened, {
    ops: [{
      op: 'addChart',
      target: { slide: 0 },
      kind: 'bar',
      title: '季度收入',
      categories: ['Q1', 'Q2'],
      series: [{ name: '收入', values: [10, 20] }],
      offset: { x: 914400, y: 914400, cx: 4572000, cy: 2743200 },
      gridlines: true,
    }],
  })
  expect(result.applied, JSON.stringify(result.failures)).toBe(true)
  const chartId = result.records?.[0]?.created?.[0]
  if (!chartId) throw new Error('addChart did not return a chart element id.')
  return { document, chartId }
}

describe('setChart native axis and grid styles', () => {
  it('writes, reopens, and renders grid/axis colors and explicit point font size while preserving data', async () => {
    const { document, chartId } = await newChartDocument()
    const result = runTxn(document.opened, {
      ops: [{
        op: 'setChart',
        target: { slide: 0, el: chartId },
        patch: {
          gridColor: '#27324A',
          axisLineColor: '#AABBCC',
          axisLabelFontSize: 12,
        },
      }],
    })
    expect(result.applied, JSON.stringify(result.failures)).toBe(true)
    const currentChart = document.opened.deck.slides[0]?.elements.find((element) => element.type === 'chart')
    if (!currentChart) throw new Error('Chart id changed after the first style patch.')

    const lineOnly = runTxn(document.opened, {
      ops: [{
        op: 'setChart',
        target: { slide: 0, el: currentChart.id },
        patch: { axisLineColor: '#112233' },
      }],
    })
    expect(lineOnly.applied, JSON.stringify(lineOnly.failures)).toBe(true)

    const xml = chartXml(document)
    expect(xml).toContain('<c:majorGridlines>')
    expect(xml).toContain('val="27324A"')
    expect(xml).toContain('val="112233"')
    expect(xml).toContain('sz="1200"')
    expect(xml).toContain('<c:v>10</c:v>')
    expect(xml).toContain('<c:v>20</c:v>')

    const checkpoint = await saveSlidesDocument(document.opened)
    const reopened = await openSlidesDocument(checkpoint)
    const chart = reopened.opened.deck.slides[0]?.elements.find((element) => element.type === 'chart')
    if (!chart || chart.type !== 'chart') throw new Error('Reopened chart could not be resolved.')

    expect(chart.chart.categories).toEqual(['Q1', 'Q2'])
    expect(chart.chart.series[0]?.values).toEqual([10, 20])
    expect(chart.chart.valAxis).toMatchObject({
      gridColor: '#27324A',
      lineColor: '#112233',
      labelSizePt: 12,
    })
    expect(chart.chart.catAxis).toMatchObject({
      lineColor: '#112233',
      labelSizePt: 12,
    })

    const node = buildChartNode(
      'chart',
      chart.id,
      chart.chart,
      {
        x: 0,
        y: 0,
        w: 640,
        h: 400,
        centerX: 320,
        centerY: 200,
        rotationDeg: 0,
        flipH: false,
        flipV: false,
      },
      makeViewport({ cx: 12192000, cy: 6858000 }, 1280),
      new HeuristicMetrics(),
    )
    if (!node) throw new Error('Chart render node was not built.')
    expect(node.gridLines.some((line) => line.color === '#27324A')).toBe(true)
    expect(node.axisLines.every((line) => line.color === '#112233')).toBe(true)
    expect(node.labels.some((label) => label.text === 'Q1' && label.fontSizePx > 0)).toBe(true)
    const expectedLabelPx = (12 * 96) / 72 * makeViewport({ cx: 12192000, cy: 6858000 }, 1280).scale
    expect(node.labels.find((label) => label.text === 'Q1')?.fontSizePx).toBeCloseTo(expectedLabelPx)
  })
})
