/** Bounded data-only freeform geometry. Never accepts XML, SVG or executable input. */
export type NativePathCommand = ['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z']

export function customPathXml(value: unknown): string {
  if (!Array.isArray(value) || value.length < 2 || value.length > 256) throw new Error('自定义路径需要 2–256 个 M/L/C/Z 指令。')
  if (!Array.isArray(value[0]) || value[0][0] !== 'M') throw new Error('自定义路径必须以 M 开始。')
  let started = false
  const point = (x: number, y: number) => `<a:pt x="${Math.round(x * 100000)}" y="${Math.round(y * 100000)}"/>`
  const commands = value.map((raw, index) => {
    if (!Array.isArray(raw)) throw new Error(`路径指令 ${index} 必须是数组。`)
    const [kind, ...coordinates] = raw
    const count = kind === 'M' || kind === 'L' ? 2 : kind === 'C' ? 6 : kind === 'Z' ? 0 : -1
    if (count < 0 || coordinates.length !== count || coordinates.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) {
      throw new Error(`路径指令 ${index} 无效：坐标必须是 0–1 的有限数值。`)
    }
    if (kind === 'M') { started = true; return `<a:moveTo>${point(coordinates[0], coordinates[1])}</a:moveTo>` }
    if (!started) throw new Error('闭合路径之后必须以 M 开始新子路径。')
    if (kind === 'L') return `<a:lnTo>${point(coordinates[0], coordinates[1])}</a:lnTo>`
    if (kind === 'C') return `<a:cubicBezTo>${point(coordinates[0], coordinates[1])}${point(coordinates[2], coordinates[3])}${point(coordinates[4], coordinates[5])}</a:cubicBezTo>`
    started = false
    return '<a:close/>'
  }).join('')
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="100000" b="100000"/><a:pathLst><a:path w="100000" h="100000">${commands}</a:path></a:pathLst></a:custGeom>`
}
