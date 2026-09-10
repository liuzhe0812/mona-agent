import type {
  ChartRenderNode,
  RenderFill,
  RenderNode,
  RenderSlide,
  RenderStroke,
  RenderTextLayout,
  ShapeRenderNode,
  TableRenderNode,
} from '@genoffice/pptx-render'
import { displayFontFamily, normalizeColor } from '../vendor/genoffice/apps/slides/src/renderer/konva-adapter'

export interface SlideImage {
  readonly image: HTMLImageElement
  readonly dataUrl: string
}

export type SlideImageMap = ReadonlyMap<string, SlideImage>

function fillStyle(
  context: CanvasRenderingContext2D,
  fill: RenderFill,
  x: number,
  y: number,
  width: number,
  height: number,
  images: SlideImageMap,
): CanvasPattern | CanvasGradient | string {
  if (fill.kind === 'solid') return normalizeColor(fill.color)
  if (fill.kind === 'gradient') {
    const angle = (fill.angleDeg * Math.PI) / 180
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const length = Math.abs(dx) * width + Math.abs(dy) * height
    const centerX = x + width / 2
    const centerY = y + height / 2
    const gradient = context.createLinearGradient(
      centerX - (dx * length) / 2,
      centerY - (dy * length) / 2,
      centerX + (dx * length) / 2,
      centerY + (dy * length) / 2,
    )
    for (const stop of fill.stops) gradient.addColorStop(stop.pos, normalizeColor(stop.color))
    return gradient
  }
  if (fill.kind === 'image' && fill.dataUrl) {
    const loaded = images.get(fill.dataUrl)
    if (loaded) return context.createPattern(loaded.image, fill.mode === 'tile' ? 'repeat' : 'no-repeat') ?? '#ffffff'
  }
  if (fill.kind === 'pattern') {
    const patternCanvas = document.createElement('canvas')
    const size = Math.max(2, Math.round(fill.cellPx))
    patternCanvas.width = size
    patternCanvas.height = size
    const patternContext = patternCanvas.getContext('2d')
    if (patternContext) {
      patternContext.fillStyle = normalizeColor(fill.bg)
      patternContext.fillRect(0, 0, size, size)
      patternContext.strokeStyle = normalizeColor(fill.fg)
      patternContext.lineWidth = Math.max(1, size / 8)
      patternContext.beginPath()
      patternContext.moveTo(0, size / 2)
      patternContext.lineTo(size / 2, 0)
      patternContext.moveTo(size / 2, size)
      patternContext.lineTo(size, size / 2)
      patternContext.stroke()
      return context.createPattern(patternCanvas, 'repeat') ?? '#ffffff'
    }
  }
  return 'transparent'
}

function strokeStyle(stroke: RenderStroke | undefined): string {
  return stroke ? normalizeColor(stroke.color) : 'transparent'
}

function applyStroke(context: CanvasRenderingContext2D, stroke: RenderStroke | undefined): void {
  if (!stroke) return
  context.strokeStyle = strokeStyle(stroke)
  context.lineWidth = stroke.widthPx
  context.lineCap = stroke.cap ?? 'butt'
  context.lineJoin = stroke.join ?? 'miter'
  context.setLineDash(stroke.dash ?? [])
}

function pathForShape(node: ShapeRenderNode): Path2D | null {
  if (node.pathData || node.fillPathData || node.strokePathData) {
    return new Path2D(node.pathData ?? node.fillPathData ?? node.strokePathData)
  }
  if (node.polygonPoints) {
    const path = new Path2D()
    const points = node.polygonPoints
    if (points.length >= 2) {
      path.moveTo(points[0]!, points[1]!)
      for (let i = 2; i < points.length; i += 2) path.lineTo(points[i]!, points[i + 1]!)
      path.closePath()
    }
    return path
  }
  return null
}

