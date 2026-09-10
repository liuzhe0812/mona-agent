import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficeEditorHost } from "./OfficeEditorHost";
import type { OfficeEditorToHostMessage } from "./office-bridge";
import type { OfficeSessionState, OfficeSocketMessage } from "./types";

const state = vi.hoisted(() => ({
  frameOnLoad: undefined as (() => void) | undefined,
  editorHandler: undefined as ((message: OfficeEditorToHostMessage) => void) | undefined,
  bridgePosts: [] as unknown[],
  socket: undefined as TestSocket | undefined,
  uploadOfficeCheckpoint: vi.fn(),
  saveOfficeSession: vi.fn(),
  getOfficeWorkingFile: vi.fn(),
  saveDialog: vi.fn(),
  writeFile: vi.fn(),
  getOfficeSession: vi.fn(),
}));

vi.mock("./OfficeEditorFrame", () => ({
  OfficeEditorFrame: forwardRef<HTMLIFrameElement, { onLoad: () => void }>((props, ref) => {
    useImperativeHandle(ref, () => ({}) as HTMLIFrameElement);
    state.frameOnLoad = props.onLoad;
    return null;
  }),
}));

vi.mock("./office-bridge", () => ({
  connectOfficeEditor: vi.fn((_frame: HTMLIFrameElement, handler: (message: OfficeEditorToHostMessage) => void) => {
    state.editorHandler = handler;
    return {
      post: (message: unknown) => state.bridgePosts.push(message),
      close: vi.fn(),
    };
  }),
}));

vi.mock("@/lib/office-client", () => ({
  OfficeClientError: class OfficeClientError extends Error {},
  closeOfficeSession: vi.fn(),
  createOfficeSocketTicket: vi.fn(async () => ({ ticket: "ticket-1" })),
  getOfficeSession: state.getOfficeSession,
  getOfficeSocketUrl: vi.fn(async () => "ws://office.test/socket"),
  getOfficeWorkingFile: state.getOfficeWorkingFile,
  openOfficeEngine: vi.fn(),
  readOfficeEngineRange: vi.fn(),
  saveOfficeSession: state.saveOfficeSession,
  uploadOfficeCheckpoint: state.uploadOfficeCheckpoint,
}));

vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: state.saveDialog }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: state.writeFile }));

class TestSocket {
  static readonly OPEN = 1;
  readonly readyState = TestSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    state.socket = this;
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {}

