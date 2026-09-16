import type {
  DocumentVersion,
  OfficeApplyCommand,
  OfficeCommandResult,
  OfficeDocumentType,
  OfficeEngineRangeRequest,
  OfficeInspectCommand,
  OfficeInspectResponse,
} from "./types";

export type HostToOfficeEditorMessage =
  | { type: "office_open"; sessionId: string; documentType: OfficeDocumentType; version: DocumentVersion; file: ArrayBuffer; pendingVisualSlideIds?: string[]; pendingReviewTargets?: string[] }
  | { type: "office_command"; command: OfficeApplyCommand }
  | { type: "office_inspect"; command: OfficeInspectCommand }
  | { type: "office_checkpoint_request"; version: DocumentVersion }
  | { type: "office_engine_response"; requestId: string; ok: true; result: unknown }
  | { type: "office_engine_response"; requestId: string; ok: false; error: string };

export type OfficeEditorToHostMessage =
  | { type: "office_editor_ready"; sessionId: string; version: DocumentVersion }
  | { type: "office_user_change"; sessionId: string; version: DocumentVersion; changedTargets: string[]; pendingVisualSlideIds?: string[]; pendingReviewTargets?: string[] }
  | { type: "office_command_result"; result: OfficeCommandResult }
  | { type: "office_inspect_result"; result: OfficeInspectResponse }
  | { type: "office_checkpoint"; sessionId: string; version: DocumentVersion; file: ArrayBuffer }
  | { type: "office_ai_request"; sessionId: string; prompt: string; displayText?: string }
  | { type: "office_engine_request"; requestId: string; method: "open" }
  | { type: "office_engine_request"; requestId: string; method: "read_range"; payload: OfficeEngineRangeRequest };

export interface OfficeEditorBridge {
  post: (message: HostToOfficeEditorMessage, transfer?: Transferable[]) => void;
  close: () => void;
}

export function connectOfficeEditor(
  frame: HTMLIFrameElement,
  onMessage: (message: OfficeEditorToHostMessage) => void,
): OfficeEditorBridge {
  const target = frame.contentWindow;
  if (!target) throw new Error("编辑器尚未加载。");
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<OfficeEditorToHostMessage>) => {
    onMessage(event.data);
  };
  channel.port1.start();
  target.postMessage({ type: "mona_office_connect" }, new URL(frame.src).origin, [channel.port2]);
  return {
    post: (message, transfer = []) => channel.port1.postMessage(message, transfer),
    close: () => channel.port1.close(),
  };
}
