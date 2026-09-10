import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  closeOfficeSession,
  createOfficeSocketTicket,
  getOfficeSession,
  getOfficeSocketUrl,
  getOfficeWorkingFile,
  openOfficeEngine,
  OfficeClientError,
  readOfficeEngineRange,
  saveOfficeSession,
  uploadOfficeCheckpoint,
} from "@/lib/office-client";
import { isTauri } from "@/lib/tauri";

import { OfficeEditorFrame } from "./OfficeEditorFrame";
import { OfficeEditorToolbar, type OfficeEditorActivity } from "./OfficeEditorToolbar";
import { connectOfficeEditor, type OfficeEditorBridge, type OfficeEditorToHostMessage } from "./office-bridge";
import { useOfficeSessionStore } from "./office-session-store";
import type { DocumentVersion, OfficeSessionState, OfficeSocketMessage } from "./types";

interface OfficeEditorHostProps {
  initialSession: OfficeSessionState;
  ownerSessionKey: string;
  onClosed: (sessionId: string) => void;
  onExported?: (fileName: string) => void;
  exportDirectory?: string | null;
  generating?: boolean;
  stopping?: boolean;
  onAiRequest?: (prompt: string, displayText?: string) => void;
  toolbarContainer?: HTMLElement | null;
}

type PendingActionInput =
  | { type: "save" }
  | { type: "export"; output: string };
type PendingAction = PendingActionInput & { version: DocumentVersion };

function sameVersion(left: DocumentVersion | null, right: DocumentVersion): boolean {
  return !!left
    && left.editorEpoch === right.editorEpoch
    && left.modelRevision === right.modelRevision;
}

function versionAtLeast(current: DocumentVersion, expected: DocumentVersion): boolean {
  return current.editorEpoch === expected.editorEpoch
    && current.modelRevision >= expected.modelRevision;
}

function messageVersion(message: OfficeEditorToHostMessage): DocumentVersion | null {
  if (message.type === "office_command_result") {
    return message.result.ok ? message.result.version : message.result.currentVersion;
  }
  if (message.type === "office_inspect_result") {
    return message.result.ok ? message.result.version : message.result.currentVersion;
  }
  return "version" in message ? message.version : null;
}

function commandActivity(message: Extract<OfficeSocketMessage, { event: "office_command" }>): OfficeEditorActivity {
  const operations = message.command.operations;
  if (operations.some((operation) => operation.op === "set_formula")) return "formula";
  if (operations.every((operation) => operation.op === "set_style" || operation.op === "set_block_style")) {
    return "formatting";
  }
  if (operations.some((operation) => operation.op.startsWith("insert_") || operation.op.startsWith("slide_add"))) {
    return "writing";
  }
  return "editing";
}

function exportFormat(type: OfficeSessionState["type"]): { name: string; extension: string } {
  if (type === "docs") return { name: "Word 文档", extension: "docx" };
  if (type === "slides") return { name: "PowerPoint 演示文稿", extension: "pptx" };
  return { name: "Excel 工作簿", extension: "xlsx" };
}

