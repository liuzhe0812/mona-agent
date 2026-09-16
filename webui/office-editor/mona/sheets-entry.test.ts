import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { pixelsToCharacterWidth } from '../vendor/genoffice/apps/sheets/src/renderer/app-constants'

type Cell = {
  value: string | number | boolean | null
  formula?: string
  style?: Record<string, unknown>
}

type SheetState = {
  id: string
  name: string
  rowCount: number
  columnCount: number
  hidden: boolean
  showGridLines: boolean
}

type FakeFilterState = {
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
}

type FakeConditionalRule = {
  ranges: Array<{ startRow: number; endRow: number; startColumn: number; endColumn: number }>
  stopIfTrue?: boolean
  rule: Record<string, unknown>
}

const getBuiltinModule = <T>(name: string): T => {
  const getter = (process as unknown as {
    getBuiltinModule?: (moduleName: string) => unknown
  }).getBuiltinModule
  if (!getter) throw new Error('Node built-in module access is unavailable.')
  return getter(name) as T
}

const fsPromises = getBuiltinModule<{ readFile: (path: string) => Promise<Uint8Array> }>('node:fs/promises')
const pathModule = getBuiltinModule<{
  resolve: (...paths: string[]) => string
  dirname: (path: string) => string
}>('node:path')
const urlModule = getBuiltinModule<{ fileURLToPath: (url: string | URL) => string }>('node:url')
const fixturePath = pathModule.resolve(
  pathModule.dirname(urlModule.fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/office/blank.xlsx',
)

const state = {
  bridge: undefined as TestBridge | undefined,
  posts: [] as unknown[],
  styles: [] as Array<{ bold?: boolean; horizontalAlignment?: string }>,
  univerOptions: [] as unknown[],
  presetOptions: [] as unknown[],
  genOfficeAppProps: [] as unknown[],
  embeddedControllers: [] as unknown[],
  attachedRuntime: undefined as unknown,
  openedWorkbookFiles: [] as unknown[],
  sheets: [
    { id: 'sheet-1', name: 'Sheet1', rowCount: 2, columnCount: 3, hidden: false, showGridLines: true },
  ] as SheetState[],
  mergedRanges: [] as string[],
  disposedUnits: [] as string[],
  commandListener: undefined as ((event: unknown) => void) | undefined,
  cells: [
    [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
    [{ value: '原始 A2' }, { value: null }, { value: null }],
  ] as Cell[][],
  engineCells: [] as Cell[][],
  columnWidths: [] as number[],
  rowHeights: [] as number[],
  filters: new Map<string, FakeFilterState>(),
  conditionalRules: new Map<string, FakeConditionalRule[]>(),
  freezes: new Map<string, { xSplit: number; ySplit: number }>(),
}

function resetFakeState(cells: Cell[][] = [
  [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
  [{ value: '原始 A2' }, { value: null }, { value: null }],
]): void {
  state.posts = []
  state.styles = []
  state.univerOptions = []
  state.presetOptions = []
  state.genOfficeAppProps = []
  state.embeddedControllers = []
  state.attachedRuntime = undefined
  state.openedWorkbookFiles = []
  state.sheets = [
    { id: 'sheet-1', name: 'Sheet1', rowCount: cells.length, columnCount: 3, hidden: false, showGridLines: true },
  ]
  state.mergedRanges = []
  state.disposedUnits = []
  state.commandListener = undefined
  state.cells = structuredClone(cells)
  state.engineCells = structuredClone(cells)
  state.columnWidths = []
  state.rowHeights = []
  state.filters.clear()
  state.conditionalRules.clear()
  state.freezes.clear()
  state.bridge = undefined
}

function columnName(column: number): string {
  let value = column + 1
  let name = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function rangeAddress(startRow: number, startColumn: number, rowCount: number, columnCount: number): string {
  const start = `${columnName(startColumn)}${startRow + 1}`
  const end = `${columnName(startColumn + columnCount - 1)}${startRow + rowCount}`
  return start === end ? start : `${start}:${end}`
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = bytes.slice()
  return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function waitForPost(predicate: (message: unknown) => boolean): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const message = state.posts.find(predicate)
    if (isRecord(message)) return message
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('等待 Sheets bridge 消息超时。')
}

async function openSheets(file: ArrayBuffer): Promise<TestBridge> {
  ;(globalThis as { document?: unknown }).document = { getElementById: () => ({}) }
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  await import('./sheets-entry')
  const bridge = state.bridge
  if (!bridge) throw new Error('Sheets bridge was not created')
  bridge.emit({
    type: 'office_open',
    sessionId: 'session-1',
    documentType: 'sheets',
    version: { editorEpoch: 'epoch-1', modelRevision: 0 },
    file,
  })
  await waitForPost((message) => isRecord(message) && message.type === 'office_editor_ready')
  return bridge
}

class TestRange {
  constructor(
    private readonly startRow: number,
    private readonly startColumn: number,
    private readonly rowCount: number,
    private readonly columnCount: number,
  ) {}

  getValues(): unknown[][] {
    return this.cells().map((row) => row.map((cell) => cell.value))
  }

  getRange(): TestRange {
    return this
  }

  createFilter(): unknown {
    const sheetId = state.sheets[0]?.id ?? 'sheet-1'
    state.filters.set(sheetId, {
      range: {
        startRow: this.startRow,
        endRow: this.startRow + this.rowCount - 1,
        startColumn: this.startColumn,
        endColumn: this.startColumn + this.columnCount - 1,
      },
    })
    return new TestFilter(sheetId)
  }

  getFormulas(): string[][] {
    return this.cells().map((row) => row.map((cell) => cell.formula ?? ''))
  }

  getCellStyleData(): Record<string, unknown> {
    return this.cells()[0]?.[0]?.style ?? {}
  }

  setValue(value: string | number | boolean): void {
    this.requireSingleCell().value = value
    delete this.requireSingleCell().formula
  }

  setValues(values: Array<Array<Record<string, unknown>>>): void {
    if (values.length !== this.rowCount || values.some((row) => row.length !== this.columnCount)) {
      throw new Error('fake range dimensions do not match')
    }
    for (let row = 0; row < this.rowCount; row += 1) {
      for (let column = 0; column < this.columnCount; column += 1) {
        const cell = this.cellAt(row, column)
        const next = values[row]?.[column] ?? {}
        cell.value = (next.v as Cell['value'] | undefined) ?? null
        if (typeof next.f === 'string') cell.formula = next.f
        else delete cell.formula
        if (next.s && typeof next.s === 'object') cell.style = next.s as Record<string, unknown>
      }
    }
  }

  setFormula(formula: string): void {
    const cell = this.requireSingleCell()
    cell.formula = formula
    cell.value = null
  }

  clearContent(): void {
    for (const row of this.cells()) {
      for (const cell of row) {
        cell.value = null
        delete cell.formula
      }
    }
  }

  setFontWeight(weight: string | null): void {
    this.requireSingleCell().style = { ...this.requireSingleCell().style, bl: weight === 'bold' ? 1 : 0 }
  }

  setFontStyle(style: string | null): void {
    this.requireSingleCell().style = { ...this.requireSingleCell().style, italic: style === 'italic' }
  }

  setFontColor(color: string): void {
    this.requireSingleCell().style = { ...this.requireSingleCell().style, color }
  }

  setBackground(color: string): void {
    this.requireSingleCell().style = { ...this.requireSingleCell().style, backgroundColor: color }
  }

  setNumberFormat(numberFormat: string): void {
    this.requireSingleCell().style = { ...this.requireSingleCell().style, numberFormat }
  }

  setHorizontalAlignment(horizontalAlignment: string): void {
    const code = { left: 1, center: 2, right: 3 }[horizontalAlignment as 'left' | 'center' | 'right']
    this.requireSingleCell().style = {
      ...this.requireSingleCell().style,
      ht: code ?? horizontalAlignment,
    }
  }

  merge(): void {
    const address = rangeAddress(this.startRow, this.startColumn, this.rowCount, this.columnCount)
    if (!state.mergedRanges.includes(address)) state.mergedRanges.push(address)
  }

  breakApart(): void {
    const address = rangeAddress(this.startRow, this.startColumn, this.rowCount, this.columnCount)
    state.mergedRanges = state.mergedRanges.filter((range) => range !== address)
  }

  private cells(): Cell[][] {
    return Array.from({ length: this.rowCount }, (_, row) =>
      Array.from({ length: this.columnCount }, (_, column) => this.cellAt(row, column)),
    )
  }

  private cellAt(row: number, column: number): Cell {
    const absoluteRow = this.startRow + row
    const absoluteColumn = this.startColumn + column
    state.cells[absoluteRow] ??= []
    state.cells[absoluteRow]![absoluteColumn] ??= { value: null }
    return state.cells[absoluteRow]![absoluteColumn]!
  }

  private requireSingleCell(): Cell {
    if (this.rowCount !== 1 || this.columnCount !== 1) throw new Error('fake range is not one cell')
    return this.cellAt(0, 0)
  }
}

class TestFilter {
  constructor(private readonly sheetId: string) {}

  getRange(): { getRange: () => FakeFilterState['range'] } {
    return { getRange: () => state.filters.get(this.sheetId)?.range ?? {
      startRow: 0, endRow: 0, startColumn: 0, endColumn: 0,
    } }
  }

  getColumnFilterCriteria(): null {
    return null
  }

  getFilteredOutRows(): number[] {
    return []
  }

  remove(): void {
    state.filters.delete(this.sheetId)
  }
}

class TestConditionalBuilder {
  private rule: Record<string, unknown> = {}
  private ranges: Array<FakeConditionalRule['ranges'][number]> = []

  setRanges(ranges: Array<FakeConditionalRule['ranges'][number]>): this {
    this.ranges = ranges
    return this
  }

  setColorScale(config: unknown): this { this.rule = { type: 'colorScale', config }; return this }
  whenNumberGreaterThan(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value }; return this }
  whenNumberGreaterThanOrEqualTo(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'greaterThanOrEqual', value }; return this }
  whenNumberLessThan(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'lessThan', value }; return this }
  whenNumberLessThanOrEqualTo(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'lessThanOrEqual', value }; return this }
  whenNumberEqualTo(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'equal', value }; return this }
  whenNumberNotEqualTo(value: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'notEqual', value }; return this }
  whenNumberBetween(value: number, value2: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'between', value, value2 }; return this }
  whenNumberNotBetween(value: number, value2: number): this { this.rule = { type: 'highlightCell', subType: 'number', operator: 'notBetween', value, value2 }; return this }
  whenTextContains(value: string): this { this.rule = { type: 'highlightCell', subType: 'text', operator: 'containsText', value }; return this }
  whenTextDoesNotContain(value: string): this { this.rule = { type: 'highlightCell', subType: 'text', operator: 'notContainsText', value }; return this }
  whenTextStartsWith(value: string): this { this.rule = { type: 'highlightCell', subType: 'text', operator: 'beginsWith', value }; return this }
  whenTextEndsWith(value: string): this { this.rule = { type: 'highlightCell', subType: 'text', operator: 'endsWith', value }; return this }
  whenCellEmpty(): this { this.rule = { type: 'highlightCell', subType: 'blank', value: true }; return this }
  whenCellNotEmpty(): this { this.rule = { type: 'highlightCell', subType: 'blank', value: false }; return this }
  setDuplicateValues(): this { this.rule = { type: 'highlightCell', subType: 'duplicate', value: false }; return this }
  setUniqueValues(): this { this.rule = { type: 'highlightCell', subType: 'duplicate', value: true }; return this }
  setRank(value: unknown): this { this.rule = { type: 'highlightCell', subType: 'top10', ...value as object }; return this }
  whenFormulaSatisfied(value: string): this { this.rule = { type: 'highlightCell', subType: 'formula', value }; return this }
  setBackground(value: string): this { this.rule.style = { ...(this.rule.style as object), fillColor: value }; return this }
  setFontColor(value: string): this { this.rule.style = { ...(this.rule.style as object), fontColor: value }; return this }
  setBold(value: boolean): this { this.rule.style = { ...(this.rule.style as object), bold: value }; return this }
  setItalic(value: boolean): this { this.rule.style = { ...(this.rule.style as object), italic: value }; return this }

  build(): FakeConditionalRule {
    return { ranges: this.ranges, stopIfTrue: false, rule: this.rule }
  }
}

