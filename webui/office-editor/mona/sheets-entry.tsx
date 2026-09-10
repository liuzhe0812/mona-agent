import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HorizontalAlign, type ICellData } from '@univerjs/core'
import '@univerjs/preset-sheets-core/lib/index.css'
import { installScreenTips } from '@genoffice/ui'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'

import { createUniver } from '../vendor/genoffice/apps/sheets/src/renderer/create-univer'
import {
  App as GenOfficeSheetsApp,
  type EmbeddedSheetsApi,
  type EmbeddedSheetsController,
} from '../vendor/genoffice/apps/sheets/src/renderer/App'
import { LocaleProvider, setModuleLang } from '../vendor/genoffice/apps/sheets/src/renderer/i18n/locale'
import type {
  WorkbookFile,
  WorkbookRangeRequest,
  WorkbookRangeResult,
} from '../vendor/genoffice/apps/sheets/src/shared/desktop-api'
import {
  formatAddress,
  parseRange,
  rangeCellCount,
  type RangeBounds,
} from '../vendor/genoffice/apps/sheets/src/domain/cell-address'
import { fromNeutralStyle, toNeutralStyle } from '../vendor/genoffice/apps/sheets/src/renderer/edit-journal'
import {
  CF_MUTATIONS,
  FILTER_MUTATIONS,
  SET_FROZEN_MUTATION,
  getWorkbookMdw,
  pixelsToCharacterWidth,
} from '../vendor/genoffice/apps/sheets/src/renderer/app-constants'
import { MonaOfficeBridge, type DocumentVersion, type HostMessage, type OfficeOpenMessage } from './bridge'
import {
  buildXlsxCheckpoint,
  type CellEdit,
  type SheetCfState,
  type SheetEditPlan,
  type SheetFilterState,
  type SheetPageSetupState,
  type SheetStructuralOps,
  type StructuralOp,
} from './xlsx-browser'
import { sameDocumentVersion } from './version'
import { captureEditorElement, VisualVersionConflict } from './visual'
import './sheets-editor.css'
import '../vendor/genoffice/apps/sheets/src/renderer/styles.css'
import './ribbon-overflow.css'

if (typeof document.addEventListener === 'function') installScreenTips()
setModuleLang('zh')

if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => window.location.reload())
}

let embeddedReadWorkbookRange:
  | ((request: WorkbookRangeRequest) => Promise<WorkbookRangeResult>)
  | null = null

if (!(window as unknown as { desktopApi?: unknown }).desktopApi) {
  const embeddedDesktopApi = {
    getLanguage: async () => 'zh',
    getTheme: async () => 'system',
    onLanguageChanged: () => () => undefined,
    onThemeChanged: () => () => undefined,
    onChromePressed: () => () => undefined,
    selectWorkbook: async () => null,
    readWorkbookRange: async (request: WorkbookRangeRequest) => {
      if (!embeddedReadWorkbookRange) throw new Error('Mona 表格尚未连接。')
      return embeddedReadWorkbookRange(request)
    },
    readWorkbookFormulas: async () => ({ cells: [], indexingComplete: true, truncated: false }),
    recalcWorkbook: async () => ({ cells: [] }),
    saveWorkbookEdits: async () => ({ canceled: true }),
    writeWorkbookRecovery: async () => ({ ok: true }),
    closeWorkbook: async () => undefined,
    openExternal: async (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
    getAiSettings: async () => ({ provider: 'anthropic', providers: {} }),
    hasQueuedWorkbook: async () => false,
    consumeNewBlankWorkbook: async () => false,
    getRecentFiles: async () => [],
    notifyPendingEdits: () => undefined,
    onMenuAction: () => () => undefined,
    onCloseSaveRequest: () => () => undefined,
    onWorkbookRenamed: () => () => undefined,
    onRecoveryPrompt: () => () => undefined,
    reportCloseSaveResult: () => undefined,
  }
  ;(window as unknown as { desktopApi: Record<string, unknown> }).desktopApi = new Proxy(embeddedDesktopApi, {
    get: (target, property) => {
      if (property in target) return target[property as keyof typeof target]
      if (typeof property === 'string' && property.startsWith('on')) return () => () => undefined
      return async () => null
    },
  })
}

type UniverRuntime = ReturnType<typeof createUniver>
type CellValue = string | number | boolean | null

type WorkbookSheet = WorkbookFile['sheets'][number]

type EngineSheet = Pick<
  WorkbookSheet,
  'id' | 'name' | 'rowCount' | 'columnCount' | 'hidden' | 'showGridLines'
> & Partial<Omit<WorkbookSheet, 'id' | 'name' | 'rowCount' | 'columnCount' | 'hidden' | 'showGridLines'>> & {
  originalName?: string
}

type EngineStyle = Partial<WorkbookFile['styles'][number]>

interface EngineWorkbook {
  sessionId: string
  name: string
  sheets: EngineSheet[]
  styles: EngineStyle[]
}

interface EngineRangeResult {
  cells: Array<{
    row: number
    column: number
    value: CellValue
    formula?: string
    styleIndex?: number
  }>
}

interface SheetStyle {
  bold?: boolean | null
  italic?: boolean | null
  color?: string | null
  backgroundColor?: string | null
  numberFormat?: string | null
  horizontalAlign?: 'left' | 'center' | 'right' | null
  fontFamily?: string
  fontSize?: number
  underline?: boolean
  strikethrough?: boolean
  verticalAlign?: 'top' | 'center' | 'bottom'
  wrapText?: boolean
  borderTop?: { style: string; color?: string } | null
  borderBottom?: { style: string; color?: string } | null
  borderLeft?: { style: string; color?: string } | null
  borderRight?: { style: string; color?: string } | null
}

type SheetOperation =
  | { op: 'set_cell'; payload: { sheet: string; cell: string; value: CellValue } }
  | { op: 'set_range'; payload: { sheet: string; range: string; values: CellValue[][] } }
  | { op: 'set_formula'; payload: { sheet: string; cell: string; formula: string } }
  | { op: 'clear_range'; payload: { sheet: string; range: string } }
  | { op: 'set_style'; payload: { sheet: string; range: string; style: SheetStyle } }
  | { op: 'insert_rows' | 'delete_rows'; payload: { sheet: string; index: number; count: number } }
  | { op: 'insert_columns' | 'delete_columns'; payload: { sheet: string; index: number; count: number } }
  | { op: 'merge_cells' | 'unmerge_cells'; payload: { sheet: string; range: string } }
  | { op: 'add_sheet'; payload: { name: string } }
  | { op: 'delete_sheet'; payload: { sheet: string } }
  | { op: 'rename_sheet'; payload: { sheet: string; newName: string } }
  | { op: 'move_sheet'; payload: { sheet: string; position: number } }
  | { op: 'set_column_width' | 'set_row_height'; payload: { sheet: string; index: number; count: number; size: number } }
  | { op: 'set_auto_filter'; payload: { sheet: string; range: string | null } }
  | { op: 'set_freeze_panes'; payload: { sheet: string; rows: number; columns: number } }
  | { op: 'set_conditional_format'; payload: { sheet: string; range: string; rule: Record<string, unknown> } }

interface SheetRevisionSnapshot {
  edits: CellEdit[]
  structuralOps: SheetStructuralOps[]
  sheetPlan?: SheetEditPlan
  filterStates: SheetFilterState[]
  cfStates: SheetCfState[]
  pageSetupStates: SheetPageSetupState[]
}

interface ApplyCommand {
  sessionId: string
  operationId: string
  expectedVersion: DocumentVersion
  operations: SheetOperation[]
}

interface InspectCommand {
  sessionId: string
  requestId: string
  query:
    | { mode: 'summary' }
    | { mode: 'visual' }
    | { mode: 'selection' }
    | { mode: 'range'; sheet: string; range: string; includeFormula: boolean; includeStyle: boolean }
}

interface RangeSnapshot {
  sheetName: string
  bounds: RangeBounds
  cells: ICellData[][]
}

interface UniverCommandEvent {
  id: string
  params?: {
    unitId?: string
    subUnitId?: string
    subUnitName?: string
    cellValue?: unknown
    range?: unknown
    ranges?: unknown[]
    values?: Record<string, { ranges?: unknown[] }>
    name?: string
    index?: number
    colWidth?: number | Record<string, number>
    rowHeight?: number | Record<string, number>
    sheet?: { id?: string; name?: string; rowCount?: number; columnCount?: number }
  }
  options?: { fromFormula?: boolean }
}

interface RemovedSheetState {
  sheet: EngineSheet
  edits: CellEdit[]
  structuralOps: StructuralOp[]
}

const ROW_COLUMN_MUTATIONS: Record<
  string,
  { kind: 'insert-rows' | 'remove-rows' | 'insert-cols' | 'remove-cols'; axis: 'row' | 'column' }
> = {
  'sheet.mutation.insert-row': { kind: 'insert-rows', axis: 'row' },
  'sheet.mutation.remove-rows': { kind: 'remove-rows', axis: 'row' },
  'sheet.mutation.insert-col': { kind: 'insert-cols', axis: 'column' },
  'sheet.mutation.remove-col': { kind: 'remove-cols', axis: 'column' },
}

const MERGE_MUTATIONS: Record<string, 'merge-cells' | 'unmerge-cells'> = {
  'sheet.mutation.add-worksheet-merge': 'merge-cells',
  'sheet.mutation.remove-worksheet-merge': 'unmerge-cells',
}

const SHEET_LIFECYCLE_MUTATIONS = new Set([
  'sheet.mutation.insert-sheet',
  'sheet.mutation.remove-sheet',
  'sheet.mutation.set-worksheet-name',
  'sheet.mutation.set-worksheet-order',
])

function rangeBounds(value: unknown): RangeBounds | null {
  if (!isRecord(value)) return null
  const startRow = Number(value.startRow)
  const endRow = Number(value.endRow)
  const startColumn = Number(value.startColumn)
  const endColumn = Number(value.endColumn)
  if (![startRow, endRow, startColumn, endColumn].every(Number.isInteger)) return null
  if (startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn) return null
  return { startRow, endRow, startColumn, endColumn }
}

function cellValueBounds(value: unknown): RangeBounds | null {
  if (!isRecord(value)) return null
  const rows = Object.keys(value).map(Number).filter(Number.isInteger)
  if (rows.length === 0) return null
  const columns = rows.flatMap((row) => {
    const cells = value[String(row)]
    return isRecord(cells) ? Object.keys(cells).map(Number).filter(Number.isInteger) : []
  })
  if (columns.length === 0) return null
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...columns),
    endColumn: Math.max(...columns),
  }
}

