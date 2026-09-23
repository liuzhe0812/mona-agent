import { describe, expect, it, vi } from 'vitest'
import type { RenderNode, RenderSlide } from '@genoffice/pptx-render'
import { elementDurableId, slideDurableId } from '@genoffice/pptx-engine'
import { mapXmlColors } from './slides-colors'
import type { SlidesApi } from '../vendor/genoffice/apps/slides/src/shared/ipc'

import {
  openSlidesDocument,
  saveSlidesDocument,
  slideText,
} from './slides-engine'
import { isBlockingLayoutWarning, slideLayoutWarnings } from './slides-layout'
import { PRESETS, presetWarnings, type PresetContent } from './slides-presets'
import { presetBoundaryContent } from './slides-preset-capacity'
import qualityFixture from '../tests/presets/quality-content.json'
import workflowFixture from '../tests/presets/workflow-content.json'
import designFixture from '../tests/design/components.json'

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
  it('recolors the same document after human edits, preserving IDs, layout, data, exclusions and undo', async () => {
    vi.resetModules()
    harness.posts = []; harness.cleanups = []; harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!, sessionId = 'inplace-recolor'
    let version = { editorEpoch: 'inplace-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version, file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((m) => m.type === 'office_editor_ready')
    const built = await apply(bridge, sessionId, version, 'color-source', [
      { op: 'slide_add_text', payload: { slideId: 's_1', x: 70, y: 60, width: 1100, height: 80, text: '原始标题', font: { fontSize: 30, color: '#25856B' } } },
      { op: 'slide_add_text', payload: { slideId: 's_1', x: 70, y: 180, width: 500, height: 120, paragraphs: [{ runs: [{ text: '2,052.51', fontSize: 54, color: '#25856B' }, { text: ' 万元', fontSize: 18, color: '#172621' }] }] } },
      { op: 'slide_add_shape', payload: { slideId: 's_1', x: 70, y: 380, width: 180, height: 80, shape: 'rect', fillColor: '#25856B', text: '人工保护色' } },
      { op: 'slide_add_shape', payload: { slideId: 's_1', x: 70, y: 510, width: 180, height: 80, shape: 'rect', fillColor: '#AA0000', text: '风险' } },
      { op: 'slide_add_path', payload: { slideId: 's_1', x: 350, y: 380, width: 180, height: 80, path: [['M', 0, 0], ['C', 0.3, 0, 0.5, 1, 1, 1], ['L', 0, 1], ['Z']], fillColor: '#25856B88' } },
      { op: 'slide_add_chart', payload: { slideId: 's_1', x: 640, y: 180, width: 550, height: 400, kind: 'bar', categories: ['基期', '当前'], series: [{ name: '收入', values: [56, 75] }, { name: '亏损', values: [-20, -15] }], style: { seriesColors: ['#25856B', '#AA0000'], axisLabelColor: '#172621' } } },
    ])
    expect(built.ok, JSON.stringify(built.error)).toBe(true)
    version = built.version as typeof version
    const elements = built.createdElements as Array<{ id: string; text: string }>
    const title = elements.find((e) => e.text === '原始标题')!, protectedId = elements.find((e) => e.text === '人工保护色')!.id
    const api = (window as unknown as { slidesApi: SlidesApi }).slidesApi
    await api.editText({ slideIndex: 0, sourceId: title.id, paragraphs: [{ runs: [{ text: '人工修改已确认，#25856B是文本', fontSize: 30, color: '#25856B' }] }] })
    const user = await waitForPost((m) => m.type === 'office_user_change')
    version = user.version as typeof version
    const capture = async () => {
      bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
      const m = await waitForPost((x) => x.type === 'office_checkpoint' && (x.version as typeof version)?.modelRevision === version.modelRevision)
      return openSlidesDocument(m.file as ArrayBuffer)
    }
    const before = await capture()
    const palette = await inspect(bridge, sessionId, version, 'color-inventory', { mode: 'palette' })
    expect(JSON.stringify(palette)).toContain('#25856B')
    const caps = await inspect(bridge, sessionId, version, 'color-caps', { mode: 'capabilities', operations: ['slide_set_style', 'slide_set_fill'] })
    expect(caps.unsupportedOperations).toEqual(['slide_set_style'])
    expect((caps.operations as Array<{op:string}>).map((o) => o.op)).toEqual(['slide_set_fill'])
    const oldVersion = version
    const payload = { replacements: [{ from: '#25856B', to: '#E56B20' }], excludeElementIds: [protectedId] }
    const changed = await apply(bridge, sessionId, version, 'color-change', [{ op: 'slide_replace_colors', payload }])
    expect(changed.ok, JSON.stringify(changed.error)).toBe(true)
    expect(changed.sessionId).toBe(sessionId)
    expect(changed.createdSlides).toEqual([])
    expect(changed.createdElements).toEqual([])
    expect((changed.colorChanges as Array<{colorReplacements:number}>)[0]!.colorReplacements).toBeGreaterThan(3)
    version = changed.version as typeof version
    expect(version.modelRevision).toBe(oldVersion.modelRevision + 1)
    const after = await capture()
    const identity = (d: typeof before) => d.opened.deck.slides.map((s) => ({ slide: slideDurableId(s), elements: s.elements.map((e) => ({ id: elementDurableId(e), type: e.type, transform: e.transform })) }))
    expect(identity(after)).toEqual(identity(before))
    expect(after.slides.map(slideText)).toEqual(before.slides.map(slideText))
    expect(after.slides.map(slideText).join('')).toContain('人工修改已确认')
    for (const [name, bytes] of before.opened.archive.entries) {
      const updated = after.opened.archive.entries.get(name)!
      if (/^ppt\/(slides|charts)\/[^/]+\.xml$/.test(name)) {
        expect(mapXmlColors(new TextDecoder().decode(updated), () => '000000').text, name)
          .toBe(mapXmlColors(new TextDecoder().decode(bytes), () => '000000').text)
      } else expect(updated, name).toEqual(bytes)
    }
    const oldProtected = before.opened.deck.slides[0]!.elements.find((e) => elementDurableId(e) === protectedId)!
    expect(after.opened.deck.slides[0]!.elements.find((e) => elementDurableId(e) === protectedId)!.anchor.originalXml).toBe(oldProtected.anchor.originalXml)
    const stale = await apply(bridge, sessionId, oldVersion, 'color-stale', [{ op: 'slide_replace_colors', payload }])
    expect((stale.error as {code:string}).code).toBe('VERSION_CONFLICT')
    const noop = await apply(bridge, sessionId, version, 'color-noop', [{ op: 'slide_replace_colors', payload }])
    expect(noop.unchanged).toBe(true); expect(noop.version).toEqual(version)
    const failed = await apply(bridge, sessionId, version, 'color-rollback', [
      { op: 'slide_replace_colors', payload: { replacements: [{ from: '#E56B20', to: '#0000FF' }] } },
      { op: 'slide_set_fill', payload: { slideId: 's_1', elementId: 'nonexistent', color: '#000000' } },
    ])
    expect(failed.ok).toBe(false)
    const current = await inspect(bridge, sessionId, version, 'color-still-orange', { mode: 'palette' })
    expect(JSON.stringify(current)).toContain('#E56B20'); expect(JSON.stringify(current)).not.toContain('#0000FF')
    await api.undo()
    version = { ...version, modelRevision: version.modelRevision + 1 }
    const undone = await capture()
    expect(undone.opened.archive.readText('ppt/slides/slide1.xml')).toBe(before.opened.archive.readText('ppt/slides/slide1.xml'))
    await api.redo()
    version = { ...version, modelRevision: version.modelRevision + 1 }
    const redone = await capture()
    expect(redone.opened.archive.readText('ppt/slides/slide1.xml')).toBe(after.opened.archive.readText('ppt/slides/slide1.xml'))
  })

  it('creates all native designs through the production bridge and preserves freeform geometry and rich text on reopen', async () => {
    vi.resetModules()
    harness.posts = []; harness.cleanups = []; harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'native-components'
    let version = { editorEpoch: 'native-components-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version, file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message)=>message.type==='office_editor_ready')
    const initial = await inspect(bridge,sessionId,version,'design-initial',{mode:'slides'})
    let slideId = String((initial.slides as Array<{id:string}>)[0]!.id)
    for (const [index,page] of designFixture.decks[0]!.pages.entries()) {
      if (index) { const added=await apply(bridge,sessionId,version,`design-add-${index}`,[{op:'slide_add',payload:{slideId}}]); expect(added.ok).toBe(true); version=added.version as typeof version; slideId=(added.createdSlides as Array<{id:string}>)[0]!.id }
      const payload = {...structuredClone(page.operations[0]!.payload),slideId} as Record<string,unknown>
      if(page.name==='image') {
        const bytes=Buffer.from(await fsPromises.readFile(urlModule.fileURLToPath(new URL('../tests/design/product-workspace.png',import.meta.url))))
        ;(payload.content as Record<string,unknown>).image={dataUrl:`data:image/png;base64,${bytes.toString('base64')}`,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}
      }
      const result=await apply(bridge,sessionId,version,`design-build-${index}`,[{op:'slide_add_design',payload}])
      expect(result.ok,`${page.name}: ${JSON.stringify(result.error)}`).toBe(true)
      expect((result.warnings as string[]).filter((w)=>w.startsWith('[错误]')),page.name).toEqual([])
      version=result.version as typeof version
    }
    const budget = await apply(bridge,sessionId,version,'design-cannot-expand-raw-budget',[
      {op:'slide_add_design',payload:{slideId,design:'items',region:{x:20,y:20,width:320,height:220},content:{title:'',items:[{label:'预算检查'}]}}},
      ...Array.from({length:26},()=>({op:'slide_add_chart',payload:{slideId,x:20,y:20,width:200,height:200,kind:'bar',categories:['A'],series:[{name:'数据',values:[1]}],style:{textColor:'#172621'}}})),
    ])
    expect(budget.ok).toBe(false)
    expect(JSON.stringify(budget.error)).toContain('50 个原始操作')
    const revision=version.modelRevision
    const failed=await apply(bridge,sessionId,version,'design-path-invalid',[
      {op:'slide_add_text',payload:{slideId,x:70,y:620,width:900,height:40,text:'不应留下'}},
      {op:'slide_add_path',payload:{slideId,x:50,y:150,width:300,height:300,path:[['M',0,0],['C',1,1,2,2,3,3]],fillColor:'#FFFFFF'}},
    ])
    expect(failed.ok).toBe(false)
    const unsafe = await apply(bridge,sessionId,version,'design-path-unsafe-color',[
      {op:'slide_add_path',payload:{slideId,x:50,y:150,width:300,height:300,path:[['M',0,0],['L',1,1]],fillColor:'\"/><a:bad/>'}},
    ])
    expect(unsafe.ok).toBe(false)
    bridge.emit({type:'office_checkpoint_request',sessionId,version})
    const checkpoint=await waitForPost((m)=>m.type==='office_checkpoint' && (m.version as typeof version)?.modelRevision===revision)
    const reopened=await openSlidesDocument(checkpoint.file as ArrayBuffer)
    expect(reopened.slides).toHaveLength(11)
    expect(reopened.slides.map(slideText).join('')).not.toContain('不应留下')
    expect(reopened.opened.deck.slides[4]!.elements.some((el)=>'customGeometry' in el && !!el.customGeometry)).toBe(true)
    const xml=reopened.opened.archive.readText('ppt/slides/slide2.xml')!
    expect(xml).toContain('2,052.51')
    expect(xml).toContain('万元')
    const fonts=[...xml.matchAll(/sz="(\d+)"/g)].map((m)=>Number(m[1]))
    expect(Math.max(...fonts)).toBeGreaterThan(6000)
    expect(reopened.opened.archive.readText('ppt/slides/slide5.xml')).toContain('a:cubicBezTo')
  })

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

  it('applies themed chart series colors through seriesColors and keeps them in the saved file', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'chart-theme-session'
    let version = { editorEpoch: 'chart-theme-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')
    const pages = await inspect(bridge, sessionId, version, 'chart-theme-pages', { mode: 'slides' })
    const slideId = String((pages.slides as Array<Record<string, unknown>>)[0]!.id)

    // 创建阶段的轴标题与柱间距现在可用；系列色不是创建字段，必须被明确拒绝而不是静默忽略。
    const createRejected = await apply(bridge, sessionId, version, 'chart-theme-create-color', [{
      op: 'slide_add_chart', payload: {
        slideId, x: 100, y: 150, width: 700, height: 350, kind: 'bar',
        categories: ['Q1', 'Q2'], series: [{ name: '收入', values: [12, 18] }],
        seriesColors: ['#72DFC1'],
      },
    }])
    expect(createRejected.ok).toBe(false)
    expect(createRejected.currentVersion).toEqual(version)

    const created = await apply(bridge, sessionId, version, 'chart-theme-create', [{
      op: 'slide_add_chart', payload: {
        slideId, x: 100, y: 150, width: 700, height: 350, kind: 'bar',
        title: '季度收入', categories: ['Q1', 'Q2'],
        series: [{ name: '收入', values: [12, 18] }, { name: '成本', values: [7, 9] }],
        legendPos: 'b', gridlines: true, dataLabels: true,
        catAxisTitle: '季度', valAxisTitle: '千美元', gapWidthPct: 60,
      },
    }])
    expect(created.ok).toBe(true)
    version = created.version as typeof version
    const elements = await inspect(bridge, sessionId, version, 'chart-theme-elements', { mode: 'slides' })
    const elementId = String(((elements.slides as Array<Record<string, unknown>>)[0]!.elements as Array<Record<string, unknown>>)
      .find((item) => item.type === 'chart')!.id)

    const badColors = await apply(bridge, sessionId, version, 'chart-theme-bad', [{
      op: 'slide_set_chart_style', payload: { slideId, elementId, style: { seriesColors: ['FFF'] } },
    }])
    expect(badColors.ok).toBe(false)
    expect(JSON.stringify(badColors)).toContain('seriesColors')

    const themed = await apply(bridge, sessionId, version, 'chart-theme-apply', [{
      op: 'slide_set_chart_style', payload: {
        slideId, elementId,
        style: { seriesColors: ['#72DFC1', '#6C7CFF'], textColor: '#F5F7FA', axisLabelColor: '#B8C2D6' },
      },
    }])
    expect(themed.ok).toBe(true)
    version = themed.version as typeof version

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === version.modelRevision)
    const reopened = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    const chartPath = [...reopened.opened.archive.entries.keys()].find((path) => (
      /^ppt\/charts\/chart\d+\.xml$/.test(path)
    ))!
    const xml = reopened.opened.archive.readText(chartPath)
    if (xml == null) throw new Error('saved chart part is empty')
    // 逐系列填充色与文字色都必须落到导出的图表部件里，不能被编辑器内预览吃掉。
    const seriesBlocks = xml.split('<c:ser>').slice(1)
    expect(seriesBlocks.map((block) => /<c:spPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"/.exec(block)?.[1]))
      .toEqual(['72DFC1', '6C7CFF'])
    expect(xml).toContain('val="F5F7FA"')
    expect(xml).toContain('val="B8C2D6"')
  })

  it('instantiates preset pages, maps roles to real IDs, and themes charts after creation', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'preset-session'
    let version = { editorEpoch: 'preset-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const slideIds = async (): Promise<string[]> => {
      const result = await inspect(bridge, sessionId, version, `preset-slides-${version.modelRevision}`, { mode: 'slides' })
      return (result.slides as Array<Record<string, unknown>>).map((slide) => String(slide.id))
    }
    const addSlideAfter = async (afterId: string, tag: string): Promise<string> => {
      const added = await apply(bridge, sessionId, version, tag, [{ op: 'slide_add', payload: { slideId: afterId } }])
      expect(added.ok).toBe(true)
      version = added.version as typeof version
      const ids = await slideIds()
      const index = ids.indexOf(afterId)
      const next = ids[index + 1]
      if (!next) throw new Error('slide_add 没有产生新页面')
      return next
    }

    const firstId = (await slideIds())[0]!
    const chartPage = await apply(bridge, sessionId, version, 'preset-chart', [{
      op: 'slide_add_preset', payload: {
        slideId: firstId, presetId: 'dark-chart-insight',
        content: {
          title: '收入差距来自结构化升级',
          summary: '2025 全年，单位：千美元，来源：经营台账',
          takeaway: '8 个百分点',
          items: ['A 相比 B 的差距来自高端线占比', '低端线毛利率同比下降 3 个百分点'],
          chart: {
            kind: 'bar', categories: ['方案 A', '方案 B', '方案 C'],
            series: [{ name: '完成率', values: [72, 64, 58] }],
            legendPos: 'none', gridlines: true, dataLabels: true,
            catAxisTitle: '方案', valAxisTitle: '百分比', gapWidthPct: 60,
          },
        },
      },
    }])
    expect(chartPage.ok).toBe(true)
    version = chartPage.version as typeof version
    const presetPage = (chartPage.presetPages as Array<Record<string, unknown>>)[0]!
    expect(presetPage.roles).toEqual(['background', 'title', 'summary', 'chart', 'takeaway', 'evidence-1', 'evidence-2'])
    const elements = presetPage.elements as Record<string, string>
    expect(Object.keys(elements).length).toBeGreaterThanOrEqual(7)
    const chartId = elements.chart!
    expect(chartId).toMatch(/^e_/)
    // 创建与主题为同一命令；下文重开 PPTX 验证实际图表 XML 的主题色。
    expect(presetPage.pendingChartStyles).toEqual([])
    expect(version.modelRevision).toBe(1)

    const heroId = await addSlideAfter(firstId, 'preset-add-hero')
    const heroPage = await apply(bridge, sessionId, version, 'preset-hero', [{
      op: 'slide_add_preset', payload: {
        slideId: heroId, presetId: 'dark-product-hero',
        content: {
          title: '一屏掌握用户画像', summary: '产品实拍，2026 年 9 月',
          items: ['实时聚合行为与画像', '支持按分群下钻'],
          image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
        },
      },
    }])
    expect(heroPage.ok).toBe(true)
    version = heroPage.version as typeof version
    expect((heroPage.presetPages as Array<Record<string, unknown>>)[0]!.pendingChartStyles).toEqual([])

    const processId = await addSlideAfter(heroId, 'preset-add-process')
    const selection = await inspect(bridge, sessionId, version, 'preset-select-process', {
      mode: 'capabilities', operations:['slide_add_preset'], presetRelation:'sequence', presetRole:'process',
      presetContent: {
        title: '实施路径分三步推进', summary: '每个阶段都有明确验收口径，避免返工',
        nodes: ['输入', '判断', '执行'],
        items: ['先冻结输入范围', '再验证判断口径', '最后按执行结果复盘'],
      },
    })
    expect(selection.contentRef).toMatch(/^preset-content:/)
    expect((selection.presets as Array<Record<string,unknown>>).every((preset) => preset.relation === 'sequence')).toBe(true)
    const processPage = await apply(bridge, sessionId, version, 'preset-process', [{
      op: 'slide_add_preset', payload: {
        slideId: processId, presetId: 'light-process-map',
        contentRef: selection.contentRef,
      },
    }])
    expect(processPage.ok).toBe(true)
    version = processPage.version as typeof version

    // 超容量必须在写入前失败，并且不产生半页内容
    const before = await slideIds()
    const occupied = await apply(bridge, sessionId, version, 'preset-occupied-page', [{
      op: 'slide_add_preset', payload: {slideId:processId,presetId:'light-process-map',
        content:{title:'不能覆盖已有内容',nodes:['输入','判断','执行'],items:['a','b','c']}},
    }])
    expect(occupied.ok).toBe(false)
    expect(JSON.stringify(occupied)).toContain('空白页')
    const overCapacity = await apply(bridge, sessionId, version, 'preset-over-capacity', [{
      op: 'slide_add_preset', payload: {
        slideId: processId, presetId: 'dark-chart-insight',
        content: { title: '标题', chart: { kind: 'bar', categories: ['A'], series: [{ name: 'x', values: [1] }, { name: 'y', values: [2] }, { name: 'z', values: [3] }, { name: 'w', values: [4] }] } },
      },
    }])
    expect(overCapacity.ok).toBe(false)
    expect(JSON.stringify(overCapacity)).toContain('超过声明容量')
    expect(await slideIds()).toEqual(before)

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === version.modelRevision)
    const reopened = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    const slides = reopened.opened.deck.slides
    expect(slides.length).toBe(3)
    const types = slides.map((slide) => slide.elements.map((element) => element.type))
    expect(types[0]).toEqual(expect.arrayContaining(['shape', 'text', 'chart']))
    expect(types[1]).toEqual(expect.arrayContaining(['picture', 'text']))
    expect(types[2]).toEqual(expect.arrayContaining(['shape', 'text']))

    const chartPath = [...reopened.opened.archive.entries.keys()].find((path) => (
      /^ppt\/charts\/chart\d+\.xml$/.test(path)
    ))!
    const xml = reopened.opened.archive.readText(chartPath)
    if (xml == null) throw new Error('saved chart part is empty')
    expect(xml).toContain('val="72DFC1"')
    expect(xml).toContain('<c:gapWidth val="60"/>')
  })

  it('supports explicitly requested basic drafts, applies brand charts and inherits the deck theme', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'automatic-content'
    let version = {editorEpoch:'automatic-epoch',modelRevision:0}
    bridge.emit({type:'office_open',sessionId,documentType:'slides',version,file:asArrayBuffer(await fsPromises.readFile(bundledBlankPath))})
    await waitForPost((message)=>message.type==='office_editor_ready')
    const pages = await inspect(bridge,sessionId,version,'auto-slides',{mode:'slides'})
    const firstId = String((pages.slides as Array<Record<string,unknown>>)[0]!.id)
    const created = await apply(bridge,sessionId,version,'auto-finance',[{op:'slide_add_preset',payload:{slideId:firstId,presetId:'auto-content',content:workflowFixture.pages[0]!.content}}])
    expect(created.ok,JSON.stringify(created.error)).toBe(true)
    expect(created.version).toMatchObject({modelRevision:1})
    const preset = (created.presetPages as Array<Record<string,unknown>>)[0]!
    expect(preset.presetId).toBe('auto-content')
    expect(preset.pendingChartStyles).toEqual([])
    expect((created.warnings as string[]).filter(isBlockingLayoutWarning)).toEqual([])
    version = created.version as typeof version
    bridge.emit({type:'office_checkpoint_request',sessionId,version})
    const firstCheckpoint = await waitForPost((message)=>message.type==='office_checkpoint' && (message.version as typeof version)?.modelRevision===1)
    bridge.emit({type:'office_open',sessionId,documentType:'slides',version,file:firstCheckpoint.file})
    await waitForPost((message)=>message.type==='office_editor_ready' && (message.version as typeof version)?.modelRevision===1)
    const added = await apply(bridge,sessionId,version,'auto-add',[{op:'slide_add',payload:{slideId:firstId}}])
    version = added.version as typeof version
    const listed = await inspect(bridge,sessionId,version,'auto-slides-2',{mode:'slides'})
    const secondId = String((listed.slides as Array<Record<string,unknown>>)[1]!.id)
    const following = await apply(bridge,sessionId,version,'auto-following',[{op:'slide_add_preset',payload:{slideId:secondId,content:workflowFixture.pages[1]!.content}}])
    expect(following.ok,JSON.stringify(following.error)).toBe(true)
    version = following.version as typeof version
    bridge.emit({type:'office_checkpoint_request',sessionId,version})
    const checkpoint = await waitForPost((message)=>message.type==='office_checkpoint' && (message.version as typeof version)?.modelRevision===version.modelRevision)
    const reopened = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    const allXml = [...reopened.opened.archive.entries.keys()].filter((name)=>/ppt\/(slides|charts)\/.*\.xml$/.test(name))
      .map((name)=>reopened.opened.archive.readText(name) ?? '')
    for (const fact of workflowFixture.pages[0]!.content.facts!) expect(allXml.join('')).toContain(fact.text)
    const chartPath = [...reopened.opened.archive.entries.keys()].find((name)=>/^ppt\/charts\/chart\d+\.xml$/.test(name))!
    expect(reopened.opened.archive.readText(chartPath)).toContain('D85A00')
    expect(reopened.opened.archive.readText(reopened.opened.deck.slides[1]!.path)).toContain('D85A00')
    const rejected = await inspect(bridge,sessionId,version,'auto-diagnostics',{mode:'capabilities',operations:['slide_add_preset'],
      presetContent:{title:'不能猜关系',nodes:['甲','乙'],items:['说明一','说明二']}})
    expect(rejected.presets).toEqual([])
    expect(JSON.stringify(rejected.presetDiagnostics)).toContain('relation')
  })

  it('continues with styled native charts after a preset mismatch and rolls back invalid styles', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'native-design'
    let version = { editorEpoch: 'native-design-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version, file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')
    const initial = await inspect(bridge, sessionId, version, 'native-initial', { mode: 'slides' })
    const slideId = String((initial.slides as Array<Record<string, unknown>>)[0]!.id)
    const content = { title: '复杂关联不应被模板限制', relation: 'network', nodes: ['甲', '乙'], items: ['说明一', '说明二'] }
    const candidates = await inspect(bridge, sessionId, version, 'native-candidates', { mode: 'capabilities', operations: ['slide_add_preset'], presetContent: content })
    expect(candidates.presets).toEqual([])
    const mismatch = await apply(bridge, sessionId, version, 'native-mismatch', [{ op: 'slide_add_preset', payload: { slideId, content } }])
    expect(mismatch.ok).toBe(false)
    expect(JSON.stringify(mismatch.error)).toContain('slide_compose')
    const empty = await inspect(bridge, sessionId, version, 'native-empty', { mode: 'slides' })
    expect((empty.slides as Array<{ elements: unknown[] }>)[0]!.elements).toEqual([])

    const chart = { kind: 'bar', categories: ['基期', '当前'], series: [{ name: '周期', values: [50, 30] }], valAxisTitle: '分钟' }
    const created = await apply(bridge, sessionId, version, 'native-create', [
      { op: 'slide_add_text', payload: { slideId, x: 48, y: 36, width: 1180, height: 90, text: '交付周期缩短', font: { fontSize: 30 } } },
      { op: 'slide_compose', payload: { slideId, x: 48, y: 150, width: 1184, height: 470, columns: [1, 1], rows: [1], gap: 40, items: [
        { type: 'chart', column: 0, row: 0, ...chart, style: { seriesColors: ['#25856B'], axisLabelColor: '#223344', axisLabelFontSize: 14 } },
        { type: 'chart', column: 1, row: 0, ...chart, style: { seriesColors: ['#D85A00'], gridColor: '#DDDDDD' } },
      ] } },
    ])
    expect(created.ok, JSON.stringify(created.error)).toBe(true)
    expect(created.version).toMatchObject({ modelRevision: 1 })
    expect(created.presetPages).toBeUndefined()
    expect((created.createdElements as Array<{ type: string }>).filter((element) => element.type === 'chart')).toHaveLength(2)
    version = created.version as typeof version
    const invalid = await apply(bridge, sessionId, version, 'native-invalid-style', [{ op: 'slide_add_chart', payload: { slideId, x: 100, y: 160, width: 600, height: 300, ...chart, style: { unsupported: true } } }])
    expect(invalid.ok).toBe(false)
    expect(JSON.stringify(invalid.error)).toContain('不支持的图表样式')
    const after = await inspect(bridge, sessionId, version, 'native-after', { mode: 'slides' })
    expect((after.slides as Array<{ elements: unknown[] }>)[0]!.elements).toHaveLength(3)
    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint' && (message.version as typeof version)?.modelRevision === 1)
    const reopened = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    expect(reopened.opened.deck.slides[0]!.elements.filter((element) => element.type === 'chart')).toHaveLength(2)
    const chartXml = [...reopened.opened.archive.entries.keys()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))
      .map((name) => reopened.opened.archive.readText(name) ?? '').join('\n')
    expect(chartXml).toContain('25856B')
    expect(chartXml).toContain('D85A00')
    expect(chartXml).toContain('50')
    expect(chartXml).toContain('分钟')
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

