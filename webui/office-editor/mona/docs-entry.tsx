import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { installScreenTips } from '@genoffice/ui'
import {
  App as GenOfficeDocsApp,
  type EmbeddedDocsApi,
  type EmbeddedDocsController,
} from '../vendor/genoffice/apps/docs/src/renderer/App'
import {
  executeCommands,
  type Command,
  type Target,
  type UpdateParagraphStyle,
  type UpdateTextStyle,
} from '../vendor/genoffice/apps/docs/src/renderer/ai/commands'
import { MonaOfficeBridge, type DocumentVersion, type HostMessage, type OfficeOpenMessage } from './bridge'
import { pickBrowserImage } from './browser-file-picker'
import { applyTableStyle, describeDocStyle } from './docs-format'
import { captureEditorElement, VisualVersionConflict } from './visual'
import './docs-editor.css'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/color-picker.css'
import '@genoffice/ui/dropdown.css'
import '../vendor/genoffice/apps/docs/src/renderer/styles.css'
import './ribbon-overflow.css'

if (typeof document.addEventListener === 'function') installScreenTips()

let embeddedSaveDoc: ((data: ArrayBuffer) => Promise<{ ok: boolean; path?: string }>) | null = null

if (!(window as unknown as { desktop?: unknown }).desktop) {
  const embeddedDesktop = {
    getLanguage: async () => 'zh',
    getTheme: async () => 'system',
    onChromePressed: () => () => undefined,
    onLanguageChanged: () => () => undefined,
    onThemeChanged: () => () => undefined,
    onRenamedDocx: () => () => undefined,
    onOpenDocx: () => () => undefined,
    onMenuCommand: () => () => undefined,
    onTeardown: () => () => undefined,
    getRecentFiles: async () => [],
    getAiSettings: async () => ({ provider: 'anthropic', providers: {} }),
    pickImage: pickBrowserImage,
    listDocsTabs: async () => [],
    openNewTab: async () => undefined,
    focusDocsTab: async () => undefined,
    fontMetrics: async () => null,
    fetchImage: async () => null,
    writeRecoveryCopy: async () => ({ ok: true }),
    saveDocx: async (_path: string, data: ArrayBuffer) => embeddedSaveDoc?.(data) ?? { ok: false },
    saveDocxAs: async (_name: string, data: ArrayBuffer) => embeddedSaveDoc?.(data) ?? { ok: false },
    saveDocxNew: async (_name: string, data: ArrayBuffer) => embeddedSaveDoc?.(data) ?? { ok: false },
    setDocPassword: async () => ({ ok: false }),
    docPasswordIntentRevision: async () => 0,
    discardDocPasswordIntents: async () => ({ ok: true }),
  }
  ;(window as unknown as { desktop: Record<string, unknown> }).desktop = new Proxy(embeddedDesktop, {
    get: (target, property) => {
      if (property in target) return target[property as keyof typeof target]
      if (typeof property === 'string' && property.startsWith('on')) return () => () => undefined
      return async () => null
    },
  })
}

const BLOCK_TYPES = ['docParagraph', 'docHeading', 'docListItem', 'docTable', 'docProtected']

const MonaBlockIds = Extension.create({
  name: 'monaBlockIds',
  addGlobalAttributes() {
    return [{
      types: BLOCK_TYPES,
      attributes: { monaId: { default: null, rendered: false } },
    }]
  },
})

interface BlockRecord {
  id: string
  type: string
  text: string
  level?: number
  rows?: string[][]
  pos: number
  size: number
  style: Record<string, unknown>
}

interface DocsCommand {
  sessionId: string
  operationId: string
  expectedVersion: DocumentVersion
  operations: Array<{ op: string; payload: Record<string, unknown> }>
}

