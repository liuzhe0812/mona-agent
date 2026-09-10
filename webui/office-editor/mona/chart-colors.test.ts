import { describe, expect, it } from 'vitest'

import { parseChartXml } from '../vendor/genoffice/packages/pptx-engine/src/chart'
import { makeViewport } from '../vendor/genoffice/packages/pptx-render/src/coords'
import { buildChartNode } from '../vendor/genoffice/packages/pptx-render/src/build-chart'
import { HeuristicMetrics } from '../vendor/genoffice/packages/pptx-render/src/metrics'

const XML_PREFIX = '<c:chartSpace xmlns:c="c" xmlns:a="a">'
const XML_SUFFIX = '</c:chartSpace>'
const box = {
  x: 0,
  y: 0,
  w: 640,
  h: 400,
  centerX: 320,
  centerY: 200,
  rotationDeg: 0,
  flipH: false,
  flipV: false,
}
const vp = makeViewport({ cx: 12192000, cy: 6858000 }, 1280)
const metrics = new HeuristicMetrics()

const CHART_XML = `${XML_PREFIX}
  <c:chart>
    <c:title>
      <c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p>
        <a:r><a:rPr><a:solidFill><a:srgbClr val="AA0000"/></a:solidFill></a:rPr><a:t>Revenue</a:t></a:r>
      </a:p></c:rich></c:tx>
    </c:title>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Series A</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>17</c:v></c:pt><c:pt idx="1"><c:v>23</c:v></c:pt></c:numCache></c:numRef></c:val>
          <c:dLbls><c:showVal val="1"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="DDAA00"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr></c:dLbls>
        </c:ser>
        <c:dLbls><c:showVal val="1"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="CC6600"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr></c:dLbls>
        <c:axId val="1"/><c:axId val="2"/>
      </c:lineChart>
      <c:catAx>
        <c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/>
        <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="BB00BB"/></a:solidFill></a:rPr><a:t>Period</a:t></a:r></a:p></c:rich></c:tx></c:title>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="00BB00"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>
      </c:catAx>
      <c:valAx>
        <c:axId val="2"/><c:scaling/><c:delete val="0"/><c:axPos val="l"/>
        <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Amount</a:t></a:r></a:p></c:rich></c:tx>
          <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="0000AA"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>
        </c:title>
        <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>
      </c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="008800"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr></c:legend>
  </c:chart>
  <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>
${XML_SUFFIX}`

const ROOT_FALLBACK_XML = `${XML_PREFIX}
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Series A</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>17</c:v></c:pt><c:pt idx="1"><c:v>23</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c:ser>
        <c:dLbls><c:showVal val="1"/></c:dLbls>
        <c:axId val="1"/><c:axId val="2"/>
      </c:lineChart>
      <c:catAx><c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Period</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling/><c:delete val="0"/><c:axPos val="l"/><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Amount</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
  </c:chart>
  <c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr>
${XML_SUFFIX}`

function label(node: NonNullable<ReturnType<typeof buildChartNode>>, text: string) {
  return node.labels.find((item) => item.text === text)
}

describe('chart text colors', () => {
  it('parses explicit chart text colors and applies them to the render tree', () => {
    const model = parseChartXml(CHART_XML)!
    expect(model).toMatchObject({
      textColor: '#123456',
      titleColor: '#AA0000',
      legendColor: '#008800',
      dataLabelColor: '#CC6600',
      valAxis: { labelColor: '#00AA00', titleColor: '#0000AA' },
      catAxis: { labelColor: '#00BB00', titleColor: '#BB00BB' },
    })
    expect(model.series[0]?.dataLabelColor).toBe('#DDAA00')

    const node = buildChartNode('chart', 'source', model, box, vp, metrics)!
    expect(label(node, 'Revenue')?.color).toBe('#AA0000')
    expect(label(node, 'Q1')?.color).toBe('#00BB00')
    expect(label(node, 'Period')?.color).toBe('#BB00BB')
    expect(label(node, 'Amount')?.color).toBe('#0000AA')
    expect(label(node, 'Series A')?.color).toBe('#008800')
    expect(label(node, '17')?.color).toBe('#DDAA00')
    expect(label(node, '23')?.color).toBe('#DDAA00')
  })

  it('falls back from local colors to chartSpace textColor, then preserves defaults', () => {
    const model = parseChartXml(ROOT_FALLBACK_XML)!
    expect(model.textColor).toBe('#123456')
    expect(model.titleColor).toBeUndefined()
    expect(model.legendColor).toBeUndefined()
    expect(model.dataLabelColor).toBeUndefined()
    expect(model.valAxis?.labelColor).toBeUndefined()
    expect(model.catAxis?.labelColor).toBeUndefined()

    const node = buildChartNode('chart', 'source', model, box, vp, metrics)!
    expect(label(node, 'Revenue')?.color).toBe('#123456')
    expect(label(node, 'Q1')?.color).toBe('#123456')
    expect(label(node, 'Period')?.color).toBe('#123456')
    expect(label(node, 'Amount')?.color).toBe('#123456')
    expect(label(node, 'Series A')?.color).toBe('#123456')
    expect(label(node, '17')?.color).toBe('#123456')

    const noRootColor = parseChartXml(ROOT_FALLBACK_XML.replace(/<c:txPr>[\s\S]*<\/c:txPr>\s*<\/c:chartSpace>$/, XML_SUFFIX))!
    const defaults = buildChartNode('chart', 'source', noRootColor, box, vp, metrics)!
    expect(label(defaults, 'Revenue')?.color).toBe('#000000')
    expect(label(defaults, 'Q1')?.color).toBe('#000000')
    expect(label(defaults, 'Series A')?.color).toBe('#000000')
    expect(label(defaults, '17')?.color).toBe('#404040')
  })

  it('uses the explicit data-label color across bar, pie, and scatter builders', () => {
    const bar = buildChartNode('bar', 'source', {
      kind: 'bar',
      barDir: 'col',
      grouping: 'stacked',
      categories: ['A'],
      textColor: '#123456',
      series: [{ values: [37], dataLabels: true }],
    }, box, vp, metrics)!
    expect(label(bar, '37')?.color).toBe('#123456')

    const pie = buildChartNode('pie', 'source', {
      kind: 'pie',
      categories: ['A'],
      dataLabelColor: '#654321',
      series: [{ values: [37], dataLabels: true }],
    }, box, vp, metrics)!
    expect(label(pie, '37')?.color).toBe('#654321')

    const scatter = buildChartNode('scatter', 'source', {
      kind: 'scatter',
      categories: [],
      dataLabelColor: '#AABBCC',
      dataLabels: true,
      series: [{ values: [37], xValues: [1] }],
    }, box, vp, metrics)!
    expect(label(scatter, '37')?.color).toBe('#AABBCC')

    const whiteFallback = buildChartNode('bar', 'source', {
      kind: 'bar',
      barDir: 'col',
      grouping: 'stacked',
      categories: ['A'],
      series: [{ values: [37], dataLabels: true }],
    }, box, vp, metrics)!
    expect(label(whiteFallback, '37')?.color).toBe('#FFFFFF')
  })
})
