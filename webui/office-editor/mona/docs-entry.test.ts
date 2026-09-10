// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildBlankDocx, parseDocx, readSectionSettings } from '@genoffice/docx-engine'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const bridgeState = vi.hoisted(() => ({
  bridges: [] as Array<{
    listener?: (message: unknown) => void
    posts: unknown[]
    emit: (message: unknown) => void
  }>,
}))

vi.mock('./bridge', () => ({
  MonaOfficeBridge: class {
    listener?: (message: unknown) => void
    posts: unknown[] = []

    constructor() {
      bridgeState.bridges.push(this)
    }

    onMessage(listener: (message: unknown) => void): () => void {
      this.listener = listener
      return () => {
        if (this.listener === listener) this.listener = undefined
      }
    }

    post(message: unknown): void {
      this.posts.push(message)
    }

    close(): void {}

    emit(message: unknown): void {
      this.listener?.(message)
    }
  },
}))

import { mountDocsEntry } from './docs-entry'

function flush(delay = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay))
}

function latestPost(bridge: { posts: unknown[] }, type: string): Record<string, unknown> {
  const message = [...bridge.posts].reverse().find((item) => (
    typeof item === 'object' && item !== null && 'type' in item && item.type === type
  ))
  if (!message || typeof message !== 'object') throw new Error(`missing ${type}`)
  return message as Record<string, unknown>
}

function resultOf(bridge: { posts: unknown[] }, type: string): Record<string, unknown> {
  const message = latestPost(bridge, type)
  const result = message.result
  if (!result || typeof result !== 'object') throw new Error(`missing ${type} result`)
  return result as Record<string, unknown>
}

function versionOf(result: Record<string, unknown>): { editorEpoch: string; modelRevision: number } {
  const version = result.version
  if (!version || typeof version !== 'object') throw new Error('missing result version')
  return version as { editorEpoch: string; modelRevision: number }
}

function parsedBlockText(block: {
  runs?: Array<{ text: string }>
  table?: { rows: Array<Array<{ richParas?: Array<{ runs: Array<{ text: string }> }> }>> }
}): string {
  const runs = (block.runs ?? []).map((run) => run.text).join('')
  const table = (block.table?.rows ?? [])
    .flatMap((row) => row.flatMap((cell) => (cell.richParas ?? []).flatMap((para) => para.runs.map((run) => run.text))))
    .join('')
  return `${runs}${table}`
}