function paintShape(
  context: CanvasRenderingContext2D,
  node: ShapeRenderNode,
  images: SlideImageMap,
): void {
  const { box } = node
  const path = pathForShape(node)
  if (node.line) {
    const points = node.line.points
    if (points.length < 4) return
    applyStroke(context, node.stroke)
    context.beginPath()
    context.moveTo(points[0]!, points[1]!)
    for (let i = 2; i < points.length; i += 2) context.lineTo(points[i]!, points[i + 1]!)
    context.stroke()
    return
  }
  if (path) {
    context.fillStyle = fillStyle(context, node.fill, 0, 0, box.w, box.h, images)
    if (node.fill.kind !== 'none') context.fill(path)
    applyStroke(context, node.stroke)
    if (node.stroke) context.stroke(path)
    return
  }
  const isEllipse = node.presetGeometry === 'ellipse' || node.presetGeometry === 'circle'
  context.beginPath()
  if (isEllipse) {
    context.ellipse(box.w / 2, box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2)
  } else if (node.cornerRadiusPx && 'roundRect' in context) {
    context.roundRect(0, 0, box.w, box.h, node.cornerRadiusPx)
  } else {
    context.rect(0, 0, box.w, box.h)
  }
  context.fillStyle = fillStyle(context, node.fill, 0, 0, box.w, box.h, images)
  if (node.fill.kind !== 'none') context.fill()
  applyStroke(context, node.stroke)
  if (node.stroke) context.stroke()
}

function drawText(
  context: CanvasRenderingContext2D,
  layout: RenderTextLayout | undefined,
  x: number,
  y: number,
): void {
  if (!layout) return
  for (const line of layout.lines) {
    for (const run of line.runs) {
      const fontFamily = displayFontFamily(run.fontFamily)
      const style = [run.italic ? 'italic' : '', run.bold ? 'bold' : ''].filter(Boolean).join(' ')
      context.font = `${style ? `${style} ` : ''}${run.fontSizePx}px ${fontFamily}`
      context.textBaseline = 'alphabetic'
      context.textAlign = run.rtl ? 'right' : 'left'
      const runX = x + layout.insets.l + run.x
      const runY = y + layout.insets.t + run.baselineY
      if (run.highlight) {
        context.fillStyle = normalizeColor(run.highlight)
        context.fillRect(runX, y + layout.insets.t + line.top, run.widthPx, line.height)
      }
      if (run.outline) {
        context.strokeStyle = normalizeColor(run.outline.color)
        context.lineWidth = Math.max(0.5, run.outline.widthPx)
        context.strokeText(run.text, runX, runY)
      }
      context.fillStyle = run.gradient
        ? (() => {
            const gradient = context.createLinearGradient(runX, runY - run.fontSizePx, runX + run.widthPx, runY)
            for (const stop of run.gradient.stops) gradient.addColorStop(stop.pos, normalizeColor(stop.color))
            return gradient
          })()
        : normalizeColor(run.color)
      context.fillText(run.text, runX, runY)
      if (run.underline || run.strike) {
        context.strokeStyle = normalizeColor(run.color)
        context.lineWidth = Math.max(1, run.fontSizePx / 14)
        context.beginPath()
        if (run.underline) {
          const underlineY = runY + Math.max(1, run.fontSizePx * 0.08)
          context.moveTo(runX, underlineY)
          context.lineTo(runX + run.widthPx, underlineY)
        }
        if (run.strike) {
          const strikeY = runY - run.fontSizePx * 0.3
          context.moveTo(runX, strikeY)
          context.lineTo(runX + run.widthPx, strikeY)
        }
        context.stroke()
      }
    }
  }
  context.textAlign = 'left'
}

