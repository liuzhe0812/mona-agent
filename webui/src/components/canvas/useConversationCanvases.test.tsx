import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureHostedPlatform } from "@/lib/hosted-platform";
import type { SavedWorkspaceCanvas, WorkspaceCanvasDocument } from "@/lib/tauri";
import type { UIMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listWorkspaceCanvases: vi.fn(),
  migrateLegacyCanvases: vi.fn(),
  readWorkspaceCanvas: vi.fn(),
  saveWorkspaceCanvas: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: mocks.isTauri,
  hasWorkspaceStorage: mocks.isTauri,
  listWorkspaceCanvases: mocks.listWorkspaceCanvases,
  migrateLegacyCanvases: mocks.migrateLegacyCanvases,
  readWorkspaceCanvas: mocks.readWorkspaceCanvas,
  saveWorkspaceCanvas: mocks.saveWorkspaceCanvas,
}));

import { useConversationCanvases } from "./useConversationCanvases";

const WORKSPACE_ROOT = "D:\\workspace";
const CHAT_ID = "chat-1";

function canvas(
  overrides: Partial<WorkspaceCanvasDocument> = {},
): WorkspaceCanvasDocument {
  return {
    version: 1,
    id: "canvas-1",
    kind: "flowchart",
    title: "退款审批流程图",
    originChatId: CHAT_ID,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    contentMarkdown: "# 退款审批流程图",
    ...overrides,
  };
}

function savedCanvas(overrides: Partial<WorkspaceCanvasDocument> = {}): SavedWorkspaceCanvas {
  const saved = canvas(overrides);
  return {
    canvas: saved,
    path: `${WORKSPACE_ROOT}\\canvases\\${saved.id}.mona-canvas`,
  };
}

function hookOptions(overrides: Partial<Parameters<typeof useConversationCanvases>[0]> = {}) {
  return {
    chatId: CHAT_ID,
    messages: [],
    isStreaming: false,
    workspaceRoot: WORKSPACE_ROOT,
    ...overrides,
  };
}

