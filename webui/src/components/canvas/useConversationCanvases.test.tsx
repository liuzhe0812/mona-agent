import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedWorkspaceCanvas, WorkspaceCanvasDocument } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  listWorkspaceCanvases: vi.fn(),
  migrateLegacyCanvases: vi.fn(),
  readWorkspaceCanvas: vi.fn(),
  saveWorkspaceCanvas: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: mocks.isTauri,
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
});
