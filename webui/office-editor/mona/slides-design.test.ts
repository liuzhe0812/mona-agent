import { describe, expect, it } from 'vitest'
const builtin = (process as unknown as { getBuiltinModule: (name: string) => unknown }).getBuiltinModule
const { readFile } = builtin('node:fs/promises') as typeof import('node:fs/promises')
import { openSlidesDocument } from './slides-engine'
import { expandSlideDesign, DESIGN_CATALOG } from './slides-design'
import { nativeParagraphs, nativeBodyPr, fitNativeText, measureNativeText } from './slides-typography'
import { customPathXml } from '../vendor/genoffice/packages/pptx-engine/src/custom-path'
import { makeViewport } from '@genoffice/pptx-render'
import fixture from '../tests/design/components.json'

async function blank() {
  const bytes = await readFile(new URL('../../../src-tauri/resources/office-editor/templates/blank.pptx', import.meta.url))
  return openSlidesDocument(Uint8Array.from(bytes).buffer)
}

describe('native design components', () => {
  it('covers every advertised design with real content and preserves canonical inputs', async () => {
    const doc = await blank()
    const pages = fixture.decks[0]!.pages
    expect(pages.map((p) => p.name)).toEqual(DESIGN_CATALOG.map((d) => d.id).sort((a,b) => pages.findIndex((p)=>p.name===a)-pages.findIndex((p)=>p.name===b)))
    for (const page of pages) {
      const payload = structuredClone(page.operations[0]!.payload) as Record<string, unknown>
      const content = payload.content as Record<string, unknown>
      if (page.name === 'image') content.image = { dataUrl: 'data:image/png;base64,AAAA', width: 1280, height: 720 }
      const before = JSON.stringify(payload)
      const operations = expandSlideDesign(payload, doc)
      expect(operations.length, page.name).toBeGreaterThan(4)
      expect(operations.length).toBeLessThanOrEqual(220)
      expect(JSON.stringify(payload)).toBe(before)
      expect(operations.some((op) => op.op === 'slide_add_svg')).toBe(false)
    }
  })

  it('keeps five and eight parallel items, and rejects unknown fields without discarding them', async () => {
    const doc = await blank()
    for (const count of [5,8]) {
      const items = Array.from({ length: count }, (_,i)=>({ label:`能力${i+1}`, detail:`保留第${i+1}条解释` }))
      const ops = expandSlideDesign({ slideId:'s_1', design:'items', content:{title:'同一个目标，多种能力',items} },doc)
      for (const item of items) expect(JSON.stringify(ops)).toContain(item.detail)
    }
    expect(()=>expandSlideDesign({slideId:'s_1',design:'metric',content:{title:'指标',metric:{label:'投入',value:0},unsupported:'不能丢'}},doc)).toThrow('不支持字段')
  })

  it('uses readable native component typography in regions instead of shrinking a full page', async () => {
    const doc = await blank()
    const operations = expandSlideDesign({ slideId:'s_1', design:'metric', region:{x:60,y:180,width:450,height:380}, content:{title:'投入',metric:{label:'研发人员',value:119,unit:'人',detail:'用于验证局部构图。'}} },doc)
    const labels = operations.filter((op)=>op.op==='slide_add_text').flatMap((op)=>(op.payload.paragraphs as Array<{runs:Array<{text:string;fontSize:number}>}>).flatMap((p)=>p.runs))
    expect(labels.find((r)=>r.text==='研发人员')!.fontSize).toBeGreaterThanOrEqual(10)
    for (const op of operations) {
      expect(Number(op.payload.x)).toBeGreaterThanOrEqual(60)
      expect(Number(op.payload.y)).toBeGreaterThanOrEqual(180)
      expect(Number(op.payload.x)+Number(op.payload.width)).toBeLessThanOrEqual(510.1)
      expect(Number(op.payload.y)+Number(op.payload.height)).toBeLessThanOrEqual(560.1)
    }
    const waterfall = expandSlideDesign({ slideId:'s_1', design:'waterfall', region:{x:524,y:176,width:712,height:388}, content:{title:'自主组合',start:{label:'之前',value:50},steps:[{label:'调整',value:-20}],unit:'分钟'} },doc)
    for (const op of waterfall) {
      expect(Number(op.payload.x)).toBeGreaterThanOrEqual(524)
      expect(Number(op.payload.y)).toBeGreaterThanOrEqual(176)
      expect(Number(op.payload.x)+Number(op.payload.width)).toBeLessThanOrEqual(1236.1)
      expect(Number(op.payload.y)+Number(op.payload.height)).toBeLessThanOrEqual(564.1)
    }
    const tiny=expandSlideDesign({slideId:'s_1',design:'waterfall',content:{title:'保留小数',steps:[{label:'变化',value:0.0000001}]}},doc)
    expect(JSON.stringify(tiny)).toContain('0.0000001')
  })

  it('handles negative and zero waterfall values, including a crossing-zero cumulative result', async () => {
    const doc=await blank()
    for (const values of [[0,0],[-8,3],[4,-12,0,2]]) {
      const ops=expandSlideDesign({slideId:'s_1',design:'waterfall',content:{title:'变化验证',steps:values.map((value,i)=>({label:`变化${i}`,value})),start:{label:'起点',value:2},unit:'万元'}},doc)
      expect(JSON.stringify(ops)).not.toMatch(/NaN|Infinity/)
      for(const op of ops) for(const k of ['x','y','width','height']) expect(Number.isFinite(op.payload[k])).toBe(true)
    }
  })

  it('computes native Sankey paths and rejects missing nodes, negative flow and malformed paths', async () => {
    const doc=await blank()
    const content={title:'流向',sources:[{id:'a',label:'来源'}],targets:[{id:'b',label:'目标'}],links:[{source:'a',target:'b',value:3}]}
    const ops=expandSlideDesign({slideId:'s_1',design:'sankey',content},doc)
    const path=ops.find((op)=>op.op==='slide_add_path')!
    expect(customPathXml(path.payload.path)).toContain('a:cubicBezTo')
    expect(()=>expandSlideDesign({slideId:'s_1',design:'sankey',content:{...content,links:[{source:'missing',target:'b',value:1}]}},doc)).toThrow('实际节点')
    expect(()=>expandSlideDesign({slideId:'s_1',design:'sankey',content:{...content,links:[{source:'a',target:'b',value:-1}]}},doc)).toThrow('非负')
    expect(()=>customPathXml([['M',0,0],['L',Infinity,1]])).toThrow('有限')
    expect(()=>customPathXml([['M',0,0],['L',2,1]])).toThrow('0–1')
    expect(()=>customPathXml('<svg onload="bad"/>')).toThrow()
    expect(()=>customPathXml([['M',0,0],['Z'],['L',1,1]])).toThrow('必须以 M')
  })
})