  emit(message: OfficeSocketMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function officeSession(overrides: Partial<OfficeSessionState> = {}): OfficeSessionState {
  return {
    sessionId: "office-1",
    displayName: "销售计划.xlsx",
    type: "sheets",
    version: { editorEpoch: "epoch-1", modelRevision: 0 },
    checkpointVersion: { editorEpoch: "epoch-1", modelRevision: 0 },
    savedVersion: { editorEpoch: "epoch-1", modelRevision: 0 },
    dirty: false,
    editorConnected: false,
    saveState: "clean",
    lastError: null,
    ...overrides,
  };
}

function recoveredSession(): OfficeSessionState {
  return officeSession({
    sessionId: "office-recovered",
    displayName: "恢复中的文档.docx",
    type: "docs",
    version: { editorEpoch: "epoch-1", modelRevision: 3 },
    checkpointVersion: { editorEpoch: "epoch-1", modelRevision: 3 },
    savedVersion: null,
    dirty: true,
    saveState: "dirty",
    lastError: {
      code: "CHECKPOINT_FAILED",
      message: "应用异常退出，已恢复到最近一次保存点；其后的未保存修改未能恢复。",
      retryable: false,
    },
  });
}

describe("OfficeEditorHost", () => {
  beforeEach(() => {
    state.frameOnLoad = undefined;
    state.editorHandler = undefined;
    state.bridgePosts = [];
    state.socket = undefined;
    state.uploadOfficeCheckpoint.mockReset();
    state.saveOfficeSession.mockReset();
    state.getOfficeWorkingFile.mockReset();
    state.getOfficeWorkingFile.mockResolvedValue(new ArrayBuffer(4));
    state.saveDialog.mockReset();
    state.writeFile.mockReset();
    state.getOfficeSession.mockReset();
    vi.stubGlobal("WebSocket", TestSocket);
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    ["docs", "项目说明.docx"],
    ["sheets", "销售计划.xlsx"],
    ["slides", "产品介绍.pptx"],
  ] as const)("moves %s actions into the host toolbar without rendering a file row", (type, displayName) => {
    const toolbarContainer = document.createElement("div");
    document.body.append(toolbarContainer);
    const { container, unmount } = render(
      <OfficeEditorHost
        initialSession={officeSession({ type, displayName })}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
        toolbarContainer={toolbarContainer}
      />,
    );

    const controls = within(toolbarContainer);
    expect(controls.getByText("正在准备文档")).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(controls.getByRole("button", { name: "导出" })).toBeInTheDocument();
    expect(controls.queryByRole("button", { name: "关闭编辑器" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(displayName);

    unmount();
    toolbarContainer.remove();
  });

  it("shows a Chinese recovery notice without exposing the internal error code", () => {
    render(
      <OfficeEditorHost
        initialSession={recoveredSession()}
        ownerSessionKey="websocket:chat-recovered"
        onClosed={() => undefined}
      />,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("应用异常退出，已恢复到最近一次保存点");
    expect(notice).not.toHaveTextContent("CHECKPOINT_FAILED");
    expect(screen.getByText("已恢复")).toBeInTheDocument();
  });

  it("checkpoints in the background and offers a real retry when upload fails", async () => {
    vi.useFakeTimers();
    const initial = officeSession();
    const edited = officeSession({
      version: { editorEpoch: "epoch-1", modelRevision: 1 },
      checkpointVersion: { editorEpoch: "epoch-1", modelRevision: 1 },
      savedVersion: { editorEpoch: "epoch-1", modelRevision: 0 },
      dirty: true,
      saveState: "dirty",
      editorConnected: true,
    });
    state.uploadOfficeCheckpoint
      .mockRejectedValueOnce(new Error("保存点上传失败。"))
      .mockResolvedValueOnce({});
    state.getOfficeSession.mockResolvedValue(edited);

    render(
      <OfficeEditorHost
        initialSession={initial}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
      />,
    );

    await act(async () => state.frameOnLoad?.());
    await act(async () => Promise.resolve());
    const socket = state.socket;
    if (!socket) throw new Error("socket was not created");
    act(() => socket.emit({ event: "office_session_open", session: initial }));
    act(() => state.editorHandler?.({
      type: "office_editor_ready",
      sessionId: initial.sessionId,
      version: initial.version,
    }));
    act(() => state.editorHandler?.({
      type: "office_user_change",
      sessionId: initial.sessionId,
      version: { editorEpoch: "epoch-1", modelRevision: 1 },
      changedTargets: ["Sheet1!A1"],
    }));

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(state.bridgePosts).toContainEqual({
      type: "office_checkpoint_request",
      version: { editorEpoch: "epoch-1", modelRevision: 1 },
    });

    await act(async () => state.editorHandler?.({
      type: "office_checkpoint",
      sessionId: initial.sessionId,
      version: { editorEpoch: "epoch-1", modelRevision: 1 },
      file: new ArrayBuffer(8),
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("保存点上传失败");
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(state.bridgePosts.filter((message) => (
      typeof message === "object" && message !== null && "type" in message
      && message.type === "office_checkpoint_request"
    ))).toHaveLength(2);

    await act(async () => state.editorHandler?.({
      type: "office_checkpoint",
      sessionId: initial.sessionId,
      version: { editorEpoch: "epoch-1", modelRevision: 1 },
      file: new ArrayBuffer(8),
    }));
    await act(async () => Promise.resolve());
    expect(state.uploadOfficeCheckpoint).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reconnects the socket without reopening and overwriting the live editor model", async () => {
    vi.useFakeTimers();
    const initial = officeSession();
    state.getOfficeSession.mockResolvedValue(initial);

    render(
      <OfficeEditorHost
        initialSession={initial}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
      />,
    );

    await act(async () => state.frameOnLoad?.());
    await act(async () => Promise.resolve());
    const firstSocket = state.socket;
    if (!firstSocket) throw new Error("first socket was not created");
    act(() => firstSocket.emit({ event: "office_session_open", session: initial }));
    act(() => state.editorHandler?.({
      type: "office_editor_ready",
      sessionId: initial.sessionId,
      version: initial.version,
    }));
    expect(state.bridgePosts.filter((message) => (
      typeof message === "object" && message !== null && "type" in message && message.type === "office_open"
    ))).toHaveLength(1);

    act(() => firstSocket.onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => Promise.resolve());
    const secondSocket = state.socket;
    if (!secondSocket || secondSocket === firstSocket) throw new Error("second socket was not created");
    act(() => secondSocket.emit({ event: "office_session_open", session: initial }));

    expect(state.bridgePosts.filter((message) => (
      typeof message === "object" && message !== null && "type" in message && message.type === "office_open"
    ))).toHaveLength(1);
    expect(secondSocket.sent.map((message) => JSON.parse(message))).toContainEqual({
      event: "office_editor_ready",
      sessionId: initial.sessionId,
      version: initial.version,
    });
  });

  it("forwards AI requests from the embedded editor and ignores another session", async () => {
    const initial = officeSession();
    const onAiRequest = vi.fn();
    state.getOfficeSession.mockResolvedValue(initial);

    render(
      <OfficeEditorHost
        initialSession={initial}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
        onAiRequest={onAiRequest}
      />,
    );

    await act(async () => state.frameOnLoad?.());
    await act(async () => Promise.resolve());
    const socket = state.socket;
    if (!socket) throw new Error("socket was not created");
    act(() => socket.emit({ event: "office_session_open", session: initial }));

    act(() => state.editorHandler?.({
      type: "office_ai_request",
      sessionId: "office-other",
      prompt: "不应转发",
      displayText: "错误会话",
    }));
    expect(onAiRequest).not.toHaveBeenCalled();

    act(() => state.editorHandler?.({
      type: "office_ai_request",
      sessionId: initial.sessionId,
      prompt: "把当前表格按月份汇总",
      displayText: "请汇总当前表格",
    }));
    expect(onAiRequest).toHaveBeenCalledWith("把当前表格按月份汇总", "请汇总当前表格");
  });

  it("exports the current checkpoint to the path selected in the save dialog", async () => {
    const initial = officeSession();
    const onExported = vi.fn();
    state.getOfficeSession.mockResolvedValue(initial);
    state.getOfficeWorkingFile.mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer);
    state.saveDialog.mockResolvedValue("C:/Users/test/Desktop/销售计划.xlsx");

    render(
      <OfficeEditorHost
        initialSession={initial}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
        onExported={onExported}
      />,
    );

    await act(async () => state.frameOnLoad?.());
    await act(async () => Promise.resolve());
    const socket = state.socket;
    if (!socket) throw new Error("socket was not created");
    act(() => socket.emit({ event: "office_session_open", session: initial }));
    act(() => state.editorHandler?.({
      type: "office_editor_ready",
      sessionId: initial.sessionId,
      version: initial.version,
    }));

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    await waitFor(() => {
      expect(state.saveDialog).toHaveBeenCalledWith({
        title: "导出 Excel 工作簿",
        defaultPath: "销售计划.xlsx",
        filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      });
    });
    await waitFor(() => {
      expect(state.writeFile).toHaveBeenCalledWith(
        "C:/Users/test/Desktop/销售计划.xlsx",
        new Uint8Array([1, 2, 3]),
      );
    });
    expect(onExported).toHaveBeenCalledWith("销售计划.xlsx");
    await waitFor(() => {
      expect(screen.getByText("已导出：销售计划.xlsx")).toBeInTheDocument();
    });
  });

  it("does not export when the save dialog is cancelled", async () => {
    const initial = officeSession();
    state.getOfficeSession.mockResolvedValue(initial);
    state.saveDialog.mockResolvedValue(null);

    render(
      <OfficeEditorHost
        initialSession={initial}
        ownerSessionKey="websocket:chat-1"
        onClosed={() => undefined}
      />,
    );

    await act(async () => state.frameOnLoad?.());
    await act(async () => Promise.resolve());
    const socket = state.socket;
    if (!socket) throw new Error("socket was not created");
    act(() => socket.emit({ event: "office_session_open", session: initial }));
    act(() => state.editorHandler?.({
      type: "office_editor_ready",
      sessionId: initial.sessionId,
      version: initial.version,
    }));

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    await waitFor(() => expect(state.saveDialog).toHaveBeenCalledTimes(1));
    expect(state.writeFile).not.toHaveBeenCalled();
  });
});