class TestSheet {
  constructor(private readonly id: string) {}

  private metadata(): SheetState {
    const metadata = state.sheets.find((sheet) => sheet.id === this.id)
    if (!metadata) throw new Error(`fake sheet ${this.id} does not exist`)
    return metadata
  }

  getSheetName(): string {
    return this.metadata().name
  }

  getSheetId(): string {
    return this.id
  }

  setName(name: string): void {
    this.metadata().name = name
  }

  insertRowsBefore(index: number, count: number): void {
    const columnCount = Math.max(1, ...state.cells.map((row) => row.length))
    state.cells.splice(index, 0, ...Array.from({ length: count }, () => (
      Array.from({ length: columnCount }, () => ({ value: null }))
    )))
    this.metadata().rowCount += count
  }

  deleteRows(index: number, count: number): void {
    state.cells.splice(index, count)
    if (state.cells.length === 0) state.cells.push([{ value: null }])
    this.metadata().rowCount = state.cells.length
  }

  insertColumnsBefore(index: number, count: number): void {
    for (const row of state.cells) row.splice(index, 0, ...Array.from({ length: count }, () => ({ value: null })))
    this.metadata().columnCount += count
  }

  deleteColumns(index: number, count: number): void {
    for (const row of state.cells) row.splice(index, count)
    this.metadata().columnCount = Math.max(1, this.metadata().columnCount - count)
  }

