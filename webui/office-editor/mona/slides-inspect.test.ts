import { expect, it, vi } from 'vitest'

import { openSlidesDocument } from './slides-engine'

interface TestBridgeLike {
  emit: (message: unknown) => void
}

const harness = vi.hoisted(() => ({
  bridge: undefined as TestBridgeLike | undefined,
  slidesController: undefined as {
    selectionChanged?: (selection: { slideIndex: number; sourceIds: string[] }) => void
  } | undefined,
  posts: [] as Array<Record<string, unknown>>,
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
  useEffect: (effect: () => unknown) => effect(),
}))
vi.mock('react/jsx-runtime', () => ({
  Fragment: Symbol('Fragment'),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
}))
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: (element: { type?: unknown; props?: unknown }) => {
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        if ('type' in value && typeof (value as { type?: unknown }).type === 'function') {
          const component = (value as { type: (props: unknown) => unknown }).type
          visit(component((value as { props?: unknown }).props))
          return
        }
        if ('props' in value) {
          const props = (value as { props?: unknown }).props
          if (props && typeof props === 'object' && 'children' in props) {
            visit((props as { children?: unknown }).children)
          }
        }
        if (Array.isArray(value)) value.forEach(visit)
      }
      visit(element)
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

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

async function waitForPost(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
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

async function inspect(
  bridge: TestBridgeLike,
  sessionId: string,
  version: { editorEpoch: string; modelRevision: number },
  requestId: string,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  bridge.emit({ type: 'office_inspect', command: { sessionId, requestId, query } })
  const message = await waitForPost((candidate) => (
    candidate.type === 'office_inspect_result' && resultOf(candidate).requestId === requestId
  ))
  expect(resultOf(message)).toEqual(expect.objectContaining({ ok: true, version }))
  const nested = resultOf(message).result
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new Error('Slides inspect 结果无效。')
  return nested as Record<string, unknown>
}

async function inspectFailure(
  bridge: TestBridgeLike,
  sessionId: string,
  requestId: string,
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  bridge.emit({ type: 'office_inspect', command: { sessionId, requestId, query } })
  const message = await waitForPost((candidate) => (
    candidate.type === 'office_inspect_result' && resultOf(candidate).requestId === requestId
  ))
  return resultOf(message)
}

it('filters slide reads before materializing pages and returns complete selection details', async () => {
  harness.posts = []
  harness.bridge = undefined
  harness.slidesController = undefined
  ;(globalThis as { document?: unknown }).document = {
    addEventListener: vi.fn(),
    getElementById: () => ({}),
    fonts: { load: async () => [] },
  }
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    devicePixelRatio: 1,
  }

  const { slideElementTypeLabel: _label } = await import('./slides-entry')
  const bridge = harness.bridge as TestBridgeLike | undefined
  if (!bridge) throw new Error('Slides bridge was not created.')
  const sessionId = 'slides-inspect-filter-1'
  const version = { editorEpoch: 'slides-inspect-epoch-1', modelRevision: 0 }
  const source = await fsPromises.readFile(fixturePath)
  bridge.emit({
    type: 'office_open',
    sessionId,
    documentType: 'slides',
    version,
    file: asArrayBuffer(source),
  })
  await waitForPost((message) => message.type === 'office_editor_ready')

  const capabilities = await inspect(bridge, sessionId, version, 'capabilities-chart', {
    mode: 'capabilities',
    elementType: 'chart',
  })
  expect(capabilities).toEqual(expect.objectContaining({
    mode: 'capabilities',
    documentType: 'slides',
  }))
  expect((capabilities.operations as Array<Record<string, unknown>>).map((operation) => operation.op))
    .toContain('slide_set_chart_style')

  const pages = await inspect(bridge, sessionId, version, 'slides-all', { mode: 'slides', limit: 10 })
  const allSlides = pages.slides as Array<Record<string, unknown>>
  const firstSlide = allSlides[0]
  if (!firstSlide) throw new Error('固定 fixture 没有第一页。')
  const slideId = String(firstSlide.id)
  const allElements = firstSlide.elements as Array<Record<string, unknown>>
  const selected = allElements.find((element) => String(element.text ?? '').trim())
  if (!selected) throw new Error('固定 fixture 没有可选择元素。')
  const elementId = String(selected.id)

  const filtered = await inspect(bridge, sessionId, version, 'slides-filtered', {
    mode: 'slides',
    slideIds: [slideId],
    elementIds: [elementId],
    limit: 10,
  })
  const filteredSlides = filtered.slides as Array<Record<string, unknown>>
  expect(filteredSlides).toHaveLength(1)
  expect(filteredSlides[0]?.elements).toEqual([expect.objectContaining({ id: elementId })])

  const slidesApi = (window as unknown as {
    slidesApi: {
      getRenderSlides: () => Promise<Array<{
        nodes: Array<{ sourceId: string; durableId?: string; type: string; text?: { lines: Array<{ runs: Array<{ text: string }> }> } }>
      }>>
    }
  }).slidesApi
  const renderSlides = await slidesApi.getRenderSlides()
  const selectedSourceId = renderSlides[0]?.nodes.find((node) => node.durableId === elementId)?.sourceId
  if (!selectedSourceId) throw new Error('固定 fixture 元素缺少可选择 sourceId。')
  const controller = harness.slidesController as {
    selectionChanged?: (selection: { slideIndex: number; sourceIds: string[] }) => void
  } | undefined
  controller?.selectionChanged?.({ slideIndex: 0, sourceIds: [selectedSourceId] })

  const selection = await inspect(bridge, sessionId, version, 'selection-details', { mode: 'selection' })
  expect(selection).toEqual(expect.objectContaining({
    mode: 'selection',
    documentType: 'slides',
    slideId,
    elementIds: [elementId],
    slideWidth: expect.any(Number),
    slideHeight: expect.any(Number),
  }))
  expect(selection.elements).toEqual([expect.objectContaining({
    id: elementId,
    text: expect.any(String),
    x: expect.any(Number),
    y: expect.any(Number),
    width: expect.any(Number),
    height: expect.any(Number),
    style: expect.objectContaining({ fontColor: expect.any(String) }),
  })])

  const filteredCapabilities = await inspect(bridge, sessionId, version, 'capabilities-filtered', {
    mode: 'capabilities',
    operations: ['slide_set_text', 'slide_set_geometry'],
  })
  expect((filteredCapabilities.operations as Array<Record<string, unknown>>).map((operation) => operation.op))
    .toEqual(['slide_set_text', 'slide_set_geometry'])

  const unknownOperation = await inspectFailure(bridge, sessionId, 'capabilities-unknown', {
    mode: 'capabilities',
    operations: ['slide_missing'],
  })
  expect(unknownOperation).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({ code: 'INVALID_OPERATION', message: expect.stringContaining('slide_missing') }),
  }))

  const unknownSlide = await inspectFailure(bridge, sessionId, 'slides-unknown-slide', {
    mode: 'slides',
    slideIds: ['slide_missing'],
  })
  expect(unknownSlide).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({ code: 'INVALID_OPERATION', message: expect.stringContaining('slide_missing') }),
  }))

  const unknownElement = await inspectFailure(bridge, sessionId, 'slides-unknown-element', {
    mode: 'slides',
    slideIds: [slideId],
    elementIds: ['element_missing'],
  })
  expect(unknownElement).toEqual(expect.objectContaining({
    ok: false,
    error: expect.objectContaining({ code: 'INVALID_OPERATION', message: expect.stringContaining('element_missing') }),
  }))
})