function rowColumnOperations(
  operations: readonly StructuralOp[],
  axis: 'row' | 'column',
): Array<Extract<StructuralOp, { index: number }>> {
  return operations.filter((operation): operation is Extract<StructuralOp, { index: number }> => (
    'index' in operation
    && (axis === 'row'
      ? operation.kind === 'insert-rows' || operation.kind === 'remove-rows'
      : operation.kind === 'insert-cols' || operation.kind === 'remove-cols')
  ))
}

function fileToScreen(operations: readonly StructuralOp[], axis: 'row' | 'column', index: number): number | null {
  let position = index
  for (const operation of rowColumnOperations(operations, axis)) {
    if (operation.kind.startsWith('insert-')) {
      if (position >= operation.index) position += operation.count
    } else if (position >= operation.index && position < operation.index + operation.count) {
      return null
    } else if (position >= operation.index + operation.count) {
      position -= operation.count
    }
  }
  return position
}

function screenToFile(operations: readonly StructuralOp[], axis: 'row' | 'column', index: number): number | null {
  let position = index
  const relevant = rowColumnOperations(operations, axis)
  for (let step = relevant.length - 1; step >= 0; step -= 1) {
    const operation = relevant[step]!
    if (operation.kind.startsWith('insert-')) {
      if (position >= operation.index && position < operation.index + operation.count) return null
      if (position >= operation.index + operation.count) position -= operation.count
    } else if (position >= operation.index) {
      position += operation.count
    }
  }
  return position
}

function screenRangeToFileRange(operations: readonly StructuralOp[], range: RangeBounds): RangeBounds | null {
  const rows = Array.from({ length: range.endRow - range.startRow + 1 }, (_, offset) => (
    screenToFile(operations, 'row', range.startRow + offset)
  )).filter((index): index is number => index !== null)
  const columns = Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, offset) => (
    screenToFile(operations, 'column', range.startColumn + offset)
  )).filter((index): index is number => index !== null)
  if (rows.length === 0 || columns.length === 0) return null
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...columns),
    endColumn: Math.max(...columns),
  }
}

interface CachedOperation {
  fingerprint: string
  result: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value: unknown): value is DocumentVersion {
  return isRecord(value)
    && typeof value.editorEpoch === 'string'
    && Number.isInteger(value.modelRevision)
    && Number(value.modelRevision) >= 0
}

function normalizeCellValue(value: unknown): CellValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null
}

function parseWorkbook(value: unknown): EngineWorkbook {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.name !== 'string') {
    throw new Error('工作簿元数据无效。')
  }
  if (!Array.isArray(value.sheets) || !Array.isArray(value.styles)) {
    throw new Error('工作簿元数据不完整。')
  }
  return value as unknown as EngineWorkbook
}

function parseEngineRange(value: unknown): EngineRangeResult {
  if (!isRecord(value) || !Array.isArray(value.cells)) throw new Error('工作表数据无效。')
  return value as unknown as EngineRangeResult
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice(0))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function embeddedWorkbookFile(
  message: OfficeOpenMessage,
  workbook: EngineWorkbook,
): Promise<WorkbookFile> {
  return {
    sessionId: workbook.sessionId,
    name: workbook.name,
    sha256: await sha256Hex(message.file),
    entryCount: 0,
    activeTab: 0,
    sheets: workbook.sheets.map(({ originalName: _originalName, ...sheet }) => ({
      ...sheet,
      rowCount: Math.max(1, sheet.rowCount),
      columnCount: Math.max(1, sheet.columnCount),
      columnWidths: sheet.columnWidths ?? [],
      defaultRowHeight: sheet.defaultRowHeight ?? null,
      defaultColumnWidth: sheet.defaultColumnWidth ?? null,
      freeze: sheet.freeze ?? null,
      tabColor: sheet.tabColor ?? null,
      tables: sheet.tables ?? [],
      comments: sheet.comments ?? [],
      pivotRanges: sheet.pivotRanges ?? [],
      pivotTables: sheet.pivotTables ?? [],
      sparklines: sheet.sparklines ?? [],
      cellImages: sheet.cellImages ?? [],
    })),
    styles: workbook.styles.map((style) => ({
      ...style,
      bold: style.bold === true,
      italic: style.italic === true,
      underline: style.underline === true,
      strikethrough: style.strikethrough === true,
      wrapText: style.wrapText === true,
      ...(style.fontColor ? { fontColor: style.fontColor } : {}),
      ...(style.fillColor ? { fillColor: style.fillColor } : {}),
      ...(style.numberFormat ? { numberFormat: style.numberFormat } : {}),
      ...(style.horizontalAlignment ? { horizontalAlignment: style.horizontalAlignment } : {}),
      diagonalUp: style.diagonalUp === true,
      diagonalDown: style.diagonalDown === true,
    })),
    dxfStyles: [],
    visuals: [],
    definedNames: [],
    readOnly: false,
  }
}

function embeddedRangeResult(result: EngineRangeResult): WorkbookRangeResult {
  return {
    cells: result.cells,
    rows: [],
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    dataValidations: [],
    sheetProtection: null,
    rowBreaks: [],
    colBreaks: [],
    pageSetup: null,
    protectedRanges: [],
    indexedThroughRow: null,
    indexingComplete: true,
  }
}

function worksheetByName(runtime: UniverRuntime, name: string) {
  return runtime.univerAPI.getActiveWorkbook()?.getSheets().find((sheet) => sheet.getSheetName() === name)
}

type FilterFacade = {
  getRange: () => { getRange: () => RangeBounds }
  getColumnFilterCriteria: (column: number) => unknown
  getFilteredOutRows: () => number[]
}

type ConditionalRuleFacade = {
  ranges: Array<RangeBounds>
  stopIfTrue?: boolean
  rule: Record<string, unknown>
}

type ConditionalBuilder = {
  setRanges: (ranges: Array<RangeBounds>) => ConditionalBuilder
  build: () => unknown
  setColorScale: (config: unknown) => ConditionalBuilder
  whenNumberGreaterThan: (value: number) => ConditionalBuilder
  whenNumberGreaterThanOrEqualTo: (value: number) => ConditionalBuilder
  whenNumberLessThan: (value: number) => ConditionalBuilder
  whenNumberLessThanOrEqualTo: (value: number) => ConditionalBuilder
  whenNumberEqualTo: (value: number) => ConditionalBuilder
  whenNumberNotEqualTo: (value: number) => ConditionalBuilder
  whenNumberBetween: (first: number, second: number) => ConditionalBuilder
  whenNumberNotBetween: (first: number, second: number) => ConditionalBuilder
  whenTextContains: (value: string) => ConditionalBuilder
  whenTextDoesNotContain: (value: string) => ConditionalBuilder
  whenTextStartsWith: (value: string) => ConditionalBuilder
  whenTextEndsWith: (value: string) => ConditionalBuilder
  whenCellEmpty: () => ConditionalBuilder
  whenCellNotEmpty: () => ConditionalBuilder
  setDuplicateValues: () => ConditionalBuilder
  setUniqueValues: () => ConditionalBuilder
  setRank: (value: unknown) => ConditionalBuilder
  whenFormulaSatisfied: (value: string) => ConditionalBuilder
  setBackground: (value: string) => ConditionalBuilder
  setFontColor: (value: string) => ConditionalBuilder
  setBold: (value: boolean) => ConditionalBuilder
  setItalic: (value: boolean) => ConditionalBuilder
}

function filterStateForWorksheet(
  worksheet: unknown,
  sheetName: string,
  fallback: RangeBounds,
): SheetFilterState {
  const filter = (worksheet as { getFilter?: () => FilterFacade | null }).getFilter?.() ?? null
  if (!filter) return { sheetName, filter: null, hiddenRows: [], visibilityRange: fallback }
  const range = filter.getRange().getRange()
  const columns: NonNullable<SheetFilterState['filter']>['columns'] = []
  for (let column = range.startColumn; column <= range.endColumn; column += 1) {
    const criteria = filter.getColumnFilterCriteria(column) as {
      filters?: { filters?: unknown[]; blank?: boolean }
      customFilters?: { and?: boolean; customFilters?: Array<{ val?: unknown; operator?: string }> }
      colorFilters?: unknown
    } | null
    if (!criteria) continue
    if (criteria.colorFilters) throw new Error('颜色筛选暂不支持保存。')
    if (!criteria.filters && !criteria.customFilters) continue
    columns.push({
      colId: column - range.startColumn,
      ...(criteria.filters?.filters ? { values: criteria.filters.filters.map(String) } : {}),
      ...(criteria.filters?.blank ? { blank: true } : {}),
      ...(criteria.customFilters ? {
        customs: {
          ...(criteria.customFilters.and ? { and: true } : {}),
          filters: (criteria.customFilters.customFilters ?? []).map((custom) => ({
            val: typeof custom.val === 'number' ? custom.val : String(custom.val ?? ''),
            ...(custom.operator ? { operator: custom.operator } : {}),
          })),
        },
      } : {}),
    })
  }
  const area = {
    startRow: range.startRow,
    endRow: range.endRow,
    startColumn: range.startColumn,
    endColumn: range.endColumn,
  }
  return {
    sheetName,
    filter: { range: area, columns },
    hiddenRows: filter.getFilteredOutRows(),
    visibilityRange: area,
  }
}