/**
 * 预设页面的制作期回归：把「几何 + 样式 + 文字换行 + 图表样式」冻结成可 diff 的快照。
 * 浏览器里的 SlideCanvas PNG 仍是最终画面验收，这里负责在没有浏览器时也能拦截回归。
 */
interface PresetRenderSnapshot {
  type: string
  box: [number, number, number, number]
  background?: true
  fill?: string
  stroke?: string
  font?: { size: number; family: string; bold: boolean; color: string }
  lines?: string[]
  contentHeight?: number
  hasImage?: true
  chart?: {
    kind: string
    legendPos: string
    gridlines: boolean
    dataLabels: boolean
    catAxisTitle?: string
    valAxisTitle?: string
    gapWidthPct?: number
    colors: string[]
  }
  children?: PresetRenderSnapshot[]
}

/**
 * 每个变体的人工代表内容与预期对象类型。新增变体必须在这里补一条，
 * 否则快照用例直接失败——这就是"变体清单驱动"，避免漏测。
 */
const PRESET_SAMPLES: Record<string, { content: PresetContent; expects: string[] }> = Object.fromEntries(
  PRESETS.filter((preset) => !preset.elements.some((element) => element.kind === 'layout')).map((preset) => {
    const pages = qualityFixture.decks.flatMap((deck) => deck.pages)
    const match = pages.find((page) => page.presetId === preset.id)
      ?? pages.find((page) => PRESETS.find((item) => item.id === page.presetId)?.family === preset.family)
    if (!match) throw new Error(`缺少 ${preset.id} 的代表内容`)
    const expects = ['shape', 'text']
    if (preset.elements.some((element) => element.kind === 'chart')) expects.push('chart')
    if (preset.elements.some((element) => element.kind === 'image' || element.kind === 'icon')) expects.push('picture')
    return [preset.id, {content: structuredClone(match.content) as unknown as PresetContent, expects}]
  }),
)

