import { describe, expect, it } from 'vitest'
import { elementDurableId, slideDurableId } from '@genoffice/pptx-engine'
import catalog from '../../../mona/skills/mona-pptx/assets/dashi/templates.json'
import selection from './presets/dashi-selection.json'
import { dashiOperation, dashiScenarioCatalog, dashiTemplateCatalog, scaleDashiXml } from './slides-dashi'
import { openSlidesDocument, refreshSlidesDocument, saveSlidesDocument, slideText } from './slides-engine'
import { runTxn } from '../vendor/genoffice/apps/slides/src/main/ops'

const blank = new URL('../../../src-tauri/resources/office-editor/templates/blank.pptx', import.meta.url)
const {readFile} = process.getBuiltinModule!('node:fs/promises') as {readFile: (path: URL) => Promise<Uint8Array>}
const asBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

describe('real Dashi native templates', () => {
  it('links each scene to eight real source IDs and exposes only bound native text', () => {
    expect(dashiScenarioCatalog()).toHaveLength(12)
    for (const scene of selection.scenarios) {
      expect(scene.pages).toHaveLength(8)
      const readyIds = new Set(catalog.pages.map((page) => page.id))
      for (const page of scene.pages) expect(readyIds.has(page.sourceLayoutId)).toBe(true)
    }
    for (const page of catalog.pages) {
      expect(page.id).toMatch(/^theme\d{2}_page\d{3}$/)
      const detail = dashiTemplateCatalog(undefined, page.id)[0]!
      expect('fields' in detail).toBe(true)
      if ('fields' in detail) {
        expect(detail.fields.length).toBeGreaterThan(0)
        expect(detail.fields.every((field) => page.fields.some((original) => original.path === field.name && original.textIndexes.length))).toBe(true)
      }
    }
  })

  it('imports actual source objects at target size, keeps the slide ID, edits text and survives reopen', async () => {
    const page = catalog.pages[0]!
    expect(page).toBeDefined()
    const field = page.fields.find((field) => field.textIndexes.length && field.maxChars >= 4)!
    const doc = await openSlidesDocument(asBuffer(await readFile(blank)))
    const id = slideDurableId(doc.opened.deck.slides[0]!)
    const fixtureImage = Buffer.from(await readFile(new URL('../tests/design/product-workspace.png', import.meta.url))).toString('base64')
    const templateAssets = Object.fromEntries(page.assetIds.map((id) => [id, `data:image/png;base64,${fixtureImage}`]))
    const result = runTxn(doc.opened, {isolation:'atomic',ops:[dashiOperation({slideId:id,templateId:page.id,fields:{[field.path]:'迁移验证'},templateAssets})]})
    expect(result.failures ?? []).toHaveLength(0)
    expect(result.applied).toBe(true)
    const native = doc.opened.deck.slides[0]!
    expect(slideDurableId(native)).toBe(id)
    expect(native.elements.length).toBeGreaterThan(4)
    expect(native.elements.some((element) => element.type === 'shape' || element.type === 'text')).toBe(true)
    const ids = native.elements.map(elementDurableId)
    const refreshed = refreshSlidesDocument(doc)
    expect(slideText(refreshed.slides[0]!)).toContain('迁移验证')
    const mono = native.elements.find((element) => (element.type === 'shape' || element.type === 'text')
      && element.text?.paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text === '07')))
    expect(mono).toBeDefined()
    if (mono?.type === 'shape' || mono?.type === 'text') {
      expect(mono.text!.paragraphs[0]!.runs[0]!.fontSize).toBeCloseTo(40, 1)
      const rendered = refreshed.slides[0]!.nodes.find((node) => node.durableId === elementDurableId(mono))!
      if (rendered.type === 'shape' || rendered.type === 'text') {
        const evidence = page.textLayout.find((record) => record.text === '07')!
        const canvasScale = refreshed.slides[0]!.widthPx / 1920
        const baseline = rendered.box.y + rendered.text!.insets.t + rendered.text!.lines[0]!.runs[0]!.baselineY
        expect('baselinePx' in evidence).toBe(true)
        if ('baselinePx' in evidence && typeof evidence.baselinePx === 'number') expect(baseline).toBeCloseTo(evidence.baselinePx * canvasScale, 1)
      }
    }
    const reopened = await openSlidesDocument(await saveSlidesDocument(refreshed.opened))
    expect(slideDurableId(reopened.opened.deck.slides[0]!)).toBe(id)
    expect(reopened.opened.deck.slides[0]!.elements.map(elementDurableId)).toEqual(ids)
    expect(slideText(reopened.slides[0]!)).toContain('迁移验证')
    const reject = runTxn(doc.opened, {isolation:'atomic',ops:[dashiOperation({slideId:id,templateId:page.id})]})
    expect(reject.applied).toBe(false)
    expect(slideText(refreshSlidesDocument(doc).slides[0]!)).toContain('迁移验证')
  })

  it('rejects arbitrary paths, XML and unknown or overflowing text fields before mutation', () => {
    const page = catalog.pages[0]!
    expect(() => dashiOperation({slideId:'s_1',templateId:'../../anything.pptx'})).toThrow()
    expect(() => dashiOperation({slideId:'s_1',templateId:page.id,xml:'<p:sld/>'})).toThrow()
    expect(() => dashiOperation({slideId:'s_1',templateId:page.id,fields:{invented:'伪字段'}})).toThrow()
    const field = page.fields.find((field) => field.textIndexes.length)!
    expect(() => dashiOperation({slideId:'s_1',templateId:page.id,fields:{[field.path]:'长'.repeat(2000)}})).toThrow()
  })

  it('keeps inline emphasis once as editable rich text when the source exporter duplicates it', async () => {
    const page=catalog.pages.find((page)=>page.id==='theme07_page010')!
    const doc=await openSlidesDocument(asBuffer(await readFile(blank)))
    const fixtureImage=Buffer.from(await readFile(new URL('../tests/design/product-workspace.png',import.meta.url))).toString('base64')
    const assets=Object.fromEntries(page.assetIds.map((id)=>[id,`data:image/png;base64,${fixtureImage}`]))
    const result=runTxn(doc.opened,{isolation:'atomic',ops:[dashiOperation({slideId:slideDurableId(doc.opened.deck.slides[0]!),templateId:page.id,templateAssets:assets})]})
    expect(result.applied).toBe(true)
    const paragraph=doc.opened.deck.slides[0]!.elements.flatMap((element)=>
      element.type==='shape'||element.type==='text' ? element.text?.paragraphs??[] : [])
      .find((paragraph)=>paragraph.runs.map((run)=>run.text).join('').startsWith('放，而是由'))!
    expect(paragraph).toBeDefined()
    expect(paragraph.runs.some((run)=>run.text==='8 月' && run.bold)).toBe(true)
    expect(paragraph.runs.map((run)=>run.text).join('').match(/8 月/g)).toHaveLength(1)
  })

  it('rolls back earlier same-page content instead of replacing it with a template', async () => {
    const doc = await openSlidesDocument(asBuffer(await readFile(blank)))
    const id = slideDurableId(doc.opened.deck.slides[0]!)
    const result = runTxn(doc.opened, {isolation:'atomic',ops:[
      {op:'addElement',target:{slide:id},kind:'text',offset:{x:10000,y:10000,cx:1000000,cy:100000},paragraphs:[{runs:[{text:'必须保留的内容'}]}]},
      dashiOperation({slideId:id,templateId:catalog.pages[0]!.id}),
    ]})
    expect(result.applied).toBe(false)
    expect(result.failures?.some((failure) => failure.error.includes('已增加的内容'))).toBe(true)
    expect(doc.opened.deck.slides[0]!.elements).toHaveLength(0)
  })

  it('scales physical geometry and fonts without altering chart values or normalized paths', () => {
    const xml = '<a:off x="120" y="240"/><a:ext cx="720" cy="360"/><a:rPr sz="3600"/><a:path w="100" h="100"><a:pt x="20" y="40"/></a:path><a:t>2026</a:t><a:srgbClr val="202020"/>'
    expect(scaleDashiXml(xml, 0.5)).toBe('<a:off x="60" y="120"/><a:ext cx="360" cy="180"/><a:rPr sz="1800"/><a:path w="100" h="100"><a:pt x="20" y="40"/></a:path><a:t>2026</a:t><a:srgbClr val="202020"/>')
  })
})
