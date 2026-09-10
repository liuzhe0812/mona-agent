import { Editor } from '@tiptap/core'
import { parseDocx, saveDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { buildDocx } from '../vendor/genoffice/packages/docx-engine/tests/helpers/build-docx'
import {
  blocksToPmDoc,
  pmDocToSavePlan,
  type PmNode,
} from '../vendor/genoffice/apps/docs/src/renderer/editor/convert'
import { editorExtensions } from '../vendor/genoffice/apps/docs/src/renderer/editor/extensions'
import { applyTableStyle, describeDocStyle } from './docs-format'

const TABLE =
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
  '<w:tr><w:tc><w:p><w:r><w:t>标题</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>一月</w:t></w:r></w:p></w:tc>' +
  '<w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'

const PARAGRAPH =
  '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>' +
  '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Arial"/>' +
  '<w:sz w:val="28"/><w:b/><w:color w:val="C00000"/></w:rPr>' +
  '<w:t>报告</w:t></w:r></w:p>'

async function openEditor(bodyXml: string): Promise<{
  editor: Editor
  parsed: Awaited<ReturnType<typeof parseDocx>>
}> {
  const parsed = await parseDocx(await buildDocx({ bodyXml }))
  const editor = new Editor({
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  return { editor, parsed }
}

describe('Mona document formatting helpers', () => {
  it('applies table formatting and preserves it through docx save and parse', async () => {
    const { editor, parsed } = await openEditor(TABLE)
    let tablePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (tablePos < 0 && node.type.name === 'docTable') tablePos = pos
    })
    expect(tablePos).toBeGreaterThanOrEqual(0)

    applyTableStyle(editor, tablePos, {
      columnWidths: [200, 300],
      headerRows: 1,
      headerFill: '#D9EAF7',
      bodyFill: '#FFFFFF',
      borderColor: '#9DC3E6',
      cellPadding: 10,
    })

    const table = editor.state.doc.nodeAt(tablePos)!
    expect(table.attrs).toMatchObject({
      widthPx: 500,
      tblAutoFit: 'fixed',
      cellMar: { top: 150, right: 150, bottom: 150, left: 150 },
    })
    expect(table.child(0).attrs).toMatchObject({ repeatHeader: true, repeatHeaderEdited: true })
    expect(table.child(1).attrs).toMatchObject({ repeatHeader: false, repeatHeaderEdited: true })
    expect(table.child(0).child(0).attrs).toMatchObject({
      colwidth: [200],
      fill: 'D9EAF7',
      borders: { top: { color: '9DC3E6' } },
    })
    expect(table.child(1).child(1).attrs).toMatchObject({ colwidth: [300], fill: 'FFFFFF' })

    const plan = pmDocToSavePlan(editor.getJSON() as PmNode, parsed.blocks)
    const reparsed = await parseDocx(await saveDocx(parsed, plan.saveBlocks))
    const savedTable = reparsed.blocks.find((block) => block.table)?.table
    expect(savedTable?.colWidthsTwips).toEqual([3000, 4500])
    expect(savedTable?.cellMarTwips).toEqual({ top: 150, right: 150, bottom: 150, left: 150 })
    expect(savedTable?.repeatHeaderRows).toEqual([true, false])
    expect(savedTable?.rows[0]?.[0]?.fill).toBe('D9EAF7')
    expect(savedTable?.rows[1]?.[1]?.fill).toBe('FFFFFF')
    expect(savedTable?.rows[0]?.[0]?.borders?.top?.color).toBe('9DC3E6')
    editor.destroy()
  })

  it('validates before dispatching a transaction', async () => {
    const { editor } = await openEditor(TABLE)
    const before = editor.getJSON()
    expect(() =>
      applyTableStyle(editor, 0, {
        columnWidths: [200],
        headerRows: 1,
        headerFill: '#D9EAF7',
        bodyFill: '#FFFFFF',
        borderColor: '#9DC3E6',
        cellPadding: 10,
      }),
    ).toThrow(/columnWidths/)
    expect(editor.getJSON()).toEqual(before)
    editor.destroy()
  })

  it('changes only the explicitly provided table style field', async () => {
    const { editor } = await openEditor(TABLE)
    let tablePos = -1
    editor.state.doc.descendants((node, pos) => {
      if (tablePos < 0 && node.type.name === 'docTable') tablePos = pos
    })
    const before = editor.state.doc.nodeAt(tablePos)!
    const beforeWidths = before.child(0).child(0).attrs.colwidth
    const beforeFill = before.child(0).child(0).attrs.fill

    applyTableStyle(editor, tablePos, { borderColor: '#123456' })

    const after = editor.state.doc.nodeAt(tablePos)!
    expect(after.attrs.widthPx).toBe(before.attrs.widthPx)
    expect(after.attrs.colWidthsPct).toEqual(before.attrs.colWidthsPct)
    expect(after.child(0).child(0).attrs.colwidth).toEqual(beforeWidths)
    expect(after.child(0).child(0).attrs.fill).toBe(beforeFill)
    expect(after.child(0).child(0).attrs.borders).toMatchObject({
      top: { color: '123456' },
    })
    editor.destroy()
  })

  it('describes readable font and paragraph style fields', async () => {
    const { editor } = await openEditor(PARAGRAPH)
    const paragraph = editor.state.doc.firstChild!
    expect(describeDocStyle(paragraph)).toEqual({
      type: 'docParagraph',
      fontFamily: 'Arial',
      fontSizePt: 14,
      color: '#C00000',
      bold: true,
      italic: false,
      underline: false,
      strike: false,
      paragraph: {
        align: 'center',
        lineSpacing: null,
        lineRule: null,
        indentLeftPt: null,
        indentRightPt: null,
        indentFirstLinePt: null,
        spaceBeforePt: null,
        spaceAfterPt: 12,
        pageBreakBefore: false,
      },
    })
    editor.destroy()
  })
})
