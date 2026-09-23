import { describe, expect, it } from 'vitest'
import { mapXmlColors } from './slides-colors'

describe('native color-only XML patch', () => {
  it('keeps mixed text, numeric literals, alpha, gradients, geometry and media untouched', () => {
    const xml = `<p:grpSp><p:sp><p:spPr><a:xfrm><a:off x="25856" y="120"/></a:xfrm><a:gradFill><a:gs pos="0"><a:srgbClr val="25856B"><a:alpha val="50000"/></a:srgbClr></a:gs><a:gs pos="100000"><a:srgbClr val="AA0000"/></a:gs></a:gradFill><a:ln><a:solidFill><a:srgbClr val='25856b'/></a:solidFill></a:ln></p:spPr><p:txBody><a:p><a:r><a:rPr sz="9000"><a:solidFill><a:srgbClr val="25856B"/></a:solidFill></a:rPr><a:t>人工修改 #25856B，金额25856</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip><a:duotone><a:srgbClr val="25856B"/></a:duotone></a:blip></p:blipFill></p:pic><a:schemeClr val="accent1"/></p:grpSp>`
    const fields: string[] = []
    const result = mapXmlColors(xml, (hex, field) => { fields.push(field); return hex === '25856B' ? 'E56B20' : undefined })
    expect(result.text.match(/E56B20/g)).toHaveLength(3)
    expect(result.text).toContain('人工修改 #25856B，金额25856')
    expect(result.text).toContain('<a:alpha val="50000"/>')
    expect(result.text).toContain('<p:pic><p:blipFill><a:blip><a:duotone><a:srgbClr val="25856B"/>')
    expect(result.inherited).toBe(1)
    expect(fields).toEqual(['fill', 'fill', 'stroke', 'text'])
    expect(mapXmlColors(result.text, () => '000000').text).toBe(mapXmlColors(xml, () => '000000').text)
  })
  it('honors property selection, leaves comments alone, and uses simultaneous mappings', () => {
    const xml = '<!-- <a:srgbClr val="25856B"/> --><a:rPr><a:solidFill><a:srgbClr val="25856B"/></a:solidFill></a:rPr><a:ln><a:srgbClr val="E56B20"/></a:ln>'
    const map: Record<string, string> = { '25856B': 'E56B20', 'E56B20': '000000' }
    const result = mapXmlColors(xml, (hex, field) => field === 'text' ? map[hex] : undefined).text
    expect(result).toBe('<!-- <a:srgbClr val="25856B"/> --><a:rPr><a:solidFill><a:srgbClr val="E56B20"/></a:solidFill></a:rPr><a:ln><a:srgbClr val="E56B20"/></a:ln>')
    expect(mapXmlColors(xml, (hex) => hex).text).toBe(xml)
  })
})