  getRange(row: number, column: number, rowCount = 1, columnCount = 1): TestRange {
    return new TestRange(row, column, rowCount, columnCount)
  }

  getMaxColumns(): number {
    return this.metadata().columnCount
  }

  getMaxRows(): number {
    return this.metadata().rowCount
  }

  setColumnWidths(start: number, count: number, size: number): void {
    for (let index = start; index < start + count; index += 1) state.columnWidths[index] = size
  }

  setRowHeightsForced(start: number, count: number, size: number): void {
    for (let index = start; index < start + count; index += 1) state.rowHeights[index] = size
  }

  getColumnWidth(column = 0): number {
    return state.columnWidths[column] ?? 88
  }

  getRowHeight(row = 0): number {
    return state.rowHeights[row] ?? 20
  }

  getFilter(): TestFilter | null {
    return state.filters.has(this.id) ? new TestFilter(this.id) : null
  }

  getConditionalFormattingRules(): FakeConditionalRule[] {
    return [...(state.conditionalRules.get(this.id) ?? [])]
  }

  newConditionalFormattingRule(): TestConditionalBuilder {
    return new TestConditionalBuilder()
  }

  addConditionalFormattingRule(rule: FakeConditionalRule): void {
    const rules = state.conditionalRules.get(this.id) ?? []
    rules.push(rule)
    state.conditionalRules.set(this.id, rules)
  }

  setFreeze(value: { xSplit: number; ySplit: number }): void {
    state.freezes.set(this.id, value)
  }

  cancelFreeze(): void {
    state.freezes.delete(this.id)
  }

  scrollToCell(): void {}
}

class TestBridge {
  private listener: ((message: unknown) => void) | undefined

