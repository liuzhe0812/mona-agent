import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OfficeSessionState } from "./types";

const state = vi.hoisted(() => ({
  importOfficeSession: vi.fn(),
}));

vi.mock("@/lib/office-client", () => ({
  importOfficeSession: state.importOfficeSession,
}));

vi.mock("./OfficeEditorHost", () => ({
  OfficeEditorHost: ({ initialSession }: { initialSession: OfficeSessionState }) => (
    <div data-testid="office-editor-host">{initialSession.sessionId}:{initialSession.displayName}</div>
  ),
}));

import { OfficeFileEditor } from "./OfficeFileEditor";

function session(sessionId: string, displayName: string, type: OfficeSessionState["type"]): OfficeSessionState {
  return {
    sessionId,
    displayName,
    type,
    version: { editorEpoch: "epoch-1", modelRevision: 0 },
    checkpointVersion: null,
    savedVersion: null,
    dirty: true,
    editorConnected: false,
    saveState: "dirty",
    lastError: null,
  };
}

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer as ArrayBuffer;
}

function editorProps(overrides: Partial<React.ComponentProps<typeof OfficeFileEditor>> = {}) {
  return {
    filename: "报告.docx",
    sourceIdentity: "C:/workspace/报告.docx",
    ownerSessionKey: "websocket:chat-office",
    fetchBuffer: vi.fn().mockResolvedValue(bytes(1, 2, 3)),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("OfficeFileEditor", () => {
  beforeEach(() => {
    state.importOfficeSession.mockReset();
  });

  it("does not open a stale file when the selected file changes during loading", async () => {
    const oldFile = deferred<ArrayBuffer>();
    const newFile = deferred<ArrayBuffer>();
    const oldFetch = vi.fn().mockReturnValue(oldFile.promise);
    const newFetch = vi.fn().mockReturnValue(newFile.promise);
    state.importOfficeSession.mockImplementation(async (request: { filename: string }) => (
      session("office-new", request.filename, "sheets")
    ));
    const { rerender } = render(<OfficeFileEditor {...editorProps({
      filename: "旧报告.docx",
      sourceIdentity: "C:/workspace/旧报告.docx",
      fetchBuffer: oldFetch,
    })} />);

    await waitFor(() => expect(oldFetch).toHaveBeenCalledOnce());
    rerender(<OfficeFileEditor {...editorProps({
      filename: "新报告.xlsx",
      sourceIdentity: "C:/workspace/新报告.xlsx",
      fetchBuffer: newFetch,
    })} />);

    await waitFor(() => expect(newFetch).toHaveBeenCalledOnce());
    await act(async () => {
      oldFile.resolve(bytes(0x01));
      await Promise.resolve();
    });
    expect(state.importOfficeSession).not.toHaveBeenCalled();

    await act(async () => {
      newFile.resolve(bytes(0x02));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("office-editor-host")).toHaveTextContent(
      "office-new:新报告.xlsx",
    ));
    expect(state.importOfficeSession).toHaveBeenCalledOnce();
    expect(state.importOfficeSession.mock.calls[0]?.[0]).toEqual({
      filename: "新报告.xlsx",
      sourceIdentity: "C:/workspace/新报告.xlsx",
      ownerSessionKey: "websocket:chat-office",
    });
  });

  it("lets a failed import be retried", async () => {
    const fetchBuffer = vi.fn().mockResolvedValue(bytes(4, 5, 6));
    state.importOfficeSession
      .mockRejectedValueOnce(new Error("服务暂时不可用"))
      .mockResolvedValueOnce(session("office-retry", "报告.docx", "docs"));
    render(<OfficeFileEditor {...editorProps({ fetchBuffer })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("文档打开失败：服务暂时不可用");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(screen.getByTestId("office-editor-host")).toHaveTextContent(
      "office-retry:报告.docx",
    ));
    expect(fetchBuffer).toHaveBeenCalledTimes(2);
    expect(state.importOfficeSession).toHaveBeenCalledTimes(2);
  });

  it("does not import again when the parent rerenders the same file", async () => {
    const fetchBuffer = vi.fn().mockResolvedValue(bytes(7, 8, 9));
    state.importOfficeSession.mockResolvedValue(session("office-stable", "报告.docx", "docs"));
    const { rerender } = render(<OfficeFileEditor {...editorProps({ fetchBuffer })} />);

    await waitFor(() => expect(screen.getByTestId("office-editor-host")).toHaveTextContent(
      "office-stable:报告.docx",
    ));
    rerender(<OfficeFileEditor {...editorProps({
      fetchBuffer: vi.fn().mockResolvedValue(bytes(7, 8, 9)),
      onClosed: () => undefined,
    })} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.importOfficeSession).toHaveBeenCalledOnce();
    expect(fetchBuffer).toHaveBeenCalledOnce();
  });
});
