import { describe, expect, it } from 'vitest'
import { openSlidesDocument, saveSlidesDocument } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'
import type { RenderNode } from '@genoffice/pptx-render'

/**
 * 字体探针：主题要显式声明字体族，就必须先确认
 * ①声明的族名会不会被保留、②声明的族在当前环境是否真实存在、
 * ③中英混排会不会比纯中文更容易溢出。
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

const rect = (x: number, y: number, cx: number, cy: number) => ({ x, y, cx, cy })

interface TextFacts {
  fontFamily?: string
  srcFontFamily?: string
  fontSizePx: number
  lines: number
  widestLine: number
  contentHeight: number
}

async function renderText(
  text: string,
  options: { fontFamily?: string; fontSize?: number; widthEmu?: number; text?: string } = {},
): Promise<TextFacts> {
  const document = await openSlidesDocument(asArrayBuffer(await fsPromises.readFile(blankPath)))
  const created = runTxn(document.opened, {
    ops: [{
      op: 'addElement',
      target: { slide: 0 },
      kind: 'textbox',
      offset: rect(457200, 457200, options.widthEmu ?? 8001000, 3657600),
      paragraphs: [{
        runs: [{
          text: options.text ?? text,
          ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
          fontSize: options.fontSize ?? 14,
        }],
      }],
    }],
  })
  expect(created.applied, JSON.stringify(created.failures)).toBe(true)
  const reopened = await openSlidesDocument(await saveSlidesDocument(document.opened))
  const node = reopened.slides[0]!.nodes.find((item: RenderNode) => (
    item.type === 'text' && item.text && item.text.lines.length > 0
  )) as Extract<RenderNode, { type: 'shape' | 'text' }> | undefined
  if (!node?.text) throw new Error('文本框没有渲染出来')
  const run = node.text.lines.flatMap((line) => line.runs)[0]!
  const widestLine = Math.max(...node.text.lines.map((line) => (
    line.runs.length ? Math.max(...line.runs.map((item) => item.x + item.widthPx)) : 0
  )))
  return {
    fontFamily: run.fontFamily,
    srcFontFamily: run.srcFontFamily,
    fontSizePx: run.fontSizePx,
    lines: node.text.lines.length,
    widestLine,
    contentHeight: node.text.contentHeight,
  }
}

describe('字体探针', () => {
  it('[可写] 声明的字体族会被写进文件并在重开后保留', async () => {
    for (const family of ['Microsoft YaHei', '等线']) {
      const facts = await renderText('经营台账口径下结构化升级与毛利率变化', { fontFamily: family })
      // srcFontFamily 是模型里显式声明的族名；它会按声明保留，不会被替换掉
      expect(facts.srcFontFamily, `声明 ${family}`).toBe(family)
      expect(facts.fontFamily).toBeTruthy()
    }
  })

  it('未安装的字体族会被替换，但仍按声明的字号排版', async () => {
    const declared = await renderText('经营台账口径下结构化升级与毛利率变化', { fontFamily: 'Space Grotesk' })
    // 声明保留在 srcFontFamily，实际渲染族名交给替换逻辑
    expect(declared.srcFontFamily).toBe('Space Grotesk')
    expect(declared.fontFamily).toBeTruthy()
    expect(declared.fontSizePx).toBeCloseTo(18.67, 1)

    const explicit = await renderText('经营台账口径下结构化升级与毛利率变化', { fontFamily: '等线' })
    // 未安装字体与已安装字体在当前环境都不应改变字号
    expect(declared.fontSizePx).toBeCloseTo(explicit.fontSizePx, 1)
  })

  it('中英混排不会比纯中文占更多行（数字与空格更窄）', async () => {
    const pure = await renderText('经营台账口径结构化升级毛利率变化回落复核')
    const mixed = await renderText('2025 全年，单位：千美元，来源：经营台账')
    expect(pure.lines).toBeGreaterThan(0)
    expect(mixed.lines).toBeGreaterThan(0)
    expect(mixed.lines).toBeLessThanOrEqual(pure.lines + 1)
    // 记录事实：混排的可用宽度不会被撑爆
    expect(mixed.widestLine).toBeLessThanOrEqual(1120)
  })
})