  constructor(readonly kind: string) {
    state.bridge = this
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  post(message: unknown): void {
    state.posts.push(message)
  }

  async engineOpen(): Promise<unknown> {
    return {
      sessionId: 'engine-session',
      name: 'fixture.xlsx',
      sheets: [{ id: 'sheet-1', name: 'Sheet1', rowCount: 2, columnCount: 3, hidden: false, showGridLines: true }],
      styles: state.styles,
    }
  }

  async engineReadRange(payload?: { range?: { startRow: number; endRow: number; startColumn: number; endColumn: number } }): Promise<unknown> {
    const range = payload?.range ?? {
      startRow: 0,
      endRow: state.engineCells.length - 1,
      startColumn: 0,
      endColumn: Math.max(0, ...state.engineCells.map((row) => row.length - 1)),
    }
    return {
      cells: state.engineCells.flatMap((row, rowIndex) => row.flatMap((cell, columnIndex) => (
        rowIndex < range.startRow || rowIndex > range.endRow
        || columnIndex < range.startColumn || columnIndex > range.endColumn
          ? []
          : [{
              row: rowIndex,
              column: columnIndex,
              value: cell.value,
              ...(cell.formula ? { formula: cell.formula } : {}),
              ...(state.styles.length > 0 && rowIndex === 0 && columnIndex === 0 ? { styleIndex: 0 } : {}),
            }]
      ))),
    }
  }

  close(): void {}

  emit(message: unknown): void {
    this.listener?.(message)
  }
}

type FakeElement = {
  type?: unknown
  props?: Record<string, unknown>
}

function renderFakeElement(element: unknown): void {
  if (!element || typeof element !== 'object') return
  const current = element as FakeElement
  if (typeof current.type === 'function') {
    renderFakeElement(current.type(current.props ?? {}))
    return
  }
  const children = current.props?.children
  if (Array.isArray(children)) {
    for (const child of children) renderFakeElement(child)
  } else {
    renderFakeElement(children)
  }
}

const workbook = {
  getSheets: () => state.sheets.map((sheet) => new TestSheet(sheet.id)),
  getActiveWorkbook: () => workbook,
  getActiveSheet: () => new TestSheet(state.sheets[0]?.id ?? 'sheet-1'),
  getActiveRange: () => null,
  setActiveSheet: vi.fn(),
  setActiveRange: vi.fn(),
  getId: () => 'file-session-1',
  getSnapshot: vi.fn(() => ({
    __fakeCells: structuredClone(state.cells),
    __fakeSheets: structuredClone(state.sheets),
    __fakeMergedRanges: [...state.mergedRanges],
    __fakeColumnWidths: [...state.columnWidths],
    __fakeRowHeights: [...state.rowHeights],
    __fakeFilters: [...state.filters],
    __fakeConditionalRules: [...state.conditionalRules],
    __fakeFreezes: [...state.freezes],
  })),
  disposeUnit: vi.fn((unitId: string) => {
    state.disposedUnits.push(unitId)
  }),
  createWorkbook: vi.fn((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return
    const value = snapshot as {
      __fakeCells?: Cell[][]
      __fakeSheets?: SheetState[]
      __fakeMergedRanges?: string[]
      __fakeColumnWidths?: number[]
      __fakeRowHeights?: number[]
      __fakeFilters?: Array<[string, FakeFilterState]>
      __fakeConditionalRules?: Array<[string, FakeConditionalRule[]]>
      __fakeFreezes?: Array<[string, { xSplit: number; ySplit: number }]>
      sheets?: Record<string, { id?: string; name?: string; rowCount?: number; columnCount?: number }>
    }
    if (value.__fakeCells) state.cells = structuredClone(value.__fakeCells)
    if (value.__fakeSheets) state.sheets = structuredClone(value.__fakeSheets)
    if (value.__fakeMergedRanges) state.mergedRanges = [...value.__fakeMergedRanges]
    if (value.__fakeColumnWidths) state.columnWidths = [...value.__fakeColumnWidths]
    if (value.__fakeRowHeights) state.rowHeights = [...value.__fakeRowHeights]
    if (value.__fakeFilters) state.filters = new Map(structuredClone(value.__fakeFilters))
    if (value.__fakeConditionalRules) state.conditionalRules = new Map(structuredClone(value.__fakeConditionalRules))
    if (value.__fakeFreezes) state.freezes = new Map(structuredClone(value.__fakeFreezes))
  }),
  Event: { CommandExecuted: 'command-executed' },
  addEvent: vi.fn((_event: string, listener: (event: unknown) => void) => {
    state.commandListener = listener
    return { dispose: vi.fn() }
  }),
}

vi.mock('react', () => ({
  createContext: <T,>(value: T) => ({ _currentValue: value }),
  useContext: <T,>(context: { _currentValue: T }) => context._currentValue,
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(current: T) => [current, vi.fn()],
  useEffect: (effect: () => unknown) => effect(),
}))

vi.mock('react/jsx-runtime', () => ({
  Fragment: Symbol('Fragment'),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
}))

vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: (element: FakeElement) => renderFakeElement(element),
  }),
}))

vi.mock('../vendor/genoffice/apps/sheets/src/renderer/App', () => ({
  App: (props: { embeddedController?: {
    attach: (api: { runtime: unknown; open: (file: unknown) => void }) => unknown
  } }) => {
    state.genOfficeAppProps.push(props)
    if (props.embeddedController) {
      state.embeddedControllers.push(props.embeddedController)
      const runtime = {
        univer: { dispose: vi.fn() },
        univerAPI: workbook,
      }
      state.attachedRuntime = runtime
      props.embeddedController.attach({
        runtime,
        open: (file) => state.openedWorkbookFiles.push(file),
      })
    }
    return null
  },
}))

vi.mock('../vendor/genoffice/apps/sheets/src/renderer/i18n/locale', () => ({
  LocaleProvider: (props: { children?: unknown }) => props.children,
  setModuleLang: vi.fn(),
}))

vi.mock('@univerjs/core', () => ({
  HorizontalAlign: { LEFT: 'left', CENTER: 'center', RIGHT: 'right' },
  LocaleType: { ZH_CN: 'zhCN' },
  mergeLocales: (locale: unknown) => locale,
}))

vi.mock('@univerjs/preset-sheets-core', () => ({
  UniverSheetsCorePreset: (options: unknown) => {
    state.presetOptions.push(options)
    return {}
  },
}))

vi.mock('@univerjs/preset-sheets-core/locales/zh-CN', () => ({ default: {} }))
vi.mock('@univerjs/themes', () => ({ greenTheme: {} }))
vi.mock('../vendor/genoffice/apps/sheets/src/renderer/create-univer', () => ({
  createUniver: (options: unknown) => {
    state.univerOptions.push(options)
    return {
      univer: { dispose: vi.fn() },
      univerAPI: workbook,
    }
  },
}))
vi.mock('./bridge', () => ({ MonaOfficeBridge: TestBridge }))

