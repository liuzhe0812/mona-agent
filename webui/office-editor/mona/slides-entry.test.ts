import { describe, expect, it, vi } from 'vitest'

import {
  openSlidesDocument,
  saveSlidesDocument,
  slideText,
} from './slides-engine'

interface TestBridgeLike {
  emit: (message: unknown) => void
}

const harness = vi.hoisted(() => ({
  bridge: undefined as TestBridgeLike | undefined,
  slidesController: undefined as { requestAi: (request: { prompt: string; displayText?: string }) => void } | undefined,
  posts: [] as Array<Record<string, unknown>>,
  cleanups: [] as Array<() => void>,
}))

class TestBridge {
  private listener: ((message: unknown) => void) | undefined

  constructor() {
    harness.bridge = this
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  post(message: Record<string, unknown>): void {
    harness.posts.push(message)
  }

  close(): void {}

  emit(message: unknown): void {
    this.listener?.(message)
  }
}

vi.mock('./bridge', () => ({ MonaOfficeBridge: TestBridge }))
vi.mock('./slides-renderer', () => ({
  drawRenderSlide: vi.fn(),
  loadSlideImages: async () => new Map(),
}))
vi.mock('../vendor/genoffice/apps/slides/src/renderer/App', () => ({
  App: (props: { embeddedController?: typeof harness.slidesController }) => {
    harness.slidesController = props.embeddedController
    return null
  },
}))
vi.mock('react', () => ({
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(current: T) => [current, vi.fn()],
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => unknown) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') harness.cleanups.push(cleanup as () => void)
  },
}))
vi.mock('react/jsx-runtime', () => ({
  Fragment: Symbol('Fragment'),
  jsx: (type: unknown, props: unknown) => {
    if (props && typeof props === 'object' && 'embeddedController' in props) {
      harness.slidesController = (props as { embeddedController?: typeof harness.slidesController }).embeddedController
    }
    return { type, props }
  },
  jsxs: (type: unknown, props: unknown) => {
    if (props && typeof props === 'object' && 'embeddedController' in props) {
      harness.slidesController = (props as { embeddedController?: typeof harness.slidesController }).embeddedController
    }
    return { type, props }
  },
}))
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: (element: { type?: (props: unknown) => unknown; props?: unknown }) => {
      if (typeof element.type !== 'function') return
      const rendered = element.type(element.props)
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if ('props' in value) {
          const props = (value as { props?: unknown }).props
          if (props && typeof props === 'object' && 'embeddedController' in props) {
            harness.slidesController = (props as { embeddedController?: typeof harness.slidesController }).embeddedController
          }
          if (props && typeof props === 'object' && 'children' in props) visit((props as { children?: unknown }).children)
        }
        if (Array.isArray(value)) value.forEach(visit)
      }
      visit(rendered)
    },
  }),
}))

const getBuiltinModule = <T>(name: string): T => {
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
const fixturePath = pathModule.resolve(
  pathModule.dirname(here),
  '../vendor/genoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
)
const bundledBlankPath = pathModule.resolve(
  pathModule.dirname(here),
  '../../../src-tauri/resources/office-editor/templates/blank.pptx',
)

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

async function waitForPost(
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const message = harness.posts.find(predicate)
    if (message) return message
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('等待 Slides bridge 消息超时。')
}

function resultOf(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Slides 返回结果无效。')
  return result as Record<string, unknown>
}

function nestedResult(message: Record<string, unknown>): Record<string, unknown> {
  const result = resultOf(message).result
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Slides inspect 结果无效。')
  return result as Record<string, unknown>
}

async function inspect(
  bridge: TestBridgeLike,
  sessionId: string,
  version: { editorEpoch: string; modelRevision: number },
  requestId: string,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  bridge.emit({ type: 'office_inspect', command: { sessionId, requestId, query } })
  const message = await waitForPost((candidate) => (
    candidate.type === 'office_inspect_result'
    && resultOf(candidate).requestId === requestId
  ))
  expect(resultOf(message)).toEqual(expect.objectContaining({ ok: true, version }))
  return nestedResult(message)
}

async function apply(
  bridge: TestBridgeLike,
  sessionId: string,
  expectedVersion: { editorEpoch: string; modelRevision: number },
  operationId: string,
  operations: Array<{ op: string; payload: Record<string, unknown> }>,
): Promise<Record<string, unknown>> {
  bridge.emit({
    type: 'office_command',
    command: { sessionId, operationId, expectedVersion, operations },
  })
  const message = await waitForPost((candidate) => (
    candidate.type === 'office_command_result'
    && resultOf(candidate).operationId === operationId
  ))
  return resultOf(message)
}

async function inspectError(bridge: TestBridgeLike, sessionId: string, requestId: string, query: Record<string, unknown>) {
  bridge.emit({ type: 'office_inspect', command: { sessionId, requestId, query } })
  const message = await waitForPost((candidate) => candidate.type === 'office_inspect_result' && resultOf(candidate).requestId === requestId)
  expect(resultOf(message)).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'INVALID_OPERATION' }) }))
}

