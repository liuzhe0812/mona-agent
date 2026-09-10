declare module '@mona-xlsx-gateway' {
  export interface WorkbookStyleEdit {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    underlineStyle?: 'single' | 'double'
    strikethrough?: boolean
    fontFamily?: string
    fontSize?: number
    fontColor?: string | null
    fillColor?: string | null
    horizontalAlignment?: 'left' | 'center' | 'right' | 'justify' | 'distributed'
    verticalAlignment?: 'top' | 'center' | 'bottom'
    wrapText?: boolean
    textRotation?: number
    indent?: number
    protectionLocked?: boolean
    protectionHidden?: boolean
    numberFormat?: string
    borderTop?: { style: string; color?: string } | null
    borderBottom?: { style: string; color?: string } | null
    borderLeft?: { style: string; color?: string } | null
    borderRight?: { style: string; color?: string } | null
  }

  export interface CellEdit {
    sheetName: string
    row: number
    column: number
    writeValue: boolean
    cell: {
      value: string | number | boolean | null
      formula?: string
    }
    style?: WorkbookStyleEdit
  }

  export interface EntrySource {
    paths(): Promise<readonly string[]>
    has(path: string): Promise<boolean>
    readText(path: string): Promise<string>
  }

  export interface MutationPlan {
    replaced: ReadonlyMap<string, string>
    added: ReadonlyMap<string, string>
    addedBinary: ReadonlyMap<string, Uint8Array>
    removedEntries: readonly string[]
  }

  export type StructuralOp =
    | { kind: 'insert-rows' | 'remove-rows' | 'insert-cols' | 'remove-cols'; index: number; count: number }
    | { kind: 'set-row-size' | 'set-col-size'; start: number; end: number; size: number | null }
    | { kind: 'merge-cells' | 'unmerge-cells'; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }

  export interface SheetStructuralOps {
    sheetName: string
    ops: StructuralOp[]
  }

  export interface SheetEditPlan {
    renames: Array<{ sheetName: string; newName: string }>
    additions: Array<{ name: string; sourceSheetName?: string }>
    removals: string[]
    order: string[]
    orderChanged?: boolean
  }

  export interface FilterColumnState {
    colId: number
    values?: string[]
    blank?: boolean
    customs?: { and?: boolean; filters: Array<{ val: string | number; operator?: string }> }
  }

  export interface SheetFilterState {
    sheetName: string
    filter: {
      range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
      columns: FilterColumnState[]
    } | null
    hiddenRows: number[]
    visibilityRange: { startRow: number; endRow: number; startColumn: number; endColumn: number }
  }

  export interface SheetCfState {
    sheetName: string
    rules: Array<{
      ranges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>
      stopIfTrue: boolean
      rule: Record<string, unknown>
    }>
  }

  export interface SheetPageSetupState {
    sheetName: string
    frozenRows?: number
    frozenColumns?: number
  }

  export function planCellEditsToXlsx(
    source: EntrySource,
    edits: readonly CellEdit[],
    structuralOps?: readonly SheetStructuralOps[],
    chartEdits?: readonly unknown[],
    sheetPlan?: SheetEditPlan,
    filterStates?: readonly SheetFilterState[],
    hyperlinkEdits?: readonly unknown[],
    cfStates?: readonly SheetCfState[],
    dvStates?: readonly unknown[],
    sheetProtections?: readonly unknown[],
    definedNamesState?: unknown,
    visualAdditions?: readonly unknown[],
    pageSetupStates?: readonly SheetPageSetupState[],
  ): Promise<MutationPlan>
}
