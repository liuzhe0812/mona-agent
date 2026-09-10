import { describe, expect, it } from 'vitest'
import { XMLParser } from 'fast-xml-parser'

import { patchChartTextColors } from '../vendor/genoffice/packages/pptx-engine/src/chart-text'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
})
const preserveParser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
})

const CHART_XML = `<?xml version="1.0" encoding="UTF-8"?>
<c:chartSpace xmlns:c="c" xmlns:a="a" xmlns:r="r" xmlns:foo="urn:foo">
  <c:date1904 val="0"/>
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>
        <a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="333333"/></a:solidFill><a:latin typeface="Aptos Display"/></a:rPr>
        <a:t>Revenue &amp; Growth &lt;Q1&gt;</a:t>
      </a:r></a:p></c:rich></c:tx>
      <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="2200"><a:solidFill><a:srgbClr val="222222"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
    </c:title>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Sales &amp; Services</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q&amp;1</c:v></c:pt><c:pt idx="1"><c:v>Q&lt;2&gt;</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$C$2</c:f><c:numCache><c:formatCode>0.00</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>17.5</c:v></c:pt><c:pt idx="1"><c:v>23.25</c:v></c:pt></c:numCache></c:numRef></c:val>
          <c:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></c:spPr>
          <c:dLbls>
            <c:showVal val="1"/><c:numFmt formatCode="&quot;$&quot;#,##0.00" sourceLinked="0"/>
            <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="999999"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
          </c:dLbls>
        </c:ser>
        <c:dLbls>
          <c:showVal val="1"/><c:showCatName val="0"/><c:numFmt formatCode="&quot;$&quot;#,##0.00" sourceLinked="0"/>
          <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="888888"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
        </c:dLbls>
        <c:axId val="1"/><c:axId val="2"/>
        <c:extLst><c:ext uri="{ABCDEF}"><foo:payload foo:value="keep">extension &amp; payload</foo:payload></c:ext></c:extLst>
      </c:lineChart>
      <c:catAx>
        <c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/>
        <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="666666"/></a:solidFill></a:rPr><a:t>Quarter</a:t></a:r></a:p></c:rich></c:tx></c:title>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200"><a:solidFill><a:srgbClr val="444444"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
      </c:catAx>
      <c:valAx>
        <c:axId val="2"/><c:scaling/><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="0.00" sourceLinked="0"/>
        <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1400"><a:solidFill><a:srgbClr val="666666"/></a:solidFill></a:rPr><a:t>Amount</a:t></a:r></a:p></c:rich></c:tx></c:title>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300"><a:solidFill><a:srgbClr val="555555"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
      </c:valAx>
    </c:plotArea>
    <c:legend>
      <c:legendPos val="r"/>
      <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1500"><a:solidFill><a:srgbClr val="777777"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
    </c:legend>
  </c:chart>
  <c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>
  <c:printSettings><c:headerFooter/><c:pageMargins/></c:printSettings>
  <c:extLst><c:ext uri="{ROOT-EXT}"><foo:payload foo:value="root">root extension</foo:payload></c:ext></c:extLst>
  <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1800"><a:solidFill><a:srgbClr val="111111"/></a:solidFill><a:latin typeface="Aptos"/></a:defRPr></a:pPr></a:p></c:txPr>
</c:chartSpace>`

const PATCH = {
  textColor: '#E2E8F0',
  titleColor: '#FACC15',
  axisLabelColor: '#A5B4FC',
  axisTitleColor: '#67E8F9',
  legendColor: '#86EFAC',
  dataLabelColor: '#FDA4AF',
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value
}

function colorOf(properties: any): string | undefined {
  return first(first(properties?.['a:solidFill'])?.['a:srgbClr'])?.['@_val']
}

function defColor(owner: any): string | undefined {
  const txPr = first(owner?.['c:txPr'])
  const paragraph = first(txPr?.['a:p'])
  const pPr = first(paragraph?.['a:pPr'])
  return colorOf(first(pPr?.['a:defRPr']))
}

function firstRunColor(owner: any): string | undefined {
  const rich = first(first(owner?.['c:tx'])?.['c:rich'])
  const paragraph = first(rich?.['a:p'])
  const run = first(paragraph?.['a:r'])
  return colorOf(first(run?.['a:rPr']))
}

function textOwners(xml: string): {
  root: any
  chart: any
  title: any
  catAxis: any
  valAxis: any
  legend: any
  lineChart: any
  plotLabels: any
  seriesLabels: any
} {
  const root = (parser.parse(xml) as any)['c:chartSpace']
  const chart = root['c:chart']
  const plotArea = chart['c:plotArea']
  const lineChart = plotArea['c:lineChart']
  const series = first(lineChart['c:ser'])
  return {
    root,
    chart,
    title: chart['c:title'],
    catAxis: plotArea['c:catAx'],
    valAxis: plotArea['c:valAx'],
    legend: chart['c:legend'],
    lineChart,
    plotLabels: lineChart['c:dLbls'],
    seriesLabels: series?.['c:dLbls'],
  }
}

