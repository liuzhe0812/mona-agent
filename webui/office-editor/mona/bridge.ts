export type OfficeEditorKind = 'docs' | 'sheets' | 'slides'

export interface DocumentVersion {
  editorEpoch: string
  modelRevision: number
}

export interface OfficeOpenMessage {
  type: 'office_open'
  sessionId: string
  documentType: OfficeEditorKind
  version: DocumentVersion
  file: ArrayBuffer
  pendingVisualSlideIds?: string[]
  pendingReviewTargets?: string[]
}

export interface EngineRangeRequest {
  sheetId: string
  range: {
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  }
}

export type HostMessage =
  | OfficeOpenMessage
  | { type: 'office_command'; command: unknown }
  | { type: 'office_inspect'; command: unknown }
  | { type: 'office_checkpoint_request'; version: DocumentVersion }
  | { type: 'office_engine_response'; requestId: string; ok: true; result: unknown }
  | { type: 'office_engine_response'; requestId: string; ok: false; error: string }

export type EditorMessage =
  | { type: 'office_editor_ready'; sessionId: string; version: DocumentVersion }
  | { type: 'office_user_change'; sessionId: string; version: DocumentVersion; changedTargets: string[]; pendingVisualSlideIds?: string[]; pendingReviewTargets?: string[] }
  | { type: 'office_command_result'; result: unknown }
  | { type: 'office_inspect_result'; result: unknown }
  | { type: 'office_checkpoint'; sessionId: string; version: DocumentVersion; file: ArrayBuffer }
  | { type: 'office_ai_request'; sessionId: string; prompt: string; displayText?: string }
  | { type: 'office_engine_request'; requestId: string; method: 'open' }
  | { type: 'office_engine_request'; requestId: string; method: 'read_range'; payload: EngineRangeRequest }

interface PendingEngineRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class MonaOfficeBridge {
  private port: MessagePort | null = null
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly pendingEngine = new Map<string, PendingEngineRequest>()
  private readonly queuedMessages: HostMessage[] = []

  constructor(readonly kind: OfficeEditorKind) {
    window.addEventListener('message', this.handleConnect)
  }

  onMessage(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    for (const message of this.queuedMessages.splice(0)) listener(message)
    return () => this.listeners.delete(listener)
  }

  post(message: EditorMessage, transfer: Transferable[] = []): void {
    if (!this.port) throw new Error('Mona 编辑器尚未连接宿主。')
    this.port.postMessage(message, transfer)
  }

  async engineOpen(): Promise<unknown> {
    return this.requestEngine({ method: 'open' })
  }

  async engineReadRange(payload: EngineRangeRequest): Promise<unknown> {
    return this.requestEngine({ method: 'read_range', payload })
  }

  close(): void {
    window.removeEventListener('message', this.handleConnect)
    this.port?.close()
    this.port = null
    for (const pending of this.pendingEngine.values()) {
      pending.reject(new Error('Mona 编辑器与宿主的连接已断开。'))
    }
    this.pendingEngine.clear()
  }

  private readonly handleConnect = (event: MessageEvent): void => {
    const parentOriginAllowed = event.origin === window.location.origin || (
      import.meta.env.DEV
      && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(event.origin)
    )
    if (
      event.source !== window.parent ||
      !parentOriginAllowed ||
      !event.data ||
      event.data.type !== 'mona_office_connect' ||
      event.ports.length !== 1
    ) {
      return
    }
    this.port?.close()
    this.port = event.ports[0]
    this.port.onmessage = (portEvent: MessageEvent<HostMessage>) => {
      const message = portEvent.data
      if (message.type === 'office_engine_response') {
        const pending = this.pendingEngine.get(message.requestId)
        if (!pending) return
        this.pendingEngine.delete(message.requestId)
        if (message.ok === true) pending.resolve(message.result)
        else pending.reject(new Error((message as { error: string }).error))
        return
      }
      if (this.listeners.size === 0) this.queuedMessages.push(message)
      else for (const listener of this.listeners) listener(message)
    }
    this.port.start()
  }

  private requestEngine(
    request:
      | { method: 'open' }
      | { method: 'read_range'; payload: EngineRangeRequest },
  ): Promise<unknown> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.pendingEngine.set(requestId, { resolve, reject })
      this.post({
        type: 'office_engine_request',
        requestId,
        ...request,
      } as EditorMessage)
    })
  }
}
