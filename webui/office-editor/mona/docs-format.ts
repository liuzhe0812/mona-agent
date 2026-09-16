import type { Editor } from '@tiptap/core'
import { TableMap } from '@tiptap/pm/tables'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

const HEX_COLOR = /^#[0-9a-f]{6}$/i

function colorValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw new Error(`${key} 必须是 #RRGGBB 颜色。`)
  }
  return value.slice(1).toUpperCase()
}

function hasValue(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined
}

function numberValue(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} 必须是有限数字。`)
  }
  return value
}

function twipsToPoints(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value / 20 : null
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const hex = value.replace(/^#/, '')
  return /^([0-9a-f]{6})$/i.test(hex) ? `#${hex.toUpperCase()}` : value
}

function rowBreakXml(raw: unknown, allowBreak: boolean): string | null {
  let xml = typeof raw === 'string' && /^<w:trPr(?:\s[^>]*)?>[\s\S]*<\/w:trPr>$/.test(raw)
    ? raw
    : '<w:trPr></w:trPr>'
  xml = xml.replace(/<w:cantSplit(?:\s[^>]*)?\/>/g, '')
  if (!allowBreak) xml = xml.replace('</w:trPr>', '<w:cantSplit/></w:trPr>')
  return /^<w:trPr(?:\s[^>]*)?>\s*<\/w:trPr>$/.test(xml) ? null : xml
}

export function applyTableStyle(
  editor: Editor,
  tablePos: number,
  payload: Record<string, unknown>,
): void {
  const table = editor.state.doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'docTable') throw new Error('指定位置不是文档表格。')

  const provided = [
    'columnWidths', 'headerRows', 'headerFill', 'bodyFill', 'borderColor', 'cellPadding',
    'headerBold', 'headerAlign', 'verticalAlign', 'allowRowBreakAcrossPages',
  ]
    .filter((key) => hasValue(payload, key))
  if (provided.length === 0) throw new Error('至少需要提供一个表格样式字段。')

  const columnWidths = hasValue(payload, 'columnWidths') ? payload.columnWidths : undefined
  if (
    columnWidths !== undefined &&
    (!Array.isArray(columnWidths) ||
      columnWidths.length === 0 ||
      columnWidths.some((width) => typeof width !== 'number' || !Number.isFinite(width) || width <= 0))
  ) {
    throw new Error('columnWidths 必须是包含正数像素宽度的数组。')
  }

  const headerRows = hasValue(payload, 'headerRows') ? numberValue(payload, 'headerRows') : undefined
  if (
    headerRows !== undefined &&
    (!Number.isInteger(headerRows) || headerRows < 0 || headerRows > table.childCount)
  ) {
    throw new Error(`headerRows 必须是 0–${table.childCount} 的整数。`)
  }

  const cellPadding = hasValue(payload, 'cellPadding') ? numberValue(payload, 'cellPadding') : undefined
  if (cellPadding !== undefined && (cellPadding < 0 || cellPadding > 40)) {
    throw new Error('cellPadding 必须在 0–40 像素之间。')
  }

  const headerFill = hasValue(payload, 'headerFill') ? colorValue(payload, 'headerFill') : undefined
  const bodyFill = hasValue(payload, 'bodyFill') ? colorValue(payload, 'bodyFill') : undefined
  const borderColor = hasValue(payload, 'borderColor') ? colorValue(payload, 'borderColor') : undefined
  const headerBold = hasValue(payload, 'headerBold') ? payload.headerBold : undefined
  if (headerBold !== undefined && typeof headerBold !== 'boolean') throw new Error('headerBold 必须是布尔值。')
  const headerAlign = hasValue(payload, 'headerAlign') ? payload.headerAlign : undefined
  if (headerAlign !== undefined && !['left', 'center', 'right'].includes(String(headerAlign))) {
    throw new Error('headerAlign 必须是 left、center 或 right。')
  }
  const verticalAlign = hasValue(payload, 'verticalAlign') ? payload.verticalAlign : undefined
  if (verticalAlign !== undefined && !['top', 'center', 'bottom'].includes(String(verticalAlign))) {
    throw new Error('verticalAlign 必须是 top、center 或 bottom。')
  }
  const allowRowBreak = hasValue(payload, 'allowRowBreakAcrossPages')
    ? payload.allowRowBreakAcrossPages
    : undefined
  if (allowRowBreak !== undefined && typeof allowRowBreak !== 'boolean') {
    throw new Error('allowRowBreakAcrossPages 必须是布尔值。')
  }
  let columnPercentages: number[] | undefined
  let totalWidth: number | undefined
  if (columnWidths !== undefined) {
    const columnCount = TableMap.get(table).width
    if (columnWidths.length !== columnCount) {
      throw new Error(`columnWidths 必须包含 ${columnCount} 列。`)
    }
    totalWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    columnPercentages = columnWidths.map((width) => (width / totalWidth!) * 100)
  }

  const cellMargins = cellPadding === undefined
    ? undefined
    : {
        top: Math.round(cellPadding * 15),
        right: Math.round(cellPadding * 15),
        bottom: Math.round(cellPadding * 15),
        left: Math.round(cellPadding * 15),
      }
  const border = borderColor === undefined
    ? undefined
    : { style: 'single', szEighths: 4, color: borderColor }

  let transaction = editor.state.tr
  table.forEach((row, rowOffset, rowIndex) => {
    if (headerRows !== undefined || allowRowBreak !== undefined) {
      transaction = transaction.setNodeMarkup(tablePos + 1 + rowOffset, undefined, {
        ...row.attrs,
        ...(headerRows === undefined
          ? {}
          : { repeatHeader: rowIndex < headerRows, repeatHeaderEdited: true }),
        ...(allowRowBreak === undefined
          ? {}
          : { rawTrPr: rowBreakXml(row.attrs.rawTrPr, allowRowBreak) }),
      })
    }

    let column = 0
    row.forEach((cell, cellOffset) => {
      const colspan = Math.max(1, Number(cell.attrs.colspan) || 1)
      const isHeaderRow = headerRows === undefined ? row.attrs.repeatHeader === true : rowIndex < headerRows
      const cellPatch: Record<string, unknown> = {}
      if (columnWidths !== undefined) cellPatch.colwidth = columnWidths.slice(column, column + colspan)
      if (isHeaderRow && headerFill !== undefined) cellPatch.fill = headerFill
      if (!isHeaderRow && bodyFill !== undefined) cellPatch.fill = bodyFill
      if (isHeaderRow && headerBold !== undefined) cellPatch.bold = headerBold
      if (isHeaderRow && headerAlign !== undefined) cellPatch.align = headerAlign
      if (verticalAlign !== undefined) cellPatch.vAlign = verticalAlign
      if (border !== undefined) {
        cellPatch.borders = {
          top: { ...border },
          right: { ...border },
          bottom: { ...border },
          left: { ...border },
        }
      }
      if (Object.keys(cellPatch).length > 0) {
        transaction = transaction.setNodeMarkup(tablePos + 2 + rowOffset + cellOffset, undefined, {
          ...cell.attrs,
          ...cellPatch,
        })
      }
      if (isHeaderRow && (headerBold !== undefined || headerAlign !== undefined)) {
        const cellPos = tablePos + 2 + rowOffset + cellOffset
        cell.forEach((paragraph, paragraphOffset) => {
          if (paragraph.type.name !== 'docParagraph' && paragraph.type.name !== 'docListItem') return
          const paragraphPos = cellPos + 1 + paragraphOffset
          if (headerAlign !== undefined) {
            transaction = transaction.setNodeMarkup(paragraphPos, undefined, {
              ...paragraph.attrs,
              align: headerAlign,
            })
          }
          if (headerBold !== undefined && paragraph.content.size > 0) {
            const from = paragraphPos + 1
            const to = from + paragraph.content.size
            const bold = editor.schema.marks.bold
            transaction = headerBold
              ? transaction.addMark(from, to, bold.create())
              : transaction.removeMark(from, to, bold)
          }
        })
      }
      column += colspan
    })
  })

  const tablePatch: Record<string, unknown> = {}
  if (columnPercentages !== undefined) {
    tablePatch.colWidthsPct = columnPercentages
    tablePatch.widthPx = totalWidth
    tablePatch.widthPct = null
    tablePatch.tblAutoFit = 'fixed'
    tablePatch.tblAutoFitEdited = true
  }
  if (cellMargins !== undefined) {
    tablePatch.cellMar = cellMargins
    tablePatch.cellMarEdited = true
  }
  transaction = transaction.setNodeMarkup(tablePos, undefined, { ...table.attrs, ...tablePatch })
  editor.view.dispatch(transaction)
}