function conditionalStateForWorksheet(worksheet: unknown, sheetName: string): SheetCfState {
  const rules = (worksheet as {
    getConditionalFormattingRules?: () => ConditionalRuleFacade[]
  }).getConditionalFormattingRules?.() ?? []
  return {
    sheetName,
    rules: rules.map((rule) => ({
      ranges: rule.ranges.map((range) => ({
        startRow: range.startRow,
        endRow: range.endRow,
        startColumn: range.startColumn,
        endColumn: range.endColumn,
      })),
      stopIfTrue: rule.stopIfTrue === true,
      rule: rule.rule,
    })),
  }
}

function applyConditionalFormat(
  worksheet: unknown,
  bounds: RangeBounds,
  rule: Record<string, unknown>,
): void {
  const sheet = worksheet as {
    newConditionalFormattingRule: () => ConditionalBuilder
    addConditionalFormattingRule: (rule: unknown) => void
  }
  const ranges = [bounds]
  const builder = sheet.newConditionalFormattingRule()
  if (rule.kind === 'colorScale') {
    const minColor = rule.minColor
    const maxColor = rule.maxColor
    if (typeof minColor !== 'string' || typeof maxColor !== 'string') {
      throw new Error('colorScale 必须包含 minColor 和 maxColor。')
    }
    const stops = [
      { index: 0, color: minColor, value: { type: 'min' } },
      ...(typeof rule.midColor === 'string'
        ? [{ index: 1, color: rule.midColor, value: { type: 'percentile', value: 50 } }]
        : []),
      { index: typeof rule.midColor === 'string' ? 2 : 1, color: maxColor, value: { type: 'max' } },
    ]
    sheet.addConditionalFormattingRule(builder.setColorScale(stops).setRanges(ranges).build())
    return
  }
  const kind = rule.kind
  let styled: ConditionalBuilder
  const operator = String(rule.operator ?? '')
  const value = Number(rule.value)
  const second = Number(rule.value2 ?? rule.value)
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw new Error('数字条件格式缺少有效 value。')
    const byOperator: Record<string, () => ConditionalBuilder> = {
      greaterThan: () => builder.whenNumberGreaterThan(value),
      greaterThanOrEqual: () => builder.whenNumberGreaterThanOrEqualTo(value),
      lessThan: () => builder.whenNumberLessThan(value),
      lessThanOrEqual: () => builder.whenNumberLessThanOrEqualTo(value),
      equal: () => builder.whenNumberEqualTo(value),
      notEqual: () => builder.whenNumberNotEqualTo(value),
      between: () => builder.whenNumberBetween(value, second),
      notBetween: () => builder.whenNumberNotBetween(value, second),
    }
    if (!byOperator[operator]) throw new Error(`不支持的数字条件格式运算符：${operator}`)
    styled = byOperator[operator]()
  } else if (kind === 'text') {
    if (typeof rule.text !== 'string' || rule.text.length === 0) throw new Error('文本条件格式缺少 text。')
    const byOperator: Record<string, () => ConditionalBuilder> = {
      contains: () => builder.whenTextContains(rule.text as string),
      notContains: () => builder.whenTextDoesNotContain(rule.text as string),
      beginsWith: () => builder.whenTextStartsWith(rule.text as string),
      endsWith: () => builder.whenTextEndsWith(rule.text as string),
    }
    if (!byOperator[operator]) throw new Error(`不支持的文本条件格式运算符：${operator}`)
    styled = byOperator[operator]()
  } else if (kind === 'blank') styled = rule.blank === true ? builder.whenCellEmpty() : builder.whenCellNotEmpty()
  else if (kind === 'duplicate') styled = rule.unique === true ? builder.setUniqueValues() : builder.setDuplicateValues()
  else if (kind === 'top10') styled = builder.setRank({ isBottom: rule.bottom === true, isPercent: rule.percent === true, value: Number(rule.rank) })
  else if (kind === 'formula' && typeof rule.formula === 'string') styled = builder.whenFormulaSatisfied(rule.formula)
  else throw new Error(`不支持的条件格式类型：${String(kind)}`)
  const format = isRecord(rule.format) ? rule.format : {}
  if (typeof format.fillColor === 'string') styled = styled.setBackground(format.fillColor)
  if (typeof format.fontColor === 'string') styled = styled.setFontColor(format.fontColor)
  if (format.bold === true) styled = styled.setBold(true)
  if (format.italic === true) styled = styled.setItalic(true)
  sheet.addConditionalFormattingRule(styled.setRanges(ranges).build())
}

function styleForSave(style: SheetStyle): NonNullable<CellEdit['style']> {
  return {
    ...(style.bold == null ? {} : { bold: style.bold }),
    ...(style.italic == null ? {} : { italic: style.italic }),
    ...(style.color === undefined ? {} : { fontColor: style.color }),
    ...(style.backgroundColor === undefined ? {} : { fillColor: style.backgroundColor }),
    ...(style.numberFormat == null ? {} : { numberFormat: style.numberFormat }),
    ...(style.horizontalAlign == null ? {} : { horizontalAlignment: style.horizontalAlign }),
    ...(style.verticalAlign == null ? {} : { verticalAlignment: style.verticalAlign }),
    ...Object.fromEntries([
      'fontFamily', 'fontSize', 'underline', 'strikethrough', 'wrapText',
      'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
    ].filter((key) => (style as unknown as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, (style as unknown as Record<string, unknown>)[key]])),
  }
}

function applyStyle(range: ReturnType<NonNullable<ReturnType<typeof worksheetByName>>['getRange']>, style: SheetStyle | EngineStyle): void {
  if (style.bold !== undefined) range.setFontWeight(style.bold ? 'bold' : null)
  if (style.italic !== undefined) range.setFontStyle(style.italic ? 'italic' : null)
  const editorStyle = style as SheetStyle
  const engineStyle = style as EngineStyle
  const fontColor = editorStyle.color !== undefined ? editorStyle.color : engineStyle.fontColor
  const fillColor = editorStyle.backgroundColor !== undefined ? editorStyle.backgroundColor : engineStyle.fillColor
  const horizontal = editorStyle.horizontalAlign !== undefined ? editorStyle.horizontalAlign : engineStyle.horizontalAlignment
  if (style.fontFamily !== undefined) range.setFontFamily(style.fontFamily)
  if (style.fontSize !== undefined) range.setFontSize(style.fontSize)
  if (style.underline !== undefined) range.setFontLine(style.underline ? 'underline' : null)
  if (style.wrapText !== undefined) range.setWrap(style.wrapText)
  const vertical = editorStyle.verticalAlign ?? engineStyle.verticalAlignment
  if (vertical === 'top' || vertical === 'center' || vertical === 'bottom') {
    range.setVerticalAlignment(vertical === 'center' ? 'middle' : vertical)
  }
  const extraStyle = fromNeutralStyle(styleForSave(editorStyle) as Parameters<typeof fromNeutralStyle>[0])
  const patch = Object.fromEntries(['bd', 'st'].filter((key) => key in extraStyle).map((key) => [key, extraStyle[key]]))
  if (Object.keys(patch).length) range.setValue({ s: patch } as ICellData)
  if (fontColor) range.setFontColor(fontColor)
  if (fillColor) range.setBackground(fillColor)
  if (style.numberFormat) range.setNumberFormat(style.numberFormat)
  if (horizontal === 'left' || horizontal === 'center') {
    range.setHorizontalAlignment(horizontal)
  } else if (horizontal === 'right') {
    range.setValue({ s: { ht: HorizontalAlign.RIGHT } } as ICellData)
  }
}

function toAddress(bounds: RangeBounds): string {
  const start = formatAddress(bounds.startRow, bounds.startColumn)
  const end = formatAddress(bounds.endRow, bounds.endColumn)
  return start === end ? start : `${start}:${end}`
}

function currentStyleForSave(
  range: ReturnType<NonNullable<ReturnType<typeof worksheetByName>>['getRange']>,
): NonNullable<CellEdit['style']> {
  const style = range.getCellStyleData() ?? {}
  return toNeutralStyle(style as unknown as Record<string, unknown>) ?? {}
}

