import { createElement } from 'react'
import { createRoot } from 'react-dom/client'

import type { DocumentVersion } from './bridge'
import { VisualVersionConflict } from './visual'
import { sameDocumentVersion } from './version'
import { metafileToDataUrl } from '@genoffice/docx-engine/metafile'
import type { RenderFill, RenderNode, RenderSlide } from '@genoffice/pptx-render'

export { VisualVersionConflict }

export interface CapturedSlide {
  dataUrl: string
  width: number
  height: number
}

export interface SlideCaptureOptions {
  elementIds?: readonly string[]
  region?: { x: number; y: number; width: number; height: number }
  padding?: number
}

interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

function collectFillImages(fill: RenderFill | undefined, urls: Set<string>): void {
  if (fill?.kind === 'image' && fill.dataUrl) urls.add(fill.dataUrl)
}

function collectNodeImages(node: RenderNode, urls: Set<string>): void {
  if (node.type === 'picture' && node.dataUrl) urls.add(node.dataUrl)
  if (node.type === 'shape' || node.type === 'text') collectFillImages(node.fill, urls)
  if (node.type === 'chart') {
    collectFillImages(node.bgFill, urls)
    collectFillImages(node.plotRect?.fill, urls)
  }
  if (node.type === 'group') for (const child of node.children) collectNodeImages(child, urls)
  if (node.type === 'table') {
    collectFillImages(node.bgFill, urls)
    for (const cell of node.cells) collectFillImages(cell.fill, urls)
  }
}

function imageUrls(slide: RenderSlide): Set<string> {
  const urls = new Set<string>()
  collectFillImages(slide.background, urls)
  for (const node of slide.nodes) collectNodeImages(node, urls)
  return urls
}

function elementBoxes(slide: RenderSlide): Map<string, PixelRect> {
  const boxes = new Map<string, PixelRect>()
  const visit = (nodes: RenderNode[], offsetX = 0, offsetY = 0): void => {
    for (const node of nodes) {
      if (!node.decoration && node.durableId) {
        boxes.set(node.durableId, {
          x: node.box.x + offsetX,
          y: node.box.y + offsetY,
          width: node.box.w,
          height: node.box.h,
        })
      }
      if (node.type === 'group') visit(node.children, offsetX + node.box.x, offsetY + node.box.y)
    }
  }
  visit(slide.nodes)
  return boxes
}

function captureRegion(slide: RenderSlide, options?: SlideCaptureOptions): PixelRect {
  const elementIds = options?.elementIds?.filter(Boolean) ?? []
  if (elementIds.length > 0 && options?.region) {
    throw new Error('visual 不能同时指定 elementIds 和 region。')
  }
  if (options?.region) {
    const { x, y, width, height } = options.region
    if (![x, y, width, height].every(Number.isFinite)
      || width <= 0 || height <= 0 || x < 0 || y < 0
      || x + width > slide.widthPx || y + height > slide.heightPx) {
      throw new Error('visual region 必须位于幻灯片边界内。')
    }
    return { x, y, width, height }
  }
  if (elementIds.length === 0) {
    return { x: 0, y: 0, width: slide.widthPx, height: slide.heightPx }
  }
  const boxes = elementBoxes(slide)
  const selected = elementIds.map((id) => boxes.get(id))
  if (selected.some((box) => !box)) throw new Error('visual elementIds 中包含找不到的元素。')
  const padding = options?.padding ?? 16
  if (!Number.isFinite(padding) || padding < 0) throw new Error('visual padding 必须是非负数。')
  const left = Math.min(...selected.map((box) => box!.x))
  const top = Math.min(...selected.map((box) => box!.y))
  const right = Math.max(...selected.map((box) => box!.x + box!.width))
  const bottom = Math.max(...selected.map((box) => box!.y + box!.height))
  const x = Math.max(0, left - padding)
  const y = Math.max(0, top - padding)
  const farX = Math.min(slide.widthPx, right + padding)
  const farY = Math.min(slide.heightPx, bottom + padding)
  return { x, y, width: farX - x, height: farY - y }
}

const METAFILE_RE = /^data:(image\/x-(?:emf|wmf)|image\/(?:emf|wmf));base64,/