export function describeDocStyle(node: ProseMirrorNode): Record<string, unknown> {
  const textNodes: ProseMirrorNode[] = []
  node.descendants((child) => {
    if (child.isText) textNodes.push(child)
    return true
  })

  const textStyle = textNodes
    .flatMap((textNode) => textNode.marks)
    .find((mark) => mark.type.name === 'docTextStyle')?.attrs as
    | Record<string, unknown>
    | undefined
  const sizeHalfPoints =
    typeof textStyle?.sizeHalfPoints === 'number'
      ? textStyle.sizeHalfPoints
      : typeof node.attrs.emptyRunSize === 'number'
        ? node.attrs.emptyRunSize
        : null
  const fontFamily =
    (typeof textStyle?.fontAscii === 'string' && textStyle.fontAscii) ||
    (typeof textStyle?.font === 'string' && textStyle.font) ||
    (typeof node.attrs.emptyRunFont === 'string' && node.attrs.emptyRunFont) ||
    null
  const hasMark = (name: string): boolean =>
    textNodes.length > 0 && textNodes.every((textNode) => textNode.marks.some((mark) => mark.type.name === name))

  return {
    type: node.type.name,
    fontFamily,
    fontSizePt: sizeHalfPoints === null ? null : sizeHalfPoints / 2,
    color: normalizeColor(textStyle?.color),
    bold: hasMark('bold'),
    italic: hasMark('italic'),
    underline: hasMark('underline'),
    strike: hasMark('strike'),
    paragraph: {
      align: node.attrs.align ?? null,
      lineSpacing: node.attrs.lineSpacing ?? null,
      lineRule: node.attrs.lineRule ?? null,
      indentLeftPt: twipsToPoints(node.attrs.indentLeft),
      indentRightPt: twipsToPoints(node.attrs.indentRight),
      indentFirstLinePt: twipsToPoints(node.attrs.indentFirstLine),
      spaceBeforePt: twipsToPoints(node.attrs.spaceBefore),
      spaceAfterPt: twipsToPoints(node.attrs.spaceAfter),
      pageBreakBefore: node.attrs.pageBreakBefore === true,
    },
  }
}