describe('Mona Docs entry', () => {
  afterEach(() => {
    bridgeState.bridges.length = 0
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('parses a real blank docx, applies structured operations atomically, and reparses a checkpoint', async () => {
    const blank = await buildBlankDocx({ eastAsiaFont: 'Microsoft YaHei' })
    const parsedBlank = await parseDocx(blank)
    expect(parsedBlank.blocks.length).toBeGreaterThan(0)
    expect(parsedBlockText(parsedBlank.blocks[0]!)).toBe('')

    document.body.innerHTML = '<div id="root"></div>'
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    await act(async () => {
      mountDocsEntry()
      await flush()
    })
    const bridge = bridgeState.bridges[0]
    if (!bridge) throw new Error('Docs bridge was not created')
    expect(bridge.listener).toBeTypeOf('function')
    const initialVersion = { editorEpoch: 'epoch-docs', modelRevision: 0 }

    await act(async () => {
      bridge.emit({
        type: 'office_open',
        sessionId: 'docs-session',
        documentType: 'docs',
        version: initialVersion,
        file: blank.buffer.slice(blank.byteOffset, blank.byteOffset + blank.byteLength),
      })
      await flush(100)
      await flush(100)
    })
    expect(bridge.posts).toContainEqual(expect.objectContaining({
      type: 'office_editor_ready',
      sessionId: 'docs-session',
      version: initialVersion,
    }))
    expect(document.querySelector('.ProseMirror')).not.toBeNull()
    expect(document.querySelector('.ribbon')).not.toBeNull()
    const ribbonTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.ribbon-tab'))
    const ribbonTab = (label: string) => ribbonTabs.find((button) => button.textContent?.trim() === label)
    expect(ribbonTabs.map((button) => button.textContent?.trim())).toEqual(expect.arrayContaining([
      '开始',
      '插入',
      '绘图',
      '设计',
      '布局',
      '引用',
      '审阅',
      '视图',
    ]))
    expect(ribbonTab('文件')).toBeUndefined()
    expect(document.querySelector('.file-menu')).toBeNull()
    expect(document.querySelector('.autosave-toggle')).toBeNull()
    expect(document.querySelector('.qa-btn[aria-label^="保存"]')).toBeNull()
    expect(document.querySelector('.qa-btn[aria-label="撤销"]')).not.toBeNull()
    expect(document.querySelector('.qa-btn[aria-label="恢复"]')).not.toBeNull()
    expect(ribbonTab('开始')).toBeDefined()
    expect(ribbonTab('开始')?.disabled).toBe(false)

    await act(async () => {
      ribbonTab('审阅')?.click()
      await flush()
    })
    const reviewText = document.querySelector('.ribbon-body')?.textContent ?? ''
    expect(reviewText).not.toContain('编辑器')
    expect(reviewText).not.toContain('翻译')
    expect(reviewText).not.toContain('AI 处理批注')
    expect(reviewText).not.toContain('AI 总结修订')

    await act(async () => {
      ribbonTab('视图')?.click()
      await flush()
    })
    const viewText = document.querySelector('.ribbon-body')?.textContent ?? ''
    expect(viewText).not.toContain('AI 面板')
    expect(viewText).not.toContain('新建标签')
    expect(viewText).not.toContain('切换标签')
    expect(viewText).toContain('拆分')
    expect(document.querySelector('.mona-follow-button')).toBeNull()

    await act(async () => {
      ribbonTab('开始')?.click()
      await flush()
    })

    const sendCommand = async (
      operationId: string,
      expectedVersion: { editorEpoch: string; modelRevision: number },
      operations: Array<{ op: string; payload: Record<string, unknown> }>,
    ): Promise<Record<string, unknown>> => {
      await act(async () => {
        bridge.emit({
          type: 'office_command',
          command: {
            sessionId: 'docs-session',
            operationId,
            expectedVersion,
            operations,
          },
        })
        await flush()
        await flush()
      })
      return resultOf(bridge, 'office_command_result')
    }

    const heading = await sendCommand('heading-1', initialVersion, [{
      op: 'insert_heading',
      payload: { text: '销售报告', level: 1, afterBlockId: 'block_0' },
    }])
    expect(heading.ok).toBe(true)
    const headingId = String((heading.changedTargets as string[])[0])
    const v1 = versionOf(heading)

    const list = await sendCommand('list-1', v1, [{
      op: 'insert_list',
      payload: { kind: 'bullet', items: ['第一项', '第二项'], afterBlockId: headingId },
    }])
    expect(list.ok).toBe(true)
    const listIds = list.changedTargets as string[]
    expect(listIds).toHaveLength(2)
    const v2 = versionOf(list)

    const table = await sendCommand('table-1', v2, [{
      op: 'insert_table',
      payload: { rows: [['月份', '金额'], ['一月', '100']], afterBlockId: listIds[1] },
    }])
    expect(table.ok).toBe(true)
    const tableId = String((table.changedTargets as string[])[0])
    const v3 = versionOf(table)

    await act(async () => {
      bridge.emit({
        type: 'office_inspect',
        command: {
          sessionId: 'docs-session',
          requestId: 'table-after-insert',
          query: { mode: 'blocks', blockIds: [tableId] },
        },
      })
      await flush()
    })
    const tableAfterInsert = resultOf(bridge, 'office_inspect_result')
    expect(tableAfterInsert.result).toEqual(expect.objectContaining({
      mode: 'blocks',
      blocks: [expect.objectContaining({
        id: tableId,
        type: 'table',
        rows: [['月份', '金额'], ['一月', '100']],
      })],
    }))

    const updatedTableCell = await sendCommand('table-cell-1', v3, [{
      op: 'set_table_cell',
      payload: { blockId: tableId, rowIndex: 1, columnIndex: 1, text: '120' },
    }])
    expect(updatedTableCell.ok).toBe(true)
    expect(updatedTableCell.changedTargets).toEqual([tableId])
    const v3Cell = versionOf(updatedTableCell)

    const styled = await sendCommand('style-1', v3Cell, [{
      op: 'set_block_style',
      payload: {
        blockId: headingId,
        style: {
          bold: true,
          align: 'center',
          headingLevel: 2,
          underline: true,
          color: 'C00000',
          fontSize: 18,
          spaceAfter: 240,
        },
      },
    }])
    expect(styled.ok).toBe(true)
    expect(styled.changedTargets).toEqual([headingId])
    const v4 = versionOf(styled)

    const replaced = await sendCommand('replace-1', v4, [{
      op: 'replace_block_text',
      payload: { blockId: headingId, text: '月度销售报告' },
    }])
    expect(replaced.ok).toBe(true)
    expect(replaced.changedTargets).toEqual([headingId])
    const v5 = versionOf(replaced)

    await act(async () => {
      bridge.emit({
        type: 'office_inspect',
        command: {
          sessionId: 'docs-session',
          requestId: 'summary-1',
          query: { mode: 'summary' },
        },
      })
      await flush()
    })
    const summary = resultOf(bridge, 'office_inspect_result')
    expect(summary.ok).toBe(true)
    expect(summary.result).toEqual(expect.objectContaining({
      mode: 'summary',
      documentType: 'docs',
      headingCount: 1,
      tableCount: 1,
    }))

    await act(async () => {
      bridge.emit({
        type: 'office_inspect',
        command: {
          sessionId: 'docs-session',
          requestId: 'outline-1',
          query: { mode: 'outline' },
        },
      })
      await flush()
    })
    const outline = resultOf(bridge, 'office_inspect_result')
    expect(outline.result).toEqual(expect.objectContaining({
      mode: 'outline',
      items: [expect.objectContaining({ id: headingId, text: '月度销售报告', level: 2 })],
    }))

    await act(async () => {
      bridge.emit({
        type: 'office_inspect',
        command: {
          sessionId: 'docs-session',
          requestId: 'blocks-1',
          query: { mode: 'blocks', blockIds: [headingId, tableId] },
        },
      })
      await flush()
    })
    const blocks = resultOf(bridge, 'office_inspect_result')
    expect(blocks.result).toEqual(expect.objectContaining({
      mode: 'blocks',
      blocks: expect.arrayContaining([
        expect.objectContaining({ id: headingId, type: 'heading', text: '月度销售报告' }),
        expect.objectContaining({ id: tableId, type: 'table', text: '月份金额一月120' }),
      ]),
    }))

    const beforeAtomicFailure = v5
    const failed = await sendCommand('rollback-1', beforeAtomicFailure, [
      { op: 'replace_block_text', payload: { blockId: headingId, text: '不应保留' } },
      { op: 'unsupported', payload: {} },
    ])
    expect(failed.ok).toBe(false)
    expect(failed.currentVersion).toEqual(beforeAtomicFailure)
    expect((failed.error as Record<string, unknown>).code).toBe('INVALID_OPERATION')

    await act(async () => {
      bridge.emit({
        type: 'office_inspect',
        command: {
          sessionId: 'docs-session',
          requestId: 'blocks-after-rollback',
          query: { mode: 'blocks', blockIds: [headingId] },
        },
      })
      await flush()
    })
    const afterRollback = resultOf(bridge, 'office_inspect_result')
    expect(afterRollback.result).toEqual(expect.objectContaining({
      blocks: [expect.objectContaining({ id: headingId, text: '月度销售报告' })],
    }))

    const fullEditor = (window as unknown as {
      __aidocs?: { editor?: { chain: () => { focus: () => { insertContent: (text: string) => { run: () => void } } } } }
    }).__aidocs?.editor
    if (!fullEditor) throw new Error('GenOffice Docs 完整编辑器没有暴露编辑实例。')
    await act(async () => {
      fullEditor.chain().focus().insertContent('完整界面编辑').run()
      await flush()
    })
    const userChange = latestPost(bridge, 'office_user_change')
    const finalVersion = userChange.version as { editorEpoch: string; modelRevision: number }
    expect(finalVersion.modelRevision).toBe(v5.modelRevision + 1)

    await act(async () => {
      bridge.emit({ type: 'office_checkpoint_request', version: finalVersion })
      await flush(500)
      await flush(500)
    })
    const checkpoint = latestPost(bridge, 'office_checkpoint')
    expect(checkpoint).toEqual(expect.objectContaining({
      sessionId: 'docs-session',
      version: finalVersion,
    }))
    const checkpointBytes = checkpoint.file
    if (!(checkpointBytes instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const reparsed = await parseDocx(new Uint8Array(checkpointBytes))
    expect(reparsed.blocks.map(parsedBlockText)).toEqual(expect.arrayContaining([
      '月度销售报告',
      '第一项',
      '第二项',
      '月份金额一月120完整界面编辑',
    ]))
    expect(reparsed.blocks.filter((block) => block.type === 'listItem').every((block) => (
      block.list?.kind === 'bullet'
    ))).toBe(true)
    expect(reparsed.blocks.some((block) => block.table)).toBe(true)
    const reparsedHeading = reparsed.blocks.find((block) => parsedBlockText(block) === '月度销售报告')
    expect(reparsedHeading).toEqual(expect.objectContaining({
      level: 2,
      format: expect.objectContaining({ spaceAfter: 240 }),
    }))
    expect(reparsedHeading?.runs?.[0]).toEqual(expect.objectContaining({
      underline: true,
      color: 'C00000',
      sizeHalfPoints: 36,
    }))
  })

  it('keeps page, table, inspection, and historical checkpoint semantics across real editing', async () => {
    const blank = await buildBlankDocx({ eastAsiaFont: 'Microsoft YaHei' })
    document.body.innerHTML = '<div id="root"></div>'
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    await act(async () => {
      mountDocsEntry()
      await flush()
    })
    const bridge = bridgeState.bridges[0]
    if (!bridge) throw new Error('Docs bridge was not created')
    const initialVersion = { editorEpoch: 'epoch-professional', modelRevision: 0 }

    await act(async () => {
      bridge.emit({
        type: 'office_open',
        sessionId: 'professional-session',
        documentType: 'docs',
        version: initialVersion,
        file: blank.buffer.slice(blank.byteOffset, blank.byteOffset + blank.byteLength),
      })
      await flush(100)
      await flush(100)
    })

    const sendCommand = async (
      operationId: string,
      expectedVersion: { editorEpoch: string; modelRevision: number },
      operations: Array<{ op: string; payload: Record<string, unknown> }>,
    ): Promise<Record<string, unknown>> => {
      await act(async () => {
        bridge.emit({
          type: 'office_command',
          command: {
            sessionId: 'professional-session',
            operationId,
            expectedVersion,
            operations,
          },
        })
        await flush()
        await flush()
      })
      return resultOf(bridge, 'office_command_result')
    }

    const inspect = async (requestId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> => {
      await act(async () => {
        bridge.emit({
          type: 'office_inspect',
          command: {
            sessionId: 'professional-session',
            requestId,
            query,
          },
        })
        await flush()
      })
      return resultOf(bridge, 'office_inspect_result')
    }

    const page = await sendCommand('professional-page', initialVersion, [{
      op: 'set_page_style',
      payload: {
        widthMm: 210,
        heightMm: 297,
        marginTopMm: 20,
        marginBottomMm: 20,
        marginLeftMm: 18,
        marginRightMm: 18,
      },
    }])
    expect(page.ok).toBe(true)
    let version = versionOf(page)

    const heading = await sendCommand('professional-heading', version, [{
      op: 'insert_heading',
      payload: { text: '专业标题', level: 1, afterBlockId: 'block_0' },
    }])
    expect(heading.ok).toBe(true)
    const headingId = String((heading.changedTargets as string[])[0])
    version = versionOf(heading)

    const paragraph = await sendCommand('professional-paragraph', version, [{
      op: 'insert_paragraph',
      payload: { text: '说明段落', afterBlockId: headingId },
    }])
    expect(paragraph.ok).toBe(true)
    const paragraphId = String((paragraph.changedTargets as string[])[0])
    version = versionOf(paragraph)

    const table = await sendCommand('professional-table', version, [{
      op: 'insert_table',
      payload: { rows: [['项目', '金额'], ['一月', '100']], afterBlockId: paragraphId },
    }])
    expect(table.ok).toBe(true)
    const tableId = String((table.changedTargets as string[])[0])
    version = versionOf(table)

    const styledHeading = await sendCommand('professional-heading-style', version, [{
      op: 'set_block_style',
      payload: {
        blockId: headingId,
        style: { bold: true, color: 'C00000', fontSize: 18, align: 'center', spaceAfter: 240 },
      },
    }])
    expect(styledHeading.ok).toBe(true)
    version = versionOf(styledHeading)

    const styledTable = await sendCommand('professional-table-style', version, [{
      op: 'set_table_style',
      payload: {
        blockId: tableId,
        columnWidths: [180, 240],
        headerRows: 1,
        headerFill: '#D9EAF7',
        bodyFill: '#FFFFFF',
        borderColor: '#9DC3E6',
        cellPadding: 8,
      },
    }])
    expect(styledTable.ok).toBe(true)
    const headerFooter = await sendCommand('professional-header-footer', versionOf(styledTable), [
      {
        op: 'set_header_footer',
        payload: { kind: 'header', text: '默认页眉', pageNumber: false },
      },
      {
        op: 'set_header_footer',
        payload: { kind: 'footer', text: '默认页脚', pageNumber: true },
      },
    ])
    expect(headerFooter.ok).toBe(true)
    expect(headerFooter.changedTargets).toEqual(expect.arrayContaining([
      'document:header',
      'document:footer',
    ]))
    const preservePageNumber = await sendCommand(
      'professional-footer-text-preserves-page-number',
      versionOf(headerFooter),
      [{ op: 'set_header_footer', payload: { kind: 'footer', text: '更新后的默认页脚' } }],
    )
    expect(preservePageNumber.ok).toBe(true)
    const historicalVersion = versionOf(preservePageNumber)

    const summary = await inspect('professional-summary', { mode: 'summary' })
    expect(summary.ok).toBe(true)
    const summaryResult = summary.result as {
      blockCount: number
      headingCount: number
      tableCount: number
      headerFooter: {
        header: { text: string; pageNumber: boolean } | null
        footer: { text: string; pageNumber: boolean } | null
      }
      pageSettings: Array<Record<string, number>>
    }
    expect(summaryResult.blockCount).toBeGreaterThanOrEqual(4)
    expect(summaryResult.headingCount).toBeGreaterThanOrEqual(1)
    expect(summaryResult.tableCount).toBe(1)
    expect(summaryResult.headerFooter).toEqual(expect.objectContaining({
      header: { text: '默认页眉', pageNumber: false },
      footer: { text: '更新后的默认页脚', pageNumber: true },
    }))

    const invalidHeaderFooter = await sendCommand('professional-invalid-header-footer', historicalVersion, [
      {
        op: 'set_header_footer',
        payload: { kind: 'header', text: '不应部分写入' },
      },
      {
        op: 'set_header_footer',
        payload: { kind: 'aside', text: '无效操作' },
      },
    ])
    expect(invalidHeaderFooter.ok).toBe(false)
    expect((invalidHeaderFooter.error as Record<string, unknown>).code).toBe('INVALID_OPERATION')
    const afterInvalidHeaderFooter = await inspect('professional-after-invalid-header-footer', { mode: 'summary' })
    expect((afterInvalidHeaderFooter.result as { headerFooter: { header: { text: string } } })
      .headerFooter.header.text).toBe('默认页眉')
    const pageSettings = summaryResult.pageSettings[0]
    expect(pageSettings).toBeDefined()
    expect(pageSettings.widthMm).toBeCloseTo(210, 1)
    expect(pageSettings.heightMm).toBeCloseTo(297, 1)
    expect(pageSettings.marginTopMm).toBeCloseTo(20, 1)
    expect(pageSettings.marginBottomMm).toBeCloseTo(20, 1)
    expect(pageSettings.marginLeftMm).toBeCloseTo(18, 1)
    expect(pageSettings.marginRightMm).toBeCloseTo(18, 1)

    const blocksInspection = await inspect('professional-blocks', {
      mode: 'blocks',
      blockIds: [headingId, paragraphId, tableId],
    })
    expect(blocksInspection.result).toEqual(expect.objectContaining({
      mode: 'blocks',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          id: headingId,
          type: 'heading',
          text: '专业标题',
          style: expect.objectContaining({
            fontFamily: null,
            fontSizePt: 18,
            color: '#C00000',
            bold: true,
            paragraph: expect.objectContaining({ align: 'center', spaceAfterPt: 12 }),
          }),
        }),
        expect.objectContaining({ id: paragraphId, type: 'paragraph', text: '说明段落' }),
        expect.objectContaining({
          id: tableId,
          type: 'table',
          rows: [['项目', '金额'], ['一月', '100']],
        }),
      ]),
    }))

    type AutomationEditor = {
      state: {
        doc: {
          descendants: (callback: (node: { attrs?: Record<string, unknown>; content: { size: number } }, pos: number) => boolean | void) => void
        }
      }
      commands: { setTextSelection: (selection: number | { from: number; to: number }) => boolean }
      chain: () => { focus: () => { insertContent: (text: string) => { run: () => boolean } } }
    }
    const fullEditor = (window as unknown as { __aidocs?: { editor?: AutomationEditor } }).__aidocs?.editor
    if (!fullEditor) throw new Error('GenOffice Docs 完整编辑器没有暴露编辑实例。')
    let headingFrom = -1
    let headingTo = -1
    fullEditor.state.doc.descendants((node, pos) => {
      if (node.attrs?.monaId !== headingId) return true
      headingFrom = pos + 1
      headingTo = headingFrom + node.content.size
      return false
    })
    if (headingFrom < 0 || headingTo < 0) throw new Error('找不到标题位置。')
    fullEditor.commands.setTextSelection({ from: headingFrom, to: headingTo })
    const selection = await inspect('professional-selection', { mode: 'selection' })
    expect(selection.result).toEqual(expect.objectContaining({
      mode: 'selection',
      blockIds: [headingId],
      text: '专业标题',
    }))

    await act(async () => {
      bridge.emit({ type: 'office_checkpoint_request', version: historicalVersion })
      await flush(500)
      await flush(500)
    })
    const checkpoint = latestPost(bridge, 'office_checkpoint')
    expect(checkpoint.version).toEqual(historicalVersion)
    const checkpointBytes = checkpoint.file
    if (!(checkpointBytes instanceof ArrayBuffer)) throw new Error('checkpoint is not an ArrayBuffer')
    const reparsed = await parseDocx(new Uint8Array(checkpointBytes))
    const section = readSectionSettings(reparsed)
    expect(section).toMatchObject({
      pageWidth: 11906,
      pageHeight: 16838,
      marginTop: 1134,
      marginBottom: 1134,
      marginLeft: 1020,
      marginRight: 1020,
    })
    expect(reparsed.blocks.some((block) => parsedBlockText(block) === '专业标题')).toBe(true)
    expect(reparsed.blocks.some((block) => parsedBlockText(block) === '说明段落')).toBe(true)
    expect(reparsed.headerText).toBe('默认页眉')
    expect(reparsed.footerText).toContain('更新后的默认页脚')
    expect(reparsed.footerHasPageNumber).toBe(true)
    expect(reparsed.headerHasPageNumber).toBe(false)
    const reparsedTable = reparsed.blocks.find((block) => block.table)?.table
    expect(reparsedTable?.colWidthsTwips).toEqual([2700, 3600])
    expect(reparsedTable?.cellMarTwips).toEqual({ top: 120, right: 120, bottom: 120, left: 120 })
    expect(reparsedTable?.repeatHeaderRows).toEqual([true, false])
    expect(reparsedTable?.rows[0]?.[0]?.fill).toBe('D9EAF7')
    expect(reparsedTable?.rows[0]?.[0]?.borders?.top?.color).toBe('9DC3E6')

    fullEditor.commands.setTextSelection(headingTo)
    await act(async () => {
      fullEditor.chain().focus().insertContent('用户真实输入').run()
      await flush()
      await flush()
    })
    const userChange = latestPost(bridge, 'office_user_change')
    const latestVersion = versionOf(userChange)
    expect(latestVersion.modelRevision).toBe(historicalVersion.modelRevision + 1)

    const stale = await sendCommand('professional-stale-command', historicalVersion, [{
      op: 'set_header_footer',
      payload: { kind: 'header', text: '不应修改', pageNumber: true },
    }])
    expect(stale.ok).toBe(false)
    expect((stale.error as Record<string, unknown>).code).toBe('VERSION_CONFLICT')

    const afterStaleHeader = await inspect('professional-after-stale-header', { mode: 'summary' })
    expect((afterStaleHeader.result as { headerFooter: { header: { text: string } } }).headerFooter.header.text)
      .toBe('默认页眉')

    const latestSearch = await inspect('professional-latest-search', { mode: 'search', text: '用户真实输入' })
    expect(latestSearch.result).toEqual(expect.objectContaining({
      mode: 'search',
      matches: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('用户真实输入') })]),
    }))

    await act(async () => {
      bridge.emit({ type: 'office_checkpoint_request', version: historicalVersion })
      await flush(500)
      await flush(500)
    })
    const historicalCheckpoint = latestPost(bridge, 'office_checkpoint')
    const historicalBytes = historicalCheckpoint.file
    if (!(historicalBytes instanceof ArrayBuffer)) throw new Error('historical checkpoint is not an ArrayBuffer')
    const historicalParsed = await parseDocx(new Uint8Array(historicalBytes))
    expect(historicalParsed.blocks.map(parsedBlockText).join('')).not.toContain('用户真实输入')
    expect(historicalParsed.headerText).toBe('默认页眉')
    expect(historicalParsed.footerText).toContain('更新后的默认页脚')
    expect(historicalParsed.footerHasPageNumber).toBe(true)

    const afterHistorical = await inspect('professional-after-historical', { mode: 'search', text: '用户真实输入' })
    expect(versionOf(afterHistorical)).toEqual(latestVersion)
    expect(afterHistorical.result).toEqual(expect.objectContaining({
      matches: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('用户真实输入') })]),
    }))
  })
})