async function normalizedImageUrl(url: string): Promise<string> {
  const match = METAFILE_RE.exec(url)
  if (!match) return url
  const encoded = url.slice(url.indexOf(',') + 1)
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const converted = await metafileToDataUrl(bytes, match[1]!.includes('emf') ? 'image/x-emf' : 'image/x-wmf')
  if (!converted) throw new Error('幻灯片矢量图片无法转换。')
  return converted
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const source = await normalizedImageUrl(url)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`幻灯片图片加载失败：${url.slice(0, 80)}`))
    image.src = source
  })
}

async function preloadImages(slide: RenderSlide): Promise<Map<string, HTMLImageElement>> {
  const entries = await Promise.all(
    [...imageUrls(slide)].map(async (url) => [url, await loadImage(url)] as const),
  )
  return new Map(entries)
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

function captureCanvases(
  host: HTMLElement,
  slide: RenderSlide,
  bleed: number,
  region: PixelRect,
): CapturedSlide {
  const layers = [...host.querySelectorAll('canvas')]
  if (layers.length === 0) throw new Error('幻灯片画布尚未完成渲染。')
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(4096, Math.max(1, Math.round(region.width)))
  canvas.height = Math.min(8192, Math.max(1, Math.round(region.height)))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建幻灯片截图画布。')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  for (const layer of layers) {
    const cssWidth = layer.clientWidth || slide.widthPx + bleed * 2
    const cssHeight = layer.clientHeight || slide.heightPx + bleed * 2
    const scaleX = layer.width / cssWidth
    const scaleY = layer.height / cssHeight
    context.drawImage(
      layer,
      Math.round((bleed + region.x) * scaleX),
      Math.round((bleed + region.y) * scaleY),
      Math.round(region.width * scaleX),
      Math.round(region.height * scaleY),
      0,
      0,
      canvas.width,
      canvas.height,
    )
  }
  const cropped = canvas.toDataURL('image/png')
  if (cropped.length > 16_000_000) throw new Error('当前幻灯片画面过大，请缩小检查范围。')
  return { dataUrl: cropped, width: canvas.width, height: canvas.height }
}

export async function captureSlide(
  slide: RenderSlide,
  version: DocumentVersion,
  getVersion: () => DocumentVersion | null,
  options?: SlideCaptureOptions,
): Promise<CapturedSlide> {
  const { CANVAS_BLEED, SlideCanvas } = await import('../vendor/genoffice/apps/slides/src/renderer/SlideCanvas')
  const before = getVersion()
  if (!before || !sameDocumentVersion(version, before)) {
    throw new VisualVersionConflict('文档已变化，请重新读取后检查画面。')
  }
  const region = captureRegion(slide, options)
  const images = await preloadImages(slide)
  const host = document.createElement('div')
  const hostWidth = slide.widthPx + CANVAS_BLEED * 2
  const hostHeight = slide.heightPx + CANVAS_BLEED * 2
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'fixed'
  host.style.left = '-100000px'
  host.style.top = '0'
  host.style.width = `${hostWidth}px`
  host.style.height = `${hostHeight}px`
  host.style.pointerEvents = 'none'
  host.style.overflow = 'hidden'
  host.style.background = '#808080'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    const canvas = createElement(SlideCanvas, {
      slide,
      selectedIds: [],
      onSelect: () => undefined,
      onEditText: () => undefined,
      onTransform: () => undefined,
      onEditTableCell: () => undefined,
      onTableColResize: () => undefined,
      onContextMenu: () => undefined,
      onMarqueeSelect: () => undefined,
      onDuplicateTo: () => undefined,
      onEnterGroup: () => undefined,
      onEditConnectorEndpoints: () => undefined,
      onDrawCommit: () => undefined,
      onDrawCancel: () => undefined,
      onAdjust: () => undefined,
      images,
      zoom: 1,
      enteredGroupId: null,
      drawMode: null,
      editingText: null,
    })
    root.render(createElement('div', {
      style: {
        position: 'relative',
        left: CANVAS_BLEED,
        top: CANVAS_BLEED,
        width: hostWidth,
        height: hostHeight,
      },
    }, canvas))
    await nextFrame()
    await nextFrame()
    await document.fonts.ready
    const captured = captureCanvases(host, slide, CANVAS_BLEED, region)
    const after = getVersion()
    if (!after || !sameDocumentVersion(version, after)) {
      throw new VisualVersionConflict('检查画面时文档已变化，请重新检查。')
    }
    return captured
  } finally {
    root.unmount()
    host.remove()
  }
}