describe('Sheets command atomic rollback', () => {
  it('renders the GenOffice Sheets app with a Chinese embedded runtime', async () => {
    vi.resetModules()
    resetFakeState()
    await openSheets(new ArrayBuffer(0))

    expect(state.genOfficeAppProps).toHaveLength(1)
    const appProps = state.genOfficeAppProps[0] as {
      embeddedController?: unknown
    }
    expect(appProps.embeddedController).toBe(state.embeddedControllers[0])
    expect(state.attachedRuntime).toEqual(expect.objectContaining({ univerAPI: workbook }))
    expect(state.openedWorkbookFiles).toHaveLength(1)
    expect(state.univerOptions).toHaveLength(0)
  })

  it('restores earlier operations and keeps modelRevision when operation N fails', async () => {
    vi.resetModules()
    resetFakeState([
      [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
      [{ value: '原始 A2' }, { value: null }, { value: null }],
    ])
    const bridge = await openSheets(new ArrayBuffer(0))

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'rollback-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'set_cell', payload: { sheet: 'Sheet1', cell: 'A1', value: '临时修改' } },
          { op: 'set_range', payload: { sheet: 'Sheet1', range: 'B1:C1', values: [[11, 21]] } },
          { op: 'set_range', payload: { sheet: 'Sheet1', range: 'A2:B2', values: [['尺寸错误']] } },
        ],
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(state.cells.map((row) => row.map(({ value, formula }) => ({
      value,
      ...(formula ? { formula } : {}),
    })))).toEqual([
      [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
      [{ value: '原始 A2' }, { value: null }, { value: null }],
    ])
    expect(state.posts.at(-1)).toEqual(expect.objectContaining({
      type: 'office_command_result',
      result: expect.objectContaining({
        ok: false,
        operationId: 'rollback-1',
        currentVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        error: expect.objectContaining({ code: 'INVALID_OPERATION' }),
      }),
    }))
  })

  it('rejects 1000 stale commands after the editor advances to revision 1', async () => {
    vi.resetModules()
    resetFakeState([
      [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
      [{ value: '原始 A2' }, { value: null }, { value: null }],
    ])
    const bridge = await openSheets(new ArrayBuffer(0))

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'advance-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'set_cell', payload: { sheet: 'Sheet1', cell: 'A1', value: '正常修改' } },
        ],
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    const successfulResult = state.posts.find((message) => (
      typeof message === 'object' && message !== null &&
      'result' in message &&
      typeof message.result === 'object' && message.result !== null &&
      'operationId' in message.result && message.result.operationId === 'advance-1'
    )) as { result?: { ok?: boolean; version?: { modelRevision?: number } } } | undefined
    expect(successfulResult?.result).toEqual(expect.objectContaining({
      ok: true,
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
    }))

    for (let index = 0; index < 1000; index += 1) {
      bridge.emit({
        type: 'office_command',
        command: {
          sessionId: 'session-1',
          operationId: `stale-${index}`,
          expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
          operations: [
            { op: 'set_cell', payload: { sheet: 'Sheet1', cell: 'A1', value: `过期修改-${index}` } },
          ],
        },
      })
    }

    const staleResults = state.posts.filter((message) => (
      typeof message === 'object' && message !== null &&
      'result' in message &&
      typeof message.result === 'object' && message.result !== null &&
      typeof (message.result as { operationId?: unknown }).operationId === 'string' &&
      (message.result as { operationId: string }).operationId.startsWith('stale-')
    )) as Array<{ result: { ok?: boolean; currentVersion?: { modelRevision?: number }; error?: { code?: string } } }>
    expect(staleResults).toHaveLength(1000)
    expect(staleResults.every(({ result }) => (
      result.ok === false &&
      result.currentVersion?.modelRevision === 1 &&
      result.error?.code === 'VERSION_CONFLICT'
    ))).toBe(true)
    expect(state.cells[0]?.[0]?.value).toBe('正常修改')
  })

  it('returns compact bold and centered style when inspect includes styles', async () => {
    vi.resetModules()
    resetFakeState([
      [{ value: '标题' }, { value: 10 }, { value: 20 }],
      [{ value: '原始 A2' }, { value: null }, { value: null }],
    ])
    state.styles = [{ bold: true, horizontalAlignment: 'center' }]
    const bridge = await openSheets(new ArrayBuffer(0))

    bridge.emit({
      type: 'office_inspect',
      command: {
        sessionId: 'session-1',
        requestId: 'inspect-style-1',
        query: {
          mode: 'range',
          sheet: 'Sheet1',
          range: 'A1',
          includeFormula: false,
          includeStyle: true,
        },
      },
    })
    await Promise.resolve()
    await Promise.resolve()

    const response = state.posts.find((message) => (
      typeof message === 'object' && message !== null &&
      'type' in message && message.type === 'office_inspect_result'
    )) as {
      result?: {
        ok?: boolean
        result?: { rows?: Array<Array<{ style?: unknown }>> }
      }
    } | undefined
    expect(response?.result?.ok).toBe(true)
    expect(response?.result?.result?.rows?.[0]?.[0]?.style).toEqual(expect.objectContaining({
      bold: true,
      horizontalAlign: 'center',
    }))
  })

  it('keeps changed ranges pending and reports formula errors until inspected and fixed', async () => {
    vi.resetModules()
    resetFakeState([[{ value: '#DIV/0!', formula: '=1/0' }, { value: null }, { value: null }]])
    const bridge = await openSheets(new ArrayBuffer(0))
    bridge.emit({ type: 'office_command', command: {
      sessionId: 'session-1', operationId: 'style-error',
      expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
      operations: [{ op: 'set_style', payload: { sheet: 'Sheet1', range: 'A1', style: { bold: true } } }],
    } })
    const applied = await waitForPost((message) => isRecord(message) && message.type === 'office_command_result'
      && isRecord(message.result) && message.result.operationId === 'style-error')
    expect(applied.result).toEqual(expect.objectContaining({ ok: true }))
    expect(state.cells[0]?.[0]).toEqual(expect.objectContaining({ formula: '=1/0' }))
    state.cells[0]![0]!.value = '#DIV/0!'
    bridge.emit({ type: 'office_inspect', command: {
      sessionId: 'session-1', requestId: 'review-error', query: { mode: 'review' },
    } })
    const review = await waitForPost((message) => isRecord(message) && message.type === 'office_inspect_result'
      && isRecord(message.result) && message.result.requestId === 'review-error')
    expect(review.result).toEqual(expect.objectContaining({ result: expect.objectContaining({
      pendingTargets: ['Sheet1!A1'], warnings: [expect.stringContaining('#DIV/0!')],
    }) }))
    bridge.emit({ type: 'office_inspect', command: {
      sessionId: 'session-1', requestId: 'range-error',
      query: { mode: 'range', sheet: 'Sheet1', range: 'A1', includeFormula: true, includeStyle: true },
    } })
    await waitForPost((message) => isRecord(message) && message.type === 'office_inspect_result'
      && isRecord(message.result) && message.result.requestId === 'range-error')
    bridge.emit({ type: 'office_inspect', command: {
      sessionId: 'session-1', requestId: 'review-read', query: { mode: 'review' },
    } })
    const readReview = await waitForPost((message) => isRecord(message) && message.type === 'office_inspect_result'
      && isRecord(message.result) && message.result.requestId === 'review-read')
    expect(readReview.result).toEqual(expect.objectContaining({ result: expect.objectContaining({
      pendingTargets: ['Sheet1!A1'], warnings: [expect.stringContaining('#DIV/0!')],
    }) }))
    bridge.emit({ type: 'office_command', command: {
      sessionId: 'session-1', operationId: 'fix-error',
      expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 1 },
      operations: [{ op: 'set_cell', payload: { sheet: 'Sheet1', cell: 'A1', value: 0 } }],
    } })
    await waitForPost((message) => isRecord(message) && message.type === 'office_command_result'
      && isRecord(message.result) && message.result.operationId === 'fix-error')
    bridge.emit({ type: 'office_inspect', command: {
      sessionId: 'session-1', requestId: 'range-fixed',
      query: { mode: 'range', sheet: 'Sheet1', range: 'A1', includeFormula: true, includeStyle: true },
    } })
    await waitForPost((message) => isRecord(message) && message.type === 'office_inspect_result'
      && isRecord(message.result) && message.result.requestId === 'range-fixed')
    bridge.emit({ type: 'office_inspect', command: {
      sessionId: 'session-1', requestId: 'review-fixed', query: { mode: 'review' },
    } })
    const fixed = await waitForPost((message) => isRecord(message) && message.type === 'office_inspect_result'
      && isRecord(message.result) && message.result.requestId === 'review-fixed')
    expect(fixed.result).toEqual(expect.objectContaining({ result: expect.objectContaining({
      pendingTargets: [], warnings: [],
    }) }))
  })

  it('tracks the mutation range from an existing workbook and preserves it for inspect and checkpoint', async () => {
    vi.resetModules()
    resetFakeState()
    const source = asArrayBuffer(await fsPromises.readFile(fixturePath))
    const bridge = await openSheets(source)

    state.cells[0]![0] = { value: '用户实时修改' }
    state.commandListener?.({
      id: 'sheet.mutation.set-range-values',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        cellValue: { 0: { 0: { v: '用户实时修改' } } },
      },
    })
    await Promise.resolve()

    expect(state.posts).toContainEqual(expect.objectContaining({
      type: 'office_user_change',
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
      changedTargets: ['Sheet1!A1'],
    }))

    bridge.emit({
      type: 'office_inspect',
      command: {
        sessionId: 'session-1',
        requestId: 'inspect-user-change',
        query: { mode: 'range', sheet: 'Sheet1', range: 'A1', includeFormula: true },
      },
    })
    const inspected = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_inspect_result'
      && isRecord(message.result)
      && message.result.requestId === 'inspect-user-change'
    ))
    expect(inspected.result).toEqual(expect.objectContaining({
      ok: true,
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
      result: expect.objectContaining({ rows: [[expect.objectContaining({ value: '用户实时修改' })]] }),
    }))

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && isRecord(message.version)
      && message.version.modelRevision === 1
    ))
    if (!(checkpoint.file instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const zip = await JSZip.loadAsync(checkpoint.file)
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
    expect(worksheetXml).toContain('用户实时修改')
  })

  it('records structural mutations and their undo mutations from the editor', async () => {
    vi.resetModules()
    resetFakeState()
    const bridge = await openSheets(asArrayBuffer(await fsPromises.readFile(fixturePath)))
    const sheet = new TestSheet('sheet-1')

    sheet.insertRowsBefore(0, 1)
    state.commandListener?.({
      id: 'sheet.mutation.insert-row',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 },
      },
    })
    await Promise.resolve()
    expect(state.posts).toContainEqual(expect.objectContaining({
      type: 'office_user_change',
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
      changedTargets: ['Sheet1!insert-rows:1:1'],
    }))

    sheet.deleteRows(0, 1)
    state.commandListener?.({
      id: 'sheet.mutation.remove-rows',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 },
      },
    })
    await Promise.resolve()
    expect(state.posts).toContainEqual(expect.objectContaining({
      type: 'office_user_change',
      version: { editorEpoch: 'epoch-1', modelRevision: 2 },
      changedTargets: ['Sheet1!remove-rows:1:1'],
    }))

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 2 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && isRecord(message.version)
      && message.version.modelRevision === 2
    ))
    expect(checkpoint.file).toBeInstanceOf(ArrayBuffer)
  })

  it('maps disk reads around a user-inserted row without overwriting the new row', async () => {
    vi.resetModules()
    resetFakeState()
    const bridge = await openSheets(asArrayBuffer(await fsPromises.readFile(fixturePath)))
    const sheet = new TestSheet('sheet-1')

    sheet.insertRowsBefore(0, 1)
    state.commandListener?.({
      id: 'sheet.mutation.insert-row',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 },
      },
    })
    await Promise.resolve()

    bridge.emit({
      type: 'office_inspect',
      command: {
        sessionId: 'session-1',
        requestId: 'inspect-shifted-range',
        query: { mode: 'range', sheet: 'Sheet1', range: 'A1:A3', includeFormula: true },
      },
    })
    const inspected = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_inspect_result'
      && isRecord(message.result)
      && message.result.requestId === 'inspect-shifted-range'
    ))
    const result = inspected.result as { result?: { rows?: Array<Array<{ value?: unknown }>> } }
    expect(result.result?.rows?.map((row) => row[0]?.value)).toEqual([
      null,
      '原始 A1',
      '原始 A2',
    ])
  })

  it('persists user sheet renames and merge mutations from the live editor', async () => {
    vi.resetModules()
    resetFakeState()
    const bridge = await openSheets(asArrayBuffer(await fsPromises.readFile(fixturePath)))
    const sheet = new TestSheet('sheet-1')

    sheet.setName('销售数据')
    state.commandListener?.({
      id: 'sheet.mutation.set-worksheet-name',
      params: { unitId: 'file-session-1', subUnitId: 'sheet-1', name: '销售数据' },
    })
    await Promise.resolve()
    new TestRange(0, 0, 1, 2).merge()
    state.commandListener?.({
      id: 'sheet.mutation.add-worksheet-merge',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }],
      },
    })
    await Promise.resolve()

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 2 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && isRecord(message.version)
      && message.version.modelRevision === 2
    ))
    if (!(checkpoint.file instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const zip = await JSZip.loadAsync(checkpoint.file)
    expect(await zip.file('xl/workbook.xml')?.async('string')).toContain('name="销售数据"')
    expect(await zip.file('xl/worksheets/sheet1.xml')?.async('string')).toContain('<mergeCell ref="A1:B1"/>')
  })

  it('rolls back structural operations atomically when a later operation fails', async () => {
    vi.resetModules()
    resetFakeState()
    const bridge = await openSheets(new ArrayBuffer(0))

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'structural-rollback-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'insert_rows', payload: { sheet: 'Sheet1', index: 1, count: 1 } },
          { op: 'merge_cells', payload: { sheet: 'Sheet1', range: 'not-a-range' } },
        ],
      },
    })
    const response = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_command_result'
      && isRecord(message.result)
      && message.result.operationId === 'structural-rollback-1'
    ))
    const result = response.result as Record<string, unknown>

    expect(state.cells).toEqual([
      [{ value: '原始 A1' }, { value: 10 }, { value: 20 }],
      [{ value: '原始 A2' }, { value: null }, { value: null }],
    ])
    expect(state.sheets[0]?.rowCount).toBe(2)
    expect(state.mergedRanges).toEqual([])
    expect(state.disposedUnits).toEqual(['file-session-1'])
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      currentVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
      error: expect.objectContaining({ code: 'INVALID_OPERATION' }),
    }))
  })

  it('checkpoints structural edits through the real GenOffice XLSX planner', async () => {
    vi.resetModules()
    resetFakeState()
    const source = asArrayBuffer(await fsPromises.readFile(fixturePath))
    const bridge = await openSheets(source)

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'structural-checkpoint-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'insert_rows', payload: { sheet: 'Sheet1', index: 1, count: 1 } },
          { op: 'merge_cells', payload: { sheet: 'Sheet1', range: 'A1:B1' } },
        ],
      },
    })
    await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_command_result'
      && isRecord(message.result)
      && message.result.operationId === 'structural-checkpoint-1'
      && message.result.ok === true
    ))

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && message.sessionId === 'session-1'
    ))
    if (!(checkpoint.file instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const zip = await JSZip.loadAsync(checkpoint.file)
    const worksheet = zip.file('xl/worksheets/sheet1.xml')
    if (!worksheet) throw new Error('checkpoint is missing the first worksheet')
    const worksheetXml = await worksheet.async('string')

    expect(checkpoint.version).toEqual({ editorEpoch: 'epoch-1', modelRevision: 1 })
    expect(worksheetXml).toContain('<mergeCell ref="A1:B1"/>')
  })

  it('applies filters, conditional formats, and freeze panes through the live bridge and checkpoint', async () => {
    vi.resetModules()
    resetFakeState()
    const source = asArrayBuffer(await fsPromises.readFile(fixturePath))
    const bridge = await openSheets(source)

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'professional-sheet-features-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'set_auto_filter', payload: { sheet: 'Sheet1', range: 'A1:B3' } },
          { op: 'set_freeze_panes', payload: { sheet: 'Sheet1', rows: 1, columns: 1 } },
          {
            op: 'set_conditional_format',
            payload: {
              sheet: 'Sheet1',
              range: 'A2:A3',
              rule: {
                kind: 'colorScale',
                minColor: '#F8696B',
                maxColor: '#63BE7B',
              },
            },
          },
        ],
      },
    })
    const commandResult = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_command_result'
      && isRecord(message.result)
      && message.result.operationId === 'professional-sheet-features-1'
    ))
    expect(commandResult.result).toEqual(expect.objectContaining({
      ok: true,
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
      changedTargets: expect.arrayContaining([
        'Sheet1:filter',
        'Sheet1:freeze:1:1',
        'Sheet1!A2:A3:conditional-format',
      ]),
    }))

    bridge.emit({
      type: 'office_inspect',
      command: {
        sessionId: 'session-1',
        requestId: 'professional-sheet-features-summary',
        query: { mode: 'summary' },
      },
    })
    const summary = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_inspect_result'
      && isRecord(message.result)
      && message.result.requestId === 'professional-sheet-features-summary'
    ))
    expect(summary.result).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        sheets: [expect.objectContaining({
          autoFilter: expect.objectContaining({ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }),
          conditionalFormatCount: 1,
          freeze: { frozenRows: 1, frozenColumns: 1 },
        })],
      }),
    }))

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 1 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && isRecord(message.version)
      && message.version.modelRevision === 1
    ))
    if (!(checkpoint.file instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const zip = await JSZip.loadAsync(checkpoint.file)
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
    if (!worksheetXml) throw new Error('checkpoint is missing the first worksheet')
    expect(worksheetXml).toContain('<autoFilter ref="A1:B3"/>')
    expect(worksheetXml).toContain('<conditionalFormatting sqref="A2:A3">')
    expect(worksheetXml).toContain('type="colorScale"')
    expect(worksheetXml).toContain('<pane xSplit="1" ySplit="1"')
  })

  it('lets user axis-size mutations replace AI sizes in the exported worksheet XML', async () => {
    vi.resetModules()
    resetFakeState()
    const source = asArrayBuffer(await fsPromises.readFile(fixturePath))
    const bridge = await openSheets(source)

    bridge.emit({
      type: 'office_command',
      command: {
        sessionId: 'session-1',
        operationId: 'axis-size-ai-1',
        expectedVersion: { editorEpoch: 'epoch-1', modelRevision: 0 },
        operations: [
          { op: 'set_column_width', payload: { sheet: 'Sheet1', index: 1, count: 1, size: 8 } },
          { op: 'set_row_height', payload: { sheet: 'Sheet1', index: 1, count: 1, size: 18 } },
        ],
      },
    })
    const aiResult = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_command_result'
      && isRecord(message.result)
      && message.result.operationId === 'axis-size-ai-1'
      && message.result.ok === true
    ))
    expect((aiResult.result as { version?: unknown }).version).toEqual({
      editorEpoch: 'epoch-1',
      modelRevision: 1,
    })

    const userColumnPixels = 200
    const userRowPixels = 48
    const sheet = new TestSheet('sheet-1')
    sheet.setColumnWidths(0, 1, userColumnPixels)
    state.commandListener?.({
      id: 'sheet.mutation.set-worksheet-col-width',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        ranges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 }],
        colWidth: userColumnPixels,
      },
    })
    sheet.setRowHeightsForced(0, 1, userRowPixels)
    state.commandListener?.({
      id: 'sheet.mutation.set-worksheet-row-height',
      params: {
        unitId: 'file-session-1',
        subUnitId: 'sheet-1',
        ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }],
        rowHeight: userRowPixels,
      },
    })
    const userChange = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_user_change'
      && isRecord(message.version)
      && message.version.modelRevision === 2
    ))
    expect(userChange.changedTargets).toEqual(expect.arrayContaining(['Sheet1!A1:A2', 'Sheet1!A1:B1']))

    bridge.emit({
      type: 'office_inspect',
      command: {
        sessionId: 'session-1',
        requestId: 'axis-size-inspect',
        query: { mode: 'range', sheet: 'Sheet1', range: 'A1', includeFormula: false, includeStyle: true },
      },
    })
    const inspected = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_inspect_result'
      && isRecord(message.result)
      && message.result.requestId === 'axis-size-inspect'
    ))
    expect(inspected.result).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        columnWidths: [pixelsToCharacterWidth(userColumnPixels)],
        rowHeights: [userRowPixels * 72 / 96],
      }),
    }))

    bridge.emit({
      type: 'office_checkpoint_request',
      sessionId: 'session-1',
      version: { editorEpoch: 'epoch-1', modelRevision: 2 },
    })
    const checkpoint = await waitForPost((message) => (
      isRecord(message)
      && message.type === 'office_checkpoint'
      && isRecord(message.version)
      && message.version.modelRevision === 2
    ))
    if (!(checkpoint.file instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const zip = await JSZip.loadAsync(checkpoint.file)
    const worksheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string')
    if (!worksheetXml) throw new Error('checkpoint is missing the first worksheet')
    const finalColumnWidth = pixelsToCharacterWidth(userColumnPixels)
    expect(worksheetXml).toMatch(
      new RegExp(`<col\\b(?=[^>]*\\bmin="1")(?=[^>]*\\bmax="1")[^>]*\\bwidth="${finalColumnWidth}"`),
    )
    expect(worksheetXml).toContain('<row r="1" ht="36" customHeight="1"')
    expect(worksheetXml).not.toMatch(
      /<col\b(?=[^>]*\bmin="1")(?=[^>]*\bmax="1")[^>]*\bwidth="8"/,
    )
  })
})