interface DocsInspect {
  sessionId: string
  requestId: string
  query: Record<string, unknown>
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

function sameVersion(left: DocumentVersion | null, right: DocumentVersion): boolean {
  return !!left
    && left.editorEpoch === right.editorEpoch
    && left.modelRevision === right.modelRevision
}

function blocksOf(editor: Editor): BlockRecord[] {
  const blocks: BlockRecord[] = []
  editor.state.doc.forEach((node, pos) => {
    const rows: string[][] = []
    if (node.type.name === 'docTable') {
      node.forEach((row) => {
        const cells: string[] = []
        row.forEach((cell) => cells.push(cell.textContent))
        rows.push(cells)
      })
    }
    blocks.push({
      id: String(node.attrs.monaId || (
        typeof node.attrs.docxIndex === 'number' ? `block_${node.attrs.docxIndex}` : `block_${pos}`
      )),
      type: node.type.name,
      text: node.textContent,
      ...(node.type.name === 'docHeading' ? { level: Number(node.attrs.level) || 1 } : {}),
      ...(rows.length > 0 ? { rows } : {}),
      pos,
      size: node.nodeSize,
      style: describeDocStyle(node),
    })
  })
  return blocks
}

function publicBlock(block: BlockRecord) {
  return {
    id: block.id,
    type: block.type === 'docHeading'
      ? 'heading'
      : block.type === 'docListItem'
        ? 'list_item'
        : block.type === 'docTable'
          ? 'table'
          : block.type === 'docProtected'
            ? 'image'
            : 'paragraph',
    text: block.text,
    ...(block.level ? { level: block.level } : {}),
    ...(block.rows ? { rows: block.rows } : {}),
    style: block.style,
  }
}

function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串。`)
  return value
}

function asBlock(editor: Editor, value: unknown): BlockRecord {
  const id = asText(value, 'blockId')
  const block = blocksOf(editor).find((candidate) => candidate.id === id)
  if (!block) throw new Error(`找不到文档块：${id}`)
  return block
}

function asIndex(value: unknown, field: string): number {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 0) throw new Error(`${field} 必须是从 0 开始的整数。`)
  return index
}

function headerFooterPayload(payload: Record<string, unknown>): {
  kind: 'header' | 'footer'
  view: 'default' | 'first' | 'even'
  text: string
  pageNumber?: boolean
} {
  if (payload.kind !== 'header' && payload.kind !== 'footer') {
    throw new Error('页眉页脚 kind 必须是 header 或 footer。')
  }
  const view = payload.view ?? 'default'
  if (view !== 'default' && view !== 'first' && view !== 'even') {
    throw new Error('页眉页脚 view 必须是 default、first 或 even。')
  }
  const text = asText(payload.text, 'text')
  if (payload.pageNumber !== undefined && typeof payload.pageNumber !== 'boolean') {
    throw new Error('页眉页脚 pageNumber 必须是布尔值。')
  }
  return {
    kind: payload.kind,
    view,
    text,
    ...(typeof payload.pageNumber === 'boolean' ? { pageNumber: payload.pageNumber } : {}),
  }
}

function insertionPoint(editor: Editor, afterBlockId: unknown): number {
  if (afterBlockId == null) return editor.state.doc.content.size
  const block = asBlock(editor, afterBlockId)
  return block.pos + block.size
}

function textContent(text: string, fontSizePt = 11, bold = false): JSONContent[] {
  if (!text) return []
  return [{
    type: 'text',
    text,
    marks: [
      {
        type: 'docTextStyle',
        attrs: {
          color: '000000',
          sizeHalfPoints: fontSizePt * 2,
          font: 'Microsoft YaHei',
          fontAscii: 'Arial',
        },
      },
      ...(bold ? [{ type: 'bold' }] : []),
    ],
  }]
}

export function tableRowSplitCount(root: ParentNode): number {
  return new Set(Array.from(root.querySelectorAll(
    '.doc-table .page-gap-cell, .doc-table .page-gap-cut',
  )).map((element) => element.closest('tr')).filter(Boolean)).size
}

function applyOperation(editor: Editor, operation: DocsCommand['operations'][number]): string[] {
  if (!isRecord(operation) || typeof operation.op !== 'string' || !isRecord(operation.payload)) {
    throw new Error('文档操作格式无效。')
  }
  const payload = operation.payload
  if (operation.op === 'set_table_style') {
    const block = asBlock(editor, payload.blockId)
    if (block.type !== 'docTable') throw new Error('指定文档块不是表格。')
    applyTableStyle(editor, block.pos, payload)
    return [block.id]
  }
  if (operation.op === 'replace_block_text') {
    const block = asBlock(editor, payload.blockId)
    if (!['docParagraph', 'docHeading', 'docListItem'].includes(block.type)) {
      throw new Error('当前文档块不支持直接替换文本。')
    }
    const text = asText(payload.text, 'text')
    const node = editor.state.doc.nodeAt(block.pos)
    let marks = node?.marks ?? []
    node?.descendants((child) => {
      if (!child.isText) return true
      marks = child.marks
      return false
    })
    const tr = editor.state.tr.replaceWith(
      block.pos + 1,
      block.pos + block.size - 1,
      text ? editor.state.schema.text(text, marks) : [],
    )
    editor.view.dispatch(tr)
    return [block.id]
  }
  if (operation.op === 'delete_block') {
    const block = asBlock(editor, payload.blockId)
    editor.view.dispatch(editor.state.tr.delete(block.pos, block.pos + block.size))
    return [block.id]
  }
  if (operation.op === 'insert_paragraph' || operation.op === 'insert_title' || operation.op === 'insert_heading') {
    const id = `block_${crypto.randomUUID().replaceAll('-', '')}`
    const text = asText(payload.text, 'text')
    const title = operation.op === 'insert_title'
    const heading = operation.op === 'insert_heading'
    const level = Math.max(1, Math.min(6, Number(payload.level) || 1))
    const headingSize = level === 1 ? 16 : level === 2 ? 13 : 12
    editor.commands.insertContentAt(insertionPoint(editor, payload.afterBlockId), {
      type: heading ? 'docHeading' : 'docParagraph',
      attrs: {
        docxIndex: null,
        monaId: id,
        ...(title
          ? { styleId: 'Title', align: 'center', lineSpacing: 1, spaceBefore: 0, spaceAfter: 240 }
          : heading
            ? {
                level,
                lineSpacing: 1.15,
                spaceBefore: level === 1 ? 240 : 160,
                spaceAfter: 80,
              }
            : { lineSpacing: 1.35, spaceAfter: 120 }),
      },
      content: textContent(text, title ? 22 : heading ? headingSize : 11, title || heading),
    })
    return [id]
  }
  if (operation.op === 'insert_list') {
    if (!Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > 100) {
      throw new Error('列表项必须包含 1–100 项。')
    }
    const kind = payload.kind === 'ordered' ? 'ordered' : 'bullet'
    const ids: string[] = []
    const content = payload.items.map((item) => {
      const id = `block_${crypto.randomUUID().replaceAll('-', '')}`
      ids.push(id)
      return {
        type: 'docListItem',
        attrs: { docxIndex: null, monaId: id, kind, ilvl: 0, lineSpacing: 1.3, spaceAfter: 60 },
        content: textContent(asText(item, 'item')),
      }
    })
    editor.commands.insertContentAt(insertionPoint(editor, payload.afterBlockId), content)
    return ids
  }
  if (operation.op === 'insert_table') {
    if (!Array.isArray(payload.rows) || payload.rows.length === 0 || payload.rows.length > 50) {
      throw new Error('表格必须包含 1–50 行。')
    }
    const rows = payload.rows.map((row) => {
      if (!Array.isArray(row) || row.length === 0 || row.length > 20) {
        throw new Error('表格每行必须包含 1–20 个单元格。')
      }
      return row
    })
    const columnCount = rows[0]!.length
    if (rows.some((row) => row.length !== columnCount)) throw new Error('表格每行列数必须一致。')
    const id = `block_${crypto.randomUUID().replaceAll('-', '')}`
    editor.commands.insertContentAt(insertionPoint(editor, payload.afterBlockId), {
      type: 'docTable',
      attrs: {
        docxIndex: null,
        monaId: id,
        tblAutoFit: 'window',
        cellMar: { top: 120, right: 120, bottom: 120, left: 120 },
        cellMarEdited: true,
      },
      content: rows.map((row, rowIndex) => ({
        type: 'docTableRow',
        attrs: {
          repeatHeader: rowIndex === 0,
          repeatHeaderEdited: true,
          rawTrPr: '<w:trPr><w:cantSplit/></w:trPr>',
        },
        content: row.map((cell) => ({
          type: rowIndex === 0 ? 'docTableHeader' : 'docTableCell',
          attrs: {
            fill: rowIndex === 0 ? 'EAF2F8' : null,
            bold: rowIndex === 0,
            align: rowIndex === 0 ? 'center' : null,
            vAlign: 'center',
            borders: {
              top: { style: 'single', szEighths: 4, color: 'D9D9D9' },
              right: { style: 'single', szEighths: 4, color: 'D9D9D9' },
              bottom: { style: 'single', szEighths: 4, color: 'D9D9D9' },
              left: { style: 'single', szEighths: 4, color: 'D9D9D9' },
            },
          },
          content: [{
            type: 'docParagraph',
            attrs: {
              docxIndex: null,
              monaId: null,
              lineSpacing: 1.2,
              spaceAfter: 0,
              align: rowIndex === 0 ? 'center' : null,
            },
            content: textContent(asText(cell, 'cell'), 10, rowIndex === 0),
          }],
        })),
      })),
    })
    return [id]
  }
  if (operation.op === 'insert_image') {
    const dataUrl = asText(payload.dataUrl, 'dataUrl')
    if (!/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 14_000_000) {
      throw new Error('图片必须是 10MB 以内的 PNG、JPEG 或 GIF 数据地址。')
    }
    const id = `block_${crypto.randomUUID().replaceAll('-', '')}`
    editor.commands.insertContentAt(insertionPoint(editor, payload.afterBlockId), {
      type: 'docProtected',
      attrs: {
        docxIndex: null,
        monaId: id,
        blockType: 'image',
        label: '图片',
        imageDataUrl: dataUrl,
        imageWidthPx: Math.max(1, Math.min(1600, Number(payload.widthPx) || 320)),
        imageHeightPx: Math.max(1, Math.min(1600, Number(payload.heightPx) || 180)),
      },
    })
    return [id]
  }
  if (operation.op === 'set_table_cell') {
    const block = asBlock(editor, payload.blockId)
    if (block.type !== 'docTable') throw new Error('指定文档块不是表格。')
    const rowIndex = asIndex(payload.rowIndex, 'rowIndex')
    const columnIndex = asIndex(payload.columnIndex, 'columnIndex')
    const text = asText(payload.text, 'text')
    const table = editor.state.doc.nodeAt(block.pos)
    if (!table || rowIndex >= table.childCount) throw new Error(`表格不存在第 ${rowIndex + 1} 行。`)
    const row = table.child(rowIndex)
    if (columnIndex >= row.childCount) {
      throw new Error(`表格第 ${rowIndex + 1} 行不存在第 ${columnIndex + 1} 列。`)
    }
    const cell = row.child(columnIndex)
    let rowOffset = 0
    for (let index = 0; index < rowIndex; index++) rowOffset += table.child(index).nodeSize
    let cellOffset = 0
    for (let index = 0; index < columnIndex; index++) cellOffset += row.child(index).nodeSize
    const cellPos = block.pos + 2 + rowOffset + cellOffset
    const paragraphType = editor.state.schema.nodes.docParagraph
    if (!paragraphType) throw new Error('文档表格段落不可用。')
    const currentParagraph = cell.firstChild?.type.name === 'docParagraph' ? cell.firstChild : null
    const paragraph = paragraphType.create(
      currentParagraph ? { ...currentParagraph.attrs, docxIndex: null } : { docxIndex: null },
      text ? editor.state.schema.text(text) : undefined,
    )
    editor.view.dispatch(editor.state.tr.replaceWith(cellPos + 1, cellPos + cell.nodeSize - 1, paragraph))
    return [block.id]
  }
  if (operation.op === 'set_block_style') {
    const block = asBlock(editor, payload.blockId)
    const style = isRecord(payload.style) ? payload.style : {}
    const blockIndex = blocksOf(editor).findIndex((candidate) => candidate.id === block.id)
    const target: Target = { blockIndexes: [blockIndex] }
    const commands: Command[] = []
    const textStyle: UpdateTextStyle['style'] = {}
    const textFields: UpdateTextStyle['fields'] = []
    for (const key of ['bold', 'italic', 'underline', 'strike'] as const) {
      if (typeof style[key] !== 'boolean') continue
      textStyle[key] = style[key]
      textFields.push(key)
    }
    for (const key of ['color', 'highlight', 'font'] as const) {
      if (typeof style[key] !== 'string' && style[key] !== null) continue
      textStyle[key] = style[key] as string | null
      textFields.push(key)
    }
    const sizeHalfPoints = typeof style.sizeHalfPoints === 'number'
      ? style.sizeHalfPoints
      : typeof style.fontSize === 'number'
        ? style.fontSize * 2
        : undefined
    if (sizeHalfPoints !== undefined) {
      textStyle.sizeHalfPoints = Math.max(2, Math.min(400, Math.round(sizeHalfPoints)))
      textFields.push('sizeHalfPoints')
    }
    if (style.baselineOffset === 'SUPERSCRIPT' || style.baselineOffset === 'SUBSCRIPT'
      || style.baselineOffset === 'NONE' || style.baselineOffset === null) {
      textStyle.baselineOffset = style.baselineOffset
      textFields.push('baselineOffset')
    }
    if (textFields.length > 0) commands.push({ updateTextStyle: { target, style: textStyle, fields: textFields } })

    const paragraphStyle: UpdateParagraphStyle['style'] = {}
    const paragraphFields: UpdateParagraphStyle['fields'] = []
    if (style.align === 'left' || style.align === 'center' || style.align === 'right'
      || style.align === 'justify' || style.align === null) {
      paragraphStyle.align = style.align
      paragraphFields.push('align')
    }
    for (const key of [
      'lineSpacing',
      'indentLeft',
      'indentRight',
      'indentFirstLine',
      'spaceBefore',
      'spaceAfter',
    ] as const) {
      if (typeof style[key] !== 'number' && style[key] !== null) continue
      paragraphStyle[key] = style[key] as number | null
      paragraphFields.push(key)
    }
    if (typeof style.pageBreakBefore === 'boolean') {
      paragraphStyle.pageBreakBefore = style.pageBreakBefore
      paragraphFields.push('pageBreakBefore')
    }
    for (const key of ['shadingFill', 'borders'] as const) {
      if (typeof style[key] !== 'string' && style[key] !== null) continue
      paragraphStyle[key] = style[key] as string | null
      paragraphFields.push(key)
    }
    if (paragraphFields.length > 0) {
      commands.push({ updateParagraphStyle: { target, style: paragraphStyle, fields: paragraphFields } })
    }

    if (style.headingLevel !== undefined) {
      const level = Number(style.headingLevel)
      if (!Number.isInteger(level) || level < 0 || level > 6) throw new Error('标题级别必须是 0–6。')
      commands.push({ setHeadingLevel: { target, level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 } })
    }
    if (commands.length === 0) throw new Error('没有可应用的文档样式。')
    const outcome = executeCommands(editor, { commands })
    if (!outcome.ok) throw new Error(outcome.error || '文档样式修改失败。')
    return [block.id]
  }
  throw new Error(`不支持的文档操作：${operation.op}`)
}

function MonaDocsEditor(): React.JSX.Element {
  const bridgeRef = useRef<MonaOfficeBridge | null>(null)
  if (!bridgeRef.current) bridgeRef.current = new MonaOfficeBridge('docs')
  const sessionRef = useRef<OfficeOpenMessage | null>(null)
  const versionRef = useRef<DocumentVersion | null>(null)
  const revisionDocsRef = useRef(new Map<number, () => Promise<Uint8Array | null>>())
  const operationCacheRef = useRef(new Map<string, { fingerprint: string; result: unknown }>())
  const reviewPendingRef = useRef(false)
  const observedReviewVersionRef = useRef<DocumentVersion | null>(null)
  const footerTouchedRef = useRef(false)
  const suppressRef = useRef(false)
  const agentApplyingRef = useRef(false)
  const embeddedApiRef = useRef<EmbeddedDocsApi | null>(null)
  const apiWaitersRef = useRef<Array<(api: EmbeddedDocsApi) => void>>([])
  const [editor, setEditor] = useState<Editor | null>(null)
  const [status, setStatus] = useState('等待 Mona 打开文档…')
  const [error, setError] = useState<string | null>(null)
  const [followPaused, setFollowPaused] = useState(false)

  embeddedSaveDoc = async (data) => {
    const session = sessionRef.current
    const version = versionRef.current
    if (!session || !version) return { ok: false }
    const file = data.slice(0)
    bridgeRef.current?.post({ type: 'office_checkpoint', sessionId: session.sessionId, version, file }, [file])
    return { ok: true, path: `mona://${session.sessionId}` }
  }

  const embeddedController = useMemo<EmbeddedDocsController>(() => ({
    extensions: [MonaBlockIds],
    changed: (target) => {
      const api = embeddedApiRef.current
      const session = sessionRef.current
      const current = versionRef.current
      if (!api || !session || !current || suppressRef.current) return
      const version = { ...current, modelRevision: current.modelRevision + 1 }
      versionRef.current = version
      rememberRevision(version, api.editor.getJSON())
      reviewPendingRef.current = true
      observedReviewVersionRef.current = null
      bridgeRef.current?.post({
        type: 'office_user_change',
        sessionId: session.sessionId,
        version,
        changedTargets: [target],
        pendingReviewTargets: ['document'],
      })
    },
    attach: (api) => {
      embeddedApiRef.current = api
      setEditor(api.editor)
      for (const resolve of apiWaitersRef.current.splice(0)) resolve(api)
      const onUpdate = () => {
        if (suppressRef.current || !sessionRef.current || !versionRef.current) return
        const version = { ...versionRef.current, modelRevision: versionRef.current.modelRevision + 1 }
        versionRef.current = version
        rememberRevision(version, api.editor.getJSON())
        reviewPendingRef.current = true
        observedReviewVersionRef.current = null
        const block = blocksOf(api.editor).find((candidate) => (
          api.editor.state.selection.from >= candidate.pos
          && api.editor.state.selection.from <= candidate.pos + candidate.size
        ))
        bridgeRef.current?.post({
          type: 'office_user_change',
          sessionId: sessionRef.current.sessionId,
          version,
          changedTargets: [block?.id ?? 'document'],
          pendingReviewTargets: ['document'],
        })
      }
      api.editor.on('update', onUpdate)
      return () => {
        api.editor.off('update', onUpdate)
        if (embeddedApiRef.current === api) {
          embeddedApiRef.current = null
          setEditor(null)
        }
      }
    },
  }), [])

  function waitForApi(): Promise<EmbeddedDocsApi> {
    if (embeddedApiRef.current) return Promise.resolve(embeddedApiRef.current)
    return new Promise((resolve) => apiWaitersRef.current.push(resolve))
  }

  function rememberRevision(version: DocumentVersion, content: JSONContent): void {
    void content
    const snapshot = embeddedApiRef.current?.snapshot()
    if (snapshot) revisionDocsRef.current.set(version.modelRevision, snapshot)
    while (revisionDocsRef.current.size > 32) {
      const first = revisionDocsRef.current.keys().next().value
      if (first === undefined) break
      revisionDocsRef.current.delete(first)
    }
  }

  async function openDocument(message: OfficeOpenMessage): Promise<void> {
    if (message.documentType !== 'docs' || !isVersion(message.version)) {
      throw new Error('当前入口不能打开这个文档。')
    }
    setStatus('正在打开文档…')
    setError(null)
    setFollowPaused(false)
    const api = await waitForApi()
    suppressRef.current = true
    sessionRef.current = message
    versionRef.current = message.version
    reviewPendingRef.current = message.pendingReviewTargets?.includes('document') ?? false
    observedReviewVersionRef.current = null
    footerTouchedRef.current = false
    try {
      const outcome = await api.open({
        path: `mona://${message.sessionId}`,
        name: `${message.sessionId}.docx`,
        data: message.file.slice(0),
        hash: '',
      })
      if (outcome !== 'ok') throw new Error('GenOffice 无法打开当前文档。')
    } finally {
      suppressRef.current = false
    }
    revisionDocsRef.current.clear()
    rememberRevision(message.version, api.editor.getJSON())
    setStatus('')
    bridgeRef.current?.post({
      type: 'office_editor_ready',
      sessionId: message.sessionId,
      version: message.version,
    })
  }

  async function checkpoint(version: DocumentVersion): Promise<void> {
    const session = sessionRef.current
    const snapshot = revisionDocsRef.current.get(version.modelRevision)
    const api = embeddedApiRef.current
    if (!session || !api || !snapshot || version.editorEpoch !== versionRef.current?.editorEpoch) return
    const bytes = await snapshot()
    if (!bytes) throw new Error('文档尚未准备好。')
    const file = bytes.slice().buffer as ArrayBuffer
    bridgeRef.current?.post({ type: 'office_checkpoint', sessionId: session.sessionId, version, file }, [file])
  }

  async function inspect(value: unknown): Promise<void> {
    if (!editor || !isRecord(value) || typeof value.sessionId !== 'string'
      || typeof value.requestId !== 'string' || !isRecord(value.query)) return
    const command = value as unknown as DocsInspect
    const session = sessionRef.current
    const version = versionRef.current
    if (!session || !version || command.sessionId !== session.sessionId) return
    try {
      const blocks = blocksOf(editor)
      const mode = command.query.mode
      const currentPageCount = (): number => {
        const debug = (window as unknown as { __pageDebug?: { slices?: unknown[] } }).__pageDebug
        const debugCount = Array.isArray(debug?.slices) ? debug.slices.length : 0
        const boundaries = Array.from(document.querySelectorAll<HTMLElement>(
          '.doc-page .page-gap[data-boundary-y], .doc-page .page-gap-cut[data-boundary-y]',
        )).map((element) => element.dataset.boundaryY).filter(Boolean)
        const domCount = boundaries.length > 0
          ? new Set(boundaries).size + 1
          : document.querySelectorAll('.doc-page .page-gap, .doc-page .page-gap-cut').length + 1
        return Math.max(1, debugCount, domCount)
      }
      const qualityWarnings = (): string[] => {
        const warnings: string[] = []
        const state = embeddedApiRef.current?.readHeaderFooter()
        const footers = state ? [state.footer, state.hfVariants.footerFirst, state.hfVariants.footerEven] : []
        for (const footer of footerTouchedRef.current ? footers : []) {
          if (footer && !footer.pageNumber && /^(?:第\s*)?(?:页|页码|page)$/iu.test(footer.text.trim())) {
            warnings.push('[错误] 页脚包含页码文字但没有 PAGE 字段；请用单次 set_header_footer 写入真实页码。')
            break
          }
        }
        const splitRows = tableRowSplitCount(document)
        if (splitRows > 0) warnings.push(`[需检查] 检测到 ${splitRows} 个表格行跨页拆分；请确认阅读连续性，必要时调整列宽、内容或禁止拆行。`)
        return warnings
      }
      let result: unknown
      if (mode === 'summary') {
        const state = embeddedApiRef.current?.readHeaderFooter()
        const pageCount = currentPageCount()
        const lightHeaderFooter = (value: { text: string; pageNumber?: boolean } | null) => (
          value ? { text: value.text, pageNumber: value.pageNumber === true } : null
        )
        result = {
          mode,
          documentType: 'docs',
          blockCount: blocks.length,
          characterCount: blocks.reduce((sum, block) => sum + block.text.length, 0),
          headingCount: blocks.filter((block) => block.type === 'docHeading').length,
          tableCount: blocks.filter((block) => block.type === 'docTable').length,
          imageCount: blocks.filter((block) => block.type === 'docProtected').length,
          pageCount,
          warnings: qualityWarnings(),
          headerFooter: state ? {
            header: lightHeaderFooter(state.header),
            footer: lightHeaderFooter(state.footer),
            headerFirst: lightHeaderFooter(state.hfVariants.headerFirst),
            footerFirst: lightHeaderFooter(state.hfVariants.footerFirst),
            headerEven: lightHeaderFooter(state.hfVariants.headerEven),
            footerEven: lightHeaderFooter(state.hfVariants.footerEven),
          } : null,
          pageSettings: embeddedApiRef.current?.pageSettings().map((settings, sectionIndex) => ({
            sectionIndex,
            widthMm: settings.pageWidth * 25.4 / 1440,
            heightMm: settings.pageHeight * 25.4 / 1440,
            marginTopMm: settings.marginTop * 25.4 / 1440,
            marginBottomMm: settings.marginBottom * 25.4 / 1440,
            marginLeftMm: settings.marginLeft * 25.4 / 1440,
            marginRightMm: settings.marginRight * 25.4 / 1440,
          })) ?? [],
        }
      } else if (mode === 'selection') {
        const { from, to } = editor.state.selection
        result = {
          mode, documentType: 'docs',
          blockIds: blocks.filter((block) => block.pos < to && block.pos + block.size > from).map((block) => block.id),
          text: editor.state.doc.textBetween(from, to, '\n').slice(0, 10000),
        }
      } else if (mode === 'visual') {
        const pages = document.querySelectorAll<HTMLElement>('.doc-page')
        const pageCount = currentPageCount()
        const pageIndex = command.query.pageIndex == null ? null : asIndex(command.query.pageIndex, 'pageIndex')
        const element = pageIndex === null
          ? document.querySelector<HTMLElement>('.editor-scroll') ?? editor.view.dom
          : pages[pageIndex]
        if (!element) throw new Error('指定页尚未显示，请使用当前视图检查。')
        const fullDocument = pageIndex === 0 && pages.length === 1
        const acceptWarnings = command.query.acceptWarnings === true
        const reviewReason = typeof command.query.reviewReason === 'string' ? command.query.reviewReason.trim() : ''
        if (acceptWarnings && (!fullDocument || !reviewReason
          || !sameVersion(observedReviewVersionRef.current, version))) {
          throw new Error('接受文档提示前请先查看当前版本的完整连续文档，并通过 reviewReason 说明保留理由。')
        }
        const captured = await captureEditorElement(element, pageIndex === null ? 'viewport' : `page:${pageIndex}`, version, () => versionRef.current)
        const warnings = [...captured.warnings, ...qualityWarnings()]
        if (fullDocument) observedReviewVersionRef.current = { ...version }
        const blocking = warnings.some((warning) => warning.startsWith('[错误]'))
        if (fullDocument && !blocking && (warnings.length === 0 || acceptWarnings)) reviewPendingRef.current = false
        if (pageIndex !== null && pages.length === 1 && pageCount > 1) {
          result = {
            ...captured,
            target: 'document:continuous',
            warnings: [...warnings, `当前画面是包含 ${pageCount} 页的连续文档，请检查全部分页内容。`],
            pendingReviewTargets: reviewPendingRef.current ? ['document'] : [],
            ...(acceptWarnings ? { reviewReason } : {}),
          }
        } else result = {
          ...captured,
          warnings,
          pendingReviewTargets: reviewPendingRef.current ? ['document'] : [],
          ...(acceptWarnings ? { reviewReason } : {}),
        }
      } else if (mode === 'review') {
        result = {
          mode,
          documentType: 'docs',
          pendingTargets: reviewPendingRef.current ? ['document'] : [],
          warnings: qualityWarnings(),
        }
      } else if (mode === 'outline') {
        result = { mode, items: blocks.filter((block) => block.type === 'docHeading').map(publicBlock) }
      } else if (mode === 'search') {
        const text = asText(command.query.text, 'text').toLocaleLowerCase()
        const limit = Math.max(1, Math.min(100, Number(command.query.limit) || 20))
        result = {
          mode,
          matches: blocks
            .filter((block) => block.text.toLocaleLowerCase().includes(text))
            .slice(0, limit)
            .map(publicBlock),
        }
      } else if (mode === 'blocks') {
        if (!Array.isArray(command.query.blockIds)) throw new Error('文档块标识必须是数组。')
        const ids = new Set(command.query.blockIds.map(String))
        result = { mode, blocks: blocks.filter((block) => ids.has(block.id)).map(publicBlock) }
      } else {
        throw new Error(`文档不支持此检查模式：${String(mode)}`)
      }
      bridgeRef.current?.post({
        type: 'office_inspect_result',
        result: { ok: true, requestId: command.requestId, sessionId: session.sessionId, version, result },
      })
    } catch (reason) {
      bridgeRef.current?.post({
        type: 'office_inspect_result',
        result: {
          ok: false,
          requestId: command.requestId,
          sessionId: session.sessionId,
          currentVersion: version,
          error: {
            code: reason instanceof VisualVersionConflict ? 'VERSION_CONFLICT' : 'INVALID_OPERATION',
            message: reason instanceof Error ? reason.message : '无法读取文档。',
            retryable: reason instanceof VisualVersionConflict,
          },
        },
      })
    }
  }

  function revealChangedBlock(changedTargets: string[]): void {
    if (!editor || followPaused) return
    const target = [...changedTargets].reverse().find((id) => id.startsWith('block_'))
    const block = target ? blocksOf(editor).find((candidate) => candidate.id === target) : undefined
    if (!block) return
    const position = Math.min(block.pos + 1, editor.state.doc.content.size)
    const selection = TextSelection.near(editor.state.doc.resolve(position), 1)
    editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView())
  }

  function apply(value: unknown): void {
    if (!editor || !isRecord(value) || typeof value.sessionId !== 'string'
      || typeof value.operationId !== 'string' || !isVersion(value.expectedVersion)
      || !Array.isArray(value.operations)) return
    const command = value as unknown as DocsCommand
    const session = sessionRef.current
    const currentVersion = versionRef.current
    if (!session || !currentVersion || command.sessionId !== session.sessionId) return
    const fingerprint = JSON.stringify(command)
    const cached = operationCacheRef.current.get(command.operationId)
    if (cached) {
      if (cached.fingerprint === fingerprint) bridgeRef.current?.post({ type: 'office_command_result', result: cached.result })
      return
    }
    if (!sameVersion(currentVersion, command.expectedVersion)) {
      const result = {
        ok: false,
        sessionId: session.sessionId,
        operationId: command.operationId,
        currentVersion,
        changedTargets: [],
        error: { code: 'VERSION_CONFLICT', message: '文档已发生变化，请重新读取相关区域。', retryable: true },
      }
      revealChangedBlock(result.changedTargets)
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
      return
    }
    if (command.operations.length === 0 || command.operations.length > 50) return
    const api = embeddedApiRef.current
    if (!api) return
    const before = editor.getJSON()
    const pagesBefore = api.pageSettings()
    const headerFooterBefore = api.readHeaderFooter()
    const changedTargets: string[] = []
    agentApplyingRef.current = true
    suppressRef.current = true
    try {
      for (const operation of command.operations) {
        if (operation.op === 'set_header_footer') headerFooterPayload(operation.payload)
      }
      for (const operation of command.operations) {
        if (operation.op === 'set_header_footer') {
          const payload = headerFooterPayload(operation.payload)
          const state = api.readHeaderFooter()
          const variant = `${payload.kind}${payload.view === 'first' ? 'First' : 'Even'}` as
            | 'headerFirst' | 'footerFirst' | 'headerEven' | 'footerEven'
          const existing = payload.view === 'default'
            ? state[payload.kind]
            : state.hfVariants[variant]
          api.setHeaderFooter(
            payload.kind,
            { text: payload.text, pageNumber: payload.pageNumber ?? existing?.pageNumber ?? false },
            payload.view,
          )
          changedTargets.push(`document:${payload.kind}`)
        } else if (operation.op === 'set_page_style') {
          const payload = operation.payload
          const index = payload.sectionIndex == null ? 0 : asIndex(payload.sectionIndex, 'sectionIndex')
          const settings = api.pageSettings()[index]
          if (!settings) throw new Error('找不到指定的文档节。')
          const next = { ...settings }
          const fields = {
            widthMm: 'pageWidth', heightMm: 'pageHeight', marginTopMm: 'marginTop',
            marginBottomMm: 'marginBottom', marginLeftMm: 'marginLeft', marginRightMm: 'marginRight',
          } as const
          for (const [key, field] of Object.entries(fields)) {
            if (payload[key] === undefined) continue
            const value = Number(payload[key])
            if (!Number.isFinite(value) || value < 0 || value > 1000) throw new Error(`页面设置 ${key} 无效。`)
            next[field] = Math.round(value * 1440 / 25.4)
          }
          if (next.pageWidth <= next.marginLeft + next.marginRight || next.pageHeight <= next.marginTop + next.marginBottom) {
            throw new Error('页边距不能占满页面。')
          }
          next.orientation = next.pageWidth > next.pageHeight ? 'landscape' : 'portrait'
          api.setPageSettings(index, next)
          changedTargets.push(`document:section:${index}`)
        } else changedTargets.push(...applyOperation(editor, operation))
      }
      const version = { ...currentVersion, modelRevision: currentVersion.modelRevision + 1 }
      versionRef.current = version
      rememberRevision(version, editor.getJSON())
      reviewPendingRef.current = true
      observedReviewVersionRef.current = null
      if (command.operations.some((operation) => operation.op === 'set_header_footer')) {
        footerTouchedRef.current = true
      }
      const result = {
        ok: true,
        sessionId: session.sessionId,
        operationId: command.operationId,
        version,
        changedTargets: [...new Set(changedTargets)],
        summary: `已完成 ${command.operations.length} 项文档修改`,
        pendingReviewTargets: ['document'],
      }
      revealChangedBlock(result.changedTargets)
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
    } catch (reason) {
      editor.commands.setContent(before, { emitUpdate: false })
      pagesBefore.forEach((settings, index) => api.setPageSettings(index, settings))
      api.restoreHeaderFooter(headerFooterBefore)
      const result = {
        ok: false,
        sessionId: session.sessionId,
        operationId: command.operationId,
        currentVersion,
        changedTargets: [],
        error: {
          code: 'INVALID_OPERATION',
          message: reason instanceof Error ? reason.message : '文档修改失败。',
          retryable: false,
        },
      }
      operationCacheRef.current.set(command.operationId, { fingerprint, result })
      bridgeRef.current?.post({ type: 'office_command_result', result })
    } finally {
      suppressRef.current = false
      agentApplyingRef.current = false
    }
  }

  useEffect(() => {
    const bridge = bridgeRef.current!
    return bridge.onMessage((message: HostMessage) => {
      if (message.type === 'office_open') void openDocument(message).catch((reason) => {
        setError(reason instanceof Error ? reason.message : '文档打开失败。')
        setStatus('')
      })
      else if (message.type === 'office_checkpoint_request') void checkpoint(message.version).catch((reason) => {
        setError(reason instanceof Error ? reason.message : '文档保存失败。')
      })
      else if (message.type === 'office_inspect') inspect(message.command)
      else if (message.type === 'office_command') apply(message.command)
    })
  })

  useEffect(() => () => {
    embeddedSaveDoc = null
    bridgeRef.current?.close()
  }, [])

  return (
    <main
      className="mona-docs-editor"
      data-editor-kind="docs"
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
      <GenOfficeDocsApp embeddedController={embeddedController} />
      {(error || status) ? (
        <div className="mona-docs-status" role={error ? 'alert' : 'status'}>{error ?? status}</div>
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

export function mountDocsEntry(): void {
  const root = document.getElementById('root')
  if (!root) throw new Error('缺少应用根节点。')
  createRoot(root).render(<MonaDocsEditor />)
}
