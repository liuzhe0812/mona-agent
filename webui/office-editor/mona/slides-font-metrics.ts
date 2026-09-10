import { HeuristicMetrics, type FontMetricsProvider, type RunStyle } from '@genoffice/pptx-render'

let browserMetrics: FontMetricsProvider | undefined

export function slideFontMetrics(): FontMetricsProvider {
  if (browserMetrics) return browserMetrics
  if (typeof document === 'undefined' || typeof CanvasRenderingContext2D === 'undefined') return new HeuristicMetrics()
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return new HeuristicMetrics()
  const fallback = new HeuristicMetrics()
  const cache = new Map<string, number>()
  browserMetrics = {
    metrics: (style) => fallback.metrics(style),
    measure(text: string, style: RunStyle): number {
      const family = style.fontFamily.replace(/["\\]/g, '\\$&')
      const font = `${style.italic ? 'italic' : 'normal'} ${style.bold ? 'bold' : 'normal'} ${style.fontSizePx}px "${family}"`
      const key = `${font}|${style.kerning}|${text}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      context.font = font
      context.fontKerning = style.kerning === false ? 'none' : 'normal'
      const width = context.measureText(text).width
      if (cache.size >= 4096) cache.clear()
      cache.set(key, width)
      return width
    },
  }
  return browserMetrics
}
