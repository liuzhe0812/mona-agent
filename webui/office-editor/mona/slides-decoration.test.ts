import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import { openSlidesDocument, saveSlidesDocument } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'
import type { RenderNode } from '@genoffice/pptx-render'

/**
 * 视觉处理能力探针：确认参考主题里的 mediaTreatment / cardTreatment
 * （图片圆角、面板圆角、图注遮罩、卡片描边）在 Mona 的原生操作里能不能写。
 * 结论同样只分三类：公开操作可写 / 底层可写但入口未暴露 / 引擎缺失。
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
const blankPath = pathModule.resolve(
  pathModule.dirname(urlModule.fileURLToPath(import.meta.url)),
  '../../../src-tauri/resources/office-editor/templates/blank.pptx',
)

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

const PNG_BYTES = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
)

const rect = (x: number, y: number, cx: number, cy: number) => ({ x, y, cx, cy })

type ShapeNode = Extract<RenderNode, { type: 'shape' | 'text' }>

function shapes(nodes: RenderNode[]): ShapeNode[] {
  return nodes.filter((node): node is ShapeNode => node.type === 'shape' || node.type === 'text')
}

async function blankDocument() {
  return openSlidesDocument(asArrayBuffer(await fsPromises.readFile(blankPath)))
}

describe('视觉处理能力探针', () => {
  it('[可写] 圆角形状、图片填充、图片裁切与透明度都能落到渲染树并保存', async () => {
    const document = await blankDocument()
    const created = runTxn(document.opened, {
      ops: [
        { op: 'addElement', target: { slide: 0 }, kind: 'roundRect', offset: rect(914400, 914400, 2743200, 1371600) },
        { op: 'addElement', target: { slide: 0 }, kind: 'roundRect', offset: rect(4572000, 914400, 2743200, 1371600) },
        { op: 'addPicture', target: { slide: 0 }, bytes: PNG_BYTES, ext: 'png', offset: rect(914400, 2743200, 2743200, 1371600) },
      ],
    })
    expect(created.applied, JSON.stringify(created.failures)).toBe(true)
    const [pill, imageSlot, picture] = created.records!.map((record) => record.created![0]!)

    const patched = runTxn(document.opened, {
      ops: [
        // 面板圆角：几何换 preset + avLst 调半径
        { op: 'setShapeAdjust', target: { slide: 0, el: pill }, adjust: { adj: 50000 } },
        // 圆角图片：形状 + 图片填充（stretch 铺满）
        { op: 'setImageFill', target: { slide: 0, el: imageSlot }, source: { bytes: PNG_BYTES, ext: 'png' } },
        // 真实图片：透明度 + 裁切
        { op: 'setPictureOpacity', target: { slide: 0, el: picture }, opacity: 0.5 },
        { op: 'setPictureSrcRect', target: { slide: 0, el: picture }, srcRect: { l: 0, t: 0, r: 0.6, b: 0 } },
      ],
    })
    expect(patched.applied, JSON.stringify(patched.failures)).toBe(true)

    const reopened = await openSlidesDocument(await saveSlidesDocument(document.opened))
    const nodes = reopened.slides[0]!.nodes

    const pillNode = shapes(nodes).find((node) => node.presetGeometry === 'roundRect')
    expect(pillNode?.cornerRadiusPx ?? 0).toBeGreaterThan(0)

    // 图片填充在渲染树里是 shape + fill.kind==='image'，不是 picture 元素
    expect(shapes(nodes).some((node) => node.fill.kind === 'image')).toBe(true)

    const pictureElement = reopened.opened.deck.slides[0]!.elements.find((element) => element.type === 'picture')
    expect(pictureElement?.anchor.originalXml ?? '').toContain('srcRect')
    expect(nodes.some((node) => node.type === 'picture')).toBe(true)
  })

  it('[可写] 形状与图片支持描边、柔化与内外阴影（含 #RRGGBBAA 透明色）', async () => {
    const document = await blankDocument()
    const created = runTxn(document.opened, {
      ops: [
        { op: 'addElement', target: { slide: 0 }, kind: 'roundRect', offset: rect(914400, 914400, 2743200, 1371600) },
        { op: 'addPicture', target: { slide: 0 }, bytes: PNG_BYTES, ext: 'png', offset: rect(4572000, 914400, 2743200, 1371600) },
      ],
    })
    expect(created.applied, JSON.stringify(created.failures)).toBe(true)
    const [shape, picture] = created.records!.map((record) => record.created![0]!)

    const patched = runTxn(document.opened, {
      ops: [
        // 卡片描边
        { op: 'setStroke', target: { slide: 0, el: shape }, stroke: { color: '#27324A', widthEmu: 12700 } },
        // 内阴影：参考主题的 inset 描边效果可以表达
        {
          op: 'setEffects', target: { slide: 0, el: shape },
          effects: { shadow: { color: '#72DFC155', blurRad: 254000, dist: 0, dirDeg: 0, inner: true } },
        },
        // 图片柔化：渲染层对图片生效
        { op: 'setEffects', target: { slide: 0, el: picture }, effects: { softEdge: 127000 } },
      ],
    })
    expect(patched.applied, JSON.stringify(patched.failures)).toBe(true)

    const reopened = await openSlidesDocument(await saveSlidesDocument(document.opened))
    const nodes = reopened.slides[0]!.nodes
    const shapeNode = shapes(nodes).find((node) => node.presetGeometry === 'roundRect')
    expect(shapeNode?.shadow).toMatchObject({ inner: true })
    expect(shapeNode?.stroke?.color).toBeTruthy()
    const pictureNode = nodes.find((node) => node.type === 'picture')
    expect(pictureNode && 'softEdgePx' in pictureNode ? pictureNode.softEdgePx : 0).toBeGreaterThan(0)
  })

  it('[引擎缺失] 图片本身没有几何圆角/裁剪入口，圆角图片必须用形状图片填充', async () => {
    const document = await blankDocument()
    const created = runTxn(document.opened, {
      ops: [{ op: 'addPicture', target: { slide: 0 }, bytes: PNG_BYTES, ext: 'png', offset: rect(914400, 914400, 2743200, 1371600) }],
    })
    const picture = created.records![0]!.created![0]!
    for (const unknown of [
      { op: 'setPictureClip', target: { slide: 0, el: picture }, cornerRadiusPx: 12 },
      { op: 'setPictureRadius', target: { slide: 0, el: picture }, radiusEmu: 114300 },
    ]) {
      const outcome = runTxn(document.opened, { ops: [unknown as never] })
      expect(outcome.applied).toBe(false)
      expect(outcome.failures?.[0]?.error).toContain('unknown op')
    }

    // 图片没有预设几何，"改几何"这条路也不通：圆角图片只能新建形状再填图。
    const viaGeometry = runTxn(document.opened, {
      ops: [{ op: 'setShapeGeometry', target: { slide: 0, el: picture }, prst: 'roundRect' } as never],
    })
    expect(viaGeometry.applied).toBe(false)
    expect(viaGeometry.failures?.[0]?.error).toContain('setShapeGeometry')
  })
})
