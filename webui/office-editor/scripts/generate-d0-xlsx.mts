import JSZip from 'jszip'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { buildXlsxCheckpoint, type CellEdit } from '../mona/xlsx-browser'

const fixedDate = new Date('2000-01-01T00:00:00.000Z')
const officeEditorRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(officeEditorRoot, '../../tests/fixtures/office/d0-roundtrip.xlsx')

function addEntry(zip: JSZip, path: string, content: string): void {
  zip.file(path, content, { date: fixedDate, createFolders: false })
}

async function sourceWorkbook(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  addEntry(
    zip,
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  )
  addEntry(
    zip,
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  )
  addEntry(
    zip,
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets>' +
      '<calcPr fullCalcOnLoad="1"/></workbook>',
  )
  addEntry(
    zip,
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  )
  addEntry(
    zip,
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  )
  addEntry(
    zip,
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:C3"/><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c>' +
      '<c r="B1" t="inlineStr"><is><t>收入</t></is></c>' +
      '<c r="C1" t="inlineStr"><is><t>增长率</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>一月</t></is></c>' +
      '<c r="B2"><v>120000</v></c>' +
      '<c r="C2"><f>B2/100000-1</f><v>0.2</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>二月</t></is></c>' +
      '<c r="B3"><v>130000</v></c>' +
      '<c r="C3"><f>B3/B2-1</f><v>0.08333333333333333</v></c></row>' +
      '</sheetData></worksheet>',
  )
  return zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

async function normalizeArchive(buffer: ArrayBuffer): Promise<Buffer> {
  const source = await JSZip.loadAsync(buffer)
  const normalized = new JSZip()
  for (const [path, entry] of Object.entries(source.files)) {
    if (entry.dir) {
      normalized.folder(path, { date: fixedDate })
    } else {
      normalized.file(path, await entry.async('uint8array'), {
        binary: true,
        date: fixedDate,
        createFolders: false,
      })
    }
  }
  return Buffer.from(await normalized.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }))
}

const edits: readonly CellEdit[] = [
  { sheetName: '销售', row: 0, column: 0, writeValue: true, cell: { value: '月份' }, style: { bold: true, horizontalAlignment: 'center' } },
  { sheetName: '销售', row: 0, column: 1, writeValue: true, cell: { value: '收入' }, style: { bold: true, horizontalAlignment: 'center' } },
  { sheetName: '销售', row: 0, column: 2, writeValue: true, cell: { value: '增长率' }, style: { bold: true, horizontalAlignment: 'center' } },
  { sheetName: '销售', row: 1, column: 2, writeValue: false, cell: { value: null }, style: { horizontalAlignment: 'center', numberFormat: '0.00%' } },
  { sheetName: '销售', row: 2, column: 2, writeValue: false, cell: { value: null }, style: { horizontalAlignment: 'center', numberFormat: '0.00%' } },
]

const checkpoint = await buildXlsxCheckpoint(await sourceWorkbook(), edits)
const output = await normalizeArchive(checkpoint)
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, output)
process.stdout.write(`generated ${outputPath} (${output.byteLength} bytes)\n`)