function drawPicture(
  context: CanvasRenderingContext2D,
  node: RenderNode & { type: 'picture' },
  images: SlideImageMap,
): void {
  const image = node.dataUrl ? images.get(node.dataUrl)?.image : undefined
  if (!image) {
    context.fillStyle = '#f1f3f5'
    context.fillRect(0, 0, node.box.w, node.box.h)
    context.strokeStyle = '#adb5bd'
    context.strokeRect(0, 0, node.box.w, node.box.h)
    return
  }
  const crop = node.srcRect
  const sx = image.naturalWidth * (crop?.l ?? 0)
  const sy = image.naturalHeight * (crop?.t ?? 0)
  const sw = image.naturalWidth * (1 - (crop?.l ?? 0) - (crop?.r ?? 0))
  const sh = image.naturalHeight * (1 - (crop?.t ?? 0) - (crop?.b ?? 0))
  context.globalAlpha = node.opacity ?? 1
  context.drawImage(image, sx, sy, sw, sh, 0, 0, node.box.w, node.box.h)
  context.globalAlpha = 1
  applyStroke(context, node.stroke)
  if (node.stroke) context.strokeRect(0, 0, node.box.w, node.box.h)
}

function drawTable(context: CanvasRenderingContext2D, node: TableRenderNode, images: SlideImageMap): void {
  for (const cell of node.cells) {
    context.fillStyle = fillStyle(context, cell.fill, cell.x, cell.y, cell.w, cell.h, images)
    if (cell.fill.kind !== 'none') context.fillRect(cell.x, cell.y, cell.w, cell.h)
    const borders = cell.borders
    for (const [edge, stroke] of Object.entries(borders ?? {})) {
      applyStroke(context, stroke)
      context.beginPath()
      if (edge === 'l') {
        context.moveTo(cell.x, cell.y)
        context.lineTo(cell.x, cell.y + cell.h)
      } else if (edge === 'r') {
        context.moveTo(cell.x + cell.w, cell.y)
        context.lineTo(cell.x + cell.w, cell.y + cell.h)
      } else if (edge === 't') {
        context.moveTo(cell.x, cell.y)
        context.lineTo(cell.x + cell.w, cell.y)
      } else {
        context.moveTo(cell.x, cell.y + cell.h)
        context.lineTo(cell.x + cell.w, cell.y + cell.h)
      }
      context.stroke()
    }
    drawText(context, cell.text, cell.x, cell.y)
  }
}

function drawChart(context: CanvasRenderingContext2D, node: ChartRenderNode): void {
  if (node.bgFill && node.bgFill.kind === 'solid') {
    context.fillStyle = normalizeColor(node.bgFill.color)
    context.fillRect(0, 0, node.box.w, node.box.h)
  }
  for (const line of [...node.gridLines, ...node.axisLines]) {
    context.strokeStyle = normalizeColor(line.color)
    context.lineWidth = line.widthPx ?? 1
    context.setLineDash('dash' in line ? line.dash ?? [] : [])
    context.beginPath()
    context.moveTo(line.x1, line.y1)
    context.lineTo(line.x2, line.y2)
    context.stroke()
  }
  context.setLineDash([])
  for (const bar of node.bars) {
    context.fillStyle = normalizeColor(bar.color)
    context.fillRect(bar.x, bar.y, bar.w, bar.h)
  }
  for (const polyline of node.polylines) {
    if (polyline.points.length < 4) continue
    context.strokeStyle = normalizeColor(polyline.color)
    context.lineWidth = polyline.widthPx
    context.beginPath()
    context.moveTo(polyline.points[0]!, polyline.points[1]!)
    for (let i = 2; i < polyline.points.length; i += 2) context.lineTo(polyline.points[i]!, polyline.points[i + 1]!)
    if (polyline.closed) context.closePath()
    if (polyline.fill) {
      context.fillStyle = normalizeColor(polyline.fill)
      context.fill()
    }
    context.stroke()
  }
  for (const marker of node.markers) {
    context.fillStyle = normalizeColor(marker.color)
    context.beginPath()
    context.arc(marker.x, marker.y, marker.r, 0, Math.PI * 2)
    context.fill()
  }
  for (const label of node.labels) {
    context.save()
    context.translate(label.x, label.y)
    if (label.rotationDeg) context.rotate((label.rotationDeg * Math.PI) / 180)
    context.font = `${label.italic ? 'italic ' : ''}${label.bold ? 'bold ' : ''}${label.fontSizePx}px system-ui`
    context.fillStyle = normalizeColor(label.color)
    context.textBaseline = 'top'
    context.fillText(label.text, 0, 0)
    context.restore()
  }
}

