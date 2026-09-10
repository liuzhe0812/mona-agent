import { describe, expect, it } from 'vitest'

import {
  openSlidesDocument,
  refreshSlidesDocument,
  saveSlidesDocument,
  snapshotSlidesDocument,
  slideMediaCount,
  slideText,
} from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'
import JSZip from 'jszip'
import { vi } from 'vitest'

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
const here = urlModule.fileURLToPath(import.meta.url) as string
const fixturePath = pathModule.resolve(
  pathModule.dirname(here) as string,
  '../vendor/genoffice/packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
) as string

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

describe('Slides browser adapter', () => {
  it('freezes exact checkpoint versions while deferring and reusing compression', async () => {
    const doc = await openSlidesDocument(asArrayBuffer(await fsPromises.readFile(fixturePath)))
    const originalText = slideText(doc.slides[0]!)
    const zip = vi.spyOn(JSZip.prototype, 'generateAsync')
    try {
      const snapshot = snapshotSlidesDocument(doc.opened)
      expect(zip).not.toHaveBeenCalled()
      const added = runTxn(doc.opened, { ops: [{ op: 'addElement', target: { slide: 0 }, kind: 'textbox',
        offset: { x: 100000, y: 100000, cx: 2000000, cy: 500000 }, paragraphs: [{ runs: [{ text: '之后的修改' }] }] }] })
      expect(added.applied).toBe(true)
      const pending = snapshot()
      expect(snapshot()).toBe(pending)
      const prior = await openSlidesDocument(await pending)
      expect(slideText(prior.slides[0]!)).toBe(originalText)
      expect(zip).toHaveBeenCalledTimes(1)
      const latest = await openSlidesDocument(await saveSlidesDocument(doc.opened))
      expect(slideText(latest.slides[0]!)).toContain('之后的修改')
    } finally { zip.mockRestore() }
  })

  it('refreshes the changed slide while keeping other pages and media stable', async () => {
    const doc = await openSlidesDocument(asArrayBuffer(await fsPromises.readFile(fixturePath)))
    expect(doc.slides.length).toBeGreaterThan(1)
    const originalOther = doc.slides[1]
    runTxn(doc.opened, { ops: [{ op: 'addElement', target: { slide: 0 }, kind: 'textbox',
      offset: { x: 100000, y: 100000, cx: 2000000, cy: 500000 }, paragraphs: [{ runs: [{ text: '局部更新' }] }] }] })
    const updated = refreshSlidesDocument(doc, 1280, new Set([doc.opened.deck.slides[0]!.path]))
    expect(slideText(updated.slides[0]!)).toContain('局部更新')
    expect(updated.slides[1]).toBe(originalOther)
    expect(updated.media).toEqual(doc.media)
  })
  it('opens the fixed GenOffice deck, builds render slides, and checkpoints PPTX', async () => {
    const bytes = await fsPromises.readFile(fixturePath) as Uint8Array
    const document = await openSlidesDocument(asArrayBuffer(bytes))

    expect(document.slides.length).toBeGreaterThan(0)
    expect(slideText(document.slides[0]!).trim().length).toBeGreaterThan(0)
    expect(slideMediaCount(document.slides[0]!)).toBeGreaterThanOrEqual(0)

    const checkpoint = await saveSlidesDocument(document.opened)
    expect(new Uint8Array(checkpoint).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]))
  })
})