function MonaSheetsEditor(): React.JSX.Element {
  const bridgeRef = useRef<MonaOfficeBridge | null>(null)
  if (bridgeRef.current === null) bridgeRef.current = new MonaOfficeBridge('sheets')
  const runtimeRef = useRef<UniverRuntime | null>(null)
  const embeddedApiRef = useRef<EmbeddedSheetsApi | null>(null)
  const apiWaitersRef = useRef<Array<(api: EmbeddedSheetsApi) => void>>([])
  const sessionRef = useRef<OfficeOpenMessage | null>(null)
  const workbookRef = useRef<EngineWorkbook | null>(null)
  const versionRef = useRef<DocumentVersion | null>(null)
  const sourceRef = useRef<ArrayBuffer | null>(null)
  const editsRef = useRef(new Map<string, CellEdit>())
  const structuralOpsRef = useRef(new Map<string, StructuralOp[]>())
  const sheetPlanRef = useRef<SheetEditPlan | undefined>(undefined)
  const filterStatesRef = useRef(new Map<string, SheetFilterState>())
  const cfStatesRef = useRef(new Map<string, SheetCfState>())
  const pageSetupStatesRef = useRef(new Map<string, SheetPageSetupState>())
  const revisionSnapshotsRef = useRef(new Map<number, SheetRevisionSnapshot>())
  const originalSheetsRef = useRef(new Map<string, EngineSheet>())
  const removedSheetsRef = useRef(new Map<string, RemovedSheetState>())
  const recentChangedTargetsRef = useRef<string[]>([])
  const operationCacheRef = useRef(new Map<string, CachedOperation>())
  const suppressEventsRef = useRef(false)
  const agentApplyingRef = useRef(false)
  const changeQueuedRef = useRef(false)
  const pendingUserRangesRef = useRef(new Map<string, RangeBounds[]>())
  const pendingUserTargetsRef = useRef(new Set<string>())
  const [status, setStatus] = useState('等待 Mona 打开表格…')
  const [error, setError] = useState<string | null>(null)
  const [followPaused, setFollowPaused] = useState(false)

  const embeddedController = useMemo<EmbeddedSheetsController>(() => ({
    attach: (api) => {
      embeddedApiRef.current = api
      runtimeRef.current = api.runtime
      for (const resolve of apiWaitersRef.current.splice(0)) resolve(api)
      return () => {
        if (embeddedApiRef.current === api) {
          embeddedApiRef.current = null
          runtimeRef.current = null
        }
      }
    },
    save: async () => {
      const version = versionRef.current
      if (version) await checkpoint(version)
    },
  }), [])

  function waitForApi(): Promise<EmbeddedSheetsApi> {
    if (embeddedApiRef.current) return Promise.resolve(embeddedApiRef.current)
    return new Promise((resolve) => apiWaitersRef.current.push(resolve))
  }

  embeddedReadWorkbookRange = async (request) => {
    const result = parseEngineRange(await bridgeRef.current!.engineReadRange({
      sheetId: request.sheetId,
      range: request.range,
    }))
    return embeddedRangeResult(result)
  }

  function rememberRevision(revision: number): void {
    revisionSnapshotsRef.current.set(revision, structuredClone({
      edits: [...editsRef.current.values()],
      structuralOps: [...structuralOpsRef.current].map(([sheetName, ops]) => ({
        sheetName: persistenceSheetName(sheetName),
        ops,
      })),
      ...(sheetPlanRef.current ? { sheetPlan: sheetPlanRef.current } : {}),
      filterStates: [...filterStatesRef.current.values()],
      cfStates: [...cfStatesRef.current.values()],
      pageSetupStates: [...pageSetupStatesRef.current.values()],
    }))
    while (revisionSnapshotsRef.current.size > 32) {
      const oldest = revisionSnapshotsRef.current.keys().next().value
      if (oldest === undefined) break
      revisionSnapshotsRef.current.delete(oldest)
    }
  }

  function nextVersion(): DocumentVersion {
    const current = versionRef.current
    if (!current) throw new Error('编辑器尚未打开。')
    const next = { ...current, modelRevision: current.modelRevision + 1 }
    versionRef.current = next
    rememberRevision(next.modelRevision)
    return next
  }

  function persistenceSheetName(liveName: string): string {
    const sheet = workbookRef.current?.sheets.find((candidate) => candidate.name === liveName)
    return sheet?.originalName ?? liveName
  }

  function recordRangeEdits(
    sheetName: string,
    bounds: RangeBounds,
    style?: SheetStyle,
    captureCurrentStyle = false,
  ): void {
    const runtime = runtimeRef.current
    const worksheet = runtime ? worksheetByName(runtime, sheetName) : undefined
    if (!worksheet) throw new Error(`找不到工作表：${sheetName}`)
    const range = worksheet.getRange(
      bounds.startRow,
      bounds.startColumn,
      bounds.endRow - bounds.startRow + 1,
      bounds.endColumn - bounds.startColumn + 1,
    )
    const values = range.getValues()
    const formulas = range.getFormulas()
    const savedStyle = style ? styleForSave(style) : undefined
    for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
      for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
        const rowOffset = row - bounds.startRow
        const columnOffset = column - bounds.startColumn
        const key = `${sheetName}!${row}:${column}`
        const existing = editsRef.current.get(key)
        const formula = formulas[rowOffset]?.[columnOffset] || undefined
        const currentStyle = captureCurrentStyle
          ? currentStyleForSave(worksheet.getRange(row, column, 1, 1))
          : undefined
        editsRef.current.set(key, {
          sheetName: persistenceSheetName(sheetName),
          row,
          column,
          writeValue: style === undefined || existing?.writeValue === true,
          cell: {
            value: normalizeCellValue(values[rowOffset]?.[columnOffset]),
            ...(formula ? { formula } : {}),
          },
          ...((savedStyle || currentStyle || existing?.style)
            ? { style: { ...existing?.style, ...currentStyle, ...savedStyle } }
            : {}),
        })
      }
    }
  }

  function captureUserRange(sheetName: string, bounds: RangeBounds): void {
    const columnCount = bounds.endColumn - bounds.startColumn + 1
    const rowsPerChunk = Math.max(1, Math.floor(20_000 / columnCount))
    for (let startRow = bounds.startRow; startRow <= bounds.endRow; startRow += rowsPerChunk) {
      recordRangeEdits(sheetName, {
        ...bounds,
        startRow,
        endRow: Math.min(bounds.endRow, startRow + rowsPerChunk - 1),
      }, undefined, true)
    }
  }

  function flushUserChange(): void {
    changeQueuedRef.current = false
    const session = sessionRef.current
    if (!session || suppressEventsRef.current) return
    const changedTargets = [...pendingUserTargetsRef.current]
    for (const [sheetName, ranges] of pendingUserRangesRef.current) {
      for (const bounds of ranges) captureUserRange(sheetName, bounds)
    }
    pendingUserRangesRef.current.clear()
    pendingUserTargetsRef.current.clear()
    if (changedTargets.length === 0) return
    const version = nextVersion()
    recentChangedTargetsRef.current = changedTargets
    bridgeRef.current?.post({
      type: 'office_user_change',
      sessionId: session.sessionId,
      version,
      changedTargets,
    })
  }

  function queueUserChange(target: string, sheetName?: string, bounds?: RangeBounds): void {
    pendingUserTargetsRef.current.add(target)
    if (sheetName && bounds) {
      const ranges = pendingUserRangesRef.current.get(sheetName) ?? []
      ranges.push(bounds)
      pendingUserRangesRef.current.set(sheetName, ranges)
    }
    if (suppressEventsRef.current || changeQueuedRef.current) return
    changeQueuedRef.current = true
    queueMicrotask(flushUserChange)
  }

  async function loadRange(sheet: EngineSheet, bounds: RangeBounds, preserveEdits: boolean): Promise<void> {
    const runtime = runtimeRef.current
    if (!runtime) throw new Error('表格运行时尚未准备好。')
    if (!sheet.originalName) return
    const structuralOps = structuralOpsRef.current.get(sheet.name) ?? []
    const fileBounds = screenRangeToFileRange(structuralOps, bounds)
    if (!fileBounds) return
    const result = parseEngineRange(await bridgeRef.current!.engineReadRange({ sheetId: sheet.id, range: fileBounds }))
    const worksheet = worksheetByName(runtime, sheet.name)
    if (!worksheet) throw new Error(`找不到工作表：${sheet.name}`)
    suppressEventsRef.current = true
    try {
      for (const cell of result.cells) {
        const row = fileToScreen(structuralOps, 'row', cell.row)
        const column = fileToScreen(structuralOps, 'column', cell.column)
        if (row === null || column === null
          || row < bounds.startRow || row > bounds.endRow
          || column < bounds.startColumn || column > bounds.endColumn) continue
        if (preserveEdits && editsRef.current.has(`${sheet.name}!${row}:${column}`)) continue
        const target = worksheet.getRange(row, column, 1, 1)
        if (cell.formula) target.setFormula(cell.formula)
        else if (cell.value === null) target.clearContent()
        else target.setValue(cell.value)
        const style = cell.styleIndex === undefined ? undefined : workbookRef.current?.styles[cell.styleIndex]
        if (style) applyStyle(target, style)
      }
    } finally {
      suppressEventsRef.current = false
    }
  }

  async function openWorkbook(message: OfficeOpenMessage): Promise<void> {
    if (message.documentType !== 'sheets' || !isVersion(message.version)) {
      throw new Error('当前入口不能打开这个文档。')
    }
    setStatus('正在打开表格…')
    setError(null)
    setFollowPaused(false)
    sessionRef.current = message
    versionRef.current = message.version
    sourceRef.current = message.file
    editsRef.current.clear()
    structuralOpsRef.current.clear()
    sheetPlanRef.current = undefined
    filterStatesRef.current.clear()
    cfStatesRef.current.clear()
    pageSetupStatesRef.current.clear()
    revisionSnapshotsRef.current.clear()
    originalSheetsRef.current.clear()
    removedSheetsRef.current.clear()
    pendingUserRangesRef.current.clear()
    pendingUserTargetsRef.current.clear()
    recentChangedTargetsRef.current = []
    rememberRevision(message.version.modelRevision)
    const workbook = parseWorkbook(await bridgeRef.current!.engineOpen())
    workbook.sheets = workbook.sheets.map((sheet) => ({ ...sheet, originalName: sheet.name }))
    workbookRef.current = workbook
    originalSheetsRef.current = new Map(workbook.sheets.map((sheet) => [sheet.id, structuredClone(sheet)]))
    const api = await waitForApi()
    api.open(await embeddedWorkbookFile(message, workbook))
    const runtime = api.runtime
    runtimeRef.current = runtime
    suppressEventsRef.current = true
    suppressEventsRef.current = false
    for (const sheet of workbook.sheets) {
      const columns = Math.max(1, Math.min(sheet.columnCount, 50))
      const rows = Math.max(1, Math.min(sheet.rowCount, Math.floor(20_000 / columns), 200))
      await loadRange(sheet, {
        startRow: 0,
        endRow: rows - 1,
        startColumn: 0,
        endColumn: columns - 1,
      }, false)
    }
    runtime.univerAPI.addEvent(runtime.univerAPI.Event.CommandExecuted, (rawEvent) => {
      const event = rawEvent as unknown as UniverCommandEvent
      if (suppressEventsRef.current || event.options?.fromFormula) return
      const params = event.params
      if (!params || params.unitId !== runtime.univerAPI.getActiveWorkbook()?.getId()) return
      const metadata = workbookRef.current
      const activeWorkbook = runtime.univerAPI.getActiveWorkbook()
      if (!metadata || !activeWorkbook) return
      if (event.id === SET_FROZEN_MUTATION && params.subUnitId) {
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        const freeze = params as unknown as { ySplit?: number; xSplit?: number }
        if (!sheet) return
        pageSetupStatesRef.current.set(sheet.name, {
          sheetName: sheet.name,
          frozenRows: Math.max(0, freeze.ySplit ?? 0),
          frozenColumns: Math.max(0, freeze.xSplit ?? 0),
        })
        queueUserChange(`${sheet.name}:freeze`)
        return
      }
      if (FILTER_MUTATIONS.has(event.id) && params.subUnitId) {
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        const worksheet = sheet ? worksheetByName(runtime, sheet.name) : undefined
        if (!sheet || !worksheet) return
        filterStatesRef.current.set(sheet.name, filterStateForWorksheet(worksheet, sheet.name, {
          startRow: 0,
          endRow: Math.max(0, sheet.rowCount - 1),
          startColumn: 0,
          endColumn: Math.max(0, sheet.columnCount - 1),
        }))
        queueUserChange(`${sheet.name}:filter`)
        return
      }
      if (CF_MUTATIONS.has(event.id) && params.subUnitId) {
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        const worksheet = sheet ? worksheetByName(runtime, sheet.name) : undefined
        if (!sheet || !worksheet) return
        cfStatesRef.current.set(sheet.name, conditionalStateForWorksheet(worksheet, sheet.name))
        queueUserChange(`${sheet.name}:conditional-format`)
        return
      }
      if ((event.id === 'sheet.mutation.set-worksheet-col-width'
        || event.id === 'sheet.mutation.set-worksheet-row-height') && params.subUnitId) {
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        if (!sheet) return
        const columns = event.id.endsWith('col-width')
        const sizes = columns ? params.colWidth : params.rowHeight
        for (const value of params.ranges ?? []) {
          const bounds = rangeBounds(value)
          if (!bounds) continue
          const start = columns ? bounds.startColumn : bounds.startRow
          const end = columns ? bounds.endColumn : bounds.endRow
          for (let index = start; index <= end; index++) {
            const pixels = typeof sizes === 'number' ? sizes : sizes?.[String(index)]
            if (typeof pixels !== 'number' || !Number.isFinite(pixels)) continue
            recordStructural(sheet.name, {
              kind: columns ? 'set-col-size' : 'set-row-size', start: index, end: index,
              size: columns ? pixelsToCharacterWidth(pixels) : pixels * 72 / 96,
            })
          }
          queueUserChange(`${sheet.name}!${toAddress(bounds)}`)
        }
        return
      }
      const rowColumn = ROW_COLUMN_MUTATIONS[event.id]
      const merge = MERGE_MUTATIONS[event.id]
      if (rowColumn && params.subUnitId) {
        const bounds = rangeBounds(params.range)
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        if (!bounds || !sheet) return
        const index = rowColumn.axis === 'row' ? bounds.startRow : bounds.startColumn
        const count = rowColumn.axis === 'row'
          ? bounds.endRow - bounds.startRow + 1
          : bounds.endColumn - bounds.startColumn + 1
        const structural = { kind: rowColumn.kind, index, count } as StructuralOp
        shiftRecordedEdits(sheet.name, structural)
        recordStructural(sheet.name, structural)
        if (rowColumn.axis === 'row') {
          sheet.rowCount = Math.max(0, sheet.rowCount + (rowColumn.kind === 'insert-rows' ? count : -count))
        } else {
          sheet.columnCount = Math.max(0, sheet.columnCount + (rowColumn.kind === 'insert-cols' ? count : -count))
        }
        queueUserChange(`${sheet.name}!${rowColumn.kind}:${index + 1}:${count}`)
        return
      }
      if (merge && params.subUnitId) {
        const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
        if (!sheet) return
        for (const value of params.ranges ?? []) {
          const bounds = rangeBounds(value)
          if (!bounds) continue
          recordStructural(sheet.name, { kind: merge, range: bounds } as StructuralOp)
          queueUserChange(`${sheet.name}!${toAddress(bounds)}`)
        }
        return
      }
      if (SHEET_LIFECYCLE_MUTATIONS.has(event.id)) {
        const plan = currentSheetPlan()
        if (event.id === 'sheet.mutation.insert-sheet') {
          const id = params.sheet?.id
          const name = params.sheet?.name
          if (!id || !name) return
          const removed = removedSheetsRef.current.get(id)
          const original = originalSheetsRef.current.get(id)
          const restored = removed?.sheet ?? original
          const sheet: EngineSheet = restored
            ? { ...restored, name }
            : {
                id,
                name,
                rowCount: params.sheet?.rowCount ?? 1000,
                columnCount: params.sheet?.columnCount ?? 26,
                hidden: false,
                showGridLines: true,
              }
          metadata.sheets.push(sheet)
          if (removed) {
            for (const edit of removed.edits) editsRef.current.set(`${sheet.name}!${edit.row}:${edit.column}`, edit)
            if (removed.structuralOps.length > 0) structuralOpsRef.current.set(sheet.name, removed.structuralOps)
            removedSheetsRef.current.delete(id)
          }
          if (sheet.originalName) {
            plan.removals = plan.removals.filter((candidate) => candidate !== sheet.originalName)
          } else if (!plan.additions.some((candidate) => candidate.name === name)) {
            plan.additions.push({ name })
          }
        } else if (event.id === 'sheet.mutation.remove-sheet' && params.subUnitId) {
          const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
          if (!sheet) return
          removedSheetsRef.current.set(sheet.id, {
            sheet: structuredClone(sheet),
            edits: [...editsRef.current.entries()]
              .filter(([key]) => key.startsWith(`${sheet.name}!`))
              .map(([, edit]) => edit),
            structuralOps: structuredClone(structuralOpsRef.current.get(sheet.name) ?? []),
          })
          metadata.sheets = metadata.sheets.filter((candidate) => candidate !== sheet)
          for (const key of editsRef.current.keys()) {
            if (key.startsWith(`${sheet.name}!`)) editsRef.current.delete(key)
          }
          structuralOpsRef.current.delete(sheet.name)
          if (sheet.originalName) {
            if (!plan.removals.includes(sheet.originalName)) plan.removals.push(sheet.originalName)
            plan.renames = plan.renames.filter((rename) => rename.sheetName !== sheet.originalName)
          } else {
            plan.additions = plan.additions.filter((addition) => addition.name !== sheet.name)
          }
        } else if (event.id === 'sheet.mutation.set-worksheet-name' && params.subUnitId && params.name) {
          const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
          if (!sheet) return
          const previousName = sheet.name
          const nextName = params.name
          if (sheet.originalName) {
            plan.renames = plan.renames.filter((rename) => rename.sheetName !== sheet.originalName)
            if (sheet.originalName !== nextName) plan.renames.push({ sheetName: sheet.originalName, newName: nextName })
          } else {
            const addition = plan.additions.find((candidate) => candidate.name === previousName)
            if (addition) addition.name = nextName
          }
          editsRef.current = new Map([...editsRef.current.entries()].map(([key, edit]) => {
            if (!key.startsWith(`${previousName}!`)) return [key, edit]
            const nextEdit = sheet.originalName ? edit : { ...edit, sheetName: nextName }
            return [`${nextName}!${edit.row}:${edit.column}`, nextEdit]
          }))
          const structural = structuralOpsRef.current.get(previousName)
          if (structural) {
            structuralOpsRef.current.delete(previousName)
            structuralOpsRef.current.set(nextName, structural)
          }
          sheet.name = nextName
        }
        const liveOrder = activeWorkbook.getSheets().map((sheet) => sheet.getSheetName())
        metadata.sheets.sort((left, right) => liveOrder.indexOf(left.name) - liveOrder.indexOf(right.name))
        plan.order = liveOrder
        plan.orderChanged = true
        queueUserChange(`workbook:${event.id}`)
        return
      }
      if (!params.subUnitId) return
      const sheet = metadata.sheets.find((candidate) => candidate.id === params.subUnitId)
      if (!sheet) return
      const ranges: RangeBounds[] = []
      if (event.id === 'sheet.mutation.set-range-values') {
        const bounds = cellValueBounds(params.cellValue)
        if (bounds) ranges.push(bounds)
      } else if (event.id === 'sheet.mutation.set.numfmt') {
        for (const entry of Object.values(params.values ?? {})) {
          for (const value of entry.ranges ?? []) {
            const bounds = rangeBounds(value)
            if (bounds) ranges.push(bounds)
          }
        }
      } else if (event.id === 'sheet.mutation.remove.numfmt') {
        for (const value of params.ranges ?? []) {
          const bounds = rangeBounds(value)
          if (bounds) ranges.push(bounds)
        }
      }
      for (const bounds of ranges) {
        queueUserChange(`${sheet.name}!${toAddress(bounds)}`, sheet.name, bounds)
      }
    })
    setStatus('')
    bridgeRef.current!.post({
      type: 'office_editor_ready',
      sessionId: message.sessionId,
      version: message.version,
    })
  }

  function commandFailure(command: ApplyCommand, code: string, message: string): unknown {
    return {
      ok: false,
      sessionId: command.sessionId,
      operationId: command.operationId,
      currentVersion: versionRef.current,
      changedTargets: code === 'VERSION_CONFLICT' ? recentChangedTargetsRef.current : [],
      error: { code, message, retryable: code === 'VERSION_CONFLICT' },
    }
  }

  function operationTarget(operation: SheetOperation): { sheetName: string; bounds: RangeBounds } {
    if (!['set_cell', 'set_range', 'set_formula', 'clear_range', 'set_style'].includes(operation.op)) {
      throw new Error('当前操作不是单元格操作。')
    }
    const payload = operation.payload as { sheet: string; range?: string; cell?: string }
    const range = payload.range ?? payload.cell
    if (!range) throw new Error('单元格操作缺少目标范围。')
    const bounds = parseRange(range.toUpperCase())
    if (rangeCellCount(bounds) > 20_000) throw new Error('单次操作不能超过 20000 个单元格。')
    return { sheetName: payload.sheet, bounds }
  }

  function currentSheetPlan(): SheetEditPlan {
    if (!sheetPlanRef.current) {
      sheetPlanRef.current = {
        renames: [],
        additions: [],
        removals: [],
        order: workbookRef.current?.sheets.map((sheet) => sheet.name) ?? [],
      }
    }
    return sheetPlanRef.current
  }

  function recordStructural(sheetName: string, operation: StructuralOp): void {
    const current = structuralOpsRef.current.get(sheetName) ?? []
    structuralOpsRef.current.set(sheetName, [...current, operation])
  }

  function shiftRecordedEdits(sheetName: string, operation: StructuralOp): void {
    if (!('index' in operation)) return
    const persistedName = persistenceSheetName(sheetName)
    const next = new Map<string, CellEdit>()
    for (const edit of editsRef.current.values()) {
      if (edit.sheetName !== persistedName) {
        const liveName = workbookRef.current?.sheets.find((sheet) => (
          (sheet.originalName ?? sheet.name) === edit.sheetName
        ))?.name ?? edit.sheetName
        next.set(`${liveName}!${edit.row}:${edit.column}`, edit)
        continue
      }
      let row = edit.row
      let column = edit.column
      const coordinate = operation.kind.endsWith('rows') ? row : column
      if (operation.kind.startsWith('insert')) {
        if (coordinate >= operation.index) {
          if (operation.kind.endsWith('rows')) row += operation.count
          else column += operation.count
        }
      } else if (coordinate >= operation.index && coordinate < operation.index + operation.count) {
        continue
      } else if (coordinate >= operation.index + operation.count) {
        if (operation.kind.endsWith('rows')) row -= operation.count
        else column -= operation.count
      }
      const shifted = { ...edit, row, column }
      next.set(`${sheetName}!${row}:${column}`, shifted)
    }
    editsRef.current = next
  }

  function applyStructuralOperation(operation: SheetOperation): string {
    const runtime = runtimeRef.current
    const metadata = workbookRef.current
    const workbook = runtime?.univerAPI.getActiveWorkbook()
    if (!runtime || !metadata || !workbook) throw new Error('表格运行时尚未准备好。')
    if (operation.op === 'set_auto_filter') {
      const sheet = metadata.sheets.find((candidate) => candidate.name === operation.payload.sheet)
      const worksheet = worksheetByName(runtime, operation.payload.sheet)
      if (!sheet || !worksheet) throw new Error(`找不到工作表：${operation.payload.sheet}`)
      const fallback = {
        startRow: 0,
        endRow: Math.max(0, sheet.rowCount - 1),
        startColumn: 0,
        endColumn: Math.max(0, sheet.columnCount - 1),
      }
      const previous = filterStateForWorksheet(worksheet, sheet.name, fallback)
      const current = (worksheet as unknown as {
        getFilter?: () => { remove: () => void } | null
      }).getFilter?.()
      current?.remove()
      if (operation.payload.range !== null) {
        const bounds = parseRange(operation.payload.range.toUpperCase())
        worksheet.getRange(
          bounds.startRow,
          bounds.startColumn,
          bounds.endRow - bounds.startRow + 1,
          bounds.endColumn - bounds.startColumn + 1,
        ).createFilter()
        filterStatesRef.current.set(sheet.name, filterStateForWorksheet(worksheet, sheet.name, bounds))
      } else {
        filterStatesRef.current.set(sheet.name, {
          sheetName: sheet.name,
          filter: null,
          hiddenRows: [],
          visibilityRange: previous.visibilityRange,
        })
      }
      return `${sheet.name}:filter`
    }
    if (operation.op === 'set_freeze_panes') {
      const sheet = metadata.sheets.find((candidate) => candidate.name === operation.payload.sheet)
      const worksheet = worksheetByName(runtime, operation.payload.sheet)
      if (!sheet || !worksheet) throw new Error(`找不到工作表：${operation.payload.sheet}`)
      const { rows, columns } = operation.payload
      if (!Number.isInteger(rows) || rows < 0 || rows > 100 || !Number.isInteger(columns) || columns < 0 || columns > 100) {
        throw new Error('冻结窗格的 rows/columns 必须是 0–100 的整数。')
      }
      const target = worksheet as unknown as {
        cancelFreeze?: () => void
        setFreeze?: (value: { startRow: number; startColumn: number; xSplit: number; ySplit: number }) => void
      }
      if (rows === 0 && columns === 0) target.cancelFreeze?.()
      else target.setFreeze?.({
        startRow: rows > 0 ? rows : -1,
        startColumn: columns > 0 ? columns : -1,
        xSplit: columns,
        ySplit: rows,
      })
      pageSetupStatesRef.current.set(sheet.name, {
        sheetName: sheet.name,
        frozenRows: rows,
        frozenColumns: columns,
      })
      return `${sheet.name}:freeze:${rows}:${columns}`
    }
    if (operation.op === 'set_conditional_format') {
      const sheet = metadata.sheets.find((candidate) => candidate.name === operation.payload.sheet)
      const worksheet = worksheetByName(runtime, operation.payload.sheet)
      if (!sheet || !worksheet) throw new Error(`找不到工作表：${operation.payload.sheet}`)
      const bounds = parseRange(operation.payload.range.toUpperCase())
      applyConditionalFormat(worksheet, bounds, operation.payload.rule)
      cfStatesRef.current.set(sheet.name, conditionalStateForWorksheet(worksheet, sheet.name))
      return `${sheet.name}!${operation.payload.range}:conditional-format`
    }
    if (operation.op === 'set_column_width' || operation.op === 'set_row_height') {
      const { sheet, index, count, size } = operation.payload
      const columns = operation.op === 'set_column_width'
      if (!Number.isInteger(index) || index < 1 || !Number.isInteger(count) || count < 1 || count > 10_000
        || !Number.isFinite(size) || size <= 0 || size > (columns ? 255 : 409.5)) {
        throw new Error('行列尺寸的 index/count/size 无效。')
      }
      const worksheet = worksheetByName(runtime, sheet)
      if (!worksheet) throw new Error(`找不到工作表：${sheet}`)
      const limit = columns ? worksheet.getMaxColumns() : worksheet.getMaxRows()
      if (index - 1 + count > limit) throw new Error('行列尺寸目标超出工作表范围。')
      if (columns) {
        const mdw = getWorkbookMdw()
        worksheet.setColumnWidths(index - 1, count, Math.floor(((256 * size + Math.floor(128 / mdw)) / 256) * mdw) + 5)
      }
      else worksheet.setRowHeightsForced(index - 1, count, Math.round(size * 96 / 72))
      recordStructural(sheet, { kind: columns ? 'set-col-size' : 'set-row-size', start: index - 1, end: index + count - 2, size })
      return `${sheet}:${columns ? 'columns' : 'rows'}:${index}-${index + count - 1}`
    }
    if (operation.op === 'insert_rows' || operation.op === 'delete_rows'
      || operation.op === 'insert_columns' || operation.op === 'delete_columns') {
      const { sheet, index, count } = operation.payload
      const worksheet = worksheetByName(runtime, sheet)
      if (!worksheet) throw new Error(`找不到工作表：${sheet}`)
      const at = index - 1
      const kind = operation.op === 'insert_rows'
        ? 'insert-rows'
        : operation.op === 'delete_rows'
          ? 'remove-rows'
          : operation.op === 'insert_columns'
            ? 'insert-cols'
            : 'remove-cols'
      const structural = { kind, index: at, count } as StructuralOp
      if (operation.op === 'insert_rows') worksheet.insertRowsBefore(at, count)
      else if (operation.op === 'delete_rows') worksheet.deleteRows(at, count)
      else if (operation.op === 'insert_columns') worksheet.insertColumnsBefore(at, count)
      else worksheet.deleteColumns(at, count)
      shiftRecordedEdits(sheet, structural)
      recordStructural(sheet, structural)
      return `${sheet}!${operation.op}:${index}:${count}`
    }
    if (operation.op === 'merge_cells' || operation.op === 'unmerge_cells') {
      const worksheet = worksheetByName(runtime, operation.payload.sheet)
      if (!worksheet) throw new Error(`找不到工作表：${operation.payload.sheet}`)
      const bounds = parseRange(operation.payload.range.toUpperCase())
      const range = worksheet.getRange(
        bounds.startRow,
        bounds.startColumn,
        bounds.endRow - bounds.startRow + 1,
        bounds.endColumn - bounds.startColumn + 1,
      )
      if (operation.op === 'merge_cells') range.merge()
      else range.breakApart()
      recordStructural(operation.payload.sheet, {
        kind: operation.op === 'merge_cells' ? 'merge-cells' : 'unmerge-cells',
        range: bounds,
      })
      return `${operation.payload.sheet}!${operation.payload.range}`
    }
    if (operation.op === 'add_sheet') {
      const name = operation.payload.name.trim()
      workbook.insertSheet(name)
      const worksheet = workbook.getSheets().find((sheet) => sheet.getSheetName() === name)
      if (!worksheet) throw new Error('工作表创建失败。')
      metadata.sheets.push({
        id: worksheet.getSheetId(),
        name,
        rowCount: 1000,
        columnCount: 26,
        hidden: false,
        showGridLines: true,
      })
      const plan = currentSheetPlan()
      plan.additions.push({ name })
      plan.order = metadata.sheets.map((sheet) => sheet.name)
      return `sheet:${name}`
    }
    const sheetName = operation.payload.sheet
    const sheet = metadata.sheets.find((candidate) => candidate.name === sheetName)
    const worksheet = worksheetByName(runtime, sheetName)
    if (!sheet || !worksheet) throw new Error(`找不到工作表：${sheetName}`)
    const plan = currentSheetPlan()
    if (operation.op === 'delete_sheet') {
      if (metadata.sheets.length <= 1) throw new Error('工作簿至少需要保留一个工作表。')
      workbook.deleteSheet(worksheet.getSheetId())
      metadata.sheets = metadata.sheets.filter((candidate) => candidate !== sheet)
      if (sheet.originalName) {
        if (!plan.removals.includes(sheet.originalName)) plan.removals.push(sheet.originalName)
        plan.renames = plan.renames.filter((rename) => rename.sheetName !== sheet.originalName)
      } else {
        plan.additions = plan.additions.filter((addition) => addition.name !== sheet.name)
      }
      for (const key of editsRef.current.keys()) {
        if (key.startsWith(`${sheetName}!`)) editsRef.current.delete(key)
      }
      structuralOpsRef.current.delete(sheetName)
      plan.order = metadata.sheets.map((candidate) => candidate.name)
      return `sheet:${sheetName}`
    }
    if (operation.op === 'rename_sheet') {
      const nextName = operation.payload.newName.trim()
      worksheet.setName(nextName)
      if (sheet.originalName) {
        plan.renames = plan.renames.filter((rename) => rename.sheetName !== sheet.originalName)
        if (sheet.originalName !== nextName) {
          plan.renames.push({ sheetName: sheet.originalName, newName: nextName })
        }
      } else {
        const addition = plan.additions.find((candidate) => candidate.name === sheetName)
        if (addition) addition.name = nextName
      }
      editsRef.current = new Map([...editsRef.current.entries()].map(([key, edit]) => {
        if (!key.startsWith(`${sheetName}!`)) return [key, edit]
        const nextEdit = sheet.originalName ? edit : { ...edit, sheetName: nextName }
        return [`${nextName}!${edit.row}:${edit.column}`, nextEdit]
      }))
      const structural = structuralOpsRef.current.get(sheetName)
      if (structural) {
        structuralOpsRef.current.delete(sheetName)
        structuralOpsRef.current.set(nextName, structural)
      }
      sheet.name = nextName
      plan.order = metadata.sheets.map((candidate) => candidate.name)
      return `sheet:${nextName}`
    }
    if (operation.op === 'move_sheet') {
      const position = operation.payload.position - 1
      workbook.moveSheet(worksheet, position)
      metadata.sheets = metadata.sheets.filter((candidate) => candidate !== sheet)
      metadata.sheets.splice(position, 0, sheet)
      plan.order = metadata.sheets.map((candidate) => candidate.name)
      plan.orderChanged = true
      return `sheet:${sheetName}`
    }
    throw new Error('不支持的工作表结构操作。')
  }

  function snapshotRanges(targets: Array<{ sheetName: string; bounds: RangeBounds }>): RangeSnapshot[] {
    const runtime = runtimeRef.current
    if (!runtime) throw new Error('编辑器尚未准备好。')
    return targets.map(({ sheetName, bounds }) => {
      const worksheet = worksheetByName(runtime, sheetName)
      if (!worksheet) throw new Error(`找不到工作表：${sheetName}`)
      const cells: ICellData[][] = []
      for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
        const outputRow: ICellData[] = []
        for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
          const cell = worksheet.getRange(row, column, 1, 1)
          const formula = cell.getFormulas()[0]?.[0]
          outputRow.push({
            v: normalizeCellValue(cell.getValues()[0]?.[0]),
            ...(formula ? { f: formula } : {}),
            s: cell.getCellStyleData() ?? null,
          } as ICellData)
        }
        cells.push(outputRow)
      }
      return { sheetName, bounds, cells }
    })
  }

  function restoreSnapshots(snapshots: RangeSnapshot[]): void {
    const runtime = runtimeRef.current
    if (!runtime) return
    suppressEventsRef.current = true
    try {
      for (const snapshot of snapshots) {
        const worksheet = worksheetByName(runtime, snapshot.sheetName)
        if (!worksheet) continue
        worksheet.getRange(
          snapshot.bounds.startRow,
          snapshot.bounds.startColumn,
          snapshot.cells.length,
          snapshot.cells[0]?.length ?? 1,
        ).setValues(snapshot.cells)
      }
    } finally {
      suppressEventsRef.current = false
    }
  }

  function revealChangedRange(targets: Array<{ sheetName: string; bounds: RangeBounds } | null>): void {
    if (followPaused) return
    const target = [...targets].reverse().find((candidate) => candidate !== null)
    const workbook = runtimeRef.current?.univerAPI.getActiveWorkbook()
    const worksheet = target && runtimeRef.current
      ? worksheetByName(runtimeRef.current, target.sheetName)
      : undefined
    if (!target || !workbook || !worksheet) return
    const range = worksheet.getRange(
      target.bounds.startRow,
      target.bounds.startColumn,
      target.bounds.endRow - target.bounds.startRow + 1,
      target.bounds.endColumn - target.bounds.startColumn + 1,
    )
    workbook.setActiveSheet(worksheet)
    workbook.setActiveRange(range)
    worksheet.scrollToCell(target.bounds.startRow, target.bounds.startColumn, 150)
  }

  async function applyCommand(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.operationId !== 'string') return
    const command = value as unknown as ApplyCommand
    const session = sessionRef.current
    const currentVersion = versionRef.current
    if (!session || !currentVersion || command.sessionId !== session.sessionId || !isVersion(command.expectedVersion)) return
    const fingerprint = JSON.stringify(command)
    const cached = operationCacheRef.current.get(command.operationId)
    if (cached) {
      const result = cached.fingerprint === fingerprint
        ? cached.result
        : commandFailure(command, 'INVALID_OPERATION', '同一 operationId 不能用于不同命令。')
      bridgeRef.current!.post({ type: 'office_command_result', result })
      return
    }
    if (!sameDocumentVersion(command.expectedVersion, currentVersion)) {
      const result = commandFailure(command, 'VERSION_CONFLICT', '文档已发生变化，请重新读取相关区域。')
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current!.post({ type: 'office_command_result', result })
      return
    }
    if (!Array.isArray(command.operations) || command.operations.length === 0 || command.operations.length > 50) {
      bridgeRef.current!.post({
        type: 'office_command_result',
        result: commandFailure(command, 'INVALID_OPERATION', '编辑器操作列表无效。'),
      })
      return
    }
    let targets: Array<{ sheetName: string; bounds: RangeBounds } | null>
    let snapshots: RangeSnapshot[]
    try {
      targets = command.operations.map((operation) => (
        ['set_cell', 'set_range', 'set_formula', 'clear_range', 'set_style'].includes(operation.op)
          ? operationTarget(operation)
          : null
      ))
      for (const [index, operation] of command.operations.entries()) {
        const target = targets[index]
        if (operation.op === 'set_range' && target) {
          const rows = target.bounds.endRow - target.bounds.startRow + 1
          const columns = target.bounds.endColumn - target.bounds.startColumn + 1
          if (operation.payload.values.length !== rows
            || operation.payload.values.some((row) => row.length !== columns)) {
            throw new Error('set_range 的 values 尺寸与目标范围不一致。')
          }
        }
        if ((operation.op === 'insert_rows' || operation.op === 'delete_rows'
          || operation.op === 'insert_columns' || operation.op === 'delete_columns')
          && (!Number.isInteger(operation.payload.index) || operation.payload.index < 1
            || !Number.isInteger(operation.payload.count) || operation.payload.count < 1
            || operation.payload.count > 10_000)) {
          throw new Error('行列操作的 index/count 无效。')
        }
        if ((operation.op === 'add_sheet' && !operation.payload.name.trim())
          || (operation.op === 'rename_sheet' && !operation.payload.newName.trim())) {
          throw new Error('工作表名称不能为空。')
        }
      }
      snapshots = snapshotRanges(targets.filter((target): target is NonNullable<typeof target> => !!target))
    } catch (reason) {
      bridgeRef.current!.post({
        type: 'office_command_result',
        result: commandFailure(command, 'INVALID_OPERATION', reason instanceof Error ? reason.message : '编辑器操作无效。'),
      })
      return
    }
    const editsBefore = new Map(editsRef.current)
    const structuralBefore = structuredClone([...structuralOpsRef.current])
    const planBefore = structuredClone(sheetPlanRef.current)
    const filterBefore = structuredClone([...filterStatesRef.current])
    const cfBefore = structuredClone([...cfStatesRef.current])
    const pageSetupBefore = structuredClone([...pageSetupStatesRef.current])
    const metadataBefore = structuredClone(workbookRef.current)
    const activeWorkbook = runtimeRef.current?.univerAPI.getActiveWorkbook()
    const workbookSnapshot = activeWorkbook?.getSnapshot()
    const changedTargets: string[] = []
    agentApplyingRef.current = true
    suppressEventsRef.current = true
    try {
      for (let index = 0; index < command.operations.length; index += 1) {
        const operation = command.operations[index]!
        const target = targets[index]
        if (!target) {
          changedTargets.push(applyStructuralOperation(operation))
          continue
        }
        const worksheet = worksheetByName(runtimeRef.current!, target.sheetName)!
        const range = worksheet.getRange(
          target.bounds.startRow,
          target.bounds.startColumn,
          target.bounds.endRow - target.bounds.startRow + 1,
          target.bounds.endColumn - target.bounds.startColumn + 1,
        )
        if (operation.op === 'set_cell') {
          if (operation.payload.value === null) range.clearContent()
          else range.setValue(operation.payload.value)
        }
        else if (operation.op === 'set_range') {
          range.setValues(operation.payload.values.map((row) => row.map((cell) => ({ v: cell } as ICellData))))
        } else if (operation.op === 'set_formula') range.setFormula(operation.payload.formula)
        else if (operation.op === 'clear_range') range.clearContent()
        else if (operation.op === 'set_style') applyStyle(range, operation.payload.style)
        else throw new Error('不支持的编辑器操作。')
        recordRangeEdits(target.sheetName, target.bounds, operation.op === 'set_style' ? operation.payload.style : undefined)
        changedTargets.push(`${target.sheetName}!${toAddress(target.bounds)}`)
      }
    } catch (reason) {
      editsRef.current = editsBefore
      structuralOpsRef.current = new Map(structuralBefore)
      sheetPlanRef.current = planBefore
      filterStatesRef.current = new Map(filterBefore)
      cfStatesRef.current = new Map(cfBefore)
      pageSetupStatesRef.current = new Map(pageSetupBefore)
      workbookRef.current = metadataBefore
      if (workbookSnapshot && activeWorkbook && runtimeRef.current) {
        runtimeRef.current.univerAPI.disposeUnit(activeWorkbook.getId())
        runtimeRef.current.univerAPI.createWorkbook(workbookSnapshot)
      } else {
        restoreSnapshots(snapshots)
      }
      const result = commandFailure(command, 'INVALID_OPERATION', reason instanceof Error ? reason.message : '编辑器操作失败。')
      bridgeRef.current!.post({ type: 'office_command_result', result })
      return
    } finally {
      suppressEventsRef.current = false
      agentApplyingRef.current = false
    }
    const version = nextVersion()
    revealChangedRange(targets)
    const result = {
      ok: true,
      sessionId: session.sessionId,
      operationId: command.operationId,
      version,
      changedTargets,
      summary: `已完成 ${command.operations.length} 项表格修改`,
    }
    recentChangedTargetsRef.current = result.changedTargets
    operationCacheRef.current.set(command.operationId, { fingerprint, result })
    while (operationCacheRef.current.size > 128) {
      const oldest = operationCacheRef.current.keys().next().value
      if (oldest === undefined) break
      operationCacheRef.current.delete(oldest)
    }
    bridgeRef.current!.post({ type: 'office_command_result', result })
  }

  async function inspect(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.requestId !== 'string' || !isRecord(value.query)) return
    const command = value as unknown as InspectCommand
    const session = sessionRef.current
    const version = versionRef.current
    const workbook = workbookRef.current
    if (!session || !version || !workbook || command.sessionId !== session.sessionId) return
    try {
      const query = command.query
      const presentationState = (sheet: EngineSheet) => {
        const worksheet = runtimeRef.current ? worksheetByName(runtimeRef.current, sheet.name) : undefined
        const fallback = {
          startRow: 0,
          endRow: Math.max(0, sheet.rowCount - 1),
          startColumn: 0,
          endColumn: Math.max(0, sheet.columnCount - 1),
        }
        const liveFilter = worksheet ? filterStateForWorksheet(worksheet, sheet.name, fallback) : undefined
        const liveConditional = worksheet ? conditionalStateForWorksheet(worksheet, sheet.name) : undefined
        return {
          autoFilter: (filterStatesRef.current.get(sheet.name) ?? liveFilter)?.filter?.range ?? null,
          conditionalFormatCount: (cfStatesRef.current.get(sheet.name) ?? liveConditional)?.rules.length ?? 0,
          freeze: {
            frozenRows: pageSetupStatesRef.current.get(sheet.name)?.frozenRows ?? sheet.freeze?.frozenRows ?? 0,
            frozenColumns: pageSetupStatesRef.current.get(sheet.name)?.frozenColumns ?? sheet.freeze?.frozenColumns ?? 0,
          },
        }
      }
      if (query.mode === 'visual' || query.mode === 'selection') {
        const active = runtimeRef.current?.univerAPI.getActiveWorkbook()
        const sheet = active?.getActiveSheet()
        const selection = active?.getActiveRange()?.getRange()
        let result: unknown = {
          mode: 'selection', documentType: 'sheets', sheet: sheet?.getSheetName() ?? null,
          range: selection ? toAddress(selection) : null,
        }
        if (query.mode === 'visual') {
          const element = document.querySelector<HTMLElement>('.mona-sheets-editor')
          if (!element) throw new Error('当前工作表尚未显示。')
          result = {
            ...await captureEditorElement(element, `${sheet?.getSheetName() ?? ''}:viewport`, version, () => versionRef.current),
            warnings: ['仅包含当前可见工作表区域；使用 range 检查其它数据、公式与样式。'],
          }
        }
        bridgeRef.current!.post({ type: 'office_inspect_result', result: {
          ok: true, requestId: command.requestId, sessionId: session.sessionId, version, result,
        } })
        return
      }
      if (query.mode === 'summary') {
        bridgeRef.current!.post({
          type: 'office_inspect_result',
          result: {
            ok: true,
            requestId: command.requestId,
            sessionId: session.sessionId,
            version,
            result: {
              mode: 'summary',
              documentType: 'sheets',
              sheetCount: workbook.sheets.length,
              sheets: workbook.sheets.map((sheet) => ({
                id: sheet.id,
                name: sheet.name,
                rowCount: sheet.rowCount,
                columnCount: sheet.columnCount,
                ...presentationState(sheet),
              })),
            },
          },
        })
        return
      }
      const sheet = workbook.sheets.find((candidate) => candidate.name === query.sheet)
      if (!sheet) throw new Error(`找不到工作表：${query.sheet}`)
      const bounds = parseRange(query.range.toUpperCase())
      if (rangeCellCount(bounds) > 20_000) throw new Error('读取范围不能超过 20000 个单元格。')
      await loadRange(sheet, bounds, true)
      if (!versionRef.current || !sameDocumentVersion(version, versionRef.current)) {
        throw new VisualVersionConflict('读取期间表格已变化，请重新读取。')
      }
      const worksheet = worksheetByName(runtimeRef.current!, sheet.name)!
      const range = worksheet.getRange(
        bounds.startRow,
        bounds.startColumn,
        bounds.endRow - bounds.startRow + 1,
        bounds.endColumn - bounds.startColumn + 1,
      )
      const values = range.getValues()
      const formulas = range.getFormulas()
      const rows = values.map((row, rowIndex) => row.map((cell, columnIndex) => {
        const savedStyle = query.includeStyle
          ? currentStyleForSave(worksheet.getRange(
              bounds.startRow + rowIndex,
              bounds.startColumn + columnIndex,
              1,
              1,
            ))
          : undefined
        const style = savedStyle && Object.keys(savedStyle).length > 0
          ? {
              ...(savedStyle.bold === undefined ? {} : { bold: savedStyle.bold }),
              ...(savedStyle.italic === undefined ? {} : { italic: savedStyle.italic }),
              ...(savedStyle.fontColor === undefined ? {} : { color: savedStyle.fontColor }),
              ...(savedStyle.fillColor === undefined ? {} : { backgroundColor: savedStyle.fillColor }),
              ...(savedStyle.numberFormat === undefined ? {} : { numberFormat: savedStyle.numberFormat }),
              ...(savedStyle.horizontalAlignment === undefined
                ? {}
                : { horizontalAlign: savedStyle.horizontalAlignment }),
              ...(savedStyle.verticalAlignment === undefined ? {} : { verticalAlign: savedStyle.verticalAlignment }),
              ...Object.fromEntries([
                'fontFamily', 'fontSize', 'underline', 'strikethrough', 'wrapText',
                'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
              ].filter((key) => (savedStyle as Record<string, unknown>)[key] !== undefined)
                .map((key) => [key, (savedStyle as Record<string, unknown>)[key]])),
            }
          : null
        return {
          value: normalizeCellValue(cell),
          ...(query.includeFormula && formulas[rowIndex]?.[columnIndex]
            ? { formula: formulas[rowIndex]![columnIndex] }
            : {}),
          ...(query.includeStyle ? { style } : {}),
        }
      }))
      bridgeRef.current!.post({
        type: 'office_inspect_result',
        result: {
          ok: true,
          requestId: command.requestId,
          sessionId: session.sessionId,
          version,
          result: {
            mode: 'range', sheet: sheet.name, range: toAddress(bounds), rows,
            ...presentationState(sheet),
            ...(query.includeStyle ? {
              columnWidths: Array.from({ length: bounds.endColumn - bounds.startColumn + 1 }, (_, offset) =>
                pixelsToCharacterWidth(worksheet.getColumnWidth(bounds.startColumn + offset))),
              rowHeights: Array.from({ length: bounds.endRow - bounds.startRow + 1 }, (_, offset) =>
                worksheet.getRowHeight(bounds.startRow + offset) * 72 / 96),
            } : {}),
          },
        },
      })
    } catch (reason) {
      bridgeRef.current!.post({
        type: 'office_inspect_result',
        result: {
          ok: false,
          requestId: command.requestId,
          sessionId: session.sessionId,
          currentVersion: versionRef.current ?? version,
          error: {
            code: reason instanceof VisualVersionConflict ? 'VERSION_CONFLICT' : 'INVALID_OPERATION',
            message: reason instanceof Error ? reason.message : '无法读取表格。',
            retryable: reason instanceof VisualVersionConflict,
          },
        },
      })
    }
  }

  async function checkpoint(version: DocumentVersion): Promise<void> {
    const session = sessionRef.current
    const source = sourceRef.current
    if (!session || !source || version.editorEpoch !== session.version.editorEpoch) return
    const snapshot = revisionSnapshotsRef.current.get(version.modelRevision)
    if (!snapshot) throw new Error('请求的表格版本已不在 checkpoint 窗口中。')
    const file = await buildXlsxCheckpoint(
      source,
      snapshot.edits,
      snapshot.structuralOps,
      snapshot.sheetPlan,
      {
        filterStates: snapshot.filterStates,
        cfStates: snapshot.cfStates,
        pageSetupStates: snapshot.pageSetupStates,
      },
    )
    bridgeRef.current!.post(
      { type: 'office_checkpoint', sessionId: session.sessionId, version, file },
      [file],
    )
  }

  useEffect(() => {
    const bridge = bridgeRef.current!
    return bridge.onMessage((message: HostMessage) => {
      if (message.type === 'office_open') {
        void openWorkbook(message).catch((reason) => {
          setError(reason instanceof Error ? reason.message : '表格打开失败。')
        })
      } else if (message.type === 'office_command') {
        void applyCommand(message.command)
      } else if (message.type === 'office_inspect') {
        void inspect(message.command)
      } else if (message.type === 'office_checkpoint_request') {
        void checkpoint(message.version).catch((reason) => {
          setError(reason instanceof Error ? reason.message : '表格保存失败。')
        })
      }
    })
  }, [])

  useEffect(() => () => {
    embeddedReadWorkbookRange = null
    bridgeRef.current?.close()
  }, [])

  return (
    <main
      className="mona-sheets-editor"
      onPointerDownCapture={() => {
        if (agentApplyingRef.current) setFollowPaused(true)
      }}
      onWheelCapture={() => {
        if (agentApplyingRef.current) setFollowPaused(true)
      }}
      onKeyDownCapture={() => {
        if (agentApplyingRef.current) setFollowPaused(true)
      }}
    >
      <LocaleProvider initial="zh">
        <GenOfficeSheetsApp embeddedController={embeddedController} />
      </LocaleProvider>
      {error || status ? (
        <div className="mona-sheets-status" data-error={error ? 'true' : 'false'} role={error ? 'alert' : 'status'}>
          {error ?? status}
        </div>
      ) : null}
      {followPaused ? (
        <button
          type="button"
          className="mona-follow-button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setFollowPaused(false)}
        >
          继续跟随 AI
        </button>
      ) : null}
    </main>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少应用根节点。')
createRoot(root).render(<MonaSheetsEditor />)