export function OfficeEditorHost({
  initialSession,
  ownerSessionKey,
  onClosed,
  onExported,
  exportDirectory,
  generating = false,
  stopping = false,
  onAiRequest,
  toolbarContainer,
}: OfficeEditorHostProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<OfficeEditorBridge | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef(initialSession);
  const connectedFrameRef = useRef(false);
  const editorReadyRef = useRef(false);
  const generationRef = useRef(0);
  const generatingRef = useRef(generating);
  generatingRef.current = generating;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkpointIdleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkpointMaxTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkpointRequestRef = useRef<DocumentVersion | null>(null);
  const pendingCheckpointRef = useRef<DocumentVersion | null>(null);
  const flushCheckpointRef = useRef<() => void>(() => undefined);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const pendingSocketMessagesRef = useRef<string[]>([]);
  const connectRef = useRef<(renewEditor: boolean) => void>(() => undefined);
  const [session, setSession] = useState(initialSession);
  const [activity, setActivity] = useState<OfficeEditorActivity>("preparing");
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<"reconnect" | "checkpoint" | "action">("reconnect");
  const [exportedFileName, setExportedFileName] = useState<string | null>(null);
  const [generationStopped, setGenerationStopped] = useState(false);
  const [participatingTurn, setParticipatingTurn] = useState(false);
  const upsertSession = useOfficeSessionStore((state) => state.upsert);
  const removeSession = useOfficeSessionStore((state) => state.remove);

  const updateSession = useCallback((next: OfficeSessionState) => {
    sessionRef.current = next;
    setSession(next);
    upsertSession(next);
  }, [upsertSession]);

  const updateSessionFromServer = useCallback((next: OfficeSessionState) => {
    const local = sessionRef.current;
    if (
      local.version.editorEpoch === next.version.editorEpoch
      && local.version.modelRevision > next.version.modelRevision
    ) {
      updateSession({
        ...next,
        version: local.version,
        dirty: true,
        saveState: "dirty",
      });
      return;
    }
    updateSession(next);
  }, [updateSession]);

  const sendSocketMessage = useCallback((message: object) => {
    const serialized = JSON.stringify(message);
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    } else {
      pendingSocketMessagesRef.current.push(serialized);
    }
  }, []);

  const flushSocketMessages = useCallback((socket: WebSocket) => {
    for (const message of pendingSocketMessagesRef.current.splice(0)) socket.send(message);
  }, []);

  const flushCheckpoint = useCallback(() => {
    if (checkpointRequestRef.current) return;
    const version = pendingCheckpointRef.current;
    const bridge = bridgeRef.current;
    if (!version || !bridge) return;
    if (checkpointIdleTimerRef.current) clearTimeout(checkpointIdleTimerRef.current);
    if (checkpointMaxTimerRef.current) clearTimeout(checkpointMaxTimerRef.current);
    checkpointIdleTimerRef.current = undefined;
    checkpointMaxTimerRef.current = undefined;
    pendingCheckpointRef.current = null;
    checkpointRequestRef.current = version;
    setError(null);
    setActivity("saving");
    bridge.post({ type: "office_checkpoint_request", version });
  }, []);
  flushCheckpointRef.current = flushCheckpoint;

  const scheduleCheckpoint = useCallback((
    version: DocumentVersion,
    immediate = false,
  ) => {
    const pending = pendingCheckpointRef.current;
    if (
      !pending
      || pending.editorEpoch !== version.editorEpoch
      || pending.modelRevision <= version.modelRevision
    ) {
      pendingCheckpointRef.current = version;
    }
    if (immediate) {
      flushCheckpoint();
      return;
    }
    if (checkpointIdleTimerRef.current) clearTimeout(checkpointIdleTimerRef.current);
    checkpointIdleTimerRef.current = setTimeout(flushCheckpoint, 2000);
    checkpointMaxTimerRef.current ??= setTimeout(flushCheckpoint, 5000);
  }, [flushCheckpoint]);

  const performAction = useCallback(async (action: PendingAction) => {
    if (action.type === "save") {
      await saveOfficeSession(sessionRef.current.sessionId, ownerSessionKey, {
        overwriteSource: false,
        version: action.version,
      });
    } else {
      const file = await getOfficeWorkingFile(sessionRef.current.sessionId, ownerSessionKey);
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(action.output, new Uint8Array(file));
      const fileName = action.output.split(/[\\/]/).at(-1) || sessionRef.current.displayName;
      setExportedFileName(fileName);
      onExported?.(fileName);
    }
  }, [onExported, ownerSessionKey]);

  const uploadCheckpoint = useCallback(async (
    version: DocumentVersion,
    file: ArrayBuffer,
  ) => {
    setActivity("saving");
    let uploaded = false;
    try {
      await uploadOfficeCheckpoint(sessionRef.current.sessionId, ownerSessionKey, version, file);
      uploaded = true;
      const pending = pendingActionRef.current;
      if (pending && versionAtLeast(version, pending.version)) {
        await performAction({ ...pending, version });
        pendingActionRef.current = null;
      }
      updateSession(await getOfficeSession(sessionRef.current.sessionId, ownerSessionKey));
      setError(null);
    } catch (reason) {
      if (uploaded) {
        setErrorAction("action");
      } else {
        const pending = pendingCheckpointRef.current;
        if (!pending || !versionAtLeast(pending, version)) {
          pendingCheckpointRef.current = version;
        }
        setErrorAction("checkpoint");
      }
      const message = reason instanceof Error ? reason.message : "文件保存失败。";
      setError(message);
    } finally {
      if (checkpointRequestRef.current && versionAtLeast(version, checkpointRequestRef.current)) {
        checkpointRequestRef.current = null;
      }
      setActivity("idle");
      if (uploaded && pendingCheckpointRef.current) {
        queueMicrotask(() => flushCheckpointRef.current());
      }
    }
  }, [ownerSessionKey, performAction, updateSession]);

  const handleEditorMessage = useCallback((message: OfficeEditorToHostMessage) => {
    const current = sessionRef.current;
    if ("sessionId" in message && message.sessionId !== current.sessionId) return;
    const version = messageVersion(message);
    if (version && version.editorEpoch !== current.version.editorEpoch) return;
    if (message.type === "office_ai_request") {
      onAiRequest?.(message.prompt, message.displayText);
    } else if (message.type === "office_engine_request") {
      void (async () => {
        try {
          const result = message.method === "open"
            ? await openOfficeEngine(current.sessionId, ownerSessionKey)
            : await readOfficeEngineRange(current.sessionId, ownerSessionKey, message.payload);
          bridgeRef.current?.post({
            type: "office_engine_response",
            requestId: message.requestId,
            ok: true,
            result,
          });
        } catch (reason) {
          bridgeRef.current?.post({
            type: "office_engine_response",
            requestId: message.requestId,
            ok: false,
            error: reason instanceof Error ? reason.message : "表格数据读取失败。",
          });
        }
      })();
    } else if (message.type === "office_editor_ready") {
      editorReadyRef.current = true;
      setActivity("idle");
      sendSocketMessage({ event: "office_editor_ready", sessionId: current.sessionId, version: message.version });
      queueMicrotask(() => flushCheckpointRef.current());
    } else if (message.type === "office_user_change") {
      setExportedFileName(null);
      updateSession({
        ...current,
        version: message.version,
        dirty: true,
        saveState: "dirty",
      });
      sendSocketMessage({
        event: "office_user_change",
        sessionId: current.sessionId,
        version: message.version,
        changedTargets: message.changedTargets,
        ...(message.pendingVisualSlideIds ? { pendingVisualSlideIds: message.pendingVisualSlideIds } : {}),
      });
      scheduleCheckpoint(message.version);
    } else if (message.type === "office_command_result") {
      setActivity("idle");
      sendSocketMessage({ event: "office_command_result", result: message.result });
      if (message.result.ok && !message.result.unchanged) {
        setExportedFileName(null);
        updateSession({
          ...current,
          version: message.result.version,
          dirty: true,
          saveState: "dirty",
        });
        scheduleCheckpoint(message.result.version);
      }
    } else if (message.type === "office_inspect_result") {
      sendSocketMessage({ event: "office_inspect_result", result: message.result });
    } else if (message.type === "office_checkpoint") {
      void uploadCheckpoint(message.version, message.file);
    }
  }, [onAiRequest, ownerSessionKey, scheduleCheckpoint, sendSocketMessage, updateSession, uploadCheckpoint]);

  const connect = useCallback(async (renewEditor: boolean) => {
    const generation = ++generationRef.current;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (renewEditor || !editorReadyRef.current) {
      bridgeRef.current?.close();
      bridgeRef.current = null;
    }
    socketRef.current?.close();
    socketRef.current = null;
    if (checkpointRequestRef.current) {
      pendingCheckpointRef.current = checkpointRequestRef.current;
      checkpointRequestRef.current = null;
    }
    setError(null);
    setErrorAction("reconnect");
    setActivity("preparing");
    try {
      const ticket = await createOfficeSocketTicket(
        initialSession.sessionId,
        ownerSessionKey,
        { renewEditor },
      );
      const [nextSession, file, socketUrl] = await Promise.all([
        getOfficeSession(initialSession.sessionId, ownerSessionKey),
        getOfficeWorkingFile(initialSession.sessionId, ownerSessionKey),
        getOfficeSocketUrl(ticket.ticket),
      ]);
      if (generation !== generationRef.current) return;
      updateSession(nextSession);
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;
      socket.onmessage = (event) => {
        if (generation !== generationRef.current || typeof event.data !== "string") return;
        let message: OfficeSocketMessage;
        try {
          message = JSON.parse(event.data) as OfficeSocketMessage;
        } catch {
          setError("编辑器连接返回了无效数据。");
          return;
        }
        if (message.event === "office_session_open") {
          updateSessionFromServer(message.session);
          const frame = frameRef.current;
          if (!frame) return;
          const previousBridge = bridgeRef.current;
          const bridge = connectOfficeEditor(frame, handleEditorMessage);
          bridgeRef.current = bridge;
          previousBridge?.close();
          if (editorReadyRef.current && !renewEditor) {
            socket.send(JSON.stringify({
              event: "office_editor_ready",
              sessionId: message.session.sessionId,
              version: message.session.version,
            }));
            flushSocketMessages(socket);
            queueMicrotask(() => flushCheckpointRef.current());
          } else {
            bridge.post(
              {
                type: "office_open",
                sessionId: message.session.sessionId,
                documentType: message.session.type,
                version: message.session.version,
                file,
                ...(message.session.pendingVisualSlideIds ? { pendingVisualSlideIds: message.session.pendingVisualSlideIds } : {}),
              },
              [file],
            );
          }
        } else if (message.event === "office_session_state") {
          updateSessionFromServer(message.session);
        } else if (message.event === "office_command") {
          if (message.command.sessionId !== sessionRef.current.sessionId) return;
          if (generatingRef.current) setParticipatingTurn(true);
          setActivity(commandActivity(message));
          bridgeRef.current?.post({ type: "office_command", command: message.command });
        } else if (message.event === "office_inspect_command") {
          if (message.command.sessionId !== sessionRef.current.sessionId) return;
          bridgeRef.current?.post({ type: "office_inspect", command: message.command });
        } else if (message.event === "office_checkpoint_request") {
          if (message.sessionId !== sessionRef.current.sessionId) return;
          scheduleCheckpoint(message.version, true);
        } else if (message.event === "office_session_closed") {
          removeSession(message.sessionId);
          onClosed(message.sessionId);
        }
      };
      socket.onclose = () => {
        if (generation !== generationRef.current) return;
        reconnectTimerRef.current = setTimeout(() => connectRef.current(false), 1000);
      };
      socket.onerror = () => {
        setErrorAction("reconnect");
        setError("编辑器连接中断，正在重新连接。");
      };
    } catch (reason) {
      if (generation !== generationRef.current) return;
      if (reason instanceof OfficeClientError && reason.code === "SESSION_NOT_FOUND") {
        removeSession(initialSession.sessionId);
        onClosed(initialSession.sessionId);
        return;
      }
      setErrorAction("reconnect");
      const message = reason instanceof OfficeClientError || reason instanceof Error
        ? reason.message
        : "编辑器加载失败。";
      setError(message);
    }
  }, [flushSocketMessages, handleEditorMessage, initialSession.sessionId, onClosed, ownerSessionKey, removeSession, scheduleCheckpoint, updateSession, updateSessionFromServer]);
  connectRef.current = (renewEditor) => void connect(renewEditor);

  useEffect(() => {
    updateSession(initialSession);
  }, [initialSession, updateSession]);

  useEffect(() => {
    generatingRef.current = generating;
    if (generating) {
      setParticipatingTurn(false);
      setGenerationStopped(false);
    }
  }, [generating]);

  useEffect(() => {
    if (stopping && participatingTurn) setGenerationStopped(true);
  }, [participatingTurn, stopping]);

  useEffect(() => () => {
    generationRef.current += 1;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (checkpointIdleTimerRef.current) clearTimeout(checkpointIdleTimerRef.current);
    if (checkpointMaxTimerRef.current) clearTimeout(checkpointMaxTimerRef.current);
    bridgeRef.current?.close();
    socketRef.current?.close();
  }, []);

  const requestCheckpoint = useCallback((action: PendingActionInput) => {
    const pending = { ...action, version: sessionRef.current.version } as PendingAction;
    pendingActionRef.current = pending;
    if (sameVersion(sessionRef.current.checkpointVersion, pending.version)) {
      setActivity("saving");
      void (async () => {
        try {
          await performAction(pending);
          pendingActionRef.current = null;
          updateSession(await getOfficeSession(sessionRef.current.sessionId, ownerSessionKey));
          setError(null);
        } catch (reason) {
          setErrorAction("action");
          setError(reason instanceof Error ? reason.message : "文件保存失败。");
        } finally {
          setActivity("idle");
        }
      })();
      return;
    }
    const bridge = bridgeRef.current;
    if (!bridge) {
      setError("编辑器尚未准备好。");
      return;
    }
    scheduleCheckpoint(pending.version, true);
  }, [performAction, scheduleCheckpoint, updateSession]);

  const requestExport = useCallback(async () => {
    if (!isTauri()) {
      setError("仅 Mona 桌面端支持选择导出位置。");
      return;
    }
    const { name, extension } = exportFormat(sessionRef.current.type);
    const defaultPath = exportDirectory
      ? `${exportDirectory.replace(/[\\/]$/, "")}/${sessionRef.current.displayName}`
      : sessionRef.current.displayName;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const output = await save({
      title: `导出 ${name}`,
      defaultPath,
      filters: [{ name, extensions: [extension] }],
    });
    if (output) requestCheckpoint({ type: "export", output });
  }, [exportDirectory, requestCheckpoint]);

  const retryPendingAction = useCallback(() => {
    const pending = pendingActionRef.current;
    if (!pending) return;
    setActivity("saving");
    void (async () => {
      try {
        await performAction(pending);
        pendingActionRef.current = null;
        updateSession(await getOfficeSession(sessionRef.current.sessionId, ownerSessionKey));
        setError(null);
      } catch (reason) {
        setErrorAction("action");
        setError(reason instanceof Error ? reason.message : "文件保存失败。");
      } finally {
        setActivity("idle");
      }
    })();
  }, [ownerSessionKey, performAction, updateSession]);

  const handleClose = useCallback(async () => {
    try {
      await closeOfficeSession(session.sessionId, ownerSessionKey);
      removeSession(session.sessionId);
      onClosed(session.sessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "编辑器关闭失败。");
    }
  }, [onClosed, ownerSessionKey, removeSession, session.sessionId]);

  const displayedActivity: OfficeEditorActivity = activity === "idle"
    ? generationStopped
      ? "stopped"
      : generating && participatingTurn
        ? "generating"
        : "idle"
    : activity;
  const toolbar = (
    <OfficeEditorToolbar
      session={session}
      activity={displayedActivity}
      exportedFileName={exportedFileName}
      onSave={() => requestCheckpoint({ type: "save" })}
      onExport={() => void requestExport()}
      onClose={() => void handleClose()}
      compact={toolbarContainer !== undefined}
    />
  );
  return (
    <section className="flex h-full min-h-0 flex-col bg-[hsl(var(--editor-surface))]" data-testid="office-editor-host">
      {toolbarContainer === undefined ? toolbar : toolbarContainer ? createPortal(toolbar, toolbarContainer) : null}
      {error ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-caption text-destructive" role="alert">
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              if (errorAction === "checkpoint") flushCheckpointRef.current();
              else if (errorAction === "action") retryPendingAction();
              else connectRef.current(false);
            }}
          >
            {errorAction === "checkpoint" || errorAction === "action" ? "重试保存" : "重新连接"}
          </Button>
        </div>
      ) : null}
      {!error && session.lastError ? (
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-caption text-foreground" role="status">
          {session.lastError.message}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <OfficeEditorFrame
          ref={frameRef}
          documentType={session.type}
          onLoad={() => {
            const renew = connectedFrameRef.current;
            connectedFrameRef.current = true;
            if (renew) {
              editorReadyRef.current = false;
              pendingSocketMessagesRef.current = [];
            }
            connectRef.current(renew);
          }}
        />
      </div>
    </section>
  );
}
