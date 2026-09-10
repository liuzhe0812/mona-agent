import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'

import { buildXlsxCheckpoint } from './xlsx-browser'

async function workbookFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  )
  zip.file(
    'xl/styles.xml',
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>before</t></is></c></row></sheetData></worksheet>',
  )
  zip.file('docProps/custom.xml', '<sentinel>unchanged</sentinel>')
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('browser XLSX checkpoint', () => {
  it('uses the GenOffice planner and preserves untouched entries', async () => {
    const output = await buildXlsxCheckpoint(await workbookFixture(), [
      {
        sheetName: 'Sheet1',
        row: 0,
        column: 0,
        writeValue: true,
        cell: { value: 'after' },
        style: { bold: true, horizontalAlignment: 'center' },
      },
    ])
    const zip = await JSZip.loadAsync(output)
    const worksheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    const styles = await zip.file('xl/styles.xml')!.async('string')

    expect(worksheet).toMatch(/<t\b[^>]*>after<\/t>/)
    expect(styles).toContain('<b/>')
    expect(styles).toContain('horizontal="center"')
    expect(await zip.file('docProps/custom.xml')!.async('string')).toBe('<sentinel>unchanged</sentinel>')
  })

  it('round-trips cell style deltas, formulas, and axis sizes through real OOXML', async () => {
    const output = await buildXlsxCheckpoint(
      await workbookFixture(),
      [
        {
          sheetName: 'Sheet1',
          row: 0,
          column: 0,
          writeValue: true,
          cell: { value: 'styled value' },
          style: {
            fontFamily: 'Verdana',
            fontSize: 14,
            verticalAlignment: 'center',
            wrapText: true,
            borderTop: { style: 'thin', color: '#FF0000' },
            borderBottom: { style: 'thin', color: '#FF0000' },
            borderLeft: { style: 'thin', color: '#FF0000' },
            borderRight: { style: 'thin', color: '#FF0000' },
          },
        },
        {
          sheetName: 'Sheet1',
          row: 0,
          column: 1,
          writeValue: true,
          cell: { value: null, formula: '=SUM(1,2)' },
        },
      ],
      [{
        sheetName: 'Sheet1',
        ops: [
          { kind: 'set-col-size', start: 0, end: 0, size: 22 },
          { kind: 'set-row-size', start: 0, end: 0, size: 30 },
        ],
      }],
    )
    const zip = await JSZip.loadAsync(output)
    const worksheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    const styles = await zip.file('xl/styles.xml')!.async('string')

    expect(worksheet).toMatch(/<t[^>]*>styled value<\/t>/)
    expect(worksheet).toContain('<f>SUM(1,2)</f>')
    expect(worksheet).toMatch(/<col\b[^>]*min="1"[^>]*max="1"[^>]*width="22"/)
    expect(worksheet).toContain('<row r="1" ht="30" customHeight="1"')
    expect(styles).toContain('<name val="Verdana"/>')
    expect(styles).toContain('<sz val="14"/>')
    expect(styles).toContain('<alignment vertical="center" wrapText="1"/>')
    expect(styles).toContain('<top style="thin"><color rgb="FFFF0000"/></top>')
    expect(styles).toContain('<bottom style="thin"><color rgb="FFFF0000"/></bottom>')
    expect(await zip.file('docProps/custom.xml')!.async('string')).toBe('<sentinel>unchanged</sentinel>')
  })

  it('persists filter, conditional-format, and freeze state through the real planner', async () => {
    const area = { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }
    const output = await buildXlsxCheckpoint(
      await workbookFixture(),
      [],
      [],
      undefined,
      {
        filterStates: [{
          sheetName: 'Sheet1',
          filter: { range: area, columns: [] },
          hiddenRows: [],
          visibilityRange: area,
        }],
        cfStates: [{
          sheetName: 'Sheet1',
          rules: [{
            ranges: [area],
            stopIfTrue: false,
            rule: {
              type: 'colorScale',
              config: [
                { index: 0, color: '#F8696B', value: { type: 'min' } },
                { index: 1, color: '#63BE7B', value: { type: 'max' } },
              ],
            },
          }],
        }],
        pageSetupStates: [{ sheetName: 'Sheet1', frozenRows: 1, frozenColumns: 1 }],
      },
    )
    const zip = await JSZip.loadAsync(output)
    const worksheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')

    expect(worksheet).toContain('<autoFilter ref="A1:B3"/>')
    expect(worksheet).toContain('<conditionalFormatting sqref="A1:B3">')
    expect(worksheet).toContain('type="colorScale"')
    expect(worksheet).toContain('<pane xSplit="1" ySplit="1"')
    expect(await zip.file('docProps/custom.xml')!.async('string')).toBe('<sentinel>unchanged</sentinel>')
  })

  it('removes an existing auto-filter when the filter state is null', async () => {
    const sourceZip = await JSZip.loadAsync(await workbookFixture())
    const originalWorksheet = await sourceZip.file('xl/worksheets/sheet1.xml')!.async('string')
    sourceZip.file('xl/worksheets/sheet1.xml', originalWorksheet.replace(
      '</sheetData>',
      '</sheetData><autoFilter ref="A1:B3"/>',
    ))
    const output = await buildXlsxCheckpoint(
      await sourceZip.generateAsync({ type: 'arraybuffer' }),
      [],
      [],
      undefined,
      {
        filterStates: [{
          sheetName: 'Sheet1',
          filter: null,
          hiddenRows: [],
          visibilityRange: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 },
        }],
      },
    )
    const zip = await JSZip.loadAsync(output)
    const worksheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(worksheet).not.toContain('<autoFilter')
  })
})