describe("useConversationCanvases workspace persistence", () => {
  let releaseAccount: (() => void) | undefined;
  afterEach(() => {
    cleanup();
    releaseAccount?.();
    releaseAccount = undefined;
    vi.useRealTimers();
  });
  beforeEach(() => {
    mocks.isTauri.mockReturnValue(true);
    mocks.migrateLegacyCanvases.mockReset().mockResolvedValue(0);
    mocks.listWorkspaceCanvases.mockReset().mockResolvedValue([]);
    mocks.readWorkspaceCanvas.mockReset();
    mocks.saveWorkspaceCanvas.mockReset().mockImplementation(
      async (_workspaceRoot: string, document: WorkspaceCanvasDocument) => ({
        canvas: document,
        path: `${WORKSPACE_ROOT}\\canvases\\${document.id}.mona-canvas`,
      }),
    );
  });

  it("restores and activates the latest canvas owned by a reopened chat", async () => {
    mocks.listWorkspaceCanvases.mockResolvedValue([
      savedCanvas({ id: "older", title: "旧画布", createdAt: "2026-09-01T00:00:00.000Z" }),
      savedCanvas({ id: "latest", title: "当前画布", createdAt: "2026-09-02T00:00:00.000Z" }),
    ]);
    const { result } = renderHook(() => useConversationCanvases(hookOptions()));

    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    expect(mocks.listWorkspaceCanvases).toHaveBeenCalledWith(WORKSPACE_ROOT, CHAT_ID);
    expect(result.current.activeCanvasId).toBe("canvas:latest");
    expect(result.current.activeCanvas?.note.title).toBe("当前画布");
  });

  it("creates a blank canvas through workspace persistence without a notes save", async () => {
    const { result } = renderHook(() => useConversationCanvases(hookOptions()));

    let tabId: string | null = null;
    act(() => {
      tabId = result.current.createBlankCanvas("mindmap");
    });

    await waitFor(() => expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledTimes(1));

    expect(tabId).toMatch(/^canvas:/);
    expect(result.current.activeCanvasId).toBe(tabId);
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledWith(
      WORKSPACE_ROOT,
      expect.objectContaining({
        kind: "mindmap",
        originChatId: CHAT_ID,
        title: "未命名思维导图",
      }),
    );
  });

  it("reads a .mona-canvas file and activates it as the current tab", async () => {
    const path = `${WORKSPACE_ROOT}\\canvases\\existing.mona-canvas`;
    mocks.readWorkspaceCanvas.mockResolvedValue(
      savedCanvas({ id: "existing", title: "已存在的流程图" }),
    );
    const { result } = renderHook(() => useConversationCanvases(hookOptions()));

    let openedId: string | null = null;
    await act(async () => {
      openedId = await result.current.openWorkspaceCanvas(path);
    });

    expect(mocks.readWorkspaceCanvas).toHaveBeenCalledWith(WORKSPACE_ROOT, path);
    expect(openedId).toBe("canvas:existing");
    expect(result.current.activeCanvasId).toBe("canvas:existing");
    expect(result.current.activeCanvas?.note.title).toBe("已存在的流程图");
    expect(result.current.activeCanvas?.workspacePath).toBe(
      `${WORKSPACE_ROOT}\\canvases\\existing.mona-canvas`,
    );
  });

  it("runs legacy canvas migration without automatically opening canvases", async () => {
    mocks.migrateLegacyCanvases.mockResolvedValue(1);

    const { result } = renderHook(() => useConversationCanvases(hookOptions({ migrateLegacy: true })));

    await waitFor(() => expect(mocks.migrateLegacyCanvases).toHaveBeenCalledWith(WORKSPACE_ROOT));

    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeCanvasId).toBeNull();
  });

  it("creates, saves, and completes a mindmap updated through the canvas tool", async () => {
    const onOpenCanvas = vi.fn();
    const { result, rerender } = renderHook(
      ({ messages, isStreaming }: { messages: UIMessage[]; isStreaming: boolean }) =>
        useConversationCanvases(hookOptions({ messages, isStreaming, onOpenCanvas })),
      { initialProps: { messages: [] as UIMessage[], isStreaming: true } },
    );
    let routed: ReturnType<typeof result.current.routeMessage>;
    act(() => {
      routed = result.current.routeMessage("随便做个思维导图测试一下");
    });
    const id = result.current.activeCanvas!.note.id;
    expect(routed!.canvasId).toBe(id);
    expect(routed!.content).toContain('canvas(action="open")');
    expect(onOpenCanvas).toHaveBeenCalledWith(`canvas:${id}`, true);
    await act(async () => { await routed!.canvasPathReady; });

    const markdown = "# 测试思维导图\n- 分支\n  - 叶子";
    act(() => {
      result.current.updateCanvasContent(id, { contentMarkdown: markdown, plainText: "测试思维导图 分支 叶子" });
    });
    rerender({ messages: [{
      id: "completed-mindmap", role: "assistant", content: "已创建可编辑思维导图。", createdAt: Date.now(),
    }], isStreaming: false });

    expect(result.current.activeCanvas?.generationStatus).toBe("idle");
    expect(result.current.activeCanvas?.error).toBeUndefined();
    expect(result.current.activeCanvas?.note.contentMarkdown).toBe(markdown);
    await waitFor(() => expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledWith(
      WORKSPACE_ROOT, expect.objectContaining({ id, kind: "mindmap", contentMarkdown: markdown, originChatId: CHAT_ID }),
    ));
  });

  it("flushes the last pending edit to its original workspace when switching chats", async () => {
    releaseAccount = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "account-a" });
    mocks.listWorkspaceCanvases.mockImplementation(async (_root, chatId) => chatId === CHAT_ID ? [savedCanvas()] : []);
    const { result, rerender } = renderHook(({ chatId, workspaceRoot }) =>
      useConversationCanvases(hookOptions({ chatId, workspaceRoot })),
    { initialProps: { chatId: CHAT_ID, workspaceRoot: WORKSPACE_ROOT } });
    await waitFor(() => expect(result.current.activeCanvas).not.toBeNull());
    vi.useFakeTimers();
    act(() => result.current.updateCanvasContent("canvas-1", { contentMarkdown: "# 最后一笔" }));
    rerender({ chatId: "chat-2", workspaceRoot: "D:\\other-workspace" });
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledTimes(1);
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledWith(WORKSPACE_ROOT,
      expect.objectContaining({ id: "canvas-1", contentMarkdown: "# 最后一笔", originChatId: CHAT_ID }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledTimes(1);
    expect(result.current.tabs).toEqual([]);
  });

  it.each([0, 450])("does not duplicate a save on unmount after %i ms", async (elapsed) => {
    mocks.listWorkspaceCanvases.mockResolvedValue([savedCanvas()]);
    const { result, unmount } = renderHook(() => useConversationCanvases(hookOptions()));
    await waitFor(() => expect(result.current.activeCanvas).not.toBeNull());
    mocks.saveWorkspaceCanvas.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();
    act(() => result.current.updateCanvasContent("canvas-1", { contentMarkdown: "# 离开前编辑" }));
    act(() => vi.advanceTimersByTime(elapsed));
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledTimes(1);
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledWith(WORKSPACE_ROOT,
      expect.objectContaining({ contentMarkdown: "# 离开前编辑" }));
  });

  it("discards unsent edits when the hosted account snapshot changes", async () => {
    const releaseOld = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "account-a" });
    mocks.listWorkspaceCanvases.mockResolvedValue([savedCanvas()]);
    const { result, unmount } = renderHook(() => useConversationCanvases(hookOptions()));
    await waitFor(() => expect(result.current.activeCanvas).not.toBeNull());
    vi.useFakeTimers();
    act(() => result.current.updateCanvasContent("canvas-1", { contentMarkdown: "# 旧账号内容" }));
    releaseAccount = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "account-b" });
    unmount();
    releaseOld();
    act(() => vi.advanceTimersByTime(1000));
    expect(mocks.saveWorkspaceCanvas).not.toHaveBeenCalled();
  });

  it("does not report an old pending write failure in the next chat", async () => {
    mocks.listWorkspaceCanvases.mockResolvedValue([savedCanvas()]);
    const { result, rerender } = renderHook(({ chatId }) => useConversationCanvases(hookOptions({ chatId })),
      { initialProps: { chatId: CHAT_ID } });
    await waitFor(() => expect(result.current.activeCanvas).not.toBeNull());
    let fail!: (error: Error) => void;
    mocks.saveWorkspaceCanvas.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.useFakeTimers();
    act(() => result.current.updateCanvasContent("canvas-1", { contentMarkdown: "# 新内容" }));
    rerender({ chatId: "chat-2" });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.activeCanvas?.saveStatus).toBe("saved");
    await act(async () => { fail(new Error("旧文件写入结果未知")); });
    expect(result.current.activeCanvas?.saveStatus).toBe("saved");
    expect(result.current.activeCanvas?.error).toBeUndefined();
    expect(mocks.saveWorkspaceCanvas).toHaveBeenCalledTimes(1);
  });
});