function drawNode(
  context: CanvasRenderingContext2D,
  node: RenderNode,
  images: SlideImageMap,
): void {
  const { box } = node
  context.save()
  context.translate(box.x + box.w / 2, box.y + box.h / 2)
  context.rotate((box.rotationDeg * Math.PI) / 180)
  context.scale(box.flipH ? -1 : 1, box.flipV ? -1 : 1)
  context.translate(-box.w / 2, -box.h / 2)
  if (node.type === 'group') {
    node.children.forEach((child) => drawNode(context, child, images))
  } else if (node.type === 'shape' || node.type === 'text') {
    paintShape(context, node, images)
    drawText(context, node.text, 0, 0)
  } else if (node.type === 'picture') {
    drawPicture(context, node, images)
  } else if (node.type === 'table') {
    drawTable(context, node, images)
  } else if (node.type === 'chart') {
    drawChart(context, node)
  } else {
    if (node.type !== 'placeholder-chip') return
    context.setLineDash([4, 3])
    context.strokeStyle = '#868e96'
    context.strokeRect(0, 0, box.w, box.h)
    context.setLineDash([])
    context.fillStyle = '#495057'
    context.font = '14px system-ui'
    context.fillText(node.label, 8, 22)
  }
  context.restore()
}

function drawFill(
  context: CanvasRenderingContext2D,
  fill: RenderFill,
  width: number,
  height: number,
  images: SlideImageMap,
): void {
  if (fill.kind === 'none') return
  context.fillStyle = fillStyle(context, fill, 0, 0, width, height, images)
  context.fillRect(0, 0, width, height)
}

export function drawRenderSlide(
  canvas: HTMLCanvasElement,
  slide: RenderSlide,
  images: SlideImageMap,
): void {
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  canvas.width = Math.max(1, Math.round(slide.widthPx * ratio))
  canvas.height = Math.max(1, Math.round(slide.heightPx * ratio))
  canvas.style.aspectRatio = `${slide.widthPx} / ${slide.heightPx}`
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, slide.widthPx, slide.heightPx)
  drawFill(context, slide.background, slide.widthPx, slide.heightPx, images)
  slide.nodes.forEach((node) => drawNode(context, node, images))
}

export async function loadSlideImages(
  slides: readonly RenderSlide[],
): Promise<Map<string, SlideImage>> {
  const urls = new Set<string>()
  const fonts = new Set<string>()
  const visit = (node: RenderNode): void => {
    if (node.type === 'picture' && node.dataUrl) urls.add(node.dataUrl)
    if (node.type === 'shape' || node.type === 'text') {
      const fill = node.fill
      if (fill.kind === 'image' && fill.dataUrl) urls.add(fill.dataUrl)
      for (const line of node.text?.lines ?? []) {
        for (const run of line.runs) fonts.add(displayFontFamily(run.fontFamily))
      }
    }
    if (node.type === 'group') node.children.forEach(visit)
  }
  slides.forEach((slide) => {
    const fill = slide.background
    if (fill.kind === 'image' && fill.dataUrl) urls.add(fill.dataUrl)
    slide.nodes.forEach(visit)
  })
  if (document.fonts?.load) {
    await Promise.all([...fonts].map((family) => document.fonts.load(`16px ${family}`).catch(() => [])))
  }
  const loaded = new Map<string, SlideImage>()
  await Promise.all([...urls].map(async (dataUrl) => {
    const image = new Image()
    image.src = dataUrl
    await new Promise<void>((resolve) => {
      image.onload = () => resolve()
      image.onerror = () => resolve()
    })
    if (image.naturalWidth > 0) loaded.set(dataUrl, { image, dataUrl })
  }))
  return loaded
}