function roundTo(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function solidColor(fill: unknown): string | undefined {
  const value = fill as { kind?: string; color?: string } | undefined
  if (!value?.kind || value.kind === 'none') return undefined
  return value.kind === 'solid' ? value.color : value.kind
}

function snapshotNode(node: RenderNode): PresetRenderSnapshot {
  const snapshot: PresetRenderSnapshot = {
    type: node.type,
    box: [roundTo(node.box.x), roundTo(node.box.y), roundTo(node.box.w), roundTo(node.box.h)],
  }
  if (node.background) snapshot.background = true
  if (node.type === 'shape' || node.type === 'text') {
    const fill = solidColor(node.fill)
    if (fill) snapshot.fill = fill
    const stroke = node.stroke as { color?: string; widthPt?: number } | undefined
    if (stroke?.color) snapshot.stroke = `${stroke.color} ${roundTo(stroke.widthPt ?? 0)}pt`
    if (node.text) {
      const lines = node.text.lines.map((line) => line.runs.map((item) => item.text).join(''))
      // 空文本框（预设的背景色块）不进入字体快照，避免噪声。
      if (lines.join('').trim()) {
        const run = node.text.lines.flatMap((line) => line.runs).find((item) => item.text.trim())
        if (run) {
          snapshot.font = {
            size: roundTo(run.fontSizePx), family: run.fontFamily, bold: !!run.bold, color: run.color,
          }
        }
        snapshot.lines = lines
        snapshot.contentHeight = roundTo(node.text.contentHeight)
      }
    }
  }
  if (node.type === 'picture') snapshot.hasImage = true
  if (node.type === 'chart') {
    const info = node.styleInfo
    const colors = new Set<string>()
    for (const bar of node.bars ?? []) colors.add(bar.color)
    for (const wedge of node.wedges ?? []) colors.add(wedge.color)
    snapshot.chart = {
      kind: info?.kind ?? 'unknown',
      legendPos: info?.legendPos ?? 'none',
      gridlines: !!info?.gridlines,
      dataLabels: !!info?.dataLabels,
      ...(info?.catAxisTitle ? { catAxisTitle: info.catAxisTitle } : {}),
      ...(info?.valAxisTitle ? { valAxisTitle: info.valAxisTitle } : {}),
      ...(info?.gapWidthPct != null ? { gapWidthPct: info.gapWidthPct } : {}),
      colors: [...colors],
    }
  }
  if (node.type === 'group') snapshot.children = node.children.map(snapshotNode)
  return snapshot
}

/** 内容纵向占比：排除页面背景和母版装饰，只看真实内容外接框。 */
function contentCoverage(slide: RenderSlide): number {
  const boxes = slide.nodes.filter((node) => !node.decoration && !node.background).map((node) => node.box)
  if (!boxes.length) return 0
  const top = Math.min(...boxes.map((box) => box.y))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  return roundTo((bottom - top) / slide.heightPx, 2)
}

function durableIds(slide: RenderSlide): Set<string> {
  const ids = new Set<string>()
  const visit = (nodes: RenderNode[]): void => {
    for (const node of nodes) {
      if (node.durableId) ids.add(node.durableId)
      if (node.type === 'group') visit(node.children)
    }
  }
  visit(slide.nodes)
  return ids
}

describe('预设页面渲染快照（CI 回归）', () => {
  it('冻结全部预设页的几何、样式、换行与图表主题，且没有阻塞性布局问题', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'preset-snapshot-session'
    let version = { editorEpoch: 'preset-snapshot-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const slideIds = async (): Promise<string[]> => {
      const result = await inspect(bridge, sessionId, version, `snapshot-slides-${version.modelRevision}`, { mode: 'slides' })
      return (result.slides as Array<Record<string, unknown>>).map((slide) => String(slide.id))
    }

    // 变体清单驱动：逐个预索取代表内容，缺一条就失败，不会静默漏测。
    const productBytes = await fsPromises.readFile(pathModule.resolve(pathModule.dirname(here), '../tests/presets/assets/product-workspace.png'))
    // 新布局由 extended-content 的真实浏览器图集验收；此快照保留旧目录回归。
    const samples = PRESETS.filter((preset) => !preset.elements.some((element) => element.kind === 'layout')).map((preset) => {
      const sample = PRESET_SAMPLES[preset.id]
      if (!sample) throw new Error(`缺少 ${preset.id} 的代表内容：新增变体必须补 PRESET_SAMPLES`)
      if (preset.capacity.imageRequired) sample.content.image = {dataUrl: `data:image/png;base64,${Buffer.from(productBytes).toString('base64')}`,width:2880,height:1704,fit:'contain'}
      expect(presetWarnings(preset, sample.content), `${preset.id} 代表内容必须在声明容量内`).toEqual([])
      return { preset, sample }
    })

    let target = (await slideIds())[0]!
    for (const [index, { preset, sample }] of samples.entries()) {
      if (index > 0) {
        const added = await apply(bridge, sessionId, version, `snapshot-add-${index}`, [
          { op: 'slide_add', payload: { slideId: target } },
        ])
        expect(added.ok).toBe(true)
        version = added.version as typeof version
        const ids = await slideIds()
        target = ids[ids.indexOf(target) + 1]!
      }
      const created = await apply(bridge, sessionId, version, `snapshot-page-${index}`, [
        { op: 'slide_add_preset', payload: { slideId: target, presetId: preset.id, content: sample.content } },
      ])
      expect(created.ok, `${preset.id}: ${JSON.stringify(created.error ?? '')}`).toBe(true)
      expect(created.createdElements).toBeTruthy()
      version = created.version as typeof version
      const pending = ((created.presetPages as Array<Record<string, unknown>>)[0]!
        .pendingChartStyles as Array<Record<string, unknown>>)
      for (const style of pending) {
        const styled = await apply(bridge, sessionId, version, `snapshot-style-${index}`, [{
          op: 'slide_set_chart_style',
          payload: { slideId: target, elementId: style.elementId, style: style.style },
        }])
        expect(styled.ok).toBe(true)
        version = styled.version as typeof version
      }
    }

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === version.modelRevision)
    const document = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    const slides = document.slides
    expect(slides).toHaveLength(samples.length)

    // 硬门控：任何越界、溢出或文字重叠都必须先修好，再谈快照。
    for (const [index, slide] of slides.entries()) {
      const warnings = slideLayoutWarnings(slide, durableIds(slide))
      expect(warnings.filter(isBlockingLayoutWarning), `page ${samples[index]!.preset.id}`).toEqual([])
    }

    // 每个变体都要真的产出自己声明的对象类型。
    const pageTypes = document.opened.deck.slides.map((slide) => slide.elements.map((element) => element.type))
    for (const [index, { preset, sample }] of samples.entries()) {
      expect(pageTypes[index], preset.id).toEqual(expect.arrayContaining(sample.expects))
    }

    const themedCharts = [...document.opened.archive.entries.keys()]
      .filter((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path))
      .map((path) => document.opened.archive.readText(path) ?? '')
    // 两个主题的图表各自拿到自己的系列色，而不是共用一套默认调色板
    expect(themedCharts).toHaveLength(2)
    expect(themedCharts.some((xml) => xml.includes('val="72DFC1"'))).toBe(true)
    expect(themedCharts.some((xml) => xml.includes('val="3458B4"'))).toBe(true)

    expect({
      pages: slides.map((slide) => slide.nodes.map(snapshotNode)),
      coverage: slides.map(contentCoverage),
    }).toMatchSnapshot()
  })

  it('每个预设在声明容量上限上都不溢出', async () => {
    vi.resetModules()
    harness.posts = []
    harness.cleanups = []
    harness.bridge = undefined
    ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}), fonts: { load: async () => [] } }
    ;(globalThis as { window?: unknown }).window = { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1 }
    await import('./slides-entry')
    const bridge = harness.bridge!
    const sessionId = 'preset-capacity-session'
    let version = { editorEpoch: 'preset-capacity-epoch', modelRevision: 0 }
    bridge.emit({ type: 'office_open', sessionId, documentType: 'slides', version,
      file: asArrayBuffer(await fsPromises.readFile(bundledBlankPath)) })
    await waitForPost((message) => message.type === 'office_editor_ready')

    const slideIds = async (): Promise<string[]> => {
      const result = await inspect(bridge, sessionId, version, `capacity-slides-${version.modelRevision}`, { mode: 'slides', limit: 100 })
      return (result.slides as Array<Record<string, unknown>>).map((slide) => String(slide.id))
    }

    let target = (await slideIds())[0]!
    for (const [index, preset] of PRESETS.entries()) {
      if (index > 0) {
        const added = await apply(bridge, sessionId, version, `capacity-add-${index}`, [
          { op: 'slide_add', payload: { slideId: target } },
        ])
        expect(added.ok).toBe(true)
        version = added.version as typeof version
        const ids = await slideIds()
        target = ids[ids.indexOf(target) + 1]!
      }
      const created = await apply(bridge, sessionId, version, `capacity-${preset.id}`, [{
        op: 'slide_add_preset',
        payload: { slideId: target, presetId: preset.id, content: presetBoundaryContent(preset) },
      }])
      expect(created.ok, `${preset.id}: ${JSON.stringify(created.error ?? '')}`).toBe(true)
      version = created.version as typeof version
      const pending = ((created.presetPages as Array<Record<string, unknown>>)[0]!
        .pendingChartStyles as Array<Record<string, unknown>>)
      for (const style of pending) {
        const styled = await apply(bridge, sessionId, version, `capacity-style-${preset.id}`, [{
          op: 'slide_set_chart_style',
          payload: { slideId: target, elementId: style.elementId, style: style.style },
        }])
        expect(styled.ok).toBe(true)
        version = styled.version as typeof version
      }
    }

    bridge.emit({ type: 'office_checkpoint_request', sessionId, version })
    const checkpoint = await waitForPost((message) => message.type === 'office_checkpoint'
      && (message.version as typeof version)?.modelRevision === version.modelRevision)
    const document = await openSlidesDocument(checkpoint.file as ArrayBuffer)
    expect(document.slides).toHaveLength(PRESETS.length)
    // 一次列出所有越界页面，避免逐页迭代
    const violations = document.slides.flatMap((slide, index) => (
      slideLayoutWarnings(slide, durableIds(slide))
        .filter(isBlockingLayoutWarning)
        .map((warning) => `${PRESETS[index]!.id}: ${warning}`)
    ))
    expect(violations).toEqual([])
  }, 20000)
})