describe('native typography',()=>{
  const vp=makeViewport({cx:12192000,cy:6858000},1280)
  it('preserves mixed runs, baseline, spacing and explicit zero insets',()=>{
    const paragraphs=nativeParagraphs({paragraphs:[{runs:[{text:'970',fontSize:100,color:'#172621',letterSpacing:-1},{text:' 万元',fontSize:20,baseline:0}],lineHeight:110,spaceAfter:6}]})!
    expect(paragraphs[0]!.runs[1]!.fontSize).toBe(20)
    expect(nativeBodyPr({insets:{l:0,t:0,r:0,b:0},anchor:'middle'},vp)).toEqual({insetsEmu:{l:0,t:0,r:0,b:0},anchor:'ctr'})
    const fitted=fitNativeText(paragraphs,500,180,vp)
    expect(fitted.flatMap((p)=>p.runs).map((r)=>r.text).join('')).toBe('970 万元')
    expect(measureNativeText(fitted,500,180,vp).contentHeight).toBeLessThan(180)
  })
  it('does not truncate overflow or accept hidden unknown formatting',()=>{
    expect(()=>nativeParagraphs({text:'甲',paragraphs:[{runs:[{text:'乙'}]}]})).toThrow('二选一')
    expect(()=>nativeParagraphs({text:'甲',font:{madeUp:1}})).toThrow('不支持')
    expect(()=>fitNativeText([{runs:[{text:'很长的中文'.repeat(100),fontSize:24}]}],80,40,vp)).toThrow('没有截断')
  })
})