describe('Slides Mona entry', () => {
  it('opens and reopens a blank PPTX checkpoint', async () => {
    const blank = await fsPromises.readFile(bundledBlankPath)
    const document = await openSlidesDocument(asArrayBuffer(blank))
    expect(document.slides).toHaveLength(1)

    const checkpoint = await saveSlidesDocument(document.opened)
    const reopened = await openSlidesDocument(checkpoint)
    expect(reopened.slides).toHaveLength(1)
  })

  it('applies a GenOffice transaction for a table, transition, and speaker notes', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    await import('./slides-entry')
    const bridge = harness.bridge as TestBridgeLike | undefined
    if (!bridge) throw new Error('Slides bridge was not created.')
    const sessionId = 'slides-blank-txn-1'
    const version = { editorEpoch: 'slides-blank-epoch-1', modelRevision: 0 }
    const blank = await fsPromises.readFile(bundledBlankPath)
    bridge.emit({
      type: 'office_open',
      sessionId,
      documentType: 'slides',
      version,
      file: asArrayBuffer(blank),
    })
    await waitForPost((message) => (
      message.type === 'office_editor_ready'
      && message.sessionId === sessionId
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === 0
    ))

    const pagesResult = await inspect(bridge, sessionId, version, 'blank-txn-slides-1', {
      mode: 'slides',
      slideIds: [],
      limit: 10,
    })
    const page = (pagesResult.slides as Array<Record<string, unknown>>)[0]
    if (!page) throw new Error('空白演示文稿没有第一页。')
    const slideId = String(page.id)
    const nextVersion = { ...version, modelRevision: 1 }
    const result = await apply(bridge, sessionId, version, 'blank-txn-1', [{
      op: 'slide_apply_txn',
      payload: {
        ops: [
          {
            op: 'addTable',
            target: { slide: slideId },
            rows: 2,
            cols: 2,
            offset: { x: 100_000, y: 100_000, cx: 3_000_000, cy: 1_500_000 },
          },
          { op: 'setTransition', target: { slide: slideId }, kind: 'fade' },
          { op: 'setNotes', target: { slide: slideId }, text: 'AI 备注' },
        ],
      },
    }])
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      version: nextVersion,
    }))

    const slidesApi = (window as unknown as {
      slidesApi: {
        getRenderSlides: () => Promise<Array<{ nodes: Array<{ type: string }> }> | null>
        getTransition: (slideIndex: number) => Promise<string>
        getNotes: (slideIndex: number) => Promise<string>
      }
    }).slidesApi
    expect(await slidesApi.getTransition(0)).toBe('fade')
    expect(await slidesApi.getNotes(0)).toBe('AI 备注')

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version: nextVersion })
    const checkpointMessage = await waitForPost((message) => (
      message.type === 'office_checkpoint'
      && message.sessionId === sessionId
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === 1
    ))
    const checkpoint = checkpointMessage.file
    if (!(checkpoint instanceof ArrayBuffer)) throw new Error('空白演示文稿 checkpoint 不是 ArrayBuffer。')

    bridge.emit({
      type: 'office_open',
      sessionId,
      documentType: 'slides',
      version: nextVersion,
      file: checkpoint,
    })
    await waitForPost((message) => (
      message.type === 'office_editor_ready'
      && message.sessionId === sessionId
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === 1
    ))
    expect(await slidesApi.getTransition(0)).toBe('fade')
    expect(await slidesApi.getNotes(0)).toBe('AI 备注')
    const reopenedSlides = await slidesApi.getRenderSlides()
    expect(reopenedSlides?.[0]?.nodes.some((node) => node.type === 'table')).toBe(true)
  })

  it('creates native charts in pixel coordinates, rejects mismatched data and preserves chart XML', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    await import('./slides-entry')
    const bridge = harness.bridge as TestBridgeLike | undefined
    if (!bridge) throw new Error('Slides bridge was not created.')
    const sessionId = 'slides-chart-txn-1'
    const version = { editorEpoch: 'slides-chart-epoch-1', modelRevision: 0 }
    const blank = await fsPromises.readFile(bundledBlankPath)
    bridge.emit({
      type: 'office_open',
      sessionId,
      documentType: 'slides',
      version,
      file: asArrayBuffer(blank),
    })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const pages = await inspect(bridge, sessionId, version, 'chart-slides-1', {
      mode: 'slides',
      slideIds: [],
      limit: 10,
    })
    const page = (pages.slides as Array<Record<string, unknown>>)[0]
    if (!page) throw new Error('空白演示文稿没有第一页。')
    const slideId = String(page.id)
    const invalid = await apply(bridge, sessionId, version, 'chart-invalid', [{
      op: 'slide_add_chart', payload: { slideId, x: 100, y: 150, width: 700, height: 350,
        kind: 'bar', categories: ['Q1', 'Q2'], series: [{ name: '收入', values: [1] }] },
    }])
    expect(invalid.ok).toBe(false)
    expect(invalid.currentVersion).toEqual(version)
    const result = await apply(bridge, sessionId, version, 'chart-add-1', [{
      op: 'slide_add_chart',
      payload: {
            slideId, x: 100, y: 150, width: 700, height: 350,
            kind: 'bar',
            title: '季度收入（千美元）',
            categories: ['Q1', 'Q2', 'Q3'],
            series: [{ name: '收入（千美元）', values: [1200, 1450, 1610] }],
            legendPos: 'none',
            gridlines: true,
            dataLabels: true,
            valAxisTitle: '千美元',
      },
    }])
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      version: { editorEpoch: version.editorEpoch, modelRevision: 1 },
    }))
    const nextVersion = result.version as typeof version
    expect(result.createdElements).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'chart', x: 100, y: 150, width: 700, height: 350 })]))

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version: nextVersion })
    const checkpointMessage = await waitForPost((message) => (
      message.type === 'office_checkpoint'
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === 1
    ))
    const checkpoint = checkpointMessage.file
    if (!(checkpoint instanceof ArrayBuffer)) throw new Error('图表 PPTX checkpoint 不是 ArrayBuffer。')
    const reopened = await openSlidesDocument(checkpoint)
    const chartNode = reopened.slides[0]?.nodes.find((node) => node.type === 'chart') as
      | { styleInfo?: Record<string, unknown> }
      | undefined
    expect(chartNode?.styleInfo).toEqual(expect.objectContaining({
      legendPos: 'none',
      gridlines: true,
      dataLabels: true,
      valAxisTitle: '千美元',
    }))
    const chartPath = [...reopened.opened.archive.entries.keys()].find((path) => (
      /^ppt\/charts\/chart\d+\.xml$/.test(path)
    ))
    if (!chartPath) throw new Error('保存后的 PPTX 没有 chart XML。')
    const chartXml = reopened.opened.archive.readText(chartPath)
    expect(chartXml).toBeTruthy()
    expect(chartXml).not.toContain('<c:legend>')
    expect(chartXml).toContain('<c:majorGridlines/>')
    expect(chartXml).toContain('<c:dLbls>')
    expect(chartXml).toContain('<a:t>千美元</a:t>')
    expect(chartXml).toContain('1450')
    expect(chartXml).toContain('Q2')
  })

  it('edits chart text through stable IDs, reports no-ops, and preserves colors across save and data edits', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}), fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1,
    }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'chart-text-session'
    let version = { editorEpoch: 'chart-text-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')
    const pages = await inspect(bridge, sessionId, version, 'chart-text-pages', { mode: 'slides' })
    const slideId = String((pages.slides as Array<Record<string, unknown>>)[0]!.id)
    const added = await apply(bridge, sessionId, version, 'chart-text-add', [{
      op: 'slide_apply_txn', payload: { ops: [{
        op: 'addChart', target: { slide: slideId }, kind: 'bar', title: '收入',
        categories: ['Q1', 'Q2'], series: [{ name: '收入', values: [12, 18] }],
        legendPos: 'b', dataLabels: true, valAxisTitle: '万元',
        offset: { x: 914400, y: 914400, cx: 5486400, cy: 2743200 },
      }] },
    }])
    expect(added.ok).toBe(true)
    version = added.version as typeof version
    const elements = await inspect(bridge, sessionId, version, 'chart-text-elements', { mode: 'slides' })
    const element = ((elements.slides as Array<Record<string, unknown>>)[0]!.elements as Array<Record<string, unknown>>)
      .find((item) => item.type === 'chart')!
    const elementId = String(element.id)
    expect(elementId).toMatch(/^e_/)
    expect(element.chart).toEqual(expect.objectContaining({
      categories: ['Q1', 'Q2'], supportedTextStyleFields: expect.arrayContaining(['textColor', 'legendColor']),
    }))
    const style = {
      textColor: '#E2E8F0', titleColor: '#FACC15', axisLabelColor: '#A5B4FC',
      axisTitleColor: '#67E8F9', legendColor: '#86EFAC', dataLabelColor: '#FDA4AF',
    }
    const recolored = await apply(bridge, sessionId, version, 'chart-text-color', [{
      op: 'slide_set_chart_style', payload: { slideId, elementId, style },
    }])
    expect(recolored).toEqual(expect.objectContaining({ ok: true, version: { ...version, modelRevision: 2 } }))
    version = recolored.version as typeof version
    const visible = await inspect(bridge, sessionId, version, 'chart-text-immediate', { mode: 'slides' })
    const visibleChart = ((visible.slides as Array<Record<string, unknown>>)[0]!.elements as Array<Record<string, unknown>>)
      .find((item) => item.id === elementId)!.chart
    expect(visibleChart).toEqual(expect.objectContaining({
      textStyle: expect.objectContaining({ textColor: '#E2E8F0', titleColor: '#FACC15', legendColor: '#86EFAC' }),
    }))
    const api = (window as unknown as { slidesApi: { getRenderSlides: () => Promise<Array<{ nodes: Array<{
      type: string; labels?: Array<{ text: string; color: string }>
    }> }>> } }).slidesApi
    const visibleNode = (await api.getRenderSlides())[0]!.nodes.find((node) => node.type === 'chart')!
    expect(visibleNode.labels).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Q1', color: '#A5B4FC' }),
      expect.objectContaining({ text: '万元', color: '#67E8F9' }),
    ]))
    const unchanged = await apply(bridge, sessionId, version, 'chart-text-repeat', [{
      op: 'slide_set_chart_style', payload: { slideId, elementId, style },
    }])
    expect(unchanged).toEqual(expect.objectContaining({ ok: true, unchanged: true, version, changedTargets: [] }))
    const rejected = await apply(bridge, sessionId, version, 'chart-text-unknown', [{
      op: 'slide_apply_txn', payload: { ops: [{ op: 'setChart', target: { slide: slideId, el: elementId },
        patch: { fontColor: '#FFFFFF' } }] },
    }])
    expect(rejected.ok).toBe(false)
    expect(JSON.stringify(rejected)).toContain('textColor')
    const edited = await apply(bridge, sessionId, version, 'chart-text-data', [{
      op: 'slide_apply_txn', payload: { ops: [{ op: 'setChart', target: { slide: slideId, el: elementId },
        patch: { title: '更新收入', series: [{ name: '收入', values: [15, 21] }] } }] },
    }])
    expect(edited.ok).toBe(true)
    version = edited.version as typeof version
    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === version.modelRevision)
    const reopened = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    const chart = reopened.opened.deck.slides[0]!.elements.find((item) => item.type === 'chart')
    if (!chart || chart.type !== 'chart') throw new Error('Missing chart after save')
    expect(chart.chart).toEqual(expect.objectContaining({
      textColor: '#E2E8F0', titleColor: '#FACC15', legendColor: '#86EFAC', dataLabelColor: '#FDA4AF',
      title: '更新收入', categories: ['Q1', 'Q2'],
    }))
    expect(chart.chart.series[0]!.values).toEqual([15, 21])
    expect(chart.chart.valAxis).toEqual(expect.objectContaining({ labelColor: '#A5B4FC', titleColor: '#67E8F9' }))
    const font = await apply(bridge, sessionId, version, 'chart-text-font-color', [{
      op: 'slide_set_font', payload: { slideId, elementId, font: { color: '#FFFFFF' } },
    }])
    expect(font.ok).toBe(true)
    version = font.version as typeof version
    const fontRejected = await apply(bridge, sessionId, version, 'chart-text-font-size', [{
      op: 'slide_set_font', payload: { slideId, elementId, font: { size: 24 } },
    }])
    expect(fontRejected.ok).toBe(false)
  })

  it('creates native mixed elements, returns exact IDs and supports local edit, old checkpoints and undo', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'mixed-layout'
    let version = { editorEpoch: 'mixed-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')
    const pages = await inspect(bridge, sessionId, version, 'mixed-pages', { mode: 'slides' })
    const slideId = String((pages.slides as Array<Record<string, unknown>>)[0]!.id)
    const result = await apply(bridge, sessionId, version, 'mixed-compose', [{ op: 'slide_compose', payload: {
      slideId, columns: [2, 1], rows: [1, 3], items: [
        { type: 'text', row: 0, column: 0, columnSpan: 2, text: '混排标题', font: { fontSize: 32, color: '#203040' } },
        { type: 'image', row: 1, column: 0, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
        { type: 'shape', row: 1, column: 1, shape: 'rect', fillColor: '#F3EEE5' },
        { type: 'svg', row: 1, column: 1, inset: 40, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#D94732"/></svg>' },
      ],
    } }])
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const created = result.createdElements as Array<Record<string, unknown>>
    expect(created.map((element) => element.type).sort()).toEqual(['picture', 'picture', 'shape', 'text'])
    expect(new Set(created.map((element) => element.id)).size).toBe(4)
    expect(result.warnings).toEqual([])
    version = result.version as typeof version
    const firstVersion = { ...version }
    const rejected = await apply(bridge, sessionId, version, 'mixed-dangerous-svg', [{ op: 'slide_apply_txn', payload: {
      ops: [{ op: 'addPicture', target: { slide: slideId }, ext: 'svg',
        bytes: [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>')],
        offset: { x: 0, y: 0, cx: 100000, cy: 100000 } }],
    } }])
    expect(rejected.ok).toBe(false)
    const text = created.find((element) => element.type === 'text')!
    const edited = await apply(bridge, sessionId, version, 'mixed-edit-title', [{ op: 'slide_set_text',
      payload: { slideId, elementId: text.id, text: '仍可编辑' } }])
    expect(edited.ok).toBe(true)
    expect(edited.updatedElements).toEqual(expect.arrayContaining([expect.objectContaining({ id: text.id, text: '仍可编辑' })]))
    version = edited.version as typeof version
    bridge.emit({ type: 'office_checkpoint_request', sessionId, version: firstVersion })
    const prior = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === firstVersion.modelRevision)
    const reopenedPrior = await openSlidesDocument(prior.file as ArrayBuffer)
    expect(slideText(reopenedPrior.slides[0]!)).toContain('混排标题')
    expect([...reopenedPrior.opened.archive.entries.keys()].some((path) => path.endsWith('.svg'))).toBe(true)
    expect([...reopenedPrior.opened.archive.entries.keys()].some((path) => path.endsWith('.png'))).toBe(true)
    const api = (window as unknown as { slidesApi: { undo: () => Promise<unknown>; redo: () => Promise<unknown>; getRenderSlides: () => Promise<typeof reopenedPrior.slides> } }).slidesApi
    await api.undo()
    expect(slideText((await api.getRenderSlides())[0]!)).toContain('混排标题')
    await api.undo()
    expect((await api.getRenderSlides())[0]!.nodes.filter((node) => !node.decoration)).toHaveLength(0)
    await api.redo()
    expect(slideText((await api.getRenderSlides())[0]!)).toContain('混排标题')
  })

  it('runs inspect, edit, page management, atomic bounds rejection, and checkpoint reopen through the bridge', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    const { slideElementTypeLabel } = await import('./slides-entry')
    expect([
      'shape',
      'text',
      'picture',
      'table',
      'group',
      'chart',
      'placeholder-chip',
    ].map(slideElementTypeLabel)).toEqual([
      '图形',
      '文本',
      '图片',
      '表格',
      '组合',
      '图表',
      '占位符',
    ])
    const bridge = harness.bridge as TestBridgeLike | undefined
    if (!bridge) throw new Error('Slides bridge was not created.')
    const sessionId = 'slides-session-1'
    const epoch = 'slides-epoch-1'
    let version = { editorEpoch: epoch, modelRevision: 0 }
    const source = await fsPromises.readFile(fixturePath)
    bridge.emit({
      type: 'office_open',
      sessionId,
      documentType: 'slides',
      version,
      file: asArrayBuffer(source),
    })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const slidesController = Reflect.get(harness, 'slidesController') as
      | {
          requestAi: (request: { prompt: string; displayText?: string }) => void
          selectionChanged?: (selection: { slideIndex: number; sourceIds: string[] }) => void
        }
      | undefined
    if (!slidesController) throw new Error('GenOffice Slides controller was not mounted.')
    slidesController.requestAi({
      prompt: '把封面标题改成季度复盘',
      displayText: '请修改当前演示文稿的封面标题',
    })
    expect(harness.posts).toContainEqual({
      type: 'office_ai_request',
      sessionId,
      prompt: '把封面标题改成季度复盘',
      displayText: '请修改当前演示文稿的封面标题',
    })

    const summary = await inspect(bridge, sessionId, version, 'summary-1', { mode: 'summary' })
    expect(summary).toEqual(expect.objectContaining({ documentType: 'slides', slideCount: expect.any(Number) }))
    expect(Number(summary.elementCount)).toBeGreaterThan(0)

    const outline = await inspect(bridge, sessionId, version, 'outline-1', { mode: 'outline', limit: 10 })
    expect(Array.isArray(outline.items)).toBe(true)
    expect(outline.items).not.toHaveLength(0)

    const pagesResult = await inspect(bridge, sessionId, version, 'slides-1', {
      mode: 'slides',
      slideIds: [],
      limit: 10,
    })
    const pages = pagesResult.slides as Array<Record<string, unknown>>
    const firstPage = pages[0]
    if (!firstPage) throw new Error('固定 fixture 没有第一页。')
    const slideId = String(firstPage.id)
    const elements = firstPage.elements as Array<Record<string, unknown>>
    const textElement = elements.find((element) => String(element.text ?? '').trim())
    if (!textElement) throw new Error('固定 fixture 没有可编辑文本元素。')
    const elementId = String(textElement.id)
    const renderSlides = await (window as unknown as {
      slidesApi: {
        getRenderSlides: () => Promise<Array<{ nodes: Array<{ sourceId: string; type: string; text?: { lines: Array<{ runs: Array<{ text: string }> }> } }> }> | null>
      }
    }).slidesApi.getRenderSlides()
    const selectedSourceId = renderSlides?.[0]?.nodes.find((node) => (
      (node.type === 'shape' || node.type === 'text')
      && node.text?.lines.flatMap((line) => line.runs.map((run) => run.text)).join('') === String(textElement.text)
    ))?.sourceId
    if (!selectedSourceId) throw new Error('固定 fixture 没有可选择的文本元素。')
    slidesController.selectionChanged?.({ slideIndex: 0, sourceIds: [selectedSourceId] })
    const selection = await inspect(bridge, sessionId, version, 'selection-1', { mode: 'selection' })
    expect(selection).toEqual(expect.objectContaining({
      slideId,
      elementIds: [elementId],
    }))

    let result = await apply(bridge, sessionId, version, 'text-1', [{
      op: 'slide_set_text',
      payload: { slideId, elementId, text: 'Mona Slides 测试文本' },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    const search = await inspect(bridge, sessionId, version, 'search-text-1', {
      mode: 'search',
      text: 'Mona Slides 测试文本',
      limit: 10,
    })
    expect(search.matches).toHaveLength(1)

    result = await apply(bridge, sessionId, version, 'geometry-1', [{
      op: 'slide_set_geometry',
      payload: { slideId, elementId, x: 80, y: 60, width: 520, height: 150 },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    result = await apply(bridge, sessionId, version, 'add-text-1', [{
      op: 'slide_add_text',
      payload: { slideId, text: '新增文本', x: 100, y: 520, width: 300, height: 100 },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    result = await apply(bridge, sessionId, version, 'add-shape-1', [{
      op: 'slide_add_shape',
      payload: { slideId, shape: 'rect', fillColor: '#D9EAF7', x: 460, y: 520, width: 200, height: 100 },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    result = await apply(bridge, sessionId, version, 'add-slide-1', [{
      op: 'slide_add',
      payload: { slideId },
    }])
    expect(result.ok).toBe(true)
    expect(result.createdSlides).toEqual([expect.objectContaining({
      id: expect.any(String),
      index: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    })])
    version = result.version as typeof version

    let currentPages = (await inspect(bridge, sessionId, version, 'slides-2', { mode: 'slides', limit: 10 })).slides as Array<Record<string, unknown>>
    expect(currentPages.length).toBeGreaterThan(1)
    result = await apply(bridge, sessionId, version, 'duplicate-slide-1', [{
      op: 'slide_duplicate',
      payload: { slideId },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    result = await apply(bridge, sessionId, version, 'move-slide-1', [{
      op: 'slide_move',
      payload: { slideId, toIndex: 1 },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    currentPages = (await inspect(bridge, sessionId, version, 'slides-3', { mode: 'slides', limit: 10 })).slides as Array<Record<string, unknown>>
    const removable = currentPages.find((page) => page.id !== slideId)
    if (!removable) throw new Error('页管理操作没有产生可删除页面。')
    result = await apply(bridge, sessionId, version, 'delete-slide-1', [{
      op: 'slide_delete',
      payload: { slideId: String(removable.id) },
    }])
    expect(result.ok).toBe(true)
    version = result.version as typeof version

    const beforeFailed = version
    result = await apply(bridge, sessionId, version, 'atomic-bounds-1', [
      {
        op: 'slide_set_text',
        payload: { slideId, elementId, text: '不应保存的修改' },
      },
      {
        op: 'slide_set_geometry',
        payload: { slideId, elementId, x: 0, y: 0, width: 9999, height: 9999 },
      },
    ])
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      currentVersion: beforeFailed,
      error: expect.objectContaining({ code: 'INVALID_OPERATION' }),
    }))

    const afterFailed = await inspect(bridge, sessionId, beforeFailed, 'search-after-failed', {
      mode: 'search',
      text: '不应保存的修改',
      limit: 10,
    })
    expect(afterFailed.matches).toEqual([])

    const slidesApi = (window as unknown as {
      slidesApi: {
        getRenderSlides: () => Promise<Array<{ nodes: Array<{ sourceId: string; type: string }> }> | null>
        editText: (op: Record<string, unknown>) => Promise<unknown>
      }
    }).slidesApi
    const rendered = await slidesApi.getRenderSlides()
    const editable = rendered?.[0]?.nodes.find((node) => node.type === 'shape' || node.type === 'text')
    if (!editable) throw new Error('完整 Slides 界面没有可编辑文本元素。')
    await slidesApi.editText({
      slideIndex: 0,
      sourceId: editable.sourceId,
      paragraphs: [{ runs: [{ text: '完整界面编辑' }] }],
    })
    const userChange = await waitForPost((message) => (
      message.type === 'office_user_change'
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === beforeFailed.modelRevision + 1
    ))
    version = userChange.version as typeof version

    bridge.emit({ type: 'office_checkpoint_request', version })
    const checkpointMessage = await waitForPost((message) => (
      message.type === 'office_checkpoint'
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === version.modelRevision
    ))
    const checkpoint = checkpointMessage.file
    if (!(checkpoint instanceof ArrayBuffer)) throw new Error('Slides checkpoint 不是 ArrayBuffer。')
    const reopened = await openSlidesDocument(checkpoint)
    expect(reopened.slides.some((slide) => slideText(slide).includes('完整界面编辑'))).toBe(true)
  })

  it('round-trips native add styles and rejects an expired version', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    await import('./slides-entry')
    const bridge = harness.bridge as TestBridgeLike | undefined
    if (!bridge) throw new Error('Slides bridge was not created.')
    const sessionId = 'slides-style-roundtrip-1'
    const version = { editorEpoch: 'slides-style-epoch-1', modelRevision: 0 }
    const blank = await fsPromises.readFile(bundledBlankPath)
    bridge.emit({
      type: 'office_open',
      sessionId,
      documentType: 'slides',
      version,
      file: asArrayBuffer(blank),
    })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const pages = await inspect(bridge, sessionId, version, 'style-slides-1', {
      mode: 'slides',
      slideIds: [],
      limit: 10,
    })
    const page = (pages.slides as Array<Record<string, unknown>>)[0]
    if (!page) throw new Error('空白演示文稿没有第一页。')
    const slideId = String(page.id)
    const result = await apply(bridge, sessionId, version, 'style-add-1', [
      {
        op: 'slide_add_text',
        payload: {
          slideId,
          text: '原生样式保留',
          x: 100,
          y: 100,
          width: 420,
          height: 100,
          align: 'center',
          font: { fontFamily: 'Arial', fontSize: 24, bold: true, color: '#123456' },
        },
      },
      {
        op: 'slide_add_shape',
        payload: {
          slideId,
          shape: 'rect',
          text: '边框形状',
          x: 100,
          y: 240,
          width: 420,
          height: 120,
          fillColor: '#F0F4FF',
          strokeColor: '#345678',
          strokeWidthPt: 2,
          font: { fontFamily: 'Arial', fontSize: 18, color: '#345678' },
        },
      },
    ])
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      version: { editorEpoch: version.editorEpoch, modelRevision: 1 },
    }))
    const nextVersion = result.version as typeof version

    const styledPages = await inspect(bridge, sessionId, nextVersion, 'style-slides-2', {
      mode: 'slides',
      slideIds: [slideId],
      limit: 10,
    })
    const styledPage = (styledPages.slides as Array<Record<string, unknown>>)[0]
    const styledElements = styledPage?.elements as Array<Record<string, unknown>> | undefined
    const textElement = styledElements?.find((element) => element.text === '原生样式保留')
    const shapeElement = styledElements?.find((element) => element.text === '边框形状')
    expect(textElement?.style).toEqual(expect.objectContaining({
      fontFamily: 'Arial',
      fontSizePt: 24,
      align: 'center',
    }))
    expect(shapeElement?.style).toEqual(expect.objectContaining({
      fill: '#F0F4FF',
      stroke: { color: '#345678', widthPt: 2 },
    }))

    const expired = await apply(bridge, sessionId, version, 'style-expired-1', [{
      op: 'slide_set_text',
      payload: {
        slideId,
        elementId: String(textElement?.id),
        text: '不应覆盖新版本',
      },
    }])
    expect(expired).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    }))

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version: nextVersion })
    const checkpointMessage = await waitForPost((message) => (
      message.type === 'office_checkpoint'
      && (message.version as { modelRevision?: number } | undefined)?.modelRevision === 1
    ))
    const checkpoint = checkpointMessage.file
    if (!(checkpoint instanceof ArrayBuffer)) throw new Error('样式 PPTX checkpoint 不是 ArrayBuffer。')
    const reopened = await openSlidesDocument(checkpoint)
    const reopenedNodes = reopened.slides[0]?.nodes ?? []
    const reopenedText = reopenedNodes.find((node) => (
      (node.type === 'shape' || node.type === 'text')
      && node.text?.lines.flatMap((line) => line.runs.map((run) => run.text)).join('') === '原生样式保留'
    ))
    expect(reopenedText?.type === 'shape' || reopenedText?.type === 'text').toBe(true)
    if (reopenedText?.type === 'shape' || reopenedText?.type === 'text') {
      expect(reopenedText.text?.lines[0]?.runs[0]?.fontFamily).toBe('Arial')
      expect(reopenedText.text?.lines[0]?.runs[0]?.bold).toBe(true)
      expect(reopenedText.text?.lines[0]?.align).toBe('center')
    }
  })

  it('routes visual inspect to the requested stable slide without editing the deck', async () => {
    vi.resetModules()
    vi.doMock('./slides-visual', () => ({
      captureSlide: async () => ({
        dataUrl: 'data:image/png;base64,AA==',
        width: 1280,
        height: 720,
      }),
      VisualVersionConflict: class extends Error {},
    }))
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    try {
      await import('./slides-entry')
      const bridge = harness.bridge as TestBridgeLike | undefined
      if (!bridge) throw new Error('Slides bridge was not created.')
      const sessionId = 'slides-visual-route-1'
      const version = { editorEpoch: 'slides-visual-epoch-1', modelRevision: 0 }
      const blank = await fsPromises.readFile(bundledBlankPath)
      bridge.emit({
        type: 'office_open',
        sessionId,
        documentType: 'slides',
        version,
        file: asArrayBuffer(blank),
      })
      await waitForPost((message) => message.type === 'office_editor_ready')
      const pages = await inspect(bridge, sessionId, version, 'visual-slides-1', {
        mode: 'slides',
        slideIds: [],
        limit: 10,
      })
      const slide = (pages.slides as Array<Record<string, unknown>>)[0]
      if (!slide) throw new Error('空白演示文稿没有第一页。')
      const result = await inspect(bridge, sessionId, version, 'visual-1', {
        mode: 'visual',
        slideId: String(slide.id),
      })
      expect(result).toEqual({
        mode: 'visual',
        dataUrl: 'data:image/png;base64,AA==',
        width: 1280,
        height: 720,
        target: String(slide.id),
        warnings: [],
        pendingVisualSlideIds: [],
      })
      expect(version).toEqual({ editorEpoch: 'slides-visual-epoch-1', modelRevision: 0 })
    } finally {
      vi.doUnmock('./slides-visual')
    }
  })

  it('tracks review pages across edits, full-page visual capture, crop, failure, and reopen', async () => {
    vi.resetModules()
    let captureMode: 'ok' | 'fail' = 'ok'
    vi.doMock('./slides-visual', () => ({
      captureSlide: async () => {
        if (captureMode === 'fail') throw new Error('模拟画面捕获失败。')
        return { dataUrl: 'data:image/png;base64,AA==', width: 1280, height: 720 }
      },
      VisualVersionConflict: class extends Error {},
    }))
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    harness.slidesController = undefined
    ;(globalThis as { document?: unknown }).document = {
      getElementById: () => ({}),
      fonts: { load: async () => [] },
    }
    ;(globalThis as { window?: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      devicePixelRatio: 1,
    }

    try {
      await import('./slides-entry')
      const bridge = harness.bridge as TestBridgeLike | undefined
      if (!bridge) throw new Error('Slides bridge was not created.')
      const sessionId = 'slides-review-route-1'
      let version = { editorEpoch: 'slides-review-epoch-1', modelRevision: 0 }
      const blank = await fsPromises.readFile(bundledBlankPath)
      bridge.emit({
        type: 'office_open',
        sessionId,
        documentType: 'slides',
        version,
        file: asArrayBuffer(blank),
      })
      await waitForPost((message) => message.type === 'office_editor_ready' && message.sessionId === sessionId)

      const initialReview = await inspect(bridge, sessionId, version, 'review-initial', { mode: 'review' })
      expect(initialReview).toEqual({
        mode: 'review',
        documentType: 'slides',
        pendingSlideIds: [],
        warnings: [],
      })
      const pages = await inspect(bridge, sessionId, version, 'review-pages', { mode: 'slides', limit: 10 })
      const slide = (pages.slides as Array<Record<string, unknown>>)[0]
      if (!slide) throw new Error('空白演示文稿没有第一页。')
      const slideId = String(slide.id)

      let result = await apply(bridge, sessionId, version, 'review-add-1', [{
        op: 'slide_add_text',
        payload: { slideId, text: '需要复核', x: 100, y: 100, width: 300, height: 100 },
      }])
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        pendingVisualSlideIds: [slideId],
      }))
      const firstCommandResult = result
      version = result.version as typeof version

      const afterEdit = await inspect(bridge, sessionId, version, 'review-after-edit', { mode: 'review' })
      expect(afterEdit.pendingSlideIds).toEqual([slideId])

      const fullVisual = await inspect(bridge, sessionId, version, 'review-full-visual', {
        mode: 'visual',
        slideId,
      })
      expect(fullVisual.pendingVisualSlideIds).toEqual([])
      expect((await inspect(bridge, sessionId, version, 'review-after-full-visual', { mode: 'review' })).pendingSlideIds)
        .toEqual([])
      const commandResultCount = () => harness.posts.filter((message) => message.type === 'office_command_result').length
      const beforeReplay = commandResultCount()
      bridge.emit({
        type: 'office_command',
        command: {
          sessionId,
          operationId: 'review-add-1',
          expectedVersion: { editorEpoch: version.editorEpoch, modelRevision: 0 },
          operations: [{
            op: 'slide_add_text',
            payload: { slideId, text: '需要复核', x: 100, y: 100, width: 300, height: 100 },
          }],
        },
      })
      for (let attempt = 0; attempt < 200 && commandResultCount() <= beforeReplay; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(commandResultCount()).toBe(beforeReplay + 1)
      const replay = harness.posts.filter((message) => message.type === 'office_command_result').at(-1)
      if (!replay) throw new Error('幂等命令没有返回回执。')
      expect(resultOf(replay)).toEqual(firstCommandResult)

      result = await apply(bridge, sessionId, version, 'review-add-2', [{
        op: 'slide_add_text',
        payload: { slideId, text: '溢出'.repeat(100), x: 100, y: 240, width: 40, height: 20 },
      }])
      expect(result.pendingVisualSlideIds).toEqual([slideId])
      version = result.version as typeof version
      const overflowElementId = String((result.createdElements as Array<Record<string, unknown>>)[0]?.id)
      if (!overflowElementId || overflowElementId === 'undefined') throw new Error('溢出元素没有返回稳定 ID。')
      const cropped = await inspect(bridge, sessionId, version, 'review-cropped-visual', {
        mode: 'visual',
        slideId,
        region: { x: 0, y: 0, width: 400, height: 300 },
      })
      expect(cropped.pendingVisualSlideIds).toEqual([slideId])
      const afterCrop = await inspect(bridge, sessionId, version, 'review-after-crop', { mode: 'review' })
      expect(afterCrop.pendingSlideIds).toEqual([slideId])
      expect(afterCrop.warnings).toEqual(expect.arrayContaining([expect.stringContaining(overflowElementId)]))

      captureMode = 'fail'
      bridge.emit({
        type: 'office_inspect',
        command: { sessionId, requestId: 'review-failed-visual', query: { mode: 'visual', slideId } },
      })
      const failedVisual = await waitForPost((message) => (
        message.type === 'office_inspect_result' && resultOf(message).requestId === 'review-failed-visual'
      ))
      expect(resultOf(failedVisual)).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INVALID_OPERATION' }),
      }))
      expect((await inspect(bridge, sessionId, version, 'review-after-failure', { mode: 'review' })).pendingSlideIds)
        .toEqual([slideId])

      captureMode = 'ok'
      const warningVisual = await inspect(bridge, sessionId, version, 'review-full-visual-2', { mode: 'visual', slideId })
      expect(warningVisual.warnings).toEqual(expect.arrayContaining([expect.stringContaining(overflowElementId)]))
      const afterWarningVisual = await inspect(bridge, sessionId, version, 'review-after-warning-visual', { mode: 'review' })
      expect(afterWarningVisual.pendingSlideIds).toEqual([slideId])
      expect(afterWarningVisual.warnings).toEqual(expect.arrayContaining([expect.stringContaining(overflowElementId)]))
      result = await apply(bridge, sessionId, version, 'review-fix-overflow', [{
        op: 'slide_set_text',
        payload: { slideId, elementId: overflowElementId, text: '' },
      }])
      version = result.version as typeof version
      const afterWarningFix = await inspect(bridge, sessionId, version, 'review-after-warning-fix', { mode: 'review' })
      expect(afterWarningFix.warnings).toEqual([])
      expect(afterWarningFix.pendingSlideIds).toEqual([slideId])
      await inspect(bridge, sessionId, version, 'review-after-warning-fix-visual', { mode: 'visual', slideId })
      expect((await inspect(bridge, sessionId, version, 'review-after-warning-fix-final', { mode: 'review' })).pendingSlideIds)
        .toEqual([])

      result = await apply(bridge, sessionId, version, 'review-add-picture-overlay', [{
        op: 'slide_add_image',
        payload: {
          slideId, x: 600, y: 100, width: 200, height: 200,
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        },
      }, {
        op: 'slide_add_text',
        payload: { slideId, text: '有意的图片叠字', x: 610, y: 120, width: 180, height: 80 },
      }])
      version = result.version as typeof version
      await inspectError(bridge, sessionId, 'review-overlay-before-seeing', {
        mode: 'visual', slideId, acceptWarnings: true, reviewReason: '尚未观察不应接受',
      })
      const overlayVisual = await inspect(bridge, sessionId, version, 'review-overlay-visual', { mode: 'visual', slideId })
      expect(overlayVisual.warnings).toEqual(expect.arrayContaining([expect.stringContaining('[需检查]')]))
      expect(overlayVisual.pendingVisualSlideIds).toEqual([slideId])
      await inspectError(bridge, sessionId, 'review-overlay-no-reason', { mode: 'visual', slideId, acceptWarnings: true })
      await inspectError(bridge, sessionId, 'review-overlay-crop-accept', {
        mode: 'visual', slideId, acceptWarnings: true, reviewReason: '局部不能放行', region: { x: 600, y: 100, width: 200, height: 200 },
      })
      const acceptedOverlay = await inspect(bridge, sessionId, version, 'review-overlay-accepted', {
        mode: 'visual', slideId, acceptWarnings: true, reviewReason: '文字有意放在图片留白区，已检查整页且文字清晰。',
      })
      expect(acceptedOverlay.pendingVisualSlideIds).toEqual([])
      expect(acceptedOverlay.reviewReason).toContain('图片留白区')

      result = await apply(bridge, sessionId, version, 'review-add-3', [{
        op: 'slide_add_text',
        payload: { slideId, text: '断开后仍需复核', x: 100, y: 380, width: 300, height: 100 },
      }])
      version = result.version as typeof version
      expect(result.pendingVisualSlideIds).toEqual([slideId])

      const reopenedSessionId = 'slides-review-route-2'
      await inspectError(bridge, sessionId, 'review-overlay-after-edit', {
        mode: 'visual', slideId, acceptWarnings: true, reviewReason: '旧版本观察不能放行',
      })
      bridge.emit({
        type: 'office_open',
        sessionId: reopenedSessionId,
        documentType: 'slides',
        version,
        pendingVisualSlideIds: [slideId],
        file: asArrayBuffer(blank),
      })
      await waitForPost((message) => message.type === 'office_editor_ready' && message.sessionId === reopenedSessionId)
      expect((await inspect(bridge, reopenedSessionId, version, 'review-after-reopen', { mode: 'review' })).pendingSlideIds)
        .toEqual([slideId])

      const comparisonText = ['示例模型 A', '• 编码测试结果仅供本回归测试使用', '• 推理测试与价格需要按统一字段比较',
        '• 输入和输出价格必须区分单位', '', '示例模型 B', '• 编码测试结果仅供本回归测试使用',
        '• 推理测试与价格需要按统一字段比较', '• 输入和输出价格必须区分单位', '', '示例模型 C',
        '• 编码测试结果仅供本回归测试使用', '• 推理测试与价格需要按统一字段比较',
        '• 输入和输出价格必须区分单位，并注明数据来源与测试日期，保持各模型之间的比较口径一致'].join('\n')
      const comparison = await apply(bridge, reopenedSessionId, version, 'comparison-single-box', [{
        op: 'slide_compose', payload: { slideId, columns: [1], rows: [0.3, 1], gap: 24, items: [
          { type: 'text', column: 0, row: 0, text: '三个示例模型的比较', font: { fontSize: 32, bold: true } },
          { type: 'text', column: 0, row: 1, text: comparisonText, font: { fontSize: 14 } },
        ] },
      }])
      expect(comparison.ok).toBe(true)
      expect(comparison.warnings).toEqual(expect.arrayContaining([expect.stringContaining('单个全宽文本框')]))
      version = comparison.version as typeof version
      const singleBoxReview = await inspect(bridge, reopenedSessionId, version, 'comparison-review', { mode: 'review' })
      expect(singleBoxReview.warnings).toEqual(expect.arrayContaining([expect.stringContaining('单个全宽文本框')]))
      const singleBoxVisual = await inspect(bridge, reopenedSessionId, version, 'comparison-visual', { mode: 'visual', slideId })
      expect(singleBoxVisual.pendingVisualSlideIds).toEqual([slideId])
      const bodyId = (comparison.createdElements as Array<Record<string, unknown>>)[1]!.id
      const split = await apply(bridge, reopenedSessionId, version, 'comparison-split', [
        { op: 'slide_delete_element', payload: { slideId, elementId: bodyId } },
        { op: 'slide_compose', payload: { slideId, x: 48, y: 210, width: 1184, height: 450,
          columns: [1, 1, 1], rows: [1], gap: 24, items: ['A', 'B', 'C'].map((name, column) => ({
            type: 'text', column, row: 0, text: `示例模型 ${name}\n编码：待测\n推理：待测\n价格：待核对`, font: { fontSize: 18 },
          })) } },
      ])
      expect(split.ok).toBe(true)
      version = split.version as typeof version
      const splitReview = await inspect(bridge, reopenedSessionId, version, 'comparison-split-review', { mode: 'review' })
      expect(splitReview.warnings).toEqual([])
      expect(splitReview.pendingSlideIds).toEqual([slideId])
      const splitVisual = await inspect(bridge, reopenedSessionId, version, 'comparison-split-visual', { mode: 'visual', slideId })
      expect(splitVisual.pendingVisualSlideIds).toEqual([])
    } finally {
      vi.doUnmock('./slides-visual')
    }
  })
})