function tag(node: Record<string, unknown>): string {
  return Object.keys(node).find((key) => key !== ':@') ?? ''
}

function stripColorFormatting(value: unknown, parentTag?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => stripColorFormatting(item, parentTag))
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(object)) {
    if (key === 'c:txPr') continue
    if (
      parentTag === 'a:rPr' ||
      parentTag === 'a:defRPr' ||
      parentTag === 'a:endParaRPr'
    ) {
      if (key === 'a:solidFill' || key === 'a:noFill' || key === 'a:gradFill' || key === 'a:pattFill')
        continue
    }
    result[key] = stripColorFormatting(child, key)
  }
  return result
}

function nonTextProjection(xml: string): unknown {
  return stripColorFormatting(parser.parse(xml))
}

function styleAttributes(xml: string): string[] {
  const parsed = preserveParser.parse(xml) as unknown
  const result: string[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    const name = tag(node)
    if (name === 'a:rPr' || name === 'a:defRPr' || name === 'a:endParaRPr') {
      const attrs = node[':@']
      if (attrs && typeof attrs === 'object' && Object.keys(attrs).length)
        result.push(JSON.stringify(attrs))
    }
    Object.values(node).forEach(visit)
  }
  visit(parsed)
  return result
}

describe('patchChartTextColors', () => {
  it('recolors native chart text owners while preserving data, formats, extensions, and text styles', () => {
    const patched = patchChartTextColors(CHART_XML, PATCH)
    const owners = textOwners(patched)

    expect(defColor(owners.root)).toBe('E2E8F0')
    expect(defColor(owners.title)).toBe('FACC15')
    expect(firstRunColor(owners.title)).toBe('FACC15')
    expect(defColor(owners.catAxis)).toBe('A5B4FC')
    expect(defColor(owners.valAxis)).toBe('A5B4FC')
    expect(firstRunColor(owners.catAxis['c:title'])).toBe('67E8F9')
    expect(firstRunColor(owners.valAxis['c:title'])).toBe('67E8F9')
    expect(defColor(owners.legend)).toBe('86EFAC')
    expect(defColor(owners.plotLabels)).toBe('FDA4AF')
    expect(defColor(owners.seriesLabels)).toBe('FDA4AF')

    const originalOwners = textOwners(CHART_XML)
    expect(owners.root['c:externalData']).toEqual(originalOwners.root['c:externalData'])
    const series = first(owners.lineChart['c:ser'])
    const originalSeries = first(originalOwners.lineChart['c:ser'])
    expect(series?.['c:tx']).toEqual(originalSeries?.['c:tx'])
    expect(series?.['c:cat']).toEqual(originalSeries?.['c:cat'])
    expect(series?.['c:val']).toEqual(originalSeries?.['c:val'])
    expect(series?.['c:spPr']).toEqual(originalSeries?.['c:spPr'])
    expect(owners.lineChart['c:extLst']).toEqual(originalOwners.lineChart['c:extLst'])
    expect(owners.chart['c:extLst']).toEqual(originalOwners.chart['c:extLst'])
    expect(owners.seriesLabels['c:numFmt']).toEqual(originalOwners.seriesLabels['c:numFmt'])
    expect(owners.valAxis['c:numFmt']).toEqual(originalOwners.valAxis['c:numFmt'])
    expect(nonTextProjection(patched)).toEqual(nonTextProjection(CHART_XML))
    expect(styleAttributes(patched)).toEqual(styleAttributes(CHART_XML))
  })

  it('is byte-stable on repeated application and does not create absent visible owners', () => {
    const once = patchChartTextColors(CHART_XML, PATCH)
    expect(patchChartTextColors(once, PATCH)).toBe(once)

    const noVisibleOwners = `<?xml version="1.0"?><c:chartSpace xmlns:c="c" xmlns:a="a">
      <c:chart><c:plotArea><c:lineChart><c:ser><c:val><c:numLit><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:lineChart></c:plotArea></c:chart>
      <c:externalData r:id="missing" xmlns:r="r"/>
    </c:chartSpace>`
    const localOnly = patchChartTextColors(noVisibleOwners, {
      titleColor: '#FACC15',
      axisLabelColor: '#A5B4FC',
      axisTitleColor: '#67E8F9',
      legendColor: '#86EFAC',
      dataLabelColor: '#FDA4AF',
    })
    expect(localOnly).toBe(noVisibleOwners)
  })
})
