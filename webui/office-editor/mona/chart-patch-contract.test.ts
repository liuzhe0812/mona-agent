import { describe, expect, it } from 'vitest'

import { Buffer } from 'buffer'
import { openSlidesDocument, saveSlidesDocument } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'

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

function archiveSnapshot(opened: Parameters<typeof runTxn>[0]): Map<string, string> {
  return new Map(
    [...opened.archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]),
  )
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
    }],
  })
  expect(result.applied).toBe(true)
  const chartId = result.records?.[0]?.created?.[0]
  if (!chartId) throw new Error('addChart did not return a chart element id.')
  return { document, chartId }
}

function rejectChartPatch(
  opened: Parameters<typeof runTxn>[0],
  chartId: string,
  patch: unknown,
) {
  const before = archiveSnapshot(opened)
  const result = runTxn(opened, {
    ops: [{ op: 'setChart', target: { slide: 0, el: chartId }, patch }],
  })
  expect(result.applied).toBe(false)
  expect(result.failures).toHaveLength(1)
  expect(result.failures?.[0]?.error).toContain('Available patch fields:')
  expect(result.failures?.[0]?.error).toContain('textColor')
  expect(result.failures?.[0]?.error).not.toContain('edit_chart')
  expect(archiveSnapshot(opened)).toEqual(before)
  return result.failures?.[0]?.error ?? ''
}

describe('setChart patch contract', () => {
  it.each([
    ['unknown field', { fontColor: 'FFFFFF' }, 'unknown patch field(s): fontColor'],
    ['empty patch', {}, '"patch" must contain at least one field'],
    [
      'dimension mismatch',
      {
        categories: ['Q1', 'Q2', 'Q3'],
        series: [{ name: '收入', values: [10, 20] }],
      },
      'data dimensions do not match',
    ],
    ['non-finite number', { gapWidthPct: Number.NaN }, 'gapWidthPct'],
    ['non-finite series value', { series: [{ name: '收入', values: [10, Number.POSITIVE_INFINITY] }] }, 'series'],
    ['invalid text color', { textColor: 'FFF' }, 'textColor'],
    ['invalid palette color', { colorScheme: ['#12GG34'] }, 'colorScheme'],
  ])('rejects %s without touching the archive', async (_name, patch, expected) => {
    const { document, chartId } = await newChartDocument()
    const error = rejectChartPatch(document.opened, chartId, patch)
    expect(error).toContain(expected)
  })

  it('keeps an imported chart descr when applying a pure text-color patch', async () => {
    const { document, chartId } = await newChartDocument()
    const chart = document.opened.deck.slides[0]?.elements.find((element) => element.id === chartId)
    if (!chart || chart.type !== 'chart') throw new Error('Created chart could not be resolved.')

    const foreignDescr = 'foreign-chart-marker'
    chart.anchor.originalXml = chart.anchor.originalXml.replace(
      'descr="aislides-chart"',
      `descr="${foreignDescr}"`,
    )
    chart.descr = foreignDescr

    const result = runTxn(document.opened, {
      ops: [{
        op: 'setChart',
        target: { slide: 0, el: chartId },
        patch: { textColor: 'FFFFFF', axisLabelColor: '#D9D9D9' },
      }],
    })
    expect(result.applied).toBe(true)
    expect(chart.descr).toBe(foreignDescr)
    expect(chart.anchor.originalXml).toContain(`descr="${foreignDescr}"`)

    const checkpoint = await saveSlidesDocument(document.opened)
    const reopened = await openSlidesDocument(checkpoint)
    const reopenedChart = reopened.opened.deck.slides[0]?.elements.find((element) => element.type === 'chart')
    expect(reopenedChart?.descr).toBe(foreignDescr)

    const chartPath = [...reopened.opened.archive.entries.keys()].find((path) => (
      /^ppt\/charts\/chart\d+\.xml$/.test(path)
    ))
    expect(chartPath).toBeTruthy()
    expect(reopened.opened.archive.readText(chartPath!)).toContain('val="FFFFFF"')
  })
})
